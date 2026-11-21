#!/usr/bin/env node
/**
 * Database Cleanup Migration — Order History Reset
 * ------------------------------------------------
 * Clears historical test orders / invoices, resets the order sequence counter,
 * and releases locked waiter slots. Menu items, categories, users and staff
 * credentials are never touched.
 *
 * ============================================================================
 * SAFETY CONTRACT (C2 hardening)
 * ============================================================================
 * Default invocation is INSPECTION ONLY. It reads counts and prints a plan;
 * it never writes. Deletion requires ALL of the following:
 *
 *   1. --execute
 *   2. --confirm DELETE-ALL-ORDER-HISTORY   (exact, case-sensitive)
 *   3. --backup-ref <non-empty>             (verified backup/export reference)
 *   4. --approval-ref <non-empty>           (change/ticket reference)
 *   5. an explicit non-production environment classification
 *
 * Production-like, missing, or ambiguous environment classification is
 * refused UNCONDITIONALLY. There is no production override flag.
 * DRY_RUN=1 (or --dry-run) is inspection only and can never authorize
 * --execute; supplying both is a conflict and is refused.
 *
 * Every argument and environment check runs BEFORE the database driver is
 * loaded or a connection is opened. Hostnames, URIs, and credentials are
 * never printed.
 *
 * ============================================================================
 * DESTRUCTIVE SCOPE (unchanged — see --help)
 * ============================================================================
 *   orders        : deleteMany({}) -> EVERY order, including PAID/ARCHIVED
 *   counters      : order_seq + legacy order counter ids reset to seq 0
 *   system_auth   : activeWaiters cleared (releases all live waiter slots)
 *
 * NOT touched: menu_items, categories, users, staff credentials,
 * InventoryReservation, InventoryItem.reservedStock, StockMovement.
 * The operation is NOT transactional.
 *
 * Usage:
 *   node scripts/clean-order-history.js                       # inspection only
 *   BONO_OPERATION_ENV=staging node scripts/clean-order-history.js --execute \
 *     --confirm DELETE-ALL-ORDER-HISTORY \
 *     --backup-ref <backup-or-export-id> \
 *     --approval-ref <change-or-ticket-id>
 *
 *   node scripts/clean-order-history.js --help
 */

// Destructive-execution contract.
const DESTRUCTIVE_FLAG = "--execute";
const CONFIRMATION_FLAG = "--confirm";
const CONFIRMATION_TOKEN = "DELETE-ALL-ORDER-HISTORY";
const BACKUP_FLAG = "--backup-ref";
const APPROVAL_FLAG = "--approval-ref";
const DRY_RUN_FLAG = "--dry-run";
const HELP_FLAGS = Object.freeze(["--help", "-h"]);

// Environment classification. Fail closed: only an explicit, recognized
// non-production value permits destructive execution.
const ENV_MARKERS = Object.freeze([
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

// Counter ids that may hold the order sequence in this codebase. The canonical
// one is "order_seq" (see lib/orderService.js genOrderNumber). The others are
// defensive fallbacks for legacy / alternate naming so the reset is robust.
const ORDER_COUNTER_IDS = Object.freeze(["order_seq", "orderNumber", "orderId", "order"]);

const USAGE_TEXT = `
Order-history reset — DESTRUCTIVE when explicitly authorized.

Usage:
  node scripts/clean-order-history.js [--dry-run]     Inspection only (no writes)
  node scripts/clean-order-history.js --help          Show this help

  node scripts/clean-order-history.js --execute \\
    --confirm DELETE-ALL-ORDER-HISTORY \\
    --backup-ref <non-empty> \\
    --approval-ref <non-empty>

Required for --execute (all checked before any database connection):
  --execute                     Explicit destructive execution flag.
  --confirm DELETE-ALL-ORDER-HISTORY
                                Exact, case-sensitive confirmation token.
  --backup-ref <value>          Verified backup/export reference.
  --approval-ref <value>        Change/ticket approval reference.

Environment:
  Execution requires an explicit non-production classification. Recognized:
    development, dev, test, testing, staging, stage, preview, local, ci,
    deploy-preview, branch-deploy
  Markers checked: BONO_OPERATION_ENV, NODE_ENV, APP_ENV, DEPLOY_ENV,
    ENVIRONMENT, VERCEL_ENV, CONTEXT
  Production-like ("production", "prod", "live"), missing, unrecognized, or
  conflicting classification is refused unconditionally. No override exists.

DESTRUCTIVE SCOPE (unchanged):
  - orders:      deletes EVERY order, including PAID and ARCHIVED orders.
  - counters:    resets order_seq and legacy order counter ids to seq 0.
  - system_auth: clears activeWaiters, releasing all live waiter slots.
  NOT touched:   menu_items, categories, users, staff credentials,
                 InventoryReservation, InventoryItem.reservedStock,
                 StockMovement.
  The reset is NOT transactional.

Dry run:
  Default invocation and --dry-run / DRY_RUN=1 read counts and print the plan.
  They cannot mutate data. Combining a dry-run request with --execute is
  refused as a conflict.
`.trim();

function normalizeEnvValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isDryRunRequested(env) {
  return TRUTHY.includes(normalizeEnvValue(env?.DRY_RUN));
}

/**
 * Classifies the target environment from well-known marker variables.
 * Fail-closed rules:
 *  - any production-like marker -> production
 *  - any unrecognized non-empty marker -> ambiguous, treated as production
 *  - no recognized non-production marker -> missing, treated as production
 */
function classifyOperationEnvironment(env = process.env) {
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
 * Pure argument parser. Never reads files, loads a driver, or connects.
 * Returns { ok:false, error } for malformed, missing, duplicated, or
 * conflicting arguments.
 */
function parseInvocation(argv = [], env = process.env) {
  const result = {
    ok: true,
    mode: "inspect",
    help: false,
    execute: false,
    confirmation: null,
    backupRef: null,
    approvalRef: null,
    dryRun: false,
  };
  const seen = new Set();
  const args = Array.isArray(argv) ? argv : [];

  const fail = (error) => ({ ...result, ok: false, error });

  const readValue = (flag, index) => {
    const value = args[index + 1];
    if (value === undefined || value === "" || value.startsWith("-")) {
      return { error: `${flag} requires a non-empty value` };
    }
    return { value };
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (HELP_FLAGS.includes(arg)) {
      if (seen.has("help")) return fail("duplicate argument: --help");
      seen.add("help");
      result.help = true;
      continue;
    }

    if (arg === DRY_RUN_FLAG) {
      if (seen.has(DRY_RUN_FLAG)) return fail(`duplicate argument: ${DRY_RUN_FLAG}`);
      seen.add(DRY_RUN_FLAG);
      result.dryRun = true;
      continue;
    }

    if (arg === DESTRUCTIVE_FLAG) {
      if (seen.has(DESTRUCTIVE_FLAG)) return fail(`duplicate argument: ${DESTRUCTIVE_FLAG}`);
      seen.add(DESTRUCTIVE_FLAG);
      result.execute = true;
      continue;
    }

    if (arg === CONFIRMATION_FLAG || arg === BACKUP_FLAG || arg === APPROVAL_FLAG) {
      if (seen.has(arg)) return fail(`duplicate argument: ${arg}`);
      const parsedValue = readValue(arg, i);
      if (parsedValue.error) return fail(parsedValue.error);
      seen.add(arg);
      if (arg === CONFIRMATION_FLAG) result.confirmation = parsedValue.value;
      if (arg === BACKUP_FLAG) result.backupRef = parsedValue.value;
      if (arg === APPROVAL_FLAG) result.approvalRef = parsedValue.value;
      i += 1;
      continue;
    }

    return fail(`unknown argument: ${arg}`);
  }

  if (result.help) {
    result.mode = "help";
    return result;
  }

  const destructiveArgsSupplied =
    result.confirmation !== null || result.backupRef !== null || result.approvalRef !== null;

  if (result.execute && (result.dryRun || isDryRunRequested(env))) {
    return fail(
      "conflicting arguments: --execute cannot be combined with --dry-run or DRY_RUN=1 (dry-run is inspection only)"
    );
  }

  if (!result.execute && destructiveArgsSupplied) {
    return fail(
      `${DESTRUCTIVE_FLAG} is required before --confirm/--backup-ref/--approval-ref can be used`
    );
  }

  if (result.execute) {
    if (result.confirmation !== CONFIRMATION_TOKEN) {
      return fail(`--confirm must exactly equal ${CONFIRMATION_TOKEN}`);
    }
    if (!String(result.backupRef ?? "").trim()) {
      return fail(`${BACKUP_FLAG} is required and must be non-empty before execution`);
    }
    if (!String(result.approvalRef ?? "").trim()) {
      return fail(`${APPROVAL_FLAG} is required and must be non-empty before execution`);
    }
    result.mode = "execute";
  }

  return result;
}

/**
 * Pure authorization gate. Never connects.
 * Inspection is always allowed; execution is refused in production, in an
 * ambiguous/missing environment, or when the parsed arguments are invalid.
 */
function assertExecutionAuthorized(parsed, env = process.env) {
  if (!parsed || parsed.ok !== true) {
    return {
      ok: false,
      execute: false,
      errors: [parsed?.error || "invalid invocation"],
      environment: null,
    };
  }
  if (parsed.mode !== "execute") {
    return { ok: true, execute: false, errors: [], environment: null };
  }

  const environment = classifyOperationEnvironment(env);
  if (environment.production) {
    return {
      ok: false,
      execute: true,
      errors: [
        `refusing destructive execution: ${environment.reason} ` +
          `(${environment.observations.join(", ") || "no markers set"}). ` +
          "Production execution is refused unconditionally; there is no override.",
      ],
      environment,
    };
  }

  return { ok: true, execute: true, errors: [], environment };
}

/**
 * Masks URIs, credential-shaped parameters, and hostnames before any error
 * text is printed. Used only on failure paths.
 */
function redact(value) {
  return String(value ?? "")
    .replace(/mongodb(\+srv)?:\/\/[^\s"'`]+/gi, "mongodb://[redacted]")
    .replace(/\b(password|pwd|secret|token|pass)=([^&\s"'`]+)/gi, "$1=[redacted]")
    .replace(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?\b/gi, "[host]");
}

function refusal(message) {
  console.error(`REFUSED: ${message}`);
  console.error("No database connection was attempted and no data was modified.");
  return 2;
}

async function main() {
  const env = process.env;
  const parsed = parseInvocation(process.argv.slice(2), env);

  if (!parsed.ok) {
    console.error(USAGE_TEXT);
    return refusal(parsed.error);
  }
  if (parsed.help) {
    console.log(USAGE_TEXT);
    return 0;
  }

  // All argument and environment checks happen before the driver is loaded.
  const authorization = assertExecutionAuthorized(parsed, env);
  if (!authorization.ok) {
    for (const error of authorization.errors) console.error(`REFUSED: ${error}`);
    console.error("No database connection was attempted and no data was modified.");
    return 2;
  }

  const mongoUri = env.MONGODB_URI;
  if (!mongoUri) {
    console.error("MONGODB_URI is not set in the process environment.");
    console.error("No database connection was attempted and no data was modified.");
    return 1;
  }

  // Loaded only after every authorization check has passed.
  const mongoose = require("mongoose");
  const execute = parsed.mode === "execute";

  try {
    await mongoose.connect(mongoUri, {
      bufferCommands: false,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 30000,
      connectTimeoutMS: 10000,
      // A cleanup command must never create collections or build indexes.
      autoIndex: false,
      autoCreate: false,
    });
    console.log("Connected to the configured database (host and credentials hidden).");

    // ESM model modules are imported dynamically: this script is CommonJS
    // (the repo's *.js scripts use require), while the models are ESM exports.
    const { getOrderModel } = await import("../lib/models/Order.js");
    const { getSystemAuthModel } = await import("../lib/models/SystemAuth.js");

    const Order = getOrderModel(mongoose.connection);
    const SystemAuth = getSystemAuthModel(mongoose.connection);
    const counters = mongoose.connection.collection("counters");

    const orderCount = await Order.estimatedDocumentCount();
    const paidCount = await Order.countDocuments({ status: "PAID" });
    const archivedCount = await Order.countDocuments({ status: "ARCHIVED" });
    const sysDoc = await SystemAuth.findById("system").lean();
    const activeWaiters = Array.isArray(sysDoc?.activeWaiters) ? sysDoc.activeWaiters.length : 0;
    const counter = await counters.findOne({ _id: "order_seq" });

    console.log("");
    console.log(execute ? "ORDER HISTORY RESET — EXECUTION AUTHORIZED" : "INSPECTION ONLY — no writes will be performed");
    console.log(`  orders total:    ${orderCount}`);
    console.log(`  orders PAID:     ${paidCount}`);
    console.log(`  orders ARCHIVED: ${archivedCount}`);
    console.log(`  activeWaiters:   ${activeWaiters}`);
    console.log(`  order_seq:       ${counter ? counter.seq : "n/a"}`);
    console.log("  destructive scope: ALL orders (including PAID/ARCHIVED),");
    console.log("                     order counters reset to 0, activeWaiters cleared.");
    console.log("  not transactional; InventoryReservation/reservedStock are NOT touched.");
    console.log("");

    if (!execute) {
      console.log("Dry run complete. Re-run with --execute and the required arguments");
      console.log("(--confirm, --backup-ref, --approval-ref) in an approved");
      console.log("non-production environment to perform the reset.");
      return 0;
    }

    console.log("Authorization references:");
    console.log(`  backup-ref:   ${parsed.backupRef}`);
    console.log(`  approval-ref: ${parsed.approvalRef}`);
    console.log("");

    // -----------------------------------------------------------------------
    // 1. CLEAR ORDERS COLLECTION (unchanged scope: every order)
    // -----------------------------------------------------------------------
    const res = await Order.deleteMany({});
    console.log(`Cleared ${res.deletedCount} order record(s) from 'orders'.`);

    // -----------------------------------------------------------------------
    // 2. RESET ORDER SEQUENCE COUNTER
    // -----------------------------------------------------------------------
    await counters.updateOne(
      { _id: "order_seq" },
      { $set: { seq: 0 } },
      { upsert: true }
    );
    const extras = await counters.updateMany(
      { _id: { $in: ORDER_COUNTER_IDS.filter((id) => id !== "order_seq") } },
      { $set: { seq: 0 } }
    );
    console.log(
      `Reset order sequence counter 'order_seq' to 0` +
        (extras.modifiedCount
          ? ` (plus ${extras.modifiedCount} legacy counter doc(s)).`
          : ".")
    );

    // -----------------------------------------------------------------------
    // 3. RELEASE ACTIVE WAITER SESSIONS (explicit side effect, unchanged)
    // -----------------------------------------------------------------------
    await SystemAuth.updateOne(
      { _id: "system" },
      { $set: { activeWaiters: [] } }
    );
    console.log("Released all active waiter sessions (system_auth.activeWaiters = []).");

    console.log("");
    console.log("Order history reset complete. Menu items, categories, users and");
    console.log("PIN credentials remain untouched; active waiter sessions cleared.");
    return 0;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

module.exports = {
  DESTRUCTIVE_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_TOKEN,
  BACKUP_FLAG,
  APPROVAL_FLAG,
  DRY_RUN_FLAG,
  USAGE_TEXT,
  ORDER_COUNTER_IDS,
  classifyOperationEnvironment,
  parseInvocation,
  assertExecutionAuthorized,
  redact,
};

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = typeof code === "number" ? code : 0;
    })
    .catch((err) => {
      console.error("ERROR during database cleanup:", redact(err?.message || err));
      process.exitCode = 1;
    });
}
