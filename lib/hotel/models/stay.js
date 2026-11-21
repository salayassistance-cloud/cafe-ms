import mongoose from "mongoose";

import {
  HOTEL_MAX_STAY_NIGHTS,
  HOTEL_STAY_CHARGE_RULE,
  HOTEL_STAY_STATUSES,
} from "../constants.js";
import { formatHotelLocalDate } from "../dates.js";
import {
  GuestSnapshotSchema,
  RoomSnapshotSchema,
  RoomTypeSnapshotSchema,
} from "./reservation.js";

// A Stay is created exactly once per successful check-in and is never
// hard-deleted. It snapshots the reservation's commercial terms so later rate,
// guest, room-type, or room changes cannot rewrite the in-house folio.
//
// Indexes are DEFINED here but never built automatically. The unique
// reservationId index is the durable one-stay-per-reservation backstop; until
// an approved index deployment, the service also checks and serializes check-in
// through the reservation transition and the per-room booking lock.

const StayStatusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: HOTEL_STAY_STATUSES,
      required: true,
    },
    previousStatus: {
      type: String,
      enum: [...HOTEL_STAY_STATUSES, null],
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

const StaySchema = new mongoose.Schema(
  {
    reservationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reservation",
      required: true,
    },
    reservationNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
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
      required: true,
    },
    roomSnapshot: {
      type: RoomSnapshotSchema,
      required: true,
    },
    arrivalDate: {
      type: Date,
      required: true,
    },
    departureDate: {
      type: Date,
      required: true,
    },
    reservationNights: {
      type: Number,
      required: true,
      min: 1,
      max: HOTEL_MAX_STAY_NIGHTS,
      validate: {
        validator: Number.isInteger,
        message: "reservationNights must be an integer",
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
    reservationTotalAmount: {
      type: Number,
      required: true,
      min: 0,
      max: 1_000_000_000_000,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    expectedCheckOutAt: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: HOTEL_STAY_STATUSES,
      default: "IN_HOUSE",
      required: true,
    },
    checkedInAt: {
      type: Date,
      required: true,
    },
    checkedInBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      default: null,
    },
    checkInNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
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
    checkOutNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    billableNights: {
      type: Number,
      default: null,
      min: 1,
      max: HOTEL_MAX_STAY_NIGHTS + 366,
      validate: {
        validator(value) {
          return value == null || Number.isInteger(value);
        },
        message: "billableNights must be an integer",
      },
    },
    roomCharges: {
      type: Number,
      default: null,
      min: 0,
      max: 1_000_000_000_000,
    },
    totalCharges: {
      type: Number,
      default: null,
      min: 0,
      max: 1_000_000_000_000,
    },
    chargeRule: {
      type: String,
      enum: [HOTEL_STAY_CHARGE_RULE, null],
      default: null,
    },
    statusHistory: {
      type: [StayStatusHistorySchema],
      default: [],
    },
  },
  {
    timestamps: true,
    strict: "throw",
    versionKey: false,
    collection: "hotel_stays",
  }
);

StaySchema.index({ reservationId: 1 }, { unique: true });
StaySchema.index({ guestId: 1, checkedInAt: -1 });
StaySchema.index({ roomId: 1, status: 1 });
StaySchema.index({ status: 1, checkedInAt: 1 });
StaySchema.index({ checkedInAt: -1 });

export function getStayModel(connection) {
  if (!connection?.models) {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  if (connection.models.Stay) return connection.models.Stay;
  if (typeof connection.model !== "function") {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  return connection.model("Stay", StaySchema, "hotel_stays");
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function localDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? formatHotelLocalDate(date) : null;
}

function idString(value) {
  const id = value?._id ?? value;
  return id ? String(id) : null;
}

function guestSnapshotOf(stay) {
  const snapshot = stay.guestSnapshot ?? {};
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

function roomTypeSnapshotOf(stay) {
  const snapshot = stay.roomTypeSnapshot ?? {};
  return {
    name: snapshot.name ?? "",
    code: snapshot.code ?? "",
    capacity: snapshot.capacity ?? null,
    baseNightlyRate: snapshot.baseNightlyRate ?? null,
  };
}

function roomSnapshotOf(stay) {
  if (!stay.roomSnapshot) return null;
  return {
    roomNumber: stay.roomSnapshot.roomNumber ?? "",
    floor: stay.roomSnapshot.floor ?? null,
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

function currentReservationSummary(reservation) {
  if (!reservation) return null;
  return {
    id: idString(reservation),
    reservationNumber: reservation.reservationNumber ?? null,
    status: reservation.status ?? null,
    arrivalDate: iso(reservation.arrivalDate),
    departureDate: iso(reservation.departureDate),
    arrivalLocalDate: localDate(reservation.arrivalDate),
    departureLocalDate: localDate(reservation.departureDate),
    nights: reservation.nights ?? null,
    nightlyRate: reservation.nightlyRate ?? null,
    totalAmount: reservation.totalAmount ?? null,
  };
}

function statusHistoryOf(stay) {
  if (!Array.isArray(stay.statusHistory)) return [];
  return stay.statusHistory.map((entry) => ({
    status: entry.status,
    previousStatus: entry.previousStatus ?? null,
    changedAt: iso(entry.changedAt),
    changedBy: idString(entry.changedBy),
    note: entry.note ?? "",
  }));
}

export function toSafeHotelStay(
  stay,
  {
    guest = null,
    room = null,
    roomType = null,
    reservation = null,
    paymentSummary = null,
    includeHistory = true,
  } = {}
) {
  if (!stay) return null;

  const safe = {
    id: idString(stay),
    status: stay.status,
    reservationId: idString(stay.reservationId),
    reservationNumber: stay.reservationNumber,
    reservation: currentReservationSummary(reservation),
    reservationSnapshot: {
      reservationNumber: stay.reservationNumber,
      arrivalDate: iso(stay.arrivalDate),
      departureDate: iso(stay.departureDate),
      arrivalLocalDate: localDate(stay.arrivalDate),
      departureLocalDate: localDate(stay.departureDate),
      nights: stay.reservationNights,
      adults: stay.adults,
      children: stay.children ?? 0,
      nightlyRate: stay.nightlyRate,
      rateSource: stay.rateSource,
      totalAmount: stay.reservationTotalAmount,
      notes: stay.notes ?? "",
    },
    guestId: idString(stay.guestId),
    guest: currentGuestSummary(guest),
    guestSnapshot: guestSnapshotOf(stay),
    roomTypeId: idString(stay.roomTypeId),
    roomType: currentRoomTypeSummary(roomType),
    roomTypeSnapshot: roomTypeSnapshotOf(stay),
    roomId: idString(stay.roomId),
    room: currentRoomSummary(room),
    roomSnapshot: roomSnapshotOf(stay),
    arrivalDate: iso(stay.arrivalDate),
    departureDate: iso(stay.departureDate),
    arrivalLocalDate: localDate(stay.arrivalDate),
    departureLocalDate: localDate(stay.departureDate),
    reservationNights: stay.reservationNights,
    adults: stay.adults,
    children: stay.children ?? 0,
    nightlyRate: stay.nightlyRate,
    rateSource: stay.rateSource,
    reservationTotalAmount: stay.reservationTotalAmount,
    notes: stay.notes ?? "",
    expectedCheckOutAt: iso(stay.expectedCheckOutAt),
    expectedCheckOutLocalDate: localDate(stay.expectedCheckOutAt),
    checkedInAt: iso(stay.checkedInAt),
    checkedInLocalDate: localDate(stay.checkedInAt),
    checkedInBy: idString(stay.checkedInBy),
    checkInNote: stay.checkInNote ?? "",
    checkedOutAt: iso(stay.checkedOutAt),
    checkedOutLocalDate: localDate(stay.checkedOutAt),
    checkedOutBy: idString(stay.checkedOutBy),
    checkOutNote: stay.checkOutNote ?? "",
    billableNights: stay.billableNights ?? null,
    roomCharges: stay.roomCharges ?? null,
    totalCharges: stay.totalCharges ?? null,
    chargeRule: stay.chargeRule ?? null,
    paymentSummary: paymentSummary ?? null,
    createdAt: iso(stay.createdAt),
    updatedAt: iso(stay.updatedAt),
  };

  if (includeHistory) safe.statusHistory = statusHistoryOf(stay);
  return safe;
}

export function toSafeHotelStaySummary(stay, refs = {}) {
  return toSafeHotelStay(stay, {
    ...refs,
    paymentSummary: null,
    includeHistory: false,
  });
}

export { StaySchema, StayStatusHistorySchema };
