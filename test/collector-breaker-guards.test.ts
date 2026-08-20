/**
 * @packageDocumentation
 * Adversarial-review hardening for the write collector => five separate ways the breaker or the
 * flush path could misbehave under load or a flaky driver. Each one is a spot the earlier design
 * got subtly wrong:
 *
 * - COL#1 => a repeat write to an *already buffered* key at the cap collapses onto it, so it must
 *   not trip the breaker (only a brand new key growing the buffer past the cap can).
 * - COL#2 => a flush that succeeds while a write burst has legitimately refilled the buffer to the
 *   cap must not declare the breaker closed on top of a full buffer (open/closed flapping).
 * - COL#3 => `beforeExit` draining a buffer that a dead database keeps rejecting must give up &
 *   drop its own listener, or the process can never exit (flush → requeue → beforeExit forever).
 * - COL#5 => a driver whose `batchSet` throws *synchronously* has to be absorbed as a failed group
 *   (requeued, retried), not thrown out of the flush where the write is silently lost.
 * - COL#6 => a failed flush requeues its groups back over the high-water mark, but the flush already
 *   re-armed the backpressure edge when it cleared the buffer => the requeue climb has to re-fire
 *   onBackpressure, otherwise it stays silent until the next brand new write happens to trip it.
 * - COL#7 => a non-finite `time`/`recoverAfter` (NaN, Infinity) has to be rejected up front, before
 *   it coerces `setInterval` into a ~1ms hot loop.
 *
 * All run against the fake driver so a test can steer failures & park a flush mid flight.
 */

import { describe, expect, it, vi } from 'vitest';
import { fakedriver } from './helpers/fakedriver.js';
import { waitfor, sleep } from './helpers/wait.js';
import {
  WriteCollector,
  resolveCollectorConfig,
  MAX_BUFFER,
  HIGH_WATER,
} from '../src/database/utils/collector.js';
import { ConfigurationError, DatabaseUnavailableError } from '../src/database/errors.js';
import type { CollectorConfig, DatabaseDriver } from '../src/database/types.js';

function collectorfor(driver: DatabaseDriver, config: CollectorConfig): WriteCollector {
  return new WriteCollector(driver, resolveCollectorConfig(config));
}

describe('collector breaker guards', () => {
  it('COL#1 => a repeat write at the cap updates in place instead of tripping', async () => {
    const driver = fakedriver();
    const collector = collectorfor(driver, { time: 9_000 }); // nothing flushes on its own

    for (let i = 0; i < MAX_BUFFER; i++) collector.queue('bulk', 'rows', `key-${i}`, { i });
    expect(collector.pendingCount).toBe(MAX_BUFFER);

    // key-0 is already buffered => this collapses onto it (last write wins), the buffer can't grow,
    // so the breaker must stay closed. the old guard tripped on size alone & went read-only here
    expect(() => collector.queue('bulk', 'rows', 'key-0', { i: 999 })).not.toThrow();
    expect(collector.isTripped).toBe(false);
    expect(collector.pendingCount).toBe(MAX_BUFFER);

    // a brand new key at the cap is the real overflow => that still trips
    expect(() => collector.queue('bulk', 'rows', 'new-key', { i: -1 })).toThrow(
      DatabaseUnavailableError,
    );
    expect(collector.isTripped).toBe(true);

    await collector.stop();
  });

  it('COL#2 => a succeeding flush does not close the breaker while a burst refilled the buffer', async () => {
    const driver = fakedriver();
    // long cooldown => once the burst trips it, only this test's actions move the breaker
    const collector = collectorfor(driver, { time: 20, recoverAfter: 600_000 });

    // park the first flush inside the driver so we can refill the emptied buffer behind it
    const blocked = driver.blockNextBatch();
    collector.queue('bulk', 'rows', 'first', { i: 0 });
    await blocked.started; // flush is in flight, buffer cleared

    // a genuine write burst fills the buffer to the cap & trips the breaker while the flush is parked
    for (let i = 0; i < MAX_BUFFER; i++) collector.queue('bulk', 'rows', `burst-${i}`, { i });
    expect(() => collector.queue('bulk', 'rows', 'one-too-many', { i: -1 })).toThrow(
      DatabaseUnavailableError,
    );
    expect(collector.isTripped).toBe(true);

    // the parked flush lands successfully => but the buffer is legitimately over the cap now, so
    // the breaker has to stay open rather than flap back to closed on top of a full buffer
    blocked.release();
    await waitfor('the parked flush to commit its group', () => driver.rows.size >= 1, 2_000);
    await sleep(30); // let the success branch run (or, with the guard, decline to)

    expect(collector.isTripped).toBe(true);
    expect(collector.pendingCount).toBe(MAX_BUFFER);

    await collector.stop();
  });

  it('COL#3 => beforeExit stops re-arming when a dead DB makes no progress', async () => {
    const errspy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const driver = fakedriver();

    // sample before constructing => the collector registers its beforeExit listener in the ctor
    const before = process.listenerCount('beforeExit');
    const collector = collectorfor(driver, { time: 9_000 }); // no interval flush during the test
    expect(process.listenerCount('beforeExit')).toBe(before + 1);

    driver.failBatches(Number.MAX_SAFE_INTEGER, 'down for the whole test');
    collector.queue('economy', 'balances', 'user-1', { coins: 1 });

    // simulate the loop draining => our handler flushes, the flush makes no headroom (DB down), so
    // it must remove itself so node can actually exit instead of re-firing beforeExit forever
    process.emit('beforeExit', 0);
    await waitfor(
      'the beforeExit listener to remove itself after a no-progress flush',
      () => process.listenerCount('beforeExit') === before,
      2_000,
    );

    // the write is still buffered => lost to the outage, same as a hard kill mid-outage would lose it
    expect(collector.pendingCount).toBe(1);

    await collector.stop();
    errspy.mockRestore();
  });

  it('COL#5 => a synchronous throw from batchSet is a failed group, not a lost write', async () => {
    const rows = new Map<string, unknown>();
    let boom = true;
    let flushErrors = 0;
    const driver: DatabaseDriver = {
      async get(s, t, k) {
        const v = rows.get(`${s}:${t}:${k}`);
        return v === undefined ? null : v;
      },
      async exists(s, t, k) {
        return rows.has(`${s}:${t}:${k}`);
      },
      async set(s, t, k, v) {
        rows.set(`${s}:${t}:${k}`, v);
      },
      // deliberately not async => the first call throws *synchronously*, the way a mis-written or
      // genuinely sync driver would. allSettled has to absorb that instead of it escaping runFlush
      batchSet(s, t, writes) {
        if (boom) {
          boom = false;
          throw new Error('sync boom');
        }
        for (const [k, v] of writes) rows.set(`${s}:${t}:${k}`, v);
        return Promise.resolve();
      },
      async delete(s, t, k) {
        rows.delete(`${s}:${t}:${k}`);
      },
      // eslint-disable-next-line require-yield
      async *scan() {
        return;
      },
      async count() {
        return 0;
      },
      async close() {
        return;
      },
    };
    const collector = collectorfor(driver, {
      time: 20,
      hooks: { onFlushError: () => void flushErrors++ },
    });

    collector.queue('economy', 'balances', 'user-1', { coins: 1 });

    // the sync throw is caught & the group requeued => the retry lands, nothing is dropped
    await waitfor('the write to survive the sync throw and land', () => rows.size === 1, 2_000);
    expect(flushErrors).toBeGreaterThanOrEqual(1);

    await collector.stop();
  });

  it('COL#6 => a requeue that refills past the high-water mark re-fires backpressure', async () => {
    const driver = fakedriver();
    const pressures: number[] = [];
    // long interval => the test drives the single flush itself via the parked batch, nothing else
    // fires on a timer & muddies the onBackpressure count
    const collector = collectorfor(driver, {
      time: 9_000,
      hooks: { onBackpressure: (pending) => void pressures.push(pending) },
    });

    // park the flush so we can inspect the buffer mid flight, then fail it on release
    const blocked = driver.blockNextBatch();

    // one group (same schema:table) of exactly HIGH_WATER keys => the fresh-write edge fires once on
    // the way up. all in one group so the whole climb requeues as a single failed batch below
    for (let i = 0; i < HIGH_WATER; i++) collector.queue('bulk', 'rows', `key-${i}`, { i });
    expect(pressures.length).toBe(1);
    expect(pressures[0]).toBe(HIGH_WATER);

    // manual flush => snapshots & clears the buffer (re-arming the edge to false), then parks in the
    // driver. with the buffer emptied, a naive edge can never fire again on its own
    const flushing = collector.flush();
    await blocked.started;
    expect(collector.pendingCount).toBe(0);

    // the parked batch rejects => the whole group is requeued, refilling the buffer back over the
    // mark. COL#6: that climb has to re-fire onBackpressure even though no new write() happened
    blocked.release(new Error('outage'));
    await flushing;

    expect(collector.pendingCount).toBe(HIGH_WATER);
    expect(pressures.length).toBe(2);
    expect(pressures[1]).toBe(HIGH_WATER);

    await collector.stop();
  });

  it('COL#7 => a non-finite time or recoverAfter is rejected up front', () => {
    // NaN slips past a plain `<= 0` (NaN <= 0 is false) & then coerces setInterval to a ~1ms loop
    expect(() => resolveCollectorConfig({ time: Number.NaN })).toThrow(ConfigurationError);
    expect(() => resolveCollectorConfig({ time: Number.POSITIVE_INFINITY })).toThrow(
      ConfigurationError,
    );
    expect(() => resolveCollectorConfig({ recoverAfter: Number.NaN })).toThrow(ConfigurationError);
    expect(() => resolveCollectorConfig({ recoverAfter: Number.POSITIVE_INFINITY })).toThrow(
      ConfigurationError,
    );

    // a finite, positive config still resolves cleanly
    expect(() => resolveCollectorConfig({ time: 1000, recoverAfter: 5000 })).not.toThrow();
  });
});
