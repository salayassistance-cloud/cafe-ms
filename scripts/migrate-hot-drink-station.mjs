#!/usr/bin/env node
// Optional catalog migration: retarget existing coffee / hot-beverage categories
// (and their menu items) from BARISTA to the JEBENA BUNA station (HOT_DRINK).
//
// Read-only by default. Only `--apply` writes. This script never touches the
// `orders` collection: historical order lines keep their immutable `type`
// snapshot, so past orders and reports are unaffected.
//
// Usage:
//   node --env-file=.env.local scripts/migrate-hot-drink-station.mjs
//   node --env-file=.env.local scripts/migrate-hot-drink-station.mjs --apply
//
// Matching is deliberately narrow: a category must currently resolve to
// BARISTA and its slug/name must look like a coffee or hot beverage. KITCHEN
// categories are never selected, and an already-HOT_DRINK category is skipped.

import mongoose from "mongoose";
import { getCategoryModel } from "../lib/models/Category.js";
import { getMenuItemModel } from "../lib/models/MenuItem.js";

const APPLY = process.argv.includes("--apply") && !process.argv.includes("--dry-run");

// Coffee / hot-beverage identity. Kept in one place so the preview and the
// write use exactly the same selection.
const HOT_BEVERAGE_RE =
  /coffee|buna|jebena|espresso|macchiato|latte|cappuccino|americano|mocha|tea|chai|hot.?chocolate|ቡና|ጀበና/i;

const SYSTEM_DBS = new Set(["admin", "local", "config"]);

function displayName(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.en || value.am || value.om || "";
  return "";
}

// Current station resolution for a category (explicit targetStation wins;
// otherwise legacy type drives the station, matching lib/menuService).
function categoryStation(cat) {
  const explicit = String(cat?.targetStation || "").toUpperCase();
  if (explicit === "HOT_DRINK" || explicit === "BARISTA" || explicit === "KITCHEN") return explicit;
  const type = String(cat?.type || "").toUpperCase();
  if (type === "HOT_DRINK") return "HOT_DRINK";
  if (type === "DRINK") return "BARISTA";
  return "KITCHEN";
}

function isHotBeverageCategory(cat) {
  const text = `${displayName(cat?.name)} ${cat?.slug || ""}`;
  return HOT_BEVERAGE_RE.test(text);
}

function selectCategories(categories) {
  return categories.filter(
    (cat) => categoryStation(cat) === "BARISTA" && isHotBeverageCategory(cat)
  );
}

function selectItems(items, categoryIds) {
  const ids = new Set(categoryIds.map((id) => String(id)));
  return items.filter((item) => {
    const catId = item?.category ?? item?.categoryId;
    if (!catId || !ids.has(String(catId))) return false;
    return String(item?.targetStation || item?.station || "").toUpperCase() !== "HOT_DRINK";
  });
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error(
      "MONGODB_URI is not set — run with: node --env-file=.env.local scripts/migrate-hot-drink-station.mjs"
    );
    return 1;
  }

  let conn;
  try {
    conn = await mongoose
      .createConnection(process.env.MONGODB_URI, {
        autoCreate: false,
        autoIndex: false,
        bufferCommands: false,
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 30000,
      })
      .asPromise();

    if (SYSTEM_DBS.has(conn.name)) {
      console.error(`ABORT: connected database is a system database (${conn.name}).`);
      return 2;
    }

    const Category = getCategoryModel(conn);
    const MenuItem = getMenuItemModel(conn);

    const [categories, items, orderCount] = await Promise.all([
      Category.find({}).lean(),
      MenuItem.find({}).lean(),
      conn.db.collection("orders").countDocuments(),
    ]);

    const selectedCategories = selectCategories(categories);
    const selectedItems = selectItems(
      items,
      selectedCategories.map((cat) => cat._id)
    );

    console.log(`Database: ${conn.name}`);
    console.log(`Orders (never modified): ${orderCount}`);
    console.log(`Coffee/hot-beverage BARISTA categories matched: ${selectedCategories.length}`);
    for (const cat of selectedCategories) {
      console.log(`  CATEGORY ${cat.slug || String(cat._id)} — ${displayName(cat.name)}`);
    }
    console.log(`Menu items to retarget: ${selectedItems.length}`);
    for (const item of selectedItems.slice(0, 25)) {
      console.log(`  ITEM ${displayName(item.name)} (${String(item._id)})`);
    }
    if (selectedItems.length > 25) {
      console.log(`  … ${selectedItems.length - 25} more item(s)`);
    }

    if (!APPLY) {
      console.log("\nDRY RUN: no MongoDB writes performed. Re-run with --apply to migrate.");
      return 0;
    }

    if (selectedCategories.length === 0) {
      console.log("\nNothing to migrate — catalog already targets HOT_DRINK (or has no coffee categories).");
      return 0;
    }

    const catIds = selectedCategories.map((cat) => cat._id);
    const catResult = await Category.updateMany(
      { _id: { $in: catIds } },
      { $set: { targetStation: "HOT_DRINK", type: "HOT_DRINK" } },
      { runValidators: false }
    );

    const itemResult = await MenuItem.updateMany(
      {
        $and: [
          { $or: [{ category: { $in: catIds } }, { categoryId: { $in: catIds } }] },
          {
            $or: [
              { targetStation: { $ne: "HOT_DRINK" } },
              { station: { $ne: "HOT_DRINK" } },
            ],
          },
        ],
      },
      {
        $set: {
          targetStation: "HOT_DRINK",
          station: "HOT_DRINK",
          categoryType: "HOT_DRINK",
        },
      },
      { runValidators: false }
    );

    console.log(
      `\nApplied: ${catResult.modifiedCount} category(ies), ${itemResult.modifiedCount} menu item(s) retargeted to HOT_DRINK.`
    );
    console.log("Orders were not modified — historical snapshots are unchanged.");
    return 0;
  } finally {
    await conn?.close().catch(() => {});
  }
}

const exitCode = await main().catch((error) => {
  console.error(`\nMigration failed: ${error.message}`);
  return 1;
});
if (exitCode) process.exitCode = exitCode;
