# BONO POS / Hotel - Phase 2.1 Owner Decision Matrix

**Status:** READ-ONLY REVIEW - awaiting owner approval
**Date:** 2026-11-07
**Branch:** `main`
**HEAD:** `69650435a6587d4577bc126f719fa1392bb934b3`
**Working tree at review start:** 105 dirty/untracked entries
**Implementation authorization:** None. No code, schema, route, dependency, database, or deployment change was made in this phase.

---

## 1. Purpose and method

This document resolves, for owner approval, the ten decisions left open by Inventory V2 Phase 2.0. It does not make those decisions. Each record contains the eight fields required by the Phase 2.1 brief:

1. Existing implementation and evidence
2. Risk if left unresolved
3. Available options
4. Recommended option and rationale
5. Migration and compatibility impact
6. Required tests
7. Required owner approval
8. Whether it blocks production

Evidence was gathered by reading source, tests, and documentation only. No database was contacted and no `.env`/`.env.local` value was read.

### Evidence labels

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in source, tests, git state, or project documentation. |
| **INFERRED** | Reasoned from verified facts; not directly executed or observed. |
| **UNVERIFIED** | Not established. Requires a disposable environment, live topology, or an independent reviewer. |

### Baseline test evidence

| Check | Result | Label |
|---|---|---|
| Full DB-free suite (`node --test <64 explicit tests/*.test.mjs files>`) | **1291 tests, 223 suites, 1291 pass, 0 fail, 0 skipped** (54.1s) | VERIFIED |
| Phase 2.0 suite (`tests/inventory-v2-phase2.test.mjs`) | 50 pass, 0 fail (recorded in `docs/inventory-v2-phase2-foundations.md`) | VERIFIED |
| Phase 1 suite (`tests/inventory-v2-phase1.test.mjs`) | 154 pass, 0 fail (recorded) | VERIFIED |
| Real MongoDB replica-set transaction test | Not run | UNVERIFIED |
| Production build / deploy | Not run in this phase | UNVERIFIED |

---

## 2. Decision summary

| # | Decision | Recommendation | Blocks V1 production? | Blocks V2 activation? | Owner approval required |
|---|---|---|---|---|---|
| D1 | Adopt `server-only` package | Adopt in Phase 2.2 before V2 route wiring | No | **Yes** | Engineering owner + release manager |
| D2 | V2 index plan and guarded deployment | Approve plan; staged deployment with change ticket | No | **Yes** | Owner + DBA/operations |
| D3 | MongoDB topology and transaction budget | Require replica set or mongos; formal budget | **Yes** (V1 inventory uses transactions) | **Yes** | Owner + infrastructure |
| D4 | `inventoryreservations` migration vs retention | Retain as immutable history; archive later | No | No (Yes before V1 decommission) | Owner + finance/audit |
| D5 | Drain existing V1 holds | Maintenance-window drain with reconciliation | No | **Yes** | Owner + operations |
| D6 | Cross-owner `reservedStock` reconciliation | Read-only report first, guarded repair second | No | **Yes** | Owner + finance |
| D7 | `inventoryMode` storage and assignment | Server-assigned, immutable, default `V1` | No | **Yes** | Owner + architecture |
| D8 | V2-aware `clear-orders` | Guard/refuse while V2 holds exist; never zero V2 stock | No (if controlled) | **Yes** | Owner + operations |
| D9 | V1/V2 dual-read duration and cutover | Dual-read window with parity gate; owner sign-off | No | **Yes** (final cutover) | Owner + finance |
| D10 | Payment/inventory integration + independent audit | No integration before prerequisites and audit | No | **Yes** | Owner + finance + independent auditor |

**Reading the table:** "Blocks V1 production" means the item must be closed before the current POS/Hotel release can be called production-ready. "Blocks V2 activation" means it must be closed before any V2 code path is wired to live routes. D3 is the only decision that blocks the current V1 release because V1 inventory deduction and waste already use multi-document transactions.

---

## 3. Decision records

### D1 - Adopt the `server-only` package?

**Recommendation: ADOPT in Phase 2.2, before any V2 route wiring. Not required for the current V1 release.**

| Field | Assessment |
|---|---|
| **1. Existing implementation and evidence** | `lib/inventory-v2/server/boundary.js:3-13` states explicitly that the `server-only` package is not installed and that the runtime guard is the current enforcement. `package.json` contains no `server-only` dependency, and `node_modules/server-only` does not exist (VERIFIED). `assertServerOnly()` throws at module evaluation time if a server module is evaluated in a client context (`boundary.js:32`). No `app/` or non-V2 `lib/` module imports `lib/inventory-v2/` (VERIFIED in Phase 2.0; unchanged). |
| **2. Risk if unresolved** | The current guard is runtime-only. A bundler could strip or transform the check, and a future accidental client import would not fail at build time. Without the package, the boundary depends on review discipline rather than a build-time error. |
| **3. Available options** | **A.** Add `server-only` and import it in every V2 server module. **B.** Keep the runtime guard and add an ESLint import rule. **C.** Do nothing until V2 is wired. |
| **4. Recommendation and rationale** | **A plus B.** The package gives a build-time failure for the exact mistake that matters (server code in a client bundle), is small, has no runtime cost in server bundles, and is the standard Next.js boundary mechanism. Keep the runtime guard as defense in depth. Schedule it as the first task of Phase 2.2 so it is in place before V2 is imported by any route. |
| **5. Migration and compatibility impact** | Add one dependency and lockfile entry; add `import "server-only"` to `lib/inventory-v2/server/*` and any future server-only V2 module. No database, schema, API, or client behavior change. Verify compatibility with Next 16.3.1 and the existing ESLint config. |
| **6. Required tests** | Production build succeeds; a client-component test importing a V2 server module fails at build/test time; server imports still work; ESLint remains clean; `npm ls server-only` resolves a single version. |
| **7. Required owner approval** | Engineering owner approves the dependency and version pin; release manager confirms it lands before V2 route wiring. |
| **8. Production blocking?** | **No for V1** (V2 is not wired). **Yes for V2 activation.** |

---

### D2 - Approval process for the V2 index plan and guarded deployment

**Recommendation: APPROVE the plan as written; deploy in stages (disposable -> staging -> production) under a change ticket. Never use `syncIndexes` for V2.**

| Field | Assessment |
|---|---|
| **1. Existing implementation and evidence** | `lib/inventory-v2/server/indexPlan.js` defines seven collections and classifies every index as `CORRECTNESS_CRITICAL_UNIQUE`, `QUERY_PERFORMANCE_ONLY`, or `CLEANUP_ONLY` (VERIFIED). The challenge collection has exactly one correctness-critical unique index, `{ challengeId: 1 }`; a global unique `{ approvalGroupId: 1, stage: 1 }` on challenges is explicitly forbidden. Successful-approval uniqueness lives only in `inventory_v2_approvals` via `{ approvalGroupId: 1, stage: 1 }` (VERIFIED). `scripts/inventory-v2-deploy-indexes.mjs` requires `--confirm`, requires `--allow-production` plus a non-empty `INVENTORY_V2_INDEX_DEPLOY_APPROVAL` when production markers are set, calls `createIndexes()` only, refuses on unexpected or mismatched indexes, and never prints the URI, credentials, or approval value (VERIFIED). The script was **never executed** (VERIFIED from its own header and Phase 2.0 record). In contrast, `lib/mongodb.js:53-71,149` runs background `syncIndexes()` for Order, Staff, Category, MenuItem, and InventoryAudit on connection; that path can create and drop indexes outside any approval gate (VERIFIED code; production impact INFERRED). |
| **2. Risk if unresolved** | Deploying without approval can create or drop indexes on the wrong database, fail on duplicate data, or silently diverge from the plan. Letting `syncIndexes` run against V2 collections would defeat the plan's explicit uniqueness rules. A failed unique-index build can leave a collection partially indexed and block writes. |
| **3. Available options** | **A.** Approve the plan and staged script as-is. **B.** Change the plan before deployment. **C.** Defer all V2 index work. **D.** Use application `syncIndexes` (rejected: violates the Phase 2.0 contract). |
| **4. Recommendation and rationale** | **A, with a mandatory preflight.** Approve the plan because its uniqueness rules match the Phase 2.0 safety contract. Deploy first to a disposable database, then staging, then production. Require a change/ticket reference, a duplicate-data preflight for every unique key, a named operator, and a rollback note that drops only indexes created by this deployment. Keep `syncIndexes` away from V2 collections. |
| **5. Migration and compatibility impact** | Index-only change; no document rewrite. Unique indexes can fail if pre-existing duplicates exist, so the preflight must count duplicates per key. No V1 index is modified by the V2 script. Production deployment must be a separate, explicitly approved operation. |
| **6. Required tests** | Existing plan-validation and CLI-guard tests (50 Phase 2.0 tests) must pass; duplicate-count preflight on a disposable copy; `createIndexes` succeeds on disposable and staging; index list matches the plan exactly; a second run is idempotent; unexpected-index refusal is exercised; rollback drops only new indexes. |
| **7. Required owner approval** | Owner approves the plan and the staged rollout. Operations/DBA approves the target database, window, and change ticket. Production requires `--allow-production` and a non-empty `INVENTORY_V2_INDEX_DEPLOY_APPROVAL`. |
| **8. Production blocking?** | **No for V1.** **Yes for V2 activation.** |

---

### D3 - MongoDB topology and transaction timeout budget

**Recommendation: REQUIRE a replica set or mongos, document the topology, and adopt an explicit transaction budget. This is the only decision that blocks the current V1 release.**

| Field | Assessment |
|---|---|
| **1. Existing implementation and evidence** | V1 already uses multi-document transactions: `lib/inventoryDeductionService.js:258-330` and `lib/inventoryWasteService.js:51-165` start sessions, write `InventoryItem` and `StockMovement` in one transaction, and handle `TransientTransactionError` / `UnknownTransactionCommitResult` (VERIFIED). `lib/inventory-v2/server/transaction.js` defines the V2 contract: bounded retry for transient errors, **no blind retry** for unknown commit, unsupported topology mapped to `TRANSACTIONS_UNAVAILABLE` (503), and session cleanup in `finally` (VERIFIED). `lib/mongodb.js:31-45` sets `bufferCommands: false`, `maxPoolSize: 10`, `serverSelectionTimeoutMS: 3000`, and `socketTimeoutMS: 30000` (VERIFIED). No topology evidence exists in the repository: there is no replica-set member list, no `rs.status()` capture, no staging connection proof, and no transaction-timeout test against a real server (UNVERIFIED). |
| **2. Risk if unresolved** | A standalone MongoDB accepts `startSession()` but rejects the first transactional write, so V1 payment deduction and waste could fail at the worst moment. A transaction that outlives the gateway budget can be reported as failed while still committing, creating an unknown-commit state. An oversized retry budget can turn a transient conflict into a request timeout. |
| **3. Available options** | **A.** Require a replica set or mongos (Atlas replica set is the default) and publish the topology. **B.** Run standalone and remove transactions (rejected: breaks atomic stock + ledger writes). **C.** Run sharded/mongos. |
| **4. Recommendation and rationale** | **A, with C supported as an equivalent topology.** Require documented proof of a replica set or mongos in every environment. Adopt a budget: per-operation `maxTimeMS` bounded, `maxCommitTimeMS` bounded, at most 3 transient attempts with jitter, and a total request budget below the gateway timeout. The code comment in `lib/mongodb.js` targets a 5s gateway; the transaction budget should leave headroom (for example, commit <= 3s and total <= 4s) so the application fails closed before the platform does. |
| **5. Migration and compatibility impact** | No schema change. Connection string and infrastructure only. V1 services already assume transactions; formalizing the budget may require adding `maxTimeMS`/`maxCommitTimeMS` options in a later approved change. No behavior change in this phase. |
| **6. Required tests** | Real replica-set integration test for deduction, waste, and V2 commit; standalone rejection returns the documented 503; forced failover during commit exercises unknown-commit resolution; timeout test proves no blind retry; retry exhaustion returns a stable error; concurrent transactions produce no duplicate `StockMovement` rows. |
| **7. Required owner approval** | Owner approves the topology and budget. Infrastructure approves the cluster tier, failover behavior, and connection limits. |
| **8. Production blocking?** | **Yes for V1 production** because V1 inventory already depends on transactions. **Yes for V2 activation.** |

---

### D4 - `inventoryreservations` migration versus historical retention

**Recommendation: RETAIN `inventoryreservations` as immutable historical/audit data. Do not migrate rows into V2. Archive only under a later approved retention policy.**

| Field | Assessment |
|---|---|
| **1. Existing implementation and evidence** | `lib/inventory-v2/server/ownership.js:10-12` declares V1 orders authoritative in `inventoryreservations` and V2 orders authoritative in `inventory_v2_allocations` (VERIFIED). `lib/models/InventoryReservation.js` documents the V1 lifecycle (`RESERVED`, `APPROVAL_REQUIRED`, `APPROVED`, `CONSUMING`, `CONSUMED`, `RELEASED`) (VERIFIED). `clear-orders` preserves `CONSUMED`/`CONSUMING` reservations as audit evidence and deletes the rest (`app/api/manager/settings/clear-orders/route.js:62-74`) (VERIFIED). No migration script or retention policy exists (VERIFIED absence). |
| **2. Risk if unresolved** | Rewriting V1 rows into V2 risks corrupting historical quantities, approval snapshots, and consumption evidence. Deleting them destroys the only per-order record of what was held, consumed, or voided. Leaving retention undefined means unbounded growth and unclear legal/audit obligations. |
| **3. Available options** | **A.** Retain in place indefinitely. **B.** Retain then archive to cold storage after an approved period. **C.** Migrate rows into V2 allocations. **D.** Delete after a fixed period. |
| **4. Recommendation and rationale** | **A now, then B under an approved policy.** Historical V1 rows are evidence, not live state. They should remain queryable for reconciliation and dispute resolution. Migration (C) creates a second authority and is unsafe. Deletion (D) is only acceptable after a signed retention schedule and a verified archive. |
| **5. Migration and compatibility impact** | No data movement in Phase 2.2. Optional archive job later must be read-only against live data, write to a separate archive, and preserve `orderId`, status, quantities, approval snapshot, and timestamps. Reporting must not treat archived rows as live holds. |
| **6. Required tests** | Historical read by `orderId`; `clear-orders` preservation behavior; archive export/restore round-trip; reconciliation ignores archived rows; retention job is idempotent and never touches `CONSUMING`. |
| **7. Required owner approval** | Owner approves retention duration and archive destination. Finance/audit confirms evidentiary needs. |
| **8. Production blocking?** | **No for the V1 release.** **No for a V2 pilot**, but **yes before V1 is decommissioned**. |

---

### D5 - Drain procedure for existing V1 holds

**Recommendation: DRAIN in a controlled maintenance window before any V2 allocation is created. Freeze new V1 reservations, complete or cancel open orders, reconcile, then switch mode.**

| Field | Assessment |
|---|---|
| **1. Existing implementation and evidence** | V1 holds are represented by open `InventoryReservation` rows and aggregated in `InventoryItem.reservedStock` (`lib/models/InventoryReservation.js:3-20`; `ownership.js:52-53`) (VERIFIED). No drain script or runbook exists (VERIFIED absence). `clear-orders` zeroes all `reservedStock` when no `CONSUMING` reservation exists, which is a destructive reset, not a controlled drain (`clear-orders/route.js:67-82`) (VERIFIED). |
| **2. Risk if unresolved** | If V2 starts while V1 holds remain, the same physical stock can be held twice or released by the wrong owner. A partial drain can leave `reservedStock` above the sum of live holds, causing phantom shortages, or below it, causing oversell. |
| **3. Available options** | **A.** Maintenance-window drain with a freeze. **B.** Rolling drain while V1 continues. **C.** No drain; start V2 immediately. |
| **4. Recommendation and rationale** | **A.** A freeze is the only way to make the reconciliation assertion meaningful. Procedure: announce the window; block new order creation and reservation writes; allow in-flight orders to reach a terminal state or cancel them through the normal release path; run a read-only reconciliation; require `reservedStock == sum(open V1 holds)` per item; snapshot the result; only then enable V2 allocation creation. Rolling drain (B) is harder to prove and should be rejected for the first cutover. |
| **5. Migration and compatibility impact** | No schema change. Requires an operational runbook, a feature freeze, and an audit snapshot. Existing orders remain V1-owned and readable. |
| **6. Required tests** | Dry run on a disposable copy: freeze blocks new reservations; cancel/release path returns holds; reconciliation assertion passes; a deliberately injected mismatch is detected; the runbook is timed and reversible; post-drain order creation is blocked until the mode switch. |
| **7. Required owner approval** | Owner approves the window and the freeze. Operations executes and signs the reconciliation snapshot. |
| **8. Production blocking?** | **No for the V1 release.** **Yes for V2 activation.** |

---

### D6 - Cross-owner `reservedStock` reconciliation

**Recommendation: BUILD a read-only reconciliation report first; add a guarded repair script only after the report is trusted. Run it daily and at every mode change.**

| Field | Assessment |
|---|---|
| **1. Existing implementation and evidence** | `InventoryItem.reservedStock` is the shared physical hold aggregate for both owners (`ownership.js:20-21,52-53`) (VERIFIED). V1 increments/decrements it in reservation, consumption, and release paths; V2 is proposed to do the same. No reconciliation job, report, or invariant test exists (VERIFIED absence). `lib/inventoryAlertService.js` computes `availableStock = currentStock - reservedStock` for alerts but does not verify the aggregate (VERIFIED). |
| **2. Risk if unresolved** | Drift between the aggregate and the owner ledgers causes oversell (aggregate too low), phantom shortages (aggregate too high), or a release that subtracts another owner's hold. The error is silent because every read path trusts the aggregate. |
| **3. Available options** | **A.** Read-only daily report. **B.** Automatic repair. **C.** Manual spot checks only. |
| **4. Recommendation and rationale** | **A first, then a guarded B.** The report must compute, per item, `sum(open V1 holds) + sum(open V2 holds)` and compare it to `reservedStock`, with a tolerance of zero. Publish the diff and the orders responsible. Only after the report is stable should a repair script be allowed, and it must require an approval reference, write an audit record, and be idempotent. Automatic repair without a trusted report can hide the root cause. |
| **5. Migration and compatibility impact** | No schema change. Report is read-only. Repair is a separate, owner-approved operation. Reporting must distinguish V1 and V2 contributors. |
| **6. Required tests** | Fixture-based reconciliation for V1-only, V2-only, mixed, and zero states; fault injection for missing reservation, stale hold, and double release; repair idempotency; audit record on repair; report runtime on a representative dataset. |
| **7. Required owner approval** | Owner approves the report as an operational control and separately approves any repair run. Finance reviews the invariant. |
| **8. Production blocking?** | **No for the V1 release** (V1 still benefits from the report). **Yes for V2 activation.** |

---

### D7 - `inventoryMode` storage and server-side assignment

**Recommendation: STORE `inventoryMode` on the Order as a server-assigned, immutable enum, defaulting legacy orders to `V1`. Never accept it from a client.**

| Field | Assessment |
|---|---|
| **1. Existing implementation and evidence** | `ownership.js:32-46` defines `INVENTORY_MODES` (`V1`, `V2`) and the authority collection for each; `normalizeInventoryMode()` validates the value and `resolveInventoryOwner()` resolves the owner (VERIFIED). `lib/models/Order.js` has no `inventoryMode` field and `lib/orderService.js` does not set one (VERIFIED). No migration or backfill exists (VERIFIED absence). |
| **2. Risk if unresolved** | If the mode is derived from a client flag or a global mutable setting, the same order can be treated as V1 by one service and V2 by another, causing double holds or double release. Legacy orders without a mode are ambiguous during the transition. |
| **3. Available options** | **A.** Persist on the Order, server-assigned and immutable. **B.** Derive from a deployment feature flag at read time. **C.** Store in a separate mapping collection. |
| **4. Recommendation and rationale** | **A.** The owner must be a property of the order, not of the request or the deployment. Assign it in the same server-side write that creates the order; reject any client-supplied value; make it immutable after creation; backfill legacy orders to `V1`. A feature flag may decide which mode new orders receive, but it must not decide how an existing order is interpreted. |
| **5. Migration and compatibility impact** | Additive field with a default and a backfill. No V1 behavior change if the default is `V1`. Indexing is optional; if added, it is query-performance only. Existing readers ignore the field until V2 is wired. |
| **6. Required tests** | New order receives the server-selected mode; client-supplied mode is ignored or rejected; legacy order reads as `V1`; mode is immutable after creation; V1 service rejects a `V2` order and vice versa; mixed-mode reporting separates totals. |
| **7. Required owner approval** | Owner approves the field, default, and backfill. Architecture confirms the authority mapping. |
| **8. Production blocking?** | **No for the V1 release.** **Yes for V2 wiring.** |

---

### D8 - V2-aware `clear-orders` procedure

**Recommendation: GUARD the existing destructive reset so it refuses whenever any V2 allocation/hold exists or any V1 consumption is in flight. Until that guard ships, `clear-orders` must not be used in any environment where V2 is active.**

| Field | Assessment |
|---|---|
| **1. Existing implementation and evidence** | `app/api/manager/settings/clear-orders/route.js:55-91` deletes every order, deletes all non-`CONSUMED`/`CONSUMING` reservations, globally sets `reservedStock: 0` when no `CONSUMING` reservation exists, and resets the order counter (VERIFIED). It has no V2 awareness. `ownership.js:61-63` already names the intended failure codes: `CLEAR_ORDERS_V2_HOLDS_PRESENT`, `CLEAR_ORDERS_V1_CONSUMPTION_IN_FLIGHT`, `CLEAR_ORDERS_V2_OWNERSHIP_UNKNOWN` (VERIFIED). |
| **2. Risk if unresolved** | In a V2 environment, the route would delete V2-owned orders and zero `reservedStock`, erasing V2 holds without releasing allocations. That can cause oversell and destroy audit evidence. |
| **3. Available options** | **A.** Add a preflight guard to the existing route. **B.** Create a separate V2-aware reset procedure. **C.** Disable `clear-orders` in production. |
| **4. Recommendation and rationale** | **A now, B if the semantics diverge.** The preflight must refuse if any V2 allocation exists in an open state, if any V1 reservation is `CONSUMING`, or if ownership cannot be determined. The reset must then operate only on V1-owned data and must never zero stock held by V2. If V2 needs a different reset contract, build a separate procedure rather than overloading the V1 route. |
| **5. Migration and compatibility impact** | No schema change. The route becomes stricter; existing V1 resets continue to work when no V2 data exists. Requires an audit record and a clear error response. |
| **6. Required tests** | Refuses with V2 holds present; refuses with `CONSUMING`; refuses on unknown ownership; succeeds for V1-only; preserves `CONSUMED`/`CONSUMING` evidence; never zeroes V2-held stock; counter reset only after successful guard. |
| **7. Required owner approval** | Owner approves the reset contract. Operations confirms the maintenance procedure. |
| **8. Production blocking?** | **No for V1 production if the route is controlled and documented.** **Yes for V2 activation.** |

---

### D9 - V1/V2 dual-read duration and cutover criteria

**Recommendation: RUN V1 and V2 reporting in parallel for a defined window (proposed 30 days or two monthly closes, whichever is longer) and cut over only when parity is proven and the owner signs off.**

| Field | Assessment |
|---|---|
| **1. Existing implementation and evidence** | Reporting is V1-only: `lib/reportRevenueBreakdown.js:46-95` builds `kitchenRevenue`, `baristaRevenue`, `hotDrinkRevenue`, and `totalPaidRevenue` from `PAID` orders (VERIFIED). `lib/reportService.js:48-84` caches reports for 30s (VERIFIED). `lib/analytics.js` enriches `kitchenPerf` and `baristaPerf` but not `hotDrinkPerf` (VERIFIED). There is no dual-read flag, no parity report, and no cutover criterion (VERIFIED absence). |
| **2. Risk if unresolved** | Switching reports too early can produce unexplained revenue differences, double-count or omit orders, and erode trust in the numbers. Switching with no defined window makes rollback decisions arbitrary. |
| **3. Available options** | **A.** Dual-read and compare for a fixed window. **B.** Keep V1 reporting until a hard cutover. **C.** Switch to V2 immediately. |
| **4. Recommendation and rationale** | **A.** Dual-read is a control, not a feature: compute both totals, store the variance, and alert on any order-level mismatch. Define cutover criteria in advance: zero unexplained variance for the window, all V1 holds drained, reconciliation clean, V2 audit parity, and owner/finance sign-off. Keep a read-only V1 view after cutover for dispute resolution. |
| **5. Migration and compatibility impact** | Reporting code behind a flag; no data migration. Historical reports remain V1-readable. The dual-read path must not mutate orders or stock. |
| **6. Required tests** | Parity fixtures for cash, transfer, split-item, cancelled-line, refund/void, and hot-drink cases; variance report; stale-cache behavior; cutover dry run; rollback to V1; read-only guarantee. |
| **7. Required owner approval** | Owner and finance approve the window and the cutover criteria. |
| **8. Production blocking?** | **No for the V1 release.** **Yes for the final V2 cutover** (not for a limited pilot). |

---

### D10 - Future payment/inventory integration prerequisites and independent audit

**Recommendation: DO NOT integrate V2 payment and inventory before the prerequisites below are met and an independent audit is complete. This is a hard gate, not a schedule target.**

| Field | Assessment |
|---|---|
| **1. Existing implementation and evidence** | V2 domain modules exist for payment readiness, accounting, approval, state machine, allocation identity, quantity, units, and waste (`lib/inventory-v2/domain/*`) (VERIFIED). The server layer exposes transaction, index plan, ownership, and order-mutation inventory only; no V2 route, model, or live payment path is wired (VERIFIED). V1 payment logic is in `lib/orderService.js` (`payOrder`, `submitPaymentForVerification`, `applyPaidInventory`) and uses best-effort inventory hooks (`orderService.js:235-246`) (VERIFIED). No independent audit has been performed (UNVERIFIED). |
| **2. Risk if unresolved** | Premature integration can double-charge, consume stock twice, bind evidence to a stale order version, or create an unauditable financial trail. Best-effort V1 hooks already swallow inventory failures, so a V2 path built on the same pattern would hide discrepancies. |
| **3. Available options** | **A.** Integrate only after all prerequisites and an independent audit. **B.** Integrate incrementally behind a flag. **C.** Do not integrate. |
| **4. Recommendation and rationale** | **A.** Prerequisites: (1) `orderVersion` implemented and incremented atomically by every order writer; (2) idempotent payment submission and evidence binding to the exact version; (3) approval separation of duties and challenge uniqueness; (4) durable audit events for every state transition; (5) reconciliation of stock, cash, and evidence; (6) documented failure and recovery behavior for unknown commit; (7) independent security and financial audit with a signed report. Only then should a pilot be considered. |
| **5. Migration and compatibility impact** | No live change in Phase 2.2 unless separately approved. Future work adds V2 collections and route wiring behind a flag; V1 remains authoritative until cutover. Payment evidence must be additive and immutable. |
| **6. Required tests** | Idempotent retry, duplicate submission, stale `orderVersion`, evidence tampering, challenge replay, approval replay, partial failure, unknown commit, reconciliation, audit completeness, and a full end-to-end pilot on disposable data. |
| **7. Required owner approval** | Owner, finance, and an independent auditor sign the prerequisite checklist and the audit report. No self-certification. |
| **8. Production blocking?** | **No for the V1 release.** **Yes for any V2 payment/inventory feature.** |

---

## 4. Dependency order for approval

The decisions are not independent. A safe order is:

1. **D3** - confirm topology and transaction budget first; every inventory path depends on it.
2. **D2** - approve the index plan and deployment process.
3. **D4, D5, D6** - define retention, drain, and reconciliation together; they share the same invariant.
4. **D7, D8** - define ownership and the destructive-reset guard before any V2 order exists.
5. **D1** - add the build-time boundary before V2 is imported by a route.
6. **D9** - define dual-read and cutover criteria before the pilot.
7. **D10** - the final gate; no payment/inventory integration before prerequisites and independent audit.

D3 is the only item that must close before the current V1 release can be called production-ready. All others gate V2 activation or V1 decommissioning.

---

## 5. Approval record template

Each decision should be recorded as:

| Field | Value |
|---|---|
| Decision ID | D1-D10 |
| Decision | Approve / Approve with conditions / Reject / Defer |
| Conditions | Exact changes required before approval |
| Approver | Name and role |
| Date | YYYY-MM-DD |
| Evidence reviewed | Commit SHA, document version, test run |
| Change/ticket reference | Required for D2, D5, D6, D8, D10 |
| Review date | Next scheduled review |

No decision in this document is effective until the owner records it in this template or an equivalent signed artifact.

---

## 6. Safety confirmation

- Branch `main`, HEAD `69650435a6587d4577bc126f719fa1392bb934b3` at review start.
- No source, schema, route, dependency, database, or deployment change was made in Phase 2.1.
- No `.env`/`.env.local` content was read.
- No MongoDB connection was opened.
- No V2 code path was wired into a live route.
- All existing user work under `lib/inventory-v2/`, `lib/hotel/`, `tests/`, `scripts/`, and `docs/` was preserved.
