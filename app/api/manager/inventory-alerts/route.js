import { connectToDatabase } from "@/lib/mongodb";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { getInventoryAlerts } from "@/lib/inventoryAlertService";

export const dynamic = "force-dynamic";

// GET /api/manager/inventory-alerts — MANAGER only, inventory:read
async function getHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "inventory:read")) return fail("Forbidden: requires MANAGER", 403);

  try {
    const conn = await connectToDatabase();
    const data = await getInventoryAlerts(conn);
    return ok(data, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] inventory-alerts error:", err);
    return fail("Failed to load inventory alerts", 500);
  }
}

export const GET = withApi(getHandler);
