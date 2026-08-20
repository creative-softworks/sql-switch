/**
 * @packageDocumentation
 * A2 => a bare `set()` (no await, no .force()) must still land.
 *
 * The write operation used to be lazy: nothing happened until you awaited it or called .force(),
 * so a fire and forget `db...set(v)` silently dropped the write. These lock the eager behaviour in
 * => the write is committed to the buffer the moment set() is called, await only decides whether
 * you wait for it, and validation still throws synchronously at the call.
 */

import { describe, expect, it } from 'vitest';
import { localdal, reopen } from './helpers/tempdal.js';

// long enough that nothing flushes mid test, short enough to dodge the >=10s collector warning
const NOFLUSH = { enabled: true, time: 9_000 } as const;

describe('eager set', () => {
  it('an un-awaited set is queued right away', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('antinuke').table('settings').key('guild-1');

    // no await, no .force()
    key.set({ strict: true });

    expect(db.pendingWrites).toBe(1);
    expect(await key.get()).toEqual({ strict: true });
  });

  it('an un-awaited set actually reaches disk on flush', async () => {
    const { db, dir } = await localdal(NOFLUSH);

    db.schema('antinuke').table('settings').key('guild-1').set({ strict: true });
    // close flushes the buffer => prove it landed by reading through a fresh connection
    await db.close();

    const fresh = await reopen(dir);
    expect(await fresh.schema('antinuke').table('settings').key('guild-1').get()).toEqual({
      strict: true,
    });
  });

  it('an un-awaited set still lands with the collector disabled', async () => {
    const { db, dir } = await localdal({ enabled: false });

    db.schema('economy').table('balances').key('user-1').set({ coins: 5 });
    // no collector => the driver write is fired eagerly, give the microtask a turn then read back
    await db.schema('economy').table('balances').key('user-1').get();
    await db.close();

    const fresh = await reopen(dir);
    expect(await fresh.schema('economy').table('balances').key('user-1').get()).toEqual({
      coins: 5,
    });
  });

  it('validation still throws synchronously at the call, before anything is queued', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('antinuke').table('settings').key('guild-1');

    expect(() => key.set(undefined)).toThrow(TypeError);
    expect(db.pendingWrites).toBe(0);
  });

  it('.force() supersedes a value that was eagerly queued first', async () => {
    const { db, dir } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('balances').key('user-1');

    key.set({ coins: 1 }); // eager queue
    await key.set({ coins: 2 }).force(); // immediate, must win

    await db.close();
    const fresh = await reopen(dir);
    expect(await fresh.schema('economy').table('balances').key('user-1').get()).toEqual({
      coins: 2,
    });
  });
});
