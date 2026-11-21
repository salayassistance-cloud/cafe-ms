# BONO Inventory — Phase 2, Step 5: Offline V1 Unit-Integration Readiness Audit

Status: **OFFLINE SOURCE AUDIT ONLY — NO DATABASE ACCESS, NO RUNTIME WIRING.**

- Branch: `main`
- HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
- Audit date: 2026-11-15
- Files created: `docs/inventory-v1-unit-integration-readiness.md` only
- Files modified: none
- Database connections / queries: **0**
- Runtime imports of `lib/inventoryUnitAdapter.js`: **0**
- Test suites run unchanged: 58 + 48 + 204 = **310 passing, 0 failing**
- ESLint on inspected source: **exit 0**

Step 4 could not identify an approved development/test database, so everything
below is derived from source code and existing tests. **No claim in this report
depends on actual stored unit values.** Sections 9 and 10 separate what is
provable offline from what still needs data or an owner decision.

---

## 1. Current V1 unit-flow architecture

### 1.1 The two unit authorities

V1 has two independent, free-text unit vocabularies:

| Side | Field | Meaning |
|---|---|---|
| Demand | `recipes.ingredients[].unit`, `orders.items[].components[].stockUnit` | "unit the ingredient/component is written in" |
| Supply | `inventoryitems.unit` | "unit the stock ledger is denominated in" |

V1 never reconciles them arithmetically. It only asks: *is the text the same
after `trim().toLowerCase()`?* If yes, the raw numbers are subtracted. If no,
the requirement is dropped with a warning.

`lib/inventoryReservationRules.js:18-26`:

```js
export function normalizeUnit(value) {
  return String(value || "").trim().toLowerCase();
}
export function sameUnit(a, b) {
  const ua = normalizeUnit(a);
  const ub = normalizeUnit(b);
  return !!ua && ua === ub;
}
```

Consequences that define the whole integration problem:

1. **There is no conversion anywhere in V1.** `1 kg` of a `g`-stocked item is
   not 1000 g; it is a mismatch.
2. **A mismatch is a silent skip, not a rejection.** The order is still created,
   still enters preparation, still gets paid. Only that inventory item is left
   out of the reservation and out of the deduction.
3. **Nothing is normalized in storage.** `InventoryItem.unit`, recipe units,
   `StockMovement.unit`, and `InventoryAudit.unit` keep the caller's casing and
   trimming (receive writes the caller-cased label).
4. **Quantities are rounded to 3 decimals**, repeatedly, via `round3`
   (`inventoryReservationRules.js:12-16`). The exact-arithmetic adapter operates
   at 1e-6, so V1's 3-decimal storage is a real representability limit (see §4.4).

### 1.2 Unit carriers (verified schema → collection mapping)

| Model | File | Collection | Unit field | Constraint |
|---|---|---|---|---|
| `InventoryItem` | `lib/models/InventoryItem.js:35-40` | `inventoryitems` | `unit` (line 10) | required, trimmed, **no enum** |
| `Recipe` | `lib/models/Recipe.js:37-42` | `recipes` | `ingredients[].unit` (line 14) | required, trimmed, **no enum** |
| `StockMovement` | `lib/models/StockMovement.js:85-90` | `stockmovements` | `unit` (line 44) | nullable, default `null` |
| `InventoryAudit` | `lib/models/InventoryAudit.js:67-72` | `inventoryaudits` | `unit` (line 39) | nullable, default `null` |
| `InventoryReservation` | `lib/models/InventoryReservation.js:175-180` | `inventoryreservations` | `items[].unit` (40), `approval.shortages[].unit` (57), `voids[].items[].unit` (89) | required/required/default `""` |
| `Order` | `lib/models/Order.js` (`model("Order", …, "orders")`) | `orders` | `items[].components[].stockUnit` (41) | nullable, trimmed |

Mixed-type caveat: `inventoryaudits.beforeSnapshot` / `afterSnapshot` are
`Mixed`; any embedded item document may carry an unvalidated nested `unit`.

### 1.3 Who reads and writes each unit

| Unit field | Written by | Read by |
|---|---|---|
| `inventoryitems.unit` | inventory item create/update routes (`app/api/inventory/items/**`), seeded data | `validateRequirements` (unit authority), `createOrder` cost check, approval queue, item UI |
| `recipes.ingredients[].unit` | recipe create/update routes, seeded data | `prepareInventoryDeduction`, `calculateDeductionFromRecipes`, recipe UI |
| `orders.items[].components[].stockUnit` | `normalizeComponent` (`orderService.js:181-188`), `editOrderItems` (copies existing components) | `prepareInventoryDeduction`, `calculateDeductionFromRecipes`, `createOrder` cost check, `toKdsShape` |
| `StockMovement.unit` | receive (`inventoryReceiveService.js:162`), legacy executor (`inventoryDeductionService.js:305`), reservation consumption (`inventoryReservationService.js:1289`) | reporting/analytics, movement API serializer |
| `InventoryAudit.unit` | receive (`inventoryReceiveService.js:189`), item create/update audit | audit API, manager inventory views |
| `InventoryReservation.items[].unit` | reservation/reconcile/approve/consume | reconciliation, approval queue, void snapshot, serializers |
| `approval.shortages[].unit` | approval only | approval queue, manager decision evidence |
| `voids[].items[].unit` | `appendPostPreparationVoid` | cancellation evidence, manager reporting |

Notable gaps already present in V1 (relevant to any conversion work):

- **Waste writes no unit at all.** `createWasteMovement`
  (`lib/inventoryWasteService.js:110-122`) inserts a `StockMovement` with
  `{item, type:"OUT", quantity, reason:"Waste", notes, createdBy}` and no `unit`,
  so `stockmovements.unit` is `null`. The `InventoryAudit` written at
  `:128-142` also omits `unit`.
- **Sale consumption writes no `InventoryAudit` at all.** It writes only
  `StockMovement` (`inventoryReservationService.js:1285-1297`).
- **The legacy executor never compares units.** `executeInventoryDeduction`
  selects `cost unit` (`inventoryDeductionService.js:278-282`) but only builds a
  cost map (line 283); the `unit` is unused. It then decrements `currentStock`
  by the plan's raw `quantity` (line 295) and writes the plan's `unit`
  (line 305). If it were ever called with a plan whose unit differs from the
  item's unit, it would subtract `1` kg from a `g`-denominated stock. It is
  currently **not called from runtime code** (see §2.7).

---

## 2. Exact source locations and call chains

All functions below are the *live* V1 path. `lib/inventory-v2/server/*` files
mention these symbols only inside registry/ownership metadata
(`ownership.js:166-243`, `orderMutationInventory.js:98-225`), not as callers.

### 2.1 Order creation → reservation (the primary chain)

```
app/api/orders/route.js:3
  └─ createOrder(...)                              lib/orderService.js:262-448
       ├─ normalizeItem / normalizeItemComponents   lib/orderService.js:80-106
       ├─ normalizeComponent                       lib/orderService.js:109-208
       │    ├─ stockQuantity parse                 :172-180
       │    ├─ stockUnit parse/trim/20-char cap    :181-188
       │    └─ stockQuantity-without-unit reject   :186-188
       ├─ resolveCatalogLine                       :215-231
       ├─ component cost/unit gate                 :350-394
       │    └─ unit mismatch ⇒ costSnapshot=null   :367-373  (SILENT SKIP)
       └─ runInventoryHook("reservation create")   :444-446
            └─ ensureOrderInventoryReservation     lib/inventoryReservationService.js:326-452
                 ├─ calculateRawRequirements       :168-180
                 │    └─ prepareInventoryDeduction lib/inventoryDeductionService.js:20-213
                 │         ├─ recipe aggregation   :96-145
                 │         └─ component aggregation:147-198
                 ├─ validateRequirements           :185-222
                 │    ├─ read item unit            :208
                 │    ├─ sameUnit test             :209
                 │    └─ mismatch ⇒ warning+skip   :210-213
                 ├─ planCoverage                   lib/inventoryReservationRules.js:41-51
                 ├─ conditional $inc reservedStock :396-423
                 └─ Reservation.create             :428-442
```

Unit-touching lines in this chain:

| Step | Location | Behavior |
|---|---|---|
| Requirement unit origin (recipe) | `inventoryDeductionService.js:122` | `String(ing.unit \|\| "").trim()` |
| Empty unit dropped | `inventoryDeductionService.js:123-126` | warning, no requirement |
| Requirement unit origin (component) | `inventoryDeductionService.js:177` | `String(comp.stockUnit \|\| "").trim()` |
| Aggregation bucketing | `inventoryDeductionService.js:130-143`, `184-196` | same item + **case-sensitive** unit merge; otherwise key `id::unit` |
| Requirement trim only | `inventoryReservationService.js:175` | `.trim()` — **case preserved** |
| Positive-quantity filter | `inventoryReservationService.js:178` | drops empty unit / non-positive qty |
| Stock-unit read | `inventoryReservationService.js:192-196` | `.select("_id name unit currentStock reservedStock cost")` |
| Mismatch policy | `inventoryReservationService.js:209-213` | warn + `continue` (item excluded, others proceed) |
| Stored reservation unit | `inventoryReservationService.js:217` | `invUnit \|\| req.unit` → **stock unit wins** |
| Hold quantity | `:380-393`, `:396-423` | raw numbers, `round3` |

### 2.2 Reconciliation (edits, line cancels, gate self-heal)

```
reconcileOrderInventory                          lib/inventoryReservationService.js:456-643
  ├─ ensure… if missing                          :460
  ├─ CONSUMED/RELEASED short-circuit             :462
  ├─ calculateRawRequirements + validate         :464-465
  ├─ newRequirementFp                            :466
  ├─ fast no-op on equal fingerprint             :469-476
  └─ transaction                                 :478-635
       ├─ re-validate live                       :486
       ├─ target map / preserved approved hold   :494-510
       ├─ removed items released                 :512-524
       ├─ conditional hold delta                 :528-583
       ├─ finalItems (unit = live unit)          :587-603
       ├─ status derivation                      :605-615
       └─ $set items/fingerprints/approval       :619-633
```

Call sites: `orderService.js:1556` (line cancel, not consumed),
`orderService.js:1757` (`editOrderItems`), plus internal self-heals at
`inventoryReservationService.js:672, 776, 812, 822`.

### 2.3 Pre-preparation gate and consumption (Kitchen / Barista / Jebena)

```
updateOrderStatus(...)                           lib/orderService.js:480-…
  ├─ station classification (FOOD/DRINK/HOT_DRINK):493-538
  └─ if status === "PREPARING"                   :544-563
       ├─ assertOrderInventoryReady               lib/inventoryReservationService.js:646-713
       └─ consumeOrderInventory                   :1174-1376
```

`assertOrderInventoryReady`:

| Line | Behavior |
|---|---|
| 663-665 | already-consumed order short-circuits (mixed-station second start) |
| 668-670 | recompute requirements + fingerprint |
| 671-680 | fingerprint drift ⇒ reconcile, else `RESERVATION_CONFLICT` |
| 682-695 | `APPROVAL_REQUIRED` ⇒ `MANAGER_APPROVAL_REQUIRED` (block) |
| 696-711 | `RELEASED`/`CONSUMED`/unknown status ⇒ block |

`consumeOrderInventory`:

| Line | Behavior |
|---|---|
| 1177-1194 | missing reservation ⇒ legacy SaleDeduction probe ⇒ ensure |
| 1197-1210 | `consumptionPlan` idempotency short-circuits |
| 1212-1216 | fresh requirements map (`currentRequired`) |
| 1221-1243 | atomic `CONSUMING` claim (exactly-once) |
| 1247-1251 | load items by reservation ids |
| 1258-1265 | `consumeQty = max(0, min(reserved, required, physical, held))` — **all four in stock unit** |
| 1268-1283 | conditional `$inc { currentStock: -q, reservedStock: -q }` |
| 1285-1297 | StockMovement `unit: it.unit`, `idempotencyKey: sale:{orderId}:{invId}` |
| 1298-1320 | unused hold released |
| 1322-1331 | `consumedQuantity` accumulation |
| 1338-1355 | `CONSUMED` finalize |

Station roles converge here: `isKitchen`/`isBarista`/`isHotDrink` only choose
which station field flips (`orderService.js:493-496, 598-609`). Jebena Buna is
`HOT_DRINK` (`:515`) and uses the identical inventory gate. Therefore unit
behavior is **station-independent**.

### 2.4 Manager shortage approval

```
approveInventoryShortage                         lib/inventoryReservationService.js:717-977
  ├─ identity/reason/fingerprint validation      :722-741
  ├─ ensure if missing                           :744-746
  ├─ status contract                             :748-768
  ├─ recompute + fingerprint compare             :770-785
  ├─ preview items (unit = validated unit)       :788-807
  ├─ previewFp / stale handling                  :808-835
  └─ transaction                                 :837-974
       ├─ fingerprint re-check                   :847-856
       ├─ re-validate live                       :858
       ├─ hold delta                             :863-928
       ├─ shortage snapshot (unit from item)     :931-939
       └─ APPROVED / RESERVED                   :945-965
```

API entry: `app/api/orders/[id]/inventory-approval/route.js:6,113`.
Read-only queue: `getInventoryApprovalQueue`
(`inventoryReservationService.js:1379-1431`), API
`app/api/manager/inventory-approvals/route.js:2`.

### 2.5 Payment path (idempotent fallback)

```
payOrder                                          lib/orderService.js:1083-1241
  └─ applyPaidInventory                           :1007-1045
       ├─ consumeOrderInventory(trigger:"PAYMENT") :1009
       └─ on failure: isOrderInventoryConsumed     :1021-1023
            └─ release only if nothing consumed   :1024-1028
confirmPayment                                    :1826-…
  └─ applyPaidInventory                           :1865
submitPaymentForVerification                      :1764-…
  └─ no inventory call (PAYMENT_PENDING only)
```

Payment is never blocked by inventory. `applyPaidInventory` logs failures and
returns (`:1010-1044`). No unit value is written on the payment path except
through the shared consumption movement.

### 2.6 Cancellation, archive, void, waste

```
archiveOrder                    orderService.js:1246-1277  → release(recordVoid:false)
cancelOrderByWaiter             :1285-1324                 → release (ORDER)
cancelOrder                     :1330-1370                 → release (ORDER)
cancelOrderItem                 :1375-1593
  └─ syncInventoryAfterLineChange                          :1522-1558
       ├─ consumed + all lines cancelled → release(ORDER)  :1527-1534
       ├─ consumed + partial line        → recordPostPreparationVoid(LINE) :1536-1544
       ├─ not consumed + all cancelled   → release          :1546-1554
       └─ not consumed + partial         → reconcile        :1555-1557
releaseOrderInventory           inventoryReservationService.js:1073-1151
  ├─ releasePlan                inventoryReservationRules.js:70-86
  ├─ VOID_CONSUMED → appendPostPreparationVoid              :1095-1103
  ├─ hold release ($max 0)                                  :1107-1131
  └─ status RELEASED, items.reservedQuantity=0              :1134-1149
appendPostPreparationVoid       :995-1066
  ├─ voidItems: {unit: it.unit || ""}                       :1014-1023
  ├─ $push voids (dedup by line/order)                      :1032-1050
  └─ whole-order: SaleDeduction → Waste (unit untouched)    :1057-1063
recordPostPreparationVoid       :1156-1167
```

Waste (manual, not order-linked): `lib/inventoryWasteService.js:6-…`, movement
at `:110-122` with **no `unit`** → stored `null`.

Receive: `inventoryReceiveService.js:125-129` compares supplied unit to item
unit with `trim().toLowerCase()` and **throws** `ReceiveServiceError` on
mismatch (`:127`) — the only place in V1 where a unit mismatch hard-fails. It
then persists `movementUnit` (caller casing) into `StockMovement.unit` (`:162`)
and `InventoryAudit.unit` (`:189`).

### 2.7 Legacy deduction executor (not wired)

`executeInventoryDeduction` (`inventoryDeductionService.js:217-336`) has **no
runtime caller**. Grep over `lib/`, `app/`, `scripts/` finds only its definition
and the registry entry in `ownership.js:233-243`. Its only guard is
`refOrderId + reason:"SaleDeduction"` (`:248-255`); it does not validate units.

The pure helper `calculateDeductionFromRecipes` (`:341-399`) is used only by
tests; it buckets by `String(ing.unit)` **without trimming** (`:360`), so it can
diverge from `prepareInventoryDeduction`, which trims.

### 2.8 Fingerprints include the unit

```
buildRequirementFingerprint                      inventoryReservationRules.js:98-110
  row = id : normalizeUnit(unit) : qty.toFixed(3)     :102-107
buildShortageFingerprint                         :112-132
  row = id : normalizeUnit(unit) : required : available : shortage   :116-125
```

Both hash the **normalized unit label** plus 3-decimal quantities. Any change to
either the label or the quantity invalidates a stored
`requirementFingerprint` / `shortageFingerprint`, which is exactly what
`reconcileOrderInventory` and `approveInventoryShortage` use to detect drift.

### 2.9 Current mismatch behavior, summarized

| Location | Trigger | Behavior | Inventory effect |
|---|---|---|---|
| `inventoryReservationService.js:209-213` | recipe/component unit ≠ item unit | `warnings.push`, `continue` | item **not reserved**, no shortage recorded |
| `orderService.js:367-373` | component `stockUnit` ≠ item unit | `costSnapshot=null`, `totalCost=null` | no cost; deduction also later dropped by validation |
| `inventoryDeductionService.js:132-143` | two ingredients, same item, different unit text | separate bucket `id::unit` | two requirements for one item |
| `inventoryReceiveService.js:125-128` | supplied receive unit ≠ item unit | **throw 400** | no movement written |
| `inventoryWasteService.js` | n/a (no unit accepted) | unit stored `null` | no unit evidence |

No path *rejects the order* for a unit mismatch. Nothing warns the waiter. The
warnings live only on the reservation document and the hook log.

---

## 3. Adapter integration boundary recommendation

### 3.1 Recommended boundary: `validateRequirements`

**Convert exactly once, inside `validateRequirements`
(`lib/inventoryReservationService.js:185-222`), from the requirement's source
unit to the `InventoryItem` unit that the same function already reads at
line 208.**

Why this is the correct choke point:

1. It is the **only** function in V1 where both units are simultaneously
   available: `req.unit` (demand) and `doc.unit` (supply). No other boundary has
   both without a second read.
2. It is already the **policy owner** for unit mismatch (`:209-213`). Replacing
   "warn + skip" with "try exact conversion; if exact, accept; else warn + skip"
   is an in-place policy change, not a new subsystem.
3. It feeds **all four** lifecycle operations: `ensureOrderInventoryReservation`
   (`:335, 350`), `reconcileOrderInventory` (`:465, 486`),
   `approveInventoryShortage` (`:771, 858`), `consumeOrderInventory`
   (`:1213`). One change covers create, edit, reject, cancel, prepare, pay.
4. It preserves the existing stored-unit contract: reservation items, approval
   shortages, consumption `StockMovement.unit`, and void items all take
   `it.unit`, which after conversion is the **inventory unit** — the unit
   `currentStock`/`reservedStock` are actually denominated in.
5. It requires **no schema change, no API change, no route change**, and no edit
   to `orderService.js`, payment code, or `prepareInventoryDeduction`.

### 3.2 Boundaries that must NOT convert

| Candidate | Why not |
|---|---|
| `normalizeComponent` (`orderService.js:109-208`) | Only sees components, not recipes; has no `InventoryItem.unit`; would duplicate the rule in a second place; would rewrite persisted `stockUnit`, changing `toKdsShape` output (`:1982`) and the waiter-visible label. |
| `prepareInventoryDeduction` (`inventoryDeductionService.js:20-213`) | Deliberately DB-light and recipe-only; has no item unit; converting here would require a new item read and would change its documented "pure calculation" contract and its output unit vocabulary. |
| `consumeOrderInventory` (`:1174-1376`) | Too late: holds and fingerprints were already written in the mismatched/absent unit. Conversion here would break the `reservedStock` invariant (hold and consumption would disagree). |
| `executeInventoryDeduction` (`:217-336`) | Not in runtime; converting here would double-convert if the plan came from the requirement layer. |
| Route/API layer | Would change API contracts and put unit policy in HTTP handlers. |

### 3.3 Before reservation, before deduction, or both?

**Before reservation — and therefore before every deduction that derives from a
reservation — in one place.**

The key structural fact: `calculateRawRequirements`
(`inventoryReservationService.js:168-180`) calls `prepareInventoryDeduction`
and then feeds its output through `validateRequirements`. Reservation math,
reconciliation, approval, and consumption all consume the *validated* output.
The legacy executor is not called at runtime. So:

- convert once in `validateRequirements`;
- the reservation layer receives stock-unit quantities;
- the deduction/consumption layer receives the same stock-unit quantities
  because it reads `reservation.items[].unit` / `requiredQuantity`;
- **never convert again** downstream.

If the legacy executor is ever wired in the future, it must accept an
already-converted plan (from the same requirement layer), not re-convert. The
plan should carry the stock unit, which it already does via `ingredients[].unit`.

### 3.4 Safe cross-unit quantity comparison

Never compare raw decimal quantities across units. Compare exact canonical
integers:

```
a = adaptV1Quantity(qtyA, unitA)   // { dimension, canonicalUnit, scaled: BigInt }
b = adaptV1Quantity(qtyB, unitB)
safeEqual = a.dimension === b.dimension
          && a.canonicalUnit === b.canonicalUnit
          && a.scaled === b.scaled
```

Rules:

1. Dimension must match first. `g` vs `ml` vs `pcs` are never comparable, even
   if the numeric values are equal.
2. Equality is `scaled` equality, not `Number(qtyA) === Number(qtyB)`.
3. Ordering (`>`/`<`) is valid only within the same dimension and only on
   `scaled`.
4. `planCoverage`, `availableOf`, and the `consumeQty` clamp must continue to
   operate on **plain numbers in one unit** (the stock unit). They must not be
   rewritten to BigInt in this step; the adapter is used to *decide* the
   converted decimal, not to replace the V1 arithmetic engine.

### 3.5 Preserving original source units

The adapter already returns `sourceQuantity` and `sourceUnit` untouched
(`inventoryUnitAdapter.js:231-251`). V1 has **no field** for a source unit on
`InventoryReservation`. The recommended handling:

- **Do not** store the source unit in `Reservation.items[].unit`; that field is
  the stock unit and is used by consumption, voids, and reporting.
- **Do not** add schema fields in this step.
- For observability, emit a bounded warning on conversion, e.g.
  `"Unit converted for inventory item <id>: 1 kg → 1000 g"`, in the existing
  `warnings` array (already capped at 50 at
  `inventoryReservationService.js:336, 435, 625`).
- If durable provenance is required later, the only schema-free home is
  `StockMovement.notes` (string, 500-char cap; written at
  `inventoryReservationService.js:1294`). Changing that note format is an owner
  decision (§9.3), not part of the mechanical conversion.

### 3.6 Missing / null / empty / unknown / ambiguous / unsupported

| Input | Required behavior | Where enforced |
|---|---|---|
| Recipe/component unit missing or empty | no requirement (existing behavior); keep warning | `inventoryDeductionService.js:123-126`, `:178-181`; `inventoryReservationService.js:178` |
| `InventoryItem.unit` missing or empty | fail closed: warning + skip item; never guess | new check in `validateRequirements` |
| Unknown alias (`oz`, `lb`, `gm`, `tbsp`, `tsp`, `dozen`, punctuation) | fail closed: warning + skip | adapter `UNKNOWN_UNIT` |
| Ambiguous container/portion noun (`bottle`, `can`, `pack`, `box`, `cup`, …) | fail closed even though `inventoryUnits.js` maps `bottle`/`can` to `pcs` | adapter `AMBIGUOUS_UNIT` (`inventoryUnitAdapter.js:92-133, 165-176`) |
| Non-string unit | fail closed | adapter `UNKNOWN_UNIT` via `normalizeUnit` |
| Negative / non-finite quantity | already filtered before validation; keep | `inventoryDeductionService.js:118-121` |
| Precision that V1's 3 decimals cannot represent | fail closed (warn + skip) — see §4.4 | new check in `validateRequirements` |

**Fail closed must stay per-item, not per-order.** The existing contract is
explicit: "They do not block unrelated (valid) items"
(`inventoryReservationService.js:182-184`). Throwing would turn a unit problem
into a blocked Kitchen/Barista/Jebena ticket and would violate existing
lifecycle tests.

### 3.7 API-contract impact

None, if conversion happens only in `validateRequirements`:

- `serializeInventoryReservation` / `summarize`
  (`inventoryReservationService.js:236-292`) still returns `unit`.
- Approval queue (`:1379-1431`) still returns stock units and names.
- `toKdsShape` (`orderService.js:1969-…`) still returns the stored
  `components[].stockUnit` (line 1982) — the label the waiter entered is
  **not** rewritten.
- Inventory item/movement/receive/waste APIs are untouched.

The only observable change is **quantity + unit inside reservation documents and
`SaleDeduction` movements for orders that previously mismatched**.

### 3.8 Are the adapter's exported helpers sufficient?

| Helper | Sufficient for this boundary? | Notes |
|---|---|---|
| `adaptV1Quantity(qty, unit)` | **Yes** — the core call | Returns exact `scaled`, dimension, canonical unit, and preserves source |
| `convertAdaptedQuantity(result, targetUnit)` | **Yes** — needed to express the canonical value back in the item's unit | Rejects cross-dimension and lossy results |
| `formatInUnit(scaled, unit)` | Yes for display/round-trip checks | Same lossy guard |
| `toSourceUnitQuantity(result)` | Yes for reverse/display | Uses `approvedUnit`, i.e. the **normalized** spelling, not the original bytes |
| `canAdaptV1Quantity(qty, unit)` | Yes for probing/observability | Swallows the reason; do not use it where the error code must be logged |
| `ADAPTER_ERROR_CODES` / `canonicalUnit` / `scaled` | Yes | Stable codes for warning mapping |

Unsafe assumptions / gaps to handle in the caller (not by editing the adapter):

1. **No "compare two V1 pairs" helper.** The caller must compare `scaled`
   itself after checking `dimension` (§3.4).
2. **Throws on failure.** The caller must wrap each item in `try/catch`; the
   adapter has no batch/partial API.
3. **No V1 rounding policy.** The adapter is exact at 1e-6; V1 immediately calls
   `round3`. The caller must reject values that `round3` would change (§4.4).
4. **`sourceUnit` ≠ guaranteed original bytes in `approvedUnit`.** `KG` becomes
   `kg`, `l` becomes `L`. This is correct normalization but must not be treated
   as byte-preserving provenance.
5. **No double-conversion marker.** Converting an already-converted pair is
   undetectable. The design must convert exactly once at the choke point.
6. **No quantity-vs-unit coupling check.** The adapter converts the quantity and
   the unit together (good), but it cannot know whether the *number* was already
   stored in the target unit. Only the schema/label can tell you that.

---

## 4. Required conversion and validation rules

### 4.1 Authority rule

`InventoryItem.unit` is authoritative for stock. Convert **demand → stock**,
never stock → demand. Rationale: `currentStock`, `reservedStock`, and every
`StockMovement` quantity are already denominated in the item's unit.

### 4.2 No-op rule

If `sameUnit(req.unit, invUnit)` is already true (`inventoryReservationRules.js:22-26`),
**do not call the adapter**. Return the requirement unchanged. This guarantees
byte-identical behavior and identical fingerprints for every order that works
today.

### 4.3 Exactness rule

1. `adapted = adaptV1Quantity(req.requiredQuantity, req.unit)`.
2. If `adapted.dimension !== invDefinition.dimension` → reject
   (`UNIT_DIMENSION_MISMATCH`).
3. `converted = convertAdaptedQuantity(adapted, invUnit)` — the adapter throws
   `LOSSY_CONVERSION` rather than rounding.
4. Use `converted.value` (exact decimal string) → `Number(...)`.
5. Require `round3(convertedNumber) === convertedNumber`; otherwise reject as
   `QUANTITY_PRECISION_UNSUPPORTED` (V1 cannot store it at 3 decimals).

### 4.4 The 3-decimal representability limit (must be explicit)

V1 rounds every requirement at `inventoryReservationService.js:176` and again at
`:218`, and every hold at `inventoryReservationRules.js:41-51`. So the real V1
precision floor is **0.001 in the stock unit**.

Examples with a `kg`-stocked item:

| Demand | Exact conversion | V1-representable? | Decision |
|---|---|---|---|
| `500 g` | `0.5 kg` | yes (3 dp) | convert |
| `1 g` | `0.001 kg` | yes | convert |
| `0.5 g` | `0.0005 kg` | **no** | reject (would round to 1 g — a 2× error) |
| `1000 g` | `1 kg` | yes | convert |
| `1 kg` → `g` item | `1000 g` | yes | convert |

This is why the rule "convert then `round3`" is unsafe. The check must run
**before** the value enters `round3`.

### 4.5 Validation order inside `validateRequirements`

For each requirement, in order:

1. inventory item exists? (existing, `:201-207`)
2. `invUnit` non-empty? (new)
3. `sameUnit(invUnit, req.unit)`? → accept unchanged (existing fast path)
4. else attempt exact adaptation + conversion + 3-dp check → accept with
   `unit: invUnit`, `requiredQuantity: converted`
5. else push a **classified** warning and `continue`

Warning vocabulary (new strings, existing array):

- `UNIT_CONVERSION_UNSUPPORTED: <id> recipe <u1> → inventory <u2> (code)`
- `UNIT_AMBIGUOUS: <id> unit "<u>" has no established dimension`
- `UNIT_MISSING: inventory item <id> has no unit`
- `UNIT_PRECISION_UNSUPPORTED: <id> <qty> <u1> cannot be stored exactly as <u2>`

The existing mismatch string at `:210-213` should be retained as the fallback so
no test or log consumer breaks.

### 4.6 Forbidden conversions

- Label-only conversion (`kg` → `g` with quantity unchanged).
- `g` ↔ `ml` (density inference).
- `pcs` ↔ any mass/volume unit.
- `bottle`/`can` → `pcs` (adapter rejects; do not add an alias).
- `oz` mass-vs-fluid inference.
- Silent rounding to make a value fit.
- Converting `InventoryItem.unit` itself, or rewriting stored
  `stockUnit`/recipe units.

### 4.7 Idempotency of the rule

The rule must be **deterministic and side-effect-free**: same requirement +
same item unit ⇒ same converted quantity and same warnings. It must not consult
time, reservation state, or `currentStock`. Fingerprints then change only when
the physical requirement changes.

---

## 5. Compatibility risks and required regression tests

### 5.1 Risk register

| # | Risk | Mechanism | Severity | Mitigation |
|---|---|---|---|---|
| R1 | **Stored fingerprints change** for orders that previously mismatched (previously skipped item now appears) | `requirementFingerprint` includes id:unit:qty (`rules:98-110`) | High | Reconcile is self-healing (`:456-643`); but **APPROVED** orders become `APPROVAL_STALE` (`:107-131`, `:748-758`) and need re-approval |
| R2 | **In-flight `RESERVED` quantity changes** | converted qty enters `planCoverage` | Medium | Hold delta path (`:528-583`) handles both directions; test both |
| R3 | **Ambiguous/unsupported item newly converts zero or rejects** | previously skipped, still skipped | Low | Warning-only; no reservation change |
| R4 | **Duplicate requirement rows for one item** when recipe units differ only by case (`kg` vs `KG`) | case-sensitive bucketing (`deduction:133, 186`) + lowercase fingerprint normalization | Medium | Conversion normalizes both to the stock unit; this **merges** rows and changes the fingerprint shape. Requires explicit test + owner note |
| R5 | **Double deduction** | two consumers (PREPARING + PAYMENT) | Must not change | Conversion does not touch claim/idempotency keys (`:1296`, `:248`); replay tests must stay green |
| R6 | **`StockMovement` history mixes units over time** | no migration allowed | Medium | Reporting must group by unit (already the case); document that pre-conversion rows keep their original unit |
| R7 | **Void/waste evidence** | void echoes `it.unit` (`:1019`); waste writes `null` | Low | Unit unchanged by conversion; waste remains unitless |
| R8 | **Audit drift** | receive writes caller unit (`receive:189`); consumption writes no audit | Low | Out of scope; do not change |
| R9 | **Payment state** | `applyPaidInventory` never throws (`:1007-1045`) | None expected | Verify `payOrder`/`confirmPayment` suites |
| R10 | **KDS/waiter display** | `toKdsShape` returns stored `stockUnit` (`:1982`) | None expected | Assert unchanged |
| R11 | **V1/V2 shared stock** | `ownership.js` declares V1 writers; V2 must not call them | High if violated | No V2 file changes; ownership tests must stay green |
| R12 | **3-decimal precision** | `round3` at three points | Medium | §4.4 rejection rule + test |

### 5.2 Required regression tests (to be added in the implementation step, not now)

| ID | Test | Asserts |
|---|---|---|
| T1 | `kg` recipe on `g` item | reservation item unit = `g`, required = 1000×, hold applied, movement unit `g` |
| T2 | `g` recipe on `kg` item, exactly representable | reservation unit = `kg`, exact converted qty |
| T3 | `g` recipe on `kg` item, **0.0005 kg** | rejected with precision warning, item omitted, other items still reserved |
| T4 | same-unit order | fingerprint byte-identical to pre-change; no adapter call |
| T5 | unknown unit (`oz`, `gm`, `tbsp`) | warning + skip; order still created; no hold |
| T6 | ambiguous `bottle` / `can` | warning + skip; never `pcs` |
| T7 | missing `InventoryItem.unit` | warning + skip; no crash |
| T8 | component `stockUnit` mismatch | both `createOrder` cost gate (`:368`) and validation agree: no cost, no reservation |
| T9 | case-variant duplicate recipe rows | exactly one requirement per item; deterministic fingerprint |
| T10 | replay `createOrder` hook | one reservation |
| T11 | PREPARING twice (mixed station) | one consumption, second skipped |
| T12 | payment after PREPARING | `skipped`, no second movement |
| T13 | approval replay | same fingerprint ⇒ no-op; changed ⇒ `APPROVAL_STALE` |
| T14 | cancel before preparation | hold released, unit unchanged |
| T15 | cancel after preparation | void recorded, `SaleDeduction` → `Waste`, unit unchanged |
| T16 | waste | `StockMovement.unit` still `null` |
| T17 | `toKdsShape` | `stockUnit` unchanged |
| T18 | adapter property test | convert → reverse is identity or `LOSSY_CONVERSION` |

### 5.3 Existing suites that must remain green (verified now, unchanged)

| Suite | Tests | Result |
|---|---|---|
| `tests/inventory-units-normalization.test.mjs` | 31 | pass |
| `tests/inventory-unit-adapter.test.mjs` | 27 | pass |
| `tests/inventory-reservation-phase1.test.mjs` + `inventory-lifecycle-phase1-1.test.mjs` + `inventory-hook-observability.test.mjs` | 48 | pass |
| `tests/inventory-v2-phase1.test.mjs` + `inventory-v2-phase2.test.mjs` | 204 | pass |

Total: **310 passing, 0 failing.**

### 5.4 Station / role compatibility

| Actor | Entry | Inventory effect |
|---|---|---|
| Waiter | `createOrder`, `editOrderItems`, `cancelOrderByWaiter` | reservation create/reconcile/release — same choke point |
| Kitchen | `updateOrderStatus` role `KITCHEN` | gate + consume once |
| Barista | `updateOrderStatus` role `BARISTA` | gate + consume once (shared order) |
| Jebena Buna | `updateOrderStatus` role `HOT_DRINK` (`orderService.js:515`) | identical gate/consume |
| Manager | approval, cancel, archive | approval snapshot + release/void |
| Hotel | `lib/hotel/*`, `app/api/hotel/**` | **no import** of any V1 inventory/order service (verified by grep) → unaffected |

---

## 6. Stored-data questions still blocked by Step 4

These are the questions that only a read-only audit of real data can answer.
Each is tagged with what it actually decides.

| # | Question | Decides |
|---|---|---|
| Q1 | Distinct raw `inventoryitems.unit` values + counts | Whether conversion is ever exercised; whether any item is non-canonical |
| Q2 | Distinct raw `recipes.ingredients[].unit` values + counts | Whether demand vocabulary ⊂ canonical/exactly-mappable |
| Q3 | Joint distribution (recipe unit ↔ item unit) per inventory item | How many live paths would newly convert; R1/R2 blast radius |
| Q4 | Distinct raw `orders.items[].components[].stockUnit` + counts, and match rate vs item unit | Whether priced-component deductions are currently being dropped |
| Q5 | Distinct `stockmovements.unit` + null/empty counts, by `reason` | History-mixing scale; confirms waste `null` assumption |
| Q6 | Distinct `inventoryaudits.unit` + null counts; `beforeSnapshot`/`afterSnapshot` nested `unit` presence | Audit provenance assumptions |
| Q7 | Distinct `inventoryreservations.items[].unit` + status distribution | How many in-flight `RESERVED`/`APPROVED` rows would be re-fingerprinted |
| Q8 | Count of reservations whose stored `requirementFingerprint` would change under conversion | Exact cutover impact (R1) |
| Q9 | Case/whitespace variants (`KG`, `" kg "`, `G`) | Whether R4 duplicate-row merge is theoretical or real |
| Q10 | Presence/absence of `oz`, `lb`, `gm`, `tbsp`, `tsp`, `cup`, `dozen`, `bottle`, `can`, `pack`, `box`, `unit`, `item` | Whether owner policy decisions (§9.3) block go-live |
| Q11 | Any non-string stored unit (`$type` ≠ string/null) | Schema-drift handling |
| Q12 | Distinct recipe units where the same menu item has two recipes with different units | Additional bucketing/precision cases |

**Q1–Q3 and Q8 are decision-blocking. Q4–Q7 and Q9–Q12 size the risk.**

Step 4 recorded: 0 queries, 0 records, because no approved non-production target
could be identified without reading secrets (`docs/inventory-stored-unit-audit.md`).
Nothing in this report assumes any particular answer to Q1–Q12.

---

## 7. Narrowly scoped proposed implementation plan (not executed)

**Precondition: §8 STOP conditions cleared and §9.3 owner decisions recorded.**

| Step | Change | Files | Guardrails |
|---|---|---|---|
| 6A | Add a pure helper that wraps the adapter for one V1 requirement: `convertRequirementQuantity({quantity, unit}, inventoryUnit)` → `{ok:true, quantity, unit, warning}` or `{ok:false, code, warning}`. No DB, no side effects, no V1 rounding inside. | **new** `lib/inventoryRequirementConversion.js` (name to be approved) | Only imports `lib/inventoryUnitAdapter.js`; unit tests only |
| 6B | In `validateRequirements`, replace the mismatch `continue` with: advance adapter attempt → accept converted requirement (stock unit) or classified warning. Keep `sameUnit` fast path first. | `lib/inventoryReservationService.js:200-220` (one function) | No signature change; no new DB read; warnings capped by existing caller |
| 6C | No change to `prepareInventoryDeduction`, `orderService.js`, models, routes, payment, waste, receive, or V2. | — | Enforced by diff review |
| 6D | Add T1–T18 as new tests; run all 310 existing tests unchanged. | **new** `tests/inventory-requirement-conversion.test.mjs` (+ additions to the reservation suite only if the owner allows) | No edits to existing assertions |
| 6E | Observability: map adapter codes into the existing warning strings; optionally one `logEvent("warn", "inventory_unit_converted", …)` per order (existing logger, no new infra). | `inventoryReservationService.js` (same function) | Redact ids? ids are already logged elsewhere |
| 6F | Cutover policy for in-flight reservations: reconcile-on-next-touch (default, no migration) or freeze existing fingerprints until terminal. | **owner decision** | No backfill, no migration |

Explicit non-goals: no schema fields, no index changes, no migration script, no
API change, no UI change, no V2 change, no payment change, no
`executeInventoryDeduction` wiring.

**Rollback:** revert the single `validateRequirements` change and delete the new
helper/test file. No data written by this step, so rollback is code-only. Any
reservation already reconciled under the new rule remains internally consistent
(it was written through the normal transactional path); re-running
`reconcileOrderInventory` after rollback returns it to the old skip behavior.

---

## 8. Explicit STOP conditions before runtime integration

Do not wire, merge, or deploy the adapter if **any** of these is true:

1. **Stored-unit audit incomplete.** Q1–Q3 and Q8 unanswered (§6).
2. **Any observed stored unit is outside {canonical + exactly mappable}** and has
   no recorded owner decision.
3. **Any `bottle`/`can`/container noun exists in data** and someone proposes
   mapping it to `pcs`. The adapter must keep rejecting it.
4. **Any `oz` exists** without a recorded mass-vs-fluid decision.
5. **Any `InventoryItem` has a null/empty/non-string unit.**
6. **Conversion would require changing `round3`, `QTY_EPSILON`, or the 3-decimal
   contract.**
7. **Conversion would require a schema or index change**, including adding a
   source-unit field.
8. **Conversion would require backfilling or rewriting existing reservations,
   movements, or fingerprints.**
9. **In-flight `APPROVED` orders would silently lose their approval** without
   an explicit owner-approved cutover rule (§7 6F).
10. **Any existing test fails**, including the 310 currently green, or the V1/V2
    ownership invariants in `tests/inventory-v2-phase*.test.mjs`.
11. **Any change would be needed in `orderService.js`, payment paths,
    `inventoryWasteService.js`, `inventoryReceiveService.js`, or
    `lib/inventory-v2/**`.**
12. **The legacy `executeInventoryDeduction` would need to be wired** to make
    the change work.
13. **Label-only conversion is proposed anywhere** as a shortcut.
14. **The change cannot be expressed as one function-level edit plus one new
    pure helper file.**

---

## 9. Conclusion classification

### 9.1 Safe offline conclusions (proven from source; no data needed)

| # | Conclusion | Evidence |
|---|---|---|
| S1 | V1 performs no unit conversion; comparison is trimmed, case-insensitive text equality | `inventoryReservationRules.js:18-26` |
| S2 | A unit mismatch drops the item from the reservation with a warning; it never rejects the order | `inventoryReservationService.js:209-213`, `182-184` |
| S3 | A component unit mismatch also nulls cost silently, independently | `orderService.js:367-373` |
| S4 | The first and only point holding both units is `validateRequirements` | `:185-222` |
| S5 | All reservation lifecycle operations flow through that function | `:335, 350, 465, 486, 771, 858, 1213` |
| S6 | Reservation items, approval shortages, consumption movements, and voids all carry the **stock** unit | `:217, 931-939, 1289, 1019` |
| S7 | Consumption quantity is a min over reserved/required/physical/held in one unit, so unit agreement is a precondition | `:1258-1265` |
| S8 | Fingerprints hash normalized unit + 3-dp quantity, so conversion changes them | `rules:98-132` |
| S9 | The legacy executor is not wired and would decrement without checking units | `deduction:217-336`, grep |
| S10 | Waste writes `unit: null`; consumption writes no audit | `waste:110-122`, `reservation:1285-1297` |
| S11 | Adapter rejects `bottle`/`can` despite `inventoryUnits.js` mapping them to `pcs` | `adapter:92-133` vs `units:157-168` |
| S12 | Kitchen, Barista, and Jebena share one gate/consume path; Hotel does not import V1 inventory | `orderService.js:544-563`, hotel grep |
| S13 | Adapter helpers are sufficient for conversion; the caller must add dimension checks, per-item try/catch, and the 3-dp representability rule | `adapter:231-442` |
| S14 | No runtime file imports the adapter today | grep over `lib/`, `app/`, `scripts/` |
| S15 | Case-variant recipe units can create two requirement rows for one item, and the fingerprint ordering then depends on insertion order | `deduction:130-143`, `rules:99-108` |

### 9.2 Conclusions requiring actual stored-unit data

| # | Conclusion | Blocked by |
|---|---|---|
| D1 | Whether conversion will ever execute on real orders | Q1, Q2, Q3 |
| D2 | Whether any unsupported/ambiguous unit exists | Q10 |
| D3 | How many live reservations/reconciliations would change | Q3, Q7, Q8 |
| D4 | How many `APPROVED` orders would go stale | Q7, Q8 |
| D5 | Whether the 3-decimal precision rule rejects real recipes | Q1, Q2, Q12 |
| D6 | Whether R4 case-variant duplicates occur in practice | Q9 |
| D7 | Whether history mixing in `stockmovements.unit` is material | Q5 |
| D8 | Whether audit snapshots carry nested units | Q6 |

### 9.3 Decisions requiring explicit owner approval

| # | Decision | Options |
|---|---|---|
| A1 | Cutover semantics for in-flight reservations | (a) reconcile on next touch (default); (b) freeze fingerprints until terminal; (c) pause ordering during cutover |
| A2 | Whether `APPROVED` shortages may be invalidated by conversion | require re-approval vs. preserve snapshot |
| A3 | `oz` policy | mass ounce, fluid ounce, or unsupported |
| A4 | `lb` / `gm` policy | exact factor? representation? or unsupported |
| A5 | `tbsp` / `tsp` / `cup` / `dozen` policy | unsupported vs. explicit factors |
| A6 | Container nouns (`bottle`, `can`, `pack`, `box`, …) | keep permanently unsupported (recommended) vs. establish a count meaning |
| A7 | Durable source-unit provenance | none (warnings only) vs. `StockMovement.notes` format vs. new additive schema field |
| A8 | Reporting rule for mixed-unit history | group by unit (current) vs. canonicalize at read time |
| A9 | Whether merging case-variant duplicate rows (S15) is acceptable | merge (changes fingerprint) vs. preserve current shape |

---

## 10. Verification and safety record

| Requirement | Status |
|---|---|
| No database connection or query | Confirmed — none was made; no client instantiated |
| No `.env` / `.env.local` access | Confirmed — never opened |
| No production/staging access | Confirmed |
| No migration, index, or data write | Confirmed |
| No runtime adapter wiring | Confirmed — grep finds no importer in `lib/`, `app/`, `scripts/`; tests import it only |
| No reservation/deduction/order/payment change | Confirmed — no file edited |
| No schema change | Confirmed |
| Existing tests run unchanged | `node --test` on the 7 inventory suites: **310 pass / 0 fail** |
| ESLint on inspected source only, no auto-fix | `npx eslint` on the 12 inspected files: **exit 0** |
| Application/test files modified | **None** |
| Git state | No add/commit/stash/reset/clean/checkout/push. Baseline preserved: 61 modified entries; untracked 95 → 96 (this report only) |

Inspected files:

- `lib/inventoryUnits.js`
- `lib/inventoryUnitAdapter.js`
- `lib/inventoryReservationService.js`
- `lib/inventoryReservationRules.js`
- `lib/inventoryDeductionService.js`
- `lib/orderService.js`
- `lib/inventoryReceiveService.js`
- `lib/inventoryWasteService.js`
- `lib/inventoryAuditService.js`
- `lib/models/InventoryItem.js`
- `lib/models/Recipe.js`
- `lib/models/StockMovement.js`
- `lib/models/InventoryAudit.js`
- `lib/models/InventoryReservation.js`
- `lib/models/Order.js`

Stop point: this report only. No adapter wiring, no database access, no change
to reservation, deduction, order, payment, waste, receive, schema, or V2 code.
