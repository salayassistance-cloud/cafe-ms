# WP-04-04 — Index Specification and Query Performance Proposal (Final Technical Clarification)

Status: **FINAL TECHNICAL CLARIFICATION — PROPOSAL ONLY — NO DEPLOYMENT AUTHORIZATION**  
Revision Date: 2026-11-10  
Repository: `C:\hotelms`  
Branch / HEAD: `main` / `69650435a6587d4577bc126f719fa1392bb934b3`  
Author: Architecture & Recovery Design Reviewer  
Work Package: **WP04-04 (Index & Query Proposal Clarification)**  
Parents: `wp-04-reconciliation-design.md`, `wp-04-persistence-design.md`, `wp-04-00-authorization-record.md`  

> **MANDATORY NOTICE & BOUNDARIES:**  
> This document contains index and query design proposals only. **No indexes may be created, synchronized, dropped, or deployed.** No MongoDB connection was established, and no index deployment script was run. All proposals must be distinguished from verified deployed indexes. Gate **G-IDX-1** remains **UNSIGNED**.

> **AMENDMENT 2026-11-12 — WP04-06 DESIGN CONSOLIDATION (see `wp-04-06-design-consolidation-and-register.md` §4 IX-AM1):**
> 1. **§4.1 polling/claim note:** any candidate surfaced by the polling query may still fail the claim CAS — including the approved positive unresolved-operation predicate `U_claim` (`$or: [{ pendingOperation: null }, { "pendingOperation.state": { $in: ["COMMITTED", "ABANDONED"] } }]`). **No index change is required for this predicate**: unresolved-operation blocking is enforced on the task document by the CAS filter itself.
> 2. **New index requirement (outside the 12 disposable proposals):** the approved OD-24 (H1) history collection requires a unique `{taskId: 1, operationId: 1}` index on `inventory_recovery_operation_history` (full unique index; deterministic id `OPH:<taskId>:<operationId>`; insert-only). Deployment requires an OD-10 signature, the **G-IDX-1** gate, a guarded deploy script with `--confirm`/`--allow-production`, and a DBA window. `IDX-OPA-01` from R3 §22.3.5 is **not** built (H-D not selected).

---

## 1. Index Demarcation and Safety Baseline

### 1.1 Demarcation Table

| Index Status | Definition | Authority | Enforcement |
|---|---|---|---|
| **Verified Deployed Indexes** | Indexes confirmed to exist in the active MongoDB replica set by empirical collection inspection. | DBA / Evidence from G-IDX-1 | Zero verified recovery indexes exist today. Existing V1 indexes must be treated as immutable. |
| **Proposed Indexes** | Theoretical index definitions proposed in this document to satisfy performance, uniqueness, and sequencing requirements. | WP04-04 Architecture Clarification | **NEVER ASSUMED PRESENT.** The adapter and classifier must function correctly or fail closed if indexes are missing. |
| **Prohibited Actions** | Modifying `lib/mongodb.js`, running `syncIndexes()`, creating collections, or dropping indexes. | Prohibited by WP04-04 Rules | Any automatic index deployment attempt is a critical boundary violation. |

---

## 2. Proposed Index Specifications: Task Collection (`inventory_recovery_tasks`)

Under the revised design, index specifications support **WD-10 (item-level findings first)** and independent finding-level lifecycles without defect suppression:

### 2.1 Index Specifications Table

| Identifier | Proposed Key Pattern | Options / Constraints | Purpose & Access Pattern |
|---|---|---|---|
| **IDX-TSK-01** | `{ taskId: 1 }` | `unique: true` | Primary business identity lookup; deterministic finding identity (`REC:v1:<32-hex>`). |
| **IDX-TSK-02** | `{ findingIdentityKey: 1 }` | `partialFilterExpression: { isOpen: true }`<br>`unique: true` | **WD-10 INTEGRITY INDEX (OD-23: PROPOSED):** Guarantees at most one open task per finding identity. Prevents duplicate task creation for the same item defect while allowing multiple distinct findings on one order. |
| **IDX-TSK-03** | `{ orderId: 1, isOpen: 1 }` | Compound index (Non-unique) | **ORDER-LEVEL CORRELATION:** Rapidly retrieves all open tasks associated with an order without bottlenecking on a single task per order. |
| **IDX-TSK-04** | `{ status: 1, isOpen: 1, nextAttemptAt: 1, leaseUntil: 1 }` | Compound index | Polling queue index for workers seeking eligible tasks (`DETECTED`, expired `LEASED`, or due `RETRY_SCHEDULED`). |
| **IDX-TSK-05** | `{ leaseOwner: 1, leaseUntil: 1, leaseGeneration: 1 }` | `partialFilterExpression: { isOpen: true }` | Worker heartbeat, generation tracking, and orphaned lease reclamation. |
| **IDX-TSK-06** | `{ status: 1, severity: 1, createdAt: 1 }` | `partialFilterExpression: { status: "MANUAL_REQUIRED" }` | Operations dashboard and escalation queue; surfaces urgent manual reviews in FIFO order. |

### 2.2 Deep Dive: Revised Uniqueness Architecture (IDX-TSK-02 vs IDX-TSK-03)
- **Rejection of `{ orderId: 1, isOpen: true }` Unique Constraint:** The initial draft proposed a unique partial index on `orderId`. This was rejected because it violates WD-10: if an order has a shortage on Item 1 and an unconsumed reservation on Item 2, a unique index on `orderId` would silently suppress or reject Item 2.
- **The Revised Finding Identity Unique Constraint:** `IDX-TSK-02` indexes `findingIdentityKey = REC:v1:<sha256(rule, code, orderId, itemId, lineId)>`. This ensures:
  - If a scanner discovers the exact same finding on Item 1, duplicate task creation is prevented.
  - If a scanner discovers a distinct finding on Item 2 of the same order, a separate task is created cleanly.
- **Order-Level Correlation (`IDX-TSK-03`):** Non-unique compound index allowing triage views to fetch all open tasks for `orderId` with index-backed efficiency.

---

## 3. Proposed Index Specifications: Evidence Event Collection (`inventory_recovery_events`)

The proposed `inventory_recovery_events` collection is an append-only ledger. It requires indexes for strictly ordered sequence retrieval, cross-order audit trails, and security event scanning.

### 3.1 Index Specifications Table

| Identifier | Proposed Key Pattern | Options / Constraints | Purpose & Access Pattern |
|---|---|---|---|
| **IDX-EVT-01** | `{ eventId: 1 }` | `unique: true` | Primary immutable event identity; prevents duplicate event insertion. |
| **IDX-EVT-02** | `{ taskId: 1, sequenceNumber: 1 }` | `unique: true` | **STRICT SEQUENCE GUARANTEE:** Enforces monotonic sequence numbers per task; supports fast event playback in chronological order without client-side sort overhead. |
| **IDX-EVT-03** | `{ orderId: 1, timestamp: -1 }` | Compound index | Order audit lookup; allows operators and verifiers to inspect complete history of an order. |
| **IDX-EVT-04** | `{ eventType: 1, timestamp: -1 }` | Compound index | Operational monitoring query; powers telemetry and alerts on specific events (e.g., `RECOVERY_EVIDENCE_DRIFT`). |
| **IDX-EVT-05** | `{ actorId: 1, timestamp: -1 }` | Compound index | Compliance and insider threat auditing; verifies human vs service actions over time. |
| **IDX-EVT-06** | `{ taskId: 1, leaseGeneration: 1 }` | Compound index | Stale generation auditing; allows rapid discovery of events published under expired or aborted lease generations. |

---

## 4. Query Patterns and Execution Bounds

Every query executed against the recovery collections must be structurally bounded. Unbounded collection scans (`COLLSCAN`) and memory-intensive sorts without index backing are strictly prohibited.

### 4.1 Worker Polling Query
```javascript
/**
 * Proposed Worker Polling Query
 * Uses Index: IDX-TSK-04 { status: 1, isOpen: 1, nextAttemptAt: 1, leaseUntil: 1 }
 */
const eligibleTasks = await TaskCollection.find({
  isOpen: true,
  $or: [
    { status: "DETECTED" },
    { status: "RETRY_SCHEDULED", nextAttemptAt: { $lte: new Date() } },
    { status: "LEASED", leaseUntil: { $lt: new Date() } }
  ]
})
  .sort({ createdAt: 1 }) // FIFO fairness
  .limit(20)             // STRICT BOUND: Never fetch unbounded lists
  .lean();
```
- **Execution Plan Expectations:** Index scan on `IDX-TSK-04`, bounding scan time to $< 5\text{ ms}$.

### 4.2 Order Findings Triage Query
```javascript
/**
 * Proposed Order Findings Query
 * Uses Index: IDX-TSK-03 { orderId: 1, isOpen: 1 }
 */
const orderOpenTasks = await TaskCollection.find({
  orderId: targetOrderId,
  isOpen: true
})
  .limit(50) // Bounded limit
  .lean();
```
- **Execution Plan Expectations:** Highly selective index scan on `IDX-TSK-03`.

### 4.3 Evidence Playback Query
```javascript
/**
 * Proposed Evidence Playback Query
 * Uses Index: IDX-EVT-02 { taskId: 1, sequenceNumber: 1 }
 */
const taskEvents = await EventCollection.find({
  taskId: targetTaskId
})
  .sort({ sequenceNumber: 1 }) // Strictly ordered via BSON Long index
  .limit(100)                  // Max events per task lifecycle
  .lean();
```
- **Execution Plan Expectations:** Index scan on `IDX-EVT-02`. Zero memory sort (`SORT` stage avoided because index provides natural sort order).

---

## 5. Deployment Preflight and Missing Index Behavior

In conformance with `lib/recovery/adapter.js` and rule D03 (`INDEX_ABSENT_SUSPECTED`):
1. **Never Assume Indexes:** The application code must never assume that proposed indexes have been deployed.
2. **Missing Index Detection:** A preflight probe (`admin/deploy/indexes`) must explicitly inspect `db.collection.getIndexes()` during operational readiness checks.
3. **Fail-Closed on Missing Uniqueness:** If `IDX-TSK-02` (partial unique finding identity index) or `IDX-EVT-02` (sequence uniqueness index) is missing in an operational environment, the recovery worker must refuse to start in automatic mode. Operating a distributed recovery queue without unique constraints would allow race conditions and duplicate task execution.
4. **Index Synchronization Prohibition:** No application code may execute `TaskModel.syncIndexes()`. Schema index declarations with auto-sync risk locking collections or causing unexpected downtime on production databases. All index provisioning must occur via reviewed DBA change tickets under gate **G-IDX-1**.
