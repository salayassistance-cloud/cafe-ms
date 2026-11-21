# BONO — Strict UI Correction (Four Items)

**Phase type:** Four explicitly authorized UI changes only.
**Status:** Complete. Awaiting owner review. No further phase started.
**Baseline HEAD:** `69650435a6587d4577bc126f719fa1392bb934b3` (branch `main`).

---

## 1. Baseline and ending working-tree status

| Check | Baseline | Ending |
|---|---|---|
| Repository root | `C:/hotelms` | unchanged |
| Branch / HEAD | `main` / `6965043…` | unchanged |
| Status entries | 254 | **255** |
| Modified | 85 | 85 |
| Deleted | 3 | 3 |
| Untracked entries | 166 (407 files) | 167 (408 files) |
| Staged | 0 | 0 |

Baseline was 254 entries because `public/home/homepage.png` had become a **pre-existing modified file before this phase began** (owner work). It was preserved untouched — no image asset was replaced or edited. All other prior modified/untracked work was preserved; no reset, clean, stash, revert, overwrite or destructive Git command was used.

The three EXTERNAL deletion paths remain deleted: `app/api/external-items/route.js`, `app/api/external-sales/route.js`, `lib/models/ExternalItemRequest.js`.

Delta: +1 untracked file only (this report).

---

## 2. Exact files changed

**Modified:**

- `app/page.js` — Changes 1, 2 and 3 (titles, solid cards/divider/reduced image treatment, card position and icon lists).
- `app/components/HomeNav.jsx` — Change 4 (fixed-height desktop landing frame, compact heading/subtitle shell, smaller square tiles/icons).
- `app/pos/page.js`, `app/room/page.js` — Change 4 (subtitle strings, smaller tile text/icons).
- `lib/translations.js` — four new keys per language (`am`, `en`, `om`): `restaurantOperationsTitle`, `hotelOperationsTitle`, `posLandingSubtitle`, `roomLandingSubtitle`. No existing translation removed or altered.
- `tests/bono-homepage-layout.test.mjs` — focused contract tests updated for the four changes.

**Added:** `docs/bono-ui-correction-four-items.md` (this report).

No other file was touched.

---

## 3. Implementation details

**Change 1 — Card titles:** The two visible homepage card headings are now rendered through `titleKey`/`fallbackTitle`: **Restaurant Operations** (POS card) and **Hotel Operations** (ROOM card), with AM/EN/OM strings in `lib/translations.js`. Internal identifiers (`href: "/pos"`, `href: "/room"`, component names, routes, roles) are unchanged.

**Change 2 — Background separation:** The homepage cards now use an explicit solid `bg-[var(--c-card)]` plus `border border-[var(--c-border)]` (no transparency). The blended gradient fade was removed and replaced with a clear `border-b-2 border-[var(--c-accent)]` line at the bottom of the hero. The existing image asset is kept but rendered at `opacity-80` so the image area is more subtle; the theme-aware BONO overlay (`--c-header` gold / `--c-accent` orange) is unchanged.

**Change 3 — Card position and sub-page lists:** Card overlap was reduced from `clamp(90px, 20dvh, 200px)` to `clamp(50px, 12dvh, 120px)`, moving the cards slightly downward and increasing space below the heading/subtitle. The former paragraph-style sub-page text was replaced by a `SubPageList` component: POS renders a compact `grid-cols-2` × 3-row list (Manager Reports, Cashier Portal, Waiter Portal, Kitchen Display, Barista Display, Jebena Buna); ROOM renders a compact `flex flex-col` vertical list (Reception, Room Management, Room Reports). Each item has a 12px Tabler icon prefix, compact 11px label, consistent alignment and spacing. These are informational spans only — no links or new navigation.

**Change 4 — Single-viewport landing pages:** `PageFrame` gained a `fixed` variant (`lg:h-dvh lg:overflow-y-auto`) used by `LandingShell`, so on normal desktop viewports `/pos` and `/room` occupy exactly one viewport with no page scrolling (smaller screens can still scroll when needed). The landing grid is capped at `max-w-4xl`, heading reduced to `text-lg sm:text-xl`, padding tightened (`pt-16 pb-3 lg:pt-14`), tile padding reduced (`p-2 sm:p-3`), icon wrappers reduced to `h-10 w-10` with `h-7 w-7` icons, and tile text reduced to `text-sm`/`text-[11px]`. Each page keeps its centered heading and gains a short translated subtitle: POS — "Restaurant service and daily operations"; ROOM — "Hotel reception, rooms and reporting". The arrow-only back link and all routes/auth behavior remain intact.

---

## 4. Tests and results

| Command | Result |
|---|---|
| `node --test tests/bono-homepage-layout.test.mjs tests/report-i18n-corrections.test.mjs tests/hot-drink-station.test.mjs` | **44 pass, 0 fail** |
| `node --test tests/*.test.mjs` (full DB-free regression suite) | **2558 pass, 0 fail** |

Focused assertions cover: new card titles with translation keys; solid card backgrounds, accent divider, removed gradient and `opacity-80` image; reduced card overlap; 2×3 icon-prefixed POS grid and vertical ROOM list with all nine labels/icons; fixed desktop viewport frame, compact heading/subtitle and smaller tiles; subtitles present in all three languages; unchanged destination routes, PIN modal, Hotel session layout and back-link label.

---

## 5. ESLint results

`npx eslint app/page.js app/pos/page.js app/room/page.js app/components/HomeNav.jsx lib/translations.js tests/bono-homepage-layout.test.mjs`

**Clean — exit code 0, no findings.**

No build or dev server was started (prohibited by the current safety scope).

---

## 6. Browser verification status

**Not performed.** No browser or dev-server run was used; no visual or scroll-behavior verification is claimed. Owner-side visual confirmation of the single-screen desktop landing pages and the hero divider is recommended.

---

## 7. Any unresolved issues

- No browser verification (§6); the desktop single-viewport fit is implemented via `dvh` sizing and source-level constraints, not measured in a browser.
- Very short desktop viewports use internal `overflow-y-auto` rather than clipping, so a scrollbar may appear there; normal desktop sizes fit without scrolling.
- The pre-existing modification to `public/home/homepage.png` was intentionally left untouched.

---

## 8. Scope confirmation

No backend, API, database, inventory/order/payment/business logic, POS PIN, Hotel session, destination-page, footer, route or navigation-architecture changes. No unrelated translation, color, icon or control changes. No destructive Git command, staging, commit, push, deployment, production access, or secrets/environment-file read occurred.

**STOP — the four requested changes are complete. Do not start another phase.**
