# Hotel Management / POS System (BonoDig · I HOPE CAFE)

Production-ready Next.js 16 POS for hotel/café: menu, waiter ordering, KDS/barista boards, manager reporting, brand/payment config. Unified MongoDB, HttpOnly session auth, SSE-first real-time.

## Architecture

```
Browser (Waiter / KDS / Barista / Manager / Menu)
  ↓ fetch / Server Action
Canonical API (app/api) + withApi envelope {success,data,error}
  ↓ requireAuth (lib/security) + policy.can (lib/policy)
  ↓ validate (lib/validate) — strict, NoSQL-injection guarded
  ↓ Domain Service (lib/orderService, menuService, reportService, staffService, authService)
  ↓ lib/mongodb connectToDatabase — single mongoose.createConnection pool (globalThis, 10 poll, 3s serverSelection)
  ↓ MongoDB Atlas hotel_management (orders, categories, menuitems, staffs, system_auth)
  ↓ publish (lib/eventHub) → /api/events SSE → clients refetch (invalidation, not full dataset)
```

- **One** DB connection (`lib/mongodb.js` `connectToDatabase`; `lib/dbConnect.js` removed in Phase 6), **one** schema per entity, **one** auth (HMAC HttpOnly `bono_sess`), **one** policy, **one** order lifecycle, **one** report service.
- **Caching:** `menu/brand/payment-info` public `s-maxage=60 stale-while-revalidate=300` (CDN), invalidated via `revalidateTag('menu')` + `revalidatePath` on CRUD (`lib/cache.js`). Orders/reports `no-store` (operational), reports 30s TTL (`reportService`).
- **Real-time:** `POST/PATCH /api/orders` → `publish` → `GET /api/events` SSE `text/event-stream` 25s ping → clients debounced 150ms refetch. In-memory `globalThis.__orderEventHub` (single-instance; multi-instance needs Redis — documented). Fallback poll 30s KDS, 30s Waiter orders + 60s menu, visibility-gated.
- **Security:** `next.config.mjs` + `proxy.js` security headers (`nosniff`, `DENY`, `Referrer-Policy`, `Permissions-Policy`, `HSTS` prod), CORS same-origin only, `X-Content-Type-Options`.

## Routes

| Route | Guard | Description |
|---|---|---|
| `/` | public | Portal hub → waiter/kds/barista/manager/menu |
| `/menu` | public (cacheable) | Customer menu (categories+items, multi-lang am/en/om), search/sort, cart, brand header, pay-info modal |
| `/waiter` | `WAITER` (PinGuard) | Table 1-10, language, ACTIVE orders drawer, cart → `POST /api/orders`, pay `PATCH /api/orders/[id]` |
| `/kds` | `KITCHEN` | `FOOD` board, `ACTIVE` orders, `PREPARING↔READY`, chime, elapsed, `ARCHIVED` dismiss |
| `/barista` | `BARISTA` | `DRINK` board (same component, `station=DRINK`) |
| `/kitchen` | redirect → `/kds` | Compatibility alias (documented) |
| `/login?next=/waiter` | public | `PinGuard` → `POST /api/auth/verify-pin` or `login-staff` |
| `/manager` | redirect → `/manager/reports` | — |
| `/manager/reports` | `MANAGER` | Executive KPIs, hourly/shift/trends, top/slow items, waiter/kitchen perf, payment breakdown, export CSV/PDF; fetches `GET /api/manager/analytics` on-demand + 60s bg when visible (was 3s poll) |
| `/manager/menu-crud` | `MANAGER` (Server Actions) | Categories + items CRUD (3-lang names, price, image Cloudinary), station toggle Foods/Drinks, paymentInfos CRUD, brand name/logo upload |

## Roles & Auth

| Role | Access |
|---|---|
| `WAITER` | `orders:create` (POST), `orders:transition:SERVED/PAID`, `orders:read` ACTIVE, `orders:external`, `events:subscribe` |
| `KITCHEN` | `orders:transition:PREPARING/READY/ARCHIVED` |
| `BARISTA` | same as KITCHEN for DRINK |
| `MANAGER` | all above + `menu:mutate`, `brand:mutate`, `reports:read`, `settings:*`, `staff:mutate`, `orders:transition:CANCELLED` |

**Auth flow:** `POST /api/auth/verify-pin` (terminal PIN) or `POST /api/auth/login-staff` (name+PIN+role) `verifyStaffPin`/`verifyRolePin` scrypt hash → `createSessionToken({role,staffId,name,waiterNumber,iat,exp})` HMAC-SHA256 `AUTH_SECRET` → `Set-Cookie bono_sess HttpOnly lax secure(prod) maxAge 7d`. Server `requireAuth` reads cookie (or `Bearer`), `verifySessionToken` checks `exp/iat` + timingSafeEqual. `GET /api/auth/logout` deletes cookie + `unlockWaiter`. No PIN/password/token in `localStorage` (only `deviceId`, `staff_name/id` convenience). `AUTH_SECRET` required in prod (throws otherwise).

## Database

- **URI:** `MONGODB_URI` (also `CAFEDB_URI` alias) → `hotel_management` (Atlas, 60s s-maxage menu). One `createConnection` pool, `bufferCommands:false`, `serverSelection 3s`.
- **Collections:** `orders`, `categories`, `menuitems`, `staffs` (per-person, `pinHash` scrypt, `name+role` unique), `system_auth` (`_id=system` 4 hashed PINs + `activeWaiters[{waiterNumber,deviceSessionId}]`), `brandconfigs` (single `{name,logoPath}`), `paymentinfos`, `counters{_id=order_seq}`. Legacy `users` (0 docs) dropped Phase 3, `brandings` retained until manual review.
- **Indexes:** `orders: orderNumber, tableNumber, status, createdAt, status+createdAt, status+items.type+createdAt, waiterNumber/Id/staffId+createdAt, isExternal`; `categories: slug unique Wells`; `menuitems: category+isAvailable`; `staffs: name+role unique, role+createdAt`. Legacy `categoryId_1_isAvailable_1` dropped.
- **Schemas strict:true** Phase 3 (MenuItem `suppressReservedKeysWarning` for `isNew`).

## API

Envelope ` {success, data, error, message} ` via `lib/apiResponse ok/fail`, `withApi` maps DB →503, unknown→500 never leak stack. Headers `Cache-Control` as above.

| Method | Path | Auth | Body/Query | Notes |
|---|---|---|---|---|
| POST | `/api/auth/verify-pin` | `limit 5/min` | `{role,pin}` | terminal shared PIN → HttpOnly |
| POST | `/api/auth/login-staff` | `5/min` | `{name,pin,role}` | per-person, auditable |
| POST | `/api/auth/logout` | any | `{role,waiterNumber,deviceSessionId}` | clears cookie + unlock |
| GET | `/api/menu?lang=&category=&all=` | public (60/min) | `lang am/en/om, category id/slug, all` | via `menuService.getUnifiedMenu`, public s-maxage 60 |
| GET/POST/PUT | `/api/brand` | `mutate:MANAGER` | `{name,logoPath}` | single doc |
| POST | `/api/brand/upload` | `MANAGER` 10/min | `form file` | png/jpg/webp/gif/svg 5MB, Cloudinary `menu_items` |
| GET/POST/PUT/DELETE | `/api/payment-info` | `mutate:MANAGER` | `{bankName,ownerName,accountNumber,isActive}` | |
| GET | `/api/staff?role=` | any auth | | list staffs |
| POST | `/api/manager/staff` | `MANAGER` | `{staffId,newPin}` | manager can reset any PIN |
| GET | `/api/manager/analytics?from=&to=&interval=` | `MANAGER` | `YYYY-MM-DD, interval daily/hourly/shift/trends` | canonical, 30s TTL, no 5k truncation |
| GET | `/api/manager/reports` | `MANAGER` | same | legacy alias → same service + Deprecation Sunset Dec 2026 |
| POST | `/api/orders` | `WAITER/MANAGER` 30/min | `{tableNumber,items[{name,price,quantity,type,itemId?}],waiterName/Number/Id}` | server snapshots `MenuItem.price` via `itemId`, `totalAmount` recomputed |
| GET | `/api/orders?status=&table=&waiterName=&date=` | any auth | `ACTIVE` default (PENDING/PREPARING/READY) limit 200 | |
| GET/PATCH/DELETE | `/api/orders/[id]` | `read:any, patch:canTransition, delete:ARCHIVED` | `{status,action,paymentMethod,kitchenStaffId?}` | state machine enforced |
| PATCH | `/api/orders/[id]/status` | same as above | `{status}` alias | |
| POST | `/api/external-sales` | `WAITER/MANAGER` | `{tableNumber,items,waiterName,paymentMethod}` | `isExternal:true` PAID directly, `EXT-…` |
| GET | `/api/waiter/active` | public | — | `activeWaiters` from snapshot cache |
| GET | `/api/events` | public | SSE | `text/event-stream` 25s ping |
| POST | `/api/manager/settings/*` | `MANAGER` + PIN re-auth | `{currentManagerPin}` + pins | `update-pins`, `reset-waiters`, `clear-orders` (destructive → session+PIN) |

## Order Lifecycle

`PENDING → PREPARING → READY → SERVED → PAID` (`CANCELLED` terminal via MANAGER from any except PAID, `ARCHIVED` KDS soft-delete hides from ACTIVE but keeps history). `payOrder` idempotent (retry same `PAID` returns same). `totalAmount` server-authoritative, `paymentMethod CASH/TELEBIRR/NONE`. Timestamps `preparingAt/readyAt/servedAt/paidAt/completedAt` idempotent.

## Menu / KDS / Barista / Waiter / Reports

- **Menu:** `Category {name{am,en,om}, slug unique, targetStation/type, order, isActive}` → `MenuItem {name{am,en,om}, price, category→Category, targetStation/station, imageUrl/image, isNew/isItemNew/isPopular→isNew, isAvailable/inStock→isAvailable, categoryType}`. Service `menuService.serializeCategory/Item` single alias resolver.
- **KDS/Barista:** `KitchenDisplay` (`station FOOD/DRINK`) polls `ACTIVE` lean `status_1_createdAt` IXSCAN, SSE 30s fallback, `NEW_FLASH 6s`, `TICK 1s` elapsed `priorityOf`, `ARCHIVED` dismiss.
- **Waiter:** `WaiterUI` menu cache 60s, orders 30s + SSE coalesce 150ms, `sendOrder` auditable `waiterId/waiterInfo`, external `isExternal` → `external-sales`.
- **Reports:** `analytics.js buildReport` on in-range orders (no limit), kpis revenue PAID only, `revenueDeltaPct`, hourly 6-23, shifts A/B, daily/weekly, `topItems/slowItems` by `qty`, `waiterPerf/kitchenPerf/baristaPerf` by `staffId`, `paymentBreakdown`, `externalSales`. `api/manager/analytics` 30s TTL, no 3s poll (60s bg when visible).

## Real-time Events

`publish({type:"orders-changed",orderId})` + `ORDER_READY{waiterNumber/Name/Id}` → `/api/events` `globalThis.__orderEventHub` Set. Clients `useOrderEvents` `EventSource` auto-reconnect, filter `ping`, `scheduleRefresh` debounce. Single-instance; multi-instance swap to Redis (same api).

## Environment

```
MONGODB_URI=mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/hotel_management?retryWrites=true&w=majority
CAFEDB_URI=same
AUTH_SECRET=64-hex-random  # required prod, else throws
NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=... # server-only
# ALLOWED_ORIGINS=https://admin.example.com
```
See `.env.example` (placeholders only, never commit `.env.local`). `.gitignore` has `.env*` + `!.env.example`, `dev.out`, `body.json`.

## Deployment

`next build` → `next start`. `instrumentation.js` warms DB on boot. Set `TZ=Africa/Addis_Ababa` for Ethiopian business day (reports). `proxy.js` + `next.config.mjs` handle CORS same-origin, rate-limit (in-memory per-IP, single-instance), `no-store` for operational APIs, `s-maxage 60` for catalog.

## Migrations

- `scripts/migrate-phase3-canonical.js --apply` — backfills `category/targetStation/imageUrl/isNew/isAvailable/order` etc., idempotent, verifies 0 missing canonical, 0 count delta. Dry-run default.
- `scripts/sync-indexes.js` — `Order syncIndexes` (now via `lib/mongodb` background).
- `scripts/sync-menu-categories.js [--apply]` — rebuilds `categories` from `menuitems` refs, order 1..N.
- `scripts/clean-order-history.js` / `DRY_RUN=1` — wipes `orders` + `counters` + `activeWaiters` (preserves menu/staff/pins).
- `scripts/seed-auth.js` / `reset-auth.js` — hashed default PINs (1111/2222/3333/4444).

## Troubleshooting

- `503 Database temporarily unavailable` → check `MONGODB_URI`, Atlas IP allowlist, `instrumentation` log `db connection warmed`, `withApi` 503 `Retry-After:2`.
- `401/403` → missing/expired `bono_sess` or wrong role — re-login via `/login?next=`.
- Menu stale after CRUD → `revalidateTag('menu')` + `revalidatePath` (lib/cache) — wait 60s s-maxage or hard refresh.
- Waiter `IN USE` stuck → `POST /api/manager/settings/reset-waiters` with MANAGER PIN re-auth, or `verify-waiter` re-bind.

## Security

`lib/sessionCrypto` HMAC `exp 7d`, `HttpOnly lax secure(prod)`, `lib/security requireAuth` + `policy can/canTransition` server-side only, `validate` strict (ObjectId, prices 0-100k, qty 1-99, dates YYYY-MM-DD), `rateLimit` in-memory 5-100/min per IP (documented single-instance), `cloudinary` mime 5MB whitelist, `apiResponse` never leaks stacks, scripts redact URI (`host (redacted)`), `.env.example` placeholders. Rotate `AUTH_SECRET`/`MONGODB_URI`/`CLOUDINARY_API_SECRET` if ever exposed.

## Performance

Reports on-demand (was 3s), menu 60s CDN, Waiter 30s orders + 60s menu (was 10s/15s), KDS 30s (was 5s), SW disabled (no stale), external unsplash fallback removed → `/placeholders/food.svg`. Build `next build` must pass, `npm run lint`.

#   c a f e - m s  
 