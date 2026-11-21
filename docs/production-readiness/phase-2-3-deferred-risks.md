# Phase 2.3 — Deferred Risks and Required Owner Decisions

Status: **OPEN ITEMS — NOT IMPLEMENTED / NOT PRODUCTION-READY**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`

This document records every risk Phase 2.3 deliberately did **not** resolve, the evidence level, and the decision required. Nothing below is claimed as fixed. Risks carried from Phase 2.2 keep their original IDs where applicable.

Evidence labels:

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in source, tests, or git state. |
| **REAL-TESTED** | Exercised against the disposable replica set. |
| **DEFERRED** | Understood, intentionally not changed in Phase 2.3. |
| **UNVERIFIED** | Cannot be proven without staging/production/owner input. |
| **OWNER DECISION** | Requires an explicit business, accounting, or operations decision. |

---

## 1. Summary matrix

| ID | Risk | Severity | Status | Required decision |
|---|---|---|---|---|
| D-01 | Payment (`PAID`) and inventory deduction are not atomic | High | DEFERRED / REAL-TESTED | Approve B+D recovery (or C) and its operational owner |
| D-02 | No automated recovery or reconciliation worker exists | High | DEFERRED | Approve design + schema/lease; implement before relying on eventual consistency |
| D-03 | No discrepancy alerting, runbook, or on-call owner | High | DEFERRED | Assign alert route and manual-intervention owner |
| D-04 | A PAID retry can overwrite `paymentMethod`; `updatePayment` is non-atomic | Medium-High | DEFERRED / VERIFIED | Decide whether method is immutable after first payment |
| D-05 | No monetary refund / chargeback / reversal model exists | High (production) | DEFERRED | Define refund authority and audit trail |
| D-06 | `clear-orders` is non-transactional and has a residual CONSUMING race | High (destructive admin) | DEFERRED / VERIFIED | Disable in production or define a maintenance-window procedure |
| D-07 | `scripts/clean-order-history.js` remains an unhardened destructive path | Critical if run | DEFERRED / VERIFIED | Retire or harden |
| D-08 | `clear-orders` can zero V2 holds (V2 not wired) | Critical before V2 | DEFERRED (R-03) | Keep disabled until V2 ownership guard is approved |
| D-09 | `clear-orders` lacks dual control and pre-reset export | High | DEFERRED (R-04) | Product/ops decision |
| D-10 | Legacy `executeInventoryDeduction` is dead but unsafe if wired | Medium | VERIFIED / GUARDED BY TEST | Delete in a future cleanup or document as forbidden |
| D-11 | V2 transaction helper remains unwired | Medium | OUT OF SCOPE | V2 activation plan |
| D-12 | Order creation and reservation are separate writes | Medium | DEFERRED / REAL-TESTED | Accepted because PREPARING re-attempts; recovery worker still absent |
| D-13 | PREPARING consumes stock before the order status write | Medium | DEFERRED / REAL-TESTED | Accepted direction; confirm retry/operator behavior |
| D-14 | `cancelOrderItem` uses two order writes with `updatedAt` as a token, not `orderVersion` | Medium | VERIFIED / SOURCE-ONLY | Approve `orderVersion` backfill |
| D-15 | Order mutation race (row 13 of the matrix) has no real-concurrency test | Medium | UNVERIFIED TEST GAP | Add a real test before claiming closure |
| D-16 | Real tests use a single-node replica set; failover/partitions untested | High | UNVERIFIED | Provide staging/multi-node test plan |
| D-17 | Production topology and deployment mode are unknown | High | UNVERIFIED | Confirm replica set/mongos, connection strings, and retry settings |
| D-18 | Required unique indexes may not be deployed | High | UNVERIFIED | Deploy and verify indexes before relying on idempotency |
| D-19 | Old `StockMovement` index may still reject multi-ingredient orders | High | VERIFIED (source note) | Replace the old `(refOrderId, reason)` index with `(refOrderId, reason, item)` |
| D-20 | No external payment provider; callbacks are not applicable today | Info / future High | VERIFIED | Require outbox + provider event IDs before integration |
| D-21 | Negative-stock prevention is application-level only | Medium | VERIFIED / REAL-TESTED | Accept or add defense-in-depth (no schema change made) |
| D-22 | Recovery detection queries are illustrative, not volume-tested | Medium | UNVERIFIED | Validate on staging with representative data |
| D-23 | Backup/PITR/restore has not been tested | High | UNVERIFIED (R-11) | Owner configures and runs a restore drill |
| D-24 | No manual/UI verification was performed in this phase | Medium | UNVERIFIED | Run operator acceptance before release |
| D-25 | No `orderVersion`; no `inventoryMode` | Medium / Info | DEFERRED | Approve or reject both explicitly |
| D-26 | Rate limiting remains in-memory per process (carried from 2.2) | Medium | DEFERRED (R-10) | Accept single-instance or add shared store |
| D-27 | Manager PIN step-up remains optional for ordinary PIN changes (carried) | Medium | DEFERRED (R-06) | Owner decision |
| D-28 | Default-PIN rejection can lock out seeded accounts on deploy (carried) | High | OWNER DECISION (R-07) | Rotate PINs before deployment |
| D-29 | `clean-order-history` also clears `activeWaiters`; unrelated to inventory | Medium | DEFERRED | Include in retirement decision |
| D-30 | No structured audit collection for recovery actions | Medium | DEFERRED | Approve collection/schema if B+D is accepted |

---

## 2. Detail and closure evidence

### D-01 — PAID without atomic deduction

**Evidence:** REAL-TESTED. Payment commits in one order write; consumption is a following transaction. The test “payment commits even when inventory fails” proves the order remains `PAID`, the hold is released, and no deduction is recorded.

**Impact:** A paid order can exist without a stock deduction. The direction is deliberate (never reverse a successful payment because stock is unavailable), but it is a financial/inventory divergence that must be detected and reconciled.

**Closure evidence:** An approved recovery model (see `phase-2-3-recovery-and-idempotency-design.md`), a deployed worker, an alert route, and a tested runbook showing every PAID order reaches exactly one reservation/movement terminal state.

### D-02 — No recovery worker

**Evidence:** VERIFIED. No scheduled job, queue consumer, lease, or recovery collection exists. The recovery document is a design proposal only.

**Impact:** Divergences are detectable only by ad-hoc queries. There is no owner, no retry, and no automatic escalation.

**Owner decision:** Approve B+D, B only, C, or a manual-only procedure. If B+D is approved, approve the recovery collection/lease schema.

### D-03 — No alerting or runbook

**Evidence:** VERIFIED. Structured logs exist (`logEvent`), but no alert sink, threshold, escalation policy, or on-call owner is defined in the repository.

**Impact:** A paid-without-deduction order or a stale `CONSUMING` reservation can persist indefinitely.

**Closure evidence:** A named alert destination, tested threshold, and a runbook with the exact queries from the recovery design.

### D-04 — Payment method mutability and non-atomic legacy metadata

**Evidence:** VERIFIED. On an already-`PAID` order, `payOrder` sets `paymentMethod` whenever a valid method is supplied, while preserving `paidAt` and the first account snapshot. `updatePayment` reads then writes without an atomic guard.

**Impact:** A retry with a different valid method can change the recorded method of a settled order. No second payment record is created, but the historical method label can change.

**Owner decision:** Declare `paymentMethod` immutable once `paidAt` is set, or explicitly allow correction with an audit event. This was not changed because it would alter API semantics.

### D-05 — No monetary refund/chargeback model

**Evidence:** VERIFIED. “Refund” in this phase means inventory reversal (post-preparation void → Waste). There is no monetary refund endpoint, refund ledger, provider credit, or chargeback state. `rejectPayment` only returns `PAYMENT_PENDING` → `SERVED`.

**Impact:** A cash refund or transfer reversal has no first-class record and cannot be reconciled against an order.

**Owner decision:** Define whether refunds are out of scope, manual, or require a new financial ledger. Do not infer that inventory void equals a money refund.

### D-06 — `clear-orders` residual race

**Evidence:** VERIFIED. The route checks `CONSUMING` before mutation, but a reservation can transition to `CONSUMING` after the count. It deletes orders/reservations and zeroes holds without a single transaction.

**Impact:** A live consumption could race the destructive reset. This is an operator-only path with no UI caller, but the race is real.

**Owner decision:** Disable in production, require a maintenance lock, or make the reset transactional. Until then, keep it inaccessible.

### D-07 — `clean-order-history.js`

**Evidence:** VERIFIED. `Order.deleteMany({})` plus counter reset; no PAID/CONSUMING guard and no hold cleanup. Not run in this phase.

**Impact:** Running it bypasses every Phase 2.2/2.3 safety guard and destroys financial evidence.

**Owner decision:** Delete the script or harden it to the endpoint contract. **Do not run it.**

### D-08 / D-09 — V2 holds and dual control

Carried from Phase 2.2 R-03/R-04. `clear-orders` zeroes `reservedStock` globally and is not V2-aware. V2 runtime integration remains out of scope. A V2-aware guard and a dual-control/export procedure are still required before V2 activation or production use.

### D-10 — Legacy executor

**Evidence:** VERIFIED. `executeInventoryDeduction` performs unconditional stock changes and is not idempotent by order/item. It is not called by the order service or API routes. A Phase 2.3 regression test asserts it stays unwired.

**Impact:** Re-wiring it without redesign would reintroduce negative stock and duplicate deductions.

**Closure evidence:** Delete the function or mark it explicitly `@deprecated` with a test-enforced prohibition.

### D-11 — V2 transaction helper

**Evidence:** VERIFIED. `lib/inventory-v2/server/transaction.js` is not used by V1. Real tests exercise V1 `runInTransaction` only.

**Impact:** The V2 path has no runtime transaction proof in this phase.

**Owner decision:** Keep V2 out of production until its own transaction/ownership tests run against a disposable replica set.

### D-12 — Order creation + reservation

**Evidence:** REAL-TESTED for reservation concurrency; the order `save()` and reservation transaction are separate. Reservation failure does not block intake, and PREPARING re-attempts.

**Impact:** A crash between order creation and reservation leaves an order with no hold until PREPARING. Because PREPARING gates on `assertOrderInventoryReady`, this is recoverable; it still lacks a background recovery owner.

### D-13 — Stock consumed before PREPARING status

**Evidence:** REAL-TESTED for idempotent consumption. `updateOrderStatus(PREPARING)` consumes stock, then writes the station/status. A crash after consumption but before the order write leaves `CONSUMED` stock with the order not yet PREPARING.

**Impact:** Retrying PREPARING sees `CONSUMED` and proceeds. The direction is safe (stock is never restored), but it is another eventual-consistency seam.

### D-14 / D-25 — No `orderVersion`, `updatedAt` as a token

**Evidence:** VERIFIED. `cancelOrderItem` uses `updatedAt` equality in its second write; `editOrderItems` relies on `status:"PENDING"`. No `orderVersion` field exists. `orderVersion` and `inventoryMode` were not added.

**Impact:** `updatedAt` is not a true monotonic version and can collide at millisecond resolution. Multi-write flows can still lose an update in unusual interleavings.

**Owner decision:** Approve the `orderVersion` design contract and backfill (see recovery design §12) or accept the current guards.

### D-15 — Source-only mutation race

**Evidence:** The failure matrix row 13 (edit/line cancel vs preparation/payment) is source-verified but not exercised with real concurrent writers. No integration test covers it.

**Closure evidence:** Add a real replica-set test that interleaves `editOrderItems`/`cancelOrderItem` with `updateOrderStatus(PREPARING)` and payment.

### D-16 / D-17 — Topology proof gap

**Evidence:** Real tests ran on a **single-node** replica set (`127.0.0.1:27019`). No multi-node election, failover, network partition, or production connection string was exercised. Production topology is UNVERIFIED.

**Impact:** Single-node success proves transaction semantics and write conflicts, not production availability behavior.

**Closure evidence:** A staging/multi-node test plan, plus confirmed production topology (`replicaSet`/`mongos`, retry writes, read/write concern).

### D-18 / D-19 — Index deployment

**Evidence:** VERIFIED in source. `StockMovement` requires the unique partial `(refOrderId, reason, item)` and the unique partial `idempotencyKey`. The schema comment states the old `(order, reason)` index must be replaced by deployment. No index was deployed in this phase.

**Impact:** If the old index remains, multi-ingredient orders can fail on the second movement. If the unique indexes are absent, duplicate deduction protection is weaker.

**Closure evidence:** Approved additive deploy with preflight inspection, then a verified `getIndexes()` dump on the target. No index command was run here.

### D-20 — External provider

**Evidence:** VERIFIED. No provider integration, webhook, callback, or provider transaction ID exists. Provider callback rows in the matrix are N/A.

**Impact:** The current “payment” is internal state only. Adding a provider without event IDs/outbox would create duplicate-settlement risk.

**Closure evidence:** Provider event ID unique index, signature verification, transactional inbox/outbox, and a reconciliation poll.

### D-21 — Application-level negative-stock prevention

**Evidence:** REAL-TESTED for consumption and DB-free for reservation rules. Conditional filters prevent decrements below zero; there is no database check constraint.

**Impact:** A future code path that bypasses the conditional filter could create negative stock. The dead legacy executor is exactly such a path if re-wired.

**Owner decision:** Accept application-level enforcement or add a database-level guard (schema/validation change not made).

### D-22 — Recovery query validation

**Evidence:** The recovery document’s queries are illustrative. They were not run against representative production volumes or index sets.

**Impact:** A query may be slow, miss legacy shapes, or produce false positives.

**Closure evidence:** Staging dry-run with sampled data and documented thresholds.

### D-23 — Backup/restore

**Evidence:** UNVERIFIED (carried R-11). No backup, PITR, encryption, retention, or restore drill evidence exists in the repository.

**Impact:** A restore may lose the payment/inventory boundary or restore without the unique indexes required for safe replay.

**Closure evidence:** A signed restore drill including post-restore reconciliation queries.

### D-24 — No manual/UI verification

**Evidence:** All Phase 2.3 verification is automated (DB-free + replica set). No waiter, cashier, KDS, manager, or admin UI was exercised.

**Closure evidence:** Operator acceptance test covering payment, preparation, cancellation, approval, and the destructive reset preview.

### D-26 / D-27 / D-28 — Carried Phase 2.2 operational risks

- In-memory rate limiting (R-10) remains per-process.
- Manager PIN change step-up (R-06) remains optional.
- Default-PIN rejection (R-07) can lock out seeded accounts on deploy; rotate PINs first.

These were not reworked in Phase 2.3.

### D-29 — `activeWaiters` cleanup

`clean-order-history.js` also clears `SystemAuth.activeWaiters`. Any retirement/hardening decision must include this side effect and its operational impact on live sessions.

### D-30 — Recovery audit storage

The recovery design requires durable evidence (before/after state, filters, result). No recovery audit collection exists. Approving B+D implies approving a schema/index change and a retention policy.

---

## 3. What Phase 2.3 did close

| Phase 2.2 item | Phase 2.3 result |
|---|---|
| R-01 PAID with failed consumption | Behavior remains by design; now proven with real transactions, a test, and a recovery design. Not “fixed”; accepted and documented. |
| R-02 no real MongoDB transaction proof | **Partially closed:** real disposable replica-set tests now pass (16/16). Multi-node/failover remains open (D-16). |
| R-03 clear-orders not V2-aware | Still open (D-08). |
| R-04 clear-orders dual control/export | Still open (D-09). |
| R-05 clean-order-history unhardened | Still open (D-07). |
| R-11 backup/restore/alerting | Still open (D-03, D-23). |

---

## 4. Release position

The system is **not production-ready**. The narrow Phase 2.3 corrections reduce concrete race and compatibility defects and provide real transaction evidence, but production readiness still depends on:

1. an approved recovery/reconciliation model with an owner and alerting;
2. confirmed production topology and index deployment;
3. a tested backup/restore drill;
4. an explicit refund and payment-method policy;
5. a decision on every destructive admin path;
6. operator acceptance testing.

No deployment, migration, index sync, seed, V2 activation, or Phase 2.4 work was performed.
