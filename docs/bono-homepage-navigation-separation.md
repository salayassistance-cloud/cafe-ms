# BONO — Homepage Navigation Separation Correction

**Phase type:** Navigation / UI correction only.
**Status:** Complete. Awaiting owner review. No further phase started.
**Baseline HEAD:** `69650435a6587d4577bc126f719fa1392bb934b3` (branch `main`).

---

## 1. Files changed

**Modified:**

- `app/page.js` — main homepage reduced to exactly two primary module cards (`POS`, `ROOM`); all sub-page navigation, PIN modal and portal data removed from this route.
- `lib/translations.js` — added `backToHome` in all three languages (`am`, `en`, `om`).
- `tests/bono-homepage-layout.test.mjs` — rewritten as the three-level navigation contract test (now 8 tests).
- `tests/hot-drink-station.test.mjs` — two source-contract assertions repointed from `app/page.js` to the new shared catalog (`app/components/HomeNav.jsx`); intent unchanged ("login/home/PIN surfaces know `/jebena`").

**Added:**

- `app/components/HomeNav.jsx` — shared BONO portal catalog (existing routes, icons, labels), shared tile styling, and the landing-page shell with the Back-to-Main-Homepage link.
- `app/pos/page.js` — dedicated POS landing page.
- `app/room/page.js` — dedicated ROOM landing page.
- `docs/bono-homepage-navigation-separation.md` — this report.

No API, schema, DB, auth, business-logic, Hotel/POS destination page or configuration file was modified.

---

## 2. New routes / pages created

| Route | File | Purpose |
|---|---|---|
| `/pos` | `app/pos/page.js` | Dedicated POS landing page — six POS destination cards only |
| `/room` | `app/room/page.js` | Dedicated ROOM landing page — three Hotel destination cards only |

Both are ordinary top-level App Router pages under the existing root layout. `proxy.js` matches `/api/:path*` only, so neither route is gated or rewritten. No route was removed, renamed or shadowed.

---

## 3. Navigation behavior

```
Main Homepage (/)
   ├─ POS card ──> /pos  ──> Manager Reports / Cashier / Waiter / Kitchen / Barista / Jebena Buna
   └─ ROOM card ─> /room ──> Reception / Room Management / Room Reports
```

- **Main homepage (`/`):** only the two primary cards, reusing the existing BONO background image (`/home/homepage.png`), overlay, theme/language toggles, typography, colors, icon family and footer. No sub-pages, accordions, modals or conditional hiding are used.
- **POS landing (`/pos`):** shows only the six POS cards. Clicking a card runs the *same* `handlePortalClick` logic that was on the homepage, opening the existing `PinLoginModal` (PIN verification, tab credential, heartbeat and `navigateAfterAuth` are untouched). The obsolete `/menu`, `INVENTORY` and `STAFF` branches were carried over verbatim rather than dropped.
- **ROOM landing (`/room`):** shows only the three Hotel cards as `next/link` links. Authentication remains owned by the unchanged `/hotel` server layout; no POS PIN modal is involved.
- **Back navigation:** both landing pages render a visible `← Back to Main Homepage` link (`<Link href="/">` with `aria-label`) in the shared `LandingShell`. Theme and language controls appear in the same position on all three pages.
- Responsive grids: homepage 1 column → 2 at `md`; POS landing 2 columns → 3 at `lg`; ROOM landing 1 column → 3 at `sm`. No fixed widths or horizontal overflow introduced.

---

## 4. Confirmation of route reuse

All destination routes are unchanged and are sourced from the shared catalog:

- POS: `/manager/reports`, `/cashier`, `/waiter`, `/kds`, `/barista`, `/jebena`
- Hotel: `/hotel/reception`, `/hotel/rooms`, `/hotel/reports`

Existing protections remain in place: POS route layouts still call `getPortalSession(role)` / `PinGuard`, and `app/hotel/layout.js` still runs `getHotelServerSession()`, renders `HotelSessionGate` on failure and wraps children in `HotelSessionProvider`. No session architecture, CSRF handling, cookie or database boundary was changed; no `/api/hotel/auth/me` bootstrap was reintroduced.

---

## 5. Tests and results

| Command | Result |
|---|---|
| `node --test tests/bono-homepage-layout.test.mjs tests/hot-drink-station.test.mjs` | **36 pass, 0 fail** |
| `node --test tests/hotel-session-loading-performance.test.mjs tests/hotel-rooms-ui.test.mjs tests/hotel-room-reports-ui.test.mjs tests/hotel-reception-login-ui.test.mjs` | **67 pass, 0 fail** |
| `node --test tests/*.test.mjs` (full DB-free suite) | **2557 pass, 0 fail** (baseline 2555; +2 focused tests) |

The updated homepage contract tests assert: exactly two homepage cards; no sub-page routes on `/`; existing image/tokens/controls retained; POS landing contains only POS destinations plus the unchanged PIN flow; ROOM landing contains only Hotel destinations and no PIN modal; both landing pages expose Back-to-Main-Homepage; all destination routes preserved; Hotel server layout/provider/gate intact; label parity across `am`/`en`/`om`.

---

## 6. ESLint result

`npx eslint app/page.js app/pos/page.js app/room/page.js app/components/HomeNav.jsx lib/translations.js tests/bono-homepage-layout.test.mjs tests/hot-drink-station.test.mjs`

**Clean — no findings.**

No `next build` or dev server was started (both can load environment files / touch external services, prohibited by this scope).

---

## 7. Browser verification status

**Not performed.** No browser or dev-server run was used, so no visual or interactive verification is claimed. Verification was source-contract and test based. An owner-side visual check of `/`, `/pos` and `/room` at desktop/tablet/mobile widths in both themes is recommended.

---

## 8. Baseline and ending working-tree status

- Root `C:/hotelms`, branch `main`, HEAD `69650435a6587d4577bc126f719fa1392bb934b3` — unchanged.
- Baseline: **244 entries = 81 modified + 3 deleted + 160 untracked entries (401 files), 0 staged**.
- Ending: **248 entries = 81 modified + 3 deleted + 164 untracked entries (405 files), 0 staged**.
- **Delta:** +4 status entries / +4 untracked entries / +4 untracked files — fully explained by `app/components/HomeNav.jsx`, `app/pos/page.js`, `app/room/page.js` and this report. Modified/deleted counts and staged count are unchanged.
- The three EXTERNAL deletion paths remain deleted and untouched: `app/api/external-items/route.js`, `app/api/external-sales/route.js`, `lib/models/ExternalItemRequest.js`.
- All other pre-existing modified and untracked work was preserved. No destructive Git command, staging, commit or push was performed; no databases, production services, secrets or environment files were accessed.

---

## 9. Unresolved issues

- No browser/visual verification (§7).
- The POS catalog retains the legacy `/menu`, `INVENTORY` and `STAFF` handler branches as inert compatibility code; no card currently renders them (same as before this correction).
- No further issues known.

**STOP — this phase is complete. Do not proceed to any additional phase.**
