import mongoose from "mongoose";

import {
  HOTEL_ROLES,
  HOTEL_SESSION_REVOKE_REASONS,
} from "../constants.js";

// Opaque browser cookie -> HMAC token hash -> HotelSession row -> live
// HotelUser. `roleSnapshot` is audit metadata only and MUST NOT authorize a
// request. Authorization always uses the live HotelUser.role.
//
// Indexes are DEFINED here but are never built automatically: the dedicated
// Hotel connection sets `autoIndex: false`. Do not create them on a live
// database without explicit approval.

const HotelSessionSchema = new mongoose.Schema(
  {
    hotelUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      required: true,
    },
    // HMAC-SHA256 hex digest of the random cookie token. The raw token is
    // never stored in MongoDB.
    tokenHash: {
      type: String,
      required: true,
      select: false,
      match: /^[0-9a-f]{64}$/,
    },
    // HMAC-SHA256 of the session-bound CSRF token. The raw CSRF token is
    // returned once to the client and sent back in a request header.
    csrfHash: {
      type: String,
      required: true,
      select: false,
      match: /^[0-9a-f]{64}$/,
    },
    roleSnapshot: {
      type: String,
      enum: HOTEL_ROLES,
      required: true,
    },
    lastSeenAt: {
      type: Date,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    idleExpiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokeReason: {
      type: String,
      enum: [...HOTEL_SESSION_REVOKE_REASONS, "NONE"],
      default: null,
    },
    userAgentHash: {
      type: String,
      default: null,
      maxlength: 64,
    },
    ipHash: {
      type: String,
      default: null,
      maxlength: 64,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    strict: "throw",
    versionKey: false,
    collection: "hotel_sessions",
  }
);

HotelSessionSchema.index({ tokenHash: 1 }, { unique: true });
HotelSessionSchema.index({ hotelUserId: 1, revokedAt: 1 });
HotelSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export function getHotelSessionModel(connection) {
  if (!connection?.models) {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  if (connection.models.HotelSession) return connection.models.HotelSession;
  if (typeof connection.model !== "function") {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  return connection.model(
    "HotelSession",
    HotelSessionSchema,
    "hotel_sessions"
  );
}

export { HotelSessionSchema };
