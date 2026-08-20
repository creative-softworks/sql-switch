/**
 * @packageDocumentation
 * P0 #1 + M6 => reads must see writes that are still sitting in the collector buffer.
 *
 * `set()` then `get()` returning the old value is the single most surprising thing about a KV
 * store, so these lock the behaviour in: a queued write is visible right away, a queued write
 * shadows what's on disk, & the lookup stays O(1) with a full buffer (never a scan).
 */

import { describe, expect, it } from 'vitest';
import { localdal } from './helpers/tempdal.js';

// long enough that nothing flushes mid test, short enough to dodge the >=10s collector warning
const NOFLUSH = { enabled: true, time: 9_000 } as const;

describe('read your writes', () => {
  it('a queued set is visible to an immediate get', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('antinuke').table('settings').key('guild-1');

    await key.set({ strict: true });

    expect(db.pendingWrites).toBe(1);
    expect(await key.get()).toEqual({ strict: true });
  });

  it('a queued write shadows the value already on disk', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('balances').key('user-1');

    await key.set({ coins: 1 }).force();
    await key.set({ coins: 2 });

    expect(await key.get()).toEqual({ coins: 2 });
  });

  it('a buffered null reads back as null, not as a miss', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('antinuke').table('settings').key('guild-1');

    await key.set({ strict: true }).force();
    await key.set(null);

    expect(await key.get()).toBeNull();
  });

  it('an unknown key still reads null with writes buffered', async () => {
    const { db } = await localdal(NOFLUSH);
    const table = db.schema('antinuke').table('settings');

    await table.key('guild-1').set({ strict: true });

    expect(await table.key('nope').get()).toBeNull();
  });

  it('mutating the object after set cannot change what a later get returns', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('antinuke').table('settings').key('guild-1');

    const payload = { strict: true };
    await key.set(payload);
    payload.strict = false;

    // the buffered copy is snapshotted, so the read reflects what was actually written
    expect(await key.get()).toEqual({ strict: true });
  });

  it('reads stay O(1) with a full buffer (no buffer scan)', async () => {
    const { db } = await localdal(NOFLUSH);
    const table = db.schema('bulk').table('rows');

    // 4999 keys => just under the 5000 breaker cap
    for (let i = 0; i < 4999; i++) {
      await table.key(`key-${i}`).set({ i });
    }
    expect(db.pendingWrites).toBe(4999);

    // an O(n) peek would be ~25M comparisons here, an O(1) one is ~5k map lookups
    const started = performance.now();
    for (let i = 0; i < 4999; i++) {
      await table.key(`key-${i}`).get();
    }
    const elapsed = performance.now() - started;

    expect(await table.key('key-4998').get()).toEqual({ i: 4998 });
    expect(elapsed).toBeLessThan(2_000);
  });
});
