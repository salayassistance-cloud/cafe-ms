# BONO — Strict UI Correction (3 Requested Items Only)

## Scope statement

Only the three authorized UI corrections were made. No routes, authentication,
PIN logic, session architecture, APIs, business logic, theme/language systems,
or unrelated components were changed. POS authentication and the POS login UI
itself were not modified.

---

## Baseline and ending working-tree status

Baseline captured before edits (`git status --porcelain`): **257**
modified/deleted/untracked entries, on branch `main` at HEAD
`6965043 Complete Bono UI and reporting updates`.

Ending status: **258** entries. The only new status entry is:

```
=> ?? tests/bono-ui-correction-three-items.test.mjs
```

All other pre-existing modifications and untracked files were preserved. No
staging, commits, pushes, destructive Git operations, database/index/schema
changes, `.env`/secret reads, deployments, or production access occurred. The
three pre-existing EXTERNAL deletion paths were untouched.

---

## Exact files changed

Modified:

1. `app/components/hotel/HotelPinLogin.jsx`
2. `app/components/hotel/HotelSessionGate.jsx`
3. `lib/hotel/uiTranslations.js`
4. `app/pos/page.js`
5. `app/page.js`
6. `tests/bono-homepage-layout.test.mjs` (only the POS tile assertion)
7. `tests/hotel-unified-pin-auth.test.mjs` (only the keypad-button assertion)

Added:

8. `tests/bono-ui-correction-three-items.test.mjs`
9. `docs/bono-ui-correction-three-items.md` (this report)

---

## Task 1 — Hotel PIN login modal UI refinement

**Floating modal + blurred/dimmed background.** `HotelPinLogin` now uses the POS
Manager Reports modal overlay classes verbatim where reusable:
`fixed inset-0 z-[100] flex items-center justify-center`,
`bg-[#1E293B]/30 dark:bg-[#12131A]/70`, `backdrop-blur-md`, and a centered
`max-w-[360px] rounded-2xl border ... bg-white dark:bg-[#1C1D24] p-6 shadow-[...]`
card. It no longer fills the screen with an opaque background.

**Generic title removed.** The visible "Hotel sign in" heading and its now-unused
`login.pinTitle` translation keys were removed. No replacement generic title was
added.

**Destination identity.** The modal header now shows, centered:
- Reception → `IconDoor`, **Reception**
- Room Management → `IconBedFilled`, **Room Management**
- Room Reports → `IconClipboardListFilled`, **Room Reports**

with `Enter your 4-digit PIN` directly beneath, using the POS modal's heading
and subtitle typography/spacing. `HotelSessionGate` derives only the *display*
destination from `usePathname()` and passes it as a prop; the existing `role`
prop, PIN endpoint, payload, and verification behavior are unchanged. New
localized keys (`login.destinationReception`, `login.destinationRooms`,
`login.destinationReports`) were added to both English and Amharic dictionaries.

**Keypad.** The shared `app/components/PinKeypad.js` is still used, now with
`hideSubmit` plus the same full-width BONO Verify button used by the POS modal.
No username, no password, no new keypad implementation.

The language and theme toggles remain available at the overlay's top-right so
language/theme functionality is preserved; they do not alter the modal card.

---

## Task 2 — POS landing page card size and spacing

In `app/pos/page.js` only, a scoped `POS_TILE_CLASS` replaces the shared square
tile class: fixed compact rectangular heights (`h-[104px]`, `sm:h-[116px]`)
instead of `aspect-square`, with unchanged icons, labels, descriptions, colors,
and `PORTALS` data. The grid now uses explicit horizontal and vertical gaps
(`gap-x-4 gap-y-5 sm:gap-x-5 sm:gap-y-6`) while keeping the balanced
`grid-cols-2 lg:grid-cols-3` responsive layout.

`app/components/HomeNav.jsx` and `app/room/page.js` were not changed, so the ROOM
landing page keeps its existing square tiles. Routes and `PinLoginModal` flow
are untouched.

---

## Task 3 — Main homepage card spacing and icon transparency

In `app/page.js`:

- `SubPageList` now starts at `mt-7` instead of `mt-3`, clearly separating each
  card's heading/description from its informational sub-page list. Both cards
  use the same value, so they stay aligned. List structure, icon prefixes,
  labels, and grid arrangement are unchanged.
- The primary POS/Hotel icon container's `bg-[var(--c-badge-bg)]` fill was
  replaced with `bg-transparent`. The icon component, color
  (`text-[var(--c-accent)]`), size, and position are unchanged, and the primary
  card background (`bg-[var(--c-card)]`) remains.

---

## Tests and results

New DB-free source-contract suite `tests/bono-ui-correction-three-items.test.mjs`
covers: modal overlay/blur/proportions, absence of the generic heading, all three
destination icon/name mappings and PIN instruction, unchanged role/PIN endpoint
and keypad, POS compact rectangles and gaps with unchanged data/flow, homepage
header/list spacing, transparent icon background, and preserved labels/routes.

Two existing focused assertions were updated to follow the intentional changes
(POS now uses its scoped tile class; the Hotel keypad uses the POS-style separate
Verify button).

Results:

```
Focused run: 52 tests, 52 pass, 0 fail
Full DB-free suite (node --test tests/*.test.mjs, --test-reporter=tap):
             2587 tests, 2587 pass, 0 fail, 0 skipped
```

---

## ESLint results

`npx eslint` on all changed/new files: **0 errors, 0 warnings**.

---

## Browser verification status

Not performed. A dev/build server was deliberately not started because the
safety scope forbids risking access to environment variables, databases, or
external services. Verification is limited to DB-free source-contract tests and
ESLint.

---

## Unresolved issues

None known. The only deliberate deviation from the POS modal is that the Hotel
gate's language/theme toggles remain visible at the overlay's top-right (the POS
landing page keeps its toggles behind the blur) so language and theme controls
are not lost on the Hotel sign-in screen.
