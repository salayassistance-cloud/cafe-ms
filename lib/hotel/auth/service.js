// Hotel request authorization guard.
//
// This module retains ONLY the request guard that the protected Hotel
// operational APIs depend on. The sole interactive session-creation path is
// POST /api/hotel/auth/login (identity + 4-digit PIN); it lives under
// app/api/hotel/auth/ and uses the Hotel-only session store. Login/logout are
// not implemented here: this guard verifies an already-established session. It verifies an existing opaque session cookie
// against the Hotel session store and the live HotelUser role. Removing this
// guard would require modifying every protected operational handler and route,
// which is outside the authentication-cleanup scope.
//
// The guard never issues, rotates, or extends a credential. It never imports
// POS auth, staff, session, cookie, or database modules. Connections are
// injected for DB-free tests; the default provider is loaded lazily so
// importing this module cannot connect to a database.

import {
  HOTEL_ERROR_CODES,
  HotelApiError,
} from "../errors.js";
import {
  HOTEL_AUDIT_ACTIONS,
  safeRecordHotelAudit,
} from "../audit.js";
import {
  assertHotelSessionConfigured,
  parseHotelSessionCookieHeader,
  resolveHotelSession,
  verifyHotelSessionCsrf,
} from "./session.js";
import {
  assertHotelPermission,
  assertHotelRole,
  permissionsForHotelRole,
} from "./authorization.js";

async function defaultConnect() {
  const { connectToHotelDatabase } = await import("../db/connection.js");
  return connectToHotelDatabase();
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
  return defaultConnect();
}

// Route Handler guard. Returns a result object rather than throwing for
// ordinary 401/403 decisions so callers can choose their own response shape.
// Database/config errors still propagate and should be handled by
// `withHotelApi` (or an equivalent Hotel-only wrapper).
export async function authenticateHotelRequest(
  request,
  {
    allowedRoles = null,
    permission = null,
    connect,
    touch = true,
    csrfToken = null,
    requireCsrf = false,
  } = {}
) {
  const rawToken = parseHotelSessionCookieHeader(
    request?.headers?.get?.("cookie") || ""
  );
  if (!rawToken) {
    return {
      ok: false,
      status: 401,
      code: HOTEL_ERROR_CODES.AUTHENTICATION_REQUIRED,
      message: "Authentication required",
    };
  }

  // Fail closed before opening a database connection if the Hotel secret is
  // missing or incorrectly configured.
  assertHotelSessionConfigured();
  const connection = await resolveConnection(connect);
  const resolved = await resolveHotelSession(connection, rawToken, { touch });
  if (!resolved.ok) {
    const expired = resolved.code === HOTEL_ERROR_CODES.SESSION_EXPIRED;
    return {
      ok: false,
      status: 401,
      code: expired
        ? HOTEL_ERROR_CODES.SESSION_EXPIRED
        : HOTEL_ERROR_CODES.INVALID_SESSION,
      message: expired
        ? "Session expired. Please sign in again."
        : "Authentication required",
    };
  }

  if (requireCsrf && !verifyHotelSessionCsrf(resolved.session, csrfToken, rawToken)) {
    await safeRecordHotelAudit(connection, {
      action: HOTEL_AUDIT_ACTIONS.AUTH_ACCESS_DENIED,
      outcome: "DENIED",
      actorUserId: resolved.user.id,
      actorRole: resolved.role,
      metadata: {
        reason: "CSRF_VALIDATION_FAILED",
        operation: request?.method || "UNKNOWN",
      },
      request,
    });
    return {
      ok: false,
      status: 403,
      code: HOTEL_ERROR_CODES.CSRF_VALIDATION_FAILED,
      message: "Request verification failed",
    };
  }

  try {
    assertHotelRole(resolved.role, allowedRoles);
    if (permission) {
      assertHotelPermission(resolved.role, permission);
    }
  } catch (error) {
    await safeRecordHotelAudit(connection, {
      action: HOTEL_AUDIT_ACTIONS.AUTH_ACCESS_DENIED,
      outcome: "DENIED",
      actorUserId: resolved.user.id,
      actorRole: resolved.role,
      metadata: {
        permission,
        allowedRoles: Array.isArray(allowedRoles) ? allowedRoles : null,
      },
      request,
    });
    return {
      ok: false,
      status: 403,
      code: HOTEL_ERROR_CODES.FORBIDDEN,
      message:
        error instanceof HotelApiError
          ? error.message
          : "You do not have permission to perform this action",
    };
  }

  return {
    ok: true,
    connection,
    user: resolved.user,
    role: resolved.role,
    permissions: permissionsForHotelRole(resolved.role),
    session: {
      id: resolved.session._id ? String(resolved.session._id) : null,
      roleSnapshot: resolved.roleSnapshot,
      expiresAt: resolved.session.expiresAt,
      idleExpiresAt: resolved.session.idleExpiresAt,
    },
  };
}
