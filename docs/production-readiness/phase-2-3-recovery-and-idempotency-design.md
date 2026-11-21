# Phase 2.3 — Recovery and Idempotency Design

Status: **DESIGN PROPOSAL — NOT IMPLEMENTED**
Date: 2026-11-08
Scope: BONO POS V1 order payment and inventory consistency
Companion: `phase-2-3-transaction-concurrency-report.md`, `phase-2-3-payment-inventory-failure-matrix.md`

> This document proposes recovery and idempotency mechanisms. It does not add schema, code, jobs, indexes, environment variables, or operational automation. Every write described here is conditional and evidence-driven. **No recovery step may blindly increment or decrement stock.**

---

## 1. Current state (verified)

| Building block | Current behavior |
|---|---|
| Order payment | One atomic order document write (`payOrder`, `confirmPayment`) |
| Inventory consumption | One MongoDB transaction: `CONSUMING` claim → conditional decrement → `SaleDeduction` insert → `CONSUMED` |
| Reservation identity | One document per order; unique `orderId` |
| Movement identity | Unique partial `(refOrderId, reason, item)` and unique partial `idempotencyKey` |
| Movement key | `sale:<orderId>:<inventoryItemId>` — server-derived |
| Unknown commit | Never retried; caller resolves from durable evidence |
| Transient errors | Bounded retry (max 3 attempts) |
| Payment/inventory atomicity | **Not atomic as a pair**; payment commits first, inventory follows |
| Recovery worker | **None** |
| Reconciliation job | **None** |
| Alerting for paid-without-deduction | **None** |
| External provider boundary | **None** |

The current design already provides the *primitives* for safe recovery: an idempotent reservation identity, an idempotent movement key, a consumption state machine, and conditional stock writes. What is missing is a durable recovery owner, detection, evidence recording, and operator escalation.

---

## 2. Server-authoritative identities

No identity may be derived from a client timestamp, a random client value, or a client-generated UUID.

| Action | Authoritative identity | Uniqueness mechanism |
|---|---|---|
| Order | `Order._id` (and human `orderNumber`) | Primary key / unique order number |
| Reservation | `orderId` | Unique index |
| Consumption attempt | `(orderId)` via reservation state | Atomic claim on `status` |
| Stock deduction | `(refOrderId, reason, item)` | Unique partial index |
| Sale deduction | `sale:<orderId>:<inventoryItemId>` | Unique partial `idempotencyKey` index |
| Post-preparation void | `(reservation, source, lineId)` | `voids.source $ne` / `voids.lineId $ne` filter |
| Recovery run | Server-generated `runId` + ownership marker | Operator/service-controlled, never client-supplied |
| Future provider event | Provider event ID | Unique index in an inbox/outbox collection |

The `sale:` key is stable across retries because it contains only the order ID and the inventory item ID. It does not contain time, user input, request IDs, or random noise.

---

## 3. Consistency approaches A–D

### Approach A — One transaction spanning order state and inventory

**Shape:** payment commit, reservation consumption, and movement insert in a single MongoDB transaction.

| Criterion | Assessment |
|---|---|
| Atomicity | Strongest: PAID and deduction commit or abort together |
| Availability | Payment would fail or block when inventory is unavailable/conflicted |
| Business impact | A paid customer could be refused settlement because a recipe link or stock write failed; conflicts with the current “payment succeeds, inventory is reconciled” policy |
| Compatibility | Requires refactoring `payOrder`/`confirmPayment`, order creation, and the reservation service onto one session; changes error contracts and latency |
| Complexity | High; larger transaction footprint, more write conflicts |
| Recovery | Minimal, but failures become customer-facing |
| Verdict | **Not recommended for the payment path.** Possible later for order creation + initial reservation only. |

### Approach B — Durable consumption job / explicit recovery state

**Shape:** keep the payment commit atomic. Treat the reservation state machine (`RESERVED` → `CONSUMING` → `CONSUMED`/`RELEASED`) as the durable job state. A recovery worker scans incomplete/abnormal states and performs one idempotent step at a time.

| Criterion | Assessment |
|---|---|
| Atomicity | Per-step atomic; eventual consistency between payment and stock |
| Availability | Payment is never blocked by inventory |
| Compatibility | Uses existing reservation/movement documents; no schema change required for a first version |
| Complexity | Medium: worker, lease, evidence log, alerting |
| Recovery | Strong if every step re-checks evidence and uses conditional writes |
| Verdict | **Recommended near-term.** |

### Approach C — Transactional outbox

**Shape:** payment commit writes the order state and an outbox event in one transaction. A worker publishes/consumes the event, then performs idempotent inventory work.

| Criterion | Assessment |
|---|---|
| Atomicity | Strong between order and event; inventory remains eventually consistent |
| Availability | Payment independent of inventory |
| Compatibility | Adds a collection/schema and worker; requires order and outbox to share a transaction-capable deployment |
| Complexity | Medium-high |
| Recovery | Excellent: the outbox row is the durable intent and can be replayed |
| External provider fit | Best fit if a provider is added later |
| Verdict | **Strategic target**, especially before any external payment integration. |

### Approach D — Explicit reconciliation

**Shape:** a read-only scanner compares orders, reservations, holds, and movements; it reports discrepancies and optionally performs the same safe recovery steps as B.

| Criterion | Assessment |
|---|---|
| Atomicity | None by itself; it detects |
| Availability | High; runs independently |
| Compatibility | No schema change for detection |
| Complexity | Medium (query design, thresholds, alert routing) |
| Recovery | Essential safety net even if A, B, or C is chosen |
| Verdict | **Required regardless of the chosen model.** |

### Recommendation

1. **Adopt B + D now:** durable recovery state plus explicit reconciliation.
2. **Treat every recovery action as idempotent and evidence-driven**, using the existing conditional primitives.
3. **Plan C as the next step** if an external payment provider, multi-service split, or higher transaction volume is introduced.
4. **Reject A for settlement** under the current business rule that a successful payment must not be reversed because inventory is unavailable.

---

## 4. Recovery model

### 4.1 Required properties

Every recovery action must satisfy all of the following:

1. **Idempotent** — re-running it produces no additional stock or financial effect.
2. **Evidence-first** — read authoritative order, reservation, inventory, and movement rows before writing.
3. **Conditional** — every write includes the expected prior state in the filter.
4. **Single-step** — one state transition per run; no batch blind adjustments.
5. **Auditable** — record before/after state, the exact filters used, and the outcome.
6. **Leased** — only one recovery owner may act on an order at a time.
7. **No restoration of consumed stock** — a consumed deduction is never incremented back.
8. **No payment reversal** — recovery never changes a successful `PAID` to another state.

### 4.2 Failure classes and safe actions

| Class | Detection | Safe action | Must not do |
|---|---|---|---|
| **R1. PAID, no reservation, no movement** | `Order.status=PAID`; reservation missing; `StockMovement` `SaleDeduction` missing | Check whether a legacy deduction exists. If yes, record an externally reconciled marker. If no, **escalate to manual** because the recipe/price snapshot at payment time is gone | Recompute and deduct against today’s recipe without approval |
| **R2. PAID, reservation `RESERVED`/`APPROVED`, no movement** | Reservation live; zero SaleDeduction | Run the normal idempotent consumption transaction. It re-checks stock, hold, and movement uniqueness | Force a deduction if physical/hold is insufficient |
| **R3. Reservation `CONSUMING` beyond lease** | `status=CONSUMING`; age > lease | Inspect movements and stock. If movements prove the deduction landed, finalize `CONSUMED` conditionally. Otherwise **manual**: the current code should never persist CONSUMING across a committed transaction | Reset to `RESERVED` and re-deduct |
| **R4. Movements exist, reservation not `CONSUMED`** | SaleDeduction rows exist; reservation `RESERVED`/`CONSUMING` | Conditionally mark `CONSUMED`, set `consumedAt`, record evidence. No stock change | Deduct again |
| **R5. Duplicate movements for one `(order, item)`** | Count > 1 | Alert and **manual**. Preserve all rows as evidence | Delete or decrement to “fix” |
| **R6. Reservation `CONSUMED`, no movement** | `consumedQuantity>0`; zero SaleDeduction | Alert and **manual**. Accounting/ledger reconstruction required | Re-decrement or silently recreate a movement |
| **R7. Hold leak** | `InventoryItem.reservedStock` > sum of live reservation holds | Recompute the expected hold from live reservations, compare, and propose a conditional correction with a full audit record. High-risk; manual approval recommended | Global zeroing of `reservedStock` |
| **R8. Negative stock** | `currentStock < 0` or `reservedStock < 0` | Alert and **manual**. Should be impossible under conditional writes | Clamp silently |

### 4.3 Recovery loop (pseudo-code)

```text
acquire lease for orderId (owner, leaseUntil)
evidence = read(order, reservation, inventory, movements)
if lease not owned -> exit
switch (classify(evidence)):
  R2 -> consumeOrderInventory(order)            # existing idempotent transaction
  R4 -> finalize reservation CONSUMED conditionally
  R3 -> if movements prove landed: finalize; else escalate
  R1/R5/R6/R7/R8 -> create manual-intervention record + alert
record audit evidence (before, filters, result, after)
release lease
```

Re-running the loop after a crash re-reads evidence and reaches the same decision. No step depends on a previous in-memory value.

---

## 5. Detection queries (illustrative, not executed)

Use conservative time thresholds; never run these against production as part of this phase.

### 5.1 Paid orders without consumption evidence

```js
// Orders that are PAID but have no reservation and no SaleDeduction.
db.orders.aggregate([
  { $match: { status: "PAID" } },
  { $lookup: {
      from: "inventoryreservations",
      localField: "_id",
      foreignField: "orderId",
      as: "reservation"
  }},
  { $lookup: {
      from: "stockmovements",
      let: { oid: "$_id" },
      pipeline: [
        { $match: { $expr: {
            $and: [
              { $eq: ["$refOrderId", "$$oid"] },
              { $eq: ["$reason", "SaleDeduction"] }
            ]
        }}},
        { $limit: 1 }
      ],
      as: "deduction"
  }},
  { $match: {
      reservation: { $size: 0 },
      deduction: { $size: 0 },
      paidAt: { $lt: new Date(Date.now() - 15 * 60 * 1000) }
  }},
  { $project: { orderNumber: 1, paidAt: 1, totalAmount: 1 } }
])
```

### 5.2 Live reservation on a paid order

```js
db.inventoryreservations.find({
  status: { $in: ["RESERVED", "APPROVED", "APPROVAL_REQUIRED", "NO_INVENTORY", "CONSUMING"] }
}).forEach((r) => {
  const o = db.orders.findOne({ _id: r.orderId });
  if (o && o.status === "PAID") printjson({ orderId: r.orderId, status: r.status });
});
```

### 5.3 Stale CONSUMING

```js
db.inventoryreservations.find({
  status: "CONSUMING",
  updatedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) }
})
```

### 5.4 Duplicate deduction detection

```js
db.stockmovements.aggregate([
  { $match: { reason: "SaleDeduction", refOrderId: { $type: "objectId" } } },
  { $group: {
      _id: { order: "$refOrderId", item: "$item" },
      count: { $sum: 1 },
      totalQty: { $sum: "$quantity" }
  }},
  { $match: { count: { $gt: 1 } } }
])
```

### 5.5 Reserved-stock drift

```js
db.inventoryitems.find({ reservedStock: { $gt: 0 } }).forEach((it) => {
  const reservations = db.inventoryreservations.find({
    status: { $in: ["RESERVED", "APPROVED", "APPROVAL_REQUIRED", "NO_INVENTORY"] },
    "items.inventoryItemId": it._id
  }).toArray();
  const expected = reservations.reduce((sum, r) => {
    const line = r.items.find((x) => String(x.inventoryItemId) === String(it._id));
    return sum + Number(line?.reservedQuantity || 0);
  }, 0);
  if (Math.abs(expected - it.reservedStock) > 0.0005) {
    printjson({ item: it._id, name: it.name, actual: it.reservedStock, expected });
  }
});
```

### 5.6 Consumed reservation without movement

```js
db.inventoryreservations.find({ status: "CONSUMED" }).forEach((r) => {
  const n = db.stockmovements.countDocuments({
    refOrderId: r.orderId,
    reason: { $in: ["SaleDeduction", "Waste"] }
  });
  if (n === 0) printjson({ orderId: r.orderId, consumedAt: r.consumedAt });
});
```

---

## 6. Recovery ownership

| Concern | Design |
|---|---|
| Who may run recovery | A single server-side worker identity, or a named operator runbook step. Never a POS client. |
| Concurrency | Per-order lease: `recoveryOwner` + `recoveryLeaseUntil` (proposed fields; **not added**). A conditional update claims the lease. |
| Lease expiry | Short (for example 5 minutes), renewed only by the owner. Expired lease may be reclaimed after evidence re-read. |
| Scope | One order at a time. No global stock rewrite. |
| Authority | Recovery may complete an existing intent; it may not invent a new financial action. |
| Escalation | R1, R5, R6, R7, R8 always create a manual-intervention record. |
| Idempotency | All actions use existing conditional primitives or equivalent conditional filters. |
| Observability | Every run emits a structured event with `runId`, `orderId`, class, action, result, and before/after values. |

Because the lease fields do not exist yet, the first implementation can use an external ownership marker or a dedicated recovery collection. That requires owner approval and a schema/index change, which Phase 2.3 did not perform.

---

## 7. Manual intervention criteria

A human must review, with the evidence attached, when:

- A `PAID` order has no reservation and no deduction, and no legacy deduction evidence exists.
- A reservation is `CONSUMING` beyond its lease without conclusive movement evidence.
- Duplicate `SaleDeduction` rows exist for one order/item.
- A `CONSUMED` reservation has no movement row.
- `currentStock` or `reservedStock` is negative.
- A paid order’s reservation is `RELEASED` and no deduction exists (paid without stock, or an accepted inventory failure).
- Hold drift cannot be explained by live reservations.
- Stock was restored by any path other than an approved physical stock correction (which must be a separate audited movement, never a silent `reservedStock` change).

---

## 8. Audit evidence requirements

For every recovery run, persist:

| Field | Purpose |
|---|---|
| `runId` | Correlate logs and manual review |
| `orderId` / `orderNumber` | Target |
| `reservationId` | Target inventory intent |
| `class` (R1–R8) | Why recovery ran |
| `detectedAt` | Detection time |
| `evidence` | The exact authoritative values read: order status/paidAt, reservation status/items, stock/hold, movement IDs/quantities |
| `action` | The single step attempted |
| `filters` | The exact conditional filter used |
| `before` / `after` | Stock, hold, reservation status, movement count |
| `result` | Applied / skipped / escalated |
| `owner` | Worker or operator identity |
| `finishedAt` | Completion time |
| `notes` | Manual rationale when escalated |

Evidence must allow a reviewer to reconstruct the decision **without re-reading mutable state**.

---

## 9. Duplicate payment and duplicate stock detection

| Detector | Signal | Expected response |
|---|---|---|
| Duplicate PAID transitions | One order row; `paidAt` set once | No duplicate payment row exists; detect repeated API calls via logs, not a second order |
| Conflicting payment methods | `PAID` order whose method changed across retries (possible today) | Alert; owner decides whether historical method is authoritative |
| Duplicate deduction | `(refOrderId, item)` count > 1 | Manual; preserve rows |
| Movement without reservation | `SaleDeduction` for an order with no reservation (legacy) | Classify as legacy; do not delete |
| Reservation without movement | `CONSUMED` but no movement | Manual accounting review |
| Paid without deduction | `PAID`, reservation `RELEASED`, no movement | Alert; likely accepted inventory failure or legacy path |
| Hold without live reservation | `reservedStock` > expected | Recompute and approve correction |
| Stock below zero | Negative current/reserved | Blocking alert; manual |
| Topology unavailable | `TRANSACTIONS_UNAVAILABLE` rate | Alert; fix topology, not application retries |

Suggested alert severity: negative stock, duplicate movements, and paid-without-evidence are **critical**; stale CONSUMING and hold drift are **high**; legacy/no-reservation paid orders are **review**.

---

## 10. Backup and restore dependencies

- A consistent backup must include `orders`, `inventoryitems`, `inventoryreservations`, `stockmovements`, `counters`, and the staff/settings collections required to interpret them.
- Point-in-time recovery requires the provider’s oplog/PITR capability; a nightly dump is not sufficient to reconstruct a payment/inventory boundary.
- Restore must preserve the unique partial indexes on `stockmovements` and the unique `orderId` reservation index. Restoring without them allows duplicate deductions on replay.
- After restore, run the read-only reconciliation queries **before** accepting writes. Do not replay payment or consumption mutations blindly.
- A restored database may legitimately contain the accepted “PAID but not deducted” state. Treat it as reconciliation evidence, not corruption.
- Backups must be encrypted and access-controlled; this document does not assert that the hosting provider currently does so.

---

## 11. External payment provider boundary (future)

No provider exists today. If one is added, these requirements are non-negotiable:

1. The provider **event ID** is the idempotency key, stored under a unique index.
2. Webhook verification (signature, timestamp, replay window) happens before any write.
3. The raw event is persisted in an inbox/outbox record.
4. The order transition and the event record are committed in one transaction where the topology allows.
5. Inventory consumption stays asynchronous and idempotent; the provider callback must not decrement stock directly.
6. A reconciliation poll against the provider is required for events that never arrive.
7. A provider “captured” event must never be silently reversed by an inventory failure; refunds are an explicit provider operation with their own identity.
8. Approach C (outbox) becomes the target architecture.

---

## 12. `orderVersion` design contract (proposal only — not implemented)

`orderVersion` was **not** added in Phase 2.3. Before any implementation, the owner must approve this contract:

| Aspect | Contract |
|---|---|
| Field | `orderVersion: { type: Number, default: 0, min: 0 }` on `Order` |
| Increment | Every successful state-changing order write increments by 1 inside the same update |
| Read | Included in API responses only if explicitly approved; internal use first |
| Mutation | Client may send the version it read (`If-Match` style); the write filter includes `{ _id, orderVersion: expected }` |
| Conflict | Zero matched documents → `409 VERSION_CONFLICT`; caller must re-read |
| Backfill | Required migration for existing orders; reads must tolerate a missing field (`$ifNull: ["$orderVersion", 0]`) |
| Scope | Protects multi-write flows (item cancel + derived status, edit + reconcile) from lost updates |
| Limits | Does not make payment and inventory atomic; does not replace conditional stock filters or idempotency keys |
| Rollback | Field is additive and readable by V1; removing enforcement restores prior behavior |
| Approval | Not approved; no code or schema change made |

`inventoryMode` was also not added. No `TRACKED`/`UNTRACKED`/`EXTERNAL` policy change is proposed here.

---

## 13. Open decisions for the owner

1. Approve **B + D** as the near-term model; approve C as the strategic target.
2. Approve or reject a recovery collection/lease schema (requires migration).
3. Define the acceptable “PAID without deduction” window and alert route.
4. Decide whether such a state blocks reporting, requires manager review, or is auto-reconciled when evidence is conclusive.
5. Decide whether `updatePayment` may overwrite the method of an already-PAID order.
6. Approve the `orderVersion` backfill plan before implementation.
7. Decide the fate of `scripts/clean-order-history.js`.
