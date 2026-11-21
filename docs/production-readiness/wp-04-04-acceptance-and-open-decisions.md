# WP-04-04 — Acceptance Criteria, Unknown Commit Contract, and Open Decisions (Final Technical Clarification)

Status: **FINAL TECHNICAL CLARIFICATION — DESIGN SPECIFICATION ONLY — NO CODE AUTHORIZATION**  
Revision Date: 2026-11-10  
Repository: `C:\hotelms`  
Branch / HEAD: `main` / `69650435a6587d4577bc126f719fa1392bb934b3`  
Author: Architecture & Recovery Design Reviewer  
Work Package: **WP04-04 (Acceptance & Open Decisions Clarification)**  
Parents: `wp-04-reconciliation-design.md`, `wp-04-recovery-state-machine.md`, `wp-04-owner-decision-proposal.md`  

> **MANDATORY NOTICE & BOUNDARIES:**  
> This document specifies acceptance criteria, decision trees, and owner governance contracts. **No implementation authorization is granted.** Implementation of WP04-05 or any subsequent package remains blocked until the prerequisite owner decisions are formally approved.

---

## 1. Disambiguation: Business Unknown Commit vs Recovery Persistence Unknown Commit

To eliminate architectural confusion, two fundamentally different failure domains are strictly separated:

### 1.1 Domain A: Business-Operation Unknown Commit (V1 POS / Orders / Inventory)
- **Context:** A business transaction (e.g. payment submission, stock deduction, reservation release) executed in V1 encounters a network timeout or unknown commit result.
- **Recovery Invariants:**
  1. **Strict Read-Only Stance:** The recovery plane acts exclusively as a fresh authoritative observer via `lib/recovery/adapter.js`.
  2. **Zero Business Writes:** The recovery plane is **never** authorized to retry, compensate, repair, or re-issue a business transaction.
  3. **Absent Effect Rule:** An absent business effect (e.g. `StockMovement` missing after order marked `PAID`) **never authorizes a recovery business write**. The task transitions to `MANUAL_REQUIRED` with escalation code `ESC_BUSINESS_UNKNOWN_COMMIT`.
  4. **`RESOLVED` Semantics:** `RESOLVED` remains strictly restricted to `resolution: "ALREADY_CORRECT"`, occurring solely when fresh authoritative evidence proves that regular staff completed the workflow naturally.

### 1.2 Domain B: Recovery-Record Persistence Unknown Commit (Metadata Writes)
- **Context:** A recovery process writes metadata to `inventory_recovery_tasks` or `inventory_recovery_events`, and write acknowledgment is lost.
- **Recovery Invariants:**
  1. **Metadata-Only Scope:** Recovery metadata retries **never touch business collections** and **never invoke business services**.
  2. **Idempotent Recovery:**
     - For Events: Worker queries `inventory_recovery_events.findOne({ eventId: "EVT:<taskId>:<seq>" })`. If found, write succeeded. If absent, retry *exact same* event.
     - For Tasks: Worker queries `inventory_recovery_tasks.findOne({ taskId: targetTaskId })` and evaluates `leaseGeneration` and `status`.

---

## 2. Separation of Duties and Authorization Matrix

Per approved owner decision **WD-03**, human governance enforces strict separation of duties using role placeholders. No single individual or role may unilaterally authorize, execute, and verify a recovery task.

### 2.1 Role Placeholder Definitions

| Role Placeholder | Authorized Responsibilities | Prohibited Actions |
|---|---|---|
| `ROLE-TECHNICAL-LEAD` | Architecture review, index approvals, system configuration, verifier of technical recovery outcomes. | Cannot execute manual inventory writes or approve stock write-offs. |
| `ROLE-DATA-OWNER` | Policy definitions, evidence retention approvals, sign-off on data divergence resolutions. | Cannot perform independent verification of technical implementations. |
| `ROLE-INVENTORY-MANAGER` | Approver of physical stock adjustments, manager overrides, and shortage allowances. | Cannot act as the independent verifier (`verifierId`) of their own approvals. |
| `ROLE-RECOVERY-EXECUTOR` | Human operator or designated service identity executing an approved manual review plan. | Cannot approve the task (`approvedBy`) or verify the task (`verifierId`). |

### 2.2 Formal Separation Invariants

$$\text{approvedBy} \neq \text{executedBy}$$
$$\text{verifierId} \neq \text{approvedBy}$$
$$\text{verifierId} \neq \text{executedBy}$$

Any attempt to submit a `CLOSED` transition where `verifierId == executedBy` or `verifierId == approvedBy` must fail immediately with a typed authorization error: `SEPARATION_OF_DUTIES_VIOLATION`.

---

## 3. Comprehensive Acceptance Test Matrix (WP04-05 Requirements)

The future WP04-05 package must validate the recovery persistence architecture against both unit test doubles (DB-free) and an isolated, disposable replica set. The test matrix requires fifteen explicit test conditions:

| ID | Test Scenario | Execution Level | Expected Behavior |
|---|---|---|---|
| **TEST-01** | Concurrent lease acquisition | L2 (Disposable Replica Set) | Two workers attempt to claim the same task simultaneously. Exactly one worker wins; the loser receives `matchedCount: 0` and yields cleanly. |
| **TEST-02** | Expired lease rejection | L2 (Disposable Replica Set) | A worker whose `leaseUntil` timestamp has passed attempts a state update. The update matches 0 documents; worker fails closed. |
| **TEST-03** | Stale fencing generation rejection | L2 (Disposable Replica Set) | Worker A holds `leaseGeneration: 1`. Worker B reclaims the task, bumping `leaseGeneration: 2`. Worker A attempts write. Rejected due to mismatched generation. |
| **TEST-04** | Lease expiry between counter allocation and event insertion | L2 (Disposable Replica Set) | Worker acquires lease and bumps sequence counter. Lease expires before event insertion. Reclaiming worker detects stale generation; transaction aborts or gap is recorded. |
| **TEST-05** | Counter increment with failed event insertion | L2 (Disposable Replica Set) | Sequence counter increments, but event `insertOne` simulates socket failure. Sequence gap is created (e.g. seq 1, 2, 4); audit playback asserts gap is benign and order preserved. |
| **TEST-06** | Event insertion with lost acknowledgment | L2 (Disposable Replica Set) | Event inserts successfully, but client loses ack. Client re-queries `{ taskId, sequenceNumber }`, observes record present, avoids double-insert. |
| **TEST-07** | Duplicate event identity | L2 (Disposable Replica Set) | Attempt to insert duplicate `eventId: "EVT:<taskId>:<seq>"`. Rejected by unique index `IDX-EVT-01` with duplicate key error `11000`. |
| **TEST-08** | Duplicate sequence rejection | L2 (Disposable Replica Set) | Attempt to insert two distinct events with identical `{ taskId, sequenceNumber }`. Rejected by unique index `IDX-EVT-02`. |
| **TEST-09** | Sequence overflow guard | L0 / L1 (Unit / Fakes) | Sequence counter approaches `MAX_SEQUENCE_NUMBER = 1,000,000`. Counter query filter `{ eventSequenceCounter: { $lt: 1000000 } }` fails closed; emits `SEQUENCE_OVERFLOW`. |
| **TEST-10** | Concurrent independent findings on one order | L2 (Disposable Replica Set) | Order 123 suffers defects on Item A and Item B simultaneously. Both tasks insert successfully with distinct `findingIdentityKey` values; `IDX-TSK-03` retrieves both. |
| **TEST-11** | Business unknown commit with zero business writes | L1 / L2 | Simulated timeout on V1 payment. Recovery scanner performs fresh read, discovers missing payment effect, transitions to `MANUAL_REQUIRED`; executes ZERO business writes. |
| **TEST-12** | Recovery metadata unknown commit with idempotent reconciliation | L2 (Disposable Replica Set) | Timeout on task status update. Recovery worker reconciles task document from event ledger without invoking business services. |
| **TEST-13** | Recursive sensitive-field rejection | L0 (DB-Free Unit) | Synthetic event payloads containing `accountNumber`, `pin`, `token`, or `password` at arbitrary nesting depths are rejected by `assertNoSensitiveKeys()`. |
| **TEST-14** | Standalone MongoDB transaction-unavailable behavior | L1 / L2 (Standalone) | In a standalone environment without replica set, multi-document transaction attempts fail closed cleanly with typed error `TRANSACTIONS_UNAVAILABLE`. |
| **TEST-15** | Replica-set transaction success and rollback behavior | L2 (Disposable Replica Set) | In a replica set, multi-document task update + event insert commits atomically. Simulated error during event insert cleanly rolls back task update. |

---

## 4. Register of Unresolved Owner Decisions and WP04-05 Blocking Status

The authoritative register tracks 23 owner decisions. The table below details the active status and explicit blocking status for WP04-05 technical proof versus later operational activation:

| ID | Topic | Current Status | Blocks WP04-05 Disposable Proof? | Blocks Operational Activation? |
|---|---|---|---|---|
| **OD-04** | Task, Evidence, and Audit Retention Horizon | **UNRESOLVED** | **NO** (Disposable replica set is dropped after tests; no retention needed). | **YES** (Operational deployment cannot define TTL or archiving without this). |
| **OD-07** | Operational Alert Routing, SLA, and On-Call Sinks | **UNRESOLVED** | **NO** (WP04-05 runs synthetic tests with in-memory logging; no paging required). | **YES** (Operational worker cannot run without approved on-call escalation sinks). |
| **OD-09** | Production Lease Duration, Retry Schedule, and Jitter | **UNRESOLVED** | **NO** (WP04-05 explicitly uses provisional test inputs: 5 min lease, 5 attempts). | **YES** (Production timeouts require explicit owner approval). |
| **OD-10** | Exact Recovery Task and Event Schema Contracts | **PROPOSED** | **YES** (WP04-05 cannot write Mongoose/Mongo models without approved schema contract). | **YES** (Production schemas must match approved contracts). |
| **OD-23** | Open-Task Scoping Architecture (Option B vs Option C) | **PROPOSED** | **YES** (WP04-05 index and uniqueness tests depend on Option B finding-level identity). | **YES** (Database uniqueness constraints depend directly on this decision). |

---

## 5. Strict Governance and Safety Boundary

- **No Automatic Approval:** Decisions OD-04, OD-07, OD-09, OD-10, and OD-23 remain formally unapproved.
- **No Personnel Named:** All roles remain defined exclusively by role placeholders (`ROLE-TECHNICAL-LEAD`, `ROLE-DATA-OWNER`, `ROLE-INVENTORY-MANAGER`, `ROLE-RECOVERY-EXECUTOR`).
- **Prerequisites for WP04-05 Authorization:**
  1. Explicit owner sign-off on **OD-10** (Schema contracts) and **OD-23** (Finding-level uniqueness architecture).
  2. Issuance of a formal **AUTH-2** authorization ticket naming WP04-05.
  3. Verification of disposable, loopback-only replica set isolation with zero access to staging or production URIs.
