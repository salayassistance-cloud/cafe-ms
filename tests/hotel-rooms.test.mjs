// Hotel Room and RoomType backend tests — DB-free.
//
// No MongoDB connection is opened and no index is created. Services and route
// handlers use an in-memory stub connection so duplicate, deactivation, status,
// authorization, CSRF, and audit behavior can be exercised deterministically.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import {
  HOTEL_CSRF_HEADER,
  HOTEL_SESSION_COOKIE,
} from "../lib/hotel/constants.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
  HotelValidationError,
} from "../lib/hotel/errors.js";
import { HOTEL_AUDIT_ACTIONS } from "../lib/hotel/audit.js";
import { createHotelSession } from "../lib/hotel/auth/session.js";
import { toSafeHotelUser } from "../lib/hotel/models/hotelUser.js";
import { getRoomModel } from "../lib/hotel/models/room.js";
import { withHotelApi } from "../lib/hotel/http/apiResponse.js";
import {
  handleChangeRoomStatus,
  handleCreateRoom,
  handleDeactivateRoom,
  handleGetRoom,
  handleListRooms,
  handleUpdateRoom,
} from "../lib/hotel/http/roomHandlers.js";
import {
  handleCreateRoomType,
  handleDeactivateRoomType,
  handleGetRoomType,
  handleListRoomTypes,
  handleUpdateRoomType,
} from "../lib/hotel/http/roomTypeHandlers.js";
import {
  changeRoomStatus,
  createRoom,
  deactivateRoom,
  listRooms,
  updateRoom,
} from "../lib/hotel/services/rooms.js";
import {
  createRoomType,
  deactivateRoomType,
  updateRoomType,
} from "../lib/hotel/services/roomTypes.js";
import {
  validateRoomPayload,
  validateRoomStatusPayload,
  validateRoomTypePayload,
} from "../lib/hotel/validation.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (path) => readFileSync(join(root, path), "utf8");

const TEST_HOTEL_SECRET = "hotel-room-test-secret-independent-1234567890";
const TEST_MONGO_URI = "mongodb://127.0.0.1:27017/bono_hotel";
const TEST_ORIGIN = "https://hotel.example";

let previous = {};

before(() => {
  previous = {
    HOTEL_SESSION_SECRET: process.env.HOTEL_SESSION_SECRET,
    ROOM_MONGODB_URI: process.env.ROOM_MONGODB_URI,
    HOTEL_ALLOWED_ORIGINS: process.env.HOTEL_ALLOWED_ORIGINS,
  };
  process.env.HOTEL_SESSION_SECRET = TEST_HOTEL_SECRET;
  process.env.ROOM_MONGODB_URI = TEST_MONGO_URI;
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
    _id: new mongoose.Types.ObjectId(),
    email: "manager@example.com",
    name: "Hotel Manager",
    role: "MANAGER",
    isActive: true,
    lastLoginAt: null,
    ...overrides,
  };
}

function cloneRow(row) {
  if (!row) return null;
  const copy = { ...row };
  if (Array.isArray(row.statusHistory)) {
    copy.statusHistory = row.statusHistory.map((entry) => ({ ...entry }));
  }
  if (Array.isArray(row.amenities)) copy.amenities = [...row.amenities];
  return copy;
}

function matchesFilter(row, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    const actual = row[field];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$ne" in expected) return String(actual) !== String(expected.$ne);
      if ("$in" in expected) {
        const allowed = new Set(expected.$in.map((value) => String(value)));
        return allowed.has(String(actual));
      }
    }
    return String(actual) === String(expected);
  });
}

function makeFindQuery(initialRows) {
  let rows = [...initialRows];
  const query = {
    sort(spec) {
      rows.sort((left, right) => {
        for (const [field, direction] of Object.entries(spec)) {
          const leftValue =
            typeof left[field] === "number" ? left[field] : String(left[field]);
          const rightValue =
            typeof right[field] === "number"
              ? right[field]
              : String(right[field]);
          if (leftValue < rightValue) return -direction;
          if (leftValue > rightValue) return direction;
        }
        return 0;
      });
      return query;
    },
    skip(count) {
      rows = rows.slice(count);
      return query;
    },
    limit(count) {
      rows = rows.slice(0, count);
      return query;
    },
    select() {
      return query;
    },
    lean: async () => rows.map(cloneRow),
  };
  return query;
}

function duplicateKeyError() {
  const error = new Error("E11000 duplicate key error");
  error.code = 11000;
  return error;
}

function makeCollectionModel(state, key, { uniqueField = null } = {}) {
  const rows = state[key];

  const findRow = (filter) => rows.find((row) => matchesFilter(row, filter));

  return {
    findById(id) {
      return {
        lean: async () => {
          const row = rows.find((entry) => String(entry._id) === String(id));
          return cloneRow(row);
        },
      };
    },
    findOne(filter) {
      return {
        select: () => ({
          lean: async () => cloneRow(findRow(filter)),
        }),
      };
    },
    exists: async (filter) => {
      const row = findRow(filter);
      return row ? { _id: row._id } : null;
    },
    create: async (doc) => {
      if (uniqueField && rows.some((row) => row[uniqueField] === doc[uniqueField])) {
        throw duplicateKeyError();
      }
      if (state.duplicateCreate === key) {
        state.duplicateCreate = null;
        throw duplicateKeyError();
      }
      const now = new Date();
      const row = {
        ...doc,
        _id: new mongoose.Types.ObjectId(),
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return cloneRow(row);
    },
    updateOne: async (filter, update) => {
      const row = findRow(filter);
      if (!row) return { modifiedCount: 0 };
      if (update?.$set) Object.assign(row, update.$set);
      if (update?.$push) {
        for (const [field, value] of Object.entries(update.$push)) {
          if (!Array.isArray(row[field])) row[field] = [];
          row[field].push(value);
        }
      }
      row.updatedAt = new Date();
      return { modifiedCount: 1 };
    },
    countDocuments: async (filter) =>
      rows.filter((row) => matchesFilter(row, filter)).length,
    find: (filter) =>
      makeFindQuery(rows.filter((row) => matchesFilter(row, filter))),
  };
}

function createFakeConnection({ role = "MANAGER" } = {}) {
  const state = {
    user: makeUser({ role }),
    sessions: [],
    audits: [],
    roomTypes: [],
    rooms: [],
    auditFails: false,
    duplicateCreate: null,
  };

  const connection = {
    state,
    models: {
      HotelUser: {
        findById: () => ({
          select: () => ({
            lean: async () => cloneRow(state.user),
          }),
        }),
      },
      HotelSession: {
        create: async (doc) => {
          const row = { ...doc, _id: new mongoose.Types.ObjectId() };
          state.sessions.push(row);
          return cloneRow(row);
        },
        findOne: (filter) => ({
          select: () => ({
            lean: async () => {
              const row = state.sessions.find((entry) =>
                matchesFilter(entry, filter)
              );
              return cloneRow(row);
            },
          }),
        }),
        updateOne: async () => ({ modifiedCount: 1 }),
      },
      HotelAuditLog: {
        create: async (doc) => {
          if (state.auditFails) throw new Error("audit store unavailable");
          state.audits.push(doc);
          return { ...doc, _id: new mongoose.Types.ObjectId() };
        },
      },
      RoomType: makeCollectionModel(state, "roomTypes", {
        uniqueField: "code",
      }),
      Room: makeCollectionModel(state, "rooms", {
        uniqueField: "roomNumber",
      }),
    },
  };

  return connection;
}

function seedRoomType(connection, overrides = {}) {
  const now = new Date();
  const roomType = {
    _id: new mongoose.Types.ObjectId(),
    name: "Deluxe",
    code: "DLX",
    description: "",
    capacity: 2,
    baseNightlyRate: 120,
    amenities: ["Wi-Fi"],
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  connection.state.roomTypes.push(roomType);
  return roomType;
}

function seedRoom(connection, roomType, overrides = {}) {
  const now = new Date();
  const status = overrides.operationalStatus ?? "AVAILABLE";
  const room = {
    _id: new mongoose.Types.ObjectId(),
    roomNumber: "101",
    floor: 1,
    roomTypeId: roomType._id,
    capacity: 2,
    amenities: ["Wi-Fi"],
    nightlyRateOverride: null,
    isActive: true,
    operationalStatus: status,
    statusHistory: [
      {
        status,
        previousStatus: null,
        changedAt: now,
        changedBy: null,
        note: "",
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  connection.state.rooms.push(room);
  return room;
}

async function sessionFor(connection) {
  const { token, csrfToken } = await createHotelSession(connection, {
    hotelUserId: connection.state.user._id,
    role: connection.state.user.role,
  });
  return { token, csrfToken };
}

function buildRequest({
  method = "GET",
  path = "/api/hotel/rooms",
  token = null,
  csrfToken = null,
  origin = TEST_ORIGIN,
  body,
  headers = {},
} = {}) {
  const requestHeaders = { ...headers };
  if (origin !== null) requestHeaders.origin = origin;
  if (token) requestHeaders.cookie = `${HOTEL_SESSION_COOKIE}=${token}`;
  if (csrfToken) requestHeaders[HOTEL_CSRF_HEADER] = csrfToken;
  if (body !== undefined) requestHeaders["content-type"] = "application/json";

  return new Request(`${TEST_ORIGIN}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function runHandler(handler, request, context = {}, deps = {}) {
  return withHotelApi((req, ctx) => handler(req, ctx, deps))(request, context);
}

function paramsFor(id) {
  return { params: Promise.resolve({ id: String(id) }) };
}

function capture(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

function auditsFor(connection, action) {
  return connection.state.audits.filter((entry) => entry.action === action);
}

describe("Hotel room validation", () => {
  const roomTypeId = new mongoose.Types.ObjectId().toString();

  test("normalizes a room payload and applies safe defaults", () => {
    const result = validateRoomPayload({
      roomNumber: " 101-a ",
      floor: 1,
      roomTypeId,
      capacity: 2,
      amenities: ["TV", "TV", "Wi-Fi"],
      nightlyRateOverride: 99.999,
    });

    assert.equal(result.roomNumber, "101-A");
    assert.equal(result.floor, 1);
    assert.equal(result.roomTypeId, roomTypeId);
    assert.deepEqual(result.amenities, ["TV", "Wi-Fi"]);
    assert.equal(result.nightlyRateOverride, 100);
    assert.equal(result.isActive, true);
    assert.equal(result.operationalStatus, "AVAILABLE");
  });

  test("rejects invalid room fields and reservation-controlled statuses", () => {
    const error = capture(() =>
      validateRoomPayload({
        roomNumber: "A B",
        floor: 1.5,
        roomTypeId: "not-an-object-id",
        capacity: 0,
        operationalStatus: "OCCUPIED",
      })
    );

    assert.ok(error instanceof HotelValidationError);
    for (const field of [
      "roomNumber",
      "floor",
      "roomTypeId",
      "capacity",
      "operationalStatus",
    ]) {
      assert.ok(error.fieldErrors[field], `${field} should be rejected`);
    }
  });

  test("requires status changes through the dedicated payload", () => {
    const partialError = capture(() =>
      validateRoomPayload(
        { operationalStatus: "CLEANING" },
        { partial: true }
      )
    );
    assert.ok(partialError instanceof HotelValidationError);
    assert.match(
      partialError.fieldErrors.operationalStatus,
      /status endpoint/
    );

    for (const status of ["OCCUPIED", "RESERVED"]) {
      const error = capture(() =>
        validateRoomStatusPayload({ operationalStatus: status })
      );
      assert.ok(error instanceof HotelValidationError);
      assert.ok(error.fieldErrors.operationalStatus);
    }

    const accepted = validateRoomStatusPayload({
      operationalStatus: "cleaning",
      note: " deep clean ",
    });
    assert.deepEqual(accepted, {
      operationalStatus: "CLEANING",
      note: "deep clean",
    });
  });

  test("rejects empty partial updates and normalizes partial room types", () => {
    const emptyRoom = capture(() => validateRoomPayload({}, { partial: true }));
    assert.ok(emptyRoom instanceof HotelValidationError);
    assert.equal(emptyRoom.fieldErrors.body, "at least one field is required");

    const emptyRoomType = validateRoomTypePayload({}, { partial: true });
    assert.deepEqual(emptyRoomType, {});

    const partialType = validateRoomTypePayload(
      { code: "dlx" },
      { partial: true }
    );
    assert.equal(partialType.code, "DLX");

    const invalidType = capture(() =>
      validateRoomTypePayload({ code: "bad code" }, { partial: true })
    );
    assert.ok(invalidType instanceof HotelValidationError);
    assert.ok(invalidType.fieldErrors.code);
  });
});

describe("Hotel RoomType service", () => {
  test("creates a room type and records a success audit", async () => {
    const connection = createFakeConnection();
    const actor = toSafeHotelUser(connection.state.user);

    const result = await createRoomType({
      connection,
      input: {
        name: "Deluxe",
        code: "dlx",
        capacity: 2,
        baseNightlyRate: 120.555,
        amenities: ["Wi-Fi"],
      },
      actor,
    });

    assert.equal(result.roomType.code, "DLX");
    assert.equal(result.roomType.baseNightlyRate, 120.56);
    assert.equal(connection.state.roomTypes.length, 1);

    const audits = auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_TYPE_CREATED);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, "SUCCESS");
    assert.equal(audits[0].entityType, "RoomType");
    assert.equal(audits[0].entityId, result.roomType.id);
    assert.equal(String(audits[0].actorUserId), actor.id);
    assert.equal(audits[0].actorRole, "MANAGER");
  });

  test("rejects duplicate codes before writing and maps duplicate-key races", async () => {
    const connection = createFakeConnection();
    seedRoomType(connection, { code: "DLX" });

    const duplicate = await createRoomType({
      connection,
      input: {
        name: "Another Deluxe",
        code: "dlx",
        capacity: 2,
        baseNightlyRate: 150,
      },
    }).catch((error) => error);

    assert.ok(duplicate instanceof HotelApiError);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.code, HOTEL_ERROR_CODES.CONFLICT);
    assert.equal(connection.state.roomTypes.length, 1);
    assert.equal(connection.state.audits.length, 0);

    connection.state.duplicateCreate = "roomTypes";
    const race = await createRoomType({
      connection,
      input: {
        name: "Suite",
        code: "STE",
        capacity: 4,
        baseNightlyRate: 250,
      },
    }).catch((error) => error);

    assert.ok(race instanceof HotelApiError);
    assert.equal(race.status, 409);
    assert.equal(connection.state.roomTypes.length, 1);
  });

  test("update rejects a duplicate code and leaves the record unchanged", async () => {
    const connection = createFakeConnection();
    seedRoomType(connection, { name: "Deluxe", code: "DLX" });
    const suite = seedRoomType(connection, { name: "Suite", code: "STE" });

    const duplicate = await updateRoomType({
      connection,
      id: String(suite._id),
      input: { code: "dlx" },
    }).catch((error) => error);

    assert.ok(duplicate instanceof HotelApiError);
    assert.equal(duplicate.status, 409);
    assert.equal(suite.code, "STE");
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_TYPE_UPDATED).length,
      0
    );
  });

  test("deactivation is refused while active rooms reference the type", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const room = seedRoom(connection, roomType);

    const refused = await deactivateRoomType({
      connection,
      id: String(roomType._id),
    }).catch((error) => error);

    assert.ok(refused instanceof HotelApiError);
    assert.equal(refused.status, 409);
    assert.equal(roomType.isActive, true);
    assert.equal(auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_TYPE_DEACTIVATED).length, 0);

    room.isActive = false;
    const deactivated = await deactivateRoomType({
      connection,
      id: String(roomType._id),
    });
    assert.equal(deactivated.changed, true);
    assert.equal(deactivated.roomType.isActive, false);
    assert.equal(roomType.isActive, false);
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_TYPE_DEACTIVATED).length,
      1
    );

    const again = await deactivateRoomType({
      connection,
      id: String(roomType._id),
    });
    assert.equal(again.changed, false);
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_TYPE_DEACTIVATED).length,
      1
    );
  });

  test("generic updates cannot deactivate but can reactivate", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);

    const refused = await updateRoomType({
      connection,
      id: String(roomType._id),
      input: { isActive: false },
    }).catch((error) => error);
    assert.ok(refused instanceof HotelValidationError);
    assert.ok(refused.fieldErrors.isActive);

    await deactivateRoomType({
      connection,
      id: String(roomType._id),
    });
    assert.equal(roomType.isActive, false);

    const reactivated = await updateRoomType({
      connection,
      id: String(roomType._id),
      input: { isActive: true },
    });
    assert.equal(reactivated.roomType.isActive, true);
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_TYPE_UPDATED).length,
      1
    );
  });
});

describe("Hotel Room service", () => {
  test("creates a room with status history, effective rate, and audit", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const actor = toSafeHotelUser(connection.state.user);

    const result = await createRoom({
      connection,
      input: {
        roomNumber: "101",
        floor: 1,
        roomTypeId: String(roomType._id),
        capacity: 2,
        amenities: ["TV"],
      },
      actor,
    });

    assert.equal(result.room.roomNumber, "101");
    assert.equal(result.room.roomType.id, String(roomType._id));
    assert.equal(result.room.effectiveNightlyRate, 120);
    assert.equal(result.room.operationalStatus, "AVAILABLE");
    assert.equal(result.room.statusHistory.length, 1);
    assert.equal(result.room.statusHistory[0].status, "AVAILABLE");
    assert.equal(String(result.room.statusHistory[0].changedBy), actor.id);

    const audits = auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_CREATED);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].entityType, "Room");
    assert.equal(audits[0].entityId, result.room.id);
    assert.equal(audits[0].metadata.roomNumber, "101");
  });

  test("rejects duplicate room numbers and inactive or missing room types", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    seedRoom(connection, roomType, { roomNumber: "101" });

    const duplicate = await createRoom({
      connection,
      input: {
        roomNumber: "101",
        floor: 1,
        roomTypeId: String(roomType._id),
        capacity: 2,
      },
    }).catch((error) => error);

    assert.ok(duplicate instanceof HotelApiError);
    assert.equal(duplicate.status, 409);
    assert.equal(connection.state.rooms.length, 1);

    connection.state.duplicateCreate = "rooms";
    const race = await createRoom({
      connection,
      input: {
        roomNumber: "104",
        floor: 1,
        roomTypeId: String(roomType._id),
        capacity: 2,
      },
    }).catch((error) => error);
    assert.ok(race instanceof HotelApiError);
    assert.equal(race.status, 409);
    assert.equal(connection.state.rooms.length, 1);

    roomType.isActive = false;
    const inactive = await createRoom({
      connection,
      input: {
        roomNumber: "102",
        floor: 1,
        roomTypeId: String(roomType._id),
        capacity: 2,
      },
    }).catch((error) => error);
    assert.ok(inactive instanceof HotelValidationError);
    assert.ok(inactive.fieldErrors.roomTypeId);

    const missing = await createRoom({
      connection,
      input: {
        roomNumber: "103",
        floor: 1,
        roomTypeId: new mongoose.Types.ObjectId().toString(),
        capacity: 2,
      },
    }).catch((error) => error);
    assert.ok(missing instanceof HotelValidationError);
    assert.ok(missing.fieldErrors.roomTypeId);
    assert.equal(connection.state.rooms.length, 1);
  });

  test("updates fields, prevents duplicate numbers, and gates reactivation", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const first = seedRoom(connection, roomType, { roomNumber: "101" });
    seedRoom(connection, roomType, { roomNumber: "102", floor: 1 });

    const duplicate = await updateRoom({
      connection,
      id: String(first._id),
      input: { roomNumber: "102" },
    }).catch((error) => error);
    assert.ok(duplicate instanceof HotelApiError);
    assert.equal(duplicate.status, 409);
    assert.equal(first.roomNumber, "101");

    const updated = await updateRoom({
      connection,
      id: String(first._id),
      input: { floor: 3 },
    });
    assert.equal(updated.room.floor, 3);
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_UPDATED).length,
      1
    );

    const refusedDeactivate = await updateRoom({
      connection,
      id: String(first._id),
      input: { isActive: false },
    }).catch((error) => error);
    assert.ok(refusedDeactivate instanceof HotelValidationError);
    assert.ok(refusedDeactivate.fieldErrors.isActive);

    first.isActive = false;
    roomType.isActive = false;
    const refusedReactivation = await updateRoom({
      connection,
      id: String(first._id),
      input: { isActive: true },
    }).catch((error) => error);
    assert.ok(refusedReactivation instanceof HotelValidationError);
    assert.ok(refusedReactivation.fieldErrors.roomTypeId);
    assert.equal(first.isActive, false);
  });

  test("refuses deactivation of occupied or reserved rooms", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const occupied = seedRoom(connection, roomType, {
      roomNumber: "201",
      operationalStatus: "OCCUPIED",
    });
    const reserved = seedRoom(connection, roomType, {
      roomNumber: "202",
      operationalStatus: "RESERVED",
    });

    for (const room of [occupied, reserved]) {
      const refused = await deactivateRoom({
        connection,
        id: String(room._id),
      }).catch((error) => error);
      assert.ok(refused instanceof HotelApiError);
      assert.equal(refused.status, 409);
      assert.equal(room.isActive, true);
    }
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_DEACTIVATED).length,
      0
    );

    const available = seedRoom(connection, roomType, {
      roomNumber: "203",
      operationalStatus: "AVAILABLE",
    });
    const deactivated = await deactivateRoom({
      connection,
      id: String(available._id),
    });
    assert.equal(deactivated.changed, true);
    assert.equal(available.isActive, false);
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_DEACTIVATED).length,
      1
    );

    const again = await deactivateRoom({
      connection,
      id: String(available._id),
    });
    assert.equal(again.changed, false);
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_DEACTIVATED).length,
      1
    );
  });

  test("changes manual status, appends history, and audits", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const room = seedRoom(connection, roomType);
    const actor = toSafeHotelUser(connection.state.user);

    const result = await changeRoomStatus({
      connection,
      id: String(room._id),
      input: { operationalStatus: "CLEANING", note: "deep clean" },
      actor,
    });

    assert.equal(result.room.operationalStatus, "CLEANING");
    assert.equal(result.room.statusHistory.length, 2);
    assert.equal(result.room.statusHistory[1].status, "CLEANING");
    assert.equal(result.room.statusHistory[1].previousStatus, "AVAILABLE");
    assert.equal(result.room.statusHistory[1].note, "deep clean");
    assert.equal(String(result.room.statusHistory[1].changedBy), actor.id);

    const audits = auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_STATUS_CHANGED);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].metadata.previousStatus, "AVAILABLE");
    assert.equal(audits[0].metadata.status, "CLEANING");

    const sameStatus = await changeRoomStatus({
      connection,
      id: String(room._id),
      input: { operationalStatus: "CLEANING" },
    }).catch((error) => error);
    assert.ok(sameStatus instanceof HotelApiError);
    assert.equal(sameStatus.status, 409);
  });

  test("blocks reservation-controlled and inactive room status changes", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const occupied = seedRoom(connection, roomType, {
      roomNumber: "301",
      operationalStatus: "OCCUPIED",
    });
    const inactive = seedRoom(connection, roomType, {
      roomNumber: "302",
      isActive: false,
    });

    const occupiedError = await changeRoomStatus({
      connection,
      id: String(occupied._id),
      input: { operationalStatus: "AVAILABLE" },
    }).catch((error) => error);
    assert.ok(occupiedError instanceof HotelApiError);
    assert.equal(occupiedError.status, 409);

    const inactiveError = await changeRoomStatus({
      connection,
      id: String(inactive._id),
      input: { operationalStatus: "CLEANING" },
    }).catch((error) => error);
    assert.ok(inactiveError instanceof HotelApiError);
    assert.equal(inactiveError.status, 409);

    const manualOccupied = await changeRoomStatus({
      connection,
      id: String(inactive._id),
      input: { operationalStatus: "OCCUPIED" },
    }).catch((error) => error);
    assert.ok(manualOccupied instanceof HotelValidationError);
    assert.ok(manualOccupied.fieldErrors.operationalStatus);

    assert.equal(connection.state.rooms.length, 2);
    assert.equal(auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_STATUS_CHANGED).length, 0);
  });

  test("audit failures never break a successful write", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    connection.state.auditFails = true;

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const result = await createRoom({
        connection,
        input: {
          roomNumber: "401",
          floor: 4,
          roomTypeId: String(roomType._id),
          capacity: 2,
        },
      });
      assert.equal(result.room.roomNumber, "401");
      assert.equal(connection.state.rooms.length, 1);
      assert.equal(connection.state.audits.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("lists rooms with filters and a safe room-type summary", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    seedRoom(connection, roomType, { roomNumber: "101" });
    seedRoom(connection, roomType, {
      roomNumber: "102",
      operationalStatus: "CLEANING",
    });

    const result = await listRooms({
      connection,
      operationalStatus: "CLEANING",
    });

    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].roomNumber, "102");
    assert.equal(result.items[0].roomType.code, "DLX");
    assert.equal(result.items[0].effectiveNightlyRate, 120);
  });
});

describe("Hotel Room and RoomType HTTP routes", () => {
  test("requires authentication for reads and writes", async () => {
    const connection = createFakeConnection();

    const list = await runHandler(
      handleListRoomTypes,
      buildRequest({ path: "/api/hotel/room-types" }),
      {},
      { connect: connection }
    );
    assert.equal(list.status, 401);
    const listBody = await list.json();
    assert.equal(listBody.success, false);
    assert.equal(listBody.error.code, HOTEL_ERROR_CODES.AUTHENTICATION_REQUIRED);

    const create = await runHandler(
      handleCreateRoomType,
      buildRequest({
        method: "POST",
        path: "/api/hotel/room-types",
        body: {
          name: "Deluxe",
          code: "DLX",
          capacity: 2,
          baseNightlyRate: 120,
        },
      }),
      {},
      { connect: connection }
    );
    assert.equal(create.status, 401);
    assert.equal(connection.state.roomTypes.length, 0);
  });

  test("receptionists can read but cannot manage rooms or room types", async () => {
    const connection = createFakeConnection({ role: "RECEPTIONIST" });
    const roomType = seedRoomType(connection);
    seedRoom(connection, roomType);
    const { token, csrfToken } = await sessionFor(connection);

    const list = await runHandler(
      handleListRooms,
      buildRequest({
        path: "/api/hotel/rooms",
        token,
      }),
      {},
      { connect: connection }
    );
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.data.total, 1);
    assert.equal(listBody.data.items[0].roomNumber, "101");

    const createRoomTypeResponse = await runHandler(
      handleCreateRoomType,
      buildRequest({
        method: "POST",
        path: "/api/hotel/room-types",
        token,
        csrfToken,
        body: {
          name: "Suite",
          code: "STE",
          capacity: 4,
          baseNightlyRate: 250,
        },
      }),
      {},
      { connect: connection }
    );
    assert.equal(createRoomTypeResponse.status, 403);
    const denied = await createRoomTypeResponse.json();
    assert.equal(denied.error.code, HOTEL_ERROR_CODES.FORBIDDEN);
    assert.equal(connection.state.roomTypes.length, 1);

    const createRoomResponse = await runHandler(
      handleCreateRoom,
      buildRequest({
        method: "POST",
        path: "/api/hotel/rooms",
        token,
        csrfToken,
        body: {
          roomNumber: "102",
          floor: 1,
          roomTypeId: String(roomType._id),
          capacity: 2,
        },
      }),
      {},
      { connect: connection }
    );
    assert.equal(createRoomResponse.status, 403);
    const deniedRoom = await createRoomResponse.json();
    assert.equal(deniedRoom.error.code, HOTEL_ERROR_CODES.FORBIDDEN);
    assert.equal(connection.state.rooms.length, 1);

    const deniedAudits = auditsFor(
      connection,
      HOTEL_AUDIT_ACTIONS.AUTH_ACCESS_DENIED
    );
    assert.equal(deniedAudits.length, 2);
    assert.deepEqual(
      deniedAudits.map((entry) => entry.metadata.permission).sort(),
      ["hotel.roomTypes.manage", "hotel.rooms.manage"].sort()
    );
  });

  test("mutations require the session CSRF token and same origin", async () => {
    const connection = createFakeConnection();
    const { token, csrfToken } = await sessionFor(connection);

    const noCsrf = await runHandler(
      handleCreateRoomType,
      buildRequest({
        method: "POST",
        path: "/api/hotel/room-types",
        token,
        body: {
          name: "Deluxe",
          code: "DLX",
          capacity: 2,
          baseNightlyRate: 120,
        },
      }),
      {},
      { connect: connection }
    );
    assert.equal(noCsrf.status, 403);
    const noCsrfBody = await noCsrf.json();
    assert.equal(noCsrfBody.error.code, HOTEL_ERROR_CODES.CSRF_VALIDATION_FAILED);
    assert.equal(connection.state.roomTypes.length, 0);

    const badOrigin = await runHandler(
      handleCreateRoomType,
      buildRequest({
        method: "POST",
        path: "/api/hotel/room-types",
        token,
        csrfToken,
        origin: "https://evil.example",
        body: {
          name: "Deluxe",
          code: "DLX",
          capacity: 2,
          baseNightlyRate: 120,
        },
      }),
      {},
      { connect: connection }
    );
    assert.equal(badOrigin.status, 403);
    const badOriginBody = await badOrigin.json();
    assert.equal(badOriginBody.error.code, HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED);
    assert.equal(connection.state.roomTypes.length, 0);
  });

  test("manager can run the full create, update, status, and deactivate flow", async () => {
    const connection = createFakeConnection();
    const { token, csrfToken } = await sessionFor(connection);

    const createdTypeResponse = await runHandler(
      handleCreateRoomType,
      buildRequest({
        method: "POST",
        path: "/api/hotel/room-types",
        token,
        csrfToken,
        body: {
          name: "Deluxe",
          code: "DLX",
          capacity: 2,
          baseNightlyRate: 120,
          amenities: ["Wi-Fi"],
        },
      }),
      {},
      { connect: connection }
    );
    assert.equal(createdTypeResponse.status, 201);
    const createdType = await createdTypeResponse.json();
    const roomTypeId = createdType.data.roomType.id;

    const createdRoomResponse = await runHandler(
      handleCreateRoom,
      buildRequest({
        method: "POST",
        path: "/api/hotel/rooms",
        token,
        csrfToken,
        body: {
          roomNumber: "101",
          floor: 1,
          roomTypeId,
          capacity: 2,
          amenities: ["TV"],
        },
      }),
      {},
      { connect: connection }
    );
    assert.equal(createdRoomResponse.status, 201);
    const createdRoom = await createdRoomResponse.json();
    const roomId = createdRoom.data.room.id;
    assert.equal(createdRoom.data.room.operationalStatus, "AVAILABLE");

    const detail = await runHandler(
      handleGetRoom,
      buildRequest({
        path: `/api/hotel/rooms/${roomId}`,
        token,
      }),
      paramsFor(roomId),
      { connect: connection }
    );
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.data.room.roomNumber, "101");

    const updated = await runHandler(
      handleUpdateRoom,
      buildRequest({
        method: "PATCH",
        path: `/api/hotel/rooms/${roomId}`,
        token,
        csrfToken,
        body: { floor: 2 },
      }),
      paramsFor(roomId),
      { connect: connection }
    );
    assert.equal(updated.status, 200);
    const updatedBody = await updated.json();
    assert.equal(updatedBody.data.room.floor, 2);

    const status = await runHandler(
      handleChangeRoomStatus,
      buildRequest({
        method: "POST",
        path: `/api/hotel/rooms/${roomId}/status`,
        token,
        csrfToken,
        body: { operationalStatus: "CLEANING", note: "deep clean" },
      }),
      paramsFor(roomId),
      { connect: connection }
    );
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.data.room.operationalStatus, "CLEANING");
    assert.equal(statusBody.data.room.statusHistory.length, 2);

    const deactivateRoomResponse = await runHandler(
      handleDeactivateRoom,
      buildRequest({
        method: "POST",
        path: `/api/hotel/rooms/${roomId}/deactivate`,
        token,
        csrfToken,
      }),
      paramsFor(roomId),
      { connect: connection }
    );
    assert.equal(deactivateRoomResponse.status, 200);
    const deactivatedRoom = await deactivateRoomResponse.json();
    assert.equal(deactivatedRoom.data.room.isActive, false);

    const deactivateTypeResponse = await runHandler(
      handleDeactivateRoomType,
      buildRequest({
        method: "POST",
        path: `/api/hotel/room-types/${roomTypeId}/deactivate`,
        token,
        csrfToken,
      }),
      paramsFor(roomTypeId),
      { connect: connection }
    );
    assert.equal(deactivateTypeResponse.status, 200);
    const deactivatedType = await deactivateTypeResponse.json();
    assert.equal(deactivatedType.data.roomType.isActive, false);

    const actions = connection.state.audits.map((entry) => entry.action);
    for (const action of [
      HOTEL_AUDIT_ACTIONS.ROOM_TYPE_CREATED,
      HOTEL_AUDIT_ACTIONS.ROOM_CREATED,
      HOTEL_AUDIT_ACTIONS.ROOM_UPDATED,
      HOTEL_AUDIT_ACTIONS.ROOM_STATUS_CHANGED,
      HOTEL_AUDIT_ACTIONS.ROOM_DEACTIVATED,
      HOTEL_AUDIT_ACTIONS.ROOM_TYPE_DEACTIVATED,
    ]) {
      assert.ok(actions.includes(action), `${action} should be audited`);
    }
  });

  test("list queries reject invalid filters before the model is queried", async () => {
    const connection = createFakeConnection();
    const { token } = await sessionFor(connection);

    const response = await runHandler(
      handleListRooms,
      buildRequest({
        path: "/api/hotel/rooms?floor=not-a-number",
        token,
      }),
      {},
      { connect: connection }
    );
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.ok(body.error.details.fieldErrors.floor);

    const pagination = await runHandler(
      handleListRoomTypes,
      buildRequest({
        path: "/api/hotel/room-types?limit=500",
        token,
      }),
      {},
      { connect: connection }
    );
    assert.equal(pagination.status, 422);
    const paginationBody = await pagination.json();
    assert.ok(paginationBody.error.details.fieldErrors.limit);
  });

  test("room type detail and update handlers validate the route id", async () => {
    const connection = createFakeConnection();
    const { token, csrfToken } = await sessionFor(connection);

    const response = await runHandler(
      handleGetRoomType,
      buildRequest({
        path: "/api/hotel/room-types/not-an-id",
        token,
      }),
      paramsFor("not-an-id"),
      { connect: connection }
    );
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.ok(body.error.details.fieldErrors.id);

    const update = await runHandler(
      handleUpdateRoomType,
      buildRequest({
        method: "PATCH",
        path: "/api/hotel/room-types/not-an-id",
        token,
        csrfToken,
        body: { name: "Renamed" },
      }),
      paramsFor("not-an-id"),
      { connect: connection }
    );
    assert.equal(update.status, 422);
  });

  test("route files are protected, node-runtime, and expose no hard delete", () => {
    const routeFiles = [
      "app/api/hotel/room-types/route.js",
      "app/api/hotel/room-types/[id]/route.js",
      "app/api/hotel/room-types/[id]/deactivate/route.js",
      "app/api/hotel/rooms/route.js",
      "app/api/hotel/rooms/[id]/route.js",
      "app/api/hotel/rooms/[id]/deactivate/route.js",
      "app/api/hotel/rooms/[id]/status/route.js",
    ];

    for (const file of routeFiles) {
      const source = src(file);
      assert.match(source, /export const runtime = "nodejs"/, file);
      assert.match(source, /export const dynamic = "force-dynamic"/, file);
      assert.match(source, /withHotelApi/, file);
      assert.ok(!/export\s+const\s+DELETE/.test(source), `${file} must not delete`);
    }

    for (const file of [
      "lib/hotel/services/rooms.js",
      "lib/hotel/services/roomTypes.js",
      "lib/hotel/models/room.js",
      "lib/hotel/models/roomType.js",
    ]) {
      const source = src(file);
      assert.ok(
        !/deleteOne|deleteMany|findByIdAndDelete|findOneAndDelete/.test(source),
        `${file} must not hard-delete hotel records`
      );
    }
  });
});

describe("Hotel Room model isolation (DB-free)", () => {
  test("Room compiles only on the supplied Hotel connection and defines constraints", async () => {
    assert.equal(mongoose.models.Room, undefined);
    const connection = mongoose.createConnection();

    try {
      const Room = getRoomModel(connection);
      assert.equal(connection.models.Room, Room);
      assert.equal(mongoose.models.Room, undefined);
      assert.equal(Room.collection.name, "hotel_rooms");

      const valid = new Room({
        roomNumber: "101",
        floor: 1,
        roomTypeId: new mongoose.Types.ObjectId(),
        capacity: 2,
        amenities: ["TV"],
      });
      await valid.validate();
      assert.equal(valid.operationalStatus, "AVAILABLE");
      assert.equal(valid.statusHistory.length, 0);

      const invalidFloor = new Room({
        roomNumber: "102",
        floor: 1.5,
        roomTypeId: new mongoose.Types.ObjectId(),
        capacity: 2,
      });
      await assert.rejects(
        invalidFloor.validate(),
        (error) => Boolean(error.errors.floor)
      );

      const invalidStatus = new Room({
        roomNumber: "103",
        floor: 1,
        roomTypeId: new mongoose.Types.ObjectId(),
        capacity: 2,
        operationalStatus: "DIRTY",
      });
      await assert.rejects(
        invalidStatus.validate(),
        (error) => Boolean(error.errors.operationalStatus)
      );

      const indexes = Room.schema.indexes();
      assert.ok(
        indexes.some(
          ([keys, options]) =>
            keys.roomNumber === 1 && options.unique === true
        ),
        "Room.roomNumber unique index is defined"
      );
    } finally {
      await connection.close();
    }
  });
});
