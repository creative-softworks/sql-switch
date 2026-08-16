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
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { buildSqliteTable } from '../schema.js';
import type { DatabaseDriver, SqliteConfig } from '../types.js';

export class SqliteDriver implements DatabaseDriver {
  // one drizzle instance per schema => one .db file per schema
  private dbs = new Map<string, ReturnType<typeof drizzle>>();
  private raws = new Map<string, Database.Database>();
  // tracks which schema:table pairs have had CREATE TABLE IF NOT EXISTS run
  private ready = new Set<string>();

  constructor(private config: SqliteConfig) {}

  // lazy-open a .db file for the given schema, cache it
  private open(schema: string): { db: ReturnType<typeof drizzle>; raw: Database.Database } {
    if (this.dbs.has(schema)) {
      return { db: this.dbs.get(schema)!, raw: this.raws.get(schema)! };
    }

    const dataDir = this.config.dataDir ?? './data/databases';
    fs.mkdirSync(dataDir, { recursive: true });

    const dbPath = path.join(dataDir, `${schema}.db`);
    const raw = new Database(dbPath);

    // prevents silent precision loss on Discord snowflakes (64-bit integers)
    raw.defaultSafeIntegers(true);

    if (this.config.wal !== false) {
      // WAL => concurrent reads + no full file lock on write
      raw.pragma('journal_mode = WAL');
    }

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

    try {
      return JSON.parse(row.value);
    } catch {
      // shouldn't happen under normal use, but return raw string rather than crash
      return row.value;
    }
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
   * Upsert a batch of key→value pairs inside a single transaction.
   * Called by the collector flush — much faster than individual inserts.
   * @inheritdoc
   */
  async batchSet(schema: string, table: string, writes: Map<string, unknown>): Promise<void> {
    const { db, raw } = this.open(schema);
    this.ensureTable(schema, table, raw);

    const tbl = buildSqliteTable(table);

    // drizzle's sync transaction runs the callback immediately => don't call the result
    db.transaction((tx) => {
      for (const [key, value] of writes) {
        const serialized = JSON.stringify(value);
        tx.insert(tbl)
          .values({ id: key, value: serialized })
          .onConflictDoUpdate({ target: tbl.id, set: { value: serialized } })
          .run();
      }
    });
  }

  /** @inheritdoc */
  async delete(schema: string, table: string, key: string): Promise<void> {
    const { db, raw } = this.open(schema);
    this.ensureTable(schema, table, raw);

    const tbl = buildSqliteTable(table);
    db.delete(tbl).where(eq(tbl.id, key)).run();
  }

  /** Close all open `.db` file handles. */
  async close(): Promise<void> {
    for (const raw of this.raws.values()) {
      raw.close();
    }
    this.dbs.clear();
    this.raws.clear();
    this.ready.clear();
  }
}
