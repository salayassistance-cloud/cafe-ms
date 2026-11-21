# Phase 2.1 — Inventory Policy Classification Safety Corrections

## 1. Preflight baseline

Verified before any modification:

| Check | Expected / observed |
|---|---|
| Repository | `C:\hotelms` |
| Branch | `main` |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` |
| Status entries | 232 |
| Modified | 79 |
| Deleted | 3 |
| Untracked directory entries | 150 |
| Untracked files | 386 |
| Staged | 0 |
| Commits ahead | 0 |
| Status digest | `4C84AFCBCE9EBA38A9486641A2E6CA039ED954D12700E5DFE80D894EE91C7539` |

The complete baseline matched the Phase 2 final report. No Git state was repaired, cleaned, stashed or reset. The three pre-existing EXTERNAL deletions were confirmed intact both before and after implementation.

## 2. Exact files changed

**New source files**
- `lib/inventoryPolicyVersionService.js` — shared `policyVersion` serializer and fail-closed transaction wrapper.
- `docs/phase-2.1-inventory-policy-safety-corrections.md` — this report.

**New test files**
- `tests/phase21-inventory-policy-safety.test.mjs` — 15 focused DB-free tests.
- `tests/helpers/policy-version-fakes.mjs` — shared DB-free transaction/version stub helper.

**Modified source files**
- `lib/constants.js` — canonical terminal/open lifecycle helper.
- `lib/models/MenuItem.js` — `policyVersion` field (default 0, no backfill).
- `lib/menuInventoryPolicyService.js` — version-guarded classification write, bounded legacy-identity guard, canonical lifecycle import.
- `lib/orderService.js` — version serialization on create and add-line edits, full-attempt retry, canonical terminal guards.
- `app/api/inventory/audits/route.js` — actor name / notes / entity serialization.
- `app/components/InventoryUI.jsx` — classification audit rendering.
- `app/manager/menu-crud/MenuCrudClient.jsx` — synchronous in-flight submit guard.
- `lib/translations.js` — `invPolicyChange` label (Amharic + English).

**Modified existing test harnesses** (transaction stub support only)
- `tests/c1-catalog-identity.test.mjs`
- `tests/inventory-policy-foundation.test.mjs`
- `tests/inventory-policy-enforcement.test.mjs`
- `tests/inventory-policy-line-snapshot.test.mjs`
- `tests/inventory-recipe-snapshot.test.mjs`
- `tests/order-catalog-availability.test.mjs`
- `tests/menu-inventory-policy-classification.test.mjs` (also updated snapshot-key assertion and legacy-fake support)

No other files were changed. Every file above is within the authorized scope; the helper file and test harness edits are necessary to exercise the new transactional paths without a database.

## 3. Implementation summary

- **MenuItem `policyVersion`**: new numeric field, `default: 0`, `min: 0`. Legacy documents without the field are normalized to 0 in memory and matched with `{ $in: [0, null] }` (Mongo `null` also matches missing). No migration, backfill or initialization write was performed.
- **Shared serializer** (`lib/inventoryPolicyVersionService.js`): conditional `findOneAndUpdate` on the same MenuItem document, combining `policyVersion + 1` with the caller's `$set` (`inventoryPolicy` for classification; no catalog-visible `updatedAt` change for order flows via `timestamps: false`). A miss throws `POLICY_VERSION_CONFLICT`; a missing `startSession` throws `POLICY_TRANSACTION_UNAVAILABLE` (503) — fail closed.
- **Classification**: the open-order recheck, legacy-identity check, Recipe validation, guarded policy/version write and durable audit all run in one transaction. A version miss aborts and the whole callback is re-run (fresh item, fresh open-order query, fresh Recipe validation).
- **Order create / add-line edit**: catalog resolution happens outside the small transaction; the version bump and the order insert/update happen inside it. On a version miss the entire attempt is retried, so catalog and policy are re-resolved. Both flows write the same MenuItem document as classification, creating a real MongoDB write-conflict dependency rather than relying on snapshot isolation.
- **Lifecycle, audit visibility and UI** corrections are described below.
- **Recipe gate unchanged**: the stricter TRACKED gate (active Recipe, `isTrackedRecipeUsable`, stock-area and unit validation) was preserved exactly; no Recipe, reservation or deduction logic was modified.

## 4. Concurrency design and conflict handling

Two order flows and classification all perform a conditional write on the same MenuItem document:

| Flow | Transaction contents | Serialization write |
|---|---|---|
| Classification | open-order recheck → legacy check → Recipe gate → policy write → audit | `policyVersion: expected → expected+1` plus `inventoryPolicy` |
| `createOrder` | version bump → `Order.save({ session })` | `policyVersion: expected → expected+1` (no `updatedAt` change) |
| `editOrderItems` (add only) | version bump → atomic `items`/`totalAmount` `$set` | same conditional bump |

If classification commits first, the order's version guard misses, the transaction aborts and the outer retry re-reads the catalog (new policy is captured). If an order commits first, classification's version guard misses, its transaction aborts and the whole callback re-runs the open-order guard — now seeing the new open order — and blocks the reclassification. Real MongoDB write conflicts are handled by the existing `runInTransaction` retry policy; version misses are handled by the bounded outer retry loops. If transactions are unavailable, all three paths fail closed with a controlled 503.

Existing order-line snapshots are never rewritten: `working` is rebuilt from the stored order on each retry, and only newly added lines receive a fresh snapshot. Pure quantity/note/remove edits keep their original non-transactional atomic path.

## 5. Canonical lifecycle definition

`lib/constants.js` now exports `TERMINAL_ORDER_STATUSES`, `OPEN_ORDER_STATUSES`, `isTerminalOrderStatus()` and `isOpenOrderStatus()`. Terminal = SERVED, PAYMENT_PENDING, PAID, CANCELLED, ARCHIVED — verified against the order lifecycle (SERVED and PAYMENT_PENDING can no longer be edited) and the previously duplicated `orderService` guards. Open = PENDING, PREPARING, READY. The classification guard and the six inline `orderService` terminal guards now use this one definition; no new status was invented and uncertain statuses are not treated as terminal.

## 6. Legacy identity protection

The classification guard adds a bounded second query for open orders with `$elemMatch` lines lacking a valid `itemId`. For each non-cancelled legacy line:

- no usable name → `LEGACY_LINE_IDENTITY_UNRESOLVED` (fail closed);
- exact normalized name match against the target MenuItem's supported `name` fields → blocked as an affected open order;
- name shared with another live MenuItem, or conflicting localized names → `LEGACY_LINE_IDENTITY_UNRESOLVED`;
- a non-blank name matching none of the target's names → treated as unrelated.

No fuzzy matching, migration or legacy-order rewrite was introduced.

## 7. Audit UI changes

`app/api/inventory/audits/route.js` now resolves staff display names from `actorId` (name only, no credentials), serializes `actorName`, falls back to the actor id (never a false "System" for an identified actor), maps `reason → notes`, and tags classification rows with `entity: "MenuItem"`. `InventoryUI.jsx` renders classification rows with a dedicated "Menu item classification" badge, shows the before → after snapshot values, keeps the stock-delta column empty for these rows, and leaves all other audit types unchanged. No InventoryAudit schema, index, migration or backfill was introduced.

## 8. UI double-submit protection

`MenuCrudClient.jsx` adds a synchronous `classificationInFlight` ref, checked before validation and set immediately after confirmation — before React's async pending state exists — and cleared in `finally`. Server-confirmed state remains authoritative: local saved policy changes only when `res.changed` is true; failures still display `res.error` without changing the displayed saved value.

## 9. Test results

```
node --test tests/phase21-inventory-policy-safety.test.mjs
# 15 tests, 15 pass, 0 fail (exit 0)

node --test tests/inventory-policy-line-snapshot.test.mjs tests/menu-inventory-policy-classification.test.mjs tests/inventory-policy-foundation.test.mjs tests/inventory-policy-enforcement.test.mjs tests/inventory-recipe-snapshot.test.mjs tests/order-catalog-availability.test.mjs tests/c1-catalog-identity.test.mjs
# 143 tests, 143 pass, 0 fail (exit 0)

node --test tests/inventory-policy-consistency.test.mjs tests/menu-orderability-policy-privacy.test.mjs tests/inventory-manager-ui-integration.test.mjs tests/report-i18n-corrections.test.mjs tests/inventory-policy-line-snapshot.test.mjs tests/phase21-inventory-policy-safety.test.mjs
# 107 tests, 107 pass, 0 fail (exit 0)

node --test tests/inventory-reservation-phase1.test.mjs tests/inventory-lifecycle-phase1-1.test.mjs tests/inventory-consumption-failure-safety.test.mjs tests/reservation-reconcile-immutable.test.mjs tests/legacy-deduction-disabled.test.mjs tests/session-auth-migration.test.mjs tests/tab-operational-sessions.test.mjs
# 113 tests, 113 pass, 0 fail (exit 0)
```

No tests were skipped. No build was run. `MODULE_TYPELESS_PACKAGE_JSON` warnings and benign stub-hook error logs are pre-existing and do not affect assertions.

## 10. Risks and unverified runtime assumptions

- **No runtime/DB verification:** all concurrency evidence is source-level plus DB-free interleaving tests. MongoDB write-conflict behavior, transaction commit timing and replica-set availability were not exercised.
- **Standalone topology fails closed:** classification and serialized order writes require transactions; unsupported topology yields 503.
- **Legacy name matching is exact only:** a legacy line whose stored name differs from every supported localized name of the target is treated as unrelated. This is deterministic and bounded but cannot resolve misspelled or renamed legacy lines.
- **Serialization writes on every order:** each order create/add bumps a MenuItem version. This is not an initialization/backfill write, but it does touch catalog documents during order intake.
- **Audit actor name is best-effort:** if the Staff lookup fails, the actor id is still shown (not "System"), but the human name may be absent.
- **Retry bounds:** three attempts per outer/inner loop; persistent conflicts surface as a controlled error rather than indefinite retry.
- The stricter TRACKED classification Recipe gate is unchanged by design.

## 11. Final Git status comparison

| Check | Preflight | After implementation |
|---|---|---|
| HEAD | `69650435…` | `69650435…` (unchanged) |
| Branch | `main` | `main` |
| Status entries | 232 | 237 |
| Modified | 79 | 81 |
| Deleted | 3 | 3 |
| Untracked entries | 150 | 153 |
| Untracked files | 386 | 390 |
| Staged | 0 | 0 |
| Commits ahead | 0 | 0 |
| Digest | `4C84AFCB…` | `1AF852F8…` |

Deltas: two previously clean tracked files (`lib/constants.js`, `lib/models/MenuItem.js`) are now modified; four new untracked files were added (`lib/inventoryPolicyVersionService.js`, `tests/helpers/policy-version-fakes.mjs`, `tests/phase21-inventory-policy-safety.test.mjs`, and this report). The three EXTERNAL deletions and all unrelated uncommitted work remain untouched.

## 12. Confirmation of excluded operations

No MongoDB connection or query; no database read/write/alteration; no migration, backfill, seed or index change; no secret, credential or `.env` access; no staging, production, deployment, staging files, commits, pushes, resets, cleans, stashes, checkouts, restores, rebases or cherry-picks; no EXTERNAL retirement; no payment, hotel, Jebena Buna, reservation, recovery or unrelated API changes; no public-menu exposure change; no broad refactor; no build.

Implementation and verification are complete. No further phase was started.
