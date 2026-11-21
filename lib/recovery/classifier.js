// WP04-03 — Pure, DB-free D01–D10 finding classifier.
//
// Input: evidence bundles produced by WP04-01 `projectEvidence()` (schema
// `wp04-evidence-v1`). Output: a deterministic, frozen finding report.
//
// This module performs no I/O: no database, filesystem, network, environment,
// clock, or randomness access. Time and scan windows are injected by the caller.
// When an age-dependent rule cannot be measured from projected evidence, the
// classifier records a `deferred` entry instead of inventing a threshold.
//
// Hard policy carried from the approved matrix and registry:
//   * D02 and D09 are finding codes only (no durable class, no task payload).
//   * D06 is ALERT_ONLY and never creates a recovery task.
//   * No rule authorizes repair, stock/payment/reservation mutation, or a
//     shortage correction quantity.
//   * The fingerprint detects evidence drift; it does not prove truth.

import {
  RULES,
  RULES_BY_ID,
  SEVERITY,
  CONFIDENCE,
  ORDER_STATUSES,
  RESERVATION_STATUSES,
} from "./rules/registry.js";
import { EVIDENCE_SCHEMA_VERSION } from "./evidence.js";
import { fingerprintEvidence } from "./fingerprint.js";

export const FINDING_SCHEMA_VERSION = "wp04-finding-v1";
export const CLASSIFIER_VERSION = "wp04-classifier-v1";

// Local copy of the project's existing quantity epsilon. Importing a V1 service
// module into the recovery layer would break the no-service dependency rule.
export const QTY_EPSILON = 1e-9;

export const DEFAULT_MAX_BUNDLES = 1000;
export const DEFAULT_MAX_FINDINGS = 5000;
export const MAX_MAX_BUNDLES = 10000;
export const MAX_MAX_FINDINGS = 50000;

export class ClassifierError extends Error {
  /**
   * @param {string} code Stable error code.
   * @param {string|null} [field] Offending field path.
   * @param {string} [message] Safe message with no evidence payload.
   */
  constructor(code, field = null, message = code) {
    super(message);
    this.name = "ClassifierError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message) {
  throw new ClassifierError(code, field, message || code);
}

const ORDER_STATUS_SET = new Set(ORDER_STATUSES);
const RESERVATION_STATUS_SET = new Set(RESERVATION_STATUSES);
const MOVEMENT_TYPES = new Set(["IN", "OUT", "ADJUSTMENT"]);
const MOVEMENT_REASONS = new Set([
  "Purchase",
  "SaleDeduction",
  "Waste",
  "Correction",
  "Initial",
]);
const PAYMENT_METHODS = new Set(["CASH", "TRANSFER", "TELEBIRR", "NONE"]);
const LIVE_RESERVATION_STATUSES = new Set([
  "RESERVED",
  "APPROVED",
  "APPROVAL_REQUIRED",
  "NO_INVENTORY",
]);
const ACTIVE_ORDER_STATUSES = new Set([
  "PENDING",
  "PREPARING",
  "READY",
  "SERVED",
  "PAYMENT_PENDING",
]);
const PREPARED_STATIONS = new Set(["PREPARING", "READY", "SERVED"]);
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFiniteNumberOrNull(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isIsoDateString(value) {
  return (
    typeof value === "string" &&
    ISO_UTC_RE.test(value) &&
    !Number.isNaN(new Date(value).getTime()) &&
    new Date(value).toISOString() === value
  );
}

function assertIsoDate(value, field) {
  if (value === null) return;
  if (!isIsoDateString(value)) {
    fail("INVALID_DATE", field, `${field} must be ISO-8601 UTC with milliseconds and Z`);
  }
}

function assertQuantity(value, field) {
  if (!isFiniteNumberOrNull(value)) {
    fail("INVALID_NUMERIC_VALUE", field, `${field} must be a finite number or null`);
  }
}

function assertStringOrNull(value, field) {
  if (value !== null && typeof value !== "string") {
    fail("INVALID_TYPE", field, `${field} must be a string or null`);
  }
}

function assertBooleanOrNull(value, field) {
  if (value !== null && typeof value !== "boolean") {
    fail("INVALID_TYPE", field, `${field} must be a boolean or null`);
  }
}

/**
 * Validate a projected identifier. Empty strings and malformed ObjectId tags are
 * ambiguous and therefore rejected rather than coerced.
 *
 * @param {unknown} value
 * @param {string} field
 */
function assertIdentifier(value, field) {
  if (value === null) return;
  if (typeof value === "string") {
    if (value.length === 0) {
      fail("INVALID_IDENTIFIER", field, `${field} must not be an empty string`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("INVALID_IDENTIFIER", field, `${field} numeric id is not a safe integer`);
    }
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (
      keys.length === 1 &&
      keys[0] === "$oid" &&
      typeof value.$oid === "string" &&
      /^[0-9a-fA-F]{24}$/.test(value.$oid)
    ) {
      return;
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

function identifierString(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (isPlainObject(value) && typeof value.$oid === "string") {
    return value.$oid.toLowerCase();
  }
  return String(value);
}

function idEquals(a, b) {
  return identifierKey(a) === identifierKey(b);
}

/**
 * Reject BigInt, Decimal128, and V2 scaled-quantity shapes explicitly. WP04
 * consumes V1 `Number` evidence only; a silent coercion would lose precision.
 */
function assertNoUnsupportedValues(value, path) {
  if (typeof value === "bigint") {
    fail("UNSUPPORTED_V2_EVIDENCE", path, `${path} contains a BigInt quantity`);
  }
  if (value === null || typeof value !== "object") return;
  if (!Array.isArray(value)) {
    if (value._bsontype === "Decimal128" || /Decimal128/.test(String(value._bsontype || ""))) {
      fail("UNSUPPORTED_NUMERIC_TYPE", path, `${path} contains Decimal128`);
    }
    if (Object.prototype.hasOwnProperty.call(value, "scaled")) {
      fail("UNSUPPORTED_V2_EVIDENCE", path, `${path} contains a V2 scaled quantity`);
    }
  }
  for (const [key, nested] of Object.entries(value)) {
    assertNoUnsupportedValues(nested, `${path}.${key}`);
  }
}

function assertProjectedComponent(component, field) {
  if (!isPlainObject(component)) fail("INVALID_TYPE", field, `${field} must be an object`);
  assertIdentifier(component.componentId ?? null, `${field}.componentId`);
  assertStringOrNull(component.kind ?? null, `${field}.kind`);
  assertIdentifier(component.inventoryItemId ?? null, `${field}.inventoryItemId`);
  assertQuantity(component.stockQuantity ?? null, `${field}.stockQuantity`);
}

function assertProjectedOrderItem(item, field) {
  if (!isPlainObject(item)) fail("INVALID_TYPE", field, `${field} must be an object`);
  assertIdentifier(item.lineId ?? null, `${field}.lineId`);
  assertStringOrNull(item.type ?? null, `${field}.type`);
  assertQuantity(item.quantity ?? null, `${field}.quantity`);
  assertBooleanOrNull(item.cancelled ?? null, `${field}.cancelled`);
  assertIsoDate(item.cancelledAt ?? null, `${field}.cancelledAt`);
  if (!Array.isArray(item.components)) {
    fail("INVALID_TYPE", `${field}.components`, `${field}.components must be an array`);
  }
  item.components.forEach((component, index) =>
    assertProjectedComponent(component, `${field}.components[${index}]`),
  );
}

function assertProjectedOrder(order) {
  if (order === null) return;
  if (!isPlainObject(order)) fail("INVALID_TYPE", "order", "order must be an object or null");
  assertIdentifier(order.id ?? null, "order.id");
  assertIdentifier(order.orderNumber ?? null, "order.orderNumber");
  assertStringOrNull(order.status ?? null, "order.status");
  assertIsoDate(order.paidAt ?? null, "order.paidAt");
  assertStringOrNull(order.paymentMethod ?? null, "order.paymentMethod");
  assertIdentifier(order.paymentAccountId ?? null, "order.paymentAccountId");
  assertIsoDate(order.paymentSubmittedAt ?? null, "order.paymentSubmittedAt");
  assertIdentifier(order.paymentSubmittedBy ?? null, "order.paymentSubmittedBy");
  assertIsoDate(order.paymentVerifiedAt ?? null, "order.paymentVerifiedAt");
  assertIdentifier(order.paymentVerifiedBy ?? null, "order.paymentVerifiedBy");
  assertIsoDate(order.paymentRejectedAt ?? null, "order.paymentRejectedAt");
  assertIdentifier(order.paymentRejectedBy ?? null, "order.paymentRejectedBy");
  assertBooleanOrNull(
    order.paymentAccountSnapshotPresent ?? null,
    "order.paymentAccountSnapshotPresent",
  );
  assertIsoDate(order.preparingAt ?? null, "order.preparingAt");
  assertIsoDate(order.readyAt ?? null, "order.readyAt");
  assertIsoDate(order.servedAt ?? null, "order.servedAt");
  assertIsoDate(order.createdAt ?? null, "order.createdAt");
  assertIsoDate(order.updatedAt ?? null, "order.updatedAt");
  assertStringOrNull(order.kitchenStatus ?? null, "order.kitchenStatus");
  assertStringOrNull(order.baristaStatus ?? null, "order.baristaStatus");
  assertStringOrNull(order.hotDrinkStatus ?? null, "order.hotDrinkStatus");
  if (!Array.isArray(order.items)) {
    fail("INVALID_TYPE", "order.items", "order.items must be an array");
  }
  order.items.forEach((item, index) => assertProjectedOrderItem(item, `order.items[${index}]`));
  if (!Array.isArray(order.cancelledLineIds)) {
    fail("INVALID_TYPE", "order.cancelledLineIds", "order.cancelledLineIds must be an array");
  }
  order.cancelledLineIds.forEach((lineId, index) =>
    assertIdentifier(lineId, `order.cancelledLineIds[${index}]`),
  );
}

function assertProjectedReservationItem(item, field) {
  if (!isPlainObject(item)) fail("INVALID_TYPE", field, `${field} must be an object`);
  assertIdentifier(item.inventoryItemId ?? null, `${field}.inventoryItemId`);
  assertQuantity(item.requiredQuantity ?? null, `${field}.requiredQuantity`);
  assertQuantity(item.reservedQuantity ?? null, `${field}.reservedQuantity`);
  assertQuantity(item.shortageQuantity ?? null, `${field}.shortageQuantity`);
  assertQuantity(item.consumedQuantity ?? null, `${field}.consumedQuantity`);
}

function assertProjectedVoid(entry, field) {
  if (!isPlainObject(entry)) fail("INVALID_TYPE", field, `${field} must be an object`);
  assertIsoDate(entry.at ?? null, `${field}.at`);
  assertStringOrNull(entry.phase ?? null, `${field}.phase`);
  assertStringOrNull(entry.source ?? null, `${field}.source`);
  assertIdentifier(entry.lineId ?? null, `${field}.lineId`);
  assertStringOrNull(entry.station ?? null, `${field}.station`);
  if (!Array.isArray(entry.items)) {
    fail("INVALID_TYPE", `${field}.items`, `${field}.items must be an array`);
  }
  entry.items.forEach((item, index) => {
    const itemField = `${field}.items[${index}]`;
    if (!isPlainObject(item)) fail("INVALID_TYPE", itemField, `${itemField} must be an object`);
    assertIdentifier(item.inventoryItemId ?? null, `${itemField}.inventoryItemId`);
    assertQuantity(item.quantity ?? null, `${itemField}.quantity`);
  });
}

function assertProjectedApproval(approval) {
  if (approval === null) return;
  if (!isPlainObject(approval)) {
    fail("INVALID_TYPE", "reservation.approval", "reservation.approval must be an object or null");
  }
  assertBooleanOrNull(approval.present ?? null, "reservation.approval.present");
  assertIsoDate(approval.approvedAt ?? null, "reservation.approval.approvedAt");
  assertStringOrNull(
    approval.requirementFingerprint ?? null,
    "reservation.approval.requirementFingerprint",
  );
  assertStringOrNull(
    approval.shortageFingerprint ?? null,
    "reservation.approval.shortageFingerprint",
  );
  if (approval.shortageItemCount !== undefined) {
    if (!Number.isSafeInteger(approval.shortageItemCount) || approval.shortageItemCount < 0) {
      fail("INVALID_TYPE", "reservation.approval.shortageItemCount", "invalid shortage count");
    }
  }
}

function assertProjectedReservation(reservation) {
  if (reservation === null) return;
  if (!isPlainObject(reservation)) {
    fail("INVALID_TYPE", "reservation", "reservation must be an object or null");
  }
  assertIdentifier(reservation.id ?? null, "reservation.id");
  assertIdentifier(reservation.orderId ?? null, "reservation.orderId");
  assertIdentifier(reservation.orderNumber ?? null, "reservation.orderNumber");
  assertStringOrNull(reservation.status ?? null, "reservation.status");
  assertStringOrNull(reservation.requirementFingerprint ?? null, "reservation.requirementFingerprint");
  assertStringOrNull(reservation.shortageFingerprint ?? null, "reservation.shortageFingerprint");
  if (!Array.isArray(reservation.items)) {
    fail("INVALID_TYPE", "reservation.items", "reservation.items must be an array");
  }
  reservation.items.forEach((item, index) =>
    assertProjectedReservationItem(item, `reservation.items[${index}]`),
  );
  assertProjectedApproval(reservation.approval ?? null);
  assertIsoDate(reservation.consumedAt ?? null, "reservation.consumedAt");
  assertStringOrNull(reservation.consumedTrigger ?? null, "reservation.consumedTrigger");
  assertIsoDate(reservation.releasedAt ?? null, "reservation.releasedAt");
  assertStringOrNull(reservation.releaseReason ?? null, "reservation.releaseReason");
  if (!Array.isArray(reservation.voids)) {
    fail("INVALID_TYPE", "reservation.voids", "reservation.voids must be an array");
  }
  reservation.voids.forEach((entry, index) =>
    assertProjectedVoid(entry, `reservation.voids[${index}]`),
  );
}

function assertProjectedMovement(movement, index) {
  const field = `movements[${index}]`;
  if (!isPlainObject(movement)) fail("INVALID_TYPE", field, `${field} must be an object`);
  assertIdentifier(movement.id ?? null, `${field}.id`);
  assertIdentifier(movement.refOrderId ?? null, `${field}.refOrderId`);
  assertIdentifier(movement.item ?? null, `${field}.item`);
  assertStringOrNull(movement.type ?? null, `${field}.type`);
  assertQuantity(movement.quantity ?? null, `${field}.quantity`);
  assertStringOrNull(movement.reason ?? null, `${field}.reason`);
  assertStringOrNull(movement.idempotencyKey ?? null, `${field}.idempotencyKey`);
  assertIsoDate(movement.voidedAt ?? null, `${field}.voidedAt`);
  assertStringOrNull(movement.voidReason ?? null, `${field}.voidReason`);
  assertIsoDate(movement.createdAt ?? null, `${field}.createdAt`);
}

function assertProjectedInventory(item, index) {
  const field = `inventory[${index}]`;
  if (!isPlainObject(item)) fail("INVALID_TYPE", field, `${field} must be an object`);
  assertIdentifier(item.id ?? null, `${field}.id`);
  assertQuantity(item.currentStock ?? null, `${field}.currentStock`);
  assertQuantity(item.reservedStock ?? null, `${field}.reservedStock`);
}

/**
 * Validate a projected evidence bundle without reading or mutating it.
 *
 * @param {unknown} evidence
 */
function assertEvidenceShape(evidence) {
  if (!isPlainObject(evidence)) {
    fail("INVALID_EVIDENCE", "evidence", "evidence must be a projected plain object");
  }
  if (evidence.schema !== EVIDENCE_SCHEMA_VERSION) {
    fail(
      "UNSUPPORTED_EVIDENCE_VERSION",
      "evidence.schema",
      `expected ${EVIDENCE_SCHEMA_VERSION}`,
    );
  }
  assertNoUnsupportedValues(evidence, "evidence");
  assertProjectedOrder(evidence.order ?? null);
  assertProjectedReservation(evidence.reservation ?? null);
  if (!Array.isArray(evidence.movements)) {
    fail("INVALID_TYPE", "movements", "movements must be an array");
  }
  evidence.movements.forEach(assertProjectedMovement);
  if (!Array.isArray(evidence.inventory)) {
    fail("INVALID_TYPE", "inventory", "inventory must be an array");
  }
  evidence.inventory.forEach(assertProjectedInventory);
}

function normalizeOptionDate(value, field) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail("INVALID_DATE", field, `${field} is invalid`);
    return value.toISOString();
  }
  if (!isIsoDateString(value)) {
    fail("INVALID_DATE", field, `${field} must be ISO-8601 UTC with milliseconds and Z`);
  }
  return value;
}

function normalizeBound(value, fallback, maximum, field) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("INVALID_LIMIT", field, `${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function normalizeIndexEvidence(value) {
  if (value === null || value === undefined) {
    return Object.freeze({ saleDeductionUnique: "UNKNOWN", source: "NOT_SUPPLIED" });
  }
  if (!isPlainObject(value)) {
    fail("INVALID_INDEX_EVIDENCE", "indexEvidence", "indexEvidence must be a plain object");
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
    source: typeof value.source === "string" ? value.source : "SUPPLIED",
  });
}

function normalizeOptions(options) {
  if (options === null || options === undefined) options = {};
  if (!isPlainObject(options)) {
    fail("INVALID_OPTIONS", "options", "options must be a plain object");
  }
  const since = normalizeOptionDate(options.since, "options.since");
  const until = normalizeOptionDate(options.until, "options.until");
  if (since !== null && until !== null && since > until) {
    fail("INVALID_WINDOW", "options.until", "until must not precede since");
  }
  const expectedFingerprints = options.expectedFingerprints ?? null;
  if (expectedFingerprints !== null) {
    if (!isPlainObject(expectedFingerprints)) {
      fail(
        "INVALID_OPTIONS",
        "options.expectedFingerprints",
        "expectedFingerprints must be a plain object",
      );
    }
    for (const [key, digest] of Object.entries(expectedFingerprints)) {
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
        fail(
          "INVALID_OPTIONS",
          `options.expectedFingerprints.${key}`,
          "expected fingerprint must be a lowercase SHA-256 hex digest",
        );
      }
    }
  }
  return Object.freeze({
    now: normalizeOptionDate(options.now, "options.now"),
    since,
    until,
    maxBundles: normalizeBound(
      options.maxBundles,
      DEFAULT_MAX_BUNDLES,
      MAX_MAX_BUNDLES,
      "options.maxBundles",
    ),
    maxFindings: normalizeBound(
      options.maxFindings,
      DEFAULT_MAX_FINDINGS,
      MAX_MAX_FINDINGS,
      "options.maxFindings",
    ),
    indexEvidence: normalizeIndexEvidence(options.indexEvidence),
    expectedFingerprints,
  });
}

function saleMovements(movements) {
  return movements.filter((movement) => effectiveReason(movement) === "SaleDeduction");
}

function effectiveReason(movement) {
  return movement.voidedAt !== null && movement.voidedAt !== undefined
    ? "Waste"
    : movement.reason;
}

function movementQuantities(movements) {
  const totals = new Map();
  for (const movement of saleMovements(movements)) {
    if (movement.item === null) continue;
    const key = identifierKey(movement.item);
    const quantity = movement.quantity ?? 0;
    totals.set(key, (totals.get(key) ?? 0) + quantity);
  }
  return totals;
}

function sumReserved(reservation) {
  let total = 0;
  for (const item of reservation?.items ?? []) total += item.reservedQuantity ?? 0;
  return total;
}

function reservationHasVoidSource(reservation, sources) {
  const allowed = new Set(sources);
  return (reservation?.voids ?? []).some((entry) => allowed.has(entry.source));
}

function reservationHasLineVoid(reservation, lineId) {
  return (reservation?.voids ?? []).some(
    (entry) => entry.source === "LINE" && entry.lineId !== null && idEquals(entry.lineId, lineId),
  );
}

function requiredFromOrder(order) {
  const totals = new Map();
  for (const item of order?.items ?? []) {
    if (item.cancelled === true) continue;
    for (const component of item.components ?? []) {
      if (component.inventoryItemId === null) continue;
      const key = identifierKey(component.inventoryItemId);
      if (component.stockQuantity !== null) {
        totals.set(key, (totals.get(key) ?? 0) + component.stockQuantity);
      } else if (!totals.has(key)) {
        totals.set(key, 0);
      }
    }
  }
  return totals;
}

function orderLinksItemOnlyToCancelledLines(order, inventoryItemId) {
  let linked = false;
  for (const item of order?.items ?? []) {
    for (const component of item.components ?? []) {
      if (component.inventoryItemId !== null && idEquals(component.inventoryItemId, inventoryItemId)) {
        linked = true;
        if (item.cancelled !== true) return false;
      }
    }
  }
  return linked;
}

function isPrepared(order) {
  if (order.preparingAt !== null) return true;
  return [order.kitchenStatus, order.baristaStatus, order.hotDrinkStatus].some((status) =>
    PREPARED_STATIONS.has(status),
  );
}

function orderKeyOf(evidence) {
  if (evidence.order?.id !== null && evidence.order?.id !== undefined) {
    return `order:${identifierKey(evidence.order.id)}`;
  }
  if (
    evidence.reservation?.orderId !== null &&
    evidence.reservation?.orderId !== undefined
  ) {
    return `order:${identifierKey(evidence.reservation.orderId)}`;
  }
  const movement = evidence.movements.find((entry) => entry.refOrderId !== null);
  if (movement) return `movement:${identifierKey(movement.refOrderId)}`;
  return "unknown";
}

function orderIdOf(evidence) {
  if (evidence.order?.id !== null && evidence.order?.id !== undefined) return evidence.order.id;
  if (evidence.reservation?.orderId !== null && evidence.reservation?.orderId !== undefined) {
    return evidence.reservation.orderId;
  }
  const movement = evidence.movements.find((entry) => entry.refOrderId !== null);
  return movement ? movement.refOrderId : null;
}

function sortedUniqueByIdentity(entries, identity) {
  const map = new Map();
  for (const entry of entries) {
    if (entry === null || entry === undefined) continue;
    const key = identity(entry);
    if (!map.has(key)) map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => {
    const left = identity(a);
    const right = identity(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function movementIdentity(movement) {
  if (movement.id !== null && movement.id !== undefined) return `id:${identifierKey(movement.id)}`;
  return `shape:${JSON.stringify(movement)}`;
}

function reservationIdentity(reservation) {
  if (reservation.id !== null && reservation.id !== undefined) return `id:${identifierKey(reservation.id)}`;
  return `shape:${JSON.stringify(reservation)}`;
}

function inventoryIdentity(item) {
  if (item.id !== null && item.id !== undefined) return `id:${identifierKey(item.id)}`;
  return `shape:${JSON.stringify(item)}`;
}

function sanitizeFindingEvidence(evidence, fields) {
  const order = evidence.order;
  const reservation = evidence.reservation;
  return Object.freeze({
    orderStatus: order?.status ?? null,
    paidAt: order?.paidAt ?? null,
    paymentMethod: order?.paymentMethod ?? null,
    reservationStatus: reservation?.status ?? null,
    releaseReason: reservation?.releaseReason ?? null,
    saleMovementCount: saleMovements(evidence.movements).length,
    itemId: fields.itemId ?? null,
    lineId: fields.lineId ?? null,
    requiredQuantity: fields.requiredQuantity ?? null,
    reservedQuantity: fields.reservedQuantity ?? null,
    shortageQuantity: fields.shortageQuantity ?? null,
    consumedQuantity: fields.consumedQuantity ?? null,
    movementQuantity: fields.movementQuantity ?? null,
    ageMs: fields.ageMs ?? null,
    thresholdState: fields.thresholdState ?? null,
    candidate: fields.candidate ?? null,
    indexState: fields.indexState ?? null,
    expectedFingerprint: fields.expectedFingerprint ?? null,
    observedFingerprint: fields.observedFingerprint ?? null,
  });
}

/**
 * Assert that a rule id and sub-code are in the frozen approved vocabulary.
 * Exposed so tests and future callers cannot invent a finding.
 *
 * @param {string} ruleId
 * @param {string} code
 * @returns {true}
 */
export function assertFindingCode(ruleId, code) {
  if (typeof ruleId !== "string" || !Object.hasOwn(RULES_BY_ID, ruleId)) {
    fail("UNKNOWN_RULE", "rule", "unknown rule id");
  }
  const rule = RULES_BY_ID[ruleId];
  if (typeof code !== "string" || !rule.subCodes.includes(code)) {
    fail("UNKNOWN_SUBCODE", "code", `unknown sub-code for ${ruleId}`);
  }
  return true;
}

function makeFinding(context, ruleId, code, fields = {}) {
  assertFindingCode(ruleId, code);
  const rule = RULES_BY_ID[ruleId];
  const evidence = context.evidence;
  const orderId = fields.orderId ?? orderIdOf(evidence);
  const orderNumber = fields.orderNumber ?? evidence.order?.orderNumber ?? null;
  const reservationId = fields.reservationId ?? evidence.reservation?.id ?? null;
  const itemId = fields.itemId ?? null;
  const lineId = fields.lineId ?? null;
  const severity = fields.severity ?? rule.severity.level;
  const confidence = fields.confidence ?? rule.confidence.level;
  if (!Object.values(SEVERITY).includes(severity)) {
    fail("INVALID_SEVERITY", "severity", `unknown severity ${String(severity)}`);
  }
  if (!Object.values(CONFIDENCE).includes(confidence)) {
    fail("INVALID_CONFIDENCE", "confidence", `unknown confidence ${String(confidence)}`);
  }
  const classification =
    fields.classification ??
    (ruleId === "D06" ? "ALERT" : severity === SEVERITY.INFO ? "INFO" : "DEFECT");
  const itemKey = itemId === null ? "null" : identifierKey(itemId);
  const lineKey = lineId === null ? "null" : identifierKey(lineId);
  return Object.freeze({
    schema: FINDING_SCHEMA_VERSION,
    rule: ruleId,
    code,
    orderId,
    orderNumber,
    reservationId,
    itemId,
    lineId,
    severity,
    confidence,
    evidenceLevel: fields.evidenceLevel ?? rule.evidenceLevels[0],
    graceMs: fields.graceMs ?? 0,
    evidenceFingerprint: context.fingerprint.digest,
    evidence: sanitizeFindingEvidence(evidence, fields),
    recommendedReview: rule.humanReview.roles.join("+"),
    autoRecovery: "PROHIBITED",
    readOnly: true,
    createsRecoveryTask: false,
    taskCreationPolicy: rule.taskCreationPolicy,
    findingCodeOnly: rule.findingCodeOnly === true,
    durableClass: rule.findingCodeOnly === true ? false : null,
    task: null,
    classification,
    thresholdState: fields.thresholdState ?? null,
    dedupeKey: `${ruleId}:${code}:${identifierKey(orderId)}:${itemKey}:${lineKey}`,
  });
}

function buildGroup(groupItems) {
  const primary =
    groupItems.find((entry) => entry.evidence.order !== null) ?? groupItems[0];
  const reservations = sortedUniqueByIdentity(
    groupItems.map((entry) => entry.evidence.reservation).filter((entry) => entry !== null),
    reservationIdentity,
  );
  const movements = sortedUniqueByIdentity(
    groupItems.flatMap((entry) => entry.evidence.movements),
    movementIdentity,
  );
  const inventory = sortedUniqueByIdentity(
    groupItems.flatMap((entry) => entry.evidence.inventory),
    inventoryIdentity,
  );
  const evidence = Object.freeze({
    schema: EVIDENCE_SCHEMA_VERSION,
    order: primary.evidence.order,
    reservation: reservations.length > 0 ? reservations[0] : null,
    movements: Object.freeze(movements),
    inventory: Object.freeze(inventory),
    projection: primary.evidence.projection ?? null,
  });
  return {
    key: orderKeyOf(evidence),
    evidence,
    reservations,
  };
}

function normalizeBundle(bundle, index) {
  if (bundle === null || bundle === undefined) {
    fail("INVALID_EVIDENCE", `bundles[${index}]`, "bundle must be an evidence object");
  }
  const evidence = isPlainObject(bundle) && bundle.evidence !== undefined ? bundle.evidence : bundle;
  assertEvidenceShape(evidence);
  const indexEvidence =
    isPlainObject(bundle) && bundle.indexEvidence !== undefined
      ? normalizeIndexEvidence(bundle.indexEvidence)
      : null;
  return { evidence, indexEvidence };
}

function classifyD01(context, emit) {
  const { evidence } = context;
  const order = evidence.order;
  if (order === null || order.status !== "PAID") return;
  const reservation = evidence.reservation;
  const sales = saleMovements(evidence.movements);
  const required = requiredFromOrder(order);

  if (reservation === null) {
    if (required.size === 0) {
      emit("D01", "NO_INVENTORY_REQUIREMENT", {
        severity: SEVERITY.INFO,
        confidence: CONFIDENCE.HIGH,
      });
      return;
    }
    if (sales.length > 0) {
      emit("D01", "ALREADY_CORRECT_LEGACY", {
        severity: SEVERITY.INFO,
        confidence: CONFIDENCE.HIGH,
      });
      return;
    }
    emit("D01", "PAID_NO_RESERVATION_NO_DEDUCTION", {
      severity: SEVERITY.CRITICAL,
      confidence: CONFIDENCE.MEDIUM,
    });
    return;
  }

  if (reservation.status === "NO_INVENTORY") {
    const totalRequired = reservation.items.reduce(
      (total, item) => total + (item.requiredQuantity ?? 0),
      0,
    );
    if (totalRequired <= QTY_EPSILON) {
      emit("D01", "NO_INVENTORY_REQUIREMENT", {
        severity: SEVERITY.INFO,
        confidence: CONFIDENCE.HIGH,
      });
    }
    return;
  }

  if (reservation.status === "CONSUMED") {
    for (const item of reservation.items) {
      if (
        (item.shortageQuantity ?? 0) > QTY_EPSILON &&
        reservation.approval !== null
      ) {
        emit("D01", "APPROVED_SHORTAGE", {
          severity: SEVERITY.INFO,
          confidence: CONFIDENCE.HIGH,
          itemId: item.inventoryItemId,
          requiredQuantity: item.requiredQuantity,
          shortageQuantity: item.shortageQuantity,
          consumedQuantity: item.consumedQuantity,
        });
      }
    }
    for (const item of reservation.items) {
      const requiredQuantity = item.requiredQuantity ?? 0;
      const consumedQuantity = item.consumedQuantity ?? 0;
      const shortageQuantity = item.shortageQuantity ?? 0;
      if (requiredQuantity <= QTY_EPSILON) continue;
      if (consumedQuantity > QTY_EPSILON) continue;
      if (shortageQuantity > QTY_EPSILON) continue;
      const hasMovement = sales.some((movement) => idEquals(movement.item, item.inventoryItemId));
      if (!hasMovement) {
        emit("D01", "CONSUMED_WITHOUT_ITEM_EVIDENCE", {
          severity: SEVERITY.CRITICAL,
          confidence: CONFIDENCE.MEDIUM,
          itemId: item.inventoryItemId,
          requiredQuantity,
          consumedQuantity,
          shortageQuantity,
        });
      }
    }
    return;
  }

  if (
    reservation.status === "RESERVED" ||
    reservation.status === "APPROVED" ||
    reservation.status === "APPROVAL_REQUIRED"
  ) {
    emit("D01", "PAID_WITH_LIVE_RESERVATION", {
      severity: SEVERITY.CRITICAL,
      confidence: CONFIDENCE.HIGH,
    });
    return;
  }

  if (
    reservation.status === "RELEASED" &&
    reservation.releaseReason === "CONSUMPTION_FAILED" &&
    sales.length === 0
  ) {
    emit("D01", "PAID_RELEASED_NO_DEDUCTION", {
      severity: SEVERITY.CRITICAL,
      confidence: CONFIDENCE.HIGH,
    });
  }
}

function classifyD02(context, emit) {
  const { evidence } = context;
  const order = evidence.order;
  const sales = saleMovements(evidence.movements);

  if (order === null) {
    if (evidence.movements.length === 0) return;
    const movement = evidence.movements.find((entry) => entry.refOrderId !== null);
    emit("D02", "ORPHAN_DEDUCTION", {
      orderId: movement ? movement.refOrderId : null,
      severity: SEVERITY.CRITICAL,
      confidence: CONFIDENCE.HIGH,
    });
    return;
  }

  if (sales.length === 0) return;

  if (ACTIVE_ORDER_STATUSES.has(order.status)) {
    const anyStation =
      order.kitchenStatus !== null ||
      order.baristaStatus !== null ||
      order.hotDrinkStatus !== null;
    if (order.preparingAt === null && !anyStation) {
      emit("D02", "DEDUCTION_WITHOUT_PREPARATION_OR_PAYMENT", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.MEDIUM,
      });
    }
    return;
  }

  if (order.status === "CANCELLED" || order.status === "ARCHIVED") {
    const reservation = evidence.reservation;
    if (reservation !== null && reservationHasVoidSource(reservation, ["ORDER", "ARCHIVE", "LINE"])) {
      return;
    }
    if (reservation === null && order.status === "ARCHIVED") {
      emit("D02", "LEGACY_DEDUCTION", {
        severity: SEVERITY.INFO,
        confidence: CONFIDENCE.MEDIUM,
      });
      return;
    }
    emit("D02", "TERMINAL_DEDUCTION_NO_VOID", {
      severity: SEVERITY.HIGH,
      confidence: CONFIDENCE.HIGH,
    });
    return;
  }

  if (order.status === "PAID") return;

  emit("D02", "UNKNOWN_LIFECYCLE_DEDUCTION", {
    severity: SEVERITY.HIGH,
    confidence: CONFIDENCE.MEDIUM,
  });
}

function expectedSaleKey(movement) {
  return `sale:${identifierString(movement.refOrderId)}:${identifierString(movement.item)}`;
}

function classifyD03(context, emit) {
  const { evidence } = context;
  const sales = saleMovements(evidence.movements);
  let duplicateIdentity = false;

  const byItem = new Map();
  for (const movement of sales) {
    if (movement.item === null) continue;
    const key = identifierKey(movement.item);
    const list = byItem.get(key) ?? [];
    list.push(movement);
    byItem.set(key, list);
  }
  for (const list of byItem.values()) {
    if (list.length > 1) {
      duplicateIdentity = true;
      emit("D03", "DUPLICATE_MOVEMENT_IDENTITY", {
        severity: SEVERITY.CRITICAL,
        confidence: CONFIDENCE.HIGH,
        itemId: list[0].item,
        movementQuantity: list.reduce((total, entry) => total + (entry.quantity ?? 0), 0),
      });
    }
  }

  const byKey = new Map();
  for (const movement of evidence.movements) {
    if (movement.idempotencyKey === null) continue;
    if (!movement.idempotencyKey.startsWith("sale:")) continue;
    const list = byKey.get(movement.idempotencyKey) ?? [];
    list.push(movement);
    byKey.set(movement.idempotencyKey, list);
  }
  for (const list of byKey.values()) {
    if (list.length > 1) {
      emit("D03", "DUPLICATE_IDEMPOTENCY_KEY", {
        severity: SEVERITY.CRITICAL,
        confidence: CONFIDENCE.HIGH,
        itemId: list[0].item,
        movementQuantity: list.reduce((total, entry) => total + (entry.quantity ?? 0), 0),
        evidenceLevel: "E2",
      });
    }
  }

  for (const movement of sales) {
    if (movement.idempotencyKey === null) continue;
    if (movement.idempotencyKey !== expectedSaleKey(movement)) {
      emit("D03", "MALFORMED_SALE_KEY", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
        itemId: movement.item,
      });
    }
  }

  const indexState = context.options.indexEvidence.saleDeductionUnique;
  if (indexState === "ABSENT" || (duplicateIdentity && indexState !== "PRESENT")) {
    emit("D03", "INDEX_ABSENT_SUSPECTED", {
      severity: indexState === "ABSENT" ? SEVERITY.MEDIUM : SEVERITY.MEDIUM,
      confidence: CONFIDENCE.MEDIUM,
      indexState,
      classification: "INDEX_EVIDENCE",
    });
  }
}

function classifyD04(context, emit) {
  const { evidence, reservations } = context;
  const order = evidence.order;
  const reservation = evidence.reservation;

  if (reservations.length > 1) {
    emit("D04", "DUPLICATE_RESERVATION", {
      severity: SEVERITY.CRITICAL,
      confidence: CONFIDENCE.HIGH,
      reservationId: reservation?.id ?? null,
    });
  }
  if (order === null && reservations.length > 0) {
    emit("D04", "ORPHAN_RESERVATION", {
      severity: SEVERITY.HIGH,
      confidence: CONFIDENCE.HIGH,
      orderId: reservation?.orderId ?? null,
      reservationId: reservation?.id ?? null,
    });
  }
  if (reservation === null) return;

  if (reservation.status === "APPROVAL_REQUIRED") {
    emit("D04", "AWAITING_APPROVAL", {
      severity: SEVERITY.INFO,
      confidence: CONFIDENCE.HIGH,
    });
  }

  if (
    reservation.status === "CONSUMED" &&
    (reservation.consumedAt === null ||
      reservation.items.every((item) => (item.consumedQuantity ?? 0) <= QTY_EPSILON))
  ) {
    emit("D04", "CONSUMED_WITHOUT_EVIDENCE", {
      severity: SEVERITY.HIGH,
      confidence: CONFIDENCE.HIGH,
    });
  }

  if (
    reservation.status === "RELEASED" &&
    reservation.items.some((item) => (item.reservedQuantity ?? 0) > QTY_EPSILON)
  ) {
    emit("D04", "RELEASED_WITH_HOLD", {
      severity: SEVERITY.HIGH,
      confidence: CONFIDENCE.HIGH,
    });
  }

  if (reservation.status === "APPROVED" && reservation.approval === null) {
    emit("D04", "APPROVED_WITHOUT_APPROVAL", {
      severity: SEVERITY.HIGH,
      confidence: CONFIDENCE.HIGH,
    });
  }

  if (
    reservation.approval !== null &&
    reservation.approval.requirementFingerprint !== null &&
    reservation.requirementFingerprint !== null &&
    reservation.approval.requirementFingerprint !== reservation.requirementFingerprint
  ) {
    emit("D04", "APPROVAL_FINGERPRINT_MISMATCH", {
      severity: SEVERITY.MEDIUM,
      confidence: CONFIDENCE.MEDIUM,
    });
  }

  const inventoryKeys = new Set(evidence.inventory.map((item) => identifierKey(item.id)));
  for (const item of reservation.items) {
    if (item.inventoryItemId === null) continue;
    const requiredQuantity = item.requiredQuantity ?? 0;
    const consumedQuantity = item.consumedQuantity ?? 0;
    const reservedQuantity = item.reservedQuantity ?? 0;
    if (consumedQuantity > requiredQuantity + QTY_EPSILON) {
      emit("D04", "CONSUMED_EXCEEDS_REQUIRED", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
        itemId: item.inventoryItemId,
        requiredQuantity,
        consumedQuantity,
      });
    }
    if (reservedQuantity < 0 || consumedQuantity < 0) {
      emit("D04", "NEGATIVE_RESERVATION_QUANTITY", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
        itemId: item.inventoryItemId,
        reservedQuantity,
        consumedQuantity,
      });
    }
    if (evidence.inventory.length > 0 && !inventoryKeys.has(identifierKey(item.inventoryItemId))) {
      emit("D04", "MISSING_INVENTORY_ITEM", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
        itemId: item.inventoryItemId,
      });
    }
  }
}

function classifyD05(context, emit) {
  const { evidence, reservations } = context;
  const order = evidence.order;

  for (const reservation of reservations) {
    if (!LIVE_RESERVATION_STATUSES.has(reservation.status)) continue;
    if (reservation.status === "NO_INVENTORY" && sumReserved(reservation) <= QTY_EPSILON) {
      continue;
    }
    if (order === null) {
      emit("D05", "ORPHAN_LIVE_HOLD", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
        orderId: reservation.orderId,
        reservationId: reservation.id,
      });
      continue;
    }
    if (order.status === "CANCELLED" || order.status === "ARCHIVED") {
      emit("D05", "HOLD_ON_TERMINAL_ORDER", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
        reservationId: reservation.id,
      });
      continue;
    }
    if (order.status === "PAID") {
      emit("D05", "PAID_WITH_LIVE_HOLD", {
        severity: SEVERITY.CRITICAL,
        confidence: CONFIDENCE.HIGH,
        reservationId: reservation.id,
        classification: "CROSS_REFERENCE",
      });
      continue;
    }
    if (ACTIVE_ORDER_STATUSES.has(order.status)) {
      context.defer("D05", "STALE_LIVE_HOLD", "W_STALE_UNSET_OR_AGE_NOT_PROJECTED", {
        reservationId: reservation.id,
        orderId: reservation.orderId,
      });
    }
  }
}

function classifyD06(context, emit) {
  const { evidence, reservations } = context;
  const order = evidence.order;
  const quantities = movementQuantities(evidence.movements);

  for (const reservation of reservations) {
    if (reservation.status !== "CONSUMING") continue;
    const expected = reservation.items.filter(
      (item) => (item.requiredQuantity ?? 0) > (item.shortageQuantity ?? 0) + QTY_EPSILON,
    );
    const complete =
      expected.length > 0 &&
      expected.every(
        (item) =>
          (quantities.get(identifierKey(item.inventoryItemId)) ?? 0) >=
          (item.requiredQuantity ?? 0) - QTY_EPSILON,
      );
    const anyPositive = expected.some(
      (item) => (quantities.get(identifierKey(item.inventoryItemId)) ?? 0) > QTY_EPSILON,
    );
    const none = quantities.size === 0;
    const holdsStock = sumReserved(reservation) > QTY_EPSILON;

    let code;
    let severity;
    let confidence;
    let candidate = null;
    if (order === null) {
      code = "CONSUMING_ORPHAN";
      severity = SEVERITY.CRITICAL;
      confidence = CONFIDENCE.HIGH;
    } else if (complete && !holdsStock) {
      code = "CONSUMING_MOVEMENTS_COMPLETE";
      severity = SEVERITY.HIGH;
      confidence = CONFIDENCE.HIGH;
      candidate = "FINALIZE_CANDIDATE";
    } else if (anyPositive && !complete) {
      code = "CONSUMING_PARTIAL";
      severity = SEVERITY.CRITICAL;
      confidence = CONFIDENCE.HIGH;
    } else if (none) {
      code = "CONSUMING_ABANDONED";
      severity = SEVERITY.HIGH;
      confidence = CONFIDENCE.MEDIUM;
    } else {
      code = "CONSUMING_AMBIGUOUS";
      severity = SEVERITY.CRITICAL;
      confidence = CONFIDENCE.MEDIUM;
    }
    emit("D06", code, {
      severity,
      confidence,
      reservationId: reservation.id,
      itemId: expected.length === 1 ? expected[0].inventoryItemId : null,
      candidate,
      classification: "ALERT",
      thresholdState: "W_STALE_UNSET",
      graceMs: 0,
    });
    context.defer("D06", code, "W_STALE_UNSET_OR_AGE_NOT_PROJECTED", {
      reservationId: reservation.id,
      orderId: reservation.orderId,
    });
  }
}

function classifyD07(context, emit) {
  const { evidence } = context;
  const order = evidence.order;
  const reservation = evidence.reservation;
  if (order === null || reservation === null) return;
  if (reservation.status !== "CONSUMED") return;

  const quantities = movementQuantities(evidence.movements);
  const reservationKeys = new Set();

  for (const item of reservation.items) {
    if (item.inventoryItemId === null) continue;
    const key = identifierKey(item.inventoryItemId);
    reservationKeys.add(key);
    const moved = quantities.get(key) ?? 0;
    const requiredQuantity = item.requiredQuantity ?? 0;
    const shortageQuantity = item.shortageQuantity ?? 0;
    const consumedQuantity = item.consumedQuantity ?? 0;
    if (Math.abs(moved - consumedQuantity) > QTY_EPSILON) {
      emit("D07", "CONSUMED_MOVEMENT_MISMATCH", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
        itemId: item.inventoryItemId,
        requiredQuantity,
        consumedQuantity,
        movementQuantity: moved,
      });
    }
    if (
      requiredQuantity > shortageQuantity + QTY_EPSILON &&
      consumedQuantity <= QTY_EPSILON &&
      moved <= QTY_EPSILON
    ) {
      emit("D07", "REQUIRED_ITEM_NOT_CONSUMED", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.MEDIUM,
        itemId: item.inventoryItemId,
        requiredQuantity,
        consumedQuantity,
        movementQuantity: moved,
      });
    }
  }

  for (const [key, moved] of quantities) {
    if (reservationKeys.has(key)) continue;
    const movement = saleMovements(evidence.movements).find(
      (entry) => entry.item !== null && identifierKey(entry.item) === key,
    );
    emit("D07", "MOVEMENT_WITHOUT_RESERVATION_ITEM", {
      severity: SEVERITY.HIGH,
      confidence: CONFIDENCE.HIGH,
      itemId: movement ? movement.item : null,
      movementQuantity: moved,
    });
  }

  context.defer("D07", "STATION_PARTIAL_CONSUMPTION", "STATION_ATTRIBUTION_NOT_PROJECTED");
}

function classifyD08(context, emit) {
  const { evidence } = context;
  const order = evidence.order;
  if (order === null) return;
  const reservation = evidence.reservation;
  const sales = saleMovements(evidence.movements);
  const cancelledLines = order.items.filter((item) => item.cancelled === true);

  if (reservation !== null) {
    const voidCounts = new Map();
    for (const entry of reservation.voids) {
      const key = `${entry.source ?? "null"}:${identifierKey(entry.lineId)}`;
      voidCounts.set(key, (voidCounts.get(key) ?? 0) + 1);
    }
    for (const count of voidCounts.values()) {
      if (count > 1) {
        emit("D08", "DUPLICATE_VOID", {
          severity: SEVERITY.MEDIUM,
          confidence: CONFIDENCE.HIGH,
        });
        break;
      }
    }
  }

  if (
    order.status !== "CANCELLED" &&
    order.status !== "ARCHIVED" &&
    cancelledLines.length === 0
  ) {
    return;
  }

  if (
    (order.status === "CANCELLED" || order.status === "ARCHIVED") &&
    reservation !== null &&
    reservation.status === "CONSUMED"
  ) {
    if (!reservationHasVoidSource(reservation, ["ORDER", "ARCHIVE"])) {
      emit("D08", "CANCELLED_NO_ORDER_VOID", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (sales.length > 0) {
      emit("D08", "CANCELLED_SALE_NOT_RECLASSIFIED", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    return;
  }

  if (order.status === "CANCELLED" && reservation !== null && LIVE_RESERVATION_STATUSES.has(reservation.status)) {
    if (reservation.status !== "NO_INVENTORY" || sumReserved(reservation) > QTY_EPSILON) {
      emit("D08", "CANCELLED_HOLD_NOT_RELEASED", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    return;
  }

  if (
    reservation !== null &&
    (reservation.status === "CONSUMED" ||
      reservation.items.some((item) => (item.consumedQuantity ?? 0) > QTY_EPSILON))
  ) {
    for (const line of cancelledLines) {
      if (line.lineId !== null && !reservationHasLineVoid(reservation, line.lineId)) {
        emit("D08", "LINE_CANCEL_NO_VOID", {
          severity: SEVERITY.MEDIUM,
          confidence: CONFIDENCE.MEDIUM,
          lineId: line.lineId,
        });
      }
    }
    return;
  }

  if (
    reservation !== null &&
    (reservation.status === "RESERVED" ||
      reservation.status === "APPROVED" ||
      reservation.status === "APPROVAL_REQUIRED")
  ) {
    const stillRequired = reservation.items.filter(
      (item) =>
        item.inventoryItemId !== null &&
        (item.requiredQuantity ?? 0) > QTY_EPSILON &&
        orderLinksItemOnlyToCancelledLines(order, item.inventoryItemId),
    );
    if (stillRequired.length > 0) {
      emit("D08", "LINE_CANCEL_HOLD_NOT_RECONCILED", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.MEDIUM,
        itemId: stillRequired[0].inventoryItemId,
        requiredQuantity: stillRequired[0].requiredQuantity,
      });
    }
  }
}

function classifyD09(context, emit) {
  const { evidence } = context;
  const order = evidence.order;
  if (order === null) return;
  const reservation = evidence.reservation;

  if (order.status === "PAYMENT_PENDING") {
    if (order.paymentMethod === null || order.paymentMethod === "NONE" || order.paymentSubmittedAt === null) {
      emit("D09", "PENDING_WITHOUT_SUBMISSION", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (order.paidAt !== null) {
      emit("D09", "PENDING_WITH_PAID_AT", {
        severity: SEVERITY.CRITICAL,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (order.paymentVerifiedAt !== null) {
      emit("D09", "PENDING_WITH_VERIFICATION", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (
      order.paymentRejectedAt !== null &&
      order.paymentSubmittedAt !== null &&
      order.paymentSubmittedAt < order.paymentRejectedAt
    ) {
      emit("D09", "PENDING_AFTER_REJECTION", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.MEDIUM,
      });
    }
  }

  if (order.status === "PAID") {
    if (order.paidAt === null) {
      emit("D09", "PAID_WITHOUT_PAID_AT", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (order.paymentMethod === null || order.paymentMethod === "NONE") {
      emit("D09", "PAID_WITHOUT_METHOD", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (
      order.paymentMethod === "TRANSFER" &&
      (order.paymentAccountId === null || order.paymentAccountSnapshotPresent !== true)
    ) {
      emit("D09", "PAID_TRANSFER_WITHOUT_ACCOUNT", {
        severity: SEVERITY.MEDIUM,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (order.paymentRejectedAt !== null) {
      emit("D09", "PAID_WITH_REJECTION_TIMESTAMP", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.MEDIUM,
      });
    }
  }

  if (
    isPrepared(order) &&
    reservation !== null &&
    (reservation.status === "RESERVED" ||
      reservation.status === "APPROVED" ||
      reservation.status === "APPROVAL_REQUIRED")
  ) {
    emit("D09", "PREPARED_WITH_LIVE_HOLD", {
      severity: SEVERITY.HIGH,
      confidence: CONFIDENCE.HIGH,
    });
  }

  if (order.paymentVerifiedAt !== null && order.status !== "PAID") {
    emit("D09", "VERIFIED_NOT_PAID", {
      severity: SEVERITY.MEDIUM,
      confidence: CONFIDENCE.MEDIUM,
    });
  }
}

function classifyD10(context, emit, gating) {
  const { evidence, options } = context;
  const order = evidence.order;
  const reservation = evidence.reservation;

  const report = (code, fields) => {
    gating.add(code);
    emit("D10", code, fields);
  };

  if (order !== null) {
    if (order.id === null) {
      report("MISSING_REQUIRED_FIELD", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (order.status === null) {
      report("MISSING_REQUIRED_FIELD", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    } else if (!ORDER_STATUS_SET.has(order.status)) {
      report("UNKNOWN_ENUM", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (order.paymentMethod !== null && !PAYMENT_METHODS.has(order.paymentMethod)) {
      report("UNKNOWN_ENUM", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    for (const item of order.items) {
      if ((item.quantity ?? 0) < 0) {
        report("NEGATIVE_QUANTITY", {
          severity: SEVERITY.HIGH,
          confidence: CONFIDENCE.HIGH,
          lineId: item.lineId,
        });
      }
      for (const component of item.components) {
        if ((component.stockQuantity ?? 0) < 0) {
          report("NEGATIVE_QUANTITY", {
            severity: SEVERITY.HIGH,
            confidence: CONFIDENCE.HIGH,
            lineId: item.lineId,
            itemId: component.inventoryItemId,
          });
        }
      }
    }
    if (
      order.createdAt !== null &&
      order.paidAt !== null &&
      order.paidAt < order.createdAt
    ) {
      report("CONTRADICTORY_TIMESTAMPS", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (
      order.paymentSubmittedAt !== null &&
      order.paymentVerifiedAt !== null &&
      order.paymentVerifiedAt < order.paymentSubmittedAt
    ) {
      report("CONTRADICTORY_TIMESTAMPS", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
  }

  if (reservation !== null) {
    if (reservation.id === null) {
      report("MISSING_REQUIRED_FIELD", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (reservation.orderId === null) {
      report("MISSING_REQUIRED_FIELD", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (reservation.status === null) {
      report("MISSING_REQUIRED_FIELD", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    } else if (!RESERVATION_STATUS_SET.has(reservation.status)) {
      report("UNKNOWN_ENUM", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (
      reservation.requirementFingerprint === null &&
      reservation.shortageFingerprint === null &&
      reservation.status !== "NO_INVENTORY"
    ) {
      emit("D10", "LEGACY_SHAPE", {
        severity: SEVERITY.INFO,
        confidence: CONFIDENCE.MEDIUM,
      });
    }
    if (
      order !== null &&
      order.orderNumber !== null &&
      reservation.orderNumber !== null &&
      !idEquals(order.orderNumber, reservation.orderNumber)
    ) {
      report("IDENTITY_MISMATCH", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    for (const item of reservation.items) {
      if (item.inventoryItemId === null) {
        report("MISSING_REQUIRED_FIELD", {
          severity: SEVERITY.HIGH,
          confidence: CONFIDENCE.HIGH,
        });
      }
      if (item.requiredQuantity === null) {
        report("MISSING_REQUIRED_FIELD", {
          severity: SEVERITY.HIGH,
          confidence: CONFIDENCE.HIGH,
          itemId: item.inventoryItemId,
        });
      }
      for (const quantity of [
        item.requiredQuantity,
        item.reservedQuantity,
        item.shortageQuantity,
        item.consumedQuantity,
      ]) {
        if (quantity !== null && quantity < 0) {
          report("NEGATIVE_QUANTITY", {
            severity: SEVERITY.HIGH,
            confidence: CONFIDENCE.HIGH,
            itemId: item.inventoryItemId,
            requiredQuantity: item.requiredQuantity,
            reservedQuantity: item.reservedQuantity,
            consumedQuantity: item.consumedQuantity,
          });
          break;
        }
      }
      if (
        item.requiredQuantity !== null &&
        item.consumedQuantity !== null &&
        item.consumedQuantity > item.requiredQuantity + QTY_EPSILON
      ) {
        report("QUANTITY_OUT_OF_RANGE", {
          severity: SEVERITY.HIGH,
          confidence: CONFIDENCE.HIGH,
          itemId: item.inventoryItemId,
          requiredQuantity: item.requiredQuantity,
          consumedQuantity: item.consumedQuantity,
        });
      }
      if (
        (reservation.status === "CONSUMED" || reservation.status === "RELEASED") &&
        (item.reservedQuantity ?? 0) > QTY_EPSILON
      ) {
        if (reservation.status === "CONSUMED") {
          report("QUANTITY_OUT_OF_RANGE", {
            severity: SEVERITY.HIGH,
            confidence: CONFIDENCE.HIGH,
            itemId: item.inventoryItemId,
            reservedQuantity: item.reservedQuantity,
          });
        }
      }
    }
  }

  const inventoryKeys = new Set(evidence.inventory.map((item) => identifierKey(item.id)));
  for (const movement of evidence.movements) {
    if (movement.id === null) {
      report("MISSING_REQUIRED_FIELD", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (movement.type === null) {
      report("MISSING_REQUIRED_FIELD", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    } else if (!MOVEMENT_TYPES.has(movement.type)) {
      report("UNKNOWN_ENUM", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (movement.reason !== null && !MOVEMENT_REASONS.has(movement.reason)) {
      report("UNKNOWN_ENUM", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    }
    if (movement.quantity === null) {
      report("MISSING_REQUIRED_FIELD", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
      });
    } else {
      if (movement.quantity < 0) {
        report("NEGATIVE_QUANTITY", {
          severity: SEVERITY.HIGH,
          confidence: CONFIDENCE.HIGH,
          itemId: movement.item,
          movementQuantity: movement.quantity,
        });
      }
      if (movement.type === "OUT" && movement.quantity <= 0) {
        report("QUANTITY_OUT_OF_RANGE", {
          severity: SEVERITY.HIGH,
          confidence: CONFIDENCE.HIGH,
          itemId: movement.item,
          movementQuantity: movement.quantity,
        });
      }
    }
    if (movement.reason === "SaleDeduction" && movement.refOrderId === null) {
      report("MISSING_REQUIRED_FIELD", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
        itemId: movement.item,
      });
    }
    if (
      movement.item !== null &&
      evidence.inventory.length > 0 &&
      !inventoryKeys.has(identifierKey(movement.item))
    ) {
      report("ORPHAN_REFERENCE", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
        itemId: movement.item,
      });
    }
  }

  if (options.expectedFingerprints !== null) {
    const key = orderKeyOf(evidence);
    const expected = options.expectedFingerprints[key];
    if (expected !== undefined && expected !== context.fingerprint.digest) {
      report("EVIDENCE_DRIFT", {
        severity: SEVERITY.HIGH,
        confidence: CONFIDENCE.HIGH,
        expectedFingerprint: expected,
        observedFingerprint: context.fingerprint.digest,
      });
    }
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function compareFindings(a, b) {
  const left = [
    identifierKey(a.orderId),
    a.rule,
    a.code,
    a.itemId === null ? "" : identifierKey(a.itemId),
    a.lineId === null ? "" : identifierKey(a.lineId),
    a.dedupeKey,
  ];
  const right = [
    identifierKey(b.orderId),
    b.rule,
    b.code,
    b.itemId === null ? "" : identifierKey(b.itemId),
    b.lineId === null ? "" : identifierKey(b.lineId),
    b.dedupeKey,
  ];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function dedupeFindings(findings) {
  const seen = new Set();
  const unique = [];
  for (const finding of findings) {
    if (seen.has(finding.dedupeKey)) continue;
    seen.add(finding.dedupeKey);
    unique.push(finding);
  }
  return unique;
}

function sortDeferred(entries) {
  return entries.sort((a, b) => {
    const left = `${a.rule}:${a.code}:${identifierKey(a.orderId)}:${a.reason}`;
    const right = `${b.rule}:${b.code}:${identifierKey(b.orderId)}:${b.reason}`;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function buildReport(findings, deferred, groups, options) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byRule = {};
  for (const rule of RULES) byRule[rule.id] = 0;
  const byClassification = { DEFECT: 0, ALERT: 0, INFO: 0, CROSS_REFERENCE: 0, INDEX_EVIDENCE: 0 };
  for (const finding of findings) {
    const severity = finding.severity.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(bySeverity, severity)) bySeverity[severity] += 1;
    byRule[finding.rule] += 1;
    if (Object.prototype.hasOwnProperty.call(byClassification, finding.classification)) {
      byClassification[finding.classification] += 1;
    }
  }
  return {
    schema: FINDING_SCHEMA_VERSION,
    classifier: CLASSIFIER_VERSION,
    generatedAt: options.now,
    window: Object.freeze({ since: options.since, until: options.until }),
    readOnly: true,
    summary: Object.freeze({
      ordersScanned: groups.length,
      findings: findings.length,
      bySeverity: Object.freeze(bySeverity),
      byRule: Object.freeze(byRule),
      byClassification: Object.freeze(byClassification),
    }),
    findings: Object.freeze(findings),
    deferred: Object.freeze(sortDeferred(deferred)),
  };
}

/**
 * Classify a single projected evidence bundle.
 *
 * @param {Object} evidence A bundle returned by WP04-01 `projectEvidence()`.
 * @param {Object} [options]
 * @returns {Readonly<Object>} Frozen finding report.
 */
export function classifyEvidence(evidence, options = {}) {
  return classifyBundles([{ evidence }], options);
}

/**
 * Classify multiple projected evidence bundles. Bundles sharing an order id are
 * grouped so duplicate-reservation and cross-bundle checks can run.
 *
 * @param {Array<Object>} bundles Either projected evidence bundles or
 *   `{ evidence, indexEvidence }` wrappers.
 * @param {Object} [options]
 * @returns {Readonly<Object>} Frozen finding report.
 */
export function classifyBundles(bundles, options = {}) {
  const normalizedOptions = normalizeOptions(options);
  if (!Array.isArray(bundles)) {
    fail("INVALID_INPUT", "bundles", "bundles must be an array of evidence bundles");
  }
  if (bundles.length > normalizedOptions.maxBundles) {
    fail(
      "EVIDENCE_BOUND_EXCEEDED",
      "bundles",
      `bundles exceeds the classifier limit of ${normalizedOptions.maxBundles}`,
    );
  }

  const normalized = bundles.map(normalizeBundle);

  const grouped = new Map();
  normalized.forEach((entry, index) => {
    const key = orderKeyOf(entry.evidence) === "unknown" ? `unknown:${index}` : orderKeyOf(entry.evidence);
    const groupItems = grouped.get(key) ?? [];
    groupItems.push(entry);
    grouped.set(key, groupItems);
  });

  const groups = [...grouped.values()].map(buildGroup);
  const findings = [];
  const deferred = [];

  for (const group of groups) {
    const groupIndexEvidence =
      group.evidence.reservation !== null
        ? normalized.find((entry) => entry.evidence.reservation === group.evidence.reservation)?.indexEvidence
        : normalized.find((entry) => entry.indexEvidence !== null)?.indexEvidence;
    const effectiveOptions =
      groupIndexEvidence === null || groupIndexEvidence === undefined
        ? normalizedOptions
        : Object.freeze({ ...normalizedOptions, indexEvidence: groupIndexEvidence });
    const context = {
      evidence: group.evidence,
      reservations: group.reservations,
      options: effectiveOptions,
      fingerprint: fingerprintEvidence(group.evidence),
      defer(rule, code, reason, details = {}) {
        deferred.push(
          Object.freeze({
            rule,
            code,
            reason,
            orderId: details.orderId ?? orderIdOf(group.evidence),
            reservationId: details.reservationId ?? group.evidence.reservation?.id ?? null,
          }),
        );
      },
    };
    const emit = (ruleId, code, fields = {}) => {
      findings.push(makeFinding(context, ruleId, code, fields));
      if (findings.length > effectiveOptions.maxFindings) {
        fail(
          "EVIDENCE_BOUND_EXCEEDED",
          "findings",
          `findings exceeds the classifier limit of ${effectiveOptions.maxFindings}`,
        );
      }
    };

    const gating = new Set();
    classifyD10(context, emit, gating);
    if (gating.size > 0) continue;

    classifyD01(context, emit);
    classifyD02(context, emit);
    classifyD03(context, emit);
    classifyD04(context, emit);
    classifyD05(context, emit);
    classifyD06(context, emit);
    classifyD07(context, emit);
    classifyD08(context, emit);
    classifyD09(context, emit);
  }

  const unique = dedupeFindings(findings);
  unique.sort(compareFindings);
  return deepFreeze(buildReport(unique, deferred, groups, normalizedOptions));
}

