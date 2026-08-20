/**
 * @packageDocumentation
 * #17 => the small quality-of-life layer on top of get/set/delete. Core + array only (locked scope):
 * `has`, `deleteAll`, `add`/`sub`, `push`/`pull`/`pop`/`shift`/`unshift`. No dot-notation, no
 * merge/update, no aliases.
 *
 * Every one is read-modify-write sugar over the same fluent get/set, so they inherit read-your-writes
 * (a queued value is seen by the next op) and the same value validation. Run against real SQLite.
 */

import { describe, expect, it } from 'vitest';
import { localdal } from './helpers/tempdal.js';

const NOFLUSH = { enabled: true, time: 9_000 } as const;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('convenience methods', () => {
  it('has reflects whether a key exists', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('balances').key('user-1');

    expect(await key.has()).toBe(false);
    await key.set({ coins: 1 });
    expect(await key.has()).toBe(true);
    await key.delete();
    expect(await key.has()).toBe(false);
  });

  it('has returns true for a key whose stored value is null (not built on get)', async () => {
    // regression => has() used to be `get() !== null`, so a row storing a literal null read as
    // absent. it goes through the driver's existence check now, which a stored null can't fool
    const { db } = await localdal({ enabled: false });
    const key = db.schema('economy').table('balances').key('null-holder');

    await key.set(null);
    expect(await key.get()).toBeNull(); // the value really is null
    expect(await key.has()).toBe(true); // ...but the key exists
  });

  it('has sees a buffered null as existing (read your writes)', async () => {
    const { db } = await localdal(NOFLUSH); // long interval => the write stays in the buffer
    const key = db.schema('economy').table('balances').key('null-buffered');

    await key.set(null); // queued, never flushed
    expect(await key.has()).toBe(true);
  });

  it('deleteAll empties a table', async () => {
    const { db } = await localdal(NOFLUSH);
    const table = db.schema('economy').table('balances');

    await table.key('user-1').set({ coins: 1 }).force();
    await table.key('user-2').set({ coins: 2 }).force();
    expect(await table.count()).toBe(2);

    await table.deleteAll();
    expect(await table.count()).toBe(0);
    expect(await collect(table.keys())).toEqual([]);
  });

  it('deleteAll with a prefix only clears the matching keys', async () => {
    const { db } = await localdal(NOFLUSH);
    const table = db.schema('antinuke').table('settings');

    await table.key('guild-1').set({ strict: true }).force();
    await table.key('guild-2').set({ strict: false }).force();
    await table.key('user-1').set({ strict: true }).force();

    await table.deleteAll({ prefix: 'guild-' });

    expect((await collect(table.keys())).sort()).toEqual(['user-1']);
  });

  it('add / sub treat a missing key as 0 and return the new total', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('balances').key('user-1');

    expect(await key.add(5)).toBe(5);
    expect(await key.add(3)).toBe(8);
    expect(await key.sub(2)).toBe(6);
    expect(await key.get()).toBe(6);
  });

  it('add throws when the stored value is not a number', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('balances').key('user-1');

    await key.set({ coins: 1 });
    await expect(key.add(1)).rejects.toThrow(TypeError);
  });

  it('push / unshift build an array from a missing key', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('log').key('events');

    expect(await key.push('a', 'b')).toEqual(['a', 'b']);
    expect(await key.unshift('start')).toEqual(['start', 'a', 'b']);
    expect(await key.get()).toEqual(['start', 'a', 'b']);
  });

  it('pop / shift remove and return an end element', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('log').key('events');

    await key.push('a', 'b', 'c');
    expect(await key.pop()).toBe('c');
    expect(await key.shift()).toBe('a');
    expect(await key.get()).toEqual(['b']);
  });

  it('pop / shift / pull on a missing key return empty without materializing a row', async () => {
    // no collector => a write would land in the driver immediately, so count/keys catch a phantom
    const { db } = await localdal({ enabled: false });
    const table = db.schema('economy').table('log');
    const key = table.key('missing');

    expect(await key.pop()).toBeUndefined();
    expect(await key.shift()).toBeUndefined();
    expect(await key.pull('x')).toEqual([]);

    // asking to remove from nothing must not leave an empty-array row behind
    expect(await key.has()).toBe(false);
    expect(await table.count()).toBe(0);
    expect(await collect(table.keys())).toEqual([]);
  });

  it('pop / shift on an existing empty array return undefined and keep the row', async () => {
    const { db } = await localdal({ enabled: false });
    const key = db.schema('economy').table('log').key('empty');

    await key.set([]);
    expect(await key.pop()).toBeUndefined();
    expect(await key.shift()).toBeUndefined();
    // the row was already there => it stays, still empty (distinct from the missing-key case above)
    expect(await key.has()).toBe(true);
    expect(await key.get()).toEqual([]);
  });

  it('pull removes every element equal to the given value', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('log').key('events');

    await key.push('a', 'b', 'a', 'c', 'a');
    expect(await key.pull('a')).toEqual(['b', 'c']);
    expect(await key.get()).toEqual(['b', 'c']);
  });

  it('pull with a predicate removes what the predicate accepts', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('log').key('nums');

    await key.push(1, 2, 3, 4);
    expect(await key.pull((n: number) => n % 2 === 0)).toEqual([1, 3]);
  });

  it('push throws when the stored value is not an array', async () => {
    const { db } = await localdal(NOFLUSH);
    const key = db.schema('economy').table('balances').key('user-1');

    await key.set({ coins: 1 });
    await expect(key.push('x')).rejects.toThrow(TypeError);
  });
});
