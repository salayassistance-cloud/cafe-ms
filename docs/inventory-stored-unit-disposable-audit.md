# Inventory Stored-Unit Audit — Disposable Synthetic Evidence (Step 4)

> **SYNTHETIC / DISPOSABLE — NOT PRODUCTION EVIDENCE.**
> Every number below was measured against a newly created, uniquely named, local-only
> disposable MongoDB database holding only synthetic fixture documents. Nothing here is
> evidence about production, staging, or customer inventory data.
> **The real stored-unit audit remains BLOCKED** until a separately authorized sanitized
> real-data export is supplied. See `docs/inventory-stored-unit-audit.md`.

Status date: 2026-11-15.

## 1. Environment and safety

| Item | Value |
| --- | --- |
| Endpoint (host:port only) | `127.0.0.1:27017` |
| Listener verification | `Get-NetTCPConnection -LocalPort 27017` → bound to `127.0.0.1`, PID 4788 (`mongod`) |
| Auth | local listener accepts unauthenticated connections; no credentials read or printed |
| Remote access | **None.** No Atlas, production, staging, or any remote host was contacted |
| `.env` / secrets | **Not read.** No connection string printed |

Disposable database (created new, verified absent beforehand):

```
bono_unit_audit_disposable_20261115_a1
```

Pre-insert probe (against `admin` only):

```
mongosh --host 127.0.0.1 --port 27017 --quiet --file C:\Users\besud\AppData\Local\Temp\opencode\probe-local-db.js
→ {"reachable":true,"databaseCount":3,"targetExists":false}
```

The probe script checks `listDatabases()` names and nothing else. After the load, the
server holds 4 databases (3 pre-existing + this disposable one). No pre-existing database
was read, written, renamed, or dropped.

### Commands executed

Load + audit (first run):

```
node tests/fixtures/inventory-unit-disposable-audit.mjs --host 127.0.0.1 --port 27017 --db bono_unit_audit_disposable_20261115_a1
```

Re-audit after a runner-analysis correction (strictly read-only, no writes):

```
node tests/fixtures/inventory-unit-disposable-audit.mjs --host 127.0.0.1 --port 27017 --db bono_unit_audit_disposable_20261115_a1 --audit-only
```

### Runner safety guarantees (`tests/fixtures/inventory-unit-disposable-audit.mjs`)

- Refuses any host other than `127.0.0.1` and any port other than `27017`.
- Refuses any database name not matching `bono_unit_audit_disposable_*`.
- Load mode refuses an existing database or a database with any collections.
- `--audit-only` mode performs **only reads**; it verifies every fixture collection
  exists with the exact expected document count before auditing, and refuses otherwise.
- Never drops, renames, or writes to any other database. Never creates indexes
  (`autoIndex: false`; raw collections, no Mongoose models).
- Never reads environment files or credentials; never prints a URI; sanitizes error text.

## 2. Inserted collections and document counts

Fixture source: `tests/fixtures/inventory-unit-disposable-audit.fixture.json`
(synthetic IDs `aa…/bb…/cc…/dd…/ee…/ff…`, category `SYNTH-AUDIT`, order numbers `SYN-…`).

| Collection | Inserted | Verified count |
| --- | ---: | ---: |
| `inventoryitems` | 16 | 16 |
| `recipes` | 8 | 8 |
| `stockmovements` | 12 | 12 |
| `inventoryaudits` | 5 | 5 |
| `orders` | 5 | 5 |
| `inventoryreservations` | 6 | 6 |

Some documents intentionally violate schema requirements (missing/null/empty/whitespace
units) so the audit detects them; this is a fixture feature, not a schema change.

## 3. Raw vs normalized unit distributions

Raw values are preserved exactly (JSON-quoted); normalization (`trim().toLowerCase()`)
is reported separately and never silently applied to the raw record.

### 3.1 `inventoryitems.unit` — 16 items

Missing 1 (field absent), null 1, empty 1, whitespace-only 0.

| Class | Count |
| --- | ---: |
| canonical | 7 (`g`×2, `ml`×2, `pcs`×2, `" g "`→g×1) |
| mapped | 3 (`kg`→g, `KG`→g, `L`→ml) |
| unsupported | 1 (`oz`) |
| ambiguous | 2 (`bottle`, `cup`) |

### 3.2 `recipes.ingredients[].unit` — 32 ingredient rows

Missing 0, null 0, empty 0, whitespace-only 1 (`"   "`).

| Class | Count |
| --- | ---: |
| canonical | 11 |
| mapped | 8 (`kg`×4, `l`×2, `piece`×1, `each`×1) |
| unsupported | 6 (`dozen`×1, `gm`×1, `lb`×1, `oz`×2, `tbsp`×1) |
| ambiguous | 6 (`bag`, `bottle`, `box`, `cup`×2, `pack`) |

### 3.3 `stockmovements.unit` — 12 movements

Missing 1, null 1, empty 1, whitespace-only 1.

| Class | Count |
| --- | ---: |
| canonical | 3 |
| mapped | 3 (`kg`×2, `l`×1) |
| unsupported | 1 (`oz`) |
| ambiguous | 1 (`bottle`) |

### 3.4 `inventoryaudits` (`unit` + `beforeSnapshot.unit` + `afterSnapshot.unit`) — 15 entries

Missing 1, null 3, empty 2, whitespace-only 0.

| Class | Count |
| --- | ---: |
| canonical | 3 (`g`) |
| mapped | 3 (`kg`) |
| unsupported | 3 (`oz`×2 raw spellings `oz`/`OZ`) |

Includes a `kg` → `KG` unit edit snapshot (the pre-existing "editable unit" hazard).

### 3.5 `inventoryreservations.items[].unit` — 9 rows

Missing 0, null 0, empty 0, whitespace-only 0.

| Class | Count |
| --- | ---: |
| canonical | 4 |
| mapped | 4 (`kg`×2, `l`×2) |
| ambiguous | 1 (`bottle`) |

### 3.6 `inventoryreservations.approval.shortages[].unit` — 2 rows

Canonical 1 (`g`), ambiguous 1 (`bottle`). No missing/null/empty.

### 3.7 `inventoryreservations.voids[].items[].unit` — 2 rows

Canonical 1 (`ml`), empty 1 (`""`). No missing/null.

### 3.8 `orders.items[].components[].stockUnit` (PRICED components) — 18 entries

Missing 1, null 1, empty 1, whitespace-only 0.

| Class | Count |
| --- | ---: |
| canonical | 7 (`g`×4, `pcs`/`PCS`×3) |
| mapped | 5 (`kg`×2, `l`×2, `each`×1) |
| unsupported | 1 (`oz`) |
| ambiguous | 2 (`bottle`, `cup`) |

## 4. Cross-unit conversion candidates

Measured with the integrated V1 helper `convertRequirementToStockUnit()` /
`mergeRequirements()` (`lib/inventoryRequirementConversion.js`), applying M1–M5.

M1: Converted values take effect at the next normal reconciliation; no migration or backfill is performed.

### 4.1 Recipe ingredient rows (32)

| Outcome | Count |
| --- | ---: |
| SAME_UNIT | 11 |
| CONVERTED | 6 |
| REJECTED | 12 |
| MISSING_STOCK_UNIT (item has no usable unit) | 3 |

Rejection codes: `LOSSY_CONVERSION`×1, `QUANTITY_PRECISION_UNSUPPORTED`×1,
`AMBIGUOUS_UNIT`×4 (`cup`, `pack`, `box`, `bag`), `UNKNOWN_UNIT`×5 (`dozen`, `tbsp`,
`oz`, `lb`, `gm`), `MISSING_UNIT`×4 (3 item-side empty/null/absent units + 1 demand
whitespace-only unit).

Representative exact conversions (milli units prove 3-decimal exactness, M5):

| Demand | → Stock unit | Converted |
| --- | --- | --- |
| 1500 g | kg | 1.5 kg (milli 1500) |
| 0.5 kg | g | 500 g (milli 500000) |
| 1.25 L | ml | 1250 ml (milli 1250000) |
| 6 piece | pcs | 6 pcs (milli 6000) |
| 10 each | pcs | 10 pcs (milli 10000) |

Deliberate failures (fail-closed, no rounding):

| Demand | → Stock unit | Code |
| --- | --- | --- |
| 0.5 g | kg | `LOSSY_CONVERSION` (0.0005 kg needs 4 decimals) |
| 0.0000001 g | kg | `QUANTITY_PRECISION_UNSUPPORTED` |
| cup / pack / box / bag → pcs | | `AMBIGUOUS_UNIT` (M4: container nouns never inferred) |
| dozen / tbsp / oz / lb / gm → known units | | `UNKNOWN_UNIT` (M4: no new aliases) |
| item unit missing/null/empty | | `MISSING_UNIT` |
| `"   "` demand unit vs `g` item | | `MISSING_UNIT` |

Note: `" g "` (padded, same letters) converts/keeps via `sameUnit` exactly like `g` —
identical-unit text keeps existing V1 behaviour (M4).

### 4.2 Order `PRICED_COMPONENT` stockUnit rows (18)

| Outcome | Count |
| --- | ---: |
| SAME_UNIT | 9 |
| CONVERTED | 2 |
| REJECTED | 7 (`LOSSY_CONVERSION`×1, `UNKNOWN_UNIT`×1, `AMBIGUOUS_UNIT`×2, `MISSING_UNIT`×3) |

Same-unit duplicates across case variants merge as identical units: `pcs` + `PCS`
(SYN-0005), `kg` + `KG` (SYN-0001) keep existing V1 same-unit behaviour.

## 5. Duplicate requirement rows and merge impact (M3)

Requirement rows grouped by inventory item across recipe+component sources:

| Item (stock unit) | Rows | Merge candidates (stock unit) | Merged | Rejected rows |
| --- | ---: | --- | ---: | --- |
| `aa…0002` (kg) | 5 | 1.5 + 1.5 + 2 kg | **1 row = 5 kg** | 0.5 g (`LOSSY`), 1e-7 g (`PRECISION`) |
| `aa…0001` (g) | 6 | 500 + 500 + 100 + 200 + 50 g | **1 row = 1350 g** | `"   "` (`MISSING_UNIT`) |
| `aa…0003` (ml) | 2 | 1250 + 250 ml | **1 row = 1500 ml** | — |
| `aa…0005` (pcs) | 7 | 6 pcs | **1 row = 6 pcs** | cup/pack/box/bag (`AMBIGUOUS`), dozen/tbsp (`UNKNOWN`) |
| `aa…0013` (g) | 3 | — | 0 | oz/lb/gm (`UNKNOWN_UNIT`) |

Every merge is an exact BigInt milli-unit sum after conversion; incompatible dimensions
and rejected units are never merged; deterministic ordering; extra fields preserved.

## 6. Reservation impact and fingerprint behaviour (M2)

6 stored reservations by status: RESERVED 1, APPROVAL_REQUIRED 1, APPROVED 2,
CONSUMED 1, RELEASED 1. Analysis statuses: RESERVED / APPROVAL_REQUIRED / APPROVED.

| Reservation | Status | Effect under M1–M5 | Fingerprint | Approval |
| --- | --- | --- | --- | --- |
| `ee…0001` SYN-0001 | RESERVED | kg + KG duplicate rows merge to 3.5 kg | changes | none |
| `ee…0002` SYN-0002 | APPROVAL_REQUIRED | L 1.25 → 1250 ml applied; 0.5 g vs kg dropped (`LOSSY_CONVERSION`) | changes | none |
| `ee…0003` SYN-0003 | APPROVED | bottle same-unit; stable, no merge | unchanged | **unaffected** |
| `ee…0004` SYN-0004 | APPROVED | 0.5 g vs kg dropped (`LOSSY_CONVERSION`) → rows change | changes | **invalidated → fresh Manager approval required (M2)** |
| `ee…0005` SYN-0005 | CONSUMED | not analysed (terminal) | — | — |
| `ee…0006` SYN-0005-R | RELEASED | not analysed (terminal) | — | — |

Totals: affected 3; APPROVED invalidated 1. No reservation or order state was mutated;
reconciliation itself was **not** executed — this is a static read-only impact analysis.

## 7. Limitations vs real stored data

Synthetic evidence cannot prove any production fact:

- actual production unit distribution, case-variant duplicate frequency, or item count;
- real `APPROVED` reservations that would need fresh Manager approval (M2 counts);
- frequency of empty/null `InventoryItem.unit` items in the live catalogue;
- real recipe+component duplicate-row prevalence reaching `validateRequirements()`;
- `StockMovement` unit uniformity in real history;
- runtime behaviour under load — no runtime/deployment/worker was activated.

## 8. Evidence required for the real (still BLOCKED) audit

The real stored-unit audit in `docs/inventory-stored-unit-audit.md` stays BLOCKED until a
**separately authorized sanitized real-data export** provides:

1. unit values only (no names, IDs of people, suppliers, orders) per collection and field:
   `inventoryitems.unit`, `recipes.ingredients[].unit`, `stockmovements.unit`,
   `inventoryaudits.unit` + snapshot units, `inventoryreservations` (items / approval
   shortages / voids), `orders…components.stockUnit`;
2. paired numeric quantities (same sanitization level) so exactness/`LOSSY_CONVERSION`
   can be evaluated per row;
3. reservation status + stored `requirementFingerprint`/`shortageFingerprint` values;
4. a statement of export date, environment, and filter scope, plus owner authorization.

## 9. Cleanup (owner review only — NOT executed)

Do not run without separate approval; the database is deliberately left in place:

```
mongosh --host 127.0.0.1 --port 27017 --quiet --eval "db.getSiblingDB('bono_unit_audit_disposable_20261115_a1').dropDatabase()"
```

## 10. Confirmation

- No production, staging, Atlas, or remote host was accessed.
- No `.env`, `.env.local`, credential, or secret was read; no connection string printed.
- No schema, migration, index, seed, backfill, API, payment, order, or runtime change.
- Only the disposable database `bono_unit_audit_disposable_20261115_a1` was touched.
- Git: nothing staged, committed, stashed, reset, or cleaned; all pre-existing
  working-tree changes preserved.
