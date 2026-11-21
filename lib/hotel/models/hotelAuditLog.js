import mongoose from "mongoose";

import {
  HOTEL_AUDIT_OUTCOMES,
  HOTEL_ROLES,
} from "../constants.js";

// Append-only Hotel audit foundation. Raw IPs, user agents, cookies, tokens,
// and passwords must never be written here. Callers pass request metadata and
// the service stores only one-way hashes plus sanitized metadata.

const HotelAuditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    outcome: {
      type: String,
      enum: HOTEL_AUDIT_OUTCOMES,
      required: true,
    },
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      default: null,
    },
    actorRole: {
      type: String,
      enum: [...HOTEL_ROLES, null],
      default: null,
    },
    entityType: {
      type: String,
      trim: true,
      maxlength: 60,
      default: null,
    },
    entityId: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    requestId: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    ipHash: {
      type: String,
      default: null,
      maxlength: 64,
    },
    userAgentHash: {
      type: String,
      default: null,
      maxlength: 64,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    strict: "throw",
    versionKey: false,
    collection: "hotel_audit_logs",
  }
);

HotelAuditLogSchema.index({ actorUserId: 1, createdAt: -1 });
HotelAuditLogSchema.index({ action: 1, createdAt: -1 });
HotelAuditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export function getHotelAuditLogModel(connection) {
  if (!connection?.models) {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  if (connection.models.HotelAuditLog) {
    return connection.models.HotelAuditLog;
  }
  if (typeof connection.model !== "function") {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  return connection.model(
    "HotelAuditLog",
    HotelAuditLogSchema,
    "hotel_audit_logs"
  );
}

export { HotelAuditLogSchema };
