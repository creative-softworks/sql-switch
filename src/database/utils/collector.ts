/**
 * @packageDocumentation
 * Write collector — buffers writes in RAM and flushes to the driver in bulk on each interval.
 *
 * ### How it works
 * - Every `.set()` call queues a pending write using a `schema:table:key` composite key.
 * - If the same key is updated multiple times within a flush window, only the last write
 *   survives (Map key collision = natural dedup). This is the "action queue" behaviour.
 * - Every N ms (default 3000) `flush()` groups pending writes by schema:table and calls
 *   `driver.batchSet()` for each group inside its own transaction. Flushes are serialized,
 *   so a slow one overlapping the next interval can't land an older value after a newer one.
 * - A group that fails is put back in the buffer & retried on the next flush (newer writes
 *   for the same key win), so a brief outage doesn't silently drop data.
 * - Circuit breaker: if the buffer grows past 5000 keys, new writes are rejected with
 *   {@link DatabaseUnavailableError} and the collector is marked read-only. A sustained
 *   outage gets there on its own via the retry path.
 * - SIGINT handler does a proper async flush before exit. Hard kills (SIGKILL) still lose up
 *   to one flush interval of writes => acknowledged tradeoff to protect the DB from storms.
 *
 * @example
 * ```ts
 * const collector = new WriteCollector(driver, { enabled: true, time: 3000 });
 * collector.queue('antinuke', 'settings', 'guild_123', { strict: true });
 * await collector.stop(); // flush & clear timer (e.g. on graceful shutdown)
 * ```
 */

import { DatabaseUnavailableError } from '../errors.js';
import type { DatabaseDriver, CollectorConfig } from '../types.js';

/** hard cap on pending writes before the circuit breaker trips */
const MAX_BUFFER = 5000;

interface PendingWrite {
  schema: string;
  table: string;
  key: string;
  value: unknown;
}

export class WriteCollector {
  // composite key => last pending write for that key (dedup within window)
  private buffer = new Map<string, PendingWrite>();
  private timer: ReturnType<typeof setInterval> | null = null;
  // once tripped, the collector stays read-only until the process restarts
  private tripped = false;
  // in-flight flush => new flushes chain onto it instead of running concurrently
  private flushing: Promise<void> | null = null;
  // bound handlers so we can remove them on stop()
  private sigintHandler: (() => void) | null = null;

  constructor(
    private driver: DatabaseDriver,
    config: Required<CollectorConfig>,
  ) {
    if (config.time >= 10_000) {
      console.warn(
        `[sql-switch] collector time is ${config.time}ms — recommended below 10000ms,` +
          ` high intervals make writes feel sluggish to end users`,
      );
    }

    this.timer = setInterval(() => void this.flush(), config.time);

    // async flush on SIGINT — wait for it to finish before letting the process exit
    // only register once per collector instance, cleanup on stop()
    this.sigintHandler = () => {
      void this.flush().then(() => process.exit(0));
    };
    process.once('SIGINT', this.sigintHandler);
  }

  /**
   * Queue a write for the next flush. If the circuit breaker is tripped, throws
   * {@link DatabaseUnavailableError} — callers should catch & enter read-only mode.
   *
   * Same-key writes within a flush window are collapsed: only the last value is kept.
   */
  queue(schema: string, table: string, key: string, value: unknown): void {
    if (this.tripped) {
      throw new DatabaseUnavailableError();
    }

    if (this.buffer.size >= MAX_BUFFER) {
      this.tripped = true;
      throw new DatabaseUnavailableError(
        `write buffer hit the ${MAX_BUFFER}-key limit — circuit breaker tripped, entering read-only mode`,
      );
    }

    // map key collision = last write wins (the action queue dedup)
    this.buffer.set(`${schema}:${table}:${key}`, { schema, table, key, value });
  }

  /**
   * Flush all pending writes to the driver.
   * Groups writes by schema:table so each group can be sent as one batch transaction.
   *
   * @remarks
   * Calls are serialized => if a flush is already running, this one waits for it and then
   * runs. Two flushes overlapping used to be able to commit an older value for a key after
   * a newer one, because each takes its own snapshot.
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

  // the actual flush, only ever entered one at a time (see flush())
  private async runFlush(): Promise<void> {
    if (this.buffer.size === 0) return;

    // snapshot & clear before awaiting so incoming writes during flush aren't lost
    const snapshot = new Map(this.buffer);
    this.buffer.clear();

    // group by schema:table
    const groups = new Map<string, { schema: string; table: string; writes: Map<string, unknown> }>();
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
        this.driver.batchSet(schema, table, writes),
      ),
    );

    results.forEach((r, i) => {
      if (r.status !== 'rejected') return;

      const group = pendingGroups[i];
      console.error(
        `[sql-switch] flush error on ${group?.schema}.${group?.table}:`,
        r.reason,
      );
      if (group) this.requeue(group.schema, group.table, group.writes);
    });
  }

  /**
   * Put a failed group back in the buffer for the next flush.
   *
   * Writes queued while the flush was in flight are newer, so they win => only keys that
   * aren't back in the buffer already get restored. Overflowing the cap here trips the
   * breaker, which is how a sustained outage ends up read-only instead of looping forever.
   */
  private requeue(schema: string, table: string, writes: Map<string, unknown>): void {
    for (const [key, value] of writes) {
      const bk = `${schema}:${table}:${key}`;
      if (this.buffer.has(bk)) continue;

      if (this.buffer.size >= MAX_BUFFER) {
        this.tripped = true;
        console.error(
          `[sql-switch] write buffer hit the ${MAX_BUFFER}-key limit while retrying failed` +
            ` writes => circuit breaker tripped, entering read-only mode`,
        );
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
    // remove SIGINT handler to prevent stale flushes after close
    if (this.sigintHandler) {
      process.off('SIGINT', this.sigintHandler);
      this.sigintHandler = null;
    }
    await this.flush();

    // anything left here came back from a failed group => nothing is going to retry it now,
    // so at least make the loss visible instead of silent
    if (this.buffer.size > 0) {
      console.error(
        `[sql-switch] ${this.buffer.size} write(s) could not be flushed before shutdown`,
      );
    }
  }

  /** True if the circuit breaker has tripped (buffer overflow or DB outage). */
  get isTripped(): boolean {
    return this.tripped;
  }

  /** Number of writes currently waiting in the buffer. */
  get pendingCount(): number {
    return this.buffer.size;
  }
}
