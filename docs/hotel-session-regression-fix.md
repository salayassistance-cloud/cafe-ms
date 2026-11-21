# BONO — Hotel Session Remediation Regression Fix

**Priority:** Immediate.
**Status:** Fix implemented and verified by source-based tests. Awaiting owner review.
**Baseline HEAD:** `69650435a6587d4577bc126f719fa1392bb934b3` (branch `main`)

---

## 1. Preflight baseline

| Check | Before this phase | After this phase |
|---|---|---|
| Repository root | `C:/hotelms` | unchanged |
| Branch | `main` | unchanged |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` | unchanged |
| Status entries | 241 | 242 |
| Modified | 81 | 81 |
| Deleted | 3 | 3 |
| Untracked entries | 157 | 158 |
| Untracked files | 398 | 399 |
| Staged | 0 | 0 |

The starting tree matched the final state recorded in `docs/hotel-session-loading-performance-remediation.md` exactly. All existing modified, untracked, and deleted entries were preserved.

**Three EXTERNAL deletion paths confirmed intact before and after:** `app/api/external-items/route.js`, `app/api/external-sales/route.js`, `lib/models/ExternalItemRequest.js`.

No reset, clean, stash, revert, overwrite, stage, commit, or push was performed.

---

## 2. Exact runtime error root cause

**Default-vs-named export mismatch on `HotelSessionProvider`.**

- `app/hotel/layout.js:3` (as written in the remediation phase) contained:
  `import HotelSessionProvider from "@/app/components/hotel/HotelSessionProvider";`
- `app/components/hotel/HotelSessionProvider.jsx` exports only **named** bindings:
  `export function HotelSessionProvider(...)` (line 18) and `export function useHotelSession()` (line 26). It has **no `export default`**.

A default import of a module with no default export resolves to `undefined`. React therefore received `undefined` as the element type at `app/hotel/layout.js:22`, producing exactly the reported error:

> Element type is invalid: expected a string ... or a class/function ... but got: undefined. Check the render method of HotelLayout.

This was a plain ES-module import/export error — not a circular import, not a client/server boundary violation, not a path or filename problem, and not a fault in the session resolver. The other new module pair (`HotelSessionGate`: default export at `HotelSessionGate.jsx:13`, default import at `layout.js:2`) and the resolver (`getHotelServerSession`: named export, named import at `layout.js:1`) were verified to match correctly. The four UI shells' `useHotelSession` named imports also matched.

**Why earlier tests missed it:** the existing hotel tests are DB-free/DOM-free *source-contract* tests that match text patterns; they did not validate that an import style matches the target module's export style. A regression test for this exact class of bug was added.

---

## 3. Exact files changed

- `app/hotel/layout.js` — one-line import correction (Phase 2 fix).
- `tests/hotel-session-loading-performance.test.mjs` — added a new `describe("Hotel session module import/export consistency")` block with three regression tests (Phase 2 fix).

No other source, API, schema, config, workflow, or test file was modified.

---

## 4. Minimal correction implemented

Changed the layout import from a default import to the named import that actually exists:

```diff
-import HotelSessionProvider from "@/app/components/hotel/HotelSessionProvider";
+import { HotelSessionProvider } from "@/app/components/hotel/HotelSessionProvider";
```

This is the smallest possible correction: the provider component itself is correct, the server layout logic is correct, and no behavior changes. Importing a named client-component export from a Server Component is supported. The shared session architecture, server-authoritative validation, role restrictions, logout/expiry/revocation handling, and POS/HOTEL isolation are all unchanged. No `/api/hotel/auth/me` bootstrap or blocking loading screen was reintroduced, and no global cache or cross-user state was added.

A regression test now asserts that the layout's provider import is the named form, that the provider exports that named function, that the gate/resolver imports match their export styles, and that all four shells' `useHotelSession` named imports match the provider's named hook export.

---

## 5. Route investigation results

`app/hotel/` contains `layout.js` plus three pages: `reception/page.js`, `rooms/page.js`, `reports/page.js`. The former `users/page.js` was removed during the Phase 1 legacy staff cleanup.

| Requested path | Source status | Conclusion |
|---|---|---|
| `GET /hotel` | No `app/hotel/page.js` exists | **Invalid route request** — 404 is expected by the current route architecture. Not created. |
| `GET /hotel/report` | No `app/hotel/report/` directory exists | **Invalid route request** (singular; likely a typo for `/hotel/reports`). 404 is expected. Not created. |
| `GET /hotel/reports` | `app/hotel/reports/page.js` exists | **Valid intended route** — 200 is correct. Verified by source and by `tests/hotel-room-reports-ui.test.mjs`. |

A source search found no links to `/hotel` or `/hotel/report`. The existing in-app links target valid paths such as `/hotel/reception`, `/hotel/rooms`, and `/hotel/reports`. No new routes, redirects, or route rewrites were introduced; doing so would be unrelated to this regression.

Note: a 200 on a Hotel route can render the sign-in gate (the layout returns `HotelSessionGate` when no valid session), so HTTP 200 alone does not imply an authenticated page.

---

## 6. Login latency investigation results and limitations

`POST /api/hotel/auth/login 200 in 4.7s` — **source-based analysis only; no timing measurement was taken, and no change was made.**

The PIN login path (`lib/hotel/auth/service.js:112-162`, `completeHotelLogin` at `:77-110`) performs, in order:

1. Payload validation and `assertHotelSessionConfigured()` — pure, negligible.
2. `resolveConnection(connect)` → lazy `connectToHotelDatabase()` (`service.js:48-63`) — **on a cold instance this is the first Hotel DB connection**, with `serverSelectionTimeoutMS: 5000` and `connectTimeoutMS: 10000` (`lib/hotel/db/connection.js:29-40`). A slow handshake/selection is consistent with a ~4.7s duration.
3. `HotelUser.findOne(...)` with `+pinHash` — one DB read.
4. `verifyHotelPin()` — scrypt with `N=32768, r=8, p=1`, 64-byte key, ~32 MiB working memory (`lib/hotel/auth/pin.js:20-25`). Real CPU cost, but normally far below 4.7s on ordinary hardware; can be slower on constrained environments.
5. `completeHotelLogin()` — `createHotelSession` (DB insert), `HotelUser.updateOne` for `lastLoginAt`, and `safeRecordHotelAudit` (audit insert): additional DB round trips.
6. The opportunistic PIN rehash (`service.js:150-159`) is fire-and-forget (not awaited) and therefore does not block the response.
7. Next.js request/middleware overhead (`proxy.js`) — small.

**Most plausible source-supported explanation:** the preceding unauthenticated `GET /hotel/reports` did **not** open the Hotel database, because `getHotelServerSession()` returns early on a missing cookie before calling `connectToHotelDatabase()` (`lib/hotel/auth/serverSession.js`). Therefore the login request likely paid the first Hotel DB connection handshake (bounded by the 5s selection timeout), plus possible serverless cold-start cost. scrypt and the additional DB round trips are secondary contributors but cannot be quantified here.

**Limitations:** no browser, server, profiler, or database was run; the log line is the only timing datum supplied. No causal timing conclusion is proven. No login/hashing/security change was made: reducing scrypt cost or weakening authentication is out of scope. If this duration is reproducible, it should be investigated in a separate owner-approved phase with safe local timing instrumentation (warm vs cold connection, hash duration, per-query duration).

---

## 7. Tests and actual results

| Command | Result |
|---|---|
| `node --test tests/hotel-session-loading-performance.test.mjs` | **13 tests, 13 pass, 0 fail** (includes the 3 new import/export consistency tests) |
| `node --test tests/hotel-*.test.mjs` | **535 tests, 535 pass, 0 fail** |
| `node --test tests/*.test.mjs` (full DB-free suite) | **2549 tests, 2549 pass, 0 fail** |
| `npx eslint app/hotel/layout.js tests/hotel-session-loading-performance.test.mjs` | clean (no findings) |

Note: before adding the new regression tests, the focused suite had 10 tests; the three additional tests are the import/export consistency guards that would have caught this bug.

No build was run (a Next.js build can load environment files and perform static-generation DB access, which this scope prohibits).

---

## 8. Browser verification

**Not performed.** No browser automation tool or safe local dev-server run was available within this phase's restrictions (starting a dev server could load environment files and connect to databases). Verification is therefore source-based plus the DB-free test suites above. The runtime error's mechanism was identified and corrected directly in source; an owner-side browser check of `/hotel/reports` (and the other valid Hotel routes) is recommended before the next phase.

---

## 9. Security/regression considerations

- The fix changes only how an existing component is imported; no authorization or session logic changed.
- Server-side session validation in `app/hotel/layout.js` remains authoritative; all protected APIs still enforce permission, Origin, and CSRF checks.
- No reintroduction of duplicate client `/api/hotel/auth/me` bootstraps or repeated "Checking Hotel session…" screens — the shared, layout-scoped provider remains.
- No global/module-level session cache, no cross-user state sharing, no browser storage of tokens.
- Logout (`router.refresh()`), expired/invalid session handling (`HotelSessionGate`), revocation (401 → login state), and role restrictions are unchanged.
- POS/HOTEL isolation unchanged: the layout still imports only Hotel auth infrastructure and `next/headers`.
- Source-contract tests do not execute React, which is why the mismatch was not caught earlier; the new consistency tests close that specific gap. A full browser/render check remains advisable (see §8).

---

## 10. Final working-tree status and baseline delta

- Root `C:/hotelms`, branch `main`, HEAD `69650435a6587d4577bc126f719fa1392bb934b3` (unchanged).
- Final: **242 status entries = 81 modified + 3 deleted + 158 untracked entries (399 untracked files), 0 staged**.
- Phase start: 241 entries = 81 modified + 3 deleted + 157 untracked entries (398 untracked files), 0 staged.
- **Delta:** +1 entry / +1 untracked entry / +1 untracked file — this report. The two source edits were to files already present in the working tree (one inside an untracked directory, one already listed as untracked), so they add no new entries. Modified and deleted counts are unchanged.

---

## 11. Confirmation — database boundaries and user work preserved

Confirmed. No database was merged, reconfigured, accessed, or written to. The Hotel connection manager (`ROOM_MONGODB_URI`, `bono_hotel`) and POS connection manager (`MONGODB_URI`) remain separate and untouched. All pre-existing user work — modified, untracked, and deleted files — was preserved exactly, including the three EXTERNAL deletion paths.

---

## 12. Confirmation — no prohibited operations

Confirmed. No DB writes, migrations, backfills, index changes, seeds, or schema changes; no production/staging access; no secrets or `.env` files read; no deployment or infrastructure change; no POS, Hotel business-logic, or unrelated performance changes; no Git staging, commit, push, reset, stash, clean, checkout, or revert.

**STOP — regression fix complete. Awaiting owner review. Do not begin the unified homepage UI phase until explicitly approved.**
