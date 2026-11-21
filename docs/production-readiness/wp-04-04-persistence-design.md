# WP-04-04 — Durable Recovery Persistence and Evidence Design (Final Technical Clarification)

Status: **FINAL TECHNICAL CLARIFICATION — DESIGN SPECIFICATION ONLY — NO CODE AUTHORIZATION**  
Revision Date: 2026-11-10  
Repository: `C:\hotelms`  
Branch / HEAD: `main` / `69650435a6587d4577bc126f719fa1392bb934b3`  
Author: Architecture & Recovery Design Reviewer  
Work Package: **WP04-04 (Persistence Design Clarification)**  
Parents: `wp-04-reconciliation-design.md`, `wp-04-recovery-state-machine.md`, `wp-04-detection-rule-matrix.md`, `wp-04-00-authorization-record.md`, `wp-04-03-implementation-report.md`  

> **MANDATORY NOTICE & BOUNDARIES:**  
> This document specifies an architectural design clarification only. **No implementation authorization is granted.** No database connection was opened; no staging or production system was accessed; no schema, collection, or index was created or synchronized; no source, route, worker, scheduler, or test file was modified. All recommendations are proposals subject to explicit owner approval. Decisions OD-04, OD-07, OD-09, OD-10, and OD-23 remain unapproved.

> **AMENDMENT 2026-11-12 — WP04-06 DESIGN CONSOLIDATION (see `wp-04-06-design-consolidation-and-register.md`):** §6's event-time sequence allocation model is **superseded for O2 operation flows** by the reservation-time model (R3 §15.1/§22.4.2): the transition event and an operation reservation are **distinct single-slot consumers in separate transactions** — the claim consumes one sequence for its event; a standalone `T_reserve` consumes exactly one sequence for the pending operation and emits no event (I-C); W7 effect writes insert at the already-reserved sequence and **never** increment `eventSequenceCounter`. Reserved-but-uneffected sequences are permanent gaps (OD-28(a)); the single-slot ceiling guard remains sufficient. §7.2's stale-generation defense remains consistent and authoritative. OD-23 wording above is unaffected (still owner-approved Option B for scoping only); OD-24 (H1), OD-27-SC, OD-30, OD-33, OD-37, T9/Acquire, and I-C are now registered in the consolidation document.

---

## 1. Executive Summary and Clarification Scope

This final technical clarification resolves all remaining technical ambiguities, concurrency edge cases, and policy demarcations in the WP04-04 persistence design:
1. **Business Unknown Commit vs Recovery Persistence Unknown Commit:** Strictly separates business-operation failures (orders, payments, inventory) from recovery-metadata persistence failures. Re-affirms that an absent business effect **never** authorizes a business write or retry. Purges ambiguous execution language.
2. **Lease Generation Fencing and Publication:** Replaces uncoordinated counter increments with monotonic lease generation fencing (`leaseGeneration`), defining exact rejection rules for stale workers and sequence gap semantics.
3. **Event Sequence Numeric Safety:** Specifies exact numeric types (BSON Long / Safe Integer), bounded ranges ($[1, 1000000]$), atomic `$inc` behavior, and overflow fail-closed protection, eliminating unbounded floating-point risks.
4. **WD-10 Finding Identity:** Clarifies deterministic canonical identity encoding (`REC:v1:<32-hex-digest>`), explicit typed null handling, ObjectId/string differentiation, and distinct multi-defect lifecycles on a single order. OD-23 remains explicitly **PROPOSED / OWNER APPROVAL REQUIRED**.
5. **Persistence Security Hardening:** Mandates strict allowlist projection, complete exclusion of account numbers and masked fragments, removal of free-text strings in favor of bounded enums, and recursive sensitive-key validation.
6. **Topology Prerequisites:** Clearly establishes that multi-document task/event consistency requires a transaction-capable replica set as a hard prerequisite; no multi-document atomicity is claimed on standalone MongoDB.

---

## 2. Policy Baseline and Demarcation

| Tier | Meaning | Application in this Document |
|---|---|---|
| **Approved Owner Policy** | Formally approved by the owner (WD-01 through WD-14). | Seven approved states; D01–D10 vocabulary; WD-10 item-level focus; no auto-repair; append-only audit; role-placeholder model. |
| **Existing Verified Source Behavior** | Proven by inspection of the active codebase. | `projectEvidence()` allowlisting; `fingerprintEvidence()` SHA-256; `classifyEvidence()` dedupe keys; V1 idempotency keys. |
| **Proposed Design** | Architecture proposed by this review for durable persistence. | Item-level finding identity, BSON Long sequence counter, monotonic lease generation fencing, bounded error structures. |
| **Unverified Deployment Assumptions** | Infrastructure assumptions requiring DBA verification. | Multi-document replica-set transactions, WiredTiger engine availability, NTP clock synchronization across nodes. |
| **Decisions Requiring Owner Approval** | Unresolved operational parameters requiring explicit owner signature. | Proposed collection names, open-task scoping model (OD-23), retention horizon (OD-4), lease duration (OD-9), alert sinks (OD-7). |

---

## 3. Disambiguation: Business Unknown Commit vs Recovery Persistence Unknown Commit

To eliminate architectural confusion, two fundamentally different failure domains are strictly separated:

```text
+---------------------------------------------------------------------------------------------------+
|                                      TWO DISTINCT DOMAINS                                         |
+-------------------------------------------------+-------------------------------------------------+
|        DOMAIN A: BUSINESS UNKNOWN COMMIT        |     DOMAIN B: RECOVERY PERSISTENCE COMMIT       |
+-------------------------------------------------+-------------------------------------------------+
| • Source: V1 Cashier, Waiter, Kitchen, Payment  | • Source: Recovery Worker writing Recovery DB   |
| • Operations: Payment verify, stock deduction   | • Operations: Task status update, event append  |
| • Target Collections: orders, inventoryitems,   | • Target Collections: inventory_recovery_tasks, |
|   inventoryreservations, stockmovements         |   inventory_recovery_events                     |
| • Recovery Role: 100% READ-ONLY OBSERVER        | • Recovery Role: DURABLE METADATA PERSISTER     |
| • Action on Timeout: Fresh read only            | • Action on Timeout: Idempotent metadata check  |
| • Prohibited: ANY BUSINESS WRITE OR RETRY       | • Prohibited: ANY INVOCATION OF BUSINESS CODE   |
+-------------------------------------------------+-------------------------------------------------+
```

### 3.1 Domain A: Business-Operation Unknown Commit
- **Definition:** A business transaction (e.g. order payment, inventory deduction, reservation hold release) executed by a POS client, cashier, or V1 service encounters a socket timeout, network disconnection, or primary stepdown before acknowledgment is received.
- **Recovery Plane Invariant:**
  - The recovery plane acts exclusively as a **read-only observer**.
  - The recovery plane performs fresh, bounded authoritative reads via `lib/recovery/adapter.js`.
  - Under no condition does the recovery plane retry, compensate, repair, or re-issue a business transaction.
  - **Absent Observed Effect Rule:** If an authoritative read reveals that a business write did **not** commit (e.g. `StockMovement` does not exist), this observation **NEVER authorizes a recovery business write**. It is recorded as a finding or escalated to human review (`MANUAL_REQUIRED`).
  - **`RESOLVED` Semantics:** `RESOLVED` remains strictly restricted to `resolution: "ALREADY_CORRECT"`, occurring solely when fresh authoritative evidence proves that regular staff completed the workflow naturally.

### 3.2 Domain B: Recovery-Record Persistence Unknown Commit
- **Definition:** A recovery process attempts to write metadata to `inventory_recovery_tasks` or `inventory_recovery_events`, and the write acknowledgment is lost due to a database timeout.
- **Persistence Invariant:**
  - The recovery process must reconcile **recovery metadata only**.
  - The worker performs an idempotent query on `eventId` or `{ taskId, sequenceNumber }`.
  - If the metadata record exists, the write succeeded; the worker advances task state.
  - If the metadata record is absent, the worker retries writing the *exact same* metadata record under the current fencing token.
  - **Strict Boundary:** Recovery metadata retries **never touch business collections** and **never invoke business services**.

---

## 4. Recovery Task Identity and Scoping (WD-10 Preservation)

### 4.1 Preserving Item-Level Identity (WD-10)
Approved owner decision **WD-10** establishes that recovery operates at the **item level first**, with mandatory line-level attribution deferred. An order containing multiple items may experience independent discrepancies (e.g. Item A has a shortage, Item B is unconsumed).

- **Rejection of Order-Level Bottleneck:** A unique constraint on `{ orderId: 1, isOpen: true }` is rejected because it forces an order to have at most one open task, suppressing concurrent defects on distinct items.
- **Proposed Architecture (OD-23: PROPOSED / OWNER APPROVAL REQUIRED):** Open tasks are scoped by finding identity: `{ findingIdentityKey: 1, isOpen: true }`.

### 4.2 Canonical Task Identity Specification
The canonical task identity is computed deterministically via canonical JSON and SHA-256 to eliminate delimiter injection vulnerabilities:

```javascript
/**
 * Canonical Finding Identity Key Specification
 * Deterministic SHA-256 over canonical JSON tuple.
 */
function buildFindingIdentityKey(ruleId, code, orderId, itemId = null, lineId = null) {
  const payload = {
    schema: "wp04-task-identity-v1",
    rule: String(ruleId),
    code: String(code),
    orderId: normalizeIdentifierForIdentity(orderId),
    itemId: itemId === null ? { $type: "null" } : normalizeIdentifierForIdentity(itemId),
    lineId: lineId === null ? { $type: "null" } : normalizeIdentifierForIdentity(lineId),
  };
  const canonicalString = canonicalize(payload); // UTF-16 sorted keys, ECMAScript shortest round-trip
  const digest = createHash("sha256").update(canonicalString, "utf8").digest("hex");
  return `REC:v1:${digest.slice(0, 32)}`;
}
```

- **Type Normalization Rules:**
  - `ObjectId`: Represented as `{ $oid: "<24-hex-lowercase>" }`.
  - `String`: Represented as `{ $str: "<string>" }`.
  - `Number`: Safe integer represented as `{ $num: <int> }`.
  - `null`: Explicitly typed object `{ $type: "null" }` to prevent ambiguity between absent and null properties.
- **Task Identifiers:**
  - `taskId`: `REC:v1:<32-hex-digest>`.
  - `taskKey`: Grouping key `GRP:<orderId>` (non-unique, enables querying all findings for an order).
  - `findingIdentityKey`: Identical to `taskId`.

### 4.3 Terminal State Immutability and Reappearance
- Tasks in terminal states (`CLOSED` and `CANCELLED`) have `isOpen: false` and are **permanently immutable**.
- If an order experiences a new defect on the same item after a task has closed:
  - The partial unique index on `{ findingIdentityKey: 1 }` where `isOpen: true` permits the new insert because `isOpen` on the historical document is `false`.
  - A new task document is inserted with a unique MongoDB `_id`, recording `priorTaskId: <historicalDoc._id>` for audit lineage.

---

## 5. Durable Schema Contracts (Revised & Hardened)

### 5.1 Task Schema Contract (`inventory_recovery_tasks`)
*Collection proposal requiring owner approval OD-10.*

```javascript
const DurableRecoveryTaskContract = {
  _id: "ObjectId",                       // Internal document ID
  taskId: "String",                     // Canonical ID: "REC:v1:<32-hex-digest>"
  taskKey: "String",                    // Grouping: "GRP:<orderId>"
  orderId: "ObjectId",                  // Ref to Order._id
  orderNumber: "String|Number|null",    // Read-only reference for triage
  reservationId: "ObjectId|null",       // Ref to InventoryReservation._id
  itemId: "ObjectId|null",              // Target inventory item ID (WD-10)
  lineId: "String|Number|null",         // Target order line ID (optional)

  // --- Classification (Frozen D01-D10 Vocabulary) ---
  rule: "String",                       // Enum: "D01" ... "D10"
  code: "String",                       // Frozen sub-code from registry.js
  classification: "String",             // "DEFECT" | "ALERT" | "INFO"
  severity: "String",                   // "CRITICAL" | "HIGH" | "MEDIUM" | "INFO"
  confidence: "String",                 // "HIGH" | "MEDIUM" | "LOW"
  evidenceLevel: "String",              // "E0" | "E1" | "E2" | "E3"
  findingIdentityKey: "String",         // Indexed deduplication key
  findingCodeOnly: "Boolean",           // True for D02 and D09
  durableClass: "Boolean|null",         // False for D02/D09; null/true for others

  // --- Fingerprints and Versioning ---
  fingerprintSchema: "String",          // "wp04-fingerprint-v1"
  evidenceSchema: "String",             // "wp04-evidence-v1"
  initialFingerprint: "String",         // SHA-256 hex digest
  currentFingerprint: "String",         // SHA-256 hex digest

  // --- Lifecycle, Lease & Sequence Counter ---
  status: "String",                     // DETECTED | LEASED | RETRY_SCHEDULED | MANUAL_REQUIRED | RESOLVED | CLOSED | CANCELLED
  isOpen: "Boolean",                    // true for active/escalated; false ONLY for CLOSED and CANCELLED
  leaseOwner: "String|null",            // Worker identity holding lease
  leaseToken: "String|null",            // UUID fencing token
  leaseGeneration: "Number",            // BSON Long / Safe Int: strictly monotonic increment per claim
  leaseUntil: "Date|null",              // UTC expiration timestamp
  attempts: "Number",                   // Non-negative integer charged upon lease claim
  maxAttempts: "Number",                // Hard retry ceiling (Provisional test default: 5)
  nextAttemptAt: "Date|null",           // UTC timestamp for retry eligibility
  eventSequenceCounter: "Number",       // BSON Long / Safe Int: monotonic sequence counter (Max: 1,000,000)

  // --- Hardened Escalation & Review (Zero Free Text) ---
  manualReasonCode: "String|null",      // Bounded enum: "POLICY_MANUAL_RULE" | "EVIDENCE_DRIFT" | "ATTEMPTS_EXHAUSTED" | "PERSISTENCE_TIMEOUT"
  escalation: {
    code: "String|null",                // Bounded enum: "ESC_UNKNOWN_COMMIT" | "ESC_EVIDENCE_DRIFT" | "ESC_EXHAUSTED" | "ESC_MANUAL_RULE"
    expectedStatus: "String|null",      // Allowed order/reservation status enum
    actualStatus: "String|null",
    expectedQuantity: "Number|null",    // Finite numeric quantity
    actualQuantity: "Number|null",
  },
  approvedBy: "String|null",            // Role placeholder (e.g., "ROLE-INVENTORY-MANAGER")
  approvedAt: "Date|null",
  executedBy: "String|null",            // Role placeholder (e.g., "ROLE-RECOVERY-EXECUTOR")
  executedAt: "Date|null",
  verifierId: "String|null",            // Role placeholder (e.g., "ROLE-TECHNICAL-LEAD")
  verifiedAt: "Date|null",

  // --- Resolution (Read-Only Semantics) ---
  resolution: "String|null",            // "ALREADY_CORRECT" | "ESCALATED" | "CANCELLED" ("APPLIED" disabled in read-only)
  lastErrorCode: "String|null",         // Bounded enum: "EVIDENCE_DRIFT" | "TIMEOUT" | "CONFLICT" | "SEQUENCE_OVERFLOW"
  lastErrorField: "String|null",        // Sanitized schema path (max 64 chars)

  // --- Timestamps ---
  createdAt: "Date",
  updatedAt: "Date",
  closedAt: "Date|null",
  cancelledAt: "Date|null",
};
```

### 5.2 Event Schema Contract (`inventory_recovery_events`)
*Collection proposal requiring owner approval OD-10.*

```javascript
const RecoveryEvidenceEventContract = {
  _id: "ObjectId",                      // Internal document ID
  eventId: "String",                    // Deterministic ID: "EVT:<taskId>:<sequenceNumber>"
  taskId: "String",                     // Canonical finding ID ("REC:v1:<digest>")
  orderId: "ObjectId",                  // Ref to Order._id
  sequenceNumber: "Number",             // BSON Long / Safe Int: strictly monotonic sequence (1..1000000)
  leaseGeneration: "Number",            // Lease generation under which this event was published
  timestamp: "Date",                    // Authoritative ISO-8601 UTC timestamp

  // --- Event Classification ---
  eventType: "String",                  // Bounded enum:
                                        // "RECOVERY_DETECTED" | "RECOVERY_LEASED" | "RECOVERY_RENEWED" |
                                        // "RECOVERY_RETRY_SCHEDULED" | "RECOVERY_ESCALATED" |
                                        // "RECOVERY_APPROVED" | "RECOVERY_RESOLVED" |
                                        // "RECOVERY_VERIFIED" | "RECOVERY_CLOSED" | "RECOVERY_CANCELLED" |
                                        // "RECOVERY_EVIDENCE_DRIFT"

  // --- Provenance & Attribution ---
  actorId: "String",                    // Service identity or role placeholder
  actorRole: "String",                  // "ROLE-TECHNICAL-LEAD" | "ROLE-DATA-OWNER" | "ROLE-INVENTORY-MANAGER" | "SERVICE-WORKER"
  actorType: "String",                  // "WORKER" | "OPERATOR" | "SCANNER" | "VERIFIER"
  fencingToken: "String",               // Lease UUID fencing token

  // --- Evidence Snapshot & Digest ---
  fingerprintVersion: "String",         // "wp04-fingerprint-v1"
  evidenceSchemaVersion: "String",      // "wp04-evidence-v1"
  evidenceDigest: "String",             // SHA-256 hex digest
  projectedEvidence: "Object",          // Output from projectEvidence() (strictly allowlisted, zero accounts/PINs)

  // --- Bounded Details ---
  details: {
    fromStatus: "String|null",
    toStatus: "String",
    attempts: "Number",
    diagnosticCode: "String|null",      // Bounded enum: "DOC_CORRUPT" | "INDEX_ABSENT" | "TIMEOUT" | "LEASE_EXPIRED" | "DRIFT_DETECTED"
    observedFingerprint: "String|null",
  }
};
```

---

## 6. Event Sequence Numeric Safety

To ensure that the sequence counter cannot suffer floating-point rounding, silent precision loss, or infinite looping:
1. **BSON Storage Type:** The sequence counter `eventSequenceCounter` and event `sequenceNumber` must be persisted as **BSON Long (`Int64`)**.
2. **Safe Operational Range:**
   $$1 \le \text{sequenceNumber} \le 1,000,000$$
   A single recovery task lifecycle requires fewer than 50 events. Setting an explicit architectural ceiling of $1,000,000$ guarantees that operations never approach JavaScript's `Number.MAX_SAFE_INTEGER` ($9,007,199,254,740,991$).
3. **Atomic Increment & Overflow Guard:**
   Sequence allocation is executed using a query condition bounding the counter:
   ```javascript
   const update = {
     $inc: { eventSequenceCounter: 1 },
     $set: { updatedAt: currentTime }
   };
   const filter = {
     taskId: targetTaskId,
     isOpen: true,
     status: "LEASED",
     leaseOwner: workerId,
     leaseToken: activeToken,
     leaseGeneration: currentGeneration,
     leaseUntil: { $gt: currentTime },
     eventSequenceCounter: { $lt: 1000000 } // HARD OVERFLOW CEILING
   };
   ```
4. **Overflow Fail-Closed:** If `eventSequenceCounter` reaches $1,000,000$, the query matches 0 documents. The worker fails closed with typed error `SEQUENCE_OVERFLOW`, preventing any further automated writes and escalating the task to human operators.

---

## 7. Topology Prerequisites and Consistency Architecture

### 7.1 Multi-Document Replica-Set Transaction Prerequisite
A core finding of this clarification is that **multi-document atomicity across tasks and events cannot be guaranteed on standalone MongoDB**. 
- **Topology Requirement:** For the recovery plane to guarantee that task status updates and event inserts commit atomically without sequence desynchronization, an **active MongoDB replica set** (or sharded cluster) is a **hard prerequisite**.
- **No Standalone Claims:** The recovery plane will explicitly reject claims of multi-document transactional consistency when connected to a standalone MongoDB instance.

### 7.2 Practical Recommended Design: Model 1 with Stale-Generation Rejection
1. **Acquire Lease:** Worker atomically increments `leaseGeneration` and updates `leaseToken`, `leaseOwner`, and `leaseUntil` via `findOneAndUpdate` on the task document.
2. **Execute Multi-Document Transaction:**
   ```text
   session.startTransaction()
   try:
     1. Read task inside session: verify leaseGeneration == activeGen AND leaseUntil > now.
     2. Increment eventSequenceCounter on task inside session.
     3. Insert event into inventory_recovery_events inside session (keyed with sequenceNumber and leaseGeneration).
     4. Update task status inside session.
     commitTransaction()
   except:
     abortTransaction()
   ```
3. **Fallback & Stale-Generation Defense:** If an event insertion commits but the task update aborts (e.g. during standalone fallback or simulated network severance):
   - The event carries `leaseGeneration`.
   - When a subsequent worker reclaims the lease, it observes `leaseGeneration` has been bumped.
   - Any event carrying a generation lower than the active generation without a corresponding task transition is quarantined or reconciled as an uncommitted attempt.
4. **Sequence Gaps:** Sequence gaps are formally defined as benign indicators of aborted attempts and do not impair sequential playback.
