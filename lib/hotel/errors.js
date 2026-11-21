// Hotel-only error taxonomy and secret-redaction helpers.
//
// No POS response/error module is imported. Public responses never include
// stack traces, raw database errors, connection strings, or credentials.

export const HOTEL_ERROR_CODES = Object.freeze({
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  INVALID_SESSION: "INVALID_SESSION",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  FORBIDDEN: "FORBIDDEN",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  GONE: "GONE",
  ORIGIN_NOT_ALLOWED: "ORIGIN_NOT_ALLOWED",
  CSRF_VALIDATION_FAILED: "CSRF_VALIDATION_FAILED",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",
  HOTEL_CONFIGURATION_ERROR: "HOTEL_CONFIGURATION_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

export class HotelApiError extends Error {
  constructor({
    code = HOTEL_ERROR_CODES.INTERNAL_ERROR,
    message = "Internal Server Error",
    status = 500,
    details = null,
    expose = status < 500,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "HotelApiError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = expose;
  }
}

export class HotelValidationError extends HotelApiError {
  constructor(fieldErrors = {}, message = "Invalid request") {
    super({
      code: HOTEL_ERROR_CODES.VALIDATION_ERROR,
      message,
      status: 422,
      details: { fieldErrors },
      expose: true,
    });
    this.name = "HotelValidationError";
    this.fieldErrors = fieldErrors;
  }
}

export class HotelConfigurationError extends HotelApiError {
  constructor(message = "Hotel service configuration is incomplete") {
    super({
      code: HOTEL_ERROR_CODES.HOTEL_CONFIGURATION_ERROR,
      message,
      status: 503,
      expose: false,
    });
    this.name = "HotelConfigurationError";
  }
}

export class HotelDatabaseConfigurationError extends HotelConfigurationError {
  constructor(message = "Hotel database is not configured") {
    super(message);
    this.name = "HotelDatabaseConfigurationError";
  }
}

export function isHotelDatabaseError(error) {
  if (!error) return false;
  const signature = `${error.name || ""} ${error.message || ""} ${error.code || ""}`;
  return /mongo|mongoose|disconnected|server selection|topology|econnrefused|etimedout|network/i.test(
    signature
  );
}

// Best-effort redaction for diagnostics. Never pass the result to a client.
export function redactSensitiveText(value) {
  let text = typeof value === "string" ? value : String(value ?? "");
  text = text.replace(
    /mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi,
    "[redacted-mongodb-uri]"
  );
  text = text.replace(
    /\b(password|passwd|pwd|secret|token|cookie|authorization)(\s*["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi,
    (_match, key, separator) => `${key}${separator}[redacted]`
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
  return text;
}

export function normalizeHotelError(error) {
  if (error instanceof HotelApiError) return error;

  if (error?.name === "ValidationError") {
    const fieldErrors = {};
    for (const [field, detail] of Object.entries(error.errors || {})) {
      fieldErrors[field] = "Invalid value";
    }
    return new HotelValidationError(fieldErrors);
  }

  if (error?.code === 11000) {
    return new HotelApiError({
      code: HOTEL_ERROR_CODES.CONFLICT,
      message: "A record with the same unique value already exists",
      status: 409,
      expose: true,
    });
  }

  if (isHotelDatabaseError(error)) {
    return new HotelApiError({
      code: HOTEL_ERROR_CODES.DATABASE_UNAVAILABLE,
      message: "Hotel database is temporarily unavailable",
      status: 503,
      expose: true,
    });
  }

  return new HotelApiError({
    code: HOTEL_ERROR_CODES.INTERNAL_ERROR,
    message: "Internal Server Error",
    status: 500,
    expose: false,
    cause: error,
  });
}
