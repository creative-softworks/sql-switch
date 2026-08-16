/**
 * @packageDocumentation
 * Public entry point — the fluent API facade.
 *
 * One API, two engines. `db.schema("antinuke").table("settings").key("guild_123")` resolves
 * to `./data/databases/antinuke.db` (table `settings`) in local mode, or the Postgres
 * logical schema `antinuke.settings` in cloud mode. Application code never changes.
 *
 * @example Connecting
 * ```ts
 * import { createDAL } from 'sql-switch';
 *
 * const db = createDAL();
 * await db.connect({
 *   db: { mode: 'local', dataDir: './data/databases', wal: true },
 *   collector: { enabled: true, time: 3000 },
 * });
 * ```
 *
 * @example Reading & writing
 * ```ts
 * // read
 * const settings = await db.schema('antinuke').table('settings').key('guild_123').get();
 *
 * // write (queued to the collector, flushed in bulk)
 * await db.schema('antinuke').table('settings').key('guild_123').set({ strict: true });
 *
 * // write immediately, bypassing the collector
 * await db.schema('antinuke').table('settings').key('guild_123').set({ strict: true }).force();
 * ```
 */

import { SqliteDriver } from './drivers/sqlite-drizzle.js';
import { PostgresDriver } from './drivers/postgres-drizzle.js';
import { WriteCollector } from './utils/collector.js';
import { TableContext } from './schema-manager.js';
import { ConfigurationError, NotConnectedError } from './errors.js';
import { engineSwap } from './engine-swap.js';
import type { EngineSwapOptions, EngineSwapResult } from './engine-swap.js';
import type { DALConfig, DatabaseDriver, CollectorConfig, SqliteConfig } from './types.js';

export * from './types.js';
export * from './errors.js';
export * from './engine-swap.js';
export { validateName, NAME_PATTERN, TableContext } from './schema-manager.js';

/** default collector settings, merged with whatever the user passes in */
const COLLECTOR_DEFAULTS: Required<CollectorConfig> = { enabled: true, time: 3000 };

/**
 * Options for {@link DAL.swapEngine} => same as {@link EngineSwapOptions}, except the paths
 * & connection string default to whatever this DAL was connected with.
 */
export interface DalSwapOptions extends EngineSwapOptions {
  /**
   * Reconnect on the target engine once the data has moved (up => cloud, down => local),
   * reusing the current collector settings. Set `false` to leave the DAL closed.
   * @defaultValue `true`
   */
  reconnect?: boolean;
}

/**
 * A pending write that is both awaitable **and** chainable with `.force()`.
 *
 * Awaiting it directly queues the write through the collector (batched, flushed on the
 * next interval). Calling `.force()` skips the collector and hits the driver immediately.
 *
 * @typeParam T - Resolved value type (always `void` for the current write operations).
 *
 * @example
 * ```ts
 * // queued — returns as soon as it's buffered
 * await db.schema('economy').table('balances').key('user_1').set({ coins: 100 });
 *
 * // immediate — resolves only once the DB has actually written it
 * await db.schema('economy').table('balances').key('user_1').set({ coins: 100 }).force();
 * ```
 */
export class WriteOperation<T> implements PromiseLike<T> {
  constructor(
    private queued: () => Promise<T>,
    private immediate: () => Promise<T>,
  ) {}

  /** Makes the operation awaitable => runs the queued (collector) path. */
  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.queued().then(onFulfilled, onRejected);
  }

  /** Bypass the write collector & execute against the database right now. */
  force(): Promise<T> {
    return this.immediate();
  }
}

/**
 * Terminal node of the fluent chain — bound to one `schema:table:key` triple.
 * Returned by {@link TableProxy.key}.
 */
export class KeyProxy {
  /** @internal */
  constructor(
    private ctx: TableContext,
    private key: string,
    private driver: DatabaseDriver,
    private collector: WriteCollector | null,
  ) {}

  /**
   * Read the value at this key.
   * @returns The stored value, or `null` if the key doesn't exist.
   * @typeParam T - Expected shape of the stored value.
   */
  async get<T = unknown>(): Promise<T | null> {
    return (await this.driver.get(this.ctx.schema, this.ctx.table, this.key)) as T | null;
  }

  /**
   * Write a value at this key (upsert).
   * Await it to queue via the collector, or call `.force()` to write immediately.
   *
   * @throws {TypeError} if value contains circular references or unsupported types (e.g. BigInt without replacer)
   */
  set<T = unknown>(value: T): WriteOperation<void> {
    // validate JSON.stringify won't throw before queuing or writing
    try {
      JSON.stringify(value);
    } catch (err) {
      throw new TypeError(
        `cannot serialize value for storage: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return new WriteOperation<void>(
      async () => {
        // collector disabled => fall straight through to the driver
        if (!this.collector) {
          return this.driver.set(this.ctx.schema, this.ctx.table, this.key, value);
        }
        this.collector.queue(this.ctx.schema, this.ctx.table, this.key, value);
      },
      () => this.driver.set(this.ctx.schema, this.ctx.table, this.key, value),
    );
  }

  /**
   * Delete this key.
   *
   * @remarks
   * Deletes always run immediately, even when awaited without `.force()`. Routing them
   * through the collector would mean a queued `set()` on the same key could land after
   * the delete & resurrect the row. `.force()` is accepted for API symmetry.
   */
  delete(): WriteOperation<void> {
    const run = () => this.driver.delete(this.ctx.schema, this.ctx.table, this.key);
    return new WriteOperation<void>(run, run);
  }
}

/** Table-level node of the fluent chain. Returned by {@link SchemaProxy.table}. */
export class TableProxy {
  /** @internal */
  constructor(
    private ctx: TableContext,
    private driver: DatabaseDriver,
    private collector: WriteCollector | null,
  ) {}

  /**
   * Select a key within this table.
   * @param id - The lookup key (e.g. `guild_123`).
   */
  key(id: string): KeyProxy {
    return new KeyProxy(this.ctx, id, this.driver, this.collector);
  }
}

/** Schema-level node of the fluent chain. Returned by {@link DAL.schema}. */
export class SchemaProxy {
  /** @internal */
  constructor(
    private schemaName: string,
    private driver: DatabaseDriver,
    private collector: WriteCollector | null,
  ) {}

  /**
   * Select a table within this schema.
   * @param name - Table name. Must match `^[a-zA-Z0-9-]+$`.
   * @throws {@link InvalidNameError} on an invalid name.
   */
  table(name: string): TableProxy {
    // TableContext validates both names on construction
    return new TableProxy(new TableContext(this.schemaName, name), this.driver, this.collector);
  }
}

/**
 * The DAL instance. Create one with {@link createDAL}, then `connect()` before use.
 * A single instance is meant to be shared across your whole app.
 */
export class DAL {
  private driver: DatabaseDriver | null = null;
  private collector: WriteCollector | null = null;
  // kept so swapEngine() can inherit paths/credentials & reconnect afterwards
  private config: DALConfig | null = null;

  /**
   * Initialise the driver & collector from config.
   *
   * @param config - Engine mode + collector settings.
   * @throws {@link ConfigurationError} if the config is missing required fields.
   */
  async connect(config: DALConfig): Promise<void> {
    if (!config?.db?.mode) {
      throw new ConfigurationError('config.db.mode is required — expected "local" or "cloud"');
    }

    if (config.db.mode === 'local') {
      this.driver = new SqliteDriver(config.db);
    } else if (config.db.mode === 'cloud') {
      if (!config.db.connectionString) {
        throw new ConfigurationError('config.db.connectionString is required in cloud mode');
      }
      this.driver = new PostgresDriver(config.db);
    } else {
      throw new ConfigurationError(
        `unknown db mode "${(config.db as { mode: string }).mode}" — expected "local" or "cloud"`,
      );
    }

    const collectorConfig = { ...COLLECTOR_DEFAULTS, ...(config.collector ?? {}) };
    if (collectorConfig.time <= 0) {
      throw new ConfigurationError('collector.time must be greater than 0');
    }

    // disabled => every write goes straight to the driver
    this.collector = collectorConfig.enabled
      ? new WriteCollector(this.driver, collectorConfig)
      : null;

    this.config = config;
  }

  /**
   * Start a fluent chain on the given schema.
   *
   * Maps to `./data/databases/<name>.db` in local mode, or the Postgres logical schema
   * `<name>` in cloud mode.
   *
   * @param name - Schema name. Must match `^[a-zA-Z0-9-]+$`.
   * @throws {@link NotConnectedError} if called before `connect()`.
   */
  schema(name: string): SchemaProxy {
    if (!this.driver) throw new NotConnectedError();
    return new SchemaProxy(name, this.driver, this.collector);
  }

  /** Flush any pending writes & close all connections. Call on graceful shutdown. */
  async close(): Promise<void> {
    if (this.collector) {
      await this.collector.stop();
      this.collector = null;
    }
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  /**
   * Swap this DAL onto the other engine from code => same migration as
   * `npm run db:engine-swap`, no terminal involved.
   *
   * Pending writes are flushed & the current handles closed first (deleting a `.db` file out
   * from under an open connection is asking for trouble), then the data moves, then the DAL
   * reconnects on the target engine reusing the same collector settings.
   *
   * Anything you don't pass is inherited from `connect()` => `dataDir` in local mode,
   * `connectionString` in cloud mode, falling back to `DATABASE_URL`. Missing schemas,
   * tables & directories on the target side are created.
   *
   * @param options - Direction plus any overrides. See {@link DalSwapOptions}.
   * @throws {@link NotConnectedError} if called before `connect()`.
   * @throws {@link ConfigurationError} if no Postgres connection string can be resolved.
   *
   * @example
   * ```ts
   * // local SQLite => production Postgres, then keep querying the same db object
   * const result = await db.swapEngine({ direction: 'up', onConflict: 'overwrite' });
   * console.log(`moved ${result.totalRows} rows`);
   * ```
   */
  async swapEngine(options: DalSwapOptions): Promise<EngineSwapResult> {
    if (!this.config) throw new NotConnectedError();

    const current = this.config;
    const reconnect = options.reconnect ?? true;

    // inherit from the live config so a bare { direction } call just works
    const dataDir =
      options.dataDir ?? (current.db.mode === 'local' ? current.db.dataDir : undefined);
    const connectionString =
      options.connectionString ??
      (current.db.mode === 'cloud' ? current.db.connectionString : undefined);

    // built field by field => exactOptionalPropertyTypes rejects explicit undefined
    const swapOptions: EngineSwapOptions = { direction: options.direction };
    if (dataDir !== undefined) swapOptions.dataDir = dataDir;
    if (connectionString !== undefined) swapOptions.connectionString = connectionString;
    if (options.keepLocalFiles !== undefined) swapOptions.keepLocalFiles = options.keepLocalFiles;
    if (options.onConflict !== undefined) swapOptions.onConflict = options.onConflict;
    if (options.onProgress !== undefined) swapOptions.onProgress = options.onProgress;

    // flush & release handles before the migration touches any file
    await this.close();

    const result = await engineSwap(swapOptions);

    if (!reconnect) return result;

    if (options.direction === 'up') {
      // engineSwap already resolved this for the migration, resolve it the same way here
      const url = connectionString ?? process.env.DATABASE_URL;
      if (!url) {
        throw new ConfigurationError(
          'cannot reconnect in cloud mode => pass connectionString or set DATABASE_URL',
        );
      }
      const next: DALConfig = { db: { mode: 'cloud', connectionString: url } };
      if (current.collector !== undefined) next.collector = current.collector;
      await this.connect(next);
      return result;
    }

    const next: DALConfig = { db: this.localConfigFrom(current, dataDir) };
    if (current.collector !== undefined) next.collector = current.collector;
    await this.connect(next);
    return result;
  }

  // rebuild the local config for a downward swap, keeping the wal choice if there was one
  private localConfigFrom(current: DALConfig, dataDir: string | undefined): SqliteConfig {
    const db: SqliteConfig = { mode: 'local' };
    if (dataDir !== undefined) db.dataDir = dataDir;
    if (current.db.mode === 'local' && current.db.wal !== undefined) db.wal = current.db.wal;
    return db;
  }

  /** Number of writes currently buffered in the collector (0 when disabled). */
  get pendingWrites(): number {
    return this.collector?.pendingCount ?? 0;
  }
}

/**
 * Create a new DAL instance.
 *
 * @example
 * ```ts
 * const db = createDAL();
 * await db.connect({ db: { mode: 'local' } });
 * ```
 */
export function createDAL(): DAL {
  return new DAL();
}

export default createDAL;
