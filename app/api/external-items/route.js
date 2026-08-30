import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { connectToDatabase } from "@/lib/mongodb";
import { getExternalItemRequestModel } from "@/lib/models/ExternalItemRequest";
import { requireAuth } from "@/lib/security";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { sanitizeName, validateQuantity, validatePrice } from "@/lib/validate";

export const dynamic = "force-dynamic";

// POST /api/external-items
// Creates one or more EXTERNAL ITEM REQUESTs raised by a waiter (or manager on
// behalf of a waiter). These are non-menu items needing Manager review.
//
// Server is authoritative:
//  - waiterId / waiterName are derived from the authenticated session (staffId/name)
//  - itemName, quantity, type, price are validated but never trusted for identity
//  - a PENDING status is always stamped by the server
async function postHandler(request) {
  const auth = await requireAuth(request, ["WAITER", "MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!["WAITER", "MANAGER"].includes(String(auth.payload.role).toUpperCase()))
    return fail("Forbidden", 403);

  const rl = checkRateLimit(request, { key: "external_items", ...RATE_LIMITS.GENERAL });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }

  const len = request.headers.get("content-length");
  if (len && Number(len) > 20 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return fail("Invalid request body", 400);

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) return fail("At least one external item is required", 400);
  if (rawItems.length > 50) return fail("Too many items (max 50)", 400);

  const tableNumber =
    Number.isInteger(Number(body.tableNumber)) && Number(body.tableNumber) >= 1 && Number(body.tableNumber) <= 50
      ? Number(body.tableNumber)
      : null;

  // Server-derived waiter identity (waiterId never trusted from client).
  const role = String(auth.payload.role).toUpperCase();
  let waiterId = null;
  let waiterName = "Waiter";
  let waiterNumber = null;
  if (role === "WAITER") {
    waiterId = auth.payload.staffId || null;
    waiterName = auth.payload.name || auth.payload.waiterName || "Waiter";
    waiterNumber = auth.payload.waiterNumber ?? null;
  } else if (role === "MANAGER") {
    // Manager may specify waiter explicitly (e.g. correcting on behalf)
    waiterId = body.waiterId || auth.payload.staffId || null;
    waiterName =
      typeof body.waiterName === "string" && body.waiterName.trim()
        ? body.waiterName.trim()
        : (auth.payload?.name || "Waiter");
    waiterNumber =
      body.waiterNumber != null ? Number(body.waiterNumber) : (auth.payload?.waiterNumber ?? null);
  }

  const requests = [];
  for (let i = 0; i < rawItems.length; i++) {
    const it = rawItems[i];
    if (!it || typeof it !== "object") return fail(`Item ${i}: invalid shape`, 400);
    const name = sanitizeName(it.name || it.itemName);
    if (!name) return fail(`Item ${i}: itemName is required`, 400);
    const qty = validateQuantity(it.quantity ?? it.qty);
    if (qty == null) return fail(`Item ${i}: quantity must be integer 1-99`, 400);
    const price = validatePrice(it.price);
    if (price == null) return fail(`Item ${i}: price must be number >= 0`, 400);
    const typeRaw = String(it.type || it.category || "FOOD").trim().toUpperCase();
    const type = typeRaw === "DRINK" ? "DRINK" : "FOOD";
    requests.push({
      waiterId,
      waiterName,
      waiterNumber,
      tableNumber,
      itemName: name,
      quantity: qty,
      type,
      price: Math.round(price * 100) / 100,
      status: "PENDING",
    });
  }

  try {
    const conn = await connectToDatabase();
    const Model = getExternalItemRequestModel(conn);
    const docs = await Model.insertMany(requests, { ordered: true });
    return ok(
      {
        requests: docs.map((d) => ({
          _id: String(d._id),
          itemName: d.itemName,
          quantity: d.quantity,
          type: d.type,
          price: d.price,
          status: d.status,
          tableNumber: d.tableNumber,
          waiterName: d.waiterName,
          createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
        })),
      },
      201
    );
  } catch (e) {
    if (isDbError(e)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] external-items POST error:", e?.message || e);
    return fail("Failed to record external item request", 500);
  }
}

// GET /api/external-items
// Manager reports endpoint. Returns external item requests, optionally filtered
// by date range / status / type. Used by the Manager Reports "EXTERNAL ITEM"
// section. Waiter may read only their own requests when no manager role.
async function getHandler(request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return fail(auth.error, auth.status);
  const role = String(auth.payload.role).toUpperCase();
  if (!["MANAGER", "WAITER"].includes(role)) return fail("Forbidden", 403);

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const status = searchParams.get("status");
  const type = searchParams.get("type");

  const query = {};
  if (role === "WAITER") {
    // Waiter sees only their own requests
    if (auth.payload.staffId) query.waiterId = String(auth.payload.staffId);
  }
  if (status && ["PENDING", "REVIEWED", "REJECTED"].includes(status.toUpperCase()))
    query.status = status.toUpperCase();
  if (type && (type.toUpperCase() === "FOOD" || type.toUpperCase() === "DRINK"))
    query.type = type.toUpperCase();
  if (from || to) {
    const range = {};
    const ymd = /^(\d{4})-(\d{2})-(\d{2})$/;
    if (from) {
      const m = ymd.exec(String(from).trim());
      if (m) {
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
        if (!Number.isNaN(d.getTime())) range.$gte = d;
      } else {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) range.$gte = d;
      }
    }
    if (to) {
      const m = ymd.exec(String(to).trim());
      if (m) {
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
        if (!Number.isNaN(d.getTime())) range.$lte = d;
      } else {
        const d = new Date(to);
        if (!Number.isNaN(d.getTime())) range.$lte = d;
      }
    }
    if (Object.keys(range).length) query.createdAt = range;
  }

  try {
    const conn = await connectToDatabase();
    const Model = getExternalItemRequestModel(conn);
    const docs = await Model.find(query).sort({ createdAt: -1 }).limit(500).lean();
    return ok(
      {
        count: docs.length,
        requests: docs.map((d) => ({
          _id: String(d._id),
          itemName: d.itemName,
          quantity: d.quantity,
          type: d.type,
          price: d.price,
          status: d.status,
          tableNumber: d.tableNumber ?? null,
          waiterName: d.waiterName,
          waiterId: d.waiterId ? String(d.waiterId) : null,
          waiterNumber: d.waiterNumber ?? null,
          createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
        })),
      },
      200
    );
  } catch (e) {
    if (isDbError(e)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] external-items GET error:", e?.message || e);
    return fail("Failed to load external item requests", 500);
  }
}

export const POST = withApi(postHandler);
export const GET = withApi(getHandler);
