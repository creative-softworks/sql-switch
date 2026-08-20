/**
 * @packageDocumentation
 * #11 / M4 => the collector's observability hooks. onStateChange already existed (see
 * breaker-recovery); these lock in the three that report the things you actually want alerts on:
 * a flush that failed (onFlushError, retried), writes lost for good (onDrop), and the buffer
 * filling faster than it drains (onBackpressure). A throwing hook must never take the flush down.
 */

import { describe, expect, it, vi } from 'vitest';
import { fakedriver } from './helpers/fakedriver.js';
import { waitfor } from './helpers/wait.js';
import {
  WriteCollector,
  resolveCollectorConfig,
  MAX_BUFFER,
  HIGH_WATER,
} from '../src/database/utils/collector.js';
import type { CollectorConfig, DatabaseDriver } from '../src/database/types.js';

function collectorfor(driver: DatabaseDriver, config: CollectorConfig): WriteCollector {
  return new WriteCollector(driver, resolveCollectorConfig(config));
}

describe('collector observability hooks', () => {
  it('onFlushError fires with the failing group context, then the write is retried', async () => {
    const driver = fakedriver();
    const calls: Array<{ schema: string; table: string; writes: number }> = [];
    const collector = collectorfor(driver, {
      time: 20,
      hooks: { onFlushError: (_err, ctx) => calls.push(ctx) },
    });

    driver.failBatches(1); // one transient failure, then it lands
    collector.queue('economy', 'balances', 'user-1', { coins: 1 });

    await waitfor('the write to be retried onto the driver', () => driver.rows.size === 1, 2_000);
    expect(calls).toEqual([{ schema: 'economy', table: 'balances', writes: 1 }]);

    await collector.stop();
  });

  it('onFlushError replaces the default console.error', async () => {
    const driver = fakedriver();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const collector = collectorfor(driver, {
      time: 20,
      hooks: { onFlushError: () => undefined },
    });

    driver.failBatches(1);
    collector.queue('economy', 'balances', 'user-1', { coins: 1 });
    await waitfor('the write to land', () => driver.rows.size === 1, 2_000);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await collector.stop();
  });

  it('onBackpressure fires once when the buffer crosses the high-water mark', async () => {
    const driver = fakedriver();
    let fired = 0;
    let reported = { pending: 0, max: 0 };
    const collector = collectorfor(driver, {
      time: 9_000, // nothing flushes on its own => we control the buffer level
      hooks: {
        onBackpressure: (pending, max) => {
          fired++;
          reported = { pending, max };
        },
      },
    });

    // one short of the mark => silent
    for (let i = 0; i < HIGH_WATER - 1; i++) collector.queue('bulk', 'rows', `k-${i}`, { i });
    expect(fired).toBe(0);

    // crossing it fires exactly once, no matter how many more pile on
    collector.queue('bulk', 'rows', 'crosses', { i: -1 });
    collector.queue('bulk', 'rows', 'and-again', { i: -2 });
    expect(fired).toBe(1);
    expect(reported).toEqual({ pending: HIGH_WATER, max: MAX_BUFFER });

    await collector.stop();
  });

  it('onDrop fires for writes that can not be flushed before shutdown', async () => {
    const driver = fakedriver();
    const drops: Array<{ writes: number; reason: string }> = [];
    const collector = collectorfor(driver, {
      time: 9_000,
      hooks: { onDrop: (writes, reason) => drops.push({ writes, reason }) },
    });

    // the flush on stop() fails => the write comes back with nobody left to retry it
    driver.failBatches(10, 'still down at shutdown');
    collector.queue('economy', 'balances', 'user-1', { coins: 1 });
    await collector.stop();

    expect(drops).toHaveLength(1);
    expect(drops[0]?.writes).toBe(1);
    expect(drops[0]?.reason).toContain('shutdown');
  });

  it('onDrop fires when the buffer overflows while retrying a failed group', async () => {
    const driver = fakedriver();
    const drops: number[] = [];
    // long cooldown => once it trips it stays open, so the requeue overflow is the only drop path
    const collector = collectorfor(driver, {
      time: 20,
      recoverAfter: 600_000,
      hooks: { onDrop: (writes) => drops.push(writes) },
    });

    // park the first flush inside the driver so we can refill the emptied buffer behind it: a
    // 1:1 requeue of a full buffer never overflows, it's fresh writes landing during the retry
    // that push it past the cap
    const blocked = driver.blockNextBatch();
    for (let i = 0; i < 3_000; i++) collector.queue('bulk', 'rows', `g1-${i}`, { i });
    await blocked.started; // flush is in flight, buffer cleared

    // 3000 fresh keys into the emptied buffer while the first group is parked
    for (let i = 0; i < 3_000; i++) collector.queue('bulk', 'rows', `g2-${i}`, { i });

    // fail the parked group => it requeues on top of the 3000 => 6000 > 5000 => the leftover drops
    blocked.release(new Error('still down'));

    await waitfor('the breaker to trip on the retry path', () => collector.isTripped, 3_000);
    expect(drops.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

    await collector.stop();
  });

  it('a throwing hook is caught and never takes the flush down', async () => {
    const driver = fakedriver();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const collector = collectorfor(driver, {
      time: 20,
      hooks: {
        onFlushError: () => {
          throw new Error('metrics backend is down');
        },
      },
    });

    driver.failBatches(1);
    collector.queue('economy', 'balances', 'user-1', { coins: 1 });

    // despite the hook throwing, the retry still lands the write
    await waitfor('the write to land despite the throwing hook', () => driver.rows.size === 1, 2_000);
    expect(spy).toHaveBeenCalled(); // the throw was logged, not propagated

    spy.mockRestore();
    await collector.stop();
  });
});
