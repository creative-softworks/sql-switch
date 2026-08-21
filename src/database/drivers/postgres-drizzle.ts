/**
 * @packageDocumentation
 * PostgreSQL driver — implements {@link DatabaseDriver} using node-postgres (pg) + drizzle-orm.
 *
 * All schemas share a single `pg.Pool`. Schema/table isolation is handled at the SQL level
 * via Postgres logical schemas (e.g. `antinuke.settings`).
 *
 * @remarks
 * **PgBouncer compatibility**: drizzle-orm/node-postgres uses simple/unnamed queries by
 * default, which is exactly what PgBouncer transaction mode requires. Named prepared
 * statements corrupt PgBouncer pools — never call `pool.prepare()` here.
 *
 * Pool `max` defaults to 5 — keep it low when running behind PgBouncer in transaction
 * mode (PgBouncer does the real multiplexing; your local pool should stay small).
 *
 * JSONB columns are returned already parsed by the pg driver, so no `JSON.parse()` needed
 * on reads — unlike the SQLite driver which stores TEXT.
 *
 * **Wedge protection**: every op is bounded (a query that never answers would otherwise hold one of
 * the `max` slots forever — 5 of those and the driver stops answering at all), retried a bounded
 * number of times on transient errors, and allowed to notice that a table it cached as "created" is
 * gone. See {@link poolOptions}, {@link withretry} and {@link PostgresDriver.forget}.
 */

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { buildPgTable } from '../schema.js';
import { ConfigurationError } from '../errors.js';
import type { DatabaseDriver, PostgresConfig, ScanOptions, StoredEntry } from '../types.js';

const { Pool } = pg;

/**
 * Default ceiling on a single operation, in milliseconds.
 *
 * @remarks
 * A flat key lookup or upsert is a couple of ms on a healthy database, so 30s isn't a performance
 * budget => it's the line past which the query is not coming back & the pool slot is worth more
 * than the answer. Override with `pool.statementTimeout`, `0` turns it off.
 */
export const STATEMENT_TIMEOUT = 30_000;

/**
 * How far behind the server side cancel the client side timer sits, in milliseconds.
 *
 * @remarks
 * Two ceilings, on purpose: the server cancels a statement that's merely slow (clean `57014`, the
 * connection survives), the client timer catches the case where no answer arrives at all because
 * the socket is gone. Giving the server a head start means the usual failure reports itself
 * properly instead of as a blind client side timeout.
 */
export const QUERY_GRACE = 2_000;

/** Total tries per op, first attempt included. @see {@link withretry} */
export const RETRY_ATTEMPTS = 3;

/** First backoff window in milliseconds, doubling per attempt up to {@link RETRY_CAP}. */
export const RETRY_BASE = 50;

/** Longest backoff window in milliseconds. */
export const RETRY_CAP = 500;

/**
 * Errors worth another attempt => connection level failures & the two "start over" verdicts.
 *
 * @remarks
 * Codes are either a node `errno` (socket died before Postgres saw anything) or a sqlstate. Class
 * `08` is connection exception, `57Pxx` is the server shutting the session down on its own terms
 * (restart, failover, an idle reaper), `40001`/`40P01` are serialization failure & deadlock, which
 * Postgres and CockroachDB both expect the client to retry.
 *
 * Deliberately absent: `57014` (that's our own statement timeout — retrying turns one hung query
 * into three), unique violations, auth failures & `42P01`, which is real but needs the table cache
 * fixed rather than a blind retry.
 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '57P01',
  '57P02',
  '57P03',
  '40001',
  '40P01',
]);

/**
 * Message fragments that mean the same thing as a transient code.
 *
 * @remarks
 * well, pg reports a socket that dies mid query as a plain `Error` with no `code` at all, so the
 * wording is the only thing left to match on. fragile by nature (it's library phrasing, not a
 * protocol contract) => it can only ever widen the retry set, it never decides that something with
 * a real sqlstate is retryable.
 */
const TRANSIENT_MESSAGES = ['Connection terminated', 'not queryable', 'socket hang up'];

/** sqlstates for "the thing you named isn't there" => undefined_table & invalid_schema_name */
const MISSING_CODES = new Set(['42P01', '3F000']);

/** whatever came back may not be an Error at all => only a string `code` counts */
function errcode(err: unknown): string | undefined {
  // drizzle 0.45+ wraps a driver error in DrizzleQueryError & hangs the real pg error off `.cause`,
  // so the sqlstate we need (42P01, 40001, 08006, …) is a hop or two down, not on the top object.
  // walk the cause chain (bounded, a self-referential cause shouldn't spin) & take the first code.
  for (
    let cur: unknown = err, hops = 0;
    typeof cur === 'object' && cur !== null && hops < 8;
    hops++
  ) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** every message down the `.cause` chain, joined => the transient hint may be on the wrapped error */
function errmessages(err: unknown): string {
  const parts: string[] = [];
  for (let cur: unknown = err, hops = 0; cur != null && hops < 8; hops++) {
    if (cur instanceof Error && cur.message) parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/**
 * Is this error worth another attempt?
 *
 * @remarks
 * Safe to act on because every op this driver runs is idempotent (upsert, delete, or a read), so
 * repeating one can't double anything up. See {@link TRANSIENT_CODES} for what's in & what isn't.
 * @internal
 */
export function isTransient(err: unknown): boolean {
  const code = errcode(err);
  if (code !== undefined) return TRANSIENT_CODES.has(code);

  const message = errmessages(err);
  return TRANSIENT_MESSAGES.some((hint) => message.includes(hint));
}

/**
 * Did the schema or table vanish out from under us?
 *
 * @remarks
 * Means the driver's `ready` cache is lying, not that the caller did anything wrong => the fix is
 * to forget the cache entry & run the `CREATE ... IF NOT EXISTS` again.
 * @internal
 */
export function isMissingRelation(err: unknown): boolean {
  const code = errcode(err);
  return code !== undefined && MISSING_CODES.has(code);
}

/**
 * Full jitter backoff => a uniform pick from a doubling window, `0` included.
 *
 * @param attempt - 0 for the wait after the first failure.
 * @param random - Injectable for tests. Defaults to `Math.random`.
 *
 * @remarks
 * Full jitter rather than a fixed delay because every process in a fleet sees the same blip at the
 * same moment => equal waits mean they all come back together and blip it again. The window is
 * capped at {@link RETRY_CAP} so the added latency stays small either way.
 * @internal
 */
export function retrydelay(attempt: number, random: () => number = Math.random): number {
  const window = Math.min(RETRY_BASE * 2 ** attempt, RETRY_CAP);
  return Math.floor(random() * window);
}

/** plain wait, only ever used between retries => nothing depends on it being precise */
function nap(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Knobs for {@link withretry}, all of them there so tests don't need a clock or real dice. */
export interface RetryOptions {
  /** Total tries, first attempt included. @defaultValue {@link RETRY_ATTEMPTS} */
  attempts?: number;
  /** Wait between attempts. @defaultValue a real `setTimeout` */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source. @defaultValue `Math.random` */
  random?: () => number;
}

/**
 * Run `op`, retrying transient failures a bounded number of times with jittered backoff.
 *
 * @remarks
 * This is for the blip in front of an outage, not the outage: a reset or a failover costs one
 * round trip and the read succeeds, where before it failed outright. A database that's actually
 * down still fails fast (3 tries, at most {@link RETRY_CAP} ms of waiting between them) and the
 * collector's circuit breaker takes it from there.
 * @internal
 */
export async function withretry<T>(op: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  const sleep = options.sleep ?? nap;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      // last attempt, or nothing about it suggests a second one would go differently
      if (attempt >= attempts - 1 || !isTransient(err)) throw err;
      await sleep(retrydelay(attempt, random));
    }
  }
}

/**
 * Build the `pg.Pool` config for a {@link PostgresConfig}.
 *
 * @throws {@link ConfigurationError} if `pool.statementTimeout` isn't a whole number of ms >= 0.
 *
 * @remarks
 * Only `query_timeout` (client side) goes on the pool. Postgres' own `statement_timeout` would
 * have to travel as a startup parameter, and PgBouncer drops any connection that carries a startup
 * parameter it doesn't track => that would break the deployment this driver is written for. The
 * server side cap is applied per transaction instead, with `SET LOCAL` inside the flush, which is
 * transaction scoped & safe through any pooler.
 * @internal
 */
export function poolOptions(config: PostgresConfig): pg.PoolConfig {
  const timeout = config.pool?.statementTimeout ?? STATEMENT_TIMEOUT;
  if (!Number.isInteger(timeout) || timeout < 0) {
    throw new ConfigurationError(
      `pool.statementTimeout must be a whole number of milliseconds >= 0 (0 disables it), got ${timeout}`,
    );
  }

  return {
    connectionString: config.connectionString,
    // keep low — PgBouncer handles the real multiplexing
    max: config.pool?.max ?? 5,
    // bound the wait for a connection => an unreachable server shouldn't hang a caller forever
    connectionTimeoutMillis: config.pool?.connectionTimeoutMillis ?? 10_000,
    // close idle connections to avoid leaking resources
    idleTimeoutMillis: config.pool?.idleTimeoutMillis ?? 30_000,
    ...(timeout > 0 ? { query_timeout: timeout + QUERY_GRACE } : {}),
  };
}

/**
 * Rows per statement on a bulk flush.
 *
 * @remarks
 * Same number `engine-swap.ts` chunks its migration with. Two bound parameters per row means a
 * chunk costs 1000 of Postgres' 65535 parameter limit, so even a full 5000 key flush is 10
 * statements & never near the cap.
 */
export const UPSERT_CHUNK = 500;

/**
 * Rows pulled per round trip on a scan.
 *
 * @remarks
 * A scan can't hold a server cursor open across `await yield` without pinning a pool connection for
 * the whole (caller-paced) iteration, so it keyset-paginates instead => `WHERE id > $last ORDER BY
 * id LIMIT n`, one bound page at a time, exactly how the downward engine swap reads. Peak memory is
 * one page, and each page borrows & returns its connection like any other query.
 */
export const SCAN_CHUNK = 500;

/**
 * Split a flush group into chunks => one statement per chunk instead of one per key.
 *
 * @param writes - The flush group, in insertion order.
 * @param size - Rows per chunk. Defaults to {@link UPSERT_CHUNK}.
 * @internal
 */
export function* upsertChunks<T>(
  writes: Map<string, T>,
  size = UPSERT_CHUNK,
): Generator<Array<[string, T]>> {
  let chunk: Array<[string, T]> = [];

  for (const entry of writes) {
    chunk.push(entry);
    if (chunk.length === size) {
      yield chunk;
      chunk = [];
    }
  }

  if (chunk.length > 0) yield chunk;
}

/**
 * Build the multi-row upsert for one chunk => `INSERT ... VALUES (..),(..) ON CONFLICT DO UPDATE`.
 *
 * Ids & values are bound parameters, never interpolated. Schema & table names are quoted the same
 * way the rest of this driver quotes them (they're validated on the way in through `TableContext`).
 *
 * @param schema - Postgres logical schema.
 * @param table - Table within it.
 * @param chunk - Up to {@link UPSERT_CHUNK} key/value pairs.
 * @internal
 */
export function buildBulkUpsert(
  schema: string,
  table: string,
  chunk: Array<[string, unknown]>,
): { text: string; params: unknown[] } {
  const values: string[] = [];
  const params: unknown[] = [];

  chunk.forEach(([key, value], n) => {
    values.push(`($${n * 2 + 1}, $${n * 2 + 2}::jsonb)`);
    params.push(key);
    // JSONB wants json text & pg would stringify an object for us anyway => be explicit about it
    params.push(JSON.stringify(value));
  });

  return {
    text:
      `INSERT INTO "${schema}"."${table}" (id, value) VALUES ${values.join(', ')}` +
      ` ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
    params,
  };
}

export class PostgresDriver implements DatabaseDriver {
  private pool: pg.Pool;
  private db: ReturnType<typeof drizzle>;
  // tracks which schema:table pairs have had CREATE SCHEMA/TABLE IF NOT EXISTS run
  private ready = new Set<string>();
  // in-flight ensure calls, keyed the same way => concurrent callers share one round trip
  private ensuring = new Map<string, Promise<void>>();
  // schemas that already had CREATE SCHEMA run (separate from tables, one per schema)
  private schemasReady = new Map<string, Promise<void>>();
  // server side ceiling per transaction, ms. 0 => the caller turned it off
  private statementTimeout: number;

  constructor(config: PostgresConfig) {
    // validates too => a nonsense timeout throws here rather than on the first query
    this.pool = new Pool(poolOptions(config));
    this.statementTimeout = config.pool?.statementTimeout ?? STATEMENT_TIMEOUT;

    // pg emits this on idle clients (server restart, network drop). without a listener node
    // treats it as an unhandled 'error' event & kills the process => the whole point of the
    // circuit breaker is to survive an outage, so swallow it & let the next query reconnect
    this.pool.on('error', (err) => {
      console.error('[sql-switch] idle postgres client error:', err);
    });

    this.db = drizzle(this.pool);
  }

  // CREATE SCHEMA + TABLE on first touch, cached so subsequent calls are free
  private async ensureTable(schema: string, table: string): Promise<void> {
    const key = `${schema}:${table}`;
    if (this.ready.has(key)) return;

    // collector flushes fire groups in parallel => without this, two tables in the same
    // schema race on CREATE SCHEMA IF NOT EXISTS and postgres throws a pg_namespace
    // unique violation (it isn't actually atomic)
    const inflight = this.ensuring.get(key);
    if (inflight) return inflight;

    const run = (async () => {
      // raw pool.query here — drizzle doesn't have CREATE SCHEMA in its query builder
      let schemaRun = this.schemasReady.get(schema);
      if (!schemaRun) {
        // IF NOT EXISTS => idempotent, so a retry after a reset just no-ops
        schemaRun = withretry(() =>
          this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`),
        ).then(() => undefined);
        this.schemasReady.set(schema, schemaRun);
      }

      try {
        await schemaRun;
      } catch (err) {
        // failed attempts must not stay cached, the next call should retry
        this.schemasReady.delete(schema);
        throw err;
      }

      await withretry(() =>
        this.pool.query(`
          CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (
            id   TEXT  PRIMARY KEY,
            value JSONB NOT NULL
          )
        `),
      );

      this.ready.add(key);
    })();

    this.ensuring.set(key, run);
    try {
      await run;
    } finally {
      this.ensuring.delete(key);
    }
  }

  /**
   * Drop every cached "already created" flag for a schema.
   *
   * @remarks
   * The caches are an optimization, not a source of truth: a schema can be dropped by a migration,
   * a restored snapshot or a failover to a host that never had it. When an op says the relation
   * isn't there, the flags are wrong & the whole schema goes, not just the one table => the other
   * tables in it are just as gone.
   */
  private forget(schema: string): void {
    this.schemasReady.delete(schema);
    for (const key of this.ready) {
      if (key.startsWith(`${schema}:`)) this.ready.delete(key);
    }
  }

  /**
   * Ensure the table exists, then run `op` with retries & one cache-repair attempt.
   *
   * @remarks
   * Two different failures, two different answers: a transient one gets another go right away
   * ({@link withretry}), a missing relation means the cache lied => forget it, recreate, run once
   * more. Both are only safe because every op here is a read, an upsert or a delete.
   */
  private async run<T>(schema: string, table: string, op: () => Promise<T>): Promise<T> {
    try {
      await this.ensureTable(schema, table);
      return await withretry(op);
    } catch (err) {
      if (!isMissingRelation(err)) throw err;

      this.forget(schema);
      await this.ensureTable(schema, table);
      return await withretry(op);
    }
  }

  /** @inheritdoc */
  async get(schema: string, table: string, key: string): Promise<unknown> {
    const tbl = buildPgTable(schema, table);

    const rows = await this.run(schema, table, () =>
      this.db.select().from(tbl).where(eq(tbl.id, key)).limit(1),
    );

    const row = rows[0];
    if (!row) return null;
    // JSONB is already a parsed JS object from the pg driver — no JSON.parse needed
    return row.value;
  }

  /**
   * Does a row exist for this key?
   *
   * @remarks
   * `SELECT 1 ... LIMIT 1` => existence only, never pulls the JSONB back, so a row storing a literal
   * `null` still reports as existing (which `get()` can't distinguish, hence a dedicated check). Key
   * is bound, never spliced in (S6).
   *
   * @inheritdoc
   */
  async exists(schema: string, table: string, key: string): Promise<boolean> {
    return this.run(schema, table, async () => {
      const res = await this.pool.query(
        `SELECT 1 FROM "${schema}"."${table}" WHERE id = $1 LIMIT 1`,
        [key],
      );
      return res.rows.length > 0;
    });
  }

  /** @inheritdoc */
  async set(schema: string, table: string, key: string, value: unknown): Promise<void> {
    const tbl = buildPgTable(schema, table);

    await this.run(schema, table, async () => {
      await this.db
        .insert(tbl)
        .values({ id: key, value })
        .onConflictDoUpdate({ target: tbl.id, set: { value } });
    });
  }

  /**
   * Upsert a batch of key→value pairs inside a single transaction.
   * Called by the collector flush.
   *
   * @remarks
   * One multi-row `INSERT ... ON CONFLICT DO UPDATE` per {@link UPSERT_CHUNK} keys, which is what
   * `engine-swap.ts` already did for migrations. A loop of single row inserts costs one round trip
   * per key => a 5000 key flush went from 5000 round trips to 10, and that ratio is what decides
   * whether Postgres keeps up at high write rates. Peak memory is one chunk of parameters.
   *
   * The whole group is still one transaction (chunks are statements, not transactions), so a failure
   * anywhere rolls the group back & the collector retries it intact.
   *
   * `SET LOCAL statement_timeout` puts the server side ceiling on it: this is the one op that can
   * genuinely block (a lock, a busy server), and a flush that never returns holds a pool slot for
   * the rest of the process' life. Transaction scoped, so it can't leak onto a pooled connection.
   *
   * @inheritdoc
   */
  async batchSet(schema: string, table: string, writes: Map<string, unknown>): Promise<void> {
    await this.run(schema, table, () => this.flushtx(schema, table, writes));
  }

  /** one transaction for a whole flush group => pulled out so `run()` can retry it as a unit */
  private async flushtx(
    schema: string,
    table: string,
    writes: Map<string, unknown>,
  ): Promise<void> {
    // a dedicated client so BEGIN/COMMIT can't land on different pooled connections
    const client = await this.pool.connect();
    let failure: Error | undefined;

    try {
      await client.query('BEGIN');
      // interpolated because SET takes no bound parameters => it's a validated integer, never
      // caller text (see poolOptions)
      if (this.statementTimeout > 0) {
        await client.query(`SET LOCAL statement_timeout = ${this.statementTimeout}`);
      }

      for (const chunk of upsertChunks(writes)) {
        const { text, params } = buildBulkUpsert(schema, table, chunk);
        await client.query(text, params);
      }

      await client.query('COMMIT');
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      // best effort rollback => the connection may already be dead
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      // hand a failed client back as broken => pg destroys it instead of returning a connection
      // that may still be mid statement (a client side timeout doesn't stop the server)
      client.release(failure);
    }
  }

  /** @inheritdoc */
  async delete(schema: string, table: string, key: string): Promise<void> {
    const tbl = buildPgTable(schema, table);

    await this.run(schema, table, async () => {
      await this.db.delete(tbl).where(eq(tbl.id, key));
    });
  }

  /**
   * Stream every row in id order, keyset-paginating a page at a time.
   *
   * @remarks
   * Each page runs through {@link PostgresDriver.run} like any other op => retries transient blips
   * and repairs a stale table cache, and borrows a pool connection only for the page's own round
   * trip, never for the whole iteration. Peak memory is one {@link SCAN_CHUNK} page (SC2).
   *
   * The prefix is bound as a parameter (S6), matched with `substr(id, 1, $n) = $n` so it's case
   * sensitive & literal => `%`/`_` in a prefix match themselves, they're not `LIKE` wildcards.
   *
   * @inheritdoc
   */
  async *scan(schema: string, table: string, opts?: ScanOptions): AsyncIterable<StoredEntry> {
    const prefix = opts?.prefix;
    let after: string | null = null;

    for (;;) {
      const rows = await this.run(schema, table, () => this.scanPage(schema, table, prefix, after));
      if (rows.length === 0) break;

      for (const row of rows) yield row;

      // a short page is the last page => no need for one more round trip to see zero rows
      if (rows.length < SCAN_CHUNK) break;
      after = rows[rows.length - 1]!.id;
    }
  }

  /** one keyset page => rows with `id` past `after`, ascending, optionally prefix filtered */
  private async scanPage(
    schema: string,
    table: string,
    prefix: string | undefined,
    after: string | null,
  ): Promise<StoredEntry[]> {
    const params: unknown[] = [];
    const where: string[] = [];

    if (prefix !== undefined && prefix.length > 0) {
      params.push([...prefix].length);
      const lenParam = params.length;
      params.push(prefix);
      where.push(`substr(id, 1, $${lenParam}) = $${params.length}`);
    }
    if (after !== null) {
      params.push(after);
      where.push(`id > $${params.length}`);
    }
    params.push(SCAN_CHUNK);
    const limitParam = params.length;

    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const res = await this.pool.query(
      `SELECT id, value FROM "${schema}"."${table}"${clause} ORDER BY id LIMIT $${limitParam}`,
      params,
    );

    // JSONB comes back already parsed from the pg driver, same as get()
    return res.rows.map((row) => ({ id: row.id as string, value: row.value }));
  }

  /** @inheritdoc */
  async count(schema: string, table: string, opts?: ScanOptions): Promise<number> {
    const prefix = opts?.prefix;

    return this.run(schema, table, async () => {
      const params: unknown[] = [];
      let clause = '';
      if (prefix !== undefined && prefix.length > 0) {
        params.push([...prefix].length, prefix);
        clause = ' WHERE substr(id, 1, $1) = $2';
      }

      const res = await this.pool.query(
        `SELECT count(*) AS n FROM "${schema}"."${table}"${clause}`,
        params,
      );
      // count(*) is bigint => pg hands it back as a string, Number() is exact below 2^53
      return Number((res.rows[0] as { n: string } | undefined)?.n ?? 0);
    });
  }

  /** End the connection pool gracefully. */
  async close(): Promise<void> {
    await this.pool.end();
    this.ready.clear();
    this.ensuring.clear();
    this.schemasReady.clear();
  }
}
