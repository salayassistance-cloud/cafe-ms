# BONO — Homepage UI Layout Refinement (POS / ROOM)

**Phase type:** Homepage layout / UI refinement only.
**Status:** Complete. Awaiting owner review before any backend optimization or security remediation.
**Baseline HEAD:** `69650435a6587d4577bc126f719fa1392bb934b3` (branch `main`).

---

## 1. Preflight baseline

| Check | Before this phase |
|---|---|
| Repository root | `C:/hotelms` (confirmed) |
| Branch | `main` |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` |
| Status entries | 242 = 81 modified + 3 deleted + 158 untracked entries (399 untracked files) |
| Staged | 0 |
| Commits ahead of `origin/main` | 0 |

This starting tree exactly matched the final state recorded in `docs/hotel-session-regression-fix.md`. All pre-existing modified, untracked and deleted files were preserved; nothing was reset, cleaned, stashed, reverted, overwritten or discarded.

**Three EXTERNAL deletion paths confirmed intact before and after** (still `D`, not restored):

- `app/api/external-items/route.js`
- `app/api/external-sales/route.js`
- `lib/models/ExternalItemRequest.js`

Also inspected: `app/page.js`, `app/layout.js`, `app/globals.css`, `app/components/PinLoginModal.js`, `app/components/LanguageToggle.jsx`, `app/components/ThemeToggleHome.jsx`, `lib/translations.js`, `app/hotel/layout.js`, `app/components/hotel/HotelSessionGate.jsx`, `app/components/hotel/HotelSessionProvider.jsx`, `public/home/homepage.png`, `next.config.mjs`, `package.json`, `tests/hot-drink-station.test.mjs`, `docs/hotel-session-loading-performance-remediation.md`, `docs/hotel-session-regression-fix.md`.

Per `AGENTS.md`, the bundled Next.js 16.3.1 guides `01-app/02-guides/ai-agents.md` and `01-app/01-getting-started/12-images.md` were read before writing code.

**Reference limitation:** no image file was actually attached to this conversation. The implementation therefore follows the *textual* composition description (large image-backed upper area, floating containers overlapping a clean lower section) and copies no AccessElite branding, colors, typography or content.

---

## 2. Layout structure implemented

The homepage is now a single vertical composition with two clearly divided horizontal regions:

1. **Upper (image-backed) section** — full width, ~38vh mobile / 42vh tablet / 48vh desktop with sensible minimum heights; carries the existing BONO image, the BONO-colored overlay, the brand headline, and the existing language/theme controls.
2. **Lower (clean) section** — full-width BONO background (`--c-bg`) that the two module cards overlap via a negative top margin (`-mt-10 sm:-mt-12 lg:-mt-16`).

The two floating module containers are the only primary cards on the page:

- `POS`
- `ROOM`

The previous two-column "intro left / portal grid right" arrangement, the mobile yellow header bar and the desktop left-column article were consolidated into this structure. The existing `bonoArticle` copy is retained in the lower section on desktop; the footer and `PinLoginModal` are unchanged.

---

## 3. Background image and overlay implementation

- **Image:** the already-present BONO asset `public/home/homepage.png` (alt "Hotel and café"), previously used by this homepage at native 1774×887. Rendered with `next/image` using `fill`, `priority`, `sizes="100vw"` and `object-cover object-center` inside a `relative` section, so it covers the upper portion without distortion. **No new or stock image was introduced** and the existing file was not replaced.
- **Overlay:** a low-opacity tint of existing BONO tokens only — `--c-header` (gold) at 20% in light mode, `--c-accent` (orange) at 12% in dark mode. The image remains visible beneath it.
- **Transition:** a bottom gradient from `transparent` to `var(--c-bg)` fades the image into the clean lower section, producing the intentional horizontal split.
- The brand headline uses existing `--c-text` / `--c-muted` tokens and a light `drop-shadow-sm` for readability; the existing language and theme toggles sit above the overlay (`z-10`).

No reference purple/pink colors were used; the palette is unchanged (`globals.css` was not modified).

---

## 4. Existing BONO colors/style preservation

Preserved without change: CSS custom properties and theme tokens, light/dark themes, Geist local font, `card-elevated` / `tactile` utilities, Tabler icon family, i18n structure, route names, auth flows, and all existing image assets.

`app/globals.css`, `app/layout.js`, `app/components/PinLoginModal.js`, the theme/language providers, and all Hotel/POS source files were left untouched. New labels were added as ordinary keys in all three existing language blocks (`am`, `en`, `om`) of `lib/translations.js`, using the established `t(key)` + fallback pattern.

---

## 5. POS and ROOM container implementation

**POS** — existing destinations, routes, icons, PIN modal navigation and authorization are unchanged:

| Destination | Route | Existing icon |
|---|---|---|
| Manager Reports | `/manager/reports` | `IconDashboardFilled` |
| Cashier | `/cashier` | `IconCashRegister` |
| Waiter | `/waiter` | `IconReceiptFilled` |
| Kitchen | `/kds` | `IconChefHatFilled` |
| Barista | `/barista` | `IconMugFilled` |
| Jebena Buna | `/jebena` | `IconCoffee` |

**ROOM** — three destinations using the existing Hotel routes and existing Tabler icon family:

| Destination | Route | Icon |
|---|---|---|
| Reception | `/hotel/reception` | `IconDoor` |
| Room Management | `/hotel/rooms` | `IconBedFilled` |
| Room Reports | `/hotel/reports` | `IconClipboardListFilled` |

ROOM tiles are `next/link` `<Link>` components (the same client-navigation mechanism already used by the Hotel UI). They deliberately do **not** use the POS PIN modal. Entering `/hotel/*` goes through the unchanged `app/hotel/layout.js` server-side `getHotelServerSession()` gate and `HotelSessionGate`; subsequent navigation between Hotel sub-pages keeps that layout and `HotelSessionProvider` mounted, so the previously fixed repeated session-loading problem is not reintroduced. No `/api/hotel/auth/me` bootstrap or loading screen was added.

Cards share the same `card-elevated` surface, padding scale, rounded corners, header treatment and tile component; balanced equal heights via `items-stretch` + `flex-1` grids. No third module container was added.

---

## 6. Exact files changed

**Modified:**

- `app/page.js` — two-module homepage layout, background/overlay composition, ROOM links, room labels wiring.
- `lib/translations.js` — 8 new keys in each of `am`, `en`, `om`: `posModuleDesc`, `roomModuleDesc`, `receptionPortal`, `receptionDesc`, `roomsPortal`, `roomsDesc`, `roomReportsPortal`, `roomReportsDesc`.

**Added:**

- `tests/bono-homepage-layout.test.mjs` — DB-free/DOM-free source-contract regression tests for the two-module layout, preserved routes/assets, BONO token usage, Hotel session isolation and i18n key parity.
- `docs/bono-homepage-layout-refinement.md` — this report.

No other file was created, modified or deleted.

---

## 7. Routes preserved

All pre-existing homepage destinations remain on their exact routes: `/manager/reports`, `/cashier`, `/waiter`, `/kds`, `/barista`, `/jebena` (plus the retained `/menu` history-replace branch). ROOM uses only the three valid existing Hotel routes verified in the regression report: `/hotel/reception`, `/hotel/rooms`, `/hotel/reports`. No fake, invented, singular (`/hotel/report`) or root (`/hotel`) destinations were added. No route files, middleware/proxy, layout gating or business logic were changed.

---

## 8. Responsive verification

Source-level responsive structure (no browser run — see §9):

- **Desktop (`md`/`lg` ≥ 768px):** two module cards side by side (`md:grid-cols-2`, `lg:gap-8`), equal height, overlapping the background transition. POS tiles form 2 columns × 3 rows; ROOM tiles form one stretched row of 3.
- **Tablet (`sm` ≥ 640px):** hero grows to 42vh; card padding/gaps scale; ROOM switches from 1 to 3 columns; grid remains two cards at `md`.
- **Mobile (< 640px):** cards stack vertically (`grid-cols-1`); POS tiles are 2 columns and ROOM tiles are a single column; all destinations remain visible. Root has `overflow-x-hidden`, tiles use `w-full`/`min-w-0` behavior via grid, and no fixed widths were introduced, avoiding horizontal overflow and clipping.
- **Dark/light:** overlay, fade, card surfaces, icons and text all resolve through existing theme tokens; the existing `ThemeToggleHome` remains available in the hero.

---

## 9. Browser verification

**Not performed.** Starting the Next dev server or a build would automatically load local environment files (`.env.local`) and could connect to databases, which this phase explicitly prohibits ("Read secrets or environment files", "Access production DBs"). No browser automation tool was used, and no claim of visual/browser verification is made. Verification was source-contract and test based; an owner-side visual check at desktop/tablet/mobile widths in both themes is recommended.

---

## 10. Tests and results

| Command | Result |
|---|---|
| `npx eslint app/page.js lib/translations.js tests/bono-homepage-layout.test.mjs` | clean, no findings |
| `node --test tests/bono-homepage-layout.test.mjs` | 6 pass, 0 fail |
| `node --test tests/hot-drink-station.test.mjs tests/hotel-session-loading-performance.test.mjs tests/hotel-rooms-ui.test.mjs tests/hotel-room-reports-ui.test.mjs tests/hotel-reception-login-ui.test.mjs` | 95 pass, 0 fail |
| `node --test tests/bono-homepage-layout.test.mjs tests/hot-drink-station.test.mjs` (final re-check) | 34 pass, 0 fail |
| `node --test tests/*.test.mjs` (full DB-free suite) | **2555 pass, 0 fail** (baseline was 2549; +6 new tests) |

The new tests assert: exactly two module cards, all POS routes and PIN modal retained, only the three valid Hotel routes via `next/link`, the existing homepage image reused with `fill`, BONO token usage with no external image URL, the unchanged Hotel server layout/provider/gate and no client `auth/me` bootstrap, and translation-key parity across all three languages.

No `next build` was run (it can load environment files / perform static DB access, prohibited here).

---

## 11. Remaining issues

- No browser/visual verification (§9) — layout correctness is source-based only.
- The uploaded visual reference was not present as an accessible image in this session; composition follows the written description. If the owner supplies the actual image, a visual fidelity pass can be done in a later approved phase.
- Hotel ROOM tiles go through the existing sign-in gate on first entry (owned by `app/hotel/layout.js`); this is existing behavior, not a regression.
- Amharic/Oromo strings for the new labels are plain translations of the English copy; owner review of wording is welcome.

---

## 12. Final working-tree status and baseline delta

- Root `C:/hotelms`, branch `main`, HEAD `69650435a6587d4577bc126f719fa1392bb934b3` (unchanged).
- Phase start: **242 entries = 81 modified + 3 deleted + 158 untracked entries (399 files), 0 staged**.
- Final: **244 entries = 81 modified + 3 deleted + 160 untracked entries (401 files), 0 staged**.
- **Delta:** +2 status entries / +2 untracked entries / +2 untracked files — fully explained by `tests/bono-homepage-layout.test.mjs` and this report. The two modified files were already in the working tree, so modified/deleted counts are unchanged. No staged changes and no commits.
- All pre-existing user work, including the three EXTERNAL deletions, is preserved exactly.

---

## 13. Confirmation — no prohibited operations

Confirmed:

- No POS or Hotel business logic changed; no APIs, database schemas, indexes, migrations, backfills, seeds or database writes; no database merging or access of any kind.
- No production/staging access and no secrets or environment files read.
- No deployment or infrastructure change.
- No Git staging, commit, push, reset, clean, stash, checkout or revert.
- No SEC-01 remediation or backend optimization started.

**STOP — this phase is complete. Await owner review before proceeding.**
