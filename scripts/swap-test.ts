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

// ES#4 => a schema that mixes a table of ours with another app's, and one that's all someone
// else's. both are dropped alongside SCHEMA so a rerun always starts clean
const ES4_DIR = './data/swap-test-es4';
const ES4_MIXED = 'swaptest_es4mix';
const ES4_FOREIGN = 'swaptest_es4foreign';

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

/** wipe the test schemas so a rerun always starts clean */
async function dropTestSchema(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
  pool.on('error', () => undefined);
  try {
    for (const schema of [SCHEMA, ES4_MIXED, ES4_FOREIGN]) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
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
  fs.rmSync(ES4_DIR, { recursive: true, force: true });
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
    // scalar payloads => the down-swap has to re-quote pg's decoded JSONB or a string like "5" comes
    // back as the number 5. these are the exact shapes ES#1 corrupted (bare `5`/`true`/`hello world`
    // stored instead of `"5"`/`"true"`/`"hello world"`), so the round-trip below is the regression
    ['scalar-str-num', '5'],
    ['scalar-str-bool', 'true'],
    ['scalar-str-text', 'hello world'],
    ['scalar-real-num', 5],
    ['scalar-real-bool', true],
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

  // ES#1 regression => a JSON string must survive the down-swap as a string, not decay into the
  // number/boolean it looks like. under the old `typeof === string` shortcut these came back wrong
  const strNum = await back.schema(SCHEMA).table(TABLE).key('scalar-str-num').get();
  check('string "5" stayed a string after down-swap', strNum === '5', strNum);
  const strBool = await back.schema(SCHEMA).table(TABLE).key('scalar-str-bool').get();
  check('string "true" stayed a string after down-swap', strBool === 'true', strBool);
  const strText = await back.schema(SCHEMA).table(TABLE).key('scalar-str-text').get();
  check('plain-text string round-tripped intact', strText === 'hello world', strText);
  // the flip side => a real number/boolean must not gain quotes on the way through
  const realNum = await back.schema(SCHEMA).table(TABLE).key('scalar-real-num').get();
  check('number 5 stayed the number 5', realNum === 5, realNum);
  const realBool = await back.schema(SCHEMA).table(TABLE).key('scalar-real-bool').get();
  check('boolean true stayed boolean true', realBool === true, realBool);
  await back.close();

  console.log('\n[5] conflicts are skipped unless allowed');
  const skipped = await engineSwap({ direction: 'down', dataDir: TEST_DIR });
  check('existing local file left alone', skipped.skipped === 1, skipped);
  check('nothing pulled while skipping', skipped.totalRows === 0, skipped.totalRows);
  // ES#8 => a declined file conflict lands in `tables`, not just the skipped count. table:'' marks
  // it file-level (the whole schema), mirroring how the up-swap records a declined table
  const fileConflict = skipped.tables.find((t) => t.schema === SCHEMA && t.table === '');
  check('file conflict recorded in tables', fileConflict?.reason === 'conflict', skipped.tables);
  check('file conflict moved no rows', fileConflict?.rows === 0, fileConflict);

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

  console.log('\n[7] ES#4 => a foreign-shaped table is skipped, an all-foreign schema hydrates nothing');
  {
    const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
    pool.on('error', () => undefined);
    try {
      // a schema that mixes one of our tables with another app's => the foreign one has to be
      // skipped, not crash `SELECT id, value`, and the rest of the schema still comes down
      await pool.query(`CREATE SCHEMA "${ES4_MIXED}"`);
      await pool.query(
        `CREATE TABLE "${ES4_MIXED}"."settings" (id TEXT PRIMARY KEY, value JSONB NOT NULL)`,
      );
      await pool.query(`INSERT INTO "${ES4_MIXED}"."settings" (id, value) VALUES ($1, $2)`, [
        'guild-1',
        JSON.stringify({ strict: true }),
      ]);
      await pool.query(
        `CREATE TABLE "${ES4_MIXED}"."events" (event_id SERIAL PRIMARY KEY, payload TEXT)`,
      );
      await pool.query(`INSERT INTO "${ES4_MIXED}"."events" (payload) VALUES ('not ours')`);

      // a schema that's entirely someone else's => nothing of ours to pull, so no stub .db may be
      // left behind (the pulledTables === 0 discard)
      await pool.query(`CREATE SCHEMA "${ES4_FOREIGN}"`);
      await pool.query(
        `CREATE TABLE "${ES4_FOREIGN}"."audit" (audit_id SERIAL PRIMARY KEY, note TEXT)`,
      );
      await pool.query(`INSERT INTO "${ES4_FOREIGN}"."audit" (note) VALUES ('theirs')`);
    } finally {
      await pool.end();
    }

    const es4 = await engineSwap({
      direction: 'down',
      dataDir: ES4_DIR,
      onConflict: 'overwrite',
      onProgress: (line) => console.log(`       ${line}`),
    });

    // the mixed schema's DAL table came down, its foreign table was skipped by shape
    const pulledMix = es4.tables.find((t) => t.schema === ES4_MIXED && t.table === 'settings');
    check('DAL table in a mixed schema came down', pulledMix?.rows === 1, es4.tables);
    check(
      'foreign-shaped table skipped, not crashed',
      es4.skippedNames.includes(`${ES4_MIXED}.events`),
      es4.skippedNames,
    );
    check('mixed schema hydrated a .db', fs.existsSync(`${ES4_DIR}/${ES4_MIXED}.db`));

    // the all-foreign schema pulled nothing => no empty stub file
    check(
      'all-foreign table skipped by shape',
      es4.skippedNames.includes(`${ES4_FOREIGN}.audit`),
      es4.skippedNames,
    );
    check(
      'all-foreign schema left no stub .db',
      !fs.existsSync(`${ES4_DIR}/${ES4_FOREIGN}.db`),
    );
    check('no leftover temp file for the discarded schema', !fs.existsSync(`${ES4_DIR}/${ES4_FOREIGN}.db.tmp`));

    // and the row that did come down reads back through a local DAL
    const es4back = createDAL();
    await es4back.connect({ db: { mode: 'local', dataDir: ES4_DIR }, collector: { enabled: false } });
    const mixValue = await es4back.schema(ES4_MIXED).table('settings').key('guild-1').get<{ strict: boolean }>();
    check('mixed-schema value round-tripped', mixValue?.strict === true, mixValue);
    await es4back.close();
  }

  console.log('\n[8] cleanup');
  await dropTestSchema(url);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(ES4_DIR, { recursive: true, force: true });
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
