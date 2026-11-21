// WP04-03 — Injected, read-only V1 evidence adapter.
//
// The adapter never creates a connection and never imports Mongoose or a
// MongoDB driver. Callers inject four narrow repository objects plus an
// optional index-evidence provider. The adapter builds every query filter and
// projection itself; no caller-supplied query object is accepted.
//
// Read-only by construction:
//   * required repository methods are the single `findBounded` read primitive;
//   * repositories exposing write/connection/collection surfaces are rejected;
//   * every query has an explicit limit and, unless bounded by ids, a window;
//   * projection errors are propagated unchanged and never wrapped with payloads;
//   * deployed-index evidence is never assumed. Unknown evidence is reported so
//     the classifier can emit INDEX_ABSENT_SUSPECTED.

import { projectEvidence } from "./evidence.js";
import { classifyBundles } from "./classifier.js";

export const ADAPTER_VERSION = "wp04-adapter-v1";

export const DEFAULT_LIMITS = Object.freeze({
  maxOrders: 200,
  maxDocsPerOrder: 500,
  maxInventoryItems: 1000,
  maxOrphanMovements: 200,
  maxTotalBundles: 2000,
});

export const MAX_LIMITS = Object.freeze({
  maxOrders: 1000,
  maxDocsPerOrder: 2000,
  maxInventoryItems: 5000,
  maxOrphanMovements: 1000,
  maxTotalBundles: 10000,
});

export class AdapterError extends Error {
  /**
   * @param {string} code Stable error code.
   * @param {string|null} [field] Offending field/repository.
   * @param {string} [message] Safe message with no document payload.
   */
  constructor(code, field = null, message = code) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message) {
  throw new AdapterError(code, field, message || code);
}

const ORDER_STATUSES = Object.freeze([
  "PENDING",
  "PREPARING",
  "READY",
  "SERVED",
  "PAYMENT_PENDING",
  "PAID",
  "CANCELLED",
  "ARCHIVED",
]);

const RESERVATION_STATUSES = Object.freeze([
  "NO_INVENTORY",
  "RESERVED",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "CONSUMING",
  "CONSUMED",
  "RELEASED",
]);

const ORDER_STATUS_SET = new Set(ORDER_STATUSES);
const RESERVATION_STATUS_SET = new Set(RESERVATION_STATUSES);
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Write-capable and connection-capable repository keys are refused so a raw
// Mongoose model cannot be passed as a "read-only" repository.
const FORBIDDEN_REPOSITORY_KEYS = Object.freeze([
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
  "connection",
  "db",
  "collection",
  "model",
]);

export const ORDER_PROJECTION = Object.freeze({
  _id: 1,
  orderNumber: 1,
  status: 1,
  paidAt: 1,
  paymentMethod: 1,
  paymentAccountId: 1,
  paymentAccountSnapshot: Object.freeze({ _id: 1 }),
  paymentSubmittedAt: 1,
  paymentSubmittedBy: 1,
  paymentVerifiedAt: 1,
  paymentVerifiedBy: 1,
  paymentRejectedAt: 1,
  paymentRejectedBy: 1,
  preparingAt: 1,
  readyAt: 1,
  servedAt: 1,
  createdAt: 1,
  updatedAt: 1,
  kitchenStatus: 1,
  baristaStatus: 1,
  hotDrinkStatus: 1,
  items: Object.freeze({
    lineId: 1,
    type: 1,
    quantity: 1,
    cancelled: 1,
    cancelledAt: 1,
    components: Object.freeze({
      componentId: 1,
      kind: 1,
      inventoryItemId: 1,
      stockQuantity: 1,
    }),
  }),
});

export const RESERVATION_PROJECTION = Object.freeze({
  _id: 1,
  orderId: 1,
  orderNumber: 1,
  status: 1,
  requirementFingerprint: 1,
  shortageFingerprint: 1,
  items: Object.freeze({
    inventoryItemId: 1,
    requiredQuantity: 1,
    reservedQuantity: 1,
    shortageQuantity: 1,
    consumedQuantity: 1,
  }),
  approval: Object.freeze({
    approvedAt: 1,
    requirementFingerprint: 1,
    shortageFingerprint: 1,
    shortages: Object.freeze({ inventoryItemId: 1, quantity: 1 }),
  }),
  consumedAt: 1,
  consumedTrigger: 1,
  releasedAt: 1,
  releaseReason: 1,
  voids: Object.freeze({
    at: 1,
    phase: 1,
    source: 1,
    lineId: 1,
    station: 1,
    items: Object.freeze({ inventoryItemId: 1, quantity: 1 }),
  }),
});

export const MOVEMENT_PROJECTION = Object.freeze({
  _id: 1,
  refOrderId: 1,
  item: 1,
  type: 1,
  quantity: 1,
  reason: 1,
  idempotencyKey: 1,
  voidedAt: 1,
  voidReason: 1,
  createdAt: 1,
});

export const INVENTORY_PROJECTION = Object.freeze({
  _id: 1,
  currentStock: 1,
  reservedStock: 1,
});

export const RULE_SCOPES = Object.freeze({
  ALL: Object.freeze([...ORDER_STATUSES]),
  D01: Object.freeze(["PAID"]),
  D02: Object.freeze(ORDER_STATUSES.filter((status) => status !== "PAID")),
  D06: Object.freeze([...ORDER_STATUSES]),
  D08: Object.freeze(["CANCELLED", "ARCHIVED"]),
  D09: Object.freeze(["PAYMENT_PENDING", "SERVED", "PAID"]),
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Accept only documented ISO-8601 UTC timestamps. Date objects are accepted and
 * normalized; non-ISO strings and timezone offsets are rejected as ambiguous.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string|null}
 */
export function parseIsoDate(value, field = "date") {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail("INVALID_DATE", field, `${field} is invalid`);
    return value.toISOString();
  }
  if (typeof value !== "string") {
    fail("INVALID_DATE", field, `${field} must be an ISO-8601 UTC string or Date`);
  }
  if (!ISO_UTC_RE.test(value)) {
    fail(
      "INVALID_DATE",
      field,
      `${field} must be ISO-8601 UTC with milliseconds and Z`,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("INVALID_DATE", field, `${field} is not a valid date`);
  }
  return value;
}

/**
 * Normalize an identifier used in an internally built query. Only non-empty
 * strings, safe integers, and 24-hex ObjectId tags are accepted.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string|number|{ $oid: string }|null}
 */
export function normalizeAdapterIdentifier(value, field = "identifier") {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length === 0) fail("INVALID_IDENTIFIER", field, `${field} is empty`);
    if (/^[0-9a-fA-F]{24}$/.test(value)) {
      return Object.freeze({ $oid: value.toLowerCase() });
    }
    fail("INVALID_IDENTIFIER", field, `${field} must be a 24-hex ObjectId string`);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("INVALID_IDENTIFIER", field, `${field} numeric id is not a safe integer`);
    }
    return value;
  }
  if (isPlainObject(value)) {
    if (typeof value.$oid === "string" && /^[0-9a-fA-F]{24}$/.test(value.$oid)) {
      return Object.freeze({ $oid: value.$oid.toLowerCase() });
    }
    if (typeof value.toHexString === "function") {
      const hex = value.toHexString();
      if (typeof hex === "string" && /^[0-9a-fA-F]{24}$/.test(hex)) {
        return Object.freeze({ $oid: hex.toLowerCase() });
      }
    }
    if (value._bsontype === "ObjectId" && typeof value.toString === "function") {
      const hex = value.toString();
      if (typeof hex === "string" && /^[0-9a-fA-F]{24}$/.test(hex)) {
        return Object.freeze({ $oid: hex.toLowerCase() });
      }
    }
  }
  fail("INVALID_IDENTIFIER", field, `${field} is not a supported identifier`);
}

function identifierKey(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number") return `n:${value}`;
  if (isPlainObject(value) && typeof value.$oid === "string") {
    return `o:${value.$oid.toLowerCase()}`;
  }
  return `x:${String(value)}`;
}

function normalizeLimit(value, fallback, maximum, field) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("INVALID_LIMIT", field, `${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function normalizeAdapterOptions(options) {
  if (options === null || options === undefined) options = {};
  if (!isPlainObject(options)) {
    fail("INVALID_OPTIONS", "options", "options must be a plain object");
  }
  const since = parseIsoDate(options.since, "options.since");
  const until = parseIsoDate(options.until, "options.until");
  if (since !== null && until !== null && since > until) {
    fail("INVALID_WINDOW", "options.until", "until must not precede since");
  }
  const ruleScope = options.ruleScope ?? "ALL";
  if (!Object.hasOwn(RULE_SCOPES, ruleScope)) {
    fail("INVALID_RULE_SCOPE", "options.ruleScope", `unknown rule scope ${String(ruleScope)}`);
  }
  const rawOrderIds = options.orderIds ?? [];
  if (!Array.isArray(rawOrderIds)) {
    fail("INVALID_IDENTIFIER", "options.orderIds", "orderIds must be an array");
  }
  const orderIds = rawOrderIds.map((value, index) =>
    normalizeAdapterIdentifier(value, `options.orderIds[${index}]`),
  );
  const includeConsuming =
    options.includeConsuming ?? (ruleScope === "ALL" || ruleScope === "D06");
  const includeOrphans = options.includeOrphans ?? false;
  if (typeof includeConsuming !== "boolean" || typeof includeOrphans !== "boolean") {
    fail("INVALID_OPTIONS", "options", "includeConsuming/includeOrphans must be booleans");
  }
  if (orderIds.length === 0 && since === null) {
    fail(
      "MISSING_SCAN_WINDOW",
      "options.since",
      "a scan window (since) or an explicit orderIds list is required",
    );
  }
  const limits = Object.freeze({
    maxOrders: normalizeLimit(options.maxOrders, DEFAULT_LIMITS.maxOrders, MAX_LIMITS.maxOrders, "options.maxOrders"),
    maxDocsPerOrder: normalizeLimit(
      options.maxDocsPerOrder,
      DEFAULT_LIMITS.maxDocsPerOrder,
      MAX_LIMITS.maxDocsPerOrder,
      "options.maxDocsPerOrder",
    ),
    maxInventoryItems: normalizeLimit(
      options.maxInventoryItems,
      DEFAULT_LIMITS.maxInventoryItems,
      MAX_LIMITS.maxInventoryItems,
      "options.maxInventoryItems",
    ),
    maxOrphanMovements: normalizeLimit(
      options.maxOrphanMovements,
      DEFAULT_LIMITS.maxOrphanMovements,
      MAX_LIMITS.maxOrphanMovements,
      "options.maxOrphanMovements",
    ),
    maxTotalBundles: normalizeLimit(
      options.maxTotalBundles,
      DEFAULT_LIMITS.maxTotalBundles,
      MAX_LIMITS.maxTotalBundles,
      "options.maxTotalBundles",
    ),
  });
  return Object.freeze({
    since,
    until,
    ruleScope,
    orderIds: Object.freeze(orderIds),
    includeConsuming,
    includeOrphans,
    limits,
    indexEvidence: options.indexEvidence ?? null,
  });
}

function assertReadOnlyRepository(repository, name) {
  if (!isPlainObject(repository) && typeof repository !== "object") {
    fail("INVALID_REPOSITORY", name, `${name} repository must be an object`);
  }
  if (repository === null || typeof repository.findBounded !== "function") {
    fail("INVALID_REPOSITORY", name, `${name} must expose findBounded`);
  }
  for (const key of FORBIDDEN_REPOSITORY_KEYS) {
    if (typeof repository[key] === "function" || repository[key] !== undefined) {
      fail(
        "WRITE_SURFACE_DETECTED",
        name,
        `${name} exposes forbidden read/write capability ${key}`,
      );
    }
  }
}

function assertRepositories(repositories) {
  if (!isPlainObject(repositories)) {
    fail("INVALID_REPOSITORIES", "repositories", "repositories must be a plain object");
  }
  assertReadOnlyRepository(repositories.orders, "orders");
  assertReadOnlyRepository(repositories.reservations, "reservations");
  assertReadOnlyRepository(repositories.movements, "movements");
  assertReadOnlyRepository(repositories.inventory, "inventory");
  if (repositories.indexEvidence !== undefined && repositories.indexEvidence !== null) {
    if (typeof repositories.indexEvidence.readUniqueIndexEvidence !== "function") {
      fail(
        "INVALID_INDEX_EVIDENCE_PROVIDER",
        "indexEvidence",
        "indexEvidence must expose readUniqueIndexEvidence",
      );
    }
  }
}

function validateStatusList(statuses, allowed, field) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    fail("INVALID_FILTER", field, `${field} must be a non-empty array`);
  }
  for (const status of statuses) {
    if (!allowed.has(status)) {
      fail("INVALID_FILTER", field, `${field} contains an unknown status`);
    }
  }
  return Object.freeze([...statuses]);
}

// V1 stores createdAt/updatedAt as BSON Dates (Mongoose `timestamps: true`).
// `since`/`until` are validated ISO strings; range operands must be Dates.
function toDateBoundary(value) {
  return value === null ? null : new Date(value);
}

function buildOrderFilter(options) {
  const filter = {};
  if (options.orderIds.length > 0) {
    filter._id = Object.freeze({ $in: Object.freeze([...options.orderIds]) });
  } else {
    const statuses = validateStatusList(
      RULE_SCOPES[options.ruleScope],
      ORDER_STATUS_SET,
      "orderStatuses",
    );
    filter.status = statuses.length === 1 ? statuses[0] : Object.freeze({ $in: statuses });
    const window = {};
    if (options.since !== null) window.$gte = toDateBoundary(options.since);
    if (options.until !== null) window.$lte = toDateBoundary(options.until);
    filter.updatedAt = Object.freeze(window);
  }
  return Object.freeze(filter);
}

function buildReservationFilter(orderIds, options, explicitStatuses = null) {
  const filter = {};
  if (orderIds.length > 0) {
    filter.orderId = Object.freeze({
      $in: Object.freeze(orderIds.map((id) => normalizeAdapterIdentifier(id, "orderId"))),
    });
  }
  if (explicitStatuses !== null) {
    const statuses = validateStatusList(
      explicitStatuses,
      RESERVATION_STATUS_SET,
      "reservationStatuses",
    );
    filter.status = statuses.length === 1 ? statuses[0] : Object.freeze({ $in: statuses });
  }
  if (options.since !== null || options.until !== null) {
    const window = {};
    if (options.since !== null) window.$gte = toDateBoundary(options.since);
    if (options.until !== null) window.$lte = toDateBoundary(options.until);
    filter.updatedAt = Object.freeze(window);
  }
  return Object.freeze(filter);
}

function buildMovementFilter(orderIds, options) {
  const filter = {
    refOrderId: Object.freeze({
      $in: Object.freeze(orderIds.map((id) => normalizeAdapterIdentifier(id, "orderId"))),
    }),
  };
  if (options.since !== null || options.until !== null) {
    const window = {};
    if (options.since !== null) window.$gte = toDateBoundary(options.since);
    if (options.until !== null) window.$lte = toDateBoundary(options.until);
    filter.createdAt = Object.freeze(window);
  }
  return Object.freeze(filter);
}

function buildInventoryFilter(itemIds) {
  return Object.freeze({
    _id: Object.freeze({
      $in: Object.freeze(
        itemIds.map((id) => normalizeAdapterIdentifier(id, "inventoryItemId")),
      ),
    }),
  });
}

async function readBounded(repository, name, filter, projection, limit) {
  const result = await repository.findBounded(filter, projection, { limit });
  const docs = Array.isArray(result) ? result : result?.docs;
  if (!Array.isArray(docs)) {
    fail("INVALID_REPOSITORY_RESULT", name, `${name}.findBounded must return an array or { docs }`);
  }
  if (result && result.truncated === true) {
    fail(
      "EVIDENCE_BOUND_EXCEEDED",
      name,
      `${name} reported a truncated result; failing closed`,
    );
  }
  if (docs.length > limit) {
    fail(
      "EVIDENCE_BOUND_EXCEEDED",
      name,
      `${name} returned ${docs.length} documents for a limit of ${limit}`,
    );
  }
  return docs;
}

function uniqueItemIds(reservations, movements) {
  const seen = new Set();
  const ids = [];
  const add = (value) => {
    if (value === null || value === undefined) return;
    const key = identifierKey(value);
    if (seen.has(key)) return;
    seen.add(key);
    ids.push(value);
  };
  for (const reservation of reservations) {
    for (const item of reservation?.items ?? []) add(item.inventoryItemId);
  }
  for (const movement of movements) add(movement.item);
  return ids;
}

function normalizeIndexEvidenceValue(value) {
  if (value === null || value === undefined) {
    return Object.freeze({ saleDeductionUnique: "UNKNOWN", source: "NOT_PROBED" });
  }
  if (!isPlainObject(value)) {
    fail("INVALID_INDEX_EVIDENCE", "indexEvidence", "index evidence must be a plain object");
  }
  const state = value.saleDeductionUnique ?? "UNKNOWN";
  if (!["PRESENT", "ABSENT", "UNKNOWN"].includes(state)) {
    fail(
      "INVALID_INDEX_EVIDENCE",
      "indexEvidence.saleDeductionUnique",
      "index evidence must be PRESENT, ABSENT, or UNKNOWN",
    );
  }
  return Object.freeze({
    saleDeductionUnique: state,
    source: typeof value.source === "string" ? value.source : "INJECTED",
  });
}

async function readIndexEvidence(repositories, options) {
  if (options.indexEvidence !== null && options.indexEvidence !== undefined) {
    return normalizeIndexEvidenceValue(options.indexEvidence);
  }
  const provider = repositories.indexEvidence;
  if (provider === undefined || provider === null) {
    return Object.freeze({ saleDeductionUnique: "UNKNOWN", source: "NOT_PROBED" });
  }
  try {
    return normalizeIndexEvidenceValue(await provider.readUniqueIndexEvidence());
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    return Object.freeze({
      saleDeductionUnique: "UNKNOWN",
      source: "PROVIDER_ERROR",
    });
  }
}

async function collectOrderBundles(repositories, order, options, bundles) {
  const orderId = order._id ?? order.id;
  const filter = buildReservationFilter([orderId], options);
  const rawReservations = await readBounded(
    repositories.reservations,
    "reservations",
    filter,
    RESERVATION_PROJECTION,
    options.limits.maxDocsPerOrder,
  );
  const rawMovements = await readBounded(
    repositories.movements,
    "movements",
    buildMovementFilter([orderId], options),
    MOVEMENT_PROJECTION,
    options.limits.maxDocsPerOrder,
  );
  const itemIds = uniqueItemIds(rawReservations, rawMovements);
  let rawInventory = [];
  if (itemIds.length > 0) {
    rawInventory = await readBounded(
      repositories.inventory,
      "inventory",
      buildInventoryFilter(itemIds),
      INVENTORY_PROJECTION,
      options.limits.maxInventoryItems,
    );
  }

  const reservationList = rawReservations.length > 0 ? rawReservations : [null];
  for (const reservation of reservationList) {
    const evidence = projectEvidence({
      order,
      reservation,
      movements: rawMovements,
      inventory: rawInventory,
    });
    bundles.push(evidence);
    if (bundles.length > options.limits.maxTotalBundles) {
      fail(
        "EVIDENCE_BOUND_EXCEEDED",
        "bundles",
        `bundles exceeds the adapter limit of ${options.limits.maxTotalBundles}`,
      );
    }
  }
}

async function discoverConsumingOrderIds(repositories, options) {
  const filter = buildReservationFilter(
    [],
    options,
    ["CONSUMING"],
  );
  const reservations = await readBounded(
    repositories.reservations,
    "reservations",
    filter,
    Object.freeze({ _id: 1, orderId: 1 }),
    options.limits.maxOrders,
  );
  const ids = [];
  const seen = new Set();
  for (const reservation of reservations) {
    if (reservation.orderId === undefined || reservation.orderId === null) continue;
    const key = identifierKey(reservation.orderId);
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(reservation.orderId);
  }
  return ids;
}

async function collectOrphanBundles(repositories, options, knownOrderKeys, bundles) {
  const filter = { refOrderId: Object.freeze({ $ne: null }) };
  if (options.since !== null || options.until !== null) {
    const window = {};
    if (options.since !== null) window.$gte = toDateBoundary(options.since);
    if (options.until !== null) window.$lte = toDateBoundary(options.until);
    filter.createdAt = Object.freeze(window);
  }
  const movements = await readBounded(
    repositories.movements,
    "movements",
    Object.freeze(filter),
    MOVEMENT_PROJECTION,
    options.limits.maxOrphanMovements,
  );
  const grouped = new Map();
  for (const movement of movements) {
    if (movement.refOrderId === undefined || movement.refOrderId === null) continue;
    const key = identifierKey(normalizeAdapterIdentifier(movement.refOrderId, "movement.refOrderId"));
    const list = grouped.get(key) ?? [];
    list.push(movement);
    grouped.set(key, list);
  }
  for (const [key, groupMovements] of grouped) {
    if (knownOrderKeys.has(key)) continue;
    const orderId = normalizeAdapterIdentifier(groupMovements[0].refOrderId, "movement.refOrderId");
    const found = await readBounded(
      repositories.orders,
      "orders",
      Object.freeze({ _id: orderId }),
      ORDER_PROJECTION,
      1,
    );
    if (found.length > 0) continue;
    const itemIds = uniqueItemIds([], groupMovements);
    let inventory = [];
    if (itemIds.length > 0) {
      inventory = await readBounded(
        repositories.inventory,
        "inventory",
        buildInventoryFilter(itemIds),
        INVENTORY_PROJECTION,
        options.limits.maxInventoryItems,
      );
    }
    const evidence = projectEvidence({
      order: null,
      reservation: null,
      movements: groupMovements,
      inventory,
    });
    bundles.push(evidence);
    if (bundles.length > options.limits.maxTotalBundles) {
      fail(
        "EVIDENCE_BOUND_EXCEEDED",
        "bundles",
        `bundles exceeds the adapter limit of ${options.limits.maxTotalBundles}`,
      );
    }
  }
}

/**
 * Read bounded V1 evidence and return projected bundles. No connection is
 * created; every repository is injected and must be read-only.
 *
 * @param {{ orders: Object, reservations: Object, movements: Object, inventory: Object, indexEvidence?: Object }} repositories
 * @param {Object} [options]
 * @returns {Promise<Readonly<Object>>}
 */
export async function collectEvidence(repositories, options = {}) {
  assertRepositories(repositories);
  const normalized = normalizeAdapterOptions(options);
  const orderDocs = await readBounded(
    repositories.orders,
    "orders",
    buildOrderFilter(normalized),
    ORDER_PROJECTION,
    normalized.limits.maxOrders,
  );

  const orderById = new Map();
  for (const order of orderDocs) {
    const id = order._id ?? order.id;
    if (id === undefined || id === null) continue;
    const key = identifierKey(normalizeAdapterIdentifier(id, "order._id"));
    if (!orderById.has(key)) orderById.set(key, order);
  }

  if (normalized.includeConsuming && normalized.orderIds.length === 0) {
    const consumingIds = await discoverConsumingOrderIds(repositories, normalized);
    const missing = consumingIds.filter((id) => !orderById.has(identifierKey(id)));
    if (missing.length > 0) {
      const extraOrders = await readBounded(
        repositories.orders,
        "orders",
        Object.freeze({
          _id: Object.freeze({ $in: Object.freeze(missing) }),
        }),
        ORDER_PROJECTION,
        normalized.limits.maxOrders,
      );
      for (const order of extraOrders) {
        const id = order._id ?? order.id;
        if (id === undefined || id === null) continue;
        const key = identifierKey(normalizeAdapterIdentifier(id, "order._id"));
        if (!orderById.has(key)) orderById.set(key, order);
      }
    }
  }

  const bundles = [];
  for (const order of orderById.values()) {
    await collectOrderBundles(repositories, order, normalized, bundles);
  }

  if (normalized.includeOrphans) {
    const known = new Set(orderById.keys());
    await collectOrphanBundles(repositories, normalized, known, bundles);
  }

  const indexEvidence = await readIndexEvidence(repositories, normalized);
  const frozenBundles = Object.freeze([...bundles]);
  return Object.freeze({
    schema: ADAPTER_VERSION,
    readOnly: true,
    generatedAt: null,
    bundles: frozenBundles,
    indexEvidence,
    bounds: Object.freeze({
      maxOrders: normalized.limits.maxOrders,
      maxDocsPerOrder: normalized.limits.maxDocsPerOrder,
      maxInventoryItems: normalized.limits.maxInventoryItems,
      maxOrphanMovements: normalized.limits.maxOrphanMovements,
      maxTotalBundles: normalized.limits.maxTotalBundles,
      orderCount: orderById.size,
      bundleCount: frozenBundles.length,
    }),
  });
}

/**
 * Run the classifier over adapter-collected evidence.
 *
 * @param {{ orders: Object, reservations: Object, movements: Object, inventory: Object, indexEvidence?: Object }} repositories
 * @param {Object} [options]
 * @returns {Promise<Readonly<Object>>}
 */
export async function reconcile(repositories, options = {}) {
  const collected = await collectEvidence(repositories, options);
  return classifyBundles(collected.bundles, {
    ...options,
    indexEvidence: collected.indexEvidence,
  });
}

/**
 * Create a frozen read-only facade. The facade exposes no write, collection,
 * index, or connection method.
 *
 * @param {Object} repositories
 * @returns {Readonly<{ collect: Function, classify: Function, reconcile: Function, describe: Function }>}
 */
export function createReadOnlyAdapter(repositories) {
  assertRepositories(repositories);
  return Object.freeze({
    collect: (options) => collectEvidence(repositories, options),
    classify: async (options = {}) => {
      const collected = await collectEvidence(repositories, options);
      return classifyBundles(collected.bundles, {
        ...options,
        indexEvidence: collected.indexEvidence,
      });
    },
    reconcile: (options) => reconcile(repositories, options),
    describe: () =>
      Object.freeze({
        schema: ADAPTER_VERSION,
        readOnly: true,
        methods: Object.freeze(["collect", "classify", "reconcile", "describe"]),
      }),
  });
}


