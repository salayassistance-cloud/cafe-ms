// Regression tests for the Hotel PIN-change HTTP 500 caused by lean-document
// ObjectIds. Existing Hotel PIN tests seed string `_id` values, so they never
// exercised the real Mongoose `.lean()` return shape. These tests use real
// bson ObjectIds (no database, no network, no credentials) and execute the
// real Route Handlers against the in-memory Hotel connection fake.
//
// Run with:
//   node --test tests/hotel-pin-change-objectid-regression.test.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { register } from "node:module";
import mongoose from "mongoose";
import { beforeEach, describe, test } from "node:test";

// Redirects ONLY the Hotel DB connection module to the in-memory fake.
register("./helpers/hotel-route-loader.mjs", import.meta.url);

process.env.HOTEL_SESSION_SECRET =
  "test-only-hotel-session-secret-0123456789abcdef";
process.env.AUTH_SECRET = "test-only-pos-auth-secret-0123456789abcdef";

const { setHotelFakeConnection, clearHotelFakeConnection } = await import(
  "./helpers/hotel-route-fake-db.mjs"
);
const { hashHotelPin, verifyHotelPin } = await import(
  "../lib/hotel/auth/pin.js"
);
const { setHotelUserPin } = await import(
  "../lib/hotel/auth/credential.js"
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

const changePinRoute = await import(
  "../app/api/hotel/auth/change-pin/route.js"
);
const staffPinRoute = await import(
  "../app/api/hotel/staff/[id]/pin/route.js"
);

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
      if ("$in" in condition) {
        if (!condition.$in.some((entry) => sameId(value, entry))) return false;
        continue;
      }
    }
    if (!sameId(value, condition)) return false;
  }
  return true;
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
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      const hits = docs.filter((entry) => matches(entry, filter));
      hits.forEach((doc) => {
        if (update.$set) Object.assign(doc, update.$set);
      });
      return { matchedCount: hits.length, modifiedCount: hits.length };
    },
    async create(doc) {
      const created = {
        _id: new mongoose.Types.ObjectId(),
        ...doc,
        createdAt: new Date(`2026-01-01T00:00:${String(++counter).padStart(2, "0")}.000Z`),
      };
      docs.push(created);
      return created;
    },
    async deleteOne(filter) {
      const index = docs.findIndex((entry) => matches(entry, filter));
      if (index === -1) return { deletedCount: 0 };
      docs.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
}

function userDoc({ id, name, role, pin }) {
  return {
    _id: id, // real ObjectId, as returned by a real Mongoose `.lean()`
    name,
    role,
    isActive: true,
    email: `${name.toLowerCase()}@hotel.invalid`,
    pinHash: hashHotelPin(pin),
    pinSetAt: new Date(Date.now() - 60 * 60 * 1000),
    pinFailedAttempts: 0,
    pinLockedUntil: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

let state;
let rawToken;
let csrfToken;
let managerId;
let receptionId;
let sessionId;

beforeEach(() => {
  clearHotelFakeConnection();
  resetHotelRateLimitStore();

  managerId = new mongoose.Types.ObjectId();
  receptionId = new mongoose.Types.ObjectId();
  sessionId = new mongoose.Types.ObjectId();
  rawToken = crypto.randomBytes(32).toString("base64url");
  csrfToken = deriveHotelSessionCsrfToken(rawToken);

  const users = [
    userDoc({ id: managerId, name: "Manager", role: "MANAGER", pin: "1111" }),
    userDoc({ id: receptionId, name: "Reception", role: "RECEPTIONIST", pin: "2222" }),
  ];
  const sessions = [
    {
      _id: sessionId,
      hotelUserId: managerId,
      tokenHash: hashHotelSessionToken(rawToken),
      csrfHash: hashHotelCsrfToken(csrfToken),
      roleSnapshot: "MANAGER",
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      idleExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      revokedAt: null,
      revokeReason: null,
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
});

function makeRequest(body, url = "http://localhost:3000/api/hotel/auth/change-pin") {
  const headers = new Headers({
    origin: "http://localhost:3000",
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  });
  headers.set("cookie", `${HOTEL_SESSION_COOKIE}=${rawToken}`);
  headers.set(HOTEL_CSRF_HEADER, csrfToken);
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("setHotelUserPin with a real bson ObjectId", () => {
  test("accepts the `_id` shape returned by a real Mongoose `.lean()` query", async () => {
    const id = new mongoose.Types.ObjectId();
    const connection = {
      models: { HotelUser: createFakeModel([userDoc({ id, name: "T", role: "RECEPTIONIST", pin: "1234" })]) },
    };
    await assert.doesNotReject(() => setHotelUserPin(connection, id, "5678"));
    const stored = connection.models.HotelUser.docs[0];
    assert.equal(verifyHotelPin("5678", stored.pinHash), true);
    assert.equal(verifyHotelPin("1234", stored.pinHash), false);
  });
});

describe("PIN change routes with lean-style ObjectIds", () => {
  test("self-service change returns 200, persists the new PIN and revokes the session", async () => {
    const response = await changePinRoute.POST(
      makeRequest({ currentPin: "1111", newPin: "4321", confirmPin: "4321" })
    );
    const payload = await response.json();

    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.success, true);

    const manager = state.connection.models.HotelUser.docs.find((doc) =>
      sameId(doc._id, managerId)
    );
    assert.equal(verifyHotelPin("4321", manager.pinHash), true);
    assert.equal(verifyHotelPin("1111", manager.pinHash), false);

    const session = state.connection.models.HotelSession.docs[0];
    assert.ok(session.revokedAt, "acting session must be revoked");
    assert.equal(session.revokeReason, "SECURITY");

    assert.equal(state.connection.models.HotelAuditLog.docs.length, 1);
    assert.equal(
      state.connection.models.HotelAuditLog.docs[0].action,
      "STAFF_SELF_PIN_CHANGED"
    );
  });

  test("Manager reset of a Receptionist PIN succeeds with lean-style ObjectIds", async () => {
    const url = `http://localhost:3000/api/hotel/staff/${String(receptionId)}/pin`;
    const response = await staffPinRoute.POST(makeRequest(
      { pin: "7788", confirmPin: "7788" },
      url
    ), { params: Promise.resolve({ id: String(receptionId) }) });
    const payload = await response.json();

    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.success, true);

    const reception = state.connection.models.HotelUser.docs.find((doc) =>
      sameId(doc._id, receptionId)
    );
    assert.equal(verifyHotelPin("7788", reception.pinHash), true);
    assert.equal(verifyHotelPin("2222", reception.pinHash), false);
  });
});
