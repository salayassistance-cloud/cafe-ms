import { connectToDatabase } from "@/lib/mongodb";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { validateInventoryItemUpdate } from "@/lib/inventoryValidation";
import { serializeInventoryItem } from "@/lib/inventoryService";
import { validateObjectId, sanitizeString } from "@/lib/validate";

export const dynamic = "force-dynamic";

// PATCH /api/inventory/items/[id]
// Update allowed fields: name, category, unit, minimumStock, cost, status, supplier — MANAGER only
async function patchHandler(request, { params }) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "inventory:mutate")) return fail("Forbidden: requires MANAGER", 403);

  const { id } = await params;
  const sanitizedId = sanitizeString(id, { maxLen: 50 });
  if (!sanitizedId || !validateObjectId(sanitizedId)) return fail("Invalid inventory item id", 400);

  const len = request.headers.get("content-length");
  if (len && Number(len) > 50 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Invalid request body", 400);
  }

  const validated = validateInventoryItemUpdate(body);
  if (!validated.ok) return fail(validated.error, 400);

  try {
    const conn = await connectToDatabase();
    const InventoryItem = getInventoryItemModel(conn);
    const doc = await InventoryItem.findOneAndUpdate(
      { _id: sanitizedId },
      { $set: { ...validated.data, updatedAt: new Date() } },
      { new: true, runValidators: true }
    ).lean();
    if (!doc) return fail("Inventory item not found", 404);
    return ok({ item: serializeInventoryItem(doc) }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    if (err && err.code === 11000) return fail("Inventory item already exists", 409);
    console.error("[api] inventory items PATCH error:", err);
    return fail(err?.message || "Failed to update inventory item", 500);
  }
}

export const PATCH = withApi(patchHandler);
