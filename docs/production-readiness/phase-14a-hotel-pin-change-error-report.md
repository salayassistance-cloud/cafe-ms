# Phase 14A — Hotel PIN Change HTTP 500 Root-Cause Investigation & Minimal Fix

**Date:** 2026-11-21
**Scope:** `C:\hotelms` only. Local development / isolated local Hotel database. No production access.
**Outcome:** Root cause identified and reproduced deterministically; a single focused fix applied; regression tests added and passing.

---

## 1. Root cause (exact code path)

### Failure chain

1. `app/api/hotel/auth/change-pin/route.js:98`
   ```js
   const user = await getHotelUserWithPin(connection, auth.user.id);
   ```
   `lib/hotel/auth/credential.js:63-67` implements this with:
   ```js
   return Hotel.findById(userId).select("+pinHash").lean();
   ```
   With a real Mongoose connection, `.lean()` returns `_id` as a **bson `mongoose.Types.ObjectId`**, not a 24-character string. (The pre-existing DB-free tests seed `_id` as a string, so they never exercised this shape.)

2. `app/api/hotel/auth/change-pin/route.js:109` passes `user._id` to `findHotelPinCollision(...)`. This is safe: the value is used directly inside a Mongoose filter (`_id: { $ne: ... }`), where an ObjectId is valid.

3. `app/api/hotel/auth/change-pin/route.js:117` passes `user._id` to `setHotelUserPin(connection, user._id, newPin)`.

4. **The exact failing operation** — pre-fix `lib/hotel/auth/credential.js:191-194`:
   ```js
   export async function setHotelUserPin(connection, userId, pin) {
     if (!isValidHotelIdentityId(userId) || !isValidHotelPin(pin)) {
       throw new Error("A valid Hotel identity and 4-digit PIN are required");
     }
   ```
   `isValidHotelIdentityId` (`credential.js:28-30`) requires `typeof value === "string"`. A bson ObjectId fails that check, so the helper throws a **plain `Error` before any database write**.

5. `withHotelApi` (`lib/hotel/http/apiResponse.js:92-107`) catches it. `normalizeHotelError` (`lib/hotel/errors.js:103-139`) finds no matching `HotelApiError`, validation error, duplicate-key code, or database-error signature, so it wraps the plain `Error` as `HOTEL_ERROR_CODES.INTERNAL_ERROR`, **status 500**, and logs only the redacted diagnostic:
   ```
   [hotel/api] Error: A valid Hotel identity and 4-digit PIN are required
   ```

**Direct evidence:** the new regression test `tests/hotel-pin-change-objectid-regression.test.mjs`, which uses real `mongoose.Types.ObjectId` values, failed before the fix with `500 !== 200` and payload `{"code":"INTERNAL_ERROR","message":"Internal Server Error"}`; the unit case failed with the exact thrown message above. After the fix, all three cases pass.

### Second affected path (same root cause)

The Manager reset workflow is hit by the identical defect:

- `app/api/hotel/staff/[id]/pin/route.js:72-78` → `snapshotManagedStaff()` (`lib/hotel/auth/staffService.js:95-112`) reads the target with `.select("+pinHash").lean()` → `resetReceptionistPin()` (`staffService.js:184-198`) calls `setHotelUserPin(connection, user._id, pin)` at line 190 → same plain `Error` → 500.

The pre-fix regression test for this route also returned `500 !== 200`. It now passes.

### What was *not* the cause

Origin/CSRF enforcement, rate limiting, role/permission checks, session resolution, scrypt PIN hashing/verification, collision detection, session revocation, and audit writing were all reached and behaved correctly in the DB-free tests. Because the exception occurred at the identity-type guard before `HotelUser.updateOne`, **no PIN was persisted on the failing path** — there is no partial credential state to repair.

---

## 2. Runtime database verification

### Verified (configuration and read-only live checks)

| Item | Result |
| --- | --- |
| `.env.local` `ROOM_MONGODB_URI` | MongoDB **Atlas SRV** URI, database `bono_hotel` (host name inspected only; **never connected**) |
| `.env.development.local` `ROOM_MONGODB_URI` | `mongodb://` to **127.0.0.1:27017**, database `bono_hotel`, no credentials in URI |
| Next.js env precedence | `.env.development.local` loads before `.env.local` in `next dev`; the file was created 2026-11-21 18:03, before the running dev server started at 20:25 — so the local override is in effect |
| Running processes | `next dev` / `next-server` listening on port 3000; `mongod` PID 4812 on 127.0.0.1:27017; a separate `mongod` PID 4580 on 127.0.0.1:27018 |
| Read-only `mongosh` on 127.0.0.1:27017 | Database `bono_hotel` exists with `hotel_users`, `hotel_sessions`, `hotel_audit_logs`; `hotel_users` document count = **3**. No document contents were read |
| Read-only `mongosh` on 127.0.0.1:27018 | Only disposable POS `bono_pos_phase23_*` databases; **no** `bono_hotel` — not used by Hotel |
| Live dev server, public read-only endpoint | `GET /api/hotel/auth/identities` (same-origin) returned **HTTP 200** with **3 identities**, matching the local `bono_hotel.hotel_users` count. Response body contents were not recorded |

**Conclusion:** the running Next.js dev process is using the intended isolated local Hotel database `bono_hotel` on 127.0.0.1:27017. Local Hotel configuration is **not** a defect and was **not** changed.

### Explicitly unverified

- **Live `POST /api/hotel/auth/change-pin` with a real authenticated session and real current PIN was not executed.** Doing so would require handling live credentials/PINs or writing test sessions into the shared local database, which is out of scope for this controlled task. The root cause was instead reproduced deterministically with the real production modules against real bson ObjectIds in DB-free tests.
- The running process's environment block could not be read directly on Windows; runtime DB identity was established from documented Next.js env precedence plus the live public endpoint's identity count matching the local database.

---

## 3. Files changed

| File | Change | Why |
| --- | --- | --- |
| `lib/hotel/auth/credential.js` | In `setHotelUserPin`, normalize `userId` with `String(userId ?? "")` before `isValidHotelIdentityId`, and use the normalized string in the `HotelUser.updateOne` filter. | Smallest fix at the shared choke point. Accepts the real `.lean()` bson `ObjectId` shape while keeping the strict 24-hex identity check, the same scrypt hash, the same reset of failed-attempt/lockout fields, and the same plain-`Error` behavior for genuinely invalid input. Fixes both the self-service and Manager-reset routes with one change. |
| `tests/hotel-pin-change-objectid-regression.test.mjs` | **New.** Three DB-free tests using real bson `ObjectId`s: (1) `setHotelUserPin` accepts a real ObjectId and persists/invalidates the PIN; (2) self-service route returns 200, persists new PIN, invalidates old PIN, revokes session, writes audit; (3) Manager reset of a Receptionist PIN returns 200 and persists. | Focused regression coverage for the actual defect. Existing tests used string IDs and therefore passed while production failed. |

No environment files, route handlers, schemas, models, session/CSRF/rate-limit/audit code, or POS code were modified. No dependencies were added.

---

## 4. Security impact

- **Before the fix:** the defect failed **closed**. It threw before `HotelUser.updateOne`, so no PIN was written, no session was revoked, and no false success was returned. There was no authentication bypass, privilege escalation, role confusion, or credential disclosure; the generic 500 response leaked no details. Impact was **availability / functionality**: neither self-service PIN change nor Manager PIN reset worked against real data.
- **After the fix:** all existing controls are unchanged — session + CSRF + Origin checks, rate limits, role/permission matrix, identity-scoped targeting (a client still cannot select another identity), scrypt hashing with the same parameters, collision policy with self-exclusion, `SECURITY`-reason session revocation, and audit events. The fix only widens the *input type* accepted at one internal helper to the type Mongoose actually returns; the value must still be a valid 24-hex identity.
- The regression test explicitly asserts old-PIN invalidation, new-PIN verification, session revocation, and audit recording, so a future change that weakens these controls will fail.

---

## 5. Tests and results

| Check | Result |
| --- | --- |
| New regression (real ObjectIds) — before fix | **3 fail / 3** (two routes returned 500; unit case threw the exact diagnostic) |
| New regression — after fix | **3 pass / 3** |
| Focused PIN suites (`hotel-pin-change-objectid-regression`, `hotel-pin-change-route`, `hotel-pin-change-behavior`) | **29 pass / 29**, 0 fail |
| Broader safe subset: all `tests/hotel-*.test.mjs` except live-DB/integration files, plus `auth-production-hardening` and `staff-pin-canonical` | **461 pass / 461**, 0 fail |
| `npm run lint` | **0 errors**, 3 pre-existing warnings in unrelated files |
| `npm run build` with `MONGODB_URI`, `CAFEDB_URI`, `ROOM_MONGODB_URI` blanked | **Succeeded** (`.next/BUILD_ID` present); confirms no DB connection needed at build time |

Excluded from the broader sweep because they use or emulate live/local databases: `hotel-payments.test.mjs`, `hotel-integration.test.mjs`, `hotel-integration-harness.test.mjs`.

---

## 6. Remaining risks / blockers

1. **Owner-performed live acceptance is still required.** The pinned manual scenarios PIN-S02…PIN-S08 in `phase-14-release-preparation-report.md` (Manager and Receptionist self-service change, new/old PIN behavior, reauthentication, protected routes, logout) were not executed here because they need real credentials and a browser session. The defect and fix are covered by deterministic DB-free route tests.
2. **Other `.lean()` call sites** were reviewed for the same pattern. `getHotelUserWithPin`, `verifyHotelUserPin`, `recordFailedHotelPinAttempt`, and `resetHotelPinFailures` all receive validated string ids at their call sites; `findHotelPinCollision` uses `exceptUserId` directly in a filter (ObjectId-safe). No further change is justified at this time.
3. The production build wrote standard `.next` output while the dev server uses `.next/dev`; no source or configuration was altered by the build.
4. No configuration change was made or requested. If the owner ever intends the Hotel service to use the Atlas `ROOM_MONGODB_URI` from `.env.local` instead of the local development override, that is a separate, explicit decision — this investigation found the local override to be the intended and working development setup.

---

## 7. Confirmations

- **No production database was connected to or queried.** The Atlas SRV host in `.env.local` was inspected by name only and never contacted.
- **No deployment, migration, index creation, backfill, production write, or destructive operation** was performed.
- **No staging, commit, push, stash, reset, clean, checkout, or revert** was performed.
- **`C:\bonosm` was not accessed or modified.**
- The pre-existing working tree (all modified and untracked files) was preserved. The only additions/changes made by this task are the two files listed in §3.
- Per the STOP condition, work stops here; no further phase, deployment, migration, or infrastructure action will be taken without the owner's explicit approval.
