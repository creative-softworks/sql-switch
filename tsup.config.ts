import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/database/index.ts'],
  format: ['cjs', 'esm'],
  // dts handled by tsc directly (see build script) => per-file .d.ts + .d.ts.map
  // tsup's rollup-based dts bundler merges everything into one file & drops declaration maps
  sourcemap: true,
  clean: true,
  // MUST stay true => the drivers are pulled in with a lazy `await import()` inside connect(), but each
  // driver module has a top-level `import pg` / `import better-sqlite3`. with splitting off esbuild
  // inlines the whole driver into the entry chunk & hoists those top-level imports to the top of
  // index.js, so a SQLite-only app suddenly needs `pg` installed just to import us (NEW-13). splitting
  // keeps the dynamically-imported drivers as their own chunks => the driver import only fires when
  // that engine is actually selected. verify BOTH dist/index.js & dist/index.cjs after any build change.
  splitting: true,
  target: 'node18',
  outDir: 'dist',
  // mark runtime deps as external so consumers install their own copies
  external: ['better-sqlite3', 'pg', 'drizzle-orm'],
});
