// Hotel backend report tests — DB-free.
//
// No MongoDB connection is opened and no index is created. The aggregation
// service and the two report handlers run against an in-memory stub connection
// (the established house pattern from tests/hotel-stays.test.mjs) so window
// validation, occupancy intersections, null-denominator coverage rules,
// money exactness, void exclusion, outstanding balances, handler permissions,
// and CSV escaping are exercised deterministically.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";

import {
  HOTEL_REPORT_MAX_WINDOW_DAYS,
  HOTEL_SESSION_COOKIE,
  HOTEL_CSRF_HEADER,
  HOTEL_STAY_CHARGE_RULE,
} from "../lib/hotel/constants.js";
import { HOTEL_ROOM_OPERATIONAL_STATUSES } from "../lib/hotel/constants.js";
import { HotelValidationError } from "../lib/hotel/errors.js";
import {
  HOTEL_REPORT_DEFINITIONS,
  buildHotelReportsSummary,
} from "../lib/hotel/services/reports.js";
import {
  escapeHotelCsvCell,
  renderHotelReportsSummaryCsv,
  HOTEL_REPORT_CSV_DAILY_HEADERS,
  HOTEL_REPORT_CSV_SUMMARY_HEADERS,
} from "../lib/hotel/services/reportsCsv.js";
import { withHotelApi } from "../lib/hotel/http/apiResponse.js";
import {
  handleHotelReportsSummary,
  handleHotelReportsSummaryExport,
  handleHotelReportsSummaryExportPdf,
} from "../lib/hotel/http/reportHandlers.js";
import {
  HOTEL_REPORT_PDF_PAGE,
  renderHotelReportsSummaryPdf,
} from "../lib/hotel/services/reportsPdf.js";
import { createHotelSession } from "../lib/hotel/auth/session.js";
import {
  addHotelLocalDays,
  formatHotelLocalDate,
} from "../lib/hotel/dates.js";

const TEST_HOTEL_SECRET = "hotel-report-test-secret-independent-123456789";
const TEST_MONGO_URI = "mongodb://127.0.0.1:27017/bono_hotel";
const TEST_ORIGIN = "https://hotel.example";

// 2030-06-05T09:00:00Z == Addis 2030-06-05 12:00. `today` for report windows
// is therefore 2030-06-05 when `now` is fixed to this instant.
const REPORT_NOW = Date.UTC(2030, 5, 5, 9, 0, 0);

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

// ————————————————————————————————————————————————————————————— stub helpers

function cloneRow(row) {
  if (!row) return null;
  const copy = { ...row };
  for (const field of ["statusHistory"]) {
    if (Array.isArray(row[field])) {
      copy[field] = row[field].map((entry) => ({ ...entry }));
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
    if (
      expected &&
      typeof expected === "object" &&
      !Array.isArray(expected) &&
      !(expected instanceof Date)
    ) {
      const operators = Object.keys(expected).filter((key) =>
        key.startsWith("$")
      );
      if (operators.length > 0) {
        return operators.every((operator) => {
          switch (operator) {
            case "$in": {
              const allowed = new Set(expected.$in.map((value) => String(value)));
              return allowed.has(String(actual));
            }
            case "$lt":
              return comparable(actual) < comparable(expected.$lt);
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
    sort() {
      return query;
    },
    skip() {
      return query;
    },
    limit() {
      return query;
    },
    select() {
      return query;
    },
    lean: async () => rows.map(cloneRow),
  };
  return query;
}

function makeCollectionModel(state, key) {
  const rows = state[key];
  return {
    find: (filter) => makeFindQuery(rows.filter((row) => matchesFilter(row, filter))),
    countDocuments: async (filter) =>
      rows.filter((row) => matchesFilter(row, filter)).length,
  };
}

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

function createFakeConnection(role = "MANAGER") {
  const state = {
    user: makeUser({ role }),
    sessions: [],
    guests: [],
    roomTypes: [],
    rooms: [],
    reservations: [],
    stays: [],
    payments: [],
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
            const row = state.sessions.find((entry) => matchesFilter(entry, filter));
            return cloneRow(row);
          },
        }),
      }),
      updateOne: async () => ({ modifiedCount: 1 }),
    },
    RoomType: makeCollectionModel(state, "roomTypes"),
    Room: makeCollectionModel(state, "rooms"),
    Reservation: makeCollectionModel(state, "reservations"),
    Stay: makeCollectionModel(state, "stays"),
    HotelPayment: makeCollectionModel(state, "payments"),
  };

  return { state, models };
}

// —————————————————————————————————————————————————————————————— seed helpers

// Addis-local midnight UTC instant for a Gregorian YMD value.
const addisMidnight = (ymd) => new Date(`${ymd}T00:00:00.000+03:00`);

// Addis-local wall clock instant on a Gregorian YMD with a timeOfDay input.
const addisInstant = (ymd, timeOfDay) => new Date(`${ymd}T${timeOfDay}:00.000+03:00`);

function seedRoomType(connection, overrides = {}) {
  const roomType = {
    _id: new mongoose.Types.ObjectId(),
    name: "Deluxe",
    code: "DLX",
    description: "",
    capacity: 2,
    baseNightlyRate: 120,
    amenities: ["Wi-Fi"],
    isActive: true,
    createdAt: addisMidnight("2030-01-01"),
    updatedAt: addisMidnight("2030-01-01"),
    ...overrides,
  };
  connection.state.roomTypes.push(roomType);
  return roomType;
}

function seedRoom(
  connection,
  { roomNumber = "101", history, createdAt, isActive = true } = {}
) {
  const status = history?.[0]?.status ?? "AVAILABLE";
  const room = {
    _id: new mongoose.Types.ObjectId(),
    roomNumber,
    floor: 1,
    roomTypeId: null,
    capacity: 2,
    amenities: ["Wi-Fi"],
    nightlyRateOverride: null,
    isActive,
    operationalStatus: status,
    statusHistory: history ?? [],
    createdAt,
    updatedAt: createdAt,
  };
  connection.state.rooms.push(room);
  return room;
}

function seedReservation(connection, overrides = {}) {
  const reservation = {
    _id: new mongoose.Types.ObjectId(),
    reservationNumber: "RSV-2030-0001",
    status: "CONFIRMED",
    arrivalDate: addisMidnight("2030-06-02"),
    departureDate: addisMidnight("2030-06-05"),
    nights: 3,
    nightlyRate: 100,
    totalAmount: 300,
    guestId: new mongoose.Types.ObjectId(),
    guestSnapshot: { firstName: "Abebe", lastName: "Bekele" },
    roomId: null,
    roomTypeId: null,
    stayId: null,
    createdAt: addisMidnight("2030-05-01"),
    updatedAt: addisMidnight("2030-05-01"),
    ...overrides,
  };
  connection.state.reservations.push(reservation);
  return reservation;
}

function seedStay(connection, overrides = {}) {
  const stay = {
    _id: new mongoose.Types.ObjectId(),
    reservationId: new mongoose.Types.ObjectId(),
    reservationNumber: "RSV-2030-0001",
    guestId: new mongoose.Types.ObjectId(),
    guestSnapshot: { firstName: "Abebe", lastName: "Bekele" },
    roomTypeId: null,
    roomTypeSnapshot: { name: "Deluxe", capacity: 2 },
    roomId: null,
    roomSnapshot: { roomNumber: "101", floor: 1 },
    status: "IN_HOUSE",
    arrivalDate: addisMidnight("2030-05-27"),
    departureDate: addisMidnight("2030-06-01"),
    checkedInAt: addisInstant("2030-05-27", "14:00"),
    checkedOutAt: null,
    checkInNote: "",
    checkInBy: null,
    checkOutNote: null,
    checkOutBy: null,
    billableNights: null,
    nightlyRateSnapshot: 100,
    roomCharges: null,
    totalCharges: null,
    chargeRule: null,
    createdAt: addisInstant("2030-05-27", "14:00"),
    updatedAt: addisInstant("2030-05-27", "14:00"),
    ...overrides,
  };
  connection.state.stays.push(stay);
  return stay;
}

function seedPayment(connection, overrides = {}) {
  const payment = {
    _id: new mongoose.Types.ObjectId(),
    stayId: null,
    reservationId: null,
    guestId: null,
    paymentNumber: "PAY-2030-0001",
    amount: 100,
    amountMinor: 10000,
    currency: "ETB",
    method: "CASH",
    status: "RECORDED",
    recordedAt: addisInstant("2030-06-01", "12:00"),
    recordedBy: null,
    note: "",
    idempotencyKey: `idem-${connection.state.payments.length + 1}`,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    createdAt: addisInstant("2030-06-01", "12:00"),
    updatedAt: addisInstant("2030-06-01", "12:00"),
    ...overrides,
  };
  connection.state.payments.push(payment);
  return payment;
}

// ———————————————————————————————————————————————————————— window validation

describe("Report window validation", () => {
  test("rejects a reversed window", async () => {
    const connection = createFakeConnection();
    await assert.rejects(
      () =>
        buildHotelReportsSummary({
          connection,
          from: "2030-06-04",
          to: "2030-06-01",
          now: REPORT_NOW,
        }),
      (error) =>
        error instanceof HotelValidationError &&
        error.fieldErrors.to !== undefined &&
        error.fieldErrors.from === undefined
    );
  });

  test("rejects window of 93 days and accepts exactly 92 days", async () => {
    const connection = createFakeConnection();
    const from = "2030-03-01";
    const to93 = formatHotelLocalDate(addHotelLocalDays(addisMidnight(from), 92));
    await assert.rejects(
      () =>
        buildHotelReportsSummary({ connection, from, to: to93, now: REPORT_NOW }),
      (error) =>
        error instanceof HotelValidationError &&
        error.fieldErrors.to.includes(String(HOTEL_REPORT_MAX_WINDOW_DAYS))
    );
    const to92 = formatHotelLocalDate(addHotelLocalDays(addisMidnight(from), 91));
    const result = await buildHotelReportsSummary({
      connection,
      from,
      to: to92,
      now: REPORT_NOW,
    });
    assert.equal(result.days.length, 92);
  });

  test("rejects malformed dates and future end dates", async () => {
    const connection = createFakeConnection();
    await assert.rejects(
      () =>
        buildHotelReportsSummary({
          connection,
          from: "2030-2-1",
          to: "2030-06-01",
          now: REPORT_NOW,
        }),
      (error) => error.fieldErrors.from !== undefined
    );
    await assert.rejects(
      () =>
        buildHotelReportsSummary({
          connection,
          from: "2030-02-30",
          to: "2030-06-01",
          now: REPORT_NOW,
        }),
      (error) => error.fieldErrors.from !== undefined
    );
    await assert.rejects(
      () =>
        buildHotelReportsSummary({
          connection,
          from: "2030-06-01",
          to: "2030-06-06",
          now: REPORT_NOW,
        }),
      (error) => error.fieldErrors.to !== undefined
    );
  });
});

// —————————————————————————————————————————————————— occupancy and coverage

const RICH_WINDOW = { from: "2030-05-29", to: "2030-06-04" };

function makeRichConnection() {
  const connection = createFakeConnection();
  const roomType = seedRoomType(connection);

  // Room A: covered for the entire window.
  const roomA = seedRoom(connection, {
    roomNumber: "101",
    history: [
      {
        status: "AVAILABLE",
        previousStatus: null,
        changedAt: addisMidnight("2030-01-01"),
      },
    ],
    createdAt: addisMidnight("2030-01-01"),
  });

  // Room B: coverage starts at the 06-02 midnight entry; it existed from
  // 05-15, so earlier days in the window are unknown (denominator null).
  seedRoom(connection, {
    roomNumber: "102",
    history: [
      {
        status: "AVAILABLE",
        previousStatus: null,
        changedAt: addisMidnight("2030-06-02"),
      },
    ],
    createdAt: addisMidnight("2030-05-15"),
  });

  // Room C: created mid-day on 06-03 with its seed entry at the same instant.
  // Its creation day is simply not eligible; it does not make the day unknown.
  seedRoom(connection, {
    roomNumber: "103",
    history: [
      {
        status: "AVAILABLE",
        previousStatus: null,
        changedAt: addisInstant("2030-06-03", "15:00"),
      },
    ],
    createdAt: addisInstant("2030-06-03", "15:00"),
  });

  // Stay S1 spans the window start on room A and checks out on 06-01.
  const stayS1 = seedStay(connection, {
    roomId: roomA._id,
    roomSnapshot: { roomNumber: "101", floor: 1 },
    status: "CHECKED_OUT",
    billableNights: 4,
    roomCharges: 480,
    totalCharges: "480.00",
    chargeRule: HOTEL_STAY_CHARGE_RULE,
    checkedOutAt: addisInstant("2030-06-01", "10:00"),
  });

  // Stay S2 re-uses room A the same day (in-house through window end).
  seedStay(connection, {
    roomId: roomA._id,
    roomTypeId: roomType._id,
    roomSnapshot: { roomNumber: "101", floor: 1 },
    status: "IN_HOUSE",
    checkedInAt: addisInstant("2030-06-01", "15:00"),
    departureDate: addisMidnight("2030-06-05"),
  });

  seedReservation(connection, {
    status: "CONFIRMED",
    arrivalDate: addisMidnight("2030-06-02"),
  });
  seedReservation(connection, {
    reservationNumber: "RSV-2030-0002",
    status: "NO_SHOW",
    arrivalDate: addisMidnight("2030-06-03"),
  });
  seedReservation(connection, {
    reservationNumber: "RSV-2030-0003",
    status: "CANCELLED",
    arrivalDate: addisMidnight("2030-06-04"),
  });

  seedPayment(connection, {
    stayId: stayS1._id,
    method: "CASH",
    amount: 5000,
    amountMinor: 500000,
    recordedAt: addisInstant("2030-06-02", "15:00"),
  });
  seedPayment(connection, {
    method: "CARD",
    amount: 2500,
    amountMinor: 250000,
    recordedAt: addisInstant("2030-05-29", "11:00"),
  });
  seedPayment(connection, {
    method: "CARD",
    amount: 200,
    amountMinor: 20000,
    recordedAt: addisInstant("2030-06-01", "12:00"),
    stayId: stayS1._id,
  });
  const voided = seedPayment(connection, {
    paymentNumber: "PAY-2030-0004",
    method: "CASH",
    amount: 1000,
    amountMinor: 100000,
    recordedAt: addisInstant("2030-05-30", "12:00"),
    status: "VOIDED",
    voidedAt: addisInstant("2030-06-03", "09:00"),
    voidReason: "duplicate entry",
  });
  connection.state.payments[3] = { ...voided, status: "VOIDED" };

  return { connection, roomA, stayS1 };
}

async function richSummary(connection) {
  return buildHotelReportsSummary({
    connection,
    from: RICH_WINDOW.from,
    to: RICH_WINDOW.to,
    now: REPORT_NOW,
  });
}

describe("Occupancy, denominator coverage, and activity", () => {
  let result = null;

  before(async () => {
    const { connection } = makeRichConnection();
    result = await richSummary(connection);
  });

  test("builds one day row per civil date with no scaffolding leak", () => {
    assert.equal(result.range.from, "2030-05-29");
    assert.equal(result.range.to, "2030-06-04");
    assert.equal(result.range.dayCount, 7);
    assert.equal(result.days.length, 7);
    assert.equal(result.days[0].date, "2030-05-29");
    assert.equal(result.days[6].date, "2030-06-04");
    for (const day of result.days) {
      assert.equal(day.startMs, undefined);
      assert.equal(day.endMs, undefined);
      assert.equal(day.occupiedRoomIds, undefined);
    }
  });

  test("deduplicates a room occupied by two stays on one day", () => {
    // S1 checks out 06-01 10:00; S2 checks in 06-01 15:00 on the same room:
    // both intersect 06-01, so the room counts once for that day.
    assert.deepEqual(
      result.days.map((day) => day.occupiedRoomNights),
      [1, 1, 1, 1, 1, 1, 1]
    );
    assert.equal(result.totals.occupiedRoomNights, 7);
  });

  test("applies the null-coverage denominator policy", () => {
    // Days 29..01: room B is uncovered though it existed -> day unknown.
    assert.deepEqual(result.days.slice(0, 4).map((day) => day.availableRoomNights), [
      null,
      null,
      null,
      null,
    ]);
    // 06-02 and 06-03: rooms A + B covered (room C not yet eligible).
    assert.deepEqual(result.days[4].availableRoomNights, 2);
    assert.deepEqual(result.days[5].availableRoomNights, 2);
    // 06-04: rooms A + B + C covered.
    assert.deepEqual(result.days[6].availableRoomNights, 3);
    assert.equal(result.totals.availableRoomNights, null);
    assert.deepEqual(result.denominatorCoverage, {
      fullyCovered: false,
      uncoveredDates: [
        "2030-05-29",
        "2030-05-30",
        "2030-05-31",
        "2030-06-01",
      ],
    });
  });

  test("occupancy rate is null for unknown or zero denominators, else exact", () => {
    assert.deepEqual(
      result.days.map((day) => day.occupancyRatePct),
      [null, null, null, null, 50, 50, 33.3]
    );
    assert.equal(result.totals.occupancyRatePct, null);
  });

  test("reports cancelled reservations as no metric at all", () => {
    assert.deepEqual(
      result.days.map(
        (day) => day.scheduledArrivals + day.noShowArrivals + day.checkIns +
          day.departuresDue + day.checkOuts
      ).reduce((sum, value) => sum + value, 0),
      // 06-01: 1 no-show? none; 1 check-in (S2), 1 departure due (S1), 1 checkout (S1);
      // 06-02: 1 scheduled arrival; 06-03: 1 no-show.
      5
    );
    assert.equal(result.totals.scheduledArrivals, 1);
    assert.equal(result.totals.noShowArrivals, 1);
  });

  test("separates dues from actual events", () => {
    assert.equal(result.totals.checkIns, 1);
    assert.equal(result.totals.checkOuts, 1);
    assert.equal(result.totals.departuresDue, 1);
    assert.equal(result.days[3].checkOuts, 1);
    assert.equal(result.days[3].departuresDue, 1);
    assert.equal(result.days[3].checkIns, 1);
  });

  test("charges, payments, and voids land on their own dates", () => {
    // Charges by checkout date.
    assert.equal(result.days[3].postedRoomChargesMinor, 48000);
    assert.equal(result.totals.postedRoomChargesMinor, 48000);
    // Recorded payments by recorded date.
    assert.equal(result.days[0].paymentsRecordedMinor, 250000);
    assert.equal(result.days[3].paymentsRecordedMinor, 20000);
    assert.equal(result.days[4].paymentsRecordedMinor, 500000);
    assert.equal(result.totals.paymentsRecordedMinor, 770000);
    assert.equal(result.totals.paymentsRecordedCount, 3);
    // Voided payments by void date, never netted into the collected total.
    assert.equal(result.days[5].paymentsVoidedMinor, 100000);
    assert.equal(result.totals.paymentsVoidedMinor, 100000);
    assert.equal(result.totals.paymentsVoidedCount, 1);
    assert.deepEqual(result.methodBreakdown, { CASH: 500000, CARD: 270000 });
  });

  test("ADR is null-safe; RevPAR needs full denominator coverage", () => {
    assert.equal(result.totals.adrMinor, Math.round(48000 / 7));
    assert.equal(result.totals.revparMinor, null);
  });

  test("outstanding balance nets final charges minus all-time collected", () => {
    // S1 charges 48000; payments attached to it (500000 + 20000) exceed the
    // charges. A negative outstanding is refused and reported as 0.
    assert.equal(result.totals.outstandingMinor, 0);
  });

  test("inventory is a live snapshot over all operational statuses", () => {
    assert.equal(result.inventory.roomsTotal, 3);
    assert.equal(result.inventory.roomsActive, 3);
    assert.equal(result.inventory.roomsInactive, 0);
    assert.equal(result.inventory.roomTypesTotal, 1);
    assert.equal(result.inventory.roomTypesActive, 1);
    assert.deepEqual(
      Object.keys(result.inventory.roomsByOperationalStatus).sort(),
      [...HOTEL_ROOM_OPERATIONAL_STATUSES].sort()
    );
    assert.equal(result.inventory.roomsByOperationalStatus.AVAILABLE, 3);
  });

  test("returns stable definitions and labels", () => {
    assert.equal(result.definitions, HOTEL_REPORT_DEFINITIONS);
    assert.deepEqual(result.labels, {
      payments: "recorded date",
      voids: "void date",
      charges: "checkout date",
    });
  });
});

describe("Charges, ADR, and RevPAR on a fully covered window", () => {
  test("finalized charges convert exactly and ADR/RevPAR use their denominators", async () => {
    const connection = createFakeConnection();
    const roomA = seedRoom(connection, {
      roomNumber: "201",
      history: [
        {
          status: "AVAILABLE",
          previousStatus: null,
          changedAt: addisMidnight("2030-01-01"),
        },
        {
          status: "OUT_OF_SERVICE",
          previousStatus: "AVAILABLE",
          changedAt: addisInstant("2030-06-02", "10:00"),
        },
        {
          status: "AVAILABLE",
          previousStatus: "OUT_OF_SERVICE",
          changedAt: addisInstant("2030-06-02", "18:00"),
        },
      ],
      createdAt: addisMidnight("2030-01-01"),
    });
    seedRoomType(connection);

    seedStay(connection, {
      roomId: roomA._id,
      roomSnapshot: { roomNumber: "201", floor: 2 },
      status: "CHECKED_OUT",
      checkedInAt: addisInstant("2030-05-31", "20:00"),
      checkedOutAt: addisInstant("2030-06-01", "10:00"),
      departureDate: addisMidnight("2030-06-01"),
      billableNights: 1,
      roomCharges: 120,
      totalCharges: "120.00",
      chargeRule: HOTEL_STAY_CHARGE_RULE,
    });

    const result = await buildHotelReportsSummary({
      connection,
      from: "2030-06-01",
      to: "2030-06-03",
      now: REPORT_NOW,
    });

    // 06-01: available; 06-02: OUT_OF_SERVICE entry inside the day -> 0;
    // 06-03: the 18:00 entry restores availability at day start.
    assert.deepEqual(result.days.map((day) => day.availableRoomNights), [1, 0, 1]);
    assert.equal(result.totals.availableRoomNights, 2);
    assert.equal(result.days[1].occupancyRatePct, null);
    // Occupied room-nights: the stay intersects only 06-01.
    assert.deepEqual(result.days.map((day) => day.occupiedRoomNights), [1, 0, 0]);
    assert.equal(result.totals.occupiedRoomNights, 1);
    assert.equal(result.days[1].occupancyRatePct, null);
    assert.equal(result.days[0].occupancyRatePct, 100);
    // Money exactness: 120.00 ETB == 12000 santim, once.
    assert.equal(result.totals.postedRoomChargesMinor, 12000);
    assert.equal(result.totals.adrMinor, 12000);
    assert.equal(result.totals.revparMinor, 6000);
    // No checked-out stays are unfinalized here.
    assert.equal(result.totals.outstandingMinor, 12000);
  });
});

describe("Null-coverage and zero-denominator reporting", () => {
  test("a day without denominator history is null, never zero", async () => {
    const connection = createFakeConnection();
    seedRoom(connection, {
      roomNumber: "301",
      history: [],
      createdAt: addisMidnight("2030-01-01"),
    });

    const result = await buildHotelReportsSummary({
      connection,
      from: "2030-06-01",
      to: "2030-06-01",
      now: REPORT_NOW,
    });

    assert.equal(result.days[0].availableRoomNights, null);
    assert.equal(result.days[0].occupancyRatePct, null);
    assert.equal(result.totals.availableRoomNights, null);
    assert.equal(result.totals.occupancyRatePct, null);
    assert.equal(result.totals.revparMinor, null);
    // No stays checked out -> no outstanding to report as unknown.
    assert.equal(result.totals.outstandingMinor, 0);
    assert.deepEqual(result.denominatorCoverage, {
      fullyCovered: false,
      uncoveredDates: ["2030-06-01"],
    });
  });

  test("an unfinalized in-window checkout forces outstanding to null", async () => {
    const connection = createFakeConnection();
    const roomA = seedRoom(connection, {
      roomNumber: "401",
      history: [
        {
          status: "AVAILABLE",
          previousStatus: null,
          changedAt: addisMidnight("2030-01-01"),
        },
      ],
      createdAt: addisMidnight("2030-01-01"),
    });
    seedStay(connection, {
      roomId: roomA._id,
      status: "CHECKED_OUT",
      checkedInAt: addisInstant("2030-06-01", "10:00"),
      checkedOutAt: addisInstant("2030-06-01", "18:00"),
      billableNights: null,
      roomCharges: null,
      totalCharges: null,
      chargeRule: null,
    });

    const result = await buildHotelReportsSummary({
      connection,
      from: "2030-06-01",
      to: "2030-06-01",
      now: REPORT_NOW,
    });

    assert.equal(result.totals.postedRoomChargesMinor, 0);
    assert.equal(result.totals.outstandingMinor, null);
  });

  test("over-collection refuses a negative outstanding", async () => {
    const connection = createFakeConnection();
    const roomA = seedRoom(connection, {
      roomNumber: "501",
      history: [
        {
          status: "AVAILABLE",
          previousStatus: null,
          changedAt: addisMidnight("2030-01-01"),
        },
      ],
      createdAt: addisMidnight("2030-01-01"),
    });
    const stay = seedStay(connection, {
      roomId: roomA._id,
      status: "CHECKED_OUT",
      checkedInAt: addisInstant("2030-06-01", "10:00"),
      checkedOutAt: addisInstant("2030-06-01", "18:00"),
      billableNights: 1,
      roomCharges: 50,
      totalCharges: "50.00",
      chargeRule: HOTEL_STAY_CHARGE_RULE,
    });
    seedPayment(connection, {
      stayId: stay._id,
      amountMinor: 6000,
      recordedAt: addisInstant("2030-06-01", "19:00"),
    });

    const result = await buildHotelReportsSummary({
      connection,
      from: "2030-06-01",
      to: "2030-06-01",
      now: REPORT_NOW,
    });

    assert.equal(result.totals.postedRoomChargesMinor, 5000);
    assert.equal(result.totals.outstandingMinor, 0);
  });
});

// ————————————————————————————————————————————————————————— handler contracts

function buildRequest(path, { token = null, extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.cookie = `${HOTEL_SESSION_COOKIE}=${token}`;
  return new Request(`${TEST_ORIGIN}${path}`, { headers });
}

async function sessionFor(connection) {
  const { token } = await createHotelSession(connection, {
    hotelUserId: connection.state.user._id,
    role: connection.state.user.role,
  });
  return token;
}

function runHandler(handler, request, deps = {}) {
  return withHotelApi((req, ctx) => handler(req, ctx, deps))(request, {});
}

describe("Report handlers: auth, envelope, and query limits", () => {
  test("anonymous requests are rejected with 401", async () => {
    const connection = createFakeConnection("MANAGER");
    const response = await runHandler(
      handleHotelReportsSummary,
      buildRequest("/api/hotel/reports/summary?from=2030-06-01&to=2030-06-02"),
      { connect: connection, now: REPORT_NOW }
    );
    assert.equal(response.status, 401);
  });

  test("receptionist sessions are rejected with 403", async () => {
    const connection = createFakeConnection("RECEPTIONIST");
    const token = await sessionFor(connection);
    const response = await runHandler(
      handleHotelReportsSummary,
      buildRequest("/api/hotel/reports/summary?from=2030-06-01&to=2030-06-02", {
        token,
      }),
      { connect: connection, now: REPORT_NOW }
    );
    assert.equal(response.status, 403);
  });

  test("manager sessions receive the documented envelope", async () => {
    const connection = createFakeConnection("MANAGER");
    const token = await sessionFor(connection);
    const response = await runHandler(
      handleHotelReportsSummary,
      buildRequest("/api/hotel/reports/summary?from=2030-06-01&to=2030-06-02", {
        token,
      }),
      { connect: connection, now: REPORT_NOW }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.error, null);
    assert.equal(body.data.range.from, "2030-06-01");
    assert.equal(body.data.range.to, "2030-06-02");
    assert.deepEqual(body.data.definitions, HOTEL_REPORT_DEFINITIONS);
    assert.equal(body.data.days.length, 2);
    assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate, proxy-revalidate");
  });

  test("unknown and duplicate query fields are rejected", async () => {
    const connection = createFakeConnection("MANAGER");
    const token = await sessionFor(connection);
    const response = await runHandler(
      handleHotelReportsSummary,
      buildRequest(
        "/api/hotel/reports/summary?from=2030-06-01&to=2030-06-02&guestId=5",
        { token }
      ),
      { connect: connection, now: REPORT_NOW }
    );
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.match(body.error.details.fieldErrors.guestId, /not an allowed query parameter/);

    const missing = await runHandler(
      handleHotelReportsSummary,
      buildRequest("/api/hotel/reports/summary", { token }),
      { connect: connection, now: REPORT_NOW }
    );
    const missingBody = await missing.json();
    assert.equal(missing.status, 422);
    assert.ok(missingBody.error.details.fieldErrors.from);
    assert.ok(missingBody.error.details.fieldErrors.to);
  });

  test("future windows vanish at the handler boundary too", async () => {
    const connection = createFakeConnection("MANAGER");
    const token = await sessionFor(connection);
    const response = await runHandler(
      handleHotelReportsSummary,
      buildRequest("/api/hotel/reports/summary?from=2030-06-05&to=2030-06-06", {
        token,
      }),
      { connect: connection, now: REPORT_NOW }
    );
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.ok(body.error.details.fieldErrors.to);
  });
});

describe("CSV export handler", () => {
  test("managers get an RFC-4180 export with safe headers and filename", async () => {
    const connection = createFakeConnection("MANAGER");
    await seedRoomType(connection);
    const roomA = seedRoom(connection, {
      roomNumber: "101",
      history: [
        {
          status: "AVAILABLE",
          previousStatus: null,
          changedAt: addisMidnight("2030-01-01"),
        },
      ],
      createdAt: addisMidnight("2030-01-01"),
    });
    seedStay(connection, {
      roomId: roomA._id,
      status: "CHECKED_OUT",
      checkedInAt: addisInstant("2030-05-31", "20:00"),
      checkedOutAt: addisInstant("2030-06-01", "10:00"),
      billableNights: 1,
      roomCharges: 120,
      totalCharges: "120.00",
      chargeRule: HOTEL_STAY_CHARGE_RULE,
    });

    const token = await sessionFor(connection);
    const response = await runHandler(
      handleHotelReportsSummaryExport,
      buildRequest("/api/hotel/reports/summary/export?from=2030-06-01&to=2030-06-02", {
        token,
      }),
      { connect: connection, now: REPORT_NOW }
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="hotel-report-2030-06-01-to-2030-06-02.csv"'
    );
    assert.equal(
      response.headers.get("cache-control"),
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    const bytes = new Uint8Array(await response.arrayBuffer());
    // UTF-8 BOM (EF BB BF) must lead the file for correct Excel decoding.
    assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8").decode(bytes.slice(3));
    assert.ok(text.startsWith("Bono Hotel Room Performance Report\r\n"));
    const full = `${new TextDecoder("utf-8").decode(bytes)}`;
    assert.ok(full.endsWith("\r\n"));
    assert.ok(full.includes("\r\nDaily detail\r\n"));
    assert.ok(full.includes(HOTEL_REPORT_CSV_DAILY_HEADERS.join(",")));
    assert.ok(full.includes("Posted room charges (ETB),120.00"));
    // The export reconciles with the JSON summary through the same service.
    const json = await runHandler(
      handleHotelReportsSummary,
      buildRequest("/api/hotel/reports/summary?from=2030-06-01&to=2030-06-02", {
        token,
      }),
      { connect: connection, now: REPORT_NOW }
    ).then((res) => res.json());
    assert.equal(json.data.totals.postedRoomChargesMinor, 12000);
  });

  test("anonymous export requests are rejected", async () => {
    const connection = createFakeConnection("MANAGER");
    const response = await runHandler(
      handleHotelReportsSummaryExport,
      buildRequest("/api/hotel/reports/summary/export?from=2030-06-01&to=2030-06-02"),
      { connect: connection, now: REPORT_NOW }
    );
    assert.equal(response.status, 401);
  });

  test("uses the documented user-facing columns in a stable order", () => {
    assert.deepEqual([...HOTEL_REPORT_CSV_SUMMARY_HEADERS], ["Metric", "Value"]);
    assert.deepEqual([...HOTEL_REPORT_CSV_DAILY_HEADERS], [
      "Date",
      "Ethiopian date",
      "Occupied room-nights",
      "Available room-nights",
      "Occupancy rate (%)",
      "Payments collected (ETB)",
      "Voided payments (ETB)",
      "Posted room charges (ETB)",
      "Scheduled arrivals",
      "No-show arrivals",
      "Check-ins",
      "Departures due",
      "Check-outs",
    ]);
    const csv = renderHotelReportsSummaryCsv(csvFixture());
    assert.ok(csv.includes(`\r\nDaily detail\r\n${HOTEL_REPORT_CSV_DAILY_HEADERS.join(",")}\r\n`));
  });

  test("omits internal fields, raw keys, and debugging metadata", () => {
    const csv = renderHotelReportsSummaryCsv(csvFixture());
    for (const forbidden of [
      "_id",
      "ObjectId",
      "paymentsRecordedMinor",
      "paymentsVoidedMinor",
      "postedRoomChargesMinor",
      "outstandingMinor",
      "adrMinor",
      "revparMinor",
      "fromInstant",
      "toInstant",
      "statusHistory",
      "denominatorCoverage",
      "[Definitions]",
      "[Report]",
    ]) {
      assert.ok(!csv.includes(forbidden), `must not export ${forbidden}`);
    }
    assert.ok(!csv.includes("undefined"));
    assert.ok(!csv.includes("null"));
  });

  test("guards formulas and escapes quotes, commas, and newlines with CRLF", () => {
    assert.equal(escapeHotelCsvCell("=1+1"), "'=1+1");
    assert.equal(escapeHotelCsvCell("@cmd"), "'@cmd");
    assert.equal(escapeHotelCsvCell("+danger"), "'+danger");
    assert.equal(escapeHotelCsvCell("-x"), "'-x");
    assert.equal(escapeHotelCsvCell("\tinterp"), "'\tinterp");
    assert.equal(escapeHotelCsvCell("plain"), "plain");
    assert.equal(escapeHotelCsvCell("a,b"), '"a,b"');
    assert.equal(escapeHotelCsvCell('say "hi"'), '"say ""hi"""');
    assert.equal(escapeHotelCsvCell("line\nbreak"), '"line\r\nbreak"');
    assert.equal(escapeHotelCsvCell("line\r\nbreak"), '"line\r\nbreak"');

    const csv = renderHotelReportsSummaryCsv(
      csvFixture({
        methodBreakdown: {
          "=SUM(A1:A2)": 10000,
          "+danger": 5000,
          "@cmd": 2500,
          "-x": 1000,
        },
      })
    );
    assert.ok(csv.includes("'=sum(a1:a2),100.00"));
    assert.ok(csv.includes("'+danger,50.00"));
    assert.ok(csv.includes("'@cmd,25.00"));
    assert.ok(csv.includes("'-x,10.00"));
  });

  test("renders unavailable metrics as N/A and keeps numbers Excel-friendly", () => {
    const csv = renderHotelReportsSummaryCsv(
      csvFixture({
        totals: {
          occupiedRoomNights: 0,
          availableRoomNights: null,
          occupancyRatePct: null,
          paymentsRecordedMinor: 750000,
          paymentsRecordedCount: 0,
          paymentsVoidedMinor: 0,
          paymentsVoidedCount: 0,
          postedRoomChargesMinor: 0,
          outstandingMinor: null,
          adrMinor: null,
          revparMinor: null,
          scheduledArrivals: 0,
          noShowArrivals: 0,
          checkIns: 0,
          departuresDue: 0,
          checkOuts: 0,
        },
      })
    );
    assert.ok(csv.includes("Available room-nights,N/A"));
    assert.ok(csv.includes("Occupancy rate (%),N/A"));
    assert.ok(csv.includes("Payments collected (ETB),7500.00"));
    assert.ok(csv.includes("Outstanding balance (ETB),N/A"));
    // No thousands separators: Excel must see a number, not text.
    assert.ok(!csv.includes("7,500.00"));
    assert.ok(!csv.startsWith("\uFEFF"), "the BOM belongs to the HTTP handler");
  });

  test("keeps existing report calculations unchanged", async () => {
    const connection = createFakeConnection();
    const roomA = seedRoom(connection, {
      roomNumber: "601",
      history: [
        {
          status: "AVAILABLE",
          previousStatus: null,
          changedAt: addisMidnight("2030-01-01"),
        },
      ],
      createdAt: addisMidnight("2030-01-01"),
    });
    seedStay(connection, {
      roomId: roomA._id,
      status: "CHECKED_OUT",
      checkedInAt: addisInstant("2030-05-31", "20:00"),
      checkedOutAt: addisInstant("2030-06-01", "10:00"),
      billableNights: 1,
      roomCharges: 120,
      totalCharges: "120.00",
      chargeRule: HOTEL_STAY_CHARGE_RULE,
    });
    const summary = await buildHotelReportsSummary({
      connection,
      from: "2030-06-01",
      to: "2030-06-02",
      now: REPORT_NOW,
    });
    const csv = renderHotelReportsSummaryCsv(summary);
    assert.ok(csv.includes(`Occupied room-nights,${summary.totals.occupiedRoomNights}`));
    assert.ok(csv.includes(`Posted room charges (ETB),120.00`));
    assert.ok(csv.includes(`ADR (ETB),${(summary.totals.adrMinor / 100).toFixed(2)}`));
    assert.ok(csv.includes(`Occupancy rate (%),${summary.totals.occupancyRatePct.toFixed(1)}`));
  });
});

// —————————————————————————————————————————————————————————— PDF helpers
//
// Tests render with `compress: false` so the content streams are readable. This
// is a tiny PDF text extractor for the standard Helvetica output used here; it
// is not a general-purpose PDF parser and adds no dependency.

function decodePdfHex(hex) {
  let text = "";
  for (let index = 0; index < hex.length; index += 2) {
    text += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
  }
  return text;
}

function unescapePdfLiteral(text) {
  const escapes = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    "(": "(",
    ")": ")",
    "\\": "\\",
  };
  return text.replace(/\\([nrtbf()\\])/g, (_, character) => escapes[character]);
}

function extractPdfText(buffer) {
  const source = buffer.toString("latin1");
  const blocks = [...source.matchAll(/BT([\s\S]*?)ET/g)];
  const lines = [];
  for (const block of blocks) {
    const tokens = [
      ...block[1].matchAll(/<([0-9a-fA-F]+)>|\(((?:\\.|[^\\()])*)\)/g),
    ];
    let line = "";
    for (const token of tokens) {
      line +=
        token[1] !== undefined
          ? decodePdfHex(token[1])
          : unescapePdfLiteral(token[2]);
    }
    if (line.trim()) lines.push(line);
  }
  return lines.join("\n");
}

function pdfPageCount(buffer) {
  return (buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
}

function pdfMultiPageFixture() {
  const days = Array.from({ length: 92 }, (_, index) => {
    const date = formatHotelLocalDate(
      addHotelLocalDays(addisMidnight("2030-03-01"), index)
    );
    return {
      date,
      occupiedRoomNights: 1,
      availableRoomNights: 2,
      occupancyRatePct: 50,
      paymentsRecordedMinor: 10000,
      paymentsVoidedMinor: 0,
      postedRoomChargesMinor: 12000,
      scheduledArrivals: 0,
      noShowArrivals: 0,
      checkIns: 1,
      departuresDue: 1,
      checkOuts: 0,
    };
  });
  return csvFixture({
    range: { from: "2030-03-01", to: "2030-05-31", dayCount: 92 },
    days,
  });
}

describe("PDF export renderer", () => {
  test("starts with a PDF signature and uses A4 portrait dimensions", async () => {
    const pdf = await renderHotelReportsSummaryPdf(csvFixture(), {
      compress: false,
      generatedAt: REPORT_NOW,
    });
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.match(
      pdf.toString("latin1"),
      /\/MediaBox\s*\[\s*0\s+0\s+595\.28\s+841\.89\s*\]/
    );
    assert.equal(HOTEL_REPORT_PDF_PAGE.width, 595.28);
    assert.equal(HOTEL_REPORT_PDF_PAGE.height, 841.89);
  });

  test("includes the title, range, timestamp, summary labels, and table headings", async () => {
    const pdf = await renderHotelReportsSummaryPdf(csvFixture(), {
      compress: false,
      generatedAt: REPORT_NOW,
    });
    const text = extractPdfText(pdf);
    // Header cells may wrap at a hyphen; flatten whitespace and rejoin those
    // labels before asserting the human-facing heading text.
    const flat = text.replace(/\s+/g, " ").replace(/- /g, "-");

    assert.match(flat, /Bono Hotel/);
    assert.match(flat, /Room Performance Report/);
    assert.match(flat, /2030-06-01 to 2030-06-01/);
    assert.match(flat, /Generated: 05 Jun 2030, 12:00 \(Africa\/Addis_Ababa\)/);

    for (const label of [
      "Occupied room-nights",
      "Available room-nights",
      "Occupancy rate",
      "Payments collected (ETB)",
      "Voided payments (ETB)",
      "Posted room charges (ETB)",
      "Outstanding balance (ETB)",
      "ADR (ETB)",
      "RevPAR (ETB)",
      "Scheduled arrivals",
      "No-show arrivals",
      "Check-ins",
      "Departures due",
      "Check-outs",
    ]) {
      assert.ok(flat.includes(label), `missing summary label: ${label}`);
    }

    for (const heading of [
      "Date / Ethiopian date",
      "Occupied",
      "Available",
      "Occ. %",
      "Payments (ETB)",
      "Voids (ETB)",
      "Charges (ETB)",
      "Arrivals",
      "No-shows",
      "Check-ins",
      "Departures",
      "Check-outs",
      "Live room inventory",
      "Payments collected by method",
      "Data coverage",
      "Metric notes",
    ]) {
      assert.ok(flat.includes(heading), `missing table heading: ${heading}`);
    }
  });

  test("renders unavailable metrics as N/A and never as fabricated zeros", async () => {
    const pdf = await renderHotelReportsSummaryPdf(
      csvFixture({
        totals: {
          occupiedRoomNights: 0,
          availableRoomNights: null,
          occupancyRatePct: null,
          paymentsRecordedMinor: 750000,
          paymentsRecordedCount: 1,
          paymentsVoidedMinor: 0,
          paymentsVoidedCount: 0,
          postedRoomChargesMinor: 0,
          outstandingMinor: null,
          adrMinor: null,
          revparMinor: null,
          scheduledArrivals: 0,
          noShowArrivals: 0,
          checkIns: 0,
          departuresDue: 0,
          checkOuts: 0,
        },
        days: [
          {
            date: "2030-06-01",
            occupiedRoomNights: 0,
            availableRoomNights: null,
            occupancyRatePct: null,
            paymentsRecordedMinor: 750000,
            paymentsVoidedMinor: 0,
            postedRoomChargesMinor: 0,
            scheduledArrivals: 0,
            noShowArrivals: 0,
            checkIns: 0,
            departuresDue: 0,
            checkOuts: 0,
          },
        ],
      }),
      { compress: false, generatedAt: REPORT_NOW }
    );
    const flat = extractPdfText(pdf).replace(/\s+/g, " ");
    assert.ok(flat.includes("N/A"));
    assert.ok(!flat.includes("undefined"));
    assert.ok(!flat.includes("null"));
  });

  test("paginates long reports and repeats daily table headings", async () => {
    const pdf = await renderHotelReportsSummaryPdf(pdfMultiPageFixture(), {
      compress: false,
      generatedAt: REPORT_NOW,
    });
    assert.ok(pdfPageCount(pdf) >= 2, "expected a multi-page PDF");
    const text = extractPdfText(pdf);
    assert.ok(text.includes("Page 1 of"));
    assert.ok(
      (text.match(/Date \/ Ethiopian date/g) || []).length >= 2,
      "daily headings should repeat on continuation pages"
    );
  });

  test("excludes internal IDs, raw fields, and sensitive values", async () => {
    const pdf = await renderHotelReportsSummaryPdf(csvFixture(), {
      compress: false,
      generatedAt: REPORT_NOW,
    });
    const text = extractPdfText(pdf).toLowerCase();
    for (const forbidden of [
      "_id",
      "objectid",
      "statushistory",
      "recordedat",
      "voidedat",
      "checkedinat",
      "checkedoutat",
      "roomid",
      "guestid",
      "reservationid",
      "paymentnumber",
      "pinhash",
      "csrf",
      "session",
      "token",
      "password",
      "stack trace",
    ]) {
      assert.ok(!text.includes(forbidden), `must not expose ${forbidden}`);
    }
  });
});

describe("PDF export handler", () => {
  test("anonymous requests are rejected with 401", async () => {
    const connection = createFakeConnection("MANAGER");
    const response = await runHandler(
      handleHotelReportsSummaryExportPdf,
      buildRequest(
        "/api/hotel/reports/summary/export/pdf?from=2030-06-01&to=2030-06-02"
      ),
      { connect: connection, now: REPORT_NOW }
    );
    assert.equal(response.status, 401);
  });

  test("receptionist sessions are rejected with 403", async () => {
    const connection = createFakeConnection("RECEPTIONIST");
    const token = await sessionFor(connection);
    const response = await runHandler(
      handleHotelReportsSummaryExportPdf,
      buildRequest(
        "/api/hotel/reports/summary/export/pdf?from=2030-06-01&to=2030-06-02",
        { token }
      ),
      { connect: connection, now: REPORT_NOW }
    );
    assert.equal(response.status, 403);
  });

  test("managers receive a PDF with safe headers and a dated filename", async () => {
    const connection = createFakeConnection("MANAGER");
    const token = await sessionFor(connection);
    const response = await runHandler(
      handleHotelReportsSummaryExportPdf,
      buildRequest(
        "/api/hotel/reports/summary/export/pdf?from=2030-06-01&to=2030-06-02",
        { token }
      ),
      { connect: connection, now: REPORT_NOW }
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="hotel-report-2030-06-01-to-2030-06-02.pdf"'
    );
    assert.equal(
      response.headers.get("cache-control"),
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");

    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.match(
      bytes.toString("latin1"),
      /\/MediaBox\s*\[\s*0\s+0\s+595\.28\s+841\.89\s*\]/
    );
  });

  test("date validation matches the JSON and CSV endpoints", async () => {
    const connection = createFakeConnection("MANAGER");
    const token = await sessionFor(connection);

    const missing = await runHandler(
      handleHotelReportsSummaryExportPdf,
      buildRequest("/api/hotel/reports/summary/export/pdf", { token }),
      { connect: connection, now: REPORT_NOW }
    );
    assert.equal(missing.status, 422);
    const missingBody = await missing.json();
    assert.ok(missingBody.error.details.fieldErrors.from);
    assert.ok(missingBody.error.details.fieldErrors.to);

    const future = await runHandler(
      handleHotelReportsSummaryExportPdf,
      buildRequest(
        "/api/hotel/reports/summary/export/pdf?from=2030-06-05&to=2030-06-06",
        { token }
      ),
      { connect: connection, now: REPORT_NOW }
    );
    assert.equal(future.status, 422);
    const futureBody = await future.json();
    assert.ok(futureBody.error.details.fieldErrors.to);

    const unknown = await runHandler(
      handleHotelReportsSummaryExportPdf,
      buildRequest(
        "/api/hotel/reports/summary/export/pdf?from=2030-06-01&to=2030-06-02&guestId=5",
        { token }
      ),
      { connect: connection, now: REPORT_NOW }
    );
    assert.equal(unknown.status, 422);
  });
});

function csvFixture(overrides = {}) {
  return {
    range: { from: "2030-06-01", to: "2030-06-01", dayCount: 1 },
    definitions: HOTEL_REPORT_DEFINITIONS,
    labels: {
      payments: "recorded date",
      voids: "void date",
      charges: "checkout date",
    },
    totals: {
      occupiedRoomNights: 0,
      availableRoomNights: null,
      occupancyRatePct: null,
      paymentsRecordedMinor: 750000,
      paymentsRecordedCount: 1,
      paymentsVoidedMinor: 0,
      paymentsVoidedCount: 0,
      postedRoomChargesMinor: 0,
      outstandingMinor: null,
      adrMinor: null,
      revparMinor: null,
      scheduledArrivals: 0,
      noShowArrivals: 0,
      checkIns: 0,
      departuresDue: 0,
      checkOuts: 0,
    },
    days: [
      {
        date: "2030-06-01",
        occupiedRoomNights: 0,
        availableRoomNights: null,
        occupancyRatePct: null,
        paymentsRecordedMinor: 750000,
        paymentsVoidedMinor: 0,
        postedRoomChargesMinor: 0,
        scheduledArrivals: 0,
        noShowArrivals: 0,
        checkIns: 0,
        departuresDue: 0,
        checkOuts: 0,
      },
    ],
    methodBreakdown: {},
    inventory: {
      roomsTotal: 0,
      roomsActive: 0,
      roomsInactive: 0,
      roomsByOperationalStatus: {},
      roomTypesTotal: 0,
      roomTypesActive: 0,
    },
    denominatorCoverage: {
      fullyCovered: false,
      uncoveredDates: ["2030-06-01"],
    },
    ...overrides,
  };
}
