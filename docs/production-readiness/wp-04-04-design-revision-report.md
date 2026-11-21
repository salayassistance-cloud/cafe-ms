# WP-04-04 — Durable Recovery Persistence Design Revision Report

Status: **DESIGN REVISION COMPLETED — READ-ONLY — NO CODE AUTHORIZATION**  
Revision Date: 2026-11-10  
Repository: `C:\hotelms`  
Branch / HEAD: `main` / `69650435a6587d4577bc126f719fa1392bb934b3`  
Author: Architecture & Recovery Design Reviewer  
Work Package: **WP04-04 (Design Revision Report)**  
Parents: `wp-04-04-persistence-design.md`, `wp-04-04-concurrency-and-lease-analysis.md`, `wp-04-04-index-and-query-proposal.md`, `wp-04-04-acceptance-and-open-decisions.md`, `wp-04-00-authorization-record.md`  

---

## 1. Executive Summary

This report formalizes the architectural corrections and policy reconciliations applied to the WP04-04 design suite for BONO Inventory V2.

The revision was conducted strictly under **documentation-only design revision authority**. No source code, Mongoose schema, API route, background worker, scheduler, or database configuration was modified. No MongoDB connection was established, no secrets or credentials were read, and no operational changes were executed.

The revision successfully resolves the six identified technical, concurrency, and governance conflicts:
1. **Item-Level Task Identity (WD-10 Preservation):** Replaced the problematic one-open-task-per-order restriction with an item-level finding identity model, preventing the silent suppression of multiple distinct defects on a single order.
2. **Concurrency-Safe Monotonic Event Sequencing:** Replaced client-side sequence estimation with an atomic sequence counter on the task document protected by UUID lease fencing.
3. **Sensitive-Data and Payload Hardening:** Completely removed account numbers and masked fragments (`****1234`), eliminated unconstrained free-text fields, and replaced arbitrary payload objects with bounded enum codes.
4. **Immediate Read-Only Architecture:** Re-affirmed zero automatic repair authority and clarified that `RESOLVED` in read-only mode denotes exclusively `ALREADY_CORRECT` (natural convergence via live V1 workflow).
5. **Topology-Conscious State/Event Consistency:** Evaluated multi-document ACID transactions against an idempotent event-first model, establishing that transaction guarantees must not be assumed without empirical disposable replica-set proof.
6. **Canonical Stable Identity:** Reconciled disparate ID formulations into a single, versioned, delimiter-safe canonical format: `REC:v1:<sha256_32hex>`.

---

## 2. Identified Issues and Resolutions

### Issue 1: Recovery Task Identity and Uniqueness (WD-10 Conflict)
- **Problem:** The initial design proposed a partial unique index on `{ orderId: 1, isOpen: true }`. This suppressed subsequent distinct defects on different items of the same order, forced unnatural multi-defect merging, and directly violated **WD-10** ("item-level first; mandatory line-level deferred").
- **Resolution:**
  - Evaluated three architectural models: Option A (order-level uniqueness), Option B (finding-level uniqueness), and Option C (parent-child session hierarchy).
  - Selected and proposed **Option B (Unique Open Task per Finding Identity)**. Finding identity is defined by the deterministic tuple `(ruleId, code, orderId, itemId, lineId)`.
  - Replaced the partial unique index on `orderId` with `IDX-TSK-02` on `{ findingIdentityKey: 1 }` where `isOpen: true`.
  - Added non-unique compound index `IDX-TSK-03` on `{ orderId: 1, isOpen: 1 }` for rapid order-level correlation without forcing a single-task bottleneck.
  - Cataloged this choice as a formal proposal requiring owner approval under **OD-23**.

### Issue 2: Concurrency-Safe Append-Only Event Sequencing
- **Problem:** The initial design lacked a safe sequence allocation protocol, leaving the append-only event log vulnerable to race conditions, sequence collisions, and desynchronization between task state and event records.
- **Resolution:**
  - Designed an atomic sequence counter mechanism: the task document maintains `eventSequenceCounter: Number`, incremented atomically via `$inc` inside a lease-fenced `findOneAndUpdate`.
  - Enforced sequence uniqueness via `IDX-EVT-02` on `{ taskId: 1, sequenceNumber: 1 }`.
  - Defined explicit handling for asynchronous failure modes:
    - *Task counter updates, but event insert fails:* Results in a benign sequence gap (e.g., seq 1, 2, 4) that does not break monotonic ordering.
    - *Event inserts, but task update fails:* Reclaimed by subsequent worker via event log inspection.
    - *Unknown commit on event insert:* Worker queries `{ taskId, sequenceNumber }` to confirm write before retrying; blind retries are prohibited.
  - Explicitly demarcated multi-document ACID transactions as an unverified deployment assumption.

### Issue 3: Evidence and Sensitive-Data Controls
- **Problem:** The initial draft permitted masked account numbers (`****1234`), unconstrained string fields (`diagnosticMessage`, `lastErrorMessage`, `unresolvedQuestion`, `whatWasAttempted`), and arbitrary objects (`actionResult`, `expectedVsActual`), creating data leakage and prompt/payload injection risks.
- **Resolution:**
  - **Total Account Number Exclusion:** Removed all account number and masked fragment references. In accordance with `wp04-evidence-v1`, only `paymentAccountId` (an identifier/ObjectId tag) and boolean `paymentAccountSnapshotPresent` are projected.
  - **Elimination of Free-Text:**
    - `diagnosticMessage` $\rightarrow$ `diagnosticCode: String` (bounded enum: `DOC_CORRUPT`, `INDEX_ABSENT`, `TIMEOUT`, `LEASE_EXPIRED`, `SCHEMA_MISMATCH`, `DRIFT_DETECTED`).
    - `lastErrorMessage` $\rightarrow$ `lastErrorCode: String` and `lastErrorField: String|null` (sanitized schema path).
    - `unresolvedQuestion` $\rightarrow$ `escalation.code: String` (bounded enum: `ESC_UNKNOWN_COMMIT`, `ESC_EVIDENCE_DRIFT`, `ESC_EXHAUSTED`, `ESC_MANUAL_RULE`).
    - `whatWasAttempted` $\rightarrow$ `attemptedAction: String` (bounded enum: `NONE`, `VERIFY_ONLY`, `RE_READ_EVIDENCE`).
  - **Strict Structure Hardening:**
    - `expectedVsActual` $\rightarrow$ `escalation: { expectedStatus, actualStatus, expectedQuantity, actualQuantity }` restricted strictly to enums and finite numbers.
    - `actionResult` $\rightarrow$ `actionResult: { verified: Boolean, observedFingerprint: String }`.
  - **Enforcement:** Mandated recursive execution of `assertNoSensitiveKeys()` and strict allowlist validation prior to any persistence operation.

### Issue 4: Read-Only Boundary and Execution Separation
- **Problem:** Ambiguity in the initial review implied that recovery workers could actively execute repairs and conflated `RESOLVED` with active repair writes.
- **Resolution:**
  - Re-affirmed that the immediate recovery architecture possesses **zero repair authority**.
  - Formally clarified that `resolution: "APPLIED"` is strictly disabled in read-only mode.
  - Defined that `RESOLVED` can only mean `resolution: "ALREADY_CORRECT"`, occurring when a fresh evidence re-read proves that the divergence cleared naturally via live cashier, waiter, or kitchen transactions.
  - Architecturally separated detection, review, approval, execution, and verification into distinct future milestones requiring separate owner authorization.

### Issue 5: Task/Event Consistency Models
- **Problem:** The initial draft assumed atomic multi-document transaction availability across task updates and event inserts without assessing topology dependencies.
- **Resolution:**
  - Evaluated three consistency models:
    - *Model 1 (Multi-Document ACID Transaction):* Provides full all-or-nothing atomicity but mandates an active replica set, failing on standalone MongoDB or during failover elections.
    - *Model 2 (Idempotent Event-First with Pending State):* Works on all topologies, preserves immutable intent first, but requires reconciliation of pending states upon lease reclamation.
    - *Model 3 (Lease-Fenced Atomic Task Counter followed by Idempotent Event Insert):* Provides single-document atomicity for counter allocation across any topology, with sequence gaps handling aborted attempts.
  - Established that transaction guarantees must not be claimed until empirically validated by disposable replica-set tests in WP04-05. Proposed Model 3 as the robust baseline.

### Issue 6: Stable Canonical Identity
- **Problem:** Disparate ID formats were present across early working drafts (`RECOVERY:<orderId>`, `REC:<orderId>:<findingDedupeHash>`, `REC:<orderId>:<rule>:<subCode>:<itemId>:<lineId>`).
- **Resolution:**
  - Standardized on a single, deterministic, versioned, delimiter-safe format:
    $$\text{taskId} = \text{REC:v1:} \langle \text{SHA-256}(\text{canonicalJson}(\text{ruleId}, \text{code}, \text{orderId}, \text{itemId}, \text{lineId}))[0..32] \rangle$$
  - Hashing canonical JSON avoids delimiter injection attacks (e.g. colons inside identifiers) and guarantees fixed-width, indexed strings.
  - Defined non-unique grouping key `taskKey = GRP:<orderId>` for order-level lookups.

---

## 3. Policy vs. Proposed Design Demarcation

| Area | Approved Owner Policy (WD-01 to WD-14) | Proposed Design (WP04-04 Revision) | Unverified Deployment Assumption |
|---|---|---|---|
| **Lifecycle States** | Exactly seven approved states. | Strict enum enforcement; no `AWAITING_APPROVAL` status. | None. Single-document state transitions verified. |
| **Identity Scoping** | WD-10: Item-level first; line-level deferred. | Option B: Unique open task per finding identity key (`IDX-TSK-02`). | WiredTiger partial index filtering performance. |
| **Audit Ledger** | WD-07: Append-only evidence history. | Dedicated `inventory_recovery_events` collection; atomic sequence counter. | Multi-document transaction availability across collections (Unverified). |
| **Sensitive Data** | Prohibit passwords, PINs, tokens, and credentials. | Total exclusion of account numbers and fragments; zero free text; bounded enums only. | In-memory regex throughput under high finding volume. |
| **Repair Authority** | WD-01, WD-05, WD-06: No auto-repair, hold release, or shortage correction. | Read-only architecture; `APPLIED` resolution disabled; `RESOLVED` = `ALREADY_CORRECT` only. | None. Structurally enforced. |
| **Operational Values** | WD-08: Lease duration and retries are provisional test inputs. | 5-minute lease and 5 attempts documented as provisional; configurable via env/options. | NTP clock synchronization between worker nodes. |

---

## 4. Revised Index Proposal Summary

| Collection | Identifier | Key Pattern | Options | Access Pattern |
|---|---|---|---|---|
| `inventory_recovery_tasks` | `IDX-TSK-01` | `{ taskId: 1 }` | `unique: true` | Primary deterministic finding identity. |
| `inventory_recovery_tasks` | `IDX-TSK-02` | `{ findingIdentityKey: 1 }` | `partialFilterExpression: { isOpen: true }`<br>`unique: true` | **WD-10 Integrity Index:** Prevents duplicate open tasks per finding identity. |
| `inventory_recovery_tasks` | `IDX-TSK-03` | `{ orderId: 1, isOpen: 1 }` | Compound (Non-unique) | Order-level triage; retrieves all findings on an order. |
| `inventory_recovery_tasks` | `IDX-TSK-04` | `{ status: 1, isOpen: 1, nextAttemptAt: 1, leaseUntil: 1 }` | Compound | Worker queue polling and lease reclamation. |
| `inventory_recovery_tasks` | `IDX-TSK-05` | `{ leaseOwner: 1, leaseUntil: 1 }` | `partialFilterExpression: { isOpen: true }` | Worker heartbeat and orphaned lease tracking. |
| `inventory_recovery_tasks` | `IDX-TSK-06` | `{ status: 1, severity: 1, createdAt: 1 }` | `partialFilterExpression: { status: "MANUAL_REQUIRED" }` | Operations escalation FIFO queue. |
| `inventory_recovery_events` | `IDX-EVT-01` | `{ eventId: 1 }` | `unique: true` | Immutable event document identity. |
| `inventory_recovery_events` | `IDX-EVT-02` | `{ taskId: 1, sequenceNumber: 1 }` | `unique: true` | **Strict Sequence Guarantee:** Enforces ordered event stream. |
| `inventory_recovery_events` | `IDX-EVT-03` | `{ orderId: 1, timestamp: -1 }` | Compound | Order audit history playback. |
| `inventory_recovery_events` | `IDX-EVT-04` | `{ eventType: 1, timestamp: -1 }` | Compound | Security and operational telemetry queries. |
| `inventory_recovery_events` | `IDX-EVT-05` | `{ actorId: 1, timestamp: -1 }` | Compound | Compliance auditing of actor activities. |

---

## 5. Register of Unresolved Owner Decisions

The authoritative owner decision register now tracks 23 items. The critical decisions governing persistence implementation are:

1. **OD-23 (Open-Task Scoping Architecture — NEW):** Formal approval of Option B (Unique Open Task per Finding Identity) versus Option C (Parent Session with Child Tasks).
2. **OD-10 (Schema Contracts):** Formal approval of the revised schema contracts for `inventory_recovery_tasks` and `inventory_recovery_events`.
3. **OD-4 (Retention Horizon):** Retention period for recovery tasks, evidence, and audit events (e.g. 7 years financial vs indefinite).
4. **OD-9 (Operational Lease Parameters):** Production approval of lease duration, retry backoff schedule, jitter, and attempt limits.
5. **OD-7 (Operational Alert Sinks):** Specification of alert routing destinations (Slack, PagerDuty, Email) and escalation response SLAs.
6. **OD-18 (Staging Acceptance Gate G-PAY-1):** Remains **BLOCKED**, preventing end-to-end staging validation.

---

## 6. Implementation Blockers for Future Packages

Before WP04-05 (Disposable Replica-Set Proof) or subsequent packages may begin:
1. **Explicit AUTH-2 Authorization:** A dedicated ticket authorizing disposable replica-set database work must be issued.
2. **Owner Decision Sign-off:** OD-10 (Schemas) and OD-23 (Finding Scoping) must be formally approved.
3. **Loopback-Only Isolation Enforcement:** Test harnesses must verify loopback-only connections with zero access to staging or production URIs.
4. **Multi-Document Transaction Proof:** WP04-05 must empirically prove whether the target MongoDB topology supports multi-document transactions before Model 1 consistency can be adopted.

---

## 7. Baseline Preservation and Negative Confirmations

| Metric | Preflight Baseline | Post-Revision State | Verification |
|---|---|---|---|
| **Git Branch** | `main` | `main` | Verified identical |
| **Commit HEAD** | `69650435a6587d4577bc126f719fa1392bb934b3` | `69650435a6587d4577bc126f719fa1392bb934b3` | Verified identical |
| **Modified Files** | 61 files | 61 files | 100% Preserved |
| **Staged Files** | 0 files | 0 files | Clean |
| **Untracked Baseline** | 75 entries | 75 entries + 6 docs | Additive docs only |

### Explicit Negative Confirmations:
1. **No Code Implemented:** Persistence schemas, models, repositories, and workers were revised in design documents only; no application source code was authored or altered.
2. **No File Mutation:** Zero existing source files, test files, configuration files, or environment files were modified or deleted.
3. **No Database Contact:** Zero connections were opened to MongoDB (local, disposable, staging, or production).
4. **No Secret Access:** Neither `.env`, `.env.local`, nor any system credentials or connection strings were read.
5. **No Index Deployment:** No index, collection, or database migration was executed.
6. **No Automation Enabled:** No background workers, schedulers, cron jobs, or queues were created or activated.
7. **No V2 Activation:** Inventory V2 remains completely inactive.

---

## 8. Mandatory Stop Point

**STOP POINT REACHED.**  
Work Package **WP04-04 (Design Revision)** is complete. All identified technical and policy conflicts have been resolved in the design artifacts. Further implementation requires a separate explicit authorization ticket and resolution of blocking owner decisions.

