import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { requireAuth } from "@/lib/security";

export const dynamic = "force-dynamic";

// GET /api/auth/me — returns current authenticated session (if any)
// Used by /waiter to check if already logged in as WAITER
async function handler(request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return fail(auth.error, auth.status);
  // Return minimal safe session info
  const p = auth.payload;
  return ok({
    staffId: p.staffId || null,
    role: p.role,
    name: p.name || p.staffName || null,
    waiterNumber: p.waiterNumber ?? null,
  }, 200);
}

export const GET = withApi(handler);
