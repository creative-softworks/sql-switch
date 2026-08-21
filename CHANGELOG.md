# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While it's pre-1.0, minor versions may carry breaking changes.

## [Unreleased]

## [0.2.0] - 2026-08-21

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

[Unreleased]: https://github.com/creative-softworks/sql-switch/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/creative-softworks/sql-switch/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/creative-softworks/sql-switch/releases/tag/v0.1.0
