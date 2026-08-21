# @creative-softworks/sql-switch

Branded alias of [**sql-switch**](https://www.npmjs.com/package/sql-switch) — a universal, hot-swappable database abstraction layer: SQLite in dev, PostgreSQL in prod, one fluent API.

This package re-exports `sql-switch` unchanged. It exists so the library can be installed under the Creative-Softworks scope; the code, versions and docs all live in the main package.

```bash
npm install @creative-softworks/sql-switch
```

```ts
// the short unscoped name resolves too (it's pulled in as a dependency)
import { createDAL } from 'sql-switch';
```

Full documentation: https://github.com/creative-softworks/sql-switch#readme

Everything is identical to `sql-switch` at the same version — see that package for the API, guides and changelog.
