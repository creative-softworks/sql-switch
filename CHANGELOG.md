# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While it's pre-1.0, minor versions may carry breaking changes.

## [Unreleased]

## [1.0.1] - 2026-08-21

Tier 1 correctness fixes (packaging + Postgres value integrity + write durability).
No public API changes and no breaking changes — safe as a patch release.

### Fixed

- **`import 'sql-switch'` no longer drags in both drivers** (NEW-13): with tsup
  `splitting: false`, esbuild inlined each lazily-imported driver into the entry
  chunk and hoisted its top-level `import pg` / `import better-sqlite3`, so a
  SQLite-only (or Postgres-only) install crashed on import with "Cannot find
  module …". `splitting: true` keeps the drivers as their own chunks, so a driver
  is only loaded once its engine is selected — restoring the optional-peer-dep
  invariant. Both the ESM and CJS entrypoints are covered by a build-output guard.
- **Postgres `get()` no longer corrupts JSON-looking strings** (NEW-2): `get()`
  read through drizzle's `jsonb` column, which ran a second `JSON.parse` on a
  value the pg driver had already parsed. A stored string like a snowflake id
  (`"123456789012345678"`) came back as a precision-lost number, and `get()`
  disagreed with `entries()`/scans on the same row. `get()` now reads through the
  raw pool the way the scans always did.
- **Postgres `set(null)` is consistent across paths** (NEW-7): drizzle mapped a
  JS `null` onto a SQL `NULL`, which the `NOT NULL` `value` column rejected, so
  `set(null)` behaved differently on the immediate versus the buffered path. `set`
  now binds `$n::jsonb` with `JSON.stringify`, storing a jsonb `null` on every
  path — `get()` reads it back as `null` and `has()` still reports the row.
- **An un-awaited `delete()` now lands** (C1): `delete()` only ran its work inside
  the `WriteOperation` callbacks, so a fire-and-forget `delete()` (no `await`, no
  `.force()`) silently did nothing while a fire-and-forget `set()` committed. It
  now executes eagerly at call time, matching `set()`; `await`/`.force()` only
  decide whether you wait for it.

### Changed

- Postgres driver `get`/`set`/`delete` now issue raw parameterized `pool.query`
  calls (the same single `$n::jsonb` path as the bulk upsert and the scans)
  instead of the drizzle query builder, so every read and write path agrees
  byte-for-byte. drizzle-orm is still used for the SQLite driver and schema
  builders, so it remains a dependency.

## [1.0.0] - 2026-08-21

First stable release. The public API (the fluent chain, `createDAL`/`engineSwap`,
the error classes and config types) is now considered stable under SemVer. No
behavior or API changes from 0.2.0 — this release hardens the quality gates and
marks the surface as settled.

### Added

- Biome as the lint + format gate (`pnpm check` / `check:fix`, `lint`, `format`),
  wired into CI as a `quality` job and into `prepublishOnly`.
- v8 code coverage (`pnpm test:coverage`, `@vitest/coverage-v8`) generated in the
  Postgres CI job so the cross-engine and down-swap paths are measured.
- Security workflow: `pnpm audit --audit-level high` plus CodeQL on every push/PR
  and a weekly cron.

### Changed

- Node engine floor is `>=22` and the CI matrix runs Node 22/24 (18/20 are past
  EOL and vitest 4 pulls `styleText` from `node:util`, 20.12+ only).

Correctness, scalability and packaging hardening pass.

### Added

- Read-your-writes: `get()` consults the pending buffer (tombstone aware) before
  hitting the engine.
- Circuit breaker half-open recovery with `recoverAfter` / `autoRecover` and an
  `onStateChange` hook; failed flush groups requeue with bounded jittered backoff.
- Graceful shutdown on SIGINT, SIGTERM and `beforeExit` without the library ever
  calling `process.exit()`.
- Table-level enumeration (`keys` / `values` / `entries` / `startsWith` / `count`
  / `deleteAll`) and convenience methods (`has` / `add` / `sub` / `push` /
  `unshift` / `pop` / `shift` / `pull`) on the fluent chain.
- Observability hooks (`onFlushError` / `onTrip` / `onDrop` / `onBackpressure`).

### Changed

- Chunked, streaming engine swap => peak memory is one chunk, per-table journalled
  resume; foreign schema/table names are skipped and reported, not aborted on.
- Bulk multi-row upserts on Postgres, chunked/yielding SQLite flush, unref'd flush
  timer => the only wall is database storage.
- Value integrity aligned across both engines (`undefined` / NaN / NUL policy).
- Drivers (`better-sqlite3`, `pg`) are lazily imported optional peer dependencies.

## [0.1.0] - 2026-08-20

Initial pre-release of the universal SQLite/PostgreSQL DAL.

### Added

- Single fluent API that works the same regardless of which engine is running.
- Write collector => buffers writes in RAM and flushes in bulk.
- Circuit breaker => trips to read-only mode on a Postgres outage instead of
  crashing, then recovers.
- Bidirectional engine swap => migrate data SQLite files <=> PostgreSQL schemas.

[Unreleased]: https://github.com/creative-softworks/sql-switch/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/creative-softworks/sql-switch/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/creative-softworks/sql-switch/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/creative-softworks/sql-switch/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/creative-softworks/sql-switch/releases/tag/v0.1.0
