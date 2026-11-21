// WP04-01 — Stable, versioned evidence fingerprint.
//
// The fingerprint is SHA-256 over a canonical JSON representation of the
// fingerprint-relevant subset of a projected evidence bundle. It detects
// evidence drift; it does NOT prove the underlying evidence is true, correct,
// complete, or fraud-free.
//
// Canonicalization rules (version 1):
//   * object keys sorted by UTF-16 code unit order;
//   * no insignificant whitespace;
//   * strings serialized with JSON escaping, no implicit Unicode normalization;
//   * numbers use the ECMAScript shortest round-trip representation;
//   * -0 normalizes to 0;
//   * null and undefined both serialize as null;
//   * dates are already ISO-8601 UTC strings from the evidence projection;
//   * identifiers are already type-preserving (string / integer / { $oid });
//   * arrays are ordered by the caller unless the fingerprint payload sorts them.
//
// Pure module: no database, network, filesystem, or environment access.

import { createHash } from "node:crypto";

import { EVIDENCE_SCHEMA_VERSION } from "./evidence.js";

export const FINGERPRINT_VERSION = "wp04-fingerprint-v1";
export const HASH_ALGORITHM = "sha256";

export class FingerprintError extends Error {
  /**
   * @param {string} code Stable error code.
   * @param {string} [field] Offending field path, if known.
   * @param {string} [message] Safe message with no evidence payload.
   */
  constructor(code, field = null, message = code) {
    super(message);
    this.name = "FingerprintError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message) {
  throw new FingerprintError(code, field, message || code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Serialize any supported value to canonical JSON.
 *
 * Unsupported values (functions, symbols, bigints, Dates, ObjectIds, class
 * instances, non-finite numbers) are rejected rather than coerced, so evidence
 * can never silently change shape.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
  if (value === null || value === undefined) return "null";

  const type = typeof value;
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(value)) {
      fail("UNSERIALIZABLE_NUMBER", null, "non-finite numbers are not canonicalizable");
    }
    if (Object.is(value, -0)) return "0";
    return String(value);
  }
  if (type === "string") return JSON.stringify(value);
  if (type === "bigint" || type === "function" || type === "symbol") {
    fail("UNSUPPORTED_TYPE", null, `${type} values are not canonicalizable`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }

  if (isPlainObject(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail("UNSUPPORTED_SYMBOL_KEY", null, "symbol keys are not canonicalizable");
    }
    const keys = Object.keys(value).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`,
    );
    return `{${entries.join(",")}}`;
  }

  fail("UNSUPPORTED_TYPE", null, "only plain objects, arrays, and primitives are canonicalizable");
}

function byCanonical(a, b) {
  const left = canonicalize(a);
  const right = canonicalize(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) out[key] = source?.[key] ?? null;
  return out;
}

const ORDER_FP_FIELDS = Object.freeze([
  "id",
  "orderNumber",
  "status",
  "paidAt",
  "paymentMethod",
  "paymentAccountId",
  "updatedAt",
]);

const RESERVATION_FP_FIELDS = Object.freeze([
  "id",
  "orderId",
  "status",
  "consumedAt",
  "consumedTrigger",
  "releasedAt",
  "releaseReason",
]);

const RESERVATION_ITEM_FP_FIELDS = Object.freeze([
  "inventoryItemId",
  "requiredQuantity",
  "reservedQuantity",
  "shortageQuantity",
  "consumedQuantity",
]);

const VOID_FP_FIELDS = Object.freeze(["at", "source", "lineId"]);

const MOVEMENT_FP_FIELDS = Object.freeze([
  "id",
  "item",
  "type",
  "quantity",
  "reason",
  "idempotencyKey",
  "voidedAt",
]);

const INVENTORY_FP_FIELDS = Object.freeze(["id", "currentStock", "reservedStock"]);

/**
 * Build the narrow, deterministic fingerprint payload from a projected bundle.
 *
 * Classification-only fields (station status, payment workflow timestamps,
 * order items, reservation approval metadata, free-text reasons, account
 * snapshots) are deliberately excluded.
 *
 * @param {Object} evidence A bundle returned by projectEvidence().
 * @returns {Readonly<Object>}
 */
export function toFingerprintPayload(evidence) {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    fail("INVALID_EVIDENCE", "evidence", "evidence must be a projected object");
  }
  if (evidence.schema !== EVIDENCE_SCHEMA_VERSION) {
    fail(
      "UNSUPPORTED_EVIDENCE_VERSION",
      "evidence.schema",
      `expected ${EVIDENCE_SCHEMA_VERSION}`,
    );
  }

  const order = evidence.order
    ? {
        ...pick(evidence.order, ORDER_FP_FIELDS),
        cancelledLineIds: [...(evidence.order.cancelledLineIds || [])].sort(byCanonical),
      }
    : null;

  const reservation = evidence.reservation
    ? {
        ...pick(evidence.reservation, RESERVATION_FP_FIELDS),
        items: [...(evidence.reservation.items || [])]
          .map((item) => pick(item, RESERVATION_ITEM_FP_FIELDS))
          .sort(byCanonical),
        voids: [...(evidence.reservation.voids || [])]
          .map((voidEntry) => ({
            ...pick(voidEntry, VOID_FP_FIELDS),
            items: [...(voidEntry.items || [])]
              .map((item) =>
                pick(item, Object.freeze(["inventoryItemId", "quantity"])),
              )
              .sort(byCanonical),
          }))
          .sort(byCanonical),
      }
    : null;

  const movements = [...(evidence.movements || [])]
    .map((movement) => pick(movement, MOVEMENT_FP_FIELDS))
    .sort(byCanonical);

  const inventory = [...(evidence.inventory || [])]
    .map((item) => pick(item, INVENTORY_FP_FIELDS))
    .sort(byCanonical);

  return Object.freeze({
    schema: EVIDENCE_SCHEMA_VERSION,
    order,
    reservation,
    movements: Object.freeze(movements),
    inventory: Object.freeze(inventory),
  });
}

/**
 * Return the canonical JSON string that is hashed. Exposed for tests and for
 * operators who need to explain a drift without seeing the digest alone.
 *
 * @param {Object} evidence
 * @returns {string}
 */
export function canonicalizeFingerprintPayload(evidence) {
  return canonicalize(toFingerprintPayload(evidence));
}

/**
 * Compute the versioned SHA-256 evidence fingerprint.
 *
 * @param {Object} evidence A bundle returned by projectEvidence().
 * @returns {Readonly<{ version: string, algorithm: string, schema: string, digest: string }>}
 */
export function fingerprintEvidence(evidence) {
  const canonical = canonicalizeFingerprintPayload(evidence);
  const digest = createHash(HASH_ALGORITHM).update(canonical, "utf8").digest("hex");
  return Object.freeze({
    version: FINGERPRINT_VERSION,
    algorithm: HASH_ALGORITHM,
    schema: EVIDENCE_SCHEMA_VERSION,
    digest,
  });
}
