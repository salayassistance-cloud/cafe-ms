import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { changeStaffPin } from "@/lib/staffService";
import { NextResponse } from "next/server";
import { validateChangePinPayload } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/change-pin — self-service PIN change (canonical Staff).
 * Requires authenticated session; uses session staffId only (ignore client staffId unless it matches session).
 * Validates current PIN against Staff.pinHash, then hashes new PIN.
 * Manager authorized changes for others must use POST /api/manager/staff.
 */
async function handler(request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return NextResponse.json({ success: false, message: auth.error }, { status: auth.status });

  const rl = checkRateLimit(request, { key: "change_pin", limit: 10, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json({ success: false, message: `Too many attempts. Retry after ${retryAfterSeconds(rl.retryAfterMs)}s` }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds(rl.retryAfterMs)) } });
  }
  const len = request.headers.get("content-length");
  if (len && Number(len) > 5 * 1024) return NextResponse.json({ success: false, message: "Payload too large" }, { status: 413 });
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
  }

  const validated = validateChangePinPayload(body);
  if (!validated.ok) {
    return NextResponse.json({ success: false, message: validated.error }, { status: 400 });
  }
  const { currentPin, newPin } = validated.data;

  // Enforce session ownership — ignore client staffId unless it exactly matches session
  const sessionStaffId = auth.payload.staffId ? String(auth.payload.staffId) : null;
  if (!sessionStaffId) {
    return NextResponse.json({ success: false, message: "Session has no staff identity. Please re-login." }, { status: 401 });
  }
  if (validated.data.staffId && String(validated.data.staffId) !== sessionStaffId) {
    return NextResponse.json({ success: false, message: "Cannot change another user's PIN" }, { status: 403 });
  }

  const conn = await connectToDatabase();
  const result = await changeStaffPin(conn, { staffId: sessionStaffId, currentPin, newPin });
  if (!result.ok) {
    return NextResponse.json({ success: false, message: result.error }, { status: 400 });
  }
  return NextResponse.json({ success: true, message: "PIN updated successfully" }, { status: 200 });
}

export const POST = withApi(handler);
