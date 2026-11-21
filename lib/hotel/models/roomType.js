import mongoose from "mongoose";

// The RoomType model must only ever be compiled on the dedicated Hotel
// connection. There is intentionally no default export and no call to
// `mongoose.model("RoomType", ...)` on the default POS connection.

const roomTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 30,
      match: /^[A-Z0-9][A-Z0-9_-]{0,29}$/,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    capacity: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
    },
    baseNightlyRate: {
      type: Number,
      required: true,
      min: 0,
      max: 1_000_000_000,
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
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
    strict: "throw",
    versionKey: false,
  }
);

roomTypeSchema.index({ code: 1 }, { unique: true });
roomTypeSchema.index({ name: 1, isActive: 1 });

export function toSafeRoomType(roomType) {
  if (!roomType) return null;
  return {
    id: String(roomType._id ?? roomType.id),
    name: roomType.name,
    code: roomType.code,
    description: roomType.description ?? "",
    capacity: roomType.capacity,
    baseNightlyRate: roomType.baseNightlyRate,
    amenities: Array.isArray(roomType.amenities)
      ? [...roomType.amenities]
      : [],
    isActive: roomType.isActive === true,
    createdAt: roomType.createdAt ?? null,
    updatedAt: roomType.updatedAt ?? null,
  };
}

export function toSafeRoomTypeSummary(roomType) {
  const safe = toSafeRoomType(roomType);
  if (!safe) return null;
  return {
    id: safe.id,
    name: safe.name,
    code: safe.code,
    capacity: safe.capacity,
    baseNightlyRate: safe.baseNightlyRate,
    isActive: safe.isActive,
  };
}

export function getRoomTypeModel(connection) {
  if (!connection?.models) {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  if (connection.models.RoomType) return connection.models.RoomType;
  if (typeof connection.model !== "function") {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  return connection.model("RoomType", roomTypeSchema);
}

export { roomTypeSchema as RoomTypeSchema };
