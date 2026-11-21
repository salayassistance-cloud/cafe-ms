// BONO strictly-scoped 4-item UI correction — DB-free source contract tests.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

const home = read("app/page.js");
const catalog = read("app/components/HomeNav.jsx");
const posPage = read("app/pos/page.js");
const roomPage = read("app/room/page.js");
const i18n = read("lib/translations.js");
const hotelLayout = read("app/hotel/layout.js");

const POS_ROUTES = ["/manager/reports", "/cashier", "/waiter", "/kds", "/barista", "/jebena"];
const HOTEL_ROUTES = ["/hotel/reception", "/hotel/rooms", "/hotel/reports"];

// --- Change 1 ---

test("homepage primary cards use the new professional titles", () => {
  assert.match(home, /titleKey: "restaurantOperationsTitle"/);
  assert.match(home, /fallbackTitle: "Restaurant Operations"/);
  assert.match(home, /titleKey: "hotelOperationsTitle"/);
  assert.match(home, /fallbackTitle: "Hotel Operations"/);
  assert.doesNotMatch(home, /title: "POS"|title: "ROOM"/);
  assert.equal((i18n.match(/restaurantOperationsTitle:/g) || []).length, 3);
  assert.equal((i18n.match(/hotelOperationsTitle:/g) || []).length, 3);
});

// --- Change 2 ---

test("primary cards have solid backgrounds and a clear background divider", () => {
  assert.match(home, /border border-\[var\(--c-border\)\] bg-\[var\(--c-card\)\]/);
  assert.match(home, /border-b-2 border-\[var\(--c-accent\)\]/);
  assert.doesNotMatch(home, /linear-gradient/, "blended fade removed");
  assert.match(home, /src="\/home\/homepage\.png"/, "existing image asset kept");
});

test("upper image treatment is reduced and theme-aware overlay retained", () => {
  assert.match(home, /object-cover object-center opacity-80/);
  assert.match(home, /bg-\[var\(--c-header\)\] opacity-30/);
  assert.match(home, /dark:bg-\[var\(--c-accent\)\] dark:opacity-20/);
});

// --- Change 3 ---

test("cards moved down with more space beneath the heading area", () => {
  assert.match(home, /marginTop: "calc\(-1 \* clamp\(50px, 12dvh, 120px\)\)"/);
  assert.doesNotMatch(home, /clamp\(90px, 20dvh, 200px\)/);
});

test("POS sub-pages render as a compact icon-prefixed 2x3 grid", () => {
  assert.match(home, /function SubPageList/);
  assert.match(home, /grid grid-cols-2 gap-x-3 gap-y-2/);
  assert.match(home, /size=\{12\}/);
  for (const label of [
    "Manager Reports",
    "Cashier Portal",
    "Waiter Portal",
    "Kitchen Display",
    "Barista Display",
    "Jebena Buna",
  ]) {
    assert.ok(home.includes(`label: "${label}"`), `POS item ${label}`);
  }
  for (const icon of [
    "IconFileAnalytics",
    "IconCashRegister",
    "IconReceiptFilled",
    "IconChefHatFilled",
    "IconMugFilled",
    "IconCoffee",
  ]) {
    assert.ok(home.includes(icon), `POS icon ${icon}`);
  }
});

test("ROOM sub-pages render as a compact icon-prefixed vertical list", () => {
  assert.match(home, /flex flex-col gap-2/);
  for (const label of ["Reception", "Room Management", "Room Reports"]) {
    assert.ok(home.includes(`label: "${label}"`), `ROOM item ${label}`);
  }
  for (const icon of ["IconDoor", "IconBedFilled", "IconClipboardListFilled"]) {
    assert.ok(home.includes(icon), `ROOM icon ${icon}`);
  }
  assert.doesNotMatch(home, /line-clamp-4/);
  for (const route of [...POS_ROUTES, ...HOTEL_ROUTES]) {
    assert.ok(!home.includes(`"${route}"`), `no sub-page route ${route} on homepage`);
  }
  assert.equal((home.match(/href: "\//g) || []).length, 2, "only two primary cards");
});

// --- Change 4 ---

test("landing pages are constrained to one desktop viewport", () => {
  assert.match(catalog, /export function PageFrame\(\{ children, fixed = false \}\)/);
  assert.match(catalog, /lg:h-dvh lg:overflow-y-auto/);
  assert.match(catalog, /<PageFrame fixed>/);
  assert.match(catalog, /max-w-4xl/);
  assert.match(catalog, /pt-16 pb-3 lg:pt-14/);
  assert.match(catalog, /aspect-square w-full/);
  assert.match(catalog, /p-2 text-center bg-\[var\(--c-card\)\] overflow-hidden sm:p-3/);
  assert.match(posPage, /POS_TILE_CLASS/, "pos uses its compact rectangular tiles");
  assert.match(roomPage, /LANDING_TILE_CLASS/, "room keeps its square tiles");
  for (const [name, page] of [["pos", posPage], ["room", roomPage]]) {
    assert.match(page, /h-10 w-10 items-center justify-center mb-2/, `${name} smaller icons`);
    assert.match(page, /text-sm font-bold/, `${name} smaller labels`);
  }
});

test("landing subtitles are added via the translation structure", () => {
  assert.match(catalog, /LandingShell\(\{ heading, subtitle, children \}\)/);
  assert.match(catalog, /mb-4 text-center text-xs/);
  assert.match(posPage, /posLandingSubtitle/);
  assert.match(posPage, /Restaurant service and daily operations/);
  assert.match(roomPage, /roomLandingSubtitle/);
  assert.match(roomPage, /Hotel reception, rooms and reporting/);
  assert.match(posPage, /<LandingShell\s+heading="POS"/);
  assert.match(roomPage, /<LandingShell\s+heading="ROOM"/);
  assert.equal((i18n.match(/posLandingSubtitle:/g) || []).length, 3);
  assert.equal((i18n.match(/roomLandingSubtitle:/g) || []).length, 3);
});

// --- Preserved navigation / auth ---

test("routes, PIN flow and Hotel session architecture are unchanged", () => {
  for (const route of POS_ROUTES) assert.ok(catalog.includes(`route: "${route}"`), route);
  for (const route of HOTEL_ROUTES) assert.ok(catalog.includes(`route: "${route}"`), route);
  assert.match(home, /href: "\/pos"/);
  assert.match(home, /href: "\/room"/);
  assert.match(posPage, /PORTALS\.map/);
  assert.match(roomPage, /ROOM_PORTALS\.map/);
  assert.match(posPage, /<PinLoginModal/);
  assert.match(posPage, /handlePortalClick/);
  assert.doesNotMatch(roomPage, /PinLoginModal/);
  assert.match(hotelLayout, /getHotelServerSession\(\)/);
  assert.match(hotelLayout, /<HotelSessionProvider session=\{result\.session\}>/);
  assert.match(catalog, /aria-label=\{t\("backToHome"\)\}/);
  assert.doesNotMatch(home, /selectPortal|bonoArticle/, "old homepage text stays removed");
});
