import mongoose from "mongoose";

import { HOTEL_GUEST_ID_TYPES } from "../constants.js";

// Guests are never hard-deleted. Deactivation preserves every reservation and
// stay that references the guest. The model is compiled only on the dedicated
// Hotel connection; indexes are defined here but never built automatically.
//
// There is deliberately no unique index on phone/email: families and corporate
// bookers legitimately share contact details.

const GuestSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
      match: /^\+?[0-9][0-9()\-\s]{2,29}$/,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      default: null,
    },
    nationality: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "",
    },
    idType: {
      type: String,
      enum: [...HOTEL_GUEST_ID_TYPES, null],
      default: null,
    },
    idNumber: {
      type: String,
      trim: true,
      maxlength: 60,
      default: "",
    },
    address: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "",
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    strict: "throw",
    versionKey: false,
    collection: "hotel_guests",
  }
);

GuestSchema.index({ lastName: 1, firstName: 1 });
GuestSchema.index({ phone: 1 });
GuestSchema.index({ isActive: 1, lastName: 1, firstName: 1 });

export function getGuestModel(connection) {
  if (!connection?.models) {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  if (connection.models.Guest) return connection.models.Guest;
  if (typeof connection.model !== "function") {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  return connection.model("Guest", GuestSchema, "hotel_guests");
}

export function toSafeHotelGuest(guest) {
  if (!guest) return null;
  const id = guest._id ?? guest.id;
  const firstName = guest.firstName ?? "";
  const lastName = guest.lastName ?? "";

  return {
    id: id ? String(id) : null,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    phone: guest.phone ?? "",
    email: guest.email ?? null,
    nationality: guest.nationality ?? "",
    idType: guest.idType ?? null,
    idNumber: guest.idNumber ?? "",
    address: guest.address ?? "",
    notes: guest.notes ?? "",
    isActive: guest.isActive === true,
    createdAt: guest.createdAt ?? null,
    updatedAt: guest.updatedAt ?? null,
  };
}

export function toSafeHotelGuestSummary(guest) {
  const safe = toSafeHotelGuest(guest);
  if (!safe) return null;
  return {
    id: safe.id,
    firstName: safe.firstName,
    lastName: safe.lastName,
    fullName: safe.fullName,
    phone: safe.phone,
    email: safe.email,
    isActive: safe.isActive,
  };
}

export { GuestSchema };
