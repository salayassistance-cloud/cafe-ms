// Hotel-only HTTP response helpers.
//
// Deliberately independent of the POS `lib/apiResponse.js` / `lib/withApi.js`.
// No CORS grant is made by default, and no stack trace or database detail is
// ever returned to a client.

import {
  HotelApiError,
  HotelValidationError,
  HOTEL_ERROR_CODES,
  normalizeHotelError,
  redactSensitiveText,
} from "../errors.js";

const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
});

function mergeHeaders(headers) {
  const merged = new Headers(NO_STORE_HEADERS);
  if (headers) {
    for (const [key, value] of new Headers(headers).entries()) {
      merged.set(key, value);
    }
  }
  if (!merged.has("Content-Type")) {
    merged.set("Content-Type", "application/json; charset=utf-8");
  }
  return merged;
}

export function hotelSuccess(data = null, { status = 200, headers } = {}) {
  return Response.json(
    { success: true, data, error: null },
    { status, headers: mergeHeaders(headers) }
  );
}

export function hotelFailure(
  {
    code = HOTEL_ERROR_CODES.INTERNAL_ERROR,
    message = "Internal Server Error",
    status = 500,
    details = null,
  } = {},
  { headers } = {}
) {
  const body = {
    success: false,
    data: null,
    error: { code, message },
  };
  if (details && typeof details === "object") {
    body.error.details = details;
  }
  return Response.json(body, { status, headers: mergeHeaders(headers) });
}

export function hotelErrorResponse(error, { headers } = {}) {
  const normalized = normalizeHotelError(error);

  if (normalized instanceof HotelValidationError) {
    return hotelFailure(
      {
        code: normalized.code,
        message: normalized.message,
        status: normalized.status,
        details: { fieldErrors: normalized.fieldErrors },
      },
      { headers }
    );
  }

  return hotelFailure(
    {
      code: normalized.code,
      message: normalized.expose
        ? normalized.message
        : normalized.status === 503
          ? "Hotel service is temporarily unavailable"
          : "Internal Server Error",
      status: normalized.status,
      details: normalized.expose ? normalized.details : null,
    },
    { headers }
  );
}

// Future Hotel route handlers can use this wrapper. It intentionally performs
// no database connection and no authentication; those must be explicit.
export function withHotelApi(handler) {
  return async function wrappedHotelHandler(request, context) {
    try {
      return await handler(request, context);
    } catch (error) {
      const normalized = normalizeHotelError(error);
      if (normalized.status >= 500) {
        // Never log a stack trace, raw driver error, URI, token, or password.
        const diagnostic = `${error?.name || "Error"}: ${
          error?.message || "Unknown error"
        }`;
        console.error("[hotel/api]", redactSensitiveText(diagnostic));
      }
      return hotelErrorResponse(error);
    }
  };
}

export { HotelApiError };
