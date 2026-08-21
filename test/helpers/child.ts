/**
 * @packageDocumentation
 * Test helper => run a fixture in its own process.
 *
 * Some behaviour only exists at process level: whether a signal actually drains the buffer, whether
 * the library re-raises it instead of calling `process.exit()`, whether an idle process can exit at
 * all. None of that can be checked inside the test runner (re-raising a signal would take the worker
 * down with it), so those tests spawn a real child & assert on how it died.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/** How a fixture process ended. */
export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** true when it ended on its own => we never had to kill it */
  selfexit: boolean;
}

export interface RunOptions {
  /** Fires the first time the fixture prints `ready` => where a test sends its signal. */
  onReady?: (child: ChildProcess) => void;
  /** SIGKILL backstop in ms, so a hang comes back as `selfexit: false` instead of a test timeout. */
  patience?: number;
}

/**
 * Run `test/fixtures/<file>` in a fresh process & resolve with how it ended.
 *
 * tsx is loaded through `--import`, not run as the `tsx` CLI => the CLI re-spawns node as a
 * grandchild, so a signal would land on the wrapper & never reach the process holding the buffer.
 */
export function runfixture(
  file: string,
  args: string[],
  opts: RunOptions = {},
): Promise<ChildExit> {
  const fixture = path.join(import.meta.dirname, '..', 'fixtures', file);
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let ready = false;
    let selfexit = true;

    const backstop = setTimeout(() => {
      selfexit = false;
      child.kill('SIGKILL');
    }, opts.patience ?? 5_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!ready && stdout.includes('ready')) {
        ready = true;
        opts.onReady?.(child);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(backstop);
      resolve({ code, signal, stdout, stderr, selfexit });
    });
  });
}
