import mongoose from "mongoose";

import {
  TASK_ID_PATTERN,
  EVENT_ID_PATTERN,
} from "../recovery/identity.js";
import {
  RecoveryOperationHistorySchema,
  getRecoveryOperationHistoryModel,
} from "./RecoveryTask.js";

// WP04-06 — Recovery event and H1 operation-history contract metadata
// (AUTHORED, NOT DEPLOYED).
//
// Contract source: docs/production-readiness/wp-04-06-design-consolidation-and-register.md
// §2.1, §2.2, and §3. IMPORTANT PROVENANCE: the only recorded OD-10-scope owner
// approval is the WP04-05 *disposable replica-set proof* scope. No production
// schema/index signature is recorded in this repository; register §1/§10.5
// therefore keeps production schema/index authorization PENDING. This file is
// authored metadata only — it is not a signed production contract and it does
// not deploy a collection or index.
//
// Both collections are append-only audit evidence. This file declares schema
// metadata only: it does not create collections, deploy indexes, open a
// connection, or implement transaction writers.
//
// OD-30 / H1: a history record is appended inside the same transaction/session
// as `T_effect` (state COMMITTED) or `T_abandon` (state ABANDONED). The task
// document CAS is the fence; the history record is never the uniqueness fence.

export const EVENT_TYPES = Object.freeze([
  "RECOVERY_DETECTED",
  "RECOVERY_LEASED",
  "RECOVERY_RENEWED",
  "RECOVERY_RETRY_SCHEDULED",
  "RECOVERY_ESCALATED",
  "RECOVERY_REJECTED",
  "RECOVERY_APPROVED",
  "RECOVERY_RESOLVED",
  "RECOVERY_VERIFIED",
  "RECOVERY_CLOSED",
  "RECOVERY_CANCELLED",
  "RECOVERY_EVIDENCE_DRIFT",
]);

// `ROLE-RECOVERY-EXECUTOR` is retained in the actor union per OD-10.
export const ACTOR_ROLES = Object.freeze([
  "ROLE-TECHNICAL-LEAD",
  "ROLE-DATA-OWNER",
  "ROLE-INVENTORY-MANAGER",
  "ROLE-RECOVERY-EXECUTOR",
  "SERVICE-WORKER",
]);

export const ACTOR_TYPES = Object.freeze(["WORKER", "OPERATOR", "SCANNER", "VERIFIER"]);

// WP04-04 bounded diagnostics plus the R3 documented technical diagnostic
// values. OD-10 §2.4 clause 5 / OD-29: escalation categories live in
// `ESCALATION_CODES` (`RecoveryTask.js`) and MUST NOT appear here; the two
// enums are disjoint.
export const BASE_DIAGNOSTIC_CODES = Object.freeze([
  "DOC_CORRUPT",
  "INDEX_ABSENT",
  "TIMEOUT",
  "LEASE_EXPIRED",
  "DRIFT_DETECTED",
  "PERSISTENCE_TIMEOUT",
  "CONFLICT",
  "DRIFT",
  "RETRY",
]);

export const DIAGNOSTIC_CODES = Object.freeze([...BASE_DIAGNOSTIC_CODES]);

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SENSITIVE_KEY_PATTERN =
  /pin|password|passwd|secret|token|authorization|cookie|sessionid|apikey|connectionstring|mongodburi|accountnumber|credential/i;

function validateProjectedEvidence(value) {
  if (!value || typeof value !== "object") return true;

  function check(object) {
    for (const [key, nested] of Object.entries(object)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) return false;
      if (nested && typeof nested === "object" && !check(nested)) return false;
    }
    return true;
  }

  return check(value);
}

function validateFiniteQuantity(value) {
  if (value === null || value === undefined) return true;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

const DeltaSchema = new mongoose.Schema(
  {
    consumedDelta: {
      type: Number,
      default: null,
      validate: {
        validator: validateFiniteQuantity,
        message: "consumedDelta must be a finite number between 0 and 1000000",
      },
    },
    reservedDelta: {
      type: Number,
      default: null,
      validate: {
        validator: validateFiniteQuantity,
        message: "reservedDelta must be a finite number between 0 and 1000000",
      },
    },
  },
  { _id: false, strict: true },
);

const EventDetailsSchema = new mongoose.Schema(
  {
    fromStatus: { type: String, default: null },
    toStatus: { type: String, required: true },
    attempts: { type: Number, required: true, min: 0, max: 100 },
    diagnosticCode: {
      type: String,
      enum: [null, ...DIAGNOSTIC_CODES],
      default: null,
    },
    observedFingerprint: {
      type: String,
      default: null,
      match: FINGERPRINT_PATTERN,
    },
    leaseDurationMs: { type: Number, default: null, min: 1 },
    delta: { type: DeltaSchema, default: null },
  },
  { _id: false, strict: true },
);

const RecoveryEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      immutable: true,
      match: EVENT_ID_PATTERN,
    },
    taskId: {
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
    sequenceNumber: {
      type: mongoose.Schema.Types.BigInt,
      required: true,
      immutable: true,
      min: 1,
      max: 1_000_000,
    },
    leaseGeneration: {
      type: mongoose.Schema.Types.BigInt,
      required: true,
      immutable: true,
      min: 0,
      max: 1_000_000,
    },
    timestamp: { type: Date, required: true, default: Date.now, immutable: true },

    eventType: {
      type: String,
      required: true,
      immutable: true,
      enum: EVENT_TYPES,
    },

    actorId: { type: String, required: true, immutable: true, maxlength: 128 },
    actorRole: {
      type: String,
      required: true,
      immutable: true,
      enum: ACTOR_ROLES,
    },
    actorType: {
      type: String,
      required: true,
      immutable: true,
      enum: ACTOR_TYPES,
    },
    fencingToken: {
      type: String,
      default: null,
      immutable: true,
      match: UUID_V4_PATTERN,
    },

    fingerprintVersion: { type: String, default: "wp04-fingerprint-v1", immutable: true },
    evidenceSchemaVersion: { type: String, default: "wp04-evidence-v1", immutable: true },
    evidenceDigest: {
      type: String,
      required: true,
      immutable: true,
      match: FINGERPRINT_PATTERN,
    },
    projectedEvidence: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      immutable: true,
      validate: {
        validator: validateProjectedEvidence,
        message: "projectedEvidence contains forbidden sensitive keys",
      },
    },

    details: { type: EventDetailsSchema, required: true },
  },
  {
    collection: "inventory_recovery_events",
    autoIndex: false,
    timestamps: false,
    strict: true,
  },
);

// Index declarations are schema metadata only. Deployment is a separate,
// gated operation; no index is created by this module.
RecoveryEventSchema.index({ eventId: 1 }, { unique: true, name: "IDX-EVT-01" });
RecoveryEventSchema.index(
  { taskId: 1, sequenceNumber: 1 },
  { unique: true, name: "IDX-EVT-02" },
);
RecoveryEventSchema.index({ orderId: 1, timestamp: -1 }, { name: "IDX-EVT-03" });
RecoveryEventSchema.index({ eventType: 1, timestamp: -1 }, { name: "IDX-EVT-04" });
RecoveryEventSchema.index({ actorId: 1, timestamp: -1 }, { name: "IDX-EVT-05" });
RecoveryEventSchema.index({ taskId: 1, leaseGeneration: 1 }, { name: "IDX-EVT-06" });

// H1 operation history is defined with the task contract (RecoveryTask.js) and
// re-exported here because both are append-only audit evidence. The history
// record is inserted in the same transaction as `T_effect` / `T_abandon`; the
// task-document CAS is the fence, never the history row.

export function getRecoveryEventModel(connection) {
  return (
    connection.models.RecoveryEvent ||
    connection.model("RecoveryEvent", RecoveryEventSchema, "inventory_recovery_events")
  );
}

export {
  RecoveryEventSchema,
  RecoveryOperationHistorySchema,
  EventDetailsSchema,
  DeltaSchema,
  getRecoveryOperationHistoryModel,
};
