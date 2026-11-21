# Phase 2.5 — Test and Acceptance Plan

Status: **READ-ONLY PLANNING — NOT EXECUTED, NOT AUTHORIZED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Basis: `phase-2-5-implementation-blueprint.md`, `phase-2-5-work-package-matrix.md`
Purpose: define the automated, disposable-database, and manual evidence required before any Phase 2.5 work package is accepted

> This plan does not run tests, connect to a database, read secrets, deploy indexes, or perform production operations. All commands below are proposed for the implementation phase and require explicit approval. The existing Phase 2.3 evidence remains the baseline: **1370 DB-free tests / 245 suites / 0 fail / 0 skipped** and **16/16 disposable replica-set tests**.

---

## 1. Test strategy

### 1.1 Layers

| Layer | Purpose | Environment | Can write? | Required for |
|---|---|---|---|---|
| **L0 — Source-contract / pure unit** | Lock code shape, enums, guards, and pure rules without a database | Local Node.js | No | Every C1/C2 WP |
| **L1 — DB-free integration-style** | Exercise services with fakes/in-memory fixtures where possible | Local Node.js | No | Payment rules, classification, idempotency rules, audit redaction |
| **L2 — Disposable replica-set** | Prove transactions, uniqueness, concurrency, leases, index behavior | Isolated loopback replica set + throw-away DB | Yes, disposable only | WP-01, WP-05, WP-06, WP-07, WP-10, WP-11, WP-12, WP-14 |
| **L3 — Staging operational** | Prove topology, failover, pool, restore, destructive gate, alerts | Staging with disposable data | Yes, disposable only | WP-08, WP-13, WP-15, WP-16 |
| **L4 — Production read-only** | Evidence collection only | Production | **No** | WP-13, release gate |

### 1.2 Hard rules

1. L2/L3 never use the application database, `MONGODB_URI`, `ROOM_MONGODB_URI`, or production credentials.
2. L2 uses a loopback-only, credential-free, phase-specific database name and an explicit acknowledgement flag.
3. L3/L4 never run a destructive script, failover, index drop, or restore against production without a separate signed change.
4. A test that requires a production secret is not a valid test; it is a manual evidence item.
5. No test may use Inventory V2 or create `inventory_v2_*` collections.
6. No test may add `orderVersion` or `inventoryMode`.
7. A failing test blocks the work package and the wave. It is not waived by a later passing test.

### 1.3 Evidence labels

| Label | Meaning |
|---|---|
| **PASS (unit)** | DB-free test passed. |
| **PASS (real)** | Disposable replica-set test passed with real sessions/writes. |
| **PASS (staging)** | Staging drill passed with recorded evidence. |
| **SOURCE-ONLY** | Verified by code inspection; no runtime test yet. |
| **UNVERIFIED** | Requires staging/production/DBA/owner evidence. |

---

## 2. Baseline regression gate

### 2.1 Existing DB-free suite

The implementation phase must first re-run the existing DB-free suite using the same runner as Phase 2.3. The acceptance baseline is:

- 1370 tests, 245 suites, 0 failures, 0 skipped.
- No test opens a MongoDB connection.
- No `.env`/`.env.local` value is read.
- No test writes to the repository.

A regression in the existing suite blocks all new work. New tests are additive; they do not replace or weaken the baseline.

### 2.2 Existing disposable replica-set suite

The existing Phase 2.3 integration suite remains the transaction baseline:

- 16/16 pass on the disposable single-node replica set.
- Standalone target returns `503 TRANSACTIONS_UNAVAILABLE`.
- Unknown commit does not duplicate.
- Reservation/consumption/release/void identity is preserved.

Phase 2.5 adds new integration files; it does not modify the Phase 2.3 evidence. If the Phase 2.3 suite cannot be rerun, the implementation is blocked.

---

## 3. New DB-free test files

All files live under `tests/` and use `node:test` + `node:assert/strict`, matching the existing style.

| File | Work package | What it locks |
|---|---|---|
| `tests/phase25-payment-immutability.test.mjs` | WP-01 | `payOrder` method/account guards key on `paidAt`; `updatePayment` atomic filter; no PAID timestamp stamping; conflict code; TELEBIRR normalization. |
| `tests/phase25-payment-reconciliation.test.mjs` | WP-03 | Pure payment checks; no write calls; stable finding codes. |
| `tests/phase25-recovery-reconciliation.test.mjs` | WP-04 | R1–R8 classification; `NO_INVENTORY`/released/partial boundaries; no write calls. |
| `tests/phase25-recovery-schema.test.mjs` | WP-05 | Fields/enums; unique `taskId`; unique partial open task; no TTL; no V2 name; no `orderVersion`/`inventoryMode`. |
| `tests/phase25-recovery-lifecycle.test.mjs` | WP-06 | Task identity; state guards; lease acquisition/renewal/expiry; backoff; unknown-commit rule; manual classes; worker cannot approve; no direct stock writes. |
| `tests/phase25-audit.test.mjs` | WP-07 | Append-only exports; required fields; redaction; approver/verifier distinctness. |
| `tests/phase25-destructive-admin.test.mjs` | WP-08/WP-09 | Production hard-deny; dry-run; PAID/ARCHIVED/CONSUMING/open-task refusals; distinct approver; audit intent/result; script absent/no unconditional delete. |
| `tests/phase25-payment-accounts.test.mjs` | WP-10 | Referenced archive; unused step-up; fail-closed reference check; snapshot untouched; audit. |
| `tests/phase25-index-coverage.test.mjs` | WP-11 | Exact V1 index definitions; `PaymentInfo` index; script coverage; no `syncIndexes`; production auto-index off. |
| `tests/phase25-stockmovement-index.test.mjs` | WP-12 | Old/new key detection; exact options; duplicate preflight; second drop token; no `syncIndexes`/`dropIndexes`. |
| `tests/phase25-db-readiness.test.mjs` | WP-13 | Read-only command list; no write methods; redaction; exit codes. |
| `tests/phase25-transaction-policy.test.mjs` | WP-14 | Explicit concerns/budget; retry bound; unknown commit not retried; no Hotel change; no `syncIndexes`. |
| `tests/phase25-payment-adjustments.test.mjs` | WP-02 | Field/enum/amount validation; idempotency; cumulative cap; permissions; no original-payment mutation. |
| `tests/phase25-gates.test.mjs` | Cross-cutting | Gate/stop-condition source contracts; no V2 activation; no `orderVersion`/`inventoryMode`; no production destructive enablement. |

### 3.1 Source-contract conventions

- Read files with `readFileSync` and slice between explicit function markers, as in `tests/phase23-order-integrity.test.mjs`.
- Strip comments only where necessary; do not hide a forbidden call inside a string.
- Assert exact guard expressions, not generic prose.
- Assert forbidden calls are absent (for example `syncIndexes`, `dropIndex`, `Order.deleteMany({})`, direct `$inc` on stock outside the existing consumption primitive).
- Keep every test DB-free. No `mongoose.connect`, no `createConnection`, no `.env` read.

### 3.2 Pure-rule fixtures

Where a rule can be extracted, test it as a pure function:

- payment identity decision (`same method`, `different method`, `legacy PAID`, `pre-PAID`);
- recovery class decision (`R1`…`R8`);
- backoff schedule;
- adjustment cap/duplicate decision;
- destructive gate decision (`production marker`, `ticket`, `second approver`, `backup ref`);
- index key/option matcher.

This keeps the most important logic testable without a database and makes the integration tests smaller.

---

## 4. Disposable replica-set integration plan

### 4.1 Harness

Reuse the Phase 2.3 pattern and add Phase 2.5-named helpers only if needed:

- `tests/helpers/pos-phase25-loader.mjs` — `@/` alias and extension resolution.
- `tests/helpers/pos-phase25-register.mjs` — loader registration.

The harness must enforce:

- `mongodb://` only, no credentials.
- Loopback host only (`127.0.0.1`, `::1`, `localhost`).
- Isolated port (proposed `27019`, same disposable test instance).
- Database name prefix `bono_pos_phase25_`.
- Explicit acknowledgement: `POS_PHASE25_TEST_TARGET_ACK="I_CONFIRM_DISPOSABLE_POS_REPLICA_SET"`.
- Opt-in: `POS_PHASE25_INTEGRATION_TESTS="1"`.
- Refusal of `MONGODB_URI`/`MONGO_URI`/`ROOM_MONGODB_URI`.
- Drop only the verified phase-specific database created by the run.
- No `.env`/`.env.local` read.

### 4.2 Proposed command (not executed in this phase)

```powershell
$env:POS_PHASE25_INTEGRATION_TESTS="1"
$env:POS_PHASE25_TEST_TARGET_ACK="I_CONFIRM_DISPOSABLE_POS_REPLICA_SET"
$env:POS_PHASE25_TEST_MONGODB_URI="mongodb://127.0.0.1:27019/bono_pos_phase25_<unique>?directConnection=true"
node --import ./tests/helpers/pos-phase25-register.mjs --test tests/integration/phase25-*.integration.mjs
```

A standalone target is a separate opt-in (mirroring Phase 2.3) and must use a different isolated database prefix. It is used only to prove `503 TRANSACTIONS_UNAVAILABLE`.

### 4.3 New integration files

| File | Work package | Real proof |
|---|---|---|
| `tests/integration/phase25-payment-immutability.integration.mjs` | WP-01 | Concurrent pay/update races; one identity; one `paidAt`; no second payment; snapshot preservation. |
| `tests/integration/phase25-payment-reconciliation.integration.mjs` | WP-03 | Read-only report over seeded clean/divergent data; DB unchanged. |
| `tests/integration/phase25-recovery-reconciliation.integration.mjs` | WP-04 | R1–R8 classification over seeded data; DB unchanged. |
| `tests/integration/phase25-recovery-worker.integration.mjs` | WP-06 | Lease race; expiry/reclaim; crash after commit; unknown commit; R2 idempotent; R4 no stock change; manual classes. |
| `tests/integration/phase25-audit.integration.mjs` | WP-07 | Append-only insert; unique event id; query paths; no update/delete. |
| `tests/integration/phase25-destructive-admin.integration.mjs` | WP-08 | Seed each refusal state; zero writes on refusal; dry-run; exact delete filters; audit. |
| `tests/integration/phase25-payment-accounts.integration.mjs` | WP-10 | Referenced archive; unused step-up delete; concurrent reference; audit. |
| `tests/integration/phase25-index-coverage.integration.mjs` | WP-11 | Create all indexes; verify exact keys/options; duplicate rejection; query plans. |
| `tests/integration/phase25-stockmovement-index.integration.mjs` | WP-12 | Old index rejects multi-item; replacement; multi-item succeeds; duplicate new key rejected; idempotency key rejected. |
| `tests/integration/phase25-db-readiness.integration.mjs` | WP-13 | Topology/index/duplicate output; no writes. |
| `tests/integration/phase25-transaction-policy.integration.mjs` | WP-14 | Commit/abort; transient retry once; unknown commit no duplicate; standalone 503; bounded timeout. |
| `tests/integration/phase25-payment-adjustments.integration.mjs` | WP-02 | Unique idempotency; cap; duplicate provider event; audit; original untouched. |

### 4.4 Integration test data

- Use unique order numbers and ObjectIds per run; never reuse production-like IDs.
- Seed only the collections needed for the test.
- Clean up by dropping the verified disposable database, never by deleting individual production-like documents.
- For R2/R4, create real reservations/stock movements through the existing service primitives, not by direct writes, so the test proves the production path.
- For index replacement, create a disposable collection named for the test and apply the script's exact logic; do not run the production script against the application database.

---

## 5. Work-package acceptance criteria

### WP-01 — Payment identity freeze

**Automated**
- DB-free source-contract tests pass.
- Disposable concurrency tests pass.

**Manual**
- Staging cash, transfer, and transfer-with-account payments.
- Same-method and different-method retries produce the expected `200`/`409` contract.
- Stored order shows one identity; `paidAt` unchanged on retry.
- No UI file changed; no account number/PIN in logs.

**Acceptance:** G-PAY-1 signed. A different-method retry cannot change the identity; a `PAID` `updatePayment` cannot mutate the method or timestamps.

### WP-02 — Payment adjustment ledger

**Automated**
- Finance-approved field/amount/cap/idempotency tests.
- Disposable unique-index and duplicate-provider tests.

**Manual**
- Finance reviews a sample of records and the reconciliation report.
- No UI/provider/Hotel path.

**Acceptance:** G-PAY-2 signed, or the owner formally declares refunds/chargebacks out of scope and publishes a manual procedure. The original payment is never edited.

### WP-03 — Payment reconciliation

**Automated**
- Fixture tests for every finding code.
- Read-only integration proof; DB unchanged.

**Manual**
- Finance samples exceptions on staging.

**Acceptance:** G-PAY-3 signed; report is read-only and stable.

### WP-04 — Inventory reconciliation

**Automated**
- R1–R8 classification tests; read-only integration proof.

**Manual**
- Staging run with representative volume; sample matches manual queries.

**Acceptance:** G-REC-1 signed; no write path exists.

### WP-05 — Recovery schema

**Automated**
- Exact fields/indexes; unique open-task proof; no TTL/V2 fields.

**Manual**
- `getIndexes()` before/after; owner signs fields/retention.

**Acceptance:** G-REC-2 signed; one open task per order is enforced.

### WP-06 — Recovery lifecycle/worker

**Automated**
- Lease race/expiry; backoff; unknown commit; R2/R4 only; audit; no blind stock write.

**Manual**
- Staging `--once` run; kill switch; no public route.

**Acceptance:** G-REC-3 signed; worker cannot approve or execute manual classes; no duplicate effect after crash.

### WP-07 — Audit foundation

**Automated**
- Append-only; required fields; redaction; distinct approver/verifier.

**Manual**
- Owner/finance sample; retention decision.

**Acceptance:** G-AUD-1 signed; destructive actions abort if audit fails.

### WP-08 — Destructive-admin gate

**Automated**
- Production hard-deny; non-prod refusals; dry-run; audit; distinct approver.

**Manual**
- Staging only; confirm production returns `403`.

**Acceptance:** G-DEST-1 signed; no production reset is possible in Phase 2.5.

### WP-09 — Script retirement

**Automated**
- File absent or permanent stub; no `Order.deleteMany({})`; no `activeWaiters` side effect.

**Manual**
- Repository search; retirement notice.

**Acceptance:** G-DEST-2 signed; no executable repository path deletes all orders.

### WP-10 — Payment-account archive

**Automated**
- Referenced archive; unused step-up; fail-closed reference check; audit.

**Manual**
- Manager flow; snapshot preservation.

**Acceptance:** G-PAY-4 signed; referenced accounts are never hard-deleted.

### WP-11 — V1 index coverage

**Automated**
- Exact index table; script coverage; no `syncIndexes`.

**Manual**
- Staging additive deploy; before/after `getIndexes()`; duplicate preflight.

**Acceptance:** G-IDX-1 signed; every required V1 index is deployed or explicitly reported as absent.

### WP-12 — Obsolete index replacement

**Automated**
- Detection/dry-run/duplicate/second-token tests.
- Disposable create-then-drop proof; multi-item sale succeeds after replacement.

**Manual**
- DBA/developer before/after; staging multi-item payment.

**Acceptance:** G-IDX-2 signed; the old index is removed only after the new one is verified.

### WP-13 — DB readiness tooling

**Automated**
- Read-only command list; no writes; redaction.

**Manual**
- Staging evidence; production read-only only with approval.

**Acceptance:** G-DB-1 signed; topology/concerns/index inventory is reproducible.

### WP-14 — Transaction concerns/budget/pool

**Automated**
- Explicit options; retry bound; unknown commit; standalone 503.

**Manual**
- Staging failover/pool proof (WP-16); DBA sign-off.

**Acceptance:** G-DB-2 signed; no unknown commit is retried; no transaction outlives the approved budget.

### WP-15 — Backup/restore/RPO/RTO

**Automated**
- Restore verification via WP-13; reconciliation via WP-03/WP-04.

**Manual**
- Isolated restore drill; counters/indexes/evidence; actual RPO/RTO; independent verifier.

**Acceptance:** G-DB-3 signed; restore within signed RPO/RTO.

### WP-16 — Failover/pool/alerting

**Automated**
- No production test; staging evidence.

**Manual**
- Step-down, partition, rolling restart, pool saturation, alert routing.

**Acceptance:** G-DB-4 signed; no duplicate after failover; alerts reach a named on-call.

### WP-17 — RACI

**Automated**
- Audit distinctness tests; no invented role.

**Manual**
- Named approver/executor/verifier and backups.

**Acceptance:** G-GOV-1 signed.

### WP-18 — Deferred reset

**Acceptance:** Not accepted in Phase 2.5. Production remains disabled.

---

## 6. Specific test cases

### 6.1 Payment identity

| # | Scenario | Expected |
|---|---|---|
| P-01 | First cash `payOrder` | `PAID`, `CASH`, `paidAt` set, no account |
| P-02 | Retry same cash method | Same identity, one `paidAt`, no second effect |
| P-03 | Retry different method (`TRANSFER`) | Original method preserved; no account/snapshot change |
| P-04 | First transfer with active account | Snapshot persisted |
| P-05 | Retry transfer with a different account | Original account/snapshot preserved |
| P-06 | Concurrent cash vs transfer `payOrder` | One identity wins; no torn fields |
| P-07 | `updatePayment` on `PAID`, different method | `409 PAYMENT_METHOD_IMMUTABLE`, no change |
| P-08 | `updatePayment` on `PAID`, same method | `200`, no timestamp change |
| P-09 | `updatePayment` on `SERVED` | Atomic pre-PAID change; concurrent pay cannot tear |
| P-10 | Legacy `PAID`, `paidAt` null, `updatePayment` | Frozen/conflict; no invented backfill |
| P-11 | `confirmPayment` | Preserves submitted method/snapshot |
| P-12 | `submitPaymentForVerification` on `PAID` | Rejected; no mutation |
| P-13 | `rejectPayment` | Returns to `SERVED`; identity preserved |
| P-14 | Failed DB/topology | Clean error; no identity change |

### 6.2 Recovery

| # | Scenario | Expected |
|---|---|---|
| R-01 | Two workers acquire one task | One lease winner |
| R-02 | Lease expires | Exactly one reclaim; evidence re-read |
| R-03 | Crash after committed deduction | No duplicate; `ALREADY_CORRECT` |
| R-04 | Unknown commit with effect present | Resolve, no retry |
| R-05 | Unknown commit with effect absent | Same identity retry within budget |
| R-06 | R2 live reservation | Idempotent consumption; one movement per item |
| R-07 | R4 movement exists, no live hold | Finalize `CONSUMED`; no stock change |
| R-08 | R4 movement exists, live hold remains | Escalate (R7), no stock change |
| R-09 | R3 stale `CONSUMING`, conclusive movement | Finalize or manual per rule |
| R-10 | R3 stale `CONSUMING`, ambiguous | `MANUAL_REQUIRED`; no write |
| R-11 | R5 duplicate movements | Manual; rows preserved |
| R-12 | R6 consumed without movement | Manual; no re-decrement |
| R-13 | R7 hold drift | Manual; conditional correction only |
| R-14 | R8 negative stock | Manual; no clamp |
| R-15 | Retry budget exhausted | `MANUAL_REQUIRED`; no endless loop |
| R-16 | Worker tries to approve | Rejected |
| R-17 | Audit write fails | Action not applied |

### 6.3 Destructive administration

| # | Scenario | Expected |
|---|---|---|
| D-01 | Production marker | `403 DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION` |
| D-02 | Non-prod dry-run | Preview; zero writes |
| D-03 | PAID order present | Refuse before delete |
| D-04 | ARCHIVED order present | Refuse before delete |
| D-05 | CONSUMING reservation | Refuse before hold reset |
| D-06 | Open recovery task | Refuse |
| D-07 | V2 hold exists (if collection) | Refuse |
| D-08 | Missing token | `400` |
| D-09 | Wrong PIN | `401` |
| D-10 | Second approver same as executor | Refuse |
| D-11 | Missing backup/export ref | Refuse (future production) |
| D-12 | Deletable state | Exact filters; PAID/ARCHIVED/CONSUMED/CONSUMING preserved |
| D-13 | StockMovement/InventoryAudit | Untouched |
| D-14 | Counter | Reset only when orders empty |
| D-15 | Audit | Intent and result recorded; no secrets |
| D-16 | `clean-order-history.js` | Absent or permanent stub; no unconditional delete |

### 6.4 Indexes

| # | Scenario | Expected |
|---|---|---|
| I-01 | `InventoryReservation.orderId` duplicate | Rejected |
| I-02 | `StockMovement` duplicate `(order, reason, item)` | Rejected |
| I-03 | `StockMovement` duplicate `idempotencyKey` | Rejected |
| I-04 | `PaymentInfo` list query | Uses `{ createdAt: -1 }` |
| I-05 | Old `(refOrderId, reason)` exists | Detected, not auto-dropped |
| I-06 | New index missing | Created additively |
| I-07 | Duplicate preflight non-empty | Replacement stops; no drop |
| I-08 | Old index drop | Only after new verified; exact name/keys |
| I-09 | Multi-item sale after replacement | Succeeds |
| I-10 | `syncIndexes()` | Absent from connection path and scripts |

### 6.5 Database operations

| # | Scenario | Expected |
|---|---|---|
| DB-01 | Standalone target | `503 TRANSACTIONS_UNAVAILABLE` |
| DB-02 | Replica set/mongos | Transactions commit/abort |
| DB-03 | Transient error | Bounded retry; one commit |
| DB-04 | Unknown commit | No blind retry; evidence |
| DB-05 | Write concern | Explicit majority (approved value) |
| DB-06 | Read preference | Primary for financial/inventory |
| DB-07 | Pool saturation | Clean 503/429 before gateway deadline |
| DB-08 | Failover | No duplicate; no lost acknowledged write |
| DB-09 | Restore | Counters/indexes/evidence intact; reconciliation clean |
| DB-10 | Alerts | `TRANSACTIONS_UNAVAILABLE`, retry, unknown commit, backup, index drift routed |

---

## 7. Manual and staging verification

### 7.1 Staging prerequisites

- Replica set or mongos with the approved topology.
- Disposable POS database; never production.
- A second Manager account for dual-control testing (or an approved ticket fallback).
- A disposable payment account and a referenced payment account.
- A seeded paid order, a live reservation, a consumed reservation, a duplicate movement fixture, and a negative-stock fixture (all disposable).
- A backup target and an isolated restore target.

### 7.2 Manual checklist

| # | Check | Evidence |
|---|---|---|
| M-01 | Cash/transfer/account payment and retries | API response + stored order + log |
| M-02 | Payment method conflict | `409` code + unchanged order |
| M-03 | Read-only inventory reconciliation | Report + sample queries |
| M-04 | Read-only payment reconciliation | Report + finance sample |
| M-05 | Recovery worker `--once` on R2 | Task result + movement count |
| M-06 | Recovery worker on R4 | Status finalized; stock unchanged |
| M-07 | Recovery worker on R5–R8 | `MANUAL_REQUIRED`; no write |
| M-08 | Lease contention | One winner + audit |
| M-09 | Destructive production gate | `403`; no write |
| M-10 | Non-prod dry-run | Zero writes |
| M-11 | Non-prod refusal states | Zero writes |
| M-12 | Payment account archive | `isActive:false`; snapshot intact |
| M-13 | Unused account step-up | PIN required; audit |
| M-14 | Additive index deploy | Before/after `getIndexes()` |
| M-15 | Old index replacement | Multi-item sale succeeds |
| M-16 | Topology/concern evidence | Redacted output |
| M-17 | Failover drill | No duplicate; pool recovers |
| M-18 | Restore drill | RPO/RTO + reconciliation |
| M-19 | Alert routing | Named on-call acknowledges |
| M-20 | No V2/Hotel/UI change | Diff review |

### 7.3 Production read-only checks (only with owner/DBA approval)

- `hello` / `rs.status()` summary.
- `getDefaultRWConcern`.
- `getIndexes()` for the collections in the blueprint.
- Duplicate preflight aggregations.
- Counts for reconciliation; no document content export without approval.

No production write, failover, restore, index drop, or destructive operation is part of Phase 2.5 testing.

---

## 8. Acceptance and release criteria

A work package is accepted only when all of the following are true:

1. The DB-free suite passes with the Phase 2.3 baseline intact.
2. The targeted new DB-free tests pass.
3. The targeted disposable replica-set tests pass (where applicable).
4. The manual/staging checklist is complete (where applicable).
5. The work package's gate is signed by the approver named in the RACI.
6. No forbidden change is present: V2 activation, `orderVersion`, `inventoryMode`, Hotel change, POS UI change, secret read, production access, migration, `syncIndexes`, or unapproved index drop.
7. The evidence package is stored and independently reviewed.

### 8.1 Release gate summary

| Gate | Evidence required | Blocks |
|---|---|---|
| G-PAY-1 | WP-01 unit + real concurrency + staging | Payment release |
| G-PAY-2 | Finance sign-off or explicit out-of-scope policy | Refund/chargeback enablement |
| G-PAY-3 | WP-03 report + finance sample | Financial operations |
| G-PAY-4 | WP-10 unit + real + audit | Account deletion |
| G-REC-1 | WP-04 report + staging sample | Recovery operations |
| G-REC-2 | WP-05 schema/index + owner sign-off | Worker code |
| G-REC-3 | WP-06 real lease/retry/audit | Automated recovery |
| G-AUD-1 | WP-07 append-only/redaction | Destructive/recovery |
| G-DEST-1 | WP-08 production hard-deny | Any production reset |
| G-DEST-2 | WP-09 retirement | Repository safety |
| G-IDX-1 | WP-11 deploy + dump | Inventory idempotency |
| G-IDX-2 | WP-12 replacement + multi-item proof | Multi-item correctness |
| G-DB-1 | WP-13 topology/index evidence | DB release |
| G-DB-2 | WP-14 concerns/budget + staging | Transaction release |
| G-DB-3 | WP-15 restore within RPO/RTO | Production release |
| G-DB-4 | WP-16 failover/pool/alert | Production release |
| G-GOV-1 | WP-17 signed RACI | Recovery/destructive operations |

---

## 9. Stop conditions

Stop and return to the owner if:

- the existing DB-free or Phase 2.3 integration baseline cannot be reproduced;
- a test requires a production database, secret, or destructive operation;
- a unique index build finds duplicates that require data deletion (R5) without an approved manual review;
- a recovery action would write stock/payment outside the existing conditional primitive;
- finance has not approved the adjustment accounting boundary;
- the RACI has no named approver or verifier;
- a proposed change would activate V2, add `orderVersion`/`inventoryMode`, change Hotel, or alter POS UI;
- a C2/C3/C4/C5 change is bundled with a C1 deploy.

**This plan is a proposal. No test was run, no database was contacted, and no production resource was accessed in Phase 2.5 planning.**
