// Room Management UI contract tests — DB-free and DOM-free.
//
// The components are checked at the source level: no browser, Mongo connection,
// module execution, or POS auth component is involved. These tests protect the
// Phase 2 UI-only scope: existing Hotel endpoints only, no fabricated data,
// manual-only status control, Manager-only mutations, and no credential/token
// storage.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

const pageSource = read("app/hotel/rooms/page.js");
const roomsUiSource = read("app/components/hotel/RoomsUI.jsx");
const roomsPanelSource = read("app/components/hotel/RoomsPanel.jsx");
const requestHookSource = read("app/components/hotel/useHotelRequest.js");
const roomTypesSource = read("app/components/hotel/RoomTypesPanel.jsx");

describe("Room Management route", () => {
  test("is a Hotel-only dynamic route rendering RoomsUI outside the POS guard", () => {
    assert.match(pageSource, /export const dynamic = "force-dynamic"/);
    assert.match(pageSource, /import RoomsUI from "@\/app\/components\/hotel\/RoomsUI"/);
    for (const forbidden of ["PinGuard", "PinLoginModal", "PinKeypad", "getPortalSession"]) {
      assert.ok(!pageSource.includes(forbidden), `route must not use ${forbidden}`);
    }
  });
});

describe("Room Management auth shell", () => {
  test("reuses the layout PIN gate and the shared verified-session request wrapper", () => {
    assert.match(roomsUiSource, /import \{ useHotelRequest \} from "\.\/useHotelRequest"/);
    assert.match(roomsUiSource, /const request = useHotelRequest\(\)/);
    assert.ok(!roomsUiSource.includes("/api/hotel/auth/me"));
    assert.ok(!roomsUiSource.includes("ReceptionLogin"));
    assert.match(roomsUiSource, /import HotelTopBar from "\.\/HotelTopBar"/);
    assert.ok(!roomsUiSource.includes("Sign out"), "the shared Hotel bar has no visible sign-out");
    assert.ok(!roomsUiSource.includes("localStorage"));
    assert.ok(!roomsUiSource.includes("sessionStorage"));
  });

  test("holds the CSRF token only in memory and forwards it through hotelRequest", () => {
    assert.match(requestHookSource, /useHotelSession\(\)/);
    assert.match(requestHookSource, /csrfToken: session\?\.csrfToken \|\| null/);
    assert.ok(!requestHookSource.includes("HOTEL_CSRF_HEADER"), "header handling stays inside hotelApi");
  });

  test("never imports POS authentication or POS session helpers", () => {
    for (const source of [roomsUiSource, roomsPanelSource, roomTypesSource]) {
      for (const forbidden of [
        'from "@/app/components/PinGuard"',
        'from "@/app/components/PinLoginModal"',
        'from "@/app/components/PinKeypad"',
        'from "@/lib/sessionClient"',
        'from "@/lib/clientFetch"',
        'from "@/_lib/pos',
      ]) {
        assert.ok(!source.includes(forbidden), `must not import ${forbidden}`);
      }
      assert.ok(
        source.includes('from "./hotelApi"') ||
          source.includes('from "./useHotelRequest"'),
        "must use a Hotel-only request wrapper"
      );
      assert.match(source, /from "\.\/ui"/);
    }
  });
});

describe("Rooms panel data contract", () => {
  test("uses only the existing rooms and room-types endpoints", () => {
    const endpoints = roomsPanelSource.match(/\/api\/hotel\/[a-z-]+/g) || [];
    const unique = [...new Set(endpoints)].sort();
    assert.deepEqual(unique, ["/api/hotel/room-types", "/api/hotel/rooms"]);
  });

  test("filters only with fields the rooms API accepts", () => {
    assert.match(roomsPanelSource, /operationalStatus/);
    assert.match(roomsPanelSource, /roomTypeId/);
    assert.match(roomsPanelSource, /isActive/);
    assert.match(roomsPanelSource, /params\.limit = PAGE_SIZE/);
    assert.match(roomsPanelSource, /params\.offset = offset/);
    assert.ok(!roomsPanelSource.includes("search="), "rooms API has no server-side search");
    assert.ok(!roomsPanelSource.includes("arrivalFrom"), "rooms API has no date filters");
  });

  test("derives summary counts from API totals and marks unavailable values", () => {
    assert.match(roomsPanelSource, /typeof result\.value\?\.total === "number"/);
    assert.match(roomsPanelSource, /Promise\.allSettled/);
    assert.match(roomsPanelSource, /limit: 1, offset: 0/);
    assert.match(roomsPanelSource, /"—"/);
  });

  test("guards list loads against stale responses and duplicate summaries", () => {
    assert.match(roomsPanelSource, /loadIdRef\.current !== requestId/);
    assert.match(roomsPanelSource, /summaryRequestIdRef\.current !== requestId/);
    assert.match(roomsPanelSource, /if \(busy\) return;|if \(busy \|\| !canManage\) return;/);
  });

  test("restricts manual status changes to the four housekeeping statuses", () => {
    assert.match(
      roomsPanelSource,
      /const MANUAL_ROOM_STATUSES = \["AVAILABLE", "CLEANING", "MAINTENANCE", "OUT_OF_SERVICE"\];/
    );
    assert.match(roomsPanelSource, /const options = MANUAL_ROOM_STATUSES\.filter/);
    assert.match(roomsPanelSource, /MANUAL_ROOM_STATUSES\.map/);
    assert.match(
      roomsPanelSource,
      /body: \{ operationalStatus: status, note: note\.trim\(\) \}/
    );
  });

  test("deactivates through the dedicated endpoint and reactivates via PATCH", () => {
    assert.match(
      roomsPanelSource,
      /\/api\/hotel\/rooms\/\$\{encodeURIComponent\(room\.id\)\}\/deactivate/
    );
    assert.match(
      roomsPanelSource,
      /method: "PATCH",\s*\n\s*body: \{ isActive: true \},/
    );
    assert.ok(
      !roomsPanelSource.includes('method: "DELETE"'),
      "rooms are never hard-deleted"
    );
  });

  test("gates every mutation behind a Manager session", () => {
    assert.match(roomsPanelSource, /const canManage = role === "MANAGER"/);
    assert.ok(roomsPanelSource.split("canManage").length >= 12, "canManage guards mutation UI");
  });

  test("shows server validation errors without simulating success", () => {
    assert.match(roomsPanelSource, /setFieldErrors\(submitError\.fieldErrors\)/);
    assert.match(roomsPanelSource, /humanHotelError\(submitError/);
    assert.match(roomsPanelSource, /aria-invalid=/);
  });

  test("keeps tokens and logs out of the UI source", () => {
    assert.ok(!roomsPanelSource.includes("localStorage"));
    assert.ok(!roomsPanelSource.includes("sessionStorage"));
    assert.ok(!roomsPanelSource.includes("console."));
  });
});

describe("Room types panel data contract", () => {
  test("uses only the existing room-types endpoints", () => {
    const endpoints = roomTypesSource.match(/\/api\/hotel\/[a-z-]+/g) || [];
    const unique = [...new Set(endpoints)].sort();
    assert.deepEqual(unique, ["/api/hotel/room-types"]);
    assert.match(roomTypesSource, /\/room-types\/\$\{encodeURIComponent\(roomType\.id\)\}\/deactivate/);
    assert.ok(!roomTypesSource.includes('method: "DELETE"'));
  });

  test("guards type loads against stale responses", () => {
    assert.match(roomTypesSource, /loadIdRef\.current !== requestId/);
  });

  test("keeps types read-only without a Manager session", () => {
    assert.ok(roomTypesSource.includes("canManage"));
    assert.match(roomTypesSource, /t\("common\.readOnlyManager"\)/);
  });

  test("never stores tokens or logs", () => {
    assert.ok(!roomTypesSource.includes("localStorage"));
    assert.ok(!roomTypesSource.includes("sessionStorage"));
    assert.ok(!roomTypesSource.includes("console."));
  });
});

describe("Room Management scope boundaries", () => {
  test("does not add Room Reports, Manager CRUD, or username/PIN management", () => {
    for (const source of [pageSource, roomsUiSource, roomsPanelSource, roomTypesSource]) {
      for (const forbidden of [
        "Room Reports",
        "Manager Reports",
        "report",
        "username",
        "pinHash",
        "rotate",
        "provision",
      ]) {
        assert.ok(!source.includes(forbidden), `Room Management UI must not contain "${forbidden}"`);
      }
    }
  });

  test("imports every React hook it calls", () => {
    for (const [name, source] of [
      ["RoomsUI", roomsUiSource],
      ["RoomsPanel", roomsPanelSource],
      ["RoomTypesPanel", roomTypesSource],
    ]) {
      const imported = new Set(
        source
          .match(/import\s*\{([^}]+)\}\s*from\s*"react"/)?.[1]
          ?.split(",")
          .map((entry) => entry.trim())
          .filter(Boolean) ?? []
      );
      const hasHotelI18nHook = source.includes(
        'import { useHotelI18n } from "./HotelI18n"'
      );
      const hasHotelSessionHook = source.includes(
        'import { useHotelSession } from "./HotelSessionProvider"'
      );
      const hasHotelRequestHook = source.includes(
        'import { useHotelRequest } from "./useHotelRequest"'
      );
      const called = new Set(
        (source.match(/\buse[A-Z]\w*\s*\(/g) || []).map((entry) =>
          entry.replace(/\s*\($/, "")
        )
      );
      const missing = [...called].filter(
        (hook) =>
          !imported.has(hook) &&
          !(hook === "useHotelI18n" && hasHotelI18nHook) &&
          !(hook === "useHotelSession" && hasHotelSessionHook) &&
          !(hook === "useHotelRequest" && hasHotelRequestHook)
      );
      assert.deepEqual(
        missing,
        [],
        `${name}.jsx calls ${missing.join(", ")} without a matching import`
      );
    }
  });
});

describe("Portal-aware login and Rooms navigation", () => {
  test("Rooms Reception link targets the Reception route with a reception icon", () => {
    const source = read("app/components/hotel/RoomsUI.jsx");
    assert.ok(source.includes('href="/hotel/reception"'));
    assert.ok(source.includes("IconDoorEnter"));
    assert.ok(source.includes('href="/hotel/management"'));
  });

  test("login gate is a centered, dimmed-overlay modal and scopes identities to the portal", () => {
    const gate = read("app/components/hotel/HotelLoginGate.jsx");
    const portals = read("lib/hotel/ui/portals.js");
    // Portal-aware filtering and no opposite-role button/label. Portal choice
    // now comes from the shared pure routing module, not an inline path test.
    assert.ok(gate.includes("resolveHotelPortal(pathname)"));
    assert.ok(gate.includes('@/lib/hotel/ui/portals'));
    assert.ok(gate.includes("filterIdentitiesForRole"));
    assert.ok(gate.includes("RECEPTIONIST") && gate.includes("MANAGER"));
    assert.ok(portals.includes("login.receptionTitle"));
    assert.ok(portals.includes("login.roomsTitle"));
    assert.ok(gate.includes("login.enterPinFour"));
    assert.ok(!gate.includes("Hotel Manager"));
    assert.ok(!gate.includes("session.roleManager"));
    assert.ok(!gate.includes("session.roleReceptionist"));
    // POS-style modal presentation: blurred portal context behind the card.
    assert.ok(gate.includes("blur-[2px]"));
    assert.ok(gate.includes("animate-fade-up"));
    assert.ok(gate.includes("max-w-[360px]"));
    assert.ok(portals.includes('"/hotel/reception"'));
    assert.ok(portals.includes('"/hotel/rooms"'));
    // The keypad is enabled for entry and the Verify control has one predicate.
    assert.ok(gate.includes("keypadDisabled"));
    assert.ok(gate.includes("disabled={!ready}"));
    assert.ok(gate.includes("canSubmitPin"));
    assert.ok(gate.includes("HotelPinKeypad"));
    // The missing-Receptionist state is explicit rather than a dead keypad.
    assert.ok(gate.includes("login.noReceptionist"));
    assert.ok(gate.includes("login.retryDirectory"));
  });

  test("Rooms Reception navigation uses a reception icon and reception portal", () => {
    const source = read("app/components/hotel/RoomsUI.jsx");
    assert.ok(source.includes('href="/hotel/reception"'));
    assert.ok(source.includes("IconDoorEnter"));
  });
});
