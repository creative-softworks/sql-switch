# sql-switch

Universal hot-swappable database abstraction layer for Node.js. Run SQLite locally, PostgreSQL in production — the same fluent API covers both. Migrate your data between engines with one CLI command, or one function call.

## Install

```bash
npm install sql-switch
```

The database drivers are **optional peer dependencies** — install only the one for the engine you
run, so a SQLite-only app never pulls in `pg` and its build, and vice versa:

```bash
npm install better-sqlite3   # local mode
npm install pg               # cloud mode
```

Each driver is loaded lazily the first time you `connect()` in that mode, so importing the package
never requires both engines to be present.

## Quick start

```ts
import { createDAL } from 'sql-switch';

const db = createDAL();

await db.connect({
  db: { mode: 'local', dataDir: './data/databases', wal: true },
  collector: { enabled: true, time: 3000 },
});

// read
const settings = await db.schema('antinuke').table('settings').key('guild_123').get();

// write (queued, flushed every 3s in bulk)
await db.schema('antinuke').table('settings').key('guild_123').set({ strict: true });

// write immediately, bypassing the collector
await db.schema('antinuke').table('settings').key('guild_123').set({ strict: true }).force();
```

## Switch to PostgreSQL

```ts
await db.connect({
  db: {
    mode: 'cloud',
    connectionString: process.env.DATABASE_URL,
    pool: { max: 5, statementTimeout: 30_000 },
  },
  collector: { enabled: true, time: 3000 },
});
```

`statementTimeout` (default 30s, `0` disables) is the ceiling on a single operation. Without one a
query that never answers holds a pool connection for the life of the process — `max` of those and
every later read blocks with no error at all.

## Enumerate, scan & convenience helpers

Beyond `get`/`set`/`delete`, a table streams and a key has the usual key-value sugar. The
enumeration methods return async iterators — a scan of a huge table never lands the whole thing in
RAM (a cursor on SQLite, keyset-paged on Postgres), so peak memory is one row/chunk.

```ts
const table = db.schema('economy').table('balances');

// stream keys / values / entries in ascending id order — break to stop early
for await (const [id, balance] of table.entries()) console.log(id, balance);
for await (const id of table.keys({ prefix: 'guild-' })) console.log(id);

// startsWith(prefix) is sugar for entries({ prefix }); the prefix is bound, never a pattern
for await (const [id, bal] of table.startsWith('guild-')) console.log(id, bal);

const howMany = await table.count({ prefix: 'guild-' }); // counted in the DB, rows never materialized
await table.deleteAll({ prefix: 'guild-' });             // wipe a prefix (or the whole table)
```

```ts
const key = db.schema('economy').table('balances').key('user_1');

await key.has();            // true if a value is stored (or buffered) for this key
await key.add(50);          // numeric increment (a missing key counts as 0) → new total
await key.sub(10);          // decrement
await key.push('a', 'b');   // array helpers: push / unshift / pop / shift / pull
await key.pull((x) => x.done);
```

Enumeration reads committed rows, so a write still sitting in the collector buffer is not visible to
a scan yet — `await`/`.force()` or `close()` first for an exact view. The numeric and array helpers
are read-modify-write and **not** atomic: two un-awaited `add()`s on the same key can read the same
base and lose an update. Sequential `await`ed calls are fine.

## Reliability

Defaults are chosen so nothing is silently lost. All of it is configurable.

```ts
await db.connect({
  db: { mode: 'cloud', connectionString: process.env.DATABASE_URL },
  collector: {
    time: 3000,           // flush interval
    autoRecover: true,    // breaker heals itself after an outage
    recoverAfter: 10_000, // read-only window before one trial flush decides
    flushOnExit: true,    // drain on SIGINT / SIGTERM / beforeExit
    hooks: {
      onStateChange: (state, reason) => log.warn(`db breaker ${state}`, reason),
    },
  },
});
```

| Behaviour | What happens |
|-----------|--------------|
| Buffered writes | A queued `set()` is visible to the next `get()` on the same key, before the flush. |
| Postgres outage | Transient failures are retried inside the driver with bounded jittered backoff; a group that still fails goes back in the buffer for the next flush. |
| Sustained outage | The buffer hits its 5000-key cap and the breaker opens — writes raise `DatabaseUnavailableError`, reads keep working. |
| Recovery | After `recoverAfter` the breaker half-opens; one trial flush closes it again (`autoRecover: false` keeps it latched until the process restarts). |
| Shutdown | `SIGINT`, `SIGTERM` and `beforeExit` flush the buffer, then the signal is handed back — the library never calls `process.exit()` for you. |
| Unstorable values | `undefined`, `NaN`/`Infinity`, NUL characters, BigInt and circular references throw `InvalidValueError` at the call, not inside a flush. |

## Engine swap

Move your data between engines either from the terminal or from code.

### CLI

```bash
# local SQLite → production PostgreSQL
npm run db:engine-swap -- --up

# production PostgreSQL → local SQLite
npm run db:engine-swap -- --down
```

| Flag | Description |
|------|-------------|
| `--up` / `--down` | Direction. One is required. |
| `--url <conn>` | PostgreSQL connection string. Falls back to `DATABASE_URL`. |
| `--dir <path>` | SQLite data directory. Default `./data/databases`. |
| `--keep` | Upward only: keep the local `.db` files instead of deleting them. |
| `--yes` | Auto-answer Y to every overwrite prompt (CI / non-interactive). |

### From code

Same migration, no terminal. Anything you leave out is filled in — `dataDir` defaults to
`./data/databases`, `connectionString` to `process.env.DATABASE_URL`, and missing schemas,
tables and directories are created on the target side.

```ts
import { engineSwap } from 'sql-switch';

const result = await engineSwap({
  direction: 'up',            // 'up' = SQLite → PostgreSQL, 'down' = the reverse
  onConflict: 'overwrite',    // default 'skip' — nothing is clobbered unless you say so
  onProgress: (line) => console.log(line),
});

console.log(`${result.totalRows} rows across ${result.tables.length} tables`);
```

Or swap a live DAL and keep using the same object. Pending writes are flushed and the open
handles closed first, then it reconnects on the target engine with your existing collector
settings:

```ts
await db.swapEngine({ direction: 'up', onConflict: 'overwrite' });

// same db instance, now reading from PostgreSQL
await db.schema('antinuke').table('settings').key('guild_123').get();
```

`onConflict` also takes a callback if you want to decide per target:

```ts
await engineSwap({
  direction: 'up',
  onConflict: (c) => c.schema !== 'economy', // never clobber economy
});
```

### What the migration guarantees

| | |
|---|---|
| Memory | Rows stream a chunk at a time in both directions — peak memory is one chunk, not one table. |
| Atomicity | Each table moves in its own transaction going up; going down the file is built as `.tmp` and renamed into place. |
| Resume | Every committed table (or renamed file) is journalled in the data dir, so an interrupted run resumes deterministically. A clean run removes the journal. |
| Shared databases | Schema/table names this DAL can't address (`^[a-zA-Z0-9_-]+$`) are skipped and listed in `result.skippedNames` instead of aborting the run. Nothing else is read or written. |
| Interruption | `SIGINT`/`SIGTERM` stops at the next boundary, sets `result.aborted`, deletes nothing, then hands the signal back. Run the same swap again to finish it. |
| Local files | Deleted only when every table landed **and** no DAL in this process still has the data dir open — a write sitting in a collector buffer is invisible to a migration reading the file. |

```ts
const result = await engineSwap({ direction: 'up' });

if (result.aborted) console.warn('stopped early, rerun to resume');
if (result.skippedNames.length) console.warn('left alone:', result.skippedNames);
```

## API

| Method | Description |
|--------|-------------|
| `db.connect(config)` | Initialise the DAL. Call once at startup. |
| `.schema(name)` | Select a module schema (maps to a `.db` file or Postgres schema). |
| `.table(name)` | Select a table inside the schema. |
| `.key(id)` | Select a key inside the table. |
| `.get<T>()` | Read. Returns `T \| null`. |
| `.set(value)` | Queue a write (or flush immediately if collector disabled). |
| `.set(value).force()` | Bypass the collector, write immediately. |
| `.delete()` | Delete immediately. Never queued, even when awaited without `.force()`. |
| `.has()` | `true` if a value is stored or buffered for the key. |
| `.add(n)` / `.sub(n)` | Numeric increment/decrement (missing key = 0). Non-atomic RMW. |
| `.push/.unshift/.pop/.shift/.pull` | Array helpers on the value. Non-atomic RMW. |
| `table.keys/.values/.entries` | Stream ids / values / `[id, value]`, ascending id order. `{ prefix }` narrows. |
| `table.startsWith(prefix)` | Sugar for `.entries({ prefix })`. Prefix is bound, never a pattern. |
| `table.count(opts?)` | Row count, done in the DB (rows never materialized). |
| `table.deleteAll(opts?)` | Delete every key (or just those under a prefix). |
| `db.swapEngine(options)` | Migrate to the other engine & reconnect on it. |
| `db.pendingWrites` | Number of writes currently buffered in the collector. |
| `db.close()` | Flush pending writes and close all connections. |
| `engineSwap(options)` | Standalone engine swap, no DAL instance needed. |

## Limits

The library is built so the only hard wall you hit is the database running out of storage. The few
non-storage constraints below are deliberate, so they're documented rather than left as surprises.

| Limit | Detail |
|-------|--------|
| Big integers in values | Values round-trip through JSON, so an integer past `2^53` loses precision (`12345678901234567890` reads back as `…567000`). Store big integers as strings. Only the key is precision-safe. |
| Binary in values | A `Buffer`/typed array serializes to `{ "type": "Buffer", "data": [...] }` and comes back a plain object, never a `Buffer`. Base64-encode binary yourself if you need it back intact. |
| Unstorable values | `undefined`, `NaN`/`Infinity`, NUL characters, BigInt and circular references are refused up front with `InvalidValueError` — they can't be stored the same way by both engines. |
| SQLite schema count | In local mode each schema is one `.db` file whose handle is cached for the life of the process (no LRU). Keep schemas coarse — one per module (`antinuke`, `economy`), not one per entity — or a schema-per-tenant layout hits the OS file-descriptor limit long before disk fills. Put the entity id in the key, not the schema. Cloud mode shares one pool and has no such ceiling. |
| SQLite writers | WAL allows concurrent readers with one writer. A second *writer* process waits up to `busyTimeout` (default 5s) for the lock, then throws `SQLITE_BUSY`. In-process, one cached handle per schema serializes writes already. |

## Scripts

```bash
npm run build        # dual CJS/ESM bundle + per-file .d.ts
npm test             # Vitest suite (Postgres files skip themselves without DATABASE_URL)
npm run typecheck    # tsc on src/ and scripts/
npm run smoke        # fast end to end check against real SQLite files
npm run swap-test    # engine swap integration test (needs DATABASE_URL, skips without it)
npm run docs         # TypeDoc HTML into /docs
npm run docs:serve   # serve /docs on http://localhost:3000
```

## Requirements

- Node.js >= 18.0.0
