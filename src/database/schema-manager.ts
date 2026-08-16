/**
 * @packageDocumentation
 * Name validation & schema/table routing context.
 *
 * The `.schema()` / `.table()` chain resolves to either a physical `.db` file (SQLite)
 * or a Postgres logical schema. Either way the name lands in a file path or a SQL
 * identifier, so it gets validated hard before it goes anywhere near the driver.
 */

import { InvalidNameError } from './errors.js';

/**
 * Allowed characters for schema & table names.
 * Letters, numbers & hyphens only => safe as both a file name & a Postgres identifier.
 * No spaces, no dots, no quotes, nothing that could break out of an identifier.
 */
export const NAME_PATTERN = /^[a-zA-Z0-9-]+$/;

/**
 * Validate a schema or table name against {@link NAME_PATTERN}.
 *
 * @param kind - Whether this is a `schema` or `table` name (used in the error message).
 * @param name - The name to check.
 * @throws {@link InvalidNameError} if the name is empty or contains disallowed characters.
 *
 * @example
 * ```ts
 * validateName('schema', 'antinuke');    // ok
 * validateName('schema', 'anti nuke');   // throws InvalidNameError
 * validateName('table', 'settings; DROP'); // throws InvalidNameError
 * ```
 */
export function validateName(kind: 'schema' | 'table', name: string): void {
  if (typeof name !== 'string' || name.length === 0 || !NAME_PATTERN.test(name)) {
    throw new InvalidNameError(kind, String(name));
  }
}

/**
 * A resolved `{ schema, table }` pair. Both names are validated on construction,
 * so anything downstream can treat them as safe identifiers.
 */
export class TableContext {
  constructor(
    readonly schema: string,
    readonly table: string,
  ) {
    validateName('schema', schema);
    validateName('table', table);
  }

  /** `schema:table` — used as the cache key for table-creation bookkeeping. */
  toString(): string {
    return `${this.schema}:${this.table}`;
  }
}
