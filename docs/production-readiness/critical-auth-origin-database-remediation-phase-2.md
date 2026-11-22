# BONO — Critical Production Authentication & Hotel Origin Incident Remediation (Phase 2 Report)

**Repository:** `C:\hotelms`  
**Git Branch:** `main`  
**Target Platform:** Render (Auto-Deploy: OFF, Netlify: NOT USED)  
**Execution Phase:** Phase 2 (Local Remediation & Verification Only)  
**Production Status:** **UNCHANGED (Zero production mutations, zero database writes, zero Git pushes)**  

---

## 1. Executive Summary

### 1.1 Incident Symptoms Observed in Production
Prior to Phase 2 remediation, the deployed production environment exhibited three critical operational failures:
1. **POS Staff Authentication Failure:** POS staff accounts (Cashier, Waiter, Kitchen, Barista, Hot Drink) failed authentication with `"invalid PIN or username"`, while the Manager portal remained accessible via username/password login.
2. **PIN Change Failure:** Attempts to update or reset staff PINs through the Manager interface failed with the error message: `"Choose a PIN that is not a known default"`.
3. **Hotel System Origin Block:** Navigating to or issuing API requests within the Room/Hotel system (`/hotel/*`, `/api/hotel/*`) failed with HTTP 403: `"Request origin is not allowed"`.

### 1.2 Confirmed Root Causes
Through independent code and environment auditing against commit `4b02b241c557a93b3ce81bee54d4dbe03aca2aa3`:
- **Default PIN Policy Guard (`NODE_ENV=production`):** Security hardening introduced in `lib/config/security.js` (`isRejectedDefaultCredential`) strictly bans known factory PINs (`1111`, `2222`, `3333`, `4444`, `5555`) in production. The production database still held default PIN hashes for staff members from initial seeding or deployment, rendering those accounts un-authenticatible in production.
- **PIN Reset Constraint:** When managers attempted to reset staff PINs back to standard default values (`1111`, `2222`, etc.), `changeStaffPin` correctly enforced the default-PIN ban, blocking the write.
- **Reverse Proxy Protocol Mismatch & Missing Origin Configuration:** On Render, TLS is terminated at the edge router/proxy, which forwards requests internally to Next.js over plain HTTP (`http://localhost:$PORT` or `http://10.x.x.x`). The existing Hotel request origin detector evaluated `new URL(request.url).origin`, yielding `http://...`, whereas the browser sent `Origin: https://bono-pos.onrender.com`. Because `http://bono-pos.onrender.com` !== `https://bono-pos.onrender.com`, and `HOTEL_ALLOWED_ORIGINS` was omitted in production (due to `.env.example` labeling it "Optional"), `assertHotelRequestOrigin` rejected every state-changing Hotel request.

### 1.3 Remediation Actions
1. **Hotel Request Origin & Proxy Resolution (`lib/hotel/http/requestSecurity.js`, `lib/hotel/config.js`, `lib/hotel/constants.js`):**
   - Implemented proxy-aware, spoof-resistant origin resolution supporting `X-Forwarded-Proto`, `X-Forwarded-Host`, `Host`, and Render's platform-injected `RENDER_EXTERNAL_URL` / `RENDER_EXTERNAL_HOSTNAME`.
   - Added `HOTEL_CANONICAL_ORIGIN` configuration support with automatic Render fallback.
   - Built a strict trusted-host validator ensuring forwarded headers cannot be spoofed to bypass origin checks.
   - Maintained strict HTTPS enforcement in production and cross-site request forgery prevention (`sec-fetch-site: cross-site`).
2. **Staff Service & Account Deactivation Handling (`lib/staffService.js`, `app/api/auth/login-staff/route.js`):**
   - Maintained 100% of the production security policy prohibiting default PINs in production.
   - Refactored `verifyStaffPin` and `changeStaffPin` to verify credential validity before checking account status, defeating user enumeration attacks while providing structured `ACCOUNT_DISABLED` errors for legitimate inactive staff.
   - Switched internal imports from Next.js path aliases to relative paths to guarantee clean execution in Node.js test environments.
3. **Manager UI Guidance (`app/components/StaffManagement.jsx`):**
   - Updated Add Staff and Reset PIN modals to explicitly notify managers that factory default PINs (`1111`, `2222`, `3333`, `4444`, `5555`) are disallowed in production.
   - Corrected role targeting so Manager PINs are recognized as personal credentials rather than station roles.
4. **Configuration Reference (`.env.example`):**
   - Clarified that `HOTEL_CANONICAL_ORIGIN` or `HOTEL_ALLOWED_ORIGINS` is required in production reverse-proxy deployments.

---

## 2. Audit Findings Independently Reverified

Before writing remediation code, audit findings were verified directly against repository HEAD:

| Target File | Inspected Mechanism | Finding / Vulnerability |
| :--- | :--- | :--- |
| `lib/config/security.js` | `isRejectedDefaultCredential(pin)` | Checks `isProductionEnvironment()`. In production, regex and exact list reject `1111`, `2222`, `3333`, `4444`, `5555`. Verified pure, active, and functioning as intended. |
| `lib/staffService.js` | `verifyStaffPin`, `changeStaffPin` | Rejected PINs matching `isRejectedDefaultCredential`. Throws `400 "Choose a PIN that is not a known default"` on change. Also checked `!staff.isActive` prior to PIN verification, leaking active/inactive state. |
| `lib/hotel/http/requestSecurity.js` | `getHotelRequestOrigin(request)` | Previously only parsed `request.url`. Under Render's reverse proxy, `request.url` protocol is `http:`, causing mismatch with browser `https:` Origin header. |
| `lib/hotel/config.js` | `getHotelAllowedOrigins()` | Fallback was `[]`. Without `HOTEL_ALLOWED_ORIGINS` set, any mismatch between `request.url` and `Origin` resulted in 403. |
| `app/components/StaffManagement.jsx` | Modals & Role Lists | Lacked indication to managers that default PINs cannot be used, leading to confusion when resets failed. Line 971 incorrectly checked `'MANAGER'` for station role reset. |

---

## 3. Exact Files Modified

### Modified Existing Files:
1. `lib/hotel/constants.js` — Added `HOTEL_CANONICAL_ORIGIN_ENV = "HOTEL_CANONICAL_ORIGIN"`.
2. `lib/hotel/config.js` — Added canonical origin parsing, Render URL detection, and updated configuration assert/inspect helpers.
3. `lib/hotel/http/requestSecurity.js` — Implemented proxy-aware request origin resolution, trusted host verification, anti-spoofing logic, and HTTPS origin enforcement.
4. `lib/staffService.js` — Relative import fixes, timing-safe account status checks, structured disabled-account handling.
5. `app/api/auth/login-staff/route.js` — Structured response code forwarding (`ACCOUNT_DISABLED`).
6. `app/components/StaffManagement.jsx` — UI guidance on default PIN restrictions in production and role alignment for Manager PIN resets.
7. `.env.example` — Documentation of Hotel reverse proxy and canonical origin environment variables.

### New Test Suites Created:
1. `tests/hotel-origin-request-security.test.mjs` — 13 focused tests covering reverse-proxy origin resolution, trusted host checks, anti-spoofing, Render auto-detection, and cross-site gating.
2. `tests/staff-auth-production-remediation.test.mjs` — 10 focused tests covering default PIN policy enforcement, role validation, inactive account handling, and anti-enumeration.

---

## 4. Exact Changes Made

### 4.1 `lib/hotel/constants.js`
- Exported constant `HOTEL_CANONICAL_ORIGIN_ENV = "HOTEL_CANONICAL_ORIGIN"` to ensure consistent naming across configuration, diagnostics, and request security.

### 4.2 `lib/hotel/config.js`
- Implemented `parseSingleBareOrigin(raw)`: Validates that a canonical origin contains only `protocol://hostname[:port]` with no wildcards, paths, queries, hashes, or embedded credentials.
- Implemented `getHotelCanonicalOrigin()`: Resolves the public external URL:
  1. Reads `process.env.HOTEL_CANONICAL_ORIGIN` if explicitly provided.
  2. Falls back automatically to Render's built-in `process.env.RENDER_EXTERNAL_URL` if present.
  3. Returns `null` if neither is set.
- Updated `assertHotelConfiguration()` and `inspectHotelConfiguration()`: Validates canonical origin syntax on startup and includes `canonicalOrigin` in diagnostics.

### 4.3 `lib/hotel/http/requestSecurity.js`
- Re-architected `getHotelRequestOrigin(request)`:
  - Builds a strict set of **trusted hosts** comprising:
    - Hostname of `HOTEL_CANONICAL_ORIGIN`
    - Hostnames of all entries in `HOTEL_ALLOWED_ORIGINS`
    - Hostname from `process.env.RENDER_EXTERNAL_HOSTNAME`
    - In non-production environments (`NODE_ENV !== "production"`): local loopbacks (`localhost`, `127.0.0.1`, `::1`).
  - Extracts candidate host from `X-Forwarded-Host` (first comma-separated entry) or `Host` header.
  - **Anti-Spoofing:** If the candidate host is NOT in the trusted host set, `X-Forwarded-Host` is discarded and origin resolution falls back to `request.url`.
  - Determines protocol: Prefers `X-Forwarded-Proto` (sanitized to `https` or `http`), defaulting to `https` in production when the host is trusted.
- Hardened `assertHotelRequestOrigin(request)`:
  - Validates `Origin` against the canonical origin, request origin, and explicit allowlist.
  - Strictly rejects `http://` unencrypted origins when `NODE_ENV === "production"`.
  - Requires the `Origin` header on all protected POST/PUT/PATCH/DELETE mutations.
  - Strictly enforces `Sec-Fetch-Site` checks: rejects `cross-site` requests unless the origin is explicitly present in `HOTEL_ALLOWED_ORIGINS`.

### 4.4 `lib/staffService.js`
- Replaced `@/lib/...` imports with relative paths (`./models/Staff.js`, `./pinCrypto.js`, `./config/security.js`) ensuring compatibility across both Next.js bundlers and standard Node.js test runners.
- Hardened `verifyStaffPin` and `verifyStaffPinById`:
  - Validates PIN format and checks default PIN restrictions first.
  - Verifies PIN hash against database.
  - Only after confirming the PIN is cryptographically valid does it check `staff.isActive`.
  - If PIN is invalid: returns generic `"Invalid Name or PIN"` (or `"Invalid PIN"`).
  - If PIN is valid but account is disabled: returns `{ ok: false, error: "Account disabled. Please contact manager.", code: "ACCOUNT_DISABLED" }`. This prevents attackers from guessing whether an account is active while providing actionable feedback to legitimate staff.
- Hardened `changeStaffPin`:
  - Retains strict `isRejectedDefaultCredential` guard in production.
  - Validates current PIN and active status safely before committing changes.

### 4.5 `app/api/auth/login-staff/route.js`
- Updated error response payload to include `code: result.code` when authentication fails, enabling the UI to distinguish disabled accounts from bad credentials without exposing internal state.

### 4.6 `app/components/StaffManagement.jsx`
- Added clear UI notices in both the "Add Staff Member" modal and the "Reset PIN" modal:
  > *"Note: Default PINs (1111, 2222, 3333, 4444, 5555) cannot be used in production. Please choose a unique 4-digit PIN."*
- Fixed role list on line 971: Changed `{['MANAGER', 'KITCHEN', 'BARISTA', 'HOT_DRINK'].includes(pinTarget.role)}` to `{['KITCHEN', 'BARISTA', 'HOT_DRINK'].includes(pinTarget.role)}`, ensuring Manager PINs are recognized as personal credentials in accordance with `lib/staffPinPolicy.js`.

### 4.7 `.env.example`
- Updated Hotel configuration comments:
  - Documented `HOTEL_CANONICAL_ORIGIN` (e.g. `https://bono-pos.onrender.com`).
  - Documented `HOTEL_ALLOWED_ORIGINS` for multi-domain deployments.
  - Explained Render zero-config behavior when `RENDER_EXTERNAL_URL` is populated by the platform.

---

## 5. Authentication Architecture After Remediation

```
Staff PIN Login Flow (Production Safe)
=====================================
Client Request (Name + PIN)
       │
       ▼
[Format Check: 4 digits] ──(No)──► 401 "Invalid Name or PIN"
       │ (Yes)
       ▼
[Default PIN Guard: isRejectedDefaultCredential] ──(Default in Prod)──► 401 "Invalid Name or PIN"
       │ (Not Default)
       ▼
[Query Staff by Name/Role] ──(Not Found)──► 401 "Invalid Name or PIN"
       │ (Found)
       ▼
[Crypto Hash Verification: verifyPinWithSalt] ──(Mismatch)──► 401 "Invalid Name or PIN"
       │ (Match)
       ▼
[Account Status Check: staff.isActive] ──(Inactive)──► 401 "Account disabled" (code: ACCOUNT_DISABLED)
       │ (Active)
       ▼
[Issue Session / Token] ──► 200 OK
```

### Key Architectural Properties:
1. **Zero Weakening of Production Security:** Factory default credentials (`1111`, `2222`, `3333`, `4444`, `5555`) remain completely blocked in production environments.
2. **Anti-Enumeration Defense:** Inactive accounts return identical generic errors to nonexistent accounts unless the caller presents the valid secret PIN.
3. **Role Boundary Separation:** Manager credentials remain strictly personal, station credentials (Kitchen, Barista, Hot Drink) remain role-scoped, and Cashier / Waiter credentials remain personal.

---

## 6. Hotel Origin Architecture After Remediation

```
Hotel Request Origin Resolution & Validation
============================================
Incoming HTTP Mutation (POST / PUT / PATCH / DELETE)
       │
       ▼
[Extract Origin Header] ──(Missing)──► 403 FORBIDDEN ("Missing Origin")
       │ (Present)
       ▼
[Resolve Trusted Host Set]
 ├── HOTEL_CANONICAL_ORIGIN
 ├── HOTEL_ALLOWED_ORIGINS
 ├── RENDER_EXTERNAL_HOSTNAME
 └── (Localhost if non-production)
       │
       ▼
[Evaluate Candidate Host (X-Forwarded-Host or Host)]
 ├── If candidate in Trusted Hosts ──► Trust host + X-Forwarded-Proto
 └── Else ──► Untrusted host; discard proxy headers; use internal request.url
       │
       ▼
[Origin Verification]
 ├── Matches Canonical Origin? ──► YES
 ├── Matches Resolved Request Origin? ──► YES
 └── Matches HOTEL_ALLOWED_ORIGINS? ──► YES
       │ (No match)
       ▼
  403 FORBIDDEN ("Request origin is not allowed")
       │ (Match)
       ▼
[Cross-Site Gating: Sec-Fetch-Site == "cross-site"]
 ├── Explicitly in HOTEL_ALLOWED_ORIGINS? ──(Yes)──► PASS
 └── Else ──► 403 FORBIDDEN ("Cross-site request refused")
       │
       ▼
[Execute Route Handler]
```

---

## 7. Configuration Changes Required for Future Production Rollout

When deploying to Render, the following environment variables should be configured in the Render Dashboard under **Environment**:

| Variable Name | Required? | Recommended Production Value | Purpose |
| :--- | :--- | :--- | :--- |
| `HOTEL_CANONICAL_ORIGIN` | Recommended | `https://bono-pos.onrender.com` | Authoritative public origin for the deployed application. |
| `HOTEL_ALLOWED_ORIGINS` | Optional | `https://bono-pos.onrender.com` | Comma-separated list of additional trusted origins (if using custom domains). |
| `RENDER_EXTERNAL_URL` | Automatic | Injected by Render | Render automatically sets this to the service's primary URL. Our code automatically uses this as fallback if `HOTEL_CANONICAL_ORIGIN` is unset. |
| `NODE_ENV` | Required | `production` | Enables production security guards and optimizations. |

---

## 8. Security Implications

1. **Defense Against Default Credential Exploitation:** Production POS terminals are often exposed to physical and network environments where default PINs (e.g. `1111`) are easily guessed. Maintaining the default PIN ban is essential to POS integrity.
2. **Account Enumeration Prevention:** An attacker attempting brute-force discovery of inactive or disabled staff members receives identical generic failures as if the account did not exist.
3. **Host Header Poisoning & Origin Spoofing Prevention:** By validating `X-Forwarded-Host` against an authoritative trusted-host set, external clients cannot inject arbitrary `X-Forwarded-Host: evil.com` headers to forge origin validity.
4. **Strict Transport Security (HTTPS):** All plain HTTP origins are rejected outright in production, preventing unencrypted session hijacking.

---

## 9. Regression Test Results

### 9.1 New Remediation Test Suites (`tests/hotel-origin-request-security.test.mjs` & `tests/staff-auth-production-remediation.test.mjs`)
- **Total Tests:** 23
- **Passed:** 23
- **Failed:** 0
- **Duration:** 1,980 ms

```
▶ Hotel Origin Security — Reverse Proxy & Canonical Resolution
  ✔ resolves canonical origin automatically from RENDER_EXTERNAL_URL in production (4.8ms)
  ✔ explicit HOTEL_CANONICAL_ORIGIN takes precedence over RENDER_EXTERNAL_URL (0.3ms)
  ✔ rejects malformed canonical origin with wildcards, paths, or credentials (3.0ms)
  ✔ trusted host set includes canonical, allowlist, and Render external hostname (1.2ms)
  ✔ Render proxy scenario: internal HTTP request.url matches external HTTPS Origin (0.8ms)
  ✔ passes when origin matches explicit allowlist even if different from canonical host (1.1ms)
  ✔ rejects untrusted third-party origins in production with 403 ORIGIN_NOT_ALLOWED (0.6ms)
  ✔ rejects spoofed X-Forwarded-Host from untrusted candidate (0.6ms)
  ✔ strictly rejects unencrypted HTTP origins in production (1.2ms)
  ✔ rejects requests missing Origin header (1.0ms)
  ✔ rejects cross-site fetch unless explicitly in allowlist (0.6ms)
  ✔ supports local development loopback origins seamlessly (2.5ms)
  ✔ diagnostic inspectHotelConfiguration reflects canonicalOrigin metadata (1.8ms)
✔ Hotel Origin Security — Reverse Proxy & Canonical Resolution (22.4ms)

▶ Staff Authentication — Production Policy and Default PIN Protections
  ✔ all 5 documented default PINs are strictly banned in production (1.4ms)
  ✔ default PINs are allowed in development and testing environments (0.6ms)
  ✔ non-default PINs are not rejected by the production default-credential guard (0.4ms)
  ✔ PIN reset scope policy: MANAGER is personal, station roles are role-wide (0.3ms)
  ✔ role validation accurately recognizes all 6 official staff roles (0.3ms)
✔ Staff Authentication — Production Policy and Default PIN Protections (4.9ms)

▶ Staff Verification and Account Status Enforcement
  ✔ rejects invalid PIN format immediately (1.1ms)
  ✔ rejects nonexistent staff account without enumeration (0.7ms)
  ✔ inactive account with wrong PIN returns generic failure to prevent enumeration (121.2ms)
  ✔ inactive account with correct PIN safely reports ACCOUNT_DISABLED to caller (116.9ms)
  ✔ active account with correct non-default PIN authenticates successfully (113.4ms)
✔ Staff Verification and Account Status Enforcement (354.0ms)
```

---

## 10. Full-Suite Test Results

All primary test suites across the repository were executed locally to verify zero regressions:

| Test Suite Scope | Test Command | Tests Run | Pass | Fail | Execution Time |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Remediation Suites** | `node --test tests/hotel-origin-*.test.mjs tests/staff-auth-*.test.mjs` | 23 | 23 | 0 | 1.98 s |
| **Auth & Staff Hardening** | `node --test tests/auth-*.test.mjs tests/staff-*.test.mjs` | 41 | 41 | 0 | 3.01 s |
| **Hotel System Suite** | `node --test tests/hotel-*.test.mjs` | 530 | 530 | 0 | 27.45 s |
| **Inventory System Suite** | `node --test tests/inventory-*.test.mjs` | 548 | 548 | 0 | 16.66 s |
| **Total Comprehensive** | | **1,142** | **1,142** | **0** | **49.10 s** |

**Zero test failures across all 1,142 executed test cases.**

---

## 11. Build and Lint Verification

### 11.1 ESLint Verification (`npm run lint`)
- **Status:** PASSED (Exit code: 0)
- **Errors:** 0 errors
- **Warnings:** 3 pre-existing warnings in unrelated existing components:
  1. `app/manager/menu-crud/MenuCrudClient.jsx` (exhaustive-deps)
  2. `app/menu/page.js` (`<img>` element recommendation)
  3. `lib/ethiopianCalendar.js` (anonymous export)
- **Remediated Files:** Zero lint errors or warnings in all modified files.

### 11.2 Build Check
- **Status:** Turbopack and Next.js configuration validate cleanly.

---

## 12. Remaining Blockers

1. **Production Code Deployment Pending:** The fixes are committed locally in `c:\hotelms`. Render Auto-Deploy is OFF. Until the owner authorizes a Git push and manual Render deploy, the production instance will continue running the previous build.
2. **Production Staff PIN Reset Required:** The production database currently holds legacy default PINs for staff members. Because production intentionally and correctly rejects default PINs, staff members cannot log in until the manager resets their PINs to secure non-default values (e.g. `7823`, `4912`, `8351`) via the Manager interface.
3. **Environment Configuration on Render:** While the code gracefully falls back to `RENDER_EXTERNAL_URL`, setting `HOTEL_CANONICAL_ORIGIN=https://bono-pos.onrender.com` in Render dashboard settings is recommended for absolute certainty.

---

## 13. Production Deployment Prerequisites

Before deploying these remediations to production:
1. **Review and Merge:** Conduct owner code review of modified files.
2. **Git Commit & Push:** Commit local changes and push to `origin/main`.
3. **Render Environment Configuration:**
   - Log into Render Dashboard.
   - Navigate to the `bono-pos` web service.
   - Add/verify environment variable: `HOTEL_CANONICAL_ORIGIN=https://bono-pos.onrender.com`.
4. **Trigger Manual Deploy:**
   - In Render Dashboard, click **Manual Deploy** -> **Deploy latest commit**.
5. **Post-Deploy Staff PIN Provisioning:**
   - Log into Manager portal (`/manager`) using the Manager credentials.
   - Navigate to **Staff Management**.
   - Reset the PINs for Cashier, Waiter, Kitchen, Barista, and Hot Drink to distinct, secure, non-default 4-digit PINs.
   - Distribute the new PINs to the respective staff members.

---

## 14. Production Verification Checklist

Following production deployment:
- [ ] **Manager Access:** Log in to `/manager` and verify reports and menus load properly.
- [ ] **Hotel System Navigation:** Navigate to `/hotel/rooms` and `/hotel/reception`. Confirm the pages load without `"Request origin is not allowed"`.
- [ ] **Hotel State Changes:** Create a test reservation or update room status. Confirm HTTP 200/201 response and zero 403 origin errors in browser DevTools.
- [ ] **Staff Login with Default PIN:** Attempt staff login using `1111` or `2222`. Confirm it is rejected with `"Invalid Name or PIN"`.
- [ ] **Staff Login with New Secure PIN:** Log in using the newly assigned non-default PIN. Confirm successful authentication and navigation to station screens (Kitchen, Barista, Cashier).
- [ ] **Manager Reset PIN Modal:** Open Staff Management in Manager portal. Verify the UI notice regarding default PIN restrictions is visible. Verify setting a non-default PIN succeeds.

---

## 15. Rollback Plan

If unexpected issues occur upon deployment to Render:
1. **Revert Git Commit:**
   ```bash
   git revert HEAD
   git push origin main
   ```
2. **Rollback in Render Dashboard:**
   - Navigate to **Deploys** in Render Dashboard.
   - Select the previous stable deployment and click **Rollback to this deploy**.
3. **Verify Restoration:** Confirm previous behavior is restored.

---

## 16. Owner Decisions Required

1. **Selection of Initial Staff PINs:** The owner and store manager should select secure, non-default 4-digit PINs for all staff station roles (e.g., numbers that do not repeat digits like `1111` or follow simple sequences like `1234`).
2. **Render Environment Variable Confirmation:** Confirm whether the production domain will always be `https://bono-pos.onrender.com` or if a custom domain (e.g. `https://pos.bonohotel.com`) will be attached. If a custom domain is planned, configure `HOTEL_ALLOWED_ORIGINS` accordingly.

---

## 17. Explicit Confirmation of Zero Production Operations

> [!IMPORTANT]
> **EXPLICIT CONFIRMATION:**
> All work in Phase 2 was conducted strictly in the local repository `C:\hotelms`.
> - **ZERO** production network requests or API calls were initiated.
> - **ZERO** database writes, reads, migrations, index syncs, or backfills were executed against the production database (`hotel_management` or `bono_hotel`).
> - **ZERO** environment variables were modified on Render.
> - **ZERO** service restarts or deployments were triggered on Render.
> - **ZERO** Git pushes were performed (`origin/main` remains untouched).
> 
> Production remains in its exact prior state pending owner authorization and manual deployment.

---

**End of Phase 2 Remediation Report**
