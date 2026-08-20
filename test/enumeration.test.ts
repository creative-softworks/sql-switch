/**
 * @packageDocumentation
 * #7 => a KV store you can actually scan. `keys` / `values` / `entries` / `count` / `startsWith`,
 * all streaming (async iterators) so a big table never lands in RAM at once (SC2).
 *
 * These run against real SQLite files so the driver's cursor & the bound prefix filter are both
 * exercised end to end. The prefix is bound, never interpolated (S6) => a prefix full of SQL/glob
 * metacharacters just matches literally or matches nothing.
 */

import { describe, expect, it } from 'vitest';
import { localdal } from './helpers/tempdal.js';

// nothing flushes mid test, but enumeration reads committed rows => write with .force() so the
// rows are actually on disk for the scan to find
const NOFLUSH = { enabled: true, time: 9_000 } as const;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('enumeration', () => {
  it('keys / values / entries stream everything in a table', async () => {
    const { db } = await localdal(NOFLUSH);
    const table = db.schema('economy').table('balances');

    await table.key('user-1').set({ coins: 1 }).force();
    await table.key('user-2').set({ coins: 2 }).force();
    await table.key('user-3').set({ coins: 3 }).force();

    expect((await collect(table.keys())).sort()).toEqual(['user-1', 'user-2', 'user-3']);
    expect(await collect(table.values())).toContainEqual({ coins: 2 });

    const entries = await collect(table.entries());
    expect(entries).toContainEqual(['user-2', { coins: 2 }]);
    expect(entries).toHaveLength(3);
  });

  it('count returns the row total as a plain number', async () => {
    const { db } = await localdal(NOFLUSH);
    const table = db.schema('economy').table('balances');

    expect(await table.count()).toBe(0);
    await table.key('user-1').set({ coins: 1 }).force();
    await table.key('user-2').set({ coins: 2 }).force();

    const n = await table.count();
    expect(n).toBe(2);
    expect(typeof n).toBe('number');
  });

  it('startsWith filters by an exact, case sensitive id prefix', async () => {
    const { db } = await localdal(NOFLUSH);
    const table = db.schema('antinuke').table('settings');

    await table.key('guild-1').set({ strict: true }).force();
    await table.key('guild-2').set({ strict: false }).force();
    await table.key('user-1').set({ strict: true }).force();
    await table.key('GUILD-9').set({ strict: true }).force(); // wrong case, must not match

    const ids = (await collect(table.startsWith('guild-'))).map(([id]) => id).sort();
    expect(ids).toEqual(['guild-1', 'guild-2']);

    expect(await table.count({ prefix: 'guild-' })).toBe(2);
  });

  it('a prefix with wildcard metacharacters is matched literally, not interpreted', async () => {
    const { db } = await localdal(NOFLUSH);
    const table = db.schema('antinuke').table('settings');

    await table.key('a%b').set({ ok: true }).force();
    await table.key('axb').set({ ok: false }).force(); // would match if % were a wildcard

    const ids = (await collect(table.startsWith('a%'))).map(([id]) => id);
    expect(ids).toEqual(['a%b']);
  });

  it('scanning an empty table yields nothing', async () => {
    const { db } = await localdal(NOFLUSH);
    const table = db.schema('economy').table('empties');

    expect(await collect(table.keys())).toEqual([]);
    expect(await table.count()).toBe(0);
  });

  it('a scan does not wedge other writes to the same schema (no live cursor across await)', async () => {
    const { db } = await localdal(NOFLUSH);
    const table = db.schema('economy').table('balances');

    await table.key('user-1').set({ coins: 1 }).force();
    await table.key('user-2').set({ coins: 2 }).force();
    await table.key('user-3').set({ coins: 3 }).force();

    // a live better-sqlite3 cursor held across the async yields pins the one connection this schema
    // shares => anything else touching it mid scan used to throw "database connection is busy"
    // (drivers #1). keyset paging reads a page then frees the connection, so a write lands fine
    const seen: string[] = [];
    for await (const [id] of table.entries()) {
      seen.push(id);
      if (seen.length === 1) {
        await table.key('mid-scan').set({ coins: 99 }).force();
      }
    }

    expect(seen.length).toBeGreaterThanOrEqual(3);
    // the write that ran mid scan actually committed instead of throwing
    expect(await table.key('mid-scan').get()).toEqual({ coins: 99 });
  });

  it('keeps an empty-string id in the scan (first page has no id > bound)', async () => {
    const { db } = await localdal(NOFLUSH);
    const table = db.schema('economy').table('edge');

    await table.key('').set({ empty: true }).force();
    await table.key('a').set({ empty: false }).force();

    // keyset paging seeds the first page with no lower bound, so `id > ?` can't drop the '' row
    expect((await collect(table.keys())).sort()).toEqual(['', 'a']);
  });
});
