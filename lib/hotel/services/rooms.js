import {
  HOTEL_BLOCKING_ROOM_STATUSES,
} from "../constants.js";
import {
  HOTEL_AUDIT_ACTIONS,
  safeRecordHotelAudit,
} from "../audit.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
  HotelValidationError,
} from "../errors.js";
import { getRoomModel, toSafeHotelRoom } from "../models/room.js";
import { getRoomTypeModel } from "../models/roomType.js";
import {
  validateObjectIdString,
  validateRoomPayload,
  validateRoomStatusPayload,
} from "../validation.js";

// Hotel Room service. Rooms are never hard-deleted. Deactivation is refused
// while a room is occupied or reserved, and status changes are refused for
// those reservation-controlled states. Room types are referenced by ObjectId
// so deactivating a type never breaks historical room records.

function notFound() {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.NOT_FOUND,
    message: "Room not found",
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

async function findRoom(connection, id) {
  const Room = getRoomModel(connection);
  const room = await Room.findById(id).lean();
  if (!room) throw notFound();
  return room;
}

async function findRoomType(connection, roomTypeId) {
  if (!roomTypeId) return null;
  const RoomType = getRoomTypeModel(connection);
  return RoomType.findById(roomTypeId).lean();
}

async function assertActiveRoomType(connection, roomTypeId) {
  const roomType = await findRoomType(connection, roomTypeId);
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

async function assertRoomNumberAvailable(
  connection,
  roomNumber,
  excludeId = null
) {
  const Room = getRoomModel(connection);
  const filter = { roomNumber };
  if (excludeId) filter._id = { $ne: excludeId };
  const existing = await Room.findOne(filter).select("_id").lean();
  if (existing) {
    throw conflict("A room with this number already exists", "roomNumber");
  }
}

async function loadRoomTypeMap(connection, rooms) {
  const ids = [
    ...new Set(
      rooms
        .map((room) => (room.roomTypeId ? String(room.roomTypeId) : null))
        .filter(Boolean)
    ),
  ];
  if (ids.length === 0) return new Map();

  const RoomType = getRoomTypeModel(connection);
  const roomTypes = await RoomType.find({ _id: { $in: ids } })
    .select("name code capacity baseNightlyRate isActive")
    .lean();
  return new Map(roomTypes.map((roomType) => [String(roomType._id), roomType]));
}

async function audit(connection, event) {
  await safeRecordHotelAudit(connection, event);
}

export async function listRooms({
  connection,
  isActive,
  operationalStatus,
  floor,
  roomTypeId,
  limit = 50,
  offset = 0,
} = {}) {
  const Room = getRoomModel(connection);
  const filter = {};
  if (isActive !== undefined) filter.isActive = isActive;
  if (operationalStatus !== undefined) {
    filter.operationalStatus = operationalStatus;
  }
  if (floor !== undefined) filter.floor = floor;
  if (roomTypeId !== undefined) filter.roomTypeId = roomTypeId;

  const total = await Room.countDocuments(filter);
  const rooms = await Room.find(filter)
    .sort({ floor: 1, roomNumber: 1 })
    .skip(offset)
    .limit(limit)
    .lean();
  const roomTypeMap = await loadRoomTypeMap(connection, rooms);

  return {
    items: rooms.map((room) =>
      toSafeHotelRoom(room, roomTypeMap.get(String(room.roomTypeId)))
    ),
    total,
    limit,
    offset,
  };
}

export async function getRoom({ connection, id } = {}) {
  const normalizedId = validateObjectIdString(id, "id");
  const room = await findRoom(connection, normalizedId);
  const roomType = await findRoomType(connection, room.roomTypeId);
  return { room: toSafeHotelRoom(room, roomType) };
}

export async function createRoom({
  connection,
  input,
  actor = null,
  request = null,
  now = Date.now(),
} = {}) {
  const validated = validateRoomPayload(input);
  await assertRoomNumberAvailable(connection, validated.roomNumber);
  const roomType = await assertActiveRoomType(connection, validated.roomTypeId);

  const status = validated.operationalStatus ?? "AVAILABLE";
  const Room = getRoomModel(connection);
  let created;
  try {
    created = await Room.create({
      ...validated,
      operationalStatus: status,
      statusHistory: [
        {
          status,
          previousStatus: null,
          changedAt: new Date(now),
          changedBy: actor?.id ?? null,
          note: "",
        },
      ],
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict("A room with this number already exists", "roomNumber");
    }
    throw error;
  }

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.ROOM_CREATED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "Room",
    entityId: created._id ? String(created._id) : null,
    metadata: {
      roomNumber: created.roomNumber,
      floor: created.floor,
      roomTypeId: String(created.roomTypeId),
      operationalStatus: created.operationalStatus,
    },
    request,
  });

  return { room: toSafeHotelRoom(created, roomType) };
}

export async function updateRoom({
  connection,
  id,
  input,
  actor = null,
  request = null,
} = {}) {
  const normalizedId = validateObjectIdString(id, "id");
  const validated = validateRoomPayload(input, { partial: true });
  if (Object.keys(validated).length === 0) {
    throw new HotelValidationError({ body: "at least one field is required" });
  }
  if (validated.isActive === false) {
    throw new HotelValidationError({
      isActive:
        "isActive cannot be set to false here; use the room deactivate endpoint",
    });
  }

  const existing = await findRoom(connection, normalizedId);

  if (
    validated.roomNumber &&
    validated.roomNumber !== existing.roomNumber
  ) {
    await assertRoomNumberAvailable(
      connection,
      validated.roomNumber,
      normalizedId
    );
  }

  let roomType;
  if (
    validated.roomTypeId &&
    String(validated.roomTypeId) !== String(existing.roomTypeId)
  ) {
    roomType = await assertActiveRoomType(connection, validated.roomTypeId);
  } else {
    roomType = await findRoomType(connection, existing.roomTypeId);
  }

  // Reactivation must not attach a room to an inactive type.
  if (
    validated.isActive === true &&
    existing.isActive === false &&
    roomType?.isActive !== true
  ) {
    throw new HotelValidationError({
      roomTypeId: "roomTypeId must reference an active room type",
    });
  }

  const Room = getRoomModel(connection);
  try {
    await Room.updateOne(
      { _id: normalizedId },
      { $set: validated },
      { runValidators: true }
    );
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict("A room with this number already exists", "roomNumber");
    }
    throw error;
  }

  const updated = await findRoom(connection, normalizedId);
  const updatedRoomType = validated.roomTypeId
    ? roomType
    : await findRoomType(connection, updated.roomTypeId);

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.ROOM_UPDATED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "Room",
    entityId: String(updated._id),
    metadata: {
      changedFields: Object.keys(validated),
      roomNumber: updated.roomNumber,
    },
    request,
  });

  return { room: toSafeHotelRoom(updated, updatedRoomType) };
}

export async function deactivateRoom({
  connection,
  id,
  actor = null,
  request = null,
} = {}) {
  const normalizedId = validateObjectIdString(id, "id");
  const existing = await findRoom(connection, normalizedId);
  const roomType = await findRoomType(connection, existing.roomTypeId);

  if (existing.isActive === false) {
    return {
      room: toSafeHotelRoom(existing, roomType),
      changed: false,
    };
  }

  if (HOTEL_BLOCKING_ROOM_STATUSES.includes(existing.operationalStatus)) {
    throw conflict(
      `A room that is ${existing.operationalStatus} cannot be deactivated`,
      "operationalStatus"
    );
  }

  const Room = getRoomModel(connection);
  await Room.updateOne(
    { _id: normalizedId, isActive: true },
    { $set: { isActive: false } },
    { runValidators: true }
  );

  const updated = await findRoom(connection, normalizedId);

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.ROOM_DEACTIVATED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "Room",
    entityId: String(updated._id),
    metadata: {
      roomNumber: updated.roomNumber,
      operationalStatus: updated.operationalStatus,
    },
    request,
  });

  return {
    room: toSafeHotelRoom(updated, roomType),
    changed: true,
  };
}

export async function changeRoomStatus({
  connection,
  id,
  input,
  actor = null,
  request = null,
  now = Date.now(),
} = {}) {
  const normalizedId = validateObjectIdString(id, "id");
  const validated = validateRoomStatusPayload(input);
  const existing = await findRoom(connection, normalizedId);
  const roomType = await findRoomType(connection, existing.roomTypeId);

  if (existing.isActive === false) {
    throw conflict("An inactive room cannot change operational status");
  }
  if (HOTEL_BLOCKING_ROOM_STATUSES.includes(existing.operationalStatus)) {
    throw conflict(
      `A room that is ${existing.operationalStatus} is controlled by the reservation flow`,
      "operationalStatus"
    );
  }
  if (existing.operationalStatus === validated.operationalStatus) {
    throw conflict(
      `Room is already in ${validated.operationalStatus} status`,
      "operationalStatus"
    );
  }

  const entry = {
    status: validated.operationalStatus,
    previousStatus: existing.operationalStatus,
    changedAt: new Date(now),
    changedBy: actor?.id ?? null,
    note: validated.note,
  };

  const Room = getRoomModel(connection);
  await Room.updateOne(
    { _id: normalizedId, isActive: true },
    {
      $set: { operationalStatus: validated.operationalStatus },
      $push: { statusHistory: entry },
    },
    { runValidators: true }
  );

  const updated = await findRoom(connection, normalizedId);

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.ROOM_STATUS_CHANGED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "Room",
    entityId: String(updated._id),
    metadata: {
      previousStatus: existing.operationalStatus,
      status: updated.operationalStatus,
      note: validated.note,
    },
    request,
  });

  return { room: toSafeHotelRoom(updated, roomType) };
}
