import mongoose from "mongoose";

// Transient per-room booking mutex. `_id` is the string form of the room
// ObjectId, so MongoDB's always-present unique `_id` index provides mutual
// exclusion without deploying a custom index.
//
// Locks are short-lived. The TTL index below is DEFINED only and is not built
// automatically (`autoIndex: false`). Expired locks can be stolen atomically by
// the booking service even before a TTL monitor removes them.
//
// Lock rows are operational coordination records, not business history, so the
// booking service may delete its own lock in a `finally` block.

const RoomBookingLockSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    owner: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: false,
    strict: "throw",
    versionKey: false,
    collection: "hotel_room_booking_locks",
  }
);

RoomBookingLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export function getRoomBookingLockModel(connection) {
  if (!connection?.models) {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  if (connection.models.RoomBookingLock) {
    return connection.models.RoomBookingLock;
  }
  if (typeof connection.model !== "function") {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  return connection.model(
    "RoomBookingLock",
    RoomBookingLockSchema,
    "hotel_room_booking_locks"
  );
}

export { RoomBookingLockSchema };
