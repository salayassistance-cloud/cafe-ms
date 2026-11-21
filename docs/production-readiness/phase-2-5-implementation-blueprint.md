# Phase 2.5 — Approved Decisions Implementation Blueprint

Status: **READ-ONLY PLANNING — NOT IMPLEMENTED, NOT AUTHORIZED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Owner approval basis: Phase 2.4 decisions **A–E** (design and policy only)
Companions: `phase-2-5-work-package-matrix.md`, `phase-2-5-test-and-acceptance-plan.md`, `phase-2-5-safety-and-deployment-gates.md`

> This document translates the owner-approved Phase 2.4 decisions into dependency-aware work packages. It does not implement them. No application code, test, schema, model, script, configuration, index, migration, database, deployment, or production resource was touched. No `.env`/`.env.local` value was read. No destructive script was executed. No Inventory V2 runtime was activated. No `orderVersion` or `inventoryMode` field was added. No Hotel, Room Service, Waiter, Kitchen, Barista, Jebena Buna, POS UI, or unrelated API behaviour was changed.

Evidence labels:

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in the current source, tests, or git state during Phase 2.5 planning. |
| **REAL-TESTED** | Proven by the Phase 2.3 disposable replica-set suite. |
| **INFERRED** | A logical consequence of verified code, not separately exercised. |
| **UNVERIFIED** | Requires staging, production, DBA, finance, or owner evidence. |
| **OWNER DECISION** | Requires a signed business, accounting, security, or operations decision. |

---

## 1. Authority, scope, and non-goals

### 1.1 What is authorized

The owner approved Phase 2.4 decisions **A–E** as design and policy. That approval authorizes planning, review, and separately gated implementation work. It does **not** authorize:

- access to a production database, production credentials, or secret files;
- index creation, index deletion, migration, seed, or `syncIndexes()`;
- deployment, production service start, or production failover;
- destructive administration or deletion of financial records;
- Inventory V2 activation or wiring;
- adding `orderVersion`, `inventoryMode`, or any V2 runtime field;
- changes to Hotel, Room Service, Waiter, Kitchen, Barista, Jebena Buna, POS UI, or unrelated APIs.

Every work package below is a proposal. Implementation starts only after the owner reviews this blueprint and the companion matrix, test, and gate documents.

### 1.2 In scope

1. Payment-method and financial-history immutability after the first successful `PAID` transition.
2. A read-only reconciliation capability for inventory/payment divergence.
3. Durable recovery-task state, lease ownership, bounded retry, evidence, and manual escalation.
4. Production safeguards for destructive administration.
5. V1 index deployment coverage for inventory, stock, payment-account, recovery, and audit collections; safe replacement of the obsolete `StockMovement` index.
6. Database operational readiness: topology, concerns, time budget, pool, failover, backup/restore, RPO/RTO.
7. Recovery responsibility, separation of duties, durable audit, and independent verification.

### 1.3 Explicit non-goals

- No monetary refund or chargeback implementation until finance approves accounting semantics. The adjustment ledger is defined but finance-gated.
- No automatic repair of R1, R3 (ambiguous), R5, R6, R7, or R8.
- No blind `$inc`/`$set` on `currentStock`, `reservedStock`, `paidAt`, payment balances, or payment identity.
- No single transaction spanning payment and inventory settlement.
- No transactional outbox in Phase 2.5; it remains the strategic target.
- No production enablement of `clear-orders`.
- No replacement for `clean-order-history.js`; it is retired.
- No V2 activation, V2 cutover, V2 shadow mode, or V2 index deployment.
- No Hotel changes. Hotel keeps its separate database, auth, payment model, and `RECORDED`/`VOIDED` policy.
- No POS UI changes. Any future UI requirement is a separate approved change.

---

## 2. Verified baseline and assumptions

### 2.1 Safety gate

| Check | Observed | Expected | Result |
|---|---|---|---|
| Branch | `main` | `main` | PASS |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` | same | PASS |
| Pre-existing status entries | **130** | 130 | PASS |
| Pre-existing paths preserved | yes | yes | PASS |
| Phase 2.4 decisions A–E read | 4 of 4 documents | 4 | PASS |
| Phase 2.2 / 2.3 reports read | yes | yes | PASS |
| Source inspection | completed | required | PASS |
| Code/schema/DB/index change | none | none | PASS |

The Phase 2.4 documents live under the already-untracked `docs/production-readiness/` directory. New files in that directory do not add a separate `git status` entry. No pre-existing dirty or untracked path was reset, cleaned, checked out, stashed, staged, committed, pushed, or overwritten.

### 2.2 Payment mutation paths (verified)

| Path | Current behaviour | Risk |
|---|---|---|
| `payOrder` (`lib/orderService.js`) | Filter accepts `SERVED`, `READY`, `PAID`; pipeline sets `paymentMethod` whenever a valid `pm` is supplied. `paidAt`/`completedAt`/`servedAt` use null guards; account snapshot is guarded by a null `paymentAccountId`. | A retry on an already-`PAID` order can overwrite `paymentMethod`; a transfer retry can set an account on a cash-paid order because the account guard keys on `paymentAccountId`, not `paidAt`. |
| `confirmPayment` | `PAYMENT_PENDING → PAID`; preserves the submitted method/account; sets `paidAt` with a null guard. | Correct today; must remain immutable and be covered by regression tests. |
| `submitPaymentForVerification` | `SERVED → PAYMENT_PENDING`; sets method/account before payment; does not mark `PAID`. | Pre-settlement mutation is allowed; must reject any `PAID`/`PAYMENT_PENDING` race through the atomic filter. |
| `rejectPayment` | `PAYMENT_PENDING → SERVED`; preserves method/account snapshot for audit. | Correct today; must not be able to run after `PAID`. |
| `updatePayment` | Calls `updateOrderFields` with an unconditional `$set`; then, if `status === "PAID"`, may stamp `paidAt`/`completedAt`/`servedAt`. | Can change the method of a `PAID` order and mutate timestamps without an atomic guard or durable audit. |
| `PATCH /api/orders/[id]` with only `paymentMethod` | Calls `updatePayment`. | Exposes the mutability gap through an authenticated API. |
| `PATCH /api/orders/[id]/status` MANAGER `SERVED → PAID` | Calls `payOrder`. | Same retry/method-overwrite risk as `payOrder`. |
| `PATCH /api/orders/[id]` `PAYMENT_PENDING → PAID` | Calls `confirmPayment`; does not accept a client method. | Correct canonical path. |

**Verified absence:** no monetary refund, chargeback, reversal, credit-note, provider event, provider webhook, or provider refund ID exists in POS. Hotel `HotelPayment` has a separate `RECORDED`/`VOIDED` model; it is not a POS refund ledger.

### 2.3 Recovery paths (verified)

| Fact | Evidence |
|---|---|
| No recovery collection, worker, queue, cron, lease, outbox, or scheduled endpoint exists. | Repository search; `package.json` has no queue/worker dependency. |
| Payment commits before inventory and is never rolled back by inventory failure. | `applyPaidInventory` in `lib/orderService.js`; Phase 2.3 real test. |
| Consumption is transactional and idempotent. | `consumeOrderInventory` / `runInTransaction` in `lib/inventoryReservationService.js`. |
| Reservation identity is unique per order. | `InventoryReservation.orderId` is `unique: true`. |
| Movement identity is unique per `(order, reason, item)` and per `idempotencyKey`. | `lib/models/StockMovement.js` partial unique indexes. |
| V1 helper: 3 attempts, 20 ms fixed delay, transient-only retry, unknown commit never retried, standalone `503 TRANSACTIONS_UNAVAILABLE`. | `lib/inventoryReservationService.js`; Phase 2.3 real tests. |
| V2 has recovery vocabulary but is unwired. | `lib/inventory-v2/domain/states.js`, `paymentReadiness.js`; no V1 import. |

**Consequence:** legitimate divergence states exist and have no durable owner. A read-only reconciliation report is the minimum immediate control; a worker is not safe without an approved lease, authorization, audit, and escalation model.

### 2.4 Destructive paths (verified)

| Entry point | Current behaviour | Phase 2.5 position |
|---|---|---|
| `POST /api/manager/settings/clear-orders` | MANAGER + own Staff PIN + literal `CLEAR-ORDERS` or `dryRun`; refuses any `PAID` order or `CONSUMING` reservation; deletes non-PAID/non-ARCHIVED orders and non-CONSUMED/non-CONSUMING reservations; zeroes every positive `reservedStock`; resets the counter only when no orders remain; emits one structured log line. | Production disabled by default. Non-production retains guarded behaviour. No production enablement in Phase 2.5. |
| `scripts/clean-order-history.js` | `Order.deleteMany({})` with no production guard, no PAID/CONSUMING guard, no reservation cleanup, no hold release, no audit. | Retire. Do not run. |
| `DELETE /api/payment-info?id=...` | Archives if one order references the account; otherwise hard-deletes; the order-check failure path falls through to hard delete; no step-up; no durable audit. | Archive referenced accounts; fail closed if reference status is unknown; step-up + audit for unused deletion. |
| `scripts/reset-auth.js` | Refuses `NODE_ENV=production`; resets legacy `SystemAuth` PINs and clears `activeWaiters`. | Out of scope; no change. Production uses the Staff PIN reset flow. |
| `scripts/test-*.js` / `scripts/test-*.mjs` | Several perform writes/deletes against an assumed disposable database. | Disposable databases only; not production tools. No change in Phase 2.5. |

### 2.5 Index deployment gap (verified)

`scripts/sync-indexes.js` and the connection-path background provisioning cover only:

1. `orders`
2. `staffs`
3. `categories`
4. `menuitems`
5. `inventoryaudits`

No repository script deploys indexes for `InventoryItem`, `InventoryReservation`, `StockMovement`, or `PaymentInfo`. `PaymentInfo` defines no indexes. The obsolete `StockMovement` `(refOrderId, reason)` index must be replaced by `(refOrderId, reason, item)`; `createIndexes()` will not drop it.

### 2.6 Database settings (verified)

| Setting | POS |
|---|---|
| `maxPoolSize` | 10 |
| `minPoolSize` | 0 |
| `serverSelectionTimeoutMS` | 3000 |
| `socketTimeoutMS` | 30000 |
| `connectTimeoutMS` | 10000 |
| `bufferCommands` | false |
| `readConcern` / `writeConcern` / `readPreference` / `retryWrites` | not set |
| Transaction options | none (`startTransaction()` with no options) |

Hotel uses a separate `ROOM_MONGODB_URI`, `dbName bono_hotel`, `autoIndex false`, `autoCreate false`, `maxPoolSize 10`, `serverSelectionTimeoutMS 5000`. Hotel remains out of scope.

### 2.7 Assumptions that remain true

- V1 is authoritative for orders, payments, reservations, stock, and station state.
- V2 remains unwired; no V2 collection or route is active.
- The POS and Hotel databases are separate; no cross-database transaction is proposed.
- The existing DB-free suite is the regression baseline; Phase 2.3 recorded **1370 tests / 245 suites / 0 fail / 0 skipped**.
- The existing disposable replica-set suite is the real-database baseline; Phase 2.3 recorded **16/16 pass**, including standalone `503 TRANSACTIONS_UNAVAILABLE`.

---

## 3. Work-package conventions

### 3.1 Change classes

| Class | Meaning | Examples | Deploy unit |
|---|---|---|---|
| **C0** | Read-only planning, review, or evidence | This blueprint; reconciliation runbook | No deploy |
| **C1** | Code-only; no schema, index, or data change | Payment freeze; reconciliation script; worker CLI; route guards | One application deploy |
| **C2** | Additive schema or collection | Recovery jobs; audit events; payment adjustments | Schema deploy before dependent code |
| **C3** | Index create/drop | V1 index coverage; obsolete index replacement | Separate approved index window |
| **C4** | Data migration or backfill | Duplicate remediation; legacy payment-method backfill | Separate approved migration; **none authorized by this blueprint** |
| **C5** | Production operation | Backup/restore drill; failover drill; destructive reset | Separate change ticket and maintenance window |

**Rule:** a single deployment must not mix C2, C3, C4, and C5. Code that depends on a new collection or index deploys only after the schema/index is verified. A C5 operation never runs as part of an application deploy.

### 3.2 Work-package states

| State | Meaning |
|---|---|
| **READY FOR REVIEW** | Scope is precise and can be approved for implementation. |
| **BLOCKED — OWNER/DBA** | Requires a signed value or environment decision. |
| **BLOCKED — FINANCE** | Requires accounting semantics before any code. |
| **BLOCKED — DEPENDENCY** | Requires another work package or deployment. |
| **DEFERRED** | Explicitly not in Phase 2.5. |

### 3.3 Work-package index

| ID | Work package | Decision | Class | Wave | Depends on | Status |
|---|---|---|---|---|---|---|
| WP-01 | Freeze payment identity after first `PAID` | B-1 | C1 | 0 | none | READY FOR REVIEW |
| WP-02 | Append-only payment adjustment ledger | B-2…B-6 | C2 + C1 | 3 | WP-07, finance gate | BLOCKED — FINANCE |
| WP-03 | Read-only payment reconciliation | B-8 | C1 | 1 | WP-01; WP-02 optional | READY FOR REVIEW |
| WP-04 | Read-only inventory reconciliation | A, D | C1 | 0 | none | READY FOR REVIEW |
| WP-05 | Recovery job schema and indexes | A | C2 | 1 | none | READY FOR REVIEW |
| WP-06 | Recovery lifecycle service and worker | A, E | C1 + C5 | 2 | WP-05, WP-07, WP-11 | READY FOR REVIEW |
| WP-07 | Durable POS audit foundation | A, C, E | C2 + C1 | 1 | none | READY FOR REVIEW |
| WP-08 | Destructive-admin production gate | C-1 | C1 + C5 | 2 | WP-05, WP-07, WP-17 | READY FOR REVIEW |
| WP-09 | Retire `clean-order-history.js` | C-2 | C1 | 1 | WP-08 policy | READY FOR REVIEW |
| WP-10 | Payment-account archive and step-up | C-5 | C1 | 2 | WP-07 | READY FOR REVIEW |
| WP-11 | V1 index coverage | D-4 | C1 + C3 | 2 | WP-05, WP-07 | READY FOR REVIEW |
| WP-12 | Replace obsolete `StockMovement` index | D-6 | C3 + C5 | 3 | WP-11, WP-13 | READY FOR REVIEW |
| WP-13 | Database readiness verification tooling | D-1, D-2, D-4 | C1 + C5 | 1 | none | READY FOR REVIEW |
| WP-14 | Transaction concerns, budget, and pool | D-2, D-3 | C1 | 3 | WP-13; D-2/D-3 sign-off | BLOCKED — OWNER/DBA |
| WP-15 | Backup/restore, RPO, and RTO | D-5 | C5 | 4 | WP-13, WP-14 | BLOCKED — OWNER/DBA |
| WP-16 | Failover, pool, and alerting staging proof | D-6 | C5 | 4 | WP-14, WP-15 | BLOCKED — OWNER/DBA |
| WP-17 | RACI, dual control, and independent verification | E | C0 | 1 | WP-06, WP-08, WP-10 | READY FOR REVIEW |
| WP-18 | Transactional/V2-aware destructive reset | C-1 future | C1 + C2 + C5 | 5 | WP-05, WP-07, WP-08, WP-17, separate V2 approval | DEFERRED |

---

## 4. Detailed work packages

### WP-01 — Freeze payment identity after the first `PAID`

- **Decision:** B-1.
- **Change class:** C1 — code-only.
- **Status:** READY FOR REVIEW. Implementation requires owner sign-off of the exact retry/error contract in §4.1.1.
- **Scope and exact paths:**
  - `lib/orderService.js` — `payOrder`, `updatePayment`, `updateOrderFields` (call-site only), and a new exported pure helper if needed.
  - `app/api/orders/[id]/route.js` — error mapping only; no UI change.
  - `app/api/orders/[id]/status/route.js` — error mapping only if the service throws a status-bearing error.
  - `tests/phase25-payment-immutability.test.mjs` (new).
  - `tests/integration/phase25-payment-immutability.integration.mjs` (new).
- **Dependencies:** none.
- **Proposed implementation sequence:**
  1. Define the frozen identity set: `paymentMethod`, `paymentAccountId`, `paymentAccountSnapshot`. The lock marker is the existing `paidAt`; no new schema field.
  2. `payOrder`: replace the unconditional `...(pm ? { paymentMethod: pm } : {})` with a pipeline conditional that sets the method only when `paidAt` is null/absent. Guard `paymentAccountId` and `paymentAccountSnapshot` on the same `paidAt` condition, not on a null account id.
  3. `payOrder`: keep the existing filter (`SERVED`, `READY`, `PAID`) so idempotent retries still return the stored order. A retry with a different method must preserve the first method; do not create a second payment.
  4. `updatePayment`: re-read the order with `status`, `paidAt`, `paymentMethod`, `paymentAccountId`, and `paymentAccountSnapshot`. If `paidAt` is non-null or `status === "PAID"`, treat the identity as frozen. Same method → return the order idempotently. Different method → throw a status-bearing `409 PAYMENT_METHOD_IMMUTABLE`. Never stamp `paidAt`/`completedAt`/`servedAt` from `updatePayment`.
  5. `updatePayment`: for a non-`PAID`, `paidAt: null` order, use an atomic filter that includes `paidAt: null` and `status: { $ne: "PAID" }`. On a miss, re-read and apply the frozen/same-method rules.
  6. Route mapping: `mapServiceError` already honors `err.status`; verify it returns `409` and the stable code without leaking internals.
  7. Add a structured `payment_method_preserved`/`payment_method_conflict` log event with order id, actor id, requested method, stored method, and result. Never log account numbers or PINs.
- **§4.1.1 Retry/error contract (requires owner sign-off):**
  - `payOrder` retry with the same method: `200`, original identity, no extra effect.
  - `payOrder` retry with a different method: `200`, original identity preserved; response may include an additive `paymentIdentityPreserved: true` marker. No new payment row.
  - `updatePayment` same method on `PAID`: `200`, no change.
  - `updatePayment` different method on `PAID`: `409`, stable code `PAYMENT_METHOD_IMMUTABLE`, no change.
  - Legacy `PAID` order with `paidAt: null`: treat as frozen (no mutation) and return the same conflict. A backfill is not authorized in Phase 2.5.
- **Data compatibility and backward compatibility:**
  - No schema change. Existing `PAID` orders keep their current method, account, and snapshot.
  - `payOrder` callers that retry with the same method see no change. Callers that retry with a different method no longer overwrite history.
  - `updatePayment` callers that edit a pre-`PAID` order keep working. `PAID` edits now return `409`. No POS UI uses the payment-method-only PATCH path today (verified).
  - Legacy `TELEBIRR` continues to normalize to `TRANSFER` on new writes; historical reads keep `TELEBIRR`.
- **Failure modes and recovery behaviour:**
  - Two concurrent `payOrder` calls with different methods: MongoDB serializes the document writes; the first sets `paidAt` and the method; the second sees a non-null `paidAt` and preserves it. Exactly one payment identity survives.
  - `payOrder` races `updatePayment`: `updatePayment` wins only while `paidAt` is null and `status != PAID`; `payOrder` may then set the first settled identity. If `payOrder` wins, `updatePayment` re-reads and returns `409` unless the requested method matches.
  - Lost response: a retry is idempotent; it must not create a second payment or change the identity.
  - Database/topology failure: no payment identity is changed; the caller receives the existing connection error contract.
- **Required automated tests (DB-free):**
  - Source-contract: `payOrder` has no unconditional `paymentMethod` set inside the `PAID`-eligible pipeline.
  - Source-contract: the account snapshot guard keys on `paidAt`, not `paymentAccountId`.
  - Source-contract: `updatePayment` no longer contains the `if (order.status === "PAID")` timestamp-stamping block.
  - Source-contract: `updatePayment` uses an atomic filter containing `paidAt: null` and `status: { $ne: "PAID" }`.
  - Pure-rule tests for the requested/stored method comparison, legacy normalization, and the conflict code.
- **Required disposable-database integration tests:**
  - First `payOrder` sets method, `paidAt`, and account snapshot.
  - Retry with the same method: one `PAID` state, one `paidAt`, one method, one snapshot.
  - Retry with a different method: method and snapshot unchanged; no second payment row.
  - Two concurrent `payOrder` calls with different methods: exactly one identity wins.
  - `updatePayment` on `PAID` with a different method: `409`, no database change.
  - `updatePayment` on `PAID` with the same method: `200`, no timestamp change.
  - `updatePayment` on `SERVED` with `paidAt: null`: allowed atomically; a concurrent `payOrder` cannot produce a torn identity.
  - `confirmPayment` preserves the submitted method and snapshot.
  - `submitPaymentForVerification` cannot run on `PAID`.
  - `rejectPayment` never changes `paidAt` or the method.
- **Manual verification:**
  - On staging, record a cash payment, a transfer payment, and a transfer payment with an account snapshot. Retry each via the API with the same and a different method. Inspect the stored order and the structured log.
  - Confirm no UI file changed and no account number or PIN appears in logs.
- **Rollback / forward recovery:**
  - **Forward-only.** Reverting the code would reintroduce the mutability defect. If a regression is found, disable the affected route path with a server-side guard and ship a forward fix.
  - Existing data needs no repair. If a historical method is known to have been overwritten, it cannot be reconstructed from POS data; record the limitation. Do not invent a backfill.
- **Exclusions:**
  - No refund, chargeback, credit-note, or monetary adjustment (WP-02).
  - No legacy `PAID` method backfill.
  - No POS UI change.
  - No change to `confirmPayment` semantics, station state, order status, or inventory.
  - No change to Hotel payments.

---

### WP-02 — Append-only payment adjustment ledger

- **Decision:** B-2, B-3, B-4, B-5, B-6.
- **Change class:** C2 (new collection) + C1 (service/route). Finance-gated.
- **Status:** BLOCKED — FINANCE. No code may be written until finance approves the accounting boundary and the owner signs the adjustment schema.
- **Scope and exact paths:**
  - `lib/models/PaymentAdjustment.js` (new) — append-only adjustment record.
  - `lib/paymentAdjustmentService.js` (new) — record, replay, cap, and status-transition rules.
  - `app/api/payments/adjustments/route.js` (new, authenticated; no UI) — only after finance approval.
  - `lib/policy.js` — proposed permissions; no role invention.
  - `tests/phase25-payment-adjustments.test.mjs` (new).
  - `tests/integration/phase25-payment-adjustments.integration.mjs` (new).
- **Dependencies:** WP-07 (durable audit), finance approval, owner approval of the adjustment fields and permissions.
- **Proposed record shape (design only):**
  - `adjustmentId` (server-generated unique), `orderId`, `orderNumber`, `originalPaymentRef` (`orderId` + `paidAt` + stored method snapshot).
  - `adjustmentType` ∈ `REFUND`, `CHARGEBACK`, `CORRECTION`.
  - `amountMinor` (integer minor units) and `currency`; the representation must be finance-approved.
  - `method`, `accountSnapshot` (for transfer), `reason` (bounded/sanitized).
  - `actorId`, `actorRole`, `approvedBy`, `approvedAt`, `verifierId`, `verifiedAt`.
  - `idempotencyKey`, `provider`, `providerEventId`, `providerRefundId`.
  - `status` ∈ `RECORDED`, `CONFIRMED`, `FAILED`, `VOIDED`; `createdAt`, `updatedAt`, `evidenceRef`.
  - No field may overwrite or negate the original order/payment fields.
- **Proposed indexes:**
  - `{ adjustmentId: 1 }` unique.
  - `{ orderId: 1, idempotencyKey: 1 }` unique.
  - `{ orderId: 1, createdAt: -1 }`.
  - `{ adjustmentType: 1, status: 1, createdAt: -1 }`.
  - `{ provider: 1, providerEventId: 1 }` unique partial where `providerEventId` is a string.
  - `{ provider: 1, providerRefundId: 1 }` unique partial where `providerRefundId` is a string.
- **Proposed implementation sequence:**
  1. Finance signs the accounting boundary: what is recorded, what is not recognized, how currency/minor units are represented, and who approves.
  2. Owner signs the permission matrix and retention.
  3. Add the model and indexes (C2), then deploy indexes through the approved C3 window.
  4. Add the append-only service: duplicate key with identical details replays; same key with different amount/method/reason returns `409`; cumulative confirmed refunds/chargebacks cannot exceed the original paid amount.
  5. Add the route with Manager approval + step-up, Cashier/Manager execution, and an independent verifier. No UI in Phase 2.5.
  6. Emit a WP-07 audit event for every adjustment and status transition.
- **Data compatibility and backward compatibility:**
  - Additive collection; existing orders/payments are untouched.
  - Hotel `HotelPayment` remains separate; this ledger must not be reused for Hotel.
  - No accounting rule, tax treatment, revenue recognition, ledger account, or journal entry is asserted by this blueprint.
- **Failure modes and recovery behaviour:**
  - Duplicate request: same key + identical payload replays the stored record; different payload returns `409` and creates nothing.
  - Over-refund: reject before writing; the original payment is unchanged.
  - Provider duplicate event: unique partial index rejects the second record; the service returns the stored result or a conflict.
  - Audit write failure: abort the adjustment write; no financial fact without an audit trail.
  - Partial failure: the adjustment status remains `RECORDED`/`FAILED`; a verifier resolves it; no silent retry of an unknown provider commit.
- **Required automated tests (DB-free):**
  - Field/enum/amount validation; idempotency-key rules; cumulative-cap rule; status-transition guard; no mutation of original payment fields in source.
  - Permission tests: Waiter cannot record/approve; Cashier cannot approve own adjustment; Manager approver must differ from executor where required.
- **Required disposable-database integration tests:**
  - Unique `(orderId, idempotencyKey)` rejects a duplicate.
  - Same key with different amount returns `409`.
  - Partial refunds accumulate to the paid cap; over-refund is rejected.
  - Full refund leaves the original order/payment intact.
  - Duplicate provider event/refund ID creates one record.
  - Audit event exists for every write.
- **Manual verification:**
  - Finance reviews a sample of records and the reconciliation report (WP-03).
  - Confirm no UI, no provider integration, and no Hotel path is wired.
- **Rollback / forward recovery:**
  - Disable the route; leave the append-only collection in place. Never delete adjustment history.
  - A bad record is corrected by a new `VOIDED`/`CORRECTION` record, not an edit.
- **Exclusions:**
  - No accounting rules, tax, revenue recognition, ledger accounts, or journal entries.
  - No provider gateway, webhook, signature verification, or refund polling.
  - No POS UI.
  - No Hotel refund model.
  - No automatic inventory restoration from a monetary adjustment.

---

### WP-03 — Read-only payment reconciliation

- **Decision:** B-8.
- **Change class:** C1 — code-only, read-only.
- **Status:** READY FOR REVIEW.
- **Scope and exact paths:**
  - `lib/paymentReconciliation.js` (new) — pure comparison rules.
  - `scripts/reconcile-payments.mjs` (new) — read-only CLI.
  - `tests/phase25-payment-reconciliation.test.mjs` (new).
  - `tests/integration/phase25-payment-reconciliation.integration.mjs` (new).
- **Dependencies:** WP-01 for the frozen identity guarantee. WP-02 is optional; the report runs with zero adjustments.
- **Proposed implementation sequence:**
  1. Define read-only checks: `PAID` with no `paidAt`; `PAID` with `paymentMethod` `NONE`/null; `TRANSFER` with no account snapshot; `paymentAccountId` with no snapshot; `CASH` with an account id; legacy `TELEBIRR` counts; adjustment without original payment; confirmed refunds + chargebacks > paid amount; duplicate provider event/refund id; failed/voided adjustment with provider success; unapplied provider event.
  2. Implement pure functions that accept plain records and return findings with stable codes.
  3. Implement the CLI: read-only connection, redacted output, `--since`, `--limit`, `--format json|table`, `--fail-on-findings`. Refuse `--apply`.
  4. Emit a summary and exit non-zero on findings only when requested.
- **Data compatibility:** no writes, no schema, no index dependency beyond query performance.
- **Failure modes:** read error → non-zero exit, no partial mutation; timeout → bounded query; unknown adjustment fields → report as `UNKNOWN_ADJUSTMENT_SHAPE`, do not guess.
- **Automated tests:** fixture-based rule tests for every check; a source-contract test that the script contains no `insert`, `update`, `delete`, `findOneAndUpdate`, or `bulkWrite`.
- **Disposable-database integration tests:** seed a disposable DB with clean and divergent fixtures; verify findings and exit codes; verify the DB is unchanged by comparing collection counts and document hashes.
- **Manual verification:** finance samples exceptions on staging; owner reviews the report format and retention.
- **Rollback / forward recovery:** read-only; no rollback. Fix a rule with a forward code deploy.
- **Exclusions:** no automatic correction; no monetary adjustment; no provider integration; no production write.

---

### WP-04 — Read-only inventory reconciliation

- **Decision:** A (durable recovery + explicit reconciliation), D (verification).
- **Change class:** C1 — code-only, read-only.
- **Status:** READY FOR REVIEW. This is the first implementation deliverable and the minimum immediate control.
- **Scope and exact paths:**
  - `lib/recovery/classify.js` (new) — pure R1–R8 classification.
  - `lib/recovery/reconciliation.js` (new) — read-only scanners.
  - `scripts/reconcile-inventory.mjs` (new) — CLI.
  - `tests/phase25-recovery-reconciliation.test.mjs` (new).
  - `tests/integration/phase25-recovery-reconciliation.integration.mjs` (new).
- **Dependencies:** none for detection. It uses existing models; the missing indexes may make scans slower but do not change correctness.
- **Proposed implementation sequence:**
  1. Implement read-only evidence readers for orders, reservations, inventory items, and stock movements.
  2. Implement classification:
     - **R1:** `PAID`, no reservation, no `SaleDeduction`; legacy deduction evidence is reported as `ALREADY_CORRECT_LEGACY`, otherwise `MANUAL_REQUIRED`.
     - **R2:** `PAID`, live reservation (`RESERVED`/`APPROVED`/`APPROVAL_REQUIRED`/`NO_INVENTORY`), no movement, positive hold or no-inventory marker; candidate for the existing idempotent consumption.
     - **R3:** stale `CONSUMING`; if movements prove the deduction landed exactly once, report `FINALIZE_CANDIDATE`; otherwise `MANUAL_REQUIRED`.
     - **R4:** movement exists and reservation is not `CONSUMED`; report `FINALIZE_CANDIDATE` only when no live hold remains; otherwise `MANUAL_REQUIRED` (possible R7).
     - **R5:** duplicate `SaleDeduction` for one `(order, item)`; `MANUAL_REQUIRED`.
     - **R6:** `CONSUMED` with `consumedQuantity > 0` and zero movement; `MANUAL_REQUIRED`.
     - **R7:** `reservedStock` greater than the sum of live reservation holds; `MANUAL_REQUIRED` with expected/actual.
     - **R8:** negative `currentStock` or `reservedStock`; `MANUAL_REQUIRED`.
  3. Add CLI filters (`--since`, `--limit`, `--class`, `--format`), stable finding codes, and a summary. Refuse `--apply`.
  4. Do not create recovery tasks in this WP. WP-06 consumes the same classifier.
- **Data compatibility:** none; read-only.
- **Failure modes:** missing indexes → slow scan, bounded by `--limit`; inconsistent read → report `EVIDENCE_INCOMPLETE`, do not guess; DB failure → non-zero exit.
- **Automated tests:** pure classification fixtures for R1–R8 and boundaries (`NO_INVENTORY`, released reservation, legacy movement, partial movement, hold drift); source-contract test that the script has no write calls.
- **Disposable-database integration tests:** seed each class; verify classification and counts; verify no document is modified.
- **Manual verification:** run on staging with representative volume; compare a sample against manual queries; record runtime and index usage (`explain` read-only).
- **Rollback / forward recovery:** read-only; no rollback.
- **Exclusions:** no task creation, no worker, no stock/payment correction, no automatic repair.

---

### WP-05 — Recovery job schema and indexes

- **Decision:** A-2.
- **Change class:** C2 — additive collection and indexes.
- **Status:** READY FOR REVIEW. Schema deployment is not authorized until the owner signs the fields and retention.
- **Scope and exact paths:**
  - `lib/models/InventoryRecoveryJob.js` (new) — collection `inventory_recovery_jobs`.
  - `tests/phase25-recovery-schema.test.mjs` (new).
  - Index deployment is executed through WP-11's guarded script; no index is created by this WP itself.
- **Dependencies:** none for the model; WP-11 for deployment; WP-07 for audit linkage.
- **Proposed fields:**
  - Identity: `_id`, `taskKey` = `RECOVERY:<orderId>` (stable order identity, non-unique), `taskId` = `RECOVERY:<orderId>:<server-generated ObjectId>` (unique), `orderId`, `orderNumber`, `reservationId`.
  - Classification: `class` ∈ `R1`…`R8`, `status` ∈ `DETECTED`, `LEASED`, `RETRY_SCHEDULED`, `MANUAL_REQUIRED`, `RESOLVED`, `CLOSED`, `CANCELLED`.
  - Open-task control: `isOpen` boolean. Unique partial `{ orderId: 1 }` with `{ isOpen: true }`.
  - Evidence: `evidenceFingerprint`, `evidence` (bounded snapshot of order status/paidAt, reservation status/items, stock/hold, movement ids/quantities), `manualReason`.
  - Execution: `attempts`, `maxAttempts` (default 5), `nextAttemptAt`, `leaseOwner`, `leaseUntil`, `leaseToken`, `lastErrorCode`, `lastErrorMessage`.
  - Approval/verification: `approvedBy`, `approvedAt`, `executedBy`, `executedAt`, `verifierId`, `verifiedAt`.
  - Resolution: `resolution` ∈ `APPLIED`, `ALREADY_CORRECT`, `ESCALATED`, `CANCELLED`; `resolvedAt`, `createdAt`, `updatedAt`.
- **Proposed indexes:**
  - `{ taskId: 1 }` unique.
  - `{ orderId: 1 }` unique partial `{ isOpen: true }`.
  - `{ status: 1, nextAttemptAt: 1 }`.
  - `{ status: 1, leaseUntil: 1 }`.
  - `{ class: 1, status: 1 }`.
  - `{ orderNumber: 1 }`.
  - `{ createdAt: -1 }`.
  - No TTL; closed tasks are retained.
- **Design refinement over Phase 2.4:** Phase 2.4 proposed `taskId = RECOVERY:<orderId>`. Because closed tasks are retained and a later divergence may need a new task, this blueprint uses a stable `taskKey` plus a unique server-generated `taskId` suffix, while retaining one-open-task-per-order through the partial unique index. This is a planning refinement, not an implementation.
- **Proposed implementation sequence:** model → schema tests → owner sign-off → WP-11 index deployment → verify unique open-task behavior on a disposable replica set.
- **Data compatibility:** additive; no change to orders, reservations, inventory items, stock movements, or counters.
- **Failure modes:** duplicate open task → unique index rejects; service re-reads and converges. Index build fails on duplicates → deployment stops; no data change. Model registration conflict → process fails closed.
- **Automated tests:** field/enum definitions; unique and partial index definitions; no TTL; no V2 collection name; no `orderVersion`/`inventoryMode`.
- **Disposable-database integration tests:** insert two open tasks for one order → second rejected; close the first → a new open task is allowed; closed history remains.
- **Manual verification:** `getIndexes()` shows the exact keys/options; no V2 collection created.
- **Rollback / forward recovery:** additive collection; disable dependent code. Dropping the collection is a C3/C5 operation requiring approval; it is not a rollback step in Phase 2.5.
- **Exclusions:** no worker, no detection, no automatic repair, no V2, no TTL, no data backfill.

---

### WP-06 — Recovery lifecycle service and worker

- **Decision:** A-3, A-4, A-6; E-2, E-3.
- **Change class:** C1 (service/CLI) + C5 (scheduling in a later approved operation).
- **Status:** READY FOR REVIEW, but production scheduling is blocked until WP-17 and the owner's alert/on-call decision.
- **Scope and exact paths:**
  - `lib/recovery/taskService.js` (new) — create/converge, acquire/renew/release lease, bounded retry, escalate, close.
  - `lib/recovery/classify.js` (shared with WP-04).
  - `scripts/recovery-worker.mjs` (new) — operator-invoked CLI; no public route.
  - `tests/phase25-recovery-lifecycle.test.mjs` (new).
  - `tests/integration/phase25-recovery-worker.integration.mjs` (new).
- **Dependencies:** WP-05 (schema), WP-07 (audit), WP-11 (indexes), WP-17 (ownership).
- **Lease and retry contract:**
  - Lease duration: 5 minutes; renewal only by the same `leaseOwner` with a live lease; `leaseToken` increments on acquisition.
  - Acquisition filter: `DETECTED`, or `RETRY_SCHEDULED` with `nextAttemptAt <= now`, or `LEASED` with `leaseUntil < now`. `$inc attempts`, set owner/until/token atomically.
  - `maxAttempts = 5`; backoff 30 s → 60 s → 120 s → 240 s → 480 s, capped at 15 min, jittered. No retry after max; escalate to `MANUAL_REQUIRED`.
  - Unknown commit: zero automatic retries; re-read evidence. If the effect is present exactly once → `RESOLVED`/`ALREADY_CORRECT`; if absent → retry the same action identity within budget; if contradictory → `MANUAL_REQUIRED`.
  - Transient transaction error: bounded retry of the same idempotent step. Topology unavailable: schedule later, alert, do not hammer.
- **Worker authorization:**
  - A server-side worker identity supplied by `RECOVERY_WORKER_ID` or a CLI flag; never a Staff session, cookie, or POS client.
  - No default identity; the CLI refuses to start without it and without an explicit `--execute` flag.
  - The worker may execute only R2 and R4. R1, R3 (ambiguous), R5, R6, R7, R8 always escalate.
  - The worker cannot approve or verify its own task. A Manager/financial reviewer approves manual steps; an independent verifier checks the after-state.
  - Kill switch: `RECOVERY_WORKER_ENABLED` (proposed name) defaults off; the CLI exits when off. Tasks remain durable.
  - No public endpoint; no scheduler in Phase 2.5. A scheduler is a separate C5 operation.
- **Action rules:**
  - R2: call `consumeOrderInventory` with the existing idempotent transaction. Never write `currentStock`/`reservedStock` directly.
  - R4: conditionally finalize `CONSUMED` only when movements exist and no live hold remains; no stock change. Otherwise escalate.
  - R3: finalize only when movements prove the deduction landed exactly once and no hold remains; otherwise manual.
  - R1/R5/R6/R7/R8: no automatic action.
- **Proposed implementation sequence:** task service → lease/retry tests → classifier integration → CLI → disposable replica-set tests → staging manual run → owner approval for scheduling.
- **Data compatibility:** additive; existing reservation/consumption primitives unchanged.
- **Failure modes:** worker crash → lease expires, next worker re-reads evidence; duplicate worker → one lease winner; stale lease → reclaim only after expiry; evidence change → update snapshot and re-classify; audit write failure → do not execute the action; topology down → schedule/alert.
- **Automated tests (DB-free):** task identity; open-task convergence; state-transition guards; lease filter; renewal; backoff; unknown-commit rule; manual-class mapping; worker cannot approve; source-contract no direct stock/ payment writes.
- **Disposable-database integration tests:** two workers race one task; lease expiry reclaim; crash after committed deduction; unknown commit; transient retry; R2 idempotent; R4 no stock change; R3 ambiguous manual; R5–R8 manual; audit record; worker cannot execute manual classes.
- **Manual verification:** staging run with `--once`; inspect task/audit/evidence; kill switch; confirm no public route.
- **Rollback / forward recovery:** set the kill switch off; stop the scheduler; leave tasks and audit intact. Do not delete tasks to "reset" a failure. A bad action is corrected by a new audited forward step, not a blind reversal.
- **Exclusions:** no automatic R1/R3/R5–R8; no payment reversal; no stock restoration except an approved correction movement; no public API; no V2; no scheduler in Phase 2.5.

---

### WP-07 — Durable POS audit foundation

- **Decision:** A (audit evidence), C (destructive audit), E (separation and verification).
- **Change class:** C2 (new collection) + C1 (append-only service).
- **Status:** READY FOR REVIEW. Retention is an owner/finance decision; no TTL is proposed by default.
- **Scope and exact paths:**
  - `lib/models/PosAuditEvent.js` (new) — collection `pos_audit_events`.
  - `lib/posAuditService.js` (new) — append-only `recordAuditEvent`.
  - `lib/policy.js` — only if a new permission is required; no new role is invented.
  - `tests/phase25-audit.test.mjs` (new).
  - `tests/integration/phase25-audit.integration.mjs` (new).
- **Dependencies:** none for the model; WP-06, WP-08, and WP-10 depend on it.
- **Proposed fields:**
  - `eventId` (server-generated unique; ObjectId or ULID), `domain` ∈ `RECOVERY`, `DESTRUCTIVE_ADMIN`, `PAYMENT_ADJUSTMENT`, `INDEX_DEPLOYMENT`, `DB_OPERATION`, `PAYMENT`.
  - `action`, `correlationId`, `orderId`, `taskId`, `ticketId`.
  - `actorType` ∈ `STAFF`, `WORKER`, `OPERATOR`, `SYSTEM`; `actorId`, `actorRole`.
  - `approverId`, `verifierId`, `reason`.
  - `evidence`, `filters`, `before`, `after` (bounded, redacted).
  - `result` ∈ `SUCCESS`, `FAILED`, `PARTIAL`, `ESCALATED`, `INFO`.
  - `createdAt`; no `updatedAt` mutation path.
- **Proposed indexes:**
  - `{ eventId: 1 }` unique.
  - `{ domain: 1, createdAt: -1 }`.
  - `{ orderId: 1, createdAt: -1 }`.
  - `{ taskId: 1, createdAt: -1 }`.
  - `{ actorId: 1, createdAt: -1 }`.
  - `{ correlationId: 1 }`.
  - No TTL until the owner/finance sets retention.
- **Proposed implementation sequence:** model → append-only service (insert only; no update/delete API) → redaction tests → integrate WP-06/08/10 → deploy indexes through WP-11.
- **Data compatibility:** additive; no change to existing logs or collections.
- **Failure modes:** audit insert failure must abort a destructive action; for recovery, the task remains open and the action is not retried blindly. Duplicate `eventId` is a programming error; reject and alert.
- **Automated tests:** no update/delete/remove exports; every event has actor/domain/action/result; sensitive values are redacted; approver/verifier distinctness rules where required.
- **Disposable-database integration tests:** append-only insert; unique event id; query by domain/order/task; no update/delete path.
- **Manual verification:** owner/finance reviews sample records and retention; confirm no PIN, token, secret, or full account number is stored.
- **Rollback / forward recovery:** append-only; never delete a record to fix it. Corrections are new events. Disable dependent features if the service is unavailable.
- **Exclusions:** no log shipping, alert sink, UI, TTL, or statutory retention claim. No replacement for the existing Hotel audit collection.

---

### WP-08 — Destructive-admin production gate

- **Decision:** C-1, C-3, C-4, C-8.
- **Change class:** C1 (route/guard) + C5 (production operation).
- **Status:** READY FOR REVIEW. Production execution remains **hard-denied** in Phase 2.5; WP-18 is the only path to enable it.
- **Scope and exact paths:**
  - `app/api/manager/settings/clear-orders/route.js`.
  - `lib/destructiveAdmin.js` (new) — environment gate, ticket/approval validation, second-approver rule.
  - `lib/policy.js` — only if a new permission is required; keep `settings:clearOrders` MANAGER.
  - `tests/phase25-destructive-admin.test.mjs` (new).
  - `tests/clear-orders-safety.test.mjs` — regression expectations updated only in the implementation phase.
- **Dependencies:** WP-05 (open recovery tasks), WP-07 (audit), WP-17 (approver/verifier roles). WP-18 is required before any production enablement.
- **Proposed production gate (fail closed):**
  1. Detect production using the same markers as `scripts/sync-indexes.js`: `NODE_ENV`, `DEPLOY_ENV`, `VERCEL_ENV`, `CONTEXT`, `ENVIRONMENT`, `APP_ENV`. If any is `production`, `prod`, or `live`, production rules apply. An unrecognized marker group is not treated as production by itself, but the route still refuses to mutate unless the non-production path is explicit.
  2. In production, return `403 DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION` unconditionally until WP-18 is complete and the owner signs a separate production-enablement change. This is the approved "disabled by default" posture and is stronger than an environment flag.
  3. In non-production, preserve the current MANAGER + own Staff PIN + `CLEAR-ORDERS`/`dryRun` contract, plus the new preflight/audit requirements below.
  4. If a future approved WP-18 enables production, the gate must additionally require: a non-empty change ticket matching `POS_DESTRUCTIVE_ADMIN_APPROVAL`, a verified backup reference, a logical export reference, a named maintenance window, a second distinct approver, and the absence of any open recovery task or V2 hold.
- **Proposed preflight additions (non-production and future production):**
  - Refuse any `PAID` order (existing).
  - Refuse any `ARCHIVED` order (new; preserve historical evidence).
  - Refuse any `CONSUMING` reservation (existing).
  - Refuse any open `inventory_recovery_jobs` task (`isOpen: true`).
  - Refuse any V2 hold if a V2 collection exists. Detection is read-only; V2 remains unwired.
  - Refuse if the backup/export reference is missing when the operation is considered destructive (non-dry-run).
- **Dual control:**
  - The requesting Manager remains the executor.
  - The second approver must be a distinct identity. The strongest system-enforced form is a second Manager Staff id + PIN verified by `verifyStaffPinById`, with `secondApproverStaffId !== auth.payload.staffId`. If the business cannot provide a second Manager, an owner/operations ticket reference is recorded, but the blueprint does not claim that as cryptographic dual control.
  - The audit record stores executor, approver, ticket, preview counts, export/backup reference, filters, before/after, and result.
- **Proposed implementation sequence:** gate helper → production hard-deny → non-production preflight additions → dual-control fields → audit intent/result → tests → staging run.
- **Data compatibility:** production API callers now receive `403` by default; this is intentional. Non-production behaviour remains compatible except for the additional refusals. No schema or data change.
- **Failure modes:** audit write failure → abort before mutation; missing/ambiguous backup → abort; second approver same as executor → reject; open recovery task → reject; concurrent `CONSUMING` transition → preflight refuses, and production remains disabled so the residual race is not exposed; partial delete → not possible to "undo" without restore/export, which is why production is denied.
- **Automated tests:** production gate matrix; dry-run mutates nothing; PAID/ARCHIVED/CONSUMING/open-task refusals before any delete; delete filters preserve evidence; StockMovement/InventoryAudit untouched; counter reset only when empty; distinct approver enforced; audit intent/result; no PIN/token in logs.
- **Disposable-database integration tests:** seed each refusal state and verify zero writes; seed a deletable state and verify exact counts; verify audit rows; verify dry-run leaves counts unchanged.
- **Manual verification:** non-production staging only; confirm production marker returns `403`; confirm no UI caller exists; confirm the operation is not enabled in production.
- **Rollback / forward recovery:** disable the route/flag; production is already denied. A non-production deletion cannot be undone except from the export/backup; this is why it remains test-only.
- **Exclusions:** no production enablement; no transactional reset; no V2 activation; no `activeWaiters` cleanup; no catalog deletion; no deletion of PAID/ARCHIVED orders, CONSUMED/CONSUMING reservations, StockMovement, or InventoryAudit.

---

### WP-09 — Retire `clean-order-history.js`

- **Decision:** C-2.
- **Change class:** C1 — code/repository change.
- **Status:** READY FOR REVIEW.
- **Scope and exact paths:**
  - `scripts/clean-order-history.js` — delete, or replace with a fail-closed stub that always exits non-zero with an explanation. The recommended action is deletion.
  - `tests/phase25-destructive-admin.test.mjs` (new) — source test that no unconditional `Order.deleteMany({})` remains and the script is absent or permanently disabled.
  - No `package.json` script references it today (verified).
- **Dependencies:** WP-08 policy approval.
- **Proposed implementation sequence:**
  1. Search the repository for references to `clean-order-history`.
  2. Add a source test that fails if an executable `Order.deleteMany({})` path returns to `scripts/`.
  3. Delete the script.
  4. Document in the implementation report that operators must not use old copies; an external copy cannot be controlled by the repository.
- **Data compatibility:** no data change. The destructive capability disappears from the repository; this is the intended safety improvement.
- **Failure modes:** an operator running an old external copy bypasses the repository; mitigation is credential/network control and the retirement notice. The script must never be replaced with a "safer" version that still deletes PAID history.
- **Automated tests:** file absent or stub exits non-zero; no `Order.deleteMany({})`; no `SystemAuth.activeWaiters` side effect in order cleanup.
- **Disposable-database integration tests:** none required for deletion. If a stub is retained, run it against a disposable DB and assert it refuses before connecting.
- **Manual verification:** repository search; confirm no operational runbook instructs its use; confirm `activeWaiters` cleanup is a separate operational action.
- **Rollback / forward recovery:** do not restore the script. If order-history cleanup is required, use the approved WP-18 procedure with export/backup/dual control.
- **Exclusions:** no replacement script; no `activeWaiters` cleanup; no data deletion; no production operation.

---

### WP-10 — Payment-account archive and step-up

- **Decision:** C-5.
- **Change class:** C1 — code-only (audit uses WP-07).
- **Status:** READY FOR REVIEW.
- **Scope and exact paths:**
  - `app/api/payment-info/route.js` — `DELETE` handler.
  - `lib/paymentInfoService.js` (new, optional) — reference check and archive decision; keeps the route thin.
  - `tests/phase25-payment-accounts.test.mjs` (new) or an extension of `tests/payment-accounts.test.mjs`.
  - `tests/integration/phase25-payment-accounts.integration.mjs` (new).
- **Dependencies:** WP-07 for durable audit.
- **Proposed implementation sequence:**
  1. Validate the account id.
  2. Determine reference status with a read-only query. If the query fails, **fail closed** with `503`/`500`; never fall through to hard delete.
  3. If referenced by any order: set `isActive: false`; never delete; return `{ archived: true, disabled: true }`.
  4. If not referenced: require a MANAGER step-up PIN in the body (`currentManagerPin`), verified against the requesting Staff record. Without it, return `400 STEP_UP_REQUIRED`.
  5. Only after step-up, hard-delete the unused account. Record a WP-07 audit event with actor, account id, used/archived/deleted, reason, and timestamp.
  6. Preserve all `paymentAccountSnapshot` values on historical orders; never rewrite them.
- **Data compatibility:** referenced-account behaviour is unchanged. Unused-account deletion now requires a step-up; this is a deliberate security change. Historical snapshots are untouched.
- **Failure modes:** reference query failure → no delete; audit write failure → no delete; step-up failure → no delete; concurrent order creation referencing the account → the order check and delete are not atomic. Mitigation: archive-only is always safe; for unused hard delete, use a conditional delete after re-checking, and accept a residual race only for an account that was unused at both checks. If strict safety is required, make all deletes archive-only.
- **Automated tests:** referenced → archive; unreferenced without PIN → `400`; unreferenced with wrong PIN → `401`; unreferenced with correct PIN → delete + audit; reference query failure → no hard delete; snapshot untouched.
- **Disposable-database integration tests:** create an order referencing an account; delete → archived; create an unused account; delete with step-up → removed; audit rows exist; concurrent reference test.
- **Manual verification:** Manager UI flow; confirm no account number is logged; confirm historical order snapshots remain.
- **Rollback / forward recovery:** re-activate an archived account with the existing `PUT` `isActive: true`; a hard-deleted unused account has no financial history to restore. If a referenced account was incorrectly hard-deleted, restore from backup and reconcile; this is why the fail-closed reference check is mandatory.
- **Exclusions:** no rewrite of order snapshots; no hard delete of a referenced account; no POS UI change; no Hotel payment account.

---

### WP-11 — V1 index coverage

- **Decision:** D-4.
- **Change class:** C1 (script/model/test) + C3 (index deployment).
- **Status:** READY FOR REVIEW; deployment is a separate approved C3 operation.
- **Scope and exact paths:**
  - `scripts/sync-indexes.js` — add the V1 models and new collections.
  - `lib/mongodb.js` — add the same models to non-production background provisioning.
  - `lib/models/PaymentInfo.js` — add the proposed `{ createdAt: -1 }` index for the list query.
  - `tests/pos-index-management.test.mjs` — extend the coverage regression.
  - `tests/phase25-index-coverage.test.mjs` (new) — exact index definitions and coverage.
  - `tests/integration/phase25-index-coverage.integration.mjs` (new).
- **Dependencies:** WP-05 and WP-07 for the new model files; WP-02 if the adjustment ledger is approved. The script can be extended in stages; each stage is additive.
- **Exact V1 index definitions to deploy:**

| Collection | Index | Options | Purpose |
|---|---|---|---|
| `inventoryitems` | `{ category: 1, status: 1 }` | non-unique | Category/status listing |
| `inventoryitems` | `{ supplier: 1, status: 1 }` | non-unique | Supplier/status listing |
| `inventoryreservations` | `{ orderId: 1 }` | **unique** | One reservation per order |
| `inventoryreservations` | `{ orderNumber: 1 }` | non-unique | Lookup |
| `inventoryreservations` | `{ status: 1 }` | non-unique | Queue |
| `inventoryreservations` | `{ requirementFingerprint: 1 }` | non-unique | Diagnostics |
| `inventoryreservations` | `{ shortageFingerprint: 1 }` | non-unique | Diagnostics |
| `inventoryreservations` | `{ status: 1, createdAt: 1 }` | non-unique | Approval queue |
| `inventoryreservations` | `{ status: 1, updatedAt: -1 }` | non-unique | Stale holds |
| `stockmovements` | `{ item: 1, createdAt: -1 }` | non-unique | Reporting |
| `stockmovements` | `{ reason: 1, createdAt: -1 }` | non-unique | Consumption/waste reporting |
| `stockmovements` | `{ refOrderId: 1, reason: 1, item: 1 }` | **unique partial** `{ refOrderId: { $type: "objectId" } }` | One sale deduction per order/item |
| `stockmovements` | `{ idempotencyKey: 1 }` | **unique partial** `{ idempotencyKey: { $type: "string" } }` | Purchase-receipt idempotency |
| `paymentinfos` | `{ createdAt: -1 }` | non-unique | List query |
| `inventory_recovery_jobs` | see WP-05 | unique/partial as defined | Recovery task identity |
| `pos_audit_events` | see WP-07 | unique/query indexes | Append-only audit |
| `payment_adjustments` | see WP-02 | unique/partial as defined | Finance-gated adjustment ledger |

- **Existing-index conflicts:**
  - The obsolete `StockMovement` `(refOrderId, reason)` index is not dropped by `createIndexes()`. WP-12 handles it.
  - A pre-existing duplicate for a new unique index makes `createIndexes()` fail. The script must report the conflict and exit non-zero; no index is dropped.
  - `PaymentInfo` has no existing indexes; `{ createdAt: -1 }` is additive.
- **Proposed implementation sequence:**
  1. Add models to `scripts/sync-indexes.js` and the background provisioning list.
  2. Add `PaymentInfoSchema.index({ createdAt: -1 })`.
  3. Add source tests that assert exact coverage and that `syncIndexes()` never returns.
  4. Run on a disposable replica set: create indexes, insert duplicates, verify failure is reported.
  5. Staging: run `node --env-file=<staging> scripts/sync-indexes.js --confirm` after duplicate preflight. Production: `--allow-production` plus `POS_INDEX_DEPLOY_APPROVAL`.
  6. Capture before/after `getIndexes()` through WP-13.
- **Data compatibility:** additive indexes only; no document rewrite. A unique index build can fail on existing duplicates; that is a data-remediation gate, not an automatic cleanup.
- **Failure modes:** duplicate values → build fails, existing indexes untouched; permissions → exit non-zero; partial build → rerun is idempotent; old index remains until WP-12.
- **Automated tests:** exact model/index coverage; `PaymentInfo` index; no `syncIndexes` in connection path; production auto-index off; scripts require `--confirm`/`--allow-production`/approval.
- **Disposable-database integration tests:** create all indexes; verify keys/options; duplicate reservation rejected; duplicate sale deduction rejected; duplicate idempotency key rejected; `PaymentInfo` query uses the index.
- **Manual verification:** index inventory dump; no URI printed; staging query plans for key reads.
- **Rollback / forward recovery:** additive indexes can be dropped only by an approved C3 operation; the default is to leave them and fix forward. Never use `syncIndexes()` to "clean up."
- **Exclusions:** no `syncIndexes()`; no automatic drop; no old-index replacement (WP-12); no V2 indexes; no data migration.

---

### WP-12 — Replace the obsolete `StockMovement` index

- **Decision:** D-6.
- **Change class:** C3 (index create/drop) + C5 (maintenance operation).
- **Status:** READY FOR REVIEW; execution requires a separate approved window.
- **Scope and exact paths:**
  - `scripts/replace-stockmovement-index.mjs` (new) — guarded, dry-run-first replacement.
  - `tests/phase25-stockmovement-index.test.mjs` (new) — source/guard tests.
  - `tests/integration/phase25-stockmovement-index.integration.mjs` (new) — disposable replica-set proof.
  - No application code change is required for the index itself. The schema already defines the new index.
- **Dependencies:** WP-11 (new index created), WP-13 (inventory dump), WP-14 (topology/concerns verified).
- **Why replacement is required:** the old unique `(refOrderId, reason)` index rejects valid multi-ingredient sale deductions. The new unique partial `(refOrderId, reason, item)` is the correct identity. `createIndexes()` creates the new index but never drops the old one.
- **Proposed script contract:**
  - Requires `--confirm`; production requires `--allow-production` and a non-empty `POS_INDEX_DEPLOY_APPROVAL`.
  - Dry-run is the default; `--execute` is required to write.
  - Step 1: `getIndexes()`; locate the old index by exact key order `{ refOrderId: 1, reason: 1 }`. Record its name, `unique`, and partial options.
  - Step 2: locate the new index by exact keys `{ refOrderId: 1, reason: 1, item: 1 }`, `unique: true`, partial `{ refOrderId: { $type: "objectId" } }`.
  - Step 3: duplicate preflight (read-only):
    - Group all documents with `refOrderId` of type ObjectId by `{ refOrderId, reason, item }`; any count > 1 blocks.
    - Group string `idempotencyKey` values; any count > 1 blocks.
  - Step 4: create the new index if missing; verify it exists with exact options.
  - Step 5: if the old index exists, require `--drop-obsolete` plus a second literal confirmation token (proposed `DROP-OBSOLETE-STOCKMOVEMENT-INDEX`). Drop it by the exact discovered name only. If keys/options differ, refuse.
  - Step 6: verify post-state; print redacted before/after; exit non-zero on any mismatch.
- **Proposed execution order:** preflight duplicates → create new index → verify → application-compatible write test on staging (multi-ingredient consumption) → drop old index in the approved window → verify `getIndexes()` and a multi-item sale deduction.
- **Data compatibility:** no document rewrite. If duplicates exist, no unique index is created; a separate approved data-remediation plan is required. The old index is only dropped after the new one is verified.
- **Failure modes:** duplicate preflight fails → stop, no writes; new index build fails → old index remains, multi-item orders remain blocked; drop fails → new index remains, old still blocks; app writes during the window → if old remains, multi-item writes fail; schedule a maintenance window with no concurrent sale deductions.
- **Rollback / forward recovery:** **forward-only.** Do not recreate the old unique `(refOrderId, reason)` index; it is harmful. If the new index is missing after the drop, recreate it from the schema and re-verify. If the drop was partial, verify and retry the exact drop. Restore from backup only if index metadata cannot be repaired.
- **Automated tests:** exact key/options detection; refusal on mismatched old index; duplicate preflight; dry-run performs no writes; source-contract no `syncIndexes`/`dropIndexes`; second token required for drop.
- **Disposable-database integration tests:** create the old index and multi-item data; prove the old index rejects a valid multi-item sale; run the replacement; prove multi-item deduction succeeds; prove duplicate `(order, reason, item)` is rejected; prove duplicate idempotency key is rejected; verify index inventory.
- **Manual verification:** before/after `getIndexes()`; DBA/operator and developer sign-off; staging multi-item payment/consumption.
- **Rollback / forward recovery:** no data rollback; forward repair only. Record the exact old index name and options in the change ticket.
- **Exclusions:** no automatic drop; no `syncIndexes()`; no data rewrite; no V2 indexes; no production execution without a signed window.

---

### WP-13 — Database readiness verification tooling

- **Decision:** D-1, D-2, D-4.
- **Change class:** C1 (read-only script) + C5 (operator execution on staging/production).
- **Status:** READY FOR REVIEW.
- **Scope and exact paths:**
  - `scripts/verify-db-readiness.mjs` (new) — read-only evidence collector.
  - `tests/phase25-db-readiness.test.mjs` (new) — source/guard tests.
  - `tests/integration/phase25-db-readiness.integration.mjs` (new) — disposable replica-set proof.
- **Dependencies:** none to build; WP-11 for the full index list.
- **Proposed checks (read-only):**
  - `hello` / `isWritablePrimary`, `setName`, `hosts`, `primary`, `me`.
  - `rs.status()` summary if the target is a replica set; `mongos` detection if applicable.
  - `getDefaultRWConcern`.
  - Effective URI options reviewed without printing the URI.
  - `getIndexes()` for `orders`, `staffs`, `categories`, `menuitems`, `inventoryaudits`, `inventoryitems`, `inventoryreservations`, `stockmovements`, `paymentinfos`, and any new approved collections.
  - Duplicate preflight for `inventoryreservations.orderId`, `stockmovements.(refOrderId, reason, item)`, and `stockmovements.idempotencyKey`.
  - Collection counts and index presence; no document content export.
- **Proposed implementation sequence:** implement read-only commands → redaction tests → disposable run → staging read-only evidence → production read-only evidence only with owner/DBA approval.
- **Data compatibility:** none; no writes.
- **Failure modes:** connection failure → non-zero exit, no partial output; unsupported admin command → report `UNSUPPORTED`, do not guess; credentials/URI → never print.
- **Automated tests:** source-contract no write methods; redaction of URI/credentials; exact command list; exit codes.
- **Disposable-database integration tests:** run against a disposable replica set and a standalone target; verify topology/index/duplicate output; verify no writes.
- **Manual verification:** DBA reviews staging output; production read-only output is attached to the gate record.
- **Rollback / forward recovery:** none; read-only.
- **Exclusions:** no failover, load test, backup, restore, index create/drop, or migration. Those are WP-15/WP-16/WP-12.

---

### WP-14 — Transaction concerns, budget, and pool

- **Decision:** D-2, D-3.
- **Change class:** C1 — code-only.
- **Status:** BLOCKED — OWNER/DBA. The exact values require D-2/D-3 sign-off; this blueprint proposes values but does not approve them.
- **Scope and exact paths:**
  - `lib/mongodb.js` — connection options and transaction budget constants.
  - `lib/inventoryReservationService.js` — `runInTransaction` transaction options and observability.
  - `tests/phase25-transaction-policy.test.mjs` (new) — source-contract tests.
  - `tests/integration/phase25-transaction-policy.integration.mjs` (new) — disposable replica-set proof.
- **Proposed values for sign-off (not approved):**

| Parameter | Proposed value | Rationale |
|---|---|---|
| `writeConcern` (connection and transaction) | `{ w: "majority" }` | Explicit durability; owner/DBA must confirm the cluster supports it. |
| `readConcern` (non-transactional) | `{ level: "local" }` | Primary reads; no snapshot requirement outside a transaction. |
| `readConcern` (transaction) | `{ level: "snapshot" }` | Transaction-consistent reads; validate on the deployed topology. |
| `readPreference` | `"primary"` | Payment/inventory read-after-write correctness. |
| `retryWrites` | `true` | Documented driver behavior; confirm it survives the URI. |
| `maxCommitTimeMS` | `4000` | Below the ~5 s gateway deadline; owner/DBA may choose a lower value. |
| Transaction operation `maxTimeMS` | `3000` | Bound individual inventory queries; no unbounded scan. |
| Pool | `maxPoolSize 10`, `minPoolSize 0` | Keep current unless staging load proves otherwise. |
| Retry budget | 3 attempts, transient-only, 20 ms fixed delay | Preserve Phase 2.3 V1 behavior; unknown commit never retried. |

- **Proposed implementation sequence:**
  1. Owner/DBA signs the values and the failover expectation.
  2. Add explicit connection options in `lib/mongodb.js`; do not change Hotel.
  3. Pass transaction options in `runInTransaction`; preserve the existing retry/unknown-commit rules.
  4. Apply `maxTimeMS` to the bounded queries inside reservation/consumption transactions.
  5. Emit structured events for retry, unknown commit, and `TRANSACTIONS_UNAVAILABLE`.
  6. Run disposable and staging proofs before production.
- **Data compatibility:** no data change. Latency/durability behavior may change; staging proof is mandatory. Existing idempotency and atomic filters remain.
- **Failure modes:** topology unsupported → `503 TRANSACTIONS_UNAVAILABLE`; transient error → bounded retry; unknown commit → no retry, evidence resolution; pool exhaustion → fail fast (no buffering); failover → transaction commits once or fails cleanly.
- **Automated tests:** source-contract that concerns/options are explicit; unknown commit not retried; retry bounded; session always ends; no `syncIndexes`.
- **Disposable-database integration tests:** commit/abort; transient retry commits once; unknown commit does not duplicate; standalone `503`; concern options accepted; bounded query timeout.
- **Manual verification:** staging failover and pool test in WP-16; DBA reviews the effective concern output.
- **Rollback / forward recovery:** revert connection/transaction options with a code deploy; no data rollback. If a concern value causes an outage, fail closed and restore the previous approved value.
- **Exclusions:** Hotel connection; retryable-write changes without approval; unbounded transaction lifetime; payment/inventory business logic changes.

---

### WP-15 — Backup, restore, RPO, and RTO

- **Decision:** D-5.
- **Change class:** C5 — production operations.
- **Status:** BLOCKED — OWNER/DBA. No backup, restore, or production operation is authorized by this blueprint.
- **Scope and exact paths:**
  - No application code. Operational evidence is stored outside the repository and referenced by the release gate.
  - The drill uses an isolated target with the same major MongoDB version and topology class.
- **Dependencies:** WP-13 (topology/index evidence), WP-14 (concerns), owner D-9/D-10/D-11 decisions.
- **Required decisions:**
  - Backup mechanism: Atlas continuous backup, scheduled `mongodump`, or filesystem snapshot.
  - PITR window (if claimed) and retention.
  - Encryption at rest and offsite/cross-region copy.
  - RPO/RTO values. **Proposed for sign-off:** RPO ≤ 15 minutes; RTO ≤ 4 hours. These are recommendations, not approved values.
  - Restore owner and independent verifier.
  - Restore drill cadence (monthly/quarterly/per release).
- **Drill sequence:**
  1. Provision an isolated target; never restore over production.
  2. Restore the latest backup; if PITR is claimed, restore to a chosen point.
  3. Verify `counters` (especially `order_seq`).
  4. Verify unique indexes and partial filters for reservations, stock movements, and any new approved collections.
  5. Run WP-04/WP-03 read-only reconciliation.
  6. Smoke-test read paths in a sandbox; no production write test.
  7. Record actual RTO and RPO, row counts, index list, reconciliation output, operator, and verifier.
- **Pass criteria:** restore within approved RTO; data loss within approved RPO; counters intact; unique indexes present; PAID/ARCHIVED and StockMovement evidence intact; no unexplained reconciliation divergence; evidence package reviewed by an independent verifier.
- **Failure modes:** restore failure → keep production untouched; retry on a fresh isolated target; do not "repair" production from an unverified backup. Missing counters/indexes → fail the drill and fix the backup/restore procedure.
- **Automated tests:** none for the backup product; the drill checklist is the test. WP-13's verification script is used against the restored target.
- **Disposable-database integration tests:** restore into a disposable target; verify counts/indexes; run reconciliation.
- **Manual verification:** owner/DBA/verifier sign the drill report.
- **Rollback / forward recovery:** production is not modified. If a restore is ever required in an incident, restore to an isolated target first, verify, then follow the approved cutover. Forward recovery is preferred over in-place destructive repair.
- **Exclusions:** no production restore; no backup configuration change without owner approval; no Hotel database drill unless separately approved; no RPO/RTO claim without measured evidence.

---

### WP-16 — Failover, pool, and alerting staging proof

- **Decision:** D-6; A/E alerting.
- **Change class:** C5 — staging operations; C1 for event names only if needed.
- **Status:** BLOCKED — OWNER/DBA. Staging only; never production.
- **Scope and exact paths:**
  - Staging environment with a replica set or mongos and disposable data.
  - `lib/operationalLogger.js` event names only if a missing signal is identified; no new sink code in Phase 2.5.
  - No production cluster operation.
- **Dependencies:** WP-14 (concerns/budget), WP-15 (backup/restore), owner alert sink/on-call.
- **Required proofs:**
  - Primary step-down during a transaction: transaction commits once or fails cleanly; no duplicate deduction.
  - Primary step-down during a normal write: driver retries or returns a clean error; no partial write.
  - Network partition: fails closed; no split-brain duplicate.
  - Rolling restart: no lost acknowledged write; pool recovers.
  - Pool saturation: requests fail cleanly (503/429) before the gateway deadline; no unbounded queue.
  - `TRANSACTIONS_UNAVAILABLE` burst: alert fires; requests fail with 503; no silent success.
  - Backup success/failure and restore-drill date: alert/visibility exists.
  - Recovery signals: PAID-without-deduction, duplicate movement, negative stock, stale `CONSUMING`, hold drift, retry exhaustion.
- **Failure modes:** a failed drill is a release blocker; do not "pass" by relaxing the criterion. A production failover is prohibited.
- **Automated tests:** none against production; staging scripts/logs are the evidence.
- **Disposable-database integration tests:** use the disposable harness for transaction/failover-adjacent behavior where possible; a true step-down requires a staging cluster.
- **Manual verification:** operations/DBA run the drill; developer verifies no duplicate; finance/verifier reviews reconciliation.
- **Rollback / forward recovery:** staging can be rebuilt; no production rollback. Fix the topology/configuration and rerun.
- **Exclusions:** production failover; Hotel; V2; load test against production.

---

### WP-17 — RACI, dual control, and independent verification

- **Decision:** E-1…E-4.
- **Change class:** C0 — governance and evidence.
- **Status:** READY FOR REVIEW; names must be assigned before production.
- **Scope and exact paths:**
  - This blueprint and `phase-2-5-safety-and-deployment-gates.md` define the proposed matrix.
  - Signed approval/verification records are stored outside the repository or in an approved audit system; no personal names are invented here.
  - `lib/policy.js` is unchanged unless a future approved system-enforced permission is required.
- **Dependencies:** WP-06, WP-08, WP-10.
- **Role slots (organisational, not system roles):** `OWNER`, `OPERATIONS`, `DBA`, `FINANCE_REVIEWER`, `MANAGER`, `CASHIER`, `DEVELOPER_OPERATOR`, `RECOVERY_WORKER`, `INDEPENDENT_VERIFIER`.
- **Proposed RACI:**

| Activity | Approves | Executes | Independently verifies |
|---|---|---|---|
| Read-only reconciliation | Manager / operations (schedule) | Developer/operator or worker | Finance reviewer (sample/exceptions) |
| R2 recovery | Manager (standing approval for deterministic class) | Worker/operator | Manager or finance reviewer not in execution |
| R4 recovery | Manager (standing approval) | Worker/operator | Finance reviewer |
| R1/R3 ambiguous | Manager + finance reviewer | Developer/operator | A person who did not execute |
| R5 duplicate movements | Finance reviewer + Manager | Manual accounting review; no automated repair | Independent reviewer |
| R6 consumed without movement | Finance reviewer + Manager | Manual ledger reconstruction | Independent reviewer |
| R7 hold drift | Manager after evidence review | Developer/operator with conditional audited correction | Independent reviewer |
| R8 negative stock | Manager + finance reviewer | Manual correction only, as a new audited movement | Independent reviewer |
| Monetary refund | Manager + finance reviewer | Cashier/Manager | Finance reviewer |
| Chargeback | Finance reviewer | Manager/operator records provider evidence | Independent reviewer |
| Stock correction | Manager | Manager/operator, reason + before/after | Another Manager or finance reviewer |
| `clear-orders` / destructive reset | Owner + operations (ticket) | Named operator | Second approver verifies counts/export/result |
| Index deployment | Owner + DBA/operations | DBA/operator | Developer verifies index dump |
| Backup/restore drill | Owner + operations | DBA/operator | Finance reviewer verifies reconciliation |

- **Separation rules:**
  1. No one approves and executes the same financial adjustment.
  2. No one verifies their own execution.
  3. The worker never approves; it executes only R2/R4 and escalates the rest.
  4. The developer/operator never approves a financial correction.
  5. The finance reviewer is not the implementer.
  6. Manager self-approval is not independent verification.
- **Proposed implementation sequence:** owner assigns names/backups → sign the matrix → train operators → record in the audit service → verify during staging drills.
- **Data compatibility:** none; no schema, no role change. System enforcement is limited to distinct Staff ids where applicable; non-Staff organisational roles are operational controls, not new accounts.
- **Failure modes:** no named backup → production gate fails; same person in two roles → audit/verification rejects where system-enforced, otherwise the release is not signed.
- **Automated tests:** audit service tests for approver/executor/verifier distinctness; policy tests confirm no invented role.
- **Disposable-database integration tests:** none required; audit insert/read tests in WP-07.
- **Manual verification:** signed matrix and drill records.
- **Rollback / forward recovery:** revise and re-sign; no data rollback.
- **Exclusions:** no new system roles, no auth changes, no permission escalation, no named individuals in this planning document.

---

### WP-18 — Transactional/V2-aware destructive reset (deferred)

- **Decision:** C-1 future; C-8.
- **Change class:** C1 + C2 + C5.
- **Status:** **DEFERRED — NOT AUTHORIZED.** Production remains hard-denied in Phase 2.5.
- **Scope and exact paths:**
  - `app/api/manager/settings/clear-orders/route.js`.
  - `lib/destructiveAdmin.js`.
  - A future maintenance-lock model/collection (name to be approved).
  - Tests and staging proof.
- **Dependencies:** WP-05, WP-07, WP-08, WP-17; a separate V2 activation approval; a signed backup/export procedure.
- **Why deferred:** the current reset is non-transactional and has a residual `CONSUMING` race. It also globally zeroes `reservedStock` and is not V2-aware. Production must not run it until a transaction/lock design is approved and proven.
- **Proposed design constraints (not implemented):**
  - Acquire a maintenance lock that all order/payment/consumption writers honour, or use a transaction with a write conflict on every affected reservation/item.
  - Refuse while any PAID/ARCHIVED order, CONSUMING reservation, open recovery task, or V2 hold exists.
  - Export before delete; verify restore; dual control; durable audit.
  - Never delete PAID/ARCHIVED orders, CONSUMED/CONSUMING reservations, StockMovement, or InventoryAudit.
  - Never zero `reservedStock` globally; release only reservation-derived holds conditionally.
- **Failure modes:** lock acquisition failure → abort; concurrent consumption → abort/retry; audit failure → abort; partial delete → restore/export, not in-place repair.
- **Tests:** concurrency/race on a disposable replica set; lock contention; refusal states; export/restore; audit.
- **Manual verification:** staging only; owner/DBA/verifier sign-off.
- **Rollback / forward recovery:** forward-only; restore from verified backup if a destructive operation fails.
- **Exclusions:** no production enablement; no V2 activation; no data deletion in Phase 2.5.

---

## 5. Data migration register

**No data migration or backfill is authorized by Phase 2.5.**

| Potential migration | Decision | Reason |
|---|---|---|
| Backfill legacy `PAID` orders with null/unknown `paymentMethod` | **Not approved** | The historical method cannot be proven; inventing one would corrupt financial history. Report it in WP-03 and leave it. |
| Rewrite `TELEBIRR` historical rows to `TRANSFER` | **Not approved** | Historical reads intentionally preserve the legacy brand; new writes normalize. |
| Delete/repair duplicate sale deductions | **Not approved** | Requires manual accounting review (R5). Preserve all rows; do not delete evidence. |
| Reset/repair `reservedStock` globally | **Prohibited** | R7 requires an evidence-driven conditional correction, never a global zero. |
| Create recovery tasks for existing divergence | **Not a migration** | WP-04 reports first; WP-06 creates tasks at detection time after approval. |
| Move V1 data into V2 collections | **Prohibited** | V2 remains unwired; no `orderVersion`/`inventoryMode`. |
| Change `StockMovement` documents | **Prohibited** | Index replacement is metadata-only; documents are append-only evidence. |

If any implementation step appears to require a C4 migration, it stops and returns to the owner for a separate approved plan. No migration is bundled with a code or index deployment.

---

## 6. Cross-phase consistency and traceability

| Requirement | Phase 2.5 treatment |
|---|---|
| Phase 2.3 atomic terminal guards | Preserved. WP-01 adds atomic payment-identity guards; no terminal guard is weakened. |
| Phase 2.3 four `updatePipeline: true` fixes | Preserved. WP-14 does not remove them. |
| Phase 2.3 nested error classification | Preserved. WP-01/WP-14 keep transient vs unknown-commit classification. |
| Phase 2.3 disposable replica-set evidence (16/16) | Baseline; Phase 2.5 adds tests, never replaces the existing suite. |
| Phase 2.2 Manager step-up, rate limits, redaction | Reused by WP-08/WP-10; no bypass. |
| Phase 2.2 explicit index deployment | Extended by WP-11/WP-12; `syncIndexes()` remains banned. |
| Phase 2.4 A (B + D; C strategic) | WP-04/WP-05/WP-06; no outbox, no single settlement transaction. |
| Phase 2.4 B (freeze; append-only adjustments) | WP-01/WP-02/WP-03; finance gate on accounting. |
| Phase 2.4 C (destructive controls) | WP-08/WP-09/WP-10/WP-18; production denied. |
| Phase 2.4 D (topology, concerns, indexes, restore) | WP-11…WP-16. |
| Phase 2.4 E (approver/executor/verifier) | WP-07/WP-17; audit and separation. |
| V2 remains unwired | No V2 model, route, collection, or index is created. |
| Hotel remains separate | No Hotel file, database, or payment policy changes. |
| POS UI unchanged | No UI file changes; API error contracts are additive/stricter only where approved. |

---

## 7. Approval record required before implementation

| ID | Item | Approve / Reject / Defer | Conditions | Approver | Date |
|---|---|---|---|---|---|
| P25-01 | WP-01 retry/error contract | | | | |
| P25-02 | WP-02 finance accounting boundary | | | | |
| P25-03 | WP-03/WP-04 read-only reports | | | | |
| P25-04 | WP-05 recovery schema/indexes | | | | |
| P25-05 | WP-06 worker identity/lease/retry | | | | |
| P25-06 | WP-07 audit retention/access | | | | |
| P25-07 | WP-08 production destructive gate | | | | |
| P25-08 | WP-09 script retirement | | | | |
| P25-09 | WP-10 payment-account step-up | | | | |
| P25-10 | WP-11 index coverage/window | | | | |
| P25-11 | WP-12 obsolete index replacement | | | | |
| P25-12 | WP-13 read-only production checks | | | | |
| P25-13 | WP-14 concerns/budget/pool values | | | | |
| P25-14 | WP-15 backup/RPO/RTO/restore | | | | |
| P25-15 | WP-16 staging failover/alerting | | | | |
| P25-16 | WP-17 RACI/named people | | | | |
| P25-17 | WP-18 deferral | | | | |

**No work package is approved by this document. Implementation begins only after explicit owner review and sign-off.**

