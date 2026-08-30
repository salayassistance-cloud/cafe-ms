// Canonical Menu domain service — single source for Category/MenuItem serialization
// and alias resolution. Route handlers and Server Components MUST use this
// instead of inline mapping, so `category` vs `categoryId` and similar aliases
// are resolved in one place.
//
// CANONICAL fields (write target):
//   MenuItem: category (ObjectId → Category), targetStation (KITCHEN/BARISTA),
//             imageUrl, isNew, isAvailable
// ALIASES (read + write-compat, migrated lazily):
//   categoryId ↔ category, station ↔ targetStation, image ↔ imageUrl,
//   isItemNew/isPopular ↔ isNew, inStock/available ↔ isAvailable
// Category: canonical slug + targetStation + type + order; displayOrder is alias.

import { getLocalizedSingleString } from "@/lib/displayName";

export const STATIONS = { KITCHEN: "KITCHEN", BARISTA: "BARISTA" };
export const CATEGORY_TYPES = { FOOD: "FOOD", DRINK: "DRINK" };

// Resolve the canonical station for a category doc
export function resolveCategoryStation(cat) {
  if (!cat) return STATIONS.KITCHEN;
  if (cat.targetStation) return cat.targetStation === "BARISTA" ? STATIONS.BARISTA : STATIONS.KITCHEN;
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
    type: doc.type || (station === "BARISTA" ? "DRINK" : "FOOD"),
    targetStation: station,
    station,
    order,
    displayOrder: doc.displayOrder ?? doc.order ?? order,
    isActive: doc.isActive !== false,
  };
}

export function serializeMenuItem(doc, categoriesMap) {
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
  const station = doc.targetStation || doc.station || (doc.categoryType === "DRINK" ? "BARISTA" : "KITCHEN");
  const price = Number(doc.price) || 0;
  const title = nameEn || nameAm || nameOm || getLocalizedSingleString(name) || "";
  const isAvailable = doc.isAvailable !== false && doc.inStock !== false;
  const barista = !!(cat?.slug?.includes("drink") || cat?.slug?.includes("barista") || station === "BARISTA");
  return {
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
    categoryType: doc.categoryType || (station === "BARISTA" ? "DRINK" : "FOOD"),
    station,
    targetStation: station,
    barista,
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
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

// Fetch + serialize in one call (used by /api/menu and server pages)
// includeUnavailable=false filters to available/inStock only (waiter view);
// includeUnavailable=true returns everything (manager CRUD).
export async function getUnifiedMenu({ includeUnavailable = false } = {}) {
  const { connectToDatabase } = await import("@/lib/mongodb");
  const conn = await connectToDatabase();
  const { getCategoryModel } = await import("@/lib/models/Category");
  const { getMenuItemModel } = await import("@/lib/models/MenuItem");
  const Category = getCategoryModel(conn);
  const MenuItem = getMenuItemModel(conn);
  const [cats, items] = await Promise.all([
    Category.find({}).select("name slug order displayOrder type targetStation isActive").sort({ order: 1, displayOrder: 1, slug: 1 }).lean(),
    MenuItem.find({}).select("name description price category categoryId categoryType station targetStation imageUrl image isSpecial isNew isItemNew isPopular isAvailable isFasting isNonFasting inStock createdAt updatedAt").sort({ createdAt: -1 }).lean(),
  ]);
  const serializedCats = cats.map(serializeCategory);
  const catMap = new Map(serializedCats.map((c) => [String(c._id), c]));
  let serializedItems = items.map((doc) => serializeMenuItem(doc, catMap));
  if (!includeUnavailable) {
    serializedItems = serializedItems.filter((it) => it.isAvailable);
  }
  return { categories: serializedCats, items: serializedItems, rawCats: cats, rawItems: items };
}
