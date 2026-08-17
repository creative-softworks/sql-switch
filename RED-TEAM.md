# RED-TEAM.md — orientation & break-it brief for an AI agent

You have full access to this repo in a throwaway environment. Your job: **understand
this package, then try to break it**, and hand back reproducible bug reports. Read this
whole file first, then read the source (it's small, 9 files under `src/database/`).

## What this package is

`sql-switch` is a universal, hot-swappable database abstraction layer. One fluent API
runs on two engines:

- **SQLite mode** — each schema is a physical `.db` file (`./data/databases/<schema>.db`), WAL on by default.
- **PostgreSQL mode** — each schema is a Postgres logical schema (`<schema>.<table>`).

Same call regardless of engine:
```ts
await db.schema('antinuke').table('settings').key('guild_123').set({ strict: true })
```

## Architecture map (read the source in this order)

| File | What it does |
|------|--------------|
| `src/database/index.ts` | the public fluent API facade (`createDAL`, `engineSwap`). the ONLY public surface — package.json `exports` points here. |
| `src/database/drivers/sqlite-drizzle.ts` | SQLite engine (better-sqlite3 + drizzle), one `.db` file per schema. |
| `src/database/drivers/postgres-drizzle.ts` | Postgres engine (pg + drizzle), one logical schema per schema. |
| `src/database/utils/collector.ts` | the write collector — buffers writes in RAM, bulk-flushes on an interval, collapses repeat writes to the same key. also where the circuit breaker + exit flush live. |
| `src/database/engine-swap.ts` | bidirectional migration (SQLite files ⇄ Postgres schemas), one transaction per table. |
| `src/database/schema-manager.ts` | resolves/creates schemas & tables per engine. |
| `src/database/schema.ts` | drizzle table/column definitions. |
| `src/database/types.ts` | shared types (config, driver interface, etc.). |
| `src/database/errors.ts` | error types. |

## Key mechanisms to attack (verify each against the source before trusting this summary)

- **Write collector** — buffers writes, flushes in bulk every N ms (default 3000). Multiple
  writes to the same key inside a window collapse to the last value. `.force()` bypasses the
  collector and writes immediately. Disable-able.
- **Circuit breaker** — caps pending writes at **5000 keys**. On a Postgres outage it trips to
  read-only instead of crashing. Failed flush groups go back in the buffer and are retried, so a
  *sustained* outage is what fills the buffer and trips it.
- **Exit flush** — a `SIGINT` handler drains the buffer on graceful shutdown (registered once per
  collector, removed on `close()`).
- **Engine swap** — every table migrates in its own transaction; local files are deleted only
  after every table has landed. Interactive conflict resolution on the CLI, or an `onConflict`
  handler from code.

## Setup in this environment

```bash
pnpm install --frozen-lockfile   # native build gate already fixed in pnpm-workspace.yaml
pnpm run typecheck               # tsc gate
pnpm run smoke                   # SQLite end-to-end, needs no DB
pnpm run build                   # dual CJS/ESM bundle
```
For the Postgres paths you need a **throwaway** `DATABASE_URL` (see `docker-compose.yml` in
this repo — `docker compose up -d` gives you an ephemeral Postgres, wiped on restart):
```bash
export DATABASE_URL='postgres://postgres:redteam@localhost:5432/swaptest_playground'
pnpm run swap-test               # creates & drops its own `swaptest` schema
```

## Attack surface — go hard on these

1. **Collector concurrency** — interleave `set` / `.force()` / interval-flush on the SAME key. Can same-key collapse ever drop or reorder the last write? Race the flush against an inbound write.
2. **Circuit breaker edges** — sustained Postgres outage that fills the 5000-key cap. Off-by-one at exactly 5000? Does it trip cleanly, stay read-only, and recover when the DB returns? Do retried groups ever double-write?
3. **Crash mid-flush** — the exit flush only hooks `SIGINT`. What about `SIGTERM`, `SIGKILL`, `process.exit()`, or an uncaught exception? Are buffered writes silently lost?
4. **Partial engine-swap failure** — kill the process (or make the DB fail) after table 3 of 5 has migrated. Is the source data really intact? Any half-migrated / half-deleted state? Does a rerun recover?
5. **Input abuse** — huge payloads, deeply nested objects, emoji/unicode keys, and injection attempts in schema/table/key names. There IS name validation — try to bypass it (path traversal in the SQLite filename, SQL identifiers in Postgres).
6. **Type edges** — BigInt, `undefined`, `NaN`, circular refs, `Date`, `Buffer`. What's silently coerced vs rejected?
7. **SQLite specifics** — WAL file handling, two processes opening the same `.db`, disk-full mid-write, a read-only data dir.
8. **Lifecycle** — double `connect()`, `close()` then reuse, `close()` mid-flush, swap while writes are still buffered.

## Rules of engagement (important)

- **Never point `DATABASE_URL` at a database you care about.** You are trying to break things — you can and will drop schemas, exhaust connections, corrupt data. Use the disposable Postgres only.
- **Every bug needs a reproduction.** Write a standalone script or test under `red-team/` that fails deterministically. Prose-only claims don't count — if you can't repro it, it's a hypothesis, label it as such.
- **Write findings to `FINDINGS.md`** as you go: title, severity, the repro path, expected vs actual, and a suspected root cause (file:line). Rank by severity.
- **Don't "fix" anything.** Report only. The point is a prioritized bug list, not a patched fork.
- The only gates that exist are `pnpm run typecheck` + `pnpm run smoke` (+ `pnpm run swap-test` with a DB). There is no lint and no unit-test framework — if you add tests, wire up the runner yourself and say so.

