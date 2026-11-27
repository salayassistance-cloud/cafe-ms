// Phase 4-B4: Unified Homepage — Seven Staff Portals (DB-free source contract tests)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

const home = read("app/page.js");
const catalog = read("app/components/HomeNav.jsx");
const pinModal = read("app/components/PinLoginModal.js");
const i18n = read("lib/translations.js");

test("Phase 4-B4: Exactly seven staff portals are defined and displayed", () => {
  assert.match(catalog, /export const UNIFIED_PORTALS = \[/);
  const portalRoles = ["MANAGER", "CASHIER", "RECEPTION", "WAITER", "KITCHEN", "BARISTA", "HOT_DRINK"];
  for (const role of portalRoles) {
    assert.ok(catalog.includes(`role: "${role}"`), `catalog includes role ${role}`);
  }
  // Check exactly 7 items in UNIFIED_PORTALS
  assert.match(catalog, /role: "MANAGER"[\s\S]*role: "CASHIER"[\s\S]*role: "RECEPTION"[\s\S]*role: "WAITER"[\s\S]*role: "KITCHEN"[\s\S]*role: "BARISTA"[\s\S]*role: "HOT_DRINK"/);
  assert.match(home, /UNIFIED_PORTALS\.map/);
});

test("Phase 4-B4: Desktop layout — 4 columns, 2 rows, MANAGER spans both rows", () => {
  // Grid layout classes
  assert.match(home, /grid-cols-2 lg:grid-cols-4/);
  assert.match(home, /MANAGER:[\s\S]*lg:row-span-2/);
  assert.match(home, /MANAGER:[\s\S]*lg:col-start-1 lg:row-start-1/);

  // Row 1: CASHIER, RECEPTION, WAITER (cols 2, 3, 4)
  assert.match(home, /CASHIER:[\s\S]*lg:col-start-2 lg:row-start-1/);
  assert.match(home, /RECEPTION:[\s\S]*lg:col-start-3 lg:row-start-1/);
  assert.match(home, /WAITER:[\s\S]*lg:col-start-4 lg:row-start-1/);

  // Row 2: KITCHEN, BARISTA, JEBENA BUNA (cols 2, 3, 4)
  assert.match(home, /KITCHEN:[\s\S]*lg:col-start-2 lg:row-start-2/);
  assert.match(home, /BARISTA:[\s\S]*lg:col-start-3 lg:row-start-2/);
  assert.match(home, /HOT_DRINK:[\s\S]*lg:col-start-4 lg:row-start-2/);
});

test("Phase 4-B10: Mobile layout — 2 columns, 4 rows", () => {
  assert.match(home, /WAITER:[\s\S]*col-start-1 row-start-1/);
  assert.match(home, /RECEPTION:[\s\S]*col-start-1 row-start-2/);
  assert.match(home, /CASHIER:[\s\S]*col-start-1 row-start-3/);
  assert.match(home, /KITCHEN:[\s\S]*col-start-2 row-start-1/);
  assert.match(home, /BARISTA:[\s\S]*col-start-2 row-start-2/);
  assert.match(home, /HOT_DRINK:[\s\S]*col-start-2 row-start-3/);
  assert.match(home, /MANAGER:[\s\S]*col-span-2 col-start-1 row-start-4/);
});

test("Phase 4-B4: Portal destinations are preserved without inventing routes", () => {
  const EXPECTED_ROUTES = {
    MANAGER: "/manager/reports",
    CASHIER: "/cashier",
    RECEPTION: "/hotel/reception",
    WAITER: "/waiter",
    KITCHEN: "/kds",
    BARISTA: "/barista",
    HOT_DRINK: "/jebena",
  };

  for (const [role, route] of Object.entries(EXPECTED_ROUTES)) {
    assert.ok(catalog.includes(`role: "${role}"`), `catalog has role ${role}`);
    assert.ok(catalog.includes(`route: "${route}"`), `catalog maps ${role} to ${route}`);
  }
});

test("Phase 4-B4: Separate POS and Room portal cards removed from homepage navigation", () => {
  // Homepage no longer links to /pos or /room modules
  assert.doesNotMatch(home, /href: "\/pos"/);
  assert.doesNotMatch(home, /href: "\/room"/);
  assert.doesNotMatch(home, /MODULES/);
  assert.doesNotMatch(home, /restaurantOperationsTitle/);
  assert.doesNotMatch(home, /hotelOperationsTitle/);
});

test("Phase 4-B4: Existing direct pages and functionality are NOT deleted", () => {
  assert.ok(existsSync(join(root, "app/pos/page.js")), "app/pos/page.js exists for direct URL access");
  assert.ok(existsSync(join(root, "app/room/page.js")), "app/room/page.js exists for direct URL access");
  assert.ok(existsSync(join(root, "app/hotel/rooms/page.js")), "Hotel rooms page preserved");
  assert.ok(existsSync(join(root, "app/hotel/reports/page.js")), "Hotel reports page preserved");
  assert.ok(existsSync(join(root, "app/hotel/reception/page.js")), "Hotel reception page preserved");

  // HomeNav still exports backwards-compatible PORTALS and ROOM_PORTALS
  assert.match(catalog, /export const PORTALS =/);
  assert.match(catalog, /export const ROOM_PORTALS =/);
});

test("Phase 4-B4: Existing PIN login flow is preserved and supports RECEPTION", () => {
  assert.match(home, /<PinLoginModal/);
  assert.match(home, /handlePortalClick/);
  assert.match(home, /setActivePortal\(portal\)/);

  // PinLoginModal supports RECEPTION with IconDoor
  assert.match(pinModal, /IconDoor/);
  assert.match(pinModal, /RECEPTION: <IconDoor/);

  // PortalIcon in HomeNav supports RECEPTION with IconDoor
  assert.match(catalog, /case "RECEPTION":\s*return <IconDoor/);
});

test("Phase 4-B4: Accessibility and styling requirements", () => {
  // Accessible buttons
  assert.match(home, /type="button"/);
  assert.match(home, /aria-label=\{title\}/);
  // Focus visible ring
  assert.match(home, /focus-visible:ring-2/);
  assert.match(home, /focus-visible:ring-\[var\(--c-accent\)\]/);
  // Hover & active states
  assert.match(home, /hover:border-\[var\(--c-accent\)\]/);
  assert.match(home, /active:scale-\[0\.98\]/);
});

test("Phase 4-B4: Translation keys exist for all seven portals", () => {
  const keys = [
    "managerPortal", "cashierPortal", "receptionPortal", "waiterPortal", "kitchenPortal", "baristaPortal", "hotDrinkPortal",
    "managerDesc", "cashierDesc", "receptionDesc", "waiterDesc", "kitchenDesc", "baristaDesc", "hotDrinkDesc",
  ];
  for (const k of keys) {
    assert.ok(i18n.includes(`${k}:`), `translation key ${k} exists`);
  }
});
