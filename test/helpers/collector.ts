/**
 * @packageDocumentation
 * Test helper => build a {@link WriteCollector} on any driver with the real defaults filled in.
 *
 * The collector's constructor takes a fully resolved config on purpose (one home for the
 * defaults), so tests go through the same {@link resolveCollectorConfig} `connect()` uses instead
 * of restating every field & drifting from it.
 */

import { WriteCollector, resolveCollectorConfig } from '../../src/database/utils/collector.js';
import type { CollectorConfig, DatabaseDriver } from '../../src/database/types.js';

/** 9s => long enough that nothing flushes mid test, short of the 10s "too slow" warning */
export const NOFLUSH: CollectorConfig = { enabled: true, time: 9_000 };

/** A collector wired to `driver`, defaults resolved the same way `connect()` resolves them. */
export function testcollector(driver: DatabaseDriver, config: CollectorConfig = NOFLUSH) {
  return new WriteCollector(driver, resolveCollectorConfig(config));
}
