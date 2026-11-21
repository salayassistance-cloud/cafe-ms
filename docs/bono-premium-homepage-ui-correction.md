# BONO — Premium Homepage & Landing Pages UI Correction

**Phase type:** UI refinement for `/`, `/pos`, `/room` and shared controls.
**Status:** Complete. Awaiting owner review. No further phase started.
**Baseline HEAD:** `69650435a6587d4577bc126f719fa1392bb934b3` (branch `main`).

---

## 1. Baseline and ending working-tree status

| Check | Baseline | Ending |
|---|---|---|
| Repository root | `C:/hotelms` | unchanged |
| Branch / HEAD | `main` / `6965043…` | unchanged |
| Status entries | 248 | **251** |
| Modified | 81 | 83 |
| Deleted | 3 | 3 |
| Untracked entries | 164 (405 files) | 165 (406 files) |
| Staged | 0 | 0 |

Baseline matched the final state of `docs/bono-homepage-navigation-separation.md`. All pre-existing modified, untracked and deleted files were preserved; no reset, clean, stash, revert, overwrite or destructive Git command was used.

The three EXTERNAL deletion paths remain deleted and untouched: `app/api/external-items/route.js`, `app/api/external-sales/route.js`, `lib/models/ExternalItemRequest.js`.

Delta: +2 modified files (`LanguageProvider.jsx`, `LanguageToggle.jsx`) and +1 untracked file (this report). All other new/updated files were already present as untracked or modified entries.

---

## 2. Files changed

**Modified:**

- `app/page.js` — homepage text removed; tall centered cards; strengthened hero and responsive overlap; shared frame/controls.
- `app/components/HomeNav.jsx` — added `PageFrame`, `TopControls`, compact `LandingShell`; retained portal catalog/icons/tile styling; text-fit guards.
- `app/components/LanguageProvider.jsx` — language-toggle root-cause fix (single external store).
- `app/components/LanguageToggle.jsx` — selector generated from `SUPPORTED_LANGS` (adds the previously unavailable OM segment), same visual style.
- `tests/bono-homepage-layout.test.mjs` — rewritten as the five-task contract suite (12 tests).
- `app/pos/page.js`, `app/room/page.js` — switched to the compact `LandingShell`; heading block removed; PIN/session logic untouched.

**Added:**

- `docs/bono-premium-homepage-ui-correction.md` — this report.

No API, schema, database, auth/PIN, Hotel session, destination-page or configuration file was modified.

---

## 3. Task-by-task implementation

### Task 1 — Proper device/viewport frame

A single shared `PageFrame` in `app/components/HomeNav.jsx` is now used by all three pages: `min-h-screen` with a `100dvh` inline override (correct mobile browser viewport behavior), `overflow-x-hidden`, and a contained max-width content column with responsive padding. Landing pages vertically center their cards in the available frame with top spacing below the header. Hero and card sizes use `clamp()` with `dvh` units so content fits normal desktop viewports without needless scrolling, while small screens can scroll only when content genuinely requires it. No mockup border or decorative frame was added.

### Task 2 — Homepage text removal and tall premium cards

Removed from the homepage source entirely (not CSS-hidden): "BONO MANAGEMENT SYSTEM", the "Select Your Portal" prompt, and the full `bonoArticle` descriptive paragraph. Only POS and ROOM remain as primary cards. Each card uses a constrained pair width (`max-w-2xl` for the two-card group), a responsive tall minimum height `clamp(300px, 42dvh, 400px)`, larger 40px icon, centered content, and a two-line-clamped subtitle so translated labels cannot resize the card. Cards remain visually equal, centered and aligned.

### Task 3 — Hero image, overlay and card placement

The existing `/home/homepage.png` asset is retained with `fill`/`object-cover`/`object-center`. Hero height is `clamp(280px, 50dvh, 560px)` — approximately the upper half of the viewport. The BONO overlay increased from 20%/12% to 30% (light `--c-header` gold) / 20% (dark `--c-accent` orange) while keeping the image visible. A gradient fades into the clean `--c-bg` lower section. The two cards are centered horizontally and pulled up by `calc(-1 * clamp(90px, 20dvh, 200px))`, placing their midpoint at the hero/lower transition and roughly half of each card above and below it. Controls sit in an absolutely positioned header row above the cards, so they cannot collide. No brittle fixed offsets.

### Task 4 — Language toggle smoothness and consistency

**Root cause (investigated, not assumed):** `LanguageProvider` initialized from `defaultLang` and then applied the persisted `hms_lang` value inside two `setTimeout(…, 0)` callbacks fired from a mount effect, tracked by a `hydrated` flag that was set but never used. This produced (a) a visible flash of Amharic before the saved language arrived, and (b) a race where a fast AM→EN click could be overwritten by the still-pending mount timeout, leaving UI text and `localStorage` out of sync. The homepage additionally had its own separate `useSyncExternalStore` mount gate, so the language flip appeared at different moments on `/` versus `/pos` and `/room`.

**Actual correction:** replaced the deferred bootstraps with one synchronous external store in `LanguageProvider` using `useSyncExternalStore` (`subscribe` + `readPersistedLang` + `getServerLang`). The server and hydration snapshot are both `defaultLang` (no mismatch); after hydration the persisted value is read synchronously. `setLang()` writes to `localStorage` and dispatches a single `bono-language-change` event, so the context value, visible text and selected segment all update in one commit. The dead `hydrated` flag and duplicate local language state are gone; no second state system was introduced. The context value is memoized. `LanguageToggle` is now generated from `SUPPORTED_LANGS`, restoring a control for the previously unselectable OM language while preserving the existing pill styling. All three pages use the same `TopControls` implementation.

### Task 5 — Compact landing-page headers

`LandingShell` no longer accepts a title/description/icon and renders no heading block. The removed content ("Back to Main Homepage" text, "BONO MANAGEMENT SYSTEM", large POS/ROOM heading, the two module description lines) is gone from the landing pages' source. It is replaced by a single arrow-only `<Link href="/">` in `TopControls`, on the same horizontal row as the language and theme controls but on the opposite side. The link has `aria-label` and `title` set to the translated `Back to Main Homepage` label and no visible text. Destination cards are now the visual focus, with generous top spacing beneath the compact header. The six POS and three ROOM destinations, routes, PIN flow and Hotel session linking are unchanged.

---

## 4. Tests and results

| Command | Result |
|---|---|
| `node --test tests/bono-homepage-layout.test.mjs tests/report-i18n-corrections.test.mjs tests/hotel-ui-i18n.test.mjs` | **28 pass, 0 fail** |
| `node --test tests/*.test.mjs` (full DB-free suite) | **2561 pass, 0 fail** (baseline 2557; +4 focused tests) |

The updated contract suite asserts: shared viewport frame on all three pages; homepage text removal; exactly two homepage destinations; tall/centered/proportionally constrained cards; half-viewport hero with stronger theme-aware overlay; responsive half-height card overlap; single-store language provider with no deferred timers or duplicate state; selector built from all supported languages; compact landing headers with no heading block; arrow-only back link with accessible label/tooltip; all six POS and three ROOM routes; and intact PIN/Hotel guard references.

---

## 5. ESLint results

`npx eslint app/page.js app/pos/page.js app/room/page.js app/components/HomeNav.jsx app/components/LanguageProvider.jsx app/components/LanguageToggle.jsx tests/bono-homepage-layout.test.mjs`

**Clean — exit code 0, no findings.**

No build or dev server was started (both can load environment files / touch external services, prohibited by this scope).

---

## 6. Browser verification status

**Not performed.** No browser or dev-server run was used, so no visual/interactive verification is claimed. Verification was source-contract and test based. Owner-side visual review of `/`, `/pos` and `/room` at desktop/tablet/mobile widths and in both themes is recommended, especially for exact card proportions and overlay tone.

---

## 7. Unresolved limitations

- No browser/visual verification (§6); proportions are implemented to the stated targets but not visually measured.
- The homepage retains its existing `useSyncExternalStore` mount gate (loading dots before hydration) — unchanged behavior, kept to avoid a hydration mismatch.
- Footer text is retained; only the three explicitly listed homepage text elements were removed.
- The landing cards use `line-clamp-2` on subtitles to prevent resizing; very long future translations could still truncate.

---

## 8. Confirmation of scope safety

Confirmed:

- No database schema/logic, API or API contract, order/payment/inventory/business logic changes.
- No staff PIN verification or Hotel authentication, session gate/provider or business-logic changes; route protections untouched.
- No destination-page implementation modified; all six POS and three Hotel destination routes reused unchanged.
- No unrelated work reverted/overwritten; three EXTERNAL deletions preserved.
- No destructive Git command, staging, commit or push; no production access, secrets or environment files read; no deployment.

**STOP — this phase is complete. Do not begin another phase.**
