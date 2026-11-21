// WP04-03 — DB-free test doubles.
//
// These helpers are intentionally small. They implement only the read contract
// the adapter is allowed to use: `findBounded(filter, projection, { limit })`.
// A separate WriteTrap proves that any attempted write or index operation fails
// immediately, and that no such call is made by the adapter or classifier.

export class UnexpectedWriteError extends Error {
  constructor(method) {
    super(`UNEXPECTED_WRITE: ${method}`);
    this.name = "UnexpectedWriteError";
    this.code = "UNEXPECTED_WRITE";
    this.method = method;
  }
}

const WRITE_METHODS = Object.freeze([
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "bulkWrite",
  "createIndex",
  "createIndexes",
  "dropIndex",
  "dropIndexes",
  "syncIndexes",
  "createCollection",
  "dropCollection",
  "dropDatabase",
  "aggregate",
  "watch",
  "transaction",
  "withTransaction",
  "startSession",
]);

/**
 * Every write-capable method throws immediately.
 *
 * @returns {Readonly<Record<string, Function>>}
 */
export function createWriteTrap() {
  const trap = {};
  for (const method of WRITE_METHODS) {
    trap[method] = () => {
      throw new UnexpectedWriteError(method);
    };
  }
  return Object.freeze(trap);
}

/**
 * A connection factory that fails if anything tries to open a connection.
 */
export function createConnectionTrap() {
  const explode = (name) => () => {
    throw new UnexpectedWriteError(name);
  };
  return Object.freeze({
    connect: explode("connect"),
    createConnection: explode("createConnection"),
    model: explode("model"),
    collection: explode("collection"),
    db: explode("db"),
  });
}

export function oid(hex) {
  const normalized = String(hex).replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{1,24}$/.test(normalized)) {
    throw new Error(`oid() expects 1-24 hex characters, received ${String(hex)}`);
  }
  return Object.freeze({ $oid: normalized.padStart(24, "0") });
}

export function iso(value) {
  return new Date(value).toISOString();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function valueKey(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number") return `n:${value}`;
  if (typeof value === "boolean") return `b:${value}`;
  if (value instanceof Date) return `d:${value.toISOString()}`;
  if (isPlainObject(value) && typeof value.$oid === "string") {
    return `o:${value.$oid.toLowerCase()}`;
  }
  if (isPlainObject(value) && typeof value.toHexString === "function") {
    return `o:${value.toHexString().toLowerCase()}`;
  }
  return `j:${JSON.stringify(value)}`;
}

function equals(a, b) {
  return valueKey(a) === valueKey(b);
}

function compareKeys(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function matchesCondition(value, condition) {
  if (isPlainObject(condition) && !Object.prototype.hasOwnProperty.call(condition, "$oid")) {
    if (Object.prototype.hasOwnProperty.call(condition, "$in")) {
      return condition.$in.some((entry) => equals(value, entry));
    }
    if (Object.prototype.hasOwnProperty.call(condition, "$ne")) {
      return !equals(value, condition.$ne);
    }
    if (
      Object.prototype.hasOwnProperty.call(condition, "$gte") ||
      Object.prototype.hasOwnProperty.call(condition, "$lte")
    ) {
      const left = value instanceof Date ? value.toISOString() : value;
      if (Object.prototype.hasOwnProperty.call(condition, "$gte")) {
        const right = condition.$gte instanceof Date ? condition.$gte.toISOString() : condition.$gte;
        if (compareKeys(left, right) < 0) return false;
      }
      if (Object.prototype.hasOwnProperty.call(condition, "$lte")) {
        const right = condition.$lte instanceof Date ? condition.$lte.toISOString() : condition.$lte;
        if (compareKeys(left, right) > 0) return false;
      }
      return true;
    }
  }
  return equals(value, condition);
}

function matches(doc, filter) {
  if (!isPlainObject(filter)) return true;
  for (const [field, condition] of Object.entries(filter)) {
    if (!matchesCondition(doc?.[field], condition)) return false;
  }
  return true;
}

function sortByDocumentId(docs) {
  return [...docs].sort((a, b) =>
    compareKeys(valueKey(a?._id ?? a?.id ?? null), valueKey(b?._id ?? b?.id ?? null)),
  );
}

/**
 * Build one read-only repository. Every call is recorded for assertions.
 *
 * @param {Array<Object>} docs
 * @param {{ name?: string, unsorted?: boolean, limitBias?: number }} [config]
 */
export function createFakeRepository(docs, config = {}) {
  const { name = "repository", unsorted = false, limitBias = 0 } = config;
  const calls = [];
  const repository = {
    findBounded(filter, projection, options = {}) {
      const limit = options.limit;
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error(`${name}.findBounded requires a positive integer limit`);
      }
      calls.push(Object.freeze({ filter, projection, options: Object.freeze({ ...options }) }));
      let selected = docs.filter((doc) => matches(doc, filter));
      selected = sortByDocumentId(selected);
      if (unsorted) selected = [...selected].reverse();
      return selected.slice(0, limit + limitBias);
    },
  };
  Object.defineProperty(repository, "calls", {
    enumerable: true,
    configurable: false,
    get: () => calls,
  });
  Object.defineProperty(repository, "name", {
    enumerable: true,
    configurable: false,
    value: name,
  });
  return Object.freeze(repository);
}

export function createStaticIndexEvidence(state = "UNKNOWN", source = "TEST") {
  return Object.freeze({
    readUniqueIndexEvidence: async () => ({ saleDeductionUnique: state, source }),
  });
}

export function createUnavailableIndexEvidence() {
  return Object.freeze({
    readUniqueIndexEvidence: async () => {
      throw new Error("index metadata unavailable");
    },
  });
}

/**
 * Build all four repositories plus optional index evidence.
 *
 * @param {{
 *   orders?: Array<Object>,
 *   reservations?: Array<Object>,
 *   movements?: Array<Object>,
 *   inventory?: Array<Object>,
 *   indexEvidence?: Object|null,
 *   unsorted?: boolean,
 *   limitBias?: number,
 * }} [config]
 */
export function createFakeRepositories(config = {}) {
  const {
    orders = [],
    reservations = [],
    movements = [],
    inventory = [],
    indexEvidence = null,
    unsorted = false,
    limitBias = 0,
  } = config;
  const repositories = {
    orders: createFakeRepository(orders, { name: "orders", unsorted, limitBias }),
    reservations: createFakeRepository(reservations, {
      name: "reservations",
      unsorted,
      limitBias,
    }),
    movements: createFakeRepository(movements, { name: "movements", unsorted, limitBias }),
    inventory: createFakeRepository(inventory, { name: "inventory", unsorted, limitBias }),
  };
  if (indexEvidence !== null) repositories.indexEvidence = indexEvidence;
  return Object.freeze(repositories);
}
