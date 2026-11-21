# BONO — Strictly Scoped UI Correction (5 Items)

**Phase type:** Five explicitly authorized UI changes only.
**Status:** Complete. Awaiting owner review. No further phase started.
**Baseline HEAD:** `69650435a6587d4577bc126f719fa1392bb934b3` (branch `main`).

---

## 1. Baseline and ending working-tree status

| Check | Baseline | Ending |
|---|---|---|
| Repository root | `C:/hotelms` | unchanged |
| Branch / HEAD | `main` / `6965043…` | unchanged |
| Status entries | 251 | **253** |
| Modified | 83 | 84 |
| Deleted | 3 | 3 |
| Untracked entries | 165 (406 files) | 166 (407 files) |
| Staged | 0 | 0 |

Baseline matched the final state of `docs/bono-premium-homepage-ui-correction.md`. All unrelated modified/untracked work was preserved; no reset, clean, stash, revert, overwrite or destructive Git command was used.

The three EXTERNAL deletion paths remain deleted and untouched: `app/api/external-items/route.js`, `app/api/external-sales/route.js`, `lib/models/ExternalItemRequest.js`.

Delta: +1 modified (`ThemeToggleHome.jsx`, previously clean) and +1 untracked file (this report). Other changed files were already modified/untracked entries.

---

## 2. Exact files changed

**Modified:**

- `app/components/LanguageToggle.jsx` — Change 1 (AM/EN only) and Change 4 (smaller toggle).
- `app/components/HomeNav.jsx` — Change 2 (page-wide top-right control row), Change 4 (smaller arrow), Change 5 (square landing tiles + small centered heading).
- `app/page.js` — Change 3 (card gap/height + informational sub-page labels) and Change 4 (heading, two-line subtitle, reduced card/icon sizes).
- `app/pos/page.js`, `app/room/page.js` — Change 5 (square tiles, `heading` prop, no other changes).
- `app/components/ThemeToggleHome.jsx` — Change 4 (smaller theme control).
- `lib/translations.js` — Change 4 only: two new subtitle keys in `am`, `en`, `om`; no existing translation altered or removed.
- `tests/bono-homepage-layout.test.mjs` — focused contract tests updated for the five changes.

**Added:** `docs/bono-strict-ui-correction-5-items.md` (this report).

No other file was touched.

---

## 3. Confirmation of each change

**Change 1 — Remove Oromo toggle option:** `LanguageToggle` now builds its two segments from a local `TOGGLE_LANGS = ["am", "en"]`; the OM label/import and `SUPPORTED_LANGS.map` usage were removed. Oromo translation data in `lib/translations.js` is untouched and no other UI/functionality changed. The provider, persistence key (`hms_lang`) and `setLang` behavior are unchanged.

**Change 2 — Controls top-right:** The shared `TopControls` header row is now page-wide (`absolute inset-x-0 top-0 … justify-between`) instead of constrained by `max-w-6xl`, placing the language and theme toggles together at the upper-right corner of the page. Styles, colors, icons and behavior unchanged. On landing pages the arrow-only back link remains on the opposite (left) side of the same row.

**Change 3 — Homepage cards:** Horizontal gap increased (`gap-10 sm:gap-12`) on a narrower `max-w-xl` pair; card minimum height raised to `clamp(310px, 44dvh, 420px)` while absolute card width/padding/icon size were reduced per Change 4, keeping both cards equal and aligned. Added a small secondary informational line under each title listing the category sub-pages: POS — "Manager Reports · Cashier Portal · Waiter Portal · Kitchen Display · Barista Display · Jebena Buna"; ROOM — "Reception · Room Management · Room Reports". It uses muted `--c-faint` 10px text, wraps responsively and contains **no links**.

**Change 4 — Heading, subtitle and reduced sizes:** Added the top-centered heading "Avenue Hotel Management System" and a two-line subtitle using two new translation keys (`homeSubtitleLine1`/`homeSubtitleLine2`) in all three languages. Reduced: homepage card padding (`p-5 sm:p-6`), icon container (`h-14 w-14`, 36px icon) and title (`text-xl`); language toggle (`h-9`, smaller segments); theme toggle (`h-9 w-9`, 16px icons); back arrow (`h-9 w-9`, 18px icon). No colors, icons, routes or background/overlay implementation changed.

**Change 5 — Landing pages:** Added `LANDING_TILE_CLASS` with `aspect-square` and applied it to all six POS and three ROOM tiles; gaps remain consistent and layouts stay responsive (2→3 columns POS, 1→3 columns ROOM). `LandingShell` now accepts a `heading` prop and renders a small top-centered `<h1>` (`text-xl sm:text-2xl`, `mb-6`) above the grid. The arrow-only back link, its accessible label/tooltip, and the absence of the removed descriptive header text are all preserved.

---

## 4. Tests and results

| Command | Result |
|---|---|
| `node --test tests/bono-homepage-layout.test.mjs tests/report-i18n-corrections.test.mjs tests/hot-drink-station.test.mjs` | **44 pass, 0 fail** |
| `node --test tests/*.test.mjs` (full DB-free regression suite) | **2558 pass, 0 fail** |

The focused suite verifies: only AM/EN toggle options with no OM label; provider persistence unchanged; page-wide top-right control row; increased gap/height and equal cards; informational sub-page names with no sub-page routes on `/`; heading and two-line subtitle with translation parity; reduced control/card sizes; square landing tiles with consistent gaps and responsive columns; centered headings with no back text; unchanged destination routes, PIN modal and Hotel session layout; unchanged image and overlay token.

The full suite count decreased from 2561 to 2558 solely because the rewritten focused suite has 9 tests instead of 12; no existing test failed or was removed outside that file.

---

## 5. ESLint results

`npx eslint app/page.js app/pos/page.js app/room/page.js app/components/HomeNav.jsx app/components/LanguageToggle.jsx app/components/ThemeToggleHome.jsx lib/translations.js tests/bono-homepage-layout.test.mjs`

**Clean — exit code 0, no findings.**

No build or dev server was started (prohibited by the current safety scope).

---

## 6. Browser verification status

**Not performed.** No browser or dev-server run was used; no visual/interactive verification is claimed. Owner-side visual review of the three pages is recommended for final proportion confirmation.

---

## 7. Any unresolved issue

- No browser verification (§6).
- A user with a previously persisted `om` preference will still see Oromo text from the provider until they choose AM or EN; the Oromo option itself is no longer present or selectable in the toggle. Translation data was intentionally left intact per strict scope.

---

## 8. Scope confirmation

No changes to backend, APIs, databases, orders/payments/inventory/business logic, POS PIN authentication, Hotel session handling, destination pages, footer, background image or overlay implementation. No unrelated translations changed. No destructive Git command, staging, commit, push, deployment, production access or secrets/environment-file read occurred.

**STOP — the five requested changes are complete. Do not start another phase.**
