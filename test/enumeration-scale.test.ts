/**
 * @packageDocumentation
 * Large-N proof for the enumeration & bulk methods (G3/SC2). The point isn't the exact number, it's
 * that a table far bigger than any single chunk still scans, counts & clears without ever holding
 * more than a page in memory => streaming, not materialize-then-iterate.
 *
 * N is kept modest so the suite stays quick, but it's several times the 500-row driver chunk, so the
 * cursor/keyset paging path is genuinely exercised (a one-chunk table would never page).
 */

import { describe, expect, it } from 'vitest';
import { localdal, reopen } from './helpers/tempdal.js';

const NOFLUSH = { enabled: true, time: 60_000 } as const;
const N = 2_500; // > 5x the 500-row SQLite tx / Postgres keyset chunk

describe('enumeration at scale', () => {
  it('streams every row in order, counts, then clears them all', async () => {
    const { db, dir } = await localdal(NOFLUSH);
    const table = db.schema('economy').table('balances');

    // one bulk flush on close rather than N forced writes => keep the setup cheap
    for (let i = 0; i < N; i++) {
      table.key(`user-${String(i).padStart(5, '0')}`).set({ coins: i });
    }
    await db.close();

    // reopen so the scan reads committed rows off disk, not the collector buffer
    const fresh = await reopen(dir);
    const t = fresh.schema('economy').table('balances');

    expect(await t.count()).toBe(N);

    let seen = 0;
    let last = '';
    for await (const id of t.keys()) {
      expect(id > last).toBe(true); // ascending id order holds across chunk boundaries
      last = id;
      seen++;
    }
    expect(seen).toBe(N);

    await t.deleteAll();
    expect(await t.count()).toBe(0);
    await fresh.close();
  });

  it('prefix scan only walks the matching slice', async () => {
    const { db, dir } = await localdal(NOFLUSH);
    const table = db.schema('antinuke').table('settings');

    for (let i = 0; i < N; i++) table.key(`guild-${String(i).padStart(5, '0')}`).set({ n: i });
    for (let i = 0; i < 10; i++) table.key(`user-${i}`).set({ n: i });
    await db.close();

    const fresh = await reopen(dir);
    const t = fresh.schema('antinuke').table('settings');

    expect(await t.count({ prefix: 'guild-' })).toBe(N);
    expect(await t.count({ prefix: 'user-' })).toBe(10);
    await fresh.close();
  });
});
