// Hotel disposable-MongoDB integration tests — explicit opt-in only.
//
// No connection is opened unless the complete test-only opt-in environment is
// present. The guard claims a fresh loopback standalone target before any test
// data is written. With HOTEL_INTEGRATION_WAIT_FOR_INDEXES=1, index readiness is
// confirmed read-only after the claim and before any in-database fixture,
// including the manager and receptionist users. A wait failure or timeout aborts
// the run without automatic cleanup, so the marker and any existing data remain
// for inspection. Without that flag, the harness never requires, creates,
// repairs, deploys, or synchronizes indexes; it only verifies that the harness
// itself created no custom indexes.
//
// This file never runs cleanup: a failed or successful run leaves the ownership
// marker and test data for the separate cleanup command.
//
// Failure output must remain free of URIs, credentials, session/CSRF tokens,
// and raw documents. Assertions below compare scalar safe fields; unexpected
// service errors are narrowed with the harness redactor before being rethrown.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { HOTEL_DB_NAME } from "../lib/hotel/constants.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
} from "../lib/hotel/errors.js";
import {
  connectToHotelDatabase,
  disconnectHotelDatabase,
} from "../lib/hotel/db/connection.js";
import {
  addHotelLocalDays,
  formatHotelLocalDate,
  hotelLocalToday,
} from "../lib/hotel/dates.js";
import { getGuestModel } from "../lib/hotel/models/guest.js";
import { getHotelAuditLogModel } from "../lib/hotel/models/hotelAuditLog.js";
import { getHotelPaymentModel } from "../lib/hotel/models/hotelPayment.js";
import { getHotelSessionModel } from "../lib/hotel/models/hotelSession.js";
import { getHotelUserModel } from "../lib/hotel/models/hotelUser.js";
import { getReservationModel } from "../lib/hotel/models/reservation.js";
import { getRoomModel } from "../lib/hotel/models/room.js";
import { getRoomBookingLockModel } from "../lib/hotel/models/roomBookingLock.js";
import { getRoomTypeModel } from "../lib/hotel/models/roomType.js";
import { getStayModel } from "../lib/hotel/models/stay.js";
import { createGuest } from "../lib/hotel/services/guests.js";
import { createReservation, cancelReservation } from "../lib/hotel/services/reservations.js";
import { createRoom } from "../lib/hotel/services/rooms.js";
import { createRoomType } from "../lib/hotel/services/roomTypes.js";
import {
  checkInReservation,
  checkOutStay,
} from "../lib/hotel/services/stays.js";
import {
  getStayFolio,
  recordStayPayment,
  voidHotelPayment,
} from "../lib/hotel/services/payments.js";
import {
  assertNoCachedHotelConnection,
  claimHotelIntegrationTarget,
  verifyHotelIntegrationConnection,
  verifyHotelIntegrationOwnership,
  HotelIntegrationGuardError,
} from "./helpers/hotel-integration-guard.mjs";
import {
  createHotelIntegrationFixtures,
  createHotelIntegrationRunId,
  HotelIntegrationHarnessError,
  inspectHotelIndexReadiness,
  installHotelIntegrationRuntimeEnvironment,
  inspectHotelIntegrationOptIn,
  readHotelIntegrationHarnessOptions,
  readHotelIntegrationOwnershipMarker,
  safeHotelIntegrationError,
  waitForHotelIndexes,
} from "./helpers/hotel-integration-harness.mjs";

const optIn = inspectHotelIntegrationOptIn(process.env);

let connection = null;
let config = null;
let ownership = null;
let runtime = null;
let runId = null;
let fixtures = null;
let waitForIndexes = false;
let preflightIndexReadiness = null;
let manager = null;
let receptionist = null;
let fixtureSequence = 0;

function nextFixtureIndex() {
  fixtureSequence += 1;
  return fixtureSequence;
}

function localDate(now, offset) {
  return formatHotelLocalDate(addHotelLocalDays(hotelLocalToday(now), offset));
}

function assertConflict(error, label) {
  assert.ok(error instanceof HotelApiError, `${label}: expected HotelApiError`);
  assert.equal(error.code, HOTEL_ERROR_CODES.CONFLICT, `${label}: expected CONFLICT`);
  assert.equal(error.status, 409, `${label}: expected status 409`);
}

function integrationTest(name, fn) {
  test(name, async (t) => {
    try {
      await fn(t);
    } catch (error) {
      if (error?.name === "AssertionError") throw error;
      if (
        error instanceof HotelIntegrationHarnessError ||
        error instanceof HotelIntegrationGuardError
      ) {
        throw error;
      }

      const safe = safeHotelIntegrationError(error, {
        secrets: [
          config?.mongoUri,
          manager?.password,
          receptionist?.password,
        ].filter(Boolean),
      });
      throw new HotelIntegrationHarnessError(
        safe.code,
        `${name}: ${safe.message}`
      );
    }
  });
}

async function createIntegrationUser(role, kind) {
  const HotelUser = getHotelUserModel(connection);
  const email = fixtures.guestEmail(kind, nextFixtureIndex());
  const user = await HotelUser.create({
    email,
    name: `${fixtures.runTag} ${role} ${kind}`,
    role,
    isActive: true,
  });

  return {
    id: String(user._id),
    email,
    role,
  };
}

async function createRoomTypeFixture(kind, baseNightlyRate = 500) {
  const { roomType } = await createRoomType({
    connection,
    input: {
      name: `Integration ${fixtures.runTag} ${kind}`,
      code: fixtures.roomTypeCode(kind),
      description: "Disposable integration fixture",
      capacity: 2,
      baseNightlyRate,
      amenities: ["Wi-Fi"],
    },
    actor: manager.actor,
  });
  return roomType;
}

async function createRoomFixture(kind, roomTypeId) {
  const { room } = await createRoom({
    connection,
    input: {
      roomNumber: fixtures.roomNumber(nextFixtureIndex()),
      floor: 1,
      roomTypeId,
      capacity: 2,
      amenities: ["Wi-Fi"],
    },
    actor: manager.actor,
  });
  return room;
}

async function createGuestFixture(kind) {
  const index = nextFixtureIndex();
  const { guest } = await createGuest({
    connection,
    input: {
      firstName: fixtures.firstName(kind),
      lastName: fixtures.lastName(index),
      phone: fixtures.guestPhone(index),
      email: fixtures.guestEmail(kind, index),
      nationality: "ET",
      idType: "PASSPORT",
      idNumber: `IT-${fixtures.runTag}-${index}`,
    },
    actor: manager.actor,
  });
  return guest;
}

async function createReservationFixture({
  roomTypeId,
  roomId,
  guestId,
  arrivalOffset = 0,
  departureOffset = 1,
  now = Date.now(),
}) {
  const { reservation } = await createReservation({
    connection,
    input: {
      guestId,
      roomTypeId,
      roomId,
      arrivalDate: localDate(now, arrivalOffset),
      departureDate: localDate(now, departureOffset),
      adults: 1,
      notes: fixtures.note("RESERVATION"),
    },
    actor: manager.actor,
    now,
  });
  return reservation;
}

async function createCheckedOutStay(kind, baseNightlyRate = 500) {
  const roomType = await createRoomTypeFixture(kind, baseNightlyRate);
  const room = await createRoomFixture(kind, roomType.id);
  const guest = await createGuestFixture(kind);
  const now = Date.now();
  const reservation = await createReservationFixture({
    roomTypeId: roomType.id,
    roomId: room.id,
    guestId: guest.id,
    arrivalOffset: 0,
    departureOffset: 1,
    now,
  });
  const checkedIn = await checkInReservation({
    connection,
    id: reservation.id,
    input: { note: fixtures.note("CHECKIN") },
    actor: receptionist.actor,
    now,
  });
  const checkedOut = await checkOutStay({
    connection,
    id: checkedIn.stay.id,
    input: { note: fixtures.note("CHECKOUT") },
    actor: receptionist.actor,
    now: now + 60_000,
  });
  const { folio } = await getStayFolio({
    connection,
    stayId: checkedIn.stay.id,
  });

  return {
    roomType,
    room,
    guest,
    reservation,
    stay: checkedOut.stay,
    checkedIn,
    checkedOut,
    folio,
  };
}

function integrationModels() {
  return [
    getHotelAuditLogModel(connection),
    getHotelPaymentModel(connection),
    getHotelSessionModel(connection),
    getHotelUserModel(connection),
    getGuestModel(connection),
    getReservationModel(connection),
    getRoomModel(connection),
    getRoomBookingLockModel(connection),
    getStayModel(connection),
    getRoomTypeModel(connection),
  ];
}

async function countStays(reservationId) {
  return getStayModel(connection).countDocuments({ reservationId });
}

async function countPayments(stayId) {
  return getHotelPaymentModel(connection).countDocuments({ stayId });
}

async function listCustomIndexes(models) {
  const custom = [];
  for (const model of models) {
    let indexes;
    try {
      indexes = await model.collection.indexes();
    } catch (error) {
      if (error?.code === 26 || error?.codeName === "NamespaceNotFound") {
        indexes = [];
      } else {
        throw error;
      }
    }
    for (const index of indexes) {
      if (index?.name && index.name !== "_id_") {
        custom.push(`${model.collection.name}.${index.name}`);
      }
    }
  }
  return custom;
}

before(async () => {
  if (!optIn.requested) return;

  assertNoCachedHotelConnection();
  const options = readHotelIntegrationHarnessOptions(process.env);
  config = options.config;
  waitForIndexes = options.waitForIndexes;
  runId = createHotelIntegrationRunId();
  runtime = installHotelIntegrationRuntimeEnvironment({ config });

  try {
    connection = await connectToHotelDatabase();
  } catch (error) {
    const safe = safeHotelIntegrationError(error, {
      secrets: [config.mongoUri],
    });
    throw new HotelIntegrationHarnessError(
      "CONNECT_FAILED",
      `${safe.code}: ${safe.message}`
    );
  }

  await verifyHotelIntegrationConnection({
    connection,
    expectedTarget: config.target,
  });
  ownership = await claimHotelIntegrationTarget({
    connection,
    expectedTarget: config.target,
    runId,
  });

  // Readiness must be confirmed before the first in-database fixture. The wait
  // is read-only. On failure or timeout, the thrown error aborts this before
  // hook; the ownership marker and any existing data are retained because this
  // file never runs cleanup.
  if (waitForIndexes) {
    preflightIndexReadiness = await waitForHotelIndexes({
      connection,
      models: integrationModels(),
      timeoutMs: 120_000,
    });
  }

  fixtures = createHotelIntegrationFixtures(runId);

  const managerUser = await createIntegrationUser("MANAGER", "MGR");
  manager = {
    ...managerUser,
    actor: { id: managerUser.id, role: managerUser.role },
  };

  const receptionistUser = await createIntegrationUser("RECEPTIONIST", "REC");
  receptionist = {
    ...receptionistUser,
    actor: { id: receptionistUser.id, role: receptionistUser.role },
  };
});

after(async () => {
  try {
    if (connection) await disconnectHotelDatabase();
  } finally {
    if (runtime) runtime.restore();
  }
});

describe(
  "Hotel disposable-MongoDB integration",
  { skip: optIn.requested ? false : optIn.reason },
  () => {
    integrationTest(
      "preflight claims a fresh loopback target and retains ownership",
      async () => {
        assert.equal(config.target.databaseName, HOTEL_DB_NAME);
        assert.ok(
          config.target.host === "127.0.0.1" ||
            config.target.host === "::1"
        );
        assert.notEqual(config.target.port, 27017);
        assert.equal(connection.name, HOTEL_DB_NAME);
        assert.equal(connection.readyState, 1);

        const verified = await verifyHotelIntegrationOwnership({
          connection,
          expectedTarget: config.target,
          ownership,
        });
        assert.equal(verified.owned, true);

        const marker = await readHotelIntegrationOwnershipMarker({
          connection,
          expectedTarget: config.target,
        });
        assert.equal(marker.runId, runId);
        assert.equal(marker.tokenHash.length, 64);
        assert.equal(
          marker.collectionName,
          "hotel_integration_run_ownership"
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(marker, "token"),
          false
        );
      }
    );

    integrationTest(
      "creates run-scoped room type, room, and guest fixtures",
      async () => {
        const roomType = await createRoomTypeFixture("FIX", 450);
        const room = await createRoomFixture("FIX", roomType.id);
        const guest = await createGuestFixture("FIX");

        assert.match(roomType.code, new RegExp(`^IT${fixtures.runTag}`));
        assert.match(room.roomNumber, new RegExp(`^IT${fixtures.runTag}`));
        assert.match(
          guest.email,
          new RegExp(`^it\\.${fixtures.runTag.toLowerCase()}`)
        );
        assert.match(guest.phone, /^\+2519[0-9]{8}$/);
        assert.equal(room.roomTypeId, roomType.id);
        assert.equal(guest.isActive, true);
      }
    );

    integrationTest(
      "serializes overlapping reservations and uses half-open intervals",
      async () => {
        const roomType = await createRoomTypeFixture("RSV", 500);
        const room = await createRoomFixture("RSV", roomType.id);
        const guest = await createGuestFixture("RSV");
        const now = Date.now();
        const input = (arrivalOffset, departureOffset) => ({
          guestId: guest.id,
          roomTypeId: roomType.id,
          roomId: room.id,
          arrivalDate: localDate(now, arrivalOffset),
          departureDate: localDate(now, departureOffset),
          adults: 1,
        });

        const results = await Promise.allSettled([
          createReservation({
            connection,
            input: input(10, 12),
            actor: manager.actor,
            now,
          }),
          createReservation({
            connection,
            input: input(10, 12),
            actor: manager.actor,
            now,
          }),
        ]);

        const winners = results.filter(
          (result) => result.status === "fulfilled"
        );
        const losers = results.filter(
          (result) => result.status === "rejected"
        );
        assert.equal(winners.length, 1);
        assert.equal(losers.length, 1);
        assertConflict(losers[0].reason, "concurrent reservation");

        const winner = winners[0].value.reservation;
        const adjacent = (
          await createReservation({
            connection,
            input: input(12, 14),
            actor: manager.actor,
            now,
          })
        ).reservation;
        assert.equal(adjacent.status, "CONFIRMED");

        await assert.rejects(
          () =>
            createReservation({
              connection,
              input: input(11, 13),
              actor: manager.actor,
              now,
            }),
          (error) => {
            assertConflict(error, "overlapping reservation");
            return true;
          }
        );

        await cancelReservation({
          connection,
          id: winner.id,
          input: { reason: fixtures.note("CANCEL") },
          actor: manager.actor,
          now,
        });

        const replacement = (
          await createReservation({
            connection,
            input: input(10, 12),
            actor: manager.actor,
            now,
          })
        ).reservation;
        assert.equal(replacement.status, "CONFIRMED");
        assert.notEqual(winner.reservationNumber, adjacent.reservationNumber);
        assert.notEqual(
          winner.reservationNumber,
          replacement.reservationNumber
        );
      }
    );

    integrationTest(
      "recovers an expired per-room booking lock",
      async () => {
        const roomType = await createRoomTypeFixture("LOCK", 500);
        const room = await createRoomFixture("LOCK", roomType.id);
        const guest = await createGuestFixture("LOCK");
        const Lock = getRoomBookingLockModel(connection);

        await Lock.create({
          _id: String(room.id),
          owner: "crashed-integration-run",
          expiresAt: new Date(Date.now() - 60_000),
        });

        const now = Date.now();
        const reservation = (
          await createReservation({
            connection,
            input: {
              guestId: guest.id,
              roomTypeId: roomType.id,
              roomId: room.id,
              arrivalDate: localDate(now, 20),
              departureDate: localDate(now, 22),
              adults: 1,
            },
            actor: manager.actor,
            now,
          })
        ).reservation;

        assert.equal(reservation.status, "CONFIRMED");
        assert.equal(await Lock.findById(String(room.id)).lean(), null);
      }
    );

    integrationTest(
      "recovers and replays check-in and check-out without duplicate stays",
      async () => {
        const roomType = await createRoomTypeFixture("STAY", 500);
        const room = await createRoomFixture("STAY", roomType.id);
        const guest = await createGuestFixture("STAY");
        const now = Date.now();
        const reservation = await createReservationFixture({
          roomTypeId: roomType.id,
          roomId: room.id,
          guestId: guest.id,
          arrivalOffset: 0,
          departureOffset: 1,
          now,
        });

        const checkedIn = await checkInReservation({
          connection,
          id: reservation.id,
          input: { note: fixtures.note("CHECKIN") },
          actor: receptionist.actor,
          now,
        });
        assert.equal(checkedIn.changed, true);
        assert.equal(checkedIn.stay.status, "IN_HOUSE");
        assert.equal(checkedIn.reservation.status, "CHECKED_IN");
        assert.equal(checkedIn.roomStatus, "OCCUPIED");

        const replay = await checkInReservation({
          connection,
          id: reservation.id,
          input: { note: fixtures.note("CHECKIN-REPLAY") },
          actor: receptionist.actor,
          now,
        });
        assert.equal(replay.changed, false);
        assert.equal(replay.stay.id, checkedIn.stay.id);
        assert.equal(await countStays(reservation.id), 1);

        // Simulate a partial check-in write: the stay and room were written,
        // but the reservation transition was not committed.
        await getReservationModel(connection).updateOne(
          { _id: reservation.id },
          { $set: { status: "CONFIRMED", checkedInAt: null, stayId: null } }
        );
        await getRoomModel(connection).updateOne(
          { _id: room.id },
          { $set: { operationalStatus: "AVAILABLE" } }
        );

        const repaired = await checkInReservation({
          connection,
          id: reservation.id,
          input: { note: fixtures.note("CHECKIN-REPAIR") },
          actor: receptionist.actor,
          now,
        });
        assert.equal(repaired.changed, true);
        assert.equal(repaired.stay.id, checkedIn.stay.id);
        assert.equal(repaired.reservation.status, "CHECKED_IN");
        assert.equal(repaired.roomStatus, "OCCUPIED");

        const checkOutNow = now + 60_000;
        const checkedOut = await checkOutStay({
          connection,
          id: checkedIn.stay.id,
          input: { note: fixtures.note("CHECKOUT") },
          actor: receptionist.actor,
          now: checkOutNow,
        });
        assert.equal(checkedOut.changed, true);
        assert.equal(checkedOut.stay.status, "CHECKED_OUT");
        assert.equal(checkedOut.reservation.status, "CHECKED_OUT");
        assert.equal(checkedOut.roomStatus, "CLEANING");
        assert.notEqual(checkedOut.stay.totalCharges, null);
        assert.equal(await countStays(reservation.id), 1);

        const replayOut = await checkOutStay({
          connection,
          id: checkedIn.stay.id,
          input: { note: fixtures.note("CHECKOUT-REPLAY") },
          actor: receptionist.actor,
          now: checkOutNow + 1000,
        });
        assert.equal(replayOut.changed, false);
        assert.equal(replayOut.roomStatus, "CLEANING");
        assert.equal(replayOut.stay.id, checkedOut.stay.id);

        // Simulate a partial check-out write: the stay is final, but the
        // reservation and room updates were not committed.
        await getReservationModel(connection).updateOne(
          { _id: reservation.id },
          { $set: { status: "CHECKED_IN", checkedOutAt: null } }
        );
        await getRoomModel(connection).updateOne(
          { _id: room.id },
          { $set: { operationalStatus: "OCCUPIED" } }
        );

        const repairedOut = await checkOutStay({
          connection,
          id: checkedIn.stay.id,
          input: { note: fixtures.note("CHECKOUT-REPAIR") },
          actor: receptionist.actor,
          now: checkOutNow + 2000,
        });
        assert.equal(repairedOut.changed, true);
        assert.equal(repairedOut.reservation.status, "CHECKED_OUT");
        assert.equal(repairedOut.roomStatus, "CLEANING");
        assert.notEqual(repairedOut.roomStatus, "AVAILABLE");
        assert.equal(await countStays(reservation.id), 1);
      }
    );

    integrationTest(
      "records and replays payments with folio recalculation",
      async () => {
        const context = await createCheckedOutStay("PAY", 600);
        assert.equal(context.folio.available, true);
        assert.equal(context.folio.finalized, true);
        assert.equal(
          context.folio.outstandingBalanceMinor,
          context.folio.totalChargesMinor
        );
        assert.equal(context.folio.canRecordPayment, true);

        const amount = context.folio.outstandingBalance;
        const idempotencyKey = fixtures.idempotencyKey(
          "PAY",
          nextFixtureIndex()
        );
        const input = {
          amount,
          method: "CASH",
          idempotencyKey,
        };

        const first = await recordStayPayment({
          connection,
          stayId: context.stay.id,
          input,
          actor: receptionist.actor,
        });
        assert.equal(first.created, true);
        assert.equal(first.changed, true);
        assert.equal(first.payment.status, "RECORDED");
        assert.equal(first.folio.outstandingBalanceMinor, 0);

        const replay = await recordStayPayment({
          connection,
          stayId: context.stay.id,
          input,
          actor: receptionist.actor,
        });
        assert.equal(replay.created, false);
        assert.equal(replay.replayed, true);
        assert.equal(replay.changed, false);
        assert.equal(replay.payment.id, first.payment.id);
        assert.equal(await countPayments(context.stay.id), 1);

        await assert.rejects(
          () =>
            recordStayPayment({
              connection,
              stayId: context.stay.id,
              input: { ...input, amount: "1.00" },
              actor: receptionist.actor,
            }),
          (error) => {
            assertConflict(error, "idempotency key conflict");
            return true;
          }
        );
      }
    );

    integrationTest(
      "serializes concurrent payments and rejects overpayment",
      async () => {
        const context = await createCheckedOutStay("PAYC", 700);
        const amount = context.folio.outstandingBalance;
        const keyA = fixtures.idempotencyKey("PAYCA", nextFixtureIndex());
        const keyB = fixtures.idempotencyKey("PAYCB", nextFixtureIndex());

        const results = await Promise.allSettled([
          recordStayPayment({
            connection,
            stayId: context.stay.id,
            input: { amount, method: "CARD", idempotencyKey: keyA },
            actor: receptionist.actor,
          }),
          recordStayPayment({
            connection,
            stayId: context.stay.id,
            input: { amount, method: "CARD", idempotencyKey: keyB },
            actor: receptionist.actor,
          }),
        ]);

        const winners = results.filter(
          (result) => result.status === "fulfilled"
        );
        const losers = results.filter(
          (result) => result.status === "rejected"
        );
        assert.equal(winners.length, 1);
        assert.equal(losers.length, 1);
        assertConflict(losers[0].reason, "concurrent payment");

        const losingKey = results[0].status === "rejected" ? keyA : keyB;
        await assert.rejects(
          () =>
            recordStayPayment({
              connection,
              stayId: context.stay.id,
              input: {
                amount,
                method: "CARD",
                idempotencyKey: losingKey,
              },
              actor: receptionist.actor,
            }),
          (error) => {
            assertConflict(error, "overpayment");
            return true;
          }
        );

        assert.equal(await countPayments(context.stay.id), 1);
        const { folio } = await getStayFolio({
          connection,
          stayId: context.stay.id,
        });
        assert.equal(folio.outstandingBalanceMinor, 0);
      }
    );

    integrationTest(
      "voids payments non-destructively and recalculates the folio",
      async () => {
        const context = await createCheckedOutStay("VOID", 800);
        const amount = context.folio.outstandingBalance;
        const idempotencyKey = fixtures.idempotencyKey(
          "VOID",
          nextFixtureIndex()
        );

        const recorded = await recordStayPayment({
          connection,
          stayId: context.stay.id,
          input: { amount, method: "BANK_TRANSFER", idempotencyKey },
          actor: receptionist.actor,
        });

        const voided = await voidHotelPayment({
          connection,
          paymentId: recorded.payment.id,
          input: { reason: fixtures.note("VOID") },
          actor: manager.actor,
        });
        assert.equal(voided.changed, true);
        assert.equal(voided.payment.status, "VOIDED");
        assert.equal(
          voided.folio.outstandingBalanceMinor,
          context.folio.totalChargesMinor
        );

        const replay = await voidHotelPayment({
          connection,
          paymentId: recorded.payment.id,
          input: { reason: fixtures.note("VOID-REPLAY") },
          actor: manager.actor,
        });
        assert.equal(replay.changed, false);
        assert.equal(replay.replayed, true);
        assert.equal(replay.payment.status, "VOIDED");

        const replacement = await recordStayPayment({
          connection,
          stayId: context.stay.id,
          input: {
            amount,
            method: "CASH",
            idempotencyKey: fixtures.idempotencyKey(
              "VOIDR",
              nextFixtureIndex()
            ),
          },
          actor: receptionist.actor,
        });
        assert.equal(replacement.created, true);
        assert.equal(replacement.folio.outstandingBalanceMinor, 0);
        assert.equal(await countPayments(context.stay.id), 2);
      }
    );

    integrationTest(
      "compiles the payment model on a cold folio read",
      async () => {
        const context = await createCheckedOutStay("COLD", 900);

        // Ensure the model exists, then remove it from this connection to
        // prove the folio path recompiles it rather than relying on test order.
        getHotelPaymentModel(connection);
        connection.deleteModel("HotelPayment");

        const { folio } = await getStayFolio({
          connection,
          stayId: context.stay.id,
        });
        assert.equal(folio.available, true);
        assert.equal(folio.finalized, true);
        assert.equal(
          folio.totalChargesMinor,
          context.folio.totalChargesMinor
        );
        assert.ok(getHotelPaymentModel(connection));
      }
    );


    integrationTest(
      "reports post-run index readiness without waiting or deploying indexes",
      async (t) => {
        const models = integrationModels();
        const readiness = await inspectHotelIndexReadiness({
          connection,
          models,
        });
        assert.equal(readiness.checkedCollections.length, 10);
        assert.ok(readiness.expectedCount > 0);

        if (waitForIndexes) {
          // This is a post-run observation only. Readiness was already
          // confirmed by the before hook before the first fixture user existed.
          assert.notEqual(preflightIndexReadiness, null);
          assert.equal(preflightIndexReadiness.ready, true);
          assert.equal(readiness.ready, true);
          assert.equal(readiness.missing.length, 0);
          assert.equal(readiness.issues.length, 0);
          t.diagnostic(
            `Index readiness was confirmed before fixture creation for ${preflightIndexReadiness.expectedCount} indexes across ${preflightIndexReadiness.checkedCollections.length} collections; this post-run check did not wait.`
          );
          return;
        }

        const custom = await listCustomIndexes(models);
        assert.deepEqual(custom, []);
        t.diagnostic(
          "Index readiness was not requested or required; the harness created no custom indexes and did not wait for indexes."
        );
      }
    );

    integrationTest(
      "retains the ownership marker for the separate cleanup command",
      async () => {
        const marker = await readHotelIntegrationOwnershipMarker({
          connection,
          expectedTarget: config.target,
        });
        assert.equal(marker.runId, runId);

        const verified = await verifyHotelIntegrationOwnership({
          connection,
          expectedTarget: config.target,
          ownership,
        });
        assert.equal(verified.owned, true);
      }
    );
  }
);
