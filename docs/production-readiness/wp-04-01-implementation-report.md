# WP04-01 — Implementation Report

Status: **IMPLEMENTED AND TESTED — WP04-02+ NOT AUTHORIZED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Package: **WP04-01 — Rule registry, evidence projection, fingerprint** (C1 / AUTH-1)
Authorization: owner authorization for **WP04-01 only**; technical reviewer: **ChatGPT (AI Technical Reviewer)**. This designation is **not** independent human verification and **not** a production gate approval.
Companions: `wp-04-implementation-blueprint.md`, `wp-04-implementation-work-packages.md`, `wp-04-implementation-acceptance-matrix.md`, `wp-04-00-authorization-record.md`

> WP04-01 is complete. No database, staging, production, `.env`, secret, route, worker, scheduler, index, migration, or schema change was made. No stock, payment, accounting, reservation, or order record was mutated. Inventory V2 remains inactive. **No gate is signed, passed, or waived.** G-REC-1, G-REC-2, G-REC-3, G-AUD-1, G-GOV-1, G-IDX-1, G-DB-1, G-DB-2, G-DB-4, and G-PAY-2 remain **UNSIGNED**; G-PAY-1 remains **BLOCKED**.

---

## 1. Scope delivered

| Deliverable | Status |
|---|---|
| D01–D10 read-only detection rule registry | **Implemented** |
| Deterministic, allowlisted evidence projection | **Implemented** |
| Stable, versioned evidence fingerprint | **Implemented** |
| Focused DB-free tests for all three | **Implemented — 43 tests, 43 pass** |

### 1.1 Out of scope (not implemented)

- No classifier / finding evaluation (WP04-02).
- No scanner, CLI, read-only guard, or database read (WP04-03).
- No fixtures package (WP04-04) beyond the focused WP04-01 tests.
- No recovery collection, model, repository, lease, worker, queue, scheduler, or persistence.
- No reconciliation against real orders or inventory.
- No schema, API, route, index, migration, seed, or runtime configuration change.
- No Inventory V2 activation; no WP-13 or WP-09.

---

## 2. Files created

| File | Purpose | Bytes |
|---|---|---|
| `lib/recovery/rules/registry.js` | Frozen D01–D10 metadata, sub-codes, evidence fields, lifecycle, review roles | 30,767 |
| `lib/recovery/evidence.js` | Allowlisted projection, typed errors, bounds, ID/date/number normalization | 19,594 |
| `lib/recovery/fingerprint.js` | Canonical JSON, narrow fingerprint payload, SHA-256, versioning | 7,469 |
| `tests/wp04-01-recovery-core.test.mjs` | 43 focused DB-free tests across the three modules | 27,093 |

No existing file was modified. `lib/recovery/` did not exist before this package.

---

## 3. Architectural decisions and module boundaries

### 3.1 Why these locations

The repository convention is `lib/<domain>Service.js` for services and `lib/models/<Name>.js` for models. WP04-01 introduces no service runtime and no model, so it uses a narrow domain folder:

```text
lib/recovery/
  rules/registry.js   pure metadata; no imports
  evidence.js         pure projection; no imports
  fingerprint.js      pure hashing; imports node:crypto + ./evidence.js only
```

`lib/recovery/rules/` keeps the vocabulary separate from the projection and hash, so WP04-02 can add a classifier beside the registry without changing the registry file.

### 3.2 Registry boundaries

- Exactly ten entries, ordered D01–D10, exported as a deeply frozen array.
- A null-prototype `RULES_BY_ID` map plus an own-property guard prevents `__proto__`/prototype-key lookups from resolving to `Object.prototype`.
- `getRuleDefinition(id)` returns a frozen entry or `null`; it never constructs a rule from caller input.
- Every rule carries: stable id, version, title, description, required class, R-map, severity/confidence ranges, evidence levels, authoritative source fields, correlation identity, lifecycle statuses, false-positive exclusions, human-review roles, `readOnly: true`, `autoRecovery: "PROHIBITED"`, `createsRecoveryTask: false`, task-creation policy, and stable sub-codes.
- No `R9`/`R10` appears anywhere. D02 and D09 carry `findingCodeOnly: true` and `durableClass: false`.
- D06 carries `taskCreationPolicy: "ALERT_ONLY"` and `createsRecoveryTask: false`.

### 3.3 Evidence projection boundaries

- Builds a new plain object from an explicit allowlist; source objects are never spread, serialized, or returned.
- Missing/null values become explicit `null` (or `[]` for child arrays).
- Invalid values raise a typed `EvidenceProjectionError` with a stable code and field path; messages never include the source value.
- Safety bounds fail closed (`EVIDENCE_BOUND_EXCEEDED`) rather than silently truncating.
- Quantities keep exact numeric semantics; numeric strings are rejected rather than coerced.
- Identifiers preserve type: string stays string, safe integer stays number, BSON ObjectId becomes `{ $oid: "<24 hex>" }`; other objects are rejected.
- Dates normalize to ISO-8601 UTC; invalid dates are rejected.
- A recursive sensitive-key scan is a defense-in-depth check on the finished projection.

### 3.4 Fingerprint boundaries

- Imports only `node:crypto` and the local `EVIDENCE_SCHEMA_VERSION`. `node:crypto` is a pure in-process hashing primitive, not network or filesystem I/O.
- Canonical JSON: sorted keys, no whitespace, explicit `null`, stable string escaping, ECMAScript number formatting.
- Rejects values that cannot be canonicalized deterministically (NaN, Infinity, Date, class instances, functions, symbols, bigint).
- Sorts movements, reservation items, inventory rows, and voids by canonical form so database read order cannot change the digest.
- Returns `{ version, algorithm, schema, digest }`; the digest is 64 lowercase hex characters.

### 3.5 Dependency inspection

Source-contract tests assert that the three modules:

- do not import Mongoose, MongoDB, a connection helper, any write-capable V1 service, or any V2 server module;
- contain no `insertOne`/`updateOne`/`deleteOne`/`findOneAndUpdate`/`bulkWrite`/`createIndex`/`syncIndexes`/collection operation;
- do not read `process.env`, the filesystem, the network, or spawn a process;
- do not reference `inventory_v2`, `inventoryMode`, or `orderVersion`;
- export no write-capable function.

---

## 4. D01–D10 implementation mapping

| Rule | Approved class | R-map | Severity | Confidence | Evidence | Task policy | Sub-codes |
|---|---|---|---|---|---|---|---|
| D01 | PAID missing deduction | R1, R6 | CRITICAL | MEDIUM–HIGH | E2 | DEFERRED | 7 |
| D02 | Deduction without payment evidence | R7 (finding code, not R9) | HIGH–CRITICAL | MEDIUM–HIGH | E2 | DEFERRED | 5 |
| D03 | Duplicate stock movements | R5 | CRITICAL | HIGH | E2 | DEFERRED | 4 |
| D04 | Duplicate/inconsistent reservations | R5, R7 | HIGH–CRITICAL | MEDIUM–HIGH | E2 | DEFERRED | 10 |
| D05 | Expired/abandoned reservations | R2, R7 | MEDIUM–HIGH | MEDIUM–HIGH | E2 | DEFERRED | 4 |
| D06 | Stuck `CONSUMING` | R3 | HIGH–CRITICAL | HIGH | E2 | **ALERT_ONLY** | 5 |
| D07 | Partial multi-station deductions | R4, R6 | HIGH–CRITICAL | MEDIUM–HIGH | E2 | DEFERRED | 4 |
| D08 | Cancelled items / inconsistent inventory | R5, R7 | MEDIUM–HIGH | MEDIUM–HIGH | E2 | DEFERRED | 6 |
| D09 | Payment verification/rejection inconsistency | R1, R7 (finding code, not R10) | HIGH–CRITICAL | MEDIUM–HIGH | E2 | DEFERRED | 10 |
| D10 | Missing/malformed/conflicting evidence | R1–R8 | HIGH–CRITICAL | MEDIUM–HIGH | E1–E2 | DEFERRED | 12 |

Registry sub-codes are the exact codes named by `wp-04-detection-rule-matrix.md`, including `ORPHAN_DEDUCTION`, `TERMINAL_DEDUCTION_NO_VOID`, `DUPLICATE_MOVEMENT_IDENTITY`, `DUPLICATE_RESERVATION`, `HOLD_ON_TERMINAL_ORDER`, `CONSUMING_PARTIAL`, `CONSUMED_MOVEMENT_MISMATCH`, `CANCELLED_HOLD_NOT_RELEASED`, `PENDING_WITH_PAID_AT`, `EVIDENCE_DRIFT`, and related codes.

Lifecycle status arrays use the exact enums from `lib/models/Order.js` and `lib/models/InventoryReservation.js`. D06 applies only to `CONSUMING`; D01 only to `PAID`; D02 excludes `PAID` to avoid double-reporting with D01.

---

## 5. Evidence projection field policy

### 5.1 Included

| Entity | Included fields |
|---|---|
| Order | `_id`, `orderNumber`, `status`, `paidAt`, `paymentMethod`, `paymentAccountId`, payment workflow timestamps/actor ids, `paymentAccountSnapshotPresent` (boolean), `preparingAt`, `readyAt`, `servedAt`, `createdAt`, `updatedAt`, station statuses, item line ids/types/quantities/cancelled flags, component ids/kinds/inventory ids/stock quantities, derived `cancelledLineIds` |
| Reservation | `_id`, `orderId`, `orderNumber`, `status`, requirement/shortage fingerprints, item quantities (required/reserved/shortage/consumed), approval presence/approvedAt/fingerprints/shortage count, `consumedAt`, `consumedTrigger`, `releasedAt`, `releaseReason`, voids (`at`, `phase`, `source`, `lineId`, `station`, item ids/quantities) |
| Movement | `_id`, `refOrderId`, `item`, `type`, `quantity`, `reason`, `idempotencyKey`, `voidedAt`, `voidReason`, `createdAt` |
| Inventory | `_id`, `currentStock`, `reservedStock` |

### 5.2 Excluded (allowlist denies by construction)

- PINs, PIN hashes, passwords, secrets, tokens, authorization headers, cookies, session ids, API keys, credentials, connection strings, Mongo URIs.
- Payment account numbers and account-holder data. Only `paymentAccountId` and a snapshot-presence boolean are kept.
- Free-text fields: order notes/names, payment rejection reason, reservation void reason, item names/units.
- Whole documents, Mongoose internals (`_doc`, `$__`, methods), and unknown nested objects.
- Inventory cost/minimum/status context, which must never be used to infer a correction.

### 5.3 Explicit handling

| Case | Behaviour |
|---|---|
| Missing or `null` | Explicit `null` (or `[]` for child arrays). |
| Legacy optional field absent | `null`; no guessed value. |
| Invalid quantity type/string/NaN | `INVALID_NUMERIC_VALUE` typed error. |
| Invalid date | `INVALID_DATE` typed error. |
| Unsupported identifier object | `INVALID_IDENTIFIER` typed error. |
| Non-array child collection | `INVALID_ARRAY` / entity-specific typed error. |
| Bound exceeded | `EVIDENCE_BOUND_EXCEEDED` (fail closed; no truncation). |
| Sensitive key appears | `SENSITIVE_FIELD_DETECTED` (defense in depth). |

Bounds: 500 order items, 100 components per item, 500 reservation items, 200 voids, 200 void items, 2,000 movements, 1,000 inventory items. These are safety caps, not business thresholds.

---

## 6. Fingerprint format and version

| Attribute | Value |
|---|---|
| Evidence schema | `wp04-evidence-v1` |
| Fingerprint version | `wp04-fingerprint-v1` |
| Algorithm | SHA-256 over UTF-8 canonical JSON |
| Digest | 64 lowercase hex characters |
| Result shape | `{ version, algorithm, schema, digest }` (frozen) |

### 6.1 Fingerprint-relevant payload

```text
{
  schema: "wp04-evidence-v1",
  order: { id, orderNumber, status, paidAt, paymentMethod, paymentAccountId,
           updatedAt, cancelledLineIds[] } | null,
  reservation: { id, orderId, status, consumedAt, consumedTrigger,
                 releasedAt, releaseReason,
                 items: [{ inventoryItemId, requiredQuantity, reservedQuantity,
                           shortageQuantity, consumedQuantity }],
                 voids: [{ at, source, lineId,
                           items: [{ inventoryItemId, quantity }] }] } | null,
  movements: [{ id, item, type, quantity, reason, idempotencyKey, voidedAt }],
  inventory: [{ id, currentStock, reservedStock }]
}
```

Classification-only fields (station status, payment workflow timestamps, order items, approval metadata, free-text reasons, account snapshots) are excluded so operational noise does not create false drift. Within the payload, arrays are canonically sorted.

### 6.2 Canonicalization rules

1. Object keys sorted by UTF-16 code unit order; no insignificant whitespace.
2. Strings use JSON escaping with **no implicit Unicode normalization** (NFC and NFD remain distinct).
3. Numbers use the ECMAScript shortest round-trip representation; `-0` → `0`; NaN/Infinity rejected.
4. `null` and `undefined` both serialize as `null`.
5. Dates are already ISO-8601 UTC strings; identifiers are already type-preserving.
6. Unsupported types are rejected, never coerced.

### 6.3 Limitation

A matching digest proves the projected evidence is byte-identical under this canonical form. It does **not** prove the evidence is true, complete, authoritative, or free of fraud. The digest is a drift detector, not an assertion of correctness.

---

## 7. Tests and exact results

### 7.1 Commands

```powershell
node --check lib\recovery\rules\registry.js
node --check lib\recovery\evidence.js
node --check lib\recovery\fingerprint.js
node --check tests\wp04-01-recovery-core.test.mjs

node --test tests\wp04-01-recovery-core.test.mjs

npx eslint lib\recovery tests\wp04-01-recovery-core.test.mjs

node --test tests\inventory-reservation-phase1.test.mjs tests\inventory-lifecycle-phase1-1.test.mjs tests\phase25-payment-immutability.test.mjs tests\inventory-hook-observability.test.mjs tests\item-level-cancellation.test.mjs

# Full DB-free suite
$files = Get-ChildItem tests -Filter *.test.mjs | ForEach-Object { $_.FullName }
node --test @files
```

### 7.2 Results

| Check | Result |
|---|---|
| Syntax check (4 files) | **PASS** — `SYNTAX OK` |
| WP04-01 focused suite | **PASS** — 43 tests, 43 pass, 0 fail, 0 skipped, 0 todo |
| ESLint on new files | **PASS** — no output, exit 0 |
| Relevant existing regressions | **PASS** — 82 tests, 82 pass, 0 fail, 0 skipped |
| Full DB-free suite (74 files) | **PASS** — 1,451 tests, 1,451 pass, 0 fail, 0 skipped, 0 todo, exit 0 |

The `MODULE_TYPELESS_PACKAGE_JSON` warning emitted by Node for ESM-syntax `.js` files is pre-existing repository behaviour (no `"type": "module"` in `package.json`) and does not affect results.

### 7.3 WP04-01 test coverage mapping

| Requirement | Covered by |
|---|---|
| Exactly D01–D10, no more | registry: id/order/count tests |
| No R9/R10 | registry: recovery-map and referenced-class tests |
| D02/D09 finding-code behaviour | registry: `findingCodeOnly`/`durableClass` tests |
| D06 task prohibition | registry: `ALERT_ONLY` test |
| Lifecycle applicability | registry: enum-membership tests |
| False-positive exclusions | registry: every rule non-empty |
| Immutability / no dynamic rules | registry: deep-freeze, mutation-throw, `__proto__` lookup tests |
| Missing/null/invalid evidence | projection: missing, legacy, invalid-type, invalid-date tests |
| Sensitive-field exclusion + recursive allowlist | projection: nested sensitive-key and serialized-output tests |
| Deterministic key ordering | fingerprint: source key reorder and canonical JSON tests |
| Identifier/date normalization | projection: identifier-type and ISO-date tests |
| Exact numeric preservation | projection: `0.1+0.2` / `1/3` test; fingerprint: `100` vs `100.0` |
| Fingerprint versioning | fingerprint: version/algorithm/schema and unsupported-schema tests |
| Equivalent projection stability | fingerprint: repeated/deterministic tests |
| Material evidence difference | fingerprint: changed quantity/status/void tests |
| Malformed input rejection | projection: typed-error tests |
| No database/runtime side effects | source-contract suite (imports, calls, env, fs, net) |

---

## 8. DB-free proof and dependency inspection

- No test opens a connection; no `MONGODB_URI`/`MONGO_URI`/`ROOM_MONGODB_URI` is read.
- `lib/recovery/evidence.js` and `lib/recovery/rules/registry.js` have **zero imports**.
- `lib/recovery/fingerprint.js` imports only `node:crypto` and `./evidence.js`.
- No module imports `mongoose`, `mongodb`, `@/lib/mongodb`, any V1 write service, or any V2 server module.
- No module calls a write/index/collection method.
- No module reads `process.env`, the filesystem, the network, or spawns a process.
- No module references an HTTP route, worker, queue, cron, scheduler, lease, or recovery collection.
- The only runtime dependency added is the Node built-in `node:crypto`, used for SHA-256. No package was installed.

---

## 9. Baseline and final Git status

### 9.1 Baseline (before WP04-01 changes)

| Measure | Value |
|---|---|
| Branch | `main` |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` |
| Total entries | **300** |
| Modified (` M`) | **61** |
| Untracked (`??`) | **239** |
| Deleted | **0** |
| Staged | **0** |
| Status SHA-256 | `65bee2d9c246757adbe3bb5e35fa0e51b152b8210f0743b908edbb5b0637c4e5` |

### 9.2 Final (after this report was written)

| Measure | Value |
|---|---|
| Branch | `main` |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` |
| Total entries | **305** |
| Modified (` M`) | **61** |
| Untracked (`??`) | **244** |
| Deleted | **0** |
| Staged | **0** |
| Status SHA-256 | `793822378159d106f73711733831950738403df4584ba45c37cc0eda6d3933ca` |

### 9.3 Delta

| Measure | Result |
|---|---|
| Added paths | **5** |
| Removed paths | **0** |
| Unexpected modified paths | **0** |

Added paths, in full:

```text
?? docs/production-readiness/wp-04-01-implementation-report.md
?? lib/recovery/evidence.js
?? lib/recovery/fingerprint.js
?? lib/recovery/rules/registry.js
?? tests/wp04-01-recovery-core.test.mjs
```

The delta is exactly five new paths (three modules, one focused test, this report) and zero removals; modified count stays 61; HEAD is unchanged; nothing is staged.

### 9.4 Preservation proof

A full path-list comparison (`Compare-Object`) between the baseline snapshot and the final `git status --short --untracked-files=all` output returned:

1. `added=5` — only the five authorized WP04-01 artifacts listed in §9.3;
2. `removed=0` — no pre-existing modified or untracked path was removed;
3. modified count remains **61**, deleted **0**, staged **0**;
4. branch `main` and HEAD `69650435a6587d4577bc126f719fa1392bb934b3` are unchanged.

**PASS.** All 300 pre-existing entries in the baseline snapshot are preserved.

---

## 10. Deferred work (unchanged by this package)

Still not approved or implemented:

- WP04-02 classifier and later packages.
- `W_STALE` and live-hold numeric thresholds.
- Legacy cutoff date.
- Shortage accounting semantics.
- Evidence/output retention periods.
- Lease/retry/backoff/jitter numerics.
- Production scan window and transaction-lifetime limits.
- Alert sink/on-call/SLA.
- Exact recovery task/evidence schema and collection names.
- Index inventory/deployment.
- External-writer register.
- Named approver/executor/verifier and backups.
- Gate signatories and dates.
- `R9`/`R10` adoption.
- D06 task creation or finalize.
- Automatic hold release.
- Line-level attribution.
- Worker scheduling.

---

## 11. Gate states (unchanged)

| Gate | State |
|---|---|
| G-REC-1 | **UNSIGNED — NOT STARTED** |
| G-REC-2 | **UNSIGNED — NOT STARTED** |
| G-REC-3 | **UNSIGNED — NOT STARTED** |
| G-AUD-1 | **UNSIGNED — NOT STARTED** |
| G-GOV-1 | **UNSIGNED — NOT STARTED** |
| G-IDX-1 | **UNSIGNED** |
| G-DB-1 | **UNSIGNED** |
| G-DB-2 | **UNSIGNED** |
| G-DB-4 | **UNSIGNED** |
| G-PAY-1 | **BLOCKED** |
| G-PAY-2 | **UNSIGNED** |

No gate was signed, passed, or waived. This package supplies source and DB-free test evidence only; it does not satisfy G-REC-1, which also requires a disposable replica-set proof and an approved staging sample.

---

## 12. Acceptance criteria

| WP04-01 criterion | Result |
|---|---|
| Registry contains exactly the approved D01–D10 vocabulary | **PASS** |
| Evidence projection is allowlisted and deterministic | **PASS** |
| Fingerprinting is stable, versioned, and tested | **PASS** |
| No database or write capability in implemented modules | **PASS** |
| All required focused tests pass | **PASS — 43/43** |
| No unrelated application behavior changed | **PASS** — no existing file modified |
| Pre-existing modifications/untracked files preserved | **PASS** — see §9.4 |

**WP04-01 is COMPLETE.**

---

## 13. Closing statement

- WP04-01 delivered the D01–D10 registry, allowlisted evidence projection, and versioned SHA-256 fingerprint.
- **WP04-02 and every later package remain UNAUTHORIZED.**
- No database, staging, production, secret, route, worker, scheduler, index, migration, or schema work occurred.
- No gate was signed or changed; G-PAY-1 remains BLOCKED.
- Inventory V2 remains inactive; WP-13 and WP-09 were not started.

Stop after WP04-01. Await separate owner authorization before proceeding.
