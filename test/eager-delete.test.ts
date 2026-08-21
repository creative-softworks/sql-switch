/**
 * @packageDocumentation
 * C1 => a bare `delete()` (no await, no `.force()`) must still land.
 *
 * delete() used to only run its work inside the WriteOperation callbacks, so a fire and forget
 * `db...delete()` never executed => meanwhile a fire and forget `set()` (already eager) did, so the
 * two silently disagreed on the same key. these lock the eager behaviour in: the driver delete, and
 * the buffer eviction that stops a queued set() resurrecting the row, both fire the moment delete()
 * is called => await/`.force()` only decide whether you wait for it.
 *
 * engine agnostic on purpose => drives {@link KeyProxy} straight over the in memory fakedriver, so
 * it runs everywhere, not only where a real sqlite/postgres is reachable.
 */

import { describe, expect, it } from 'vitest';
import { KeyProxy, TableContext } from '../src/database/index.js';
import type { WriteCollector } from '../src/database/utils/collector.js';
import type { DatabaseDriver } from '../src/database/types.js';
import { NOFLUSH, testcollector } from './helpers/collector.js';
import { fakedriver, rowkey } from './helpers/fakedriver.js';
import { waitfor } from './helpers/wait.js';

const SCHEMA = 'antinuke';
const TABLE = 'settings';
const KEY = 'guild-1';
const ROW = rowkey(SCHEMA, TABLE, KEY);

function keyproxy(driver: DatabaseDriver, collector: WriteCollector | null): KeyProxy {
  return new KeyProxy(new TableContext(SCHEMA, TABLE), KEY, driver, collector);
}

describe('eager delete (C1)', () => {
  it('an un-awaited delete reaches the driver with the collector off', async () => {
    const driver = fakedriver();
    driver.rows.set(ROW, { strict: true });

    // no await, no .force()
    keyproxy(driver, null).delete();

    await waitfor('the un-awaited delete reaches the driver', () => driver.calls.delete > 0);
    expect(driver.rows.has(ROW)).toBe(false);
  });

  it('an un-awaited delete reaches the driver with the collector on', async () => {
    const driver = fakedriver();
    const collector = testcollector(driver);
    driver.rows.set(ROW, { strict: true });

    keyproxy(driver, collector).delete(); // fire and forget

    await waitfor('the un-awaited delete reaches the driver', () => driver.calls.delete > 0);
    expect(driver.rows.has(ROW)).toBe(false);

    await collector.stop();
  });

  it('an un-awaited delete evicts a buffered set for the key, so a later flush cannot resurrect it', async () => {
    const driver = fakedriver();
    const collector = testcollector(driver, NOFLUSH); // nothing flushes on its own
    const key = keyproxy(driver, collector);

    // eager queue via the facade => sits in the buffer, not on the driver yet
    key.set({ strict: true });
    expect(collector.pendingCount).toBe(1);

    // fire and forget delete => evict() runs synchronously, so the buffered set is already gone
    key.delete();
    expect(collector.pendingCount).toBe(0);

    await waitfor('the un-awaited delete reaches the driver', () => driver.calls.delete > 0);

    // flush whatever is left => the evicted set must not come back around
    await collector.flush();
    expect(driver.rows.has(ROW)).toBe(false);

    await collector.stop();
  });
});
