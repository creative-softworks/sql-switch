/**
 * @packageDocumentation
 * Bidirectional engine-swap CLI.
 *
 * Thin wrapper around {@link engineSwap} from the library => the migration logic itself lives
 * in `src/database/engine-swap.ts` so the CLI and the programmatic API can't drift apart.
 * This file only parses flags and wires stdin prompts into the conflict handler.
 *
 * ```bash
 * npm run db:engine-swap -- --up   --url postgres://user:pass@host:5432/mydb
 * npm run db:engine-swap -- --down --url postgres://user:pass@host:5432/mydb
 * ```
 *
 * Flags:
 * - `--up` / `--down`   direction (required)
 * - `--url <conn>`      Postgres connection string (falls back to `DATABASE_URL`)
 * - `--dir <path>`      SQLite data directory (default `./data/databases`)
 * - `--keep`            upward only: keep local `.db` files instead of deleting them
 * - `--yes`             auto-answer Y to every overwrite prompt (non-interactive/CI)
 *
 * Both directions only touch schema & table names matching `^[a-zA-Z0-9_-]+$` (checked before a
 * name reaches a file path or a SQL identifier) and prompt before overwriting existing data.
 * Anything else in the same directory or database is listed as skipped & left exactly as it was =>
 * pointing this at a database shared with another app is safe, it just won't move that app's data.
 *
 * `Ctrl-C`/`SIGTERM` stops at the next table boundary rather than mid table, leaves a resume
 * journal in the data dir & exits non zero => rerun the same command to finish the migration.
 */

import readline from 'node:readline';
import { engineSwap } from '../src/database/index.js';
import type { EngineSwapOptions, SwapConflict } from '../src/database/index.js';

interface CliOptions {
  direction: 'up' | 'down';
  url: string | undefined;
  dataDir: string;
  keepLocalFiles: boolean;
  assumeYes: boolean;
}

function fail(message: string): never {
  console.error(`[engine-swap] ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
  const up = argv.includes('--up');
  const down = argv.includes('--down');

  if (up === down) {
    // covers both "neither given" & "both given"
    fail('specify exactly one direction => --up (SQLite to Postgres) or --down (Postgres to SQLite)');
  }

  // reads the value after a flag => guards against the flag being last with no value
  const flagValue = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`${flag} requires a value`);
    }
    return value;
  };

  return {
    direction: up ? 'up' : 'down',
    // left undefined => engineSwap falls back to DATABASE_URL & errors if that's missing too
    url: flagValue('--url'),
    dataDir: flagValue('--dir') ?? './data/databases',
    // default is to clean up local files after a successful upward migration
    keepLocalFiles: argv.includes('--keep'),
    assumeYes: argv.includes('--yes'),
  };
}

/** Ask a Y/N question on stdin. Auto-returns true when `--yes` was passed. */
function confirm(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) {
    console.log(`${question} (Y/N) => auto-yes`);
    return Promise.resolve(true);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (Y/N) `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const swapOptions: EngineSwapOptions = {
    direction: opts.direction,
    dataDir: opts.dataDir,
    keepLocalFiles: opts.keepLocalFiles,
    onProgress: (line) => console.log(`[engine-swap] ${line}`),
    // interactive prompt per target, exactly like the old inline behaviour
    onConflict: (conflict: SwapConflict) => {
      const target =
        conflict.kind === 'table' ? `${conflict.schema}.${conflict.table}` : `${conflict.schema}.db`;
      return confirm(
        `[engine-swap] leftover data detected in ${target}. Overwrite with new data?`,
        opts.assumeYes,
      );
    },
  };

  // only set it when given => undefined would defeat the DATABASE_URL fallback
  if (opts.url !== undefined) swapOptions.connectionString = opts.url;

  const result = await engineSwap(swapOptions);

  console.log(
    `[engine-swap] ${result.totalRows} row(s) across ${result.tables.length} table(s)` +
      `${result.skipped > 0 ? `, ${result.skipped} target(s) skipped` : ''}`,
  );

  if (result.skippedNames.length > 0) {
    console.log(
      `[engine-swap] left alone (not addressable by this DAL): ${result.skippedNames.join(', ')}`,
    );
  }

  // non zero on an interrupted run => a CI step or a shell `&&` chain shouldn't read a partial
  // migration as a finished one
  if (result.aborted) {
    console.error('[engine-swap] stopped early => rerun the same command to resume');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[engine-swap] migration failed:', err);
  process.exit(1);
});
