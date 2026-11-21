# BONO — Unified POS + ROOM System Architecture & Performance Audit

> **Phase type:** READ-ONLY architectural audit and planning.
> **Status:** Audit complete. No implementation. Awaiting owner approval for the next phase.
> **Date:** 2026-11-20
> **Baseline HEAD:** `69650435a6587d4577bc126f719fa1392bb934b3` (branch `main`)

---

## 0. Evidence conventions used in this report

- **[SRC]** — verified by direct source inspection during this audit (file paths and line references given).
- **[DOC]** — stated in an existing repository document; cross-checked against source where practical.
- **[INF]** — interpretation/inference by the auditor; not a verified fact.
- All performance findings are **SOURCE-BASED (static)**. **No MEASURED findings exist in this report.** No runtime metrics, query plans, index statistics, payload measurements, or load tests were produced. No database, staging, or production system was contacted.

---

## 1. Executive summary

BONO is a single Next.js 16.3.1 application (`C:/hotelms`, package `bonodig`, React 19.2.8, Mongoose 9, Tailwind 4) that already contains **two genuinely separate domain systems** sharing only the host, edge layer, and a few presentation utilities:

- **POS (Restaurant/F&B)** — `app/**` excluding `hotel`, `app/api/**` excluding `hotel`, `lib/**` excluding `lib/hotel/**`. One MongoDB database reached through `lib/mongodb.js` (`MONGODB_URI`), one staff/session/auth model (`Staff`, `Session`, six roles), and a large, mature order/inventory/reporting subsystem.
- **ROOM (Hotel)** — `app/hotel/**`, `app/api/hotel/**`, `lib/hotel/**`. A deliberately isolated module with its **own** MongoDB connection (`lib/hotel/db/connection.js`, `ROOM_MONGODB_URI`, database `bono_hotel`), its **own** users/sessions/roles (`MANAGER`, `RECEPTIONIST`), its **own** CSRF + Origin-protected API, and its own collection set.

**Central conclusion:** the two systems should be unified at the **experience/layout/navigation shell and shared operational-configuration level**, while their databases, auth boundaries, domain services, and API contracts stay separate. There is **no source evidence supporting a database merge, a rewrite, a schema unification, or microservices**. The safest path is a modular "one app shell, two domain modules" architecture with strict failure isolation.

**Current homepage** (`app/page.js`) is a flat grid of **six PIN-gated portal buttons** (Cashier, Waiter, Kitchen, Barista, Jebena Buna/HOT_DRINK, Manager) plus a left marketing column — no module grouping, no ROOM entry points at all. The requested two-card (POS / ROOM) homepage is a natural evolution of this file and needs no route rewrites: all nine target sub-pages already exist as routes (POS six + ROOM three).

**Top performance priorities (source-based):** JS-side report aggregation over unbounded order sets with per-order `Intl` allocation (PERF-01); duplicate order queries defeating the report cache (PERF-02); N+1 catalog lookups inside a transaction during menu-policy classification (PERF-03); hotel connection cold-start vs ~5s gateway budget (PERF-04); incomplete POS index deployment (PERF-07); retry loops without backoff/commit budget (PERF-14); process-local SSE/state under serverless (PERF-16).

**Top security risks:** public unauthenticated bank-account disclosure (SEC-01); optional manager PIN step-up (SEC-02); POS sessions without idle expiry (SEC-03); unauthenticated SSE carrying order identifiers (SEC-04); and a programmatic production-readiness gap (no CI, no verified staging, no backup/restore proof — SEC-05) that gates both modules.

**Preservation:** all 238 working-tree entries, including the three EXTERNAL deletions, were left untouched. This report is the only new file.

---

## 2. Verified repository baseline

### 2.1 Preflight results

| Check | Value |
|---|---|
| Repository root | `C:/hotelms` (from `git rev-parse --show-toplevel`) |
| Branch | `main` (up to date with `origin/main`; 0 commits ahead) |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` — "Complete Bono UI and reporting updates" |
| Staged changes | **0** (`git diff --cached --name-only` empty) |
| Status entries | **238** = 81 modified + 3 deleted + 154 untracked entries |
| Untracked files | **391** (`git ls-files --others --exclude-standard`) |
| Recent history | `6965043`, `2aa8da9`, `3a939b7`, `039badc`, `8fcb77b`, `51fe2da`, `4d91648`, `8332bd1` |

### 2.2 Comparison with the last confirmed baseline

The **Phase 2.1.1 final report** (`docs/phase-2.1.1-final-safety-corrections.md`) recorded its own post-implementation state as: **238 entries / 81 M / 3 D / 154 untracked entries / 391 untracked files / 0 staged / HEAD `69650435…`**. The current preflight matches that state **exactly** on every count and on HEAD. Therefore:

- **No changes have occurred since the last confirmed baseline.** [SRC]
- The only expected delta from this audit is the addition of this report file (untracked +1).
- The report's published digest (`4B931D38…`) could not be byte-reproduced because the hashing serialization method is not documented; the authoritative comparison is the count vector above, which matches. This is an explicitly unverified item (§21).

### 2.3 The three EXTERNAL deletions (preserved)

| Path | Status |
|---|---|
| `app/api/external-items/route.js` | `D` — intact |
| `app/api/external-sales/route.js` | `D` — intact |
| `lib/models/ExternalItemRequest.js` | `D` — intact |

All three were confirmed present as deletions before and after this audit. **They were not restored.** [SRC]

### 2.4 Mutation log for this phase

No `reset`, `stash`, `clean`, `checkout`, `stage`, `commit`, `push`, migration, seed, index operation, deployment, DB connection, `.env`/secret read, or existing-source modification was performed. No tests or builds were run (a Next build can load env files and perform static-generation DB access, which this phase forbids). Git state was only read.

---

## 3. Architecture map (verified)

```
C:\hotelms  — Next.js 16 app, single deployment unit
├─ app/
│  ├─ layout.js                 root providers (Theme, Language, PwaRouteTracker, BottomNav[no-op])
│  ├─ page.js                   CURRENT HOME: 6 flat PIN portal cards  → TARGET: 2 module cards
│  ├─ login/, launch/           PIN fallback login, PWA launch redirect
│  ├─ menu/                     public customer QR menu (cacheable)
│  ├─ cashier/, waiter/, kds/, kitchen/(alias), barista/, jebena/    POS stations
│  ├─ manager/                  reports, menu-crud (Server Actions), inventory, staff
│  ├─ hotel/                    ROOM: reception, rooms, reports, users  (4 thin client shells)
│  ├─ components/               POS client islands (all 'use client')
│  ├─ components/hotel/         ROOM client panels + hotelApi transport
│  └─ api/
│     ├─ auth/*, orders/*, menu, brand/*, payment-info, events(SSE), health
│     ├─ manager/*, cashier/report, station/report, inventory/*, recipes/*, extra-items/*
│     └─ hotel/**               ROOM API (43 route files, withHotelApi)
├─ lib/                         POS domain services, models, auth, validation, infra
│  └─ hotel/                    ROOM domain services, models, auth, http, db/connection.js
├─ scripts/                     index deploy, provisioning, migrations, recovery scans
├─ docs/                        phase reports + production-readiness/ (extensive)
├─ tests/                       122 *.test.mjs + integration/ harnesses (DB-free by default)
├─ instrumentation.js            boot: warms POS DB only
├─ proxy.js                     Next 16 middleware: CORS preflight, edge rate limit, headers
├─ next.config.mjs              rewrites, security headers, API no-store / public cache rules
└─ netlify.toml                 deployment: npm run build + @netlify/plugin-nextjs
```

**Shared surface:** host/origin, `proxy.js`, `next.config.mjs` headers, PWA shell, Tabler icons, `lib/ethiopianCalendar.js` (shared calendar), theme + language providers (shared `hms_lang` key). **Not shared:** databases, connections, secrets, cookies, role engines, API envelopes, domain services, and models. [SRC]

---

## 4. POS architecture (source-verified)

### 4.1 Routes and gating

| Route | Implementation | Gate |
|---|---|---|
| `/` | `app/page.js` — 6 portal buttons + `PinLoginModal` | Client-only; each portal authenticates on click |
| `/cashier` | `app/cashier/page.js` → `CashierUI.jsx` | Strict `CASHIER` via `layout.js` (MANAGER rejected at page level) |
| `/waiter` | `app/waiter/page.js` → `WaiterUI.js` | `getPortalSession("WAITER")` |
| `/kds` | `app/kds/page.js` → `KitchenDisplay` `station="FOOD"` | `KITCHEN` |
| `/kitchen` | `app/kitchen/page.js` | `redirect("/kds")` compatibility alias |
| `/barista` | `app/barista/page.js` → `KitchenDisplay` `station="DRINK"` | `BARISTA` |
| `/jebena` | `app/jebena/page.js` → `KitchenDisplay` `station="HOT_DRINK"` | `HOT_DRINK` |
| `/menu` | `app/menu/page.js` — public trilingual catalog/cart | Public |
| `/manager` → `/manager/reports` | `app/manager/layout.js` + `reports/page.js` | `MANAGER` |
| `/manager/menu-crud`, `/manager/inventory`, `/manager/staff` | manager layout | `MANAGER` |
| `/login?next=…` | `app/login/page.js` | `roleFromNext()` maps path → role; **no `/cashier` case → falls through to MANAGER** |

### 4.2 Components (all client components)

`CashierUI`, `WaiterUI`, `KitchenDisplay` (shared KDS parameterized by station), `StationReportPanel`, `ManagerSidebar`, `PinGuard`, `PinLoginModal`, `PinKeypad`, `ChangePinModal`, `SettingsGear`, `StaffManagement`, `InventoryUI`, `MenuCrudClient`, plus theme/i18n/date helpers. `BottomNav` is a no-op (returns `null`). SSE realtime via `lib/orderEvents.js` (`useOrderEvents`) with polling fallback in boards.

### 4.3 Services and models

- Core: `lib/orderService.js` (state machine `PENDING→PREPARING→READY→SERVED→PAID`, plus `CANCELLED`/`ARCHIVED`; price snapshots, version-conflict retries, inventory reservation/consumption), `lib/menuService.js`, `lib/reportService.js`, `lib/analytics.js`, `lib/cashierReport.js`, `lib/stationReport.js`, `lib/stationStatus.js`.
- Inventory subsystem: `inventoryPolicy.js`, `inventoryReservationService.js`, `inventoryDeductionService.js`, `inventoryPolicyVersionService.js`, `inventory-v2/**` (newer layering, largely unwired), recipe write/draft services, `extraItemService.js`.
- Models (factories on the POS connection): `Order`, `Category`, `MenuItem`, `Staff`, `Session`, `InventoryItem`, `StockMovement`, `ExtraItem`, `Recipe`, `InventoryReservation`, `InventoryAudit`, `PaymentInfo`, `BrandConfig`, `Supplier`, `SystemAuth` (retired authority, bootstrap fallback only).

### 4.4 Server actions

Only `app/manager/menu-crud/actions.js` (`"use server"`): `createCategory`, `deleteCategory`, `updateCategory`, `createMenuItem`, `updateMenuItem`, `setMenuItemInventoryPolicy`, `deleteMenuItem` + aliases. Guarded by `assertManager()` (tab credential first, then cookie); Cloudinary uploads; `revalidateAll()` revalidates paths and publishes `menu-changed`. This is the only POS server action surface.

---

## 5. ROOM architecture (source-verified)

### 5.1 Routes and gating

Exactly three thin page shells under a shared `app/hotel/layout.js` session gate
(no `/hotel` index):
- `/hotel/reception` → `ReceptionUI` (guests, reservations, check-in/out, payments)
- `/hotel/rooms` → `RoomsUI` (rooms/types, status; RECEPTIONIST read-only)
- `/hotel/reports` → `RoomReportsUI` (MANAGER only)

The former `/hotel/users` page and its staff-management UI were removed in the
Phase 1 legacy cleanup. Each remaining page is `force-dynamic`; auth is handled
by the shared server layout and the role-scoped PIN gate.

### 5.2 API and services

43 route files under `app/api/hotel/**`, all thin `withHotelApi(handler)` wrappers (`runtime="nodejs"`, `force-dynamic`). `withHotelApi` only normalizes errors; each handler calls `authorizeHotelRequest` with a permission and `mutation:true` ⇒ exact Origin + `x-hotel-csrf-token`. Domain services under `lib/hotel/services/`: `rooms`, `roomTypes`, `guests`, `reservations`, `stays`, `bookingLocks`, `folio`, `payments`, `staff`, `reports`(+csv/pdf). Models under `lib/hotel/models/` are factories on the hotel connection with explicit collections (`hotel_rooms`, `hotel_guests`, `hotel_reservations`, `hotel_stays`, `hotel_payments`, `hotel_users`, `hotel_sessions`, `hotel_audit_logs`, `hotel_room_booking_locks`, `roomtypes`).

### 5.3 Business rules (source + `docs/hotel-foundation.md`)

- Room states: manual `AVAILABLE/CLEANING/MAINTENANCE/OUT_OF_SERVICE`; `OCCUPIED`/`RESERVED` system-owned; check-out → `CLEANING`, never straight to `AVAILABLE`.
- Reservation: `CONFIRMED → CANCELLED | CHECKED_IN | NO_SHOW`; `CHECKED_IN → CHECKED_OUT`; terminal states enforced; half-open `[arrival, departure)` intervals; per-room `_id` mutex with 30s TTL and atomic steal; conditional updates; immutable snapshots.
- Stay: `IN_HOUSE → CHECKED_OUT`, one per reservation. Payments: `RECORDED → VOIDED` (non-destructive), idempotency keys, overpayment rejected, integer minor units (santim), ETB.
- Reports: 92-day max window, bounded, money in minor units, no `.aggregate()`.
- Ethiopian calendar: `lib/ethiopianCalendar.js` shared; hotel backend uses fixed UTC+3 for canonical midnight instants; Ethiopian date pickers in UI; `hms_lang` shared i18n key with a separate semantic dictionary.

### 5.4 Integration with POS

**None at the business/import level.** No POS module imports hotel code or vice versa (boundary tests assert this). Operational integration (e.g., charging restaurant items to a room) is explicitly deferred in `docs/hotel-foundation.md`. [SRC/DOC]

---

## 6. Database architecture (source-verified)

| Property | POS | ROOM |
|---|---|---|
| Connection module | `lib/mongodb.js` `connectToDatabase()` | `lib/hotel/db/connection.js` `connectToHotelDatabase()` |
| Env (name only) | `MONGODB_URI` | `ROOM_MONGODB_URI`; forces `dbName: "bono_hotel"` |
| DB derivation | from URI path | `HOTEL_DB_NAME = "bono_hotel"`; rejects other DB names |
| Singleton key | `globalThis.mongoose` | `globalThis.__bonoHotelMongooseConnection` |
| Driver API | `mongoose.createConnection(...).asPromise()` | same |
| Pool | `maxPoolSize:10`, `minPoolSize:0` | same |
| Timeouts | selection **3000ms**, connect 10000ms, socket 30000ms | selection **5000ms**, connect 10000ms, socket 30000ms |
| Auto indexes | additive `createIndexes()` in background outside prod | `autoIndex:false`, `autoCreate:false` — never |
| Model registration | factories on POS conn | factories on hotel conn; no `mongoose.models` use |
| Boot warmup | **yes** — `instrumentation.js:13` | **no** |
| Secrets/cookies | `AUTH_SECRET`; `__Host-bono_session` | `HOTEL_SESSION_SECRET` (must differ); `__Host-bono_hotel_session` |

**There is no duplicate connection manager bug** — the two are intentional and correctly isolated. Do **not** merge them. The 5s hotel selection timeout ≈ the documented ~5s gateway budget, and a cold ROOM request pays it; see PERF-04. [SRC]

POS uses **one** database for orders/auth/menu/inventory; `lib/dbConnect.js` is documented as a deprecated alias (not found active in this audit's primary search). Scripts use standalone `mongoose.connect` and are operator-gated. Hotel configuration requires `ROOM_MONGODB_URI` + `HOTEL_SESSION_SECRET` + allowed origins; first manager and indexes are created only by explicit `--confirm` CLI scripts. [SRC/DOC]

---

## 7. Backend performance findings (all SOURCE-BASED; no measurements)

Each finding: ID, source, current behavior, concern, correction, qualitative benefit, risk, dependencies, DB/index change?, owner approval?

### PERF-01 — Unbounded order fetch + JS aggregation + per-order `Intl` allocation (HIGH, architectural)
- **Source:** `lib/reportService.js:69-77` (no `.limit()`; >50k only logs); `lib/analytics.js:277-708` (~15 passes, 18 hourly filters at `:407-420`); `lib/ethiopianCalendar.js:172-195` (`new Intl.DateTimeFormat` per call); `app/api/cashier/report/route.js:39-43`; `app/api/station/report/route.js:59-64`.
- **Concern:** O(n) memory and O(n × buckets) CPU per report; can approach the 5s gateway budget as data grows; source comment itself says migrate at >50k.
- **Correction:** (a) memoize one module-level `Intl.DateTimeFormat` (safe, isolated); (b) single-pass `buildReport`; (c) migration to `$match+$group` pipelines keeping JS as parity oracle.
- **Benefit:** large CPU/GC/network reduction; latency closer to constant. **Risk:** financial-equivalence proof required for (c). **Dependencies:** Addis ordinal semantics. **DB/index:** basic indexes exist (`Order.js:239-244`); new pipelines may need `{status,createdAt}` (already present). **Owner approval:** yes for (c), no for (a).

### PERF-02 — Report endpoints re-query orders outside the cache (HIGH, API)
- **Source:** `app/api/manager/analytics/route.js:61-74` (second `Order.find` limited to 251); `app/api/cashier/report/route.js:37-43` (unbounded). Cache TTL is **30s** (`lib/reportService.js:48-52`), not 5s as older docs state.
- **Concern:** ~doubles DB work on every call; cached aggregate can be 30s stale while detail list is fresh.
- **Correction:** extend the cached value to include the order array/derived detail; derive views inside `getReport`. **Benefit:** one range query per cache miss. **Risk:** larger cache entries (bounded by 20-entry prune). **DB/index:** no. **Owner approval:** no.

### PERF-03 — N+1 in menu-policy classification inside a transaction (HIGH, safe code)
- **Source:** `lib/menuInventoryPolicyService.js:169-188, 190-251` (nested `legacyOrders→items→lines`, DB query per line at `:220`), inside transaction `:321-366`; reached from `actions.js:593-609`.
- **Concern:** latency grows with legacy order history while a transaction is held open.
- **Correction:** collect names, one batched `MenuItem.find({_id:{$ne}, $or: allClauses})`, name→item map; bound the open-order scan; preserve fail-closed ambiguity rules exactly. **Benefit:** O(lines) → O(1) queries. **Risk:** medium (semantics). **DB/index:** existing `{status,createdAt}` helps. **Owner approval:** no.

### PERF-04 — Hotel cold start and timeout budget (MEDIUM-HIGH, config/architectural)
- **Source:** `lib/hotel/db/connection.js:29-40, 77-133`; `instrumentation.js:9-20` warms POS only; `lib/hotel/config.js:78-85`.
- **Concern:** first ROOM request pays up to 5s selection ≈ gateway deadline; `socketTimeoutMS:30000` > gateway; no explicit concerns/`minPoolSize>0`.
- **Correction:** guarded non-blocking hotel warmup; lower selection timeout for headroom; explicit read/write concerns and `maxCommitTimeMS`. **Benefit:** removes ROOM cold-start risk. **Risk:** false-negative 503s on slow failover (DBA decision). **DB/index:** no. **Owner approval:** yes for timeout/concern values.

### PERF-07 — POS production index coverage incomplete (MEDIUM-HIGH, DB-dependent)
- **Source:** `lib/mongodb.js:66-108,180-182` (background build covers only 5 models); `scripts/sync-indexes.js:115-125` (9 models); defined-but-undeployed: `Session.js:133-143` (**TTL** `expiresAt`), `RecoveryEvent.js`, `RecoveryTask.js`, `ExtraItem.js`, `Recipe.js`, `Supplier.js`.
- **Concern:** sessions have no TTL → unbounded growth; recovery scans slow; missing unique backstops.
- **Correction:** extend `sync-indexes.js` additively. **Benefit:** bounded sessions, faster scans. **Risk:** unique builds fail on duplicates (script fails closed). **DB/index:** **yes**. **Owner approval:** **yes** (`--allow-production` + approval ref).

### PERF-08 — Hotel arrivals query has no leading-field index (MEDIUM, DB-dependent)
- **Source:** `lib/hotel/services/reports.js:324-328` filters `arrivalDate`; `lib/hotel/models/reservation.js:244-253` has no index beginning with `arrivalDate`.
- **Correction:** add `ReservationSchema.index({arrivalDate:1})` (or `{arrivalDate,status}`) and redeploy via hotel index script. **Benefit:** index-backed range scan. **Risk:** low. **DB/index:** **yes**. **Owner approval:** yes for production deployment.

### PERF-10 — Menu cache headers/invalidation inconsistent; canonical cache helper dead (MEDIUM, API)
- **Source:** `app/api/menu/route.js:7,92-104` (60s `s-maxage`, +300s SWR); `lib/cache.js:21-33` `invalidateMenuCaches()` has **no importers**; `actions.js:110-125` uses its own `revalidateAll()`; overlapping rules in `next.config.mjs:43-65` and `proxy.js:93-108`.
- **Concern:** new clients can see stale menu up to 60s+ after edits; ambiguous headers for brand/payment-info. **Correction:** pick one invalidation mechanism; wire or delete the dead helper; disambiguate header rules. **Risk:** lower TTL raises DB load. **DB/index:** no. **Owner approval:** possibly for CDN purge.

### PERF-11 — Report cache never invalidated on writes (MEDIUM, API)
- **Source:** `lib/reportService.js:48-87` (process-local TTL map); order mutations publish only SSE, no cache invalidation.
- **Concern:** dashboards up to 30s stale after payment; per-instance cache multiplication. **Correction:** versioned keys or explicit invalidation on order writes. **Risk:** coupling. **DB/index:** no. **Owner approval:** no.

### PERF-12 — Redundant session reads per authenticated request (MEDIUM, safe code)
- **Source:** `lib/serverAuth.js:95-132,154-171`; `lib/sessionStore.js:155-162` (`touchSession` re-reads session already loaded by caller).
- **Concern:** 3–4 DB round trips before business query. **Correction:** pass loaded session row to `touchSession`. **Benefit:** one fewer round trip. **Risk:** low; keep revoke/expiry checks. **DB/index:** no. **Owner approval:** no.

### PERF-13 — Redundant advisory count + parallelizable analytics reads (MEDIUM, safe code)
- **Source:** `app/manager/menu-crud/actions.js:190-193` then `:204-207`; `app/api/manager/analytics/route.js:61,65-69` (sequential awaits).
- **Correction:** remove advisory count; `Promise.all` for `getReport` + detail. **Benefit:** one fewer round trip; overlapped I/O. **DB/index:** no. **Owner approval:** no.

### PERF-14 — Retry loops lack backoff/commit budget (MEDIUM-HIGH, architectural)
- **Source:** `lib/transactionRunner.js:92-140` (3 attempts, fixed 20ms); `lib/orderService.js:409-420,1912-1926` (no backoff); `lib/inventory-v2/server/transaction.js:392` (fuller contract, **unwired**); `docs/production-readiness/phase-2-4-production-database-checklist.md:109-127`.
- **Concern:** lockstep retries; transaction can outlive request (unknown commit). **Correction:** exponential+jitter, `maxCommitTimeMS`/`maxTimeMS` below gateway; keep "never retry unknown commit"; wire or retire V2 helper. **Risk:** requires replica-set verification. **DB/index:** no. **Owner approval:** **yes** (DBA).

### PERF-15 — No pagination in POS lists/reports (MEDIUM, API)
- **Source:** `app/api/orders/route.js:236-242` (`.limit(200)` cap, no cursor); cashier/station reports unbounded. ROOM contrast: proper `skip/limit` in `lib/hotel/http/query.js:58-77` and all hotel list services.
- **Correction:** `limit/offset` or `(createdAt,_id)` cursor for `GET /api/orders`; deltas on SSE. **Risk:** client contract change. **DB/index:** existing indexes support cursors. **Owner approval:** no (coordinate clients).

### PERF-16 — Process-local SSE/state under serverless/multi-instance (MEDIUM-HIGH, architectural)
- **Source:** `lib/eventHub.js:15-45` (`globalThis` Set); `app/api/events/route.js:30-82` (long-lived stream, 25s ping, no `cancel()`); `lib/rateLimit.js:9-25` + `proxy.js:12-38` (two rate stores).
- **Concern:** cross-instance events lost; function duration kills streams; unbounded Sets/Maps; missing stream cleanup. **Correction:** shared pub/sub, add `cancel()`, serverless fallback, unify rate stores. **Risk:** new infra dependency. **DB/index:** no (external state). **Owner approval:** **yes**.

### PERF-05/06/17 — Low priority
- `PERF-05`: `lib/mongodb.js:78-80` sets `indexSyncStarted` before the enable check (dev/HMR only).
- `PERF-06`: `/api/health` (`app/api/health/route.js:39-53`) checks POS DB only — ROOM outage invisible.
- `PERF-17`: two API error envelopes (POS `lib/apiResponse.js` vs hotel `lib/hotel/http/apiResponse.js`) are deliberate; dead `cache.js`; `isExternal` retained in projections without consumers.

### Source-verified strengths to preserve
Batched `$in` reference maps (`lib/hotel/services/stays.js:665-729`, `reservations.js:310-324`), batched recipe/MenuItem reads (`orderService.js:59-92`), atomic `findOneAndUpdate` pipelines (`orderService.js:846-872`), aggregation in inventory analytics, correct transient-vs-unknown-commit classification (`transactionRunner.js:61-67,119-132`), and additive-only index scripts.

---

## 8. API findings

- **Envelope split:** POS `{success,data,error,message}` (`lib/apiResponse.js`) vs hotel `{success,data,error:{code,message}}` (`lib/hotel/http/apiResponse.js`) — intentional isolation; document rather than merge. [SRC]
- **Auth coverage:** all POS routes use `requireAuth`/live-session except public-by-design endpoints (`/api/menu`, `/api/brand` GET, `/api/payment-info` GET, `/api/events`, `/api/health`, `/api/menu` extras catalog uses `orders:create`). Hotel routes all pass through `authorizeHotelRequest`. [SRC]
- **Validation:** `lib/validate.js` covers order/status/pin/pagination; raw `request.json()` with targeted checks remains in manager staff/waiters, brand, payment-info, recipe writes. Hotel uses strict bounded JSON with size caps and no-operator acceptance. [SRC]
- **Redundancy:** `/api/manager/reports` is a legacy alias of `/api/manager/analytics` (deprecation documented); `lib/cache.js` dead; `isExternal` leftovers from the EXTERNAL retirement remain in projections (historical values still read-only). [SRC/DOC]
- **SSE:** `/api/events` is public and carries `{type,orderId,orderNumber,status,reason}` — see SEC-04. [SRC]
- **Health:** POS-only readiness — see PERF-06. [SRC]

---

## 9. Security and reliability findings (prioritized)

| ID | Sev | Finding (source) | Correction | Owner |
|---|---|---|---|---|
| SEC-01 | HIGH | `app/api/payment-info/route.js:10-43` + `next.config.mjs:60-65`: public, publicly cached full bank account numbers (incl. inactive). | Require scoped role or mask to last 4 + bank; filter inactive; remove public cache. | Yes |
| SEC-02 | MED-HIGH | `app/api/manager/staff/route.js:210-269`: manager PIN step-up optional; shared station PIN; cookie-only resolution (no tab-credential path). | Mandatory step-up; accept tab session; per-person station PINs. | Yes |
| SEC-03 | MED | `lib/sessionStore.js:26,66-79`: POS `idleExpiresAt` written but **never enforced** (8h absolute); hotel enforces 30m idle. | Enforce idle expiry or accept + document with client auto-lock. | Yes |
| SEC-04 | MED | `app/api/events/route.js:12-81` public SSE carries order id/number/status; no concurrent-stream cap. | Emit invalidation-only payloads or require any session; cap streams. | Yes |
| SEC-05 | HIGH (programmatic) | No `.github/` CI; `netlify.toml` builds only; no verified staging, backup/restore drill, rollback, or alerting (release roadmap docs). | Execute Gates 0–4 before release. | Yes |
| SEC-06 | MED-HIGH | Hotel track not production-ready (config, first manager, indexes, live integration all unverified) — `docs/hotel-foundation.md:11-21`. | Provision + run `--confirm` scripts + disposable-DB integration suite + runbook. | Yes |
| SEC-07 | MED-HIGH | `lib/orderService.js:1286-1339,1534-1537`: PAID commit + inventory consumption not atomic; recovery worker/deferred risks. | Approve recovery design, deploy indexes, implement reconciliation + refund model. | Yes |
| SEC-08 | MED | G-PAY-1 staging acceptance BLOCKED — no approved isolated staging; contract cases C1–C7 unexecuted. | Provision isolated staging, execute checklist, sign gate. | Yes |
| SEC-09 | MED | Three inconsistent in-memory rate limiters (`rateLimit.js`, `proxy.js`, hotel `rateLimit.js`). | Shared KV limiter, canonical IP extraction, per-account lockout. | Yes |
| SEC-10 | LOW | Retired legacy crypto (`sessionCrypto.js` dev secret) still in tree; no runtime importers. | Delete or `server-only`+throw; update `.env.example`. | No |
| SEC-11 | LOW | `orders/[id]` + `status` routes echo service error strings; logs carry full errors. | Stable codes + generic messages; redacted structured logs. | No |
| SEC-12 | LOW | Boot/health validates POS only; raw DB error text logged at warm-up. | Include `inspectHotelConfiguration()` + hotel connectivity; redact. | No |
| SEC-13 | LOW | No CSP despite security.js claim; unpinned Netlify plugin; CORS reflects same-host. | Pin plugin; report-only→enforce CSP; document CORS. | Yes for CSP |
| SEC-14 | LOW | PIN cache key contains plaintext 4-digit PIN; IP-only lockout. | HMAC the cache key; per-account lockout. | No |

**Positive controls (verified):** live-role authorization on both modules; no client/body role used for authz; server-authoritative POS totals and frozen payment identity; hotel folio immutability, payment idempotency and non-destructive void; conditional state transitions and per-room mutex; hotel role change revokes sessions; CSRF+Origin on all hotel mutations; env files git-ignored; provisioning scripts never print PINs. [SRC]

---

## 10. Unified architecture proposal

**Recommended: modular monolith (one Next.js app, two domain modules), experience-level unification only.**

- **Unified application shell:** shared brand header, theme/language providers, and homepage. Do **not** create a single universal dashboard component; keep a lightweight module hub.
- **Shared design system:** extend the existing CSS-variable theme (`--c-card`, `--c-accent`, etc.), Tabler icon set, `MenuItemImage`-style fallbacks, Ethiopian date pickers, and translation keys. Add a small set of shared primitives (Card, ModuleCard, Breadcrumb, PageHeader, StatusPill) in a new neutral `app/components/shared/` — additive, not replacing domain components.
- **Authentication:** keep two independent session stacks. Sharing a session would couple two databases and two role engines — not safe. Optionally add a single sign-on *portal credential vault* later only with explicit owner approval. Module-level authorization remains per domain (`lib/policy.js` vs hotel `authorization.js`).
- **API entry points:** keep `/api/*` (POS) and `/api/hotel/*` (ROOM) separate. Do not rename or merge existing endpoints. A thin `/api/health` can be extended to report both modules.
- **Databases:** preserve both databases and both connection managers exactly. No cross-database transactions now; if future cross-module features need them, use application-level saga/outbox patterns, never a shared schema.
- **Integration:** safe POS↔ROOM integration is read-only/invalidation-level at first (e.g., a manager "operations overview" that calls both systems' existing APIs and renders side-by-side). Charging POS items to a room is explicitly deferred.
- **Observability/config:** unify operational configuration *documentation* (env var inventory, index-deploy runbooks, health) and logging conventions, but keep separate secrets. Reuse `lib/operationalLogger.js` conventions in hotel where safe.
- **Failure isolation:** each module keeps its own DB failure mode (POS 503 via `withApi`; hotel via `withHotelApi`); a ROOM outage must not break POS and vice versa.
- **Backward compatibility:** keep all aliases (`/kitchen`, `/manager/reports`, legacy `/api/manager/reports`) and existing routes; redirects only added, never removed.

**Rejected alternatives:** database merge (no evidence, high risk); microservices (no source-level need, no owner-approved phase); full rewrite (violates constraints). [INF grounded in §3–9]

---

## 11. Homepage layout blueprint (design only — do not implement)

### 11.1 Two primary cards

**Header (shared):** brand "BONO MANAGEMENT SYSTEM" + tagline, `LanguageToggle` + `ThemeToggleHome` (already exist), consistent with current `app/page.js` header.

**POS card** — sub-navigation (6 links, using existing route targets):
- Manager Reports → `/manager/reports`
- Cashier → `/cashier`
- Waiter → `/waiter`
- Kitchen → `/kds`
- Barista → `/barista`
- Jebena Buna → `/jebena`

**ROOM card** — sub-navigation (3 links):
- Reception → `/hotel/reception`
- Room Management → `/hotel/rooms`
- Room Reports → `/hotel/reports`

### 11.2 Layout guidance (based on existing code, not speculation)

- **Desktop (lg):** two equal-height cards side by side (CSS grid `lg:grid-cols-2`, `auto-rows-fr`), each with a module identity band (icon + color accent), a short description, and a tidy grid of sub-links. POS 6 links → 2 columns × 3 rows; ROOM 3 links → 1 column × 3 rows (or 3 across with shorter labels). Reuse `card-elevated tactile` classes and CSS variables already in use (`app/page.js:222`).
- **Tablet (md):** stack cards vertically, each full width; sub-link grid remains 2 columns.
- **Mobile:** single column, POS card first then ROOM; sub-links in a 2-column grid with `min-h-[110px]` tap targets; keep the existing 3-dot pre-mount loader (`app/page.js:154-162`) and the existing footer.
- **Brand/identity:** module accent colors derived from the theme (POS warm accent, ROOM cooler tone) but using theme variables so dark mode works; Tabler icons per sub-link (reuse existing `PortalIcon` mapping, add hotel icons).
- **Role visibility:** the homepage is a launchpad, not an authorization boundary — show both modules to everyone; per-route guards and PIN modals enforce access. Optionally de-emphasize (not hide) sub-links the current browser's session cannot open; do not rely on client hints for security. A unified "Manager overview" is **appropriate only for MANAGER roles** and should be a separate optional page, not a merged dashboard card.
- **Accessibility:** semantic `<nav aria-label="POS module">`, `<h2>` per card, visible focus rings (already via `card-elevated`?), `aria-hidden` on decorative icons (existing pattern), min 44px targets, keyboard order matching visual order, `aria-live` for loading state.
- **Icons/loading:** reuse `@tabler/icons-react`; keep icon sizing consistent (current 36px portals). Loading: keep `useSyncExternalStore` loader; add skeleton cards if async module metadata is introduced.
- **Entry/back behavior:** each sub-link keeps the current click semantics — open `PinLoginModal` for role-gated POS entries, or navigate to hotel pages which self-gate. Preserve current back behavior (homepage reachable via browser Back for all except `/menu`, which uses `router.replace` intentionally). Provide a visible "Home / All modules" link inside each module layout so users are not dependent on browser Back.

### 11.3 Proposed component architecture (additive)

```
app/components/shared/ModuleCard.jsx      (presentational; icon, title, desc, children links)
app/components/shared/ModuleLink.jsx      (uniform sub-link with icon + label)
app/components/shared/ModuleHubHeader.jsx (brand + language/theme controls)
app/page.js                               (compose two ModuleCards; keep PinLoginModal)
```
No existing file needs deletion; `PORTALS` data can be split into two module arrays.

### 11.4 Routes to preserve vs plan

- **Preserve exactly:** all routes in §4.1 and §5.1, including aliases `/kitchen`, `/manager/reports`, `/launch`, `/menu`.
- **Mapping/redirect planning required (do not change now):** none for the nine requested links — all exist. The only known gap is `/login?next=/cashier` defaulting to MANAGER (see §4.1); flag for a future fix, do not change in this phase. No speculative route changes are proposed.

---

## 12. Module navigation blueprint

- **POS module:** homepage card → sub-link → `PinLoginModal` (role from portal config) → route layout `getPortalSession(role)` + `PinGuard`. Inside `/manager/*`, `ManagerSidebar` provides secondary nav (Reports, Menu, Inventory, Staff). Each station header provides Settings gear (PIN change) + theme/language toggles. A "Home" breadcrumb returns to `/`.
- **ROOM module:** homepage card → sub-link → hotel page → shared `/hotel` layout session gate → `HotelPinLogin` (role-scoped PIN) if unauthenticated. `HotelTopBar` carries title, Ethiopian date, language/theme toggles. Tabs within `ReceptionUI`/`RoomsUI` provide sub-navigation. Manager-only panels guard reports. Add a "Home" link to `HotelTopBar`.
- **Cross-module nav:** only from the homepage module cards (and optionally a MANAGER-only operations overview). Do not embed cross-module links deep inside station screens — preserves focus and failure isolation.

---

## 13. Frontend unification strategy

1. Add shared presentational primitives and a module-card composition; leave all domain components untouched.
2. Consolidate duplicated theme/language/date usage behind the existing providers (no new providers).
3. Normalize page headers/breadcrumbs and loading/error states across both modules (additive wrappers).
4. Keep POS client-island model and hotel client-shell model unchanged.
5. Keep components that must remain domain-specific: all station UIs (`CashierUI`, `WaiterUI`, `KitchenDisplay`, `StationReportPanel`), manager CRUD/inventory/staff, and all hotel panels/forms/`hotelApi`.
6. Do not merge schemas, collections, translation dictionaries, or API hooks merely for uniformity.

---

## 14. Backend integration strategy

1. **APIs:** no changes to existing endpoints. Optionally add read-only aggregation endpoints (manager operations overview) that fan out to existing APIs; no shared write path.
2. **Shared services:** only transport/logging/config documentation can be shared. Keep domain services separate.
3. **Auth/sessions:** keep separate. If SSO is desired, treat as a new owner-approved phase with threat modeling.
4. **DB connections:** keep two managers; apply PERF-04 (hotel warmup/timeouts) and health extension.
5. **Cross-module features:** start with read-only cross-module reporting; defer any transactional POS↔ROOM operation (e.g., restaurant charge to room) until an owner-approved saga/outbox design exists.
6. **Preserve domain-specific:** order state machine, inventory policy engine, hotel folio/payments, booking locks, both permission matrices.

---

## 15. Performance optimization roadmap (prioritized)

| Order | IDs | Category | Change | Owner approval | DB/index |
|---|---|---|---|---|---|
| 1 | PERF-01a, 12, 13, 06 | Safe code / health | `Intl` memoization; session-touch reuse; remove advisory count + parallelize; hotel health check | No | No |
| 2 | PERF-02, 11, 10, 15 | API / caching | Single cached order set; cache invalidation; header cleanup; pagination (coordinate clients) | No (CDN maybe) | No |
| 3 | PERF-03 | Safe code (tests) | Batch N+1 classification with parity tests | No | No |
| 4 | PERF-07, 08, 04, 14 | DB-dependent / config | Index expansion; hotel arrivalDate index; warmup/timeouts; retry budget | **Yes** | **Yes** (07/08) |
| 5 | PERF-01b/c, 16 | Architectural | Single-pass + aggregation pipelines; shared pub/sub + serverless strategy | **Yes** | Pipeline indexes may be needed |

Each finding's full detail (current behavior, concern, correction, benefit, risk, dependencies, verification strategy) is in §7. Verification strategy in general: parity tests against the current JS aggregator, DB-free unit tests, disposable replica-set tests for transactions, index preflight (duplicate check) before any deployment, and staged load/soak tests with real metrics before/after — none performed in this phase.

---

## 16. Risk classification

- **HIGH / owner-gated:** SEC-01 (public account disclosure), SEC-05 (no release gates), PERF-01 (report scaling), PERF-07 (index deployment), PERF-16 (serverless realtime).
- **MEDIUM-HIGH:** SEC-02, SEC-06, SEC-07, PERF-03, PERF-04, PERF-14.
- **MEDIUM:** SEC-03, SEC-04, SEC-08, SEC-09, PERF-02, PERF-08, PERF-10, PERF-11, PERF-12, PERF-13, PERF-15.
- **LOW:** SEC-10…14, PERF-05, PERF-17.
- **Risk of the proposed homepage work:** low if additive; the main risk is role-visibility confusion (mitigated by keeping per-route guards authoritative) and cache-header ambiguity (PERF-10) if module metadata is cached.

---

## 17. Dependencies and owner decisions

Owner decisions required before implementation:
1. Approve **experience-level-only unification** and reject DB/auth merge (§10).
2. Approve homepage blueprint and whether a MANAGER-only operations overview is in scope (§11).
3. Decide SEC-01 remedy (mask vs authenticate payment info) — affects customer transfer UX.
4. Decide SEC-02 (mandatory manager PIN step-up, per-person station PINs).
5. Decide SEC-03 POS idle-expiry policy (enforce vs accept + document).
6. Decide SEC-04 SSE policy (authentication and/or invalidation-only payloads).
7. Approve production-readiness gates (SEC-05/06/07/08): staging environment, backup/restore, replica-set verification, index deployment approval refs, G-PAY-1 contract decisions.
8. Choose deployment topology (single Node instance vs serverless) — determines PERF-16 approach.
9. Approve timeout/concern values and index changes (PERF-04/07/08/14) with DBA input.
10. Confirm the documented baseline digest algorithm, or accept count-vector matching as the baseline proof (§21).

Technical dependencies: staging + replica-set availability for transaction tests; client coordination for pagination (PERF-15); CDN config access for cache purge (PERF-10).

---

## 18. Implementation phases (planning only — not started)

- **Phase U0 — Decisions & baseline:** owner decisions §17; freeze a signed baseline manifest; re-verify the three EXTERNAL deletions.
- **Phase U1 — Homepage/shell:** additive two-card hub + shared primitives + "Home" links; preserve all routes; regression-test navigation and PIN flows.
- **Phase U2 — Safe backend quick wins:** PERF-01a, 12, 13, 06;SEC-10/11/12/14 cleanups; add parity tests.
- **Phase U3 — API/caching:** PERF-02, 11, 10, 15; coordinated client changes.
- **Phase U4 — Owner-gated ops/DB:** PERF-07, 08, 04, 14; SEC-01/02/03/04/05/06/07/08/09 remediation with staged verification.
- **Phase U5 — Architectural (optional):** PERF-01b/c, 16; MANAGER operations overview; only if owner-approved.

Each phase ends with the regression strategy in §19 and a Git baseline delta check.

---

## 19. Regression strategy

- **DB-free tests:** run the full `node --test tests/*.test.mjs` suite plus focused suites (`hotel-*`, `phase21-*`, `order-catalog-availability`, `payment-*`, `pos-index-management`, `kds-single-flight-polling`, `station-report`). Prior docs claim ~1500+ passing DB-free tests; re-establish the current count at the start of each phase.
- **Source-contract greps:** no cross-module imports; no `syncIndexes` in runtime path; zero unguarded manual `NextResponse.json` in migrated handlers; EXTERNAL deletions still absent.
- **Parity checks:** report totals before/after PERF-01/02 (analytics vs reports envelope); menu before/after PERF-10; auth flows ( PIN, tab heartbeat, logout) after PERF-12.
- **Staged/replica-set:** transaction conflict/abort, payment immutability, booking overlap/locks, index duplicate preflight — only in isolated staging with owner approval.
- **Manual UI checks:** homepage cards on desktop/tablet/mobile, keyboard nav, dark mode, language toggle, role-specific visibility, back-navigation.
- **Git checks:** before/after status vector; confirm only phase-intended files changed; confirm no EXTERNAL restoration.

---

## 20. Deployment considerations

- Deployment is Netlify (`netlify.toml`, `@netlify/plugin-nextjs` unpinned) with `proxy.js` middleware, `instrumentation.js` boot hook, and PWA assets (`app/manifest.js`, self-unregistering `public/sw.js`). [SRC]
- No build/deploy was run in this phase (would load env files / possible static DB access — prohibited).
- Before any release: pin plugin version (SEC-13); add/report-only CSP; verify both secrets and DB URIs are configured by name; deploy indexes via guarded scripts with approval refs; run restore/rollback drills; sign staging gates (SEC-05/06/08).
- Homepage changes are pure client composition — no new deployment configuration required. Any cache-header change (PERF-10) must be validated at the CDN layer.
- Keep POS and ROOM failure modes independent: a ROOM config absence must not prevent POS boot (note `instrumentation.js` warms POS only, which helps).

---

## 21. Explicitly unverified items

1. No database was contacted; no schema, index, collection, or data state was verified at runtime. All DB statements are source-based.
2. No measurements: no latency, payload size, query plan, index usage stats, or load results.
3. No build or test execution; test counts are quoted from existing docs, not re-measured.
4. The Phase 2.1.1 digest algorithm is undocumented; baseline equivalence was proven by matching count vector + HEAD, not by digest.
5. Cross-module import isolation was verified by targeted grep/tests-in-source, not by an automated dependency graph tool.
6. Deployment topology (single Node vs serverless/fan-out) is inferred from docs and process-local design; not confirmed with the platform owner.
7. Production MongoDB replica-set/transaction availability remains unverified (documented blocker).
8. The `docs/production-readiness/*` and phase reports contain some stale counts (e.g., test totals, clean-order-history hardening) — treat as claims to re-verify, not facts.
9. Hotel UI beyond Reception and the "not production-ready" status are from `docs/hotel-foundation.md` and source shape; live behavior unverified.

---

## 22. Recommended next phase

**Recommended: Phase U0 — Owner decisions + baseline freeze** (§18). Obtain the ten owner decisions in §17, confirm the deployment topology and the baseline proof, and re-verify the three EXTERNAL deletions. Only after approval proceed to **Phase U1 (two-card homepage + shared shell, additive)** and **Phase U2 (safe backend quick wins)**, each with the regression checks in §19.

**Do not implement any recommendation from this report before owner approval.**

---

## Final audit summary (for the owner)

- **Preflight/baseline:** root `C:/hotelms`; `main`; HEAD `69650435…`; 238 entries (81 M / 3 D / 154 untracked entries / 391 untracked files); 0 staged; matches the Phase 2.1.1 final state exactly — no changes since baseline. Three EXTERNAL deletions confirmed intact and preserved.
- **Coverage:** POS routes/components/services/models/actions; ROOM routes/API/services/models/auth/DB; both connection managers; backend performance across both; security/reliability/deployment/tests. All source-based; zero measurements.
- **Major architecture findings:** two deliberately isolated modules; two separate databases/connections/session stacks; nine requested sub-pages already exist; homepage is six flat portals with no ROOM entries; one Server Action module; SSE is the realtime mechanism.
- **Performance priorities:** PERF-01 (report aggregation + `Intl`), PERF-02 (duplicate report queries), PERF-03 (N+1 classification), PERF-04 (hotel cold start), PERF-07 (indexes), PERF-14 (retries), PERF-16 (serverless state).
- **Homepage proposal:** two module cards (POS 6 links, ROOM 3 links), shared brand header, responsive grid, role visibility delegated to existing guards, additive shared `ModuleCard`/`ModuleLink` components, no route rewrites.
- **Recommended architecture:** modular monolith — unify shell/design/navigation/ops-config; keep DBs, auth, APIs, and domains separate; no rewrite, no DB merge, no microservices.
- **Critical/high risks:** SEC-01 public bank-account disclosure; SEC-05 no release gates; PERF-01/PERF-07/PERF-16 scaling/ops risks; plus owner-gated SEC-02/03/04/06/07.
- **Proposed sequence:** U0 decisions → U1 homepage/shell → U2 safe quick wins → U3 API/caching → U4 gated ops/DB → U5 optional architecture.
- **Files changed:** only `docs/bono-unified-system-architecture-performance-audit.md` (this report, new/untracked).
- **Git baseline delta:** expected +1 untracked file; no staging/commit/push/reset/stash/clean/checkout.
- **Confirmation:** no DB, migration, seed, index, deployment, `.env`/secret access, or Git mutation was performed; the three EXTERNAL deletions were not restored.

**STOP — awaiting owner approval. No recommendation has been implemented.**
