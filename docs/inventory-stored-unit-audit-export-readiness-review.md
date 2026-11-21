# BONO Step 6 — Sanitized Export Readiness Review

**Status: READ-ONLY REVIEW — COMPLETE. EXPORT EXECUTION NOT AUTHORIZED.**

- Review date: 2026-11-15
- Reviewed document: `docs/inventory-stored-unit-audit-export-spec.md` (353 lines, as created in Step 5)
- Compared against: current Mongoose schemas (`lib/models/InventoryItem.js`,
  `Recipe.js`, `StockMovement.js`, `InventoryAudit.js`, `InventoryReservation.js`,
  `Order.js`), `lib/inventoryReservationRules.js`, `lib/inventoryReservationService.js`,
  `lib/inventoryUnitAdapter.js`, `lib/inventoryRequirementConversion.js`,
  `lib/inventoryUnits.js`, `lib/orderService.js`, and the Step 4/5 documents
  (`docs/inventory-stored-unit-audit.md`,
  `docs/inventory-stored-unit-disposable-audit.md`,
  `docs/inventory-unit-owner-decisions.md`).
- Method: source inspection only. **No database connection, no script created or run,
  no environment/secret access, no Git mutation, no modification of the reviewed
  specification.**

---

## Overall verdict: **PASS WITH CORRECTIONS**

The specification is structurally sound, source-accurate on the matrix, fingerprint
behavior, pseudonym joins, collision policy, unit preservation, and M1–M5. Four
corrections (2 High, 4 Medium) must be applied before an owner-operated export; none
changes the concept, and none requires code or schema changes.

---

## Verification of the ten review-scope points

### 1. Collection/field matrix vs current schemas — PASS

Every exported field name was verified against the actual schema definitions:

| Collection | Verified source | Notes |
|---|---|---|
| `inventoryitems` | `lib/models/InventoryItem.js:6-31` (collection name `:35-40`) | `unit` (String, required, trim), `currentStock`, `reservedStock` exist as exported |
| `recipes` | `lib/models/Recipe.js:19-42` (collection `:37-42`) | `ingredients[] {inventoryItemId, quantity, unit}`, `isActive` exist; `menuItemId` correctly excluded |
| `stockmovements` | `lib/models/StockMovement.js:6-92` (collection `:85-90`) | `unit` (String, default null, `:44`), `type`/`reason` enums, `quantity` exist |
| `inventoryaudits` | `lib/models/InventoryAudit.js:9-72` (collection `:67-72`) | `unit` (default null, `:39`), `action` enum (`:7`), `beforeSnapshot`/`afterSnapshot` **Mixed** (`:55-56`) |
| `inventoryreservations` | `lib/models/InventoryReservation.js:124-168` (collection `:175-180`) | full item/approval/void shapes verified (`:33-122`); `voids[].lineId` (`:113`), `voids[].items[].unit` default `""` (`:89`), `consumedTrigger` (`:155`) |
| `orders` | `lib/models/Order.js:25-107` | `OrderComponentSchema.inventoryItemId` (`:39`), `stockQuantity` (`:40`), `stockUnit` (`:41`), `lineId` (`:53`) |

No exported field is misnamed, and no excluded field is needed by any audited question.

### 2. Pseudonym namespaces, stable joins, null/missing, collisions — PASS

- Namespaces `item`/`order`/`orderline`/`component`/`recipe`/`reservation`
  (spec `:117`) cover every exported identifier.
- Shared `orderline` namespace is source-correct: `cancelOrderItem` validates the id
  against the order's own `items[].lineId` (`lib/orderService.js:1380, 1396-1404`) and
  writes that exact ObjectId into `voids[].lineId` (`:1541` →
  `appendPostPreparationVoid`, `lib/inventoryReservationService.js:1069`); void
  idempotency filters on the same value (`:1034`).
- Null/missing stay null/missing (spec `:124`) — matches the schema nullability facts
  (`voids[].lineId` default null, `StockMovement.unit` default null, etc.).
- Collision policy is complete: per-namespace injectivity, global cross-namespace
  uniqueness, whole-export abort, manifest counts for offline re-verification
  (spec `:125-135`). See Low-1 for one input-format refinement.

### 3. Fingerprint recomputation — PASS

Spec §3 (`:139-174`) matches the implementation exactly
(`lib/inventoryReservationRules.js:98-110`): signature `buildRequirementFingerprint(orderId, items)`;
internal canonicalization (`String(inventoryItemId || "")`, rules-module
`normalizeUnit` = trim+lowercase (`:18-20`), `round3` = `Math.round(v*1000)/1000`
(`:12-16`), filter `id && qty>0`, sort by `${id}:${unit}` localeCompare, join
`"id:unit:qty.toFixed(3)"` with `|`, sha256 of `${String(orderId)}|${rows}`).
All runtime callers pass `{ inventoryItemId, unit, requiredQuantity }`
(`lib/inventoryReservationService.js:324,368,386,452,492,513,643,696,798,967`).
The exporter rules (stored rows verbatim, real ids, no pre-rounding/pre-sorting/
pseudonym substitution, stored-vs-recomputed comparison, mismatch = evidence) are
correct. `buildShortageFingerprint` inputs are all exported (`:112-132`).

### 4. BSON type serialization — **CORRECTIONS REQUIRED (High-2)**

The double/int32/int64/decimal128/date/null/missing/unknown rows (spec `:183-191`)
are correct and non-coercing, and NaN/±Infinity are handled (`:193-195`). Gaps:
**Boolean and ObjectId are absent** from the table, yet `recipes.isActive` (Boolean)
is exported, and every exported identifier is an ObjectId before pseudonymization;
deprecated BSON types (`Binary`, `RegExp`, `Symbol`, `Timestamp`, `Code`, `undefined`)
are only implicitly covered by `$unknownBsonType` without enumeration. `-0` doubles:
`JSON.stringify(-0)` emits `"0"`, losing the sign bit — `qtyHex` must be declared the
authoritative sign representation. Details in the findings.

### 5. Raw-unit preservation and M1–M5 — PASS

§5 (`:199-212`) preserves missing/null/empty/whitespace/case with `unitStoredType`,
no trim/lowercase/alias/NFC/classification at export. §9 (`:320-338`) restates M1–M5
in exact accordance with `docs/inventory-unit-owner-decisions.md` (M1 `:51-72`,
M2 `:76-99`, M3 `:103-127`, M4 `:131-162`, M5 `:166-188`); no policy is re-decided.

### 6. Read-only evidence — **CORRECTIONS REQUIRED (Medium-1, Medium-2)**

The layered structure (role → tool → logs → corroborating → prohibited profiling) is
the right architecture and correctly demotes opcounters to non-attributable context
(spec `:236-239`). Two precision problems make the current wording weaker than
claimed — see findings. The profiling prohibition (`:240-242`) is correct: the
profiler writes to `system.profile`, i.e. proving read-only via profiling would
itself write.

### 7. Sensitive-field leakage / indirect identifiers / Mixed traversal — PASS with one High

- Matrix contains no names, staff/customer/manager ids, order numbers, costs,
  payment data, or free text; `warnings[]` (which contain raw inventory ids) are
  excluded (spec `:94`); timestamps are excluded everywhere, so document ordering
  cannot leak temporal information.
- **Unbounded Mixed traversal is currently only implied, not guaranteed**: the
  deep-scan sentence (spec `:70`) restricts leaves to keys `unit`/`stockUnit`, but its
  own example cites `afterSnapshot.currentStock` — a non-unit key — so a reader cannot
  tell whether companion numeric keys are exported or the whole snapshot is. High-1
  resolves this with an explicit allow-list.
- Enum tokens (`status`, `type`, `reason`, `action`, `phase`, `source`, `station`,
  `kind`, `consumedTrigger`) are safe constants.

### 8. Manifest, digests, integrity, orphans, failure behavior — PASS with one Medium

Manifest contents, per-collection counts and digests, namespace count verification,
referential joins (including the shared `orderline` pair), orphan reporting
("reported, never dropped"), and count reconciliation are specified (spec `:248-270`).
Missing: explicit failure behavior when a digest or count mismatches at receipt
(Medium-3), and the sanitized file format is undefined (Medium-4).

### 9. Credential/key/dump handling — PASS

The procedure requires no sharing of credentials (typed locally, never pasted into
chat/scripts — spec `:275-277`), the HMAC key never leaves the owner's machine and the
mapping is never exported (`:113-116, 278-280`), the raw dump stays local and is
deleted after verification (`:283-284`), and the transfer carries only sanitized JSON
+ manifest. The manifest holds a key *fingerprint* (SHA-256 of the key), not the key.

### 10. Contradictions / ambiguities / missing tests / dependencies — see findings

Contradiction High-1; ambiguity Medium-1 (log capture), Medium-2 (role detail);
missing implementation artifacts are correctly declared (sanitizer and offline
validation script do not exist yet — spec `:278`, `:349-351`); dependency on tool
version behavior for `listDatabases` noted in Medium-2.

---

## Findings (ranked)

### Critical

None.

### High

**H1 — Mixed deep-scan scope is self-contradictory (spec :70; related :299-301, :308-310).**
The rule says the exporter exports "every leaf whose key is `unit` or `stockUnit`" but
the example cites `afterSnapshot.currentStock` (a non-unit key). Strict reading loses
the quantity pairing that snapshot drift evidence needs; loose reading could be read as
exporting entire snapshots — an unbounded traversal that could leak embedded
names/ids/costs inside `Mixed` documents (`lib/models/InventoryAudit.js:55-56`).
**Required correction:** replace the sentence with an explicit allow-list:

> "From `Mixed` snapshots, export **only** leaves whose key is one of
> `unit`, `stockUnit` (raw, R) or `currentStock`, `quantity`, `stockQuantity`,
> `requiredQuantity`, `availableQuantity`, `shortageQuantity`, `beforeStock`,
> `afterStock` (numeric, N), each with its exact dotted path and type tag per §4.
> Every other key inside a snapshot is excluded; unexpected key names are counted per
> path in the manifest as schema-drift evidence but are never exported."

**H2 — §4 type table gaps: Boolean, ObjectId, deprecated BSON types, `-0` (spec :183-195).**
`recipes.isActive` is an exported Boolean; all exported identifiers are ObjectIds that
are pseudonymized before serialization; deprecated types (`Binary`, `RegExp`,
`Symbol`, `Timestamp`, `Code`, `undefined`) can occur in drifted/Mixed data.
**Required correction:** add rows —

> "| **boolean** | JSON `true` / `false` — exact, no tag |"
> "| **ObjectId** | never emitted raw; its 24-byte hex is consumed only as pseudonymization input (§2) |"
> "| **Binary / RegExp / Symbol / Timestamp / Code / undefined (deprecated types)** | `{"$unknownBsonType": "<type code>"}` + raw leaf path recorded in the manifest |"

and append: "`qtyHex` is the authoritative representation for negative zero
(`-0`), which shortest-round-trip JSON emits as `0`."

### Medium

**M1 — Server-log capture mechanism is imprecise (spec :228-235).**
Default mongod logging does **not** record every command: per-command lines appear
only for slow operations (default threshold `slowOpThresholdMs` = 100 ms), and
`logLevel: 1` alone does not change that. As written, "confirms only find/list*
commands" is not demonstrable for a fast export. **Required correction:** name the
concrete community-edition mechanism —

> "For the export window the owner temporarily sets `slowOpThresholdMs: 0` via
> `setParameter` (every operation is then logged with its command shape, namespace and
> authenticated user), or equivalently raises COMMAND component verbosity; the owner
> filters the log by the export user's connection, archives the excerpt showing only
> `find`/`list*` commands, and restores the parameter afterwards. Log volume scales
> with the export; run the export per collection to keep windows bounded."

**M2 — Least-privilege role detail; `--oplog` privilege expansion (spec :218-225).**
The `read` role does not include cluster-scope `listDatabases`; mongodump commonly
issues `listDatabases` even when `--db` is given, so the role may be insufficient
depending on tool version. `--oplog` reads `local.oplog.rs`, requiring privileges
beyond the target database, and adds nothing to a point-in-time export of the audited
collections. **Required correction:**

> "Grant a custom role: `read` on the single approved database plus — only if the
> verified tool version requires it — the cluster-scope `listDatabases` action; record
> the role definition (name + privileges, never credentials) in the manifest. Do **not**
> use `--oplog`; it requires reading `local.oplog.rs` and is unnecessary for this
> snapshot export."

**M3 — Transfer-integrity failure behavior undefined (spec :270).**
"File digests … must match" does not state the consequence of a mismatch.
**Required correction:** "On any digest, count, or namespace-count mismatch at
receipt, the bundle is rejected in full and re-exported; a partially validated bundle
is never consumed by the audit."

**M4 — Sanitized file format undefined (spec :279-280).**
`sanitized/*.json` names no format, encoding, or ordering — the future audit parser
and digest reproducibility depend on it. **Required correction:**

> "One UTF-8 (no BOM) NDJSON file per collection, one document per line, documents
> sorted by their primary pseudonym for deterministic digests; plus one
> `manifest.json`. No temporal fields exist anywhere in the export (all timestamps are
> excluded), so deterministic ordering leaks no timing information."

### Low

**L1 — Orphaned unit entries in audit distributions (spec :262-265).**
State explicitly that orphaned rows' unit entries remain **counted** in the audit
distributions with an `orphan` flag — they are real stored data, and excluding them
would bias the measurement.

**L2 — Drift counters in the manifest (spec :248-258).**
Add per-path counts of `$unknownBsonType`, `$decimal128`/`$decimal128Hex`, and
non-string `unitStoredType` occurrences so schema drift is quantified without
re-opening the data.

**L3 — HMAC input serialization for non-ObjectId ids (spec :113-114).**
All pseudonymized fields are ObjectIds in current schemas; if drift yields string ids,
define the input as the exact stored value (ObjectId → hex; string → as-is) so the
namespace rule stays deterministic.

**L4 — `unitStoredType` naming (spec :206).**
Align the `<other BSON type>` placeholder with the §4 tag names so audit tooling has
one vocabulary.

---

## What is proven / not proven

**Proven by this review (source inspection):**
- Every exported field name and collection name exists in the current Mongoose schemas.
- `voids[].lineId` and `orders.items[].lineId` are the same identifier (source path
  verified end-to-end).
- The fingerprint signature, internal canonicalization, and recomputation caveats
  match the implementation exactly.
- The pseudonym/join/collision design is internally consistent and fail-closed.
- M1–M5 restatements match the approved decision record; the export performs no
  conversion, merge, rounding, or backfill (M1/M3/M5 respected by construction).
- The exclusion list covers all identified personal/order/payment/free-text data.

**Not proven (and not provable until execution):**
- That a future exporter implements this specification correctly — **no sanitizer or
  validation script exists yet** (declared in the spec, `:278`).
- That server logging will actually capture every command in practice — tool/version
  dependent (M1).
- That the production/real database schema matches repository HEAD (drift is
  handled by tags, but the audit has seen zero real documents).
- That the read-only role is actually created with least privilege — owner-side step.
- No real data was accessed, and no export capability exists in this repository.

---

## Prerequisites checklist for a later owner-operated export

1. ☐ Apply the four corrections (H1, H2, M1, M2) and the Medium/Low refinements to
   `docs/inventory-stored-unit-audit-export-spec.md`.
2. ☐ Owner approves the corrected specification by name.
3. ☐ Sanitizer/exporter script is separately authorized, source-reviewed, and
   offline-tested before any connection (none exists today).
4. ☐ Offline validation script (manifest digests, count reconciliation, orphan
   report, excluded-key absence check) is separately authorized.
5. ☐ Dedicated least-privilege read-only role created on the approved environment;
   role definition recorded (no credentials shared).
6. ☐ Owner names the approved target database explicitly (never guessed).
7. ☐ Log-evidence window configured (`slowOpThresholdMs: 0` or COMMAND verbosity)
   with a documented restore step.
8. ☐ Transfer channel agreed; digests verified at receipt; mismatch ⇒ full rejection
   and re-export.
9. ☐ Only then is `docs/inventory-stored-unit-audit.md` unblocked; until then the
   real stored-unit audit **remains BLOCKED**.

---

## Non-authorization statement

This review is read-only documentation. It does **not** authorize export execution,
database access, credential use, script creation, migrations, runtime integration,
deployment, or any change to `lib/`, `app/`, `scripts/`, `tests/`, fixtures, or the
reviewed specification. Producing this report created exactly one new file (this
document). The real stored-unit audit remains BLOCKED.
