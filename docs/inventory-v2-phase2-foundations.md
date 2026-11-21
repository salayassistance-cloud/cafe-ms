# BONO Inventory V2 — Phase 2.0 Foundations

Status: **IMPLEMENTED FOUNDATIONS ONLY — NOT WIRED, NOT DEPLOYED, NOT EXECUTED.**

Phase 2.0 adds reusable server-side foundations for Inventory V2. It does not
change V1 behaviour, does not add production imports or route wiring, does not
add `orderVersion` or `inventoryMode` to the Order schema, and does not connect
to MongoDB or create any index. No Phase 2.1 work is included.

- Baseline branch: `main`
- Baseline HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
- All new files are uncommitted/untracked. Nothing was staged, committed, or pushed.

---

## 1. Scope and non-goals

### In scope (delivered)

1. A runtime server-only boundary for `lib/inventory-v2/server/`.
2. A reusable transaction helper with bounded retries and an explicit
   unknown-commit resolution contract.
3. A centralized, explicit V2 index plan plus a guarded deployment script.
4. A static order-mutation inventory and the future `orderVersion` contract.
5. A V1/V2 ownership model, shared `reservedStock` invariants, and a
   documented `clear-orders` risk.
6. DB-free tests for all of the above.
7. This document.

### Explicit non-goals (not delivered, by design)

- No V2 allocation, approval, waste-correction, payment-evidence, audit, or
  policy-version implementation.
- No `inventoryMode` field, no `orderVersion` field, no schema migration.
- No change to `lib/orderService.js`, `lib/inventoryReservationService.js`,
  `lib/inventoryWasteService.js`, `lib/inventoryDeductionService.js`, or the
  clear-orders route.
- No import of `lib/inventory-v2/` from any application route, model, V1
  service, or client component.
- No database connection, index creation, deployment, or migration.
- No addition of the `server-only` npm package (not authorized). The
  repository-compatible runtime guard plus ESLint is used instead.

---

## 2. Files added or modified

| File | Change | Purpose |
|------|--------|---------|
| `lib/inventory-v2/server/boundary.js` | added | Runtime server-only guard |
| `lib/inventory-v2/server/transaction.js` | added | Reusable transaction helper |
| `lib/inventory-v2/server/indexPlan.js` | added | Explicit V2 index plan + validation |
| `lib/inventory-v2/server/orderMutationInventory.js` | added | Order writer inventory + version contract |
| `lib/inventory-v2/server/ownership.js` | added | V1/V2 ownership + shared-stock invariants |
| `lib/inventory-v2/server/index.js` | added | Server-only barrel (issuer-free) |
| `scripts/inventory-v2-deploy-indexes.mjs` | added | Guarded, unexecuted index deployment |
| `tests/inventory-v2-phase2.test.mjs` | added | 50 DB-free Phase 2.0 tests |
| `eslint.config.mjs` | modified | Client import boundary enforcement |
| `docs/inventory-v2-phase2-foundations.md` | added | This document |

`lib/inventory-v2/domain/` (Phase 1) was **not** modified. Its public barrel
remains issuer-free: `issueManagerActionAuthorization`,
`issueWasteManagerAuthorization`, and `resetWasteCorrectionLedger` are not
exported from it or from the new server barrel.

---

## 3. Server-only boundary

`boundary.js` provides:

- `isServerRuntime()` — true when `window` is undefined.
- `assertServerOnly(scope)` — throws when evaluated in a browser bundle.
- `isServerOnlyViolation(scope)` — non-throwing predicate for tests/checks.
- `INVENTORY_V2_SERVER_MODULE_PREFIX = "lib/inventory-v2/server/"`.

Every other V2 server module calls `assertServerOnly(...)` at import time, so a
client bundle import fails closed at runtime.

**Static enforcement.** `eslint.config.mjs` adds `no-restricted-imports` for
client-shaped files (`app/components/**`, `app/**/page.*`, `app/**/*Client.*`,
`app/**/*UI.*`, `app/**/*Modal.*`). Server routes, server actions, scripts, and
tests are deliberately not matched, so legitimate server imports remain allowed.

**Limitation.** The `server-only` package is not installed. Bundler-level
poisoning is therefore not claimed. The runtime guard plus ESLint are the
current defences; adopting `server-only` requires separate authorization.

---

## 4. Transaction helper contract

`transaction.js` exports `runV2Transaction(connection, options)`.

Required options:

| Option | Meaning |
|--------|---------|
| `actionIdentity` | Stable logical action identity (never changes across retries) |
| `fingerprint` | Stable payload fingerprint for that action |
| `operation(session, context)` | Work performed inside one transaction |
| `resolveOutcome(actionIdentity, context)` | Caller-owned resolution for unknown commit results |
| `maxAttempts` | Default `5` |
| `baseDelayMs` / `maxDelayMs` | Defaults `25` / `250` |
| `sleep` / `random` | Injectable for deterministic tests |
| `onAttempt` | Optional observability hook (never changes semantics) |

### Error classification

| Class | Detection | Behaviour |
|-------|-----------|-----------|
| `UNSUPPORTED` | code `20` or replica-set/mongos message | Throw `TRANSACTIONS_UNAVAILABLE` (HTTP 503). Never retried. |
| `UNKNOWN_COMMIT` | `UnknownTransactionCommitResult` label | Call `resolveOutcome` with the **same** identity/fingerprint. Never a blind retry. |
| `TRANSIENT` | `TransientTransactionError` label, code `112` (WriteConflict), code `251` (NoSuchTransaction) | Retry with exponential backoff + jitter, bounded by `maxAttempts`. |
| `DETERMINISTIC` | anything else | Rethrow unchanged. Never retried or wrapped. |

### Unknown-commit resolution

`resolveOutcome(actionIdentity, { fingerprint, attempt, error })` must return:

| Status | Meaning | Helper behaviour |
|--------|---------|------------------|
| `CONFIRMED_SUCCESS` | Stored record matches identity **and** fingerprint | Replay the stored `result` |
| `CONFIRMED_ABSENT` | Record definitively absent | Retry the **same** action identity if budget remains |
| `CONFLICT` | Identity exists with a different payload | Throw `ACTION_IDENTITY_CONFLICT` (409) |
| `UNRESOLVED` | Outcome cannot be established | Throw `OUTCOME_UNRESOLVED` (409), never retry |

A `CONFIRMED_SUCCESS` whose returned identity/fingerprint differs from the
caller's is treated as a conflict, not a replay.

### Cleanup guarantees

- A session is opened per attempt and `endSession()` runs in `finally` on every
  path (commit, abort, business error, unsupported topology, unknown commit).
- `abortTransaction()` runs whenever a transaction started but did not commit.
- An abort/cleanup failure never replaces the primary error; it is attached as a
  non-enumerable `abortError` property.
- Invalid options fail before any session is opened.

**This helper is not wired into any V1 service in Phase 2.0.**

---

## 5. V2 index plan

`indexPlan.js` is pure data + validation. It never connects to MongoDB and is
never imported by application startup.

### Collections

`inventory_v2_allocations`, `inventory_v2_waste_corrections`,
`inventory_v2_approval_challenges`, `inventory_v2_approvals`,
`inventory_v2_payment_evidence`, `inventory_v2_audit_events`,
`inventory_v2_policy_versions`.

### Classifications

- `CORRECTNESS_CRITICAL_UNIQUE` — the database enforces a safety invariant.
- `QUERY_PERFORMANCE_ONLY` — read-path optimisation, not a correctness dependency.
- `CLEANUP_ONLY` — TTL reclamation; never decides whether a new document may exist.

### Unique constraints

| Collection | Unique key | Rationale |
|------------|-----------|-----------|
| allocations | `{ allocationId: 1 }` | One durable allocation per ID |
| allocations | `{ orderId: 1, allocationKey: 1, epoch: 1 }` | No duplicate allocation identity |
| waste_corrections | `{ allocationId: 1, correctionId: 1 }` | Durable correction idempotency |
| approval_challenges | `{ challengeId: 1 }` | **Only** correctness-critical unique index on challenges |
| approvals | `{ approvalGroupId: 1, stage: 1 }` | **Only** place this tuple is unique |
| approvals | `{ challengeId: 1 }` | One successful approval per consumed challenge |
| payment_evidence | `{ evidenceId: 1 }` | One durable evidence per ID |
| payment_evidence | `{ orderId: 1, orderVersion: 1 }` | Evidence bound to exactly one order version |
| audit_events | `{ eventId: 1 }` | Idempotent audit events |
| policy_versions | `{ policyVersion: 1 }` | Immutable unique policy versions |

### Challenge rule (critical)

`inventory_v2_approval_challenges` has exactly one correctness-critical unique
index: `{ challengeId: 1 }`. A global unique
`{ approvalGroupId: 1, stage: 1 }` on challenges is **forbidden**: it would
deadlock re-issuance after an expired/failed challenge. Successful-approval
uniqueness belongs exclusively to `inventory_v2_approvals`.

The only TTL index is `challenge_expires_ttl` on `{ expiresAt: 1 }`
(`expireAfterSeconds: 0`), classified `CLEANUP_ONLY` and non-unique. The
optional `challenge_open_lookup` index on `{ approvalGroupId: 1, stage: 1 }` is
non-unique and partial (`consumedAt: null`), and is never a correctness
dependency.

`validateV2IndexPlan()` / `assertV2IndexPlan()` reject: unknown collections,
duplicate names/keys, invalid directions, unique/TTL classification mismatches,
unique TTL, missing required uniques, missing collections, and the forbidden
challenge unique.

---

## 6. Index deployment script

`scripts/inventory-v2-deploy-indexes.mjs` — **created but never executed.**

Safeguards:

1. Requires `--confirm`; without it, exits non-zero before any connection.
2. Production gate: if any production marker is present (`NODE_ENV`,
   `VERCEL_ENV`, `CONTEXT`, `DEPLOY_ENV`, `ENVIRONMENT`, `APP_ENV`,
   `INVENTORY_V2_INDEX_DEPLOY_ENV`), it additionally requires
   `--allow-production` **and** a non-empty
   `INVENTORY_V2_INDEX_DEPLOY_APPROVAL` change/ticket reference.
3. Fails closed when the target environment is unclassified.
4. Inspects indexes **before** and **after** deployment.
5. Creates only missing indexes, via `createIndexes()` only.
6. Fails closed on missing, unexpected, mismatched, duplicate, or forbidden
   indexes; it never removes them.
7. Never calls `syncIndexes()`, `dropIndex()`, or `dropIndexes()`.
8. Never prints the URI, credentials, or approval value (redaction applied to
   error text).
9. Closes the dedicated connection in `finally`.

`lib/mongodb.js` still performs background index sync for existing models and
was **not** extended to V2 collections. `lib/hotel/db/connection.js` remains the
repository model for `autoIndex: false` plus explicit deployment.

---

## 7. Order mutation inventory and `orderVersion`

`orderMutationInventory.js` is a **static source inventory**, not proof of
runtime coverage. It documents every known order writer, including
`lib/orderService.js` (create, status, serve, pay, archive, cancel, cancel-item,
edit-items, payment submission/confirmation/rejection/update), delegated API
routes, `clear-orders`, operational scripts, and client callers.

`ORDER_VERSION_CONTRACT` states:

- `orderVersion` is a server-controlled monotonic integer, initial value `0`.
- The same atomic write that mutates the order must `$inc` it.
- Concurrency-sensitive filters must include the expected `orderVersion`.
- Payment evidence and approval challenges bind to the exact version.
- `updatedAt` is **forbidden** as a substitute.
- **Not implemented in Phase 2.0.**

`CANCEL_ORDER_ITEM_UPDATED_AT_ANALYSIS` records the current `cancelOrderItem`
behaviour: the guarded second (derived-status) write uses `updatedAt` from the
first write as its optimistic token. Phase 2.0 decision: **document only, do not
replace it.** The future contract requires the line-cancel and derived-status
writes to share one version increment (or both carry the expected version).

`UNVERIFIED_WRITER_RISKS` records that external integrations, ad-hoc scripts,
dynamic imports, and direct `mongosh` writes cannot be proven absent from the
repository.

---

## 8. V1/V2 ownership and shared stock

`ownership.js` defines:

- `V1` authority: `inventoryreservations` (`InventoryReservation`), `ACTIVE_V1`.
- `V2` authority: `inventory_v2_allocations` (proposed, not implemented).
- `InventoryItem.reservedStock` is the **shared physical hold aggregate**.

Rules enforced by pure helpers:

- `inventoryMode` is required and server-assigned; never inferred from the UI.
- An order has **exactly one** owner; both or neither fails closed.
- V1 services reject V2-owned orders and vice versa (`assertV1OwnedOrder`,
  `assertV2OwnedOrder`).
- Every hold change must be a conditional atomic update.
- V1 paths must never subtract V2 holds, and vice versa.
- Reconciliation is per-owner; a global reset is not reconciliation.
- No retroactive deduction on already-consumed stock.
- V1/V2 reporting stays isolated until an owner-approved cutover.

`RESERVED_STOCK_WRITERS` inventories the known writers/readers:
`ensureOrderInventoryReservation`, `reconcileOrderInventory`,
`approveInventoryShortage`, `releaseOrderInventory`, `consumeOrderInventory`,
`clear-orders`, `executeInventoryDeduction` (does not touch `reservedStock`),
and `recordWaste` (reads it for available-stock guards).

### Clear-orders risk (critical, unchanged)

`app/api/manager/settings/clear-orders/route.js` currently performs
`Order.deleteMany({})`, deletes V1 reservations except `CONSUMED`/`CONSUMING`,
and globally resets holds with
`InventoryItem.updateMany({ reservedStock: { $gt: 0 } }, { $set: { reservedStock: 0 } })`.
A future V2 hold would be erased, leaving V2 allocations that believe stock is
held while `reservedStock` is zero.

Phase 2.0 **does not change the route**. `evaluateClearOrdersSafety()` is a pure
future guard (not called by the route) that fails closed when V2 holds exist,
V2 ownership is unknown, or V1 consumption is in flight.

---

## 9. Test evidence

All tests are DB-free. No MongoDB connection is opened, no environment file is
read, and no model/route code is imported. Transaction behaviour is proven
against **stub sessions only**.

| Command | Result |
|---------|--------|
| `node --test tests/inventory-v2-phase2.test.mjs` | **50 pass, 0 fail** (6 suites) |
| `node --test tests/inventory-v2-phase1.test.mjs` | **154 pass, 0 fail** (21 suites) |
| `node --test tests/inventory-lifecycle-phase1-1.test.mjs tests/inventory-reservation-phase1.test.mjs tests/item-level-cancellation.test.mjs tests/clear-orders-auth.test.mjs tests/kds-action-precision.test.mjs tests/kds-separation.test.mjs` | **92 pass, 0 fail** (11 suites) |
| `npx eslint lib/inventory-v2/server scripts/inventory-v2-deploy-indexes.mjs tests/inventory-v2-phase2.test.mjs eslint.config.mjs` | **clean (no output)** |

Phase 2.0 coverage includes: runtime boundary, module guards, issuer-free
barrels, absence of production imports, domain purity, ESLint config, commit
success, transient retry with stable identity, bounded exhaustion, unknown
commit (success/absent/conflict/unresolved), unsupported topology (503),
deterministic rethrow, abort-failure masking, session cleanup on every path,
invalid options, backoff determinism, plan validation and tamper rejection,
challenge-unique prohibition, TTL rules, CLI confirmation/production/URI/help
guards, plan grouping, index inspection, destructive-call absence, order-writer
coverage, `orderVersion` contract, `cancelOrderItem` token, schema absence, and
V1/V2 ownership invariants.

Note: Node emits a pre-existing `MODULE_TYPELESS_PACKAGE_JSON` warning because
`package.json` has no `"type": "module"`. It is a warning only and does not
affect results.

---

## 10. Verification labels

### VERIFIED FROM SOURCE

- `lib/inventory-v2/` is not imported by any `app/` or non-V2 `lib/` module.
- `lib/models/Order.js` contains no `orderVersion`.
- `lib/orderService.js` still uses `updatedAt` in `cancelOrderItem` and contains
  no `orderVersion`.
- `clear-orders` still deletes orders and globally resets `reservedStock`.
- The deployment script contains no `syncIndexes`, `dropIndex`, or
  `dropIndexes` call.
- The domain and server barrels do not export trusted issuers or
  `resetWasteCorrectionLedger`.

### VERIFIED BY TEST

- All 50 Phase 2.0 tests pass.
- The 154 Phase 1 tests and 92 related inventory/KDS/clear-orders tests pass.
- Targeted ESLint is clean.
- Plan tampering and CLI guard failures fail closed.

### INFERRED

- The runtime guard prevents a browser bundle from evaluating V2 server modules
  in practice, assuming the bundler does not strip or transform the check.
- The static order-writer inventory covers the writers visible in this
  repository; it cannot prove the absence of external writers.
- Bounded retries with jitter reduce write-conflict collisions but do not
  guarantee eventual success.

### UNVERIFIED

- Real MongoDB replica-set/mongos topology and transaction support.
- Real transaction timeout, commit, and unknown-commit behaviour.
- Whether V2 indexes can be created on the live database without conflict.
- Whether the guarded deployment script runs correctly against a real cluster
  (it was never executed).
- Complete runtime order-writer coverage (external integrations, ad-hoc
  scripts, direct database access).
- `orderVersion` compatibility with legacy orders and all writers.
- `inventoryMode` representation and migration of existing orders.
- `inventoryreservations` migration/retention strategy.
- `reservedStock` reconciliation across owners.
- Authoritative KDS evidence, high-value threshold source, retention/backup,
  PIN lockout policy, and CI replica-set availability.

### REQUIRES OWNER DECISION

1. Adopt the `server-only` package for bundler-level enforcement?
2. Approve the V2 index plan and schedule guarded deployment (including the
   `--allow-production` approval process).
3. Confirm the MongoDB topology and transaction budget for V2.
4. Decide `inventoryreservations` migration vs. historical retention.
5. Decide how existing V1 holds are drained before V2 allocation creation.
6. Decide `reservedStock` reconciliation across both owner ledgers.
7. Decide `inventoryMode` storage and server assignment.
8. Approve the V2-aware `clear-orders` procedure before any V2 hold can exist.
9. Decide dual-read duration and cutover criteria for V1/V2 reporting.
10. Approve any future payment/inventory integration after prerequisites and an
    independent audit.

---

## 11. Safety-gate confirmation

- Branch `main`, HEAD `69650435a6587d4577bc126f719fa1392bb934b3` unchanged.
- Baseline dirty/untracked count was 101. Current count is 104, fully explained
  by: new `scripts/inventory-v2-deploy-indexes.mjs`, new
  `tests/inventory-v2-phase2.test.mjs`, and modified `eslint.config.mjs`.
  New `lib/inventory-v2/server/` files remain inside the already-untracked
  `lib/inventory-v2/` directory entry. This document adds one more untracked
  file.
- No `.env`/`.env.local`/credential/secret file was read.
- No MongoDB connection, migration, index creation, or deployment was performed.
- No production import, route wiring, or V1 behaviour change was made.
- No file was reset, checked out, stashed, cleaned, overwritten, staged,
  committed, or pushed.
- The index deployment script was not executed.

**Phase 2.0 ends here. Phase 2.1 must not start until the owner reviews this
report and authorizes it separately.**
