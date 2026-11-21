# WP-04 — Durable Recovery State Machine

Status: **DESIGN CONTRACT — OFFLINE WRITER SOURCE EXISTS; NOT DEPLOYED, NOT RUNTIME-AUTHORIZED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch / HEAD: `main` / `69650435a6587d4577bc126f719fa1392bb934b3`
Parent: `wp-04-reconciliation-design.md`
Companions: `wp-04-detection-rule-matrix.md`, `wp-04-test-and-acceptance-plan.md`
Related approved design: `phase-2-4-recovery-readiness.md`, Phase 2.5 WP-05/WP-06/WP-07

> This document defines a lifecycle, lease, retry, escalation, evidence, audit, and alerting contract. It does **not** create a collection, model, index, worker, queue, cron, route, environment variable, or migration. It does **not** execute recovery. No database was contacted. No stock, payment, order, reservation, movement, or audit record was changed. Inventory V2 remains inactive.

> **AMENDMENT 2026-11-12 — WP04-06 DESIGN CONSOLIDATION (see `wp-04-06-design-consolidation-and-register.md`):**
> 1. **§6.2 Acquire / T9 (SM-AM1):** the claim filter gains the positive unresolved-operation predicate `U_claim` — `$or: [{ pendingOperation: null }, { "pendingOperation.state": { $in: ["COMMITTED", "ABANDONED"] } }]` — and the update gains `$inc: { leaseGeneration: 1 }` in the same write. The `$inc` block in the pseudocode below omits `leaseGeneration`; the fenced-write contract in `wp-04-04-concurrency-and-lease-analysis.md` §2.2 (as amended) is authoritative.
> 2. **§7.3 (SM-AM2):** the V1-evidence escalation path is superseded for O2 operation flows by the R3 §6.2/§16 rules: V1 evidence is **never** abort proof; no evidence-based automatic escalation; `UNKNOWN_COMMIT` is observed-only and the operation stays `PREPARED`.
> 3. **§10.3 audit rows (SM-AM3):** event-time sequence allocation is superseded for O2 operation flows by reservation-time allocation (R3 §15.1/§22.4.2): transition events and operation reservations are distinct single-slot consumers in separate transactions; W7 effect writes never increment `eventSequenceCounter`.
> All numerical values remain provisional test inputs (OD-09 is test-derived, not invented). Approved decision register: OD-24 (H1), OD-27-SC, OD-30, OD-33, OD-37 (`ABANDONABLE_STATUSES = {LEASED}`), I-C standalone `T_reserve`.

> **AMENDMENT 2026-11-12 — WP04-06 PACKAGE 4 OFFLINE SOURCE CLOSURE (see register §11):**
>
> 1. **Source status.** `lib/recovery/taskWriter.js` now carries an offline writer that is exercised only by DB-free, in-memory tests. This is **source-level only**. No collection, index, worker, queue, scheduler, cron, route, environment variable, or migration exists; no MongoDB was contacted; inventory V2 remains inactive. The design contract below is unchanged. Passing offline tests do **not** prove transaction isolation, deployed index uniqueness, real server-time CAS behaviour, or production readiness.
> 2. **Implemented transitions (offline source).** T1 `— → DETECTED` (W1); T2 `DETECTED → LEASED` (W2); T3 `DETECTED → CANCELLED` (W10, operator); T5 `LEASED → RESOLVED` (W7 `commitOperation`, plus W9 `resolveTask` for the already-correct path); T6 `LEASED → RETRY_SCHEDULED` (W5 `T-RETRY`, guarded by `attempts < maxAttempts`); T7 `LEASED → MANUAL_REQUIRED` (W5 `T-EXHAUST` / W12); T8 `LEASED → CANCELLED` (W10, worker lease identity); T9 expired-lease reclaim (W2, no `G_ATTEMPTS`); T10 `RETRY_SCHEDULED → LEASED` (W2); T12 `MANUAL_REQUIRED → LEASED` (W2 with an explicit `OPERATOR`, approval state/role/identity, and approver ≠ executor); T13 `MANUAL_REQUIRED → CANCELLED` (W10); T14 `RESOLVED → CLOSED` (W9 `closeTask`, explicit independent `VERIFIER`, `RECOVERY_VERIFIED`).
> 3. **Deferred, fail-closed.** T4 `DETECTED → MANUAL_REQUIRED`, T11 `RETRY_SCHEDULED → MANUAL_REQUIRED`, and T15 `RESOLVED → MANUAL_REQUIRED` have no writer row and fail closed. W4 `releaseLease` remains fail-closed and **OPEN** (no approved target status). W13/W14 remain deferred. `APPLIED` resolution remains disabled/read-only.
> 4. **W7 strictness.** The effect path accepts only the approved row `LEASED → RESOLVED` with `RECOVERY_RESOLVED`; arbitrary status pairs or event types are rejected before a session opens. It writes only `resolution`, `currentFingerprint`, `lastErrorCode`, `lastErrorField`, requires `resolution = ALREADY_CORRECT` plus a 64-hex fingerprint, rejects closure/cancellation/approval/verification/identity/lease injection, and preserves I-C (event at the reserved sequence, no `eventSequenceCounter` `$inc`) and H1 atomicity.
> 5. **W5 strictness.** `applyTransition` may run only `T-RETRY`, `T-EXHAUST`, and `T-APPROVE`; T5/T14 and the cancellation rows are rejected there. Each row has its own field allowlist, so privileged fields cannot be injected. `RECOVERY_APPROVED` is only emitted when the approval record actually is `APPROVED`; cancellation resolution stays writer-owned.
> 6. **Actor separation.** Worker rows require `WORKER`/`SERVICE-WORKER`; T12 requires an explicit authorized `OPERATOR` distinct from the approver with matching approval role; T14 requires an explicit `VERIFIER` distinct from both approver and executor; W8/W10/W11 require their own operator identity. W8 also requires authorization identity/role match, operation-bound authorization, task/operation lease-generation equality, and a valid non-null `leaseUntil`.
> 7. **Provenance.** `lib/models/RecoveryTask.js` and `RecoveryEvent.js` are **authored schema/index declarations** (`autoIndex: false`); **no index is deployed**. The only recorded OD-10-scope approval is the WP04-05 *disposable replica-set proof*. Production schema/index authorization remains **PENDING** and no production signature is claimed. BLK-AP-01 remains OPEN.
> 8. **Path conflict closed.** `lib/recovery/reconciliation.js` remains reserved for the WP04-03 V1 scanner and is now **empty**. The stale near-duplicate of the WP04-06 auditor that previously occupied it was archived byte-for-byte by the WP04-06 Track A closure at `docs/production-readiness/archive/wp04-03-path-conflict/reconciliation.wp04-06-stale.js` (SHA-256 `DC58D15F05EA804D9E0CCB4E44A575184B985718936E338F1B4561D2CE37FC43`, identical before and after the move). It is unreferenced by runtime imports.

---

## 1. Scope and constraints

### 1.1 What this document owns

- The persisted status vocabulary and legal transitions.
- The identity and idempotency rules for one recovery action.
- The lease/claim protocol and split-brain prevention.
- The retry, backoff, unknown-commit, and terminal-state rules.
- Manual escalation, approval, execution, and independent verification.
- Evidence retention, audit events, observability, and alert routing requirements.

### 1.2 What this document does not own

- The detection rules and finding codes (see the rule matrix).
- The recovery collection schema and indexes (approved Phase 2.5 WP-05).
- The append-only audit collection (approved Phase 2.5 WP-07).
- The worker CLI and scheduling (Phase 2.5 WP-06).
- Any correction arithmetic, refund, chargeback, valuation, or accounting rule.
- Any V2 transition or collection.

### 1.3 Non-negotiable rules

1. No recovery action may write `currentStock` or `reservedStock` directly.
2. No recovery action may change `paidAt`, `paymentMethod`, `paymentAccountId`, or `paymentAccountSnapshot`.
3. No recovery action may delete a document.
4. No recovery action may run without an append-only audit record.
5. No worker may approve or verify its own task.
6. No automatic action exists for a manual class.
7. An unknown commit is never blindly retried.
8. Evidence drift invalidates the task decision.
9. A live V1 writer always wins; recovery yields.
10. V2 is never touched.

---

## 2. State vocabulary

### 2.1 Persisted statuses (approved WP-05 schema)

| Status | Terminal | `isOpen` | Meaning |
|---|---|---|---|
| `DETECTED` | no | `true` | Finding recorded with evidence; no owner yet. |
| `LEASED` | no | `true` | A worker/operator holds the lease and is executing or about to execute. |
| `RETRY_SCHEDULED` | no | `true` | A transient failure occurred; the next attempt is scheduled. |
| `MANUAL_REQUIRED` | quasi-terminal | `true` | A human decision is required; no automatic action until an approved manual execution. |
| `RESOLVED` | no | `true` | The action was applied, or the evidence proves it was already correct; awaiting independent verification. |
| `CLOSED` | yes | `false` | Independently verified and accepted; retained. |
| `CANCELLED` | yes | `false` | Superseded because the evidence became clean before an action; retained. |

No new persisted status is proposed. `AWAITING_APPROVAL` is **not** a separate status; approval is a set of fields on `MANUAL_REQUIRED`.

### 2.2 Derived execution sub-phase (not persisted)

| Sub-phase | Where it lives | Meaning |
|---|---|---|
| `EVIDENCE_CHECK` | inside `LEASED` | Re-read and compare the evidence fingerprint. |
| `ACTION` | inside `LEASED` | Invoke the one approved primitive. |
| `EFFECT_CHECK` | inside `LEASED` | Re-read durable evidence to prove the effect landed exactly once. |

Persisting a sub-phase would require a schema change; the design keeps it in the audit/event stream and in the task's `lastErrorCode`/`resolution` fields.

### 2.3 Resolution values (approved WP-05 schema)

`APPLIED`, `ALREADY_CORRECT`, `ESCALATED`, `CANCELLED`.

| Resolution | Used when |
|---|---|
| `APPLIED` | The approved action was executed and the effect is present exactly once. |
| `ALREADY_CORRECT` | Evidence proves the desired state already exists; no write was needed. |
| `ESCALATED` | A human decision is required; no automatic action. |
| `CANCELLED` | The task is superseded; no action. |

---

## 3. State diagram

```text
                         +------------------+
        scanner/operator |    DETECTED      |
                         +---------+--------+
                                   |
             +---------------------+----------------------+
             |                     |                      |
             v                     v                      v
     +---------------+     +----------------+     +------------------+
     |   CANCELLED   |     |    LEASED      |     | MANUAL_REQUIRED  |
     |  (terminal)   |     | (lease held)   |     |  (human gate)    |
     +---------------+     +---+----+---+---+     +---+----------+---+
                               |    |   |             |          |
              +----------------+    |   +-------------+          |
              |                     |                 |            |
              v                     v                 v            v
      +---------------+     +----------------+  +---------+  +-----------+
      |   RESOLVED    |     | RETRY_SCHEDULED|  | LEASED  |  | CANCELLED |
      | (unverified)  |     |  (due later)   |  |(approved|  |(terminal) |
      +---+-------+---+     +--------+-------+  | manual) |  +-----------+
          |       |                  |          +---------+
          |       |                  v
          |       |              LEASED (due)
          |       |
          v       v
   +---------+  +------------------+
   | CLOSED  |  | MANUAL_REQUIRED  |
   |(terminal|  | (verifier rejects|
   +---------+  +------------------+
```

Rules:

- `DETECTED → MANUAL_REQUIRED` is allowed at creation when the class is manual-only or the evidence is E0/E1.
- `LEASED` expiry does **not** change status; another claimant takes the lease with a new token.
- `RESOLVED → CLOSED` requires an independent verifier.
- `CANCELLED` and `CLOSED` are the only terminal states.
- `MANUAL_REQUIRED` is not terminal: an approved manual execution moves it to `LEASED`.

---

## 4. Transition table

| # | From | To | Guard | Actor | Evidence required | Audit action |
|---|---|---|---|---|---|---|
| T1 | — | `DETECTED` | Valid finding with `evidenceFingerprint`; class D01–D10 | scanner / operator | E1 minimum | `RECOVERY_DETECTED` |
| T2 | `DETECTED` | `LEASED` | `isOpen`, attempts < max, atomic claim wins | worker | E2 | `RECOVERY_LEASED` |
| T3 | `DETECTED` | `CANCELLED` | Evidence re-read proves no divergence | worker / operator | E2 | `RECOVERY_CANCELLED` |
| T4 | `DETECTED` | `MANUAL_REQUIRED` | Class is manual-only, or evidence E0/E1, or no approved primitive | scanner / operator | E1 + reason | `RECOVERY_ESCALATED` |
| T5 | `LEASED` | `RESOLVED` | Action succeeded; effect present exactly once | worker | E3 | `RECOVERY_EXECUTED`, `RECOVERY_RESOLVED` |
| T6 | `LEASED` | `RETRY_SCHEDULED` | Transient failure; attempts < max; next attempt set | worker | E2 | `RECOVERY_RETRY_SCHEDULED` |
| T7 | `LEASED` | `MANUAL_REQUIRED` | Non-retryable error, contradictory unknown commit, evidence drift, or attempts exhausted | worker | E2 | `RECOVERY_ESCALATED` |
| T8 | `LEASED` | `CANCELLED` | Evidence became clean before the action | worker | E2 | `RECOVERY_CANCELLED` |
| T9 | `LEASED` | `LEASED` (new owner) | Lease expired; atomic reclaim by another worker | worker | E2 | `RECOVERY_LEASED` (reclaim) |
| T10 | `RETRY_SCHEDULED` | `LEASED` | `nextAttemptAt <= now`; attempts < max | worker | E2 | `RECOVERY_LEASED` |
| T11 | `RETRY_SCHEDULED` | `MANUAL_REQUIRED` | Attempts exhausted or evidence drift | worker | E2 | `RECOVERY_ESCALATED` |
| T12 | `MANUAL_REQUIRED` | `LEASED` | Named approver approved; executor distinct from approver; action allowed for class | operator / manager | E2 + approval | `RECOVERY_APPROVED`, `RECOVERY_LEASED` |
| T13 | `MANUAL_REQUIRED` | `CANCELLED` | Evidence re-read proves no divergence | manager | E2 | `RECOVERY_CANCELLED` |
| T14 | `RESOLVED` | `CLOSED` | Independent verifier confirms the after-state; verifier distinct from approver and executor | verifier | E3 | `RECOVERY_VERIFIED`, `RECOVERY_CLOSED` |
| T15 | `RESOLVED` | `MANUAL_REQUIRED` | Verifier rejects the after-state | verifier | E3 + reason | `RECOVERY_ESCALATED` |

### 4.1 Guard definitions

| Guard | Definition |
|---|---|
| `G_OPEN` | `isOpen === true`. |
| `G_CLASS` | `class ∈ {D01…D10}` and the class has an approved action map. |
| `G_EVIDENCE` | `evidenceFingerprint` recomputes to the stored value, or the task is re-classified before action. |
| `G_LEASE` | `leaseOwner`, `leaseToken`, and a live `leaseUntil` match the caller. |
| `G_ATTEMPTS` | `attempts < maxAttempts` for the automatic acquisitions **T2** (`DETECTED → LEASED`) and **T10** (`RETRY_SCHEDULED → LEASED`) only. It does **not** apply to **T9** expired-lease reclaim or **T12** approved manual reclaim: an expired `LEASED` task at or above `maxAttempts` must remain reclaimable so it can reach **T7** (`MANUAL_REQUIRED`) or the approved W8 abandonment path. |
| `G_APPROVAL` | `approvedBy` and `approvedAt` are set; approver is a named, authorized identity. |
| `G_DISTINCT` | `executedBy !== approvedBy` and `verifierId ∉ {approvedBy, executedBy}`. |
| `G_NO_V2` | The target order/reservation has no V2 state; if V2 is detected, stop and escalate. |
| `G_AUDIT` | The append-only audit insert succeeded before the action. |

### 4.2 Illegal transitions

| Attempt | Result |
|---|---|
| `CLOSED → any` | Rejected; a new divergence creates a new task. |
| `CANCELLED → any` | Rejected. |
| `RESOLVED → RESOLVED` | Rejected; idempotent replay returns the stored result. |
| `LEASED → CLOSED` (skip verification) | Rejected. |
| `MANUAL_REQUIRED → RESOLVED` (skip execution) | Rejected; must pass through `LEASED`. |
| `MANUAL_REQUIRED → LEASED` without approval | Rejected. |
| `LEASED → RESOLVED` without effect evidence | Rejected. |
| Any transition with a stale `leaseToken` | Rejected; caller re-reads. |
| Any transition that changes payment identity or stock quantity outside the approved primitive | Rejected by the action map. |

---

## 5. Identity and idempotency

### 5.1 Task identity

| Field | Value | Rule |
|---|---|---|
| `taskKey` | `RECOVERY:<orderId>` | stable grouping; non-unique |
| `taskId` | `RECOVERY:<orderId>:<ObjectId>` | unique task instance |
| `orderId` | order ObjectId | correlation |
| `reservationId` | reservation `_id` or null | correlation |
| `isOpen` | boolean | one open task per order via partial unique index |

### 5.2 Evidence identity

```
evidenceFingerprint = SHA-256(canonicalJson(evidenceSnapshot))
```

The snapshot includes only the fields defined in the design document §6.7. It excludes account numbers, PINs, tokens, free text, and timestamps that are not part of the decision (for example `updatedAt` is included only where it proves a grace window).

### 5.3 Action identity

| Action | Identity | Reuse |
|---|---|---|
| Consume a live reservation (R2) | `sale:<orderId>:<inventoryItemId>` | Existing `StockMovement.idempotencyKey`; never invent a new key. |
| Finalize `CONSUMED` (R4/R3 conclusive) | reservation `_id` + `status: "CONSUMING"` or expected status | Conditional status-only update. |
| Release a hold (manual R7) | reservation `_id` + reservation status + `releaseReason` | Existing `releaseOrderInventory` primitive, manual only. |
| Record a void (manual R5/R8) | `voids.source` / `voids.lineId` | Existing dedupe. |

A task never creates a new movement key, a new reservation, or a second payment.

### 5.4 Open-task convergence

```text
on detection(orderId, class, fingerprint):
    existing = tasks.findOne({ orderId, isOpen: true })
    if existing == null:
        create task(taskKey, taskId, class, fingerprint, status=DETECTED)
    else if existing.evidenceFingerprint == fingerprint and existing.class == class:
        return existing            // idempotent detection
    else:
        // Evidence changed. Do not mutate a terminal or leased task in place.
        if existing.status in ["CLOSED","CANCELLED"]:
            create new task
        else:
            append evidence-drift audit; re-classify; update class/fingerprint
            only if the task is not currently executing
```

A task that is `LEASED` must not have its class or fingerprint overwritten by a scanner; the worker owns the re-read.

### 5.5 Replay rules

| Replay | Result |
|---|---|
| Same detection, same fingerprint, open task | Return existing task; no new task. |
| Same detection, different fingerprint | Evidence drift; re-classify. |
| Same action completed twice | The primitive returns `skipped`/already-applied; task resolves `ALREADY_CORRECT`. |
| Duplicate audit event | Unique `eventId` rejects; alert as a programming error. |
| Duplicate recovery task | Partial unique open-task index rejects; service re-reads. |

---

## 6. Lease and claim protocol

### 6.1 Lease parameters

| Parameter | Proposed value | Status |
|---|---|---|
| Lease duration | 5 minutes | DESIGN ASSUMPTION (OD-9) |
| Renewal | same owner + token + live lease | DESIGN ASSUMPTION |
| Grace for renew | 0 (must be live) | DESIGN ASSUMPTION |
| Owner identity | `RECOVERY_WORKER_ID` or CLI `--worker-id`; no default | DESIGN ASSUMPTION |
| Token | random UUID per acquisition | DESIGN ASSUMPTION |
| Kill switch | `RECOVERY_WORKER_ENABLED` defaults off | DESIGN ASSUMPTION |

### 6.2 Acquire (pseudocode)

```text
function acquire(taskId, workerId, now):
    token = uuid()
    task = tasks.findOneAndUpdate(
      {
        _id: taskId,
        isOpen: true,
        attempts: { $lt: maxAttempts },
        $or: [
          { status: "DETECTED" },
          { status: "RETRY_SCHEDULED", nextAttemptAt: { $lte: now } },
          { status: "LEASED", leaseUntil: { $lt: now } },
          { status: "MANUAL_REQUIRED" }   // only with a validated approval
        ]
      },
      {
        $set: {
          status: "LEASED",
          leaseOwner: workerId,
          leaseToken: token,
          leaseUntil: new Date(now + 5*60*1000)
        },
        $inc: { attempts: 1 },
        $unset: { nextAttemptAt: "" }
      },
      { returnDocument: "after" }
    )
    return task
```

> **AMENDMENT 2026-11-12 (T9/Acquire — see `wp-04-06-design-consolidation-and-register.md` §4 SM-AM1):** the filter above is amended to include the positive unresolved-operation predicate `U_claim` — `$or: [{ pendingOperation: null }, { "pendingOperation.state": { $in: ["COMMITTED", "ABANDONED"] } }]` — and the update gains `$inc: { leaseGeneration: 1 }` in the same write. A claim must not proceed while a prior operation is unresolved (`PREPARED`, including an `UNKNOWN_COMMIT`-observed operation). The `$set` block above also omits `leaseGeneration` initialization and `$unset` of a prior `pendingOperation` is prohibited while its outcome is unresolved.

For `MANUAL_REQUIRED`, the filter additionally requires a valid approval:

```text
approvedBy != null
approvedAt != null
executedBy == null or executedBy == workerId
approvedBy != workerId
```

The worker identity is a server-side service identity, never a Staff session, cookie, or POS client.

### 6.3 Renew

```text
function renew(taskId, workerId, token, now):
    return tasks.findOneAndUpdate(
      { _id: taskId, isOpen: true, status: "LEASED",
        leaseOwner: workerId, leaseToken: token,
        leaseUntil: { $gt: now } },
      { $set: { leaseUntil: new Date(now + 5*60*1000) } },
      { returnDocument: "after" }
    )
```

A renewal miss means the lease was lost; the worker must stop and re-read. It must not continue "best effort".

### 6.4 Complete or release

```text
function finish(taskId, workerId, token, outcome):
    return tasks.findOneAndUpdate(
      { _id: taskId, isOpen: true, status: "LEASED",
        leaseOwner: workerId, leaseToken: token },
      { $set: outcome, $unset: { leaseOwner: "", leaseUntil: "", leaseToken: "" } },
      { returnDocument: "after" }
    )
```

A finish miss is an unknown outcome. The worker re-reads the task and the durable effect; it does not repeat the action blindly.

### 6.5 Split-brain prevention

- Only one atomic claim wins per task.
- A stale owner cannot renew or finish because the filter requires the current token.
- A reclaimed task increments `attempts` and gets a new token; the old owner's writes fail the guard.
- The task lease is **not** a lock on the order. V1 writers can still change the order; the worker must re-read evidence before acting.

---

## 7. Retry and backoff

### 7.1 Attempt accounting

`attempts` increments on **lease acquisition**, not on action invocation. This bounds total leases and prevents a crash loop from consuming unbounded retries.

| Attempt | Delay before next lease |
|---|---|
| 1 | immediate |
| 2 | 30 s |
| 3 | 60 s |
| 4 | 120 s |
| 5 | 240 s |
| exhausted | `MANUAL_REQUIRED` |

**Scope (2026-11-12 clarification):** `attempts < maxAttempts` is a guard on the automatic acquisitions **T2** (`DETECTED → LEASED`) and **T10** (`RETRY_SCHEDULED → LEASED`) only. **T9** expired-lease reclaim and **T12** approved manual reclaim are deliberately exempt: an expired `LEASED` task at or above `maxAttempts` must remain reclaimable so it can reach **T7** (`MANUAL_REQUIRED`) or the approved W8 abandonment path. OD-09 numeric values, status transitions, and the transition set are unchanged.

The proposed cap is 15 minutes with jitter; the exact values are **OD-9**.

### 7.2 Failure classification

| Failure | Classification | Action |
|---|---|---|
| Transient transaction error | retryable | Re-run the same idempotent step under the same action identity. |
| Topology unavailable (`TRANSACTIONS_UNAVAILABLE`, selection timeout) | retryable later | `RETRY_SCHEDULED` + alert; do not hammer. |
| Unknown transaction commit | ambiguous | Re-read evidence; never blind retry. |
| Validation error, `409` conflict, evidence drift | non-retryable | `MANUAL_REQUIRED`. |
| Audit write failure | blocking | Do not execute; `RETRY_SCHEDULED` or `MANUAL_REQUIRED`; alert. |
| Kill switch off | not a failure | Worker does not start; tasks remain durable. |
| Duplicate task | convergence | Re-read; return existing. |

### 7.3 Unknown commit contract

```text
function onUnknownCommit(task, actionIdentity):
    evidence = reReadEvidence(task.orderId)
    effects  = countEffects(actionIdentity, evidence)

    if effects == 1:
        return resolve(task, "ALREADY_CORRECT")
    if effects == 0 and task.attempts < task.maxAttempts:
        return scheduleRetry(task)
    if effects == 0 and task.attempts >= task.maxAttempts:
        return escalate(task, "UNKNOWN_COMMIT_NO_EFFECT")
    return escalate(task, "UNKNOWN_COMMIT_CONTRADICTORY")
```

`countEffects` is action-specific:

- consumption: number of `StockMovement` rows with the exact `sale:<orderId>:<item>` key and the reservation status;
- finalize: reservation status and `consumedAt`;
- release: reservation status and `reservedStock`;
- void: `voids` entry and movement reclassification.

A partial effect is never "completed" by a second write.

---

## 8. Action authorization by class

| Class | Sub-code | Future automatic action (WP-06) | Manual only |
|---|---|---|---|
| D01 / R1 | `PAID_WITH_LIVE_RESERVATION` | **No** — R1 is manual | yes |
| D01 / R1 | `PAID_RELEASED_NO_DEDUCTION` | No | yes |
| D01 / R1 | `ALREADY_CORRECT_LEGACY` | Resolve `ALREADY_CORRECT` (no write) | no |
| D02 | all | No | yes |
| D03 / R5 | all | No | yes |
| D04 / R5/R7 | all | No | yes |
| D05 / R2 | `PAID_WITH_LIVE_HOLD` | **Yes** — idempotent `consumeOrderInventory` only | — |
| D05 / R7 | `HOLD_ON_TERMINAL_ORDER`, `STALE_LIVE_HOLD`, `ORPHAN_LIVE_HOLD` | No | yes |
| D06 / R3 | `CONSUMING_MOVEMENTS_COMPLETE` | Status-only finalize when no hold remains | quantity change |
| D06 / R3 | `CONSUMING_PARTIAL`, `CONSUMING_AMBIGUOUS`, `CONSUMING_ABANDONED`, `CONSUMING_ORPHAN` | No | yes |
| D07 / R4 | movement complete, no live hold | Status-only finalize; no stock change | quantity change |
| D07 / R6 | mismatch / missing item | No | yes |
| D08 / R5/R7 | all | No | yes |
| D09 / R1/R7 | all | No | yes |
| D10 | all | No; blocks every automatic action | yes |

**Critical:** "automatic" in the table means a *future* WP-06 worker, not WP-04. WP-04 authorizes none of these actions. The only approved automatic primitive in Phase 2.5 is the existing idempotent consumption for R2; everything else escalates.

---

## 9. Manual escalation

### 9.1 Required escalation payload

| Field | Content |
|---|---|
| `taskId`, `orderId`, `orderNumber` | identity |
| `class`, `subCode` | finding |
| `severity`, `confidence`, `evidenceLevel` | triage |
| `evidenceFingerprint`, `evidenceSnapshot` | reproducible evidence |
| `whatWasAttempted` | action and failure code |
| `unresolvedQuestion` | one precise question, not "fix it" |
| `expectedVsActual` | quantities/status, no invented correction |
| `approvedBy`, `executedBy`, `verifierId` | named humans |
| `deadline` | escalation SLA (OD-7) |

### 9.2 Approval and execution

1. The task enters `MANUAL_REQUIRED` with a reason code.
2. The approver reviews the evidence and records `approvedBy`/`approvedAt`.
3. The approver must not be the executor.
4. The executor claims the task (T12) and performs only the approved step.
5. The executor records `executedBy`/`executedAt` and the result.
6. The task moves to `RESOLVED` (`APPLIED` or `ALREADY_CORRECT`).
7. An independent verifier re-reads the after-state and moves it to `CLOSED` or back to `MANUAL_REQUIRED`.

### 9.3 Verification checklist

- The approved action matches the class and sub-code.
- The after-state is proven by durable evidence, not by a log line.
- No second movement/reservation/payment was created.
- `currentStock`/`reservedStock` are not negative.
- The evidence fingerprint of the after-state is recorded.
- The audit trail contains intent and result with distinct approver/executor/verifier.
- No V2 state was created or changed.

---

## 10. Evidence retention and audit

### 10.1 Evidence snapshot

| Field | Retained |
|---|---|
| Order status, `paidAt`, `paymentMethod`, `paymentAccountId` | yes |
| Account snapshot bank/owner | yes (business context) |
| Account number | **masked to last 4** |
| Reservation status/items/quantities/voids | yes |
| Movement ids/quantities/reasons/keys/void stamps | yes |
| Inventory item ids/`currentStock`/`reservedStock` | yes |
| Free-text cancellation reason | truncated/sanitized |
| PIN, token, cookie, session, connection string | never |

### 10.2 Retention

- No TTL by default.
- `CLOSED` and `CANCELLED` tasks are retained with their evidence and audit.
- Retention duration is **OD-4**; finance/legal may require a longer period.
- Evidence history is append-only. If the schema keeps one `evidence` object, a re-read must append an audit event with the new fingerprint rather than overwrite history (**OD-8**).

### 10.3 Audit events

| Event | When | Required fields |
|---|---|---|
| `RECOVERY_DETECTED` | task created | taskId, orderId, class, fingerprint, severity |
| `RECOVERY_LEASED` | lease acquired/reclaimed | workerId, token, leaseUntil, attempts |
| `RECOVERY_RENEWED` | lease renewed | workerId, token, leaseUntil |
| `RECOVERY_EXECUTED` | primitive invoked | action, identity, before/after, result |
| `RECOVERY_RETRY_SCHEDULED` | transient failure | code, attempts, nextAttemptAt |
| `RECOVERY_ESCALATED` | manual required | reason code, unresolved question |
| `RECOVERY_APPROVED` | manual approval | approverId, approvedAt |
| `RECOVERY_RESOLVED` | effect proven | resolution, afterFingerprint |
| `RECOVERY_VERIFIED` | independent verification | verifierId, afterFingerprint |
| `RECOVERY_CLOSED` | terminal | verifierId, closedAt |
| `RECOVERY_CANCELLED` | superseded | reason, evidence |
| `RECOVERY_EVIDENCE_DRIFT` | fingerprint changed | old/new fingerprint |

Audit is append-only. A failed audit insert aborts the action; there is no "best effort" audit.

---

## 11. Observability and alerting

### 11.1 Signals

| Signal | Type | Threshold (proposal) |
|---|---|---|
| Open critical tasks | gauge | > 0 page immediately |
| Oldest open task age | gauge | > 15 min high, > 1 h critical |
| Tasks at max attempts | counter | any → page |
| Evidence-drift events | counter | any → investigate |
| Unknown-commit events | counter | any → page |
| Lease contention/reclaims | counter | spike → investigate |
| Worker heartbeat | heartbeat | missing 2 intervals → page |
| Scanner read errors | counter | any → investigate |
| Missing index / duplicate preflight | event | any → DBA |
| Kill switch state | gauge | off in production = informational |

Thresholds are **OD-7**.

### 11.2 Logging

- Use `lib/operationalLogger.js` structured JSON.
- Never log account numbers, PINs, tokens, cookies, or connection strings.
- Log the task id, order id, class, sub-code, and fingerprint; not the full evidence payload.
- The public health endpoint remains coarse and does not expose task counts or identifiers.

### 11.3 Missing sink

**VERIFIED:** no alert sink, on-call integration, dashboard, metric exporter, queue, or scheduler exists. Detection and recovery without routing is not an operational control; the owner must approve a sink before relying on alerts.

---

## 12. Concurrency with live V1 writers

| Live event | Required recovery behaviour |
|---|---|
| Order is edited | Re-read requirements; if the fingerprint changed, re-classify. |
| Order starts `PREPARING` | Consumption may already be in progress; do not race it; re-read. |
| Order is paid | Payment is authoritative; do not change identity; re-classify inventory only. |
| Order/line is cancelled | Retrieve/void rules apply; do not consume a released reservation. |
| Reservation is released | Do not consume; task becomes `CANCELLED` or `MANUAL_REQUIRED`. |
| Hold changes | Re-read `reservedStock`; a changed hold invalidates a finalize action. |
| Two workers claim | One lease winner; the loser re-reads. |
| Process crash | Lease expires; next claimant re-reads evidence. |
| Unknown commit | Evidence resolution only. |

The task lease does not block V1 writes. This is deliberate: a live cashier/waiter action must always win.

---

## 13. Prohibited transitions and actions

| Prohibition | Reason |
|---|---|
| `LEASED → CLOSED` | Skips independent verification. |
| `MANUAL_REQUIRED → RESOLVED` | Skips execution/evidence. |
| Reopen `CLOSED`/`CANCELLED` | Destroys history; create a new task. |
| Execute with a stale token | Split-brain. |
| Execute after evidence drift | Wrong target. |
| Write stock directly | Accounting fact without primitive. |
| Change payment identity | Frozen after `PAID`. |
| Delete any record | Evidence destruction. |
| Auto-resolve R1/R3-ambiguous/R5–R8 | Not approved. |
| Run with no worker identity | Untraceable action. |
| Run with no audit | No accountability. |
| Read/write V2 | Out of scope. |
| Combine payment and inventory writes | Approved decision 3. |

---

## 14. Failure-mode table

| Failure | State after crash | Recovery |
|---|---|---|
| Crash before lease | `DETECTED` | Another worker claims. |
| Crash after lease, before action | `LEASED` until expiry | Reclaim after expiry; re-read. |
| Crash after action commit, before finish | `LEASED` until expiry | Reclaim; effect exists exactly once → `ALREADY_CORRECT`. |
| Crash after action commit, effect partial | `LEASED` until expiry | Reclaim; contradictory → `MANUAL_REQUIRED`. |
| Crash after finish, before audit flush | Task terminal, audit missing | Durable audit is written before the action; if it is missing, the task is inconsistent → manual investigation. |
| Audit insert fails | Action not applied | Retry or escalate; no action. |
| Lease renewal fails | Another worker may claim | Stop; re-read. |
| Two workers finish | One token wins; other misses | Re-read; no duplicate. |
| Evidence changes mid-action | Unknown target | Re-read; if drift, abort and re-classify. |
| Topology unavailable | No write | `RETRY_SCHEDULED` + alert. |
| Kill switch off | Worker exits | Tasks durable. |
| Index missing | Duplicate detection weaker | Report; do not create index in WP-04. |

---

## 15. Owner decisions required

| # | Decision | Effect |
|---|---|---|
| OD-3 | Stale-`CONSUMING` and live-order thresholds | Age-based classification. |
| OD-4 | Task/evidence/audit retention | Legal/finance compliance. |
| OD-5 | Whether any terminal-order hold may be auto-released after approval | Current design prohibits all auto-release. |
| OD-7 | Alert sink, thresholds, on-call, SLA | Operational control. |
| OD-8 | Evidence history model | One snapshot vs append-only history. |
| OD-9 | Lease duration, attempts, backoff, jitter | Retry behaviour. |
| OD-11 | Named approver/executor/verifier per class | Separation of duties. |
| OD-12 | Whether the worker may ever run on a schedule, and where | WP-06 is C5-gated. |

**No recovery was executed. No stock or payment record was changed. Inventory V2 remains inactive.**
