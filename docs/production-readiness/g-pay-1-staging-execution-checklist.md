# G-PAY-1 Staging Execution Checklist

**Status:** **PREPARED — NOT EXECUTED. ALL CASES ARE BLOCKED UNTIL GATE G0 IS VERIFIED.**
**Date:** 2026-11-08
**Repository:** `C:\hotelms`
**Baseline:** `main` / `69650435a6587d4577bc126f719fa1392bb934b3`
**Scope:** WP-01 payment identity immutability acceptance in an approved, isolated staging environment.

> This checklist is preparation only. It does not claim G-PAY-1 passed. Do not execute any case until every G0 gate below is positively verified and recorded with an approval reference. Do not use production, the Hotel database, the local application database on `27017`/`27018`, or any database containing real data.

---

## 0. Execution rules

1. Use only an owner-approved staging application and an owner-approved, isolated staging MongoDB replica set.
2. Use only synthetic staff, sessions, payment accounts, orders, and amounts. Record every synthetic identifier.
3. Never print or attach cookies, tokens, PINs, connection strings, or real account numbers. Sanitize captured evidence.
4. Do not run migrations, seed scripts, index synchronization, or schema changes.
5. Do not run `Order.deleteMany({})` or any broad cleanup. Delete only the exact synthetic rows created for this run, or drop the staging database only if the database owner confirms it is dedicated and disposable.
6. Do not weaken authentication, ownership, or `orders:payment:confirm` to make a case pass.
7. Stop immediately if real customer data, production credentials, or an unexpected payment/accounting mutation is observed.

### Placeholders to fill only after approval

| Placeholder | Meaning |
|---|---|
| `<STAGING_BASE_URL>` | Approved staging application origin |
| `<STAGING_DB_NAME>` | Approved isolated staging database name |
| `<MANAGER_SESSION_COOKIE>` | Test MANAGER session cookie value (never print) |
| `<CASHIER_SESSION_COOKIE>` | Test CASHIER session cookie value (never print) |
| `<WAITER_SESSION_COOKIE>` | Test WAITER session cookie value (never print) |
| `<PAY_ACC_A>`, `<PAY_ACC_B>`, `<PAY_ACC_C>` | Synthetic `PaymentInfo` IDs |
| `<O_CASH>`, `<O_TRANSFER>`, `<O_LEGACY>`, `<O_RACE>`, `<O_VERIFY>`, `<O_REJECT>` | Synthetic order IDs |

---

## G0 — Preflight gate (must pass before any case)

| Gate | Required evidence | Status |
|---|---|---|
| G0-1 Environment approval | Written owner approval naming the staging environment and approval reference | REQUIRES OWNER APPROVAL |
| G0-2 Application isolation | **Owner:** the staging environment owner who issued G0-1. **Evidence:** a written, dated attestation naming the approved staging application URL/origin and its deployment context, referencing the G0-1 approval, plus a recorded URL-resolution/deployment-context check (for example, the deployed environment identifier or release record) confirming the URL is the staging app and not production. A URL that merely responds is not evidence. | REQUIRES ENVIRONMENT-OWNER ATTESTATION |
| G0-3 Database isolation | Approved staging MongoDB target is a dedicated replica set/database, not production, not Hotel, not `27017`/`27018`; database owner confirms no real customer data | NOT VERIFIED |
| G0-4 Test identities | Test-only MANAGER, CASHIER, and WAITER accounts exist; no real staff credentials are used | REQUIRES OWNER APPROVAL |
| G0-5 Test payment accounts | Synthetic `PaymentInfo` records approved for creation, deactivation, and deletion | REQUIRES OWNER APPROVAL |
| G0-6 Synthetic data permission | Permission to create synthetic orders and payments and to read back the stored documents | REQUIRES OWNER APPROVAL |
| G0-7 Log capture | Approved way to capture structured JSON logs without exposing secrets | NOT VERIFIED |
| G0-8 Cleanup/rollback | Named cleanup owner and approved procedure for synthetic rows or the dedicated staging database | REQUIRES OWNER APPROVAL |
| G0-9 Contract decisions | Owner decision on the known CASHIER `403` vs `409` behavior, the `status:"PAID"` different-method `200` preservation, and the inactive-account `500` mapping | REQUIRES OWNER APPROVAL |
| G0-10 Test window | Approved start/end time and change/ticket reference | REQUIRES OWNER APPROVAL |

**If any G0 item is not positively verified, mark every case `BLOCKED — NOT RUN` and stop.**

> **G0-2 authority resolution (RC-3, 2026-11-14).** G0-2 is owned by the staging environment owner named in the G0-1 approval, not by the tester or the database owner. Its evidence is a written, dated attestation plus a recorded deployment-context check, as stated in the table. This closes the earlier omission in which the owner was named only inside the evidence text and no dated artifact was required. See `staging-readiness-report.md` §6 (G0-1) and §10 item 2 for the same environment-owner source.

> **G0 applicability for the read-only G-REC-1 pilot (RC-3, 2026-11-14).** G0-4, G0-5, G0-6, and G0-9 are payment-acceptance gates. They do not apply to a read-only inventory scan. For G-REC-1, only G0-1, G0-2, G0-3, G0-7, G0-8, and G0-10 apply. G0-6 is replaced by the separate seeded-data authorization in `wp-04-test-and-acceptance-plan.md` §7.1C. This does not weaken G-PAY-1, which still requires every G0 item.

---

## 1. Synthetic fixtures

Create only after G0 approval.

| Fixture | Suggested synthetic values | Notes |
|---|---|---|
| MANAGER staff | `name="GP1 Test Manager"`, role `MANAGER`, test-only PIN hash | Never use a real staff PIN |
| CASHIER staff | `name="GP1 Test Cashier"`, role `CASHIER`, test-only PIN hash | Used for confirmation/rejection |
| WAITER staff | `name="GP1 Test Waiter"`, role `WAITER` | Owns the synthetic verify/reject orders |
| `PAY_ACC_A` | `bankName="GP1 Synthetic Bank A"`, `ownerName="GP1 Synthetic Owner A"`, `accountNumber="GP1-TEST-ACCT-A-0001"`, active | Initial transfer and snapshot tests |
| `PAY_ACC_B` | synthetic, inactive by default | New unpaid transfer rejection |
| `PAY_ACC_C` | synthetic, active | Concurrent different-account test |
| `O_CASH` | synthetic, `SERVED`, `paymentMethod="NONE"`, `paidAt=null` | Initial cash |
| `O_TRANSFER` | synthetic, `SERVED`, `paymentMethod="NONE"`, `paidAt=null` | Initial transfer |
| `O_LEGACY` | synthetic, `status="PAID"`, `paymentMethod="TRANSFER"`, `paidAt=null` | Legacy freeze |
| `O_RACE` | synthetic, `SERVED` | Concurrency |
| `O_VERIFY` | synthetic, `SERVED`, `waiterId=<WAITER staff id>` | Verification |
| `O_REJECT` | synthetic, `SERVED`, `waiterId=<WAITER staff id>` | Rejection |

Record all IDs and account numbers in a sanitized evidence table. Never record cookies or PINs.

---

## 2. Required cases

### GP1-01 — CASH initial payment

**Preconditions**
- G0 passed; `O_CASH` is synthetic, `SERVED`, `paymentMethod="NONE"`, `paidAt=null`.
- MANAGER test session is authenticated.

**Action**
1. `PATCH <STAGING_BASE_URL>/api/orders/<O_CASH>` with cookie `<MANAGER_SESSION_COOKIE>` and body:
   `{"status":"PAID","paymentMethod":"CASH"}`
2. `GET` the same order.
3. Read the stored order document read-only from `<STAGING_DB_NAME>`.

**Expected HTTP:** `200`.

**Expected persisted payment fields**
- `status="PAID"`.
- `paymentMethod="CASH"`.
- `paymentAccountId=null`.
- `paymentAccountSnapshot=null`.
- `paidAt` non-null.
- `completedAt` and `servedAt` non-null if they were null before.
- Exactly one payment identity; no second payment record.

**Expected audit/log:** no error log; no account number or secret in logs.

**Cleanup:** record `<O_CASH>`; delete only this synthetic order during the approved cleanup window, or leave it for the dedicated staging DB drop.

---

### GP1-02 — TRANSFER initial payment with active account

**Preconditions**
- `O_TRANSFER` is synthetic, `SERVED`, `paymentMethod="NONE"`, `paidAt=null`.
- `PAY_ACC_A` exists, is active, and has synthetic values.
- MANAGER test session.

**Action**
1. `PATCH /api/orders/<O_TRANSFER>` body:
   `{"status":"PAID","paymentMethod":"TRANSFER","paymentAccountId":"<PAY_ACC_A>"}`
2. Re-read the order and the stored document.

**Expected HTTP:** `200`.

**Expected persisted payment fields**
- `status="PAID"`.
- `paymentMethod="TRANSFER"`.
- `paymentAccountId=<PAY_ACC_A>`.
- `paymentAccountSnapshot` equals `PAY_ACC_A`'s synthetic `bankName`, `ownerName`, `accountNumber`.
- `paidAt` non-null.
- Exactly one payment identity.

**Expected audit/log:** no account number or snapshot value in logs.

**Cleanup:** retain `O_TRANSFER` for GP1-05/GP1-06/GP1-07/GP1-08; delete during final cleanup.

---

### GP1-03 — Same-method CASH retry

**Preconditions**
- `O_CASH` is `PAID` from GP1-01.
- MANAGER test session.
- Record the current `paidAt`, `paymentMethod`, `paymentAccountId`, `paymentAccountSnapshot`, and `updatedAt`.

**Action**
1. `PATCH /api/orders/<O_CASH>` body `{"paymentMethod":"CASH"}` (method-only `updatePayment` path).
2. Re-read the order and stored document.
3. Repeat once with `{"status":"PAID","paymentMethod":"CASH"}` to exercise the status path.

**Expected HTTP:** `200` for both requests.

**Expected persisted payment fields**
- All payment identity fields unchanged.
- `paidAt` unchanged.
- No account or snapshot populated for CASH.
- `updatedAt` behavior recorded (no payment identity mutation).

**Expected audit/log:** no `payment_method_conflict`; no account number or secret.

**Cleanup:** keep `O_CASH` for GP1-04; delete during final cleanup.

---

### GP1-04 — Different-method CASH retry

**Preconditions**
- `O_CASH` is `PAID` as CASH.
- MANAGER test session (the method-only path is not available to CASHIER).

**Action**
1. `PATCH /api/orders/<O_CASH>` body `{"paymentMethod":"TRANSFER"}` as MANAGER.
2. Re-read the order.
3. Also record the CASHIER result with the same body (authorization check only; expected `403`).
4. As a separate documented behavior, send `{"status":"PAID","paymentMethod":"TRANSFER","paymentAccountId":"<PAY_ACC_A>"}` and record the result.

**Expected HTTP**
- MANAGER method-only different method: `409`.
- CASHIER method-only different method: `403` (authorization unchanged).
- Status-path different method: `200` with the stored CASH identity preserved (documented `payOrder` semantics).

**Expected persisted payment fields**
- `409` and `403` cause no mutation.
- Status-path `200` keeps `paymentMethod="CASH"`, no account, unchanged `paidAt`.
- No second payment identity.

**Expected audit/log**
- `payment_method_conflict` with `result="REJECTED"` for the `409`.
- `payment_method_preserved` for the status-path `200`.
- Logs contain method names only, never account numbers.

**Cleanup:** no new rows; keep `O_CASH`.

---

### GP1-05 — Same-method TRANSFER retry

**Preconditions**
- `O_TRANSFER` is `PAID` as TRANSFER with `PAY_ACC_A`.
- Record the current identity and snapshot.
- MANAGER test session.

**Action**
1. `PATCH /api/orders/<O_TRANSFER>` body `{"paymentMethod":"TRANSFER"}` (method-only path; no account required).
2. `PATCH /api/orders/<O_TRANSFER>` body `{"status":"PAID","paymentMethod":"TRANSFER","paymentAccountId":"<PAY_ACC_A>"}` (status path).
3. Repeat the status path through `/api/orders/<O_TRANSFER>/status`.
4. Re-read the stored document after each call.

**Expected HTTP:** `200` for all.

**Expected persisted payment fields**
- `paymentMethod="TRANSFER"`.
- `paymentAccountId=<PAY_ACC_A>`.
- `paymentAccountSnapshot` byte-for-byte unchanged.
- `paidAt` unchanged.
- No second payment identity.

**Expected audit/log:** no conflict; no account number or snapshot in logs.

**Cleanup:** keep `O_TRANSFER` for GP1-06 through GP1-08.

---

### GP1-06 — Different-method TRANSFER retry

**Preconditions**
- `O_TRANSFER` is `PAID` as TRANSFER.
- MANAGER test session.

**Action**
1. `PATCH /api/orders/<O_TRANSFER>` body `{"paymentMethod":"CASH"}` as MANAGER.
2. Re-read the order.
3. Record the CASHIER result with the same body (expected `403`).

**Expected HTTP:** `409` for MANAGER; `403` for CASHIER.

**Expected persisted payment fields**
- No mutation on either response.
- `paymentMethod` remains `TRANSFER`; account and snapshot unchanged; `paidAt` unchanged.

**Expected audit/log:** `payment_method_conflict` with `result="REJECTED"`; method names only.

**Cleanup:** no new rows.

---

### GP1-07 — TRANSFER retry after original account deactivation

**Preconditions**
- `O_TRANSFER` is `PAID` as TRANSFER with `PAY_ACC_A`.
- The test account owner has approved deactivating `PAY_ACC_A`.

**Action**
1. Set `PAY_ACC_A.isActive=false` in the approved staging test data.
2. `PATCH /api/orders/<O_TRANSFER>` body `{"status":"PAID","paymentMethod":"TRANSFER","paymentAccountId":"<PAY_ACC_A>"}`.
3. Re-read the stored document.

**Expected HTTP:** `200`.

**Expected persisted payment fields**
- Stored `paymentAccountId` and snapshot unchanged.
- `paidAt` unchanged.
- No account lookup failure; no mutation to a replacement account.

**Expected audit/log:** no account number, PIN, or secret; no new payment.

**Cleanup:** reactivate `PAY_ACC_A` only if required for GP1-08; otherwise proceed and delete it under the approved cleanup.

---

### GP1-08 — TRANSFER retry after original account deletion

**Preconditions**
- `O_TRANSFER` is `PAID` with a synthetic account that may be deleted.
- The test account owner has approved deleting the synthetic account.

**Action**
1. Delete the synthetic account used by `O_TRANSFER` (or use a dedicated synthetic account seeded for this case).
2. `PATCH /api/orders/<O_TRANSFER>` body `{"status":"PAID","paymentMethod":"TRANSFER","paymentAccountId":"<deleted-account-id>"}`.
3. Re-read the stored document.

**Expected HTTP:** `200`.

**Expected persisted payment fields**
- Stored account ID and snapshot unchanged.
- `paidAt` unchanged.
- No replacement account written.

**Expected audit/log:** no lookup error; no secret in logs.

**Cleanup:** record the deleted synthetic account ID; no real account may be deleted.

---

### GP1-09 — New unpaid TRANSFER with missing/inactive account

**Preconditions**
- A synthetic unpaid order `O_UNPAID` in `SERVED`.
- `PAY_ACC_B` is synthetic and inactive.
- MANAGER test session.

**Action**
1. `PATCH /api/orders/<O_UNPAID>` body `{"status":"PAID","paymentMethod":"TRANSFER"}` (missing account).
2. `PATCH /api/orders/<O_UNPAID>` body `{"status":"PAID","paymentMethod":"TRANSFER","paymentAccountId":"<PAY_ACC_B>"}` (inactive account).
3. `PATCH /api/orders/<O_UNPAID>` body `{"status":"PAID","paymentMethod":"TRANSFER","paymentAccountId":"<random-valid-object-id>"}` (nonexistent account).
4. Re-read the order after each attempt.

**Expected HTTP**
- Missing account: `400`.
- Inactive account: **currently `500` generic** (`Payment account is disabled` is not mapped to 4xx by the existing route). This is a pre-existing mapping gap, not a WP-01 regression.
- Nonexistent account: `404` (`Payment account not found`), pre-existing mapping.

**Expected persisted payment fields**
- No mutation on any failed attempt.
- `status` remains `SERVED`; `paymentMethod` remains `NONE`; `paidAt` remains `null`.

**Expected audit/log**
- Rejection without a payment write.
- The inactive-account attempt logs a server-side unhandled error; confirm the response body is generic and contains no account number or stack trace.
- Owner must explicitly accept the `500` mapping or defer G-PAY-1 for a clean-4xx fix.

**Cleanup:** delete `O_UNPAID` during final cleanup; delete `PAY_ACC_B` if created for this case.

---

### GP1-10 — Legacy PAID order with `paidAt:null`

**Preconditions**
- `O_LEGACY` is synthetic: `status="PAID"`, `paymentMethod="TRANSFER"`, `paymentAccountId=<synthetic account>`, `paymentAccountSnapshot=<synthetic snapshot>`, `paidAt=null`, `completedAt=null`, `servedAt=null`.
- MANAGER test session.

**Action**
1. `PATCH /api/orders/<O_LEGACY>` body `{"paymentMethod":"TRANSFER"}` (same method).
2. `PATCH /api/orders/<O_LEGACY>` body `{"paymentMethod":"CASH"}` (different method).
3. `PATCH /api/orders/<O_LEGACY>` body `{"status":"PAID","paymentMethod":"TRANSFER","paymentAccountId":"<random-valid-object-id>"}`.
4. Re-read the stored document after each call.

**Expected HTTP**
- Same-method method-only: `200` no-op.
- Different-method method-only: `409 PAYMENT_METHOD_IMMUTABLE`.
- Status retry: `200`, identity preserved.

**Expected persisted payment fields**
- `paidAt` remains `null` (no backfill).
- `completedAt` and `servedAt` remain `null`.
- `paymentMethod`, `paymentAccountId`, and snapshot unchanged.
- No second payment identity.

**Expected audit/log:** conflict/preserved events with method names only; no account number.

**Cleanup:** delete `O_LEGACY` during final cleanup.

---

### GP1-11 — Concurrent payment identity attempts

**Preconditions**
- `O_RACE` is synthetic, `SERVED`, `paidAt=null`.
- `PAY_ACC_C` and `PAY_ACC_D` are synthetic active accounts with distinct synthetic values.
- A staging harness or approved concurrent HTTP client is available.

**Action**
1. Fire two simultaneous requests:
   - `PATCH /api/orders/<O_RACE>` body `{"status":"PAID","paymentMethod":"TRANSFER","paymentAccountId":"<PAY_ACC_C>"}`
   - `PATCH /api/orders/<O_RACE>` body `{"status":"PAID","paymentMethod":"TRANSFER","paymentAccountId":"<PAY_ACC_D>"}`
2. Re-read the stored document at least 10 times.
3. Optionally repeat with `updatePayment` racing `payOrder` on a fresh synthetic order.

**Expected HTTP:** both requests may return `200`; no `500`.

**Expected persisted payment fields**
- Exactly one `paidAt`.
- Exactly one winning account ID.
- The stored snapshot matches the winning account ID; never a torn pair.
- No second payment identity.

**Expected audit/log:** at most one `payment_method_preserved` if the losing method differs; no account number or secret.

**Cleanup:** delete `O_RACE` and both synthetic accounts during final cleanup.

---

### GP1-12 — Payment verification and rejection

**Preconditions**
- `O_VERIFY` and `O_REJECT` are synthetic, `SERVED`, owned by the test WAITER.
- WAITER, CASHIER, and MANAGER test sessions.
- `PAY_ACC_A` is active for the transfer verification case.

**Action**
1. WAITER `PATCH /api/orders/<O_VERIFY>` body `{"status":"PAYMENT_PENDING","paymentMethod":"TRANSFER","paymentAccountId":"<PAY_ACC_A>"}`.
2. CASHIER `PATCH /api/orders/<O_VERIFY>` body `{"status":"PAID"}`.
3. WAITER `PATCH /api/orders/<O_REJECT>` body `{"status":"PAYMENT_PENDING","paymentMethod":"CASH"}`.
4. CASHIER `PATCH /api/orders/<O_REJECT>` body `{"action":"REJECT_PAYMENT","reason":"GP1 synthetic rejection"}`.
5. Re-read both stored documents.

**Expected HTTP:** `200` at each step.

**Expected persisted payment fields**
- `O_VERIFY`: `PAID`, method TRANSFER, account `PAY_ACC_A`, snapshot preserved, `paidAt` set, verification fields recorded.
- `O_REJECT`: back to `SERVED`, method CASH retained for audit, `paymentRejectedAt` set, reason recorded, `paidAt=null`.

**Expected audit/log:** no account number, PIN, or cookie in logs; rejection reason contains no sensitive data.

**Cleanup:** delete both synthetic orders during final cleanup.

---

### GP1-13 — Authentication and authorization checks

**Preconditions**
- Test sessions for MANAGER, CASHIER, WAITER, and a second WAITER (or an unauthenticated client).
- A synthetic PAID order and a synthetic `PAYMENT_PENDING` order.

**Action**
1. `PATCH` without a cookie.
2. `PATCH` with a WAITER cookie requesting `{"status":"PAID"}`.
3. `PATCH` with a CASHIER cookie and `{"paymentMethod":"TRANSFER"}` on a PAID CASH order (method-only path).
4. `PATCH` with a CASHIER cookie confirming a `PAYMENT_PENDING` order.
5. `PATCH` with a WAITER cookie on an order owned by a different waiter (SERVED/PAYMENT_PENDING ownership path).

**Expected HTTP**
- No cookie: `401`.
- WAITER PAID: `403`.
- CASHIER method-only transfer: `403`.
- CASHIER confirm: `200`.
- Wrong-owner WAITER: `403`.

**Expected persisted payment fields**
- No mutation on any denied request.
- The authorized CASHIER confirm preserves the submitted identity and sets `paidAt`.

**Expected audit/log:** auth failures do not log cookies or session IDs.

**Cleanup:** delete synthetic sessions and orders during final cleanup.

---

### GP1-14 — Nested logger redaction for account-number variants

**Preconditions**
- Approved staging log capture is active.
- A DB-free Node process can import the repository logger (no database connection).

**Action**
1. Run a temporary, non-repository probe in the staging workspace:
   - import `lib/operationalLogger.js`;
   - call `logEvent("info","gp1_redaction_probe",{accountNumber, accountNo, account_number, acctNo, iban, ACCOUNT_NUMBER, "account-number", nested:{accountNo, deeper:[{ACCT_NO}]}, safeField:"visible", paymentAccountId:"<synthetic-id>"})` with synthetic marker values.
2. Capture the emitted JSON line.
3. Also capture the `payment_method_conflict` and `payment_method_preserved` lines from GP1-04, GP1-06, and GP1-10.
4. Search the capture for the synthetic account numbers and secrets.

**Expected HTTP:** not applicable (log probe).

**Expected persisted payment fields:** not applicable; no database write.

**Expected log behavior**
- Every account-number variant is emitted as `"[redacted]"`.
- `safeField` and `paymentAccountId` remain visible.
- Conflict/preserved events contain only `orderId`, `actorId`, `requestedMethod`, `storedMethod`, and `result`.

**Cleanup:** delete the temporary probe file and captured raw logs after sanitized evidence is recorded.

---

### GP1-15 — No sensitive values in logs

**Preconditions**
- All GP1 cases executed with staging log capture.
- Synthetic markers: `GP1-TEST-ACCT-A-0001`, a synthetic PIN, a synthetic session cookie, and a synthetic connection-string marker.

**Action**
1. Scan all captured staged logs for:
   - every synthetic account number;
   - `pin`, `pinHash`, `password`, `token`, `secret`, `credential`, `cookie`, `authorization`;
   - `mongodb://`, `mongodb+srv://`, `Bearer `;
   - the synthetic session cookie value and synthetic PIN.
2. Confirm no raw synthetic account number appears.
3. Confirm connection strings appear only redacted, or not at all.

**Expected HTTP:** not applicable.

**Expected log behavior**
- No synthetic account number, PIN, token, cookie, or raw connection string.
- Sensitive keys appear as `"[redacted]"`.
- Payment events contain only the documented fields.

**Cleanup:** retain only sanitized excerpts; delete raw captures per the approved log-retention rule.

---

## 3. Evidence capture template

For each executed case, record:

| Field | Value |
|---|---|
| Case ID | GP1-xx |
| Approval reference | `<owner approval / ticket>` |
| Environment | `<STAGING_BASE_URL>` |
| Database | `<STAGING_DB_NAME>` |
| Synthetic order ID | `<id>` |
| Synthetic account ID | `<id>` |
| Request (sanitized) | method + path + JSON body; no cookie |
| HTTP status | `<status>` |
| Persisted identity | method / account ID / snapshot / paidAt |
| Log event | sanitized JSON excerpt |
| Verdict | PASS / FAIL / BLOCKED |
| Cleanup | exact rows deleted or DB drop reference |

Do not record cookies, PINs, tokens, or raw connection strings.

---

## 4. Known contract decisions requiring owner sign-off

| ID | Behavior | Owner decision required |
|---|---|---|
| C1 | CASHIER method-only different-method retry returns `403`, not `409` | Accept existing authorization policy or approve a policy change |
| C2 | `{"status":"PAID","paymentMethod":"TRANSFER"}` without an account returns `400` | Accept or change the existing validation contract |
| C3 | Status-path different-method retry returns `200` and preserves identity; only method-only `updatePayment` returns `409` | Accept blueprint §4.1.1 semantics |
| C4 | Inactive account on a new unpaid TRANSFER returns generic `500` | Accept as pre-existing mapping or require a clean-4xx fix before sign-off |
| C5 | Nonexistent account returns `404` | Accept existing mapping |
| C6 | Logger redaction is key-based, not value-pattern-based | Accept call-site discipline or approve a broader logger change |
| C7 | Narrow pre-read race on unpaid TRANSFER freeze | Accept documented residual risk |

---

## 5. Stop conditions

Stop and mark the run `BLOCKED` if:

- any G0 gate is not positively verified;
- the staging target cannot be proven isolated from production/Hotel/real data;
- a test requires weakening auth, ownership, or `payment_confirm`;
- an unexpected payment or accounting mutation occurs;
- a real account number, PIN, token, cookie, or connection string appears in a response or log;
- the fix requires a schema change, migration, seed, index deployment, or broad refactor outside WP-01.

**End of checklist.**
