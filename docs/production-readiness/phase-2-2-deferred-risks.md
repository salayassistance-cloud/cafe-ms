# Phase 2.2 — Deferred Risks and Required Owner Decisions

Status: **OPEN ITEMS — NOT IMPLEMENTED**
Date: 2026-11-07
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`

This document records every risk that Phase 2.2 deliberately did **not** resolve, why it was deferred, what the owner must decide, and what evidence would close it. No item below is claimed as fixed.

Evidence labels:

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in source/tests/git state. |
| **DEFERRED** | Understood, intentionally not changed in Phase 2.2. |
| **UNVERIFIED** | Cannot be proven without production/staging access or owner input. |
| **OWNER DECISION** | Requires an explicit business/security/accounting decision. |

---

## Summary matrix

| ID | Risk | Severity | Status | Required decision |
|---|---|---|---|---|
| R-01 | PAID can commit while inventory consumption fails | High | DEFERRED / VERIFIED | Owner approves recovery procedure |
| R-02 | No transaction/idempotency proof on real MongoDB replica set | High | UNVERIFIED | Staging/disposable replica-set test |
| R-03 | `clear-orders` is not V2-aware | Critical before V2 | DEFERRED | Disable before V2 activation |
| R-04 | `clear-orders` has no dual control, export, or UI caller | High | DEFERRED | Owner defines operational procedure |
| R-05 | Second destructive script `clean-order-history.js` is unhardened | High | DEFERRED / VERIFIED | Retire or harden before release |
| R-06 | Manager staff PIN change keeps step-up optional | Medium | DEFERRED | Owner decides mandatory step-up |
| R-07 | Deploying default-PIN rejection can lock out existing accounts | High | OWNER DECISION | Rotate PINs before deployment |
| R-08 | Index deployment approval detection is heuristic | Medium | DEFERRED | Mandate approval env in deploy pipeline |
| R-09 | Index deployment has no duplicate preflight / live inspection | Medium | DEFERRED | Staging inspection plan |
| R-10 | Rate limiting is in-memory per process | Medium | DEFERRED | Accept single-instance or add Redis |
| R-11 | Backup/restore/alerting/retention unproven | High | UNVERIFIED | Owner configures and tests |
| R-12 | Legacy `SystemAuth` model/scripts remain for development | Low | DEFERRED | Retire after migration evidence |
| R-13 | Health endpoint is public by design | Low | OWNER DECISION | Accept or restrict at edge |
| R-14 | First-Manager provisioning requires operator DB access | Medium | DEFERRED | Document runbook + access control |

---

## R-01 — An order can become PAID while inventory consumption fails

**Evidence:** VERIFIED in `lib/orderService.js`.

`payOrder` and `confirmPayment` write `status: "PAID"` atomically and then call `applyPaidInventory`. That function catches consumption failures and never throws, because the payment is already committed. Phase 2.2 only made the failure observable (`inventory_consumption_failed`).

**Impact:** A paid order can temporarily (or permanently, until retried) have consumption not recorded. `StockMovement` may be missing. The code attempts to release only real holds when consumption fails, but this is compensating logic, not a transaction.

**Why deferred:** Changing this touches financial/accounting semantics and the payment success contract, which requires owner approval. Converting the catch to a throw would falsely report a committed payment as failed and is prohibited.

**Owner decision required:** Approve one of:
1. Keep best-effort consumption and rely on alert-driven manual reconciliation.
2. Introduce an outbox/reconciliation job (Phase 2.3+) that retries consumption idempotently.
3. Move consumption into a replica-set transaction with payment (larger design change; requires R-02).

**Closure evidence:** A tested recovery procedure that confirms every PAID order reaches exactly one `StockMovement`/reservation terminal state, plus an alert with an owner and runbook.

---

## R-02 — No real MongoDB transaction/idempotency test was run

**Evidence:** UNVERIFIED. Phase 2.2 ran only DB-free tests. The atomic claims are verified by source (`status: "CONSUMING"`, conditional `$inc`), not by a live replica set.

**Impact:** Behavior under concurrent payment/consumption, transactions, and rollbacks is not proven. Mock tests cannot demonstrate production MongoDB semantics.

**Why deferred:** The safety gate prohibits connecting to MongoDB and running migrations/tests against it.

**Required action:** Run the existing transaction/concurrency test plan against a **disposable replica set** (or staging), covering:
- double `payOrder` / double `confirmPayment`;
- concurrent consumption and cancellation;
- consumption failure and release;
- `clear-orders` race with a live consumption.

**Closure evidence:** Recorded pass/fail output from a disposable replica set, with no production data.

---

## R-03 — `clear-orders` is not V2-aware

**Evidence:** VERIFIED. The route is explicitly V1-only. It does not call the V2 ownership guard (`evaluateClearOrdersSafety`, `assertClearOrdersV2Safe`) that exists in `lib/inventory-v2/server/ownership.js`. The V2 tests document `clear-orders` as a `GLOBAL`/`CRITICAL` reserved-stock writer.

**Impact:** If Inventory V2 ever writes holds to `InventoryItem.reservedStock` in the same database, this route could zero V2 holds. That would corrupt V2 ownership and stock.

**Why deferred:** V2 runtime integration is explicitly out of scope for Phase 2.2. Wiring a V2 guard without approved ownership semantics would violate the phase boundary.

**Owner decision required:** Before V2 activation, either:
- disable `clear-orders` in V2 environments and provide a V2-aware procedure; or
- wire the existing ownership guard and refuse when any V2 hold/ownership is detected.

**Closure evidence:** A V2-ownership test proving the route refuses V2 holds and unknown ownership, plus a release gate that blocks V2 activation until it passes.

---

## R-04 — `clear-orders` lacks dual control, export, and a UI caller

**Evidence:** VERIFIED. No UI caller exists (repository grep); only `lib/policy.js` and tests reference `settings:clearOrders`. Phase 2.2 added a preview and a confirmation token but no second approver, no pre-reset export, and no scheduled maintenance lock.

**Impact:** A single Manager with a valid session and own PIN can still destroy non-PAID order history and V1 reservation holds. There is no built-in snapshot to restore from.

**Why deferred:** Dual control and export are product/operational decisions; adding an export path or a second-approver model would change the workflow and may require storage decisions.

**Owner decision required:** Define whether `clear-orders` is:
- a development-only tool (recommended: remove from production builds/routes), or
- a controlled production operation requiring dual approval, a verified backup, and a pre-reset export.

**Closure evidence:** Documented runbook + UI/CLI gating + a restore drill. Until then, keep it inaccessible in production.

---

## R-05 — `scripts/clean-order-history.js` is a second, unhardened destructive path

**Evidence:** VERIFIED. The CommonJS script deletes all orders, resets `order_seq`, and clears `SystemAuth.activeWaiters`. It has a `DRY_RUN=1` preview but **no production refusal, no confirmation token, no PAID/ARCHIVED preservation, and no CONSUMING check**.

**Impact:** This bypasses every Phase 2.2 `clear-orders` guard. Running it against production can delete financial evidence and corrupt reservations.

**Why deferred:** It is a manual operator script, not a runtime endpoint. Hardening it was not required to close the verified endpoint finding, and changing its behavior merits its own review.

**Owner decision required:** Retire the script, or harden it to the same contract as the endpoint (production refusal, confirmation, PAID/CONSUMING refusal, evidence preservation).

**Closure evidence:** Script removed from the repo or covered by the same safety tests and runbook.

---

## R-06 — Manager PIN change keeps step-up optional

**Evidence:** VERIFIED. `app/api/manager/staff/route.js` verifies `currentManagerPin` only when supplied. The Manager UI sends it only if the field is non-empty (`if (cur) body.currentManagerPin = cur` in `app/components/StaffManagement.jsx`).

**Impact:** A stolen Manager session could change a PIN without knowing the current Manager PIN. `clear-orders` does require step-up; ordinary PIN changes do not.

**Why deferred:** Making step-up mandatory would break the existing UI flow and was not part of the narrow security correction set. The UI change is a product decision.

**Owner decision required:** Make step-up mandatory for every Manager-initiated PIN change (and update the UI), or accept session-only authorization for this action.

**Closure evidence:** UI + route + test proving a missing/wrong `currentManagerPin` is rejected.

---

## R-07 — Deploying default-PIN rejection can lock out existing accounts

**Evidence:** VERIFIED by design. In production, `1111/2222/3333/4444/5555` are rejected even if a `Staff.pinHash` matches.

**Impact:** Any production account still using a seeded default cannot sign in after deployment. This is intentional security behavior, but it is an operational breaking change if PINs are not rotated first.

**Owner decision required:** Before deployment:
1. Inventory every Staff account whose PIN is a known default.
2. Rotate each PIN through an authorized flow (or operator-assisted reset).
3. Confirm the first Manager exists and can sign in.

**Closure evidence:** Pre-deployment checklist signed off, plus a post-deploy smoke test for each role.

**Note:** No production credential was inspected in this phase; the count of affected accounts is UNVERIFIED.

---

## R-08 — Index deployment approval detection is heuristic

**Evidence:** VERIFIED. `scripts/sync-indexes.js` treats the environment as production when any of `NODE_ENV`, `VERCEL_ENV`, `CONTEXT`, `DEPLOY_ENV`, `ENVIRONMENT`, `APP_ENV` is `production|prod|live`. If a platform sets none of these, the script will not require `--allow-production` or `POS_INDEX_DEPLOY_APPROVAL`.

**Impact:** An operator could run the additive command against a production URI without the approval gate. The command still never drops indexes, so the blast radius is limited to creating missing indexes.

**Why deferred:** Requiring `--allow-production` unconditionally would break the normal developer workflow; the correct fix belongs in the deployment pipeline.

**Owner decision required:** Make the release pipeline always pass `--allow-production` and set `POS_INDEX_DEPLOY_APPROVAL`, or invert the default (production assumed unless `--development`).

**Closure evidence:** Pipeline config showing the approval variable is mandatory for production deployments.

---

## R-09 — No duplicate preflight or live index inspection

**Evidence:** DEFERRED. The additive `createIndexes()` call can fail if an existing collection has duplicate values for a new unique index. Phase 2.2 reports the failure (non-zero exit) but does not preflight duplicates, list existing indexes, or compare the desired set.

**Impact:** A release may stop on an index conflict; existing indexes remain untouched, but the operator must inspect manually.

**Required action:** Before the first production run:
1. List existing indexes per collection.
2. Run duplicate-value preflight for every unique index.
3. Run the script against staging first.
4. Record the before/after index list.

**Closure evidence:** Staging run output and an index inventory diff.

---

## R-10 — Rate limiting is in-memory and per process

**Evidence:** VERIFIED. `lib/rateLimit.js` stores counters on `globalThis`. It is not distributed.

**Impact:** Multi-instance/serverless deployments get per-instance limits; an attacker can spread attempts across instances. The comment already acknowledges the Redis swap.

**Why deferred:** No hosting topology was confirmed; adding Redis is an infrastructure dependency.

**Owner decision required:** Confirm single-instance deployment (accept), or provision a shared limiter (Redis/KV) and swap the implementation behind the existing API.

---

## R-11 — Backup, restore, alerting, and retention are unproven

**Evidence:** UNVERIFIED. No repository evidence of provider backups, restore drills, alert routing, on-call ownership, or retention schedules.

**Impact:** A destructive action or database failure could cause unrecoverable loss. The health endpoint and structured logs are only inputs; they do not provide protection.

**Required owner actions:**
1. Enable provider backups and point-in-time recovery where available.
2. Perform and record a restore drill.
3. Configure alerts for the Phase 2.2 events and route them to an owner.
4. Define retention for orders, reservations, and stock movements (finance/audit input required).
5. Define who may run `clear-orders` or any destructive script.

**Closure evidence:** A signed runbook with dates, restore test output, and configured alert destinations.

---

## R-12 — Legacy `SystemAuth` model/scripts still exist

**Evidence:** VERIFIED. `lib/models/SystemAuth.js` remains; `scripts/seed-auth.js` and `scripts/reset-auth.js` remain, now refusing production and printing no PINs. `SystemAuth` is not a runtime authority.

**Impact:** Residual confusion and a development-only path that could be misused if `NODE_ENV` is misconfigured. No production login depends on it.

**Why deferred:** Removing the model/scripts is a cleanup step that requires migration evidence and is outside the narrow security fix.

**Owner decision required:** Schedule removal after confirming no operational script depends on `system_auth`.

---

## R-13 — Health endpoint is public by design

**Evidence:** VERIFIED. `GET /api/health` is unauthenticated and returns only `service`, `status`, `checks.database`, `uptimeSeconds`, and `timestamp`.

**Impact:** It reveals service liveness and coarse DB readiness. It does not expose hosts, URIs, errors, or versions. Some operators prefer to restrict even this.

**Owner decision required:** Accept public liveness/readiness, or restrict at the edge/monitoring network. If restricted, update the uptime monitor accordingly.

---

## R-14 — First-Manager provisioning needs operator database access

**Evidence:** VERIFIED. `scripts/pos-provision-manager.mjs` requires `MONGODB_URI` and `--confirm`, and either `POS_PROVISION_MANAGER_PIN` or a hidden TTY prompt.

**Impact:** Bootstrapping a virgin production database requires a trusted operator with DB access and a secure channel for the PIN. The script refuses if a MANAGER already exists, so it cannot add later Managers.

**Owner decision required:** Define who runs it, how `POS_PROVISION_MANAGER_PIN` is injected (secret manager, not shell history), and the procedure for adding additional Managers.

---

## Explicitly out of scope (not started)

- Inventory V2 runtime integration.
- `orderVersion` schema implementation.
- `inventoryMode` schema implementation.
- V2 allocation, approval, payment, or stock writes.
- Hotel feature changes.
- Payment state-machine redesign or reversal/refund accounting.
- Database migration, index deployment, seed execution, or production deployment.

---

## Owner sign-off requested

Please decide/confirm:

1. **R-01 / R-02:** Accept alert-driven manual reconciliation for now, or approve a Phase 2.3 outbox/transaction design?
2. **R-03:** Confirm `clear-orders` will be disabled before any V2 activation and that V2 guard wiring is a required V2 gate.
3. **R-04 / R-05:** Retire or harden `clear-orders` and `scripts/clean-order-history.js`; define dual control/export.
4. **R-06:** Mandatory Manager step-up for PIN changes — yes or no?
5. **R-07:** Approve the pre-deployment PIN rotation plan.
6. **R-08 / R-09:** Approve the index deployment pipeline approval variable and staging inspection.
7. **R-10 / R-11:** Confirm rate-limit topology and provide backup/restore/alert evidence.
8. **R-13 / R-14:** Accept the public health endpoint and document the provisioning runbook.

No deployment should occur until items 1–8 are resolved or explicitly accepted as residual risk.
