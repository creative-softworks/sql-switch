/**
 * @packageDocumentation
 * #12 => SQLite `busy_timeout`. WAL fixes reader/writer contention but not writer/writer, so a
 * blocked write should wait out the lock instead of throwing `SQLITE_BUSY` on contact. The grace is
 * configurable & validated up front (a bad value fails at connect, not on the first collision).
 *
 * The pragma itself is set on the raw connection so we can't read it back through the public API =>
 * these lock the config plumbing (default, override, rejection) and prove a custom value still
 * writes & reads end to end.
 */

import { describe, expect, it } from 'vitest';
import { ConfigurationError, createDAL } from '../src/database/index.js';
import { tempdir } from './helpers/tempdal.js';

describe('sqlite busy_timeout config', () => {
  it('rejects a non-integer or negative timeout at connect (before any write)', async () => {
    const dir = tempdir();
    const db = createDAL();

    await expect(
      db.connect({
        db: { mode: 'local', dataDir: dir, busyTimeout: -1 },
        collector: { enabled: false },
      }),
    ).rejects.toThrow(ConfigurationError);
    await expect(
      db.connect({
        db: { mode: 'local', dataDir: dir, busyTimeout: 1.5 },
        collector: { enabled: false },
      }),
    ).rejects.toThrow(ConfigurationError);
  });

  it('accepts a custom timeout and still writes & reads', async () => {
    const dir = tempdir();
    const db = createDAL();
    await db.connect({
      db: { mode: 'local', dataDir: dir, busyTimeout: 1_000 },
      collector: { enabled: false },
    });

    await db.schema('economy').table('balances').key('user-1').set({ coins: 7 });
    expect(await db.schema('economy').table('balances').key('user-1').get()).toEqual({ coins: 7 });
    await db.close();
  });

  it('accepts 0 (fail immediately)', async () => {
    const dir = tempdir();
    const db = createDAL();
    await db.connect({
      db: { mode: 'local', dataDir: dir, busyTimeout: 0 },
      collector: { enabled: false },
    });
    await db.close();
  });
});
