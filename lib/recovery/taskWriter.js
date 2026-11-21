// WP04-06 — Canonical recovery-task writer (OD-34) for the O2/H1 protocol.
//
// Contract sources:
//   * docs/production-readiness/wp-04-06-design-consolidation-and-register.md
//     §2, §3, §4 (OD-24/25/26/27/27-SC/28/30/31/32/33/34/37, T9, I-C)
//   * docs/production-readiness/wp-04-06-design-discovery-report.md §12, §13,
//     §15, §16, §22.3, §22.4, §22.6
//
// This module is the only code allowed to mutate `inventory_recovery_tasks`,
// insert `inventory_recovery_events`, or insert
// `inventory_recovery_operation_history` (OD-34 / §12.3). It does not open a
// connection, deploy indexes, run migrations, start a worker, or read
// environment variables; the caller supplies a live Mongoose connection.
//
// Binding protocol properties implemented here:
//   * OD-30  — the task-document CAS is the fence. The H1 history row is
//              append-only audit evidence and is never the uniqueness fence.
//   * OD-24  — O2 `pendingOperation` reservation plus H1 history written in the
//              same transaction as `T_effect` / `T_abandon`.
//   * OD-25  — one active operation per task across lease generations: a
//              non-terminal `pendingOperation` blocks reservation and claims.
//   * OD-26  — positive, representation-local unresolved-outcome predicate.
//   * OD-27/OD-27-SC — hold by default; same-identity replay only after a
//              writer-observed definitive abort; `UNKNOWN_COMMIT` stays
//              observed-only and the operation remains `PREPARED`.
//   * OD-28  — permanent sequence gaps, no reuse, fail-closed ceiling.
//   * OD-37  — exact original lease identity, server-time expiry,
//              operation-bound authorization, `ABANDONABLE_STATUSES = {LEASED}`,
//              atomic task/event/history transition, and the audit wording
//              `OPERATOR_DECISION_AFTER_HOLD` (never `ABORT_CONFIRMED`).
//   * T9     — `U_claim` on every claim/reclaim path and an atomic
//              `leaseGeneration` CAS with an explicit abort on zero match.
//   * I-C    — W2/W5 claim lifecycle and W6 `T_reserve` are separate
//              transactions, each consuming exactly one sequence; `T_reserve`
//              emits no event; W7 inserts at the reserved sequence without
//              incrementing the counter.
//
// Every required conditional write is checked for a zero match and aborts by
// throwing before any event insert, commit, or success result (§13.1, §13.2).

import { randomUUID } from "node:crypto";

import {
  ABANDONABLE_STATUSES,
  APPROVAL_ROLES,
  ESCALATION_CODES,
  OPERATION_SETTLEMENT_BASES,
  TERMINAL_OP_STATES,
  getRecoveryOperationHistoryModel,
  getRecoveryTaskModel,
} from "../models/RecoveryTask.js";
import { DIAGNOSTIC_CODES, getRecoveryEventModel } from "../models/RecoveryEvent.js";
import {
  MAX_SEQUENCE_NUMBER,
  assertFingerprint,
  assertTaskId,
  buildEventId,
  buildOperationHistoryId,
} from "./identity.js";
// WP04-03 owns `./reconciliation.js` (V1 read-only scanner). The WP04-06
// H1/operation-evidence auditor lives at `./operationReconciliation.js`; the
// writer takes the shared non-proof/abort vocabulary from there so the write
// path and the audit path cannot drift.
import { DEFINITIVE_ABORT_EVIDENCE, NON_PROOF_OUTCOMES } from "./operationReconciliation.js";

export const SEQUENCE_CEILING = MAX_SEQUENCE_NUMBER;

export const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: "majority" },
  writeConcern: { w: "majority" },
});

// OD-34 / §12.3: the complete write allowlist. Anything not in this table is
// rejected before a session is opened.
export const WRITER_ENTRY_POINTS = Object.freeze([
  Object.freeze({ id: "W1", methods: Object.freeze(["createTaskFromFinding"]) }),
  Object.freeze({ id: "W2", methods: Object.freeze(["claimLease"]) }),
  Object.freeze({ id: "W3", methods: Object.freeze(["renewLease"]) }),
  Object.freeze({ id: "W4", methods: Object.freeze(["releaseLease"]) }),
  Object.freeze({ id: "W5", methods: Object.freeze(["applyTransition"]) }),
  Object.freeze({ id: "W6", methods: Object.freeze(["reserveOperation"]) }),
  Object.freeze({ id: "W7", methods: Object.freeze(["commitOperation"]) }),
  Object.freeze({ id: "W8", methods: Object.freeze(["abandonOperation"]) }),
  Object.freeze({ id: "W9", methods: Object.freeze(["resolveTask", "closeTask"]) }),
  Object.freeze({ id: "W10", methods: Object.freeze(["cancelTask"]) }),
  Object.freeze({ id: "W11", methods: Object.freeze(["recordApproval", "recordRejection"]) }),
  Object.freeze({ id: "W12", methods: Object.freeze(["escalateTask"]) }),
  Object.freeze({ id: "W13", methods: Object.freeze(["archiveClosedTasks"]) }),
  Object.freeze({ id: "W14", methods: Object.freeze(["repairTask"]) }),
]);

export const WRITER_ALLOWLIST = Object.freeze(
  WRITER_ENTRY_POINTS.flatMap((entry) => entry.methods),
);

// Deferred by open owner decisions, not by preference. These entry points are
// declared (so the allowlist is complete) and refuse to run.
export const DEFERRED_ENTRY_POINTS = Object.freeze({
  archiveClosedTasks:
    "W13 is a retention/archive job. OD-04 retention is OPEN and no delete or archive path is authorized.",
  repairTask:
    "W14 requires explicit corrective-write authorization. Read-only until that authorization exists.",
});

export const WRITER_ERROR_CODES = Object.freeze([
  "CAS_MISMATCH",
  "SEQUENCE_OVERFLOW",
  "DUPLICATE_EVENT",
  "DUPLICATE_TASK",
  "DUPLICATE_HISTORY",
  "UNRESOLVED_OUTCOME",
  "TASK_NOT_FOUND",
  "OPERATION_MISMATCH",
  "AUTHORIZATION_MISMATCH",
  "ABANDONMENT_NOT_PERMITTED",
  "LEASE_NOT_EXPIRED",
  "TRANSITION_NOT_ALLOWED",
  "ENTRY_POINT_NOT_ALLOWED",
  "ENTRY_POINT_NOT_IMPLEMENTED",
  "REPLAY_NOT_AUTHORIZED",
  "APPROVAL_REQUIRED",
  "INVALID_ARGUMENT",
]);

export class RecoveryWriterError extends Error {
  /**
   * @param {string} code Stable writer error code.
   * @param {string} message Safe message with no evidence payload.
   * @param {Record<string, unknown>} [details] Non-sensitive diagnostic fields.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RecoveryWriterError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new RecoveryWriterError(code, message, details);
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// §16.1 / OD-27-SC: the non-proof and definitive-abort vocabularies are owned
// by the read-only WP04-06 reconciliation module and re-exported here. They are
// deliberately single-sourced: the writer must not grow a divergent copy.
export { APPROVAL_ROLES, DEFINITIVE_ABORT_EVIDENCE, NON_PROOF_OUTCOMES };

// There is deliberately no global "writable task fields" universe: each
// transition carries its own strict allowlist (TRANSITION_FIELD_ALLOWLISTS /
// EFFECT_TRANSITIONS). Identity, lease, counter, operation, closure,
// cancellation, approval and verification fields are writer-controlled.

// Approved lifecycle rows (§3.3 / §13.4). Operation rows are W6/W7/W8 and are
// intentionally not part of this table.
export const LIFECYCLE_TRANSITIONS = Object.freeze([
  Object.freeze({
    id: "T-RENEW",
    from: "LEASED",
    to: "LEASED",
    eventType: "RECOVERY_RENEWED",
    requiresLease: true,
  }),
  Object.freeze({
    id: "T-RETRY",
    from: "LEASED",
    to: "RETRY_SCHEDULED",
    eventType: "RECOVERY_RETRY_SCHEDULED",
    requiresLease: true,
  }),
  Object.freeze({
    id: "T-EXHAUST",
    from: "LEASED",
    to: "MANUAL_REQUIRED",
    eventType: "RECOVERY_ESCALATED",
    requiresLease: true,
    requiresAttemptsExhausted: true,
  }),
  Object.freeze({
    id: "T-APPROVE",
    from: "MANUAL_REQUIRED",
    to: "MANUAL_REQUIRED",
    eventType: "RECOVERY_APPROVED",
    requiresApprovalPending: true,
    requiresApprovalDistinct: true,
  }),
  Object.freeze({
    id: "T-REJECT",
    from: "MANUAL_REQUIRED",
    to: "MANUAL_REQUIRED",
    eventType: "RECOVERY_REJECTED",
    requiresApprovalPending: true,
    requiresApprovalDistinct: true,
  }),
  Object.freeze({
    id: "T-RECLAIM",
    from: "MANUAL_REQUIRED",
    to: "LEASED",
    eventType: "RECOVERY_LEASED",
    requiresApprovalApproved: true,
    claim: true,
  }),
  Object.freeze({
    id: "T-RESOLVE",
    from: "LEASED",
    to: "RESOLVED",
    eventType: "RECOVERY_RESOLVED",
    requiresLease: true,
  }),
  Object.freeze({
    id: "T-CLOSE",
    from: "RESOLVED",
    to: "CLOSED",
    eventType: "RECOVERY_VERIFIED",
    closes: true,
  }),
  Object.freeze({
    id: "T-CANCEL-DETECTED",
    from: "DETECTED",
    to: "CANCELLED",
    eventType: "RECOVERY_CANCELLED",
    closes: true,
  }),
  Object.freeze({
    id: "T-CANCEL-LEASED",
    from: "LEASED",
    to: "CANCELLED",
    eventType: "RECOVERY_CANCELLED",
    requiresLease: true,
    closes: true,
  }),
  Object.freeze({
    id: "T-CANCEL-MANUAL",
    from: "MANUAL_REQUIRED",
    to: "CANCELLED",
    eventType: "RECOVERY_CANCELLED",
    closes: true,
  }),
]);

export function getLifecycleTransition(transitionId) {
  return LIFECYCLE_TRANSITIONS.find((entry) => entry.id === transitionId) || null;
}

// -----------------------------------------------------------------------------
// W7 effect transitions (T5 only)
//
// The effect path must not accept a caller-chosen status/event pair. Only the
// approved T5 row (LEASED -> RESOLVED, RECOVERY_RESOLVED) is executable, and it
// carries a strict field allowlist. APPLIED remains disabled/read-only: until
// the owner authorizes it, the only representable T5 resolution is
// ALREADY_CORRECT (the effect is present exactly once).
// -----------------------------------------------------------------------------
export const EFFECT_TRANSITIONS = Object.freeze([
  Object.freeze({
    id: "T-EFFECT-RESOLVE",
    from: "LEASED",
    to: "RESOLVED",
    eventType: "RECOVERY_RESOLVED",
    requiredFields: Object.freeze(["resolution", "currentFingerprint"]),
    allowedFields: Object.freeze([
      "resolution",
      "currentFingerprint",
      "lastErrorCode",
      "lastErrorField",
    ]),
    allowedResolutions: Object.freeze(["ALREADY_CORRECT"]),
  }),
]);

/**
 * Resolve and validate an effect transition. Arbitrary from/to/event triples are
 * rejected before any session is opened.
 */
export function resolveEffectTransition({ fromStatus, toStatus, eventType } = {}) {
  if (typeof fromStatus !== "string" || typeof toStatus !== "string") {
    fail("INVALID_ARGUMENT", "fromStatus and toStatus are required", {
      field: "fromStatus/toStatus",
    });
  }
  const transition = EFFECT_TRANSITIONS.find(
    (entry) => entry.from === fromStatus && entry.to === toStatus,
  );
  if (!transition) {
    fail("TRANSITION_NOT_ALLOWED", "effect transition is not approved", {
      fromStatus,
      toStatus,
    });
  }
  if (eventType !== undefined && eventType !== transition.eventType) {
    fail("TRANSITION_NOT_ALLOWED", "event type is not approved for this effect transition", {
      eventType,
      expectedEventType: transition.eventType,
    });
  }
  return transition;
}

// -----------------------------------------------------------------------------
// W5 generic lifecycle transitions and per-row field allowlists
//
// W5 runs only the rows that have no dedicated wrapper: T6 retry, T7 exhaust and
// the T-APPROVE approval step. T5 resolution, T14 closure and T3/T8/T13
// cancellation have dedicated entry points (W9/W10) and are not reachable
// through W5. T4/T11/T15 are deferred and have no writer row at all. Privileged
// fields are rejected by omission from every allowlist.
// -----------------------------------------------------------------------------
export const W5_TRANSITION_IDS = Object.freeze(["T-RETRY", "T-EXHAUST", "T-APPROVE"]);

export const TRANSITION_FIELD_ALLOWLISTS = Object.freeze({
  "T-RENEW": Object.freeze([]),
  "T-RETRY": Object.freeze(["nextAttemptAt"]),
  "T-EXHAUST": Object.freeze(["manualReasonCode", "escalation"]),
  "T-APPROVE": Object.freeze(["approval", "approvedBy", "approvedAt"]),
  "T-REJECT": Object.freeze(["approval", "approvedBy", "approvedAt"]),
  "T-RESOLVE": Object.freeze([
    "resolution",
    "currentFingerprint",
    "lastErrorCode",
    "lastErrorField",
  ]),
  "T-CLOSE": Object.freeze([]),
  "T-CANCEL-DETECTED": Object.freeze([]),
  "T-CANCEL-LEASED": Object.freeze([]),
  "T-CANCEL-MANUAL": Object.freeze([]),
});

// W1 / OD-10 §2.4 clauses 2-3: a finding may create only immutable identity,
// classification and fingerprint metadata. Approval, execution, verification,
// closure, cancellation, resolution, lease, sequence and operation state are
// writer-owned and are rejected rather than silently accepted.
export const TASK_CREATION_FIELDS = Object.freeze([
  "taskId",
  "taskKey",
  "findingIdentityKey",
  "orderId",
  "orderNumber",
  "reservationId",
  "itemId",
  "lineId",
  "rule",
  "code",
  "classification",
  "severity",
  "confidence",
  "evidenceLevel",
  "findingCodeOnly",
  "durableClass",
  "fingerprintSchema",
  "evidenceSchema",
  "initialFingerprint",
  "currentFingerprint",
  "maxAttempts",
]);

export function isAllowlistedEntryPoint(entryPoint) {
  return WRITER_ALLOWLIST.includes(entryPoint);
}

function assertAllowlisted(entryPoint) {
  if (!isAllowlistedEntryPoint(entryPoint)) {
    fail("ENTRY_POINT_NOT_ALLOWED", `${entryPoint} is not an approved writer entry point`, {
      entryPoint,
    });
  }
  if (Object.prototype.hasOwnProperty.call(DEFERRED_ENTRY_POINTS, entryPoint)) {
    fail("ENTRY_POINT_NOT_IMPLEMENTED", DEFERRED_ENTRY_POINTS[entryPoint], { entryPoint });
  }
}

function toBigInt(value, field) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  return fail("INVALID_ARGUMENT", `${field} must be an integer`, { field });
}

function toDate(value, field) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  return fail("INVALID_ARGUMENT", `${field} must be a valid Date`, { field });
}

function isDuplicateKeyError(error) {
  return Boolean(
    error &&
      (error.code === 11000 ||
        error.code === 11001 ||
        (error.cause && error.cause.code === 11000)),
  );
}

// -----------------------------------------------------------------------------
// Predicate builders (exported so the source contract is testable verbatim)
// -----------------------------------------------------------------------------

/**
 * OD-26 / T9 — the positive unresolved-outcome predicate `U`.
 * A null/missing operation or a terminal state is the only acceptable state.
 */
export function buildUnresolvedOperationPredicate() {
  return {
    $or: [
      { pendingOperation: null },
      { "pendingOperation.state": { $in: [...TERMINAL_OP_STATES] } },
    ],
  };
}

/**
 * T9/Acquire — `U_claim`. Same positive predicate, named separately because the
 * claim contract is the one OD-37 relies on to prevent a generation bump from
 * zero-matching `T_abandon` forever.
 */
export function buildClaimUnresolvedPredicate() {
  return {
    $or: [
      { pendingOperation: null },
      { "pendingOperation.state": { $in: [...TERMINAL_OP_STATES] } },
    ],
  };
}

/**
 * `L(G, Tk, W, now)` — exact lease identity with a server-derived liveness
 * check (`$$NOW`), never a worker-local clock.
 */
export function buildLeasePredicate(lease) {
  if (!lease || typeof lease !== "object") {
    return fail("INVALID_ARGUMENT", "lease identity is required", { field: "lease" });
  }
  return {
    leaseGeneration: toBigInt(lease.leaseGeneration, "lease.leaseGeneration"),
    leaseToken: lease.leaseToken,
    leaseOwner: lease.leaseOwner,
    $expr: { $gt: ["$leaseUntil", "$$NOW"] },
  };
}

/**
 * OD-37 — the original lease must be expired by server time. The original lease
 * identity is the task document's top-level `leaseGeneration` / `leaseToken` /
 * `leaseOwner`: T9/Acquire `U_claim` prevents any claim while
 * `pendingOperation.state = PREPARED`, and no other writer mutates `leaseToken`,
 * so that identity remains the acquiring lease for the whole PREPARED lifetime.
 *
 * `pendingOperation` has no `leaseToken` in the signed OD-10 schema, so the
 * token is bound here against the task document rather than the reservation.
 * Expiry is always `$$NOW` (server time), never a worker-local clock.
 */
export function buildExpiredOriginalLeasePredicate(lease) {
  if (!lease || typeof lease !== "object") {
    return fail("INVALID_ARGUMENT", "lease identity is required", { field: "lease" });
  }
  return {
    leaseGeneration: toBigInt(lease.leaseGeneration, "lease.leaseGeneration"),
    leaseToken: lease.leaseToken,
    leaseOwner: lease.leaseOwner,
    $expr: { $lte: ["$leaseUntil", "$$NOW"] },
  };
}

/** Exact durable reservation identity (OD-25 / §22.3). */
export function buildPendingOperationPredicate(operation, { state = "PREPARED" } = {}) {
  return {
    "pendingOperation.operationId": operation.operationId,
    "pendingOperation.state": state,
    "pendingOperation.leaseGeneration": toBigInt(
      operation.leaseGeneration,
      "operation.leaseGeneration",
    ),
    "pendingOperation.sequenceNumber": toBigInt(
      operation.sequenceNumber,
      "operation.sequenceNumber",
    ),
    "pendingOperation.eventId": operation.eventId,
  };
}

/**
 * `S(C)` plus `N(max)`. Returns an array because a single JavaScript object
 * cannot carry two clauses for `eventSequenceCounter` (§22.3.3 note).
 */
export function buildSequencePredicate(expectedCounter) {
  return [
    { eventSequenceCounter: toBigInt(expectedCounter, "eventSequenceCounter") },
    { eventSequenceCounter: { $lt: SEQUENCE_CEILING } },
  ];
}

// -----------------------------------------------------------------------------
// Pure decisions
// -----------------------------------------------------------------------------

/** OD-28 — allocate exactly one sequence, or fail closed at the ceiling. */
export function nextSequenceNumber(counter) {
  const current = toBigInt(counter, "eventSequenceCounter");
  if (current >= SEQUENCE_CEILING) {
    fail("SEQUENCE_OVERFLOW", "eventSequenceCounter is at the fail-closed ceiling", {
      ceiling: SEQUENCE_CEILING.toString(),
    });
  }
  return current + 1n;
}

/**
 * Classify the durable operation state without inferring an abort from absence.
 * `PREPARED` includes an observed `UNKNOWN_COMMIT` (OD-31).
 */
export function assessOperationOutcome(task) {
  if (!task) {
    return { state: "NO_TASK", action: "HOLD", replayable: false, reason: "TASK_NOT_FOUND" };
  }
  const operation = task.pendingOperation;
  if (!operation) {
    return { state: "NO_OPERATION", action: "PROCEED", replayable: false, reason: "NONE" };
  }
  if (operation.state === "PREPARED") {
    return {
      state: "UNRESOLVED",
      action: "HOLD",
      replayable: false,
      operationId: operation.operationId,
      reason: "PREPARED_OPERATION_NOT_SETTLED",
    };
  }
  if (TERMINAL_OP_STATES.includes(operation.state)) {
    return {
      state: "TERMINAL",
      action: "PROCEED",
      replayable: false,
      operationId: operation.operationId,
      reason: operation.state,
    };
  }
  return {
    state: "UNRECOGNIZED",
    action: "HOLD",
    replayable: false,
    operationId: operation.operationId ?? null,
    reason: "UNKNOWN_OPERATION_STATE",
  };
}

/**
 * OD-27-SC — bounded same-identity replay is permitted only after a
 * writer-observed definitive abort of the same operation. `UNKNOWN_COMMIT` and
 * every §16.1 non-proof is rejected.
 */
export function assessReplayEligibility({ operation, evidence } = {}) {
  if (!operation) {
    return { replayable: false, reason: "NO_OPERATION" };
  }
  if (operation.state === "COMMITTED") {
    return { replayable: false, adoptable: true, reason: "ALREADY_COMMITTED" };
  }
  if (operation.state === "ABANDONED") {
    return { replayable: false, reason: "ALREADY_ABANDONED" };
  }
  if (operation.state !== "PREPARED") {
    return { replayable: false, reason: "UNKNOWN_OPERATION_STATE" };
  }

  const outcome = evidence?.outcome;
  if (!outcome) {
    return { replayable: false, reason: "NO_DEFINITIVE_ABORT_EVIDENCE" };
  }
  if (NON_PROOF_OUTCOMES.includes(outcome)) {
    return { replayable: false, reason: `NON_PROOF:${outcome}` };
  }
  if (!DEFINITIVE_ABORT_EVIDENCE.includes(outcome)) {
    return { replayable: false, reason: `UNRECOGNIZED_EVIDENCE:${outcome}` };
  }
  if (evidence.operationId !== operation.operationId) {
    return { replayable: false, reason: "EVIDENCE_OPERATION_MISMATCH" };
  }
  return { replayable: true, reason: "WRITER_OBSERVED_DEFINITIVE_ABORT" };
}

function assertNoUnresolvedOperation(task) {
  const outcome = assessOperationOutcome(task);
  if (outcome.state === "UNRESOLVED" || outcome.state === "UNRECOGNIZED") {
    fail("UNRESOLVED_OUTCOME", "a prior operation is not terminal; hold", {
      operationId: outcome.operationId ?? null,
      reason: outcome.reason,
    });
  }
}

function requireWorker(worker) {
  if (!worker || typeof worker !== "object") {
    return fail("INVALID_ARGUMENT", "worker identity is required", { field: "worker" });
  }
  if (typeof worker.id !== "string" || worker.id.length === 0 || worker.id.length > 128) {
    return fail("INVALID_ARGUMENT", "worker.id must be 1..128 characters", { field: "worker.id" });
  }
  if (typeof worker.token !== "string" || !UUID_V4_PATTERN.test(worker.token)) {
    return fail("INVALID_ARGUMENT", "worker.token must be a UUID v4 fencing token", {
      field: "worker.token",
    });
  }
  if (worker.leaseMs !== undefined && !(Number.isSafeInteger(worker.leaseMs) && worker.leaseMs > 0)) {
    return fail("INVALID_ARGUMENT", "worker.leaseMs must be a positive integer", {
      field: "worker.leaseMs",
    });
  }
  return worker;
}

function workerActor(worker) {
  return { id: worker.id, role: "SERVICE-WORKER", type: "WORKER" };
}

function requireActor(actor, fallback) {
  const value = actor ?? fallback;
  if (!value || typeof value.id !== "string" || value.id.length === 0) {
    return fail("INVALID_ARGUMENT", "actor.id is required", { field: "actor.id" });
  }
  if (typeof value.role !== "string" || typeof value.type !== "string") {
    return fail("INVALID_ARGUMENT", "actor.role and actor.type are required", { field: "actor" });
  }
  return value;
}

// Actor binding is per transition, not per caller preference. These helpers keep
// the T2/T9/T10 worker rows, the T12 operator row, the T14 verifier row and the
// cancellation rows from being driven by an arbitrary actor type/role.
function assertWorkerActor(actor) {
  if (actor.type !== "WORKER" || actor.role !== "SERVICE-WORKER") {
    fail("AUTHORIZATION_MISMATCH", "actor must be a service worker", {
      field: "actor",
      actualType: actor.type,
      actualRole: actor.role,
    });
  }
}

function assertOperatorActor(actor) {
  if (actor.type !== "OPERATOR" || !APPROVAL_ROLES.includes(actor.role)) {
    fail("AUTHORIZATION_MISMATCH", "actor must be an authorized operator", {
      field: "actor",
      actualType: actor.type,
      actualRole: actor.role,
    });
  }
}

function assertVerifierActor(actor) {
  if (actor.type !== "VERIFIER" || !APPROVAL_ROLES.includes(actor.role)) {
    fail("AUTHORIZATION_MISMATCH", "actor must be an authorized independent verifier", {
      field: "actor",
      actualType: actor.type,
      actualRole: actor.role,
    });
  }
}

function assertVerifierDistinct(actor, task) {
  // Both approval representations are authoritative. If they disagree, the
  // task cannot prove who approved it, so verification fails closed.
  const flatApprover = task.approvedBy ?? null;
  const nestedApprover = task.approval?.approvedBy ?? null;
  if (flatApprover !== null && nestedApprover !== null && flatApprover !== nestedApprover) {
    fail("AUTHORIZATION_MISMATCH", "flat and nested approver identities contradict", {
      field: "approval.approvedBy",
    });
  }
  if (flatApprover === actor.id) {
    fail("AUTHORIZATION_MISMATCH", "verifier must be distinct from the flat approver", {
      field: "approvedBy",
    });
  }
  if (nestedApprover === actor.id) {
    fail("AUTHORIZATION_MISMATCH", "verifier must be distinct from the nested approver", {
      field: "approval.approvedBy",
    });
  }
  if (task.executedBy === actor.id) {
    fail("AUTHORIZATION_MISMATCH", "verifier must be distinct from the executor", {
      field: "executedBy",
    });
  }
}

/**
 * Strict per-transition field picker. Unlike `pickWritableFields`, this only
 * admits the fields the approved row may write, so closure, cancellation,
 * approval, verification, lease and identity fields cannot be injected through
 * a generic transition.
 */
function pickTransitionFields(fields, allowed = []) {
  if (fields === undefined || fields === null) return {};
  if (typeof fields !== "object" || Array.isArray(fields)) {
    return fail("INVALID_ARGUMENT", "fields must be an object", { field: "fields" });
  }
  const rejected = Object.keys(fields).filter((key) => !allowed.includes(key));
  if (rejected.length > 0) {
    fail("INVALID_ARGUMENT", "field is not writable for this transition", {
      fields: rejected,
    });
  }
  return { ...fields };
}

/**
 * W1 strict creation picker. Unlike a spread, it admits only approved
 * finding/identity metadata, so a caller cannot seed approval, execution,
 * verification, closure, cancellation, resolution, lease or operation state at
 * creation time.
 */
function pickCreationFields(task) {
  const rejected = Object.keys(task).filter((key) => !TASK_CREATION_FIELDS.includes(key));
  if (rejected.length > 0) {
    fail("INVALID_ARGUMENT", "task draft contains a non-creation field", {
      fields: rejected,
    });
  }
  const picked = {};
  for (const key of TASK_CREATION_FIELDS) {
    if (task[key] !== undefined) picked[key] = task[key];
  }
  return picked;
}

/** OD-10 §2.4 clause 6: `durableClass` is exactly Boolean|null. */
function assertDurableClass(value) {
  if (value === undefined || value === null || typeof value === "boolean") return value;
  return fail("INVALID_ARGUMENT", "durableClass must be Boolean or null", {
    field: "durableClass",
  });
}

/** OD-10 §2.4 clauses 5/8: `details.diagnosticCode` is a technical cause only. */
function assertDiagnosticCode(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !DIAGNOSTIC_CODES.includes(value)) {
    fail("INVALID_ARGUMENT", "diagnosticCode must be a technical diagnostic value", {
      field: "diagnosticCode",
    });
  }
  return value;
}

/**
 * OD-10 §2.4 clause 5: every `RECOVERY_ESCALATED` event requires a conforming
 * `task.escalation.code`. Diagnostic values are not escalation categories.
 */
function assertEscalationRecord(escalation, field = "escalation") {
  if (!escalation || typeof escalation !== "object" || Array.isArray(escalation)) {
    fail("INVALID_ARGUMENT", "a conforming escalation record is required", { field });
  }
  if (typeof escalation.code !== "string" || !ESCALATION_CODES.includes(escalation.code)) {
    fail("INVALID_ARGUMENT", "escalation.code must be an approved escalation category", {
      field: `${field}.code`,
    });
  }
  for (const key of ["expectedStatus", "actualStatus"]) {
    if (
      escalation[key] !== undefined &&
      escalation[key] !== null &&
      typeof escalation[key] !== "string"
    ) {
      fail("INVALID_ARGUMENT", `escalation.${key} must be a string or null`, {
        field: `${field}.${key}`,
      });
    }
  }
  for (const key of ["expectedQuantity", "actualQuantity"]) {
    const value = escalation[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
      fail("INVALID_ARGUMENT", `escalation.${key} must be a finite number in [0, 1000000]`, {
        field: `${field}.${key}`,
      });
    }
  }
  return escalation;
}

function requireEffectFields(transition, fields) {
  for (const field of transition.requiredFields) {
    if (fields[field] === undefined) {
      fail("INVALID_ARGUMENT", `${field} is required for ${transition.id}`, { field });
    }
  }
  if (transition.requiredFields.includes("resolution")) {
    if (fields.resolution === "APPLIED") {
      fail(
        "INVALID_ARGUMENT",
        "APPLIED resolution is disabled/read-only pending its own authorization",
        { field: "resolution" },
      );
    }
    if (!transition.allowedResolutions.includes(fields.resolution)) {
      fail("INVALID_ARGUMENT", "resolution is not approved for this effect transition", {
        field: "resolution",
        allowed: [...transition.allowedResolutions],
      });
    }
  }
  if (transition.requiredFields.includes("currentFingerprint")) {
    if (
      typeof fields.currentFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(fields.currentFingerprint)
    ) {
      fail("INVALID_ARGUMENT", "currentFingerprint must be a 64-character lowercase hex digest", {
        field: "currentFingerprint",
      });
    }
  }
}

function approvalTime(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.getTime() : null;
}

/**
 * W5 T-APPROVE — normalize exactly one approval record.
 *
 * Validation and persistence must use the same object: a caller must not be able
 * to validate an APPROVED record while persisting a different PENDING one. The
 * returned object contains only the approved schema fields, so unknown caller
 * keys cannot reach the write.
 */
function normalizeApprovalRecord(raw, field = "approval", expectedState = "APPROVED") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("APPROVAL_REQUIRED", "an approval record is required for this transition", { field });
  }
  if (raw.state !== expectedState) {
    fail("APPROVAL_REQUIRED", `this transition requires a ${expectedState} approval record`, {
      field: `${field}.state`,
    });
  }
  if (typeof raw.approvedBy !== "string" || raw.approvedBy.trim().length === 0) {
    fail("APPROVAL_REQUIRED", "approval.approvedBy must be a non-empty identity", {
      field: `${field}.approvedBy`,
    });
  }
  if (typeof raw.operatorRole !== "string" || !APPROVAL_ROLES.includes(raw.operatorRole)) {
    fail("APPROVAL_REQUIRED", "approval.operatorRole must be an authorized role", {
      field: `${field}.operatorRole`,
    });
  }
  if (approvalTime(raw.approvedAt) === null) {
    fail("APPROVAL_REQUIRED", "approval.approvedAt must be a valid Date", {
      field: `${field}.approvedAt`,
    });
  }
  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== "string") {
    fail("INVALID_ARGUMENT", "approval.notes must be a string", { field: `${field}.notes` });
  }
  return {
    state: raw.state,
    approvedBy: raw.approvedBy,
    approvedAt: raw.approvedAt,
    operatorRole: raw.operatorRole,
    notes: raw.notes ?? null,
  };
}

function sameApprovalRecord(left, right) {
  return (
    left.state === right.state &&
    left.approvedBy === right.approvedBy &&
    left.operatorRole === right.operatorRole &&
    approvalTime(left.approvedAt) === approvalTime(right.approvedAt) &&
    (left.notes ?? null) === (right.notes ?? null)
  );
}

/**
 * Resolve the single canonical T-APPROVE approval object.
 *
 * Both `input.approval` and `fields.approval` are accepted for compatibility,
 * but when both are supplied they must describe the same approval. Caller flat
 * `approvedBy`/`approvedAt` fields may confirm the record but may never
 * contradict it. The returned object is the only approval that may be written.
 */
function resolveCanonicalApproval(
  inputApproval,
  fieldApproval,
  flatApprovedBy,
  flatApprovedAt,
  expectedState = "APPROVED",
) {
  const hasInput = inputApproval !== undefined && inputApproval !== null;
  const hasField = fieldApproval !== undefined && fieldApproval !== null;
  if (!hasInput && !hasField) {
    fail("APPROVAL_REQUIRED", `this transition requires a ${expectedState} approval record`, {
      field: "approval",
    });
  }
  const canonical = normalizeApprovalRecord(
    hasInput ? inputApproval : fieldApproval,
    hasInput ? "input.approval" : "fields.approval",
    expectedState,
  );
  if (hasInput && hasField) {
    const alternate = normalizeApprovalRecord(fieldApproval, "fields.approval", expectedState);
    if (!sameApprovalRecord(canonical, alternate)) {
      fail(
        "APPROVAL_REQUIRED",
        "input.approval and fields.approval must describe the same approval",
        { field: "approval" },
      );
    }
  }
  if (
    flatApprovedBy !== undefined &&
    flatApprovedBy !== null &&
    flatApprovedBy !== canonical.approvedBy
  ) {
    fail("APPROVAL_REQUIRED", "fields.approvedBy contradicts the validated approval identity", {
      field: "approvedBy",
    });
  }
  if (flatApprovedAt !== undefined && flatApprovedAt !== null) {
    if (
      approvalTime(flatApprovedAt) === null ||
      approvalTime(flatApprovedAt) !== approvalTime(canonical.approvedAt)
    ) {
      fail("APPROVAL_REQUIRED", "fields.approvedAt contradicts the validated approval timestamp", {
        field: "approvedAt",
      });
    }
  }
  return canonical;
}

/**
 * W11 / §3.3 T-APPROVE separation of duties.
 *
 * The approver must be an `OPERATOR` whose role matches the role being recorded
 * in `approval.operatorRole`, and must be a different identity from the executor
 * (`executedBy`) and the independent verifier (`verifierId`) — G_APPROVAL and
 * G_DISTINCT. These are typed pre-checks; the distinctness conditions are
 * repeated as CAS `$ne` clauses so a concurrent write cannot slip past them.
 */
function assertApprovalDistinct(actor, approval, task) {
  if (!approval || typeof approval !== "object") {
    fail("APPROVAL_REQUIRED", "an approval record is required for T-APPROVE", {
      field: "approval",
    });
  }
  if (actor.type !== "OPERATOR") {
    fail("AUTHORIZATION_MISMATCH", "approval actor must be an operator", {
      field: "actor.type",
      actualType: actor.type,
    });
  }
  if (typeof approval.operatorRole !== "string" || !APPROVAL_ROLES.includes(approval.operatorRole)) {
    fail("APPROVAL_REQUIRED", "approval.operatorRole must be an authorized role", {
      field: "approval.operatorRole",
    });
  }
  if (actor.role !== approval.operatorRole) {
    fail("AUTHORIZATION_MISMATCH", "actor.role must equal approval.operatorRole", {
      field: "actor.role",
      actorRole: actor.role,
      approvalRole: approval.operatorRole,
    });
  }
  if (approval.approvedBy !== actor.id) {
    fail("APPROVAL_REQUIRED", "approver identity must match the acting operator", {
      field: "approval.approvedBy",
    });
  }
  // The flat audit field and the nested approval must not disagree. A stale flat
  // approver is not allowed to survive an approval write.
  if (
    task.approvedBy !== undefined &&
    task.approvedBy !== null &&
    task.approvedBy !== approval.approvedBy
  ) {
    fail("APPROVAL_REQUIRED", "flat approvedBy contradicts the validated approval", {
      field: "approvedBy",
    });
  }
  if (task.executedBy === actor.id) {
    fail("APPROVAL_REQUIRED", "approver must be distinct from the executor", {
      field: "executedBy",
    });
  }
  if (task.verifierId === actor.id) {
    fail("APPROVAL_REQUIRED", "approver must be distinct from the verifier", {
      field: "verifierId",
    });
  }
}

function buildEventDocument({
  task,
  sequenceNumber,
  leaseGeneration,
  eventType,
  actor,
  details,
  fencingToken,
  now,
}) {
  return {
    eventId: buildEventId(task.taskId, sequenceNumber),
    taskId: task.taskId,
    orderId: task.orderId,
    sequenceNumber,
    leaseGeneration: toBigInt(leaseGeneration, "leaseGeneration"),
    timestamp: now,
    eventType,
    actorId: actor.id,
    actorRole: actor.role,
    actorType: actor.type,
    fencingToken: fencingToken ?? null,
    evidenceDigest: task.currentFingerprint,
    projectedEvidence: {},
    details: {
      fromStatus: details?.fromStatus ?? null,
      toStatus: details?.toStatus,
      attempts: details?.attempts,
      diagnosticCode: details?.diagnosticCode ?? null,
      observedFingerprint: details?.observedFingerprint ?? null,
      leaseDurationMs: details?.leaseDurationMs ?? null,
      delta: details?.delta ?? null,
    },
  };
}

function buildHistoryDocument({ task, operation, state, settledAt, settlement, manualReasonCode, basis }) {
  return {
    historyId: buildOperationHistoryId(task.taskId, operation.operationId),
    taskId: task.taskId,
    operationId: operation.operationId,
    state,
    leaseGeneration: toBigInt(operation.leaseGeneration, "operation.leaseGeneration"),
    sequenceNumber: toBigInt(operation.sequenceNumber, "operation.sequenceNumber"),
    eventId: operation.eventId,
    reservedAt: operation.reservedAt,
    reservedBy: operation.reservedBy,
    settledAt,
    intentDigest: operation.intentDigest,
    settlement: settlement ?? null,
    manualReasonCode: manualReasonCode ?? null,
    basis: basis ?? null,
  };
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/**
 * Create the canonical writer. Exactly one dependency set is required:
 * a Mongoose `connection`, or explicit `models` plus `startSession`.
 *
 * @param {object} [options]
 * @param {object|null} [options.connection] Mongoose connection.
 * @param {{task: object, event: object, history: object}|null} [options.models]
 * @param {(() => Promise<object>)|null} [options.startSession]
 * @param {(() => Date)|undefined} [options.clock]
 * @param {(() => string)|undefined} [options.newOperationId]
 * @param {((trace: object) => void)|null} [options.trace] Runtime tracing hook.
 */
export function createRecoveryTaskWriter(options = {}) {
  const {
    connection = null,
    models = null,
    startSession = null,
    clock = () => new Date(),
    newOperationId = () => randomUUID(),
    trace = null,
  } = options;

  if (!models && !connection) {
    return fail("INVALID_ARGUMENT", "a connection or explicit models are required", {
      field: "connection",
    });
  }

  const taskModel = models?.task ?? getRecoveryTaskModel(connection);
  const eventModel = models?.event ?? getRecoveryEventModel(connection);
  const historyModel = models?.history ?? getRecoveryOperationHistoryModel(connection);
  const openSession =
    startSession ?? (() => Promise.resolve(connection.startSession()));

  async function runTransaction(work) {
    const session = await openSession();
    let result;
    try {
      await session.withTransaction(async () => {
        // Throwing inside the callback is the explicit abort (§13.1).
        result = await work(session);
      }, TRANSACTION_OPTIONS);
    } finally {
      if (session && typeof session.endSession === "function") {
        await session.endSession();
      }
    }
    return result;
  }

  function emitTrace(entryPoint, payload) {
    if (typeof trace === "function") {
      trace({ entryPoint, ...payload });
    }
  }

  async function readTask(session, taskId) {
    assertTaskId(taskId, "taskId");
    const task = await taskModel.findOne(
      { taskId },
      null,
      { session, readConcern: { level: "majority" } },
    );
    if (!task) {
      fail("TASK_NOT_FOUND", "recovery task not found", { taskId });
    }
    return task;
  }

  function assertMatched(result, stage, context) {
    const matched = result?.matchedCount ?? result?.n ?? 0;
    if (matched !== 1) {
      fail("CAS_MISMATCH", `${stage} conditional write matched zero documents`, {
        stage,
        ...context,
      });
    }
  }

  async function insertEvent(session, document) {
    try {
      await eventModel.insertMany([document], { session, ordered: true });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        fail("DUPLICATE_EVENT", "event identity already exists", {
          eventId: document.eventId,
          taskId: document.taskId,
          sequenceNumber: document.sequenceNumber.toString(),
        });
      }
      throw error;
    }
  }

  async function insertHistory(session, document) {
    try {
      await historyModel.insertMany([document], { session, ordered: true });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        fail("DUPLICATE_HISTORY", "operation history identity already exists", {
          historyId: document.historyId,
          taskId: document.taskId,
          operationId: document.operationId,
        });
      }
      throw error;
    }
  }

  function leaseUntilFrom(worker, now) {
    const leaseMs = worker.leaseMs ?? 5 * 60 * 1000; // OD-09 provisional test value.
    return new Date(now.getTime() + leaseMs);
  }

  // ---------------------------------------------------------------------------
  // W1 — createTaskFromFinding
  // ---------------------------------------------------------------------------
  async function createTaskFromFinding(input = {}) {
    assertAllowlisted("createTaskFromFinding");
    const { task, actor } = input;
    if (!task || typeof task !== "object") {
      fail("INVALID_ARGUMENT", "task draft is required", { field: "task" });
    }
    assertTaskId(task.taskId, "task.taskId");
    if (!task.findingIdentityKey) {
      fail("INVALID_ARGUMENT", "findingIdentityKey is required", { field: "findingIdentityKey" });
    }
    assertFingerprint(task.initialFingerprint, "initialFingerprint");
    assertFingerprint(task.currentFingerprint, "currentFingerprint");
    assertDurableClass(task.durableClass);

    const now = toDate(input.now ?? clock(), "now");
    const sequenceNumber = 1n;
    const taskDocument = {
      ...pickCreationFields(task),
      status: "DETECTED",
      isOpen: true,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      leaseGeneration: 0n,
      eventSequenceCounter: sequenceNumber,
      attempts: 0,
      pendingOperation: null,
      createdAt: now,
      updatedAt: now,
    };
    const eventDocument = buildEventDocument({
      task: taskDocument,
      sequenceNumber,
      leaseGeneration: 0n,
      eventType: "RECOVERY_DETECTED",
      actor: requireActor(actor, { id: "SCANNER", role: "SERVICE-WORKER", type: "SCANNER" }),
      details: { toStatus: "DETECTED", attempts: 0 },
      fencingToken: null,
      now,
    });

    const result = await runTransaction(async (session) => {
      try {
        await taskModel.insertMany([taskDocument], { session, ordered: true });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          fail("DUPLICATE_TASK", "an open task already exists for this finding", {
            taskId: taskDocument.taskId,
            findingIdentityKey: taskDocument.findingIdentityKey,
          });
        }
        throw error;
      }
      await insertEvent(session, eventDocument);
      return {
        taskId: taskDocument.taskId,
        eventId: eventDocument.eventId,
        sequenceNumber,
        status: "DETECTED",
      };
    });

    emitTrace("createTaskFromFinding", {
      taskId: result.taskId,
      eventId: result.eventId,
      sequenceNumber: result.sequenceNumber,
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // W2 — claimLease (DETECTED / RETRY_SCHEDULED / expired LEASED / T12 reclaim)
  // ---------------------------------------------------------------------------
  async function claimLease(input = {}) {
    assertAllowlisted("claimLease");
    const worker = requireWorker(input.worker);
    const fromStatus = input.fromStatus;
    if (!["DETECTED", "RETRY_SCHEDULED", "LEASED", "MANUAL_REQUIRED"].includes(fromStatus)) {
      fail("INVALID_ARGUMENT", "fromStatus is not claimable", { field: "fromStatus" });
    }
    // T12 is an operator/manager acquisition and must carry an explicit
    // OPERATOR identity. T2/T9/T10 are worker acquisitions.
    const manualReclaim = fromStatus === "MANUAL_REQUIRED";
    const actor = manualReclaim
      ? requireActor(input.actor, null)
      : requireActor(input.actor, workerActor(worker));
    if (manualReclaim) assertOperatorActor(actor);
    else assertWorkerActor(actor);
    const now = toDate(input.now ?? clock(), "now");
    const leaseUntil = leaseUntilFrom(worker, now);
    const taskId = input.taskId;

    const result = await runTransaction(async (session) => {
      const task = await readTask(session, taskId);

      if (task.status !== fromStatus) {
        fail("CAS_MISMATCH", "claim precondition failed on status", {
          stage: "CLAIM",
          expectedStatus: fromStatus,
          actualStatus: task.status,
        });
      }
      if (!task.isOpen) {
        fail("CAS_MISMATCH", "claim precondition failed: task is closed", {
          stage: "CLAIM",
          taskId,
        });
      }
      // Typed pre-check; `U_claim` in the filter remains the actual fence.
      assertNoUnresolvedOperation(task);

      if (manualReclaim) {
        // T12: a named approver approved the action, the recorded approval role
        // is present, authorized and identical to the executor's role, and the
        // executor is distinct from the approver. None of these checks may be
        // skipped because a field is null. The security-critical conditions are
        // repeated as CAS clauses below.
        const approval = task.approval;
        if (!approval || approval.state !== "APPROVED") {
          fail("APPROVAL_REQUIRED", "T12 requires an APPROVED approval record", {
            field: "approval.state",
          });
        }
        if (typeof approval.approvedBy !== "string" || approval.approvedBy.length === 0) {
          fail("APPROVAL_REQUIRED", "T12 requires a named approver", {
            field: "approval.approvedBy",
          });
        }
        if (
          typeof approval.operatorRole !== "string" ||
          !APPROVAL_ROLES.includes(approval.operatorRole)
        ) {
          fail("APPROVAL_REQUIRED", "T12 requires an authorized approval.operatorRole", {
            field: "approval.operatorRole",
          });
        }
        if (!(approval.approvedAt instanceof Date) || Number.isNaN(approval.approvedAt.getTime())) {
          fail("APPROVAL_REQUIRED", "T12 requires a valid approval.approvedAt", {
            field: "approval.approvedAt",
          });
        }
        if (approval.operatorRole !== actor.role) {
          fail("AUTHORIZATION_MISMATCH", "executor role must match the approval role", {
            field: "actor.role",
            actorRole: actor.role,
            approvalRole: approval.operatorRole,
          });
        }
        if (approval.approvedBy === actor.id) {
          fail("APPROVAL_REQUIRED", "executor must be distinct from the approver", {
            field: "approval.approvedBy",
          });
        }
        // If the flat audit field is present it must agree with the nested
        // approval. A contradiction is an attribution failure, not a preference.
        if (
          task.approvedBy !== undefined &&
          task.approvedBy !== null &&
          task.approvedBy !== approval.approvedBy
        ) {
          fail("APPROVAL_REQUIRED", "flat approvedBy contradicts the nested approval", {
            field: "approvedBy",
          });
        }
      }

      const sequenceNumber = nextSequenceNumber(task.eventSequenceCounter);
      const leaseGeneration = toBigInt(task.leaseGeneration, "leaseGeneration") + 1n;
      const attempts = Number(task.attempts ?? 0) + 1;

      const clauses = [
        { taskId },
        { isOpen: true },
        { status: fromStatus },
        { leaseGeneration: toBigInt(task.leaseGeneration, "leaseGeneration") },
        buildClaimUnresolvedPredicate(),
        ...buildSequencePredicate(task.eventSequenceCounter),
      ];

      if (fromStatus === "DETECTED" || fromStatus === "RETRY_SCHEDULED") {
        // G_ATTEMPTS applies only to the automatic acquisitions T2
        // (DETECTED -> LEASED) and T10 (RETRY_SCHEDULED -> LEASED). It is
        // deliberately absent from T9 expired-lease reclaim and T12 approved
        // manual reclaim: an exhausted crashed lease must stay reclaimable so
        // it can reach T7 (MANUAL_REQUIRED) or the approved W8 abandonment
        // path. OD-09 numerics remain test-derived.
        clauses.push({ $expr: { $lt: ["$attempts", "$maxAttempts"] } });
      }

      if (fromStatus === "RETRY_SCHEDULED") {
        clauses.push({ $expr: { $lte: ["$nextAttemptAt", "$$NOW"] } });
      }
      if (fromStatus === "LEASED") {
        // Expired-lease reclaim (OD-37 / T9). A live lease is never stolen.
        clauses.push({ $expr: { $lte: ["$leaseUntil", "$$NOW"] } });
      }
      if (fromStatus === "MANUAL_REQUIRED") {
        // T12: approval is required, the approver is a named identity, the
        // approval role is present and equals the executor role, the approval
        // timestamp is present, and the executor (actor) is distinct from the
        // approver. These are repeated in the CAS so a concurrent write cannot
        // remove a condition between the typed check and the update.
        clauses.push({ "approval.state": "APPROVED" });
        clauses.push({ "approval.approvedBy": { $ne: null } });
        clauses.push({ "approval.approvedBy": { $ne: actor.id } });
        clauses.push({ "approval.operatorRole": actor.role });
        clauses.push({ "approval.approvedAt": { $ne: null } });
        clauses.push({
          $or: [{ approvedBy: null }, { approvedBy: task.approval.approvedBy }],
        });
      }

      const set = {
        status: "LEASED",
        isOpen: true,
        leaseOwner: worker.id,
        leaseToken: worker.token,
        leaseUntil,
        updatedAt: now,
      };
      if (manualReclaim) {
        // T12 executor attribution (G_DISTINCT / BLK-AP-01 representation).
        set.executedBy = actor.id;
        set.executedAt = now;
      }
      const update = {
        $set: set,
        $inc: {
          leaseGeneration: 1n,
          attempts: 1,
          eventSequenceCounter: 1n,
        },
      };
      if (fromStatus === "RETRY_SCHEDULED") {
        update.$unset = { nextAttemptAt: "" };
      }

      const write = await taskModel.updateOne({ $and: clauses }, update, { session });
      assertMatched(write, "CLAIM", { taskId });

      await insertEvent(
        session,
        buildEventDocument({
          task,
          sequenceNumber,
          leaseGeneration,
          eventType: "RECOVERY_LEASED",
          actor,
          details: {
            fromStatus,
            toStatus: "LEASED",
            attempts,
            leaseDurationMs: worker.leaseMs ?? 5 * 60 * 1000,
          },
          fencingToken: worker.token,
          now,
        }),
      );

      return {
        taskId,
        status: "LEASED",
        leaseGeneration,
        sequenceNumber,
        eventId: buildEventId(taskId, sequenceNumber),
      };
    });

    emitTrace("claimLease", {
      taskId: result.taskId,
      sequenceNumber: result.sequenceNumber,
      eventId: result.eventId,
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // W3 — renewLease
  // ---------------------------------------------------------------------------
  async function renewLease(input = {}) {
    assertAllowlisted("renewLease");
    const worker = requireWorker(input.worker);
    const actor = requireActor(input.actor, workerActor(worker));
    assertWorkerActor(actor);
    const now = toDate(input.now ?? clock(), "now");
    const leaseUntil = leaseUntilFrom(worker, now);

    const result = await runTransaction(async (session) => {
      const task = await readTask(session, input.taskId);
      const transition = getLifecycleTransition("T-RENEW");
      if (task.status !== transition.from) {
        fail("CAS_MISMATCH", "renew precondition failed on status", {
          stage: "RENEW",
          expectedStatus: transition.from,
          actualStatus: task.status,
        });
      }
      assertNoUnresolvedOperation(task);

      const sequenceNumber = nextSequenceNumber(task.eventSequenceCounter);
      const leaseGeneration = toBigInt(task.leaseGeneration, "leaseGeneration");
      const clauses = [
        { taskId: task.taskId },
        { isOpen: true },
        { status: transition.from },
        { leaseGeneration },
        buildUnresolvedOperationPredicate(),
        ...buildSequencePredicate(task.eventSequenceCounter),
        buildLeasePredicate({
          leaseGeneration,
          leaseToken: worker.token,
          leaseOwner: worker.id,
        }),
      ];

      const write = await taskModel.updateOne(
        { $and: clauses },
        { $set: { leaseUntil, updatedAt: now }, $inc: { eventSequenceCounter: 1n } },
        { session },
      );
      assertMatched(write, "RENEW", { taskId: task.taskId });

      await insertEvent(
        session,
        buildEventDocument({
          task,
          sequenceNumber,
          leaseGeneration,
          eventType: transition.eventType,
          actor,
          details: { fromStatus: "LEASED", toStatus: "LEASED", attempts: task.attempts },
          fencingToken: worker.token,
          now,
        }),
      );

      return {
        taskId: task.taskId,
        sequenceNumber,
        eventId: buildEventId(task.taskId, sequenceNumber),
      };
    });

    emitTrace("renewLease", { taskId: result.taskId, sequenceNumber: result.sequenceNumber });
    return result;
  }

  // ---------------------------------------------------------------------------
  // W5 — applyTransition (allowlisted lifecycle rows only)
  // ---------------------------------------------------------------------------
  async function applyTransition(input = {}) {
    assertAllowlisted("applyTransition");
    return runLifecycle("applyTransition", input);
  }

  async function runLifecycle(entryPoint, input = {}, inheritedSession = null) {
    const transition = getLifecycleTransition(input.transitionId);
    if (!transition) {
      fail("TRANSITION_NOT_ALLOWED", "transition is not in the approved lifecycle table", {
        transitionId: input.transitionId,
      });
    }
    if (transition.claim) {
      // Claims are W2 only. W5 must not perform a lease-generation bump.
      fail("TRANSITION_NOT_ALLOWED", "claim transitions must use claimLease (W2)", {
        transitionId: transition.id,
      });
    }
    if (entryPoint === "applyTransition" && !W5_TRANSITION_IDS.includes(transition.id)) {
      // T5 resolution, T14 closure and cancellation are dedicated entry points
      // (W9/W10). T4/T11/T15 have no runtime row. W5 cannot drive them.
      fail("TRANSITION_NOT_ALLOWED", "W5 applyTransition may only run the approved generic rows", {
        transitionId: transition.id,
        approved: [...W5_TRANSITION_IDS],
      });
    }

    const now = toDate(input.now ?? clock(), "now");
    const fields = pickTransitionFields(input.fields, TRANSITION_FIELD_ALLOWLISTS[transition.id]);
    const diagnosticCode = assertDiagnosticCode(input.diagnosticCode);

    const requiresWorker =
      transition.requiresLease ||
      transition.id === "T-RESOLVE" ||
      transition.id === "T-RETRY" ||
      transition.id === "T-EXHAUST" ||
      transition.id === "T-CANCEL-LEASED";
    const worker = requiresWorker ? requireWorker(input.worker) : input.worker ?? null;

    let actor;
    let canonicalApproval = null;
    if (transition.id === "T-APPROVE") {
      actor = requireActor(input.actor, null);
      // RECOVERY_APPROVED may only be written when the approval actually is
      // APPROVED. Exactly one canonical object is validated and persisted;
      // PENDING/REJECTED/missing/conflicting records stop before any write.
      canonicalApproval = resolveCanonicalApproval(
        input.approval,
        fields.approval,
        fields.approvedBy,
        fields.approvedAt,
        "APPROVED",
      );
      fields.approval = canonicalApproval;
      fields.approvedBy = canonicalApproval.approvedBy;
      fields.approvedAt = canonicalApproval.approvedAt;
    } else if (transition.id === "T-REJECT") {
      actor = requireActor(input.actor, null);
      // RECOVERY_REJECTED may only be written when the decision actually is
      // REJECTED. The same canonical object feeds validation and persistence.
      canonicalApproval = resolveCanonicalApproval(
        input.approval,
        fields.approval,
        fields.approvedBy,
        fields.approvedAt,
        "REJECTED",
      );
      fields.approval = canonicalApproval;
      fields.approvedBy = canonicalApproval.approvedBy;
      fields.approvedAt = canonicalApproval.approvedAt;
    } else if (transition.id === "T-CLOSE") {
      actor = requireActor(input.actor, null);
      assertVerifierActor(actor);
    } else if (transition.id === "T-CANCEL-DETECTED" || transition.id === "T-CANCEL-MANUAL") {
      actor = requireActor(input.actor, null);
      assertOperatorActor(actor);
    } else if (requiresWorker) {
      actor = requireActor(input.actor, workerActor(worker));
      assertWorkerActor(actor);
    } else {
      actor = requireActor(input.actor, null);
      assertOperatorActor(actor);
    }

    if (transition.id === "T-RETRY") {
      // T6: retry scheduling requires a next attempt and attempts < maxAttempts.
      if (!(fields.nextAttemptAt instanceof Date) || Number.isNaN(fields.nextAttemptAt.getTime())) {
        fail("INVALID_ARGUMENT", "T-RETRY requires a valid nextAttemptAt", {
          field: "nextAttemptAt",
        });
      }
    }
    if (transition.id === "T-EXHAUST") {
      // OD-10 §2.4 clause 5: every RECOVERY_ESCALATED carries a valid
      // task.escalation.code. An omitted or diagnostic-valued code is refused
      // before any session opens.
      if (fields.escalation === undefined || fields.escalation === null) {
        fail("INVALID_ARGUMENT", "T-EXHAUST requires a conforming escalation record", {
          field: "escalation",
        });
      }
      assertEscalationRecord(fields.escalation, "escalation");
    }
    if (transition.id === "T-RESOLVE") {
      if (fields.resolution === "APPLIED") {
        fail("INVALID_ARGUMENT", "APPLIED resolution is disabled/read-only", {
          field: "resolution",
        });
      }
      // T5 (already-correct path): the writer owns the resolution value.
      fields.resolution = "ALREADY_CORRECT";
    }
    if (transition.id === "T-CLOSE") {
      // T14: the writer owns the verifier identity; callers cannot supply a
      // different verifier through fields.
      fields.verifierId = actor.id;
      fields.verifiedAt = now;
    }
    if (transition.to === "CANCELLED") {
      // Cancellation resolution is writer-owned; it is not a caller field.
      fields.resolution = "CANCELLED";
    }

    const work = async (session) => {
      const task = await readTask(session, input.taskId);
      if (task.status !== transition.from) {
        fail("TRANSITION_NOT_ALLOWED", "task status does not match the transition source", {
          transitionId: transition.id,
          expectedStatus: transition.from,
          actualStatus: task.status,
        });
      }
      assertNoUnresolvedOperation(task);

      if (transition.requiresApprovalDistinct) {
        assertApprovalDistinct(actor, canonicalApproval, task);
      }
      if (transition.id === "T-CLOSE") {
        assertVerifierDistinct(actor, task);
      }

      const sequenceNumber = nextSequenceNumber(task.eventSequenceCounter);
      const leaseGeneration = toBigInt(task.leaseGeneration, "leaseGeneration");

      const clauses = [
        { taskId: task.taskId },
        { isOpen: true },
        { status: transition.from },
        { leaseGeneration },
        buildUnresolvedOperationPredicate(),
        ...buildSequencePredicate(task.eventSequenceCounter),
      ];

      if (transition.requiresLease) {
        clauses.push(
          buildLeasePredicate({
            leaseGeneration,
            leaseToken: worker.token,
            leaseOwner: worker.id,
          }),
        );
      }
      if (transition.requiresAttemptsExhausted) {
        clauses.push({ $expr: { $gte: ["$attempts", "$maxAttempts"] } });
      }
      if (transition.id === "T-RETRY") {
        // T6: attempts < maxAttempts. G_ATTEMPTS is not applied to T9/T12.
        clauses.push({ $expr: { $lt: ["$attempts", "$maxAttempts"] } });
      }
      if (transition.requiresApprovalPending) {
        clauses.push({
          $or: [{ "approval.state": null }, { "approval.state": "PENDING" }],
        });
      }
      if (transition.requiresApprovalDistinct) {
        // G_DISTINCT: the approver must not be the executor or the independent
        // verifier. `$ne` also matches a missing/null audit field, so an unset
        // field can never be mistaken for the approver's identity.
        clauses.push({ executedBy: { $ne: actor.id } });
        clauses.push({ verifierId: { $ne: actor.id } });
        // The flat audit approver, if present, must agree with the canonical
        // nested approval being written.
        clauses.push({
          $or: [{ approvedBy: null }, { approvedBy: canonicalApproval.approvedBy }],
        });
      }
      if (transition.id === "T-CLOSE") {
        // T14: the verifier must be distinct from both approver representations
        // and from the executor. The flat/nested consistency clause fails closed
        // if a concurrent write makes the approver attribution contradictory.
        clauses.push({ approvedBy: { $ne: actor.id } });
        clauses.push({ "approval.approvedBy": { $ne: actor.id } });
        clauses.push({ executedBy: { $ne: actor.id } });
        clauses.push({
          $or: [
            { approvedBy: null },
            { "approval.approvedBy": null },
            { $expr: { $eq: ["$approvedBy", "$approval.approvedBy"] } },
          ],
        });
      }
      if (transition.requiresApprovalApproved) {
        clauses.push({ "approval.state": "APPROVED" });
        clauses.push({ "approval.approvedBy": { $ne: null } });
      }
      if (transition.closes) {
        clauses.push({ isOpen: true });
      }

      const set = {
        ...fields,
        status: transition.to,
        updatedAt: now,
      };
      if (transition.closes) {
        set.isOpen = false;
        if (transition.to === "CLOSED") set.closedAt = now;
        if (transition.to === "CANCELLED") set.cancelledAt = now;
      }

      const write = await taskModel.updateOne(
        { $and: clauses },
        { $set: set, $inc: { eventSequenceCounter: 1n } },
        { session },
      );
      assertMatched(write, "TRANSITION", { taskId: task.taskId, transitionId: transition.id });

      await insertEvent(
        session,
        buildEventDocument({
          task,
          sequenceNumber,
          leaseGeneration,
          eventType: transition.eventType,
          actor,
          details: {
            fromStatus: transition.from,
            toStatus: transition.to,
            attempts: task.attempts,
            diagnosticCode,
            observedFingerprint: input.observedFingerprint ?? null,
          },
          fencingToken: worker?.token ?? null,
          now,
        }),
      );

      return {
        taskId: task.taskId,
        status: transition.to,
        sequenceNumber,
        eventId: buildEventId(task.taskId, sequenceNumber),
      };
    };

    const result = inheritedSession
      ? await work(inheritedSession)
      : await runTransaction(work);

    emitTrace(entryPoint, {
      taskId: result.taskId,
      sequenceNumber: result.sequenceNumber,
      eventId: result.eventId,
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // W6 — reserveOperation (standalone T_reserve, I-C)
  // ---------------------------------------------------------------------------
  async function reserveOperation(input = {}) {
    assertAllowlisted("reserveOperation");
    const worker = requireWorker(input.worker);
    const taskId = input.taskId;
    assertFingerprint(input.intentDigest, "intentDigest");
    // Minted once per logical reservation, outside the transaction, so driver
    // retries reuse the same identity (§22.4).
    const operationId = input.operationId ?? newOperationId();
    if (typeof operationId !== "string" || operationId.length === 0) {
      fail("INVALID_ARGUMENT", "operationId must be a non-empty string", {
        field: "operationId",
      });
    }
    const now = toDate(input.now ?? clock(), "now");

    const result = await runTransaction(async (session) => {
      const task = await readTask(session, taskId);

      if (task.status !== "LEASED") {
        fail("CAS_MISMATCH", "reservation requires a leased task", {
          stage: "RESERVE",
          expectedStatus: "LEASED",
          actualStatus: task.status,
        });
      }
      assertNoUnresolvedOperation(task);

      const counter = toBigInt(task.eventSequenceCounter, "eventSequenceCounter");
      const sequenceNumber = nextSequenceNumber(counter);
      const leaseGeneration = toBigInt(task.leaseGeneration, "leaseGeneration");
      const eventId = buildEventId(taskId, sequenceNumber);

      const previous = task.pendingOperation;
      const pendingClause = previous
        ? {
            "pendingOperation.operationId": previous.operationId,
            "pendingOperation.state": { $in: [...TERMINAL_OP_STATES] },
            "pendingOperation.leaseGeneration": toBigInt(
              previous.leaseGeneration,
              "pendingOperation.leaseGeneration",
            ),
            "pendingOperation.sequenceNumber": toBigInt(
              previous.sequenceNumber,
              "pendingOperation.sequenceNumber",
            ),
            "pendingOperation.eventId": previous.eventId,
          }
        : { pendingOperation: null };

      const clauses = [
        { taskId },
        { isOpen: true },
        { status: "LEASED" },
        { leaseGeneration },
        buildLeasePredicate({
          leaseGeneration,
          leaseToken: worker.token,
          leaseOwner: worker.id,
        }),
        buildUnresolvedOperationPredicate(),
        ...buildSequencePredicate(counter),
        pendingClause,
      ];

      const write = await taskModel.updateOne(
        { $and: clauses },
        {
          $set: {
            pendingOperation: {
              operationId,
              state: "PREPARED",
              leaseGeneration,
              sequenceNumber,
              eventId,
              reservedAt: now,
              reservedBy: worker.id,
              intentDigest: input.intentDigest,
              settledAt: null,
              settlement: null,
            },
            updatedAt: now,
          },
          $inc: { eventSequenceCounter: 1n },
        },
        { session },
      );
      assertMatched(write, "RESERVE", { taskId });

      // I-C: T_reserve emits no event.
      return {
        taskId,
        operation: {
          operationId,
          state: "PREPARED",
          leaseGeneration,
          sequenceNumber,
          eventId,
          reservedAt: now,
          reservedBy: worker.id,
          intentDigest: input.intentDigest,
          settledAt: null,
          settlement: null,
          // Transient handle only (OD-37). Not part of the persisted
          // `pendingOperation` document and never written to the task.
          leaseToken: worker.token,
        },
        operationId,
        leaseGeneration,
        sequenceNumber,
        eventId,
      };
    });

    emitTrace("reserveOperation", {
      taskId: result.taskId,
      operationId: result.operationId,
      sequenceNumber: result.sequenceNumber,
    });
    return result;
  }

  function requireOperation(operation) {
    if (!operation || typeof operation !== "object") {
      return fail("INVALID_ARGUMENT", "operation reservation is required", { field: "operation" });
    }
    if (typeof operation.operationId !== "string" || operation.operationId.length === 0) {
      return fail("INVALID_ARGUMENT", "operation.operationId is required", {
        field: "operation.operationId",
      });
    }
    toBigInt(operation.leaseGeneration, "operation.leaseGeneration");
    toBigInt(operation.sequenceNumber, "operation.sequenceNumber");
    if (typeof operation.eventId !== "string") {
      return fail("INVALID_ARGUMENT", "operation.eventId is required", {
        field: "operation.eventId",
      });
    }
    // Transient, never persisted: `reserveOperation` returns the acquiring
    // lease token so a caller can prove it holds the original lease. The
    // signed OD-10 `pendingOperation` shape has no `leaseToken` field.
    if (operation.leaseToken !== undefined) {
      if (typeof operation.leaseToken !== "string" || !UUID_V4_PATTERN.test(operation.leaseToken)) {
        return fail("INVALID_ARGUMENT", "operation.leaseToken must be a UUID v4 fencing token", {
          field: "operation.leaseToken",
        });
      }
    }
    return operation;
  }

  // ---------------------------------------------------------------------------
  // W7 — commitOperation (T_effect): task + event + H1 history, one transaction
  // ---------------------------------------------------------------------------
  async function commitOperation(input = {}) {
    assertAllowlisted("commitOperation");
    const operation = requireOperation(input.operation);
    const worker = requireWorker(input.worker);
    const actor = requireActor(input.actor, workerActor(worker));
    assertWorkerActor(actor);
    // T5 is the only approved effect. The caller cannot choose an arbitrary
    // status pair or event type, and only the strict effect field set is writable.
    const transition = resolveEffectTransition({
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      eventType: input.eventType,
    });
    const fields = pickTransitionFields(input.fields, transition.allowedFields, transition.id);
    requireEffectFields(transition, fields);
    const diagnosticCode = assertDiagnosticCode(input.diagnosticCode);
    const fromStatus = transition.from;
    const toStatus = transition.to;
    const now = toDate(input.now ?? clock(), "now");
    const taskId = input.taskId;

    const result = await runTransaction(async (session) => {
      const task = await readTask(session, taskId);

      // OD-27-SC: a second attempt at the same identity is only permitted with
      // writer-observed definitive abort evidence. UNKNOWN_COMMIT never
      // qualifies, and a missing event is not abort proof.
      if (input.abortEvidence) {
        const replay = assessReplayEligibility({
          operation: task.pendingOperation,
          evidence: input.abortEvidence,
        });
        if (!replay.replayable) {
          fail("REPLAY_NOT_AUTHORIZED", "same-identity replay is not authorized", {
            reason: replay.reason,
          });
        }
      }

      const clauses = [
        { taskId },
        { isOpen: true },
        { status: fromStatus },
        { eventSequenceCounter: toBigInt(operation.sequenceNumber, "operation.sequenceNumber") },
        { leaseGeneration: toBigInt(operation.leaseGeneration, "operation.leaseGeneration") },
        buildLeasePredicate({
          leaseGeneration: operation.leaseGeneration,
          leaseToken: worker.token,
          leaseOwner: worker.id,
        }),
        buildPendingOperationPredicate(operation, { state: "PREPARED" }),
      ];

      const write = await taskModel.updateOne(
        { $and: clauses },
        {
          $set: {
            ...fields,
            status: toStatus,
            "pendingOperation.state": "COMMITTED",
            "pendingOperation.settledAt": now,
            updatedAt: now,
          },
          // I-C: no counter increment at effect time. The reservation already
          // consumed the sequence.
        },
        { session },
      );
      assertMatched(write, "EFFECT", { taskId, operationId: operation.operationId });

      await insertEvent(
        session,
        buildEventDocument({
          task,
          sequenceNumber: toBigInt(task.pendingOperation.sequenceNumber, "operation.sequenceNumber"),
          leaseGeneration: task.pendingOperation.leaseGeneration,
          eventType: transition.eventType,
          actor,
          details: {
            fromStatus,
            toStatus,
            attempts: task.attempts,
            diagnosticCode,
            observedFingerprint: input.observedFingerprint ?? null,
            delta: input.delta ?? null,
          },
          fencingToken: worker.token,
          now,
        }),
      );

      // OD-30 / H1: same-transaction, insert-only history evidence. The durable
      // reservation is the source of identity, not the caller's handle.
      await insertHistory(
        session,
        buildHistoryDocument({
          task,
          operation: task.pendingOperation,
          state: "COMMITTED",
          settledAt: now,
          settlement: null,
          manualReasonCode: null,
          basis: null,
        }),
      );

      return {
        taskId,
        status: toStatus,
        operationId: operation.operationId,
        sequenceNumber: toBigInt(operation.sequenceNumber, "operation.sequenceNumber"),
        eventId: operation.eventId,
      };
    });

    emitTrace("commitOperation", {
      taskId: result.taskId,
      operationId: result.operationId,
      sequenceNumber: result.sequenceNumber,
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // W8 — abandonOperation (T_abandon): OD-27 / OD-27-SC / OD-37
  // ---------------------------------------------------------------------------
  async function abandonOperation(input = {}) {
    assertAllowlisted("abandonOperation");
    const operation = requireOperation(input.operation);
    const authorization = input.authorization;
    if (!authorization || typeof authorization !== "object") {
      fail("INVALID_ARGUMENT", "operator authorization is required", {
        field: "authorization",
      });
    }
    // OD-37: authorization must name this exact operation identity.
    if (authorization.operationId !== operation.operationId) {
      fail("AUTHORIZATION_MISMATCH", "authorization does not cover this operation", {
        authorizedOperationId: authorization.operationId ?? null,
        operationId: operation.operationId,
      });
    }
    if (
      typeof authorization.id !== "string" ||
      typeof authorization.operatorId !== "string" ||
      typeof authorization.operatorRole !== "string"
    ) {
      fail("INVALID_ARGUMENT", "authorization.id, operatorId and operatorRole are required", {
        field: "authorization",
      });
    }
    if (!APPROVAL_ROLES.includes(authorization.operatorRole)) {
      fail("AUTHORIZATION_MISMATCH", "authorization operatorRole is not authorized", {
        field: "authorization.operatorRole",
      });
    }
    const basis = authorization.basis ?? "OPERATOR_DECISION_AFTER_HOLD";
    if (!OPERATION_SETTLEMENT_BASES.includes(basis)) {
      fail("INVALID_ARGUMENT", "settlement basis is not an approved audit wording", {
        field: "authorization.basis",
      });
    }
    const manualReasonCode = input.manualReasonCode ?? "AMBIGUOUS_COMMIT";
    const actor = requireActor(input.actor, {
      id: authorization.operatorId,
      role: authorization.operatorRole,
      type: "OPERATOR",
    });
    assertOperatorActor(actor);
    // OD-37: the acting identity is the authorization identity. A caller cannot
    // attribute an abandonment to a different operator.
    if (actor.id !== authorization.operatorId) {
      fail("AUTHORIZATION_MISMATCH", "actor identity does not match the authorization", {
        field: "actor.id",
        actorId: actor.id,
        authorizedOperatorId: authorization.operatorId,
      });
    }
    if (actor.role !== authorization.operatorRole) {
      fail("AUTHORIZATION_MISMATCH", "actor role does not match the authorization", {
        field: "actor.role",
        actorRole: actor.role,
        authorizedOperatorRole: authorization.operatorRole,
      });
    }
    const now = toDate(input.now ?? clock(), "now");
    const taskId = input.taskId;
    const diagnosticCode = assertDiagnosticCode(input.diagnosticCode ?? null);

    const result = await runTransaction(async (session) => {
      const task = await readTask(session, taskId);

      const pending = task.pendingOperation;
      if (!pending) {
        fail("OPERATION_MISMATCH", "task has no pending operation", { taskId });
      }
      if (pending.operationId !== operation.operationId) {
        fail("OPERATION_MISMATCH", "pending operation identity does not match", {
          expectedOperationId: operation.operationId,
          actualOperationId: pending.operationId,
        });
      }
      if (pending.state !== "PREPARED") {
        fail("OPERATION_MISMATCH", "operation is not unresolved", {
          state: pending.state,
        });
      }
      // OD-37: only LEASED can hold a PREPARED operation conformingly.
      if (!ABANDONABLE_STATUSES.includes(task.status)) {
        fail("ABANDONMENT_NOT_PERMITTED", "source status is not abandonable", {
          status: task.status,
          allowed: [...ABANDONABLE_STATUSES],
        });
      }
      const pendingGeneration = toBigInt(pending.leaseGeneration, "pendingOperation.leaseGeneration");
      const pendingSequence = toBigInt(pending.sequenceNumber, "pendingOperation.sequenceNumber");
      if (pendingGeneration !== toBigInt(operation.leaseGeneration, "operation.leaseGeneration")) {
        fail("OPERATION_MISMATCH", "operation lease generation does not match", {
          expected: operation.leaseGeneration.toString(),
          actual: pendingGeneration.toString(),
        });
      }
      if (pendingSequence !== toBigInt(operation.sequenceNumber, "operation.sequenceNumber")) {
        fail("OPERATION_MISMATCH", "operation sequence does not match", {
          expected: operation.sequenceNumber.toString(),
          actual: pendingSequence.toString(),
        });
      }
      if (pending.eventId !== operation.eventId) {
        fail("OPERATION_MISMATCH", "operation event identity does not match", {
          expectedEventId: operation.eventId,
          actualEventId: pending.eventId,
        });
      }
      // OD-37: the original lease identity is the task document's top-level
      // `leaseGeneration` / `leaseToken` / `leaseOwner`. A transient handle
      // token, when the caller supplies one, must name that same lease.
      if (typeof task.leaseToken !== "string" || task.leaseToken.length === 0) {
        fail("OPERATION_MISMATCH", "original lease token is missing from the task", {
          field: "leaseToken",
        });
      }
      if (typeof task.leaseOwner !== "string" || task.leaseOwner.length === 0) {
        fail("OPERATION_MISMATCH", "original lease owner is missing from the task", {
          field: "leaseOwner",
        });
      }
      if (toBigInt(task.leaseGeneration, "leaseGeneration") !== pendingGeneration) {
        fail("OPERATION_MISMATCH", "task lease generation does not match the operation", {
          field: "leaseGeneration",
          taskGeneration: task.leaseGeneration.toString(),
          operationGeneration: pendingGeneration.toString(),
        });
      }
      // A missing/invalid `leaseUntil` must never be read as "expired": BSON
      // ordering can make null compare below a date. Fail closed explicitly.
      if (!(task.leaseUntil instanceof Date) || Number.isNaN(task.leaseUntil.getTime())) {
        fail("OPERATION_MISMATCH", "original lease expiry is missing or invalid", {
          field: "leaseUntil",
        });
      }
      if (operation.leaseToken !== undefined && operation.leaseToken !== task.leaseToken) {
        fail("OPERATION_MISMATCH", "operation lease token does not match the original lease", {
          field: "leaseToken",
        });
      }
      // Expiry is decided only by the server-time `$$NOW` CAS predicate below.
      // A worker-local clock pre-check is deliberately absent: skew must not
      // reject an abandonment the server would accept, and a zero-match CAS
      // remains the fail-closed abort.

      const sequenceNumber = nextSequenceNumber(task.eventSequenceCounter);
      const settlement = {
        authorizationId: authorization.id,
        operationId: operation.operationId,
        operatorId: authorization.operatorId,
        operatorRole: authorization.operatorRole,
        basis,
        at: now,
      };

      const clauses = [
        { taskId },
        { isOpen: true },
        { status: { $in: [...ABANDONABLE_STATUSES] } },
        ...buildSequencePredicate(task.eventSequenceCounter),
        buildExpiredOriginalLeasePredicate({
          leaseGeneration: task.leaseGeneration,
          leaseToken: task.leaseToken,
          leaseOwner: task.leaseOwner,
        }),
        buildPendingOperationPredicate(operation, { state: "PREPARED" }),
      ];

      const write = await taskModel.updateOne(
        { $and: clauses },
        {
          $set: {
            status: "MANUAL_REQUIRED",
            manualReasonCode,
            // OD-10 §2.4 clause 5: the abandonment escalation carries an
            // explicit escalation category; no diagnostic value is misused.
            escalation: { code: "ESC_UNKNOWN_COMMIT" },
            "pendingOperation.state": "ABANDONED",
            "pendingOperation.settledAt": now,
            "pendingOperation.settlement": settlement,
            updatedAt: now,
          },
          $inc: { eventSequenceCounter: 1n },
        },
        { session },
      );
      assertMatched(write, "ABANDON", { taskId, operationId: operation.operationId });

      await insertEvent(
        session,
        buildEventDocument({
          task,
          sequenceNumber,
          leaseGeneration: pendingGeneration,
          eventType: "RECOVERY_ESCALATED",
          actor,
          details: {
            fromStatus: task.status,
            toStatus: "MANUAL_REQUIRED",
            attempts: task.attempts,
            diagnosticCode,
          },
          fencingToken: null,
          now,
        }),
      );

      // H1-EXT: the abandonment record is written in the same transaction and
      // carries the approved audit wording, never ABORT_CONFIRMED. The durable
      // reservation is the source of identity, not the caller's handle.
      await insertHistory(
        session,
        buildHistoryDocument({
          task,
          operation: pending,
          state: "ABANDONED",
          settledAt: now,
          settlement,
          manualReasonCode,
          basis,
        }),
      );

      return {
        taskId,
        status: "MANUAL_REQUIRED",
        operationId: operation.operationId,
        sequenceNumber,
        eventId: buildEventId(taskId, sequenceNumber),
      };
    });

    emitTrace("abandonOperation", {
      taskId: result.taskId,
      operationId: result.operationId,
      sequenceNumber: result.sequenceNumber,
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // W9 / W10 / W11 / W12 — thin, fixed-transition wrappers
  // ---------------------------------------------------------------------------
  async function resolveTask(input = {}) {
    assertAllowlisted("resolveTask");
    if (
      input.fields?.resolution !== undefined &&
      input.fields.resolution !== "ALREADY_CORRECT"
    ) {
      // APPLIED and every other resolution are read-only through this path.
      fail("INVALID_ARGUMENT", "resolveTask is read-only for resolution", {
        field: "resolution",
      });
    }
    return runLifecycle("resolveTask", {
      ...input,
      transitionId: "T-RESOLVE",
      fields: { ...input.fields, resolution: "ALREADY_CORRECT" },
    });
  }

  async function closeTask(input = {}) {
    assertAllowlisted("closeTask");
    return runLifecycle("closeTask", {
      ...input,
      transitionId: "T-CLOSE",
      actor: input.actor,
      fields: { ...input.fields },
    });
  }

  async function cancelTask(input = {}) {
    assertAllowlisted("cancelTask");
    const taskId = input.taskId;
    const now = toDate(input.now ?? clock(), "now");

    // The transition is chosen from the observed status inside the transaction.
    return runTransaction(async (session) => {
      const task = await readTask(session, taskId);
      const transitionId =
        task.status === "DETECTED"
          ? "T-CANCEL-DETECTED"
          : task.status === "LEASED"
            ? "T-CANCEL-LEASED"
            : task.status === "MANUAL_REQUIRED"
              ? "T-CANCEL-MANUAL"
              : null;
      if (!transitionId) {
        fail("TRANSITION_NOT_ALLOWED", "status is not cancellable", { status: task.status });
      }
      return runLifecycle(
        "cancelTask",
        {
          ...input,
          transitionId,
          now,
          fields: { ...input.fields },
        },
        session,
      );
    });
  }

  async function recordApproval(input = {}) {
    assertAllowlisted("recordApproval");
    const actor = requireActor(input.actor, null);
    const now = toDate(input.now ?? clock(), "now");
    const approval = input.approval;
    if (!approval || typeof approval !== "object" || approval.state !== "APPROVED") {
      fail("APPROVAL_REQUIRED", "an explicit APPROVED approval record is required", {
        field: "approval",
      });
    }
    if (approval.approvedBy !== actor.id) {
      fail("APPROVAL_REQUIRED", "approver identity must match the acting operator", {
        field: "approval.approvedBy",
      });
    }
    // The writer owns the approval timestamp when the caller omits it. This one
    // normalized object is what validation and persistence both use; caller
    // `fields` are discarded so flat audit fields cannot contradict it.
    const canonical = {
      ...approval,
      approvedAt: approval.approvedAt ?? now,
    };
    return runLifecycle("recordApproval", {
      ...input,
      transitionId: "T-APPROVE",
      actor,
      now,
      approval: canonical,
      fields: undefined,
    });
  }

  async function recordRejection(input = {}) {
    assertAllowlisted("recordRejection");
    const actor = requireActor(input.actor, null);
    const now = toDate(input.now ?? clock(), "now");
    const approval = input.approval;
    if (!approval || typeof approval !== "object" || approval.state !== "REJECTED") {
      fail("APPROVAL_REQUIRED", "an explicit REJECTED approval record is required", {
        field: "approval",
      });
    }
    if (approval.approvedBy !== actor.id) {
      fail("APPROVAL_REQUIRED", "deciding operator identity must match the acting operator", {
        field: "approval.approvedBy",
      });
    }
    // The writer owns the decision timestamp when the caller omits it. Caller
    // `fields` are discarded so flat audit fields cannot contradict the record.
    const canonical = {
      ...approval,
      approvedAt: approval.approvedAt ?? now,
    };
    return runLifecycle("recordRejection", {
      ...input,
      transitionId: "T-REJECT",
      actor,
      now,
      approval: canonical,
      fields: undefined,
    });
  }

  async function escalateTask(input = {}) {
    assertAllowlisted("escalateTask");
    const reasonCode = input.manualReasonCode ?? "ATTEMPTS_EXHAUSTED";
    return runLifecycle("escalateTask", {
      ...input,
      transitionId: "T-EXHAUST",
      fields: {
        manualReasonCode: reasonCode,
        escalation: input.escalation ?? { code: "ESC_EXHAUSTED" },
      },
      diagnosticCode: input.diagnosticCode ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // W4 / W13 / W14
  // ---------------------------------------------------------------------------
  async function releaseLease() {
    // W4's target status is not specified by the approved register (§12.3 only
    // says "$unset lease fields + event"). Refusing is safer than inventing a
    // transition; see the Package 2 report.
    assertAllowlisted("releaseLease");
    return fail(
      "ENTRY_POINT_NOT_IMPLEMENTED",
      "W4 releaseLease has no approved target status; implement only after a design decision",
      { entryPoint: "releaseLease" },
    );
  }

  async function archiveClosedTasks() {
    assertAllowlisted("archiveClosedTasks");
    return fail("ENTRY_POINT_NOT_IMPLEMENTED", DEFERRED_ENTRY_POINTS.archiveClosedTasks, {
      entryPoint: "archiveClosedTasks",
    });
  }

  async function repairTask() {
    assertAllowlisted("repairTask");
    return fail("ENTRY_POINT_NOT_IMPLEMENTED", DEFERRED_ENTRY_POINTS.repairTask, {
      entryPoint: "repairTask",
    });
  }

  const writer = {
    createTaskFromFinding,
    claimLease,
    renewLease,
    releaseLease,
    applyTransition,
    reserveOperation,
    commitOperation,
    abandonOperation,
    resolveTask,
    closeTask,
    cancelTask,
    recordApproval,
    recordRejection,
    escalateTask,
    archiveClosedTasks,
    repairTask,
  };

  // Runtime guard: the writer surface must equal the allowlist.
  const exposed = Object.keys(writer);
  const unexpected = exposed.filter((name) => !WRITER_ALLOWLIST.includes(name));
  if (unexpected.length > 0) {
    fail("ENTRY_POINT_NOT_ALLOWED", "writer exposes a non-allowlisted entry point", {
      entryPoints: unexpected,
    });
  }

  return Object.freeze(writer);
}
