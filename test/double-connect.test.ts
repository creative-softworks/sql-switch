/**
 * @packageDocumentation
 * P1 #8 => `connect()` twice used to leak the engine it replaced.
 *
 * The second call overwrote `driver`, `collector` & `config` without closing anything, so the old
 * pg pool, the old flush interval & the old signal listeners all stayed alive => and whatever was
 * still buffered on that collector was never written by anyone.
 *
 * The rule these lock down: config is validated first, and only then does the previous engine get
 * flushed & closed. A `connect()` that throws leaves the connection you already had alone.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { createDAL } from '../src/database/index.js';
import { ConfigurationError } from '../src/database/errors.js';
import type { DALConfig } from '../src/database/types.js';
import { tempdir } from './helpers/tempdal.js';
import { NOFLUSH } from './helpers/collector.js';

// make the pg driver fail the way a missing `pg` peer dep would => the module `import`s `pg` at the
// top, so a missing peer surfaces as an ERR_MODULE_NOT_FOUND for 'pg'. we throw that from the ctor
// (which connect wraps in the same try as the import) to prove the friendly-error translation
// without uninstalling the package. only the one cloud-mode test imports this, so local stays real
vi.mock('../src/database/drivers/postgres-drizzle.js', () => ({
  PostgresDriver: class {
    constructor() {
      const err = new Error("Cannot find package 'pg' imported from postgres-drizzle.js");
      (err as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }
  },
}));

describe('double connect', () => {
  it('flushes & closes the engine it replaces', async () => {
    const first = tempdir();
    const second = tempdir();
    const db = createDAL();
    onTestFinished(async () => {
      await db.close().catch(() => undefined);
    });

    await db.connect({ db: { mode: 'local', dataDir: first }, collector: NOFLUSH });
    await db.schema('antinuke').table('settings').key('guild-1').set({ strict: true });
    expect(db.pendingWrites).toBe(1);

    await db.connect({ db: { mode: 'local', dataDir: second }, collector: NOFLUSH });

    // buffer belonged to the old collector => nothing would ever have flushed it
    expect(db.pendingWrites).toBe(0);
    expect(fs.existsSync(path.join(first, 'antinuke.db'))).toBe(true);

    // and the new connection is pointed at the new dir
    await db.schema('antinuke').table('settings').key('guild-2').set({ strict: false }).force();
    expect(fs.existsSync(path.join(second, 'antinuke.db'))).toBe(true);
  });

  it('does not leave the old collector listening for signals', async () => {
    const db = createDAL();
    onTestFinished(async () => {
      await db.close().catch(() => undefined);
    });

    const before = process.listenerCount('SIGTERM');

    await db.connect({ db: { mode: 'local', dataDir: tempdir() }, collector: NOFLUSH });
    await db.connect({ db: { mode: 'local', dataDir: tempdir() }, collector: NOFLUSH });

    // one live collector => one listener, not one per connect() call
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    await db.close();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('warns instead of doing it silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = createDAL();
    onTestFinished(async () => {
      warn.mockRestore();
      await db.close().catch(() => undefined);
    });

    await db.connect({ db: { mode: 'local', dataDir: tempdir() }, collector: NOFLUSH });
    expect(warn).not.toHaveBeenCalled();

    await db.connect({ db: { mode: 'local', dataDir: tempdir() }, collector: NOFLUSH });

    expect(warn.mock.calls.flat().join(' ')).toContain('already connected');
  });

  it('leaves the live connection alone when the new config is bad', async () => {
    const dir = tempdir();
    const db = createDAL();
    onTestFinished(async () => {
      await db.close().catch(() => undefined);
    });

    await db.connect({ db: { mode: 'local', dataDir: dir }, collector: NOFLUSH });
    await db.schema('antinuke').table('settings').key('guild-1').set({ strict: true });

    // the types already demand a connectionString here => that guard exists for JS callers, so the
    // cast is the only way to reach it from a typed test
    await expect(
      db.connect({ db: { mode: 'cloud' } } as unknown as DALConfig),
    ).rejects.toThrow(ConfigurationError);
    // a bad collector interval has to be caught before the old engine is torn down too
    await expect(
      db.connect({ db: { mode: 'local', dataDir: dir }, collector: { time: 0 } }),
    ).rejects.toThrow(ConfigurationError);

    // still the original connection, buffer included
    expect(db.pendingWrites).toBe(1);
    expect(await db.schema('antinuke').table('settings').key('guild-1').get()).toEqual({
      strict: true,
    });
  });

  it('leaves the live connection alone when the new engine fails to build', async () => {
    // the config guards pass here, so the failure lands *inside* driver construction (a bad
    // busyTimeout throws in the SqliteDriver ctor) => that's exactly the spot that used to run
    // after the old engine was already torn down, leaving the DAL with no connection at all
    const dir = tempdir();
    const db = createDAL();
    onTestFinished(async () => {
      await db.close().catch(() => undefined);
    });

    await db.connect({ db: { mode: 'local', dataDir: dir }, collector: NOFLUSH });
    await db.schema('antinuke').table('settings').key('guild-1').set({ strict: true });

    await expect(
      db.connect({ db: { mode: 'local', dataDir: dir, busyTimeout: -1 }, collector: NOFLUSH }),
    ).rejects.toThrow(ConfigurationError);

    // the original engine is still live => buffer intact, reads & writes still work
    expect(db.pendingWrites).toBe(1);
    expect(await db.schema('antinuke').table('settings').key('guild-1').get()).toEqual({
      strict: true,
    });
    await db.schema('antinuke').table('settings').key('guild-2').set({ ok: true }).force();
    expect(await db.schema('antinuke').table('settings').key('guild-2').get()).toEqual({ ok: true });
  });

  it('turns a missing engine peer dep into a ConfigurationError that names the package', async () => {
    const db = createDAL();
    onTestFinished(async () => {
      await db.close().catch(() => undefined);
    });

    // the mocked pg driver import throws ERR_MODULE_NOT_FOUND for 'pg' => connect should translate
    // that into a friendly, actionable error rather than surfacing the raw resolver stack
    const err = await db
      .connect({ db: { mode: 'cloud', connectionString: 'postgres://ignored' }, collector: NOFLUSH })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as ConfigurationError).message).toContain('pg');
    expect((err as ConfigurationError).message).toContain('cloud mode');
    // the raw resolver error is kept as the cause for debugging
    expect((err as ConfigurationError).cause).toBeInstanceOf(Error);
  });
});
