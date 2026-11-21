// Hotel disposable-MongoDB integration harness helpers — DB-free.
//
// This module never opens a MongoDB connection, never reads an environment
// file, and never writes a URI, credential, session token, or raw document to
// output. The integration test owns the connection lifecycle; this module only
// validates opt-in state, maps the approved test URI into the Hotel runtime
// configuration, builds run-scoped fixture names, inspects index readiness
// read-only, and reads the ownership marker for the separate cleanup command.
//
// Safety rules enforced here:
// - The guard module remains authoritative for target, ownership, and cleanup.
// - The runtime mapping never falls back to POS or generic MongoDB variables.
// - Index readiness is a read-only poll. This module never creates an index.
// - Cleanup requires both an explicit CLI confirmation and the guard's exact
//   environment confirmation value.

import crypto from "node:crypto";

import {
  HOTEL_INTEGRATION_COLLECTIONS,
  HOTEL_INTEGRATION_DB_NAME,
  HOTEL_INTEGRATION_ENV,
  HOTEL_INTEGRATION_OWNERSHIP_COLLECTION,
  HOTEL_INTEGRATION_OWNERSHIP_ID,
  HOTEL_INTEGRATION_VALUES,
  HotelIntegrationGuardError,
  parseHotelIntegrationMongoUri,
  readHotelIntegrationConfig,
  verifyHotelIntegrationConnection,
} from "./hotel-integration-guard.mjs";
import { redactSensitiveText } from "../../lib/hotel/errors.js";

export const HOTEL_INTEGRATION_HARNESS_ENV = Object.freeze({
  WAIT_FOR_INDEXES: "HOTEL_INTEGRATION_WAIT_FOR_INDEXES",
});

export const HOTEL_INTEGRATION_HARNESS_VALUES = Object.freeze({
  WAIT_FOR_INDEXES: "1",
});

export const HOTEL_INTEGRATION_INDEX_WAIT_TIMEOUT_MS = 60_000;
export const HOTEL_INTEGRATION_INDEX_WAIT_INTERVAL_MS = 500;
export const HOTEL_INTEGRATION_SESSION_SECRET_MIN_LENGTH = 32;
export const HOTEL_INTEGRATION_RUN_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

const ROOM_URI_ENV = "ROOM_MONGODB_URI";
const SESSION_SECRET_ENV = "HOTEL_SESSION_SECRET";
const CLEANUP_CONFIRM_ARG = "--confirm";
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;
const COOKIE_VALUE_RE =
  /(__Host-bono_hotel_session|x-hotel-csrf-token)(\s*[:=]\s*)[^\s,;"'}]+/gi;

export class HotelIntegrationHarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HotelIntegrationHarnessError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new HotelIntegrationHarnessError(code, message);
}

function envValue(env, name) {
  const value = env?.[name];
  return value == null ? "" : String(value);
}

function normalizeHost(host) {
  return String(host ?? "")
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase();
}

function targetMatches(left, right) {
  return (
    normalizeHost(left?.host) === normalizeHost(right?.host) &&
    Number(left?.port) === Number(right?.port) &&
    String(left?.databaseName ?? "") === String(right?.databaseName ?? "")
  );
}

function safeRunId(runId) {
  return typeof runId === "string" && HOTEL_INTEGRATION_RUN_ID_RE.test(runId);
}

// A harness invocation is "requested" when any test-only flag is present. If
// none is present, the integration file reports skipped tests and never opens a
// connection. If even one flag is present, every required flag must validate.
export function inspectHotelIntegrationOptIn(env = process.env) {
  const names = [
    HOTEL_INTEGRATION_ENV.OPT_IN,
    HOTEL_INTEGRATION_ENV.TARGET_CLASS,
    HOTEL_INTEGRATION_ENV.TARGET_ACK,
    HOTEL_INTEGRATION_ENV.MONGO_URI,
  ];
  const present = names.some((name) => envValue(env, name).trim() !== "");

  if (!present) {
    return Object.freeze({
      requested: false,
      reason:
        "Hotel integration tests are opt-in and no test-only environment flags are present",
    });
  }

  return Object.freeze({ requested: true, reason: null });
}

export function readHotelIntegrationIndexWaitOption(env = process.env) {
  const raw = envValue(env, HOTEL_INTEGRATION_HARNESS_ENV.WAIT_FOR_INDEXES).trim();
  if (raw === "") return false;
  if (raw === HOTEL_INTEGRATION_HARNESS_VALUES.WAIT_FOR_INDEXES) return true;

  fail(
    "INDEX_WAIT_FLAG",
    `Hotel integration environment variable ${HOTEL_INTEGRATION_HARNESS_ENV.WAIT_FOR_INDEXES} must be 1 or unset`
  );
}

export function readHotelIntegrationHarnessOptions(env = process.env) {
  const config = readHotelIntegrationConfig(env);
  return Object.freeze({
    config,
    waitForIndexes: readHotelIntegrationIndexWaitOption(env),
  });
}

export function readHotelIntegrationCleanupConfig(env = process.env) {
  if (
    envValue(env, HOTEL_INTEGRATION_ENV.CLEANUP_ACK) !==
    HOTEL_INTEGRATION_VALUES.CLEANUP_ACK
  ) {
    fail(
      "CLEANUP_NOT_ALLOWED",
      `Cleanup requires ${HOTEL_INTEGRATION_ENV.CLEANUP_ACK} to equal the exact confirmation value`
    );
  }

  return readHotelIntegrationConfig(env);
}

export function parseHotelIntegrationCleanupArgs(argv = []) {
  if (!Array.isArray(argv)) {
    fail("CLEANUP_ARGS", "Cleanup arguments must be an array");
  }

  let confirm = false;
  for (const arg of argv) {
    if (arg === CLEANUP_CONFIRM_ARG) {
      if (confirm) {
        fail("CLEANUP_ARGS", "Cleanup accepts --confirm exactly once");
      }
      confirm = true;
      continue;
    }

    // Never echo an unknown argument: it might contain a credential.
    fail("CLEANUP_ARGS", "Unknown cleanup argument; only --confirm is supported");
  }

  if (!confirm) {
    fail(
      "CLEANUP_CONFIRM_REQUIRED",
      "Cleanup requires the explicit --confirm argument"
    );
  }

  return Object.freeze({ confirm: true });
}

export function assertHotelIntegrationCleanupRequest({
  argv = [],
  env = process.env,
} = {}) {
  const args = parseHotelIntegrationCleanupArgs(argv);
  const config = readHotelIntegrationCleanupConfig(env);
  return Object.freeze({ ...args, config });
}

export function buildHotelIntegrationRuntimeEnvironment({
  config,
  sessionSecret = null,
} = {}) {
  if (!config || typeof config.mongoUri !== "string") {
    fail("RUNTIME_CONFIG", "An approved Hotel integration config is required");
  }

  // Re-parse with the guard so a caller cannot supply a hand-built config that
  // bypasses the target rules. The runtime mapping is always the exact test URI.
  const parsed = parseHotelIntegrationMongoUri(config.mongoUri);
  if (!targetMatches(parsed, config.target)) {
    fail(
      "RUNTIME_CONFIG",
      "The Hotel integration config target does not match its MongoDB URI"
    );
  }

  const secret =
    sessionSecret == null
      ? crypto.randomBytes(48).toString("base64url")
      : sessionSecret;

  if (
    typeof secret !== "string" ||
    secret.length < HOTEL_INTEGRATION_SESSION_SECRET_MIN_LENGTH ||
    secret.length > 512 ||
    /\s/.test(secret)
  ) {
    fail(
      "RUNTIME_SESSION_SECRET",
      "The test-only Hotel session secret is invalid"
    );
  }

  return Object.freeze({
    [ROOM_URI_ENV]: config.mongoUri,
    [SESSION_SECRET_ENV]: secret,
  });
}

// Explicitly map the approved test URI and a generated test-only session
// secret into the provided environment object. The original values are restored
// by the returned idempotent function. No other Hotel/POS variable is read or
// written. Callers must validate opt-in before calling this function.
export function installHotelIntegrationRuntimeEnvironment({
  config,
  env = process.env,
  sessionSecret = null,
  includeSessionSecret = true,
} = {}) {
  if (!env || typeof env !== "object") {
    fail("RUNTIME_ENV", "A mutable environment object is required");
  }

  const validated = readHotelIntegrationConfig(env);
  if (validated.mongoUri !== config?.mongoUri) {
    fail(
      "RUNTIME_CONFIG",
      "The runtime config does not match the validated Hotel integration environment"
    );
  }

  const runtime = buildHotelIntegrationRuntimeEnvironment({
    config: validated,
    sessionSecret: includeSessionSecret ? sessionSecret : null,
  });

  const keys = [ROOM_URI_ENV];
  if (includeSessionSecret) keys.push(SESSION_SECRET_ENV);

  const previous = new Map();
  for (const key of keys) {
    previous.set(key, {
      present: Object.prototype.hasOwnProperty.call(env, key),
      value: env[key],
    });
  }

  env[ROOM_URI_ENV] = runtime[ROOM_URI_ENV];
  if (includeSessionSecret) {
    env[SESSION_SECRET_ENV] = runtime[SESSION_SECRET_ENV];
  }

  let restored = false;
  return Object.freeze({
    installed: true,
    restore() {
      if (restored) return;
      restored = true;
      for (const key of keys) {
        const entry = previous.get(key);
        if (entry.present) {
          env[key] = entry.value;
        } else {
          delete env[key];
        }
      }
    },
  });
}

export function createHotelIntegrationRunId({
  now = Date.now(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    fail("RUN_ID", "The integration run timestamp is invalid");
  }

  let random;
  try {
    random = randomBytes(12);
  } catch {
    fail("RUN_ID", "The integration run identifier could not be generated");
  }

  const runId = `hit-${Math.floor(timestamp).toString(36)}-${Buffer.from(
    random
  ).toString("hex")}`;

  if (!safeRunId(runId)) {
    fail("RUN_ID", "The integration run identifier is invalid");
  }

  return runId;
}

function fixtureTag(runId) {
  if (!safeRunId(runId)) {
    fail("RUN_ID", "A valid integration run identifier is required");
  }

  const compact = runId.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const tag = compact.slice(-10);
  if (tag.length >= 6) return tag;

  return crypto
    .createHash("sha256")
    .update(runId)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
}

function fixtureKind(value, fallback = "FIX") {
  const clean = String(value ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
  return (clean || fallback).slice(0, 8);
}

function fixtureDigits(runId, length = 12) {
  const hash = crypto.createHash("sha256").update(runId).digest("hex");
  let digits = "";
  for (const character of hash) {
    digits += (Number.parseInt(character, 16) % 10).toString();
    if (digits.length >= length) break;
  }
  return digits.padEnd(length, "0");
}

// All fixture values are scoped to the run and satisfy the Hotel field rules.
// Two runs never share a room-type code, room number, email, or idempotency key.
export function createHotelIntegrationFixtures(runId) {
  const tag = fixtureTag(runId);
  const digits = fixtureDigits(runId);

  function roomTypeCode(kind = "STD") {
    return `IT${tag}${fixtureKind(kind)}`.slice(0, 30);
  }

  function roomNumber(index = 1) {
    const suffix = String(Math.abs(Number(index) || 1)).padStart(2, "0");
    return `IT${tag}${suffix}`.slice(0, 20);
  }

  function guestEmail(kind = "GUEST", index = 1) {
    return `it.${tag.toLowerCase()}.${fixtureKind(kind).toLowerCase()}.${Math.abs(
      Number(index) || 1
    )}@example.test`;
  }

  function guestPhone(index = 1) {
    return `+2519${digits.slice(0, 7)}${Math.abs(Number(index) || 1) % 10}`;
  }

  function firstName(kind = "GUEST") {
    return `IT${tag}${fixtureKind(kind)}`.slice(0, 80);
  }

  function lastName(index = 1) {
    return `Guest${Math.abs(Number(index) || 1)}`.slice(0, 80);
  }

  function idempotencyKey(kind = "PAY", index = 1) {
    return `it.${tag}.${fixtureKind(kind).toLowerCase()}.${Math.abs(
      Number(index) || 1
    )}`;
  }

  function note(kind = "SCENARIO") {
    return `integration ${tag} ${fixtureKind(kind)}`.trim();
  }

  return Object.freeze({
    runId,
    runTag: tag,
    roomTypeCode,
    roomNumber,
    guestEmail,
    guestPhone,
    firstName,
    lastName,
    idempotencyKey,
    note,
  });
}

export function safeHotelIntegrationText(value, { secrets = [] } = {}) {
  let text = typeof value === "string" ? value : String(value ?? "");
  // Redact a Bearer token before the generic key/value pass, which can consume
  // the word "Bearer" and leave the token itself behind.
  text = text.replace(
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    "Bearer [redacted]"
  );
  text = redactSensitiveText(text);

  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    text = text.split(secret).join("[redacted]");
  }

  text = text.replace(
    /scrypt\$[^\s"'<>]+/gi,
    "[redacted-password-hash]"
  );
  text = text.replace(/\b[A-Fa-f0-9]{64}\b/g, "[redacted-hash]");
  text = text.replace(/\b[A-Za-z0-9_-]{43}\b/g, "[redacted-token]");
  text = text.replace(COOKIE_VALUE_RE, (_match, name, separator) => {
    return `${name}${separator}[redacted]`;
  });

  return text;
}

export function safeHotelIntegrationError(error, { secrets = [] } = {}) {
  const rawCode = typeof error?.code === "string" ? error.code : "";
  const code = /^[A-Z0-9_]{1,80}$/.test(rawCode)
    ? rawCode
    : "INTEGRATION_ERROR";
  const message = safeHotelIntegrationText(
    error?.message ?? "Unknown integration failure",
    { secrets }
  );

  return Object.freeze({
    name: "HotelIntegrationError",
    code,
    message,
  });
}

export function formatHotelIntegrationError(error, options = {}) {
  const safe = safeHotelIntegrationError(error, options);
  return `${safe.code}: ${safe.message}`;
}

function defaultIndexName(key) {
  const entries = Object.entries(key ?? {});
  if (entries.length === 0) {
    fail("INDEX_PLAN", "A Hotel schema index must define at least one key");
  }
  return entries.map(([field, direction]) => `${field}_${direction}`).join("_");
}

function indexKeySignature(key) {
  return Object.entries(key ?? {})
    .map(([field, direction]) => `${field}:${direction}`)
    .join("|");
}

function expectedIndexesForModel(model) {
  const collection = model?.collection?.name;
  if (!collection) {
    fail("INDEX_MODEL", "A Hotel index model is missing its collection name");
  }

  const schemaIndexes = model?.schema?.indexes?.();
  if (!Array.isArray(schemaIndexes)) {
    fail("INDEX_MODEL", "A Hotel index model does not expose schema indexes");
  }

  return schemaIndexes.map(([key, options = {}]) => ({
    name: options.name || defaultIndexName(key),
    key,
    unique: options.unique === true,
    expireAfterSeconds:
      options.expireAfterSeconds === undefined
        ? null
        : Number(options.expireAfterSeconds),
  }));
}

async function readModelIndexes(model) {
  if (typeof model?.collection?.indexes !== "function") {
    fail("INDEX_MODEL", "A Hotel index model cannot list collection indexes");
  }

  try {
    const indexes = await model.collection.indexes();
    if (!Array.isArray(indexes)) {
      fail("INDEX_READ", "The Hotel collection index list was not readable");
    }
    return indexes;
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") {
      return [];
    }
    if (error instanceof HotelIntegrationHarnessError) throw error;
    fail("INDEX_READ", "The Hotel collection indexes could not be inspected");
  }
}

// Read-only readiness check. It only lists existing collection indexes and
// never mutates index definitions. Issues contain collection and index names
// only, never raw index documents or values.
export async function inspectHotelIndexReadiness({ connection, models } = {}) {
  if (!connection || !Array.isArray(models) || models.length === 0) {
    fail(
      "INDEX_MODELS",
      "A connected Hotel target and at least one model are required"
    );
  }

  const missing = [];
  const issues = [];
  const checkedCollections = [];
  let expectedCount = 0;

  for (const model of models) {
    const collection = model?.collection?.name;
    if (!collection) {
      fail("INDEX_MODEL", "A Hotel index model is missing its collection name");
    }
    checkedCollections.push(collection);

    const expected = expectedIndexesForModel(model);
    expectedCount += expected.length;
    const actual = await readModelIndexes(model);
    const actualByName = new Map();

    for (const index of actual) {
      if (!index || index.name === "_id_") continue;
      if (actualByName.has(index.name)) {
        issues.push({
          type: "DUPLICATE_NAME",
          collection,
          index: index.name,
        });
        continue;
      }
      actualByName.set(index.name, index);
    }

    const expectedNames = new Set();
    for (const wanted of expected) {
      expectedNames.add(wanted.name);
      const found = actualByName.get(wanted.name);

      if (!found) {
        missing.push({ collection, index: wanted.name });
        continue;
      }

      if (indexKeySignature(found.key) !== indexKeySignature(wanted.key)) {
        issues.push({
          type: "KEY_MISMATCH",
          collection,
          index: wanted.name,
        });
        continue;
      }

      if ((found.unique === true) !== wanted.unique) {
        issues.push({
          type: "UNIQUE_MISMATCH",
          collection,
          index: wanted.name,
        });
        continue;
      }

      const foundTtl =
        found.expireAfterSeconds === undefined
          ? null
          : Number(found.expireAfterSeconds);
      if (foundTtl !== wanted.expireAfterSeconds) {
        issues.push({
          type: "TTL_MISMATCH",
          collection,
          index: wanted.name,
        });
      }
    }

    for (const [name] of actualByName) {
      if (!expectedNames.has(name)) {
        issues.push({ type: "UNEXPECTED", collection, index: name });
      }
    }
  }

  return Object.freeze({
    ready: missing.length === 0 && issues.length === 0,
    expectedCount,
    checkedCollections: Object.freeze(checkedCollections),
    missing: Object.freeze(missing),
    issues: Object.freeze(issues),
  });
}

// Optional read-only wait for a separately approved index deployment. The
// harness never invokes that deployment itself. A timeout leaves the ownership
// marker and all test data in place for the separate cleanup command.
export async function waitForHotelIndexes({
  connection,
  models,
  timeoutMs = HOTEL_INTEGRATION_INDEX_WAIT_TIMEOUT_MS,
  intervalMs = HOTEL_INTEGRATION_INDEX_WAIT_INTERVAL_MS,
  now = () => Date.now(),
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    fail("INDEX_WAIT_OPTIONS", "Index wait timing options are invalid");
  }

  const deadline = now() + timeoutMs;

  for (;;) {
    const readiness = await inspectHotelIndexReadiness({ connection, models });
    if (readiness.ready) return readiness;

    if (now() >= deadline) {
      fail(
        "INDEX_WAIT_TIMEOUT",
        `Index readiness was not confirmed within ${timeoutMs}ms; ${readiness.missing.length} index(es) are missing and ${readiness.issues.length} issue(s) remain`
      );
    }

    await sleep(intervalMs);
  }
}

// Read the single ownership marker for the separate cleanup command. The guard
// verifies the marker again inside cleanupHotelIntegrationTarget; this function
// only narrows the stored document to safe scalar fields and refuses an
// unreadable or mismatched marker before any cleanup is attempted.
export async function readHotelIntegrationOwnershipMarker({
  connection,
  expectedTarget,
} = {}) {
  await verifyHotelIntegrationConnection({ connection, expectedTarget });

  let marker;
  try {
    marker = await connection.db
      .collection(HOTEL_INTEGRATION_OWNERSHIP_COLLECTION)
      .findOne({ _id: HOTEL_INTEGRATION_OWNERSHIP_ID });
  } catch {
    fail(
      "OWNERSHIP_READ_FAILED",
      "The disposable-target ownership marker could not be read"
    );
  }

  if (!marker) {
    fail(
      "OWNERSHIP_NOT_FOUND",
      "The disposable-target ownership marker does not exist"
    );
  }

  const target = marker.target;
  if (
    !target ||
    !targetMatches(target, expectedTarget) ||
    String(target.databaseName ?? "") !== HOTEL_INTEGRATION_DB_NAME
  ) {
    fail(
      "OWNERSHIP_MISMATCH",
      "The disposable-target ownership marker does not match the approved target"
    );
  }

  if (
    !safeRunId(marker.runId) ||
    typeof marker.tokenHash !== "string" ||
    !TOKEN_HASH_RE.test(marker.tokenHash) ||
    !Number.isInteger(Number(marker.pid)) ||
    Number(marker.pid) <= 0
  ) {
    fail(
      "OWNERSHIP_INVALID",
      "The disposable-target ownership marker is incomplete"
    );
  }

  return Object.freeze({
    collectionName: HOTEL_INTEGRATION_OWNERSHIP_COLLECTION,
    runId: marker.runId,
    tokenHash: marker.tokenHash,
    pid: Number(marker.pid),
    target: Object.freeze({
      host: normalizeHost(target.host),
      port: Number(target.port),
      databaseName: target.databaseName,
    }),
  });
}

// Exported for tests that assert the harness never widens the guard's namespace
// allowlist. The list is intentionally the same frozen guard constant.
export const HOTEL_INTEGRATION_HARNESS_COLLECTIONS =
  HOTEL_INTEGRATION_COLLECTIONS;

export { HotelIntegrationGuardError };
