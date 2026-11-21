# BONO Inventory — Phase 2, Step 2: Legacy Unit Compatibility Audit

Status: **READ-ONLY AUDIT COMPLETE. NO DATABASE ACCESS. NO RUNTIME CHANGE. NO ADAPTER OR INTEGRATION BUILT.**

- Branch: `main`
- HEAD: `69650435a6587d4577bc126f719fa1392bb934b3` (2026-10-24T02:32:50+03:00)
- Audit date: 2026-11-15
- Files created by this step: **`docs/inventory-unit-compatibility-audit.md` only**
- Files modified by this step: **none**
- `lib/inventoryUnits.js` was read only and is unchanged.

This document is an evidence report. It does not authorize a unit adapter, a
migration, a rewrite of stored units, or any runtime wiring.

---

## 1. Authorization boundary

Performed:

- Static inspection of repository source, models, validation, services, UI,
  scripts, fixtures, tests, docs, and menu JSON.
- Measured literal unit-value scanning with documented, repeatable commands.

Not performed, by instruction:

- No connection, query, aggregation, index build, or schema introspection against
  any MongoDB instance (local, staging, production).
- No read of `.env`, `.env.local`, or any other environment/credential file.
- No source, runtime, test, schema, or model change.
- No migration, index deployment, deployment, worker, or scheduler action.
- No Git mutation (no add, commit, reset, clean, checkout, stash, or push).

Because no database was read, **this report cannot state what unit strings are
actually stored in production collections.** Section 9 lists exactly what remains
unverified.

---

## 2. Method and reproducibility

Two scans were run over the working tree, excluding `node_modules`, `.next`,
`.git`, `out`, `build`, `.vercel`, and `package-lock.json`.

Scan A — literal assignments to unit-bearing fields:

```powershell
Get-ChildItem -Path C:\hotelms -Recurse -Include *.js,*.jsx,*.mjs,*.cjs,*.json -File |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.next|\.git|out|build|\.vercel)\\' -and $_.Name -ne 'package-lock.json' } |
  Select-String -Pattern '(?<![A-Za-z0-9_])(stockUnit|movementUnit|auditUnit|unit)\s*[:=]\s*([''"''])([^''"'']*)\2' -AllMatches -CaseSensitive |
  ForEach-Object { foreach ($m in $_.Matches) { [pscustomobject]@{
    File=$_.Path.Replace('C:\hotelms\','').Replace('\','/'); Line=$_.LineNumber;
    Field=$m.Groups[1].Value; Value=$m.Groups[3].Value } } } |
  Group-Object Value -CaseSensitive | Sort-Object Count -Descending | Select-Object Count,Name
```

Scan B — unit-token occurrences with surrounding context, used to decide whether
a token is a unit value, a function argument, prose, or a field name:

```powershell
Get-ChildItem -Path C:\hotelms -Recurse -Include *.js,*.jsx,*.mjs,*.cjs -File |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.next|\.git|out|build|\.vercel)\\' } |
  Select-String -Pattern '["''](kg|KG|g|pcs|ml|L|litre|liter|each|ea|bottle|cans?)["'']' -AllMatches
```

Scan C — targeted token sweep for the 27 aliases named in the task over
`lib/` and `app/`, plus `food_menu.json` / `drink_menu.json` prose.

No audit script was committed. Adding one would be a source change, which this
step forbids. Scan A/B are reproducible from the commands above.

---

## 3. Unit-bearing surfaces found in source

| Surface | Location | Constraint on `unit` | Source-confirmed |
|---|---|---|---|
| `InventoryItem.unit` | `lib/models/InventoryItem.js:10` | `String, required, trim` — **no enum, no allowlist** | yes |
| `Recipe.ingredients[].unit` | `lib/models/Recipe.js:14` | `String, required, trim` — no enum | yes |
| `InventoryReservation.items[].unit` | `lib/models/InventoryReservation.js:40` | `String, required, trim` — no enum | yes |
| `InventoryReservation.ingredients[].unit` | `lib/models/InventoryReservation.js:57` | `String, required, trim` — no enum | yes |
| `InventoryReservation...unit` (third field) | `lib/models/InventoryReservation.js:89` | `String, default: ""` | yes |
| `StockMovement.unit` | `lib/models/StockMovement.js:44` | `String, default: null` — **nullable** | yes |
| `InventoryAudit.unit` | `lib/models/InventoryAudit.js:39` | `String, default: null` — **nullable** | yes |
| `Order.items[].components[].stockUnit` | `lib/models/Order.js` (component subdoc) | free string; validated ≤ 20 chars | yes |
| Item create/update validation | `lib/inventoryValidation.js:26,93-101` | trimmed, 1–50 chars, control chars stripped, `<script` rejected. **Any text accepted.** | yes |
| Receive validation | `app/api/inventory/receive/route.js:49-52`; `lib/inventoryAuditService.js:94-99` | trimmed, truncated to 50, `<script` rejected. Any text accepted. | yes |
| Component `stockUnit` validation | `lib/validate.js:193-219` | arbitrary non-empty string ≤ 20 chars; requires `inventoryItemId` | yes |
| Reservation unit comparison | `lib/inventoryReservationRules.js:18-24` | `normalizeUnit()` = `trim().toLowerCase()`; **text equality, no conversion** | yes |
| Receive idempotency unit comparison | `lib/inventoryReceiveService.js:45,125` | `trim().toLowerCase()` equality; mismatch throws 400 | yes |
| Order component vs inventory unit | `lib/orderService.js:367-373` | case-insensitive text equality; mismatch **silently** drops cost/deduction | yes |
| Recipe vs inventory unit (create) | `app/api/recipes/route.js:86` | `trim().toLowerCase()` equality; mismatch → 400 | yes |
| Recipe vs inventory unit (update) | `app/api/recipes/[id]/route.js:52-58` | same; mismatch → 400 | yes |
| Deduction grouping | `lib/inventoryDeductionService.js:122-143,177-195` | exact case-sensitive string grouping; separate buckets "to avoid mixing g/kg"; **no conversion** | yes |
| Reservation unit mismatch handling | `lib/inventoryReservationService.js:208-217` | mismatch → explicit warning, **no reservation** | yes |
| Inventory UI | `app/components/InventoryUI.jsx` | free-text `<input>` for unit; no `<select>`, no vocabulary | yes |

Conclusion: the legacy unit vocabulary is genuinely free text at every layer.
Nothing in the source enumerates or restricts it.

---

## 4. Measured literal vocabulary (source-confirmed)

### 4.1 Literal unit-field assignments across the whole repository

Case-sensitive counts from Scan A. "Occurrences" counts each literal; one source
line can contribute two occurrences.

| Value | Occurrences | Where | Nature |
|---|---|---|---|
| `kg` | 36 | scripts (8 files), tests (7 files) | fixture/test data |
| `g` | 19 | tests (2 files) | fixture/test data |
| `""` (empty) | 11 | `app/components/InventoryUI.jsx` form initial state | UI default, not a value |
| `KG` | 2 | `scripts/test-receive-idempotency.mjs:79,164` | deliberate case-variant probe |
| `" kg "` | 1 | `scripts/test-receive-idempotency.mjs:80` | deliberate whitespace-variant probe |
| `pcs` | 1 | `tests/inventory-v2-phase1.test.mjs:318` | V2 wire fixture |
| `"a"` (×51) | 2 (1 line) | `scripts/test-receive-validation.mjs:108` | non-unit artifact: proves 51-char units are truncated, not rejected |
| **Total** | **72 (61 non-empty)** | | |

**Source-confirmed legacy vocabulary in unit-bearing fields: `kg`, `g`, `pcs`,
`KG`, `" kg "`.** No other token appears as a unit value anywhere in the
repository.

### 4.2 Per-file occurrence counts (non-empty values)

| File | Occurrences |
|---|---|
| `tests/inventory-v2-phase1.test.mjs` | 17 |
| `scripts/test-receive-idempotency.mjs` | 9 |
| `tests/inventory-reservation-phase1.test.mjs` | 8 |
| `tests/integration/phase23-replica-set.integration.mjs` | 5 |
| `tests/integration/support/wp04-05/l2/l2FixturePlan.mjs` | 5 |
| `tests/components.test.mjs` | 4 |
| `scripts/test-h73-cost.mjs` | 2 |
| `scripts/test-h74-get.mjs` | 2 |
| `scripts/test-receive-validation.mjs` | 2 |
| `tests/item-level-cancellation.test.mjs` | 2 |
| `scripts/test-audit-direct.mjs` | 1 |
| `scripts/test-direct-service.mjs` | 1 |
| `scripts/test-h72-audit.mjs` | 1 |
| `scripts/test-h73-route.mjs` | 1 |
| `tests/wp04-01-recovery-core.test.mjs` | 1 |
| **Total** | **61** |

Additional unit-token usage that is *not* a persisted field assignment:

- `tests/inventory-lifecycle-phase1-1.test.mjs` — 14 `requirement(ITEM_A, "kg", …)`
  argument occurrences over 13 lines. V1 reservation lifecycle fixture.
- `tests/inventory-v2-phase1.test.mjs` — many `parseQuantityInUnit` /
  `convertQuantityExact` call arguments using `g`, `kg`, `ml`, `L`, `pcs`.
- `canonicalUnit:` literals — `g` 14, `ml` 3, `kg` 2, `pcs` 2, `""` 1.
  The two `canonicalUnit: "kg"` and one `unit: "kg"` / `canonicalUnit: "ml"` at
  lines 375–395 are **intentional rejection fixtures**, not valid vocabulary.

### 4.3 Seed, migration, and fixture files

| File group | Result |
|---|---|
| `scripts/seed-*.mjs`, `scripts/migrate-*.mjs`, `scripts/migrate-*.js`, `scripts/sync-*.mjs`, `scripts/sync-*.js` | **Zero** unit-field assignments |
| `food_menu.json`, `drink_menu.json` | **Zero** `unit` / `stockUnit` / `ingredients` keys. Only prose (see §6). |
| `tests/integration/support/**` | Only `kg` in `l2FixturePlan.mjs` |
| `docs/production-readiness/evidence/*.json` | No unit fields |
| Other JSON/CSV files in the tree | None carry unit values |

### 4.4 UI strings (not vocabulary)

`app/components/InventoryUI.jsx` uses free-text inputs and these `placeholder`
strings only:

- line 891: `placeholder={selectedItem?.unit || "kg"}`
- line 930: `placeholder="kg"`
- line 1246: `placeholder="kg"`

Placeholders are hints, not validation and not evidence of stored values.
`lib/translations.js` only contains labels (`invUnit: "Unit"`, `invUnitCost:
"Unit Cost"`, `invErrIngUnit: "Each ingredient unit is required"`).

### 4.5 Module vocabularies in the repository

`lib/inventoryUnits.js` (Step 1, unmodified, **not imported by any runtime
module** — only `tests/inventory-units-normalization.test.mjs` references it):

| Group | Accepted aliases | Maps to |
|---|---|---|
| MASS | `g`, `gram`, `grams` | `g` (×1) |
| MASS | `kg`, `kilogram`, `kilograms`, `kgs` | `g` (×1000) |
| VOLUME | `ml`, `millilitre(s)`, `milliliter(s)` | `ml` (×1) |
| VOLUME | `l`, `litre(s)`, `liter(s)` | `ml` (×1000) |
| COUNT | `pcs`, `pc`, `piece`, `pieces`, `each`, `ea`, `bottle`, `bottles`, `can`, `cans` | `pcs` (×1) |

`lib/inventory-v2/domain/units.js` (strict, exact-match):

- Approved units: `kg`, `g`, `L`, `ml`, `pcs`.
- Canonical accounting units: `g`, `ml`, `pcs`.
- Supported pairs: `kg↔g`, `L↔ml`, `pcs↔pcs` only.
- Explicitly rejects `"KG"`, `"l"`, whitespace, and all aliases (source comment
  lines 10–12; assertions at `tests/inventory-v2-phase1.test.mjs:542`).

---

## 5. Classification

Class definitions used here:

- **CANONICAL** — the token is already a canonical accounting unit (`g`, `ml`,
  `pcs`), so no conversion or relabeling is required.
- **MAPPED** — the token is accepted by `lib/inventoryUnits.js` with one
  canonical target and an exact power-of-ten factor, and its dimension is
  established by source evidence other than the alias table itself.
- **UNRESOLVED** — the token is a standard measurement word with a determinate
  dimension, but the module does not support it. No automatic mapping can be
  justified; an explicit product decision is required. Current behaviour is
  fail-closed.
- **DIMENSION_UNKNOWN** — the repository does not establish what quantity the
  token denotes (container, portion, count, or volume). It must not be
  auto-converted, and the module's own alias declaration is not accepted as
  evidence.

Classification rule for container/portion nouns: a token such as `bottle`,
`box`, `pack`, `slice`, `tray`, `bunch`, or `unit` is never inferred as a count.
Only standard measurement abbreviations (`kg`, `g`, `ml`, `L`, `lb`, `tbsp`,
`tsp`, `dozen`) are treated as dimension-determinate.

| Token | Module verdict | Audit class | Legacy field occurrences | Proposed resolution |
|---|---|---|---|---|
| `g` | `g` ×1 | **CANONICAL** | 19 | None. Already canonical. |
| `ml` | `ml` ×1 | **CANONICAL** | 0 (3 as `canonicalUnit`) | None. Already canonical. |
| `pcs` | `pcs` ×1 | **CANONICAL** | 1 | None. Already canonical. |
| `kg` | `g` ×1000 | **MAPPED** | 36 | Convert at read time only, in a later authorized step. Label-only rewrite is unsafe (1 kg ≠ 1 g). |
| `KG` | `g` ×1000 (case-folded) | **MAPPED** | 2 | Same as `kg`. Note V2 rejects `KG`; normalization must happen before V2 ingestion. |
| `" kg "` | `g` ×1000 (trimmed) | **MAPPED** | 1 | Same as `kg`; trim only, never store the normalized form back. |
| `L` | `ml` ×1000 | **MAPPED** | 0 | Convert at read time only; later authorization. |
| `l` | `ml` ×1000 | **MAPPED** | 0 | Same as `L`. V2 rejects lowercase `l`. |
| `litre`, `litres`, `liter`, `liters` | `ml` ×1000 | **MAPPED** | 0 | Same as `L`. |
| `kilogram`, `kilograms`, `kgs` | `g` ×1000 | **MAPPED** | 0 | Same as `kg`. |
| `gram`, `grams` | `g` ×1 | **MAPPED** | 0 | Label normalization only. |
| `pc`, `piece`, `pieces`, `each`, `ea` | `pcs` ×1 | **MAPPED** | 0 | Label normalization only, after authorization. |
| `bottle`, `bottles` | `pcs` ×1 (policy-declared) | **DIMENSION_UNKNOWN** | 0 | Do not assume count. See §6.1 and §8. |
| `can`, `cans` | `pcs` ×1 (policy-declared) | **DIMENSION_UNKNOWN** | 0 | Do not assume count. See §6.1 and §8. |
| `oz` | rejected | **UNRESOLVED** | 0 | Mass vs fluid-ounce ambiguity is unresolved; no mapping. |
| `lb` | rejected | **UNRESOLVED** | 0 | Mass; needs product decision (factor 453.59237 g is not a power of ten, so the exact-integer contract cannot represent it without a policy choice). |
| `gm` | rejected | **UNRESOLVED** | 0 | Apparent mass abbreviation; needs decision (alias or reject). |
| `tbsp`, `tsp` | rejected | **UNRESOLVED** | 0 | Volume, non-metric; exact conversion to `ml` is not a power of ten. |
| `dozen` | rejected | **UNRESOLVED** | 0 | Count with fixed factor 12; needs product decision. |
| `cup`, `shot`, `dash`, `pinch` | rejected | **DIMENSION_UNKNOWN** | 0 | Vessel/portion/approximate measures; not safely convertible. |
| `slice`, `loaf`, `head`, `clove`, `bunch`, `tray` | rejected | **DIMENSION_UNKNOWN** | 0 | Portion/count nouns with no defined quantity. |
| `unit`, `item` | rejected | **DIMENSION_UNKNOWN** | 0 | Placeholder words; could mean count or nothing. |
| `pack`, `packet`, `box`, `bag`, `tin`, `jar`, `sachet` | rejected | **DIMENSION_UNKNOWN** | 0 | Container nouns with unknown pack size. |

Every token marked `MAPPED` except `kg`/`KG`/`" kg "` has **zero** occurrences in
any unit-bearing field in the repository. They are supported for future input,
not proven to exist in legacy data.

---

## 6. Alias-by-alias investigation (the 27 requested tokens)

### 6.1 `bottle`, `can`

Repository evidence:

- `lib/inventoryUnits.js:156,164,166-167` — the alias table maps both to `pcs`,
  with the comment "bottle and can mean a countable container here — never a
  volume." This is the module's own **declaration**, not evidence about legacy
  data.
- `tests/inventory-units-normalization.test.mjs:152-170` — the same declaration
  asserted by Step 1 tests.
- `drink_menu.json` — `bottle` appears only as menu prose: product names such as
  `"Gordon's Gin (Bottle)"` (line 441), `"Blue Label Bottle"` (line 681), and
  descriptions such as "Half bottle of ultra-premium blended Scotch whisky"
  (line 698). `drink_menu.json` has **no** `unit` field.
- No `unit: "bottle"` or `unit: "can"` exists anywhere in the repository.

Verdict: **DIMENSION_UNKNOWN for legacy data.** The source does not establish
that a stored `"bottle"` means one countable piece; a bottle could denote a
700 ml/750 ml serving, a case, or a single unit. `can` has the same problem.
Both are classified DIMENSION_UNKNOWN, and the module's `pcs` mapping is flagged
as an unverified policy choice.

### 6.2 `unit`, `item`

- `unit` is a **field name** in every model, not a value. Zero occurrences as a
  value.
- `item` appears only as identifiers/field names (`InventoryItem`, `itemId`,
  `menu item`, "Inventory item" report label at
  `lib/hotel/services/reportsPdf.js:79`).
- Both are rejected by `lib/inventoryUnits.js` and by Step 1 tests
  (`"unit"`, `"units"` at test lines 182-183).

Verdict: **DIMENSION_UNKNOWN.** If a legacy record literally stores `"unit"` or
`"item"`, its meaning is unknowable from source.

### 6.3 `pack`, `packet`, `box`, `bag`, `tin`, `jar`, `sachet`

- Only occurrences in `lib/` and `app/`: the module's comment listing them as
  intentionally unguessed (`lib/inventoryUnits.js:42`) and unrelated prose
  (`box` in a UI comment, `app/page.js:23`).
- Step 1 tests assert all of them are rejected (lines 184-190).
- Zero unit-field occurrences.

Verdict: **DIMENSION_UNKNOWN.** A pack/box/bag has no defined quantity and no
source-confirmed semantic. They must not be treated as `pcs`.

### 6.4 `dozen`, `bunch`, `head`, `clove`, `loaf`, `tray`, `slice`

- `dozen` is rejected by Step 1 tests (line 191) and `slice` at line 192.
- `bunch`, `head`, `clove`, `loaf`, `tray` appear nowhere in a unit context;
  `head`/`slice` hits in `lib/`/`app/` are unrelated code (`Buffer.subarray`,
  `Array.slice`).
- Zero unit-field occurrences.

Verdict: `dozen` → **UNRESOLVED** (fixed count of 12, unsupported).
`bunch`, `head`, `clove`, `loaf`, `tray`, `slice` → **DIMENSION_UNKNOWN**
(portion nouns with undefined size).

### 6.5 `cup`, `tbsp`, `tsp`

- Only occurrence in `lib/`/`app/`: `lib/inventoryUnits.js:42`.
- Step 1 tests reject `cup` and `tbsp`/`tsp` (lines 179-181).
- Zero unit-field occurrences.

Verdict: `tbsp`, `tsp` → **UNRESOLVED** (volume, imperial/US customary, not
power-of-ten convertible to `ml`). `cup` → **DIMENSION_UNKNOWN** (volume measure
vs drinking vessel; ambiguous).

### 6.6 `shot`, `dash`, `pinch`

- No occurrence in inventory source at all. `dash` hits in `lib/` are prose
  ("never collapses to a dash", `lib/analytics.js:207`) and username-character
  messages (`lib/translations.js:1263`).
- Step 1 tests reject `shot` (line 193).

Verdict: **DIMENSION_UNKNOWN.** Approximate or context-dependent volumes.

### 6.7 `oz`, `lb`, `gm`

- Only occurrences in `lib/`/`app/`: the module's comment naming them as
  rejected (`lib/inventoryUnits.js:41`).
- Step 1 tests reject `oz`, `ounce`, `lb`, `lbs` (lines 175-178).
- `gm` is not mentioned anywhere in the repository.
- Zero unit-field occurrences.

Verdict: **UNRESOLVED.** `oz` additionally carries a mass-vs-fluid-ounce
ambiguity that no repository evidence resolves. `lb`/`gm` cannot be represented
by the current exact power-of-ten factor contract without a new policy decision.

---

## 7. Compatibility findings and risk

### 7.1 What is compatible today without any adapter

- `g`, `ml`, `pcs` are simultaneously canonical and V2-approved. No action.
- `kg` appears in 36 fixture locations plus case/whitespace variants. Its
  dimension is source-confirmed by `lib/inventory-v2/domain/units.js` and the
  Step 1 factor table. It is safely mappable **as a pair with quantity
  conversion**.
- V1 already treats unit text case-insensitively for equality (reservation,
  receive idempotency, recipe/inventory checks). `"KG"` and `" kg "` therefore
  compare equal to `"kg"` today.

### 7.2 What would break if only labels were normalized

1. **V1 never converts quantities.** `lib/inventoryDeductionService.js:132-137`
   explicitly separates buckets "to avoid mixing g/kg"; `orderService.js:367-373`
   silently disables cost/deduction on a unit-text mismatch. Relabeling a stored
   `1 kg` to `1 g` would multiply/destroy stock meaning by 1000. Any adapter must
   convert quantity, not just the label.
2. **V2 rejects inputs V1 accepts.** `lib/inventory-v2/domain/units.js` rejects
   `"KG"`, `"l"`, aliases, and surrounding whitespace by design. Legacy values
   must pass through normalization *before* V2, never straight into it.
3. **Nullable legacy units exist.** `StockMovement.unit` and `InventoryAudit.unit`
   default to `null`; `InventoryReservation` has a `default: ""` unit field.
   `normalizeUnit("")` and `normalizeUnit(null)` throw
   (`tests/inventory-units-normalization.test.mjs:208-219`). Nullable legacy
   units are a real, source-confirmed gap that no alias list addresses.
4. **Receive writes caller-supplied casing.** `lib/inventoryReceiveService.js:129`
   sets `movementUnit = unit || String(item.unit).trim()`, so a movement can
   persist `"KG"` even when the item's unit is `"kg"`. Stored case variance is
   structurally possible, not hypothetical.
5. **Arbitrary text is storable.** Validation accepts any 1–50-char sanitized
   string, and 51-char values are truncated rather than rejected
   (`scripts/test-receive-validation.mjs:108`). `"a".repeat(50)` is a legal
   stored unit today.
6. **`Order.stockUnit` is free text ≤ 20 chars.** A mismatch against the
   inventory item unit does not error; it silently drops cost/deduction
   (`lib/orderService.js:367-373`). Unit cleanup must not assume these values are
   well-formed.

### 7.3 Risk of over-trusting the Step 1 alias table

`bottle`, `can`, `each`, `ea`, `piece(s)`, `pc`, and every metric synonym other
than `kg`/`g`/`ml` have **no repository evidence** as stored legacy values. Using
the alias table as if it described production data would convert tokens that may
never exist while leaving the genuinely unknown ones (`pack`, `box`, `jar`, …)
unhandled. The correct conclusion from repository evidence alone is that only
`kg`, `g`, `pcs`, `KG`, and `" kg "` are proven.

---

## 8. Unresolved ambiguities (not silently decided)

1. **Actual stored unit strings are unknown.** No database was read. The
   in-repo vocabulary is fixture data plus UI placeholders, which is not evidence
   about production collections.
2. **`bottle` / `can` semantics are unproven.** Source contains a module comment
   asserting countable containers, but no data, seed, fixture, or validation
   evidence. Left `DIMENSION_UNKNOWN`. No alias was added or changed.
3. **`oz` dimension is ambiguous** (mass ounce vs fluid ounce). Left unresolved.
4. **`lb` / `gm` conversion policy is undefined.** The exact contract uses
   power-of-ten factors only; 453.59237 g per lb and 0.028349523125 g per oz do
   not fit that representation without a rounding policy, which does not exist.
5. **Container nouns (`pack`, `packet`, `box`, `bag`, `tin`, `jar`, `sachet`,
   `tray`, `loaf`, `bunch`, `head`, `clove`, `slice`, `cup`, `shot`, `dash`,
   `pinch`, `unit`, `item`) have no defined quantity and no repository evidence.**
   Not mapped, not rejected as "wrong" — explicitly undetermined.
6. **Nullable units** (`StockMovement.unit`, `InventoryAudit.unit`,
   `InventoryReservation` `default: ""`) have no decided handling.
7. **Whether legacy `StockMovement.unit` casing actually diverges from
   `InventoryItem.unit` in stored data** is structurally possible (§7.2 item 4)
   but unmeasured.
8. **No repository file establishes a unit allowlist, migration, or canonical
   seed**, so no "intended legacy vocabulary" can be reconstructed.

---

## 9. What remains unverified (requires separate authorization)

A real compatibility decision needs aggregate, read-only facts that only the
database can supply:

- Distinct trimmed/lowercased `unit` values and counts per collection:
  `inventoryitems`, `recipes` (`ingredients.unit`), `inventoryreservations`
  (item and ingredient units), `stockmovements.unit`, `inventoryaudits.unit`,
  and `orders` component `stockUnit`.
- Count of `null` / empty / whitespace-only units per collection.
- Count of order components whose `stockUnit` does not case-insensitively match
  their inventory item's `unit` (the silent cost/deduction drop path).
- Cross-tab of `InventoryItem.unit` vs `Recipe.ingredients[].unit` for the same
  item, to size the recipe/inventory mismatch population.

This audit **did not** perform any of that. Doing so requires explicit separate
authorization for a read-only database audit (distinct-value aggregation only —
no record reads, no writes, no index changes, no `.env` inspection).

---

## 10. Proposed resolution plan (proposed only — nothing executed)

1. Keep `lib/inventoryUnits.js` exactly as-is until the database facts in §9
   exist.
2. If authorization is granted, run a distinct-value aggregate audit and replace
   the "unverified" rows in §5 with measured counts. Do not infer `pcs` for
   `bottle`/`can` from the alias table alone.
3. Only after that, decide per token:
   - `CANONICAL` → no work.
   - `MAPPED` → read-time normalization **with quantity conversion**, never
     in-place rewriting of stored values.
   - `UNRESOLVED` / `DIMENSION_UNKNOWN` → fail closed and surface the raw value
     for human resolution; do not guess.
4. Define handling for nullable/empty units before any adapter work.
5. Keep any future adapter opt-in, side-effect free at import, and out of
   reservation, deduction, order, payment, and waste paths until explicitly
   authorized.

No adapter, no runtime import, and no stored-value rewrite is authorized or
started by this report.

---

## 11. Files inspected and files created

### Created

- `docs/inventory-unit-compatibility-audit.md` (this report)

### Inspected (read or scanned)

Unit modules and tests:

- `lib/inventoryUnits.js`
- `lib/inventory-v2/domain/units.js`
- `tests/inventory-units-normalization.test.mjs`
- `tests/inventory-v2-phase1.test.mjs`
- `tests/inventory-reservation-phase1.test.mjs`
- `tests/inventory-lifecycle-phase1-1.test.mjs`
- `tests/item-level-cancellation.test.mjs`
- `tests/components.test.mjs`
- `tests/wp04-01-recovery-core.test.mjs`
- `tests/integration/phase23-replica-set.integration.mjs`
- `tests/integration/support/wp04-05/l2/l2FixturePlan.mjs`, `l2FixtureSeeder.mjs`
- `tests/helpers/pos-phase23-loader.mjs`, `pos-phase25-loader.mjs`
- `tests/wp04-05-fixture-plan.test.mjs`

Models and validation:

- `lib/models/InventoryItem.js`
- `lib/models/Recipe.js`
- `lib/models/StockMovement.js`
- `lib/models/InventoryAudit.js`
- `lib/models/InventoryReservation.js`
- `lib/models/Order.js`
- `lib/models/MenuItem.js`
- `lib/inventoryValidation.js`
- `lib/validate.js`

Services and rules:

- `lib/orderService.js`
- `lib/inventoryDeductionService.js`
- `lib/inventoryReservationRules.js`
- `lib/inventoryReservationService.js`
- `lib/inventoryReceiveService.js`
- `lib/inventoryAuditService.js`
- `lib/inventoryService.js`
- `lib/inventoryAlertService.js`
- `lib/inventoryAnalyticsService.js`
- `lib/inventoryDashboardService.js`

Routes and UI:

- `app/api/inventory/items/route.js`
- `app/api/inventory/items/[id]/route.js`
- `app/api/inventory/receive/route.js`
- `app/api/inventory/audits/route.js`
- `app/api/recipes/route.js`
- `app/api/recipes/[id]/route.js`
- `app/components/InventoryUI.jsx`
- `app/components/WaiterUI.js`
- `lib/translations.js`

Scripts:

- `scripts/clean-order-history.js`, `hotel-deploy-indexes.mjs`,
  `hotel-provision-manager.mjs`, `hotel-rotate-credentials.mjs`,
  `inventory-recovery-scan.mjs`, `inventory-v2-deploy-indexes.mjs`,
  `migrate-hot-drink-station.mjs`, `migrate-phase3-canonical.js`,
  `migrate-staff-waiterNumber.js`, `pos-provision-manager.mjs`, `reset-auth.js`,
  `seed-auth.js`, `seed-hot-drink-staff.mjs`, `seed-menu-json.mjs`,
  `seed-orders.mjs`, `sync-food-menu-json.mjs`, `sync-indexes.js`,
  `sync-menu-categories.js`, `test-audit-direct.mjs`, `test-auth-fail-closed.mjs`,
  `test-direct-service.mjs`, `test-extra-items.mjs`, `test-h72-audit.mjs`,
  `test-h73-cost.mjs`, `test-h73-route.mjs`, `test-h74-get.mjs`,
  `test-kds-dismissal.mjs`, `test-menu-unification.mjs`,
  `test-phase65-security.js`, `test-receive-idempotency.mjs`,
  `test-receive-validation.mjs`, `test-waiter-isolation.mjs`,
  `verify-analytics.mjs`

Data and docs:

- `food_menu.json`
- `drink_menu.json`
- `jsconfig.json`, `package.json`
- `docs/inventory-v2-phase2-foundations.md`
- `docs/hotel-foundation.md`
- `docs/production-readiness/**/*.md`
- `docs/production-readiness/evidence/*.json`

Not inspected, deliberately: `.env`, `.env.local`, any database or live data.

---

## 12. Safety and verification confirmation

- **Database:** no connection, query, aggregation, or index operation was made.
  No MongoDB client was imported or executed.
- **Environment:** no `.env` or `.env.local` file was read.
- **Source/runtime/tests/schema/models:** unchanged. Only the markdown report was
  added.
- **`lib/inventoryUnits.js`:** unchanged; no alias added, removed, or edited.
- **Stored unit values:** not normalized, not rewritten, not migrated.
- **Git:** no add/commit/reset/clean/checkout/stash/push. The pre-existing dirty
  working tree (61 modified, 91 untracked entries before this report) is
  preserved; the report is the only new path.
- **Runtime imports:** `lib/inventoryUnits.js` is still referenced only by
  `tests/inventory-units-normalization.test.mjs`. No application, route, model,
  or service imports it, so no live behaviour changed.
- **Live behaviour:** unchanged. Unit comparison remains trim/lowercase text
  equality with no conversion, exactly as before this audit.

Stop point: this report is the end of Phase 2 Step 2. No unit adapter and no
runtime integration were started.
