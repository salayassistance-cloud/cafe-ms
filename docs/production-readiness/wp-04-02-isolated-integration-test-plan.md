# WP04-02 — Isolated Integration Test Plan (Design Only)

Status: **DESIGN ONLY — NO TEST FILE CREATED, NO DATABASE USED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`

> This plan defines how a future authorized package proves the read-only reconciliation adapter and classifier without touching staging, production, or any non-disposable database. **Nothing in this document has been executed beyond the existing WP04-01 DB-free suite.** No test file is added or modified by WP04-02.

---

## 1. Principles

1. **Layered isolation.** Pure logic is proven with zero I/O; database behavior is proven only on a disposable replica set under separate authorization.
2. **No write path in the test subject.** The adapter is exercised with fake repositories that fail the test if any write method is called.
3. **Synthetic evidence only.** Fixtures are hand-built objects. No production document, account number, PIN, token, or personal record is copied.
4. **Determinism.** Every case asserts an exact fingerprint or exact finding set; no time-of-day or locale dependence.
5. **Fail closed.** Malformed, unknown, or oversized evidence must produce a typed error, never a guess.
6. **Gate honesty.** A green L1 suite does not satisfy G-REC-1. Only L2 and an approved sample satisfy it.

---

## 2. Test levels

| Level | Name | Environment | DB allowed | Authorization needed |
|---|---|---|---|---|
| **L0** | Pure unit | Node process | No | Already authorized (WP04-01) |
| **L1** | Adapter contract with fakes | Node process | No | Future WP04-03 |
| **L2** | Disposable replica set | Local `mongod --replSet` container or equivalent | Disposable only | Separate owner authorization + G-DB-2/G-DB-4 |
| **L3** | Approved staging sample | Isolated approved staging copy | Read-only | Separate owner authorization + G-PAY-1 unblock |

No level above L1 is authorized by WP04-02.

---

## 3. L0 — Existing baseline (already passing)

WP04-01 provides 43 DB-free tests: `tests/wp04-01-recovery-core.test.mjs`.

| Area | Cases | Reference |
|---|---|---|
| Registry vocabulary | 9 | test file `:170-303` |
| Evidence projection | 13 | test file `:304-497` |
| Fingerprint | 15 | test file `:498-697` |
| Read-only source contract | 6 | test file `:698-762` |

Current result: **43 pass, 0 fail, 0 skipped, exit 0** (re-verified 2026-11-08).

Command:

```powershell
node --test tests/wp04-01-recovery-core.test.mjs
```

These tests already lock the registry, projection, and fingerprint. L1 adds adapter behavior; it does not duplicate L0.

---

## 4. L1 — Adapter contract tests (future, DB-free)

### 4.1 Test doubles

| Double | Contract |
|---|---|
| `FakeOrderRepository` | `findBounded(filter, projection, options)` returns capped synthetic arrays; records call arguments |
| `FakeReservationRepository` | same, plus `findByOrderIds(ids, options)` |
| `FakeMovementRepository` | same, plus `countByOrderIds(ids)` |
| `FakeInventoryRepository` | same, `findByIds(ids)` |
| `WriteTrap` | every write/index/collection method throws `UNEXPECTED_WRITE` |

Rule: the adapter receives repository objects by injection. It must never import `lib/mongodb.js`, a model, or a service.

### 4.2 Cases

| ID | Assertion | Failure mode covered |
|---|---|---|
| **INT-01** | Adapter exports no write-capable function | Accidental mutation surface |
| **INT-02** | Source imports contain no `mongoose`, `mongodb`, `@/lib/mongodb`, or write service | Boundary breach |
| **INT-03** | Adapter calls only read methods on every double | Silent write |
| **INT-04** | Every query carries an explicit limit and a `since`/`until` bound | Unbounded scan |
| **INT-05** | Query filters are lifecycle-aware: D01 selects `PAID`; D02 excludes `PAID`; D06 selects `CONSUMING` only | Cross-rule double reporting |
| **INT-06** | Results are ordered deterministically by `orderId`, then rule code | Non-deterministic output |
| **INT-07** | Per-order child reads are capped (`maxDocsPerOrder`) and exceeding the cap yields a typed `EVIDENCE_BOUND_EXCEEDED`-class result | Hostile document blow-up |
| **INT-08** | Missing reservation yields explicit "absent" evidence, not an exception | Legacy orders |
| **INT-09** | Missing order for a movement yields an orphan finding candidate, not a crash | D02/D03 orphan case |
| **INT-10** | Adapter never projects a whole document (assert projected key set equals the allowlist) | Data leak |
| **INT-11** | Adapter never includes account numbers, PINs, tokens, or free text in output | Sensitive leak |
| **INT-12** | Adapter returns frozen objects | Downstream mutation |
| **INT-13** | Adapter propagates typed projection errors unchanged and redacts payloads | Log leakage |
| **INT-14** | Adapter works with index-absent behavior simulated (fake returns duplicates/unsorted) | Deployment variance |
| **INT-15** | Adapter does not depend on wall-clock time beyond an injected `now` | Non-determinism |

### 4.3 Classifier contract cases (future WP04-03)

| ID | Assertion |
|---|---|
| **CLS-01** | Exactly D01–D10 can be emitted; an unknown rule id is rejected |
| **CLS-02** | D02 and D09 emit `findingCodeOnly` results with no durable class and no task payload |
| **CLS-03** | D06 emits `ALERT_ONLY` and no task payload |
| **CLS-04** | No rule emits an auto-repair or correction quantity |
| **CLS-05** | Shortage is reported as a quantity observation only; no correction is computed |
| **CLS-06** | Output is stable across repeated runs and key order permutations |
| **CLS-07** | Equivalent evidence → identical fingerprint; material change → different fingerprint |
| **CLS-08** | Lifecycle exclusions hold: clean consumption, valid void, approved shortage, inventory-free order produce no defect |
| **CLS-09** | A `PAID` + `RELEASED(CONSUMPTION_FAILED)` + no movement fixture yields D01 only, not D02 |
| **CLS-10** | A `CONSUMING` fixture without an approved stale threshold yields an alert, not a task |
| **CLS-11** | No output contains a personal name, account number, or free-text reason |
| **CLS-12** | The classifier performs no I/O (source contract) |

### 4.4 Commands (future)

```powershell
node --check lib/recovery/adapter.js
node --check lib/recovery/classifier.js
node --test tests/wp04-03-recovery-adapter.test.mjs
node --test tests/wp04-03-recovery-classifier.test.mjs
npx eslint lib/recovery tests/wp04-03-recovery-adapter.test.mjs tests/wp04-03-recovery-classifier.test.mjs
```

No such files exist today.

---

## 5. L2 — Disposable replica-set integration (future, separately authorized)

### 5.1 Preconditions

- Written owner authorization naming the disposable environment.
- G-DB-2 / G-DB-4 evidence package.
- No connection string read from a shared `.env`; the test harness receives an explicit ephemeral URI.
- The database name must contain a disposable marker (for example `wp04_it_<timestamp>`), and the harness must refuse any database name not matching it.
- The harness must never run against `MONGODB_URI`, `MONGO_URI`, or `ROOM_MONGODB_URI`.

### 5.2 Seeded classes (synthetic)

| Fixture | Shape | Expected |
|---|---|---|
| `FX-D01` | PAID order, reservation RELEASED with `releaseReason=CONSUMPTION_FAILED`, no effective movement | D01 finding |
| `FX-D01-OK` | PAID order, reservation CONSUMED, one movement | No finding |
| `FX-D02` | CANCELLED order, effective SaleDeduction, no void | D02 finding |
| `FX-D03` | Two effective SaleDeduction rows for `(order, item)` | D03 finding |
| `FX-D04` | Two reservations for one order | D04 finding |
| `FX-D05` | Live hold on CANCELLED order | D05 finding |
| `FX-D06` | Reservation stuck CONSUMING with an injected old timestamp | D06 alert only |
| `FX-D07` | Consumed reservation, movement totals mismatch | D07 finding |
| `FX-D08` | CANCELLED order with consumed sale not reclassified | D08 finding |
| `FX-D09` | `PAYMENT_PENDING` with `paidAt` set | D09 finding code |
| `FX-D10` | Unknown enum / malformed quantity | D10 finding |
| `FX-CLEAN` | Fully consistent order | No finding |

All fixture names are design labels only; no fixture files are created in this package.

### 5.3 Cases

| ID | Assertion |
|---|---|
| **IT-01** | Adapter opens no write transaction; server-side operation profiling shows only `find`/`aggregate` with no `$out`/`$merge` |
| **IT-02** | No collection is created or dropped during the run |
| **IT-03** | With the intended unique indexes present, each fixture yields the expected finding set |
| **IT-04** | With the unique indexes absent (simulated by dropping on the disposable DB), duplicate detection reports `INDEX_ABSENT_SUSPECTED` and still produces no write |
| **IT-05** | Read-only database user (if provisioned) can execute every query; any write attempt fails with authorization error |
| **IT-06** | Bounded query respects `limit` and time window |
| **IT-07** | Snapshot consistency: a concurrently inserted movement either appears fully or not at all per declared read concern; no mixed torn state is classified |
| **IT-08** | Timeout produces a typed error, not a partial finding set |
| **IT-09** | Fingerprint of the same seeded order is stable across two runs |
| **IT-10** | Changing only a classification-only field does not change the fingerprint |

### 5.4 Explicit prohibition

Do not reuse a shared developer database. Do not clone staging. Do not run these cases against any database that is not created and destroyed by the harness in the same run.

---

## 6. L3 — Approved staging sample (future)

Only after L2 and a signed evidence package:

1. Owner approves a named, isolated read-only copy.
2. Scan window and sample size are owner-supplied, not invented.
3. Output contains only finding codes, bounded evidence, and fingerprints.
4. A human compares a small sample against source records.
5. No write, no repair, no hold release is executed.

**Ordering resolution (RC-2, 2026-11-14).** In this section, “G-PAY-1 is unblocked” means only that the **shared staging-environment blocker** has been cleared by G0-1/G0-2/G0-3 approval. It does **not** mean G-PAY-1 is signed, accepted, or waived. G-PAY-1 keeps its own G0 checklist and cases and remains **BLOCKED** until those pass. Once the environment is approved and L2 is signed, L3 may run as read-only G-REC-1 evidence without waiting for G-PAY-1 acceptance, but it may not use G-PAY-1's payment fixtures or write authorization, and it does not clear G-PAY-1. If the environment approval is refused, both L3 and G-PAY-1 remain blocked. No bypass exists. **L2 is not complete:** AUTH-2 was granted for the bounded WP04-05 proof on 2026-11-11 and it executed 19/19, but the required G-REC-1 L2 read-only evidence and owner acceptance are not recorded. No new AUTH-2 is required for that bounded proof; L3 remains unauthorized and cannot start until a complete, accepted L2 evidence package exists.

> **Supplementary-proof reconciliation (2026-11-14, documentation only).** The owner has accepted the later **WP04-05 L2 supplementary proof** — **ACCEPTED — PASS** — for the completed disposable local authenticated replica-set proof only (D01–D10 observed; independent verifier `ok: true` with zero violations; before/after counts, canonical BSON digests, collection and index inventories unchanged; read-only privilege, redaction, determinism, and negative-control checks passed; clean teardown). This acceptance is **not** overall L2 acceptance, **not** a G-REC-1 signature, and **not** L3/staging/production authorization. The preceding paragraph is retained as the record of the prior state. L3 remains unauthorized until the remaining G-REC-1 evidence and approvals exist; the 2026-11-11 bounded persistence proof remains not accepted as L2. See `wp-04-05-disposable-replica-set-proof-report.md` §11.

---

## 7. Coverage matrix

| Requirement | L0 | L1 | L2 | L3 |
|---|---|---|---|---|
| D01–D10 vocabulary | ✅ | ✅ | ✅ | ✅ |
| D02/D09 finding-only | ✅ | ✅ | ✅ | ✅ |
| D06 alert-only | ✅ | ✅ | ✅ | ✅ |
| Allowlist / sensitive exclusion | ✅ | ✅ | ✅ | ✅ |
| Numeric exactness | ✅ | ✅ | ✅ | ✅ |
| Identifier/date canonicalization | ✅ | ✅ | ✅ | ✅ |
| Fingerprint determinism | ✅ | ✅ | ✅ | ✅ |
| No database dependency | ✅ | ✅ | n/a planned | n/a |
| No write capability | ✅ | ✅ | ✅ | ✅ |
| Index-present/absent | — | simulated | ✅ | ✅ |
| Staging realism | — | — | partial | ✅ |

---

## 8. What this package deliberately does not do

- Does not create `lib/recovery/adapter.js` or `lib/recovery/classifier.js`.
- Does not create `tests/wp04-03-*.test.mjs`.
- Does not start a disposable database.
- Does not add npm scripts.
- Does not touch `.env` or any connection string.
- Does not authorize L2 or L3.

---

## 9. Acceptance for the future first integration package

The next package may be reported complete only if:

1. L0 remains green (43/43) and L1 passes with zero writes observed.
2. The adapter source contract proves no DB import and no write method.
3. Every query has an explicit bound and lifecycle filter.
4. Findings are deterministic and match the approved matrix.
5. D02/D09/D06 constraints hold at the output layer.
6. No route, service, schema, or index is modified.
7. A separate owner authorization exists for any L2 work.
