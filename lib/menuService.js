// Canonical Menu domain service — single source for Category/MenuItem serialization
// and alias resolution. Route handlers and Server Components MUST use this
// instead of inline mapping, so `category` vs `categoryId` and similar aliases
// are resolved in one place.
//
// CANONICAL fields (write target):
//   MenuItem: category (ObjectId → Category), targetStation
//             (KITCHEN/BARISTA/HOT_DRINK), imageUrl, isNew, isAvailable
// ALIASES (read + write-compat, migrated lazily):
//   categoryId ↔ category, station ↔ targetStation, image ↔ imageUrl,
//   isItemNew/isPopular ↔ isNew, inStock/available ↔ isAvailable
// Category: canonical slug + targetStation + type + order; displayOrder is alias.

import { getLocalizedSingleString } from "@/lib/displayName";
import { STATIONS, resolveMenuItemStation } from "@/lib/menuStation";
import {
  INVENTORY_POLICY,
  resolveInventoryPolicy,
  isTrackedRecipeUsable,
} from "@/lib/inventoryPolicy";

// Re-exported so existing callers keep one import site; the vocabulary and the
// resolution priority live in lib/menuStation.js (also used by recipe
// stock-area compatibility and DB-free tests).
export { STATIONS, resolveMenuItemStation };

export const CATEGORY_TYPES = { FOOD: "FOOD", DRINK: "DRINK", HOT_DRINK: "HOT_DRINK" };

// Resolve the canonical station for a category doc.
// Explicit `targetStation` always wins (three-way); type is the fallback.
// Existing coffee/barista heuristics are intentionally unchanged: moving the
// historical coffee catalog to HOT_DRINK is an operator opt-in migration
// (scripts/migrate-hot-drink-station.mjs), never an implicit runtime retarget.
export function resolveCategoryStation(cat) {
  if (!cat) return STATIONS.KITCHEN;
  if (cat.targetStation === "HOT_DRINK") return STATIONS.HOT_DRINK;
  if (cat.targetStation === "BARISTA") return STATIONS.BARISTA;
  if (cat.targetStation) return STATIONS.KITCHEN;
  if (cat.type === "HOT_DRINK") return STATIONS.HOT_DRINK;
  if (cat.type === "DRINK") return STATIONS.BARISTA;
  const name = typeof cat.name === "object" ? cat.name?.en || "" : String(cat.name || "");
  if (/drink|barista|juice|coffee|beer|wine/i.test(name) || /drink|barista/i.test(cat.slug || "")) {
    return STATIONS.BARISTA;
  }
  return STATIONS.KITCHEN;
}

export function serializeCategory(doc) {
  const rawName = doc.name;
  const display = typeof rawName === "string" ? rawName : rawName?.en || rawName?.am || rawName?.om || "";
  const displayAm = typeof rawName === "string" ? rawName : rawName?.am || rawName?.en || display;
  const displayOm = typeof rawName === "string" ? rawName : rawName?.om || rawName?.en || display;
  const station = resolveCategoryStation(doc);
  const order = doc.order ?? doc.displayOrder ?? 0;
  return {
    _id: String(doc._id),
    id: String(doc._id),
    name: display,
    nameEn: typeof rawName === "object" ? rawName?.en || display : display,
    nameAm: typeof rawName === "object" ? rawName?.am || display : display,
    nameAmharic: displayAm,
    nameOm: displayOm,
    displayName: display,
    nameObj: typeof rawName === "object" ? rawName : { en: display, am: display, om: display },
    slug: doc.slug || "",
    type: doc.type || (station === "BARISTA" ? "DRINK" : station === "HOT_DRINK" ? "HOT_DRINK" : "FOOD"),
    targetStation: station,
    station,
    order,
    displayOrder: doc.displayOrder ?? doc.order ?? order,
    isActive: doc.isActive !== false,
  };
}

export function serializeMenuItem(doc, categoriesMap, options = {}) {
  const id = String(doc._id);
  const name = doc.name || {};
  const desc = doc.description || {};
  const nameEn = typeof name === "string" ? name : name.en || name.am || name.om || "";
  const nameAm = typeof name === "string" ? name : name.am || name.en || "";
  const nameOm = typeof name === "string" ? name : name.om || name.en || "";
  const descEn = typeof desc === "string" ? desc : desc.en || "";
  const descAm = typeof desc === "string" ? desc : desc.am || "";
  const descOm = typeof desc === "string" ? desc : desc.om || "";
  const catId = doc.category ? String(doc.category) : doc.categoryId ? String(doc.categoryId) : "";
  const cat = categoriesMap ? categoriesMap.get(catId) : null;
  const catName = cat ? cat.name : "";
  const station = resolveMenuItemStation(doc);
  const price = Number(doc.price) || 0;
  const title = nameEn || nameAm || nameOm || getLocalizedSingleString(name) || "";
  const isAvailable = doc.isAvailable !== false && doc.inStock !== false;
  const inventoryPolicy = resolveInventoryPolicy(doc);
  const inventoryPolicyResolved =
    inventoryPolicy === "TRACKED" || inventoryPolicy === "UNTRACKED";
  // D9/D10: neutral orderability signal for Waiter/public clients. It never
  // carries the policy value itself; getUnifiedMenu refines it with the Recipe
  // batch for TRACKED items.
  const orderable = isAvailable && inventoryPolicyResolved;
  const barista = !!(cat?.slug?.includes("drink") || cat?.slug?.includes("barista") || station === "BARISTA");
  const hotDrink = !!(station === "HOT_DRINK" || doc.categoryType === "HOT_DRINK");
  const serialized = {
    _id: id,
    id,
    name: { en: nameEn, am: nameAm, om: nameOm },
    fullName: { en: nameEn, am: nameAm, om: nameOm },
    nameEn,
    nameAm,
    nameOm,
    title,
    titleAmharic: nameAm || title,
    titleOm: nameOm || title,
    // titleLocalized is filled by caller per lang; default to EN for compat
    titleLocalized: title,
    description: { en: descEn, am: descAm, om: descOm },
    descriptionEn: descEn,
    descriptionAm: descAm,
    descriptionOm: descOm,
    // legacy string description for /api/menu compat (EN)
    descriptionString: descEn || descAm || "",
    price,
    currency: "ETB",
    priceDisplay: `ETB ${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    category: catId,
    categoryId: catId,
    categoryName: catName,
    categorySlug: cat?.slug || "",
    categoryType:
      doc.categoryType ||
      (station === "BARISTA" ? "DRINK" : station === "HOT_DRINK" ? "HOT_DRINK" : "FOOD"),
    station,
    targetStation: station,
    barista,
    hotDrink,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) || "item",
    imageUrl: doc.imageUrl || doc.image || "",
    image: doc.image || doc.imageUrl || "",
    isSpecial: !!doc.isSpecial,
    isNew: !!(doc.isNew || doc.isItemNew || doc.isPopular),
    isItemNew: !!(doc.isNew || doc.isItemNew),
    isPopular: !!(doc.isNew || doc.isPopular),
    isAvailable,
    inStock: isAvailable,
    isFasting: !!doc.isFasting,
    isNonFasting: doc.isNonFasting !== undefined ? !!doc.isNonFasting : !doc.isFasting,
    // H1: UNKNOWN means "not reviewed"; EXTERNAL is historical read-only.
    // Callers must not present either as an orderable tracked/untracked item.
    //
    // D12: these two fields are internal catalog metadata. They are kept for the
    // protected Manager path (getUnifiedMenu default) and stripped from every
    // public/Waiter HTTP payload by passing { includeInventoryPolicy: false }.
    inventoryPolicy,
    inventoryPolicyResolved,
    // D9/D10: the only orderability signal public clients receive. Neutral
    // boolean — no policy enum, no Recipe/inventory detail.
    orderable,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
  if (options.includeInventoryPolicy === false) {
    delete serialized.inventoryPolicy;
    delete serialized.inventoryPolicyResolved;
  }
  return serialized;
}

// D9: a TRACKED item whose Recipe cannot produce a requirement is already
// rejected at submit time; mark it non-orderable so the Waiter UI never offers
// it. A Recipe read failure returns an empty set: the catalog stays visible and
// the server gate remains authoritative (an optional flag must never hide a
// valid item).
async function findTrackedItemsWithoutUsableRecipe(conn, rawItems) {
  const tracked = (Array.isArray(rawItems) ? rawItems : []).filter(
    (doc) => resolveInventoryPolicy(doc) === INVENTORY_POLICY.TRACKED
  );
  const trackedIds = tracked.map((doc) => doc?._id).filter(Boolean);
  if (trackedIds.length === 0) return new Set();
  try {
    const { getRecipeModel } = await import("@/lib/models/Recipe");
    const Recipe = getRecipeModel(conn);
    const rows = await Recipe.find({ menuItemId: { $in: trackedIds } }).lean();
    const counts = new Map();
    const byMenuId = new Map();
    for (const row of rows || []) {
      const key = String(row.menuItemId);
      counts.set(key, (counts.get(key) || 0) + 1);
      byMenuId.set(key, row);
    }
    const blocked = new Set();
    for (const doc of tracked) {
      const key = String(doc._id);
      // Duplicate Recipe documents are ambiguous and fail closed, matching the
      // canonical TRACKED gate in lib/orderService.js.
      const recipe = counts.get(key) === 1 ? byMenuId.get(key) : null;
      if (!isTrackedRecipeUsable(recipe)) blocked.add(key);
    }
    return blocked;
  } catch {
    return new Set();
  }
}

// Fetch + serialize in one call (used by /api/menu and server pages)
// includeUnavailable=false filters to available/inStock only (waiter view);
// includeUnavailable=true returns everything (manager CRUD).
// includeInventoryPolicy=false strips the internal policy metadata from the
// payload (public/Waiter HTTP); the protected Manager page keeps the default.
export async function getUnifiedMenu({
  includeUnavailable = false,
  includeInventoryPolicy = true,
} = {}) {
  const { connectToDatabase } = await import("@/lib/mongodb");
  const conn = await connectToDatabase();
  const { getCategoryModel } = await import("@/lib/models/Category");
  const { getMenuItemModel } = await import("@/lib/models/MenuItem");
  const Category = getCategoryModel(conn);
  const MenuItem = getMenuItemModel(conn);
  const [cats, items] = await Promise.all([
    Category.find({}).select("name slug order displayOrder type targetStation isActive").sort({ order: 1, displayOrder: 1, slug: 1 }).lean(),
    MenuItem.find({ isDeleted: { $ne: true } }).select("name description price category categoryId categoryType station targetStation imageUrl image isSpecial isNew isItemNew isPopular isAvailable isFasting isNonFasting inStock inventoryPolicy createdAt updatedAt").sort({ createdAt: -1 }).lean(),
  ]);
  const serializedCats = cats.map(serializeCategory);
  const catMap = new Map(serializedCats.map((c) => [String(c._id), c]));
  let serializedItems = items.map((doc) =>
    serializeMenuItem(doc, catMap, { includeInventoryPolicy })
  );
  // D9: refine the neutral flag with Recipe usability for TRACKED items. The
  // requirement never reads live Recipes per request in the UI; this single
  // batched read is the same source the submit gate uses.
  const recipeBlockedIds = await findTrackedItemsWithoutUsableRecipe(conn, items);
  if (recipeBlockedIds.size > 0) {
    serializedItems = serializedItems.map((it) =>
      recipeBlockedIds.has(String(it._id)) ? { ...it, orderable: false } : it
    );
  }
  if (!includeUnavailable) {
    serializedItems = serializedItems.filter((it) => it.isAvailable);
  }
  return { categories: serializedCats, items: serializedItems, rawCats: cats, rawItems: items };
}
