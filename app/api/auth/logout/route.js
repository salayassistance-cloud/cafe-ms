import { SESSION_COOKIE, SESSION_COOKIE_DELETE_OPTS } from "@/lib/sessionCrypto";
import { cookies } from "next/headers";
import { withApi } from "@/lib/withApi";
import { ok } from "@/lib/apiResponse";

export const dynamic = "force-dynamic";

// POST /api/auth/logout
// Clears the signed session cookie. No device/waiterNumber logic — waiter identity is Staff._id via session.
async function handler(request) {

  const store = await cookies();
  // Use delete with path/sameSite/secure to ensure browser matches cookie scope (fixation protection)
  try {
    store.delete(SESSION_COOKIE);
    // Also set expired cookie explicitly for cross-browser compat
    store.set(SESSION_COOKIE, "", SESSION_COOKIE_DELETE_OPTS);
  } catch {}

  return ok({ loggedOut: true });
}

export const POST = withApi(handler);
