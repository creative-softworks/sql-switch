/**
 * @packageDocumentation
 * One home for "the process is going away" => which signals count, and how to hand one back.
 *
 * Both the write collector and the engine swap need the same two things: a chance to finish what
 * they were doing before the process dies, and a way to give the signal back afterwards without
 * stealing shutdown from the host app. Keeping the rule in one place is the point => a library that
 * calls `process.exit()` cancels the app's own handlers, its `finally` blocks and any sibling that
 * was still draining (#9), and getting that subtly different in two files is how it creeps back in.
 */

/**
 * Signals a process is normally asked to stop with.
 *
 * @remarks
 * `SIGTERM` matters as much as `SIGINT` => containers stop processes with `SIGTERM`, so anything
 * that only listens for `SIGINT` silently loses whatever it was holding on every deploy.
 * @internal
 */
export const EXIT_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * Re-raise a signal we intercepted, but only if nothing else is listening for it.
 *
 * @param signal - The signal that was caught.
 *
 * @remarks
 * fragile, the order matters => the caller has to take *its own* listener off before calling this,
 * otherwise it just catches its own re-raise. If the app has a handler of its own, that handler is
 * already running & re-raising would run it twice => the app decides how to exit, we only make sure
 * our state is consistent before it does.
 *
 * COL#8: a signal landing at the same moment as an explicit `close()` is a benign race, not a bug.
 * Both paths drain the same buffer, and `flush()` runs one at a time => the second drain just finds
 * an empty buffer, nothing is written twice or lost. Whichever removes our listener first, the
 * re-raise here still fires only when no other listener remains, which is the correct default for a
 * process that was just told to stop: we got the last writes out, then let termination proceed.
 * @internal
 */
export function handback(signal: NodeJS.Signals): void {
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}
