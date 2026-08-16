/**
 * @packageDocumentation
 * Engine swap integration test => exercises the real migration in both directions against a
 * live Postgres, then cleans up after itself.
 *
 * Needs `DATABASE_URL`. Without it the script exits 0 & says it skipped, so it's safe to run
 * anywhere. Everything it touches lives in the dedicated `swaptest` schema (created here,
 * dropped at the end) plus a temp data dir, nothing else in the database is read or written.
 *
 * ```bash
 * npx tsx scripts/swap-test.ts
 * ```
 */

import fs from 'node:fs';
import pg from 'pg';
import { createDAL, engineSwap } from '../src/database/index.js';

const TEST_DIR = './data/swap-test';
const SCHEMA = 'swaptest';
const TABLE = 'rows';

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

/** wipe the test schema so a rerun always starts clean */
async function dropTestSchema(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
  pool.on('error', () => undefined);
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  } finally {
    await pool.end();
  }
}

async function countRows(url: string): Promise<number> {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
  pool.on('error', () => undefined);
  try {
    const res = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."${TABLE}"`);
    return (res.rows[0] as { n: number }).n;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('[swap-test] DATABASE_URL not set => skipped');
    return;
  }

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  await dropTestSchema(url);

  console.log('\n[1] seed local SQLite data');
  const local = createDAL();
  await local.connect({
    db: { mode: 'local', dataDir: TEST_DIR, wal: true },
    collector: { enabled: false },
  });

  // a snowflake shaped key => the whole reason the CLI reads with defaultSafeIntegers(true)
  const seeds: Array<[string, unknown]> = [
    ['1234567890123456789', { strict: true, nested: { list: [1, 2, 3] } }],
    ['guild-2', { strict: false }],
    ['guild-3', { count: 42, label: 'unicode ok => é ü 漢字' }],
  ];
  // push past the 500 row CHUNK_SIZE so the chunking & keyset pagination actually get used
  for (let i = 0; i < 600; i++) {
    seeds.push([`bulk-${i}`, { i }]);
  }
  for (const [key, value] of seeds) {
    await local.schema(SCHEMA).table(TABLE).key(key).set(value).force();
  }
  await local.close();
  check('local .db file written', fs.existsSync(`${TEST_DIR}/${SCHEMA}.db`));

  console.log('\n[2] swap up => SQLite to Postgres');
  const up = await engineSwap({
    direction: 'up',
    dataDir: TEST_DIR,
    onConflict: 'overwrite',
    onProgress: (line) => console.log(`       ${line}`),
  });
  check('every seeded row migrated', up.totalRows === seeds.length, up.totalRows);
  check('one table reported', up.tables.length === 1, up.tables);
  check('nothing skipped', up.skipped === 0, up.skipped);
  check('local file deleted by default', !fs.existsSync(`${TEST_DIR}/${SCHEMA}.db`));
  check('deleted file reported', up.deletedFiles.length === 1, up.deletedFiles);
  check('rows really are in postgres', (await countRows(url)) === seeds.length);
  console.log('\n[3] read the migrated data through the cloud driver');
  const cloud = createDAL();
  await cloud.connect({ db: { mode: 'cloud', connectionString: url }, collector: { enabled: false } });
  const snowflake = await cloud
    .schema(SCHEMA)
    .table(TABLE)
    .key('1234567890123456789')
    .get<{ strict: boolean; nested: { list: number[] } }>();
  check('64-bit key survived the swap', snowflake?.strict === true, snowflake);
  check('nested value survived', snowflake?.nested.list.join(',') === '1,2,3', snowflake);

  const unicode = await cloud.schema(SCHEMA).table(TABLE).key('guild-3').get<{ label: string }>();
  check('unicode payload survived', unicode?.label.includes('漢字') === true, unicode);
  await cloud.close();

  console.log('\n[4] swap down => Postgres to SQLite');
  const down = await engineSwap({
    direction: 'down',
    dataDir: TEST_DIR,
    onConflict: 'overwrite',
    onProgress: (line) => console.log(`       ${line}`),
  });
  const pulled = down.tables.find((t) => t.schema === SCHEMA && t.table === TABLE);
  check('rows pulled back down', pulled?.rows === seeds.length, down.tables);
  check('local file recreated', fs.existsSync(`${TEST_DIR}/${SCHEMA}.db`));
  check('no leftover temp file', !fs.existsSync(`${TEST_DIR}/${SCHEMA}.db.tmp`));

  const back = createDAL();
  await back.connect({ db: { mode: 'local', dataDir: TEST_DIR }, collector: { enabled: false } });
  const roundtrip = await back
    .schema(SCHEMA)
    .table(TABLE)
    .key('1234567890123456789')
    .get<{ nested: { list: number[] } }>();
  check('round trip kept the value intact', roundtrip?.nested.list.join(',') === '1,2,3', roundtrip);

  // chunk boundary rows are where keyset pagination would drop or repeat data
  const boundary = await back.schema(SCHEMA).table(TABLE).key('bulk-499').get<{ i: number }>();
  const afterBoundary = await back.schema(SCHEMA).table(TABLE).key('bulk-500').get<{ i: number }>();
  const lastBulk = await back.schema(SCHEMA).table(TABLE).key('bulk-599').get<{ i: number }>();
  check('row at the chunk boundary came down', boundary?.i === 499, boundary);
  check('row after the chunk boundary came down', afterBoundary?.i === 500, afterBoundary);
  check('last bulk row came down', lastBulk?.i === 599, lastBulk);
  await back.close();

  console.log('\n[5] conflicts are skipped unless allowed');
  const skipped = await engineSwap({ direction: 'down', dataDir: TEST_DIR });
  check('existing local file left alone', skipped.skipped === 1, skipped);
  check('nothing pulled while skipping', skipped.totalRows === 0, skipped.totalRows);

  console.log('\n[6] db.swapEngine() migrates & reconnects in place');
  const hot = createDAL();
  await hot.connect({
    db: { mode: 'local', dataDir: TEST_DIR, wal: true },
    collector: { enabled: true, time: 300 },
  });
  // queued (not forced) => proves swapEngine flushes before touching the files
  await hot.schema(SCHEMA).table(TABLE).key('guild-4').set({ hot: true });
  check('write is still buffered', hot.pendingWrites === 1, hot.pendingWrites);

  const hotResult = await hot.swapEngine({ direction: 'up', onConflict: 'overwrite' });
  check('pending write was flushed before the swap', hotResult.totalRows === seeds.length + 1, hotResult.totalRows);

  // same db object, now talking to postgres
  const afterSwap = await hot.schema(SCHEMA).table(TABLE).key('guild-4').get<{ hot: boolean }>();
  check('dal reconnected on the cloud engine', afterSwap?.hot === true, afterSwap);
  check('collector settings carried over', hot.pendingWrites === 0, hot.pendingWrites);
  await hot.close();

  console.log('\n[7] cleanup');
  await dropTestSchema(url);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  check('test schema dropped', true);

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('='.repeat(46));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('swap test crashed:', err);
  process.exit(1);
});
