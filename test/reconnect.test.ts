/**
 * @packageDocumentation
 * 2.0 => `reconnect()` is one primitive for three jobs: restart a wedged connection, recover a lost
 * one, and repoint to the other declared engine without moving data.
 *
 * The rules these lock down: pending writes are flushed before the old engine is torn down (same as
 * `close()`), the exit-flush listener count doesn't grow per call, and a `reconnect()` that can't
 * stand the new engine up — bad target, missing peer dep — leaves the connection you already had
 * fully intact rather than dropping you to no engine at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { createDAL } from '../src/database/index.js';
import { ConfigurationError, NotConnectedError } from '../src/database/errors.js';
import { tempdir } from './helpers/tempdal.js';
import { NOFLUSH } from './helpers/collector.js';

// same trick double-connect uses => make the pg driver fail the way a missing `pg` peer dep would,
// so we can prove reconnect stays on the live engine when the *target* engine can't be built,
// without uninstalling anything. only the one test that repoints to cloud imports this path
vi.mock('../src/database/drivers/postgres-drizzle.js', () => ({
  PostgresDriver: class {
    constructor() {
      const err = new Error("Cannot find package 'pg' imported from postgres-drizzle.js");
      (err as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }
  },
}));

describe('reconnect', () => {
  it('throws NotConnectedError before connect()', async () => {
    const db = createDAL();
    await expect(db.reconnect()).rejects.toThrow(NotConnectedError);
  });

  it('flushes pending writes before tearing the old engine down', async () => {
    const dir = tempdir();
    const db = createDAL();
    onTestFinished(async () => {
      await db.close().catch(() => undefined);
    });

    await db.connect({ db: 'local', local: { dataDir: dir }, collector: NOFLUSH });
    await db.schema('antinuke').table('settings').key('guild-1').set({ strict: true });
    expect(db.pendingWrites).toBe(1);

    // no arg => re-open the same engine. the buffered write has to be drained on the way out, not
    // dropped with the collector it lived on
    await db.reconnect();

    expect(db.pendingWrites).toBe(0);
    expect(fs.existsSync(path.join(dir, 'antinuke.db'))).toBe(true);
    // and the fresh connection reads it back & still writes
    expect(await db.schema('antinuke').table('settings').key('guild-1').get()).toEqual({
      strict: true,
    });
    await db.schema('antinuke').table('settings').key('guild-2').set({ ok: true }).force();
    expect(await db.schema('antinuke').table('settings').key('guild-2').get()).toEqual({
      ok: true,
    });
  });

  it('does not leak an exit-flush listener per call', async () => {
    const db = createDAL();
    onTestFinished(async () => {
      await db.close().catch(() => undefined);
    });

    const before = process.listenerCount('SIGTERM');

    await db.connect({ db: 'local', local: { dataDir: tempdir() }, collector: NOFLUSH });
    await db.reconnect();
    await db.reconnect();

    // one live collector => one listener, no matter how many times we reconnect
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    await db.close();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('reconnects silently => no "already connected" warn like connect()-over-connect does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = createDAL();
    onTestFinished(async () => {
      warn.mockRestore();
      await db.close().catch(() => undefined);
    });

    await db.connect({ db: 'local', local: { dataDir: tempdir() }, collector: NOFLUSH });
    await db.reconnect();

    // a deliberate reconnect() is the sanctioned way to do this => it shouldn't nag
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves the live engine alone when the target has no config block', async () => {
    const dir = tempdir();
    const db = createDAL();
    onTestFinished(async () => {
      await db.close().catch(() => undefined);
    });

    // only a local block was declared => repointing to cloud is rejected before anything is torn
    // down (validation runs ahead of building the replacement driver)
    await db.connect({ db: 'local', local: { dataDir: dir }, collector: NOFLUSH });
    await db.schema('antinuke').table('settings').key('guild-1').set({ strict: true });

    await expect(db.reconnect('cloud')).rejects.toThrow(ConfigurationError);

    // still on local, buffer included
    expect(db.pendingWrites).toBe(1);
    expect(await db.schema('antinuke').table('settings').key('guild-1').get()).toEqual({
      strict: true,
    });
  });

  it('leaves the live engine alone when the target engine fails to build', async () => {
    const dir = tempdir();
    const db = createDAL();
    onTestFinished(async () => {
      await db.close().catch(() => undefined);
    });

    // a cloud block is declared this time, so validation passes & the failure lands inside driver
    // construction (the mocked pg ctor throws ERR_MODULE_NOT_FOUND) => that's exactly the spot the
    // fail-safe ordering has to survive: the old local engine must still be live afterwards
    await db.connect({
      db: 'local',
      local: { dataDir: dir },
      cloud: { connectionString: 'postgres://ignored' },
      collector: NOFLUSH,
    });
    await db.schema('antinuke').table('settings').key('guild-1').set({ strict: true });

    const err = await db
      .reconnect('cloud')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as ConfigurationError).message).toContain('pg');

    // local engine untouched => buffer intact, reads & writes still work
    expect(db.pendingWrites).toBe(1);
    expect(await db.schema('antinuke').table('settings').key('guild-1').get()).toEqual({
      strict: true,
    });
    await db.schema('antinuke').table('settings').key('guild-2').set({ ok: true }).force();
    expect(await db.schema('antinuke').table('settings').key('guild-2').get()).toEqual({
      ok: true,
    });
  });
});
