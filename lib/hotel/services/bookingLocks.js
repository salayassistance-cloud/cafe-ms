import crypto from "crypto";

import { HOTEL_BOOKING_LOCK_TTL_MS } from "../constants.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
  HotelValidationError,
} from "../errors.js";
import { getRoomBookingLockModel } from "../models/roomBookingLock.js";
import { validateObjectIdString } from "../validation.js";

// Per-room booking mutex.
//
// MongoDB always enforces uniqueness on `_id`, so creating a lock document with
// `_id = roomId` is atomic even before any custom index is deployed. Concurrent
// booking attempts for the same room therefore serialize around the overlap
// check and the reservation write.
//
// Locks expire so a crashed request cannot block a room forever. The TTL index
// is defined in the model only; expired locks are also stolen atomically here,
// so cleanup does not depend on a TTL monitor being enabled.

function bookingBusy({
  message = "Room is currently being booked; retry shortly",
  field = "roomId",
} = {}) {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.CONFLICT,
    message,
    status: 409,
    expose: true,
    details: { field },
  });
}

function normalizeOwner(owner) {
  if (typeof owner !== "string" || owner.trim() === "") {
    throw new HotelValidationError({
      owner: "A booking lock owner is required",
    });
  }
  const value = owner.trim();
  if (value.length > 100) {
    throw new HotelValidationError({
      owner: "A booking lock owner must be at most 100 characters",
    });
  }
  return value;
}

export function createHotelRoomBookingLockOwner() {
  return crypto.randomUUID();
}

export async function acquireHotelRoomBookingLock({
  connection,
  roomId,
  owner,
  now = Date.now(),
} = {}) {
  const normalizedRoomId = validateObjectIdString(roomId, "roomId");
  const normalizedOwner = normalizeOwner(owner);
  const Lock = getRoomBookingLockModel(connection);
  const expiresAt = new Date(now + HOTEL_BOOKING_LOCK_TTL_MS);

  try {
    await Lock.create({
      _id: normalizedRoomId,
      owner: normalizedOwner,
      expiresAt,
    });
    return true;
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  // The lock already exists. Steal it only if it has expired; the filter and
  // update are a single atomic operation, so two contenders cannot both win.
  const stolen = await Lock.findOneAndUpdate(
    {
      _id: normalizedRoomId,
      expiresAt: { $lte: new Date(now) },
    },
    { $set: { owner: normalizedOwner, expiresAt } },
    { new: true }
  );

  return Boolean(stolen && stolen.owner === normalizedOwner);
}

export async function releaseHotelRoomBookingLock({
  connection,
  roomId,
  owner,
} = {}) {
  const normalizedRoomId = validateObjectIdString(roomId, "roomId");
  const normalizedOwner = normalizeOwner(owner);
  const Lock = getRoomBookingLockModel(connection);

  // Releasing is scoped to this owner so a delayed request can never delete a
  // lock that a newer owner has already acquired.
  await Lock.deleteOne({ _id: normalizedRoomId, owner: normalizedOwner });
  return true;
}

export async function withHotelRoomBookingLocks({
  connection,
  roomIds = [],
  owner,
  now = Date.now(),
  busyMessage,
  busyField,
  fn,
} = {}) {
  if (typeof fn !== "function") {
    throw new TypeError("withHotelRoomBookingLocks requires a function");
  }

  // Sorting unique room ids gives every caller the same acquisition order and
  // prevents deadlocks when a reservation moves between two rooms.
  const normalizedRoomIds = [
    ...new Set(
      roomIds
        .filter((roomId) => roomId != null && roomId !== "")
        .map((roomId) => validateObjectIdString(roomId, "roomId"))
    ),
  ].sort();

  if (normalizedRoomIds.length === 0) return fn();

  const lockOwner = normalizeOwner(owner ?? createHotelRoomBookingLockOwner());
  const acquired = [];

  try {
    for (const roomId of normalizedRoomIds) {
      const locked = await acquireHotelRoomBookingLock({
        connection,
        roomId,
        owner: lockOwner,
        now,
      });
      if (!locked) {
        throw bookingBusy({ message: busyMessage, field: busyField });
      }
      acquired.push(roomId);
    }
    return await fn();
  } finally {
    for (const roomId of acquired) {
      try {
        await releaseHotelRoomBookingLock({
          connection,
          roomId,
          owner: lockOwner,
        });
      } catch {
        // The lock expires on its own. A release failure must never mask the
        // booking result or the original error.
      }
    }
  }
}
