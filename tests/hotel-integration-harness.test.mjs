// Hotel disposable-MongoDB integration harness tests — DB-free.
//
// Every connection, model, and index list below is an in-memory fake. No
// MongoDB connection is opened, no index is created, and no environment file is
// read. All URIs, passwords, tokens, and hashes are synthetic test values.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOTEL_INTEGRATION_DB_NAME,
  HOTEL_INTEGRATION_ENV,
  HOTEL_INTEGRATION_OWNERSHIP_COLLECTION,
  HOTEL_INTEGRATION_OWNERSHIP_ID,
  HOTEL_INTEGRATION_VALUES,
  HotelIntegrationGuardError,
  claimHotelIntegrationTarget,
  verifyHotelIntegrationOwnership,
} from "./helpers/hotel-integration-guard.mjs";
import {
  HOTEL_INTEGRATION_HARNESS_ENV,
  HotelIntegrationHarnessError,
  assertHotelIntegrationCleanupRequest,
  buildHotelIntegrationRuntimeEnvironment,
  createHotelIntegrationFixtures,
  createHotelIntegrationRunId,
  formatHotelIntegrationError,
  inspectHotelIndexReadiness,
  inspectHotelIntegrationOptIn,
  installHotelIntegrationRuntimeEnvironment,
  parseHotelIntegrationCleanupArgs,
  readHotelIntegrationCleanupConfig,
  readHotelIntegrationHarnessOptions,
  readHotelIntegrationIndexWaitOption,
  readHotelIntegrationOwnershipMarker,
  safeHotelIntegrationError,
  safeHotelIntegrationText,
  waitForHotelIndexes,
} from "./helpers/hotel-integration-harness.mjs";
import { runHotelIntegrationCleanupCli } from "./hotel-integration-cleanup.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function src(path) {
  return readFileSync(join(root, path), "utf8");
}

function validEnv(overrides = {}) {
  return {
    [HOTEL_INTEGRATION_ENV.OPT_IN]: HOTEL_INTEGRATION_VALUES.OPT_IN,
    [HOTEL_INTEGRATION_ENV.TARGET_CLASS]:
      HOTEL_INTEGRATION_VALUES.TARGET_CLASS,
    [HOTEL_INTEGRATION_ENV.TARGET_ACK]: HOTEL_INTEGRATION_VALUES.TARGET_ACK,
    [HOTEL_INTEGRATION_ENV.MONGO_URI]:
      "mongodb://127.0.0.1:27018/bono_hotel",
    ...overrides,
  };
}

function cleanupEnv(overrides = {}) {
  return validEnv({
    [HOTEL_INTEGRATION_ENV.CLEANUP_ACK]: HOTEL_INTEGRATION_VALUES.CLEANUP_ACK,
    ...overrides,
  });
}

function markerDoc(overrides = {}) {
  return {
    _id: HOTEL_INTEGRATION_OWNERSHIP_ID,
    runId: "hit-abcdefghijklmnop",
    tokenHash: "a".repeat(64),
    pid: 1234,
    target: {
      host: "127.0.0.1",
      port: 27018,
      databaseName: HOTEL_INTEGRATION_DB_NAME,
    },
    kind: "bono-hotel-disposable-integration-run",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    rawSecret: "must-not-be-returned",
    ...overrides,
  };
}

function expectedTarget(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 27018,
    databaseName: HOTEL_INTEGRATION_DB_NAME,
    ...overrides,
  };
}

function fakeConnection({
  marker = null,
  hello = { ok: 1, isWritablePrimary: true },
  findOneError = null,
} = {}) {
  const collections = new Map();

  const db = {
    databaseName: HOTEL_INTEGRATION_DB_NAME,
    command: async () => hello,
    collection(name) {
      if (!collections.has(name)) {
        collections.set(name, {
          findOne: async (filter) => {
            if (findOneError) throw findOneError;
            if (name !== HOTEL_INTEGRATION_OWNERSHIP_COLLECTION) return null;
            if (filter?._id !== HOTEL_INTEGRATION_OWNERSHIP_ID) return null;
            return marker;
          },
          indexes: async () => [],
        });
      }
      return collections.get(name);
    },
  };

  return {
    readyState: 1,
    name: HOTEL_INTEGRATION_DB_NAME,
    host: "127.0.0.1",
    port: 27018,
    db,
    models: {},
  };
}

function fakeOwnedTargetConnection() {
  const markers = new Map();
  const calls = { insertOne: 0, deleteOne: 0, deleteMany: 0 };

  function matches(document, filter) {
    return Object.entries(filter ?? {}).every(([path, expected]) => {
      const actual = path.split(".").reduce((value, part) => value?.[part], document);
      return actual === expected;
    });
  }

  function markerCollection() {
    return {
      insertOne: async (document) => {
        calls.insertOne += 1;
        markers.set(document._id, { ...document });
        return { acknowledged: true, insertedId: document._id };
      },
      findOne: async (filter) => {
        const document = markers.get(filter?._id);
        return document && matches(document, filter) ? document : null;
      },
      deleteOne: async () => {
        calls.deleteOne += 1;
        return { deletedCount: 1 };
      },
      deleteMany: async () => {
        calls.deleteMany += 1;
        return { acknowledged: true, deletedCount: 0 };
      },
    };
  }

  const connection = {
    readyState: 1,
    name: HOTEL_INTEGRATION_DB_NAME,
    host: "127.0.0.1",
    port: 27018,
    db: {
      databaseName: HOTEL_INTEGRATION_DB_NAME,
      command: async () => ({ ok: 1, isWritablePrimary: true }),
      listCollections: () => ({ toArray: async () => [] }),
      collection: (name) =>
        name === HOTEL_INTEGRATION_OWNERSHIP_COLLECTION
          ? markerCollection()
          : {
              insertOne: async () => {
                throw new Error("the wait must not write test data");
              },
            },
    },
  };

  return { connection, markers, calls };
}

function fakeIndexModel(collection, schemaIndexes, actualIndexes) {
  return {
    collection: {
      name: collection,
      indexes: async () => actualIndexes,
    },
    schema: {
      indexes: () => schemaIndexes,
    },
  };
}

function actualIndex(name, key, options = {}) {
  return { name, key, ...options };
}

describe("Hotel integration opt-in and runtime mapping", () => {
  test("reports no request when no test-only flags are present", () => {
    const state = inspectHotelIntegrationOptIn({});
    assert.equal(state.requested, false);
    assert.match(state.reason, /opt-in/i);
  });

  test("treats any partial test flag as a request", () => {
    assert.equal(
      inspectHotelIntegrationOptIn({ HOTEL_INTEGRATION_TESTS: "1" }).requested,
      true
    );
    assert.equal(
      inspectHotelIntegrationOptIn({
        HOTEL_TEST_MONGODB_URI: "mongodb://127.0.0.1:27018/bono_hotel",
      }).requested,
      true
    );
  });

  test("requires every guard flag before building harness options", () => {
    assert.throws(
      () => readHotelIntegrationHarnessOptions({}),
      (error) =>
        error instanceof HotelIntegrationGuardError &&
        error.code === "ENV_FLAG"
    );

    for (const name of [
      HOTEL_INTEGRATION_ENV.OPT_IN,
      HOTEL_INTEGRATION_ENV.TARGET_CLASS,
      HOTEL_INTEGRATION_ENV.TARGET_ACK,
      HOTEL_INTEGRATION_ENV.MONGO_URI,
    ]) {
      const env = validEnv();
      delete env[name];
      assert.throws(
        () => readHotelIntegrationHarnessOptions(env),
        (error) => error instanceof HotelIntegrationGuardError
      );
    }
  });

  test("rejects inherited POS and generic MongoDB configuration", () => {
    for (const name of [
      "ROOM_MONGODB_URI",
      "MONGODB_URI",
      "MONGO_URI",
      "HOTEL_SESSION_SECRET",
      "AUTH_SECRET",
      "HOTEL_PROVISION_MANAGER_PASSWORD",
      "HOTEL_PROVISION_MANAGER_PIN",
      "HOTEL_PROVISION_PIN",
    ]) {
      assert.throws(
        () => readHotelIntegrationHarnessOptions(validEnv({ [name]: "x" })),
        (error) =>
          error instanceof HotelIntegrationGuardError &&
          error.code === "ENV_INHERITED"
      );
    }
  });

  test("maps only the approved test URI and a generated session secret", () => {
    const env = validEnv();
    const options = readHotelIntegrationHarnessOptions(env);
    const runtime = installHotelIntegrationRuntimeEnvironment({
      config: options.config,
      env,
    });

    assert.equal(env.ROOM_MONGODB_URI, env.HOTEL_TEST_MONGODB_URI);
    assert.equal(typeof env.HOTEL_SESSION_SECRET, "string");
    assert.ok(env.HOTEL_SESSION_SECRET.length >= 32);
    assert.equal(Object.prototype.hasOwnProperty.call(env, "MONGODB_URI"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, "MONGO_URI"), false);
    assert.equal(runtime.installed, true);

    assert.throws(
      () => readHotelIntegrationHarnessOptions(env),
      (error) =>
        error instanceof HotelIntegrationGuardError &&
        error.code === "ENV_INHERITED"
    );

    runtime.restore();
    assert.equal(Object.prototype.hasOwnProperty.call(env, "ROOM_MONGODB_URI"), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(env, "HOTEL_SESSION_SECRET"),
      false
    );
    assert.doesNotThrow(() => readHotelIntegrationHarnessOptions(env));

    runtime.restore();
    assert.equal(
      Object.prototype.hasOwnProperty.call(env, "ROOM_MONGODB_URI"),
      false
    );
  });

  test("can install only the URI mapping for cleanup", () => {
    const env = cleanupEnv();
    const options = readHotelIntegrationCleanupConfig(env);
    const runtime = installHotelIntegrationRuntimeEnvironment({
      config: options,
      env,
      includeSessionSecret: false,
    });

    assert.equal(env.ROOM_MONGODB_URI, env.HOTEL_TEST_MONGODB_URI);
    assert.equal(
      Object.prototype.hasOwnProperty.call(env, "HOTEL_SESSION_SECRET"),
      false
    );
    runtime.restore();
  });

  test("rejects a hand-built config whose target does not match its URI", () => {
    const options = readHotelIntegrationHarnessOptions(validEnv());
    assert.throws(
      () =>
        buildHotelIntegrationRuntimeEnvironment({
          config: {
            mongoUri: options.config.mongoUri,
            target: expectedTarget({ port: 27019 }),
          },
        }),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "RUNTIME_CONFIG"
    );
  });

  test("accepts only the exact index-wait flag", () => {
    assert.equal(readHotelIntegrationIndexWaitOption({}), false);
    assert.equal(
      readHotelIntegrationIndexWaitOption({
        [HOTEL_INTEGRATION_HARNESS_ENV.WAIT_FOR_INDEXES]: "1",
      }),
      true
    );
    for (const value of ["true", "yes", "0", "2"]) {
      assert.throws(
        () =>
          readHotelIntegrationIndexWaitOption({
            [HOTEL_INTEGRATION_HARNESS_ENV.WAIT_FOR_INDEXES]: value,
          }),
        (error) =>
          error instanceof HotelIntegrationHarnessError &&
          error.code === "INDEX_WAIT_FLAG"
      );
    }
  });
});

describe("Hotel integration fixture naming", () => {
  test("generates a guard-compatible run identifier", () => {
    const runId = createHotelIntegrationRunId({
      now: 1_700_000_000_000,
      randomBytes: () => Buffer.alloc(12, 0xab),
    });
    assert.match(runId, /^hit-[a-z0-9]+-[0-9a-f]{24}$/);
    assert.match(runId, /^[A-Za-z0-9_-]{16,128}$/);

    const other = createHotelIntegrationRunId({
      now: 1_700_000_000_001,
      randomBytes: () => Buffer.alloc(12, 0xcd),
    });
    assert.notEqual(runId, other);
  });

  test("produces valid, run-scoped fixture values", () => {
    const runId = createHotelIntegrationRunId({
      now: 1_700_000_000_000,
      randomBytes: () => Buffer.alloc(12, 0x12),
    });
    const fixtures = createHotelIntegrationFixtures(runId);

    assert.match(fixtures.roomTypeCode("STD"), /^[A-Z0-9][A-Z0-9_-]{0,29}$/);
    assert.match(fixtures.roomNumber(1), /^[A-Z0-9][A-Z0-9-]{0,19}$/);
    assert.match(fixtures.guestPhone(1), /^\+?[0-9][0-9()\-\s]{2,29}$/);
    assert.match(
      fixtures.guestEmail("GUEST", 1),
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    );
    assert.match(
      fixtures.idempotencyKey("PAY", 1),
      /^[A-Za-z0-9._:-]+$/
    );
    assert.ok(fixtures.roomTypeCode("STD").includes(fixtures.runTag));
    assert.ok(fixtures.roomNumber(1).includes(fixtures.runTag));
    assert.ok(
      fixtures.guestEmail("GUEST", 1).includes(fixtures.runTag.toLowerCase())
    );
  });

  test("keeps fixture values disjoint across runs", () => {
    const first = createHotelIntegrationFixtures(
      createHotelIntegrationRunId({
        now: 1,
        randomBytes: () => Buffer.alloc(12, 0x01),
      })
    );
    const second = createHotelIntegrationFixtures(
      createHotelIntegrationRunId({
        now: 2,
        randomBytes: () => Buffer.alloc(12, 0x02),
      })
    );

    assert.notEqual(first.roomTypeCode("STD"), second.roomTypeCode("STD"));
    assert.notEqual(first.roomNumber(1), second.roomNumber(1));
    assert.notEqual(
      first.guestEmail("GUEST", 1),
      second.guestEmail("GUEST", 1)
    );
    assert.notEqual(
      first.idempotencyKey("PAY", 1),
      second.idempotencyKey("PAY", 1)
    );
  });

  test("rejects an invalid run identifier", () => {
    assert.throws(
      () => createHotelIntegrationFixtures("short"),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "RUN_ID"
    );
  });
});

describe("Hotel integration failure redaction", () => {
  test("removes URIs, credentials, tokens, hashes, cookies, and secrets", () => {
    const token = "A".repeat(43);
    const hash = "b".repeat(64);
    const text = [
      "mongodb://user:password@127.0.0.1:27018/bono_hotel",
      "password=hunter2",
      "Authorization: Bearer abc.def.ghi",
      token,
      hash,
      "scrypt$32768$8$1$c2FsdA$aGFzaA",
      "__Host-bono_hotel_session=cookie-value",
      "x-hotel-csrf-token: csrf-value",
    ].join(" ");

    const safe = safeHotelIntegrationText(text, { secrets: ["hunter2"] });

    assert.equal(safe.includes("mongodb://"), false);
    assert.equal(safe.includes("password@"), false);
    assert.equal(safe.includes("hunter2"), false);
    assert.equal(safe.includes("abc.def.ghi"), false);
    assert.equal(safe.includes(token), false);
    assert.equal(safe.includes(hash), false);
    assert.equal(safe.includes("scrypt$"), false);
    assert.equal(safe.includes("cookie-value"), false);
    assert.equal(safe.includes("csrf-value"), false);
    assert.match(safe, /\[redacted-mongodb-uri\]/);
  });

  test("returns a narrow error summary without stack, cause, or raw fields", () => {
    const error = new Error("token=super-secret-value");
    error.code = "SAFE_CODE";
    error.stack = "STACK MUST NOT LEAK";
    error.cause = { secret: "CAUSE MUST NOT LEAK" };
    error.rawDocument = { password: "RAW MUST NOT LEAK" };

    const safe = safeHotelIntegrationError(error, {
      secrets: ["super-secret-value"],
    });

    assert.deepEqual(Object.keys(safe).sort(), ["code", "message", "name"]);
    assert.equal(safe.code, "SAFE_CODE");
    assert.equal(safe.name, "HotelIntegrationError");
    assert.equal(safe.message.includes("super-secret-value"), false);
    assert.equal(JSON.stringify(safe).includes("STACK"), false);
    assert.equal(JSON.stringify(safe).includes("CAUSE"), false);
    assert.equal(JSON.stringify(safe).includes("RAW"), false);
    assert.match(formatHotelIntegrationError(error), /^SAFE_CODE: /);
  });

  test("uses a safe fallback code for an untrusted error code", () => {
    const error = new Error("failure");
    error.code = "NOT A SAFE CODE";
    const safe = safeHotelIntegrationError(error);
    assert.equal(safe.code, "INTEGRATION_ERROR");
  });
});

describe("Hotel integration cleanup request validation", () => {
  test("requires exactly one --confirm argument", () => {
    assert.deepEqual(parseHotelIntegrationCleanupArgs(["--confirm"]), {
      confirm: true,
    });
    assert.throws(
      () => parseHotelIntegrationCleanupArgs([]),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "CLEANUP_CONFIRM_REQUIRED"
    );
    assert.throws(
      () => parseHotelIntegrationCleanupArgs(["--confirm", "--confirm"]),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "CLEANUP_ARGS"
    );
  });

  test("does not echo an unknown cleanup argument", () => {
    assert.throws(
      () => parseHotelIntegrationCleanupArgs(["--password=do-not-echo"]),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "CLEANUP_ARGS" &&
        error.message.includes("do-not-echo") === false
    );
  });

  test("requires the exact cleanup confirmation environment value", () => {
    assert.throws(
      () => readHotelIntegrationCleanupConfig(validEnv()),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "CLEANUP_NOT_ALLOWED"
    );

    const config = readHotelIntegrationCleanupConfig(cleanupEnv());
    assert.equal(config.target.databaseName, HOTEL_INTEGRATION_DB_NAME);

    const request = assertHotelIntegrationCleanupRequest({
      argv: ["--confirm"],
      env: cleanupEnv(),
    });
    assert.equal(request.confirm, true);
    assert.equal(request.config.target.port, 27018);
  });

  test("does not connect when confirmation is missing", async () => {
    let connected = false;
    const errors = [];

    const code = await runHotelIntegrationCleanupCli({
      argv: [],
      env: cleanupEnv(),
      connect: async () => {
        connected = true;
        throw new Error("must not connect");
      },
      disconnect: async () => {},
      log: () => {},
      errorLog: (message) => errors.push(String(message)),
    });

    assert.equal(code, 2);
    assert.equal(connected, false);
    assert.equal(errors.join("\n").includes("mongodb://"), false);
  });

  test("does not connect without the cleanup environment acknowledgement", async () => {
    let connected = false;

    const code = await runHotelIntegrationCleanupCli({
      argv: ["--confirm"],
      env: validEnv(),
      connect: async () => {
        connected = true;
        throw new Error("must not connect");
      },
      disconnect: async () => {},
      log: () => {},
      errorLog: () => {},
    });

    assert.equal(code, 2);
    assert.equal(connected, false);
  });

  test("redacts a connection failure and restores the environment", async () => {
    const env = cleanupEnv();
    const errors = [];

    const code = await runHotelIntegrationCleanupCli({
      argv: ["--confirm"],
      env,
      connect: async () => {
        throw new Error(
          "connect failed mongodb://user:password@127.0.0.1:27018/bono_hotel"
        );
      },
      disconnect: async () => {
        throw new Error("must not disconnect");
      },
      log: () => {},
      errorLog: (message) => errors.push(String(message)),
    });

    const output = errors.join("\n");
    assert.equal(code, 1);
    assert.equal(output.includes("mongodb://"), false);
    assert.equal(output.includes("password"), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(env, "ROOM_MONGODB_URI"),
      false
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(env, "HOTEL_SESSION_SECRET"),
      false
    );
  });
});

describe("Hotel integration index readiness", () => {
  test("reports ready when every expected index is present", async () => {
    const model = fakeIndexModel(
      "hotel_sample",
      [
        [{ code: 1 }, { unique: true }],
        [{ name: 1, isActive: 1 }, {}],
      ],
      [
        actualIndex("_id_", { _id: 1 }),
        actualIndex("code_1", { code: 1 }, { unique: true }),
        actualIndex("name_1_isActive_1", { name: 1, isActive: 1 }),
      ]
    );

    const readiness = await inspectHotelIndexReadiness({
      connection: {},
      models: [model],
    });

    assert.equal(readiness.ready, true);
    assert.equal(readiness.expectedCount, 2);
    assert.deepEqual(readiness.checkedCollections, ["hotel_sample"]);
    assert.deepEqual(readiness.missing, []);
    assert.deepEqual(readiness.issues, []);
  });

  test("reports missing indexes without throwing", async () => {
    const model = fakeIndexModel(
      "hotel_sample",
      [[{ code: 1 }, { unique: true }]],
      [actualIndex("_id_", { _id: 1 })]
    );

    const readiness = await inspectHotelIndexReadiness({
      connection: {},
      models: [model],
    });

    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.missing, [
      { collection: "hotel_sample", index: "code_1" },
    ]);
  });

  test("treats a missing namespace as a missing index", async () => {
    const model = {
      collection: {
        name: "hotel_missing",
        indexes: async () => {
          const error = new Error("namespace not found");
          error.code = 26;
          throw error;
        },
      },
      schema: {
        indexes: () => [[{ code: 1 }, { unique: true }]],
      },
    };

    const readiness = await inspectHotelIndexReadiness({
      connection: {},
      models: [model],
    });

    assert.equal(readiness.ready, false);
    assert.equal(readiness.missing.length, 1);
  });

  test("reports unexpected, key, unique, and TTL mismatches safely", async () => {
    const model = fakeIndexModel(
      "hotel_sample",
      [
        [{ code: 1 }, { unique: true }],
        [{ expiresAt: 1 }, { expireAfterSeconds: 0 }],
      ],
      [
        actualIndex("_id_", { _id: 1 }),
        actualIndex("code_1", { code: -1 }),
        actualIndex("expiresAt_1", { expiresAt: 1 }, { expireAfterSeconds: 60 }),
        actualIndex("extra_1", { extra: 1 }),
      ]
    );

    const readiness = await inspectHotelIndexReadiness({
      connection: {},
      models: [model],
    });

    assert.equal(readiness.ready, false);
    assert.deepEqual(
      readiness.issues.map((issue) => issue.type).sort(),
      ["KEY_MISMATCH", "TTL_MISMATCH", "UNEXPECTED"]
    );
    assert.equal(JSON.stringify(readiness).includes("actualKey"), false);
  });

  test("reports a unique-option mismatch", async () => {
    const model = fakeIndexModel(
      "hotel_sample",
      [[{ code: 1 }, { unique: true }]],
      [actualIndex("code_1", { code: 1 })]
    );

    const readiness = await inspectHotelIndexReadiness({
      connection: {},
      models: [model],
    });

    assert.equal(readiness.ready, false);
    assert.deepEqual(
      readiness.issues.map((issue) => issue.type),
      ["UNIQUE_MISMATCH"]
    );
  });

  test("waits read-only until readiness is confirmed", async () => {
    let indexCalls = 0;
    let sleeps = 0;
    let time = 0;

    const model = {
      collection: {
        name: "hotel_sample",
        indexes: async () => {
          indexCalls += 1;
          if (indexCalls === 1) return [actualIndex("_id_", { _id: 1 })];
          return [
            actualIndex("_id_", { _id: 1 }),
            actualIndex("code_1", { code: 1 }, { unique: true }),
          ];
        },
      },
      schema: {
        indexes: () => [[{ code: 1 }, { unique: true }]],
      },
    };

    const readiness = await waitForHotelIndexes({
      connection: {},
      models: [model],
      timeoutMs: 100,
      intervalMs: 10,
      now: () => {
        time += 10;
        return time;
      },
      sleep: async () => {
        sleeps += 1;
      },
    });

    assert.equal(readiness.ready, true);
    assert.equal(indexCalls, 2);
    assert.equal(sleeps, 1);
  });

  test("times out with a safe error and never mutates indexes", async () => {
    let time = 0;
    const model = fakeIndexModel(
      "hotel_sample",
      [[{ code: 1 }, { unique: true }]],
      [actualIndex("_id_", { _id: 1 })]
    );

    await assert.rejects(
      () =>
        waitForHotelIndexes({
          connection: {},
          models: [model],
          timeoutMs: 100,
          intervalMs: 10,
          now: () => {
            time += 100;
            return time;
          },
          sleep: async () => {
            throw new Error("sleep must not be reached after timeout");
          },
        }),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "INDEX_WAIT_TIMEOUT"
    );
  });

  test("rejects an invalid index model without exposing its contents", async () => {
    await assert.rejects(
      () =>
        inspectHotelIndexReadiness({
          connection: {},
          models: [{ schema: { indexes: () => [] } }],
        }),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "INDEX_MODEL"
    );
  });
});

describe("Hotel integration ownership marker reading", () => {
  test("returns only the safe ownership fields", async () => {
    const marker = await readHotelIntegrationOwnershipMarker({
      connection: fakeConnection({ marker: markerDoc() }),
      expectedTarget: expectedTarget(),
    });

    assert.deepEqual(Object.keys(marker).sort(), [
      "collectionName",
      "pid",
      "runId",
      "target",
      "tokenHash",
    ]);
    assert.equal(marker.collectionName, HOTEL_INTEGRATION_OWNERSHIP_COLLECTION);
    assert.equal(marker.runId, "hit-abcdefghijklmnop");
    assert.equal(marker.pid, 1234);
    assert.equal(marker.target.host, "127.0.0.1");
    assert.equal(marker.target.port, 27018);
    assert.equal(marker.target.databaseName, HOTEL_INTEGRATION_DB_NAME);
    assert.equal(Object.prototype.hasOwnProperty.call(marker, "rawSecret"), false);
  });

  test("refuses a missing marker", async () => {
    await assert.rejects(
      () =>
        readHotelIntegrationOwnershipMarker({
          connection: fakeConnection({ marker: null }),
          expectedTarget: expectedTarget(),
        }),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "OWNERSHIP_NOT_FOUND"
    );
  });

  test("refuses a marker for a different target", async () => {
    await assert.rejects(
      () =>
        readHotelIntegrationOwnershipMarker({
          connection: fakeConnection({
            marker: markerDoc({
              target: {
                host: "127.0.0.1",
                port: 27019,
                databaseName: HOTEL_INTEGRATION_DB_NAME,
              },
            }),
          }),
          expectedTarget: expectedTarget(),
        }),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "OWNERSHIP_MISMATCH"
    );
  });

  test("refuses an incomplete marker", async () => {
    for (const overrides of [
      { runId: "short" },
      { tokenHash: "not-a-hash" },
      { pid: 0 },
    ]) {
      await assert.rejects(
        () =>
          readHotelIntegrationOwnershipMarker({
            connection: fakeConnection({ marker: markerDoc(overrides) }),
            expectedTarget: expectedTarget(),
          }),
        (error) =>
          error instanceof HotelIntegrationHarnessError &&
          error.code === "OWNERSHIP_INVALID"
      );
    }
  });

  test("refuses an unreadable marker", async () => {
    await assert.rejects(
      () =>
        readHotelIntegrationOwnershipMarker({
          connection: fakeConnection({
            marker: markerDoc(),
            findOneError: new Error("read failed"),
          }),
          expectedTarget: expectedTarget(),
        }),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "OWNERSHIP_READ_FAILED"
    );
  });

  test("re-verifies the live target before reading the marker", async () => {
    const connection = fakeConnection({ marker: markerDoc() });
    connection.readyState = 0;

    await assert.rejects(
      () =>
        readHotelIntegrationOwnershipMarker({
          connection,
          expectedTarget: expectedTarget(),
        }),
      (error) =>
        error instanceof HotelIntegrationGuardError &&
        error.code === "TARGET_NOT_CONNECTED"
    );
  });
});

describe("Hotel integration preflight ordering", () => {
  test("waits for indexes after ownership is claimed and before fixture users", () => {
    const source = src("tests/hotel-integration.test.mjs");
    const beforeStart = source.indexOf("before(async () => {");
    const afterStart = source.indexOf("after(async () => {");

    assert.ok(beforeStart >= 0, "the integration file must define a before hook");
    assert.ok(afterStart > beforeStart, "the after hook must follow the before hook");

    const before = source.slice(beforeStart, afterStart);
    const positions = {
      options: before.indexOf("waitForIndexes = options.waitForIndexes;"),
      connect: before.indexOf("connection = await connectToHotelDatabase();"),
      verify: before.indexOf("await verifyHotelIntegrationConnection({"),
      claim: before.indexOf("ownership = await claimHotelIntegrationTarget({"),
      wait: before.indexOf("await waitForHotelIndexes({"),
      fixtures: before.indexOf(
        "fixtures = createHotelIntegrationFixtures(runId);"
      ),
      manager: before.indexOf(
        "const managerUser = await createIntegrationUser("
      ),
      receptionist: before.indexOf(
        "const receptionistUser = await createIntegrationUser("
      ),
    };

    for (const [name, index] of Object.entries(positions)) {
      assert.ok(index >= 0, `before hook must contain the ${name} step`);
    }

    const ordered = [
      "options",
      "connect",
      "verify",
      "claim",
      "wait",
      "fixtures",
      "manager",
      "receptionist",
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      assert.ok(
        positions[previous] < positions[current],
        `${previous} must happen before ${current}`
      );
    }

    // The wait is explicit opt-in and is the only wait in the file. A later
    // test must not duplicate it or imply that readiness was checked late.
    assert.match(
      before,
      /if \(waitForIndexes\) \{\s*preflightIndexReadiness = await waitForHotelIndexes\(\{/
    );
    assert.equal(
      source.match(/waitForHotelIndexes\s*\(/g)?.length,
      1,
      "the integration file must wait for indexes exactly once, during preflight"
    );
  });

  test("does not catch, clean up, or release ownership after a wait failure", () => {
    const source = src("tests/hotel-integration.test.mjs");
    const beforeStart = source.indexOf("before(async () => {");
    const afterStart = source.indexOf("after(async () => {");
    const describeStart = source.indexOf("describe(", afterStart);

    assert.ok(beforeStart >= 0 && afterStart > beforeStart);
    assert.ok(describeStart > afterStart);

    const before = source.slice(beforeStart, afterStart);
    const waitStart = before.indexOf("if (waitForIndexes) {");
    const waitEnd = before.indexOf(
      "fixtures = createHotelIntegrationFixtures(runId);",
      waitStart
    );
    const waitBlock = before.slice(waitStart, waitEnd);

    assert.ok(waitStart >= 0 && waitEnd > waitStart);
    assert.equal(waitBlock.includes("catch"), false);
    assert.equal(waitBlock.includes("finally"), false);
    assert.equal(waitBlock.includes("cleanup"), false);
    assert.equal(waitBlock.includes("delete"), false);
    assert.equal(waitBlock.includes("disconnect"), false);

    const afterHook = source.slice(afterStart, describeStart);
    assert.match(afterHook, /disconnectHotelDatabase/);
    assert.equal(afterHook.includes("cleanup"), false);
    assert.equal(afterHook.includes("delete"), false);
    assert.equal(afterHook.includes("drop"), false);

    // The separate cleanup command is never imported or called by this file.
    assert.equal(source.includes("cleanupHotelIntegrationTarget"), false);
  });

  test("a readiness timeout retains the claimed marker and deletes nothing", async () => {
    const { connection, markers, calls } = fakeOwnedTargetConnection();
    const target = expectedTarget();
    const runId = "hit-preflight-timeout01";
    const ownership = await claimHotelIntegrationTarget({
      connection,
      expectedTarget: target,
      runId,
    });

    assert.equal(markers.size, 1);
    assert.equal(calls.insertOne, 1);

    const model = fakeIndexModel(
      "hotel_sample",
      [[{ code: 1 }, { unique: true }]],
      [actualIndex("_id_", { _id: 1 })]
    );
    let time = 0;

    await assert.rejects(
      () =>
        waitForHotelIndexes({
          connection,
          models: [model],
          timeoutMs: 100,
          intervalMs: 10,
          now: () => {
            time += 100;
            return time;
          },
          sleep: async () => {
            throw new Error("sleep must not be reached after timeout");
          },
        }),
      (error) =>
        error instanceof HotelIntegrationHarnessError &&
        error.code === "INDEX_WAIT_TIMEOUT"
    );

    // The failed preflight must not release the marker or delete any data.
    assert.equal(markers.size, 1);
    assert.equal(markers.get(HOTEL_INTEGRATION_OWNERSHIP_ID).runId, runId);
    assert.equal(calls.deleteOne, 0);
    assert.equal(calls.deleteMany, 0);

    const verified = await verifyHotelIntegrationOwnership({
      connection,
      expectedTarget: target,
      ownership,
    });
    assert.equal(verified.owned, true);
  });
});

describe("Hotel integration harness source safety", () => {
  test("helper is DB-free, guard-backed, and has no broad index or cleanup calls", () => {
    const source = src("tests/helpers/hotel-integration-harness.mjs");

    assert.match(source, /hotel-integration-guard\.mjs/);
    assert.equal(source.includes("mongoose"), false);
    assert.equal(source.includes("connectToHotelDatabase"), false);
    assert.equal(source.includes("process.env.MONGODB_URI"), false);
    assert.equal(source.includes("process.env.MONGO_URI"), false);
    for (const forbidden of [
      "dropDatabase",
      "dropCollection",
      "dropIndexes",
      "syncIndexes",
      "createIndexes",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `helper source must not contain ${forbidden}`
      );
    }
  });

  test("integration test never cleans up or imports the deployment script", () => {
    const source = src("tests/hotel-integration.test.mjs");

    assert.match(source, /hotel-integration-guard\.mjs/);
    assert.match(source, /hotel-integration-harness\.mjs/);
    assert.equal(source.includes("cleanupHotelIntegrationTarget"), false);
    assert.equal(source.includes("hotel-deploy-indexes"), false);
    assert.equal(source.includes("process.on("), false);
    for (const forbidden of [
      "dropDatabase",
      "dropCollection",
      "dropIndexes",
      "syncIndexes",
      "createIndexes",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `integration test source must not contain ${forbidden}`
      );
    }

    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1]
    );
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith("node:") ||
          specifier.startsWith("../lib/hotel/") ||
          specifier.startsWith("./helpers/"),
        `unexpected integration-test import: ${specifier}`
      );
    }
  });

  test("cleanup command is guard-backed and only runs when invoked directly", () => {
    const source = src("tests/hotel-integration-cleanup.mjs");

    assert.match(source, /cleanupHotelIntegrationTarget/);
    assert.match(source, /isMainModule/);
    assert.match(source, /--confirm/);
    assert.match(source, /HOTEL_TEST_ALLOW_CLEANUP|CLEANUP_ACK/);
    assert.equal(source.includes("process.on("), false);
    for (const forbidden of [
      "dropDatabase",
      "dropCollection",
      "dropIndexes",
      "syncIndexes",
      "createIndexes",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `cleanup source must not contain ${forbidden}`
      );
    }
  });

  test("harness collection list remains the guard's ten-collection allowlist", () => {
    const source = src("tests/helpers/hotel-integration-harness.mjs");
    assert.match(
      source,
      /HOTEL_INTEGRATION_HARNESS_COLLECTIONS\s*=\s*HOTEL_INTEGRATION_COLLECTIONS/
    );
  });
});
