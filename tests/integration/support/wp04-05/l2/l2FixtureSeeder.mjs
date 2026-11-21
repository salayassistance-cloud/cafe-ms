// WP04-05 L2 — disposable V1 fixture seeder (TEST-ONLY).
//
// The seeder is the only module in the L2 tooling that is allowed to write. It
// uses the separately scoped `readWrite` fixture-writer account and refuses to
// run unless every target check passes *before* the first insert:
//
//   * the URI is a single loopback mongodb:// target on the dedicated L2 port;
//   * the URI database equals the requested database;
//   * the database name carries the `bono_recovery_wp04_05_` prefix;
//   * the authenticated account has exactly one role: readWrite on that DB;
//   * the target database contains no non-system collection yet;
//   * only the four allowlisted V1 collections are written.
//
// It never reads `.env`, never prints a URI or credential, never creates an
// index, and never touches any other database.

import mongoose from "mongoose";

import {
  COLLECTIONS,
  EXPECTED_RULES,
  WINDOW,
  expectedCollectionCounts,
  fixtureDocuments,
} from "./l2FixturePlan.mjs";
import { L2_DB_PREFIX, L2_PORT } from "./l2Cluster.mjs";

export const FIXTURE_WRITER_ROLES = Object.freeze(["readWrite"]);

const ALLOWED_COLLECTIONS = new Set(Object.values(COLLECTIONS));

export class FixtureSeederError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "FixtureSeederError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FixtureSeederError(code, message);
}

function isLoopback(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("::ffff:127.")) return true;
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part)) &&
    Number(parts[0]) === 127 && parts.every((part) => Number(part) <= 255);
}

export function assertDisposableTarget(uri, dbName) {
  if (typeof dbName !== "string" || !dbName.startsWith(L2_DB_PREFIX)) {
    fail("DB_NAMESPACE_REFUSED", `database must start with ${L2_DB_PREFIX}`);
  }
  if (typeof uri !== "string" || uri.length === 0) fail("URI_MISSING", "URI is required");
  if (/\s/.test(uri)) fail("URI_AMBIGUOUS", "URI must not contain whitespace");
  // Reject multi-host URIs before URL parsing: commas make the authority invalid
  // for the WHATWG URL parser, so check the raw authority first.
  const authority = uri.slice(uri.indexOf("://") + 3).split(/[/?#]/, 1)[0];
  if (authority.includes(",")) fail("URI_MULTI_HOST_REFUSED", "multiple hosts are refused");
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    fail("URI_MALFORMED", "URI is malformed");
  }
  if (parsed.protocol !== "mongodb:") fail("URI_SCHEME_REFUSED", "only mongodb:// is allowed");
  if (!isLoopback(parsed.hostname)) fail("URI_NON_LOOPBACK_REFUSED", "loopback only");
  const port = Number(parsed.port);
  if (port !== L2_PORT) {
    fail("URI_PORT_REFUSED", `only the dedicated L2 port ${L2_PORT} is allowed`);
  }
  if (parsed.pathname !== `/${dbName}`) {
    fail("URI_DB_MISMATCH", "URI database must equal the disposable database name");
  }
  return Object.freeze({ port, dbName });
}

async function authenticatedRoles(connection) {
  const status = await connection.db.admin().command({ connectionStatus: 1 });
  const roles = status?.authInfo?.authenticatedUserRoles;
  if (!Array.isArray(roles)) fail("AUTH_STATUS_UNAVAILABLE", "authentication status unavailable");
  return roles.map((role) => ({ role: role.role, db: role.db }));
}

function assertWriterScope(roles, dbName) {
  const allowed =
    roles.length === 1 && roles[0].role === FIXTURE_WRITER_ROLES[0] && roles[0].db === dbName;
  if (!allowed) {
    fail(
      "WRITER_SCOPE_REFUSED",
      "fixture writer must have exactly readWrite on the disposable database",
    );
  }
}

async function openWriter(uri, dbName) {
  const connection = await mongoose.createConnection(uri, {
    autoIndex: false,
    autoCreate: false,
    bufferCommands: false,
    maxPoolSize: 2,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
  }).asPromise();
  try {
    if (connection.db.databaseName !== dbName) {
      fail("CONNECTION_DB_MISMATCH", "connected database is not the disposable database");
    }
    assertWriterScope(await authenticatedRoles(connection), dbName);
    return connection;
  } catch (error) {
    await connection.close();
    throw error;
  }
}

async function listUserCollections(connection) {
  const infos = await connection.db
    .listCollections({}, { nameOnly: true })
    .toArray();
  return infos.map((info) => info.name).filter((name) => !name.startsWith("system."));
}

/**
 * Seed the D01–D10 fixture set into a brand-new disposable database.
 *
 * @param {{ uri: string, dbName: string, plan?: ReturnType<typeof fixtureDocuments> }} options
 * @returns {Promise<{ dbName: string, counts: Object, collections: Array<string>, rules: Array<string>, window: Object }>}
 */
export async function seedFixtures(options) {
  const { uri, dbName } = options ?? {};
  assertDisposableTarget(uri, dbName);
  const plan = options.plan ?? fixtureDocuments();
  const expected = expectedCollectionCounts();

  const connection = await openWriter(uri, dbName);
  try {
    const existing = await listUserCollections(connection);
    if (existing.length > 0) {
      fail("DATABASE_NOT_EMPTY", "refusing to seed a database that already has collections");
    }

    const writes = [
      [COLLECTIONS.orders, plan.orders],
      [COLLECTIONS.reservations, plan.reservations],
      [COLLECTIONS.movements, plan.movements],
      [COLLECTIONS.inventory, plan.inventory],
    ];
    for (const [name, documents] of writes) {
      if (!ALLOWED_COLLECTIONS.has(name)) fail("COLLECTION_REFUSED", `collection ${name} is not allowlisted`);
      if (!Array.isArray(documents)) fail("INVALID_PLAN", `plan entry for ${name} must be an array`);
      if (documents.length === 0) continue;
      await connection.db.collection(name).insertMany(documents, { ordered: true });
    }

    const counts = {};
    for (const name of ALLOWED_COLLECTIONS) {
      counts[name] = await connection.db.collection(name).countDocuments({});
    }
    for (const [name, expectedCount] of Object.entries(expected)) {
      if (counts[name] !== expectedCount) {
        fail("SEED_COUNT_MISMATCH", `collection ${name} has ${counts[name]} of ${expectedCount}`);
      }
    }
    const collections = await listUserCollections(connection);
    for (const name of collections) {
      if (!ALLOWED_COLLECTIONS.has(name)) fail("UNEXPECTED_COLLECTION", `unexpected collection ${name}`);
    }

    return Object.freeze({
      dbName,
      counts: Object.freeze(counts),
      collections: Object.freeze(collections.sort()),
      rules: EXPECTED_RULES,
      window: WINDOW,
    });
  } finally {
    await connection.close();
  }
}

/**
 * Drop only the four fixture collections so a test can re-seed deterministically.
 * Never drops the database and never touches another namespace.
 *
 * @param {{ uri: string, dbName: string }} options
 */
export async function resetFixtureCollections(options) {
  const { uri, dbName } = options ?? {};
  assertDisposableTarget(uri, dbName);
  const connection = await openWriter(uri, dbName);
  try {
    const existing = await listUserCollections(connection);
    for (const name of existing) {
      if (!ALLOWED_COLLECTIONS.has(name)) {
        fail("UNEXPECTED_COLLECTION", `refusing to drop unexpected collection ${name}`);
      }
      await connection.db.collection(name).drop();
    }
  } finally {
    await connection.close();
  }
}

/**
 * Replace the fixture set: drop only allowlisted collections, then seed again.
 *
 * @param {{ uri: string, dbName: string }} options
 */
export async function reseedFixtures(options) {
  await resetFixtureCollections(options);
  return seedFixtures(options);
}
