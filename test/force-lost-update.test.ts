/**
 * @packageDocumentation
 * P0 #3 + M5 => a `.force()` write must not be clobbered by an older value still in the buffer.
 *
 * `set(v1)` queues, `set(v2).force()` writes now, then the next flush commits the buffered v1 on
 * top => the newest write loses. Same coherence rule as the delete case (#2): any immediate
 * driver write for a key drops that key from the buffer, and a failed flush can't put it back.
 */

import { describe, expect, it } from 'vitest';
import { localdal, reopen } from './helpers/tempdal.js';
import { fakedriver, rowkey } from './helpers/fakedriver.js';
import { NOFLUSH, testcollector } from './helpers/collector.js';
import { KeyProxy } from '../src/database/index.js';
import { TableContext } from '../src/database/schema-manager.js';

describe('force lost update', () => {
  it('drops the older buffered value for the same key', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('balances').key('user-1');

    await key.set({ coins: 1 });
    expect(db.pendingWrites).toBe(1);

    await key.set({ coins: 2 }).force();

    expect(db.pendingWrites).toBe(0);
    expect(await key.get()).toEqual({ coins: 2 });
  });

  it('survives the next flush', async () => {
    const { db, dir } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('balances').key('user-1');

    await key.set({ coins: 1 });
    await key.set({ coins: 2 }).force();
    await db.close();

    const db2 = await reopen(dir);
    expect(await db2.schema('economy').table('balances').key('user-1').get()).toEqual({ coins: 2 });
  });

  it('a failed flush does not restore the older value over a forced write', async () => {
    const driver = fakedriver();
    const collector = testcollector(driver);

    collector.queue('economy', 'balances', 'user-1', { coins: 1 });

    const blocked = driver.blockNextBatch();
    const flush = collector.flush();
    await blocked.started;

    collector.evict('economy', 'balances', 'user-1');
    await driver.set('economy', 'balances', 'user-1', { coins: 2 });

    blocked.release(new Error('simulated outage'));
    await flush;

    expect(collector.pendingCount).toBe(0);
    expect(driver.rows.get(rowkey('economy', 'balances', 'user-1'))).toEqual({ coins: 2 });

    await collector.stop();
  });

  it('a forced write lands after a flush that is already writing the same key', async () => {
    const driver = fakedriver();
    const collector = testcollector(driver);
    const key = new KeyProxy(new TableContext('economy', 'balances'), 'user-1', driver, collector);

    await key.set({ coins: 1 });

    // hold the flush open with v1 in flight, then force v2 through the fluent path
    const blocked = driver.blockNextBatch();
    const flush = collector.flush();
    await blocked.started;

    const forced = key.set({ coins: 2 }).force();
    blocked.release();
    await Promise.all([flush, forced]);

    // v1 committed first, v2 second => newest write wins
    expect(driver.rows.get(rowkey('economy', 'balances', 'user-1'))).toEqual({ coins: 2 });

    await collector.stop();
  });
});
