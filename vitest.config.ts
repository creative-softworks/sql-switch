import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // better-sqlite3 is a native sync binding & a few tests drive real timers / signals =>
    // forks gives every file its own process so a wedged handle can't bleed into the next one
    pool: 'forks',
    // native sqlite writes plus the large N tests need more than the 5s default
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // text-summary lands in the job log, json-summary/lcov feed tooling, html is browsable
      reporter: ['text', 'text-summary', 'json-summary', 'lcov', 'html'],
      reportsDirectory: './coverage',
      // only the shipped library counts => scripts/ are CLI glue & test/ is the harness itself.
      // vitest 4 dropped the `all` key => naming `include` already reports zero-hit files, so an
      // untested module still shows at 0% instead of silently dropping off the report
      include: ['src/**/*.ts'],
      // thresholds are deliberately unset until the first CI run establishes a baseline => the pg
      // runtime paths & swapDown only run in the DATABASE_URL job, so a matrix only number would
      // read misleadingly low. tighten them in the coverage PR once the down swap test (T1) lands.
    },
  },
});
