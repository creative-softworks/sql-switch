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
  },
});
