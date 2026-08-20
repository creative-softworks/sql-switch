/**
 * @packageDocumentation
 * M1 => the flush interval must not hold the event loop open.
 *
 * A ref'd `setInterval` means any process that connects & then goes idle hangs forever unless it
 * remembers `close()`. That's a library holding an app hostage, and it's the classic "why won't my
 * script exit?" report. Unref'd, node exits when the app is done, and the buffer still lands because
 * `beforeExit` flushes it on the way out (#5).
 */

import { describe, expect, it } from 'vitest';
import { tempdir, reopen } from './helpers/tempdal.js';
import { runfixture } from './helpers/child.js';

describe('idle exit', () => {
  it('lets an idle process exit on its own, buffer & all', async () => {
    const dir = tempdir();

    // nothing kills this one => it has to run out of work by itself
    const exited = await runfixture('idle-exit-child.ts', [dir], { patience: 6_000 });

    expect(exited.selfexit).toBe(true);
    expect(exited.code).toBe(0);

    // exiting isn't allowed to cost the buffered write
    const db = await reopen(dir);
    expect(await db.schema('antinuke').table('settings').key('guild-1').get()).toEqual({
      strict: true,
    });
  });
});
