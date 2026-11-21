import {
  hotelFailure,
  hotelSuccess,
  withHotelApi,
} from "@/lib/hotel/http/apiResponse";
import {
  assertHotelRequestOrigin,
  readHotelCsrfHeader,
  readHotelJsonBody,
} from "@/lib/hotel/http/requestSecurity";
import {
  checkHotelRateLimit,
  hotelRetryAfterSeconds,
  HOTEL_RATE_LIMITS,
} from "@/lib/hotel/auth/rateLimit";
import { authenticateHotelRequest } from "@/lib/hotel/auth/service";
import {
  findHotelPinCollision,
  getHotelUserWithPin,
  setHotelUserPin,
} from "@/lib/hotel/auth/credential";
import { verifyHotelPin } from "@/lib/hotel/auth/pin";
import { revokeAllHotelSessionsForUser } from "@/lib/hotel/auth/session";
import { validateHotelPin } from "@/lib/hotel/validation";
import { HOTEL_ERROR_CODES, HotelValidationError } from "@/lib/hotel/errors";
import { HOTEL_AUDIT_ACTIONS, safeRecordHotelAudit } from "@/lib/hotel/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/hotel/auth/change-pin — self-service PIN change. The target is
// always the authenticated session's own HotelUser id; a client cannot select
// another identity. Changing the PIN revokes every session for that user.
async function handler(request) {
  assertHotelRequestOrigin(request);

  const rate = checkHotelRateLimit(request, {
    key: "hotel_change_pin",
    ...HOTEL_RATE_LIMITS.CHANGE_PIN,
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

  const auth = await authenticateHotelRequest(request, {
    requireCsrf: true,
    csrfToken: readHotelCsrfHeader(request),
  });
  if (!auth.ok) {
    return hotelFailure({
      code: auth.code,
      status: auth.status,
      message: auth.message,
    });
  }

  const body = await readHotelJsonBody(request);
  let currentPin;
  let newPin;
  let confirmPin;
  try {
    currentPin = validateHotelPin(body.currentPin, "currentPin");
    newPin = validateHotelPin(body.newPin, "newPin");
    confirmPin = validateHotelPin(body.confirmPin, "confirmPin");
  } catch (error) {
    if (!(error instanceof HotelValidationError)) throw error;
    return hotelFailure({
      code: HOTEL_ERROR_CODES.VALIDATION_ERROR,
      status: 422,
      message: "PIN must be exactly 4 digits",
    });
  }

  if (newPin !== confirmPin) {
    return hotelFailure({
      code: HOTEL_ERROR_CODES.VALIDATION_ERROR,
      status: 422,
      message: "New PIN and Confirm PIN do not match",
    });
  }
  if (newPin === currentPin) {
    return hotelFailure({
      code: HOTEL_ERROR_CODES.VALIDATION_ERROR,
      status: 422,
      message: "New PIN must differ from current PIN",
    });
  }

  const connection = auth.connection;
  const user = await getHotelUserWithPin(connection, auth.user.id);
  if (!user || !verifyHotelPin(currentPin, user.pinHash)) {
    return hotelFailure({
      code: HOTEL_ERROR_CODES.INVALID_CREDENTIALS,
      status: 401,
      message: "Current PIN is incorrect",
    });
  }

  // Phase 3F / E-07: same collision policy as Manager creation/reset, with
  // the acting identity excluded. Inactive accounts are included by the helper.
  if (await findHotelPinCollision(connection, newPin, { exceptUserId: user._id })) {
    return hotelFailure({
      code: HOTEL_ERROR_CODES.CONFLICT,
      status: 409,
      message: "That PIN is already assigned to another Hotel identity",
    });
  }

  await setHotelUserPin(connection, user._id, newPin);
  await revokeAllHotelSessionsForUser(connection, user._id, "SECURITY").catch(
    () => {}
  );
  await safeRecordHotelAudit(connection, {
    action: HOTEL_AUDIT_ACTIONS.STAFF_SELF_PIN_CHANGED,
    outcome: "SUCCESS",
    actorUserId: auth.user.id,
    actorRole: auth.role,
    entityType: "HotelUser",
    entityId: auth.user.id,
    metadata: {},
    request,
  }).catch(() => {});

  return hotelSuccess({ message: "PIN updated successfully", changed: true });
}

export const POST = withHotelApi(handler);
