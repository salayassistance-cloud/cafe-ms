// Server-side session read for guarded Server Components / layouts.
// AUTH-ARCH-4: delegates to the canonical resolver in lib/serverAuth — the
// same authority as requireAuth (new server session -> live Staff).
// Returns the live payload ({ staffId, role, name, waiterNumber? }) when the
// session is valid for `role`, else null. Fail-closed: DB/network failure
// yields null (never authenticated).

import { cookies } from "next/headers";
import { getLiveSessionFromCookies } from "@/lib/serverAuth";

export async function getPortalSession(role) {
  const store = await cookies();
  const payload = await getLiveSessionFromCookies(store, [role]);
  if (!payload) return null;
  if (String(payload.role).toUpperCase() !== String(role).toUpperCase()) return null;
  return payload;
}
