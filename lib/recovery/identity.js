// WP04-06 — Deterministic recovery identity helpers.
//
// This module is pure: no database, network, filesystem, environment, clock, or
// randomness access. It implements the identity shapes approved in
// `docs/production-readiness/wp-04-06-design-consolidation-and-register.md`
// (§2.1, §2.2, §3) and the canonical finding identity in WP04-04 §4.2.
//
// It deliberately does not mint `operationId` values. The register does not
// define an operation-id format; only the H1 history identity is fixed:
//
//   OPH:<taskId>:<operationId>
//
// The task-document CAS remains the operation fence. The history record is
// append-only audit evidence, not a uniqueness fence (OD-30).

import { createHash } from "node:crypto";

import { canonicalize } from "./fingerprint.js";

export const TASK_IDENTITY_SCHEMA_VERSION = "wp04-task-identity-v1";

export const TASK_ID_PREFIX = "REC:v1:";
export const TASK_KEY_PREFIX = "GRP:";
export const EVENT_ID_PREFIX = "EVT:";
export const OPERATION_HISTORY_ID_PREFIX = "OPH:";

export const TASK_ID_PATTERN = /^REC:v1:[a-f0-9]{32}$/;
export const TASK_KEY_PATTERN = /^GRP:[a-f0-9]{24}$/;
export const EVENT_ID_PATTERN = /^EVT:REC:v1:[a-f0-9]{32}:[0-9]+$/;
export const OPERATION_HISTORY_ID_PATTERN = /^OPH:REC:v1:[a-f0-9]{32}:.+$/;

export const MIN_SEQUENCE_NUMBER = 1n;
export const MAX_SEQUENCE_NUMBER = 1_000_000n;

const HEX_24 = /^[a-f0-9]{24}$/;
const HEX_64 = /^[a-f0-9]{64}$/;

export class RecoveryIdentityError extends Error {
  /**
   * @param {string} code Stable error code.
   * @param {string|null} [field] Offending field path, if known.
   * @param {string} [message] Safe message with no evidence payload.
   */
  constructor(code, field = null, message = code) {
    super(message);
    this.name = "RecoveryIdentityError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message) {
  throw new RecoveryIdentityError(code, field, message || code);
}

function isObjectIdLike(value) {
  if (value === null || typeof value !== "object") return false;
  if (value._bsontype === "ObjectId" || value._bsontype === "BSONObjectID") return true;
  return typeof value.toHexString === "function";
}

function objectIdHex(value, field) {
  let hex;
  if (isObjectIdLike(value)) {
    hex = value.toHexString();
  } else if (typeof value === "string") {
    hex = value;
  } else {
    fail("INVALID_IDENTIFIER_TYPE", field, `${field} must be an ObjectId or 24-hex string`);
  }

  const normalized = String(hex).toLowerCase();
  if (!HEX_24.test(normalized)) {
    fail("INVALID_OBJECT_ID", field, `${field} must be a 24-character hex ObjectId`);
  }
  return normalized;
}

function typedNull() {
  return { $type: "null" };
}

/**
 * Normalize an identity identifier to its canonical typed representation.
 *
 * `kind` is positional because the schema fixes the type of each identity slot:
 *   * `objectId` — orderId and itemId are ObjectIds.
 *   * `line`     — lineId is Mixed String/Number (or an ObjectId if supplied).
 *
 * Explicit `{ $oid }`, `{ $str }`, `{ $num }`, and `{ $type: "null" }` wrappers
 * are preserved so callers can remove ambiguity for line identifiers.
 */
function normalizeIdentityIdentifier(value, kind, field) {
  if (value === null) return typedNull();
  if (value === undefined) {
    fail("MISSING_IDENTIFIER", field, `${field} must be explicitly null or a value`);
  }

  if (typeof value === "object") {
    if (isObjectIdLike(value)) {
      return { $oid: objectIdHex(value, field) };
    }
    if (Object.prototype.hasOwnProperty.call(value, "$type") && value.$type === "null") {
      return typedNull();
    }
    if (Object.prototype.hasOwnProperty.call(value, "$oid")) {
      return { $oid: objectIdHex(value.$oid, field) };
    }
    if (Object.prototype.hasOwnProperty.call(value, "$str")) {
      return { $str: String(value.$str) };
    }
    if (Object.prototype.hasOwnProperty.call(value, "$num")) {
      if (!Number.isSafeInteger(value.$num)) {
        fail("INVALID_NUMBER_IDENTIFIER", field, `${field} $num must be a safe integer`);
      }
      return { $num: value.$num };
    }
    fail("INVALID_IDENTIFIER_TYPE", field, `${field} has an unsupported identifier wrapper`);
  }

  if (kind === "objectId") {
    return { $oid: objectIdHex(value, field) };
  }

  if (typeof value === "string") return { $str: value };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("INVALID_NUMBER_IDENTIFIER", field, `${field} must be a safe integer`);
    }
    return { $num: value };
  }

  fail("INVALID_IDENTIFIER_TYPE", field, `${field} has an unsupported identifier type`);
}

export function validateTaskId(value) {
  return typeof value === "string" && TASK_ID_PATTERN.test(value);
}

export function validateTaskKey(value) {
  return typeof value === "string" && TASK_KEY_PATTERN.test(value);
}

export function validateEventId(value) {
  return typeof value === "string" && EVENT_ID_PATTERN.test(value);
}

export function validateOperationHistoryId(value) {
  return typeof value === "string" && OPERATION_HISTORY_ID_PATTERN.test(value);
}

export function validateFingerprint(value) {
  return typeof value === "string" && HEX_64.test(value);
}

export function assertTaskId(value, field = "taskId") {
  if (!validateTaskId(value)) {
    fail("INVALID_TASK_ID", field, `${field} must match REC:v1:<32-hex>`);
  }
  return value;
}

export function assertTaskKey(value, field = "taskKey") {
  if (!validateTaskKey(value)) {
    fail("INVALID_TASK_KEY", field, `${field} must match GRP:<24-hex>`);
  }
  return value;
}

export function assertEventId(value, field = "eventId") {
  if (!validateEventId(value)) {
    fail("INVALID_EVENT_ID", field, `${field} must match EVT:<taskId>:<sequenceNumber>`);
  }
  return value;
}

export function assertOperationHistoryId(value, field = "historyId") {
  if (!validateOperationHistoryId(value)) {
    fail("INVALID_OPERATION_HISTORY_ID", field, `${field} must match OPH:<taskId>:<operationId>`);
  }
  return value;
}

export function assertFingerprint(value, field = "fingerprint") {
  if (!validateFingerprint(value)) {
    fail("INVALID_FINGERPRINT", field, `${field} must be a 64-character lowercase hex digest`);
  }
  return value;
}

/**
 * Canonical finding identity key (WD-10 / WP04-04 §4.2).
 *
 * @param {string} ruleId D01..D10 rule id.
 * @param {string} code Registered finding subcode.
 * @param {string|{toHexString(): string}|{$oid: string}} orderId Order ObjectId.
 * @param {string|object|null} [itemId] Item ObjectId, or explicit null.
 * @param {string|number|object|null} [lineId] Mixed line id, or explicit null.
 * @returns {string} `REC:v1:<32-hex-digest>`
 */
export function buildFindingIdentityKey(ruleId, code, orderId, itemId = null, lineId = null) {
  const payload = {
    code: String(code),
    itemId: normalizeIdentityIdentifier(itemId, "objectId", "itemId"),
    lineId: normalizeIdentityIdentifier(lineId, "line", "lineId"),
    orderId: normalizeIdentityIdentifier(orderId, "objectId", "orderId"),
    rule: String(ruleId),
    schema: TASK_IDENTITY_SCHEMA_VERSION,
  };

  const canonicalString = canonicalize(payload);
  const digest = createHash("sha256").update(canonicalString, "utf8").digest("hex");
  return `${TASK_ID_PREFIX}${digest.slice(0, 32)}`;
}

/**
 * Grouping key for all findings on an order: `GRP:<orderId>`.
 */
export function buildTaskKey(orderId) {
  return `${TASK_KEY_PREFIX}${objectIdHex(orderId, "orderId")}`;
}

/**
 * Deterministic event identity: `EVT:<taskId>:<sequenceNumber>`.
 */
export function buildEventId(taskId, sequenceNumber) {
  assertTaskId(taskId, "taskId");

  let sequence;
  if (typeof sequenceNumber === "bigint") {
    sequence = sequenceNumber;
  } else if (typeof sequenceNumber === "number" && Number.isSafeInteger(sequenceNumber)) {
    sequence = BigInt(sequenceNumber);
  } else if (typeof sequenceNumber === "string" && /^[0-9]+$/.test(sequenceNumber)) {
    sequence = BigInt(sequenceNumber);
  } else {
    fail("INVALID_SEQUENCE_NUMBER", "sequenceNumber", "sequenceNumber must be an integer");
  }

  if (sequence < MIN_SEQUENCE_NUMBER || sequence > MAX_SEQUENCE_NUMBER) {
    fail(
      "SEQUENCE_OUT_OF_RANGE",
      "sequenceNumber",
      `sequenceNumber must be between ${MIN_SEQUENCE_NUMBER} and ${MAX_SEQUENCE_NUMBER}`,
    );
  }

  return `${EVENT_ID_PREFIX}${taskId}:${sequence.toString()}`;
}

/**
 * Deterministic H1 operation-history identity:
 * `OPH:<taskId>:<operationId>`.
 *
 * The operationId format is intentionally not defined here; callers must use
 * the identity minted once per logical reservation by the future writer.
 */
export function buildOperationHistoryId(taskId, operationId) {
  assertTaskId(taskId, "taskId");
  if (typeof operationId !== "string" || operationId.length === 0) {
    fail("INVALID_OPERATION_ID", "operationId", "operationId must be a non-empty string");
  }
  return `${OPERATION_HISTORY_ID_PREFIX}${taskId}:${operationId}`;
}
