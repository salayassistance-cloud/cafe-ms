// Phase 4-B3 — Hotel RECEPTION authorization & page-gate tests (DB-free).
//
// Uses the test-only `authenticate` seam and an in-memory stub connection;
// never imports lib/hotel/db/connection.js and never opens any database.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { authorizeHotelRequest } from "../lib/hotel/http/authorizedRequest.js";
import {
  HOTEL_PERMISSIONS,
  ROLE_PERMISSIONS,
  canHotel,
} from "../lib/hotel/auth/authorization.js";
import { HOTEL_ERROR_CODES } from "../lib/hotel/errors.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const HOTEL_ORIGIN = "https://hotel.example";
const POS_RECEPTION_STAFF_ID = "662222222222222222222222";
const STUB_CONNECTION = Object.freeze({ models: Object.freeze({}) });

function posPayload(role) {
  return { ok: true, payload: { staffId: POS_RECEPTION_STAFF_ID, role } };
}

function buildRequest({
  method = "GET",
  path = "/api/hotel/guests",
  origin = HOTEL_ORIGIN,
} = {}) {
  const headers = {};
  if (origin !== null) headers.origin = origin;
  return new Request(`${HOTEL_ORIGIN}${path}`, { method, headers });
}

function authorize({
  role = "RECEPTION",
  permission = HOTEL_PERMISSIONS.GUESTS_READ,
  mutation = false,
  request = buildRequest(),
} = {}) {
  return authorizeHotelRequest(request, {
    permission,
    mutation,
    connect: STUB_CONNECTION,
    allowedOrigins: [HOTEL_ORIGIN],
    authenticate: async () => posPayload(role),
  });
}

describe("Phase 4-B3: Hotel RECEPTION authorization boundary", () => {
  test("maps POS RECEPTION to Hotel RECEPTIONIST with null user.id", async () => {
    const result = await authorize();

    assert.equal(result.ok, true);
    assert.equal(result.auth.role, "RECEPTIONIST");
    assert.deepEqual(result.auth.user, { id: null, role: "RECEPTIONIST" });
    assert.equal(result.auth.connection, STUB_CONNECTION);
  });

  test("permits all existing RECEPTIONIST permissions including BILLING_MANAGE (void)", async () => {
    const allowedPermissions = [
      HOTEL_PERMISSIONS.DASHBOARD_READ,
      HOTEL_PERMISSIONS.ROOM_TYPES_READ,
      HOTEL_PERMISSIONS.ROOMS_READ,
      HOTEL_PERMISSIONS.RESERVATIONS_READ,
      HOTEL_PERMISSIONS.RESERVATIONS_MANAGE,
      HOTEL_PERMISSIONS.GUESTS_READ,
      HOTEL_PERMISSIONS.GUESTS_MANAGE,
      HOTEL_PERMISSIONS.BILLING_READ,
      HOTEL_PERMISSIONS.BILLING_MANAGE,
    ];

    assert.deepEqual(
      [...ROLE_PERMISSIONS.RECEPTIONIST].sort(),
      [...allowedPermissions].sort()
    );

    for (const permission of allowedPermissions) {
      const result = await authorize({
        role: "RECEPTION",
        permission,
        mutation: permission === HOTEL_PERMISSIONS.BILLING_MANAGE,
        request: buildRequest({
          method: permission === HOTEL_PERMISSIONS.BILLING_MANAGE ? "POST" : "GET",
          path: "/api/hotel/payments/pay-1/void",
        }),
      });
      assert.equal(result.ok, true, `RECEPTION should be allowed ${permission}`);
      assert.equal(result.auth.role, "RECEPTIONIST");
    }
  });

  test("denies MANAGER-only Hotel permissions to RECEPTION", async () => {
    const deniedPermissions = [
      HOTEL_PERMISSIONS.ROOM_TYPES_MANAGE,
      HOTEL_PERMISSIONS.ROOMS_MANAGE,
      HOTEL_PERMISSIONS.REPORTS_READ,
      HOTEL_PERMISSIONS.STAFF_MANAGE,
      HOTEL_PERMISSIONS.AUDIT_READ,
      HOTEL_PERMISSIONS.SETTINGS_MANAGE,
    ];

    for (const permission of deniedPermissions) {
      const result = await authorize({ role: "RECEPTION", permission });
      assert.equal(result.ok, false, `RECEPTION must be denied ${permission}`);
      assert.equal(result.response.status, 403);
      const body = await result.response.json();
      assert.equal(body.error.code, HOTEL_ERROR_CODES.FORBIDDEN);
    }
  });

  test("rejects non-MANAGER / non-RECEPTION roles and unknown roles", async () => {
    for (const role of [
      "CASHIER",
      "WAITER",
      "KITCHEN",
      "BARISTA",
      "HOT_DRINK",
      "RECEPTIONIST",
      "UNKNOWN",
      "",
    ]) {
      const result = await authorize({ role });
      assert.equal(result.ok, false, role);
      assert.equal(result.response.status, 403, role);
    }
  });

  test("MANAGER retains all Hotel permissions including STAFF_MANAGE", async () => {
    for (const permission of Object.values(HOTEL_PERMISSIONS)) {
      const result = await authorize({ role: "MANAGER", permission });
      assert.equal(result.ok, true, `MANAGER should be allowed ${permission}`);
      assert.equal(result.auth.role, "MANAGER");
    }
  });
});

describe("Phase 4-B3 / Phase 4-B6: Hotel permission matrix STAFF_MANAGE retention", () => {
  test("STAFF_MANAGE permission is preserved in matrix and denied to RECEPTION", () => {
    assert.ok(HOTEL_PERMISSIONS.STAFF_MANAGE);
    assert.equal(canHotel("MANAGER", HOTEL_PERMISSIONS.STAFF_MANAGE), true);
    assert.equal(canHotel("RECEPTIONIST", HOTEL_PERMISSIONS.STAFF_MANAGE), false);
  });
});

describe("Phase 4-B3: Hotel page gates & PinGuard", () => {
  test("Hotel layout permits MANAGER and RECEPTION; Reception page stays accessible under layout", () => {
    const layout = read("app/hotel/layout.js");
    assert.match(
      layout,
      /getLiveSessionFromCookies\(store,\s*\[\s*"MANAGER",\s*"RECEPTION",?\s*\]\)/
    );
    assert.match(layout, /<PinGuard role="RECEPTION" next="\/hotel\/reception" \/>/);
  });

  test("Hotel Rooms and Reports pages enforce explicit MANAGER-only server gates", () => {
    const pages = [
      { path: "app/hotel/rooms/page.js", next: "/hotel/rooms" },
      { path: "app/hotel/reports/page.js", next: "/hotel/reports" },
    ];

    for (const { path, next } of pages) {
      const src = read(path);
      assert.match(src, /getPortalSession\("MANAGER"\)/, path);
      assert.match(
        src,
        new RegExp(`<PinGuard role="MANAGER" next="${next.replace(/\//g, "\\/")}"`),
        path
      );
    }
  });

  test("PinGuard maps RECEPTION label and /hotel/reception fallback target", () => {
    const pinGuard = read("app/components/PinGuard.js");
    assert.match(pinGuard, /RECEPTION:\s*"Reception Portal"/);
    assert.match(pinGuard, /role === "RECEPTION"\s*\?\s*"\/hotel\/reception"/);
  });
});
