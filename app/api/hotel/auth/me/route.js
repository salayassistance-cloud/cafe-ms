import { hotelFailure, hotelSuccess, withHotelApi } from "@/lib/hotel/http/apiResponse";
import { HOTEL_ERROR_CODES } from "@/lib/hotel/errors";
import { authenticateHotelRequest } from "@/lib/hotel/auth/service";
import { deriveHotelSessionCsrfToken } from "@/lib/hotel/auth/csrf";
import { parseHotelSessionCookieHeader } from "@/lib/hotel/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/hotel/auth/me — optional current-user/CSRF refresh for Hotel
// clients that need to re-read the verified session. It never creates a
// session; the /hotel server layout remains the authoritative page gate.
async function handler(request) {
  const auth = await authenticateHotelRequest(request);
  if (!auth.ok) {
    return hotelFailure({
      code: auth.code,
      status: auth.status,
      message: auth.message,
    });
  }

  const rawToken = parseHotelSessionCookieHeader(
    request.headers.get("cookie") || ""
  );
  const csrfToken = rawToken ? deriveHotelSessionCsrfToken(rawToken) : null;
  if (!csrfToken) {
    return hotelFailure({
      code: HOTEL_ERROR_CODES.INVALID_SESSION,
      status: 401,
      message: "Authentication required",
    });
  }

  return hotelSuccess({
    user: auth.user,
    role: auth.role,
    csrfToken,
    session: auth.session,
  });
}

export const GET = withHotelApi(handler);
