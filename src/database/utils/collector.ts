/**
 * @packageDocumentation
 * Write collector — buffers writes in RAM and flushes to the driver in bulk on each interval.
 *
 * ### How it works
 * - Every `.set()` call queues a pending write using a `schema:table:key` composite key.
 * - If the same key is updated multiple times within a flush window, only the last write
 *   survives (Map key collision = natural dedup). This is the "action queue" behaviour.
 * - Reads go through {@link WriteCollector.peek} first, so a buffered write is visible to the
 *   very next `get()` (read your writes) instead of only after the flush lands.
 * - Any immediate driver write ({@link WriteCollector.evict} + {@link WriteCollector.settle})
 *   pulls that key out of the buffer, so a `.force()` or a `delete()` can't be undone by an
 *   older value flushing on top of it later.
 * - Every N ms (default 3000) `flush()` groups pending writes by schema:table and calls
 *   `driver.batchSet()` for each group inside its own transaction. Flushes are serialized,
 *   so a slow one overlapping the next interval can't land an older value after a newer one.
 * - A group that fails is put back in the buffer & retried on the next flush (newer writes
 *   for the same key win), so a brief outage doesn't silently drop data.
 * - Circuit breaker: if the buffer grows past 5000 keys, new writes are rejected with
 *   {@link DatabaseUnavailableError} and the collector goes read-only. A sustained outage gets
 *   there on its own via the retry path. It heals: after `recoverAfter` ms the next interval lets
 *   one trial flush through (half-open) & closes the breaker if it landed.
 * - Exit flush: `SIGINT`, `SIGTERM` & `beforeExit` all drain the buffer first (`flushOnExit`,
 *   default on). The signal is then re-raised rather than turned into a `process.exit()` => the
 *   host app keeps control of its own shutdown. Hard kills (SIGKILL) still lose up to one flush
 *   interval of writes => acknowledged tradeoff to protect the DB from storms.
 *
 * @example
 * ```ts
 * const collector = new WriteCollector(driver, resolveCollectorConfig({ time: 3000 }));
 * collector.queue('antinuke', 'settings', 'guild_123', { strict: true });
 * await collector.stop(); // flush & clear timer (e.g. on graceful shutdown)
 * ```
 */

import { ConfigurationError, DatabaseUnavailableError } from '../errors.js';
import { EXIT_SIGNALS, handback } from './shutdown.js';
import type { BreakerState, DatabaseDriver, CollectorConfig } from '../types.js';

/**
 * Hard cap on pending writes before the circuit breaker trips.
 *
 * @remarks
 * Sized for the flat two column rows this stores => 5000 buffered keys is a few MB of RAM, small
 * enough to hold through a blip & small enough that going read-only is cheaper than an OOM.
 */
export const MAX_BUFFER = 5000;

/**
 * High-water mark => buffered writes past this fire {@link CollectorHooks.onBackpressure}.
 *
 * @remarks
 * 80% of {@link MAX_BUFFER} => far enough up that the flush is visibly falling behind, with enough
 * headroom left to react before writes start getting rejected at the cap.
 */
export const HIGH_WATER = Math.floor(MAX_BUFFER * 0.8);

/** default collector settings, merged with whatever the caller passes in */
const COLLECTOR_DEFAULTS: Required<CollectorConfig> = {
  enabled: true,
  time: 3000,
  autoRecover: true,
  recoverAfter: 10_000,
  flushOnExit: true,
  hooks: {},
};

/**
 * Fill in the collector defaults & reject values that can't work.
 *
 * Lives here rather than in the facade so the defaults have exactly one home => `connect()`, the
 * tests & anything constructing a {@link WriteCollector} directly all resolve config the same way.
 *
 * @param config - Partial config from the user, or nothing at all.
 * @throws {@link ConfigurationError} on a `time` or `recoverAfter` that isn't a finite number > 0
 * (a `NaN` slips past a plain `<= 0` check & then coerces `setInterval` to a ~1ms hot loop).
 * @internal
 */
export function resolveCollectorConfig(config?: CollectorConfig): Required<CollectorConfig> {
  const resolved: Required<CollectorConfig> = { ...COLLECTOR_DEFAULTS, ...(config ?? {}) };

  if (!Number.isFinite(resolved.time) || resolved.time <= 0) {
    throw new ConfigurationError('collector.time must be a finite number of milliseconds greater than 0');
  }
  if (!Number.isFinite(resolved.recoverAfter) || resolved.recoverAfter <= 0) {
    throw new ConfigurationError(
      'collector.recoverAfter must be a finite number of milliseconds greater than 0',
    );
  }

  return resolved;
}

interface PendingWrite {
  schema: string;
  table: string;
  key: string;
  /** a snapshot copy, never the object the caller passed to `set()` (see {@link snapshotvalue}) */
  value: unknown;
}

/**
 * Result of a {@link WriteCollector.peek} => `hit` says whether the buffer had anything for that
 * key at all, which is what keeps a buffered `null` distinct from a miss.
 */
export interface BufferedValue {
  hit: boolean;
  value: unknown;
}

/**
 * Copy a value the same way a read after the flush would see it.
 *
 * The driver stores JSON, so a value has to survive the same round trip whether it's read out of
 * the buffer or off disk (a Date is an ISO string either way). It also keeps the buffer off the
 * caller's object => without the copy, mutating the thing you handed to `set()` would quietly
 * change what gets written, and a value read back out of the buffer would be mutable too.
 *
 * @param value - The value to copy.
 * @param json - Its JSON text, when the caller already computed it (`set()` does, for validation)
 * => saves stringifying the same value twice on the write path.
 */
function snapshotvalue(value: unknown, json?: string): unknown {
  const text = json ?? JSON.stringify(value);
  // only reachable if something slipped an undefined past set()'s validation => read it as empty
  return text === undefined ? null : JSON.parse(text);
}

export class WriteCollector {
  // composite key => last pending write for that key (dedup within window)
  private buffer = new Map<string, PendingWrite>();
  // the snapshot a flush is currently writing => still peek-able, so a read during a flush sees
  // its own write instead of the row the driver hasn't committed yet
  private inflight: Map<string, PendingWrite> | null = null;
  // keys an immediate write/delete pulled out from under the in flight snapshot => requeue() must
  // not put those back, they've already been superseded on the driver
  private evicted = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  // breaker position => `closed` is normal, `open` is read-only, `half-open` is one trial flush
  private state: BreakerState = 'closed';
  // when the breaker last went open => the cooldown is measured from here
  private trippedAt = 0;
  // in-flight flush => new flushes chain onto it instead of running concurrently
  private flushing: Promise<void> | null = null;
  // edge-trigger for onBackpressure => true once the buffer crosses HIGH_WATER, re-armed each flush
  private overHighWater = false;
  // bound handlers so we can remove them on stop() => a listener that outlives the collector would
  // flush onto a driver the app has already closed
  private signalHandlers = new Map<NodeJS.Signals, () => void>();
  private beforeExitHandler: (() => void) | null = null;

  constructor(
    private driver: DatabaseDriver,
    private config: Required<CollectorConfig>,
  ) {
    if (config.time >= 10_000) {
      console.warn(
        `[sql-switch] collector time is ${config.time}ms — recommended below 10000ms,` +
          ` high intervals make writes feel sluggish to end users`,
      );
    }

    this.timer = setInterval(() => void this.tick(), config.time);
    // don't hold the event loop open => a script that connects & goes idle should be able to exit
    // on its own. nothing is lost by it: the buffer still gets drained by `beforeExit`, by a signal
    // or by close(), all of which run before the process actually goes away
    this.timer.unref();

    if (config.flushOnExit) this.hookexit();
  }

  /**
   * Listen for the process going away so the buffer gets drained instead of dropped.
   *
   * `SIGTERM` matters as much as `SIGINT` here => that's what containers send, and it used to be
   * ignored entirely. `beforeExit` covers the third way out: a script that simply runs out of work
   * with writes still buffered (it doesn't fire on signals or `process.exit()`, both already
   * covered). Removed again by {@link stop}.
   */
  private hookexit(): void {
    for (const signal of EXIT_SIGNALS) {
      const handler = (): void => void this.onsignal(signal);
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    // async work in a beforeExit listener keeps the loop alive until it settles => the flush lands.
    // routed through flushOnBeforeExit so a dead DB can't turn that into an infinite spin
    this.beforeExitHandler = (): void => void this.flushOnBeforeExit();
    process.on('beforeExit', this.beforeExitHandler);
  }

  /**
   * The `beforeExit` drain => flush what's buffered, but give up if it isn't going anywhere.
   *
   * well, a plain `void this.flush()` here livelocks against a database that's down: `beforeExit`
   * fires, the flush fails & {@link requeue} puts the writes back, the async work keeps the event
   * loop alive, so `beforeExit` fires again => flush → requeue → beforeExit forever & the process
   * can never actually exit. So watch the buffer: a drain that didn't shrink it means the driver
   * isn't taking writes, and retrying on every `beforeExit` is pointless => drop our own listener
   * and let the process go. Those requeued writes are already lost to the outage, the same way a
   * `SIGKILL` mid-outage would lose them. A signal or `close()` can still flush explicitly.
   */
  private async flushOnBeforeExit(): Promise<void> {
    const before = this.buffer.size;
    if (before === 0) return; // nothing buffered => don't keep the loop alive for a no-op flush

    await this.flush();

    // no headroom gained => the DB isn't answering, stop re-arming beforeExit or we spin here
    if (this.buffer.size >= before && this.beforeExitHandler) {
      process.off('beforeExit', this.beforeExitHandler);
      this.beforeExitHandler = null;
    }
  }

  /**
   * Drain the buffer, then hand the signal back.
   *
   * fragile, the order matters => flush first, then drop *our* listener, then re-raise so whatever
   * would have happened without us happens now. Calling `process.exit()` here (the old behaviour)
   * steals shutdown from the host app: its own handlers, its `finally` blocks & any sibling
   * collector still draining all get cut off by whoever finished flushing first.
   *
   * The re-raise only fires when nothing else is listening for that signal. If the app has its own
   * handler, it's already running & re-raising would run it a second time => the app decides how to
   * exit, we just make sure the buffer is on disk before it does.
   */
  private async onsignal(signal: NodeJS.Signals): Promise<void> {
    try {
      await this.flush();
    } catch (err) {
      console.error(`[sql-switch] flush on ${signal} failed:`, err);
    }

    const handler = this.signalHandlers.get(signal);
    if (handler) {
      process.off(signal, handler);
      this.signalHandlers.delete(signal);
    }

    handback(signal);
  }

  /** Take every exit listener back off. Called from {@link stop}. */
  private unhookexit(): void {
    for (const [signal, handler] of this.signalHandlers) process.off(signal, handler);
    this.signalHandlers.clear();

    if (this.beforeExitHandler) {
      process.off('beforeExit', this.beforeExitHandler);
      this.beforeExitHandler = null;
    }
  }

  /**
   * Queue a write for the next flush. While the circuit breaker is anything but closed, throws
   * {@link DatabaseUnavailableError} — callers should catch & serve reads only.
   *
   * Same-key writes within a flush window are collapsed: only the last value is kept.
   *
   * @param schema - Schema the write belongs to.
   * @param table - Table within that schema.
   * @param key - Row id.
   * @param value - The value to store. Buffered as a snapshot copy, so mutating the object
   * afterwards can't change what eventually gets written.
   * @param json - `JSON.stringify(value)` if the caller already has it => avoids serializing the
   * same value twice.
   * @throws {@link DatabaseUnavailableError} if the breaker isn't closed or the buffer is full.
   */
  queue(schema: string, table: string, key: string, value: unknown, json?: string): void {
    // half-open counts as unavailable too => the trial flush is still deciding, and taking writes
    // it might have to hand back keeps the buffer from ever draining
    if (this.state !== 'closed') {
      throw new DatabaseUnavailableError();
    }

    const bk = `${schema}:${table}:${key}`;

    // only a *new* key can push the buffer past the cap => a write to a key that's already
    // buffered collapses onto it (the action queue dedup, last write wins), so it can't grow
    // memory at all. checking has() first means a bounded hot set of exactly MAX_BUFFER keys keeps
    // taking updates instead of spuriously tripping the breaker into read-only mode
    if (!this.buffer.has(bk) && this.buffer.size >= MAX_BUFFER) {
      this.trip(`write buffer hit the ${MAX_BUFFER}-key limit`);
      throw new DatabaseUnavailableError(
        `write buffer hit the ${MAX_BUFFER}-key limit — circuit breaker tripped, entering read-only mode`,
      );
    }

    // map key collision = last write wins (the action queue dedup)
    this.buffer.set(bk, {
      schema,
      table,
      key,
      value: snapshotvalue(value, json),
    });

    // edge-trigger => fire once on the way up, not on every write past the mark. re-armed when the
    // next flush clears the buffer (see runFlush)
    this.checkHighWater();
  }

  /**
   * Look up a key in the buffer without touching the driver => this is what makes reads see
   * writes that haven't been flushed yet.
   *
   * O(1): the same `schema:table:key` composite the buffer is keyed on, so a read never turns
   * into a buffer scan no matter how many writes are pending. Checks the in flight snapshot too,
   * otherwise a read landing during a flush would fall through to a row that isn't committed yet.
   *
   * @returns `hit: false` when nothing is buffered, so a buffered `null` stays distinct from a
   * miss. The value is a snapshot copy, matching what a read after the flush returns.
   */
  peek(schema: string, table: string, key: string): BufferedValue {
    const bk = `${schema}:${table}:${key}`;
    const pending = this.buffer.get(bk) ?? this.inflight?.get(bk);
    if (!pending) return { hit: false, value: null };
    return { hit: true, value: snapshotvalue(pending.value) };
  }

  /**
   * Drop a key from the buffer because it's being written (or deleted) on the driver right now.
   *
   * One rule covers three bugs: any immediate driver write for a key drops that key from the
   * buffer, so a queued `set()` can't resurrect a deleted row & an older buffered value can't
   * land on top of a `.force()`.
   *
   * @remarks
   * fragile, ordering matters here => a key evicted while a flush is in flight also has to be
   * marked so {@link requeue} skips it. without that, a group that fails puts the stale value
   * straight back in the buffer & the next flush commits it anyway.
   *
   * @see {@link settle} — call it after this to wait out a flush already writing the key.
   */
  evict(schema: string, table: string, key: string): void {
    const bk = `${schema}:${table}:${key}`;
    this.buffer.delete(bk);

    if (this.inflight) {
      this.inflight.delete(bk);
      this.evicted.add(bk);
    }
  }

  /**
   * Wait for the flush that's currently running (if any) to finish.
   *
   * An immediate write has to wait this out, otherwise a flush already committing the old value
   * can land *after* it => the newest write silently loses. Doesn't start a flush of its own.
   */
  async settle(): Promise<void> {
    await this.flushing;
  }

  /**
   * Flush all pending writes to the driver.
   * Groups writes by schema:table so each group can be sent as one batch transaction.
   *
   * @remarks
   * Calls are serialized => if a flush is already running, this one waits for it and then
   * runs. Two flushes overlapping used to be able to commit an older value for a key after
   * a newer one, because each takes its own snapshot.
   *
   * Calling this directly ignores the breaker cooldown on purpose => an explicit flush (`stop()`,
   * a shutdown hook, your own retry) is a caller saying "try now", and if it lands the breaker
   * closes. The interval goes through {@link tick} instead, which waits the cooldown out.
   */
  async flush(): Promise<void> {
    const run = (this.flushing ?? Promise.resolve()).then(() => this.runFlush());
    // never let a rejection poison the chain for later callers
    this.flushing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The interval's flush => also the breaker's clock.
   *
   * While the breaker is open this is what waits out `recoverAfter` & then promotes to half-open
   * so exactly one trial flush gets through. {@link runFlush} passes the verdict back.
   */
  private async tick(): Promise<void> {
    if (this.state === 'half-open') return; // a trial is already in the air

    if (this.state === 'open') {
      if (!this.config.autoRecover) return;
      if (Date.now() - this.trippedAt < this.config.recoverAfter) return;
      this.setstate('half-open');
    }

    await this.flush();
  }

  /** Move the breaker & tell the app about it. A throwing hook can't take the flush down. */
  private setstate(next: BreakerState, reason?: string): void {
    if (this.state === next) return;
    this.state = next;
    this.safehook('onStateChange', () => this.config.hooks.onStateChange?.(next, reason));
  }

  /**
   * Run an observability hook without ever letting it take the collector down.
   *
   * @remarks
   * Hooks run on the flush path, so a throwing one would otherwise abort a flush or a state
   * transition. Caught & logged instead => the app's metrics bug can't become a data-loss bug.
   */
  private safehook(label: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      console.error(`[sql-switch] collector ${label} hook threw:`, err);
    }
  }

  /** A flush group failed => hand it to onFlushError, or log it if nobody's listening. */
  private reportFlushError(schema: string, table: string, writes: number, error: unknown): void {
    if (this.config.hooks.onFlushError) {
      this.safehook('onFlushError', () =>
        this.config.hooks.onFlushError!(error, { schema, table, writes }),
      );
    } else {
      console.error(`[sql-switch] flush error on ${schema}.${table}:`, error);
    }
  }

  /** Writes lost for good => hand the count to onDrop, or log it if nobody's listening. */
  private reportDrop(writes: number, reason: string): void {
    if (writes <= 0) return;
    if (this.config.hooks.onDrop) {
      this.safehook('onDrop', () => this.config.hooks.onDrop!(writes, reason));
    } else {
      console.error(`[sql-switch] dropped ${writes} write(s) => ${reason}`);
    }
  }

  /** Buffer crossed the high-water mark => hand it to onBackpressure, or warn if nobody's listening. */
  private reportBackpressure(): void {
    if (this.config.hooks.onBackpressure) {
      this.safehook('onBackpressure', () =>
        this.config.hooks.onBackpressure!(this.buffer.size, MAX_BUFFER),
      );
    } else {
      console.warn(
        `[sql-switch] write buffer past ${HIGH_WATER}/${MAX_BUFFER} keys => flush isn't keeping up`,
      );
    }
  }

  /**
   * Fire the backpressure signal once when the buffer first climbs past the high-water mark.
   *
   * Edge-triggered against `overHighWater` => a buffer sitting above the mark reports on the climb,
   * not on every write, and runFlush re-arms it the moment the buffer clears. Called from queue()
   * when a fresh write pushes us over, and again after a failed flush requeues (COL#6): the requeue
   * can refill past the mark on its own, and that climb is real backpressure the caller should hear
   * about just the same, otherwise it stays silent until the next brand new write happens to trip
   * the edge.
   */
  private checkHighWater(): void {
    if (this.buffer.size >= HIGH_WATER && !this.overHighWater) {
      this.overHighWater = true;
      this.reportBackpressure();
    }
  }

  /** Open the breaker & start the cooldown. */
  private trip(reason: string): void {
    this.trippedAt = Date.now();
    this.setstate('open', reason);
  }

  // the actual flush, only ever entered one at a time (see flush())
  private async runFlush(): Promise<void> {
    if (this.buffer.size === 0) {
      // a trial flush with nothing left to write can't prove the database is back, but there's
      // nothing to lose either => close & let the next real write re-trip if it's still down
      if (this.state === 'half-open') this.setstate('closed', 'nothing left to flush');
      return;
    }

    // snapshot & clear before awaiting so incoming writes during flush aren't lost. the snapshot
    // is kept on the instance rather than local => peek() reads through it, so a get() during a
    // flush still sees the value being written instead of the stale row on disk
    const snapshot = new Map(this.buffer);
    this.buffer.clear();
    this.inflight = snapshot;
    this.evicted.clear();
    // buffer just emptied => re-arm the backpressure edge so a fresh climb fires again
    this.overHighWater = false;

    try {
      // group by schema:table
      const groups = new Map<
        string,
        { schema: string; table: string; writes: Map<string, unknown> }
      >();
      for (const pending of snapshot.values()) {
        const gk = `${pending.schema}:${pending.table}`;
        if (!groups.has(gk)) {
          groups.set(gk, { schema: pending.schema, table: pending.table, writes: new Map() });
        }
        groups.get(gk)!.writes.set(pending.key, pending.value);
      }

      // keep the array so settled results line up with their group by index
      const pendingGroups = Array.from(groups.values());

      const results = await Promise.allSettled(
        pendingGroups.map(({ schema, table, writes }) =>
          // Promise.resolve().then wraps the call => a driver whose batchSet throws *synchronously*
          // (the interface allows a non-async one) becomes a rejected promise allSettled absorbs,
          // instead of throwing out of .map & rejecting the whole flush (unhandled on the tick path)
          Promise.resolve().then(() => this.driver.batchSet(schema, table, writes)),
        ),
      );

      results.forEach((r, i) => {
        if (r.status !== 'rejected') return;

        const group = pendingGroups[i];
        if (group) {
          this.reportFlushError(group.schema, group.table, group.writes.size, r.reason);
          this.requeue(group.schema, group.table, group.writes);
        }
      });

      // COL#6: a failed flush just requeued its groups => the buffer we cleared above may be back
      // over the high-water mark, but the edge was re-armed to false when we cleared it, so nothing
      // re-fired. re-check here so requeue-driven backpressure is reported, not just fresh-write
      this.checkHighWater();

      // the breaker's verdict. everything through => the database is answering, so close (this is
      // what ends read-only mode after an outage). anything rejected during a trial => back to
      // open with the cooldown re-armed, so the next attempt is one cooldown away, not one interval
      if (!results.some((r) => r.status === 'rejected')) {
        // don't declare healthy while the buffer is already back at the cap => a write burst can
        // trip the breaker (via queue()) during this flush's await, and closing here on top of a
        // still-full buffer just means the next set() re-trips => open/closed flapping and an
        // isTripped that briefly lies. stay tripped until a flush actually leaves headroom
        if (this.buffer.size < MAX_BUFFER) {
          this.setstate('closed', 'flush succeeded');
        }
      } else if (this.state === 'half-open') {
        this.trip('trial flush failed');
      }
    } finally {
      this.inflight = null;
      this.evicted.clear();
    }
  }

  /**
   * Put a failed group back in the buffer for the next flush.
   *
   * Writes queued while the flush was in flight are newer, so they win => only keys that
   * aren't back in the buffer already get restored. Keys an immediate write or delete evicted
   * mid flight are skipped for the same reason: the driver already holds something newer.
   * Overflowing the cap here trips the breaker, which is how a sustained outage ends up
   * read-only instead of looping forever.
   */
  private requeue(schema: string, table: string, writes: Map<string, unknown>): void {
    const entries = Array.from(writes);
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i]!;
      const bk = `${schema}:${table}:${key}`;
      if (this.buffer.has(bk) || this.evicted.has(bk)) continue;

      if (this.buffer.size >= MAX_BUFFER) {
        const reason = `write buffer hit the ${MAX_BUFFER}-key limit while retrying failed writes`;
        this.trip(reason);
        // everything from here on we can't restore => count only what wasn't already superseded
        let dropped = 0;
        for (let j = i; j < entries.length; j++) {
          const rest = `${schema}:${table}:${entries[j]![0]}`;
          if (!this.buffer.has(rest) && !this.evicted.has(rest)) dropped++;
        }
        this.reportDrop(dropped, reason);
        return;
      }

      this.buffer.set(bk, { schema, table, key, value });
    }
  }

  /** Flush remaining writes and stop the interval timer. Call this on graceful shutdown. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // remove the exit listeners to prevent stale flushes after close
    this.unhookexit();
    await this.flush();

    // anything left here came back from a failed group => nothing is going to retry it now,
    // so at least make the loss visible instead of silent
    if (this.buffer.size > 0) {
      this.reportDrop(this.buffer.size, 'could not be flushed before shutdown');
    }
  }

  /**
   * True while the collector is refusing writes => the breaker is open, or half-open with a trial
   * flush still deciding. See {@link breakerState} for which of the two.
   */
  get isTripped(): boolean {
    return this.state !== 'closed';
  }

  /** Current circuit breaker position. */
  get breakerState(): BreakerState {
    return this.state;
  }

  /** Number of writes currently waiting in the buffer. */
  get pendingCount(): number {
    return this.buffer.size;
  }
}
