// Hotel Payments and Guest Folio backend tests — DB-free.
//
// No MongoDB connection is opened and no index is created. The services and
// route handlers run against an in-memory stub connection so amount parsing,
// permissions, idempotency, overpayment rejection, void/recalculation,
// concurrency gates, audit behavior, and POS isolation can be exercised
// deterministically.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import {
  HOTEL_PAYMENT_CURRENCY,
  HOTEL_PAYMENT_METHODS,
  HOTEL_PAYMENT_STATUSES,
  HOTEL_STAY_CHARGE_RULE,
} from "../lib/hotel/constants.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
  HotelValidationError,
} from "../lib/hotel/errors.js";
import { HOTEL_AUDIT_ACTIONS } from "../lib/hotel/audit.js";
import {
  canHotel,
  HOTEL_PERMISSIONS,
} from "../lib/hotel/auth/authorization.js";
import { toSafeHotelUser } from "../lib/hotel/models/hotelUser.js";
import {
  getHotelPaymentModel,
  toSafeHotelPayment,
} from "../lib/hotel/models/hotelPayment.js";
import { withHotelApi } from "../lib/hotel/http/apiResponse.js";
import {
  handleGetHotelPayment,
  handleGetStayFolio,
  handleRecordStayPayment,
  handleVoidHotelPayment,
} from "../lib/hotel/http/paymentHandlers.js";
import {
  buildHotelFolio,
  getHotelFolio,
  HOTEL_FOLIO_SETTLEMENT_STATUSES,
  HOTEL_FOLIO_SOURCES,
} from "../lib/hotel/services/folio.js";
import {
  getHotelPayment,
  recordStayPayment,
  voidHotelPayment,
} from "../lib/hotel/services/payments.js";
import {
  getHotelStayPaymentSummary,
  HOTEL_PAYMENT_SUMMARY_SOURCES,
} from "../lib/hotel/services/stayPayments.js";
import {
  fromHotelMinorUnits,
  parseHotelPaymentAmount,
  toHotelMinorUnits,
} from "../lib/hotel/money.js";
import {
  validateHotelPaymentPayload,
  validateHotelPaymentVoidPayload,
} from "../lib/hotel/validation.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (path) => readFileSync(join(root, path), "utf8");

const TEST_HOTEL_SECRET = "hotel-payment-test-secret-independent-1234567890";
const TEST_MONGO_URI = "mongodb://127.0.0.1:27017/bono_hotel";
const TEST_ORIGIN = "https://hotel.example";
const PAY_NOW = Date.UTC(2030, 0, 17, 2, 0, 0);
const VOID_NOW = Date.UTC(2030, 0, 17, 3, 0, 0);

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
  if (Array.isArray(row.statusHistory)) {
    copy.statusHistory = row.statusHistory.map((entry) => ({ ...entry }));
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

function makeCollectionModel(
  state,
  key,
  { uniqueFields = [], isLock = false } = {}
) {
  const rows = state[key];
  const findRow = (filter) => rows.find((row) => matchesFilter(row, filter));

  return {
    findById(id) {
      const result = async () => {
        const row = rows.find((entry) => String(entry._id) === String(id));
        return cloneRow(row);
      };
      return { select: () => ({ lean: result }), lean: result };
    },
    findOne(filter) {
      const result = async () => cloneRow(findRow(filter));
      return { select: () => ({ lean: result }), lean: result };
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
      for (const fields of uniqueFields) {
        const present = fields.every((field) => doc[field] != null);
        const duplicate =
          present &&
          rows.some((row) =>
            fields.every(
              (field) => String(row[field]) === String(doc[field])
            )
          );
        if (duplicate) throw duplicateKeyError();
      }
      const now = new Date();
      const row = {
        ...doc,
        _id: doc._id ?? new mongoose.Types.ObjectId(),
        createdAt: doc.createdAt ?? now,
        updatedAt: doc.updatedAt ?? now,
      };
      if (isLock) state.lockAcquireOrder.push(String(doc._id));
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

function createFakeConnection({
  role = "RECEPTIONIST",
  withPayments = true,
  auditFails = false,
} = {}) {
  const state = {
    user: makeUser({ role }),
    sessions: [],
    audits: [],
    stays: [],
    payments: [],
    locks: [],
    lockAcquireOrder: [],
    auditFails,
  };

  const lockModel = {
    ...makeCollectionModel(state, "locks", { isLock: true }),
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
      updateOne: async () => ({ modifiedCount: 1 }),
    },
    HotelSession: {
      create: async (doc) => {
        const row = {
          ...doc,
          _id: new mongoose.Types.ObjectId(),
          createdAt: new Date(),
        };
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
      updateOne: async (filter, update) => {
        const row = state.sessions.find((entry) =>
          matchesFilter(entry, filter)
        );
        if (!row) return { modifiedCount: 0 };
        if (update?.$set) Object.assign(row, update.$set);
        return { modifiedCount: 1 };
      },
    },
    HotelAuditLog: {
      create: async (doc) => {
        if (state.auditFails) throw new Error("audit store unavailable");
        state.audits.push(doc);
        return { ...doc, _id: new mongoose.Types.ObjectId() };
      },
    },
    Stay: makeCollectionModel(state, "stays", {
      uniqueFields: [["reservationId"]],
    }),
    RoomBookingLock: lockModel,
  };

  if (withPayments) {
    models.HotelPayment = makeCollectionModel(state, "payments", {
      uniqueFields: [
        ["paymentNumber"],
        ["stayId", "idempotencyKey"],
      ],
    });
  }

  return { state, models };
}

// Emulates Mongoose's lazy `connection.model(name, schema, collection)` API on
// a connection whose HotelPayment model has not been compiled yet.
function attachLazyPaymentModel(connection) {
  let calls = 0;
  connection.model = (name, schema, collection) => {
    calls += 1;
    assert.equal(name, "HotelPayment");
    assert.equal(collection, "hotel_payments");
    assert.equal(connection.models.HotelPayment, undefined);
    const model = makeCollectionModel(connection.state, "payments", {
      uniqueFields: [
        ["paymentNumber"],
        ["stayId", "idempotencyKey"],
      ],
    });
    connection.models[name] = model;
    return model;
  };
  return () => calls;
}

function seedStay(connection, overrides = {}) {
  const now = new Date();
  const checkedOutAt = overrides.checkedOutAt ?? new Date(PAY_NOW);
  const stay = {
    _id: new mongoose.Types.ObjectId(),
    reservationId: overrides.reservationId ?? new mongoose.Types.ObjectId(),
    reservationNumber: overrides.reservationNumber ?? "RES-20300115-A1B2C3",
    guestId: overrides.guestId ?? new mongoose.Types.ObjectId(),
    roomId: overrides.roomId ?? new mongoose.Types.ObjectId(),
    roomSnapshot: { roomNumber: "101", floor: 1 },
    guestSnapshot: {
      firstName: "Abebe",
      lastName: "Bekele",
      fullName: "Abebe Bekele",
      phone: "+251911000000",
      email: null,
    },
    status: overrides.status ?? "CHECKED_OUT",
    nightlyRate: overrides.nightlyRate ?? 120,
    billableNights: overrides.billableNights ?? 2,
    roomCharges: overrides.roomCharges ?? 240,
    totalCharges: overrides.totalCharges ?? 240,
    chargeRule: overrides.chargeRule ?? HOTEL_STAY_CHARGE_RULE,
    checkedInAt: overrides.checkedInAt ?? new Date("2030-01-15T07:00:00.000Z"),
    checkedOutAt:
      overrides.status === "IN_HOUSE"
        ? null
        : overrides.checkedOutAt ?? checkedOutAt,
    statusHistory: overrides.statusHistory ?? [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  connection.state.stays.push(stay);
  return stay;
}

function seedPayment(connection, stay, overrides = {}) {
  const now = new Date();
  const payment = {
    _id: new mongoose.Types.ObjectId(),
    paymentNumber:
      overrides.paymentNumber ??
      `PAY-20300117-${new mongoose.Types.ObjectId()
        .toHexString()
        .slice(-6)
        .toUpperCase()}`,
    stayId: stay._id,
    reservationId: stay.reservationId,
    guestId: stay.guestId,
    amountMinor: overrides.amountMinor ?? 10_000,
    currency: overrides.currency ?? HOTEL_PAYMENT_CURRENCY,
    method: overrides.method ?? "CASH",
    status: overrides.status ?? "RECORDED",
    idempotencyKey:
      overrides.idempotencyKey ??
      `seed-${new mongoose.Types.ObjectId().toHexString()}`,
    requestHash: overrides.requestHash ?? "a".repeat(64),
    actorUserId: overrides.actorUserId ?? connection.state.user._id,
    recordedAt: overrides.recordedAt ?? now,
    voidedAt: overrides.voidedAt ?? null,
    voidedBy: overrides.voidedBy ?? null,
    voidReason: overrides.voidReason ?? "",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
  connection.state.payments.push(payment);
  return payment;
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

function checkedOutFixture(overrides = {}) {
  const connection = createFakeConnection(overrides.connection);
  const stay = seedStay(connection, overrides.stay);
  const actor = toSafeHotelUser(connection.state.user);
  return { connection, stay, actor };
}

function paymentInput(overrides = {}) {
  return {
    amount: 100,
    method: "CASH",
    idempotencyKey: "payment-key-1",
    ...overrides,
  };
}

describe("Hotel money representation", () => {
  test("parses decimal major units exactly into integer minor units", () => {
    assert.deepEqual(parseHotelPaymentAmount(100), {
      amount: 100,
      amountMinor: 10_000,
    });
    assert.deepEqual(parseHotelPaymentAmount("100.50"), {
      amount: 100.5,
      amountMinor: 10_050,
    });
    assert.deepEqual(parseHotelPaymentAmount("0.10"), {
      amount: 0.1,
      amountMinor: 10,
    });
    assert.deepEqual(parseHotelPaymentAmount("0.20"), {
      amount: 0.2,
      amountMinor: 20,
    });
    assert.equal(fromHotelMinorUnits(10 + 20), 0.3);
    assert.equal(toHotelMinorUnits(240.00000000000003), 24_000);
  });

  test("rejects zero, negative, non-finite, and over-precise amounts", () => {
    for (const value of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "0",
      "-1",
      "1.234",
      "1e2",
      "1,000",
      ".5",
      "+1",
      {},
      null,
      true,
    ]) {
      const error = capture(() => parseHotelPaymentAmount(value));
      assert.ok(
        error instanceof HotelValidationError,
        `expected ${String(value)} to be rejected`
      );
      assert.ok(error.fieldErrors.amount);
    }
  });

  test("does not silently round existing charges with excess precision", () => {
    const error = capture(() => toHotelMinorUnits(1.234, { field: "total" }));
    assert.ok(error instanceof HotelValidationError);
    assert.ok(error.fieldErrors.total);
  });
});

describe("Hotel payment validation", () => {
  test("normalizes amount, method, and idempotency key", () => {
    const input = validateHotelPaymentPayload({
      amount: "100.50",
      method: " cash ",
      idempotencyKey: " payment-key-1 ",
    });
    assert.equal(input.amount, 100.5);
    assert.equal(input.amountMinor, 10_050);
    assert.equal(input.method, "CASH");
    assert.equal(input.idempotencyKey, "payment-key-1");
    assert.ok(HOTEL_PAYMENT_METHODS.includes(input.method));
  });

  test("requires all payment fields and rejects invalid values", () => {
    for (const body of [
      {},
      { method: "CASH", idempotencyKey: "key-1" },
      { amount: 100, idempotencyKey: "key-1" },
      { amount: 100, method: "CASH" },
      { amount: 0, method: "CASH", idempotencyKey: "key-1" },
      { amount: 100, method: "CARD_TERMINAL", idempotencyKey: "key-1" },
      { amount: 100, method: "CASH", idempotencyKey: "bad key" },
      { amount: 100, method: "CASH", idempotencyKey: "x".repeat(129) },
    ]) {
      const error = capture(() => validateHotelPaymentPayload(body));
      assert.ok(error instanceof HotelValidationError);
      assert.ok(Object.keys(error.fieldErrors).length > 0);
    }
  });

  test("rejects server-owned fields and payment-secret fields", () => {
    for (const field of [
      "status",
      "currency",
      "stayId",
      "amountMinor",
      "totalCharges",
      "paymentNumber",
      "actorUserId",
      "requestHash",
      "cardNumber",
      "cvv",
    ]) {
      const error = capture(() =>
        validateHotelPaymentPayload({
          amount: 100,
          method: "CASH",
          idempotencyKey: "key-1",
          [field]: "forged",
        })
      );
      assert.ok(error instanceof HotelValidationError, field);
      assert.ok(error.fieldErrors[field], field);
    }
  });

  test("void payloads allow only a reason and reject financial edits", () => {
    assert.deepEqual(validateHotelPaymentVoidPayload({}), { reason: "" });
    assert.deepEqual(
      validateHotelPaymentVoidPayload({ reason: "Duplicate tender" }),
      { reason: "Duplicate tender" }
    );

    for (const body of [
      { amount: 10 },
      { method: "CARD" },
      { status: "RECORDED" },
      { reason: "4111111111111111" },
    ]) {
      const error = capture(() => validateHotelPaymentVoidPayload(body));
      assert.ok(error instanceof HotelValidationError);
      assert.ok(Object.keys(error.fieldErrors).length > 0);
    }
  });
});

describe("HotelPayment model", () => {
  test("compiles only on the Hotel connection and defines its indexes", async () => {
    assert.equal(mongoose.models.HotelPayment, undefined);

    const connection = mongoose.createConnection();
    try {
      const Payment = getHotelPaymentModel(connection);
      assert.equal(connection.models.HotelPayment, Payment);
      assert.equal(mongoose.models.HotelPayment, undefined);
      assert.equal(Payment.collection.name, "hotel_payments");
      assert.deepEqual(Payment.schema.path("status").enumValues, [
        "RECORDED",
        "VOIDED",
      ]);
      assert.deepEqual(
        Payment.schema.path("method").enumValues,
        HOTEL_PAYMENT_METHODS
      );
      assert.deepEqual(
        Payment.schema.path("currency").enumValues,
        [HOTEL_PAYMENT_CURRENCY]
      );

      const valid = new Payment({
        paymentNumber: "PAY-20300117-A1B2C3",
        stayId: new mongoose.Types.ObjectId(),
        reservationId: new mongoose.Types.ObjectId(),
        guestId: new mongoose.Types.ObjectId(),
        amountMinor: 10_000,
        currency: HOTEL_PAYMENT_CURRENCY,
        method: "CASH",
        status: "RECORDED",
        idempotencyKey: "model-key-1",
        requestHash: "a".repeat(64),
        actorUserId: new mongoose.Types.ObjectId(),
        recordedAt: new Date(),
      });
      await valid.validate();

      const invalidStatus = new Payment({ ...valid.toObject(), status: "PAID" });
      await assert.rejects(
        invalidStatus.validate(),
        (error) => Boolean(error.errors.status)
      );

      const invalidAmount = new Payment({
        ...valid.toObject(),
        amountMinor: 0,
      });
      await assert.rejects(
        invalidAmount.validate(),
        (error) => Boolean(error.errors.amountMinor)
      );

      const invalidMethod = new Payment({
        ...valid.toObject(),
        method: "CARD_TERMINAL",
      });
      await assert.rejects(
        invalidMethod.validate(),
        (error) => Boolean(error.errors.method)
      );

      const invalidHash = new Payment({
        ...valid.toObject(),
        requestHash: "not-a-hash",
      });
      await assert.rejects(
        invalidHash.validate(),
        (error) => Boolean(error.errors.requestHash)
      );

      const indexes = Payment.schema.indexes();
      assert.ok(
        indexes.some(
          ([keys, options]) =>
            keys.paymentNumber === 1 && options.unique === true
        ),
        "paymentNumber unique index is defined"
      );
      assert.ok(
        indexes.some(
          ([keys, options]) =>
            keys.stayId === 1 &&
            keys.idempotencyKey === 1 &&
            options.unique === true
        ),
        "stayId + idempotencyKey unique index is defined"
      );
    } finally {
      await connection.close();
    }
  });

  test("safe serializer derives major units and never exposes the request hash", () => {
    const safe = toSafeHotelPayment({
      _id: new mongoose.Types.ObjectId(),
      paymentNumber: "PAY-20300117-A1B2C3",
      stayId: new mongoose.Types.ObjectId(),
      reservationId: new mongoose.Types.ObjectId(),
      guestId: new mongoose.Types.ObjectId(),
      amountMinor: 10_050,
      currency: HOTEL_PAYMENT_CURRENCY,
      method: "CARD",
      status: "RECORDED",
      idempotencyKey: "safe-key-1",
      requestHash: "b".repeat(64),
      actorUserId: new mongoose.Types.ObjectId(),
      recordedAt: new Date(),
    });

    assert.equal(safe.amount, 100.5);
    assert.equal(safe.amountMinor, 10_050);
    assert.equal(safe.currency, HOTEL_PAYMENT_CURRENCY);
    assert.equal(safe.requestHash, undefined);
    assert.equal(safe.idempotencyKey, "safe-key-1");
  });

  test("accepts a legacy decimal amount only as a read fallback", () => {
    const safe = toSafeHotelPayment({
      _id: new mongoose.Types.ObjectId(),
      stayId: new mongoose.Types.ObjectId(),
      amount: 100,
      status: "PAID",
    });
    assert.equal(safe.amount, 100);
    assert.equal(safe.amountMinor, 10_000);
  });
});

describe("Hotel folio calculations", () => {
  test("an unpaid finalized folio reports the persisted charge snapshot", async () => {
    const connection = createFakeConnection();
    const stay = seedStay(connection);

    const folio = await getHotelFolio({ connection, stayId: stay._id });
    assert.equal(folio.available, true);
    assert.equal(folio.finalized, true);
    assert.equal(folio.currency, HOTEL_PAYMENT_CURRENCY);
    assert.equal(folio.totalCharges, 240);
    assert.equal(folio.totalChargesMinor, 24_000);
    assert.equal(folio.totalPaid, 0);
    assert.equal(folio.totalPaidMinor, 0);
    assert.equal(folio.outstandingBalance, 240);
    assert.equal(folio.outstandingBalanceMinor, 24_000);
    assert.equal(folio.paymentCount, 0);
    assert.equal(folio.payments.length, 0);
    assert.equal(
      folio.settlementStatus,
      HOTEL_FOLIO_SETTLEMENT_STATUSES.UNPAID
    );
    assert.equal(folio.settled, false);
    assert.equal(folio.canRecordPayment, true);
    assert.equal(folio.source, HOTEL_FOLIO_SOURCES.HOTEL_PAYMENT_RECORDS);
  });

  test("counts only active persisted payments and lists voided history", async () => {
    const connection = createFakeConnection();
    const stay = seedStay(connection);
    seedPayment(connection, stay, { amountMinor: 10_000, status: "RECORDED" });
    seedPayment(connection, stay, { amountMinor: 5_000, status: "RECORDED" });
    seedPayment(connection, stay, { amountMinor: 99_900, status: "VOIDED" });
    seedPayment(connection, stay, { amountMinor: 2_000, status: "CANCELLED" });

    const folio = await getHotelFolio({ connection, stayId: stay._id });
    assert.equal(folio.available, true);
    assert.equal(folio.totalPaid, 150);
    assert.equal(folio.totalPaidMinor, 15_000);
    assert.equal(folio.outstandingBalance, 90);
    assert.equal(folio.overpayment, 0);
    assert.equal(folio.paymentCount, 2);
    assert.equal(folio.payments.length, 4);
    assert.equal(
      folio.settlementStatus,
      HOTEL_FOLIO_SETTLEMENT_STATUSES.PARTIALLY_PAID
    );
    assert.equal(folio.settled, false);
  });

  test("exact settlement requires persisted payment records", async () => {
    const connection = createFakeConnection();
    const stay = seedStay(connection);
    seedPayment(connection, stay, { amountMinor: 24_000, status: "RECORDED" });

    const folio = await getHotelFolio({ connection, stayId: stay._id });
    assert.equal(folio.totalPaid, 240);
    assert.equal(folio.outstandingBalance, 0);
    assert.equal(folio.overpayment, 0);
    assert.equal(
      folio.settlementStatus,
      HOTEL_FOLIO_SETTLEMENT_STATUSES.SETTLED
    );
    assert.equal(folio.settled, true);
    assert.equal(folio.canRecordPayment, false);
  });

  test("legacy overpayment is reported, never hidden or zeroed", async () => {
    const connection = createFakeConnection();
    const stay = seedStay(connection);
    seedPayment(connection, stay, { amountMinor: 30_000, status: "RECORDED" });

    const folio = await getHotelFolio({ connection, stayId: stay._id });
    assert.equal(folio.totalPaid, 300);
    assert.equal(folio.outstandingBalance, 0);
    assert.equal(folio.overpayment, 60);
    assert.equal(
      folio.settlementStatus,
      HOTEL_FOLIO_SETTLEMENT_STATUSES.OVERPAID
    );
    assert.equal(folio.settled, false);
  });

  test("an in-house stay has no finalized balance and null charges are not zero", async () => {
    const connection = createFakeConnection();
    const stay = seedStay(connection, {
      status: "IN_HOUSE",
      totalCharges: null,
      roomCharges: null,
      billableNights: null,
      chargeRule: null,
    });

    const folio = await getHotelFolio({ connection, stayId: stay._id });
    assert.equal(folio.available, true);
    assert.equal(folio.finalized, false);
    assert.equal(folio.totalCharges, null);
    assert.equal(folio.totalChargesMinor, null);
    assert.equal(folio.totalPaid, 0);
    assert.equal(folio.outstandingBalance, null);
    assert.equal(folio.overpayment, null);
    assert.equal(
      folio.settlementStatus,
      HOTEL_FOLIO_SETTLEMENT_STATUSES.CHARGES_NOT_FINALIZED
    );
    assert.equal(folio.settled, false);
    assert.equal(folio.canRecordPayment, false);
  });

  test("missing payment records are unavailable, not a zero balance", async () => {
    const connection = createFakeConnection({ withPayments: false });
    const stay = seedStay(connection);

    const folio = await buildHotelFolio({ connection, stay });
    assert.equal(folio.available, false);
    assert.equal(folio.totalCharges, 240);
    assert.equal(folio.totalPaid, null);
    assert.equal(folio.outstandingBalance, null);
    assert.equal(folio.overpayment, null);
    assert.equal(folio.paymentCount, 0);
    assert.equal(folio.source, HOTEL_FOLIO_SOURCES.PAYMENTS_NOT_IMPLEMENTED);

    const summary = await getHotelStayPaymentSummary({ connection, stay });
    assert.equal(summary.available, false);
    assert.equal(summary.totalCharges, 240);
    assert.equal(summary.totalPaid, null);
    assert.equal(summary.outstandingBalance, null);
    assert.equal(
      summary.source,
      HOTEL_PAYMENT_SUMMARY_SOURCES.PAYMENTS_NOT_IMPLEMENTED
    );
  });

  test("a cold-start folio compiles HotelPayment before reading persisted records", async () => {
    const connection = createFakeConnection({ withPayments: false });
    const stay = seedStay(connection);
    seedPayment(connection, stay, { amountMinor: 10_000 });
    seedPayment(connection, stay, { amountMinor: 5_000 });

    assert.equal(connection.models.HotelPayment, undefined);
    const factoryCalls = attachLazyPaymentModel(connection);

    const folio = await buildHotelFolio({ connection, stay });
    assert.equal(factoryCalls(), 1);
    assert.equal(typeof connection.models.HotelPayment.find, "function");
    assert.equal(folio.available, true);
    assert.equal(folio.source, HOTEL_FOLIO_SOURCES.HOTEL_PAYMENT_RECORDS);
    assert.equal(folio.totalCharges, 240);
    assert.equal(folio.totalPaid, 150);
    assert.equal(folio.outstandingBalance, 90);
    assert.equal(folio.paymentCount, 2);

    const summaryConnection = createFakeConnection({ withPayments: false });
    const summaryStay = seedStay(summaryConnection);
    seedPayment(summaryConnection, summaryStay, { amountMinor: 10_000 });
    seedPayment(summaryConnection, summaryStay, { amountMinor: 5_000 });

    assert.equal(summaryConnection.models.HotelPayment, undefined);
    const summaryFactoryCalls = attachLazyPaymentModel(summaryConnection);

    const summary = await getHotelStayPaymentSummary({
      connection: summaryConnection,
      stay: summaryStay,
    });
    assert.equal(summaryFactoryCalls(), 1);
    assert.equal(summary.available, true);
    assert.equal(summary.totalPaid, 150);
    assert.equal(summary.outstandingBalance, 90);
    assert.equal(summary.paymentCount, 2);
    assert.equal(
      summary.source,
      HOTEL_PAYMENT_SUMMARY_SOURCES.HOTEL_PAYMENT_RECORDS
    );
  });

  test("a corrupt persisted payment makes the folio unavailable", async () => {
    const connection = createFakeConnection();
    const stay = seedStay(connection);
    seedPayment(connection, stay, {
      amountMinor: null,
      amount: "not-money",
      status: "RECORDED",
    });

    const folio = await getHotelFolio({ connection, stayId: stay._id });
    assert.equal(folio.available, false);
    assert.equal(folio.totalPaid, null);
    assert.equal(folio.outstandingBalance, null);
    assert.equal(folio.overpayment, null);
    assert.equal(folio.paymentCount, null);
    assert.equal(folio.reason, "PAYMENT_RECORD_INVALID");
    assert.equal(folio.source, HOTEL_FOLIO_SOURCES.PAYMENT_RECORD_INVALID);
  });

  test("the Phase 4B payment summary is a compatibility view of the folio", async () => {
    const connection = createFakeConnection();
    const stay = seedStay(connection);
    seedPayment(connection, stay, { amountMinor: 10_000 });
    seedPayment(connection, stay, { amountMinor: 5_000 });

    const summary = await getHotelStayPaymentSummary({ connection, stay });
    assert.equal(summary.available, true);
    assert.equal(summary.totalCharges, 240);
    assert.equal(summary.totalPaid, 150);
    assert.equal(summary.outstandingBalance, 90);
    assert.equal(summary.overpayment, 0);
    assert.equal(summary.paymentCount, 2);
    assert.equal(
      summary.source,
      HOTEL_PAYMENT_SUMMARY_SOURCES.HOTEL_PAYMENT_RECORDS
    );
    assert.equal(summary.reason, null);
  });
});

describe("Hotel payment service", () => {
  test("records partial payments against the persisted charge snapshot", async () => {
    const { connection, stay, actor } = checkedOutFixture();

    const result = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput(),
      actor,
      now: PAY_NOW,
    });

    assert.equal(result.created, true);
    assert.equal(result.replayed, false);
    assert.equal(result.payment.status, "RECORDED");
    assert.equal(result.payment.amount, 100);
    assert.equal(result.payment.amountMinor, 10_000);
    assert.equal(result.payment.currency, HOTEL_PAYMENT_CURRENCY);
    assert.equal(result.payment.method, "CASH");
    assert.equal(result.payment.stayId, String(stay._id));
    assert.equal(result.payment.reservationId, String(stay.reservationId));
    assert.equal(result.payment.guestId, String(stay.guestId));
    assert.match(result.payment.paymentNumber, /^PAY-\d{8}-[A-F0-9]{6}$/);
    assert.equal(result.folio.totalPaid, 100);
    assert.equal(result.folio.outstandingBalance, 140);
    assert.equal(
      result.folio.settlementStatus,
      HOTEL_FOLIO_SETTLEMENT_STATUSES.PARTIALLY_PAID
    );
    assert.equal(connection.state.payments.length, 1);

    const recorded = auditsFor(connection, HOTEL_AUDIT_ACTIONS.PAYMENT_RECORDED);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].metadata.amountMinor, 10_000);
    assert.equal(recorded[0].metadata.method, "CASH");
    assert.equal(recorded[0].metadata.status, "RECORDED");
    assert.equal(recorded[0].metadata.idempotencyKey, undefined);
    assert.ok(recorded[0].metadata.idempotencyKeyHash);
    assert.equal(recorded[0].metadata.cardNumber, undefined);
    assert.equal(recorded[0].metadata.cvv, undefined);
  });

  test("supports exact settlement and rejects further overpayment", async () => {
    const { connection, stay, actor } = checkedOutFixture();

    await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ amount: 100 }),
      actor,
      now: PAY_NOW,
    });
    const settled = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({
        amount: 140,
        idempotencyKey: "payment-key-2",
      }),
      actor,
      now: PAY_NOW,
    });

    assert.equal(settled.created, true);
    assert.equal(settled.folio.totalPaid, 240);
    assert.equal(settled.folio.outstandingBalance, 0);
    assert.equal(settled.folio.settled, true);
    assert.equal(
      settled.folio.settlementStatus,
      HOTEL_FOLIO_SETTLEMENT_STATUSES.SETTLED
    );

    await assert.rejects(
      () =>
        recordStayPayment({
          connection,
          stayId: stay._id,
          input: paymentInput({
            amount: 1,
            idempotencyKey: "payment-key-3",
          }),
          actor,
          now: PAY_NOW,
        }),
      (error) =>
        error instanceof HotelApiError &&
        error.status === 409 &&
        error.code === HOTEL_ERROR_CODES.CONFLICT &&
        error.details.field === "amount"
    );

    assert.equal(connection.state.payments.length, 2);
    const rejected = auditsFor(connection, HOTEL_AUDIT_ACTIONS.PAYMENT_REJECTED);
    assert.ok(rejected.some((entry) => entry.metadata.reason === "OVERPAYMENT"));
  });

  test("rejects a payment that exceeds the outstanding balance", async () => {
    const { connection, stay, actor } = checkedOutFixture();
    await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ amount: 100 }),
      actor,
      now: PAY_NOW,
    });

    await assert.rejects(
      () =>
        recordStayPayment({
          connection,
          stayId: stay._id,
          input: paymentInput({
            amount: 141,
            idempotencyKey: "payment-key-2",
          }),
          actor,
          now: PAY_NOW,
        }),
      (error) =>
        error instanceof HotelApiError &&
        error.status === 409 &&
        error.details.outstandingBalance === 140 &&
        error.details.outstandingBalanceMinor === 14_000
    );

    assert.equal(connection.state.payments.length, 1);
  });

  test("rejects payments before check-out and for unfinalized charges", async () => {
    const inHouse = checkedOutFixture({
      stay: {
        status: "IN_HOUSE",
        totalCharges: null,
        roomCharges: null,
        billableNights: null,
        chargeRule: null,
      },
    });

    await assert.rejects(
      () =>
        recordStayPayment({
          connection: inHouse.connection,
          stayId: inHouse.stay._id,
          input: paymentInput(),
          actor: inHouse.actor,
          now: PAY_NOW,
        }),
      (error) =>
        error instanceof HotelApiError &&
        error.status === 409 &&
        error.details.field === "stayId"
    );
    assert.equal(inHouse.connection.state.payments.length, 0);
    assert.ok(
      auditsFor(inHouse.connection, HOTEL_AUDIT_ACTIONS.PAYMENT_REJECTED).some(
        (entry) => entry.metadata.reason === "STAY_NOT_CHECKED_OUT"
      )
    );

    const unfinalized = checkedOutFixture({
      stay: {
        totalCharges: null,
        roomCharges: null,
        billableNights: null,
        chargeRule: null,
      },
    });
    await assert.rejects(
      () =>
        recordStayPayment({
          connection: unfinalized.connection,
          stayId: unfinalized.stay._id,
          input: paymentInput(),
          actor: unfinalized.actor,
          now: PAY_NOW,
        }),
      (error) =>
        error instanceof HotelApiError &&
        error.status === 409 &&
        error.details.field === "totalCharges"
    );
    assert.equal(unfinalized.connection.state.payments.length, 0);
  });

  test("rejects invalid amounts and methods before any write", async () => {
    const { connection, stay, actor } = checkedOutFixture();

    for (const input of [
      paymentInput({ amount: 0 }),
      paymentInput({ amount: -1 }),
      paymentInput({ amount: Number.NaN }),
      paymentInput({ amount: "1.234" }),
      paymentInput({ method: "CARD_TERMINAL" }),
      paymentInput({ idempotencyKey: "bad key" }),
      paymentInput({ currency: "USD" }),
      paymentInput({ totalCharges: 1 }),
    ]) {
      await assert.rejects(
        () =>
          recordStayPayment({
            connection,
            stayId: stay._id,
            input,
            actor,
            now: PAY_NOW,
          }),
        (error) => error instanceof HotelValidationError
      );
    }
    assert.equal(connection.state.payments.length, 0);
  });

  test("replays an identical idempotent request and conflicts on different details", async () => {
    const { connection, stay, actor } = checkedOutFixture();

    const first = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ amount: "100.50" }),
      actor,
      now: PAY_NOW,
    });
    const replay = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ amount: "100.50" }),
      actor,
      now: PAY_NOW + 1_000,
    });

    assert.equal(replay.created, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.payment.id, first.payment.id);
    assert.equal(connection.state.payments.length, 1);
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.PAYMENT_REPLAYED).length,
      1
    );

    await assert.rejects(
      () =>
        recordStayPayment({
          connection,
          stayId: stay._id,
          input: paymentInput({ amount: 101 }),
          actor,
          now: PAY_NOW + 2_000,
        }),
      (error) =>
        error instanceof HotelApiError &&
        error.status === 409 &&
        error.details.field === "idempotencyKey"
    );
    assert.equal(connection.state.payments.length, 1);

    await assert.rejects(
      () =>
        recordStayPayment({
          connection,
          stayId: stay._id,
          input: paymentInput({ method: "CARD" }),
          actor,
          now: PAY_NOW + 3_000,
        }),
      (error) =>
        error instanceof HotelApiError &&
        error.status === 409 &&
        error.details.field === "idempotencyKey"
    );
    assert.equal(connection.state.payments.length, 1);
    assert.ok(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.PAYMENT_REJECTED).some(
        (entry) => entry.metadata.reason === "IDEMPOTENCY_KEY_CONFLICT"
      )
    );
  });

  test("scopes idempotency keys to the stay", async () => {
    const { connection, stay, actor } = checkedOutFixture();
    const secondStay = seedStay(connection);

    await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ idempotencyKey: "shared-key" }),
      actor,
      now: PAY_NOW,
    });
    const second = await recordStayPayment({
      connection,
      stayId: secondStay._id,
      input: paymentInput({ idempotencyKey: "shared-key" }),
      actor,
      now: PAY_NOW,
    });

    assert.equal(second.created, true);
    assert.equal(connection.state.payments.length, 2);
  });

  test("concurrent duplicate requests create at most one payment", async () => {
    const { connection, stay, actor } = checkedOutFixture();

    const results = await Promise.allSettled([
      recordStayPayment({
        connection,
        stayId: stay._id,
        input: paymentInput({ idempotencyKey: "concurrent-key" }),
        actor,
        now: PAY_NOW,
      }),
      recordStayPayment({
        connection,
        stayId: stay._id,
        input: paymentInput({ idempotencyKey: "concurrent-key" }),
        actor,
        now: PAY_NOW,
      }),
    ]);

    assert.equal(connection.state.payments.length, 1);
    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    assert.equal(fulfilled.length, 1);
    assert.equal(fulfilled[0].value.created, true);
    const rejected = results.filter((entry) => entry.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.status, 409);

    const retry = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ idempotencyKey: "concurrent-key" }),
      actor,
      now: PAY_NOW + 1_000,
    });
    assert.equal(retry.created, false);
    assert.equal(retry.replayed, true);
    assert.equal(connection.state.payments.length, 1);
  });

  test("concurrent different keys cannot overpay the folio", async () => {
    const { connection, stay, actor } = checkedOutFixture();

    await Promise.allSettled([
      recordStayPayment({
        connection,
        stayId: stay._id,
        input: paymentInput({ amount: 150, idempotencyKey: "race-key-1" }),
        actor,
        now: PAY_NOW,
      }),
      recordStayPayment({
        connection,
        stayId: stay._id,
        input: paymentInput({ amount: 150, idempotencyKey: "race-key-2" }),
        actor,
        now: PAY_NOW,
      }),
    ]);

    assert.ok(connection.state.payments.length <= 1);
    const folio = await getHotelFolio({ connection, stayId: stay._id });
    assert.ok(folio.totalPaid <= 240);
    assert.equal(folio.overpayment, 0);
  });

  test("audit failures never break payment creation", async () => {
    const { connection, stay, actor } = checkedOutFixture({
      connection: { auditFails: true },
    });

    const result = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput(),
      actor,
      now: PAY_NOW,
    });

    assert.equal(result.created, true);
    assert.equal(connection.state.payments.length, 1);
  });

  test("accepts decimal strings and accumulates without floating-point drift", async () => {
    const { connection, stay, actor } = checkedOutFixture();

    await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ amount: "0.10", idempotencyKey: "decimal-1" }),
      actor,
      now: PAY_NOW,
    });
    const second = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ amount: "0.20", idempotencyKey: "decimal-2" }),
      actor,
      now: PAY_NOW,
    });

    assert.equal(second.folio.totalPaid, 0.3);
    assert.equal(second.folio.totalPaidMinor, 30);
    assert.equal(second.folio.outstandingBalance, 239.7);
  });

  test("a missing stay is a generic 404 and an invalid id is a 422", async () => {
    const { connection, actor } = checkedOutFixture();

    await assert.rejects(
      () =>
        recordStayPayment({
          connection,
          stayId: new mongoose.Types.ObjectId(),
          input: paymentInput(),
          actor,
          now: PAY_NOW,
        }),
      (error) =>
        error instanceof HotelApiError &&
        error.status === 404 &&
        error.message === "Stay not found"
    );

    await assert.rejects(
      () =>
        recordStayPayment({
          connection,
          stayId: "not-an-id",
          input: paymentInput(),
          actor,
          now: PAY_NOW,
        }),
      (error) =>
        error instanceof HotelValidationError &&
        Boolean(error.fieldErrors.id)
    );
  });
});

describe("Hotel payment void service", () => {
  test("voiding is non-destructive and recalculates the folio", async () => {
    const { connection, stay, actor } = checkedOutFixture();
    const first = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ amount: 100, idempotencyKey: "void-key-1" }),
      actor,
      now: PAY_NOW,
    });
    await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ amount: 140, idempotencyKey: "void-key-2" }),
      actor,
      now: PAY_NOW,
    });

    const voided = await voidHotelPayment({
      connection,
      paymentId: first.payment.id,
      input: { reason: "Duplicate tender" },
      actor,
      now: VOID_NOW,
    });

    assert.equal(voided.changed, true);
    assert.equal(voided.replayed, false);
    assert.equal(voided.payment.status, "VOIDED");
    assert.equal(voided.payment.voidReason, "Duplicate tender");
    assert.equal(voided.payment.voidedBy, actor.id);
    assert.equal(voided.payment.voidedAt, new Date(VOID_NOW).toISOString());
    assert.equal(voided.folio.totalPaid, 140);
    assert.equal(voided.folio.outstandingBalance, 100);
    assert.equal(
      voided.folio.settlementStatus,
      HOTEL_FOLIO_SETTLEMENT_STATUSES.PARTIALLY_PAID
    );
    assert.equal(voided.folio.settled, false);
    assert.equal(connection.state.payments.length, 2);

    const audits = auditsFor(connection, HOTEL_AUDIT_ACTIONS.PAYMENT_VOIDED);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].metadata.previousStatus, "RECORDED");
    assert.equal(audits[0].metadata.status, "VOIDED");
    assert.equal(audits[0].metadata.reason, "Duplicate tender");
  });

  test("repeated void requests are idempotent and audited", async () => {
    const { connection, stay, actor } = checkedOutFixture();
    const created = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ idempotencyKey: "repeat-void-key" }),
      actor,
      now: PAY_NOW,
    });

    const first = await voidHotelPayment({
      connection,
      paymentId: created.payment.id,
      input: { reason: "First reason" },
      actor,
      now: VOID_NOW,
    });
    const second = await voidHotelPayment({
      connection,
      paymentId: created.payment.id,
      input: { reason: "Different reason" },
      actor,
      now: VOID_NOW + 1_000,
    });

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.payment.status, "VOIDED");
    assert.equal(second.payment.voidReason, "First reason");
    assert.equal(
      auditsFor(connection, HOTEL_AUDIT_ACTIONS.PAYMENT_VOID_REPLAYED).length,
      1
    );
    assert.equal(connection.state.payments.length, 1);
  });

  test("void payloads cannot edit amount or method", async () => {
    const { connection, stay, actor } = checkedOutFixture();
    const created = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ idempotencyKey: "void-edit-key" }),
      actor,
      now: PAY_NOW,
    });

    for (const input of [
      { amount: 10 },
      { method: "CARD" },
      { status: "RECORDED" },
      { reason: "4111111111111111" },
    ]) {
      await assert.rejects(
        () =>
          voidHotelPayment({
            connection,
            paymentId: created.payment.id,
            input,
            actor,
            now: VOID_NOW,
          }),
        (error) => error instanceof HotelValidationError
      );
    }

    assert.equal(connection.state.payments[0].status, "RECORDED");
    assert.equal(connection.state.payments.length, 1);
  });

  test("voiding a missing payment is a 404 and audit failure does not block", async () => {
    const { connection, stay, actor } = checkedOutFixture();
    const created = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ idempotencyKey: "void-audit-key" }),
      actor,
      now: PAY_NOW,
    });

    await assert.rejects(
      () =>
        voidHotelPayment({
          connection,
          paymentId: new mongoose.Types.ObjectId(),
          actor,
          now: VOID_NOW,
        }),
      (error) =>
        error instanceof HotelApiError &&
        error.status === 404 &&
        error.message === "Payment not found"
    );

    connection.state.auditFails = true;
    const voided = await voidHotelPayment({
      connection,
      paymentId: created.payment.id,
      actor,
      now: VOID_NOW,
    });
    assert.equal(voided.changed, true);
    assert.equal(voided.payment.status, "VOIDED");
  });

  test("a non-recorded payment cannot be voided", async () => {
    const { connection, stay, actor } = checkedOutFixture();
    const seeded = seedPayment(connection, stay, {
      status: "PAID",
      amountMinor: 10_000,
    });

    await assert.rejects(
      () =>
        voidHotelPayment({
          connection,
          paymentId: seeded._id,
          actor,
          now: VOID_NOW,
        }),
      (error) =>
        error instanceof HotelApiError &&
        error.status === 409 &&
        error.details.field === "status"
    );
    assert.equal(seeded.status, "PAID");
  });
});

describe("Hotel payment HTTP routes", () => {
  test("enforces exact origin and required JSON body on payment mutations", async () => {
    const { connection, stay } = checkedOutFixture();

    const badOrigin = await runHandler(
      handleRecordStayPayment,
      buildRequest({
        method: "POST",
        path: `/api/hotel/stays/${stay._id}/payments`,
        origin: "https://evil.example",
        body: paymentInput(),
      }),
      paramsFor(stay._id),
      { connect: connection, now: PAY_NOW, authenticate: testManagerAuth }
    );
    assert.equal(badOrigin.status, 403);
    assert.equal(
      (await badOrigin.json()).error.code,
      HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED
    );
    assert.equal(connection.state.payments.length, 0);

    const noBody = await runHandler(
      handleRecordStayPayment,
      buildRequest({
        method: "POST",
        path: `/api/hotel/stays/${stay._id}/payments`,
      }),
      paramsFor(stay._id),
      { connect: connection, now: PAY_NOW, authenticate: testManagerAuth }
    );
    assert.equal(noBody.status, 415);
    assert.equal(connection.state.payments.length, 0);
  });

  test("Phase 1 MANAGER can record, read, and void a payment", async () => {
    const { connection, stay } = checkedOutFixture();

    const recorded = await runHandler(
      handleRecordStayPayment,
      buildRequest({
        method: "POST",
        path: `/api/hotel/stays/${stay._id}/payments`,
        body: paymentInput({ amount: "100.50" }),
      }),
      paramsFor(stay._id),
      { connect: connection, now: PAY_NOW, authenticate: testManagerAuth }
    );
    assert.equal(recorded.status, 201);
    const recordedBody = await recorded.json();
    assert.equal(recordedBody.data.created, true);
    assert.equal(recordedBody.data.payment.amount, 100.5);
    assert.equal(recordedBody.data.payment.amountMinor, 10_050);
    const paymentId = recordedBody.data.payment.id;

    const replayed = await runHandler(
      handleRecordStayPayment,
      buildRequest({
        method: "POST",
        path: `/api/hotel/stays/${stay._id}/payments`,
        body: paymentInput({ amount: "100.50" }),
      }),
      paramsFor(stay._id),
      { connect: connection, now: PAY_NOW + 1_000, authenticate: testManagerAuth }
    );
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json()).data.created, false);

    const folio = await runHandler(
      handleGetStayFolio,
      buildRequest({
        path: `/api/hotel/stays/${stay._id}/folio`,
      }),
      paramsFor(stay._id),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(folio.status, 200);
    const folioBody = await folio.json();
    assert.equal(folioBody.data.folio.totalCharges, 240);
    assert.equal(folioBody.data.folio.totalPaid, 100.5);
    assert.equal(folioBody.data.folio.outstandingBalance, 139.5);
    assert.equal(folioBody.data.folio.payments.length, 1);

    const detail = await runHandler(
      handleGetHotelPayment,
      buildRequest({
        path: `/api/hotel/payments/${paymentId}`,
      }),
      paramsFor(paymentId),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.data.payment.id, paymentId);
    assert.equal(detailBody.data.folio.totalPaid, 100.5);
    assert.equal(detailBody.data.folio.payments, undefined);

    const voided = await runHandler(
      handleVoidHotelPayment,
      buildRequest({
        method: "POST",
        path: `/api/hotel/payments/${paymentId}/void`,
        body: { reason: "Duplicate tender" },
      }),
      paramsFor(paymentId),
      { connect: connection, now: VOID_NOW, authenticate: testManagerAuth }
    );
    assert.equal(voided.status, 200);
    const voidedBody = await voided.json();
    assert.equal(voidedBody.data.changed, true);
    assert.equal(voidedBody.data.payment.status, "VOIDED");
    assert.equal(voidedBody.data.folio.totalPaid, 0);
    assert.equal(voidedBody.data.folio.outstandingBalance, 240);

    const repeated = await runHandler(
      handleVoidHotelPayment,
      buildRequest({
        method: "POST",
        path: `/api/hotel/payments/${paymentId}/void`,
      }),
      paramsFor(paymentId),
      { connect: connection, now: VOID_NOW + 1_000, authenticate: testManagerAuth }
    );
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).data.changed, false);
  });

  test("manager can record a payment", async () => {
    const { connection, stay } = checkedOutFixture({
      connection: { role: "MANAGER" },
    });

    const recorded = await runHandler(
      handleRecordStayPayment,
      buildRequest({
        method: "POST",
        path: `/api/hotel/stays/${stay._id}/payments`,
        body: paymentInput(),
      }),
      paramsFor(stay._id),
      { connect: connection, now: PAY_NOW, authenticate: testManagerAuth }
    );
    assert.equal(recorded.status, 201);
  });

  test("void mutations require exact origin", async () => {
    const { connection, stay } = checkedOutFixture();
    const created = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput(),
      actor: toSafeHotelUser(connection.state.user),
      now: PAY_NOW,
    });

    const badOrigin = await runHandler(
      handleVoidHotelPayment,
      buildRequest({
        method: "POST",
        path: `/api/hotel/payments/${created.payment.id}/void`,
        origin: "https://evil.example",
      }),
      paramsFor(created.payment.id),
      { connect: connection, now: VOID_NOW }
    );
    assert.equal(badOrigin.status, 403);
    assert.equal(connection.state.payments[0].status, "RECORDED");
  });

  test("overpayment responses are safe and contain no database details", async () => {
    const { connection, stay } = checkedOutFixture();
    const created = await recordStayPayment({
      connection,
      stayId: stay._id,
      input: paymentInput({ amount: 200 }),
      actor: toSafeHotelUser(connection.state.user),
      now: PAY_NOW,
    });

    const overpayment = await runHandler(
      handleRecordStayPayment,
      buildRequest({
        method: "POST",
        path: `/api/hotel/stays/${stay._id}/payments`,
        body: paymentInput({
          amount: 41,
          idempotencyKey: "overpay-http-key",
        }),
      }),
      paramsFor(stay._id),
      { connect: connection, now: PAY_NOW, authenticate: testManagerAuth }
    );
    assert.equal(overpayment.status, 409);
    const text = await overpayment.text();
    assert.ok(text.includes("Payment exceeds the outstanding balance"));
    assert.ok(!/stack|mongodb|MongoServerError|connection string/i.test(text));
    assert.equal(connection.state.payments.length, 1);

    const invalidId = await runHandler(
      handleGetHotelPayment,
      buildRequest({ path: "/api/hotel/payments/not-an-id" }),
      paramsFor("not-an-id"),
      { connect: connection, authenticate: testManagerAuth }
    );
    assert.equal(invalidId.status, 422);
    assert.ok(
      (await invalidId.json()).error.details.fieldErrors.id
    );
  });

  test("unavailable payment records produce a generic 503", async () => {
    const { connection, stay } = checkedOutFixture();
    connection.models.HotelPayment.find = () => {
      throw new Error("mongodb://127.0.0.1:27017/bono_hotel unavailable");
    };

    const response = await runHandler(
      handleRecordStayPayment,
      buildRequest({
        method: "POST",
        path: `/api/hotel/stays/${stay._id}/payments`,
        body: paymentInput(),
      }),
      paramsFor(stay._id),
      { connect: connection, now: PAY_NOW }
    );
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.ok(text.includes("temporarily unavailable"));
    assert.ok(!/mongodb:\/\/|stack|bono_hotel/i.test(text));
  });

  test("route files are protected, node-runtime, and expose no hard delete", () => {
    const routeFiles = [
      "app/api/hotel/stays/[id]/payments/route.js",
      "app/api/hotel/stays/[id]/folio/route.js",
      "app/api/hotel/payments/[id]/route.js",
      "app/api/hotel/payments/[id]/void/route.js",
    ];

    for (const file of routeFiles) {
      const source = src(file);
      assert.match(source, /export const runtime = "nodejs"/, file);
      assert.match(source, /export const dynamic = "force-dynamic"/, file);
      assert.match(source, /withHotelApi/, file);
      assert.ok(
        !/export\s+const\s+(DELETE|PUT|PATCH)/.test(source),
        `${file} must not expose delete/update handlers`
      );
    }

    const handlers = src("lib/hotel/http/paymentHandlers.js");
    assert.match(
      handlers,
      /handleRecordStayPayment[\s\S]*BILLING_MANAGE/
    );
    assert.match(handlers, /handleVoidHotelPayment[\s\S]*BILLING_MANAGE/);
    assert.match(handlers, /handleGetStayFolio[\s\S]*BILLING_READ/);
    assert.match(handlers, /handleGetHotelPayment[\s\S]*BILLING_READ/);
  });

  test("payment files never import POS modules and never hard-delete business rows", () => {
    const files = [
      "lib/hotel/money.js",
      "lib/hotel/models/hotelPayment.js",
      "lib/hotel/services/folio.js",
      "lib/hotel/services/payments.js",
      "lib/hotel/http/paymentHandlers.js",
    ];

    for (const file of files) {
      const source = src(file);
      for (const forbidden of [
        "@/lib/mongodb",
        "@/lib/serverAuth",
        "@/lib/authServer",
        "@/lib/sessionStore",
        "@/lib/withApi",
        "@/lib/security",
        "@/lib/apiResponse",
        "@/lib/validate",
        "lib/models/",
        "lib/payment",
        "lib/db/",
        "process.env",
      ]) {
        assert.ok(!source.includes(forbidden), `${file} contains ${forbidden}`);
      }
      assert.ok(
        !/deleteOne|deleteMany|findByIdAndDelete|findOneAndDelete/.test(source),
        `${file} must not hard-delete business records`
      );
    }
  });
});

describe("Hotel payment authorization matrix", () => {
  test("both Hotel roles may read and manage billing, but unknown roles may not", () => {
    for (const role of ["MANAGER", "RECEPTIONIST"]) {
      assert.equal(canHotel(role, HOTEL_PERMISSIONS.BILLING_READ), true, role);
      assert.equal(canHotel(role, HOTEL_PERMISSIONS.BILLING_MANAGE), true, role);
    }
    assert.equal(canHotel("UNKNOWN", HOTEL_PERMISSIONS.BILLING_READ), false);
    assert.equal(canHotel("UNKNOWN", HOTEL_PERMISSIONS.BILLING_MANAGE), false);
    assert.ok(HOTEL_PAYMENT_STATUSES.includes("RECORDED"));
    assert.ok(HOTEL_PAYMENT_STATUSES.includes("VOIDED"));
  });
});
