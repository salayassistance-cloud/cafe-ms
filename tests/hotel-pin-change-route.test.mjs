// Route-level behavioral tests for Hotel PIN change.
//
// Unlike the existing source-string assertions, these execute the real Route
// Handler with a real Request (Origin, cookie, CSRF header, JSON body) against
// an in-memory Hotel connection. They prove the end-to-end contract:
//
//   HTTP request -> Origin/CSRF -> auth -> validation -> persistence ->
//   session revocation -> audit -> response
//
// Run with:
//   node --import ./tests/helpers/hotel-route-register.mjs \
//        --test tests/hotel-pin-change-route.test.mjs
//
// No database, no network, no production credential, no production code change.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { register } from "node:module";
import { describe, test, beforeEach } from "node:test";

// Self-register the test-only resolver so this file also runs in the default
// `node --test tests/*.test.mjs` sweep, where no `--import` flag is present.
// The hook redirects ONLY the Hotel DB connection module to an in-memory fake;
// all production source files are loaded unmodified.
register("./helpers/hotel-route-loader.mjs", import.meta.url);

// Environment must exist before any Hotel module reads it. These are synthetic
// test-only values; they are never used outside this process.
process.env.HOTEL_SESSION_SECRET =
  "test-only-hotel-session-secret-0123456789abcdef";
process.env.AUTH_SECRET = "test-only-pos-auth-secret-0123456789abcdef";

const { setHotelFakeConnection, clearHotelFakeConnection } = await import(
  "./helpers/hotel-route-fake-db.mjs"
);
const { hashHotelPin, verifyHotelPin } = await import(
  "../lib/hotel/auth/pin.js"
);
const { deriveHotelSessionCsrfToken, hashHotelCsrfToken } = await import(
  "../lib/hotel/auth/csrf.js"
);
const { hashHotelSessionToken } = await import(
  "../lib/hotel/auth/session.js"
);
const { resetHotelRateLimitStore } = await import(
  "../lib/hotel/auth/rateLimit.js"
);
const { HOTEL_CSRF_HEADER, HOTEL_SESSION_COOKIE } = await import(
  "../lib/hotel/constants.js"
);

// Importing the Route Handlers pulls in the production modules. The loader
// redirects only `lib/hotel/db/connection.js` to the fake.
const changePinRoute = await import(
  "../app/api/hotel/auth/change-pin/route.js"
);
const staffPinRoute = await import(
  "../app/api/hotel/staff/[id]/pin/route.js"
);

const ID_MANAGER = "64b000000000000000000001";
const ID_RECEPTION = "64b000000000000000000002";
const ID_OTHER = "64b000000000000000000003";
const SESSION_ID = "65b000000000000000000001";

// ---------------------------------------------------------------------------
// In-memory Mongoose-like models
// ---------------------------------------------------------------------------

function sameId(a, b) {
  return String(a) === String(b);
}

function matches(doc, filter) {
  for (const [key, condition] of Object.entries(filter)) {
    const value = doc[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if ("$ne" in condition) {
        if (sameId(value, condition.$ne)) return false;
        continue;
      }
      if ("$type" in condition) {
        if (typeof value !== condition.$type) return false;
        continue;
      }
      if ("$in" in condition) {
        if (!condition.$in.some((entry) => sameId(value, entry))) return false;
        continue;
      }
    }
    if (!sameId(value, condition)) return false;
  }
  return true;
}

function applyUpdate(doc, update) {
  if (Array.isArray(update)) {
    // The only pipeline update in this flow is the failed-attempt counter,
    // which these tests do not exercise. Keep it a no-op rather than throwing.
    return;
  }
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$unset) {
    for (const key of Object.keys(update.$unset)) delete doc[key];
  }
}

function makeQuery(result) {
  const query = {
    select() {
      return query;
    },
    sort() {
      return query;
    },
    lean() {
      return Promise.resolve(result);
    },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return query;
}

function createFakeModel(seed = []) {
  const docs = seed.map((doc) => ({ ...doc }));
  let counter = 0;
  return {
    docs,
    findById(id) {
      return makeQuery(docs.find((doc) => sameId(doc._id, id)) ?? null);
    },
    find(filter = {}) {
      return makeQuery(docs.filter((doc) => matches(doc, filter)));
    },
    findOne(filter = {}) {
      return makeQuery(docs.find((doc) => matches(doc, filter)) ?? null);
    },
    async updateOne(filter, update) {
      const doc = docs.find((entry) => matches(entry, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(doc, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      const hits = docs.filter((entry) => matches(entry, filter));
      hits.forEach((doc) => applyUpdate(doc, update));
      return { matchedCount: hits.length, modifiedCount: hits.length };
    },
    async create(doc) {
      const created = {
        _id: `0000000000000000000000${++counter}`.slice(-24),
        ...doc,
      };
      docs.push(created);
      return created;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function userDoc({ id, name, role, pin, isActive = true }) {
  return {
    _id: id,
    name,
    role,
    isActive,
    email: `${name.toLowerCase()}@hotel.invalid`,
    pinHash: pin ? hashHotelPin(pin) : null,
    pinSetAt: new Date(Date.now() - 60 * 60 * 1000),
    pinFailedAttempts: 0,
    pinLockedUntil: null,
    lastLoginAt: null,
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  };
}

let state;
let rawToken;
let csrfToken;

function buildFixture() {
  rawToken = crypto.randomBytes(32).toString("base64url");
  csrfToken = deriveHotelSessionCsrfToken(rawToken);

  const users = [
    userDoc({ id: ID_MANAGER, name: "Manager", role: "MANAGER", pin: "1111" }),
    userDoc({ id: ID_RECEPTION, name: "Reception", role: "RECEPTIONIST", pin: "2222" }),
    userDoc({ id: ID_OTHER, name: "Other", role: "RECEPTIONIST", pin: "9999" }),
  ];

  const sessions = [
    {
      _id: SESSION_ID,
      hotelUserId: ID_MANAGER,
      tokenHash: hashHotelSessionToken(rawToken),
      csrfHash: hashHotelCsrfToken(csrfToken),
      roleSnapshot: "MANAGER",
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      idleExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      revokedAt: null,
      revokeReason: null,
      createdAt: new Date(Date.now() - 60 * 1000),
    },
  ];

  state = {
    connection: {
      models: {
        HotelUser: createFakeModel(users),
        HotelSession: createFakeModel(sessions),
        HotelAuditLog: createFakeModel([]),
      },
    },
  };
  setHotelFakeConnection(state.connection);
}

function makeRequest({
  body,
  withCookie = true,
  withCsrf = true,
  origin = "http://localhost:3000",
  url = "http://localhost:3000/api/hotel/auth/change-pin",
  method = "POST",
} = {}) {
  const headers = new Headers({
    origin,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    accept: "application/json",
  });
  if (withCookie) headers.set("cookie", `${HOTEL_SESSION_COOKIE}=${rawToken}`);
  if (withCsrf) headers.set(HOTEL_CSRF_HEADER, csrfToken);
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function userById(id) {
  return state.connection.models.HotelUser.docs.find((doc) => doc._id === id);
}

async function callChangePin(request) {
  const response = await changePinRoute.POST(request, {});
  const payload = await response.json();
  return { response, payload };
}

beforeEach(() => {
  clearHotelFakeConnection();
  resetHotelRateLimitStore();
  buildFixture();
});

// ---------------------------------------------------------------------------
// Self-service PIN change
// ---------------------------------------------------------------------------

describe("POST /api/hotel/auth/change-pin", () => {
  test("changes the caller's PIN, revokes sessions and writes an audit record", async () => {
    const { response, payload } = await callChangePin(
      makeRequest({
        body: { currentPin: "1111", newPin: "4321", confirmPin: "4321" },
      })
    );

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.changed, true);

    const manager = userById(ID_MANAGER);
    assert.equal(verifyHotelPin("4321", manager.pinHash), true, "new PIN persisted");
    assert.equal(verifyHotelPin("1111", manager.pinHash), false, "old PIN rejected");
    assert.equal(manager.pinFailedAttempts, 0);
    assert.equal(manager.pinLockedUntil, null);

    const session = state.connection.models.HotelSession.docs.find(
      (doc) => doc._id === SESSION_ID
    );
    assert.ok(session.revokedAt, "the acting session is revoked");
    assert.equal(session.revokeReason, "SECURITY");

    const audits = state.connection.models.HotelAuditLog.docs;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "STAFF_SELF_PIN_CHANGED");
    assert.equal(audits[0].outcome, "SUCCESS");
  });

  test("a wrong current PIN is rejected and nothing changes", async () => {
    const { response, payload } = await callChangePin(
      makeRequest({
        body: { currentPin: "0000", newPin: "4321", confirmPin: "4321" },
      })
    );

    assert.equal(response.status, 401);
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, "INVALID_CREDENTIALS");

    const manager = userById(ID_MANAGER);
    assert.equal(verifyHotelPin("1111", manager.pinHash), true);
    assert.equal(verifyHotelPin("4321", manager.pinHash), false);
  });

  test("mismatched confirmation is rejected before any write", async () => {
    const { response, payload } = await callChangePin(
      makeRequest({
        body: { currentPin: "1111", newPin: "4321", confirmPin: "4322" },
      })
    );

    assert.equal(response.status, 422);
    assert.equal(payload.error.message, "New PIN and Confirm PIN do not match");
    assert.equal(verifyHotelPin("1111", userById(ID_MANAGER).pinHash), true);
  });

  test("the new PIN must differ from the current PIN", async () => {
    const { response, payload } = await callChangePin(
      makeRequest({
        body: { currentPin: "1111", newPin: "1111", confirmPin: "1111" },
      })
    );

    assert.equal(response.status, 422);
    assert.equal(payload.error.message, "New PIN must differ from current PIN");
  });

  test("a non-4-digit PIN is rejected", async () => {
    const { response } = await callChangePin(
      makeRequest({
        body: { currentPin: "1111", newPin: "12345", confirmPin: "12345" },
      })
    );
    assert.equal(response.status, 422);
    assert.equal(verifyHotelPin("1111", userById(ID_MANAGER).pinHash), true);
  });

  test("a PIN used by another identity is rejected with a conflict", async () => {
    const { response, payload } = await callChangePin(
      makeRequest({
        body: { currentPin: "1111", newPin: "9999", confirmPin: "9999" },
      })
    );

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, "CONFLICT");
    assert.equal(verifyHotelPin("1111", userById(ID_MANAGER).pinHash), true);
    assert.equal(verifyHotelPin("9999", userById(ID_OTHER).pinHash), true);
  });

  test("the request is refused without the CSRF header", async () => {
    const { response, payload } = await callChangePin(
      makeRequest({
        body: { currentPin: "1111", newPin: "4321", confirmPin: "4321" },
        withCsrf: false,
      })
    );

    assert.equal(response.status, 403);
    assert.equal(payload.error.code, "CSRF_VALIDATION_FAILED");
    assert.equal(verifyHotelPin("1111", userById(ID_MANAGER).pinHash), true);
  });

  test("the request is refused from a foreign Origin", async () => {
    const { response } = await callChangePin(
      makeRequest({
        body: { currentPin: "1111", newPin: "4321", confirmPin: "4321" },
        origin: "https://evil.example",
      })
    );
    assert.equal(response.status, 403);
    assert.equal(verifyHotelPin("1111", userById(ID_MANAGER).pinHash), true);
  });

  test("the request is refused without a session cookie", async () => {
    const { response, payload } = await callChangePin(
      makeRequest({
        body: { currentPin: "1111", newPin: "4321", confirmPin: "4321" },
        withCookie: false,
      })
    );
    assert.equal(response.status, 401);
    assert.equal(payload.error.code, "AUTHENTICATION_REQUIRED");
  });

  test("the caller cannot choose another identity", async () => {
    // A staffId field is ignored: the target is always the session identity.
    const { response } = await callChangePin(
      makeRequest({
        body: {
          currentPin: "1111",
          newPin: "4321",
          confirmPin: "4321",
          staffId: ID_RECEPTION,
          hotelUserId: ID_RECEPTION,
        },
      })
    );

    assert.equal(response.status, 200);
    assert.equal(verifyHotelPin("4321", userById(ID_MANAGER).pinHash), true);
    assert.equal(verifyHotelPin("2222", userById(ID_RECEPTION).pinHash), true);
  });
});

// ---------------------------------------------------------------------------
// Manager reset of a Receptionist PIN
// ---------------------------------------------------------------------------

describe("POST /api/hotel/staff/[id]/pin", () => {
  function resetRequest(body) {
    return makeRequest({
      body,
      url: `http://localhost:3000/api/hotel/staff/${ID_RECEPTION}/pin`,
    });
  }

  async function callReset(request) {
    const response = await staffPinRoute.POST(request, {
      params: Promise.resolve({ id: ID_RECEPTION }),
    });
    const payload = await response.json();
    return { response, payload };
  }

  test("resets a Receptionist PIN and revokes that identity's sessions", async () => {
    // Give the Receptionist a live session so revocation has work to do.
    state.connection.models.HotelSession.docs.push({
      _id: "65b000000000000000000002",
      hotelUserId: ID_RECEPTION,
      tokenHash: hashHotelSessionToken(
        crypto.randomBytes(32).toString("base64url")
      ),
      csrfHash: hashHotelCsrfToken(csrfToken),
      roleSnapshot: "RECEPTIONIST",
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      idleExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      revokedAt: null,
      revokeReason: null,
      createdAt: new Date(Date.now() - 60 * 1000),
    });

    const { response, payload } = await callReset(
      resetRequest({ pin: "7788", confirmPin: "7788" })
    );

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.staff.id, ID_RECEPTION);
    assert.equal(payload.data.sessionsRevoked, true);

    const reception = userById(ID_RECEPTION);
    assert.equal(verifyHotelPin("7788", reception.pinHash), true);
    assert.equal(verifyHotelPin("2222", reception.pinHash), false);
    assert.equal(String(reception.updatedByStaffId), ID_MANAGER);

    const revoked = state.connection.models.HotelSession.docs.find(
      (doc) => doc._id === "65b000000000000000000002"
    );
    assert.ok(revoked.revokedAt, "receptionist session revoked");

    const actions = state.connection.models.HotelAuditLog.docs.map(
      (doc) => doc.action
    );
    assert.ok(actions.includes("STAFF_PIN_RESET"));
  });

  test("rejects a PIN already used by another identity", async () => {
    const { response, payload } = await callReset(
      resetRequest({ pin: "9999", confirmPin: "9999" })
    );

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, "CONFLICT");
    assert.equal(verifyHotelPin("2222", userById(ID_RECEPTION).pinHash), true);
  });

  test("rejects mismatched confirmation", async () => {
    const { response } = await callReset(
      resetRequest({ pin: "7788", confirmPin: "7789" })
    );
    assert.equal(response.status, 422);
    assert.equal(verifyHotelPin("2222", userById(ID_RECEPTION).pinHash), true);
  });
});
