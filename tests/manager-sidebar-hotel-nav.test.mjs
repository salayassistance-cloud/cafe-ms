// Manager Sidebar Hotel navigation — DB-free, source-level contract tests.
//
// Phase 2 is a navigation-only integration: the existing POS Manager Sidebar
// gains two ordinary links to the existing Hotel pages. No POS entry, role,
// auth mechanism, or Hotel business logic is exercised or executed here.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

const sidebar = read("app/components/ManagerSidebar.jsx");

// Parse the RAW_ENTRIES literal without importing the client component.
function parseEntries(source) {
  const start = source.indexOf("const RAW_ENTRIES = [");
  assert.ok(start !== -1, "RAW_ENTRIES must exist");
  const end = source.indexOf("];", start);
  assert.ok(end !== -1, "RAW_ENTRIES must be terminated");
  const block = source.slice(start, end);

  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      const id = line.match(/id:\s*'([^']+)'/)?.[1] ?? null;
      const label = line.match(/label:\s*'([^']+)'/)?.[1] ?? null;
      const href = line.match(/href:\s*'([^']+)'/)?.[1] ?? null;
      const type = line.match(/type:\s*'([^']+)'/)?.[1] ?? null;
      const icon = line.match(/icon:\s*([A-Za-z0-9_]+)/)?.[1] ?? null;
      return { id, label, href, type, icon };
    });
}

const entries = parseEntries(sidebar);
const byLabel = (label) => entries.find((entry) => entry.label === label);

describe("Manager Sidebar — Hotel entries", () => {
  test("adds a Room Management link to the existing Hotel route", () => {
    const entry = byLabel("Room Management");
    assert.ok(entry, "Room Management entry must exist");
    assert.equal(entry.href, "/hotel/rooms");
    assert.equal(entry.type, "link");
    assert.equal(entry.icon, "IconBedFilled");
  });

  test("adds a Room Reports link to the existing Hotel route", () => {
    const entry = byLabel("Room Reports");
    assert.ok(entry, "Room Reports entry must exist");
    assert.equal(entry.href, "/hotel/reports");
    assert.equal(entry.type, "link");
    assert.equal(entry.icon, "IconClipboardListFilled");
  });

  test("both Hotel entries are ordinary navigation links, not embedded apps", () => {
    assert.ok(!sidebar.includes("<iframe"), "no embedded Hotel application");
    assert.ok(!sidebar.includes("RoomReportsUI"), "no Hotel UI component import");
    assert.ok(!sidebar.includes("RoomsUI"), "no Hotel UI component import");
    // Links render through the shared Link branch of renderItem.
    assert.match(sidebar, /if \(entry\.type === 'link' && entry\.href\)/);
    assert.match(sidebar, /<Link\s*\n\s*href=\{entry\.href\}/);
  });

  test("uses the existing Hotel labels verbatim", () => {
    for (const label of ["Room Management", "Room Reports"]) {
      assert.ok(byLabel(label), `sidebar must reuse the ${label} label`);
    }
  });
});

describe("Manager Sidebar — scope boundaries", () => {
  test("Reception is not added to the Manager Sidebar", () => {
    assert.ok(!sidebar.includes("Reception"), "Reception must stay off the sidebar");
    assert.ok(!sidebar.includes("/hotel/reception"), "no Reception route on the sidebar");
    for (const entry of entries) {
      assert.ok(
        !/reception/i.test(entry.href ?? ""),
        `entry ${entry.id} must not point at Reception`
      );
    }
  });

  test("keeps every existing POS entry and its route intact", () => {
    const expected = [
      ["reports", "Manager Reports", "/manager/reports"],
      ["menu", "Menu Management", "/manager/menu-crud"],
      ["inventory", "Inventory", "/manager/inventory"],
      ["staff", "Staff Management", "/manager/staff"],
    ];
    for (const [id, label, href] of expected) {
      const entry = entries.find((candidate) => candidate.id === id);
      assert.ok(entry, `existing entry ${id} must remain`);
      assert.equal(entry.label, label);
      assert.equal(entry.href, href);
      assert.equal(entry.type, "link");
    }
    for (const action of ["exportCsv", "exportPdf"]) {
      const entry = entries.find((candidate) => candidate.id === action);
      assert.ok(entry, `existing action ${action} must remain`);
      assert.equal(entry.type, "action");
    }
  });

  test("does not reorder existing entries or introduce a duplicate sidebar", () => {
    const ids = entries.map((entry) => entry.id);
    const posIds = ids.filter((id) =>
      ["reports", "menu", "inventory", "staff", "exportCsv", "exportPdf"].includes(id)
    );
    assert.deepEqual(posIds, [
      "reports",
      "menu",
      "inventory",
      "staff",
      "exportCsv",
      "exportPdf",
    ]);
    // The two Hotel links sit between Staff Management and the export actions.
    assert.deepEqual(ids, [
      "reports",
      "menu",
      "inventory",
      "staff",
      "hotelRooms",
      "hotelReports",
      "exportCsv",
      "exportPdf",
    ]);
    assert.equal(
      (sidebar.match(/aria-label="Manager navigation"/g) || []).length,
      1,
      "exactly one Manager navigation region"
    );
    assert.equal(
      (sidebar.match(/export default function ManagerSidebar/g) || []).length,
      1,
      "no duplicate ManagerSidebar component"
    );
  });

  test("preserves existing navigation behavior and responsive layout", () => {
    // Drag-and-drop reorder, keyboard reorder, collapse and mobile drawer.
    for (const contract of [
      /const handleDragStart = /,
      /const handleDrop = /,
      /const handleKeyReorder = /,
      /setCollapsed\(\(v\) => !v\)/,
      /const \[mobileOpen, setMobileOpen\] = useState\(false\)/,
      /hidden lg:flex lg:shrink-0 lg:sticky/,
      /aria-label="Manager navigation"/,
    ]) {
      assert.match(sidebar, contract);
    }
    // Active-route highlighting still uses the shared href matcher.
    assert.match(sidebar, /pathname\.startsWith\(href \+ '\/'\)/);
    // Hotel links inherit the same prefetch behaviour as POS links.
    assert.match(sidebar, /<Link\s*\n\s*href=\{entry\.href\}\s*\n\s*prefetch/);
  });

  test("introduces no role, auth, or session mechanism", () => {
    for (const forbidden of [
      "getPortalSession",
      "requireAuth",
      "PinGuard",
      "sessionStorage",
      "fetch(",
      "/api/hotel",
    ]) {
      assert.ok(
        !sidebar.includes(forbidden),
        `sidebar must not contain ${forbidden}`
      );
    }
    // localStorage is permitted strictly for sidebar order persistence
    assert.ok(
      sidebar.includes("bono_manager_sidebar_order"),
      "sidebar must use bono_manager_sidebar_order for order persistence"
    );
  });
});
