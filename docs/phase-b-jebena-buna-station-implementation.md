# JEBENA BUNA — Third Preparation Station (HOT_DRINK) — Phase B Implementation Report

Status: **IMPLEMENTED** — builds, full regression suite green, Phase A architecture respected.
Branch: `main` (all Phase B edits uncommitted; pre-existing user/hotel work preserved untouched).
Companion document: `docs/phase-a-jebena-buna-station-architecture.md`.

---

## 1. What was built

A third TV preparation station for the BONO POS:

| Aspect | Value |
|---|---|
| Role / Teacher enum value | `HOT_DRINK` |
| Staff role enum value | `HOT_DRINK` |
| Session role snapshot | `HOT_DRINK` |
| Status field on the order | `hotDrinkStatus` (+ `hotDrinkPreparingAt`, `hotDrinkReadyAt`, `hotDrinkStaffId`) |
| Portal | `/jebena` (guarded by a live `HOT_DRINK` staff session) |
| Display label | `JEBENA BUNA` |
| `cancelledStation` value | `HOT_DRINK` |
| Revenue bucket | `hotDrinkRevenue` (third, additive) |
| Item type snapshot | `HOT_DRINK` |

Design principle kept: the third station is a **peer** of KITCHEN and BARISTA, sharing the same
one `KitchenDisplay` board component, the same policy matrix, the same auth engine, the same
order state machine — no duplicated portals, screens, or update paths.

---

## 2. Exact files changed

### Models & validation
- `lib/models/Staff.js` — `STAFF_ROLES` add `"HOT_DRINK"`
- `lib/models/Session.js` — `SESSION_ROLES` add `"HOT_DRINK"`
- `lib/models/Order.js` — `ITEM_TYPE` add `HOT_DRINK`; order `hotDrinkStatus`/`hotDrinkPreparingAt`/`hotDrinkReadyAt`/`hotDrinkStaffId` (+ index); line `cancelledStation` enum add `HOT_DRINK`
- `lib/models/Category.js` — `type` and `targetStation` enums add `HOT_DRINK`
- `lib/models/MenuItem.js` — `categoryType` and station enums add `HOT_DRINK`
- `lib/validate.js` — `validateRole` accepts `HOT_DRINK`

### Policy & station model
- `lib/policy.js` — `HOT_DRINK` role; `HOT_DRINK_OR_MANAGER` group; transitions `PREPARING`/`READY`/`ARCHIVED`; `orders:cancel:item`; no payment/serve/create/menu/staff grant
- `lib/stationStatus.js` — pure station map + status/action/update helpers add the third station (existing KITCHEN/BARISTA behavior unchanged)

### Auth & provisioning
- `lib/config/security.js` — `DEFAULT_HOT_DRINK_PIN` env-overridable (default `"5555"`)
- `app/api/auth/*` — no change required (role-generic `Staff.find({ role })` lookup already covers it)
- `app/api/staff/route.js` — default/custom `pinStatus` map includes `HOT_DRINK`
- `app/api/manager/staff/route.js` — role-wide PIN reset includes `HOT_DRINK` + `revokeRoleSessions(PIN_RESET)`
- `app/components/StaffManagement.jsx` — `HOT_DRINK` role chip + shared-role PIN reset path
- `scripts/seed-hot-drink-staff.mjs` (**new**) — idempotent HOT_DRINK Staff provisioning; `--reset-pin` opt-in; scrypt-hashed, never plaintext

### Menu catalog
- `lib/menuService.js` — `resolveCategoryStation` third resolution: explicit `targetStation`/`type` `HOT_DRINK` wins; historical coffee heuristic (name/slug) keeps resolving BARISTA until `scripts/migrate-hot-drink-station.mjs` is run
- `app/manager/menu-crud/actions.js` — `stationType(targetStation)` accepts `HOT_DRINK`; category/item writes accept third station
- `app/manager/menu-crud/MenuCrudClient.jsx` — third `HOT_DRINK` tab, filters, placeholders, optimistic updates

### Orders & state machine
- `lib/orderService.js` — `normalizeItem` HOT_DRINK inference; HOT_DRINK peer branch in `updateOrderStatus` (KITCHEN/BARISTA branches untouched); overall-READY generalized to "all present active stations are READY"; per-station attribution (`hotDrinkStaffId`, `hotDrinkPreparingAt`, `hotDrinkReadyAt`); generalized `cancelOrderItem` renormalization with guarded `hotDrinkStatus` write; `toKdsShape` exposes hot-drink status/timestamps/attribution and `type`/`cancelledStation` snapshots
- `app/api/orders/route.js` — station read scopes include `HOT_DRINK`
- `app/api/orders/[id]/route.js` — HOT_DRINK action authorization
- `app/api/orders/[id]/status/route.js` — HOT_DRINK status transition with attribution

### KDS board & portals
- `app/components/KitchenDisplay.js` — `station="HOT_DRINK"` support: scoped dest, labels, empty state text, session re-login route `/jebena`, station-aware optimistic merge, `cancelledStation` HOT_DRINK client filtering
- `app/jebena/layout.js` (**new**) — `getPortalSession("HOT_DRINK")` + `<PinGuard role="HOT_DRINK" next="/jebena" />`
- `app/jebena/page.js` (**new**) — renders `<KitchenDisplay station="HOT_DRINK" stationLabel="JEBENA BUNA ONLY" …/>`
- `app/login/page.js` — `/jebena` next-route mapping (`return "HOT_DRINK"`)
- `app/page.js` —_portal card (additive; file carries user work — no behavior overwritten)
- `app/components/PinGuard.js` / `app/components/PinLoginModal.js` — HOT_DRINK label + coffee icon

### Waiter tracking
- `app/components/WaiterUI.js` — HOT_DRINK classification (`targetStation`/`hotDrink` flag → type snapshot on submit) and generalized all-present-station chips (Kitchen/Barista/Jebena) on mixed orders

### Payment & cashier
- Payment engine untouched (deliberate): HOT_DRINK keeps no `orders:payment*` authority — cashier/manager flow unchanged and unweakened

### Reporting & revenue
- `lib/reportRevenueBreakdown.js` — third bucket `hotDrinkRevenue`; `unattributedRevenue = paid − food − drink − hotDrink`; `resolveItemType` accepts `HOT_DRINK`
- `lib/analytics.js` — `kpis.hotDrinkRevenue`
- `lib/reportService.js` — select exposes hot-drink fields for analytics
- `lib/cashierReport.js` — `projectCashierReportResponse` carries `revenue.hotDrink`
- `app/manager/reports/page.js` — 8th KPI card (HOT_DRINK revenue), `hotDrink` item filter/pill, third menu-performance group (Jebena), donut adds "Hot Drink" slice
- `app/components/CashierUI.jsx` — third revenue card + third menu-item group (4-col responsive grid)

### Translations
- `lib/translations.js` — `hotDrink`, `hotDrinkRevenue`, portal strings in am / en / om

### Migration (opt-in)
- `scripts/migrate-hot-drink-station.mjs` (**new**) — read-only by default; `--apply` retargets only BARISTA-resolving coffee/hot-beverage categories and their items to HOT_DRINK; **never writes to `orders`**

### Tests
- `tests/hot-drink-station.test.mjs` (**new**) — 28 tests: auth/provisioning, authorization boundaries, menu routing, state machine, station model/waiter chips, portal, payment/inventory isolation, revenue buckets, migration script safety
- `tests/staff-pin-canonical.test.mjs` — literal role-wide reset list updated (`HOT_DRINK` added) — assertion strengthened, not weakened
- `tests/cashier-report.test.mjs` — projection keys now also cover `hotDrink` — no assertion removed
- `scripts/test-menu-unification.mjs` — catalog enum source assertions updated to accept the third enum — no check removed

**Not intentionally touched:** `package.json`, `.env.example`, `app/components/ManagerSidebar.jsx` and all `hotel/*` paths — those modifications shown in `git status` are the user's pre-existing uncommitted work and were preserved byte-for-byte.

---

## 3. Verification results (actual, this run)

### Full regression suite
- Baseline (before Phase B): **980 tests pass, 0 fail**
- Final (after Phase B): **`ℹ tests 1008 · pass 1008 · fail 0 · cancelled 0 · skipped 0`** — exit code 0 (~47 s)
  - 980 original + 28 new in `tests/hot-drink-station.test.mjs`
  - `node scripts/test-menu-unification.mjs` standalone: **40 pass, 0 fail**, exit 0

### Production build
The default `next build` cannot run in this offline environment: `Geist` is fetched from
`fonts.googleapis.com` at build time by `app/layout.js` (untouched user code) and the sandbox has
no network access (`connect ETIMEDOUT 142.251.47.131:443`). The default Turbopack then also fails
to resolve its internal google-font module offline. This is **pre-existing and environmental**,
not caused by Phase B code.

To still compile-verify the produced code, the webpack builder was used with Next.js's documented
offline test hook `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` pointing at a minimal mock created in the OS
temp dir — **no repository file was modified** for this:

```
$env:NEXT_FONT_GOOGLE_MOCKED_RESPONSES = "<temp>\font-mock.json"
npx next build --webpack
# → EXIT_CODE=0
# ✓ Compiled successfully in 20.8s
# Running TypeScript … Finished  ✓
# Generating static pages (8/8) ✓
# Route table includes: ƒ /jebena   (alongside ƒ /barista, ○ /kitchen, ƒ /login …)
```

So: production compilation, TypeScript check, and route generation for the new portal all pass;
on a network-enabled machine the plain `next build` should behave identically.

---

## 4. Security notes

- **PINs** are stored only as scrypt hashes (`lib/pinCrypto`); `scripts/seed-hot-drink-staff.mjs` writes `hashPin(DEFAULT_HOT_DRINK_PIN)` — plaintext never reaches the DB.
- **Default PIN** `"5555"` is overridable via `DEFAULT_HOT_DRINK_PIN` env; the staff manager UI marks accounts `DEFAULT`/`CUSTOM` server-side (hash never returned).
- **Role-wide reset**: manager reset updates all `HOT_DRINK` staff atomically and revokes their sessions (`revokeRoleSessions(conn, 'HOT_DRINK', 'PIN_RESET')`).
- **Authority boundaries enforced in `lib/policy.js` and verified by tests**: HOT_DRINK may `PENDING→PREPARING→READY→(ARCHIVE its own station)` and cancel its own HOT_DRINK lines only; it may **not** create orders, serve, pay/confirm/submit payments, cancel whole orders, or mutate menu/staff/reports/inventory.
- **Portal guarding**: `/jebena` server layout requires a live HOT_DRINK staff session; expired/revoked sessions route back to PIN login for HOT_DRINK.
- **Attribution is server-derived**: `hotDrinkStaffId`/timestamps come from the session identity on the authenticated status endpoint, never from the client payload.

---

## 5. Historical compatibility

- **Orders are never mutated by migration**: `scripts/migrate-hot-drink-station.mjs` writes nothing to the `orders` collection; historical line `type` snapshots are immutable.
- **FOOD/DRINK numbers unchanged**: every line whose `type`/`categoryType` is FOOD or DRINK lands in exactly the same bucket as before; `hotDrinkRevenue` is a new, additive bucket. Regression test proves prior figures (60 food / 40 drink / 0 hot / 0 unattributed) reproduce exactly.
- **`unattributedRevenue` formula**: generalized `paid − food − drink − hotDrink`; zero-HOT-DRINK historical ranges produce the identical prior value.
- **Legacy ordering payloads**: `{ barista: true }` or DRINK categoryType → DRINK exactly as before; the `hotDrink: true` / `HOT_DRINK` categoryType inference is new and additive.
- **One/two-station READY behavior preserved**: orders without HOT_DRINK lines derive overall READY exactly as before (all-present-station generalization tested).
- **Inventory (D-6)**: `lib/inventoryWasteService.js`, `lib/inventoryAuditService.js`, `lib/models/InventoryAudit.js` contain no HOT_DRINK value — test-enforced.
- **Existing test suites**: no assertion was weakened; only intentional literal lists (role enums, projection keys) were extended.

---

## 6. Limitations

1. The plain `next build` (Turbopack default) could not be exercised on this machine because Google-Fonts fetching is network-blocked; the webpack builder was verified instead (see §3).
2. Historical coffee categories keep resolving to BARISTA until the operator runs the opt-in migration script — by design (D-2); the new HOT_DRINK menu items must be created via Menu Management or made via migration.
3. HOT_DRINK does not appear in inventory waste/audit actor allowlists (D-6) — deliberate.
4. `.env.example` was left untouched (it carries the user's uncommitted hotel changes); the override is documented here and in the seed script header: `DEFAULT_HOT_DRINK_PIN`.
5. Reports date-range caching and CSV export were not extended to include the new bucket's CSV columns beyond the existing KPI CSV path (KPI row carries the same computed `kpis.*`; a dedicated CSV column would be a separate change).

---

## 7. Operator runbook (migration & provisioning)

### Staff provisioning (idempotent)
```powershell
node --env-file=.env.local scripts/seed-hot-drink-staff.mjs                 # dry review
node --env-file=.env.local scripts/seed-hot-drink-staff.mjs --reset-pin     # create or reset role-wide PIN to default
```
Existing HOT_DRINK accounts are skipped unless `--reset-pin` is given explicitly.

### Catalog migration preview (read-only; no writes)
```powershell
node --env-file=.env.local scripts/migrate-hot-drink-station.mjs
```
Prints: database name, count of coffee/hot-beverage BARISTA categories matched,
each matched category slug/name, up to 25 (and total) menu items to retarget, and the
(unchanged) orders count. Expected plan line for a typical coffee catalog:
`CATEGORY coffee-ceremony — ...` / `ITEM Macchiato (...)`.
**Nothing is written** without `--apply`.

### Catalog migration apply
```powershell
node --env-file=.env.local scripts/migrate-hot-drink-station.mjs --apply
```
Retargets only the selected categories + their items (`targetStation/type = HOT_DRINK`, item
`station/categoryType = HOT_DRINK`). Re-running with `--apply` is a no-op (already-migrated
entities are excluded from selection). Orders are never written; historical revenue buckets keep
their old numbers (HOT_DRINK lines on future orders flow into `hotDrinkRevenue`).

### Post-migration verification
1. `/manager/staff` → HOT_DRINK role row present; PIN status `DEFAULT` until changed.
2. `/manager/menu-crud` → HOT_DRINK tab shows migrated items.
3. Waiter submits an order with a hot-drink item → `/jebena` board shows the order; `HOT_DRINK` chips appear in the waiter's mixed-order cards.
4. `/manager/reports` → KPI row shows HOT_DRINK revenue; cashier `/cashier` report grid shows the third card/group.

---

## 8. Uncommitted working tree

All Phase B changes are uncommitted on `main` (HEAD baseline `6965043` at start). Remaining
modified/untracked entries are either Phase B work (list in §2) or the user's preserved
pre-existing work (`hotel/*`, `pdfkit`, `ManagerSidebar.jsx`, `.env.example`, etc.). Nothing was
reverted, staged, or committed on the user's behalf.
