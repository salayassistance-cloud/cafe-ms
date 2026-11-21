import mongoose from "mongoose";

import {
  HOTEL_PAYMENT_CURRENCY,
  HOTEL_PAYMENT_METHODS,
  HOTEL_PAYMENT_STATUSES,
} from "../constants.js";
import {
  fromHotelMinorUnits,
  toHotelMinorUnits,
} from "../money.js";

// A HotelPayment is a record of money tendered for a checked-out Stay. It is
// never hard-deleted: corrections are non-destructive VOIDED records.
//
// `amountMinor` is the canonical amount in integer minor units (santim). The
// existing Stay/Reservation money fields remain decimal major units; the folio
// service converts them once and performs all arithmetic in minor units.
//
// No card PAN, CVV, bank credential, provider token, or other payment secret is
// stored. `method` records only how the payment was tendered.
//
// Indexes are DEFINED here but never built automatically. The compound
// `stayId + idempotencyKey` unique index is the durable idempotency backstop;
// until an approved Hotel-only index deployment, the per-room lock serializes
// writers that use this service.

const HotelPaymentSchema = new mongoose.Schema(
  {
    paymentNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
    },
    stayId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Stay",
      required: true,
    },
    reservationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reservation",
      required: true,
    },
    guestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      required: true,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      max: 100_000_000_000_000,
      validate: {
        validator: Number.isSafeInteger,
        message: "amountMinor must be an integer number of minor units",
      },
    },
    currency: {
      type: String,
      enum: [HOTEL_PAYMENT_CURRENCY],
      default: HOTEL_PAYMENT_CURRENCY,
      required: true,
    },
    method: {
      type: String,
      enum: HOTEL_PAYMENT_METHODS,
      required: true,
    },
    status: {
      type: String,
      enum: HOTEL_PAYMENT_STATUSES,
      default: "RECORDED",
      required: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
      match: /^[A-Za-z0-9._:-]+$/,
    },
    // SHA-256 of the normalized request (stay, amount, method, currency). It is
    // internal only: the serializer never exposes it.
    requestHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
    },
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      required: true,
    },
    recordedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    voidedAt: {
      type: Date,
      default: null,
    },
    voidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelUser",
      default: null,
    },
    voidReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
  },
  {
    timestamps: true,
    strict: "throw",
    versionKey: false,
    collection: "hotel_payments",
  }
);

HotelPaymentSchema.index({ paymentNumber: 1 }, { unique: true });
HotelPaymentSchema.index({ stayId: 1, idempotencyKey: 1 }, { unique: true });
HotelPaymentSchema.index({ stayId: 1, recordedAt: 1 });
HotelPaymentSchema.index({ reservationId: 1, recordedAt: -1 });
HotelPaymentSchema.index({ guestId: 1, recordedAt: -1 });
HotelPaymentSchema.index({ status: 1, recordedAt: -1 });

export function getHotelPaymentModel(connection) {
  if (!connection?.models) {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  if (connection.models.HotelPayment) return connection.models.HotelPayment;
  if (typeof connection.model !== "function") {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }
  return connection.model("HotelPayment", HotelPaymentSchema, "hotel_payments");
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

export function paymentMinorUnits(payment) {
  if (Number.isSafeInteger(payment?.amountMinor) && payment.amountMinor > 0) {
    return payment.amountMinor;
  }

  // Phase 4B compatibility: older payment-summary fixtures used a decimal
  // `amount`. Real HotelPayment rows always carry `amountMinor`.
  if (payment?.amount != null) {
    try {
      const minor = toHotelMinorUnits(payment.amount, { field: "amount" });
      return minor > 0 ? minor : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function toSafeHotelPayment(payment) {
  if (!payment) return null;
  const amountMinor = paymentMinorUnits(payment);

  return {
    id: idString(payment),
    paymentNumber: payment.paymentNumber ?? null,
    stayId: idString(payment.stayId),
    reservationId: idString(payment.reservationId),
    guestId: idString(payment.guestId),
    amount: amountMinor == null ? null : fromHotelMinorUnits(amountMinor),
    amountMinor,
    currency: payment.currency ?? null,
    method: payment.method ?? null,
    status: payment.status ?? null,
    idempotencyKey: payment.idempotencyKey ?? null,
    actorUserId: idString(payment.actorUserId),
    recordedAt: iso(payment.recordedAt ?? payment.createdAt),
    voidedAt: iso(payment.voidedAt),
    voidedBy: idString(payment.voidedBy),
    voidReason: payment.voidReason ?? "",
    createdAt: iso(payment.createdAt),
    updatedAt: iso(payment.updatedAt),
  };
}

export { HotelPaymentSchema };
