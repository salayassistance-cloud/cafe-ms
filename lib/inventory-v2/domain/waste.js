// BONO Inventory V2 — waste accounting and signed correction validation.
//
//   sold = C - W
//   waste = W
//
// W is NET ORDER-LINKED waste (including PREPARED_UNSOLD). Direct waste is a
// separate reporting bucket and is NEVER subtracted from allocation consumed
// quantity. Signed corrections only move W; they never change Q/H/C/R/S and
// never touch physical stock or movement history.
//
// Authorization
// -------------
// A caller-supplied role string (managerRole: "MANAGER") or Manager snapshot is
// NOT authorization. Every correction requires evidence issued by
// issueWasteManagerAuthorization(), which:
//   * requires a trusted server-side `verifyManager` port (authenticated
//     session / PIN verification / DB lookup) — a request-body claim alone can
//     never become evidence (F-07);
//   * binds managerId, authorizationId, action, correctionId, expiry, and an
//     optional correction fingerprint;
//   * registers the frozen evidence in a module-private WeakSet.
//
// assertWasteAuthorizationEvidence() re-checks membership, binding, and expiry.
// Raw snapshots are rejected outright by validateWasteCorrection().
//
// Idempotency (F-06 / P1-04)
// --------------------------
// applyWasteCorrection() keeps a process-local ledger keyed by
// `${allocationId}|${correctionId}`. Replaying the exact same payload +
// authorization + allocation state returns the original result without
// mutating waste. Reusing the identity with a different delta, reason,
// authorization, actor, or allocation state fails closed with
// WASTE_CORRECTION_CONFLICT.
//
// This ledger is NOT durable and NOT cross-process. Phase 2 MUST enforce the
// same contract atomically in the service layer: a unique index on
// { allocationId, correctionId } or an equivalent conditional insert, followed
// by fingerprint comparison on duplicate-key. Never treat this Map as the
// production idempotency store.
//
// This module is pure: no persistence, no audit writes, no stock mutation.

import crypto from "node:crypto";

import {
  assertNoAccountingChange,
  accountingExact,
  validateAllocationAccounting,
} from "./accounting.js";
import {
  ERROR_CODES,
  fail,
} from "./errors.js";
import {
  assertSignedScaledQuantity,
  scaledToNumber,
} from "./quantity.js";

export const WASTE_AUTHORIZATION_VERSION = "waste-manager-authorization-v1";
export const WASTE_AUTHORIZATION_TTL_MS = 5 * 60_000;

const VALIDATED_WASTE_AUTHORIZATIONS = new WeakSet();
const WASTE_CORRECTION_LEDGER = new Map();
const SAFE_CORRECTION_ID = /^[^|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
const SAFE_REASON = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;

function assertCorrectionId(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    !SAFE_CORRECTION_ID.test(value)
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_ID_REQUIRED,
      "A valid correction identity is required",
      { correctionId: value }
    );
  }
  return value;
}

function assertReason(value) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim() !== value ||
    !SAFE_REASON.test(value)
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_REASON_REQUIRED,
      "A non-empty correction reason is required",
      { reason: value }
    );
  }
  return value;
}

function assertNonEmptyString(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      `${field} must be a non-empty trimmed string`,
      { field, value }
    );
  }
  return value;
}

function normalizeAllocationRevision(value, field = "allocationRevision") {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(
        ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
        `${field} must be a non-negative safe integer or non-empty string`,
        { field, value }
      );
    }
    return String(value);
  }
  if (typeof value === "string" && value.length > 0 && value.trim() === value) {
    return value;
  }
  fail(
    ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
    `${field} is required and must be a non-negative integer or non-empty string`,
    { field, value }
  );
}

function toEpochMs(value, field) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  fail(
    ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
    `${field} must be a valid timestamp`,
    { field, value }
  );
}

/**
 * Issue Manager-authorization evidence from a SERVER-VERIFIED claim.
 *
 * `options.verifyManager(claim)` must confirm the manager identity through the
 * trusted service boundary. It must not echo the request body. Without a
 * verifier this fails closed.
 */
export function issueWasteManagerAuthorization(
  claim,
  expected = {},
  options = {}
) {
  if (!claim || typeof claim !== "object") {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Validated Manager authorization evidence is required",
      { claim }
    );
  }
  if (typeof options.verifyManager !== "function") {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "A trusted server-side manager verifier is required; a request-body snapshot is not authorization"
    );
  }
  let verified = false;
  try {
    verified = options.verifyManager(claim);
  } catch {
    verified = false;
  }
  if (verified !== true) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager identity could not be verified; authorization fails closed"
    );
  }

  const managerId = assertNonEmptyString(claim.managerId, "managerId");
  if (claim.role !== "MANAGER") {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "A caller-supplied role string is not authorization; role must be MANAGER",
      { managerId, role: claim.role }
    );
  }
  const authorizationId = assertNonEmptyString(
    claim.authorizationId,
    "authorizationId"
  );
  if (claim.action !== "WASTE_CORRECTION") {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization was not issued for a waste correction",
      { managerId, action: claim.action }
    );
  }
  const correctionId = assertCorrectionId(claim.correctionId);
  if (
    expected.correctionId !== undefined &&
    correctionId !== expected.correctionId
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization is bound to another correction",
      { correctionId, expectedCorrectionId: expected.correctionId }
    );
  }
  if (claim.approved !== true) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization evidence must be affirmatively approved",
      { managerId, approved: claim.approved }
    );
  }

  // P1-05: the authorization fingerprint is mandatory. It binds the exact
  // allocation identity, correction identity, signed delta, reason, accounting
  // state, and revision. A missing/malformed fingerprint fails closed.
  if (
    typeof claim.correctionFingerprint !== "string" ||
    claim.correctionFingerprint.length === 0 ||
    claim.correctionFingerprint.trim() !== claim.correctionFingerprint
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_FINGERPRINT_REQUIRED,
      "A valid waste correction authorization fingerprint is required",
      { correctionFingerprint: claim.correctionFingerprint }
    );
  }
  const correctionFingerprint = claim.correctionFingerprint;
  if (
    expected.correctionFingerprint !== undefined &&
    correctionFingerprint !== expected.correctionFingerprint
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization is bound to another correction payload",
      {
        correctionFingerprint,
        expectedCorrectionFingerprint: expected.correctionFingerprint,
      }
    );
  }

  const allocationId = assertNonEmptyString(claim.allocationId, "allocationId");
  if (
    expected.allocationId !== undefined &&
    allocationId !== expected.allocationId
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization is bound to another allocation",
      { allocationId, expectedAllocationId: expected.allocationId }
    );
  }
  const allocationRevision = normalizeAllocationRevision(
    claim.allocationRevision,
    "allocationRevision"
  );
  if (
    expected.allocationRevision !== undefined &&
    allocationRevision !==
      normalizeAllocationRevision(
        expected.allocationRevision,
        "expected.allocationRevision"
      )
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization is bound to another allocation revision",
      {
        allocationRevision,
        expectedAllocationRevision: expected.allocationRevision,
      }
    );
  }

  const issuedAt = toEpochMs(claim.issuedAt, "issuedAt");
  const expiresAt = toEpochMs(claim.expiresAt, "expiresAt");
  const now =
    expected.now === undefined ? Date.now() : toEpochMs(expected.now, "now");

  if (expiresAt <= issuedAt) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Authorization expiresAt must be after issuedAt",
      { issuedAt, expiresAt }
    );
  }
  if (expiresAt - issuedAt > WASTE_AUTHORIZATION_TTL_MS) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Authorization TTL exceeds the supported maximum",
      { issuedAt, expiresAt, maxTtlMs: WASTE_AUTHORIZATION_TTL_MS }
    );
  }
  if (now >= expiresAt) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization has expired",
      { now, expiresAt }
    );
  }
  if (now < issuedAt) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization is not valid yet",
      { now, issuedAt }
    );
  }

  const evidence = Object.freeze({
    evidenceVersion: WASTE_AUTHORIZATION_VERSION,
    valid: true,
    managerId,
    role: "MANAGER",
    authorizationId,
    action: "WASTE_CORRECTION",
    correctionId,
    correctionFingerprint,
    allocationId,
    allocationRevision,
    issuedAt,
    expiresAt,
  });
  VALIDATED_WASTE_AUTHORIZATIONS.add(evidence);
  return evidence;
}

export function assertWasteAuthorizationEvidence(evidence, expected = {}) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    !VALIDATED_WASTE_AUTHORIZATIONS.has(evidence) ||
    evidence.evidenceVersion !== WASTE_AUTHORIZATION_VERSION ||
    evidence.valid !== true
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Validated Manager authorization evidence is required",
      { hasEvidence: Boolean(evidence) }
    );
  }
  if (evidence.role !== "MANAGER" || evidence.action !== "WASTE_CORRECTION") {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization evidence is malformed"
    );
  }
  if (
    typeof evidence.correctionFingerprint !== "string" ||
    evidence.correctionFingerprint.length === 0
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_FINGERPRINT_REQUIRED,
      "Manager authorization evidence is missing its correction fingerprint"
    );
  }
  if (
    expected.correctionId !== undefined &&
    evidence.correctionId !== expected.correctionId
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization is bound to another correction",
      {
        correctionId: evidence.correctionId,
        expectedCorrectionId: expected.correctionId,
      }
    );
  }
  if (
    expected.allocationId !== undefined &&
    evidence.allocationId !== expected.allocationId
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization is bound to another allocation",
      {
        allocationId: evidence.allocationId,
        expectedAllocationId: expected.allocationId,
      }
    );
  }
  if (
    expected.allocationRevision !== undefined &&
    evidence.allocationRevision !==
      normalizeAllocationRevision(
        expected.allocationRevision,
        "expected.allocationRevision"
      )
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization is bound to another allocation revision",
      {
        allocationRevision: evidence.allocationRevision,
        expectedAllocationRevision: expected.allocationRevision,
      }
    );
  }
  const now =
    expected.now === undefined ? Date.now() : toEpochMs(expected.now, "now");
  if (now >= evidence.expiresAt) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization has expired",
      { now, expiresAt: evidence.expiresAt }
    );
  }
  if (now < evidence.issuedAt) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization is not valid yet",
      { now, issuedAt: evidence.issuedAt }
    );
  }
  return evidence;
}

/**
 * Pure waste reporting math. `orderLinkedWaste` is W; `directWaste` is a
 * separate bucket used by dual-read reporting.
 */
export function computeWasteAccounting({
  consumedQuantity,
  orderLinkedWaste,
  directWaste = 0,
} = {}) {
  const C = assertSignedScaledQuantity(consumedQuantity, "consumedQuantity");
  const W = assertSignedScaledQuantity(orderLinkedWaste, "orderLinkedWaste");
  const D = assertSignedScaledQuantity(directWaste, "directWaste");

  if (C < 0n || W < 0n || D < 0n) {
    fail(ERROR_CODES.NEGATIVE_QUANTITY, "Waste quantities must not be negative");
  }
  if (W > C) {
    fail(
      ERROR_CODES.WASTE_EXCEEDS_CONSUMPTION,
      "Order-linked waste cannot exceed consumed quantity",
      { consumedQuantity: C.toString(), orderLinkedWaste: W.toString() }
    );
  }

  return Object.freeze({
    consumedQuantity: scaledToNumber(C),
    orderLinkedWaste: scaledToNumber(W),
    directWaste: scaledToNumber(D),
    totalWaste: scaledToNumber(W + D),
    sold: scaledToNumber(C - W),
    waste: scaledToNumber(W),
  });
}

export function splitWaste({ orderLinkedWaste = 0, directWaste = 0 } = {}) {
  const W = assertSignedScaledQuantity(orderLinkedWaste, "orderLinkedWaste");
  const D = assertSignedScaledQuantity(directWaste, "directWaste");
  if (W < 0n || D < 0n) {
    fail(ERROR_CODES.NEGATIVE_QUANTITY, "Waste quantities must not be negative");
  }
  return Object.freeze({
    orderLinkedWaste: scaledToNumber(W),
    directWaste: scaledToNumber(D),
    totalWaste: scaledToNumber(W + D),
  });
}

// P1-05 / Phase 1.8: collision-free fingerprint.
//
// v2 joined fields with "|", so different values containing the delimiter
// could serialize identically (for example reason="c", authorizationId="d|e"
// versus reason="c|d", authorizationId="e"). v3 serializes an explicit,
// ordered, typed array with JSON and hashes the canonical UTF-8 bytes with
// SHA-256. JSON string escaping is injective for every supported string
// (including delimiters and Unicode), and the explicit version prefix keeps
// legacy v2 fingerprints from ever validating as v3.
const WASTE_CORRECTION_FINGERPRINT_VERSION = "waste-correction-v3";

function canonicalFingerprintPayload(fields) {
  return JSON.stringify([
    WASTE_CORRECTION_FINGERPRINT_VERSION,
    ["allocationId", fields.allocationId],
    ["correctionId", fields.correctionId],
    ["reason", fields.reason],
    ["authorizationId", fields.authorizationId],
    ["managerId", fields.managerId],
    ["allocationRevision", fields.allocationRevision],
    ["wasteDelta", fields.wasteDelta],
    ["requiredQuantity", fields.requiredQuantity],
    ["heldQuantity", fields.heldQuantity],
    ["consumedQuantity", fields.consumedQuantity],
    ["releasedHoldQuantity", fields.releasedHoldQuantity],
    ["voidedQuantity", fields.voidedQuantity],
    ["shortageQuantity", fields.shortageQuantity],
    ["wasteQuantity", fields.wasteQuantity],
  ]);
}

/**
 * Deterministic, collision-free fingerprint of the complete correction
 * payload. The service layer can persist this value and compare it atomically
 * on duplicate key. The returned string is versioned and SHA-256 hashed; it is
 * not a claim of durable cross-process idempotency (that is Phase 2).
 */
export function computeWasteCorrectionFingerprint({
  allocationId,
  correctionId,
  wasteDelta,
  reason,
  authorizationId,
  managerId,
  allocationRevision,
  accounting,
} = {}) {
  const exact = accountingExact(accounting);
  const delta = assertSignedScaledQuantity(wasteDelta, "wasteDelta");
  const payload = canonicalFingerprintPayload({
    allocationId: assertNonEmptyString(allocationId, "allocationId"),
    correctionId: assertCorrectionId(correctionId),
    reason: assertReason(reason),
    authorizationId: assertNonEmptyString(authorizationId, "authorizationId"),
    managerId: assertNonEmptyString(managerId, "managerId"),
    allocationRevision: normalizeAllocationRevision(allocationRevision),
    wasteDelta: delta.toString(),
    requiredQuantity: exact.requiredQuantity.toString(),
    heldQuantity: exact.heldQuantity.toString(),
    consumedQuantity: exact.consumedQuantity.toString(),
    releasedHoldQuantity: exact.releasedHoldQuantity.toString(),
    voidedQuantity: exact.voidedQuantity.toString(),
    shortageQuantity: exact.shortageQuantity.toString(),
    wasteQuantity: exact.wasteQuantity.toString(),
  });
  const digest = crypto
    .createHash("sha256")
    .update(payload, "utf8")
    .digest("hex");
  return `${WASTE_CORRECTION_FINGERPRINT_VERSION}:${digest}`;
}

function resolveAuthorization(
  managerAuthorization,
  correctionId,
  now,
  allocationId,
  allocationRevision
) {
  if (!managerAuthorization || typeof managerAuthorization !== "object") {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Every waste correction requires validated Manager authorization evidence",
      { correctionId }
    );
  }
  // F-07: a raw Manager snapshot is never evidence, even if it has every
  // expected field. It must have been issued at the trusted service boundary.
  if (managerAuthorization.evidenceVersion !== WASTE_AUTHORIZATION_VERSION) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Raw Manager snapshots are not authorization evidence; issue evidence at the trusted boundary"
    );
  }
  return assertWasteAuthorizationEvidence(managerAuthorization, {
    correctionId,
    allocationId,
    allocationRevision,
    now,
  });
}

/**
 * Validate a signed waste correction against an allocation.
 *
 * Required:
 *   - allocation accounting (C and W are read, never modified)
 *   - correctionId (idempotency identity)
 *   - reason (non-empty)
 *   - managerAuthorization (issued evidence bound to correctionId)
 *   - wasteDelta (finite signed exact delta)
 *
 * Invariant: 0 <= W + wasteDelta <= C.
 */
export function validateWasteCorrection({
  allocation,
  allocationId,
  wasteDelta,
  correctionId,
  reason,
  managerAuthorization,
  allocationRevision,
  now,
} = {}) {
  const accounting = accountingExact(allocation);
  const safeAllocationId = assertNonEmptyString(allocationId, "allocationId");
  const id = assertCorrectionId(correctionId);
  const safeReason = assertReason(reason);
  const safeAllocationRevision = normalizeAllocationRevision(
    allocationRevision
  );
  const authorization = resolveAuthorization(
    managerAuthorization,
    id,
    now,
    safeAllocationId,
    safeAllocationRevision
  );

  const delta = assertSignedScaledQuantity(wasteDelta, "wasteDelta");
  if (delta === 0n) {
    fail(
      ERROR_CODES.INVALID_WASTE_DELTA,
      "Waste correction delta must be non-zero",
      { wasteDelta: 0 }
    );
  }

  const previousWaste = accounting.wasteQuantity;
  const newWaste = previousWaste + delta;

  if (newWaste < 0n || newWaste > accounting.consumedQuantity) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_OUT_OF_RANGE,
      "Waste correction must preserve 0 <= W <= C",
      {
        consumedQuantity: accounting.consumedQuantity.toString(),
        previousWasteQuantity: previousWaste.toString(),
        wasteDelta: delta.toString(),
        newWasteQuantity: newWaste.toString(),
      }
    );
  }

  const fingerprint = computeWasteCorrectionFingerprint({
    allocationId: safeAllocationId,
    correctionId: id,
    wasteDelta: delta,
    reason: safeReason,
    authorizationId: authorization.authorizationId,
    managerId: authorization.managerId,
    allocationRevision: safeAllocationRevision,
    accounting: allocation,
  });
  // P1-05 / Phase 1.8: legacy v2 fingerprints are ambiguous and are never
  // silently treated as v3. Reissue the authorization with a v3 fingerprint.
  if (
    typeof authorization.correctionFingerprint === "string" &&
    authorization.correctionFingerprint.startsWith("waste-correction-v2|")
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Legacy waste-correction-v2 fingerprints are not accepted; reissue authorization",
      { correctionFingerprint: authorization.correctionFingerprint }
    );
  }
  // P1-05: the fingerprint is mandatory and must match exactly. A missing or
  // mismatched fingerprint can never authorize the correction.
  if (
    typeof authorization.correctionFingerprint !== "string" ||
    authorization.correctionFingerprint.length === 0 ||
    authorization.correctionFingerprint !== fingerprint
  ) {
    fail(
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED,
      "Manager authorization was issued for a different correction payload",
      {
        correctionFingerprint: authorization.correctionFingerprint,
        actualFingerprint: fingerprint,
      }
    );
  }

  const correction = {
    allocationId: safeAllocationId,
    allocationRevision: safeAllocationRevision,
    correctionId: id,
    managerId: authorization.managerId,
    managerRole: "MANAGER",
    authorizationId: authorization.authorizationId,
    reason: safeReason,
    correctionFingerprint: fingerprint,
    consumedQuantity: scaledToNumber(accounting.consumedQuantity),
    previousWasteQuantity: scaledToNumber(previousWaste),
    wasteDelta: scaledToNumber(delta),
    newWasteQuantity: scaledToNumber(newWaste),
    soldQuantity: scaledToNumber(accounting.consumedQuantity - newWaste),
  };
  Object.defineProperty(correction, "exact", {
    value: Object.freeze({
      consumedQuantity: accounting.consumedQuantity,
      previousWasteQuantity: previousWaste,
      wasteDelta: delta,
      newWasteQuantity: newWaste,
      soldQuantity: accounting.consumedQuantity - newWaste,
    }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(correction);
}

/**
 * Pure application of a validated correction. Returns a new accounting value
 * with ONLY wasteQuantity changed, proving that Q/H/C/R/S are untouched.
 *
 * Idempotency is scoped to correctionId. The process-local ledger is a
 * best-effort guard only; Phase 2 must enforce durable atomic uniqueness at the
 * service layer (see the module header).
 */
export function applyWasteCorrection(allocation, correctionInput = {}) {
  const correction = validateWasteCorrection({
    ...correctionInput,
    allocation,
  });

  // P1-04: process-local best-effort only. Phase 2 MUST replace this with a
  // durable unique key { allocationId, correctionId } committed atomically with
  // the allocation update and the stored payload fingerprint.
  const ledgerKey = `${correction.allocationId}|${correction.correctionId}`;
  const existing = WASTE_CORRECTION_LEDGER.get(ledgerKey);
  if (existing) {
    if (
      existing.correction.correctionFingerprint !==
      correction.correctionFingerprint
    ) {
      fail(
        ERROR_CODES.WASTE_CORRECTION_CONFLICT,
        "Waste correction identity was reused with a different payload or authorization",
        {
          allocationId: correction.allocationId,
          correctionId: correction.correctionId,
          previousFingerprint: existing.correction.correctionFingerprint,
          attemptedFingerprint: correction.correctionFingerprint,
        }
      );
    }
    return Object.freeze({ ...existing, idempotentReplay: true });
  }

  const before = accountingExact(allocation);
  const afterExact = {
    ...before,
    wasteQuantity: correction.exact.newWasteQuantity,
  };

  assertNoAccountingChange(allocation, { exact: afterExact });

  const applied = Object.freeze({
    accounting: validateAllocationAccounting({ exact: afterExact }),
    correction,
    idempotentReplay: false,
  });
  WASTE_CORRECTION_LEDGER.set(ledgerKey, applied);
  return applied;
}
