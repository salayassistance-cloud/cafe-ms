#!/usr/bin/env node
/**
 * Update the checked-in menu catalog descriptions in the canonical MenuItem
 * collection. Categories and all non-description item fields are read-only.
 *
 * Usage:
 *   node --env-file=.env.local scripts/seed-menu-json.mjs
 *   node --env-file=.env.local scripts/seed-menu-json.mjs --apply
 *
 * The default mode is read-only. The source files do not contain a persisted
 * MenuItem identifier, and their numeric ids are scoped separately by file,
 * so item matching uses the existing category slug + English name fields.
 * No source id is added to the schema.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { getCategoryModel } from "../lib/models/Category.js";
import { getMenuItemModel } from "../lib/models/MenuItem.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FILES = [
  { file: "drink_menu.json", mainCategory: "Drink", type: "DRINK", station: "BARISTA" },
  { file: "food_menu.json", mainCategory: "Food", type: "FOOD", station: "KITCHEN" },
];
const LOCALES = ["en", "am", "om"];
const REQUIRED_ITEM_FIELDS = [
  "id",
  "mainCategory",
  "category",
  "name",
  "description",
  "price",
  "isAvailable",
  "isFasting",
  "isSpecial",
];
const DRY_RUN_ENV = ["1", "true", "yes"].includes(
  String(process.env.DRY_RUN || "").toLowerCase()
);
const APPLY = process.argv.includes("--apply") && !process.argv.includes("--dry-run") && !DRY_RUN_ENV;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

function identityText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function menuItemKey(categorySlug, englishName) {
  return `${categorySlug}::${identityText(englishName)}`;
}

function sourceName(value) {
  return { en: value.en, am: value.am, om: value.om };
}

function englishName(value) {
  if (typeof value === "string") return value;
  if (isRecord(value)) return value.en || value.am || value.om || "";
  return "";
}

function sameLocalizedName(actual, expected) {
  return isRecord(actual) && LOCALES.every((locale) => actual[locale] === expected[locale]);
}

function sameId(actual, expected) {
  if (actual == null || expected == null) return actual == null && expected == null;
  return String(actual) === String(expected);
}

function fieldsThatDiffer(existing, expected, localizedFields = new Set()) {
  return Object.keys(expected).filter((field) => {
    if (localizedFields.has(field)) return !sameLocalizedName(existing[field], expected[field]);
    if (field === "category" || field === "categoryId") return !sameId(existing[field], expected[field]);
    return existing[field] !== expected[field];
  });
}

function validateLocalized(value, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object with en/am/om values`);
    return false;
  }
  for (const locale of LOCALES) {
    if (typeof value[locale] !== "string" || !value[locale].trim()) {
      errors.push(`${label}.${locale} must be a non-empty string`);
    }
  }
  const unexpected = Object.keys(value).filter((key) => !LOCALES.includes(key));
  if (unexpected.length) errors.push(`${label} has unexpected locale(s): ${unexpected.join(", ")}`);
  return true;
}

function loadSourceCatalog() {
  const errors = [];
  const records = [];
  const categories = new Map();
  const itemKeys = new Map();
  const fileSummaries = [];

  for (const source of SOURCE_FILES) {
    const filePath = path.join(ROOT, source.file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      errors.push(`${source.file}: invalid JSON: ${error.message}`);
      continue;
    }
    if (!Array.isArray(data)) {
      errors.push(`${source.file}: root value must be an array`);
      continue;
    }

    const ids = new Set();
    const fileCategories = new Set();
    let validRecords = 0;

    data.forEach((item, index) => {
      const label = `${source.file}[${index}]`;
      if (!isRecord(item)) {
        errors.push(`${label}: record must be an object`);
        return;
      }

      const unexpectedFields = Object.keys(item).filter((key) => !REQUIRED_ITEM_FIELDS.includes(key));
      if (unexpectedFields.length) errors.push(`${label}: unexpected field(s): ${unexpectedFields.join(", ")}`);
      for (const field of REQUIRED_ITEM_FIELDS) {
        if (!(field in item)) errors.push(`${label}: missing ${field}`);
      }

      if (!Number.isInteger(item.id) || item.id < 1) errors.push(`${label}.id must be a positive integer`);
      if (ids.has(item.id)) errors.push(`${source.file}: duplicate source id ${item.id}`);
      ids.add(item.id);
      if (item.mainCategory !== source.mainCategory) {
        errors.push(`${label}.mainCategory must be ${source.mainCategory}`);
      }
      validateLocalized(item.category, `${label}.category`, errors);
      validateLocalized(item.name, `${label}.name`, errors);
      validateLocalized(item.description, `${label}.description`, errors);
      if (typeof item.price !== "number" || !Number.isFinite(item.price) || item.price < 0) {
        errors.push(`${label}.price must be a non-negative number`);
      }
      for (const field of ["isAvailable", "isFasting", "isSpecial"]) {
        if (typeof item[field] !== "boolean") errors.push(`${label}.${field} must be boolean`);
      }

      if (
        !isRecord(item.category) ||
        !LOCALES.every((locale) => typeof item.category[locale] === "string" && item.category[locale].trim()) ||
        !isRecord(item.name) ||
        !LOCALES.every((locale) => typeof item.name[locale] === "string" && item.name[locale].trim()) ||
        !isRecord(item.description) ||
        !LOCALES.every((locale) => typeof item.description[locale] === "string" && item.description[locale].trim())
      ) {
        return;
      }

      validRecords += 1;
      const categoryName = sourceName(item.category);
      const categorySlug = slugify(categoryName.en);
      const existingCategory = categories.get(categorySlug);
      if (existingCategory) {
        if (
          existingCategory.type !== source.type ||
          JSON.stringify(existingCategory.name) !== JSON.stringify(categoryName)
        ) {
          errors.push(`${label}: category slug ${categorySlug} maps to conflicting type or translations`);
        }
        existingCategory.recordCount += 1;
        existingCategory.sourceIds.push(`${source.file}#${item.id}`);
      } else {
        categories.set(categorySlug, {
          slug: categorySlug,
          name: categoryName,
          type: source.type,
          station: source.station,
          recordCount: 1,
          sourceIds: [`${source.file}#${item.id}`],
        });
      }
      fileCategories.add(categorySlug);

      const key = menuItemKey(categorySlug, item.name.en);
      if (itemKeys.has(key)) {
        errors.push(`${label}: duplicate menu natural key ${key} (also ${itemKeys.get(key)})`);
      } else {
        itemKeys.set(key, `${source.file}#${item.id}`);
      }
      records.push({ ...item, sourceFile: source.file, type: source.type, station: source.station, categorySlug });
    });

    fileSummaries.push({ file: source.file, type: source.type, records: data.length, validRecords, uniqueSourceIds: ids.size, uniqueCategories: fileCategories.size });
  }

  const sortedCategories = [...categories.values()].sort(
    (a, b) => a.name.en.localeCompare(b.name.en, undefined, { sensitivity: "base" }) || a.slug.localeCompare(b.slug)
  );
  const slugOwners = new Map();
  for (const category of sortedCategories) {
    category.order = sortedCategories.indexOf(category) + 1;
    const owner = slugOwners.get(category.slug);
    if (owner && owner !== category.name.en) {
      errors.push(`category slug collision: ${category.slug} (${owner} and ${category.name.en})`);
    }
    slugOwners.set(category.slug, category.name.en);
  }

  return { errors, records, categories: sortedCategories, itemKeys, fileSummaries };
}

function sourceItemFields(item, categoryId) {
  return {
    name: sourceName(item.name),
    description: sourceName(item.description),
    price: item.price,
    category: categoryId,
    categoryId,
    categoryType: item.type,
    station: item.station,
    targetStation: item.station,
    isSpecial: item.isSpecial,
    isAvailable: item.isAvailable,
    inStock: item.isAvailable,
    isFasting: item.isFasting,
    // The source exposes isFasting only; this is the existing complementary alias.
    isNonFasting: !item.isFasting,
  };
}

function existingCategoryBySlug(existingCategories, errors) {
  const bySlug = new Map();
  for (const category of existingCategories) {
    if (!category.slug) continue;
    const slug = String(category.slug);
    const prior = bySlug.get(slug);
    if (prior) {
      errors.push(`database has duplicate Category slug ${slug}: ${prior._id} and ${category._id}`);
    } else {
      bySlug.set(slug, category);
    }
  }
  return bySlug;
}

function categorySlugForItem(item, categoriesById) {
  const reference = item.category || item.categoryId;
  if (reference == null) return "";
  const category = categoriesById.get(String(reference));
  if (category?.slug) return String(category.slug);
  return typeof reference === "string" && reference.length < 100 ? slugify(reference) : "";
}

function existingItemsByKey(existingItems, existingCategories, errors) {
  const categoriesById = new Map(existingCategories.map((category) => [String(category._id), category]));
  const byKey = new Map();
  let duplicateCount = 0;
  for (const item of existingItems) {
    const categorySlug = categorySlugForItem(item, categoriesById);
    const name = englishName(item.name);
    if (!categorySlug || !name.trim()) continue;
    const key = menuItemKey(categorySlug, name);
    const prior = byKey.get(key);
    if (prior) {
      errors.push(`database has duplicate MenuItem natural key ${key}: ${prior._id} and ${item._id}`);
      duplicateCount += 1;
    } else {
      byKey.set(key, item);
    }
  }
  return { byKey, categoriesById, duplicateCount };
}

function buildPlan(catalog, existingCategories, existingItems) {
  const errors = [...catalog.errors];
  const unresolvedMappings = [];
  const categoriesBySlug = existingCategoryBySlug(existingCategories, errors);
  const { byKey: itemsByKey, duplicateCount } = existingItemsByKey(existingItems, existingCategories, errors);

  if (existingItems.length !== catalog.records.length) {
    errors.push(`database has ${existingItems.length} menuitems; expected the existing ${catalog.records.length} source items`);
  }

  const categoryPlans = catalog.categories.map((sourceCategory) => {
    const existing = categoriesBySlug.get(sourceCategory.slug) || null;
    if (!existing) {
      unresolvedMappings.push(`${sourceCategory.slug}: category is missing from the existing database`);
    } else {
      const expected = {
        name: sourceCategory.name,
        slug: sourceCategory.slug,
        type: sourceCategory.type,
        targetStation: sourceCategory.station,
      };
      const differences = fieldsThatDiffer(existing, expected, new Set(["name"]));
      if (differences.length) {
        errors.push(`${sourceCategory.slug}: category differs in ${differences.join(", ")}; refusing to modify Category data`);
      }
    }

    const fields = {
      name: sourceCategory.name,
      slug: sourceCategory.slug,
      type: sourceCategory.type,
      targetStation: sourceCategory.station,
    };
    return {
      ...sourceCategory,
      existing,
      fields,
      action: existing ? "UNCHANGED" : "ERROR",
      categoryId: existing?._id || null,
    };
  });
  const categoryPlansBySlug = new Map(categoryPlans.map((plan) => [plan.slug, plan]));

  const itemPlans = catalog.records.map((item) => {
    const categoryPlan = categoryPlansBySlug.get(item.categorySlug);
    if (!categoryPlan) {
      unresolvedMappings.push(`${item.sourceFile}#${item.id}: category ${item.categorySlug} is unresolved`);
      return { item, categoryPlan: null, existing: null, action: "ERROR" };
    }
    if (categoryPlan.type !== item.type || categoryPlan.station !== item.station) {
      unresolvedMappings.push(`${item.sourceFile}#${item.id}: ${item.type}/${item.station} does not match category ${item.categorySlug}`);
    }
    const existing = itemsByKey.get(menuItemKey(item.categorySlug, item.name.en)) || null;
    const fields = sourceItemFields(item, categoryPlan.categoryId);
    if (!existing) {
      errors.push(`${item.sourceFile}#${item.id}: existing MenuItem is missing; refusing to insert or replace catalog data`);
      return { item, categoryPlan, existing: null, fields, action: "ERROR" };
    }
    const protectedFields = { ...fields };
    delete protectedFields.description;
    const protectedDifferences = fieldsThatDiffer(existing, protectedFields, new Set(["name"]));
    if (protectedDifferences.length) {
      errors.push(`${item.sourceFile}#${item.id}: refusing to change protected MenuItem field(s): ${protectedDifferences.join(", ")}`);
    }
    const descriptionDiffers = fieldsThatDiffer(existing, { description: fields.description }, new Set(["description"])).length > 0;
    const descriptionAction = descriptionDiffers
      ? (isRecord(existing.description) && LOCALES.some((locale) => String(existing.description[locale] || "").trim()) ? "UPDATED" : "ADDED")
      : "UNCHANGED";
    return { item, categoryPlan, existing, fields, action: protectedDifferences.length ? "ERROR" : descriptionAction };
  });

  return { errors, unresolvedMappings, categoryPlans, itemPlans, duplicateCount };
}

function actionCounts(plans) {
  return plans.reduce((counts, plan) => {
    counts[plan.action] = (counts[plan.action] || 0) + 1;
    return counts;
  }, {});
}

function printSourceSummary(catalog) {
  const byType = new Map();
  for (const item of catalog.records) {
    const summary = byType.get(item.type) || { records: 0, priceTotal: 0, minPrice: Infinity, maxPrice: -Infinity, available: 0, fasting: 0, special: 0, descriptions: 0 };
    summary.records += 1;
    summary.priceTotal += item.price;
    summary.minPrice = Math.min(summary.minPrice, item.price);
    summary.maxPrice = Math.max(summary.maxPrice, item.price);
    summary.available += item.isAvailable ? 1 : 0;
    summary.fasting += item.isFasting ? 1 : 0;
    summary.special += item.isSpecial ? 1 : 0;
    summary.descriptions += 1;
    byType.set(item.type, summary);
  }

  console.log("\n[source] Catalog validation");
  for (const summary of catalog.fileSummaries) {
    console.log(`  ${summary.file}: ${summary.records} records, ${summary.uniqueCategories} categories, ${summary.uniqueSourceIds} unique source ids`);
  }
  console.log(`  total records: ${catalog.records.length}`);
  console.log(`  total categories: ${catalog.categories.length}`);
  for (const type of ["DRINK", "FOOD"]) {
    const summary = byType.get(type);
    if (!summary) continue;
    console.log(`  ${type}: ${summary.records} items, prices ${summary.minPrice}-${summary.maxPrice} ETB, price total ${summary.priceTotal} ETB, available ${summary.available}, fasting ${summary.fasting}, special ${summary.special}, descriptions ${summary.descriptions}`);
  }
  console.log("  source IDs are file-scoped and are not persisted");
  console.log("  duplicate source IDs: none");
  console.log("  duplicate source natural keys: none");
  console.log("  conflicting category translations/types: none");
  console.log(`  validation errors: ${catalog.errors.length}`);
  for (const error of catalog.errors) console.log(`    ERROR ${error}`);
  console.log("\n[source] Categories");
  for (const category of catalog.categories) {
    console.log(`  ${category.type}/${category.station} ${category.slug}: ${category.recordCount} items (${category.name.en})`);
  }
}

function printDatabasePlan(plan, existingCategories, existingItems, orderCount) {
  const itemActions = actionCounts(plan.itemPlans);
  console.log("\n[database] Read-only snapshot");
  console.log(`  database: hotel_management`);
  console.log(`  existing categories: ${existingCategories.length}`);
  console.log(`  existing menuitems: ${existingItems.length}`);
  console.log(`  existing orders: ${orderCount} (import does not touch orders)`);
  console.log("\n[plan] Categories");
  console.log(`  unchanged: ${plan.categoryPlans.filter((category) => category.action === "UNCHANGED").length}`);
  for (const category of plan.categoryPlans) {
    console.log(`  ${category.action.padEnd(9)} ${category.type}/${category.station} ${category.slug} (${category.recordCount} items)`);
  }
  console.log("\n[plan] MenuItems");
  console.log(`  total: ${existingItems.length}`);
  console.log(`  descriptions added: ${itemActions.ADDED || 0}`);
  console.log(`  descriptions updated: ${itemActions.UPDATED || 0}`);
  console.log(`  descriptions unchanged: ${itemActions.UNCHANGED || 0}`);
  console.log(`  errors: ${itemActions.ERROR || 0}`);
  console.log(`  duplicates: ${plan.duplicateCount}`);
  console.log(`  unresolved category/type/station mappings: ${plan.unresolvedMappings.length}`);
  for (const mapping of plan.unresolvedMappings) console.log(`    MAPPING ${mapping}`);
  console.log(`  plan validation errors: ${plan.errors.length}`);
  for (const error of plan.errors) console.log(`    ERROR ${error}`);
  console.log(`\n[plan] Status: ${plan.errors.length === 0 && plan.unresolvedMappings.length === 0 ? "CLEAN" : "ABORT"}`);
  if (!APPLY) console.log("[plan] DRY RUN: no MongoDB writes performed.");
}

async function readDatabase(conn) {
  const Category = getCategoryModel(conn);
  const MenuItem = getMenuItemModel(conn);
  const [categories, items, orders] = await Promise.all([
    Category.find({}).lean(),
    MenuItem.find({}).lean(),
    conn.db.collection("orders").countDocuments(),
  ]);
  return { Category, MenuItem, categories, items, orders };
}

function categoryFieldsMatch(actual, expected) {
  return fieldsThatDiffer(actual, expected, new Set(["name"])).length === 0;
}

function itemFieldsMatch(actual, expected) {
  return fieldsThatDiffer(actual, expected, new Set(["name", "description"])).length === 0;
}

async function applyPlan(plan, MenuItem) {
  let descriptionAdded = 0;
  let descriptionUpdated = 0;
  for (const itemPlan of plan.itemPlans) {
    if (!itemPlan.categoryPlan) continue;
    if (itemPlan.action === "UNCHANGED") continue;
    if (!itemPlan.existing || !["ADDED", "UPDATED"].includes(itemPlan.action)) {
      throw new Error(`Refusing to write invalid description plan for ${itemPlan.item.sourceFile}#${itemPlan.item.id}`);
    }
    const result = await MenuItem.updateOne(
      { _id: itemPlan.existing._id },
      { $set: { description: itemPlan.fields.description } },
      { runValidators: true }
    );
    if (!result.matchedCount) throw new Error(`MenuItem ${itemPlan.existing._id} was not found during description update`);
    if (itemPlan.action === "ADDED") descriptionAdded += result.modifiedCount ? 1 : 0;
    if (itemPlan.action === "UPDATED") descriptionUpdated += result.modifiedCount ? 1 : 0;
  }

  console.log(`\n[apply] categories unchanged ${plan.categoryPlans.filter((category) => category.action === "UNCHANGED").length}`);
  console.log(`[apply] descriptions added ${descriptionAdded}, updated ${descriptionUpdated}`);
}

async function verifyApplied(catalog, Category, MenuItem, beforeOrders) {
  const [allCategories, allItems, orderCount] = await Promise.all([
    Category.find({}).lean(),
    MenuItem.find({}).lean(),
    Category.db.db.collection("orders").countDocuments(),
  ]);
  const categoriesBySlug = new Map(allCategories.filter((category) => category.slug).map((category) => [String(category.slug), category]));
  const itemsByKey = new Map();
  const categoriesById = new Map(allCategories.map((category) => [String(category._id), category]));
  for (const item of allItems) {
    const categorySlug = categorySlugForItem(item, categoriesById);
    const name = englishName(item.name);
    if (!categorySlug || !name.trim()) continue;
    const key = menuItemKey(categorySlug, name);
    const list = itemsByKey.get(key) || [];
    list.push(item);
    itemsByKey.set(key, list);
  }

  const errors = [];
  for (const sourceCategory of catalog.categories) {
    const actual = categoriesBySlug.get(sourceCategory.slug);
    if (!actual) {
      errors.push(`missing category ${sourceCategory.slug}`);
      continue;
    }
    const expected = {
      name: sourceCategory.name,
      slug: sourceCategory.slug,
      type: sourceCategory.type,
      targetStation: sourceCategory.station,
    };
    if (!categoryFieldsMatch(actual, expected)) {
      errors.push(`category ${sourceCategory.slug} does not match source fields`);
    }
  }

  let matchedItems = 0;
  for (const sourceItem of catalog.records) {
    const key = menuItemKey(sourceItem.categorySlug, sourceItem.name.en);
    const matches = itemsByKey.get(key) || [];
    if (matches.length !== 1) {
      errors.push(`${sourceItem.sourceFile}#${sourceItem.id} expected one item for ${key}, found ${matches.length}`);
      continue;
    }
    const category = categoriesBySlug.get(sourceItem.categorySlug);
    const expected = sourceItemFields(sourceItem, category?._id);
    if (!category || !itemFieldsMatch(matches[0], expected)) {
      errors.push(`${sourceItem.sourceFile}#${sourceItem.id} does not match canonical DB fields`);
      continue;
    }
    matchedItems += 1;
  }

  if (orderCount !== beforeOrders) errors.push(`orders count changed from ${beforeOrders} to ${orderCount}`);
  console.log("\n[verify] Direct database validation");
  console.log(`  categories total: ${allCategories.length}; source categories verified: ${catalog.categories.length}`);
  console.log(`  menuitems total: ${allItems.length}; source items verified: ${matchedItems}/${catalog.records.length}`);
  console.log(`  orders total: ${orderCount} (before ${beforeOrders})`);
  console.log(`  status: ${errors.length === 0 ? "PASS" : "FAIL"}`);
  for (const error of errors) console.log(`    ERROR ${error}`);
  if (errors.length) throw new Error(`post-apply verification failed with ${errors.length} error(s)`);
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node --env-file=.env.local scripts/seed-menu-json.mjs [--apply]");
    return 0;
  }

  const catalog = loadSourceCatalog();
  printSourceSummary(catalog);
  if (!process.env.MONGODB_URI) {
    console.error("\nMONGODB_URI is not set — run with: node --env-file=.env.local scripts/seed-menu-json.mjs");
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
    const snapshot = await readDatabase(conn);
    const plan = buildPlan(catalog, snapshot.categories, snapshot.items);
    printDatabasePlan(plan, snapshot.categories, snapshot.items, snapshot.orders);
    if (plan.errors.length || plan.unresolvedMappings.length) return 2;
    if (!APPLY) return 0;

    await applyPlan(plan, snapshot.MenuItem);
    await verifyApplied(catalog, snapshot.Category, snapshot.MenuItem, snapshot.orders);
    return 0;
  } finally {
    await conn?.close().catch(() => {});
  }
}

const exitCode = await main().catch((error) => {
  console.error(`\nSeed failed: ${error.message}`);
  return 1;
});
if (exitCode) process.exitCode = exitCode;
