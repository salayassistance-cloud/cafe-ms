#!/usr/bin/env node
// Explicit Hotel-only index deployment command.
//
// Usage (after configuring ROOM_MONGODB_URI for the intended Hotel database):
//   node --env-file=.env.local scripts/hotel-deploy-indexes.mjs --confirm
//
// This command never uses the POS connection, the POS MONGODB_URI, or the POS
// sync-indexes script. It only calls createIndexes() on Hotel models. It never
// calls syncIndexes(), dropIndex(), or dropIndexes(). Unexpected or mismatched
// indexes are reported and cause a nonzero exit; they are never removed.
//
// Production environments require --allow-production and a non-empty
// HOTEL_INDEX_DEPLOY_APPROVAL change/ticket reference. The approval value is
// checked but never printed.

import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  HOTEL_DB_NAME,
  HOTEL_MONGODB_URI_ENV,
} from "../lib/hotel/constants.js";
import { requireHotelMongoUri } from "../lib/hotel/config.js";
import { redactSensitiveText } from "../lib/hotel/errors.js";
import {
  connectToHotelDatabase,
  disconnectHotelDatabase,
} from "../lib/hotel/db/connection.js";
import { getHotelAuditLogModel } from "../lib/hotel/models/hotelAuditLog.js";
import { getHotelPaymentModel } from "../lib/hotel/models/hotelPayment.js";
import { getHotelUserModel } from "../lib/hotel/models/hotelUser.js";
import { getGuestModel } from "../lib/hotel/models/guest.js";
import { getReservationModel } from "../lib/hotel/models/reservation.js";
import { getRoomModel } from "../lib/hotel/models/room.js";
import { getRoomBookingLockModel } from "../lib/hotel/models/roomBookingLock.js";
import { getStayModel } from "../lib/hotel/models/stay.js";
import { getRoomTypeModel } from "../lib/hotel/models/roomType.js";

const USAGE = `Usage:
  node --env-file=.env.local scripts/hotel-deploy-indexes.mjs --confirm

Options:
  --confirm            Required acknowledgement that this writes indexes.
  --allow-production   Required when a production environment marker is set.
  --help               Show this help.

Production also requires a non-empty HOTEL_INDEX_DEPLOY_APPROVAL change or
ticket reference. The command never prints the URI, credentials, or approval
value. It creates only missing Hotel schema indexes and never drops indexes.`;

const PRODUCTION_VALUES = new Set(["production", "prod", "live"]);
const NON_PRODUCTION_VALUES = new Set([
  "development",
  "dev",
  "local",
  "test",
  "disposable",
]);
const PRODUCTION_MARKERS = Object.freeze([
  "HOTEL_INDEX_DEPLOY_ENV",
  "NODE_ENV",
  "VERCEL_ENV",
  "CONTEXT",
  "DEPLOY_ENV",
  "ENVIRONMENT",
  "APP_ENV",
]);
const APPROVAL_ENV = "HOTEL_INDEX_DEPLOY_APPROVAL";

const OPTION_KEYS = Object.freeze([
  "unique",
  "sparse",
  "expireAfterSeconds",
  "partialFilterExpression",
  "collation",
  "hidden",
]);

export const HOTEL_INDEX_MODELS = Object.freeze([
  { label: "HotelAuditLog", getModel: getHotelAuditLogModel },
  { label: "HotelPayment", getModel: getHotelPaymentModel },
  { label: "HotelUser", getModel: getHotelUserModel },
  { label: "Guest", getModel: getGuestModel },
  { label: "Reservation", getModel: getReservationModel },
  { label: "Room", getModel: getRoomModel },
  { label: "RoomBookingLock", getModel: getRoomBookingLockModel },
  { label: "Stay", getModel: getStayModel },
  { label: "RoomType", getModel: getRoomTypeModel },
]);

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}

export function parseIndexDeployArgs(argv = []) {
  const parsed = {
    confirm: false,
    allowProduction: false,
    help: false,
  };

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
  const deployEnv = String(env?.HOTEL_INDEX_DEPLOY_ENV ?? "")
    .trim()
    .toLowerCase();
  if (markers.length === 0 && !NON_PRODUCTION_VALUES.has(deployEnv)) {
    markers.push("HOTEL_INDEX_DEPLOY_ENV (unset or unrecognized)");
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
    throw new CliError(
      `${HOTEL_MONGODB_URI_ENV} contains an invalid database path`
    );
  }
}

export function assertHotelDatabaseTarget(uri) {
  const databaseName = databaseNameFromMongoUri(uri);
  if (databaseName !== "" && databaseName !== HOTEL_DB_NAME) {
    throw new CliError(
      `${HOTEL_MONGODB_URI_ENV} must target the ${HOTEL_DB_NAME} database`
    );
  }
  return databaseName || HOTEL_DB_NAME;
}

function defaultIndexName(key) {
  const entries = Object.entries(key ?? {});
  if (entries.length === 0) {
    throw new Error("A schema index must define at least one key");
  }
  return entries.map(([field, direction]) => `${field}_${direction}`).join("_");
}

function indexKeySignature(key) {
  return Object.entries(key ?? {})
    .map(([field, direction]) => `${field}:${direction}`)
    .join("|");
}

function normalizeIndexOptions(options) {
  const normalized = {};
  for (const key of OPTION_KEYS) {
    if (options?.[key] !== undefined && options[key] !== false) {
      normalized[key] = options[key];
    }
  }
  return normalized;
}

export function buildIndexPlan(connection, modelFactories = HOTEL_INDEX_MODELS) {
  if (!connection?.models) {
    throw new Error("A dedicated Hotel Mongoose connection is required");
  }

  const seenCollections = new Set();
  return modelFactories.map(({ label, getModel }) => {
    const model = getModel(connection);
    const collection = model?.collection?.name;
    if (!collection) {
      throw new Error(`Hotel model ${label} has no collection name`);
    }
    if (seenCollections.has(collection)) {
      throw new Error(`Duplicate Hotel collection in index plan: ${collection}`);
    }
    seenCollections.add(collection);

    const schemaIndexes = model?.schema?.indexes?.();
    if (!Array.isArray(schemaIndexes)) {
      throw new Error(`Hotel model ${label} does not expose schema indexes`);
    }

    const seenNames = new Set();
    const indexes = schemaIndexes.map(([key, options = {}]) => {
      const name = options.name || defaultIndexName(key);
      if (seenNames.has(name)) {
        throw new Error(`Duplicate schema index name: ${collection}.${name}`);
      }
      seenNames.add(name);
      return {
        name,
        key,
        options: normalizeIndexOptions(options),
      };
    });

    return { label, model, collection, indexes };
  });
}

async function listCollectionIndexes(model) {
  try {
    const indexes = await model.collection.indexes();
    return Array.isArray(indexes) ? indexes : [];
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") {
      return [];
    }
    throw error;
  }
}

export async function inspectIndexPlan(plan) {
  const issues = [];
  let expectedCount = 0;

  for (const entry of plan) {
    const actual = await listCollectionIndexes(entry.model);
    const actualByName = new Map();
    const actualByKey = new Map();

    for (const index of actual) {
      if (!index || index.name === "_id_") continue;
      actualByName.set(index.name, index);
      const signature = indexKeySignature(index.key);
      if (actualByKey.has(signature)) {
        issues.push({
          type: "DUPLICATE_KEY",
          collection: entry.collection,
          index: index.name,
          detail: `same key already present as ${actualByKey.get(signature).name}`,
        });
      } else {
        actualByKey.set(signature, index);
      }
    }

    const expectedNames = new Set();
    for (const expected of entry.indexes) {
      expectedCount += 1;
      expectedNames.add(expected.name);
      const actualIndex = actualByName.get(expected.name);

      if (!actualIndex) {
        issues.push({
          type: "MISSING",
          collection: entry.collection,
          index: expected.name,
          key: expected.key,
          options: expected.options,
        });
        continue;
      }

      if (indexKeySignature(actualIndex.key) !== indexKeySignature(expected.key)) {
        issues.push({
          type: "KEY_MISMATCH",
          collection: entry.collection,
          index: expected.name,
          expectedKey: expected.key,
          actualKey: actualIndex.key,
        });
        continue;
      }

      const actualOptions = normalizeIndexOptions(actualIndex);
      if (!isDeepStrictEqual(actualOptions, expected.options)) {
        issues.push({
          type: "OPTIONS_MISMATCH",
          collection: entry.collection,
          index: expected.name,
          expectedOptions: expected.options,
          actualOptions,
        });
      }
    }

    for (const expected of entry.indexes) {
      const sameKey = actualByKey.get(indexKeySignature(expected.key));
      if (sameKey && sameKey.name !== expected.name) {
        issues.push({
          type: "NAME_MISMATCH",
          collection: entry.collection,
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
          collection: entry.collection,
          index: index.name,
          key: index.key,
          options: normalizeIndexOptions(index),
        });
      }
    }
  }

  return { issues, expectedCount };
}

function printIndexPlan(plan, log) {
  const total = plan.reduce((sum, entry) => sum + entry.indexes.length, 0);
  log(`[hotel:indexes] Target database: ${HOTEL_DB_NAME}`);
  log(
    `[hotel:indexes] Expected: ${total} schema indexes across ${plan.length} collections (plus automatic _id_).`
  );
  for (const entry of plan) {
    log(`[hotel:indexes] ${entry.collection} (${entry.label})`);
    for (const index of entry.indexes) {
      log(
        `  - ${index.name} key=${JSON.stringify(index.key)} options=${JSON.stringify(
          index.options
        )}`
      );
    }
  }
}

function printIndexIssues(issues, write) {
  for (const issue of issues) {
    const parts = [`[hotel:indexes] ${issue.type} ${issue.collection}`];
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

function safeErrorMessage(error) {
  if (error instanceof CliError) return error.message;
  if (error instanceof Error) {
    return redactSensitiveText(error.message || error.name);
  }
  return "Hotel index deployment failed";
}

export async function runIndexDeploymentCli(
  argv = process.argv.slice(2),
  deps = {}
) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const connect = deps.connect ?? connectToHotelDatabase;
  const disconnect = deps.disconnect ?? disconnectHotelDatabase;
  const modelFactories = deps.modelFactories ?? HOTEL_INDEX_MODELS;

  let parsed;
  try {
    parsed = parseIndexDeployArgs(argv);
  } catch (caught) {
    error(`[hotel:indexes] ${safeErrorMessage(caught)}`);
    return 1;
  }

  if (parsed.help) {
    log(USAGE);
    return 0;
  }

  if (!parsed.confirm) {
    error(
      "[hotel:indexes] Refusing to write without --confirm. No database operation was performed."
    );
    return 1;
  }

  try {
    assertProductionApproval({
      env,
      allowProduction: parsed.allowProduction,
    });
    const uri = requireHotelMongoUri(env);
    assertHotelDatabaseTarget(uri);
  } catch (caught) {
    error(`[hotel:indexes] ${safeErrorMessage(caught)}`);
    error(
      "[hotel:indexes] No database operation was performed."
    );
    return 1;
  }

  let connection = null;
  try {
    connection = await connect();
    if (!connection || connection.name !== HOTEL_DB_NAME) {
      throw new CliError(
        `Connected database is not ${HOTEL_DB_NAME}; refusing to deploy indexes.`
      );
    }

    const plan = buildIndexPlan(connection, modelFactories);
    printIndexPlan(plan, log);

    const preflight = await inspectIndexPlan(plan);
    const blocking = preflight.issues.filter(
      (issue) => issue.type !== "MISSING"
    );
    if (blocking.length > 0) {
      printIndexIssues(preflight.issues, error);
      error(
        "[hotel:indexes] Refusing to apply indexes while unexpected or mismatched indexes exist. No indexes were created or dropped."
      );
      return 1;
    }

    const missing = preflight.issues.filter(
      (issue) => issue.type === "MISSING"
    );
    if (missing.length === 0) {
      log(
        `[hotel:indexes] Verified ${preflight.expectedCount} existing schema indexes; no writes needed.`
      );
      return 0;
    }

    const collectionsWithMissing = new Set(
      missing.map((issue) => issue.collection)
    );
    log(
      `[hotel:indexes] Applying ${missing.length} missing indexes across ${collectionsWithMissing.size} collections. Existing indexes are not dropped.`
    );

    for (const entry of plan) {
      if (!collectionsWithMissing.has(entry.collection)) continue;
      log(`[hotel:indexes] createIndexes ${entry.collection}`);
      await entry.model.createIndexes();
    }

    const postflight = await inspectIndexPlan(plan);
    if (postflight.issues.length > 0) {
      printIndexIssues(postflight.issues, error);
      error(
        "[hotel:indexes] Verification failed. No indexes were dropped; review the issues before re-running."
      );
      return 1;
    }

    log(
      `[hotel:indexes] Verified ${postflight.expectedCount} schema indexes across ${plan.length} collections. No indexes were dropped.`
    );
    return 0;
  } catch (caught) {
    error(`[hotel:indexes] ${safeErrorMessage(caught)}`);
    error(
      "[hotel:indexes] Deployment stopped. No indexes were dropped; a partial create may require review."
    );
    return 1;
  } finally {
    if (connection) {
      await disconnect().catch(() => {});
    }
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const exitCode = await runIndexDeploymentCli();
  process.exitCode = exitCode;
}
