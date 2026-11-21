# WP-04-03 — DB-Free Classifier and Read-Only Adapter: Implementation Report

Status: **IMPLEMENTED — DB-FREE — NO DATABASE CONTACT — WP04-04 NOT STARTED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch / HEAD: `main` / `69650435a6587d4577bc126f719fa1392bb934b3` (unchanged)
Work package: **WP04-03 only**
Parents: `wp-04-detection-rule-matrix.md`, `wp-04-02-isolated-integration-test-plan.md`, `wp-04-02-open-risks-and-gates.md`, `wp-04-02-v1-integration-map.md`

> This work package adds a pure classifier and a dependency-injected read-only
> adapter. No MongoDB connection was opened, no `.env` file was read, no
> document was read or written, and no route, service, model, index script,
> configuration, or station behavior was modified. All test evidence is
> synthetic and in-memory.

---

## 1. Scope and result

WP04-03 delivers exactly three things:

1. a **pure, DB-free classifier** for detection rules D01–D10 that consumes only
   WP04-01 projected evidence (`wp04-evidence-v1`) and the frozen WP04 registry;
2. a **dependency-injected, read-only V1 adapter** that reads bounded evidence
   through caller-supplied repositories and never creates a connection;
3. **DB-free tests and doubles** that prove the classifier vocabulary, rule
   behavior, lifecycle false-positive exclusions, bounds, determinism, numeric
   and date/identifier strictness, missing-index reporting, and the absence of
   any write or connection surface.

Delivered status:

| Area | Result |
|---|---|
| D01–D10 classifier | Implemented, deterministic, frozen output |
| Evidence adapter | Implemented, injected repositories only, read-only |
| WriteTrap / connection trap | Implemented and exercised |
| CLS-01…CLS-12 | Covered (28 classifier tests) |
| INT-01…INT-15 | Covered (21 adapter tests) |
| D01–D10 behavior | Covered |
| ESLint (new files) | 0 errors / 0 warnings |
| Full DB-free suite | 1500 tests / 267 suites / 1500 pass / 0 fail / 0 skipped |
| Database contact | None |
| WP04-04+ | Not started |

---

## 2. Files added

| File | Lines | Purpose |
|---|---:|---|
| `lib/recovery/classifier.js` | 1912 | Pure D01–D10 classifier; validation, grouping, deterministic finding report, bounds, typed errors |
| `lib/recovery/adapter.js` | 832 | Injected read-only V1 adapter; allowlisted projections, internally built bounded filters, strict dates/identifiers, index-evidence pass-through, facade |
| `tests/helpers/recovery-fakes.mjs` | 243 | Fake `findBounded` repositories, WriteTrap, connection trap, index-evidence helpers, minimal Mongo-like matcher |
| `tests/wp04-03-recovery-classifier.test.mjs` | 963 | CLS-01…CLS-12, D01–D10 behavior, malformed evidence, bounds, redaction, determinism |
| `tests/wp04-03-recovery-adapter.test.mjs` | 499 | INT-01…INT-15, WriteTrap, limit ceilings, missing-index reporting, adapter determinism |
| `docs/production-readiness/wp-04-03-implementation-report.md` | this file | Implementation record |

No existing file was edited. No WP04-01 artifact was changed.

---

## 3. Architecture

### 3.1 Classifier (`lib/recovery/classifier.js`)

Public API:

```js
classifyEvidence(evidence, options)      // one projected bundle
classifyBundles(bundles, options)        // many bundles, grouped by order
```

Exports: `FINDING_SCHEMA_VERSION = "wp04-finding-v1"`,
`CLASSIFIER_VERSION = "wp04-classifier-v1"`, `QTY_EPSILON = 1e-9`,
`ClassifierError`, `assertFindingCode`.

Pipeline per run:

1. **Normalize options.** Optional `now`, `since`, `until`, `maxBundles`,
   `maxFindings`, `indexEvidence`, `expectedFingerprints`. Dates must be
   strict ISO-8601 UTC with milliseconds and `Z`, or `Date`; offsets are
   rejected. Bounds are integers with hard ceilings.
2. **Validate every bundle.** Plain object, exact evidence schema, allowlisted
   field types only. Reject `BigInt`, V2 `{ scaled: ... }`, Decimal128,
   malformed/empty identifiers, non-safe-integer numeric ids, non-ISO dates,
   numeric strings, and non-finite quantities with typed errors.
3. **Group by order identity.** Duplicate reservations and cross-bundle checks
   are possible without trusting document order.
4. **Run D10 first as a gate.** Schema, quantity, orphan-reference, identity,
   unknown-enum, contradictory-timestamp, and `EVIDENCE_DRIFT` findings
   suppress D01–D09 for that order. A malformed order therefore produces a
   D10 finding instead of a false defect.
5. **Run D01–D09.** Each rule only reads projected evidence. Findings are
   frozen, de-duplicated by a stable dedupe key, and sorted by order id, rule,
   code, item, line, then dedupe key.
6. **Build a frozen report.** Summary counters by severity, rule, and
   classification; `readOnly: true`; injected `generatedAt`; a `deferred` list
   for rules that cannot be measured from projected evidence.

Hard policy encoded:

- `D02` and `D09` emit `findingCodeOnly: true`, `durableClass: false`; they
  never create a durable class or task payload.
- `D06` emits `classification: "ALERT"`, `taskCreationPolicy: "ALERT_ONLY"`,
  `createsRecoveryTask: false`, `task: null`.
- Every finding has `autoRecovery: "PROHIBITED"`, `readOnly: true`, and no
  correction/repair field.
- No rule emits R9/R10 and no rule authorizes repair or a shortage correction.
- Age-dependent branches are **deferred**, not invented (see §7).

### 3.2 Adapter (`lib/recovery/adapter.js`)

Public API:

```js
collectEvidence(repositories, options)   // projected bundles + index evidence
reconcile(repositories, options)         // collect + classify
createReadOnlyAdapter(repositories)      // frozen facade
```

Exports also include `DEFAULT_LIMITS`, `MAX_LIMITS`, `ORDER_PROJECTION`,
`RESERVATION_PROJECTION`, `MOVEMENT_PROJECTION`, `INVENTORY_PROJECTION`,
`RULE_SCOPES`, `parseIsoDate`, `normalizeAdapterIdentifier`.

Repository contract (injected, one read primitive):

```js
findBounded(filter, projection, { limit }) -> Document[] | { docs, truncated? }
```

Read-only enforcement:

- `assertRepositories` requires exactly the four repositories and the single
  `findBounded` method.
- Any repository exposing `insert*`, `update*`, `replace*`, `delete*`,
  `findOneAnd*`, `bulkWrite`, `createIndex*`, `dropIndex*`, `syncIndexes`,
  `createCollection`, `dropCollection`, `dropDatabase`, `connection`, `db`,
  `collection`, or `model` is rejected with `WRITE_SURFACE_DETECTED`.
- Every filter is built internally. No caller-supplied query object, sort, or
  projection is accepted.
- Every read has an explicit positive integer limit; orders additionally
  require a `since` window unless explicit `orderIds` are supplied. Returning
  more than the limit, or `truncated: true`, fails closed with
  `EVIDENCE_BOUND_EXCEEDED`.
- Projection uses only the allowlisted WP04-01 fields. Account numbers, holder
  names, item names, PINs, tokens, and free text never enter the projection.
- `projectEvidence` errors propagate unchanged and are not wrapped with
  document payloads.

Index evidence:

- The adapter never probes, creates, drops, or assumes an index.
- Index state is injected (`options.indexEvidence` or
  `repositories.indexEvidence.readUniqueIndexEvidence()`) and normalized to
  `PRESENT`, `ABSENT`, or `UNKNOWN`.
- Provider failure becomes `UNKNOWN`; it is not an adapter crash and it is not
  a claim that the index exists.
- The classifier emits `D03 / INDEX_ABSENT_SUSPECTED` when state is `ABSENT`,
  or when duplicate sale evidence exists without confirmed `PRESENT` state.

Rule scopes are lifecycle-aware: `D01` reads `PAID`, `D02` excludes `PAID`,
`D06` additionally discovers `CONSUMING` reservations, and `ALL` includes that
discovery read. Orphan scanning is opt-in (`includeOrphans` defaults to
`false`) and bounded by its own limit.

### 3.3 WriteTrap and DB-free proof

`createWriteTrap()` returns throwing methods for every write, index,
collection, aggregation, watch, session, and transaction method. Tests call
each one and require `UnexpectedWriteError`. `createConnectionTrap()` does the
same for connect/model/collection/db. The adapter and classifier sources are
scanned to prove they import no Mongoose, MongoDB driver, filesystem, network,
or environment access.

### 3.4 Rule coverage summary

| Rule | Implemented behavior |
|---|---|
| D01 | PAID with live hold, released-without-deduction, no-reservation/no-deduction, consumed-without-item-evidence, approved shortage (INFO), already-correct legacy (INFO), no inventory requirement (INFO) |
| D02 | Orphan deduction, terminal deduction without valid void, deduction without preparation/payment, unknown lifecycle, legacy archive (INFO) |
| D03 | Duplicate movement identity, duplicate sale idempotency key, malformed sale key, absent/suspected unique index |
| D04 | Duplicate reservation, orphan reservation, missing inventory item, released-with-hold, consumed-without-evidence, approved-without-approval, approval fingerprint mismatch, negative/excess quantities |
| D05 | Orphan live hold, hold on terminal order, PAID with live hold (cross-reference); stale age deferred |
| D06 | Consuming orphan / partial / complete / abandoned / ambiguous, always ALERT only; age/staleness deferred |
| D07 | Consumed vs movement mismatch, required item not consumed, movement without reservation item; station partial consumption deferred |
| D08 | Cancelled no order void, cancelled sale not reclassified, cancelled hold not released, line cancel without void / unreconciled hold, duplicate void |
| D09 | Pending without submission, pending with paid/verification timestamp, pending after rejection, paid without paidAt/method/account, paid with rejection timestamp, prepared with live hold, verified-not-paid |
| D10 | Unknown enum, missing required field, negative quantity, quantity out of range, orphan reference, identity mismatch, contradictory timestamps, legacy shape (INFO), evidence drift |

---

## 4. Test coverage and results

### 4.1 Classifier suite — 28 passing

```text
node --test tests\wp04-03-recovery-classifier.test.mjs
ℹ tests 28
ℹ suites 5
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Coverage:

- **CLS-01** frozen D01–D10 vocabulary; unknown rule/sub-code rejected.
- **CLS-02** D02/D09 are finding codes only, no durable class, no task.
- **CLS-03** D06 is ALERT_ONLY with `thresholdState: "W_STALE_UNSET"`.
- **CLS-04** no finding authorizes repair, correction quantity, or a task.
- **CLS-05** shortage is report-only with no correction quantity.
- **CLS-06** identical output across repeats and key-order permutations.
- **CLS-07** fingerprint equality/difference semantics.
- **CLS-08** lifecycle exclusions: clean consumption, valid void, approved
  shortage, inventory-free order.
- **CLS-09** PAID + RELEASED(CONSUMPTION_FAILED) yields D01, not D02.
- **CLS-10** CONSUMING without approved threshold yields alert and deferral.
- **CLS-11** no account number, holder name, item name, or free text.
- **CLS-12** classifier source performs no I/O and exposes no write surface.
- **D01–D10** each rule positive/negative case, including D10 gating and
  evidence drift.
- **Malformed evidence**: null, wrong schema, `BigInt`, V2 scaled, Decimal128,
  bad identifiers, non-ISO/offset dates, numeric strings, invalid `now`.
- **Numerics/bounds**: exact `2.0001` preserved without rounding; bundle and
  finding ceilings fail closed; output frozen and input unmutated.

### 4.2 Adapter suite — 21 passing

```text
node --test tests\wp04-03-recovery-adapter.test.mjs
ℹ tests 21
ℹ suites 4
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Coverage:

- **INT-01** facade exposes only `collect`, `classify`, `reconcile`, `describe`.
- **INT-02** no Mongoose/MongoDB/service/connection import.
- **INT-03** only `findBounded` is called on every double.
- **INT-04** explicit limits and order time window.
- **INT-05** lifecycle-aware D01/D02/D06 filters.
- **INT-06** deterministic finding order from unsorted input.
- **INT-07** per-order cap fails closed; ceiling enforced.
- **INT-08** missing reservation is explicit `null`, not an exception.
- **INT-09** orphan movement yields an orphan candidate and D02 finding.
- **INT-10** allowlisted projection only; secrets never leak.
- **INT-11** no account number, PIN, token, or free text in output.
- **INT-12** results and bundles frozen.
- **INT-13** projection errors propagate unchanged and redact payloads.
- **INT-14** missing/absent index evidence yields `INDEX_ABSENT_SUSPECTED`.
- **INT-15** no wall clock; identical output for identical injected inputs.

### 4.3 Focused combined run — 92 passing

```text
node --test tests\wp04-03-recovery-classifier.test.mjs `
  tests\wp04-03-recovery-adapter.test.mjs `
  tests\wp04-01-recovery-core.test.mjs
ℹ tests 92   (28 + 21 + 43)
ℹ suites 13
ℹ pass 92
ℹ fail 0
ℹ skipped 0
```

WP04-01 regression alone: **43 pass / 0 fail**.

### 4.4 Full DB-free suite — 1500 passing

```text
node --test "tests/*.test.mjs"
ℹ tests 1500
ℹ suites 267
ℹ pass 1500
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 47784.856
```

All MongoDB/replica-set integration suites are explicit opt-in and were not
requested; no `HOTEL_TEST_MONGODB_URI`, `HOTEL_INTEGRATION`, `MONGODB_URI`,
`MONGO_URI`, or `ROOM_MONGODB_URI` was set in the test environment.

### 4.5 Lint

```text
npx eslint lib/recovery/classifier.js lib/recovery/adapter.js `
  tests/wp04-03-recovery-classifier.test.mjs `
  tests/wp04-03-recovery-adapter.test.mjs `
  tests/helpers/recovery-fakes.mjs
```

Result: **0 errors, 0 warnings, 0 fatal errors** (5 files).

Node prints the repository's pre-existing `MODULE_TYPELESS_PACKAGE_JSON`
warning for `.js` ES modules. It is not caused by this work and `"type":
"module"` was not added.

---

## 5. Safety and compliance evidence

- **Pure classifier:** source scan finds no `mongoose`, `mongodb`,
  `MongoClient`, `createConnection`, `node:fs`, `node:net`, `node:http`,
  `process.env`, `Date.now`, `performance.now`, or `Math.random`.
- **Adapter:** the same scan is clean; all repositories are injected and the
  only method invoked is `findBounded`.
- **No write surface:** forbidden repository keys are rejected; the WriteTrap
  throws for every write/index/collection/session method; the facade has no
  write key.
- **No connection:** the adapter never imports a driver or opens a client.
- **No mutations:** outputs are deeply frozen; input evidence is unchanged
  after classification; no test performs a write.
- **Redaction:** allowlisted fields only; account numbers, holder names, PINs,
  tokens, item names, and free text are absent from projected evidence and
  findings.
- **Exact numerics:** V1 `Number` only; `1e-9` epsilon for boundary
  comparisons; `BigInt`, V2 scaled quantities, and Decimal128 are rejected, not
  coerced.
- **Strict time:** ISO-8601 UTC with milliseconds and `Z`; timezone offsets and
  date-only strings are rejected; the clock is injected.
- **Strict identity:** non-empty strings, safe integers, or 24-hex ObjectId
  tags; empty/malformed ids rejected; ids are not stringified ambiguously.
- **Missing index:** never assumed present; unknown/absent/unavailable evidence
  surfaces `INDEX_ABSENT_SUSPECTED` when duplicates exist, or on explicit
  `ABSENT`.
- **No side effects:** no route, service, model, index script, configuration,
  `.env`, database, staging, or production access.

---

## 6. Git comparison

Baseline snapshot (taken before WP04-03 work):

| Metric | Baseline | After WP04-03 (before this report) | Delta |
|---|---:|---:|---:|
| Entries | 309 | 314 | +5 |
| Modified | 61 | 61 | 0 |
| Untracked | 248 | 253 | +5 |
| Deleted | 0 | 0 | 0 |
| Staged | 0 | 0 | 0 |

Baseline SHA-256 of the status snapshot:
`fd38ee6dc799cd07c2fdfc5a116c65b4cc17c8d45d2592856ee0314e42e48de2`

Post-work SHA-256 (before this report):
`5fdc8b3891b0d7ee099594db02b7f00a43405a48b4732327b2b351f51df0d8f4`

The only added paths are exactly the five WP04-03 files:

```text
?? lib/recovery/adapter.js
?? lib/recovery/classifier.js
?? tests/helpers/recovery-fakes.mjs
?? tests/wp04-03-recovery-adapter.test.mjs
?? tests/wp04-03-recovery-classifier.test.mjs
```

No pre-existing path was removed, modified, staged, committed, pushed, reset,
cleaned, checked out, or stashed. Adding this report makes the final count
315 entries (61 modified + 254 untracked), verified after writing it, with the
report path:

```text
?? docs/production-readiness/wp-04-03-implementation-report.md
```

Final status SHA-256 (including this report):
`a3f36f80af3227f7f936762426bb4504eca1a4d655c2818c58b18645d441593a`

Branch remains `main`; HEAD remains
`69650435a6587d4577bc126f719fa1392bb934b3`.

---

## 7. Deferred issues

These are deliberately **not** emitted as findings because the approved
evidence projection does not contain the fields required to measure them. They
are recorded in the report's `deferred` array with a reason code.

| Rule / code | Reason | Consequence |
|---|---|---|
| `D05 / STALE_LIVE_HOLD` | `W_STALE` is not approved; reservation `updatedAt`/`decisionAt` are not projected by WP04-01 | D05 still reports orphan, terminal, and PAID holds; age is not asserted |
| `D06` age/staleness | Same threshold gap; reservation age cannot be measured | D06 emits alert-only state classifications with `thresholdState: "W_STALE_UNSET"`; no task |
| `D07 / STATION_PARTIAL_CONSUMPTION` | Station attribution is not part of the projected evidence | D07 reports consumed/movement and orphan-item mismatches only |

Other known, non-blocking limitations:

- D10 `LEGACY_SHAPE` emits INFO when both reservation fingerprints are null.
  This is intentional legacy visibility, not a defect.
- Aggregate/`watch`/transaction doubles exist only in the WriteTrap to prove
  they are never used; the adapter has no such method.
- The classifier groups bundles by order identity; callers must not pass two
  different orders under the same id (D10 identity checks still apply within a
  bundle).

No WP04-01 file was modified. The missing reservation timestamps are a WP04-01
scope decision, not a defect that blocks WP04-03.

---

## 8. Gates and authorization

No gate was signed, changed, or bypassed by this work package.

| Gate | State |
|---|---|
| G-PAY-1 | **BLOCKED** (unchanged; staging acceptance still absent) |
| G-REC | UNSIGNED |
| G-AUD | UNSIGNED |
| G-GOV | UNSIGNED |
| G-IDX | UNSIGNED |
| G-DB | UNSIGNED |
| G-PAY-2 | UNSIGNED |

WP04-04 and later work packages were **not** started. No database, staging,
production, secret, route, worker, scheduler, index, migration, or schema work
was performed.

---

## 9. Stop point

WP04-03 is complete. The next authorized action would require explicit
approval of WP04-04 or a gate decision; none was taken here.
