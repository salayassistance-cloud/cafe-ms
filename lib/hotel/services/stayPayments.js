// Hotel-only payment-summary boundary for stays.
//
// This module is a compatibility facade over the Phase 4C folio service. The
// folio service is the financial source of truth; this facade preserves the
// Phase 4B response shape used by Stay detail and check-out.
//
// When payment records are unavailable, monetary paid/outstanding fields are
// null. Callers must not substitute zero for an unknown balance.

import { HOTEL_PAYMENT_CURRENCY } from "../constants.js";
import { buildHotelFolio } from "./folio.js";

export const HOTEL_PAYMENT_SUMMARY_SOURCES = Object.freeze({
  HOTEL_PAYMENT_RECORDS: "HOTEL_PAYMENT_RECORDS",
  PAYMENTS_NOT_IMPLEMENTED: "PAYMENTS_NOT_IMPLEMENTED",
  PAYMENT_SUMMARY_UNAVAILABLE: "PAYMENT_SUMMARY_UNAVAILABLE",
});

function totalChargesOf(stay) {
  const value = stay?.totalCharges ?? stay?.roomCharges ?? null;
  return value == null ? null : Number(value);
}

export function unavailableHotelStayPaymentSummary(
  stay,
  { reason = "PAYMENT_RECORDS_NOT_IMPLEMENTED" } = {}
) {
  return {
    available: false,
    currency: HOTEL_PAYMENT_CURRENCY,
    totalCharges: totalChargesOf(stay),
    totalPaid: null,
    outstandingBalance: null,
    overpayment: null,
    paymentCount: 0,
    source:
      reason === "PAYMENT_RECORDS_NOT_IMPLEMENTED"
        ? HOTEL_PAYMENT_SUMMARY_SOURCES.PAYMENTS_NOT_IMPLEMENTED
        : HOTEL_PAYMENT_SUMMARY_SOURCES.PAYMENT_SUMMARY_UNAVAILABLE,
    reason,
  };
}

export async function getHotelStayPaymentSummary({
  connection,
  stay,
  reservation = null,
} = {}) {
  if (!stay) {
    throw new TypeError("getHotelStayPaymentSummary requires a stay");
  }

  try {
    const folio = await buildHotelFolio({
      connection,
      stay,
      reservation,
    });

    if (!folio.available) {
      return unavailableHotelStayPaymentSummary(stay, {
        reason: folio.reason ?? "PAYMENT_SUMMARY_UNAVAILABLE",
      });
    }

    return {
      available: true,
      currency: folio.currency,
      reservationId: reservation?._id
        ? String(reservation._id)
        : folio.reservationId,
      totalCharges: folio.totalCharges,
      totalPaid: folio.totalPaid,
      outstandingBalance: folio.outstandingBalance,
      overpayment: folio.overpayment,
      paymentCount: folio.paymentCount,
      source: HOTEL_PAYMENT_SUMMARY_SOURCES.HOTEL_PAYMENT_RECORDS,
      reason: null,
    };
  } catch {
    return unavailableHotelStayPaymentSummary(stay, {
      reason: "PAYMENT_SUMMARY_UNAVAILABLE",
    });
  }
}
