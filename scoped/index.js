// branded alias => the real code lives in the unscoped `sql-switch` package. this file just
// re-exports it, so `@creative-softworks/sql-switch` and `sql-switch` are the exact same API from
// one source of truth (one place bugs get fixed, one version to bump). ESM entry.
export * from 'sql-switch';
export { default } from 'sql-switch';
