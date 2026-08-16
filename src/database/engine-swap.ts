/**
 * @packageDocumentation
 * Programmatic engine swap => the same bidirectional migration the CLI does, callable from
 * code so you don't have to shell out to `npm run db:engine-swap`.
 *
 * - **up**   SQLite `.db` files  ->  Postgres logical schemas
 * - **down** Postgres schemas    ->  SQLite `.db` files
 *
 * Anything you leave out of the options is filled in for you: `dataDir` falls back to
 * `./data/databases`, `connectionString` to `process.env.DATABASE_URL`, and the target side
 * (data dir, Postgres schemas, tables) is created if it isn't there yet.
 *
 * @example Swap standalone
 * ```ts
 * import { engineSwap } from 'sql-switch';
 *
 * const result = await engineSwap({ direction: 'up', onConflict: 'overwrite' });
 * console.log(`${result.totalRows} rows moved`);
 * ```
 *
 * @example Swap a live DAL & keep using it
 * ```ts
 * // flushes pending writes, migrates, then reconnects on the new engine
 * await db.swapEngine({ direction: 'up' });
 * await db.schema('antinuke').table('settings').key('guild_1').get(); // now hitting Postgres
 * ```
 */

import pg from 'pg';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { validateName } from './schema-manager.js';
import { ConfigurationError } from './errors.js';

const { Pool } = pg;

/** Postgres built-ins that are never treated as user data. */
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'public', 'pg_toast'];

/** rows per chunk when moving data => keeps memory flat on big tables */
const CHUNK_SIZE = 500;

/** default location for SQLite `.db` files, matches the SqliteDriver default */
const DEFAULT_DATA_DIR = './data/databases';

/** Which way the data moves. */
export type SwapDirection = 'up' | 'down';

/** Something the migration is about to overwrite, passed to an `onConflict` callback. */
export interface SwapConflict {
  /** `table` on the way up (a Postgres table), `file` on the way down (a local `.db`). */
  kind: 'table' | 'file';
  schema: string;
  /** only set when `kind` is `table` */
  table?: string;
}

/**
 * What to do when the target already holds data.
 * `'skip'` (the default) leaves it alone, `'overwrite'` replaces it, or decide per target
 * with a callback returning `true` to overwrite.
 */
export type ConflictHandler =
  | 'skip'
  | 'overwrite'
  | ((conflict: SwapConflict) => boolean | Promise<boolean>);

/** Options for {@link engineSwap}. Everything except `direction` has a default. */
export interface EngineSwapOptions {
  /** `'up'` = SQLite to Postgres, `'down'` = Postgres to SQLite. */
  direction: SwapDirection;
  /**
   * Postgres connection string.
   * @defaultValue `process.env.DATABASE_URL`
   */
  connectionString?: string;
  /**
   * Directory holding the SQLite `.db` files. Created if missing.
   * @defaultValue `'./data/databases'`
   */
  dataDir?: string;
  /**
   * Upward only: keep the local `.db` files after a successful migration.
   * @defaultValue `false` (files are deleted, same as the CLI without `--keep`)
   */
  keepLocalFiles?: boolean;
  /**
   * How to handle a target that already has data in it.
   * @defaultValue `'skip'` => nothing gets clobbered unless you say so
   */
  onConflict?: ConflictHandler;
  /** Called with human readable progress lines. Handy for piping into your own logger. */
  onProgress?: (message: string) => void;
}

/** Per table outcome of a swap. */
export interface SwapTableResult {
  schema: string;
  table: string;
  /** rows actually moved (0 when skipped) */
  rows: number;
  /** true when a conflict handler declined to overwrite this target */
  skipped: boolean;
}

/** Everything that happened during a swap. */
export interface EngineSwapResult {
  direction: SwapDirection;
  /** one entry per table touched, in the order they were processed */
  tables: SwapTableResult[];
  /** sum of `rows` across every non skipped table */
  totalRows: number;
  /** how many targets were skipped because of a conflict */
  skipped: number;
  /** local `.db` files removed after a successful upward migration */
  deletedFiles: string[];
}

/** options with every default applied => what the internals actually work with */
interface ResolvedSwapOptions {
  direction: SwapDirection;
  connectionString: string;
  dataDir: string;
  keepLocalFiles: boolean;
  onConflict: ConflictHandler;
  onProgress: (message: string) => void;
}

/**
 * Fill in every missing option & validate what's left.
 * Split out so the CLI can share the exact same defaulting rules.
 *
 * @throws {@link ConfigurationError} on a bad direction or a missing connection string.
 * @internal
 */
export function resolveSwapOptions(options: EngineSwapOptions): ResolvedSwapOptions {
  if (options?.direction !== 'up' && options?.direction !== 'down') {
    throw new ConfigurationError(
      'engine swap direction is required => "up" (SQLite to Postgres) or "down" (Postgres to SQLite)',
    );
  }

  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new ConfigurationError(
      'engine swap needs a Postgres connection string => pass connectionString or set DATABASE_URL',
    );
  }

  return {
    direction: options.direction,
    connectionString,
    dataDir: options.dataDir ?? DEFAULT_DATA_DIR,
    keepLocalFiles: options.keepLocalFiles ?? false,
    onConflict: options.onConflict ?? 'skip',
    // no logger passed => stay quiet, the result object has everything anyway
    onProgress: options.onProgress ?? (() => undefined),
  };
}

// ask the conflict handler whether a target may be overwritten
async function mayOverwrite(handler: ConflictHandler, conflict: SwapConflict): Promise<boolean> {
  if (typeof handler === 'function') return handler(conflict);
  return handler === 'overwrite';
}

/** describes a conflict target the way the CLI prompt used to */
function conflictLabel(conflict: SwapConflict): string {
  return conflict.kind === 'table' ? `${conflict.schema}.${conflict.table}` : `${conflict.schema}.db`;
}

/** List the user tables inside a SQLite file (skips sqlite internal tables). */
function sqliteTables(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * Upward migration => SQLite files into Postgres logical schemas.
 * Each `<name>.db` file becomes schema `<name>`, each table inside it is recreated as-is.
 *
 * Every table moves inside its own transaction, so a chunk failing partway can't leave the
 * Postgres side truncated or half filled. Local files are only deleted once every table in
 * them landed.
 */
async function swapUp(opts: ResolvedSwapOptions): Promise<EngineSwapResult> {
  const result: EngineSwapResult = {
    direction: 'up',
    tables: [],
    totalRows: 0,
    skipped: 0,
    deletedFiles: [],
  };

  if (!fs.existsSync(opts.dataDir)) {
    opts.onProgress(`data directory "${opts.dataDir}" does not exist => nothing to migrate`);
    return result;
  }

  const files = fs.readdirSync(opts.dataDir).filter((f) => f.endsWith('.db'));
  if (files.length === 0) {
    opts.onProgress(`no .db files found in ${opts.dataDir} => nothing to do`);
    return result;
  }

  const pool = new Pool({ connectionString: opts.connectionString, max: 5 });
  // pg kills the process on an unhandled idle client error
  pool.on('error', (err) => opts.onProgress(`idle postgres client error: ${err.message}`));

  const migrated: string[] = [];

  try {
    for (const file of files) {
      const schema = path.basename(file, '.db');
      validateName('schema', schema);

      const sqlitePath = path.join(opts.dataDir, file);
      const sqlite = new Database(sqlitePath, { readonly: true });
      // keep defaultSafeIntegers(true) => prevents precision loss on 64-bit IDs during read
      sqlite.defaultSafeIntegers(true);

      try {
        const tables = sqliteTables(sqlite);
        if (tables.length === 0) {
          opts.onProgress(`${schema} => no tables, skipped`);
          continue;
        }

        await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

        // a single skipped table means the local file still holds data Postgres doesn't =>
        // never delete it afterwards
        let fullyMigrated = true;

        for (const table of tables) {
          validateName('table', table);

          await pool.query(`
            CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (
              id    TEXT  PRIMARY KEY,
              value JSONB NOT NULL
            )
          `);

          // leftover rows in the target => ask before clobbering them
          const existing = await pool.query(`SELECT 1 FROM "${schema}"."${table}" LIMIT 1`);
          let truncateFirst = false;

          if (existing.rowCount && existing.rowCount > 0) {
            const conflict: SwapConflict = { kind: 'table', schema, table };
            if (!(await mayOverwrite(opts.onConflict, conflict))) {
              opts.onProgress(`${conflictLabel(conflict)} => skipped, target already has data`);
              result.tables.push({ schema, table, rows: 0, skipped: true });
              result.skipped++;
              fullyMigrated = false;
              continue;
            }
            truncateFirst = true;
          }

          const rows = sqlite.prepare(`SELECT id, value FROM "${table}"`).all() as Array<{
            id: string | bigint;
            value: string;
          }>;

          // one transaction per table => a chunk failing halfway can't leave the target
          // truncated or half filled, it all rolls back together
          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            if (truncateFirst) {
              await client.query(`TRUNCATE TABLE "${schema}"."${table}"`);
            }

            // chunked bulk upsert => flat memory even on big tables
            for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
              const chunk = rows.slice(i, i + CHUNK_SIZE);
              const values: string[] = [];
              const params: unknown[] = [];

              chunk.forEach((row, n) => {
                values.push(`($${n * 2 + 1}, $${n * 2 + 2}::jsonb)`);
                // handle BigInt IDs returned by defaultSafeIntegers(true)
                params.push(typeof row.id === 'bigint' ? row.id.toString() : row.id);
                // SQLite stores TEXT => pass the JSON string straight through to JSONB
                params.push(typeof row.value === 'string' ? row.value : JSON.stringify(row.value));
              });

              await client.query(
                `INSERT INTO "${schema}"."${table}" (id, value) VALUES ${values.join(', ')}
                 ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
                params,
              );
            }

            await client.query('COMMIT');
          } catch (err) {
            // best effort rollback => the connection may already be dead
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          } finally {
            client.release();
          }

          result.tables.push({ schema, table, rows: rows.length, skipped: false });
          result.totalRows += rows.length;
          opts.onProgress(`${schema}.${table} => ${rows.length} rows migrated`);
        }

        if (fullyMigrated) {
          migrated.push(sqlitePath);
        } else {
          opts.onProgress(`${file} kept => not every table was migrated`);
        }
      } finally {
        sqlite.close();
      }
    }

    // only delete local files after every schema landed successfully
    if (!opts.keepLocalFiles && migrated.length > 0) {
      for (const p of migrated) {
        fs.rmSync(p, { force: true });
        // WAL sidecars come along with the .db file
        fs.rmSync(`${p}-wal`, { force: true });
        fs.rmSync(`${p}-shm`, { force: true });
        result.deletedFiles.push(p);
      }
      opts.onProgress(
        `deleted ${result.deletedFiles.length} local .db file(s) (set keepLocalFiles to retain)`,
      );
    }

    opts.onProgress('upward migration complete => SQLite to Postgres');
    return result;
  } finally {
    await pool.end();
  }
}

/**
 * Downward migration => Postgres logical schemas into SQLite files.
 *
 * Writes to `<schema>.db.tmp` first & renames on success, so a mid-pull failure can't
 * leave a half-written database in place. Postgres data is left untouched.
 */
async function swapDown(opts: ResolvedSwapOptions): Promise<EngineSwapResult> {
  const result: EngineSwapResult = {
    direction: 'down',
    tables: [],
    totalRows: 0,
    skipped: 0,
    deletedFiles: [],
  };

  // target dir may not exist yet on a fresh machine
  fs.mkdirSync(opts.dataDir, { recursive: true });

  const pool = new Pool({ connectionString: opts.connectionString, max: 5 });
  pool.on('error', (err) => opts.onProgress(`idle postgres client error: ${err.message}`));

  try {
    const schemaRes = await pool.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN (${SYSTEM_SCHEMAS.map((_, i) => `$${i + 1}`).join(', ')})
         AND schema_name NOT LIKE 'pg_%'`,
      SYSTEM_SCHEMAS,
    );

    const schemas = schemaRes.rows.map((r: { schema_name: string }) => r.schema_name);
    if (schemas.length === 0) {
      opts.onProgress('no user schemas found in Postgres => nothing to do');
      return result;
    }

    for (const schema of schemas) {
      validateName('schema', schema);

      const dbPath = path.join(opts.dataDir, `${schema}.db`);
      const tmpPath = `${dbPath}.tmp`;

      // existing local file => ask before replacing it
      if (fs.existsSync(dbPath)) {
        const conflict: SwapConflict = { kind: 'file', schema };
        if (!(await mayOverwrite(opts.onConflict, conflict))) {
          opts.onProgress(`${conflictLabel(conflict)} => skipped, local file already exists`);
          result.skipped++;
          continue;
        }
      }

      const tableRes = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [schema],
      );
      const tables = tableRes.rows.map((r: { table_name: string }) => r.table_name);
      if (tables.length === 0) {
        opts.onProgress(`${schema} => no tables, skipped`);
        continue;
      }

      // stale temp file from a previous failed run
      fs.rmSync(tmpPath, { force: true });
      const sqlite = new Database(tmpPath);

      try {
        sqlite.pragma('journal_mode = WAL');

        for (const table of tables) {
          validateName('table', table);

          sqlite.exec(
            `CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, value TEXT NOT NULL)`,
          );

          const insert = sqlite.prepare(
            `INSERT OR REPLACE INTO "${table}" (id, value) VALUES (?, ?)`,
          );

          let total = 0;
          // keyset pagination => LIMIT/OFFSET rescans everything it skipped on every chunk,
          // which turns quadratic on a big table. id is the primary key so `> lastId` walks
          // the index instead
          let lastId: string | null = null;

          for (;;) {
            const res: pg.QueryResult = await (lastId === null
              ? pool.query(
                  `SELECT id, value FROM "${schema}"."${table}" ORDER BY id LIMIT $1`,
                  [CHUNK_SIZE],
                )
              : pool.query(
                  `SELECT id, value FROM "${schema}"."${table}"
                   WHERE id > $1 ORDER BY id LIMIT $2`,
                  [lastId, CHUNK_SIZE],
                ));
            if (res.rows.length === 0) break;

            const insertMany = sqlite.transaction((rows: { id: string; value: unknown }[]) => {
              for (const row of rows) {
                // JSONB arrives parsed => stringify back down for SQLite TEXT
                const payload =
                  typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
                insert.run(row.id, payload);
              }
            });
            insertMany(res.rows);

            total += res.rows.length;
            lastId = (res.rows[res.rows.length - 1] as { id: string }).id;
            // short page => that was the last one, no need for another round trip
            if (res.rows.length < CHUNK_SIZE) break;
          }

          result.tables.push({ schema, table, rows: total, skipped: false });
          result.totalRows += total;
          opts.onProgress(`${schema}.${table} => ${total} rows pulled`);
        }
      } finally {
        sqlite.close();
      }

      // atomic swap => the active .db is only replaced once the temp file is complete
      fs.renameSync(tmpPath, dbPath);
      // drop stale WAL sidecars belonging to the replaced file
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      // close() normally checkpoints & removes these, but clean them up if it didn't
      fs.rmSync(`${tmpPath}-wal`, { force: true });
      fs.rmSync(`${tmpPath}-shm`, { force: true });
      opts.onProgress(`hydrated ${schema}.db`);
    }

    opts.onProgress('downward migration complete => Postgres to SQLite');
    opts.onProgress('cloud data left untouched (backup)');
    return result;
  } finally {
    await pool.end();
  }
}

/**
 * Run an engine swap from code, no terminal needed.
 *
 * Missing options are defaulted (see {@link EngineSwapOptions}) & the target side is created
 * if it doesn't exist yet, so the minimum viable call is just a direction plus a reachable
 * `DATABASE_URL`.
 *
 * @param options - Direction plus any overrides.
 * @returns A per table breakdown of what moved.
 * @throws {@link ConfigurationError} if the direction is missing/invalid or no connection
 * string can be resolved.
 * @throws {@link InvalidNameError} if a schema or table name isn't `^[a-zA-Z0-9-]+$`.
 *
 * @example Non interactive, overwrite whatever is in the target
 * ```ts
 * await engineSwap({
 *   direction: 'up',
 *   onConflict: 'overwrite',
 *   onProgress: (line) => console.log(`[swap] ${line}`),
 * });
 * ```
 *
 * @example Decide per table
 * ```ts
 * await engineSwap({
 *   direction: 'up',
 *   onConflict: (c) => c.schema !== 'economy', // never clobber economy
 * });
 * ```
 */
export async function engineSwap(options: EngineSwapOptions): Promise<EngineSwapResult> {
  const opts = resolveSwapOptions(options);

  opts.onProgress(
    `direction: ${opts.direction === 'up' ? 'SQLite => Postgres' : 'Postgres => SQLite'}`,
  );
  opts.onProgress(`data dir: ${opts.dataDir}`);

  return opts.direction === 'up' ? swapUp(opts) : swapDown(opts);
}
