/**
 * @packageDocumentation
 * P0 #2 + M5 => a delete must not be undone by a `set()` that is still buffered.
 *
 * Deletes run immediately while `set()` is buffered, so the two can cross: the delete hits the
 * row now, then the next flush writes the queued value straight back in. These lock down both
 * halves => the buffer is evicted on delete, and a flush that fails mid flight can't requeue a
 * value for a key that got deleted while it was in the air.
 */

import { describe, expect, it } from 'vitest';
import { localdal, reopen } from './helpers/tempdal.js';
import { fakedriver, rowkey } from './helpers/fakedriver.js';
import { NOFLUSH, testcollector } from './helpers/collector.js';

describe('delete resurrection', () => {
  it('drops a buffered set for the same key', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('antinuke').table('settings').key('guild-1');

    await key.set({ strict: true });
    expect(db.pendingWrites).toBe(1);

    await key.delete();

    expect(db.pendingWrites).toBe(0);
  });

  it('stays deleted after the buffer is flushed', async () => {
    const { db, dir } = await localdal(NOFLUSH);
    const key = db.schema('antinuke').table('settings').key('guild-1');

    await key.set({ strict: true });
    await key.delete();
    expect(await key.get()).toBeNull();

    // close() flushes whatever is left => the row must not come back
    await db.close();

    const db2 = await reopen(dir);
    expect(await db2.schema('antinuke').table('settings').key('guild-1').get()).toBeNull();
  });

  it('leaves other buffered keys alone', async () => {
    const { db, dir } = await localdal(NOFLUSH);
    const table = db.schema('antinuke').table('settings');

    await table.key('guild-1').set({ strict: true });
    await table.key('guild-2').set({ strict: false });
    await table.key('guild-1').delete();

    expect(db.pendingWrites).toBe(1);
    await db.close();

    const db2 = await reopen(dir);
    expect(await db2.schema('antinuke').table('settings').key('guild-2').get()).toEqual({
      strict: false,
    });
    expect(await db2.schema('antinuke').table('settings').key('guild-1').get()).toBeNull();
  });

  it('a failed flush does not requeue a key deleted while it was in flight', async () => {
    const driver = fakedriver();
    const collector = testcollector(driver);

    collector.queue('antinuke', 'settings', 'guild-1', { strict: true });

    // park the flush so the delete can land in the middle of it
    const blocked = driver.blockNextBatch();
    const flush = collector.flush();
    await blocked.started;

    collector.evict('antinuke', 'settings', 'guild-1');
    blocked.release(new Error('simulated outage'));
    await flush;

    // the group failed & would normally go back in the buffer => not for an evicted key
    expect(collector.pendingCount).toBe(0);
    expect(driver.rows.has(rowkey('antinuke', 'settings', 'guild-1'))).toBe(false);

    await collector.stop();
  });

  it('an immediate delete waits out a flush that is already writing the key', async () => {
    const driver = fakedriver();
    const collector = testcollector(driver);

    collector.queue('antinuke', 'settings', 'guild-1', { strict: true });

    const blocked = driver.blockNextBatch();
    const flush = collector.flush();
    await blocked.started;

    // delete is issued while the flush holds the value => must not resolve before it lands
    collector.evict('antinuke', 'settings', 'guild-1');
    const deleted = collector.settle().then(() => driver.delete('antinuke', 'settings', 'guild-1'));

    blocked.release();
    await Promise.all([flush, deleted]);

    expect(driver.rows.has(rowkey('antinuke', 'settings', 'guild-1'))).toBe(false);

    await collector.stop();
  });
});
