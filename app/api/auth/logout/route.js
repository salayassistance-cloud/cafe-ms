import { cookies } from "next/headers";
import { withApi } from "@/lib/withApi";
import { ok } from "@/lib/apiResponse";

export const dynamic = "force-dynamic";

// POST /api/auth/logout
// Revokes the presenting session and clears the canonical session cookie.
// AUTH-ARCH-8F: legacy bono_sess is no longer issued or authorized, so there
// is nothing legacy to clear. No device/waiterNumber logic — waiter identity
// is Staff._id via session.
// AUTH-ARCH-3: also revokes the server-side session (LOGOUT). Idempotent —
// a missing/already-revoked session still returns success. Best-effort DB
// access: cookie clearing + success response never depend on it.
// AUTH-ARCH-11: tab-scoped logout. When the X-Bono-Tab-Session header names
// this tab's credential, ONLY that Session row is revoked — other tabs (even
// other tabs of the same Staff) are untouched. Cookie clearing is preserved
// so no stale authenticated shell survives.
async function handler(request) {

  const store = await cookies();
  try {
    const { revokeSession, revokeSessionByTabCredential } = await import("@/lib/sessionStore");
    const { TAB_SESSION_HEADER } = await import("@/lib/serverAuth");
    const { NEW_SESSION_COOKIE, NEW_SESSION_COOKIE_DELETE_OPTS } = await import("@/lib/serverSessionCookies");
    const tabRaw = request.headers.get(TAB_SESSION_HEADER) || request.headers.get(TAB_SESSION_HEADER.toLowerCase());
    const hasTab = !!(tabRaw && tabRaw.trim());
    if (hasTab) {
      try {
        const { connectToDatabase } = await import("@/lib/mongodb");
        const conn = await connectToDatabase();
        await revokeSessionByTabCredential(conn, tabRaw.trim(), "LOGOUT");
      } catch {}
    }
    // Tab isolation: the browser-wide cookie may name ANOTHER tab's live
    // station session. Only revoke the cookie-presented row for pure
    // cookie-only flows (no tab credential presented); a tab logout revokes
    // exactly its own row above and must never invalidate other tabs.
    // Cookie clearing below is browser-local and revokes nothing.
    const outgoing = store.get(NEW_SESSION_COOKIE)?.value || null;
    if (outgoing && !hasTab) {
      try {
        const { connectToDatabase } = await import("@/lib/mongodb");
        const conn = await connectToDatabase();
        await revokeSession(conn, outgoing, "LOGOUT");
      } catch {}
    }
    try {
      store.delete(NEW_SESSION_COOKIE);
      store.set(NEW_SESSION_COOKIE, "", NEW_SESSION_COOKIE_DELETE_OPTS);
    } catch {}
  } catch {}

  return ok({ loggedOut: true });
}

export const POST = withApi(handler);
