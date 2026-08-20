/**
 * @packageDocumentation
 * Child fixture for the SIGTERM half of P0 #5 / P1 #9 => a real process, a real signal, a real
 * `.db` file on disk.
 *
 * In-process tests can't check the interesting half (that the library hands the signal back instead
 * of calling `process.exit()` itself), because re-raising a signal inside the test runner would take
 * the runner down with it. So this one queues a write that no interval will ever flush, says
 * `ready`, and waits to be killed. The parent asserts both the exit signal & the row on disk.
 *
 * Usage: `tsx test/fixtures/exit-flush-child.ts <dataDir>`
 */

import { createDAL } from '../../src/database/index.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: exit-flush-child.ts <dataDir>');

const db = createDAL();
// a flush interval far past the test => only the exit path can put this row on disk
await db.connect({ db: { mode: 'local', dataDir: dir }, collector: { time: 600_000 } });
await db.schema('antinuke').table('settings').key('guild-1').set({ strict: true });

console.log('ready');

// keep the loop alive on our own so the only way out is the signal => doesn't rely on the
// collector's interval holding the process up (that timer gets unref'd, see M1)
setInterval(() => undefined, 1_000);
