// Hotel-only date utilities.
//
// Hotel business dates are Addis Ababa civil dates. The database stores a
// canonical UTC instant for local midnight; formatted Ethiopian strings are
// display-only and must never be used as the canonical timestamp.
//
// Africa/Addis_Ababa has a fixed UTC+03:00 offset (no DST). The constant is
// centralised here so reservation locks and stay calculations agree.

import {
  HOTEL_ADDIS_UTC_OFFSET_MS,
  HOTEL_MAX_STAY_NIGHTS,
  HOTEL_TIME_ZONE,
} from "./constants.js";
import { HotelValidationError } from "./errors.js";

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: HOTEL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function localDateParts(date) {
  const parts = LOCAL_DATE_FORMATTER.formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type === "year" || part.type === "month" || part.type === "day") {
      values[part.type] = part.value;
    }
  }
  return values;
}

export function formatHotelLocalDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("A valid date is required");
  }
  const { year, month, day } = localDateParts(date);
  return `${year}-${month}-${day}`;
}

export function parseHotelLocalDate(value, field = "date") {
  const text = typeof value === "string" ? value.trim() : "";
  const match = LOCAL_DATE_RE.exec(text);
  if (!match) {
    throw new HotelValidationError({
      [field]: `${field} must be a valid YYYY-MM-DD date`,
    });
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));

  if (
    year < 1900 ||
    year > 2200 ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new HotelValidationError({
      [field]: `${field} must be a valid calendar date`,
    });
  }

  return new Date(probe.getTime() - HOTEL_ADDIS_UTC_OFFSET_MS);
}

export function hotelLocalToday(now = Date.now()) {
  return formatHotelLocalDate(new Date(now));
}

export function addHotelLocalDays(value, days) {
  const localDate = formatHotelLocalDate(value);
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(
    Date.UTC(year, month - 1, day + days) - HOTEL_ADDIS_UTC_OFFSET_MS
  );
}

export function getHotelStayNights(arrivalDate, departureDate) {
  return Math.round(
    (new Date(departureDate).getTime() - new Date(arrivalDate).getTime()) /
      DAY_MS
  );
}

export function enumerateHotelNights(arrivalDate, departureDate) {
  const nights = getHotelStayNights(arrivalDate, departureDate);
  if (!Number.isInteger(nights) || nights <= 0) return [];
  const keys = [];
  for (let index = 0; index < nights; index += 1) {
    keys.push(formatHotelLocalDate(addHotelLocalDays(arrivalDate, index)));
  }
  return keys;
}

export function validateHotelStayRange({
  arrivalDate,
  departureDate,
  now = Date.now(),
  requireTodayOrLater = true,
} = {}) {
  const fieldErrors = {};
  let arrival = null;
  let departure = null;

  try {
    arrival = parseHotelLocalDate(arrivalDate, "arrivalDate");
  } catch (error) {
    if (error instanceof HotelValidationError) {
      Object.assign(fieldErrors, error.fieldErrors);
    } else {
      throw error;
    }
  }

  try {
    departure = parseHotelLocalDate(departureDate, "departureDate");
  } catch (error) {
    if (error instanceof HotelValidationError) {
      Object.assign(fieldErrors, error.fieldErrors);
    } else {
      throw error;
    }
  }

  let nights = null;
  if (arrival && departure) {
    nights = getHotelStayNights(arrival, departure);
    if (nights <= 0) {
      fieldErrors.departureDate = "departureDate must be after arrivalDate";
    } else if (nights > HOTEL_MAX_STAY_NIGHTS) {
      fieldErrors.departureDate = `a stay must not exceed ${HOTEL_MAX_STAY_NIGHTS} nights`;
    }

    if (
      requireTodayOrLater &&
      formatHotelLocalDate(arrival) < hotelLocalToday(now)
    ) {
      fieldErrors.arrivalDate = "arrivalDate must be today or later";
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }

  return { arrivalDate: arrival, departureDate: departure, nights };
}

export { DAY_MS as HOTEL_DAY_MS };
