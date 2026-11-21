// Hotel disposable-MongoDB integration guard tests — DB-free.
//
// Every connection below is an in-memory fake. No MongoDB connection is opened,
// no index is created, and no environment file is read. All URIs and secrets
// are synthetic test values.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOTEL_INTEGRATION_ALLOWED_HOSTS,
  HOTEL_INTEGRATION_COLLECTIONS,
  HOTEL_INTEGRATION_DB_NAME,
  HOTEL_INTEGRATION_ENV,
  HOTEL_INTEGRATION_OWNERSHIP_COLLECTION,
  HOTEL_INTEGRATION_OWNERSHIP_ID,
  HOTEL_INTEGRATION_VALUES,
  HotelIntegrationGuardError,
  assertFreshHotelIntegrationTarget,
  assertNoCachedHotelConnection,
  assertNoInheritedHotelEnvironment,
  claimHotelIntegrationTarget,
  cleanupHotelIntegrationTarget,
  parseHotelIntegrationMongoUri,
  readHotelIntegrationConfig,
  verifyHotelIntegrationConnection,
  verifyHotelIntegrationOwnership,
} from "./helpers/hotel-integration-guard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VALID_URI = "mongodb://127.0.0.1:27018/bono_hotel";
const VALID_TARGET = Object.freeze({
  host: "127.0.0.1",
  port: 27018,
  databaseName: HOTEL_INTEGRATION_DB_NAME,
});
const RUN_ID = "run_1234567890abcdef";
const CLEANUP_ACK = HOTEL_INTEGRATION_VALUES.CLEANUP_ACK;

function validEnv(overrides = {}) {
  return {
    NODE_ENV: "test",
    HOTEL_INTEGRATION_TESTS: "1",
    HOTEL_INDEX_DEPLOY_ENV: "disposable",
    HOTEL_TEST_TARGET_ACK: "I_CONFIRM_DISPOSABLE_MONGODB",
    HOTEL_TEST_MONGODB_URI: VALID_URI,
    ...overrides,
  };
}

function envWithout(name) {
  const env = validEnv();
  delete env[name];
  return env;
}

function assertSafeError(error, code) {
  assert.ok(
    error instanceof HotelIntegrationGuardError,
    `expected HotelIntegrationGuardError, got ${error}`
  );
  assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
  assert.equal(error.message.includes("mongodb://"), false);
  assert.equal(error.message.includes("super-secret"), false);
  assert.equal(error.message.includes("synthetic-password"), false);
  return error;
}

function expectSyncError(fn, code) {
  let error;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  return assertSafeError(error, code);
}

async function expectAsyncError(action, code) {
  let error;
  try {
    await (typeof action === "function" ? action() : action);
  } catch (caught) {
    error = caught;
  }
  return assertSafeError(error, code);
}

function valueAt(object, path) {
  return path.split(".").reduce((value, part) => value?.[part], object);
}

function matchesFilter(document, filter) {
  return Object.entries(filter).every(
    ([path, expected]) => valueAt(document, path) === expected
  );
}

function createFakeConnection({
  readyState = 1,
  name = HOTEL_INTEGRATION_DB_NAME,
  host = "127.0.0.1",
  port = 27018,
  databaseName = HOTEL_INTEGRATION_DB_NAME,
  hello = { ok: 1, isWritablePrimary: true },
  helloError = false,
  collections = [],
  collectionTypes = {},
  onListCollections = null,
  listCollectionsError = false,
  listCollectionsValue = null,
  insertError = false,
  insertAcknowledged = true,
  insertedId = null,
  findError = false,
  marker = null,
  deleteManyErrorFor = null,
  deleteManyAcknowledged = true,
  markerDeleteError = false,
  markerDeleteCount = 1,
  onDelete = null,
} = {}) {
  const calls = {
    commands: 0,
    listCollections: 0,
    inserts: [],
    finds: [],
    deletes: [],
    markerDeletes: [],
    forbidden: [],
  };
  const markerDocs = new Map();
  if (marker) markerDocs.set(marker._id, marker);

  const db = {
    databaseName,
    async command(command) {
      calls.commands += 1;
      if (helloError) throw new Error("synthetic hello failure");
      return typeof hello === "function" ? hello(command) : hello;
    },
    listCollections() {
      calls.listCollections += 1;
      if (onListCollections) onListCollections(calls.listCollections);
      if (listCollectionsError) throw new Error("synthetic list failure");
      if (listCollectionsValue !== null) return listCollectionsValue;
      const names = [...collections];
      if (markerDocs.size > 0) names.push(HOTEL_INTEGRATION_OWNERSHIP_COLLECTION);
      return {
        toArray: async () =>
          names.map((entry) => ({
            name: entry,
            type: collectionTypes[entry] ?? "collection",
          })),
      };
    },
    collection(collectionName) {
      if (collectionName === HOTEL_INTEGRATION_OWNERSHIP_COLLECTION) {
        return {
          async insertOne(document) {
            calls.inserts.push(document);
            if (insertError) throw new Error("synthetic insert failure");
            markerDocs.set(document._id, { ...document });
            return {
              acknowledged: insertAcknowledged,
              insertedId: insertedId ?? document._id,
            };
          },
          async findOne(filter) {
            calls.finds.push(filter);
            if (findError) throw new Error("synthetic find failure");
            const document = markerDocs.get(filter._id);
            return document && matchesFilter(document, filter)
              ? { ...document }
              : null;
          },
          async deleteOne(filter) {
            calls.markerDeletes.push(filter);
            if (markerDeleteError) {
              throw new Error("synthetic marker delete failure");
            }
            const document = markerDocs.get(filter._id);
            if (!document || !matchesFilter(document, filter)) {
              return { acknowledged: true, deletedCount: 0 };
            }
            if (markerDeleteCount === 0) {
              return { acknowledged: true, deletedCount: 0 };
            }
            markerDocs.delete(filter._id);
            return {
              acknowledged: true,
              deletedCount: markerDeleteCount,
            };
          },
        };
      }

      return {
        async deleteMany(filter) {
          calls.deletes.push({ name: collectionName, filter });
          if (deleteManyErrorFor === collectionName) {
            throw new Error("synthetic collection delete failure");
          }
          if (onDelete) onDelete(collectionName, calls);
          return { acknowledged: deleteManyAcknowledged, deletedCount: 0 };
        },
      };
    },
    async dropDatabase() {
      calls.forbidden.push("dropDatabase");
      throw new Error("dropDatabase must not be called");
    },
    async dropCollection() {
      calls.forbidden.push("dropCollection");
      throw new Error("dropCollection must not be called");
    },
    async dropIndexes() {
      calls.forbidden.push("dropIndexes");
      throw new Error("dropIndexes must not be called");
    },
  };

  return {
    connection: {
      readyState,
      name,
      host,
      port,
      db,
    },
    calls,
    markerDocs,
  };
}

async function claimValidOwnership(fake, overrides = {}) {
  return claimHotelIntegrationTarget({
    connection: fake.connection,
    expectedTarget: VALID_TARGET,
    runId: RUN_ID,
    now: 1_700_000_000_000,
    ...overrides,
  });
}

describe("Hotel integration environment guard", () => {
  test("accepts the exact opt-in environment and returns a credential-free target", () => {
    const syntheticUri =
      "mongodb://test-user:synthetic-password@127.0.0.1:27018/bono_hotel?authSource=admin";
    const config = readHotelIntegrationConfig(
      validEnv({ HOTEL_TEST_MONGODB_URI: syntheticUri })
    );

    assert.equal(config.mongoUri, syntheticUri);
    assert.deepEqual(config.target, VALID_TARGET);
    assert.equal("username" in config.target, false);
    assert.equal("password" in config.target, false);
    assert.equal("uri" in config.target, false);
  });

  test("accepts IPv6 loopback and directConnection=true", () => {
    const config = readHotelIntegrationConfig(
      validEnv({
        HOTEL_TEST_MONGODB_URI:
          "mongodb://[::1]:27018/bono_hotel?directConnection=true",
      })
    );

    assert.deepEqual(config.target, {
      host: "::1",
      port: 27018,
      databaseName: HOTEL_INTEGRATION_DB_NAME,
    });
  });

  test("requires every exact opt-in value", () => {
    for (const name of [
      HOTEL_INTEGRATION_ENV.OPT_IN,
      HOTEL_INTEGRATION_ENV.TARGET_CLASS,
      HOTEL_INTEGRATION_ENV.TARGET_ACK,
    ]) {
      expectSyncError(() => readHotelIntegrationConfig(envWithout(name)), "ENV_FLAG");
    }

    for (const value of ["true", "01", "1 ", "yes"]) {
      expectSyncError(
        () =>
          readHotelIntegrationConfig(
            validEnv({ HOTEL_INTEGRATION_TESTS: value })
          ),
        "ENV_FLAG"
      );
    }

    for (const value of ["production", "Disposable", "dev", "disposable "]) {
      expectSyncError(
        () =>
          readHotelIntegrationConfig(
            validEnv({ HOTEL_INDEX_DEPLOY_ENV: value })
          ),
        "ENV_FLAG"
      );
    }

    for (const value of [
      "1",
      "I_CONFIRM_DISPOSABLE_MONGODB ",
      "i_confirm_disposable_mongodb",
    ]) {
      expectSyncError(
        () =>
          readHotelIntegrationConfig(
            validEnv({ HOTEL_TEST_TARGET_ACK: value })
          ),
        "ENV_FLAG"
      );
    }
  });

  test("requires a non-empty test-only MongoDB URI", () => {
    for (const value of [undefined, "", "   ", null, 123]) {
      const env = validEnv();
      if (value === undefined) delete env[HOTEL_INTEGRATION_ENV.MONGO_URI];
      else env[HOTEL_INTEGRATION_ENV.MONGO_URI] = value;
      expectSyncError(() => readHotelIntegrationConfig(env), "ENV_URI");
    }
  });

  test("refuses inherited Hotel/POS database and secret variables", () => {
    for (const name of [
      "ROOM_MONGODB_URI",
      "MONGODB_URI",
      "MONGO_URI",
      "AUTH_SECRET",
      "HOTEL_SESSION_SECRET",
      "HOTEL_PROVISION_MANAGER_PASSWORD",
      "HOTEL_PROVISION_MANAGER_PIN",
      "HOTEL_PROVISION_PIN",
    ]) {
      const error = expectSyncError(
        () =>
          readHotelIntegrationConfig(
            validEnv({ [name]: "synthetic-password" })
          ),
        "ENV_INHERITED"
      );
      assert.ok(error.message.includes(name));
      assert.equal(error.message.includes("synthetic-password"), false);
    }

    for (const value of [123, true, {}]) {
      expectSyncError(
        () =>
          readHotelIntegrationConfig(
            validEnv({ AUTH_SECRET: value })
          ),
        "ENV_INHERITED"
      );
    }
  });

  test("refuses deployment markers and non-test NODE_ENV values", () => {
    for (const name of [
      "VERCEL_ENV",
      "CONTEXT",
      "DEPLOY_ENV",
      "ENVIRONMENT",
      "APP_ENV",
    ]) {
      const error = expectSyncError(
        () =>
          readHotelIntegrationConfig(
            validEnv({ [name]: "production" })
          ),
        "ENV_PRODUCTION"
      );
      assert.ok(error.message.includes(name));
    }

    for (const value of ["production", "prod", "live", "development", "staging"]) {
      expectSyncError(
        () =>
          readHotelIntegrationConfig(
            validEnv({ NODE_ENV: value })
          ),
        "ENV_PRODUCTION"
      );
    }

    assert.doesNotThrow(() =>
      readHotelIntegrationConfig(validEnv({ NODE_ENV: "" }))
    );
  });

  test("environment errors never echo the URI or a secret value", () => {
    const syntheticUri =
      "mongodb://test-user:synthetic-password@127.0.0.1:27018/bono_hotel";
    for (const overrides of [
      { HOTEL_INTEGRATION_TESTS: "0" },
      { HOTEL_INDEX_DEPLOY_ENV: "production" },
      { HOTEL_TEST_TARGET_ACK: "0" },
      { ROOM_MONGODB_URI: syntheticUri },
      { AUTH_SECRET: "synthetic-password" },
      { NODE_ENV: "production" },
    ]) {
      const error = expectSyncError(
        () =>
          readHotelIntegrationConfig(
            validEnv({
              HOTEL_TEST_MONGODB_URI: syntheticUri,
              ...overrides,
            })
          ),
        overrides.ROOM_MONGODB_URI
          ? "ENV_INHERITED"
          : overrides.AUTH_SECRET
            ? "ENV_INHERITED"
            : overrides.NODE_ENV
              ? "ENV_PRODUCTION"
              : overrides.HOTEL_INDEX_DEPLOY_ENV
                ? "ENV_FLAG"
                : "ENV_FLAG"
      );
      assert.equal(error.message.includes("synthetic-password"), false);
      assert.equal(error.message.includes(syntheticUri), false);
    }
  });

  test("assertNoInheritedHotelEnvironment is directly usable", () => {
    assert.doesNotThrow(() => assertNoInheritedHotelEnvironment(validEnv()));
    expectSyncError(
      () =>
        assertNoInheritedHotelEnvironment(
          validEnv({ MONGO_URI: "synthetic-password" })
        ),
      "ENV_INHERITED"
    );
  });
});

describe("Hotel integration URI policy", () => {
  test("accepts literal loopback hosts and strips URL brackets", () => {
    assert.deepEqual(parseHotelIntegrationMongoUri(VALID_URI), VALID_TARGET);
    assert.deepEqual(
      parseHotelIntegrationMongoUri("mongodb://[::1]:27018/bono_hotel"),
      {
        host: "::1",
        port: 27018,
        databaseName: HOTEL_INTEGRATION_DB_NAME,
      }
    );
  });

  test("never returns credentials", () => {
    const target = parseHotelIntegrationMongoUri(
      "mongodb://test-user:synthetic-password@127.0.0.1:27018/bono_hotel"
    );
    assert.deepEqual(target, VALID_TARGET);
    assert.equal(JSON.stringify(target).includes("synthetic-password"), false);
    assert.equal(JSON.stringify(target).includes("test-user"), false);
  });

  test("rejects non-direct schemes and Atlas/SRV targets", () => {
    for (const uri of [
      "mongodb+srv://cluster.example.com/bono_hotel",
      "http://127.0.0.1:27018/bono_hotel",
      "https://127.0.0.1:27018/bono_hotel",
    ]) {
      expectSyncError(() => parseHotelIntegrationMongoUri(uri), "URI_SCHEME");
    }
  });

  test("rejects localhost, DNS hosts, wildcard hosts, and lookalikes", () => {
    for (const uri of [
      "mongodb://localhost:27018/bono_hotel",
      "mongodb://mongo.internal:27018/bono_hotel",
      "mongodb://0.0.0.0:27018/bono_hotel",
      "mongodb://[::]:27018/bono_hotel",
      "mongodb://127.0.0.1.nip.io:27018/bono_hotel",
      "mongodb://127.0.0.1.:27018/bono_hotel",
      "mongodb://[::ffff:127.0.0.1]:27018/bono_hotel",
    ]) {
      expectSyncError(() => parseHotelIntegrationMongoUri(uri), "URI_HOST");
    }
  });

  test("rejects missing, default, and privileged ports", () => {
    for (const uri of [
      "mongodb://127.0.0.1/bono_hotel",
      "mongodb://127.0.0.1:27017/bono_hotel",
      "mongodb://127.0.0.1:80/bono_hotel",
    ]) {
      expectSyncError(() => parseHotelIntegrationMongoUri(uri), "URI_PORT");
    }

    expectSyncError(
      () => parseHotelIntegrationMongoUri("mongodb://127.0.0.1:65536/bono_hotel"),
      "URI_INVALID"
    );
  });

  test("rejects any database path other than exactly /bono_hotel", () => {
    for (const uri of [
      "mongodb://127.0.0.1:27018",
      "mongodb://127.0.0.1:27018/",
      "mongodb://127.0.0.1:27018/other",
      "mongodb://127.0.0.1:27018/bono_hotel_extra",
      "mongodb://127.0.0.1:27018/bono_hotel/",
      "mongodb://127.0.0.1:27018/hotel/bono_hotel",
    ]) {
      expectSyncError(() => parseHotelIntegrationMongoUri(uri), "URI_DATABASE");
    }
  });

  test("rejects unsupported, duplicate, and dangerous query parameters", () => {
    for (const uri of [
      "mongodb://127.0.0.1:27018/bono_hotel?replicaSet=rs0",
      "mongodb://127.0.0.1:27018/bono_hotel?loadBalanced=true",
      "mongodb://127.0.0.1:27018/bono_hotel?tls=true",
      "mongodb://127.0.0.1:27018/bono_hotel?ssl=true",
      "mongodb://127.0.0.1:27018/bono_hotel?unknown=value",
      "mongodb://127.0.0.1:27018/bono_hotel?directConnection",
      "mongodb://127.0.0.1:27018/bono_hotel?directConnection=false",
      "mongodb://127.0.0.1:27018/bono_hotel?directConnection=true&directConnection=true",
      "mongodb://127.0.0.1:27018/bono_hotel?authSource=",
      "mongodb://127.0.0.1:27018/bono_hotel?authSource=admin&authSource=admin",
      "mongodb://127.0.0.1:27018/bono_hotel?",
      "mongodb://127.0.0.1:27018/bono_hotel#fragment",
    ]) {
      expectSyncError(() => parseHotelIntegrationMongoUri(uri), "URI_QUERY");
    }
  });

  test("rejects multiple hosts and malformed or whitespace-bearing URIs", () => {
    for (const uri of [
      "mongodb://127.0.0.1:27018,127.0.0.1:27019/bono_hotel",
      "mongodb://127.0.0.1:27018,b:27019/bono_hotel",
      ` ${VALID_URI}`,
      `${VALID_URI} `,
      "mongodb://127.0.0.1:27018/bono_hotel\n",
      "mongodb://127.0.0.1:27018/bono_hotel?authSource=admin\n",
      "",
      null,
      123,
    ]) {
      expectSyncError(() => parseHotelIntegrationMongoUri(uri), "URI_INVALID");
    }

    expectSyncError(
      () => parseHotelIntegrationMongoUri("not-a-mongodb-uri"),
      "URI_SCHEME"
    );
  });

  test("URI errors never echo the synthetic URI or credentials", () => {
    for (const uri of [
      "mongodb://test-user:synthetic-password@localhost:27018/bono_hotel",
      "mongodb://test-user:synthetic-password@127.0.0.1:27017/bono_hotel",
      "mongodb://test-user:synthetic-password@127.0.0.1:27018/other",
      "mongodb://test-user:synthetic-password@127.0.0.1:27018/bono_hotel?replicaSet=rs0",
    ]) {
      const error = expectSyncError(
        () => parseHotelIntegrationMongoUri(uri),
        uri.includes("localhost")
          ? "URI_HOST"
          : uri.includes(":27017")
            ? "URI_PORT"
            : uri.includes("/other")
              ? "URI_DATABASE"
              : "URI_QUERY"
      );
      assert.equal(error.message.includes("synthetic-password"), false);
      assert.equal(error.message.includes(uri), false);
    }
  });
});

describe("Hotel integration connection cache guard", () => {
  test("allows a fresh global object and rejects any cached state", () => {
    assert.doesNotThrow(() => assertNoCachedHotelConnection({}));
    assert.doesNotThrow(() =>
      assertNoCachedHotelConnection({
        __bonoHotelMongooseConnection: null,
      })
    );

    for (const state of [
      { connection: {} },
      { promise: Promise.resolve() },
      { connection: null, promise: null, fingerprint: "abc" },
      true,
      "cached",
    ]) {
      expectSyncError(
        () =>
          assertNoCachedHotelConnection({
            __bonoHotelMongooseConnection: state,
          }),
        "CACHE_PRESENT"
      );
    }
  });
});

describe("Hotel integration live target verification", () => {
  test("accepts a standalone writable loopback connection", async () => {
    const fake = createFakeConnection();
    const result = await verifyHotelIntegrationConnection({
      connection: fake.connection,
      expectedTarget: VALID_TARGET,
    });

    assert.deepEqual(result.target, VALID_TARGET);
    assert.equal(result.writable, true);
    assert.equal(fake.calls.commands, 1);
  });

  test("normalizes bracketed IPv6 connection hosts", async () => {
    const fake = createFakeConnection({ host: "[::1]" });
    const result = await verifyHotelIntegrationConnection({
      connection: fake.connection,
      expectedTarget: { ...VALID_TARGET, host: "::1" },
    });
    assert.equal(result.target.host, "::1");
  });

  test("rejects malformed expected targets before inspecting the connection", async () => {
    for (const target of [
      null,
      { host: "localhost", port: 27018, databaseName: HOTEL_INTEGRATION_DB_NAME },
      { host: "127.0.0.1", port: 27017, databaseName: HOTEL_INTEGRATION_DB_NAME },
      { host: "127.0.0.1", port: 80, databaseName: HOTEL_INTEGRATION_DB_NAME },
      { host: "127.0.0.1", port: 27018, databaseName: "other" },
    ]) {
      await expectAsyncError(
        () =>
          verifyHotelIntegrationConnection({
            connection: createFakeConnection().connection,
            expectedTarget: target,
          }),
        "TARGET_INVALID"
      );
    }
  });

  test("rejects disconnected, wrong-name, wrong-host, and wrong-port connections", async () => {
    for (const options of [
      { readyState: 0 },
      { name: "other" },
      { databaseName: "other" },
      { host: "localhost" },
      { host: "127.0.0.2" },
      { port: 27019 },
    ]) {
      const fake = createFakeConnection(options);
      await expectAsyncError(
        () =>
          verifyHotelIntegrationConnection({
            connection: fake.connection,
            expectedTarget: VALID_TARGET,
          }),
        options.readyState !== undefined
          ? "TARGET_NOT_CONNECTED"
          : options.name || options.databaseName
            ? "TARGET_DATABASE"
            : options.host
              ? "TARGET_HOST"
              : "TARGET_PORT"
      );
    }
  });

  test("rejects failed hello commands and non-ok responses", async () => {
    await expectAsyncError(
      () =>
        verifyHotelIntegrationConnection({
          connection: createFakeConnection({ helloError: true }).connection,
          expectedTarget: VALID_TARGET,
        }),
      "TARGET_HELLO"
    );

    for (const hello of [null, {}, { ok: 0 }, { ok: 1, isWritablePrimary: true }]) {
      if (hello && hello.ok === 1) continue;
      await expectAsyncError(
        () =>
          verifyHotelIntegrationConnection({
            connection: createFakeConnection({ hello }).connection,
            expectedTarget: VALID_TARGET,
          }),
        "TARGET_HELLO"
      );
    }
  });

  test("rejects replica-set, mongos, load-balanced, and non-standalone targets", async () => {
    const cases = [
      [{ ok: 1, isWritablePrimary: true, setName: "rs0" }, "TARGET_REPLICA_SET"],
      [{ ok: 1, isWritablePrimary: true, setVersion: 1 }, "TARGET_REPLICA_SET"],
      [
        { ok: 1, isWritablePrimary: true, hosts: ["127.0.0.1:27018"] },
        "TARGET_REPLICA_SET",
      ],
      [
        { ok: 1, isWritablePrimary: true, passives: ["127.0.0.1:27018"] },
        "TARGET_REPLICA_SET",
      ],
      [
        { ok: 1, isWritablePrimary: true, arbiters: ["127.0.0.1:27018"] },
        "TARGET_REPLICA_SET",
      ],
      [{ ok: 1, isWritablePrimary: true, secondary: true }, "TARGET_REPLICA_SET"],
      [{ ok: 1, isWritablePrimary: true, arbiterOnly: true }, "TARGET_REPLICA_SET"],
      [{ ok: 1, isWritablePrimary: true, hidden: true }, "TARGET_REPLICA_SET"],
      [{ ok: 1, isWritablePrimary: true, msg: "isdbgrid" }, "TARGET_MONGOS"],
      [{ ok: 1, isWritablePrimary: true, msg: "other" }, "TARGET_NOT_STANDALONE"],
      [
        { ok: 1, isWritablePrimary: true, serviceId: "synthetic" },
        "TARGET_NOT_STANDALONE",
      ],
      [
        { ok: 1, isWritablePrimary: true, loadBalanced: true },
        "TARGET_NOT_STANDALONE",
      ],
    ];

    for (const [hello, code] of cases) {
      await expectAsyncError(
        () =>
          verifyHotelIntegrationConnection({
            connection: createFakeConnection({ hello }).connection,
            expectedTarget: VALID_TARGET,
          }),
        code
      );
    }
  });

  test("rejects secondary and read-only targets", async () => {
    for (const hello of [
      { ok: 1, isWritablePrimary: false, ismaster: false },
      { ok: 1, isWritablePrimary: true, readOnly: true },
      { ok: 1, ismaster: false },
    ]) {
      await expectAsyncError(
        () =>
          verifyHotelIntegrationConnection({
            connection: createFakeConnection({ hello }).connection,
            expectedTarget: VALID_TARGET,
          }),
        "TARGET_NOT_WRITABLE"
      );
    }
  });

  test("requires a present modern writable field to be true", async () => {
    for (const hello of [
      { ok: 1, isWritablePrimary: false, ismaster: true, maxWireVersion: 9 },
      { ok: 1, isWritablePrimary: null, ismaster: true, maxWireVersion: 9 },
      {
        ok: 1,
        isWritablePrimary: undefined,
        ismaster: true,
        maxWireVersion: 9,
      },
    ]) {
      await expectAsyncError(
        () =>
          verifyHotelIntegrationConnection({
            connection: createFakeConnection({ hello }).connection,
            expectedTarget: VALID_TARGET,
          }),
        "TARGET_NOT_WRITABLE"
      );
    }

    const fake = createFakeConnection({
      hello: {
        ok: 1,
        isWritablePrimary: true,
        ismaster: false,
        maxWireVersion: 9,
      },
    });
    const result = await verifyHotelIntegrationConnection({
      connection: fake.connection,
      expectedTarget: VALID_TARGET,
    });
    assert.equal(result.writable, true);
  });

  test("rejects hello responses with no usable writable field", async () => {
    for (const hello of [
      { ok: 1 },
      { ok: 1, ismaster: false, maxWireVersion: 9 },
      {
        ok: 1,
        isWritablePrimary: undefined,
        ismaster: false,
        maxWireVersion: 9,
      },
    ]) {
      await expectAsyncError(
        () =>
          verifyHotelIntegrationConnection({
            connection: createFakeConnection({ hello }).connection,
            expectedTarget: VALID_TARGET,
          }),
        "TARGET_NOT_WRITABLE"
      );
    }
  });

  test("accepts the legacy ismaster marker only for legacy wire versions", async () => {
    for (const maxWireVersion of [8, 9]) {
      const fake = createFakeConnection({
        hello: { ok: 1, ismaster: true, maxWireVersion },
      });
      const result = await verifyHotelIntegrationConnection({
        connection: fake.connection,
        expectedTarget: VALID_TARGET,
      });
      assert.equal(result.writable, true);
    }

    for (const hello of [
      { ok: 1, ismaster: true, maxWireVersion: 13 },
      { ok: 1, ismaster: true, maxWireVersion: 29 },
      { ok: 1, ismaster: true },
      { ok: 1, ismaster: true, maxWireVersion: 7 },
    ]) {
      await expectAsyncError(
        () =>
          verifyHotelIntegrationConnection({
            connection: createFakeConnection({ hello }).connection,
            expectedTarget: VALID_TARGET,
          }),
        "TARGET_NOT_WRITABLE"
      );
    }
  });
});

describe("Hotel integration freshness guard", () => {
  test("accepts an empty target and ignores system collections", async () => {
    for (const collections of [[], ["system.views"], ["system.profile"]]) {
      const fake = createFakeConnection({ collections });
      const result = await assertFreshHotelIntegrationTarget({
        connection: fake.connection,
        expectedTarget: VALID_TARGET,
      });
      assert.equal(result.fresh, true);
      assert.equal(fake.calls.listCollections, 1);
    }
  });

  test("rejects any non-system collection, including an old ownership marker", async () => {
    for (const collections of [
      ["hotel_users"],
      ["roomtypes"],
      ["pos_sales"],
      [HOTEL_INTEGRATION_OWNERSHIP_COLLECTION],
      ["system.views", "hotel_stays"],
    ]) {
      const fake = createFakeConnection({ collections });
      await expectAsyncError(
        () =>
          assertFreshHotelIntegrationTarget({
            connection: fake.connection,
            expectedTarget: VALID_TARGET,
          }),
        "TARGET_NOT_FRESH"
      );
    }
  });

  test("rejects an uninspectable collection list", async () => {
    for (const options of [
      { listCollectionsError: true },
      { listCollectionsValue: { not: "an array" } },
      { collections: [null] },
    ]) {
      const fake = createFakeConnection(options);
      await expectAsyncError(
        () =>
          assertFreshHotelIntegrationTarget({
            connection: fake.connection,
            expectedTarget: VALID_TARGET,
          }),
        "TARGET_FRESHNESS_UNVERIFIED"
      );
    }
  });

  test("accepts a listCollections promise that resolves to an array", async () => {
    const fake = createFakeConnection({
      listCollectionsValue: Promise.resolve([]),
    });
    const result = await assertFreshHotelIntegrationTarget({
      connection: fake.connection,
      expectedTarget: VALID_TARGET,
    });
    assert.equal(result.fresh, true);
  });
});

describe("Hotel integration ownership guard", () => {
  test("claims a fresh target with one hashed ownership marker", async () => {
    const fake = createFakeConnection();
    const ownership = await claimValidOwnership(fake);

    assert.equal(ownership.collectionName, HOTEL_INTEGRATION_OWNERSHIP_COLLECTION);
    assert.equal(ownership.runId, RUN_ID);
    assert.match(ownership.tokenHash, /^[0-9a-f]{64}$/);
    assert.equal(ownership.pid, process.pid);
    assert.deepEqual(ownership.target, VALID_TARGET);
    assert.equal("token" in ownership, false);
    assert.equal(fake.calls.inserts.length, 1);

    const marker = fake.calls.inserts[0];
    assert.equal(marker._id, HOTEL_INTEGRATION_OWNERSHIP_ID);
    assert.equal(marker.runId, RUN_ID);
    assert.equal(marker.kind, "bono-hotel-disposable-integration-run");
    assert.equal(marker.tokenHash, ownership.tokenHash);
    assert.equal("token" in marker, false);
    assert.deepEqual(marker.target, VALID_TARGET);
    assert.equal(marker.pid, process.pid);
    assert.ok(marker.createdAt instanceof Date);
  });

  test("refuses a second claim on an already-owned target", async () => {
    const fake = createFakeConnection();
    await claimValidOwnership(fake);

    await expectAsyncError(
      () => claimValidOwnership(fake),
      "TARGET_NOT_FRESH"
    );
    assert.equal(fake.calls.inserts.length, 1);
    assert.equal(fake.markerDocs.size, 1);
    assert.equal(fake.markerDocs.has(HOTEL_INTEGRATION_OWNERSHIP_ID), true);
  });

  test("refuses to claim a non-fresh target or invalid run identity", async () => {
    const nonFresh = createFakeConnection({ collections: ["hotel_users"] });
    await expectAsyncError(
      () => claimValidOwnership(nonFresh),
      "TARGET_NOT_FRESH"
    );
    assert.equal(nonFresh.calls.inserts.length, 0);

    for (const runId of ["short", "bad id with spaces", "bad/id", "", null]) {
      const fake = createFakeConnection();
      await expectAsyncError(
        () => claimValidOwnership(fake, { runId }),
        "OWNERSHIP_INVALID"
      );
      assert.equal(fake.calls.inserts.length, 0);
    }

    const fake = createFakeConnection();
    await expectAsyncError(
      () => claimValidOwnership(fake, { now: Number.NaN }),
      "OWNERSHIP_INVALID"
    );
    assert.equal(fake.calls.inserts.length, 0);
  });

  test("refuses an unacknowledged or failed ownership insert", async () => {
    for (const options of [
      { insertError: true },
      { insertAcknowledged: false },
      { insertedId: "different-id" },
    ]) {
      const fake = createFakeConnection(options);
      await expectAsyncError(
        () => claimValidOwnership(fake),
        "OWNERSHIP_CLAIM_FAILED"
      );
    }
  });

  test("verifies the exact live target and ownership marker", async () => {
    const fake = createFakeConnection();
    const ownership = await claimValidOwnership(fake);
    const result = await verifyHotelIntegrationOwnership({
      connection: fake.connection,
      expectedTarget: VALID_TARGET,
      ownership,
    });

    assert.equal(result.owned, true);
    assert.equal(result.runId, RUN_ID);
    assert.deepEqual(result.target, VALID_TARGET);
    assert.equal(fake.calls.finds.length, 1);
    assert.equal(fake.calls.finds[0]._id, HOTEL_INTEGRATION_OWNERSHIP_ID);
    assert.equal(fake.calls.finds[0].runId, RUN_ID);
    assert.equal(fake.calls.finds[0].tokenHash, ownership.tokenHash);
    assert.equal(fake.calls.finds[0]["target.host"], "127.0.0.1");
    assert.equal(fake.calls.finds[0]["target.port"], 27018);
    assert.equal(
      fake.calls.finds[0]["target.databaseName"],
      HOTEL_INTEGRATION_DB_NAME
    );
  });

  test("rejects missing, malformed, or mismatched ownership records", async () => {
    const fake = createFakeConnection();
    const ownership = await claimValidOwnership(fake);

    for (const [record, code] of [
      [null, "OWNERSHIP_INVALID"],
      [{}, "OWNERSHIP_INVALID"],
      [{ ...ownership, collectionName: "other" }, "OWNERSHIP_INVALID"],
      [{ ...ownership, tokenHash: "short" }, "OWNERSHIP_INVALID"],
      [{ ...ownership, pid: "not-a-pid" }, "OWNERSHIP_INVALID"],
      [{ ...ownership, pid: 0 }, "OWNERSHIP_INVALID"],
      [
        { ...ownership, target: { ...VALID_TARGET, port: 27019 } },
        "OWNERSHIP_MISMATCH",
      ],
    ]) {
      await expectAsyncError(
        () =>
          verifyHotelIntegrationOwnership({
            connection: fake.connection,
            expectedTarget: VALID_TARGET,
            ownership: record,
          }),
        code
      );
    }
  });

  test("rejects a missing, mutated, or unreadable marker", async () => {
    const missing = createFakeConnection();
    const missingOwnership = await claimValidOwnership(missing);
    missing.markerDocs.clear();
    await expectAsyncError(
      () =>
        verifyHotelIntegrationOwnership({
          connection: missing.connection,
          expectedTarget: VALID_TARGET,
          ownership: missingOwnership,
        }),
      "OWNERSHIP_MISMATCH"
    );

    for (const mutate of [
      (marker) => {
        marker.tokenHash = "0".repeat(64);
      },
      (marker) => {
        marker.runId = "other_run_1234567890";
      },
      (marker) => {
        marker.pid += 1;
      },
      (marker) => {
        marker.target.port = 27019;
      },
    ]) {
      const fake = createFakeConnection();
      const ownership = await claimValidOwnership(fake);
      mutate(fake.markerDocs.get(HOTEL_INTEGRATION_OWNERSHIP_ID));
      await expectAsyncError(
        () =>
          verifyHotelIntegrationOwnership({
            connection: fake.connection,
            expectedTarget: VALID_TARGET,
            ownership,
          }),
        "OWNERSHIP_MISMATCH"
      );
    }

    const unreadable = createFakeConnection({ findError: true });
    const unreadableOwnership = await claimValidOwnership(unreadable);
    await expectAsyncError(
      () =>
        verifyHotelIntegrationOwnership({
          connection: unreadable.connection,
          expectedTarget: VALID_TARGET,
          ownership: unreadableOwnership,
        }),
      "OWNERSHIP_MISMATCH"
    );
  });

  test("re-verifies the live target before trusting an ownership marker", async () => {
    const fake = createFakeConnection();
    const ownership = await claimValidOwnership(fake);
    fake.connection.host = "127.0.0.2";

    await expectAsyncError(
      () =>
        verifyHotelIntegrationOwnership({
          connection: fake.connection,
          expectedTarget: VALID_TARGET,
          ownership,
        }),
      "TARGET_HOST"
    );
    assert.equal(fake.calls.finds.length, 0);
  });
});

describe("Hotel integration cleanup guard", () => {
  test("deletes only the ten Hotel collections and the exact owned marker", async () => {
    const fake = createFakeConnection();
    const ownership = await claimValidOwnership(fake);
    const result = await cleanupHotelIntegrationTarget({
      connection: fake.connection,
      expectedTarget: VALID_TARGET,
      ownership,
      env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
    });

    assert.deepEqual(result.deletedCollections, [
      ...HOTEL_INTEGRATION_COLLECTIONS,
    ]);
    assert.equal(result.ownershipReleased, true);
    assert.deepEqual(
      fake.calls.deletes.map((entry) => entry.name),
      [...HOTEL_INTEGRATION_COLLECTIONS]
    );
    assert.equal(fake.calls.deletes.every((entry) => Object.keys(entry.filter).length === 0), true);
    assert.equal(fake.calls.markerDeletes.length, 1);
    assert.equal(fake.calls.markerDeletes[0]._id, HOTEL_INTEGRATION_OWNERSHIP_ID);
    assert.equal(fake.calls.markerDeletes[0].runId, RUN_ID);
    assert.equal(fake.calls.markerDeletes[0].tokenHash, ownership.tokenHash);
    assert.equal(fake.markerDocs.size, 0);
    assert.deepEqual(fake.calls.forbidden, []);
  });

  test("refuses cleanup before any deletion when an unexpected collection or view exists", async () => {
    for (const [name, type] of [
      ["pos_sales", "collection"],
      ["unexpected_view", "view"],
      ["hotel_users", "view"],
    ]) {
      const collections = [];
      const collectionTypes = {};
      const fake = createFakeConnection({ collections, collectionTypes });
      const ownership = await claimValidOwnership(fake);

      collections.push(name);
      collectionTypes[name] = type;

      await expectAsyncError(
        () =>
          cleanupHotelIntegrationTarget({
            connection: fake.connection,
            expectedTarget: VALID_TARGET,
            ownership,
            env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
          }),
        "CLEANUP_UNEXPECTED_COLLECTION"
      );

      assert.equal(fake.calls.deletes.length, 0);
      assert.equal(fake.calls.markerDeletes.length, 0);
      assert.equal(fake.markerDocs.size, 1);
      assert.deepEqual(fake.calls.forbidden, []);
    }
  });

  test("retains the marker when an unexpected collection appears during cleanup", async () => {
    const collections = [];
    const fake = createFakeConnection({
      collections,
      onDelete(name) {
        if (name === HOTEL_INTEGRATION_COLLECTIONS.at(-1)) {
          collections.push("pos_sales");
        }
      },
    });
    const ownership = await claimValidOwnership(fake);

    await expectAsyncError(
      () =>
        cleanupHotelIntegrationTarget({
          connection: fake.connection,
          expectedTarget: VALID_TARGET,
          ownership,
          env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
        }),
      "CLEANUP_UNEXPECTED_COLLECTION"
    );

    assert.equal(fake.calls.deletes.length, HOTEL_INTEGRATION_COLLECTIONS.length);
    assert.equal(fake.calls.markerDeletes.length, 0);
    assert.equal(fake.markerDocs.size, 1);
    assert.equal(fake.markerDocs.has(HOTEL_INTEGRATION_OWNERSHIP_ID), true);
    assert.deepEqual(fake.calls.forbidden, []);
  });

  test("retains the marker when the post-delete collection list cannot be verified", async () => {
    const fake = createFakeConnection({
      onListCollections(count) {
        if (count === 3) {
          throw new Error("synthetic post-delete list failure");
        }
      },
    });
    const ownership = await claimValidOwnership(fake);

    await expectAsyncError(
      () =>
        cleanupHotelIntegrationTarget({
          connection: fake.connection,
          expectedTarget: VALID_TARGET,
          ownership,
          env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
        }),
      "CLEANUP_TARGET_UNVERIFIED"
    );

    assert.equal(fake.calls.listCollections, 3);
    assert.equal(fake.calls.deletes.length, HOTEL_INTEGRATION_COLLECTIONS.length);
    assert.equal(fake.calls.markerDeletes.length, 0);
    assert.equal(fake.markerDocs.size, 1);
    assert.equal(fake.markerDocs.has(HOTEL_INTEGRATION_OWNERSHIP_ID), true);
    assert.deepEqual(fake.calls.forbidden, []);
  });

  test("requires the separate exact cleanup acknowledgement before any deletion", async () => {
    const fake = createFakeConnection();
    const ownership = await claimValidOwnership(fake);
    const beforeCommands = fake.calls.commands;

    for (const value of [
      undefined,
      "",
      "1",
      "true",
      "I_CONFIRM_DISPOSABLE_MONGODB",
      "i_confirm_delete_disposable_mongodb_data",
    ]) {
      const env = validEnv();
      if (value !== undefined) env.HOTEL_TEST_ALLOW_CLEANUP = value;
      await expectAsyncError(
        () =>
          cleanupHotelIntegrationTarget({
            connection: fake.connection,
            expectedTarget: VALID_TARGET,
            ownership,
            env,
          }),
        "CLEANUP_NOT_ALLOWED"
      );
    }

    assert.equal(fake.calls.commands, beforeCommands);
    assert.equal(fake.calls.deletes.length, 0);
    assert.equal(fake.calls.markerDeletes.length, 0);
  });

  test("re-validates the full integration environment before deletion", async () => {
    const fake = createFakeConnection();
    const ownership = await claimValidOwnership(fake);
    const cleanupEnv = validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK });

    const cases = [
      [
        { ...cleanupEnv, HOTEL_INTEGRATION_TESTS: "0" },
        "ENV_FLAG",
      ],
      [
        { ...cleanupEnv, HOTEL_INDEX_DEPLOY_ENV: "production" },
        "ENV_FLAG",
      ],
      [
        { ...cleanupEnv, HOTEL_TEST_TARGET_ACK: "wrong" },
        "ENV_FLAG",
      ],
      [
        { ...cleanupEnv, ROOM_MONGODB_URI: "synthetic-password" },
        "ENV_INHERITED",
      ],
      [
        { ...cleanupEnv, NODE_ENV: "production" },
        "ENV_PRODUCTION",
      ],
      [
        {
          ...cleanupEnv,
          HOTEL_TEST_MONGODB_URI: "mongodb://127.0.0.1:27019/bono_hotel",
        },
        "CLEANUP_TARGET_MISMATCH",
      ],
    ];

    for (const [env, code] of cases) {
      await expectAsyncError(
        () =>
          cleanupHotelIntegrationTarget({
            connection: fake.connection,
            expectedTarget: VALID_TARGET,
            ownership,
            env,
          }),
        code
      );
    }

    assert.equal(fake.calls.deletes.length, 0);
    assert.equal(fake.calls.markerDeletes.length, 0);
  });

  test("requires a valid ownership record and exact target before deletion", async () => {
    const fake = createFakeConnection();
    const ownership = await claimValidOwnership(fake);
    const cleanupEnv = validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK });

    await expectAsyncError(
      () =>
        cleanupHotelIntegrationTarget({
          connection: fake.connection,
          expectedTarget: VALID_TARGET,
          ownership: null,
          env: cleanupEnv,
        }),
      "OWNERSHIP_INVALID"
    );

    await expectAsyncError(
      () =>
        cleanupHotelIntegrationTarget({
          connection: fake.connection,
          expectedTarget: VALID_TARGET,
          ownership: {
            ...ownership,
            target: { ...VALID_TARGET, port: 27019 },
          },
          env: cleanupEnv,
        }),
      "CLEANUP_TARGET_MISMATCH"
    );

    assert.equal(fake.calls.deletes.length, 0);
    assert.equal(fake.calls.markerDeletes.length, 0);
  });

  test("stops before deletion when the marker or live target no longer matches", async () => {
    const missing = createFakeConnection();
    const missingOwnership = await claimValidOwnership(missing);
    missing.markerDocs.clear();
    await expectAsyncError(
      () =>
        cleanupHotelIntegrationTarget({
          connection: missing.connection,
          expectedTarget: VALID_TARGET,
          ownership: missingOwnership,
          env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
        }),
      "OWNERSHIP_MISMATCH"
    );
    assert.equal(missing.calls.deletes.length, 0);

    const moved = createFakeConnection();
    const movedOwnership = await claimValidOwnership(moved);
    moved.connection.port = 27019;
    await expectAsyncError(
      () =>
        cleanupHotelIntegrationTarget({
          connection: moved.connection,
          expectedTarget: VALID_TARGET,
          ownership: movedOwnership,
          env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
        }),
      "TARGET_PORT"
    );
    assert.equal(moved.calls.deletes.length, 0);
  });

  test("keeps the ownership marker when a Hotel collection delete fails", async () => {
    const fake = createFakeConnection({ deleteManyErrorFor: "hotel_stays" });
    const ownership = await claimValidOwnership(fake);

    await expectAsyncError(
      () =>
        cleanupHotelIntegrationTarget({
          connection: fake.connection,
          expectedTarget: VALID_TARGET,
          ownership,
          env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
        }),
      "CLEANUP_FAILED"
    );

    assert.equal(fake.calls.deletes.length, 8);
    assert.equal(fake.markerDocs.size, 1);
    assert.equal(fake.calls.markerDeletes.length, 0);
    assert.deepEqual(fake.calls.forbidden, []);
  });

  test("keeps the ownership marker when a delete is unacknowledged", async () => {
    const fake = createFakeConnection({ deleteManyAcknowledged: false });
    const ownership = await claimValidOwnership(fake);

    await expectAsyncError(
      () =>
        cleanupHotelIntegrationTarget({
          connection: fake.connection,
          expectedTarget: VALID_TARGET,
          ownership,
          env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
        }),
      "CLEANUP_FAILED"
    );

    assert.equal(fake.calls.deletes.length, 1);
    assert.equal(fake.markerDocs.size, 1);
    assert.equal(fake.calls.markerDeletes.length, 0);
  });

  test("does not release ownership when post-delete target verification fails", async () => {
    const fake = createFakeConnection({
      onDelete(name) {
        if (name === HOTEL_INTEGRATION_COLLECTIONS.at(-1)) {
          fake.connection.readyState = 0;
        }
      },
    });
    const ownership = await claimValidOwnership(fake);

    await expectAsyncError(
      () =>
        cleanupHotelIntegrationTarget({
          connection: fake.connection,
          expectedTarget: VALID_TARGET,
          ownership,
          env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
        }),
      "TARGET_NOT_CONNECTED"
    );

    assert.equal(fake.calls.deletes.length, HOTEL_INTEGRATION_COLLECTIONS.length);
    assert.equal(fake.markerDocs.size, 1);
    assert.equal(fake.calls.markerDeletes.length, 0);
    assert.deepEqual(fake.calls.forbidden, []);
  });

  test("keeps the marker when its exact deletion fails or deletes nothing", async () => {
    for (const options of [
      { markerDeleteError: true },
      { markerDeleteCount: 0 },
    ]) {
      const fake = createFakeConnection(options);
      const ownership = await claimValidOwnership(fake);

      await expectAsyncError(
        () =>
          cleanupHotelIntegrationTarget({
            connection: fake.connection,
            expectedTarget: VALID_TARGET,
            ownership,
            env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
          }),
        "CLEANUP_FAILED"
      );

      assert.equal(fake.calls.deletes.length, HOTEL_INTEGRATION_COLLECTIONS.length);
      assert.equal(fake.markerDocs.size, 1);
    }
  });

  test("deletes only the exact owned marker when other marker rows exist", async () => {
    const fake = createFakeConnection();
    const ownership = await claimValidOwnership(fake);
    fake.markerDocs.set("other_run_1234567890", {
      ...fake.markerDocs.get(HOTEL_INTEGRATION_OWNERSHIP_ID),
      _id: "other_run_1234567890",
      runId: "other_run_1234567890",
    });

    const result = await cleanupHotelIntegrationTarget({
      connection: fake.connection,
      expectedTarget: VALID_TARGET,
      ownership,
      env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
    });

    assert.equal(result.ownershipReleased, true);
    assert.equal(fake.markerDocs.has(HOTEL_INTEGRATION_OWNERSHIP_ID), false);
    assert.equal(fake.markerDocs.has("other_run_1234567890"), true);
  });

  test("keeps the marker until every Hotel collection has been processed", async () => {
    const markerStates = [];
    let fake;
    fake = createFakeConnection({
      onDelete(name, calls) {
        markerStates.push({
          name,
          markers: fake.markerDocs.size,
          markerDeletes: calls.markerDeletes.length,
        });
      },
    });
    const ownership = await claimValidOwnership(fake);

    await cleanupHotelIntegrationTarget({
      connection: fake.connection,
      expectedTarget: VALID_TARGET,
      ownership,
      env: validEnv({ HOTEL_TEST_ALLOW_CLEANUP: CLEANUP_ACK }),
    });

    assert.equal(markerStates.length, HOTEL_INTEGRATION_COLLECTIONS.length);
    assert.deepEqual(
      markerStates.map((entry) => entry.name),
      [...HOTEL_INTEGRATION_COLLECTIONS]
    );
    assert.equal(
      markerStates.every((entry) => entry.markers === 1),
      true
    );
    assert.equal(
      markerStates.every((entry) => entry.markerDeletes === 0),
      true
    );
    assert.equal(fake.calls.markerDeletes.length, 1);
  });
});

describe("Hotel integration guard source safety", () => {
  test("the helper is DB-free, dependency-light, and has no automatic hooks", () => {
    const source = readFileSync(
      join(root, "tests/helpers/hotel-integration-guard.mjs"),
      "utf8"
    );

    assert.match(source, /^import crypto from "node:crypto";/m);
    for (const forbidden of [
      ".env.local",
      "readFileSync",
      "console.",
      "dropDatabase",
      "dropCollection",
      "dropIndexes",
      "syncIndexes",
      "dropIndex(",
      "connectToHotelDatabase",
      "mongoose",
      "node:test",
      "after(",
      "before(",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `helper source must not contain ${forbidden}`
      );
    }
  });

  test("the helper does not mutate process.env or open a connection", () => {
    const source = readFileSync(
      join(root, "tests/helpers/hotel-integration-guard.mjs"),
      "utf8"
    );
    assert.equal(source.includes("process.env ="), false);
    assert.equal(source.includes("process.env["), false);
    assert.equal(source.includes("createConnection"), false);
    assert.equal(source.includes("MongoClient"), false);
  });
});
