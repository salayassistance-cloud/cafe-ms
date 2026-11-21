# WP-04 — Test and Acceptance Plan

Status: **DESIGN ONLY — NO TEST RUN — NO DATABASE CONTACTED — NOT AUTHORIZED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch / HEAD: `main` / `69650435a6587d4577bc126f719fa1392bb934b3`
Parent: `wp-04-reconciliation-design.md`
Companions: `wp-04-detection-rule-matrix.md`, `wp-04-recovery-state-machine.md`
Baseline plans: `phase-2-5-test-and-acceptance-plan.md`, `phase-2-3-payment-inventory-failure-matrix.md`

> This plan does not run tests, open a database, read secrets, create collections or indexes, deploy code, or perform production operations. Every command is a proposal for a later, separately approved implementation phase. WP-04 authorizes no recovery execution, no inventory mutation, and no Inventory V2 activation. G-PAY-1 remains **BLOCKED**.

---

## 1. Test strategy

### 1.1 Layers

| Layer | Purpose | Environment | Can write? | WP-04 use |
|---|---|---|---|---|
| **L0 — Source-contract / pure unit** | Lock code shape, read-only guard, enums, classifier rules | Local Node.js | No | Required |
| **L1 — DB-free integration-style** | Exercise the classifier, fingerprint, and state machine with in-memory fixtures | Local Node.js | No | Required |
| **L2 — Disposable replica-set** | Prove read-only scans, index-present/absent behaviour, concurrency, leases, crash/unknown-commit | Isolated loopback replica set + throw-away DB | Yes, disposable only | Required for WP-04 read-only; worker cases are WP-06 |
| **L3 — Staging operational** | Prove representative volume, runtime, sample accuracy | Staging with disposable data | Read-only for WP-04 | Required for G-REC-1 |
| **L4 — Production read-only** | Evidence collection only | Production | **No** | Not part of WP-04; separate approval |

### 1.2 Hard rules

1. L2/L3 never use the application database, `MONGODB_URI`, `ROOM_MONGODB_URI`, or production credentials.
2. L2 uses a loopback-only, credential-free, phase-specific database name and an explicit acknowledgement flag.
3. No test may create `inventory_v2_*` collections or read V2 state.
4. No test may add `orderVersion`, `inventoryMode`, or a V2 runtime field.
5. No test may modify an existing database, even a staging one, during a WP-04 read-only run.
6. A test that requires a production secret is not a test; it is a manual evidence item.
7. A failing test blocks the rule and the acceptance gate; a later pass does not waive it.

### 1.3 Evidence labels

| Label | Meaning |
|---|---|
| **PASS (unit)** | DB-free test passed. |
| **PASS (real)** | Disposable replica-set test passed with real reads (and writes only where the test is explicitly a WP-05/WP-06 test). |
| **PASS (staging)** | Staging read-only drill passed with recorded evidence. |
| **SOURCE-ONLY** | Verified by code inspection; no runtime test yet. |
| **UNVERIFIED** | Requires staging/production/DBA/owner evidence. |

---

## 2. Baseline regression gate

### 2.1 Existing DB-free suite

The last recorded baselines are:

| Source | Recorded | Status in this task |
|---|---|---|
| Phase 2.3 | 1370 tests / 245 suites / 0 fail / 0 skipped | Reported, not re-run |
| Staging-readiness re-verification | 1408 tests / 254 suites / 0 fail / 0 skipped | Reported, not re-run |

The implementation phase must re-run the current full DB-free suite before adding WP-04 files. Acceptance baseline:

- 0 failures, 0 skipped, no database connection;
- no `.env`/`.env.local` read;
- no repository write during the test run;
- new tests are additive and do not weaken the baseline.

A regression blocks WP-04 implementation.

### 2.2 Existing disposable replica-set suite

The Phase 2.3/2.5 integration suite remains the transaction baseline (reported 16/16). WP-04 adds a new read-only integration file; it does not modify the existing evidence. If the existing suite cannot be re-run, WP-04 integration acceptance is blocked.

### 2.3 What WP-04 must not claim

- It does not re-run the prior 16/16 or 27/27 evidence.
- It does not prove G-PAY-1.
- It does not prove staging readiness.
- It does not prove deployed index presence.
- It does not prove production data is clean.

---

## 3. New DB-free tests (design)

### 3.1 Files

| File | Work package | Locks |
|---|---|---|
| `tests/phase25-recovery-reconciliation.test.mjs` | WP-04 | D01–D10 classification, fingerprint, output contract, read-only source contract |
| `tests/phase25-recovery-schema.test.mjs` | WP-05 (future) | task fields/enums, unique `taskId`, unique partial open task, no TTL, no V2 |
| `tests/phase25-recovery-lifecycle.test.mjs` | WP-06 (future) | transitions, lease, retry, unknown commit, separation of duties |
| `tests/integration/phase25-recovery-reconciliation.integration.mjs` | WP-04 | read-only proof, seeded classes, index-present/absent |
| `tests/integration/phase25-recovery-worker.integration.mjs` | WP-06 (future) | lease race, crash, unknown commit, R2/R4 |

WP-04 implementation creates only the first and fourth files. The others are listed for dependency clarity and are not part of WP-04 authorization.

### 3.2 Source-contract tests (L0)

The scanner and classifier must be provably read-only.

| # | Assertion | Method |
|---|---|---|
| SC-01 | No `insertOne`, `insertMany`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`, `findOneAndUpdate`, `findOneAndReplace`, `findOneAndDelete`, `bulkWrite` in the scanner/classifier import graph | Read the file slice; regex over executable code; strip comments and strings first |
| SC-02 | No `createIndex`, `createIndexes`, `dropIndex`, `dropIndexes`, `syncIndexes`, `createCollection`, `dropCollection` | Same |
| SC-03 | No `$out`, `$merge`, or `$function` stage in any aggregation | Same |
| SC-04 | No `--apply`, `--repair`, `--fix`, `--force`, `--execute` flag; unknown flag exits non-zero | Parse the argument list; assert rejection |
| SC-05 | No import of a write-capable service (`orderService`, `inventoryReservationService`, `inventoryDeductionService`, `inventoryService`, `inventoryReceiveService`, `inventoryWasteService`, `paymentInfoService`, V2 server modules) | Static import graph |
| SC-06 | No `inventory_v2` collection name | String/regex scan |
| SC-07 | No `orderVersion` or `inventoryMode` reference | String scan |
| SC-08 | Only read methods are exported from the scanner module | Export list |
| SC-09 | No `.env`/`.env.local` read | Parse for `dotenv`, `process.env` file reads, `readFileSync` on env paths |
| SC-10 | Output is deterministic for the same input | Two runs on the same fixture produce byte-identical JSON except `generatedAt` |

### 3.3 Pure classifier tests (L1)

Fixtures are plain objects; no Mongoose, no connection.

| # | Fixture | Expected |
|---|---|---|
| C-01 | `PAID`, no reservation, no movement, inventory-linked line | D01 `PAID_NO_RESERVATION_NO_DEDUCTION`, Critical, Medium |
| C-02 | `PAID`, `RELEASED(CONSUMPTION_FAILED)`, no movement | D01 `PAID_RELEASED_NO_DEDUCTION`, Critical, High |
| C-03 | `PAID`, `RESERVED`, positive hold | D01 `PAID_WITH_LIVE_RESERVATION`, Critical, High |
| C-04 | `PAID`, `CONSUMED`, one item `consumedQuantity=0`, no movement | D01 `CONSUMED_WITHOUT_ITEM_EVIDENCE`, Critical, Medium |
| C-05 | `PAID`, no reservation, legacy `SaleDeduction` | D01 `ALREADY_CORRECT_LEGACY`, Info |
| C-06 | `PAID`, only external/retail lines | D01 `NO_INVENTORY_REQUIREMENT`, Info |
| C-07 | `PAID`, approved shortage, lower `consumedQuantity` | D01 `APPROVED_SHORTAGE`, Info (not Critical) |
| C-08 | `PREPARING`, `SaleDeduction`, no `paidAt` | D02 no finding (legitimate prep consumption) |
| C-09 | `CANCELLED`, `SaleDeduction`, no void | D02 `TERMINAL_DEDUCTION_NO_VOID`, High |
| C-10 | `CANCELLED`, `SaleDeduction` reclassified to `Waste`, void present | D02 no finding |
| C-11 | Two identical `SaleDeduction` rows `(order,item)` | D03 `DUPLICATE_MOVEMENT_IDENTITY`, Critical |
| C-12 | Two rows with the same `sale:` key | D03 `DUPLICATE_IDEMPOTENCY_KEY`, Critical |
| C-13 | One `Correction` row with a valid reason | D03 no Critical finding |
| C-14 | Two reservations for one order | D04 `DUPLICATE_RESERVATION`, Critical |
| C-15 | Reservation with no order | D04 `ORPHAN_RESERVATION`, High |
| C-16 | `RELEASED` with `reservedQuantity>0` | D04 `RELEASED_WITH_HOLD`, High |
| C-17 | `APPROVED` with no approval | D04 `APPROVED_WITHOUT_APPROVAL`, High |
| C-18 | Live reservation on `CANCELLED` order | D05 `HOLD_ON_TERMINAL_ORDER`, High |
| C-19 | Live reservation on `PAID` order | D05 cross-reference + D01 primary |
| C-20 | `NO_INVENTORY` with zero hold | D05 no finding |
| C-21 | `CONSUMING`, age > `W_STALE`, movements complete, no hold | D06 `CONSUMING_MOVEMENTS_COMPLETE`, `FINALIZE_CANDIDATE` |
| C-22 | `CONSUMING`, age > `W_STALE`, partial movements | D06 `CONSUMING_PARTIAL`, Critical |
| C-23 | `CONSUMING`, age < `W_STALE` | D06 no finding (grace) |
| C-24 | `CONSUMED`, movement quantity ≠ `consumedQuantity` | D07 `CONSUMED_MOVEMENT_MISMATCH`, High |
| C-25 | `CONSUMED`, movement for an item not in reservation | D07 `MOVEMENT_WITHOUT_RESERVATION_ITEM`, High |
| C-26 | Multi-station order, all items consumed once | D07 no finding |
| C-27 | Whole order cancelled after consumption, `SaleDeduction` remains | D08 `CANCELLED_SALE_NOT_RECLASSIFIED`, High |
| C-28 | Whole order cancelled before consumption, hold remains | D08 `CANCELLED_HOLD_NOT_RELEASED`, High |
| C-29 | Line cancelled after consumption, no LINE void | D08 `LINE_CANCEL_NO_VOID`, Medium |
| C-30 | Line cancelled, item shared with active line | D08 no release finding |
| C-31 | `PAYMENT_PENDING` with `paidAt` | D09 `PENDING_WITH_PAID_AT`, Critical |
| C-32 | `PAID` with `TRANSFER` and no account | D09 `PAID_TRANSFER_WITHOUT_ACCOUNT`, High |
| C-33 | Prepared order with live hold | D09 `PREPARED_WITH_LIVE_HOLD`, High |
| C-34 | `PAYMENT_PENDING` with consumed stock | D09 no finding |
| C-35 | Unknown reservation status | D10 `UNKNOWN_ENUM`, High |
| C-36 | Negative quantity | D10 `NEGATIVE_QUANTITY`, High |
| C-37 | `consumedQuantity > requiredQuantity` | D10 `QUANTITY_OUT_OF_RANGE`, High |
| C-38 | Movement points to a missing order | D02 `ORPHAN_DEDUCTION` + D10 `ORPHAN_REFERENCE` |
| C-39 | Fingerprint changes between detection and execution | D10 `EVIDENCE_DRIFT`, High |
| C-40 | E0/E1 evidence for a class | D10 `EVIDENCE_INCOMPLETE`; no automatic action |

### 3.4 Fingerprint tests (L1)

| # | Assertion |
|---|---|
| FP-01 | Same evidence → same SHA-256 across processes. |
| FP-02 | Key insertion order does not change the hash. |
| FP-03 | `100` vs `100.0` canonicalize identically. |
| FP-04 | A changed `consumedQuantity` changes the hash. |
| FP-05 | A changed account number does **not** enter the hash input. |
| FP-06 | A changed `updatedAt` that is outside the decision scope does not change the hash. |
| FP-07 | A changed void timestamp changes the hash. |
| FP-08 | Unicode normalization is explicit and stable. |

### 3.5 State-machine tests (L1, future WP-05/WP-06)

| # | Assertion |
|---|---|
| SM-01 | Every legal transition in the state-machine document is accepted. |
| SM-02 | Every illegal transition is rejected. |
| SM-03 | `CLOSED`/`CANCELLED` cannot be reopened. |
| SM-04 | `LEASED → CLOSED` is rejected. |
| SM-05 | `MANUAL_REQUIRED → RESOLVED` is rejected. |
| SM-06 | `MANUAL_REQUIRED → LEASED` without approval is rejected. |
| SM-07 | `MANUAL_REQUIRED → LEASED` with approver == executor is rejected. |
| SM-08 | `RESOLVED → CLOSED` with verifier == approver or executor is rejected. |
| SM-09 | Lease acquire is atomic: two concurrent calls → one winner. |
| SM-10 | Renewal with a stale token fails. |
| SM-11 | Finish with a stale token fails. |
| SM-12 | Lease expiry allows reclaim with a new token. |
| SM-13 | Backoff schedule is exactly 30/60/120/240/480 s with the approved cap/jitter. |
| SM-14 | `attempts` increments on lease, not on action. |
| SM-15 | Max attempts → `MANUAL_REQUIRED`. |
| SM-16 | Unknown commit with exactly one effect → `ALREADY_CORRECT`. |
| SM-17 | Unknown commit with no effect and budget → retry. |
| SM-18 | Unknown commit with contradictory effect → `MANUAL_REQUIRED`. |
| SM-19 | Audit failure blocks the action. |
| SM-20 | No direct `$inc`/`$set` on stock/payment fields in the worker source. |

### 3.6 Output and redaction tests (L1)

| # | Assertion |
|---|---|
| OR-01 | `readOnly: true` is always present. |
| OR-02 | `--apply` exits non-zero and prints a refusal. |
| OR-03 | Account number is masked to last 4. |
| OR-04 | No PIN, token, cookie, session, or connection string appears in output. |
| OR-05 | Finding order is deterministic. |
| OR-06 | `evidenceLevel` is always one of E0–E3. |
| OR-07 | A finding always carries a `recommendedReview` and `autoRecovery: "PROHIBITED"`. |
| OR-08 | Exit code is `0` clean, `2` findings, `1` read error. |

---

## 4. Disposable replica-set integration plan (WP-04 read-only)

### 4.1 Harness

Reuse the Phase 2.5 pattern:

- `tests/helpers/pos-phase25-loader.mjs` — `@/` alias and extension resolution.
- `tests/helpers/pos-phase25-register.mjs` — loader registration.

The harness must enforce:

- `mongodb://` only, no credentials;
- loopback host only (`127.0.0.1`, `::1`, `localhost`);
- isolated port (proposed `27019`);
- database prefix `bono_pos_phase25_`;
- `POS_PHASE25_INTEGRATION_TESTS="1"`;
- `POS_PHASE25_TEST_TARGET_ACK="I_CONFIRM_DISPOSABLE_POS_REPLICA_SET"`;
- refusal of `MONGODB_URI`/`MONGO_URI`/`ROOM_MONGODB_URI`;
- drop only the verified phase-specific database created by the run;
- no `.env`/`.env.local` read.

### 4.2 Proposed command (not executed)

```powershell
$env:POS_PHASE25_INTEGRATION_TESTS="1"
$env:POS_PHASE25_TEST_TARGET_ACK="I_CONFIRM_DISPOSABLE_POS_REPLICA_SET"
$env:POS_PHASE25_TEST_MONGODB_URI="mongodb://127.0.0.1:27019/bono_pos_phase25_wp04_<unique>?directConnection=true"
node --import ./tests/helpers/pos-phase25-register.mjs --test tests/integration/phase25-recovery-reconciliation.integration.mjs
```

### 4.3 Read-only proof

For every integration case:

1. record collection counts and a deterministic document hash before the scan;
2. run the scanner;
3. record counts and hash after;
4. assert equality;
5. assert no new collection/index and no `inventory_v2_*` collection.

A scanner that mutates anything fails the test even if findings are correct.

### 4.4 Seeded classes

Seed via existing primitives where possible, not direct writes, so the test proves the production path:

| Class | Seed |
|---|---|
| D01 | complete a paid order without inventory; or force the payment fallback failure |
| D02 | create a legacy-style `SaleDeduction` with no reservation on a cancelled order |
| D03 | duplicate a movement through a controlled fixture (only where the unique index is absent) |
| D04 | two reservations (index absent) or a structurally invalid reservation |
| D05 | create a hold, then cancel the order without releasing |
| D06 | set `CONSUMING` through a controlled fixture; seed complete/partial/no movement variants |
| D07 | consume a multi-item reservation, remove one movement |
| D08 | cancel after consumption without a void, or cancel before consumption without release |
| D09 | set `PAYMENT_PENDING` with `paidAt`, or a prepared order with a live hold |
| D10 | unknown enum/negative quantity/missing reference fixtures |

Direct fixture writes are permitted **only inside the disposable database** and only to create a state that the production code cannot create safely. The test must never use direct writes against a non-disposable target.

### 4.5 Index-present and index-absent cases

| Case | Setup | Expected |
|---|---|---|
| IX-01 | Unique `(refOrderId, reason, item)` present | Duplicate insert rejected; D03 reports only pre-existing duplicates. |
| IX-02 | Index absent | Duplicate fixture is readable; D03 reports + `INDEX_ABSENT`. |
| IX-03 | Unique `orderId` present | Duplicate reservation insert rejected. |
| IX-04 | Index absent | D04 reports duplicates. |
| IX-05 | `idempotencyKey` present | Duplicate sale key rejected. |

WP-04 must not create the index; the test creates it only in the disposable database to prove detection under both conditions.

---

## 5. Failure matrix (required by the task)

Each row defines a real or simulated failure, the expected detection, the expected durable-task outcome, and the proof that no stock/payment was changed without approval.

| # | Scenario | Setup | Expected detection | Expected task state | Proof |
|---|---|---|---|---|---|
| **F-01** | Payment success / deduction failure | `payOrder` commits `PAID`; `consumeOrderInventory` fails (forced idempotency collision or transaction error) | D01 `PAID_RELEASED_NO_DEDUCTION` (or `PAID_WITH_LIVE_RESERVATION`) | `DETECTED` → future R2/R1 path; WP-04 leaves it open | Order `PAID`; hold released or live; zero `SaleDeduction`; one error log; no second payment |
| **F-02** | Duplicate worker execution | Two workers run the same task with the same evidence | Same class | One lease winner; second sees `LEASED`/`RESOLVED`; no duplicate effect | One movement per item; one `RECOVERY_EXECUTED`; no duplicate audit |
| **F-03** | Lease expiry | Worker acquires, stops renewing; another worker claims after expiry | Same class | `LEASED` → reclaim with new token; attempts increment | Old owner cannot finish; new owner re-reads; no duplicate effect |
| **F-04** | Process crash | Kill the worker after acquisition, before action; and after action commit, before finish | Same class | Expiry → reclaim; effect present exactly once → `ALREADY_CORRECT` | No duplicate movement; task evidence matches |
| **F-05** | Concurrent recovery claims | Two workers call acquire at the same instant | Same class | Exactly one `LEASED`; one `RECOVERY_LEASED` | Token/owner single-valued; loser re-reads |
| **F-06** | Incomplete movement evidence | Reservation `CONSUMED` but one item has no movement; or movement quantity partial | D07 `CONSUMED_MOVEMENT_MISMATCH` / `REQUIRED_ITEM_NOT_CONSUMED`; D10 `EVIDENCE_INCOMPLETE` if unreadable | `MANUAL_REQUIRED` | No stock write; expected vs actual recorded |
| **F-07** | Missing accounting evidence | `PAID` with no `paidAt`/method, or movement with no order, or reservation with no order | D09/D02/D04 + D10 | `MANUAL_REQUIRED` | No payment or stock change |
| **F-08** | Already-reconciled order | Rerun detection on a clean order; replay a resolved task | No finding (or `ALREADY_CORRECT` if a task existed) | `RESOLVED`/`CLOSED` or no task | Counts/hash unchanged; no new movement |
| **F-09** | Cancellation races | Payment vs cancel; line cancel vs prep; archive vs payment | D08/D09 as applicable | Manual; no automatic release | Final state is either `PAID` with evidence or terminal with void/release; no lost payment |
| **F-10** | Partial multi-station deductions | Multi-item/multi-station order; only some items consumed/moved | D07 `CONSUMED_MOVEMENT_MISMATCH` / `STATION_PARTIAL_CONSUMPTION` | `MANUAL_REQUIRED` (R4 may finalize status only when conclusive) | Stock unchanged by WP-04; per-item expected/actual recorded |

### 5.1 Additional failure rows

| # | Scenario | Expected |
|---|---|---|
| F-11 | Unknown commit with effect present | Resolve `ALREADY_CORRECT`; no retry. |
| F-12 | Unknown commit with effect absent | Retry same identity within budget. |
| F-13 | Unknown commit contradictory | `MANUAL_REQUIRED`; no second write. |
| F-14 | Audit insert fails | Action not applied; task stays open; alert. |
| F-15 | Evidence drift mid-task | Abort, re-classify, no action. |
| F-16 | Kill switch off | Worker exits; tasks durable. |
| F-17 | Standalone topology | `503 TRANSACTIONS_UNAVAILABLE`; no write. |
| F-18 | Scanner read timeout | Exit non-zero; no partial report presented as complete. |
| F-19 | Masked account in output | Last 4 only; no full number. |
| F-20 | V2 collection present | `V2_PRESENT_UNEXPECTED`; stop classifying; no V2 read/write. |

---

## 6. Test cases per detection rule

### 6.1 D01 — `PAID` missing deduction

| # | Case | Expected |
|---|---|---|
| D01-01 | `PAID`, no reservation, inventory-linked line | Critical finding |
| D01-02 | `PAID`, `RELEASED(CONSUMPTION_FAILED)`, no movement | Critical finding |
| D01-03 | `PAID`, `RESERVED`, positive hold | Critical finding |
| D01-04 | `PAID`, `CONSUMED`, missing item evidence | Critical/Medium |
| D01-05 | `PAID`, legacy `SaleDeduction`, no reservation | `ALREADY_CORRECT_LEGACY`, Info |
| D01-06 | `PAID`, external-only lines | `NO_INVENTORY_REQUIREMENT`, Info |
| D01-07 | `PAID`, approved shortage | `APPROVED_SHORTAGE`, Info |
| D01-08 | `PAID`, clean consumption | No finding |

### 6.2 D02 — Deduction without payment

| # | Case | Expected |
|---|---|---|
| D02-01 | `PREPARING`, `SaleDeduction`, no `paidAt` | No finding |
| D02-02 | `CANCELLED`, `SaleDeduction`, no void | High finding |
| D02-03 | `CANCELLED`, reclassified `Waste`, void present | No finding |
| D02-04 | Movement with no order | Critical finding |
| D02-05 | `SERVED`, deduction, no `preparingAt` | High/Medium finding |
| D02-06 | `PAID`, deduction | Deferred to D01 |

### 6.3 D03 — Duplicate movements

| # | Case | Expected |
|---|---|---|
| D03-01 | Two identical `(order,item,SaleDeduction)` | Critical |
| D03-02 | Two identical `sale:` keys | Critical |
| D03-03 | One `SaleDeduction` + one `Waste` reclassification | No duplicate |
| D03-04 | Multiple `Correction` rows | Info |
| D03-05 | Malformed `sale:` key | High |

### 6.4 D04 — Duplicate/inconsistent reservations

| # | Case | Expected |
|---|---|---|
| D04-01 | Two reservations, one order | Critical |
| D04-02 | Reservation with no order | High |
| D04-03 | `CONSUMED` with no `consumedAt` | High |
| D04-04 | `RELEASED` with a hold | High |
| D04-05 | `APPROVED` without approval | High |
| D04-06 | Approval fingerprint mismatch | Medium |
| D04-07 | `NO_INVENTORY`, zero items | No finding |

### 6.5 D05 — Expired/abandoned reservations

| # | Case | Expected |
|---|---|---|
| D05-01 | Hold on `CANCELLED` order | High |
| D05-02 | Hold on `PAID` order | D01 primary, D05 cross-reference |
| D05-03 | `PENDING` older than `W_STALE` | Medium |
| D05-04 | `APPROVAL_REQUIRED` awaiting manager | Info/Medium |
| D05-05 | `NO_INVENTORY`, zero hold | No finding |

### 6.6 D06 — `CONSUMING`

| # | Case | Expected |
|---|---|---|
| D06-01 | Complete movements, no hold | `FINALIZE_CANDIDATE` |
| D06-02 | Partial movements | Critical |
| D06-03 | No movements, stock unchanged | `CONSUMING_ABANDONED`, Medium |
| D06-04 | No movements, stock decremented | Critical |
| D06-05 | Age < `W_STALE` | No finding |

### 6.7 D07 — Partial multi-station

| # | Case | Expected |
|---|---|---|
| D07-01 | Quantity mismatch | High |
| D07-02 | Required item not consumed, no shortage | High/Medium |
| D07-03 | Movement not in reservation | High |
| D07-04 | Approved shortage | No finding |
| D07-05 | Whole order consumed at first station | No finding |

### 6.8 D08 — Cancelled items

| # | Case | Expected |
|---|---|---|
| D08-01 | Whole cancel after consumption, sale remains | High |
| D08-02 | Whole cancel before consumption, hold remains | High |
| D08-03 | Line cancel after consumption, no LINE void | Medium |
| D08-04 | Line cancel, item shared with active line | No release finding |
| D08-05 | Duplicate void | Medium |
| D08-06 | Archive with `source: ARCHIVE` | Accepted |

### 6.9 D09 — Payment verification/rejection

| # | Case | Expected |
|---|---|---|
| D09-01 | `PAYMENT_PENDING` with `paidAt` | Critical |
| D09-02 | `PAYMENT_PENDING` without submission | High |
| D09-03 | `PAID` without `paidAt` | High |
| D09-04 | `PAID` `TRANSFER` without account | Medium |
| D09-05 | Prepared order with live hold | High |
| D09-06 | `PAYMENT_PENDING` with consumed stock | No finding |
| D09-07 | Rejected payment with consumed stock | No finding (by design) |

### 6.10 D10 — Evidence integrity

| # | Case | Expected |
|---|---|---|
| D10-01 | Unknown enum | High |
| D10-02 | Negative quantity | High |
| D10-03 | `consumedQuantity > requiredQuantity` | High |
| D10-04 | Missing reference | High |
| D10-05 | Contradictory timestamps | High |
| D10-06 | Fingerprint drift | High |
| D10-07 | E0/E1 evidence | Blocks automatic action |

---

## 7. Manual and staging verification

### 7.1 Staging prerequisites

> **Readiness resolution RC-1 / RC-4 / RC-6 (2026-11-14, documentation only).** Environment access, pilot execution, and data-seeding authorization are **three separate authorizations**. None implies another. Seeding is **not** an environment-access prerequisite, but it **is** required for M-02 coverage. The counts/hash method is proposed but **BLOCKED** pending owner approval. The CLI interface below was verified against `scripts/inventory-recovery-scan.mjs`; no scanner run was performed.

**A. Environment access (blocks any connection).**

- An approved isolated staging environment with a disposable POS database (G0-1, G0-2).
- A dedicated staging MongoDB target, confirmed isolated from production and Hotel data (G0-3).
- A read-only database credential or an explicitly read-only session, scoped to that database.
- A named inventory manager, finance reviewer, and independent verifier.
- A log capture path that does not expose secrets (G0-7).
- An approved scan window and change/ticket reference (G0-10).
- A documented cleanup/rollback and a named cleanup owner (G0-8).

**B. Pilot execution (blocks the scan even after A).**

- The read-only credential is issued to the named operators only for the approved window.
- A complete, signed L2 disposable replica-set evidence package (WP04-05). AUTH-2 was granted on 2026-11-11 for the bounded disposable proof only, and the proof executed 19/19. However, the executed suite did not record the G-REC-1 L2 read-only evidence (seeded D01–D10 classification, before/after counts/hash, no-new-collection/index baseline), and no owner acceptance exists. This is an open prerequisite. Environment approval does not authorize L2, and the prior AUTH-2 does not authorize new proof work.
- No write, repair, hold release, recovery-task creation, or runtime activation is authorized.

> **Status reconciliation RC-8 (2026-11-14, documentation only).** The owner has accepted the later **WP04-05 L2 supplementary proof** — **ACCEPTED — PASS** — for the completed disposable local authenticated replica-set proof only (D01–D10 observed; verifier `ok: true`, zero violations; counts, canonical BSON digests, collection and index inventories unchanged; redaction/determinism/negative controls passed; clean teardown). The preceding prerequisite paragraph is retained as the record of the prior state. The acceptance satisfies the L2 disposable-proof prerequisite for its limited scope, but it is **not** overall L2 acceptance, **not** a G-REC-1 signature, and **not** authorization for L3, staging, or production. G-REC-1 criteria 8, 10 (staging part), 11, and 12 remain open; the 2026-11-11 bounded persistence proof remains not accepted as L2. See `wp-04-05-disposable-replica-set-proof-report.md` §11.

**C. Seeded-data authorization (separate write authorization; blocks M-02 only).**

- M-02 requires a seeded copy containing at least one instance of each detectable class D01–D10.
- Seeding is a **write** operation. It is **not** an environment-access prerequisite and must never use the scan credential.
- Seeding requires its own owner approval, a DBA-approved method, a named seeder, synthetic-only source data, and a cleanup record.
- **Status: BLOCKED** until that separate authorization exists. Without C, a pilot may still prove M-01 and the CLI/redaction checks on existing approved staging data, but M-02 and the D01–D10 coverage acceptance criterion cannot pass.

**Counts/hash method (RC-4).** No method is currently approved, and the scanner does not emit counts or hashes. The proposed minimum read-only method is: `getCollectionNames()`; `getCollectionInfos()` / `getIndexes()` per collection; `countDocuments({})` per collection; and a per-collection digest computed as SHA-256 over the sorted per-document SHA-256 digests of each document's canonicalized BSON (stable key order, typed values preserved), computed by the approved read-only client, retaining only the digests and never logging or exporting document content; plus a digest of the sorted collection-name list. `system.*` collections are excluded. If the read-only role cannot compute a content digest, the DBA must provide an equivalent server-side read-only digest (for example, `dbHash`), or the method remains BLOCKED. **Status: BLOCKED — pending owner approval of this method at G0-1. RC-4 creates no script and changes no scanner code.** Until approved, M-04, M-05, and M-08 remain BLOCKED.

> **Counts/hash reconciliation (2026-11-14, documentation only).** The canonical BSON digest specification used by the accepted WP04-05 L2 supplementary proof records owner approval on 2026-11-14 for that bounded disposable proof only (`wp-04-05-l2-canonical-bson-digest-spec.md`). That approval does **not** approve the staging counts/hash method at G0-1, does **not** clear RC-4 for M-04/M-05/M-08, and does **not** authorize L3 or staging. The staging method remains **BLOCKED** as stated above.

**Verified CLI interface (RC-6).** The parser's accepted flags are exactly: `--confirm`, `--allow-production`, `--allow-remote`, `--fail-on-findings`, `--format`, `--since`, `--until`, `--max-orders`, `--max-docs-per-order`, `--max-inventory-items`, `--help`, `-h`. Required: `--since` and `--confirm`. `--format` accepts `summary` or `json`. The proposed command is valid:

```
MONGODB_URI=... node scripts/inventory-recovery-scan.mjs --since <YYYY-MM-DDTHH:MM:SS.sssZ> --until <YYYY-MM-DDTHH:MM:SS.sssZ> --confirm --format json
```

Both timestamps must be ISO-8601 UTC with milliseconds and `Z`. `--until` is optional and must not precede `--since`.

`--allow-remote` is added only for an owner-approved non-loopback host. `--allow-production` and `RECOVERY_SCAN_APPROVAL` are never used for staging. `--fail-on-findings` is supported but is not used for acceptance evidence because it returns exit `3`. `--apply` and every other write-like flag are rejected before any database module is imported.

**Current status: ENVIRONMENT ACCESS BLOCKED.** The `staging-readiness-report.md` records that no approved isolated staging environment exists. WP-04 cannot complete G-REC-1 staging evidence until A, B, and the M-02 seeding authorization exist. G-PAY-1 remains blocked for the same environment reason and is not waived.

**Remaining contradiction (RC-7, corrected 2026-11-14).** AUTH-2 **was granted** on 2026-11-11 for the bounded WP04-05 disposable proof, recorded in `wp-04-05-disposable-replica-set-proof-report.md` header and §10. The proof executed 19/19. The earlier “AUTH-2 not granted / NOT AUTHORIZED” wording was incorrect. What remains missing is the **G-REC-1 L2 evidence package** (criteria 5–7) and **owner acceptance**; the proof report says work halts pending formal owner review. WP04-06/L3 remains unauthorized. **Owner decision required:** record acceptance only if the required L2 artifacts are produced, or authorize a bounded supplementary L2 read-only run. Until then, L3 is blocked independently of staging.

### 7.2 Manual checklist

| # | Check | Evidence |
|---|---|---|
| M-01 | Run the scanner read-only on the staging copy | Command, output, exit code |
| M-02 | Each of D01–D10 is represented and classified | Sample per rule |
| M-03 | A sample of findings matches manual read-only queries | Query text + expected/actual |
| M-04 | Document counts/hashes are unchanged before/after | Before/after evidence |
| M-05 | No new collection or index was created | `getCollectionNames` / `getIndexes` |
| M-06 | No `inventory_v2_*` collection exists or was read | Collection list |
| M-07 | Output contains no account number beyond last 4, PIN, token, or connection string | Redaction sample |
| M-08 | Runtime and scanned counts are recorded | Timing + counts |
| M-09 | `--apply` and unknown flags are refused | CLI evidence |
| M-10 | The report is stable across two runs | Diff of two runs |
| M-11 | The owner reviews the finding format and retention | Signed review |
| M-12 | No application source or UI changed | Diff review |

### 7.3 Production read-only (only with separate approval)

Not part of WP-04. If ever approved, it is limited to:

- collection names and index metadata;
- counts and aggregate reconciliation numbers;
- no document content export without approval;
- no write, no failover, no restore, no index operation.

---

## 8. Acceptance criteria

### 8.1 G-REC-1 — read-only inventory reconciliation available

| Criterion | Evidence |
|---|---|
| The scanner/classifier implements D01–D10 | Source + DB-free tests |
| Every rule has a positive and negative fixture | L1 suite results |
| The scanner is provably read-only | Source-contract tests + integration before/after hash |
| A disposable replica-set run classifies seeded classes | L2 results |
| A staging read-only run matches manual queries on a sample | L3 evidence |
| No write path exists (`--apply` refused) | CLI test |
| No V2 collection is read or created | Integration evidence + source scan |
| Output is redacted and deterministic | L1 + staging sample |
| The report states confidence, severity, evidence level | Output schema test |
| No application source, schema, index, or UI changed | Diff review |
| The owner signs the report format and retention | Signed review |

**Current evidence status (2026-11-14, RC-5 / RC-8).** The R-1 read-only source is present and formally accepted (2026-11-14); it supports the DB-free source, classifier, CLI, and determinism rows. The WP04-05 L2 supplementary proof is owner-accepted (2026-11-14) for its limited disposable scope: seeded D01–D10 classification, before/after counts and canonical BSON digests, and the no-new-collection/index baseline are proven there (criteria 5–7). That acceptance is **not** overall L2 acceptance. L3 staging sample evidence does not exist, and the retention signature is deferred. Criteria 8, 10 (staging part), 11, and 12 remain open.

**Acceptance decision:** G-REC-1 is **NOT signed** by this document. It requires the implementation and evidence above. WP-04 design review is complete when the owner has reviewed all four documents and answered the open decisions.

### 8.2 What is explicitly not accepted here

| Gate | Status |
|---|---|
| G-PAY-1 | **BLOCKED** — no approved staging acceptance. |
| G-REC-2 (recovery schema/index) | Schema contract approved (OD-10); index not deployed; WP04-07 not started. |
| G-REC-3 (worker lease/retry/audit) | Not started; WP-06. |
| G-AUD-1 (append-only audit) | Not started; WP-07. |
| G-GOV-1 (RACI signed) | Names not assigned. |
| Inventory V2 activation | **Prohibited.** |

### 8.3 Evidence package

Store together:

1. baseline `git status` fingerprint (before and after);
2. DB-free test output;
3. disposable replica-set output;
4. staging command, output, counts, and before/after hash;
5. the sample manual queries and their results;
6. redaction sample;
7. the owner's signed review and retention decision;
8. a statement that no production database was contacted.

---

## 9. Stop conditions

Stop and return to the owner if:

1. the existing DB-free or integration baseline cannot be reproduced;
2. a test requires production data, a production credential, or a destructive operation;
3. a rule would change an accounting or inventory quantity;
4. a class cannot be classified without a business/accounting decision;
5. a unique index build finds duplicates that would require data deletion (R5) without an approved manual review;
6. a recovery action would write stock/payment outside the existing conditional primitive;
7. finance has not approved the adjustment/shortage boundary;
8. the RACI has no named approver, executor, or verifier;
9. a proposed change would activate V2, add `orderVersion`/`inventoryMode`, change Hotel, or alter POS UI;
10. a C2/C3/C4/C5 change would be bundled with a C1 deploy;
11. the scanner cannot be proven read-only;
12. a staging run would touch a non-disposable database.

---

## 10. Explicit statement

**No test was run in WP-04. No database was contacted. No collection or index was created. No stock, payment, order, reservation, movement, or audit record was changed. No application source code was modified. Inventory V2 was not activated. G-PAY-1 remains blocked.**
