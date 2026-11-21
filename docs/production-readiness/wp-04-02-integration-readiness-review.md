# WP04-02 — WP04-01 Integration Readiness Review

Status: **READ-ONLY REVIEW COMPLETE — NO INTEGRATION PERFORMED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Package: **WP04-02 — Integration readiness and isolated integration design** (documentation only)
Authorization: owner authorization for **WP04-02 read-only review and documentation only**. Technical reviewer: **ChatGPT (AI Technical Reviewer)**. This is **not** independent human verification and **not** a production gate approval.
Companions: `wp-04-02-v1-integration-map.md`, `wp-04-02-isolated-integration-test-plan.md`, `wp-04-02-open-risks-and-gates.md`

> This document reviews WP04-01 source and marks integration readiness. It does not modify WP04-01 files, does not wire recovery into any route or service, does not create tests, and does not access any database. No gate is signed, passed, or waived.

---

## 1. Scope and method

Reviewed read-only:

| Artifact | Bytes | State |
|---|---:|---|
| `lib/recovery/rules/registry.js` | 30,767 | unchanged |
| `lib/recovery/evidence.js` | 19,594 | unchanged |
| `lib/recovery/fingerprint.js` | 7,469 | unchanged |
| `tests/wp04-01-recovery-core.test.mjs` | 27,093 | unchanged |

Method:

1. Full-file source read of the three modules and the test file.
2. Line-level verification of every claim against the approved detection matrix and design §6.
3. Re-ran the focused DB-free suite without modifying anything: **43 tests, 43 pass, 0 fail, 0 skipped, exit 0**.
4. Repository-wide search for `Decimal128` / `BigInt` to establish the numeric boundary (see F-01).
5. No database connection, no `.env` read, no external service call.

---

## 2. Verification results

| # | Requirement | Result | Evidence |
|---|---|---|---|
| V-01 | Exactly D01–D10 defined, in order, no extra rules | **PASS** | `registry.js:123-799`; `RULE_IDS` at `registry.js:809`; test at `wp04-01-recovery-core.test.mjs:171` |
| V-02 | No R9/R10 anywhere | **PASS** | `getReferencedRecoveryClasses()` `registry.js:832-838`; test at test file `:223` |
| V-03 | D02 is a finding code, not a durable class | **PASS** | `registry.js:273-274` (`durableClass: false`, `findingCodeOnly: true`); test `:236` |
| V-04 | D09 is a finding code, not a durable class | **PASS** | `registry.js:722-723`; test `:236` |
| V-05 | D06 is alert-only and creates no task | **PASS** | `registry.js:510-513` (`createsRecoveryTask: false`, `ALERT_ONLY`); test `:245` |
| V-06 | No rule authorizes repair | **PASS** | every entry: `readOnly: true`, `autoRecovery: "PROHIBITED"` (e.g. `registry.js:190-193, 510-513`) |
| V-07 | Registry immutability | **PASS** | deep freeze `registry.js:65-86`; `Object.freeze(RULES)` `:123,798`; test `:275` |
| V-08 | Prototype-pollution resistance | **PASS** | null-prototype map `registry.js:801-807`; `Object.hasOwn` guard `:820-824`; test `:290` |
| V-09 | Recursive sensitive-field exclusion | **PASS** | regex `evidence.js:455-456`; recursive walk `:458-470`; post-projection gate `:516`; tests `:305, :327` |
| V-10 | Missing / null / invalid handling is explicit | **PASS** | `evidence.js:107-176`, `:486-518`; tests `:361, :370, :422` |
| V-11 | Identifier canonicalization preserves type | **PASS** | `evidence.js:107-136`; test `:435` |
| V-12 | Date canonicalization to ISO-8601 UTC | **PASS** | `evidence.js:145-162`; test `:449` |
| V-13 | Exact numeric preservation, no silent rounding | **PASS WITH NOTE** | `evidence.js:172-176`; tests `:382, :527`; see F-01 |
| V-14 | Stable fingerprint version | **PASS** | `fingerprint.js:25-26`; result shape `:235-244`; test `:499, :644` |
| V-15 | Deterministic sorting independent of input order | **PASS** | `fingerprint.js:97-103, 185-207`; tests `:514, :604` |
| V-16 | Classification-only changes do not alter the digest | **PASS** | narrow payload `fingerprint.js:111-151, 163-216`; test `:546, :676` |
| V-17 | Material evidence changes alter the digest | **PASS** | tests `:538, :578, :586, :635` |
| V-18 | No DB / filesystem / network / environment / write capability | **PASS** | `fingerprint.js:21-23`; zero imports in the other two; tests `:705, :716, :725, :741, :752` |
| V-19 | Focused suite still green | **PASS** | re-run 2026-11-08: 43/43 pass, 0 fail, 0 skipped |

---

## 3. Detailed source findings

### 3.1 Rule registry

- **Vocabulary is closed.** `RULES` is a literal array of ten entries (`registry.js:123-799`), each mapped through `freezeRule` (`:65-74`), which deep-freezes nested arrays and objects. There is no factory, no input-derived rule, and no merge from configuration.
- **Ordering is fixed** D01→D10; `RULE_IDS` derives from the same frozen array (`:809`), so a duplicate or reordering cannot appear without editing source.
- **Lookup cannot be polluted.** `RULES_BY_ID` is built on `Object.create(null)` (`:803-807`) and `getRuleDefinition` requires `Object.hasOwn` (`:822`). `getRuleDefinition("__proto__")`, `"constructor"`, and non-string inputs return `null`.
- **Finding-code posture is explicit only where required.** D02 (`:273-274`) and D09 (`:722-723`) carry both flags. Other rules omit the keys rather than setting them to `false`. Consumers must treat *absence* as "not explicitly downgraded" and must branch on `=== true`. This is a consumer-contract note (F-03), not a registry defect.
- **D06 alert-only is metadata-enforced here** (`:510-513`) and must also be enforced by the future classifier and persistence layer (F-04).
- **Recovery maps never include R9/R10**; the union is exactly R1–R8 (`:832-838`).
- **Lifecycle arrays use the live enums**: `ORDER_STATUSES` (`:40-49`) matches `lib/models/Order.js:12-21`; `RESERVATION_STATUSES` (`:51-59`) matches `lib/models/InventoryReservation.js:23-31`.
- **Sub-codes are the approved matrix codes**, unique per rule (test `:269`).

### 3.2 Evidence projection

- **Allowlist by construction.** Every projected field is named literally in `projectOrder` (`evidence.js:225-291`), `projectReservation` (`:375-423`), `projectMovement` (`:425-443`), and `projectInventoryItem` (`:445-453`). No `...source`, no `for..in`, no `JSON.stringify(document)`.
- **Sensitive data cannot pass**: account numbers and holder names are never selected; `paymentAccountSnapshot` is reduced to the boolean `paymentAccountSnapshotPresent` (`:271`); free-text rejection reasons, item names, void reasons, and units are never selected; the recursive guard (`:458-470`) would additionally fail the projection if a sensitive key ever appeared.
- **Type-preserving identifiers.** String stays string; safe integer stays number; BSON ObjectId (`toHexString` or `_bsontype`) becomes `{ $oid: "<24 lowercase hex>" }`; everything else raises `INVALID_IDENTIFIER` (`:107-136`).
- **Dates** become `toISOString()` (UTC, millisecond precision); invalid dates raise `INVALID_DATE` (`:145-162`).
- **Quantities** are returned unchanged when they are finite numbers; numeric strings, `NaN`, `Infinity`, Decimal128 objects, and V2 `{ scaled: bigint }` objects raise `INVALID_NUMERIC_VALUE` (`:172-176`). Nothing is rounded, coerced, or defaulted to zero.
- **Bounds fail closed**: exceeding a cap raises `EVIDENCE_BOUND_EXCEEDED` instead of truncating (`:24-32, :67-77`). Caller limit overrides are validated (`:79-105`).
- **Freezing** is recursive over the finished projection (`:472-476`), so a downstream classifier cannot mutate evidence.
- **Determinism**: field order and content are fixed by the projection; the derived `cancelledLineIds` array is sorted (`:251-256`).

### 3.3 Fingerprint

- **Narrow payload.** `ORDER_FP_FIELDS` (`fingerprint.js:111-119`) excludes order items, station status, workflow timestamps, and account snapshots. `RESERVATION_FP_FIELDS` (`:121-129`) excludes approval metadata, requirement/shortage fingerprints, and void reasons. `MOVEMENT_FP_FIELDS` (`:141-149`) excludes `createdAt` and `voidReason`.
- **Canonical JSON** sorts keys via `Object.keys(value).sort()` (`:85`), rejects class instances, Dates, functions, symbols, and bigints (`:62-95`), normalizes `-0` to `0`, and serializes `undefined` as `null`.
- **No locale dependence**: only `<`/`>` comparison on canonical strings (`:97-103`) and `JSON.stringify` for strings.
- **No Unicode normalization** is applied, by explicit decision (test `:669`). NFC and NFD remain distinct digests.
- **Version gate**: payload construction refuses any evidence object whose `schema` is not `wp04-evidence-v1` (`:167-173`).
- **Digest**: SHA-256 over the UTF-8 canonical string, lowercase hex, 64 characters (`:235-244`).
- **Scope disclaimer is present** (`:1-19`): the digest detects drift; it does not prove truth, completeness, or absence of fraud.

### 3.4 Read-only dependency proof

| Module | Imports | Write capability |
|---|---|---|
| `rules/registry.js` | none | none |
| `evidence.js` | none | none |
| `fingerprint.js` | `node:crypto`, `./evidence.js` | none |

No Mongoose, MongoDB client, connection helper, route, worker, queue, scheduler, lease, filesystem, network, `process.env`, `eval`, or `new Function`. The source-contract suite asserts this mechanically (`wp04-01-recovery-core.test.mjs:698-762`).

---

## 4. Findings

Severity here means *integration risk*, not a defect in WP04-01.

| ID | Severity | Finding | Required handling |
|---|---|---|---|
| **F-01** | Medium | **Numeric precision boundary.** V1 stores quantities as IEEE-754 `Number` (`InventoryReservation.js:41-45,58-60,90`; `StockMovement.js:19`; `InventoryItem.js:11,14`). The projection preserves any finite number and does not assert a magnitude or `Number.isSafeInteger` bound for quantities (`evidence.js:172-176`). Values above 2^53 would already be imprecise in the source. Repo-wide search found **no `Decimal128` usage**; Inventory V2 uses exact scaled `BigInt` objects, which the projection rejects as `INVALID_NUMERIC_VALUE` (fail closed). | Adapter must be **V1-only**. Do not project V2 exact quantities. If V2 activates, define a new evidence schema version rather than loosening v1. Record quantity magnitude as an acceptance check in the test plan. |
| **F-02** | Low | **Date parsing is runtime-dependent for non-ISO strings.** `normalizeDate` accepts any string `new Date()` can parse (`evidence.js:151-159`). ISO-8601 is stable across Node versions; loosely-formatted strings are not guaranteed. | Adapter must pass `Date` objects or ISO-8601 strings. Classifier must not accept user-formatted dates. |
| **F-03** | Low | **Absence-based flags.** `findingCodeOnly`/`durableClass` exist only on D02/D09; other rules omit them. | Classifier must branch on `rule.findingCodeOnly === true`, never on truthiness of a missing key being false-by-default in a schema. Consider a future registry version that sets both flags on every rule, but **do not change v1** in this package. |
| **F-04** | Medium | **Layering is required for durable-class prohibition.** The registry expresses intent; it cannot physically prevent a future caller from creating a task. | Enforcement points: (1) classifier refuses durable output for finding-only rules; (2) persistence rejects a task whose rule is finding-only or `ALERT_ONLY`; (3) D06 has no task-creation path. All three are future packages. |
| **F-05** | Low | **Free-text minimization constrains some sub-codes.** D09's approved authoritative fields include `paymentRejectionReason`, and D08's include `voidReason`; the projection intentionally excludes free text. Detection must rely on timestamps, actor ids, and controlled enums, not on reason text. | Classifier contracts must not require free text. If a sub-code is impossible without it, leave the sub-code unimplemented and report it as an owner decision. |
| **F-06** | Info | **`cancelledLineIds` uses native `.sort()`** (`evidence.js:251-256`). Mixed identifier types in one order would sort by string coercion. | V1 line ids are ObjectIds, so this is stable. Classifier should not mix identifier types. |
| **F-07** | Info | **`tryProjectEvidence` rethrows non-projection errors** (`evidence.js:527-545`). | Adapter should catch only `EvidenceProjectionError` for data defects; rethrow programming errors. |

No **High** or **Critical** source-level defect was found. WP04-01 is fit to build on, subject to the adapter boundaries above.

---

## 5. Integration readiness verdict

| Dimension | Readiness |
|---|---|
| Rule vocabulary | **READY** — closed, frozen, tested |
| Evidence projection | **READY WITH ADAPTER CONSTRAINT** — V1-only, ISO dates, finite numbers |
| Fingerprint | **READY** — versioned, deterministic, drift-capable |
| DB-free purity | **READY** — proven mechanically |
| Classifier | **NOT IMPLEMENTED** — WP04-03+ |
| Adapter / DB reads | **NOT IMPLEMENTED** — WP04-03+ |
| Persistence / workers | **NOT IMPLEMENTED** — later package |
| Live route integration | **NOT AUTHORIZED** |

WP04-01 is a sound foundation. It is **not** an integration; nothing here reads a database or changes application behavior.

---

## 6. Preservation statement

- No existing file was created, modified, or deleted by this review.
- The four WP04-01 files are byte-identical to their pre-review state.
- The only artifacts added by WP04-02 are the four documentation files named at the top of this document.
- No stage, commit, push, deploy, reset, clean, checkout, or stash was performed.
