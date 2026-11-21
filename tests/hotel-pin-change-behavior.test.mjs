// Behavioral (DB-free) tests for the Hotel PIN change paths.
//
// The pre-existing Hotel tests for PIN change are source-string assertions:
// they prove the route *mentions* the right calls, not that a PIN is actually
// replaced and that the old PIN stops working. These tests execute the real
// service code against an in-memory Mongoose-like model so the credential
// lifecycle is observed end to end:
//
//   hash -> persist -> verify(new)=true -> verify(old)=false
//
// Covered paths:
//   1. self-service change (setHotelUserPin + verifyHotelPin)
//   2. Manager reset of a Receptionist PIN (resetReceptionistPin)
//   3. collision rejection and self-exclusion
//   4. session revocation after a credential change
//
// No database, no network, no production code modification.

import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";

import {
  findHotelPinCollision,
  getHotelUserWithPin,
  recordFailedHotelPinAttempt,
  setHotelUserPin,
  verifyHotelUserPin,
} from "../lib/hotel/auth/credential.js";
import {
  resetReceptionistPin,
  snapshotManagedStaff,
} from "../lib/hotel/auth/staffService.js";
import { hashHotelPin, verifyHotelPin } from "../lib/hotel/auth/pin.js";

// ---------------------------------------------------------------------------
// Minimal in-memory Mongoose model: supports the query surface used by the
// Hotel auth services (findById/find/findOne + select/lean, updateOne,
// updateMany, create). It is intentionally small and synchronous under the
// hood so a test can assert persisted state directly.
// ---------------------------------------------------------------------------

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

// Minimal MongoDB aggregation-expression evaluator. The production lockout
// write uses a pipeline update (atomic increment + threshold lock), so the fake
// model must understand the few operators it uses or the harness would report
// a false failure that is not a product defect.
function resolveExpression(expr, doc) {
  if (typeof expr === "string" && expr.startsWith("$")) {
    return doc[expr.slice(1)];
  }
  if (Array.isArray(expr)) return expr.map((entry) => resolveExpression(entry, doc));
  if (expr && typeof expr === "object") {
    if ("$cond" in expr) {
      const [condition, whenTrue, whenFalse] = expr.$cond;
      return resolveExpression(condition, doc)
        ? resolveExpression(whenTrue, doc)
        : resolveExpression(whenFalse, doc);
    }
    if ("$add" in expr) {
      return expr.$add.reduce(
        (sum, entry) => sum + Number(resolveExpression(entry, doc) || 0),
        0
      );
    }
    if ("$ifNull" in expr) {
      const [first, fallback] = expr.$ifNull;
      const value = resolveExpression(first, doc);
      return value === null || value === undefined
        ? resolveExpression(fallback, doc)
        : value;
    }
    if ("$ne" in expr) {
      const [left, right] = expr.$ne;
      return resolveExpression(left, doc) !== resolveExpression(right, doc);
    }
    if ("$lte" in expr) {
      const [left, right] = expr.$lte;
      return resolveExpression(left, doc) <= resolveExpression(right, doc);
    }
    if ("$gte" in expr) {
      const [left, right] = expr.$gte;
      return resolveExpression(left, doc) >= resolveExpression(right, doc);
    }
    if ("$and" in expr) {
      return expr.$and.every((entry) => Boolean(resolveExpression(entry, doc)));
    }
  }
  return expr;
}

function applyUpdate(doc, update) {
  if (Array.isArray(update)) {
    // Pipeline stages observe the document state left by previous stages.
    for (const stage of update) {
      if (stage.$set) {
        for (const [key, expr] of Object.entries(stage.$set)) {
          doc[key] = resolveExpression(expr, doc);
        }
      }
    }
    return;
  }
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$unset) {
    for (const key of Object.keys(update.$unset)) delete doc[key];
  }
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
      const created = { _id: `0000000000000000000000${++counter}`.slice(-24), ...doc };
      docs.push(created);
      return created;
    },
  };
}

function makeConnection({ users = [], sessions = [] } = {}) {
  return {
    models: {
      HotelUser: createFakeModel(users),
      HotelSession: createFakeModel(sessions),
    },
  };
}

const ID_MANAGER = "64b000000000000000000001";
const ID_RECEPTION = "64b000000000000000000002";
const ID_OTHER = "64b000000000000000000003";

function userDoc({ id, name, role, pin, isActive = true }) {
  return {
    _id: id,
    name,
    role,
    isActive,
    email: `${name.toLowerCase()}@hotel.invalid`,
    pinHash: pin ? hashHotelPin(pin) : null,
    pinSetAt: new Date("2026-01-01T00:00:00.000Z"),
    pinFailedAttempts: 0,
    pinLockedUntil: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("Hotel PIN primitives", () => {
  test("a hashed PIN verifies only for the exact four digits", () => {
    const stored = hashHotelPin("2468");
    assert.equal(verifyHotelPin("2468", stored), true);
    assert.equal(verifyHotelPin("2469", stored), false);
    assert.equal(verifyHotelPin("246", stored), false);
    assert.equal(verifyHotelPin("24680", stored), false);
    assert.equal(verifyHotelPin("", stored), false);
  });

  test("hashes are salted: the same PIN hashes differently", () => {
    assert.notEqual(hashHotelPin("1357"), hashHotelPin("1357"));
  });
});

describe("self-service PIN change (setHotelUserPin)", () => {
  let connection;

  beforeEach(() => {
    connection = makeConnection({
      users: [
        userDoc({ id: ID_MANAGER, name: "Manager", role: "MANAGER", pin: "1111" }),
        userDoc({ id: ID_RECEPTION, name: "Reception", role: "RECEPTIONIST", pin: "2222" }),
      ],
    });
  });

  test("persists the new PIN and invalidates the old one", async () => {
    await setHotelUserPin(connection, ID_RECEPTION, "3456");

    const stored = await getHotelUserWithPin(connection, ID_RECEPTION);
    assert.equal(verifyHotelPin("3456", stored.pinHash), true, "new PIN must verify");
    assert.equal(verifyHotelPin("2222", stored.pinHash), false, "old PIN must fail");
    assert.equal(stored.pinFailedAttempts, 0);
    assert.equal(stored.pinLockedUntil, null);
  });

  test("login verification accepts the new PIN and rejects the old one", async () => {
    await setHotelUserPin(connection, ID_RECEPTION, "3456");

    const withNew = await verifyHotelUserPin(connection, {
      identityId: ID_RECEPTION,
      pin: "3456",
    });
    assert.equal(withNew.ok, true);
    assert.equal(withNew.role, "RECEPTIONIST");

    const withOld = await verifyHotelUserPin(connection, {
      identityId: ID_RECEPTION,
      pin: "2222",
    });
    assert.equal(withOld.ok, false);
    assert.equal(withOld.reason, "INVALID_CREDENTIALS");
  });

  test("a PIN locked by failed attempts is unlocked by the change", async () => {
    const model = connection.models.HotelUser;
    const target = model.docs.find((doc) => doc._id === ID_RECEPTION);
    target.pinFailedAttempts = 5;
    target.pinLockedUntil = new Date(Date.now() + 10 * 60 * 1000);

    const locked = await verifyHotelUserPin(connection, {
      identityId: ID_RECEPTION,
      pin: "2222",
    });
    assert.equal(locked.ok, false, "locked identity cannot authenticate");

    await setHotelUserPin(connection, ID_RECEPTION, "3456");
    const after = await verifyHotelUserPin(connection, {
      identityId: ID_RECEPTION,
      pin: "3456",
    });
    assert.equal(after.ok, true, "changing the PIN clears the lock");
  });

  test("the same PIN may not be assigned to two identities", async () => {
    const collision = await findHotelPinCollision(connection, "1111", {
      exceptUserId: ID_RECEPTION,
    });
    assert.equal(collision, ID_MANAGER);
  });

  test("collision scan excludes the acting identity", async () => {
    const self = await findHotelPinCollision(connection, "2222", {
      exceptUserId: ID_RECEPTION,
    });
    assert.equal(self, null, "an identity may keep its own PIN");
  });
});

describe("Manager reset of a Receptionist PIN (resetReceptionistPin)", () => {
  let connection;

  beforeEach(() => {
    connection = makeConnection({
      users: [
        userDoc({ id: ID_MANAGER, name: "Manager", role: "MANAGER", pin: "1111" }),
        userDoc({ id: ID_RECEPTION, name: "Reception", role: "RECEPTIONIST", pin: "2222" }),
        userDoc({ id: ID_OTHER, name: "Other", role: "RECEPTIONIST", pin: "9999" }),
      ],
    });
  });

  test("changes the target PIN, keeps other identities untouched", async () => {
    const updated = await resetReceptionistPin(
      connection,
      ID_RECEPTION,
      "7788",
      ID_MANAGER
    );

    assert.equal(updated.id, ID_RECEPTION);
    assert.equal(updated.role, "RECEPTIONIST");

    const target = await getHotelUserWithPin(connection, ID_RECEPTION);
    assert.equal(verifyHotelPin("7788", target.pinHash), true);
    assert.equal(verifyHotelPin("2222", target.pinHash), false);
    assert.equal(String(target.updatedByStaffId), ID_MANAGER);

    const other = await getHotelUserWithPin(connection, ID_OTHER);
    assert.equal(verifyHotelPin("9999", other.pinHash), true, "other staff unchanged");

    const manager = await getHotelUserWithPin(connection, ID_MANAGER);
    assert.equal(verifyHotelPin("1111", manager.pinHash), true, "manager unchanged");
  });

  test("rejects a PIN already used by another identity", async () => {
    await assert.rejects(
      () => resetReceptionistPin(connection, ID_RECEPTION, "9999", ID_MANAGER),
      (error) => error?.status === 409
    );

    const target = await getHotelUserWithPin(connection, ID_RECEPTION);
    assert.equal(verifyHotelPin("2222", target.pinHash), true, "PIN unchanged on conflict");
  });

  test("refuses to reset a Manager account", async () => {
    await assert.rejects(
      () => resetReceptionistPin(connection, ID_MANAGER, "7788", ID_MANAGER),
      (error) => error?.status === 403
    );
  });

  test("snapshot captures the credential state used for compensation", async () => {
    const { before } = await snapshotManagedStaff(connection, ID_RECEPTION);
    assert.ok(before.pinHash, "snapshot includes the PIN hash");
    assert.equal(verifyHotelPin("2222", before.pinHash), true);
  });
});

describe("session revocation after a credential change", () => {
  test("all live sessions for the user are revoked, others untouched", async () => {
    const { revokeAllHotelSessionsForUser } = await import(
      "../lib/hotel/auth/session.js"
    );
    const connection = makeConnection({
      users: [],
      sessions: [
        { _id: "s1", hotelUserId: ID_RECEPTION, revokedAt: null },
        { _id: "s2", hotelUserId: ID_RECEPTION, revokedAt: null },
        { _id: "s3", hotelUserId: ID_MANAGER, revokedAt: null },
      ],
    });

    const revoked = await revokeAllHotelSessionsForUser(
      connection,
      ID_RECEPTION,
      "SECURITY"
    );
    assert.equal(revoked, 2);

    const sessions = connection.models.HotelSession.docs;
    assert.equal(sessions.filter((s) => s.revokedAt).length, 2);
    const managerSession = sessions.find((s) => s._id === "s3");
    assert.equal(managerSession.revokedAt, null);
    assert.equal(
      sessions.find((s) => s._id === "s1").revokeReason,
      "SECURITY"
    );
  });
});

describe("failed-attempt accounting", () => {
  test("five wrong PINs lock the identity", async () => {
    const connection = makeConnection({
      users: [userDoc({ id: ID_RECEPTION, name: "Reception", role: "RECEPTIONIST", pin: "2222" })],
    });

    let locked = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await verifyHotelUserPin(connection, {
        identityId: ID_RECEPTION,
        pin: "0000",
      });
      assert.equal(result.ok, false);
      const outcome = await recordFailedHotelPinAttempt(connection, ID_RECEPTION, {
        failedAttempts: result.failedAttempts,
        wasLocked: result.wasLocked,
      });
      locked = outcome.locked;
    }
    assert.equal(locked, true, "the fifth failure crosses the lock threshold");

    const afterLock = await verifyHotelUserPin(connection, {
      identityId: ID_RECEPTION,
      pin: "2222",
    });
    assert.equal(afterLock.ok, false, "a locked identity rejects even the correct PIN");
  });
});
