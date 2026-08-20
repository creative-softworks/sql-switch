/**
 * @packageDocumentation
 * Test helper => hermetic local mode DALs in a throwaway temp dir.
 *
 * Everything here registers its own cleanup through vitest's `onTestFinished`, so a test just
 * calls {@link localdal} & never has to remember to close a handle or rm a directory. No
 * `DATABASE_URL`, no shared state between files => these always run.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { createDAL } from '../../src/database/index.js';
import type { DAL } from '../../src/database/index.js';
import type { CollectorConfig } from '../../src/database/types.js';

/** A fresh throwaway directory, removed once the current test finishes. */
export function tempdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlswitch-'));
  onTestFinished(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** What {@link localdal} hands back => a connected DAL plus the dir its `.db` files live in. */
export interface LocalDal {
  db: DAL;
  dir: string;
}

/**
 * A connected local mode DAL pointed at a throwaway dir.
 *
 * Closed & wiped when the test finishes, so leaving writes buffered at the end of a test is
 * fine. Pass collector settings to override the defaults (a long `time` is the usual trick =>
 * nothing flushes unless the test asks for it).
 */
export async function localdal(collector?: CollectorConfig): Promise<LocalDal> {
  const dir = tempdir();
  const db = createDAL();
  await db.connect({
    db: { mode: 'local', dataDir: dir, wal: true },
    ...(collector ? { collector } : {}),
  });

  onTestFinished(async () => {
    // may already be closed by the test itself => close() is idempotent
    await db.close().catch(() => undefined);
  });

  return { db, dir };
}

/**
 * Open a second DAL on an existing dir with the collector off.
 *
 * The durability tests all follow the same shape => write, `close()` (which flushes), then read
 * the files back through a fresh connection to prove what actually hit disk rather than what was
 * still sitting in RAM.
 */
export async function reopen(dir: string): Promise<DAL> {
  const db = createDAL();
  await db.connect({ db: { mode: 'local', dataDir: dir }, collector: { enabled: false } });

  onTestFinished(async () => {
    await db.close().catch(() => undefined);
  });

  return db;
}
