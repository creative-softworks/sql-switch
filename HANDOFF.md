# HANDOFF — sql-switch → professional grade

**To:** Opus 5, ultracode effort.
**From:** Opus 4.8 (release + audit pass).
**Date:** 2026-08-21.
**Mission:** Take `sql-switch` from "shipped and working" to "professional grade." Fix the real
bugs first, then close the tooling and polish gaps. Leave it as a package a senior reviewer would
sign off on without flinching.

---

## 0. Read this first

- **Ground truth is CLAUDE.md.** House comment style, variable naming, invariants, commands,
  Replit sandbox constraints — all there. Follow the comment mechanics exactly (`=>` not em-dash,
  `&` not "and" in comments, lowercase casual comments, `userdata` never `user_data`). Several
  older files violate this; see item S13.
- **v0.2.0 is already live on npm** (both `sql-switch` and `@creative-softworks/sql-switch`) and has
  a GitHub Release. Do NOT re-publish 0.2.0. Any fixes ship as **0.2.1** (patch) or **0.3.0**
  (new/changed public surface). Release mechanics in §5.
- **Work on a branch off `origin/main`, open a PR.** `main` has branch protection (required checks
  `test (22)`, `test (24)`, `docs`; squash-only). Never push straight to main.
- This audit changed **nothing** in the code — it's all still open work.

## 1. Quality gates (what "green" means)

Run before claiming anything works: `pnpm typecheck && pnpm test && pnpm smoke` (add
`pnpm swap-test` when `DATABASE_URL` is set). Notes:

- `pnpm typecheck` is currently **clean**. Keep it that way.
- `pnpm test` **segfaults locally in this sandbox** — a better-sqlite3 native-ABI mismatch
  (exit 139 / SIGSEGV), NOT a logic failure. Only pure-logic test files pass here. **CI on Node
  22/24 (ubuntu) is authoritative** for anything touching the native binding. Don't chase the
  local segfault; verify native-path work via CI.
- Postgres-backed tests self-skip without `DATABASE_URL`. That's by design — but see C2 below,
  it's also a coverage hole.

## 2. Backlog — CRITICAL (do these first)

These two are genuine behavioral bugs, not opinion:

- **[C1] Un-awaited `delete()` is a silent no-op.** `src/database/index.ts:218-224`. `delete()`
  only *defines* `run` and returns a lazy `WriteOperation`; nothing executes until `.then()`/
  `await`/`.force()`. So `db.schema(s).table(t).key(id).delete()` fire-and-forget does nothing.
  This is the exact footgun `set()` was deliberately made eager to avoid (read `set()`'s own
  docstring). **Fix:** execute `run()` eagerly inside `delete()` like `set()` does, keep the
  returned handle awaitable, guard the fire-and-forget path with `.catch`. Add a regression test.

- **[C2] Engine-swap leaks SIGINT/SIGTERM handlers when a driver import fails.**
  `src/database/engine-swap.ts:613-617` (swapUp) and `882-886` (swapDown). `hookswapexit()`
  registers process signal listeners *before* the dynamic `import('pg')` /
  `import('better-sqlite3')`, and those imports sit *before* the `try` whose `finally` calls
  `exit.release()`. A missing driver throws out of the function, listeners never removed →
  orphaned handlers accumulate across calls, `MaxListenersExceededWarning`, corrupted host
  shutdown. **Fix:** register the exit hook *after* the imports/pool are built, or move
  `hookswapexit()` inside the `try`. Test with a swap where the target driver isn't installed.

## 3. Backlog — SHOULD-FIX (correctness & consistency)

- **[S3] Fire-and-forget `.force()` and forced `delete()` can crash the process.**
  `index.ts:196-204, 218-224`. The queued `set()` path guards with `void scheduled.catch(...)`;
  the `.force()` closure and `delete()` `run` do not, so an un-awaited rejection becomes an
  unhandled rejection (process crash under default Node). Attach the same defensive `.catch`.

- **[S4] A corrupt/locked `.db` file aborts the whole upward migration.**
  `engine-swap.ts:644`. `new Database(sqlitePath, {readonly:true})` is built *outside* the
  per-file `try` (starts at 651), so a bad header / OS lock / permission error takes down the
  entire multi-schema run — contradicting the module's own "skip & report via `skippedNames`"
  ethos. Wrap the open, route failures into `skippedNames` + `onProgress`.

- **[S5] `WriteOperation` implements `then` but not `catch`/`finally`.** `index.ts:77-95`. TS
  users are shielded by the `PromiseLike` type; a JS caller doing `.catch(...)`/`.finally(...)`
  hits `TypeError: catch is not a function`. Add `catch`/`finally` delegating to `then` (or
  return a real `Promise`).

- **[S6] Pure reads have write side effects (auto-create schema/table).**
  `sqlite-drizzle.ts:148-176, 263-320`, `postgres-drizzle.ts:363-410` via `ensureTable`.
  `get`/`has`/`scan`/`count`/`deleteAll` all run `CREATE TABLE IF NOT EXISTS` (+ `mkdir`/file
  create on SQLite, `CREATE SCHEMA IF NOT EXISTS` on PG). A `count()` on a never-written schema
  materializes it — and on PG a stray read creates an empty logical schema that `swapDown` later
  enumerates as "user data." Make pure reads not auto-create (treat missing relation as empty),
  or document as intentional. Prefer the fix.

- **[S7] A failed `engineSwap()` inside `swapEngine()` leaves the DAL silently unusable.**
  `index.ts:761-785`. It `await this.close()` (nulls driver/collector) then `await engineSwap()`;
  if that throws, the DAL is closed but `this.config` is still set → every later call throws
  `NotConnectedError`, no rollback, no reconnect. Reconnect to the original config on failure (or
  document that a failed swap requires an explicit `connect()`). Pair with the S-tier test gap below.

## 4. Backlog — TESTS, TOOLING & CI (the biggest "professional" gap)

The pure-logic layer is genuinely well tested (collector/breaker, value integrity, name
validation, pg classifiers, journal/chunking). The gaps are concentrated in cross-engine and
runtime-driver paths, and there are no quality-of-life gates.

**Critical coverage holes:**
- **[T1] `swapDown` (engine-swap.ts:858-1130) has ZERO Vitest coverage.** No `direction:'down'`
  call exists in `test/`. Untested: file-level conflict decline, all-foreign-schema stub cleanup,
  `wal_checkpoint(TRUNCATE)` before rename, tmp→`.db` atomic rename, stale `.tmp-wal`/`-shm`
  cleanup, keyset pagination, JSONB→TEXT re-serialization. Single biggest risk area — add a
  gated down-swap durability test mirroring the up-swap one.
- **[T2] Up-swap row migration + all `PostgresDriver` runtime methods only run in one
  secret-gated CI job.** Everything behind `describe.skipIf(!DATABASE_URL)` silently reports green
  on fork PRs and across the matrix. A pg-driver or migration regression can merge red-free.
  At minimum make "green without secret ≠ tested" loud; ideally run the gated set on the matrix.
- **[T3] No dependency/security audit in CI** — no `pnpm audit`/CodeQL/OSV/Trivy. Dependabot only
  bumps versions, it won't fail CI on a CVE. Notable for a provenance-published package.
- **[T4] No code coverage at all** — no `@vitest/coverage-v8`, no `test:coverage`, no thresholds,
  no report upload. Land this FIRST: it makes T1/T2 self-evident instead of hand-discovered.

**Should-fix tooling:**
- **[T5] No linter.** Add `@typescript-eslint` (or Biome) + a CI lint job. Most conspicuous
  missing gate given the strict tsconfig. CLAUDE.md's "no lint is wired up" invariant must be
  updated when you do this.
- **[T6] No enforced formatter.** `.editorconfig` exists but nothing enforces it — add Prettier
  or Biome `format --check` to CI.
- **[T7] No pre-commit hooks** (husky / simple-git-hooks + lint-staged) to run typecheck/lint
  before push.
- **[T8] Untested branches, all cheap unit tests:** `resolveSwapOptions` error branches
  (engine-swap.ts:243-266, pure fn — no DB needed); `NotConnectedError` (index.ts:696,740 — the
  one error class of five never asserted); `swapEngine`/`DalSwapOptions` reconnect logic
  (index.ts:739-793); `add(Infinity)`→`InvalidValueError`; breaker `closed→open` re-trip cycle;
  direct unit tests for `utils/shutdown.ts` and `utils/value.ts`.

## 5. Backlog — DOCS & PACKAGING POLISH

- **[D1] README has zero badges.** Add a badge row: npm version, license (MIT), CI status, node
  engine (`>=22`), provenance. (`README.md`.)
- **[D2] Hosted TypeDoc is built + deployed to GitHub Pages but never linked.** Add a
  "Documentation" section/link in README; consider pointing `package.json` `homepage` at the
  Pages site instead of `#readme`. (`.github/workflows/docs.yml` deploys it.)
- **[D3] `sideEffects` field missing** from both `package.json` and `scoped/package.json`. The
  module is import-side-effect-free (signal handlers register at runtime inside `connect()`, not
  at import). Add `"sideEffects": false` to both — real tree-shaking win + expected metadata.
- **[D4] No "Error handling" section in README.** The error classes are public and each carries a
  discriminant `code` (`DATABASE_UNAVAILABLE`, `INVALID_NAME`, `CONFIGURATION_ERROR`,
  `NOT_CONNECTED`, `INVALID_VALUE`). Show the `instanceof`/`.code` pattern + a table.
- **[D5] Exported config types invisible in README** — `DALConfig`, `CollectorConfig`,
  `CollectorHooks`, `ScanOptions`, `BreakerState`, `DalSwapOptions`, `EngineSwap*`. Add a typed-
  config snippet and link the hosted type reference. (TSDoc in `types.ts` is already excellent.)
- **[D6] Thin keywords (6)** in both package.json files — add `orm`, `postgres`, `better-sqlite3`,
  `pg`, `migration`, `database-abstraction`, `write-batching`, `circuit-breaker`, `neon`.
- **[D7] CLAUDE.md handoff drift** — it says `node >=18` and "matrix 18/20/22/24", but real
  `engines` is `>=22.0.0` and `ci.yml` runs `[22,24]`. Reconcile.
- **[D8] `master-blueprint.md` is referenced by CLAUDE.md but does not exist.** Either write it or
  drop the pointer — a handoff reader hits a dead reference.
- **[D9] Nice-to-have:** `.github/CODEOWNERS`, `funding` field / `FUNDING.yml` (only if a channel
  exists), badge/`sideEffects` parity for the scoped alias.

## 6. Backlog — NICE-TO-HAVE (cleanup a reviewer will notice)

- **[N1]** Dead deprecated `deleteAfterMigration` config field (`types.ts:189-197`) — remove on
  next major.
- **[N2]** Duplicated chunking + upsert-SQL logic: `engine-swap.ts:336-378` vs
  `postgres-drizzle.ts:284-333`. Two near-identical generators/builders that can drift. Consolidate.
- **[N3]** Backpressure hook can go silent under sustained churn — `overHighWater` only re-arms
  when the buffer fully clears (`collector.ts:463-468, 493`); an oscillating-above-mark buffer
  never re-fires `onBackpressure`.
- **[N4]** NUL scrub in error message replaces only the first occurrence (`value.ts:86`, missing
  `/g`). Cosmetic.
- **[N5]** No DAL-level breaker-state accessor — `collector` has `isTripped`/`breakerState`, `DAL`
  only surfaces `pendingWrites`. Consider a `db.breakerState` passthrough.
- **[N6]** `pull()` overload ambiguous for function-valued array elements (`index.ts:370`) — doc note.
- **[S13/N7] House-style comment violations** per CLAUDE.md in the older files: `errors.ts`
  (em-dashes throughout), `schema.ts`, `types.ts`, and the top-of-file doc blocks in
  `postgres-drizzle.ts` / `sqlite-drizzle.ts`. Bring them to `=>` / `&` / lowercase style.

## 7. Suggested sequencing

1. **Tooling scaffold first** — coverage (T4), linter (T5), formatter (T6), CI audit (T3). This
   surfaces the real gaps and gives you gates for everything after.
2. **Critical bugs** — C1, C2 (each with a regression test).
3. **Correctness/consistency** — S3-S7.
4. **Coverage** — T1 (swapDown), T2 (make gated paths visible/matrix'd), T8 (cheap unit branches).
5. **Docs & packaging** — D1-D8.
6. **Cleanup** — N1-N7 / house style.
7. Update CHANGELOG under a new `[Unreleased]`; bump to 0.2.1 (fixes only) or 0.3.0 (if S5/S6/N5
   widen the public surface — an exports/`.d.ts` change is a deliberate act per the invariants).

## 8. Release mechanics (when it's time)

Bump **three** spots to the same version: root `package.json` `version`, `scoped/package.json`
`version`, and `scoped/package.json` `dependencies["sql-switch"]`. Push tag `v<x.y.z>`. The
`publish.yml` workflow guards tag == all three before publishing both packages with provenance,
then create the GitHub Release. The npm credential is now a working Automation-class token
(a granular "select packages" token previously failed to create the unscoped package with a
misleading E404 — don't regress to one).

## 9. Hard constraints (do not violate)

- Public API = only what `src/database/index.ts` re-exports (exports map + `.d.ts`). Widening it
  is a deliberate act — update the exports and the invariants list on purpose, and treat it as a
  minor version bump pre-1.0.
- Driver packages (`better-sqlite3`, `pg`) are **optional** peer deps loaded via dynamic,
  mode-gated `import()`. Never add a static import — a SQLite-only app must not gain a `pg` dep.
- Ships dual CJS + ESM from one source; both entrypoints must keep resolving.
- TypeDoc must stay at **zero warnings** (`treatWarningsAsErrors`); `@internal` symbols are
  excluded, so never `{@link}` one from a public comment. README is the TypeDoc readme — a broken
  link there fails `pnpm docs` too.
- Don't commit `.claude-data/` or `quick.db/`; don't overwrite `.graphify/graph.json` (stale, and
  the installed CLI's `build` writes an incompatible format — see CLAUDE.md).
- Rotate the Neon `DATABASE_URL` if it was ever exposed; redact any token in output.

