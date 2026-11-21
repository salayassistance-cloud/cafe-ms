# WP-01 Follow-up Remediation Report — G-PAY-1 Blockers

**Status:** **REMEDIATION IMPLEMENTED — G-PAY-1 REMAINS BLOCKED.**
**Date:** 2026-11-08
**Repository:** `C:\hotelms`
**Baseline commit:** `6965043` (`Complete Bono UI and reporting updates`)
**Scope:** Narrow WP-01 follow-up only: R-2, R-3, R-4, R-5, R-7, R-8.
**Environment:** DB-free only. No staging or production database was contacted, no `.env`/`.env.local` was read, and no real payment/refund/chargeback was executed.

---

## 1. Executive summary

The six authorized WP-01 follow-up findings were addressed at source level:

| ID | Finding | Result |
|---|---|---|
| **R-2** | PAID retry could not reach `payOrder` through the public PATCH routes | **Fixed.** Both PATCH routes now dispatch an existing `PAID` order to the idempotent `payOrder` path. Auth, ownership, and payment-confirm permission remain enforced. |
| **R-3** | Different-method PAID retry was rejected by validation with an unrelated `400` | **Fixed.** A method-only `{ paymentMethod: "TRANSFER" }` assertion is now structurally valid and reaches `updatePayment`, which returns `409 PAYMENT_METHOD_IMMUTABLE` for a frozen order. General submission validation was not weakened. |
| **R-4** | Same-method TRANSFER retry could disturb frozen identity | **Fixed.** Frozen retries write neither `paymentAccountId` nor `paymentAccountSnapshot`; the existing `$cond`/`paidAt` pipeline remains the authority. |
| **R-5** | PAID retry required a currently active account | **Fixed.** `payOrder` reads the freeze marker first and skips the active-account lookup for a frozen identity. New, unpaid TRANSFER still validates its selected account. |
| **R-7** | Logger did not redact account-number key variants | **Fixed.** Central redaction now covers `accountNumber`, `accountNo`, `account_number`, `acctNo`, `iban`, and case/separator variants, recursively. |
| **R-8** | Unrelated dirty UI work must not be attributed to WP-01 | **Honored.** This follow-up touched only 5 source files, 1 new test file, and this report. No UI/Hotel/Inventory/V2 file was modified. |

**Test evidence:** the new focused suite has **18 tests / 5 suites, 18 pass, 0 fail**. The focused regression run (new suite plus existing payment/order/logger suites) has **136 tests / 24 suites, 136 pass, 0 fail**. The full DB-free suite has **1408 tests / 254 suites, 1408 pass, 0 fail, 0 skipped**.

**G-PAY-1 is not signed.** The staging prerequisite identified in `g-pay-1-staging-acceptance-report.md` is still missing. The opt-in replica-set integration suite was not run because no disposable replica set was explicitly provisioned for this follow-up, and no staging acceptance was possible.

---

## 2. Documents read before changes

- `docs/production-readiness/g-pay-1-staging-acceptance-report.md`
- `docs/production-readiness/phase-2-5-implementation-blueprint.md` (WP-01 and §4.1.1 retry/error contract)
- `docs/production-readiness/phase-2-5-test-and-acceptance-plan.md` (§5 WP-01 acceptance criteria)
- `docs/production-readiness/phase-2-5-safety-and-deployment-gates.md` (INV-FIN-1..7)

---

## 3. Exact changes

### 3.1 `lib/validate.js` — R-3

`validateOrderStatusUpdate` previously required `paymentAccountId` for every TRANSFER request, including a method-only assertion against an existing order. That produced an unrelated `400` before the frozen-identity service could answer `409`.

**Change:** the account requirement now applies only when the request carries a `status` or `action`:

```js
const methodOnlyAssertion = !result.status && !result.action;
if (isTransferMethod(result.paymentMethod) && !result.paymentAccountId && !methodOnlyAssertion) {
  return { error: "paymentAccountId is required for Transfer payments" };
}
```

**Preserved:**
- `{ status: "PAYMENT_PENDING", paymentMethod: "TRANSFER" }` without an account still fails.
- `{ status: "PAID", paymentMethod: "TRANSFER" }` without an account still fails (existing test contract).
- Invalid account ObjectIds still fail.
- CASH-with-account and account-without-TRANSFER rules are unchanged.

### 3.2 `lib/orderService.js` — R-4/R-5

`payOrder` now reads the freeze marker before validating a TRANSFER account:

```js
let frozenIdentity = false;
if (pm === "TRANSFER") {
  const current = await Order.findOne(buildOrderQuery(identifier))
    .select("status paidAt")
    .lean();
  frozenIdentity = isFrozenPaymentIdentity(current);
}
if (pm === "TRANSFER") {
  if (!frozenIdentity) {
    // existing required-id, PaymentInfo lookup, isActive check, snapshot build
  }
} else if (pm === "CASH") {
  // unchanged
} else if (paymentAccountId) {
  // unchanged
}
```

**Behavior:**
- A frozen TRANSFER retry (including a legacy `PAID` order with `paidAt: null`) does not require the original account to exist or be active.
- `paymentAccOid`/`paymentSnapshot` stay `null` on a frozen retry, so the atomic pipeline adds no `paymentAccountId`/`paymentAccountSnapshot` write. The stored identity cannot be replaced.
- A new/unpaid TRANSFER still requires a syntactically valid account ID and still checks `PaymentInfo` existence and `isActive`.
- The single `findOneAndUpdate` payment commit, `status: { $in: ["SERVED", "READY", "PAID"] }` filter, `paidAt` lock marker, and `$cond` preservation are unchanged.
- No schema field was added. `paidAt` remains the sole lock marker.

### 3.3 `app/api/orders/[id]/route.js` — R-2

The PAID branch now recognizes an already-PAID order before the fallback `400`:

```js
if (existingForPay.status === "PAYMENT_PENDING") {
  doc = await confirmPayment(...);
} else if (existingForPay.status === "PAID") {
  // idempotent retry; same method = 200 no-op, different method = stored identity
  doc = await payOrder(conn, sanitizedId, { paymentMethod, paymentAccountId, actorId: ... });
} else if (roleUpper === "MANAGER" && existingForPay.status === "SERVED") {
  doc = await payOrder(...);
} else {
  return fail("Order must be submitted for verification before payment", 400);
}
```

**Preserved:** the `orders:payment:confirm` gate for `PAID`, the WAITER ownership check, route rate limiting, payload validation, and the `PAYMENT_PENDING → confirmPayment` canonical path.

### 3.4 `app/api/orders/[id]/status/route.js` — R-2

The same PAID retry dispatch was added for parity, with `paymentAccountId` forwarded:

```js
} else if (existingForPay.status === "PAID") {
  doc = await payOrder(conn, sanitizedId, {
    paymentMethod: validated.data.paymentMethod,
    paymentAccountId: validated.data.paymentAccountId,
    actorId: auth.payload.staffId,
  });
}
```

**Preserved:** the `raw === "PAID"` `orders:payment:confirm` gate, WAITER ownership check, and the existing `PAYMENT_PENDING`/MANAGER-SERVED behavior.

### 3.5 `lib/operationalLogger.js` — R-7

Added normalized account-number terms to the central `SENSITIVE_TERMS` list:

```js
"accountnumber",
"accountno",
"acctno",
"iban",
```

Because the logger already normalizes keys by lowercasing and removing separators, these cover `accountNumber`, `account_number`, `ACCOUNT-NUMBER`, `accountNo`, `account_no`, `acctNo`, `acct_no`, and `iban`. Redaction is recursive through nested objects, arrays, snapshots, and `Error` shapes. Bare `account` and `paymentAccountId` are deliberately **not** redacted so non-secret identifiers stay observable.

**No payment log call site was changed to log raw account details.** Existing WP-01 events still log only order ID, actor ID, requested/stored method, and result.

### 3.6 `tests/wp01-payment-remediation.test.mjs` — new focused suite

18 DB-free tests across 5 suites. It uses the existing repository convention:

- real `validateOrderStatusUpdate` and real logger imports;
- the real `payOrder`/`updatePayment` function bodies executed against a small in-memory `Order` model (no MongoDB, no `@/` alias resolution);
- source-contract assertions for route dispatch and authorization.

The suite covers all nine required areas:

| Required test | Covered by |
|---|---|
| 1. Public API same-method PAID retry | R-2 route-dispatch test + behavioral same-method PAID retry |
| 2. Public API different-method PAID retry → 409 | R-3 validator + `updatePayment` 409 + route error mapping |
| 3. PAID TRANSFER retry with inactive/unavailable account | R-4/R-5 frozen retry test (no `PaymentInfo` lookup possible) |
| 4. Original snapshot remains unchanged | Frozen retry asserts no account/snapshot pipeline writes and stored snapshot preserved |
| 5. New unpaid TRANSFER validates account | Validator + `payOrder` missing-account rejection |
| 6. Concurrent identity change cannot overwrite | Stale pre-read + concurrent freeze → 409; same-method re-read; `$cond` assertions |
| 7. Legacy PAID with `paidAt: null` frozen | Legacy frozen TRANSFER retry test |
| 8. Logger nested `accountNumber` variants | Key-variant, nested array/snapshot, and `logEvent` serialization tests |
| 9. Existing payment tests remain green | Focused and full DB-free runs below |

---

## 4. Resulting retry contract

| Request | Order state | Result |
|---|---|---|
| `{ status: "PAID", paymentMethod: "CASH" }` | `PAID` | `200`, stored identity preserved, `paidAt` unchanged |
| `{ status: "PAID", paymentMethod: "TRANSFER", paymentAccountId: <original or unavailable id> }` | `PAID` TRANSFER | `200`, no account lookup, stored account/snapshot preserved |
| `{ status: "PAID" }` | `PAID` (any method) | `200`, stored identity preserved |
| `{ paymentMethod: "TRANSFER" }` | `PAID` CASH (MANAGER; existing `orders:payment` policy) | `409 PAYMENT_METHOD_IMMUTABLE`, no write |
| `{ paymentMethod: "CASH" }` | `PAID` CASH | `200`, no write |
| `{ status: "PAID", paymentMethod: "TRANSFER", paymentAccountId: <valid> }` | `PAID` CASH | `200`, stored CASH identity preserved (blueprint §4.1.1 `payOrder` semantics) |
| `{ status: "PAYMENT_PENDING", paymentMethod: "TRANSFER" }` | unpaid | `400`, account required |
| `{ status: "PAID", paymentMethod: "TRANSFER" }` | any | `400`, account required (existing contract) |
| `{ paymentMethod: "TRANSFER" }` | unpaid | allowed; `updatePayment` may change the pre-PAID method (existing behavior) |
| Any PAID request by WAITER | any | `403`; no authorization bypass |

**Authorization note:** the method-only different-method retry path is still gated by the existing `orders:payment` policy (`WAITER`, `MANAGER`). A CASHIER receives `403` on that specific method-only route rather than `409`; the CASHIER PAID-status path reaches `payOrder` and preserves identity as above. No permission was widened for this follow-up.

---

## 5. Test results

### 5.1 New focused suite

```text
node --test tests/wp01-payment-remediation.test.mjs
tests 18 / suites 5 / pass 18 / fail 0 / skipped 0
```

### 5.2 Focused regression run

```text
node --test tests/wp01-payment-remediation.test.mjs tests/phase25-payment-immutability.test.mjs tests/phase23-order-integrity.test.mjs tests/payment-accounts.test.mjs tests/payment-transfer-generic.test.mjs tests/payment-verification.test.mjs tests/payment-rejection-resubmit.test.mjs tests/operational-logger.test.mjs tests/cashier-confirm-auth.test.mjs tests/cashier-role.test.mjs
tests 136 / suites 24 / pass 136 / fail 0 / skipped 0 / duration 4.09s
```

This includes the existing cash, transfer, payment-verification, rejection/resubmission, payment-account, order-integrity, WP-01 immutability, cashier-authorization, and logger suites.

### 5.3 Full DB-free suite

```text
node --test "tests/*.test.mjs"
tests 1408 / suites 254 / pass 1408 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration 34.49s
```

No database connection was opened by the DB-free suite. The opt-in replica-set integration suite was **not** run.

### 5.4 Not run

- `tests/integration/phase25-payment-immutability.integration.mjs` — requires an explicitly provisioned disposable replica set. None was assumed or created.
- Staging manual acceptance — no approved isolated staging environment, URL, credential, or database target exists.
- Real payment, refund, chargeback, inventory reconciliation, index deployment, schema migration, or seed — all excluded.

---

## 6. R-8 — change attribution and preserved working-tree paths

### 6.1 Exact follow-up changes

Only these paths were changed or created by this follow-up:

| Path | Change |
|---|---|
| `lib/validate.js` | Method-only TRANSFER validation exception (R-3) |
| `lib/orderService.js` | Frozen-marker pre-read and conditional account validation in `payOrder` (R-4/R-5) |
| `app/api/orders/[id]/route.js` | PAID retry dispatch to `payOrder` (R-2) |
| `app/api/orders/[id]/status/route.js` | PAID retry dispatch to `payOrder` (R-2) |
| `lib/operationalLogger.js` | Account-number redaction terms (R-7) |
| `tests/wp01-payment-remediation.test.mjs` | New 18-test focused suite |
| `docs/production-readiness/wp-01-follow-up-remediation-report.md` | This report |

**No UI file was modified.** No `app/components/*`, Hotel, Room Service, Waiter, Kitchen, Barista, Jebena Buna, POS, inventory, V2, index, schema, or seed file was changed by this follow-up.

### 6.2 Pre-existing working tree

The repository was already dirty at the start of this follow-up. `git status --porcelain=v1` showed **61 modified tracked paths and 71 untracked paths (132 entries)** before this report was created. Those paths were inspected only where needed; none was reverted, cleaned, checked out, stashed, staged, committed, or pushed.

The pre-existing dirty/untracked inventory is preserved verbatim in Appendix A. It includes the unrelated UI/Inventory/Hotel/Jebena files that must **not** be attributed to WP-01, for example:

- `app/components/CashierUI.jsx`, `InventoryUI.jsx`, `KitchenDisplay.js`, `ManagerSidebar.jsx`, `PinGuard.js`, `PinLoginModal.js`, `StaffManagement.jsx`, `WaiterUI.js`
- `app/hotel/`, `app/jebena/`, `app/components/hotel/`, `lib/hotel/`, `lib/inventory-v2/`
- `docs/hotel-foundation.md`, `docs/inventory-v2-phase2-foundations.md`, `docs/phase-a-jebena-buna-station-architecture.md`, `docs/phase-b-jebena-buna-station-implementation.md`
- the pre-existing `docs/production-readiness/` document set

### 6.3 Baseline limitation

The baseline commit is `6965043`. Because the working tree already contained uncommitted WP-01 and unrelated changes, `git diff` against `HEAD` cannot isolate this follow-up by itself. Attribution above is based on the exact paths edited in this session, not on blaming every dirty hunk in those files to WP-01.

---

## 7. Unresolved findings and residual risks

1. **G-PAY-1 remains BLOCKED.** No approved isolated staging environment exists, so the required manual acceptance cases (staging cash, transfer, transfer-with-account, same/different-method retries, stored-identity inspection, log inspection) were not run.
2. **Replica-set integration suite not executed.** The opt-in Phase 2.5 integration suite still needs an explicitly provisioned disposable replica set. No assumption was made that a previous disposable database exists.
3. **CASHIER method-only retry is `403`, not `409`.** The existing `orders:payment` policy is `WAITER`/`MANAGER`. This follow-up intentionally did not widen authorization. The `409` contract is reachable by MANAGER, and CASHIER's PAID-status retry preserves identity. If the owner requires CASHIER to receive `409` on the method-only route, that is an authorization-policy decision and must be approved separately.
4. **`{ status: "PAID", paymentMethod: "TRANSFER" }` without an account remains a `400`.** This preserves the existing validation contract. A caller can retry with `{ status: "PAID" }` or with a syntactically valid (even inactive/unavailable) account ID.
5. **Different-method `payOrder` retry returns `200` with the original identity**, per blueprint §4.1.1. Only `updatePayment` returns `409 PAYMENT_METHOD_IMMUTABLE`. This is intentional, not a regression.
6. **Logger redaction is key-based.** Account numbers embedded in arbitrary free-text message strings are not detected. Payment call sites do not log such strings; adding value-pattern detection would be a broader logging change.
7. **Narrow pre-read race.** If an unpaid TRANSFER order is frozen concurrently after the freeze check but before the account lookup, an account that is simultaneously disabled could still produce a validation error instead of an idempotent retry response. The stored identity is never mutated because the atomic `$cond` write remains authoritative. This race does not affect already-frozen retries and does not require a schema change.
8. **No production/staging validation of the logger output or route behavior** was possible. All evidence is DB-free/source-level.

---

## 8. Next G-PAY-1 prerequisites

1. Owner reviews the exact source changes and the new **18-test** focused suite.
2. Owner provides an approved isolated staging environment (URL, credentials, isolated database) or explicitly provisions a disposable replica set for integration tests.
3. Run `tests/integration/phase25-payment-immutability.integration.mjs` against that disposable target.
4. Execute the WP-01 manual acceptance cases from `phase-2-5-test-and-acceptance-plan.md` §5:
   - staging cash, transfer, and transfer-with-account payments;
   - same-method and different-method retries (`200`/`409` contract);
   - verify one stored identity and an unchanged `paidAt` on retry;
   - verify no UI change and no account number/PIN in logs.
5. Re-run the full DB-free suite on the reviewed tree.
6. Only then can G-PAY-1 be considered for sign-off. This follow-up does not sign it.

---

## Appendix A — Preserved pre-existing working-tree inventory

Snapshot from `git status --porcelain=v1` taken before this report file was created. The new test file `tests/wp01-payment-remediation.test.mjs` appears here because it was added during this follow-up; all other entries predate it.

```text
 M .env.example
 M app/api/auth/verify-pin/route.js
 M app/api/inventory/items/route.js
 M app/api/manager/settings/clear-orders/route.js
 M app/api/manager/staff/route.js
 M app/api/manager/waiters/route.js
 M app/api/orders/[id]/route.js
 M app/api/orders/[id]/status/route.js
 M app/api/orders/route.js
 M app/api/staff/route.js
 M app/components/CashierUI.jsx
 M app/components/InventoryUI.jsx
 M app/components/KitchenDisplay.js
 M app/components/ManagerSidebar.jsx
 M app/components/PinGuard.js
 M app/components/PinLoginModal.js
 M app/components/StaffManagement.jsx
 M app/components/WaiterUI.js
 M app/layout.js
 M app/login/page.js
 M app/manager/menu-crud/MenuCrudClient.jsx
 M app/manager/menu-crud/actions.js
 M app/manager/reports/page.js
 M app/page.js
 M eslint.config.mjs
 M lib/analytics.js
 M lib/cashierReport.js
 M lib/config/security.js
 M lib/inventoryAlertService.js
 M lib/inventoryDashboardService.js
 M lib/inventoryService.js
 M lib/inventoryWasteService.js
 M lib/menuService.js
 M lib/models/Category.js
 M lib/models/InventoryItem.js
 M lib/models/MenuItem.js
 M lib/models/Order.js
 M lib/models/Session.js
 M lib/models/Staff.js
 M lib/models/StockMovement.js
 M lib/mongodb.js
 M lib/orderService.js
 M lib/policy.js
 M lib/reportRevenueBreakdown.js
 M lib/reportService.js
 M lib/staffService.js
 M lib/stationStatus.js
 M lib/translations.js
 M lib/validate.js
 M lib/withApi.js
 M package-lock.json
 M package.json
 M scripts/reset-auth.js
 M scripts/seed-auth.js
 M scripts/sync-indexes.js
 M scripts/test-menu-unification.mjs
 M tests/cashier-report.test.mjs
 M tests/clear-orders-auth.test.mjs
 M tests/default-credential-cleanup.test.mjs
 M tests/payment-rejection-resubmit.test.mjs
 M tests/staff-pin-canonical.test.mjs
?? app/api/health/
?? app/api/hotel/
?? app/api/manager/inventory-approvals/
?? app/api/orders/[id]/inventory-approval/
?? app/api/station/
?? app/components/EthiopianDatePicker.jsx
?? app/components/StationReportPanel.jsx
?? app/components/hotel/
?? app/fonts/
?? app/hotel/
?? app/jebena/
?? docs/hotel-foundation.md
?? docs/inventory-v2-phase2-foundations.md
?? docs/phase-a-jebena-buna-station-architecture.md
?? docs/phase-b-jebena-buna-station-implementation.md
?? docs/production-readiness/
?? lib/config/runtimeEnv.js
?? lib/health.js
?? lib/hotel/
?? lib/inventory-v2/
?? lib/inventoryReservationRules.js
?? lib/inventoryReservationService.js
?? lib/models/InventoryReservation.js
?? lib/operationalLogger.js
?? lib/staffPinPolicy.js
?? lib/stationReport.js
?? scripts/hotel-deploy-indexes.mjs
?? scripts/hotel-provision-manager.mjs
?? scripts/hotel-rotate-credentials.mjs
?? scripts/inventory-v2-deploy-indexes.mjs
?? scripts/migrate-hot-drink-station.mjs
?? scripts/pos-provision-manager.mjs
?? scripts/seed-hot-drink-staff.mjs
?? tests/auth-production-hardening.test.mjs
?? tests/clear-orders-safety.test.mjs
?? tests/health-endpoint.test.mjs
?? tests/helpers/
?? tests/hot-drink-station.test.mjs
?? tests/hotel-auth-routes.test.mjs
?? tests/hotel-ethiopian-calendar-ui.test.mjs
?? tests/hotel-foundation.test.mjs
?? tests/hotel-guest-verification.test.mjs
?? tests/hotel-index-deploy.test.mjs
?? tests/hotel-integration-cleanup.mjs
?? tests/hotel-integration-guard.test.mjs
?? tests/hotel-integration-harness.test.mjs
?? tests/hotel-integration.test.mjs
?? tests/hotel-payments.test.mjs
?? tests/hotel-reception-login-ui.test.mjs
?? tests/hotel-reception.test.mjs
?? tests/hotel-reports.test.mjs
?? tests/hotel-room-reports-ui.test.mjs
?? tests/hotel-rooms-ui.test.mjs
?? tests/hotel-rooms.test.mjs
?? tests/hotel-staff.test.mjs
?? tests/hotel-stays.test.mjs
?? tests/hotel-ui-i18n.test.mjs
?? tests/hotel-users-ui.test.mjs
?? tests/integration/
?? tests/inventory-hook-observability.test.mjs
?? tests/inventory-lifecycle-phase1-1.test.mjs
?? tests/inventory-reservation-phase1.test.mjs
?? tests/inventory-v2-phase1.test.mjs
?? tests/inventory-v2-phase2.test.mjs
?? tests/kds-single-flight-polling.test.mjs
?? tests/operational-logger.test.mjs
?? tests/phase23-order-integrity.test.mjs
?? tests/phase25-payment-immutability.test.mjs
?? tests/pos-index-management.test.mjs
?? tests/station-report.test.mjs
?? tests/wp01-payment-remediation.test.mjs
```

No git mutation command (`reset`, `clean`, `checkout`, `stash`, `add`, `commit`, `push`) was run.
