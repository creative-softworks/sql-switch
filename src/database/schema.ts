/**
 * @packageDocumentation
 * Drizzle ORM table definitions — strictly two-column KV store shared by both drivers.
 *
 * Schema: `id TEXT PRIMARY KEY, value JSONB/TEXT`
 * - `id`    — the lookup key (e.g. `guild_123`, `user_456`)
 * - `value` — the data payload; JSONB in Postgres, TEXT (JSON-serialised) in SQLite
 *
 * @remarks
 * A flat two-column model is used intentionally. A multi-column relational schema would
 * require a full type-translation matrix for every field when migrating SQLite ↔ Postgres
 * (type affinity vs strict typing). One `value` column sidesteps all of that.
 */

import { pgSchema, text, jsonb } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core';

/**
 * Build a Drizzle SQLite table definition for a given table name.
 * `value` is stored as `JSON.stringify`'d TEXT since SQLite has no native JSON column.
 *
 * @param tableName - Table name. Must match `^[a-zA-Z0-9_-]+$`.
 */
export function buildSqliteTable(tableName: string) {
  return sqliteTable(tableName, {
    id: sqliteText('id').primaryKey(),
    // stored as JSON.stringify'd string — parsed back to object on read
    value: sqliteText('value').notNull(),
  });
}

/**
 * Build a Drizzle Postgres table inside a named logical schema.
 * `value` uses `JSONB` for efficient binary storage & GIN indexing support.
 *
 * @param schemaName - Postgres logical schema (e.g. `antinuke`). Must match `^[a-zA-Z0-9_-]+$`.
 * @param tableName  - Table name inside that schema (e.g. `settings`).
 */
export function buildPgTable(schemaName: string, tableName: string) {
  const schema = pgSchema(schemaName);
  return schema.table(tableName, {
    id: text('id').primaryKey(),
    // JSONB => binary-encoded JSON, faster to query & supports GIN partial-path indexing
    value: jsonb('value').notNull(),
  });
}
