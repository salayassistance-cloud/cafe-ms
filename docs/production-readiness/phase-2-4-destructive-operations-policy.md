# Phase 2.4 — Destructive Operations Policy

Status: **READ-ONLY POLICY PROPOSAL — NOT IMPLEMENTED, NOT APPROVED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Decision: **C** — destructive administration
Companions: `phase-2-4-owner-decisions.md`, `phase-2-4-recovery-readiness.md`

> No destructive script or endpoint was executed. No historical record was modified. No database was contacted. No code, schema, index, or environment variable was changed. Counts and behaviour below are from source inspection and the Phase 2.2/2.3 reports.

Evidence labels:

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in current source, tests, or git state. |
| **REAL-TESTED** | Exercised against the Phase 2.3 disposable replica set. |
| **INFERRED** | A logical consequence of verified code, not separately exercised. |
| **UNVERIFIED** | Requires staging/production/owner input. |
| **OWNER DECISION** | Requires an explicit business/operations decision. |

---

## 1. Purpose

Phase 2.2 hardened the `clear-orders` endpoint and Phase 2.3 documented its residual race. A second destructive path, `scripts/clean-order-history.js`, remains unhardened. Other reset operations exist outside the financial path but still require an explicit production policy.

This document:

1. inventories every deletion/reset operation found in the repository;
2. states the current behaviour with source evidence;
3. identifies the financial, inventory, station, and audit dependencies;
4. proposes a production policy for each operation;
5. defines the approval, preview, confirmation, backup, audit, and retention requirements;
6. explicitly forbids execution in this phase.

**No operation below is approved for production use by this document.**

---

## 2. Destructive-operation inventory

### 2.1 Financial / order history

| ID | Operation | Entry point | Authorization | Destructive effect | Evidence |
|---|---|---|---|---|---|
| **C-1** | `clear-orders` reset | `POST /api/manager/settings/clear-orders` | MANAGER session + requesting manager's own Staff PIN + `confirm: "CLEAR-ORDERS"` (or `dryRun`) | Deletes non-PAID/non-ARCHIVED orders; deletes non-CONSUMED/non-CONSUMING reservations; zeroes all positive `reservedStock`; conditionally resets the order counter | `app/api/manager/settings/clear-orders/route.js` |
| **C-2** | `clean-order-history.js` | `node scripts/clean-order-history.js` | `MONGODB_URI` only; `DRY_RUN=1` optional; no role/PIN/token | Deletes **all** orders; resets order counters; clears `SystemAuth.activeWaiters` | `scripts/clean-order-history.js` |
| **C-3** | Order cancel / archive | `PATCH /api/orders/[id]`, status route | Manager (cancel); Kitchen/Barista/Hot Drink/Manager (archive) | State transition only; evidence retained; does not delete | `lib/orderService.js`; `lib/policy.js` |
| **C-4** | Item cancel | `PATCH /api/orders/[id]` item action | Kitchen/Barista/Hot Drink/Manager | State transition only; evidence retained; may trigger inventory void/reconcile | `lib/orderService.js`; `lib/inventoryReservationService.js` |

### 2.2 Catalog / payment account

| ID | Operation | Entry point | Authorization | Destructive effect | Evidence |
|---|---|---|---|---|---|
| **C-5** | Delete payment account | `DELETE /api/payment-info?id=...` | MANAGER | If the account was used by an order, archives it (`isActive:false`); otherwise hard-deletes it. No step-up PIN; no durable audit. | `app/api/payment-info/route.js` |
| **C-6** | Delete menu category (cascade) | `app/manager/menu-crud/actions.js` | Manager server action | Deletes menu items in the category, then the category; does not touch historical orders | `app/manager/menu-crud/actions.js` |
| **C-7** | Delete menu item | `app/manager/menu-crud/actions.js` | Manager server action | Deletes a menu item; historical order snapshots remain | same |

### 2.3 Auth / credentials

| ID | Operation | Entry point | Authorization | Destructive effect | Evidence |
|---|---|---|---|---|---|
| **C-8** | Reset legacy auth | `node scripts/reset-auth.js` | `MONGODB_URI`; refuses `NODE_ENV=production` | Restores default `SystemAuth` PINs and clears `activeWaiters`; does not touch orders | `scripts/reset-auth.js` |
| **C-9** | Seed auth | `node scripts/seed-auth.js` | `MONGODB_URI`; idempotent | Creates/updates `SystemAuth`; does not delete orders | `scripts/seed-auth.js` |
| **C-10** | Clear active waiter sessions | Part of C-1? No; part of C-2 and C-8 | see above | Releases device/login slots; affects live sessions | `scripts/clean-order-history.js`, `scripts/reset-auth.js` |
| **C-11** | Hotel payment void | `POST /api/hotel/payments/[id]/void` (Hotel) | `BILLING_MANAGE` + CSRF + Origin | Non-destructive `RECORDED → VOIDED`; no hard delete; no amount/method edit | `lib/hotel/services/payments.js`, `lib/hotel/http/paymentHandlers.js` |

### 2.4 Test / utility scripts

| ID | Operation | Entry point | Risk |
|---|---|---|---|
| **C-12** | `scripts/test-phase65-security.js` | manual | Deletes orders with `orderNumber` in `["TEST-W1","TEST-W2"]`; must never run against production |
| **C-13** | `scripts/test-h74-get.mjs` | manual | Deletes temporary `InventoryItem`/`InventoryAudit` rows; must never run against production |
| **C-14** | Other `test-*.mjs` scripts | manual | Assume a disposable database; several perform writes/deletes; not production tools |

> C-12–C-14 are development utilities. They are included because they contain delete calls; they are not production operations and must be blocked from production credentials/network access.

---

## 3. Current `clear-orders` behaviour (C-1)

### 3.1 Authorization and preflight

**VERIFIED** from `app/api/manager/settings/clear-orders/route.js`:

1. `requireAuth(request, ["MANAGER"])`.
2. Rate limit `MANAGER`; payload capped at 5 KB.
3. `currentManagerPin` must be a valid 4-digit PIN.
4. `dryRun: true` (or `preview: true`) returns a preview without mutation.
5. Non-dry-run requires the literal token `CLEAR-ORDERS` (case-insensitive after trim).
6. The PIN is verified against the requesting manager's own `Staff` record (`verifyStaffPinById`); a shared role PIN cannot pass.
7. Counts: total orders, PAID, ARCHIVED, total reservations, CONSUMING reservations, items with `reservedStock > 0`, preserved reservations (`CONSUMED`, `CONSUMING`).
8. Preview reports `blockedReasons`: `PAID_ORDERS_PRESENT`, `INVENTORY_CONSUMPTION_IN_FLIGHT`.

### 3.2 Execution

**VERIFIED**:

1. Refuses with `409 CLEAR_ORDERS_PAID_EVIDENCE_PRESENT` if any PAID order exists.
2. Refuses with `409 CLEAR_ORDERS_V1_CONSUMPTION_IN_FLIGHT` if any reservation is `CONSUMING`.
3. `Order.deleteMany({ status: { $nin: ["PAID", "ARCHIVED"] } })`.
4. `Reservation.deleteMany({ status: { $nin: ["CONSUMED", "CONSUMING"] } })`.
5. `InventoryItem.updateMany({ reservedStock: { $gt: 0 } }, { $set: { reservedStock: 0 } })`.
6. Resets `counters["order_seq"].seq = 0` only if `Order.countDocuments({}) === 0`.
7. Emits `logEvent("warn", "clear_orders_executed", { managerStaffId, clearedOrders, clearedReservations, preservedOrders, counterReset })`.
8. Returns counts; no export, no second approver, no transaction.

### 3.3 What is preserved

- PAID and ARCHIVED orders.
- CONSUMED and CONSUMING reservations.
- `StockMovement` (never touched).
- Order counter when orders remain.

### 3.4 What is destroyed

- PENDING / PREPARING / READY / SERVED / PAYMENT_PENDING / CANCELLED orders (all non-PAID/non-ARCHIVED).
- RESERVED / APPROVAL_REQUIRED / APPROVED / NO_INVENTORY / RELEASED reservations.
- All positive `reservedStock` (globally zeroed).

### 3.5 Residual race (VERIFIED / INFERRED)

The preflight counts `CONSUMING` reservations, then the delete/zero-hold writes run without a transaction or lock. A reservation can transition to `CONSUMING` between the count and the `reservedStock` reset. In that window:

- The reservation is preserved by the delete filter (it is `CONSUMING` or becomes so), but its hold may already be zeroed.
- A live consumption may then decrement stock/claim `CONSUMING` while the global hold reset runs.

Phase 2.3 documented this as a residual risk. The route is operator-only and has no in-repo UI caller (**VERIFIED**).

### 3.6 Audit gap

The only record is a structured log line. There is no durable POS audit collection, no before/after export, and no second approver. **VERIFIED.**

---

## 4. Current `clean-order-history.js` behaviour (C-2)

**VERIFIED** from `scripts/clean-order-history.js`:

1. Requires `MONGODB_URI`; optional `DRY_RUN=1`.
2. Connects directly with Mongoose; no environment guard (unlike `reset-auth.js`).
3. `Order.deleteMany({})` — deletes **every** order, including PAID.
4. Resets `counters["order_seq"].seq = 0` and legacy counter ids.
5. `SystemAuth.updateOne({ _id: "system" }, { $set: { activeWaiters: [] } })`.
6. Does **not** delete or release `InventoryReservation` rows.
7. Does **not** zero `InventoryItem.reservedStock`.
8. Does **not** preserve PAID/ARCHIVED evidence.
9. Does **not** write an audit record.
10. Is not transactional.

**Impact:** running it bypasses every Phase 2.2/2.3 guard, deletes financial evidence, leaves reservation/hold state inconsistent, and releases live waiter sessions. It must not be run against any environment containing financial data.

---

## 5. Dependencies and invariants

| Dependency | Effect of an unsafe reset | Required protection |
|---|---|---|
| **PAID orders** | Financial evidence lost; revenue/report reconciliation impossible | Preserve; refuse reset while PAID exists |
| **ARCHIVED orders** | Historical reporting lost | Preserve |
| **InventoryReservation** | Per-order consumption evidence lost; hold accounting broken | Preserve CONSUMED/CONSUMING; delete only non-evidence states after release |
| **InventoryItem.reservedStock** | Hold leak or live-hold zeroing; sellable stock wrong | Conditional, reservation-derived correction; never global zeroing |
| **StockMovement** | Audit/ledger evidence lost | Never delete |
| **Counters** | Duplicate/reused ORD numbers | Reset only when the orders collection is empty and no historical order exists |
| **SystemAuth.activeWaiters** | Live waiter sessions released | Treat as a separate operational action with notice |
| **PaymentInfo** | Transfer payment account disappears; historical snapshot remains | Archive if used; hard-delete only unused accounts |
| **HotelPayment** | Record-only; no hard delete; void is non-destructive | Do not apply POS reset policy to Hotel |
| **Recovery tasks (proposed)** | A reset could delete evidence a recovery task needs | Refuse while an open recovery task exists |
| **V2 allocations (future)** | A global `reservedStock` zero could corrupt V2 holds | Refuse while any V2 hold exists; V2 is not wired today |

---

## 6. Production policy per operation

### 6.1 C-1 — `clear-orders`

**Policy: DISABLED IN PRODUCTION BY DEFAULT.**

| Control | Requirement |
|---|---|
| Environment | Production execution requires an explicit `POS_ALLOW_DESTRUCTIVE_ADMIN=1`-style gate (name to be approved) plus a change ticket. Default is disabled. |
| Authorization | MANAGER session + requesting manager's own Staff PIN (current). |
| Dual control | A second named approver (owner/operations) must approve the exact preview and ticket. The executor cannot self-approve. |
| Preview | `dryRun: true` is mandatory immediately before execution; the preview counts are attached to the ticket. |
| Confirmation | Literal `CLEAR-ORDERS` (current) plus the ticket id. |
| Preflight | Refuse if any PAID or ARCHIVED order exists, any `CONSUMING` reservation exists, any open recovery task exists, or any V2 hold exists. |
| Backup/export | A verified database backup and a pre-reset export of orders/reservations/counters must exist before execution. The export reference is recorded. |
| Transaction/lock | Either make the reset transactional/locked, or keep it disabled. The residual CONSUMING race is not acceptable for production. |
| Maintenance window | Required; no concurrent order/payment/station activity. |
| Audit | Durable record: actor, approver, ticket, preview counts, export/backup reference, filters, before/after counts, result. |
| Retention | Export/audit retained per the approved financial retention policy. |
| Notification | Inform staff before and after; release/restore waiter sessions deliberately if C-2-like cleanup is needed. |

**Recommendation:** keep the endpoint for non-production/testing only until the transactional/V2-aware version is approved. In production, use an approved archive/retention procedure instead.

### 6.2 C-2 — `scripts/clean-order-history.js`

**Policy: RETIRE. DO NOT RUN.**

| Control | Requirement |
|---|---|
| Status | Remove from operational use; delete the script or replace it with a guarded, dry-run, export-first, evidence-preserving command. |
| Production guard | If retained, it must refuse `NODE_ENV=production` and require an explicit disposable-target acknowledgement, like the integration harness. |
| PAID evidence | Must never delete PAID/ARCHIVED orders. |
| Reservations/holds | Must not leave orphan reservations or zero holds blindly. |
| `activeWaiters` | Must be a separate, explicit operational action, not a side effect of order cleanup. |
| Audit | Must record actor, target, counts, export reference, and result. |
| Approval | Owner + operations; change ticket; maintenance window; backup/export. |

**Recommendation:** retire it. It duplicates a destructive capability with none of the endpoint guards and is the highest-risk script in the repository.

### 6.3 C-3 / C-4 — order cancel / archive / item cancel

**Policy: ALLOWED; these are state transitions, not deletions.**

- Preserve the order row.
- Preserve PAID evidence (atomic terminal guards, Phase 2.3).
- Preserve inventory evidence; post-preparation void reclassifies, never restores stock.
- Require the existing role and reason.
- No change proposed.

### 6.4 C-5 — payment account deletion

**Policy: ARCHIVE-ONLY WHEN REFERENCED; STEP-UP + AUDIT.**

| Control | Requirement |
|---|---|
| Referenced account | Never hard-delete; set `isActive:false` (current behaviour). |
| Unused account | Hard delete allowed only with Manager step-up and a durable audit record. |
| Historical orders | Keep `paymentAccountSnapshot`; do not rewrite. |
| Audit | Record actor, account id, used/archived/deleted, reason, timestamp. |
| Production | Allowed for unused accounts; otherwise archive. |

### 6.5 C-6 / C-7 — catalog deletion

**Policy: ALLOWED, with historical preservation.**

- Never rewrite historical order items.
- Deleting a category may cascade to menu items; require a preview and confirmation.
- No financial evidence is deleted.
- Audit the actor and affected counts.

### 6.6 C-8 / C-9 — auth reset/seed

**Policy: NON-PRODUCTION ONLY; PRODUCTION USES THE STAFF PIN RESET FLOW.**

- `reset-auth.js` already refuses `NODE_ENV=production` (**VERIFIED**).
- It restores default PINs; this is a security risk if run outside a controlled setup.
- It clears `activeWaiters`; notify staff.
- It does not touch orders; it is out of the financial destructive scope.
- `seed-auth.js` is idempotent; it must not overwrite live credentials without approval.

### 6.7 C-11 — Hotel payment void

**Policy: ALLOWED; non-destructive.**

- `RECORDED → VOIDED` only; no hard delete; no amount/method edit.
- `BILLING_MANAGE` + CSRF + Origin.
- Audit to `hotel_audit_logs`.
- Do not apply POS order-reset policy to Hotel.

### 6.8 C-12–C-14 — test/utility scripts

**Policy: DISPOSABLE DATABASES ONLY.**

- Never run with production credentials or production network access.
- Use an explicit target acknowledgement and a database-name prefix guard, as the Phase 2.3 integration harness does.
- Do not treat them as operational tools.

---

## 7. Environment protection

| Requirement | Proposed mechanism |
|---|---|
| Production default | Destructive admin disabled unless an explicit environment flag is set **and** a change ticket is present. |
| Environment marker | Fail closed if `NODE_ENV`/`DEPLOY_ENV`/`VERCEL_ENV` is unrecognized. |
| Target guard | Refuse a database name that is not the expected environment; never print the URI. |
| Approval reference | Non-empty ticket/approval env var, checked but never printed (same pattern as index deployment). |
| Network | Destructive scripts run only from an approved operator host, not from a public route. |
| Kill switch | A single flag disables all destructive admin operations. |

**VERIFIED pattern:** the index deployment scripts already implement `--confirm`, `--allow-production`, and a non-empty approval env var. The destructive policy should reuse that pattern; it is not implemented for `clear-orders` or `clean-order-history.js` today.

---

## 8. Preview and confirmation

| Operation | Preview | Confirmation | Notes |
|---|---|---|---|
| C-1 `clear-orders` | `dryRun: true` returns counts and `blockedReasons` | `confirm: "CLEAR-ORDERS"` | Current. Add ticket id and export reference. |
| C-2 script | `DRY_RUN=1` | None | Insufficient; add an explicit target acknowledgement and a confirmation token. |
| C-5 payment account | Show referenced/unused status | Explicit `confirm` | Add step-up + audit. |
| C-6/C-7 catalog | Show cascade counts | Explicit `confirm` | Add preview if absent. |

A preview is not a substitute for a backup. A confirmation token is not a substitute for dual control.

---

## 9. Evidence preservation rules

1. **PAID and ARCHIVED orders are financial evidence.** Never delete.
2. **CONSUMED and CONSUMING reservations are inventory evidence.** Never delete. A `CONSUMING` reservation is also an in-flight operation; refuse while any exist.
3. **`StockMovement` is append-only.** Never delete, never rewrite.
4. **`InventoryAudit` is append-only.** Never delete.
5. **HotelPayment is non-deletable.** Void only.
6. **Historical order items are snapshots.** Catalog deletion must not rewrite them.
7. **Payment account snapshots on orders are immutable.** Deleting/archiving the account must not rewrite the snapshot.
8. **Order numbers are never reused.** Reset the counter only when no historical order remains.
9. **Recovery evidence (proposed) is immutable.** A reset must refuse while an open recovery task exists.

---

## 10. Audit trail and retention

### 10.1 Current state

- `clear-orders` emits one structured log line.
- `clean-order-history.js` emits console messages only.
- `payment-info` deletion emits no durable audit.
- There is **no durable POS audit collection** for destructive admin actions. **VERIFIED.**
- Hotel has `hotel_audit_logs`; POS does not have an equivalent.

### 10.2 Required audit record

| Field | Purpose |
|---|---|
| `operation` | `clear-orders`, `clean-order-history`, `payment-info-delete`, etc. |
| `actorId` / role | Who executed |
| `approverId` / role | Who approved (second control) |
| `ticketId` | Change/approval reference |
| `target` | Environment/database, redacted |
| `preview` | Counts and blocked reasons |
| `filters` | Exact filters used |
| `before` / `after` | Counts, holds, counter state |
| `backupRef` / `exportRef` | Verified backup/export |
| `result` | Success/failure/partial |
| `timestamps` | Start/end |
| `notes` | Reason |

The audit record must be append-only and access-controlled. Retention must be set by the owner/finance; no statutory period is asserted here.

### 10.3 Historical data retention

- Orders, reservations, stock movements, inventory audits, and Hotel payments are historical records.
- No retention job exists.
- Any future archive/retention policy must be additive, export-first, and preserve the ability to reconcile payments and stock.
- Deleting history to “clean up” is not an acceptable substitute for archiving.

---

## 11. Backup and restore requirements

Before any destructive execution:

1. A verified backup exists and its restore path is known.
2. A logical export of the affected collections exists (orders, reservations, counters, inventory items, stock movements, relevant settings).
3. The export is stored outside the target database and access-controlled.
4. A restore drill has passed for the backup mechanism.
5. The restore preserves unique indexes (reservation `orderId`, stock movement identities).
6. After a restore, reconciliation runs before accepting writes.

**VERIFIED absence:** no backup/PITR/restore evidence exists in the repository. This is a production blocker for destructive operations.

---

## 12. Required tests

### 12.1 `clear-orders`

1. Non-MANAGER is rejected.
2. Wrong/absent PIN is rejected.
3. Missing confirmation token is rejected; `dryRun` succeeds without mutation.
4. PAID evidence refusal; no deletion occurs.
5. CONSUMING refusal; no hold reset occurs.
6. Delete filter never removes PAID/ARCHIVED orders or CONSUMED/CONSUMING reservations.
7. `StockMovement` count is unchanged.
8. Counter reset only when the orders collection is empty.
9. The residual CONSUMING race is either prevented or the operation is disabled in production.
10. Audit record exists with actor/approver/ticket/export reference.

### 12.2 `clean-order-history.js`

1. Source test: no unconditional `Order.deleteMany({})` remains if retained.
2. Production guard refuses.
3. PAID/ARCHIVED evidence is preserved.
4. Reservation/hold consistency is preserved.
5. `activeWaiters` is not an implicit side effect.
6. Export/audit exists.

### 12.3 Payment account / catalog

1. Referenced account is archived, not deleted.
2. Unused account deletion requires step-up + audit.
3. Catalog cascade preview/confirmation.
4. Historical order snapshots unchanged.

### 12.4 Cross-cutting

1. Environment marker and approval reference fail closed.
2. URI/credentials are never printed.
3. Restore drill evidence is recorded.
4. Post-restore reconciliation passes.

---

## 13. Owner decisions required

| ID | Decision | Recommendation |
|---|---|---|
| C-1 | Is `clear-orders` disabled in production? | **Yes, by default**, until transactional/locked and V2-aware. |
| C-2 | Retire or harden `clean-order-history.js`? | **Retire.** |
| C-3 | Who approves and who executes a destructive reset? | Owner/operations approves; named operator executes; a second approver verifies. |
| C-4 | What backup/export is mandatory? | Verified backup + logical export + restore drill evidence. |
| C-5 | What audit retention applies? | Owner + finance decision; append-only; no default asserted. |
| C-6 | Is `payment-info` hard delete allowed? | Archive-only when referenced; step-up + audit for unused. |
| C-7 | Is `activeWaiters` cleanup part of order reset? | No; separate operational action with notice. |
| C-8 | What is the V2 guard? | Refuse while any V2 hold exists; prerequisite for V2 activation. |

---

## 14. Production-blocking statement

**Destructive administration is production-blocking.** The repository contains:

- a guarded but non-transactional reset with a residual CONSUMING race;
- an unhardened script that deletes all orders;
- no durable POS audit trail for destructive actions;
- no backup/restore evidence.

No production reset may be performed until the owner approves this policy, the backup/export/restore requirements are met, and the unhardened script is retired.

**No destructive operation was executed in this phase.**
