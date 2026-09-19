import { connectToDatabase } from "@/lib/mongodb";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { validateDateString } from "@/lib/validate";
import {
  getStockUsage,
  getInventoryValuation,
  getPurchaseHistory,
} from "@/lib/inventoryAnalyticsService";

export const dynamic = "force-dynamic";

// GET /api/manager/inventory-analytics?from=YYYY-MM-DD&to=YYYY-MM-DD
// MANAGER only, permission inventory:read
async function getHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "inventory:read")) return fail("Forbidden: requires MANAGER", 403);

  const { searchParams } = new URL(request.url);
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");

  let from = null;
  let to = null;

  if (rawFrom) {
    const v = validateDateString(rawFrom);
    if (!v) return fail("Invalid from date (use YYYY-MM-DD)", 400);
    const d = new Date(v);
    d.setHours(0, 0, 0, 0);
    from = d;
  }
  if (rawTo) {
    const v = validateDateString(rawTo);
    if (!v) return fail("Invalid to date (use YYYY-MM-DD)", 400);
    const d = new Date(v);
    d.setHours(23, 59, 59, 999);
    to = d;
  }
  if (from && to && from > to) return fail("from date must be before to date", 400);

  try {
    const conn = await connectToDatabase();

    const [usage, valuation, purchases] = await Promise.all([
      getStockUsage(conn, { from, to }),
      getInventoryValuation(conn),
      getPurchaseHistory(conn, { from, to }),
    ]);

    return ok({ usage, valuation, purchases }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] inventory-analytics error:", err);
    return fail("Failed to load inventory analytics", 500);
  }
}

export const GET = withApi(getHandler);
