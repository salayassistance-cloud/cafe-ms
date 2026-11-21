# Phase 2.5 — Safety and Deployment Gates

Status: **READ-ONLY PLANNING — NOT EXECUTED, NOT AUTHORIZED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Basis: `phase-2-5-implementation-blueprint.md`, `phase-2-5-work-package-matrix.md`, `phase-2-5-test-and-acceptance-plan.md`
Purpose: invariants, environment gates, deployment rules, rollback, RPO/RTO, and stop conditions for Phase 2.5 implementation

> This document defines gates only. It does not authorize code, schema, index, migration, database, deployment, or production work. No database was contacted. No `.env`/`.env.local` value was read. No index was created or dropped. No destructive script was executed. No Inventory V2 runtime was activated. No `orderVersion` or `inventoryMode` field was added. No Hotel, Room Service, Waiter, Kitchen, Barista, Jebena Buna, POS UI, or unrelated API behaviour was changed.

Evidence labels:

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in the current source, tests, or git state. |
| **REAL-TESTED** | Proven by the Phase 2.3 disposable replica-set suite. |
| **INFERRED** | A logical consequence of verified code, not separately exercised. |
| **UNVERIFIED** | Requires staging, production, DBA, finance, or owner evidence. |
| **OWNER DECISION** | Requires a signed business, accounting, security, or operations decision. |

---

## 1. Non-negotiable invariants

These invariants hold for every work package. Any change that violates one is rejected, regardless of test results.

### 1.1 Financial invariants

| ID | Invariant | Enforcement |
|---|---|---|
| **INV-FIN-1** | Once an order first reaches `PAID`, its `paymentMethod`, `paymentAccountId`, and `paymentAccountSnapshot` never change. | WP-01 atomic `paidAt` guard; `409 PAYMENT_METHOD_IMMUTABLE` on conflicting `updatePayment`. |
| **INV-FIN-2** | `paidAt` is the single payment lock marker. No new `paymentLocked`, `paymentVersion`, or equivalent field is introduced. | Schema unchanged. |
| **INV-FIN-3** | A retried payment never creates a second payment identity and never changes the stored one. Exactly one `paidAt` per order. | Idempotent `payOrder`; concurrency test. |
| **INV-FIN-4** | Refunds and chargebacks are append-only adjustments. The original order/payment is never edited to represent a reversal. | WP-02, finance-gated. |
| **INV-FIN-5** | No accounting rule, tax treatment, revenue recognition, ledger account, journal entry, or provider semantics is invented. | Finance gate G-PAY-2. |
| **INV-FIN-6** | A legacy `PAID` order with `paidAt: null` is treated as frozen. No method backfill is authorized. | WP-01 rule; WP-03 report. |
| **INV-FIN-7** | Payment and inventory settlement are separate. Payment never rolls back because inventory failed, and no single transaction spans both. | Phase 2.4 Decision A; preserved. |

### 1.2 Inventory invariants

| ID | Invariant | Enforcement |
|---|---|---|
| **INV-INV-1** | `currentStock` and `reservedStock` are never written by a recovery action, script, or worker except through the existing conditional consumption/release/void primitives or an approved, audited correction movement. | WP-04/WP-06 source-contract tests. |
| **INV-INV-2** | `reservedStock` is never globally zeroed except by an approved WP-18 transactional procedure. | WP-08; WP-18 deferred. |
| **INV-INV-3** | One `SaleDeduction` per `(order, reason, item)` and one movement per `idempotencyKey`. | Unique partial indexes; WP-11/WP-12. |
| **INV-INV-4** | An ambiguous state (`R1`, `R3`, `R5`–`R8`) is never auto-repaired. | WP-06 executes only R2/R4. |
| **INV-INV-5** | Movement and reservation evidence is append-only; it is never deleted to make a reconciliation report clean. | WP-03/WP-04 read-only; WP-12 metadata-only. |
| **INV-INV-6** | Negative stock is reported, never silently clamped. | R8 manual. |

### 1.3 Data and schema invariants

| ID | Invariant | Enforcement |
|---|---|---|
| **INV-DATA-1** | No data migration or backfill is authorized in Phase 2.5. A step that appears to need one stops for a separate approved plan. | Blueprint §5; stop condition. |
| **INV-DATA-2** | No `syncIndexes()`, `dropIndexes()`, or automatic index drop. `createIndexes()` is additive only. | WP-11/WP-12; source tests. |
| **INV-DATA-3** | The obsolete `StockMovement` `(refOrderId, reason)` unique index is never recreated. | WP-12 forward-only rule. |
| **INV-DATA-4** | No V2 collection, model, route, index, or field is created. No `orderVersion`, no `inventoryMode`. | Exclusion tests; WP-11 scope. |
| **INV-DATA-5** | POS and Hotel databases remain separate. No cross-database transaction or shared schema. | Blueprint §1.3. |
| **INV-DATA-6** | Destructive administrative operations never delete `PAID`/`ARCHIVED` orders, `CONSUMED`/`CONSUMING` reservations, `StockMovement`, or `InventoryAudit`. | WP-08 refusals. |
| **INV-DATA-7** | Audit records are append-only. A correction is a new record, never an edit or delete. | WP-07. |

### 1.4 Scope invariants

| ID | Invariant | Enforcement |
|---|---|---|
| **INV-SCOPE-1** | No Hotel, Room Service, Waiter, Kitchen, Barista, Jebena Buna, POS UI, or unrelated API change. | Diff review; work-package exclusions. |
| **INV-SCOPE-2** | Inventory V2 remains unwired and inactive. | Exclusion tests; no V2 file imported. |
| **INV-SCOPE-3** | Recovery executes only R2 and R4 automatically. | WP-06 classifier and tests. |
| **INV-SCOPE-4** | A production destructive reset is impossible in Phase 2.5. | WP-08 hard-deny `403 DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION`. |
| **INV-SCOPE-5** | `scripts/clean-order-history.js` is retired and never replaced with another unconditional delete. | WP-09 source test. |
| **INV-SCOPE-6** | No secrets, connection strings, PINs, tokens, or full account numbers are logged, printed, or committed. | Redaction tests; operational logger. |

### 1.5 Governance invariants

| ID | Invariant | Enforcement |
|---|---|---|
| **INV-GOV-1** | No one approves and executes the same financial adjustment, and no one verifies their own execution. | WP-17 RACI; WP-02/WP-07 checks. |
| **INV-GOV-2** | The recovery worker never approves and never verifies. | WP-06 authorization. |
| **INV-GOV-3** | Every destructive, recovery, adjustment, index, and DB operation has a durable audit record where WP-07 is in scope. Audit failure aborts the action. | WP-07/WP-08. |
| **INV-GOV-4** | Every production operation has a named approver, executor, and independent verifier with backups. | WP-17; gate signature. |
| **INV-GOV-5** | No new system role is invented. Organisational roles are control slots, not authentication identities. | `lib/policy.js` unchanged. |

---

## 2. Environment model and gates

### 2.1 Environments

| Environment | Database | Purpose | Allowed in Phase 2.5 |
|---|---|---|---|
| **Local DB-free** | none | Unit/source-contract tests | Yes (no DB connection) |
| **Disposable replica set** | loopback `127.0.0.1:27019`, `bono_pos_phase25_*` | Transaction/concurrency/index proofs | Yes, opt-in only |
| **Staging** | Isolated staging cluster, disposable data | Operational drills, destructive gate, restore | Yes, with approval |
| **Production** | Production cluster | Read-only evidence only | **Read-only only; no write, no destructive, no index drop** |

### 2.2 Environment detection (proposed, fail closed)

A single helper must classify the environment. Markers, in order: `NODE_ENV`, `DEPLOY_ENV`, `VERCEL_ENV`, `CONTEXT`, `ENVIRONMENT`, `APP_ENV`. Values `production`, `prod`, `live` → production. Unknown → not production, but destructive mutation still requires the explicit non-production path and all preflight checks.

**Rule:** if production status is ambiguous for a destructive path, treat it as production and deny.

### 2.3 Gate table

| Gate | Applies to | Pass evidence | Approver | Blocks |
|---|---|---|---|---|
| **ENV-GATE-0 — Planning** | This document set | Four documents reviewed; no code/schema/DB change | Owner | All implementation |
| **ENV-GATE-1 — Local unit** | Every C1/C2 WP | DB-free suite + new tests pass | Technical lead | Any deploy |
| **ENV-GATE-2 — Disposable DB** | WP-01, WP-05, WP-06, WP-07, WP-10, WP-11, WP-12, WP-14 | Phase 2.3 16/16 + new integration pass | Technical lead | Schema/index/production |
| **ENV-GATE-3 — C2 schema** | WP-02, WP-05, WP-07 | Model/index tests; disposable unique/open-task proof; owner signs fields/retention | Owner + DBA | Dependent C1 code |
| **ENV-GATE-4 — C3 index** | WP-11, WP-12 | Duplicate preflight; before/after `getIndexes()`; staging proof | Owner + DBA + approval reference | Production index claim |
| **ENV-GATE-5 — Staging operational** | WP-08, WP-13, WP-15, WP-16 | Drill report; no duplicate; restore within RPO/RTO; alerts routed | Owner + operations/DBA | Production release |
| **ENV-GATE-6 — Production read-only** | WP-13 | Redacted topology/index evidence | Owner + DBA | Release sign-off |
| **ENV-GATE-7 — Production write** | **None in Phase 2.5** | Not reachable | — | All production writes |
| **ENV-GATE-8 — Production destructive** | WP-18 only | Deferred; separate approval | — | Contained by `403` |

### 2.4 Production hard rules

1. No Phase 2.5 work package performs a production write.
2. No production index create/drop outside an approved C3 window (WP-11 additive, WP-12 replacement).
3. No production restore, failover, or load test outside an approved C5 ticket.
4. No production destructive path; `403 DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION` is permanent in Phase 2.5.
5. Production read-only checks run only with `ENV-GATE-6`; they never select document content beyond counts and index metadata unless explicitly approved.
6. No production credential or `.env` value is read during planning or review.

---

## 3. Deployment rules by change class

### 3.1 Class rules

| Class | May contain | May not contain | Required before deploy |
|---|---|---|---|
| **C0** | Documents, RACI, runbooks | Code, schema, index | Owner review |
| **C1** | Application code, tests, read-only scripts, guards | Schema, index, data change, production operation | ENV-GATE-1 + targeted ENV-GATE-2 |
| **C2** | New model/collection/index definition | Code that requires the collection before verification | ENV-GATE-3; deploy before dependent C1 |
| **C3** | Index create/drop script and execution | Application feature code, data rewrite | ENV-GATE-4; separate window |
| **C4** | Data migration/backfill (none authorized) | Anything bundled with C1/C2/C3/C5 | Separate approved plan |
| **C5** | Production operation, drill, destructive run | Application feature code | ENV-GATE-5; separate ticket |

### 3.2 Sequencing rules

1. **C2 before C1 dependency.** A service that reads a new collection deploys only after the collection and its indexes are verified in that environment.
2. **C3 after duplicate preflight.** No unique index is deployed over unverified duplicates.
3. **C3 create before C3 drop.** WP-11 creates the new `StockMovement` index; WP-12 verifies it, then drops the old one.
4. **C1 before C5.** The gate/kill switch code must exist before any operational drill exercises it.
5. **C5 never inside a release.** A drill, restore, or destructive operation is its own change ticket with its own window.
6. **No mixed-class deploy.** A single deployment carries one class. Schema, index, migration, and operation are separate units.

### 3.3 Deployment checklist (every class)

| # | Item | Evidence |
|---|---|---|
| 1 | Branch/commit recorded; working tree contains only approved changes | `git status --short`, `git rev-parse HEAD` |
| 2 | No secret or `.env` file in the diff | diff review |
| 3 | No V2 file, `orderVersion`, or `inventoryMode` | search + test |
| 4 | No Hotel/POS UI file | diff scope |
| 5 | Baseline suite passes | ENV-GATE-1 |
| 6 | Targeted new tests pass | ENV-GATE-2 as applicable |
| 7 | Change class matches the deploy unit | review |
| 8 | Rollback/forward-recovery step documented | this document §5 |
| 9 | Approver/executor/verifier named | WP-17 |
| 10 | Evidence package stored | audit/release record |

---

## 4. Operational read-only reconciliation gate

### 4.1 Before recovery is enabled

The read-only reconciliation reports (WP-03, WP-04) are the minimum immediate control. Before any recovery worker is enabled:

1. Both reports run on staging with representative data.
2. The R1–R8 counts are reviewed by the Manager and finance reviewer.
3. Every `MANUAL_REQUIRED` class has a named owner and a manual procedure.
4. The reports are proven read-only (no write methods in source; DB unchanged).
5. The report output contains no secrets, account numbers, or PINs.

### 4.2 Recovery enablement gate

The worker remains disabled until all of the following are true:

| # | Requirement | Gate |
|---|---|---|
| 1 | Recovery schema and unique open-task index deployed and verified | G-REC-2 |
| 2 | Append-only audit deployed and proven | G-AUD-1 |
| 3 | Lease/retry/unknown-commit tests pass on a disposable replica set | G-REC-3 |
| 4 | Worker executes only R2/R4; manual classes escalate | G-REC-3 |
| 5 | Kill switch off by default; worker identity explicit; no public route | G-REC-3 |
| 6 | Alert routing and named on-call confirmed | G-DB-4 |
| 7 | RACI signed with approver/verifier backups | G-GOV-1 |

**Rule:** enabling the worker is a C5 operation. It is never part of a C1 code deploy.

### 4.3 Recovery execution rules

- R2 → existing idempotent `consumeOrderInventory`; no direct stock write.
- R4 → conditional `CONSUMED` finalization only when movements exist and no live hold remains; no stock change.
- R1, R3 ambiguous, R5–R8 → `MANUAL_REQUIRED`; no automatic action.
- Unknown commit → zero automatic retries; evidence re-read; resolve or escalate.
- Audit write failure → do not execute.
- Lease expiry → only the next owner may reclaim; evidence is re-read before action.

---

## 5. Rollback and forward recovery

### 5.1 Principles

1. **Financial and inventory history is forward-only.** Reverting code never restores a lost financial fact by rewriting history.
2. **No rollback deletes evidence.** Do not delete orders, reservations, movements, audit rows, adjustments, or recovery tasks to "reset" a failure.
3. **Prefer forward repair** with an audited, approved step.
4. **Restore is last resort**, into an isolated target first.

### 5.2 Rollback by work package

| WP | Rollback | Forward recovery |
|---|---|---|
| WP-01 | Do not revert. Disable the affected route path with a server-side guard and ship a forward fix. | Existing data needs no repair; a known overwritten method cannot be reconstructed. |
| WP-02 | Disable the route; keep the append-only collection. | New `VOIDED`/`CORRECTION` record; never edit history. |
| WP-03/WP-04 | None needed; read-only. | Fix a rule with a forward deploy. |
| WP-05 | Disable dependent code; keep the collection. Dropping is a C3/C5 decision, not a rollback. | Fix the model/index with a forward deploy. |
| WP-06 | Kill switch off; stop the scheduler; keep tasks/audit. | New audited step; never delete tasks. |
| WP-07 | Keep the collection; disable dependent features. | Append a correcting event. |
| WP-08 | Production is already denied. Disable the route/flag. | Non-production deletion is recoverable only from export/backup. |
| WP-09 | Do not restore the script. | Use WP-18 procedure if cleanup is ever required. |
| WP-10 | Re-activate an archived account with the existing `PUT`. | If a referenced account was wrongly deleted, restore from backup and reconcile. |
| WP-11 | Additive indexes may be dropped only by an approved C3 operation. | Leave and fix forward; never `syncIndexes()`. |
| WP-12 | **Forward-only.** Do not recreate the old unique `(refOrderId, reason)` index. | Recreate the new index from schema and verify; retry the exact drop. |
| WP-13 | None; read-only. | Fix the tool and redeploy. |
| WP-14 | Revert connection/transaction options with a code deploy. | Restore the previous approved value and re-verify. |
| WP-15/WP-16 | Production untouched; staging can be rebuilt. | Fix topology/configuration and rerun the drill. |
| WP-17 | Revise and re-sign. | No data rollback. |
| WP-18 | Deferred. | Report to owner; restore from verified backup. |

### 5.3 Incident rule

If a Phase 2.5 change is implicated in a production incident:

1. Set the kill switch / disable the affected route.
2. Preserve all evidence; do not delete data.
3. Capture logs and the audit trail.
4. Escalate per the RACI; finance reviewer joins for any financial divergence.
5. Prefer forward repair; restore only with owner/DBA approval into an isolated target first.

---

## 6. RPO, RTO, and backup expectations

### 6.1 Proposed values (require owner sign-off)

| Metric | Proposed value | Status |
|---|---|---|
| **RPO** | ≤ 15 minutes | **UNVERIFIED — OWNER DECISION** |
| **RTO** | ≤ 4 hours | **UNVERIFIED — OWNER DECISION** |
| Backup retention | Owner/finance decision; proposed ≥ 30 days for financial evidence | **UNVERIFIED — OWNER DECISION** |
| PITR window | Must match the claimed RPO if PITR is used | **UNVERIFIED** |
| Restore drill cadence | Quarterly, plus before any production write release | **OWNER DECISION** |

These are recommendations, not approved service levels. No restore was performed in Phase 2.5 planning; no RPO/RTO is claimed as achieved.

### 6.2 Backup/restore gate

| # | Requirement | Evidence |
|---|---|---|
| 1 | Backup mechanism named and enabled | provider configuration |
| 2 | Encryption at rest and offsite/cross-region copy confirmed | provider/DBA evidence |
| 3 | Isolated restore target available | staging/isolated cluster |
| 4 | Restore performed within the signed RTO | drill report |
| 5 | Data loss within the signed RPO | drill report |
| 6 | `counters` (especially `order_seq`) intact | restore verification |
| 7 | Unique indexes and partial filters present | `getIndexes()` after restore |
| 8 | WP-03/WP-04 reconciliation clean after restore | reconciliation output |
| 9 | Independent verifier signs | signed report |

### 6.3 Data integrity after restore

A restore is not complete until:

- order numbers do not collide with post-restore new orders;
- reservation uniqueness holds;
- sale-deduction and idempotency-key uniqueness hold;
- PAID/ARCHIVED orders and StockMovement evidence are intact;
- no duplicate payment identity exists;
- the reconciliation reports show no unexplained divergence.

---

## 7. Destructive administration gates

### 7.1 Production

`POST /api/manager/settings/clear-orders` returns `403 DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION` in production. This is unconditional in Phase 2.5. It is not configurable by a flag, environment variable, or PIN.

### 7.2 Non-production

The existing MANAGER + own PIN + literal `CLEAR-ORDERS`/`dryRun` contract remains, plus:

1. Dry-run is available and mutates nothing.
2. Refuse any `PAID` order.
3. Refuse any `ARCHIVED` order.
4. Refuse any `CONSUMING` reservation.
5. Refuse any open recovery task.
6. Refuse any V2 hold if a V2 collection is present.
7. Require a distinct second approver where the system supports it; otherwise record the approved ticket.
8. Write audit intent before mutation and audit result after.
9. Abort on audit failure.
10. Delete only non-PAID/non-ARCHIVED orders and non-CONSUMED/non-CONSUMING reservations; never StockMovement or InventoryAudit.
11. Reset the counter only when no orders remain.
12. Never clear `SystemAuth.activeWaiters` as part of order cleanup.

### 7.3 Future production enablement (WP-18, deferred)

Additional requirements: maintenance lock honoured by all writers, or transaction-level conflict; verified backup + logical export; named window; second approver; no open recovery task; V2-aware; staging race proof; owner/DBA/verifier sign-off.

---

## 8. Index deployment gates

### 8.1 Additive deployment (WP-11)

| # | Step | Pass condition |
|---|---|---|
| 1 | Duplicate preflight (read-only) | No duplicates for every new unique index |
| 2 | `getIndexes()` before | Snapshot captured |
| 3 | Create missing indexes only | `createIndexes()`, never `syncIndexes()` |
| 4 | Verify keys/options | Exact match to the blueprint table |
| 5 | Query-plan spot check | Key reads use the intended index |
| 6 | `getIndexes()` after | Diff shows only approved additions |
| 7 | Approval reference | `POS_INDEX_DEPLOY_APPROVAL` non-empty; never printed |

### 8.2 Replacement (WP-12)

| # | Step | Pass condition |
|---|---|---|
| 1 | Detect the old index by exact keys/options | Name and options recorded |
| 2 | Detect the new index by exact keys/options | Present and `unique: true` with partial filter |
| 3 | Duplicate preflight | Blocks on any duplicate |
| 4 | Dry-run | No writes |
| 5 | Create new index if missing | Verified |
| 6 | Second confirmation token | `DROP-OBSOLETE-STOCKMOVEMENT-INDEX` |
| 7 | Drop only the exact old index name | No other index touched |
| 8 | Verify | Multi-item sale deduction succeeds; duplicates rejected |
| 9 | Record | Before/after in the change ticket |

**Forward-only:** the old unique `(refOrderId, reason)` index is never recreated.

### 8.3 Index stop conditions

- Duplicate preflight non-empty.
- Old index keys/options differ from the expected shape.
- New index missing or wrong options.
- Missing approval reference.
- Any proposal to use `syncIndexes()` or `dropIndexes()`.
- Any request to bundle index work with a code release.

---

## 9. Stop conditions

Work stops and returns to the owner when any of the following occurs:

1. Branch, HEAD, or working-tree state differs from the recorded safe baseline in a way that would overwrite pre-existing work.
2. A step requires a production database, production credential, `.env` read, or destructive operation.
3. A required dependency, gate, or sign-off is missing.
4. A C2, C3, C4, or C5 change would be bundled with a C1 deploy.
5. A test or staging drill fails; it is not waived by another passing test.
6. A unique index build finds duplicates that would require deletion without an approved manual review.
7. A recovery action would write `currentStock`/`reservedStock` outside the existing conditional primitive.
8. A payment/refund/chargeback decision would require an invented accounting rule.
9. The RACI has no named approver, executor, or independent verifier.
10. A change would activate V2, add `orderVersion`/`inventoryMode`, change Hotel, or alter POS UI.
11. A proposal would recreate the obsolete `StockMovement` index or use `syncIndexes()`.
12. Audit is unavailable for a destructive or recovery action.

On a stop condition, the default is **deny and escalate**, never "proceed and fix later."

---

## 10. Final Phase 2.5 planning safety report

### 10.1 Required checks

| Check | Method | Expected |
|---|---|---|
| Branch | `git rev-parse --abbrev-ref HEAD` | `main` |
| HEAD | `git rev-parse HEAD` | `69650435a6587d4577bc126f719fa1392bb934b3` |
| Initial status | `git status --short` | 130 entries; SHA256 `9372adbd4bd7d776117e1e73a55552f0fc696fd5dd1db1b1c7abecf05c739a84` |
| Final status | `git status --short` | Same 130 pre-existing entries preserved |
| New documents | `docs/production-readiness/phase-2-5-*.md` | Exactly 4 |
| Tracked app files | diff against HEAD | No change |
| Secrets | search/diff | No `.env`/secret read or committed |
| Database | evidence | No connection opened |
| Production | evidence | No resource accessed |
| V2 | search | No V2 file/collection/field |
| Destructive | evidence | No script or route executed |

### 10.2 Report template

```
Phase 2.5 planning safety report
Date:
Branch:
HEAD:
Initial status entries (count):
Initial status SHA256:
Final status entries (count):
Final status SHA256:
Pre-existing paths preserved: yes/no
New documents created:
  1. docs/production-readiness/phase-2-5-implementation-blueprint.md
  2. docs/production-readiness/phase-2-5-work-package-matrix.md
  3. docs/production-readiness/phase-2-5-test-and-acceptance-plan.md
  4. docs/production-readiness/phase-2-5-safety-and-deployment-gates.md
Tracked application files changed: none
Database connected: no
.env/secret read: no
Index created/dropped: no
Migration/seed run: no
Destructive script run: no
Inventory V2 activated: no
orderVersion/inventoryMode added: no
Hotel/Room Service/Waiter/Kitchen/Barista/Jebena Buna/POS UI changed: no
Production service/deployment touched: no
Result: PASS / FAIL
```

### 10.3 Non-negotiable reporting rules

- Report the actual branch and HEAD; do not assume.
- Report both initial and final status.
- Confirm all pre-existing dirty/untracked paths are preserved.
- Confirm only the four new documents were added.
- Do not claim a test, restore, or drill that was not performed.
- Do not begin implementation after reporting; stop and await owner review.

---

## 11. Approval record

| ID | Gate/item | Approve / Reject / Defer | Conditions | Approver | Date |
|---|---|---|---|---|---|
| P25-G-01 | Invariants §1 | | | | |
| P25-G-02 | Environment gates §2 | | | | |
| P25-G-03 | Change-class rules §3 | | | | |
| P25-G-04 | Recovery enablement §4 | | | | |
| P25-G-05 | Rollback/forward recovery §5 | | | | |
| P25-G-06 | RPO ≤ 15 min / RTO ≤ 4 h §6 | | | | |
| P25-G-07 | Destructive production hard-deny §7 | | | | |
| P25-G-08 | Index deployment gates §8 | | | | |
| P25-G-09 | Stop conditions §9 | | | | |
| P25-G-10 | Safety report template §10 | | | | |

**No gate in this document is approved. Implementation begins only after explicit owner review and sign-off of the four Phase 2.5 documents.**
