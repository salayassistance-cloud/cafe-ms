// Disposable, synthetic, local-only stored-unit audit runner.
//
// SAFETY
// ------
// - Refuses any host other than 127.0.0.1 and any port other than 27017.
// - Refuses any database name that is not `bono_unit_audit_disposable_*`.
// - Refuses to run if the target database already exists or has collections.
// - Inserts the synthetic fixture only, into that one database.
// - Never drops, renames, or writes to any other database.
// - Never reads environment files or credentials and never prints a URI.
//
// This is SYNTHETIC / DISPOSABLE evidence only. It is not production data.

import mongoose from "mongoose";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_UNIT_LIST,
  canNormalizeUnit,
  normalizeUnit,
} from "../../lib/inventoryUnits.js";
import { AMBIGUOUS_UNITS } from "../../lib/inventoryUnitAdapter.js";
import {
  convertRequirementToStockUnit,
  mergeRequirements,
} from "../../lib/inventoryRequirementConversion.js";
import {
  buildRequirementFingerprint,
  sameUnit,
} from "../../lib/inventoryReservationRules.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "inventory-unit-disposable-audit.fixture.json");

const CANONICAL = new Set(CANONICAL_UNIT_LIST);
const AMBIGUOUS = new Set(AMBIGUOUS_UNITS);

const OBJECT_ID_FIELDS = new Set([
  "_id",
  "item",
  "inventoryItemId",
  "orderId",
  "menuItemId",
  "managerId",
  "actorId",
  "by",
  "voidedBy",
  "consumedBy",
  "correlationId",
  "supplier",
  "refOrderId",
  "createdBy",
  "componentId",
  "lineId",
  "itemId",
  "paymentAccountId",
]);

const DATE_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "approvedAt",
  "at",
  "decisionAt",
  "consumedAt",
  "releasedAt",
  "cancelledAt",
  "voidedAt",
]);

function sanitize(text) {
  return String(text).replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "<redacted-uri>");
}

function fail(message) {
  throw new Error(sanitize(message));
}

function parseArgs(argv) {
  const args = { host: "", port: "", db: "", auditOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--host") args.host = value ?? "";
    else if (key === "--port") args.port = value ?? "";
    else if (key === "--db") args.db = value ?? "";
    else if (key === "--audit-only") args.auditOnly = true;
  }
  return args;
}

function toBson(value, key) {
  if (Array.isArray(value)) return value.map((item) => toBson(item, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = toBson(childValue, childKey);
    }
    return out;
  }
  if (typeof value === "string") {
    if (OBJECT_ID_FIELDS.has(key) && /^[a-f0-9]{24}$/i.test(value)) {
      return new mongoose.Types.ObjectId(value);
    }
    if (DATE_FIELDS.has(key)) return new Date(value);
  }
  return value;
}

function displayRaw(value) {
  if (value === null) return "null";
  if (typeof value !== "string") return `<${typeof value}>`;
  return JSON.stringify(value);
}

function classifyNormalized(normalized) {
  if (AMBIGUOUS.has(normalized)) return "ambiguous";
  if (!canNormalizeUnit(normalized)) return "unsupported";
  const definition = normalizeUnit(normalized);
  return CANONICAL.has(normalized) && CANONICAL.has(definition.canonicalUnit)
    ? "canonical"
    : "mapped";
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function distribution(entries) {
  const stats = {
    totalEntries: entries.length,
    present: 0,
    missing: 0,
    nullValue: 0,
    empty: 0,
    whitespaceOnly: 0,
    nonString: 0,
  };
  const rawCounts = new Map();
  const normalizedCounts = new Map();
  const canonicalByNormalized = new Map();
  const classes = { canonical: 0, mapped: 0, unsupported: 0, ambiguous: 0 };
  const classByRaw = new Map();

  for (const entry of entries) {
    if (!entry.present) {
      stats.missing += 1;
      continue;
    }
    stats.present += 1;
    const raw = entry.raw;

    if (raw === null) {
      stats.nullValue += 1;
      increment(rawCounts, "null");
      continue;
    }
    if (typeof raw !== "string") {
      stats.nonString += 1;
      increment(rawCounts, `<${typeof raw}>`);
      classes.unsupported += 1;
      continue;
    }
    if (raw === "") {
      stats.empty += 1;
      increment(rawCounts, JSON.stringify(raw));
      continue;
    }
    if (raw.trim() === "") {
      stats.whitespaceOnly += 1;
      increment(rawCounts, JSON.stringify(raw));
      continue;
    }

    const normalized = raw.trim().toLowerCase();
    increment(rawCounts, JSON.stringify(raw));
    increment(normalizedCounts, normalized);
    const cls = classifyNormalized(normalized);
    classes[cls] += 1;
    classByRaw.set(JSON.stringify(raw), cls);
    if (canNormalizeUnit(normalized)) {
      canonicalByNormalized.set(normalized, normalizeUnit(normalized).canonicalUnit);
    }
  }

  return {
    ...stats,
    distinctRaw: [...rawCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([raw, count]) => ({ raw, count })),
    distinctNormalized: [...normalizedCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([normalized, count]) => ({
        normalized,
        count,
        canonicalUnit: canonicalByNormalized.get(normalized) ?? null,
        class: classifyNormalized(normalized),
      })),
    classification: classes,
    classByRaw: Object.fromEntries(
      [...classByRaw.entries()].sort(([a], [b]) => a.localeCompare(b))
    ),
  };
}

// Returns `convertedQuantity` (and milli units) separately so the caller's
// demand `quantity` is never overwritten. Raw demand values stay untouched.
function convertRow(rawUnit, quantity, item) {
  if (!item) return { outcome: "MISSING_ITEM", code: "ITEM_NOT_FOUND" };
  const present = Object.prototype.hasOwnProperty.call(item, "unit");
  const stockUnit = item.unit;
  if (!present || stockUnit === null || typeof stockUnit !== "string" || stockUnit.trim() === "") {
    return { outcome: "MISSING_STOCK_UNIT", code: "MISSING_UNIT" };
  }
  if (sameUnit(stockUnit, rawUnit)) {
    return { outcome: "SAME_UNIT", code: null, convertedQuantity: Number(quantity) };
  }
  const result = convertRequirementToStockUnit(quantity, rawUnit ?? "", stockUnit);
  if (result.ok) {
    return {
      outcome: "CONVERTED",
      code: null,
      convertedQuantity: result.quantity,
      convertedQuantityMilli: result.quantityMilli.toString(),
    };
  }
  return { outcome: "REJECTED", code: result.code };
}

function summariseOutcomes(rows) {
  const byOutcome = { SAME_UNIT: 0, CONVERTED: 0, REJECTED: 0, MISSING_STOCK_UNIT: 0, MISSING_ITEM: 0 };
  const byCode = {};
  for (const row of rows) {
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
    if (row.code) byCode[row.code] = (byCode[row.code] ?? 0) + 1;
  }
  return { byOutcome, byCode };
}

function requirementKey(value) {
  return String(value ?? "");
}

function duplicatesFor(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = requirementKey(row.inventoryItemId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([inventoryItemId, group]) => ({ inventoryItemId, rows: group }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.host !== "127.0.0.1") fail(`Refusing non-local host: ${args.host || "(missing)"}`);
  if (String(args.port) !== "27017") fail(`Refusing non-standard port: ${args.port || "(missing)"}`);
  if (!/^bono_unit_audit_disposable_[a-z0-9_]+$/.test(args.db)) {
    fail(`Refusing non-disposable database name: ${args.db || "(missing)"}`);
  }

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const conn = mongoose.createConnection();
  await conn.openUri(`mongodb://${args.host}:${args.port}/${args.db}`, {
    serverSelectionTimeoutMS: 5000,
    autoIndex: false,
  });

  if (conn.db.databaseName !== args.db) fail("Connected database name mismatch");

  const admin = conn.db.admin();
  const existingNames = (await admin.listDatabases()).databases.map((d) => d.name);
  const existing = existingNames.includes(args.db);
  const beforeCollections = await conn.db.listCollections({}, { nameOnly: true }).toArray();

  let inserted = {};
  if (args.auditOnly) {
    // Strictly read-only re-audit of an existing disposable database.
    // The stored content must exactly match the fixture, otherwise refuse.
    if (!existing || beforeCollections.length === 0) {
      fail(`Refusing audit-only run on missing or empty database: ${args.db}`);
    }
    const fixtureNames = Object.keys(fixture.collections);
    for (const name of fixtureNames) {
      if (!beforeCollections.some((c) => c.name === name)) {
        fail(`Refusing audit-only run: collection ${name} missing in ${args.db}`);
      }
    }
    for (const coll of beforeCollections) {
      if (!fixtureNames.includes(coll.name)) {
        fail(`Refusing audit-only run: unexpected collection ${coll.name} in ${args.db}`);
      }
    }
    for (const name of fixtureNames) {
      const expected = fixture.collections[name].length;
      const actual = await conn.db.collection(name).countDocuments({});
      if (actual !== expected) {
        fail(`Refusing audit-only run: ${name} count ${actual} != fixture ${expected}`);
      }
    }
  } else {
    if (existing) {
      fail(`Refusing to reuse existing database: ${args.db}`);
    }
    if (beforeCollections.length > 0) {
      fail(`Refusing to use a non-empty database: ${args.db}`);
    }
    for (const [name, docs] of Object.entries(fixture.collections)) {
      const prepared = docs.map((doc) => toBson(doc));
      if (prepared.length > 0) {
        await conn.db.collection(name).insertMany(prepared, { ordered: true });
      }
      inserted[name] = prepared.length;
    }
  }

  const verifiedCounts = {};
  for (const name of Object.keys(fixture.collections)) {
    verifiedCounts[name] = await conn.db.collection(name).countDocuments({});
  }

  // ---- read-only audit ----
  const docs = {};
  for (const name of Object.keys(fixture.collections)) {
    docs[name] = await conn.db.collection(name).find({}).toArray();
  }

  const items = docs.inventoryitems;
  const itemById = new Map(items.map((item) => [String(item._id), item]));

  const itemEntries = items.map((item) => ({
    collection: "inventoryitems",
    documentId: String(item._id),
    path: "unit",
    present: Object.prototype.hasOwnProperty.call(item, "unit"),
    raw: item.unit,
    itemId: String(item._id),
    quantity: null,
  }));

  const recipeEntries = [];
  const componentRows = [];
  for (const recipe of docs.recipes) {
    for (const [index, ingredient] of (recipe.ingredients ?? []).entries()) {
      recipeEntries.push({
        collection: "recipes",
        documentId: String(recipe._id),
        path: `ingredients[${index}].unit`,
        present: Object.prototype.hasOwnProperty.call(ingredient, "unit"),
        raw: ingredient.unit,
        itemId: ingredient.inventoryItemId ? String(ingredient.inventoryItemId) : null,
        quantity: ingredient.quantity,
      });
      componentRows.push({
        recipeId: String(recipe._id),
        menuItemId: String(recipe.menuItemId),
        ingredientIndex: index,
        inventoryItemId: ingredient.inventoryItemId ? String(ingredient.inventoryItemId) : null,
        demandUnit: ingredient.unit,
        quantity: ingredient.quantity,
      });
    }
  }

  const movementEntries = docs.stockmovements.map((movement) => ({
    collection: "stockmovements",
    documentId: String(movement._id),
    path: "unit",
    present: Object.prototype.hasOwnProperty.call(movement, "unit"),
    raw: movement.unit,
    itemId: movement.item ? String(movement.item) : null,
    quantity: movement.quantity,
  }));

  const auditEntries = [];
  for (const audit of docs.inventoryaudits) {
    auditEntries.push({
      collection: "inventoryaudits",
      documentId: String(audit._id),
      path: "unit",
      present: Object.prototype.hasOwnProperty.call(audit, "unit"),
      raw: audit.unit,
      itemId: audit.item ? String(audit.item) : null,
      quantity: null,
    });
    for (const snapshot of ["beforeSnapshot", "afterSnapshot"]) {
      const value = audit[snapshot];
      const present =
        value !== null &&
        typeof value === "object" &&
        Object.prototype.hasOwnProperty.call(value, "unit");
      auditEntries.push({
        collection: "inventoryaudits",
        documentId: String(audit._id),
        path: `${snapshot}.unit`,
        present,
        raw: present ? value.unit : undefined,
        itemId: audit.item ? String(audit.item) : null,
        quantity: null,
      });
    }
  }

  const reservationItemEntries = [];
  const approvalShortageEntries = [];
  const voidItemEntries = [];
  for (const reservation of docs.inventoryreservations) {
    for (const [index, item] of (reservation.items ?? []).entries()) {
      reservationItemEntries.push({
        collection: "inventoryreservations",
        documentId: String(reservation._id),
        path: `items[${index}].unit`,
        present: Object.prototype.hasOwnProperty.call(item, "unit"),
        raw: item.unit,
        itemId: item.inventoryItemId ? String(item.inventoryItemId) : null,
        quantity: item.requiredQuantity,
      });
    }
    for (const [index, shortage] of (reservation.approval?.shortages ?? []).entries()) {
      approvalShortageEntries.push({
        collection: "inventoryreservations",
        documentId: String(reservation._id),
        path: `approval.shortages[${index}].unit`,
        present: Object.prototype.hasOwnProperty.call(shortage, "unit"),
        raw: shortage.unit,
        itemId: shortage.inventoryItemId ? String(shortage.inventoryItemId) : null,
        quantity: shortage.requiredQuantity,
      });
    }
    for (const [voidIndex, voidDoc] of (reservation.voids ?? []).entries()) {
      for (const [index, item] of (voidDoc.items ?? []).entries()) {
        voidItemEntries.push({
          collection: "inventoryreservations",
          documentId: String(reservation._id),
          path: `voids[${voidIndex}].items[${index}].unit`,
          present: Object.prototype.hasOwnProperty.call(item, "unit"),
          raw: item.unit,
          itemId: item.inventoryItemId ? String(item.inventoryItemId) : null,
          quantity: item.quantity,
        });
      }
    }
  }

  const orderComponentEntries = [];
  const orderComponentConversions = [];
  for (const order of docs.orders) {
    for (const [lineIndex, line] of (order.items ?? []).entries()) {
      for (const [componentIndex, component] of (line.components ?? []).entries()) {
        if (component.kind !== "PRICED_COMPONENT") continue;
        orderComponentEntries.push({
          collection: "orders",
          documentId: String(order._id),
          path: `items[${lineIndex}].components[${componentIndex}].stockUnit`,
          present: Object.prototype.hasOwnProperty.call(component, "stockUnit"),
          raw: component.stockUnit,
          itemId: component.inventoryItemId ? String(component.inventoryItemId) : null,
          quantity: component.stockQuantity,
        });
        orderComponentConversions.push({
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          lineName: line.name,
          componentName: component.name,
          inventoryItemId: component.inventoryItemId ? String(component.inventoryItemId) : null,
          demandUnit: component.stockUnit,
          quantity: component.stockQuantity,
        });
      }
    }
  }

  const distributions = {
    "inventoryitems.unit": distribution(itemEntries),
    "recipes.ingredients[].unit": distribution(recipeEntries),
    "stockmovements.unit": distribution(movementEntries),
    "inventoryaudits.unit+beforeSnapshot.unit+afterSnapshot.unit": distribution(auditEntries),
    "inventoryreservations.items[].unit": distribution(reservationItemEntries),
    "inventoryreservations.approval.shortages[].unit": distribution(approvalShortageEntries),
    "inventoryreservations.voids[].items[].unit": distribution(voidItemEntries),
    "orders.items[].components[].stockUnit": distribution(orderComponentEntries),
  };

  const recipeConversions = componentRows.map((row) => {
    const item = itemById.get(row.inventoryItemId);
    const result = convertRow(row.demandUnit, row.quantity, item);
    return {
      ...row,
      stockUnit: item ? item.unit ?? null : null,
      ...result,
    };
  });

  const orderConversions = orderComponentConversions.map((row) => {
    const item = itemById.get(row.inventoryItemId);
    const result = convertRow(row.demandUnit, row.quantity, item);
    return { ...row, stockUnit: item ? item.unit ?? null : null, ...result };
  });

  const recipeDuplicates = duplicatesFor(
    recipeConversions.map((row) => ({
      inventoryItemId: row.inventoryItemId,
      unit: row.demandUnit,
      requiredQuantity: row.quantity,
      outcome: row.outcome,
      code: row.code,
      convertedQuantity: row.convertedQuantity,
      stockUnit: row.stockUnit,
    }))
  ).map((group) => {
    // Conversion outcomes are already computed above; reuse them so the
    // merge works on exact converted stock-unit values (M3).
    const convertedRows = [];
    const warnings = [];
    for (const row of group.rows) {
      if (row.outcome === "SAME_UNIT" || row.outcome === "CONVERTED") {
        convertedRows.push({
          inventoryItemId: group.inventoryItemId,
          unit: row.stockUnit,
          requiredQuantity: row.convertedQuantity,
        });
      } else {
        warnings.push({ outcome: row.outcome, code: row.code, unit: row.unit });
      }
    }
    const merged = mergeRequirements(convertedRows);
    return {
      inventoryItemId: group.inventoryItemId,
      rowCount: group.rows.length,
      rows: group.rows.map((row) => ({
        unit: row.unit,
        quantity: row.requiredQuantity,
        outcome: row.outcome,
        code: row.code,
      })),
      mergeCandidates: convertedRows,
      mergedRowCount: merged.items.length,
      mergedRequiredQuantity: merged.items.map((item) => item.requiredQuantity),
      mergeWarnings: [...warnings, ...merged.warnings],
    };
  });

  const reservationByStatus = {};
  for (const reservation of docs.inventoryreservations) {
    reservationByStatus[reservation.status] = (reservationByStatus[reservation.status] ?? 0) + 1;
  }

  const analysableStatuses = new Set(["RESERVED", "APPROVAL_REQUIRED", "APPROVED"]);
  const reservationImpact = [];
  for (const reservation of docs.inventoryreservations) {
    if (!analysableStatuses.has(reservation.status)) continue;
    const beforeItems = (reservation.items ?? []).map((item) => ({
      inventoryItemId: String(item.inventoryItemId),
      unit: item.unit,
      requiredQuantity: item.requiredQuantity,
    }));
    const beforeFingerprint = buildRequirementFingerprint(String(reservation.orderId), beforeItems);

    const afterRows = [];
    const applied = [];
    const dropped = [];
    for (const item of beforeItems) {
      const stockDoc = itemById.get(item.inventoryItemId);
      const result = convertRow(item.unit, item.requiredQuantity, stockDoc);
      if (result.outcome === "SAME_UNIT" || result.outcome === "CONVERTED") {
        afterRows.push({
          inventoryItemId: item.inventoryItemId,
          unit: stockDoc.unit,
          requiredQuantity: result.convertedQuantity,
        });
        applied.push({
          inventoryItemId: item.inventoryItemId,
          fromUnit: item.unit,
          fromQuantity: item.requiredQuantity,
          toUnit: stockDoc.unit,
          toQuantity: result.convertedQuantity,
          outcome: result.outcome,
        });
      } else {
        dropped.push({
          inventoryItemId: item.inventoryItemId,
          unit: item.unit,
          quantity: item.requiredQuantity,
          outcome: result.outcome,
          code: result.code,
        });
      }
    }

    const merged = mergeRequirements(afterRows);
    const afterFingerprint = buildRequirementFingerprint(String(reservation.orderId), merged.items);
    const duplicateGroups = duplicatesFor(beforeItems);

    reservationImpact.push({
      reservationId: String(reservation._id),
      orderId: String(reservation.orderId),
      orderNumber: reservation.orderNumber,
      status: reservation.status,
      storedRequirementFingerprint: reservation.requirementFingerprint,
      reconstructedBeforeFingerprint: beforeFingerprint,
      reconstructedAfterFingerprint: afterFingerprint,
      duplicateRowGroups: duplicateGroups.map((group) => ({
        inventoryItemId: group.inventoryItemId,
        rowCount: group.rows.length,
      })),
      applied,
      dropped,
      mergeWarnings: merged.warnings,
      affected: beforeFingerprint !== afterFingerprint || dropped.length > 0,
      approvalInvalidated:
        reservation.status === "APPROVED" &&
        (beforeFingerprint !== afterFingerprint || dropped.length > 0),
      hasApproval: Boolean(reservation.approval),
    });
  }

  const report = {
    synthetic: true,
    disposable: true,
    productionEvidence: false,
    label: "SYNTHETIC / DISPOSABLE — NOT PRODUCTION EVIDENCE",
    endpoint: { host: args.host, port: Number(args.port) },
    database: args.db,
    mode: args.auditOnly ? "audit-only (strictly read-only)" : "load+audit",
    preflight: {
      databaseExisted: existing,
      collectionsBeforeInsert: beforeCollections.length,
      existingDatabaseCount: existingNames.length,
    },
    inserted,
    verifiedCounts,
    distributions,
    conversionSummary: {
      recipes: summariseOutcomes(recipeConversions),
      orderComponents: summariseOutcomes(orderConversions),
      recipeRows: recipeConversions,
      orderComponentRows: orderConversions,
    },
    duplicateMergeExamples: {
      recipes: recipeDuplicates,
    },
    reservations: {
      byStatus: reservationByStatus,
      analysedStatuses: [...analysableStatuses],
      impact: reservationImpact,
      affectedCount: reservationImpact.filter((row) => row.affected).length,
      approvalInvalidatedCount: reservationImpact.filter((row) => row.approvalInvalidated).length,
    },
    limitations: [
      "Synthetic data only; it is not evidence about production or customer inventory.",
      "The real stored-unit audit remains BLOCKED until a sanitized real-data export is authorized.",
      "No schema indexes were created; the audit reads raw collections only.",
      "Some documents intentionally violate schema requirements to exercise detection.",
    ],
  };

  console.log(JSON.stringify(report, null, 2));

  await conn.close();
}

main().catch(async (error) => {
  console.error(JSON.stringify({ ok: false, name: error?.name, message: sanitize(error?.message) }));
  process.exitCode = 1;
});
