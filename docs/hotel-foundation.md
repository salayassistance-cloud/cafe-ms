# Hotel Management Foundation

## Status

This is an **isolated Hotel backend foundation** with Hotel-only username +
four-digit PIN login/logout Route Handlers, Room Type and Room CRUD Route
Handlers, Guest management, Reservation
creation/viewing/update/cancellation/room-assignment Route Handlers, and the
check-in/check-out/Stay workflow. It also includes explicit first-Manager
provisioning and per-user credential-rotation commands plus Phase 4C payment
recording. It is **not** production-ready and not a complete Hotel system: no
Hotel UI beyond the Reception screen, guest requests, seed/migration has not been
implemented. A guarded Hotel-only index deployment script exists, but no indexes
have been deployed and no live-database integration test has been run.

At implementation time, `.env.local` was checked **by key name only** (no values
were read or printed): it did not contain `ROOM_MONGODB_URI` or
`HOTEL_SESSION_SECRET`. No Hotel user was created, no provisioning command was
run, no live database was contacted, and no index was created. Hotel
authentication must not be described as operational until configuration and
disposable-database integration tests are complete.

## Isolation boundaries

- Hotel data uses `ROOM_MONGODB_URI` and the `bono_hotel` database.
- `lib/hotel/db/connection.js` creates a dedicated Mongoose connection with its
  own pool. It never uses `lib/mongodb.js` or the default Mongoose connection.
- No POS route, API, model, session, cookie, staff record, auth helper, menu
  code, or business logic is imported or modified.
- `RoomType` and `Room` are compiled only on the supplied Hotel connection.
  There is no default-model export and no registration on the POS connection.
- Room and Room Type services receive the resolved Hotel connection explicitly;
  they never use the default Mongoose connection.
- The Hotel cookie is `__Host-bono_hotel_session`. POS cookies such as
  `bono_sess` and `__Host-bono_session` are never read or written.
- The Hotel session secret is independent of `AUTH_SECRET`; configuring the same
  value is rejected.

## Configuration (not yet present)

Add these to `.env.local` (never commit it) or the deployment secret store:

```dotenv
# Server-only MongoDB URI for the Hotel database.
ROOM_MONGODB_URI=mongodb+srv://<cluster>/bono_hotel

# Separate Hotel session HMAC secret. At least 32 characters; 64 random hex is
# recommended. MUST differ from AUTH_SECRET.
HOTEL_SESSION_SECRET=<generate-a-separate-secret>

# Optional: extra exact origins allowed to call Hotel auth routes. Comma
# separated, bare origins only (no wildcards or paths). The application's own
# origin is always accepted.
HOTEL_ALLOWED_ORIGINS=https://hotel.example

Note: `HOTEL_ALLOWED_ORIGINS` validates origins at the Hotel handler layer; it does not itself enable cross-origin preflight through `proxy.js`. A browser frontend on another host or port may fail its `OPTIONS` request. Prefer same-origin deployment unless cross-origin support is separately reviewed and approved. This documentation change does not authorize modifying `proxy.js`.
```

The application also forces `dbName: "bono_hotel"` when opening the connection,
so a URI without a database path is acceptable. A URI that explicitly names any
other database is rejected. Use a MongoDB user scoped to the Hotel database; do
not reuse the POS database credentials. Integration tests must use a separate,
throwaway MongoDB instance, container, or port. Another database name on a
shared cluster is not sufficient isolation because the connection forces the
`bono_hotel` database name.

`inspectHotelConfiguration()` returns safe readiness booleans and never includes
the URI or secret values.

Generate a local secret only when ready to configure the environment:

```bash
$hotelSecret = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
# Enter the value manually in .env.local or your deployment secret manager.
# Never print or paste the secret into chat, documentation, or Git.
Remove-Variable hotelSecret
```

Do not paste the generated value into source, documentation, chat, or Git.

## Database connection behavior

`connectToHotelDatabase()` is explicit: importing the module never connects.
The connection is cached on `globalThis` across Next.js hot reloads, reconnects
when the URI fingerprint changes or a stale connection is detected, and resets
after a failed initial connection.

Safety defaults:

- `dbName: "bono_hotel"`
- `autoIndex: false`
- `autoCreate: false`
- `bufferCommands: false`
- pool size 10, server-selection timeout 5s, connect timeout 10s

Consequently, normal application use cannot create collections or indexes.
Index definitions in the models are documentation for a separately approved
deployment operation. **No indexes have been created on a live database.**

## Models and collections

| Model | Collection | Notes |
| --- | --- | --- |
| `HotelUser` | `hotel_users` | `MANAGER` / `RECEPTIONIST`, unique string `username`, scrypt `pinHash` (not selected by default), optional transitional `passwordHash`, active flag |
| `HotelSession` | `hotel_sessions` | Opaque session row, only HMAC token hash and CSRF hash stored, absolute + idle expiry, revocation |
| `HotelAuditLog` | `hotel_audit_logs` | Append-only audit foundation; raw IP, user agent, cookies, credentials, PINs, and tokens are not stored |
| `RoomType` | `roomtypes` (Mongoose default) | Dedicated Hotel connection only; unique `code` index defined; never hard-deleted |
| `Room` | `hotel_rooms` | Dedicated Hotel connection only; unique `roomNumber` index defined; embedded status history; never hard-deleted |
| `Stay` | `hotel_stays` | Dedicated Hotel connection only; one Stay per reservation; immutable commercial snapshots; embedded status history; never hard-deleted |

Indexes are **defined only** in the schemas. They are not applied automatically.
`Room.roomNumber`, `RoomType.code`, `Reservation.reservationNumber`, and
`Stay.reservationId` have application-level duplicate checks that return
`409 CONFLICT`, but the durable uniqueness guarantee requires an approved index
deployment. Do not treat those checks as a substitute for the unique indexes
under concurrent writes.

## Authentication and session design

- Reception credentials are a username plus exactly four ASCII digits. PINs use
  Node `scrypt` (`N=32768`, `r=8`, `p=1`) with a random 16-byte salt and
  constant-time comparison. Stored format is `scrypt$N$r$p$<salt>$<hash>`. Only
  the derived hash is stored; the PIN is never persisted, returned, or logged.
- A legacy email + `passwordHash` login remains available only as a transitional
  path for accounts provisioned before PIN login. The Reception UI does not use
  it. `passwordHash` is optional in the schema and is retained unchanged by PIN
  rotation until separately retired.
- There is no default user, default PIN, default password, or bootstrap bypass.
- Login normalizes the username (trim + lowercase), verifies the PIN, checks the
  live active flag, and creates an opaque 256-bit session token.
- Usernames are 3-32 characters, start with a letter or digit, and contain only
  lowercase letters, digits, dot, underscore, or hyphen after normalization.
  A partial unique index enforces uniqueness only for real string usernames, so
  legacy rows without one do not collide.
- MongoDB stores only `HMAC-SHA256(HOTEL_SESSION_SECRET, token)`; the raw token
  exists only in the browser cookie set by the login response.
- Cookie flags: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`.
  The `__Host-` prefix requires HTTPS; localhost is treated as a secure context
  by modern browsers. Plain-HTTP LAN origins are unsupported.
- Absolute expiry is 8 hours. Idle expiry is 30 minutes and slides, but never
  beyond the absolute expiry.
- Every request reloads the live `HotelUser`. `roleSnapshot` is audit metadata
  only. A disabled account or changed role revokes the session and requires a
  new login.
- Login failures use one generic response (`Invalid username or PIN`) to reduce
  account enumeration, and the missing-user or no-PIN path performs a dummy PIN
  verification to reduce timing differences. Wrong PIN, unknown username, and
  inactive account are indistinguishable.
- Changing a user's username/PIN revokes every live session for that user.

### Authentication routes

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/hotel/auth/login` | `POST` | Validates Origin, rate limit, JSON body, and Hotel configuration; returns a safe user projection plus a one-time CSRF token and sets the session cookie |
| `/api/hotel/auth/logout` | `POST` | Validates Origin and rate limit; requires the CSRF header for a live session; revokes the session and clears the cookie |
| `/api/hotel/auth/me` | `GET` | Reloads the live user from the existing session and returns a safe user projection plus a fresh session-bound CSRF token; does not mutate business data |

All three routes are `runtime = "nodejs"`, `dynamic = "force-dynamic"`, and use
the Hotel `withHotelApi` wrapper. No POS route, middleware, auth, cookie, or
database helper is imported. `proxy.js` matches `/api/:path*` and adds generic API
`no-store` / `nosniff` headers plus same-host `OPTIONS` handling, but it performs
no Hotel authentication or authorization. Every Hotel route enforces its own
Origin, session, CSRF, and permission checks.

Login request requirements:

- `Content-Type: application/json`
- A valid `Origin` header. It must exactly match the request origin or an entry
  in `HOTEL_ALLOWED_ORIGINS`. A missing Origin is rejected.
- Body: `{ "username": "...", "pin": "1234" }`
- `pin` must be a JSON string of exactly four ASCII digits. A malformed body
  returns `422 VALIDATION_ERROR` with field-scoped messages and no password or
  PIN echo.
- The transitional legacy body `{ "email": "...", "password": "..." }` still
  works for existing accounts but is not used by the Reception UI.
- Maximum body size: 8 KiB.

A successful login response has this shape:

```json
{
  "success": true,
  "data": {
    "user": { "id": "...", "email": "...", "username": "manager", "name": "...", "role": "MANAGER" },
    "role": "MANAGER",
    "csrfToken": "<one-time session-bound token>",
    "session": { "expiresAt": "...", "idleExpiresAt": "..." }
  },
  "error": null
}
```

The session token is only in the `__Host-bono_hotel_session` cookie and is never
returned in JSON. The CSRF token is only in the JSON body and is never set as a
cookie or written to `localStorage`. The client must retain it in memory and send
it as `x-hotel-csrf-token` on logout and every future state-changing Hotel
request.

After a page reload, the client calls `GET /api/hotel/auth/me` with the existing
cookie. The endpoint authenticates the session, reloads the live user and role,
and returns the same safe user projection plus a fresh CSRF token. Rotation
replaces the session's `csrfHash`, so the previous token stops working; the raw
token is returned only in the JSON response. A disabled account, changed role,
revoked session, or expired session returns `401` and cannot obtain a token.

The bootstrap GET is read-only and accepts no body. A same-origin browser GET may
omit `Origin`, so it is not mandatory; when `Origin` is present it must pass the
same exact-origin/allowlist check as a mutation, and `Sec-Fetch-Site: cross-site`
is rejected. `SameSite=Strict`, the absence of CORS grants, and `no-store`
responses remain the primary boundaries. Existing mutation routes keep their
mandatory Origin and CSRF checks unchanged. Logout with the bootstrapped token
works after a reload.

Logout is idempotent: a missing or invalid session cookie still returns success
and clears the cookie. A live session without the correct CSRF header returns
`403 CSRF_VALIDATION_FAILED` and is not revoked. Logout accepts no request body.

### Request hardening

- Exact Origin validation runs before any credential or database work for login,
  logout, and any bootstrap request that supplies `Origin`. The read-only
  bootstrap GET may omit `Origin`, but still rejects
  `Sec-Fetch-Site: cross-site`; `SameSite=Strict` and the absence of CORS grants
  are the boundary in that case.
- Login is limited to 10 attempts per 15 minutes per client and, independently,
  10 attempts per 15 minutes per submitted username; logout to 60 per 15
  minutes. Successful login resets that client's and that username's login
  buckets. Responses use `429` with `Retry-After`.
- The per-username bucket is consumed for unknown usernames too, so it does not
  become an account-enumeration oracle.
- The limiter is in-memory and per process. It is not a global multi-instance
  quota; use a shared store before horizontal scaling. Bucket keys hash the
  scope and client/username identifier rather than storing raw IPs or usernames.
- The limiter trusts proxy headers (`x-nf-client-connection-ip`, `x-real-ip`,
  `x-forwarded-for`). The deployment proxy must overwrite them; this is
  defense-in-depth, not a network boundary.
- JSON bodies are size-bounded and must be plain objects. Malformed JSON returns
  `400`, wrong media type `415`, oversized bodies `413`.
- CSRF uses a random 256-bit token, HMAC-hashed with
  `HOTEL_SESSION_SECRET` before storage. Only `csrfHash` is stored on the session
  row, and it is excluded from normal queries.
- Public errors use stable Hotel error codes and generic messages. No stack
  traces, driver errors, URIs, credentials, tokens, PINs, or credential hashes
  are returned or logged.

### Roles and permissions

| Permission | MANAGER | RECEPTIONIST |
| --- | --- | --- |
| `hotel.dashboard.read` | yes | yes |
| `hotel.roomTypes.read` | yes | yes |
| `hotel.roomTypes.manage` | yes | no |
| `hotel.rooms.read` | yes | yes |
| `hotel.rooms.manage` | yes | no |
| `hotel.reservations.read` | yes | yes |
| `hotel.reservations.manage` | yes | yes |
| `hotel.guests.read` | yes | yes |
| `hotel.guests.manage` | yes | yes |
| `hotel.billing.read` | yes | yes |
| `hotel.billing.manage` | yes | yes |
| `hotel.reports.read` | yes | no |
| `hotel.staff.manage` | yes | no |
| `hotel.audit.read` | yes | no |
| `hotel.settings.manage` | yes | no |

Authenticated Route Handlers use the Hotel guard, never POS `requireAuth`.
Reads require a live Hotel session and the relevant read permission. Mutations
additionally require an exact Origin and the session-bound CSRF header:

```js
const auth = await authorizeHotelRequest(request, {
  permission: HOTEL_PERMISSIONS.ROOM_TYPES_MANAGE,
  mutation: true,
  connect,
});
if (!auth.ok) return auth.response;

const body = await readHotelJsonBody(request);
const input = validateRoomTypePayload(body);
```

`authorizeHotelRequest` calls `authenticateHotelRequest` with
`requireCsrf: mutation` and the `x-hotel-csrf-token` header. A missing session
returns `401`; a failed Origin or CSRF check returns `403`; a role without the
permission returns `403 FORBIDDEN`. Denied permission and CSRF attempts are
audited as `AUTH_ACCESS_DENIED`.

## Room Types and Rooms API (PHASE 3)

| Route | Methods | Permission |
| --- | --- | --- |
| `/api/hotel/room-types` | `GET`, `POST` | `hotel.roomTypes.read` / `hotel.roomTypes.manage` |
| `/api/hotel/room-types/[id]` | `GET`, `PATCH` | `hotel.roomTypes.read` / `hotel.roomTypes.manage` |
| `/api/hotel/room-types/[id]/deactivate` | `POST` | `hotel.roomTypes.manage` |
| `/api/hotel/rooms` | `GET`, `POST` | `hotel.rooms.read` / `hotel.rooms.manage` |
| `/api/hotel/rooms/[id]` | `GET`, `PATCH` | `hotel.rooms.read` / `hotel.rooms.manage` |
| `/api/hotel/rooms/[id]/deactivate` | `POST` | `hotel.rooms.manage` |
| `/api/hotel/rooms/[id]/status` | `POST` | `hotel.rooms.manage` |

All routes are `runtime = "nodejs"` and `dynamic = "force-dynamic"`. There are
no `DELETE` handlers. Collections return
`{ items, total, limit, offset }`; detail and mutation responses return
`{ roomType }` or `{ room }`.

Room Type fields: `name`, unique uppercase `code`, `description`, `capacity`,
`baseNightlyRate`, `amenities`, `isActive`.

Room fields: unique uppercase `roomNumber`, `floor`, `roomTypeId`, `capacity`,
`amenities`, nullable `nightlyRateOverride`, `isActive`, `operationalStatus`, and
embedded `statusHistory`. `effectiveNightlyRate` is the override when set,
otherwise the referenced room type's `baseNightlyRate`.

List query filters:

- Room types: `isActive`, `limit`, `offset`.
- Rooms: `isActive`, `operationalStatus`, `floor`, `roomTypeId`, `limit`,
  `offset`.
- `limit` is 1-100 (default 50); `offset` is 0 or greater. Invalid filters
  return `422 VALIDATION_ERROR` before a model query runs.

### Duplicate prevention

`RoomType.code` and `Room.roomNumber` are normalized to uppercase and checked
before writes. A duplicate returns `409 CONFLICT` with the field named in
`details`. Duplicate-key errors from MongoDB are mapped to the same response.
Unique indexes are defined in both schemas but **have not been deployed**; see
the index caveat above.

### Room operational status policy

- Initial status is `AVAILABLE` unless creation explicitly supplies one.
- Manual changes are limited to `AVAILABLE`, `CLEANING`, `MAINTENANCE`, and
  `OUT_OF_SERVICE`.
- `OCCUPIED` is owned by check-in/check-out. `RESERVED` remains a valid
  pre-arrival room status that check-in accepts. Both are rejected on manual
  create, update, and status endpoints.
- `POST /rooms/[id]/status` appends `{ status, previousStatus, changedAt,
  changedBy, note }` to `statusHistory` and writes a `ROOM_STATUS_CHANGED` audit.
- Repeating the current status, changing an inactive room, or changing a room
  currently `OCCUPIED`/`RESERVED` returns `409 CONFLICT`.
- Generic `PATCH` cannot change `operationalStatus`; use the status endpoint.

### Safe deactivation

- Room deactivation is refused with `409 CONFLICT` while the room is `OCCUPIED`
  or `RESERVED`. Rooms are never hard-deleted, so historical references remain
  valid.
- Room Type deactivation is refused while any active room references it.
  Deactivating the type after its rooms are inactive preserves the ObjectId
  referenced by historical rooms.
- Generic `PATCH` rejects `isActive: false`; the dedicated deactivate endpoint
  must be used. `PATCH` may set `isActive: true` to reactivate, provided the
  referenced room type is active.
- Creating a room or moving it to another room type requires an active room
  type. Reactivating a room whose type is inactive is refused.
- Deactivation endpoints are idempotent: an already-inactive record returns
  `changed: false` without a second audit write.

### CRUD audit actions

`ROOM_TYPE_CREATED`, `ROOM_TYPE_UPDATED`, `ROOM_TYPE_DEACTIVATED`, `ROOM_CREATED`,
`ROOM_UPDATED`, `ROOM_DEACTIVATED`, and `ROOM_STATUS_CHANGED` are written through
`safeRecordHotelAudit`. Audit writes are best effort and never block the primary
operation.

## Guests and Reservations API (PHASE 4A)

| Route | Methods | Permission |
| --- | --- | --- |
| `/api/hotel/guests` | `GET`, `POST` | `hotel.guests.read` / `hotel.guests.manage` |
| `/api/hotel/guests/[id]` | `GET`, `PATCH` | `hotel.guests.read` / `hotel.guests.manage` |
| `/api/hotel/guests/[id]/deactivate` | `POST` | `hotel.guests.manage` |
| `/api/hotel/reservations` | `GET`, `POST` | `hotel.reservations.read` / `hotel.reservations.manage` |
| `/api/hotel/reservations/[id]` | `GET`, `PATCH` | `hotel.reservations.read` / `hotel.reservations.manage` |
| `/api/hotel/reservations/[id]/cancel` | `POST` | `hotel.reservations.manage` |
| `/api/hotel/reservations/[id]/room` | `POST` | `hotel.reservations.manage` |

All routes are `runtime = "nodejs"` and `dynamic = "force-dynamic"`. There are
no `DELETE` handlers. Collections return `{ items, total, limit, offset }`;
detail and mutation responses return `{ guest }` or `{ reservation }`.

### Guest records

Guest fields: `firstName`, `lastName`, required `phone`, optional `email`,
`nationality`, `idType` (`PASSPORT`, `NATIONAL_ID`, `DRIVER_LICENSE`, `OTHER`),
`idNumber`, `address`, `notes`, and `isActive`. Guests are never hard-deleted.
`PATCH` cannot set `isActive: false`; use the deactivate endpoint. Deactivation
is refused with `409 CONFLICT` while the guest has a `CONFIRMED` or `CHECKED_IN`
reservation. Deactivation is idempotent.

Guest list filters: `isActive`, `search` (first name, last name, phone, or
email), `limit`, `offset`.

### Reservation records

Reservation fields include `reservationNumber` (`RES-YYYYMMDD-<6 hex>`),
`guestId`, `roomTypeId`, nullable `roomId`, `arrivalDate`, `departureDate`,
`nights`, `adults`, `children`, `nightlyRate`, `rateSource`, `totalAmount`,
`status`, `notes`, `cancellation`, and `statusHistory`.

At booking time the reservation snapshots:

- Guest name, phone, and email.
- Room type name, code, capacity, and base nightly rate.
- Room number and floor when a room is assigned.
- The agreed nightly rate and whether it came from the room type base rate or a
  room override.
- The computed total for the booked nights.

Later room-type price changes, guest edits, or room renumbering do not rewrite
those snapshots. Date updates keep the original `nightlyRate` and recompute
`totalAmount` from that snapshot rate and the new night count. Generic `PATCH`
cannot change the guest, room type, room, status, nightly rate, or total.

Reservation list filters: `status`, `activeOnly`, `guestId`, `roomTypeId`,
`roomId`, `arrivalFrom`, `arrivalTo`, `limit`, `offset`. `activeOnly=true`
matches `CONFIRMED` and `CHECKED_IN`; an explicit `status` takes precedence.
`arrivalFrom`/`arrivalTo` are local `YYYY-MM-DD` dates and filter on arrival
date. Invalid filters return `422 VALIDATION_ERROR` before a model query runs.

### Hotel-local dates

Hotel business dates use `Africa/Addis_Ababa` (fixed UTC+03:00, no DST). The
database stores canonical UTC instants representing local midnight. API
responses expose both the ISO timestamp and a derived local `YYYY-MM-DD` value.
Formatted Ethiopian calendar strings are display-only and are never stored as
the canonical timestamp. Arrival must be today or later on creation, departure
must be after arrival, and a stay may not exceed 365 nights. A departure may
equal the next reservation's arrival because inventory intervals are half-open:
`[arrivalDate, departureDate)`.

### Overlap and concurrency protection

Every reservation write that can consume room inventory runs inside a per-room
booking mutex:

1. Acquire a lock document in `hotel_room_booking_locks` with
   `_id = String(roomId)`. MongoDB's always-unique `_id` index makes acquisition
   atomic; no custom index deployment is needed for mutual exclusion.
2. Re-read the room and validate that it is active, belongs to the reservation's
   room type, is not `OUT_OF_SERVICE`, and fits the party.
3. Query for an overlapping `CONFIRMED` or `CHECKED_IN` reservation using
   `arrivalDate < requestedDeparture` and `departureDate > requestedArrival`.
4. Write the reservation.
5. Release the lock in a `finally` block.

Moving a reservation between rooms acquires both room locks in sorted room-id
order to avoid deadlocks. Locks expire after 30 seconds so a crashed request
cannot block a room forever; an expired lock is stolen atomically. The TTL index
for stale-lock cleanup is defined but not deployed. A booking operation that
outlives the lock TTL could allow a second contender, so keep the lock window
short and do not perform slow external work while holding it.

The lock is the concurrency mechanism for writers that use this service. The
unique `reservationNumber` index and the compound room/status/date index are the
durable database backstops and must be deployed after approval. Until then,
duplicate reservation numbers are retried in application code, and overlap
protection depends on every writer going through this service and its lock.

### Reservation status transitions

Allowed transitions:

- `CONFIRMED -> CANCELLED`
- `CONFIRMED -> CHECKED_IN`
- `CONFIRMED -> NO_SHOW`
- `CHECKED_IN -> CHECKED_OUT`
- `CANCELLED`, `CHECKED_OUT`, and `NO_SHOW` are terminal.

New reservations start `CONFIRMED`. Generic updates are allowed only while
`CONFIRMED`. Cancellation appends a status-history entry, stores the reason and
actor, and writes a `RESERVATION_CANCELLED` audit. Check-in and check-out use
their dedicated endpoints. No-show, extensions, and room moves during an active
stay remain deferred.

### Room status boundary

Phase 4A never changed `Room.operationalStatus`. Phase 4B owns the operational
transitions: check-in moves an eligible `AVAILABLE` or `RESERVED` room to
`OCCUPIED`, and check-out moves `OCCUPIED` to `CLEANING`, never directly to
`AVAILABLE`. Check-out leaves `OUT_OF_SERVICE` unchanged. Assigning a room to a
reservation still does not set `RESERVED`, and cancellation still does not
release a room status. The manual room-status API still rejects `OCCUPIED` and
`RESERVED`.

### Reception audit actions

`GUEST_CREATED`, `GUEST_UPDATED`, `GUEST_DEACTIVATED`, `RESERVATION_CREATED`,
`RESERVATION_UPDATED`, `RESERVATION_CANCELLED`, and
`RESERVATION_ROOM_ASSIGNED` are written through `safeRecordHotelAudit`. Audit
writes are best effort and never block the primary operation.

## Stays, Check-in, and Check-out API (PHASE 4B)

| Route | Methods | Permission |
| --- | --- | --- |
| `/api/hotel/reservations/[id]/check-in` | `POST` | `hotel.reservations.manage` |
| `/api/hotel/reservations/[id]/stays` | `GET` | `hotel.reservations.read` |
| `/api/hotel/stays` | `GET` | `hotel.reservations.read` |
| `/api/hotel/stays/[id]` | `GET` | `hotel.reservations.read` |
| `/api/hotel/stays/[id]/check-out` | `POST` | `hotel.billing.manage` |
| `/api/hotel/guests/[id]/stays` | `GET` | `hotel.reservations.read` |

All routes are `runtime = "nodejs"` and `dynamic = "force-dynamic"`. There are
no `DELETE` handlers. Mutations require the Hotel session, the exact Origin, and
the session-bound CSRF header. Check-in and check-out bodies accept only an
optional `note`; protected fields such as `roomId`, `status`, `nightlyRate`, and
`totalCharges` are rejected with `422 VALIDATION_ERROR`.

### Stay records and statuses

A Stay is created exactly once per successful check-in and is never hard-deleted.
Statuses are `IN_HOUSE` (the only active status) and `CHECKED_OUT` (terminal).
The only allowed transition is `IN_HOUSE -> CHECKED_OUT`, reachable only through
the check-out endpoint. There is no generic Stay status route.

The Stay snapshots the reservation's guest, room type, room, arrival and
departure dates, nights, party size, nightly rate, rate source, reservation total,
and notes. Later guest edits, room-type price changes, room renumbering, or
reservation edits do not rewrite those snapshots. The Stay also stores
`checkedInAt`/`checkedInBy`, `expectedCheckOutAt`, `checkedOutAt`/`checkedOutBy`,
check-in/check-out notes, billable nights, charges, and the charge rule.

Stay list filters: `status`, `activeOnly`, `reservationId`, `guestId`, `roomId`,
`checkedInFrom`, `checkedInTo`, `limit`, `offset`. `checkedInFrom` and
`checkedInTo` are Hotel-local `YYYY-MM-DD` dates. `activeOnly=true` matches
`IN_HOUSE`; an explicit `status` takes precedence. Detail responses include the
immutable snapshots, status history, and, after check-out, the payment summary
boundary. The reservation-history and guest-history endpoints return the same
collection shape scoped to one reservation or guest.

### Check-in rules and sequence

A reservation can be checked in only when all of the following hold:

- Its status is `CONFIRMED`.
- It has an assigned room.
- The current `Africa/Addis_Ababa` local date is on or after the arrival date and
  before the departure date. Check-in is rejected before arrival and on or after
  departure.
- The room is active, belongs to the reservation's room type, and has enough
  capacity for the party.
- The room is `AVAILABLE` or `RESERVED`. `CLEANING`, `MAINTENANCE`, and
  `OUT_OF_SERVICE` are rejected. `OCCUPIED` is accepted only while completing an
  idempotent retry of the same stay.
- No other active stay occupies the room, and no other `CONFIRMED` or
  `CHECKED_IN` reservation overlaps the stay's half-open date interval.

The write runs inside the per-room booking lock and re-reads the reservation,
room, and any existing stay immediately before committing:

1. Revalidate the reservation status, room assignment, date window, room
   readiness, capacity, active-stay conflict, and overlapping reservations.
2. Transition the reservation `CONFIRMED -> CHECKED_IN` with a conditional
   update; a lost race returns `409 CONFLICT` and the caller must reload.
3. Create the Stay. The unique `reservationId` index is the durable
   one-stay-per-reservation backstop; until that index is deployed, the
   conditional reservation transition and the room lock serialize contenders.
4. Link `reservation.stayId` and the check-in actor/time.
5. Move the room to `OCCUPIED` and append room status history.
6. Release the lock and write `STAY_CHECKED_IN`, `RESERVATION_CHECKED_IN`, and
   `ROOM_STATUS_CHANGED` audits for the steps that actually changed.

A duplicate sequential check-in returns `changed: false` with the existing Stay
and does not write duplicate audits. Concurrent contenders either observe the
completed stay or receive `409 CONFLICT`; at most one Stay is created. A partial
failure is retained, and retrying the endpoint completes only the missing steps.
If the reservation's room changes between lock acquisition and commit, check-in
is rejected and must be retried.

### Check-out rules, charges, and recovery

Only an `IN_HOUSE` Stay can be checked out, and its reservation must be
`CHECKED_IN` (or already `CHECKED_OUT` during recovery). The write runs inside
the per-room booking lock:

1. Conditionally transition the Stay `IN_HOUSE -> CHECKED_OUT`, recording the
   actual checkout timestamp, actor, note, billable nights, room charges, total
   charges, and charge rule.
2. Conditionally transition the reservation `CHECKED_IN -> CHECKED_OUT` with the
   same checkout time and actor.
3. Move an `OCCUPIED` room to `CLEANING` and append status history.
4. Release the lock and audit only the steps that actually changed.

The charge rule is `CALENDAR_NIGHTS_MIN_ONE`: billable nights are the number of
`Africa/Addis_Ababa` civil dates crossed between the actual check-in and
check-out instants, with a minimum of one. Charges use the Stay's immutable
`nightlyRate` snapshot, so an overstay is charged at the same rate. The
reservation's historical `nightlyRate` and `totalAmount` are never altered by
check-out. Extensions are deferred; this rule simply charges actual nights at the
snapshotted rate.

A duplicate sequential check-out returns `changed: false` and preserves the
original checkout time and charges. A retry repairs any missing reservation or
room step. Room repair is deliberately conservative: only `OCCUPIED` is moved to
`CLEANING`. An `AVAILABLE` room (for example, housekeeping already completed),
`MAINTENANCE`, `RESERVED`, or `OUT_OF_SERVICE` room is left unchanged, so a retry
can never re-clean a released room or make any room `AVAILABLE`. Lock contention
returns `409 CONFLICT` without changing the Stay.

### Payment-summary boundary

Check-out exposes a payment summary but does not create or infer payment records.
`lib/hotel/services/stayPayments.js` is now a compatibility facade over the
Phase 4C folio service; it preserves the Phase 4B response shape. When the
`HotelPayment` model or persisted records are unavailable, the summary returns
`available: false`, `totalPaid: null`, `outstandingBalance: null`, and a
`PAYMENTS_NOT_IMPLEMENTED` or `PAYMENT_SUMMARY_UNAVAILABLE` source. A null
balance means unknown, never zero.

### Stay concurrency and index caveats

Check-in and check-out use the same per-room lock as reservation booking. The
lock document's always-unique `_id` index provides mutual exclusion without a
custom index deployment. Locks expire after 30 seconds; a crashed request cannot
block a room forever.

The Stay schema defines a unique `reservationId` index plus indexes for
`guestId/checkedInAt`, `roomId/status`, `status/checkedInAt`, and `checkedInAt`.
These are **defined only** and have not been deployed. Until an approved index
deployment, one-stay-per-reservation under concurrency depends on the
conditional reservation transition and the room lock, and every writer must use
this service. A booking operation that outlives the lock TTL could allow a second
contender, so keep the lock window short and do not perform slow external work
while holding it.

### Stay audit actions

`STAY_CHECKED_IN`, `STAY_CHECKED_OUT`, `RESERVATION_CHECKED_IN`,
`RESERVATION_CHECKED_OUT`, and `ROOM_STATUS_CHANGED` are written through
`safeRecordHotelAudit`. Retries log only the steps they actually repair, and the
first successful check-in or check-out logs all corresponding events. Audit
writes remain best effort and never block the primary operation.

## Payments and Guest Folio API (PHASE 4C)

| Route | Methods | Permission |
| --- | --- | --- |
| `/api/hotel/stays/[id]/payments` | `POST` | `hotel.billing.manage` |
| `/api/hotel/stays/[id]/folio` | `GET` | `hotel.billing.read` |
| `/api/hotel/payments/[id]` | `GET` | `hotel.billing.read` |
| `/api/hotel/payments/[id]/void` | `POST` | `hotel.billing.manage` |

All routes are `runtime = "nodejs"` and `dynamic = "force-dynamic"`. There are no
`DELETE`, `PUT`, or `PATCH` handlers: a payment amount or method can never be
edited, and a payment row is never hard-deleted. Mutations require the Hotel
session, the exact Origin, and the session-bound CSRF header. Both Hotel roles
(`MANAGER` and `RECEPTIONIST`) currently hold `hotel.billing.read` and
`hotel.billing.manage`; authorization is always evaluated against the live
`HotelUser.role`, never a session role snapshot.

### Payment records

`lib/hotel/models/hotelPayment.js` defines `HotelPayment` on the dedicated Hotel
connection, collection `hotel_payments`. Each row carries:

- A server-generated `paymentNumber` (`PAY-YYYYMMDD-XXXXXX`), unique.
- `stayId`, `reservationId`, and `guestId`, copied from the Stay.
- `amountMinor`, the canonical integer minor-unit amount, and `currency`
  (Hotel-configured `ETB`).
- `method`: `CASH`, `CARD`, or `BANK_TRANSFER`; `status`: `RECORDED` or
  `VOIDED`.
- A per-stay `idempotencyKey`, an internal SHA-256 `requestHash`, the recording
  actor, `recordedAt`, and void metadata (`voidedAt`, `voidedBy`, `voidReason`).

The model stores no card PAN, CVV, bank credential, provider token, or other
payment secret. The API accepts only `amount`, `method`, and `idempotencyKey`;
unknown fields, including card/bank fields and server-owned totals, identifiers,
currency, status, and actor, are rejected with `422 VALIDATION_ERROR`.

### Money representation

Existing Stay and Reservation money fields remain decimal major units (ETB).
Phase 4C payments and all folio arithmetic use integer minor units (santim,
1/100 ETB). `lib/hotel/money.js` parses client amounts exactly and converts the
Stay charge snapshot once. No floating-point accumulation is used, so payments
such as `0.10` and `0.20` total exactly `0.30`. Amounts with more than two
decimal places, exponent notation, separators, zero, negative, or non-finite
values are rejected. A payment amount must be greater than zero.

### Folio source of truth

`lib/hotel/services/folio.js` is the single financial source of truth. A folio
combines only:

- The Stay's immutable, finalized room-charge snapshot (`chargeRule`,
  `billableNights`, `roomCharges`, `totalCharges`); and
- Persisted `HotelPayment` rows.

Client-supplied totals are never trusted. A `null` charge snapshot is reported as
unknown and is never treated as zero. `VOIDED` and `CANCELLED` rows do not count
toward paid totals. Settlement status is one of `UNAVAILABLE`,
`CHARGES_NOT_FINALIZED`, `NO_CHARGE`, `UNPAID`, `PARTIALLY_PAID`, `SETTLED`, or
`OVERPAID`. `settled: true` is possible only when persisted payments equal the
finalized charges exactly. If a payment record is missing, unreadable, or
corrupt, the folio reports `available: false` with null paid/outstanding values
rather than guessing.

### Recording rules

A payment can be recorded only when the Stay is `CHECKED_OUT` and its charge
snapshot is finalized. Payments before check-out are rejected by default; Phase
4C has no deposit or prepayment policy. A missing Stay is a generic `404`; an
invalid identifier is `422`.

Overpayment policy is explicit `REJECT` (`HOTEL_PAYMENT_OVERPAYMENT_POLICY`). A
payment may equal the outstanding balance exactly. A larger payment returns
`409 CONFLICT` with the current outstanding balance and writes no payment row.

### Idempotency and concurrency

Idempotency is scoped to the Stay: the unique index is
`{ stayId, idempotencyKey }`. The same key on a different Stay is allowed.

- Same key and identical normalized details returns the existing payment with
  `created: false`, `replayed: true`, `changed: false`, and an HTTP `200`.
- Same key with a different amount, method, or currency returns
  `409 CONFLICT` on `idempotencyKey` and creates no second row.
- A new payment returns `created: true` and HTTP `201`.

Writers use the existing per-room booking lock, extended with a payment-specific
busy message. The lock serializes payment creation and voiding for one Stay, so
two different keys cannot both pass the overpayment check. The unique
`stayId + idempotencyKey` index is the durable backstop, but it is defined only
and has not been deployed. Until an approved Hotel-only index deployment,
correctness under concurrency depends on every writer using this service and on
the lock window remaining short.

### Voiding

Voiding is a conditional, non-destructive `RECORDED -> VOIDED` transition. The
row is retained, the folio is recalculated from the remaining active payments,
and no amount or method can be edited. The void body accepts only an optional
`reason`; financial fields are rejected. Reasons containing 13–19 consecutive
digits are rejected to avoid storing card or account numbers. A repeated void
returns the unchanged `VOIDED` payment with `changed: false` and writes a
separate replay audit. A payment in any other state cannot be voided.

### Payment audit actions

`PAYMENT_RECORDED`, `PAYMENT_REPLAYED`, `PAYMENT_REJECTED`, `PAYMENT_VOIDED`, and
`PAYMENT_VOID_REPLAYED` are written through `safeRecordHotelAudit`. Rejections
record a reason such as `STAY_NOT_CHECKED_OUT`, `FOLIO_NOT_FINALIZED`,
`OVERPAYMENT`, or `IDEMPOTENCY_KEY_CONFLICT`. Idempotency keys are hashed in
audit metadata; card/bank secrets are never accepted. Audit writes remain best
effort and never block the payment or void.

## First-Manager provisioning

There is no public registration route. The first `MANAGER` is created only by an
explicit operator command, after the Hotel environment is configured:

```bash
node --env-file=.env.local scripts/hotel-provision-manager.mjs \
  --email manager@example.com \
  --username manager \
  --name "Hotel Manager" \
  --confirm
```

The command:

- Refuses to run without `--confirm`.
- Reads the four-digit PIN from `HOTEL_PROVISION_MANAGER_PIN` or prompts twice
  with echo disabled. It never accepts a PIN as a command-line argument.
- Validates email, name, username, and PIN before connecting to MongoDB.
- Acquires a dedicated `_id` lock document in `hotel_provisioning_locks` so two
  processes cannot provision concurrently. MongoDB's always-present unique
  `_id` index is used; no schema index deployment is needed.
- Refuses if **any** Manager exists, active or disabled. Recovery from a lost
  Manager credential uses the rotation command below.
- Creates the Manager with `username`, `pinHash`, `role: "MANAGER"`, and
  `isActive: true`. No plaintext PIN or legacy password is created.
- Writes a `FIRST_MANAGER_PROVISIONED` audit record containing only SHA-256
  hashes of the email and username. If that audit write fails, the new Manager
  is rolled back.
- Never prints or logs the PIN, its hash, or credential material.

Running this command writes to the Hotel database. Do not run it without
explicit approval and a confirmed target database.

## Credential rotation for existing Hotel users

Accounts created before username + PIN login have no `pinHash`. There is **no
automatic migration and no invented PIN**. An operator must rotate each account
explicitly, one at a time, from a trusted terminal:

```bash
node --env-file=.env.local scripts/hotel-rotate-credentials.mjs \
  --email receptionist@example.com \
  --username reception \
  --confirm
```

The rotation command:

- Refuses to run without `--confirm`.
- Reads the new four-digit PIN from `HOTEL_PROVISION_PIN` or prompts twice with
  echo disabled. It never accepts a PIN as a command-line argument.
- Validates email, username, and PIN before connecting to MongoDB.
- Replaces only `username` and `pinHash` on the matching account; the role,
  active flag, name, email, and any legacy password hash are left unchanged.
- Relies on the partial unique username index to reject a username already
  assigned to another account, returning `409 CONFLICT`.
- Revokes every live Hotel session for that user, so a session opened with the
  old credential cannot continue.
- Writes a `HOTEL_USER_CREDENTIALS_ROTATED` audit record containing only SHA-256
  hashes and the revoked-session count. It never prints or logs the PIN or hash.
- Returns `404 NOT_FOUND` for an unknown email.

An account without a `pinHash` cannot use PIN login; its users see the same
generic `Invalid PIN` failure and must be rotated before signing in.
Do not run either command without explicit approval and a confirmed target
database.

## Legacy Hotel staff management API - retired (Phase 1 cleanup)

The standalone `/hotel/users` page, the `/api/hotel/users` route family, the
hotel staff management handlers/service (`lib/hotel/http/staffHandlers.js`,
`lib/hotel/services/staff.js`), the staff-management UI components, and the
`hotel.staff.manage` permission were removed in the Phase 1 legacy cleanup.
Username-based login, username credential rotation, and the username rate-limit
path were removed at the same time. The PIN-based credential provisioning CLIs
remain available but now accept only `--email`, `--name`, and a PIN.

The role-scoped PIN login (`/api/hotel/auth/pin-login`) is now the sole
interactive Hotel authentication path used by Reception, Room Management, and
Room Reports. The legacy email/password path in `loginHotelUser` is retained
only for pre-PIN accounts and has no UI consumer.

Identity records (`hotel_users`) and all historical attribution fields
(`actorUserId`, `createdBy`, `checkedInBy`, and similar) are preserved. The
`username` field and its partial unique index remain in the schema as dormant
legacy data; removing them is a separately approved database migration and is
explicitly out of scope for this phase. No database records, indexes, or
collections were created, modified, or deleted.

## Hotel index deployment

Hotel indexes are defined in the schemas but are not applied automatically.
Deployment is a separate, explicit operation:

```bash
node --env-file=.env.local scripts/hotel-deploy-indexes.mjs --confirm
```

The command:

- Refuses to run without `--confirm` or `ROOM_MONGODB_URI`.
- Uses only the dedicated Hotel connection and Hotel model factories.
- Requires the connected database name to be exactly `bono_hotel`.
- Classifies the target from `HOTEL_INDEX_DEPLOY_ENV`. Only `development`,
  `dev`, `local`, `test`, and `disposable` are treated as non-production.
  Production markers (`HOTEL_INDEX_DEPLOY_ENV`, `NODE_ENV`, `VERCEL_ENV`,
  `CONTEXT`, `DEPLOY_ENV`, `ENVIRONMENT`, `APP_ENV`) set to `production`, `prod`,
  or `live`, and any unset or unrecognized `HOTEL_INDEX_DEPLOY_ENV`, require
  `--allow-production` plus a non-empty `HOTEL_INDEX_DEPLOY_APPROVAL`
  change/ticket reference. The approval value is never printed. Set
  `HOTEL_INDEX_DEPLOY_ENV=production` explicitly for production and
  `HOTEL_INDEX_DEPLOY_ENV=disposable` for a disposable test instance; do not
  rely on an unset `NODE_ENV`.
- Prints collection names and index keys/options, never the URI or credentials.
- Uses `createIndexes()` only. It never calls `syncIndexes()`, `dropIndex()`, or
  `dropIndexes()`.
- Preflights existing indexes and refuses to write if it finds an unexpected,
  key-mismatched, name-mismatched, duplicate-key, or option-mismatched index.
- Creates only missing schema indexes, then re-verifies every expected index.
- Exits nonzero on a mismatch, an unexpected index, or an expected index that is
  still missing after creation. It never removes an index; unexpected indexes
  require manual review.

The expected set is 37 schema indexes across 10 collections: `hotel_users`,
`hotel_sessions`, `hotel_audit_logs`, `roomtypes`, `hotel_rooms`,
`hotel_guests`, `hotel_reservations`, `hotel_stays`, `hotel_payments`, and
`hotel_room_booking_locks`. MongoDB's automatic `_id_` index is not counted.

## Disposable MongoDB integration tests

Phase 3 adds an explicit opt-in real-database harness:

- `tests/hotel-integration.test.mjs` — guarded lifecycle and integration
  scenarios.
- `tests/helpers/hotel-integration-harness.mjs` — DB-free opt-in inspection,
  runtime mapping, run-scoped fixtures, redaction, read-only index polling,
  cleanup argument validation, and ownership-marker reading.
- `tests/hotel-integration-cleanup.mjs` — the separate, explicit cleanup
  command.
- `tests/hotel-integration-harness.test.mjs` — DB-free tests for the harness.

The real integration command is **NOT RUN**. No live MongoDB was contacted
while this phase was implemented. The DB-free harness tests and the existing
guard tests are safe to run; the real command remains blocked until an approved
fresh disposable target exists.

A real run requires all of these exact values:

```text
HOTEL_INTEGRATION_TESTS=1
HOTEL_INDEX_DEPLOY_ENV=disposable
HOTEL_TEST_TARGET_ACK=I_CONFIRM_DISPOSABLE_MONGODB
HOTEL_TEST_MONGODB_URI=mongodb://127.0.0.1:<non-27017-port>/bono_hotel
```

The target must be a fresh, standalone, throwaway MongoDB instance or container
published on a literal loopback address. The guard rejects `localhost`, DNS
hosts, `mongodb+srv://`, multiple hosts, replica sets, mongos/sharded clusters,
load-balanced targets, port 27017, any database other than `bono_hotel`,
unsupported query parameters, inherited production/POS variables, and any
existing non-system collection. The live connection must report `bono_hotel`,
the approved host and port, and a writable standalone `hello` response. When
`hello.isWritablePrimary` is present, it must be exactly `true`; a legacy
`hello.ismaster: true` is accepted only when `isWritablePrimary` is absent and
the reported `maxWireVersion` is 8 or 9 (MongoDB 4.2/4.4).

If no test-only flag is present, the integration file reports an opt-in skip and
opens no connection. If any flag is present but the complete set is invalid, the
run fails before connecting. The harness validates the guard configuration
first, maps the approved test URI to `ROOM_MONGODB_URI` only inside that test
process, generates a test-only `HOTEL_SESSION_SECRET` in memory, imports the
Hotel connection once, and never reconnects to another target in that process.
It never reads `MONGODB_URI`, `MONGO_URI`, POS configuration, or
`ROOM_MONGODB_URI` as a fallback.

Before any test write, the guard claims the target with one fixed ownership
marker in `hotel_integration_run_ownership`. The marker contains a random run
ID, a token hash, the exact target, the process ID, and a timestamp. A second
process cannot claim the same target. Test fixture names are scoped to the run;
the harness does not reuse data from another run.

### Setup guide

Use a separate disposable instance or container. Do not use a database name on
a shared cluster, and do not point this at the POS database. A container with no
persistent volume is the simplest option:

```bash
docker run --rm --name bono-hotel-it \
  -p 127.0.0.1:27018:27017 \
  mongo:7
```

The published address is literal loopback and the host port is deliberately not
27017. The guard cannot prove that the port is not forwarded to a remote host or
that the container has no shared volume. Destroy the container after the run. If
a volume is used, destroy that volume separately; the cleanup command does not
remove database files or volumes.

Preflight freshness before claiming the target. This must print an empty list:

```bash
mongosh "mongodb://127.0.0.1:27018/bono_hotel" --quiet \
  --eval 'db.getCollectionNames().filter(n => !n.startsWith("system."))'
```

Set the test-only values in the harness terminal. Do not set `ROOM_MONGODB_URI`,
`MONGODB_URI`, `MONGO_URI`, `AUTH_SECRET`, `HOTEL_SESSION_SECRET`, or
`HOTEL_PROVISION_MANAGER_PASSWORD`, `HOTEL_PROVISION_MANAGER_PIN`, or
`HOTEL_PROVISION_PIN` in this terminal; the guard refuses inherited values and
the harness supplies its own in-process mappings.

```bash
export HOTEL_INTEGRATION_TESTS=1
export HOTEL_INDEX_DEPLOY_ENV=disposable
export HOTEL_TEST_TARGET_ACK=I_CONFIRM_DISPOSABLE_MONGODB
export HOTEL_TEST_MONGODB_URI=mongodb://127.0.0.1:27018/bono_hotel

# Optional: wait read-only for a separately approved index deployment.
# export HOTEL_INTEGRATION_WAIT_FOR_INDEXES=1

node --test tests/hotel-integration.test.mjs
```

PowerShell equivalent:

```powershell
$env:HOTEL_INTEGRATION_TESTS = "1"
$env:HOTEL_INDEX_DEPLOY_ENV = "disposable"
$env:HOTEL_TEST_TARGET_ACK = "I_CONFIRM_DISPOSABLE_MONGODB"
$env:HOTEL_TEST_MONGODB_URI = "mongodb://127.0.0.1:27018/bono_hotel"
# $env:HOTEL_INTEGRATION_WAIT_FOR_INDEXES = "1"
node --test tests/hotel-integration.test.mjs
```

The harness covers: index readiness (read-only, optional wait), reservation
concurrency and half-open `[arrivalDate, departureDate)` intervals, stale
per-room booking-lock recovery, check-in/check-out replay and partial-write
recovery, payment idempotency and concurrent overpayment rejection, void and
folio recalculation, cold-start payment-model compilation, opaque sessions,
session-bound CSRF, logout revocation, live-role change revocation, and
ownership retention.

### Optional index-readiness wait

The guard requires a fresh target before it claims ownership. Index deployment
creates the ten Hotel collections, so it cannot run before the claim without
making the target fail the freshness check.

With `HOTEL_INTEGRATION_WAIT_FOR_INDEXES=1`, the integration file validates the
complete opt-in environment, connects only to the approved target, verifies the
live target, and claims the ownership marker. It then polls existing indexes
read-only for up to 120 seconds **before creating the manager/receptionist users
or any other test fixture**. It never creates, repairs, removes, deploys, or
syncs an index. If readiness times out or fails, the run aborts without
automatic cleanup: the ownership marker and any existing data remain for
inspection and for the separate cleanup command.

In a second terminal, after the harness has claimed the target and while the
preflight wait is polling, run the approved deployment against the same
disposable target:

```bash
ROOM_MONGODB_URI=mongodb://127.0.0.1:27018/bono_hotel \
HOTEL_INDEX_DEPLOY_ENV=disposable \
node scripts/hotel-deploy-indexes.mjs --confirm
```

Only do this for the target currently claimed by the integration run. Do not
run the deployment from the harness, and do not use the POS `sync-indexes`
script. Without the wait flag, the harness does not wait for, deploy, require,
create, repair, or sync indexes; it only verifies that the harness itself
created no custom indexes. Service-level concurrency tests still run because the
per-room lock uses MongoDB's automatic `_id_` uniqueness.

### Cleanup guide

Cleanup is never automatic and is not registered in an `after` hook. A failed or
successful integration run leaves the ownership marker and test data in place
for inspection. Cleanup requires both independent confirmation signals:

- the `--confirm` CLI argument; and
- the exact environment value
  `HOTEL_TEST_ALLOW_CLEANUP=I_CONFIRM_DELETE_DISPOSABLE_MONGODB_DATA`.

Run it with the same four integration flags and URI:

```bash
export HOTEL_TEST_ALLOW_CLEANUP=I_CONFIRM_DELETE_DISPOSABLE_MONGODB_DATA
node tests/hotel-integration-cleanup.mjs --confirm
```

The cleanup command reads the retained marker, re-verifies the live target and
marker, and calls the authoritative guard. The guard permits only the ten Hotel
collections, the exact ownership-marker collection, and MongoDB `system.*`
namespaces. It deletes business documents only from the ten Hotel collections,
re-verifies the target, marker, and namespace allowlist, then removes the exact
marker last. It never calls `dropDatabase()`, `dropCollection()`,
`dropIndexes()`, or `syncIndexes()`. If any check fails, cleanup stops and the
marker is retained. An unexpected collection or view stops cleanup before any
document is deleted.

After successful cleanup, destroy the disposable instance:

```bash
docker rm -f bono-hotel-it
```

### Limitations

- Standalone MongoDB only. Atlas/SRV, DNS hosts, replica sets, mongos/sharded
  clusters, load-balanced targets, TLS query options, and non-loopback hosts
  are refused.
- Loopback, a non-default port, a fresh database, and an ownership marker do not
  prove that the port is not forwarded to a remote server, that the container
  has no shared volume, or that no other process can write after the claim.
  Namespace checks are point-in-time. Destroy the instance after each run.
- The standalone target has no multi-document transactions. Concurrency
  coverage relies on the per-room booking lock, conditional updates, and
  idempotency keys.
- The harness tests services, models, sessions, and CSRF with synthetic request
  headers. It does not exercise HTTP Route Handlers, the Hotel UI, rate limiting,
  expiry timing, or POS integration.
- Index deployment is a separate operator action. A wait timeout leaves all data
  and the marker in place for cleanup.
- The real integration command remains **NOT RUN** until an approved fresh
  disposable target exists.

## Audit logging

`recordHotelAudit()` validates the action/outcome, hashes request IP and
user-agent, sanitizes metadata, and drops sensitive keys. `safeRecordHotelAudit()`
is best effort and never breaks the primary operation. Audit writes are not in
a transaction; use a transaction where an audit record is legally required.

## Remaining prerequisites before production

1. Configure `ROOM_MONGODB_URI` with a least-privilege Hotel database user.
2. Configure a separate `HOTEL_SESSION_SECRET` (at least 32 characters).
3. Approve and run the first-Manager provisioning command against the intended
   database. Never store or transmit a plaintext PIN outside that command.
   Rotate every pre-existing Hotel account through the credential-rotation
   command before expecting PIN login to succeed for it.
4. Run integration tests against a separate, throwaway MongoDB instance,
   container, or port — not another database name on a shared cluster — using
   test-only environment values and `HOTEL_INDEX_DEPLOY_ENV=disposable` for any
   index-deployment check. Cover
   login, logout, session bootstrap/reload, CSRF, rate limiting, expiry, disabled
   users, role changes,
   Room/Room Type CRUD, Guest CRUD/deactivation, reservation creation/update/
   cancellation/room assignment, date boundaries, overlapping stays, concurrent
   booking attempts, check-in/check-out, duplicate and concurrent check-in and
   check-out, room conflicts, actual-night charge boundaries, rate snapshots,
   payment recording, partial/exact/overpayment, pre-checkout rejection, folio
   calculations, idempotent replay and conflicts, concurrent payment attempts,
   void/recalculation, payment-summary boundaries, status transitions, duplicate
   constraints, safe deactivation, status history, staff list/create/update/
   activate/deactivate/rotation, duplicate email/username races, self- and
   last-Manager protection under concurrency, target session revocation, and
   audit writes.
5. Approve and run a Hotel-only index deployment, including the partial unique
   `HotelUser.username` index, the unique
   `RoomType.code`, `Room.roomNumber`, `Reservation.reservationNumber`,
   `Stay.reservationId`, and `HotelPayment.paymentNumber` indexes, the compound
   `roomId/status/arrivalDate/departureDate` reservation index, the unique
   `HotelPayment` `stayId/idempotencyKey` index, the Stay
   `guestId/checkedInAt`, `roomId/status`, `status/checkedInAt`, and
   `checkedInAt` indexes, and the `hotel_room_booking_locks.expiresAt` TTL index.
   Use `scripts/hotel-deploy-indexes.mjs` only after the plan is reviewed; do not
   use the POS `scripts/sync-indexes.js`.
6. Replace the in-memory rate limiter with a shared store before running more
   than one application instance.
7. Implement extensions, no-show handling, room moves during an active stay,
   guest requests, taxes, discounts, minibar, and any POS/room-service charge
   integration. `OCCUPIED` and `RESERVED` remain deliberately unreachable from
   the manual room-status API.
8. Add the Hotel UI using Bono/Ethiopian calendar conventions.

Until those steps are complete, do not describe Hotel authentication or CRUD as
production-ready or expose the Hotel API publicly.

## Verification commands

```bash
node --test tests/hotel-foundation.test.mjs
node --test tests/hotel-auth-routes.test.mjs
node --test tests/hotel-rooms.test.mjs
node --test tests/hotel-reception.test.mjs
node --test tests/hotel-stays.test.mjs
node --test tests/hotel-payments.test.mjs
node --test tests/hotel-staff.test.mjs
node --test tests/hotel-index-deploy.test.mjs
node --test tests/hotel-integration-guard.test.mjs
node --test tests/hotel-integration-harness.test.mjs
npm run lint
npm run build
git diff --check
git status --short
```

All ten test suites are DB-free: they open no MongoDB connection, create no
indexes, and do not run provisioning or index deployment against a real
database. The real-database integration command is intentionally not listed
above and has not been run.

## Reports API (summary + CSV/PDF export)

The manager report endpoint aggregates canonical persisted records without
creating any denormalized report store. All three responses are produced by a
single service (`lib/hotel/services/reports.js`), so the on-screen summary, CSV,
and PDF exports always reconcile:

- `GET /api/hotel/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` — JSON
  (`hotelSuccess` envelope), `hotel.reports.read` (manager-only), read-only
  (no Origin/CSRF), exact query allowlist `["from", "to"]`.
- `GET /api/hotel/reports/summary/export?from=...&to=...` — the same
  aggregation rendered as RFC 4180 CSV (`text/csv; charset=utf-8`, UTF-8 BOM,
  `no-store`, `Content-Disposition: attachment`, `nosniff`, RFC 4180
  quote-doubling, and formula-injection guarding on `=`, `+`, `-`, `@`, tab,
  CR). The export groups report metadata, summary metrics, daily detail, live
  inventory, payment methods, and coverage; internal field names, database IDs,
  and raw definitions are not exported.
- `GET /api/hotel/reports/summary/export/pdf?from=...&to=...` — the same
  aggregation rendered as a monochrome A4 portrait PDF with the same manager
  permission, query allowlist, date validation, `no-store`, `nosniff`, and a
  dated attachment filename. The PDF contains the title, selected range,
  Addis-Ababa generation timestamp, introductory notes, summary metrics, daily
  detail, live inventory, payment methods, data coverage, and concise metric
  notes. Table headers repeat across pages, unavailable values render as `N/A`,
  and page numbers/footer text appear on every page.

Contract details:

- Business dates are Africa/Addis_Ababa civil dates; Gregorian `YYYY-MM-DD`
  input is transport only and half-open day windows `[start, next start)` are
  used. Windows are validated (`HotelValidationError` field errors), restricted
  to `from <= to <= today`, and capped at `HOTEL_REPORT_MAX_WINDOW_DAYS`
  (92 days).
- Money is returned in integer minor units (santim). `paymentsRecordedMinor`
  sums RECORDED payments by recorded date; `paymentsVoidedMinor` sums VOIDED
  payments by void date and is never netted into the collected totals;
  `postedRoomChargesMinor` sums exactly-converted finalized checkout charges
  (`CALENDAR_NIGHTS_MIN_ONE`) by checkout date. `outstandingMinor` is null when
  any in-window checkout is unfinalized.
- `availableRoomNights` is reconstructed only from `Room.statusHistory`
  coverage; a day whose denominator cannot be established by history is
  `null`, never zero, and is listed in `denominatorCoverage.uncoveredDates`.
  Historical manual deactivation (`isActive=false` without a status-history
  entry) is not recoverable and is excluded from the historical denominator.
  Occupancy rate, ADR, and RevPAR are null (not 0/Infinity/NaN) whenever their
  denominators are unknown or zero.
- The response includes the `definitions` map (returned verbatim to the UI),
  per-day `days[]` series, `methodBreakdown` (by payment method), a live
  inventory snapshot, and the denominator coverage flag.
- Handler implementation: `lib/hotel/http/reportHandlers.js`; CSV rendering:
  `lib/hotel/services/reportsCsv.js`; PDF rendering:
  `lib/hotel/services/reportsPdf.js` (PDFKit, no table plugin). The aggregation
  uses bounded
  `find().select().lean()` queries plus in-process reduction (one further
  bounded payment lookup for the outstanding balance); no `.aggregate()`
  pipeline and no unbounded scan is used.

Index needs (defined in schemas, deployment still pending — see the index
deployment section above): the report queries lean on the existing
`Stay { checkedInAt: -1 }` / `{ status: 1, checkedInAt: 1 }`-style range
filters plus payment/reservation range filters. A dedicated `Room` index over
the nested `statusHistory.changedAt` subdocuments would further reduce the
in-process history walk for the denominator; it is not declared anywhere today
and is not proposed as a schema change in this phase. No index is deployed or
modified by this feature.
