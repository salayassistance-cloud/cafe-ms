# WP04-02 — Existing V1 Integration Map (Read-Only)

Status: **MAPPED — NO FLOW INVOKED, NO FILE CHANGED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`

> Purpose: describe exactly where V1 already creates, commits, releases, and consumes inventory evidence, so a future read-only reconciliation adapter can attach at the edge without redesigning payment or inventory transactions.
>
> Every reference below was read, not executed. No database connection was opened.

---

## 1. Lifecycle vocabulary

| Entity | Statuses | Source |
|---|---|---|
| Order | `PENDING`, `PREPARING`, `READY`, `SERVED`, `PAYMENT_PENDING`, `PAID`, `CANCELLED`, `ARCHIVED` | `lib/models/Order.js:12-21` |
| Reservation | `NO_INVENTORY`, `RESERVED`, `APPROVAL_REQUIRED`, `APPROVED`, `CONSUMING`, `CONSUMED`, `RELEASED` | `lib/models/InventoryReservation.js:23-31` |
| Movement reason | `Purchase`, `SaleDeduction`, `Waste`, `Correction`, `Initial` | `lib/models/StockMovement.js:20-24` |
| Movement type | `IN`, `OUT`, `ADJUSTMENT` | `lib/models/StockMovement.js:14-18` |
| Payment method | `CASH`, `TRANSFER`, `TELEBIRR` (legacy alias normalized to `TRANSFER`), `NONE` | `lib/models/Order.js:116-121`; `lib/orderService.js:995-1005, 1057-1061` |

Station progress is tracked separately on the order: `kitchenStatus`, `baristaStatus`, `hotDrinkStatus` (`lib/models/Order.js:150-152`), with per-station timestamps at `:153-157`.

---

## 2. Inventory evidence creation points

### 2.1 Order creation → reservation (non-blocking)

| Step | Reference |
|---|---|
| Order saved | `lib/orderService.js:441` |
| Reservation created through a **non-fatal** hook | `lib/orderService.js:442-446` |
| Hook swallows failures and logs a structured event | `lib/orderService.js:236-253` |
| `ensureOrderInventoryReservation` entry | `lib/inventoryReservationService.js:326` |
| Idempotent: returns existing reservation | `:331-332` |
| Re-validates availability inside a transaction | `:344-350` |
| Creates `NO_INVENTORY` reservation when nothing is required | `:338-339, 351-361` |
| Requirement fingerprint stored | `:342`, also `lib/inventoryReservationRules.js:98-110` |

**Integration consequence:** a missing reservation is a legitimate, expected state (legacy orders and swallowed hook failures). The adapter must treat "no reservation" as evidence, not as an error.

### 2.2 Shortage approval

| Step | Reference |
|---|---|
| `approveInventoryShortage` entry | `lib/inventoryReservationService.js:717-721` |
| MANAGER identity and role enforced in the service | `:723-727` |
| Reason length validated (3–500) | `:728-734` |
| Shortage fingerprint must be 64 hex characters | `:735-741` |
| Replay-safe: same fingerprint is a no-op | `:748-753` |
| Stale approval rejected | `:754-758` |
| Approval queue read | `:1379` |

**Integration consequence:** approval identity is an authenticated manager, never client text. An approval snapshot is authoritative evidence for D04/D10.

### 2.3 PREPARING → consumption

| Step | Reference |
|---|---|
| `updateOrderStatus` PREPARING branch | `lib/orderService.js:544-545` |
| Blocking readiness gate | `assertOrderInventoryReady` `lib/inventoryReservationService.js:646-700` |
| Consumption before the station flips to PREPARING | `lib/orderService.js:546-555` |
| Failure blocks preparation (unlike create/pay hooks) | `lib/orderService.js:556-562` |

**Integration consequence:** for prepared orders, stock is consumed at PREPARING, not at payment. This is why D02 must never require `PAID`.

### 2.4 Consumption transaction

| Step | Reference |
|---|---|
| `consumeOrderInventory` entry | `lib/inventoryReservationService.js:1174` |
| Legacy order with existing `SaleDeduction` is skipped, never double-deducted | `:1178-1195` |
| `ALREADY_CONSUMED` / `IN_PROGRESS` / `RELEASED` short-circuits | `:1197-1210` |
| Requirement recomputed from current order | `:1212-1216` |
| Transaction + compare-and-set claim to `CONSUMING` | `:1219-1228` |
| Concurrent claim is treated as success/skip, never failure | `:1229-1243` |
| Stock `$inc` guarded by `currentStock >= qty` and `reservedStock >= qty` | `:1267-1283` |
| Sale movement built with `idempotencyKey = sale:<orderId>:<item>` | `:1285-1297` |
| Unused hold released in the same transaction | `:1298-1320` |
| Reservation marked `CONSUMED` with `consumedAt`, `consumedBy`, `consumedTrigger` | `:1337-1350` |

**Integration consequence:** the `CONSUMING` state is a real, transient claim. A scanner that observes it without an age threshold is seeing normal work in progress. This is exactly why D06 is alert-only and its numeric threshold is deferred.

### 2.5 Release (hold only, or void consumed)

| Step | Reference |
|---|---|
| `releaseOrderInventory` entry | `lib/inventoryReservationService.js:1073-1084` |
| Transactional read | `:1090-1092` |
| `releasePlan` decides VOID_CONSUMED vs release | `:1094`; rules at `lib/inventoryReservationRules.js:70-88` |
| Consumed stock is never returned to availability; a void is appended | `:1095-1103`, `:995-1071` |
| `reservedStock` clamped at zero via update pipeline | `:1107-1131` |
| Status set to `RELEASED` with `releasedAt`/`releaseReason` | `:1134-1149` |
| Post-preparation void entry | `lib/inventoryReservationService.js:1156` |

### 2.6 Payment PAID commit and failure handling

| Step | Reference |
|---|---|
| `payOrder` entry | `lib/orderService.js:1083` |
| Frozen identity read before account lookup | `:1089-1100` |
| Account validated only for a genuinely new TRANSFER | `:1101-1128` |
| Atomic first-payment identity guarded by `paidAt` being null | `:1132-1145` |
| Inventory applied after the PAID write | `:1235-1238` |
| `applyPaidInventory` entry | `lib/orderService.js:1007` |
| Consume with `trigger: "PAYMENT"` | `:1009` |
| On failure: check whether preparation already consumed | `:1017-1023` |
| If not consumed: release with reason `CONSUMPTION_FAILED` | `:1024-1028` |
| All failures logged, never thrown (order is already PAID) | `:1010-1016, 1036-1044` |

**Integration consequence — the key D01 shape.** A PAID order can legitimately end with:
`status = PAID` + `reservation.status = RELEASED` + `releaseReason = CONSUMPTION_FAILED` + no effective `SaleDeduction`.
D01 exists to report this state. Automated repair is prohibited because the correct fix depends on physical stock, which the system cannot know.

### 2.7 Cancellation, archive, line cancel

| Flow | Reference | Inventory behavior |
|---|---|---|
| `archiveOrder` | `lib/orderService.js:1246-1277` | Guard excludes PAID/ARCHIVED/CANCELLED (`:1254`); release with `recordVoid: false` (`:1273-1275`) |
| `cancelOrderByWaiter` | `:1285` | PENDING only, own order; release path at `:1317` |
| `cancelOrder` | `:1330` | Manager whole-ticket cancel; release at `:1363` |
| `cancelOrderItem` | `:1375` | Line-level; consumed vs unconsumed branch `:1515-1557` |
| Consumed + all lines cancelled → order-level void | `:1527-1534` |
| Consumed + partial cancel → line-level void | `:1536-1544` |
| Not consumed + all lines cancelled → release | `:1546-1553` |
| Not consumed + partial cancel → reconcile | `:1555-1557` |

**Integration consequence:** after preparation, stock is never restored. Cancellation emits a void record, and the sale deduction may be reclassified to `Waste`. D08 must accept both `ORDER` and `ARCHIVE` sources.

---

## 3. Movement and idempotency primitives

| Element | Reference |
|---|---|
| `refOrderId`, `reason`, `voidedAt`, `voidReason`, `voidedBy` fields | `lib/models/StockMovement.js:30-57` |
| Unique `(refOrderId, reason, item)` partial index | `lib/models/StockMovement.js:74-77` |
| Unique `idempotencyKey` partial index | `lib/models/StockMovement.js:80-83` |
| Comment warning that deployment must replace the older index | `lib/models/StockMovement.js:69-73` |
| Sale movement key format | `lib/inventoryReservationService.js:1296` |
| Batch insert of movements | `:1333-1335` |

**Integration consequence:** index presence is a deployment fact that the application cannot assume. A missing or stale index changes what duplicates are possible. This is the D03 / G-IDX-1 boundary. The reconciliation layer must report `INDEX_ABSENT_SUSPECTED`, never create or repair an index.

---

## 4. Authorization, logging, and audit

| Concern | Reference |
|---|---|
| Role constants and groups | `lib/policy.js:14-37` |
| Payment/transition permissions | `lib/policy.js:57-70` |
| API wrapper and DB requirement | `lib/withApi.js:17` |
| Request authentication | `lib/serverAuth.js:204, 223, 238` |
| Structured logging with redaction | `lib/operationalLogger.js:17-45, 59-87` |
| `logEvent` emission point | `lib/operationalLogger.js:93` |
| Inventory audit validation/write | `lib/inventoryAuditService.js:21, 212` |
| Low-stock / alert reads | `lib/inventoryAlertService.js:25, 72` |

**Integration consequence:** a future recovery worker must authenticate as a service identity or operate outside HTTP with an explicit approved identity. It must reuse the same redaction discipline. No new role is invented in this package.

---

## 5. Database and index deployment boundary

| Element | Reference |
|---|---|
| Single shared connection from `MONGODB_URI` | `lib/mongodb.js:5, 111-145` |
| `bufferCommands: false` fast-fail | `:32-48` |
| Explicit index lifecycle; `syncIndexes()` removed | `:50-65` |
| Production default: no automatic index work | `:66-72` |
| Non-production: additive `createIndexes()` only | `:74-108` |
| Background provisioning never blocks the request | `:180-184` |
| Guarded deployment script | `scripts/sync-indexes.js`; `scripts/hotel-deploy-indexes.mjs` |

**Integration consequence:** the adapter must not call `syncIndexes`, create collections, or provision indexes. Reads must tolerate both index-present and index-absent deployments.

---

## 6. Route touchpoints (read-only observation)

| Route | Role |
|---|---|
| `app/api/orders/[id]/route.js:285-317` | Payment confirm / PAID retry / status transitions |
| `app/api/orders/[id]/status/route.js:95-132` | Status transitions including payment |
| `app/api/orders/[id]/inventory-approval/route.js` | Manager shortage approval |
| `app/api/manager/inventory-approvals/route.js` | Approval queue |

**No route, handler, or component was modified, imported, or executed.** A future reconciliation adapter must not live inside these routes.

---

## 7. Evidence availability per rule

All authoritative fields named by `wp-04-detection-rule-matrix.md` exist in V1 models, except where the projection intentionally withholds free text.

| Rule | V1 evidence present? | Notes |
|---|---|---|
| D01 | **Yes** | Order status/paidAt; reservation status/consumedAt/releasedAt/releaseReason; sale movements |
| D02 | **Yes** | Movement lifecycle fields; order status/prep markers; reservation status/voids |
| D03 | **Yes** | Movement item/refOrderId/reason/quantity/idempotencyKey/createdAt/voidedAt |
| D04 | **Yes** | Reservation orderId/status/items/approval/fingerprints/voids |
| D05 | **Yes** | Reservation status/items/updatedAt/decisionAt; order status; `reservedStock` |
| D06 | **Yes** | Reservation `CONSUMING`/updatedAt/items; movements; stock counters |
| D07 | **Yes** | Order items/stations/components; reservation items; movements |
| D08 | **Yes** | Order cancelled lines; reservation voids; movement reason/void fields |
| D09 | **Yes, with F-05** | All payment timestamps/actors present; `paymentRejectionReason` intentionally not projected |
| D10 | **Yes** | Schema enums, types, and all of the above |

Deliberately **not** projected: account numbers, holder names, free-text notes/reasons, item names/units, whole documents, Mongoose internals. See `wp-04-02-integration-readiness-review.md` §3.2.

---

## 8. Safe attachment points for a future adapter

| Boundary | Safe attachment | Prohibited |
|---|---|---|
| Evidence read | Separate read-only module that receives an existing `conn` | Importing write services to "reuse logic" |
| Query scope | Per-order bounded reads using `orderId` and indexes | Full-collection scans without bounds |
| Consistency | One logical per-order read; note snapshot limitations | Mixing a stale order with fresh movements |
| Classification | Pure function over the projected bundle | Mutating the projection or registry |
| Output | Frozen finding objects + fingerprint | Writing findings to a collection in this phase |
| Failure | Typed, redacted errors | Throwing raw documents into logs |
| Scheduling | Disabled by default; manual invocation only | Cron/queue/worker activation |
| Repair | None | Any stock/payment/reservation mutation |

---

## 9. Boundary risks visible in V1

| # | Risk | Source of risk |
|---|---|---|
| B-01 | Non-fatal inventory hooks can leave `PAID` + `RELEASED(CONSUMPTION_FAILED)` | `lib/orderService.js:236-253, 1007-1045` |
| B-02 | Fire-and-forget reservation creation can be absent for legacy orders | `lib/orderService.js:442-446`; `lib/inventoryReservationService.js:1178-1195` |
| B-03 | `CONSUMING` is a normal transient state | `lib/inventoryReservationService.js:1219-1243` |
| B-04 | Deployed unique index may not match schema | `lib/models/StockMovement.js:69-77` |
| B-05 | Consumed stock is never restored; cancellations create voids | `lib/orderService.js:1515-1557` |
| B-06 | Free-text reasons exist but are intentionally not projected | `wp-04-02-integration-readiness-review.md` F-05 |
| B-07 | V2 exact quantities are incompatible with the v1 evidence schema | `lib/inventory-v2/domain/quantity.js:147-156` |
| B-08 | Multi-collection reads are not one transaction at scan time | V1 service transactions only cover writes |

These are documented, not changed. Any mitigation belongs to a later authorized package.

---

## 10. Statement

No V1 payment, reservation, inventory, order, route, or configuration code was changed or invoked. This map is documentation derived from reading source only.
