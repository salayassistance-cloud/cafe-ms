import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { connectToDatabase } from "@/lib/mongodb";
import { getExternalItemRequestModel } from "@/lib/models/ExternalItemRequest";
import { requireAuth } from "@/lib/security";
import { addisWallToUTC } from "@/lib/analytics";

export const dynamic = "force-dynamic";

// POST /api/external-items — DEPRECATED: Extra Items are now part of Order.items (isExternal:true)
// Historical GET remains for Manager Reports (read-only). New POST is disabled — use POST /api/orders with Extra Items
async function postHandler(request) {
  return fail("External requests are deprecated — add Extra Items to the order instead", 410);
}

// GET /api/external-items
// Manager reports endpoint. Returns external item requests, optionally filtered
// by date range / status / type. Used by the Manager Reports "EXTERNAL ITEM"
// section for historical data only. Waiter may read only their own requests when no manager role.
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
        const d = addisWallToUTC(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, 0);
        if (d && !Number.isNaN(d.getTime())) range.$gte = d;
      } else {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) range.$gte = d;
      }
    }
    if (to) {
      const m = ymd.exec(String(to).trim());
      if (m) {
        const d = addisWallToUTC(Number(m[1]), Number(m[2]), Number(m[3]), 23, 59, 59, 999);
        if (d && !Number.isNaN(d.getTime())) range.$lte = d;
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
