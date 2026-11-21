// WP04-06 R-1 — Read-only repository factory.
//
// The recovery scanner must read V1 state without ever gaining a write path.
// This module reduces an already-connected, write-capable Mongoose model or raw
// driver collection to the single `findBounded(filter, projection, { limit })`
// primitive the WP04-03 adapter is allowed to call.
//
// Guarantees:
//   * the returned repository exposes EXACTLY ONE enumerable key: findBounded;
//   * the caller-supplied handle (model/collection) is captured in a closure and
//     is never reachable from the returned object;
//   * every query carries an explicit, caller-bounded limit; a result larger than
//     the requested limit is reported as `truncated` so the adapter fails closed;
//   * server-side-JavaScript and write/stage operators are rejected outright;
//   * projections must be a single consistent inclusion/exclusion shape;
//   * BSON ObjectIds are normalized to `{ $oid: "<24 hex>" }` in returned
//     documents so the adapter and evidence projection can keep identifier type;
//   * no connection, database, or environment access happens here. The caller
//     injects the handle and owns the connection lifecycle.
//
// This module does not classify findings, persist anything, or create tasks.

export const REPOSITORY_VERSION = "wp04-readonly-repository-v1";

// Large enough for every WP04-03 adapter ceiling (maxInventoryItems = 5000),
// small enough that a runaway scan fails closed instead of exhausting memory.
export const DEFAULT_MAX_LIMIT = 5000;
export const HARD_MAX_LIMIT = 10000;

export class RepositoryError extends Error {
  /**
   * @param {string} code Stable error code.
   * @param {string|null} [field] Offending field/handle.
   * @param {string} [message] Safe message with no document payload.
   */
  constructor(code, field = null, message = code) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message) {
  throw new RepositoryError(code, field, message || code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Operators that execute server-side JavaScript or write/mutate state. A read
// path never needs them, and accepting them would let a filter escape the
// bounded, read-only contract.
const FORBIDDEN_OPERATORS = Object.freeze([
  "$where",
  "$function",
  "$accumulator",
  "$expr",
  "$jsonSchema",
  "$out",
  "$merge",
  "$lookup",
  "$graphLookup",
  "$unionWith",
  "$mergeObjects",
]);

const FORBIDDEN_OPERATOR_SET = new Set(FORBIDDEN_OPERATORS);

function assertNoForbiddenOperator(value, field) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenOperator(entry, `${field}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_OPERATOR_SET.has(key)) {
      fail("FORBIDDEN_OPERATOR", `${field}.${key}`, `operator ${key} is not permitted`);
    }
    assertNoForbiddenOperator(nested, `${field}.${key}`);
  }
}

function normalizeLimit(value, maximum, field) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("INVALID_LIMIT", field, `${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function assertFilter(filter) {
  if (!isPlainObject(filter)) {
    fail("INVALID_FILTER", "filter", "filter must be a plain object");
  }
  assertNoForbiddenOperator(filter, "filter");
  return filter;
}

function assertProjection(projection) {
  if (!isPlainObject(projection)) {
    fail("INVALID_PROJECTION", "projection", "projection must be a plain object");
  }
  if (Object.keys(projection).length === 0) {
    fail("INVALID_PROJECTION", "projection", "projection must not be empty");
  }
  let mode = null;
  const visit = (node, path, topLevel) => {
    const entries = Object.entries(node);
    if (entries.length === 0) {
      fail(
        "INVALID_PROJECTION",
        `projection.${path}`,
        "projection documents must not be empty",
      );
    }
    for (const [key, value] of entries) {
      const field = path.length === 0 ? key : `${path}.${key}`;
      if (key.startsWith("$")) {
        fail(
          "INVALID_PROJECTION",
          `projection.${field}`,
          "projection keys must be field paths",
        );
      }
      if (isPlainObject(value)) {
        visit(value, field, false);
        continue;
      }
      if (value !== 0 && value !== 1 && value !== false && value !== true) {
        fail(
          "INVALID_PROJECTION",
          `projection.${field}`,
          "projection values must be 0/1 or true/false",
        );
      }
      if (topLevel && key === "_id") continue;
      const inclusion = value === 1 || value === true;
      if (mode === null) mode = inclusion;
      else if (mode !== inclusion) {
        fail(
          "INVALID_PROJECTION",
          `projection.${field}`,
          "projection cannot mix inclusion and exclusion fields",
        );
      }
    }
  };
  visit(projection, "", true);
  return projection;
}

function assertSort(sort) {
  if (sort === undefined || sort === null) return null;
  if (!isPlainObject(sort)) {
    fail("INVALID_SORT", "sort", "sort must be a plain object");
  }
  const out = {};
  for (const [key, value] of Object.entries(sort)) {
    if (key.startsWith("$")) {
      fail("INVALID_SORT", `sort.${key}`, "sort keys must be field paths");
    }
    if (value !== 1 && value !== -1) {
      fail("INVALID_SORT", `sort.${key}`, "sort values must be 1 or -1");
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function objectIdHex(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (value._bsontype === "ObjectId" && typeof value.toHexString === "function") {
    const hex = value.toHexString();
    if (typeof hex === "string" && /^[0-9a-fA-F]{24}$/.test(hex)) return hex.toLowerCase();
    return null;
  }
  return null;
}

/**
 * Deep-normalize a returned document. BSON ObjectIds become `{ $oid }` tags so
 * the adapter can preserve identifier type; Dates and primitives are unchanged.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function normalizeDocument(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => normalizeDocument(entry)));
  if (typeof value !== "object") return value;
  const hex = objectIdHex(value);
  if (hex !== null) return Object.freeze({ $oid: hex });
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = normalizeDocument(nested);
  }
  return Object.freeze(out);
}

/**
 * Translate `{ $oid }` tags back into driver ObjectIds for the query filter.
 * Everything else is copied structurally.
 *
 * @param {unknown} value
 * @param {Function} ObjectIdConstructor
 * @returns {unknown}
 */
export function toDriverValue(value, ObjectIdConstructor) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map((entry) => toDriverValue(entry, ObjectIdConstructor));
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$oid" && typeof value.$oid === "string") {
    return new ObjectIdConstructor(value.$oid);
  }
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = toDriverValue(nested, ObjectIdConstructor);
  }
  return out;
}

function assertFindResult(result, name, limit) {
  const docs = Array.isArray(result) ? result : result?.docs;
  if (!Array.isArray(docs)) {
    fail("INVALID_FIND_RESULT", name, `${name}.find must return an array of documents`);
  }
  const truncated = result && result.truncated === true;
  if (docs.length > limit) {
    return Object.freeze({ docs: Object.freeze(docs.slice(0, limit)), truncated: true });
  }
  if (truncated) {
    return Object.freeze({ docs: Object.freeze(docs.slice(0, limit)), truncated: true });
  }
  return Object.freeze({ docs: Object.freeze(docs), truncated: false });
}

/**
 * Reduce an injected read function to a frozen, read-only `findBounded`.
 *
 * @param {{
 *   name: string,
 *   find: (filter: Object, projection: Object, limit: number) => Promise<Array<Object>>|Array<Object>,
 *   maxLimit?: number,
 * }} config
 * @returns {Readonly<{ findBounded: Function }>}
 */
export function createReadOnlyRepository(config) {
  if (!isPlainObject(config)) {
    fail("INVALID_CONFIG", "config", "config must be a plain object");
  }
  const { name, find } = config;
  if (typeof name !== "string" || name.length === 0) {
    fail("INVALID_NAME", "name", "name must be a non-empty string");
  }
  if (typeof find !== "function") {
    fail("INVALID_FIND", "find", "find must be a function");
  }
  const maxLimit = normalizeLimit(
    config.maxLimit ?? DEFAULT_MAX_LIMIT,
    HARD_MAX_LIMIT,
    "maxLimit",
  );

  const findBounded = async function findBounded(filter, projection, options = {}) {
    const safeFilter = assertFilter(filter);
    const safeProjection = assertProjection(projection);
    if (!isPlainObject(options)) {
      fail("INVALID_OPTIONS", "options", "options must be a plain object");
    }
    const limit = normalizeLimit(options.limit, maxLimit, "options.limit");
    const sort = assertSort(options.sort);
    // Ask for one extra document to detect truncation without a count query.
    const raw = await find(safeFilter, safeProjection, limit + 1, sort);
    const result = assertFindResult(raw, name, limit);
    const normalized = result.docs.map((doc) => normalizeDocument(doc));
    return Object.freeze({
      docs: Object.freeze(normalized),
      truncated: result.truncated,
    });
  };

  return Object.freeze({ findBounded });
}

/**
 * Bridge a Mongoose model. The model reference stays in the closure; only
 * `findBounded` is returned.
 *
 * @param {{ name: string, model: Object, maxLimit?: number }} config
 * @returns {Readonly<{ findBounded: Function }>}
 */
export function createMongooseRepository(config) {
  if (!isPlainObject(config)) {
    fail("INVALID_CONFIG", "config", "config must be a plain object");
  }
  const { model } = config;
  if (model === null || typeof model !== "object" || typeof model.find !== "function") {
    fail("INVALID_MODEL", "model", "model must expose find()");
  }
  const ObjectIdConstructor = model?.base?.Types?.ObjectId ?? model?.db?.base?.Types?.ObjectId;
  if (typeof ObjectIdConstructor !== "function") {
    fail("INVALID_MODEL", "model", "model must expose base.Types.ObjectId");
  }
  return createReadOnlyRepository({
    name: config.name,
    maxLimit: config.maxLimit,
    find: (filter, projection, limit, sort) => {
      const query = model.find(
        toDriverValue(filter, ObjectIdConstructor),
        toDriverValue(projection, ObjectIdConstructor),
      );
      if (sort !== null) query.sort(sort);
      return query.limit(limit).lean().exec();
    },
  });
}

/**
 * Bridge a raw driver collection. `collection` stays in the closure; only
 * `findBounded` is returned.
 *
 * @param {{ name: string, collection: Object, ObjectId: Function, maxLimit?: number }} config
 * @returns {Readonly<{ findBounded: Function }>}
 */
export function createDriverCollectionRepository(config) {
  if (!isPlainObject(config)) {
    fail("INVALID_CONFIG", "config", "config must be a plain object");
  }
  const { collection, ObjectId: ObjectIdConstructor } = config;
  if (collection === null || typeof collection !== "object" || typeof collection.find !== "function") {
    fail("INVALID_COLLECTION", "collection", "collection must expose find()");
  }
  if (typeof ObjectIdConstructor !== "function") {
    fail("INVALID_OBJECTID", "ObjectId", "ObjectId constructor must be a function");
  }
  return createReadOnlyRepository({
    name: config.name,
    maxLimit: config.maxLimit,
    find: async (filter, projection, limit, sort) => {
      const cursor = collection
        .find(toDriverValue(filter, ObjectIdConstructor), {
          projection: toDriverValue(projection, ObjectIdConstructor),
        })
        .limit(limit);
      if (sort !== null) cursor.sort(sort);
      return cursor.toArray();
    },
  });
}

/**
 * Build the four read-only repositories the adapter requires.
 *
 * @param {{ orders: Object, reservations: Object, movements: Object, inventory: Object, indexEvidence?: Object }} handles
 * @returns {Readonly<Object>}
 */
export function createReadOnlyRepositories(handles) {
  if (!isPlainObject(handles)) {
    fail("INVALID_HANDLES", "handles", "handles must be a plain object");
  }
  const repositories = {
    orders: handles.orders,
    reservations: handles.reservations,
    movements: handles.movements,
    inventory: handles.inventory,
  };
  for (const [name, repository] of Object.entries(repositories)) {
    if (repository === null || typeof repository?.findBounded !== "function") {
      fail("INVALID_REPOSITORY", name, `${name} must expose findBounded`);
    }
  }
  const frozen = { ...repositories };
  if (handles.indexEvidence !== undefined && handles.indexEvidence !== null) {
    frozen.indexEvidence = handles.indexEvidence;
  }
  return Object.freeze(frozen);
}
