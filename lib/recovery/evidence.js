// WP04-01 — Deterministic, allowlisted evidence projection.
//
// The projection takes bounded V1 evidence (order, reservation, movements,
// inventory) and returns a new frozen plain object containing ONLY the fields
// the approved D01–D10 evidence model needs.
//
// Guarantees:
//   * allowlist only — source keys are never spread or serialized wholesale;
//   * no credentials, PINs, tokens, sessions, account numbers, or free text;
//   * missing/null values become explicit null (or an empty array);
//   * invalid values produce a typed EvidenceProjectionError, never a guess;
//   * quantities keep exact numeric semantics (no rounding);
//   * identifiers keep their type (string / integer / ObjectId tag);
//   * dates normalize to ISO-8601 UTC;
//   * no database, network, filesystem, or environment access.
//
// This module does not classify findings (WP04-02) or read a database (WP04-03).

export const EVIDENCE_SCHEMA_VERSION = "wp04-evidence-v1";

// Safety caps. These are not business thresholds; they exist so a malformed or
// hostile document cannot make the projection unbounded. Exceeding a cap is a
// typed failure, never a silent truncation.
export const PROJECTION_LIMITS = Object.freeze({
  maxOrderItems: 500,
  maxComponentsPerItem: 100,
  maxReservationItems: 500,
  maxVoids: 200,
  maxVoidItems: 200,
  maxMovements: 2000,
  maxInventoryItems: 1000,
});

export class EvidenceProjectionError extends Error {
  /**
   * @param {string} code Stable error code.
   * @param {string} [field] Offending field path, if known.
   * @param {string} [message] Safe message with no source payload.
   */
  constructor(code, field = null, message = code) {
    super(message);
    this.name = "EvidenceProjectionError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message) {
  throw new EvidenceProjectionError(code, field, message || code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function read(source, key) {
  if (source === null || source === undefined) return undefined;
  return source[key];
}

function asArray(value, field) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  fail("INVALID_ARRAY", field, `${field} must be an array`);
}

function bounded(value, limit, field) {
  const arr = asArray(value, field);
  if (arr.length > limit) {
    fail(
      "EVIDENCE_BOUND_EXCEEDED",
      field,
      `${field} exceeds the projection limit of ${limit}`,
    );
  }
  return arr;
}

function normalizeLimits(overrides) {
  if (overrides === null || overrides === undefined) return PROJECTION_LIMITS;
  if (!isObject(overrides)) {
    fail("INVALID_LIMIT", "limits", "limits must be a plain object");
  }
  const merged = { ...PROJECTION_LIMITS };
  for (const key of Object.keys(PROJECTION_LIMITS)) {
    if (overrides[key] === undefined) continue;
    const value = overrides[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("INVALID_LIMIT", `limits.${key}`, `${key} must be a non-negative integer`);
    }
    merged[key] = value;
  }
  return Object.freeze(merged);
}

/**
 * Normalize an identifier without losing its type.
 *
 * A string stays a string, a safe integer stays a number, and a BSON ObjectId
 * becomes { $oid: "<24 hex>" }. Ambiguous coercion (for example mapping every
 * value through String()) is deliberately avoided.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string | number | { $oid: string } | null}
 */
export function normalizeIdentifier(value, field = "identifier") {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("INVALID_IDENTIFIER", field, `${field} numeric id is not a safe integer`);
    }
    return value;
  }
  if (isObject(value)) {
    if (typeof value.$oid === "string" && /^[0-9a-fA-F]{24}$/.test(value.$oid)) {
      return Object.freeze({ $oid: value.$oid.toLowerCase() });
    }
    if (typeof value.toHexString === "function") {
      const hex = value.toHexString();
      if (typeof hex === "string" && /^[0-9a-fA-F]{24}$/.test(hex)) {
        return Object.freeze({ $oid: hex.toLowerCase() });
      }
      fail("INVALID_IDENTIFIER", field, `${field} ObjectId is malformed`);
    }
    if (value._bsontype === "ObjectId" && typeof value.toString === "function") {
      const hex = value.toString();
      if (typeof hex === "string" && /^[0-9a-fA-F]{24}$/.test(hex)) {
        return Object.freeze({ $oid: hex.toLowerCase() });
      }
      fail("INVALID_IDENTIFIER", field, `${field} ObjectId is malformed`);
    }
  }
  fail("INVALID_IDENTIFIER", field, `${field} is not a supported identifier`);
}

/**
 * Normalize a Date, ISO string, or epoch-millisecond number to ISO-8601 UTC.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string | null}
 */
export function normalizeDate(value, field = "date") {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail("INVALID_DATE", field, `${field} is invalid`);
    return value.toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      fail("INVALID_DATE", field, `${field} is not a finite timestamp`);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      fail("INVALID_DATE", field, `${field} is not a valid date`);
    }
    return parsed.toISOString();
  }
  fail("INVALID_DATE", field, `${field} is not a supported date value`);
}

/**
 * Preserve a quantity exactly. Numeric strings are rejected rather than coerced,
 * so legacy or malformed values are reported as evidence defects.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {number | null}
 */
export function normalizeQuantity(value, field = "quantity") {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  fail("INVALID_NUMERIC_VALUE", field, `${field} is not a finite number`);
}

function normalizeString(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  fail("INVALID_TYPE", field, `${field} must be a string or null`);
}

function normalizeBoolean(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  fail("INVALID_TYPE", field, `${field} must be a boolean or null`);
}

function projectComponent(raw, index) {
  const field = `order.items[].components[${index}]`;
  if (!isObject(raw)) fail("INVALID_COMPONENT", field, `${field} must be an object`);
  return Object.freeze({
    componentId: normalizeIdentifier(read(raw, "componentId"), `${field}.componentId`),
    kind: normalizeString(read(raw, "kind"), `${field}.kind`),
    inventoryItemId: normalizeIdentifier(
      read(raw, "inventoryItemId"),
      `${field}.inventoryItemId`,
    ),
    stockQuantity: normalizeQuantity(
      read(raw, "stockQuantity"),
      `${field}.stockQuantity`,
    ),
  });
}

function projectOrderItem(raw, index, limits) {
  const field = `order.items[${index}]`;
  if (!isObject(raw)) fail("INVALID_ORDER_ITEM", field, `${field} must be an object`);
  const components = bounded(
    read(raw, "components"),
    limits.maxComponentsPerItem,
    `${field}.components`,
  ).map(projectComponent);
  return Object.freeze({
    lineId: normalizeIdentifier(read(raw, "lineId"), `${field}.lineId`),
    type: normalizeString(read(raw, "type"), `${field}.type`),
    quantity: normalizeQuantity(read(raw, "quantity"), `${field}.quantity`),
    cancelled: normalizeBoolean(read(raw, "cancelled"), `${field}.cancelled`),
    cancelledAt: normalizeDate(read(raw, "cancelledAt"), `${field}.cancelledAt`),
    components: Object.freeze(components),
  });
}

function projectOrder(raw, limits) {
  if (raw === null || raw === undefined) return null;
  if (!isObject(raw)) fail("INVALID_ORDER", "order", "order must be an object or null");

  const items = bounded(
    read(raw, "items"),
    limits.maxOrderItems,
    "order.items",
  ).map((item, index) => projectOrderItem(item, index, limits));

  const cancelledLineIds = [];
  for (const item of items) {
    if (item.cancelled === true && item.lineId !== null) {
      cancelledLineIds.push(item.lineId);
    }
  }

  return Object.freeze({
    id: normalizeIdentifier(read(raw, "_id") ?? read(raw, "id"), "order.id"),
    orderNumber: normalizeIdentifier(read(raw, "orderNumber"), "order.orderNumber"),
    status: normalizeString(read(raw, "status"), "order.status"),
    paidAt: normalizeDate(read(raw, "paidAt"), "order.paidAt"),
    paymentMethod: normalizeString(read(raw, "paymentMethod"), "order.paymentMethod"),
    paymentAccountId: normalizeIdentifier(
      read(raw, "paymentAccountId"),
      "order.paymentAccountId",
    ),
    paymentSubmittedAt: normalizeDate(
      read(raw, "paymentSubmittedAt"),
      "order.paymentSubmittedAt",
    ),
    paymentSubmittedBy: normalizeIdentifier(
      read(raw, "paymentSubmittedBy"),
      "order.paymentSubmittedBy",
    ),
    paymentVerifiedAt: normalizeDate(
      read(raw, "paymentVerifiedAt"),
      "order.paymentVerifiedAt",
    ),
    paymentVerifiedBy: normalizeIdentifier(
      read(raw, "paymentVerifiedBy"),
      "order.paymentVerifiedBy",
    ),
    paymentRejectedAt: normalizeDate(
      read(raw, "paymentRejectedAt"),
      "order.paymentRejectedAt",
    ),
    paymentRejectedBy: normalizeIdentifier(
      read(raw, "paymentRejectedBy"),
      "order.paymentRejectedBy",
    ),
    paymentAccountSnapshotPresent: isObject(read(raw, "paymentAccountSnapshot")),
    preparingAt: normalizeDate(read(raw, "preparingAt"), "order.preparingAt"),
    readyAt: normalizeDate(read(raw, "readyAt"), "order.readyAt"),
    servedAt: normalizeDate(read(raw, "servedAt"), "order.servedAt"),
    createdAt: normalizeDate(read(raw, "createdAt"), "order.createdAt"),
    updatedAt: normalizeDate(read(raw, "updatedAt"), "order.updatedAt"),
    kitchenStatus: normalizeString(read(raw, "kitchenStatus"), "order.kitchenStatus"),
    baristaStatus: normalizeString(read(raw, "baristaStatus"), "order.baristaStatus"),
    hotDrinkStatus: normalizeString(
      read(raw, "hotDrinkStatus"),
      "order.hotDrinkStatus",
    ),
    items: Object.freeze(items),
    cancelledLineIds: Object.freeze(cancelledLineIds.sort()),
  });
}

function projectReservationItem(raw, index) {
  const field = `reservation.items[${index}]`;
  if (!isObject(raw)) fail("INVALID_RESERVATION_ITEM", field, `${field} must be an object`);
  return Object.freeze({
    inventoryItemId: normalizeIdentifier(
      read(raw, "inventoryItemId"),
      `${field}.inventoryItemId`,
    ),
    requiredQuantity: normalizeQuantity(
      read(raw, "requiredQuantity"),
      `${field}.requiredQuantity`,
    ),
    reservedQuantity: normalizeQuantity(
      read(raw, "reservedQuantity"),
      `${field}.reservedQuantity`,
    ),
    shortageQuantity: normalizeQuantity(
      read(raw, "shortageQuantity"),
      `${field}.shortageQuantity`,
    ),
    consumedQuantity: normalizeQuantity(
      read(raw, "consumedQuantity"),
      `${field}.consumedQuantity`,
    ),
  });
}

function projectVoidItem(raw, index) {
  const field = `reservation.voids[].items[${index}]`;
  if (!isObject(raw)) fail("INVALID_VOID_ITEM", field, `${field} must be an object`);
  return Object.freeze({
    inventoryItemId: normalizeIdentifier(
      read(raw, "inventoryItemId"),
      `${field}.inventoryItemId`,
    ),
    quantity: normalizeQuantity(read(raw, "quantity"), `${field}.quantity`),
  });
}

function projectVoid(raw, index, limits) {
  const field = `reservation.voids[${index}]`;
  if (!isObject(raw)) fail("INVALID_VOID", field, `${field} must be an object`);
  const items = bounded(
    read(raw, "items"),
    limits.maxVoidItems,
    `${field}.items`,
  ).map(projectVoidItem);
  return Object.freeze({
    at: normalizeDate(read(raw, "at"), `${field}.at`),
    phase: normalizeString(read(raw, "phase"), `${field}.phase`),
    source: normalizeString(read(raw, "source"), `${field}.source`),
    lineId: normalizeIdentifier(read(raw, "lineId"), `${field}.lineId`),
    station: normalizeString(read(raw, "station"), `${field}.station`),
    items: Object.freeze(items),
  });
}

function projectApproval(raw, limits) {
  if (raw === null || raw === undefined) return null;
  if (!isObject(raw)) {
    fail("INVALID_APPROVAL", "reservation.approval", "approval must be an object or null");
  }
  const shortages = bounded(
    read(raw, "shortages"),
    limits.maxReservationItems,
    "reservation.approval.shortages",
  );
  return Object.freeze({
    present: true,
    approvedAt: normalizeDate(read(raw, "approvedAt"), "reservation.approval.approvedAt"),
    requirementFingerprint: normalizeString(
      read(raw, "requirementFingerprint"),
      "reservation.approval.requirementFingerprint",
    ),
    shortageFingerprint: normalizeString(
      read(raw, "shortageFingerprint"),
      "reservation.approval.shortageFingerprint",
    ),
    shortageItemCount: shortages.length,
  });
}

function projectReservation(raw, limits) {
  if (raw === null || raw === undefined) return null;
  if (!isObject(raw)) {
    fail("INVALID_RESERVATION", "reservation", "reservation must be an object or null");
  }

  const items = bounded(
    read(raw, "items"),
    limits.maxReservationItems,
    "reservation.items",
  ).map(projectReservationItem);

  const voids = bounded(
    read(raw, "voids"),
    limits.maxVoids,
    "reservation.voids",
  ).map((entry, index) => projectVoid(entry, index, limits));

  return Object.freeze({
    id: normalizeIdentifier(read(raw, "_id") ?? read(raw, "id"), "reservation.id"),
    orderId: normalizeIdentifier(read(raw, "orderId"), "reservation.orderId"),
    orderNumber: normalizeIdentifier(
      read(raw, "orderNumber"),
      "reservation.orderNumber",
    ),
    status: normalizeString(read(raw, "status"), "reservation.status"),
    requirementFingerprint: normalizeString(
      read(raw, "requirementFingerprint"),
      "reservation.requirementFingerprint",
    ),
    shortageFingerprint: normalizeString(
      read(raw, "shortageFingerprint"),
      "reservation.shortageFingerprint",
    ),
    items: Object.freeze(items),
    approval: projectApproval(read(raw, "approval"), limits),
    consumedAt: normalizeDate(read(raw, "consumedAt"), "reservation.consumedAt"),
    consumedTrigger: normalizeString(
      read(raw, "consumedTrigger"),
      "reservation.consumedTrigger",
    ),
    releasedAt: normalizeDate(read(raw, "releasedAt"), "reservation.releasedAt"),
    releaseReason: normalizeString(
      read(raw, "releaseReason"),
      "reservation.releaseReason",
    ),
    voids: Object.freeze(voids),
  });
}

function projectMovement(raw, index) {
  const field = `movements[${index}]`;
  if (!isObject(raw)) fail("INVALID_MOVEMENT", field, `${field} must be an object`);
  return Object.freeze({
    id: normalizeIdentifier(read(raw, "_id") ?? read(raw, "id"), `${field}.id`),
    refOrderId: normalizeIdentifier(read(raw, "refOrderId"), `${field}.refOrderId`),
    item: normalizeIdentifier(read(raw, "item"), `${field}.item`),
    type: normalizeString(read(raw, "type"), `${field}.type`),
    quantity: normalizeQuantity(read(raw, "quantity"), `${field}.quantity`),
    reason: normalizeString(read(raw, "reason"), `${field}.reason`),
    idempotencyKey: normalizeString(
      read(raw, "idempotencyKey"),
      `${field}.idempotencyKey`,
    ),
    voidedAt: normalizeDate(read(raw, "voidedAt"), `${field}.voidedAt`),
    voidReason: normalizeString(read(raw, "voidReason"), `${field}.voidReason`),
    createdAt: normalizeDate(read(raw, "createdAt"), `${field}.createdAt`),
  });
}

function projectInventoryItem(raw, index) {
  const field = `inventory[${index}]`;
  if (!isObject(raw)) fail("INVALID_INVENTORY_ITEM", field, `${field} must be an object`);
  return Object.freeze({
    id: normalizeIdentifier(read(raw, "_id") ?? read(raw, "id"), `${field}.id`),
    currentStock: normalizeQuantity(read(raw, "currentStock"), `${field}.currentStock`),
    reservedStock: normalizeQuantity(read(raw, "reservedStock"), `${field}.reservedStock`),
  });
}

const SENSITIVE_KEY_PATTERN =
  /pin|password|passwd|secret|token|authorization|cookie|sessionid|apikey|connectionstring|mongodburi|accountnumber|credential/i;

function assertNoSensitiveKeys(value, path = "$") {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveKeys(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      fail("SENSITIVE_FIELD_DETECTED", `${path}.${key}`, "projected evidence contains a sensitive field");
    }
    assertNoSensitiveKeys(nested, `${path}.${key}`);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/**
 * Project a bounded V1 evidence bundle.
 *
 * @param {Object} input
 * @param {{ order?: Object|null, reservation?: Object|null, movements?: Array, inventory?: Array }} input
 * @param {{ limits?: Partial<typeof PROJECTION_LIMITS> }} [options]
 * @returns {Readonly<Object>}
 */
export function projectEvidence(input, options = {}) {
  if (!isObject(input)) {
    fail("INVALID_INPUT", "input", "evidence input must be a plain object");
  }

  const limits = normalizeLimits(options.limits);
  const movements = bounded(input.movements, limits.maxMovements, "movements");
  const inventory = bounded(input.inventory, limits.maxInventoryItems, "inventory");

  const projectedOrder = projectOrder(input.order ?? null, limits);
  const projectedReservation = projectReservation(input.reservation ?? null, limits);
  const projectedMovements = movements.map(projectMovement);
  const projectedInventory = inventory.map(projectInventoryItem);

  const projected = {
    schema: EVIDENCE_SCHEMA_VERSION,
    order: projectedOrder,
    reservation: projectedReservation,
    movements: Object.freeze(projectedMovements),
    inventory: Object.freeze(projectedInventory),
    projection: Object.freeze({
      limits,
      counts: Object.freeze({
        orderItems: projectedOrder?.items.length ?? 0,
        movements: projectedMovements.length,
        inventoryItems: projectedInventory.length,
      }),
    }),
  };

  assertNoSensitiveKeys(projected);
  return deepFreeze(projected);
}

/**
 * Non-throwing wrapper. Returns a typed, redacted error instead of a raw payload.
 *
 * @param {Object} input
 * @param {Object} [options]
 * @returns {{ ok: true, evidence: Object } | { ok: false, error: { code: string, field: string|null, message: string } }}
 */
export function tryProjectEvidence(input, options = {}) {
  try {
    return { ok: true, evidence: projectEvidence(input, options) };
  } catch (error) {
    if (error instanceof EvidenceProjectionError) {
      return {
        ok: false,
        error: {
          code: error.code,
          field: error.field,
          message: error.message,
        },
      };
    }
    throw error;
  }
}
