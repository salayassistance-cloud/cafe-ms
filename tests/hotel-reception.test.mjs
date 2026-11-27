// Hotel Guest and Reservation backend tests — DB-free.
//
// No MongoDB connection is opened and no index is created. Services and route
// handlers use an in-memory stub connection so validation, date boundaries,
// overlap protection, lock contention, rate snapshots, transitions, permissions,
// CSRF, and audit behavior can be exercised deterministically.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import {
  HOTEL_ACTIVE_RESERVATION_STATUSES,
  HOTEL_BOOKING_LOCK_TTL_MS,
  HOTEL_MAX_STAY_NIGHTS,
  HOTEL_RESERVATION_STATUSES,
} from "../lib/hotel/constants.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
  HotelValidationError,
} from "../lib/hotel/errors.js";
import { HOTEL_AUDIT_ACTIONS } from "../lib/hotel/audit.js";
import { toSafeHotelUser } from "../lib/hotel/models/hotelUser.js";
import { getGuestModel } from "../lib/hotel/models/guest.js";
import { getReservationModel } from "../lib/hotel/models/reservation.js";
import { getRoomBookingLockModel } from "../lib/hotel/models/roomBookingLock.js";
import { getRoomModel } from "../lib/hotel/models/room.js";
import { withHotelApi } from "../lib/hotel/http/apiResponse.js";
import {
  handleCreateGuest,
  handleDeactivateGuest,
  handleGetGuest,
  handleListGuests,
  handleUpdateGuest,
} from "../lib/hotel/http/guestHandlers.js";
import {
  handleAssignReservationRoom,
  handleCancelReservation,
  handleCreateReservation,
  handleGetReservation,
  handleListReservations,
  handleUpdateReservation,
} from "../lib/hotel/http/reservationHandlers.js";
import {
  assignReservationRoom,
  canTransitionReservation,
  cancelReservation,
  createReservation,
  getReservation,
  listReservations,
  updateReservation,
} from "../lib/hotel/services/reservations.js";
import {
  createGuest,
  deactivateGuest,
  getGuest,
  listGuests,
  updateGuest,
} from "../lib/hotel/services/guests.js";
import { withHotelRoomBookingLocks } from "../lib/hotel/services/bookingLocks.js";
import {
  addHotelLocalDays,
  enumerateHotelNights,
  formatHotelLocalDate,
  getHotelStayNights,
  hotelLocalToday,
  parseHotelLocalDate,
  validateHotelStayRange,
} from "../lib/hotel/dates.js";
import {
  validateGuestPayload,
  validateReservationAssignmentPayload,
  validateReservationCancelPayload,
  validateReservationCreatePayload,
  validateReservationUpdatePayload,
} from "../lib/hotel/validation.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (path) => readFileSync(join(root, path), "utf8");

const TEST_HOTEL_SECRET = "hotel-reception-test-secret-independent-1234567890";
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
    email: "reception@example.com",
    name: "Hotel Receptionist",
    role: "RECEPTIONIST",
    isActive: true,
    lastLoginAt: null,
    ...overrides,
  };
}

function cloneRow(row) {
  if (!row) return null;
  const copy = { ...row };
  for (const field of ["statusHistory", "amenities"]) {
    if (Array.isArray(row[field])) {
      copy[field] = row[field].map((entry) => ({ ...entry }));
    }
  }
  for (const field of ["guestSnapshot", "roomTypeSnapshot", "roomSnapshot"]) {
    if (row[field] && typeof row[field] === "object") {
      copy[field] = { ...row[field] };
    }
  }
  return copy;
}

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return String(value);
}

function matchesFilter(row, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$or") {
      return (
        Array.isArray(expected) &&
        expected.some((subFilter) => matchesFilter(row, subFilter))
      );
    }

    const actual = row[field];
    if (expected instanceof RegExp) {
      return expected.test(String(actual ?? ""));
    }

    if (
      expected &&
      typeof expected === "object" &&
      !Array.isArray(expected) &&
      !(expected instanceof Date) &&
      !(expected instanceof mongoose.Types.ObjectId)
    ) {
      if ("$ne" in expected) {
        return String(actual) !== String(expected.$ne);
      }
      if ("$in" in expected) {
        const allowed = new Set(expected.$in.map((value) => String(value)));
        return allowed.has(String(actual));
      }
      if ("$regex" in expected) {
        const pattern =
          expected.$regex instanceof RegExp
            ? expected.$regex
            : new RegExp(expected.$regex, expected.$options ?? "");
        return pattern.test(String(actual ?? ""));
      }
      if ("$lt" in expected) {
        return comparable(actual) < comparable(expected.$lt);
      }
      if ("$lte" in expected) {
        return comparable(actual) <= comparable(expected.$lte);
      }
      if ("$gt" in expected) {
        return comparable(actual) > comparable(expected.$gt);
      }
      if ("$gte" in expected) {
        return comparable(actual) >= comparable(expected.$gte);
      }
    }

    if (expected instanceof Date && actual instanceof Date) {
      return expected.getTime() === actual.getTime();
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
          const leftValue = comparable(left[field]);
          const rightValue = comparable(right[field]);
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
      if (
        doc._id != null &&
        rows.some((row) => String(row._id) === String(doc._id))
      ) {
        throw duplicateKeyError();
      }
      if (
        uniqueField &&
        rows.some(
          (row) => String(row[uniqueField]) === String(doc[uniqueField])
        )
      ) {
        throw duplicateKeyError();
      }
      if (state.duplicateCreate === key) {
        state.duplicateCreate = null;
        throw duplicateKeyError();
      }
      const now = new Date();
      const row = {
        ...doc,
        _id: doc._id ?? new mongoose.Types.ObjectId(),
        createdAt: now,
        updatedAt: now,
      };
      if (key === "locks") state.lockAcquireOrder.push(String(doc._id));
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
    deleteOne: async (filter) => {
      const index = rows.findIndex((row) => matchesFilter(row, filter));
      if (index < 0) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
    countDocuments: async (filter) =>
      rows.filter((row) => matchesFilter(row, filter)).length,
    find: (filter) =>
      makeFindQuery(rows.filter((row) => matchesFilter(row, filter))),
  };
}

function createFakeConnection({ role = "RECEPTIONIST" } = {}) {
  const state = {
    user: makeUser({ role }),
    sessions: [],
    audits: [],
    guests: [],
    roomTypes: [],
    rooms: [],
    reservations: [],
    locks: [],
    lockAcquireOrder: [],
    auditFails: false,
    duplicateCreate: null,
  };

  const lockModel = {
    ...makeCollectionModel(state, "locks"),
    findOneAndUpdate: async (filter, update, options) => {
      const row = state.locks.find((entry) => matchesFilter(entry, filter));
      if (!row) return null;
      if (update?.$set) Object.assign(row, update.$set);
      return options?.new ? cloneRow(row) : row;
    },
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
      Guest: makeCollectionModel(state, "guests"),
      RoomType: makeCollectionModel(state, "roomTypes", {
        uniqueField: "code",
      }),
      Room: makeCollectionModel(state, "rooms", {
        uniqueField: "roomNumber",
      }),
      Reservation: makeCollectionModel(state, "reservations", {
        uniqueField: "reservationNumber",
      }),
      RoomBookingLock: lockModel,
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
    capacity: roomType.capacity,
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

function seedGuest(connection, overrides = {}) {
  const now = new Date();
  const guest = {
    _id: new mongoose.Types.ObjectId(),
    firstName: "Abebe",
    lastName: "Bekele",
    phone: "+251911000000",
    email: "abebe@example.com",
    nationality: "Ethiopian",
    idType: "PASSPORT",
    idNumber: "P123456",
    address: "",
    notes: "",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  connection.state.guests.push(guest);
  return guest;
}

function seedReservation(connection, guest, roomType, overrides = {}) {
  const arrivalLocalDate = overrides.arrivalLocalDate ?? localDateIn(10);
  const departureLocalDate = overrides.departureLocalDate ?? localDateIn(12);
  const arrivalDate = parseHotelLocalDate(arrivalLocalDate);
  const departureDate = parseHotelLocalDate(departureLocalDate);
  const nights = getHotelStayNights(arrivalDate, departureDate);
  const now = new Date();
  const roomId = overrides.roomId ?? null;
  const room = roomId
    ? connection.state.rooms.find((entry) => String(entry._id) === String(roomId))
    : null;
  const nightlyRate = overrides.nightlyRate ?? roomType.baseNightlyRate;
  const reservation = {
    _id: new mongoose.Types.ObjectId(),
    reservationNumber: `RES-${arrivalLocalDate.replaceAll("-", "")}-A1B2C3`,
    guestId: guest._id,
    guestSnapshot: {
      firstName: guest.firstName,
      lastName: guest.lastName,
      fullName: `${guest.firstName} ${guest.lastName}`.trim(),
      phone: guest.phone,
      email: guest.email ?? null,
    },
    roomTypeId: roomType._id,
    roomTypeSnapshot: {
      name: roomType.name,
      code: roomType.code,
      capacity: roomType.capacity,
      baseNightlyRate: roomType.baseNightlyRate,
    },
    roomId,
    roomSnapshot: room
      ? { roomNumber: room.roomNumber, floor: room.floor }
      : null,
    arrivalDate,
    departureDate,
    nights,
    adults: overrides.adults ?? 2,
    children: overrides.children ?? 0,
    nightlyRate,
    rateSource: overrides.rateSource ?? "ROOM_TYPE_BASE",
    totalAmount: overrides.totalAmount ?? nightlyRate * nights,
    status: overrides.status ?? "CONFIRMED",
    notes: overrides.notes ?? "",
    cancelledAt: overrides.cancelledAt ?? null,
    cancelledBy: overrides.cancelledBy ?? null,
    cancellationReason: overrides.cancellationReason ?? "",
    createdBy: overrides.createdBy ?? null,
    updatedBy: overrides.updatedBy ?? null,
    statusHistory: overrides.statusHistory ?? [
      {
        status: overrides.status ?? "CONFIRMED",
        previousStatus: null,
        changedAt: now,
        changedBy: null,
        note: "",
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  connection.state.reservations.push(reservation);
  return reservation;
}

function localDateIn(days) {
  return formatHotelLocalDate(addHotelLocalDays(new Date(), days));
}

function buildRequest({
  method = "GET",
  path = "/api/hotel/guests",
  origin = TEST_ORIGIN,
  body,
  headers = {},
} = {}) {
  const requestHeaders = { ...headers };
  if (origin !== null) requestHeaders.origin = origin;
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

// Phase 4-A: simulate a canonical POS MANAGER for DB-free HTTP tests.
async function testManagerAuth() {
  return { ok: true, payload: { staffId: null, role: "MANAGER", name: "test-manager" } };
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

describe("Hotel reception date utilities", () => {
  const fixedNow = Date.UTC(2030, 0, 15, 12, 0, 0);

  test("Addis local dates map to canonical UTC midnight and round-trip", () => {
    const arrival = parseHotelLocalDate("2030-01-15", "arrivalDate");
    assert.equal(arrival.toISOString(), "2030-01-14T21:00:00.000Z");
    assert.equal(formatHotelLocalDate(arrival), "2030-01-15");

    const departure = parseHotelLocalDate("2030-01-17");
    assert.equal(getHotelStayNights(arrival, departure), 2);
    assert.deepEqual(enumerateHotelNights(arrival, departure), [
      "2030-01-15",
      "2030-01-16",
    ]);
  });

  test("invalid calendar dates and leap years are handled explicitly", () => {
    assert.doesNotThrow(() => parseHotelLocalDate("2028-02-29"));
    const invalid = capture(() => parseHotelLocalDate("2027-02-29", "arrivalDate"));
    assert.ok(invalid instanceof HotelValidationError);
    assert.ok(invalid.fieldErrors.arrivalDate);

    const impossible = capture(() => parseHotelLocalDate("2030-02-30"));
    assert.ok(impossible instanceof HotelValidationError);
    assert.ok(impossible.fieldErrors.date);
  });

  test("stay ranges reject same-day, past, and overlong stays", () => {
    const accepted = validateHotelStayRange({
      arrivalDate: "2030-01-15",
      departureDate: "2030-01-17",
      now: fixedNow,
    });
    assert.equal(accepted.nights, 2);
    assert.equal(accepted.arrivalDate.toISOString(), "2030-01-14T21:00:00.000Z");

    const sameDay = capture(() =>
      validateHotelStayRange({
        arrivalDate: "2030-01-15",
        departureDate: "2030-01-15",
        now: fixedNow,
      })
    );
    assert.ok(sameDay instanceof HotelValidationError);
    assert.ok(sameDay.fieldErrors.departureDate);

    const past = capture(() =>
      validateHotelStayRange({
        arrivalDate: "2030-01-14",
        departureDate: "2030-01-16",
        now: fixedNow,
      })
    );
    assert.ok(past instanceof HotelValidationError);
    assert.ok(past.fieldErrors.arrivalDate);

    const tooLong = capture(() =>
      validateHotelStayRange({
        arrivalDate: "2030-01-15",
        departureDate: "2031-01-16",
        now: fixedNow,
      })
    );
    assert.ok(tooLong instanceof HotelValidationError);
    assert.match(tooLong.fieldErrors.departureDate, /365/);
    assert.equal(HOTEL_MAX_STAY_NIGHTS, 365);
  });
});

describe("Hotel guest validation and service", () => {
  test("guest payloads are normalized and unsafe input is rejected", () => {
    const result = validateGuestPayload({
      firstName: " Abebe ",
      lastName: " Bekele ",
      phone: "+251 911 000 000",
      email: " ABEBE@Example.com ",
      nationality: " Ethiopian ",
      idType: "passport",
      idNumber: " P123 ",
      address: " Addis Ababa ",
      notes: " VIP ",
      ignored: "not persisted",
    });

    assert.equal(result.firstName, "Abebe");
    assert.equal(result.lastName, "Bekele");
    assert.equal(result.phone, "+251 911 000 000");
    assert.equal(result.email, "abebe@example.com");
    assert.equal(result.idType, "PASSPORT");
    assert.equal(result.idNumber, "P123");
    assert.equal(result.isActive, true);
    assert.equal(result.ignored, undefined);

    const invalid = capture(() =>
      validateGuestPayload({
        firstName: "",
        lastName: "",
        phone: "abc",
        email: "not-an-email",
        idType: "UNKNOWN",
      })
    );
    assert.ok(invalid instanceof HotelValidationError);
    for (const field of ["firstName", "lastName", "phone", "email", "idType"]) {
      assert.ok(invalid.fieldErrors[field], `${field} should be rejected`);
    }

    const emptyPartial = capture(() => validateGuestPayload({}, { partial: true }));
    assert.ok(emptyPartial instanceof HotelValidationError);
    assert.equal(emptyPartial.fieldErrors.body, "at least one field is required");
  });

  test("creates, updates, lists, and safely deactivates guests", async () => {
    const connection = createFakeConnection();
    const actor = toSafeHotelUser(connection.state.user);

    const created = await createGuest({
      connection,
      input: {
        firstName: "Abebe",
        lastName: "Bekele",
        phone: "+251911000000",
        email: "abebe@example.com",
        idType: "PASSPORT",
        idNumber: "P123456",
      },
      actor,
    });
    assert.equal(created.guest.fullName, "Abebe Bekele");
    assert.equal(created.guest.isActive, true);
    assert.equal(connection.state.guests.length, 1);
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.GUEST_CREATED).length,
      1
    );

    const updated = await updateGuest({
      connection,
      id: created.guest.id,
      input: { phone: "+251 911 111 111", notes: "Prefers a quiet room" },
      actor,
    });
    assert.equal(updated.guest.phone, "+251 911 111 111");
    assert.equal(updated.guest.notes, "Prefers a quiet room");
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.GUEST_UPDATED).length,
      1
    );

    const refusedDeactivate = await updateGuest({
      connection,
      id: created.guest.id,
      input: { isActive: false },
    }).catch((error) => error);
    assert.ok(refusedDeactivate instanceof HotelValidationError);
    assert.ok(refusedDeactivate.fieldErrors.isActive);

    const list = await listGuests({ connection, search: "abebe" });
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, created.guest.id);

    const detail = await getGuest({ connection, id: created.guest.id });
    assert.equal(detail.guest.fullName, "Abebe Bekele");

    const deactivated = await deactivateGuest({
      connection,
      id: created.guest.id,
      actor,
    });
    assert.equal(deactivated.changed, true);
    assert.equal(deactivated.guest.isActive, false);
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.GUEST_DEACTIVATED).length,
      1
    );

    const again = await deactivateGuest({
      connection,
      id: created.guest.id,
      actor,
    });
    assert.equal(again.changed, false);
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.GUEST_DEACTIVATED).length,
      1
    );
  });

  test("guest deactivation is refused while an active reservation exists", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const reservation = seedReservation(connection, guest, roomType);

    const refused = await deactivateGuest({
      connection,
      id: String(guest._id),
    }).catch((error) => error);
    assert.ok(refused instanceof HotelApiError);
    assert.equal(refused.status, 409);
    assert.equal(guest.isActive, true);

    reservation.status = "CANCELLED";
    reservation.cancelledAt = new Date();
    const deactivated = await deactivateGuest({
      connection,
      id: String(guest._id),
    });
    assert.equal(deactivated.changed, true);
    assert.equal(guest.isActive, false);
  });
});

describe("Hotel reservation validation", () => {
  const roomTypeId = new mongoose.Types.ObjectId().toString();
  const guestId = new mongoose.Types.ObjectId().toString();

  test("create payloads normalize dates, defaults, and optional room assignment", () => {
    const result = validateReservationCreatePayload({
      guestId,
      roomTypeId,
      arrivalDate: "2030-01-15",
      departureDate: "2030-01-17",
      adults: 2,
      notes: " Late arrival ",
    });

    assert.equal(result.guestId, guestId);
    assert.equal(result.roomTypeId, roomTypeId);
    assert.equal(result.arrivalDate, "2030-01-15");
    assert.equal(result.departureDate, "2030-01-17");
    assert.equal(result.children, 0);
    assert.equal(result.roomId, null);
    assert.equal(result.notes, "Late arrival");
  });

  test("create payloads reject invalid dates, ids, and impossible party sizes", () => {
    const invalid = capture(() =>
      validateReservationCreatePayload({
        guestId: "not-an-id",
        roomTypeId: "also-not-an-id",
        arrivalDate: "2030-02-30",
        departureDate: "2030-02-28",
        adults: 0,
        children: 101,
      })
    );
    assert.ok(invalid instanceof HotelValidationError);
    for (const field of [
      "guestId",
      "roomTypeId",
      "arrivalDate",
      "adults",
      "children",
    ]) {
      assert.ok(invalid.fieldErrors[field], `${field} should be rejected`);
    }

    const tooMany = capture(() =>
      validateReservationCreatePayload({
        guestId,
        roomTypeId,
        arrivalDate: "2030-01-15",
        departureDate: "2030-01-17",
        adults: 60,
        children: 60,
      })
    );
    assert.ok(tooMany instanceof HotelValidationError);
    assert.ok(tooMany.fieldErrors.adults);
  });

  test("generic updates cannot change guest, room, status, or money fields", () => {
    const invalid = capture(() =>
      validateReservationUpdatePayload({
        guestId,
        roomTypeId,
        roomId: roomTypeId,
        status: "CANCELLED",
        nightlyRate: 1,
        totalAmount: 1,
      })
    );
    assert.ok(invalid instanceof HotelValidationError);
    for (const field of [
      "guestId",
      "roomTypeId",
      "roomId",
      "status",
      "nightlyRate",
      "totalAmount",
    ]) {
      assert.ok(invalid.fieldErrors[field], `${field} should be rejected`);
    }

    const empty = capture(() => validateReservationUpdatePayload({}));
    assert.ok(empty instanceof HotelValidationError);
    assert.equal(empty.fieldErrors.body, "at least one field is required");

    const accepted = validateReservationUpdatePayload({
      arrivalDate: "2030-01-16",
      notes: "Updated",
    });
    assert.deepEqual(accepted, {
      arrivalDate: "2030-01-16",
      notes: "Updated",
    });
  });

  test("assignment and cancellation payloads are field-scoped", () => {
    const assignment = validateReservationAssignmentPayload({ roomId: roomTypeId });
    assert.equal(assignment.roomId, roomTypeId);
    assert.ok(
      capture(() => validateReservationAssignmentPayload({ roomId: "bad" }))
        instanceof HotelValidationError
    );

    const cancel = validateReservationCancelPayload({ reason: " Guest called " });
    assert.equal(cancel.reason, "Guest called");
    assert.deepEqual(validateReservationCancelPayload({}), { reason: "" });
  });

  test("reservation transitions are explicit and terminal states stay terminal", () => {
    assert.equal(canTransitionReservation("CONFIRMED", "CANCELLED"), true);
    assert.equal(canTransitionReservation("CONFIRMED", "CHECKED_IN"), true);
    assert.equal(canTransitionReservation("CONFIRMED", "NO_SHOW"), true);
    assert.equal(canTransitionReservation("CHECKED_IN", "CHECKED_OUT"), true);
    assert.equal(canTransitionReservation("CHECKED_IN", "CANCELLED"), false);
    assert.equal(canTransitionReservation("CANCELLED", "CONFIRMED"), false);
    assert.equal(canTransitionReservation("CHECKED_OUT", "CONFIRMED"), false);
    assert.equal(canTransitionReservation("NO_SHOW", "CONFIRMED"), false);
    assert.equal(HOTEL_ACTIVE_RESERVATION_STATUSES.includes("CONFIRMED"), true);
    assert.equal(HOTEL_ACTIVE_RESERVATION_STATUSES.includes("CANCELLED"), false);
    assert.deepEqual(HOTEL_RESERVATION_STATUSES, [
      "CONFIRMED",
      "CANCELLED",
      "CHECKED_IN",
      "CHECKED_OUT",
      "NO_SHOW",
    ]);
  });
});

describe("Hotel reservation service", () => {
  test("creates a reservation with snapshots, rate, total, and audit", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const actor = toSafeHotelUser(connection.state.user);

    const result = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(12),
        adults: 2,
        children: 0,
        notes: "Late arrival",
      },
      actor,
    });

    assert.match(result.reservation.reservationNumber, /^RES-\d{8}-[A-F0-9]{6}$/);
    assert.equal(result.reservation.status, "CONFIRMED");
    assert.equal(result.reservation.nights, 2);
    assert.equal(result.reservation.nightlyRate, 120);
    assert.equal(result.reservation.rateSource, "ROOM_TYPE_BASE");
    assert.equal(result.reservation.totalAmount, 240);
    assert.equal(result.reservation.guestSnapshot.fullName, "Abebe Bekele");
    assert.equal(result.reservation.roomTypeSnapshot.code, "DLX");
    assert.equal(result.reservation.roomId, null);
    assert.equal(result.reservation.statusHistory.length, 1);
    assert.equal(connection.state.reservations.length, 1);
    assert.equal(connection.state.locks.length, 0);

    const audits = auditsFor(
      connection,
      HOTEL_AUDIT_ACTIONS.RESERVATION_CREATED
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0].entityType, "Reservation");
    assert.equal(audits[0].entityId, result.reservation.id);
    assert.equal(audits[0].metadata.nightlyRate, 120);
  });

  test("snapshots survive room-type price changes and date updates", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);

    const created = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(12),
        adults: 2,
      },
    });

    roomType.baseNightlyRate = 999;
    const detail = await getReservation({
      connection,
      id: created.reservation.id,
    });
    assert.equal(detail.reservation.nightlyRate, 120);
    assert.equal(detail.reservation.totalAmount, 240);
    assert.equal(detail.reservation.roomTypeSnapshot.baseNightlyRate, 120);
    assert.equal(detail.reservation.roomType.baseNightlyRate, 999);

    const updated = await updateReservation({
      connection,
      id: created.reservation.id,
      input: { departureDate: localDateIn(13), notes: "Extended" },
    });
    assert.equal(updated.reservation.nights, 3);
    assert.equal(updated.reservation.nightlyRate, 120);
    assert.equal(updated.reservation.totalAmount, 360);
    assert.equal(updated.reservation.notes, "Extended");
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.RESERVATION_UPDATED).length,
      1
    );
  });

  test("uses a room override at creation but never reprices an existing booking", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType, {
      roomNumber: "201",
      nightlyRateOverride: 150,
    });

    const created = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId: String(room._id),
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(12),
        adults: 2,
      },
    });
    assert.equal(created.reservation.nightlyRate, 150);
    assert.equal(created.reservation.rateSource, "ROOM_OVERRIDE");
    assert.equal(created.reservation.totalAmount, 300);
    assert.equal(created.reservation.roomSnapshot.roomNumber, "201");

    const unassigned = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        arrivalDate: localDateIn(20),
        departureDate: localDateIn(22),
        adults: 2,
      },
    });
    assert.equal(unassigned.reservation.nightlyRate, 120);

    const assigned = await assignReservationRoom({
      connection,
      id: unassigned.reservation.id,
      input: { roomId: String(room._id) },
    });
    assert.equal(assigned.changed, true);
    assert.equal(assigned.reservation.nightlyRate, 120);
    assert.equal(assigned.reservation.rateSource, "ROOM_TYPE_BASE");
    assert.equal(assigned.reservation.roomId, String(room._id));
    assert.equal(
      auditsFor(
        connection,
        HOTEL_AUDIT_ACTIONS.RESERVATION_ROOM_ASSIGNED
      ).length,
      1
    );

    const same = await assignReservationRoom({
      connection,
      id: unassigned.reservation.id,
      input: { roomId: String(room._id) },
    });
    assert.equal(same.changed, false);
  });

  test("rejects inactive references, mismatched rooms, and capacity overflows", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const otherType = seedRoomType(connection, {
      name: "Standard",
      code: "STD",
      capacity: 1,
      baseNightlyRate: 80,
    });
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);
    const otherRoom = seedRoom(connection, otherType, {
      roomNumber: "301",
      capacity: 1,
    });

    const inactiveGuest = seedGuest(connection, {
      firstName: "Inactive",
      lastName: "Guest",
      phone: "+251911000001",
      isActive: false,
    });
    const inactiveType = seedRoomType(connection, {
      name: "Old",
      code: "OLD",
      isActive: false,
    });

    const cases = [
      {
        label: "inactive guest",
        input: {
          guestId: String(inactiveGuest._id),
          roomTypeId: String(roomType._id),
          adults: 2,
        },
        field: "guestId",
      },
      {
        label: "missing guest",
        input: {
          guestId: new mongoose.Types.ObjectId().toString(),
          roomTypeId: String(roomType._id),
          adults: 2,
        },
        field: "guestId",
      },
      {
        label: "inactive room type",
        input: {
          guestId: String(guest._id),
          roomTypeId: String(inactiveType._id),
          adults: 2,
        },
        field: "roomTypeId",
      },
      {
        label: "room type mismatch",
        input: {
          guestId: String(guest._id),
          roomTypeId: String(roomType._id),
          roomId: String(otherRoom._id),
          adults: 2,
        },
        field: "roomId",
      },
      {
        label: "party larger than room type",
        input: {
          guestId: String(guest._id),
          roomTypeId: String(otherType._id),
          adults: 2,
        },
        field: "adults",
      },
    ];

    for (const entry of cases) {
      const error = await createReservation({
        connection,
        input: {
          arrivalDate: localDateIn(10),
          departureDate: localDateIn(12),
          ...entry.input,
        },
      }).catch((caught) => caught);
      assert.ok(error instanceof HotelValidationError, entry.label);
      assert.ok(error.fieldErrors[entry.field], entry.label);
    }

    const outOfService = seedRoom(connection, roomType, {
      roomNumber: "401",
      operationalStatus: "OUT_OF_SERVICE",
    });
    const outOfServiceError = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId: String(outOfService._id),
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(12),
        adults: 2,
      },
    }).catch((error) => error);
    assert.ok(outOfServiceError instanceof HotelValidationError);
    assert.ok(outOfServiceError.fieldErrors.roomId);

    const assigned = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId: String(room._id),
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(12),
        adults: 2,
      },
    });
    const tooSmall = await assignReservationRoom({
      connection,
      id: assigned.reservation.id,
      input: { roomId: String(otherRoom._id) },
    }).catch((error) => error);
    assert.ok(tooSmall instanceof HotelValidationError);
    assert.ok(tooSmall.fieldErrors.roomId);
  });

  test("cancellation preserves history and rejects invalid transitions", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const actor = toSafeHotelUser(connection.state.user);

    const created = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(12),
        adults: 2,
      },
      actor,
    });

    const cancelled = await cancelReservation({
      connection,
      id: created.reservation.id,
      input: { reason: "Guest called to cancel" },
      actor,
    });
    assert.equal(cancelled.reservation.status, "CANCELLED");
    assert.equal(cancelled.reservation.cancellation.reason, "Guest called to cancel");
    assert.equal(cancelled.reservation.statusHistory.length, 2);
    assert.equal(
      cancelled.reservation.statusHistory[1].previousStatus,
      "CONFIRMED"
    );
    assert.equal(cancelled.reservation.statusHistory[1].status, "CANCELLED");
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.RESERVATION_CANCELLED).length,
      1
    );

    const again = await cancelReservation({
      connection,
      id: created.reservation.id,
      input: {},
    }).catch((error) => error);
    assert.ok(again instanceof HotelApiError);
    assert.equal(again.status, 409);

    const updateAfterCancel = await updateReservation({
      connection,
      id: created.reservation.id,
      input: { notes: "Too late" },
    }).catch((error) => error);
    assert.ok(updateAfterCancel instanceof HotelApiError);
    assert.equal(updateAfterCancel.status, 409);

    const assignAfterCancel = await assignReservationRoom({
      connection,
      id: created.reservation.id,
      input: { roomId: String(seedRoom(connection, roomType)._id) },
    }).catch((error) => error);
    assert.ok(assignAfterCancel instanceof HotelApiError);
    assert.equal(assignAfterCancel.status, 409);
  });

  test("audit failures never break guest or reservation writes", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    connection.state.auditFails = true;

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const createdGuest = await createGuest({
        connection,
        input: {
          firstName: "Audit",
          lastName: "Failure",
          phone: "+251911000099",
        },
      });
      assert.equal(createdGuest.guest.firstName, "Audit");

      const createdReservation = await createReservation({
        connection,
        input: {
          guestId: String(guest._id),
          roomTypeId: String(roomType._id),
          arrivalDate: localDateIn(10),
          departureDate: localDateIn(12),
          adults: 2,
        },
      });
      assert.equal(createdReservation.reservation.status, "CONFIRMED");
      assert.equal(connection.state.audits.length, 0);
      assert.equal(connection.state.reservations.length, 1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("retries a reservation-number collision without duplicating the booking", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    connection.state.duplicateCreate = "reservations";

    const created = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(12),
        adults: 2,
      },
    });

    assert.match(created.reservation.reservationNumber, /^RES-\d{8}-[A-F0-9]{6}$/);
    assert.equal(connection.state.reservations.length, 1);
  });
});

describe("Hotel reservation overlap and concurrency", () => {
  test("overlapping active stays are rejected but adjacent stays are allowed", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);

    const first = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId: String(room._id),
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(13),
        adults: 2,
      },
    });
    assert.equal(connection.state.locks.length, 0);

    const overlap = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId: String(room._id),
        arrivalDate: localDateIn(12),
        departureDate: localDateIn(14),
        adults: 2,
      },
    }).catch((error) => error);
    assert.ok(overlap instanceof HotelApiError);
    assert.equal(overlap.status, 409);
    assert.equal(connection.state.reservations.length, 1);
    assert.equal(connection.state.locks.length, 0);

    const adjacent = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId: String(room._id),
        arrivalDate: localDateIn(13),
        departureDate: localDateIn(15),
        adults: 2,
      },
    });
    assert.equal(adjacent.reservation.status, "CONFIRMED");
    assert.equal(connection.state.reservations.length, 2);

    const otherRoom = seedRoom(connection, roomType, { roomNumber: "102" });
    const otherRoomStay = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId: String(otherRoom._id),
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(13),
        adults: 2,
      },
    });
    assert.equal(otherRoomStay.reservation.roomId, String(otherRoom._id));

    await cancelReservation({
      connection,
      id: first.reservation.id,
      input: { reason: "Released inventory" },
    });
    const rebooked = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId: String(room._id),
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(13),
        adults: 2,
      },
    });
    assert.equal(rebooked.reservation.status, "CONFIRMED");
  });

  test("date updates re-check overlap and exclude the reservation itself", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);

    const first = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId: String(room._id),
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(12),
        adults: 2,
      },
    });
    const second = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId: String(room._id),
        arrivalDate: localDateIn(14),
        departureDate: localDateIn(16),
        adults: 2,
      },
    });

    const selfUpdate = await updateReservation({
      connection,
      id: first.reservation.id,
      input: { departureDate: localDateIn(13) },
    });
    assert.equal(selfUpdate.reservation.nights, 3);

    const collision = await updateReservation({
      connection,
      id: first.reservation.id,
      input: { departureDate: localDateIn(15) },
    }).catch((error) => error);
    assert.ok(collision instanceof HotelApiError);
    assert.equal(collision.status, 409);

    const unchanged = await getReservation({
      connection,
      id: first.reservation.id,
    });
    assert.equal(unchanged.reservation.departureLocalDate, localDateIn(13));
    assert.equal(second.reservation.status, "CONFIRMED");
  });

  test("reservation creation respects a lock held by another booking attempt", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);
    const roomId = String(room._id);

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });

    const held = withHotelRoomBookingLocks({
      connection,
      roomIds: [roomId],
      owner: "held-booking",
      fn: async () => {
        started();
        await gate;
      },
    });
    await startedPromise;

    const blocked = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId,
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(12),
        adults: 2,
      },
    }).catch((error) => error);
    assert.ok(blocked instanceof HotelApiError);
    assert.equal(blocked.status, 409);
    assert.equal(connection.state.reservations.length, 0);

    release();
    await held;

    const allowed = await createReservation({
      connection,
      input: {
        guestId: String(guest._id),
        roomTypeId: String(roomType._id),
        roomId,
        arrivalDate: localDateIn(10),
        departureDate: localDateIn(12),
        adults: 2,
      },
    });
    assert.equal(allowed.reservation.status, "CONFIRMED");
    assert.equal(connection.state.reservations.length, 1);
  });

  test("the per-room lock provides mutual exclusion and expires safely", async () => {
    const connection = createFakeConnection();
    const roomA = new mongoose.Types.ObjectId().toString();
    const roomB = new mongoose.Types.ObjectId().toString();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });

    const first = withHotelRoomBookingLocks({
      connection,
      roomIds: [roomA],
      owner: "first-owner",
      fn: async () => {
        started();
        await gate;
        return "first";
      },
    });
    await startedPromise;

    const second = await withHotelRoomBookingLocks({
      connection,
      roomIds: [roomA],
      owner: "second-owner",
      fn: async () => "second",
    }).catch((error) => error);
    assert.ok(second instanceof HotelApiError);
    assert.equal(second.status, 409);
    assert.equal(connection.state.locks.length, 1);

    release();
    assert.equal(await first, "first");
    assert.equal(connection.state.locks.length, 0);

    const third = await withHotelRoomBookingLocks({
      connection,
      roomIds: [roomA],
      owner: "third-owner",
      fn: async () => "third",
    });
    assert.equal(third, "third");
    assert.equal(connection.state.locks.length, 0);

    const now = Date.now();
    connection.state.locks.push({
      _id: roomA,
      owner: "stale-owner",
      expiresAt: new Date(now - 1),
    });
    const stolen = await withHotelRoomBookingLocks({
      connection,
      roomIds: [roomA],
      owner: "stealing-owner",
      now,
      fn: async () => "stolen",
    });
    assert.equal(stolen, "stolen");
    assert.equal(connection.state.locks.length, 0);

    connection.state.lockAcquireOrder = [];
    await withHotelRoomBookingLocks({
      connection,
      roomIds: [roomB, roomA],
      owner: "ordered-owner",
      fn: async () => "ordered",
    });
    assert.deepEqual(connection.state.lockAcquireOrder, [roomA, roomB]);
    assert.ok(HOTEL_BOOKING_LOCK_TTL_MS > 0);
  });
});

describe("Hotel guest and reservation HTTP routes", () => {
  test("requires authentication and enforces CSRF and exact origin", async () => {
    const connection = createFakeConnection();

    const badOrigin = await runHandler(
      handleCreateGuest,
      buildRequest({
        method: "POST",
        path: "/api/hotel/guests",
        origin: "https://evil.example",
        body: {
          firstName: "Abebe",
          lastName: "Bekele",
          phone: "+251911000000",
        },
      }),
      {},
      { connect: connection }
    );
    assert.equal(badOrigin.status, 403);
    assert.equal(
      (await badOrigin.json()).error.code,
      HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED
    );
    assert.equal(connection.state.guests.length, 0);
  });

  test("Phase 1 MANAGER can run the guest and reservation workflow", async () => {
    const connection = createFakeConnection({ role: "RECEPTIONIST" });
    const roomType = seedRoomType(connection);
    const room = seedRoom(connection, roomType);

    const createdGuestResponse = await runHandler(
      handleCreateGuest,
      buildRequest({
        method: "POST",
        path: "/api/hotel/guests",
        body: {
          firstName: "Abebe",
          lastName: "Bekele",
          phone: "+251911000000",
          email: "abebe@example.com",
          idType: "PASSPORT",
          idNumber: "P123456",
        },
      }),
      {},
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(createdGuestResponse.status, 201);
    const createdGuest = await createdGuestResponse.json();
    const guestId = createdGuest.data.guest.id;

    const listedGuests = await runHandler(
      handleListGuests,
      buildRequest({
        path: "/api/hotel/guests?search=abebe&isActive=true",
      }),
      {},
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(listedGuests.status, 200);
    assert.equal((await listedGuests.json()).data.total, 1);

    const detailGuest = await runHandler(
      handleGetGuest,
      buildRequest({ path: `/api/hotel/guests/${guestId}` }),
      paramsFor(guestId),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(detailGuest.status, 200);

    const updatedGuest = await runHandler(
      handleUpdateGuest,
      buildRequest({
        method: "PATCH",
        path: `/api/hotel/guests/${guestId}`,
        body: { phone: "+251 911 222 222" },
      }),
      paramsFor(guestId),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(updatedGuest.status, 200);
    assert.equal(
      (await updatedGuest.json()).data.guest.phone,
      "+251 911 222 222"
    );

    const createdReservationResponse = await runHandler(
      handleCreateReservation,
      buildRequest({
        method: "POST",
        path: "/api/hotel/reservations",
        body: {
          guestId,
          roomTypeId: String(roomType._id),
          arrivalDate: localDateIn(10),
          departureDate: localDateIn(12),
          adults: 2,
          notes: "Late arrival",
        },
      }),
      {},
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(createdReservationResponse.status, 201);
    const createdReservation = await createdReservationResponse.json();
    const reservationId = createdReservation.data.reservation.id;
    assert.equal(createdReservation.data.reservation.nightlyRate, 120);

    const assigned = await runHandler(
      handleAssignReservationRoom,
      buildRequest({
        method: "POST",
        path: `/api/hotel/reservations/${reservationId}/room`,
        body: { roomId: String(room._id) },
      }),
      paramsFor(reservationId),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(assigned.status, 200);
    assert.equal((await assigned.json()).data.reservation.roomId, String(room._id));

    const listedReservations = await runHandler(
      handleListReservations,
      buildRequest({
        path: "/api/hotel/reservations?activeOnly=true",
      }),
      {},
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(listedReservations.status, 200);
    const listedReservationsBody = await listedReservations.json();
    assert.equal(listedReservationsBody.data.total, 1);
    assert.equal(listedReservationsBody.data.items[0].status, "CONFIRMED");

    const detailReservation = await runHandler(
      handleGetReservation,
      buildRequest({
        path: `/api/hotel/reservations/${reservationId}`,
      }),
      paramsFor(reservationId),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(detailReservation.status, 200);

    const updatedReservation = await runHandler(
      handleUpdateReservation,
      buildRequest({
        method: "PATCH",
        path: `/api/hotel/reservations/${reservationId}`,
        body: { notes: "Guest will arrive late" },
      }),
      paramsFor(reservationId),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(updatedReservation.status, 200);
    assert.equal(
      (await updatedReservation.json()).data.reservation.notes,
      "Guest will arrive late"
    );

    const cancelled = await runHandler(
      handleCancelReservation,
      buildRequest({
        method: "POST",
        path: `/api/hotel/reservations/${reservationId}/cancel`,
      }),
      paramsFor(reservationId),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(cancelled.status, 200);
    const cancelledBody = await cancelled.json();
    assert.equal(cancelledBody.data.reservation.status, "CANCELLED");
    assert.equal(cancelledBody.data.reservation.cancellation.reason, "");

    const deactivatedGuest = await runHandler(
      handleDeactivateGuest,
      buildRequest({
        method: "POST",
        path: `/api/hotel/guests/${guestId}/deactivate`,
      }),
      paramsFor(guestId),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(deactivatedGuest.status, 200);
    assert.equal((await deactivatedGuest.json()).data.changed, true);

    const actions = connection.state.audits.map((entry) => entry.action);
    for (const action of [
      HOTEL_AUDIT_ACTIONS.GUEST_CREATED,
      HOTEL_AUDIT_ACTIONS.GUEST_UPDATED,
      HOTEL_AUDIT_ACTIONS.GUEST_DEACTIVATED,
      HOTEL_AUDIT_ACTIONS.RESERVATION_CREATED,
      HOTEL_AUDIT_ACTIONS.RESERVATION_ROOM_ASSIGNED,
      HOTEL_AUDIT_ACTIONS.RESERVATION_UPDATED,
      HOTEL_AUDIT_ACTIONS.RESERVATION_CANCELLED,
    ]) {
      assert.ok(actions.includes(action), `${action} should be audited`);
    }
  });

  test("invalid queries and route ids fail before a model write", async () => {
    const connection = createFakeConnection();

    const badStatus = await runHandler(
      handleListReservations,
      buildRequest({
        path: "/api/hotel/reservations?status=UNKNOWN",
      }),
      {},
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(badStatus.status, 422);
    assert.ok((await badStatus.json()).error.details.fieldErrors.status);

    const badDate = await runHandler(
      handleListReservations,
      buildRequest({
        path: "/api/hotel/reservations?arrivalFrom=not-a-date",
      }),
      {},
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(badDate.status, 422);
    assert.ok((await badDate.json()).error.details.fieldErrors.arrivalFrom);

    const badLimit = await runHandler(
      handleListGuests,
      buildRequest({ path: "/api/hotel/guests?limit=500" }),
      {},
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(badLimit.status, 422);
    assert.ok((await badLimit.json()).error.details.fieldErrors.limit);

    const badId = await runHandler(
      handleGetGuest,
      buildRequest({ path: "/api/hotel/guests/not-an-id" }),
      paramsFor("not-an-id"),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(badId.status, 422);
    assert.ok((await badId.json()).error.details.fieldErrors.id);

    const noBodyCancel = await runHandler(
      handleCancelReservation,
      buildRequest({
        method: "POST",
        path: "/api/hotel/reservations/not-an-id/cancel",
      }),
      paramsFor("not-an-id"),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(noBodyCancel.status, 422);
  });

  test("route files are protected, node-runtime, and expose no hard delete", () => {
    const routeFiles = [
      "app/api/hotel/guests/route.js",
      "app/api/hotel/guests/[id]/route.js",
      "app/api/hotel/guests/[id]/deactivate/route.js",
      "app/api/hotel/reservations/route.js",
      "app/api/hotel/reservations/[id]/route.js",
      "app/api/hotel/reservations/[id]/cancel/route.js",
      "app/api/hotel/reservations/[id]/room/route.js",
    ];

    for (const file of routeFiles) {
      const source = src(file);
      assert.match(source, /export const runtime = "nodejs"/, file);
      assert.match(source, /export const dynamic = "force-dynamic"/, file);
      assert.match(source, /withHotelApi/, file);
      assert.ok(!/export\s+const\s+DELETE/.test(source), `${file} must not delete`);
    }

    for (const file of [
      "lib/hotel/services/guests.js",
      "lib/hotel/services/reservations.js",
      "lib/hotel/models/guest.js",
      "lib/hotel/models/reservation.js",
    ]) {
      const source = src(file);
      assert.ok(
        !/deleteOne|deleteMany|findByIdAndDelete|findOneAndDelete/.test(source),
        `${file} must not hard-delete business records`
      );
    }
  });
});

describe("Hotel reception model isolation (DB-free)", () => {
  test("Guest, Reservation, and RoomBookingLock compile only on the Hotel connection", async () => {
    assert.equal(mongoose.models.Guest, undefined);
    assert.equal(mongoose.models.Reservation, undefined);
    assert.equal(mongoose.models.RoomBookingLock, undefined);

    const connection = mongoose.createConnection();
    try {
      const Guest = getGuestModel(connection);
      assert.equal(connection.models.Guest, Guest);
      assert.equal(mongoose.models.Guest, undefined);
      assert.equal(Guest.collection.name, "hotel_guests");
      assert.equal(Guest.schema.path("isActive").defaultValue, true);

      const invalidGuest = new Guest({
        firstName: "Abebe",
        lastName: "Bekele",
        phone: "+251911000000",
        idType: "UNKNOWN",
      });
      await assert.rejects(
        invalidGuest.validate(),
        (error) => Boolean(error.errors.idType)
      );

      const Reservation = getReservationModel(connection);
      assert.equal(connection.models.Reservation, Reservation);
      assert.equal(mongoose.models.Reservation, undefined);
      assert.equal(Reservation.collection.name, "hotel_reservations");
      assert.equal(Reservation.schema.path("status").defaultValue, "CONFIRMED");

      const valid = new Reservation({
        reservationNumber: "RES-20300115-ABCDEF",
        guestId: new mongoose.Types.ObjectId(),
        guestSnapshot: {
          firstName: "Abebe",
          lastName: "Bekele",
          fullName: "Abebe Bekele",
          phone: "+251911000000",
          email: null,
        },
        roomTypeId: new mongoose.Types.ObjectId(),
        roomTypeSnapshot: {
          name: "Deluxe",
          code: "DLX",
          capacity: 2,
          baseNightlyRate: 120,
        },
        arrivalDate: new Date("2030-01-14T21:00:00.000Z"),
        departureDate: new Date("2030-01-16T21:00:00.000Z"),
        nights: 2,
        adults: 2,
        children: 0,
        nightlyRate: 120,
        rateSource: "ROOM_TYPE_BASE",
        totalAmount: 240,
        status: "CONFIRMED",
        statusHistory: [
          {
            status: "CONFIRMED",
            previousStatus: null,
            changedAt: new Date(),
            changedBy: null,
            note: "",
          },
        ],
      });
      await valid.validate();

      const invalidStatus = new Reservation({
        ...valid.toObject(),
        status: "DIRTY",
      });
      await assert.rejects(
        invalidStatus.validate(),
        (error) => Boolean(error.errors.status)
      );

      const indexes = Reservation.schema.indexes();
      assert.ok(
        indexes.some(
          ([keys, options]) =>
            keys.reservationNumber === 1 && options.unique === true
        ),
        "reservationNumber unique index is defined"
      );
      assert.ok(
        indexes.some(
          ([keys]) =>
            keys.roomId === 1 &&
            keys.status === 1 &&
            keys.arrivalDate === 1 &&
            keys.departureDate === 1
        ),
        "overlap lookup index is defined"
      );

      const Lock = getRoomBookingLockModel(connection);
      assert.equal(connection.models.RoomBookingLock, Lock);
      assert.equal(mongoose.models.RoomBookingLock, undefined);
      assert.equal(Lock.collection.name, "hotel_room_booking_locks");
      assert.ok(
        Lock.schema
          .indexes()
          .some(
            ([keys, options]) =>
              keys.expiresAt === 1 && options.expireAfterSeconds === 0
          ),
        "lock TTL index is defined only"
      );
    } finally {
      await connection.close();
    }
  });
});
