/**
 * @packageDocumentation
 * M2 + M3 => what a full 5000 key flush costs the process it runs in.
 *
 * SQLite (M2): better-sqlite3 is synchronous, so the whole group used to go through one sync
 * transaction => a periodic stall on the loop thread right when the app is busiest. Chunked with a
 * yield in between, the loop keeps turning.
 *
 * Postgres (M3): one `INSERT ... ON CONFLICT` per key inside a transaction is N round trips per
 * flush group, the exact anti-pattern the brief calls out. `engine-swap.ts` already did it right
 * (one multi-row upsert per chunk), so the driver now does too => the chunk count is the round trip
 * count. The real database half only runs with `DATABASE_URL` set, everything else always runs.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';
import { SqliteDriver } from '../src/database/drivers/sqlite-drizzle.js';
import {
  PostgresDriver,
  UPSERT_CHUNK,
  buildBulkUpsert,
  upsertChunks,
} from '../src/database/drivers/postgres-drizzle.js';
import { tempdir } from './helpers/tempdal.js';
import { MAX_BUFFER } from '../src/database/utils/collector.js';

/** a flush group of `n` keys, values big enough that serializing them isn't free */
function bulkwrites(n: number): Map<string, unknown> {
  const writes = new Map<string, unknown>();
  for (let i = 0; i < n; i++) writes.set(`key-${i}`, { i, pad: 'x'.repeat(64) });
  return writes;
}

/**
 * Count how many turns the event loop got while `work` ran.
 *
 * A self rescheduling `setImmediate` can only tick when the loop is free, so this stays 0 for the
 * whole duration of a synchronous block & climbs once the work starts yielding. No timing involved
 * => nothing to flake on a slow box.
 */
async function tickswhile<T>(work: () => Promise<T>): Promise<{ result: T; ticks: number }> {
  let ticks = 0;
  let running = true;
  const beat = (): void => {
    if (!running) return;
    ticks++;
    setImmediate(beat);
  };
  setImmediate(beat);

  try {
    const result = await work();
    return { result, ticks };
  } finally {
    running = false;
  }
}

describe('sqlite bulk flush', () => {
  it(`writes a full ${MAX_BUFFER} key flush without holding the event loop`, async () => {
    const dir = tempdir();
    const driver = new SqliteDriver({ mode: 'local', dataDir: dir });
    onTestFinished(async () => {
      await driver.close();
    });

    const writes = bulkwrites(MAX_BUFFER);
    const { ticks } = await tickswhile(() => driver.batchSet('bulk', 'rows', writes));

    // one sync transaction for the whole group => the loop never gets a turn & this is 0
    expect(ticks).toBeGreaterThan(1);

    const raw = new Database(path.join(dir, 'bulk.db'), { readonly: true });
    try {
      const counted = raw.prepare('SELECT count(*) AS n FROM "rows"').get() as { n: number | bigint };
      expect(Number(counted.n)).toBe(MAX_BUFFER);
    } finally {
      raw.close();
    }

    expect(await driver.get('bulk', 'rows', 'key-0')).toEqual({ i: 0, pad: 'x'.repeat(64) });
    expect(await driver.get('bulk', 'rows', `key-${MAX_BUFFER - 1}`)).toEqual({
      i: MAX_BUFFER - 1,
      pad: 'x'.repeat(64),
    });
  });

  it('keeps chunk boundaries idempotent => a rewritten group just overwrites', async () => {
    const dir = tempdir();
    const driver = new SqliteDriver({ mode: 'local', dataDir: dir });
    onTestFinished(async () => {
      await driver.close();
    });

    // the collector requeues a whole failed group, so a chunk that already landed gets rewritten
    await driver.batchSet('bulk', 'rows', bulkwrites(1_200));
    await driver.batchSet(
      'bulk',
      'rows',
      new Map([
        ['key-0', { i: 0, pad: 'updated' }],
        ['key-1199', { i: 1199, pad: 'updated' }],
      ]),
    );

    expect(await driver.get('bulk', 'rows', 'key-0')).toEqual({ i: 0, pad: 'updated' });
    expect(await driver.get('bulk', 'rows', 'key-1199')).toEqual({ i: 1199, pad: 'updated' });
    expect(await driver.get('bulk', 'rows', 'key-600')).toEqual({ i: 600, pad: 'x'.repeat(64) });
  });
});

describe('postgres bulk upsert', () => {
  it('turns a flush group into one statement per chunk', () => {
    const sizes = [...upsertChunks(bulkwrites(1_200))].map((chunk) => chunk.length);

    // 3 round trips for 1200 keys, where the old loop took 1200
    expect(sizes).toEqual([UPSERT_CHUNK, UPSERT_CHUNK, 1_200 - 2 * UPSERT_CHUNK]);
  });

  it('stays under the parameter cap on a full flush', () => {
    // postgres refuses more than 65535 bound parameters per statement & we bind 2 per row
    expect(UPSERT_CHUNK * 2).toBeLessThan(65_535);

    const chunks = [...upsertChunks(bulkwrites(MAX_BUFFER))];
    expect(chunks).toHaveLength(Math.ceil(MAX_BUFFER / UPSERT_CHUNK));
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(UPSERT_CHUNK);
  });

  it('builds one multi row upsert, values passed as parameters', () => {
    const { text, params } = buildBulkUpsert('economy', 'balances', [
      ['user-1', { coins: 1 }],
      ['user-2', { coins: 2 }],
    ]);

    expect(text).toContain(
      'INSERT INTO "economy"."balances" (id, value) VALUES ($1, $2::jsonb), ($3, $4::jsonb)',
    );
    expect(text).toContain('ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value');
    expect(params).toEqual(['user-1', '{"coins":1}', 'user-2', '{"coins":2}']);
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('postgres bulk flush against a real database', () => {
  it('lands a 1200 key flush & upserts a rewritten chunk', async () => {
    const driver = new PostgresDriver({ mode: 'cloud', connectionString: url! });
    const pool = new pg.Pool({ connectionString: url! });
    // own throwaway schema, dropped below => never touches anything the database already had, and
    // can't race the `swaptest` schema the swap test creates & drops
    const schema = 'swaptest-bulk';
    onTestFinished(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await pool.end();
      await driver.close();
    });

    await driver.batchSet(schema, 'bulk', bulkwrites(1_200));

    const counted = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM "${schema}"."bulk"`,
    );
    expect(Number(counted.rows[0]?.n)).toBe(1_200);
    expect(await driver.get(schema, 'bulk', 'key-0')).toEqual({ i: 0, pad: 'x'.repeat(64) });
    expect(await driver.get(schema, 'bulk', 'key-1199')).toEqual({
      i: 1199,
      pad: 'x'.repeat(64),
    });

    // requeued group => the same keys come round again with newer values
    await driver.batchSet(schema, 'bulk', new Map([['key-0', { i: 0, pad: 'updated' }]]));
    expect(await driver.get(schema, 'bulk', 'key-0')).toEqual({ i: 0, pad: 'updated' });
    const after = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM "${schema}"."bulk"`);
    expect(Number(after.rows[0]?.n)).toBe(1_200);
  });
});
