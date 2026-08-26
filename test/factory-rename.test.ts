/**
 * @packageDocumentation
 * 2.0 => the factory was renamed `createDAL` -> `sqlSwitch`. `createDAL` stays as a one-line
 * `@deprecated` alias (removed in 3.0) and the default export follows `sqlSwitch`.
 *
 * These assertions never `connect()`, so they build no driver => safe to run in any environment.
 */

import { describe, expect, it } from 'vitest';
import sqlSwitchDefault, { sqlSwitch, createDAL } from '../src/database/index.js';

describe('factory rename', () => {
  it('exposes sqlSwitch as the factory', () => {
    const db = sqlSwitch();
    // the reconnect() primitive is part of the 2.0 surface
    expect(typeof db.reconnect).toBe('function');
    expect(typeof db.connect).toBe('function');
  });

  it('keeps createDAL as an alias for the same function', () => {
    expect(createDAL).toBe(sqlSwitch);
  });

  it('defaults the export to sqlSwitch', () => {
    expect(sqlSwitchDefault).toBe(sqlSwitch);
  });
});
