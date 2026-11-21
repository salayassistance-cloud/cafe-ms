import mongoose from "mongoose";

import {
  HOTEL_MAX_STAY_NIGHTS,
  HOTEL_RESERVATION_STATUSES,
} from "../constants.js";
import { formatHotelLocalDate } from "../dates.js";

// Reservations snapshot the guest, room type, and agreed nightly rate at the
// time of booking. Later changes to a guest record, room type rate, or room
// number therefore do not rewrite an existing reservation's commercial terms.
//
// Indexes are DEFINED here but never built automatically. In particular, the
// unique reservationNumber index and the room/status/date overlap index require
// an approved Hotel-only index deployment before they become durable database
// constraints.

const GuestSnapshotSchema = new mongoose.Schema(
  {
    firstName: { type: String, trim: true, maxlength: 80, required: true },
    lastName: { type: String, trim: true, maxlength: 80, required: true },
    fullName: { type: String, trim: true, maxlength: 161, required: true },
    phone: { type: String, trim: true, maxlength: 30, required: true },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
  },
  { _id: false, strict: "throw", versionKey: false }
);

const RoomTypeSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 100, required: true },
    code: { type: String, trim: true, uppercase: true, maxlength: 30, required: true },
    capacity: { type: Number, min: 1, max: 100, required: true },
    baseNightlyRate: { type: Number, min: 0, max: 1_000_000_000, required: true },
  },
  { _id: false, strict: "throw", versionKey: false }
);

const RoomSnapshotSchema = new mongoose.Schema(
  {
    roomNumber: { type: String, trim: true, uppercase: true, maxlength: 20, required: true },
    floor: { type: Number, min: -10, max: 200, required: true },
  },
  { _id: false, strict: "throw", versionKey: false }
);

const ReservationStatusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: HOTEL_RESERVATION_STATUSES,
      required: true,
    },
    previousStatus: {
      type: String,
      enum: [...HOTEL_RESERVATION_STATUSES, null],
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
  { _id: false, strict: "throw", versionKey: false }
);

const ReservationSchema = new mongoose.Schema(
  {
    reservationNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
      match: /^RES-\d{8}-[A-F0-9]{6}$/,
    },
    guestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      required: true,
    },
    guestSnapshot: {
      type: GuestSnapshotSchema,
      required: true,
    },
    roomTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoomType",
      required: true,
    },
    roomTypeSnapshot: {
      type: RoomTypeSnapshotSchema,
      required: true,
    },
    roomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Room",
      default: null,
    },
    roomSnapshot: {
      type: RoomSnapshotSchema,
      default: null,
    },
    arrivalDate: {
      type: Date,
      required: true,
    },
    departureDate: {
      type: Date,
      required: true,
    },
    nights: {
      type: Number,
      required: true,
      min: 1,
      max: HOTEL_MAX_STAY_NIGHTS,
      validate: {
        validator: Number.isInteger,
        message: "nights must be an integer",
      },
    },
    adults: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
      validate: {
        validator: Number.isInteger,
        message: "adults must be an integer",
      },
    },
    children: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      validate: {
        validator: Number.isInteger,
        message: "children must be an integer",
      },
    },
    nightlyRate: {
      type: Number,
      required: true,
      min: 0,
      max: 1_000_000_000,
    },
    rateSource: {
      type: String,
      enum: ["ROOM_TYPE_BASE", "ROOM_OVERRIDE"],
      required: true,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
      max: 1_000_000_000_000,
    },
    status: {
      type: String,
      enum: HOTEL_RESERVATION_STATUSES,
      default: "CONFIRMED",
      required: true,
    },
    stayId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Stay",
      default: null,
    },
    checkedInAt: {
      type: Date,
      default: null,
    },
    checkedInBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      default: null,
    },
    checkedOutAt: {
      type: Date,
      default: null,
    },
    checkedOutBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      default: null,
    },
    cancellationReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      default: null,
    },
    statusHistory: {
      type: [ReservationStatusHistorySchema],
      default: [],
    },
  },
  {
    timestamps: true,
    strict: "throw",
    versionKey: false,
    collection: "hotel_reservations",
  }
);

ReservationSchema.index({ reservationNumber: 1 }, { unique: true });
ReservationSchema.index({
  roomId: 1,
  status: 1,
  arrivalDate: 1,
  departureDate: 1,
});
ReservationSchema.index({ guestId: 1, arrivalDate: -1 });
ReservationSchema.index({ status: 1, arrivalDate: 1 });
ReservationSchema.index({ roomTypeId: 1, arrivalDate: 1 });

export function getReservationModel(connection) {
  if (!connection?.models) {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  if (connection.models.Reservation) return connection.models.Reservation;
  if (typeof connection.model !== "function") {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  return connection.model(
    "Reservation",
    ReservationSchema,
    "hotel_reservations"
  );
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function idString(value) {
  const id = value?._id ?? value;
  return id ? String(id) : null;
}

function guestSnapshotOf(reservation) {
  const snapshot = reservation.guestSnapshot ?? {};
  const firstName = snapshot.firstName ?? "";
  const lastName = snapshot.lastName ?? "";
  return {
    firstName,
    lastName,
    fullName: snapshot.fullName ?? `${firstName} ${lastName}`.trim(),
    phone: snapshot.phone ?? "",
    email: snapshot.email ?? null,
  };
}

function roomTypeSnapshotOf(reservation) {
  const snapshot = reservation.roomTypeSnapshot ?? {};
  return {
    name: snapshot.name ?? "",
    code: snapshot.code ?? "",
    capacity: snapshot.capacity ?? null,
    baseNightlyRate: snapshot.baseNightlyRate ?? null,
  };
}

function roomSnapshotOf(reservation) {
  if (!reservation.roomSnapshot) return null;
  return {
    roomNumber: reservation.roomSnapshot.roomNumber ?? "",
    floor: reservation.roomSnapshot.floor ?? null,
  };
}

function currentGuestSummary(guest) {
  if (!guest) return null;
  const firstName = guest.firstName ?? "";
  const lastName = guest.lastName ?? "";
  return {
    id: idString(guest),
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    phone: guest.phone ?? "",
    email: guest.email ?? null,
    isActive: guest.isActive === true,
  };
}

function currentRoomTypeSummary(roomType) {
  if (!roomType) return null;
  return {
    id: idString(roomType),
    name: roomType.name ?? "",
    code: roomType.code ?? "",
    capacity: roomType.capacity ?? null,
    baseNightlyRate: roomType.baseNightlyRate ?? null,
    isActive: roomType.isActive === true,
  };
}

function currentRoomSummary(room) {
  if (!room) return null;
  return {
    id: idString(room),
    roomNumber: room.roomNumber ?? "",
    floor: room.floor ?? null,
    roomTypeId: idString(room.roomTypeId),
    capacity: room.capacity ?? null,
    isActive: room.isActive === true,
    operationalStatus: room.operationalStatus ?? null,
  };
}

function statusHistoryOf(reservation) {
  if (!Array.isArray(reservation.statusHistory)) return [];
  return reservation.statusHistory.map((entry) => ({
    status: entry.status,
    previousStatus: entry.previousStatus ?? null,
    changedAt: iso(entry.changedAt),
    changedBy: idString(entry.changedBy),
    note: entry.note ?? "",
  }));
}

export function toSafeHotelReservation(
  reservation,
  { guest = null, roomType = null, room = null, includeHistory = true } = {}
) {
  if (!reservation) return null;
  const cancellation =
    reservation.cancelledAt || reservation.status === "CANCELLED"
      ? {
          cancelledAt: iso(reservation.cancelledAt),
          cancelledBy: idString(reservation.cancelledBy),
          reason: reservation.cancellationReason ?? "",
        }
      : null;

  const safe = {
    id: idString(reservation),
    reservationNumber: reservation.reservationNumber,
    status: reservation.status,
    guestId: idString(reservation.guestId),
    guest: currentGuestSummary(guest),
    guestSnapshot: guestSnapshotOf(reservation),
    roomTypeId: idString(reservation.roomTypeId),
    roomType: currentRoomTypeSummary(roomType),
    roomTypeSnapshot: roomTypeSnapshotOf(reservation),
    roomId: idString(reservation.roomId),
    room: currentRoomSummary(room),
    roomSnapshot: roomSnapshotOf(reservation),
    arrivalDate: iso(reservation.arrivalDate),
    departureDate: iso(reservation.departureDate),
    arrivalLocalDate: reservation.arrivalDate
      ? formatHotelLocalDate(reservation.arrivalDate)
      : null,
    departureLocalDate: reservation.departureDate
      ? formatHotelLocalDate(reservation.departureDate)
      : null,
    nights: reservation.nights,
    adults: reservation.adults,
    children: reservation.children ?? 0,
    nightlyRate: reservation.nightlyRate,
    rateSource: reservation.rateSource,
    totalAmount: reservation.totalAmount,
    notes: reservation.notes ?? "",
    stayId: idString(reservation.stayId),
    checkedInAt: iso(reservation.checkedInAt),
    checkedInBy: idString(reservation.checkedInBy),
    checkedOutAt: iso(reservation.checkedOutAt),
    checkedOutBy: idString(reservation.checkedOutBy),
    cancellation,
    createdBy: idString(reservation.createdBy),
    updatedBy: idString(reservation.updatedBy),
    createdAt: iso(reservation.createdAt),
    updatedAt: iso(reservation.updatedAt),
  };

  if (includeHistory) safe.statusHistory = statusHistoryOf(reservation);
  return safe;
}

export function toSafeHotelReservationSummary(reservation, refs = {}) {
  return toSafeHotelReservation(reservation, {
    ...refs,
    includeHistory: false,
  });
}

export {
  GuestSnapshotSchema,
  ReservationSchema,
  ReservationStatusHistorySchema,
  RoomSnapshotSchema,
  RoomTypeSnapshotSchema,
};
