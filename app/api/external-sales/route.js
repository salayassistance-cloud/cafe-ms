import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { connectToDatabase } from "@/lib/mongodb";
import { getOrderModel } from "@/lib/models/Order";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";

export const dynamic = "force-dynamic";

// POST /api/external-sales
// Records a manually-entered external sale (e.g. a retail item or expense the
// waiter adds directly) as a PAID order flagged isExternal:true. Because the
// Manager Reports dashboard reads from the orders collection, these register
// automatically under "external sales" without ever touching the KDS boards.
async function postHandler(request) {
  const auth = await requireAuth(request, ["WAITER", "MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);

  const rl = checkRateLimit(request, { key: "external_sales", ...RATE_LIMITS.GENERAL });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid JSON body", 400);
  }

  const tableNumber = Number(body.tableNumber);
  if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 50) {
    return fail("Valid tableNumber (1-50) is required", 400);
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) return fail("At least one item is required", 400);

  const items = [];
  let total = 0;
  for (const it of rawItems) {
    const name = typeof it.name === "string" ? it.name.trim() : "";
    const price = Number(it.price);
    const quantity = Number(it.quantity) || 1;
    if (!name) return fail("Each item requires a name", 400);
    if (!Number.isFinite(price) || price < 0) return fail("Each item requires a valid price", 400);
    const qty = Math.min(Math.max(Math.floor(quantity), 1), 99);
    items.push({ name, price: Math.round(price * 100) / 100, quantity: qty, type: "FOOD", isExternal: true });
    total += price * qty;
  }
  total = Math.round(total * 100) / 100;

  // Phase 6.5: server session is authoritative — ignore client waiter identity for WAITER
  let waiterName, waiterNumber, waiterId;
  if (String(auth.payload.role).toUpperCase() === "WAITER") {
    waiterName = auth.payload.name || auth.payload.waiterName || "Waiter";
    waiterNumber = auth.payload.waiterNumber ?? null;
    waiterId = auth.payload.staffId || null;
  } else {
    // MANAGER may specify waiter explicitly (e.g., correcting on behalf)
    waiterName =
      typeof body.waiterName === "string" && body.waiterName.trim()
        ? body.waiterName.trim()
        : (auth.payload?.name || "Waiter");
    waiterNumber =
      body.waiterNumber != null ? Number(body.waiterNumber) : (auth.payload?.waiterNumber ?? null);
    waiterId = body.waiterId || auth.payload?.staffId || auth.payload?.waiterId || null;
  }
  const paymentMethod = body.paymentMethod === "TELEBIRR" ? "TELEBIRR" : "CASH";

  try {
    const conn = await connectToDatabase();
    const Order = getOrderModel(conn);
    const orderNumber = `EXT-${Date.now().toString().slice(-8)}`;
    const doc = new Order({
      orderNumber,
      tableNumber,
      waiterName,
      waiterNumber,
      waiterId,
      items,
      status: "PAID",
      totalAmount: total,
      paymentMethod,
      isExternal: true,
      paidAt: new Date(),
      completedAt: new Date(),
    });
    await doc.save();
    return ok(
      { order: { _id: String(doc._id), orderNumber, totalAmount: total, isExternal: true } },
      201
    );
  } catch (e) {
    if (isDbError(e)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] external-sales error:", e?.message || e);
    return fail("Failed to record external sale", 500);
  }
}

export const POST = withApi(postHandler);
