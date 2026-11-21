// Hotel index-deployment guardrail tests — DB-free.
//
// No MongoDB connection is opened. The deployment CLI is exercised against an
// in-memory fake connection, and the source is checked for forbidden broad
// index-sync/drop behavior.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOTEL_INDEX_MODELS,
  assertHotelDatabaseTarget,
  assertProductionApproval,
  buildIndexPlan,
  databaseNameFromMongoUri,
  detectProductionMarkers,
  inspectIndexPlan,
  parseIndexDeployArgs,
  runIndexDeploymentCli,
} from "../scripts/hotel-deploy-indexes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function src(path) {
  return readFileSync(join(root, path), "utf8");
}

function indexName(key) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");
}

function toActualIndex(name, key, options = {}) {
  const actual = { name, key };
  for (const option of [
    "unique",
    "sparse",
    "expireAfterSeconds",
    "partialFilterExpression",
    "collation",
    "hidden",
  ]) {
    if (options[option] !== undefined) actual[option] = options[option];
  }
  return actual;
}

function createFakeConnection({ extraIndexes = {} } = {}) {
  const state = new Map();

  const connection = {
    name: "bono_hotel",
    models: {},
    model(name, schema, collection) {
      const collectionName = collection ?? `${name.toLowerCase()}s`;
      if (!state.has(collectionName)) {
        state.set(collectionName, [
          { name: "_id_", key: { _id: 1 } },
          ...(extraIndexes[collectionName] ?? []),
        ]);
      }

      const model = {
        schema,
        collection: {
          name: collectionName,
          indexes: async () =>
            state.get(collectionName).map((index) => structuredClone(index)),
        },
        createIndexes: async () => {
          const rows = state.get(collectionName);
          for (const [key, options = {}] of schema.indexes()) {
            const name = options.name || indexName(key);
            if (!rows.some((row) => row.name === name)) {
              rows.push(toActualIndex(name, key, options));
            }
          }
          return [];
        },
      };

      connection.models[name] = model;
      return model;
    },
  };

  return { connection, state };
}

function cleanEnv() {
  return {
    ROOM_MONGODB_URI: "mongodb://127.0.0.1:27017/bono_hotel",
    HOTEL_INDEX_DEPLOY_ENV: "disposable",
  };
}

function capture() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log: (message) => logs.push(String(message)),
    error: (message) => errors.push(String(message)),
  };
}

describe("Hotel index deployment argument and environment guards", () => {
  test("requires --confirm and does not echo unknown arguments", () => {
    assert.deepEqual(parseIndexDeployArgs([]), {
      confirm: false,
      allowProduction: false,
      help: false,
    });
    assert.equal(parseIndexDeployArgs(["--confirm"]).confirm, true);
    assert.equal(
      parseIndexDeployArgs(["--confirm", "--allow-production"])
        .allowProduction,
      true
    );
    assert.throws(
      () => parseIndexDeployArgs(["--password=do-not-echo"]),
      (error) =>
        error instanceof Error &&
        /Unknown argument/.test(error.message) &&
        !error.message.includes("do-not-echo")
    );
  });

  test("detects production markers and requires both approval signals", () => {
    assert.deepEqual(detectProductionMarkers({ NODE_ENV: "production" }), [
      "NODE_ENV",
    ]);
    assert.deepEqual(
      detectProductionMarkers({ HOTEL_INDEX_DEPLOY_ENV: "production" }),
      ["HOTEL_INDEX_DEPLOY_ENV"]
    );
    assert.deepEqual(
      detectProductionMarkers({
        NODE_ENV: "development",
        VERCEL_ENV: "preview",
        HOTEL_INDEX_DEPLOY_ENV: "disposable",
      }),
      []
    );
    assert.deepEqual(detectProductionMarkers({}), [
      "HOTEL_INDEX_DEPLOY_ENV (unset or unrecognized)",
    ]);
    assert.deepEqual(
      detectProductionMarkers({ HOTEL_INDEX_DEPLOY_ENV: "staging" }),
      ["HOTEL_INDEX_DEPLOY_ENV (unset or unrecognized)"]
    );
    assert.deepEqual(
      detectProductionMarkers({ VERCEL_ENV: "preview" }),
      ["HOTEL_INDEX_DEPLOY_ENV (unset or unrecognized)"]
    );

    assert.throws(
      () =>
        assertProductionApproval({
          env: { NODE_ENV: "production" },
          allowProduction: false,
        }),
      /--allow-production/
    );
    assert.throws(
      () =>
        assertProductionApproval({
          env: { NODE_ENV: "production" },
          allowProduction: true,
        }),
      /HOTEL_INDEX_DEPLOY_APPROVAL/
    );

    const approved = assertProductionApproval({
      env: {
        NODE_ENV: "production",
        HOTEL_INDEX_DEPLOY_APPROVAL: "CHG-1234",
      },
      allowProduction: true,
    });
    assert.equal(approved.production, true);
    assert.deepEqual(approved.markers, ["NODE_ENV"]);
    assert.ok(!JSON.stringify(approved).includes("CHG-1234"));
  });

  test("accepts only the bono_hotel database target", () => {
    assert.equal(
      databaseNameFromMongoUri(
        "mongodb://127.0.0.1:27017/bono_hotel"
      ),
      "bono_hotel"
    );
    assert.equal(
      databaseNameFromMongoUri(
        "mongodb+srv://cluster.example/bono_hotel?retryWrites=true"
      ),
      "bono_hotel"
    );
    assert.equal(
      databaseNameFromMongoUri("mongodb://127.0.0.1:27017"),
      ""
    );
    assert.equal(
      assertHotelDatabaseTarget("mongodb://127.0.0.1:27017"),
      "bono_hotel"
    );
    assert.throws(
      () =>
        assertHotelDatabaseTarget(
          "mongodb://127.0.0.1:27017/not_hotel"
        ),
      /bono_hotel/
    );
  });

  test("refuses before connecting when confirmation or configuration is missing", async () => {
    let connected = false;
    const connect = async () => {
      connected = true;
      throw new Error("must not connect");
    };

    const missingConfirm = capture();
    assert.equal(
      await runIndexDeploymentCli([], {
        env: cleanEnv(),
        connect,
        disconnect: async () => {},
        log: missingConfirm.log,
        error: missingConfirm.error,
      }),
      1
    );
    assert.equal(connected, false);
    assert.ok(
      missingConfirm.errors.some((line) => line.includes("--confirm"))
    );

    const missingUri = capture();
    assert.equal(
      await runIndexDeploymentCli(["--confirm"], {
        env: { HOTEL_INDEX_DEPLOY_ENV: "disposable" },
        connect,
        disconnect: async () => {},
        log: missingUri.log,
        error: missingUri.error,
      }),
      1
    );
    assert.equal(connected, false);

    const production = capture();
    assert.equal(
      await runIndexDeploymentCli(["--confirm"], {
        env: { ...cleanEnv(), NODE_ENV: "production" },
        connect,
        disconnect: async () => {},
        log: production.log,
        error: production.error,
      }),
      1
    );
    assert.equal(connected, false);
    assert.ok(
      production.errors.some((line) => line.includes("--allow-production"))
    );

    const wrongDatabase = capture();
    assert.equal(
      await runIndexDeploymentCli(["--confirm"], {
        env: {
          ROOM_MONGODB_URI: "mongodb://127.0.0.1:27017/not_hotel",
          HOTEL_INDEX_DEPLOY_ENV: "disposable",
        },
        connect,
        disconnect: async () => {},
        log: wrongDatabase.log,
        error: wrongDatabase.error,
      }),
      1
    );
    assert.equal(connected, false);
  });
});

describe("Hotel index plan and verification", () => {
  test("the real schemas define 37 indexes across 10 Hotel collections", () => {
    const { connection } = createFakeConnection();
    const plan = buildIndexPlan(connection);

    assert.equal(plan.length, 10);
    assert.equal(
      plan.reduce((sum, entry) => sum + entry.indexes.length, 0),
      37
    );

    const byCollection = Object.fromEntries(
      plan.map((entry) => [entry.collection, entry.indexes])
    );
    const usernameIndex = byCollection.hotel_users.find(
      (index) => index.name === "username_1"
    );
    assert.ok(usernameIndex);
    assert.equal(usernameIndex.options.unique, true);
    assert.deepEqual(usernameIndex.options.partialFilterExpression, {
      username: { $type: "string" },
    });
    assert.ok(byCollection.roomtypes);
    assert.equal(
      byCollection.hotel_sessions.find(
        (index) => index.name === "expiresAt_1"
      ).options.expireAfterSeconds,
      0
    );
    assert.equal(
      byCollection.hotel_payments.find(
        (index) => index.name === "stayId_1_idempotencyKey_1"
      ).options.unique,
      true
    );
    assert.equal(
      byCollection.roomtypes.find((index) => index.name === "code_1")
        .options.unique,
      true
    );
    assert.equal(
      byCollection.hotel_rooms.find(
        (index) => index.name === "roomNumber_1"
      ).options.unique,
      true
    );
    assert.equal(
      byCollection.hotel_stays.find(
        (index) => index.name === "reservationId_1"
      ).options.unique,
      true
    );
  });

  test("a clean fake deployment creates and verifies every schema index", async () => {
    const { connection, state } = createFakeConnection();
    const output = capture();

    const code = await runIndexDeploymentCli(["--confirm"], {
      env: cleanEnv(),
      connect: async () => connection,
      disconnect: async () => {},
      log: output.log,
      error: output.error,
    });

    assert.equal(code, 0);
    assert.deepEqual(output.errors, []);
    const created = [...state.values()]
      .flat()
      .filter((index) => index.name !== "_id_");
    assert.equal(created.length, 37);
    assert.ok(
      output.logs.some((line) =>
        line.includes("Verified 37 schema indexes")
      )
    );
    assert.ok(output.logs.some((line) => line.includes("roomtypes")));
    assert.ok(
      output.logs.some((line) => line.includes('"expireAfterSeconds":0'))
    );
    assert.ok(!output.logs.join("\n").includes("mongodb://"));
  });

  test("unexpected existing indexes block all writes", async () => {
    const { connection, state } = createFakeConnection({
      extraIndexes: {
        hotel_users: [{ name: "manual_1", key: { manual: 1 } }],
      },
    });
    const output = capture();

    const code = await runIndexDeploymentCli(["--confirm"], {
      env: cleanEnv(),
      connect: async () => connection,
      disconnect: async () => {},
      log: output.log,
      error: output.error,
    });

    assert.equal(code, 1);
    assert.ok(
      output.errors.some(
        (line) => line.includes("UNEXPECTED hotel_users manual_1")
      )
    );
    assert.equal(
      state
        .get("hotel_users")
        .some((index) => index.name === "email_1"),
      false
    );
  });

  test("index option mismatches block all writes", async () => {
    const { connection, state } = createFakeConnection({
      extraIndexes: {
        hotel_sessions: [
          {
            name: "expiresAt_1",
            key: { expiresAt: 1 },
            expireAfterSeconds: 3600,
          },
        ],
      },
    });
    const output = capture();

    const code = await runIndexDeploymentCli(["--confirm"], {
      env: cleanEnv(),
      connect: async () => connection,
      disconnect: async () => {},
      log: output.log,
      error: output.error,
    });

    assert.equal(code, 1);
    assert.ok(
      output.errors.some((line) =>
        line.includes("OPTIONS_MISMATCH hotel_sessions expiresAt_1")
      )
    );
    assert.equal(
      state
        .get("hotel_sessions")
        .some((index) => index.name === "tokenHash_1"),
      false
    );
  });

  test("the inspector reports missing, wrong-key, and wrong-name indexes", async () => {
    const { connection, state } = createFakeConnection({
      extraIndexes: {
        hotel_users: [
          { name: "email_1", key: { notEmail: 1 }, unique: true },
          { name: "email_1_alt", key: { email: 1 }, unique: true },
        ],
      },
    });
    const plan = buildIndexPlan(connection);
    const result = await inspectIndexPlan(plan);
    const userIssues = result.issues.filter(
      (issue) => issue.collection === "hotel_users"
    );

    assert.ok(
      userIssues.some(
        (issue) =>
          issue.type === "KEY_MISMATCH" && issue.index === "email_1"
      )
    );
    assert.ok(
      userIssues.some(
        (issue) =>
          issue.type === "NAME_MISMATCH" &&
          issue.expected === "email_1" &&
          issue.actual === "email_1_alt"
      )
    );
    assert.ok(
      userIssues.some(
        (issue) =>
          issue.type === "UNEXPECTED" && issue.index === "email_1_alt"
      )
    );
    assert.ok(
      userIssues.some(
        (issue) =>
          issue.type === "MISSING" &&
          issue.index === "role_1_isActive_1"
      )
    );
    assert.ok(state.get("hotel_users").length >= 3);
  });
});

describe("Hotel index deployment source safety", () => {
  test("uses only Hotel modules and never broad index sync or drops", () => {
    const source = src("scripts/hotel-deploy-indexes.mjs");

    assert.match(source, /--confirm/);
    assert.match(source, /--allow-production/);
    assert.match(source, /HOTEL_INDEX_DEPLOY_APPROVAL/);
    assert.ok(!source.includes("@/lib/mongodb"));
    assert.ok(!source.includes("scripts/sync-indexes.js"));
    assert.ok(!source.includes(".syncIndexes("));
    assert.ok(!source.includes(".dropIndex("));
    assert.ok(!source.includes(".dropIndexes("));
    assert.ok(!source.includes("mongoose.connect"));
    assert.ok(!/^\s*(?:const|let|var)\s+MONGODB_URI\b/m.test(source));
    assert.ok(
      HOTEL_INDEX_MODELS.every((entry) => typeof entry.getModel === "function")
    );
  });
});
