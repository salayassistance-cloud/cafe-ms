import mongoose from "mongoose";

import {
  HOTEL_ROOM_NUMBER_MAX_LENGTH,
  HOTEL_ROOM_NUMBER_RE,
  HOTEL_ROOM_OPERATIONAL_STATUSES,
} from "../constants.js";

// A Room is always compiled on the dedicated Hotel connection. It references a
// RoomType by ObjectId; room types are never hard-deleted, so historical room
// records keep a valid reference even after the type is deactivated.
//
// Indexes are DEFINED here but never built automatically: the Hotel connection
// sets `autoIndex: false`. Do not create them on a live database without
// explicit approval.

const RoomStatusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: HOTEL_ROOM_OPERATIONAL_STATUSES,
      required: true,
    },
    previousStatus: {
      type: String,
      enum: [...HOTEL_ROOM_OPERATIONAL_STATUSES, null],
      default: null,
    },
    changedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      default: null,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
  },
  {
    _id: false,
    strict: "throw",
    versionKey: false,
  }
);

const RoomSchema = new mongoose.Schema(
  {
    roomNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: HOTEL_ROOM_NUMBER_MAX_LENGTH,
      match: HOTEL_ROOM_NUMBER_RE,
    },
    floor: {
      type: Number,
      required: true,
      min: -10,
      max: 200,
      validate: {
        validator: Number.isInteger,
        message: "floor must be an integer",
      },
    },
    roomTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoomType",
      required: true,
    },
    capacity: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
      validate: {
        validator: Number.isInteger,
        message: "capacity must be an integer",
      },
    },
    amenities: {
      type: [
        {
          type: String,
          trim: true,
          maxlength: 80,
        },
      ],
      default: [],
      validate: {
        validator(value) {
          if (!Array.isArray(value) || value.length > 30) return false;
          return new Set(value).size === value.length;
        },
        message: "amenities must contain at most 30 unique entries",
      },
    },
    nightlyRateOverride: {
      type: Number,
      default: null,
      min: 0,
      max: 1_000_000_000,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    operationalStatus: {
      type: String,
      enum: HOTEL_ROOM_OPERATIONAL_STATUSES,
      default: "AVAILABLE",
      required: true,
    },
    statusHistory: {
      type: [RoomStatusHistorySchema],
      default: [],
    },
  },
  {
    timestamps: true,
    strict: "throw",
    versionKey: false,
    collection: "hotel_rooms",
  }
);

// Application checks give friendly conflicts; the unique index is the durable
// constraint once index deployment is approved.
RoomSchema.index({ roomNumber: 1 }, { unique: true });
RoomSchema.index({ roomTypeId: 1, isActive: 1 });
RoomSchema.index({ floor: 1, roomNumber: 1 });
RoomSchema.index({ operationalStatus: 1, isActive: 1 });

export function getRoomModel(connection) {
  if (!connection?.models) {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  if (connection.models.Room) return connection.models.Room;
  if (typeof connection.model !== "function") {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  return connection.model("Room", RoomSchema, "hotel_rooms");
}

export function toSafeHotelRoom(room, roomType = null) {
  if (!room) return null;

  const id = room._id ?? room.id;
  const rawRoomTypeId = room.roomTypeId?._id ?? room.roomTypeId;
  const statusHistory = Array.isArray(room.statusHistory)
    ? room.statusHistory.map((entry) => {
        const changedBy = entry.changedBy?._id ?? entry.changedBy;
        return {
          status: entry.status,
          previousStatus: entry.previousStatus ?? null,
          changedAt: entry.changedAt ?? null,
          changedBy: changedBy ? String(changedBy) : null,
          note: entry.note ?? "",
        };
      })
    : [];

  return {
    id: id ? String(id) : null,
    roomNumber: room.roomNumber,
    floor: room.floor,
    roomTypeId: rawRoomTypeId ? String(rawRoomTypeId) : null,
    roomType: roomType
      ? {
          id: String(roomType._id ?? roomType.id),
          name: roomType.name,
          code: roomType.code,
          capacity: roomType.capacity,
          baseNightlyRate: roomType.baseNightlyRate,
          isActive: roomType.isActive === true,
        }
      : null,
    capacity: room.capacity,
    amenities: Array.isArray(room.amenities) ? [...room.amenities] : [],
    nightlyRateOverride: room.nightlyRateOverride ?? null,
    effectiveNightlyRate:
      room.nightlyRateOverride ?? roomType?.baseNightlyRate ?? null,
    isActive: room.isActive === true,
    operationalStatus: room.operationalStatus,
    statusHistory,
    createdAt: room.createdAt ?? null,
    updatedAt: room.updatedAt ?? null,
  };
}

export { RoomSchema, RoomStatusHistorySchema };
