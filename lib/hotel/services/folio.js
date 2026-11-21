// Hotel-only folio service.
//
// The folio is the single financial source of truth for a Stay. It combines:
// - the Stay's immutable, finalized room-charge snapshot; and
// - persisted HotelPayment rows.
//
// Charges and payments are converted once to integer minor units (santim) and
// added as integers. A client-supplied total is never accepted. A null charge
// snapshot is reported as unknown, never substituted with zero.

import {
  HOTEL_PAYMENT_CURRENCY,
  HOTEL_PAYMENT_OVERPAYMENT_POLICY,
  HOTEL_STAY_CHARGE_RULE,
} from "../constants.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
} from "../errors.js";
import {
  getHotelPaymentModel,
  paymentMinorUnits,
  toSafeHotelPayment,
} from "../models/hotelPayment.js";
import { getStayModel } from "../models/stay.js";
import {
  addHotelMinorUnits,
  fromHotelMinorUnits,
  toHotelMinorUnits,
} from "../money.js";
import { validateObjectIdString } from "../validation.js";

export const HOTEL_FOLIO_SOURCES = Object.freeze({
  HOTEL_PAYMENT_RECORDS: "HOTEL_PAYMENT_RECORDS",
  PAYMENTS_NOT_IMPLEMENTED: "PAYMENTS_NOT_IMPLEMENTED",
  PAYMENT_SUMMARY_UNAVAILABLE: "PAYMENT_SUMMARY_UNAVAILABLE",
  PAYMENT_RECORD_INVALID: "PAYMENT_RECORD_INVALID",
});

export const HOTEL_FOLIO_SETTLEMENT_STATUSES = Object.freeze({
  UNAVAILABLE: "UNAVAILABLE",
  CHARGES_NOT_FINALIZED: "CHARGES_NOT_FINALIZED",
  NO_CHARGE: "NO_CHARGE",
  UNPAID: "UNPAID",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  SETTLED: "SETTLED",
  OVERPAID: "OVERPAID",
});

// RECORDED is the only status the Phase 4C model writes. PAID and
// PARTIALLY_PAID are accepted only as read-only Phase 4B compatibility values;
// VOIDED and CANCELLED never count toward paid totals.
const COUNTED_PAYMENT_STATUSES = new Set([
  "RECORDED",
  "PAID",
  "PARTIALLY_PAID",
]);
const EXCLUDED_PAYMENT_STATUSES = new Set(["VOIDED", "CANCELLED"]);

function notFound(message = "Stay not found") {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.NOT_FOUND,
    message,
    status: 404,
    expose: true,
  });
}

function idString(value) {
  const id = value?._id ?? value;
  return id ? String(id) : null;
}

function safeMinor(value, field) {
  if (value == null) return null;
  try {
    return toHotelMinorUnits(value, { field });
  } catch {
    return null;
  }
}

function chargeFields(stay) {
  const totalChargesMinor = safeMinor(stay?.totalCharges, "totalCharges");
  const roomChargesMinor = safeMinor(stay?.roomCharges, "roomCharges");
  const billableNights = stay?.billableNights;
  const billableNightsValid =
    Number.isInteger(billableNights) && billableNights >= 1;
  const chargeRuleValid = stay?.chargeRule === HOTEL_STAY_CHARGE_RULE;
  const chargesFinalized =
    stay?.status === "CHECKED_OUT" &&
    totalChargesMinor != null &&
    roomChargesMinor != null &&
    billableNightsValid &&
    chargeRuleValid;

  return {
    totalChargesMinor,
    roomChargesMinor,
    billableNights: billableNightsValid ? billableNights : null,
    chargeRule: stay?.chargeRule ?? null,
    chargesFinalized,
  };
}

function baseFolio(stay, reservation) {
  const charges = chargeFields(stay);
  return {
    available: false,
    currency: HOTEL_PAYMENT_CURRENCY,
    stayId: idString(stay),
    stayStatus: stay?.status ?? null,
    reservationId: idString(reservation?._id ?? reservation) ?? idString(stay?.reservationId),
    guestId: idString(stay?.guestId),
    finalized: charges.chargesFinalized,
    chargeRule: charges.chargeRule,
    billableNights: charges.billableNights,
    nightlyRate: stay?.nightlyRate ?? null,
    roomCharges:
      charges.roomChargesMinor == null
        ? null
        : fromHotelMinorUnits(charges.roomChargesMinor),
    roomChargesMinor: charges.roomChargesMinor,
    totalCharges:
      charges.totalChargesMinor == null
        ? null
        : fromHotelMinorUnits(charges.totalChargesMinor),
    totalChargesMinor: charges.totalChargesMinor,
    totalPaid: null,
    totalPaidMinor: null,
    outstandingBalance: null,
    outstandingBalanceMinor: null,
    overpayment: null,
    overpaymentMinor: null,
    overpaymentPolicy: HOTEL_PAYMENT_OVERPAYMENT_POLICY,
    paymentCount: 0,
    payments: [],
    settled: false,
    settlementStatus: HOTEL_FOLIO_SETTLEMENT_STATUSES.UNAVAILABLE,
    canRecordPayment: false,
    canVoidPayment: false,
    source: HOTEL_FOLIO_SOURCES.PAYMENTS_NOT_IMPLEMENTED,
    reason: "PAYMENT_RECORDS_NOT_IMPLEMENTED",
    calculatedAt: new Date().toISOString(),
  };
}

function unavailableFolio(stay, reservation, { source, reason }) {
  return {
    ...baseFolio(stay, reservation),
    source,
    reason,
  };
}

function settlementStatusOf({
  available,
  finalized,
  totalChargesMinor,
  totalPaidMinor,
}) {
  if (!available) return HOTEL_FOLIO_SETTLEMENT_STATUSES.UNAVAILABLE;
  if (!finalized) {
    return HOTEL_FOLIO_SETTLEMENT_STATUSES.CHARGES_NOT_FINALIZED;
  }
  if (totalChargesMinor === 0) {
    return HOTEL_FOLIO_SETTLEMENT_STATUSES.NO_CHARGE;
  }
  if (totalPaidMinor === 0) return HOTEL_FOLIO_SETTLEMENT_STATUSES.UNPAID;
  if (totalPaidMinor < totalChargesMinor) {
    return HOTEL_FOLIO_SETTLEMENT_STATUSES.PARTIALLY_PAID;
  }
  if (totalPaidMinor === totalChargesMinor) {
    return HOTEL_FOLIO_SETTLEMENT_STATUSES.SETTLED;
  }
  return HOTEL_FOLIO_SETTLEMENT_STATUSES.OVERPAID;
}

export async function buildHotelFolio({
  connection,
  stay,
  reservation = null,
} = {}) {
  if (!stay) {
    throw new TypeError("buildHotelFolio requires a stay");
  }

  const charges = chargeFields(stay);

  // Prefer an already-registered model. In a fresh process none exists yet, so
  // compile it through the Hotel factory; reading `connection.models` directly
  // would report existing payments as unavailable until some other operation
  // compiled the model. Connections without a model factory are genuinely
  // unable to read payment records.
  let Payment = connection?.models?.HotelPayment;
  if (!Payment && typeof connection?.model === "function") {
    Payment = getHotelPaymentModel(connection);
  }
  if (!Payment || typeof Payment.find !== "function") {
    return unavailableFolio(stay, reservation, {
      source: HOTEL_FOLIO_SOURCES.PAYMENTS_NOT_IMPLEMENTED,
      reason: "PAYMENT_RECORDS_NOT_IMPLEMENTED",
    });
  }

  let records;
  try {
    records = await Payment.find({ stayId: stay._id })
      .sort({ recordedAt: 1, createdAt: 1 })
      .lean();
  } catch {
    return unavailableFolio(stay, reservation, {
      source: HOTEL_FOLIO_SOURCES.PAYMENT_SUMMARY_UNAVAILABLE,
      reason: "PAYMENT_SUMMARY_UNAVAILABLE",
    });
  }

  if (!Array.isArray(records)) {
    return unavailableFolio(stay, reservation, {
      source: HOTEL_FOLIO_SOURCES.PAYMENT_SUMMARY_UNAVAILABLE,
      reason: "PAYMENT_SUMMARY_UNAVAILABLE",
    });
  }

  const payments = records.map((record) => toSafeHotelPayment(record));
  const countedMinors = [];
  let invalidRecord = false;

  for (const record of records) {
    const status = String(record?.status ?? "").trim().toUpperCase();
    if (EXCLUDED_PAYMENT_STATUSES.has(status)) continue;
    if (!COUNTED_PAYMENT_STATUSES.has(status)) {
      invalidRecord = true;
      continue;
    }
    const minor = paymentMinorUnits(record);
    if (minor == null) {
      invalidRecord = true;
      continue;
    }
    countedMinors.push(minor);
  }

  const totalPaidMinor = invalidRecord
    ? null
    : addHotelMinorUnits(countedMinors);
  const available = !invalidRecord;
  const finalized = charges.chargesFinalized;
  const totalChargesMinor = charges.totalChargesMinor;
  const outstandingBalanceMinor =
    !available || totalChargesMinor == null || totalPaidMinor == null
      ? null
      : Math.max(0, totalChargesMinor - totalPaidMinor);
  const overpaymentMinor =
    !available || totalChargesMinor == null || totalPaidMinor == null
      ? null
      : Math.max(0, totalPaidMinor - totalChargesMinor);
  const settlementStatus = settlementStatusOf({
    available,
    finalized,
    totalChargesMinor,
    totalPaidMinor,
  });
  const settled =
    settlementStatus === HOTEL_FOLIO_SETTLEMENT_STATUSES.SETTLED;
  const canRecordPayment =
    available &&
    finalized &&
    outstandingBalanceMinor != null &&
    outstandingBalanceMinor > 0;

  return {
    available,
    currency: HOTEL_PAYMENT_CURRENCY,
    stayId: idString(stay),
    stayStatus: stay?.status ?? null,
    reservationId:
      idString(reservation?._id ?? reservation) ?? idString(stay?.reservationId),
    guestId: idString(stay?.guestId),
    finalized,
    chargeRule: charges.chargeRule,
    billableNights: charges.billableNights,
    nightlyRate: stay?.nightlyRate ?? null,
    roomCharges:
      charges.roomChargesMinor == null
        ? null
        : fromHotelMinorUnits(charges.roomChargesMinor),
    roomChargesMinor: charges.roomChargesMinor,
    totalCharges:
      totalChargesMinor == null
        ? null
        : fromHotelMinorUnits(totalChargesMinor),
    totalChargesMinor,
    totalPaid:
      totalPaidMinor == null ? null : fromHotelMinorUnits(totalPaidMinor),
    totalPaidMinor,
    outstandingBalance:
      outstandingBalanceMinor == null
        ? null
        : fromHotelMinorUnits(outstandingBalanceMinor),
    outstandingBalanceMinor,
    overpayment:
      overpaymentMinor == null ? null : fromHotelMinorUnits(overpaymentMinor),
    overpaymentMinor,
    overpaymentPolicy: HOTEL_PAYMENT_OVERPAYMENT_POLICY,
    paymentCount: available ? countedMinors.length : null,
    payments,
    settled,
    settlementStatus,
    canRecordPayment,
    canVoidPayment: available && countedMinors.length > 0,
    source: available
      ? HOTEL_FOLIO_SOURCES.HOTEL_PAYMENT_RECORDS
      : HOTEL_FOLIO_SOURCES.PAYMENT_RECORD_INVALID,
    reason: available ? null : "PAYMENT_RECORD_INVALID",
    calculatedAt: new Date().toISOString(),
  };
}

export async function getHotelFolio({
  connection,
  stayId,
  stay = null,
  reservation = null,
} = {}) {
  let targetStay = stay;
  if (!targetStay) {
    const normalizedId = validateObjectIdString(stayId, "id");
    const Stay = getStayModel(connection);
    targetStay = await Stay.findById(normalizedId).lean();
    if (!targetStay) throw notFound();
  }
  return buildHotelFolio({
    connection,
    stay: targetStay,
    reservation,
  });
}

// Payment detail responses need totals, not every payment row. The folio
// endpoint is the only place that returns the full persisted payment list.
export function toHotelFolioSummary(folio) {
  if (!folio) return null;
  const { payments, ...summary } = folio;
  return summary;
}
