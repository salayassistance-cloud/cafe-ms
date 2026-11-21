// Server-only Hotel session resolution for the /hotel route layout.
//
// This mirrors the POS pattern (a server layout guard) without reusing any POS
// auth code, cookie, secret, or database connection. The Hotel session is still
// validated live against the Hotel database on every server-rendered entry; the
// client never receives an authorization decision it could forge.
//
// This helper NEVER writes to the session. The idle window is maintained by the
// normal Hotel API requests each screen issues on entry, so a page render does
// not need an extra session write.

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { HOTEL_SESSION_COOKIE } from "../constants.js";
import {
  connectToHotelDatabase,
  isHotelDatabaseConfigured,
} from "../db/connection.js";
import {
  parseHotelSessionCookieHeader,
  resolveHotelSession,
} from "./session.js";
import { deriveHotelSessionCsrfToken } from "./csrf.js";

// Cached for one React render pass. The /hotel layout and a destination page
// both need the same result: the layout renders the gate/provider and the page
// enforces its role. React.cache guarantees a single live DB validation per
// request instead of two, preserving the session-loading optimization.
const resolveCachedHotelServerSession = cache(async () => {
  try {
    if (!isHotelDatabaseConfigured()) {
      return { ok: false, reason: "unavailable" };
    }

    const jar = await cookies();
    const cookieValue = jar.get(HOTEL_SESSION_COOKIE)?.value;
    if (!cookieValue) return { ok: false, reason: "no-session" };

    const rawToken = parseHotelSessionCookieHeader(
      `${HOTEL_SESSION_COOKIE}=${cookieValue}`
    );
    if (!rawToken) return { ok: false, reason: "no-session" };

    const connection = await connectToHotelDatabase();
    const resolved = await resolveHotelSession(connection, rawToken, {
      touch: false,
    });
    if (!resolved.ok) return { ok: false, reason: "no-session" };

    const csrfToken = deriveHotelSessionCsrfToken(rawToken);
    if (!csrfToken) return { ok: false, reason: "unavailable" };

    return {
      ok: true,
      session: {
        user: resolved.user,
        role: resolved.role,
        csrfToken,
        session: {
          expiresAt: resolved.session.expiresAt,
          idleExpiresAt: resolved.session.idleExpiresAt,
        },
      },
    };
  } catch {
    // Missing secret, unreachable database, malformed token, etc. Fail closed:
    // the layout renders the sign-in gate. No detail is exposed to the client.
    return { ok: false, reason: "unavailable" };
  }
});

export async function getHotelServerSession() {
  return resolveCachedHotelServerSession();
}

// Server-side destination guard. Authorization is decided here, on the
// server, never by the client PIN UI.
//
// Two distinct cases are intentionally handled differently:
//
// 1. No valid session: this is NOT an authorization failure — it is the normal
//    "signed out" state. The /hotel layout owns the sign-in gate for the
//    requested route and renders it instead of `children`. Returning null here
//    (instead of redirecting) is what keeps an unauthenticated visitor on the
//    requested Manager portal. A fixed cross-portal redirect here was the root
//    cause of Manager routes bouncing to Reception.
//
// 2. A valid session for a different role: this IS an authorization failure,
//    so redirect to the role that may use the requested destination. No
//    protected data is rendered for the wrong role, and no client state can
//    override this decision.
//
// Callers must render nothing when this helper returns null; the shared gate
// is already on screen for that request.
export async function requireHotelPageRole(requiredRole, deniedHref) {
  const result = await getHotelServerSession();
  if (!result.ok) return null;
  if (result.session?.role !== requiredRole) {
    redirect(deniedHref);
  }
  return result.session;
}
