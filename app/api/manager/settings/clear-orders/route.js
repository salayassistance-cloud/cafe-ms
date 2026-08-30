import { connectToDatabase } from "@/lib/mongodb";
import { verifyRolePin } from "@/lib/authService";
import { getOrderModel } from "@/lib/models/Order";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { validatePin } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";

export const dynamic = "force-dynamic";

// POST /api/manager/settings/clear-orders
// Manager-triggered order-history reset. Wipes every order, resets the order
// sequence counter, and releases every locked waiter slot. Requires authenticated
// MANAGER session (HttpOnly cookie) + re-authentication via currentManagerPin
// for destructive confirmation (prevents CSRF/session-only bypass).
async function handler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);

  const rl = checkRateLimit(request, { key: "clear_orders", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  const len = request.headers.get("content-length");
  if (len && Number(len) > 5 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  const currentManagerPin = validatePin(body?.currentManagerPin);
  if (!currentManagerPin) {
    return fail("Manager PIN re-authentication required (4 digits) for destructive action", 400);
  }

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database temporarily unavailable", 503);
  }
  const authorised = await verifyRolePin(conn, "MANAGER", currentManagerPin);
  if (!authorised) {
    return fail("Manager PIN incorrect", 401);
  }

  const Order = getOrderModel(conn);
  const deleted = await Order.deleteMany({});

  // Reset the order sequence counter so the next order restarts at ORD-1001.
  await conn.collection("counters").updateOne(
    { _id: "order_seq" },
    { $set: { seq: 0 } },
    { upsert: true }
  );

  return ok({ clearedOrders: deleted.deletedCount });
}

export const POST = withApi(handler);
