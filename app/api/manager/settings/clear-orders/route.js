import { connectToDatabase } from "@/lib/mongodb";
import { verifyStaffPinById } from "@/lib/staffService";
import { getOrderModel } from "@/lib/models/Order";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { validatePin } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";

export const dynamic = "force-dynamic";

// POST /api/manager/settings/clear-orders
// Manager-triggered order-history reset. Wipes every order, resets the order
// sequence counter, and releases every locked waiter slot. Requires an
// authenticated MANAGER session (canonical resolver: tab credential first,
// then server session, then legacy compat) + step-up re-authentication with
// the REQUESTING MANAGER's own Staff PIN (prevents CSRF/session-only bypass
// for this destructive confirmation). No SystemAuth involvement.
async function handler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);

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
  // AUTH-ARCH-8A: step-up re-authentication against the requesting MANAGER's
  // own Staff PIN (canonical Staff credential). The legacy SystemAuth role-PIN
  // check was removed: it verified a shared role secret instead of the
  // authenticated staff member, and kept this flow on SystemAuth. Sessions
  // without a Staff identity (legacy bootstrap) cannot pass this step.
  const authorised = await verifyStaffPinById(conn, auth.payload.staffId, currentManagerPin);
  if (!authorised.ok) {
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
