// Strict three-item UI correction — DB-free source contract tests.
// No browser, database, network, or POS authentication module is involved.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const pos = read("app/pos/page.js");
const home = read("app/page.js");
const room = read("app/room/page.js");
const catalog = read("app/components/HomeNav.jsx");

describe("Task 2 — /pos card size and spacing", () => {
  test("pos cards are compact rectangles scoped to /pos", () => {
    assert.match(pos, /const POS_TILE_CLASS =/);
    assert.match(pos, /h-\[104px\] w-full/);
    assert.match(pos, /sm:h-\[116px\]/);
    assert.doesNotMatch(pos, /aspect-square/);
    assert.ok(!pos.includes("LANDING_TILE_CLASS"));
  });

  test("explicit horizontal and vertical gaps separate the cards", () => {
    assert.match(pos, /grid grid-cols-2 gap-x-4 gap-y-5/);
    assert.match(pos, /sm:gap-x-5 sm:gap-y-6 lg:grid-cols-3/);
  });

  test("icons, labels, destination data and login flow remain intact", () => {
    assert.match(pos, /PORTALS\.map/);
    assert.match(pos, /<PinLoginModal/);
    assert.match(pos, /<PortalIcon role=\{portal\.role\} \/>/);
    assert.match(pos, /text-sm font-bold/);
    assert.match(pos, /line-clamp-2 text-\[11px\]/);
    assert.match(catalog, /aspect-square w-full/);
    assert.match(room, /LANDING_TILE_CLASS/);
  });
});

describe("Task 3 — homepage card spacing and icon background", () => {
  test("sub-page list is separated from the card heading area", () => {
    assert.match(home, /className=\{`mt-7 w-full \$\{/);
    assert.doesNotMatch(home, /className=\{`mt-3 w-full \$\{/);
  });

  test("primary card icon container background is transparent", () => {
    assert.match(
      home,
      /h-14 w-14 items-center justify-center rounded-2xl bg-transparent text-\[var\(--c-accent\)\]/
    );
    assert.doesNotMatch(home, /bg-\[var\(--c-badge-bg\)\]/);
    assert.match(home, /<Icon size=\{36\} stroke=\{1\.5\} aria-hidden="true" \/>/);
  });

  test("card structure, labels and routes are unchanged", () => {
    assert.equal((home.match(/href: "\//g) || []).length, 2);
    assert.ok(home.includes('href: "/pos"'));
    assert.ok(home.includes('href: "/room"'));
    assert.match(home, /grid grid-cols-2 gap-x-3 gap-y-2/);
    assert.match(home, /flex flex-col gap-2/);
    for (const label of [
      "Manager Reports",
      "Cashier Portal",
      "Waiter Portal",
      "Kitchen Display",
      "Barista Display",
      "Jebena Buna",
      "Reception",
      "Room Management",
      "Room Reports",
    ]) {
      assert.ok(home.includes(`label: "${label}"`), label);
    }
  });
});
