/**
 * @packageDocumentation
 * P0 #5 + P1 #9 => the buffer has to survive the way processes actually get stopped, and the
 * library must not steal shutdown from the app while doing it.
 *
 * Two bugs, one code region. Only SIGINT was handled, so every container stop (SIGTERM) dropped up
 * to a full flush window of writes with no error at all (#5). And the handler finished with
 * `process.exit(0)`, which cancels the app's own handlers, its `finally` blocks & any other
 * collector still draining => whoever flushed first killed the process for everybody (#9).
 *
 * The in process tests keep a listener of their own on the signal, standing in for the host app =>
 * that's also what stops the collector re-raising the signal & taking the test runner down with it.
 * The re-raise itself is checked end to end in a child process instead (see the fixture).
 */

import { describe, expect, it, vi } from 'vitest';
import { fakedriver, rowkey } from './helpers/fakedriver.js';
import { testcollector } from './helpers/collector.js';
import { tempdir, reopen } from './helpers/tempdal.js';
import { runfixture } from './helpers/child.js';
import { waitfor, sleep } from './helpers/wait.js';

/**
 * Stand in for the host app's own signal handler.
 *
 * Two jobs => it proves a collector doesn't need to own the signal, and it keeps the collector from
 * re-raising (which would kill the vitest worker, not just this test).
 */
function appListener(signal: NodeJS.Signals): () => void {
  const noop = (): void => undefined;
  process.on(signal, noop);
  return () => process.off(signal, noop);
}

describe('exit flush', () => {
  it('drains the buffer on SIGTERM, not just SIGINT', async () => {
    const release = appListener('SIGTERM');
    try {
      const driver = fakedriver();
      const collector = testcollector(driver);
      collector.queue('antinuke', 'settings', 'guild-1', { strict: true });

      process.emit('SIGTERM', 'SIGTERM');

      await waitfor('the SIGTERM flush', () =>
        driver.rows.has(rowkey('antinuke', 'settings', 'guild-1')),
      );
      await collector.stop();
    } finally {
      release();
    }
  });

  it('does not call process.exit itself', async () => {
    const release = appListener('SIGINT');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const driver = fakedriver();
      const collector = testcollector(driver);
      collector.queue('antinuke', 'settings', 'guild-1', { strict: true });

      process.emit('SIGINT', 'SIGINT');

      await waitfor('the SIGINT flush', () =>
        driver.rows.has(rowkey('antinuke', 'settings', 'guild-1')),
      );
      expect(exit).not.toHaveBeenCalled();
      await collector.stop();
    } finally {
      exit.mockRestore();
      release();
    }
  });

  it('drains the buffer on beforeExit', async () => {
    const driver = fakedriver();
    const collector = testcollector(driver);
    collector.queue('antinuke', 'settings', 'guild-1', { strict: true });

    process.emit('beforeExit', 0);

    await waitfor('the beforeExit flush', () =>
      driver.rows.has(rowkey('antinuke', 'settings', 'guild-1')),
    );
    await collector.stop();
  });

  it('leaves no handlers behind after stop()', async () => {
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      beforeExit: process.listenerCount('beforeExit'),
    };

    const collector = testcollector(fakedriver());
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);

    await collector.stop();

    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('beforeExit')).toBe(before.beforeExit);
  });

  it('registers nothing at all when flushOnExit is off', async () => {
    const release = appListener('SIGTERM');
    try {
      const before = process.listenerCount('SIGTERM');
      const driver = fakedriver();
      const collector = testcollector(driver, { enabled: true, time: 9_000, flushOnExit: false });

      expect(process.listenerCount('SIGTERM')).toBe(before);

      collector.queue('antinuke', 'settings', 'guild-1', { strict: true });
      process.emit('SIGTERM', 'SIGTERM');
      await sleep(50);

      expect(driver.calls.batchSet).toBe(0);
      await collector.stop();
    } finally {
      release();
    }
  });

  it('flushes to disk & hands the signal back in a real process', async () => {
    const dir = tempdir();

    const exited = await runfixture('exit-flush-child.ts', [dir], {
      onReady: (child) => child.kill('SIGTERM'),
    });

    // handler off & signal re-raised => the process dies of SIGTERM the way it would have without us
    expect(exited.signal).toBe('SIGTERM');
    expect(exited.selfexit).toBe(true);

    const db = await reopen(dir);
    expect(await db.schema('antinuke').table('settings').key('guild-1').get()).toEqual({
      strict: true,
    });
  });
});
