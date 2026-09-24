import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// POST /api/auth/tab/heartbeat
// AUTH-ARCH-11: operational liveness for open tabs. The tab presents its
// memory-only credential via X-Bono-Tab-Session; the server revalidates the
// bound Session + live Staff.isActive and slides expiresAt/idleExpiresAt
// forward (bounded per heartbeat — abandoned tabs still expire and TTL
// reclaims them). No normal timeout while the tab heartbeats; explicit
// revocation (logout/disable/PIN reset) still takes effect immediately.
// Responses carry no secrets: { refreshed: true } or a stable 401 code the
// existing client session-ended UX already handles.
async function handler(request) {
  const rl = checkRateLimit(request, { key: "tab_heartbeat", ...RATE_LIMITS.GENERAL });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }

  let raw = null;
  try {
    const { TAB_SESSION_HEADER } = await import("@/lib/serverAuth");
    raw = request.headers.get(TAB_SESSION_HEADER);
    if (raw) raw = String(raw).trim() || null;
  } catch {
    raw = null;
  }
  if (!raw) return fail("Authentication required", 401);

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database connection error. Please retry shortly.", 503);
  }

  try {
    const { refreshTabSession } = await import("@/lib/sessionStore");
    const res = await refreshTabSession(conn, raw);
    if (!res.ok) {
      if (res.code === "DB_UNAVAILABLE") return fail("Database connection error. Please retry shortly.", 503);
      if (res.code === "ACCOUNT_DISABLED") return fail("Account disabled. Please contact manager.", 401, "ACCOUNT_DISABLED");
      if (res.code === "SESSION_REVOKED") return fail("Your session is no longer valid. Please sign in again.", 401, "SESSION_REVOKED");
      return fail("Invalid or expired session", 401, "SESSION_EXPIRED");
    }
    return ok({ refreshed: true });
  } catch {
    return fail("Database connection error. Please retry shortly.", 503);
  }
}

export const POST = withApi(handler);
