#!/usr/bin/env node
// BONO Inventory V2 — explicit, guarded index deployment command.
//
// Usage (after configuring MONGODB_URI for the intended database):
//   node --env-file=.env.local scripts/inventory-v2-deploy-indexes.mjs --confirm
//
// This command is the ONLY supported way to create Inventory V2 indexes. It is
// never imported by application startup and never runs automatically.
//
// Safety properties:
//   * requires --confirm;
//   * requires a separate production approval gate (--allow-production plus a
//     non-empty INVENTORY_V2_INDEX_DEPLOY_APPROVAL change/ticket reference);
//   * calls createIndexes() only;
//   * inspects indexes before and after deployment;
//   * verifies exact names, keys, uniqueness, TTL, and partial options;
//   * fails closed on missing, unexpected, mismatched, duplicate, or forbidden
//     indexes;
//   * never synchronizes, removes, or drops indexes;
//   * never prints the URI, credentials, or approval value.
//
// Phase 2.0: this script was created but NOT executed. No database connection
// was opened during implementation.

import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import mongoose from "mongoose";

import {
  V2_COLLECTIONS,
  V2_INDEX_PLAN,
  assertV2IndexPlan,
  indexKeySignature,
} from "../lib/inventory-v2/server/indexPlan.js";

const USAGE = `Usage:
  node --env-file=.env.local scripts/inventory-v2-deploy-indexes.mjs --confirm

Options:
  --confirm            Required acknowledgement that this writes indexes.
  --allow-production   Required when a production environment marker is set.
  --help               Show this help.

Production also requires a non-empty INVENTORY_V2_INDEX_DEPLOY_APPROVAL change
or ticket reference. The command never prints the URI, credentials, or approval
value. It creates only missing Inventory V2 indexes and never removes indexes.`;

const PRODUCTION_VALUES = new Set(["production", "prod", "live"]);
const NON_PRODUCTION_VALUES = new Set([
  "development",
  "dev",
  "local",
  "test",
  "disposable",
]);
const PRODUCTION_MARKERS = Object.freeze([
  "INVENTORY_V2_INDEX_DEPLOY_ENV",
  "NODE_ENV",
  "VERCEL_ENV",
  "CONTEXT",
  "DEPLOY_ENV",
  "ENVIRONMENT",
  "APP_ENV",
]);
export const APPROVAL_ENV = "INVENTORY_V2_INDEX_DEPLOY_APPROVAL";
const URI_ENV = "MONGODB_URI";

const OPTION_KEYS = Object.freeze([
  "unique",
  "sparse",
  "expireAfterSeconds",
  "partialFilterExpression",
  "collation",
  "hidden",
]);

export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}

export function parseDeployArgs(argv = []) {
  const parsed = { confirm: false, allowProduction: false, help: false };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--confirm") {
      parsed.confirm = true;
      continue;
    }
    if (arg === "--allow-production") {
      parsed.allowProduction = true;
      continue;
    }
    // Never echo an unknown argument: it might contain a secret.
    throw new CliError("Unknown argument. Use --help for supported options.");
  }

  return parsed;
}

export function detectProductionMarkers(env = process.env) {
  const markers = PRODUCTION_MARKERS.filter((name) => {
    const value = String(env?.[name] ?? "").trim().toLowerCase();
    return PRODUCTION_VALUES.has(value);
  });

  // Fail closed when the operator has not explicitly classified the target.
  const deployEnv = String(env?.INVENTORY_V2_INDEX_DEPLOY_ENV ?? "")
    .trim()
    .toLowerCase();
  if (markers.length === 0 && !NON_PRODUCTION_VALUES.has(deployEnv)) {
    markers.push("INVENTORY_V2_INDEX_DEPLOY_ENV (unset or unrecognized)");
  }

  return markers;
}

export function assertProductionApproval({
  env = process.env,
  allowProduction = false,
} = {}) {
  const markers = detectProductionMarkers(env);
  if (markers.length === 0) {
    return { production: false, markers: [] };
  }

  if (!allowProduction) {
    throw new CliError(
      `Refusing production index deployment (markers: ${markers.join(
        ", "
      )}). Re-run with --allow-production only after approval.`
    );
  }

  const approval = String(env?.[APPROVAL_ENV] ?? "").trim();
  if (approval === "") {
    throw new CliError(
      `Refusing production index deployment without a non-empty ${APPROVAL_ENV} change/ticket reference.`
    );
  }

  return { production: true, markers };
}

function defaultIndexName(key) {
  return Object.entries(key ?? {})
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");
}

function normalizeOptions(options) {
  const normalized = {};
  for (const key of OPTION_KEYS) {
    if (options?.[key] !== undefined && options[key] !== false) {
      normalized[key] = options[key];
    }
  }
  return normalized;
}

/**
 * Group the validated plan by collection. The returned structure is the only
 * input the deployment loop accepts.
 */
export function buildExpectedPlan(plan = V2_INDEX_PLAN) {
  assertV2IndexPlan(plan);

  const grouped = new Map();
  for (const entry of plan) {
    if (!grouped.has(entry.collection)) grouped.set(entry.collection, []);
    grouped.get(entry.collection).push({
      name: entry.name || defaultIndexName(entry.key),
      key: entry.key,
      options: normalizeOptions(entry.options),
      classification: entry.classification,
    });
  }

  return Object.freeze(
    [...grouped.entries()].map(([collection, indexes]) =>
      Object.freeze({
        collection,
        indexes: Object.freeze(indexes.map((index) => Object.freeze(index))),
      })
    )
  );
}

async function listCollectionIndexes(collection) {
  try {
    const indexes = await collection.indexes();
    return Array.isArray(indexes) ? indexes : [];
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") {
      return [];
    }
    throw error;
  }
}

/**
 * Compare the live indexes for one collection against the expected plan.
 * Returns issues instead of throwing so the caller can print a full report.
 */
export async function inspectCollectionIndexes(collection, expectedIndexes) {
  const actual = await listCollectionIndexes(collection);
  const issues = [];

  const actualByName = new Map();
  const actualByKey = new Map();
  for (const index of actual) {
    if (!index || index.name === "_id_") continue;
    actualByName.set(index.name, index);
    const signature = indexKeySignature(index.key);
    if (actualByKey.has(signature)) {
      issues.push({
        type: "DUPLICATE_KEY",
        collection: collection.collectionName,
        index: index.name,
        detail: `same key already present as ${actualByKey.get(signature).name}`,
      });
    } else {
      actualByKey.set(signature, index);
    }
  }

  const expectedNames = new Set();
  for (const expected of expectedIndexes) {
    expectedNames.add(expected.name);
    const actualIndex = actualByName.get(expected.name);

    if (!actualIndex) {
      issues.push({
        type: "MISSING",
        collection: collection.collectionName,
        index: expected.name,
        key: expected.key,
        options: expected.options,
      });
      continue;
    }

    if (indexKeySignature(actualIndex.key) !== indexKeySignature(expected.key)) {
      issues.push({
        type: "KEY_MISMATCH",
        collection: collection.collectionName,
        index: expected.name,
        expectedKey: expected.key,
        actualKey: actualIndex.key,
      });
      continue;
    }

    const actualOptions = normalizeOptions(actualIndex);
    if (!isDeepStrictEqual(actualOptions, expected.options)) {
      issues.push({
        type: "OPTIONS_MISMATCH",
        collection: collection.collectionName,
        index: expected.name,
        expectedOptions: expected.options,
        actualOptions,
      });
    }
  }

  for (const expected of expectedIndexes) {
    const sameKey = actualByKey.get(indexKeySignature(expected.key));
    if (sameKey && sameKey.name !== expected.name) {
      issues.push({
        type: "NAME_MISMATCH",
        collection: collection.collectionName,
        expected: expected.name,
        actual: sameKey.name,
      });
    }
  }

  for (const index of actual) {
    if (!index || index.name === "_id_") continue;
    if (!expectedNames.has(index.name)) {
      issues.push({
        type: "UNEXPECTED",
        collection: collection.collectionName,
        index: index.name,
        key: index.key,
        options: normalizeOptions(index),
      });
    }
  }

  return issues;
}

export async function inspectPlan(connection, groupedPlan) {
  const issues = [];
  let expectedCount = 0;

  for (const entry of groupedPlan) {
    expectedCount += entry.indexes.length;
    const collection = connection.collection(entry.collection);
    const collectionIssues = await inspectCollectionIndexes(
      collection,
      entry.indexes
    );
    issues.push(...collectionIssues);
  }

  return { issues, expectedCount };
}

function printIndexPlan(groupedPlan, log) {
  const total = groupedPlan.reduce(
    (sum, entry) => sum + entry.indexes.length,
    0
  );
  log(
    `[inventory-v2:indexes] Expected: ${total} indexes across ${groupedPlan.length} collections (plus automatic _id_).`
  );
  for (const entry of groupedPlan) {
    log(`[inventory-v2:indexes] ${entry.collection}`);
    for (const index of entry.indexes) {
      log(
        `  - ${index.name} key=${JSON.stringify(
          index.key
        )} options=${JSON.stringify(index.options)} classification=${
          index.classification
        }`
      );
    }
  }
}

function printIndexIssues(issues, write) {
  for (const issue of issues) {
    const parts = [`[inventory-v2:indexes] ${issue.type} ${issue.collection}`];
    if (issue.index) parts.push(issue.index);
    if (issue.expected) parts.push(`expected=${issue.expected}`);
    if (issue.actual) parts.push(`actual=${issue.actual}`);
    if (issue.key) parts.push(`key=${JSON.stringify(issue.key)}`);
    if (issue.expectedKey) {
      parts.push(`expectedKey=${JSON.stringify(issue.expectedKey)}`);
    }
    if (issue.actualKey) {
      parts.push(`actualKey=${JSON.stringify(issue.actualKey)}`);
    }
    if (issue.options) {
      parts.push(`options=${JSON.stringify(issue.options)}`);
    }
    if (issue.expectedOptions) {
      parts.push(`expectedOptions=${JSON.stringify(issue.expectedOptions)}`);
    }
    if (issue.actualOptions) {
      parts.push(`actualOptions=${JSON.stringify(issue.actualOptions)}`);
    }
    if (issue.detail) parts.push(issue.detail);
    write(parts.join(" "));
  }
}

function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[redacted-mongodb-uri]")
    .replace(/\/\/[^/@\s]+@/g, "//[redacted-credentials]@");
}

function safeErrorMessage(error) {
  if (error instanceof CliError) return error.message;
  if (error instanceof Error) {
    return redactSensitiveText(error.message || error.name);
  }
  return "Inventory V2 index deployment failed";
}

export function databaseNameFromMongoUri(uri) {
  const value = String(uri ?? "");
  const withoutQuery = value.replace(/[?#].*$/, "");
  const afterScheme = withoutQuery.replace(/^mongodb(?:\+srv)?:\/\//i, "");
  const firstSlash = afterScheme.indexOf("/");
  if (firstSlash === -1) return "";
  const rawPath = afterScheme.slice(firstSlash + 1).replace(/\/+$/, "");
  if (rawPath === "") return "";
  try {
    return decodeURIComponent(rawPath);
  } catch {
    throw new CliError(`${URI_ENV} contains an invalid database path`);
  }
}

export async function connectV2IndexDatabase(env = process.env) {
  const uri = String(env?.[URI_ENV] ?? "").trim();
  if (uri === "") {
    throw new CliError(`${URI_ENV} is required for index deployment`);
  }
  const connection = mongoose.createConnection(uri, {
    autoIndex: false,
    autoCreate: false,
    bufferCommands: false,
    maxPoolSize: 5,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 30000,
  });
  connection.on("error", () => {});
  return connection.asPromise();
}

export async function disconnectV2IndexDatabase(connection) {
  if (connection) await connection.close().catch(() => {});
}

export async function runIndexDeploymentCli(
  argv = process.argv.slice(2),
  deps = {}
) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const connect = deps.connect ?? connectV2IndexDatabase;
  const disconnect = deps.disconnect ?? disconnectV2IndexDatabase;
  const plan = deps.plan ?? V2_INDEX_PLAN;

  let parsed;
  try {
    parsed = parseDeployArgs(argv);
  } catch (caught) {
    error(`[inventory-v2:indexes] ${safeErrorMessage(caught)}`);
    return 1;
  }

  if (parsed.help) {
    log(USAGE);
    return 0;
  }

  if (!parsed.confirm) {
    error(
      "[inventory-v2:indexes] Refusing to write without --confirm. No database operation was performed."
    );
    return 1;
  }

  try {
    assertProductionApproval({ env, allowProduction: parsed.allowProduction });
    if (String(env?.[URI_ENV] ?? "").trim() === "") {
      throw new CliError(`${URI_ENV} is required for index deployment`);
    }
  } catch (caught) {
    error(`[inventory-v2:indexes] ${safeErrorMessage(caught)}`);
    error("[inventory-v2:indexes] No database operation was performed.");
    return 1;
  }

  let groupedPlan;
  try {
    groupedPlan = buildExpectedPlan(plan);
  } catch (caught) {
    error(`[inventory-v2:indexes] ${safeErrorMessage(caught)}`);
    error("[inventory-v2:indexes] No database operation was performed.");
    return 1;
  }

  let connection = null;
  try {
    connection = await connect(env);
    if (!connection) {
      throw new CliError("Index deployment connection was not established");
    }

    printIndexPlan(groupedPlan, log);

    const preflight = await inspectPlan(connection, groupedPlan);
    const blocking = preflight.issues.filter(
      (issue) => issue.type !== "MISSING"
    );
    if (blocking.length > 0) {
      printIndexIssues(preflight.issues, error);
      error(
        "[inventory-v2:indexes] Refusing to apply indexes while unexpected or mismatched indexes exist. No indexes were created or removed."
      );
      return 1;
    }

    const missing = preflight.issues.filter(
      (issue) => issue.type === "MISSING"
    );
    if (missing.length === 0) {
      log(
        `[inventory-v2:indexes] Verified ${preflight.expectedCount} existing indexes; no writes needed.`
      );
      return 0;
    }

    const collectionsWithMissing = new Set(
      missing.map((issue) => issue.collection)
    );
    log(
      `[inventory-v2:indexes] Applying ${missing.length} missing indexes across ${collectionsWithMissing.size} collections. Existing indexes are not removed.`
    );

    for (const entry of groupedPlan) {
      if (!collectionsWithMissing.has(entry.collection)) continue;
      const missingNames = new Set(
        missing
          .filter((issue) => issue.collection === entry.collection)
          .map((issue) => issue.index)
      );
      const specs = entry.indexes
        .filter((index) => missingNames.has(index.name))
        .map((index) => ({ key: index.key, name: index.name, ...index.options }));
      log(`[inventory-v2:indexes] createIndexes ${entry.collection}`);
      await connection.collection(entry.collection).createIndexes(specs);
    }

    const postflight = await inspectPlan(connection, groupedPlan);
    if (postflight.issues.length > 0) {
      printIndexIssues(postflight.issues, error);
      error(
        "[inventory-v2:indexes] Verification failed. No indexes were removed; review the issues before re-running."
      );
      return 1;
    }

    log(
      `[inventory-v2:indexes] Verified ${postflight.expectedCount} indexes across ${groupedPlan.length} collections. No indexes were removed.`
    );
    return 0;
  } catch (caught) {
    error(`[inventory-v2:indexes] ${safeErrorMessage(caught)}`);
    error(
      "[inventory-v2:indexes] Deployment stopped. No indexes were removed; a partial create may require review."
    );
    return 1;
  } finally {
    if (connection) await disconnect(connection).catch(() => {});
  }
}

export { V2_COLLECTIONS, V2_INDEX_PLAN };

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const exitCode = await runIndexDeploymentCli();
  process.exitCode = exitCode;
}
