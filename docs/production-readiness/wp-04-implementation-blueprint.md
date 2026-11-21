# WP-04 — Implementation Blueprint

Status: **DECISIONS APPROVED — BLUEPRINT ONLY — NO CODE IMPLEMENTED — NO GATE SIGNED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Owner decision record: `wp-04-owner-decision-proposal.md` (§16)
Companions: `wp-04-gate-dependency-map.md`, `wp-04-implementation-work-packages.md`, `wp-04-implementation-acceptance-matrix.md`
Design basis: `wp-04-reconciliation-design.md`, `wp-04-detection-rule-matrix.md`, `wp-04-recovery-state-machine.md`, `wp-04-test-and-acceptance-plan.md`

> The owner approved WD-01 through WD-14 on 2026-11-08. This blueprint translates those approved policies into a controlled implementation plan. It does **not** implement anything. No application source, schema, collection, index, route, API, script, test, environment variable, or runtime configuration was created or changed. No database, staging, `.env`, `.env.local`, secret, or credential was accessed. No stock, payment, accounting, or reservation record was mutated. Inventory V2 remains inactive. **No gate is signed.** G-REC-1, G-REC-2, G-REC-3, G-AUD-1, and G-GOV-1 remain **UNSIGNED**. G-PAY-1 remains **BLOCKED**.

> **AMENDMENT 2026-11-12 — WP04-06 DESIGN CONSOLIDATION (see `wp-04-06-design-consolidation-and-register.md` §4 BP-AM1):** the T9 row (WP-06, line 219) is amended to the approved T9/Acquire contract: the claim filter includes the positive unresolved-operation predicate `U_claim` (`$or: [{ pendingOperation: null }, { "pendingOperation.state": { $in: ["COMMITTED", "ABANDONED"] } }]`) and increments `leaseGeneration` **in the same write**. The W6 operation reservation is a **standalone `T_reserve` transaction** (I-C) — not folded into W2/W5 — emitting no event and reserving exactly one sequence. All other rows remain blueprint-only; this amendment does not authorize any code.

---

## 0. Reading guide

### 0.1 Status labels

| Label | Meaning |
|---|---|
| **APPROVED POLICY** | Owner-approved on 2026-11-08; binding on the design, not an implementation authorization. |
| **PROPOSED MODULE** | A candidate module boundary. No file exists; the path is confirmed only at implementation. |
| **REQUIRES AUTHORIZATION** | A separate owner/CAB decision is required before any code, database, or operational action. |
| **GATE** | Evidence-gated acceptance; approval of a policy does not satisfy it. |
| **PROHIBITED** | Must not be implemented or executed under this blueprint. |

### 0.2 Source architecture examined

The module layout below follows the repository's existing conventions, verified at the stated HEAD:

| Area | Existing convention | Example |
|---|---|---|
| Service modules | `lib/<domain>Service.js`, named exports | `lib/inventoryReservationService.js`, `lib/inventoryAuditService.js` |
| Models | `lib/models/<Name>.js`, `get<Name>Model(connection)` factory, explicit collection name | `lib/models/InventoryReservation.js` |
| Scripts | `scripts/<verb>-<noun>.mjs` or `.js`, explicit flags | `scripts/sync-indexes.js`, `scripts/inventory-v2-deploy-indexes.mjs` |
| DB-free tests | `tests/<topic>.test.mjs` | `tests/phase25-payment-immutability.test.mjs` |
| Integration tests | `tests/integration/<topic>.integration.mjs` | `tests/integration/phase23-replica-set.integration.mjs` |
| Harness | `tests/helpers/pos-phase25-loader.mjs`, `pos-phase25-register.mjs` | alias/extension resolution |
| Logging | `lib/operationalLogger.js` (`logEvent`, key redaction) | one JSON line per event |
| Connection | `lib/mongodb.js` (`connectToDatabase`) | no `syncIndexes()` in the request path |
| Health | `lib/health.js` | coarse only; no task/order detail |

Three verified constraints shape the plan:

1. `lib/mongodb.js` auto-provisions indexes only for `Order`, `Staff`, `Category`, `MenuItem`, and `InventoryAudit`. New recovery models **must not** be added to that path without a separate index change approval.
2. `InventoryReservation.orderId` is declared unique, and `StockMovement` has unique partial indexes on `(refOrderId, reason, item)` and `idempotencyKey`; deployed presence is **UNVERIFIED**. Detection must work with or without them.
3. The existing idempotent primitives are `consumeOrderInventory`, `releaseOrderInventory`, and `recordPostPreparationVoid` in `lib/inventoryReservationService.js`. Recovery must reuse them, never re-implement stock arithmetic.

---

## 1. Approval basis and constraints

### 1.1 Approved decisions carried into this blueprint

| Decision | Approved policy | Effect on this blueprint |
|---|---|---|
| WD-01 | D01–D10 are the read-only detection vocabulary | §5 defines exactly ten rules; no write path |
| WD-02 | No `R9`/`R10` in the first implementation | D02/D09 route to manual review as finding codes |
| WD-03 | Role placeholders, distinct approver/executor/verifier | §8 and the work packages enforce distinctness in design |
| WD-04 | Stale `CONSUMING` is alert-only | D06 creates no task and no status change |
| WD-05 | No age-based hold release | D05 is report-only; release needs evidence + approval |
| WD-06 | Shortage is report-only; accounting unresolved | No correction quantity or valuation anywhere |
| WD-07 | Evidence history is append-only | §4.8 and WP04-08 |
| WD-08 | Lease/retry values are provisional | Values are test inputs, not production policy |
| WD-09 | Worker disabled by default | §4.9 and WP04-10 |
| WD-10 | Mandatory line-level reconciliation deferred | Item-level first; line evidence retained |
| WD-11 | Evidence-based legacy cutoff process, no date | §5.9; cutoff date deferred |
| WD-12 | Verify deployed indexes before uniqueness reliance | §5.11 and WP04-12 |
| WD-13 | Register external/manual writers | §8.4; register pending |
| WD-14 | Gate evidence definitions approved | §7 and the acceptance matrix |

### 1.2 Deferred items that remain unapproved

Shortage accounting semantics; named approver/executor/verifier and backups; numeric `W_STALE` and live-hold thresholds; legacy cutoff date; evidence/output retention; lease duration/retries/backoff/jitter numerics; production scan window and transaction-lifetime limits; alert sink/on-call/SLA; exact schema and collection shapes; index window; external-writer inventory; gate signatories and dates; `R9`/`R10` adoption; any D06 task creation; any automatic hold release; line-attribution model; worker scheduling.

These are enumerated in `wp-04-owner-decision-proposal.md` §16.3 and are **not** approved by inference.

### 1.3 Implementation authorization state

Approval of WD-01…WD-14 is a **policy** decision. Every code, database, staging, index, worker, or operational package in §6 requires a separate authorization. The first package cannot start on the strength of this document alone.

---

## 2. Architecture boundaries (A)

| # | Boundary | Enforcement | Evidence that proves it |
|---|---|---|---|
| **A1** | V1 remains authoritative for orders, payments, reservations, stock, and station state. | The scanner reads V1 models only; no V2 import. | Source-contract test; import-graph test; staging sample. |
| **A2** | Inventory V2 remains inactive. | No `inventory_v2_*` collection read/write; no `orderVersion` or `inventoryMode`; no V2 state machine import. | String scan; integration collection list; diff review. |
| **A3** | Read-only detection is separate from recovery execution. | Two planes; the scanner/classifier export read APIs only; recovery repository is a different package. | Export-list test; write-method scan; no write-capable imports. |
| **A4** | Recovery records are durable and auditable. | Persisted task with the seven approved statuses; append-only evidence and audit events. | Disposable schema/lease tests; audit-failure abort test. |
| **A5** | No single transaction combines payment and inventory settlement. | No recovery action writes `paidAt`, payment identity, or the order payment document. | Action-map review; source test; per-class action table. |
| **A6** | Existing idempotent primitives remain authoritative. | Recovery calls `consumeOrderInventory` / `releaseOrderInventory` / `recordPostPreparationVoid`; never new `$inc`. | Source test; idempotency-key equality test. |
| **A7** | No new stock arithmetic and no silent stock repair. | No direct `$inc`/`$set` on `currentStock`/`reservedStock`; no delete; no clamp. | Source-contract test; disposable before/after hash. |
| **A8** | Recovery worker is disabled by default. | No schedule; no public route; explicit `--execute` and worker identity; kill switch absent/false by default. | CLI test; staging `--once` only with C5 approval. |
| **A9** | No automatic hold release based only on age. | D05 is report-only; release requires evidence, approval, and an approved primitive. | Rule test; action-map review. |
| **A10** | Stale `CONSUMING` generates alerts only at first. | D06 creates no task, no finalize, no status change. | Rule test; action-map review. |

### 2.1 Two-plane separation

```text
+---------------------------------------------------------------+
| DETECTION PLANE (WP04-01..WP04-06)                            |
| read-only registry, evidence projection, classifier, scanner  |
| outputs findings + evidence fingerprint                       |
| CANNOT write any collection, create a task, or invoke action  |
+-----------------------------+---------------------------------+
                              | findings / evidence
                              v
+---------------------------------------------------------------+
| RECOVERY PLANE (WP04-07..WP04-11)                             |
| durable task, lease, approval, action, verification, audit    |
| disabled by default; only after G-REC-2/3, G-AUD-1, G-GOV-1   |
+---------------------------------------------------------------+
```

The classifier is shared: the recovery plane reuses the identical rule registry and fingerprint so a task cannot drift from the finding that produced it.

---

## 3. Proposed implementation layers (B)

All paths below are **candidates** chosen to match the existing architecture. None exists yet. Final names are confirmed during WP04-01 and reviewed before any file is created.

| Layer | Responsibility | Candidate module(s) | May | Must not | Package |
|---|---|---|---|---|---|
| **L1 — Rule registry** | Stable D01–D10 definitions, sub-codes, severity, confidence, required evidence | `lib/recovery/rules/registry.js` | Declare rule metadata and sub-codes | Query the database, write, or decide a correction | WP04-01 |
| **L2 — Evidence projection** | Select only authoritative fields; mask account numbers; bound child lists | `lib/recovery/evidence.js` | Build bounded snapshots from V1 documents | Include secrets, PINs, tokens, or full account numbers | WP04-01 |
| **L3 — Fingerprint** | Canonical JSON and SHA-256 evidence fingerprint | `lib/recovery/fingerprint.js` | Deterministic hashing | Include mutable/non-decision timestamps or payment secrets | WP04-01 |
| **L4 — Classifier** | Apply D01–D10 to a bounded evidence snapshot; emit findings with confidence/severity | `lib/recovery/classify.js` | Classify, dedupe, recommend review | Write, repair, or invent a quantity | WP04-02 |
| **L5 — Read-only scanner** | Orchestrate bounded reads from primary; join order/reservation/movement/inventory | `lib/recovery/reconciliation.js` | `find`, `findOne`, `aggregate` read stages, `countDocuments`, `distinct`, `exists` | Any write, index, or write-capable import | WP04-03 |
| **L6 — Read-only guard** | Structural write ban, flag parser, import-graph guard | `lib/recovery/readOnlyGuard.js` | Refuse `--apply`/`--fix`/`--repair`/`--execute` and unknown flags | Provide an override flag | WP04-03 |
| **L7 — CLI** | Operated entry point with `--since`, `--until`, `--limit`, `--json` | `scripts/reconcile-inventory.mjs` | Emit deterministic redacted JSON, exit 0/2/1 | Accept a write flag; read `.env` | WP04-03 |
| **L8 — Recovery repository** | Durable task CRUD with the seven statuses, open-task guard | `lib/models/InventoryRecoveryJob.js`, `lib/recovery/taskRepository.js` | Create/converge tasks, append status transitions | Write stock/payment; reopen a terminal task | WP04-07 |
| **L9 — Claim/lease service** | Atomic claim, renew, finish/release, token guard | `lib/recovery/leaseService.js` | `findOneAndUpdate` on the task lease only | Lease the order or block V1 writes | WP04-09 |
| **L10 — Evidence history** | Append-only evidence events keyed by task/fingerprint | `lib/models/InventoryRecoveryEvidence.js` (candidate), `lib/recovery/evidenceHistory.js` | Insert-only evidence events and audit links | Update/delete prior evidence; TTL | WP04-08 |
| **L11 — Retry scheduler interface** | Classify failures, compute backoff, schedule `nextAttemptAt` | `lib/recovery/retryPolicy.js` | Compute provisional delays; schedule a due time | Start a timer, cron, queue, or blind-retry an unknown commit | WP04-09 |
| **L12 — Manual review/escalation** | Build the escalation payload; enforce approver/executor/verifier distinctness | `lib/recovery/escalation.js` | Validate approval fields and distinctness | Expose an HTTP route or create a permission | WP04-10 |
| **L13 — Observability** | Structured events and metric-ready counters | `lib/recovery/observability.js` (uses `lib/operationalLogger.js`) | Log redacted task/rule events | Log full evidence, account numbers, PINs, tokens | WP04-01..03, WP04-10 |
| **L14 — Authorization/audit boundary** | Map role placeholders to actions; fail closed if audit unavailable | `lib/recovery/authorization.js` (candidate), adapter to WP-07 audit | Enforce distinctness and audit-before-action | Create system roles/permissions or best-effort audit | WP04-08, WP04-10 |

### 3.1 Module dependency direction

```text
registry (L1)
   |
   v
evidence (L2) --> fingerprint (L3) --> classifier (L4)
                                          |
                                          v
                                   scanner (L5) --> guard (L6) --> CLI (L7)
                                          |
                                          v
                              recovery repository (L8)
                                          |
                    +---------------------+---------------------+
                    v                     v                     v
              lease (L9)          evidence history (L10)   retry policy (L11)
                    |                     |                     |
                    +---------------------+---------------------+
                                          v
                              escalation (L12) --> observability (L13)
                                          |
                                          v
                              authorization/audit (L14)
```

No layer may import a write-capable application service. L8–L14 are separate packages and are not authorized by WP-04.

### 3.2 Read-only enforcement details

The scanner will:

1. accept only read methods in its data-access adapter;
2. read from primary for decision-relevant evidence;
3. never import `orderService`, `inventoryReservationService`, `inventoryDeductionService`, `inventoryService`, `inventoryReceiveService`, `inventoryWasteService`, payment services, or V2 server modules;
4. reject `--apply`, `--repair`, `--fix`, `--force`, and `--execute`;
5. exit non-zero on an unknown flag;
6. be tested against a before/after document hash in L2;
7. expose no HTTP route.

### 3.3 Index-path constraint

New models must not be added to `lib/mongodb.js`'s `ensureIndexesInBackground()`. Recovery indexes are a separate C3 change governed by G-IDX-1 and WP-11/WP-12. Any package that needs an index stops until that evidence exists.

---

## 4. Durable recovery lifecycle (C)

### 4.1 Persisted statuses

Only these seven statuses are permitted. No additional persisted state may be invented.

| Status | Terminal | `isOpen` | Meaning |
|---|---|---|---|
| `DETECTED` | no | `true` | Finding recorded with evidence; no owner yet. |
| `LEASED` | no | `true` | A worker/operator holds the lease and is executing or about to execute. |
| `RETRY_SCHEDULED` | no | `true` | A transient failure occurred; the next attempt is scheduled. |
| `MANUAL_REQUIRED` | quasi-terminal | `true` | A human decision is required; no automatic action until an approved manual execution. |
| `RESOLVED` | no | `true` | Action applied or evidence proves already-correct; awaiting independent verification. |
| `CLOSED` | yes | `false` | Independently verified and accepted; retained. |
| `CANCELLED` | yes | `false` | Superseded because evidence became clean before an action; retained. |

`AWAITING_APPROVAL` is **not** a status. Approval is a set of fields on `MANUAL_REQUIRED`. Execution sub-phases (`EVIDENCE_CHECK`, `ACTION`, `EFFECT_CHECK`) are derived, not persisted.

### 4.2 Allowed transitions

| # | From | To | Guard | Actor | Evidence | Audit action |
|---|---|---|---|---|---|---|
| T1 | — | `DETECTED` | Valid finding with fingerprint; class D01–D10 | scanner/operator | E1 minimum | `RECOVERY_DETECTED` |
| T2 | `DETECTED` | `LEASED` | `G_OPEN`, attempts < max, atomic claim wins | worker | E2 | `RECOVERY_LEASED` |
| T3 | `DETECTED` | `CANCELLED` | Re-read proves no divergence | worker/operator | E2 | `RECOVERY_CANCELLED` |
| T4 | `DETECTED` | `MANUAL_REQUIRED` | Manual-only class, E0/E1, or no approved primitive | scanner/operator | E1 + reason | `RECOVERY_ESCALATED` |
| T5 | `LEASED` | `RESOLVED` | Action succeeded; effect present exactly once | worker | E3 | `RECOVERY_EXECUTED`, `RECOVERY_RESOLVED` |
| T6 | `LEASED` | `RETRY_SCHEDULED` | Transient failure; attempts < max; `nextAttemptAt` set | worker | E2 | `RECOVERY_RETRY_SCHEDULED` |
| T7 | `LEASED` | `MANUAL_REQUIRED` | Non-retryable error, contradictory unknown commit, drift, or attempts exhausted | worker | E2 | `RECOVERY_ESCALATED` |
| T8 | `LEASED` | `CANCELLED` | Evidence became clean before the action | worker | E2 | `RECOVERY_CANCELLED` |
| T9 | `LEASED` | `LEASED` (new owner) | Lease expired; atomic reclaim by another worker | worker | E2 | `RECOVERY_LEASED` (reclaim) |
| T10 | `RETRY_SCHEDULED` | `LEASED` | `nextAttemptAt <= now`; attempts < max | worker | E2 | `RECOVERY_LEASED` |
| T11 | `RETRY_SCHEDULED` | `MANUAL_REQUIRED` | Attempts exhausted or evidence drift | worker | E2 | `RECOVERY_ESCALATED` |
| T12 | `MANUAL_REQUIRED` | `LEASED` | Approved; executor distinct from approver; action allowed for class | operator | E2 + approval | `RECOVERY_APPROVED`, `RECOVERY_LEASED` |
| T13 | `MANUAL_REQUIRED` | `CANCELLED` | Re-read proves no divergence | manager | E2 | `RECOVERY_CANCELLED` |
| T14 | `RESOLVED` | `CLOSED` | Independent verifier confirms after-state; verifier distinct from approver/executor | verifier | E3 | `RECOVERY_VERIFIED`, `RECOVERY_CLOSED` |
| T15 | `RESOLVED` | `MANUAL_REQUIRED` | Verifier rejects the after-state | verifier | E3 + reason | `RECOVERY_ESCALATED` |

Guards:

| Guard | Definition |
|---|---|
| `G_OPEN` | `isOpen === true`. |
| `G_CLASS` | Class is D01–D10 and has an approved action mapping. |
| `G_EVIDENCE` | Fingerprint recomputes to the stored value, or the task is re-classified before action. |
| `G_LEASE` | `leaseOwner`, `leaseToken`, and live `leaseUntil` match the caller. |
| `G_ATTEMPTS` | `attempts < maxAttempts` for automatic transitions. |
| `G_APPROVAL` | `approvedBy` and `approvedAt` are set and authorized. |
| `G_DISTINCT` | `executedBy !== approvedBy` and `verifierId ∉ {approvedBy, executedBy}`. |
| `G_NO_V2` | Target has no V2 state; if detected, stop and escalate. |
| `G_AUDIT` | Append-only audit insert succeeded before the action. |

### 4.3 Idempotency identity

| Identity | Value | Rule |
|---|---|---|
| `taskKey` | `RECOVERY:<orderId>` | Stable grouping; non-unique. |
| `taskId` | `RECOVERY:<orderId>:<server-generated-id>` | Unique per task instance. |
| Open-task guard | Partial unique `{ orderId: 1 }` where `isOpen: true` | One open task per order; must be deployed and verified under G-REC-2. |
| `evidenceFingerprint` | SHA-256 of canonical evidence JSON | Detects drift; required before action. |
| R2 consumption | `sale:<orderId>:<inventoryItemId>` | Reuses the existing `StockMovement.idempotencyKey`; never invented. |
| R4/R3 finalize | Reservation `_id` + expected status | Conditional status-only update. |
| R7 release | Reservation `_id` + status + `releaseReason` | Existing `releaseOrderInventory`; manual only. |
| Void | `voids.source` / `voids.lineId` | Existing dedupe. |

Convergence rule:

```text
detect(orderId, class, fingerprint):
  existing = tasks.findOne({ orderId, isOpen: true })
  if none:                          create DETECTED
  else if same class + fingerprint: return existing
  else if terminal:                 create a new task
  else:                             append drift event; re-classify
                                    only if not currently executing
```

A `LEASED` task's class/fingerprint is never overwritten by a scanner; the lease holder owns the re-read.

### 4.4 Atomic claim requirements

1. One `findOneAndUpdate` with the complete eligibility filter: `isOpen`, `attempts < maxAttempts`, and status in `{DETECTED, due RETRY_SCHEDULED, expired LEASED}` (plus `MANUAL_REQUIRED` only with valid approval).
2. Set `status: LEASED`, `leaseOwner`, random `leaseToken`, `leaseUntil`.
3. Increment `attempts` on **lease acquisition**, not on action invocation.
4. Unset `nextAttemptAt`.
5. Return the post-image.
6. Exactly one concurrent caller may win; the loser re-reads and stops.
7. A stale token cannot renew or finish.

### 4.5 Lease expiry behavior

- Expiry does not change status and does not resolve the task.
- The next claimant takes a new token and increments `attempts`.
- The previous owner must stop on a renewal miss.
- The claimant re-reads evidence before any action.
- The lease is not a lock on the order; live V1 writers always win.

### 4.6 Unknown-commit handling

```text
onUnknownCommit(task, actionIdentity):
    evidence = reReadEvidence(task.orderId)
    effects  = countEffects(actionIdentity, evidence)
    if effects == 1:                    resolve(task, "ALREADY_CORRECT")
    if effects == 0 and attempts < max: scheduleRetry(task)
    if effects == 0 and attempts >= max: escalate("UNKNOWN_COMMIT_NO_EFFECT")
    else:                               escalate("UNKNOWN_COMMIT_CONTRADICTORY")
```

`countEffects` is action-specific: consumption count for `sale:<orderId>:<item>`; reservation status/`consumedAt` for finalize; reservation status/`reservedStock` for release; `voids` entry for a void. A partial effect is never completed by a second write. Blind retry is prohibited.

### 4.7 Evidence required before resolution

| Level | Meaning | Permitted outcome |
|---|---|---|
| **E0** | No order or no reservation/movement evidence | `MANUAL_REQUIRED`; no action. |
| **E1** | One side present, the other missing/unreadable | `MANUAL_REQUIRED`; report `EVIDENCE_INCOMPLETE`. |
| **E2** | Order, reservation, movements, and inventory agree on the class | Eligible for the approved manual action. |
| **E3** | E2 plus a provable, idempotent intended after-state | Eligible for the single approved automatic class (R2), only in a future C5 worker. |

Resolution requires: recomputed fingerprint, action identity, before/after evidence, a distinct executor, and an append-only audit event. Verification requires a distinct verifier re-reading durable evidence, not a log line.

### 4.8 Append-only evidence history

| Record | Content |
|---|---|
| Evidence event | `taskId`, `orderId`, `fingerprint`, `capturedAt`, `capturedBy`, bounded redacted snapshot, `reason` (`DETECTION`, `RE_READ`, `DRIFT`, `EXECUTION`, `VERIFICATION`). |
| Task pointer | `evidenceFingerprint` (current authoritative pointer). |
| Task projection | Optional latest bounded snapshot for convenience; never the only copy. |

Rules:

1. Insert-only API; no update/delete/export path.
2. Every execution and verification records the fingerprint it acted on.
3. Drift appends a new event and changes task state; it never rewrites history.
4. Closed/cancelled tasks retain all evidence.
5. No TTL until retention is approved.
6. Audit failure aborts the action.

### 4.9 Worker disabled by default

- No schedule, cron, queue, or public route in the first implementation.
- The CLI exits unless an explicit enable flag is present.
- Worker identity is mandatory (`--worker-id` or an approved server-side identity); there is no default.
- `--execute` is mandatory; without it the worker is dry-run/read-only.
- No Staff cookie, POS session, or Manager PIN may act as the worker identity.
- Enabling a schedule is a C5 operation with its own ticket and gates.
- The kill switch stops future work but never deletes durable tasks.
- Audit failure aborts execution.

### 4.10 Illegal transitions

| Attempt | Result |
|---|---|
| `CLOSED`/`CANCELLED` → any | Rejected; a new divergence creates a new task. |
| `RESOLVED` → `RESOLVED` | Rejected; idempotent replay returns the stored result. |
| `LEASED` → `CLOSED` | Rejected; independent verification is mandatory. |
| `MANUAL_REQUIRED` → `RESOLVED` | Rejected; must pass through `LEASED`. |
| `MANUAL_REQUIRED` → `LEASED` without approval | Rejected. |
| `LEASED` → `RESOLVED` without E3 effect evidence | Rejected. |
| Any transition with a stale token | Rejected. |
| Any transition that changes payment identity or stock outside the approved primitive | Rejected. |

---

## 5. Detection rules (D)

### 5.1 Common read contract

- Allowed: `find`, `findOne`, `aggregate` with read stages only, `countDocuments`, `distinct`, `exists`, `explain`.
- Forbidden: every insert/update/delete, `findOneAndUpdate`, `bulkWrite`, index/collection operations, `$out`, `$merge`, side-effecting `$function`.
- Read from primary; one logical snapshot per order.
- Bounded by `--since`, `--until`, `--limit`, `--maxDocsPerOrder`.
- Deterministic order: `orderId`, then rule code.
- Redaction: account number to last 4; no PIN, token, cookie, session, or connection string.
- Every finding carries `readOnly: true`, `autoRecovery: "PROHIBITED"`, confidence, severity, evidence level, and `graceMs` where applicable.

### 5.2 Rule map

| Rule | Required class | R-map | Authoritative fields | Correlation | Severity / confidence | Evidence | Human review |
|---|---|---|---|---|---|---|---|
| **D01** | `PAID` missing required deduction | R1, R6 | `orders.status/paidAt/paymentMethod/items[].components`, `inventoryreservations.status/items/consumedAt/releasedAt/releaseReason`, `stockmovements` | `orderId`; `(orderId, itemId)` | Critical / High–Medium | E2 | Inventory manager + finance |
| **D02** | Deduction without payment/accounting evidence | R7 extension (not `R9`) | `stockmovements.refOrderId/reason/quantity/item/voidedAt/idempotencyKey`, order lifecycle, reservation voids | `orderId`; `sale:<orderId>:<item>` | High–Critical / Medium–High | E2 | Finance + inventory manager |
| **D03** | Duplicate stock movements | R5 | `stockmovements.refOrderId/item/reason/voidedAt/quantity/idempotencyKey/createdAt` | `(refOrderId, item, effectiveReason)`; key | Critical / High | E2 | Inventory + finance + DBA |
| **D04** | Duplicate/inconsistent reservations | R5, R7 | `inventoryreservations.orderId/status/items/approval/fingerprints/voids` | `orderId` | Critical–High / High–Medium | E2 | Inventory manager + DBA |
| **D05** | Expired/abandoned reservations | R2, R7 | reservation status/quantities/`decisionAt`/`updatedAt`, order status, `inventoryitems.reservedStock` | `orderId`; item-level hold | High–Medium / High–Medium | E2 | Inventory manager |
| **D06** | Stuck `CONSUMING` | R3 | reservation status/`updatedAt`/items/`consumedAt`, movements, inventory | `orderId` | Critical–High / High after threshold | E2 | Inventory manager + technical lead |
| **D07** | Partial multi-station deductions | R4, R6 | order lines/stations, reservation items, movements | `orderId`; item-level | High–Critical / High–Medium | E2 | Inventory manager + station lead |
| **D08** | Cancelled items with inconsistent inventory | R5, R7 | order status/`items[].cancelled/lineId`, reservation `voids`/hold, movements | `orderId`; `(orderId, lineId)` | High–Medium / High–Medium | E2 | Manager + inventory manager |
| **D09** | Payment verification/rejection inconsistency | R1, R7 | payment fields, order status, reservation, movements | `orderId` | Critical–High / Medium–High | E2 | Finance + inventory manager |
| **D10** | Missing/malformed/conflicting evidence | All | Every field used above plus schema enums/types | `orderId`, `taskId`, fingerprint | High–Critical / High–Medium | E1/E2 | Technical lead + data owner |

### 5.3 Rule-specific lifecycle and false-positive controls

| Rule | Must not fire when | Extra control |
|---|---|---|
| D01 | Inventory-free order; legacy deduction with no reservation; approved shortage; consumption still inside the active grace window | Report `NO_INVENTORY_REQUIREMENT` / `ALREADY_CORRECT_LEGACY` / `APPROVED_SHORTAGE` as INFO, not Critical |
| D02 | Normal `PREPARING` consumption without payment; whole-order cancellation with a valid void/reclassification | Lifecycle check is mandatory; never require `PAID` |
| D03 | One row reclassified `SaleDeduction → Waste`; repeated `Correction` rows with distinct context | Compare effective reason; report `INDEX_ABSENT_SUSPECTED` alongside duplicates |
| D04 | Concurrent reservation creation inside the edit grace; `NO_INVENTORY` with zero items; valid approval | Structural facts only; report fingerprint drift at Medium |
| D05 | Long-lived legitimate hold; deliberate `APPROVAL_REQUIRED`; release already in flight | Compare `reservedStock`, not `requiredQuantity`; report, never release |
| D06 | Transaction still inside `W_STALE`; movement is a voided/waste row | Threshold must exceed the approved transaction budget; alert only |
| D07 | Whole order consumed once at the first station by design; approved shortage; shared item across lines | Compare item totals, never per-line allocation |
| D08 | Cancellation retry in flight; `ARCHIVE` source instead of `ORDER`; item shared with an active line | Accept `{ORDER, ARCHIVE}` for whole-order; never release based on one cancelled line |
| D09 | `PAYMENT_PENDING`/`SERVED` after normal prep consumption; cash payment without verification fields; archived account resolved via snapshot | Do not model stock change from verification/rejection |
| D10 | Newer optional fields absent on legacy documents; transient mid-transaction state | Report `LEGACY_SHAPE` at INFO; never guess a missing value |

### 5.4 D02 and D09 classification

Per WD-02, neither rule becomes `R9`/`R10` in the first implementation:

- **D02** is a finding code that routes to `MANUAL_REQUIRED` under the nearest existing class context (R7). Its `findingClass` must be recorded exactly.
- **D09** routes to `MANUAL_REQUIRED` under R1/R7 context and records the payment-workflow contradiction.
- Neither may be coerced into an automatic R2/R4 action.
- Neither may alter payment identity, delete a movement, or invent a correction.

### 5.5 Legacy cutoff procedure (no date)

1. Read the earliest order with a reservation and the earliest `requirementFingerprint`.
2. Read the earliest order where every inventory-linked line has a stable `lineId` and component evidence.
3. Identify `SaleDeduction` rows without a reservation.
4. Sample before/after each candidate boundary for completeness.
5. Classify pre-cutoff evidence as `ALREADY_CORRECT_LEGACY`, `NO_INVENTORY_REQUIREMENT`, `PAID_NO_RESERVATION_NO_DEDUCTION` (Medium), or `LEGACY_SHAPE` + D10.
6. The owner signs the cutoff and exception policy.
7. The cutoff is a reporting boundary only; no data change, no backfill.

**Cutoff date remains unapproved.**

### 5.6 Line-level scope

| Level | Status |
|---|---|
| Item-level quantity reconciliation | Required. |
| Whole-order cancellation/void evidence | Required. |
| Line-level cancellation evidence (presence of a void) | Required, Medium confidence. |
| Line-level quantity correction | Deferred; requires an item/line allocation model. |

Reservations aggregate by inventory item, so a line-level gap is never reported as Critical without item-level proof.

### 5.7 D06 alert-only scope

| Observation | Output | Action |
|---|---|---|
| `CONSUMING`, age < `W_STALE` (deferred value) | none | Ignore. |
| `CONSUMING`, age ≥ `W_STALE` | D06 finding | Alert/report only. |
| Movements complete, no hold | `FINALIZE_CANDIDATE` label | Report; no task, no write. |
| Partial/ambiguous | Critical finding | Report; manual investigation. |

### 5.8 D05 report-only scope

Report terminal-order holds, paid-order holds, stale live holds, and orphans. Never release because of age. Release requires a terminal/abandoned order, no active line, no payment dependence, hold arithmetic agreement, a named approver and distinct executor, the existing primitive, and independent verification.

### 5.9 Shortage report-only scope

Report `shortageQuantity`, approval identity, timestamp, and reason. Do not assign loss, receivable, cost, valuation, or correction. Do not clamp stock. Do not treat shortage as negative stock.

### 5.10 Index verification dependency

Until `getIndexes()` evidence exists (G-IDX-1):

- D03/D04 must report duplicates **and** `INDEX_ABSENT` when uniqueness cannot be proven.
- No rule or gate may claim duplicates are impossible.
- The scanner must work in both index-present and index-absent topologies.
- WP-04 never creates, drops, or syncs an index.

### 5.11 Automatic repair prohibition

No D01–D10 finding may trigger an automatic correction in WP-04 or in the first worker. The only future automatic primitive named by the approved design is R2 idempotent consumption, and only after G-REC-2/G-REC-3/G-AUD-1/G-GOV-1 and a separate C5 enablement. Every other class is manual.

---

## 6. Implementation work packages (E)

Full detail is in `wp-04-implementation-work-packages.md`. Summary:

| Package | Title | Class | Prerequisite | Gate | Authorization |
|---|---|---|---|---|---|
| **WP04-00** | Implementation authorization and baseline lock | C0 | This blueprint | — | **OWNER AUTHORIZATION REQUIRED** |
| **WP04-01** | Rule registry, evidence projection, fingerprint | C1 | WP04-00 | G-REC-1 | **Separate implementation authorization** |
| **WP04-02** | Pure classifier D01–D10 | C1 | WP04-01 | G-REC-1 | Separate implementation authorization |
| **WP04-03** | Read-only scanner, guard, CLI, output | C1 | WP04-02 | G-REC-1 | Separate implementation authorization |
| **WP04-04** | DB-free fixtures and test suite | C1 | WP04-01..03 | G-REC-1 | Separate implementation authorization |
| **WP04-05** | Disposable replica-set read-only proof | C2 | WP04-03/04 | G-REC-1 | **Separate DB authorization** |
| **WP04-06** | Staging read-only pilot | C5 | WP04-05; approved staging | G-REC-1 | **Separate C5 authorization; currently blocked** |
| **WP04-07** | Durable recovery schema and repository | C2 | G-IDX-1 evidence; WD-02/07 | G-REC-2 | **Separate owner authorization** |
| **WP04-08** | Append-only evidence history and audit adapter | C2 | WD-07; WP-07 design | G-AUD-1 | **Separate owner authorization** |
| **WP04-09** | Claim/lease service and retry interface (disabled) | C1/C2 | WP04-07 | G-REC-2, G-REC-3 | **Separate owner authorization** |
| **WP04-10** | Worker CLI and manual escalation interface (disabled) | C5 | WP04-08/09; G-GOV-1 | G-REC-3 | **Separate C5 authorization** |
| **WP04-11** | RACI and operational interface | C0 | WD-03; owner names | G-GOV-1 | **Separate owner/operations authorization** |
| **WP04-12** | Index verification evidence | C3 | Owner/DBA window | G-IDX-1 | **Separate DBA/owner authorization** |

**Recommended first package:** `WP04-01`, but only after `WP04-00` records a separate implementation authorization. `WP04-00` is documentation and authorization only; it does not write code.

No package is authorized by this blueprint. Packages WP04-07 through WP04-12 are additionally blocked by unsigned gates.

---

## 7. Gate dependencies (F)

| Gate | Definition | Prerequisites | Current state |
|---|---|---|---|
| **G-REC-1** | Read-only reconciliation implemented, proven read-only, reviewed report for D01–D10 | WP04-01..06; approved staging sample | **UNSIGNED** |
| **G-REC-2** | Recovery schema and unique open-task index approved, deployed, verified | WD-02/07; G-IDX-1; WP04-07 | **UNSIGNED** |
| **G-REC-3** | Worker lease/retry/unknown-commit/escalation/kill-switch/audit proven | G-REC-2, G-AUD-1, G-GOV-1, G-DB-2/4; WP04-09/10 | **UNSIGNED** |
| **G-AUD-1** | Append-only audit available and tested; audit failure aborts the action | WD-07; WP04-08; WP-07 | **UNSIGNED** |
| **G-GOV-1** | RACI, dual control, independent verification signed with names/backups | WD-03; WP04-11 | **UNSIGNED** |
| **G-PAY-1** | Payment identity freeze proven on approved staging | Approved isolated staging | **BLOCKED** |

Gate rules:

1. No gate is signed or passed by this blueprint.
2. A policy approval does not substitute for evidence.
3. G-PAY-1 has no bypass; no staging requirement is waived.
4. G-REC-2 cannot be signed while G-IDX-1 evidence is absent.
5. G-REC-3 cannot be signed without G-REC-2, G-AUD-1, G-GOV-1, and the DB gates.
6. A C5 worker enablement remains a separate ticket after G-REC-3.
7. No gate may be signed by the person who produced the evidence without an independent verifier.

---

## 8. Security and authorization boundary

### 8.1 No new system roles

`ROLE-OWNER`, `ROLE-INVENTORY-APPROVER`, `ROLE-FINANCE-APPROVER`, `ROLE-RECOVERY-EXECUTOR`, `ROLE-INDEPENDENT-VERIFIER`, `ROLE-TECHNICAL-LEAD`, `ROLE-DBA`, `ROLE-OPERATIONS`, `ROLE-ONCALL`, and `ROLE-DATA-OWNER` are **organisational responsibilities**. They are not Staff roles, accounts, permissions, sessions, or API authorities. Mapping them to system identity is deferred and requires a separate approved schema/permission change.

### 8.2 Enforcement in code and evidence

- Approver ≠ executor on one task.
- Verifier ≠ approver and ≠ executor.
- The automated worker never approves or verifies.
- Developer/operator never approves a financial correction.
- A manager cannot self-verify their own execution.
- Backups must be named before production reliance.
- Distinctness is stored in task fields and audit events.

### 8.3 Worker identity

The worker identity is a server-side service identity. It must never derive from a Staff cookie, POS session, Manager PIN, or client-supplied header. Absence of an explicit identity is a hard stop.

### 8.4 External/manual writers

Until the external-writer register exists (WD-13): assume another writer may change the evidence, re-read immediately before action, treat cross-document contradictions as D10, and never run a hold-drift correction without checking for an external write window. Shared credentials and unlogged manual writes are prohibited.

### 8.5 Logging and redaction

Use `lib/operationalLogger.js`. Never log account numbers beyond last 4, PINs, tokens, cookies, sessions, or connection strings. Log task id, order id, class, sub-code, and fingerprint; not the full evidence payload. The public health endpoint stays coarse and never exposes task counts, order identifiers, or recovery state.

---

## 9. Rollback and stop conditions

### 9.1 Rollback principles

| Change type | Rollback posture |
|---|---|
| C1 source addition | Revert the additive package; no data migration. |
| Read-only scanner | Remove the CLI/module; no data cleanup required. |
| C2 schema/index | Stop; do not drop collections/indexes without a separate approved change. The read-only slice remains usable. |
| C5 worker | Disable the kill switch, stop the process, retain durable tasks. Never delete task/evidence history to "roll back". |
| Any data change | There is **no** approved data rollback in WP-04. A wrong write is a manual, evidence-preserving incident, not a scripted undo. |

### 9.2 Stop conditions

Stop and return to the owner if:

1. source behaviour cannot be established;
2. evidence is unavailable or unreadable;
3. a rule would change an accounting or inventory quantity;
4. production access is required;
5. a user change would be overwritten;
6. a business/accounting rule must be chosen;
7. the R1–R8 vocabulary cannot represent a class without an owner decision;
8. no approver, executor, or verifier is named;
9. the scanner cannot be proven read-only;
10. an index is assumed rather than verified;
11. a package would bundle C1 with C2/C3/C4/C5;
12. a staging run would touch non-disposable data.

---

## 10. Consistency and closing statement

This blueprint, `wp-04-implementation-work-packages.md`, and `wp-04-implementation-acceptance-matrix.md` use the same package IDs (WP04-00…WP04-12), the same seven statuses, the same D01–D10 vocabulary, and the same gate states. Any divergence is a documentation defect and blocks implementation until reconciled.

**Approved decisions: WD-01 … WD-14 (policy only, 2026-11-08).**
**Deferred decisions: as listed in the owner decision record §16.3.**
**WP-04 remains design-only; nothing is implemented.**
**No gate is signed. G-REC-1 remains unsigned. G-PAY-1 remains blocked.**
**Inventory V2 remains inactive.**

No database was contacted. No code, schema, route, API, index, script, test, or runtime configuration was created or changed. No stock, payment, accounting, or reservation record was mutated.