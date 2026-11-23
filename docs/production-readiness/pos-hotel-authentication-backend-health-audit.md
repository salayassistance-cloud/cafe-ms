# BONO POS + Hotel Authentication Backend Health Audit
## Deep Read-Only Investigation — Preserving Existing Systems

**Target Repository:** `C:\hotelms`  
**Current Branch:** `main`  
**HEAD Commit:** `082623808c3944d1b8298627356303e1fa899d73`  
**Remote Tracking Ref (`origin/main`):** `082623808c3944d1b8298627356303e1fa899d73`  
**Audit Date:** 2026-11-23  
**Execution Mode:** STRICT READ-ONLY AUDIT (Zero source changes, zero DB writes, zero production mutations)  

---

## 1. Executive Summary

A comprehensive, evidence-based health audit of both authentication backends—**BONO POS Authentication** and **Hotel Room Management Authentication**—was executed across the codebase. 

### Overall Health Verdict:
- **BONO POS Authentication:** **NEEDS CORRECTION**  
  *Verdict Summary:* Structurally sound and performant with tab isolation (`AUTH-ARCH-11`), but crippled in production by an unapproved, arbitrary policy restriction (`isRejectedDefaultCredential`) that retroactively blocks login for accounts holding default PIN values (`1111`, `2222`, `3333`, `4444`, `5555`). Additionally exhibits redundant sequential database round-trips during session attachment (`attachTabCredential`), and retains deprecated `SystemAuth` references.
- **Hotel Room Management Authentication:** **NEEDS CORRECTION**  
  *Verdict Summary:* Robust cryptographic design (scrypt KDF with $N=32768$, HMAC-SHA256 session token hashes, deterministic CSRF derivation, and live role re-checks), but suffers from two critical operational deficiencies:
  1. **Absence of Manager PIN Recovery:** There is zero recovery or rotation mechanism in code for a forgotten, locked, or unhashed Manager PIN (`assertReceptionistTarget` blocks Manager reset; `provision-hotel-manager.mjs` refuses to run if any Manager exists; `hotel-rotate-credentials.mjs` was never created).
  2. **Render Client IP Failure:** `lib/hotel/http/clientIp.js` hardcodes Netlify's `x-nf-client-connection-ip`. On Render, this header is absent, causing all users to share a single global rate-limit bucket (`HOTEL_UNTRUSTED_BUCKET = "untrusted"` capped at 30 logins/min) and rendering audit log `ipHash` permanently `null`.

---

## 2. Current Git & Repository Status

- **Working Directory:** `C:\hotelms`
- **Branch:** `main`
- **HEAD SHA:** `082623808c3944d1b8298627356303e1fa899d73`
- **Remote Tracking SHA (`origin/main`):** `082623808c3944d1b8298627356303e1fa899d73`
- **Sync Status:** 0 commits ahead, 0 commits behind. Local branch exactly matches remote `origin/main`.
- **Working Tree State:** Clean (`nothing to commit, working tree clean`).
- **Latest Auth-Related Commit:** `082623808c3944d1b8298627356303e1fa899d73` (`fix(auth,hotel): proxy origin resolution, staff auth hardening, and anti-enumeration`).

---

## 3. Hotel Authentication Architecture

```
Hotel Authentication Flow
=========================
Visitor / Browser
       │
       ▼
[GET /api/hotel/auth/identities] ──► Reads active identities with pinHash from bono_hotel.hotel_users
       │
       ▼
[HotelLoginGate.jsx] ──► Displays identity buttons (filtered by portal: MANAGER vs RECEPTIONIST)
       │
       ▼ (User enters 4 digits on HotelPinKeypad.jsx)
[POST /api/hotel/auth/login] ──► Body: { identityId, pin }
       │
       ├──► assertHotelRequestOrigin (Validates Origin vs Canonical / Allowed / Render URL)
       ├──► checkHotelRateLimit (lib/hotel/auth/rateLimit.js - 5 req/min per IP, 30 untrusted)
       ├──► validateHotelPin (lib/hotel/validation.js - /^\d{4}$/)
       ├──► verifyHotelUserPin (lib/hotel/auth/credential.js)
       │       ├── HotelUser.findById(identityId).select("+pinHash").lean()
       │       └── verifyHotelPin(pin, stored) [scrypt N=32768, r=8, p=1]
       │
       ├──► createHotelSession (lib/hotel/auth/session.js)
       │       ├── Generates raw 256-bit token
       │       ├── Derives deterministic csrfToken via HMAC-SHA256
       │       └── HotelSession.create(doc) in bono_hotel.hotel_sessions
       │
       ├──► resetHotelPinFailures (HotelUser.updateOne -> pinFailedAttempts: 0, pinLockedUntil: null)
       ├──► HotelUser.updateOne -> lastLoginAt: new Date()
       ├──► safeRecordHotelAudit (HotelAuditLog.create)
       └──► Set-Cookie: __Host-bono_hotel_session=<rawToken>; HttpOnly; Secure; SameSite=Strict; Path=/
```

### Architectural Details:
1. **Model & Collection:** `HotelUser` model targeting collection `hotel_users` in database `bono_hotel` (`ROOM_MONGODB_URI`).
2. **Session Model & Collection:** `HotelSession` model targeting `hotel_sessions` in `bono_hotel`. Stores `tokenHash` (HMAC-SHA256) and `csrfHash`.
3. **Session Lifetime:** Absolute timeout: 8 hours (`HOTEL_SESSION_ABSOLUTE_MS`). Idle timeout: 30 minutes (`HOTEL_SESSION_IDLE_MS`) strictly enforced at runtime.
4. **Cookie Specification:** `__Host-bono_hotel_session` (`HttpOnly=true, Secure=true, SameSite=Strict, Path=/`).
5. **CSRF Protection:** State-changing requests (`mutation = true`) require `x-hotel-csrf-token` header, verified against HMAC-derived session token.

---

## 4. Hotel "Invalid PIN" Investigation Findings

### Finding H-01: No Self-Recovery or Operator Reset Tool for Hotel Manager PIN
- **Classification:** **CONFIRMED**
- **Evidence:** 
  1. `lib/hotel/auth/staffService.js:58-60`: `assertReceptionistTarget` explicitly throws 403: `"Only Receptionist accounts can be managed here"`. The Staff Management UI cannot reset a Manager's PIN.
  2. `app/api/hotel/auth/change-pin/route.js:18,98`: Self-service PIN change requires an already authenticated session (`requireAuth`) AND the current PIN. A logged-out Manager who does not know their PIN cannot use this route.
  3. `scripts/provision-hotel-manager.mjs:57-64`: Refuses to run if any Manager already exists (`HotelUser.countDocuments({ role: "MANAGER" }) > 0`).
  4. `scripts/hotel-rotate-credentials.mjs`: Mentioned in prompt and `docs/hotel-foundation.md:9-11`, but **does not exist** anywhere in the repository.
- **Impact:** If the Hotel Manager PIN is forgotten, or if the stored `pinHash` does not match the scrypt format, the Manager is **permanently locked out** with zero code-supported recovery mechanism.

### Finding H-02: Strict Scrypt Hash Parsing Rejects Legacy/Plaintext PINs with Generic Failure
- **Classification:** **CONFIRMED**
- **Evidence:** `lib/hotel/auth/pin.js:38-48` (`parseHotelPinHash`):
  ```javascript
  function parseHotelPinHash(stored) {
    if (typeof stored !== "string") return null;
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return null;
    ...
  }
  ```
  Unlike POS `lib/staffService.js` (which supports automatic plaintext-to-hash upgrade), Hotel PIN verification has **zero backward compatibility**. If a Manager account in `bono_hotel` was manually inserted with plaintext, bcrypt, or POS-style `salt:derived` hash, `verifyHotelPin` returns `false` unconditionally, emitting `"Invalid identity or PIN"`.

### Finding H-03: Consecutive Failure Lockout Blocks Login for 15 Minutes Without Unique Error
- **Classification:** **CONFIRMED**
- **Evidence:** `lib/hotel/auth/credential.js:23-24,100`:
  `HOTEL_PIN_MAX_FAILED_ATTEMPTS = 5; HOTEL_PIN_LOCK_MS = 15 * 60 * 1000;`
  If 5 failed attempts occur, `pinLockedUntil` is set for 15 minutes. During this period, `isHotelIdentityLocked` causes `verifyHotelUserPin` to fail immediately before verifying the PIN, returning the same generic `"Invalid identity or PIN"`. Even if the operator subsequently enters the correct PIN, they remain locked out until the 15-minute window expires.

### Finding H-04: Client IP Extraction Fails on Render, Forcing All Users into Shared 30 Req/Min Bucket
- **Classification:** **CONFIRMED**
- **Evidence:** `lib/hotel/http/clientIp.js:13,18-27`:
  `export const HOTEL_TRUSTED_IP_HEADER = "x-nf-client-connection-ip";`
  This header is unique to Netlify. On Render, it is undefined.
  In `lib/hotel/auth/rateLimit.js:58-59`:
  ```javascript
  const bucketKey = `${key}:${ip || HOTEL_UNTRUSTED_BUCKET}`;
  const effectiveLimit = ip ? limit : untrustedLimit;
  ```
  Every incoming request on Render has `ip === null`. Consequently, all client requests share the single bucket `hotel_auth_login:untrusted`. If more than 30 attempts occur across the entire deployment in 60 seconds, all users receive HTTP 429 `"Too many attempts. Retry after Xs"`.

---

## 5. POS Authentication Architecture

```
POS Authentication Flow
======================
POS Terminals (Waiter / Kitchen / Barista / Hot Drink / Cashier / Manager)
       │
       ├──► WAITER Route: Form in PinGuard.js (Username + PIN)
       │       └── POST /api/auth/login-staff
       │             ├── validateLoginStaffPayload
       │             ├── verifyStaffPin (lib/staffService.js)
       │             │     ├── findStaff (by username or name)
       │             │     ├── verifyPin (scrypt) + plaintext upgrade
       │             │     ├── isRejectedDefaultCredential(pin) [PRODUCTION LOCKOUT]
       │             │     └── staff.isActive check
       │             ├── createSession (lib/sessionStore.js) -> Session.create
       │             ├── attachTabCredential -> Session.findOne + Session.updateOne
       │             └── Set-Cookie: __Host-bono_session=<sessionId>
       │
       └──► STATION / MANAGER / CASHIER Route: PinKeypad in PinGuard.js (Role + PIN)
               └── POST /api/auth/verify-pin
                     ├── validateRole, validatePin
                     ├── Staff.find({ role, isActive: { $ne: false } }).lean()
                     ├── Sequential loop verifying candidates via scrypt
                     ├── isRejectedDefaultCredential(pin) [PRODUCTION LOCKOUT]
                     ├── createSession (lib/sessionStore.js) -> Session.create
                     ├── attachTabCredential -> Session.findOne + Session.updateOne
                     └── Set-Cookie: __Host-bono_session=<sessionId>
```

---

## 6. POS Default-PIN Restriction Analysis (Owner Policy Review)

### 6.1 Exact Implementation Locations
- **Central Policy Engine:** `lib/config/security.js:30-54`:
  ```javascript
  export const KNOWN_DEFAULT_PINS = Object.freeze({
    WAITER: "1111",
    KITCHEN: "2222",
    BARISTA: "3333",
    HOT_DRINK: "5555",
    MANAGER: "4444",
  });
  export function isRejectedDefaultCredential(pin, env = process.env) {
    return isProductionRuntime(env) && isKnownDefaultPin(pin);
  }
  ```
- **Enforcement in Login Paths:**
  1. `app/api/auth/verify-pin/route.js:128`: `if (ok && isRejectedDefaultCredential(pin)) ok = false;`
  2. `lib/staffService.js:87`: `if (isRejectedDefaultCredential(pin)) return { ok: false, error: "Invalid Name or PIN" };`
- **Enforcement in Step-Up Re-Authentication:**
  1. `lib/staffService.js:115` (`verifyStaffPinById`): `if (isRejectedDefaultCredential(pin)) return { ok: false, error: "Invalid PIN" };`
- **Enforcement in Creation & Modification Paths:**
  1. `app/api/manager/staff/route.js:243`: Returns 400 `"Choose a PIN that is not a known default"`
  2. `lib/staffService.js:141`: Returns 400 `"Choose a PIN that is not a known default"`
  3. `app/api/manager/waiters/route.js:112`: Returns 400 `"Choose a PIN that is not a known default"`
  4. `scripts/pos-provision-manager.mjs:110`: Throws error refusing known default PIN.

### 6.2 Roles Affected
**ALL SIX POS ROLES:** `WAITER`, `CASHIER`, `KITCHEN`, `BARISTA`, `HOT_DRINK`, `MANAGER`.

### 6.3 Operational vs Security Distinction

| Evaluation Criterion | Implementation Behavior | Operational Reality / Owner Intent |
| :--- | :--- | :--- |
| **Login Enforcement** | Hard rejection of matching stored hashes if PIN is in banned list. | **Critical defect:** Retroactively locks out existing staff whose accounts hold these values. |
| **Creation/Reset Enforcement** | Blocks writing any of the 5 banned PINs. | Restricts owner flexibility to choose simple numbers if desired by staff. |
| **Environment Divergence** | Allowed in dev/test; rejected in production. | Causes severe parity bugs (system works locally, breaks immediately on deploy). |
| **True Security Value** | **Negligible.** Banning only 5 numbers does not prevent weak PINs (`0000`, `1234`, `9999` are allowed). | Rate limiting and salt hashing provide the actual defense. |

### 6.4 Recommended Owner Policy
1. **Remove Login-Gate Banning:** The authentication handlers (`verifyStaffPin`, `verify-pin`) must NEVER reject a credential that matches the cryptographic hash stored in the database.
2. **Shift to Advisory Warnings:** If the owner desires protection against accidental use of factory defaults, the Manager UI should show an advisory warning badge (`"Common PIN"`) rather than having the backend refuse to write or authenticate.
3. **Preserve Operational Freedom:** Allow staff and managers to set any 4-digit PIN they choose.

---

## 7. Duplicate & Unused Code Investigation

### Finding D-01: Dual Competing POS Login Endpoints
- **Classification:** **CONFIRMED**
- **Files:** `app/api/auth/login-staff/route.js` and `app/api/auth/verify-pin/route.js`
- **Analysis:**
  - `login-staff` accepts `{ name, pin, role }` and verifies a specific staff member.
  - `verify-pin` accepts `{ role, pin }`, queries all staff in the role, and iterates through them running scrypt sequentially.
  - `login-staff` is restricted to WAITER in the UI, while `verify-pin` is used for all other roles.
  - Both endpoints duplicate cookie issuance (`NEW_SESSION_COOKIE`), session creation (`createSession`), tab attachment (`attachTabCredential`), and rate-limiting logic.

### Finding D-02: Dormant & Retired `SystemAuth` Model
- **Classification:** **CONFIRMED**
- **Files:** `lib/models/SystemAuth.js`, `scripts/seed-auth.js`, `scripts/reset-auth.js`
- **Analysis:** `SystemAuth` (singleton collection `system_auth`) was retired in Phase 2.2 (`AUTH-ARCH-8F`). Runtime code in `app` and `lib` never reads or writes it. The model file remains in `lib/models/SystemAuth.js` and is only referenced by legacy scripts and regression assertions.
- **Safety:** Can be archived in a separate approved cleanup without impacting production runtime.

### Finding D-03: Missing `hotel-rotate-credentials.mjs`
- **Classification:** **CONFIRMED (NOT FOUND IN REPO)**
- **Analysis:** Documented in `docs/hotel-foundation.md:9-11` as an operational tool, but the file was never committed or created.
- **Safety:** Does not break existing code, but leaves an administrative capability gap.

---

## 8. API Health & Performance Audit

### 8.1 Measured / Static Performance Latency Analysis

| Endpoint | Operation | DB Round-Trips | Crypto Latency | Inefficiency Identified |
| :--- | :--- | :--- | :--- | :--- |
| `POST /api/auth/login-staff` | Staff Login | 3 (1 read, 2 writes) | ~40ms (1 scrypt) | `attachTabCredential` performs a redundant `findOne` + `updateOne` immediately after `Session.create`. |
| `POST /api/auth/verify-pin` | Station Login | 3 (1 read, 2 writes) | $N \times 40\text{ms}$ (sequential scrypt) | Iterates sequentially through all staff members in a role. If a role has 5 staff, crypto time is ~200ms. |
| `POST /api/hotel/auth/login` | Hotel Login | 5 (1 read, 4 writes) | ~80ms (scrypt $N=32768$) | Performs two consecutive `updateOne` calls on `HotelUser` (`resetHotelPinFailures` and `lastLoginAt`) instead of one. |
| `GET /api/hotel/auth/identities` | Identity List | 1 read | 0ms | Lean read; fast. |
| `requireAuth` (API guard) | Auth Check | 2 reads + 1 throttled write | 0ms | Fast when indexes are present. |

### 8.2 Database Index Deployment Status
- **Classification:** **CONFIRMED (DEFINED ONLY, NOT APPLIED AUTOMATICALLY)**
- **Analysis:** Both `lib/mongodb.js` and `lib/hotel/db/connection.js` configure `autoIndex: false`.
- **Finding:** If `scripts/hotel-deploy-indexes.mjs` has not been run against the production `bono_hotel` database, queries like `HotelSession.findOne({ tokenHash })` will perform full collection scans.

---

## 9. Policy Consistency Matrix (POS vs Hotel)

| Dimension | BONO POS Implementation | Hotel Implementation | Consistency / Risk Evaluation |
| :--- | :--- | :--- | :--- |
| **PIN Length** | Exactly 4 digits (`/^\d{4}$/`) | Exactly 4 digits (`/^\d{4}$/`) | **Consistent.** |
| **PIN Characters** | Numeric ASCII `0-9` | Numeric ASCII `0-9` | **Consistent.** |
| **PIN Normalization** | `trim()`, non-digit stripping | Non-digit stripping, regex test | **Consistent.** |
| **Default PIN Ban** | Banned in prod (`1111`, etc.) via `isRejectedDefaultCredential` | **No default PIN ban** | **Divergence:** POS has unapproved restriction; Hotel is flexible. |
| **PIN Uniqueness** | Station roles share PIN; personal roles unique | **Global uniqueness** (`findHotelPinCollision`) | **Intentional domain difference.** |
| **Hashing Algorithm** | `scrypt` (`salt:derived`) | `scrypt` (`scrypt$32768$8$1$...`) | **Different formats; isolated databases.** |
| **Hashing Cost** | $N=16384, r=8, p=1$ (~40ms) | $N=32768, r=8, p=1$ (~80ms) | Hotel has 2x higher CPU work factor. |
| **Failed Attempt Limit** | Volatile rate limit only | 5 failures = 15 min DB lock | Hotel has durable lockout; POS does not. |
| **Client IP Detection** | Checks `x-nf-...`, `x-forwarded-for`, `x-real-ip` | Checks `x-nf-client-connection-ip` ONLY | **Defect in Hotel:** Fails on Render (IP is null). |
| **Session Lifetime** | 8h absolute; idle NOT enforced | 8h absolute; 30m idle enforced | **Intentional domain difference.** |
| **Cookie Security** | `__Host-bono_session` (Strict, Secure) | `__Host-bono_hotel_session` (Strict, Secure) | **Consistent.** |
| **CSRF Mechanism** | None (SameSite=Strict cookie + tab header) | Session-derived `x-hotel-csrf-token` | Hotel enforces explicit CSRF header on mutations. |
| **Audit Logging** | Order/Stock specific | Dedicated `hotel_audit_logs` collection | Hotel has dedicated auth audit trail. |
| **Database Boundary** | `hotel_management` (`MONGODB_URI`) | `bono_hotel` (`ROOM_MONGODB_URI`) | **100% Isolated.** |

---

## 10. Security Findings

1. **Anti-Enumeration Integrity (CONFIRMED):** Both systems return generic 401 error messages (`"Invalid Name or PIN"` / `"Invalid identity or PIN"`) regardless of whether the account is nonexistent, inactive, or has a wrong PIN.
2. **Reverse Proxy Origin Defense (CONFIRMED):** In `lib/hotel/http/requestSecurity.js`, candidate hosts from `X-Forwarded-Host` are validated against a strict `trustedHosts` set, preventing Host header injection attacks.
3. **Session Secret Separation (CONFIRMED):** `lib/hotel/config.js:107` explicitly asserts that `HOTEL_SESSION_SECRET !== AUTH_SECRET`, preventing cross-application token forgery.
4. **NoSQL Injection Guard (CONFIRMED):** `lib/security.js:64-76` sanitizes operator injection (`$gt`, `$ne`) on JSON bodies.

---

## 11. Operational Risks

1. **Risk 1 (High): Production Default-PIN Lockout:** Any staff member whose PIN is reset to or currently set to a standard number (`1111`, `2222`, etc.) cannot log into POS in production.
2. **Risk 2 (High): Hotel Manager Lockout Without Recovery:** If the single Manager account in `bono_hotel` has an unknown or forgotten PIN, the operator cannot reset it via CLI or API.
3. **Risk 3 (Medium): Render Hotel Rate-Limit False Positives:** Because client IP resolves to `null` on Render, busy front-desk operations could trigger the 30 req/min global limit and lock out all Hotel users temporarily.

---

## 12. Recommended Cleanup & Optimization Plan

### Phase A: Safe Optimizations (Non-Breaking)
1. **Combine Hotel Login Updates:** Consolidate `resetHotelPinFailures` and `updateOne({ lastLoginAt })` into a single MongoDB operation in `app/api/hotel/auth/login/route.js`.
2. **Combine POS Tab Credential Issuance:** Generate and hash `tabCredential` inside `buildSessionDoc` / `createSession`, eliminating the separate `attachTabCredential` round-trip.
3. **Fix Hotel Client IP Extraction for Render:** Update `lib/hotel/http/clientIp.js` to inspect `x-forwarded-for` and `x-real-ip` when `x-nf-client-connection-ip` is missing.

### Phase B: Operational Recovery Tools (Additive)
1. **Implement `scripts/hotel-rotate-manager-pin.mjs`:** Provide an operator CLI tool requiring `--confirm` that safely updates the Manager's `pinHash` using `hashHotelPin` and clears `pinLockedUntil`.

---

## 13. Recommended Policy Decisions Requiring Owner Approval

1. **Decision 1: Removal of Default-PIN Login Ban in POS:**
   - *Current Code:* Hard rejection of `1111`, `2222`, `3333`, `4444`, `5555` at login in production.
   - *Proposed Owner Policy:* Remove `isRejectedDefaultCredential` from `verifyStaffPin` and `verify-pin`. Authenticate all PINs that match the stored hash. (Optionally display a non-blocking UI warning in Manager Staff Management).
   - *Owner Approval Required:* **YES.**
2. **Decision 2: Retention vs Removal of Banned PINs on Account Creation:**
   - *Current Code:* Blocks setting `1111`, etc. in `app/api/manager/staff/route.js`.
   - *Proposed Owner Policy:* Allow managers complete freedom to assign any 4-digit PIN chosen by the employee.
   - *Owner Approval Required:* **YES.**

---

## 14. Regression Test Plan

When cleanup or policy adjustments are authorized:
1. `tests/staff-auth-production-remediation.test.mjs`: Update assertions if the default PIN policy is modified.
2. `tests/hotel-pin-auth.test.mjs`: Verify Hotel login, lockout, and session issuance.
3. `tests/hotel-origin-request-security.test.mjs`: Verify proxy header handling.
4. `tests/auth-production-hardening.test.mjs`: Verify session validation and role guards.

---

## 15. Files That Could Be Safely Cleaned Later

- `lib/models/SystemAuth.js` (archived, unused in runtime)
- `scripts/seed-auth.js` (legacy dev helper)
- `scripts/reset-auth.js` (legacy dev helper)

---

## 16. Files That Must NOT Be Touched Without Separate Approval

- `lib/hotel/db/connection.js` (governs database isolation)
- `lib/mongodb.js` (governs POS database connection)
- `lib/hotel/models/hotelUser.js` & `hotelSession.js`
- `lib/models/Staff.js` & `Session.js`
- `lib/serverAuth.js` (core POS authorization authority)
- `lib/hotel/auth/service.js` (core Hotel authorization authority)

---

## 17. Unknowns Requiring Further Evidence

1. **Live Production Hotel Manager State:** Whether a Manager document currently exists in the live Render/Atlas `bono_hotel.hotel_users` collection, and whether its `pinHash` was hashed with scrypt or is empty/corrupted. (Cannot be inspected without connecting to production DB).
2. **Production Index State:** Whether `createIndexes()` was ever executed on the live MongoDB Atlas clusters for `sessions` and `hotel_sessions`.

---

**End of Audit Report**
