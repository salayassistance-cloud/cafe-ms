# WP-04-04 — Concurrency, Lease, and Crash Safety Analysis (Final Technical Clarification)

Status: **FINAL TECHNICAL CLARIFICATION — DESIGN SPECIFICATION ONLY — NO CODE AUTHORIZATION**  
Revision Date: 2026-11-10  
Repository: `C:\hotelms`  
Branch / HEAD: `main` / `69650435a6587d4577bc126f719fa1392bb934b3`  
Author: Architecture & Recovery Design Reviewer  
Work Package: **WP04-04 (Concurrency & Lease Analysis Clarification)**  
Parents: `wp-04-recovery-state-machine.md`, `wp-04-persistence-design.md`, `wp-04-00-authorization-record.md`  

> **MANDATORY NOTICE & BOUNDARIES:**  
> This analysis is a design clarification only. **No implementation authorization is granted.** No background worker, queue, or scheduler is enabled or deployed. All lease durations and retry counts mentioned are provisional test inputs and must not be treated as approved production values. Multi-document transaction atomicity is an unverified deployment assumption requiring replica-set infrastructure.

> **AMENDMENT 2026-11-12 — WP04-06 DESIGN CONSOLIDATION (see `wp-04-06-design-consolidation-and-register.md`):**
> 1. **§2.2 claim primitive (CL-AM1):** the claim filter gains the positive unresolved-operation predicate `U_claim` — `$or: [{ pendingOperation: null }, { "pendingOperation.state": { $in: ["COMMITTED", "ABANDONED"] } }]` — inside the `$and` claim structure, and `leaseGeneration` increments **in the same write** as every acquisition/reclamation (T9/Acquire amendment).
> 2. **§4.3 (CL-AM2):** the re-insert-on-unknown persistence retry is superseded for O2 operation flows (reserve/effect/abandon) by the R3 §6.2 adoption-only rule and §13.2 R6: on unknown commit the worker observes (`UNKNOWN_COMMIT`), leaves the operation `PREPARED`, and never re-runs the body or mints a new identity. Step 3 of §4.3 remains valid only for pure event-publish writes, not operation writes.
> 3. **§3.1 (CL-AM3):** event-time sequence allocation (`seq = task.eventSequenceCounter + 1` at publish time) is superseded for O2 operation flows by reservation-time allocation (R3 §15.1/§22.4.2): transition events and operation reservations are distinct single-slot consumers in separate transactions; W7 effect writes never increment the counter.
> Approved: OD-24 (H1), OD-27-SC, OD-30 (task CAS is the fence; H1 history record is not), OD-37 (`ABANDONABLE_STATUSES = {LEASED}`), I-C standalone `T_reserve`.

---

## 1. Concurrency Model and Contention Vectors

In a multi-process hotel deployment, recovery state tracking contends with two distinct classes of concurrent activity:
1. **Recovery Worker Contention:** Multiple recovery worker instances or CLI processes attempting to claim, update, or escalate tasks.
2. **Live Operational Contention:** Live cashier, waiter, barista, kitchen display, and hotel reception transactions modifying orders, reservations, or inventory stock while recovery processes are inspecting them.

Under the item-level finding identity model (preserving **WD-10: item-level first**), multiple distinct findings may exist for the same order (e.g., Item A under-reserved, Item B missing consumption). The concurrency architecture provides:
- **Independent Finding-Level Leases:** Each finding task maintains its own atomic lease, fencing generation, and fencing token, allowing independent triage of distinct items without bottlenecking the order.
- **Monotonic Fencing Generations (`leaseGeneration`):** Every lease acquisition atomically increments a monotonic integer generation, immediately invalidating all prior workers.
- **Topology-Gated Multi-Document Atomicity:** Multi-document task/event consistency requires a transaction-capable replica set as an explicit prerequisite; standalone MongoDB provides single-document atomicity only.
- **Strict Precedence of Live V1 Operations:** Recovery operations yield immediately whenever a live business transaction changes evidence. Recovery never blocks, locks, or overrides POS operations.
- **Fail-Closed Lease Expiration:** A worker whose lease expires loses all write authority instantly. No "grace periods" or "best-effort writes" are permitted.

---

## 2. Monotonic Fencing Generations and Atomic Lease Acquisition

### 2.1 The Fencing Generation Protocol
To prevent split-brain execution and stale-worker corruption (e.g. when Worker A suffers an unannounced Garbage Collection pause or network stall while Worker B claims the task), lease ownership relies on two paired values:
1. `leaseToken`: A cryptographically random UUID string generated per acquisition.
2. `leaseGeneration`: A strictly monotonically increasing integer (`Long`) incremented atomically on the task document upon every lease state transition.

```text
 Worker A                               Database (MongoDB)                              Worker B
    |                                           |                                           |
    |-- acquire (gen: 1, token: UUID_A) ------->|                                           |
    |<-- Success (gen: 1, leaseUntil: +300s) ---|                                           |
    |                                           |                                           |
    | [ Worker A stalls / GC pause ]            |                                           |
    |                                           |-- acquire expired (gen: 2, UUID_B) ------>|
    |                                           |<-- Success (gen: 2, leaseUntil: +300s) ---|
    |                                           |                                           |
    |                                           |                                           | [ Worker B acts ]
    |                                           |                                           |
    | [ Worker A awakens ]                      |                                           |
    |-- write with (gen: 1, UUID_A) ----------->|                                           |
    |<-- FAILED (0 docs modified, gen!=1) ------|                                           |
    |                                           |                                           |
    X (Worker A halts immediately)              |                                           |
```

### 2.2 Atomic Claim Primitive (Clarified)

The atomic claim operation transitions an eligible task to `LEASED` in a single document-level atomic update:

```javascript
/**
 * Proposed Atomic Lease Acquisition Filter and Update
 * Enforces atomic single-claimant semantics per finding identity.
 */
function buildLeaseAcquisitionQuery(taskId, workerId, fencingToken, currentTime, leaseDurationMs) {
  const leaseExpiry = new Date(currentTime.getTime() + leaseDurationMs);

  const query = {
    taskId: taskId, // Canonical finding identity key (e.g., "REC:v1:<32-hex>")
    isOpen: true,
    $or: [
      // Condition A: Freshly detected task
      { status: "DETECTED" },

      // Condition B: Retry backoff has elapsed
      {
        status: "RETRY_SCHEDULED",
        nextAttemptAt: { $lte: currentTime },
        attempts: { $lt: 5 } // 5 is a PROVISIONAL test input (OD-9)
      },

      // Condition C: Prior lease has expired (Reclamation)
      {
        status: "LEASED",
        leaseUntil: { $lt: currentTime }
      },

      // Condition D: Human approval granted for manual task
      {
        status: "MANUAL_REQUIRED",
        approvedBy: { $ne: null },
        approvedAt: { $ne: null },
        executedBy: null // Has not yet been claimed for execution
      }
    ]
  };

  const update = {
    $set: {
      status: "LEASED",
      leaseOwner: workerId,
      leaseToken: fencingToken,
      leaseUntil: leaseExpiry,
      updatedAt: currentTime
    },
    $inc: {
      attempts: 1,        // Atomically charge the attempt counter
      leaseGeneration: 1  // Atomically bump monotonic fencing generation
    },
    $unset: {
      nextAttemptAt: ""
    }
  };

  return { query, update };
}
```

---

## 3. Lease Fencing and Event Publication Protocols: Architectural Comparison

Three publication protocols were evaluated to resolve the race between lease expiry, sequence counter allocation, and event insertion:

| Protocol | Mechanics | Advantages | Disadvantages & Topology Assumptions | Verdict |
|---|---|---|---|---|
| **Protocol 1: Multi-Document Replica-Set Transaction** | In a single transaction: verify `leaseGeneration`, increment `eventSequenceCounter`, insert event, update task status. | 100% atomic; zero sequence gaps; zero orphan events; split-brain impossible. | **Requires MongoDB Replica Set.** Unavailable on standalone MongoDB. Vulnerable to transaction write conflicts. | **RECOMMENDED BASELINE (with replica set prerequisite)** |
| **Protocol 2: Event-First Idempotent Pending Protocol** | Insert event with `status: "PENDING"` and `leaseGeneration`. Then update task. Reconcile on lease reclaim. | Works on standalone MongoDB; audit intent captured first. | High complexity; requires two-phase commits; pending event garbage collection; state pollution. | **REJECTED (Excessive Complexity)** |
| **Protocol 3: Lease-Fenced Counter with Sequence Gap Acceptance** | Atomically increment `eventSequenceCounter` on task with lease check; insert event; update status. | Works across all topologies; single-document atomicity on task. | If worker crashes between counter bump and event insert, sequence gap occurs (e.g. seq 1, 2, 4). | **ACCEPTABLE NON-TRANSACTIONAL FALLBACK** |

### 3.1 Recommended Architecture: Protocol 1 with Explicit Topology Prerequisite
- **The Prerequisite:** A transaction-capable replica set is an explicit prerequisite for guaranteeing multi-document atomicity between tasks and events.
- **Execution Flow (Transaction Mode):**
  ```text
  session.startTransaction()
  try:
    task = tasks.findOne({ taskId, leaseGeneration: currentGen, leaseUntil: { $gt: now } }, { session })
    if (!task) throw new LeaseLostError("Lease expired or generation bumped")
    
    seq = task.eventSequenceCounter + 1
    if (seq > 1000000) throw new SequenceOverflowError("Max sequence exceeded")
    
    tasks.updateOne({ taskId }, { $inc: { eventSequenceCounter: 1 }, $set: { status: newStatus } }, { session })
    events.insertOne({ eventId: `EVT:${taskId}:${seq}`, taskId, sequenceNumber: seq, leaseGeneration: currentGen, ... }, { session })
    
    session.commitTransaction()
  catch error:
    session.abortTransaction()
    throw error
  ```

---

## 4. Failure Scenarios and Edge-Case Reconciliation

### 4.1 Stale Generation Rejection at Event Publication
If Worker A attempts to publish an event after Worker B has reclaimed the lease:
- In Transaction Mode: Worker A's transaction checks `leaseGeneration == currentGen`. Worker B already incremented `leaseGeneration`. Worker A's query matches 0 documents; transaction aborts immediately.
- In Non-Transactional Fallback: The event insert includes `leaseGeneration`. Worker B's reclamation inspects the event log; any event carrying `leaseGeneration < activeGeneration` that is not reflected in the task state is rejected as an uncommitted attempt.

### 4.2 Sequence Gap Semantics
If a non-transactional counter increment commits, but the event insert fails:
- `eventSequenceCounter` is charged (e.g. from 3 to 4), but event 4 is never persisted.
- **Formal Invariant:** Sequence gaps (e.g. seq 1, 2, 3, 5, 6) are **benign indicators of aborted attempts**. Event stream ordering remains deterministic when sorted by `sequenceNumber: 1`. Sequence gaps do **not** invalidate audit integrity.

### 4.3 Recovery-Record Persistence Unknown Commit
If a network timeout occurs while writing an event or task update:
- **Zero Business Invocations:** The worker must **never** invoke any business service or business write.
- **Idempotent Reconciliation:**
  1. Worker queries `inventory_recovery_events.findOne({ eventId: "EVT:<taskId>:<seq>" })`.
  2. If the document exists: The event landed; worker proceeds to task status reconciliation.
  3. If the document does not exist: Worker retries the *exact same* event document under the *same* sequence number and fencing token.

> **AMENDMENT 2026-11-12 (see `wp-04-06-design-consolidation-and-register.md` §4 CL-AM2):** the re-insert-on-unknown retry above is superseded for O2 operation flows (reserve/effect/abandon) by the R3 §6.2 adoption-only rule and §13.2 R6: on unknown commit the worker observes (`UNKNOWN_COMMIT`), leaves the operation `PREPARED`, and never re-runs the body or mints a new identity (OD-27-SC permits bounded same-identity replay only after a writer-observed **definitive abort**, never inside an unknown-commit window). Step 3 remains valid only for pure event-publish writes, not operation writes.

---

## 5. Domain A: Business Unknown Commit Handling (100% Read-Only)

To prevent any confusion with persistence retries, the handling of business unknown commits in V1 is clarified:

```text
                  +----------------------------------------------+
                  |  Business Operation Unknown Commit in V1     |
                  |  (e.g., cashier payment timeout at POS)      |
                  +----------------------+-----------------------+
                                         |
                                         v
                  +----------------------------------------------+
                  |   Recovery Plane: Fresh Authoritative Read   |
                  |   via adapter.collectEvidence() (Read-Only)  |
                  +----------------------+-----------------------+
                                         |
                                         v
                  +----------------------------------------------+
                  |   Is Business Effect Present in V1 State?    |
                  +----------------------+-----------------------+
                                         |
                       +-----------------+-----------------+
                       |                                   |
                       v YES                               v NO
            +---------------------+             +----------------------+
            | Divergence cleared: |             | Divergence remains:  |
            | RESOLVED            |             | Escalate:            |
            | (ALREADY_CORRECT)   |             | MANUAL_REQUIRED      |
            +---------------------+             | (NO BUSINESS RETRY!) |
                                                +----------------------+
```

- **Strict Invariant:** The absence of a business effect (e.g. no payment record, no stock movement) **never authorizes a recovery retry or write**. The task transitions to `MANUAL_REQUIRED` with escalation code `ESC_BUSINESS_UNKNOWN_COMMIT` for human triage.

---

## 6. Provisional Nature of Lease and Retry Values (Mandatory Warning)

> [!WARNING]  
> **FORMAL DEMARCATION: PROVISIONAL TEST INPUTS ONLY**  
> Per approved owner decision **WD-08** and `wp-04-owner-decision-proposal.md`:
> - The **5-minute lease duration** is a **provisional test input**.
> - The **5-attempt ceiling** (`attempts < 5`) is a **provisional test input**.
> - The **retry backoff sequence** (`[0s, 30s, 60s, 120s, 240s]`) is a **provisional test input**.
>
> **THESE ARE NOT APPROVED OPERATIONAL VALUES.**  
> Setting production timeouts, jitter algorithms, maximum retries, and escalation ceilings requires formal owner review under **Owner Decision OD-9**. Operating these values in staging or production without explicit authorization is strictly prohibited.
