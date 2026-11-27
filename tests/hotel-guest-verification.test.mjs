// Add Guest request-verification tests — DB-free.
//
// Exercises the exact Hotel helpers used by POST /api/hotel/guests:
// Origin checks, request authorization, guest creation, and the shared Add Guest
// client contract. No MongoDB connection is opened; services use an in-memory
// stub connection.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOTEL_ERROR_CODES } from "../lib/hotel/errors.js";
import { HOTEL_PERMISSIONS } from "../lib/hotel/auth/authorization.js";
import { authorizeHotelRequest } from "../lib/hotel/http/authorizedRequest.js";
import { handleCreateGuest } from "../lib/hotel/http/guestHandlers.js";
import { withHotelApi } from "../lib/hotel/http/apiResponse.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (path) => readFileSync(join(root, path), "utf8");

const TEST_ORIGIN = "https://hotel.example";
const GUEST_BODY = {
  firstName: "Selam",
  lastName: "Bekele",
  phone: "+251911223344",
};

let previous = {};
before(() => {
  previous = {
    HOTEL_ALLOWED_ORIGINS: process.env.HOTEL_ALLOWED_ORIGINS,
  };
  delete process.env.HOTEL_ALLOWED_ORIGINS;
});
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Minimal in-memory stand-in for the dedicated Hotel Mongoose connection.
function buildConnection() {
  const state = {
    audits: [],
    guests: [],
    guestCreates: 0,
  };

  const connection = {
    state,
    models: {
      HotelAuditLog: {
        create: async (doc) => {
          state.audits.push(doc);
          return doc;
        },
      },
      Guest: {
        create: async (doc) => {
          state.guestCreates += 1;
          const row = {
            ...doc,
            _id: `guest-${state.guestCreates}`,
            isActive: doc.isActive === false ? false : true,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          state.guests.push(row);
          return row;
        },
      },
    },
  };

  return connection;
}

function guestRequest({
  origin = TEST_ORIGIN,
  fetchSite,
  body = GUEST_BODY,
  method = "POST",
} = {}) {
  const headers = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  if (fetchSite) headers["sec-fetch-site"] = fetchSite;
  return new Request(`${TEST_ORIGIN}/api/hotel/guests`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Phase 4-A: simulate a canonical POS MANAGER for DB-free HTTP tests.
async function testManagerAuth() {
  return { ok: true, payload: { staffId: null, role: "MANAGER", name: "test-manager" } };
}

const createGuestRoute = (connection) =>
  withHotelApi((request) =>
    handleCreateGuest(request, {}, { connect: connection, authenticate: testManagerAuth })
  );

describe("Add Guest request verification", () => {
  test("accepts a valid Phase 1 MANAGER request with a trusted Origin", async () => {
    const connection = buildConnection();

    const response = await createGuestRoute(connection)(guestRequest());
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.error, null);
    assert.equal(body.data.guest.firstName, GUEST_BODY.firstName);
    assert.equal(body.data.guest.lastName, GUEST_BODY.lastName);
    assert.equal(connection.state.guests.length, 1);
    assert.equal(
      connection.state.audits.some((entry) => entry.action === "GUEST_CREATED"),
      true
    );
  });

  test("rejects an untrusted Origin, a missing Origin, and cross-site metadata", async () => {
    const connection = buildConnection();
    const route = createGuestRoute(connection);

    for (const request of [
      guestRequest({ origin: "https://evil.example" }),
      guestRequest({ origin: null }),
      guestRequest({ origin: TEST_ORIGIN, fetchSite: "cross-site" }),
    ]) {
      const response = await route(request);
      const body = await response.json();
      assert.equal(response.status, 403);
      assert.equal(body.error.code, HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED);
    }

    assert.equal(connection.state.guestCreates, 0);
  });

  test("fails closed without POS authentication and authorizes only a MANAGER after Origin verification", async () => {
    const connection = buildConnection();

    // Phase 1: no POS session -> fail closed at the auth boundary.
    const unauthenticated = await authorizeHotelRequest(guestRequest(), {
      connect: connection,
      mutation: true,
      permission: HOTEL_PERMISSIONS.GUESTS_MANAGE,
      authenticate: async () => ({
        ok: false,
        status: 401,
        code: "AUTHENTICATION_REQUIRED",
      }),
    });
    assert.equal(unauthenticated.ok, false);
    assert.equal(unauthenticated.response.status, 401);

    // Phase 1: non-MANAGER POS roles are rejected; Reception stays MANAGER-only.
    const receptionist = await authorizeHotelRequest(guestRequest(), {
      connect: connection,
      mutation: true,
      permission: HOTEL_PERMISSIONS.GUESTS_MANAGE,
      authenticate: async () => ({
        ok: true,
        payload: { staffId: null, role: "RECEPTIONIST", name: "test-receptionist" },
      }),
    });
    assert.equal(receptionist.ok, false);
    assert.equal(receptionist.response.status, 403);

    // Phase 1: an authenticated MANAGER is authorized; Hotel still has no
    // session-cookie or CSRF-token requirement of its own.
    const authorized = await authorizeHotelRequest(guestRequest(), {
      connect: connection,
      mutation: true,
      permission: HOTEL_PERMISSIONS.GUESTS_MANAGE,
      authenticate: testManagerAuth,
    });
    assert.equal(authorized.ok, true);
    assert.deepEqual(authorized.auth.user, { id: null, role: "MANAGER" });
    assert.equal(authorized.auth.role, "MANAGER");

    // The auth boundary itself never writes guest rows.
    assert.equal(connection.state.guestCreates, 0);
  });
});

describe("Add Guest client contract", () => {
  test("uses the shared Hotel client without session or CSRF wiring", () => {
    const panel = src("app/components/hotel/GuestsPanel.jsx");
    assert.match(
      panel,
      /const data = await request\("\/api\/hotel\/guests", \{ method: "POST", body \}\)/
    );
    assert.ok(!panel.includes("await fetch("), "must not bypass the shared client");
    assert.ok(!panel.includes("hotelRequest("), "must use the shell request wrapper");

    const shell = src("app/components/hotel/ReceptionUI.jsx");
    assert.match(shell, /const request = useHotelRequest\(\)/);
    assert.match(shell, /<GuestsPanel[\s\S]*?request=\{request\}/);

    const hook = src("app/components/hotel/useHotelRequest.js");
    assert.match(hook, /hotelRequest\(path, options\)/);
    assert.ok(!hook.includes("useHotelSession"));
    assert.ok(!hook.includes("csrfToken"));
  });

  test("sends credentials without localStorage or document.cookie", () => {
    const client = src("app/components/hotel/hotelApi.js");
    assert.match(client, /credentials: "include"/);
    assert.ok(!client.includes("localStorage"), "no localStorage usage");
    assert.ok(!client.includes("document.cookie"), "no document.cookie usage");
    assert.ok(!client.includes("HOTEL_CSRF_HEADER"));
  });
});
