import { connectToDatabase } from "@/lib/mongodb";
import { getExtraItemModel } from "@/lib/models/ExtraItem";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import {
  listExtraItems,
  serializeExtraItem,
  validateExtraItemPayload,
} from "@/lib/extraItemService";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";

export const dynamic = "force-dynamic";

// GET /api/extra-items — Manager Extra Item management list.
async function getHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  if (!can(auth.payload.role, "inventory:read")) {
    return fail("Forbidden: requires MANAGER", 403);
  }

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database connection error. Please retry shortly.", 503);
  }
  try {
    const items = await listExtraItems(conn);
    return ok({ count: items.length, items }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] extra items GET error:", err);
    return fail("Failed to load Extra Items", 500);
  }
}

// POST /api/extra-items — Manager creates a sellable Extra Item linked to an
// existing canonical InventoryItem. No recipe is required or accepted.
async function postHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  if (!can(auth.payload.role, "inventory:mutate")) {
    return fail("Forbidden: requires MANAGER", 403);
  }

  const len = request.headers.get("content-length");
  if (len && Number(len) > 50 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  const validated = validateExtraItemPayload(body, { partial: false });
  if (!validated.ok) return fail(validated.error, 400);

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database connection error. Please retry shortly.", 503);
  }
  try {
    const InventoryItem = getInventoryItemModel(conn);
    const inventoryItem = await InventoryItem.findById(validated.data.inventoryItemId)
      .select("_id name unit stockGroup")
      .lean();
    if (!inventoryItem) return fail("Linked inventory item not found", 404);

    const ExtraItem = getExtraItemModel(conn);
    const doc = await ExtraItem.create({
      ...validated.data,
      inventoryItemId: inventoryItem._id,
    });
    return ok({ item: serializeExtraItem(doc.toObject(), inventoryItem) }, 201);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] extra items POST error:", err);
    return fail(err?.message || "Failed to create Extra Item", 500);
  }
}

export const GET = withApi(getHandler);
export const POST = withApi(postHandler);
