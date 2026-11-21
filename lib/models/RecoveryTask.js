import mongoose from "mongoose";

import {
  TASK_ID_PATTERN,
  TASK_KEY_PATTERN,
  EVENT_ID_PATTERN,
  OPERATION_HISTORY_ID_PATTERN,
} from "../recovery/identity.js";

// WP04-06 — Recovery task contract metadata (AUTHORED, NOT DEPLOYED).
//
// Contract source: docs/production-readiness/wp-04-06-design-consolidation-and-register.md
// §2.1 and §3. IMPORTANT PROVENANCE: the only recorded OD-10-scope owner
// approval is the WP04-05 *disposable replica-set proof* scope. No production
// schema/index signature is recorded in this repository; register §1/§10.5
// therefore keeps production schema/index authorization PENDING. This file is
// authored schema metadata only — it is not a signed production contract and it
// does not deploy a collection or index.
//
// This file declares schema metadata only. It does not create collections,
// deploy indexes, open a connection, write documents, or implement the canonical
// writer (`lib/recovery/taskWriter.js`). `autoIndex: false` is intentional and
// every index below is undeployed metadata.
//
// H1 operation-history contract:
//   * The task-document CAS (positive unresolved-operation predicate plus
//     `U_claim` on claims) is the operation fence (OD-30 / T9-ACQ).
//   * A separate `inventory_recovery_operation_history` record is append-only
//     audit evidence, inserted in the same transaction as `T_effect` or
//     `T_abandon`. It is never the uniqueness fence.
//   * OD-27-SC: `UNKNOWN_COMMIT` is observed-only. There is no persisted
//     `UNKNOWN_COMMIT` operation state; the operation remains `PREPARED` and is
//     never replayed. Same-identity replay is permitted only after a
//     writer-observed definitive abort.
//   * OD-37: `ABANDONABLE_STATUSES = {LEASED}` only.

export const TASK_STATUSES = Object.freeze([
  "DETECTED",
  "LEASED",
  "RETRY_SCHEDULED",
  "MANUAL_REQUIRED",
  "RESOLVED",
  "CLOSED",
  "CANCELLED",
]);

export const CLASSIFICATIONS = Object.freeze(["ALERT", "INFO", "DEFECT"]);

export const SEVERITIES = Object.freeze(["CRITICAL", "HIGH", "MEDIUM", "INFO"]);

export const CONFIDENCES = Object.freeze(["HIGH", "MEDIUM", "LOW"]);

export const EVIDENCE_LEVELS = Object.freeze(["E0", "E1", "E2", "E3"]);

export const RULE_IDS = Object.freeze([
  "D01",
  "D02",
  "D03",
  "D04",
  "D05",
  "D06",
  "D07",
  "D08",
  "D09",
  "D10",
]);

export const MANUAL_REASON_CODES = Object.freeze([
  "POLICY_MANUAL_RULE",
  "EVIDENCE_DRIFT",
  "ATTEMPTS_EXHAUSTED",
  "PERSISTENCE_TIMEOUT",
  "AMBIGUOUS_COMMIT",
]);

export const ESCALATION_CODES = Object.freeze([
  "ESC_UNKNOWN_COMMIT",
  "ESC_EVIDENCE_DRIFT",
  "ESC_EXHAUSTED",
  "ESC_MANUAL_RULE",
]);

export const APPROVAL_STATES = Object.freeze(["PENDING", "APPROVED", "REJECTED"]);

export const APPROVAL_ROLES = Object.freeze([
  "ROLE-TECHNICAL-LEAD",
  "ROLE-DATA-OWNER",
  "ROLE-INVENTORY-MANAGER",
  "ROLE-RECOVERY-EXECUTOR",
]);

export const RESOLUTIONS = Object.freeze(["ALREADY_CORRECT", "ESCALATED", "CANCELLED"]);

export const LAST_ERROR_CODES = Object.freeze([
  "EVIDENCE_DRIFT",
  "TIMEOUT",
  "CONFLICT",
  "SEQUENCE_OVERFLOW",
]);

export const OPERATION_STATES = Object.freeze(["PREPARED", "COMMITTED", "ABANDONED"]);

export const TERMINAL_OP_STATES = Object.freeze(["COMMITTED", "ABANDONED"]);

// OD-37: only LEASED can hold a PREPARED operation conformingly.
export const ABANDONABLE_STATUSES = Object.freeze(["LEASED"]);

// The positive unresolved-operation predicate guard used by claims is
// `$or: [{ pendingOperation: null }, { "pendingOperation.state": { $in: TERMINAL_OP_STATES } }]`.
// The predicates are documented here as metadata; the canonical writer
// (`lib/recovery/taskWriter.js`) is the only implementation of the write path.
export const OPERATION_SETTLEMENT_BASES = Object.freeze(["OPERATOR_DECISION_AFTER_HOLD"]);

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateBoundedText(value) {
  return (
    typeof value === "string" &&
    value.length <= 64
  );
}

function validateBoundedLineIdentifier(value) {
  if (typeof value === "string") return value.length <= 64;
  if (typeof value === "number") return Number.isSafeInteger(value);
  return false;
}

function validateFiniteQuantity(value) {
  if (value === null || value === undefined) return true;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

const ApprovalSchema = new mongoose.Schema(
  {
    state: {
      type: String,
      enum: [null, ...APPROVAL_STATES],
      default: null,
    },
    approvedBy: { type: String, default: null, maxlength: 128 },
    approvedAt: { type: Date, default: null },
    operatorRole: {
      type: String,
      enum: [null, ...APPROVAL_ROLES],
      default: null,
    },
    notes: { type: String, default: null, maxlength: 256 },
  },
  { _id: false, strict: true },
);

const EscalationSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      enum: [null, ...ESCALATION_CODES],
      default: null,
    },
    expectedStatus: { type: String, default: null },
    actualStatus: { type: String, default: null },
    expectedQuantity: {
      type: Number,
      default: null,
      validate: {
        validator: validateFiniteQuantity,
        message: "expectedQuantity must be a finite number between 0 and 1000000",
      },
    },
    actualQuantity: {
      type: Number,
      default: null,
      validate: {
        validator: validateFiniteQuantity,
        message: "actualQuantity must be a finite number between 0 and 1000000",
      },
    },
  },
  { _id: false, strict: true },
);

const SettlementSchema = new mongoose.Schema(
  {
    authorizationId: { type: String, required: true, maxlength: 128 },
    operationId: { type: String, required: true },
    operatorId: { type: String, required: true, maxlength: 128 },
    operatorRole: {
      type: String,
      required: true,
      enum: APPROVAL_ROLES,
    },
    basis: {
      type: String,
      required: true,
      enum: OPERATION_SETTLEMENT_BASES,
    },
    at: { type: Date, required: true },
  },
  { _id: false, strict: true },
);

const PendingOperationSchema = new mongoose.Schema(
  {
    operationId: { type: String, required: true },
    // PREPARED ∪ TERMINAL_OP_STATES. UNKNOWN_COMMIT is never persisted here;
    // it is an observed outcome while the operation remains PREPARED (OD-31).
    state: {
      type: String,
      required: true,
      enum: OPERATION_STATES,
    },
    leaseGeneration: {
      type: mongoose.Schema.Types.BigInt,
      required: true,
      min: 0,
      max: 1_000_000,
    },
    sequenceNumber: {
      type: mongoose.Schema.Types.BigInt,
      required: true,
      min: 1,
      max: 1_000_000,
    },
    eventId: {
      type: String,
      required: true,
      match: EVENT_ID_PATTERN,
    },
    reservedAt: { type: Date, required: true },
    reservedBy: { type: String, required: true, maxlength: 128 },
    intentDigest: {
      type: String,
      required: true,
      match: FINGERPRINT_PATTERN,
    },
    settledAt: { type: Date, default: null },
    settlement: { type: SettlementSchema, default: null },
  },
  { _id: false, strict: true },
);

const RecoveryTaskSchema = new mongoose.Schema(
  {
    // --- Immutable identity ---
    taskId: {
      type: String,
      required: true,
      immutable: true,
      match: TASK_ID_PATTERN,
    },
    taskKey: {
      type: String,
      required: true,
      immutable: true,
      match: TASK_KEY_PATTERN,
    },
    findingIdentityKey: {
      type: String,
      required: true,
      immutable: true,
      match: TASK_ID_PATTERN,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    orderNumber: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      immutable: true,
      validate: {
        validator(value) {
          if (value === null) return true;
          if (typeof value === "string" || typeof value === "number") {
            return String(value).length <= 64;
          }
          return false;
        },
        message: "orderNumber must be a String/Number of at most 64 characters, or null",
      },
    },
    reservationId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      immutable: true,
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      immutable: true,
    },
    lineId: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      immutable: true,
      validate: {
        validator(value) {
          if (value === null) return true;
          return validateBoundedLineIdentifier(value);
        },
        message: "lineId must be a String/Int of at most 64 characters, or null",
      },
    },

    // --- Classification (frozen D01–D10 vocabulary) ---
    rule: {
      type: String,
      required: true,
      immutable: true,
      enum: RULE_IDS,
    },
    code: { type: String, required: true, immutable: true },
    classification: {
      type: String,
      required: true,
      immutable: true,
      enum: CLASSIFICATIONS,
    },
    severity: {
      type: String,
      required: true,
      enum: SEVERITIES,
    },
    confidence: {
      type: String,
      required: true,
      enum: CONFIDENCES,
    },
    evidenceLevel: {
      type: String,
      required: true,
      enum: EVIDENCE_LEVELS,
    },
    findingCodeOnly: { type: Boolean, default: false },
    // OD-10 §2.4 clause 6: Boolean|null, default null. The canonical writer
    // rejects any other representation before a document is inserted.
    durableClass: { type: Boolean, default: null },

    // --- Fingerprints and versioning ---
    fingerprintSchema: { type: String, default: "wp04-fingerprint-v1" },
    evidenceSchema: { type: String, default: "wp04-evidence-v1" },
    initialFingerprint: {
      type: String,
      required: true,
      immutable: true,
      match: FINGERPRINT_PATTERN,
    },
    currentFingerprint: {
      type: String,
      required: true,
      match: FINGERPRINT_PATTERN,
    },

    // --- Lifecycle, lease and sequence counter ---
    status: {
      type: String,
      required: true,
      enum: TASK_STATUSES,
      default: "DETECTED",
    },
    isOpen: { type: Boolean, required: true, default: true },
    leaseOwner: { type: String, default: null, maxlength: 128 },
    leaseToken: {
      type: String,
      default: null,
      match: UUID_V4_PATTERN,
    },
    leaseUntil: { type: Date, default: null },
    leaseGeneration: {
      type: mongoose.Schema.Types.BigInt,
      required: true,
      default: 0n,
      min: 0,
      max: 1_000_000,
    },
    eventSequenceCounter: {
      type: mongoose.Schema.Types.BigInt,
      required: true,
      default: 0n,
      min: 0,
      max: 1_000_000,
    },
    attempts: { type: Number, required: true, default: 0, min: 0, max: 100 },
    // Provisional test value per register §6 (OD-09). Not a production numeric.
    maxAttempts: { type: Number, required: true, default: 5, min: 1, immutable: true },
    nextAttemptAt: { type: Date, default: null },

    // --- Escalation and review ---
    manualReasonCode: {
      type: String,
      enum: [null, ...MANUAL_REASON_CODES],
      default: null,
    },
    escalation: { type: EscalationSchema, default: null },

    // Nested approval metadata plus the flat separation-of-duties audit fields
    // are both retained by the authored WP04-06 metadata. Production OD-10
    // schema/index authorization remains PENDING; the only recorded OD-10-scope
    // owner approval is the WP04-05 disposable replica-set proof.
    approval: { type: ApprovalSchema, default: null },
    approvedBy: { type: String, default: null, maxlength: 128 },
    approvedAt: { type: Date, default: null },
    executedBy: { type: String, default: null, maxlength: 128 },
    executedAt: { type: Date, default: null },
    verifierId: { type: String, default: null, maxlength: 128 },
    verifiedAt: { type: Date, default: null },

    // --- Resolution ---
    resolution: {
      type: String,
      enum: [null, ...RESOLUTIONS],
      default: null,
    },
    lastErrorCode: {
      type: String,
      enum: [null, ...LAST_ERROR_CODES],
      default: null,
    },
    lastErrorField: {
      type: String,
      default: null,
      maxlength: 64,
      validate: {
        validator(value) {
          if (value === null || value === undefined) return true;
          return validateBoundedText(value);
        },
        message: "lastErrorField must be at most 64 characters",
      },
    },
    priorTaskId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      immutable: true,
    },

    // --- O2/H1 durable operation reservation ---
    pendingOperation: { type: PendingOperationSchema, default: null },

    // --- Timestamps ---
    createdAt: { type: Date, required: true, default: Date.now, immutable: true },
    updatedAt: { type: Date, required: true, default: Date.now },
    closedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  {
    collection: "inventory_recovery_tasks",
    autoIndex: false,
    timestamps: false,
    strict: true,
  },
);

// Index declarations are schema metadata only. Deployment is a separate,
// gated operation (OD-10 signature, G-IDX-1, guarded deploy script, DBA window).
RecoveryTaskSchema.index({ taskId: 1 }, { unique: true, name: "IDX-TSK-01" });
RecoveryTaskSchema.index(
  { findingIdentityKey: 1 },
  { unique: true, partialFilterExpression: { isOpen: true }, name: "IDX-TSK-02" },
);
RecoveryTaskSchema.index({ orderId: 1, isOpen: 1 }, { name: "IDX-TSK-03" });
RecoveryTaskSchema.index(
  { status: 1, isOpen: 1, nextAttemptAt: 1, leaseUntil: 1 },
  { name: "IDX-TSK-04" },
);
RecoveryTaskSchema.index(
  { leaseOwner: 1, leaseUntil: 1, leaseGeneration: 1 },
  { partialFilterExpression: { isOpen: true }, name: "IDX-TSK-05" },
);
RecoveryTaskSchema.index(
  { status: 1, severity: 1, createdAt: 1 },
  { partialFilterExpression: { status: "MANUAL_REQUIRED" }, name: "IDX-TSK-06" },
);

// -----------------------------------------------------------------------------
// H1 operation history (OD-24 / OD-30 / OD-33 / H1-EXT)
// -----------------------------------------------------------------------------

const RecoveryOperationHistorySchema = new mongoose.Schema(
  {
    // Deterministic record id: OPH:<taskId>:<operationId>.
    historyId: {
      type: String,
      required: true,
      immutable: true,
      match: OPERATION_HISTORY_ID_PATTERN,
    },
    taskId: {
      type: String,
      required: true,
      immutable: true,
      match: TASK_ID_PATTERN,
    },
    operationId: {
      type: String,
      required: true,
      immutable: true,
    },
    // Terminal operation state only. A PREPARED operation has no history row.
    state: {
      type: String,
      required: true,
      immutable: true,
      enum: TERMINAL_OP_STATES,
    },
    leaseGeneration: {
      type: mongoose.Schema.Types.BigInt,
      required: true,
      immutable: true,
      min: 0,
      max: 1_000_000,
    },
    sequenceNumber: {
      type: mongoose.Schema.Types.BigInt,
      required: true,
      immutable: true,
      min: 1,
      max: 1_000_000,
    },
    eventId: {
      type: String,
      required: true,
      immutable: true,
      match: EVENT_ID_PATTERN,
    },
    reservedAt: { type: Date, required: true, immutable: true },
    reservedBy: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 128,
    },
    // Completion timestamp for the terminal effect or abandonment.
    settledAt: { type: Date, required: true, immutable: true },
    intentDigest: {
      type: String,
      required: true,
      immutable: true,
      match: FINGERPRINT_PATTERN,
    },
    settlement: { type: SettlementSchema, default: null, immutable: true },
    manualReasonCode: {
      type: String,
      enum: [null, ...MANUAL_REASON_CODES],
      default: null,
      immutable: true,
    },
    // Abandonment audit wording is always OPERATOR_DECISION_AFTER_HOLD,
    // never ABORT_CONFIRMED.
    basis: {
      type: String,
      enum: [null, ...OPERATION_SETTLEMENT_BASES],
      default: null,
      immutable: true,
    },
  },
  {
    collection: "inventory_recovery_operation_history",
    autoIndex: false,
    timestamps: false,
    strict: true,
  },
);

// Full unique index (no partial filter): under OD-25(a) every operationId is
// unique per task across all lease generations. Insert-only; never upsert.
// This is record identity/retry idempotency only; the task-document CAS remains
// the operation fence (OD-30).
RecoveryOperationHistorySchema.index({ taskId: 1, operationId: 1 }, { unique: true });

export function getRecoveryTaskModel(connection) {
  return (
    connection.models.RecoveryTask ||
    connection.model("RecoveryTask", RecoveryTaskSchema, "inventory_recovery_tasks")
  );
}

export function getRecoveryOperationHistoryModel(connection) {
  return (
    connection.models.RecoveryOperationHistory ||
    connection.model(
      "RecoveryOperationHistory",
      RecoveryOperationHistorySchema,
      "inventory_recovery_operation_history",
    )
  );
}

export {
  RecoveryTaskSchema,
  PendingOperationSchema,
  ApprovalSchema,
  EscalationSchema,
  SettlementSchema,
  RecoveryOperationHistorySchema,
};
