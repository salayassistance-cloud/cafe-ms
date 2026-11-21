import {
  HOTEL_ACTIVE_RESERVATION_STATUSES,
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
import {
  getGuestModel,
  toSafeHotelGuest,
} from "../models/guest.js";
import { getReservationModel } from "../models/reservation.js";
import {
  validateGuestPayload,
  validateObjectIdString,
} from "../validation.js";

// Hotel Guest service. Guests are never hard-deleted. Deactivation is refused
// while the guest holds an active reservation, and generic updates cannot
// deactivate a guest; the dedicated deactivate endpoint must be used.

function notFound() {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.NOT_FOUND,
    message: "Guest not found",
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function audit(connection, event) {
  await safeRecordHotelAudit(connection, event);
}

export async function findHotelGuest(connection, id) {
  const normalizedId = validateObjectIdString(id, "id");
  const Guest = getGuestModel(connection);
  const guest = await Guest.findById(normalizedId).lean();
  if (!guest) throw notFound();
  return guest;
}

export async function assertActiveHotelGuest(connection, id) {
  const normalizedId = validateObjectIdString(id, "guestId");
  const Guest = getGuestModel(connection);
  const guest = await Guest.findById(normalizedId).lean();
  if (!guest) {
    throw new HotelValidationError({
      guestId: "guestId must reference an existing guest",
    });
  }
  if (guest.isActive !== true) {
    throw new HotelValidationError({
      guestId: "guestId must reference an active guest",
    });
  }
  return guest;
}

export async function listGuests({
  connection,
  isActive,
  search,
  limit = 50,
  offset = 0,
} = {}) {
  const Guest = getGuestModel(connection);
  const filter = {};
  if (isActive !== undefined) filter.isActive = isActive;

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { firstName: pattern },
      { lastName: pattern },
      { phone: pattern },
      { email: pattern },
    ];
  }

  const total = await Guest.countDocuments(filter);
  const guests = await Guest.find(filter)
    .sort({ lastName: 1, firstName: 1, createdAt: 1 })
    .skip(offset)
    .limit(limit)
    .lean();

  return {
    items: guests.map(toSafeHotelGuest),
    total,
    limit,
    offset,
  };
}

export async function getGuest({ connection, id } = {}) {
  const guest = await findHotelGuest(connection, id);
  return { guest: toSafeHotelGuest(guest) };
}

export async function createGuest({
  connection,
  input,
  actor = null,
  request = null,
} = {}) {
  const validated = validateGuestPayload(input);
  const Guest = getGuestModel(connection);
  const created = await Guest.create(validated);

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.GUEST_CREATED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "Guest",
    entityId: created._id ? String(created._id) : null,
    metadata: {
      fullName: `${created.firstName} ${created.lastName}`.trim(),
      isActive: created.isActive === true,
    },
    request,
  });

  return { guest: toSafeHotelGuest(created) };
}

export async function updateGuest({
  connection,
  id,
  input,
  actor = null,
  request = null,
} = {}) {
  const normalizedId = validateObjectIdString(id, "id");
  const validated = validateGuestPayload(input, { partial: true });
  if (Object.keys(validated).length === 0) {
    throw new HotelValidationError({ body: "at least one field is required" });
  }
  if (validated.isActive === false) {
    throw new HotelValidationError({
      isActive:
        "isActive cannot be set to false here; use the guest deactivate endpoint",
    });
  }

  const existing = await findHotelGuest(connection, normalizedId);
  const Guest = getGuestModel(connection);
  await Guest.updateOne(
    { _id: normalizedId },
    { $set: validated },
    { runValidators: true }
  );

  const updated = await findHotelGuest(connection, normalizedId);

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.GUEST_UPDATED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "Guest",
    entityId: String(updated._id),
    metadata: {
      changedFields: Object.keys(validated),
      previousName: `${existing.firstName} ${existing.lastName}`.trim(),
      fullName: `${updated.firstName} ${updated.lastName}`.trim(),
    },
    request,
  });

  return { guest: toSafeHotelGuest(updated) };
}

export async function deactivateGuest({
  connection,
  id,
  actor = null,
  request = null,
} = {}) {
  const normalizedId = validateObjectIdString(id, "id");
  const existing = await findHotelGuest(connection, normalizedId);

  if (existing.isActive === false) {
    return { guest: toSafeHotelGuest(existing), changed: false };
  }

  const Reservation = getReservationModel(connection);
  const activeReservation = await Reservation.exists({
    guestId: normalizedId,
    status: { $in: HOTEL_ACTIVE_RESERVATION_STATUSES },
  });
  if (activeReservation) {
    throw conflict(
      "Guest has active reservations; cancel or complete them first",
      "guestId"
    );
  }

  const Guest = getGuestModel(connection);
  await Guest.updateOne(
    { _id: normalizedId, isActive: true },
    { $set: { isActive: false } },
    { runValidators: true }
  );

  const updated = await findHotelGuest(connection, normalizedId);

  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.GUEST_DEACTIVATED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "Guest",
    entityId: String(updated._id),
    metadata: {
      fullName: `${updated.firstName} ${updated.lastName}`.trim(),
    },
    request,
  });

  return { guest: toSafeHotelGuest(updated), changed: true };
}
