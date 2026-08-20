/**
 * @packageDocumentation
 * Test helper => an in memory {@link DatabaseDriver} you can steer.
 *
 * The collector tests need to watch what actually reaches the driver (how many round trips, in
 * what order) & to hold a flush open while the test does something else. A real engine can't do
 * either, so this fake records every call, can be told to fail the next N batches, and can park
 * a batch until the test releases it.
 */

import type { DatabaseDriver } from '../../src/database/types.js';

/** A parked batch => `started` resolves when the driver enters it, `release` lets it finish. */
export interface BlockedBatch {
  /** resolves once batchSet has actually been entered (the flush is in flight) */
  started: Promise<void>;
  /** let the batch complete => pass an error to make it reject instead */
  release: (err?: Error) => void;
}

/** Call counters, one per driver method. */
export interface DriverCalls {
  get: number;
  set: number;
  batchSet: number;
  delete: number;
  close: number;
}

export interface FakeDriver extends DatabaseDriver {
  /** everything written so far, keyed `schema:table:key` */
  readonly rows: Map<string, unknown>;
  /** how many times each method was called */
  readonly calls: DriverCalls;
  /** one entry per batchSet, in call order => lets a test assert round trips per chunk */
  readonly batches: Array<{ schema: string; table: string; keys: string[] }>;
  /** make the next `n` batchSet calls reject instead of writing */
  failBatches(n: number, message?: string): void;
  /** hold the next batchSet open until the returned release() runs */
  blockNextBatch(): BlockedBatch;
}

/** `schema:table:key`, the same composite the collector buffers on. */
export function rowkey(schema: string, table: string, key: string): string {
  return `${schema}:${table}:${key}`;
}

/** Build a fresh in memory driver. */
export function fakedriver(): FakeDriver {
  const rows = new Map<string, unknown>();
  const calls: DriverCalls = { get: 0, set: 0, batchSet: 0, delete: 0, close: 0 };
  const batches: Array<{ schema: string; table: string; keys: string[] }> = [];

  let failuresLeft = 0;
  let failmessage = 'simulated outage';
  let gate: { entered: () => void; wait: Promise<Error | undefined> } | null = null;

  return {
    rows,
    calls,
    batches,

    failBatches(n: number, message?: string): void {
      failuresLeft = n;
      if (message !== undefined) failmessage = message;
    },

    blockNextBatch(): BlockedBatch {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: (err?: Error) => void;
      const wait = new Promise<Error | undefined>((resolve) => {
        release = resolve;
      });
      gate = { entered, wait };
      return { started, release };
    },

    async get(schema, table, key) {
      calls.get++;
      const hit = rows.get(rowkey(schema, table, key));
      return hit === undefined ? null : hit;
    },

    async exists(schema, table, key) {
      // has() the Map key, not get() !== null => a stored literal null still counts as existing
      return rows.has(rowkey(schema, table, key));
    },

    async set(schema, table, key, value) {
      calls.set++;
      rows.set(rowkey(schema, table, key), value);
    },

    async batchSet(schema, table, writes) {
      calls.batchSet++;
      batches.push({ schema, table, keys: [...writes.keys()] });

      // a parked batch is one shot => clear it before awaiting so the next flush runs free
      if (gate) {
        const held = gate;
        gate = null;
        held.entered();
        const err = await held.wait;
        if (err) throw err;
      }

      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error(failmessage);
      }

      for (const [key, value] of writes) {
        rows.set(rowkey(schema, table, key), value);
      }
    },

    async delete(schema, table, key) {
      calls.delete++;
      rows.delete(rowkey(schema, table, key));
    },

    async *scan(schema, table, opts) {
      // rows are keyed schema:table:key => pull this table's, strip the prefix back to the id
      const lead = `${schema}:${table}:`;
      const prefix = opts?.prefix;
      const ids = [...rows.keys()]
        .filter((k) => k.startsWith(lead))
        .map((k) => k.slice(lead.length))
        .filter((id) => prefix === undefined || id.startsWith(prefix))
        .sort();
      for (const id of ids) {
        yield { id, value: rows.get(rowkey(schema, table, id)) };
      }
    },

    async count(schema, table, opts) {
      const lead = `${schema}:${table}:`;
      const prefix = opts?.prefix;
      let n = 0;
      for (const k of rows.keys()) {
        if (!k.startsWith(lead)) continue;
        if (prefix !== undefined && !k.slice(lead.length).startsWith(prefix)) continue;
        n++;
      }
      return n;
    },

    async close() {
      calls.close++;
    },
  };
}
