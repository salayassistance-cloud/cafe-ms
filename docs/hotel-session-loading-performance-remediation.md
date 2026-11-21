# BONO — Hotel Session Loading & Page-Open Performance Remediation

**Phase type:** HOTEL page-entry/session performance and UX correction.
**Status:** Complete. Awaiting owner review before any homepage redesign phase.
**Baseline HEAD:** `69650435a6587d4577bc126f719fa1392bb934b3` (branch `main`)

> **Phase 1 cleanup note:** This is a historical record of an earlier phase.
> The `UsersUI` shell, `ReceptionLogin` component, and standalone `/hotel/users`
> page it describes were removed during the Phase 1 legacy staff cleanup. The
> shared `app/hotel/layout.js` session gate and `HotelPinLogin` are unchanged and
> remain in place. References to those removed components below are historical.

---

## 1. Preflight baseline

| Check | Before this phase | After this phase |
|---|---|---|
| Repository root | `C:/hotelms` | unchanged |
| Branch | `main` | unchanged |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` | unchanged |
| Status entries | 239 | 241 |
| Modified | 81 | 81 |
| Deleted | 3 | 3 |
| Untracked entries | 155 | 157 |
| Untracked files | 392 | 398 |
| Staged | 0 | 0 |
| Commits ahead | 0 | 0 |

The starting tree was compared against the previous audit baseline (`docs/bono-unified-system-architecture-performance-audit.md`); the only pre-existing delta was that audit report itself. All other modified, untracked, and deleted entries were preserved exactly.

**Three EXTERNAL deletion paths confirmed intact before and after:** `app/api/external-items/route.js`, `app/api/external-sales/route.js`, `lib/models/ExternalItemRequest.js`.

No reset, clean, stash, overwrite, revert, stage, commit, or push was performed.

---

## 2. Exact root cause(s) identified

1. **No shared Hotel session state.** Four top-level Hotel client shells — `ReceptionUI`, `RoomsUI`, `RoomReportsUI`, `UsersUI` — each ran their own `useEffect` that called `GET /api/hotel/auth/me` on mount and kept private `authState` / `csrfRef` / `session` state. There was no `app/hotel/layout.js` and no session provider.
2. **Every sub-page navigation re-verified the session.** Because each route rendered its own shell, navigating Reception → Rooms → Reports remounted a fresh shell and repeated the complete session round-trip (edge proxy, Hotel DB connection, session lookup, live-user lookup, CSRF derivation) even though the session had just been verified.
3. **A blocking loading screen was on the critical path.** All four shells initialize `authState="loading"` and render `t("reception.sessionChecking")` ("Checking Hotel session…") until the client `auth/me` request resolves, so no page content can render during that round-trip. This made the delay visible and repeated.
4. **POS comparison (reference only):** POS route layouts call `getPortalSession(role)` on the server (`app/manager/layout.js:10`, and the station layouts). The session is validated before HTML is sent, so POS pages arrive ready with no client-side session-loading screen. Hotel had no equivalent server gate.

Contributing factor: in React StrictMode (development), mount effects run twice, so the duplicate `@/api/hotel/auth/me` calls were even more visible locally.

The bottleneck was **architectural duplication**, not a slow endpoint: the same verification was performed once per page shell instead of once per Hotel entry, and its result was never shared.

---

## 3. Relevant files inspected

- Pages/gates: `app/hotel/{reception,rooms,reports,users}/page.js`, `app/manager/layout.js`, `app/waiter/layout.js`, `proxy.js`, `next.config.mjs`.
- Client shells: `ReceptionUI.jsx`, `RoomsUI.jsx`, `RoomReportsUI.jsx`, `UsersUI.jsx`, `ReceptionLogin.jsx`, `HotelTopBar.jsx`, `HotelI18n.jsx`, `hotelApi.js`, `ui.jsx`.
- Server auth: `app/api/hotel/auth/me/route.js`, `lib/hotel/http/authHandlers.js`, `lib/hotel/http/authorizedRequest.js`, `lib/hotel/http/requestSecurity.js`, `lib/hotel/auth/service.js`, `lib/hotel/auth/session.js`, `lib/hotel/auth/csrf.js`, `lib/hotel/auth/cookies.js`, `lib/hotel/constants.js`, `lib/hotel/db/connection.js`.
- Localization: `lib/hotel/uiTranslations.js` (`reception.sessionChecking` = "Checking Hotel session…").
- Tests: all `tests/hotel-*.test.mjs`, especially `hotel-rooms-ui.test.mjs`, `hotel-users-ui.test.mjs`, `hotel-room-reports-ui.test.mjs`, `hotel-auth-routes.test.mjs`, `hotel-reception-login-ui.test.mjs`.
- Next.js local guides: `dist/docs/.../layout.md`, `dist/docs/.../cookies.md` (confirmed layouts persist across child navigation and `cookies()` is async/request-time in Server Components).

---

## 4. Exact files changed

**Added:**
- `lib/hotel/auth/serverSession.js` — server-only Hotel session resolver for the layout.
- `app/hotel/layout.js` — server-side Hotel session gate + provider.
- `app/components/hotel/HotelSessionProvider.jsx` — layout-scoped client session context.
- `app/components/hotel/HotelSessionGate.jsx` — sign-in gate reusing the existing Hotel login.
- `tests/hotel-session-loading-performance.test.mjs` — new DB-free contract tests.

**Modified:**
- `app/components/hotel/ReceptionUI.jsx`
- `app/components/hotel/RoomsUI.jsx`
- `app/components/hotel/RoomReportsUI.jsx`
- `app/components/hotel/UsersUI.jsx`
- `tests/hotel-rooms-ui.test.mjs` — one assertion updated to recognize the new local `useHotelSession` hook import (the "all hooks imported" guard; no authorization assertion changed).

No other source, API, schema, index, config, or workflow file was touched.

---

## 5. Explanation of the technical correction

A **POS-style server gate** was introduced for the Hotel module without sharing any POS code:

1. `getHotelServerSession()` reads the Hotel-only `__Host-bono_hotel_session` cookie via `cookies()`, connects through `connectToHotelDatabase()`, and calls `resolveHotelSession(connection, token, { touch: false })`. It derives the session-bound CSRF token with `deriveHotelSessionCsrfToken()`. It fails closed to `{ok:false}` on missing cookie, invalid/expired session, missing configuration, or DB error.
2. `app/hotel/layout.js` (async, `force-dynamic`) awaits that resolver. On failure it renders `HotelSessionGate` (the existing `ReceptionLogin`; successful login calls `router.refresh()` so the server re-validates with the new cookie). On success it wraps `children` in `HotelSessionProvider` with the verified `{user, role, csrfToken, session}`.
3. The four UI shells now call `useHotelSession()`. They initialize `authState` to `"ready"` and `session` from the provider's already-verified result, and their bootstrap `useEffect` returns early (reusing `serverSession.csrfToken`) when a provider session exists. The original `hotelRequest("/api/hotel/auth/me")` fallback remains only for renders outside the Hotel layout.
4. `UsersUI.handleLogout()` now calls `router.refresh()` after clearing local state so the server layout re-validates (cookie cleared) and replaces the provider with the sign-in gate.

The layout is preserved across client navigation between Hotel sub-pages, so verification happens once per Hotel entry rather than once per page mount.

---

## 6. Before/after request flow comparison

**Before (each Hotel page entry):**
```
GET /hotel/<page> → thin shell HTML (no server-side session check)
  → client mount: authState="loading" → "Checking Hotel session…" screen
  → GET /api/hotel/auth/me
       → proxy.js edge headers
       → connectToHotelDatabase() (cached pool)
       → HotelSession.findOne + HotelUser.findById (+ throttled touch write)
       → derive CSRF → JSON response
  → setAuthState("ready") → render page
  → only then: page data requests (parallel within each shell)
  → sub-page navigation: repeat the entire sequence
```

**After (each Hotel entry, then sub-page navigation):**
```
GET /hotel/<page>
  → server layout: getHotelServerSession()
       → cookies() → hotel DB (cached pool)
       → HotelSession.findOne + HotelUser.findById (touch:false, no write)
       → derive CSRF → verified session
  → <HotelSessionProvider session=...> + page HTML arrive ready
  → client mount: authState="ready" → page + data requests immediately
  → sub-page navigation: layout + provider persist → no session verification,
    no /api/hotel/auth/me call, no loading screen
```

The data-loading requests themselves (reservations, stays, rooms, summary, reports) were already parallel via `Promise.allSettled` and were left unchanged.

---

## 7. Before/after session request count (source-derived, not measured)

| Scenario | Before | After |
|---|---|---|
| Client `GET /api/hotel/auth/me` on first Hotel entry | 1 (2 in React StrictMode dev) | 0 |
| Client `auth/me` calls over a 3-page sub-navigation sequence | 3 | 0 |
| Server-side live session resolutions on first entry | 0 | 1 (moved from client, not additive) |
| Session touch writes during entry | possibly 1 (throttled) | 0 (`touch: false`; API reads still slide idle) |
| Blocking "Checking Hotel session…" screens on a 3-page sequence | 3 | 0 |
| DB reads per session verification | session findOne + user findById | unchanged (same two reads, server-side) |

These counts are derived from the source control flow, not from instrumented request logs.

---

## 8. Timing evidence and limitations

**No timing was measured.** No browser, dev server, API call, or database was run in this phase; no production/staging access was used. Therefore no latency numbers, before/after milliseconds, or "identical to POS" claims are made. The evidence is:

- Source control flow (§6–7): the number of sequential blocking session round-trips on page entry drops from one client round-trip per mount to zero client round-trips, with the single verification moved into the server render that was already happening.
- Next.js local documentation confirming layouts persist across navigation between child routes, which is what removes repeated verification on sub-page navigation.
- Test evidence (§10) confirming the new flow is wired and the old per-shell bootstrap is now only a fallback.

Real timing comparison would require a safe local browser/run environment and is left for owner-approved verification. The target is comparable responsiveness to POS; equivalence is not claimed as measured.

---

## 9. Security implications — how authorization remains protected

- **Server-authoritative:** the server layout resolves the live session and live user (active role) from the Hotel database on every entry using the Hotel-only cookie. No client-provided role or cached flag grants access.
- **No bypass of validation:** all protected Hotel APIs still run `authorizeHotelRequest` → `authenticateHotelRequest` with permission checks and (for mutations) exact Origin + session-bound CSRF. The client change only removes duplicate *client-side* verification; it does not weaken server checks.
- **CSRF handling:** the token is still derived from the session token with the Hotel secret, held in React memory, and forwarded only on mutations through `hotelRequest`. It is not written to storage, URL, or DOM, and is never logged. It now also travels in the dynamic RSC payload of `/hotel` pages (previously it was returned by `/api/hotel/auth/me`); both deliver the same value to the same browser, and these pages are dynamically rendered (`force-dynamic` + `cookies()`), so they are not statically cached.
- **Expired / invalid / revoked sessions:** resolver rejects them and renders the sign-in gate; mid-session 401s still drive each shell's `request()` wrapper to the login state; logout now triggers a server re-validation via `router.refresh()`.
- **Role restrictions:** unchanged. `RoomReportsUI` and `UsersUI` manager gating remains, and server handlers remain the final authority.
- **Isolation:** no POS imports in the new Hotel files; separate cookie, secret, connection, and database. No global/module-level session cache, no cross-user state sharing, no race-prone shared mutable state.
- **No new storage of credentials:** PINs, hashes, cookies, and tokens are untouched.

---

## 10. Tests run and results

| Suite / command | Result |
|---|---|
| `node --test tests/hotel-session-loading-performance.test.mjs` | 10 tests, 10 pass, 0 fail |
| Focused UI/i18n set (5 files) + new suite | 118 tests, 118 pass, 0 fail |
| `node --test tests/hotel-*.test.mjs` | 532 tests, 532 pass, 0 fail |
| `node --test tests/*.test.mjs` (full DB-free suite) | 2546 tests, 2546 pass, 0 fail |
| `npx eslint <all changed JS/JSX files>` | clean (no findings) |

No build was run (a Next build may load env files / perform static DB access, prohibited in this scope). Tests are DB-free and DOM-free source-contract tests, consistent with the repository's existing hotel test strategy. The new tests specifically assert: server-side resolution in the layout, read-only fail-closed resolver, client provider with no storage, sign-in gate reuse, and that each shell initializes from the shared session while retaining the fallback bootstrap contract.

---

## 11. Regression risks and remaining issues

- **Server-side work on first HTML:** the verification now occurs while rendering the layout, so a slow Hotel database can delay first HTML instead of showing a loading indicator. The work is the same as before (moved, not added), and the Hotel connection is pooled and cached; real latency is unverified.
- **CSRF in RSC payload:** equivalent exposure to the prior JSON response, but it relies on dynamic (non-cached) rendering of `/hotel` pages; this should be re-confirmed at the CDN layer if page caching rules change.
- **`touch: false` in the layout:** idle sliding is still performed by the API requests each page issues on entry, but a session where the user only loads HTML and makes no API calls would no longer slide on that render. This is stricter, not weaker, and matches idle-expiry semantics.
- **Fallback path retained:** if a shell is rendered without the provider, it reverts to the original client bootstrap and loading screen. This is intentional for compatibility and testability.
- **Logout uses `router.refresh()`:** low risk; if a platform refresh is delayed, local state already shows the login screen immediately.
- **Measurements not taken:** no browser-level confirmation of the UX; see §8.
- **Not addressed (out of scope):** POS UI, homepage redesign, business workflows, API/schema/index changes.

---

## 12. Confirmation — POS and HOTEL database boundaries unchanged

Confirmed. The new server resolver uses only `lib/hotel/db/connection.js` (`ROOM_MONGODB_URI`, database `bono_hotel`), Hotel models, Hotel cookie/CSRF helpers, and `cookies()` from `next/headers`. No POS connection (`lib/mongodb.js`), POS cookie, POS secret, POS model, or POS auth helper is imported or referenced. No database was merged, reconfigured, or accessed.

---

## 13. Confirmation — no prohibited operations

Confirmed. No DB migration, backfill, write, index change, seed, schema change, or database access of any kind; no secrets or `.env`/`.env.local` read; no staging/production access; no deployment or infrastructure modification; no Git staging, commit, push, reset, stash, clean, checkout, revert, or deletion of user work. The three EXTERNAL deletion paths remain intact.

---

## 14. Final working-tree status and baseline delta

- Root `C:/hotelms`, branch `main`, HEAD `69650435a6587d4577bc126f719fa1392bb934b3` (unchanged).
- Final: **241 status entries = 81 modified + 3 deleted + 157 untracked entries (398 untracked files), 0 staged**.
- Starting state for this phase: 239 entries = 81 modified + 3 deleted + 155 untracked entries (392 untracked files), 0 staged.
- **Delta:** +1 status entry / +1 untracked entry / +6 untracked files — fully explained by the 5 implementation files and this report. Modified and deleted counts are unchanged; no staged changes.
- All pre-existing user work, including the three EXTERNAL deletions, is preserved.

**STOP — this phase is complete. Do not begin unified homepage implementation until the owner reviews this report and explicitly approves the next phase.**
