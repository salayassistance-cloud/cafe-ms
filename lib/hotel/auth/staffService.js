// Hotel staff management service (Phase 3D).
//
// All mutating targets must be RECEPTIONIST identities. Manager accounts are
// provisioned only by the operator CLI and can never be created, promoted,
// demoted, reset, deactivated or deleted through this service.
// No credential hash, session token, CSRF secret, or PIN value is returned.

import crypto from "crypto";

import { getHotelUserModel } from "../models/hotelUser.js";
import { HOTEL_ERROR_CODES, HotelApiError } from "../errors.js";
import { sanitizeHotelText, validateHotelPin } from "../validation.js";
import { findHotelPinCollision, setHotelUserPin } from "./credential.js";
import { hashHotelPin } from "./pin.js";

export const HOTEL_STAFF_MANAGED_ROLE = "RECEPTIONIST";

function forbidden(message) {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.FORBIDDEN,
    status: 403,
    message,
    expose: true,
  });
}

function conflict(message) {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.CONFLICT,
    status: 409,
    message,
    expose: true,
  });
}

export function toSafeStaffSummary(user) {
  if (!user) return null;
  return {
    id: String(user._id ?? user.id),
    name: user.name,
    role: user.role,
    isActive: user.isActive === true,
    pinSetAt: user.pinSetAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    createdVia: user.createdVia ?? null,
    createdByStaffId: user.createdByStaffId
      ? String(user.createdByStaffId)
      : null,
    updatedAt: user.updatedAt ?? null,
  };
}

export function validateReceptionistName(value) {
  return sanitizeHotelText(value, { field: "name", maxLength: 100 });
}

// Never operate on a non-Receptionist, including a Manager target.
export function assertReceptionistTarget(user) {
  if (!user || user.role !== HOTEL_STAFF_MANAGED_ROLE) {
    throw forbidden("Only Receptionist accounts can be managed here");
  }
  return user;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findNameCollision(connection, name, exceptId = null) {
  const HotelUser = getHotelUserModel(connection);
  const filter = {
    role: HOTEL_STAFF_MANAGED_ROLE,
    name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
  };
  if (exceptId) filter._id = { $ne: exceptId };
  return HotelUser.findOne(filter).select("_id").lean();
}

export async function listManagedStaff(connection) {
  const HotelUser = getHotelUserModel(connection);
  const users = await HotelUser.find({ role: HOTEL_STAFF_MANAGED_ROLE })
    .select("_id name role isActive pinSetAt lastLoginAt createdVia createdByStaffId updatedAt")
    .sort({ name: 1 })
    .lean();
  return users.map(toSafeStaffSummary);
}

export async function getManagedStaff(connection, id) {
  const HotelUser = getHotelUserModel(connection);
  const user = await HotelUser.findById(id).lean();
  assertReceptionistTarget(user);
  return toSafeStaffSummary(user);
}

export async function snapshotManagedStaff(connection, id) {
  const HotelUser = getHotelUserModel(connection);
  const user = await HotelUser.findById(id).select("+pinHash").lean();
  assertReceptionistTarget(user);
  return {
    user,
    before: {
      name: user.name,
      isActive: user.isActive,
      pinHash: user.pinHash,
      pinSetAt: user.pinSetAt,
      pinFailedAttempts: user.pinFailedAttempts,
      pinLockedUntil: user.pinLockedUntil,
      updatedByStaffId: user.updatedByStaffId,
      updatedAt: user.updatedAt,
    },
  };
}

// Compensation helper used only when a REQUIRED audit write fails: no
// sensitive mutation is reported as successful without audit evidence.
// Phase 3F / E-19: compensation matches the POST-mutation updatedAt returned
// by the service, so it restores our own change but never overwrites a later
// concurrent change. Returns false when the conditional restore matched none.
export async function restoreManagedStaff(connection, id, before, expectedUpdatedAt = null) {
  if (!before) return false;
  const HotelUser = getHotelUserModel(connection);
  const filter = { _id: id };
  const expected = expectedUpdatedAt || before.updatedAt;
  if (expected) filter.updatedAt = expected;
  const result = await HotelUser.updateOne(filter, { $set: before });
  return (result.modifiedCount ?? 0) > 0;
}

// Used only to roll back a just-created record when its audit write fails.
export async function removeJustCreatedStaff(connection, id) {
  const HotelUser = getHotelUserModel(connection);
  return HotelUser.deleteOne({ _id: id, createdVia: "STAFF_MANAGEMENT" });
}

export async function createReceptionist(connection, { name, pin, actorId }) {
  const cleanName = validateReceptionistName(name);
  validateHotelPin(pin);
  if (!actorId) throw forbidden("Manager identity is required");

  if (await findNameCollision(connection, cleanName)) {
    throw conflict("A Receptionist with that name already exists");
  }
  if (await findHotelPinCollision(connection, pin)) {
    throw conflict("That PIN is already assigned to another Hotel identity");
  }

  const HotelUser = getHotelUserModel(connection);
  // HotelUser.email is a required unique schema field. A non-routable opaque
  // address avoids making email a credential or requiring it from the Manager.
  const email = `${crypto.randomBytes(12).toString("hex")}@hotel.invalid`;
  const created = await HotelUser.create({
    email,
    name: cleanName,
    role: HOTEL_STAFF_MANAGED_ROLE,
    isActive: true,
    username: null,
    passwordHash: null,
    pinHash: hashHotelPin(pin),
    pinSetAt: new Date(),
    pinFailedAttempts: 0,
    pinLockedUntil: null,
    createdVia: "STAFF_MANAGEMENT",
    createdByStaffId: actorId,
    updatedByStaffId: actorId,
  });
  return toSafeStaffSummary(created);
}

export async function renameReceptionist(connection, id, name, actorId) {
  const { user } = await snapshotManagedStaff(connection, id);
  const cleanName = validateReceptionistName(name);
  if (await findNameCollision(connection, cleanName, user._id)) {
    throw conflict("A Receptionist with that name already exists");
  }
  const HotelUser = getHotelUserModel(connection);
  await HotelUser.updateOne(
    { _id: user._id },
    { $set: { name: cleanName, updatedByStaffId: actorId } }
  );
  const fresh = await HotelUser.findById(user._id).lean();
  return toSafeStaffSummary(fresh);
}

export async function resetReceptionistPin(connection, id, pin, actorId) {
  const { user } = await snapshotManagedStaff(connection, id);
  validateHotelPin(pin);
  if (await findHotelPinCollision(connection, pin, { exceptUserId: user._id })) {
    throw conflict("That PIN is already assigned to another Hotel identity");
  }
  await setHotelUserPin(connection, user._id, pin);
  const HotelUser = getHotelUserModel(connection);
  await HotelUser.updateOne(
    { _id: user._id },
    { $set: { updatedByStaffId: actorId } }
  );
  const fresh = await HotelUser.findById(user._id).lean();
  return toSafeStaffSummary(fresh);
}

export async function setReceptionistActive(connection, id, isActive, actorId) {
  const { user } = await snapshotManagedStaff(connection, id);
  if (typeof isActive !== "boolean") {
    throw new HotelApiError({
      code: HOTEL_ERROR_CODES.VALIDATION_ERROR,
      status: 422,
      message: "isActive must be a boolean",
      expose: true,
    });
  }
  if (!isActive && actorId && String(user._id) === String(actorId)) {
    throw forbidden("You cannot deactivate your own account");
  }
  const HotelUser = getHotelUserModel(connection);
  await HotelUser.updateOne(
    { _id: user._id },
    { $set: { isActive, updatedByStaffId: actorId } }
  );
  const fresh = await HotelUser.findById(user._id).lean();
  return toSafeStaffSummary(fresh);
}
