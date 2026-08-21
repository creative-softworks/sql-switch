/**
 * @packageDocumentation
 * NEW-2 + NEW-7 => the Postgres CRUD path (get/set/delete) has to agree with the scans on the exact
 * bytes of a value.
 *
 * NEW-2: get() used to read through drizzle's `jsonb` column, which ran a SECOND JSON.parse on top of
 * pg's own parse. a stored string that looks like a number (a snowflake id) came back as a precision
 * lost number, and get() disagreed with entries()/the scans (raw pool, correct) for the same row.
 * NEW-7: set(null) through drizzle mapped a JS null onto a SQL NULL, which the NOT NULL `value` column
 * rejects => set(null) behaved differently depending on the path. get/set now bind `$n::jsonb` the
 * same single way the scans & the bulk upsert always did, so a value round trips identically.
 *
 * only runs with DATABASE_URL set (own throwaway `swaptest-json-*` schema per test, dropped after).
 */

import pg from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';
import { PostgresDriver } from '../src/database/drivers/postgres-drizzle.js';

const url = process.env.DATABASE_URL;

/** driver + a raw pool for cleanup, both torn down (& the schema dropped) when the test finishes */
function setup(schema: string): { driver: PostgresDriver; pool: pg.Pool } {
  const driver = new PostgresDriver({ mode: 'cloud', connectionString: url! });
  const pool = new pg.Pool({ connectionString: url! });
  onTestFinished(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await pool.end();
    await driver.close();
  });
  return { driver, pool };
}

/** drain a driver scan into a Map<id, value> => the "always correct" raw pool read to compare against */
async function scanned(
  driver: PostgresDriver,
  schema: string,
  table: string,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for await (const row of driver.scan(schema, table)) out.set(row.id, row.value);
  return out;
}

describe.skipIf(!url)('postgres value round trip against a real database', () => {
  it('a JSON-looking string stays a string & get() agrees with the scan (NEW-2)', async () => {
    const schema = 'swaptest-json-string';
    const { driver } = setup(schema);

    // the classic offender => a discord snowflake. a second JSON.parse turns "…678" into a number
    // that's lost its last digits, so get() would neither match the input nor what the scan returns
    const snowflake = '123456789012345678';
    await driver.set(schema, 'vals', 'flake', snowflake);

    const viaGet = await driver.get(schema, 'vals', 'flake');
    expect(viaGet).toBe(snowflake);
    expect(typeof viaGet).toBe('string');

    // entries()/scan is raw pool & was always right => get() has to return the identical value
    const rows = await scanned(driver, schema, 'vals');
    expect(rows.get('flake')).toBe(snowflake);
    expect(rows.get('flake')).toStrictEqual(viaGet);
  });

  it('get() agrees with the batch-written scan for nested JSON-looking payloads (NEW-2)', async () => {
    const schema = 'swaptest-json-batch';
    const { driver } = setup(schema);

    // batchSet is the flush path (raw multi row upsert) => a leading-zero string & nested numeric
    // strings must survive both the write and every read shape
    await driver.batchSet(
      schema,
      'vals',
      new Map<string, unknown>([
        ['zero', '007'],
        ['nested', { id: '123456789012345678', ids: ['456789012345678901'] }],
      ]),
    );

    expect(await driver.get(schema, 'vals', 'zero')).toBe('007');
    expect(await driver.get(schema, 'vals', 'nested')).toStrictEqual({
      id: '123456789012345678',
      ids: ['456789012345678901'],
    });

    const rows = await scanned(driver, schema, 'vals');
    expect(rows.get('zero')).toStrictEqual(await driver.get(schema, 'vals', 'zero'));
    expect(rows.get('nested')).toStrictEqual(await driver.get(schema, 'vals', 'nested'));
  });

  it('set(null) & batchSet(null) both store a jsonb null, and exists() still sees the row (NEW-7)', async () => {
    const schema = 'swaptest-json-null';
    const { driver } = setup(schema);

    // set() is the .force() path, batchSet() is the buffered flush path => a NULL vs jsonb-null
    // mismatch used to make one of them blow up on the NOT NULL column while the other stored a row
    await driver.set(schema, 'vals', 'forced', null);
    await driver.batchSet(schema, 'vals', new Map<string, unknown>([['buffered', null]]));

    // get() can't tell a stored null from a missing key => both read as null
    expect(await driver.get(schema, 'vals', 'forced')).toBeNull();
    expect(await driver.get(schema, 'vals', 'buffered')).toBeNull();
    // …but the rows are really there, so exists()/has() must say so on both paths
    expect(await driver.exists(schema, 'vals', 'forced')).toBe(true);
    expect(await driver.exists(schema, 'vals', 'buffered')).toBe(true);
    // and a key that was never written stays absent => null value ≠ no row
    expect(await driver.exists(schema, 'vals', 'never')).toBe(false);
  });
});
