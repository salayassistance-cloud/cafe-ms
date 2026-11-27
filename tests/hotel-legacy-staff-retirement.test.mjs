// Phase 4-B6: Hotel Legacy Staff Management Retirement Contract Tests (DB-free)

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(root, rel), "utf8");

test("Phase 4-B6.1: Legacy navigation links to /hotel/management are absent from RoomsUI and RoomReportsUI", () => {
  const roomsUI = read("app/components/hotel/RoomsUI.jsx");
  const reportsUI = read("app/components/hotel/RoomReportsUI.jsx");

  assert.ok(!roomsUI.includes('href="/hotel/management"'), "RoomsUI must not link to /hotel/management");
  assert.ok(!reportsUI.includes('href="/hotel/management"'), "RoomReportsUI must not link to /hotel/management");
  assert.ok(!roomsUI.includes("staffManagement"), "RoomsUI top bar must not reference staffManagement");
  assert.ok(!reportsUI.includes("staffManagement"), "RoomReportsUI top bar must not reference staffManagement");
});

test("Phase 4-B6.2: Legacy management page is absent", () => {
  assert.equal(existsSync(join(root, "app/hotel/management/page.js")), false);
  assert.equal(existsSync(join(root, "app/hotel/management")), false);
});

test("Phase 4-B6.3: Legacy Hotel Staff Management UI is absent", () => {
  assert.equal(existsSync(join(root, "app/components/hotel/HotelStaffManagementUI.jsx")), false);
});

test("Phase 4-B6.4: The three dedicated legacy API files are absent", () => {
  assert.equal(existsSync(join(root, "app/api/hotel/staff/route.js")), false);
  assert.equal(existsSync(join(root, "app/api/hotel/staff/[id]/route.js")), false);
  assert.equal(existsSync(join(root, "app/api/hotel/staff/[id]/status/route.js")), false);
  assert.equal(existsSync(join(root, "app/api/hotel/staff")), false);
});

test("Phase 4-B6.5: The two exclusive legacy backend service/support files are absent", () => {
  assert.equal(existsSync(join(root, "lib/hotel/auth/staffService.js")), false);
  assert.equal(existsSync(join(root, "lib/hotel/auth/staffRouteSupport.js")), false);
});

test("Phase 4-B6.6: No dangling imports or source references to retired modules remain in app/ or lib/", () => {
  const checkDir = (dir) => {
    let files = [];
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(checkDir(full));
      } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".jsx"))) {
        files.push(full);
      }
    }
    return files;
  };

  const appFiles = checkDir("app");
  const libFiles = checkDir("lib");
  const allSourceFiles = [...appFiles, ...libFiles];

  const forbiddenSnippets = [
    "HotelStaffManagementUI",
    "lib/hotel/auth/staffService",
    "lib/hotel/auth/staffRouteSupport",
    "/api/hotel/staff",
  ];

  for (const rel of allSourceFiles) {
    // lib/hotel/db/connection.js is strictly prohibited from inspection
    if (rel.replace(/\\/g, "/") === "lib/hotel/db/connection.js") continue;

    const content = read(rel);
    for (const snippet of forbiddenSnippets) {
      assert.ok(
        !content.includes(snippet),
        `Source file ${rel} contains dangling reference to retired "${snippet}"`
      );
    }
  }
});

test("Phase 4-B6.7: POS Staff Management references and APIs remain intact", () => {
  assert.ok(existsSync(join(root, "app/components/StaffManagement.jsx")), "StaffManagement.jsx preserved");
  assert.ok(existsSync(join(root, "app/api/manager/staff/route.js")), "/api/manager/staff route preserved");
  assert.ok(existsSync(join(root, "app/api/manager/waiters/route.js")), "/api/manager/waiters route preserved");
  assert.ok(existsSync(join(root, "lib/models/Staff.js")), "Staff model preserved");
  assert.ok(existsSync(join(root, "lib/models/Session.js")), "Session model preserved");

  const staffMgmt = read("app/components/StaffManagement.jsx");
  assert.match(staffMgmt, /RECEPTION/);
  assert.match(staffMgmt, /\/api\/manager\/staff/);

  const staffModel = read("lib/models/Staff.js");
  assert.match(staffModel, /"RECEPTION"/);
});

test("Phase 4-B6.8: The Reception portal and its authorized Hotel access integration remain intact", () => {
  assert.ok(existsSync(join(root, "app/hotel/reception/page.js")), "Reception page preserved");

  const homeNav = read("app/components/HomeNav.jsx");
  assert.match(homeNav, /role:\s*"RECEPTION"/);
  assert.match(homeNav, /route:\s*"\/hotel\/reception"/);

  const hotelLayout = read("app/hotel/layout.js");
  assert.match(hotelLayout, /"RECEPTION"/);

  const authSeam = read("lib/hotel/http/authorizedRequest.js");
  assert.match(authSeam, /POS_RECEPTION_ROLE = "RECEPTION"/);
  assert.match(authSeam, /HOTEL_RECEPTION_ROLE = "RECEPTIONIST"/);
});

test("Phase 4-B6.9: Explicitly preserved files and models remain present", () => {
  assert.ok(existsSync(join(root, "lib/hotel/models/hotelUser.js")), "hotelUser.js model preserved");
  assert.ok(existsSync(join(root, "lib/hotel/auth/authorization.js")), "authorization.js preserved");
  assert.ok(existsSync(join(root, "lib/hotel/uiTranslations.js")), "uiTranslations.js preserved");

  const authFile = read("lib/hotel/auth/authorization.js");
  assert.match(authFile, /STAFF_MANAGE:\s*"hotel\.staff\.manage"/);
});
