/**
 * @packageDocumentation
 * Small timing helpers for the collector tests => the flush timer is real, so a few tests have to
 * wait for it rather than fake it.
 */

/** Sleep for `ms`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `condition` until it's true or `timeout` runs out.
 *
 * @throws if the condition never became true => the test fails on the wait itself, with the
 * label, instead of on a confusing assertion further down.
 */
export async function waitfor(
  label: string,
  condition: () => boolean,
  timeout = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`timed out after ${timeout}ms waiting for: ${label}`);
}
