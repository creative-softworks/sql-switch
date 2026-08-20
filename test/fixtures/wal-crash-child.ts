/**
 * @packageDocumentation
 * Child fixture for ES#6 => leave a WAL database mid crash so the parent can prove a readonly open
 * still sees the committed but uncheckpointed frames.
 *
 * The up swap opens each source file with `new Database(path, { readonly: true })`. If a real app
 * died between a commit & a checkpoint, those rows live only in the `-wal` sidecar => a readonly
 * open that couldn't see them would migrate a truncated table & then delete the source. This is the
 * faithful version of that crash: commit N rows with autocheckpoint off, say `ready`, then
 * `process.exit(0)` WITHOUT close() => no checkpoint runs, the frames stay stranded in the `-wal`.
 *
 * Usage: `node --import tsx test/fixtures/wal-crash-child.ts <dbPath> <rows>`
 */

import Database from 'better-sqlite3';

const dbPath = process.argv[2];
const rows = Number(process.argv[3]);
if (!dbPath || !Number.isInteger(rows)) {
  throw new Error('usage: wal-crash-child.ts <dbPath> <rows>');
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
// no autocheckpoint => the commit below leaves its frames in the -wal instead of folding them into
// the main file, which is exactly the crash-before-checkpoint state ES#6 is about
db.pragma('wal_autocheckpoint = 0');
db.exec('CREATE TABLE IF NOT EXISTS "rows" (id TEXT PRIMARY KEY, value TEXT NOT NULL)');

const insert = db.prepare('INSERT OR REPLACE INTO "rows" (id, value) VALUES (?, ?)');
const many = db.transaction((n: number) => {
  for (let i = 0; i < n; i++) insert.run(`key-${i}`, JSON.stringify({ i }));
});
many(rows);

console.log('ready');

// hard exit => no close(), no checkpoint. the whole point is to NOT fold the -wal into the main db,
// so the parent's readonly open has to replay the tail to see these rows
process.exit(0);
