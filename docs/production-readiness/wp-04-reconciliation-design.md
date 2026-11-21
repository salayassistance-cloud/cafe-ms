# WP-04 — Read-Only Inventory Reconciliation: Architecture and Detection Design

Status: **DESIGN ONLY — NOT IMPLEMENTED, NOT AUTHORIZED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Mode: strictly read-only source, documentation, and design review
Authority: Phase 2.4 owner decisions A–E; Phase 2.5 blueprint WP-04
Companions: `wp-04-detection-rule-matrix.md`, `wp-04-recovery-state-machine.md`, `wp-04-test-and-acceptance-plan.md`

> This document does not add application code, schema, model, collection, index, worker, queue, cron, route, environment variable, migration, seed, or runtime behaviour. No database was contacted. No `.env`, `.env.local`, secret, token, PIN, or credential was opened. No stock, payment, order, reservation, movement, recipe, station, hotel, waiter, or reporting record was read from or written to a database. Inventory V2 was not activated. G-PAY-1 remains **BLOCKED**.

> **AMENDMENT 2026-11-12 — WP04-06 DESIGN CONSOLIDATION (see `wp-04-06-design-consolidation-and-register.md` §4 RD-AM1):** in §9.3, "`leaseToken` increments on every acquisition" is **corrected**: the monotonic fencing value is **`leaseGeneration`**, incremented in the same write as every acquisition/reclamation; `leaseToken` is a per-acquisition random UUID. §9.3 additionally requires every claim filter to include the positive unresolved-operation predicate `U_claim` (`$or: [{ pendingOperation: null }, { "pendingOperation.state": { $in: ["COMMITTED", "ABANDONED"] } }]`): no claim proceeds while a prior operation is unresolved; terminal states `COMMITTED`/`ABANDONED` admit new operations. §9.4 values remain provisional test inputs (OD-09 is test-derived).

---

## 0. Evidence labels

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in the current source, model, or git state at the HEAD above. |
| **INFERRED** | A logical consequence of verified code; not separately exercised. |
| **UNVERIFIED** | Requires staging, production, DBA, finance, or owner evidence. |
| **DESIGN ASSUMPTION** | Proposed here; not approved and not present in the codebase. |
| **OWNER DECISION** | Requires an explicit signed business, accounting, security, or operational decision. |

A statement is never promoted from **INFERRED** to **VERIFIED** without source or runtime evidence. Prior Phase 2.3 disposable-database results are recorded as *reported* evidence, not re-executed in WP-04.

---

## 1. Baseline preservation

### 1.1 Git baseline

| Item | Observed | Expected | Result |
|---|---|---|---|
| Branch | `main` | `main` | PASS |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` | same | PASS |
| HEAD subject | `6965043 Complete Bono UI and reporting updates` | same | PASS |
| Working-tree status entries | **289** | 289 | PASS |
| Modified (` M`) | **61** | 61 | PASS |
| Untracked (`??`) | **228** | 228 | PASS |
| Deleted | **0** | 0 | PASS |
| Staged / index changes | **0** | 0 | PASS |

Command used (read-only):

```powershell
git branch --show-current
git rev-parse HEAD
git status --short --untracked-files=all
```

The complete 289-line status was written outside the repository to
`C:\Users\besud\AppData\Local\Temp\opencode\wp04-status-before.txt`.

### 1.2 Status fingerprint

| Item | Value |
|---|---|
| Status file | `wp04-status-before.txt` |
| Line count | `289` |
| SHA-256 | `9d47ffb8e4887e7749e97a3800d3a76f03a2baa52f5fdc045732010ff67d6739` |

The fingerprint is over the exact `git status --short --untracked-files=all` output (code + space + path), UTF-8. Recomputing the same command against the same tree must reproduce this hash. The four WP-04 documents are the only intended delta; the post-task fingerprint is recorded in the final report, not in this file (writing it here would make the file self-referential).

### 1.3 Path inventory (summary)

| Status | Area | Count |
|---|---|---|
| ` M` | `lib/` | 25 |
| ` M` | `app/` | 23 |
| ` M` | `tests/` | 5 |
| ` M` | `scripts/` | 4 |
| ` M` | root (`package.json`, `package-lock.json`, `.env.example`, `eslint.config.mjs`) | 4 |
| **Modified total** | | **61** |
| `??` | `lib/` | 80 |
| `??` | `app/` | 71 |
| `??` | `tests/` | 44 |
| `??` | `docs/` | 26 |
| `??` | `scripts/` | 7 |
| **Untracked total** | | **228** |

The `docs/production-readiness/` directory is entirely untracked at HEAD (`git ls-files docs/production-readiness` returns `0`). WP-04's four new files therefore add untracked entries but do not modify any tracked file.

### 1.4 Comparison with the prior staging-readiness report

`staging-readiness-report.md` records:

- before that task's two documents: `287` entries (`61` modified, `226` untracked);
- after its two documents: `289` entries (`61` modified, `228` untracked).

The current baseline is **identical to the post-report baseline**: `289 = 61 + 228`, same HEAD, same branch, zero deletions and zero staged changes. No user work was added, removed, or altered between that report and this task.

### 1.5 Preservation controls applied

- No Git stage, commit, push, deploy, reset, clean, checkout, stash, restore, merge, or rebase.
- No file was deleted, moved, renamed, or truncated.
- No pre-existing modified or untracked path was edited.
- The only repository writes are the four new `docs/production-readiness/wp-04-*.md` files.
- No database connection, command, or query was issued.
- No secret-bearing file was opened.

---

## 2. Objective, scope, and non-goals

### 2.1 Objective

Design a **read-only** capability that detects and classifies payment/inventory divergence in the authoritative V1 POS data, together with a **durable recovery-state architecture** that can later own a reviewed correction — without executing recovery, mutating inventory, or activating Inventory V2.

The immediate deliverable is visibility with evidence. The strategic target (transactional outbox) is explicitly not part of WP-04.

### 2.2 In scope

1. Read-only detection rules for the ten required inconsistency classes.
2. A durable recovery-record lifecycle, idempotency identity, lease, retry, escalation, evidence retention, audit event model, and observability design.
3. A failure matrix and DB-free test design.
4. Explicit separation of verified behaviour, assumptions, unresolved questions, and owner decisions.

### 2.3 Explicit non-goals

| Excluded | Reason |
|---|---|
| Automatic repair of any detected class | No approved correction semantics; stock/payment changes are accounting facts. |
| Writing `currentStock`, `reservedStock`, `paidAt`, payment identity, or movement rows | Would create unreviewed financial/inventory facts. |
| Creating a recovery collection, index, worker, queue, cron, scheduler, or public route | WP-04 is C1 read-only design; schema is WP-05, worker is WP-06. |
| Activating, shadowing, or wiring Inventory V2 | Separate owner approval; V2 remains unwired. |
| Adding `orderVersion`, `inventoryMode`, or any V2 field | Explicit Phase 2.5 exclusion. |
| A single transaction spanning payment and inventory settlement | Approved decision 3. |
| Inventing refund, chargeback, tax, revenue, cost, or valuation rules | Finance-gated; approved decision 5. |
| Changing Hotel, Room Service, Waiter, Kitchen, Barista, Jebena Buna, POS UI, or reporting | Outside WP-04 scope. |
| Index creation, index deletion, migration, backfill, seed, or `syncIndexes()` | Requires separate C3/C4 approval. |
| Production database access, even read-only | Requires a separate approved C5 evidence operation. |
| G-PAY-1 acceptance | G-PAY-1 remains blocked on staging; WP-04 does not accept payment staging. |

### 2.4 Approved architectural decisions carried into this design

| # | Decision | Consequence in this document |
|---|---|---|
| 1 | Durable recovery state plus read-only reconciliation is the immediate architecture. | §5, §9 |
| 2 | Transactional outbox remains the strategic future target. | §2.3, §9.10 |
| 3 | Payment and inventory settlement are not combined in one transaction. | §3.1, §5.4 |
| 4 | Payment method and account identity are immutable after first `PAID`. | §3.6, D09/D10 evidence assumptions |
| 5 | Refunds/chargebacks are append-only adjustments; no invented accounting rules. | §2.3, D02/D08 boundaries |
| 6 | Recovery requires supporting accounting and stock-movement evidence. | §5.3, §6.8 |
| 7 | Residual inventory holds block payment. | §3.2, D05 |
| 8 | Every recovery class requires a named approver, executor, and independent verifier. | §10 |
| 9 | Never silently repair stock or payment records. | §9.10 |

---

## 3. Verified source behaviour

All statements below are **VERIFIED** at the stated HEAD unless labelled otherwise. Line references are approximate and function names are authoritative.

### 3.1 Payment commits before inventory and is never rolled back

`payOrder` in `lib/orderService.js` performs one atomic order-document payment write. Only after that write succeeds does it call `applyPaidInventory(conn, doc, actorId)`.

`applyPaidInventory`:

1. calls `consumeOrderInventory(conn, doc, { trigger: "PAYMENT" })`;
2. on failure, logs `inventory_consumption_failed` through `lib/operationalLogger.js`;
3. re-checks whether stock was already consumed (`isOrderInventoryConsumed`);
4. if not consumed, calls `releaseOrderInventory(..., { reason: "CONSUMPTION_FAILED" })` so a failed payment-fallback consumption does not leave a permanent hold;
5. never rolls the payment back.

**Consequence:** a `PAID` order can legitimately exist with no `SaleDeduction` and a `RELEASED` reservation. This is the main source of rule **D01** and is not, by itself, evidence of fraud or corruption.

### 3.2 Primary stock consumption happens at the first `PREPARING` transition

`updateOrderStatus` in `lib/orderService.js` handles `PENDING → PREPARING → READY`. On `PREPARING` it:

1. calls `assertOrderInventoryReady(conn, pre)`;
2. calls `consumeOrderInventory(conn, pre, { trigger: "PREPARING" })`;
3. throws `INVENTORY_CHECK_UNAVAILABLE` / `MANAGER_APPROVAL_REQUIRED` / `RESERVATION_RELEASED` / `PREPARATION_CONSUMPTION_FAILED` before the status write when the gate or consumption fails;
4. only then performs the atomic station/status write.

**Verified ordering risk:** consumption is committed *before* the atomic status write. If the status write misses (concurrent writer, terminal transition, station-state mismatch), stock can be consumed while the order remains `PENDING`/`PREPARING` at the station level. This is not payment divergence, but it is an inventory-divergence window that detection must cover (D06/D07 and the failure matrix).

`assertOrderInventoryReady` returns early when stock was already consumed, so later stations of a mixed order do not reserve or consume again. The whole order is consumed at the first station start.

### 3.3 Consumption primitive is transactional and idempotent

`consumeOrderInventory` in `lib/inventoryReservationService.js`:

1. loads the reservation by `orderId`; if absent, checks for a legacy `SaleDeduction` movement and returns `skipped: true` when one exists;
2. classifies the current status (`ALREADY_CONSUMED`, `IN_PROGRESS`, `RELEASED`, otherwise consume);
3. inside `runInTransaction`, atomically claims the reservation with `status: { $in: ["RESERVED","APPROVED","APPROVAL_REQUIRED","NO_INVENTORY"] }` → `CONSUMING`;
4. for each reservation item computes `consumeQty = min(reserved, required, physical, held)` and `releaseQty = reserved - consumeQty`;
5. conditionally decrements `currentStock` and `reservedStock` with `$gte` guards;
6. inserts one `SaleDeduction` movement per consumed item with `idempotencyKey = sale:<orderId>:<inventoryItemId>`;
7. finalizes `CONSUMED` with `consumedAt`, `consumedBy`, `consumedTrigger`.

A concurrent caller that loses the claim sees `CONSUMING`/`CONSUMED` and returns `success: true, skipped: true`; it is never told to release a live consumption.

`runInTransaction` retries only transient transaction errors (3 attempts, 20 ms fixed delay), maps unsupported standalone topology to `503 TRANSACTIONS_UNAVAILABLE`, and never retries an unknown commit.

### 3.4 Reservation identity and lifecycle

`lib/models/InventoryReservation.js`:

| Property | Value |
|---|---|
| Collection | `inventoryreservations` |
| Identity | one document per order; `orderId` is `required`, `unique: true`, indexed |
| Statuses | `NO_INVENTORY`, `RESERVED`, `APPROVAL_REQUIRED`, `APPROVED`, `CONSUMING`, `CONSUMED`, `RELEASED` |
| Per-item fields | `inventoryItemId`, `unit`, `requiredQuantity`, `reservedQuantity`, `shortageQuantity`, `availableAtDecision`, `consumedQuantity` |
| Approval evidence | `managerId`, `approvedAt`, `reason`, `requirementFingerprint`, `shortageFingerprint`, `shortages[]` |
| Consumption evidence | `consumedAt`, `consumedBy`, `consumedTrigger` (`PREPARING` or `PAYMENT`) |
| Release/void evidence | `releasedAt`, `releaseReason`, `voidedAt`, `voidReason`, `voidedBy`, `voids[]` |
| Fingerprints | `requirementFingerprint`, `shortageFingerprint` |

`CONSUMING` is an **internal claim** made inside the consumption transaction. In the happy path it is never a durable state. A persisted stale `CONSUMING` therefore indicates a legacy writer, a transaction left open after a process failure, or a corrupt/manual write. It is detection class D06.

### 3.5 Stock movement identity

`lib/models/StockMovement.js`:

| Index | Definition | Purpose |
|---|---|---|
| item/time | `{ item: 1, createdAt: -1 }` | per-item history |
| reason/time | `{ reason: 1, createdAt: -1 }` | consumption/waste reporting |
| order/reason/item | `{ refOrderId: 1, reason: 1, item: 1 }`, unique, partial `refOrderId: ObjectId` | one deduction per order+item+reason |
| idempotency key | `{ idempotencyKey: 1 }`, unique, partial `idempotencyKey: string` | purchase/sale idempotency |

Movement reasons are `Purchase`, `SaleDeduction`, `Waste`, `Correction`, `Initial`. Whole-order cancellation after consumption reclassifies the order's `SaleDeduction` rows to `Waste` and stamps `voidedAt`/`voidReason`/`voidedBy`; it does **not** decrement stock again.

**Deployment caveat (VERIFIED in Phase 2.5):** the application connection path and `scripts/sync-indexes.js` do not deploy indexes for `InventoryReservation`, `StockMovement`, `InventoryItem`, or `PaymentInfo`. The unique guarantees exist in the schema but must not be assumed to exist in a deployed database. Detection must therefore treat duplicate reservations/movements as possible (D03/D04), and any index claim is **UNVERIFIED** until WP-11 evidence exists.

### 3.6 Payment verification workflow

`lib/models/Order.js` status enum: `PENDING`, `PREPARING`, `READY`, `SERVED`, `PAYMENT_PENDING`, `PAID`, `CANCELLED`, `ARCHIVED`.

Relevant fields:

- `paymentMethod` ∈ `CASH`, `TRANSFER`, `TELEBIRR`, `NONE`;
- `paymentAccountId`, `paymentAccountSnapshot { bankName, ownerName, accountNumber }`;
- `paymentSubmittedAt`, `paymentSubmittedBy`;
- `paymentVerifiedAt`, `paymentVerifiedBy`;
- `paymentRejectedAt`, `paymentRejectedBy`, `paymentRejectionReason`;
- `paidAt`, `completedAt`, `servedAt`;
- `preparingAt`, `readyAt`, per-station statuses and timestamps.

`submitPaymentForVerification` moves an eligible order to `PAYMENT_PENDING`, persists method/account, and does not set `paidAt`. `confirmPayment` moves `PAYMENT_PENDING → PAID`. `rejectPayment` moves `PAYMENT_PENDING → SERVED` and preserves the submitted snapshot for audit. `payOrder` is the manager/cashier settlement path.

**Important interaction with inventory:** an order can reach `PAYMENT_PENDING` or `SERVED` only after preparation has started in the normal flow, so its stock is usually already consumed at `PREPARING`. Payment verification/rejection therefore does not normally change stock. Detection must not flag "rejected payment with consumed stock" as an inconsistency.

### 3.7 Cancellation and void behaviour

`cancelOrderItem` in `lib/orderService.js` distinguishes:

- **not yet consumed** → `reconcileOrderInventory` after the line change, or `releaseOrderInventory` when every line is cancelled;
- **already consumed** → `recordPostPreparationVoid` for a line, or `releaseOrderInventory` for the whole order.

`releaseOrderInventory`/`appendPostPreparationVoid`:

- before consumption: returns the hold, sets `RELEASED`, zeroes `reservedQuantity`;
- after consumption: never restores stock; records a `voids[]` entry (`BEFORE_PREPARATION`/`AFTER_PREPARATION`, `source` `ORDER`/`LINE`/`ARCHIVE`), and for whole-order cancellation reclassifies all `SaleDeduction` movements to `Waste`;
- deduplicates by `voids.source` or `voids.lineId`.

### 3.8 Inventory V2 vocabulary exists but is unwired

`lib/inventory-v2/domain/states.js` defines `RECOVERY_REQUIRED`, `CONSUMING`, `PARTIALLY_CONSUMED`, `RELEASED_PARTIAL`, and canonical stations. `accounting.js`, `paymentReadiness.js`, `stateMachine.js`, `transaction.js`, and `server/orderMutationInventory.js` provide pure rules, evidence contracts, and a transaction helper.

**VERIFIED:** no V1 service imports or executes these modules; no V2 collection, route, worker, index, or runtime flag is active. V2 remains a design vocabulary, not a live system.

### 3.9 Observability baseline

- `lib/operationalLogger.js` emits one JSON line per event with key-based redaction for PIN, password, secret, token, authorization, cookie, session id, API key, connection string, and related terms. It does not ship, buffer, retry, or alert; the hosting provider is the sink.
- `lib/health.js` exposes only coarse `ready`/`not_ready`, database `up`/`down`, uptime, and timestamp. It must not expose recovery details.
- **VERIFIED:** no recovery alert route, on-call integration, metric, dashboard, queue, or scheduler exists.

### 3.10 What this review did **not** verify

- Deployed MongoDB topology, replica-set membership, write/read concern, or index presence.
- Production data volume, distribution, or whether any divergence currently exists.
- Whether any external writer or operational script mutates these collections.
- Whether historical orders predate the reservation model and how many.
- Whether the payment account snapshot is populated for every historical `TRANSFER` order.
- Whether any V2 collection exists in a deployed database.

These are **UNVERIFIED** and can only be answered by an approved staging read-only operation or owner/DBA evidence.

---

## 4. Why reconciliation is required

The verified ordering creates legitimate divergence windows. Detection must distinguish a *window* from a *defect*.

| Window | Verified mechanism | Detectable anomaly |
|---|---|---|
| W1 | Payment commits, inventory fallback fails, hold released | `PAID` + `RELEASED(CONSUMPTION_FAILED)` + no `SaleDeduction` |
| W2 | Stock consumed at `PREPARING`, station status write misses | reservation `CONSUMED` + order not `PAID`/not `PREPARING` |
| W3 | Payment succeeds while a live hold remains | `PAID` + `RESERVED`/`APPROVED` + `reservedStock > 0` |
| W4 | Duplicate reservation/movement because the unique index is undeployed | >1 reservation for one order; >1 `SaleDeduction` for one `(order,item)` |
| W5 | Process dies with an open consumption transaction | stale `CONSUMING` |
| W6 | Chatty retry or external writer | partial items consumed, quantity mismatch |
| W7 | Cancellation/void hook fails | cancelled order with a live hold, or `SaleDeduction` not reclassified |
| W8 | Hold reconciliation drift | `reservedStock` > sum of live reservation holds |
| W9 | Manual/legacy write | negative `currentStock`/`reservedStock`, malformed reservation |
| W10 | Evidence is missing or contradictory | classification cannot be proven; no safe action |

WP-04's job is to make W1–W10 **visible and auditable**, not to repair them.

---

## 5. Reconciliation architecture

### 5.1 Two planes

| Plane | Purpose | Authorization |
|---|---|---|
| **Detection plane** | Read-only scan, classify, fingerprint, report | WP-04 (this design) |
| **Recovery plane** | Durable task, lease, approval, execution, verification | WP-05/WP-06/WP-07; not authorized by WP-04 |

The planes share the classifier and the evidence fingerprint. The detection plane never writes a recovery task in WP-04; WP-06 is the only consumer that may create tasks.

### 5.2 Separation of duties

| Role | May detect | May classify | May approve | May execute | May verify |
|---|---|---|---|---|---|
| Scanner / worker process | yes | proposed class only | no | no | no |
| Inventory manager | yes | yes | yes (inventory classes) | no (must not approve and execute the same task) | no |
| Finance reviewer | yes | yes (payment-impacting classes) | yes | no | no |
| Named operator | yes | no | no | yes (approved manual step) | no |
| Independent verifier | no | no | no | no | yes |
| DBA | read-only evidence | no | no | no | may verify index/topology evidence |

The same human identity must not occupy approver and executor on one task. The verifier must be distinct from both. This is an **OWNER DECISION** to name the people; the design only enforces distinctness.

### 5.3 Evidence-first rule

A recovery action is permitted only when:

1. the order, reservation, movement, and inventory evidence all agree on the class;
2. the evidence is complete enough to prove the intended after-state;
3. the action maps to an already-approved primitive (for example the existing idempotent `consumeOrderInventory` for R2, or a status-only finalize for R4);
4. an approver, executor, and independent verifier are named;
5. an append-only audit event exists for intent and result.

If any condition fails, the task is `MANUAL_REQUIRED` and no write occurs.

### 5.4 No unified payment+inventory transaction

The design never proposes a transaction that spans the order payment document and the inventory settlement documents. The approved boundary is:

- payment is authoritative once committed;
- inventory is reconciled *after* payment, with its own transactional primitive;
- reconciliation detection reads both but writes neither in WP-04.

### 5.5 Read-only enforcement

The future scanner must be structurally incapable of writes:

- no `insert*`, `update*`, `delete*`, `findOneAndUpdate`, `bulkWrite`, `createIndex`, `dropIndex`, `syncIndexes`, `createCollection`, or `$out`/`$merge`;
- only `find`, `aggregate` with read stages, `countDocuments`, `distinct`, `exists`, and `explain`;
- a read-only connection option where the driver supports it, plus a source-contract test;
- no `--apply` flag; an unknown flag exits non-zero;
- no write path imported transitively (the test asserts the import graph).

### 5.6 Relationship to Inventory V2

WP-04 reads V1 collections only. It does not read or create `inventory_v2_*` collections, does not use V2 state transitions, and does not make V2 authoritative. If a V2 collection is ever detected, the scanner reports `V2_PRESENT_UNEXPECTED` and stops classifying; it does not interpret V2 state.

---

## 6. Authoritative evidence model

### 6.1 Order (`orders`)

| Field | Use |
|---|---|
| `_id`, `orderNumber` | correlation identity |
| `status` | lifecycle gate |
| `paidAt` | payment settled marker |
| `paymentMethod`, `paymentAccountId`, `paymentAccountSnapshot` | payment identity (account number masked in output) |
| `paymentSubmittedAt/By`, `paymentVerifiedAt/By`, `paymentRejectedAt/By/Reason` | verification-workflow consistency |
| `items[].lineId` | line-level correlation |
| `items[].type` | station scope |
| `items[].quantity` | expected requirement basis |
| `items[].cancelled`, `cancelledAt`, `cancelledBy`, `cancelledStation`, `cancelReason` | cancellation evidence |
| `items[].components[].componentId` | component identity |
| `items[].components[].kind` | `NOTE` vs `PRICED_COMPONENT` |
| `items[].components[].inventoryItemId`, `stockQuantity` | inventory link and per-unit consumption |
| `kitchenStatus`, `baristaStatus`, `hotDrinkStatus` | station progress |
| `preparingAt`, `readyAt`, `servedAt`, `createdAt`, `updatedAt` | timing and grace windows |

### 6.2 Reservation (`inventoryreservations`)

| Field | Use |
|---|---|
| `orderId` | primary correlation |
| `orderNumber` | secondary identity check |
| `status` | lifecycle gate |
| `items[].inventoryItemId` | item correlation |
| `items[].requiredQuantity`, `reservedQuantity`, `shortageQuantity`, `consumedQuantity` | quantity reconciliation |
| `approval.shortages[]`, `approval.requirementFingerprint`, `approval.shortageFingerprint` | shortage evidence |
| `requirementFingerprint` | drift detection |
| `consumedAt`, `consumedTrigger` | consumption evidence |
| `releasedAt`, `releaseReason` | release evidence |
| `voids[]` | cancellation/void evidence |

### 6.3 Stock movement (`stockmovements`)

| Field | Use |
|---|---|
| `_id` | movement identity |
| `item` | inventory item |
| `type` | `IN`/`OUT`/`ADJUSTMENT` |
| `quantity` | quantity evidence |
| `reason` | `SaleDeduction` vs `Waste` vs `Correction` |
| `refOrderId` | order correlation |
| `idempotencyKey` | `sale:<orderId>:<item>` identity |
| `voidedAt`, `voidReason`, `voidedBy` | cancellation reclassification |
| `createdAt` | ordering and grace window |

### 6.4 Inventory item (`inventoryitems`)

| Field | Use |
|---|---|
| `_id`, `name`, `unit` | identity |
| `currentStock` | physical stock |
| `reservedStock` | aggregate live hold |
| `minimumStock`, `cost`, `status` | context only; never used to infer correction quantity |

### 6.5 Payment account (`paymentinfos`)

Used only to resolve whether a `paymentAccountId` exists and is active. The account number is masked in every report. WP-04 does not modify accounts; account archival is WP-10.

### 6.6 Correlation identity

| Level | Identity |
|---|---|
| Order | `String(order._id)` |
| Reservation | `orderId` (one per order by design) |
| Movement | `_id`; business identity `(refOrderId, item, reason)`; idempotency `sale:<orderId>:<item>` |
| Item | `String(inventoryItemId)` |
| Line | `String(lineId)` |
| Task | `taskKey = RECOVERY:<orderId>`; `taskId = RECOVERY:<orderId>:<server-generated-id>` |

`orderNumber` is a readable secondary key and is never used alone as a join key.

### 6.7 Evidence fingerprint

```
evidenceFingerprint = SHA-256(canonicalJson({
  schema: "wp04-evidence-v1",
  order: { id, orderNumber, status, paidAt, paymentMethod, paymentAccountId,
           updatedAt, cancelledLineIds },
  reservation: { id, orderId, status, consumedAt, consumedTrigger, releasedAt,
                 releaseReason, items: [{ inventoryItemId, requiredQuantity,
                 reservedQuantity, shortageQuantity, consumedQuantity }],
                 voids: [{ at, source, lineId, items }] },
  movements: [{ id, item, type, quantity, reason, idempotencyKey, voidedAt }],
  inventory: [{ id, currentStock, reservedStock }]
}))
```

Rules:

- keys sorted, numbers canonicalized to a fixed decimal string;
- timestamps as ISO-8601 UTC;
- no account number, PIN, token, or free-text reason in the fingerprint input;
- deterministic across processes and languages;
- a changed fingerprint invalidates the prior snapshot and forces re-classification.

### 6.8 Evidence sufficiency levels

| Level | Meaning | Permitted outcome |
|---|---|---|
| **E0 — none** | No order or no reservation/movement evidence | `MANUAL_REQUIRED`; no action |
| **E1 — partial** | One side present, the other missing or unreadable | `MANUAL_REQUIRED`; report `EVIDENCE_INCOMPLETE` |
| **E2 — sufficient** | Order, reservation, movements, and inventory agree on the class | eligible for the approved action |
| **E3 — conclusive** | E2 plus the intended after-state is provable and idempotent | eligible for the single approved automatic class (R2) |

WP-04 reports the level; WP-06 enforces it.

---

## 7. Detection rule summary

The full field-level design is in `wp-04-detection-rule-matrix.md`. This table is the architecture-level index.

| Rule | Required class | Phase 2.5 R-map | Severity | Confidence | Auto-recovery |
|---|---|---|---|---|---|
| **D01** | `PAID` order with missing required stock deduction | R1, R6 | Critical | High | Prohibited |
| **D02** | Stock deduction without successful payment/accounting evidence | R7 extension | High | Medium–High | Prohibited |
| **D03** | Duplicate stock movements | R5 | Critical | High | Prohibited |
| **D04** | Duplicate or inconsistent reservations | R5/R7 | Critical | High | Prohibited |
| **D05** | Expired or abandoned reservations | R2/R7 | High | High (terminal) / Medium (age) | Prohibited in WP-04 |
| **D06** | Orders stuck in `CONSUMING` | R3 | Critical | High after age threshold | Prohibited |
| **D07** | Partial multi-station stock deductions | R4/R6 | High | High (quantity mismatch) | Prohibited |
| **D08** | Cancelled items with inconsistent inventory state | R5/R7 | High | High (order) / Medium (line) | Prohibited |
| **D09** | Payment verification/rejection with inconsistent stock state | R1/R7 | High | Medium | Prohibited |
| **D10** | Missing, malformed, or conflicting recovery evidence | all | High | High (schema) / Medium (semantic) | Prohibited |

**Design finding:** the approved Phase 2.5 R1–R8 vocabulary does not contain an explicit class for "movement exists but payment evidence is absent" (D02), nor a dedicated "payment workflow contradiction" class (D09). WP-04 keeps D01–D10 as the reporting vocabulary and maps them onto R1–R8 for recovery. Adding R9/R10 to the durable task schema is an **OWNER DECISION** (see §13).

---

## 8. False-positive management

A detection rule that fires on a legitimate lifecycle is worse than no rule: it trains operators to ignore alerts and can justify a harmful "repair".

| Source of false positive | Mitigation |
|---|---|
| Consumption at `PREPARING`, payment later | Never require `PAID` for a legitimate `SaleDeduction`; only flag movement without *either* payment or a valid prep/cancel lifecycle (D02). |
| `PAID` + `RELEASED(CONSUMPTION_FAILED)` | Treat as a *findable* class, not proof of corruption; require reservation and movement evidence. |
| Approved shortage | Use `approval.shortages[]` and `shortageQuantity`; never require `consumedQuantity == requiredQuantity`. |
| `NO_INVENTORY` orders | Exclude from requirement-based rules; report only as context. |
| External/retail lines and `NOTE` components | Exclude lines with no `inventoryItemId`; do not infer a requirement from price or name. |
| Legacy pre-reservation orders | Classify as `ALREADY_CORRECT_LEGACY` when a legacy `SaleDeduction` exists; never invent a reservation. |
| Whole-order cancel reclassifies to `Waste` | Compare the effective reason; a `Waste` row with `voidedAt` is expected, not a duplicate. |
| Line cancel after aggregate consumption | Reservations aggregate per item; a movement cannot be attributed to one line. Flag line-level gaps at `MEDIUM`, not `HIGH`. |
| Eventual consistency during an edit/reconcile | Apply a grace window based on `updatedAt`/`decisionAt`; re-read before reporting. Grace value is an **OWNER DECISION**. |
| In-flight transaction | `CONSUMING` is only stale after a threshold greater than the approved transaction budget. |
| Missing unique index | Duplicate detection must not assume the index exists; treat duplicates as possible and report index absence separately. |
| Clock skew | Compare server timestamps only; never compare a client time. |
| Partial read / replica lag | Read from primary for financial/inventory evidence; a secondary read is not authoritative. |

Output must include `confidence`, `evidenceLevel`, and the exact evidence used, so a reviewer can reject a finding without changing the rule.

---

## 9. Durable recovery architecture (design only)

The full state machine is in `wp-04-recovery-state-machine.md`. This section states the architectural contract.

### 9.1 Record lifecycle

Persisted statuses follow the approved Phase 2.5 WP-05 schema:

`DETECTED → LEASED → {RESOLVED | RETRY_SCHEDULED | MANUAL_REQUIRED}`
`RESOLVED → CLOSED` after independent verification.
`DETECTED | MANUAL_REQUIRED → CANCELLED` when the evidence becomes clean before an action.

No new persisted status is proposed. Execution is a derived sub-phase inside `LEASED`, not a stored enum value.

### 9.2 Idempotency identity

| Identity | Value | Purpose |
|---|---|---|
| `taskKey` | `RECOVERY:<orderId>` | stable order-level grouping |
| `taskId` | `RECOVERY:<orderId>:<ObjectId>` | unique task instance |
| open-task guard | partial unique `{ orderId: 1 }` where `isOpen: true` | one open task per order |
| `evidenceFingerprint` | §6.7 | detects evidence drift and prevents stale execution |
| movement identity | `sale:<orderId>:<item>` | reuses the existing idempotent consumption key |

A closed task is retained. A later divergence creates a **new** open task with a new `taskId`; it never reopens a closed record.

### 9.3 Lease and claim

- Lease duration: 5 minutes (**DESIGN ASSUMPTION**).
- `leaseOwner` is a server-side worker/operator identity, never a Staff cookie or POS client.
- `leaseToken` increments on every acquisition.
- Acquisition is one atomic `findOneAndUpdate` whose filter accepts `DETECTED`, due `RETRY_SCHEDULED`, or expired `LEASED`.
- Renewal requires the same owner **and** token **and** a live lease.
- Completion writes require the same owner **and** token; a stale owner cannot finalize.
- Expiry does not auto-resolve a task; the next claimant re-reads evidence.

### 9.4 Retry policy

| Parameter | Value | Status |
|---|---|---|
| `maxAttempts` | 5 | DESIGN ASSUMPTION |
| Backoff | 30 s → 60 s → 120 s → 240 s → 480 s | DESIGN ASSUMPTION |
| Cap | 15 min, jittered | DESIGN ASSUMPTION |
| Transient transaction error | bounded retry of the same idempotent step | DESIGN ASSUMPTION |
| Unknown commit | **no blind retry**; re-read evidence | Approved decision / Phase 2.3 |
| Topology unavailable | schedule later + alert; no hammering | DESIGN ASSUMPTION |
| Non-retryable conflict | immediate `MANUAL_REQUIRED` | DESIGN ASSUMPTION |
| Budget exhausted | `MANUAL_REQUIRED`; no endless loop | DESIGN ASSUMPTION |

### 9.5 Terminal states

| State | Terminal? | Meaning |
|---|---|---|
| `CLOSED` | yes | verified after-state, immutable except appended audit |
| `CANCELLED` | yes | superseded because evidence became clean; no action |
| `MANUAL_REQUIRED` | quasi-terminal | requires a named human decision; not automatic |
| `RESOLVED` | no | action applied/already correct; awaiting verifier |

### 9.6 Manual escalation

Escalation must carry: class, severity, evidence fingerprint, evidence snapshot, what was attempted, the exact unresolved question, the named approver/executor/verifier, and the deadline. The classifier must never write a "probable" correction quantity; it reports expected vs actual evidence and stops.

### 9.7 Evidence retention

- Store a bounded detection snapshot, not a full document dump.
- Mask `paymentAccountSnapshot.accountNumber`; never store PIN, token, cookie, or connection string.
- Retain task, evidence, audit, and verification records after closure; **no TTL** until owner/finance sets retention.
- Evidence snapshot is immutable; re-reads append a new audit/evidence event rather than overwriting history. The current WP-05 field list has one `evidence` object, so evidence history is an **OWNER DECISION**.

### 9.8 Audit event model

Every recovery action produces an append-only WP-07 event:

| Field | Value |
|---|---|
| `domain` | `RECOVERY` |
| `action` | `RECOVERY_DETECTED`, `RECOVERY_LEASED`, `RECOVERY_RENEWED`, `RECOVERY_EXECUTED`, `RECOVERY_RETRY_SCHEDULED`, `RECOVERY_ESCALATED`, `RECOVERY_RESOLVED`, `RECOVERY_VERIFIED`, `RECOVERY_CLOSED`, `RECOVERY_CANCELLED`, `RECOVERY_EVIDENCE_DRIFT` |
| `correlationId` | taskId |
| `orderId`, `taskId` | links |
| `actorType` | `SYSTEM`, `WORKER`, `STAFF`, `OPERATOR` |
| `actorId`, `actorRole` | identity |
| `approverId`, `verifierId` | separation of duties |
| `before`, `after` | bounded, redacted |
| `result` | `SUCCESS`, `FAILED`, `PARTIAL`, `ESCALATED`, `INFO` |
| `createdAt` | append-only |

If the audit write fails, the recovery action is not applied. No "best effort" audit.

### 9.9 Observability and alerting

Required signals (design only):

| Signal | Why |
|---|---|
| open tasks by class/severity | volume and backlog |
| oldest open task age | stuck detection |
| lease contention / expired leases | split-brain risk |
| retry exhaustion | unsafe automation |
| evidence drift | unstable rules |
| unknown-commit occurrences | financial risk |
| scanner runtime and read count | operational cost |
| index presence / duplicate preflight | correctness precondition |
| worker heartbeat and kill-switch state | liveness |

**VERIFIED:** no alert sink, on-call route, dashboard, or metric exporter exists. Thresholds, routing, and on-call ownership are **OWNER DECISIONS**. The public health endpoint must remain coarse and must not expose task counts or customer/order identifiers.

### 9.10 What must never be automated

- Any stock quantity correction (increase or decrease) outside the existing idempotent consumption primitive.
- Any payment method, account, `paidAt`, or monetary adjustment change.
- Deleting a movement, reservation, order, void record, or audit event.
- "Clamping" a negative stock to zero.
- Releasing a hold when the order may still be live.
- Reclassifying `SaleDeduction` ↔ `Waste` without a whole-order cancellation decision.
- Reconciling a class whose evidence level is E0/E1.
- Executing a manual class (R1, ambiguous R3, R5–R8) automatically.
- Combining payment and inventory writes in one transaction.
- Activating V2 or writing V2 collections.

---

## 10. Ownership and separation of duties (design)

| Duty | Accountable | Must be distinct from |
|---|---|---|
| Detection rule ownership | Technical lead | — |
| Inventory class approval | Inventory manager | Executor, verifier |
| Payment-impact approval | Finance reviewer | Executor, verifier |
| Manual execution | Named operator / worker identity | Approver, verifier |
| Independent verification | Verifier | Approver, executor |
| Index/topology evidence | DBA | — |
| Retention and alert routing | Owner / operations | — |
| RACI signature | Owner | — |

The design enforces distinctness in code (task fields and audit). It does not invent names, roles, or permissions; those are **OWNER DECISIONS**.

---

## 11. Design assumptions

| # | Assumption | Consequence if wrong |
|---|---|---|
| A1 | V1 remains authoritative for orders, payments, reservations, stock, and station state. | The scanner would read the wrong authority. |
| A2 | Payment commits atomically before inventory, and inventory never rolls payment back. | Detection ordering and D01/D02 would be invalid. |
| A3 | `CONSUMING` is never a committed happy-path state. | D06 would produce false positives after a long transaction. |
| A4 | The unique `(refOrderId, reason, item)` and `idempotencyKey` indexes may be absent in a deployed database. | Duplicate rules must not assume impossibility. |
| A5 | Historical pre-reservation orders may have legacy deductions but no reservation. | D01 must support `ALREADY_CORRECT_LEGACY`. |
| A6 | A `PAYMENT_PENDING`/`SERVED` order normally has stock already consumed at prep. | D09 must not flag that state as inconsistent. |
| A7 | Whole-order cancellation reclassifies `SaleDeduction` to `Waste` without a second decrement. | D08 must compare effective reason. |
| A8 | Recovery execution will use existing idempotent primitives, not new stock arithmetic. | Any new arithmetic is a stop condition. |
| A9 | No external payment provider, webhook, refund, or chargeback path exists in POS. | D02/D09 must not model provider events. |
| A10 | The scanner can read from primary with a bounded query window. | Secondary reads could produce false findings. |

---

## 12. Unresolved questions

1. **Volume and window.** How many orders/reservations/movements exist, and what scan window is operationally acceptable? Requires staging/production counts.
2. **Historical cutoff.** Which orders predate the reservation model, and what is the safe `createdAt` boundary for `ALREADY_CORRECT_LEGACY`?
3. **Deployed indexes.** Which of the schema-declared unique indexes actually exist? Requires WP-11/WP-13 evidence.
4. **Stale-`CONSUMING` threshold.** What is the maximum legitimate transaction lifetime on the deployed topology? Requires WP-14 evidence.
5. **Live-order staleness.** How long may a `PENDING` order legitimately hold stock? Business decision.
6. **Approved-shortage semantics.** When `shortageQuantity > 0`, is the unconsumed portion considered an accepted loss, a receivable, or neither? Finance decision; WP-04 must not assume.
7. **Line-level attribution.** Because reservation items aggregate by inventory item, a line-level movement cannot always be attributed. Is line-level reconciliation required, or is item-level sufficient?
8. **Legacy payment evidence.** Are there `PAID` orders with `paidAt: null`, `paymentMethod: NONE`, or a missing account snapshot? Requires WP-03 evidence.
9. **V2 presence.** Does any deployed database already contain `inventory_v2_*` collections? Must be read-only verified before V2 activation.
10. **External writers.** Do operational scripts or manual database edits write these collections outside the application? Must be established operationally.

---

## 13. Owner decisions required

| # | Decision | Why it blocks |
|---|---|---|
| OD-1 | Approve D01–D10 as the reporting vocabulary, and decide whether D02/D09 become durable task classes `R9`/`R10`. | The approved R1–R8 set is not exhaustive. |
| OD-2 | Name the approver, executor, and independent verifier per class. | Approved decision 8 cannot be enforced without names. |
| OD-3 | Set the stale-`CONSUMING` threshold and the live-order staleness threshold. | Age-based rules otherwise invent policy. |
| OD-4 | Set the scan window, output retention, and evidence-retention period. | No TTL is proposed; retention is a business/legal decision. |
| OD-5 | Decide whether a terminal-order hold (e.g. `CANCELLED` with `reservedStock > 0`) may ever be auto-released after approval. | Current design prohibits all automatic release. |
| OD-6 | Decide the approved-shortage accounting meaning (accepted loss vs receivable vs other). | A correction quantity must not be invented. |
| OD-7 | Approve the alert sink, thresholds, and named on-call. | No sink exists; detection without routing is not an operational control. |
| OD-8 | Decide whether evidence history is append-only (new events) or a single mutable snapshot. | WP-05 currently defines one `evidence` object. |
| OD-9 | Approve the exact backoff/lease values (or confirm the proposed defaults). | They are design assumptions, not approved policy. |
| OD-10 | Decide whether line-level reconciliation is required in addition to item-level. | Affects the D08 evidence contract and false-positive rate. |
| OD-11 | Name the approver/executor/verifier per rule and per operational shift. | The same names must not be reused in a way that defeats separation of duties. |
| OD-12 | Decide whether the future worker may run on a schedule and, if so, where. | A schedule is a C5 operation; WP-04 only designs the lifecycle. |

---

## 14. Stop conditions

Stop and return to the owner if:

1. source behaviour cannot be established for a rule;
2. required evidence is unavailable or only partially readable;
3. a proposed rule or action would change an accounting or inventory quantity;
4. production database access (even read-only) would be required;
5. a pre-existing user change would be overwritten or deleted;
6. the design would need to choose a business/accounting rule (shortage, refund, valuation, retention);
7. a broader architecture decision is required (V2 activation, unified payment+inventory transaction, outbox);
8. the approved R1–R8 vocabulary cannot represent a detected class without an owner decision;
9. the scanner cannot be proven read-only;
10. an approver, executor, or independent verifier is not named.

---

## 15. Deliverables and acceptance posture

| Deliverable | Purpose |
|---|---|
| `wp-04-reconciliation-design.md` | This architecture, verified behaviour, assumptions, questions, decisions |
| `wp-04-detection-rule-matrix.md` | Field-level detection rules D01–D10 |
| `wp-04-recovery-state-machine.md` | Durable lifecycle, lease, retry, escalation, audit, alerting |
| `wp-04-test-and-acceptance-plan.md` | Failure matrix, DB-free test design, acceptance evidence |

**Acceptance posture:** WP-04 design review is complete only when the owner has reviewed the four documents and answered OD-1…OD-10. G-REC-1 (read-only inventory reconciliation available) is **not** signed by this document. No test was run, no database was contacted, and no inventory or payment record was changed.
