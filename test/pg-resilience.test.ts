/**
 * @packageDocumentation
 * D1 + D3 + D4 => the three ways a Postgres connection wedges a process that isn't watching for it.
 *
 * D1: `connectionTimeoutMillis` only bounds *acquiring* a connection. A query that never answers
 * holds one of the 5 pool slots forever, so 5 of them block every later op with no error at all.
 * D3: a single reset used to fail a read outright. The collector's breaker covers a sustained
 * outage, this covers the blip in front of it => bounded attempts, full jitter, idempotent ops only.
 * D4: `ready` cached "this table exists" & never let go, so a table dropped out of band failed
 * forever. `schemasReady` already dropped failed entries, now the table cache does too.
 *
 * The classifiers, the retry loop & the pool options are plain functions => they run everywhere.
 * The two behaviours you can only see against a real server run with `DATABASE_URL` set.
 */

import pg from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  PostgresDriver,
  QUERY_GRACE,
  RETRY_ATTEMPTS,
  RETRY_BASE,
  RETRY_CAP,
  STATEMENT_TIMEOUT,
  isMissingRelation,
  isTransient,
  poolOptions,
  retrydelay,
  withretry,
} from '../src/database/drivers/postgres-drizzle.js';
import { ConfigurationError } from '../src/database/errors.js';

/** a pg error as the driver sees it => `code` is all the classifiers get to work with */
function pgerror(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('transient error classification', () => {
  it('retries what a momentary blip actually arrives as', () => {
    // socket level
    expect(isTransient(pgerror('ECONNRESET'))).toBe(true);
    expect(isTransient(pgerror('EPIPE'))).toBe(true);
    // sqlstate class 08 => connection exception
    expect(isTransient(pgerror('08006'))).toBe(true);
    expect(isTransient(pgerror('08003'))).toBe(true);
    // the server going away on its own terms (failover, restart, idle reaper)
    expect(isTransient(pgerror('57P01'))).toBe(true);
    // cockroach & serializable transactions expect the client to come back
    expect(isTransient(pgerror('40001'))).toBe(true);
    expect(isTransient(pgerror('40P01'))).toBe(true);
    // pg reports a dropped socket mid-query with a message & no code at all
    expect(isTransient(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('leaves alone anything a second attempt would just fail again', () => {
    // our own statement timeout => retrying is how you turn one hung query into three
    expect(isTransient(pgerror('57014'))).toBe(false);
    expect(isTransient(pgerror('23505'))).toBe(false);
    expect(isTransient(pgerror('28P01'))).toBe(false);
    // a missing relation is real, it just needs the cache fixed first (D4) rather than a retry
    expect(isTransient(pgerror('42P01'))).toBe(false);
    expect(isTransient(new Error('syntax error'))).toBe(false);
    expect(isTransient(undefined)).toBe(false);
    expect(isTransient('ECONNRESET')).toBe(false);
  });

  it('spots a relation that went missing under it', () => {
    expect(isMissingRelation(pgerror('42P01'))).toBe(true);
    expect(isMissingRelation(pgerror('3F000'))).toBe(true);
    expect(isMissingRelation(pgerror('08006'))).toBe(false);
    expect(isMissingRelation(null)).toBe(false);
  });

  it('sees through a drizzle-wrapped error to the real sqlstate on `.cause`', () => {
    // drizzle 0.45+ throws a DrizzleQueryError with no `code` of its own & the real pg error on
    // `.cause` => classify on the top object alone and every retry & self-heal quietly stops working
    const wrap = (cause: unknown) => Object.assign(new Error('Failed query: ...'), { cause });

    expect(isMissingRelation(wrap(pgerror('42P01')))).toBe(true);
    expect(isTransient(wrap(pgerror('40001')))).toBe(true);
    // a hop deeper (wrapper -> wrapper -> pg error) still resolves
    expect(isMissingRelation(wrap(wrap(pgerror('3F000'))))).toBe(true);
    // message-only transients survive the wrap too (dropped socket, no code anywhere)
    expect(isTransient(wrap(new Error('Connection terminated unexpectedly')))).toBe(true);
    // and a wrapped non-transient is still left alone
    expect(isTransient(wrap(pgerror('23505')))).toBe(false);
  });
});

describe('bounded jittered retry', () => {
  /** run `withretry` with the clock & the dice under test control => nothing to flake on */
  function harness(op: () => Promise<unknown>): { naps: number[]; run: Promise<unknown> } {
    const naps: number[] = [];
    const run = withretry(op, {
      sleep: async (ms) => {
        naps.push(ms);
      },
      random: () => 1,
    });
    return { naps, run };
  }

  it('gives a transient failure another go', async () => {
    let calls = 0;
    const { naps, run } = harness(async () => {
      calls++;
      if (calls === 1) throw pgerror('08006');
      return 'ok';
    });

    expect(await run).toBe('ok');
    expect(calls).toBe(2);
    expect(naps).toHaveLength(1);
  });

  it('gives up at the attempt cap instead of hammering', async () => {
    let calls = 0;
    const { naps, run } = harness(async () => {
      calls++;
      throw pgerror('40001');
    });

    await expect(run).rejects.toThrow('40001');
    expect(calls).toBe(RETRY_ATTEMPTS);
    // one wait between attempts, none after the last => a bounded amount of added latency
    expect(naps).toHaveLength(RETRY_ATTEMPTS - 1);
  });

  it('does not retry an error that is not going to change', async () => {
    let calls = 0;
    const { run } = harness(async () => {
      calls++;
      throw pgerror('57014');
    });

    await expect(run).rejects.toThrow('57014');
    expect(calls).toBe(1);
  });

  it('backs off with full jitter, so a fleet does not resynchronize', () => {
    // full jitter => the whole window is in play, including 0. no fixed floor to pile up on
    expect(retrydelay(0, () => 0)).toBe(0);
    expect(retrydelay(3, () => 0)).toBe(0);

    // doubling window, and it stops doubling at the cap
    expect(retrydelay(0, () => 1)).toBe(RETRY_BASE);
    expect(retrydelay(1, () => 1)).toBe(RETRY_BASE * 2);
    expect(retrydelay(20, () => 1)).toBe(RETRY_CAP);
  });
});

describe('pool options', () => {
  const base = { mode: 'cloud', connectionString: 'postgres://u:p@localhost:5432/db' } as const;

  it('puts a client side ceiling on every query by default', () => {
    const options = poolOptions(base);

    expect(options.max).toBe(5);
    // the client side timer is the backstop for "no answer ever came", so it sits a grace period
    // behind the server side cancel => the server gets to report a clean 57014 first
    expect(options.query_timeout).toBe(STATEMENT_TIMEOUT + QUERY_GRACE);
    // never a startup parameter => PgBouncer rejects unknown ones & drops the connection
    expect(options.statement_timeout).toBeUndefined();
  });

  it('takes the numbers the caller asked for', () => {
    const options = poolOptions({ ...base, pool: { max: 12, statementTimeout: 5_000 } });

    expect(options.max).toBe(12);
    expect(options.query_timeout).toBe(5_000 + QUERY_GRACE);
  });

  it('lets a caller turn the ceiling off entirely', () => {
    const options = poolOptions({ ...base, pool: { statementTimeout: 0 } });

    expect('query_timeout' in options).toBe(false);
  });

  it('defaults the connection & idle timeouts, and honors overrides (D2)', () => {
    const defaults = poolOptions(base);
    expect(defaults.connectionTimeoutMillis).toBe(10_000);
    expect(defaults.idleTimeoutMillis).toBe(30_000);

    const tuned = poolOptions({
      ...base,
      pool: { connectionTimeoutMillis: 2_000, idleTimeoutMillis: 60_000 },
    });
    expect(tuned.connectionTimeoutMillis).toBe(2_000);
    expect(tuned.idleTimeoutMillis).toBe(60_000);
  });

  it('refuses a timeout that is not a whole number of milliseconds', () => {
    expect(() => poolOptions({ ...base, pool: { statementTimeout: -1 } })).toThrow(
      ConfigurationError,
    );
    expect(() => poolOptions({ ...base, pool: { statementTimeout: 1.5 } })).toThrow(
      ConfigurationError,
    );
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('postgres resilience against a real database', () => {
  it('rebuilds its table cache when the schema is dropped out of band', async () => {
    // own throwaway schema per test => can't race the other postgres test files vitest runs in
    // parallel, and cleanup can't take anything else with it
    const schema = 'swaptest-heal';
    const driver = new PostgresDriver({ mode: 'cloud', connectionString: url! });
    const pool = new pg.Pool({ connectionString: url! });
    onTestFinished(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await pool.end();
      await driver.close();
    });

    await driver.set(schema, 'settings', 'guild-1', { strict: true });
    expect(await driver.get(schema, 'settings', 'guild-1')).toEqual({ strict: true });

    // something else wiped it (a migration, a restored snapshot, a failover to a host that never
    // had it) => the driver's cache now claims a table that isn't there
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);

    await driver.set(schema, 'settings', 'guild-1', { strict: false });
    expect(await driver.get(schema, 'settings', 'guild-1')).toEqual({ strict: false });
  });

  it('cancels a flush that blocks on a lock & keeps the pool usable', async () => {
    const schema = 'swaptest-lock';
    const driver = new PostgresDriver({
      mode: 'cloud',
      connectionString: url!,
      pool: { statementTimeout: 400 },
    });
    const pool = new pg.Pool({ connectionString: url! });
    onTestFinished(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await pool.end();
      await driver.close();
    });

    // has to exist (& be cached) before anything can lock it, otherwise the DDL blocks instead
    await driver.set(schema, 'locked', 'a', { n: 1 });

    const blocker = await pool.connect();
    let failure: unknown;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`LOCK TABLE "${schema}"."locked" IN ACCESS EXCLUSIVE MODE`);

      // the flush can never get the lock => without a statement timeout this waits forever on a
      // pool slot. 5 of those and the driver is done answering anything
      failure = await driver
        .batchSet(schema, 'locked', new Map([['b', { n: 2 }]]))
        .then(() => null, (err: unknown) => err);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    // 57014 => the server cancelled it, not the client side backstop timing out blind
    expect((failure as { code?: string } | null)?.code).toBe('57014');

    // & the pool came out of it healthy => the client that died is gone, not handed back dirty
    await driver.set(schema, 'locked', 'c', { n: 3 });
    expect(await driver.get(schema, 'locked', 'c')).toEqual({ n: 3 });
  });
});
