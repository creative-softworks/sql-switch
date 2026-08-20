/**
 * @packageDocumentation
 * #16 + S4 + S1 => the values that used to make the two engines disagree, or corrupt quietly.
 *
 * `JSON.stringify` is happy to hand back nonsense: `NaN` & `Infinity` become the string `"null"`
 * (so `get()` returns `null` & nobody ever hears about it), and `undefined` comes back as the JS
 * value `undefined`, which sailed through the old serializability guard and died much later as a
 * `NOT NULL` violation inside a flush. NUL is worse than either: valid JSON, stored fine as SQLite
 * TEXT, and a hard error on Postgres JSONB => the same write succeeds locally and throws in
 * production, and an up-swap of that row fails mid-migration.
 *
 * All three are checked in the fluent layer, before the driver exists as far as the value is
 * concerned, so there is exactly one rule & both engines inherit it. The fake driver tests are the
 * proof of that: the value never reaches a driver at all.
 */

import { describe, expect, it } from 'vitest';
import { KeyProxy, InvalidValueError } from '../src/database/index.js';
import { TableContext } from '../src/database/schema-manager.js';
import { fakedriver } from './helpers/fakedriver.js';
import { localdal } from './helpers/tempdal.js';

/** a KeyProxy with no collector => the write path is as short as it gets */
function proxy(key = 'guild-1'): { keyproxy: KeyProxy; driver: ReturnType<typeof fakedriver> } {
  const driver = fakedriver();
  return {
    keyproxy: new KeyProxy(new TableContext('antinuke', 'settings'), key, driver, null),
    driver,
  };
}

describe('values that cannot round trip', () => {
  it('rejects undefined instead of letting it become a NOT NULL violation', () => {
    const { keyproxy, driver } = proxy();

    expect(() => keyproxy.set(undefined)).toThrow(InvalidValueError);
    // thrown at the call, not on await => nothing was queued & no engine was involved
    expect(driver.calls.set).toBe(0);
    expect(driver.rows.size).toBe(0);
  });

  it('rejects NaN & the infinities wherever they sit', () => {
    const { keyproxy } = proxy();

    expect(() => keyproxy.set(NaN)).toThrow(InvalidValueError);
    expect(() => keyproxy.set(Infinity)).toThrow(InvalidValueError);
    expect(() => keyproxy.set(-Infinity)).toThrow(InvalidValueError);
    // nested is the dangerous one => a failed calculation deep in a payload
    expect(() => keyproxy.set({ balance: 10, ratio: NaN })).toThrow(/ratio/);
    expect(() => keyproxy.set([1, 2, Infinity])).toThrow(InvalidValueError);
  });

  it('rejects NUL, the one payload the two engines disagree about', () => {
    const { keyproxy } = proxy();

    expect(() => keyproxy.set('a\u0000b')).toThrow(InvalidValueError);
    expect(() => keyproxy.set({ note: 'a\u0000b' })).toThrow(/note/);
    // property names go into the same jsonb document, so they're just as fatal
    expect(() => keyproxy.set({ ['bad\u0000key']: 1 })).toThrow(InvalidValueError);
    expect(() => keyproxy.set(['fine', 'a\u0000b'])).toThrow(InvalidValueError);
  });

  it('rejects undefined / a function / a symbol inside an array => JSON turns them into null', () => {
    const { keyproxy, driver } = proxy();

    // an array has no hole to leave, so these serialize to null => same silent corruption as NaN.
    // in object *property* position JSON drops them, which is fine & tested under "values that are
    // fine", so the split is deliberate
    expect(() => keyproxy.set([1, undefined, 2])).toThrow(InvalidValueError);
    expect(() => keyproxy.set([() => 1])).toThrow(InvalidValueError);
    expect(() => keyproxy.set([Symbol('x')])).toThrow(InvalidValueError);
    // one level down still caught => a hole buried in a payload is the dangerous case
    expect(() => keyproxy.set({ items: ['ok', undefined] })).toThrow(InvalidValueError);

    // thrown at the call => nothing queued, no engine involved
    expect(driver.calls.set).toBe(0);
    expect(driver.rows.size).toBe(0);
  });

  it('rejects a NUL in the key as well => same disagreement, other column', () => {
    const driver = fakedriver();
    const ctx = new TableContext('antinuke', 'settings');

    expect(() => new KeyProxy(ctx, 'guild\u00001', driver, null)).toThrow(InvalidValueError);
  });

  it('still reports circular refs & BigInt as a TypeError', () => {
    const { keyproxy } = proxy();

    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    // InvalidValueError extends TypeError => code for new callers, instanceof for the old ones
    expect(() => keyproxy.set(circular)).toThrow(TypeError);
    expect(() => keyproxy.set(circular)).toThrow(InvalidValueError);
    expect(() => keyproxy.set({ big: 1n })).toThrow(TypeError);
  });

  it('carries a code so a caller can branch on it', () => {
    const { keyproxy } = proxy();

    try {
      keyproxy.set(undefined);
      expect.unreachable('set(undefined) should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidValueError);
      expect((err as InvalidValueError).code).toBe('INVALID_VALUE');
      expect((err as InvalidValueError).name).toBe('InvalidValueError');
    }
  });
});

describe('values that are fine', () => {
  it('keeps every falsy value that actually means something', async () => {
    const { db } = await localdal({ enabled: false });
    const table = db.schema('antinuke').table('settings');

    await table.key('a').set(null);
    await table.key('b').set(0);
    await table.key('c').set('');
    await table.key('d').set(false);

    expect(await table.key('a').get()).toBeNull();
    expect(await table.key('b').get()).toBe(0);
    expect(await table.key('c').get()).toBe('');
    expect(await table.key('d').get()).toBe(false);
  });

  it('drops undefined properties the way JSON always has', async () => {
    const { db } = await localdal({ enabled: false });
    const key = db.schema('antinuke').table('settings').key('guild-1');

    // optional fields are everywhere in real payloads => rejecting these would be unusable
    await key.set({ strict: true, reason: undefined });

    expect(await key.get()).toEqual({ strict: true });
  });

  it('round trips ordinary payloads untouched', async () => {
    const { db } = await localdal({ enabled: false });
    const key = db.schema('antinuke').table('settings').key('guild-1');

    const value = {
      strict: true,
      limits: { joins: 5, tags: ['raid', 'nuke'] },
      note: 'unicode is fine: ✓ é 😀',
    };
    await key.set(value);

    expect(await key.get()).toEqual(value);
  });
});
