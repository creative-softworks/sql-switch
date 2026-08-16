import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/database/index.ts'],
  format: ['cjs', 'esm'],
  // dts handled by tsc directly (see build script) => per-file .d.ts + .d.ts.map
  // tsup's rollup-based dts bundler merges everything into one file & drops declaration maps
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node18',
  outDir: 'dist',
  // mark runtime deps as external so consumers install their own copies
  external: ['better-sqlite3', 'pg', 'drizzle-orm'],
});
