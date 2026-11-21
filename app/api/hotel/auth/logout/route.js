import { cookies } from "next/headers";

import {
  hotelFailure,
  hotelSuccess,
  withHotelApi,
} from "@/lib/hotel/http/apiResponse";
import {
  assertHotelRequestOrigin,
  readHotelCsrfHeader,
} from "@/lib/hotel/http/requestSecurity";
import { connectToHotelDatabase } from "@/lib/hotel/db/connection";
import {
  checkHotelRateLimit,
  hotelRetryAfterSeconds,
  HOTEL_RATE_LIMITS,
} from "@/lib/hotel/auth/rateLimit";
import {
  parseHotelSessionCookieHeader,
  resolveHotelSession,
  revokeHotelSession,
  verifyHotelSessionCsrf,
} from "@/lib/hotel/auth/session";
import {
  HOTEL_SESSION_COOKIE,
  HOTEL_SESSION_COOKIE_DELETE_OPTS,
} from "@/lib/hotel/auth/cookies";
import { HOTEL_ERROR_CODES } from "@/lib/hotel/errors";
import { HOTEL_AUDIT_ACTIONS, safeRecordHotelAudit } from "@/lib/hotel/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/hotel/auth/logout — revokes the current opaque Hotel session and
// clears the Hotel-only cookie. Phase 3F / E-14: the response never claims
// revocation succeeded when it did not. A missing/invalid session is still
// idempotent; a present session with bad CSRF or a failed revocation is a
// failure (the cookie is still cleared to help the browser).
async function handler(request) {
  assertHotelRequestOrigin(request);

  const rate = checkHotelRateLimit(request, {
    key: "hotel_auth_logout",
    ...HOTEL_RATE_LIMITS.LOGOUT,
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

  const rawToken = parseHotelSessionCookieHeader(
    request.headers.get("cookie") || ""
  );
  const csrfToken = readHotelCsrfHeader(request);
  let outcome = null;
  let revokedCount = 0;

  if (rawToken) {
    try {
      const connection = await connectToHotelDatabase();
      const resolved = await resolveHotelSession(connection, rawToken, {
        touch: false,
      });
      if (resolved.ok) {
        if (!csrfToken || !verifyHotelSessionCsrf(resolved.session, csrfToken, rawToken)) {
          outcome = hotelFailure({
            code: HOTEL_ERROR_CODES.CSRF_VALIDATION_FAILED,
            status: 403,
            message: "Request verification failed; session was not revoked",
          });
        } else {
          revokedCount = await revokeHotelSession(connection, rawToken, "LOGOUT");
          if (revokedCount > 0) {
            await safeRecordHotelAudit(connection, {
              action: HOTEL_AUDIT_ACTIONS.AUTH_LOGOUT,
              outcome: "SUCCESS",
              actorUserId: resolved.user.id,
              actorRole: resolved.role,
              entityType: "HotelSession",
              entityId: resolved.session._id
                ? String(resolved.session._id)
                : null,
              metadata: { reason: "LOGOUT" },
              request,
            }).catch(() => {});
          }
        }
      }
    } catch {
      outcome = hotelFailure({
        code: HOTEL_ERROR_CODES.DATABASE_UNAVAILABLE,
        status: 503,
        message: "Session could not be revoked; try again",
      });
    }
  }

  const jar = await cookies();
  jar.set(HOTEL_SESSION_COOKIE, "", HOTEL_SESSION_COOKIE_DELETE_OPTS);
  if (outcome) return outcome;
  return hotelSuccess({ loggedOut: true, sessionsRevoked: revokedCount > 0 });
}

export const POST = withHotelApi(handler);
