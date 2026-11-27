import mongoose from "mongoose";

import {
  HOTEL_EMAIL_MAX_LENGTH,
  HOTEL_ROLES,
  HOTEL_STAFF_CREATED_VIA,
} from "../constants.js";

// Hotel operational staff record (`bono_hotel.hotel_users`).
// Authentication fields and session mechanisms have been removed from the
// Hotel foundation; this model retains operational staff identity and status.

const HotelUserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: HOTEL_EMAIL_MAX_LENGTH,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
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
      default: "STAFF_MANAGEMENT",
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
    name: user.name,
    role: user.role,
    isActive: user.isActive === true,
  };
}

export { HotelUserSchema };
