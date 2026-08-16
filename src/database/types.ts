/**
 * @packageDocumentation
 * Public TypeScript interfaces and types for sql-switch.
 * Import these in your app for a typed config object.
 *
 * @example
 * ```ts
 * import type { DALConfig } from 'sql-switch';
 *
 * const config: DALConfig = {
 *   db: { mode: 'local', dataDir: './data/databases', wal: true },
 *   collector: { enabled: true, time: 3000 },
 * };
 * ```
 */

/**
 * Controls write collector behaviour.
 * The collector batches writes in RAM and flushes to the DB in bulk at each interval.
 */
export interface CollectorConfig {
  /** Enable or disable write batching. @default true */
  enabled?: boolean;
  /**
   * Flush interval in milliseconds.
   * @default 3000
   * @remarks Values >= 10000 emit a runtime warning — high intervals hurt app responsiveness.
   */
  time?: number;
}

/** Config for local SQLite mode — one `.db` file per schema. */
export interface SqliteConfig {
  mode: 'local';
  /**
   * Directory where `.db` files are stored.
   * @default './data/databases'
   */
  dataDir?: string;
  /**
   * Enable WAL (Write-Ahead Logging) on all SQLite files.
   * WAL allows concurrent reads & a single writer without full file locks.
   * @default true
   */
  wal?: boolean;
  /**
   * After an upward migration (SQLite → PostgreSQL), delete the local `.db` files.
   * Set to `false` to keep them as a local backup.
   *
   * @deprecated Not read by `connect()`. Pass `keepLocalFiles` to `engineSwap()` /
   * `db.swapEngine()`, or `--keep` on the CLI. Kept so existing configs still typecheck.
   * @default true
   */
  deleteAfterMigration?: boolean;
}

/** Config for production PostgreSQL mode — one logical schema per module. */
export interface PostgresConfig {
  mode: 'cloud';
  /** Full Postgres connection string. e.g. `postgres://user:pass@localhost:5432/mydb` */
  connectionString: string;
  pool?: {
    /**
     * Max connections in the local pool before PgBouncer multiplexing.
     * Keep low (3–5) when running behind PgBouncer in transaction mode.
     * @default 5
     */
    max?: number;
  };
}

/** Root config object passed to `db.connect()`. */
export interface DALConfig {
  db: SqliteConfig | PostgresConfig;
  /** Write collector configuration. Defaults to enabled with a 3s flush interval. */
  collector?: CollectorConfig;
}

/**
 * Internal driver interface — both SQLite & Postgres adapters implement this.
 * Not part of the public API; use the fluent interface returned by `createDAL()`.
 * @internal
 */
export interface DatabaseDriver {
  /** Get a value by key. Returns `null` if the key does not exist. */
  get(schema: string, table: string, key: string): Promise<unknown>;
  /** Immediately upsert a single key — bypasses the collector (used by `.force()`). */
  set(schema: string, table: string, key: string, value: unknown): Promise<void>;
  /** Upsert a batch of key→value pairs in a single transaction. Called by the collector flush. */
  batchSet(schema: string, table: string, writes: Map<string, unknown>): Promise<void>;
  /** Delete a key from the given schema/table. */
  delete(schema: string, table: string, key: string): Promise<void>;
  /** Close all connections and file handles gracefully. */
  close(): Promise<void>;
}
