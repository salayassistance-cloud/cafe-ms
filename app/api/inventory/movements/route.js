import { connectToDatabase } from "@/lib/mongodb";
import { getStockMovementModel } from "@/lib/models/StockMovement";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { serializeMovement } from "@/lib/inventoryService";
import { validateObjectId, sanitizeString, validateDateString } from "@/lib/validate";

export const dynamic = "force-dynamic";

// GET /api/inventory/movements?item=&from=&to=
// Read only — MANAGER only, supports item filter + date range
// No creation endpoint in Phase D, no automatic currentStock change, no order connection.
async function getHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "inventory:read")) return fail("Forbidden: requires MANAGER", 403);

  const { searchParams } = new URL(request.url);
  const rawItem = searchParams.get("item");
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  const rawItemId = searchParams.get("itemId"); // alias

  const query = {};

  const itemId = rawItem || rawItemId;
  if (itemId) {
    const sid = sanitizeString(itemId, { maxLen: 50 });
    if (!sid || !validateObjectId(sid)) return fail("Invalid item filter: must be ObjectId", 400);
    query.item = sid;
  }

  // Date range filters on createdAt
  let fromDate = null;
  let toDate = null;
  if (rawFrom) {
    const ds = sanitizeString(rawFrom, { maxLen: 20 });
    if (!ds || !validateDateString(ds)) return fail("Invalid from date (use YYYY-MM-DD)", 400);
    const d = new Date(ds);
    d.setHours(0, 0, 0, 0);
    fromDate = d;
  }
  if (rawTo) {
    const ds = sanitizeString(rawTo, { maxLen: 20 });
    if (!ds || !validateDateString(ds)) return fail("Invalid to date (use YYYY-MM-DD)", 400);
    const d = new Date(ds);
    d.setHours(23, 59, 59, 999);
    toDate = d;
  }
  if (fromDate && toDate && fromDate > toDate) return fail("from date must be before to date", 400);
  if (fromDate || toDate) {
    query.createdAt = {};
    if (fromDate) query.createdAt.$gte = fromDate;
    if (toDate) query.createdAt.$lte = toDate;
  }

  try {
    const conn = await connectToDatabase();
    const StockMovement = getStockMovementModel(conn);
    const docs = await StockMovement.find(query)
      .select("item type quantity reason createdBy refOrderId notes createdAt updatedAt")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    const movements = docs.map(serializeMovement);
    return ok({ count: movements.length, movements }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] inventory movements GET error:", err);
    return fail("Failed to load stock movements", 500);
  }
}

export const GET = withApi(getHandler);
