/**
 * @packageDocumentation
 * Programmatic engine swap => the same bidirectional migration the CLI does, callable from
 * code so you don't have to shell out to `npm run db:engine-swap`.
 *
 * - **up**   SQLite `.db` files  ->  Postgres logical schemas
 * - **down** Postgres schemas    ->  SQLite `.db` files
 *
 * Anything you leave out of the options is filled in for you: `dataDir` falls back to
 * `./data/databases`, `connectionString` to `process.env.DATABASE_URL`, and the target side
 * (data dir, Postgres schemas, tables) is created if it isn't there yet.
 *
 * @example Swap standalone
 * ```ts
 * import { engineSwap } from 'sql-switch';
 *
 * const result = await engineSwap({ direction: 'up', onConflict: 'overwrite' });
 * console.log(`${result.totalRows} rows moved`);
 * ```
 *
 * @example Swap a live DAL & keep using it
 * ```ts
 * // flushes pending writes, migrates, then reconnects on the new engine
 * await db.swapEngine({ direction: 'up' });
 * await db.schema('antinuke').table('settings').key('guild_1').get(); // now hitting Postgres
 * ```
 *
 * @remarks
 * Durability rules that hold in both directions:
 *
 * - rows **stream** => peak memory is one {@link CHUNK_SIZE} batch, not one table
 * - a name this DAL couldn't have created is skipped & reported, never migrated & never thrown on
 *   => a database shared with another app is a normal thing to be pointed at
 * - every committed unit is journalled, so an interrupted run resumes deterministically instead of
 *   inferring what landed from what the target happens to hold
 * - an exit signal stops the run at a boundary & is handed back afterwards, the same rule the write
 *   collector follows => the library never calls `process.exit()` on the host app's behalf
 * - local `.db` files are the only copy of local data => they're deleted only when every table in
 *   them landed and no DAL in this process still holds the directory
 */

// type-only => erased at compile time, so importing this module never pulls in the native addons.
// the runtime values (Pool, the Database ctor) are loaded with a dynamic import() inside swapUp/
// swapDown, so pg & better-sqlite3 only have to be installed when a migration actually runs
import type PgTypes from 'pg';
import type BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { NAME_PATTERN } from './schema-manager.js';
import { ConfigurationError } from './errors.js';
import { EXIT_SIGNALS, handback } from './utils/shutdown.js';
import { localDirOpen, localDirGeneration, openLocalDirs } from './utils/handles.js';

/** Postgres built-ins that are never treated as user data. */
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'public', 'pg_toast'];

/**
 * Rows per chunk when moving data => keeps memory flat on big tables.
 *
 * @remarks
 * Peak memory is one chunk on either side, so the migration scales to tables far bigger than RAM
 * (G3). 500 rows is also 1000 bind parameters on the way up, comfortably under the 65535 a single
 * Postgres statement allows => the chunk size can grow a lot before that becomes the limit.
 */
const CHUNK_SIZE = 500;

/** default location for SQLite `.db` files, matches the SqliteDriver default */
const DEFAULT_DATA_DIR = './data/databases';

/**
 * Resume journal, written into the data dir while a swap is in flight.
 *
 * Dotfile on purpose => it sits next to the `.db` files (the one directory both directions always
 * have) without ever being picked up as one.
 * @internal
 */
export const JOURNAL_FILE = '.sql-switch-swap.json';

/** bumped if the journal shape ever changes => an older file is discarded, not misread */
const JOURNAL_VERSION = 1;

/** what a name has to look like, in words, for a skip message */
const NAME_HINT = 'letters, digits, dashes & underscores only';

/** Which way the data moves. */
export type SwapDirection = 'up' | 'down';

/** Something the migration is about to overwrite, passed to an `onConflict` callback. */
export interface SwapConflict {
  /** `table` on the way up (a Postgres table), `file` on the way down (a local `.db`). */
  kind: 'table' | 'file';
  schema: string;
  /** only set when `kind` is `table` */
  table?: string;
}

/**
 * What to do when the target already holds data.
 * `'skip'` (the default) leaves it alone, `'overwrite'` replaces it, or decide per target
 * with a callback returning `true` to overwrite.
 */
export type ConflictHandler =
  | 'skip'
  | 'overwrite'
  | ((conflict: SwapConflict) => boolean | Promise<boolean>);

/** Options for {@link engineSwap}. Everything except `direction` has a default. */
export interface EngineSwapOptions {
  /** `'up'` = SQLite to Postgres, `'down'` = Postgres to SQLite. */
  direction: SwapDirection;
  /**
   * Postgres connection string.
   * @defaultValue `process.env.DATABASE_URL`
   */
  connectionString?: string;
  /**
   * Directory holding the SQLite `.db` files. Created if missing.
   * @defaultValue `'./data/databases'`
   */
  dataDir?: string;
  /**
   * Upward only: keep the local `.db` files after a successful migration.
   * @defaultValue `false` (files are deleted, same as the CLI without `--keep`)
   */
  keepLocalFiles?: boolean;
  /**
   * How to handle a target that already has data in it.
   * @defaultValue `'skip'` => nothing gets clobbered unless you say so
   */
  onConflict?: ConflictHandler;
  /** Called with human readable progress lines. Handy for piping into your own logger. */
  onProgress?: (message: string) => void;
}

/** Per table outcome of a swap. */
export interface SwapTableResult {
  schema: string;
  /**
   * Table inside the schema, or `''` for a schema/file-level outcome that isn't tied to one table
   * => the down-swap uses this when it declines to overwrite an existing local `.db` (ES#8), since
   * that conflict is the whole file, not a single table within it.
   */
  table: string;
  /** rows actually moved (0 when skipped) */
  rows: number;
  /** true when this target was left alone */
  skipped: boolean;
  /**
   * Why it was skipped, when it was.
   *
   * - `conflict` the target already held data & the {@link ConflictHandler} declined (on the
   *   down-swap this is a file-level decline, reported with `table: ''`)
   * - `resumed` an earlier interrupted run already moved it, per the resume journal in the data dir
   */
  reason?: 'conflict' | 'resumed';
}

/** Everything that happened during a swap. */
export interface EngineSwapResult {
  direction: SwapDirection;
  /** one entry per table touched, in the order they were processed */
  tables: SwapTableResult[];
  /** sum of `rows` across every non skipped table */
  totalRows: number;
  /** how many targets were skipped, for any reason => each table's `reason` says which */
  skipped: number;
  /**
   * Schema & table names that were passed over because this DAL can't address them
   * (`schema` for a whole file, `schema.table` for one table inside a usable file).
   *
   * @remarks
   * A database shared with another app is the normal case here => the swap moves what it owns and
   * tells you what it left, rather than aborting halfway through with files already renamed (E4).
   */
  skippedNames: string[];
  /** local `.db` files removed after a successful upward migration */
  deletedFiles: string[];
  /**
   * True when a signal stopped the run early.
   *
   * @remarks
   * Nothing is deleted on the way out & the journal is kept, so rerunning the same swap picks up
   * where this one stopped (E2/E5/E6).
   */
  aborted: boolean;
}

/**
 * On disk record of which units of work a swap already committed.
 *
 * @remarks
 * Keys are `schema.table` going up (each table is its own transaction) and `schema` going down
 * (the file rename is the atomic unit). It only ever exists between an interrupted run & its
 * resume => a clean run deletes it on the way out, otherwise a later swap of recreated local data
 * would skip tables the journal claims are done and silently never move them.
 * @internal
 */
export interface SwapJournal {
  version: number;
  direction: SwapDirection;
  done: Record<string, JournalEntry>;
}

/** One committed unit in the resume journal => how many rows landed & when. */
export interface JournalEntry {
  rows: number;
  at: string;
}

/**
 * A journal entry that's actually the right shape.
 *
 * The file is JSON on disk, so it can be valid JSON & still hold garbage for an entry (a bare
 * number, a `null`, a missing `rows`). A *truthy* but malformed entry is the dangerous one =>
 * `readjournal` would hand it back, the swap would read it as "this unit already landed", skip the
 * unit & then delete its local file without ever migrating it (ES#5). So an entry has to prove its
 * shape before it's trusted; anything that doesn't is dropped & the unit is redone, which is safe
 * because every unit of work is idempotent.
 */
function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.rows === 'number' && Number.isFinite(entry.rows) && typeof entry.at === 'string';
}

/** options with every default applied => what the internals actually work with */
interface ResolvedSwapOptions {
  direction: SwapDirection;
  connectionString: string;
  dataDir: string;
  keepLocalFiles: boolean;
  onConflict: ConflictHandler;
  onProgress: (message: string) => void;
}

/**
 * Fill in every missing option & validate what's left.
 * Split out so the CLI can share the exact same defaulting rules.
 *
 * @throws {@link ConfigurationError} on a bad direction or a missing connection string.
 * @internal
 */
export function resolveSwapOptions(options: EngineSwapOptions): ResolvedSwapOptions {
  if (options?.direction !== 'up' && options?.direction !== 'down') {
    throw new ConfigurationError(
      'engine swap direction is required => "up" (SQLite to Postgres) or "down" (Postgres to SQLite)',
    );
  }

  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new ConfigurationError(
      'engine swap needs a Postgres connection string => pass connectionString or set DATABASE_URL',
    );
  }

  return {
    direction: options.direction,
    connectionString,
    dataDir: options.dataDir ?? DEFAULT_DATA_DIR,
    keepLocalFiles: options.keepLocalFiles ?? false,
    onConflict: options.onConflict ?? 'skip',
    // no logger passed => stay quiet, the result object has everything anyway
    onProgress: options.onProgress ?? (() => undefined),
  };
}

// ask the conflict handler whether a target may be overwritten
async function mayOverwrite(handler: ConflictHandler, conflict: SwapConflict): Promise<boolean> {
  if (typeof handler === 'function') return handler(conflict);
  return handler === 'overwrite';
}

/** describes a conflict target the way the CLI prompt used to */
function conflictLabel(conflict: SwapConflict): string {
  return conflict.kind === 'table' ? `${conflict.schema}.${conflict.table}` : `${conflict.schema}.db`;
}

/** List the user tables inside a SQLite file (skips sqlite internal tables). */
function sqliteTables(db: BetterSqlite3.Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * The exact column shape every table this DAL owns has => `id` + `value`, nothing else.
 *
 * A database shared with another app can hold a table whose *name* is addressable (no dots) but
 * whose *shape* is nothing like ours. Selecting `id, value` off one of those throws & used to take
 * the whole migration down mid-run, then wedge the resume on the same table forever (ES#4). So the
 * shape is gated the same way the name is: a table that isn't this shape is skipped & reported in
 * `skippedNames`, never queried. Requiring *exactly* these two columns is deliberate => this DAL
 * only ever creates `(id, value)`, so an extra column means it isn't one of ours.
 */
const DAL_TABLE_COLUMNS = ['id', 'value'];

/** True when `columns` is exactly `id` + `value` (order independent) => a table this DAL created. */
function isDalShape(columns: string[]): boolean {
  if (columns.length !== DAL_TABLE_COLUMNS.length) return false;
  const set = new Set(columns);
  return DAL_TABLE_COLUMNS.every((c) => set.has(c));
}

/** Column names of one SQLite table. The name is already {@link addressable}, so the interp is safe. */
function sqliteColumns(db: BetterSqlite3.Database, table: string): string[] {
  const info = db.pragma(`table_info("${table}")`) as { name: string }[];
  return info.map((c) => c.name);
}

/** one row of the flat key/value shape both engines store */
interface SwapRow {
  /** TEXT in SQLite, but BigInt once `defaultSafeIntegers(true)` is on & the id is numeric */
  id: string | bigint;
  value: string;
}

/**
 * Batch an iterable into arrays of `size`, pulling only as many items as the current batch needs.
 *
 * @param rows - Anything iterable. A better-sqlite3 `.iterate()` cursor is the point.
 * @param size - Rows per batch. The last batch is whatever is left over.
 * @returns A generator of batches.
 *
 * @remarks
 * The laziness is the whole feature (#10/E3) => `.all()` materialises a whole table before the
 * write side ever gets chunked, which is an OOM on a multi million row table no matter how small
 * the write chunks are. Peak memory here is one batch.
 *
 * Stopping early (`break`, or a throw from the consumer) closes the source iterator through the
 * `for...of` it's driven by => that matters for better-sqlite3, which refuses to `close()` a
 * database that still has a live statement iterator on it.
 * @internal
 */
export function* chunked<T>(rows: Iterable<T>, size: number): Generator<T[]> {
  let batch: T[] = [];

  for (const row of rows) {
    batch.push(row);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }

  if (batch.length > 0) yield batch;
}

/**
 * Build the multi row upsert for one chunk on the way up.
 *
 * Kept separate so the streaming loop stays readable & the parameter arithmetic lives in exactly
 * one place. Names are interpolated because Postgres can't parameterise an identifier => both are
 * checked against {@link NAME_PATTERN} before they ever reach here.
 */
function upsertsql(
  schema: string,
  table: string,
  chunk: SwapRow[],
): { text: string; params: unknown[] } {
  const values: string[] = [];
  const params: unknown[] = [];

  chunk.forEach((row, n) => {
    values.push(`($${n * 2 + 1}, $${n * 2 + 2}::jsonb)`);
    // handle BigInt IDs returned by defaultSafeIntegers(true)
    params.push(typeof row.id === 'bigint' ? row.id.toString() : row.id);
    // SQLite stores TEXT => pass the JSON string straight through to JSONB
    params.push(typeof row.value === 'string' ? row.value : JSON.stringify(row.value));
  });

  return {
    text: `INSERT INTO "${schema}"."${table}" (id, value) VALUES ${values.join(', ')}
           ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
    params,
  };
}

/** true when a discovered name is one this DAL could address itself (S6, checked pre interpolation) */
function addressable(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && NAME_PATTERN.test(name);
}

/**
 * Load the resume journal for this direction, or start a fresh one.
 *
 * @param dataDir - Directory the journal lives in, alongside the `.db` files.
 * @param direction - Direction about to run. A journal from the other direction is discarded.
 * @param onProgress - Told about anything that got thrown away.
 * @returns The journal to work from, never null.
 *
 * @remarks
 * Every failure mode ends in an empty journal rather than an exception => a half written file from
 * a process that died mid write must not be the thing that stops you migrating (E5). Losing it
 * only costs a repeat of work already done, and every unit of work is idempotent.
 * @internal
 */
export function readjournal(
  dataDir: string,
  direction: SwapDirection,
  onProgress: (message: string) => void,
): SwapJournal {
  const fresh: SwapJournal = { version: JOURNAL_VERSION, direction, done: {} };
  const file = path.join(dataDir, JOURNAL_FILE);

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // missing is the normal case, unreadable is not worth failing a migration over
    return fresh;
  }

  let parsed: Partial<SwapJournal>;
  try {
    parsed = JSON.parse(raw) as Partial<SwapJournal>;
  } catch {
    onProgress(`${JOURNAL_FILE} is not readable JSON => ignoring it & starting fresh`);
    return fresh;
  }

  if (parsed.version !== JOURNAL_VERSION || parsed.direction !== direction) {
    onProgress(`${JOURNAL_FILE} is from a different run (${parsed.direction ?? '?'}) => ignoring it`);
    return fresh;
  }

  if (!parsed.done || typeof parsed.done !== 'object') return fresh;

  // validate every entry, not just the container => a journal that's valid JSON can still hold a
  // garbage entry (a bare number, a null, a missing rows count). the dangerous shape is a truthy
  // but malformed one: the swap would read it as "already done", skip the unit & delete its local
  // file without ever migrating it (ES#5). drop the bad ones so the unit is redone, the safe way
  const done: Record<string, JournalEntry> = {};
  let dropped = 0;
  for (const [unit, entry] of Object.entries(parsed.done)) {
    if (isJournalEntry(entry)) done[unit] = entry;
    else dropped++;
  }
  if (dropped > 0) {
    onProgress(
      `${JOURNAL_FILE} had ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'} => ignoring ${dropped === 1 ? 'it' : 'them'}, that work will be redone`,
    );
  }

  return { version: JOURNAL_VERSION, direction, done };
}

/**
 * Write the journal back out, atomically.
 *
 * @param dataDir - Where the journal lives.
 * @param journal - The journal to persist.
 * @param onProgress - Told if the write failed.
 *
 * @remarks
 * Temp file + rename, so a crash mid write leaves either the old journal or the new one, never a
 * truncated one. A failure here is logged & swallowed on purpose => the data already landed, and
 * refusing to carry on because a bookkeeping file wouldn't write would be strictly worse.
 *
 * There is no transaction spanning Postgres & the filesystem => a crash in the window between
 * COMMIT and this write leaves that unit unjournalled, and the resume falls back to the
 * `onConflict` handler for it. That's the honest limit of the mechanism.
 * @internal
 */
export function savejournal(
  dataDir: string,
  journal: SwapJournal,
  onProgress: (message: string) => void,
): void {
  const file = path.join(dataDir, JOURNAL_FILE);
  const tmp = `${file}.tmp`;

  try {
    fs.writeFileSync(tmp, JSON.stringify(journal));
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    onProgress(`could not write ${JOURNAL_FILE} => a resume will redo more work (${String(err)})`);
  }
}

/**
 * Delete the journal. Only correct once a run finished without aborting.
 *
 * @param dataDir - Where the journal lives.
 * @param onProgress - Told if the file wouldn't go.
 * @internal
 */
export function dropjournal(dataDir: string, onProgress: (message: string) => void): void {
  try {
    fs.rmSync(path.join(dataDir, JOURNAL_FILE), { force: true });
  } catch (err) {
    onProgress(`could not remove ${JOURNAL_FILE} => delete it by hand (${String(err)})`);
  }
}

/** flag the swap polls at every boundary, plus which signal set it */
interface SwapAbort {
  requested: boolean;
  signal: NodeJS.Signals | null;
}

/**
 * Catch an exit signal so the migration can stop at a boundary instead of dying mid table.
 *
 * @param onProgress - Where the "stopping" notice goes.
 * @returns The flag to poll & a `release` to call in a `finally`.
 *
 * @remarks
 * Same contract the write collector follows (#5/#9): don't call `process.exit()`, hand the signal
 * back once our own state is consistent, and only when nobody else is listening for it. Just
 * having a listener is already most of the fix => without one the default action kills the process
 * between two chunks, which is the case the journal exists for (E6).
 *
 * A second signal drops the handlers & re-raises immediately => a stop that looks ignored is worse
 * than a stop that loses the tail of a table, and the current table rolls back anyway.
 */
function hookswapexit(onProgress: (message: string) => void): {
  abort: SwapAbort;
  release: () => void;
} {
  const abort: SwapAbort = { requested: false, signal: null };
  const handlers = new Map<NodeJS.Signals, () => void>();

  const drop = (): void => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.clear();
  };

  for (const signal of EXIT_SIGNALS) {
    const handler = (): void => {
      if (abort.requested) {
        onProgress(`${signal} again => stopping now, the journal covers what already landed`);
        drop();
        handback(signal);
        return;
      }
      abort.requested = true;
      abort.signal = signal;
      onProgress(`${signal} => finishing the current step & stopping (again to force)`);
    };

    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return {
    abort,
    release: (): void => {
      const caught = abort.signal;
      // fragile, the order matters => our own listener has to be gone before the re-raise, or
      // handback() just counts itself as "somebody is listening" and nothing happens
      drop();
      if (caught) handback(caught);
    },
  };
}

/**
 * Upward migration => SQLite files into Postgres logical schemas.
 * Each `<name>.db` file becomes schema `<name>`, each table inside it is recreated as-is.
 *
 * Every table moves inside its own transaction & is journalled the moment it commits, so an
 * interrupted run resumes deterministically instead of guessing from what the target happens to
 * hold. Rows stream out of SQLite a chunk at a time, so a table bigger than RAM is fine.
 *
 * Local files are the only copy of the data, so they're only deleted when every table in them
 * landed **and** the directory stayed quiescent for the whole run => no DAL in this process had it
 * open at the start, has it open now, or opened it at any point in between (a DAL that connected &
 * closed again mid-run may have flushed buffered writes the copy never read).
 */
async function swapUp(opts: ResolvedSwapOptions): Promise<EngineSwapResult> {
  const result: EngineSwapResult = {
    direction: 'up',
    tables: [],
    totalRows: 0,
    skipped: 0,
    skippedNames: [],
    deletedFiles: [],
    aborted: false,
  };

  if (!fs.existsSync(opts.dataDir)) {
    opts.onProgress(`data directory "${opts.dataDir}" does not exist => nothing to migrate`);
    return result;
  }

  const files = fs.readdirSync(opts.dataDir).filter((f) => f.endsWith('.db'));
  if (files.length === 0) {
    opts.onProgress(`no .db files found in ${opts.dataDir} => nothing to do`);
    return result;
  }

  // E1/ES#3: quiescence has to cover the *whole* run, not two instants of it. a point-in-time
  // localDirOpen() at the end misses a DAL that connected & closed again while the copy was in
  // flight => its buffered writes may have hit the file after we read it, and it's gone by the time
  // we check. so snapshot both here: whether anything was open when we started, and the cumulative
  // open-generation. at deletion time the dir is only safe if it was clear at the start AND clear
  // now AND nothing opened it in between (generation unchanged)
  const openAtStart = localDirOpen(opts.dataDir);
  const genAtStart = localDirGeneration(opts.dataDir);

  // E1: say it up front, not just at deletion time => the run is still worth doing, the files
  // just aren't safe to remove afterwards
  if (openAtStart) {
    opts.onProgress(
      `${opts.dataDir} is not quiesced => a DAL in this process still has it open, local files will be kept`,
    );
  }

  const journal = readjournal(opts.dataDir, 'up', opts.onProgress);
  const exit = hookswapexit(opts.onProgress);

  // load the native drivers only now the swap is really happening (see the import note up top)
  const { Pool } = (await import('pg')).default;
  const Database = (await import('better-sqlite3')).default;

  const pool = new Pool({ connectionString: opts.connectionString, max: 5 });
  // pg kills the process on an unhandled idle client error
  pool.on('error', (err) => opts.onProgress(`idle postgres client error: ${err.message}`));

  const migrated: string[] = [];

  try {
    for (const file of files) {
      if (exit.abort.requested) {
        result.aborted = true;
        break;
      }

      const schema = path.basename(file, '.db');

      // #6/E4: a file this DAL could never have created is somebody else's => report it & move on.
      // checked before the name reaches a path or a query, so nothing unvetted is ever interpolated
      if (!addressable(schema)) {
        opts.onProgress(`${file} => skipped, "${schema}" is not addressable (${NAME_HINT})`);
        result.skippedNames.push(schema);
        result.skipped++;
        continue;
      }

      const sqlitePath = path.join(opts.dataDir, file);
      const sqlite = new Database(sqlitePath, { readonly: true });
      // keep defaultSafeIntegers(true) => prevents precision loss on 64-bit IDs during read.
      // ES#6: a readonly open on a writable dir still replays the -wal tail, so a file whose app
      // died between a commit & a checkpoint reads back complete here, not truncated to the last
      // checkpoint. the data dir is always writable during a migration, so this holds
      sqlite.defaultSafeIntegers(true);

      try {
        const tables = sqliteTables(sqlite);
        if (tables.length === 0) {
          opts.onProgress(`${schema} => no tables, skipped`);
          continue;
        }

        await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

        // a single skipped table means the local file still holds data Postgres doesn't =>
        // never delete it afterwards
        let fullyMigrated = true;

        for (const table of tables) {
          if (exit.abort.requested) {
            result.aborted = true;
            fullyMigrated = false;
            break;
          }

          const unit = `${schema}.${table}`;

          if (!addressable(table)) {
            opts.onProgress(`${unit} => skipped, not an addressable table name (${NAME_HINT})`);
            result.skippedNames.push(unit);
            result.skipped++;
            // somebody else's table in a file we do own => the file stays either way
            fullyMigrated = false;
            continue;
          }

          // ES#4: an addressable name isn't proof it's ours => a shared .db can hold a table with a
          // totally different shape, and `SELECT id, value` off it throws & used to take the whole
          // run down. gate the shape too, skip a foreign one the same way a foreign name is skipped
          if (!isDalShape(sqliteColumns(sqlite, table))) {
            opts.onProgress(`${unit} => skipped, not a sql-switch table (columns aren't id + value)`);
            result.skippedNames.push(unit);
            result.skipped++;
            fullyMigrated = false; // a foreign table in our file => the file stays
            continue;
          }

          // E2/E5: an earlier run already committed this one, so don't move it twice. it still
          // counts as migrated data, which is what lets the file go at the end
          const done = journal.done[unit];
          if (done) {
            opts.onProgress(`${unit} => already migrated by an earlier run (${done.rows} rows)`);
            result.tables.push({ schema, table, rows: 0, skipped: true, reason: 'resumed' });
            result.skipped++;
            continue;
          }

          await pool.query(`
            CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (
              id    TEXT  PRIMARY KEY,
              value JSONB NOT NULL
            )
          `);

          // leftover rows in the target => ask before clobbering them
          const existing = await pool.query(`SELECT 1 FROM "${schema}"."${table}" LIMIT 1`);
          let truncateFirst = false;

          if (existing.rowCount && existing.rowCount > 0) {
            const conflict: SwapConflict = { kind: 'table', schema, table };
            if (!(await mayOverwrite(opts.onConflict, conflict))) {
              opts.onProgress(`${conflictLabel(conflict)} => skipped, target already has data`);
              result.tables.push({ schema, table, rows: 0, skipped: true, reason: 'conflict' });
              result.skipped++;
              fullyMigrated = false;
              continue;
            }
            truncateFirst = true;
          }

          // #10/E3: a cursor, not `.all()` => the table is never in memory all at once. it stays
          // open across the awaits below, which is fine (better-sqlite3 is synchronous & nothing
          // else touches this statement), and the for...of resets it however the loop ends
          const cursor = sqlite
            .prepare<[], SwapRow>(`SELECT id, value FROM "${table}"`)
            .iterate();

          // one transaction per table => a chunk failing halfway can't leave the target
          // truncated or half filled, it all rolls back together
          const client = await pool.connect();
          let moved = 0;
          let stopped = false;

          try {
            await client.query('BEGIN');

            if (truncateFirst) {
              await client.query(`TRUNCATE TABLE "${schema}"."${table}"`);
            }

            for (const chunk of chunked(cursor, CHUNK_SIZE)) {
              const { text, params } = upsertsql(schema, table, chunk);
              await client.query(text, params);
              moved += chunk.length;

              // E6: mid table is the one place stopping isn't free => give up the whole table
              // rather than commit a fraction of it, the resume redoes it from the top
              if (exit.abort.requested) {
                stopped = true;
                break;
              }
            }

            if (stopped) {
              await client.query('ROLLBACK');
            } else {
              await client.query('COMMIT');
            }
          } catch (err) {
            // best effort rollback => the connection may already be dead
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          } finally {
            client.release();
          }

          if (stopped) {
            result.aborted = true;
            fullyMigrated = false;
            opts.onProgress(`${unit} => rolled back at ${moved} rows, it wasn't finished`);
            break;
          }

          result.tables.push({ schema, table, rows: moved, skipped: false });
          result.totalRows += moved;
          // journalled before it's announced => the announcement is where a signal handler runs
          journal.done[unit] = { rows: moved, at: new Date().toISOString() };
          savejournal(opts.dataDir, journal, opts.onProgress);
          opts.onProgress(`${unit} => ${moved} rows migrated`);
        }

        if (fullyMigrated) {
          migrated.push(sqlitePath);
        } else {
          opts.onProgress(`${file} kept => not every table was migrated`);
        }
      } finally {
        sqlite.close();
      }
    }

    // only delete local files after every schema landed successfully
    if (result.aborted) {
      opts.onProgress('stopped early => nothing deleted, rerun the same swap to pick it back up');
    } else if (!opts.keepLocalFiles && migrated.length > 0) {
      // E1/ES#3: the dir is only safe to clear if it was quiescent for the *entire* run. re-checked
      // here, not just at the start => a DAL can connect while the copy is running, and a write
      // sitting in its collector buffer is invisible to everything we just read. three conditions,
      // each catching a different way a DAL could have touched it:
      //  - openAtStart => one was already open when we began (it may have flushed after our read)
      //  - localDirOpen => one is open right now
      //  - generation moved => one opened (& maybe closed again) at some point mid-run
      const openNow = localDirOpen(opts.dataDir);
      const touchedMidRun = localDirGeneration(opts.dataDir) !== genAtStart;

      if (openAtStart || openNow || touchedMidRun) {
        const held = openLocalDirs();
        const detail = held.length > 0 ? ` (open: ${held.join(', ')})` : ' (opened & closed mid-run)';
        opts.onProgress(
          `${opts.dataDir} is not quiesced => keeping ${migrated.length} local file(s), close every DAL on it & rerun to clear them${detail}`,
        );
      } else {
        for (const p of migrated) {
          fs.rmSync(p, { force: true });
          // WAL sidecars come along with the .db file
          fs.rmSync(`${p}-wal`, { force: true });
          fs.rmSync(`${p}-shm`, { force: true });
          result.deletedFiles.push(p);
        }
        opts.onProgress(
          `deleted ${result.deletedFiles.length} local .db file(s) (set keepLocalFiles to retain)`,
        );
      }
    }

    // E2: a journal must never outlive the run that wrote it => the local files can be recreated
    // & migrated again, and a stale "already done" entry would silently skip that new data
    if (!result.aborted) dropjournal(opts.dataDir, opts.onProgress);

    opts.onProgress(
      result.aborted
        ? 'upward migration stopped early => resume by running it again'
        : 'upward migration complete => SQLite to Postgres',
    );
    return result;
  } finally {
    // pool first => release() may hand a signal back, and that can end the process on the spot
    await pool.end().catch(() => undefined);
    exit.release();
  }
}

/**
 * Downward migration => Postgres logical schemas into SQLite files.
 *
 * Writes to `<schema>.db.tmp` first & renames on success, so a mid-pull failure can't
 * leave a half-written database in place. Postgres data is left untouched.
 *
 * @remarks
 * The rename is the atomic unit here, so that's what the journal records => an interrupted run
 * leaves whole files, never a partial one, and the resume skips the ones already in place.
 */
async function swapDown(opts: ResolvedSwapOptions): Promise<EngineSwapResult> {
  const result: EngineSwapResult = {
    direction: 'down',
    tables: [],
    totalRows: 0,
    skipped: 0,
    skippedNames: [],
    deletedFiles: [],
    aborted: false,
  };

  // target dir may not exist yet on a fresh machine
  fs.mkdirSync(opts.dataDir, { recursive: true });

  // E1, the other way round => nothing here deletes the source (Postgres keeps every row), but a
  // DAL holding these files open keeps reading the inode we renamed away from. warn, don't refuse:
  // db.swapEngine() closes first, and a standalone call may well be pointed at an idle dir
  if (localDirOpen(opts.dataDir)) {
    opts.onProgress(
      `${opts.dataDir} is not quiesced => a DAL in this process has it open & will keep using the files it already opened, close it & rerun (or use db.swapEngine())`,
    );
  }

  const journal = readjournal(opts.dataDir, 'down', opts.onProgress);
  const exit = hookswapexit(opts.onProgress);

  // load the native drivers only now the swap is really happening (see the import note up top)
  const { Pool } = (await import('pg')).default;
  const Database = (await import('better-sqlite3')).default;

  const pool = new Pool({ connectionString: opts.connectionString, max: 5 });
  pool.on('error', (err) => opts.onProgress(`idle postgres client error: ${err.message}`));

  try {
    const schemaRes = await pool.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN (${SYSTEM_SCHEMAS.map((_, i) => `$${i + 1}`).join(', ')})
         AND schema_name NOT LIKE 'pg_%'`,
      SYSTEM_SCHEMAS,
    );

    const schemas = schemaRes.rows.map((r: { schema_name: string }) => r.schema_name);
    if (schemas.length === 0) {
      opts.onProgress('no user schemas found in Postgres => nothing to do');
      return result;
    }

    for (const schema of schemas) {
      if (exit.abort.requested) {
        result.aborted = true;
        break;
      }

      // #6/E4: somebody else's schema in a shared database => leave it, don't abort the run.
      // before path.join too, so a name that isn't a name can't reach the filesystem either
      if (!addressable(schema)) {
        opts.onProgress(`${schema} => skipped, not an addressable schema name (${NAME_HINT})`);
        result.skippedNames.push(schema);
        result.skipped++;
        continue;
      }

      const dbPath = path.join(opts.dataDir, `${schema}.db`);
      const tmpPath = `${dbPath}.tmp`;

      // E2/E5: an earlier run already renamed this file into place
      const done = journal.done[schema];
      if (done) {
        opts.onProgress(`${schema}.db => already written by an earlier run (${done.rows} rows)`);
        result.skipped++;
        continue;
      }

      // existing local file => ask before replacing it
      if (fs.existsSync(dbPath)) {
        const conflict: SwapConflict = { kind: 'file', schema };
        if (!(await mayOverwrite(opts.onConflict, conflict))) {
          opts.onProgress(`${conflictLabel(conflict)} => skipped, local file already exists`);
          // ES#8: a declined file conflict is a real skipped outcome => record it in `tables` the
          // same way the up-swap records a declined table, so a caller reading `result.tables` sees
          // it. `table: ''` marks this as file-level (the whole schema), not one table inside it
          result.tables.push({ schema, table: '', rows: 0, skipped: true, reason: 'conflict' });
          result.skipped++;
          continue;
        }
      }

      const tableRes = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [schema],
      );
      const tables = tableRes.rows.map((r: { table_name: string }) => r.table_name);
      if (tables.length === 0) {
        opts.onProgress(`${schema} => no tables, skipped`);
        continue;
      }

      // stale temp files from a previous failed run => drop the WAL sidecars too, not just the main
      // file. reopening in WAL mode next to a leftover `.db.tmp-wal` can replay a prior partial pull
      // into the "fresh" file & resurrect rows postgres no longer has (deleted keys, dropped tables)
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(`${tmpPath}-wal`, { force: true });
      fs.rmSync(`${tmpPath}-shm`, { force: true });
      const sqlite = new Database(tmpPath);

      // rows pulled into this one file => what the journal records once it's renamed into place
      let schemaRows = 0;
      // how many tables in this schema were actually ours => an all-foreign schema pulls nothing &
      // must not leave an empty stub .db behind (ES#4). a real but empty DAL schema still counts
      let pulledTables = 0;
      let stopped = false;

      try {
        sqlite.pragma('journal_mode = WAL');

        for (const table of tables) {
          if (exit.abort.requested) {
            stopped = true;
            break;
          }

          if (!addressable(table)) {
            opts.onProgress(
              `${schema}.${table} => skipped, not an addressable table name (${NAME_HINT})`,
            );
            result.skippedNames.push(`${schema}.${table}`);
            result.skipped++;
            continue;
          }

          // ES#4: a table in a shared postgres schema that isn't ours => its columns aren't id +
          // value, so `SELECT id, value` below would throw & abort the whole run. skip & report it
          // instead, same as a foreign name. checked here (not once up front) because a schema can
          // mix our tables with someone else's
          const colRes = await pool.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2`,
            [schema, table],
          );
          const columns = colRes.rows.map((r: { column_name: string }) => r.column_name);
          if (!isDalShape(columns)) {
            opts.onProgress(
              `${schema}.${table} => skipped, not a sql-switch table (columns aren't id + value)`,
            );
            result.skippedNames.push(`${schema}.${table}`);
            result.skipped++;
            continue;
          }

          sqlite.exec(
            `CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, value TEXT NOT NULL)`,
          );

          const insert = sqlite.prepare(
            `INSERT OR REPLACE INTO "${table}" (id, value) VALUES (?, ?)`,
          );

          let total = 0;
          // keyset pagination => LIMIT/OFFSET rescans everything it skipped on every chunk,
          // which turns quadratic on a big table. id is the primary key so `> lastId` walks
          // the index instead
          let lastId: string | null = null;

          for (;;) {
            const res: PgTypes.QueryResult = await (lastId === null
              ? pool.query(
                  `SELECT id, value FROM "${schema}"."${table}" ORDER BY id LIMIT $1`,
                  [CHUNK_SIZE],
                )
              : pool.query(
                  `SELECT id, value FROM "${schema}"."${table}"
                   WHERE id > $1 ORDER BY id LIMIT $2`,
                  [lastId, CHUNK_SIZE],
                ));
            if (res.rows.length === 0) break;

            const insertMany = sqlite.transaction((rows: { id: string; value: unknown }[]) => {
              for (const row of rows) {
                // pg decodes JSONB before we see it, so re-serialize every value the same way set()
                // would => the SQLite TEXT column has to hold real JSON. the old `typeof === string`
                // shortcut stored a bare `hello`/`5`, which reads back as the wrong type & feeds
                // invalid json to a later up-swap's ::jsonb. well, that shortcut was exactly the
                // silent corruption this project exists to stop
                const payload = JSON.stringify(row.value);
                insert.run(row.id, payload);
              }
            });
            insertMany(res.rows);

            total += res.rows.length;
            lastId = (res.rows[res.rows.length - 1] as { id: string }).id;
            // short page => that was the last one, no need for another round trip
            if (res.rows.length < CHUNK_SIZE) break;

            // E6: a page boundary is a safe place to stop, the temp file is thrown away whole
            if (exit.abort.requested) {
              stopped = true;
              break;
            }
          }

          if (stopped) break;

          result.tables.push({ schema, table, rows: total, skipped: false });
          result.totalRows += total;
          schemaRows += total;
          pulledTables++;
          opts.onProgress(`${schema}.${table} => ${total} rows pulled`);
        }

        // ES#7: fold every committed WAL frame back into the main temp file before we close &
        // rename it. close() checkpoints on the last connection in practice, but don't bank on it
        // => the rename below moves the bare .db and then deletes its -wal, so an unfolded frame
        // would be silently lost. skip it when we're bailing out, the temp file is binned anyway
        if (!stopped) sqlite.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        sqlite.close();
      }

      if (stopped) {
        result.aborted = true;
        // nothing was renamed => the half filled temp file is worthless, and any table already
        // reported for this schema goes with it
        result.tables = result.tables.filter((t) => t.schema !== schema);
        result.totalRows -= schemaRows;
        fs.rmSync(tmpPath, { force: true });
        fs.rmSync(`${tmpPath}-wal`, { force: true });
        fs.rmSync(`${tmpPath}-shm`, { force: true });
        opts.onProgress(`${schema}.db discarded => it wasn't finished, nothing was replaced`);
        break;
      }

      // ES#4: every table in this schema belonged to someone else => we pulled nothing, so there's
      // no .db to hydrate. drop the empty temp file rather than rename a stub into place (& don't
      // journal it => there's no "done" here, the schema was never ours to begin with)
      if (pulledTables === 0) {
        fs.rmSync(tmpPath, { force: true });
        fs.rmSync(`${tmpPath}-wal`, { force: true });
        fs.rmSync(`${tmpPath}-shm`, { force: true });
        opts.onProgress(`${schema} => no sql-switch tables, nothing hydrated`);
        continue;
      }

      // atomic swap => the active .db is only replaced once the temp file is complete
      fs.renameSync(tmpPath, dbPath);
      // drop stale WAL sidecars belonging to the replaced file
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      // close() normally checkpoints & removes these, but clean them up if it didn't
      fs.rmSync(`${tmpPath}-wal`, { force: true });
      fs.rmSync(`${tmpPath}-shm`, { force: true });
      // journalled after the rename => the rename is what makes this schema done
      journal.done[schema] = { rows: schemaRows, at: new Date().toISOString() };
      savejournal(opts.dataDir, journal, opts.onProgress);
      opts.onProgress(`hydrated ${schema}.db`);
    }

    // same rule as the up swap => a finished run leaves no journal behind for the next one to
    // misread, only an interrupted one does
    if (!result.aborted) dropjournal(opts.dataDir, opts.onProgress);

    opts.onProgress(
      result.aborted
        ? 'downward migration stopped early => resume by running it again'
        : 'downward migration complete => Postgres to SQLite',
    );
    opts.onProgress('cloud data left untouched (backup)');
    return result;
  } finally {
    await pool.end().catch(() => undefined);
    exit.release();
  }
}

/**
 * Run an engine swap from code, no terminal needed.
 *
 * Missing options are defaulted (see {@link EngineSwapOptions}) & the target side is created
 * if it doesn't exist yet, so the minimum viable call is just a direction plus a reachable
 * `DATABASE_URL`.
 *
 * @param options - Direction plus any overrides.
 * @returns A per table breakdown of what moved.
 * @throws {@link ConfigurationError} if the direction is missing/invalid or no connection
 * string can be resolved.
 *
 * @remarks
 * A schema or table name that doesn't match `^[a-zA-Z0-9_-]+$` is **skipped & reported** in
 * `skippedNames`, not thrown on => aborting halfway through would leave part of a shared database
 * migrated and files already renamed. Nothing outside those names is read or written.
 *
 * An interrupted run (`SIGINT`/`SIGTERM`) stops at the next boundary, leaves a journal in the data
 * dir & sets `aborted` => run the same swap again to finish it. Nothing is deleted on the way out.
 *
 * @example Non interactive, overwrite whatever is in the target
 * ```ts
 * await engineSwap({
 *   direction: 'up',
 *   onConflict: 'overwrite',
 *   onProgress: (line) => console.log(`[swap] ${line}`),
 * });
 * ```
 *
 * @example Decide per table
 * ```ts
 * await engineSwap({
 *   direction: 'up',
 *   onConflict: (c) => c.schema !== 'economy', // never clobber economy
 * });
 * ```
 */
export async function engineSwap(options: EngineSwapOptions): Promise<EngineSwapResult> {
  const opts = resolveSwapOptions(options);

  opts.onProgress(
    `direction: ${opts.direction === 'up' ? 'SQLite => Postgres' : 'Postgres => SQLite'}`,
  );
  opts.onProgress(`data dir: ${opts.dataDir}`);

  return opts.direction === 'up' ? swapUp(opts) : swapDown(opts);
}
