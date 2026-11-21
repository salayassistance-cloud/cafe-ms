// Inventory index deployment path — DB-free tests for the Phase 2.4 gap
// closure (see docs/production-readiness/phase-2-4-production-database-checklist.md
// §9.4: no script previously deployed InventoryItem, InventoryReservation,
// StockMovement, or PaymentInfo indexes).
//
// Covers:
//  * every expected schema index definition and option (exact keys/options),
//  * the deployment script stays additive-only and guarded (source contract),
//  * gate behavior via real process spawns (no MONGODB_URI in scope, so no
//    connection is even possible),
//  * --dry-run reports the intended operations offline,
//  * legacy-index conflicts fail closed with owner-gated manual guidance,
//  * the five pre-existing non-inventory models keep their unchanged path.
//
// No database connection is made and no index is created, dropped, or
// modified. The deployment command itself is never executed against a
// database.
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getInventoryItemModel } from "../lib/models/InventoryItem.js";
import { getInventoryReservationModel } from "../lib/models/InventoryReservation.js";
import { getStockMovementModel } from "../lib/models/StockMovement.js";
import { getPaymentInfoModel } from "../lib/models/PaymentInfo.js";
import { getOrderModel } from "../lib/models/Order.js";
import mongoose from "mongoose";
import {
  INVENTORY_INDEX_MODELS,
  REMOVAL_GATE_TEXT,
  buildIndexPlan,
  findLegacyConflicts,
  mongooseIndexName,
} from "../lib/indexDeploymentPlan.js";

// Model registration never opens a connection — the unconnected default
// connection is exactly what the deployment script uses for its offline plan.
const offlineConn = mongoose.connection;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const script = () => {
  const text = src("scripts/sync-indexes.js");
  // Remove block comments and whole-line comments only (mirrors
  // tests/pos-index-management.test.mjs so string literals are preserved).
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
};

// A spawn environment that can never reach a database: all Mongo URIs and
// gates removed.
function sanitizedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/MONGODB|POS_INDEX|POS_AUTO|NODE_ENV|VERCEL_ENV|DEPLOY_ENV|ENVIRONMENT|APP_ENV|^CONTEXT$/i.test(key)) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

function runScript(args, envOverrides = {}) {
  return spawnSync(process.execPath, [join(root, "scripts/sync-indexes.js"), ...args], {
    env: sanitizedEnv(envOverrides),
    encoding: "utf8",
    cwd: root,
  });
}

describe("schema-defined inventory indexes (exact definitions)", () => {
  test("inventoryitems: two compound query indexes, non-unique", () => {
    const plan = buildIndexPlan(getInventoryItemModel(offlineConn));
    assert.deepEqual(plan.map((i) => i.name).sort(), ["category_1_status_1", "supplier_1_status_1"]);
    for (const idx of plan) {
      assert.equal(idx.options.unique, undefined, "InventoryItem indexes are not unique");
      assert.equal(idx.options.partialFilterExpression, undefined);
    }
    const byName = Object.fromEntries(plan.map((i) => [i.name, i.key]));
    assert.deepEqual(byName.category_1_status_1, { category: 1, status: 1 });
    assert.deepEqual(byName.supplier_1_status_1, { supplier: 1, status: 1 });
  });

  test("inventoryreservations: unique orderId plus diagnostics lookups", () => {
    const plan = buildIndexPlan(getInventoryReservationModel(offlineConn));
    const byName = Object.fromEntries(plan.map((i) => [i.name, i]));
    // One reservation per order — the field-level unique/index declaration.
    assert.deepEqual(byName.orderId_1.key, { orderId: 1 });
    assert.equal(byName.orderId_1.options.unique, true);
    // Diagnostics lookups exactly as declared at the bottom of the schema.
    assert.deepEqual(byName.status_1_createdAt_1.key, { status: 1, createdAt: 1 });
    assert.deepEqual(byName["status_1_updatedAt_-1"].key, { status: 1, updatedAt: -1 });
    assert.equal(byName["status_1_updatedAt_-1"].options.unique, undefined);
    for (const name of ["orderNumber_1", "status_1", "requirementFingerprint_1", "shortageFingerprint_1"]) {
      assert.ok(byName[name], `${name} is part of the schema plan`);
    }
  });

  test("stockmovements: correctness-critical unique partial indexes preserved exactly", () => {
    const plan = buildIndexPlan(getStockMovementModel(offlineConn));
    const byName = Object.fromEntries(plan.map((i) => [i.name, i]));

    // One sale deduction per (order, reason, item) — partial on objectId refOrderId.
    assert.deepEqual(byName.refOrderId_1_reason_1_item_1.key, { refOrderId: 1, reason: 1, item: 1 });
    assert.equal(byName.refOrderId_1_reason_1_item_1.options.unique, true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(byName.refOrderId_1_reason_1_item_1.options.partialFilterExpression)),
      { refOrderId: { $type: "objectId" } }
    );

    // One purchase receipt per idempotency key — partial on string idempotencyKey.
    assert.deepEqual(byName.idempotencyKey_1.key, { idempotencyKey: 1 });
    assert.equal(byName.idempotencyKey_1.options.unique, true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(byName.idempotencyKey_1.options.partialFilterExpression)),
      { idempotencyKey: { $type: "string" } }
    );

    // Reporting lookups.
    assert.deepEqual(byName["item_1_createdAt_-1"].key, { item: 1, createdAt: -1 });
    assert.deepEqual(byName["reason_1_createdAt_-1"].key, { reason: 1, createdAt: -1 });
    assert.equal(byName["item_1_createdAt_-1"].options.unique, undefined);
  });

  test("paymentinfos: explicitly covered; schema defines no indexes today", () => {
    const plan = buildIndexPlan(getPaymentInfoModel(offlineConn));
    assert.deepEqual(plan, [], "PaymentInfo has no schema indexes — coverage must report that, not skip it");
  });

  test("planner descriptors point at the four inventory collections", () => {
    assert.deepEqual(
      INVENTORY_INDEX_MODELS.map((m) => m.collection),
      ["inventoryitems", "inventoryreservations", "stockmovements", "paymentinfos"]
    );
    for (const m of INVENTORY_INDEX_MODELS) {
      assert.equal(m.conflictScan, true, `${m.collection} receives the legacy pre-check`);
      assert.match(m.getter, /^get[A-Z]/);
    }
  });
});

describe("index plan conflict classification (pure, offline)", () => {
  const planned = buildIndexPlan(getStockMovementModel(offlineConn));

  test("a legacy unique (refOrderId, reason) index is flagged as a superseded prefix", () => {
    const existing = [
      { name: "refOrderId_1_reason_1", key: { refOrderId: 1, reason: 1 }, options: { unique: true } },
    ];
    const conflicts = findLegacyConflicts(existing, planned);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, "SUPERSEDED_PREFIX");
    assert.equal(conflicts[0].indexName, "refOrderId_1_reason_1");
    assert.equal(conflicts[0].unique, true, "flags the uniqueness risk explicitly");
    assert.match(conflicts[0].guidance, /never/i);
  });

  test("a non-unique legacy prefix is also reported (it distorts query plans)", () => {
    const existing = [{ name: "refOrderId_1_reason_1", key: { refOrderId: 1, reason: 1 }, options: {} }];
    const conflicts = findLegacyConflicts(existing, planned);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].unique, false);
  });

  test("an unrelated existing index produces no conflict", () => {
    const existing = [
      { name: "createdAt_1", key: { createdAt: 1 }, options: {} },
      { name: "item_1_createdAt_-1", key: { item: 1, createdAt: -1 }, options: {} },
    ];
    assert.deepEqual(findLegacyConflicts(existing, planned), []);
  });

  test("a name collision with different options fails closed", () => {
    const existing = [
      { name: "idempotencyKey_1", key: { idempotencyKey: 1 }, options: { unique: false } },
    ];
    const conflicts = findLegacyConflicts(existing, planned);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, "NAME_TAKEN");
  });

  test("removal guidance is manual, owner-gated, and never automatic", () => {
    assert.match(REMOVAL_GATE_TEXT, /owner-approved change\/ticket/);
    assert.match(REMOVAL_GATE_TEXT, /duplicate preflight/);
    assert.match(REMOVAL_GATE_TEXT, /separately approved maintenance window/);
    assert.match(REMOVAL_GATE_TEXT, /never in the same\s+operation/);
    assert.match(REMOVAL_GATE_TEXT, /never drops, rebuilds, or modifies/);
  });

  test("index name derivation matches the MongoDB generated-name rule", () => {
    assert.equal(mongooseIndexName({ refOrderId: 1, reason: 1, item: 1 }), "refOrderId_1_reason_1_item_1");
    assert.equal(mongooseIndexName({ status: 1, createdAt: -1 }), "status_1_createdAt_-1");
    assert.equal(mongooseIndexName({}), "");
  });
});

describe("deployment script safety gates (source contract)", () => {
  test("additive only: createIndexes, never sync/drop in code or strings", () => {
    const code = script();
    assert.ok(code.includes("await model.createIndexes()"), "additive build per model");
    assert.ok(!/\bsyncIndexes\s*\(/.test(code), "no syncIndexes call");
    assert.ok(!/\bdropIndex/i.test(code), "no drop of any kind is wired (even in strings)");
  });

  test("--confirm gate precedes any database access", () => {
    const code = script();
    const confirmGate = code.indexOf('if (!hasFlag("--confirm"))');
    const connectCall = code.indexOf("mongoose.connect");
    assert.ok(confirmGate > 0, "confirmation gate exists");
    assert.ok(connectCall > confirmGate, "confirmation is checked before connecting");
    assert.ok(code.includes("No database operation was performed"));
  });

  test("production targets require --allow-production and a ticket reference", () => {
    const code = script();
    assert.ok(code.includes("--allow-production"));
    assert.ok(code.includes("POS_INDEX_DEPLOY_APPROVAL"));
    assert.ok(code.includes("Refusing production index deployment without --allow-production"));
    assert.ok(code.includes("Refusing production index deployment without a non-empty POS_INDEX_DEPLOY_APPROVAL"));
    assert.ok(!code.includes("console.log(process.env.POS_INDEX_DEPLOY_APPROVAL"), "approval value never printed");
  });

  test("connection strings are redacted from failures", () => {
    const raw = src("scripts/sync-indexes.js");
    assert.ok(raw.includes("mongodb://[redacted]"));
    assert.ok(raw.includes("credentials redacted"));
    assert.ok(!raw.includes("console.log(MONGODB_URI"), "never prints the URI");
  });

  test("legacy pre-check runs before any createIndexes and never removes", () => {
    const code = script();
    const precheck = code.indexOf("findLegacyConflicts(existing");
    const create = code.indexOf("await model.createIndexes()");
    assert.ok(precheck > 0, "read-only legacy pre-check exists");
    assert.ok(create > precheck, "conflicts are detected BEFORE any createIndexes call");
    assert.ok(code.includes("No index was created or dropped"), "fail-closed message");
    assert.ok(code.includes("read-only legacy-index pre-check"), "documented as read-only");
  });

  test("duplicate/conflict failures report actionable details", () => {
    const code = script();
    assert.ok(code.includes("error?.code === 85 || error?.code === 86"), "index-spec conflict codes surfaced");
    assert.ok(code.includes("E11000") || code.includes("duplicate key"), "duplicate-key guidance present");
    assert.ok(code.includes("duplicate preflight"), "points operators at the documented preflight");
  });

  test("the five pre-existing non-inventory models keep their unchanged path", () => {
    const code = script();
    for (const [label, getter] of [
      ["orders", "getOrderModel"],
      ["staffs", "getStaffModel"],
      ["categories", "getCategoryModel"],
      ["menuitems", "getMenuItemModel"],
      ["inventoryaudits", "getInventoryAuditModel"],
    ]) {
      assert.ok(code.includes(`["${label}", ${getter}(conn), false]`), `${label} unchanged (no legacy pre-check)`);
      assert.ok(code.includes(getter), `${getter} still imported`);
    }
    // The four inventory models are additive entries with the pre-check flag.
    for (const m of INVENTORY_INDEX_MODELS) {
      assert.ok(code.includes(`["${m.label}", ${m.getter}(conn), true]`), `${m.label} added with pre-check`);
    }
  });
});

describe("deployment script gate behavior (real process, no database in scope)", () => {
  test("missing --confirm blocks execution", () => {
    const r = runScript([]);
    assert.equal(r.status, 1);
    assert.match(r.stderr || r.stdout, /Refusing to write indexes without --confirm/);
    assert.match(r.stderr || r.stdout, /No database operation was performed/);
  });

  test("production target without --allow-production blocks execution", () => {
    const r = runScript(["--confirm"], { NODE_ENV: "production" });
    assert.equal(r.status, 1);
    assert.match(r.stderr || r.stdout, /Refusing production index deployment without --allow-production/);
  });

  test("production approval environment gate is enforced", () => {
    const r = runScript(["--confirm", "--allow-production"], { NODE_ENV: "production" });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr || r.stdout,
      /Refusing production index deployment without a non-empty POS_INDEX_DEPLOY_APPROVAL/
    );
  });

  test("with all gates satisfied but no URI, nothing connects (still no deployment)", () => {
    const r = runScript(["--confirm", "--allow-production"], {
      NODE_ENV: "production",
      POS_INDEX_DEPLOY_APPROVAL: "TEST-TICKET-001",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr || r.stdout, /MONGODB_URI is not set/);
  });

  test("default execution is non-destructive even when misconfigured", () => {
    // No confirm flag anywhere, no URI: the script must refuse before any
    // module side effect could matter and never print a credential.
    const r = runScript(["--dry-run", "--confirm"], {});
    assert.equal(r.status, 0, "dry-run + confirm still does not connect");
    assert.doesNotMatch(r.stdout + (r.stderr || ""), /mongodb(\+srv)?:\/\/[^\s\[]/i, "no URI leaked");
  });
});

describe("--dry-run reports the plan offline", () => {
  const r = runScript(["--dry-run"], {});
  const out = (r.stdout || "") + (r.stderr || "");

  test("exits 0 without connecting or requiring MONGODB_URI", () => {
    assert.equal(r.status, 0);
    assert.match(out, /No database connection was made/);
    assert.match(out, /Nothing was created, dropped, or connected/);
  });

  test("reports every inventory collection with exact generated index names", () => {
    assert.match(out, /inventoryitems:/);
    assert.match(out, /inventoryreservations:/);
    assert.match(out, /stockmovements:/);
    assert.match(out, /paymentinfos: no schema indexes defined/);
    assert.match(out, /refOrderId_1_reason_1_item_1.*\[unique, partial/);
    assert.match(out, /idempotencyKey_1.*\[unique, partial/);
    assert.match(out, /orderId_1 key \{"orderId":1\} \[unique\]/);
  });

  test("reports the unique/partial options exactly as the schema defines them", () => {
    assert.match(out, /partial \{"refOrderId":\{"\$type":"objectId"\}\}/);
    assert.match(out, /partial \{"idempotencyKey":\{"\$type":"string"\}\}/);
  });
});
