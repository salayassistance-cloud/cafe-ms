// Add Guest request-verification tests — DB-free.
//
// Exercises the exact Hotel helpers used by POST /api/hotel/guests:
// session creation/resolution, the session-bound CSRF token, Origin checks,
// role permissions, and the shared Add Guest client contract. No MongoDB
// connection is opened; services use an in-memory stub connection.
//
// The Hotel interactive login/bootstrap routes have been removed. These tests
// build a session row directly (test-only) and exercise the retained request
// guard and operational guest endpoint.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOTEL_CSRF_HEADER,
  HOTEL_SESSION_COOKIE,
} from "../lib/hotel/constants.js";
import { HOTEL_ERROR_CODES } from "../lib/hotel/errors.js";
import { HOTEL_PERMISSIONS } from "../lib/hotel/auth/authorization.js";
import {
  deriveHotelSessionCsrfToken,
  generateHotelCsrfToken,
} from "../lib/hotel/auth/csrf.js";
import { createHotelSession as createSession } from "../lib/hotel/auth/session.js";
import { authorizeHotelRequest } from "../lib/hotel/http/authorizedRequest.js";
import { authenticateHotelRequest } from "../lib/hotel/auth/service.js";
import { handleCreateGuest } from "../lib/hotel/http/guestHandlers.js";
import { withHotelApi } from "../lib/hotel/http/apiResponse.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (path) => readFileSync(join(root, path), "utf8");

const TEST_AUTH_SECRET = "pos-test-secret-that-must-not-be-reused-1234567890";
const TEST_HOTEL_SECRET = "hotel-test-secret-that-is-independent-1234567890";
const TEST_ORIGIN = "https://hotel.example";
const GUEST_BODY = {
  firstName: "Selam",
  lastName: "Bekele",
  phone: "+251911223344",
};

let previous = {};
before(() => {
  previous = {
    AUTH_SECRET: process.env.AUTH_SECRET,
    HOTEL_SESSION_SECRET: process.env.HOTEL_SESSION_SECRET,
    HOTEL_ALLOWED_ORIGINS: process.env.HOTEL_ALLOWED_ORIGINS,
  };
  process.env.AUTH_SECRET = TEST_AUTH_SECRET;
  process.env.HOTEL_SESSION_SECRET = TEST_HOTEL_SECRET;
  delete process.env.HOTEL_ALLOWED_ORIGINS;
});
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function makeUser(overrides = {}) {
  return {
    _id: "user-reception-1",
    email: "reception@example.com",
    username: "reception",
    name: "Front Desk",
    role: "RECEPTIONIST",
    isActive: true,
    lastLoginAt: null,
    ...overrides,
  };
}

// Minimal in-memory stand-in for the dedicated Hotel Mongoose connection. It
// implements only the query shapes the real services use, so the tests run the
// real auth/service code rather than mocks of those functions.
function buildConnection({ user = makeUser() } = {}) {
  const state = {
    user,
    sessions: [],
    audits: [],
    guests: [],
    sessionUpdates: [],
    guestCreates: 0,
  };

  const connection = {
    state,
    models: {
      HotelUser: {
        findById: () => ({
          select: () => ({
            lean: async () => state.user,
          }),
        }),
      },
      HotelSession: {
        create: async (doc) => {
          const row = { ...doc, _id: `session-${state.sessions.length + 1}` };
          state.sessions.push(row);
          return { ...row };
        },
        findOne: (filter) => ({
          select: () => ({
            lean: async () => {
              const row = state.sessions.find(
                (entry) => entry.tokenHash === filter.tokenHash
              );
              return row ? { ...row } : null;
            },
          }),
        }),
        updateOne: async (filter, update) => {
          state.sessionUpdates.push({ filter, update });
          const row = state.sessions.find(
            (entry) => String(entry._id) === String(filter._id)
          );
          if (!row) return { modifiedCount: 0 };
          if (filter.revokedAt === null && row.revokedAt) {
            return { modifiedCount: 0 };
          }
          if (update?.$set) Object.assign(row, update.$set);
          return { modifiedCount: 1 };
        },
      },
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

async function sessionFor(connection, { user } = {}) {
  const actor = user || connection.state.user;
  const { token, csrfToken } = await createSession(connection, {
    hotelUserId: actor._id,
    role: actor.role,
  });
  return { token, csrfToken };
}

function guestRequest({
  token,
  csrfToken,
  origin = TEST_ORIGIN,
  fetchSite,
  body = GUEST_BODY,
  method = "POST",
} = {}) {
  const headers = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  if (fetchSite) headers["sec-fetch-site"] = fetchSite;
  if (token) headers.cookie = `${HOTEL_SESSION_COOKIE}=${token}`;
  if (csrfToken) headers[HOTEL_CSRF_HEADER] = csrfToken;
  return new Request(`${TEST_ORIGIN}/api/hotel/guests`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const createGuestRoute = (connection) =>
  withHotelApi((request) =>
    handleCreateGuest(request, {}, { connect: connection })
  );

describe("Add Guest request verification", () => {
  test("accepts a valid Reception request with the session-bound token", async () => {
    const connection = buildConnection();
    const { token, csrfToken } = await sessionFor(connection);

    const response = await createGuestRoute(connection)(
      guestRequest({ token, csrfToken })
    );
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

  test("rejects a missing CSRF token before reading the body or writing", async () => {
    const connection = buildConnection();
    const { token } = await sessionFor(connection);

    const response = await createGuestRoute(connection)(
      guestRequest({ token })
    );
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.success, false);
    assert.equal(body.error.code, HOTEL_ERROR_CODES.CSRF_VALIDATION_FAILED);
    assert.equal(body.error.message, "Request verification failed");
    assert.equal(connection.state.guestCreates, 0);
    assert.equal(connection.state.guests.length, 0);
  });

  test("rejects invalid and stale CSRF tokens", async () => {
    const connection = buildConnection();
    const { token } = await sessionFor(connection);
    const route = createGuestRoute(connection);

    for (const badToken of [
      generateHotelCsrfToken(),
      "not-a-valid-token",
      deriveHotelSessionCsrfToken("A".repeat(43)),
    ]) {
      const response = await route(guestRequest({ token, csrfToken: badToken }));
      const body = await response.json();
      assert.equal(response.status, 403);
      assert.equal(body.error.code, HOTEL_ERROR_CODES.CSRF_VALIDATION_FAILED);
    }

    assert.equal(connection.state.guestCreates, 0);
  });

  test("rejects a token minted for a different session", async () => {
    const connection = buildConnection();
    const sessionA = await sessionFor(connection);
    const sessionB = await sessionFor(connection);

    // Both tokens are valid for their own session, but never for the other.
    assert.notEqual(sessionA.token, sessionB.token);
    const mismatch = await createGuestRoute(connection)(
      guestRequest({ token: sessionA.token, csrfToken: sessionB.csrfToken })
    );
    const body = await mismatch.json();

    assert.equal(mismatch.status, 403);
    assert.equal(body.error.code, HOTEL_ERROR_CODES.CSRF_VALIDATION_FAILED);
    assert.equal(connection.state.guestCreates, 0);
  });

  test("rejects an untrusted Origin, a missing Origin, and cross-site metadata", async () => {
    const connection = buildConnection();
    const { token, csrfToken } = await sessionFor(connection);
    const route = createGuestRoute(connection);

    for (const request of [
      guestRequest({
        token,
        csrfToken,
        origin: "https://evil.example",
      }),
      guestRequest({ token, csrfToken, origin: null }),
      guestRequest({
        token,
        csrfToken,
        origin: TEST_ORIGIN,
        fetchSite: "cross-site",
      }),
    ]) {
      const response = await route(request);
      const body = await response.json();
      assert.equal(response.status, 403);
      assert.equal(body.error.code, HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED);
    }

    assert.equal(connection.state.guestCreates, 0);
  });

  test("rejects a missing or invalid session", async () => {
    const connection = buildConnection();
    const route = createGuestRoute(connection);
    const csrfToken = generateHotelCsrfToken();

    const missing = await route(guestRequest({ csrfToken }));
    assert.equal(missing.status, 401);
    assert.equal(
      (await missing.json()).error.code,
      HOTEL_ERROR_CODES.AUTHENTICATION_REQUIRED
    );

    const unknown = await route(
      guestRequest({ token: "A".repeat(43), csrfToken })
    );
    assert.equal(unknown.status, 401);
    assert.equal(
      (await unknown.json()).error.code,
      HOTEL_ERROR_CODES.INVALID_SESSION
    );

    assert.equal(connection.state.guestCreates, 0);
  });

  test("keeps role and permission authorization after verification", async () => {
    const connection = buildConnection();
    const { token, csrfToken } = await sessionFor(connection);

    const denied = await authorizeHotelRequest(
      guestRequest({ token, csrfToken }),
      {
        connect: connection,
        mutation: true,
        permission: HOTEL_PERMISSIONS.REPORTS_READ,
      }
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.response.status, 403);
    assert.equal(
      (await denied.response.json()).error.code,
      HOTEL_ERROR_CODES.FORBIDDEN
    );

    const wrongRole = await authenticateHotelRequest(
      guestRequest({ token, csrfToken }),
      {
        connect: connection,
        requireCsrf: true,
        csrfToken,
        allowedRoles: ["MANAGER"],
        permission: HOTEL_PERMISSIONS.GUESTS_MANAGE,
      }
    );
    assert.equal(wrongRole.ok, false);
    assert.equal(wrongRole.status, 403);
    assert.equal(wrongRole.code, HOTEL_ERROR_CODES.FORBIDDEN);
    assert.equal(connection.state.guestCreates, 0);
  });

  test("verification failures never echo session or token values", async () => {
    const connection = buildConnection();
    const { token, csrfToken } = await sessionFor(connection);
    const route = createGuestRoute(connection);

    const responses = await Promise.all([
      route(guestRequest({ token })),
      route(guestRequest({ token, csrfToken: generateHotelCsrfToken() })),
      route(guestRequest({ token, csrfToken, origin: "https://evil.example" })),
      route(guestRequest({ csrfToken })),
    ]);

    for (const response of responses) {
      const text = await response.text();
      assert.equal(response.headers.get("set-cookie"), null);
      assert.ok(!text.includes(token), "session token must not be echoed");
      assert.ok(!text.includes(csrfToken), "CSRF token must not be echoed");
      assert.ok(!text.includes("csrfHash"), "hash must not be echoed");
      assert.ok(!text.includes("tokenHash"), "hash must not be echoed");
      assert.ok(
        !text.includes(TEST_HOTEL_SECRET),
        "server secret must not be echoed"
      );
    }
  });
});

describe("Add Guest client contract", () => {
  test("uses the shared Hotel client and forwards the CSRF token", () => {
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
    assert.match(
      hook,
      /hotelRequest\(path, \{\s*\.\.\.options,\s*csrfToken: session\?\.csrfToken \|\| null,/
    );
    assert.match(hook, /useHotelSession\(\)/);
  });

  test("sends credentials and the exact verification header on mutations", () => {
    const client = src("app/components/hotel/hotelApi.js");
    assert.match(client, /credentials: "include"/);
    assert.match(
      client,
      /MUTATION_METHODS\.has\(method\) && options\.csrfToken/
    );
    assert.match(client, /headers\[HOTEL_CSRF_HEADER\] = options\.csrfToken/);
    assert.ok(!client.includes("localStorage"), "token stays in memory");
    assert.ok(!client.includes("document.cookie"), "no token cookie");

    const constants = src("lib/hotel/constants.js");
    assert.match(
      constants,
      /HOTEL_CSRF_HEADER = "x-hotel-csrf-token"/
    );
  });
});
