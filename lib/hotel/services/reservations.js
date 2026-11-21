import crypto from "crypto";

import {
  HOTEL_ACTIVE_RESERVATION_STATUSES,
  HOTEL_RESERVATION_STATUSES,
  HOTEL_RESERVATION_TRANSITIONS,
} from "../constants.js";
import {
  HOTEL_AUDIT_ACTIONS,
  safeRecordHotelAudit,
} from "../audit.js";
import {
  formatHotelLocalDate,
  parseHotelLocalDate,
  validateHotelStayRange,
} from "../dates.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
  HotelValidationError,
} from "../errors.js";
import { getGuestModel } from "../models/guest.js";
import {
  getReservationModel,
  toSafeHotelReservation,
  toSafeHotelReservationSummary,
} from "../models/reservation.js";
import { getRoomModel } from "../models/room.js";
import { getRoomTypeModel } from "../models/roomType.js";
import {
  validateObjectIdString,
  validateReservationAssignmentPayload,
  validateReservationCancelPayload,
  validateReservationCreatePayload,
  validateReservationUpdatePayload,
} from "../validation.js";
import { withHotelRoomBookingLocks } from "./bookingLocks.js";
import { assertActiveHotelGuest } from "./guests.js";

// Hotel Reservation service.
//
// A reservation owns a half-open stay interval [arrivalDate, departureDate), so
// a checkout and a check-in may share the same local date without overlapping.
// Room inventory is protected by a per-room booking lock around the overlap
// check and write. Nightly rate and guest/room-type details are snapshotted at
// booking time and are never recomputed from later price changes.
//
// This sub-phase does not change Room.operationalStatus. Check-in will own
// OCCUPIED, and check-out will own CLEANING in a later sub-phase.

function notFound() {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.NOT_FOUND,
    message: "Reservation not found",
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

function computeTotal(nightlyRate, nights) {
  return roundMoney(Number(nightlyRate) * Number(nights));
}

function reservationNumberFor(arrivalDate) {
  const datePart = formatHotelLocalDate(arrivalDate).replaceAll("-", "");
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `RES-${datePart}-${suffix}`;
}

function snapshotGuest(guest) {
  const firstName = guest.firstName ?? "";
  const lastName = guest.lastName ?? "";
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    phone: guest.phone ?? "",
    email: guest.email ?? null,
  };
}

function snapshotRoomType(roomType) {
  return {
    name: roomType.name,
    code: roomType.code,
    capacity: roomType.capacity,
    baseNightlyRate: roomType.baseNightlyRate,
  };
}

function snapshotRoom(room) {
  return {
    roomNumber: room.roomNumber,
    floor: room.floor,
  };
}

function resolveNightlyRate(room, roomType) {
  if (room && room.nightlyRateOverride != null) {
    return {
      nightlyRate: roundMoney(room.nightlyRateOverride),
      rateSource: "ROOM_OVERRIDE",
    };
  }
  return {
    nightlyRate: roundMoney(roomType.baseNightlyRate),
    rateSource: "ROOM_TYPE_BASE",
  };
}

function assertGuestCountWithinCapacity(guestCount, capacity, field = "adults") {
  if (guestCount > capacity) {
    throw new HotelValidationError({
      [field]: `guest count exceeds the room capacity of ${capacity}`,
    });
  }
}

async function audit(connection, event) {
  await safeRecordHotelAudit(connection, event);
}

export function canTransitionReservation(fromStatus, toStatus) {
  const allowed = HOTEL_RESERVATION_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

export function assertReservationTransition(fromStatus, toStatus) {
  if (!canTransitionReservation(fromStatus, toStatus)) {
    throw conflict(
      `Reservation cannot transition from ${fromStatus} to ${toStatus}`,
      "status"
    );
  }
  return true;
}

async function findReservation(connection, id) {
  const normalizedId = validateObjectIdString(id, "id");
  const Reservation = getReservationModel(connection);
  const reservation = await Reservation.findById(normalizedId).lean();
  if (!reservation) throw notFound();
  return reservation;
}

async function findOptionalById(connection, modelName, id) {
  if (!id) return null;
  const model =
    modelName === "Guest"
      ? getGuestModel(connection)
      : modelName === "RoomType"
        ? getRoomTypeModel(connection)
        : getRoomModel(connection);
  return model.findById(id).lean();
}

async function findRoomType(connection, id) {
  const RoomType = getRoomTypeModel(connection);
  return RoomType.findById(id).lean();
}

async function assertActiveRoomType(connection, id) {
  const roomType = await findRoomType(connection, id);
  if (!roomType) {
    throw new HotelValidationError({
      roomTypeId: "roomTypeId must reference an existing room type",
    });
  }
  if (roomType.isActive !== true) {
    throw new HotelValidationError({
      roomTypeId: "roomTypeId must reference an active room type",
    });
  }
  return roomType;
}

async function findRoom(connection, id) {
  const Room = getRoomModel(connection);
  return Room.findById(id).lean();
}

async function assertRoomAssignable(
  connection,
  roomId,
  { roomTypeId, guestCount } = {}
) {
  const room = await findRoom(connection, roomId);
  if (!room) {
    throw new HotelValidationError({
      roomId: "roomId must reference an existing room",
    });
  }
  if (room.isActive !== true) {
    throw new HotelValidationError({
      roomId: "roomId must reference an active room",
    });
  }
  if (room.operationalStatus === "OUT_OF_SERVICE") {
    throw new HotelValidationError({
      roomId: "roomId must reference a sellable room",
    });
  }
  if (roomTypeId && String(room.roomTypeId) !== String(roomTypeId)) {
    throw new HotelValidationError({
      roomId: "roomId must belong to the reservation's room type",
    });
  }
  assertGuestCountWithinCapacity(guestCount, room.capacity, "roomId");
  return room;
}

async function findOverlappingReservation(
  connection,
  { roomId, arrivalDate, departureDate, excludeId = null } = {}
) {
  const Reservation = getReservationModel(connection);
  const filter = {
    roomId,
    status: { $in: HOTEL_ACTIVE_RESERVATION_STATUSES },
    arrivalDate: { $lt: departureDate },
    departureDate: { $gt: arrivalDate },
  };
  if (excludeId) filter._id = { $ne: excludeId };

  return Reservation.findOne(filter)
    .select("_id reservationNumber arrivalDate departureDate status")
    .lean();
}

function overlapConflict() {
  return conflict(
    "Room is already reserved for an overlapping stay",
    "roomId"
  );
}

async function createWithUniqueNumber(connection, doc, arrivalDate) {
  const Reservation = getReservationModel(connection);
  const attempts = 5;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await Reservation.create({
        ...doc,
        reservationNumber: reservationNumberFor(arrivalDate),
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      lastError = error;
    }
  }

  throw new HotelApiError({
    code: HOTEL_ERROR_CODES.CONFLICT,
    message: "Could not allocate a unique reservation number; retry",
    status: 409,
    expose: true,
    details: { field: "reservationNumber" },
    cause: lastError ?? undefined,
  });
}

async function loadReferenceMaps(connection, reservations) {
  const guestIds = [
    ...new Set(
      reservations
        .map((reservation) =>
          reservation.guestId ? String(reservation.guestId) : null
        )
        .filter(Boolean)
    ),
  ];
  const roomTypeIds = [
    ...new Set(
      reservations
        .map((reservation) =>
          reservation.roomTypeId ? String(reservation.roomTypeId) : null
        )
        .filter(Boolean)
    ),
  ];
  const roomIds = [
    ...new Set(
      reservations
        .map((reservation) =>
          reservation.roomId ? String(reservation.roomId) : null
        )
        .filter(Boolean)
    ),
  ];

  const [guests, roomTypes, rooms] = await Promise.all([
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
  ]);

  return {
    guestMap: new Map(guests.map((guest) => [String(guest._id), guest])),
    roomTypeMap: new Map(
      roomTypes.map((roomType) => [String(roomType._id), roomType])
    ),
    roomMap: new Map(rooms.map((room) => [String(room._id), room])),
  };
}

async function loadReservationRefs(connection, reservation) {
  const [guest, roomType, room] = await Promise.all([
    findOptionalById(connection, "Guest", reservation.guestId),
    findOptionalById(connection, "RoomType", reservation.roomTypeId),
    findOptionalById(connection, "Room", reservation.roomId),
  ]);
  return { guest, roomType, room };
}

async function loadReservationResponse(
  connection,
  reservation,
  { includeHistory = true } = {}
) {
  const refs = await loadReservationRefs(connection, reservation);
  return toSafeHotelReservation(reservation, {
    ...refs,
    includeHistory,
  });
}

export async function listReservations({
  connection,
  status,
  activeOnly = false,
  guestId,
  roomTypeId,
  roomId,
  arrivalFrom,
  arrivalTo,
  limit = 50,
  offset = 0,
} = {}) {
  if (status && !HOTEL_RESERVATION_STATUSES.includes(status)) {
    throw new HotelValidationError({
      status: `status must be one of ${HOTEL_RESERVATION_STATUSES.join(", ")}`,
    });
  }
  if (arrivalFrom && arrivalTo && arrivalFrom.getTime() > arrivalTo.getTime()) {
    throw new HotelValidationError({
      arrivalTo: "arrivalTo must be on or after arrivalFrom",
    });
  }

  const Reservation = getReservationModel(connection);
  const filter = {};
  if (status) {
    filter.status = status;
  } else if (activeOnly === true) {
    filter.status = { $in: HOTEL_ACTIVE_RESERVATION_STATUSES };
  }
  if (guestId) filter.guestId = guestId;
  if (roomTypeId) filter.roomTypeId = roomTypeId;
  if (roomId) filter.roomId = roomId;
  if (arrivalFrom || arrivalTo) {
    filter.arrivalDate = {};
    if (arrivalFrom) filter.arrivalDate.$gte = arrivalFrom;
    if (arrivalTo) filter.arrivalDate.$lte = arrivalTo;
  }

  const total = await Reservation.countDocuments(filter);
  const reservations = await Reservation.find(filter)
    .sort({ arrivalDate: 1, createdAt: -1 })
    .skip(offset)
    .limit(limit)
    .lean();
  const { guestMap, roomTypeMap, roomMap } = await loadReferenceMaps(
    connection,
    reservations
  );

  return {
    items: reservations.map((reservation) =>
      toSafeHotelReservationSummary(reservation, {
        guest: guestMap.get(String(reservation.guestId)) ?? null,
        roomType: roomTypeMap.get(String(reservation.roomTypeId)) ?? null,
        room: reservation.roomId
          ? roomMap.get(String(reservation.roomId)) ?? null
          : null,
      })
    ),
    total,
    limit,
    offset,
  };
}

export async function getReservation({ connection, id } = {}) {
  const reservation = await findReservation(connection, id);
  return {
    reservation: await loadReservationResponse(connection, reservation),
  };
}

export async function createReservation({
  connection,
  input,
  actor = null,
  request = null,
  now = Date.now(),
} = {}) {
  const validated = validateReservationCreatePayload(input);
  const guest = await assertActiveHotelGuest(connection, validated.guestId);
  const roomType = await assertActiveRoomType(connection, validated.roomTypeId);
  const stay = validateHotelStayRange({
    arrivalDate: validated.arrivalDate,
    departureDate: validated.departureDate,
    now,
  });
  const guestCount = validated.adults + validated.children;
  assertGuestCountWithinCapacity(guestCount, roomType.capacity, "adults");

  const nowDate = new Date(now);
  const roomId = validated.roomId;
  const create = async () => {
    let room = null;
    if (roomId) {
      room = await assertRoomAssignable(connection, roomId, {
        roomTypeId: roomType._id,
        guestCount,
      });
      const overlap = await findOverlappingReservation(connection, {
        roomId: room._id,
        arrivalDate: stay.arrivalDate,
        departureDate: stay.departureDate,
      });
      if (overlap) throw overlapConflict();
    }

    const rate = resolveNightlyRate(room, roomType);
    return createWithUniqueNumber(
      connection,
      {
        guestId: guest._id,
        guestSnapshot: snapshotGuest(guest),
        roomTypeId: roomType._id,
        roomTypeSnapshot: snapshotRoomType(roomType),
        roomId: room?._id ?? null,
        roomSnapshot: room ? snapshotRoom(room) : null,
        arrivalDate: stay.arrivalDate,
        departureDate: stay.departureDate,
        nights: stay.nights,
        adults: validated.adults,
        children: validated.children,
        nightlyRate: rate.nightlyRate,
        rateSource: rate.rateSource,
        totalAmount: computeTotal(rate.nightlyRate, stay.nights),
        status: "CONFIRMED",
        notes: validated.notes,
        createdBy: actor?.id ?? null,
        updatedBy: actor?.id ?? null,
        statusHistory: [
          {
            status: "CONFIRMED",
            previousStatus: null,
            changedAt: nowDate,
            changedBy: actor?.id ?? null,
            note: "",
          },
        ],
      },
      stay.arrivalDate
    );
  };

  const created = roomId
    ? await withHotelRoomBookingLocks({
        connection,
        roomIds: [roomId],
        now,
        fn: create,
      })
    : await create();

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.RESERVATION_CREATED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "Reservation",
    entityId: created._id ? String(created._id) : null,
    metadata: {
      reservationNumber: created.reservationNumber,
      guestId: String(created.guestId),
      roomTypeId: String(created.roomTypeId),
      roomId: created.roomId ? String(created.roomId) : null,
      arrivalLocalDate: formatHotelLocalDate(created.arrivalDate),
      departureLocalDate: formatHotelLocalDate(created.departureDate),
      nights: created.nights,
      nightlyRate: created.nightlyRate,
      totalAmount: created.totalAmount,
      status: created.status,
    },
    request,
  });

  return {
    reservation: await loadReservationResponse(connection, created),
  };
}

export async function updateReservation({
  connection,
  id,
  input,
  actor = null,
  request = null,
  now = Date.now(),
} = {}) {
  const existing = await findReservation(connection, id);
  if (existing.status !== "CONFIRMED") {
    throw conflict(
      `A ${existing.status} reservation cannot be updated`,
      "status"
    );
  }

  const validated = validateReservationUpdatePayload(input);
  if (Object.keys(validated).length === 0) {
    throw new HotelValidationError({ body: "at least one field is required" });
  }

  const currentArrival = formatHotelLocalDate(existing.arrivalDate);
  const currentDeparture = formatHotelLocalDate(existing.departureDate);
  const stay = validateHotelStayRange({
    arrivalDate: validated.arrivalDate ?? currentArrival,
    departureDate: validated.departureDate ?? currentDeparture,
    now,
    requireTodayOrLater: validated.arrivalDate !== undefined,
  });

  const adults = validated.adults ?? existing.adults;
  const children = validated.children ?? existing.children ?? 0;
  const capacity =
    existing.roomTypeSnapshot?.capacity ??
    (await findRoomType(connection, existing.roomTypeId))?.capacity ??
    1;
  assertGuestCountWithinCapacity(adults + children, capacity, "adults");

  const update = {
    nights: stay.nights,
    totalAmount: computeTotal(existing.nightlyRate, stay.nights),
    updatedBy: actor?.id ?? null,
  };
  if (validated.arrivalDate !== undefined) {
    update.arrivalDate = parseHotelLocalDate(validated.arrivalDate, "arrivalDate");
  }
  if (validated.departureDate !== undefined) {
    update.departureDate = parseHotelLocalDate(
      validated.departureDate,
      "departureDate"
    );
  }
  if (validated.adults !== undefined) update.adults = validated.adults;
  if (validated.children !== undefined) update.children = validated.children;
  if (validated.notes !== undefined) update.notes = validated.notes;

  const Reservation = getReservationModel(connection);
  const expectedUpdatedAt = existing.updatedAt ?? null;
  const persist = async () => {
    if (existing.roomId) {
      const overlap = await findOverlappingReservation(connection, {
        roomId: existing.roomId,
        arrivalDate: stay.arrivalDate,
        departureDate: stay.departureDate,
        excludeId: existing._id,
      });
      if (overlap) throw overlapConflict();
    }

    const filter = { _id: existing._id, status: "CONFIRMED" };
    if (expectedUpdatedAt) filter.updatedAt = expectedUpdatedAt;
    const result = await Reservation.updateOne(
      filter,
      { $set: update },
      { runValidators: true }
    );
    if (!result?.modifiedCount) {
      throw conflict(
        "Reservation is no longer CONFIRMED; reload and retry",
        "status"
      );
    }
    return findReservation(connection, existing._id);
  };

  const datesChanged =
    validated.arrivalDate !== undefined ||
    validated.departureDate !== undefined;
  const updated =
    datesChanged && existing.roomId
      ? await withHotelRoomBookingLocks({
          connection,
          roomIds: [existing.roomId],
          now,
          fn: persist,
        })
      : await persist();

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.RESERVATION_UPDATED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "Reservation",
    entityId: String(updated._id),
    metadata: {
      reservationNumber: updated.reservationNumber,
      changedFields: Object.keys(validated),
      arrivalLocalDate: formatHotelLocalDate(updated.arrivalDate),
      departureLocalDate: formatHotelLocalDate(updated.departureDate),
      nights: updated.nights,
      nightlyRate: updated.nightlyRate,
      totalAmount: updated.totalAmount,
    },
    request,
  });

  return {
    reservation: await loadReservationResponse(connection, updated),
  };
}

export async function assignReservationRoom({
  connection,
  id,
  input,
  actor = null,
  request = null,
  now = Date.now(),
} = {}) {
  const existing = await findReservation(connection, id);
  if (existing.status !== "CONFIRMED") {
    throw conflict(
      `A ${existing.status} reservation cannot be assigned a room`,
      "status"
    );
  }

  const { roomId } = validateReservationAssignmentPayload(input);
  const oldRoomId = existing.roomId ? String(existing.roomId) : null;
  if (oldRoomId === roomId) {
    return {
      reservation: await loadReservationResponse(connection, existing),
      changed: false,
    };
  }

  const guestCount = existing.adults + (existing.children ?? 0);
  const Reservation = getReservationModel(connection);
  const updated = await withHotelRoomBookingLocks({
    connection,
    roomIds: [oldRoomId, roomId].filter(Boolean),
    now,
    fn: async () => {
      const room = await assertRoomAssignable(connection, roomId, {
        roomTypeId: existing.roomTypeId,
        guestCount,
      });
      const overlap = await findOverlappingReservation(connection, {
        roomId: room._id,
        arrivalDate: existing.arrivalDate,
        departureDate: existing.departureDate,
        excludeId: existing._id,
      });
      if (overlap) throw overlapConflict();

      const filter = { _id: existing._id, status: "CONFIRMED" };
      if (existing.updatedAt) filter.updatedAt = existing.updatedAt;
      const result = await Reservation.updateOne(
        filter,
        {
          $set: {
            roomId: room._id,
            roomSnapshot: snapshotRoom(room),
            updatedBy: actor?.id ?? null,
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
      return findReservation(connection, existing._id);
    },
  });

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.RESERVATION_ROOM_ASSIGNED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "Reservation",
    entityId: String(updated._id),
    metadata: {
      reservationNumber: updated.reservationNumber,
      previousRoomId: oldRoomId,
      roomId: String(updated.roomId),
      roomNumber: updated.roomSnapshot?.roomNumber ?? null,
    },
    request,
  });

  return {
    reservation: await loadReservationResponse(connection, updated),
    changed: true,
  };
}

export async function cancelReservation({
  connection,
  id,
  input,
  actor = null,
  request = null,
  now = Date.now(),
} = {}) {
  const existing = await findReservation(connection, id);
  assertReservationTransition(existing.status, "CANCELLED");

  const { reason } = validateReservationCancelPayload(input);
  const nowDate = new Date(now);
  const Reservation = getReservationModel(connection);
  const filter = { _id: existing._id, status: existing.status };
  if (existing.updatedAt) filter.updatedAt = existing.updatedAt;
  const result = await Reservation.updateOne(
    filter,
    {
      $set: {
        status: "CANCELLED",
        cancelledAt: nowDate,
        cancelledBy: actor?.id ?? null,
        cancellationReason: reason,
        updatedBy: actor?.id ?? null,
      },
      $push: {
        statusHistory: {
          status: "CANCELLED",
          previousStatus: existing.status,
          changedAt: nowDate,
          changedBy: actor?.id ?? null,
          note: reason,
        },
      },
    },
    { runValidators: true }
  );
  if (!result?.modifiedCount) {
    throw conflict(
      "Reservation status changed; reload and retry",
      "status"
    );
  }

  const updated = await findReservation(connection, existing._id);

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.RESERVATION_CANCELLED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "Reservation",
    entityId: String(updated._id),
    metadata: {
      reservationNumber: updated.reservationNumber,
      previousStatus: existing.status,
      status: updated.status,
      reason,
    },
    request,
  });

  return {
    reservation: await loadReservationResponse(connection, updated),
  };
}
