import { connectToDatabase } from "@/lib/mongodb";
import { getRecipeModel } from "@/lib/models/Recipe";
import { getMenuItemModel } from "@/lib/models/MenuItem";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { validateRecipeCreate } from "@/lib/recipeValidation";
import { serializeRecipe } from "@/lib/recipeService";

export const dynamic = "force-dynamic";

// GET /api/recipes
// Returns recipes with menu item + inventory item info — MANAGER only
async function getHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "recipe:read") && !can(auth.payload.role, "inventory:read")) {
    return fail("Forbidden: requires MANAGER", 403);
  }

  try {
    const conn = await connectToDatabase();
    const Recipe = getRecipeModel(conn);
    const MenuItem = getMenuItemModel(conn);
    const InventoryItem = getInventoryItemModel(conn);

    const recipes = await Recipe.find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    // Batch fetch related docs
    const menuIds = [...new Set(recipes.map((r) => String(r.menuItemId)).filter(Boolean))];
    const invIds = [...new Set(recipes.flatMap((r) => (r.ingredients || []).map((i) => String(i.inventoryItemId))).filter(Boolean))];

    const [menuDocs, invDocs] = await Promise.all([
      menuIds.length ? MenuItem.find({ _id: { $in: menuIds } }).lean() : [],
      invIds.length ? InventoryItem.find({ _id: { $in: invIds } }).select("name category unit currentStock status").lean() : [],
    ]);

    const menuMap = new Map(menuDocs.map((m) => [String(m._id), m]));
    const invMap = new Map(invDocs.map((i) => [String(i._id), i]));

    const data = recipes.map((r) => serializeRecipe(r, menuMap, invMap));
    return ok({ count: data.length, recipes: data }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] recipes GET error:", err);
    return fail("Failed to load recipes", 500);
  }
}

// POST /api/recipes
// Create recipe — MANAGER only
async function postHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "recipe:mutate") && !can(auth.payload.role, "inventory:mutate")) {
    return fail("Forbidden: requires MANAGER", 403);
  }

  const len = request.headers.get("content-length");
  if (len && Number(len) > 50 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Invalid request body: expected JSON object", 400);
  }

  const validated = validateRecipeCreate(body);
  if (!validated.ok) return fail(validated.error, 400);

  try {
    const conn = await connectToDatabase();
    const Recipe = getRecipeModel(conn);
    const MenuItem = getMenuItemModel(conn);
    const InventoryItem = getInventoryItemModel(conn);

    // Verify menu item exists
    const menuExists = await MenuItem.findById(validated.data.menuItemId).select("_id name").lean();
    if (!menuExists) return fail("Menu item not found", 404);

    // Verify inventory items exist and validate unit consistency (case-insensitive)
    const invIds = validated.data.ingredients.map((i) => i.inventoryItemId);
    const invDocsForValidation = await InventoryItem.find({ _id: { $in: invIds } }).select("name category unit currentStock status").lean();
    if (invDocsForValidation.length !== invIds.length) return fail("One or more inventory items not found", 404);
    const invUnitMap = new Map(invDocsForValidation.map((d) => [String(d._id), String(d.unit || "").trim().toLowerCase()]));
    for (const ing of validated.data.ingredients) {
      const expectedUnit = invUnitMap.get(String(ing.inventoryItemId)) || "";
      const ingUnit = String(ing.unit || "").trim().toLowerCase();
      if (expectedUnit && ingUnit !== expectedUnit) {
        const invName = invDocsForValidation.find((d) => String(d._id) === String(ing.inventoryItemId))?.name || ing.inventoryItemId;
        return fail(`Unit mismatch for ingredient "${invName}": recipe unit "${ing.unit}" does not match inventory unit "${invDocsForValidation.find((d) => String(d._id) === String(ing.inventoryItemId))?.unit}"`, 400);
      }
    }

    // Check duplicate recipe for same menuItem
    const existing = await Recipe.findOne({ menuItemId: validated.data.menuItemId }).lean();
    if (existing) return fail("Recipe for this menu item already exists", 409);

    const doc = new Recipe(validated.data);
    await doc.save();

    // Serialize for response — reuse already-fetched inventory docs
    const menuMap = new Map([[String(menuExists._id), menuExists]]);
    const invMap = new Map(invDocsForValidation.map((i) => [String(i._id), i]));
    return ok({ recipe: serializeRecipe(doc.toObject(), menuMap, invMap) }, 201);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    if (err && err.code === 11000) return fail("Recipe for this menu item already exists", 409);
    console.error("[api] recipes POST error:", err);
    return fail(err?.message || "Failed to create recipe", 500);
  }
}

export const GET = withApi(getHandler);
export const POST = withApi(postHandler);
