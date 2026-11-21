import { connectToDatabase } from "@/lib/mongodb";
import { listExtraItemCatalog } from "@/lib/extraItemService";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";

export const dynamic = "force-dynamic";

// GET /api/extra-items/catalog
// Read-only Extra Item picker catalog. Only available Extra Items whose linked
// InventoryItem still exists and uses a supported stock unit are returned. The
// server supplies the canonical name, selling price, category and stock unit;
// the client never submits those values back.
async function getHandler(request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  if (!can(auth.payload.role, "orders:create")) {
    return fail("Forbidden: requires WAITER or MANAGER", 403);
  }

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database connection error. Please retry shortly.", 503);
  }

  const items = await listExtraItemCatalog(conn);
  return ok({ count: items.length, items }, 200);
}

export const GET = withApi(getHandler);
