import { hotelFailure, hotelSuccess, withHotelApi } from "@/lib/hotel/http/apiResponse";
import { assertHotelRequestOrigin } from "@/lib/hotel/http/requestSecurity";
import { connectToHotelDatabase } from "@/lib/hotel/db/connection";
import { HOTEL_ERROR_CODES } from "@/lib/hotel/errors";
import {
  checkHotelRateLimit,
  hotelRetryAfterSeconds,
  HOTEL_RATE_LIMITS,
} from "@/lib/hotel/auth/rateLimit";
import { findLoginIdentities } from "@/lib/hotel/auth/credential";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/hotel/auth/identities — public pre-login identity directory.
// Only opaque ids, display names and roles are returned. No credentials,
// hashes, email, username, lockout state or session data are exposed.
async function handler(request) {
  // Same-origin GETs normally omit Origin; validate it when a browser supplies
  // one so cross-origin directory enumeration is rejected.
  if (request.headers.get("origin")) assertHotelRequestOrigin(request);
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return hotelFailure({
      code: HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED,
      status: 403,
      message: "Request origin is not allowed",
    });
  }

  const rate = checkHotelRateLimit(request, {
    key: "hotel_auth_identities",
    ...HOTEL_RATE_LIMITS.DIRECTORY,
  });
  if (!rate.ok) {
    const seconds = hotelRetryAfterSeconds(rate.retryAfterMs);
    return hotelFailure(
      {
        code: HOTEL_ERROR_CODES.RATE_LIMITED,
        status: 429,
        message: `Too many attempts. Retry after ${seconds}s`,
      },
      { headers: { "Retry-After": String(seconds) } }
    );
  }

  const connection = await connectToHotelDatabase();
  const identities = await findLoginIdentities(connection);
  return hotelSuccess({ identities });
}

export const GET = withHotelApi(handler);
