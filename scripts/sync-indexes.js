// Phase 2.2 — explicit, additive POS index deployment.
//
// This command replaces the old `Order.syncIndexes()` behaviour. It calls
// `createIndexes()` only: it creates missing schema indexes and NEVER drops,
// rebuilds, or modifies an existing index. Any conflict is reported and the
// process exits non-zero so an operator can inspect it.
//
// Usage:
//   node --env-file=.env.local scripts/sync-indexes.js --dry-run
//   node --env-file=.env.local scripts/sync-indexes.js --confirm
//   node --env-file=.env.local scripts/sync-indexes.js --confirm --allow-production
//
// --dry-run prints the exact planned index operations (keys, generated names,
// unique/partial options) derived from the live Mongoose schemas. It never
// connects to any database, never requires MONGODB_URI, and writes nothing.
//
// Production runs also require a non-empty POS_INDEX_DEPLOY_APPROVAL
// change/ticket reference. The approval value is checked but never printed.
//
// Phase 2.4 gap closure: the inventory collections (inventoryitems,
// inventoryreservations, stockmovements, paymentinfos) are now covered. For
// these four, the script first runs a read-only legacy-index pre-check and
// FAILS CLOSED with the exact conflicting index and an owner-gated manual
// removal procedure when a legacy index (for example a unique
// (refOrderId, reason) index) conflicts with the schema plan. Legacy index
// removal is never part of this command.
//
// The application itself no longer syncs indexes on connection in production
// (see lib/mongodb.js). Deploy this command as a release prerequisite.

const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const isDryRun = hasFlag("--dry-run");

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(
    "Usage: node scripts/sync-indexes.js --dry-run\n" +
      "       node scripts/sync-indexes.js --confirm [--allow-production]\n" +
      "--dry-run: print the planned index operations without connecting.\n" +
      "Deployment creates missing indexes with createIndexes() only. Never drops indexes."
  );
  process.exit(0);
}

if (!hasFlag("--confirm")) {
  if (!isDryRun) {
    console.error(
      "Refusing to write indexes without --confirm. No database operation was performed."
    );
    process.exit(1);
  }
}

const productionMarkers = ["NODE_ENV", "VERCEL_ENV", "CONTEXT", "DEPLOY_ENV", "ENVIRONMENT", "APP_ENV"];
const isProduction = productionMarkers.some((key) =>
  ["production", "prod", "live"].includes(String(process.env[key] || "").trim().toLowerCase())
);
if (isProduction && !isDryRun) {
  if (!hasFlag("--allow-production")) {
    console.error(
      "Refusing production index deployment without --allow-production. No database operation was performed."
    );
    process.exit(1);
  }
  if (!String(process.env.POS_INDEX_DEPLOY_APPROVAL || "").trim()) {
    console.error(
      "Refusing production index deployment without a non-empty POS_INDEX_DEPLOY_APPROVAL change/ticket reference. No database operation was performed."
    );
    process.exit(1);
  }
}

// Dry-run is offline by design: no URI is read, no connection is made. The
// URI is required only for a real deployment.
if (!isDryRun) {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error(
      "MONGODB_URI is not set — run with: node --env-file=.env.local scripts/sync-indexes.js --confirm"
    );
    process.exit(1);
  }
}

(async () => {
  try {
    const [
      { getOrderModel },
      { getStaffModel },
      { getCategoryModel },
      { getMenuItemModel },
      { getInventoryAuditModel },
      { getInventoryItemModel },
      { getInventoryReservationModel },
      { getStockMovementModel },
      { getPaymentInfoModel },
      { buildIndexPlan, findLegacyConflicts },
    ] = await Promise.all([
      import("../lib/models/Order.js"),
      import("../lib/models/Staff.js"),
      import("../lib/models/Category.js"),
      import("../lib/models/MenuItem.js"),
      import("../lib/models/InventoryAudit.js"),
      import("../lib/models/InventoryItem.js"),
      import("../lib/models/InventoryReservation.js"),
      import("../lib/models/StockMovement.js"),
      import("../lib/models/PaymentInfo.js"),
      import("../lib/indexDeploymentPlan.js"),
    ]);

    // Model registration does not open a connection — safe for --dry-run.
    const conn = mongoose.connection;
    const models = [
      ["orders", getOrderModel(conn), false],
      ["staffs", getStaffModel(conn), false],
      ["categories", getCategoryModel(conn), false],
      ["menuitems", getMenuItemModel(conn), false],
      ["inventoryaudits", getInventoryAuditModel(conn), false],
      ["inventoryitems", getInventoryItemModel(conn), true],
      ["inventoryreservations", getInventoryReservationModel(conn), true],
      ["stockmovements", getStockMovementModel(conn), true],
      ["paymentinfos", getPaymentInfoModel(conn), true],
    ];

    if (isDryRun) {
      console.log("DRY-RUN — offline index plan. No database connection was made.");
      for (const [label, model] of models) {
        const plan = buildIndexPlan(model);
        if (plan.length === 0) {
          console.log(`  ${label}: no schema indexes defined (nothing to create)`);
          continue;
        }
        console.log(`  ${label}:`);
        for (const idx of plan) {
          const flags = [];
          if (idx.options.unique) flags.push("unique");
          if (idx.options.partialFilterExpression) {
            flags.push(`partial ${JSON.stringify(idx.options.partialFilterExpression)}`);
          }
          console.log(`    ${idx.name} key ${JSON.stringify(idx.key)}${flags.length ? ` [${flags.join(", ")}]` : ""}`);
        }
      }
      console.log(
        "At deployment time (--confirm) each inventory collection also receives a read-only legacy-index pre-check before any createIndexes() call."
      );
      console.log("DRY-RUN complete. Nothing was created, dropped, or connected.");
      return;
    }

    await mongoose.connect(process.env.MONGODB_URI, {
      bufferCommands: false,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 30000,
      connectTimeoutMS: 10000,
    });
    console.log("Connected to the POS database (credentials redacted).");

    // Legacy-index pre-check for the inventory collections: read-only
    // listIndexes over each collection, fail closed BEFORE any
    // createIndexes() call. This command never removes an index — a
    // conflicting legacy index (e.g. a unique (refOrderId, reason) index)
    // must be removed manually in a separately reviewed, owner-gated window.
    const precheckFailures = [];
    for (const [label, model, legacyScan] of models) {
      if (!legacyScan) continue;
      const existing = await mongoose.connection.db.collection(label).indexes();
      precheckFailures.push(
        ...findLegacyConflicts(existing, buildIndexPlan(model)).map((conflict) => ({ label, conflict }))
      );
    }
    if (precheckFailures.length > 0) {
      for (const { label, conflict } of precheckFailures) {
        console.error(`LEGACY INDEX CONFLICT on ${label}:`);
        console.error(`  kind: ${conflict.kind}`);
        console.error(`  existing index name: ${conflict.indexName}`);
        console.error(`  existing: ${JSON.stringify(conflict.existing)}`);
        console.error(`  planned:  ${JSON.stringify(conflict.planned)}`);
        if (conflict.kind === "SUPERSEDED_PREFIX" && conflict.unique) {
          console.error(
            "  A legacy UNIQUE prefix index rejects every multi-ingredient order while it exists."
          );
        }
        console.error(conflict.guidance);
      }
      console.error(
        "Pre-check failed. No index was created or dropped. No database operation was performed on any collection."
      );
      process.exitCode = 1;
      await mongoose.disconnect().catch(() => {});
      return;
    }

    for (const [label, model] of models) {
      console.log(`createIndexes ${label} (additive only)`);
      await model.createIndexes();
    }

    console.log(
      "POS indexes verified/created additively. No index was dropped or rebuilt."
    );
    await mongoose.disconnect();
    console.log("Done.");
  } catch (error) {
    const raw = String(error?.message || error);
    const message = raw.replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://[redacted]");
    console.error("Index deployment failed:", message);
    if (error?.code === 85 || error?.code === 86) {
      console.error(
        "Actionable: an existing index conflicts with the schema definition (IndexOptions/IndexKeySpecs mismatch). Compare with db.collection.getIndexes() and follow the owner-gated manual procedure in docs/production-readiness/phase-2-4-production-database-checklist.md §8.5. No index was dropped."
      );
    } else if (error?.code === 11000 || /duplicate key|E11000/i.test(raw)) {
      console.error(
        "Actionable: duplicate documents block a unique index build. Run the read-only duplicate preflight (docs/production-readiness/phase-2-4-production-database-checklist.md §8.5), reconcile manually, then re-run. No index was dropped."
      );
    }
    process.exitCode = 1;
    await mongoose.disconnect().catch(() => {});
  }
})();
