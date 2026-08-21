/**
 * @packageDocumentation
 * NEW-13 => `import 'sql-switch'` must not drag BOTH drivers in with it.
 *
 * the two engines are optional peer deps loaded with a lazy `await import()` inside connect(). but
 * each driver module has a top-level `import pg` / `import better-sqlite3`, so with tsup's
 * `splitting: false` esbuild inlined the whole driver into the entry chunk & HOISTED those imports to
 * module scope => a SQLite-only app crashed on `import 'sql-switch'` with "Cannot find module 'pg'".
 * `splitting: true` keeps each driver as its own chunk, so the driver import only fires when that
 * engine is picked. this guards the built artifact so a flip back to `splitting: false` goes red.
 *
 * reads dist => only meaningful after a build. CI's `test` job builds before `pnpm test`, so it runs
 * there; a fresh checkout with no dist self-skips rather than failing on a missing file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const DRIVERS = ['pg', 'better-sqlite3'];

/** both entrypoints have to keep resolving without either driver present => check both shapes */
const entries = ['index.js', 'index.cjs'];
const built = entries.every((f) => existsSync(resolve(dist, f)));

/**
 * lines that pull a driver in EAGERLY, at import time.
 *
 * esbuild emits module-scope imports/requires at column 0 (`import x from "pg"`, `var p =
 * require("pg")`) & everything inside a function body indented. our lazy driver loads live inside
 * async fns (`await import("pg")`, `Promise.resolve().then(() => require("pg"))`) => always indented.
 * so a driver named on a non-indented import/require line is the hoist we're guarding against, in
 * either module format, without having to hard code esbuild's exact wrapper.
 */
function eagerDriverLoads(src: string): string[] {
  return src.split('\n').filter((line) => {
    if (/^\s/.test(line)) return false; // indented => inside a function => lazy, fine
    if (!/\b(import|require)\b/.test(line)) return false; // a bare string/label mention isn't a load
    return DRIVERS.some((d) => line.includes(`"${d}"`) || line.includes(`'${d}'`));
  });
}

describe.skipIf(!built)('driver imports stay lazy in the built bundle (NEW-13)', () => {
  for (const entry of entries) {
    it(`${entry} pulls neither driver in at module scope`, () => {
      const src = readFileSync(resolve(dist, entry), 'utf8');
      expect(eagerDriverLoads(src)).toEqual([]);
    });

    it(`${entry} still references the drivers lazily (guard isn't vacuous)`, () => {
      // if a bundler change dropped the driver loads entirely the negative check above would pass
      // for the wrong reason => assert the lazy loads are actually still in there
      const src = readFileSync(resolve(dist, entry), 'utf8');
      for (const driver of DRIVERS) expect(src).toContain(driver);
    });
  }
});
