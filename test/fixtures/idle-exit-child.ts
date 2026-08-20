/**
 * @packageDocumentation
 * Child fixture for M1 => connect, then do nothing at all.
 *
 * The collector's flush interval is the only thing that could still be holding the event loop open
 * here, so if this process ever exits on its own the timer is unref'd. Deliberately no `close()` =>
 * that's the foot-gun being tested ("why won't my script exit?").
 *
 * Usage: `node --import tsx test/fixtures/idle-exit-child.ts <dataDir>`
 */

import { createDAL } from '../../src/database/index.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: idle-exit-child.ts <dataDir>');

const db = createDAL();
await db.connect({ db: { mode: 'local', dataDir: dir }, collector: { time: 3_000 } });

// buffered on purpose => the natural exit still has to put it on disk (beforeExit, see #5)
await db.schema('antinuke').table('settings').key('guild-1').set({ strict: true });

console.log('ready');
