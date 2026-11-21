# Phase 2.4 — Owner Decision Closure

Status: **READ-ONLY DECISION RECORD — NOT IMPLEMENTED, NOT APPROVED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Mode: read-only architecture review and decision preparation
Implementation: **NOT AUTHORIZED**
Database access / deployment / migration / index deployment / V2 integration: **PROHIBITED**

> This document records decisions for the owner. It does not add code, schema, collections, indexes, workers, routes, environment variables, migrations, or production operations. No database was contacted. No `.env`/`.env.local` value was read. No destructive script was executed. No Inventory V2 runtime was activated. No existing financial, inventory, payment, station, or Hotel behaviour was changed.

Companion documents:

- `phase-2-4-recovery-readiness.md` — Decision A detail (durable recovery architecture).
- `phase-2-4-destructive-operations-policy.md` — Decision C detail (destructive administration).
- `phase-2-4-production-database-checklist.md` — Decision D detail (MongoDB production readiness).

Evidence labels used throughout:

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in current source, tests, or git state. |
| **REAL-TESTED** | Exercised against the disposable replica set in Phase 2.3. |
| **INFERRED** | A logical consequence of verified code, not separately exercised. |
| **UNVERIFIED** | Cannot be proven without staging/production/owner input. |
| **OWNER DECISION** | Requires an explicit business, accounting, security, or operations decision. |

---

## 1. Safety gate

| Check | Observed | Expected | Result |
|---|---|---|---|
| Branch | `main` | `main` | PASS |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` | same | PASS |
| Status entries | **130** | 130 | PASS |
| Phase 2.3 reports readable | 4 of 4 | 4 | PASS |
| Source inspection | completed | required | PASS |
| Code/schema/DB/index changes | none | none | PASS |

The four Phase 2.4 documents live under the already-untracked `docs/production-readiness/` directory, so they do not add a separate `git status` entry. No pre-existing dirty or untracked path was reset, cleaned, checked out, stashed, staged, committed, pushed, or overwritten.

---

## 2. Decision register

| ID | Decision | Recommendation | Owner approval | Blocks production |
|---|---|---|---|---|
| **A** | Durable recovery architecture | Adopt **B + D** (durable recovery state + explicit reconciliation); keep **C** (outbox) as the strategic target before any external provider; reject **A** (single payment+inventory transaction) for settlement | Yes | **Yes** for automatic recovery; read-only reconciliation is an immediate prerequisite |
| **B** | Payment immutability and refunds | Freeze `paymentMethod` at first `PAID`; use append-only adjustment records for corrections/refunds/chargebacks; do not mutate the original payment | Yes (+ finance) | **Yes** if refunds/chargebacks are in scope; otherwise an explicit written out-of-scope policy is required |
| **C** | Destructive administration | Disable `clear-orders` in production by default; retire `clean-order-history.js`; require dual control, export, and a maintenance window for any reset | Yes (+ operations) | **Yes** |
| **D** | MongoDB production readiness | Require replica-set/mongos topology, explicit concerns, a transaction budget, inventoried indexes (including the missing inventory/stock indexes), and a tested restore | Yes (+ DBA/operations) | **Yes** |
| **E** | Production recovery ownership | Name approver, executor, and independent verifier for each recovery class; automated worker may execute only pre-approved, evidence-driven classes | Yes | **Yes** |

**No decision below is approved by this document.** The recommendations are proposals only.

---

## 3. Decision A — Durable recovery architecture (summary)

Full analysis, state machine, lease contract, queries, and manual workflow: `phase-2-4-recovery-readiness.md`.

### Verified source evidence

| Fact | Evidence | Label |
|---|---|---|
| No recovery collection, worker, queue, cron, lease, or outbox exists | Repository-wide search; `package.json` has no worker/queue dependency | VERIFIED |
| No `recovery` route or scheduled endpoint exists | Route inventory | VERIFIED |
| V1 inventory consumption is transactional and idempotent | `lib/inventoryReservationService.js` `runInTransaction` (3 attempts, transient-only retry, unknown commit not retried) | VERIFIED / REAL-TESTED |
| Reservation identity is unique per order | `lib/models/InventoryReservation.js` `orderId: { unique: true, index: true }` | VERIFIED |
| Stock movement identity is unique per `(order, reason, item)` and per `idempotencyKey` | `lib/models/StockMovement.js` two partial unique indexes | VERIFIED (definition); deployment UNVERIFIED |
| Payment commits before inventory and is never rolled back by inventory failure | `lib/orderService.js` `applyPaidInventory`; Phase 2.3 real test | VERIFIED / REAL-TESTED |
| V2 has a recovery state machine but is unwired | `lib/inventory-v2/domain/states.js`, `lib/inventory-v2/domain/paymentReadiness.js` | VERIFIED |
| Recovery actions must not blindly increment or decrement stock | Phase 2.3 design; current conditional stock writes | VERIFIED rule |

### Current behaviour

A paid order can exist without a deduction. The reservation remains `RESERVED`/`APPROVED`, or is released on consumption failure. There is no durable recovery task, no owner, no retry, no escalation, and no alert sink. Detection is ad hoc query work only.

### Risk

A `PAID` order without stock evidence, a stale `CONSUMING` reservation, duplicate movements, a hold leak, or negative stock can persist indefinitely. The system can neither prove nor repair these conditions safely at scale. This is a financial and inventory-integrity risk, not only an operational inconvenience.

### Options

| Option | Shape | Verdict |
|---|---|---|
| **A — One transaction spanning payment + inventory** | Payment commit, consumption, and movement in one transaction | Reject for settlement: a stock/recipe failure would block or reverse a successful customer payment, conflicting with current policy |
| **B — Durable recovery state** | Use the reservation state machine plus a small recovery-task collection; one idempotent conditional step per run | **Recommended near-term** |
| **C — Transactional outbox** | Payment writes an outbox event in one transaction; a consumer performs inventory work | Strategic target before an external payment provider; overkill while no consumer/worker exists |
| **D — Explicit reconciliation** | Read-only scanner detects divergence; may apply the same safe steps as B | **Required regardless of A/B/C** |
| **Existing job infrastructure** | Reuse a queue/cron already in the repo | Not available (VERIFIED absence) |

### Recommendation

Adopt **B + D now**: a minimal durable recovery-task record plus a read-only reconciliation report. Keep **C** as the target once an external provider, multi-service split, or higher volume is introduced. Reject **A** for the settlement path.

The smallest reliable architecture is:

1. A read-only reconciliation report first (no schema change).
2. A single `inventory_recovery_jobs` collection with **one open task per order** (`taskId = orderId`), a small state set, a lease, an attempt counter, and an evidence snapshot.
3. Recovery actions call the existing idempotent reservation/consumption primitives; they never write stock directly.
4. A single server-side worker identity, or a named operator runbook step, owns execution.
5. Manual escalation for R1, R3 (ambiguous), R5–R8.

### Operational impact

- A scheduled process or operator-invoked command is required. No scheduler exists today.
- A single worker identity must be provisioned outside the Staff role model.
- Alerts need an external sink; structured logs alone are not an alert.
- Manual review capacity must be assigned before enabling automatic repair.

### Data migration impact

- New collection and indexes only when approved. No change to `orders`, `inventoryreservations`, `inventoryitems`, or `stockmovements`.
- Existing divergence must be detected and classified **before** any worker is enabled.
- No historical record is rewritten or deleted.

### Required tests

Unique task identity per order; concurrent lease acquisition; lease expiry and reclaim; bounded retry/backoff; unknown-commit no-retry; evidence-driven idempotency; manual escalation; audit immutability; worker authorization; proof that no recovery path performs a blind stock change.

### Owner approval requirement

Approve B + D, the recovery-task schema/index, the lease policy, the alert sink, the manual owner, and the audit retention period. Alternatively, approve a manual-only procedure and accept that detection/repair is operator-dependent.

### Production-blocking status

**Yes.** Automatic recovery cannot be claimed without an approved model and owner. A read-only reconciliation report is the minimum immediate control; its absence is a high-severity production gap.

---

## 4. Decision B — Payment immutability and refunds

### 4.1 Verified current payment state

| Fact | Evidence | Label |
|---|---|---|
| POS payment methods are `NONE`, `CASH`, `TRANSFER`, and legacy `TELEBIRR` | `lib/constants.js` `PAYMENT_METHOD`; `lib/models/Order.js` enum | VERIFIED |
| First `PAID` writes `paymentMethod`, `paidAt`, `completedAt`, `servedAt` | `lib/orderService.js` `payOrder` pipeline | VERIFIED |
| A retry of `payOrder` on an already-`PAID` order **can overwrite `paymentMethod`** when a valid method is supplied | `lib/orderService.js` `...(pm ? { paymentMethod: pm } : {})` inside the PAID-eligible filter | VERIFIED |
| `paidAt`, `completedAt`, and `servedAt` are preserved on retry | `$cond` null checks | VERIFIED |
| `paymentAccountId` and `paymentAccountSnapshot` are set only on first payment | `$cond` on null account | VERIFIED |
| `confirmPayment` preserves the submitted method/account and sets `PAID` | `lib/orderService.js` `confirmPayment` | VERIFIED |
| `submitPaymentForVerification` sets method/account on `SERVED → PAYMENT_PENDING`; it does not set `PAID` | `lib/orderService.js` | VERIFIED |
| `rejectPayment` returns `PAYMENT_PENDING → SERVED`, preserves the submitted snapshot, and records a rejection reason | `lib/orderService.js` | VERIFIED |
| `updatePayment` reads then writes without an atomic guard; it can change the method of any order, including a `PAID` order | `lib/orderService.js` `updatePayment` | VERIFIED |
| There is no monetary refund, chargeback, reversal, credit-note, provider, webhook, or provider event ID in POS | Repository-wide search | VERIFIED absence |
| “Refund” in the current codebase means inventory reversal only (post-preparation void → Waste) | `lib/inventoryReservationService.js`; Phase 2.3 matrix row 16 | VERIFIED |
| Hotel payments are record-only: methods `CASH`, `CARD`, `BANK_TRANSFER`; statuses `RECORDED`, `VOIDED`; unique `(stayId, idempotencyKey)`; no gateway, no partial refunds | `lib/hotel/models/hotelPayment.js`, `lib/hotel/services/payments.js`, `lib/hotel/validation.js` | VERIFIED |
| Hotel void is a conditional non-destructive status transition; there is no amount/method edit endpoint and no hard delete | `lib/hotel/services/payments.js` | VERIFIED |
| Hotel overpayment is rejected (`REJECT`) | `lib/hotel/constants.js` | VERIFIED |

### 4.2 Current gaps

1. **Method mutability after settlement.** A lost-response retry can change the recorded method of a settled order. No second payment row is created, but the historical label changes. This is a real metadata-idempotency gap.
2. **No monetary refund model.** Cash returned to a customer, a transfer reversal, or a provider credit has no first-class record. Inventory void is not money.
3. **No chargeback model.** A provider dispute cannot be represented.
4. **No correction record.** `updatePayment` can silently overwrite method metadata without an audit event.
5. **No independent financial reconciliation.** Nothing compares original payment, adjustments, and net settlement.
6. **Hotel and POS are separate financial sub-systems.** A single “refund policy” must not be assumed to cover both.

### 4.3 Decisions

#### B-1 — Is `paymentMethod` immutable after `PAID`?

| Option | Description | Assessment |
|---|---|---|
| A | Leave mutable (current) | Cheapest; preserves a real historical-integrity gap |
| B | **Freeze method once `paidAt` is set; corrections use a separate adjustment record** | **Recommended.** Matches the Hotel model (no edit path; void + record); preserves the original method as evidence |
| C | Allow manager-only edits with an audit event | Acceptable only if finance agrees that the original value need not survive; weaker than B |

**Recommendation:** B. `paymentMethod`, `paymentAccountId`, and `paymentAccountSnapshot` become immutable once `paidAt` is non-null. A retry must not change them. Any correction is a new adjustment record, never an in-place mutation.

**Caveat:** This changes current retry semantics. The owner must approve the API/error contract change (for example, ignore a conflicting method on retry, or return a conflict). This document does not change it.

#### B-2 — Do corrections require a separate adjustment record?

**Recommendation: YES.** Every post-settlement correction must be an append-only record with:

- server-generated `adjustmentId`;
- `orderId` / original payment reference;
- `adjustmentType` (`REFUND`, `CHARGEBACK`, `CORRECTION`);
- `amountMinor` (or an explicitly approved decimal representation);
- `currency`;
- `method` and, for transfer, the account snapshot;
- `reason` (bounded, sanitized);
- `actorId` / role;
- `approvedBy` / role (where required);
- `idempotencyKey` (unique per order);
- provider references (`provider`, `providerEventId`, `providerRefundId`) when applicable;
- status (`RECORDED`, `CONFIRMED`, `FAILED`, `VOIDED`);
- timestamps and evidence reference.

The original payment/order row is never edited to represent a refund.

**Accounting boundary:** This document does **not** define revenue recognition, tax treatment, ledger accounts, or journal entries. Those are finance-owner decisions. It defines only identity, evidence, controls, and audit.

#### B-3 — Refund identity and idempotency

**Recommendation:**

- One server-generated `refundId` per refund intent.
- Unique `(orderId, idempotencyKey)` on the refund record.
- A duplicate request with the same key and identical details replays the stored result.
- The same key with different amount/method/reason returns `409` and creates nothing.
- A refund must reference the original payment/order and must never exceed the unrefunded balance.
- A provider refund must also store the provider event/refund ID under a unique index.
- A retry after a lost response must read the refund record and return it; it must not create a second refund.

#### B-4 — Partial versus full refunds

**Recommendation:**

- Each partial refund is its own record.
- Cumulative refunded amount must never exceed the original paid amount.
- A “full refund” is either one record for the full unrefunded balance or the set of records summing to it; the original payment is not mutated.
- The original method is preserved; the refund method is recorded separately (it may differ, for example cash refund of a transfer payment, if the owner permits it).
- Inventory reversal and money refund are independent: a stock void does not imply a cash refund, and a cash refund does not automatically restore stock.

#### B-5 — Chargeback representation

**Recommendation:** Represent a chargeback as its own adjustment type with:

- provider case/dispute ID (unique);
- amount and currency;
- status (`OPEN`, `WON`, `LOST`, `REVERSED`, `CLOSED`);
- evidence references (provider event IDs, timestamps, hashes);
- actor/approver;
- linkage to the original payment.

A chargeback must never overwrite the original payment or be recorded as a negative `paymentMethod`. Whether a chargeback blocks reporting, requires a reserve, or triggers a manual review is a finance decision.

#### B-6 — Cash refund evidence

**Recommendation (control only, not accounting):**

- refund record with amount, currency, reason, timestamp;
- executing cashier identity and role;
- approver identity and role (Manager);
- optional witness/independent verifier identity;
- receipt/document reference or a documented reason why none exists;
- no negative cash “payment” row;
- no silent edit of the original order total.

#### B-7 — Provider refund evidence (future)

No provider exists today (**VERIFIED**). If one is added:

- provider event ID is the idempotency key and is uniquely indexed;
- signature/timestamp/replay verification occurs before any write;
- the raw event is persisted (or its hash and safe metadata);
- provider refund status is reconciled by polling, not assumed;
- the provider callback never decrements stock directly;
- the outbox/inbox design (Decision A, option C) is the target.

#### B-8 — Financial reconciliation

**Recommendation:** A daily read-only reconciliation compares, per order/payment:

`original amount − confirmed refunds − confirmed chargebacks = net settled amount`

and flags:

- refund total greater than paid amount;
- adjustment without an original payment;
- duplicate provider event/refund ID;
- failed/voided adjustment with a provider success;
- method/account mismatch;
- unapplied provider event;
- order marked paid with no payment evidence.

Unmatched items require manual review. The reconciliation does not mutate data by default.

#### B-9 — Permissions and audit

| Action | Current system permission | Recommended target |
|---|---|---|
| Record POS payment | `orders:payment` (WAITER, MANAGER); `orders:payment:confirm` (CASHIER, MANAGER) | Unchanged |
| Submit for verification | `orders:payment:submit` (WAITER, MANAGER) | Unchanged |
| Reject payment | `orders:payment:reject` (CASHIER, MANAGER) | Unchanged |
| Change payment method after `PAID` | `updatePayment` via authenticated order update | **Freeze**; correction only through an approved adjustment |
| Record refund | None | New permission; Manager approval; Cashier/Manager execution |
| Record chargeback | None | New permission; Manager + financial reviewer |
| Verify reconciliation | None | Financial reviewer / independent verifier |
| Hotel payment record/void | `BILLING_MANAGE` + CSRF + Origin (Hotel) | Unchanged; Hotel policy remains separate |

**Audit:** every adjustment must record actor, role, approver, reason, amount, method, idempotency-key hash, before/after status, and provider evidence. The POS currently has no durable financial audit collection; structured logs are not sufficient for refunds.

### 4.4 Required examples

The table distinguishes **current** behaviour (VERIFIED) from **recommended target** (design only, not implemented). No accounting rule is invented.

| # | Scenario | Current behaviour (VERIFIED) | Recommended target (design only) | Invariant |
|---|---|---|---|---|
| 1 | **Cash payment** | `payOrder`/`confirmPayment` sets `PAID`, `paymentMethod=CASH`, `paidAt`; no account; inventory hook follows | Keep method immutable; cash refund is a separate adjustment with actor + manager approval + evidence | One original payment; no negative payment row |
| 2 | **Bank transfer** | `paymentAccountId` validated active; snapshot persisted on first payment; method `TRANSFER` (legacy `TELEBIRR` normalized) | Keep snapshot immutable; transfer refund is a separate adjustment referencing the original account snapshot; record refund destination/evidence | Original account snapshot survives every retry/refund |
| 3 | **External payment provider** | Does not exist | Provider event ID unique; signature verified; raw event persisted; refund/chargeback records reference provider IDs; outbox/inbox before enabling | No provider callback may write stock directly |
| 4 | **Duplicate callback** | Not applicable | Same provider event ID replays the stored result; different payload with same event ID is a conflict and creates nothing | Exactly one financial effect per provider event |
| 5 | **Full refund** | No monetary refund path; inventory void is not money | One adjustment (or a set summing to the full amount) with amount = unrefunded balance; original payment unchanged; manager approval; reconciliation entry | Refunded total ≤ paid total |
| 6 | **Partial refund** | No monetary refund path | Separate adjustment per partial; cumulative cap enforced; each has its own idempotency key; refund method recorded separately | Cumulative refunds ≤ paid amount |
| 7 | **Chargeback** | No chargeback path | Separate `CHARGEBACK` record with provider case ID, status, amount, evidence, approver; original payment unchanged; finance review | Chargeback never edits the original payment |

### 4.5 Operational impact

- A new adjustment collection/route/UI would be required for any in-system refund. This phase does not build it.
- If refunds remain out of scope, the owner must publish a written manual procedure and a manual register; the system will still not reconcile them.
- Payment-method immutability changes retry behaviour and may require a client/API update.
- Hotel payment policy remains separate; do not reuse POS adjustment tables for Hotel.

### 4.6 Data migration impact

- No schema change in this phase.
- If adopted: additive adjustment collection + indexes; no rewrite of existing orders/payments.
- Existing `PAID` orders keep their first account snapshot; no backfill of a “true” method is possible where a retry already overwrote it (detection only).
- Hotel `HotelPayment` already has a void model; a refund model would be additive.

### 4.7 Required tests

- Retry with the same method → one payment, method unchanged.
- Retry with a different valid method → method unchanged (or explicit conflict, per approved contract).
- `updatePayment` cannot change a `PAID` method without an adjustment.
- Duplicate refund idempotency key → one record, replayed result.
- Same key with different amount → `409`, no record.
- Partial refunds accumulate to the cap; over-refund is rejected.
- Full refund leaves the original payment intact.
- Chargeback record is separate and linked.
- Duplicate provider event → one effect.
- Permissions: waiter cannot refund; cashier cannot approve own refund; manager approval recorded.
- Audit record contains actor/approver/reason/amount/idempotency hash.
- Reconciliation detects over-refund, orphan adjustment, and duplicate provider event.

### 4.8 Owner approval requirement

Approve:

1. B-1 method immutability and the retry/error contract.
2. B-2 adjustment record and its fields/indexes.
3. B-3/B-4 refund identity, partial/full policy, and the refund-method rule.
4. B-5 chargeback representation.
5. B-6/B-7 evidence requirements.
6. B-8 reconciliation ownership and cadence.
7. B-9 permissions/audit and who approves refunds/chargebacks.

Finance must approve any accounting treatment. This document does not.

### 4.9 Production-blocking status

**Yes, if refunds or chargebacks are in scope.** If the owner declares them out of scope, a written manual procedure and register are still required, and the method-mutability gap remains a production-blocking financial-integrity defect until B-1 is approved and implemented.

---

## 5. Decision C — Destructive administration (summary)

Full inventory, per-operation policy, and retention requirements: `phase-2-4-destructive-operations-policy.md`.

### Verified source evidence

| Fact | Evidence | Label |
|---|---|---|
| `clear-orders` requires MANAGER + requesting manager's own Staff PIN + literal `CLEAR-ORDERS` (or `dryRun`) | `app/api/manager/settings/clear-orders/route.js` | VERIFIED |
| It refuses while any `PAID` order exists or any reservation is `CONSUMING` | same | VERIFIED |
| It deletes orders whose status is not `PAID`/`ARCHIVED`; deletes reservations whose status is not `CONSUMED`/`CONSUMING`; sets every positive `reservedStock` to `0`; resets the counter only if no orders remain | same | VERIFIED |
| It is not transactional and has a residual race: a reservation can enter `CONSUMING` after the preflight and before the hold reset | same; Phase 2.3 F6 | VERIFIED / INFERRED |
| It preserves `StockMovement` and `CONSUMED` reservation evidence | same | VERIFIED |
| It has no in-repo UI caller | Repository-wide search | VERIFIED |
| Its only audit trail is a structured `clear_orders_executed` log line; there is no durable POS audit collection | `lib/operationalLogger.js`; `clear-orders` route | VERIFIED |
| `scripts/clean-order-history.js` deletes **all** orders with `Order.deleteMany({})`, resets counters, and clears `SystemAuth.activeWaiters`; it has no PAID/CONSUMING guard, no reservation cleanup, no transaction, and no audit | `scripts/clean-order-history.js` | VERIFIED |
| `scripts/reset-auth.js` is production-guarded but resets default PINs and clears `activeWaiters`; it does not touch orders | `scripts/reset-auth.js` | VERIFIED |
| `DELETE /api/payment-info` archives an account if used by an order, otherwise hard-deletes it; MANAGER only, no step-up PIN, no durable audit | `app/api/payment-info/route.js` | VERIFIED |

### Current behaviour

`clear-orders` is a guarded but non-transactional multi-collection reset. `clean-order-history.js` is an unhardened destructive script that bypasses every guard. Neither is safe to run in production as-is.

### Risk

- Loss of financial evidence (`PAID` orders, reservations, movement links).
- A live consumption racing the reset and having its hold zeroed.
- Duplicate or reused order numbers if the counter is reset incorrectly.
- No durable record of who ran the reset and what was deleted.
- `clean-order-history.js` can delete paid history in one command.

### Options

| Operation | Options | Recommendation |
|---|---|---|
| `clear-orders` | A: leave as-is; B: **disable in production by default and require a maintenance window + export + dual control**; C: make it fully transactional and V2-aware | **B now**; C only in a future approved implementation |
| `clean-order-history.js` | A: leave; B: **retire/delete**; C: harden to the endpoint contract | **B**; never run it |
| `payment-info` delete | A: leave; B: archive-only + step-up + audit; C: leave with warning | **B** |
| Auth reset scripts | A: leave; B: keep production guard and add audit | **B** (already production-guarded) |

### Recommendation

1. **`clear-orders` is disabled in production by default.** No production run without a change ticket, a verified backup, a pre-reset export, a second approver, and a maintenance window.
2. **`scripts/clean-order-history.js` is retired.** It must not be run against any environment containing financial evidence.
3. **`payment-info` deletion becomes archive-only for any account referenced by history**, with a Manager step-up and an audit record.
4. **Every destructive operation produces a durable audit record** (actor, approver, target, counts, filters, before/after, backup/export reference).
5. **`clear-orders` must never run while Inventory V2 holds exist.** V2 remains unwired; the guard is a prerequisite for V2 activation.

### Operational impact

- Production history cleanup becomes a planned maintenance procedure, not an API call.
- A backup/export must be verified before deletion.
- The owner must name the approver and operator.
- Existing operator scripts that call `clear-orders` must be updated to send `dryRun` first and the confirmation token.

### Data migration impact

- None in this phase.
- A future transactional reset or archive/retention workflow is a separate approved change.
- No historical record may be modified or deleted as part of this decision.

### Required tests

- `clear-orders` dry run mutates nothing.
- PAID evidence refusal.
- CONSUMING refusal.
- Delete filter never removes PAID/ARCHIVED orders or CONSUMED/CONSUMING reservations.
- StockMovement is untouched.
- Counter reset only when the orders collection is empty.
- Concurrent CONSUMING race is either prevented (transaction/lock) or the operation is disabled in production.
- `payment-info` archive-vs-delete behaviour.
- Audit record exists for every destructive execution.

### Owner approval requirement

Approve the production policy for each operation, the disable-by-default posture, the retirement of the unhardened script, the dual-control/export procedure, and the audit retention period.

### Production-blocking status

**Yes.** An unhardened destructive path and a non-transactional reset are production-blocking.

---

## 6. Decision D — MongoDB production readiness (summary)

Full checklist, operator/staging split, and RPO/RTO decision template: `phase-2-4-production-database-checklist.md`.

### Verified source evidence

| Fact | Evidence | Label |
|---|---|---|
| POS connection: `maxPoolSize 10`, `minPoolSize 0`, `serverSelectionTimeoutMS 3000`, `socketTimeoutMS 30000`, `connectTimeoutMS 10000`, `bufferCommands false` | `lib/mongodb.js` | VERIFIED |
| Hotel connection: `maxPoolSize 10`, `serverSelectionTimeoutMS 5000`, `autoIndex false`, `autoCreate false`, `dbName bono_hotel` | `lib/hotel/db/connection.js` | VERIFIED |
| No explicit read concern, write concern, read preference, or `retryWrites` in application code | Connection options and transaction helpers | VERIFIED |
| V1 transaction helper: 3 attempts, 20 ms fixed delay, no explicit transaction options; standalone → `503 TRANSACTIONS_UNAVAILABLE`; unknown commit not retried | `lib/inventoryReservationService.js` | VERIFIED / REAL-TESTED |
| V2 transaction helper: default 5 attempts, 25–250 ms jittered backoff, unknown commit resolved by caller, standalone → 503; **unwired** | `lib/inventory-v2/server/transaction.js` | VERIFIED |
| Required stock indexes are defined in the schema: unique partial `(refOrderId, reason, item)` and unique partial `idempotencyKey`; the old `(refOrderId, reason)` index must be replaced | `lib/models/StockMovement.js` | VERIFIED (definition); production state UNVERIFIED |
| Reservation identity requires unique `orderId` | `lib/models/InventoryReservation.js` | VERIFIED (definition) |
| `scripts/sync-indexes.js` deploys only five models: orders, staffs, categories, menuitems, inventoryaudits | `scripts/sync-indexes.js` | VERIFIED |
| The background connection-path index provisioning also covers only those five models | `lib/mongodb.js`; `tests/pos-index-management.test.mjs` | VERIFIED |
| **No repository script deploys `InventoryItem`, `InventoryReservation`, `StockMovement`, or `PaymentInfo` indexes** | `scripts/` inventory; `scripts/sync-indexes.js` | VERIFIED absence |
| V2 index plan: 18 indexes across 7 `inventory_v2_*` collections, with explicit correctness/performance/cleanup classification | `lib/inventory-v2/server/indexPlan.js` | VERIFIED |
| V2/Hotel index scripts are additive, guarded, verify exact keys/options, and never drop | `scripts/inventory-v2-deploy-indexes.mjs`, `scripts/hotel-deploy-indexes.mjs` | VERIFIED |
| No backup/PITR/restore/RPO/RTO evidence exists in the repository | Repository search | VERIFIED absence |
| Real tests ran on a **single-node** replica set only; no failover/partition test | Phase 2.3 integration harness | VERIFIED |

### Current behaviour

The application assumes a transaction-capable MongoDB. It does not enforce or verify topology, concerns, timeouts, index presence, backup, or restore. Inventory uniqueness/idempotency depends on indexes that no repository deployment script creates.

### Risk

- Standalone MongoDB silently breaks inventory transactions (fails closed with 503, but the feature is unavailable).
- Missing unique indexes allow duplicate reservations/movements under concurrency.
- The old `(refOrderId, reason)` index can reject valid multi-ingredient orders.
- No explicit write/read concern may not meet the owner's durability expectation.
- No tested restore means a real incident may lose the payment/inventory boundary.
- Pool limits may exhaust the provider tier under serverless fan-out.
- Failover behaviour is unproven.

### Options

| Area | Options | Recommendation |
|---|---|---|
| Topology | Standalone / single-node replica set / multi-node replica set / mongos | **Multi-node replica set or mongos** for production; single-node only for dev/test |
| Concerns | Driver defaults / explicit majority + snapshot | **Explicit `majority` write concern** and transaction-appropriate read concern, subject to DBA approval |
| Transaction budget | Driver default (60 s server limit) / explicit shorter budget | Set a budget below the HTTP gateway deadline; do not let a transaction outlive the request |
| Index deployment | Auto-sync / additive script / additive script + inventory coverage | **Additive script plus a new approved inventory/stock index step**; never `syncIndexes()` |
| Backup | Nightly dump only / PITR | **PITR + retention**; nightly dump alone cannot reconstruct a payment/inventory boundary |
| Restore | Untested / rehearsal | **Tested restore drill before release** |

### Recommendation

1. Confirm **replica set or mongos** and record the `hello`/`replSetGetStatus` evidence.
2. Set explicit write/read concern and a transaction budget; document the rationale.
3. **Close the inventory index deployment gap** before relying on idempotency. This is the highest-priority Decision D finding.
4. Run a duplicate preflight and an approved one-time replacement of the old `StockMovement` index.
5. Configure PITR, retention, encryption, and access control; run a restore drill and record RPO/RTO.
6. Test failover and pool saturation on staging, not production.
7. Deploy V2/Hotel indexes only through their guarded scripts, and only after approval.

### Operational impact

- DBA/operator time for topology, concerns, indexes, backup, and restore.
- A staging environment with a disposable replica set is required.
- Index creation on large collections may need a maintenance window.
- A restore drill requires an isolated environment and a data-handling procedure.

### Data migration impact

- Index creation is additive except for the old `StockMovement` index replacement, which requires an approved drop.
- No document rewrite is required for index creation.
- Restore must preserve the unique indexes and the `counters` collection.
- V2 index deployment creates empty collections only; it does not wire V2.

### Required tests

Transaction commit/abort/retry/unknown commit; standalone 503; unique index enforcement; duplicate preflight; concurrent reservation/consumption; old-index replacement; failover; pool saturation; backup restore; post-restore reconciliation; index inventory dump.

### Owner approval requirement

Approve the topology, concerns, transaction budget, index deployment scope (including the missing inventory indexes), backup retention, RPO/RTO, restore drill, and the one-time old-index replacement.

### Production-blocking status

**Yes.** Missing inventory indexes, unverified topology, and an untested restore are production-blocking.

---

## 7. Decision E — Production recovery ownership

### 7.1 Verified role reality

| Fact | Evidence | Label |
|---|---|---|
| System roles are `WAITER`, `KITCHEN`, `BARISTA`, `HOT_DRINK`, `MANAGER`, `CASHIER` | `lib/policy.js` | VERIFIED |
| There is no `SYSTEM_ADMIN`, `DEVELOPER`, `OPERATOR`, `FINANCE`, or `WORKER` system role | `lib/policy.js`, `lib/models/Staff.js` | VERIFIED |
| There is no service-account model for an automated worker | Repository search | VERIFIED absence |
| Manager is the only role allowed to cancel an order, mutate inventory, approve shortages, change staff/PIN settings, or clear orders | `lib/policy.js` matrix | VERIFIED |
| Cashier or Manager may confirm/reject payment; Waiter or Manager may submit | `lib/policy.js` matrix | VERIFIED |
| Hotel billing uses `BILLING_MANAGE`/`BILLING_READ`, held by Hotel roles | `lib/hotel/auth/authorization.js`, `lib/hotel/http/paymentHandlers.js` | VERIFIED |
| There is no durable POS financial audit collection; structured logs are the only trail | `lib/operationalLogger.js` | VERIFIED |

**Important:** “System administrator”, “developer/operator”, and “financial reviewer” are **organisational responsibilities**, not current system roles. Assigning them does not create accounts or permissions. Any system-enforced separation requires an approved schema/permission change.

### 7.2 Responsibility matrix

| Activity | Approves | Executes | Independently verifies |
|---|---|---|---|
| **Read-only reconciliation** | Manager / system administrator (schedule) | Developer/operator or automated worker | Financial reviewer (sample/exception review) |
| **R2 recovery** (PAID, live reservation, no movement) | Manager (standing approval for the deterministic class) | Automated worker or developer/operator | Financial reviewer / Manager not involved in execution |
| **R4 recovery** (movement exists, reservation not `CONSUMED`) | Manager (standing approval) | Automated worker or developer/operator | Financial reviewer |
| **R1/R3 ambiguous recovery** | Manager + financial reviewer | Developer/operator | A person who did not execute |
| **R5 duplicate movements** | Financial reviewer + Manager | No automated repair; manual accounting review | Independent reviewer |
| **R6 consumed without movement** | Financial reviewer + Manager | Manual accounting/ledger reconstruction | Independent reviewer |
| **R7 hold drift** | Manager (after evidence review) | Developer/operator using a conditional, audited correction | Independent reviewer |
| **R8 negative stock** | Manager + financial reviewer | Manual correction only, as a new audited movement | Independent reviewer |
| **Monetary refund** | Manager + financial reviewer (per policy) | Cashier/Manager | Financial reviewer |
| **Chargeback** | Financial reviewer | Manager/operator records provider evidence | Independent reviewer |
| **Stock correction** | Manager | Manager/operator, with a reason and before/after snapshot | Another Manager or financial reviewer |
| **`clear-orders` / destructive reset** | Owner + operations (change ticket) | Named operator | A second approver verifies counts/export/result |
| **Index deployment** | Owner + DBA/operations | DBA/operator | Developer verifies post-deployment index dump |
| **Backup/restore drill** | Owner + operations | DBA/operator | Financial reviewer verifies reconciliation after restore |

### 7.3 Separation of duties

1. **No one approves and executes the same financial adjustment.** For refunds, chargebacks, and R5/R6 corrections, the approver and executor must be different people.
2. **No one independently verifies their own execution.** The verifier must be outside the execution path.
3. **The automated worker never approves.** It may execute only deterministic, pre-approved classes (R2, R4) using existing conditional primitives. It escalates everything else.
4. **The developer/operator never approves a financial correction.** They may execute an approved procedure and produce evidence.
5. **The financial reviewer is not the implementer.** This follows the roadmap's G3/G6/G7 separation and applies to recovery as well.
6. **Manager self-approval is not independent verification.** A second Manager or the financial reviewer must verify.

### 7.4 No blind stock or payment adjustments

Every recovery or correction must satisfy:

- **Evidence-first:** read order, payment, reservation, inventory, and movement rows before writing.
- **Identity:** use the existing server-authoritative identity (`orderId`, `sale:<orderId>:<item>`, adjustment idempotency key).
- **Conditional:** every write includes the expected prior state.
- **Single-step:** one transition per run.
- **Idempotent:** re-running produces no additional effect.
- **Auditable:** record before/after, filters, actor, approver, reason, result.
- **No restoration of consumed stock** except through a new audited correction movement.
- **No payment reversal** by inventory recovery.
- **No blind `$inc`/`$set`** on `currentStock`, `reservedStock`, or payment balances.

### 7.5 Manual intervention workflow

1. Detection creates a recovery task with class and evidence snapshot.
2. If the class is deterministic (R2/R4), the worker executes and records the result.
3. Otherwise the task becomes `MANUAL_REQUIRED` with a reason and evidence link.
4. A Manager and, where financial, the financial reviewer review the evidence.
5. An approved procedure is executed by a different person.
6. An independent verifier checks the after-state and signs the record.
7. The task is closed with the evidence package retained per the approved retention policy.

### 7.6 Operational impact

- Named people and backups must be assigned before production.
- A worker identity/credential must be provisioned outside the Staff role model.
- Manual review capacity and an escalation channel are required.
- Audit retention must be defined; no default exists.

### 7.7 Data migration impact

- If a recovery task or audit collection is approved, it is additive.
- No change to Staff roles is required unless the owner wants system-enforced separation; that would be a separate approved permission/schema change.

### 7.8 Required tests

Approver/executor/verifier separation in the audit record; worker cannot approve; worker can execute only R2/R4; manual escalation for R1/R3/R5–R8; no blind stock mutation; audit contains evidence and filters; independent verification recorded; unauthorized role cannot invoke recovery.

### 7.9 Owner approval requirement

Approve the responsibility matrix, named approvers/executors/verifiers, the worker identity model, the escalation channel, and the audit retention policy.

### 7.10 Production-blocking status

**Yes.** Without named ownership and independent verification, recovery cannot be operated safely.

---

## 8. Cross-phase consistency

| Prior phase / policy | Consistency requirement | Phase 2.4 position |
|---|---|---|
| **Inventory V2 Phase 1 / 2.0** | V2 is design-only, unwired, not deployed; no V2 route or collection may be activated | Recovery/decision work remains V1-scoped. Any recovery collection must not be named or treated as a V2 collection. V2 activation stays out of scope. |
| **TRACKED / UNTRACKED / EXTERNAL** | Recipe-linked lines reserve/deduct; recipe-less lines and `isExternal` lines do not; cancelled lines and NOTE components never deduct | Recovery must derive evidence from existing reservation/order snapshots. It must not invent a hold, recipe, or deduction for an untracked/external line. |
| **POS V1 behaviour** | Payment, station, and status semantics unchanged | No Phase 2.4 recommendation changes current behaviour. Recommendations are proposals only. |
| **Waiter / Kitchen / Barista / Jebena Buna** | Station state machines and role permissions unchanged | Recovery does not change KDS/station state or role permissions. |
| **Hotel / room-service** | Separate database, models, auth, and `HotelPayment` void model; no cross-database transaction | POS refund/recovery policy must not be reused for Hotel. Hotel keeps `RECORDED`/`VOIDED`; no gateway or partial refund exists. |
| **Phase 2.2 security** | Manager step-up, rate limits, redacted logs, explicit index deployment, production guards | New recovery/refund/destructive endpoints must use `requireAuth`/policy, redaction, rate limits, and step-up where applicable. No bypass. |
| **Phase 2.3 transaction corrections** | Atomic terminal guards, `updatePipeline: true`, nested error classification, bounded retry, unknown-commit no-retry | Recovery uses the same conditional primitives and error contract; it must not reintroduce blind retries or unconditional stock writes. |
| **Roadmap gates** | No gate may be self-approved; financial gates require finance; V2 cutover requires an independent auditor | Decision E mirrors these gates for recovery/refunds. |

**No V2 activation, no V1 behaviour change, and no Hotel change is proposed.**

---

## 9. Approval record (to be completed by the owner)

| Decision | Approve / Reject / Defer | Conditions | Approver | Date | Notes |
|---|---|---|---|---|---|
| A-1 Adopt B + D | | | | | |
| A-2 Recovery task schema/index | | | | | |
| A-3 Lease/worker policy | | | | | |
| A-4 Manual escalation owner | | | | | |
| A-5 Alert sink | | | | | |
| A-6 Audit retention | | | | | |
| B-1 Freeze method after `PAID` | | | | | |
| B-2 Adjustment record | | | | | |
| B-3/B-4 Refund identity/partial-full | | | | | |
| B-5 Chargeback | | | | | |
| B-6/B-7 Cash/provider evidence | | | | | |
| B-8 Reconciliation | | | | | |
| B-9 Permissions/audit | | | | | |
| C-1 `clear-orders` production policy | | | | | |
| C-2 `clean-order-history.js` retirement | | | | | |
| C-3 `payment-info` delete policy | | | | | |
| C-4 Destructive audit/retention | | | | | |
| D-1 Topology | | | | | |
| D-2 Concerns/transaction budget | | | | | |
| D-3 Pool/timeout | | | | | |
| D-4 Index inventory + missing inventory indexes | | | | | |
| D-5 Backup/restore/RPO/RTO | | | | | |
| D-6 Failover/alerting | | | | | |
| E-1 Responsibility matrix | | | | | |
| E-2 Separation of duties | | | | | |
| E-3 No blind adjustments | | | | | |
| E-4 Named people/backups | | | | | |

---

## 10. What this phase did not do

- No code change.
- No schema or model change.
- No collection, index, or migration.
- No database connection.
- No index deployment.
- No worker, queue, cron, route, or environment variable.
- No production operation.
- No Inventory V2 integration.
- No change to POS, Hotel, station, payment, or inventory behaviour.
- No destructive script executed.
- No git write command.

**The system is not declared production-ready. The next action is explicit owner approval of the decisions above before Phase 2.5.**
