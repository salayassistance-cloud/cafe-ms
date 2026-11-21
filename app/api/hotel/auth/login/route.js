import { cookies } from "next/headers";

import {
  hotelFailure,
  hotelSuccess,
  withHotelApi,
} from "@/lib/hotel/http/apiResponse";
import {
  assertHotelRequestOrigin,
  readHotelJsonBody,
} from "@/lib/hotel/http/requestSecurity";
import { connectToHotelDatabase } from "@/lib/hotel/db/connection";
import { HOTEL_ERROR_CODES, HotelValidationError } from "@/lib/hotel/errors";
import { validateHotelPin } from "@/lib/hotel/validation";
import {
  checkHotelRateLimit,
  hotelRetryAfterSeconds,
  HOTEL_RATE_LIMITS,
} from "@/lib/hotel/auth/rateLimit";
import {
  recordFailedHotelPinAttempt,
  resetHotelPinFailures,
  verifyHotelUserPin,
} from "@/lib/hotel/auth/credential";
import { createHotelSession } from "@/lib/hotel/auth/session";
import {
  HOTEL_SESSION_COOKIE,
  HOTEL_SESSION_COOKIE_OPTS,
} from "@/lib/hotel/auth/cookies";
import {
  getHotelUserModel,
  toSafeHotelUser,
} from "@/lib/hotel/models/hotelUser";
import {
  HOTEL_AUDIT_ACTIONS,
  safeRecordHotelAudit,
} from "@/lib/hotel/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENERIC_FAILURE = "Invalid identity or PIN";

function invalidCredentials() {
  return hotelFailure({
    code: HOTEL_ERROR_CODES.INVALID_CREDENTIALS,
    status: 401,
    message: GENERIC_FAILURE,
  });
}

// POST /api/hotel/auth/login — individually selected identity + 4-digit PIN.
// The client supplies only an opaque HotelUser id and a PIN. Role, active
// status and authoritative identity are resolved from the Hotel database;
// POS Staff/sessions/cookies are never involved.
async function handler(request) {
  assertHotelRequestOrigin(request);

  const rate = checkHotelRateLimit(request, {
    key: "hotel_auth_login",
    ...HOTEL_RATE_LIMITS.LOGIN,
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

  const body = await readHotelJsonBody(request);
  let identityId;
  let pin;
  try {
    identityId = String(body.identityId ?? "").trim();
    pin = validateHotelPin(body.pin);
  } catch (error) {
    if (!(error instanceof HotelValidationError)) throw error;
    return invalidCredentials();
  }

  const connection = await connectToHotelDatabase();
  const result = await verifyHotelUserPin(connection, { identityId, pin });

  if (!result.ok) {
    // Lockout failure attribution is scoped to the actual attempted identity.
    let lockResult = { locked: false };
    if (result.countFailure) {
      lockResult = await recordFailedHotelPinAttempt(connection, result.userId, {
        failedAttempts: result.failedAttempts,
        wasLocked: result.wasLocked,
      }).catch(() => ({ locked: false }));
    }
    await safeRecordHotelAudit(connection, {
      action: HOTEL_AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
      outcome: "FAILURE",
      actorUserId: result.userId,
      actorRole: null,
      entityType: "HotelUser",
      entityId: result.userId,
      metadata: { reason: "INVALID_CREDENTIALS" },
      request,
    }).catch(() => {});
    // Phase 3F / E-21: distinct, safe signal when the threshold was crossed.
    if (lockResult.locked) {
      await safeRecordHotelAudit(connection, {
        action: HOTEL_AUDIT_ACTIONS.STAFF_LOGIN_LOCKED,
        outcome: "DENIED",
        actorUserId: result.userId,
        actorRole: null,
        entityType: "HotelUser",
        entityId: result.userId,
        metadata: { reason: "PIN_FAILURE_THRESHOLD" },
        request,
      }).catch(() => {});
    }
    return invalidCredentials();
  }

  const created = await createHotelSession(connection, {
    hotelUserId: result.user._id,
    role: result.role,
    request,
  });

  await resetHotelPinFailures(connection, result.user._id).catch(() => {});
  await getHotelUserModel(connection)
    .updateOne({ _id: result.user._id }, { $set: { lastLoginAt: new Date() } })
    .catch(() => {});
  await safeRecordHotelAudit(connection, {
    action: HOTEL_AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
    outcome: "SUCCESS",
    actorUserId: String(result.user._id),
    actorRole: result.role,
    entityType: "HotelUser",
    entityId: String(result.user._id),
    metadata: {},
    request,
  }).catch(() => {});

  const jar = await cookies();
  jar.set(HOTEL_SESSION_COOKIE, created.token, HOTEL_SESSION_COOKIE_OPTS);

  return hotelSuccess({
    user: toSafeHotelUser(result.user),
    role: result.role,
    csrfToken: created.csrfToken,
    session: {
      expiresAt: created.session.expiresAt,
      idleExpiresAt: created.session.idleExpiresAt,
    },
  });
}

export const POST = withHotelApi(handler);
