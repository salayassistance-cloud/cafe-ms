# BONO Inventory — Phase 2, Step 5: Sanitized Real-Data Export Specification

**Status: SPECIFICATION ONLY — PREPARATION. NO EXPORT HAS BEEN PERFORMED.**

- Date: 2026-11-15
- Purpose: define a safe, minimal, privacy-preserving export that unblocks the real
  stored-unit audit (`docs/inventory-stored-unit-audit.md`).
- **The real stored-unit audit remains BLOCKED** until sanitized real data is supplied
  under this specification by a separately authorized, owner-operated export.
- **This document does NOT authorize**: database access, export execution, migrations,
  runtime integration, deployment, or any code/schema/test/fixture change. Approving
  this specification is approving a data-handling contract, not an execution.

Policy in force: the owner-approved M1–M5 decisions in
`docs/inventory-unit-owner-decisions.md` (see §10 for the verbatim-meaning restatement).
Synthetic-methodology context: `docs/inventory-stored-unit-disposable-audit.md`.

---

## 1. Collection and field export matrix

Legend: **P** = pseudonymize (HMAC-SHA256, §2), **R** = raw value verbatim (units:
never normalized, §5), **N** = numeric verbatim (type-preserving, §4),
**D** = derived by the exporter (hash only, §3), **E** = excluded entirely (§7).
All collection names are the explicit names registered in the models
(`inventoryitems`, `recipes`, `stockmovements`, `inventoryaudits`,
`inventoryreservations`, `orders`).

### 1.1 `inventoryitems`

| Field | Mode | Why it is needed |
|---|---|---|
| `_id` | P (ns `item`) | Join key for every other collection's item references |
| `unit` | R | **The audited field.** Missing/null/empty/whitespace/case preserved |
| `currentStock` | N | Availability context for requirement/impact sizing |
| `reservedStock` | N | Availability context (available = current − reserved) |
| `name`, `category`, `minimumStock`, `cost`, `supplier`, `status`, timestamps | E | Business/supplier data; no audited question needs them |

### 1.2 `recipes`

| Field | Mode | Why it is needed |
|---|---|---|
| `_id` | P (ns `recipe`) | Row identity for duplicate-row analysis |
| `ingredients[].inventoryItemId` | P (ns `item`) | Item join for unit comparison and M3 duplicate grouping |
| `ingredients[].quantity` | N | Exactness / `LOSSY_CONVERSION` evaluation (M5) |
| `ingredients[].unit` | R | **The audited field** |
| `isActive` | R | Segments active vs inactive recipes in counts |
| `menuItemId` | **E** | **Excluded: no audited question requires it.** Every audit cross-check is keyed on `inventoryItemId`; recipe↔order joins are not needed because recipe rows and order components are each compared independently against `inventoryitems.unit`, and fingerprint recomputation needs only `orderId` + item ids |
| timestamps | E | |

### 1.3 `stockmovements`

| Field | Mode | Why it is needed |
|---|---|---|
| `item` | P (ns `item`) | Item join |
| `unit` | R | **The audited field** — nullable; may be entirely missing in legacy rows |
| `quantity` | N | Uniformity check (movement quantity vs item stock unit) |
| `type` | R | Segments `IN`/`OUT`/`ADJUSTMENT` |
| `reason` | R | Segments Purchase/SaleDeduction/Waste/Correction uniformity |
| `unitCost`, `totalCost`, `notes`, `createdBy`, `refOrderId`, `idempotencyKey`, `supplier`, `voidedAt`, `voidReason`, `voidedBy`, timestamps | E | Financial, personal, free-text, order-linked data |

### 1.4 `inventoryaudits`

| Field | Mode | Why it is needed |
|---|---|---|
| `item` | P (ns `item`) | Item join |
| `unit` | R | **The audited field** — nullable; may be missing in legacy rows |
| `action` | R | Segments `ITEM_UPDATED` (the unit-edit hazard) from other actions |
| `quantityDelta`, `beforeStock`, `afterStock` | N | Stock-vs-unit drift evidence |
| `beforeSnapshot`, `afterSnapshot` | **Bounded deep-scan (Mixed)** | Untyped snapshots; the exporter walks them but exports **only** leaves matching the explicit allow-list below, each **with its exact dotted path**, raw value and type tag per §4. Nothing else inside a snapshot is exported |

**Mixed snapshot allow-list (H1 — exact, bounded, fail-closed).** For
`beforeSnapshot`/`afterSnapshot` (and any other `Mixed` field listed in the matrix,
§8.4), the exporter exports only these leaf keys:

| Leaf key | Mode | Notes |
|---|---|---|
| `unit`, `stockUnit` | R | The audited field; raw, never normalized (§5) |
| `currentStock`, `quantity`, `stockQuantity`, `requiredQuantity`, `availableQuantity`, `shortageQuantity`, `beforeStock`, `afterStock` | N | Numeric companions needed for stock-vs-unit drift pairing; type-preserving per §4 |

Rules:

- Every exported snapshot leaf carries its **exact dotted path** (e.g.
  `beforeSnapshot.unit`, `afterSnapshot.currentStock`) and its §4 type tag.
- **Missing and null remain distinct** inside snapshots: an absent key is absent from
  the output (recorded only in the per-path `missing` counter), and a `null` value is
  exported as `null` — never merged, never filled.
- **Every other key — including arbitrary free text, names, costs, nested ids, and any
  key not in the allow-list — is excluded entirely**, whatever its depth. Unexpected
  key names are **counted per dotted path prefix in the manifest as schema-drift
  evidence (L2)** but their values are never exported.
- The allow-list is fixed by this specification; the exporter does not extend it at
  run time. A key that looks unit-like but is not listed (`units`, `unitName`, …) is
  excluded and counted as drift.
| `actorId`, `actorRole`, `oldCost`, `newCost`, `unitCost`, `totalCost`, `supplier`, `reason`, `correlationId`, timestamps | E | Actor identity, costs, free text |

### 1.5 `inventoryreservations`

| Field | Mode | Why it is needed |
|---|---|---|
| `_id` | P (ns `reservation`) | Reservation identity |
| `orderId` | P (ns `order`) | Joins `orders._id`; fingerprint input relationship |
| `status` | R | Lifecycle segmentation (RESERVED / APPROVAL_REQUIRED / APPROVED / CONSUMING / CONSUMED / RELEASED / NO_INVENTORY) |
| `items[].inventoryItemId` | P (ns `item`) | Item join |
| `items[].unit` | R | **The audited field** |
| `items[].requiredQuantity`, `reservedQuantity`, `shortageQuantity`, `availableAtDecision`, `consumedQuantity` | N | M3 merge re-computation; shortage fingerprint inputs |
| `requirementFingerprint`, `shortageFingerprint` | R (opaque SHA-256 hex) | Stored hashes for M2 comparison; hashes reveal nothing |
| `approval.requirementFingerprint`, `approval.shortageFingerprint` | R | Stored-approval pairing (M2) |
| `approval.shortages[].inventoryItemId` | P (ns `item`) | Item join |
| `approval.shortages[].unit` | R | Approved-shortage unit consistency |
| `approval.shortages[].requiredQuantity`, `availableQuantity`, `shortageQuantity` | N | Shortage audit |
| `consumedTrigger` | R | Distinguishes PREPARING (primary) from PAYMENT (legacy/fallback) consumption |
| `voids[].phase`, `voids[].source`, `voids[].station` | R | Void segmentation |
| `voids[].lineId` | **P (ns `orderline`)** | **Same identifier space as `orders.items[].lineId`** — verified in source: `cancelOrderItem` validates the id against the order's own `items[].lineId` (`lib/orderService.js:1380,1396-1404`) and writes that exact ObjectId into the reservation void (`:1541` → `appendPostPreparationVoid`, `lib/inventoryReservationService.js:1069`). One stable `orderline` namespace for both preserves line-level void↔order-line joins. Null stays null (legacy whole-order voids) |
| `voids[].items[].inventoryItemId` | P (ns `item`) | Item join |
| `voids[].items[].unit` | R | Void-side unit integrity (default `""` per schema) |
| `voids[].items[].quantity` | N | Void quantity audit |
| `orderNumber`, `approval.managerId`, `approval.reason`, `approval.approvedAt`, `decisionAt`, `consumedAt`, `consumedBy`, `releasedAt`, `releaseReason`, `voidedAt`, `voidReason`, `voidedBy`, `voids[].at`, `voids[].by`, `voids[].reason`, `warnings[]`, timestamps | E | Order/staff identifiers, free text, dates not needed for the unit audit |

### 1.6 `orders` (only audited component/line relationships)

| Field | Mode | Why it is needed |
|---|---|---|
| `_id` | P (ns `order`) | Join to `reservation.orderId` |
| `items[].lineId` | P (ns `orderline`) | Shared with `voids[].lineId` (see §1.5) |
| `items[].components[].componentId` | P (ns `component`) | Row identity |
| `items[].components[].kind` | R | Filter to `PRICED_COMPONENT` only |
| `items[].components[].inventoryItemId` | P (ns `item`) | Item join |
| `items[].components[].stockQuantity` | N | Exactness evaluation |
| `items[].components[].stockUnit` | R | **The audited field** |
| Everything else — `orderNumber`, `tableNumber`, `waiterName`, `waiterId`, `waiterNumber`, `waiterInfo`, kitchen/barista/hotDrink staff ids, `name`, `note`, `price`, `quantity`, `unitPrice`, `lineSum`, `costSnapshot`, `totalCost`, `type`, `isExternal`, `itemId`, `cancelled*`, `cancelReason`, order status/dates, payment fields, timestamps | E | Customer/staff/payment/order business data |

---

## 2. Pseudonymization (stable, keyed, one-way)

1. **Algorithm:** HMAC-SHA256 keyed by a 32-byte owner-generated random key. Input:
   `"<namespace>|<raw-id-hex>"`. Output: first 24 hex characters (ObjectId-shaped, so
   join logic round-trips unchanged). The key never leaves the owner's machine and the
   mapping table is never exported.

   **Exact input serialization (L3).** The HMAC message is the UTF-8 byte sequence of
   one of the following, unambiguously separated so no two distinct stored values can
   produce the same message:

   | Stored identifier form | HMAC message |
   |---|---|
   | ObjectId (all pseudonymized fields in current schemas) | `<namespace>` + `|oid|` + the id's 24 lowercase hex characters |
   | String id (possible only under schema drift) | `<namespace>` + `|str|` + the exact stored string value (byte-exact, no trimming or case change) |
   | Any other type at an id position | **fail closed** — the export aborts; drift counters record it (§7.1) |

   Rules: the type discriminator (`oid` / `str`) prevents an ObjectId-hex string and a
   literal string of the same characters from ever colliding; the namespace prefix
   prevents cross-namespace identity confusion; input values are used exactly as
   stored — no normalization, reordering, or casing change. Stability and collision
   checks (§2.5) apply unchanged to every input form, and `distinctRawCount` /
   `distinctPseudonymCount` remain per namespace. The key and the raw→pseudonym
   mapping are never exported or logged (only the SHA-256 key fingerprint appears in
   the manifest).
2. **Namespaces:** `item`, `order`, `orderline`, `component`, `recipe`, `reservation`.
   Identical real IDs in the same namespace map identically everywhere. The same real
   `InventoryItem._id` therefore yields one pseudonym across `recipes`,
   `stockmovements`, `inventoryaudits`, `inventoryreservations`, and `orders`.
3. **Shared `orderline` namespace:** `orders.items[].lineId` and
   `inventoryreservations.voids[].lineId` are the same identifier (source-verified,
   §1.5) and MUST share the `orderline` namespace and one mapping.
4. **Null/missing stay null/missing** — never pseudonymized into fabricated ids.
5. **Collision checks (mandatory, fail-closed):** after mapping, the exporter asserts:
   - per namespace: the map raw→pseudonym is injective —
     `count(distinct raw ids) === count(distinct pseudonyms)`;
   - no two distinct raw ids in the same namespace share a truncated hash;
   - every emitted pseudonym is unique **globally across all namespaces**.
   On any violation the exporter **aborts the entire export with an explicit error —
   no partial output, no silent remap, no silent merge of identities**.
   Probability note: 96-bit truncation makes accidental collision negligible
   (~2⁻⁹⁶ per pair), but detection is required because a collision would silently
   corrupt join semantics. The manifest records `distinctRawCount` /
   `distinctPseudonymCount` per namespace for offline re-verification.

---

## 3. Fingerprint behavior (exact)

Source of truth: `buildRequirementFingerprint(orderId, items)` at
`lib/inventoryReservationRules.js:98-110` (re-exported at
`lib/inventoryReservationService.js:52`):

```js
buildRequirementFingerprint(orderId, items)
// rows: String(it.inventoryItemId || ""), unit: normalizeUnit(it.unit)  // trim+lowercase
//       qty: round3(it.requiredQuantity ?? it.quantity)                // Math.round(v*1000)/1000
// filter: id truthy && qty > 0
// sort by `${id}:${unit}` localeCompare
// rows joined "id:unit:qty.toFixed(3)" with "|"
// sha256( `${String(orderId)}|${rows}` )
```

Every runtime caller passes `items = [{ inventoryItemId, unit, requiredQuantity }]`
(post-`validateRequirements`, post-merge rows whose `unit` is the stock unit)
(`lib/inventoryReservationService.js:324,368,386,452,492,513,643,696,798,967`).

**Exporter rules:**

- The derived field `recomputedRequirementFingerprint` is computed by calling
  `buildRequirementFingerprint(realOrderId, storedItems)` on the reservation's stored
  `items[]` **verbatim** — fields `{ inventoryItemId, unit, requiredQuantity }`, real
  ids, real `orderId` string — **before any pseudonymization**.
- **No pre-rounding** (`round3` is applied inside the function), **no pre-sorting**
  (the function sorts), **no pseudonym substitution** (pseudonyms change the hash).
- The audit compares the **stored hash** with the **recomputed hash**; it never
  re-computes fingerprints from pseudonyms.
- **A stored-vs-recomputed mismatch is audit evidence** (M2 / historical drift), not an
  export failure. Rows may have been mutated after their fingerprint was written, or
  written by older code paths without the merge — both are findings, not defects.
- `buildShortageFingerprint` (`lib/inventoryReservationRules.js:112-132`) may likewise
  be derived from exported rows because its inputs (`requiredQuantity`,
  `availableAtDecision`, `shortageQuantity`) are all in the export matrix.

---

## 4. Type-preserving numeric serialization

Universal rule: **never silently coerce** — no double→int, no int→double, no
numeric→string, no Decimal128→float, no implicit rounding anywhere.

| BSON type | Serialization |
|---|---|
| **double** (all audited schema quantities are doubles) | JSON number via shortest round-trip decimal representation (ECMAScript `JSON.stringify` semantics — reparses to the bit-identical float64) **plus** `qtyHex`: IEEE-754 big-endian hex of the 8 bytes. `qtyHex` is emitted **only** for BSON doubles |
| **int32** | `{"$int32": <n>}` — JSON integer, exact; type preserved by the tag |
| **int64 / Long** | `{"$int64": "<exact decimal string>"}` — string form survives values beyond ±2^53 |
| **decimal128** | `{"$decimal128": "<exact canonical decimal string>"}` (Decimal128 `toString`, exact) **plus** `{"$decimal128Hex": "<16-byte big-endian hex>"}` where available for byte-level verification |
| **date** | `{"$date": "<ISO-8601 UTC>"}` |
| **boolean** | JSON `true` / `false` — exact, no tag (e.g. `recipes.isActive`) |
| **ObjectId** | Never emitted raw. The 12-byte value's 24-hex-character form is consumed only as pseudonymization input (§2); the exported value is the pseudonym. An ObjectId in a non-pseudonymized position is a schema drift event: exported as `{"$unknownBsonType":"objectId-not-in-matrix"}` with the path recorded in the manifest |
| **Binary / RegExp / Symbol / Timestamp / Code / undefined (deprecated BSON types)** | `{"$unknownBsonType": "<type code>"}` with the raw leaf path recorded in the manifest (L2 counter); never coerced to string/number/null |
| **null / missing** | `null` / key absent — distinct states, never merged |
| **MinKey / MaxKey / other or unknown BSON types** (possible only inside `Mixed`) | `{"$unknownBsonType": "<type code>"}` with the raw leaf path recorded in the manifest; the exporter stops guessing |

Special double values: NaN / ±Infinity are emitted as
`{"$special":"NaN"}` / `{"$special":"Infinity"}` / `{"$special":"-Infinity"}`
(invalid as bare JSON).

Negative zero: `JSON.stringify(-0)` emits `0`, losing the sign bit. **`qtyHex` is the
authoritative exact IEEE-754 representation for every BSON double, including `-0`**
(`0000000000000080` big-endian); the JSON number is the human-readable companion.
`qtyHex` is emitted **only** for BSON doubles — never for int32, int64, or decimal128.

Unknown or unsupported BSON types fail closed via the `{"$unknownBsonType": …}` tag
(path recorded, value never guessed or coerced). There is **no silent coercion
anywhere in §4**.

---

## 5. Raw unit preservation (no normalization)

- Unit values are exported **byte-exact**: no trimming, no lowercasing, no
  NFC/NKD Unicode normalization, no alias conversion, no default filling, no
  classification at export time.
- Unit value states use **one consistent vocabulary (L4)**, identical in exported
  records, manifest counters (§7.1), and audit interpretation:
  - `unitStoredType` — the BSON type as stored:
    `"missing"` (key absent) | `"null"` | `"string"` | `"nonString:<tag>"` where
    `<tag>` is the exact §4 tag name (`nonString:int32`, `nonString:$unknownBsonType`,
    …). The `<tag>` form keeps one vocabulary with §4 instead of the previous
    unspecified `<other BSON type>` placeholder.
  - `unitState` — populated **only** when `unitStoredType` is `"string"`:
    `"value"` | `"empty"` (zero-length) | `"whitespace"` (only Unicode whitespace
    characters, zero or more, as stored). A padded value such as `" g "` is
    `"value"` with its padding preserved verbatim.
- The four audit-visible states remain distinct per entry: **missing** (key absent),
  **null**, **empty string `""`** (`string` + `empty`), **whitespace-only** (`string` +
  `whitespace`) — never merged, never filled.
- Case variants (`kg`/`KG`), padded variants (`" g "`), and unknown values
  (`oz`, `lb`, `gm`, `tbsp`, `tsp`, `dozen`, `bottle`, `cup`, …) are exported as
  distinct raw values. Classification against the adapter policy (M4) happens only
  during the offline audit — never during export.
- Values are verified as valid UTF-8 (BSON guarantee) and carried verbatim through
  JSON escaping.

---

## 6. Read-only evidence (layered)

1. **Server-enforced impossibility (strongest):** the export runs under a dedicated
   MongoDB user with a **custom read-only role** scoped to the single approved database
   only — no `readWrite`, no `dbAdminAnyDatabase`, no cluster-wide privileges beyond
   the single `listDatabases` action described below. Any write attempt is rejected by
   the server itself; refused-attempt errors surface in server logs. Writes become
   *impossible*, not merely unobserved.

   **Role definition detail (M2):** the built-in `read` role does **not** include
   cluster-scope `listDatabases`, yet `mongodump` commonly issues `listDatabases` even
   when `--db` is given. The role is therefore a custom role:
   `read` on the approved database plus — **only if the verified tool version requires
   it** — the single cluster-scope action `{resource: {cluster: true}, actions:
   ["listDatabases"]}`. Scope and limitation: `listDatabases` returns database *names
   and sizes only*, never document data, so this does not broaden data access; the
   action is omitted when the verified `mongodump` version does not require it.
   The role definition (name + privilege document, **never credentials**) is recorded
   in the manifest, and the role is dropped after the export window closes.
2. **Restricted extraction tooling:** extraction uses `mongodump` only. Its command
   surface is exclusively `listDatabases`, `listCollections`, `listIndexes`, `find`;
   the tool contains no write path. Tool name + version are recorded in the manifest.
   Sanitization runs **offline** on the dump directory; no second live connection
   exists. **`mongodump --oplog` is explicitly prohibited (M2):** it reads
   `local.oplog.rs`, which requires privileges far beyond the approved target database
   and metadata operations, and a point-in-time consistent snapshot of the audited
   collections is unnecessary for this audit. Dump is run per database (`--db`) with
   the approved collection set; no `--oplog`, no `--gzip` requirement either way.
3. **Session-scoped server log evidence (M1 — exact mechanism and sequence).** Default
   mongod slow-operation logging does **not** record every command: per-command log
   lines appear only when an operation exceeds `slowOpThresholdMs` (default 100 ms), and
   raising `logLevel` alone does not change that. A fast export would therefore leave
   no per-command log evidence by default. The approved mechanism is:

   1. **Activation:** before the export window, the owner temporarily sets
      `db.adminCommand({setParameter: 1, slowOpThresholdMs: 0})` (or the equivalent
      `--setParameter slowOpThresholdMs=0` at startup) so every operation — however
      fast — is logged with its command shape, namespace, and authenticated user. This
      is a server *parameter* change, **not a data write**. Optionally raise the
      `COMMAND` component verbosity for finer-grained command shape capture.
   2. **Evidence collection:** during the window the owner notes the exact start/end
      UTC times and, where feasible, the export user's connection id(s); the export
      runs under the §6.1 custom role.
   3. **Verification:** after the export, the owner filters the mongod log to the
      window and the export user's connections and confirms that the only commands
      issued were `find` / `listCollections` / `listIndexes` / `listDatabases` — no
      write, no administrative command beyond the parameters in §6.1–6.2. The log
      excerpt (with connection/user context) is archived as evidence.
   4. **Restoration:** the owner restores the prior parameter value
      (`slowOpThresholdMs` back to its original setting, verbosity lowered) and
      records activation and restoration timestamps in the manifest. If commands
      outside the approved set appear in the window, the export is treated as failed
      evidence and is re-run after investigation; the sanitized data from that window
      is not used.
   5. **Log volume note:** with `slowOpThresholdMs: 0` every operation is logged, so
      log volume scales with the export; running the dump per collection (or in
      bounded batches) keeps the window short. If MongoDB Enterprise auditing is
      available, an audit filter on the export user for write actions is a drop-in
      improvement (Enterprise-only; optional).
4. **Corroborating evidence only (explicitly non-attributable):** per-collection
   document counts immediately before/after (equality expected), and the server-wide
   `opcounters` delta — retained as context only, **never as attributable proof**,
   because opcounters are shared across all clients.
5. **Prohibited technique:** `db.setProfilingLevel(2)` is **not** used — the profiler
   writes to `system.profile`, i.e. it would itself perform database writes in order to
   prove read-only behavior.

---

## 7. Manifest, integrity, completeness, transfer, exclusions

### 7.1 Manifest (`manifest.json`)

- Export timestamp (UTC), tool name + version, sanitizer version, source environment
  label (e.g. "local dev") — **no host, no URI, no credentials**; database name only if
  the owner approves; collection filter statement ("all documents, no filter");
  pseudonym key **fingerprint** (SHA-256 of the key — verifies determinism without
  revealing the key).
- Per collection: documents read, documents written, entry counts per audited unit
  path, `distinctRawCount`/`distinctPseudonymCount` per pseudonym namespace, and the
  SHA-256 digest of each sanitized output file.
- **Drift counters (L2)** — counts only, never values, so no sensitive data is exposed:
  - per collection and per dotted path: `unknownBsonTypeCount` (occurrences of
    `{"$unknownBsonType": …}`, tallied by BSON type code), `decimal128Count`
    (occurrences of `$decimal128`, plus `decimal128HexCount` where the byte form was
    available), and `unitStoredTypeCount` tallied by the §5 vocabulary
    (`missing` / `null` / `string` / `nonString`);
  - per `Mixed` snapshot path: the allow-listed leaf counts plus
    `unexpectedKeyCount` per unlisted key name (key name only, value never exported);
  - `orphanCount` per reference path (§7.2).
  Calculation: the sanitizer increments each counter exactly once per observed leaf
  during its single pass; counters are derived only from type tags, key names, and
  state buckets — never from raw values — so the manifest itself carries no item,
  order, staff, or business data.
- Pre/post server `opcounters` diff and pre/post document counts (corroborating, §6).

### 7.2 Referential integrity (offline, post-transfer)

- Every pseudonym referenced in `recipes`, `stockmovements`, `inventoryaudits`,
  `inventoryreservations`, `orders` resolves to an exported `inventoryitems`
  pseudonym; orphan counts are **reported, never dropped** (orphans are themselves
  evidence of dirty data).
- `reservation.orderId` ↔ `orders._id` join coverage reported; `voids[].lineId` ↔
  `orders.items[].lineId` join coverage reported (shared `orderline` namespace).
- File digests in the manifest must match the transferred files. **Receipt validation
  is fail-closed (M3):** on **any** digest mismatch, missing file, unexpected extra
  file, or document/count/namespace-count mismatch, the **entire bundle is rejected**
  — no partial acceptance, no audit from an incomplete bundle, no per-file rescue.
  The owner corrects the cause and performs a **new verified transfer**; the audit may
  consume only a bundle whose every check passes.
- **Orphan records are kept, marked, and counted (L1):** rows whose pseudonymized
  item/order/line reference does not resolve within the export remain in the export
  **with an explicit `orphan: true` flag** on the affected record and an orphan count
  per reference path in the manifest. Orphans are real stored data — silently
  dropping them would bias the audit distributions, and fabricating or repairing
  missing relationships is prohibited. The audit counts orphan-flagged unit entries
  inside its distributions rather than excluding them.
- Count reconciliation: total unit entries per path = sum of state buckets
  (§5 `unitStoredType` vocabulary).

### 7.3 Safe owner-operated transfer

1. Owner (on the approved environment) creates/uses the dedicated least-privilege
   read-only user; credentials are never shared in chat or scripts.
2. Owner runs `mongodump` against the approved database only, to a local directory;
   the URI is typed locally, never pasted into chat or scripts.
3. Owner runs the sanitizer (a future, separately authorized offline script — none
   exists yet) with a locally generated random key; it emits the NDJSON files and
   `manifest.json` in the §7.5 format and never emits the key, the dump, or the
   mapping table.
4. Owner spot-checks: manifest digests, raw unit samples, and absence of excluded
   field names (automated check against the §1 exclusion list).
5. Owner transfers **only** the sanitized NDJSON files + `manifest.json`; the key and
   dump stay local and are deleted by the owner after verification.

### 7.4 Hard exclusion list

Credentials/secrets/connection-string-shaped strings (asserted absent by key-name
check), payment fields and amounts, customer/waiter/staff/manager identifiers and
names, `waiterInfo`, supplier references, free-text `notes`/`reason`/`warnings`
(unreviewable), order business fields (`tableNumber`, prices, totals, `unitCost`,
`totalCost`, `costSnapshot`), `idempotencyKey`, unrelated order metadata (status,
dates, cancellation data), `recipes.menuItemId`, `orders.items[].itemId`.

### 7.5 Sanitized output file format (M4)

- **Encoding:** UTF-8, **no BOM** (BOM bytes would shift digests and violate NDJSON).
- **Structure:** NDJSON — one collection per file (`sanitized/<collection>.ndjson`),
  one JSON document per line, **LF (`\n`) line endings only**, a trailing newline after
  the final record. `manifest.json` is a pretty-printed UTF-8 JSON object (no BOM).
- **Deterministic ordering:** within each file, records are **sorted ascending by
  their primary pseudonym** (the collection's row-identity pseudonym — `_id`'s
  namespace pseudonym; for `orders`, the `order` pseudonym) as a plain byte-wise
  ASCII comparison of the 24-hex-character pseudonym strings. Ties are impossible:
  cross-namespace pseudonym uniqueness (§2.5) plus per-collection row identity means
  two records of one collection cannot share a primary pseudonym. No temporal fields
  exist anywhere in the export (all timestamps are excluded), so deterministic
  ordering leaks no timing information.
- **Stable serialization:** each record is serialized with fixed key order (the order
  fields appear in the §1 matrix; allow-listed snapshot leaves in ascending dotted-path
  order) using the §4 tags. The same sanitizer version + same input dump must always
  produce byte-identical output; digest reproducibility is verified by regenerating
  once locally and comparing SHA-256 before transfer.

---

## 8. Remaining schema ambiguities (export-time handling required)

1. **`inventoryaudits.beforeSnapshot`/`afterSnapshot` are `Mixed`** — nested unit
   paths cannot be enumerated statically; the bounded deep-scan with the explicit
   dotted-path allow-list (§1.4, H1) is mandatory.
2. **Legacy missing fields:** `StockMovement.unit`, `InventoryAudit.unit`,
   `Order.components[].stockUnit` are later additions/nullable — "missing" is a
   first-class exported state (§5 vocabulary).
3. **Schema drift:** production documents may not match repository HEAD (Decimal128,
   int64, unexpected subdocument shapes) — covered by the §4 type tags; `collStats`
   (read-only) in the manifest supports count/size verification.
4. **Legacy `isExternal` order lines** may carry inventory linkage in an undocumented
   shape: only allow-listed keys (`unit`, `stockUnit`, §1.4) found anywhere inside
   `Mixed` data — including outside the standard component path — are exported with
   their exact dotted path; every other unlisted key is counted as drift, never
   exported (§1.4).
5. **Fingerprint drift:** stored `items[]` may have been mutated after their
   fingerprint was written (or written by older code without the merge) — mismatch is
   reported as audit evidence, not treated as an export defect (§3).
6. **`round3` float semantics:** `Math.round(v*1000)/1000`; the exporter must feed
   stored rows verbatim so the fingerprint input equals what the service hashed at
   write time.

---

## 9. Policy in force — M1–M5 (approved meaning preserved)

These decisions are owned by `docs/inventory-unit-owner-decisions.md`; the export and
the audit must operate within them without re-deciding them:

- **M1** — Conversion takes effect on the next normal reconciliation; no migration or
  backfill is performed.
- **M2** — If an APPROVED order's requirement fingerprint changes, its approval is
  invalid and fresh Manager approval is required; never preserve or manufacture
  approval for changed requirements.
- **M3** — Convert each supported demand quantity exactly into its InventoryItem stock
  unit, then merge requirements deterministically per inventory item; sum only exact,
  representable quantities; never merge incompatible dimensions or rejected units.
- **M4** — Add no new aliases; unknown and ambiguous units remain fail-closed for
  cross-unit conversion; identical unit text retains existing V1 same-unit behavior;
  bottle/can and other container nouns are never inferred as pcs.
- **M5** — V1 supports three decimal places at the integration boundary; a converted
  quantity that cannot be represented exactly at three decimals is rejected with a
  warning; never round to force representability.

---

## 10. Status and non-authorization

- **Preparation only.** This is a data-handling contract for owner review.
- **No real export has been performed.** No database was connected while producing this
  document; no sanitized or raw data exists in this repository from the real database.
- **The real stored-unit audit remains BLOCKED** until sanitized real data is
  separately and safely supplied per §7 by the owner.
- This documentation approval does **not** authorize: database access, export
  execution, migrations, backfills, runtime integration, deployment, schema changes,
  or any modification to `lib/`, `app/`, `scripts/`, `tests/`, or fixtures.
- Synthetic-methodology evidence (`docs/inventory-stored-unit-disposable-audit.md`)
  remains clearly labeled SYNTHETIC / DISPOSABLE — it is not production evidence.
