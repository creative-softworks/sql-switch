/**
 * @packageDocumentation
 * Which local data directories a driver currently has open, in this process.
 *
 * Sounds like bookkeeping for its own sake, but it's the only quiescence signal a migration can
 * actually trust (E1). An upward swap reads the `.db` files and then deletes them, and a DAL that's
 * still connected can be holding writes the migration never saw => they were in the collector's RAM
 * buffer, not in the file. File level checks can't see that: an idle SQLite connection holds no
 * lock, so the file looks exactly like a quiesced one.
 *
 * A `SqliteDriver` therefore registers its data directory for as long as it exists, from
 * `connect()` to `close()`, whether or not it has opened a single file yet (a buffered write doesn't
 * need an open file to exist). `db.swapEngine()` closes first, so it always sees a clear directory.
 *
 * @remarks
 * In process only => another process (the app, while you run the CLI) can't be seen from here, and
 * nothing portable can. That's a documented limit of the check, not a bug in it: stop the app before
 * migrating a directory it owns.
 */

import path from 'node:path';

/** resolved dir => how many drivers currently have it open (two DALs on one dir both count) */
const opendirs = new Map<string, number>();

// resolved dir => cumulative count of every registerLocalDir call for it, ever. only ever climbs,
// never decremented on release => this is what lets a migration tell "a DAL opened this dir at some
// point during my run" apart from "one happens to be open right now". a DAL that connects & closes
// again inside the migration window is invisible to opendirs by the time we check (refcount back to
// 0), but it may have flushed buffered writes we never read => the generation still shows it touched
const opencounts = new Map<string, number>();

/** the one spelling everything is compared on => `./data` and `data/.` are the same directory */
function normalize(dataDir: string): string {
  return path.resolve(dataDir);
}

/**
 * Note that a driver has this directory open.
 *
 * @param dataDir - The directory holding the `.db` files. Resolved to an absolute path.
 * @internal
 */
export function registerLocalDir(dataDir: string): void {
  const key = normalize(dataDir);
  opendirs.set(key, (opendirs.get(key) ?? 0) + 1);
  opencounts.set(key, (opencounts.get(key) ?? 0) + 1);
}

/**
 * Give the directory back. Called from `SqliteDriver.close()`.
 *
 * @param dataDir - The same directory that was registered.
 * @internal
 */
export function releaseLocalDir(dataDir: string): void {
  const key = normalize(dataDir);
  const open = opendirs.get(key);
  if (open === undefined) return;

  // drop the entry rather than leave a 0 behind => openLocalDirs() only ever lists live ones
  if (open <= 1) opendirs.delete(key);
  else opendirs.set(key, open - 1);
}

/**
 * True while any driver in this process has that directory open.
 *
 * @param dataDir - Directory to check.
 * @internal
 */
export function localDirOpen(dataDir: string): boolean {
  return opendirs.has(normalize(dataDir));
}

/**
 * How many times this directory has *ever* been opened in this process, cumulative.
 *
 * Monotonic => it climbs on every {@link registerLocalDir} & never falls, so it can't be fooled by
 * a driver that opened & closed again inside a window. A migration captures this at the start of a
 * run and compares it at deletion time: a higher number means a DAL touched the directory while the
 * run was in flight, so the local files might hold writes the migration never saw (E1). See
 * {@link localDirOpen} for the point-in-time "open right now" check.
 *
 * @param dataDir - Directory to check.
 * @internal
 */
export function localDirGeneration(dataDir: string): number {
  return opencounts.get(normalize(dataDir)) ?? 0;
}

/**
 * Every directory currently held open, absolute. Handy in an error message.
 * @internal
 */
export function openLocalDirs(): string[] {
  return Array.from(opendirs.keys());
}
