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

import { WriteCollector, resolveCollectorConfig } from './utils/collector.js';
import { assertStorableKey, serializeValue } from './utils/value.js';
import { TableContext } from './schema-manager.js';
import { ConfigurationError, NotConnectedError } from './errors.js';
import { engineSwap } from './engine-swap.js';
import type { EngineSwapOptions, EngineSwapResult } from './engine-swap.js';
import type { DALConfig, DatabaseDriver, ScanOptions, SqliteConfig } from './types.js';

export * from './types.js';
export * from './errors.js';
export * from './engine-swap.js';
export { validateName, NAME_PATTERN, TableContext } from './schema-manager.js';

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
 * The write is already scheduled by the time you hold one of these (see {@link KeyProxy.set} =>
 * eager). Awaiting it waits for the queued write (or the driver write, when the collector is off);
 * calling `.force()` skips the collector and writes to the driver immediately.
 *
 * @typeParam T - Resolved value type (always `void` for the current write operations).
 *
 * @example
 * ```ts
 * // queued — the write is buffered the moment set() is called; await just waits for that
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

  /** Makes the operation awaitable => waits for the already-scheduled (collector) write. */
  // biome-ignore lint/suspicious/noThenProperty: WriteOperation is an intentional PromiseLike => await & .then() resolve the already-queued write (see class docstring)
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
  ) {
    // the id column is TEXT on both engines, but only one of them can hold a NUL => refuse it here
    // so the same key fails the same way in local & cloud mode
    assertStorableKey(key);
  }

  /**
   * Read the value at this key.
   *
   * @returns The stored value, or `null` if the key doesn't exist.
   * @typeParam T - Expected shape of the stored value.
   *
   * @remarks
   * Read your writes => a value still sitting in the collector buffer wins over the stored row,
   * so a queued `set()` is visible to the very next `get()` without waiting for the flush. The
   * buffered copy goes through the same JSON round trip the driver does, so a value doesn't
   * change shape depending on whether it landed yet.
   *
   * @see {@link KeyProxy.set}
   *
   * @example
   * ```ts
   * await db.schema('antinuke').table('settings').key('guild_1').set({ strict: true });
   * // queued, not flushed yet — still reads back as { strict: true }
   * const settings = await db.schema('antinuke').table('settings').key('guild_1').get();
   * ```
   */
  async get<T = unknown>(): Promise<T | null> {
    if (this.collector) {
      const buffered = this.collector.peek(this.ctx.schema, this.ctx.table, this.key);
      if (buffered.hit) return buffered.value as T | null;
    }
    return (await this.driver.get(this.ctx.schema, this.ctx.table, this.key)) as T | null;
  }

  /**
   * Write a value at this key (upsert).
   *
   * The write is scheduled the moment you call `set()` => a fire and forget `set(v)` with no
   * `await` and no `.force()` still lands. Awaiting it only decides whether you wait for the queue
   * (or the driver, when the collector is off); `.force()` swaps the queued copy for an immediate
   * durable write.
   *
   * @throws {@link InvalidValueError} (a `TypeError`) for a value the two engines can't store
   * identically => `undefined`, `NaN`/`Infinity`, a NUL character anywhere in a string or property
   * name, a circular reference, or a BigInt.
   * @throws {@link DatabaseUnavailableError} at the call site when the collector's breaker is open.
   *
   * @remarks
   * Eager on purpose (A2): the old behaviour was lazy => a `set()` that was never awaited & never
   * forced quietly did nothing, which is the easiest way there is to lose a write. Now the queue
   * happens synchronously, at the call, so the only thing await changes is when you find out it's
   * done.
   *
   * Validation is synchronous too => a bad value (or an open breaker) throws right here, before
   * anything is queued or written, so it can't sit in the buffer & blow up inside a flush where the
   * only trace is a log line. `undefined` as an object *property* is still dropped, the way
   * `JSON.stringify` always has.
   *
   * A value round trips through JSON, so two things are stored but come back reshaped rather than
   * refused: an integer past `Number.MAX_SAFE_INTEGER` (2^53) loses precision the moment it's read
   * back as a JS number (`12345678901234567890` returns as `...567000`), and a `Buffer`/typed array
   * degrades to `{ type: 'Buffer', data: [...] }`, never a `Buffer` again. store a big integer as a
   * string & base64 encode binary yourself if you need either back intact => this is JSON's doing,
   * not the engine's, so it's identical in local & cloud mode. only the `id` (key) is precision safe.
   *
   * @see {@link WriteOperation.force} — write immediately, bypassing the collector.
   * @see {@link KeyProxy.get} — reads see this write straight away (read your writes).
   */
  set<T = unknown>(value: T): WriteOperation<void> {
    // validate & serialize in one pass. the text is kept & handed to the collector so the buffered
    // snapshot doesn't have to serialize the same value again. throws here => at the call, eagerly
    const json = serializeValue(value);

    // schedule now, not on await => queue() is synchronous (it buffers or throws right here), so a
    // bare set() commits the write before this function returns
    let scheduled: Promise<void>;
    if (this.collector) {
      this.collector.queue(this.ctx.schema, this.ctx.table, this.key, value, json);
      scheduled = Promise.resolve();
    } else {
      // no collector => the driver write is the operation. fire it now & keep the promise so an
      // await surfaces a failure. the extra catch keeps a fire and forget failure from crashing the
      // process as an unhandled rejection => an await still re-observes the real error off `scheduled`
      scheduled = this.driver.set(this.ctx.schema, this.ctx.table, this.key, value);
      void scheduled.catch(() => undefined);
    }

    return new WriteOperation<void>(
      () => scheduled,
      async () => {
        // collector off => the eager write already is the immediate write, don't run it twice
        if (!this.collector) return scheduled;
        await this.dropbuffered();
        return this.driver.set(this.ctx.schema, this.ctx.table, this.key, value);
      },
    );
  }

  /**
   * Delete this key.
   *
   * @remarks
   * Deletes always run immediately, even when awaited without `.force()`. Routing them
   * through the collector would mean a queued `set()` on the same key could land after
   * the delete & resurrect the row. `.force()` is accepted for API symmetry.
   *
   * Any value still buffered for this key is dropped first, so a queued `set()` issued before
   * the delete can't come back on the next flush.
   */
  delete(): WriteOperation<void> {
    // start now, not on await => a bare `delete()` has to land the same way a bare `set()` does. it
    // used to only run inside the WriteOperation callbacks, so a delete that was never awaited (or
    // forced) silently vanished while a queued set() on the same key survived (C1). dropbuffered()
    // first => evict() runs synchronously right here, so a set() queued before this is gone before
    // the next flush can pick it up
    const started = (async (): Promise<void> => {
      await this.dropbuffered();
      return this.driver.delete(this.ctx.schema, this.ctx.table, this.key);
    })();
    // fire and forget must not crash the process as an unhandled rejection => an await/.force() still
    // re-observes the real error off `started`, the same guard set() uses
    void started.catch(() => undefined);

    // deletes never route through the collector => queued & immediate are the one eager write. force()
    // is accepted for API symmetry (see remarks), there's just nothing extra to bypass
    return new WriteOperation<void>(
      () => started,
      () => started,
    );
  }

  /**
   * Clear this key out of the collector before writing it straight to the driver.
   *
   * Two halves & both matter: `evict()` stops a queued value landing on top of what we're about
   * to write, `settle()` waits out a flush that's *already* committing the old value (that one
   * would otherwise land after us & win).
   */
  private async dropbuffered(): Promise<void> {
    if (!this.collector) return;
    this.collector.evict(this.ctx.schema, this.ctx.table, this.key);
    await this.collector.settle();
  }

  /**
   * Does this key exist?
   *
   * @returns `true` if a value is stored (or buffered) for this key, `false` otherwise.
   * @remarks
   * A queued `set()` counts as existing (read your writes), so the buffer is checked first. Past
   * that it asks the driver's existence check rather than `get() !== null` => a row storing a
   * literal `null` value still exists, and `has()` has to say so where `get()` can only return the
   * `null` it can't tell apart from a missing key.
   */
  async has(): Promise<boolean> {
    if (this.collector) {
      const buffered = this.collector.peek(this.ctx.schema, this.ctx.table, this.key);
      if (buffered.hit) return true;
    }
    return this.driver.exists(this.ctx.schema, this.ctx.table, this.key);
  }

  /**
   * Add to the number stored at this key (a missing key counts as `0`).
   *
   * @param amount - How much to add (may be negative).
   * @returns The new total.
   * @throws {TypeError} if the stored value isn't a number.
   * @throws {@link InvalidValueError} if the result isn't finite (e.g. adding `Infinity`).
   *
   * @remarks
   * Read-modify-write, not atomic => it reads (seeing its own buffered writes), computes, then
   * writes back through the collector. Two un-awaited `add()`s on the same key can read the same
   * base & one update is lost. Sequential `await`ed calls are fine; for contended counters under
   * real concurrency you need a lock the DAL doesn't provide.
   */
  async add(amount: number): Promise<number> {
    const base = (await this.get<unknown>()) ?? 0;
    if (typeof base !== 'number') {
      throw new TypeError(`cannot add to a non-number value at "${this.key}"`);
    }
    const next = base + amount;
    await this.set(next);
    return next;
  }

  /**
   * Subtract from the number stored at this key (a missing key counts as `0`).
   *
   * @param amount - How much to subtract.
   * @returns The new total.
   * @throws {TypeError} if the stored value isn't a number.
   * @remarks Same non-atomic read-modify-write caveat as {@link KeyProxy.add}.
   */
  async sub(amount: number): Promise<number> {
    return this.add(-amount);
  }

  /**
   * Append one or more items to the array stored at this key (a missing key starts a new array).
   *
   * @param items - Items to append.
   * @returns The updated array.
   * @throws {TypeError} if the stored value isn't an array.
   * @remarks Same non-atomic read-modify-write caveat as {@link KeyProxy.add}.
   */
  async push<T = unknown>(...items: T[]): Promise<T[]> {
    const { arr } = await this.readArray<T>();
    arr.push(...items);
    await this.set(arr);
    return arr;
  }

  /**
   * Prepend one or more items to the array stored at this key.
   *
   * @param items - Items to prepend, kept in the given order.
   * @returns The updated array.
   * @throws {TypeError} if the stored value isn't an array.
   * @remarks Same non-atomic read-modify-write caveat as {@link KeyProxy.add}.
   */
  async unshift<T = unknown>(...items: T[]): Promise<T[]> {
    const { arr } = await this.readArray<T>();
    arr.unshift(...items);
    await this.set(arr);
    return arr;
  }

  /**
   * Remove & return the last item of the array stored at this key.
   *
   * @returns The removed item, or `undefined` if the array is empty or the key is missing.
   * @throws {TypeError} if the stored value isn't an array.
   * @remarks
   * A missing key is left missing => popping from nothing returns `undefined` without creating an
   * empty-array row. Same non-atomic read-modify-write caveat as {@link KeyProxy.add}.
   */
  async pop<T = unknown>(): Promise<T | undefined> {
    const { arr, existed } = await this.readArray<T>();
    // nothing stored => nothing to pop, and don't write an empty array onto a key that never existed
    if (!existed) return undefined;
    const item = arr.pop();
    await this.set(arr);
    return item;
  }

  /**
   * Remove & return the first item of the array stored at this key.
   *
   * @returns The removed item, or `undefined` if the array is empty or the key is missing.
   * @throws {TypeError} if the stored value isn't an array.
   * @remarks
   * A missing key is left missing => shifting from nothing returns `undefined` without creating an
   * empty-array row. Same non-atomic read-modify-write caveat as {@link KeyProxy.add}.
   */
  async shift<T = unknown>(): Promise<T | undefined> {
    const { arr, existed } = await this.readArray<T>();
    if (!existed) return undefined;
    const item = arr.shift();
    await this.set(arr);
    return item;
  }

  /**
   * Remove every element of the array that matches, and store what's left.
   *
   * @param match - A value (removed by strict `===` equality) or a predicate `(item, index) =>
   * boolean` (removed when it returns truthy).
   * @returns The array with the matches gone.
   * @throws {TypeError} if the stored value isn't an array.
   * @remarks
   * The value form is reference equality, so it won't match object elements => pass a predicate for
   * those. A missing key returns `[]` without creating a row. Same non-atomic read-modify-write
   * caveat as {@link KeyProxy.add}.
   */
  async pull<T = unknown>(match: T | ((item: T, index: number) => boolean)): Promise<T[]> {
    const { arr, existed } = await this.readArray<T>();
    if (!existed) return [];
    const hit =
      typeof match === 'function'
        ? (match as (item: T, index: number) => boolean)
        : (item: T): boolean => item === match;
    const kept = arr.filter((item, i) => !hit(item, i));
    await this.set(kept);
    return kept;
  }

  // read the value as an array => a missing key is an empty one, anything non-array is a type error.
  // `existed` lets the removal helpers avoid writing an empty array back onto a key that was never
  // there, which would materialize a phantom row just for asking to pop/shift/pull nothing
  private async readArray<T>(): Promise<{ arr: T[]; existed: boolean }> {
    const current = await this.get<unknown>();
    if (current == null) return { arr: [], existed: false };
    if (!Array.isArray(current)) {
      throw new TypeError(`cannot run an array operation on a non-array value at "${this.key}"`);
    }
    return { arr: current as T[], existed: true };
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

  /**
   * Stream every key in this table, in ascending id order.
   *
   * @param opts - Optional {@link ScanOptions} => `prefix` narrows to ids that start with it.
   * @returns An async iterator of ids => `for await (const id of table.keys())`.
   *
   * @remarks
   * Streaming on purpose (SC2): rows arrive one at a time (a cursor on SQLite, keyset-paged on
   * Postgres), so a scan of a 100k-row table never lands the whole thing in RAM. `break` out of the
   * loop early & the underlying cursor is released.
   *
   * Reads committed rows straight from the engine => a write still sitting in the collector buffer
   * is **not** visible here yet (unlike {@link KeyProxy.get}, which peeks the buffer). Enumerate
   * from a quiesced state, or `await`/`.force()` the writes you care about first, for an exact view.
   *
   * @example
   * ```ts
   * for await (const id of db.schema('antinuke').table('settings').keys({ prefix: 'guild-' })) {
   *   console.log(id);
   * }
   * ```
   */
  async *keys(opts?: ScanOptions): AsyncIterableIterator<string> {
    for await (const entry of this.driver.scan(this.ctx.schema, this.ctx.table, opts)) {
      yield entry.id;
    }
  }

  /**
   * Stream every value in this table, in ascending id order.
   *
   * @typeParam T - Expected shape of the stored values.
   * @param opts - Optional {@link ScanOptions} => `prefix` narrows to ids that start with it.
   * @returns An async iterator of values.
   *
   * @remarks Same streaming & buffer-visibility contract as {@link TableProxy.keys}.
   */
  async *values<T = unknown>(opts?: ScanOptions): AsyncIterableIterator<T> {
    for await (const entry of this.driver.scan(this.ctx.schema, this.ctx.table, opts)) {
      yield entry.value as T;
    }
  }

  /**
   * Stream every `[id, value]` pair in this table, in ascending id order.
   *
   * @typeParam T - Expected shape of the stored values.
   * @param opts - Optional {@link ScanOptions} => `prefix` narrows to ids that start with it.
   * @returns An async iterator of `[id, value]` tuples (destructure like `Map` entries).
   *
   * @remarks Same streaming & buffer-visibility contract as {@link TableProxy.keys}.
   *
   * @example
   * ```ts
   * for await (const [id, value] of db.schema('economy').table('balances').entries()) {
   *   console.log(id, value);
   * }
   * ```
   */
  async *entries<T = unknown>(opts?: ScanOptions): AsyncIterableIterator<[string, T]> {
    for await (const entry of this.driver.scan(this.ctx.schema, this.ctx.table, opts)) {
      yield [entry.id, entry.value as T];
    }
  }

  /**
   * Stream `[id, value]` pairs for every key whose id starts with `prefix`.
   *
   * Sugar for {@link TableProxy.entries} with `{ prefix }`. The prefix is matched exactly & case
   * sensitively, bound as a parameter, never as a pattern => `%`/`_`/`*` in it match themselves.
   *
   * @typeParam T - Expected shape of the stored values.
   * @param prefix - Exact id prefix to match.
   *
   * @example
   * ```ts
   * // every guild under the "guild-" namespace
   * for await (const [id, settings] of table.startsWith('guild-')) { ... }
   * ```
   */
  startsWith<T = unknown>(prefix: string): AsyncIterableIterator<[string, T]> {
    return this.entries<T>({ prefix });
  }

  /**
   * Count the rows in this table.
   *
   * @param opts - Optional {@link ScanOptions} => `prefix` counts only ids that start with it.
   * @returns The row total as a plain number (counted in the database, rows are never materialized).
   *
   * @remarks Counts committed rows => same buffer-visibility caveat as {@link TableProxy.keys}.
   *
   * @example
   * ```ts
   * const guilds = await db.schema('antinuke').table('settings').count({ prefix: 'guild-' });
   * ```
   */
  count(opts?: ScanOptions): Promise<number> {
    return this.driver.count(this.ctx.schema, this.ctx.table, opts);
  }

  /**
   * Delete every key in this table (or just those under a prefix).
   *
   * @param opts - Optional {@link ScanOptions} => `prefix` restricts the wipe to matching ids.
   *
   * @remarks
   * Scales linearly => it lists the matching ids (streamed, so the id list is the only thing held,
   * never the values) then deletes them one at a time through the same path as
   * {@link KeyProxy.delete}, so a queued `set()` on a deleted key can't resurrect it. On a huge
   * table that's a delete per row; it's a maintenance/reset operation, not a hot path.
   *
   * Only clears rows already committed to the engine plus their buffered copies => a brand new
   * key still sitting unflushed in the collector (never written to disk) isn't seen by the scan.
   * Flush first (`await`/`.force()` or `close()`) if you need it gone too.
   */
  async deleteAll(opts?: ScanOptions): Promise<void> {
    // collect the ids first => deleting rows mid-scan can disturb the driver's open cursor
    const ids: string[] = [];
    for await (const id of this.keys(opts)) ids.push(id);
    for (const id of ids) await this.key(id).delete();
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
   * @param name - Table name. Must match `^[a-zA-Z0-9_-]+$`.
   * @throws {@link InvalidNameError} on an invalid name.
   */
  table(name: string): TableProxy {
    // TableContext validates both names on construction
    return new TableProxy(new TableContext(this.schemaName, name), this.driver, this.collector);
  }
}

/**
 * Is `err` a module-resolution failure for the package `pkg` specifically?
 *
 * @remarks
 * The two engine drivers `import` an optional peer dep at the top (`better-sqlite3` / `pg`), so a
 * dynamic `import()` of a driver whose peer dep isn't installed rejects with a module-not-found
 * (`ERR_MODULE_NOT_FOUND` under ESM, `MODULE_NOT_FOUND` under the CJS build). We match the quoted
 * package name in the message so a *transitive* dep going missing keeps its own real stack instead
 * of being mislabelled "install better-sqlite3".
 */
function isMissingPackage(err: unknown, pkg: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false;
  const message = (err as { message?: unknown }).message;
  // both "Cannot find package 'pg'" & "Cannot find module 'pg'" quote the name => match the quotes
  return typeof message === 'string' && message.includes(`'${pkg}'`);
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
   * @throws {@link ConfigurationError} if the config is missing required fields, or if the engine's
   * optional peer dependency (`better-sqlite3` for local, `pg` for cloud) isn't installed.
   *
   * @remarks
   * Calling this on an already connected DAL replaces the engine instead of leaking it => the
   * previous collector is flushed & stopped and the previous driver closed (same work as
   * {@link DAL.close}), with a `console.warn` so it doesn't happen unnoticed. Without that the old
   * pg pool, flush timer & signal listeners stayed alive forever, and anything still buffered on
   * the old collector was never written by anybody.
   *
   * fragile, the order matters => the new engine is fully built (peer dep imported, driver
   * constructed & its own config validated) *before* the old one is torn down, so a `connect()`
   * that throws — bad config, a missing `better-sqlite3`/`pg`, a bad `busyTimeout` — leaves the
   * connection you already had fully intact. Only once the replacement exists do we flush & close
   * the old one and swap it in.
   */
  async connect(config: DALConfig): Promise<void> {
    if (!config?.db?.mode) {
      throw new ConfigurationError('config.db.mode is required — expected "local" or "cloud"');
    }
    if (config.db.mode !== 'local' && config.db.mode !== 'cloud') {
      throw new ConfigurationError(
        `unknown db mode "${(config.db as { mode: string }).mode}" — expected "local" or "cloud"`,
      );
    }
    if (config.db.mode === 'cloud' && !config.db.connectionString) {
      throw new ConfigurationError('config.db.connectionString is required in cloud mode');
    }

    // resolved up front so a bad collector setting throws before anything is torn down
    const collectorConfig = resolveCollectorConfig(config.collector);

    // build the replacement first, into a local => import the driver on demand (so the engine
    // you're not using, & its native module, never has to be installed) then construct it. both
    // the import & the constructor run before any teardown, so a failure here can't leave you with
    // no connection at all — the old one is still live until the swap below
    const dbConfig = config.db;
    const nextDriver: DatabaseDriver =
      dbConfig.mode === 'local'
        ? await this.buildDriver('better-sqlite3', 'local', async () => {
            const { SqliteDriver } = await import('./drivers/sqlite-drizzle.js');
            return new SqliteDriver(dbConfig);
          })
        : await this.buildDriver('pg', 'cloud', async () => {
            const { PostgresDriver } = await import('./drivers/postgres-drizzle.js');
            return new PostgresDriver(dbConfig);
          });

    if (this.driver) {
      console.warn(
        '[sql-switch] already connected — flushing & closing the previous engine before' +
          ' reconnecting. call close() first to do this deliberately',
      );
      await this.close();
    }

    this.driver = nextDriver;

    // disabled => every write goes straight to the driver
    this.collector = collectorConfig.enabled
      ? new WriteCollector(this.driver, collectorConfig)
      : null;

    this.config = config;
  }

  /**
   * Build a driver (import its module on demand, then construct it), turning a missing optional peer
   * dep into a friendly {@link ConfigurationError} that names the package & how to install it.
   *
   * @remarks
   * The `build` thunk covers both the dynamic `import()` and the `new Driver(...)` => a peer dep can
   * go missing at either point (the module `import`s it at the top, or a driver could `require` it
   * lazily in its constructor), so both live inside the one `try`. Any failure that *isn't* a
   * module-not-found for this exact package is rethrown untouched => a transitive dep going missing,
   * a syntax error, or a bad `busyTimeout` keeps its own real error rather than a wrong "install
   * `pg`" message.
   */
  private async buildDriver(
    pkg: string,
    mode: 'local' | 'cloud',
    build: () => Promise<DatabaseDriver>,
  ): Promise<DatabaseDriver> {
    try {
      return await build();
    } catch (err) {
      if (isMissingPackage(err, pkg)) {
        throw new ConfigurationError(
          `the "${pkg}" package is required for ${mode} mode but isn't installed => it's an ` +
            `optional peer dependency, add it with your package manager (e.g. \`npm install ${pkg}\`)`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  /**
   * Start a fluent chain on the given schema.
   *
   * Maps to `./data/databases/<name>.db` in local mode, or the Postgres logical schema
   * `<name>` in cloud mode.
   *
   * @param name - Schema name. Must match `^[a-zA-Z0-9_-]+$`.
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
   * Closing first is also what lets an upward swap clean up the local files => a directory a DAL in
   * this process still has open counts as un quiesced and is never deleted from, because a write
   * sitting in its collector buffer is invisible to a migration reading the file.
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
