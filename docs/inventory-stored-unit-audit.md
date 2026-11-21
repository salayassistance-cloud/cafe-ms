# BONO Inventory — Phase 2, Step 4: Read-Only Stored-Unit Audit

Status: **BLOCKED BEFORE QUERY — NO DATABASE CONNECTION WAS MADE.**

- Branch: `main`
- HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
- Audit date: 2026-11-15
- Files created: `docs/inventory-stored-unit-audit.md` only
- Files modified: none
- Queries executed: **0**
- Records read: **0**

The owner approved read-only distinct-unit queries against an explicitly
identified development/test database. This audit could not satisfy the
precondition "explicitly identified" without reading secrets, so it stopped
before connecting, as the safety rules require. Section 7 states exactly what is
missing.

---

## 1. Database target classification

**Result: NOT IDENTIFIED — no approved development/test target exists in
documented configuration.**

Evidence gathered without reading `.env`, `.env.local`, or any credential file:

| Check | Method | Result |
|---|---|---|
| Application database | `README.md:52` (documented, no secret) | `MONGODB_URI` → `hotel_management` on Atlas. This is the **production** store; out of scope. |
| Documented disposable POS test DB | `docs/production-readiness/wp-04-test-and-acceptance-plan.md:225-250`, `phase-2-5-test-and-acceptance-plan.md:145` | `POS_PHASE25_TEST_MONGODB_URI=mongodb://127.0.0.1:27019/bono_pos_phase25_<unique>?directConnection=true`. Name is a **per-run placeholder**, not a fixed target. |
| Documented disposable Hotel test DB | `docs/hotel-foundation.md:1106,1170,1184` | `HOTEL_TEST_MONGODB_URI=mongodb://127.0.0.1:27018/bono_hotel`, harness-scoped, Hotel-only. |
| Test-harness isolation rule | `wp-04-test-and-acceptance-plan.md:29`, `wp-04-02-isolated-integration-test-plan.md:133` | Harness must **never** use `MONGODB_URI`, `MONGO_URI`, or `ROOM_MONGODB_URI`. |
| Local listeners | `Get-NetTCPConnection` (reachability only) | `mongod` listening on `127.0.0.1:27017` and `127.0.0.1:27018`; **nothing** on `27019`. |
| Local listener status | `g-pay-1-staging-acceptance-report.md:17,58`; `staging-readiness-report.md:107` | These listeners are explicitly **not approved**, were never contacted by prior audits, and "may contain non-disposable data". |
| Harness env vars present in this process | `Test-Path Env:` (presence boolean only, no values printed) | `POS_PHASE25_TEST_MONGODB_URI`, `POS_PHASE23_TEST_MONGODB_URI`, `HOTEL_TEST_MONGODB_URI`, `MONGODB_URI`, `MONGO_URI`, `ROOM_MONGODB_URI`, `POS_PHASE25_INTEGRATION_TESTS` — **all absent**. |

Why this blocks the audit:

1. The only database known to contain the application's inventory records is
   `hotel_management` (production). Querying it is forbidden by this task's own
   authorization.
2. The documented disposable targets are (a) addressable only through a
   placeholder `<unique>` name, (b) not running on `27019`, and (c) empty by
   construction — populating them requires writes and record creation, both
   explicitly forbidden.
3. The two reachable local `mongod` instances have **no documented database
   name**. Selecting one would be guessing a target, also forbidden.
4. The remaining route — reading `MONGODB_URI`/`CAFEDB_URI` from `.env.local` —
   is explicitly forbidden and would expose a connection string.

`.env.example` and `.env.local` were **not opened**. Their names were only seen
in a directory listing.

---

## 2. Collections and verified field paths

Verified by reading the schema definitions (not assumed from Mongoose
pluralization). Every model registers an explicit collection name.

| Model | Model function | Collection (explicit) | Unit-bearing field paths |
|---|---|---|---|
| `InventoryItem` | `lib/models/InventoryItem.js:35-40` | `inventoryitems` | `unit` (root, required, trimmed) |
| `Recipe` | `lib/models/Recipe.js:37-42` | `recipes` | `ingredients[].unit` (required, trimmed) |
| `StockMovement` | `lib/models/StockMovement.js:85-90` | `stockmovements` | `unit` (root, nullable, default `null`) |
| `InventoryAudit` | `lib/models/InventoryAudit.js:67-72` | `inventoryaudits` | `unit` (root, nullable, default `null`) |
| `InventoryReservation` | `lib/models/InventoryReservation.js:175-180` | `inventoryreservations` | `items[].unit` (required), `approval.shortages[].unit` (required), `voids[].items[].unit` (default `""`) |
| `Order` | `lib/models/Order.js` (`connection.model("Order", OrderSchema, "orders")`) | `orders` | `items[].components[].stockUnit` (nullable, trimmed, ≤ 20 chars) |

Additional unit-shaped storage worth noting (not a first-class field):

- `inventoryaudits.beforeSnapshot` and `inventoryaudits.afterSnapshot` are
  `Mixed`. If a snapshot embeds an item document, it can contain a nested `unit`.
  The Step 2 code path (`inventoryAuditService.js:232`) copies `data.unit` into
  the audit root field, but legacy snapshots are not constrained by the schema.
  Any audit must therefore treat these two Mixed paths as *possible* unit
  carriers and report them separately rather than counting them as a unit field.

Relevant write-path semantics already verified in Step 2 (unchanged):

- `InventoryItem.unit` and recipe units are free text with no enum.
- `StockMovement.unit` and `InventoryAudit.unit` are nullable.
- `InventoryReservation.voids[].items[].unit` defaults to `""`.
- Receive can persist a caller-cased unit (`inventoryReceiveService.js:129`).
- Recipe/inventory and order/inventory comparisons are trimmed, lowercased text
  equality with no conversion.

---

## 3. Exact raw unit values and counts

**NOT MEASURED.** No query was issued, so there are no observed values, no
frequencies, and no raw-value variants to report. This section is intentionally
empty rather than populated with guesses.

---

## 4. Null, missing, empty, and whitespace-only counts

**NOT MEASURED** for the same reason.

The planned measurement (to be run only against an approved target) is:

| Metric | Definition |
|---|---|
| Distinct raw value | exact stored string, case and whitespace preserved |
| Frequency | document/array-element count per distinct raw value |
| Null | `$type` is `null` |
| Missing | field path absent from the document |
| Empty string | `""` |
| Whitespace-only | non-empty, but `trim()` is `""` |
| Non-string stored value | `$type` not `string` and not `null` (schema drift signal) |

Case and whitespace variants (`kg`, `KG`, ` Kg `) are counted as **separate raw
values**; no normalization is applied during measurement.

---

## 5. Classification against current adapter policy

No observed values exist to classify. The policy below is the one that will be
applied, and it is already implemented and tested in
`lib/inventoryUnitAdapter.js`.

| Class | Rule | Adapter behaviour |
|---|---|---|
| `CANONICAL` | `g`, `ml`, `pcs` | accepted; `scaled` unchanged |
| `EXACTLY MAPPABLE` | alias with an exact power-of-ten factor: `kg`/`kilogram`/`kgs` → g ×1000; `L`/`litre`/`liter` → ml ×1000; `gram(s)` → g ×1; `pc`/`piece`/`pieces`/`each`/`ea` → pcs ×1; matching is trim + case-insensitive | accepted; quantity converted exactly, originals preserved |
| `UNKNOWN_UNIT` | `oz`, `lb`, `gm`, `tbsp`, `tsp`, `dozen`, punctuation/spacing variants | rejected, fail closed |
| `AMBIGUOUS_UNIT` | `bottle`, `can`, `pack`, `packet`, `box`, `bag`, `tin`, `jar`, `sachet`, `tray`, `loaf`, `bunch`, `head`, `clove`, `slice`, `cup`, `shot`, `dash`, `pinch`, `unit`, `item` (+ tested plurals) | rejected before alias lookup |
| `MISSING_OR_NULL` | `null`, absent, `""`, whitespace-only | rejected |

Note: `bottle`/`can` are accepted as `pcs` by `lib/inventoryUnits.js` itself, but
the adapter rejects them. Any stored instance would therefore be reported as
`AMBIGUOUS_UNIT`, not silently approved.

---

## 6. Unsupported and ambiguous values requiring owner decisions

No stored occurrences have been observed, so none of these is currently known to
exist in data. They are the decisions that would be required **if** the audit
finds them:

1. `oz` — mass ounce vs fluid ounce. The adapter deliberately refuses to decide.
2. `lb`, `gm` — non-power-of-ten mass conversions; a policy and representation
   decision is needed before any mapping.
3. `tbsp`, `tsp`, `cup` — non-metric volume; `cup` is additionally ambiguous
   between a volume measure and a vessel.
4. `dozen` — fixed count of 12 but unsupported.
5. Container/portion nouns (`bottle`, `can`, `pack`, `packet`, `box`, `bag`,
   `tin`, `jar`, `sachet`, `tray`, `loaf`, `bunch`, `head`, `clove`, `slice`,
   `shot`, `dash`, `pinch`, `unit`, `item`) — no dimension can be established
   from repository evidence.

No alias was added, removed, or reinterpreted to resolve any of these.

---

## 7. Data coverage limitations and query failures

| Limitation | Detail |
|---|---|
| No approved target | No documented development/test database with inventory data exists. |
| Production excluded | The only known data store is Atlas `hotel_management` (production). |
| No local target name | `mongod` runs on 27017/27018, but no database name is documented for them, and prior reports classify them as non-disposable. |
| Disposable target unavailable | Documented prefix `bono_pos_phase25_` requires a unique name, a live 27019 instance (none), and seeding writes (forbidden). |
| Harness env absent | All test/harness URI variables are unset in this process. |
| Query failures | None — no query was attempted. |
| Sample inspection | Not performed. |

**Exactly what target information is missing** (any one of these unblocks the
audit):

1. A database name/URI for an approved **development or test** database that
   already contains a copy or representative sample of the POS inventory data,
   supplied through a channel that does not expose credentials in this session
   (for example, a pre-set env var such as `INVENTORY_AUDIT_MONGODB_URI` that the
   operator configures, referenced by name only).
2. Explicit owner confirmation that a specific local database on
   `127.0.0.1:27017` or `127.0.0.1:27018` is a disposable/approved test copy,
   naming the database exactly.
3. Or a separate written authorization to run this read-only aggregation against
   production `hotel_management` (not granted by the current instruction and not
   assumed here).

---

## 8. Compatibility assessment

**Cannot be concluded.** Compatibility depends on the stored values, and none
were measured.

What can be stated from the already-completed Step 3 tests:

- The adapter handles `g`, `ml`, `pcs` without change.
- It handles `kg`/`L` and their documented aliases with exact conversion and
  preserves the original V1 values.
- It fails closed on unknown, ambiguous, and missing units.
- It rejects cross-dimension conversion, negative quantities, and unsupported
  precision.

Therefore the adapter is **policy-complete but data-unverified**. It will be
compatible only if the observed vocabulary is a subset of the canonical and
exactly-mappable classes. If any stored `oz`/`lb`/`bottle`/`pack`/`unit`-style
value exists, that value cannot be adapted and needs an owner decision first.

---

## 9. Recommended next step (not implemented)

1. Owner provides one of the target authorizations in section 7, by name only —
   no connection string in chat.
2. Re-run this audit as a strictly read-only, bounded aggregation with:
   - `$match` on the collection only, then `$project` of the single unit path;
   - `$group` by the **exact raw** value with `$sum: 1`;
   - a parallel pass for null / missing / empty / whitespace-only / non-string;
   - `maxTimeMS: 5000`, `allowDiskUse: false`, no `$out`, no `$merge`;
   - at most 5 sampled documents per collection, projected to the unit field
     only (no names, ids, or business data);
   - read-only credentials where available.
3. Populate sections 3–6 of this report with measured values and classify each
   against section 5.
4. Only then decide whether the adapter covers all observed values.
5. Do **not** wire the adapter into reservation, deduction, order, payment, or
   waste paths until that decision is recorded.

Proposed operation sketch (not executed):

```
db.inventoryitems.aggregate([
  { $group: { _id: "$unit", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
], { maxTimeMS: 5000, allowDiskUse: false })
```

The same shape applies to `recipes` (`$unwind: "$ingredients"`),
`inventoryreservations` (`$unwind: "$items"`), `stockmovements`,
`inventoryaudits`, and `orders` (`$unwind: "$items"`, `$unwind:
"$items.components"`, group on `$items.components.stockUnit`).

---

## 10. Safety and verification

| Requirement | Status |
|---|---|
| No production/staging connection | Confirmed — zero connections of any kind were opened. |
| No secret/credential access | Confirmed — `.env`/`.env.local` never opened; no URI printed. Only env-var **presence** booleans were checked. |
| No guessed target | Confirmed — no database name was assumed or reused. |
| Read-only permissions | Not applicable — no query ran. |
| Bounded/projected/`maxTimeMS` queries | Not applicable — no query ran. |
| No writes/updates/deletes/inserts/transactions | Confirmed — no database client was instantiated. |
| No migrations or index operations | Confirmed. |
| No test records created | Confirmed. |
| No application/test/config changes | Confirmed — the report is the only new file. |
| No POS/inventory/payment/Hotel/Kitchen/Barista/Jebena/recovery behaviour change | Confirmed — no runtime code touched or imported. |
| Git state | No add/commit/stash/reset/clean/checkout/push. Baseline preserved: 61 modified entries unchanged; untracked 94 → 95 (this report only). |

Stop point: this report records a blocked audit. No adapter wiring, no
reservation/deduction/order/payment change, and no database access occurred.
