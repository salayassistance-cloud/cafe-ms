import mongoose from "mongoose";

import {
  HOTEL_ROLES,
  HOTEL_STAFF_CREATED_VIA,
  HOTEL_USERNAME_MAX_LENGTH,
} from "../constants.js";

// A Hotel identity is never a POS `Staff` record.
//
// `passwordHash` and `username` remain dormant historical fields: no runtime
// authentication uses them. `pinHash`, `pinSetAt`, `pinFailedAttempts` and
// `pinLockedUntil` back the approved Hotel-only identity+PIN login, and the
// attribution fields record staff provenance. Deleting fields, indexes, or
// rows is a separately approved database migration and remains out of scope.
// Only POST /api/hotel/auth/login can issue a Hotel session.

const HotelUserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    username: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: HOTEL_USERNAME_MAX_LENGTH,
      default: null,
    },
    passwordHash: {
      type: String,
      default: null,
      select: false,
    },
    pinHash: {
      type: String,
      default: null,
      select: false,
    },
    role: {
      type: String,
      enum: HOTEL_ROLES,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },

    // Phase 2 credential lifecycle. These fields are metadata about a staff
    // identity; they never grant authority and are never populated from the
    // client. PIN hashes remain excluded from normal queries.
    pinSetAt: {
      type: Date,
      default: null,
    },
    pinFailedAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    pinLockedUntil: {
      type: Date,
      default: null,
    },
    // Attribution only. These ObjectIds reference other HotelUser `_id`s, the
    // same immutable identities already used by historical Hotel records, so
    // deactivation never breaks historical references.
    createdByStaffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      default: null,
    },
    updatedByStaffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      default: null,
    },
    createdVia: {
      type: String,
      enum: HOTEL_STAFF_CREATED_VIA,
      default: "LEGACY",
    },
  },
  {
    timestamps: true,
    strict: "throw",
    versionKey: false,
    collection: "hotel_users",
  }
);

HotelUserSchema.index({ email: 1 }, { unique: true });
// Existing accounts may predate username login. The partial filter keeps the
// unique guarantee only for real string usernames, so legacy rows without one
// do not collide with each other.
HotelUserSchema.index(
  { username: 1 },
  {
    unique: true,
    partialFilterExpression: { username: { $type: "string" } },
  }
);
HotelUserSchema.index({ role: 1, isActive: 1 });

export function getHotelUserModel(connection) {
  if (!connection?.models) {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  if (connection.models.HotelUser) return connection.models.HotelUser;
  if (typeof connection.model !== "function") {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  return connection.model("HotelUser", HotelUserSchema, "hotel_users");
}

export function toSafeHotelUser(user) {
  if (!user) return null;
  return {
    id: String(user._id ?? user.id),
    email: user.email,
    username: user.username ?? null,
    name: user.name,
    role: user.role,
    isActive: user.isActive === true,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

export { HotelUserSchema };
