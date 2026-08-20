/**
 * @packageDocumentation
 * SQLite driver — implements {@link DatabaseDriver} using better-sqlite3 + drizzle-orm.
 *
 * One `.db` file per schema, opened lazily on first access and cached for the lifetime
 * of the process. WAL mode is enabled by default (configurable) so concurrent reads
 * don't block each other or the single writer.
 *
 * @remarks
 * `defaultSafeIntegers(true)` is set on every connection — Discord snowflakes are 64-bit
 * integers that silently lose precision when cast to JS Number. This forces better-sqlite3
 * to return BigInt for INTEGER columns, preventing that entirely.
 *
 * The data directory is registered as open for as long as the driver lives (see
 * `utils/handles.ts`) => that's what stops an engine swap deleting `.db` files out from under a
 * connected DAL whose collector may still be holding writes.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { buildSqliteTable } from '../schema.js';
import { registerLocalDir, releaseLocalDir } from '../utils/handles.js';
import { ConfigurationError } from '../errors.js';
import type { DatabaseDriver, ScanOptions, SqliteConfig, StoredEntry } from '../types.js';

/** default location for the `.db` files, shared with the engine swap */
const DEFAULT_DATA_DIR = './data/databases';

/**
 * Default grace a blocked write waits for the lock before `SQLITE_BUSY`, in milliseconds.
 * @remarks Covers writer/writer contention across processes; WAL already handles readers. Override
 * with `busyTimeout`, `0` fails immediately.
 */
export const DEFAULT_BUSY_TIMEOUT = 5_000;

/**
 * Rows per transaction on a bulk flush.
 *
 * @remarks
 * better-sqlite3 is synchronous, so every row in a transaction is time the event loop can't do
 * anything else. 500 keeps one chunk down to a couple of ms on ordinary values, which is short
 * enough to disappear between two frames of whatever else the app is doing.
 */
const TX_CHUNK = 500;

/**
 * Rows pulled per page on a scan.
 *
 * @remarks
 * A scan can't hold a `.iterate()` cursor open across its `await yield`s: the cursor pins the one
 * connection this schema shares, so any other op landing mid scan (a `set()`, a collector flush, a
 * `delete()`) throws "database connection is busy". So it keyset-paginates instead => `WHERE id > ?
 * ORDER BY id LIMIT n`, one bound page at a time, exactly how the downward engine swap & the pg
 * driver read. Peak memory is one page, and the connection is free between pages.
 */
const SCAN_CHUNK = 500;


/** hand the loop back for one turn => `setImmediate` runs after pending I/O, so nothing starves */
function yieldloop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// deserialize a stored value the one way => JSON, but hand back the raw string rather than crash on
// a row that somehow isn't JSON (shouldn't happen under normal use, only ever written by set())
function parseStored(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class SqliteDriver implements DatabaseDriver {
  // one drizzle instance per schema => one .db file per schema
  private dbs = new Map<string, ReturnType<typeof drizzle>>();
  private raws = new Map<string, Database.Database>();
  // tracks which schema:table pairs have had CREATE TABLE IF NOT EXISTS run
  private ready = new Set<string>();
  private dataDir: string;
  // resolved grace for a blocked write, ms. validated in the constructor so a bad value fails early
  private busyTimeout: number;
  // guards the handle registry against a double close() double counting the release
  private registered = false;

  constructor(private config: SqliteConfig) {
    this.dataDir = config.dataDir ?? DEFAULT_DATA_DIR;

    const busy = config.busyTimeout ?? DEFAULT_BUSY_TIMEOUT;
    if (!Number.isInteger(busy) || busy < 0) {
      throw new ConfigurationError(
        `busyTimeout must be a whole number of milliseconds >= 0 (0 fails immediately), got ${busy}`,
      );
    }
    this.busyTimeout = busy;

    // claimed from construction, not from the first open() => a write sitting in the collector
    // buffer is data this dir holds even though no file handle exists yet (E1)
    registerLocalDir(this.dataDir);
    this.registered = true;
  }

  // lazy-open a .db file for the given schema, cache it
  private open(schema: string): { db: ReturnType<typeof drizzle>; raw: Database.Database } {
    if (this.dbs.has(schema)) {
      return { db: this.dbs.get(schema)!, raw: this.raws.get(schema)! };
    }

    fs.mkdirSync(this.dataDir, { recursive: true });

    const dbPath = path.join(this.dataDir, `${schema}.db`);
    const raw = new Database(dbPath);

    // prevents silent precision loss on Discord snowflakes (64-bit integers)
    raw.defaultSafeIntegers(true);

    if (this.config.wal !== false) {
      // WAL => concurrent reads + no full file lock on write
      raw.pragma('journal_mode = WAL');
    }

    // wait out a writer/writer collision instead of throwing SQLITE_BUSY on contact (a whole
    // number, validated in the constructor => safe to interpolate, pragma takes no bound params)
    raw.pragma(`busy_timeout = ${this.busyTimeout}`);

    const db = drizzle(raw);
    this.dbs.set(schema, db);
    this.raws.set(schema, raw);

    return { db, raw };
  }

  // CREATE TABLE IF NOT EXISTS the first time a schema:table combo is touched
  private ensureTable(schema: string, table: string, raw: Database.Database): void {
    const key = `${schema}:${table}`;
    if (this.ready.has(key)) return;

    raw.exec(
      `CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    this.ready.add(key);
  }

  /** @inheritdoc */
  async get(schema: string, table: string, key: string): Promise<unknown> {
    const { db, raw } = this.open(schema);
    this.ensureTable(schema, table, raw);

    const tbl = buildSqliteTable(table);
    const rows = db.select().from(tbl).where(eq(tbl.id, key)).limit(1).all();

    const row = rows[0];
    if (!row) return null;

    return parseStored(row.value);
  }

  /**
   * Does a row exist for this key?
   *
   * @remarks
   * `SELECT 1 ... LIMIT 1` => existence only, never decodes the value, so a row storing a literal
   * `null` still reports as existing (which `get()` can't distinguish, hence a dedicated check).
   *
   * @inheritdoc
   */
  async exists(schema: string, table: string, key: string): Promise<boolean> {
    const { raw } = this.open(schema);
    this.ensureTable(schema, table, raw);

    const row = raw.prepare(`SELECT 1 FROM "${table}" WHERE id = ? LIMIT 1`).get(key);
    return row !== undefined;
  }

  /** @inheritdoc */
  async set(schema: string, table: string, key: string, value: unknown): Promise<void> {
    const { db, raw } = this.open(schema);
    this.ensureTable(schema, table, raw);

    const tbl = buildSqliteTable(table);
    const serialized = JSON.stringify(value);
    db.insert(tbl)
      .values({ id: key, value: serialized })
      .onConflictDoUpdate({ target: tbl.id, set: { value: serialized } })
      .run();
  }

  /**
   * Upsert a batch of key→value pairs, chunked into transactions of {@link TX_CHUNK} rows.
   * Called by the collector flush — much faster than individual inserts.
   *
   * @remarks
   * Chunked rather than one transaction for the whole group, because better-sqlite3 is synchronous:
   * a 5000 key flush in one go is 5000 sync upserts on the loop thread, which shows up as a
   * periodic stall exactly when the app is busy. The loop gets a turn between chunks instead.
   *
   * The tradeoff is that atomicity is per chunk, not per group => a failure halfway leaves earlier
   * chunks committed. That's safe here: every write is an upsert (so replaying a chunk just
   * overwrites it with the same value) and the collector puts the whole failed group back in the
   * buffer, where any newer write for a key wins. Scales to the buffer cap & beyond => peak memory
   * is one chunk of prepared statements, not the whole group.
   *
   * @inheritdoc
   */
  async batchSet(schema: string, table: string, writes: Map<string, unknown>): Promise<void> {
    const { db, raw } = this.open(schema);
    this.ensureTable(schema, table, raw);

    const tbl = buildSqliteTable(table);
    const entries = Array.from(writes);

    for (let i = 0; i < entries.length; i += TX_CHUNK) {
      const chunk = entries.slice(i, i + TX_CHUNK);

      // drizzle's sync transaction runs the callback immediately => don't call the result
      db.transaction((tx) => {
        for (const [key, value] of chunk) {
          const serialized = JSON.stringify(value);
          tx.insert(tbl)
            .values({ id: key, value: serialized })
            .onConflictDoUpdate({ target: tbl.id, set: { value: serialized } })
            .run();
        }
      });

      if (i + TX_CHUNK < entries.length) await yieldloop();
    }
  }

  /** @inheritdoc */
  async delete(schema: string, table: string, key: string): Promise<void> {
    const { db, raw } = this.open(schema);
    this.ensureTable(schema, table, raw);

    const tbl = buildSqliteTable(table);
    db.delete(tbl).where(eq(tbl.id, key)).run();
  }

  /**
   * Stream every row in id order, a bounded page at a time, off keyset pagination.
   *
   * @remarks
   * Reads {@link SCAN_CHUNK} rows with `WHERE id > ? ORDER BY id LIMIT ?`, yields them, then fetches
   * the next page past the last id it saw => peak memory is one page (SC2) & no `.iterate()` cursor
   * is ever held across a yield. That last part matters: a live cursor pins the single connection
   * this schema uses, so a `set()`/`delete()`/collector flush arriving mid scan would throw "this
   * database connection is busy". Paging leaves the connection free between pages, so concurrent
   * writes to the same schema go through. The flip side of not holding a snapshot: a write that
   * lands between two pages may or may not be seen, same as the pg driver.
   *
   * `after` is null on the first page so an empty-string id isn't dropped by the `id > ?` bound.
   *
   * The prefix is bound, never spliced into the SQL (S6): `substr(id, 1, ?) = ?` compares the first
   * N characters to the literal prefix, so it's case sensitive & a prefix full of `%`/`_`/`*`
   * matches those characters, not a pattern. `LIKE`/`GLOB` were tempting but `LIKE` is
   * case-insensitive for ASCII on SQLite (surprising) & neither escapes cleanly.
   *
   * @inheritdoc
   */
  async *scan(schema: string, table: string, opts?: ScanOptions): AsyncIterable<StoredEntry> {
    const { raw } = this.open(schema);
    this.ensureTable(schema, table, raw);

    const prefix = opts?.prefix;
    const usePrefix = prefix !== undefined && prefix.length > 0;
    // substr counts code points on TEXT => count the prefix the same way, not UTF-16 units, so an
    // astral-plane prefix still lines up
    const prefixLen = usePrefix ? [...prefix].length : 0;
    const prefixClause = usePrefix ? 'substr(id, 1, ?) = ?' : '';

    // first page has no lower bound (keeps an '' id), later pages walk the primary key past `after`
    const firstStmt = raw.prepare(
      `SELECT id, value FROM "${table}"${usePrefix ? ` WHERE ${prefixClause}` : ''}` +
        ` ORDER BY id LIMIT ?`,
    );
    const nextStmt = raw.prepare(
      `SELECT id, value FROM "${table}" WHERE ${usePrefix ? `${prefixClause} AND ` : ''}` +
        `id > ? ORDER BY id LIMIT ?`,
    );

    let after: string | null = null;
    for (;;) {
      const rows = (
        after === null
          ? usePrefix
            ? firstStmt.all(prefixLen, prefix, SCAN_CHUNK)
            : firstStmt.all(SCAN_CHUNK)
          : usePrefix
            ? nextStmt.all(prefixLen, prefix, after, SCAN_CHUNK)
            : nextStmt.all(after, SCAN_CHUNK)
      ) as Array<{ id: string; value: string }>;

      if (rows.length === 0) break;
      for (const row of rows) yield { id: row.id, value: parseStored(row.value) };

      // a short page is the last one => no extra round trip just to see zero rows
      if (rows.length < SCAN_CHUNK) break;
      after = rows[rows.length - 1]!.id;
    }
  }

  /** @inheritdoc */
  async count(schema: string, table: string, opts?: ScanOptions): Promise<number> {
    const { raw } = this.open(schema);
    this.ensureTable(schema, table, raw);

    const prefix = opts?.prefix;
    const row =
      prefix !== undefined && prefix.length > 0
        ? (raw
            .prepare(`SELECT count(*) AS n FROM "${table}" WHERE substr(id, 1, ?) = ?`)
            .get([...prefix].length, prefix) as { n: number | bigint })
        : (raw.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number | bigint });

    // defaultSafeIntegers => count(*) comes back as BigInt, hand out a plain number
    return Number(row.n);
  }

  /** Close all open `.db` file handles. */
  async close(): Promise<void> {
    for (const raw of this.raws.values()) {
      raw.close();
    }
    this.dbs.clear();
    this.raws.clear();
    this.ready.clear();

    // hand the dir back => a migration may now delete these files (E1)
    if (this.registered) {
      releaseLocalDir(this.dataDir);
      this.registered = false;
    }
  }
}
