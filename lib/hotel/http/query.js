// Hotel-only list-query parsing.
//
// Query values are narrowed before they reach a model filter. Invalid values
// produce the same HotelValidationError envelope as request bodies.

import {
  HOTEL_LIST_DEFAULT_LIMIT,
  HOTEL_LIST_MAX_LIMIT,
} from "../constants.js";
import { parseHotelLocalDate } from "../dates.js";
import { HotelValidationError } from "../errors.js";
import {
  sanitizeHotelText,
  validateObjectIdString,
} from "../validation.js";

function rawValue(searchParams, field) {
  const value = searchParams?.get?.(field);
  if (value == null || value === "") return null;
  return String(value);
}

function parseInteger(value, field, { min, max, fallback }) {
  if (value == null) return fallback;
  if (!/^-?\d+$/.test(value)) {
    throw new HotelValidationError({
      [field]: `${field} must be an integer`,
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HotelValidationError({
      [field]: `${field} must be between ${min} and ${max}`,
    });
  }
  return parsed;
}

// List endpoints accept only an explicit set of query keys. Rejecting unknown
// keys (for example `role[$ne]` or `$where`) keeps request data from becoming a
// raw Mongo filter fragment.
export function assertHotelQueryFields(searchParams, allowedFields) {
  if (!Array.isArray(allowedFields) || allowedFields.length === 0) {
    throw new Error("An allowed query-field list is required");
  }
  const allowed = new Set(allowedFields);
  const fieldErrors = {};
  for (const key of searchParams?.keys?.() ?? []) {
    if (allowed.has(key)) continue;
    fieldErrors[key] = `${key} is not an allowed query parameter`;
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return true;
}

export function parseHotelPagination(
  searchParams,
  {
    defaultLimit = HOTEL_LIST_DEFAULT_LIMIT,
    maxLimit = HOTEL_LIST_MAX_LIMIT,
  } = {}
) {
  return {
    limit: parseInteger(rawValue(searchParams, "limit"), "limit", {
      min: 1,
      max: maxLimit,
      fallback: defaultLimit,
    }),
    offset: parseInteger(rawValue(searchParams, "offset"), "offset", {
      min: 0,
      max: 1_000_000,
      fallback: 0,
    }),
  };
}

export function parseHotelOptionalBoolean(searchParams, field) {
  const value = rawValue(searchParams, field);
  if (value == null) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new HotelValidationError({
    [field]: `${field} must be true or false`,
  });
}

export function parseHotelOptionalInteger(
  searchParams,
  field,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}
) {
  return parseInteger(rawValue(searchParams, field), field, {
    min,
    max,
    fallback: undefined,
  });
}

export function parseHotelOptionalEnum(searchParams, field, allowed) {
  const value = rawValue(searchParams, field);
  if (value == null) return undefined;
  const normalized = value.trim().toUpperCase();
  if (!Array.isArray(allowed) || !allowed.includes(normalized)) {
    throw new HotelValidationError({
      [field]: `${field} must be one of ${allowed.join(", ")}`,
    });
  }
  return normalized;
}

export function parseHotelOptionalObjectId(searchParams, field) {
  const value = rawValue(searchParams, field);
  if (value == null) return undefined;
  return validateObjectIdString(value, field);
}

export function parseHotelOptionalSearch(
  searchParams,
  field = "search",
  { maxLength = 100 } = {}
) {
  const value = rawValue(searchParams, field);
  if (value == null) return undefined;
  const text = sanitizeHotelText(value, {
    field,
    maxLength,
    allowEmpty: true,
  });
  return text === "" ? undefined : text;
}

export function parseHotelOptionalLocalDate(searchParams, field) {
  const value = rawValue(searchParams, field);
  if (value == null) return undefined;
  return parseHotelLocalDate(value, field);
}
