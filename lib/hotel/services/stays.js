import {
  HOTEL_ACTIVE_RESERVATION_STATUSES,
  HOTEL_ACTIVE_STAY_STATUSES,
  HOTEL_STAY_CHARGE_RULE,
  HOTEL_STAY_STATUSES,
  HOTEL_STAY_TRANSITIONS,
} from "../constants.js";
import {
  HOTEL_AUDIT_ACTIONS,
  safeRecordHotelAudit,
} from "../audit.js";
import {
  addHotelLocalDays,
  formatHotelLocalDate,
  getHotelStayNights,
  hotelLocalToday,
  parseHotelLocalDate,
} from "../dates.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
  HotelValidationError,
} from "../errors.js";
import { getGuestModel, toSafeHotelGuestSummary } from "../models/guest.js";
import { getReservationModel } from "../models/reservation.js";
import { getRoomModel } from "../models/room.js";
import { getRoomTypeModel } from "../models/roomType.js";
import {
  getStayModel,
  toSafeHotelStay,
  toSafeHotelStaySummary,
} from "../models/stay.js";
import {
  validateCheckInPayload,
  validateCheckOutPayload,
  validateObjectIdString,
} from "../validation.js";
import { withHotelRoomBookingLocks } from "./bookingLocks.js";
import { findHotelGuest } from "./guests.js";
import {
  assertReservationTransition,
  getReservation,
} from "./reservations.js";
import {
  getHotelStayPaymentSummary,
  unavailableHotelStayPaymentSummary,
} from "./stayPayments.js";

// Hotel Stay service.
//
// Check-in and check-out coordinate three documents without assuming MongoDB
// transactions are available:
//
// 1. The reservation transition is the single-winner gate. A conditional
//    update on `{ _id, status: "CONFIRMED", updatedAt }` means only one request
//    can move a reservation into CHECKED_IN.
// 2. A Stay is created once per reservation. The unique reservationId index is
//    the durable backstop; the service also checks first and retries a duplicate
//    by loading the existing stay.
// 3. The room status is changed with a conditional update and an appended
//    status-history entry.
//
// If a later step fails, the earlier state is retained and a retry completes the
// missing step. This is deliberate: no multi-document transaction is assumed,
// and no stay or financial history is deleted. Check-in and check-out are
// idempotent for an already-completed stay.
//
// Check-out charges use the immutable stay rate snapshot and Addis civil dates
// crossed, with a one-night minimum. The reservation's historical pricing is
// never recalculated.

function notFound(message = "Stay not found") {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.NOT_FOUND,
    message,
    status: 404,
    expose: true,
  });
}

function conflict(message, field = null) {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.CONFLICT,
    message,
    status: 409,
    expose: true,
    details: field ? { field } : null,
  });
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function asDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateTime(value) {
  const date = asDate(value);
  return date ? date.getTime() : null;
}

async function audit(connection, event) {
  await safeRecordHotelAudit(connection, event);
}

export function canTransitionStay(fromStatus, toStatus) {
  const allowed = HOTEL_STAY_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

export function assertStayTransition(fromStatus, toStatus) {
  if (!canTransitionStay(fromStatus, toStatus)) {
    throw conflict(
      `Stay cannot transition from ${fromStatus} to ${toStatus}`,
      "status"
    );
  }
  return true;
}

export function calculateHotelStayCharges({
  nightlyRate,
  checkedInAt,
  checkedOutAt,
} = {}) {
  const rate = Number(nightlyRate);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new HotelValidationError({
      nightlyRate: "nightlyRate must be a non-negative number",
    });
  }

  const checkIn = asDate(checkedInAt);
  const checkOut = asDate(checkedOutAt);
  if (!checkIn) {
    throw new HotelValidationError({
      checkedInAt: "checkedInAt must be a valid date",
    });
  }
  if (!checkOut) {
    throw new HotelValidationError({
      checkedOutAt: "checkedOutAt must be a valid date",
    });
  }
  if (checkOut.getTime() < checkIn.getTime()) {
    throw new HotelValidationError({
      checkedOutAt: "checkedOutAt must be on or after checkedInAt",
    });
  }

  const checkInLocalDate = formatHotelLocalDate(checkIn);
  const checkOutLocalDate = formatHotelLocalDate(checkOut);
  const crossedNights = getHotelStayNights(
    parseHotelLocalDate(checkInLocalDate),
    parseHotelLocalDate(checkOutLocalDate)
  );
  const billableNights = Math.max(1, crossedNights);
  const roomCharges = roundMoney(rate * billableNights);

  return {
    billableNights,
    nightlyRate: roundMoney(rate),
    roomCharges,
    totalCharges: roomCharges,
    chargeRule: HOTEL_STAY_CHARGE_RULE,
    checkInLocalDate,
    checkOutLocalDate,
  };
}

async function findReservation(connection, id) {
  const normalizedId = validateObjectIdString(id, "id");
  const Reservation = getReservationModel(connection);
  const reservation = await Reservation.findById(normalizedId).lean();
  if (!reservation) throw notFound("Reservation not found");
  return reservation;
}

async function findStay(connection, id) {
  const normalizedId = validateObjectIdString(id, "id");
  const Stay = getStayModel(connection);
  const stay = await Stay.findById(normalizedId).lean();
  if (!stay) throw notFound();
  return stay;
}

async function findStayByReservation(connection, reservationId) {
  const Stay = getStayModel(connection);
  return Stay.findOne({ reservationId }).lean();
}

async function findRoom(connection, id) {
  const Room = getRoomModel(connection);
  return Room.findById(id).lean();
}

async function assertNoOverlappingActiveReservation(
  connection,
  reservation,
  roomId
) {
  const Reservation = getReservationModel(connection);
  const overlap = await Reservation.findOne({
    _id: { $ne: reservation._id },
    roomId,
    status: { $in: HOTEL_ACTIVE_RESERVATION_STATUSES },
    arrivalDate: { $lt: reservation.departureDate },
    departureDate: { $gt: reservation.arrivalDate },
  })
    .select("_id reservationNumber status")
    .lean();

  if (overlap) {
    throw conflict(
      "Room has another active reservation for these dates",
      "roomId"
    );
  }
}

function assertCheckInWindow(reservation, now) {
  const arrivalLocalDate = formatHotelLocalDate(reservation.arrivalDate);
  const departureLocalDate = formatHotelLocalDate(reservation.departureDate);
  const today = hotelLocalToday(now);

  if (today < arrivalLocalDate) {
    throw conflict(
      "Reservation cannot be checked in before its arrival date",
      "arrivalDate"
    );
  }
  if (today >= departureLocalDate) {
    throw conflict(
      "Reservation departure date has passed; check-in is no longer allowed",
      "departureDate"
    );
  }

  return { arrivalLocalDate, departureLocalDate, today };
}

async function assertRoomReadyForCheckIn(
  connection,
  reservation,
  roomId,
  { allowOccupied = false, checkOverlappingReservations = true } = {}
) {
  const room = await findRoom(connection, roomId);
  if (!room) {
    throw conflict(
      "The reservation's assigned room no longer exists",
      "roomId"
    );
  }
  if (room.isActive !== true) {
    throw conflict("The reservation's assigned room is inactive", "roomId");
  }
  if (String(room.roomTypeId) !== String(reservation.roomTypeId)) {
    throw conflict(
      "The assigned room does not belong to the reservation's room type",
      "roomId"
    );
  }

  const guestCount = Number(reservation.adults) + Number(reservation.children ?? 0);
  if (!Number.isInteger(guestCount) || guestCount > Number(room.capacity)) {
    throw conflict(
      `The reservation party no longer fits the room capacity of ${room.capacity}`,
      "roomId"
    );
  }

  if (room.operationalStatus === "OCCUPIED") {
    if (!allowOccupied) {
      throw conflict("Room is already occupied", "roomId");
    }
  } else if (!["AVAILABLE", "RESERVED"].includes(room.operationalStatus)) {
    throw conflict(
      `Room is ${room.operationalStatus} and cannot be checked in`,
      "roomId"
    );
  }

  const Stay = getStayModel(connection);
  const activeStay = await Stay.findOne({
    roomId: room._id,
    status: { $in: HOTEL_ACTIVE_STAY_STATUSES },
  })
    .select("_id reservationId status")
    .lean();

  if (
    activeStay &&
    String(activeStay.reservationId) !== String(reservation._id)
  ) {
    throw conflict(
      "Room is already occupied by another active stay",
      "roomId"
    );
  }

  if (checkOverlappingReservations) {
    await assertNoOverlappingActiveReservation(
      connection,
      reservation,
      room._id
    );
  }

  return room;
}

function stayDocumentFor({ reservation, room, checkedInAt, checkedInBy, note }) {
  const changedAt = asDate(checkedInAt) ?? new Date();
  return {
    reservationId: reservation._id,
    reservationNumber: reservation.reservationNumber,
    guestId: reservation.guestId,
    guestSnapshot: {
      firstName: reservation.guestSnapshot?.firstName ?? "",
      lastName: reservation.guestSnapshot?.lastName ?? "",
      fullName:
        reservation.guestSnapshot?.fullName ??
        `${reservation.guestSnapshot?.firstName ?? ""} ${
          reservation.guestSnapshot?.lastName ?? ""
        }`.trim(),
      phone: reservation.guestSnapshot?.phone ?? "",
      email: reservation.guestSnapshot?.email ?? null,
    },
    roomTypeId: reservation.roomTypeId,
    roomTypeSnapshot: {
      name: reservation.roomTypeSnapshot?.name ?? "",
      code: reservation.roomTypeSnapshot?.code ?? "",
      capacity: reservation.roomTypeSnapshot?.capacity ?? room.capacity,
      baseNightlyRate:
        reservation.roomTypeSnapshot?.baseNightlyRate ??
        reservation.nightlyRate,
    },
    roomId: room._id,
    roomSnapshot: {
      roomNumber: room.roomNumber,
      floor: room.floor,
    },
    arrivalDate: reservation.arrivalDate,
    departureDate: reservation.departureDate,
    reservationNights: reservation.nights,
    adults: reservation.adults,
    children: reservation.children ?? 0,
    nightlyRate: reservation.nightlyRate,
    rateSource: reservation.rateSource,
    reservationTotalAmount: reservation.totalAmount,
    notes: reservation.notes ?? "",
    expectedCheckOutAt: reservation.departureDate,
    status: "IN_HOUSE",
    checkedInAt: changedAt,
    checkedInBy: checkedInBy ?? null,
    checkInNote: note ?? "",
    statusHistory: [
      {
        status: "IN_HOUSE",
        previousStatus: null,
        changedAt,
        changedBy: checkedInBy ?? null,
        note: note ?? "",
      },
    ],
  };
}

async function transitionReservationToCheckedIn({
  connection,
  reservation,
  checkedInAt,
  actor,
  note,
}) {
  const Reservation = getReservationModel(connection);
  const filter = { _id: reservation._id, status: "CONFIRMED" };
  if (reservation.updatedAt) filter.updatedAt = reservation.updatedAt;

  const result = await Reservation.updateOne(
    filter,
    {
      $set: {
        status: "CHECKED_IN",
        checkedInAt,
        checkedInBy: actor?.id ?? null,
        stayId: null,
        updatedBy: actor?.id ?? null,
      },
      $push: {
        statusHistory: {
          status: "CHECKED_IN",
          previousStatus: "CONFIRMED",
          changedAt: checkedInAt,
          changedBy: actor?.id ?? null,
          note: note ?? "",
        },
      },
    },
    { runValidators: true }
  );

  if (!result?.modifiedCount) {
    throw conflict(
      "Reservation is no longer CONFIRMED; reload and retry",
      "status"
    );
  }
  return findReservation(connection, reservation._id);
}

async function linkReservationStay({
  connection,
  reservation,
  stay,
  actor,
}) {
  const Reservation = getReservationModel(connection);
  await Reservation.updateOne(
    { _id: reservation._id, status: "CHECKED_IN" },
    {
      $set: {
        stayId: stay._id,
        updatedBy: actor?.id ?? null,
      },
    },
    { runValidators: true }
  );

  const current = await findReservation(connection, reservation._id);
  if (String(current.stayId ?? "") !== String(stay._id)) {
    throw conflict(
      "Could not link the stay to the reservation; retry check-in",
      "stayId"
    );
  }
  return current;
}

async function ensureRoomOccupied({
  connection,
  room,
  actor,
  now,
  note,
}) {
  if (room.operationalStatus === "OCCUPIED") {
    return { room, changed: false, previousStatus: "OCCUPIED" };
  }
  if (!["AVAILABLE", "RESERVED"].includes(room.operationalStatus)) {
    throw conflict(
      `Room is ${room.operationalStatus} and cannot be occupied`,
      "roomId"
    );
  }

  const Room = getRoomModel(connection);
  const changedAt = new Date(now);
  const entry = {
    status: "OCCUPIED",
    previousStatus: room.operationalStatus,
    changedAt,
    changedBy: actor?.id ?? null,
    note: note ?? "",
  };
  const result = await Room.updateOne(
    {
      _id: room._id,
      isActive: true,
      operationalStatus: room.operationalStatus,
    },
    {
      $set: { operationalStatus: "OCCUPIED" },
      $push: { statusHistory: entry },
    },
    { runValidators: true }
  );

  if (!result?.modifiedCount) {
    const current = await findRoom(connection, room._id);
    if (current?.operationalStatus === "OCCUPIED") {
      return {
        room: current,
        changed: false,
        previousStatus: room.operationalStatus,
      };
    }
    throw conflict(
      "Room status changed during check-in; reload and retry",
      "roomId"
    );
  }

  return {
    room: await findRoom(connection, room._id),
    changed: true,
    previousStatus: room.operationalStatus,
  };
}

async function ensureRoomCleaning({
  connection,
  roomId,
  actor,
  now,
  note,
  repairOnly = false,
}) {
  const room = await findRoom(connection, roomId);
  if (!room) {
    throw conflict("The stay's room no longer exists", "roomId");
  }
  if (room.operationalStatus === "CLEANING") {
    return { room, changed: false, previousStatus: "CLEANING" };
  }
  if (room.operationalStatus === "OUT_OF_SERVICE") {
    // Never make a room available, and do not override an out-of-service
    // decision. The room remains unavailable until housekeeping/maintenance
    // explicitly releases it.
    return { room, changed: false, previousStatus: "OUT_OF_SERVICE" };
  }
  if (repairOnly && room.operationalStatus !== "OCCUPIED") {
    // A retry must not undo housekeeping or a later manual decision. Only an
    // occupied room proves the original check-out did not reach the room step.
    return { room, changed: false, previousStatus: room.operationalStatus };
  }

  const Room = getRoomModel(connection);
  const changedAt = new Date(now);
  const entry = {
    status: "CLEANING",
    previousStatus: room.operationalStatus,
    changedAt,
    changedBy: actor?.id ?? null,
    note: note ?? "",
  };
  const result = await Room.updateOne(
    { _id: room._id, operationalStatus: room.operationalStatus },
    {
      $set: { operationalStatus: "CLEANING" },
      $push: { statusHistory: entry },
    },
    { runValidators: true }
  );

  if (!result?.modifiedCount) {
    const current = await findRoom(connection, room._id);
    if (current?.operationalStatus === "CLEANING") {
      return {
        room: current,
        changed: false,
        previousStatus: room.operationalStatus,
      };
    }
    throw conflict(
      "Room status changed during check-out; reload and retry",
      "roomId"
    );
  }

  return {
    room: await findRoom(connection, room._id),
    changed: true,
    previousStatus: room.operationalStatus,
  };
}

async function transitionReservationToCheckedOut({
  connection,
  reservation,
  stay,
  actor,
}) {
  if (reservation.status === "CHECKED_OUT") return reservation;
  if (reservation.status !== "CHECKED_IN") {
    throw conflict(
      `A ${reservation.status} reservation cannot be checked out`,
      "status"
    );
  }

  const checkedOutAt =
    asDate(stay.checkedOutAt) ?? new Date();
  const checkedOutBy = stay.checkedOutBy ?? actor?.id ?? null;
  const note = stay.checkOutNote ?? "";
  const Reservation = getReservationModel(connection);
  const filter = { _id: reservation._id, status: "CHECKED_IN" };
  if (reservation.updatedAt) filter.updatedAt = reservation.updatedAt;

  const result = await Reservation.updateOne(
    filter,
    {
      $set: {
        status: "CHECKED_OUT",
        checkedOutAt,
        checkedOutBy,
        updatedBy: actor?.id ?? null,
      },
      $push: {
        statusHistory: {
          status: "CHECKED_OUT",
          previousStatus: "CHECKED_IN",
          changedAt: checkedOutAt,
          changedBy: checkedOutBy,
          note,
        },
      },
    },
    { runValidators: true }
  );

  if (!result?.modifiedCount) {
    const current = await findReservation(connection, reservation._id);
    if (current.status === "CHECKED_OUT") return current;
    throw conflict(
      "Reservation status changed during check-out; reload and retry",
      "status"
    );
  }
  return findReservation(connection, reservation._id);
}

async function loadStayRefs(connection, stay) {
  const [guest, roomType, room, reservation] = await Promise.all([
    stay.guestId ? getGuestModel(connection).findById(stay.guestId).lean() : null,
    stay.roomTypeId
      ? getRoomTypeModel(connection).findById(stay.roomTypeId).lean()
      : null,
    stay.roomId ? getRoomModel(connection).findById(stay.roomId).lean() : null,
    stay.reservationId
      ? getReservationModel(connection).findById(stay.reservationId).lean()
      : null,
  ]);
  return { guest, roomType, room, reservation };
}

async function loadStayResponse(
  connection,
  stay,
  { paymentSummary = null } = {}
) {
  const refs = await loadStayRefs(connection, stay);
  return toSafeHotelStay(stay, { ...refs, paymentSummary });
}

async function safePaymentSummary(connection, stay, reservation) {
  try {
    return await getHotelStayPaymentSummary({
      connection,
      stay,
      reservation,
    });
  } catch {
    return unavailableHotelStayPaymentSummary(stay, {
      reason: "PAYMENT_SUMMARY_UNAVAILABLE",
    });
  }
}

async function loadStayReferenceMaps(connection, stays) {
  const guestIds = [
    ...new Set(
      stays.map((stay) => (stay.guestId ? String(stay.guestId) : null)).filter(Boolean)
    ),
  ];
  const roomTypeIds = [
    ...new Set(
      stays
        .map((stay) => (stay.roomTypeId ? String(stay.roomTypeId) : null))
        .filter(Boolean)
    ),
  ];
  const roomIds = [
    ...new Set(
      stays.map((stay) => (stay.roomId ? String(stay.roomId) : null)).filter(Boolean)
    ),
  ];
  const reservationIds = [
    ...new Set(
      stays
        .map((stay) => (stay.reservationId ? String(stay.reservationId) : null))
        .filter(Boolean)
    ),
  ];

  const [guests, roomTypes, rooms, reservations] = await Promise.all([
    guestIds.length
      ? getGuestModel(connection)
          .find({ _id: { $in: guestIds } })
          .select("firstName lastName phone email isActive")
          .lean()
      : [],
    roomTypeIds.length
      ? getRoomTypeModel(connection)
          .find({ _id: { $in: roomTypeIds } })
          .select("name code capacity baseNightlyRate isActive")
          .lean()
      : [],
    roomIds.length
      ? getRoomModel(connection)
          .find({ _id: { $in: roomIds } })
          .select("roomNumber floor roomTypeId capacity isActive operationalStatus")
          .lean()
      : [],
    reservationIds.length
      ? getReservationModel(connection)
          .find({ _id: { $in: reservationIds } })
          .select(
            "reservationNumber status arrivalDate departureDate nights nightlyRate totalAmount"
          )
          .lean()
      : [],
  ]);

  return {
    guestMap: new Map(guests.map((guest) => [String(guest._id), guest])),
    roomTypeMap: new Map(
      roomTypes.map((roomType) => [String(roomType._id), roomType])
    ),
    roomMap: new Map(rooms.map((room) => [String(room._id), room])),
    reservationMap: new Map(
      reservations.map((reservation) => [String(reservation._id), reservation])
    ),
  };
}

export async function listStays({
  connection,
  status,
  activeOnly = false,
  reservationId,
  guestId,
  roomId,
  checkedInFrom,
  checkedInTo,
  limit = 50,
  offset = 0,
} = {}) {
  if (status && !HOTEL_STAY_STATUSES.includes(status)) {
    throw new HotelValidationError({
      status: `status must be one of ${HOTEL_STAY_STATUSES.join(", ")}`,
    });
  }
  if (
    checkedInFrom &&
    checkedInTo &&
    checkedInFrom.getTime() > checkedInTo.getTime()
  ) {
    throw new HotelValidationError({
      checkedInTo: "checkedInTo must be on or after checkedInFrom",
    });
  }

  const Stay = getStayModel(connection);
  const filter = {};
  if (status) {
    filter.status = status;
  } else if (activeOnly === true) {
    filter.status = { $in: HOTEL_ACTIVE_STAY_STATUSES };
  }
  if (reservationId) filter.reservationId = reservationId;
  if (guestId) filter.guestId = guestId;
  if (roomId) filter.roomId = roomId;
  if (checkedInFrom || checkedInTo) {
    filter.checkedInAt = {};
    if (checkedInFrom) filter.checkedInAt.$gte = checkedInFrom;
    if (checkedInTo) {
      filter.checkedInAt.$lt = addHotelLocalDays(checkedInTo, 1);
    }
  }

  const total = await Stay.countDocuments(filter);
  const stays = await Stay.find(filter)
    .sort({ checkedInAt: -1, createdAt: -1 })
    .skip(offset)
    .limit(limit)
    .lean();
  const { guestMap, roomTypeMap, roomMap, reservationMap } =
    await loadStayReferenceMaps(connection, stays);

  return {
    items: stays.map((stay) =>
      toSafeHotelStaySummary(stay, {
        guest: guestMap.get(String(stay.guestId)) ?? null,
        roomType: roomTypeMap.get(String(stay.roomTypeId)) ?? null,
        room: roomMap.get(String(stay.roomId)) ?? null,
        reservation:
          reservationMap.get(String(stay.reservationId)) ?? null,
      })
    ),
    total,
    limit,
    offset,
  };
}

export async function getStay({ connection, id } = {}) {
  const stay = await findStay(connection, id);
  const paymentSummary =
    stay.status === "CHECKED_OUT"
      ? await safePaymentSummary(connection, stay, null)
      : null;
  return {
    stay: await loadStayResponse(connection, stay, { paymentSummary }),
  };
}

export async function listReservationStays({
  connection,
  reservationId,
  limit = 50,
  offset = 0,
} = {}) {
  const reservation = await findReservation(connection, reservationId);
  const result = await listStays({
    connection,
    reservationId: reservation._id,
    limit,
    offset,
  });
  return {
    reservationId: String(reservation._id),
    reservationNumber: reservation.reservationNumber,
    ...result,
  };
}

export async function listGuestStays({
  connection,
  guestId,
  limit = 50,
  offset = 0,
} = {}) {
  const guest = await findHotelGuest(connection, guestId);
  const result = await listStays({
    connection,
    guestId: guest._id,
    limit,
    offset,
  });
  return {
    guest: toSafeHotelGuestSummary(guest),
    ...result,
  };
}

async function writeCheckInAudits({
  connection,
  stay,
  reservation,
  roomOutcome,
  stayCreated = false,
  reservationChanged = false,
  actor,
  request,
}) {
  if (stayCreated) {
    await audit(connection, {
      action: HOTEL_AUDIT_ACTIONS.STAY_CHECKED_IN,
      outcome: "SUCCESS",
      actorUserId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      entityType: "Stay",
      entityId: String(stay._id),
      metadata: {
        stayId: String(stay._id),
        reservationId: String(reservation._id),
        reservationNumber: reservation.reservationNumber,
        guestId: String(stay.guestId),
        roomId: String(stay.roomId),
        roomNumber: stay.roomSnapshot?.roomNumber ?? null,
        checkedInAt: stay.checkedInAt,
        expectedCheckOutAt: stay.expectedCheckOutAt,
        nightlyRate: stay.nightlyRate,
        rateSource: stay.rateSource,
        reservationNights: stay.reservationNights,
      },
      request,
    });
  }

  if (reservationChanged) {
    await audit(connection, {
      action: HOTEL_AUDIT_ACTIONS.RESERVATION_CHECKED_IN,
      outcome: "SUCCESS",
      actorUserId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      entityType: "Reservation",
      entityId: String(reservation._id),
      metadata: {
        reservationNumber: reservation.reservationNumber,
        previousStatus: "CONFIRMED",
        status: "CHECKED_IN",
        stayId: String(stay._id),
        roomId: String(stay.roomId),
      },
      request,
    });
  }

  if (roomOutcome?.changed) {
    await audit(connection, {
      action: HOTEL_AUDIT_ACTIONS.ROOM_STATUS_CHANGED,
      outcome: "SUCCESS",
      actorUserId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      entityType: "Room",
      entityId: String(roomOutcome.room._id),
      metadata: {
        previousStatus: roomOutcome.previousStatus,
        status: "OCCUPIED",
        reservationId: String(reservation._id),
        stayId: String(stay._id),
      },
      request,
    });
  }
}

async function writeCheckOutAudits({
  connection,
  stay,
  reservation,
  roomOutcome,
  paymentSummary,
  stayChanged = false,
  reservationChanged = false,
  actor,
  request,
}) {
  if (stayChanged) {
    await audit(connection, {
      action: HOTEL_AUDIT_ACTIONS.STAY_CHECKED_OUT,
      outcome: "SUCCESS",
      actorUserId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      entityType: "Stay",
      entityId: String(stay._id),
      metadata: {
        stayId: String(stay._id),
        reservationId: String(reservation._id),
        reservationNumber: reservation.reservationNumber,
        guestId: String(stay.guestId),
        roomId: String(stay.roomId),
        roomNumber: stay.roomSnapshot?.roomNumber ?? null,
        checkedOutAt: stay.checkedOutAt,
        billableNights: stay.billableNights,
        nightlyRate: stay.nightlyRate,
        roomCharges: stay.roomCharges,
        totalCharges: stay.totalCharges,
        chargeRule: stay.chargeRule,
        paymentAvailable: paymentSummary?.available === true,
        totalPaid: paymentSummary?.totalPaid ?? null,
        outstandingBalance: paymentSummary?.outstandingBalance ?? null,
      },
      request,
    });
  }

  if (reservationChanged) {
    await audit(connection, {
      action: HOTEL_AUDIT_ACTIONS.RESERVATION_CHECKED_OUT,
      outcome: "SUCCESS",
      actorUserId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      entityType: "Reservation",
      entityId: String(reservation._id),
      metadata: {
        reservationNumber: reservation.reservationNumber,
        previousStatus: "CHECKED_IN",
        status: "CHECKED_OUT",
        stayId: String(stay._id),
        roomId: String(stay.roomId),
        billableNights: stay.billableNights,
        totalCharges: stay.totalCharges,
      },
      request,
    });
  }

  if (roomOutcome?.changed) {
    await audit(connection, {
      action: HOTEL_AUDIT_ACTIONS.ROOM_STATUS_CHANGED,
      outcome: "SUCCESS",
      actorUserId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      entityType: "Room",
      entityId: String(roomOutcome.room._id),
      metadata: {
        previousStatus: roomOutcome.previousStatus,
        status: "CLEANING",
        reservationId: String(reservation._id),
        stayId: String(stay._id),
      },
      request,
    });
  }
}

async function finishCheckIn({
  connection,
  reservation,
  stay,
  actor,
  note,
  now,
  stayCreated = false,
  reservationChanged = false,
}) {
  const room = await assertRoomReadyForCheckIn(
    connection,
    reservation,
    stay.roomId,
    { allowOccupied: true, checkOverlappingReservations: false }
  );
  const linkedReservation = await linkReservationStay({
    connection,
    reservation,
    stay,
    actor,
  });
  const roomOutcome = await ensureRoomOccupied({
    connection,
    room,
    actor,
    now,
    note: note || `Checked in ${reservation.reservationNumber}`,
  });
  const changed =
    stayCreated || reservationChanged || roomOutcome.changed === true;

  return {
    stay: await loadStayResponse(connection, stay),
    reservation: (await getReservation({
      connection,
      id: linkedReservation._id,
    })).reservation,
    changed,
    stayCreated,
    reservationChanged,
    roomStatus: roomOutcome.room.operationalStatus,
    roomStatusChanged: roomOutcome.changed,
    roomOutcome,
  };
}

export async function checkInReservation({
  connection,
  id,
  input = {},
  actor = null,
  request = null,
  now = Date.now(),
} = {}) {
  const validated = validateCheckInPayload(input ?? {});
  const initial = await findReservation(connection, id);

  if (!["CONFIRMED", "CHECKED_IN"].includes(initial.status)) {
    assertReservationTransition(initial.status, "CHECKED_IN");
  }

  let lockRoomId = initial.roomId ? String(initial.roomId) : null;
  if (!lockRoomId) {
    const initialStay = await findStayByReservation(connection, initial._id);
    lockRoomId = initialStay?.roomId ? String(initialStay.roomId) : null;
  }
  if (!lockRoomId) {
    throw conflict(
      "Reservation has no assigned room; assign a room before check-in",
      "roomId"
    );
  }

  const result = await withHotelRoomBookingLocks({
    connection,
    roomIds: [lockRoomId],
    now,
    fn: async () => {
      const reservation = await findReservation(connection, initial._id);
      if (
        reservation.roomId &&
        String(reservation.roomId) !== String(lockRoomId)
      ) {
        throw conflict(
          "Reservation room changed during check-in; retry",
          "roomId"
        );
      }
      let stay = await findStayByReservation(connection, reservation._id);

      if (stay) {
        if (stay.status === "CHECKED_OUT") {
          throw conflict("Stay has already checked out", "status");
        }
        if (stay.status !== "IN_HOUSE") {
          throw conflict(`A ${stay.status} stay cannot be checked in`, "status");
        }
        if (!["CONFIRMED", "CHECKED_IN"].includes(reservation.status)) {
          throw conflict(
            `A ${reservation.status} reservation cannot be checked in`,
            "status"
          );
        }

        const windowNow =
          dateTime(reservation.checkedInAt) ??
          dateTime(stay.checkedInAt) ??
          now;
        assertCheckInWindow(reservation, windowNow);

        if (reservation.status === "CONFIRMED") {
          await transitionReservationToCheckedIn({
            connection,
            reservation,
            checkedInAt: asDate(stay.checkedInAt) ?? new Date(now),
            actor,
            note: stay.checkInNote ?? validated.note,
          });
        }

        return finishCheckIn({
          connection,
          reservation,
          stay,
          actor,
          note: stay.checkInNote ?? validated.note,
          now: dateTime(stay.checkedInAt) ?? now,
          stayCreated: false,
          reservationChanged: reservation.status === "CONFIRMED",
        });
      }

      if (reservation.status === "CHECKED_IN") {
        // A previous request transitioned the reservation but did not finish
        // creating the stay. Complete it using the original check-in time.
        const checkedInAt =
          asDate(reservation.checkedInAt) ?? new Date(now);
        assertCheckInWindow(reservation, checkedInAt.getTime());
        const room = await assertRoomReadyForCheckIn(
          connection,
          reservation,
          reservation.roomId,
          { allowOccupied: true, checkOverlappingReservations: false }
        );
        const Stay = getStayModel(connection);
        let stayCreated = true;
        try {
          stay = await Stay.create(
            stayDocumentFor({
              reservation,
              room,
              checkedInAt,
              checkedInBy: reservation.checkedInBy ?? actor?.id ?? null,
              note: validated.note,
            })
          );
        } catch (error) {
          if (error?.code !== 11000) throw error;
          stayCreated = false;
          stay = await findStayByReservation(connection, reservation._id);
          if (!stay) throw error;
        }

        return finishCheckIn({
          connection,
          reservation,
          stay,
          actor,
          note: validated.note,
          now: checkedInAt.getTime(),
          stayCreated,
          reservationChanged: false,
        });
      }

      assertReservationTransition(reservation.status, "CHECKED_IN");
      assertCheckInWindow(reservation, now);

      const room = await assertRoomReadyForCheckIn(
        connection,
        reservation,
        reservation.roomId
      );
      const checkedInAt = new Date(now);
      const transitioned = await transitionReservationToCheckedIn({
        connection,
        reservation,
        checkedInAt,
        actor,
        note: validated.note,
      });

      const Stay = getStayModel(connection);
      let stayCreated = true;
      try {
        stay = await Stay.create(
          stayDocumentFor({
            reservation: transitioned,
            room,
            checkedInAt,
            checkedInBy: actor?.id ?? null,
            note: validated.note,
          })
        );
      } catch (error) {
        if (error?.code !== 11000) throw error;
        stayCreated = false;
        stay = await findStayByReservation(connection, transitioned._id);
        if (!stay) throw error;
      }
      if (stay.status !== "IN_HOUSE") {
        throw conflict("Stay is not active", "status");
      }

      return finishCheckIn({
        connection,
        reservation: transitioned,
        stay,
        actor,
        note: validated.note,
        now,
        stayCreated,
        reservationChanged: true,
      });
    },
  });

  if (result.changed) {
    await writeCheckInAudits({
      connection,
      stay: result.stay,
      reservation: result.reservation,
      roomOutcome: result.roomOutcome,
      stayCreated: result.stayCreated,
      reservationChanged: result.reservationChanged,
      actor,
      request,
    });
  }

  return {
    stay: result.stay,
    reservation: result.reservation,
    changed: result.changed,
    roomStatus: result.roomStatus,
    roomStatusChanged: result.roomStatusChanged,
  };
}

async function finalizeCheckOut({
  connection,
  stay,
  actor,
  request,
  now,
  stayChanged = false,
}) {
  const reservation = await findReservation(connection, stay.reservationId);
  if (!["CHECKED_IN", "CHECKED_OUT"].includes(reservation.status)) {
    throw conflict(
      `A ${reservation.status} reservation cannot be checked out`,
      "status"
    );
  }
  const reservationChanged = reservation.status === "CHECKED_IN";

  const updatedReservation = await transitionReservationToCheckedOut({
    connection,
    reservation,
    stay,
    actor,
  });
  const roomOutcome = await ensureRoomCleaning({
    connection,
    roomId: stay.roomId,
    actor,
    now: asDate(stay.checkedOutAt)?.getTime() ?? now,
    note: `Checked out ${reservation.reservationNumber}`,
    repairOnly: !stayChanged,
  });
  const paymentSummary = await safePaymentSummary(
    connection,
    stay,
    updatedReservation
  );
  const changed =
    stayChanged || reservationChanged || roomOutcome.changed === true;

  return {
    stay: await loadStayResponse(connection, stay, { paymentSummary }),
    reservation: (await getReservation({
      connection,
      id: updatedReservation._id,
    })).reservation,
    paymentSummary,
    changed,
    stayChanged,
    reservationChanged,
    roomStatus: roomOutcome.room.operationalStatus,
    roomStatusChanged: roomOutcome.changed,
    roomOutcome,
  };
}

export async function checkOutStay({
  connection,
  id,
  input = {},
  actor = null,
  request = null,
  now = Date.now(),
} = {}) {
  const validated = validateCheckOutPayload(input ?? {});
  const initial = await findStay(connection, id);

  if (!["IN_HOUSE", "CHECKED_OUT"].includes(initial.status)) {
    assertStayTransition(initial.status, "CHECKED_OUT");
  }

  const result = await withHotelRoomBookingLocks({
    connection,
    roomIds: [initial.roomId],
    now,
    fn: async () => {
      const stay = await findStay(connection, initial._id);

      if (stay.status === "CHECKED_OUT") {
        return finalizeCheckOut({
          connection,
          stay,
          actor,
          request,
          now: asDate(stay.checkedOutAt)?.getTime() ?? now,
          stayChanged: false,
        });
      }
      if (stay.status !== "IN_HOUSE") {
        assertStayTransition(stay.status, "CHECKED_OUT");
      }

      const reservation = await findReservation(connection, stay.reservationId);
      if (!["CHECKED_IN", "CHECKED_OUT"].includes(reservation.status)) {
        throw conflict(
          `A ${reservation.status} reservation cannot be checked out`,
          "status"
        );
      }

      const checkedOutAt = new Date(now);
      const checkedInAt = asDate(stay.checkedInAt);
      if (!checkedInAt || checkedOutAt.getTime() < checkedInAt.getTime()) {
        throw conflict(
          "checkedOutAt cannot be before checkedInAt",
          "checkedOutAt"
        );
      }

      const charges = calculateHotelStayCharges({
        nightlyRate: stay.nightlyRate,
        checkedInAt,
        checkedOutAt,
      });

      const Stay = getStayModel(connection);
      const filter = { _id: stay._id, status: "IN_HOUSE" };
      if (stay.updatedAt) filter.updatedAt = stay.updatedAt;
      const updateResult = await Stay.updateOne(
        filter,
        {
          $set: {
            status: "CHECKED_OUT",
            checkedOutAt,
            checkedOutBy: actor?.id ?? null,
            checkOutNote: validated.note,
            billableNights: charges.billableNights,
            roomCharges: charges.roomCharges,
            totalCharges: charges.totalCharges,
            chargeRule: charges.chargeRule,
          },
          $push: {
            statusHistory: {
              status: "CHECKED_OUT",
              previousStatus: "IN_HOUSE",
              changedAt: checkedOutAt,
              changedBy: actor?.id ?? null,
              note: validated.note,
            },
          },
        },
        { runValidators: true }
      );

      let updatedStay;
      let changed = true;
      if (!updateResult?.modifiedCount) {
        const current = await findStay(connection, stay._id);
        if (current?.status !== "CHECKED_OUT") {
          throw conflict(
            "Stay status changed during check-out; reload and retry",
            "status"
          );
        }
        updatedStay = current;
        changed = false;
      } else {
        updatedStay = await findStay(connection, stay._id);
      }

      return finalizeCheckOut({
        connection,
        stay: updatedStay,
        actor,
        request,
        now: checkedOutAt.getTime(),
        stayChanged: changed,
      });
    },
  });

  if (result.changed) {
    await writeCheckOutAudits({
      connection,
      stay: result.stay,
      reservation: result.reservation,
      roomOutcome: result.roomOutcome,
      paymentSummary: result.paymentSummary,
      stayChanged: result.stayChanged,
      reservationChanged: result.reservationChanged,
      actor,
      request,
    });
  }

  return {
    stay: result.stay,
    reservation: result.reservation,
    paymentSummary: result.paymentSummary,
    changed: result.changed,
    roomStatus: result.roomStatus,
    roomStatusChanged: result.roomStatusChanged,
  };
}
