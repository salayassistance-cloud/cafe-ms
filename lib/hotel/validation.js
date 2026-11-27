// Hotel-only runtime validation helpers.
//
// This is intentionally separate from `lib/validate.js` (POS roles, PINs,
// orders). Every public-facing Hotel payload must be narrowed to a plain
// object before it reaches a query or model.

import {
  HOTEL_GUEST_ID_TYPES,
  HOTEL_MANUAL_ROOM_STATUSES,
  HOTEL_ROLES,
  HOTEL_PAYMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
  HOTEL_PAYMENT_METHODS,
  HOTEL_LIST_DEFAULT_LIMIT,
  HOTEL_LIST_MAX_LIMIT,
  HOTEL_ROOM_NUMBER_MAX_LENGTH,
  HOTEL_ROOM_NUMBER_RE,
  HOTEL_ROOM_OPERATIONAL_STATUSES,
} from "./constants.js";
import { HotelValidationError } from "./errors.js";
import {
  formatHotelLocalDate,
  parseHotelLocalDate,
} from "./dates.js";
import { parseHotelPaymentAmount } from "./money.js";

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROOM_TYPE_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
const GUEST_PHONE_RE = /^\+?[0-9][0-9()\-\s]{2,29}$/;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Hotel email + password authentication input validation.
export function validateHotelRole(value, field = "role") {
  const role = String(value ?? "").trim().toUpperCase();
  if (!HOTEL_ROLES.includes(role)) {
    throw new HotelValidationError({
      [field]: `${field} must be one of ${HOTEL_ROLES.join(", ")}`,
    });
  }
  return role;
}

export function validateHotelEmail(value, field = "email") {
  const email = String(value ?? "").trim().toLowerCase();
  if (email.length < 5 || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new HotelValidationError({
      [field]: `${field} must be a valid email address`,
    });
  }
  return email;
}

export function isPlainObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertPlainObject(value, field = "body") {
  if (!isPlainObject(value)) {
    throw new HotelValidationError({
      [field]: `${field} must be a JSON object`,
    });
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new HotelValidationError({
        [field]: `${field} contains a forbidden key`,
      });
    }
  }
  return value;
}

export function sanitizeHotelText(
  value,
  { field = "value", maxLength = 200, allowEmpty = false, minLength = 0 } = {}
) {
  if (typeof value !== "string") {
    throw new HotelValidationError({ [field]: `${field} must be a string` });
  }
  const text = value.replace(CONTROL_CHARS_RE, "").trim();
  if (/<script/i.test(text) || /javascript:/i.test(text) || /on\w+\s*=/i.test(text)) {
    throw new HotelValidationError({
      [field]: `${field} contains invalid characters`,
    });
  }
  if (!allowEmpty && text.length === 0) {
    throw new HotelValidationError({ [field]: `${field} is required` });
  }
  if (text.length < minLength) {
    throw new HotelValidationError({
      [field]: `${field} must be at least ${minLength} characters`,
    });
  }
  if (text.length > maxLength) {
    throw new HotelValidationError({
      [field]: `${field} must be at most ${maxLength} characters`,
    });
  }
  return text;
}

export function normalizeHotelEmail(value) {
  const email = sanitizeHotelText(value, {
    field: "email",
    maxLength: 254,
  }).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new HotelValidationError({ email: "email is invalid" });
  }
  return email;
}

function validateRoomTypeName(value) {
  return sanitizeHotelText(value, { field: "name", maxLength: 100 });
}

function validateRoomTypeCode(value) {
  const code = sanitizeHotelText(value, {
    field: "code",
    maxLength: 30,
  }).toUpperCase();
  if (!ROOM_TYPE_CODE_RE.test(code)) {
    throw new HotelValidationError({
      code: "code must be 1-30 uppercase letters, digits, hyphens, or underscores",
    });
  }
  return code;
}

export function validateHotelCapacity(value, { field = "capacity" } = {}) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new HotelValidationError({
      [field]: `${field} must be an integer between 1 and 100`,
    });
  }
  return value;
}

export function validateHotelNightlyRate(
  value,
  { field = "baseNightlyRate" } = {}
) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HotelValidationError({
      [field]: `${field} must be a finite non-negative number`,
    });
  }
  const rounded = Math.round(value * 100) / 100;
  if (rounded > 1_000_000_000) {
    throw new HotelValidationError({
      [field]: `${field} is too large`,
    });
  }
  return rounded;
}

export function validateHotelAmenities(value, { field = "amenities" } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30) {
    throw new HotelValidationError({
      [field]: `${field} must be an array with at most 30 entries`,
    });
  }
  const unique = new Set();
  for (const entry of value) {
    const amenity = sanitizeHotelText(entry, {
      field,
      maxLength: 80,
    });
    unique.add(amenity);
  }
  return [...unique];
}

function validateRoomNumber(value) {
  const roomNumber = sanitizeHotelText(value, {
    field: "roomNumber",
    maxLength: HOTEL_ROOM_NUMBER_MAX_LENGTH,
  }).toUpperCase();
  if (!HOTEL_ROOM_NUMBER_RE.test(roomNumber)) {
    throw new HotelValidationError({
      roomNumber:
        "roomNumber must be 1-20 uppercase letters, digits, or hyphens",
    });
  }
  return roomNumber;
}

function validateRoomFloor(value) {
  if (!Number.isInteger(value) || value < -10 || value > 200) {
    throw new HotelValidationError({
      floor: "floor must be an integer between -10 and 200",
    });
  }
  return value;
}

export function validateRoomOperationalStatus(
  value,
  { field = "operationalStatus", manualOnly = false } = {}
) {
  const status = String(value ?? "").trim().toUpperCase();
  if (!HOTEL_ROOM_OPERATIONAL_STATUSES.includes(status)) {
    throw new HotelValidationError({
      [field]: `${field} must be one of ${HOTEL_ROOM_OPERATIONAL_STATUSES.join(
        ", "
      )}`,
    });
  }
  if (manualOnly && !HOTEL_MANUAL_ROOM_STATUSES.includes(status)) {
    throw new HotelValidationError({
      [field]: `${field} must be one of ${HOTEL_MANUAL_ROOM_STATUSES.join(
        ", "
      )}; OCCUPIED and RESERVED are controlled by the reservation flow`,
    });
  }
  return status;
}

export function validateRoomPayload(body, { partial = false } = {}) {
  assertPlainObject(body);
  const input = {};
  const fieldErrors = {};

  const assign = (field, validator, { optional = false } = {}) => {
    if (body[field] === undefined) {
      if (!partial && !optional) fieldErrors[field] = `${field} is required`;
      return;
    }
    try {
      input[field] = validator(body[field]);
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  };

  assign("roomNumber", validateRoomNumber);
  assign("floor", validateRoomFloor);
  assign("roomTypeId", (value) => validateObjectIdString(value, "roomTypeId"));
  assign("capacity", validateHotelCapacity);
  assign("amenities", validateHotelAmenities, { optional: true });

  if (body.nightlyRateOverride !== undefined) {
    if (body.nightlyRateOverride === null) {
      input.nightlyRateOverride = null;
    } else {
      try {
        input.nightlyRateOverride = validateHotelNightlyRate(
          body.nightlyRateOverride,
          { field: "nightlyRateOverride" }
        );
      } catch (error) {
        if (error instanceof HotelValidationError) {
          Object.assign(fieldErrors, error.fieldErrors);
        } else {
          throw error;
        }
      }
    }
  } else if (!partial) {
    input.nightlyRateOverride = null;
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      fieldErrors.isActive = "isActive must be a boolean";
    } else {
      input.isActive = body.isActive;
    }
  } else if (!partial) {
    input.isActive = true;
  }

  if (body.operationalStatus !== undefined) {
    if (partial) {
      fieldErrors.operationalStatus =
        "operationalStatus must be changed through the room status endpoint";
    } else {
      try {
        input.operationalStatus = validateRoomOperationalStatus(
          body.operationalStatus,
          { manualOnly: true }
        );
      } catch (error) {
        if (error instanceof HotelValidationError) {
          Object.assign(fieldErrors, error.fieldErrors);
        } else {
          throw error;
        }
      }
    }
  } else if (!partial) {
    input.operationalStatus = "AVAILABLE";
  }

  if (
    partial &&
    Object.keys(input).length === 0 &&
    Object.keys(fieldErrors).length === 0
  ) {
    fieldErrors.body = "at least one field is required";
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return input;
}

export function validateRoomStatusPayload(body) {
  assertPlainObject(body);
  const fieldErrors = {};

  let operationalStatus = null;
  try {
    operationalStatus = validateRoomOperationalStatus(body.operationalStatus, {
      manualOnly: true,
    });
  } catch (error) {
    if (error instanceof HotelValidationError) {
      Object.assign(fieldErrors, error.fieldErrors);
    } else {
      throw error;
    }
  }

  let note = "";
  if (body.note !== undefined && body.note !== null) {
    try {
      note = sanitizeHotelText(body.note, {
        field: "note",
        maxLength: 500,
        allowEmpty: true,
      });
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return { operationalStatus, note };
}

export function validateRoomTypePayload(body, { partial = false } = {}) {
  assertPlainObject(body);
  const input = {};
  const fieldErrors = {};

  const assign = (field, validator, { optional = false } = {}) => {
    if (body[field] === undefined) {
      if (!partial && !optional) fieldErrors[field] = `${field} is required`;
      return;
    }
    try {
      input[field] = validator(body[field]);
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  };

  assign("name", validateRoomTypeName);
  assign("code", validateRoomTypeCode);
  assign("capacity", validateHotelCapacity);
  assign("baseNightlyRate", validateHotelNightlyRate);
  assign("amenities", validateHotelAmenities, { optional: true });

  if (body.description !== undefined) {
    input.description = sanitizeHotelText(body.description, {
      field: "description",
      maxLength: 1000,
      allowEmpty: true,
    });
  } else if (!partial) {
    input.description = "";
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      fieldErrors.isActive = "isActive must be a boolean";
    } else {
      input.isActive = body.isActive;
    }
  } else if (!partial) {
    input.isActive = true;
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return input;
}

function validateGuestName(value, field) {
  return sanitizeHotelText(value, { field, maxLength: 80 });
}

function validateGuestPhone(value) {
  const phone = sanitizeHotelText(value, {
    field: "phone",
    maxLength: 30,
  }).replace(/\s+/g, " ");
  if (!GUEST_PHONE_RE.test(phone)) {
    throw new HotelValidationError({
      phone: "phone must be a valid phone number with at most 30 characters",
    });
  }
  return phone;
}

function validateOptionalEmail(value) {
  if (value == null || value === "") return null;
  return normalizeHotelEmail(value);
}

function validateOptionalGuestText(value, field, maxLength) {
  if (value == null) return "";
  return sanitizeHotelText(value, {
    field,
    maxLength,
    allowEmpty: true,
  });
}

function validateGuestIdType(value) {
  if (value == null || value === "") return null;
  const idType = String(value).trim().toUpperCase();
  if (!HOTEL_GUEST_ID_TYPES.includes(idType)) {
    throw new HotelValidationError({
      idType: `idType must be one of ${HOTEL_GUEST_ID_TYPES.join(", ")}`,
    });
  }
  return idType;
}

export function validateGuestPayload(body, { partial = false } = {}) {
  assertPlainObject(body);
  const input = {};
  const fieldErrors = {};

  const assign = (field, validator, { optional = false } = {}) => {
    if (body[field] === undefined) {
      if (!partial && !optional) fieldErrors[field] = `${field} is required`;
      return;
    }
    try {
      input[field] = validator(body[field]);
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  };

  assign("firstName", (value) => validateGuestName(value, "firstName"));
  assign("lastName", (value) => validateGuestName(value, "lastName"));
  assign("phone", validateGuestPhone);

  if (body.email !== undefined) {
    try {
      input.email = validateOptionalEmail(body.email);
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  } else if (!partial) {
    input.email = null;
  }

  for (const [field, maxLength] of [
    ["nationality", 80],
    ["idNumber", 60],
    ["address", 300],
    ["notes", 1000],
  ]) {
    if (body[field] !== undefined) {
      try {
        input[field] = validateOptionalGuestText(body[field], field, maxLength);
      } catch (error) {
        if (error instanceof HotelValidationError) {
          Object.assign(fieldErrors, error.fieldErrors);
        } else {
          throw error;
        }
      }
    } else if (!partial) {
      input[field] = "";
    }
  }

  if (body.idType !== undefined) {
    try {
      input.idType = validateGuestIdType(body.idType);
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  } else if (!partial) {
    input.idType = null;
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      fieldErrors.isActive = "isActive must be a boolean";
    } else {
      input.isActive = body.isActive;
    }
  } else if (!partial) {
    input.isActive = true;
  }

  if (
    partial &&
    Object.keys(input).length === 0 &&
    Object.keys(fieldErrors).length === 0
  ) {
    fieldErrors.body = "at least one field is required";
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return input;
}

function validateStayDateText(value, field) {
  return formatHotelLocalDate(parseHotelLocalDate(value, field));
}

function validateReservationChildren(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new HotelValidationError({
      children: "children must be an integer between 0 and 100",
    });
  }
  return value;
}

function validateReservationNotes(value) {
  if (value == null) return "";
  return sanitizeHotelText(value, {
    field: "notes",
    maxLength: 1000,
    allowEmpty: true,
  });
}

function assertGuestCountWithinLimit(adults, children, fieldErrors) {
  if (
    Number.isInteger(adults) &&
    Number.isInteger(children) &&
    adults + children > 100
  ) {
    fieldErrors.adults = "adults plus children must not exceed 100";
  }
}

export function validateReservationCreatePayload(body) {
  assertPlainObject(body);
  const input = {};
  const fieldErrors = {};

  const assign = (field, validator) => {
    if (body[field] === undefined) {
      fieldErrors[field] = `${field} is required`;
      return;
    }
    try {
      input[field] = validator(body[field]);
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  };

  assign("guestId", (value) => validateObjectIdString(value, "guestId"));
  assign("roomTypeId", (value) => validateObjectIdString(value, "roomTypeId"));
  assign("arrivalDate", (value) => validateStayDateText(value, "arrivalDate"));
  assign("departureDate", (value) =>
    validateStayDateText(value, "departureDate")
  );
  assign("adults", (value) =>
    validateHotelCapacity(value, { field: "adults" })
  );

  if (body.children !== undefined) {
    try {
      input.children = validateReservationChildren(body.children);
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  } else {
    input.children = 0;
  }

  if (body.roomId !== undefined && body.roomId !== null) {
    try {
      input.roomId = validateObjectIdString(body.roomId, "roomId");
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  } else {
    input.roomId = null;
  }

  if (body.notes !== undefined) {
    try {
      input.notes = validateReservationNotes(body.notes);
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  } else {
    input.notes = "";
  }

  assertGuestCountWithinLimit(input.adults, input.children, fieldErrors);

  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return input;
}

export function validateReservationUpdatePayload(body) {
  assertPlainObject(body);
  const input = {};
  const fieldErrors = {};

  for (const field of [
    "guestId",
    "roomTypeId",
    "roomId",
    "status",
    "nightlyRate",
    "totalAmount",
  ]) {
    if (body[field] !== undefined) {
      fieldErrors[field] = `${field} cannot be changed through this endpoint`;
    }
  }

  const assignOptional = (field, validator) => {
    if (body[field] === undefined) return;
    try {
      input[field] = validator(body[field]);
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  };

  assignOptional("arrivalDate", (value) =>
    validateStayDateText(value, "arrivalDate")
  );
  assignOptional("departureDate", (value) =>
    validateStayDateText(value, "departureDate")
  );
  assignOptional("adults", (value) =>
    validateHotelCapacity(value, { field: "adults" })
  );
  assignOptional("children", validateReservationChildren);
  assignOptional("notes", validateReservationNotes);

  assertGuestCountWithinLimit(input.adults, input.children, fieldErrors);

  if (
    Object.keys(input).length === 0 &&
    Object.keys(fieldErrors).length === 0
  ) {
    fieldErrors.body = "at least one field is required";
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return input;
}

export function validateReservationAssignmentPayload(body) {
  assertPlainObject(body);
  const roomId = validateObjectIdString(body.roomId, "roomId");
  return { roomId };
}

export function validateReservationCancelPayload(body) {
  assertPlainObject(body);
  const fieldErrors = {};
  let reason = "";

  if (body.reason !== undefined && body.reason !== null) {
    try {
      reason = sanitizeHotelText(body.reason, {
        field: "reason",
        maxLength: 500,
        allowEmpty: true,
      });
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return { reason };
}

const STAY_WORKFLOW_PROTECTED_FIELDS = Object.freeze([
  "reservationId",
  "roomId",
  "guestId",
  "status",
  "checkedInAt",
  "checkedOutAt",
  "checkedInBy",
  "checkedOutBy",
  "nightlyRate",
  "rateSource",
  "totalAmount",
  "reservationTotalAmount",
  "billableNights",
  "roomCharges",
  "totalCharges",
  "chargeRule",
]);

function validateStayWorkflowPayload(body, { operation }) {
  assertPlainObject(body);
  const fieldErrors = {};

  for (const field of STAY_WORKFLOW_PROTECTED_FIELDS) {
    if (body[field] !== undefined) {
      fieldErrors[field] = `${field} cannot be set through the ${operation} endpoint`;
    }
  }

  let note = "";
  if (body.note !== undefined && body.note !== null) {
    try {
      note = sanitizeHotelText(body.note, {
        field: "note",
        maxLength: 500,
        allowEmpty: true,
      });
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return { note };
}

export function validateCheckInPayload(body = {}) {
  return validateStayWorkflowPayload(body, { operation: "check-in" });
}

export function validateCheckOutPayload(body = {}) {
  return validateStayWorkflowPayload(body, { operation: "check-out" });
}

export function validateObjectIdString(value, field = "id") {
  const id = String(value ?? "").trim();
  if (!/^[a-fA-F0-9]{24}$/.test(id)) {
    throw new HotelValidationError({ [field]: `${field} must be a valid ObjectId` });
  }
  return id;
}

const PAYMENT_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]+$/;
const PAYMENT_SECRET_DIGITS_RE = /\d{13,19}/;

const PAYMENT_CREATE_FIELDS = Object.freeze([
  "amount",
  "method",
  "idempotencyKey",
]);

const PAYMENT_PROTECTED_FIELDS = Object.freeze([
  "paymentId",
  "paymentNumber",
  "stayId",
  "reservationId",
  "guestId",
  "amountMinor",
  "currency",
  "status",
  "actorUserId",
  "recordedBy",
  "recordedAt",
  "voidedAt",
  "voidedBy",
  "voidReason",
  "requestHash",
  "totalCharges",
  "totalPaid",
  "outstandingBalance",
  "overpayment",
  "createdAt",
  "updatedAt",
]);

// Payment payloads are deliberately narrow. Totals, identifiers, currency,
// status, and actor are server-owned; clients supply only the tendered amount,
// method, and an idempotency key. Card PAN/CVV or bank-credential fields are
// unknown fields and are rejected before any model write.
export function validateHotelPaymentPayload(body) {
  assertPlainObject(body);
  const fieldErrors = {};
  const allowed = new Set(PAYMENT_CREATE_FIELDS);
  const protectedFields = new Set(PAYMENT_PROTECTED_FIELDS);

  for (const key of Object.keys(body)) {
    if (allowed.has(key)) continue;
    fieldErrors[key] = protectedFields.has(key)
      ? `${key} cannot be set through this endpoint`
      : `${key} is not an allowed payment field`;
  }

  let amount = null;
  let amountMinor = null;
  if (body.amount === undefined) {
    fieldErrors.amount = "amount is required";
  } else {
    try {
      const parsed = parseHotelPaymentAmount(body.amount, "amount");
      amount = parsed.amount;
      amountMinor = parsed.amountMinor;
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  }

  let method = null;
  if (body.method === undefined) {
    fieldErrors.method = "method is required";
  } else if (typeof body.method !== "string") {
    fieldErrors.method = "method must be a string";
  } else {
    const normalized = body.method.trim().toUpperCase();
    if (!HOTEL_PAYMENT_METHODS.includes(normalized)) {
      fieldErrors.method = `method must be one of ${HOTEL_PAYMENT_METHODS.join(
        ", "
      )}`;
    } else {
      method = normalized;
    }
  }

  let idempotencyKey = null;
  if (body.idempotencyKey === undefined) {
    fieldErrors.idempotencyKey = "idempotencyKey is required";
  } else if (typeof body.idempotencyKey !== "string") {
    fieldErrors.idempotencyKey = "idempotencyKey must be a string";
  } else {
    const normalized = body.idempotencyKey.trim();
    if (normalized.length === 0) {
      fieldErrors.idempotencyKey = "idempotencyKey is required";
    } else if (
      normalized.length > HOTEL_PAYMENT_IDEMPOTENCY_KEY_MAX_LENGTH
    ) {
      fieldErrors.idempotencyKey = `idempotencyKey must be at most ${HOTEL_PAYMENT_IDEMPOTENCY_KEY_MAX_LENGTH} characters`;
    } else if (!PAYMENT_IDEMPOTENCY_KEY_RE.test(normalized)) {
      fieldErrors.idempotencyKey =
        "idempotencyKey may contain only letters, digits, dot, underscore, colon, and hyphen";
    } else {
      idempotencyKey = normalized;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return { amount, amountMinor, method, idempotencyKey };
}

export function validateHotelPaymentVoidPayload(body = {}) {
  assertPlainObject(body);
  const fieldErrors = {};

  for (const key of Object.keys(body)) {
    if (key !== "reason") {
      fieldErrors[key] =
        `${key} cannot be changed through the void endpoint`;
    }
  }

  let reason = "";
  if (body.reason !== undefined && body.reason !== null) {
    try {
      reason = sanitizeHotelText(body.reason, {
        field: "reason",
        maxLength: 500,
        allowEmpty: true,
      });
      if (PAYMENT_SECRET_DIGITS_RE.test(reason)) {
        fieldErrors.reason =
          "reason must not contain card or bank account numbers";
      }
    } catch (error) {
      if (error instanceof HotelValidationError) {
        Object.assign(fieldErrors, error.fieldErrors);
      } else {
        throw error;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return { reason };
}
