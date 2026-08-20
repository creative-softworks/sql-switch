/**
 * @packageDocumentation
 * One rule for what a value may be, applied before either engine sees it.
 *
 * `value` is TEXT holding JSON on SQLite and JSONB on Postgres, and the two don't agree on every
 * payload. Rather than teach each driver its own dialect quirks, everything is checked here, in the
 * fluent layer => a write that succeeds locally succeeds in production, and one that's refused is
 * refused in both places with the same error.
 *
 * What gets refused & why:
 * - `undefined` => `JSON.stringify` returns the JS value `undefined`, not a string. It used to slip
 *   through a serializability check and surface much later as a `NOT NULL` violation inside a flush,
 *   where the only trace was a `console.error`.
 * - `NaN` / `Infinity` / `-Infinity` => serialize to the string `"null"`. The write "succeeds" and
 *   the value comes back as `null`, which is silent corruption. Nested is the common case (a
 *   division that went wrong deep inside a payload).
 * - NUL (`\u0000`) in any string, in a value or a property name => valid JSON, stored happily by
 *   SQLite as TEXT, and rejected outright by Postgres JSONB (`unsupported Unicode escape sequence`).
 *   That's the sharpest cross dialect landmine in the project: same code, same value, works on your
 *   laptop & throws in cloud mode, and an up-swap of that row dies mid migration.
 * - Circular references & BigInt => `JSON.stringify` throws, as it always did.
 *
 * What stays allowed: `null`, `0`, `''`, `false` (all of them mean something), and `undefined` as an
 * object *property*, which JSON has always dropped — optional fields are everywhere in real
 * payloads, so rejecting those would make the library unusable.
 */

import { InvalidValueError } from '../errors.js';

/** the code point both engines disagree about */
const NUL = '\u0000';

/** what to call the offending spot in an error => the property name, or the value itself */
function where(key: string, root: boolean): string {
  return root ? 'the value' : `property "${key}"`;
}

/**
 * Validate & serialize a value in one pass.
 *
 * @param value - Anything the caller passed to `set()`.
 * @returns The JSON text, which the caller hands to the collector so nothing serializes twice.
 * @throws {@link InvalidValueError} for a value neither engine can store the same way.
 *
 * @remarks
 * The checks ride along on the `JSON.stringify` the write path already did (a replacer sees every
 * node exactly once), so this is one pass over the value, not two => same O(size) as serializing
 * it, with a function call per node as the added constant.
 * @internal
 */
export function serializeValue(value: unknown): string {
  // the replacer is called for the root first (key `''`), then depth first for everything under it
  let root = true;

  let json: string | undefined;
  try {
    json = JSON.stringify(value, function (this: unknown, key: string, node: unknown): unknown {
      const atroot = root;
      root = false;

      // undefined / a function / a symbol turns into `null` when it sits in an array (JSON has no
      // hole to leave), which is the same silent null-corruption we refuse NaN for. as an *object*
      // property JSON just drops it, which is intentional & fine (optional fields), so only throw
      // when the holder is an array => `this` is whatever object JSON is currently walking
      if (
        Array.isArray(this) &&
        (node === undefined || typeof node === 'function' || typeof node === 'symbol')
      ) {
        const kind = node === undefined ? 'undefined' : typeof node;
        throw new InvalidValueError(
          `cannot store ${kind} inside an array (at ${where(key, atroot)}) => it comes back as` +
            ' null, which is corruption nobody gets told about. put null there explicitly if that' +
            ' is what you mean',
        );
      }

      if (typeof node === 'number' && !Number.isFinite(node)) {
        throw new InvalidValueError(
          `cannot store ${String(node)} at ${where(key, atroot)} => it would come back as null,` +
            ' which is corruption nobody gets told about. store null or a string instead',
        );
      }

      if (key.includes(NUL)) {
        throw new InvalidValueError(
          `cannot store a NUL character in the property name "${key.replace(NUL, '\\u0000')}"` +
            ' => postgres jsonb rejects NUL & sqlite would keep it, so the two engines would' +
            ' disagree. strip or encode it first',
        );
      }

      if (typeof node === 'string' && node.includes(NUL)) {
        throw new InvalidValueError(
          `cannot store a NUL character (\\u0000) at ${where(key, atroot)} => postgres jsonb` +
            ' rejects NUL & sqlite would keep it, so the two engines would disagree. strip or' +
            ' encode it first',
        );
      }

      return node;
    });
  } catch (err) {
    if (err instanceof InvalidValueError) throw err;
    // circular refs & BigInt land here, same wording & same TypeError as before
    throw new InvalidValueError(
      `cannot serialize value for storage: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // undefined (& a bare function or symbol) serializes to no JSON at all, which the `value NOT
  // NULL` column can't take. quick.db refuses these up front too, it's the friendlier answer
  if (json === undefined) {
    throw new InvalidValueError(
      `cannot store ${typeof value} => pass null if you mean an empty value, or delete() the key`,
    );
  }

  return json;
}

/**
 * Check a lookup key can be stored by both engines.
 *
 * @param key - The `id` column value.
 * @throws {@link InvalidValueError} if the key contains NUL.
 *
 * @remarks
 * Same disagreement as a NUL in a value, other column: Postgres refuses a NUL inside a TEXT
 * parameter, SQLite takes it. Keys are arbitrary caller strings (unlike schema & table names, which
 * go through `validateName`), so this is the only guard they get => everything else is fair game.
 * @internal
 */
export function assertStorableKey(key: string): void {
  if (key.includes(NUL)) {
    throw new InvalidValueError(
      'cannot use a key containing a NUL character (\\u0000) => postgres refuses it in a TEXT' +
        ' column & sqlite would keep it, so the two engines would disagree',
    );
  }
}
