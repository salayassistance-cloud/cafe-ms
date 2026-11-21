// Hotel-only money helpers.
//
// Existing Stay and Reservation money fields are decimal major units (ETB).
// Phase 4C payments and folio arithmetic use integer minor units (santim,
// 1/100 ETB). Payment payloads are parsed exactly before any addition, so
// repeated payments such as 0.10 + 0.20 always total 0.30 without binary
// floating-point accumulation.
//
// This module is independent of POS money/formatting code.

import { HotelValidationError } from "./errors.js";

export const HOTEL_MONEY_SCALE = 100;
export const HOTEL_MAX_MONEY_MAJOR = 1_000_000_000_000;
export const HOTEL_MAX_MONEY_MINOR = HOTEL_MAX_MONEY_MAJOR * HOTEL_MONEY_SCALE;

const DECIMAL_AMOUNT_RE = /^(?:0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/;
const SCALE_EPSILON = 1e-6;

function invalid(field, message) {
  return new HotelValidationError({ [field]: message });
}

export function isHotelMoneyMinor(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function fromHotelMinorUnits(minor) {
  if (!Number.isSafeInteger(minor)) {
    throw new TypeError("Hotel minor units must be a safe integer");
  }
  return minor / HOTEL_MONEY_SCALE;
}

// Converts an existing decimal-major-unit value (for example a Stay charge
// snapshot) into integer minor units. More than two fraction digits is treated
// as malformed rather than silently rounded away.
export function toHotelMinorUnits(
  value,
  { field = "amount", allowZero = true } = {}
) {
  const numeric = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    throw invalid(field, `${field} must be a finite monetary amount`);
  }
  if (numeric < 0 || (!allowZero && numeric === 0)) {
    throw invalid(
      field,
      `${field} must be ${allowZero ? "non-negative" : "greater than zero"}`
    );
  }

  const scaled = numeric * HOTEL_MONEY_SCALE;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > SCALE_EPSILON) {
    throw invalid(field, `${field} must have at most two decimal places`);
  }
  if (!Number.isSafeInteger(rounded) || rounded > HOTEL_MAX_MONEY_MINOR) {
    throw invalid(field, `${field} is too large`);
  }
  return rounded;
}

// Parses a client payment amount. Numbers and decimal strings are accepted;
// exponent notation, separators, signs, and more than two fraction digits are
// rejected. Returns both canonical minor units and a normalized major-unit
// value for response serialization.
export function parseHotelPaymentAmount(value, field = "amount") {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalid(field, `${field} must be a finite monetary amount`);
    }
    if (value <= 0) {
      throw invalid(field, `${field} must be greater than zero`);
    }
    const amountMinor = toHotelMinorUnits(value, { field, allowZero: false });
    if (amountMinor <= 0) {
      throw invalid(field, `${field} must be greater than zero`);
    }
    return { amount: fromHotelMinorUnits(amountMinor), amountMinor };
  }

  if (typeof value === "string") {
    const text = value.trim();
    const match = DECIMAL_AMOUNT_RE.exec(text);
    if (!match) {
      throw invalid(
        field,
        `${field} must be a positive amount with at most two decimal places`
      );
    }
    const [whole, fraction = ""] = text.split(".");
    const amountMinor =
      Number(whole) * HOTEL_MONEY_SCALE +
      Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw invalid(field, `${field} must be greater than zero`);
    }
    if (amountMinor > HOTEL_MAX_MONEY_MINOR) {
      throw invalid(field, `${field} is too large`);
    }
    return { amount: fromHotelMinorUnits(amountMinor), amountMinor };
  }

  throw invalid(field, `${field} must be a number or decimal string`);
}

export function addHotelMinorUnits(values) {
  let total = 0;
  for (const value of values) {
    if (!isHotelMoneyMinor(value)) {
      throw new TypeError(
        "Hotel minor units must be non-negative safe integers"
      );
    }
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError("Hotel minor-unit total exceeds the safe range");
    }
  }
  return total;
}
