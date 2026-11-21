# JEBENA BUNA — THIRD PREPARATION STATION
## PHASE A — COMPLETE ARCHITECTURE AUDIT (REPORT ONLY • NO CODE MODIFIED)

> **Status:** Audit complete — 2026-10-31.
> **Scope:** Read-only. Zero code, schema, API, UI, dependency, or config changes were made.
> **Internal role name:** `HOT_DRINK` • **User-facing label:** JEBENA BUNA
> **Verification method:** full repo walk + grep inventories; every claim below cites a file/line that was inspected.

---

## 0. EXECUTIVE SUMMARY

The codebase has a **clean, canonical, deliberately two-station architecture**. `KITCHEN` (FOOD) and `BARISTA` (DRINK) share one KDS component, one station model (`lib/stationStatus.js`), one order state machine (`lib/orderService.js`), one auth system (per-Staff scrypt PINs in `staffs`, resolved via Session → live Staff), and one policy matrix (`lib/policy.js`). The two-station constraint is enforced by **hardcoded binary classifications** in ~30 locations (verified inventory in §10).

A third station is **feasible without a single destructive or quality-of-architecture compromise**, because the existing design is additive-friendly:

- `Order.kitchenStatus`/`baristaStatus` were added as *nullable additive fields* precisely for per-station lifecycles — `hotDrinkStatus` follows the identical pattern.
- Session roles, Staff roles, policy MATRIX, and the `dest` order filter are simple allowlists.
- Inventory deduction is keyed on `item.itemId → Recipe.menuItemId` — **item type/station play no role in deduction** (verified `lib/inventoryDeductionService.js:20–213`), so requirement 15 is satisfied by design.
- Payment lifecycle (`SERVED → PAYMENT_PENDING → PAID`), idempotency, and snapshots are station-agnostic.

**Critical findings that shape the design:**

1. **There are no "shared role PIN" secrets anymore.** AUTH-ARCH-8B/8F replaced shared secrets with one Staff row per identity (`lib/staffService.js:6–16`). However, for KITCHEN/BARISTA/MANAGER the *PIN is managed per-role*: `POST /api/manager/staff` does `Staff.updateMany({ role }, { pinHash })` (`app/api/manager/staff/route.js:279`) and `/api/auth/verify-pin` logs in as the first Staff row of the role whose PIN verifies (`app/api/auth/verify-pin/route.js:92–120`). HOT_DRINK's "separate shared 4-digit PIN" is therefore implemented by **joining the existing role-PIN mechanism (2 list entries), not by building a duplicate auth system**.
2. **The station routing key is `items[].type`** (`FOOD|DRINK`), not a stored station field. A third station requires a decision on the **order-line type** (Decision D-1 below). Recommended: extend `ITEM_TYPE` with the third value `"HOT_DRINK"`.
3. **Overall order readiness is a server-derived result**: mixed orders are READY only when every applicable station is READY (`lib/orderService.js:532–552`). The aggregation pipeline in `updateOrderStatus` is the single riskiest file (§6, §12).
4. **Manager menu CRUD is strictly two-tab** (`MenuCrudClient.jsx:57`, tabs at `755–756`, mobile `786–787`); `actions.js` classifies station with binary ternaries (`107, 115, 135, 219, 241, 325–326, 338, 460–467`). Every one of these must become three-way.
5. **Reporting has type-splits**: `resolveItemType` in `lib/reportRevenueBreakdown.js:10–15` accepts only `FOOD|DRINK` (a third type would fall out as *unattributed* until updated), and per-station duration helpers exist in `lib/analytics.js:216–259`.
6. Tests assert current role literals literally (e.g. `tests/staff-pin-canonical.test.mjs:108` asserts the exact `["KITCHEN","BARISTA","MANAGER"]` list) — listed as regression surfaces.

---

## 1. CURRENT KITCHEN/BARISTA ARCHITECTURE (AS-FOUND)

### 1.1 Station data flow (canonical, documented in `lib/stationStatus.js:1–17`)

```
Staff.role (LIVE via Session → staffs)                 ← authorization (server-only)
        ↓ stationForRole()
station ("KITCHEN" | "BARISTA")
        ↓ STATION_ITEM_TYPE / STATION_STATUS_FIELD
station-scoped lines  (items[].type, not cancelled)
station-scoped status (kitchenStatus / baristaStatus)
        ↓ UI button model
START_PREP (PENDING) → MARK_READY (PREPARING) → null (READY)
        ↓ server aggregation
overall order.status DERIVED (mixed: READY only when ALL required stations READY)
```

Key invariants (all verified):

| Invariant | Source of truth |
|---|---|
| Station keyspace = `{KITCHEN, BARISTA}` | `lib/stationStatus.js:19` |
| `FOOD ↔ KITCHEN`, `DRINK ↔ BARISTA` | `lib/stationStatus.js:21–24` |
| Status field map `kitchenStatus`/`baristaStatus` | `lib/stationStatus.js:26–29` |
| Per-station lifecycle `PENDING → PREPARING → READY` (SERVED/PAID/CANCELLED unreachable from here) | `lib/orderService.js:426–437` |
| Overall status never drives a station button (client never derives overall) | `lib/stationStatus.js:83–90` + `KitchenDisplay.js:593–601` |
| Atomics: expected station state inside the update filter → races miss cleanly | `lib/orderService.js:503–513` |
| ARCHIVE = soft dismiss, row stays for sales history, PAID refused | `lib/orderService.js:954–965` |

### 1.2 Authentication (one mechanism — AUTH-ARCH-8F)

- **Waiter:** username + personal PIN → `POST /api/auth/login-staff` (`app/api/auth/login-staff/route.js`).
- **KITCHEN/BARISTA/CASHIER/MANAGER:** PIN-only → `POST /api/auth/verify-pin` (`app/api/auth/verify-pin/route.js`): rate-limited 5/60s (`lib/rateLimit.js:76`), rejected for WAITER (lines 68–73), loads `Staff.find({ role })` and verifies each `pinHash` (scrypt, `lib/pinCrypto`); creates an opaque Session + `__Host-bono_session` (HttpOnly, SameSite=Strict) + memory-only tab credential (`X-Bono-Tab-Session`).
- **Login UI is path-derived, not role-selected:** `app/login/page.js:6–11` maps `next=` prefix to role; `/kds|/kitchen → KITCHEN`, `/barista → BARISTA`; `PinGuard` renders PIN keypad for non-WAITER (`PinGuard.js:112–153`).
- **Role authority is always live:** `Session → Staff.findById → Staff.role` (`lib/serverAuth.js:95–151`); `roleSnapshot`, cookies, client state never authorize.
- **Role-PIN management:** manager resets a role's PIN by `updateMany` over all Staff rows of that role + `revokeRoleSessions(role, "PIN_RESET")` (`app/api/manager/staff/route.js:272–308`). Default seeds: `KITCHEN=2222`, `BARISTA=3333` (`lib/config/security.js:7–8`, `scripts/seed-auth.js:15–19`).

### 1.3 Boards & portals (one shared KitchenDisplay, two consumers)

| Portal | Files | Guard | Board mount |
|---|---|---|---|
| KITCHEN | `app/kds/{layout,page}.js` (+ legacy `app/kitchen/` redirect) | `getPortalSession("KITCHEN")` else `PinGuard role="KITCHEN" next="/kds"` | `<KitchenDisplay station="FOOD" stationLabel="KITCHEN ONLY" title="KITCHEN" />` |
| BARISTA | `app/barista/{layout,page}.js` | `getPortalSession("BARISTA")` else `PinGuard role="BARISTA" next="/barista"` | `<KitchenDisplay station="DRINK" stationLabel="BARISTA ONLY" title="BARISTA" />` |

`KitchenDisplay.js` (881 lines) is the single board: SSE-first (`/api/events` + `orders-changed`/`ORDER_READY`), 30 s visibility-gated poll fallback; fetches `GET /api/orders?status=ACTIVE&dest=FOOD|DRINK`; station buttons map through `stationForView → stationStatusOf → stationActionOf`; item cancel stamps `cancelledStation: view === "DRINK" ? "BARISTA" : "KITCHEN"` (line 457); optimistic per-station updates only touch the station's own status field.

### 1.4 Order lifecycle & routing (server-authoritative)

- **Create:** `POST /api/orders` (WAITER/MANAGER). `createOrder` snapshots price/name/type from MenuItem docs (`resolveCatalogLine`, `lib/orderService.js:202–217`: `categoryType > targetStation/station > client hint`), initializes `kitchenStatus: hasFood ? "PENDING" : null`, `baristaStatus: hasDrink ? "PENDING" : null` (`375–394`).
- **Prep transitions:** `PATCH /api/orders/[id] {status}` — PREPARING/READY restricted to KITCHEN/BARISTA/MANAGER (policy `lib/policy.js:56–57`); role-scoped `$elemMatch` on type+`cancelled` (NO top-level `$ne` predicate — documented array-predicate bug avoidance, `orderService.js:489–508`); race-proofed by expected station state inside the atomic filter; per-station timestamps + `kitchenStaffId`/`baristaStaffId` attribution set server-side from session only (client IDs ignored).
- **Item cancel:** `CANCEL_ITEM` action (KITCHEN/BARISTA/MANAGER), line-type ownership enforced, blocked once that station `READY`; last-line-cancel renormalizes station status to null.
- **Waiter gates:** SERVE only from overall `READY` (`serveOrder` filter `status:"READY"`); SERVED → `PAYMENT_PENDING` (waiter) → `PAID` (CASHIER/MANAGER confirm) → deduction on confirm.
- **Waiter drawer shows per-station chips** for mixed orders (`WaiterUI.js:1790–1808`).

---

## 2. COMPLETE FILE & DEPENDENCY MAP (station-relevant slice)

```
lib/
  stationStatus.js ............ PURE station model (no DB) — §extension point E1
  policy.js ................... ROLES/GROUPS/MATRIX — E2
  orderService.js ............. state machine, station branches, toKdsShape — E3
  menuService.js .............. STATIONS/CATEGORY_TYPES, station heuristics — E7
  staffService.js ............. verifyStaffPin/changePin (role-generic, no change)
  models/Staff.js ............. STAFF_ROLES — E4
  models/Session.js ........... SESSION_ROLES (roleSnapshot enum) — E4
  models/Order.js ............. ITEM_TYPE, cancelledStation, station fields — E5
  models/MenuItem.js .......... station/targetStation/categoryType enums — E7
  models/Category.js .......... targetStation/type enums + sync hook — E7
  validate.js ................. ROLES allowlist (gates verify-pin/login-staff) — E6
  config/security.js .......... DEFAULT_KITCHEN_PIN/DEFAULT_BARISTA_PIN — E8
  analytics.js ................ per-station duration helpers (216–259), item type KPIs
  reportRevenueBreakdown.js ... resolveItemType FOOD|DRINK only (10–14)
  inventoryDeductionService.js  type/station-agnostic (no change)
  security.js serverAuth.js sessionStore.js ... role-generic resolvers (no change)
  eventHub.js orderEvents.js .. generic pub/sub (no change)

app/
  page.js ..................... PORTALS tiles (52–85), role icons (30–49), MOBILE_GRID_ORDER
  login/page.js ............... roleFromNext prefix map (6–11)
  kds/{layout,page}.js barista/{layout,page}.js kitchen/page.js ... guards/boards
  components/KitchenDisplay.js  THE board (station prop hardcodes at 9 sites)
  components/WaiterUI.js ...... item type classification (966), mixed chips (1790–1808)
  components/PinGuard.js ...... ROLE_LABEL + role branch (10–15, 214–227)
  components/PinLoginModal.js . role icons (118–125)
  components/StaffManagement.jsx  ROLES list (46), shared-role PIN modal (969)
  components/CashierUI.jsx .... FOOD/DRINK report filters (783–784, 1145)
  components/ManagerSidebar.jsx MANAGER nav (no change needed — see §5.4)
  manager/menu-crud/{page.jsx,MenuCrudClient.jsx,actions.js} ... TWO-tab menu CRUD — E9
  api/orders/route.js ......... dest filter (174–180), role station scoping (189–192) — E10
  api/orders/[id]/route.js .... PREPARING/READY branch (284–299), ORDER_READY publish
  api/orders/[id]/status/route.js  alias branch (100–115)
  api/auth/verify-pin/route.js  role-generic beyond validate ensurelist (no logic change)
  api/manager/staff/route.js .. shared-PIN role lists (279, 305) — E8
  api/staff/route.js .......... pinStatus default map (45–63)
  api/menu/route.js ........... delegates to menuService (no change)
  api/events/route.js ......... generic SSE (no change)

scripts/ seed-auth.js, reset-auth.js (DEFAULT_PINS), fixPins2.js · seed-menu-json.mjs,
         sync-food-menu-json.mjs (FOOD/DRINK station invariants) — E11
tests/  25+ suites assert station/role state (inventory in §11)
```

Dependency chain for one new station value `"HOT_DRINK"`:

```
Staff.STAFF_ROLES ─┬─ Session.SESSION_ROLES ─ login/verify-pin accept → session issues
lib/validate ROLES ─┘
policy.ROLES/MATRIX + GROUPS ─── requireAuth/canTransition everywhere
stationStatus.STATIONS/… ─── KitchenDisplay, orderService scoping, tests
models( MenuItem/Category/targetStation, Category.type, Order.ITEM_TYPE,
        Order.cancelledStation, hotDrinkStatus fields )
menu-crud tabs/actions ─── catalog writes with station="HOT_DRINK"
orderService (type routing + third status field + overall derivation)
```

**Order matters**: models must be loosened *before* any catalog/UI write of the new value, or Mongoose enum validators reject it (all relevant schemas are `strict: true` since Phase 3).

---

## 3. EXACT FILES REQUIRING MODIFICATION (Phase B scope) — with WHY + affected behavior

> Naming used in this report: role = `HOT_DRINK`; station key = `HOT_DRINK`; item type = `HOT_DRINK` (Decision D-1); status field = `hotDrinkStatus`; audit field = `hotDrinkStaffId`; UI label = **JEBENA BUNA**; portal route = `/jebena`.

### 3.1 Core model & policy (pain ordering: do first)

| # | File | Change | WHY | Behavior affected |
|---|---|---|---|---|
| 1 | `lib/models/Staff.js` (line 3) | Add `"HOT_DRINK"` to `STAFF_ROLES` | Root role enum; `isValidRole` gates `verify-pin`/`login-staff` | HOT_DRINK logins become possible |
| 2 | `lib/models/Session.js` (line 26) | Add to `SESSION_ROLES` | `roleSnapshot` enum rejects unknown values (`sessionStore.buildSessionDoc`) | HOT_DRINK sessions can be created & revoked by role |
| 3 | `lib/policy.js` (14–35, 56–63) | Add `ROLES.HOT_DRINK`; extend `ALL_ROLES`; add `GROUPS.HOT_DRINK_OR_MANAGER` (and audit uses of `KITCHEN_OR_BARISTA_OR_MANAGER` / `WAITER_KITCHEN_BARISTA` per endpoint); extend `orders:transition:PREPARING/READY/ARCHIVED` and `orders:cancel:item` | Single authorization authority; without matrix entries `can()` fails closed | Station staff may start/mark-ready/cancel-own-line/archive hot-drink tickets; no other role gains anything |
| 4 | `lib/validate.js` (5, 397) | Add `HOT_DRINK` to roles list + error strings | `validateRole` gates `/api/auth/verify-pin`, `/api/staff` | Login/route validation accepts role |
| 5 | `lib/stationStatus.js` (19–50) | Add `"HOT_DRINK"` to `STATIONS`; `STATION_ITEM_TYPE.HOT_DRINK="HOT_DRINK"`; `STATION_STATUS_FIELD.HOT_DRINK="hotDrinkStatus"`; extend `stationForView` & `stationForRole` | The pure model every consumer + test shares; must never drift | Board buttons/status/filter logic becomes three-station aware |
| 6 | `lib/models/Order.js` (23, 69, 101–102, 149–154) | Add `"HOT_DRINK"` to `ITEM_TYPE` and item `type` enum (line 57); add `"HOT_DRINK"`/`"JEBENA"` (D-2) to `cancelledStation` enum; add nullable `hotDrinkStatus` (same enum pattern as `kitchenStatus`), `hotDrinkPreparingAt`, `hotDrinkReadyAt`, `hotDrinkStaffId` | Additive nullable fields — the exact pattern used to add barista independence historically | New orders route/track hot drinks; **legacy orders untouched** (their fields stay null) |
| 7 | `lib/models/MenuItem.js` (32–45) | Extend `categoryType`, `station`, `targetStation` enums with `"HOT_DRINK"`; keep alias sync hook (already maps station↔targetStation generically) | Catalog write validator: otherwise JEBENA items are rejected by Mongoose | New/existing items can target JEBENA BUNA; sync hook works unchanged |
| 8 | `lib/models/Category.js` (22, 33–36) | Extend `targetStation` + `type` enums; update pre-validate ternary to three-way | Category/type mirror must not force HOT_DRINK categories back to FOOD/DRINK | Categories can belong to the station; type sync stays consistent |

### 3.2 Order pipeline (the risky core)

| # | File | Change | WHY | Behavior affected |
|---|---|---|---|---|
| 9 | `lib/orderService.js` — `resolveCatalogLine` (202–217) | Add `HOT_DRINK` resolution branch from `targetStation === "HOT_DRINK"` | Server-authoritative routing (requirement 10) | Hot-drink lines snapshot as type `HOT_DRINK` regardless of client hint |
| 10 | `lib/orderService.js` — `createOrder` (375–398) | init `hotDrinkStatus: hasHot ? "PENDING" : null` + `hotDrinkPreparingAt/ReadyAt: null` | Ticket must appear PENDING on the JEBENA board when it contains hot-drink lines | Creates awake mixed three-station orders |
| 11 | `lib/orderService.js` — `updateOrderStatus` (434–771) | Add `isHotDrink` branch: pre-read check, `touched` third station, `stationMatch` `$elemMatch {type:"HOT_DRINK", cancelled:{$ne:true}}`, filter on `hotDrinkStatus`, mixed overall expression becomes READY only when **all three** applicable stations READY, pipeline `$set` of `hotDrinkStatus` + `hotDrinkPreparingAt/ReadyAt`, READY attribution `hotDrinkStaffId` | This single function owns per-station sequencing, race-proofing, and the derived overall status — all three must now be three-station-aware | KITCHEN & BARISTA behavior must remain byte-identical; HOT_DRINK gets identical guarantees; guarded by regression tests (§11) |
| 12 | `lib/orderService.js` — `cancelOrderItem` (1021–1168) | `isHotDrink` branch (role gate, line-type ownership, station-READY block, `cancelledStation` stamp, renormalization of `hotDrinkStatus` incl. active-only re-derivation) | Mirror existing station-scoped cancellation exactly | JEBENA staff can cancel own lines; last-line cancel resets station status |
| 13 | `lib/orderService.js` — `toKdsShape` (1568–1587, 1609–1612) | Expose `hotDrinkStatus`, `hotDrinkStaffId`, `hotDrinkPreparingAt/ReadyAt`, per-item already generic | KDS/waiter/manager consume the projection | Clients receive hot-drink state |
| 14 | `lib/orderService.js` — `editOrderItems` (1257–1282) | Verify `add` op snapshot through updated `resolveCatalogLine` (no branch needed) | Added lines must classify correctly | Quantity/edit flows stay PENDING-gated (no change to lock semantics) |

### 3.3 API routes

| # | File | Change | WHY | Behavior affected |
|---|---|---|---|---|
| 15 | `app/api/orders/route.js` (174–181, 189–192) | Extend `dest` allowlist with `HOT_DRINK`; role branch: `role === "HOT_DRINK"` → station-scoped membership | Boards fetch their scoped tickets through `dest`; role-based read ownership | JEBENA board gets only hot-drink work; waiter read scope unchanged |
| 16 | `app/api/orders/[id]/route.js` (284–299) | READY attribution: `role === "HOT_DRINK"` → `hotDrinkStaffId`; auth comments | Attribution for manager reporting (idempotent first-write-wins, same as other stations) | Fulfillment-speed KPI per station; no overwrite on re-read |
| 17 | `app/api/orders/[id]/status/route.js` (100–115) | Same attribution mapping in alias route | Parity so both canonical routes behave identically | Same as #16 |
| 18 | `app/api/manager/staff/route.js` (273–308) | Add `HOT_DRINK` to both `["KITCHEN","BARISTA","MANAGER"]` lists (role-wide PIN reset + `revokeRoleSessions`) | Requirement 8: manage JEBENA PIN via the existing authorized staff/PIN mechanism — no duplicate system | Manager resets one shared JEBENA PIN atomically + revokes all HOT_DRINK sessions |
| 19 | `app/api/staff/route.js` (45–63) | Add `DEFAULT_HOT_DRINK_PIN` to default-vs-custom `pinStatus` map | Staff table shows whether JEBENA PIN is still the seeded default | Manager UI PIN status badges |
| 20 | `app/api/auth/verify-pin/route.js` | **No logic change expected** (role-generic beyond `validateRole`) — verify with test that `Staff.find({role:"HOT_DRINK"})` path works | Prevent accidental dual-auth branching | One shared login mechanism for all stations |

### 3.4 Menu Management (JEBENA BUNA tab) & catalog

| # | File | Change | WHY | Behavior affected |
|---|---|---|---|---|
| 21 | `app/manager/menu-crud/MenuCrudClient.jsx` (57, 65–75, 177, 284, 332–334, 355–357, 644, 690–692, 755–756, 786–787) | Third `activeTab` value `HOT_DRINK` (label JEBENA BUNA); tab-filter comparisons accept three stations; category/item forms set `targetStation=HOT_DRINK` on that tab; placeholders for coffee items | Requirement 4: dedicated navigation tab inside Menu Management with full independent CRUD | Manager creates/edits/deletes JEBENA categories & items (prices, trilingual names/descriptions, images, availability, fasting flags, special/new) |
| 22 | `app/manager/menu-crud/actions.js` (107, 115, 135, 219, 241, 325–331, 338, 339–340, 460–471) | Replace every binary `BARISTA?…:KITCHEN` ternary with three-way station resolution (from active tab/category); the `coffee` slug regex (line 326) must stop force-defaulting coffee to BARISTA when tab says HOT_DRINK | Without these, JEBENA items are silently re-routed to KITCHEN/BARISTA at write time | Catalog integrity: what the manager saves is what routes |
| 23 | `lib/menuService.js` (16–29, 71–75) | Extend `STATIONS`; three-way `resolveCategoryStation`/item station inference; keep `getUnifiedMenu` flat (tabs are consumer concern) | Single canonical mapping; menu API parity for `/api/menu` consumers | Waiter/UI receive correct station tags; new items appear in JEBENA scope |

### 3.5 UI surfaces (boards, portals, login, waiter, staff mgmt, cashier)

| # | File | Change | WHY | Behavior affected |
|---|---|---|---|---|
| 24 | **NEW** `app/jebena/layout.js` + `app/jebena/page.js` | `getPortalSession("HOT_DRINK")` guard → `PinGuard role="HOT_DRINK" next="/jebena"`; page mounts `<KitchenDisplay station="HOT_DRINK" stationLabel="JEBENA BUNA" title="JEBENA BUNA" />` | Requirement 11: dedicated board reusing the existing KitchenDisplay architecture | Third preparation board, structurally identical to /kds and /barista |
| 25 | `app/components/KitchenDisplay.js` (9 hardcoded sites: 105, 126, 166, 183–184, 234, 457, 612, 789) | Third `station` prop value: dest token, status-field choice, cancelled-station stamp, re-login route map, pending-merge map key | One board component stays the single KDS implementation | JEBENA board behaves atomically-identically |
| 26 | `app/login/page.js` (6–11) | `next.startsWith("/jebena") → "HOT_DRINK"` | Direct-URL station login |agents landing on /jebena get JEBENA PIN pad |
| 27 | `app/page.js` (30–49, 52–85, 93–101) | `PORTALS` entry (role HOT_DRINK, route `/jebena`, icon `IconTeaCup`-class), `MOBILE_GRID_ORDER` | Portal hub discoverability (existing stations are portal tiles) | Homepage tile for JEBENA BUNA |
| 28 | `app/components/PinGuard.js` (10–15) | `ROLE_LABEL.HOT_DRINK = "Jebena Buna Display"` | Station login presentation | Correct label/copy |
| 29 | `app/components/PinLoginModal.js` (118–125) | Icon mapping entry | Same | Hub modal icon |
| 30 | `app/components/WaiterUI.js` (966, 967–978, 1790–1808) | Classification: `targetStation === "HOT_DRINK" → type "HOT_DRINK"`; mixed-order station chips gain hot-drink status | Requirement 12: waiter tracking/mixed readiness — readiness gate itself is server-derived (overall READY), so UI only needs classification + status chips | Waiter sees JEBENA station progress; SERVE unlocks only when hot drinks READY too |
| 31 | `app/components/StaffManagement.jsx` (46, 969) | Add HOT_DRINK to roles list & shared-role PIN note | Requirement 8 surfaced in UI | Manager sees/manages JEBENA PIN |
| 32 | `app/components/CashierUI.jsx` (783–784) | Decision-driven: extend FOOD/DRINK report filters or fold HOT_DRINK under DRINK (D-3) | Reporting consistency | Cashier report buckets |
| 33 | `lib/translations.js` | New keys (portal, description, role label, board title) am/en/om | i18n parity | Localized labels |

### 3.6 Ops / scripts / config

| # | File | Change | WHY | Behavior affected |
|---|---|---|---|---|
| 34 | `lib/config/security.js` (7–12) | `DEFAULT_HOT_DRINK_PIN` (env `DEFAULT_HOT_DRINK_PIN`) + validation loop | Consistent default-PIN provisioning (never hardcoded menu/credential data in app code) | Production guard parity |
| 35 | `scripts/seed-auth.js`, `scripts/reset-auth.js` | Add HOT_DRINK default account to `DEFAULT_PINS` (+ output) | Provision the station operator staff rows (manager UI creates only WAITER/CASHIER) | Ops bootstrap |
| 36 | **NEW** optional `scripts/migrate-hot-drink-station.mjs` | Read-only by default; `--apply` retargets *existing coffee/hot-beverage* categories/items from `BARISTA→HOT_DRINK` (only when operator opts in) | Requirement 13/9: current coffee categories resolve to BARISTA (slug/coffee regex + `type DRINK`); the owner must choose whether existing items move stations or stay | Historically safe: only catalog docs touched; orders keep their snapshot `type`, so historical orders/reports are 100% untouched |

### 3.7 Reporting (decision-driven, Phase B slice)

| # | File | Change | WHY |
|---|---|---|---|
| 37 | `lib/reportRevenueBreakdown.js` (10–14, 69–70) | Extend `resolveItemType`; second/third bucket per D-3 | A third `type` currently falls out as *unattributed* — must be attributed deliberately |
| 38 | `lib/analytics.js` (216–259, 519) | Optional third per-station duration helper / KPI split (or fold hot drink into beverage metrics per D-3) | Manager analytics continue meaningful |

---

## 4. NEW FILES & ROUTES

| Path | Kind | Purpose |
|---|---|---|
| `app/jebena/layout.js` + `app/jebena/page.js` | Route | JEBENA BUNA KDS portal (guard + board mount), mirroring `app/kds`/`app/barista` |
| *(No new API route)* | — | All APIs are role/type-parametrized; `/api/auth/verify-pin`, `/api/orders`, SSE all work as-is once allowlists are extended. Deliberately **no** `/api/hot-drink/*` — no second API surface, no duplicate auth system |
| `scripts/migrate-hot-drink-station.mjs` | Ops (optional) | Opt-in catalog retargeting BARISTA→HOT_DRINK for coffee categories |
| `tests/hot-drink-*.test.mjs` | Tests | See §11 |

---

## 5. MENU CRUD ARCHITECTURE (Requirement 4/5)

**Both requirements are already met architecturally by categories + tabs — the third station slots in, and no parallel CRUD system is created:**

1. **CRUD implementation is Server Actions, not API routes** — `app/manager/menu-crud/actions.js`: `createCategory`, `updateCategory`, `deleteCategory` (transactional cascade with intra-transaction recount), `createMenuItem`, `updateMenuItem` (partial `$set`, availability ↔ `inStock` alias), `deleteMenuItem`; all behind `assertManager()` (tab credential from FormData `tabSession` → cookie fallback → MANAGER role), then `revalidateAll()` (5 paths + SSE `menu-changed`). All CRUD primitives (categories, items, prices, trilingual descriptions, imagery via Cloudinary upload → URL-only storage, availability, special/new/fast-fasting flags) already exist and are station-generic **except** the hardcoded two-way station classification.
2. **The only two-station hardcodes in CRUD** are: (a) client tab state + `fd.set('targetStation', activeTab)` (MenuCrudClient lines 57, 177, 284); (b) the binary ternaries in actions.js listed in §3.4 #22; (c) `menuService` fallback heuristics.
3. **Design for Phase B:** add a third tab (`HOT_DRINK`). Category scoping by tab works identically because `Category.targetStation` is an enum string (not fixed 2-way logic in the DB). Item form fields (price/description/image/availability) require **zero changes** — they are station-agnostic.
4. **Waiter tab discovery is automatic:** category pills (`WaiterUI.js:1451–1481`) render *all* categories — a JEBENA category immediately becomes an ordering tab with no WaiterUI change beyond per-line type classification.
5. **ManagerSidebar**: no separate sidebar entry needed (requirement says tab *inside* Menu Management); sidebar intentionally omits stations today (`ManagerSidebar.jsx:19–27`).

**Catalog data never invented:** CRUD remains database-backed; the seed JSON files (`food_menu.json`, `drink_menu.json`) are consumed only by ops scripts (`scripts/sync-food-menu-json.mjs`, `scripts/seed-menu-json.mjs`) — nothing reads them at runtime (verified: 11 matches, all script/test files).

---

## 6. HOT_DRINK AUTHENTICATION & SHARED PIN DESIGN (Requirements 6/7/8)

**Principle: extend the existing ADV-8B/8F single auth mechanism; never add a second one.**

```
JEBENA staff arrives  /jebena  → layout guard getPortalSession("HOT_DRINK") (cookie → live Staff)
                         │            else <PinGuard role="HOT_DRINK" next="/jebena"/>
                         ▼
        PIN keypad → POST /api/auth/verify-pin { role: "HOT_DRINK", pin }
                         │  - validateRole (lib/validate extended)
                         │  - rate limited 5/60s (unchanged generic bucket)
                         │  - Staff.find({ role: "HOT_DRINK" }) → first scrypt-verified row wins
                         ▼
        createSession (SESSION_ROLES extended) + __Host-bono_session + tab credential
                         ▼
        Every subsequent call re-resolves LIVE Staff.role → policy.can(...) — HMAC/snapshot none
```

**Shared-PIN semantics (exactly how KITCHEN/BARISTA work today, verified):**
- Staff rows for HOT_DRINK are provisioned by ops seed (`scripts/seed-auth.js`), each with scrypt-hashed `pinHash` (`pinCrypto`). Default `DEFAULT_HOT_DRINK_PIN` from `lib/config/security.js` (env-overridable, parity with `DEFAULT_BARISTA_PIN`).
- `POST /api/manager/staff` treats role-PIN targets uniformly: `updateMany({role:"HOT_DRINK"}, {$set:{pinHash}})` + `revokeRoleSessions("HOT_DRINK","PIN_RESET")` (line 279/305 — add role to both lists). This is the entire §7 requirement — **`verifyStaffPinById`, `change-pin` self service, rate limits, tab sessions all work unmodified because they are role-generic.**

**Why this is not a new auth system:** sessions, cookies, tab transport, revocation, step-up, hashing, and rate limiting are all untouched; only *allowlist membership* grows. Existing `IsDeprecated`-style dual paths (login-staff vs verify-pin) are preserved exactly with their role split.

---

## 7. ORDER ROUTING & HOT-DRINK STATUS LIFECYCLE DESIGN (Requirements 9/10)

### 7.1 Routing (server-authoritative, per item)

```
MenuItem.targetStation === "HOT_DRINK"  (canonical; alias `station` mirrored by validate hook)
        ↓  snapshot at order time (resolveCatalogLine — priority categoryType > targetStation > hint)
items[].type = "HOT_DRINK"              (stored on the line, immutable snapshot)
        ↓  server scopes: $elemMatch { type:"HOT_DRINK", cancelled:{$ne:true} }
hotDrinkStatus ∈ {null, PENDING, PREPARING, READY}
hotDrinkPreparingAt/ReadyAt, hotDrinkStaffId (audit, first-write-wins)
```

- The client hint chain remains a *hint only* (requirement: trust server routing).
- `dest=HOT_DRINK` extends the existing board read filter; compound index `{ status: 1, "items.type": 1, createdAt: -1 }` is a multikey index — **new type values are automatically covered; no new index required.**

### 7.2 Lifecycle (independent, mirroring existing stations precisely)

```
 Per hot-drink ticket (hasHotDrink active lines):
   null→PENDING (order created) → PREPARING (JEBENA START_PREP) → READY (MARK_READY)
 Guards identical to kitchen/barista:
   - strict sequence (READY only from PREPARING; PREPARING/PENDING only from null/PENDING)
   - atomic filter embeds expected prior state + terminal-state $nin + $elemMatch type/cancelled
   - single aggregation-pipeline write; miss-path reproduces exact HTTP error semantics
 Overall order status derivation becomes N-way:
   READY only when EVERY applicable station (kitchen/barista/hotDrink) is READY;
   PREPARING when any started; PENDING otherwise; single-station orders pass through directly
 Lifecycle untouched: SERVED (overall READY) → PAYMENT_PENDING → PAID / CANCELLED / ARCHIVED;
   item-cancel rules replicate per station; all-lines-cancelled ⇒ whole CANCELLED (unchanged)
```

**Mixed-order readiness (requirement 12):** the SERVE gate is server-side (`serveOrder filter status:"READY"`), so a waiter physically cannot serve until JEBENA (plus Kitchen) are done; waiter drawer gains a third status chip. No client-side gate change is required beyond displaying `hotDrinkStatus`.

---

## 8. WAITER & MIXED-ORDER INTEGRATION (Requirement 12)

| Aspect | Integration point | Notes |
|---|---|---|
| Classification | `WaiterUI.js:966` add `targetStation === "HOT_DRINK" → "HOT_DRINK"` (before the BARISTA/FOOD fallbacks) | Server is still authoritative; stale/local fallback methods (`item.barista`) unchanged |
| Ordering UX | Category pills render the new JEBENA categories automatically | No foundation change |
| Tracking | Active-orders poll stays `GET /api/orders` (session-enforced waiter ownership `orders/route.js:185–188`) | New lines flow through existing shapes; no new endpoint meets requirement 12 |
| Readiness | Overall READY gate already server-derived; extend derivation to 3 stations | Waiter does not mark hot-drink status ever |
| Station chips | Extend the mixed drawer chips (line 1790–1808) with `hotDrinkStatus` | Display-only |
| SSE | `ORDER_READY`/`orders-changed` payloads are station-agnostic | **Pre-existing gap (out of scope, report-only note):** `ORDER_READY` payload lacks `waiterId`/`tableNumber`, so waiter-toast matching relies on the poll diff (`subagent-verified`, `app/api/orders/[id]/route.js:329–335`). Unchanged behavior for all three stations; optionally fixed in Phase B+ |

---

## 9. DATABASE MIGRATION & BACKWARD COMPATIBILITY (Requirement 13)

**No destructive migration is required for any existing data.** Everything is additive:

| Concern | Verdict | Basis |
|---|---|---|
| Historical orders (`items[].type` FOOD/DRINK) | **Preserved byte-identical** | Type enum is extended, not changed; old docs revalidate untouched (`updateOrderFields` uses `runValidators:false`); `toKdsShape` reads old lines fine |
| Historical kitchen/barista statuses, timestamps, attribution | Preserved | New fields only; all defaults `null` |
| Old reports/analytics | Preserved | `resolveItemType` changes are *additive* (FOOD/DRINK keep exact buckets); zero recount risk |
| Payment correctness | Unaffected | Payment lifecycle never consults station/type |
| Inventory deduction idempotency | Unaffected | Deduction keyed on `itemId → Recipe`, idempotency via `StockMovement {refOrderId, reason:"SaleDeduction"}` lookup; **station/type execute no role** (verified `inventoryDeductionService.js` §5 report; `payment-rejection-resubmit.test.mjs` asserts deduct-only-on-confirm boundaries stay) |
| Menu aliases (`category/categoryId`, `station/targetStation`, …) | Unchanged | Third value flows through the same alias sync hooks |
| Orders indexes | Unchanged | Existing `{status,"items.type"}` compound covers new values (multikey) |
| Session/Staff data | Unchanged | Additive enum values; history preserved |

**Forward migration checklist (Phase B execution order — enforced sequencing):**

1. Extend model enums + add nullable order fields (models first — validators must accept the new value before anything writes it).
2. `scripts/seed-auth.js` to provision HOT_DRINK staff rows (run out-of-band by operator, matching AUTH-ARCH-8B policy — manager UI cannot create station roles today, by intent).
3. Backfill **not needed** for orders; optional catalog backfill script (`migrate-hot-drink-station.mjs`) only if the owner elects to move coffee categories from BARISTA to JEBENA (D-2).
4. Extend policy/validations/stationStatus (allowlists).
5. Wire orderService routing + UI (behavior).
6. Run regression suite (§11), `node scripts/sync-indexes.js` if any index changes evolve (none planned).

---

## 10. SECURITY & AUTHORIZATION ANALYSIS (Requirements 8/14)

**Every allowlist/mapping that must consider HOT_DRINK (exhaustive grep inventory, verified):**

| Category | Locations |
|---|---|
| Role enums | `Staff.js:3`, `Session.js:26`, `validate.js:5+397`, `StaffManagement.jsx:46` |
| Policy | `policy.js` ROLES (14–20), ALL_ROLES (22), GROUPS (25–35: `KITCHEN_OR_BARISTA_OR_MANAGER`, `KITCHEN_OR_MANAGER`, `BARISTA_OR_MANAGER`, `WAITER_KITCHEN_BARISTA`), MATRIX (56, 57, 61, 63) |
| Station model | `stationStatus.js:19–50` (STATIONS, ITEM_TYPE, STATUS_FIELD, stationForView, stationForRole) |
| Order routing | `orderService.js` (213–214, 375–394, 448–594, 1028–1079, 1121–1168 attribution/renormalization), `api/orders/route.js` (174–181, 189–192), `api/orders/[id]/route.js` (284–299), `[id]/status/route.js` (100–115), `validate.js:380–389` |
| Shared role-PIN mgmt | `api/manager/staff/route.js:279, 305`; `api/staff/route.js:45–63`; `lib/config/security.js:7–12`; seed scripts |
| UI guards/labels | `kds/barista` layouts, `login/page.js:6–11`, `PinGuard.js:10–15`, `PinLoginModal.js:118–125`, `page.js` PORTALS, `KitchenDisplay.js` (9 sites), `StaffManagement.jsx:969` |
| Catalog writes | `menu-crud/actions.js` (107, 115, 135, 219, 241, 325–331, 338, 339–340, 460–471), `MenuCrudClient.jsx` tabs, `menuService.js:20–29` |
| Adjacent role lists | `InventoryAudit.js:31`, `inventoryAuditService.js:4`, `inventoryWasteService.js:44–45` (waste/audit actor allowlists — decide whether HOT_DRINK may log waste), `reportRevenueBreakdown.js:10–14` |
| Misc/tests | `tests/staff-pin-canonical.test.mjs:108` (literal list assertion) |
| **No allowlists** | `proxy.js` (rate buckets only), `next.config.mjs` (manifest rewrite only) — confirmed clean |

**Security properties after the change (unchanged invariants):**
- Server-authoritative routing: client-sent `type` is a hint (existing warning comment); `resolveCatalogLine` from MenuItem decides. Changing the frontend alone does **not** implement routing — server snaps type & checks station lines in atomic filters (compliant with constraint).
- Cross-station protection: each station can only act on its own lines (`$elemMatch {type, cancelled}`) and own status field; role gate comes from live Staff via policy; races miss cleanly with HTTP 400 classification.
- No new auth endpoints, no new secret storage; PIN handling/scrypt/rate-limit/session revocation reused.
- HOT_DRINK *cannot* SERVE/pay/cancel the whole order — policy matrix stays WAITER/MANAGER (SERVE), WAITER/MANAGER (PAID submit), CASHIER/MANAGER (confirm) — requirement 13 preserved.

---

## 11. TEST STRATEGY & REGRESSION PLAN

### 11.1 Existing suites that gate Phase B (must stay green — they hardcode current state)

- **Auth/PIN:** `staff-pin-canonical.test.mjs` (**will require a deliberate update**: line 108 asserts the literal 3-role list — extend, not weaken), `station-session-policy`, `role-station-separation`, `default-credential-cleanup`, `clear-orders-auth`, tab/session suites.
- **Stations/KDS:** `kds-separation`, `kds-action-precision`, `kds-status-filter`, `item-level-cancellation` (includes no-inventory-deduction-on-cancel invariant).
- **Payments:** `payment-verification`, `payment-accounts`, `payment-transfer-generic`, `cashier-*` — role-PIN matrix untouched ⇒ green expected.
- **Food/Drink data invariants:** `scripts/test-menu-unification.mjs`, `scripts/sync-food-menu-json.mjs` (FOOD/DRINK station invariants), `test-parity-fallback-and-sorting.mjs`.

### 11.2 New tests to add (Phase B)

1. **`stationStatus` unit tests for the third station** — STATION_ITEM_TYPE/STATUS_FIELD/stationForView/stationActionOf(HOT_DRINK) exact-button semantics; no regression for existing two.
2. **Policy matrix functional tests** — `can("HOT_DRINK", "orders:transition:READY") === true`; `can("HOT_DRINK","orders:transition:PAID") === false`; SERVE/pay/cancel-order negative tests.
3. **orderService lifecycle** — pure-mock-style (fits repo's DB-free test pattern): hot-drink strict sequence, mixed three-station overall READY derivation (requires all three), single-station hot order passthrough, cancel-line renormalization with third field, confidentiality of kitchenStaffId/baristaStaffId attribution into hotDrinkStaffId.
4. **`type` enum backcompat proof** — a legacy DRINK order doc round-trips serialization/serves unchanged (requirement 13).
5. **Menu CRUD (source assertions / action dry-run)** — third tab creates items with `targetStation=HOT_DRINK` (and no binary fallback regression); actions.js no longer force-falls coffee to BARISTA.
6. **Cross-station isolation** — HOT_DRINK cannot PREPARING a DRINK line; BARISTA cannot touch HOT_DRINK; jebena board dest query returns only HOT_DRINK.
7. **Payment/deduction boundary regression list** (run as-is): deduct-on-confirm invariant, TELEBIRR normalize, transfer-account validation.
8. **`staff-pin-canonical` updated literal** — verify manager role-wide reset applies to HOT_DRINK and revokes sessions.

---

## 12. IMPLEMENTATION SEQUENCE WITH RISK CLASSIFICATION (Phase B plan)

> **Rule enforced in Phase A audit:** nothing below is executed in Phase A. Sequence is ordered by internal dependency (models → policy → services → routes → UI → scripts → tests), each step individually testable/revertible.

| Seq | Step | Files (from §3) | Risk | Mitigation |
|---|---|---|---|---|
| B1 | Role & session enums (`STAFF_ROLES`, `SESSION_ROLES`, `validate.*`, `policy.*`, incl. all GROUPS usages audit) | 1, 2, 3, 4, 6 (Models+policy) | **MEDIUM** (matrix misconfig = security; policy test) | Unit tests; whitelist-mode fail-closed proves nothing loosens silently |
| B2 | Additive Order/menu model fields + enums (`hotDrinkStatus`, timestamps, staff id; `ITEM_TYPE`, `cancelledStation`, MenuItem/Category enums) | 6, 7, 8 | **LOW** (additive, null-default) | Enum-write probe test; no historical migration |
| B3 | `stationStatus.js` three-station model | 5 | **MEDIUM** (shared pure model — all KDS + tests) | Full unit suite before consumers |
| B4 | `orderService` routing/lifecycle (create/init, updateOrderStatus pipeline, cancel, toKdsShape) | 9–14 | **HIGH** (single most intricate pipeline in the codebase — atomic stage sequencing + derived overall) | Stage-by-stage diff review + probe tests (mixed 2-station regression must equal old behavior exactly) |
| B5 | API routes (`dest`, attribution, manager staff PIN lists, staff pinStatus) | 15–20 | **MEDIUM** | Route parity tests (canonical + alias) |
| B6 | Menu CRUD third tab + actions three-way station resolution + menuService heuristics | 21–23 | **MEDIUM** (catalog integrity; coffee regex fallback) | Dry-run catalog matrix CRUD check |
| B7 | UI: portal route, KitchenDisplay, waiter, login/labels/portal hub, StaffManagement, cashier, translations | 24–33 | **LOW–MEDIUM** (display; regression via component source assertions like repo style) | Visual/functional QA at three terminals |
| B8 | Ops: `DEFAULT_HOT_DRINK_PIN`, seed scripts, optional catalog retarget script | 34–36 | **LOW** | Non-default read-only default; only `--apply` mutates |
| B9 | Reporting extensions per D-3 (revenue buckets, analytics per-station KPI) | 37–38 | **LOW** (pure additive or fold decision) | Historical totals unchanged; before/after parity run |
| B10 | Full regression: existing 25+ suites + new `hot-drink-*`, hot-drink dedup of `staff-pin-canonical` | all | — | `next build` + repo test runner |

**Top risks (tracked for Phase B):**
- R1 `updateOrderStatus` pipeline divergence (three-station conditionals can regress mixed-kitchen/barista derivation). Mitigation: bitwise-identical existing branches — place the third branch *as a peer*, don't refactor the two.
- R2 Catalog write shorthand (`categoryType` vs station) — coffee categories currently auto-resolve to BARISTA; if the migration decision (D-2) is "stay", JEBENA tab still creates new items cleanly; if "move", only opt-in script mutates catalog.
- R3 Reports bucket semantics (D-3) — hot-drink lines' revenue must be explicitly attributed or visible as HOT_DRINK unattributed; early decision prevents silent KPI drift.
- R4 `staff-pin-canonical` literal test + `StaffManagement` role list literals enumerated twice (UI + server) — must be updated together or manager PIN reset misses one surface.

---

## UNRESOLVED QUESTIONS (STAKEHOLDER DECISIONS REQUIRED BEFORE PHASE B)

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **D-1** | Third **item type** value | A) Add `"HOT_DRINK"` to `ITEM_TYPE` (1:1 with station; mirrors existing pattern exactly). B) Keep `type:"DRINK"` + add a per-line `station` field (larger model divergence, breaks 1:1 invariant, more invasive to KDS/analytics) | **A** — smallest deviation, keeps `dest` single-key and stationStatus 1:1 mappings |
| **D-2** | Existing coffee categories/items (currently `BARISTA`/`DRINK` per `slug coffee regex` and `type` syncs) | A) Leave where they are — JEBENA BUNA only offers *new* items. B) Opt-in ops script retargets coffee/hot-beverage categories+items to `HOT_DRINK` | **B** — consistent UX; script non-default and order-history-safe |
| **D-3** | Hot-drink revenue in reports (CashierUI/reportRevenueBreakdown/analytics) | A) Fold into DRINK bucket. B) Third bucket HOT_DRINK everywhere (cashier UI filter gains a chip) | **B** — requirement 13 says preserve *existing* reports (unchanged buckets for historical docs); new bucket only affects third-type lines going forward |
| **D-4** | Portal route name | `/jebena` (brand) vs `/hot-drink` (role-literal, like /barista) | **A** — but keep `roleFromNext` mapping tolerant to both; D: (optional) also alias `/hot-drink`→`/jebena` |
| **D-5** | Default HOT_DRINK PIN value + seed | Value (e.g. `5555`), provisioned via `seed-auth.js` per AUTH-ARCH-8B operator policy | Mirror DEFAULT_BARISTA_PIN pattern, env-overridable |
| **D-6** | Should HOT_DRINK join inventory-waste/audit actor allowlists? | Add or exclude HOT_DRINK from `inventoryAuditService.js:4`/`inventoryWasteService.js:44–45` | Include ONLY if the JEBENA station is expected to log waste/audits (nice-to-have, not required by this phase spec) |
| **D-7** | Should the manager Staff-creation UI be extended to allow creating HOT_DRINK staff (currently only WAITER/CASHIER) | Extend `StaffManagement.jsx:579–583` + `api/manager/waiters:87–121`, or keep station roles seeded by ops | Keep seeded (matches how Kitchen/Barista are provisioned today); note limitation explicitly |
| **D-8** | `cancelledStation` label for item cancels | `"HOT_DRINK"` vs `"JEBENA"` | **`"HOT_DRINK"`** — role-literal, prevents a second label vocabulary |

## FILES THAT WOULD BE MODIFIED IN PHASE B (final consolidated list)

> **New:** `app/jebena/{layout,page}.js`, `scripts/migrate-hot-drink-station.mjs` (optional), `tests/hot-drink-*.test.mjs` (4–7 files).
> **Modified (36):**

```
lib/models/Staff.js  lib/models/Session.js  lib/models/Order.js  lib/models/MenuItem.js
lib/models/Category.js  lib/policy.js  lib/stationStatus.js  lib/orderService.js
lib/validate.js  lib/menuService.js  lib/config/security.js  lib/translations.js
lib/analytics.js (D-3)  lib/reportRevenueBreakdown.js (D-3)  lib/inventoryWasteService.js (D-6)
lib/inventoryAuditService.js (D-6)
lib/models/InventoryAudit.js (D-6)
app/page.js  app/login/page.js
app/api/orders/route.js  app/api/orders/[id]/route.js  app/api/orders/[id]/status/route.js
app/api/manager/staff/route.js  app/api/staff/route.js
app/components/KitchenDisplay.js  app/components/WaiterUI.js  app/components/PinGuard.js
app/components/PinLoginModal.js  app/components/StaffManagement.jsx  app/components/CashierUI.jsx (D-3)
app/manager/menu-crud/MenuCrudClient.jsx  app/manager/menu-crud/actions.js
scripts/seed-auth.js  scripts/reset-auth.js
tests/staff-pin-canonical.test.mjs  scripts/test-menu-unification.mjs (station-count invariant, if any)
```

**Not modified on purpose (verify-by-test only):** `security.js`, `serverAuth.js`, `sessionStore.js`, `rateLimit.js`, `pinCrypto.js`, `staffService.js`, `inventoryDeductionService.js`, `eventHub.js`, `orderEvents.js`, `app/api/auth/verify-pin/route.js` (beyond validate allowlist auto-flow), `app/api/menu/route.js`, `app/api/events/route.js`, `proxy.js`, `next.config.mjs`, `package.json`, all hotel/*, all manager/reports/*.

---

*Phase A complete. No code was modified; no commands with side effects beyond file reads were run; no destructive operations performed. This report is the sole deliverable. Phase B may commence only after D-1…D-8 decisions are recorded.*
