// BONO Homepage & Staff Portals Layout — DB-free source contract tests.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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

// --- Unified Homepage ---

test("homepage displays the unified seven staff portals", () => {
  assert.match(home, /UNIFIED_PORTALS\.map/);
  assert.match(home, /grid-cols-2 lg:grid-cols-4/);
  assert.match(home, /Avenue Hotel Management System/);
  assert.doesNotMatch(home, /href: "\/pos"/);
  assert.doesNotMatch(home, /href: "\/room"/);
});

test("homepage desktop grid has 4 columns and 2 rows with MANAGER spanning both rows", () => {
  assert.match(home, /MANAGER:[\s\S]*lg:row-span-2/);
  assert.match(home, /MANAGER:[\s\S]*lg:col-start-1 lg:row-start-1/);
  assert.match(home, /CASHIER:[\s\S]*lg:col-start-2 lg:row-start-1/);
  assert.match(home, /RECEPTION:[\s\S]*lg:col-start-3 lg:row-start-1/);
  assert.match(home, /WAITER:[\s\S]*lg:col-start-4 lg:row-start-1/);
  assert.match(home, /KITCHEN:[\s\S]*lg:col-start-2 lg:row-start-2/);
  assert.match(home, /BARISTA:[\s\S]*lg:col-start-3 lg:row-start-2/);
  assert.match(home, /HOT_DRINK:[\s\S]*lg:col-start-4 lg:row-start-2/);
});

// --- Landing pages & direct access preserved ---

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

test("routes, PIN flow and Hotel layout gate are wired", () => {
  for (const route of POS_ROUTES) assert.ok(catalog.includes(`route: "${route}"`), route);
  for (const route of HOTEL_ROUTES) assert.ok(catalog.includes(`route: "${route}"`), route);
  assert.match(posPage, /PORTALS\.map/);
  assert.match(roomPage, /ROOM_PORTALS\.map/);
  assert.match(posPage, /<PinLoginModal/);
  assert.match(posPage, /handlePortalClick/);
  assert.match(home, /<PinLoginModal/);
  assert.match(home, /handlePortalClick/);
  assert.match(hotelLayout, /getLiveSessionFromCookies\(store,\s*\[\s*"MANAGER",\s*"RECEPTION",?\s*\]\)/);
  assert.match(hotelLayout, /<PinGuard role="RECEPTION"/);
  assert.match(catalog, /aria-label=\{t\("backToHome"\)\}/);
  assert.doesNotMatch(home, /selectPortal|bonoArticle/, "old homepage text stays removed");
});
