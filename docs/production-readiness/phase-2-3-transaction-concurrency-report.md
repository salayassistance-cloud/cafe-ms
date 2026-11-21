# Phase 2.3 — Transaction, Concurrency, and Financial-Integrity Report

Status: **IMPLEMENTATION COMPLETE — DISPOSABLE REPLICA-SET VERIFICATION ONLY**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`

> No production database was contacted. No `.env`/`.env.local` value was read. No migration, seed, index deployment, build deployment, or production command was executed. No Inventory V2 runtime integration was started. No git write command (`add`/`commit`/`push`/`reset`/`clean`/`checkout`/`stash`) was used. The application MongoDB on port `27017` was never used for testing.

---

## 1. Safety gate and baseline preservation

| Check | Result |
|---|---|
| Branch | `main` |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` |
| Baseline dirty/untracked paths | **128** |
| Final dirty/untracked paths | **130** |
| Baseline paths removed | **0** |
| Added path entries | `tests/integration/`, `tests/phase23-order-integrity.test.mjs` |
| Baseline manifest | `%TEMP%\opencode\bonov2_3-baseline-status.txt` |
| Final manifest | `%TEMP%\opencode\bonov2_3-current-status.txt` |
| Schema / migration / index deployment | None |
| Production DB / secret files | None |
| V2 runtime wiring | None |
| Deployment / Phase 2.4 work | None |

The two added path entries are exactly the new integration harness directory and the new DB-free regression suite. New documents under the already-untracked `docs/production-readiness/` directory and new files under the already-untracked `tests/helpers/` directory do not add separate `git status` entries because git collapses each untracked directory to one line. Every baseline path is still present; no user work was reset, cleaned, checked out, stashed, staged, committed, or overwritten.

---

## 2. Scope and method

### 2.1 Source audit

The audit covered, end to end:

| Area | Files |
|---|---|
| Order creation and lifecycle | `lib/orderService.js`, `lib/models/Order.js` |
| Payment create / submit / confirm / reject / retry | `lib/orderService.js`, `app/api/orders/[id]/route.js`, `app/api/orders/[id]/status/route.js` |
| Inventory reservation, consumption, release, reconciliation, void | `lib/inventoryReservationService.js`, `lib/inventoryDeductionService.js`, `lib/models/InventoryReservation.js`, `lib/models/InventoryItem.js`, `lib/models/StockMovement.js` |
| Manager approval / overrides | `app/api/orders/[id]/inventory-approval/route.js`, `app/api/manager/inventory-approvals/route.js`, `app/api/manager/settings/clear-orders/route.js` |
| Destructive history cleanup | `app/api/manager/settings/clear-orders/route.js`, `scripts/clean-order-history.js` |
| External payment boundary | repository-wide search for webhooks, callbacks, provider SDK usage |
| V2 transaction helper | `lib/inventory-v2/server/transaction.js`, `lib/inventory-v2/server/ownership.js` |

The audit explicitly traced every caller of `ensureOrderInventoryReservation`, `consumeOrderInventory`, `releaseOrderInventory`, `reconcileOrderInventory`, `recordPostPreparationVoid`, `prepareInventoryDeduction`, and `executeInventoryDeduction`.

### 2.2 Runtime verification

A disposable single-node MongoDB replica set was launched **outside the repository**:

| Property | Value |
|---|---|
| Host / port | `127.0.0.1:27019` |
| Replica set | `bonopos23rs` |
| dbPath | `%TEMP%\opencode\bono-phase23-mongo\db` |
| Credentials | None |
| Database name | `bono_pos_phase23_<unique>` only |
| Standalone negative test | `127.0.0.1:27018` / `bono_pos_phase23_standalone_<unique>` only |
| Application DB `27017` | Never used |

The integration harness refuses any URI that is not loopback, not on the isolated port, carries credentials, or does not use the phase-specific database prefix. It writes an ownership marker, re-verifies the marker and `hello` replica-set identity before every test, and drops only the verified phase database. It is **not part of the default `tests/*.test.mjs` run**.

---

## 3. Verified operation inventory and classification

Classification key:

- **TXN** — protected by a MongoDB transaction.
- **DOC** — one atomic single-document write.
- **IDEM** — a retry cannot create a second financial/stock effect.
- **RECOV** — a partial failure can be completed or reconciled from durable evidence.
- **MANUAL** — may require operator intervention.
- **N/A** — no provider boundary exists in this codebase.

| # | Operation | Durable write sequence | Classification | Notes |
|---|---|---|---|---|
| 1 | `createOrder` | `Order.save()` then reservation transaction hook | DOC + RECOV | Order intake is never blocked by inventory. A missing reservation is re-attempted by the PREPARING gate. |
| 2 | `updateOrderStatus(PREPARING)` | reservation readiness read → consumption transaction → atomic order/station pipeline | TXN (inventory) + DOC (order) + IDEM + RECOV | Inventory may commit before the order write. Retry sees `CONSUMED` and does not deduct twice. |
| 3 | `updateOrderStatus(PENDING/READY)` | one aggregation-pipeline `findOneAndUpdate` | DOC + IDEM | Filter carries the expected station state, so stale requests miss cleanly. |
| 4 | `serveOrder` | one atomic READY→SERVED pipeline | DOC | A retry returns “Only READY orders can be served”; no duplicate effect. |
| 5 | `payOrder` | one atomic payment pipeline; then best-effort consumption | DOC + IDEM + RECOV | Payment is durable before inventory. A consumption failure never rolls payment back. |
| 6 | `submitPaymentForVerification` | one atomic SERVED→PAYMENT_PENDING write | DOC + IDEM | Duplicate submit is rejected; no duplicate financial row exists. |
| 7 | `confirmPayment` | one atomic PAYMENT_PENDING→PAID pipeline; then consumption | DOC + IDEM + RECOV | Same boundary as `payOrder`. |
| 8 | `rejectPayment` | one atomic PAYMENT_PENDING→SERVED write | DOC + IDEM | Preserves the submitted snapshot for audit. |
| 9 | `updatePayment` | read + unconditional `$set`, optional second/third write | **Not transactional** | Legacy metadata path only. Does not set PAID or touch inventory. Deferred risk. |
| 10 | `cancelOrderByWaiter` | atomic PENDING+owner→CANCELLED; release hook | DOC + IDEM + RECOV | Release is transaction-protected and idempotent. |
| 11 | `cancelOrder` | atomic terminal guard; phase-aware release or void | DOC + IDEM + RECOV | Cannot overwrite a concurrently committed PAID order (Phase 2.3 fix). |
| 12 | `cancelOrderItem` | atomic array-element cancel; guarded derived-status write; reconcile/void | DOC + DOC + TXN + IDEM + RECOV | Two order writes are not one transaction, but the second is guarded by `updatedAt` and terminal states. |
| 13 | `editOrderItems` | atomic PENDING+owner item/total write; reconcile hook | DOC + TXN + RECOV | Preparation start wins the race; the edit misses cleanly. |
| 14 | `archiveOrder` | atomic guard; release or no-op | DOC + IDEM + RECOV | Cannot overwrite PAID/CANCELLED (Phase 2.3 fix). |
| 15 | `ensureOrderInventoryReservation` | one transaction: upsert reservation + conditional hold updates | TXN + IDEM | Unique `orderId`; concurrent calls converge to one reservation and one hold. |
| 16 | `consumeOrderInventory` | one transaction: CONSUMING claim → conditional decrement → SaleDeduction insert → CONSUMED | TXN + IDEM + RECOV | Claim makes duplicates skip; conditional filter forbids negative stock. |
| 17 | `releaseOrderInventory` | one transaction: RELEASED claim → hold decrement → void append | TXN + IDEM | Never restores consumed stock. |
| 18 | `reconcileOrderInventory` | one transaction: delta holds + reservation snapshot | TXN + RECOV | Used after item edit/line cancel. |
| 19 | `recordPostPreparationVoid` | one transaction: deduplicated void + `SaleDeduction`→`Waste` | TXN + IDEM | Stock is never incremented back. |
| 20 | `clear-orders` admin reset | multi-collection deletes/updates, no transaction | **Not atomic** | Serialized destructive admin operation with PAID/CONSUMING preflight. Residual race documented. |
| 21 | `scripts/clean-order-history.js` | `Order.deleteMany({})` + counter reset | **Not atomic / unsafe** | Not run and not hardened in Phase 2.3. |
| 22 | `executeInventoryDeduction` | unconditional legacy executor | **Dead code** | Not called by the order service or any API route. Must not be wired without redesign. |
| 23 | External provider webhook / callback | none | **N/A** | No provider integration, no webhook route, no callback signature, no provider transaction ID. |

---

## 4. Findings

### F1 — Cancellation and archive could overwrite a concurrently committed payment (fixed)

`cancelOrder` and `archiveOrder` read the order, checked `PAID`, and then called an **unconditional** `updateOrderFields`. A payment committing after the read but before the write could be silently reverted from `PAID` to `CANCELLED`/`ARCHIVED`, destroying financial evidence.

**Fix:** both writes now use `findOneAndUpdate` with `status: { $nin: [...] }` in the filter. The miss path reproduces the exact previous error/idempotent messages. Real concurrency tests now run 15 payment/cancel iterations and 10 payment/archive iterations without a lost payment.

### F2 — Mongoose 9 rejected every array-pipeline stock update (fixed)

`InventoryItem.updateOne(filter, [pipeline], { session })` throws:

> `Cannot pass an array to query updates unless the 'updatePipeline' option is set.`

This affected four production paths:

1. `reconcileOrderInventory` negative delta;
2. manager-approval over-hold trim;
3. `releaseOrderInventory` hold return;
4. `consumeOrderInventory` residual hold release.

In production these failures surfaced as inventory-hook warnings, which means stock holds could leak or reconciliation could silently fail. **Fix:** `updatePipeline: true` on all four calls. The first real replica-set run reproduced the failure; the second run passes.

### F3 — Standalone topology was classified as 409 instead of 503 (fixed)

On a standalone `mongod`, the driver first reports “This MongoDB deployment does not support retryable writes…”, wrapping the real server error “Transaction numbers are only allowed on a replica set member or mongos” in `errorResponse.originalError`. The classifier only inspected the outer message, so `consumeOrderInventory` returned `409` instead of `503 / TRANSACTIONS_UNAVAILABLE`.

**Fix:** error classification now walks the `originalError` / `errorResponse.originalError` / `cause` chain for topology, transient, and unknown-commit labels. The standalone integration test now asserts `success:false`, `status:503`, `code:"TRANSACTIONS_UNAVAILABLE"`, and unchanged stock.

### F4 — Payment and inventory are deliberately not one transaction (accepted boundary)

`payOrder` and `confirmPayment` commit `PAID` in one atomic order write. Consumption is a following call with its own transaction. If consumption fails, the order stays `PAID`, the failure is logged, and an unconsumed hold is released. This preserves payment availability and avoids blocking settlement on stock, at the cost of a possible paid-order-without-deduction state. The failure matrix and recovery design treat this as a **detect-and-reconcile** condition, not as a reason to reverse a successful payment.

### F5 — `updatePayment` remains a non-atomic legacy metadata path

`updatePayment` reads, writes the method, then may perform additional timestamp writes. It cannot set `PAID` and does not touch inventory. It is not used by the canonical payment/confirm flow. No change was made because tightening it would alter API semantics without owner approval.

### F6 — Destructive `clear-orders` still has a residual CONSUMING race

The route now refuses PAID evidence, requires a manager PIN plus the literal `CLEAR-ORDERS` token, supports `dryRun`, preserves CONSUMED reservations and stock-movement evidence, and repeats the non-evidence filter at delete time. A reservation can still transition to `CONSUMING` between the preflight count and the delete/zero-hold writes. This is an operator-only destructive action and remains a documented residual risk.

### F7 — `scripts/clean-order-history.js` is unhardened and must not be run

It still performs `Order.deleteMany({})` and resets the order counter without reservation/hold cleanup or PAID-evidence protection. It was not executed and was intentionally left unchanged.

### F8 — Legacy `executeInventoryDeduction` is dead but unsafe if re-wired

The legacy executor performs unconditional stock decrements and is not idempotent by order/line. It is not imported or called by the order service or any API route. Phase 2.3 adds a regression assertion preventing accidental live wiring.

### F9 — No external payment provider exists

There are no webhooks, callbacks, provider SDK calls, or provider transaction identifiers. “Payment” is an internal cash/transfer state (`CASH`, `TRANSFER`, and legacy `TELEBIRR` reads). Matrix rows about provider callbacks are explicitly recorded as **not applicable**, not silently omitted.

### F10 — V2 transaction helper is still unwired

`lib/inventory-v2/server/transaction.js` is not used by V1. The real replica-set tests exercise the V1 `runInTransaction` in `lib/inventoryReservationService.js`. Starting V2 runtime integration was explicitly out of scope.

---

## 5. Changes implemented

| File | Change | Scope |
|---|---|---|
| `lib/orderService.js` | Atomic terminal-state guards in `archiveOrder` and `cancelOrder` | Race prevention only; prior errors and idempotent returns preserved |
| `lib/inventoryReservationService.js` | `updatePipeline: true` on four array-pipeline `InventoryItem.updateOne` calls | Mongoose 9 compatibility; no stock-policy change |
| `lib/inventoryReservationService.js` | `errorChain` / nested error classification | Failure-code accuracy only; no retry expansion for unknown commits |
| `tests/phase23-order-integrity.test.mjs` | 15 DB-free regression tests | Test-only |
| `tests/integration/phase23-replica-set.integration.mjs` | 16 real replica-set tests | Test-only, explicit opt-in |
| `tests/helpers/pos-phase23-loader.mjs` | `@/` alias + extensionless import resolver | Test-only |
| `tests/helpers/pos-phase23-register.mjs` | Registers the resolver | Test-only |

### What was deliberately not changed

- When an order becomes `PAID`.
- Payment reversal or refund semantics.
- `TRACKED` / `UNTRACKED` / `EXTERNAL` inventory policy.
- Negative-stock behavior (still forbidden).
- Stock `currentStock` / `reservedStock` accounting meaning.
- `StockMovement` schema, index definitions, or accounting rows.
- Order API contracts, response shapes, and status codes (except the corrected 409→503 topology failure).
- `orderVersion` (not added).
- `inventoryMode` (not added).
- V2 wiring.
- `updatePayment`, `clean-order-history.js`, and `clear-orders` transactionality.

---

## 6. Test evidence

### 6.1 Categories

| Category | What it proves | What it does not prove |
|---|---|---|
| DB-free unit/source | Pure reservation rules, source contracts, idempotency-key shape, atomic filters, Mongoose option presence | No real transaction, no real concurrency |
| Mock/transaction-unit | N/A — no mock transaction suite was used as proof | — |
| Real MongoDB integration | Real sessions, real commits, real write conflicts, real unique indexes, real standalone rejection | Single-node topology only; not a multi-node production replica set |
| Manual verification | None performed | No UI or production workflow was exercised |

### 6.2 Results

| Run | Command | Result |
|---|---|---|
| Baseline (before Phase 2.3 changes) | `node --test "tests/*.test.mjs"` | **1355 tests / 239 suites / 0 fail / 0 skipped** |
| New DB-free Phase 2.3 suite | `node --test tests/phase23-order-integrity.test.mjs` | **15 tests / 6 suites / 15 pass** |
| Focused affected suites | 7 files (see command below) | **100 tests / 19 suites / 100 pass** |
| Final full DB-free suite | `node --test "tests/*.test.mjs"` | **1370 tests / 245 suites / 0 fail / 0 skipped** (48.8 s) |
| Real replica-set suite | opt-in command below | **16 tests / 1 suite / 16 pass** (8.8 s) |
| Standalone topology proof | included in the 16 | **503 / TRANSACTIONS_UNAVAILABLE** |

Delta: **+15 DB-free tests / +6 suites**, exactly the new Phase 2.3 file.

Focused command:

```powershell
node --test tests/phase23-order-integrity.test.mjs `
  tests/inventory-reservation-phase1.test.mjs `
  tests/inventory-lifecycle-phase1-1.test.mjs `
  tests/inventory-hook-observability.test.mjs `
  tests/item-level-cancellation.test.mjs `
  tests/clear-orders-safety.test.mjs `
  tests/clear-orders-auth.test.mjs
```

Integration command (explicit opt-in; the unique database suffix is generated per run):

```powershell
$env:POS_PHASE23_INTEGRATION_TESTS = "1"
$env:POS_PHASE23_TEST_TARGET_ACK = "I_CONFIRM_DISPOSABLE_POS_REPLICA_SET"
$env:POS_PHASE23_TEST_MONGODB_URI = "mongodb://127.0.0.1:27019/bono_pos_phase23_it_<unique>?directConnection=true&replicaSet=bonopos23rs"
$env:POS_PHASE23_STANDALONE_URI = "mongodb://127.0.0.1:27018/bono_pos_phase23_standalone_it_<unique>?directConnection=true"
$env:POS_PHASE23_STANDALONE_ACK = "I_CONFIRM_DISPOSABLE_POS_STANDALONE_DB"
node --import ./tests/helpers/pos-phase23-register.mjs --test tests/integration/phase23-replica-set.integration.mjs
```

### 6.3 Real integration coverage

1. Target guard rejects a non-phase database name.
2. Target guard rejects credentials and the application port.
3. Concurrent reservation creation holds stock exactly once.
4. Transient commit failure is retried with bounded sessions and one hold.
5. Unknown commit result is not retried and resolves from the authoritative reservation.
6. Concurrent duplicate consumption deducts once and writes one movement.
7. Concurrent last-unit consumption never goes negative and never double-deducts.
8. A failure after the stock decrement rolls the whole consumption back.
9. Payment commits when inventory fails; the stale hold is released; no deduction is recorded.
10. An unknown commit after a successful deduction is recovered without a duplicate.
11. Concurrent duplicate payment leaves one payment and one deduction.
12. Payment and manager cancellation race never leaves CANCELLED with a committed payment.
13. Payment and archive race never leaves ARCHIVED with a committed payment.
14. Concurrent release returns the hold exactly once.
15. Post-preparation void retries are idempotent and never restore stock.
16. Unsupported standalone topology fails closed with `TRANSACTIONS_UNAVAILABLE`.

---

## 7. Accounting and policy invariants (unchanged)

- `currentStock` is physical stock. `reservedStock` is a hold. Sellable = `currentStock - reservedStock`.
- A hold is never represented as negative stock.
- `SaleDeduction` is written at preparation start; payment is an idempotent fallback for legacy orders.
- Post-preparation cancellation reclassifies `SaleDeduction` to `Waste`; it never increments stock back.
- A manager-approved shortage lives on the reservation, never as negative physical stock.
- Payment success is never reversed by an inventory failure.
- `StockMovement` rows are append-only evidence; `clear-orders` never deletes them.
- `PAID` and `ARCHIVED` orders are preserved by the hardened reset.
- No item-level or order-level version field was introduced.

---

## 8. Residual work owned by the product owner

1. Approve or reject the recommended recovery model in `phase-2-3-recovery-and-idempotency-design.md`.
2. Decide whether `clear-orders` must become fully transactional or be disabled until a maintenance window procedure exists.
3. Decide whether `scripts/clean-order-history.js` is deleted or hardened before any production history cleanup.
4. Decide whether `updatePayment` may remain a legacy metadata path.
5. Approve an `orderVersion` backfill before any lost-update hardening beyond the current atomic filters.
6. Provide production replica-set topology, backup/PITR, alert routing, and an operator runbook before any deployment.
7. If an external payment provider is added, require provider event IDs and an outbox/reconciliation design before enabling it.

**This report does not declare the system production-ready.**
