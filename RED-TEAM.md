# RED-TEAM.md — orientation

You have full access to this repo in a throwaway environment. Your job: **understand this
package, then try to break it**, and hand back a reproducible bug report.

## The actual assignment lives in `instruction.md`

This file is just a signpost. **Read [`instruction.md`](./instruction.md) and follow it** — it is
the self-contained brief: setup, every command explained, the storage budget, the full attack
surface, the severity rubric, and the exact report to produce. Everything below is a 30-second
overview so you know what you're looking at before you open it.

## What this package is

`sql-switch` is a universal, hot-swappable database abstraction layer. One fluent API runs on two
engines, so the same call works whether you're on local SQLite or cloud Postgres:

```ts
await db.schema('antinuke').table('settings').key('guild_123').set({ strict: true })
```

- **SQLite mode** — each schema is a physical `.db` file (`./data/databases/<schema>.db`), WAL on by default.
- **PostgreSQL mode** — each schema is a Postgres logical schema (`<schema>.<table>`).

## Architecture map (read the source in this order — it's 9 small files under `src/database/`)

| File | What it does |
|------|--------------|
| `src/database/index.ts` | the public fluent API facade (`createDAL`, `engineSwap`). the ONLY public surface. |
| `src/database/drivers/sqlite-drizzle.ts` | SQLite engine (better-sqlite3 + drizzle), one `.db` file per schema. |
| `src/database/drivers/postgres-drizzle.ts` | Postgres engine (pg + drizzle), one logical schema per schema. |
| `src/database/utils/collector.ts` | write collector — buffers writes, bulk-flushes on an interval, collapses repeat writes to the same key. circuit breaker + exit flush live here. |
| `src/database/engine-swap.ts` | bidirectional migration (SQLite files ⇄ Postgres schemas), one transaction per table. |
| `src/database/schema-manager.ts` | resolves/creates schemas & tables per engine. |
| `src/database/schema.ts` | drizzle table/column definitions. |
| `src/database/types.ts` | shared types (config, driver interface, etc.). |
| `src/database/errors.ts` | error types. |

## Rules of engagement (the full version is in `instruction.md`)

- **Never point `DATABASE_URL` at a database you care about.** You will drop schemas, exhaust
  connections, corrupt data. Use a disposable Postgres only — `docker-compose.yml` in this repo
  gives you an ephemeral tmpfs one (`docker compose up -d`, wiped on restart).
- **Break it with extreme *conditions*, never by editing `src/`.** Sabotaging the source proves nothing.
- **Every bug needs a deterministic repro** under `red-team/`. No repro → it's a hypothesis; label it.
- **Prefix everything you create with `rt_`, respect the storage budget, and clean up.** See `instruction.md` §2, §6, §11.
- **The one deliverable is `REPORT.md`** — structure and severity rubric are in `instruction.md` §9–§10.
- **Don't "fix" anything.** Report only. The point is a prioritized bug list, not a patched fork.

The only gates that exist are `pnpm run typecheck` + `pnpm run smoke` (+ `pnpm run swap-test` with
a DB). There is no lint and no unit-test framework — if you add tests, wire up the runner yourself.
