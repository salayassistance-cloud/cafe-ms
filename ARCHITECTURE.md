# Canonical Architecture — Hotel Management / POS System (Phase 2)

> **Status:** Defined & partially implemented (2026-08-23). This document is the single source for target architecture and migration map. No destructive cleanup has been performed; legacy paths remain with deprecation notices.

---

## 1. Database Architecture — ONE Connection Manager

### CURRENT
- Canonical: `lib/mongodb.js:1` (`connectToDatabase`, `mongoose.createConnection`, `globalThis.mongoose` singleton, `bufferCommands:false`, `maxPoolSize10`, `serverSelection 3s`, `syncIndexesInBackground` non-blocking).
- Legacy alias: `lib/dbConnect.js:1` re-exports same function.
- 15 route handlers import `dbConnect`, 6 import `mongodb`, `instrumentation.js` imports `mongodb`.
- Scripts use `mongoose.connect` (CommonJS) diverging from `createConnection`.

### TARGET
- **ONE** manager: `lib/mongodb.js` (`connectToDatabase` + `default` export for compat).
- `lib/dbConnect.js` remains as **deprecated alias** (Phase 2) with notice; new code MUST `import { connectToDatabase } from "@/lib/mongodb"`.
- All callers migrated to `lib/mongodb` by Phase 5; then alias deleted.
- Scripts migrated to `createConnection` or shared helper.

### WHY
- Single pool prevents per-request handshake that blew past 5s gateway.
- `globalThis` survives HMR/warm starts; avoids leaks.
- One code path for timeouts/health.

### RISK
- Mass import churn could miss a caller → runtime 500.

### MIGRATION METHOD
- Add `default` export to `lib/mongodb.js` for `import dbConnect from "@/lib/mongodb"` compat.
- Annotate `lib/dbConnect.js` as deprecated.
- Incrementally change imports, verify with `Select-String` search, run `next build`.

### TEST REQUIRED
- `Select-String "from.*dbConnect"` zero after migration.
- Boot warm log `[instrumentation] db connection warmed` once.
- Load `/api/menu` and `/api/orders` concurrently — single connection reused (`readyState 1`).

---

## 2. Domain Architecture — ONE Service per Entity

### CURRENT
- `lib/orderService.js` (create, state machine, toKdsShape), `lib/authService.js` (SystemAuth + lock), `lib/staffService.js` (Staff + pin), `lib/analytics.js` (buildReport), `lib/cloudinary.js`, `lib/categories.js` (unused), scattered route logic (e.g., `brand/upload` fs write).

### TARGET
```
API Route / Server Action
        ↓  (validate via lib/validate, auth via lib/policy → lib/security)
Domain Service
        ↓
Database (via lib/mongodb + get*Model)
```
- **Services (canonical):**
  - `lib/orderService.js` — order lifecycle (PENDING→PREPARING→READY→SERVED→PAID→CANCELLED/ARCHIVED), server-authoritative totals.
  - `lib/menuService.js` *(new, Phase 2)* — `getUnifiedMenu`, `serializeCategory/serializeMenuItem`, alias resolution for `category/categoryId` etc.
  - `lib/reportService.js` *(new)* — `getReport`, `resolveReportRange`, `enrichWithStaffNames`, 5s TTL cache.
  - `lib/staffService.js` + `lib/authService.js` — persons vs terminals (keep both, but staff is canonical persons).
  - `lib/eventHub.js` — pub/sub.
  - `lib/cache.js` *(new)* — `invalidateMenuCaches`, tags.

### WHY
- Route handlers become thin (auth→validate→service→response); business logic testable in isolation.
- Alias resolution in one place prevents drift.

### RISK
- Over-abstraction (service for every CRUD) would add indirection.

### MIGRATION METHOD
- Introduce `menuService`/`reportService`/`cache` without removing inline code; route handlers delegate to them (as done for `analytics`/`reports` in Phase 2). Keep old paths until coverage proves parity.

### TEST REQUIRED
- `GET /api/menu` before/after parity (categories count, item titles).
- `GET /api/manager/analytics` vs `GET /api/manager/reports` produce same `kpis.revenue` for same window.

---

## 3. API Architecture — ONE Contract

### CURRENT
- Standard envelope: `{ success, data, error, message }` via `lib/apiResponse.js` (`ok`, `fail`, `isDbError`).
- `lib/withApi.js:16` centralizes CORS, health fast-fail, dbError→503 mapping, `attachCors`.
- `proxy.js` + `next.config.mjs` duplicate `no-store`/`nosniff` headers.

### TARGET
- **All** handlers: `export const GET = withApi(handler)` and use `ok(data, status)` / `fail(error,status)`.
- Validation via `lib/validate.js` (Zod-like) returns `{ ok, data }` or `{ error }`.
- Auth via `lib/security.requireAuth` or `lib/policy.authorize`.
- Errors never leak stacks; `isDbError` → `503 Retry-After:2`, others → `500` generic.

### WHY
- Predictable client handling (`err.status`, `err.retryAfter` in `clientFetch.js`).

### RISK
- None — already canonical.

### MIGRATION METHOD
- Audit remaining handlers that manually `NextResponse.json` (e.g., `auth/login-staff`) and migrate to `ok/fail` where appropriate; keep `withApi` wrapper.

### TEST REQUIRED
- `curl -X POST /api/orders -d invalid` → `400` envelope, not 500 HTML.

---

## 4. Authentication Architecture — ONE Mechanism

### CURRENT
- **Terminal shared PINs:** `system_auth` (`waiterPin`/`kitchenPin`/`baristaPin`/`managerPin` scrypt) via `lib/authService.verifyRolePin` (snapshot cache, derivedKeyCache, auto-upgrade plaintext).
- **Persons:** `staffs` (`pinHash` scrypt) via `lib/staffService.verifyStaffPin` (case-insensitive fallback).
- **Session:** `lib/sessionCrypto` HMAC-SHA256 `bono_sess` HttpOnly `sameSite lax, secure prod, 7d`; `lib/authServer.getPortalSession(role)` for layouts; `lib/security.requireAuth` for APIs (cookie or `Bearer`).
- **Convenience:** `lib/sessionClient` `localStorage` (`bono_device_id` etc.) — not trusted.
- **Legacy:** `lib/models/User` plaintext per-role PIN — zero callers.

### TARGET
```
Credential verify (staffService OR authService)
        ↓
createSessionToken({ role, staffId?, waiterNumber? })
        ↓
Set-Cookie bono_sess (HttpOnly, Secure prod)
        ↓
Server-side verify (authServer per layout, requireAuth per API)
        ↓
policy.can() per permission
```
- Persons (`login-staff`) is canonical for individuals; `verify-pin`/`verify-waiter` remains for terminal kiosks until full staff migration.
- `User` model deprecated; do not remove until `users` collection count 0 verified.
- `AUTH_SECRET` **required in prod** — `sessionCrypto` now throws if missing in `NODE_ENV=production`.

### WHY
- Browser not trusted; HttpOnly prevents forgery/XSS theft; HMAC prevents tampering; scrypt prevents DB dump → plaintext.

### RISK
- Changing `AUTH_SECRET` invalidates all sessions (forced re-login).

### MIGRATION METHOD
- Phase 2 hardened `sessionCrypto` to throw in prod if missing.
- Keep both `verifyRolePin` and `verifyStaffPin` until staff coverage 100%.

### TEST REQUIRED
- `POST /api/auth/login-staff` with correct PIN → `Set-Cookie` HttpOnly, `GET /api/staff` with cookie → 200, without → 401.
- `POST /api/auth/verify-pin` with wrong PIN → 401, rate-limited after 5.

---

## 5. Authorization Matrix — ONE Policy

### CURRENT
- Scattered strings: `requireAuth(request,["MANAGER"])`, layout `getPortalSession("MANAGER")`, Server Actions no check.

### TARGET
- Central: `lib/policy.js` — `ROLES`, `GROUPS`, `MATRIX` (`resource:action → allowedRoles`), `can()`, `canTransition()`, `authorize()`, `getAuthorizedSession()`.
- Matrix excerpt:
  - `menu:read`, `brand:read`, `paymentInfo:read`, `events:subscribe`, `waiter:active` → `null` (public).
  - `menu:mutate`, `brand:mutate`, `paymentInfo:mutate`, `reports:read`, `analytics:read`, `settings:*` → `MANAGER`.
  - `orders:create` → `WAITER/MANAGER`; `orders:transition:PREPARING/READY` → `KITCHEN/BARISTA/MANAGER`; `SERVED/PAID` → `WAITER/MANAGER`; `CANCELLED` → `MANAGER`; `ARCHIVED` → `KITCHEN/BARISTA/MANAGER`.
  - `staff:read` → any authenticated; `staff:mutate` → `MANAGER`.

### WHY
- Explicit, enumerable, testable; no duplicated `"MANAGER"` literals.

### RISK
- Matrix change is security-critical; wrong entry opens bypass.

### MIGRATION METHOD
- Phase 2 introduced `lib/policy.js` without wiring all callers.
- Phase 2 also hardened `app/manager/menu-crud/actions.js` with `assertManager()` (policy-aligned) as first wiring.
- Phase 3 will wire `orders/[id]` transitions to `canTransition`.

### TEST REQUIRED
- Unit test `policy.can("WAITER","menu:mutate") === false`, `can("MANAGER","reports:read") === true`.

---

## 6. Menu Architecture — ONE Canonical Representation

### CURRENT
- `Category.name` `Mixed` (LocalizedString or String), `slug unique`, `type`/`targetStation` mirrored.
- `MenuItem` 5 alias pairs: `category↔categoryId`, `station↔targetStation`, `imageUrl↔image`, `isNew↔isItemNew↔isPopular`, `isAvailable↔inStock`.

### TARGET
- **Canonical write fields:** `Category`: `name:{am,en,om}`, `slug`, `targetStation`, `type` (derived), `order`; `MenuItem`: `category`, `targetStation`, `imageUrl`, `isNew`, `isAvailable`, `categoryType`, `price` (server-authoritative for totals).
- **Aliases:** retained, synced in `pre validate` hooks, read via `menuService.resolve*` / `serialize*`.
- `lib/menuService.js` is the single mapping; `getUnifiedMenu()` is used by `GET /api/menu` and `app/manager/menu-crud/page.js`.

### WHY
- One field per concept prevents query bugs (`$or` on both fields).

### RISK
- Dropping aliases before backfill orphans items.

### MIGRATION METHOD
- Add migration script `scripts/migrate-menu-canonical.js` (Phase 3) that backfills `category←categoryId` etc., then verify `db.menuitems.countDocuments({ category:{$exists:false}})==0` before removing alias indexes.

### TEST REQUIRED
- `GET /api/menu` before/after parity; `db.menuitems.find` where canonical missing → 0.

---

## 7. Order Architecture — ONE Lifecycle

### CURRENT
- `lib/orderService.js` central state machine: `PENDING→PREPARING→READY→SERVED→PAID` (+ `CANCELLED`, `ARCHIVED` soft), `updateOrderFields` `$set` + `runValidators:false` for legacy shapes, `toKdsShape` normalizes, `genOrderNumber` via `counters:order_seq`.
- Handlers `orders/[id]` still unauthenticated.

### TARGET
- State machine remains in `orderService`; handlers delegate and add `requireAuth` + `policy.canTransition`.
- Totals server-authoritative: require `itemId` for catalog items, snapshot `MenuItem.price`, reject client `price` unless snapshot hit; compute `totalAmount` server-side only.
- History immutable: `PAID/CANCELLED/ARCHIVED` are terminal; `completedAt/paidAt` etc. idempotent.

### WHY
- Financial integrity — client price never trusted.

### RISK
- Requiring `itemId` breaks external ad-hoc items (handled via `isExternal` + `/api/external-sales`).

### MIGRATION METHOD
- Phase 2 documents matrix; Phase 3 enforces `requireAuth` per transition and price guard.

### TEST REQUIRED
- `POST /api/orders` with `price:999` but `itemId` of ETB 100 → stored `price 100`.
- `PATCH /api/orders/ORD-xxx {status:"CANCELLED"}` as WAITER → 403, as MANAGER → 200.

---

## 8. Reporting Architecture — ONE Service

### CURRENT (before Phase 2)
- `/api/manager/analytics` and `/api/manager/reports` identical (parseDate → limit 5000 → buildReport → enrich?). Duplicate.

### TARGET
- **Canonical:** `lib/reportService.js` (`getReport`, `resolveReportRange`, `enrichWithStaffNames`, 5s TTL cache).
- `/api/manager/analytics` is canonical URL (used by `manager/reports/page.js`).
- `/api/manager/reports` is **legacy alias** delegating to same service + `Deprecation: true`, `Sunset: Dec 2026`, with staff enrichment for compat.
- Large dataset handling: single `find({createdAt:{$gte:prevFrom,$lt:to}}).limit(5000).lean()` covering current+previous window; client receives aggregated deltas, not raw truncation. Future: Mongo aggregation pipeline (Phase 4) to reduce JS CPU.

### WHY
- DRY; cache reduces 3s poll DB hammer.

### RISK
- Cache TTL 5s may serve slightly stale revenue (acceptable for dashboard).

### MIGRATION METHOD
- Phase 2 implemented: both routes now `import { getReport, resolveReportRange }` and `analytics` removed local `parseDate`/`buildReport`; `reports` adds enrichment via `enrichWithStaffNames`.

### TEST REQUIRED
- `GET /api/manager/analytics?from=2026-08-16&to=2026-08-23` and `GET /api/manager/reports?...` return same `kpis.revenue` ± enrichment.

---

## 9. Real-Time Architecture — SSE-First

### CURRENT
- `lib/eventHub.js` `globalThis.__orderEventHub` `Set` of senders, `subscribe`/`publish`, `PING 25s`.
- `/api/events` SSE `ReadableStream`, no auth, `globalThis` survives HMR.
- `lib/orderEvents.js` `EventSource("/api/events")` + `onmessage` filter `ping`.
- Overlap: `WaiterUI` SSE + `10s` poll + `15s` menu poll; `KitchenDisplay` SSE + `5s` poll.

### TARGET
```
Order mutation (POST /api/orders, PATCH /api/orders/[id])
        ↓
publish({ type:"orders-changed", orderId, status }) + publish({ type:"ORDER_READY", waiterNumber/Name/Id })
        ↓
/api/events (SSE) → clients refetch their feed (invalidation, not data push)
        ↓
Fallback polling only when SSE disconnected (visibility: hidden pause, on reconnect immediate refetch)
```
- Process-local hub is **safe for single-instance** (Netlify single function, POS single Node). Documented swap to Redis if multi-instance.
- Keep SSE open to any same-origin terminal; consider adding session auth for `events` if multi-tenant.

### WHY
- Push removes 3s report poll, 5/10s board poll load.

### RISK
- In-memory hub loses events on deploy/restart (fallback poll reconciles).

### MIGRATION METHOD
- Phase 2 documents; Phase 4 will reduce polling to fallback-only (detect `EventSource.OPEN`).

### TEST REQUIRED
- `POST /api/orders` → SSE `data: {"type":"orders-changed"}` within 500ms on open `EventSource`.

---

## 10. Caching Architecture

### CURRENT
- Every route `force-dynamic` + `cache:'no-store'` + `withApi`/`proxy` `no-store` headers.
- `MenuCrudClient` double `router.refresh()`.
- Reports 3s poll no cache, 5000 docs each.

### TARGET
- **Menu / Categories / Brand / PaymentInfo:** public read, `revalidateTag('menu')` / `revalidatePath` on mutation. Server `fetch` with `next:{tags:['menu']}` and `revalidate 60s`; CDN `stale-while-revalidate`.
- **Active Orders:** private `no-store`, SSE invalidation only, fallback 10s when SSE closed.
- **Reports:** private `no-store` on client, 5s server TTL in `reportService`.
- **Auth snapshots:** `systemAuthSnapshot` + `derivedKeyCache` in `authService` with `invalidateAuthCache()` on write.
- **Mutations:** always `publish` + `invalidateMenuCaches` (`lib/cache.js`).

### WHY
- Menu is stable (CRUD rare) → cacheable; orders are operational → fresh.

### RISK
- Tag-based cache requires Next 15 `revalidateTag` server fetch; current `cache:'no-store'` is safe fallback.

### MIGRATION METHOD
- Phase 2 introduces `lib/cache.js` and `reportService` TTL; Phase 4 migrates `GET /api/menu` to tagged cache.

### TEST REQUIRED
- `POST /api/manager/menu-crud/actions createMenuItem` → `GET /api/menu` reflects new item within 1s (revalidated).

---

## 11. Target Directory Structure

```
app/
  layout.js (providers)
  page.js (portal hub)
  menu/ (public, cacheable)
  waiter/ (guard WAITER)
  kds/ (guard KITCHEN)
  barista/ (guard BARISTA)
  kitchen/ (redirect → kds, compat)
  login/ (compat)
  manager/
    layout.js (guard MANAGER)
    page.js (redirect)
    reports/page.js (uses analytics)
    menu-crud/ (Server Actions, guard MANAGER)
  api/
    auth/ (verify-pin, verify-waiter, login-staff, change-pin, logout)
    brand/ (+ upload)
    events/ (SSE)
    external-sales/ (isExternal)
    manager/analytics (CANONICAL) ← reportService
    manager/reports (LEGACY alias) → same
    manager/settings/* (pins, waiters, clear-orders)
    manager/staff/
    menu/ (via menuService)
    orders/ (+ [id], [id]/status alias)
    payment-info/
    staff/
    waiter/active/
  components/ (client islands: WaiterUI, KitchenDisplay, Pin*, Theme*, Language*, ChangePinModal)
  globals.css, global-error.js, icon.svg, manifest.js
lib/
  mongodb.js (CANONICAL) + dbConnect.js (DEPRECATED alias)
  policy.js (CANONICAL authz)
  menuService.js (CANONICAL)
  reportService.js (CANONICAL)
  cache.js (CANONICAL)
  orderService.js, authService.js, staffService.js, analytics.js, eventHub.js, orderEvents.js
  security.js, sessionCrypto.js, authServer.js, validate.js, rateLimit.js, withApi.js, apiResponse.js, dbHealth.js
  pinCrypto.js, clientFetch.js, sessionClient.js, cloudinary.js, currency.js, displayName.js, ethiopianCalendar.js, translations.js, constants.js, categories.js (to verify unused)
  models/ (Order, Category, MenuItem, Staff, SystemAuth, BrandConfig, PaymentInfo, User→deprecated)
hooks/ (empty → remove after verify)
public/ (icons, placeholders, sounds, sw.js)
scripts/ (sync-*, seed-*, reset-*, clean-*, verify-*)
instrumentation.js, proxy.js, next.config.mjs
ARCHITECTURE.md (this file)
```

No mass moves. Only new canonical files added (`policy`, `menuService`, `reportService`, `cache`). `User` model retained until migration audit.

---

## 12. Output — Migration Map Summary

| # | Change | CURRENT | TARGET | WHY | RISK | MIGRATION | TEST |
|---|---|---|---|---|---|---|---|
| 1 | DB singleton | `dbConnect` alias + `mongodb` + `mongoose.connect` scripts | `lib/mongodb.js` sole (`connectToDatabase`) | Single pool, no 5s timeout | Missed import → 500 | Add default export, annotate alias, migrate callers incrementally, verify `Select-String` | Concurrent menu+orders fetch shares `readyState` |
| 2 | Policy central | Scattered `requireAuth` strings + actions no check | `lib/policy.js` matrix | Enumerable, testable | Matrix misconfig → bypass | Introduce file, wire actions first, then orders | Unit tests per permission |
| 3 | Manager actions auth | No check | `assertManager()` via `verifySessionToken` | Prevent unauth catalog wipe | False 403 for valid manager | Add guard, test as MANAGER vs WAITER | `createCategory` as WAITER → 403 |
| 4 | Reporting unify | Two identical handlers | `lib/reportService` + `analytics` canonical, `reports` deprecated alias | DRY, cache | Stale cache 5s | Refactor both to `getReport`+`resolveReportRange`, add `Deprecation` header | Parity test `analytics` vs `reports` |
| 5 | AUTH_SECRET prod guard | Fallback dev secret | Throw if `NODE_ENV=production && !AUTH_SECRET` | Prevent forgery | Restart fails if env missed | Added in `sessionCrypto` | `NODE_ENV=production` without var → throw |
| 6 | Menu aliases | `category↔categoryId` etc. scattered, `strict:false` | `lib/menuService` canonical, aliases deprecated | One field per concept | Dropping alias early → orphan | Backfill script, verify count 0, then drop indexes | `menuService.serialize` before/after |
| 7 | Order price trust | Client `price` trusted if no `itemId` | Server snapshot required, recomputed total | Financial integrity | Breaks ad-hoc external items | Require `itemId` for catalog, keep `external-sales` path | Post with low price but valid `itemId` → stored DB price |
| 8 | Real-time | SSE + aggressive polls overlap | SSE-first, poll fallback only | Reduce DB 50 req/min | Missed event if SSE drops | Keep EventSource, add `OPEN` check, visibility pause | POST order → SSE within 500ms |
| 9 | Caching | `no-store` everywhere | `revalidateTag` for menu, TTL for reports | Performance | Stale menu | Introduce `cache.js`, migrate menu fetch | Create item → menu reflects after revalidate |
| 10 | API envelope | Mostly consistent but some `NextResponse.json` with `message` | `withApi` + `ok/fail` everywhere | Predictable clients | None | Audit `login-staff` envelope (already `{success,message}`) | All routes return `{success,data,error}` |

**Do not perform destructive cleanup** until each row's `TEST` passes and `RISK` is mitigated. Legacy files (`User`, `dbConnect`, `reports` alias, `kitchen` redirect) remain until Phase 5 with explicit verification.

