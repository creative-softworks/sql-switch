/**
 * @packageDocumentation
 * PostgreSQL driver — implements {@link DatabaseDriver} using node-postgres (pg) + drizzle-orm.
 *
 * All schemas share a single `pg.Pool`. Schema/table isolation is handled at the SQL level
 * via Postgres logical schemas (e.g. `antinuke.settings`).
 *
 * @remarks
 * **PgBouncer compatibility**: drizzle-orm/node-postgres uses simple/unnamed queries by
 * default, which is exactly what PgBouncer transaction mode requires. Named prepared
 * statements corrupt PgBouncer pools — never call `pool.prepare()` here.
 *
 * Pool `max` defaults to 5 — keep it low when running behind PgBouncer in transaction
 * mode (PgBouncer does the real multiplexing; your local pool should stay small).
 *
 * JSONB columns are returned already parsed by the pg driver, so no `JSON.parse()` needed
 * on reads — unlike the SQLite driver which stores TEXT.
 */

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { buildPgTable } from '../schema.js';
import type { DatabaseDriver, PostgresConfig } from '../types.js';

const { Pool } = pg;

export class PostgresDriver implements DatabaseDriver {
  private pool: pg.Pool;
  private db: ReturnType<typeof drizzle>;
  // tracks which schema:table pairs have had CREATE SCHEMA/TABLE IF NOT EXISTS run
  private ready = new Set<string>();
  // in-flight ensure calls, keyed the same way => concurrent callers share one round trip
  private ensuring = new Map<string, Promise<void>>();
  // schemas that already had CREATE SCHEMA run (separate from tables, one per schema)
  private schemasReady = new Map<string, Promise<void>>();

  constructor(private config: PostgresConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      // keep low — PgBouncer handles the real multiplexing
      max: config.pool?.max ?? 5,
      // prevent indefinite hangs on connection issues
      connectionTimeoutMillis: 10_000,
      // close idle connections to avoid leaking resources
      idleTimeoutMillis: 30_000,
    });

    // pg emits this on idle clients (server restart, network drop). without a listener node
    // treats it as an unhandled 'error' event & kills the process => the whole point of the
    // circuit breaker is to survive an outage, so swallow it & let the next query reconnect
    this.pool.on('error', (err) => {
      console.error('[sql-switch] idle postgres client error:', err);
    });

    this.db = drizzle(this.pool);
  }

  // CREATE SCHEMA + TABLE on first touch, cached so subsequent calls are free
  private async ensureTable(schema: string, table: string): Promise<void> {
    const key = `${schema}:${table}`;
    if (this.ready.has(key)) return;

    // collector flushes fire groups in parallel => without this, two tables in the same
    // schema race on CREATE SCHEMA IF NOT EXISTS and postgres throws a pg_namespace
    // unique violation (it isn't actually atomic)
    const inflight = this.ensuring.get(key);
    if (inflight) return inflight;

    const run = (async () => {
      // raw pool.query here — drizzle doesn't have CREATE SCHEMA in its query builder
      let schemaRun = this.schemasReady.get(schema);
      if (!schemaRun) {
        schemaRun = this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`).then(() => undefined);
        this.schemasReady.set(schema, schemaRun);
      }

      try {
        await schemaRun;
      } catch (err) {
        // failed attempts must not stay cached, the next call should retry
        this.schemasReady.delete(schema);
        throw err;
      }

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (
          id   TEXT  PRIMARY KEY,
          value JSONB NOT NULL
        )
      `);

      this.ready.add(key);
    })();

    this.ensuring.set(key, run);
    try {
      await run;
    } finally {
      this.ensuring.delete(key);
    }
  }

  /** @inheritdoc */
  async get(schema: string, table: string, key: string): Promise<unknown> {
    await this.ensureTable(schema, table);

    const tbl = buildPgTable(schema, table);
    const rows = await this.db.select().from(tbl).where(eq(tbl.id, key)).limit(1);

    const row = rows[0];
    if (!row) return null;
    // JSONB is already a parsed JS object from the pg driver — no JSON.parse needed
    return row.value;
  }

  /** @inheritdoc */
  async set(schema: string, table: string, key: string, value: unknown): Promise<void> {
    await this.ensureTable(schema, table);

    const tbl = buildPgTable(schema, table);
    await this.db
      .insert(tbl)
      .values({ id: key, value })
      .onConflictDoUpdate({ target: tbl.id, set: { value } });
  }

  /**
   * Upsert a batch of key→value pairs inside a single transaction.
   * Called by the collector flush.
   * @inheritdoc
   */
  async batchSet(schema: string, table: string, writes: Map<string, unknown>): Promise<void> {
    await this.ensureTable(schema, table);

    const tbl = buildPgTable(schema, table);
    await this.db.transaction(async (tx) => {
      for (const [key, value] of writes) {
        await tx
          .insert(tbl)
          .values({ id: key, value })
          .onConflictDoUpdate({ target: tbl.id, set: { value } });
      }
    });
  }

  /** @inheritdoc */
  async delete(schema: string, table: string, key: string): Promise<void> {
    await this.ensureTable(schema, table);

    const tbl = buildPgTable(schema, table);
    await this.db.delete(tbl).where(eq(tbl.id, key));
  }

  /** End the connection pool gracefully. */
  async close(): Promise<void> {
    await this.pool.end();
    this.ready.clear();
    this.ensuring.clear();
    this.schemasReady.clear();
  }
}
