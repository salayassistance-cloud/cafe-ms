// Server-side session read for guarded Server Components / layouts.
// Verifies the signed HttpOnly cookie and returns the decoded payload
// ({ role, waiterNumber? }) or null when absent / tampered.

import { cookies } from "next/headers";
import {
  verifySessionToken,
  SESSION_COOKIE,
  SESSION_IDLE_TIMEOUT_MS,
} from "@/lib/sessionCrypto";

export async function getPortalSession(role) {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload || payload.role !== role) return null;
  // Enforce idle timeout for Server Component guards as well
  if (payload.iat && Date.now() - Number(payload.iat) > SESSION_IDLE_TIMEOUT_MS) return null;
  // Enforce isActive so disabled waiter cannot see portal even if cookie remains
  if (payload.staffId) {
    try {
      const { connectToDatabase } = await import("@/lib/mongodb");
      const { getStaffModel } = await import("@/lib/models/Staff");
      const conn = await connectToDatabase();
      const Staff = getStaffModel(conn);
      const staff = await Staff.findById(payload.staffId).select("isActive role").lean();
      if (!staff || staff.isActive === false) return null;
      if (staff.role !== String(payload.role).toUpperCase()) return null;
    } catch {}
  }
  return payload;
}
