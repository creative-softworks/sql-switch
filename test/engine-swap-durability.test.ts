/**
 * @packageDocumentation
 * #10/E3 + #6/E4 + E1 + E2/E5 + E6 => the migration has to survive being interrupted, sharing a
 * database with other apps, and being pointed at a source that's still live.
 *
 * The down swap was already the reference implementation here (temp file + atomic rename, keyset
 * pagination for flat memory). These tests hold the up swap to the same standard:
 *
 * - **#10/E3** it streams. `.all()` realised a whole table before chunking the *write* side, so a
 *   multi million row table was an OOM waiting to happen. {@link chunked} is the proof: the source
 *   is a lazy generator & the test asserts how many rows it produced.
 * - **#6/E4** a name it can't address is skipped & reported, not thrown on. Aborting halfway is a
 *   durability bug, not an ergonomics one => it can leave `.db` files already renamed into place.
 * - **E1** local files are the only copy of the data. They're never deleted while a DAL in this
 *   process still has that directory open, because writes sitting in a collector buffer are
 *   invisible to a migration reading the file.
 * - **E2/E5** a run that dies between two tables leaves a journal, so the resume is deterministic
 *   (skip what landed, redo what didn't) instead of leaning on `onConflict: 'skip'` and ending up
 *   with a table in both engines.
 * - **E6** a signal mid migration stops it at a table boundary & hands the signal back, the same
 *   rule the collector follows (#5/#9).
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  JOURNAL_FILE,
  chunked,
  dropjournal,
  engineSwap,
  readjournal,
  savejournal,
} from '../src/database/engine-swap.js';
import type { SwapJournal } from '../src/database/engine-swap.js';
import { localDirOpen, registerLocalDir, releaseLocalDir } from '../src/database/utils/handles.js';
import { createDAL } from '../src/database/index.js';
import { tempdir } from './helpers/tempdal.js';
import { runfixture } from './helpers/child.js';

const url = process.env.DATABASE_URL;

/** nothing listens here => a code path that reaches this would fail loudly instead of passing */
const NOWHERE = 'postgres://swap:test@127.0.0.1:1/none';

const noop = (): void => undefined;

/**
 * Write a `.db` file straight through better-sqlite3, bypassing the fluent API.
 *
 * Deliberate => the interesting fixtures are the ones the DAL would refuse to create in the first
 * place (a table called `bad.name`, a file called `my.app.db` => a dot is not addressable), which
 * is exactly the shape a database shared with another app has.
 */
function seedsqlite(dir: string, schema: string, tables: Record<string, number>): void {
  const db = new Database(path.join(dir, `${schema}.db`));
  try {
    for (const [table, rows] of Object.entries(tables)) {
      db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      const insert = db.prepare(`INSERT OR REPLACE INTO "${table}" (id, value) VALUES (?, ?)`);
      const many = db.transaction((n: number) => {
        for (let i = 0; i < n; i++) insert.run(`key-${i}`, JSON.stringify({ i, table }));
      });
      many(rows);
    }
  } finally {
    db.close();
  }
}

/**
 * Drop a table another app owns into a `.db` => addressable name, but the columns aren't `id +
 * value`, so it isn't ours.
 *
 * This is the case a foreign *name* can't cover (#6/E4 caught `bad.name`, a dot): a name that looks
 * exactly like one of ours sitting next to a completely different schema. `SELECT id, value` off it
 * throws, which used to take the whole run down => the shape gate (ES#4) has to skip it the same way
 * a foreign name is skipped.
 */
function seedforeigntable(dir: string, schema: string, table: string): void {
  const db = new Database(path.join(dir, `${schema}.db`));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (foo TEXT PRIMARY KEY, bar INTEGER NOT NULL)`);
    db.prepare(`INSERT OR REPLACE INTO "${table}" (foo, bar) VALUES (?, ?)`).run('x', 1);
  } finally {
    db.close();
  }
}

/** a pool that drops the throwaway schemas it was told about when the test finishes */
function pgpool(schemas: string[]): pg.Pool {
  const pool = new pg.Pool({ connectionString: url! });
  pool.on('error', () => undefined);
  onTestFinished(async () => {
    for (const schema of schemas) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await pool.end();
  });
  return pool;
}

async function rowcount(pool: pg.Pool, schema: string, table: string): Promise<number> {
  const res = await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."${table}"`);
  return (res.rows[0] as { n: number }).n;
}

/**
 * Stand in for the host app's own signal handler.
 *
 * Same trick as the exit flush tests => it keeps the swap from re-raising the signal, which would
 * take the vitest worker down with it rather than just this test.
 */
function appListener(signal: NodeJS.Signals): () => void {
  process.on(signal, noop);
  return () => process.off(signal, noop);
}

describe('streaming the read side (#10 / E3)', () => {
  it('never pulls more than one chunk out of the source', () => {
    let produced = 0;
    function* source(): Generator<number> {
      // a million rows nobody has room for => materialising this is the bug being tested
      for (let i = 0; i < 1_000_000; i++) {
        produced++;
        yield i;
      }
    }

    const batches = chunked(source(), 500);

    expect(batches.next().value).toHaveLength(500);
    expect(produced).toBe(500);
    expect((batches.next().value as number[])[0]).toBe(500);
    expect(produced).toBe(1000);

    batches.return(undefined);
  });

  it('yields the remainder & nothing at all for an empty source', () => {
    expect(Array.from(chunked([1, 2, 3, 4, 5], 2))).toEqual([[1, 2], [3, 4], [5]]);
    expect(Array.from(chunked([], 2))).toEqual([]);
  });

  it('hands an early stop down to the source', () => {
    let closed = false;
    function* source(): Generator<number> {
      try {
        for (let i = 0; i < 10; i++) yield i;
      } finally {
        closed = true;
      }
    }

    for (const chunk of chunked(source(), 2)) {
      expect(chunk).toHaveLength(2);
      // better-sqlite3 won't close a database with a live iterator on it => the break has to reach
      // through the generator or the migration wedges on `sqlite.close()`
      break;
    }

    expect(closed).toBe(true);
  });
});

describe('the resume journal (E2 / E5)', () => {
  it('reads back what it saved & refuses to resume the other direction from it', () => {
    const dir = tempdir();

    expect(readjournal(dir, 'up', noop).done).toEqual({});

    const journal = readjournal(dir, 'up', noop);
    journal.done['antinuke.settings'] = { rows: 3, at: new Date().toISOString() };
    savejournal(dir, journal, noop);

    expect(readjournal(dir, 'up', noop).done['antinuke.settings']?.rows).toBe(3);
    // an up journal says nothing about which files a down swap already wrote
    expect(readjournal(dir, 'down', noop).done).toEqual({});

    dropjournal(dir, noop);
    expect(fs.existsSync(path.join(dir, JOURNAL_FILE))).toBe(false);
  });

  it('tolerates a truncated journal instead of failing the migration', () => {
    const dir = tempdir();
    // half a write from a process that died mid journal => start fresh, don't refuse to migrate
    fs.writeFileSync(path.join(dir, JOURNAL_FILE), '{"version":1,"direct');

    expect(readjournal(dir, 'up', noop).done).toEqual({});
  });

  it('drops a truthy-but-malformed entry so its unit is redone, not skipped (ES#5)', () => {
    const dir = tempdir();
    // valid JSON, valid `done` container, but the entries themselves are garbage. the dangerous
    // shape is the *truthy* one => the swap reads it as "already migrated", skips the unit & then
    // deletes its local file without ever moving the data. only the well-formed entry may survive
    fs.writeFileSync(
      path.join(dir, JOURNAL_FILE),
      JSON.stringify({
        version: 1,
        direction: 'up',
        done: {
          'antinuke.settings': 7, // a bare number, no rows/at
          'antinuke.mutes': { at: '2026-08-20T00:00:00.000Z' }, // missing rows
          'antinuke.bad': { rows: 'lots', at: '2026-08-20T00:00:00.000Z' }, // rows isn't a number
          'economy.balances': { rows: 3, at: '2026-08-20T00:00:00.000Z' }, // the one good entry
        },
      }),
    );

    const lines: string[] = [];
    const journal = readjournal(dir, 'up', (line) => lines.push(line));

    expect(Object.keys(journal.done)).toEqual(['economy.balances']);
    expect(journal.done['economy.balances']?.rows).toBe(3);
    // the three garbage entries are dropped => their units get redone next run, the safe way
    expect(lines.some((l) => l.includes('malformed'))).toBe(true);
  });
});

describe('quiescence of the source (E1)', () => {
  it('sees a live local handle on a dir & lets go of it on close', async () => {
    const dir = tempdir();
    const other = tempdir();

    expect(localDirOpen(dir)).toBe(false);

    const db = createDAL();
    await db.connect({ db: { mode: 'local', dataDir: dir } });

    expect(localDirOpen(dir)).toBe(true);
    // same directory spelled differently is still the same directory
    expect(localDirOpen(path.join(dir, '.'))).toBe(true);
    expect(localDirOpen(other)).toBe(false);

    await db.close();
    expect(localDirOpen(dir)).toBe(false);
  });
});

describe('foreign names (#6 / E4)', () => {
  it('skips a file it could never address, without touching the database', async () => {
    const dir = tempdir();
    seedsqlite(dir, 'my.app', { settings: 1 });

    const lines: string[] = [];
    const result = await engineSwap({
      direction: 'up',
      dataDir: dir,
      connectionString: NOWHERE,
      onProgress: (line) => lines.push(line),
    });

    // nothing conforming to migrate => no query is ever sent, which is why this needs no database
    expect(result.skippedNames).toEqual(['my.app']);
    expect(result.totalRows).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fs.existsSync(path.join(dir, 'my.app.db'))).toBe(true);
    expect(lines.some((line) => line.includes('my.app'))).toBe(true);
  });
});

describe('a readonly read sees committed WAL frames after a crash (ES#6)', () => {
  it('replays the uncheckpointed -wal tail the same way the up swap opens each source', async () => {
    const dir = tempdir();
    const dbPath = path.join(dir, 'antinuke.db');
    const ROWS = 200;

    // a child commits ROWS rows with autocheckpoint off, then hard-exits without close() => the
    // frames are stranded in the -wal, exactly like a process that died between commit & checkpoint
    const exit = await runfixture('wal-crash-child.ts', [dbPath, String(ROWS)]);
    expect(exit.code).toBe(0);
    expect(exit.selfexit).toBe(true);

    // the scenario is only real if those frames genuinely never reached the main file => the -wal
    // has to still be sitting there with content. an already-checkpointed file would pass this test
    // trivially & prove nothing about the readonly replay
    const walPath = `${dbPath}-wal`;
    expect(fs.existsSync(walPath)).toBe(true);
    expect(fs.statSync(walPath).size).toBeGreaterThan(0);

    // open exactly as swapUp does => readonly + safe integers. on a writable dir (the migration
    // always has one) this open replays the -wal tail, so every committed row is visible. if it
    // couldn't, the up swap would migrate a truncated table & then delete the source file
    const ro = new Database(dbPath, { readonly: true });
    try {
      ro.defaultSafeIntegers(true);
      const count = ro.prepare('SELECT count(*) AS n FROM "rows"').get() as { n: bigint };
      expect(Number(count.n)).toBe(ROWS);
      // spot check the very last committed row, not just the count => the tail of the -wal read back
      const last = ro.prepare('SELECT value FROM "rows" WHERE id = ?').get(`key-${ROWS - 1}`) as
        | { value: string }
        | undefined;
      expect(last?.value).toBe(JSON.stringify({ i: ROWS - 1 }));
    } finally {
      ro.close();
    }
  });
});

describe.skipIf(!url)('the up swap against a real database', () => {
  it('keeps local files while a DAL in this process still has the dir open (E1)', async () => {
    const schema = 'swaptest-quiesce';
    const dir = tempdir();
    const dbfile = path.join(dir, `${schema}.db`);
    pgpool([schema]);

    const db = createDAL();
    await db.connect({ db: { mode: 'local', dataDir: dir }, collector: { enabled: false } });
    await db.schema(schema).table('settings').key('guild-1').set({ strict: true }).force();

    const lines: string[] = [];
    const kept = await engineSwap({
      direction: 'up',
      dataDir: dir,
      connectionString: url!,
      onConflict: 'overwrite',
      onProgress: (line) => lines.push(line),
    });

    expect(kept.totalRows).toBe(1);
    // the rows landed, but the file is the only copy of anything still buffered => it stays
    expect(kept.deletedFiles).toEqual([]);
    expect(fs.existsSync(dbfile)).toBe(true);
    expect(lines.some((line) => line.includes('not quiesced'))).toBe(true);

    await db.close();

    const swept = await engineSwap({
      direction: 'up',
      dataDir: dir,
      connectionString: url!,
      onConflict: 'overwrite',
    });

    expect(swept.deletedFiles).toHaveLength(1);
    expect(fs.existsSync(dbfile)).toBe(false);
  });

  it('keeps files when a DAL opened & closed the dir mid-run (ES#3, generation)', async () => {
    // the gap the point-in-time check missed: a DAL connects while the copy is in flight & closes
    // again before the deletion gate. localDirOpen() reads clear at both the start & the end, so the
    // old code deleted the file => but that DAL could have flushed buffered writes onto it after we
    // read it. register/release are exactly what a real SqliteDriver connect/close call, so driving
    // them straight is a faithful (and deterministic) stand-in for that concurrent DAL
    const schema = 'swaptest-genrace';
    const dir = tempdir();
    const dbfile = path.join(dir, `${schema}.db`);
    pgpool([schema]);

    seedsqlite(dir, schema, { settings: 3 });

    let injected = false;
    const lines: string[] = [];
    const result = await engineSwap({
      direction: 'up',
      dataDir: dir,
      connectionString: url!,
      onConflict: 'overwrite',
      onProgress: (line) => {
        lines.push(line);
        if (line.includes(`${schema}.settings =>`) && !injected) {
          injected = true;
          registerLocalDir(dir); // a DAL connects mid-run...
          releaseLocalDir(dir); // ...and closes again before we reach the deletion gate
        }
      },
    });

    expect(injected).toBe(true);
    expect(result.totalRows).toBe(3); // the rows still made it to Postgres
    expect(localDirOpen(dir)).toBe(false); // and nothing is open by the end
    // ...but a DAL touched the dir mid-run, so the file is the only place its writes might live
    expect(result.deletedFiles).toEqual([]);
    expect(fs.existsSync(dbfile)).toBe(true);
    expect(lines.some((l) => l.includes('not quiesced'))).toBe(true);
  });

  it('keeps files when the dir was open at the start, even if closed by the end (ES#3, openAtStart)', async () => {
    // the other half: a DAL that was already open when the run began but closes partway through. by
    // the deletion gate the refcount is back to 0 & the generation never moved (it registered before
    // the run captured genAtStart), so only the openAtStart snapshot catches it
    const schema = 'swaptest-openstart';
    const dir = tempdir();
    const dbfile = path.join(dir, `${schema}.db`);
    pgpool([schema]);

    seedsqlite(dir, schema, { settings: 3 });

    registerLocalDir(dir); // a DAL is already open as the swap starts => openAtStart is true
    let injected = false;
    const result = await engineSwap({
      direction: 'up',
      dataDir: dir,
      connectionString: url!,
      onConflict: 'overwrite',
      onProgress: (line) => {
        if (line.includes(`${schema}.settings =>`) && !injected) {
          injected = true;
          releaseLocalDir(dir); // it closes mid-run => refcount back to 0, generation unchanged
        }
      },
    });

    expect(injected).toBe(true);
    expect(localDirOpen(dir)).toBe(false); // clear by the end...
    expect(result.deletedFiles).toEqual([]); // ...but it was dirty at the start, so keep the file
    expect(fs.existsSync(dbfile)).toBe(true);
  });

  it('skips foreign names & keeps the file they were left in (#6 / E4)', async () => {
    const schema = 'swaptest-foreign';
    const dir = tempdir();
    pgpool([schema]);

    seedsqlite(dir, schema, { settings: 3, 'bad.name': 2 });
    seedsqlite(dir, 'my.app', { settings: 1 });

    const result = await engineSwap({
      direction: 'up',
      dataDir: dir,
      connectionString: url!,
      onConflict: 'overwrite',
    });

    // the conforming table moves, the rest is left exactly where it was
    expect(result.totalRows).toBe(3);
    expect(result.tables.map((t) => `${t.schema}.${t.table}`)).toEqual([`${schema}.settings`]);
    expect(result.skippedNames.sort()).toEqual(['my.app', `${schema}.bad.name`].sort());
    expect(result.deletedFiles).toEqual([]);
    expect(fs.existsSync(path.join(dir, `${schema}.db`))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'my.app.db'))).toBe(true);
  });

  it('skips a foreign-shaped table in a file we own & keeps the file (ES#4)', async () => {
    const schema = 'swaptest-upshape';
    const dir = tempdir();
    const pool = pgpool([schema]);

    // one file, two tables => ours (id + value) and another app's (foo + bar). the name `legacy` is
    // perfectly addressable, so only the shape gate can tell it apart from one of ours
    seedsqlite(dir, schema, { settings: 3 });
    seedforeigntable(dir, schema, 'legacy');

    const lines: string[] = [];
    const result = await engineSwap({
      direction: 'up',
      dataDir: dir,
      connectionString: url!,
      onConflict: 'overwrite',
      onProgress: (line) => lines.push(line),
    });

    // the DAL table moves, the foreign-shaped one is skipped instead of crashing `SELECT id, value`
    expect(result.totalRows).toBe(3);
    expect(result.tables.map((t) => `${t.schema}.${t.table}`)).toEqual([`${schema}.settings`]);
    expect(result.skippedNames).toContain(`${schema}.legacy`);
    expect(lines.some((l) => l.includes('legacy') && l.includes('not a sql-switch table'))).toBe(
      true,
    );
    // a skipped table means the file still holds data postgres doesn't => it stays
    expect(result.deletedFiles).toEqual([]);
    expect(fs.existsSync(path.join(dir, `${schema}.db`))).toBe(true);
    expect(await rowcount(pool, schema, 'settings')).toBe(3);
  });

  it('moves a table bigger than one chunk without realising it (#10 / E3, G3)', async () => {
    const schema = 'swaptest-stream';
    const dir = tempdir();
    const pool = pgpool([schema]);

    seedsqlite(dir, schema, { rows: 1200 });

    const result = await engineSwap({
      direction: 'up',
      dataDir: dir,
      connectionString: url!,
      onConflict: 'overwrite',
    });

    expect(result.totalRows).toBe(1200);
    expect(await rowcount(pool, schema, 'rows')).toBe(1200);
    // the chunk boundaries are where an incremental batcher drops or repeats a row
    for (const id of ['key-0', 'key-499', 'key-500', 'key-999', 'key-1199']) {
      const res = await pool.query(`SELECT value FROM "${schema}"."rows" WHERE id = $1`, [id]);
      expect(res.rows).toHaveLength(1);
    }
  });
});

describe.skipIf(!url)('a swap interrupted by a signal (E6 + E2 / E5)', () => {
  it('stops at a table boundary, journals what landed & resumes deterministically', async () => {
    const schema = 'swaptest-abort';
    const dir = tempdir();
    const dbfile = path.join(dir, `${schema}.db`);
    const pool = pgpool([schema]);

    seedsqlite(dir, schema, { alpha: 3, beta: 3 });

    const release = appListener('SIGTERM');
    let first!: Awaited<ReturnType<typeof engineSwap>>;
    try {
      first = await engineSwap({
        direction: 'up',
        dataDir: dir,
        connectionString: url!,
        onConflict: 'overwrite',
        onProgress: (line) => {
          // a container stop landing between two tables => the exact window E2 is about
          if (line.startsWith(`${schema}.alpha =>`)) process.emit('SIGTERM', 'SIGTERM');
        },
      });
    } finally {
      release();
    }

    expect(first.aborted).toBe(true);
    expect(first.tables.map((t) => t.table)).toEqual(['alpha']);
    // nothing is deleted on the way out => the journal is what makes the next run cheap, not safe
    expect(first.deletedFiles).toEqual([]);
    expect(fs.existsSync(dbfile)).toBe(true);

    const journal = JSON.parse(
      fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8'),
    ) as SwapJournal;
    expect(Object.keys(journal.done)).toEqual([`${schema}.alpha`]);

    // resume on the default 'skip' handler => alpha is skipped because the journal says so, not
    // because its target happens to have rows in it
    const second = await engineSwap({
      direction: 'up',
      dataDir: dir,
      connectionString: url!,
    });

    expect(second.aborted).toBe(false);
    expect(second.tables.find((t) => t.table === 'alpha')).toMatchObject({
      rows: 0,
      skipped: true,
      reason: 'resumed',
    });
    expect(second.totalRows).toBe(3);
    // every table is accounted for now, so the file finally goes & the journal with it
    expect(second.deletedFiles).toHaveLength(1);
    expect(fs.existsSync(dbfile)).toBe(false);
    expect(fs.existsSync(path.join(dir, JOURNAL_FILE))).toBe(false);

    expect(await rowcount(pool, schema, 'alpha')).toBe(3);
    expect(await rowcount(pool, schema, 'beta')).toBe(3);
  });
});
