# sql-switch

Universal hot-swappable database abstraction layer for Node.js. Run SQLite locally, PostgreSQL in production — the same fluent API covers both. Migrate your data between engines with one CLI command, or one function call.

## Install

```bash
npm install sql-switch
```

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
  db: { mode: 'cloud', connectionString: process.env.DATABASE_URL },
  collector: { enabled: true, time: 3000 },
});
```

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
| `db.swapEngine(options)` | Migrate to the other engine & reconnect on it. |
| `db.pendingWrites` | Number of writes currently buffered in the collector. |
| `db.close()` | Flush pending writes and close all connections. |
| `engineSwap(options)` | Standalone engine swap, no DAL instance needed. |

## Scripts

```bash
npm run build        # dual CJS/ESM bundle + per-file .d.ts
npm run typecheck    # tsc on src/ and scripts/
npm run smoke        # fast end to end check against real SQLite files
npm run swap-test    # engine swap integration test (needs DATABASE_URL, skips without it)
npm run docs         # TypeDoc HTML into /docs
npm run docs:serve   # serve /docs on http://localhost:3000
```

## Requirements

- Node.js >= 18.0.0
