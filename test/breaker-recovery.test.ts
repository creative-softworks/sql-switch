/**
 * @packageDocumentation
 * P1 #4 => the circuit breaker has to be able to close again.
 *
 * Tripping is the easy half & it already worked: the buffer fills during an outage and further
 * writes are rejected instead of eating RAM. The missing half is recovery => `tripped` was set
 * once & never cleared, so a 30 second Postgres blip left the process read-only until someone
 * restarted it. These lock down the half-open behaviour: wait out a cooldown, let exactly one
 * trial flush through, close on success & re-arm on failure.
 */

import { describe, expect, it } from 'vitest';
import { fakedriver } from './helpers/fakedriver.js';
import { waitfor, sleep } from './helpers/wait.js';
import {
  WriteCollector,
  resolveCollectorConfig,
  MAX_BUFFER,
} from '../src/database/utils/collector.js';
import { DatabaseUnavailableError } from '../src/database/errors.js';
import type { BreakerState, CollectorConfig, DatabaseDriver } from '../src/database/types.js';

/** a collector on the fake driver, defaults resolved the same way `connect()` resolves them */
function collectorfor(driver: DatabaseDriver, config: CollectorConfig): WriteCollector {
  return new WriteCollector(driver, resolveCollectorConfig(config));
}

/** fill the buffer to the cap, then one more write to trip the breaker */
function trip(collector: WriteCollector): void {
  for (let i = 0; i < MAX_BUFFER; i++) {
    collector.queue('bulk', 'rows', `key-${i}`, { i });
  }
  expect(() => collector.queue('bulk', 'rows', 'one-too-many', { i: -1 })).toThrow(
    DatabaseUnavailableError,
  );
  expect(collector.isTripped).toBe(true);
}

describe('breaker recovery', () => {
  it('closes again after a trial flush succeeds', async () => {
    const driver = fakedriver();
    const collector = collectorfor(driver, { time: 20, recoverAfter: 40 });

    trip(collector);
    await waitfor('breaker to close', () => !collector.isTripped);

    expect(collector.pendingCount).toBe(0);
    expect(driver.rows.size).toBe(MAX_BUFFER);

    // read-only mode is over => writes are accepted again
    expect(() => collector.queue('bulk', 'rows', 'after', { ok: true })).not.toThrow();

    await collector.stop();
  });

  it('waits out the cooldown before trying', async () => {
    const driver = fakedriver();
    const collector = collectorfor(driver, { time: 10, recoverAfter: 400 });

    trip(collector);
    // several intervals fit inside the cooldown => none of them may reach the driver
    await sleep(120);
    expect(driver.calls.batchSet).toBe(0);
    expect(collector.isTripped).toBe(true);

    await waitfor('breaker to close', () => !collector.isTripped, 3_000);
    await collector.stop();
  });

  it('re-arms when the trial flush fails, then closes on the next one', async () => {
    const driver = fakedriver();
    const collector = collectorfor(driver, { time: 20, recoverAfter: 40 });

    driver.failBatches(1);
    trip(collector);

    await waitfor('the first trial flush', () => driver.calls.batchSet >= 1);
    expect(collector.isTripped).toBe(true);
    expect(collector.pendingCount).toBe(MAX_BUFFER);

    await waitfor('breaker to close on the second trial', () => !collector.isTripped, 3_000);
    expect(driver.rows.size).toBe(MAX_BUFFER);

    await collector.stop();
  });

  it('reports every transition through onStateChange', async () => {
    const driver = fakedriver();
    const seen: BreakerState[] = [];
    const collector = collectorfor(driver, {
      time: 20,
      recoverAfter: 40,
      hooks: { onStateChange: (state) => seen.push(state) },
    });

    trip(collector);
    await waitfor('breaker to close', () => !collector.isTripped);

    expect(seen).toEqual(['open', 'half-open', 'closed']);
    await collector.stop();
  });

  it('stays read-only forever when autoRecover is off', async () => {
    const driver = fakedriver();
    const collector = collectorfor(driver, { time: 10, recoverAfter: 10, autoRecover: false });

    trip(collector);
    await sleep(150);

    expect(collector.isTripped).toBe(true);
    expect(driver.calls.batchSet).toBe(0);

    await collector.stop();
  });

  it('flushes on stop even while the breaker is open', async () => {
    const driver = fakedriver();
    // a cooldown far longer than the test => only an explicit flush can drain this
    const collector = collectorfor(driver, { time: 9_000, recoverAfter: 600_000 });

    trip(collector);
    await collector.stop();

    expect(driver.rows.size).toBe(MAX_BUFFER);
    expect(collector.pendingCount).toBe(0);
    expect(collector.isTripped).toBe(false);
  });
});
