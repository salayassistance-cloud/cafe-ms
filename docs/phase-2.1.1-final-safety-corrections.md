# Phase 2.1.1 — Final Safety Corrections

## Preflight

Verified before any modification:

| Check | Value |
|---|---|
| Repository root | `C:\hotelms` |
| Branch | `main` |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` |
| Status entries | 237 (81 M / 3 D / 153 untracked entries) |
| Untracked files | 390 |
| Staged | 0 |
| Commits ahead | 0 |
| Status digest | `1AF852F8AEED4AA68D460463089C935F9BA92C1BE4A1317F1238520BA310B6C4` |

Baseline matched the Phase 2.1 final report exactly. No Git state was reset, cleaned, stashed or overwritten. The three EXTERNAL deletions remained intact.

## Corrections implemented

### S4 — transaction abort on failed order edit

`lib/orderService.js`: in the add-line edit transaction, `Order.findOneAndUpdate` no longer returns null to the caller. A null result now throws `PolicyVersionError(ORDER_EDIT_CONFLICT)` **inside** the transaction callback, so the MenuItem `policyVersion` bump and the order edit abort together. The new code is intentionally outside the outer version-conflict retry predicate, so a stale order state surfaces immediately rather than being retried.

`lib/inventoryPolicyVersionService.js`: added the `ORDER_EDIT_CONFLICT` error code.

### S5 — safe retry reconstruction

`lib/transactionRunner.js`: added an optional `options.maxAttempts` (default 3, canonical loop kept intact for existing source contracts). `lib/inventoryPolicyVersionService.js`: `runPolicyVersionTransactionOnce` now requests `maxAttempts: 1` for order flows. `lib/orderService.js`: the outer `createOrder` / `editOrderItems` retry loops now catch both `POLICY_VERSION_CONFLICT` and genuine transient transaction errors (never unknown commit results) and rebuild the whole attempt — including a fresh Order document, catalog snapshot and version entries — before retrying. No aborted attempt's mutable Mongoose document or version entries are reused.

### L5 — conservative legacy identity

`lib/menuInventoryPolicyService.js`: a legacy line is now considered safe to ignore only when it is proven to belong to exactly one other live MenuItem whose supported exact names cover every name on the line. A line matching the target MenuItem is blocked as before, but shared names, mixed localized names, blank names, unknown/renamed names and names matching multiple other MenuItems all fail closed with `LEGACY_LINE_IDENTITY_UNRESOLVED`. The lookup is exact-only, bounded and deterministic; no fuzzy matching was added. Terminal-order handling is unchanged.

### F3 — audit schema mismatch

Not changed by design. `InventoryAudit.item` remains an ObjectId reference to `InventoryItem` while classification events store a MenuItem id. Documented as a deferred risk; no schema, index, migration or backfill was introduced.

### F4 — code hygiene

`lib/menuInventoryPolicyService.js`: replaced the outdated header claim that the create-order race could not be closed, and removed the verified-unused `runInTransaction` import. No other cleanup.

### U2 — UI error handling

`app/manager/menu-crud/MenuCrudClient.jsx`: the classification action call is now wrapped in `try/catch/finally`. Network/server exceptions display a meaningful error, never report success, leave the confirmed saved policy untouched, and still release the synchronous in-flight guard.

## Test evidence

Focused suite:

```
node --test tests/phase21-inventory-policy-safety.test.mjs
# 22 tests, 22 pass, 0 fail (exit 0)
```

Relevant regressions:

```
node --test tests/menu-inventory-policy-classification.test.mjs tests/inventory-policy-line-snapshot.test.mjs tests/inventory-policy-foundation.test.mjs tests/inventory-policy-enforcement.test.mjs tests/inventory-recipe-snapshot.test.mjs tests/order-catalog-availability.test.mjs tests/c1-catalog-identity.test.mjs
# 143 tests, 143 pass, 0 fail (exit 0)

node --test tests/inventory-policy-consistency.test.mjs tests/menu-orderability-policy-privacy.test.mjs tests/inventory-manager-ui-integration.test.mjs tests/report-i18n-corrections.test.mjs tests/inventory-reservation-phase1.test.mjs tests/inventory-lifecycle-phase1-1.test.mjs tests/reservation-reconcile-immutable.test.mjs tests/legacy-deduction-disabled.test.mjs
# 132 tests, 132 pass, 0 fail (exit 0)
```

Full offline suite:

```
node --test tests/*.test.mjs
# 2536 tests, 2536 pass, 0 fail (exit 0)
```

Two stale source-contract assertions in `tests/extra-items-policy.test.mjs` were updated to the intentional Phase 2.1 transactional source shape (`doc.save({ session })` and the shared `persistOrder` helper); their semantic intent (extras resolve/reserve before the guarded write, and the post-save hook remains) is preserved.

Production build: **not run.** Next.js builds load environment files and may perform static-generation database access, which would violate this phase's prohibition on reading secrets/`.env` files and connecting to databases. No build result is claimed.

## Known limitations and runtime assumptions

- All concurrency evidence is source-level plus DB-free fakes. MongoDB write-conflict/abort behavior, replica-set availability and commit timing were not exercised.
- The fake transaction runner simulates abort via a rollback callback; it does not reproduce MongoDB isolation. Tests explicitly represent this limitation.
- `runPolicyVersionTransactionOnce` uses a single inner attempt so mutable documents are never reused; retry correctness relies on the outer reconstruction loop and the bounded retry policy in `lib/transactionRunner.js`.
- L5 exact-name proof cannot resolve a legacy item renamed since the order was written; such lines now block classification rather than being assumed unrelated.
- The deferred InventoryAudit schema mismatch (F3) remains: an eventual dedicated MenuItem classification audit action should be reviewed separately.
- No runtime/production verification of audit durability, stock deduction or payment behavior was performed.

## Remaining deployment blockers

- No approved runtime database environment was used; transaction support and real write-conflict behavior remain unverified.
- Build and deployment were intentionally not executed.
- The deferred audit schema semantic mismatch should be scheduled for owner review before any reporting work that populates `InventoryAudit.item`.
- Standard deployment-readiness checks (configuration, migrations review, monitoring, rollback plan) belong to the separate upcoming audit.

## Offline vs production verification

Everything reported above is **offline verification only**: static source inspection and DB-free Node tests. Nothing in this report should be read as proof of production behavior, database integrity, transaction semantics or deployment readiness.

## Final Git status comparison

| Check | Preflight | After Phase 2.1.1 |
|---|---|---|
| HEAD | `69650435…` | `69650435…` (unchanged) |
| Branch | `main` | `main` |
| Status entries | 237 | 238 |
| Modified | 81 | 81 |
| Deleted | 3 | 3 |
| Untracked entries | 153 | 154 |
| Untracked files | 390 | 391 |
| Staged | 0 | 0 |
| Commits ahead | 0 | 0 |
| Digest | `1AF852F8…` | `4B931D38CDD06A6277C746419CEAE5A1D60CA9C010187DC7ED2C90A2E667BBD4` |

Delta: one new untracked report document. No files were staged, committed, pushed, deployed, migrated or deleted. All three EXTERNAL deletions remain untouched. No database, secret, `.env`, credential, staging or production operation was performed.

Stop after this report. No deployment or further phase was started.
