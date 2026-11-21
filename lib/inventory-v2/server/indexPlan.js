// BONO Inventory V2 — explicit index plan.
//
// This module is pure data + validation. It never connects to MongoDB, creates
// an index, or imports a model. The guarded deployment script consumes this
// plan; the application must never auto-sync V2 indexes.
//
// Index classification
// --------------------
// CORRECTNESS_CRITICAL_UNIQUE
//   The database enforces a uniqueness invariant. Removing or weakening it
//   breaks a documented safety guarantee.
// QUERY_PERFORMANCE_ONLY
//   Improves a read path. It is NOT a correctness dependency and may be dropped
//   by an owner-approved migration without changing business semantics.
// CLEANUP_ONLY
//   TTL index used only to reclaim expired documents. TTL expiry is
//   non-deterministic and must never decide whether a new challenge/approval may
//   be created.
//
// Challenge rule (critical)
// -------------------------
// `inventory_v2_approval_challenges` has exactly one correctness-critical unique
// index: `{ challengeId: 1 }`. A global unique
// `{ approvalGroupId: 1, stage: 1 }` on challenges would deadlock re-issuance
// after an expired/failed challenge and is FORBIDDEN. Successful approval
// uniqueness belongs exclusively to `inventory_v2_approvals` via its
// `{ approvalGroupId: 1, stage: 1 }` unique index.

import { assertServerOnly } from "./boundary.js";

assertServerOnly("Inventory V2 index plan");

export const V2_INDEX_CLASSIFICATIONS = Object.freeze({
  CORRECTNESS_CRITICAL_UNIQUE: "CORRECTNESS_CRITICAL_UNIQUE",
  QUERY_PERFORMANCE_ONLY: "QUERY_PERFORMANCE_ONLY",
  CLEANUP_ONLY: "CLEANUP_ONLY",
});

export const V2_COLLECTIONS = Object.freeze({
  ALLOCATIONS: "inventory_v2_allocations",
  WASTE_CORRECTIONS: "inventory_v2_waste_corrections",
  APPROVAL_CHALLENGES: "inventory_v2_approval_challenges",
  APPROVALS: "inventory_v2_approvals",
  PAYMENT_EVIDENCE: "inventory_v2_payment_evidence",
  AUDIT_EVENTS: "inventory_v2_audit_events",
  POLICY_VERSIONS: "inventory_v2_policy_versions",
});

const COLLECTION_VALUES = Object.freeze(Object.values(V2_COLLECTIONS));

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

export const V2_INDEX_PLAN = deepFreeze([
  // ---------------------------------------------------------------------------
  // Allocations
  // ---------------------------------------------------------------------------
  {
    collection: V2_COLLECTIONS.ALLOCATIONS,
    name: "allocation_id_unique",
    key: { allocationId: 1 },
    options: { unique: true },
    classification: V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE,
    rationale: "One durable allocation document per allocationId.",
  },
  {
    collection: V2_COLLECTIONS.ALLOCATIONS,
    name: "allocation_order_key_epoch_unique",
    key: { orderId: 1, allocationKey: 1, epoch: 1 },
    options: { unique: true },
    classification: V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE,
    rationale:
      "Prevents duplicate allocation identities for the same order/station tuple and epoch.",
  },
  {
    collection: V2_COLLECTIONS.ALLOCATIONS,
    name: "allocation_order_station_lookup",
    key: { orderId: 1, station: 1 },
    options: {},
    classification: V2_INDEX_CLASSIFICATIONS.QUERY_PERFORMANCE_ONLY,
    rationale: "Loads the station allocations for one order.",
  },
  {
    collection: V2_COLLECTIONS.ALLOCATIONS,
    name: "allocation_state_lookup",
    key: { state: 1 },
    options: {},
    classification: V2_INDEX_CLASSIFICATIONS.QUERY_PERFORMANCE_ONLY,
    rationale: "Finds allocations in a lifecycle state for recovery/reporting.",
  },

  // ---------------------------------------------------------------------------
  // Waste corrections
  // ---------------------------------------------------------------------------
  {
    collection: V2_COLLECTIONS.WASTE_CORRECTIONS,
    name: "waste_allocation_correction_unique",
    key: { allocationId: 1, correctionId: 1 },
    options: { unique: true },
    classification: V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE,
    rationale:
      "Durable idempotency for waste corrections (replaces the process-local ledger).",
  },
  {
    collection: V2_COLLECTIONS.WASTE_CORRECTIONS,
    name: "waste_allocation_applied_lookup",
    key: { allocationId: 1, appliedAt: -1 },
    options: {},
    classification: V2_INDEX_CLASSIFICATIONS.QUERY_PERFORMANCE_ONLY,
    rationale: "Lists corrections for one allocation in application order.",
  },

  // ---------------------------------------------------------------------------
  // Approval challenges
  // ---------------------------------------------------------------------------
  {
    collection: V2_COLLECTIONS.APPROVAL_CHALLENGES,
    name: "challenge_id_unique",
    key: { challengeId: 1 },
    options: { unique: true },
    classification: V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE,
    rationale:
      "The ONLY correctness-critical unique index on challenges. One document per issued challenge.",
  },
  {
    collection: V2_COLLECTIONS.APPROVAL_CHALLENGES,
    name: "challenge_expires_ttl",
    key: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
    classification: V2_INDEX_CLASSIFICATIONS.CLEANUP_ONLY,
    rationale:
      "TTL cleanup only. Expiry never authorizes or blocks challenge creation.",
  },
  {
    collection: V2_COLLECTIONS.APPROVAL_CHALLENGES,
    name: "challenge_open_lookup",
    key: { approvalGroupId: 1, stage: 1 },
    options: { partialFilterExpression: { consumedAt: null } },
    classification: V2_INDEX_CLASSIFICATIONS.QUERY_PERFORMANCE_ONLY,
    rationale:
      "Optional non-unique partial lookup for an OPEN challenge. Never a correctness dependency and never unique.",
  },

  // ---------------------------------------------------------------------------
  // Approvals
  // ---------------------------------------------------------------------------
  {
    collection: V2_COLLECTIONS.APPROVALS,
    name: "approval_group_stage_unique",
    key: { approvalGroupId: 1, stage: 1 },
    options: { unique: true },
    classification: V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE,
    rationale:
      "Successful approvals are unique per approval group and stage. This is the ONLY place this tuple is unique.",
  },
  {
    collection: V2_COLLECTIONS.APPROVALS,
    name: "approval_challenge_unique",
    key: { challengeId: 1 },
    options: { unique: true },
    classification: V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE,
    rationale: "One successful approval per consumed challenge.",
  },
  {
    collection: V2_COLLECTIONS.APPROVALS,
    name: "approval_order_lookup",
    key: { orderId: 1, createdAt: -1 },
    options: {},
    classification: V2_INDEX_CLASSIFICATIONS.QUERY_PERFORMANCE_ONLY,
    rationale: "Lists approval history for one order.",
  },

  // ---------------------------------------------------------------------------
  // Payment evidence
  // ---------------------------------------------------------------------------
  {
    collection: V2_COLLECTIONS.PAYMENT_EVIDENCE,
    name: "payment_evidence_id_unique",
    key: { evidenceId: 1 },
    options: { unique: true },
    classification: V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE,
    rationale: "One durable evidence document per evidenceId.",
  },
  {
    collection: V2_COLLECTIONS.PAYMENT_EVIDENCE,
    name: "payment_evidence_order_version_unique",
    key: { orderId: 1, orderVersion: 1 },
    options: { unique: true },
    classification: V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE,
    rationale:
      "Binds payment evidence to exactly one order version; stale versions cannot reuse evidence.",
  },

  // ---------------------------------------------------------------------------
  // Audit events
  // ---------------------------------------------------------------------------
  {
    collection: V2_COLLECTIONS.AUDIT_EVENTS,
    name: "audit_event_id_unique",
    key: { eventId: 1 },
    options: { unique: true },
    classification: V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE,
    rationale: "Audit events are idempotent by eventId.",
  },
  {
    collection: V2_COLLECTIONS.AUDIT_EVENTS,
    name: "audit_order_time_lookup",
    key: { orderId: 1, occurredAt: -1 },
    options: {},
    classification: V2_INDEX_CLASSIFICATIONS.QUERY_PERFORMANCE_ONLY,
    rationale: "Reads the audit timeline for one order.",
  },

  // ---------------------------------------------------------------------------
  // Policy versions
  // ---------------------------------------------------------------------------
  {
    collection: V2_COLLECTIONS.POLICY_VERSIONS,
    name: "policy_version_unique",
    key: { policyVersion: 1 },
    options: { unique: true },
    classification: V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE,
    rationale: "Policy versions are unique and immutable.",
  },
  {
    collection: V2_COLLECTIONS.POLICY_VERSIONS,
    name: "policy_effective_lookup",
    key: { effectiveFrom: -1 },
    options: {},
    classification: V2_INDEX_CLASSIFICATIONS.QUERY_PERFORMANCE_ONLY,
    rationale: "Finds the latest effective policy version.",
  },
]);

export function indexKeySignature(key) {
  return Object.entries(key ?? {})
    .map(([field, direction]) => `${field}:${direction}`)
    .join("|");
}

function keySet(key) {
  return Object.keys(key ?? {});
}

const REQUIRED_UNIQUE_KEYS = Object.freeze({
  [V2_COLLECTIONS.ALLOCATIONS]: Object.freeze([
    "allocationId:1",
    "orderId:1|allocationKey:1|epoch:1",
  ]),
  [V2_COLLECTIONS.WASTE_CORRECTIONS]: Object.freeze([
    "allocationId:1|correctionId:1",
  ]),
  [V2_COLLECTIONS.APPROVAL_CHALLENGES]: Object.freeze(["challengeId:1"]),
  [V2_COLLECTIONS.APPROVALS]: Object.freeze([
    "approvalGroupId:1|stage:1",
    "challengeId:1",
  ]),
  [V2_COLLECTIONS.PAYMENT_EVIDENCE]: Object.freeze([
    "evidenceId:1",
    "orderId:1|orderVersion:1",
  ]),
  [V2_COLLECTIONS.AUDIT_EVENTS]: Object.freeze(["eventId:1"]),
  [V2_COLLECTIONS.POLICY_VERSIONS]: Object.freeze(["policyVersion:1"]),
});

export const V2_FORBIDDEN_CHALLENGE_UNIQUE_KEY =
  "approvalGroupId:1|stage:1";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a plan without touching a database. Returns every issue so the
 * deployment script can fail closed with a complete report.
 */
export function validateV2IndexPlan(plan = V2_INDEX_PLAN) {
  const issues = [];

  if (!Array.isArray(plan) || plan.length === 0) {
    return {
      ok: false,
      issues: [{ type: "INVALID_PLAN", detail: "Plan must be a non-empty array" }],
    };
  }

  const seenCollections = new Set();
  const seenNames = new Map();
  const seenKeys = new Map();
  const uniqueByCollection = new Map();

  for (const [position, entry] of plan.entries()) {
    if (!isPlainObject(entry)) {
      issues.push({ type: "INVALID_ENTRY", position, detail: "Entry must be an object" });
      continue;
    }
    const { collection, name, key, options, classification } = entry;

    if (!COLLECTION_VALUES.includes(collection)) {
      issues.push({
        type: "UNKNOWN_COLLECTION",
        position,
        collection,
        detail: "Collection is not declared in V2_COLLECTIONS",
      });
    }
    seenCollections.add(collection);

    if (typeof name !== "string" || name.trim() !== name || name.length === 0) {
      issues.push({ type: "INVALID_NAME", position, collection, name });
    }

    if (!isPlainObject(key) || keySet(key).length === 0) {
      issues.push({ type: "INVALID_KEY", position, collection, name });
    } else {
      for (const [field, direction] of Object.entries(key)) {
        if (!["1", "-1"].includes(String(direction))) {
          issues.push({
            type: "INVALID_KEY_DIRECTION",
            position,
            collection,
            name,
            field,
            direction,
          });
        }
      }
    }

    if (!isPlainObject(options)) {
      issues.push({ type: "INVALID_OPTIONS", position, collection, name });
    }

    if (!Object.values(V2_INDEX_CLASSIFICATIONS).includes(classification)) {
      issues.push({
        type: "INVALID_CLASSIFICATION",
        position,
        collection,
        name,
        classification,
      });
    }

    const signature = indexKeySignature(key);
    const nameKey = `${collection}::${name}`;
    const keyKey = `${collection}::${signature}`;

    if (seenNames.has(nameKey)) {
      issues.push({
        type: "DUPLICATE_NAME",
        position,
        collection,
        name,
        firstPosition: seenNames.get(nameKey),
      });
    } else {
      seenNames.set(nameKey, position);
    }

    if (seenKeys.has(keyKey)) {
      issues.push({
        type: "DUPLICATE_KEY",
        position,
        collection,
        name,
        keySignature: signature,
        firstPosition: seenKeys.get(keyKey),
      });
    } else {
      seenKeys.set(keyKey, position);
    }

    const unique = options?.unique === true;
    const ttl = options?.expireAfterSeconds !== undefined;

    if (unique && classification !== V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE) {
      issues.push({
        type: "UNIQUE_CLASSIFICATION_MISMATCH",
        position,
        collection,
        name,
        detail: "Unique indexes must be CORRECTNESS_CRITICAL_UNIQUE",
      });
    }
    if (
      classification === V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE &&
      !unique
    ) {
      issues.push({
        type: "CRITICAL_INDEX_NOT_UNIQUE",
        position,
        collection,
        name,
      });
    }
    if (ttl && classification !== V2_INDEX_CLASSIFICATIONS.CLEANUP_ONLY) {
      issues.push({
        type: "TTL_CLASSIFICATION_MISMATCH",
        position,
        collection,
        name,
        detail: "TTL indexes must be CLEANUP_ONLY",
      });
    }
    if (classification === V2_INDEX_CLASSIFICATIONS.CLEANUP_ONLY && !ttl) {
      issues.push({
        type: "CLEANUP_INDEX_WITHOUT_TTL",
        position,
        collection,
        name,
      });
    }
    if (unique && ttl) {
      issues.push({
        type: "UNIQUE_TTL_FORBIDDEN",
        position,
        collection,
        name,
      });
    }

    if (unique) {
      if (!uniqueByCollection.has(collection)) {
        uniqueByCollection.set(collection, new Set());
      }
      uniqueByCollection.get(collection).add(signature);
    }

    // Challenge correctness: never a unique approvalGroupId/stage index.
    if (
      collection === V2_COLLECTIONS.APPROVAL_CHALLENGES &&
      unique &&
      signature === V2_FORBIDDEN_CHALLENGE_UNIQUE_KEY
    ) {
      issues.push({
        type: "FORBIDDEN_CHALLENGE_UNIQUE",
        position,
        collection,
        name,
        detail:
          "A global unique { approvalGroupId, stage } index on challenges is forbidden",
      });
    }
  }

  for (const collection of COLLECTION_VALUES) {
    if (!seenCollections.has(collection)) {
      issues.push({
        type: "MISSING_COLLECTION",
        collection,
        detail: "Every V2 collection must appear in the plan",
      });
    }
  }

  for (const [collection, requiredKeys] of Object.entries(REQUIRED_UNIQUE_KEYS)) {
    const actual = uniqueByCollection.get(collection) ?? new Set();
    for (const required of requiredKeys) {
      if (!actual.has(required)) {
        issues.push({
          type: "MISSING_REQUIRED_UNIQUE",
          collection,
          keySignature: required,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export class InventoryV2IndexPlanError extends Error {
  constructor(issues) {
    super("Inventory V2 index plan is invalid");
    this.name = "InventoryV2IndexPlanError";
    this.code = "INVENTORY_V2_INDEX_PLAN_INVALID";
    this.issues = Object.freeze([...(issues ?? [])]);
  }
}

export function assertV2IndexPlan(plan = V2_INDEX_PLAN) {
  const result = validateV2IndexPlan(plan);
  if (!result.ok) throw new InventoryV2IndexPlanError(result.issues);
  return true;
}

export function getV2IndexPlan() {
  return V2_INDEX_PLAN;
}

export function planEntriesForCollection(collection, plan = V2_INDEX_PLAN) {
  return plan.filter((entry) => entry.collection === collection);
}

export default V2_INDEX_PLAN;
