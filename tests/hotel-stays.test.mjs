// Hotel Stay, check-in, and check-out backend tests — DB-free.
//
// No MongoDB connection is opened and no index is created. The services and
// route handlers run against an in-memory stub connection so transitions,
// concurrency gates, date boundaries, rate snapshots, room coordination,
// payment-summary boundaries, permissions, CSRF, and audits can be exercised
// deterministically.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import {
  HOTEL_PAYMENT_CURRENCY,
  HOTEL_STAY_CHARGE_RULE,
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
import { getStayModel } from "../lib/hotel/models/stay.js";
import { withHotelApi } from "../lib/hotel/http/apiResponse.js";
import {
  handleCheckInReservation,
  handleCheckOutStay,
  handleGetStay,
  handleListGuestStays,
  handleListReservationStays,
  handleListStays,
} from "../lib/hotel/http/stayHandlers.js";
import {
  calculateHotelStayCharges,
  checkInReservation,
  checkOutStay,
  getStay,
  listGuestStays,
  listReservationStays,
  listStays,
} from "../lib/hotel/services/stays.js";
import {
  getHotelStayPaymentSummary,
  HOTEL_PAYMENT_SUMMARY_SOURCES,
} from "../lib/hotel/services/stayPayments.js";
import { withHotelRoomBookingLocks } from "../lib/hotel/services/bookingLocks.js";
import {
  formatHotelLocalDate,
  getHotelStayNights,
  parseHotelLocalDate,
} from "../lib/hotel/dates.js";
import {
  validateCheckInPayload,
  validateCheckOutPayload,
} from "../lib/hotel/validation.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (path) => readFileSync(join(root, path), "utf8");

const TEST_HOTEL_SECRET = "hotel-stay-test-secret-independent-1234567890";
const TEST_MONGO_URI = "mongodb://127.0.0.1:27017/bono_hotel";
const TEST_ORIGIN = "https://hotel.example";
const CHECK_IN_NOW = Date.UTC(2030, 0, 15, 10, 0, 0);
const CHECK_OUT_NOW = Date.UTC(2030, 0, 17, 1, 0, 0);

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
      const operators = Object.keys(expected).filter((key) =>
        key.startsWith("$")
      );
      if (operators.length > 0) {
        return operators.every((operator) => {
          switch (operator) {
            case "$ne":
              return String(actual) !== String(expected.$ne);
            case "$in": {
              const allowed = new Set(
                expected.$in.map((value) => String(value))
              );
              return allowed.has(String(actual));
            }
            case "$lt":
              return comparable(actual) < comparable(expected.$lt);
            case "$lte":
              return comparable(actual) <= comparable(expected.$lte);
            case "$gt":
              return comparable(actual) > comparable(expected.$gt);
            case "$gte":
              return comparable(actual) >= comparable(expected.$gte);
            default:
              return false;
          }
        });
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
      const result = async () => cloneRow(findRow(filter));
      return {
        select: () => ({ lean: result }),
        lean: result,
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

function createFakeConnection({ role = "RECEPTIONIST", withPayments = false } = {}) {
  const state = {
    user: makeUser({ role }),
    sessions: [],
    audits: [],
    guests: [],
    roomTypes: [],
    rooms: [],
    reservations: [],
    stays: [],
    payments: [],
    locks: [],
    lockAcquireOrder: [],
    auditFails: false,
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

  const models = {
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
    RoomType: makeCollectionModel(state, "roomTypes", { uniqueField: "code" }),
    Room: makeCollectionModel(state, "rooms", { uniqueField: "roomNumber" }),
    Reservation: makeCollectionModel(state, "reservations", {
      uniqueField: "reservationNumber",
    }),
    Stay: makeCollectionModel(state, "stays", {
      uniqueField: "reservationId",
    }),
    RoomBookingLock: lockModel,
  };

  if (withPayments) {
    models.HotelPayment = makeCollectionModel(state, "payments");
  }

  return { state, models };
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
  const arrivalLocalDate = overrides.arrivalLocalDate ?? "2030-01-15";
  const departureLocalDate = overrides.departureLocalDate ?? "2030-01-17";
  const arrivalDate = parseHotelLocalDate(arrivalLocalDate);
  const departureDate = parseHotelLocalDate(departureLocalDate);
  const nights = getHotelStayNights(arrivalDate, departureDate);
  const now = new Date();
  const roomId = overrides.roomId ?? null;
  const room = roomId
    ? connection.state.rooms.find((entry) => String(entry._id) === String(roomId))
    : null;
  const nightlyRate = overrides.nightlyRate ?? roomType.baseNightlyRate;
  const status = overrides.status ?? "CONFIRMED";
  const reservation = {
    _id: new mongoose.Types.ObjectId(),
    reservationNumber:
      overrides.reservationNumber ??
      `RES-${arrivalLocalDate.replaceAll("-", "")}-A1B2C3`,
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
    status,
    notes: overrides.notes ?? "",
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: "",
    stayId: overrides.stayId ?? null,
    checkedInAt: overrides.checkedInAt ?? null,
    checkedInBy: overrides.checkedInBy ?? null,
    checkedOutAt: overrides.checkedOutAt ?? null,
    checkedOutBy: overrides.checkedOutBy ?? null,
    createdBy: null,
    updatedBy: null,
    statusHistory: overrides.statusHistory ?? [
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
  };
  connection.state.reservations.push(reservation);
  return reservation;
}

function seedStay(connection, reservation, room, overrides = {}) {
  const now = new Date();
  const checkedInAt = overrides.checkedInAt ?? new Date(CHECK_IN_NOW);
  const stay = {
    _id: new mongoose.Types.ObjectId(),
    reservationId: reservation._id,
    reservationNumber: reservation.reservationNumber,
    guestId: reservation.guestId,
    guestSnapshot: { ...reservation.guestSnapshot },
    roomTypeId: reservation.roomTypeId,
    roomTypeSnapshot: { ...reservation.roomTypeSnapshot },
    roomId: room._id,
    roomSnapshot: { ...reservation.roomSnapshot },
    arrivalDate: reservation.arrivalDate,
    departureDate: reservation.departureDate,
    reservationNights: reservation.nights,
    adults: reservation.adults,
    children: reservation.children,
    nightlyRate: reservation.nightlyRate,
    rateSource: reservation.rateSource,
    reservationTotalAmount: reservation.totalAmount,
    notes: reservation.notes,
    expectedCheckOutAt: reservation.departureDate,
    status: overrides.status ?? "IN_HOUSE",
    checkedInAt,
    checkedInBy: overrides.checkedInBy ?? connection.state.user._id,
    checkInNote: overrides.checkInNote ?? "",
    checkedOutAt: overrides.checkedOutAt ?? null,
    checkedOutBy: overrides.checkedOutBy ?? null,
    checkOutNote: overrides.checkOutNote ?? "",
    billableNights: overrides.billableNights ?? null,
    roomCharges: overrides.roomCharges ?? null,
    totalCharges: overrides.totalCharges ?? null,
    chargeRule: overrides.chargeRule ?? null,
    statusHistory: overrides.statusHistory ?? [
      {
        status: "IN_HOUSE",
        previousStatus: null,
        changedAt: checkedInAt,
        changedBy: overrides.checkedInBy ?? connection.state.user._id,
        note: overrides.checkInNote ?? "",
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  connection.state.stays.push(stay);
  return stay;
}

function buildRequest({
  method = "GET",
  path = "/api/hotel/stays",
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
  // Phase 4-A: default to a simulated canonical POS MANAGER (test-only seam);
  // explicit `deps.authenticate` always wins. Origin/validation are unaffected.
  const merged = { authenticate: testManagerAuth, ...deps };
  return withHotelApi((req, ctx) => handler(req, ctx, merged))(request, context);
}

// Phase 4-A: simulate a canonical POS MANAGER for DB-free HTTP tests.
async function testManagerAuth() {
  return { ok: true, payload: { staffId: null, role: "MANAGER", name: "test-manager" } };
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

async function checkedInFixture(overrides = {}) {
  const connection = createFakeConnection(overrides.connection);
  const roomType = seedRoomType(connection, overrides.roomType);
  const guest = seedGuest(connection, overrides.guest);
  const room = seedRoom(connection, roomType, {
    roomNumber: "101",
    ...overrides.room,
  });
  const reservation = seedReservation(connection, guest, roomType, {
    roomId: room._id,
    ...overrides.reservation,
  });
  const actor = toSafeHotelUser(connection.state.user);
  const checkedIn = await checkInReservation({
    connection,
    id: String(reservation._id),
    actor,
    now: CHECK_IN_NOW,
    input: { note: "Checked in at the front desk" },
  });
  return {
    connection,
    roomType,
    guest,
    room,
    reservation,
    actor,
    checkedIn,
  };
}

describe("Hotel stay charge rule", () => {
  test("charges Addis calendar nights with a one-night minimum", () => {
    const oneNight = calculateHotelStayCharges({
      nightlyRate: 120,
      checkedInAt: new Date("2030-01-15T10:00:00.000Z"),
      checkedOutAt: new Date("2030-01-15T20:00:00.000Z"),
    });
    assert.equal(oneNight.billableNights, 1);
    assert.equal(oneNight.roomCharges, 120);
    assert.equal(oneNight.totalCharges, 120);
    assert.equal(oneNight.chargeRule, HOTEL_STAY_CHARGE_RULE);
    assert.equal(oneNight.checkInLocalDate, "2030-01-15");
    assert.equal(oneNight.checkOutLocalDate, "2030-01-15");

    const twoNights = calculateHotelStayCharges({
      nightlyRate: 120,
      checkedInAt: new Date("2030-01-15T10:00:00.000Z"),
      checkedOutAt: new Date("2030-01-17T01:00:00.000Z"),
    });
    assert.equal(twoNights.billableNights, 2);
    assert.equal(twoNights.roomCharges, 240);
    assert.equal(twoNights.totalCharges, 240);

    const overstay = calculateHotelStayCharges({
      nightlyRate: 150,
      checkedInAt: new Date("2030-01-15T10:00:00.000Z"),
      checkedOutAt: new Date("2030-01-18T01:00:00.000Z"),
    });
    assert.equal(overstay.billableNights, 3);
    assert.equal(overstay.roomCharges, 450);
    assert.equal(overstay.totalCharges, 450);
  });

  test("rejects invalid rates and checkout before check-in", () => {
    const negativeRate = capture(() =>
      calculateHotelStayCharges({
        nightlyRate: -1,
        checkedInAt: new Date("2030-01-15T10:00:00.000Z"),
        checkedOutAt: new Date("2030-01-16T10:00:00.000Z"),
      })
    );
    assert.ok(negativeRate instanceof HotelValidationError);
    assert.ok(negativeRate.fieldErrors.nightlyRate);

    const backwards = capture(() =>
      calculateHotelStayCharges({
        nightlyRate: 120,
        checkedInAt: new Date("2030-01-17T10:00:00.000Z"),
        checkedOutAt: new Date("2030-01-16T10:00:00.000Z"),
      })
    );
    assert.ok(backwards instanceof HotelValidationError);
    assert.ok(backwards.fieldErrors.checkedOutAt);

    const missing = capture(() =>
      calculateHotelStayCharges({ nightlyRate: 120 })
    );
    assert.ok(missing instanceof HotelValidationError);
    assert.ok(missing.fieldErrors.checkedInAt);
  });
});

describe("Hotel stay model and payment boundary", () => {
  test("Stay compiles only on the Hotel connection and defines its indexes", async () => {
    assert.equal(mongoose.models.Stay, undefined);

    const connection = mongoose.createConnection();
    try {
      const Stay = getStayModel(connection);
      assert.equal(connection.models.Stay, Stay);
      assert.equal(mongoose.models.Stay, undefined);
      assert.equal(Stay.collection.name, "hotel_stays");
      assert.deepEqual(Stay.schema.path("status").enumValues, [
        "IN_HOUSE",
        "CHECKED_OUT",
      ]);

      const valid = new Stay({
        reservationId: new mongoose.Types.ObjectId(),
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
        roomId: new mongoose.Types.ObjectId(),
        roomSnapshot: { roomNumber: "101", floor: 1 },
        arrivalDate: new Date("2030-01-14T21:00:00.000Z"),
        departureDate: new Date("2030-01-16T21:00:00.000Z"),
        reservationNights: 2,
        adults: 2,
        children: 0,
        nightlyRate: 120,
        rateSource: "ROOM_TYPE_BASE",
        reservationTotalAmount: 240,
        expectedCheckOutAt: new Date("2030-01-16T21:00:00.000Z"),
        status: "IN_HOUSE",
        checkedInAt: new Date("2030-01-15T07:00:00.000Z"),
        statusHistory: [
          {
            status: "IN_HOUSE",
            previousStatus: null,
            changedAt: new Date("2030-01-15T07:00:00.000Z"),
            changedBy: null,
            note: "",
          },
        ],
      });
      await valid.validate();

      const invalidStatus = new Stay({ ...valid.toObject(), status: "DIRTY" });
      await assert.rejects(
        invalidStatus.validate(),
        (error) => Boolean(error.errors.status)
      );

      const indexes = Stay.schema.indexes();
      assert.ok(
        indexes.some(
          ([keys, options]) =>
            keys.reservationId === 1 && options.unique === true
        ),
        "reservationId unique index is defined"
      );
      assert.ok(
        indexes.some(([keys]) => keys.roomId === 1 && keys.status === 1),
        "active-stay room lookup index is defined"
      );
    } finally {
      await connection.close();
    }
  });

  test("payment summary is explicitly unavailable when no payment model exists", async () => {
    const connection = createFakeConnection();
    const stay = {
      _id: new mongoose.Types.ObjectId(),
      totalCharges: 360,
    };

    const summary = await getHotelStayPaymentSummary({ connection, stay });
    assert.equal(summary.available, false);
    assert.equal(summary.currency, HOTEL_PAYMENT_CURRENCY);
    assert.equal(summary.totalCharges, 360);
    assert.equal(summary.totalPaid, null);
    assert.equal(summary.outstandingBalance, null);
    assert.equal(summary.paymentCount, 0);
    assert.equal(
      summary.source,
      HOTEL_PAYMENT_SUMMARY_SOURCES.PAYMENTS_NOT_IMPLEMENTED
    );
    assert.notEqual(summary.totalPaid, 0);
  });

  test("payment summary counts active payments and ignores voided records", async () => {
    const connection = createFakeConnection({ withPayments: true });
    const stayId = new mongoose.Types.ObjectId();
    const reservationId = new mongoose.Types.ObjectId();
    const stay = { _id: stayId, totalCharges: 360 };

    connection.state.payments.push(
      { _id: new mongoose.Types.ObjectId(), stayId, amount: 100, status: "PAID" },
      {
        _id: new mongoose.Types.ObjectId(),
        stayId,
        amount: 50,
        status: "PARTIALLY_PAID",
      },
      {
        _id: new mongoose.Types.ObjectId(),
        stayId,
        amount: 999,
        status: "VOIDED",
      },
      {
        _id: new mongoose.Types.ObjectId(),
        stayId,
        amount: 20,
        status: "CANCELLED",
      }
    );

    const summary = await getHotelStayPaymentSummary({
      connection,
      stay,
      reservation: { _id: reservationId },
    });
    assert.equal(summary.available, true);
    assert.equal(summary.totalCharges, 360);
    assert.equal(summary.totalPaid, 150);
    assert.equal(summary.outstandingBalance, 210);
    assert.equal(summary.overpayment, 0);
    assert.equal(summary.paymentCount, 2);
    assert.equal(
      summary.source,
      HOTEL_PAYMENT_SUMMARY_SOURCES.HOTEL_PAYMENT_RECORDS
    );

    const overpaid = await getHotelStayPaymentSummary({
      connection,
      stay: { _id: stayId, totalCharges: 100 },
      reservation: { _id: reservationId },
    });
    assert.equal(overpaid.totalPaid, 150);
    assert.equal(overpaid.outstandingBalance, 0);
    assert.equal(overpaid.overpayment, 50);
  });
});

describe("Hotel check-in service", () => {
  test("checks in a confirmed reservation with snapshots and coordinated statuses", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType, { roomNumber: "101" });
    const reservation = seedReservation(connection, guest, roomType, {
      roomId: room._id,
    });
    const actor = toSafeHotelUser(connection.state.user);

    const result = await checkInReservation({
      connection,
      id: String(reservation._id),
      actor,
      now: CHECK_IN_NOW,
      input: { note: "Early arrival" },
    });

    assert.equal(result.changed, true);
    assert.equal(result.stay.status, "IN_HOUSE");
    assert.equal(result.stay.reservationId, String(reservation._id));
    assert.equal(result.stay.reservationNumber, reservation.reservationNumber);
    assert.equal(result.stay.guestId, String(guest._id));
    assert.equal(result.stay.roomId, String(room._id));
    assert.equal(result.stay.nightlyRate, 120);
    assert.equal(result.stay.rateSource, "ROOM_TYPE_BASE");
    assert.equal(result.stay.reservationNights, 2);
    assert.equal(result.stay.reservationTotalAmount, 240);
    assert.equal(result.stay.expectedCheckOutAt, reservation.departureDate.toISOString());
    assert.equal(result.stay.checkedInAt, new Date(CHECK_IN_NOW).toISOString());
    assert.equal(result.stay.checkedInLocalDate, "2030-01-15");
    assert.equal(result.stay.checkInNote, "Early arrival");
    assert.equal(result.stay.guestSnapshot.fullName, "Abebe Bekele");
    assert.equal(result.stay.roomTypeSnapshot.code, "DLX");
    assert.equal(result.stay.roomSnapshot.roomNumber, "101");
    assert.equal(result.stay.paymentSummary, null);
    assert.equal(result.stay.statusHistory.length, 1);
    assert.equal(result.stay.statusHistory[0].status, "IN_HOUSE");

    assert.equal(result.reservation.status, "CHECKED_IN");
    assert.equal(result.reservation.stayId, result.stay.id);
    assert.equal(result.reservation.checkedInAt, new Date(CHECK_IN_NOW).toISOString());
    assert.equal(result.roomStatus, "OCCUPIED");
    assert.equal(result.roomStatusChanged, true);
    assert.equal(room.operationalStatus, "OCCUPIED");
    assert.equal(room.statusHistory.at(-1).status, "OCCUPIED");
    assert.equal(connection.state.stays.length, 1);
    assert.equal(connection.state.locks.length, 0);

    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.STAY_CHECKED_IN).length,
      1
    );
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.RESERVATION_CHECKED_IN).length,
      1
    );
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_STATUS_CHANGED).length,
      1
    );
  });

  test("accepts a RESERVED room and records the room transition", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType, {
      roomNumber: "102",
      operationalStatus: "RESERVED",
    });
    const reservation = seedReservation(connection, guest, roomType, {
      roomId: room._id,
    });

    const result = await checkInReservation({
      connection,
      id: String(reservation._id),
      now: CHECK_IN_NOW,
    });

    assert.equal(result.changed, true);
    assert.equal(result.roomStatus, "OCCUPIED");
    assert.equal(result.roomStatusChanged, true);
    assert.equal(room.operationalStatus, "OCCUPIED");
  });

  test("duplicate check-in is idempotent and creates exactly one stay", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);
    const reservation = seedReservation(connection, guest, roomType, {
      roomId: room._id,
    });
    const actor = toSafeHotelUser(connection.state.user);

    const first = await checkInReservation({
      connection,
      id: String(reservation._id),
      actor,
      now: CHECK_IN_NOW,
    });
    const auditCount = connection.state.audits.length;

    const second = await checkInReservation({
      connection,
      id: String(reservation._id),
      actor,
      now: CHECK_IN_NOW + 60_000,
    });

    assert.equal(second.changed, false);
    assert.equal(second.stay.id, first.stay.id);
    assert.equal(second.stay.checkedInAt, first.stay.checkedInAt);
    assert.equal(connection.state.stays.length, 1);
    assert.equal(connection.state.audits.length, auditCount);
    assert.equal(room.operationalStatus, "OCCUPIED");
    assert.equal(reservation.status, "CHECKED_IN");
  });

  test("concurrent check-in is serialized by the room lock and keeps one stay", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);
    const reservation = seedReservation(connection, guest, roomType, {
      roomId: room._id,
    });
    const actor = toSafeHotelUser(connection.state.user);

    const results = await Promise.allSettled([
      checkInReservation({
        connection,
        id: String(reservation._id),
        actor,
        now: CHECK_IN_NOW,
      }),
      checkInReservation({
        connection,
        id: String(reservation._id),
        actor,
        now: CHECK_IN_NOW,
      }),
    ]);

    const fulfilled = results
      .filter((entry) => entry.status === "fulfilled")
      .map((entry) => entry.value);
    const rejected = results
      .filter((entry) => entry.status === "rejected")
      .map((entry) => entry.reason);

    assert.equal(connection.state.stays.length, 1);
    assert.equal(fulfilled.filter((entry) => entry.changed === true).length, 1);
    for (const error of rejected) {
      assert.ok(error instanceof HotelApiError);
      assert.equal(error.status, 409);
    }
    assert.equal(room.operationalStatus, "OCCUPIED");
    assert.equal(reservation.status, "CHECKED_IN");
  });

  test("a held room lock blocks check-in without creating a stay", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);
    const reservation = seedReservation(connection, guest, roomType, {
      roomId: room._id,
    });

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
      roomIds: [String(room._id)],
      owner: "held-check-in",
      now: CHECK_IN_NOW,
      fn: async () => {
        started();
        await gate;
      },
    });
    await startedPromise;

    const blocked = await checkInReservation({
      connection,
      id: String(reservation._id),
      now: CHECK_IN_NOW,
    }).catch((error) => error);
    assert.ok(blocked instanceof HotelApiError);
    assert.equal(blocked.status, 409);
    assert.equal(connection.state.stays.length, 0);
    assert.equal(reservation.status, "CONFIRMED");
    assert.equal(room.operationalStatus, "AVAILABLE");

    release();
    await held;

    const allowed = await checkInReservation({
      connection,
      id: String(reservation._id),
      now: CHECK_IN_NOW,
    });
    assert.equal(allowed.changed, true);
    assert.equal(connection.state.stays.length, 1);
  });

  test("rejects invalid reservation states and date windows", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);

    for (const status of ["CANCELLED", "NO_SHOW", "CHECKED_OUT"]) {
      const reservation = seedReservation(connection, guest, roomType, {
        roomId: room._id,
        status,
      });
      const error = await checkInReservation({
        connection,
        id: String(reservation._id),
        now: CHECK_IN_NOW,
      }).catch((caught) => caught);
      assert.ok(error instanceof HotelApiError, status);
      assert.equal(error.status, 409, status);
    }

    const early = seedReservation(connection, guest, roomType, {
      roomId: room._id,
      arrivalLocalDate: "2030-01-16",
      departureLocalDate: "2030-01-18",
    });
    const earlyError = await checkInReservation({
      connection,
      id: String(early._id),
      now: CHECK_IN_NOW,
    }).catch((error) => error);
    assert.ok(earlyError instanceof HotelApiError);
    assert.equal(earlyError.status, 409);
    assert.equal(earlyError.details.field, "arrivalDate");

    const departed = seedReservation(connection, guest, roomType, {
      roomId: room._id,
      arrivalLocalDate: "2030-01-13",
      departureLocalDate: "2030-01-15",
    });
    const departedError = await checkInReservation({
      connection,
      id: String(departed._id),
      now: CHECK_IN_NOW,
    }).catch((error) => error);
    assert.ok(departedError instanceof HotelApiError);
    assert.equal(departedError.status, 409);
    assert.equal(departedError.details.field, "departureDate");

    const unassigned = seedReservation(connection, guest, roomType);
    const unassignedError = await checkInReservation({
      connection,
      id: String(unassigned._id),
      now: CHECK_IN_NOW,
    }).catch((error) => error);
    assert.ok(unassignedError instanceof HotelApiError);
    assert.equal(unassignedError.status, 409);
    assert.equal(unassignedError.details.field, "roomId");
    assert.equal(connection.state.stays.length, 0);
  });

  test("rejects rooms that are not ready or not suitable", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);

    for (const status of ["CLEANING", "MAINTENANCE", "OUT_OF_SERVICE"]) {
      const room = seedRoom(connection, roomType, {
        roomNumber: `10${status.length}`,
        operationalStatus: status,
      });
      const reservation = seedReservation(connection, guest, roomType, {
        roomId: room._id,
      });
      const error = await checkInReservation({
        connection,
        id: String(reservation._id),
        now: CHECK_IN_NOW,
      }).catch((caught) => caught);
      assert.ok(error instanceof HotelApiError, status);
      assert.equal(error.status, 409, status);
    }

    const inactiveRoom = seedRoom(connection, roomType, {
      roomNumber: "120",
      isActive: false,
    });
    const inactiveReservation = seedReservation(connection, guest, roomType, {
      roomId: inactiveRoom._id,
    });
    const inactiveError = await checkInReservation({
      connection,
      id: String(inactiveReservation._id),
      now: CHECK_IN_NOW,
    }).catch((error) => error);
    assert.ok(inactiveError instanceof HotelApiError);
    assert.equal(inactiveError.status, 409);

    const otherType = seedRoomType(connection, {
      name: "Standard",
      code: "STD",
      capacity: 2,
      baseNightlyRate: 80,
    });
    const otherRoom = seedRoom(connection, otherType, { roomNumber: "130" });
    const mismatch = seedReservation(connection, guest, roomType, {
      roomId: otherRoom._id,
    });
    const mismatchError = await checkInReservation({
      connection,
      id: String(mismatch._id),
      now: CHECK_IN_NOW,
    }).catch((error) => error);
    assert.ok(mismatchError instanceof HotelApiError);
    assert.equal(mismatchError.status, 409);

    const smallRoom = seedRoom(connection, roomType, {
      roomNumber: "140",
      capacity: 1,
    });
    const largeParty = seedReservation(connection, guest, roomType, {
      roomId: smallRoom._id,
      adults: 2,
    });
    const capacityError = await checkInReservation({
      connection,
      id: String(largeParty._id),
      now: CHECK_IN_NOW,
    }).catch((error) => error);
    assert.ok(capacityError instanceof HotelApiError);
    assert.equal(capacityError.status, 409);

    const occupiedRoom = seedRoom(connection, roomType, { roomNumber: "150" });
    const activeRoomReservation = seedReservation(connection, guest, roomType, {
      roomId: occupiedRoom._id,
      status: "CHECKED_IN",
      reservationNumber: "RES-20300115-ACTIVE",
    });
    seedStay(connection, activeRoomReservation, occupiedRoom);
    const conflictReservation = seedReservation(connection, guest, roomType, {
      roomId: occupiedRoom._id,
      reservationNumber: "RES-20300115-CONFLICT",
    });
    const conflictError = await checkInReservation({
      connection,
      id: String(conflictReservation._id),
      now: CHECK_IN_NOW,
    }).catch((error) => error);
    assert.ok(conflictError instanceof HotelApiError);
    assert.equal(conflictError.status, 409);

    // An OCCUPIED room without a matching stay is not a valid first check-in;
    // OCCUPIED is only accepted while repairing an existing stay.
    const orphanedOccupied = seedRoom(connection, roomType, {
      roomNumber: "155",
      operationalStatus: "OCCUPIED",
    });
    const orphanedReservation = seedReservation(connection, guest, roomType, {
      roomId: orphanedOccupied._id,
      reservationNumber: "RES-20300115-ORPHAN",
    });
    const orphanedError = await checkInReservation({
      connection,
      id: String(orphanedReservation._id),
      now: CHECK_IN_NOW,
    }).catch((error) => error);
    assert.ok(orphanedError instanceof HotelApiError);
    assert.equal(orphanedError.status, 409);
    assert.equal(orphanedError.details.field, "roomId");
    assert.equal(
      connection.state.stays.filter(
        (stay) => String(stay.reservationId) === String(orphanedReservation._id)
      ).length,
      0
    );

    const overlapRoom = seedRoom(connection, roomType, { roomNumber: "160" });
    seedReservation(connection, guest, roomType, {
      roomId: overlapRoom._id,
      reservationNumber: "RES-20300115-OVERLAP1",
    });
    const overlappingReservation = seedReservation(connection, guest, roomType, {
      roomId: overlapRoom._id,
      reservationNumber: "RES-20300115-OVERLAP2",
    });
    const overlapError = await checkInReservation({
      connection,
      id: String(overlappingReservation._id),
      now: CHECK_IN_NOW,
    }).catch((error) => error);
    assert.ok(overlapError instanceof HotelApiError);
    assert.equal(overlapError.status, 409);
    assert.equal(overlapError.details.field, "roomId");
    assert.equal(overlapRoom.operationalStatus, "AVAILABLE");
  });

  test("repairing a partial check-in audits only the room step", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);
    const reservation = seedReservation(connection, guest, roomType, {
      roomId: room._id,
      status: "CHECKED_IN",
      checkedInAt: new Date(CHECK_IN_NOW),
      checkedInBy: connection.state.user._id,
    });
    const stay = seedStay(connection, reservation, room);
    reservation.stayId = stay._id;
    reservation.statusHistory.push({
      status: "CHECKED_IN",
      previousStatus: "CONFIRMED",
      changedAt: new Date(CHECK_IN_NOW),
      changedBy: connection.state.user._id,
      note: "",
    });
    connection.state.audits.length = 0;

    const result = await checkInReservation({
      connection,
      id: String(reservation._id),
      now: CHECK_IN_NOW,
    });

    assert.equal(result.changed, true);
    assert.equal(result.stay.id, String(stay._id));
    assert.equal(result.reservation.status, "CHECKED_IN");
    assert.equal(room.operationalStatus, "OCCUPIED");
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.STAY_CHECKED_IN).length,
      0
    );
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.RESERVATION_CHECKED_IN).length,
      0
    );
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_STATUS_CHANGED).length,
      1
    );
  });

  test("check-in does not reprice the reservation and the stay snapshot is immutable", async () => {
    const { connection, roomType, reservation, checkedIn } =
      await checkedInFixture();

    roomType.baseNightlyRate = 999;
    reservation.nightlyRate = 999;
    reservation.totalAmount = 999;

    const detail = await getStay({
      connection,
      id: checkedIn.stay.id,
    });
    assert.equal(detail.stay.nightlyRate, 120);
    assert.equal(detail.stay.rateSource, "ROOM_TYPE_BASE");
    assert.equal(detail.stay.reservationSnapshot.nightlyRate, 120);
    assert.equal(detail.stay.reservationSnapshot.totalAmount, 240);
    assert.equal(detail.stay.roomTypeSnapshot.baseNightlyRate, 120);
    assert.equal(detail.stay.reservation.nightlyRate, 999);
    assert.equal(detail.stay.roomType.baseNightlyRate, 999);
  });

  test("audit failures never break check-in", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);
    const reservation = seedReservation(connection, guest, roomType, {
      roomId: room._id,
    });
    connection.state.auditFails = true;

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const result = await checkInReservation({
        connection,
        id: String(reservation._id),
        now: CHECK_IN_NOW,
      });
      assert.equal(result.changed, true);
      assert.equal(result.stay.status, "IN_HOUSE");
      assert.equal(connection.state.audits.length, 0);
      assert.equal(connection.state.stays.length, 1);
      assert.equal(room.operationalStatus, "OCCUPIED");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("check-in payloads reject protected fields and accept an optional note", () => {
    assert.deepEqual(validateCheckInPayload({}), { note: "" });
    assert.deepEqual(validateCheckInPayload({ note: " Late arrival " }), {
      note: "Late arrival",
    });

    for (const field of [
      "reservationId",
      "roomId",
      "status",
      "nightlyRate",
      "totalCharges",
    ]) {
      const error = capture(() =>
        validateCheckInPayload({ [field]: "forged" })
      );
      assert.ok(error instanceof HotelValidationError, field);
      assert.ok(error.fieldErrors[field], field);
    }

    assert.deepEqual(validateCheckOutPayload({}), { note: "" });
  });
});

describe("Hotel check-out service", () => {
  test("checks out an in-house stay, charges actual nights, and moves the room to CLEANING", async () => {
    const { connection, room, reservation, checkedIn } =
      await checkedInFixture();
    const actor = toSafeHotelUser(connection.state.user);

    const result = await checkOutStay({
      connection,
      id: checkedIn.stay.id,
      actor,
      now: CHECK_OUT_NOW,
      input: { note: "Late checkout approved" },
    });

    assert.equal(result.changed, true);
    assert.equal(result.stay.status, "CHECKED_OUT");
    assert.equal(result.stay.billableNights, 2);
    assert.equal(result.stay.nightlyRate, 120);
    assert.equal(result.stay.roomCharges, 240);
    assert.equal(result.stay.totalCharges, 240);
    assert.equal(result.stay.chargeRule, HOTEL_STAY_CHARGE_RULE);
    assert.equal(result.stay.checkedOutAt, new Date(CHECK_OUT_NOW).toISOString());
    assert.equal(result.stay.checkedOutLocalDate, "2030-01-17");
    assert.equal(result.stay.checkedOutBy, String(connection.state.user._id));
    assert.equal(result.stay.checkOutNote, "Late checkout approved");
    assert.equal(result.stay.statusHistory.length, 2);
    assert.equal(result.stay.statusHistory[1].previousStatus, "IN_HOUSE");
    assert.equal(result.stay.statusHistory[1].status, "CHECKED_OUT");

    assert.equal(result.reservation.status, "CHECKED_OUT");
    assert.equal(result.reservation.checkedOutAt, new Date(CHECK_OUT_NOW).toISOString());
    assert.equal(result.reservation.checkedOutBy, String(connection.state.user._id));
    assert.equal(result.roomStatus, "CLEANING");
    assert.equal(result.roomStatusChanged, true);
    assert.equal(room.operationalStatus, "CLEANING");
    assert.equal(room.statusHistory.at(-1).status, "CLEANING");
    assert.notEqual(room.operationalStatus, "AVAILABLE");
    assert.equal(connection.state.locks.length, 0);

    assert.equal(result.paymentSummary.available, false);
    assert.equal(result.paymentSummary.totalPaid, null);
    assert.equal(result.paymentSummary.outstandingBalance, null);
    assert.equal(
      result.paymentSummary.source,
      HOTEL_PAYMENT_SUMMARY_SOURCES.PAYMENTS_NOT_IMPLEMENTED
    );

    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.STAY_CHECKED_OUT).length,
      1
    );
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.RESERVATION_CHECKED_OUT).length,
      1
    );
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_STATUS_CHANGED).length,
      2
    );
    assert.equal(reservation.status, "CHECKED_OUT");
  });

  test("duplicate check-out is idempotent and preserves the original checkout time", async () => {
    const { connection, checkedIn } = await checkedInFixture();
    const actor = toSafeHotelUser(connection.state.user);

    const first = await checkOutStay({
      connection,
      id: checkedIn.stay.id,
      actor,
      now: CHECK_OUT_NOW,
    });
    const auditCount = connection.state.audits.length;

    const second = await checkOutStay({
      connection,
      id: checkedIn.stay.id,
      actor,
      now: CHECK_OUT_NOW + 3_600_000,
    });

    assert.equal(second.changed, false);
    assert.equal(second.stay.id, first.stay.id);
    assert.equal(second.stay.checkedOutAt, first.stay.checkedOutAt);
    assert.equal(second.stay.totalCharges, first.stay.totalCharges);
    assert.equal(connection.state.audits.length, auditCount);
    assert.equal(connection.state.stays.length, 1);
  });

  test("a duplicate checkout after housekeeping does not re-clean the room", async () => {
    const { connection, room, checkedIn } = await checkedInFixture();
    await checkOutStay({
      connection,
      id: checkedIn.stay.id,
      now: CHECK_OUT_NOW,
    });

    room.operationalStatus = "AVAILABLE";
    room.statusHistory.push({
      status: "AVAILABLE",
      previousStatus: "CLEANING",
      changedAt: new Date(CHECK_OUT_NOW + 60_000),
      changedBy: connection.state.user._id,
      note: "Housekeeping completed",
    });
    const auditCount = connection.state.audits.length;

    const duplicate = await checkOutStay({
      connection,
      id: checkedIn.stay.id,
      now: CHECK_OUT_NOW + 120_000,
    });

    assert.equal(duplicate.changed, false);
    assert.equal(duplicate.roomStatus, "AVAILABLE");
    assert.equal(room.operationalStatus, "AVAILABLE");
    assert.equal(connection.state.audits.length, auditCount);
  });

  test("repairing a partial checkout audits only the missing steps", async () => {
    const { connection, room, reservation, checkedIn } =
      await checkedInFixture();
    const stay = connection.state.stays[0];
    stay.status = "CHECKED_OUT";
    stay.checkedOutAt = new Date(CHECK_OUT_NOW);
    stay.checkedOutBy = connection.state.user._id;
    stay.checkOutNote = "Recovered checkout";
    stay.billableNights = 2;
    stay.roomCharges = 240;
    stay.totalCharges = 240;
    stay.chargeRule = HOTEL_STAY_CHARGE_RULE;
    stay.statusHistory.push({
      status: "CHECKED_OUT",
      previousStatus: "IN_HOUSE",
      changedAt: new Date(CHECK_OUT_NOW),
      changedBy: connection.state.user._id,
      note: "Recovered checkout",
    });
    reservation.status = "CHECKED_IN";
    room.operationalStatus = "OCCUPIED";
    connection.state.audits.length = 0;

    const result = await checkOutStay({
      connection,
      id: checkedIn.stay.id,
      now: CHECK_OUT_NOW,
    });

    assert.equal(result.changed, true);
    assert.equal(result.stay.status, "CHECKED_OUT");
    assert.equal(result.reservation.status, "CHECKED_OUT");
    assert.equal(room.operationalStatus, "CLEANING");
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.STAY_CHECKED_OUT).length,
      0
    );
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.RESERVATION_CHECKED_OUT).length,
      1
    );
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.ROOM_STATUS_CHANGED).length,
      1
    );
  });

  test("rejects check-out when the reservation is not checked in", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);
    const reservation = seedReservation(connection, guest, roomType, {
      roomId: room._id,
      status: "CANCELLED",
    });
    const stay = seedStay(connection, reservation, room);

    const error = await checkOutStay({
      connection,
      id: String(stay._id),
      now: CHECK_OUT_NOW,
    }).catch((caught) => caught);
    assert.ok(error instanceof HotelApiError);
    assert.equal(error.status, 409);
    assert.equal(stay.status, "IN_HOUSE");
    assert.equal(room.operationalStatus, "AVAILABLE");
  });

  test("rejects an invalid stay status and a missing stay", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);
    const reservation = seedReservation(connection, guest, roomType, {
      roomId: room._id,
      status: "CHECKED_IN",
    });
    const invalidStay = seedStay(connection, reservation, room, {
      status: "CANCELLED",
    });

    const invalid = await checkOutStay({
      connection,
      id: String(invalidStay._id),
      now: CHECK_OUT_NOW,
    }).catch((error) => error);
    assert.ok(invalid instanceof HotelApiError);
    assert.equal(invalid.status, 409);
    assert.equal(invalidStay.status, "CANCELLED");

    const missing = await checkOutStay({
      connection,
      id: String(new mongoose.Types.ObjectId()),
      now: CHECK_OUT_NOW,
    }).catch((error) => error);
    assert.ok(missing instanceof HotelApiError);
    assert.equal(missing.status, 404);
  });

  test("never makes an out-of-service room available on checkout", async () => {
    const { connection, room, checkedIn } = await checkedInFixture();
    room.operationalStatus = "OUT_OF_SERVICE";

    const result = await checkOutStay({
      connection,
      id: checkedIn.stay.id,
      now: CHECK_OUT_NOW,
    });

    assert.equal(result.stay.status, "CHECKED_OUT");
    assert.equal(result.roomStatus, "OUT_OF_SERVICE");
    assert.equal(result.roomStatusChanged, false);
    assert.equal(room.operationalStatus, "OUT_OF_SERVICE");
    assert.notEqual(room.operationalStatus, "AVAILABLE");
  });

  test("preserves historical reservation pricing while charging actual stay nights", async () => {
    const { connection, reservation, checkedIn } = await checkedInFixture();
    const originalRate = reservation.nightlyRate;
    const originalTotal = reservation.totalAmount;

    const result = await checkOutStay({
      connection,
      id: checkedIn.stay.id,
      now: Date.UTC(2030, 0, 18, 1, 0, 0),
    });

    assert.equal(result.stay.billableNights, 3);
    assert.equal(result.stay.totalCharges, 360);
    assert.equal(result.reservation.nightlyRate, originalRate);
    assert.equal(result.reservation.totalAmount, originalTotal);
    assert.equal(reservation.nightlyRate, originalRate);
    assert.equal(reservation.totalAmount, originalTotal);
  });

  test("returns a real payment balance when Hotel payment records exist", async () => {
    const { connection, checkedIn } = await checkedInFixture({
      connection: { withPayments: true },
    });
    connection.state.payments.push(
      {
        _id: new mongoose.Types.ObjectId(),
        stayId: new mongoose.Types.ObjectId(checkedIn.stay.id),
        amount: 100,
        status: "PAID",
      },
      {
        _id: new mongoose.Types.ObjectId(),
        stayId: new mongoose.Types.ObjectId(checkedIn.stay.id),
        amount: 50,
        status: "PAID",
      },
      {
        _id: new mongoose.Types.ObjectId(),
        stayId: new mongoose.Types.ObjectId(checkedIn.stay.id),
        amount: 999,
        status: "VOIDED",
      }
    );

    const result = await checkOutStay({
      connection,
      id: checkedIn.stay.id,
      now: CHECK_OUT_NOW,
    });

    assert.equal(result.paymentSummary.available, true);
    assert.equal(result.paymentSummary.totalCharges, 240);
    assert.equal(result.paymentSummary.totalPaid, 150);
    assert.equal(result.paymentSummary.outstandingBalance, 90);
    assert.equal(result.paymentSummary.paymentCount, 2);
    assert.equal(result.paymentSummary.currency, HOTEL_PAYMENT_CURRENCY);
  });

  test("a held room lock blocks check-out without changing the stay", async () => {
    const { connection, room, checkedIn } = await checkedInFixture();

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
      roomIds: [String(room._id)],
      owner: "held-check-out",
      now: CHECK_OUT_NOW,
      fn: async () => {
        started();
        await gate;
      },
    });
    await startedPromise;

    const blocked = await checkOutStay({
      connection,
      id: checkedIn.stay.id,
      now: CHECK_OUT_NOW,
    }).catch((error) => error);
    assert.ok(blocked instanceof HotelApiError);
    assert.equal(blocked.status, 409);
    assert.equal(checkedIn.stay.status, "IN_HOUSE");
    assert.equal(room.operationalStatus, "OCCUPIED");

    release();
    await held;

    const allowed = await checkOutStay({
      connection,
      id: checkedIn.stay.id,
      now: CHECK_OUT_NOW,
    });
    assert.equal(allowed.changed, true);
    assert.equal(allowed.stay.status, "CHECKED_OUT");
  });

  test("audit failures never break check-out", async () => {
    const { connection, room, checkedIn } = await checkedInFixture();
    connection.state.audits.length = 0;
    connection.state.auditFails = true;

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const result = await checkOutStay({
        connection,
        id: checkedIn.stay.id,
        now: CHECK_OUT_NOW,
      });
      assert.equal(result.changed, true);
      assert.equal(result.stay.status, "CHECKED_OUT");
      assert.equal(connection.state.audits.length, 0);
      assert.equal(room.operationalStatus, "CLEANING");
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("Hotel stay query service", () => {
  test("lists stays with status, active, reference, and date filters", async () => {
    const { connection, guest, room, reservation, checkedIn } =
      await checkedInFixture();

    const all = await listStays({ connection });
    assert.equal(all.total, 1);
    assert.equal(all.items[0].id, checkedIn.stay.id);
    assert.equal(all.items[0].guestSnapshot.fullName, "Abebe Bekele");
    assert.equal(all.items[0].roomSnapshot.roomNumber, "101");

    const active = await listStays({ connection, activeOnly: true });
    assert.equal(active.total, 1);

    const byStatus = await listStays({ connection, status: "IN_HOUSE" });
    assert.equal(byStatus.total, 1);

    const byReservation = await listStays({
      connection,
      reservationId: String(reservation._id),
    });
    assert.equal(byReservation.total, 1);

    const byGuest = await listStays({
      connection,
      guestId: String(guest._id),
    });
    assert.equal(byGuest.total, 1);

    const byRoom = await listStays({ connection, roomId: String(room._id) });
    assert.equal(byRoom.total, 1);

    const inWindow = await listStays({
      connection,
      checkedInFrom: parseHotelLocalDate("2030-01-15"),
      checkedInTo: parseHotelLocalDate("2030-01-15"),
    });
    assert.equal(inWindow.total, 1);

    const outsideWindow = await listStays({
      connection,
      checkedInFrom: parseHotelLocalDate("2030-01-16"),
      checkedInTo: parseHotelLocalDate("2030-01-17"),
    });
    assert.equal(outsideWindow.total, 0);

    const invalidStatus = await listStays({
      connection,
      status: "DIRTY",
    }).catch((error) => error);
    assert.ok(invalidStatus instanceof HotelValidationError);
    assert.ok(invalidStatus.fieldErrors.status);

    const invalidWindow = await listStays({
      connection,
      checkedInFrom: parseHotelLocalDate("2030-01-17"),
      checkedInTo: parseHotelLocalDate("2030-01-15"),
    }).catch((error) => error);
    assert.ok(invalidWindow instanceof HotelValidationError);
    assert.ok(invalidWindow.fieldErrors.checkedInTo);
  });

  test("returns stay detail plus reservation and guest history", async () => {
    const { connection, guest, reservation, checkedIn } =
      await checkedInFixture();

    const detail = await getStay({ connection, id: checkedIn.stay.id });
    assert.equal(detail.stay.id, checkedIn.stay.id);
    assert.equal(detail.stay.reservationNumber, reservation.reservationNumber);
    assert.equal(detail.stay.guestId, String(guest._id));
    assert.equal(detail.stay.paymentSummary, null);

    const reservationHistory = await listReservationStays({
      connection,
      reservationId: String(reservation._id),
    });
    assert.equal(reservationHistory.reservationId, String(reservation._id));
    assert.equal(reservationHistory.total, 1);

    const guestHistory = await listGuestStays({
      connection,
      guestId: String(guest._id),
    });
    assert.equal(guestHistory.guest.id, String(guest._id));
    assert.equal(guestHistory.total, 1);

    const missing = await getStay({
      connection,
      id: String(new mongoose.Types.ObjectId()),
    }).catch((error) => error);
    assert.ok(missing instanceof HotelApiError);
    assert.equal(missing.status, 404);
  });
});

describe("Hotel stay HTTP routes", () => {
  test("requires authentication and enforces CSRF and exact origin", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);
    const reservation = seedReservation(connection, guest, roomType, {
      roomId: room._id,
    });

    const badOrigin = await runHandler(
      handleCheckInReservation,
      buildRequest({
        method: "POST",
        path: `/api/hotel/reservations/${reservation._id}/check-in`,
        origin: "https://evil.example",
      }),
      paramsFor(reservation._id),
      { connect: connection, now: CHECK_IN_NOW }
    );
    assert.equal(badOrigin.status, 403);
    assert.equal(
      (await badOrigin.json()).error.code,
      HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED
    );
    assert.equal(connection.state.stays.length, 0);
  });

  test("runs the complete check-in, history, and check-out workflow", async () => {
    const connection = createFakeConnection();
    const roomType = seedRoomType(connection);
    const guest = seedGuest(connection);
    const room = seedRoom(connection, roomType);
    const reservation = seedReservation(connection, guest, roomType, {
      roomId: room._id,
    });

    const checkedIn = await runHandler(
      handleCheckInReservation,
      buildRequest({
        method: "POST",
        path: `/api/hotel/reservations/${reservation._id}/check-in`,
        body: { note: "HTTP check-in" },
      }),
      paramsFor(reservation._id),
      { connect: connection, now: CHECK_IN_NOW }
    );
    assert.equal(checkedIn.status, 201);
    const checkedInBody = await checkedIn.json();
    const stayId = checkedInBody.data.stay.id;
    assert.equal(checkedInBody.data.changed, true);
    assert.equal(checkedInBody.data.stay.status, "IN_HOUSE");
    assert.equal(checkedInBody.data.reservation.status, "CHECKED_IN");

    const duplicate = await runHandler(
      handleCheckInReservation,
      buildRequest({
        method: "POST",
        path: `/api/hotel/reservations/${reservation._id}/check-in`,
      }),
      paramsFor(reservation._id),
      { connect: connection, now: CHECK_IN_NOW }
    );
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).data.changed, false);

    const list = await runHandler(
      handleListStays,
      buildRequest({
        path: "/api/hotel/stays?activeOnly=true",
      }),
      {},
      { connect: connection }
    );
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.data.total, 1);
    assert.equal(listBody.data.items[0].id, stayId);

    const detail = await runHandler(
      handleGetStay,
      buildRequest({ path: `/api/hotel/stays/${stayId}` }),
      paramsFor(stayId),
      { connect: connection }
    );
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.stay.id, stayId);

    const reservationHistory = await runHandler(
      handleListReservationStays,
      buildRequest({
        path: `/api/hotel/reservations/${reservation._id}/stays`,
      }),
      paramsFor(reservation._id),
      { connect: connection }
    );
    assert.equal(reservationHistory.status, 200);
    assert.equal((await reservationHistory.json()).data.total, 1);

    const guestHistory = await runHandler(
      handleListGuestStays,
      buildRequest({
        path: `/api/hotel/guests/${guest._id}/stays`,
      }),
      paramsFor(guest._id),
      { connect: connection }
    );
    assert.equal(guestHistory.status, 200);
    assert.equal((await guestHistory.json()).data.total, 1);

    const checkedOut = await runHandler(
      handleCheckOutStay,
      buildRequest({
        method: "POST",
        path: `/api/hotel/stays/${stayId}/check-out`,
        body: { note: "HTTP check-out" },
      }),
      paramsFor(stayId),
      { connect: connection, now: CHECK_OUT_NOW }
    );
    assert.equal(checkedOut.status, 200);
    const checkedOutBody = await checkedOut.json();
    assert.equal(checkedOutBody.data.changed, true);
    assert.equal(checkedOutBody.data.stay.status, "CHECKED_OUT");
    assert.equal(checkedOutBody.data.stay.billableNights, 2);
    assert.equal(checkedOutBody.data.stay.totalCharges, 240);
    assert.equal(checkedOutBody.data.reservation.status, "CHECKED_OUT");
    assert.equal(checkedOutBody.data.roomStatus, "CLEANING");
    assert.equal(checkedOutBody.data.paymentSummary.available, false);
    assert.equal(room.operationalStatus, "CLEANING");

    const duplicateCheckout = await runHandler(
      handleCheckOutStay,
      buildRequest({
        method: "POST",
        path: `/api/hotel/stays/${stayId}/check-out`,
      }),
      paramsFor(stayId),
      { connect: connection, now: CHECK_OUT_NOW + 60_000 }
    );
    assert.equal(duplicateCheckout.status, 200);
    assert.equal((await duplicateCheckout.json()).data.changed, false);

    const actions = connection.state.audits.map((entry) => entry.action);
    for (const action of [
      HOTEL_AUDIT_ACTIONS.STAY_CHECKED_IN,
      HOTEL_AUDIT_ACTIONS.RESERVATION_CHECKED_IN,
      HOTEL_AUDIT_ACTIONS.STAY_CHECKED_OUT,
      HOTEL_AUDIT_ACTIONS.RESERVATION_CHECKED_OUT,
      HOTEL_AUDIT_ACTIONS.ROOM_STATUS_CHANGED,
    ]) {
      assert.ok(actions.includes(action), `${action} should be audited`);
    }
  });

  test("invalid stay queries and ids fail before a model write", async () => {
    const connection = createFakeConnection();

    const badStatus = await runHandler(
      handleListStays,
      buildRequest({ path: "/api/hotel/stays?status=UNKNOWN" }),
      {},
      { connect: connection }
    );
    assert.equal(badStatus.status, 422);
    assert.ok((await badStatus.json()).error.details.fieldErrors.status);

    const badDate = await runHandler(
      handleListStays,
      buildRequest({
        path: "/api/hotel/stays?checkedInFrom=not-a-date",
      }),
      {},
      { connect: connection }
    );
    assert.equal(badDate.status, 422);
    assert.ok((await badDate.json()).error.details.fieldErrors.checkedInFrom);

    const badId = await runHandler(
      handleGetStay,
      buildRequest({ path: "/api/hotel/stays/not-an-id" }),
      paramsFor("not-an-id"),
      { connect: connection }
    );
    assert.equal(badId.status, 422);
    assert.ok((await badId.json()).error.details.fieldErrors.id);

    const noBodyCheckIn = await runHandler(
      handleCheckInReservation,
      buildRequest({
        method: "POST",
        path: "/api/hotel/reservations/not-an-id/check-in",
      }),
      paramsFor("not-an-id"),
      { connect: connection, now: CHECK_IN_NOW }
    );
    assert.equal(noBodyCheckIn.status, 422);
  });

  test("route files are protected, node-runtime, and expose no hard delete", () => {
    const routeFiles = [
      "app/api/hotel/reservations/[id]/check-in/route.js",
      "app/api/hotel/reservations/[id]/stays/route.js",
      "app/api/hotel/stays/route.js",
      "app/api/hotel/stays/[id]/route.js",
      "app/api/hotel/stays/[id]/check-out/route.js",
      "app/api/hotel/stays/[id]/payments/route.js",
      "app/api/hotel/stays/[id]/folio/route.js",
      "app/api/hotel/payments/[id]/route.js",
      "app/api/hotel/payments/[id]/void/route.js",
      "app/api/hotel/guests/[id]/stays/route.js",
    ];

    for (const file of routeFiles) {
      const source = src(file);
      assert.match(source, /export const runtime = "nodejs"/, file);
      assert.match(source, /export const dynamic = "force-dynamic"/, file);
      assert.match(source, /withHotelApi/, file);
      assert.ok(!/export\s+const\s+DELETE/.test(source), `${file} must not delete`);
    }

    for (const file of [
      "lib/hotel/services/stays.js",
      "lib/hotel/services/stayPayments.js",
      "lib/hotel/services/folio.js",
      "lib/hotel/services/payments.js",
      "lib/hotel/models/stay.js",
      "lib/hotel/models/hotelPayment.js",
    ]) {
      const source = src(file);
      assert.ok(
        !/deleteOne|deleteMany|findByIdAndDelete|findOneAndDelete/.test(source),
        `${file} must not hard-delete business records`
      );
    }

    const handlers = src("lib/hotel/http/stayHandlers.js");
    assert.match(
      handlers,
      /handleCheckInReservation[\s\S]*RESERVATIONS_MANAGE/
    );
    assert.match(handlers, /handleCheckOutStay[\s\S]*BILLING_MANAGE/);
    assert.match(handlers, /handleListStays[\s\S]*RESERVATIONS_READ/);
  });
});
