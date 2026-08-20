/**
 * @packageDocumentation
 * Harness sanity check (#15) => proves the runner, the temp dir DAL & the fake driver all work
 * before any of the correctness tests lean on them.
 */

import { describe, expect, it } from 'vitest';
import { localdal } from './helpers/tempdal.js';
import { fakedriver, rowkey } from './helpers/fakedriver.js';

describe('test harness', () => {
  it('round trips a value through a throwaway sqlite dal', async () => {
    const { db } = await localdal({ enabled: false });

    await db.schema('antinuke').table('settings').key('guild-1').set({ strict: true });
    const got = await db.schema('antinuke').table('settings').key('guild-1').get();

    expect(got).toEqual({ strict: true });
  });

  it('records driver calls on the fake driver', async () => {
    const driver = fakedriver();

    await driver.set('antinuke', 'settings', 'guild-1', { strict: true });
    await driver.batchSet('antinuke', 'settings', new Map([['guild-2', { strict: false }]]));

    expect(driver.calls.set).toBe(1);
    expect(driver.calls.batchSet).toBe(1);
    expect(driver.batches).toEqual([
      { schema: 'antinuke', table: 'settings', keys: ['guild-2'] },
    ]);
    expect(driver.rows.get(rowkey('antinuke', 'settings', 'guild-2'))).toEqual({ strict: false });
  });
});
