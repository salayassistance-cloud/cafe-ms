// WP04-06 — Read-only reconciliation for H1 operation history and evidence
// linkage.
//
// Contract sources:
//   * docs/production-readiness/wp-04-06-design-consolidation-and-register.md
//     §3 (OD-30 / OD-33), §8.1-§8.2
//   * docs/production-readiness/wp-04-06-design-discovery-report.md §13.5,
//     §16, §17, §22.3.5, §22.6
//
// This module is deliberately read-only: it calls `findOne` only. It never
// inserts, modifies, or removes a document, and it never deploys an index. It
// does not import the recovery models, so the audit path cannot acquire a write
// capability by accident (OD-34 / §12.5 A1).
//
// It exists for three approved needs:
//   1. OD-33 — after a duplicate-key error on the H1 history unique key,
//      reconcile the existing record read-only. Identical -> adopt without a
//      write. Divergent or contradictory -> stop and escalate. An existing row
//      is never overwritten.
//   2. OD-32 — snapshot/fingerprint linkage and explicit orphan-evidence
//      handling. An orphan snapshot requires `MANUAL_REQUIRED`.
//   3. OD-27-SC — replay eligibility from persisted operation state and
//      writer-observed abort evidence. `UNKNOWN_COMMIT` is never replay proof.
//
// The operation-state and non-proof vocabularies mirror the writer contract.
// They are duplicated on purpose so this auditor does not inherit writer
// assumptions; `tests/wp04-06-writer-boundary.test.mjs` asserts they agree.

export const TERMINAL_OPERATION_STATES = Object.freeze(["COMMITTED", "ABANDONED"]);

// Fields that must never differ between a retried insert and the existing row.
export const HISTORY_IMMUTABLE_FIELDS = Object.freeze([
  "taskId",
  "operationId",
  "state",
  "leaseGeneration",
  "sequenceNumber",
  "eventId",
  "reservedAt",
  "reservedBy",
  "settledAt",
  "intentDigest",
  "manualReasonCode",
  "basis",
]);

export const HISTORY_RECONCILIATION_CLASSIFICATIONS = Object.freeze([
  "IDENTICAL_ADOPT",
  "DIVERGENT",
  "CONTRADICTORY",
  "ABSENT",
]);

export const RECONCILIATION_ACTIONS = Object.freeze([
  "ADOPT_EXISTING",
  "STOP_AND_ESCALATE",
  "RETRY_SAME_IDENTITY",
  "PROCEED",
  "HOLD",
  "ESCALATE_MANUAL_REQUIRED",
]);

// OD-32: an orphaned evidence snapshot is a manual-review state.
export const ORPHAN_EVIDENCE_STATUS = "MANUAL_REQUIRED";

export const EVIDENCE_LINKAGE_STATES = Object.freeze([
  "LINKED",
  "DRIFT",
  "ORPHAN",
  "INDETERMINATE",
]);

export const NON_PROOF_OUTCOMES = Object.freeze([
  "UNKNOWN_COMMIT",
  "MISSING_EVENT",
  "NULL_READ",
  "LEASE_EXPIRED",
  "SESSION_CLOSED",
  "ELAPSED_TIME",
  "V1_EVIDENCE",
  "KILL_SESSIONS",
  "SECONDARY_READ",
]);

export const DEFINITIVE_ABORT_EVIDENCE = Object.freeze([
  "WRITE_CONFLICT_ROLLBACK",
  "TRANSACTION_ABORTED",
]);

function normalizeComparable(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (typeof value === "bigint") return `int:${value.toString()}`;
  if (typeof value === "number") return `int:${String(value)}`;
  if (typeof value === "object") {
    if (typeof value.toHexString === "function") return `oid:${value.toHexString()}`;
    if (typeof value.$oid === "string") return `oid:${value.$oid.toLowerCase()}`;
    const keys = Object.keys(value).sort();
    return `obj:${keys.map((key) => `${key}=${normalizeComparable(value[key])}`).join(",")}`;
  }
  return `str:${String(value)}`;
}

/**
 * Compare a retried history insert with the durable row. Read-only.
 */
export function compareHistoryRecords(expected, existing) {
  if (!expected || typeof expected !== "object") {
    throw new TypeError("expected history record is required");
  }
  if (!existing || typeof existing !== "object") {
    return { identical: false, mismatchedFields: [...HISTORY_IMMUTABLE_FIELDS] };
  }

  const mismatchedFields = HISTORY_IMMUTABLE_FIELDS.filter(
    (field) => normalizeComparable(expected[field]) !== normalizeComparable(existing[field]),
  );

  // `settlement` is immutable metadata but is absent on a committed effect.
  const expectedSettlement = normalizeComparable(expected.settlement);
  const existingSettlement = normalizeComparable(existing.settlement);
  if (expectedSettlement !== existingSettlement) {
    mismatchedFields.push("settlement");
  }

  return { identical: mismatchedFields.length === 0, mismatchedFields };
}

/**
 * Classify a duplicate-key outcome for the H1 history unique key.
 *
 * @param {{expected: object, existing: object|null, task?: object|null}} input
 */
export function classifyHistoryDuplicate({ expected, existing, task = null }) {
  const operationId = expected?.operationId ?? null;
  const taskOperationId = task?.pendingOperation?.operationId ?? null;

  if (existing && taskOperationId && operationId && taskOperationId !== operationId) {
    return {
      classification: "CONTRADICTORY",
      action: "STOP_AND_ESCALATE",
      adoptable: false,
      requiresEscalation: true,
      mismatchedFields: [],
      reason: "TASK_SHOWS_A_DIFFERENT_OPERATION",
    };
  }

  if (!existing) {
    const reservationIntact =
      task?.pendingOperation?.operationId === operationId &&
      task?.pendingOperation?.state === "PREPARED";
    return {
      classification: "ABSENT",
      action: reservationIntact ? "RETRY_SAME_IDENTITY" : "STOP_AND_ESCALATE",
      adoptable: false,
      requiresEscalation: !reservationIntact,
      mismatchedFields: [],
      reason: reservationIntact
        ? "HISTORY_ROW_ABSENT_RESERVATION_INTACT"
        : "HISTORY_ROW_ABSENT_RESERVATION_CHANGED",
    };
  }

  const comparison = compareHistoryRecords(expected, existing);
  if (comparison.identical) {
    return {
      classification: "IDENTICAL_ADOPT",
      action: "ADOPT_EXISTING",
      adoptable: true,
      requiresEscalation: false,
      mismatchedFields: [],
      reason: "IMMUTABLE_FIELDS_MATCH",
    };
  }

  return {
    classification: "DIVERGENT",
    action: "STOP_AND_ESCALATE",
    adoptable: false,
    requiresEscalation: true,
    mismatchedFields: comparison.mismatchedFields,
    reason: "IMMUTABLE_FIELD_MISMATCH",
  };
}

/**
 * Read-only duplicate-key reconciliation. Two `findOne` calls, no writes.
 *
 * @param {object} input
 * @param {object} input.historyModel Model/collection with `findOne`.
 * @param {object} [input.taskModel] Model/collection with `findOne`.
 * @param {object} input.expected Expected history record.
 * @param {string} input.taskId
 * @param {string} input.operationId
 * @param {object} [input.session] Optional session (read-only use).
 */
export async function reconcileDuplicateHistory({
  historyModel,
  taskModel = null,
  expected,
  taskId,
  operationId,
  session = null,
}) {
  const readOptions = {
    readConcern: { level: "majority" },
    ...(session ? { session } : {}),
  };

  const existing = await historyModel.findOne(
    { taskId, operationId },
    readOptions,
  );

  const task = taskModel
    ? await taskModel.findOne({ taskId }, readOptions)
    : null;

  const result = classifyHistoryDuplicate({ expected, existing, task });

  return {
    ...result,
    historyId: existing?.historyId ?? expected?.historyId ?? null,
    taskId,
    operationId,
    taskOperationState: task?.pendingOperation?.state ?? null,
    readOnly: true,
  };
}

/**
 * OD-32 — snapshot/fingerprint linkage and orphan-evidence classification.
 *
 * @param {object} input
 * @param {object|null} input.task Recovery task document.
 * @param {object|null} input.snapshot Captured evidence snapshot, if any.
 */
export function assessEvidenceLinkage({ task, snapshot } = {}) {
  if (!task) {
    return {
      state: "INDETERMINATE",
      action: "HOLD",
      requiredStatus: null,
      orderMatch: false,
      fingerprintMatch: false,
      reason: "TASK_NOT_FOUND",
    };
  }

  if (!snapshot) {
    return {
      state: "INDETERMINATE",
      action: "HOLD",
      requiredStatus: null,
      orderMatch: false,
      fingerprintMatch: false,
      reason: "NO_SNAPSHOT",
    };
  }

  if (snapshot.sourcePresent === false) {
    return {
      state: "ORPHAN",
      action: "ESCALATE_MANUAL_REQUIRED",
      requiredStatus: ORPHAN_EVIDENCE_STATUS,
      orderMatch: false,
      fingerprintMatch: false,
      reason: "SOURCE_ORDER_ABSENT",
    };
  }

  const orderMatch =
    normalizeComparable(task.orderId) === normalizeComparable(snapshot.orderId);
  if (!orderMatch) {
    return {
      state: "ORPHAN",
      action: "ESCALATE_MANUAL_REQUIRED",
      requiredStatus: ORPHAN_EVIDENCE_STATUS,
      orderMatch: false,
      fingerprintMatch: false,
      reason: "SNAPSHOT_ORDER_MISMATCH",
    };
  }

  const fingerprintMatch =
    typeof snapshot.fingerprint === "string" &&
    snapshot.fingerprint === task.currentFingerprint;

  if (!fingerprintMatch) {
    return {
      state: "DRIFT",
      action: "ESCALATE_MANUAL_REQUIRED",
      requiredStatus: ORPHAN_EVIDENCE_STATUS,
      orderMatch: true,
      fingerprintMatch: false,
      eventType: "RECOVERY_EVIDENCE_DRIFT",
      reason: "FINGERPRINT_DRIFT",
    };
  }

  return {
    state: "LINKED",
    action: "PROCEED",
    requiredStatus: null,
    orderMatch: true,
    fingerprintMatch: true,
    reason: "SNAPSHOT_LINKED",
  };
}

/**
 * Read-only operation-state assessment. A `PREPARED` operation is unresolved,
 * whether or not the effect outcome was observed as `UNKNOWN_COMMIT`.
 */
export function assessOperationState(task) {
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
  if (TERMINAL_OPERATION_STATES.includes(operation.state)) {
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
 * OD-27-SC — replay eligibility. Only a writer-observed definitive abort of the
 * same operation permits a same-identity replay.
 */
export function evaluateReplayEligibility({ operation, evidence } = {}) {
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
