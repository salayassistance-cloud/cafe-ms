# WP-04 — Detection Rule Matrix

Status: **DESIGN ONLY — NO QUERY EXECUTED — NOT IMPLEMENTED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch / HEAD: `main` / `69650435a6587d4577bc126f719fa1392bb934b3`
Parent: `wp-04-reconciliation-design.md`
Companion: `wp-04-recovery-state-machine.md`, `wp-04-test-and-acceptance-plan.md`

> Every query below is **pseudocode or a source-level plan**. None was executed. No MongoDB connection was opened. All rules are read-only and must remain structurally incapable of writes. No stock, payment, reservation, order, or movement record was read or changed.

---

## 0. How to read this matrix

| Column | Meaning |
|---|---|
| **Rule** | Stable WP-04 finding code. |
| **Required class** | The ten inconsistency classes required by the task. |
| **R-map** | Mapping to the approved Phase 2.5 R1–R8 recovery classes. |
| **Authoritative fields** | The only fields a rule may use. |
| **Correlation identity** | How records are joined. |
| **Detection algorithm** | Read-only pseudocode. |
| **False-positive risks** | Lifecycle states that must not be reported as defects. |
| **Confidence** | High / Medium / Low, with the condition that changes it. |
| **Severity** | Critical / High / Medium / Low. |
| **Required evidence** | Minimum evidence level (E0–E3 from the design document). |
| **Human review** | Who must review. |
| **Auto-recovery** | Always `PROHIBITED` in WP-04. Future classes are named only where Phase 2.5 already authorizes them. |

Allowed readers: `find`, `findOne`, `aggregate` with read stages only, `countDocuments`, `distinct`, `exists`, `explain`.
Forbidden: `insert*`, `update*`, `delete*`, `findOneAndUpdate`, `bulkWrite`, `createIndex`, `dropIndex`, `syncIndexes`, `createCollection`, `$out`, `$merge`, `$function` with side effects.

---

## 1. Common read contract

### 1.1 Read semantics

| Requirement | Rule |
|---|---|
| Read preference | Primary for every rule that can lead to a recovery decision. |
| Read concern | A consistent snapshot at one logical point per order; do not mix a stale order read with a fresh movement read. |
| Window | `--since` (default: owner-approved, not invented) and optional `--until`. |
| Bound | `--limit` on orders scanned; `--maxDocsPerOrder` on child records. |
| Projection | Only the fields in §6 of the design document. Never project full order history or free-text notes into output. |
| Redaction | Account number masked to last 4; no PIN, token, secret, cookie, or connection string. |
| Time | Server timestamps only; ISO-8601 UTC in output. |
| Determinism | Stable sort by `orderId`, then rule code. |

### 1.2 Grace windows

| Window | Purpose | Default |
|---|---|---|
| `W_ACTIVE` | Ignore records whose `updatedAt` is within an in-flight transaction/operation window. | **OWNER DECISION** (must exceed the approved transaction budget; WP-14 evidence) |
| `W_STALE` | Age after which a `CONSUMING` claim or a live hold is considered abandoned. | **OWNER DECISION** |
| `W_EDIT` | Allow order edit + reservation reconcile to settle. | **OWNER DECISION** |

A rule that depends on a grace window must report `graceMs` in its output so a reviewer can see why a record was included or excluded.

### 1.3 Shared helpers (pseudocode)

```text
function loadOrder(orderId):
    return orders.findOne({ _id: orderId },
      projection = ORDER_EVIDENCE_FIELDS)

function loadReservations(orderId):
    return inventoryreservations.find({ orderId },
      projection = RESERVATION_EVIDENCE_FIELDS).toArray()

function loadMovements(orderId):
    return stockmovements.find({ refOrderId: orderId },
      projection = MOVEMENT_EVIDENCE_FIELDS).toArray()

function loadInventory(itemIds):
    return inventoryitems.find({ _id: { $in: itemIds } },
      projection = { _id, name, unit, currentStock, reservedStock }).toArray()

function effectiveReason(m):
    // Whole-order cancellation reclassifies SaleDeduction -> Waste.
    return m.voidedAt != null ? "Waste" : m.reason

function requiredByItem(order, reservation):
    if reservation != null:
        return map(reservation.items, i => (i.inventoryItemId, i.requiredQuantity))
    else:
        return recomputeFromComponents(order)  // read-only; may be null

function saleMovements(movements):
    return movements.filter(m => effectiveReason(m) == "SaleDeduction")

function movementQuantityByItem(movements):
    result = {}
    for m in saleMovements(movements):
        result[m.item] = round3(result[m.item] + m.quantity)
    return result
```

`recomputeFromComponents` is **not** authoritative for historical orders; when it disagrees with the reservation, the reservation wins and the class becomes `EVIDENCE_CONFLICT`.

---

## 2. Rule index

| Rule | Required class | R-map | Severity | Confidence | Auto |
|---|---|---|---|---|---|
| D01 | `PAID` order with missing required stock deduction | R1, R6 | Critical | High / Medium | PROHIBITED |
| D02 | Stock deduction without successful payment/accounting evidence | R7 extension | High | Medium–High | PROHIBITED |
| D03 | Duplicate stock movements | R5 | Critical | High | PROHIBITED |
| D04 | Duplicate or inconsistent reservations | R5 / R7 | Critical | High | PROHIBITED |
| D05 | Expired or abandoned reservations | R2 / R7 | High | High / Medium | PROHIBITED |
| D06 | Orders stuck in `CONSUMING` | R3 | Critical | High after `W_STALE` | PROHIBITED |
| D07 | Partial multi-station stock deductions | R4 / R6 | High | High / Medium | PROHIBITED |
| D08 | Cancelled items with inconsistent inventory state | R5 / R7 | High | High / Medium | PROHIBITED |
| D09 | Payment verification/rejection with inconsistent stock state | R1 / R7 | High | Medium | PROHIBITED |
| D10 | Missing, malformed, or conflicting recovery evidence | all | High | High / Medium | PROHIBITED |

---

## 3. D01 — `PAID` order with missing required stock deduction

- **Required class:** 1.
- **R-map:** R1, R6.
- **Authoritative fields:** `orders.status`, `orders.paidAt`, `orders.paymentMethod`, `orders.items[].components[].inventoryItemId`, `orders.items[].components[].quantity/stockQuantity`, `inventoryreservations.status/items/consumedAt/releasedAt/releaseReason`, `stockmovements.reason/refOrderId/item/quantity/idempotencyKey/voidedAt`.
- **Correlation identity:** `orderId`; item-level `(orderId, inventoryItemId)`.

### 3.1 Detection algorithm

```text
for order in orders.find({
      status: "PAID",
      paidAt: { $ne: null },
      updatedAt: { $gte: since, $lte: until }
    }).sort({ _id: 1 }).limit(limit):

    reservation = loadReservations(order._id)
    movements   = loadMovements(order._id)
    sales       = saleMovements(movements)

    // 1. No inventory requirement at all.
    if reservation == null and recomputeFromComponents(order) is empty:
        report(order, "D01", "NO_INVENTORY_REQUIREMENT", INFO, confidence=High)
        continue

    // 2. Legacy order deducted before reservations existed.
    if reservation == null and sales.length > 0:
        report(order, "D01", "ALREADY_CORRECT_LEGACY", INFO, confidence=High)
        continue

    // 3. Reservation exists and is consumed.
    if reservation.status == "CONSUMED":
        expected = reservation.items.filter(i => i.requiredQuantity > 0)
        missing  = expected.filter(i =>
                     i.consumedQuantity <= EPSILON and
                     i.shortageQuantity <= EPSILON and
                     not any(s in sales for s.item == i.inventoryItemId))
        if missing.length > 0:
            report(order, "D01", "CONSUMED_WITHOUT_ITEM_EVIDENCE",
                   Critical, Medium, items=missing)
        continue

    // 4. Reservation still live on a PAID order.
    if reservation.status in ["RESERVED","APPROVED","APPROVAL_REQUIRED"]:
        report(order, "D01", "PAID_WITH_LIVE_RESERVATION",
               Critical, High, reservationStatus=reservation.status)
        continue

    // 5. Reservation released because payment-fallback consumption failed.
    if reservation.status == "RELEASED" and
       reservation.releaseReason == "CONSUMPTION_FAILED" and
       sales.length == 0:
        report(order, "D01", "PAID_RELEASED_NO_DEDUCTION",
               Critical, High)
        continue

    // 6. No reservation and no movement, with a computed requirement.
    if reservation == null and sales.length == 0 and requiredByItem(...) not empty:
        report(order, "D01", "PAID_NO_RESERVATION_NO_DEDUCTION",
               Critical, Medium)
```

### 3.2 False-positive risks

| Risk | Handling |
|---|---|
| Order has only external/retail or `NOTE` lines | `NO_INVENTORY_REQUIREMENT` / `INFO`; not a finding. |
| Order is a legacy pre-reservation sale with a legacy deduction | `ALREADY_CORRECT_LEGACY`; do not create a reservation. |
| Approved shortage explains a zero `consumedQuantity` | Treat `shortageQuantity > 0` with valid approval as covered; report `APPROVED_SHORTAGE` at `INFO`. |
| `SaleDeduction` was reclassified to `Waste` by a cancellation, but the order is somehow `PAID` | Contradictory; route to D10 rather than D01. |
| Order paid before preparation and consumption still pending within `W_ACTIVE` | Apply grace; re-read before reporting. |
| Reservation missing for a genuinely inventory-free order | `NO_INVENTORY_REQUIREMENT`, not `PAID_NO_RESERVATION_NO_DEDUCTION`. |

### 3.3 Output and review

| Field | Value |
|---|---|
| Severity | **Critical** when stock is missing and an item requirement is proven; **High** otherwise. |
| Confidence | High with a reservation/fingerprint; Medium when the requirement must be recomputed. |
| Required evidence | E2. |
| Human review | Inventory manager + finance reviewer. |
| Next step | Manual comparison with physical count; choose an approved correction path. |
| Auto-recovery | **PROHIBITED.** Even R1 is manual; only R2 (live reservation) may use the idempotent primitive in a future approved worker. |

---

## 4. D02 — Stock deduction without successful payment/accounting evidence

- **Required class:** 2.
- **R-map:** extension of R7 (the approved R-set has no explicit inverse class).
- **Authoritative fields:** `stockmovements.refOrderId/reason/quantity/item/voidedAt/voidReason/idempotencyKey`, `orders.status/paidAt/paymentMethod`, `inventoryreservations.status/voids`.
- **Correlation identity:** `orderId`; `idempotencyKey = sale:<orderId>:<item>`.

### 4.1 Detection algorithm

```text
for group in stockmovements.aggregate([
      { $match: { refOrderId: { $type: "objectId" } } },
      { $group: { _id: "$refOrderId", ids: { $push: "$_id" },
                  reasons: { $addToSet: "$reason" } } }
    ]):

    order = loadOrder(group._id)

    // Orphan movement: no order document.
    if order == null:
        report(group._id, "D02", "ORPHAN_DEDUCTION", Critical, High)
        continue

    reservation = loadReservations(order._id)
    movements   = loadMovements(order._id)
    sales       = saleMovements(movements)

    if sales.length == 0:
        continue   // no deduction to reconcile

    // Consumption at PREPARING is legitimate, even without payment.
    if order.status in ["PENDING","PREPARING","READY","SERVED","PAYMENT_PENDING"]:
        // Only flag if the lifecycle cannot explain the deduction.
        if order.preparingAt == null and all station statuses are null:
            report(order, "D02", "DEDUCTION_WITHOUT_PREPARATION_OR_PAYMENT",
                   High, Medium)
        continue

    // Terminal non-paid order: deduction must be voided or reclassified.
    if order.status in ["CANCELLED","ARCHIVED"]:
        if reservation != null and reservation.voids has an ORDER/LINE entry:
            continue   // expected
        report(order, "D02", "TERMINAL_DEDUCTION_NO_VOID", High, High)
        continue

    // PAID orders are D01's domain; do not double-report.
    if order.status == "PAID":
        continue

    report(order, "D02", "UNKNOWN_LIFECYCLE_DEDUCTION", High, Medium)
```

### 4.2 False-positive risks

| Risk | Handling |
|---|---|
| **Normal design:** ingredients are consumed at `PREPARING`, long before payment. | Never require `PAID`; the lifecycle check is mandatory. |
| Post-consumption cancellation void exists. | `reservation.voids` + `voidedAt` suppress the finding. |
| Legacy deduction on an archived order. | Report as `LEGACY_DEDUCTION` at `INFO` when no reservation exists and the order predates the model. |
| Manual `Correction` or `Initial` movements. | Only `SaleDeduction`/effective `Waste` are considered; `Correction` is context. |
| Payment evidence exists but `paidAt` is null on a legacy `PAID` order. | Use `status == PAID` as settlement evidence; flag the missing `paidAt` under D10, not D02. |
| A deduction belongs to a cancelled *line*, not the whole order. | Aggregate consumption makes line attribution unsafe; report at `Medium`. |

### 4.3 Output and review

| Field | Value |
|---|---|
| Severity | **Critical** for orphan or terminal-no-void; **High** otherwise. |
| Confidence | Medium–High; High only when the lifecycle cannot explain the deduction. |
| Required evidence | E2. |
| Human review | Cashier/finance reviewer + inventory manager. |
| Auto-recovery | **PROHIBITED.** Removing or restoring a movement is an accounting change. |

---

## 5. D03 — Duplicate stock movements

- **Required class:** 3.
- **R-map:** R5.
- **Authoritative fields:** `stockmovements.refOrderId`, `item`, `reason`, `voidedAt`, `quantity`, `idempotencyKey`, `createdAt`.
- **Correlation identity:** `(refOrderId, item, effectiveReason)`; `idempotencyKey`.

### 5.1 Detection algorithm

```text
// 5.1.1 Business identity duplicates.
for group in stockmovements.aggregate([
      { $match: { refOrderId: { $type: "objectId" } } },
      { $group: {
          _id: { order: "$refOrderId", item: "$item", reason: "$reason" },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
          quantities: { $push: "$quantity" }
      }},
      { $match: { count: { $gt: 1 } } }
    ]):
    report(group._id.order, "D03", "DUPLICATE_MOVEMENT_IDENTITY",
           Critical, High, ids=group.ids)
    // A legitimate duplicate is possible only for reasons other than
    // SaleDeduction (e.g. repeated Correction); classify those as Medium.

// 5.1.2 Idempotency-key duplicates.
for group in stockmovements.aggregate([
      { $match: { idempotencyKey: { $type: "string" } } },
      { $group: { _id: "$idempotencyKey", count: { $sum: 1 },
                  ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } }
    ]):
    report(group._id, "D03", "DUPLICATE_IDEMPOTENCY_KEY",
           Critical, High, ids=group.ids)

// 5.1.3 Malformed sale key.
for m in stockmovements.find({ reason: "SaleDeduction" }):
    expected = "sale:" + String(m.refOrderId) + ":" + String(m.item)
    if m.idempotencyKey != null and m.idempotencyKey != expected:
        report(m.refOrderId, "D03", "MALFORMED_SALE_KEY", High, High, m._id)
```

### 5.2 False-positive risks

| Risk | Handling |
|---|---|
| One legitimate `SaleDeduction` per item per order is the design. | Any second row is anomalous; the unique partial index should have rejected it. |
| `Waste` reclassification changes the reason but not the row count. | Effective reason; do not count a reclassified row as a duplicate. |
| Multiple `Correction` rows for one item. | Legitimate if each has a distinct reason/createdAt and no `SaleDeduction`; report `INFO`. |
| Purchase receiving uses `idempotencyKey` globally. | Only keys beginning with `sale:` are order-deduction keys; other duplicates are D03-context but not inventory-sale anomalies. |
| Duplicate rows could exist because the unique index was never deployed. | Report `INDEX_ABSENT_SUSPECTED` alongside the duplicate; do not assume corruption. |

### 5.3 Output and review

| Field | Value |
|---|---|
| Severity | **Critical** (double decrement). |
| Confidence | High for identical identity/key; Medium for mixed reasons. |
| Required evidence | E2. |
| Human review | Inventory manager + finance; DBA for index evidence. |
| Auto-recovery | **PROHIBITED.** Deleting a row or restoring stock requires an approved correction. |

---

## 6. D04 — Duplicate or inconsistent reservations

- **Required class:** 4.
- **R-map:** R5 / R7.
- **Authoritative fields:** `inventoryreservations.orderId/orderNumber/status/items/approval/requirementFingerprint/shortageFingerprint/consumedAt/releasedAt/voids`, `orders._id/orderNumber/status`.
- **Correlation identity:** `orderId`.

### 6.1 Detection algorithm

```text
// 6.1.1 Duplicate reservation documents.
for group in inventoryreservations.aggregate([
      { $group: { _id: "$orderId", count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } }
    ]):
    report(group._id, "D04", "DUPLICATE_RESERVATION", Critical, High, ids=group.ids)

// 6.1.2 Orphan reservation.
for r in inventoryreservations.find({}):
    if orders.exists({ _id: r.orderId }) == false:
        report(r.orderId, "D04", "ORPHAN_RESERVATION", High, High)

// 6.1.3 Structural inconsistencies.
for r in inventoryreservations.find({}):
    if r.status == "CONSUMED" and (r.consumedAt == null or all(i.consumedQuantity == 0)):
        report(r.orderId, "D04", "CONSUMED_WITHOUT_EVIDENCE", High, High)
    if r.status == "RELEASED" and any(i.reservedQuantity > 0):
        report(r.orderId, "D04", "RELEASED_WITH_HOLD", High, High)
    if r.status == "APPROVED" and r.approval == null:
        report(r.orderId, "D04", "APPROVED_WITHOUT_APPROVAL", High, High)
    if r.approval != null and r.approval.requirementFingerprint != r.requirementFingerprint:
        report(r.orderId, "D04", "APPROVAL_FINGERPRINT_MISMATCH", Medium, Medium)
    for i in r.items:
        if i.consumedQuantity > i.requiredQuantity + EPSILON:
            report(r.orderId, "D04", "CONSUMED_EXCEEDS_REQUIRED", High, High, i)
        if i.reservedQuantity < 0 or i.consumedQuantity < 0:
            report(r.orderId, "D04", "NEGATIVE_RESERVATION_QUANTITY", High, High, i)

// 6.1.4 Reservation item references a missing inventory item.
for r in inventoryreservations.find({}):
    missing = loadInventory(r.items.map(i => i.inventoryItemId)) returns fewer docs
    if missing: report(r.orderId, "D04", "MISSING_INVENTORY_ITEM", High, High)
```

### 6.2 False-positive risks

| Risk | Handling |
|---|---|
| Duplicate is impossible when the unique index exists. | Treat presence as evidence the index is missing or the write bypassed the model; report index evidence separately. |
| A reservation created concurrently with order creation may briefly be absent. | Apply `W_EDIT`; re-read before reporting. |
| `NO_INVENTORY` reservation has zero items. | Expected; not an inconsistency. |
| `APPROVED` with `shortageQuantity > 0` and a valid approval. | Expected; only flag missing approval or fingerprint mismatch. |
| Legacy reservations with null fingerprints. | Report `LEGACY_SHAPE` at `INFO`; do not require fingerprints retroactively. |
| `RELEASED` retains historical item quantities. | `releaseOrderInventory` zeroes `reservedQuantity`; if a legacy row does not, report `Medium`. |

### 6.3 Output and review

| Field | Value |
|---|---|
| Severity | **Critical** for duplicates/orphans; **High** for structural contradictions. |
| Confidence | High for structural facts; Medium for fingerprint drift. |
| Required evidence | E2. |
| Human review | Inventory manager; DBA for index verification. |
| Auto-recovery | **PROHIBITED.** |

---

## 7. D05 — Expired or abandoned reservations

- **Required class:** 5.
- **R-map:** R2 / R7.
- **Authoritative fields:** `inventoryreservations.status/reservedQuantity/updatedAt/decisionAt`, `orders.status/createdAt/updatedAt/paidAt`, `inventoryitems.reservedStock`.
- **Correlation identity:** `orderId`; item-level for hold arithmetic.

### 7.1 Detection algorithm

```text
LIVE = ["RESERVED", "APPROVED", "APPROVAL_REQUIRED", "NO_INVENTORY"]

for r in inventoryreservations.find({ status: { $in: LIVE } }):
    if r.status == "NO_INVENTORY" and
       sum(i.reservedQuantity for i in r.items) <= EPSILON:
        continue                    // no physical hold to expire
    order = loadOrder(r.orderId)
    age   = now - (r.decisionAt or r.updatedAt)

    if order == null:
        report(r.orderId, "D05", "ORPHAN_LIVE_HOLD", High, High)
        continue

    if order.status in ["CANCELLED","ARCHIVED"]:
        report(r.orderId, "D05", "HOLD_ON_TERMINAL_ORDER", High, High)
        continue

    if order.status == "PAID":
        // Overlaps D01; report once using D01, and mark D05 as cross-reference.
        report(r.orderId, "D05", "PAID_WITH_LIVE_HOLD", Critical, High)
        continue

    if order.status in ["PENDING","PREPARING","READY","SERVED","PAYMENT_PENDING"] and
       age > W_STALE:
        report(r.orderId, "D05", "STALE_LIVE_HOLD", Medium, Medium, ageMs=age)
```

`NO_INVENTORY` is reported only when it holds a positive `reservedStock`; a `NO_INVENTORY` reservation with zero items is not a hold.

### 7.2 False-positive risks

| Risk | Handling |
|---|---|
| Long-lived open table legitimately holds stock. | `W_STALE` is a business threshold; report `Medium` and let the manager confirm. |
| `APPROVAL_REQUIRED` is a deliberate blocked state awaiting manager action. | Report as `AWAITING_APPROVAL` at `Info` until `W_STALE`; never treat it as corruption. |
| `APPROVED` shortage has a hold only for the physically available portion. | Compare `reservedStock`, not `requiredQuantity`. |
| Order edit + reconcile in flight. | `W_EDIT` grace. |
| Terminal-order hold may already be scheduled for release by a cancel retry. | Re-read; if a release is in flight, do not report yet. |

### 7.3 Output and review

| Field | Value |
|---|---|
| Severity | **High** for terminal/paid holds; **Medium** for stale live holds. |
| Confidence | High for terminal order; Medium for age. |
| Required evidence | E2 (order status + reservation + inventory). |
| Human review | Inventory manager. |
| Auto-recovery | **PROHIBITED in WP-04.** Any release would change `reservedStock`; R7 is manual. OD-5 is required before any future automatic release. |

---

## 8. D06 — Orders stuck in `CONSUMING`

- **Required class:** 6.
- **R-map:** R3.
- **Authoritative fields:** `inventoryreservations.status/updatedAt/items/consumedAt`, `stockmovements` for the order, `inventoryitems`.
- **Correlation identity:** `orderId`.

### 8.1 Detection algorithm

```text
for r in inventoryreservations.find({ status: "CONSUMING" }):
    age = now - r.updatedAt
    if age < W_STALE: continue       // plausible in-flight transaction

    order     = loadOrder(r.orderId)
    movements = loadMovements(r.orderId)
    qtyByItem = movementQuantityByItem(movements)
    items     = r.items or []
    expected  = items.filter(i => i.requiredQuantity > i.shortageQuantity + EPSILON)

    if order == null:
        report(r.orderId, "D06", "CONSUMING_ORPHAN", Critical, High)
        continue

    complete = expected.every(i =>
        qtyByItem[i.inventoryItemId] >= i.requiredQuantity - EPSILON)
    partial  = expected.some(i => qtyByItem has a positive quantity) and not complete
    none     = qtyByItem is empty
    hold     = sum(i.reservedQuantity) > EPSILON

    if complete and not hold:
        report(r.orderId, "D06", "CONSUMING_MOVEMENTS_COMPLETE",
               High, High, candidate="FINALIZE_CANDIDATE")
    else if partial:
        report(r.orderId, "D06", "CONSUMING_PARTIAL",
               Critical, High)
    else if none:
        report(r.orderId, "D06", "CONSUMING_ABANDONED",
               High, Medium)
    else:
        report(r.orderId, "D06", "CONSUMING_AMBIGUOUS",
               Critical, Medium)
```

### 8.2 False-positive risks

| Risk | Handling |
|---|---|
| A transaction is genuinely in flight. | `W_STALE` must exceed the approved transaction budget (WP-14). |
| The claim committed but the process died before the transaction completed. | That is exactly the class; do not assume it rolled back without evidence. |
| Movements exist but are `Waste` from a cancellation. | Compare effective reason; a voided consumption is not a completed sale deduction. |
| Clock skew between app and database. | Use the database `updatedAt` and server time; report the delta. |
| A long repair held the transaction open. | Report `Observed long transaction` separately; still no auto-fix. |

### 8.3 Output and review

| Field | Value |
|---|---|
| Severity | **Critical** for partial/ambiguous deduction; **High** otherwise. |
| Confidence | High after `W_STALE`; Medium before. |
| Required evidence | E2 (reservation + movements + inventory). |
| Human review | Inventory manager + technical lead. |
| Auto-recovery | **PROHIBITED.** Only a future WP-06 may finalize a *status-only* `FINALIZE_CANDIDATE` when movements are conclusive and no hold remains. No stock change. |

---

## 9. D07 — Partial multi-station stock deductions

- **Required class:** 7.
- **R-map:** R4 / R6.
- **Authoritative fields:** `orders.items[].type/quantity/cancelled/components`, `orders.kitchenStatus/baristaStatus/hotDrinkStatus`, `inventoryreservations.status/items`, `stockmovements`.
- **Correlation identity:** `orderId`; item-level.

### 9.1 Detection algorithm

```text
for r in inventoryreservations.find({ status: "CONSUMED" }):
    order     = loadOrder(r.orderId)
    if order == null: continue
    movements = loadMovements(order._id)
    qtyByItem = movementQuantityByItem(movements)

    for i in r.items:
        moved = qtyByItem[i.inventoryItemId] or 0
        if abs(moved - i.consumedQuantity) > EPSILON:
            report(order, "D07", "CONSUMED_MOVEMENT_MISMATCH",
                   High, High, item=i.inventoryItemId,
                   consumed=i.consumedQuantity, moved=moved)

        if i.requiredQuantity > i.shortageQuantity + EPSILON and
           i.consumedQuantity <= EPSILON and moved <= EPSILON:
            report(order, "D07", "REQUIRED_ITEM_NOT_CONSUMED",
                   High, Medium, item=i.inventoryItemId)

    // Movement for an item the reservation never held.
    for itemId in qtyByItem:
        if no r.items matches itemId:
            report(order, "D07", "MOVEMENT_WITHOUT_RESERVATION_ITEM",
                   High, High, item=itemId)

    // Station-level completeness.
    activeStations = deriveStations(order.items)
    consumedStations = deriveStationsFromReservationItems(r.items)
    if activeStations has a station with no consumed item and
       reservation.status == "CONSUMED":
        report(order, "D07", "STATION_PARTIAL_CONSUMPTION",
               Medium, Medium, station=...)
```

`deriveStations` uses item `type` and active (not cancelled) lines only.

### 9.2 False-positive risks

| Risk | Handling |
|---|---|
| Multi-station order: the whole order is consumed at the first station by design. | Do not require each station to have its own consumption event; compare the whole reservation. |
| Approved shortage. | `shortageQuantity > 0` explains a lower `consumedQuantity`; do not flag. |
| An item is shared by two lines/recipes. | Reservations aggregate per item; compare totals, not lines. |
| A line was cancelled before prep. | Exclude cancelled lines from the expected set. |
| `NO_INVENTORY` station (no recipe). | No movement expected; exclude. |
| A movement is `Waste` due to whole-order cancellation. | Effective reason and `voidedAt`; not a sale deduction. |

### 9.3 Output and review

| Field | Value |
|---|---|
| Severity | **High**; **Critical** if the mismatch implies a double or missing stock decrement. |
| Confidence | High for quantity mismatch; Medium for station-level inference. |
| Required evidence | E2. |
| Human review | Inventory manager + station lead. |
| Auto-recovery | **PROHIBITED.** A future WP-06 may finalize `CONSUMED` only when no live hold and movements are complete; any quantity change is manual. |

---

## 10. D08 — Cancelled items with inconsistent inventory state

- **Required class:** 8.
- **R-map:** R5 / R7.
- **Authoritative fields:** `orders.status/items[].cancelled/items[].lineId/items[].cancelledAt`, `inventoryreservations.status/voids/reservedQuantity`, `stockmovements.reason/voidedAt/voidReason`.
- **Correlation identity:** `orderId`; line-level `(orderId, lineId)` where safe.

### 10.1 Detection algorithm

```text
for order in orders.find({ "items.cancelled": true, updatedAt: { $gte: since } }):
    r = loadReservations(order._id)
    movements = loadMovements(order._id)
    sales = saleMovements(movements)
    cancelledLines = order.items.filter(i => i.cancelled)
    allCancelled   = order.items.every(i => i.cancelled)

    // 10.1.1 Whole order cancelled after consumption.
    if order.status == "CANCELLED" and r != null and r.status == "CONSUMED":
        if not (r.voids has source == "ORDER"):
            report(order, "D08", "CANCELLED_NO_ORDER_VOID", High, High)
        if sales.length > 0:
            report(order, "D08", "CANCELLED_SALE_NOT_RECLASSIFIED",
                   High, High)
        continue

    // 10.1.2 Whole order cancelled before consumption.
    if order.status == "CANCELLED" and r != null and r.status in
       ["RESERVED","APPROVED","APPROVAL_REQUIRED","NO_INVENTORY"]:
        report(order, "D08", "CANCELLED_HOLD_NOT_RELEASED", High, High)
        continue

    // 10.1.3 Line cancelled after consumption.
    if r != null and (r.status == "CONSUMED" or any consumedQuantity > 0):
        for line in cancelledLines:
            if not (r.voids has source == "LINE" and lineId == line.lineId):
                report(order, "D08", "LINE_CANCEL_NO_VOID",
                       Medium, Medium, lineId=line.lineId)
        continue

    // 10.1.4 Line cancelled before consumption: requirement must be reconciled.
    if r != null and r.status in ["RESERVED","APPROVED","APPROVAL_REQUIRED"]:
        stillRequired = r.items where requiredQuantity > 0 and
                        the item is linked only to cancelled lines
        if stillRequired:
            report(order, "D08", "LINE_CANCEL_HOLD_NOT_RECONCILED",
                   High, Medium, items=stillRequired)

    // 10.1.5 Duplicate void entries.
    for (source, lineId) in r.voids:
        if count(duplicates) > 1:
            report(order, "D08", "DUPLICATE_VOID", Medium, High)
```

### 10.2 False-positive risks

| Risk | Handling |
|---|---|
| **Line-level attribution is unsafe** because reservation items aggregate per inventory item. | Report line-level gaps at `Medium`; require item-level proof before a correction. |
| Cancellation hook retry in flight. | `W_EDIT` grace; re-read. |
| `ARCHIVED` is not `CANCELLED`; archive releases/reclassifies with `source: ARCHIVE`. | Match `source` in `{ORDER, ARCHIVE}` for whole-order; do not require exactly `ORDER`. |
| A cancelled line shares an item with an active line. | The item must remain consumed for the active line; never release it based on one cancelled line. |
| Whole-order cancel reclassifies to `Waste` without a second decrement. | Expect `voidedAt` and `reason=Waste`; do not flag a "missing" `SaleDeduction`. |
| Pre-consumption cancel with `NO_INVENTORY`. | No hold to release; not a finding. |

### 10.3 Output and review

| Field | Value |
|---|---|
| Severity | **High** for whole-order and cash-impacting cases; **Medium** for line-level. |
| Confidence | High for whole-order; Medium for line-level. |
| Required evidence | E2. |
| Human review | Manager + inventory manager. |
| Auto-recovery | **PROHIBITED.** Void/reclassification decisions are accounting facts. |

---

## 11. D09 — Payment verification/rejection with inconsistent stock state

- **Required class:** 9.
- **R-map:** R1 / R7.
- **Authoritative fields:** `orders.status/paymentMethod/paymentAccountId/paymentAccountSnapshot/paymentSubmittedAt/paymentSubmittedBy/paymentVerifiedAt/paymentVerifiedBy/paymentRejectedAt/paymentRejectedBy/paymentRejectionReason/paidAt/preparingAt/kitchenStatus/baristaStatus/hotDrinkStatus`, `inventoryreservations.status/items/consumedAt`, `stockmovements`.
- **Correlation identity:** `orderId`.

### 11.1 Detection algorithm

```text
for order in orders.find({
      status: { $in: ["PAYMENT_PENDING","SERVED","PAID"] },
      updatedAt: { $gte: since }
    }):

    r = loadReservations(order._id)
    movements = loadMovements(order._id)

    // 11.1.1 Payment-workflow contradictions.
    if order.status == "PAYMENT_PENDING":
        if order.paymentMethod in [null,"NONE"] or order.paymentSubmittedAt == null:
            report(order, "D09", "PENDING_WITHOUT_SUBMISSION", High, High)
        if order.paidAt != null:
            report(order, "D09", "PENDING_WITH_PAID_AT", Critical, High)
        if order.paymentVerifiedAt != null:
            report(order, "D09", "PENDING_WITH_VERIFICATION", High, High)
        if order.paymentRejectedAt != null and order.paymentSubmittedAt < order.paymentRejectedAt:
            report(order, "D09", "PENDING_AFTER_REJECTION", High, Medium)

    if order.status == "PAID":
        if order.paidAt == null:
            report(order, "D09", "PAID_WITHOUT_PAID_AT", High, High)
        if order.paymentMethod in [null,"NONE"]:
            report(order, "D09", "PAID_WITHOUT_METHOD", High, High)
        if order.paymentMethod == "TRANSFER" and
           (order.paymentAccountId == null or order.paymentAccountSnapshot == null):
            report(order, "D09", "PAID_TRANSFER_WITHOUT_ACCOUNT", Medium, High)
        if order.paymentRejectedAt != null:
            report(order, "D09", "PAID_WITH_REJECTION_TIMESTAMP", High, Medium)

    // 11.1.2 Prepared order with a live hold: stock should have been consumed.
    prepared = order.preparingAt != null or
               any station status in ["PREPARING","READY","SERVED"]
    if prepared and r != null and
       r.status in ["RESERVED","APPROVED","APPROVAL_REQUIRED"]:
        report(order, "D09", "PREPARED_WITH_LIVE_HOLD", High, High)

    // 11.1.3 Verified-but-not-paid, or paid-without-consumption.
    if order.paymentVerifiedAt != null and order.status != "PAID":
        report(order, "D09", "VERIFIED_NOT_PAID", Medium, Medium)
```

### 11.2 False-positive risks

| Risk | Handling |
|---|---|
| `PAYMENT_PENDING` after preparation is normal; stock is already consumed. | Do not flag consumed stock on a payment-pending order. |
| `rejectPayment` returns the order to `SERVED` and preserves the snapshot. | Rejection timestamps are expected; only status/payment contradictions are flagged. |
| `payOrder` may not set `paymentVerifiedAt` (cashier path). | Do not require verification fields for a `PAID` cash order. |
| Legacy `PAID` order with `paidAt: null`. | Report `High` but do not invent a backfill (WP-01). |
| A transfer account may have been archived after payment. | Use the snapshot, not the current account status. |
| Manual manager status edits. | Report `Medium`; require order-history review. |
| A prepared order may legitimately hold stock if consumption failed and the hold was not released. | That is the finding; still no auto-release. |

### 11.3 Output and review

| Field | Value |
|---|---|
| Severity | **Critical** for contradictory settlement; **High** for prepared-with-hold. |
| Confidence | Medium–High; Medium for legacy/manual states. |
| Required evidence | E2. |
| Human review | Cashier/finance reviewer + inventory manager. |
| Auto-recovery | **PROHIBITED.** Payment fields are immutable after `PAID`; stock changes are manual. |

---

## 12. D10 — Missing, malformed, or conflicting recovery evidence

- **Required class:** 10.
- **R-map:** all.
- **Authoritative fields:** every field used by D01–D09, plus schema enums and type expectations.
- **Correlation identity:** `orderId`, `taskId`, `evidenceFingerprint`.

### 12.1 Detection algorithm

```text
for order in orders.find({ updatedAt: { $gte: since } }):
    validate order:
      - status is a known enum value
      - paymentMethod is a known enum value
      - paidAt/status consistency (delegated to D09)
      - account snapshot shape is an object or null
    for r in loadReservations(order._id):
      validate reservation:
        - status is a known enum value
        - items is an array
        - each quantity is a finite, non-negative number
        - consumedQuantity <= requiredQuantity + EPSILON
        - reservedQuantity is zero when status is CONSUMED or RELEASED
        - approval is null unless status is APPROVED
      for movement in loadMovements(order._id):
        validate movement:
          - type is IN/OUT/ADJUSTMENT
          - reason is a known enum value or null
          - OUT movement has quantity > 0
          - SaleDeduction has refOrderId and a sale:<orderId>:<item> key
          - idempotencyKey is a string when non-null
    cross-check:
      - reservation.orderNumber == order.orderNumber (or both null)
      - every movement.item exists in inventoryitems
      - every reservation item exists in inventoryitems
      - no two documents disagree on the same fact

    if validation fails:
        report(order, "D10", code, High/Medium, field=..., observed=...,
               expected=...)
        // Never guess the missing value.

// Evidence drift between detection and execution.
if task.evidenceFingerprint != recomputeFingerprint(order, reservation, movements, inventory):
    report(task.orderId, "D10", "EVIDENCE_DRIFT", High, High,
           old=task.evidenceFingerprint, new=current)
```

### 12.2 Error codes

| Code | Meaning |
|---|---|
| `UNKNOWN_ENUM` | A status/type/reason outside the schema enum. |
| `MISSING_REQUIRED_FIELD` | A required evidence field is null/absent. |
| `INVALID_TYPE` | A field has the wrong BSON type. |
| `NEGATIVE_QUANTITY` | A quantity is negative. |
| `QUANTITY_OUT_OF_RANGE` | `consumedQuantity > requiredQuantity`, etc. |
| `ORPHAN_REFERENCE` | A movement/reservation points to a missing order/item. |
| `IDENTITY_MISMATCH` | `orderNumber`/`orderId` disagree across documents. |
| `CONTRADICTORY_TIMESTAMPS` | Verified+rejected, paid+unpaid, etc. |
| `EVIDENCE_DRIFT` | The snapshot changed after detection. |
| `UNKNOWN_SHAPE` | A document has an unexpected shape not covered above. |

### 12.3 False-positive risks

| Risk | Handling |
|---|---|
| Legacy documents may not have newer fields. | Treat absent optional fields as `LEGACY_SHAPE` at `Info`; only required fields are errors. |
| A field may be temporarily inconsistent during a transaction. | Read at one logical point; apply `W_ACTIVE`. |
| Decimal precision. | Compare with the project's existing `round3`/epsilon policy; never binary float equality. |
| Unknown future fields. | Report `UNKNOWN_SHAPE`; never drop or reinterpret them. |

### 12.4 Output and review

| Field | Value |
|---|---|
| Severity | **High**; **Critical** when it blocks a financial decision. |
| Confidence | High for schema violations; Medium for semantic conflicts. |
| Required evidence | E1/E2; the report must state what is missing. |
| Human review | Technical lead + data owner; DBA if the shape is database-level. |
| Auto-recovery | **PROHIBITED.** This class blocks every automatic action for the order. |

---

## 13. Rule interaction and de-duplication

| Overlap | Resolution |
|---|---|
| D01 vs D05 (`PAID` + live hold) | Report once as D01 `PAID_WITH_LIVE_RESERVATION`; D05 emits a cross-reference only. |
| D01 vs D09 (`PAID` without `paidAt`) | D09 reports the payment-metadata defect; D01 reports the inventory consequence. Both may appear, with distinct codes. |
| D02 vs D08 (terminal deduction) | D08 owns cancellation/void semantics; D02 reports only if no void exists. |
| D03 vs D04 (duplicate documents) | D03 owns movements; D04 owns reservations. |
| D04 vs D05 (live reservation) | D04 owns structure; D05 owns age/terminal state. |
| D06 vs D07 (consumed quantity) | D06 owns `CONSUMING`; D07 owns `CONSUMED`/`PARTIALLY_CONSUMED`. |
| D10 vs all | D10 is a gate: if E0/E1, the order is reported only under D10 and excluded from automatic action. |

The report must include a `dedupeKey = class + orderId + itemId + lineId` so a single underlying defect is not counted twice.

---

## 14. Output contract (design)

```json
{
  "schema": "wp04-finding-v1",
  "generatedAt": "2026-11-08T00:00:00.000Z",
  "window": { "since": "...", "until": "..." },
  "readOnly": true,
  "summary": {
    "ordersScanned": 0,
    "findings": 0,
    "bySeverity": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
    "byRule": { "D01": 0 }
  },
  "findings": [
    {
      "rule": "D01",
      "code": "PAID_RELEASED_NO_DEDUCTION",
      "orderId": "...",
      "orderNumber": "...",
      "reservationId": "...",
      "itemId": null,
      "lineId": null,
      "severity": "critical",
      "confidence": "high",
      "evidenceLevel": "E2",
      "graceMs": 0,
      "evidenceFingerprint": "...",
      "evidence": {
        "orderStatus": "PAID",
        "paidAt": "...",
        "paymentMethod": "CASH",
        "reservationStatus": "RELEASED",
        "releaseReason": "CONSUMPTION_FAILED",
        "saleMovementCount": 0,
        "inventory": [{ "itemId": "...", "currentStock": 0, "reservedStock": 0 }]
      },
      "recommendedReview": "inventory+finance",
      "autoRecovery": "PROHIBITED"
    }
  ]
}
```

Rules:

- `readOnly` is always `true`;
- no write flag exists; `--apply` must be rejected by the parser;
- account numbers are masked;
- free-text cancellation reasons are omitted or truncated;
- findings are deterministic and stable for the same evidence;
- exit code `0` on a clean scan, `2` on findings, `1` on read error (proposal).

---

## 15. Index and performance plan (read-only)

| Query pattern | Preferred index | If absent |
|---|---|---|
| Orders by `status` + `updatedAt` | `{ status: 1, updatedAt: -1 }` (proposed) | Bounded scan; report `INDEX_ABSENT`; do not create. |
| Reservation by `orderId` | existing unique `orderId` | Slow join; report. |
| Reservation by `status` + `updatedAt` | existing `{ status: 1, updatedAt: -1 }` | Bounded scan. |
| Movements by `refOrderId` | proposed `{ refOrderId: 1, createdAt: -1 }` | Use `{ refOrderId, reason, item }` partial if present; otherwise scan. |
| Movements by idempotency key | existing unique partial | Duplicate detection degrades to aggregation. |
| Inventory by `_id` | default `_id` | Always available. |

WP-04 must **not** create any index. Missing indexes are reported as evidence; WP-11 owns deployment. A scan must be bounded by `--limit` and must not run an unbounded collection scan in production without approval.

---

## 16. Mapping of the ten required classes

| Required class | Rule(s) | Primary evidence |
|---|---|---|
| 1. `PAID` with missing required deduction | D01 | order, reservation, movements |
| 2. Deduction without payment/accounting evidence | D02 | movements, order lifecycle, reservation voids |
| 3. Duplicate stock movements | D03 | movements |
| 4. Duplicate/inconsistent reservations | D04 | reservations, inventory items |
| 5. Expired/abandoned reservations | D05 | reservations, order lifecycle, inventory |
| 6. Orders stuck in `CONSUMING` | D06 | reservation, movements, inventory |
| 7. Partial multi-station deductions | D07 | reservation items, movements, order lines |
| 8. Cancelled items with inconsistent inventory | D08 | order lines, reservation voids, movements |
| 9. Payment verification/rejection inconsistency | D09 | payment fields, reservation, movements |
| 10. Missing/malformed/conflicting evidence | D10 | all evidence, schema enums |

---

## 17. Explicit prohibitions

- No automatic action for D01–D10 in WP-04.
- No deletion of a movement, reservation, void, order, or audit record.
- No `$inc`/`$set` on `currentStock`, `reservedStock`, `paidAt`, payment identity, or balances.
- No negative-stock clamp.
- No invented correction quantity.
- No `--apply`, `--repair`, `--fix`, or `--force` flag.
- No production read without a separate approved operation.
- No V2 collection read or write.
- No change to order, payment, inventory, recipe, station, hotel, waiter, or reporting behaviour.

**No query in this document was executed. No database was contacted.**
