// Hotel request authorization, database-connection, and Origin seam.
//
// Phase 1: the only Manager identity is the existing POS `MANAGER` resolved by
// the canonical POS authority (`requireAuth`). Hotel keeps its own permission
// vocabulary, but it is projected from that single POS Manager identity.
//
// FAIL-CLOSED:
// - missing/invalid/inactive POS session -> 401
// - non-MANAGER POS role -> 403
// - POS authentication infrastructure failure -> 503
// - Hotel database/connection failure -> Hotel error response (503 for DB)
//
// Mutation Origin validation is preserved exactly as before.

import { requireAuth } from "../../security.js";
import { assertHotelPermission } from "../auth/authorization.js";
import { HOTEL_ERROR_CODES } from "../errors.js";
import { hotelErrorResponse, hotelFailure } from "./apiResponse.js";
import { assertHotelRequestOrigin } from "./requestSecurity.js";

const HOTEL_MANAGER_ROLE = "MANAGER";
const POS_RECEPTION_ROLE = "RECEPTION";
const HOTEL_RECEPTION_ROLE = "RECEPTIONIST";
const ALLOWED_POS_HOTEL_ROLES = Object.freeze([
  HOTEL_MANAGER_ROLE,
  POS_RECEPTION_ROLE,
]);

function mapPosRoleToHotelRole(posRole) {
  const normalized = String(posRole ?? "").trim().toUpperCase();
  if (normalized === HOTEL_MANAGER_ROLE) return HOTEL_MANAGER_ROLE;
  if (normalized === POS_RECEPTION_ROLE) return HOTEL_RECEPTION_ROLE;
  return null;
}

async function resolveConnection(connect) {
  if (connect?.models) return connect;
  if (typeof connect === "function") {
    const connection = await connect();
    if (!connection?.models) {
      throw new Error("Hotel connection provider did not return a connection");
    }
    return connection;
  }
  const { connectToHotelDatabase } = await import("../db/connection.js");
  return connectToHotelDatabase();
}

// The `authenticate` hook exists only for DB-free tests. It is ignored outside
// the Node test runner, so production always uses the canonical POS resolver.
function resolveAuthenticator(authenticate) {
  const isTestRunner =
    Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === "test";
  return isTestRunner && typeof authenticate === "function"
    ? authenticate
    : requireAuth;
}

function forbidden() {
  return {
    ok: false,
    response: hotelFailure({
      code: HOTEL_ERROR_CODES.FORBIDDEN,
      message: "You do not have permission to perform this action",
      status: 403,
    }),
  };
}

function authenticationFailure(result) {
  const status = Number(result?.status) || 401;

  if (status === 403) return forbidden();

  if (status >= 500) {
    return {
      ok: false,
      response: hotelFailure({
        code: HOTEL_ERROR_CODES.DATABASE_UNAVAILABLE,
        message: "Hotel service is temporarily unavailable",
        status: 503,
      }),
    };
  }

  let code = HOTEL_ERROR_CODES.AUTHENTICATION_REQUIRED;
  if (result?.code === "ACCOUNT_DISABLED") {
    code = HOTEL_ERROR_CODES.ACCOUNT_DISABLED;
  } else if (result?.code === "SESSION_EXPIRED") {
    code = HOTEL_ERROR_CODES.SESSION_EXPIRED;
  } else if (
    result?.code === "SESSION_REVOKED" ||
    result?.code === "SESSION_INVALID"
  ) {
    code = HOTEL_ERROR_CODES.INVALID_SESSION;
  }

  return {
    ok: false,
    response: hotelFailure({
      code,
      message:
        code === HOTEL_ERROR_CODES.ACCOUNT_DISABLED
          ? "Account disabled. Please contact manager."
          : "Authentication required",
      status: 401,
    }),
  };
}

export async function authorizeHotelRequest(
  request,
  {
    permission,
    mutation = false,
    connect,
    allowedOrigins,
    authenticate,
  } = {}
) {
  // Preserve the existing mutation Origin contract. Origin is not auth.
  if (mutation) {
    assertHotelRequestOrigin(request, { allowedOrigins });
  }

  // 1. Canonical POS authentication, MANAGER and RECEPTION only. Fail closed on any error.
  let result;
  try {
    result = await resolveAuthenticator(authenticate)(
      request,
      ALLOWED_POS_HOTEL_ROLES
    );
  } catch {
    return {
      ok: false,
      response: hotelFailure({
        code: HOTEL_ERROR_CODES.DATABASE_UNAVAILABLE,
        message: "Hotel service is temporarily unavailable",
        status: 503,
      }),
    };
  }

  if (!result?.ok) return authenticationFailure(result);

  // Defense in depth: requireAuth already enforces the allowlist, and only
  // MANAGER or RECEPTION -> RECEPTIONIST map to valid Hotel roles.
  const hotelRole = mapPosRoleToHotelRole(result.payload?.role);
  if (!hotelRole) return forbidden();

  // 2. Enforce the declared Hotel permission through the Hotel vocabulary.
  if (permission != null) {
    try {
      assertHotelPermission(hotelRole, permission);
    } catch (error) {
      return { ok: false, response: hotelErrorResponse(error) };
    }
  }

  // 3. Resolve the dedicated Hotel connection. Never fall back to POS.
  let connection;
  try {
    connection = await resolveConnection(connect);
  } catch (error) {
    return { ok: false, response: hotelErrorResponse(error) };
  }

  // Actor contract: Hotel services read `actor?.id` and `actor?.role`.
  // The POS Staff ObjectId is deliberately NOT placed in `id`: every Hotel
  // actor field is declared `ref: "HotelUser"`, and a POS id there would be a
  // mixed-namespace reference. Role-only attribution is safe; per-person
  // attribution stays null until an approved HotelUser <-> POS Staff mapping
  // exists.
  return {
    ok: true,
    auth: {
      connection,
      user: { id: null, role: hotelRole },
      role: hotelRole,
    },
  };
}
