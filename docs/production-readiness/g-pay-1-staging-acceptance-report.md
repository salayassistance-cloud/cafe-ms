# G-PAY-1 Staging Acceptance Report — WP-01 Payment Identity Freeze

**Status:** **BLOCKED — STAGING PREREQUISITE MISSING. G-PAY-1 IS NOT PASSED.**
**Date:** 2026-11-08
**Repository:** `C:\hotelms`
**Baseline:** `main` at `6965043` plus uncommitted WP-01 working-tree changes. No commit was created during this acceptance run.
**Owner approval:** Pending. Do not treat this document as a G-PAY-1 sign-off.

---

## 1. Executive summary

WP-01 was reviewed at source level and its DB-free automated tests were re-run. All executed DB-free suites passed. However, the required staging-only manual acceptance could not be performed because:

1. No explicitly approved isolated staging environment exists for this repository.
2. No staging URL, staging credentials, or approved staging database target was provided.
3. The only running local MongoDB services are on `127.0.0.1:27017` and `127.0.0.1:27018`. They are not approved staging, were not connected to, and may contain non-disposable data.
4. The Phase 2.5 disposable replica-set target on `127.0.0.1:27019` was not running and no approved disposable target was provisioned for this run.

Per the acceptance instruction, I stopped rather than substituting production, the local application database, or an unapproved environment. **No manual acceptance case has been recorded as passed.**

**Automated evidence re-run in this acceptance:**

| Suite | Result |
|---|---|
| `tests/phase25-payment-immutability.test.mjs` (WP-01 DB-free) | **20 pass / 0 fail** |
| `tests/payment-rejection-resubmit.test.mjs` | **8 pass / 0 fail** |
| `tests/payment-verification.test.mjs` | **15 pass / 0 fail** |
| `tests/payment-transfer-generic.test.mjs` | **12 pass / 0 fail** |
| `tests/payment-accounts.test.mjs` | **14 pass / 0 fail** |
| `tests/operational-logger.test.mjs` | **10 pass / 0 fail** |
| `tests/phase23-order-integrity.test.mjs` | **15 pass / 0 fail** |
| **Total executed** | **94 pass / 0 fail** |

The disposable replica-set integration suite `tests/integration/phase25-payment-immutability.integration.mjs` was **not executed** in this acceptance run. It defines 16 tests, including the real concurrency cases, but requires an explicitly acknowledged disposable loopback replica set on port `27019`. No approved target was available.

---

## 2. Authorization boundary and production non-access attestation

**Production was not accessed.** The following is a factual record of this run:

| Boundary | Result |
|---|---|
| Production database connection opened | **No** |
| Production secrets read or printed | **No** |
| `.env.local` contents read | **No** |
| Real customer financial records accessed | **No** |
| Real financial transaction created | **No** |
| Application code or test file modified | **No** |
| Production deployment or migration performed | **No** |
| WP-04, WP-13, or WP-09 started | **No** |

Environment variable **names** containing `MONGO`, `MONGODB`, `ROOM_`, `STAG`, or `PHASE25` were checked to determine whether a staging target existed. No values were printed. `.env.example` was read only as a template; it contains placeholders, not live credentials. `.env.local` was not opened.

Local MongoDB services were observed as running, but no connection was made to either service:

- `127.0.0.1:27017` — local MongoDB service; not used.
- `127.0.0.1:27018` — Hotel test MongoDB service; not used.
- `127.0.0.1:27019` — Phase 2.5 disposable replica-set target; not listening; not used.

No application server was started, and no HTTP request was sent to an application database.

---

## 3. WP-01 diff reviewed

### 3.1 WP-01-scoped files

| File | Relevant WP-01 change |
|---|---|
| `lib/orderService.js` | Added pure freeze helpers; changed `payOrder` first-payment identity pipeline; changed `updatePayment` freeze/atomic-write behavior; added structured payment log events. |
| `app/api/orders/[id]/route.js` | Maps status-bearing service errors to the original status and stable code; passes `actorId` to `updatePayment`. |
| `app/api/orders/[id]/status/route.js` | Maps status-bearing service errors to the original status and stable code. |
| `tests/phase25-payment-immutability.test.mjs` | New DB-free source-contract and pure-rule suite. |
| `tests/integration/phase25-payment-immutability.integration.mjs` | New opt-in real replica-set suite. |

### 3.2 Behavior confirmed by source review

- The frozen identity is `paymentMethod` + `paymentAccountId` + `paymentAccountSnapshot`.
- The lock marker is the existing `paidAt`; no new schema field is introduced.
- `payOrder` uses one atomic `findOneAndUpdate` pipeline with `updatePipeline: true`.
- `isFirstPayment` is keyed on `{ $ifNull: ["$paidAt", null] } === null` **and** `status !== "PAID"`.
- `paymentMethod`, `paymentAccountId`, and `paymentAccountSnapshot` are written only when `isFirstPayment` is true.
- `paidAt`, `completedAt`, and `servedAt` are stamped only on a genuine first settlement.
- `updatePayment` treats `paidAt` non-null **or** `status === "PAID"` as frozen.
- `updatePayment` same method on a frozen order returns the existing order without mutation.
- `updatePayment` different method on a frozen order throws `409 PAYMENT_METHOD_IMMUTABLE`.
- `updatePayment` never stamps `paidAt`, `completedAt`, or `servedAt`.
- The pre-PAID `updatePayment` write filters on `paidAt: null` and `status: { $ne: "PAID" }`.
- The service logs `payment_method_preserved` and `payment_method_conflict` with order ID, actor ID, requested method, stored method, and result only.

### 3.3 Scope caveat

The working tree is dirty and contains many unrelated changes, including UI files such as `app/components/CashierUI.jsx` and `app/components/KitchenDisplay.js`. WP-01’s stated scope excludes UI changes, but the dirty tree does not allow a clean WP-01-only diff to prove that no UI file changed. This is an **evidence-attribution gap**, not a demonstrated runtime failure. A clean worktree or a WP-01-only commit is required for the “no UI change” acceptance item.

---

## 4. Staging environment gate — why the manual run is blocked

| Requirement | Evidence | Result |
|---|---|---|
| Explicitly approved isolated staging environment | No staging URL, host, credential, or approval record was provided. `docs/production-readiness/phase-2-1-production-gap-assessment.md` (H7) records staging as a verified absence. | **MISSING** |
| Staging database isolated from production | No approved staging database target exists. Local `27017`/`27018` are not approved staging and were not used. | **MISSING** |
| Safe test staff accounts and test payment accounts | No staging test-data provisioning record or approved test tenant was provided. | **MISSING** |
| Approved disposable replica set for concurrency proof | `127.0.0.1:27019` was not listening; no approved disposable target was provisioned. | **MISSING** |
| Permission to create synthetic orders/payments | Cannot be granted without an approved isolated target. | **BLOCKED** |

**Decision:** Do not substitute production, the local application database, the Hotel test database, or a newly created unapproved environment. Acceptance stops here.

---

## 5. Manual acceptance checklist and outcomes

Every case below is written so it can be executed unchanged once an approved isolated staging target exists. All outcomes are currently **BLOCKED — NOT RUN**. “Static review” notes are observations from source inspection only; they are not staging evidence.

### GP1-01 — Cash payment

**Preconditions**
- Synthetic order `O-CASH` in `SERVED`, total `10.00`, `paidAt: null`.
- Authenticated MANAGER test session.
- Staging only; test order only.

**Steps**
1. `PATCH /api/orders/{O-CASH}` with body `{"status":"PAID","paymentMethod":"CASH"}`.
2. `GET /api/orders/{O-CASH}`.
3. Read the order document once from the staging database (read-only verification).

**Expected**
- HTTP `200`.
- `status = "PAID"`.
- `paymentMethod = "CASH"`.
- `paymentAccountId = null`.
- `paymentAccountSnapshot = null`.
- `paidAt` non-null.
- `completedAt` and `servedAt` non-null if they were null before.
- Exactly one order document; no second payment identity.

**Actual:** **BLOCKED — NOT RUN.** No approved staging environment.

**Static review:** The `payOrder` pipeline writes `paymentMethod` only when `isFirstPayment` is true and explicitly nulls account/snapshot for a first CASH payment. No runtime evidence.

---

### GP1-02 — Bank transfer

**Preconditions**
- Synthetic active payment account `PAY-ACC-1` with unmistakably synthetic values, e.g. `bankName = "Acceptance Test Bank"`, `ownerName = "Synthetic Test Owner"`, `accountNumber = "TEST-ONLY-0001"`.
- Synthetic order `O-TRANSFER` in `SERVED`.
- Authenticated MANAGER test session.

**Steps**
1. `PATCH /api/orders/{O-TRANSFER}` with body `{"status":"PAID","paymentMethod":"TRANSFER","paymentAccountId":"{PAY-ACC-1}"}`.
2. `GET /api/orders/{O-TRANSFER}`.
3. Read the stored order document.

**Expected**
- HTTP `200`.
- `status = "PAID"`.
- `paymentMethod = "TRANSFER"`.
- `paymentAccountId = {PAY-ACC-1}`.
- `paymentAccountSnapshot` equals the synthetic `bankName`, `ownerName`, and `accountNumber`.
- `paidAt` non-null.
- No second payment identity.

**Actual:** **BLOCKED — NOT RUN.** No approved staging environment.

**Static review:** The transfer branch validates the account server-side and snapshots `bankName`, `ownerName`, and `accountNumber`; the snapshot is guarded by `isFirstPayment`. No runtime evidence.

---

### GP1-03 — Transfer with payment account and snapshot integrity

**Preconditions**
- Synthetic order `O-TRANSFER-2` in `SERVED`.
- Synthetic active account `PAY-ACC-2` with synthetic values.
- Ability to rename or disable `PAY-ACC-2` after payment (test account only).

**Steps**
1. Pay `O-TRANSFER-2` as TRANSFER with `PAY-ACC-2`.
2. Record the stored `paymentAccountId` and `paymentAccountSnapshot`.
3. Rename or disable `PAY-ACC-2` in the staging test data.
4. Read `O-TRANSFER-2` again.
5. Attempt a same-method retry through the available service/API path.

**Expected**
- Stored account ID and snapshot do not change after the test account is renamed or disabled.
- Retry does not re-snapshot, does not change `paidAt`, and does not create a second payment.
- No account number appears in logs.

**Actual:** **BLOCKED — NOT RUN.** No approved staging environment.

**Static review:** The snapshot is stored on the order at first payment and the retry path preserves `$paymentAccountSnapshot`. No runtime evidence.

---

### GP1-04 — Same-method PAID retry

**Preconditions**
- `O-CASH` paid as CASH.
- `O-TRANSFER` paid as TRANSFER with `PAY-ACC-1`.
- Manager/Cashier test session for API calls; service-level harness for `payOrder` calls.

**Steps**
1. `PATCH /api/orders/{O-CASH}` with body `{"paymentMethod":"CASH"}`.
2. Service-level `payOrder(O-CASH, { paymentMethod: "CASH" })` against staging.
3. `PATCH /api/orders/{O-TRANSFER}` with body `{"paymentMethod":"TRANSFER"}`.
4. Service-level `payOrder(O-TRANSFER, { paymentMethod: "TRANSFER", paymentAccountId: "{PAY-ACC-1}" })`.
5. Re-read both orders and compare `paidAt`, method, account, snapshot, and `updatedAt`.

**Expected**
- CASH same-method API call: HTTP `200`; no mutation; `paidAt` unchanged; `updatedAt` unchanged.
- CASH same-method service retry: HTTP-equivalent success; same identity; `paidAt` unchanged.
- TRANSFER same-method retry: identity and snapshot unchanged; no second payment.
- Exactly one payment identity per order.

**Actual:** **BLOCKED — NOT RUN.** No approved staging environment.

**Static/API reachability finding:** A TRANSFER same-method retry through `PATCH /api/orders/{id}` is not reachable as specified:
- Body `{"paymentMethod":"TRANSFER"}` fails `validateOrderStatusUpdate` with `paymentAccountId is required for Transfer payments` (HTTP `400`).
- Body `{"paymentMethod":"TRANSFER","paymentAccountId":"..."}` fails the route guard `paymentAccountId requires status PAID` (HTTP `400`).

The service-level `payOrder` retry is reachable through a test harness and is covered by the integration suite. This API limitation must be acknowledged in the staging evidence; it is not a substitute for the service-level test.

---

### GP1-05 — Different-method PAID retry

**Preconditions**
- `O-CASH` paid as CASH.
- `O-TRANSFER` paid as TRANSFER with `PAY-ACC-1`.
- `PAY-ACC-3` synthetic active account for a different-method transfer request.

**Steps**
1. Service-level `payOrder(O-CASH, { paymentMethod: "TRANSFER", paymentAccountId: "{PAY-ACC-3}" })`.
2. `PATCH /api/orders/{O-TRANSFER}` with body `{"paymentMethod":"CASH"}`.
3. `PATCH /api/orders/{O-CASH}` with body `{"paymentMethod":"TRANSFER"}`.
4. Service-level `updatePayment(O-CASH, { paymentMethod: "TRANSFER" })`.
5. Re-read both orders and inspect the structured log.

**Expected**
- `payOrder` different-method retry: HTTP-equivalent `200`; original CASH identity preserved; no account populated; no second payment; `payment_method_preserved` log event.
- `updatePayment` TRANSFER-to-CASH on a PAID order: HTTP `409`, code `PAYMENT_METHOD_IMMUTABLE`; no mutation; `payment_method_conflict` log event.
- `updatePayment` CASH-to-TRANSFER on a PAID order: the Phase 2.5 contract expects `409 PAYMENT_METHOD_IMMUTABLE`.
- No identity change and no second payment in any path.

**Actual:** **BLOCKED — NOT RUN.** No approved staging environment.

**Static finding — likely API-contract mismatch:** For `PATCH /api/orders/{O-CASH}` with `{"paymentMethod":"TRANSFER"}`, validation runs before `updatePayment` and returns HTTP `400` (`paymentAccountId is required for Transfer payments`). Supplying `paymentAccountId` returns HTTP `400` from the route guard (`paymentAccountId requires status PAID`). Therefore the API currently cannot return the expected `409 PAYMENT_METHOD_IMMUTABLE` for a CASH-to-TRANSFER retry, even though the service itself would return `409`. This must be confirmed on staging and resolved or explicitly accepted by the owner before G-PAY-1 is signed. Do not treat the service-level integration test as proof of the API contract.

---

### GP1-06 — Legacy PAID orders with `paidAt: null`

**Preconditions**
- Synthetic order `O-LEGACY` with `status = "PAID"`, `paymentMethod = "CASH"`, `paidAt = null`, `completedAt = null`, `servedAt = null`.

**Steps**
1. `PATCH /api/orders/{O-LEGACY}` with body `{"paymentMethod":"CASH"}`.
2. `PATCH /api/orders/{O-LEGACY}` with body `{"paymentMethod":"TRANSFER"}`.
3. Service-level `updatePayment(O-LEGACY, { paymentMethod: "TRANSFER" })`.
4. Service-level `payOrder(O-LEGACY, { paymentMethod: "TRANSFER", paymentAccountId: "{PAY-ACC-1}" })`.
5. Re-read the order and confirm `paidAt`, `completedAt`, and `servedAt` remain null.

**Expected**
- Same-method API call: HTTP `200`; no mutation.
- Different-method service call: HTTP-equivalent `409 PAYMENT_METHOD_IMMUTABLE`.
- `payOrder` retry: HTTP-equivalent `200`; original CASH identity preserved.
- `paidAt` remains `null`; `completedAt` remains `null`; `servedAt` remains `null`.
- No method backfill and no second payment.

**Actual:** **BLOCKED — NOT RUN.** No approved staging environment.

**Static/API reachability finding:** The different-method API call CASH-to-TRANSFER is expected to return HTTP `400` from validation rather than `409`; the same limitation described in GP1-05 applies. The service-level path is expected to return `409`.

---

### GP1-07 — Concurrent payment update attempts

**Preconditions**
- Synthetic orders `O-RACE-1` and `O-RACE-2` in `SERVED`.
- Synthetic active account `PAY-ACC-4`.
- A staging service harness able to issue concurrent service calls.

**Steps**
1. On `O-RACE-1`, issue two concurrent `payOrder` calls: CASH and TRANSFER with `PAY-ACC-4`.
2. On `O-RACE-2`, issue `updatePayment(CASH)` and `payOrder(TRANSFER, PAY-ACC-4)` concurrently.
3. On a PAID order, issue two concurrent `updatePayment` calls with different methods.
4. Re-read both orders and compare all responses.

**Expected**
- Exactly one winning payment identity per order.
- Exactly one `paidAt`.
- No torn pair: never `paymentMethod = "CASH"` with a transfer account/snapshot, or the reverse.
- The losing `updatePayment` returns `409 PAYMENT_METHOD_IMMUTABLE` or loses cleanly without mutation.
- No second order or payment record.
- Both concurrent `payOrder` callers observe the same winning identity.

**Actual:** **BLOCKED — NOT RUN.** No approved staging environment and no approved disposable replica-set target.

**Existing automated coverage:** `tests/integration/phase25-payment-immutability.integration.mjs` contains the corresponding real replica-set tests, including concurrent different-method payments and `updatePayment` racing `payOrder`. It was not executed in this acceptance run. Owner-provided context says the automated suite passed, but that claim was not independently reproduced here.

---

### GP1-08 — Redacted logs

**Preconditions**
- Structured JSON application logs captured from the staging process during GP1-01 through GP1-07.
- Synthetic payment account with a unique marker account number, e.g. `TEST-ONLY-LOG-<run-id>`.

**Steps**
1. Capture log lines for `payment_method_preserved` and `payment_method_conflict`.
2. Search the captured logs for:
   - the synthetic account number;
   - `accountNumber`, `paymentAccountSnapshot`, `bankName`, `ownerName`;
   - `pin`, `token`, `secret`, `authorization`, `cookie`, `mongodb://`, `mongodb+srv://`;
   - any connection string or bearer-style credential.
3. Confirm the payment events contain only the documented fields.

**Expected**
- `payment_method_preserved` and `payment_method_conflict` contain only `orderId`, `actorId`, `requestedMethod`, `storedMethod`, and `result`.
- No account number, PIN, token, secret, cookie, or connection string appears.
- Sensitive keys are emitted as `[redacted]`.
- No account snapshot is logged.

**Actual:** **BLOCKED — NOT RUN at runtime.** No staging logs were produced.

**Static evidence executed:**
- Source review confirms the two WP-01 log blocks contain only the documented fields.
- `tests/operational-logger.test.mjs`: **10 pass / 0 fail**, including sensitive-key detection and MongoDB credential redaction.
- `tests/phase25-payment-immutability.test.mjs` includes a source-contract assertion that the `payment_method_preserved` block contains no `accountNumber`, `bankName`, `ownerName`, `paymentAccountSnapshot`, `paymentAccountId`, or `pin`.

**Residual risk:** `accountNumber` is not itself a sensitive key term in `lib/operationalLogger.js`. Redaction is key-name based. The WP-01 call sites do not pass the account number, but the guarantee depends on call-site discipline; runtime staging logs are still required.

---

### GP1-09 — Static scope and schema checks

**Steps**
1. Confirm no new freeze field was added to `lib/models/Order.js`.
2. Confirm no WP-01-attributable UI file changed.
3. Confirm no application or test file was modified during this acceptance run.

**Expected**
- No `paymentIdentityFrozen`, `paymentLockedAt`, `frozenAt`, `orderVersion`, or `inventoryMode` field.
- `paidAt` remains the only lock marker.
- No UI change in the WP-01 diff.
- Acceptance run is read-only except for this report.

**Actual**
- No new freeze field: **PASS (static + DB-free test).**
- No UI change attributable to WP-01: **UNVERIFIED.** The working tree contains unrelated UI modifications; a clean WP-01-only diff is not available.
- No application/test modification during this run: **PASS.** Only this report was written.

---

## 6. Unresolved risks and likely failures

These are findings from source review. None can be closed without staging evidence. They are recorded so the owner can decide whether they block G-PAY-1.

| ID | Risk | Severity | Status | Required action |
|---|---|---|---|---|
| R-1 | No approved staging environment; all manual cases unexecuted. | **Blocker** | **OPEN** | Provision or approve isolated staging with disposable data, then rerun this checklist. |
| R-2 | `payOrder` PAID retries are not reachable through `PATCH /api/orders/{id}` because the route returns `400` for a PAID order before calling `payOrder`. The service-level retry contract is therefore not proven through the public API. | High | **UNVERIFIED / LIKELY API GAP** | Confirm on staging; decide whether the route should expose the idempotent retry or whether service-level proof is acceptable. |
| R-3 | Different-method `updatePayment` CASH-to-TRANSFER through the API returns `400` from validation before the service can return `409 PAYMENT_METHOD_IMMUTABLE`. | High | **UNVERIFIED / LIKELY CONTRACT MISMATCH** | Confirm on staging; preserve/align the documented `409` contract or amend the contract with owner approval. |
| R-4 | Same-method TRANSFER retry through the API is blocked by account validation/route guard (`400`), so only the service-level retry can be exercised. | Medium | **UNVERIFIED** | Confirm and document the supported retry path. |
| R-5 | `payOrder` a TRANSFER retry validates the account before preserving identity. If the test account is disabled or deleted after the first payment, an idempotent retry may fail instead of returning the stored identity. | Medium | **UNVERIFIED** | Test on staging with a disabled/deleted account; decide whether retry should bypass account revalidation. |
| R-6 | A MANAGER direct `PATCH {"status":"PAID"}` from `SERVED` can omit `paymentMethod`, producing `PAID` with `paymentMethod = "NONE"` and no frozen method identity. | Medium | **UNVERIFIED** | Confirm on staging; decide whether method is mandatory for direct settlement. |
| R-7 | `accountNumber` is not in the logger’s sensitive-key list; redaction depends on call sites not passing it. | Medium | **STATIC RISK** | Capture real staging logs and verify no account number appears; consider a future logger hardening (not in this run). |
| R-8 | Working tree is dirty with unrelated UI/model changes, so “no UI change” cannot be attributed to WP-01 alone. | Medium | **UNVERIFIED** | Produce a WP-01-only commit or clean worktree for the acceptance evidence. |
| R-9 | Disposable replica-set integration suite (16 tests) was not executed in this run. | High | **NOT RUN** | Execute against an approved disposable target and attach sanitized output. |

No refund, chargeback, accounting, or WP-02 behavior was exercised. No WP-04, WP-13, or WP-09 work was started.

---

## 7. Sanitized evidence

### 7.1 Commands executed

All commands below were run from `C:\hotelms`. They are DB-free except where noted. No command opened a database connection, read `.env.local`, or printed a secret.

```text
node --test tests/phase25-payment-immutability.test.mjs
node --test tests/payment-rejection-resubmit.test.mjs
node --test tests/payment-verification.test.mjs
node --test tests/payment-transfer-generic.test.mjs
node --test tests/payment-accounts.test.mjs
node --test tests/operational-logger.test.mjs
node --test tests/phase23-order-integrity.test.mjs
```

### 7.2 Result summary

```text
tests/phase25-payment-immutability.test.mjs   20 tests, 20 pass, 0 fail
tests/payment-rejection-resubmit.test.mjs      8 tests,  8 pass, 0 fail
tests/payment-verification.test.mjs           15 tests, 15 pass, 0 fail
tests/payment-transfer-generic.test.mjs       12 tests, 12 pass, 0 fail
tests/payment-accounts.test.mjs               14 tests, 14 pass, 0 fail
tests/operational-logger.test.mjs             10 tests, 10 pass, 0 fail
tests/phase23-order-integrity.test.mjs        15 tests, 15 pass, 0 fail
```

The only warnings were Node.js `MODULE_TYPELESS_PACKAGE_JSON` performance warnings from `lib/constants.js`, `lib/validate.js`, and `lib/operationalLogger.js`. They are not test failures and are not related to WP-01.

### 7.3 WP-01 DB-free test names (all passed)

- New writes normalize legacy TELEBIRR to canonical TRANSFER.
- Requested/stored comparison treats TELEBIRR and TRANSFER as one identity.
- `paidAt` is the lock marker; legacy PAID with `paidAt` null stays frozen.
- The conflict carries the stable `409 PAYMENT_METHOD_IMMUTABLE` contract.
- No new schema field is introduced for the freeze.
- The PAID-eligible filter and single atomic pipeline are preserved.
- `paymentMethod` is written only while `paidAt` is null.
- Account and snapshot are guarded by `paidAt`, never by a null account ID.
- `paidAt`, `completedAt`, and `servedAt` are stamped only on a genuine first settlement.
- A different-method retry is logged without account or secret data.
- Payment leaves unrelated financial history untouched.
- The PAID timestamp-stamping block is gone.
- PAID and legacy-paid orders are frozen by the shared decision.
- The pre-PAID write is atomic and re-checks the freeze marker.
- A concurrent freeze is resolved by re-read, not a blind retry.
- Both order routes map a status-bearing service error to `409` + code.
- `submitPaymentForVerification` cannot run on PAID and preserves the submitted identity.
- `confirmPayment` preserves the submitted method/account snapshot.
- `rejectPayment` returns to SERVED without touching the identity.
- No refund, chargeback, or accounting rule is invented.

### 7.4 Integration suite reviewed but not executed

`tests/integration/phase25-payment-immutability.integration.mjs` defines 16 tests:

1. Target guard rejects a non-phase database name.
2. Target guard rejects credentials and the application port.
3. First cash payment records one identity.
4. Same-method retry keeps one `paidAt` and one payment.
5. Different-method retry preserves the original cash identity.
6. Different-method retry preserves the original transfer account snapshot.
7. Legacy PAID with `paidAt` null is not backfilled by a `payOrder` retry.
8. Concurrent different-method payments leave exactly one consistent identity.
9. `updatePayment` on PAID with a different method returns `409` and changes nothing.
10. `updatePayment` on PAID with the same method is idempotent and stamps nothing.
11. Legacy PAID with `paidAt` null stays frozen with no backfill.
12. `updatePayment` on SERVED with `paidAt` null is allowed and does not settle.
13. `updatePayment` racing `payOrder` cannot tear the settled identity.
14. `confirmPayment` preserves the submitted method and snapshot.
15. `submitPaymentForVerification` cannot run on PAID.
16. `rejectPayment` returns to SERVED without changing the identity.

Execution requires all of:

```text
POS_PHASE25_INTEGRATION_TESTS=1
POS_PHASE25_TEST_TARGET_ACK=I_CONFIRM_DISPOSABLE_POS_REPLICA_SET
POS_PHASE25_TEST_MONGODB_URI=mongodb://127.0.0.1:27019/bono_pos_phase25_<unique>?directConnection=true
node --import ./tests/helpers/pos-phase25-register.mjs --test tests/integration/phase25-payment-immutability.integration.mjs
```

No approved target on port `27019` was running, and no disposable target was provisioned for this run. The harness’s own guard refuses non-loopback hosts, credentials, the application port, and any database name without the `bono_pos_phase25_` prefix; it drops only the verified phase database.

---

## 8. Prerequisites to resume acceptance

Before G-PAY-1 can be evaluated, the owner or operations must provide all of the following:

1. **Explicit approval** of an isolated staging environment for POS acceptance, including the staging URL and database target.
2. **Confirmation** that the staging database contains no real customer data and is not a production replica.
3. **Test staff accounts** for MANAGER, CASHIER, and WAITER with test-only credentials.
4. **At least one synthetic active payment account** with clearly synthetic bank name, owner name, and account number.
5. **Permission to create synthetic orders and payments** in that staging environment.
6. **A log-capture method** for structured application logs during the run.
7. **A decision on the API reachability findings** (R-2, R-3, R-4): whether the public API must expose `payOrder` PAID retries and the `409` different-method `updatePayment` contract, or whether service-level proof plus a documented limitation is acceptable.
8. **A clean WP-01-only diff or commit** so the “no UI change” and exact-diff evidence is attributable.

If any of items 1–5 is unavailable, acceptance remains blocked. Do not substitute production.

---

## 9. Owner decision requested

**G-PAY-1 is NOT passed.** The required manual staging cases have no evidence. The automated DB-free evidence is green, but it does not replace the staging acceptance required by the Phase 2.5 test plan.

Requested owner decision:

- **Approve and provision** an isolated staging target so the checklist in Section 5 can be executed; or
- **Defer G-PAY-1** and keep the payment release gate closed.

No further implementation, WP-04, WP-13, or WP-09 work will start until the owner explicitly approves the next step.

---

## 10. Final attestation

I did not access production databases, production secrets, or real customer financial records. I did not create real financial transactions. I did not modify application code or tests. I did not start WP-04, WP-13, or WP-09. I used only synthetic/static evidence and DB-free tests. Production was not accessed.

**End of report.**
