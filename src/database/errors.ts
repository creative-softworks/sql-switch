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
 * Thrown when a schema or table name fails the `^[a-zA-Z0-9-]+$` constraint.
 * Spaces & special characters are rejected to keep file names & Postgres schema names safe.
 */
export class InvalidNameError extends Error {
  readonly code = 'INVALID_NAME' as const;
  constructor(kind: 'schema' | 'table', name: string) {
    super(`invalid ${kind} name "${name}" — only letters, numbers & hyphens allowed`);
    this.name = 'InvalidNameError';
  }
}

/**
 * Thrown when `db.connect()` receives invalid or inconsistent config
 * (e.g. missing connectionString in cloud mode, or invalid collector time).
 */
export class ConfigurationError extends Error {
  readonly code = 'CONFIGURATION_ERROR' as const;
  constructor(message: string) {
    super(message);
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
