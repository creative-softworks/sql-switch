# instruction.md — stress-test & break-it brief for sql-switch

> Hand this whole file to your agent. It is self-contained: it explains what the package is,
> what every command does, exactly how to attack it, the storage limit to respect, and the
> report to produce. (`README.md` and `RED-TEAM.md` in this repo have extra background if you
> want it, but you don't need them.)

---

## 0. Your mission

You are testing a Node.js package called **sql-switch**. Your job is to **break it under
extreme conditions and find every bug, vulnerability, and limitation**, then write a detailed
**`REPORT.md`**.

"Break it" means: hammer it with crazy inputs, huge loads, bad timing, concurrency, crashes,
and resource exhaustion — and see where it loses data, corrupts state, crashes, hangs, or
silently does the wrong thing. It does **not** mean editing the package's source to make it
fail (that proves nothing). Test it *as shipped*.

---

## 1. What sql-switch is

A hot-swappable database abstraction layer. One fluent API runs on two engines, so you can
develop on local SQLite and move to cloud PostgreSQL in production **without changing app code**:

```ts
await db.schema('antinuke').table('settings').key('guild_123').set({ strict: true })
```

- **local mode** — each schema is a physical SQLite file: `./data/databases/<schema>.db` (WAL on by default).
- **cloud mode** — each schema is a Postgres logical schema: `<schema>.<table>`.
- Writes are **buffered** in RAM and bulk-flushed on an interval (the "collector"); `.force()` writes immediately.
- Data can **migrate both directions** between engines (the "engine swap").

---

## 2. Ground rules (read before touching anything)

1. **Test as a black/grey box.** Drive it through its public API and CLI. You MAY read `src/` to
   understand behaviour and to point at root causes (cite `file:line`). You may write throwaway
   test scripts — put them in a `red-team/` folder. **Do NOT modify anything in `src/`** to induce
   a failure; breaking = extreme conditions, not sabotage.
2. **Respect the storage budget (see §6).** The Postgres database behind `DATABASE_URL` has
   ~500 MB. Stay **at or below 80% (~400 MB)**. Check size before and after big inserts, and
   **clean up everything you create.** Do not fill the disk and brick the database.
3. **Every bug needs a reproduction.** A deterministic script/test under `red-team/` that fails.
   No repro = it's a hypothesis; label it as one.
4. **Only touch what you create.** Prefix every schema/table/key/file you make with `rt_`
   (e.g. schema `rt_stress`). Never read, alter, or drop pre-existing data.
5. **Report, don't fix.** Deliver a prioritized bug list, not a patched fork.

---

## 3. Setup & what every command does

```bash
pnpm install --frozen-lockfile   # install deps. the native-build gate (better-sqlite3,
                                 # esbuild) is already whitelisted in pnpm-workspace.yaml.
                                 # if better-sqlite3 fails to build, you need a C toolchain
                                 # + python on this box (ubuntu: `apt-get install -y build-essential python3`)

pnpm run typecheck               # TypeScript gate (tsc on src/ + scripts/). no runtime.
pnpm run smoke                   # SQLite end-to-end self-test. needs NO database. RUN THIS FIRST
                                 # to confirm a green baseline (expect "26 passed, 0 failed").
pnpm run build                   # bundles CJS+ESM + .d.ts into dist/.
pnpm run swap-test               # engine-swap integration test. uses DATABASE_URL. creates &
                                 # drops its own `swaptest` schema. expect "24 passed, 0 failed".

pnpm run db:engine-swap -- --up  # CLI migration SQLite -> Postgres (--down for reverse).
                                 #   --url <conn>  Postgres string (falls back to DATABASE_URL)
                                 #   --dir <path>  SQLite dir (default ./data/databases)
                                 #   --keep        upward only: keep local .db files
                                 #   --yes         auto-confirm overwrites (non-interactive)

npx tsx red-team/<your-test>.ts  # run your own throwaway attack scripts (tsx runs TS directly)
```

`DATABASE_URL` is already set in your environment — verify with:
`node -e "console.log(process.env.DATABASE_URL ? 'DATABASE_URL is set' : 'MISSING')"`

---

## 4. How to drive the package (the API you'll attack)

```ts
import { createDAL, engineSwap } from 'sql-switch';   // from source: '../src/database/index.js'

const db = createDAL();

// LOCAL SQLite
await db.connect({
  db: { mode: 'local', dataDir: './data/databases', wal: true },
  collector: { enabled: true, time: 3000 },   // buffer writes, flush every 3000ms
});

// CLOUD Postgres
await db.connect({
  db: { mode: 'cloud', connectionString: process.env.DATABASE_URL },
  collector: { enabled: true, time: 3000 },
});

await db.schema('rt_x').table('t').key('k').get();            // read -> value | null
await db.schema('rt_x').table('t').key('k').set({ a: 1 });    // queued write
await db.schema('rt_x').table('t').key('k').set({ a: 1 }).force(); // immediate write
await db.schema('rt_x').table('t').key('k').delete();         // immediate delete (never queued)
db.pendingWrites;                                             // # writes currently buffered
await db.close();                                             // flush + close everything

await engineSwap({ direction: 'up', onConflict: 'skip', onProgress: console.log }); // 'up'|'down'
await db.swapEngine({ direction: 'up', onConflict: 'overwrite' }); // swap a live DAL in place
```

---

## 5. Architecture map (what does what — read the source in this order)

| File (`src/database/`) | Responsibility |
|------------------------|----------------|
| `index.ts` | public fluent API facade (`createDAL`, `engineSwap`). the ONLY public surface. |
| `drivers/sqlite-drizzle.ts` | SQLite engine (better-sqlite3 + drizzle), one `.db` file per schema. |
| `drivers/postgres-drizzle.ts` | Postgres engine (pg + drizzle). all schemas share ONE `pg.Pool` (`max` defaults to **5**, `connectionTimeoutMillis` 10s, `idleTimeoutMillis` 30s). |
| `utils/collector.ts` | write collector: buffer, interval bulk-flush, same-key collapse, circuit breaker, SIGINT flush. |
| `engine-swap.ts` | bidirectional migration. one transaction per table, `CHUNK_SIZE = 500` rows per batch. local files deleted only after all tables land. |
| `schema-manager.ts` | resolves/creates schemas & tables per engine. |
| `schema.ts` / `types.ts` / `errors.ts` | drizzle definitions / shared types / error classes. |

**Facts pulled from the source — verify each, then try to violate it:**
- **Circuit breaker:** buffer hard cap `MAX_BUFFER = 5000`. Past that, new writes are rejected with
  `DatabaseUnavailableError` and the collector goes read-only. **It stays read-only until the
  process restarts** — no in-process recovery. Test the trip, the exact-5000 boundary, AND that it
  never un-trips without a restart even after the DB recovers.
- **Exit flush:** only `SIGINT` triggers the async flush-before-exit. **`SIGTERM`, `process.exit()`,
  uncaught exceptions, and `SIGKILL` are NOT handled** — the source itself admits hard kills lose
  buffered writes. Quantify exactly what's lost for each.
- **Pool:** one shared pool, `max 5`. Easy to exhaust — see §8.7.

---

## 6. The storage budget (~500 MB Postgres — stay under 80%)

Check current database size any time:
```sql
SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
       pg_database_size(current_database()) AS bytes;
```
```ts
// programmatic size check + budget guard
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query('SELECT pg_database_size(current_database()) AS b');
const usedMB = Number(rows[0].b) / 1024 / 1024;
const BUDGET_MB = 400;                 // 80% of 500 MB — hard ceiling
if (usedMB > BUDGET_MB) throw new Error(`over budget: ${usedMB.toFixed(0)}MB`);
```
Rules:
- Record the **baseline size** before you start.
- Before any bulk insert, estimate `rowBytes * rowCount` and poll size mid-run; **stop at 400 MB**.
- **Clean up everything** when done: `DROP SCHEMA rt_<name> CASCADE;` for every schema you created,
  and delete local `./data/` files. End with the DB back at (or near) baseline size.
- To test "disk full", simulate it in **SQLite** (a small tmpfs / quota'd dir), NOT by filling the
  real Postgres.

---

## 7. Test plan (work through these phases in order)

- **Phase A — Baseline.** Run `pnpm run typecheck`, `pnpm run smoke`, `pnpm run swap-test`. Confirm
  all green. Record Node/pnpm versions and the Postgres baseline size. If baseline isn't green, that
  itself is finding #1.
- **Phase B — Local SQLite, extreme.** Attack surface §8, `mode: 'local'`. No storage cap here, but
  don't fill the real disk — use a small dir.
- **Phase C — Cloud Postgres, extreme.** Same attacks, `mode: 'cloud'` with `DATABASE_URL`,
  **storage-aware (§6)**. Focus on the pool, transactions, and Postgres-specific behaviour.
- **Phase D — Engine swap, stress.** Both directions; conflict handling (`skip`/`overwrite`/callback);
  **partial failure** (kill the process or force a DB error after some tables migrate — is the source
  intact? any half-migrated/half-deleted state? does rerun recover?); large-but-budgeted datasets to
  exercise the `CHUNK_SIZE = 500` batching and the down-path pagination.
- **Phase E — Cross-cutting.** Concurrency, lifecycle, and signals (§8.3, §8.6, §8.10).

For every phase, save the throwaway scripts under `red-team/` so findings are reproducible.

---

## 8. Attack surface — the crazy conditions to run

For each: run the scenario, then note what a bug looks like (data loss, corruption, crash, hang,
silent wrong result, unhandled rejection, resource leak).

1. **Write collector / batching** — fire many `set()`s to the SAME key inside one flush window: does
   collapse always keep the *last* value? Interleave `set()` and `.force()` on the same key and race
   them against the interval flush. Set `time` to `0` / `1` / negative / huge. Toggle `enabled:false`.
   Read a key that's buffered-but-not-flushed — do you get the fresh value?
2. **Circuit breaker (cap 5000)** — with the DB unreachable (dead host, or drop the network), pump
   >5000 buffered writes. Does it trip at exactly 5000? What error? After the DB comes back, confirm it
   *stays* read-only until restart. Any writes lost or double-applied on retry?
3. **Signals & crashes** — buffer writes, then send `SIGINT` (should flush); separately `SIGTERM`,
   `process.exit(0)`, and an uncaught exception. For each, count how many buffered writes survived.
   `SIGKILL` mid-flush: is the SQLite file / Postgres state corrupt or just short?
4. **Name / input abuse** — there IS name validation on schema/table/key. Try to bypass it: SQL meta
   characters, quotes, `;`, `--`, very long names, unicode/emoji, `..`/`/` path traversal in schema
   names (could it escape `./data/databases/`?), reserved SQL words, empty strings, 64-bit-integer keys.
5. **Value / type edges** — `undefined`, `NaN`, `Infinity`, `BigInt`, circular refs, `Date`, `Buffer`,
   deeply nested objects, multi-MB JSON blobs, keys/values with null bytes. What's coerced vs rejected,
   and is the rejection at the call site or after a partial write?
6. **Concurrency & races** — many parallel `set`/`get`/`delete` on overlapping keys; `swapEngine()`
   while writes are still buffered; two DAL instances on the same SQLite file; concurrent flushes.
7. **Connection / resource limits** — the shared pool is `max 5`. Fire 100+ concurrent cloud ops:
   does it queue, time out (10s), or throw? Kill Postgres mid-operation. Slow network. Check for pool /
   handle leaks (are connections released on error paths?).
8. **Engine-swap correctness** — partial failure (§7 Phase D); `onConflict` skip vs overwrite vs
   callback; rows straddling the 500-row chunk boundary; empty tables; a schema on target but not
   source; `keepLocalFiles` on/off; run a swap twice; swap while the collector has pending writes.
9. **SQLite specifics** — WAL file handling; read-only data dir; a second process opening the same
   `.db`; simulated disk-full (tmpfs/quota); a corrupt/locked `.db` file.
10. **Lifecycle misuse** — `connect()` twice; use after `close()`; `close()` mid-flush; ops before
    `connect()`; swap then immediately `close()`; invalid config (`mode` typo, missing
    `connectionString`, bad `dataDir`).

---

## 9. Severity rubric (rank every finding)

Tag each finding with one level. Rank the whole report by these, worst first.

| Level | Meaning | Examples |
|-------|---------|----------|
| **P0 — critical** | silent data loss/corruption, or a security escape. | buffered writes vanish on `SIGTERM` with no error; path traversal escapes `./data/databases/`; SQL injection via a name; engine-swap deletes source before target is durable. |
| **P1 — high** | crash, hang, or wrong result under a *realistic* condition. | pool exhaustion hangs forever instead of timing out; circuit breaker never un-trips; same-key collapse keeps the wrong value. |
| **P2 — medium** | bug needing an unusual trigger, or a leak that grows slowly. | connection not released on a specific error path; unhandled rejection on a malformed value; off-by-one only at exactly 5000. |
| **P3 — low / hardening** | poor ergonomics, confusing errors, missing validation that doesn't (yet) cause damage. | cryptic error message; `time: 0` silently means "never flush"; no guard on multi-MB values. |

A finding with no deterministic repro is a **hypothesis** — say so explicitly and keep it in a separate list below the confirmed ones.

---

## 10. The deliverable — `REPORT.md`

Write **one** `REPORT.md` at the repo root. Use exactly this structure:

```markdown
# sql-switch — Red-Team Report

## Environment
- Node version, pnpm version, OS
- Postgres baseline size (bytes + pretty), and size at end (prove you cleaned up)
- commit SHA tested

## Baseline (Phase A)
- typecheck / smoke / swap-test results (pass/fail + counts)

## Findings (ranked, worst first)
For EACH finding:
### [P0|P1|P2|P3] <short title>
- **What:** one-line description
- **Repro:** path to the script under `red-team/` + exact command to run it
- **Expected vs actual:** what should happen / what actually happens
- **Impact:** who/what breaks, and how bad
- **Suspected root cause:** `src/database/<file>.ts:<line>` + why
- **Suggested fix:** concrete direction (don't implement it, just describe)

## Hypotheses (unconfirmed — no deterministic repro)
- bulleted list, each labelled clearly as unverified

## Improvement recommendations
- API ergonomics, missing guards, config footguns, docs gaps
- prioritized, with rationale

## Coverage
- which of §8's 10 attack groups you exercised, on which engine (local/cloud), and what you did NOT get to
```

Rules for the report:
- Every P0/P1 **must** have a runnable repro under `red-team/`. No repro → it's a hypothesis.
- Cite `file:line` for root causes. Read `src/` to find them; don't guess.
- Be specific and quantitative: "lost 1,344 of 5,000 buffered writes on SIGTERM," not "loses some writes."

---

## 11. Before you finish — cleanup checklist

- [ ] `DROP SCHEMA rt_<name> CASCADE;` for **every** `rt_` schema you created in Postgres.
- [ ] Delete every local SQLite dir/file you made (your throwaway `./data/...` and any tmpfs dirs).
- [ ] Re-check `pg_database_size` — it should be back at (or near) the baseline you recorded.
- [ ] Confirm you never touched any non-`rt_` schema/table/key or any pre-existing `.db` file.
- [ ] `red-team/` contains every repro script, and `REPORT.md` references them by path.
- [ ] You did **not** modify anything under `src/`. (`git status src/` is clean.)

---

## Appendix — command cheat sheet

```bash
# --- setup ---
pnpm install --frozen-lockfile
node -e "console.log(process.env.DATABASE_URL ? 'DATABASE_URL is set' : 'MISSING')"

# --- baseline gates ---
pnpm run typecheck
pnpm run smoke                 # expect: 26 passed, 0 failed
pnpm run swap-test             # expect: 24 passed, 0 failed (needs DATABASE_URL)

# --- Postgres size (baseline + budget checks) ---
psql "$DATABASE_URL" -c "SELECT pg_size_pretty(pg_database_size(current_database())), pg_database_size(current_database());"

# --- run your attack scripts ---
npx tsx red-team/<your-test>.ts

# --- cleanup ---
psql "$DATABASE_URL" -c "DROP SCHEMA rt_stress CASCADE;"   # repeat per rt_ schema you made
rm -rf ./data/rt_*                                         # your throwaway local files
git status src/                                            # must be clean
```

**Golden rule:** break it with *conditions*, never by editing `src/`. Prefix everything you create
with `rt_`. Stay under 400 MB. Clean up. Every P0/P1 needs a repro. Then write `REPORT.md`.



