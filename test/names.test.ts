/**
 * @packageDocumentation
 * #13 => schema & table names may contain underscores. Snowflake-adjacent naming (`guild_settings`,
 * `user_data`) is the common case, and `_` is safe as both a file name & an unquoted-ish Postgres
 * identifier, so it joins letters, numbers & hyphens in {@link NAME_PATTERN}. Everything that could
 * break out of a file path or a SQL identifier (spaces, dots, quotes, semicolons) still throws.
 */

import { describe, expect, it } from 'vitest';
import { NAME_PATTERN, validateName, InvalidNameError } from '../src/database/index.js';

describe('name validation', () => {
  it('allows underscores alongside letters, numbers & hyphens', () => {
    for (const name of ['guild_settings', 'user_data', 'a_1-b', 'plain', 'with-hyphen', '__x__']) {
      expect(NAME_PATTERN.test(name)).toBe(true);
      expect(() => validateName('table', name)).not.toThrow();
    }
  });

  it('still rejects anything that could break an identifier or a path', () => {
    for (const name of ['', 'anti nuke', 'a.b', 'a;DROP', 'a/b', 'a"b', "a'b", 'a$b']) {
      expect(NAME_PATTERN.test(name)).toBe(false);
      expect(() => validateName('schema', name)).toThrow(InvalidNameError);
    }
  });

  it('the error message names underscores as allowed', () => {
    try {
      validateName('table', 'bad name');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidNameError);
      expect((err as Error).message).toContain('underscore');
    }
  });
});
