// Shared Hotel-only constants.
//
// This module must remain dependency-free so it can be imported by models,
// server code, and DB-free unit tests without pulling in a database
// connection or POS code.

export const HOTEL_DB_NAME = "bono_hotel";
export const HOTEL_MONGODB_URI_ENV = "ROOM_MONGODB_URI";
export const HOTEL_SESSION_SECRET_ENV = "HOTEL_SESSION_SECRET";
export const HOTEL_ALLOWED_ORIGINS_ENV = "HOTEL_ALLOWED_ORIGINS";

export const HOTEL_ROLES = Object.freeze(["MANAGER", "RECEPTIONIST"]);

export const HOTEL_SESSION_COOKIE = "__Host-bono_hotel_session";
export const HOTEL_CSRF_HEADER = "x-hotel-csrf-token";
export const HOTEL_CSRF_TOKEN_BYTES = 32;

// Hotel operations run longer than a POS station shift, but an unattended
// front-desk browser must still expire. Absolute expiry is binding; the idle
// window only moves within that absolute limit.
export const HOTEL_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const HOTEL_SESSION_IDLE_MS = 30 * 60 * 1000;
export const HOTEL_SESSION_TOUCH_THROTTLE_MS = 60 * 1000;
export const HOTEL_SESSION_TOKEN_BYTES = 32;
export const HOTEL_SESSION_SECRET_MIN_LENGTH = 32;

// Phase 2 staff identity lifecycle. The immutable staff identity is the
// HotelUser `_id`, exposed to clients as `staffId`. These values describe
// credential state and provenance only; they never authorize a request.
export const HOTEL_STAFF_CREATED_VIA = Object.freeze([
  "INITIALIZATION",
  "OPERATOR_CLI",
  "STAFF_MANAGEMENT",
  "LEGACY",
]);
// Legacy-only: the dormant `hotel_users.username` field is retained in the
// schema for data preservation until a separately approved DB cleanup. No
// runtime code writes or reads it for authentication.
export const HOTEL_USERNAME_MAX_LENGTH = 32;

export const HOTEL_SESSION_REVOKE_REASONS = Object.freeze([
  "LOGOUT",
  "ROTATED",
  "ACCOUNT_DISABLED",
  "ROLE_CHANGED",
  "SECURITY",
  "EXPIRED",
]);

export const HOTEL_AUDIT_OUTCOMES = Object.freeze([
  "SUCCESS",
  "FAILURE",
  "DENIED",
]);

// Room lifecycle. OCCUPIED and RESERVED are reserved for the future
// reservation/check-in flow; this phase exposes only manual housekeeping
// states. Deactivation is refused while a room is occupied or reserved.
export const HOTEL_ROOM_OPERATIONAL_STATUSES = Object.freeze([
  "AVAILABLE",
  "OCCUPIED",
  "RESERVED",
  "CLEANING",
  "MAINTENANCE",
  "OUT_OF_SERVICE",
]);

export const HOTEL_MANUAL_ROOM_STATUSES = Object.freeze([
  "AVAILABLE",
  "CLEANING",
  "MAINTENANCE",
  "OUT_OF_SERVICE",
]);

export const HOTEL_BLOCKING_ROOM_STATUSES = Object.freeze([
  "OCCUPIED",
  "RESERVED",
]);

export const HOTEL_ROOM_NUMBER_MAX_LENGTH = 20;
export const HOTEL_ROOM_NUMBER_RE = /^[A-Z0-9][A-Z0-9-]{0,19}$/;

// Reception domain. Dates are stored as canonical UTC instants representing
// Addis Ababa civil midnight; the API exposes local YYYY-MM-DD plus ISO
// timestamps. Formatted Ethiopian strings are never the canonical value.
export const HOTEL_TIME_ZONE = "Africa/Addis_Ababa";
export const HOTEL_ADDIS_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
export const HOTEL_MAX_STAY_NIGHTS = 365;

export const HOTEL_GUEST_ID_TYPES = Object.freeze([
  "PASSPORT",
  "NATIONAL_ID",
  "DRIVER_LICENSE",
  "OTHER",
]);

export const HOTEL_RESERVATION_STATUSES = Object.freeze([
  "CONFIRMED",
  "CANCELLED",
  "CHECKED_IN",
  "CHECKED_OUT",
  "NO_SHOW",
]);

// Only these statuses hold room inventory. CHECKED_IN is included so a future
// check-in flow keeps the room blocked for overlapping stays.
export const HOTEL_ACTIVE_RESERVATION_STATUSES = Object.freeze([
  "CONFIRMED",
  "CHECKED_IN",
]);

// Explicit reservation transitions. Check-in and check-out are the only
// workflows allowed to move a reservation into or out of CHECKED_IN.
export const HOTEL_RESERVATION_TRANSITIONS = Object.freeze({
  CONFIRMED: Object.freeze(["CANCELLED", "CHECKED_IN", "NO_SHOW"]),
  CHECKED_IN: Object.freeze(["CHECKED_OUT"]),
  CANCELLED: Object.freeze([]),
  CHECKED_OUT: Object.freeze([]),
  NO_SHOW: Object.freeze([]),
});

// A Stay is created exactly once per successful check-in. IN_HOUSE is the only
// active status; CHECKED_OUT is terminal and preserves the financial history.
export const HOTEL_STAY_STATUSES = Object.freeze(["IN_HOUSE", "CHECKED_OUT"]);
export const HOTEL_ACTIVE_STAY_STATUSES = Object.freeze(["IN_HOUSE"]);
export const HOTEL_STAY_TRANSITIONS = Object.freeze({
  IN_HOUSE: Object.freeze(["CHECKED_OUT"]),
  CHECKED_OUT: Object.freeze([]),
});

// Actual checkout charges use the stay's immutable nightly-rate snapshot and
// the number of Addis civil dates crossed, with a one-night minimum. Overstays
// are charged at the same snapshot rate; the extension workflow is deferred.
export const HOTEL_STAY_CHARGE_RULE = "CALENDAR_NIGHTS_MIN_ONE";
export const HOTEL_PAYMENT_CURRENCY = "ETB";

// Phase 4C is record-only: these methods capture how a payment was tendered,
// not an integrated card/bank transaction. No card PAN, CVV, bank credential,
// or provider secret is ever accepted or stored.
export const HOTEL_PAYMENT_METHODS = Object.freeze([
  "CASH",
  "CARD",
  "BANK_TRANSFER",
]);
export const HOTEL_PAYMENT_STATUSES = Object.freeze(["RECORDED", "VOIDED"]);

// Overpayment is rejected, not silently accepted. A payment may equal the
// outstanding balance exactly; a void is the only correction path.
export const HOTEL_PAYMENT_OVERPAYMENT_POLICY = "REJECT";
export const HOTEL_PAYMENT_ID_PREFIX = "PAY";
export const HOTEL_PAYMENT_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

// The booking lock is keyed by room ObjectId through MongoDB's always-unique
// _id index. No custom index deployment is needed for mutual exclusion. The
// TTL index for stale-lock cleanup is defined in the model only.
export const HOTEL_BOOKING_LOCK_TTL_MS = 30 * 1000;

export const HOTEL_LIST_DEFAULT_LIMIT = 50;
export const HOTEL_LIST_MAX_LIMIT = 100;

// Reports aggregate real Stay/HotelPayment/Reservation records plus the Room
// status history for the denominator. A maximum window keeps one summary or
// export request bounded; 92 days covers a full quarter.
export const HOTEL_REPORT_MAX_WINDOW_DAYS = 92;


// Request-hardening default shared by the protected operational routes.
export const HOTEL_JSON_BODY_MAX_BYTES = 8 * 1024;
