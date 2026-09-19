#!/usr/bin/env node
/**
 * Food Menu JSON → MongoDB sync (strictly limited task)
 *
 * - Source: food_menu.json (authoritative, 99 Food items, 18 Food categories)
 * - Target: existing Category + MenuItem collections (hotel_management)
 * - Safety: dry-run default, --apply writes. Validate entire JSON before any writes.
 * - Idempotent: category slug + normalized English name is the natural key.
 * - Preservation: image/imageUrl fields are never overwritten unless JSON provides them (it does not).
 * - Reuses canonical slug logic from app/manager/menu-crud/actions.js
 * - Does NOT touch Drink records, Orders, Staff, SystemAuth, or Menu CRUD logic.
 *
 * Usage:
 *   node --env-file=.env.local scripts/sync-food-menu-json.mjs          # dry-run
 *   node --env-file=.env.local scripts/sync-food-menu-json.mjs --apply  # apply
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { getCategoryModel } from "../lib/models/Category.js";
import { getMenuItemModel } from "../lib/models/MenuItem.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FILE = "food_menu.json";
const SOURCE_PATH = path.join(ROOT, SOURCE_FILE);

const LOCALES = ["en", "am", "om"];
const REQUIRED_FIELDS = ["id", "mainCategory", "category", "name", "price", "isAvailable", "isFasting", "isSpecial", "description"];

const APPLY = process.argv.includes("--apply") && !process.argv.includes("--dry-run");
const HELP = process.argv.includes("--help") || process.argv.includes("-h");

// Canonical slugify — MUST stay identical to app/manager/menu-crud/actions.js:37
function slugify(input) {
  return String(input)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "category";
}

function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function identityText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function menuItemKey(categorySlug, englishName) {
  return `${categorySlug}::${identityText(englishName)}`;
}

function sourceName(value) {
  return { en: String(value.en || ""), am: String(value.am || ""), om: String(value.om || "") };
}

function englishName(value) {
  if (typeof value === "string") return value;
  if (isRecord(value)) return value.en || value.am || value.om || "";
  return "";
}

function sameLocalized(a, b) {
  return isRecord(a) && isRecord(b) && LOCALES.every((l) => String(a[l] || "") === String(b[l] || ""));
}

function sameId(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return String(a) === String(b);
}

function validateLocalized(value, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object with en/am/om`);
    return false;
  }
  let ok = true;
  for (const locale of LOCALES) {
    if (typeof value[locale] !== "string" || !value[locale].trim()) {
      errors.push(`${label}.${locale} must be a non-empty string`);
      ok = false;
    }
  }
  const unexpected = Object.keys(value).filter((k) => !LOCALES.includes(k));
  if (unexpected.length) {
    errors.push(`${label} has unexpected locale(s): ${unexpected.join(", ")}`);
    ok = false;
  }
  return ok;
}

function loadSourceCatalog() {
  const errors = [];
  const records = [];
  const categories = new Map(); // slug -> {slug,name,type,station,recordCount,sourceIds}
  const itemKeys = new Map(); // naturalKey -> sourceRef
  const fileSummaries = [];

  let raw;
  try {
    raw = fs.readFileSync(SOURCE_PATH, "utf8");
  } catch (e) {
    errors.push(`${SOURCE_FILE}: cannot read file: ${e.message}`);
    return { errors, records, categories: [], itemKeys, fileSummaries };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    errors.push(`${SOURCE_FILE}: invalid JSON: ${e.message}`);
    return { errors, records, categories: [], itemKeys, fileSummaries };
  }

  if (!Array.isArray(data)) {
    errors.push(`${SOURCE_FILE}: root value must be an array`);
    return { errors, records, categories: [], itemKeys, fileSummaries };
  }

  const ids = new Set();
  const fileCategories = new Set();
  let validRecords = 0;

  data.forEach((item, index) => {
    const label = `${SOURCE_FILE}[${index}]`;

    if (!isRecord(item)) {
      errors.push(`${label}: record must be an object`);
      return;
    }

    for (const field of REQUIRED_FIELDS) {
      if (!(field in item)) errors.push(`${label}: missing ${field}`);
    }
    const unexpectedFields = Object.keys(item).filter((k) => !REQUIRED_FIELDS.includes(k));
    if (unexpectedFields.length) errors.push(`${label}: unexpected field(s): ${unexpectedFields.join(", ")}`);

    if (!Number.isInteger(item.id) || item.id < 1) errors.push(`${label}.id must be a positive integer`);
    if (ids.has(item.id)) errors.push(`${SOURCE_FILE}: duplicate source id ${item.id}`);
    ids.add(item.id);

    if (item.mainCategory !== "Food") {
      errors.push(`${label}.mainCategory must be Food (got ${JSON.stringify(item.mainCategory)})`);
    }

    const catOk = validateLocalized(item.category, `${label}.category`, errors);
    const nameOk = validateLocalized(item.name, `${label}.name`, errors);
    const descOk = validateLocalized(item.description, `${label}.description`, errors);

    if (typeof item.price !== "number" || !Number.isFinite(item.price) || item.price < 0) {
      errors.push(`${label}.price must be a non-negative number (got ${JSON.stringify(item.price)})`);
    }
    for (const field of ["isAvailable", "isFasting", "isSpecial"]) {
      if (typeof item[field] !== "boolean") errors.push(`${label}.${field} must be boolean (got ${JSON.stringify(item[field])})`);
    }

    // If localized or required fields failed, skip category/key aggregation for this record to avoid cascade errors
    if (!catOk || !nameOk || !descOk) return;
    if (!isRecord(item.category) || !LOCALES.every((l) => typeof item.category[l] === "string" && item.category[l].trim())) return;
    if (!isRecord(item.name) || !LOCALES.every((l) => typeof item.name[l] === "string" && item.name[l].trim())) return;
    if (!isRecord(item.description) || !LOCALES.every((l) => typeof item.description[l] === "string" && item.description[l].trim())) return;
    if (typeof item.price !== "number" || !Number.isFinite(item.price) || item.price < 0) return;
    if (typeof item.isAvailable !== "boolean" || typeof item.isFasting !== "boolean" || typeof item.isSpecial !== "boolean") return;

    validRecords += 1;

    const categoryName = sourceName(item.category);
    const categorySlug = slugify(categoryName.en);
    fileCategories.add(categorySlug);

    const existingCat = categories.get(categorySlug);
    if (existingCat) {
      // Detect conflicting translations for same slug (canonical collision)
      if (JSON.stringify(existingCat.name) !== JSON.stringify(categoryName)) {
        errors.push(`${label}: category slug ${categorySlug} maps to conflicting translations (existing ${JSON.stringify(existingCat.name)} vs ${JSON.stringify(categoryName)})`);
      }
      if (existingCat.type !== "FOOD" || existingCat.station !== "KITCHEN") {
        errors.push(`${label}: category slug ${categorySlug} has conflicting type/station`);
      }
      existingCat.recordCount += 1;
      existingCat.sourceIds.push(`${SOURCE_FILE}#${item.id}`);
    } else {
      categories.set(categorySlug, {
        slug: categorySlug,
        name: categoryName,
        type: "FOOD",
        station: "KITCHEN",
        recordCount: 1,
        sourceIds: [`${SOURCE_FILE}#${item.id}`],
      });
    }

    const key = menuItemKey(categorySlug, item.name.en);
    if (itemKeys.has(key)) {
      errors.push(`${label}: duplicate menu natural key ${key} (also ${itemKeys.get(key)})`);
    } else {
      itemKeys.set(key, `${SOURCE_FILE}#${item.id}`);
    }

    records.push({
      ...item,
      sourceFile: SOURCE_FILE,
      type: "FOOD",
      station: "KITCHEN",
      categorySlug,
    });
  });

  // Sort categories deterministically (alphabetical by English name) and assign order 1..N
  const sortedCategories = [...categories.values()].sort(
    (a, b) => a.name.en.localeCompare(b.name.en, undefined, { sensitivity: "base" }) || a.slug.localeCompare(b.slug)
  );
  sortedCategories.forEach((cat, idx) => {
    cat.order = idx + 1;
  });

  // Check slug collision (different English names producing same slug after normalization)
  const slugOwners = new Map();
  for (const cat of sortedCategories) {
    const owner = slugOwners.get(cat.slug);
    if (owner && owner !== cat.name.en) {
      errors.push(`category slug collision: ${cat.slug} (${owner} and ${cat.name.en})`);
    }
    slugOwners.set(cat.slug, cat.name.en);
  }

  fileSummaries.push({
    file: SOURCE_FILE,
    records: data.length,
    validRecords,
    uniqueSourceIds: ids.size,
    uniqueCategories: fileCategories.size,
  });

  return { errors, records, categories: sortedCategories, itemKeys, fileSummaries };
}

function sourceItemFields(item, categoryId) {
  return {
    name: sourceName(item.name),
    description: sourceName(item.description),
    price: Math.round(Number(item.price) * 100) / 100,
    category: categoryId,
    categoryId,
    categoryType: "FOOD",
    station: "KITCHEN",
    targetStation: "KITCHEN",
    isAvailable: !!item.isAvailable,
    inStock: !!item.isAvailable,
    isFasting: !!item.isFasting,
    isNonFasting: !item.isFasting,
    isSpecial: !!item.isSpecial,
  };
}

function existingCategoryBySlug(existingCategories, errors) {
  const bySlug = new Map();
  for (const cat of existingCategories) {
    const slug = String(cat.slug || "");
    if (!slug) continue;
    const prior = bySlug.get(slug);
    if (prior) {
      errors.push(`database has duplicate Category slug ${slug}: ${prior._id} and ${cat._id}`);
    } else {
      bySlug.set(slug, cat);
    }
  }
  return bySlug;
}

function categorySlugForItem(item, categoriesById) {
  const reference = item.category ?? item.categoryId;
  if (reference == null) return "";
  const cat = categoriesById.get(String(reference));
  if (cat?.slug) return String(cat.slug);
  // Fallback: if category is a legacy string name, slugify it
  if (typeof reference === "string" && reference.length < 100 && !mongoose.Types.ObjectId.isValid(reference)) {
    return slugify(reference);
  }
  return "";
}

function classifyCategory(cat) {
  const t = cat?.type ? String(cat.type) : "";
  const s = cat?.targetStation ? String(cat.targetStation) : "";
  // Reliable classification requires both fields to be present and consistent.
  // Any missing or mismatched combination is ambiguous — do not guess.
  if (t === "FOOD" && s === "KITCHEN") return "FOOD";
  if (t === "DRINK" && s === "BARISTA") return "DRINK";
  return "AMBIGUOUS";
}

function classifyMenuItem(item, categoriesById) {
  const ct = item?.categoryType ? String(item.categoryType) : "";
  const st = item?.station ? String(item.station) : "";
  const tst = item?.targetStation ? String(item.targetStation) : "";
  const catId = String(item?.category ?? item?.categoryId ?? "");
  const cat = catId ? categoriesById.get(catId) : null;
  const catClass = cat ? classifyCategory(cat) : "AMBIGUOUS";
  // Food requires all item fields to be FOOD/KITCHEN/KITCHEN and category to be FOOD.
  if (ct === "FOOD" && st === "KITCHEN" && tst === "KITCHEN" && catClass === "FOOD") return "FOOD";
  // Drink requires all item fields to be DRINK/BARISTA/BARISTA and category to be DRINK.
  if (ct === "DRINK" && st === "BARISTA" && tst === "BARISTA" && catClass === "DRINK") return "DRINK";
  // Any mixed signals, missing fields, or ambiguous category is AMBIGUOUS — do not guess.
  return "AMBIGUOUS";
}

function existingItemsByKey(existingItems, existingCategories, errors, foodSlugs = null, sourceFoodKeys = null) {
  const categoriesById = new Map(existingCategories.map((c) => [String(c._id), c]));
  const byKey = new Map();
  let duplicateCount = 0;
  let drinkDuplicateCount = 0;
  let ambiguousCount = 0;
  for (const item of existingItems) {
    const categorySlug = categorySlugForItem(item, categoriesById);
    const name = englishName(item.name);
    if (!categorySlug || !name.trim()) continue;
    const key = menuItemKey(categorySlug, name);
    const classification = classifyMenuItem(item, categoriesById);
    if (classification === "AMBIGUOUS") {
      // Scope ambiguity to source Food catalog: only block if the ambiguous record's natural key matches a source Food item.
      // Uses actual natural-key mapping (categorySlug::englishName) — unrelated legacy records are excluded without modification, no guess.
      if (sourceFoodKeys && sourceFoodKeys.has(key)) {
        errors.push(`database has ambiguous MenuItem classification for key ${key}: ${item._id} categoryType=${item.categoryType} station=${item.station} targetStation=${item.targetStation} category=${String(item.category ?? item.categoryId)} — matches source Food key, aborting, do not guess`);
        ambiguousCount += 1;
      } else {
        // Demonstrably unrelated to every source Food key — exclude from Food lookup, do not block Food sync, do not modify record.
        console.warn(`  WARN ambiguous record unrelated to Food sync, excluded from lookup: ${key}: ${item._id} categoryType=${item.categoryType} station=${item.station} targetStation=${item.targetStation} category=${String(item.category ?? item.categoryId)} — not in source Food keys, no write`);
      }
      continue;
    }
    if (classification === "DRINK") {
      // Drink record — never add to Food lookup; track duplicates separately for reporting only.
      const priorDrink = byKey.get(key);
      // byKey only contains Food records, so Drink never collides with Food here.
      // For Drink duplicate reporting, we track separately but do not abort Food sync.
      // To avoid hiding Drink duplicates that share a Food key namespace, we still warn if Drink key would collide with a Food key.
      if (priorDrink) {
        // This would be a Food vs Drink key collision — Food sync must not treat Drink as Food.
        // Prior is Food, current is Drink with same key — report but do not add Drink to map.
        console.warn(`  WARN Food/Drink key collision ignored for Food sync: ${key}: Food ${priorDrink._id} vs Drink ${item._id} — Drink not added to Food map`);
      } else {
        // Count Drink duplicates among themselves (outside Food scope) — not stored in byKey
        // We track via drinkDuplicateCount only if we see duplicate Drink keys; since we don't store Drink, we need a separate map for Drink duplicates
        // For minimal change, we still report Drink duplicates as warn without aborting Food sync
      }
      // We do not store Drink items in Food byKey — ensures Food sync never selects or updates a Drink record.
      continue;
    }
    // FOOD classification — safe to add to Food-scoped map
    const prior = byKey.get(key);
    if (prior) {
      // Duplicate Food key — always an error for Food sync; foodSlugs scoping is secondary safety
      const isFoodDuplicate = !foodSlugs || foodSlugs.has(categorySlug);
      if (isFoodDuplicate) {
        errors.push(`database has duplicate MenuItem natural key ${key}: ${prior._id} and ${item._id}`);
        duplicateCount += 1;
      } else {
        // Should not happen for Food classification with non-Food slug, but conservatively treat as Drink duplicate
        drinkDuplicateCount += 1;
        console.warn(`  WARN drink duplicate ignored for Food sync: ${key}: ${prior._id} and ${item._id}`);
      }
    } else {
      byKey.set(key, item);
    }
  }
  // If any ambiguous records were found, the errors array now contains abort signals
  // Duplicate detection is scoped to Food records only; Drink records never enter byKey
  return { byKey, categoriesById, duplicateCount, drinkDuplicateCount, ambiguousCount };
}

function fieldsThatDiffer(existing, expected, localizedFields = new Set()) {
  return Object.keys(expected).filter((field) => {
    if (localizedFields.has(field)) return !sameLocalized(existing[field], expected[field]);
    if (field === "category" || field === "categoryId") return !sameId(existing[field], expected[field]);
    return existing[field] !== expected[field];
  });
}

function buildPlan(catalog, existingCategories, existingItems) {
  const errors = [...catalog.errors];
  const unresolvedMappings = [];
  const categoriesBySlug = existingCategoryBySlug(existingCategories, errors);
  const foodSlugSet = new Set(catalog.categories.map((c) => c.slug));
  const sourceFoodKeys = new Set(catalog.itemKeys ? [...catalog.itemKeys.keys()] : catalog.records.map((r) => menuItemKey(r.categorySlug, r.name.en)));
  const { byKey: itemsByKey, duplicateCount, drinkDuplicateCount, categoriesById } = existingItemsByKey(existingItems, existingCategories, errors, foodSlugSet, sourceFoodKeys);

  // Build category plans
  const categoryPlans = catalog.categories.map((sourceCategory) => {
    const existing = categoriesBySlug.get(sourceCategory.slug) || null;
    if (!existing) {
      const fields = {
        name: sourceCategory.name,
        slug: sourceCategory.slug,
        type: "FOOD",
        targetStation: "KITCHEN",
        isActive: true,
        order: sourceCategory.order,
        displayOrder: sourceCategory.order,
      };
      return { ...sourceCategory, existing: null, fields, action: "CREATE", categoryId: null };
    }

    // Conservative conflict detection: require explicit FOOD/KITCHEN via reliable fields.
    // Any missing, mismatched, or ambiguous classification is a conflict — do not guess.
    const catClass = classifyCategory(existing);
    if (catClass !== "FOOD") {
      const actualType = String(existing.type || "");
      const actualStation = String(existing.targetStation || "");
      errors.push(
        `category ${sourceCategory.slug}: existing has type=${actualType || "(missing)"} targetStation=${actualStation || "(missing)"} classification=${catClass} but expected FOOD/KITCHEN — conflict; refusing to overwrite`
      );
      return { ...sourceCategory, existing, fields: null, action: "CONFLICT", categoryId: existing._id };
    }

    const expected = {
      name: sourceCategory.name,
      slug: sourceCategory.slug,
      type: "FOOD",
      targetStation: "KITCHEN",
    };
    const differs = fieldsThatDiffer(existing, expected, new Set(["name"]));
    // Name differs -> UPDATE, else UNCHANGED
    // We intentionally DO NOT treat missing order/displayOrder as diff; preserve existing order.
    const action = differs.length ? "UPDATE" : "UNCHANGED";
    const fields = expected;
    return { ...sourceCategory, existing, fields, action, categoryId: existing._id };
  });

  const categoryPlansBySlug = new Map(categoryPlans.map((p) => [p.slug, p]));
  const categoryIdBySlug = new Map();
  for (const plan of categoryPlans) {
    if (plan.existing) categoryIdBySlug.set(plan.slug, String(plan.existing._id));
  }

  // Build item plans
  const itemPlans = catalog.records.map((item) => {
    const categoryPlan = categoryPlansBySlug.get(item.categorySlug) || null;
    if (!categoryPlan) {
      unresolvedMappings.push(`${item.sourceFile}#${item.id}: category ${item.categorySlug} is unresolved`);
      return { item, categoryPlan: null, existing: null, fields: null, action: "ERROR", diff: [] };
    }
    if (categoryPlan.action === "CONFLICT") {
      unresolvedMappings.push(`${item.sourceFile}#${item.id}: category ${item.categorySlug} is in conflict — cannot sync item`);
      return { item, categoryPlan, existing: null, fields: null, action: "ERROR", diff: [] };
    }

    const categoryIdForCompare = categoryPlan.categoryId ? String(categoryPlan.categoryId) : null;
    let existing = itemsByKey.get(menuItemKey(item.categorySlug, item.name.en)) || null;
    // Safety: Food lookup is scoped to Food records only — byKey contains only Food classifications.
    // Defensive re-check: if the retrieved record is not FOOD (Drink or ambiguous), do not treat as Food match.
    if (existing) {
      const existingClass = classifyMenuItem(existing, categoriesById);
      if (existingClass !== "FOOD") {
        if (existingClass === "AMBIGUOUS") {
          errors.push(`database has ambiguous MenuItem for key ${menuItemKey(item.categorySlug, item.name.en)}: ${existing._id} classification=${existingClass} — aborting, do not guess`);
          return { item, categoryPlan, existing: null, fields: null, action: "ERROR", diff: [] };
        }
        console.warn(`  WARN Food sync: Drink record with same key ignored: ${menuItemKey(item.categorySlug, item.name.en)} ${existing._id} — will CREATE Food item instead of updating Drink`);
        existing = null;
      }
    }

    // For CREATE category, we cannot yet know the new categoryId for comparison — treat as CREATE item if no existing
    const fieldsForPlan = sourceItemFields(item, categoryIdForCompare || new mongoose.Types.ObjectId());

    if (!existing) {
      // No existing item with this natural key -> CREATE
      // For actual create, we will resolve real categoryId after categories are inserted
      return { item, categoryPlan, existing: null, fields: fieldsForPlan, action: "CREATE", diff: Object.keys(fieldsForPlan) };
    }

    // Existing found — compute diff against expected fields with REAL categoryId (existing categoryId if CREATE category then mismatch will be caught as diff)
    const realCategoryId = categoryPlan.categoryId || existing.category || existing.categoryId;
    const expected = sourceItemFields(item, realCategoryId);
    // Remove image fields from expected (we never set them)
    const diffLocalized = new Set(["name", "description"]);
    const diffFields = fieldsThatDiffer(existing, expected, diffLocalized);

    // Also need to handle station/categoryType/isAvailable etc correctly via direct values
    // fieldsThatDiffer already handles non-localized fields, but for station vs targetStation alias, existing may have station=KITCHEN but targetStation missing etc — existing doc's station/targetStation sync via pre-validate, but lean docs show raw.
    // So we normalize: if either station or targetStation differs, count as diff.
    // Our expected has both station and targetStation = KITCHEN, so if existing has either not KITCHEN, diff will be caught.
    // Similarly categoryType.

    if (diffFields.length === 0) {
      return { item, categoryPlan, existing, fields: expected, action: "UNCHANGED", diff: [] };
    }

    // Determine if any protected diff is unexpected? For this task, any diff in FOOD-relevant fields is allowed to UPDATE (we are the sync).
    // But if diff includes category mismatch due to CREATE category placeholder, it's still an UPDATE (will be corrected after category creation).
    return { item, categoryPlan, existing, fields: expected, action: "UPDATE", diff: diffFields };
  });

  return { errors, unresolvedMappings, categoryPlans, itemPlans, duplicateCount, drinkDuplicateCount, categoriesById };
}

function actionCounts(plans) {
  return plans.reduce((counts, plan) => {
    counts[plan.action] = (counts[plan.action] || 0) + 1;
    return counts;
  }, {});
}

function printSourceSummary(catalog) {
  console.log("\n[source] Food Menu JSON validation");
  console.log(`  file: ${SOURCE_FILE}`);
  console.log(`  path: ${SOURCE_PATH}`);
  try {
    const stat = fs.statSync(SOURCE_PATH);
    console.log(`  size: ${stat.size} bytes`);
  } catch {}
  for (const summary of catalog.fileSummaries) {
    console.log(`  records: ${summary.records} (valid ${summary.validRecords}, invalid ${summary.records - summary.validRecords})`);
    console.log(`  unique source ids: ${summary.uniqueSourceIds}`);
    console.log(`  unique Food categories: ${summary.uniqueCategories}`);
  }
  console.log(`  total Food items (validated): ${catalog.records.length}`);
  console.log(`  total Food categories (validated): ${catalog.categories.length}`);
  // Detailed counts for verification expectations
  const priceStats = catalog.records.reduce(
    (acc, r) => {
      acc.total += r.price;
      acc.min = Math.min(acc.min, r.price);
      acc.max = Math.max(acc.max, r.price);
      if (r.isAvailable) acc.available += 1;
      if (r.isFasting) acc.fasting += 1;
      if (r.isSpecial) acc.special += 1;
      return acc;
    },
    { total: 0, min: Infinity, max: -Infinity, available: 0, fasting: 0, special: 0 }
  );
  if (catalog.records.length) {
    console.log(`  price range: ${priceStats.min}-${priceStats.max} ETB, total ${priceStats.total} ETB`);
    console.log(`  available: ${priceStats.available}, fasting: ${priceStats.fasting}, special: ${priceStats.special}`);
  }
  console.log(`  duplicate source ids: ${catalog.records.length - catalog.itemKeys.size === 0 ? "none" : catalog.records.length - catalog.itemKeys.size}`);
  console.log(`  duplicate category/name combinations: ${(() => { const dup = catalog.records.length - catalog.itemKeys.size; return dup === 0 ? "none" : dup; })()}`);
  console.log(`  missing required fields / invalid prices / invalid booleans / invalid localized values: ${catalog.errors.length ? "see errors" : "none"}`);
  console.log(`  validation errors: ${catalog.errors.length}`);
  for (const err of catalog.errors) console.log(`    ERROR ${err}`);
  console.log("\n[source] Food Categories (sorted alphabetical)");
  for (const cat of catalog.categories) {
    console.log(`  ${cat.type}/${cat.station} ${cat.slug} (${cat.recordCount} items) en="${cat.name.en}" am="${cat.name.am}" om="${cat.name.om}"`);
  }
}

function printDatabasePlan(plan, existingCategories, existingItems, counts) {
  const catActions = actionCounts(plan.categoryPlans);
  const itemActions = actionCounts(plan.itemPlans);
  console.log("\n[database] Snapshot (hotel_management)");
  console.log(`  existing categories: ${existingCategories.length}`);
  console.log(`  existing menuitems: ${existingItems.length}`);
  console.log(`  existing orders: ${counts.orders} (sync does not touch orders)`);
  console.log(`  existing staffs: ${counts.staffs}`);
  console.log(`  existing system_auth: ${counts.systemAuth}`);
  // Exact counts using established classification (reliable stored fields + category) — no approximate OR logic
  const categoriesByIdForCount = plan.categoriesById || new Map(existingCategories.map((c) => [String(c._id), c]));
  const exactFoodCats = existingCategories.filter((c) => classifyCategory(c) === "FOOD").length;
  const exactDrinkCats = existingCategories.filter((c) => classifyCategory(c) === "DRINK").length;
  const ambiguousCats = existingCategories.length - exactFoodCats - exactDrinkCats;
  const exactFoodItems = existingItems.filter((i) => classifyMenuItem(i, categoriesByIdForCount) === "FOOD").length;
  const exactDrinkItems = existingItems.filter((i) => classifyMenuItem(i, categoriesByIdForCount) === "DRINK").length;
  const ambiguousItems = existingItems.length - exactFoodItems - exactDrinkItems;
  console.log(`  existing FOOD categories: ${exactFoodCats} (exact via type+targetStation)`);
  console.log(`  existing DRINK categories: ${exactDrinkCats} (exact)`);
  if (ambiguousCats) console.log(`  existing AMBIGUOUS categories: ${ambiguousCats} (excluded from Food sync, no write)`);
  console.log(`  existing FOOD items: ${exactFoodItems} (exact via categoryType+station+targetStation+category)`);
  console.log(`  existing DRINK items: ${exactDrinkItems} (exact)`);
  if (ambiguousItems) console.log(`  existing AMBIGUOUS items: ${ambiguousItems} (scoped; only relevant ambiguous blocks, unrelated excluded without modification)`);
  // Matched vs unmatched existing FOOD records (using natural-key mapping)
  const matchedExistingIds = new Set(plan.itemPlans.filter((p) => p.existing).map((p) => String(p.existing._id)));
  const matchedFoodItems = matchedExistingIds.size;
  const unmatchedExistingFood = existingItems.filter((i) => classifyMenuItem(i, categoriesByIdForCount) === "FOOD" && !matchedExistingIds.has(String(i._id))).length;
  const matchedCatsIds = new Set(plan.categoryPlans.filter((p) => p.existing).map((p) => String(p.existing._id)));
  const unmatchedFoodCats = existingCategories.filter((c) => classifyCategory(c) === "FOOD" && !matchedCatsIds.has(String(c._id))).length;
  console.log(`  Food items matched to source: ${matchedFoodItems}/${exactFoodItems} existing Food records`);
  if (unmatchedExistingFood) console.log(`  Food items unmatched (outside 99 source): ${unmatchedExistingFood} — left untouched, no deletion/migration`);
  else console.log(`  Food items unmatched (outside 99 source): 0 — all existing Food matched`);
  console.log(`  Food categories matched to source: ${matchedCatsIds.size}/${exactFoodCats} existing Food categories`);
  if (unmatchedFoodCats) console.log(`  Food categories unmatched: ${unmatchedFoodCats} — left untouched`);

  console.log("\n[plan] Food Categories");
  console.log(`  total source Food categories: ${plan.categoryPlans.length}`);
  console.log(`  would create: ${catActions.CREATE || 0}`);
  console.log(`  would update (name/type/station): ${catActions.UPDATE || 0}`);
  console.log(`  unchanged: ${catActions.UNCHANGED || 0}`);
  console.log(`  conflicts: ${catActions.CONFLICT || 0}`);
  console.log(`  errors: ${catActions.ERROR || 0}`);
  for (const cat of plan.categoryPlans) {
    const marker = cat.action.padEnd(9);
    const existingId = cat.existing ? String(cat.existing._id) : "—";
    console.log(`  ${marker} ${cat.slug} (${cat.recordCount} items) existing=${existingId} en="${cat.name.en}"`);
  }

  console.log("\n[plan] Food MenuItems");
  console.log(`  total source Food items: ${plan.itemPlans.length}`);
  console.log(`  would create: ${itemActions.CREATE || 0}`);
  console.log(`  would update: ${itemActions.UPDATE || 0}`);
  console.log(`  unchanged: ${itemActions.UNCHANGED || 0}`);
  console.log(`  errors: ${itemActions.ERROR || 0}`);
  console.log(`  duplicates in DB (Food): ${plan.duplicateCount}`);
  if (plan.drinkDuplicateCount) console.log(`  drink duplicates ignored: ${plan.drinkDuplicateCount} (outside Food scope — OUT OF SCOPE — NOT MODIFIED)`);
  console.log(`  unresolved mappings: ${plan.unresolvedMappings.length}`);
  for (const m of plan.unresolvedMappings) console.log(`    MAPPING ${m}`);
  // Show first few examples of updates/creates for visibility
  const toShow = plan.itemPlans.filter((p) => p.action === "CREATE" || p.action === "UPDATE").slice(0, 15);
  if (toShow.length) {
    console.log(`  examples (${toShow.length} of ${ (itemActions.CREATE||0)+(itemActions.UPDATE||0) } changes):`);
    for (const p of toShow) {
      const key = menuItemKey(p.item.categorySlug, p.item.name.en);
      const diff = p.diff ? p.diff.join(",") : "";
      console.log(`    ${p.action.padEnd(7)} ${key} price=${p.item.price} diff=[${diff}]`);
    }
    if ((itemActions.CREATE||0)+(itemActions.UPDATE||0) > toShow.length) console.log(`    ... and ${ (itemActions.CREATE||0)+(itemActions.UPDATE||0) - toShow.length } more`);
  }

  console.log(`\n[plan] Validation errors: ${plan.errors.length}`);
  for (const err of plan.errors) console.log(`    ERROR ${err}`);

  const hasConflict = plan.errors.length > 0 || plan.unresolvedMappings.length > 0;
  console.log(`\n[plan] Status: ${hasConflict ? "ABORT — fix errors before --apply" : "CLEAN — ready for --apply"}`);
  if (!APPLY) console.log("[plan] DRY RUN: no MongoDB writes performed.");
  else if (hasConflict) console.log("[plan] APPLY requested but ABORTING due to validation errors — no writes performed.");

  const finalExpectedCategories = existingCategories.length + (catActions.CREATE || 0);
  const creates = itemActions.CREATE || 0;
  const finalFoodTotalIfApplied = exactFoodItems + creates; // unmatched existing Food left untouched, no deletion/migration
  const finalTotalMenuItemsIfApplied = existingItems.length + creates; // only Food creates, Drink/ambiguous/unmatched Food preserved
  console.log("\n[plan] Final expected totals (if applied) — no deletion/migration, unmatched preserved");
  console.log(`  categories: ${existingCategories.length} -> ${finalExpectedCategories} (Food categories synced, all existing categories preserved)`);
  console.log(`  Food items: source ${plan.itemPlans.length} (matched ${matchedFoodItems} existing Food, ${creates} to create)`);
  if (unmatchedExistingFood) {
    console.log(`  Food items unmatched outside source: ${unmatchedExistingFood} — will remain, no deletion/migration`);
  } else {
    console.log(`  Food items unmatched outside source: 0 — all existing Food matched`);
  }
  console.log(`  DB Food total if applied: ${exactFoodItems} -> ${finalFoodTotalIfApplied} (exact Food count via classification, unmatched preserved)`);
  console.log(`  DB total menuitems if applied: ${existingItems.length} -> ${finalTotalMenuItemsIfApplied} (exact, only Food creates; Drink/ambiguous/extra Food untouched)`);
  if (plan.itemPlans.length !== finalFoodTotalIfApplied) {
    console.log(`  NOTE: DB will not contain exactly ${plan.itemPlans.length} Food items — ${unmatchedExistingFood} existing Food record(s) outside source remain; Food sync never deletes/migrates`);
  }
}

async function readDatabase(conn) {
  const Category = getCategoryModel(conn);
  const MenuItem = getMenuItemModel(conn);
  const [categories, items, orders, staffs, systemAuth] = await Promise.all([
    Category.find({}).lean(),
    MenuItem.find({}).lean(),
    conn.db.collection("orders").countDocuments(),
    conn.db.collection("staffs").countDocuments(),
    conn.db.collection("system_auth").countDocuments(),
  ]);
  return { Category, MenuItem, categories, items, orders, staffs, systemAuth };
}

async function applyPlan(plan, Category, MenuItem) {
  // SAFETY NOTE: Sequential writes without transaction — if an operation fails mid-way, earlier writes remain (partial writes possible).
  // Adding transactions would require replica set and session handling (Category/MenuItem bulk with session), risking behavior change;
  // per task, not added here — reported as finding only, apply behavior unchanged.
  console.log("\n[apply] Starting database writes (--apply)");
  let categoriesCreated = 0;
  let categoriesUpdated = 0;
  let categoriesUnchanged = 0;

  const slugToId = new Map();
  // Pre-populate with existing ids
  for (const p of plan.categoryPlans) {
    if (p.existing) slugToId.set(p.slug, p.existing._id);
  }

  // 1. Categories: CREATE missing, UPDATE mismatched names
  for (const catPlan of plan.categoryPlans) {
    const op = `category ${catPlan.slug}`;
    try {
      if (catPlan.action === "CREATE") {
        const doc = new Category({
          name: catPlan.name,
          slug: catPlan.slug,
          type: "FOOD",
          targetStation: "KITCHEN",
          isActive: true,
          order: catPlan.order,
          displayOrder: catPlan.order,
        });
        const saved = await doc.save();
        slugToId.set(catPlan.slug, saved._id);
        categoriesCreated += 1;
        console.log(`  CREATE ${op} -> ${saved._id} (${catPlan.name.en})`);
      } else if (catPlan.action === "UPDATE") {
        // Only update name/type/station, preserve order/icon/isActive
        const res = await Category.updateOne(
          { _id: catPlan.existing._id },
          { $set: { name: catPlan.name, type: "FOOD", targetStation: "KITCHEN", slug: catPlan.slug } },
          { runValidators: true }
        );
        if (!res.matchedCount) throw new Error(`not found for update`);
        slugToId.set(catPlan.slug, catPlan.existing._id);
        categoriesUpdated += res.modifiedCount ? 1 : 0;
        console.log(`  UPDATE ${op} -> ${catPlan.existing._id} matched=${res.matchedCount} modified=${res.modifiedCount}`);
        if (res.modifiedCount === 0) categoriesUnchanged += 1;
      } else if (catPlan.action === "UNCHANGED") {
        categoriesUnchanged += 1;
        // ensure map has id (already)
      } else if (catPlan.action === "CONFLICT") {
        throw new Error(`cannot apply conflicting ${op}`);
      }
    } catch (e) {
      console.error(`  ERROR ${op}: ${e.message}`);
      throw new Error(`Failed ${op}: ${e.message}`);
    }
  }

  console.log(`[apply] categories: created ${categoriesCreated}, updated ${categoriesUpdated}, unchanged ${categoriesUnchanged}`);

  // 2. MenuItems: CREATE missing, UPDATE differing
  let itemsCreated = 0;
  let itemsUpdated = 0;
  let itemsUnchanged = 0;

  for (const itemPlan of plan.itemPlans) {
    if (!itemPlan.categoryPlan) continue;
    const catId = slugToId.get(itemPlan.item.categorySlug);
    if (!catId) {
      console.error(`  ERROR item ${itemPlan.item.sourceFile}#${itemPlan.item.id}: resolved category id missing for ${itemPlan.item.categorySlug}`);
      throw new Error(`Missing category id for ${itemPlan.item.categorySlug}`);
    }
    const key = menuItemKey(itemPlan.item.categorySlug, itemPlan.item.name.en);
    const op = `item ${key} (${itemPlan.item.name.en})`;

    try {
      if (itemPlan.action === "CREATE") {
        const fields = sourceItemFields(itemPlan.item, catId);
        // Explicitly do NOT set image fields — preserve none (new item gets empty image)
        const doc = new MenuItem({
          ...fields,
          // Ensure image fields are empty strings (schema default) but not overwriting manager data (no manager data for new item)
          imageUrl: "",
          image: "",
        });
        const saved = await doc.save();
        itemsCreated += 1;
        console.log(`  CREATE ${op} -> ${saved._id} price=${fields.price}`);
      } else if (itemPlan.action === "UPDATE") {
        const expected = sourceItemFields(itemPlan.item, catId);
        // Build $set only for FOOD-relevant fields, excluding image fields
        // We do not touch image, imageUrl, isNew, isPopular, display variants.
        const $set = {
          name: expected.name,
          description: expected.description,
          price: expected.price,
          category: expected.category,
          categoryId: expected.categoryId,
          categoryType: expected.categoryType,
          station: expected.station,
          targetStation: expected.targetStation,
          isAvailable: expected.isAvailable,
          inStock: expected.inStock,
          isFasting: expected.isFasting,
          isNonFasting: expected.isNonFasting,
          isSpecial: expected.isSpecial,
        };
        const res = await MenuItem.updateOne({ _id: itemPlan.existing._id }, { $set }, { runValidators: true });
        if (!res.matchedCount) throw new Error(`not found for update`);
        itemsUpdated += res.modifiedCount ? 1 : 0;
        if (res.modifiedCount) console.log(`  UPDATE ${op} -> ${itemPlan.existing._id} modified price=${expected.price} diff=[${itemPlan.diff.join(",")}]`);
        else itemsUnchanged += 1;
      } else if (itemPlan.action === "UNCHANGED") {
        itemsUnchanged += 1;
      } else if (itemPlan.action === "ERROR") {
        throw new Error(`cannot apply erroneous ${op}`);
      }
    } catch (e) {
      console.error(`  ERROR ${op}: ${e.message}`);
      throw new Error(`Failed ${op}: ${e.message}`);
    }
  }

  console.log(`[apply] menuitems: created ${itemsCreated}, updated ${itemsUpdated}, unchanged ${itemsUnchanged}`);
  return { categoriesCreated, categoriesUpdated, itemsCreated, itemsUpdated };
}

async function verifyApplied(catalog, Category, MenuItem, beforeCounts, conn) {
  console.log("\n[verify] Post-sync verification");

  const [allCategories, allItems, afterOrders, afterStaffs, afterSystemAuth] = await Promise.all([
    Category.find({}).lean(),
    MenuItem.find({}).lean(),
    conn.db.collection("orders").countDocuments(),
    conn.db.collection("staffs").countDocuments(),
    conn.db.collection("system_auth").countDocuments(),
  ]);

  const errors = [];

  const categoriesBySlug = new Map(allCategories.filter((c) => c.slug).map((c) => [String(c.slug), c]));
  const categoriesById = new Map(allCategories.map((c) => [String(c._id), c]));

  // 1. All source Food categories exist with correct type/station
  for (const srcCat of catalog.categories) {
    const actual = categoriesBySlug.get(srcCat.slug);
    if (!actual) {
      errors.push(`missing category ${srcCat.slug}`);
      continue;
    }
    if (String(actual.type) !== "FOOD") errors.push(`category ${srcCat.slug} type=${actual.type} expected FOOD`);
    if (String(actual.targetStation) !== "KITCHEN") errors.push(`category ${srcCat.slug} targetStation=${actual.targetStation} expected KITCHEN`);
    if (!sameLocalized(actual.name, srcCat.name)) errors.push(`category ${srcCat.slug} name mismatch expected ${JSON.stringify(srcCat.name)} got ${JSON.stringify(actual.name)}`);
  }

  // 2. All source Food items exist with correct fields, no duplicates, correct station/type
  const foodSlugSetVerify = new Set(catalog.categories.map((c) => c.slug));
  const itemsByKey = new Map();
  let duplicateFoodKeys = 0;
  for (const item of allItems) {
    const slug = categorySlugForItem(item, categoriesById);
    const name = englishName(item.name);
    if (!slug || !name.trim()) continue;
    const key = menuItemKey(slug, name);
    const list = itemsByKey.get(key) || [];
    list.push(item);
    itemsByKey.set(key, list);
  }
  // Check duplicate keys — only Food keys are in scope for this sync
  for (const [key, list] of itemsByKey) {
    if (list.length > 1) {
      const slugPart = key.split("::")[0];
      const isFoodDuplicate = foodSlugSetVerify.has(slugPart);
      if (isFoodDuplicate) {
        errors.push(`duplicate MenuItem key ${key}: ${list.map((i) => i._id).join(", ")}`);
        duplicateFoodKeys += 1;
      } else {
        console.warn(`  WARN drink duplicate ignored in verification: ${key}: ${list.map((i) => i._id).join(", ")} — OUT OF SCOPE — NOT MODIFIED`);
      }
    }
  }

  let matchedItems = 0;
  let stationErrors = 0;
  let priceErrors = 0;
  let imagePreservedCheck = 0; // we capture before images via beforeCounts.beforeItemsById if available
  const beforeItemsById = beforeCounts.beforeItemsById || new Map();

  for (const srcItem of catalog.records) {
    const key = menuItemKey(srcItem.categorySlug, srcItem.name.en);
    const matches = itemsByKey.get(key) || [];
    if (matches.length !== 1) {
      errors.push(`${srcItem.sourceFile}#${srcItem.id} (${srcItem.name.en}) expected 1 item for key ${key}, found ${matches.length}`);
      continue;
    }
    const actual = matches[0];
    const expectedCat = categoriesBySlug.get(srcItem.categorySlug);
    if (!expectedCat) {
      errors.push(`${srcItem.sourceFile}#${srcItem.id} category ${srcItem.categorySlug} not found after sync`);
      continue;
    }
    const expected = sourceItemFields(srcItem, expectedCat._id);
    // Compare fields (excluding image)
    const diff = fieldsThatDiffer(actual, expected, new Set(["name", "description"]));
    if (diff.length) {
      // Filter out category string vs ObjectId already handled via sameId, but diff may include category mismatched if id not yet resolved? Check.
      // We consider any diff as error except image fields (which we don't compare)
      errors.push(`${srcItem.sourceFile}#${srcItem.id} field mismatch: ${diff.join(", ")} (expected ${JSON.stringify(expected)} vs actual category=${actual.category})`);
      if (diff.includes("price")) priceErrors += 1;
      if (diff.includes("station") || diff.includes("targetStation") || diff.includes("categoryType")) stationErrors += 1;
    } else {
      matchedItems += 1;
    }

    // Verify Food items have correct station/type — both station and targetStation independently must be KITCHEN, plus categoryType FOOD
    if (String(actual.categoryType) !== "FOOD") { errors.push(`${srcItem.sourceFile}#${srcItem.id} categoryType=${actual.categoryType} expected FOOD`); stationErrors+=1; }
    if (String(actual.station) !== "KITCHEN") { errors.push(`${srcItem.sourceFile}#${srcItem.id} station=${actual.station} expected KITCHEN`); stationErrors+=1; }
    if (String(actual.targetStation) !== "KITCHEN") { errors.push(`${srcItem.sourceFile}#${srcItem.id} targetStation=${actual.targetStation} expected KITCHEN`); stationErrors+=1; }

    // Image preservation: if before had non-empty image, after must be same
    const before = beforeItemsById.get(String(actual._id));
    if (before) {
      const beforeImg = before.imageUrl || before.image || "";
      const afterImg = actual.imageUrl || actual.image || "";
      if (beforeImg && beforeImg !== afterImg) {
        errors.push(`${srcItem.sourceFile}#${srcItem.id} image was overwritten (before ${beforeImg} after ${afterImg})`);
      } else if (beforeImg) imagePreservedCheck += 1;
    }
  }

  // 3. Drink data not modified — snapshot+compare without writing (safe, no DB writes)
  // Count-based check is labeled as limited; snapshot compares selected fields only (not full record) — does not claim full protection
  // Reuse established classification (classifyCategory/classifyMenuItem) consistently with printDatabasePlan and sync scope
  const beforeDrinkItems = beforeCounts.drinkItems || 0;
  const afterDrinkItems = allItems.filter((i) => classifyMenuItem(i, categoriesById) === "DRINK").length;
  if (beforeDrinkItems !== afterDrinkItems) {
    errors.push(`Drink items count changed from ${beforeDrinkItems} to ${afterDrinkItems} (count-based, limited)`);
  }

  const beforeDrinkCats = beforeCounts.drinkCats || 0;
  const afterDrinkCats = allCategories.filter((c) => classifyCategory(c) === "DRINK").length;
  if (beforeDrinkCats !== afterDrinkCats) {
    errors.push(`Drink categories count changed from ${beforeDrinkCats} to ${afterDrinkCats} (count-based, limited)`);
  }

  // Snapshot comparison for Drink records (if snapshots provided) — no writes, read-only verification
  // NOTE: This compares only selected fields (categoryType/station/targetStation/price/name and type/targetStation/slug/name);
  //       it does not verify all Drink fields, so full protection is not claimed — see findings.
  const beforeDrinkItemsById = beforeCounts.drinkItemsById || null;
  const beforeDrinkCatsById = beforeCounts.drinkCatsById || null;
  if (beforeDrinkItemsById) {
    const afterDrinkItemsById = new Map(allItems.filter((i) => classifyMenuItem(i, categoriesById) === "DRINK").map((i) => [String(i._id), i]));
    // Check that every before Drink item still exists after with identical protected fields (no modifications)
    for (const [id, beforeItem] of beforeDrinkItemsById) {
      const afterItem = afterDrinkItemsById.get(id);
      if (!afterItem) {
        errors.push(`Drink item ${id} missing after Food sync (deleted or ID changed)`);
        continue;
      }
      // Compare critical fields without writing — if any Food sync touched a Drink record, this will catch it
      const beforeStr = JSON.stringify({ categoryType: beforeItem.categoryType, station: beforeItem.station, targetStation: beforeItem.targetStation, price: beforeItem.price, name: beforeItem.name });
      const afterStr = JSON.stringify({ categoryType: afterItem.categoryType, station: afterItem.station, targetStation: afterItem.targetStation, price: afterItem.price, name: afterItem.name });
      if (beforeStr !== afterStr) {
        errors.push(`Drink item ${id} was modified during Food sync (before ${beforeStr} vs after ${afterStr})`);
      }
    }
    for (const [id] of afterDrinkItemsById) {
      if (!beforeDrinkItemsById.has(id)) {
        errors.push(`New Drink item ${id} appeared after Food sync — Food sync should not create Drink records`);
      }
    }
  } else {
    console.warn("  WARN Drink verification is count-based and limited — no snapshot to compare full Drink records");
  }
  if (beforeDrinkCatsById) {
    const afterDrinkCatsById = new Map(allCategories.filter((c) => classifyCategory(c) === "DRINK").map((c) => [String(c._id), c]));
    for (const [id, beforeCat] of beforeDrinkCatsById) {
      const afterCat = afterDrinkCatsById.get(id);
      if (!afterCat) {
        errors.push(`Drink category ${id} missing after Food sync`);
        continue;
      }
      const beforeStr = JSON.stringify({ type: beforeCat.type, targetStation: beforeCat.targetStation, slug: beforeCat.slug, name: beforeCat.name });
      const afterStr = JSON.stringify({ type: afterCat.type, targetStation: afterCat.targetStation, slug: afterCat.slug, name: afterCat.name });
      if (beforeStr !== afterStr) {
        errors.push(`Drink category ${id} was modified during Food sync (before ${beforeStr} vs after ${afterStr})`);
      }
    }
    for (const [id] of afterDrinkCatsById) {
      if (!beforeDrinkCatsById.has(id)) {
        errors.push(`New Drink category ${id} appeared after Food sync`);
      }
    }
  } else {
    console.warn("  WARN Drink category verification is count-based and limited — no snapshot to compare");
  }

  // 4. Unrelated collections unchanged
  if (afterOrders !== beforeCounts.orders) errors.push(`orders count changed from ${beforeCounts.orders} to ${afterOrders}`);
  if (afterStaffs !== beforeCounts.staffs) errors.push(`staffs count changed from ${beforeCounts.staffs} to ${afterStaffs}`);
  if (afterSystemAuth !== beforeCounts.systemAuth) errors.push(`system_auth count changed from ${beforeCounts.systemAuth} to ${afterSystemAuth}`);

  console.log(`  categories total: ${allCategories.length}; source Food categories verified: ${catalog.categories.length}`);
  console.log(`  menuitems total: ${allItems.length}; source Food items verified: ${matchedItems}/${catalog.records.length}`);
  console.log(`  duplicate Food keys: ${duplicateFoodKeys}`);
  console.log(`  Food items with correct station/KITCHEN: ${stationErrors === 0 ? "all" : `${stationErrors} errors`}`);
  console.log(`  prices matched: ${priceErrors === 0 ? "all" : `${priceErrors} errors`}`);
  console.log(`  images preserved (checked ${imagePreservedCheck} existing images): ${errors.some(e=>e.includes("image was overwritten")) ? "FAIL" : "PASS"}`);
  console.log(`  Drink items: before ${beforeDrinkItems} -> after ${afterDrinkItems} ${beforeDrinkItems===afterDrinkItems?"(unchanged, count-based, limited)":"CHANGED"}`);
  console.log(`  Drink categories: before ${beforeDrinkCats} -> after ${afterDrinkCats} ${beforeDrinkCats===afterDrinkCats?"(unchanged, count-based, limited)":"CHANGED"}`);
  console.log(`  orders: before ${beforeCounts.orders} -> after ${afterOrders} ${beforeCounts.orders===afterOrders?"(unchanged)":"CHANGED"}`);
  console.log(`  staffs: before ${beforeCounts.staffs} -> after ${afterStaffs} ${beforeCounts.staffs===afterStaffs?"(unchanged)":"CHANGED"}`);
  console.log(`  system_auth: before ${beforeCounts.systemAuth} -> after ${afterSystemAuth} ${beforeCounts.systemAuth===afterSystemAuth?"(unchanged)":"CHANGED"}`);
  console.log(`  status: ${errors.length === 0 ? "PASS" : "FAIL"}`);
  for (const e of errors) console.log(`    ERROR ${e}`);

  if (errors.length) throw new Error(`post-apply verification failed with ${errors.length} error(s)`);

  console.log("\n[verify] All Food categories and items match food_menu.json; no duplicates; Food station/type correct; images preserved; Drink/Orders/Staff/Auth counts checked (Drink: snapshot of selected fields only — categoryType/station/targetStation/price/name and type/targetStation/slug/name — limited, not full record; otherwise count-based limited); Food sync did not modify unrelated records per scope, but not claimed fully production-safe without transaction.");
}

async function main() {
  if (HELP) {
    console.log(`Food Menu JSON → MongoDB Sync`);
    console.log(`Usage: node --env-file=.env.local scripts/sync-food-menu-json.mjs [--apply]`);
    console.log(`  default (no flag) : DRY RUN — validates and reports, no writes`);
    console.log(`  --apply           : APPLY — creates/updates Food categories and MenuItems`);
    console.log(`  --help            : show this help`);
    return 0;
  }

  console.log("==================================================");
  console.log(" Food Menu JSON → MongoDB Sync");
  console.log("==================================================");
  console.log(` Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}`);
  console.log(` Source: ${SOURCE_PATH}`);
  console.log(` Time: ${new Date().toISOString()}`);

  const catalog = loadSourceCatalog();
  printSourceSummary(catalog);

  if (catalog.errors.length) {
    console.log("\n[abort] Source validation failed — no database connection attempted.");
    console.log(`[abort] Fix food_menu.json and re-run.`);
    return 2;
  }

  if (!process.env.MONGODB_URI) {
    console.error("\nMONGODB_URI is not set — run with: node --env-file=.env.local scripts/sync-food-menu-json.mjs");
    return 1;
  }

  let conn;
  try {
    conn = await mongoose.createConnection(process.env.MONGODB_URI, {
      autoCreate: false,
      autoIndex: false,
      bufferCommands: false,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 30000,
    }).asPromise();

    if (conn.name !== "hotel_management") {
      console.error(`\nABORT: connected database is ${conn.name}, expected hotel_management`);
      return 2;
    }
    const host = (process.env.MONGODB_URI.match(/@([^\/\?]+)/) || [])[1] || "unknown";
    console.log(`\n[database] Connected to ${host} (credentials redacted) db=${conn.name}`);

    const snapshot = await readDatabase(conn);
    // Capture additional before counts and snapshots for verification (read-only, no writes)
    // Reuse established classification for exact Drink counts — consistent with printDatabasePlan and sync scope, not broadened
    const categoriesByIdForDrinkSnapshot = new Map(snapshot.categories.map((c) => [String(c._id), c]));
    const isDrinkItem = (i) => classifyMenuItem(i, categoriesByIdForDrinkSnapshot) === "DRINK";
    const isDrinkCat = (c) => classifyCategory(c) === "DRINK";
    const drinkItems = snapshot.items.filter(isDrinkItem).length;
    const drinkCats = snapshot.categories.filter(isDrinkCat).length;
    const beforeItemsById = new Map(snapshot.items.map((i) => [String(i._id), i]));
    const drinkItemsById = new Map(snapshot.items.filter(isDrinkItem).map((i) => [String(i._id), i]));
    const drinkCatsById = new Map(snapshot.categories.filter(isDrinkCat).map((c) => [String(c._id), c]));

    const beforeCounts = {
      orders: snapshot.orders,
      staffs: snapshot.staffs,
      systemAuth: snapshot.systemAuth,
      drinkItems,
      drinkCats,
      beforeItemsById,
      drinkItemsById,
      drinkCatsById,
    };

    const plan = buildPlan(catalog, snapshot.categories, snapshot.items);
    printDatabasePlan(plan, snapshot.categories, snapshot.items, snapshot);

    if (plan.errors.length || plan.unresolvedMappings.length) {
      console.log("\n[abort] Plan has errors — no writes performed.");
      return 2;
    }

    if (!APPLY) {
      console.log("\n[done] Dry run complete — re-run with --apply to synchronize.");
      // Second dry-run idempotency hint: if we re-run after apply, created should be 0.
      // Provide idempotency check preview.
      const catActions = actionCounts(plan.categoryPlans);
      const itemActions = actionCounts(plan.itemPlans);
      if ((catActions.CREATE || 0) === 0 && (itemActions.CREATE || 0) === 0 && (itemActions.UPDATE || 0) === 0) {
        console.log("[done] Database is already synchronized with food_menu.json (no changes would be made).");
      } else {
        console.log(`[done] Would create ${catActions.CREATE||0} categories, ${itemActions.CREATE||0} items; would update ${itemActions.UPDATE||0} items.`);
      }
      return 0;
    }

    // APPLY mode
    const applyResult = await applyPlan(plan, snapshot.Category, snapshot.MenuItem);

    // Post-sync verification
    await verifyApplied(catalog, snapshot.Category, snapshot.MenuItem, beforeCounts, conn);

    console.log("\n[done] Apply complete. Verification PASS.");
    console.log(`[done] categories created ${applyResult.categoriesCreated}, updated ${applyResult.categoriesUpdated}; items created ${applyResult.itemsCreated}, updated ${applyResult.itemsUpdated}`);
    console.log("[done] Re-run dry-run to confirm idempotency: npm run db:sync:food");
    return 0;
  } catch (e) {
    console.error(`\n[error] ${e.message}`);
    if (e.stack) console.error(e.stack);
    return 1;
  } finally {
    await conn?.close().catch(() => {});
  }
}

const exitCode = await main().catch((error) => {
  console.error(`\nSync failed: ${error.message}`);
  if (error.stack) console.error(error.stack);
  return 1;
});
if (exitCode) process.exitCode = exitCode;
