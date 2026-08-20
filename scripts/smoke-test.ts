/**
 * @packageDocumentation
 * Local smoke test => exercises the fluent API end to end against real SQLite files.
 *
 * Not a unit test suite, just a fast sanity check that the wiring actually works:
 * connect, set, get, collector batching, `.force()`, delete, name validation, the
 * serialization guard, failed flush retries & shutdown.
 *
 * ```bash
 * npx tsx scripts/smoke-test.ts
 * ```
 */

import fs from 'node:fs';
import { createDAL, InvalidNameError } from '../src/database/index.js';
import { WriteCollector, resolveCollectorConfig } from '../src/database/utils/collector.js';
import type { DatabaseDriver } from '../src/database/types.js';

const TEST_DIR = './data/smoke-test';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`, detail !== undefined ? detail : '');
  }
}

async function main(): Promise<void> {
  // clean slate so reruns don't read stale rows
  fs.rmSync(TEST_DIR, { recursive: true, force: true });

  console.log('\n[1] connect + immediate write via .force()');
  const db = createDAL();
  await db.connect({
    db: { mode: 'local', dataDir: TEST_DIR, wal: true },
    collector: { enabled: true, time: 300 },
  });

  await db.schema('antinuke').table('settings').key('guild_1').set({ strict: true }).force();
  const forced = await db.schema('antinuke').table('settings').key('guild_1').get();
  check('.force() write is readable immediately', JSON.stringify(forced) === '{"strict":true}', forced);

  console.log('\n[2] queued write goes through the collector');
  await db.schema('antinuke').table('settings').key('guild_2').set({ strict: false });
  check('queued write is buffered, not yet flushed', db.pendingWrites === 1, db.pendingWrites);

  console.log('\n[3] same-key writes collapse (action queue dedup)');
  await db.schema('economy').table('balances').key('user_1').set({ coins: 1 });
  await db.schema('economy').table('balances').key('user_1').set({ coins: 2 });
  await db.schema('economy').table('balances').key('user_1').set({ coins: 3 });
  check('3 writes to one key => 1 buffered entry (+1 from step 2)', db.pendingWrites === 2, db.pendingWrites);

  console.log('\n[4] collector flushes on interval');
  await new Promise((r) => setTimeout(r, 600));
  check('buffer drained after flush interval', db.pendingWrites === 0, db.pendingWrites);

  const flushed = await db.schema('antinuke').table('settings').key('guild_2').get();
  check('queued value persisted', JSON.stringify(flushed) === '{"strict":false}', flushed);

  const collapsed = await db.schema('economy').table('balances').key('user_1').get<{ coins: number }>();
  check('collapsed write kept the LAST value', collapsed?.coins === 3, collapsed);

  console.log('\n[5] schema isolation => separate .db files');
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.db')).sort();
  check('one file per schema', files.join(',') === 'antinuke.db,economy.db', files);

  console.log('\n[6] missing key returns null');
  const missing = await db.schema('antinuke').table('settings').key('nope').get();
  check('unknown key => null', missing === null, missing);

  console.log('\n[7] delete');
  await db.schema('antinuke').table('settings').key('guild_1').delete();
  const deleted = await db.schema('antinuke').table('settings').key('guild_1').get();
  check('deleted key => null', deleted === null, deleted);
  check('delete never goes through the collector', db.pendingWrites === 0, db.pendingWrites);

  console.log('\n[8] name validation');
  const bad = ['has space', 'has.dot', 'drop;table', ''];
  for (const name of bad) {
    let threw = false;
    try {
      db.schema(name).table('settings');
    } catch (err) {
      threw = err instanceof InvalidNameError;
    }
    check(`rejects schema name ${JSON.stringify(name)}`, threw);
  }
  let validOk = true;
  try {
    // underscores are addressable now (#13) alongside letters, numbers & hyphens
    db.schema('anti_nuke-2').table('settings_v2');
  } catch {
    validOk = false;
  }
  check('accepts letters/numbers/hyphens/underscores', validOk);

  console.log('\n[9] graceful close flushes pending writes');
  await db.schema('economy').table('balances').key('user_9').set({ coins: 99 });
  await db.close();

  const db2 = createDAL();
  await db2.connect({ db: { mode: 'local', dataDir: TEST_DIR }, collector: { enabled: false } });
  const survived = await db2.schema('economy').table('balances').key('user_9').get<{ coins: number }>();
  check('pending write survived close()', survived?.coins === 99, survived);

  console.log('\n[10] collector disabled => writes go direct');
  await db2.schema('economy').table('balances').key('user_10').set({ coins: 10 });
  check('no buffering when disabled', db2.pendingWrites === 0, db2.pendingWrites);
  const direct = await db2.schema('economy').table('balances').key('user_10').get<{ coins: number }>();
  check('direct write readable right away', direct?.coins === 10, direct);

  await db2.close();

  console.log('\n[11] unserializable values are rejected at the call site');
  const db3 = createDAL();
  await db3.connect({ db: { mode: 'local', dataDir: TEST_DIR }, collector: { enabled: false } });

  // circular => JSON.stringify would throw later, inside a flush where nobody sees it
  const circular: Record<string, unknown> = { name: 'loop' };
  circular.self = circular;
  let circularThrew = false;
  try {
    db3.schema('antinuke').table('settings').key('bad_1').set(circular);
  } catch (err) {
    circularThrew = err instanceof TypeError;
  }
  check('circular reference => TypeError', circularThrew);

  let bigintThrew = false;
  try {
    db3.schema('antinuke').table('settings').key('bad_2').set({ id: 1n });
  } catch (err) {
    bigintThrew = err instanceof TypeError;
  }
  check('BigInt value => TypeError', bigintThrew);

  const notWritten = await db3.schema('antinuke').table('settings').key('bad_1').get();
  check('rejected write never reached the db', notWritten === null, notWritten);

  await db3.close();

  console.log('\n[12] failed flush groups are retried, not dropped');
  console.log('      (one "flush error" log below is expected)');
  let attempts = 0;
  const flaky: DatabaseDriver = {
    async get() {
      return null;
    },
    async exists() {
      return false;
    },
    async set() {},
    async batchSet() {
      attempts++;
      // fail the first attempt only => simulates a brief outage
      if (attempts === 1) throw new Error('simulated outage');
    },
    async delete() {},
    // eslint not wired up, but keep this honest => scan yields nothing, count is zero
    async *scan() {},
    async count() {
      return 0;
    },
    async close() {},
  };

  // long interval => only the manual flush() calls below actually run
  const collector = new WriteCollector(flaky, resolveCollectorConfig({ enabled: true, time: 5000 }));
  collector.queue('antinuke', 'settings', 'guild_x', { strict: true });
  await collector.flush();
  check('failed group went back in the buffer', collector.pendingCount === 1, collector.pendingCount);
  check('collector did not trip on a single failure', collector.isTripped === false);

  await collector.flush();
  check('retry drained the buffer', collector.pendingCount === 0, collector.pendingCount);
  check('driver saw exactly 2 batchSet calls', attempts === 2, attempts);
  await collector.stop();

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('='.repeat(46));

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
