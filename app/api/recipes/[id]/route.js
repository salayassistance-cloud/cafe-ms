import { connectToDatabase } from "@/lib/mongodb";
import { getRecipeModel } from "@/lib/models/Recipe";
import { getMenuItemModel } from "@/lib/models/MenuItem";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { validateRecipeUpdate } from "@/lib/recipeValidation";
import { serializeRecipe } from "@/lib/recipeService";
import { validateObjectId, sanitizeString } from "@/lib/validate";

export const dynamic = "force-dynamic";

// PATCH /api/recipes/[id] — MANAGER only
async function patchHandler(request, { params }) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "recipe:mutate") && !can(auth.payload.role, "inventory:mutate")) {
    return fail("Forbidden: requires MANAGER", 403);
  }

  const { id } = await params;
  const sid = sanitizeString(id, { maxLen: 50 });
  if (!sid || !validateObjectId(sid)) return fail("Invalid recipe id", 400);

  const len = request.headers.get("content-length");
  if (len && Number(len) > 50 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid request body", 400);

  const validated = validateRecipeUpdate(body);
  if (!validated.ok) return fail(validated.error, 400);

  try {
    const conn = await connectToDatabase();
    const Recipe = getRecipeModel(conn);
    const MenuItem = getMenuItemModel(conn);
    const InventoryItem = getInventoryItemModel(conn);

    // Verify referential integrity if changing ids
    if (validated.data.menuItemId) {
      const exists = await MenuItem.findById(validated.data.menuItemId).select("_id").lean();
      if (!exists) return fail("Menu item not found", 404);
      const dup = await Recipe.findOne({ menuItemId: validated.data.menuItemId, _id: { $ne: sid } }).lean();
      if (dup) return fail("Recipe for this menu item already exists", 409);
    }
    if (validated.data.ingredients) {
      const invIds = validated.data.ingredients.map((i) => i.inventoryItemId);
      const invDocs = await InventoryItem.find({ _id: { $in: invIds } }).select("name unit").lean();
      if (invDocs.length !== invIds.length) return fail("One or more inventory items not found", 404);
      const invUnitMap = new Map(invDocs.map((d) => [String(d._id), String(d.unit || "").trim().toLowerCase()]));
      for (const ing of validated.data.ingredients) {
        const expectedUnit = invUnitMap.get(String(ing.inventoryItemId)) || "";
        const ingUnit = String(ing.unit || "").trim().toLowerCase();
        if (expectedUnit && ingUnit !== expectedUnit) {
          const invName = invDocs.find((d) => String(d._id) === String(ing.inventoryItemId))?.name || ing.inventoryItemId;
          return fail(`Unit mismatch for ingredient "${invName}": recipe unit "${ing.unit}" does not match inventory unit "${invDocs.find((d) => String(d._id) === String(ing.inventoryItemId))?.unit}"`, 400);
        }
      }
    }

    const doc = await Recipe.findOneAndUpdate(
      { _id: sid },
      { $set: { ...validated.data, updatedAt: new Date() } },
      { new: true, runValidators: true }
    ).lean();
    if (!doc) return fail("Recipe not found", 404);

    // Populate for response
    const menuDoc = doc.menuItemId ? await MenuItem.findById(doc.menuItemId).lean() : null;
    const menuMap = menuDoc ? new Map([[String(menuDoc._id), menuDoc]]) : new Map();
    const invIds = (doc.ingredients || []).map((i) => String(i.inventoryItemId));
    const invDocs = invIds.length ? await InventoryItem.find({ _id: { $in: invIds } }).select("name category unit currentStock status").lean() : [];
    const invMap = new Map(invDocs.map((i) => [String(i._id), i]));

    return ok({ recipe: serializeRecipe(doc, menuMap, invMap) }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    if (err && err.code === 11000) return fail("Recipe for this menu item already exists", 409);
    console.error("[api] recipes PATCH error:", err);
    return fail(err?.message || "Failed to update recipe", 500);
  }
}

// DELETE /api/recipes/[id] — soft deactivate isActive=false — MANAGER only
async function deleteHandler(request, { params }) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "recipe:mutate") && !can(auth.payload.role, "inventory:mutate")) {
    return fail("Forbidden: requires MANAGER", 403);
  }

  const { id } = await params;
  const sid = sanitizeString(id, { maxLen: 50 });
  if (!sid || !validateObjectId(sid)) return fail("Invalid recipe id", 400);

  try {
    const conn = await connectToDatabase();
    const Recipe = getRecipeModel(conn);
    const doc = await Recipe.findOneAndUpdate(
      { _id: sid },
      { $set: { isActive: false, updatedAt: new Date() } },
      { new: true }
    ).lean();
    if (!doc) return fail("Recipe not found", 404);
    return ok({ recipe: { _id: String(doc._id), isActive: doc.isActive } }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] recipes DELETE error:", err);
    return fail(err?.message || "Failed to deactivate recipe", 500);
  }
}

export const PATCH = withApi(patchHandler);
export const DELETE = withApi(deleteHandler);
