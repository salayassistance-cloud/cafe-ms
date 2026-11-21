import {
  HOTEL_AUDIT_ACTIONS,
  safeRecordHotelAudit,
} from "../audit.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
  HotelValidationError,
} from "../errors.js";
import { getRoomModel } from "../models/room.js";
import {
  getRoomTypeModel,
  toSafeRoomType,
} from "../models/roomType.js";
import {
  validateObjectIdString,
  validateRoomTypePayload,
} from "../validation.js";

// Hotel RoomType service. All operations require an explicitly supplied Hotel
// connection. Room types are never hard-deleted: deactivation preserves the
// ObjectId referenced by historical Room records.

function notFound() {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.NOT_FOUND,
    message: "Room type not found",
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

async function findRoomType(connection, id) {
  const RoomType = getRoomTypeModel(connection);
  const roomType = await RoomType.findById(id).lean();
  if (!roomType) throw notFound();
  return roomType;
}

async function assertCodeAvailable(connection, code, excludeId = null) {
  const RoomType = getRoomTypeModel(connection);
  const filter = { code };
  if (excludeId) filter._id = { $ne: excludeId };
  const existing = await RoomType.findOne(filter).select("_id").lean();
  if (existing) {
    throw conflict("A room type with this code already exists", "code");
  }
}

async function assertNoActiveRooms(connection, roomTypeId) {
  const Room = getRoomModel(connection);
  const activeRoom = await Room.exists({
    roomTypeId,
    isActive: true,
  });
  if (activeRoom) {
    throw conflict(
      "Room type is used by active rooms; reassign or deactivate those rooms first",
      "roomTypeId"
    );
  }
}

async function audit(connection, event) {
  await safeRecordHotelAudit(connection, event);
}

export async function listRoomTypes({
  connection,
  isActive,
  limit = 50,
  offset = 0,
} = {}) {
  const RoomType = getRoomTypeModel(connection);
  const filter = {};
  if (isActive !== undefined) filter.isActive = isActive;

  const total = await RoomType.countDocuments(filter);
  const roomTypes = await RoomType.find(filter)
    .sort({ name: 1, code: 1 })
    .skip(offset)
    .limit(limit)
    .lean();

  return {
    items: roomTypes.map(toSafeRoomType),
    total,
    limit,
    offset,
  };
}

export async function getRoomType({ connection, id } = {}) {
  const normalizedId = validateObjectIdString(id, "id");
  const roomType = await findRoomType(connection, normalizedId);
  return { roomType: toSafeRoomType(roomType) };
}

export async function createRoomType({
  connection,
  input,
  actor = null,
  request = null,
} = {}) {
  const validated = validateRoomTypePayload(input);
  await assertCodeAvailable(connection, validated.code);

  const RoomType = getRoomTypeModel(connection);
  let created;
  try {
    created = await RoomType.create(validated);
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict("A room type with this code already exists", "code");
    }
    throw error;
  }

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.ROOM_TYPE_CREATED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "RoomType",
    entityId: created._id ? String(created._id) : null,
    metadata: {
      code: created.code,
      name: created.name,
      capacity: created.capacity,
      baseNightlyRate: created.baseNightlyRate,
    },
    request,
  });

  return { roomType: toSafeRoomType(created) };
}

export async function updateRoomType({
  connection,
  id,
  input,
  actor = null,
  request = null,
} = {}) {
  const normalizedId = validateObjectIdString(id, "id");
  const validated = validateRoomTypePayload(input, { partial: true });
  if (Object.keys(validated).length === 0) {
    throw new HotelValidationError({ body: "at least one field is required" });
  }
  if (validated.isActive === false) {
    throw new HotelValidationError({
      isActive:
        "isActive cannot be set to false here; use the room type deactivate endpoint",
    });
  }

  const existing = await findRoomType(connection, normalizedId);

  if (validated.code && validated.code !== existing.code) {
    await assertCodeAvailable(connection, validated.code, normalizedId);
  }

  const RoomType = getRoomTypeModel(connection);
  try {
    await RoomType.updateOne(
      { _id: normalizedId },
      { $set: validated },
      { runValidators: true }
    );
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict("A room type with this code already exists", "code");
    }
    throw error;
  }

  const updated = await findRoomType(connection, normalizedId);

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.ROOM_TYPE_UPDATED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "RoomType",
    entityId: String(updated._id),
    metadata: {
      changedFields: Object.keys(validated),
      code: updated.code,
    },
    request,
  });

  return { roomType: toSafeRoomType(updated) };
}

export async function deactivateRoomType({
  connection,
  id,
  actor = null,
  request = null,
} = {}) {
  const normalizedId = validateObjectIdString(id, "id");
  const existing = await findRoomType(connection, normalizedId);

  if (existing.isActive === false) {
    return {
      roomType: toSafeRoomType(existing),
      changed: false,
    };
  }

  await assertNoActiveRooms(connection, normalizedId);

  const RoomType = getRoomTypeModel(connection);
  await RoomType.updateOne(
    { _id: normalizedId, isActive: true },
    { $set: { isActive: false } },
    { runValidators: true }
  );

  const updated = await findRoomType(connection, normalizedId);

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.ROOM_TYPE_DEACTIVATED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "RoomType",
    entityId: String(updated._id),
    metadata: {
      code: updated.code,
      name: updated.name,
    },
    request,
  });

  return {
    roomType: toSafeRoomType(updated),
    changed: true,
  };
}
