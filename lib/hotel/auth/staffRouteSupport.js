// Shared Route Handler support for Hotel staff management.
//
// Every staff endpoint is authorized with the Hotel permission matrix
// (STAFF_MANAGE, MANAGER only) and every mutation passes through exact-Origin
// + CSRF validation. Sensitive mutations require an audit record: if the
// required audit write fails, the data change is compensated and a 500 is
// returned instead of silently reporting success.

import { hotelFailure } from "../http/apiResponse.js";
import { authorizeHotelRequest } from "../http/authorizedRequest.js";
import { recordHotelAudit } from "../audit.js";
import { HOTEL_ERROR_CODES } from "../errors.js";
import { HOTEL_PERMISSIONS } from "./authorization.js";
import {
  checkHotelRateLimit,
  hotelRetryAfterSeconds,
  HOTEL_RATE_LIMITS,
} from "./rateLimit.js";

export async function authorizeStaffRequest(request, { mutation = false } = {}) {
  const authorized = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.STAFF_MANAGE,
    mutation,
  });
  if (!authorized.ok) return { ok: false, response: authorized.response };
  return { ok: true, auth: authorized.auth };
}

export function staffAuditEvent(action, auth, target, { request, metadata = {} } = {}) {
  return {
    action,
    outcome: "SUCCESS",
    actorUserId: auth.user.id,
    actorRole: auth.role,
    entityType: "HotelUser",
    entityId: target?.id ?? null,
    metadata: { role: "RECEPTIONIST", ...metadata },
    request,
  };
}

// Phase 3F / E-13: bounded throttling for Manager staff mutations.
export function checkStaffMutationRateLimit(request) {
  const rate = checkHotelRateLimit(request, {
    key: "hotel_staff_mutation",
    ...HOTEL_RATE_LIMITS.STAFF_MUTATION,
  });
  if (rate.ok) return null;
  const seconds = hotelRetryAfterSeconds(rate.retryAfterMs);
  return hotelFailure(
    {
      code: HOTEL_ERROR_CODES.RATE_LIMITED,
      status: 429,
      message: `Too many staff changes. Retry after ${seconds}s`,
    },
    { headers: { "Retry-After": String(seconds) } }
  );
}

export async function requireStaffAudit(connection, event, compensate) {
  try {
    await recordHotelAudit(connection, event);
    return null;
  } catch {
    // Audit evidence is mandatory for these mutations. Phase 3F / E-02:
    // compensation is attempted, but the response tells the truth about what
    // actually happened. No PIN, token or credential detail is logged.
    let reverted = false;
    if (compensate) {
      try {
        reverted = (await compensate()) === true;
      } catch {
        reverted = false;
      }
    }
    console.error(
      "[hotel/staff] required audit write failed; reverted =",
      reverted
    );
    return hotelFailure({
      code: HOTEL_ERROR_CODES.INTERNAL_ERROR,
      status: 500,
      message: reverted
        ? "The change could not be recorded and was reverted"
        : "The change was applied but could not be recorded; contact an administrator",
    });
  }
}
