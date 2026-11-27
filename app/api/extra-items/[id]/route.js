import { connectToDatabase } from "@/lib/mongodb";
import { getExtraItemModel } from "@/lib/models/ExtraItem";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { serializeExtraItem, validateExtraItemPayload } from "@/lib/extraItemService";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { validateObjectId, sanitizeString } from "@/lib/validate";

export const dynamic = "force-dynamic";

function requireManager(auth) {
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  if (!can(auth.payload.role, "inventory:mutate")) {
    return fail("Forbidden: requires MANAGER", 403);
  }
  return null;
}

// PATCH /api/extra-items/[id] — Manager edits display name, category, selling
// price, availability and stock association. Inventory cost is never writable
// through this endpoint.
async function patchHandler(request, { params }) {
  const auth = await requireAuth(request, ["MANAGER"]);
  const denied = requireManager(auth);
  if (denied) return denied;

  const { id } = await params;
  const sanitizedId = sanitizeString(id, { maxLen: 50 });
  if (!sanitizedId || !validateObjectId(sanitizedId)) {
    return fail("Invalid Extra Item id", 400);
  }

  const len = request.headers.get("content-length");
  if (len && Number(len) > 50 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  const validated = validateExtraItemPayload(body, { partial: true });
  if (!validated.ok) return fail(validated.error, 400);

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database connection error. Please retry shortly.", 503);
  }
  try {
    const ExtraItem = getExtraItemModel(conn);
    const InventoryItem = getInventoryItemModel(conn);

    let inventoryItem = null;
    if (validated.data.inventoryItemId !== undefined) {
      inventoryItem = await InventoryItem.findById(validated.data.inventoryItemId)
        .select("_id name unit stockGroup")
        .lean();
      if (!inventoryItem) return fail("Linked inventory item not found", 404);
    }

    const doc = await ExtraItem.findByIdAndUpdate(
      sanitizedId,
      { $set: { ...validated.data, updatedAt: new Date() } },
      { returnDocument: 'after', runValidators: true }
    ).lean();
    if (!doc) return fail("Extra Item not found", 404);

    if (!inventoryItem) {
      inventoryItem = await InventoryItem.findById(doc.inventoryItemId)
        .select("_id name unit stockGroup")
        .lean();
    }
    return ok({ item: serializeExtraItem(doc, inventoryItem) }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] extra items PATCH error:", err);
    return fail(err?.message || "Failed to update Extra Item", 500);
  }
}

// DELETE /api/extra-items/[id] — historical orders keep their component
// snapshots, so removing a sellable Extra Item never rewrites past sales.
async function deleteHandler(request, { params }) {
  const auth = await requireAuth(request, ["MANAGER"]);
  const denied = requireManager(auth);
  if (denied) return denied;

  const { id } = await params;
  const sanitizedId = sanitizeString(id, { maxLen: 50 });
  if (!sanitizedId || !validateObjectId(sanitizedId)) {
    return fail("Invalid Extra Item id", 400);
  }

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database connection error. Please retry shortly.", 503);
  }
  try {
    const ExtraItem = getExtraItemModel(conn);
    const doc = await ExtraItem.findByIdAndDelete(sanitizedId).lean();
    if (!doc) return fail("Extra Item not found", 404);
    return ok({ deleted: true, id: sanitizedId }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] extra items DELETE error:", err);
    return fail(err?.message || "Failed to delete Extra Item", 500);
  }
}

export const PATCH = withApi(patchHandler);
export const DELETE = withApi(deleteHandler);
