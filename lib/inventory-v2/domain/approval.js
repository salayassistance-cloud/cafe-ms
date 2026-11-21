// BONO Inventory V2 — pure approval snapshot validation and evidence binding.
//
// This module validates SUPPLIED snapshots only. It does not verify PINs,
// manage challenges, persist approvals, or touch a database. Challenge replay
// prevention itself is a Phase 3/service concern; the 60-second maximum TTL is
// enforced here so an approval snapshot can never outlive its challenge.
//
// Trust model
// -----------
// A plain object such as { valid: true } is NOT approval evidence. Evidence is
// only produced by validateApprovalSnapshot(), which:
//   * binds order, station, allocation IDs, exact quantities, revision,
//     requirement fingerprint, shortage fingerprint, policy version, actor,
//     high-value evaluation, and expiry;
//   * requires a trusted server-computed high-value evaluation;
//   * returns a frozen evidence object registered in a module-private WeakSet.
//
// assertApprovalEvidence() re-checks WeakSet membership and every binding before
// a state transition or consumption may proceed. Evidence cannot be forged by
// supplying a boolean, a role string, or a self-declared high-value flag.
//
// High-value status is NEVER read from the snapshot. It must be the result of
// evaluateHighValue({ orderId, orderTotalAmount, thresholdAmount, policyVersion,
// evaluatedAt }) using the server's order total, configured threshold, policy,
// and evaluation time. Missing threshold/evaluation/order/policy fails closed.
//
// Manager-action evidence (top-up and recovery) uses the same model. Issuance
// requires a trusted server-side `verifyManager` port; a request-body Manager
// snapshot cannot become evidence by shape alone (F-07/F-12).

import {
  ERROR_CODES,
  fail,
} from "./errors.js";
import {
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertPositiveScaledQuantity,
  assertScaledQuantity,
  scaledQuantitiesEqual,
  scaledToNumber,
  compareScaledQuantities,
} from "./quantity.js";
import { CANONICAL_STATIONS } from "./states.js";

export const APPROVAL_CHALLENGE_TTL_MS = 60_000;
export const HIGH_VALUE_EVALUATION_TTL_MS = 60_000;
export const APPROVAL_STAGES = Object.freeze([1, 2]);
export const APPROVAL_EVIDENCE_VERSION = "approval-evidence-v1";
export const HIGH_VALUE_EVALUATION_VERSION = "high-value-eval-v1";
export const MANAGER_ACTION_AUTHORIZATION_VERSION =
  "manager-action-authorization-v1";

export const MANAGER_ACTION_TYPES = Object.freeze({
  TOP_UP: "TOP_UP",
  RECOVERY_RESOLUTION: "RECOVERY_RESOLUTION",
});

const VALIDATED_APPROVALS = new WeakSet();
const TRUSTED_HIGH_VALUE_EVALUATIONS = new WeakSet();
const VALIDATED_MANAGER_ACTIONS = new WeakSet();

function incomplete(message, details) {
  fail(ERROR_CODES.APPROVAL_INCOMPLETE, message, details);
}

function assertNonEmptyString(
  value,
  field,
  code = ERROR_CODES.APPROVAL_INCOMPLETE
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    fail(code, `${field} must be a non-empty trimmed string`, {
      field,
      value,
    });
  }
  return value;
}

function assertFingerprint(value, field) {
  return assertNonEmptyString(value, field);
}

// P1-02: actor identity is mandatory and must be a well-formed, delimiter-free
// identity. `null` never matches an expected actor.
function assertActorIdentity(
  value,
  field,
  code = ERROR_CODES.APPROVAL_REQUIRED
) {
  const actor = assertNonEmptyString(value, field, code);
  if (typeof actor.isWellFormed === "function" && !actor.isWellFormed()) {
    fail(code, `${field} is not well-formed Unicode`, { field, value });
  }
  if (/[|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(actor)) {
    fail(code, `${field} contains an unsafe character`, { field, value });
  }
  return actor;
}

// P1-01: bind approval evidence to the exact trusted high-value evaluation.
// Revalidation recomputes the evaluation from live order amount + configured
// threshold and compares every semantic field, including the classification.
function highValueEvaluationBinding(evaluation) {
  return Object.freeze({
    evaluationVersion: evaluation.evaluationVersion,
    orderId: evaluation.orderId,
    policyVersion: evaluation.policyVersion,
    actionActorId: evaluation.actionActorId,
    isHighValue: evaluation.isHighValue,
    orderTotalScaled: evaluation.orderTotalScaled.toString(),
    thresholdScaled: evaluation.thresholdScaled.toString(),
    evaluatedAt: evaluation.evaluatedAt,
  });
}

function assertHighValueEvaluationBinding(stored, live) {
  if (!stored || typeof stored !== "object") {
    fail(
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
      "Approval evidence is not bound to a trusted high-value evaluation"
    );
  }
  for (const field of [
    "evaluationVersion",
    "orderId",
    "policyVersion",
    "actionActorId",
    "isHighValue",
    "orderTotalScaled",
    "thresholdScaled",
    "evaluatedAt",
  ]) {
    if (stored[field] !== live[field]) {
      const code =
        field === "thresholdScaled"
          ? ERROR_CODES.HIGH_VALUE_THRESHOLD_UNCONFIGURED
          : ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED;
      fail(
        code,
        "Approval evidence was created under a different high-value evaluation",
        {
          field,
          stored: stored[field],
          live: live[field],
        }
      );
    }
  }
  return true;
}

function assertStation(value) {
  if (typeof value !== "string" || !CANONICAL_STATIONS.includes(value)) {
    fail(ERROR_CODES.APPROVAL_STATION_MISMATCH, "Approval station is invalid", {
      station: value,
      allowed: CANONICAL_STATIONS,
    });
  }
  return value;
}

function normalizeRevision(value, field = "revision") {
  if (typeof value === "number") {
    return String(assertNonNegativeInteger(value, field));
  }
  if (typeof value === "string" && value.length > 0 && value.trim() === value) {
    return value;
  }
  incomplete(`${field} must be a non-negative integer or non-empty string`, {
    field,
    value,
  });
}

function normalizePolicyVersion(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0 && value.trim() === value) {
    return value;
  }
  incomplete("policyVersion is required", { policyVersion: value });
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
  incomplete(`${field} must be a valid timestamp`, { field, value });
}

function normalizeAllocationIds(value, field = "allocationIds") {
  if (!Array.isArray(value) || value.length === 0) {
    fail(
      ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH,
      `${field} must be a non-empty array of allocation IDs`,
      { field, value }
    );
  }
  const ids = [];
  const seen = new Set();
  for (const item of value) {
    const id = assertNonEmptyString(item, `${field}[]`);
    if (seen.has(id)) {
      fail(
        ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH,
        "Duplicate allocation ID in approval snapshot",
        { allocationId: id }
      );
    }
    seen.add(id);
    ids.push(id);
  }
  return ids.sort();
}

function normalizeQuantities(input, allocationIds, field) {
  let pairs = [];
  if (Array.isArray(input)) {
    pairs = input.map((entry) => {
      if (!entry || typeof entry !== "object") {
        incomplete(`${field} entries must be objects`);
      }
      return [entry.allocationId, entry.quantity];
    });
  } else if (input && typeof input === "object") {
    pairs = Object.entries(input);
  } else {
    incomplete(`${field} is required`);
  }

  const numeric = Object.create(null);
  const exact = Object.create(null);
  for (const [rawId, rawQuantity] of pairs) {
    const id = assertNonEmptyString(rawId, `${field} key`);
    if (numeric[id] !== undefined) {
      fail(
        ERROR_CODES.APPROVAL_QUANTITY_MISMATCH,
        "Duplicate allocation quantity",
        { allocationId: id }
      );
    }
    const scaled = assertScaledQuantity(rawQuantity, `quantity:${id}`);
    numeric[id] = scaledToNumber(scaled);
    exact[id] = scaled;
  }

  const expectedIds = new Set(allocationIds);
  const actualIds = Object.keys(numeric);
  if (
    actualIds.length !== expectedIds.size ||
    actualIds.some((id) => !expectedIds.has(id))
  ) {
    fail(
      ERROR_CODES.APPROVAL_QUANTITY_MISMATCH,
      "Approval quantities must cover exactly the approved allocation IDs",
      {
        allocationIds,
        quantityAllocationIds: actualIds,
      }
    );
  }

  const orderedNumeric = Object.create(null);
  const orderedExact = Object.create(null);
  for (const id of allocationIds) {
    orderedNumeric[id] = numeric[id];
    orderedExact[id] = exact[id];
  }
  return Object.freeze({
    numeric: Object.freeze(orderedNumeric),
    exact: Object.freeze(orderedExact),
  });
}

function normalizeApprovalEntry(entry, expectedStage, field) {
  if (!entry || typeof entry !== "object") {
    fail(ERROR_CODES.APPROVAL_STAGE_INVALID, `${field} is required`, {
      field,
    });
  }
  if (entry.stage !== expectedStage) {
    fail(
      ERROR_CODES.APPROVAL_STAGE_INVALID,
      `${field} must have stage ${expectedStage}`,
      { field, stage: entry.stage, expectedStage }
    );
  }
  return Object.freeze({
    stage: expectedStage,
    managerId: assertActorIdentity(entry.managerId, `${field}.managerId`),
    approvedAt:
      entry.approvedAt === undefined || entry.approvedAt === null
        ? null
        : toEpochMs(entry.approvedAt, `${field}.approvedAt`),
  });
}

/**
 * Trusted server-side high-value evaluation. NO threshold is invented here: an
 * unset/invalid threshold fails closed. Amounts are compared as exact scaled
 * integers, not binary floating-point values. The evaluation is bound to the
 * order, policy version, actor, and evaluation time (F-08).
 */
export function evaluateHighValue({
  orderTotalAmount,
  thresholdAmount,
  orderId,
  policyVersion,
  actionActorId,
  evaluatedAt,
} = {}) {
  const safeOrderId = assertNonEmptyString(orderId, "orderId");
  const safePolicyVersion = normalizePolicyVersion(policyVersion);
  const safeEvaluatedAt =
    evaluatedAt === undefined ? Date.now() : toEpochMs(evaluatedAt, "evaluatedAt");
  // P1-02: a high-value evaluation always requires an explicit actor.
  const safeActor = assertActorIdentity(actionActorId, "actionActorId");

  if (
    typeof thresholdAmount !== "number" &&
    typeof thresholdAmount !== "string"
  ) {
    fail(
      ERROR_CODES.HIGH_VALUE_THRESHOLD_UNCONFIGURED,
      "High-value threshold is not configured; approval must fail closed",
      { thresholdAmount }
    );
  }

  let thresholdScaled;
  try {
    thresholdScaled = assertScaledQuantity(
      thresholdAmount,
      "thresholdAmount"
    );
  } catch (error) {
    fail(
      ERROR_CODES.HIGH_VALUE_THRESHOLD_UNCONFIGURED,
      "High-value threshold is not configured; approval must fail closed",
      { thresholdAmount, cause: error.code }
    );
  }
  if (thresholdScaled === 0n) {
    fail(
      ERROR_CODES.HIGH_VALUE_THRESHOLD_UNCONFIGURED,
      "High-value threshold must be positive",
      { thresholdAmount }
    );
  }

  const orderTotalScaled = assertScaledQuantity(
    orderTotalAmount,
    "orderTotalAmount"
  );

  const evaluation = Object.freeze({
    evaluationVersion: HIGH_VALUE_EVALUATION_VERSION,
    isHighValue:
      compareScaledQuantities(orderTotalScaled, thresholdScaled) >= 0,
    orderId: safeOrderId,
    policyVersion: safePolicyVersion,
    actionActorId: safeActor,
    evaluatedAt: safeEvaluatedAt,
    thresholdAmount: scaledToNumber(thresholdScaled),
    orderTotalAmount: scaledToNumber(orderTotalScaled),
    thresholdScaled,
    orderTotalScaled,
  });
  TRUSTED_HIGH_VALUE_EVALUATIONS.add(evaluation);
  return evaluation;
}

/**
 * Verify that an evaluation came from evaluateHighValue() and, when `expected`
 * is supplied, that every binding still matches the live server state.
 */
export function assertTrustedHighValueEvaluation(evaluation, expected = {}) {
  if (
    !evaluation ||
    typeof evaluation !== "object" ||
    !TRUSTED_HIGH_VALUE_EVALUATIONS.has(evaluation)
  ) {
    fail(
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
      "A trusted server-computed high-value evaluation is required (fail closed)",
      { evaluation }
    );
  }
  if (evaluation.evaluationVersion !== HIGH_VALUE_EVALUATION_VERSION) {
    fail(
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
      "High-value evaluation version is not trusted",
      { evaluationVersion: evaluation.evaluationVersion }
    );
  }
  if (typeof evaluation.isHighValue !== "boolean") {
    fail(
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
      "High-value evaluation is malformed",
      { evaluation }
    );
  }
  // P1-02: the evaluation actor is mandatory and can never be null.
  assertActorIdentity(
    evaluation.actionActorId,
    "evaluation.actionActorId",
    ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
  );

  if (expected && typeof expected === "object" && expected.orderId !== undefined) {
    const orderId = assertNonEmptyString(expected.orderId, "expected.orderId");
    if (evaluation.orderId !== orderId) {
      fail(
        ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
        "High-value evaluation belongs to another order",
        { orderId: evaluation.orderId, expectedOrderId: orderId }
      );
    }

    const policyVersion = normalizePolicyVersion(expected.policyVersion);
    if (evaluation.policyVersion !== policyVersion) {
      fail(
        ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
        "High-value evaluation was computed under another policy version",
        { policyVersion: evaluation.policyVersion, expectedPolicyVersion: policyVersion }
      );
    }

    const orderTotal = assertScaledQuantity(
      expected.orderTotalAmount,
      "expected.orderTotalAmount"
    );
    if (evaluation.orderTotalScaled !== orderTotal) {
      fail(
        ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
        "High-value evaluation was computed for another order amount",
        {
          orderTotalAmount: evaluation.orderTotalScaled.toString(),
          expectedOrderTotalAmount: orderTotal.toString(),
        }
      );
    }

    const threshold = assertScaledQuantity(
      expected.thresholdAmount,
      "expected.thresholdAmount"
    );
    if (threshold === 0n || evaluation.thresholdScaled !== threshold) {
      fail(
        ERROR_CODES.HIGH_VALUE_THRESHOLD_UNCONFIGURED,
        "High-value threshold changed or is invalid",
        {
          thresholdAmount: evaluation.thresholdScaled.toString(),
          expectedThresholdAmount: threshold.toString(),
        }
      );
    }

    const recomputed = compareScaledQuantities(orderTotal, threshold) >= 0;
    if (evaluation.isHighValue !== recomputed) {
      fail(
        ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
        "High-value evaluation contradicts the current order amount and threshold",
        { isHighValue: evaluation.isHighValue, expectedIsHighValue: recomputed }
      );
    }

    if (expected.actionActorId !== undefined) {
      const actorId = assertActorIdentity(
        expected.actionActorId,
        "expected.actionActorId"
      );
      // P1-02: null/undefined/empty/mismatched actors never match.
      if (evaluation.actionActorId !== actorId) {
        fail(
          ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
          "High-value evaluation belongs to another acting user",
          { actionActorId: evaluation.actionActorId, expectedActorId: actorId }
        );
      }
    }

    const now =
      expected.now === undefined ? Date.now() : toEpochMs(expected.now, "now");
    if (evaluation.evaluatedAt > now) {
      fail(
        ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
        "High-value evaluation is not yet valid",
        { evaluatedAt: evaluation.evaluatedAt, now }
      );
    }
    if (now - evaluation.evaluatedAt > HIGH_VALUE_EVALUATION_TTL_MS) {
      fail(
        ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
        "High-value evaluation is stale",
        { evaluatedAt: evaluation.evaluatedAt, now }
      );
    }
  }

  return evaluation;
}

/**
 * Validate an approval snapshot against the exact expected allocation
 * identity, revision, fingerprints, expiry, actor, and trusted high-value
 * evaluation.
 *
 * @param {object} snapshot supplied approval
 * @param {object} expected current server-side expectation
 * @returns {Readonly<object>} validated evidence
 */
export function validateApprovalSnapshot(snapshot, expected = {}) {
  if (!snapshot || typeof snapshot !== "object") {
    incomplete("Approval snapshot is required");
  }
  if (!expected || typeof expected !== "object") {
    incomplete("Expected approval binding is required");
  }
  // P1-01: a caller-supplied high-value boolean is never trusted. High-value
  // status must come from evaluateHighValue().
  if (
    snapshot.isHighValue !== undefined ||
    expected.isHighValue !== undefined
  ) {
    fail(
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
      "Caller-supplied isHighValue is not trusted; use a trusted high-value evaluation"
    );
  }

  const actionActorId = assertActorIdentity(
    snapshot.actionActorId,
    "actionActorId"
  );
  const currentActorId = assertActorIdentity(
    expected.currentActorId,
    "expected.currentActorId"
  );
  if (actionActorId !== currentActorId) {
    fail(
      ERROR_CODES.APPROVAL_REQUIRED,
      "Approval snapshot is bound to another acting user",
      { actionActorId, currentActorId }
    );
  }

  const orderId = assertNonEmptyString(snapshot.orderId, "orderId");
  const expectedOrderId = assertNonEmptyString(
    expected.orderId,
    "expected.orderId"
  );
  if (orderId !== expectedOrderId) {
    fail(ERROR_CODES.APPROVAL_ORDER_MISMATCH, "Approval belongs to another order", {
      orderId,
      expectedOrderId,
    });
  }

  const station = assertStation(snapshot.station);
  const expectedStation = assertStation(expected.station);
  if (station !== expectedStation) {
    fail(
      ERROR_CODES.APPROVAL_STATION_MISMATCH,
      "Approval belongs to another station",
      { station, expectedStation }
    );
  }

  const allocationIds = normalizeAllocationIds(snapshot.allocationIds);
  const expectedAllocationIds = normalizeAllocationIds(
    expected.allocationIds,
    "expected.allocationIds"
  );
  if (
    allocationIds.length !== expectedAllocationIds.length ||
    allocationIds.some((id, index) => id !== expectedAllocationIds[index])
  ) {
    fail(
      ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH,
      "Approval does not cover exactly the expected allocation IDs",
      { allocationIds, expectedAllocationIds }
    );
  }

  const quantities = normalizeQuantities(
    snapshot.allocationQuantities ?? snapshot.quantities,
    allocationIds,
    "allocationQuantities"
  );
  const expectedQuantities = normalizeQuantities(
    expected.allocationQuantities ?? expected.quantities,
    expectedAllocationIds,
    "expected.allocationQuantities"
  );
  for (const id of allocationIds) {
    if (
      !scaledQuantitiesEqual(
        quantities.exact[id],
        expectedQuantities.exact[id]
      )
    ) {
      fail(
        ERROR_CODES.APPROVAL_QUANTITY_MISMATCH,
        "Approved quantity does not match the current requirement",
        {
          allocationId: id,
          quantity: quantities.numeric[id],
          expectedQuantity: expectedQuantities.numeric[id],
        }
      );
    }
  }

  const revision = normalizeRevision(snapshot.revision);
  const expectedRevision = normalizeRevision(
    expected.revision,
    "expected.revision"
  );
  if (revision !== expectedRevision) {
    fail(
      ERROR_CODES.APPROVAL_REVISION_MISMATCH,
      "Approval revision is stale",
      { revision, expectedRevision }
    );
  }

  const requirementFingerprint = assertFingerprint(
    snapshot.requirementFingerprint,
    "requirementFingerprint"
  );
  const expectedRequirementFingerprint = assertFingerprint(
    expected.requirementFingerprint,
    "expected.requirementFingerprint"
  );
  if (requirementFingerprint !== expectedRequirementFingerprint) {
    fail(
      ERROR_CODES.APPROVAL_REQUIREMENT_MISMATCH,
      "Requirement fingerprint changed",
      { requirementFingerprint, expectedRequirementFingerprint }
    );
  }

  const shortageFingerprint = assertFingerprint(
    snapshot.shortageFingerprint,
    "shortageFingerprint"
  );
  const expectedShortageFingerprint = assertFingerprint(
    expected.shortageFingerprint,
    "expected.shortageFingerprint"
  );
  if (shortageFingerprint !== expectedShortageFingerprint) {
    fail(ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH, "Shortage fingerprint changed", {
      shortageFingerprint,
      expectedShortageFingerprint,
    });
  }

  const policyVersion = normalizePolicyVersion(snapshot.policyVersion);
  const expectedPolicyVersion = normalizePolicyVersion(
    expected.policyVersion
  );
  if (policyVersion !== expectedPolicyVersion) {
    fail(
      ERROR_CODES.APPROVAL_POLICY_VERSION_MISMATCH,
      "Approval policy version changed",
      { policyVersion, expectedPolicyVersion }
    );
  }

  // F-04: the approved shortage is mandatory and strictly positive. It is
  // stored exactly so accounting can be re-bound at consumption time.
  const shortageQuantity = assertPositiveScaledQuantity(
    expected.shortageQuantity,
    "expected.shortageQuantity"
  );

  const issuedAt = toEpochMs(snapshot.issuedAt, "issuedAt");
  const expiresAt = toEpochMs(snapshot.expiresAt, "expiresAt");
  const now =
    expected.now === undefined ? Date.now() : toEpochMs(expected.now, "now");

  if (expiresAt <= issuedAt) {
    incomplete("expiresAt must be after issuedAt", { issuedAt, expiresAt });
  }
  if (expiresAt - issuedAt > APPROVAL_CHALLENGE_TTL_MS) {
    fail(
      ERROR_CODES.APPROVAL_TTL_EXCEEDED,
      "Approval challenge TTL exceeds 60 seconds",
      { issuedAt, expiresAt, maxTtlMs: APPROVAL_CHALLENGE_TTL_MS }
    );
  }
  if (now >= expiresAt) {
    fail(ERROR_CODES.APPROVAL_EXPIRED, "Approval snapshot has expired", {
      now,
      expiresAt,
    });
  }
  if (now < issuedAt) {
    fail(
      ERROR_CODES.APPROVAL_NOT_YET_VALID,
      "Approval snapshot is not valid yet",
      { now, issuedAt }
    );
  }

  const highValueEvaluation = assertTrustedHighValueEvaluation(
    expected.highValueEvaluation ?? expected.highValue,
    {
      orderId: expectedOrderId,
      policyVersion: expectedPolicyVersion,
      orderTotalAmount: expected.orderTotalAmount,
      thresholdAmount: expected.thresholdAmount,
      actionActorId,
      now,
    }
  );

  const firstApproval = normalizeApprovalEntry(
    snapshot.firstApproval,
    1,
    "firstApproval"
  );
  const secondApproval =
    snapshot.secondApproval === undefined || snapshot.secondApproval === null
      ? null
      : normalizeApprovalEntry(snapshot.secondApproval, 2, "secondApproval");

  if (firstApproval.managerId === actionActorId) {
    fail(
      ERROR_CODES.SELF_APPROVAL_FORBIDDEN,
      "The action actor cannot approve their own request"
    );
  }
  if (secondApproval && secondApproval.managerId === actionActorId) {
    fail(
      ERROR_CODES.SELF_APPROVAL_FORBIDDEN,
      "The action actor cannot provide the second approval"
    );
  }
  if (
    secondApproval &&
    secondApproval.managerId === firstApproval.managerId
  ) {
    fail(
      ERROR_CODES.APPROVAL_MANAGER_DUPLICATE,
      "High-value approval requires two distinct Managers"
    );
  }

  const isHighValue = highValueEvaluation.isHighValue;
  if (isHighValue && !secondApproval) {
    fail(
      ERROR_CODES.SECOND_MANAGER_REQUIRED,
      "High-value approval requires a second distinct Manager"
    );
  }

  const managerIds = [firstApproval.managerId];
  if (secondApproval) managerIds.push(secondApproval.managerId);

  const highValueBinding = highValueEvaluationBinding(highValueEvaluation);

  const evidence = Object.freeze({
    evidenceVersion: APPROVAL_EVIDENCE_VERSION,
    valid: true,
    orderId,
    station,
    allocationIds: Object.freeze([...allocationIds]),
    allocationQuantities: quantities.numeric,
    allocationQuantitiesExact: quantities.exact,
    revision,
    requirementFingerprint,
    shortageFingerprint,
    shortageQuantity: scaledToNumber(shortageQuantity),
    shortageQuantityExact: shortageQuantity,
    policyVersion,
    issuedAt,
    expiresAt,
    actionActorId,
    firstApproval,
    secondApproval,
    isHighValue,
    highValueEvaluation,
    highValueBinding,
    requiredApprovals: isHighValue ? 2 : 1,
    managerIds: Object.freeze(managerIds),
  });
  VALIDATED_APPROVALS.add(evidence);
  return evidence;
}

/**
 * Re-check previously validated evidence against the current server-side
 * expectation. Booleans, role strings, copies, stale actors, and stale
 * high-value evaluations fail.
 */
export function assertApprovalEvidence(evidence, expected = {}) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    !VALIDATED_APPROVALS.has(evidence) ||
    evidence.evidenceVersion !== APPROVAL_EVIDENCE_VERSION ||
    evidence.valid !== true
  ) {
    fail(
      ERROR_CODES.APPROVAL_REQUIRED,
      "Validated approval evidence is required (a boolean or copied object is not evidence)",
      { hasEvidence: Boolean(evidence) }
    );
  }
  if (!expected || typeof expected !== "object") {
    fail(
      ERROR_CODES.APPROVAL_REQUIRED,
      "Approval evidence must be checked against a server-side expectation"
    );
  }
  // P1-01: never accept a caller-supplied high-value boolean.
  if (expected.isHighValue !== undefined) {
    fail(
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
      "Caller-supplied isHighValue is not trusted; use a trusted high-value evaluation"
    );
  }

  // F-05: the actor is part of the evidence binding and must match the actor
  // executing the protected action.
  const currentActorId = assertActorIdentity(
    expected.currentActorId,
    "expected.currentActorId"
  );
  if (evidence.actionActorId !== currentActorId) {
    fail(
      ERROR_CODES.APPROVAL_REQUIRED,
      "Approval evidence is bound to another acting user",
      { actionActorId: evidence.actionActorId, currentActorId }
    );
  }

  // F-08 / P1-01: revalidate the high-value evaluation against the live order
  // amount, threshold, policy, actor, and time, then compare the evidence
  // binding. An approval created under a different value classification (for
  // example low-value then escalated high-value) is rejected.
  const liveHighValueEvaluation = assertTrustedHighValueEvaluation(
    expected.highValueEvaluation ?? expected.highValue,
    {
      orderId: expected.orderId,
      policyVersion: expected.policyVersion,
      orderTotalAmount: expected.orderTotalAmount,
      thresholdAmount: expected.thresholdAmount,
      actionActorId: currentActorId,
      now: expected.now,
    }
  );
  const liveHighValueBinding = highValueEvaluationBinding(
    liveHighValueEvaluation
  );
  if (evidence.isHighValue !== liveHighValueEvaluation.isHighValue) {
    fail(
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
      "Approval evidence high-value classification no longer matches the live evaluation"
    );
  }

  // P1-01: revalidate the Manager entries and require a second distinct Manager
  // whenever the live evaluation is high-value.
  const evidenceFirstApproval = normalizeApprovalEntry(
    evidence.firstApproval,
    1,
    "evidence.firstApproval"
  );
  const evidenceSecondApproval =
    evidence.secondApproval === undefined || evidence.secondApproval === null
      ? null
      : normalizeApprovalEntry(
          evidence.secondApproval,
          2,
          "evidence.secondApproval"
        );
  if (evidenceFirstApproval.managerId === currentActorId) {
    fail(
      ERROR_CODES.SELF_APPROVAL_FORBIDDEN,
      "The action actor cannot approve their own request"
    );
  }
  if (
    evidenceSecondApproval &&
    evidenceSecondApproval.managerId === currentActorId
  ) {
    fail(
      ERROR_CODES.SELF_APPROVAL_FORBIDDEN,
      "The action actor cannot provide the second approval"
    );
  }
  if (
    evidenceSecondApproval &&
    evidenceSecondApproval.managerId === evidenceFirstApproval.managerId
  ) {
    fail(
      ERROR_CODES.APPROVAL_MANAGER_DUPLICATE,
      "High-value approval requires two distinct Managers"
    );
  }
  const liveIsHighValue = liveHighValueEvaluation.isHighValue;
  if (liveIsHighValue && !evidenceSecondApproval) {
    fail(
      ERROR_CODES.SECOND_MANAGER_REQUIRED,
      "High-value approval requires a second distinct Manager"
    );
  }
  if (evidence.requiredApprovals !== (liveIsHighValue ? 2 : 1)) {
    fail(
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED,
      "Approval evidence has the wrong number of required approvals"
    );
  }

  if (evidence.orderId !== expected.orderId) {
    fail(ERROR_CODES.APPROVAL_ORDER_MISMATCH, "Approval belongs to another order", {
      orderId: evidence.orderId,
      expectedOrderId: expected.orderId,
    });
  }
  // P1-01: after the order binding is confirmed, verify that the stored
  // high-value evaluation matches the live one in every semantic field.
  assertHighValueEvaluationBinding(
    evidence.highValueBinding,
    liveHighValueBinding
  );
  if (evidence.station !== expected.station) {
    fail(
      ERROR_CODES.APPROVAL_STATION_MISMATCH,
      "Approval belongs to another station",
      { station: evidence.station, expectedStation: expected.station }
    );
  }

  const expectedAllocationIds = normalizeAllocationIds(
    expected.allocationIds,
    "expected.allocationIds"
  );
  if (
    evidence.allocationIds.length !== expectedAllocationIds.length ||
    evidence.allocationIds.some(
      (id, index) => id !== expectedAllocationIds[index]
    )
  ) {
    fail(
      ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH,
      "Approval no longer covers the expected allocation IDs",
      {
        allocationIds: evidence.allocationIds,
        expectedAllocationIds,
      }
    );
  }

  const expectedQuantities = normalizeQuantities(
    expected.allocationQuantities ?? expected.quantities,
    expectedAllocationIds,
    "expected.allocationQuantities"
  );
  for (const id of expectedAllocationIds) {
    if (
      !scaledQuantitiesEqual(
        evidence.allocationQuantitiesExact[id],
        expectedQuantities.exact[id]
      )
    ) {
      fail(
        ERROR_CODES.APPROVAL_QUANTITY_MISMATCH,
        "Approved quantity no longer matches the current requirement",
        {
          allocationId: id,
          quantity: evidence.allocationQuantities[id],
          expectedQuantity: expectedQuantities.numeric[id],
        }
      );
    }
  }

  if (
    evidence.revision !== normalizeRevision(expected.revision, "expected.revision")
  ) {
    fail(ERROR_CODES.APPROVAL_REVISION_MISMATCH, "Approval revision is stale");
  }
  if (evidence.requirementFingerprint !== expected.requirementFingerprint) {
    fail(
      ERROR_CODES.APPROVAL_REQUIREMENT_MISMATCH,
      "Requirement fingerprint changed"
    );
  }
  if (evidence.shortageFingerprint !== expected.shortageFingerprint) {
    fail(ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH, "Shortage fingerprint changed");
  }
  if (
    evidence.policyVersion !== normalizePolicyVersion(expected.policyVersion)
  ) {
    fail(
      ERROR_CODES.APPROVAL_POLICY_VERSION_MISMATCH,
      "Approval policy version changed"
    );
  }

  // F-04: the shortage is mandatory, positive, and exactly bound to evidence.
  const expectedShortage = assertPositiveScaledQuantity(
    expected.shortageQuantity,
    "expected.shortageQuantity"
  );
  if (
    !scaledQuantitiesEqual(evidence.shortageQuantityExact, expectedShortage)
  ) {
    fail(
      ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH,
      "Approved shortage changed or is missing",
      {
        approvedShortage: evidence.shortageQuantityExact.toString(),
        expectedShortage: expectedShortage.toString(),
      }
    );
  }

  const now =
    expected.now === undefined ? Date.now() : toEpochMs(expected.now, "now");
  if (now >= evidence.expiresAt) {
    fail(ERROR_CODES.APPROVAL_EXPIRED, "Approval evidence has expired", {
      now,
      expiresAt: evidence.expiresAt,
    });
  }
  if (now < evidence.issuedAt) {
    fail(ERROR_CODES.APPROVAL_NOT_YET_VALID, "Approval evidence is not valid yet", {
      now,
      issuedAt: evidence.issuedAt,
    });
  }

  if (expected.allocationId !== undefined) {
    const allocationId = assertNonEmptyString(
      expected.allocationId,
      "expected.allocationId"
    );
    if (!evidence.allocationIds.includes(allocationId)) {
      fail(
        ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH,
        "Approval evidence does not cover the required allocation",
        { allocationId, allocationIds: evidence.allocationIds }
      );
    }
    if (expected.requiredQuantity !== undefined) {
      const required = assertScaledQuantity(
        expected.requiredQuantity,
        "expected.requiredQuantity"
      );
      if (
        !scaledQuantitiesEqual(
          evidence.allocationQuantitiesExact[allocationId],
          required
        )
      ) {
        fail(
          ERROR_CODES.APPROVAL_QUANTITY_MISMATCH,
          "Approved quantity does not match the allocation requirement",
          {
            allocationId,
            approvedQuantity:
              evidence.allocationQuantitiesExact[allocationId].toString(),
            requiredQuantity: required.toString(),
          }
        );
      }
    }
  }

  return evidence;
}

export function isValidatedApprovalEvidence(evidence) {
  return Boolean(
    evidence &&
      typeof evidence === "object" &&
      VALIDATED_APPROVALS.has(evidence) &&
      evidence.evidenceVersion === APPROVAL_EVIDENCE_VERSION
  );
}

// ---------------------------------------------------------------------------
// Manager-action authorization (top-up / recovery) — F-12
// ---------------------------------------------------------------------------

function normalizeAction(value) {
  const action = String(value || "").toUpperCase();
  if (
    action !== MANAGER_ACTION_TYPES.TOP_UP &&
    action !== MANAGER_ACTION_TYPES.RECOVERY_RESOLUTION
  ) {
    fail(ERROR_CODES.INVALID_INPUT, "Unknown manager action", { action: value });
  }
  return action;
}

/**
 * Issue manager-action evidence from a SERVER-VERIFIED claim.
 *
 * `options.verifyManager(claim)` must confirm the manager identity through the
 * trusted service boundary (authenticated session / PIN verification / DB
 * lookup). It must not be a request-body echo. Without a verifier, this function
 * fails closed; a caller-supplied Manager snapshot alone is never evidence.
 */
export function issueManagerActionAuthorization(
  claim,
  expected = {},
  options = {}
) {
  if (!claim || typeof claim !== "object") {
    fail(
      ERROR_CODES.APPROVAL_REQUIRED,
      "Manager action claim is required"
    );
  }
  if (typeof options.verifyManager !== "function") {
    fail(
      ERROR_CODES.APPROVAL_REQUIRED,
      "A trusted server-side manager verifier is required; a request-body claim is not authorization"
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
      ERROR_CODES.APPROVAL_REQUIRED,
      "Manager identity could not be verified; authorization fails closed"
    );
  }

  const managerId = assertActorIdentity(claim.managerId, "managerId");
  if (claim.role !== "MANAGER") {
    fail(
      ERROR_CODES.APPROVAL_REQUIRED,
      "Manager role is required for this action",
      { managerId, role: claim.role }
    );
  }
  const authorizationId = assertNonEmptyString(
    claim.authorizationId,
    "authorizationId"
  );
  const action = normalizeAction(claim.action);
  if (expected.action !== undefined && normalizeAction(expected.action) !== action) {
    fail(ERROR_CODES.INVALID_INPUT, "Manager authorization action mismatch", {
      action,
      expectedAction: expected.action,
    });
  }

  const orderId = assertNonEmptyString(claim.orderId, "orderId");
  const expectedOrderId = assertNonEmptyString(
    expected.orderId,
    "expected.orderId"
  );
  if (orderId !== expectedOrderId) {
    fail(ERROR_CODES.APPROVAL_ORDER_MISMATCH, "Authorization belongs to another order", {
      orderId,
      expectedOrderId,
    });
  }

  const station = assertStation(claim.station);
  if (station !== expected.station) {
    fail(
      ERROR_CODES.APPROVAL_STATION_MISMATCH,
      "Authorization belongs to another station",
      { station, expectedStation: expected.station }
    );
  }

  const allocationId = assertNonEmptyString(
    claim.allocationId,
    "allocationId"
  );
  const expectedAllocationId = assertNonEmptyString(
    expected.allocationId,
    "expected.allocationId"
  );
  if (allocationId !== expectedAllocationId) {
    fail(
      ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH,
      "Authorization belongs to another allocation",
      { allocationId, expectedAllocationId }
    );
  }

  const epoch = assertPositiveInteger(claim.epoch, "epoch");
  if (epoch !== assertPositiveInteger(expected.epoch, "expected.epoch")) {
    fail(ERROR_CODES.INVALID_EPOCH, "Authorization epoch is stale", {
      epoch,
      expectedEpoch: expected.epoch,
    });
  }

  const actorId = assertActorIdentity(claim.actorId, "actorId");
  const currentActorId = assertActorIdentity(
    expected.currentActorId,
    "expected.currentActorId"
  );
  if (actorId !== currentActorId) {
    fail(
      ERROR_CODES.APPROVAL_REQUIRED,
      "Authorization is bound to another acting user",
      { actorId, currentActorId }
    );
  }

  const revision = normalizeRevision(claim.revision);
  if (
    revision !==
    normalizeRevision(expected.revision, "expected.revision")
  ) {
    fail(ERROR_CODES.APPROVAL_REVISION_MISMATCH, "Authorization revision is stale", {
      revision,
      expectedRevision: expected.revision,
    });
  }

  let targetState = null;
  if (action === MANAGER_ACTION_TYPES.RECOVERY_RESOLUTION) {
    targetState = String(claim.targetState || "").toUpperCase();
    if (targetState.length === 0) {
      fail(ERROR_CODES.INVALID_RECOVERY_TARGET, "Recovery target is required");
    }
    if (
      expected.targetState !== undefined &&
      String(expected.targetState).toUpperCase() !== targetState
    ) {
      fail(ERROR_CODES.INVALID_RECOVERY_TARGET, "Recovery target mismatch", {
        targetState,
        expectedTargetState: expected.targetState,
      });
    }
  } else if (claim.targetState !== undefined) {
    fail(
      ERROR_CODES.INVALID_INPUT,
      "TOP_UP authorization must not carry a recovery target"
    );
  }

  const issuedAt = toEpochMs(claim.issuedAt, "issuedAt");
  const expiresAt = toEpochMs(claim.expiresAt, "expiresAt");
  const now =
    expected.now === undefined ? Date.now() : toEpochMs(expected.now, "now");
  if (expiresAt <= issuedAt) {
    fail(ERROR_CODES.APPROVAL_INCOMPLETE, "expiresAt must be after issuedAt");
  }
  if (expiresAt - issuedAt > APPROVAL_CHALLENGE_TTL_MS) {
    fail(ERROR_CODES.APPROVAL_TTL_EXCEEDED, "Manager authorization TTL exceeded");
  }
  if (now >= expiresAt) {
    fail(ERROR_CODES.APPROVAL_EXPIRED, "Manager authorization has expired");
  }
  if (now < issuedAt) {
    fail(ERROR_CODES.APPROVAL_NOT_YET_VALID, "Manager authorization is not valid yet");
  }

  const evidence = Object.freeze({
    evidenceVersion: MANAGER_ACTION_AUTHORIZATION_VERSION,
    valid: true,
    managerId,
    role: "MANAGER",
    authorizationId,
    action,
    orderId,
    station,
    allocationId,
    epoch,
    actorId,
    revision,
    targetState,
    issuedAt,
    expiresAt,
  });
  VALIDATED_MANAGER_ACTIONS.add(evidence);
  return evidence;
}

/**
 * Re-check manager-action evidence against the live operation binding.
 */
export function assertManagerActionAuthorization(evidence, expected = {}) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    !VALIDATED_MANAGER_ACTIONS.has(evidence) ||
    evidence.evidenceVersion !== MANAGER_ACTION_AUTHORIZATION_VERSION ||
    evidence.valid !== true
  ) {
    fail(
      ERROR_CODES.APPROVAL_REQUIRED,
      "Validated Manager-action evidence is required"
    );
  }

  const action = normalizeAction(expected.action);
  if (evidence.action !== action) {
    fail(ERROR_CODES.APPROVAL_REQUIRED, "Manager authorization is for another action", {
      action: evidence.action,
      expectedAction: action,
    });
  }

  for (const [field, value] of [
    ["orderId", expected.orderId],
    ["station", expected.station],
    ["allocationId", expected.allocationId],
    ["actorId", expected.currentActorId],
  ]) {
    const normalized =
      field === "station"
        ? assertStation(value)
        : assertNonEmptyString(value, `expected.${field}`);
    if (evidence[field] !== normalized) {
      fail(
        ERROR_CODES.APPROVAL_REQUIRED,
        `Manager authorization ${field} mismatch`,
        { field, supplied: evidence[field], expected: normalized }
      );
    }
  }

  if (evidence.epoch !== assertPositiveInteger(expected.epoch, "expected.epoch")) {
    fail(ERROR_CODES.INVALID_EPOCH, "Manager authorization epoch is stale");
  }

  if (
    evidence.revision !==
    normalizeRevision(expected.revision, "expected.revision")
  ) {
    fail(ERROR_CODES.APPROVAL_REVISION_MISMATCH, "Manager authorization revision is stale");
  }

  if (action === MANAGER_ACTION_TYPES.RECOVERY_RESOLUTION) {
    const targetState = String(expected.targetState || "").toUpperCase();
    if (targetState.length === 0) {
      fail(ERROR_CODES.INVALID_RECOVERY_TARGET, "Recovery target is required");
    }
    if (evidence.targetState !== targetState) {
      fail(ERROR_CODES.INVALID_RECOVERY_TARGET, "Recovery target mismatch", {
        targetState: evidence.targetState,
        expectedTargetState: targetState,
      });
    }
  } else if (evidence.targetState !== null) {
    fail(
      ERROR_CODES.INVALID_INPUT,
      "TOP_UP authorization must not carry a recovery target"
    );
  }

  const now =
    expected.now === undefined ? Date.now() : toEpochMs(expected.now, "now");
  if (now >= evidence.expiresAt) {
    fail(ERROR_CODES.APPROVAL_EXPIRED, "Manager authorization has expired");
  }
  if (now < evidence.issuedAt) {
    fail(ERROR_CODES.APPROVAL_NOT_YET_VALID, "Manager authorization is not valid yet");
  }

  return evidence;
}
