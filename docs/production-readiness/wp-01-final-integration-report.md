# WP-01 Final Code Review + Disposable Integration Report

**Status:** **LOCAL VERIFICATION COMPLETE — G-PAY-1 REMAINS BLOCKED pending owner staging acceptance.**
**Date:** 2026-11-08
**Repository:** `C:\hotelms`
**Branch / HEAD:** `main` / `69650435a6587d4577bc126f719fa1392bb934b3`
**Reported baseline:** `69650435a6587d4577bc126f719fa1392bb934b3`
**Scope:** WP-01 payment identity immutability only. No staging, production, Hotel, Inventory, Inventory V2, UI, or other work package was started.

---

## 1. Safety statement

- No production, staging, Hotel, or existing application database was contacted.
- No `.env` or `.env.local` was read. No application credentials were used.
- The only databases touched were three freshly created, loopback-only, disposable databases on a dedicated local MongoDB replica set:
  - `bono_pos_phase25_4ec568e17f35` (integration suite)
  - `bono_pos_phase25_api_79a71a1ac077` (first API run; dropped)
  - `bono_pos_phase25_api_61f4283c559b` (final API run; dropped)
- No migration, seed, index deployment, or schema synchronization was run. `POS_AUTO_INDEXES=0` was set for the API harness so the application connection provisioned no indexes. The integration suite's own `createIndexes()` calls are test-local to its disposable database.
- No `git reset`, `git clean`, `git checkout`, `git stash`, stage, commit, push, deploy, or user-file deletion was performed.
- The existing MongoDB listeners on `127.0.0.1:27017` (PID 4608) and `127.0.0.1:27018` (PID 4396) were never used or stopped.

---

## 2. Baseline and working tree

### 2.1 Baseline

```
main
69650435a6587d4577bc126f719fa1392bb934b3
6965043 Complete Bono UI and reporting updates
```

The HEAD matches the baseline stated in the task and in `wp-01-follow-up-remediation-report.md`.

### 2.2 Working-tree status

`git status --short --untracked-files=all` contained **286 pre-existing entries** before this report was created and contains **287 entries** now. The tree was already substantially dirty before this task and remains so. This task added exactly one file: this report.

The WP-01-relevant entries are:

| Path | State | Attribution |
|---|---|---|
| `lib/validate.js` | `M` | WP-01 follow-up (method-only TRANSFER exception) alongside pre-existing `HOT_DRINK` validation work |
| `lib/orderService.js` | `M` | WP-01 follow-up inside a large pre-existing lifecycle/inventory change set |
| `app/api/orders/[id]/route.js` | `M` | WP-01 follow-up (PAID retry dispatch) inside pre-existing inventory/error-mapping work |
| `app/api/orders/[id]/status/route.js` | `M` | WP-01 follow-up (PAID retry dispatch) |
| `lib/operationalLogger.js` | `??` (new) | Phase 2.2 logger; WP-01 R-7 redaction terms live here |
| `tests/wp01-payment-remediation.test.mjs` | `??` (new) | WP-01 focused remediation suite |
| `docs/production-readiness/wp-01-follow-up-remediation-report.md` | `??` (new) | Prior WP-01 follow-up report |
| `docs/production-readiness/wp-01-final-integration-report.md` | `??` (new) | This report |

No repository file was written by this task other than this report. The pre-existing unrelated UI, Hotel, Inventory, Inventory V2, Jebena, Kitchen, Waiter, and Barista changes listed by `git status` were left untouched.

### 2.3 Step A review scope

The exact WP-01 hunks in `lib/validate.js`, `lib/orderService.js`, `app/api/orders/[id]/route.js`, and `app/api/orders/[id]/status/route.js` were reviewed against the prior follow-up report, and the full (untracked) contents of `lib/operationalLogger.js` and `tests/wp01-payment-remediation.test.mjs` were reviewed. The WP-01 hunks match the behavior described in the prior report. Surrounding hunks in the same files are pre-existing unrelated work and were not modified.

---

## 3. Code-review findings

### 3.1 Authentication, ownership, authorization

- Both PATCH routes call `requireAuth(request)` before any order lookup or mutation. `requireAuth` resolves only the opaque `__Host-bono_session` cookie (or tab credential) through `Session` → live `Staff` (`isActive`, live `role`). `roleSnapshot` is never authoritative.
- PAID requests require `orders:payment:confirm` (`CASHIER`, `MANAGER`). `PAYMENT_PENDING` submission requires `orders:payment:submit` and the WAITER ownership check.
- Method-only payment updates remain gated by the existing `orders:payment` policy (`WAITER`, `MANAGER`). This task did not widen it.
- The harness proved an unauthenticated PATCH returns `401`, a CASHIER method-only different-method retry returns `403` (policy unchanged), and a real CASHIER cookie can confirm a `PAYMENT_PENDING` order.

### 3.2 Payment state transitions and identity freeze

- Canonical path: `SERVED` → `PAYMENT_PENDING` (`submitPaymentForVerification`) → `PAID` (`confirmPayment`).
- Legacy direct settlement: `MANAGER` may move `SERVED` → `PAID` through `payOrder`.
- PAID retry: both routes dispatch an existing `PAID` order to `payOrder`.
- `paidAt` is the sole lock marker. `isFirstPayment` is `paidAt == null && status != "PAID"`, so a legacy `PAID` order with `paidAt: null` is still frozen and is never backfilled.
- The first identity (`paymentMethod`, `paymentAccountId`, `paymentAccountSnapshot`) is written only while `isFirstPayment` is true; every retry preserves the stored values through the atomic `$cond` pipeline.
- `updatePayment` returns `409 PAYMENT_METHOD_IMMUTABLE` for a different method on a frozen order, and a `200` no-write for the same method.

### 3.3 Account validation

- A genuinely new/unpaid TRANSFER requires a syntactically valid, existing, active `PaymentInfo` account and snapshots `bankName`, `ownerName`, `accountNumber`.
- A frozen TRANSFER retry reads `status`/`paidAt` first and skips the account lookup entirely, so the original account may be inactive or deleted.
- CASH still rejects `paymentAccountId`.
- The method-only `{ paymentMethod: "TRANSFER" }` exception applies only when the request has no `status` or `action`; status-bearing TRANSFER submissions still require an account.

### 3.4 Atomicity and concurrency

- `payOrder` performs one `findOneAndUpdate` pipeline write with the freeze condition evaluated in the database at write time, so a concurrent first writer cannot be overwritten by a stale second writer.
- `updatePayment` re-checks `paidAt: null` and `status != "PAID"` in its write filter and re-reads on a miss.
- The concurrent API test fired two different TRANSFER accounts at the same order simultaneously; both returned `200` and the final stored identity was internally consistent (one account ID with the matching snapshot).

### 3.5 Logging

- `lib/operationalLogger.js` normalizes keys by removing non-alphanumerics and matching `accountnumber`, `accountno`, `acctno`, and `iban` case-insensitively, recursively through nested objects and arrays (depth limit 5).
- Payment events log only order ID, actor ID, requested/stored method names, and result. No account number, PIN, cookie, token, or connection string is logged by the reviewed call sites.
- Redaction is key-based. Account numbers embedded in arbitrary free text are not pattern-detected; no reviewed payment call site logs such text.

### 3.6 Unresolved concerns and observations

| ID | Observation | Impact on WP-01 |
|---|---|---|
| C1 | CASHIER receives `403` on the method-only different-method retry, not `409`, because `orders:payment` is `WAITER`/`MANAGER`. This is the previously documented authorization decision and was not widened. | None. CASHIER’s PAID-status retry still preserves identity; the `409` contract is reachable by MANAGER. |
| C2 | `{ status: "PAID", paymentMethod: "TRANSFER" }` with no account still returns `400`. A retry must send `{ status: "PAID" }` or any syntactically valid account ID. | None. This preserves the existing validation contract. |
| C3 | A different-method retry through the `status: "PAID"` path returns `200` and preserves the original identity; only method-only `updatePayment` returns `409`. | None. This is the documented blueprint §4.1.1 `payOrder` semantics. |
| C4 | A new unpaid TRANSFER with an **inactive** account is rejected without mutation but maps to a generic `500` (`Payment account is disabled` does not match the route’s 4xx message regex). The same mapping exists at baseline `6965043`; it is not a WP-01 regression. | No identity/accounting mutation. Reported as a pre-existing error-mapping gap for a future non-WP-01 follow-up. |
| C5 | A new unpaid TRANSFER with a nonexistent account maps to `404` (`Payment account not found`) because of the existing `not found` rule. No mutation. | None. Pre-existing mapping. |
| C6 | Logger redaction is key-based only. | None. Reviewed payment call sites do not log free-text account numbers. |
| C7 | Narrow pre-read race remains for an unpaid TRANSFER frozen between the freeze check and account lookup. The atomic write is still authoritative and cannot produce a torn identity. | None. Previously documented; no schema change. |
| C8 | No staging environment exists, so staging acceptance is still impossible. | G-PAY-1 remains blocked. |

---

## 4. Disposable replica-set integration

### 4.1 Provisioning evidence

| Item | Value |
|---|---|
| `mongod` | `C:\Program Files\MongoDB\Server\8.0\bin\mongod.exe` (MongoDB 8.0) |
| Dedicated port | `27019` (confirmed unused before start) |
| Bind address | `127.0.0.1` |
| Replica set | `bonopos25rs`, single node `127.0.0.1:27019`, confirmed `isWritablePrimary: true` |
| Oplog size | `128` MB |
| Unique dbpath | `C:\Users\besud\AppData\Local\Temp\opencode\wp01-rs-018cc8723497\db` |
| Process | PID `14048` (the only process started for this run) |
| Existing 27017/27018 | Never connected to; remained owned by PID 4608 / 4396 throughout |

The replica set was initiated with a temporary Node script outside the repository using the repository’s own `mongoose` dependency. No `mongosh`/`mongo` binary is installed.

### 4.2 Existing WP-01 opt-in integration suite

Command (PowerShell, from `C:\hotelms`):

```powershell
$db = "bono_pos_phase25_4ec568e17f35"
$uri = "mongodb://127.0.0.1:27019/${db}?directConnection=true&replicaSet=bonopos25rs"
$env:POS_PHASE25_INTEGRATION_TESTS = "1"
$env:POS_PHASE25_TEST_TARGET_ACK = "I_CONFIRM_DISPOSABLE_POS_REPLICA_SET"
$env:POS_PHASE25_TEST_MONGODB_URI = $uri
$env:POS_PHASE25_KEEP_DB = "0"
node --import ./tests/helpers/pos-phase25-register.mjs --test tests/integration/phase25-payment-immutability.integration.mjs
```

Result: **16 tests / 1 suite, 16 pass, 0 fail.**

The suite exercised initial CASH/TRANSFER writes, same/different-method retries, legacy `PAID` with `paidAt: null`, concurrency, `updatePayment` `409`, and confirm/submit/reject semantics. It dropped only its verified `bono_pos_phase25_*` database.

An earlier invocation failed before connecting because PowerShell interpolated `$db?` incorrectly; the URI guard rejected it and no database was created. The rerun with `${db}` passed.

### 4.3 Public-API harness

The integration suite calls the service layer. To satisfy the requirement to verify the **actual public API**, a temporary harness outside the repository imported the real route modules and called their PATCH handlers with real `Request` objects and real server sessions.

Harness properties:

- Target guard refused to connect unless host was exactly `127.0.0.1`, port exactly `27019`, and database name started with `bono_pos_phase25_`.
- `MONGODB_URI` was set only for the harness process; `POS_AUTO_INDEXES=0`.
- Fixtures used real `Staff` rows (`CASHIER`, `MANAGER`, `WAITER`), real `Session` rows, and the opaque `__Host-bono_session=<base64url>` cookie. No auth check was bypassed or mocked.
- `PaymentInfo` accounts were disposable test records; no external account was used.
- Both public routes were exercised: `app/api/orders/[id]/route.js` and `app/api/orders/[id]/status/route.js`.
- Cleanup verified the connected database name immediately before `dropDatabase()`.

Final API run: **27 checks / 27 pass** against `bono_pos_phase25_api_61f4283c559b`. The first API run used `bono_pos_phase25_api_79a71a1ac077`; two assertions expected a generic `400` for inactive/nonexistent accounts. After confirming the baseline route mapping is identical (`inactive` → generic `500`, `not found` → `404`), those assertions were corrected to “rejected without mutation” and the run was repeated against a fresh database. No application code was changed.

### 4.4 Cleanup evidence

| Check | Result |
|---|---|
| Phase-2.5 databases remaining after runs | `PHASE25_DATABASES []`; only `admin`, `config`, `local` remained |
| Integration DB (`bono_pos_phase25_4ec568e17f35`) | Dropped by the suite (`KEEP_DB=0`) |
| API DB run 1 (`bono_pos_phase25_api_79a71a1ac077`) | Dropped by harness |
| API DB run 2 (`bono_pos_phase25_api_61f4283c559b`) | Dropped by harness |
| PID 14048 command line | Verified to contain `wp01-rs-018cc8723497` before stopping |
| PID 14048 stopped | `processAlive=False` |
| Port 27019 | No listener |
| Temp dbpath/log/state/harness files | Removed |
| Ports 27017/27018 | Still listening under the original PIDs, untouched |

---

## 5. Required API-level case results

All calls used the real PATCH handlers with real cookie sessions and `orders:payment:*` authorization.

| # | Required case | Endpoint / request | Result |
|---|---|---|---|
| 1 | Initial CASH succeeds | `PATCH /api/orders/[id]` MANAGER `{status:"PAID",paymentMethod:"CASH"}` | `200 PAID`, method `CASH`, no account, `paidAt` set |
| 2 | Initial TRANSFER with valid active account | same, `{status:"PAID",paymentMethod:"TRANSFER",paymentAccountId:<A>}` | `200 PAID`, account A, snapshot matches A |
| 3 | PAID CASH retry, same method | same, `{status:"PAID",paymentMethod:"CASH"}` | `200`, identity and `paidAt` unchanged |
| 4 | PAID CASH retry, different method | same, method-only `{paymentMethod:"TRANSFER"}` | `409 PAYMENT_METHOD_IMMUTABLE` |
| 4b | PAID CASH retry, different method via status | same, `{status:"PAID",paymentMethod:"TRANSFER",paymentAccountId:<A>}` | `200`, stored CASH identity preserved (documented `payOrder` semantics) |
| 4c | CASHIER method-only retry | same, method-only TRANSFER as CASHIER | `403`; authorization not widened |
| 5 | PAID TRANSFER retry, same method | same, `{status:"PAID",paymentMethod:"TRANSFER",paymentAccountId:<A>}` | `200`, account ID and snapshot unchanged |
| 5b | Status route parity | `PATCH /api/orders/[id]/status` same body | `200`, same frozen identity |
| 6 | Original account now inactive | deactivate A, retry with A | `200`, identity and snapshot unchanged |
| 6b | Original account deleted | delete A, retry with A | `200`, identity and snapshot unchanged |
| 7 | Retry needs no replacement account | retry with a random valid ObjectId, then `{status:"PAID"}` only | `200` both times, identity unchanged |
| 8a | New unpaid TRANSFER without account | `{status:"PAID",paymentMethod:"TRANSFER"}` | `400`, account required |
| 8b | New unpaid TRANSFER, inactive account | account B (`isActive:false`) | Rejected; HTTP `500` generic mapping (pre-existing); order stayed `SERVED`, method `NONE`, no `paidAt` |
| 8c | New unpaid TRANSFER, nonexistent account | random ObjectId | Rejected; `404 Payment account not found` (pre-existing mapping); no mutation |
| 8d | New unpaid TRANSFER, active account | account F | `200 PAID`, identity F and snapshot written |
| 9 | Different-method PAID TRANSFER retry | method-only `{paymentMethod:"CASH"}` as MANAGER | `409 PAYMENT_METHOD_IMMUTABLE` |
| 10a | Legacy PAID `paidAt:null`, same method | method-only `{paymentMethod:"TRANSFER"}` | `200` no-op; `paidAt` stayed `null`; identity unchanged |
| 10b | Legacy PAID `paidAt:null`, different method | method-only `{paymentMethod:"CASH"}` | `409 PAYMENT_METHOD_IMMUTABLE` |
| 10c | Legacy PAID `paidAt:null`, status retry | `{status:"PAID",paymentMethod:"TRANSFER",paymentAccountId:<random>}` | `200`; `paidAt` stayed `null`; no backfill |
| 11 | Concurrent identity updates | two simultaneous `{status:"PAID"}` TRANSFER calls with accounts C and D | both `200`; exactly one identity won; account ID and snapshot remained consistent |
| 12 | Snapshot immutability | six frozen retry snapshots compared | all equal to the original snapshot |
| 13a | Verification workflow | WAITER submits `PAYMENT_PENDING` TRANSFER C → CASHIER confirms `PAID` | `200` at each step; identity C and snapshot preserved; `paidAt` set |
| 13b | Rejection workflow | WAITER submits CASH → CASHIER action `REJECT_PAYMENT` with reason | `200`; status `SERVED`, method CASH retained for audit, rejection reason/time recorded, `paidAt` null |
| A0 | Authentication still enforced | no cookie | `401 Authentication required` |
| 14 | Account-number key variants redacted | direct structured `logEvent` probe with camel/snake/kebab/upper/nested/array keys | every variant `"[redacted]"`, ordinary fields visible |
| 15 | No secrets in captured logs | scan of all 43 captured API log lines | no seeded account number, PIN material, or secret string |

---

## 6. Logger redaction evidence

Probe fields and emitted result:

```json
{
  "accountNumber": "[redacted]",
  "accountNo": "[redacted]",
  "account_number": "[redacted]",
  "acctNo": "[redacted]",
  "iban": "[redacted]",
  "ACCOUNT_NUMBER": "[redacted]",
  "account-number": "[redacted]",
  "nested": { "accountNo": "[redacted]", "deeper": [{ "ACCT_NO": "[redacted]" }] },
  "safeField": "visible-value",
  "paymentAccountId": "<visible ObjectId>"
}
```

The conflict events emitted during the API run contained only `orderId`, `actorId`, `requestedMethod`, `storedMethod`, and `result`; no account number or snapshot value appeared. A scan of all captured lines found no seeded account numbers, PIN material, or secret strings.

---

## 7. Regression results

All commands were run from `C:\hotelms` with no database connection.

| Suite | Command | Result |
|---|---|---|
| WP-01 DB-free suites | `node --test tests/phase25-payment-immutability.test.mjs tests/wp01-payment-remediation.test.mjs` | **38 tests / 9 suites, 38 pass, 0 fail** |
| Existing payment verification/rejection/account/transfer suites | `node --test tests/payment-verification.test.mjs tests/payment-rejection-resubmit.test.mjs tests/payment-accounts.test.mjs tests/payment-transfer-generic.test.mjs tests/transfer-by-account-i18n.test.mjs` | **51 tests / 5 suites, 51 pass, 0 fail** |
| Focused WP-01/payment/order/auth/logger batch | 17 files listed in §7.1 | **233 tests / 32 suites, 233 pass, 0 fail** |
| Full DB-free suite | `node --test "tests/*.test.mjs"` | **1408 tests / 254 suites, 1408 pass, 0 fail, 0 skipped** |
| ESLint (WP-01 files) | `npx eslint lib/validate.js lib/orderService.js "app/api/orders/[id]/route.js" "app/api/orders/[id]/status/route.js" lib/operationalLogger.js tests/wp01-payment-remediation.test.mjs` | exit `0`, no findings |
| Syntax check | `node --check` on the same six files | all `OK` |

### 7.1 Focused batch files

`phase25-payment-immutability`, `wp01-payment-remediation`, `payment-verification`, `payment-rejection-resubmit`, `payment-accounts`, `payment-transfer-generic`, `transfer-by-account-i18n`, `phase23-order-integrity`, `item-level-cancellation`, `cashier-confirm-auth`, `cashier-role`, `cashier-access-audit`, `waiter-cancelled-order-card`, `waiter-cancelled-persistence`, `role-station-separation`, `station-session-policy`, `operational-logger`.

---

## 8. Test-tier distinction

| Tier | What it proves | What it does not prove |
|---|---|---|
| DB-free unit/contract tests | Source-level freeze rules, validator behavior, route dispatch shape, logger redaction | Real Mongo atomicity or real HTTP handler behavior |
| Disposable replica-set integration | Real Mongo writes, atomic `$cond` freeze, concurrency, service-level retry semantics | Public route/auth behavior; staging configuration |
| Disposable public-API harness | Real route handlers, real cookie sessions, real authorization, real DB writes and cleanup | Staging/production environment, network topology, operator UI |
| Staging acceptance | The owner-approved environment, real deployment configuration, manual operator flows | Production sign-off |

Local integration and the API harness do **not** constitute staging acceptance.

---

## 9. Remaining staging requirements

1. Owner provides an approved isolated staging environment (URL, credentials, isolated database) or explicitly approves a staging-equivalent disposable target.
2. Run the WP-01 manual acceptance cases from `phase-2-5-test-and-acceptance-plan.md` §5:
   - cash, transfer, and transfer-with-account payments;
   - same-method and different-method retries (`200`/`409` contract);
   - verify one stored identity and an unchanged `paidAt` on retry;
   - verify no account number or PIN appears in deployed logs;
   - verify no UI regression.
3. Confirm deployed auth/ownership/`orders:payment:confirm` configuration matches the reviewed code.
4. Re-run the full DB-free suite on the exact reviewed tree.
5. Owner reviews and signs the G-PAY-1 acceptance record.

---

## 10. G-PAY-1 status

**G-PAY-1 remains BLOCKED.**

The local evidence is now materially stronger than the prior follow-up: the opt-in replica-set suite passes 16/16, the public-API harness passes 27/27, the focused and full DB-free suites are green, and the disposable target was verified and cleaned up. That satisfies the local integration prerequisite.

It does **not** satisfy owner staging acceptance. G-PAY-1 is therefore **eligible to proceed to owner staging acceptance**, but it is **not signed and not production-ready** on the basis of this report.
