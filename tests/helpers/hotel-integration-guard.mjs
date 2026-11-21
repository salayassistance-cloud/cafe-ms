// Hotel disposable-MongoDB integration-test safety guard — DB-free.
//
// This module never opens a MongoDB connection, never reads an environment
// file, never writes to process.env, and never logs a URI, credential, or
// environment value. Callers pass an explicit environment object and an
// already-connected Mongoose connection.
//
// Safety model:
// - Exact opt-in values and a loopback-only, standalone, non-27017 URI.
// - The live connection is re-verified by host, port, database name, and
//   MongoDB `hello` topology/writability on every safety-critical step.
// - The target must contain no non-system collections before this run claims
//   ownership by writing one marker document.
// - Cleanup is a separate explicit opt-in, requires the same live target, the
//   exact ownership marker, and a namespace-allowlist check before and after
//   data deletion. It never drops a database or collection.

import crypto from "node:crypto";

export const HOTEL_INTEGRATION_ENV = Object.freeze({
  OPT_IN: "HOTEL_INTEGRATION_TESTS",
  TARGET_CLASS: "HOTEL_INDEX_DEPLOY_ENV",
  TARGET_ACK: "HOTEL_TEST_TARGET_ACK",
  MONGO_URI: "HOTEL_TEST_MONGODB_URI",
  CLEANUP_ACK: "HOTEL_TEST_ALLOW_CLEANUP",
});

export const HOTEL_INTEGRATION_VALUES = Object.freeze({
  OPT_IN: "1",
  TARGET_CLASS: "disposable",
  TARGET_ACK: "I_CONFIRM_DISPOSABLE_MONGODB",
  CLEANUP_ACK: "I_CONFIRM_DELETE_DISPOSABLE_MONGODB_DATA",
});

export const HOTEL_INTEGRATION_DB_NAME = "bono_hotel";

export const HOTEL_INTEGRATION_ALLOWED_HOSTS = Object.freeze([
  "127.0.0.1",
  "::1",
]);

export const HOTEL_INTEGRATION_COLLECTIONS = Object.freeze([
  "hotel_users",
  "hotel_sessions",
  "hotel_audit_logs",
  "roomtypes",
  "hotel_rooms",
  "hotel_guests",
  "hotel_reservations",
  "hotel_stays",
  "hotel_payments",
  "hotel_room_booking_locks",
]);

export const HOTEL_INTEGRATION_OWNERSHIP_COLLECTION =
  "hotel_integration_run_ownership";

export const HOTEL_INTEGRATION_OWNERSHIP_ID =
  "bono-hotel-disposable-run-owner";

const CLEANUP_ALLOWED_COLLECTIONS = new Set([
  ...HOTEL_INTEGRATION_COLLECTIONS,
  HOTEL_INTEGRATION_OWNERSHIP_COLLECTION,
]);

const INHERITED_ENVIRONMENT_VARIABLES = Object.freeze([
  "ROOM_MONGODB_URI",
  "MONGODB_URI",
  "MONGO_URI",
  "AUTH_SECRET",
  "HOTEL_SESSION_SECRET",
  "HOTEL_PROVISION_MANAGER_PASSWORD",
  "HOTEL_PROVISION_MANAGER_PIN",
  "HOTEL_PROVISION_PIN",
]);

const PRODUCTION_MARKER_VARIABLES = Object.freeze([
  "VERCEL_ENV",
  "CONTEXT",
  "DEPLOY_ENV",
  "ENVIRONMENT",
  "APP_ENV",
]);

const ALLOWED_QUERY_PARAMETERS = Object.freeze([
  "authSource",
  "directConnection",
]);

const GLOBAL_CONNECTION_KEY = "__bonoHotelMongooseConnection";
const OWNERSHIP_KIND = "bono-hotel-disposable-integration-run";
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const DEFAULT_MONGODB_PORT = 27017;
const MIN_SUPPORTED_WIRE_VERSION = 8;
const LEGACY_HELLO_MAX_WIRE_VERSION = 9;
const RUN_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

export class HotelIntegrationGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HotelIntegrationGuardError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new HotelIntegrationGuardError(code, message);
}

function envValue(env, name) {
  const value = env?.[name];
  return value == null ? "" : String(value);
}

function requireExactEnv(env, name, expected) {
  if (envValue(env, name) !== expected) {
    fail(
      "ENV_FLAG",
      `Hotel integration environment variable ${name} must equal the required exact value`
    );
  }
}

function normalizeHost(host) {
  return String(host ?? "")
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase();
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object") {
    fail("TARGET_INVALID", "A complete disposable target identity is required");
  }

  const host = normalizeHost(target.host);
  if (!HOTEL_INTEGRATION_ALLOWED_HOSTS.includes(host)) {
    fail(
      "TARGET_INVALID",
      "The disposable target host must be a literal loopback address"
    );
  }

  const port = Number(target.port);
  if (
    !Number.isInteger(port) ||
    port < MIN_PORT ||
    port > MAX_PORT ||
    port === DEFAULT_MONGODB_PORT
  ) {
    fail(
      "TARGET_INVALID",
      "The disposable target port must be an explicit non-default port"
    );
  }

  if (target.databaseName !== HOTEL_INTEGRATION_DB_NAME) {
    fail(
      "TARGET_INVALID",
      `The disposable target database must be exactly ${HOTEL_INTEGRATION_DB_NAME}`
    );
  }

  return Object.freeze({
    host,
    port,
    databaseName: HOTEL_INTEGRATION_DB_NAME,
  });
}

function sameTarget(left, right) {
  return (
    left?.host === right?.host &&
    Number(left?.port) === Number(right?.port) &&
    left?.databaseName === right?.databaseName
  );
}

function collectionEntry(entry) {
  if (typeof entry === "string") {
    return { name: entry, type: null };
  }
  if (entry && typeof entry.name === "string") {
    return {
      name: entry.name,
      type: typeof entry.type === "string" ? entry.type : null,
    };
  }
  return null;
}

function isSystemNamespace(name) {
  return name.startsWith("system.");
}

function isUnexpectedCleanupEntry(entry) {
  if (isSystemNamespace(entry.name)) return false;
  if (!CLEANUP_ALLOWED_COLLECTIONS.has(entry.name)) return true;
  return entry.type != null && entry.type !== "collection";
}

async function listCollectionEntries(
  connection,
  unverifiedCode = "TARGET_FRESHNESS_UNVERIFIED"
) {
  const failUnverified = (message) => fail(unverifiedCode, message);

  if (!connection?.db || typeof connection.db.listCollections !== "function") {
    failUnverified("The disposable target collections could not be inspected");
  }

  let cursor;
  try {
    cursor = connection.db.listCollections({}, { nameOnly: true });
  } catch {
    failUnverified("The disposable target collections could not be inspected");
  }

  try {
    const rawEntries =
      cursor && typeof cursor.toArray === "function"
        ? await cursor.toArray()
        : await cursor;

    if (!Array.isArray(rawEntries)) {
      failUnverified("The disposable target collection list was not readable");
    }

    const entries = rawEntries.map(collectionEntry);
    if (entries.some((entry) => entry === null || entry.name === "")) {
      failUnverified(
        "The disposable target collection list contained an invalid entry"
      );
    }

    return entries;
  } catch (error) {
    if (error instanceof HotelIntegrationGuardError) throw error;
    failUnverified("The disposable target collections could not be inspected");
  }
}

async function listCollectionNames(connection) {
  const entries = await listCollectionEntries(connection);
  return entries.map((entry) => entry.name);
}

async function assertCleanupCollectionAllowlist(connection) {
  const entries = await listCollectionEntries(
    connection,
    "CLEANUP_TARGET_UNVERIFIED"
  );
  const unexpected = entries.find(isUnexpectedCleanupEntry);

  if (unexpected) {
    fail(
      "CLEANUP_UNEXPECTED_COLLECTION",
      `Cleanup refused because the disposable target contains unexpected collection or view ${unexpected.name}`
    );
  }

  return entries.map((entry) => entry.name);
}

function assertOwnershipShape(ownership) {
  if (!ownership || typeof ownership !== "object") {
    fail(
      "OWNERSHIP_INVALID",
      "A disposable-target ownership record is required"
    );
  }

  if (
    ownership.collectionName !== HOTEL_INTEGRATION_OWNERSHIP_COLLECTION ||
    typeof ownership.runId !== "string" ||
    !RUN_ID_RE.test(ownership.runId) ||
    typeof ownership.tokenHash !== "string" ||
    !TOKEN_HASH_RE.test(ownership.tokenHash) ||
    !Number.isInteger(Number(ownership.pid)) ||
    Number(ownership.pid) <= 0
  ) {
    fail(
      "OWNERSHIP_INVALID",
      "The disposable-target ownership record is incomplete"
    );
  }

  return {
    collectionName: HOTEL_INTEGRATION_OWNERSHIP_COLLECTION,
    runId: ownership.runId,
    tokenHash: ownership.tokenHash,
    pid: Number(ownership.pid),
    target: normalizeTarget(ownership.target),
  };
}

export function parseHotelIntegrationMongoUri(rawUri) {
  if (
    typeof rawUri !== "string" ||
    rawUri.length === 0 ||
    rawUri.trim() !== rawUri ||
    /\s/.test(rawUri)
  ) {
    fail(
      "URI_INVALID",
      "The test MongoDB URI must be a non-empty string without whitespace"
    );
  }

  if (!rawUri.startsWith("mongodb://")) {
    fail(
      "URI_SCHEME",
      "The test MongoDB URI must use the direct mongodb scheme"
    );
  }

  let parsed;
  try {
    parsed = new URL(rawUri);
  } catch {
    fail("URI_INVALID", "The test MongoDB URI could not be parsed");
  }

  if (parsed.protocol !== "mongodb:") {
    fail(
      "URI_SCHEME",
      "The test MongoDB URI must use the direct mongodb scheme"
    );
  }

  if (rawUri.includes("#") || parsed.hash) {
    fail("URI_QUERY", "The test MongoDB URI must not contain a fragment");
  }

  // Node's URL parser rejects a comma-separated multi-host authority. Keep this
  // explicit check so a future parser change cannot silently permit one.
  if (parsed.host.includes(",")) {
    fail(
      "URI_HOST",
      "The test MongoDB URI must contain exactly one loopback host"
    );
  }

  const host = normalizeHost(parsed.hostname);
  if (!HOTEL_INTEGRATION_ALLOWED_HOSTS.includes(host)) {
    fail(
      "URI_HOST",
      "The test MongoDB URI host must be the literal 127.0.0.1 or ::1"
    );
  }

  if (!parsed.port) {
    fail(
      "URI_PORT",
      "The test MongoDB URI must include an explicit non-default port"
    );
  }

  const port = Number(parsed.port);
  if (
    !Number.isInteger(port) ||
    port < MIN_PORT ||
    port > MAX_PORT ||
    port === DEFAULT_MONGODB_PORT
  ) {
    fail(
      "URI_PORT",
      "The test MongoDB URI port must be an explicit non-default port"
    );
  }

  if (parsed.pathname !== `/${HOTEL_INTEGRATION_DB_NAME}`) {
    fail(
      "URI_DATABASE",
      `The test MongoDB URI database path must be exactly /${HOTEL_INTEGRATION_DB_NAME}`
    );
  }

  if (rawUri.includes("?") && !parsed.search) {
    fail(
      "URI_QUERY",
      "The test MongoDB URI query string must not be empty"
    );
  }

  if (parsed.search) {
    const params = new URLSearchParams(parsed.search);
    const seen = new Set();

    for (const [name, value] of params) {
      if (!ALLOWED_QUERY_PARAMETERS.includes(name) || seen.has(name)) {
        fail(
          "URI_QUERY",
          "The test MongoDB URI contains an unsupported or duplicate query parameter"
        );
      }
      seen.add(name);

      if (name === "authSource" && value.trim() === "") {
        fail(
          "URI_QUERY",
          "The test MongoDB URI authSource query parameter must not be empty"
        );
      }
      if (name === "directConnection" && value !== "true") {
        fail(
          "URI_QUERY",
          "The test MongoDB URI directConnection query parameter must be exactly true"
        );
      }
    }
  }

  return Object.freeze({
    host,
    port,
    databaseName: HOTEL_INTEGRATION_DB_NAME,
  });
}

export function assertNoInheritedHotelEnvironment(env = process.env) {
  for (const name of INHERITED_ENVIRONMENT_VARIABLES) {
    if (envValue(env, name).trim() !== "") {
      fail(
        "ENV_INHERITED",
        `Refusing inherited Hotel/POS environment variable ${name}`
      );
    }
  }

  const nodeEnv = envValue(env, "NODE_ENV");
  if (nodeEnv !== "" && nodeEnv !== "test") {
    fail(
      "ENV_PRODUCTION",
      "NODE_ENV must be unset or exactly test for Hotel integration tests"
    );
  }

  for (const name of PRODUCTION_MARKER_VARIABLES) {
    if (envValue(env, name).trim() !== "") {
      fail(
        "ENV_PRODUCTION",
        `Refusing non-empty deployment environment variable ${name}`
      );
    }
  }
}

export function readHotelIntegrationConfig(env = process.env) {
  assertNoInheritedHotelEnvironment(env);

  requireExactEnv(
    env,
    HOTEL_INTEGRATION_ENV.OPT_IN,
    HOTEL_INTEGRATION_VALUES.OPT_IN
  );
  requireExactEnv(
    env,
    HOTEL_INTEGRATION_ENV.TARGET_CLASS,
    HOTEL_INTEGRATION_VALUES.TARGET_CLASS
  );
  requireExactEnv(
    env,
    HOTEL_INTEGRATION_ENV.TARGET_ACK,
    HOTEL_INTEGRATION_VALUES.TARGET_ACK
  );

  const mongoUri = env?.[HOTEL_INTEGRATION_ENV.MONGO_URI];
  if (typeof mongoUri !== "string" || mongoUri.trim() === "") {
    fail(
      "ENV_URI",
      `Hotel integration tests require ${HOTEL_INTEGRATION_ENV.MONGO_URI}`
    );
  }

  return {
    mongoUri,
    target: parseHotelIntegrationMongoUri(mongoUri),
  };
}

export function assertNoCachedHotelConnection(globalObject = globalThis) {
  if (globalObject?.[GLOBAL_CONNECTION_KEY]) {
    fail(
      "CACHE_PRESENT",
      "A cached Hotel connection already exists; use a fresh test process"
    );
  }
}

// `hello` is available from MongoDB 4.2. Some 4.2/4.4 responses use the legacy
// `ismaster` marker instead of `isWritablePrimary`; newer servers must report
// the modern field. A present modern field always wins.
function isWritableHello(hello) {
  if (Object.prototype.hasOwnProperty.call(hello, "isWritablePrimary")) {
    return hello.isWritablePrimary === true;
  }

  const maxWireVersion = Number(hello.maxWireVersion);
  return (
    hello.ismaster === true &&
    Number.isInteger(maxWireVersion) &&
    maxWireVersion >= MIN_SUPPORTED_WIRE_VERSION &&
    maxWireVersion <= LEGACY_HELLO_MAX_WIRE_VERSION
  );
}

export async function verifyHotelIntegrationConnection({
  connection,
  expectedTarget,
} = {}) {
  const target = normalizeTarget(expectedTarget);

  if (!connection || connection.readyState !== 1) {
    fail(
      "TARGET_NOT_CONNECTED",
      "The disposable MongoDB connection is not connected"
    );
  }

  if (connection.name !== HOTEL_INTEGRATION_DB_NAME) {
    fail(
      "TARGET_DATABASE",
      `The connected Hotel database name must be exactly ${HOTEL_INTEGRATION_DB_NAME}`
    );
  }

  if (
    !connection.db ||
    connection.db.databaseName !== HOTEL_INTEGRATION_DB_NAME
  ) {
    fail(
      "TARGET_DATABASE",
      `The connected MongoDB database must be exactly ${HOTEL_INTEGRATION_DB_NAME}`
    );
  }

  if (normalizeHost(connection.host) !== target.host) {
    fail(
      "TARGET_HOST",
      "The connected MongoDB host does not match the approved loopback host"
    );
  }

  if (Number(connection.port) !== target.port) {
    fail(
      "TARGET_PORT",
      "The connected MongoDB port does not match the approved disposable port"
    );
  }

  if (typeof connection.db.command !== "function") {
    fail(
      "TARGET_HELLO",
      "The disposable MongoDB topology could not be verified"
    );
  }

  let hello;
  try {
    hello = await connection.db.command({ hello: 1 });
  } catch {
    fail(
      "TARGET_HELLO",
      "The disposable MongoDB topology could not be verified"
    );
  }

  if (!hello || Number(hello.ok) !== 1) {
    fail(
      "TARGET_HELLO",
      "The disposable MongoDB topology could not be verified"
    );
  }

  if (
    hello.setName != null ||
    hello.setVersion != null ||
    hello.secondary === true ||
    hello.arbiterOnly === true ||
    hello.hidden === true
  ) {
    fail(
      "TARGET_REPLICA_SET",
      "Replica-set MongoDB targets are not permitted for Hotel integration tests"
    );
  }

  if (hello.msg != null) {
    const msg = String(hello.msg).toLowerCase();
    if (msg === "isdbgrid") {
      fail(
        "TARGET_MONGOS",
        "Mongos and sharded MongoDB targets are not permitted for Hotel integration tests"
      );
    }
    if (msg !== "") {
      fail(
        "TARGET_NOT_STANDALONE",
        "The MongoDB target did not identify itself as a standalone server"
      );
    }
  }

  if (hello.serviceId != null || hello.loadBalanced === true) {
    fail(
      "TARGET_NOT_STANDALONE",
      "Load-balanced MongoDB targets are not permitted for Hotel integration tests"
    );
  }

  for (const members of [hello.hosts, hello.passives, hello.arbiters]) {
    if (Array.isArray(members) && members.length > 0) {
      fail(
        "TARGET_REPLICA_SET",
        "Replica-set MongoDB targets are not permitted for Hotel integration tests"
      );
    }
  }

  const writable = isWritableHello(hello);
  if (!writable || hello.readOnly === true) {
    fail(
      "TARGET_NOT_WRITABLE",
      "The MongoDB target must be a writable primary or standalone server"
    );
  }

  return Object.freeze({
    target,
    writable: true,
  });
}

export async function assertFreshHotelIntegrationTarget({
  connection,
  expectedTarget,
} = {}) {
  await verifyHotelIntegrationConnection({ connection, expectedTarget });

  const names = await listCollectionNames(connection);
  const unexpected = names.filter((name) => !name.startsWith("system."));

  if (unexpected.length > 0) {
    fail(
      "TARGET_NOT_FRESH",
      `The disposable MongoDB target is not fresh; found collection ${unexpected[0]}`
    );
  }

  return Object.freeze({
    target: normalizeTarget(expectedTarget),
    fresh: true,
  });
}

export async function claimHotelIntegrationTarget({
  connection,
  expectedTarget,
  runId = crypto.randomUUID(),
  now = Date.now(),
} = {}) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    fail(
      "OWNERSHIP_INVALID",
      "The disposable-target run identifier is invalid"
    );
  }

  const createdAt = new Date(now);
  if (Number.isNaN(createdAt.getTime())) {
    fail(
      "OWNERSHIP_INVALID",
      "The disposable-target ownership timestamp is invalid"
    );
  }

  const target = normalizeTarget(expectedTarget);
  await assertFreshHotelIntegrationTarget({ connection, expectedTarget: target });

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const marker = {
    _id: HOTEL_INTEGRATION_OWNERSHIP_ID,
    runId,
    kind: OWNERSHIP_KIND,
    tokenHash,
    target: {
      host: target.host,
      port: target.port,
      databaseName: target.databaseName,
    },
    pid: process.pid,
    createdAt,
  };

  let result;
  try {
    result = await connection.db
      .collection(HOTEL_INTEGRATION_OWNERSHIP_COLLECTION)
      .insertOne(marker);
  } catch {
    fail(
      "OWNERSHIP_CLAIM_FAILED",
      "The disposable-target ownership marker could not be created"
    );
  }

  if (
    !result ||
    result.acknowledged !== true ||
    String(result.insertedId) !== HOTEL_INTEGRATION_OWNERSHIP_ID
  ) {
    fail(
      "OWNERSHIP_CLAIM_FAILED",
      "The disposable-target ownership marker was not acknowledged"
    );
  }

  return Object.freeze({
    collectionName: HOTEL_INTEGRATION_OWNERSHIP_COLLECTION,
    runId,
    tokenHash,
    pid: process.pid,
    target,
  });
}

export async function verifyHotelIntegrationOwnership({
  connection,
  expectedTarget,
  ownership,
} = {}) {
  const target = normalizeTarget(expectedTarget);
  const record = assertOwnershipShape(ownership);

  if (!sameTarget(record.target, target)) {
    fail(
      "OWNERSHIP_MISMATCH",
      "The ownership record does not match the approved disposable target"
    );
  }

  await verifyHotelIntegrationConnection({
    connection,
    expectedTarget: target,
  });

  const filter = {
    _id: HOTEL_INTEGRATION_OWNERSHIP_ID,
    runId: record.runId,
    kind: OWNERSHIP_KIND,
    tokenHash: record.tokenHash,
    pid: record.pid,
    "target.host": target.host,
    "target.port": target.port,
    "target.databaseName": target.databaseName,
  };

  let marker;
  try {
    marker = await connection.db
      .collection(HOTEL_INTEGRATION_OWNERSHIP_COLLECTION)
      .findOne(filter);
  } catch {
    fail(
      "OWNERSHIP_MISMATCH",
      "The disposable-target ownership marker could not be verified"
    );
  }

  if (!marker) {
    fail(
      "OWNERSHIP_MISMATCH",
      "The disposable-target ownership marker does not match this run"
    );
  }

  return Object.freeze({
    runId: record.runId,
    target,
    owned: true,
  });
}

export async function cleanupHotelIntegrationTarget({
  connection,
  expectedTarget,
  ownership,
  env = process.env,
} = {}) {
  if (
    envValue(env, HOTEL_INTEGRATION_ENV.CLEANUP_ACK) !==
    HOTEL_INTEGRATION_VALUES.CLEANUP_ACK
  ) {
    fail(
      "CLEANUP_NOT_ALLOWED",
      `Cleanup requires ${HOTEL_INTEGRATION_ENV.CLEANUP_ACK} to equal the exact confirmation value`
    );
  }

  const config = readHotelIntegrationConfig(env);
  const target = normalizeTarget(expectedTarget);
  if (!sameTarget(config.target, target)) {
    fail(
      "CLEANUP_TARGET_MISMATCH",
      "The cleanup environment does not describe the approved disposable target"
    );
  }

  const record = assertOwnershipShape(ownership);
  if (!sameTarget(record.target, target)) {
    fail(
      "CLEANUP_TARGET_MISMATCH",
      "The cleanup ownership record does not describe the approved disposable target"
    );
  }

  await verifyHotelIntegrationOwnership({
    connection,
    expectedTarget: target,
    ownership: record,
  });
  await assertCleanupCollectionAllowlist(connection);

  const deletedCollections = [];

  for (const collectionName of HOTEL_INTEGRATION_COLLECTIONS) {
    let result;
    try {
      result = await connection.db.collection(collectionName).deleteMany({});
    } catch {
      fail(
        "CLEANUP_FAILED",
        `Cleanup stopped while deleting Hotel collection ${collectionName}`
      );
    }

    if (!result || result.acknowledged !== true) {
      fail(
        "CLEANUP_FAILED",
        `Cleanup could not confirm deletion for Hotel collection ${collectionName}`
      );
    }

    deletedCollections.push(collectionName);
  }

  // Re-verify the live target, the ownership marker, and the namespace
  // allowlist after the Hotel deletes. The marker is deleted last, so a partial
  // cleanup never loses the evidence needed to identify the run.
  await verifyHotelIntegrationOwnership({
    connection,
    expectedTarget: target,
    ownership: record,
  });
  await assertCleanupCollectionAllowlist(connection);

  let markerResult;
  try {
    markerResult = await connection.db
      .collection(HOTEL_INTEGRATION_OWNERSHIP_COLLECTION)
      .deleteOne({
        _id: HOTEL_INTEGRATION_OWNERSHIP_ID,
        runId: record.runId,
        kind: OWNERSHIP_KIND,
        tokenHash: record.tokenHash,
        pid: record.pid,
        "target.host": target.host,
        "target.port": target.port,
        "target.databaseName": target.databaseName,
      });
  } catch {
    fail(
      "CLEANUP_FAILED",
      "Cleanup could not remove the disposable-target ownership marker"
    );
  }

  if (!markerResult || markerResult.deletedCount !== 1) {
    fail(
      "CLEANUP_FAILED",
      "Cleanup did not remove exactly one disposable-target ownership marker"
    );
  }

  return Object.freeze({
    deletedCollections: Object.freeze(deletedCollections),
    ownershipReleased: true,
  });
}
