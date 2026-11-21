#!/usr/bin/env node
/**
 * Phase 3 — Database Normalization & Canonical Migration
 * -----------------------------------------------------
 * Idempotent, safe, observable, verifiable migration for hotel_management.
 *
 * CANONICAL FIELDS (write target):
 *   MenuItem: category (ObjectId), targetStation (KITCHEN/BARISTA), imageUrl, isNew, isAvailable
 *   Category: name {am,en,om}, slug, targetStation, type (derived), order (canonical), isActive
 *   Order: isExternal default false, waiterInfo, station attribution etc. (already canonical)
 *
 * ALIASES (migrated to canonical, then verified before removal):
 *   MenuItem: categoryId→category, station→targetStation, image→imageUrl,
 *             isItemNew/isPopular→isNew, inStock→isAvailable
 *   Category: displayOrder→order, type↔targetStation sync
 *
 * SAFETY:
 *   - Verifies DB is hotel_management on expected Atlas cluster before any write.
 *   - Default dry-run; requires --apply to mutate.
 *   - Never prints URI or secrets.
 *   - Repeatable / idempotent — safe to re-run.
 *   - Counts before/after, verifies refs, prints actionable report.
 *   - Index handling is ADDITIVE ONLY (createIndexes): existing indexes are
 *     never dropped, replaced, or synchronized destructively.
 *   - Production-classified targets require --allow-production plus a non-empty
 *     PHASE3_MIGRATION_APPROVAL reference, checked before any connection.
 *
 * Usage:
 *   node --env-file=.env.local scripts/migrate-phase3-canonical.js          # dry-run (no writes)
 *   node --env-file=.env.local scripts/migrate-phase3-canonical.js --apply  # live migration
 *   DRY_RUN=1 node --env-file=.env.local scripts/migrate-phase3-canonical.js # also dry-run
 *   PHASE3_MIGRATION_ENV=production PHASE3_MIGRATION_APPROVAL=<ticket> \
 *     node --env-file=.env.local scripts/migrate-phase3-canonical.js --apply --allow-production
 *   node scripts/migrate-phase3-canonical.js --help
 */

// ── 0. INVOCATION PARSING & FAIL-CLOSED PRODUCTION APPROVAL GATE ──
// Everything in this section runs before MONGODB_URI is read, before the
// database driver is loaded, and before any database connection is attempted.

const APPLY_FLAG = "--apply";
const ALLOW_PRODUCTION_FLAG = "--allow-production";
const HELP_FLAGS = Object.freeze(["--help", "-h"]);
const APPROVAL_ENV = "PHASE3_MIGRATION_APPROVAL";

// Environment markers used for classification. Fail closed: only an explicit,
// recognized non-production value avoids the production approval gate.
const ENV_MARKERS = Object.freeze([
  "PHASE3_MIGRATION_ENV",
  "BONO_OPERATION_ENV",
  "NODE_ENV",
  "APP_ENV",
  "DEPLOY_ENV",
  "ENVIRONMENT",
  "VERCEL_ENV",
  "CONTEXT",
]);
const PRODUCTION_VALUES = Object.freeze(["production", "prod", "live"]);
const NON_PRODUCTION_VALUES = Object.freeze([
  "development",
  "dev",
  "test",
  "testing",
  "staging",
  "stage",
  "preview",
  "local",
  "ci",
  "deploy-preview",
  "branch-deploy",
]);
const TRUTHY = Object.freeze(["1", "true", "yes", "on"]);

const USAGE_TEXT = `
Phase 3 canonical migration — arguments, modes, and production approval.

Usage:
  node --env-file=.env.local scripts/migrate-phase3-canonical.js            Dry run (no writes)
  node --env-file=.env.local scripts/migrate-phase3-canonical.js --apply    Apply migration (writes)
  node scripts/migrate-phase3-canonical.js --help

Arguments:
  --apply               Enable writes. DRY_RUN=1 still forces a dry run.
  --allow-production    Required, together with PHASE3_MIGRATION_APPROVAL, when
                        the target environment classifies as production.
  --help, -h            Show this help.

Environment classification:
  Checked markers: PHASE3_MIGRATION_ENV, BONO_OPERATION_ENV, NODE_ENV, APP_ENV,
  DEPLOY_ENV, ENVIRONMENT, VERCEL_ENV, CONTEXT.
  Production-like, unrecognized, missing, or ambiguous classification is
  treated as production. There is no way to skip the production gate.

Production approval (checked before any database connection):
  --allow-production + non-empty PHASE3_MIGRATION_APPROVAL ticket reference.

Index safety:
  Index maintenance is ADDITIVE ONLY (createIndexes). This script never drops,
  replaces, or destructively re-synchronizes existing indexes.
`.trim();

function normalizeEnvValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Classifies the target environment from well-known marker variables.
 * Fail-closed rules:
 *  - any production-like marker -> production
 *  - any unrecognized non-empty marker -> production (ambiguous)
 *  - no recognized non-production marker -> production (missing)
 */
function classifyMigrationEnvironment(env = process.env) {
  const observations = [];
  let productionMarker = false;
  let recognizedNonProduction = false;
  let unrecognizedMarker = false;

  for (const name of ENV_MARKERS) {
    const value = normalizeEnvValue(env?.[name]);
    if (!value) continue;
    observations.push(`${name}=${value}`);
    if (PRODUCTION_VALUES.includes(value)) productionMarker = true;
    else if (NON_PRODUCTION_VALUES.includes(value)) recognizedNonProduction = true;
    else unrecognizedMarker = true;
  }

  if (productionMarker) {
    return {
      posture: "production",
      production: true,
      ambiguous: false,
      reason: "a production environment marker is present",
      observations,
    };
  }
  if (unrecognizedMarker) {
    return {
      posture: "production",
      production: true,
      ambiguous: true,
      reason: "an environment marker is unrecognized",
      observations,
    };
  }
  if (!recognizedNonProduction) {
    return {
      posture: "production",
      production: true,
      ambiguous: true,
      reason: "no explicit non-production environment classification is present",
      observations,
    };
  }
  return {
    posture: "non-production",
    production: false,
    ambiguous: false,
    reason: "explicit non-production classification",
    observations,
  };
}

/**
 * Strict argument parser. Malformed, unknown, or duplicated flags fail closed.
 */
function parseArgs(argv = []) {
  const parsed = { ok: true, help: false, apply: false, allowProduction: false };
  const seen = new Set();
  const args = Array.isArray(argv) ? argv : [];
  const fail = (error) => ({ ...parsed, ok: false, error });

  for (const arg of args) {
    if (HELP_FLAGS.includes(arg)) {
      if (seen.has("help")) return fail("duplicate argument: --help");
      seen.add("help");
      parsed.help = true;
      continue;
    }
    if (arg === APPLY_FLAG) {
      if (seen.has(APPLY_FLAG)) return fail(`duplicate argument: ${APPLY_FLAG}`);
      seen.add(APPLY_FLAG);
      parsed.apply = true;
      continue;
    }
    if (arg === ALLOW_PRODUCTION_FLAG) {
      if (seen.has(ALLOW_PRODUCTION_FLAG)) return fail(`duplicate argument: ${ALLOW_PRODUCTION_FLAG}`);
      seen.add(ALLOW_PRODUCTION_FLAG);
      parsed.allowProduction = true;
      continue;
    }
    return fail(`unknown argument: ${arg}`);
  }

  return parsed;
}

const parsedArgs = parseArgs(process.argv.slice(2));
if (!parsedArgs.ok) {
  console.error(USAGE_TEXT);
  console.error(`REFUSED: ${parsedArgs.error}`);
  console.error("No database connection was attempted and no data was modified.");
  process.exit(2);
}
if (parsedArgs.help) {
  console.log(USAGE_TEXT);
  process.exit(0);
}

// Fail-closed production approval gate. Runs before MONGODB_URI is read.
const environment = classifyMigrationEnvironment(process.env);
if (environment.production) {
  const approvalRef = String(process.env[APPROVAL_ENV] ?? "").trim();
  const missing = [];
  if (!parsedArgs.allowProduction) missing.push(`${ALLOW_PRODUCTION_FLAG} flag is missing`);
  if (!approvalRef) missing.push(`${APPROVAL_ENV} ticket reference is missing or empty`);
  if (missing.length) {
    console.error(
      `[phase3] Environment: production-classified (${environment.reason}: ${environment.observations.join(", ") || "no markers set"}).`
    );
    console.error(`[phase3] REFUSED — production execution requires explicit approval: ${missing.join("; ")}.`);
    console.error("[phase3] Missing or ambiguous environment classification is treated as production. No override exists.");
    console.error("[phase3] No database connection was attempted and no data was modified.");
    process.exit(2);
  }
  console.log(`[phase3] Environment: production-classified (${environment.reason}).`);
  console.log(`[phase3] Production approval: ${ALLOW_PRODUCTION_FLAG} present, ${APPROVAL_ENV} reference supplied (value hidden).`);
} else {
  console.log(`[phase3] Environment: ${environment.posture} (${environment.reason}).`);
}

const APPLY = parsedArgs.apply;
const DRY = !APPLY || TRUTHY.includes(normalizeEnvValue(process.env.DRY_RUN));
const DO_WRITE = APPLY && !DRY;

if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI is not set — run with: node --env-file=.env.local scripts/migrate-phase3-canonical.js [--apply]");
  process.exit(1);
}

const MONGODB_URI = process.env.MONGODB_URI;

function redactHost(uri) {
  const m = uri.match(/@([^\/\?]+)/);
  return m ? m[1] : "unknown";
}
function dbNameFromUri(uri) {
  const m = uri.match(/\.net\/([^\?]+)/);
  if (m) return m[1].split("?")[0];
  const slash = uri.split("/").pop();
  return slash ? slash.split("?")[0] : "unknown";
}

const HOST = redactHost(MONGODB_URI);
const DB_NAME = dbNameFromUri(MONGODB_URI);

console.log(`\n[phase3] Target host (redacted): ${HOST}`);
console.log(`[phase3] Target database: ${DB_NAME}`);
console.log(`[phase3] Mode: ${DO_WRITE ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}`);

if (DB_NAME !== "hotel_management") {
  console.error(`[phase3] ABORT — database is "${DB_NAME}", expected "hotel_management". Refusing to migrate an unintended DB.`);
  process.exit(2);
}
if (!HOST.includes("9yut545.mongodb.net")) {
  console.warn(`[phase3] WARNING — host ${HOST} does not match expected cluster0.9yut545.mongodb.net — proceed only if intentional.`);
  if (DO_WRITE) {
    console.error("[phase3] ABORT — host mismatch in APPLY mode. Run dry-run first or confirm HOST.");
    process.exit(2);
  }
}

console.log(`[phase3] Backup safety: ensure an Atlas continuous backup snapshot or mongodump exists before --apply.`);
console.log(`[phase3]   Recommended: mongodump --uri="<redacted>" --db=hotel_management --out=./backup-YYYYMMDD`);
console.log(`[phase3]   Or: Atlas UI → Backup → Take snapshot of hotel_management (verify completion).`);
console.log(`[phase3]   This script never deletes documents; it only backfills canonical fields and creates missing indexes (additive only).\n`);

function slugify(s) {
  return String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "category";
}

// The driver is loaded only after argument parsing, environment classification,
// production approval, and the database/host checks have all passed.
const { default: mongoose } = await import("mongoose");

const conn = await mongoose.createConnection(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 30000,
}).asPromise();

console.log(`[phase3] Connected to ${conn.name} @ ${conn.host}`);

// Collections
const categoriesCol = conn.db.collection("categories");
const menuitemsCol = conn.db.collection("menuitems");
const ordersCol = conn.db.collection("orders");
const staffsCol = conn.db.collection("staffs");
const brandconfigsCol = conn.db.collection("brandconfigs");
const brandingsCol = conn.db.collection("brandings");
const paymentinfosCol = conn.db.collection("paymentinfos");
const usersCol = conn.db.collection("users");
const systemAuthCol = conn.db.collection("system_auth");
const countersCol = conn.db.collection("counters");

// Helper to count
async function counts() {
  const [cats, items, orders, staffs, brandconfigs, brandings, pays, users, sysAuth] = await Promise.all([
    categoriesCol.countDocuments(),
    menuitemsCol.countDocuments(),
    ordersCol.countDocuments(),
    staffsCol.countDocuments(),
    brandconfigsCol.countDocuments().catch(() => 0),
    brandingsCol.countDocuments().catch(() => 0),
    paymentinfosCol.countDocuments(),
    usersCol.countDocuments().catch(() => 0),
    systemAuthCol.countDocuments(),
  ]);
  return { cats, items, orders, staffs, brandconfigs, brandings, pays, users, sysAuth };
}

const before = await counts();
console.log("\n[phase3] === BEFORE COUNTS ===");
console.log(`  categories: ${before.cats}, menuitems: ${before.items}, orders: ${before.orders}, staffs: ${before.staffs}`);
console.log(`  brandconfigs: ${before.brandconfigs}, brandings(legacy): ${before.brandings}, paymentinfos: ${before.pays}, users(legacy): ${before.users}, system_auth: ${before.sysAuth}`);

// ── 1. CATEGORY MIGRATION ──
console.log("\n[phase3] --- Category normalization ---");
const cats = await categoriesCol.find({}).toArray();
let catBackfilled = 0;
let catOrphanStrict = 0;
for (const c of cats) {
  const updates = {};
  // name: ensure LocalizedString {am,en,om}
  if (typeof c.name === "string") {
    const s = c.name.trim() || "Category";
    updates.name = { am: s, en: s, om: s };
  } else if (c.name && typeof c.name === "object" && !c.name.en && !c.name.am && !c.name.om) {
    // Mixed weird shape
    const s = String(c.name).trim() || "Category";
    updates.name = { am: s, en: s, om: s };
  } else if (c.name && typeof c.name === "object") {
    const en = String(c.name.en || c.name.am || c.name.om || "Category");
    const am = String(c.name.am || en);
    const om = String(c.name.om || en);
    if (c.name.en !== en || c.name.am !== am || c.name.om !== om) {
      updates.name = { am, en, om };
    }
  }
  // slug: must exist and unique
  if (!c.slug || typeof c.slug !== "string" || !c.slug.trim()) {
    const enName = typeof updates.name === "object" ? updates.name.en : (c.name?.en || String(c.name) || "category");
    updates.slug = slugify(enName);
  }
  // targetStation ↔ type sync — canonical is targetStation
  const stationFromType = c.type === "DRINK" ? "BARISTA" : c.type === "FOOD" ? "KITCHEN" : null;
  const station = c.targetStation || stationFromType || null;
  if (!c.targetStation && station) {
    updates.targetStation = station;
  }
  if (!c.type && c.targetStation) {
    updates.type = c.targetStation === "BARISTA" ? "DRINK" : "FOOD";
  } else if (c.type && !c.targetStation && stationFromType) {
    updates.targetStation = stationFromType;
  }
  // order ↔ displayOrder — canonical is order
  if (c.order == null && c.displayOrder != null) {
    updates.order = c.displayOrder;
  } else if (c.order != null && c.displayOrder == null) {
    updates.displayOrder = c.order;
  } else if (c.order == null && c.displayOrder == null) {
    updates.order = 0;
    updates.displayOrder = 0;
  } else if (c.order !== c.displayOrder) {
    // keep both in sync to canonical order
    updates.displayOrder = c.order;
  }
  if (c.isActive == null) updates.isActive = true;

  if (Object.keys(updates).length) {
    catBackfilled++;
    console.log(`  [cat] ${c._id} (${c.slug || "no-slug"}) → backfill: ${Object.keys(updates).join(", ")}`);
    if (DO_WRITE) {
      await categoriesCol.updateOne({ _id: c._id }, { $set: updates });
    }
  }
}
console.log(`[phase3] Categories backfilled: ${catBackfilled} / ${cats.length}`);

// Verify no category missing canonical fields (dry-run check)
const missingCatCanonical = await categoriesCol.countDocuments({ $or: [{ targetStation: { $exists: false } }, { order: { $exists: false } }, { slug: { $exists: false } }] });
if (DO_WRITE) {
  const afterMissing = await categoriesCol.countDocuments({ $or: [{ targetStation: { $exists: false } }, { order: { $exists: false } }] });
  console.log(`[phase3] Categories missing canonical targetStation/order after: ${afterMissing} (should be 0)`);
} else {
  console.log(`[phase3] (dry-run) Categories currently missing canonical: ${missingCatCanonical}`);
}

// ── 2. MENUITEM MIGRATION ──
console.log("\n[phase3] --- MenuItem normalization ---");
const items = await menuitemsCol.find({}).toArray();
let itemBackfilled = 0;
let itemOrphans = 0;
let itemInconsistent = 0;

for (const doc of items) {
  const updates = {};
  const catId = doc.category ? String(doc.category) : doc.categoryId ? String(doc.categoryId) : null;

  // category ↔ categoryId
  if (doc.category && !doc.categoryId) updates.categoryId = doc.category;
  if (doc.categoryId && !doc.category) updates.category = doc.categoryId;
  if (!doc.category && !doc.categoryId) {
    console.warn(`  [item] ${doc._id} WARNING — missing both category & categoryId (orphan)`);
    itemOrphans++;
  }
  // Check ref exists
  if (catId) {
    const exists = await categoriesCol.findOne({ _id: new mongoose.Types.ObjectId(catId) }).catch(() => null);
    if (!exists) {
      console.warn(`  [item] ${doc._id} WARNING — category ref ${catId} not found in categories`);
      itemOrphans++;
    }
  }

  // station ↔ targetStation
  if (doc.targetStation && !doc.station) updates.station = doc.targetStation;
  if (doc.station && !doc.targetStation) updates.targetStation = doc.station;
  if (!doc.station && !doc.targetStation) {
    // derive from categoryType or category
    const derived = doc.categoryType === "DRINK" ? "BARISTA" : "KITCHEN";
    updates.station = derived;
    updates.targetStation = derived;
  }

  // image ↔ imageUrl — canonical imageUrl
  if (doc.imageUrl && !doc.image) updates.image = doc.imageUrl;
  if (doc.image && !doc.imageUrl) updates.imageUrl = doc.image;
  if (!doc.imageUrl && !doc.image) {
    // leave empty — manager CRUD will default on create, but flag
    console.warn(`  [item] ${doc._id} no image`);
  }

  // isNew ↔ isItemNew/isPopular — canonical isNew
  if (doc.isNew == null && doc.isItemNew != null) updates.isNew = !!doc.isItemNew;
  if (doc.isNew != null && doc.isItemNew == null) updates.isItemNew = !!doc.isNew;
  if (doc.isNew == null && doc.isItemNew == null && doc.isPopular == null) {
    updates.isNew = false;
    updates.isItemNew = false;
    updates.isPopular = false;
  }
  // isPopular mirrors isNew per pre-validate (if isNew true, isPopular true)
  if (doc.isPopular == null && updates.isNew != null) updates.isPopular = !!updates.isNew;
  else if (doc.isPopular == null && doc.isNew != null) updates.isPopular = !!doc.isNew;

  // isAvailable ↔ inStock — canonical isAvailable
  if (doc.isAvailable == null && doc.inStock != null) updates.isAvailable = !!doc.inStock;
  if (doc.inStock == null && doc.isAvailable != null) updates.inStock = !!doc.isAvailable;
  if (doc.isAvailable == null && doc.inStock == null) {
    updates.isAvailable = true;
    updates.inStock = true;
  } else if (doc.isAvailable !== doc.inStock && doc.isAvailable != null && doc.inStock != null) {
    // inconsistent — canonical wins
    console.warn(`  [item] ${doc._id} inconsistent isAvailable=${doc.isAvailable} inStock=${doc.inStock} → canonical isAvailable=${doc.isAvailable}`);
    itemInconsistent++;
    updates.inStock = !!doc.isAvailable;
  }

  // categoryType derived
  if (!doc.categoryType) {
    const st = updates.targetStation || doc.targetStation || doc.station;
    updates.categoryType = st === "BARISTA" ? "DRINK" : "FOOD";
  }

  if (Object.keys(updates).length) {
    itemBackfilled++;
    console.log(`  [item] ${doc._id} → ${Object.keys(updates).join(", ")}`);
    if (DO_WRITE) {
      await menuitemsCol.updateOne({ _id: doc._id }, { $set: updates });
    }
  }
}
console.log(`[phase3] MenuItems backfilled: ${itemBackfilled} / ${items.length}, orphans: ${itemOrphans}, inconsistent isAvailable/inStock: ${itemInconsistent}`);

const missingCanonicalItems = await menuitemsCol.countDocuments({
  $or: [
    { category: { $exists: false } },
    { targetStation: { $exists: false } },
    { imageUrl: { $exists: false } },
    { isNew: { $exists: false } },
    { isAvailable: { $exists: false } },
  ],
});
console.log(`[phase3] MenuItems missing canonical after${DO_WRITE ? "" : " (dry-run current)"}: ${missingCanonicalItems} (should be 0 after apply)`);

// ── 3. ORDER NORMALIZATION (non-destructive) ──
console.log("\n[phase3] --- Order normalization ---");
const orders = await ordersCol.find({}).toArray();
let orderBackfilled = 0;
for (const o of orders) {
  const updates = {};
  if (!("isExternal" in o)) updates.isExternal = false;
  if (!o.waiterInfo && o.waiterId) {
    updates.waiterInfo = {
      waiterId: String(o.waiterId),
      waiterNumber: o.waiterNumber ?? null,
      shiftId: "SHIFT-DEFAULT",
      deviceId: "DEVICE-UNKNOWN",
    };
  }
  if (o.totalAmount == null && o.items) {
    const sum = o.items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0);
    updates.totalAmount = Math.round(sum * 100) / 100;
  }
  if (Object.keys(updates).length) {
    orderBackfilled++;
    console.log(`  [order] ${o.orderNumber} → ${Object.keys(updates).join(", ")}`);
    if (DO_WRITE) {
      await ordersCol.updateOne({ _id: o._id }, { $set: updates });
    }
  }
}
console.log(`[phase3] Orders backfilled: ${orderBackfilled} / ${orders.length}`);

// ── 4. BRAND CONFIG CONSOLIDATION ──
console.log("\n[phase3] --- BrandConfig consolidation ---");
const brandings = await brandingsCol.find({}).toArray().catch(() => []);
const brandconfigs = await brandconfigsCol.find({}).toArray();
console.log(`  brandconfigs: ${brandconfigs.length}, brandings(legacy): ${brandings.length}`);
if (brandings.length) {
  for (const b of brandings) {
    const name = b.hotelName || b.name || "I HOPE CAFE";
    const logoPath = b.logoUrl || b.logoPath || "";
    console.log(`  [brand] legacy ${b._id}: hotelName=${name}, logoUrl=${logoPath ? "present" : "empty"}`);
    if (DO_WRITE && brandconfigs.length === 0) {
      await brandconfigsCol.updateOne({}, { $set: { name, logoPath } }, { upsert: true });
      console.log(`  [brand] migrated legacy branding → brandconfigs`);
    } else if (DO_WRITE) {
      console.log(`  [brand] brandconfigs already exists — legacy branding retained for manual review, not auto-deleted`);
    }
  }
}

// ── 5. PAYMENT & STAFF CHECKS ──
console.log("\n[phase3] --- Staff / PaymentInfo / SystemAuth checks ---");
const staffCount = await staffsCol.countDocuments();
const payCount = await paymentinfosCol.countDocuments();
console.log(`  staffs: ${staffCount}, paymentinfos: ${payCount}`);
const usersCount = await usersCol.countDocuments().catch(() => 0);
console.log(`  users(legacy): ${usersCount} ${usersCount === 0 ? "(safe to drop collection after verification)" : "(has docs — retain until migration audited)"}`);
const sysAuthDoc = await systemAuthCol.findOne({ _id: "system" });
if (sysAuthDoc) {
  const pins = ["waiterPin", "kitchenPin", "baristaPin", "managerPin"];
  const missingPins = pins.filter((p) => !sysAuthDoc[p]);
  if (missingPins.length) console.warn(`  [system_auth] missing pins: ${missingPins.join(", ")}`);
  else console.log(`  [system_auth] all PIN fields present`);
}

// ── 6. INDEX REVIEW ──
console.log("\n[phase3] --- Index review ---");
const menuIdx = await menuitemsCol.indexes();
const catIdx = await categoriesCol.indexes();
const orderIdx = await ordersCol.indexes();
console.log(`  menuitems indexes: ${menuIdx.map((i) => i.name).join(", ")}`);
console.log(`  categories indexes: ${catIdx.map((i) => i.name).join(", ")}`);
console.log(`  orders indexes: ${orderIdx.map((i) => i.name).join(", ")}`);

// Identify redundant: category_1_isAvailable_1 vs categoryId_1_isAvailable_1 — keep canonical `category`
const hasLegacyCatIdIdx = menuIdx.some((i) => i.name === "categoryId_1_isAvailable_1");
const hasCanonicalCatIdx = menuIdx.some((i) => i.name === "category_1_isAvailable_1" || i.name === "category_isAvailable");
if (hasLegacyCatIdIdx && hasCanonicalCatIdx) {
  console.log(`  [index] menuitems has redundant categoryId_1_isAvailable_1 (legacy) alongside canonical category_1_isAvailable_1 — both are retained; this script never drops indexes.`);
}

// Check missing canonical indexes
const expectedCategorySlugUnique = catIdx.some((i) => i.key.slug === 1 && i.unique);
console.log(`  categories slug unique: ${expectedCategorySlugUnique ? "OK" : "MISSING — should be unique"}`);
const hasOrderStatusCreated = orderIdx.some((i) => i.key.status === 1 && i.key.createdAt === -1);
console.log(`  orders status+createdAt: ${hasOrderStatusCreated ? "OK" : "MISSING"}`);

// Create any missing schema indexes. ADDITIVE ONLY: createIndexes() never drops
// or replaces indexes that already exist on the collections.
if (DO_WRITE) {
  console.log(`\n[phase3] Creating missing indexes via Mongoose (additive only, no drops) ...`);
  try {
    const { getCategoryModel } = await import("../lib/models/Category.js");
    const { getMenuItemModel } = await import("../lib/models/MenuItem.js");
    const { getOrderModel } = await import("../lib/models/Order.js");
    const { getStaffModel } = await import("../lib/models/Staff.js");
    const { getBrandConfigModel } = await import("../lib/models/BrandConfig.js");
    const { getPaymentInfoModel } = await import("../lib/models/PaymentInfo.js");
    // Use raw connection
    await getCategoryModel(conn).createIndexes();
    await getMenuItemModel(conn).createIndexes();
    await getOrderModel(conn).createIndexes();
    await getStaffModel(conn).createIndexes();
    await getBrandConfigModel(conn).createIndexes();
    await getPaymentInfoModel(conn).createIndexes();
    console.log(`  missing indexes created; existing indexes left untouched`);
  } catch (e) {
    console.warn(`  index creation skipped: ${e.message}`);
  }
} else {
  console.log(`  (dry-run) would create missing indexes on --apply (additive only, no drops)`);
}

// ── 7. VERIFICATION AFTER ──
const after = await counts();
console.log("\n[phase3] === AFTER COUNTS ===");
console.log(`  categories: ${after.cats} (delta ${after.cats - before.cats}), menuitems: ${after.items} (delta ${after.items - before.items}), orders: ${after.orders} (delta ${after.orders - before.orders})`);
console.log(`  brandconfigs: ${after.brandconfigs}, brandings: ${after.brandings}, paymentinfos: ${after.pays}, users: ${after.users}`);

let ok = true;
if (after.cats !== before.cats) { console.error(`[phase3] FAIL — category count changed!`); ok = false; }
if (after.items !== before.items) { console.error(`[phase3] FAIL — menuitems count changed!`); ok = false; }
if (after.orders !== before.orders) { console.error(`[phase3] FAIL — orders count changed!`); ok = false; }
if (after.staffs !== before.staffs) { console.error(`[phase3] FAIL — staffs count changed!`); ok = false; }
if (after.pays !== before.pays) { console.error(`[phase3] FAIL — paymentinfos count changed!`); ok = false; }

if (DO_WRITE) {
  const stillMissingCat = await categoriesCol.countDocuments({ $or: [{ targetStation: { $exists: false } }, { order: { $exists: false } }] });
  const stillMissingItem = await menuitemsCol.countDocuments({ $or: [{ category: { $exists: false } }, { targetStation: { $exists: false } }, { imageUrl: { $exists: false } }] });
  console.log(`\n[phase3] Post-migration canonical completeness: categories missing canonical: ${stillMissingCat}, menuitems missing canonical: ${stillMissingItem}`);
  if (stillMissingCat !== 0 || stillMissingItem !== 0) { console.error(`[phase3] FAIL — canonical backfill incomplete`); ok = false; }
}

console.log(`\n[phase3] ${ok ? "✅ VERIFICATION PASSED — no data loss detected." : "❌ VERIFICATION FAILED — review logs."}`);
console.log(`[phase3] ${DO_WRITE ? "APPLY complete." : "DRY RUN complete — re-run with --apply to write."}`);
console.log(`[phase3] Next: after verification, remove legacy fallbacks (oldField||newField) and review remaining legacy indexes manually; then harden schemas to strict:true.`);

await conn.close();
process.exit(ok ? 0 : 1);
