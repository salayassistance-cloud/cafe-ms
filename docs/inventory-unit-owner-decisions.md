# BONO Inventory — Phase 2, Step 7: Owner-Approved Unit Decisions

**Status: DECISIONS APPROVED — DOCUMENTATION ONLY. NO IMPLEMENTATION AUTHORIZED.**

- Approval date: **2026-11-15**
- Branch: `main`
- HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
- Owner approval: recorded in this document
- Files created: `docs/inventory-unit-owner-decisions.md` only
- Files modified: **none**
- Runtime behavior changed: **none**
- Adapter implemented or wired: **no**
- Database connections / queries: **0**
- `.env` / `.env.local` accessed: **no**

This document is the authoritative record of the owner's approved unit
decisions for the V1 inventory integration. It records *policy*. It does not
authorize code, data, schema, or deployment changes. Implementation requires a
separate, narrowly scoped authorization (see §6).

---

## 1. Decision index

| ID | Decision | Status |
|---|---|---|
| **M1** | Cutover semantics for in-flight reservations | **APPROVED** |
| **M2** | Approval invalidation on changed requirements | **APPROVED** |
| **M3** | Duplicate requirement rows and deterministic merging | **APPROVED** |
| **M4** | Unit vocabulary freeze | **APPROVED** |
| **M5** | Three-decimal precision at the integration boundary | **APPROVED** |
| A7 | Source-unit provenance | **DEFERRED — NO CHANGE** |
| A8 | Reporting behavior for mixed-unit history | **DEFERRED — NO CHANGE** |

Traceability to Step 5 §9.3:

| Step 5 ID | Recorded here as |
|---|---|
| A1 | M1 |
| A2 | M2 |
| A9 | M3 |
| A3 + A4 + A5 + A6 | M4 (consolidated) |
| (precision ratification, Step 6 §3 M5) | M5 |
| A7 | Deferred |
| A8 | Deferred |

---

## 2. Approved decisions

### M1 — Cutover

**Status: APPROVED — 2026-11-15.**

**Exact approved rule:**

- Conversion takes effect on the next normal reconciliation.
- No migration or backfill.
- Existing orders reconcile through the existing transactional lifecycle.

**What this means:**

There is no freeze, no version marker, no special cutover code path, and no
batch job. An order that already has a reservation continues on the existing
transactional path; the next time `reconcileOrderInventory` (or any lifecycle
operation that recomputes requirements) runs, the new conversion rule applies.

**What this does not authorize:**

- Backfilling, rewriting, or re-hashing existing reservations or fingerprints.
- Pausing ordering, draining the system, or a scheduled cutover window.
- Any new state field to distinguish "old rule" from "new rule".

---

### M2 — Approval invalidation

**Status: APPROVED — 2026-11-15.**

**Exact approved rule:**

- If an APPROVED order's requirement fingerprint changes, its approval becomes invalid.
- The order must require fresh Manager approval.
- Never preserve or manufacture approval for changed requirements.

**What this means:**

When conversion changes an order's requirement fingerprint, any stored Manager
approval for that order is void. The order returns to a state that requires a
new Manager approval before preparation. A smaller shortage is **not** grounds
for automatic re-approval.

**What this does not authorize:**

- Reusing an old `approval` snapshot whose quantities no longer match the
  current requirements.
- Auto-approving, delegating approval, or bypassing the Manager PIN/session
  requirement.
- Changing the approval API contract or queue behavior.

---

### M3 — Duplicate requirement rows

**Status: APPROVED — 2026-11-15.**

**Exact approved rule:**

- Convert each supported demand quantity exactly into its InventoryItem stock unit.
- Merge requirements deterministically per inventory item after conversion.
- Sum only exact, representable quantities.
- Never merge incompatible dimensions or rejected units.

**What this means:**

Multiple demand rows that resolve to the same inventory item (for example two
recipe rows whose units differ only by case) become **one** requirement row in
the item's stock unit, with quantities summed only when each converted value is
exact and representable. Merging is deterministic: the same inputs always
produce the same single row.

**What this does not authorize:**

- Merging `g` with `ml`, or `pcs` with any mass/volume unit.
- Merging a row whose unit was rejected or could not be converted exactly.
- Changing `InventoryItem.unit`, recipe units, or stored component labels.
- Any change to the 3-decimal storage contract beyond M5.

---

### M4 — Unit vocabulary freeze

**Status: APPROVED — 2026-11-15.**

**Exact approved rule:**

- Add no new aliases.
- Unknown and ambiguous units remain fail-closed for cross-unit conversion.
- Identical unit text retains the existing V1 same-unit behavior.
- bottle/can and other container nouns must never be inferred as pcs.

**What this means:**

`lib/inventoryUnits.js` and `lib/inventoryUnitAdapter.js` are not expanded. The
accepted vocabulary is the canonical set (`g`, `ml`, `pcs`) plus the existing
exact power-of-ten aliases only. For a *same-string* pair, V1's existing
trimmed, case-insensitive text equality still applies and the adapter is not
invoked. For a *cross-unit* pair with an unknown or ambiguous unit, the item is
excluded with a warning; nothing is guessed.

Container nouns (`bottle`, `can`, `pack`, `packet`, `box`, `bag`, `tin`, `jar`,
`sachet`, `tray`, `loaf`, `bunch`, `head`, `clove`, `slice`, `cup`, `shot`,
`dash`, `pinch`, `unit`, `item`, and their plurals) are never treated as
`pcs`, even though `lib/inventoryUnits.js` happens to declare `bottle`/`can` as
`pcs` in its alias table.

**What this does not authorize:**

- Adding `oz`, `lb`, `gm`, `tbsp`, `tsp`, `dozen`, or any synonym.
- Reinterpreting `bottle`/`can` as a count.
- Changing the adapter's rejection lists.
- Rejecting same-string units that V1 accepts today.

---

### M5 — Precision

**Status: APPROVED — 2026-11-15.**

**Exact approved rule:**

- V1 supports three decimal places at the integration boundary.
- If an exact converted quantity cannot be represented at three decimals, reject it with a warning.
- Never round to force representability.

**What this means:**

The integration boundary speaks V1's 3-decimal quantity language. An exact
conversion that lands below the representable floor (for example `0.5 g`
converted to `kg` gives `0.0005 kg`) is rejected with a warning and that
requirement is omitted. It is never rounded to `0.001 kg`, because that would
change the physical quantity by 2×.

**What this does not authorize:**

- Changing `round3`, `QTY_EPSILON`, or the stored 3-decimal contract.
- Rounding, truncating, or approximating a converted quantity.
- Using precision as a reason to alter existing records.

---

## 3. Deferred decisions

### A7 — Source-unit provenance

**Status: DEFERRED — NO CHANGE.**

No durable source-unit field, note format, or display change is approved. The
original demand unit and quantity are not persisted by this work. Existing
behavior is unchanged: reservations, consumption movements, and voids continue
to carry the stock unit; the original recipe/component unit remains only on the
`Recipe` / `Order` documents.

Implementing any provenance mechanism later requires its own decision and
authorization.

### A8 — Reporting behavior for mixed-unit history

**Status: DEFERRED — NO CHANGE.**

No reporting, analytics, dashboard, or food-cost behavior changes. Reports keep
their existing behavior of aggregating per inventory item and labelling with
the item's unit. No canonicalization at read time, no grouping by recorded
movement unit, and no historical restatement is approved.

---

## 4. Explicit scope limitations

This approval is limited to the policy recorded above. It **does NOT authorize**:

- Database connections or queries.
- Production or staging access.
- Schema changes or migrations.
- Runtime adapter wiring.
- Reservation, deduction, order, or payment modifications.
- Deployment, workers, or schedulers.
- Git staging or commits.

Additional non-authorizations implied by the approved rules:

- No backfill, rewrite, or re-hashing of existing reservations, fingerprints,
  movements, audits, or approvals.
- No change to `lib/inventoryUnits.js`, `lib/inventoryUnitAdapter.js`,
  `lib/inventoryReservationService.js`, `lib/inventoryReservationRules.js`,
  `lib/inventoryDeductionService.js`, `lib/orderService.js`, any model, any
  route, or `lib/inventory-v2/**` by virtue of this document alone.
- No change to `round3`, `QTY_EPSILON`, or the 3-decimal quantity contract.
- No new aliases and no reinterpretation of container nouns.
- No automatic, manufactured, or preserved approval for changed requirements.
- No change to Kitchen, Barista, Jebena, waiter, Manager, or Hotel behavior.

This document itself is a record, not an implementation. Approving a rule is not
approving a diff.

---

## 5. Outstanding prerequisites before runtime integration

The following must be satisfied **in addition to** this decision record, and
each requires its own evidence or authorization:

### 5.1 Data evidence (sizing, not policy)

1. **Stored-unit audit remains incomplete.** Step 4 recorded 0 queries and 0
   records because no approved non-production target could be identified.
   Still needed: distinct raw `inventoryitems.unit`,
   `recipes.ingredients[].unit`, and `orders.items[].components[].stockUnit`
   values, their pairing, and the count of live reservations whose fingerprint
   would change (Step 5 §6 Q1–Q3, Q7–Q8).
2. **This evidence does not change M1–M5.** The approved rules were chosen to be
   conservative independent of the data. The audit is needed to size the
   reconcile-on-touch window and the number of orders that will require fresh
   Manager approval — not to re-decide policy.
3. **Presence checks for M4.** Whether any `oz`, `lb`, `gm`, `tbsp`, `tsp`,
   `cup`, `dozen`, or container noun exists at all (Step 5 §6 Q10). Their
   absence makes M4 vacuous in practice; their presence makes it load-bearing.

### 5.2 Separate implementation authorization

4. **An explicit, narrowly scoped implementation approval** covering the exact
   diff. Step 5 §7 (6A–6F) is a proposal, not an authorization.
5. **Written confirmation that the change remains** one function-level edit at
   the requirement-validation boundary plus one new pure helper file, with no
   schema, route, payment, waste, receive, or V2 change.

### 5.3 Quality gates

6. **All existing tests remain green unchanged** — the 310 tests currently
   passing across the unit, adapter, reservation, lifecycle, observability, and
   V2 phase 1/2 suites.
7. **New regression tests** covering, at minimum, the Step 5 §5.2 set: supported
   conversion in both directions, three-decimal rejection, same-unit no-op,
   unknown/ambiguous fail-closed, container nouns, missing item unit, duplicate
   row merging, replay/idempotency (create, prepare, pay), approval invalidation,
   cancel/void, waste `unit: null`, and unchanged KDS `stockUnit`.
8. **ESLint clean** on the touched files, with no auto-fix in the verification
   run.
9. **No new runtime import of `lib/inventoryUnitAdapter.js`** outside the
   approved integration point.

### 5.4 Scope guards derived from the approvals

10. **M1 guard:** no migration script, no backfill job, no freeze flag, no
    ordering pause.
11. **M2 guard:** a test proving an `APPROVED` order whose fingerprint changes
    returns to `APPROVAL_REQUIRED` and cannot be prepared without a new Manager
    approval.
12. **M3 guard:** a test proving incompatible dimensions and rejected units are
    never merged, and that merging is deterministic across input orderings.
13. **M5 guard:** a test proving a non-representable exact conversion is
    rejected with a warning and never rounded.
14. **A7/A8 guard:** no new fields, no note-format change, no reporting change.

Until every prerequisite above is met, the integration remains **not approved
for runtime**.

---

## 6. What happens next (not started)

The next permissible step is an owner-authorized, narrowly scoped implementation
of the requirement-conversion boundary, subject to §5. Nothing has been started
by this document.

---

## 7. Traceability

- `docs/inventory-v1-unit-integration-readiness.md` — Step 5 source audit,
  §3.1 boundary recommendation, §4 rules, §5 risks/tests, §6 stored-data
  questions, §7 plan, §8 STOP conditions, §9 decision list.
- `docs/inventory-unit-compatibility-audit.md` — Step 2 vocabulary evidence,
  including `DIMENSION_UNKNOWN` treatment of container nouns.
- `docs/inventory-stored-unit-audit.md` — Step 4 blocked-target record
  (0 queries, 0 records; no approved non-production database).
- `lib/inventoryUnits.js` — canonical vocabulary and exact power-of-ten factors
  (unchanged, not expanded by M4).
- `lib/inventoryUnitAdapter.js` — fail-closed adapter (unchanged, not wired).

---

## 8. Verification of this step

| Constraint | Status |
|---|---|
| Files created | `docs/inventory-unit-owner-decisions.md` only |
| Other files modified | None |
| Database connections / queries | None |
| `.env` / `.env.local` access | None |
| Schema or migration changes | None |
| Runtime behavior changed | None |
| Adapter wired | No |
| Deployment / workers / schedulers | None |
| Git stage / commit / stash / reset / clean | None |
| Working tree preserved | Yes — pre-existing 61 modified entries untouched; untracked count increased by exactly one (this document) |

Stop point: decision record only.
