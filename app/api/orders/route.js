import { connectToDatabase } from "@/lib/mongodb";
import { getOrderModel } from "@/lib/models/Order";
import { createOrder, toKdsShape } from "@/lib/orderService";
import { publish } from "@/lib/eventHub";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { cookies } from "next/headers";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/sessionCrypto";
import { requireAuth } from "@/lib/security";
import { can, canTransition } from "@/lib/policy";
import { validateCreateOrderPayload, sanitizeString, validateDateString } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// POST /api/orders
// Creates a new order. Prices are snapshotted from the MenuItem catalog (via
// lib/orderService) and per-item subTotals + the grand total are computed, then
// the order is persisted. Terminals are notified instantly over the SSE event
// stream and refetch, so the new ticket appears on the KDS/Barista boards
// immediately instead of on the next poll.
// Auditable: waiter identity is derived from the HTTP-only session (staffId/name)
// when present, so every order is locked to the logged-in waiter. Requires
// authenticated WAITER or MANAGER (policy: orders:create). Browser is untrusted.
async function postHandler(request) {
  const auth = await requireAuth(request, ["WAITER", "MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "orders:create")) return fail("Forbidden: requires WAITER or MANAGER", 403);

  // Rate limit: 30 orders per minute per IP (prevents spam)
  const rl = checkRateLimit(request, { key: "orders_create", ...RATE_LIMITS.ORDER_CREATE });
  if (!rl.ok) {
    const res = fail("Too many order requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }

  // Payload size guard + body parsing
  const len = request.headers.get("content-length");
  if (len && Number(len) > 50 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Invalid request body: expected JSON object", 400);
  }

  // Derive waiter identity from authenticated session — auditable binding (session already verified)
  let sessionWaiter = null;
  if (auth.payload.role === "WAITER") sessionWaiter = auth.payload;
  else if (auth.payload.role === "MANAGER" && auth.payload.staffId) {
    // Manager creating order on behalf of waiter — use manager identity but keep waiterName from payload if present
    sessionWaiter = auth.payload;
  }

  // If session has staff identity, override payload to ensure auditable binding
  if (sessionWaiter) {
    const sid = sessionWaiter.staffId || sessionWaiter.waiterId || null;
    const sname = sessionWaiter.name || sessionWaiter.staffName || sessionWaiter.waiterName || null;
    if (sid) body.waiterId = sid;
    if (sname) body.waiterName = sname;
    if (sessionWaiter.waiterNumber != null) body.waiterNumber = sessionWaiter.waiterNumber;
    // Also populate waiterInfo for legacy shape
    body.waiterInfo = {
      ...(body.waiterInfo || {}),
      waiterId: sid ? String(sid) : body.waiterInfo?.waiterId || null,
      waiterNumber: sessionWaiter.waiterNumber ?? body.waiterInfo?.waiterNumber ?? body.waiterNumber ?? null,
    };
  }

  // Strict validation & sanitization (Zod-like)
  const validated = validateCreateOrderPayload(body);
  if (!validated.ok) {
    return fail(validated.error, 400);
  }

  const sanitizedBody = {
    ...validated.data,
    // Preserve auditable session overrides
    ...(sessionWaiter ? {
      waiterId: body.waiterId,
      waiterName: body.waiterName,
      waiterNumber: body.waiterNumber,
      waiterInfo: body.waiterInfo,
    } : {}),
  };

  let conn;
  try {
    conn = await connectToDatabase();
  } catch (e) {
    return fail("Database connection error. Please retry shortly.", 503);
  }

  let doc;
  try {
    doc = await createOrder(conn, sanitizedBody);
  } catch (e) {
    const msg = String(e?.message || "");
    if (/tableNumber|must contain|required/i.test(msg)) return fail(msg, 400);
    throw e; // let withApi map to 500/503
  }

  // Non-blocking push to connected terminals (KDS / Barista / Waiter).
  // Minimal invalidation — clients refetch their own (role-scoped) feed.
  publish({
    type: "orders-changed",
    reason: "created",
    orderId: String(doc._id),
  });

  return ok({ order: toKdsShape(doc) }, 201);
}

// GET /api/orders?status=PENDING&table=3&date=YYYY-MM-DD&paymentMethod=CASH&waiterName=Abel
// Fetch orders with optional status / table / payment / date / waiter filters.
// Spec requires: GET /api/orders?status=READY&waiterName={name} returns only READY
// orders for that specific waiter (used for "Ready to Serve" per-waiter alerts).
// All query params are strictly validated & sanitized to prevent injection.
// Requires authentication (policy: orders:read = any authenticated staff).
async function getHandler(request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "orders:read")) return fail("Forbidden", 403);
  const { searchParams } = new URL(request.url);
  // Validate query params - reject overly long values to prevent DoS
  const rawStatus = searchParams.get("status");
  const rawTable = searchParams.get("table");
  const rawPayment = searchParams.get("paymentMethod");
  const rawDest = searchParams.get("dest");
  const rawWaiterName = searchParams.get("waiterName");
  const rawWaiterId = searchParams.get("waiterId");
  const rawWaiterNumber = searchParams.get("waiterNumber");
  const rawDate = searchParams.get("date");

  // Basic length guards
  if (rawStatus && rawStatus.length > 20) return fail("Invalid status param", 400);
  if (rawWaiterName && rawWaiterName.length > 50) return fail("waiterName too long", 400);
  if (rawDate && rawDate.length > 20) return fail("Invalid date param", 400);

  let conn;
  try {
    conn = await connectToDatabase();
  } catch (e) {
    return fail("Database connection error. Please retry shortly.", 503);
  }
  const Order = getOrderModel(conn);

  const query = {};
  // Status - strict allowlist
  if (rawStatus) {
    const s = rawStatus.trim().toUpperCase();
    const allowed = ["PENDING","PREPARING","READY","SERVED","PAID","CANCELLED","ARCHIVED","ACTIVE"];
    if (!allowed.includes(s)) return fail(`Invalid status: ${sanitizeString(s, { maxLen: 20 }) || "unknown"}`, 400);
    if (s === "ACTIVE") {
      query.status = { $in: ["PENDING", "PREPARING", "READY"] };
    } else {
      query.status = s;
    }
  } else {
    query.status = { $in: ["PENDING", "PREPARING", "READY"] };
  }

  if (rawTable && /^\d+$/.test(rawTable.trim())) {
    const n = Number(rawTable.trim());
    if (n >= 1 && n <= 50) query.tableNumber = n;
  }

  if (rawPayment) {
    const pm = rawPayment.trim().toUpperCase();
    if (["CASH","TELEBIRR","NONE"].includes(pm)) query.paymentMethod = pm;
    else return fail("Invalid paymentMethod", 400);
  }

  if (rawDest) {
    const d = rawDest.trim().toUpperCase();
    if (d === "FOOD" || d === "DRINK") query["items.type"] = d;
    else if (d !== "ALL" && d.length > 0) return fail("Invalid dest param", 400);
  }

  // Phase 6.5: ownership enforcement — WAITER sees only own orders (staffId canonical), KDS/BARISTA see by station not waiter
  const role = String(auth.payload.role).toUpperCase();
  if (role === "WAITER") {
    // Force own orders only — ignore any client-provided waiter filters (client is untrusted)
    if (!auth.payload.staffId) return fail("Waiter session missing staff identity", 401);
    query.waiterId = String(auth.payload.staffId);
  } else if (role === "KITCHEN" || role === "BARISTA") {
    // KDS/Barista sees by station (items.type) via dest filter, not by waiter ownership — ignore waiter filters
    // (client waiter params are ignored for these roles)
  } else if (role === "MANAGER") {
    // Manager may filter by waiter if explicitly requested (auditable)
    if (rawWaiterName) {
      const sanitized = sanitizeString(rawWaiterName, { maxLen: 50 });
      if (!sanitized) return fail("Invalid waiterName", 400);
      query.waiterName = sanitized;
    }
    if (rawWaiterId) {
      if (!/^[a-fA-F0-9]{24}$/.test(rawWaiterId.trim())) return fail("Invalid waiterId", 400);
      query.waiterId = rawWaiterId.trim();
    }
    if (rawWaiterNumber && /^\d+$/.test(rawWaiterNumber.trim())) {
      const n = Number(rawWaiterNumber.trim());
      if (n >= 1 && n <= 10) query.waiterNumber = n;
    }
  }

  if (rawDate) {
    const dateStr = rawDate.trim();
    // Strict YYYY-MM-DD only - prevents injection via Date parsing
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!m) return fail("Invalid date format (use YYYY-MM-DD)", 400);
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return fail("Invalid date", 400);
    const start = new Date(y, mo - 1, d);
    start.setHours(0, 0, 0, 0);
    const end = new Date(y, mo - 1, d);
    end.setHours(23, 59, 59, 999);
    // Verify date didn't overflow (e.g. Feb 30)
    if (start.getMonth() !== mo - 1 || start.getDate() !== d) return fail("Invalid date", 400);
    query.createdAt = { $gte: start, $lte: end };
  }

  // Optimized: select only needed fields, lean, indexed sort
  const orders = await Order.find(query)
    .select("orderNumber tableNumber waiterName waiterId waiterNumber waiterInfo kitchenStaffId baristaStaffId items status kitchenStatus baristaStatus totalAmount paymentMethod createdAt updatedAt preparingAt readyAt servedAt paidAt completedAt kitchenPreparingAt kitchenReadyAt baristaPreparingAt baristaReadyAt isExternal")
    .sort({ createdAt: -1 })
    .limit(200) // safety cap - prevents huge payload DoS
    .lean();
  const shaped = orders.map(toKdsShape);
  return ok({ count: shaped.length, orders: shaped }, 200);
}

export const POST = withApi(postHandler);
export const GET = withApi(getHandler);
