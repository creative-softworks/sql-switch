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
 * State of the collector's circuit breaker.
 *
 * - `closed` — normal operation, writes are accepted.
 * - `open` — the buffer overflowed (a sustained outage gets there through the retry path), writes
 *   are rejected with `DatabaseUnavailableError` until the cooldown is over.
 * - `half-open` — the cooldown expired & exactly one trial flush is being attempted. Success
 *   closes the breaker, failure sends it back to `open` with the cooldown re-armed.
 */
export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Optional callbacks the collector fires so an app can observe what the buffer is doing.
 *
 * @remarks
 * Hooks are for observability => they're called from the flush path, so keep them cheap & don't
 * throw from them (a throwing hook is caught & logged, it can't take the flush down with it).
 */
export interface CollectorHooks {
  /**
   * Fired on every circuit breaker transition, with a short reason on the way to `open`.
   *
   * @remarks A trip to read-only mode is observed here (`state === 'open'`) => there's no separate
   * "onTrip", it'd fire for the same event.
   *
   * @example
   * ```ts
   * collector: {
   *   hooks: {
   *     onStateChange: (state) => metrics.gauge('db.breaker', state === 'closed' ? 0 : 1),
   *   },
   * }
   * ```
   */
  onStateChange?: (state: BreakerState, reason?: string) => void;

  /**
   * Fired when a flush group fails => the writes go back in the buffer & are retried, this is your
   * hook to log/count the transient failure.
   *
   * @param error - Whatever the driver threw.
   * @param context - Which group failed & how many keys were in it.
   *
   * @remarks
   * Registering this replaces the default `console.error` for a failed flush => wire it to your
   * logger. It fires per failed group, per flush, so a sustained outage fires it every interval.
   */
  onFlushError?: (
    error: unknown,
    context: { schema: string; table: string; writes: number },
  ) => void;

  /**
   * Fired when buffered writes are lost for good => the buffer overflowed while retrying a failed
   * group, or `close()`/shutdown couldn't drain what was left.
   *
   * @param writes - How many writes were dropped.
   * @param reason - Short description of which of the two happened.
   *
   * @remarks This is real data loss, not a retry => the one hook worth paging on. Replaces the
   * default `console.error` for the same events.
   */
  onDrop?: (writes: number, reason: string) => void;

  /**
   * Fired once each time the buffer crosses its high-water mark (80% of the cap) on the way up =>
   * the flush isn't keeping up with incoming writes and the breaker is getting closer to tripping.
   *
   * @param pending - Buffered writes at the crossing.
   * @param max - The cap the breaker trips at ({@link BreakerState} `open`).
   *
   * @remarks
   * Edge triggered per flush cycle, not per write => it won't spam. An early warning to shed load or
   * widen the flush before writes start getting rejected.
   */
  onBackpressure?: (pending: number, max: number) => void;
}

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
  /**
   * Let the circuit breaker re-arm itself on a timer after an outage: once `recoverAfter` is up,
   * one trial flush decides whether the database is back.
   *
   * Set `false` to switch off that timed self-heal => the breaker then stays tripped until the
   * process restarts (the pre-recovery behaviour), only worth it if you'd rather a supervisor
   * replace the process than have it heal in place. Note this disables the *automatic, interval
   * driven* recovery path only: a flush that succeeds for any other reason still closes the
   * breaker, so the drain on `close()` or on shutdown can clear it as a side effect of getting
   * your last writes out.
   *
   * @defaultValue `true`
   */
  autoRecover?: boolean;
  /**
   * How long to stay in read-only mode before attempting a trial flush, in milliseconds.
   *
   * @defaultValue `10000`
   * @remarks Ignored when `autoRecover` is `false`. Every failed trial re-arms the same wait, so
   * this is also the retry spacing during a long outage => low values hammer a struggling
   * database, high values keep the app read-only longer than it has to be.
   */
  recoverAfter?: number;
  /**
   * Drain the buffer when the process is going away => `SIGINT`, `SIGTERM` & `beforeExit`.
   *
   * Containers stop processes with `SIGTERM`, so without this a deploy or a scale down silently
   * loses up to one flush interval of writes. The handler flushes, takes itself off & re-raises the
   * signal, so the app's own shutdown still runs => the library never calls `process.exit()` for
   * you. Hard kills (`SIGKILL`) can't be caught by anyone, that window stays lost.
   *
   * Set `false` if your app owns shutdown & already calls `await db.close()` (which flushes too),
   * or if you don't want a library holding signal listeners at all.
   *
   * @defaultValue `true`
   */
  flushOnExit?: boolean;
  /** Observability callbacks. See {@link CollectorHooks}. */
  hooks?: CollectorHooks;
}

/**
 * Config for local SQLite mode — one `.db` file per schema.
 *
 * @remarks
 * Schemas are meant to be coarse => one per module (`antinuke`, `economy`), not one per entity.
 * Each distinct schema opens a `.db` file whose handle is cached for the life of the process with
 * no LRU eviction (in-process writes to one schema serialize on that single cached handle), so a
 * schema-per-guild layout at the stated 100k+ scale runs into the OS file descriptor limit long
 * before disk fills. Put the entity id in the *key*, not the schema => thousands of keys in one
 * `settings` table is flat & cheap, thousands of schemas is not. Cloud mode shares one pool across
 * logical schemas & has no such ceiling, so this is a local-mode shape to design around, not a wall
 * production hits.
 */
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
   * How long a blocked write waits for the lock before giving up with `SQLITE_BUSY`, in
   * milliseconds. `0` fails immediately.
   *
   * @defaultValue `5000`
   * @remarks
   * WAL removes reader/writer contention but not writer/writer => a second connection to the same
   * `.db` file (another process, or another `SqliteDriver`) still has to wait its turn. Without a
   * busy timeout that second writer throws `SQLITE_BUSY` the instant it collides, which surfaces as
   * a spurious flush failure under nothing worse than two workers touching one file. This sets the
   * grace SQLite waits before it actually gives up. In-process it rarely matters (one cached handle
   * per schema serializes writes already), it's the multi-process case this covers.
   */
  busyTimeout?: number;
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
    /**
     * How long to wait for a free/new connection before giving up, in milliseconds.
     *
     * @defaultValue `10000`
     * @remarks Bounds the wait when every slot is busy or the server is unreachable => without it a
     * connection attempt can hang indefinitely. `0` waits forever (not recommended).
     */
    connectionTimeoutMillis?: number;
    /**
     * How long an idle connection lingers in the pool before it's closed, in milliseconds.
     *
     * @defaultValue `30000`
     * @remarks Reaping idle connections keeps the pool from holding server resources through quiet
     * periods. `0` keeps them open indefinitely.
     */
    idleTimeoutMillis?: number;
    /**
     * Ceiling on a single operation, in milliseconds. `0` turns it off.
     *
     * Without one, a query that never answers holds a pool connection for the rest of the
     * process' life => `max` of those and every later read & write blocks with no error at all,
     * which is a worse outage than the one that caused it. A flat key lookup is a couple of ms on
     * a healthy database, so this isn't a performance budget, it's the line past which the answer
     * is worth less than the connection.
     *
     * @defaultValue `30000`
     * @remarks Enforced client side on every op, plus `SET LOCAL statement_timeout` inside the
     * bulk flush transaction (the one op that can genuinely block on a lock). Never sent as a
     * startup parameter => PgBouncer drops connections carrying parameters it doesn't track.
     */
    statementTimeout?: number;
  };
}

/** Root config object passed to `db.connect()`. */
export interface DALConfig {
  db: SqliteConfig | PostgresConfig;
  /** Write collector configuration. Defaults to enabled with a 3s flush interval. */
  collector?: CollectorConfig;
}

/**
 * Options shared by the enumeration methods on a table
 * ({@link TableProxy.keys} / {@link TableProxy.values} / {@link TableProxy.entries} /
 * {@link TableProxy.count}).
 */
export interface ScanOptions {
  /**
   * Only include ids that begin with this exact, **case sensitive** prefix.
   *
   * @remarks
   * Matched literally, never as a pattern => the prefix is bound as a parameter, so glob/SQL
   * metacharacters (`%`, `_`, `*`, `?`) in it match themselves and nothing else. Omit for the whole
   * table. See {@link TableProxy.startsWith} for the sugar form.
   */
  prefix?: string;
}

/**
 * One row of a driver scan => a lookup key and its already-deserialized value.
 * @internal
 */
export interface StoredEntry {
  id: string;
  value: unknown;
}

/**
 * Internal driver interface — both SQLite & Postgres adapters implement this.
 * Not part of the public API; use the fluent interface returned by `createDAL()`.
 * @internal
 */
export interface DatabaseDriver {
  /** Get a value by key. Returns `null` if the key does not exist. */
  get(schema: string, table: string, key: string): Promise<unknown>;
  /**
   * Does a row exist for this key? Distinct from `get() !== null` => a row storing a literal `null`
   * value exists, but `get()` returns `null` for it, so `has()` can't be built on `get()`.
   */
  exists(schema: string, table: string, key: string): Promise<boolean>;
  /** Immediately upsert a single key — bypasses the collector (used by `.force()`). */
  set(schema: string, table: string, key: string, value: unknown): Promise<void>;
  /** Upsert a batch of key→value pairs in a single transaction. Called by the collector flush. */
  batchSet(schema: string, table: string, writes: Map<string, unknown>): Promise<void>;
  /** Delete a key from the given schema/table. */
  delete(schema: string, table: string, key: string): Promise<void>;
  /**
   * Stream every stored entry, in ascending id order, optionally filtered to an id prefix.
   * Yields one row at a time (a cursor on SQLite, keyset-paged chunks on Postgres) so peak memory
   * is one row/chunk, never the whole table.
   */
  scan(schema: string, table: string, opts?: ScanOptions): AsyncIterable<StoredEntry>;
  /** Count stored rows, optionally filtered to an id prefix. Never materializes the rows. */
  count(schema: string, table: string, opts?: ScanOptions): Promise<number>;
  /** Close all connections and file handles gracefully. */
  close(): Promise<void>;
}
