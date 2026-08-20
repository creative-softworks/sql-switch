/**
 * @packageDocumentation
 * All custom error classes for sql-switch.
 * Every error carries a `code` string for programmatic handling.
 */

/**
 * Thrown when the write collector circuit breaker trips — either the pending
 * buffer hit the 5000-key cap or the database became unreachable.
 * The app should catch this and enter a graceful read-only mode.
 *
 * @example
 * ```ts
 * try {
 *   await db.schema("economy").table("balances").key(userId).set({ coins: 100 });
 * } catch (err) {
 *   if (err instanceof DatabaseUnavailableError) enterReadOnlyMode();
 * }
 * ```
 */
export class DatabaseUnavailableError extends Error {
  readonly code = 'DATABASE_UNAVAILABLE' as const;
  constructor(message?: string) {
    super(message ?? 'database unavailable — circuit breaker tripped, entering read-only mode');
    this.name = 'DatabaseUnavailableError';
  }
}

/**
 * Thrown when a schema or table name fails the `^[a-zA-Z0-9_-]+$` constraint.
 * Spaces & special characters are rejected to keep file names & Postgres schema names safe.
 */
export class InvalidNameError extends Error {
  readonly code = 'INVALID_NAME' as const;
  constructor(kind: 'schema' | 'table', name: string) {
    super(`invalid ${kind} name "${name}" — only letters, numbers, hyphens & underscores allowed`);
    this.name = 'InvalidNameError';
  }
}

/**
 * Thrown when `db.connect()` receives invalid or inconsistent config
 * (e.g. missing connectionString in cloud mode, or invalid collector time).
 */
export class ConfigurationError extends Error {
  readonly code = 'CONFIGURATION_ERROR' as const;
  constructor(message: string, options?: ErrorOptions) {
    // forward `cause` when given => a wrapped module-not-found keeps its original stack for debugging
    super(message, options);
    this.name = 'ConfigurationError';
  }
}

/**
 * Thrown when a read or write is attempted before `db.connect()` is called.
 */
export class NotConnectedError extends Error {
  readonly code = 'NOT_CONNECTED' as const;
  constructor() {
    super('call db.connect() before performing any operations');
    this.name = 'NotConnectedError';
  }
}

/**
 * Thrown when a value (or a key) can't be stored the same way by both engines.
 *
 * Covers the payloads `JSON.stringify` is happy to mangle — `undefined`, `NaN`, `Infinity` — plus
 * NUL (`\u0000`), which SQLite keeps as TEXT and Postgres JSONB rejects outright. Also the older
 * two: circular references & BigInt.
 *
 * @remarks
 * Extends `TypeError` on purpose => `set()` has always thrown a `TypeError` for a value it can't
 * serialize, so anything catching that keeps working, and new code gets `err.code` &
 * `instanceof InvalidValueError` to branch on.
 *
 * @example
 * ```ts
 * try {
 *   await db.schema('economy').table('balances').key(userId).set({ coins: total });
 * } catch (err) {
 *   // total came out NaN => the write was refused instead of storing null
 *   if (err instanceof InvalidValueError) logger.warn(err.message);
 * }
 * ```
 */
export class InvalidValueError extends TypeError {
  readonly code = 'INVALID_VALUE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidValueError';
  }
}
