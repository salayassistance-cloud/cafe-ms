// BONO Inventory V2 — Phase 2.0 foundation tests.
//
// DB-FREE ONLY: no MongoDB/Mongoose connection is opened, no environment file
// is read, and no application/API/model code is imported. Transaction behaviour
// is proven against stub sessions; this is NOT a claim that a real MongoDB
// replica set was exercised.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as domainBarrel from "../lib/inventory-v2/domain/index.js";
import {
  assertServerOnly,
  isServerOnlyViolation,
  isServerRuntime,
} from "../lib/inventory-v2/server/boundary.js";
import {
  TRANSACTION_ERROR_CODES,
  UNKNOWN_COMMIT_RESOLUTIONS,
  classifyTransactionError,
  computeBackoffMs,
  isTransactionsUnsupportedError,
  isTransientTransactionError,
  isUnknownTransactionCommitResult,
  runV2Transaction,
} from "../lib/inventory-v2/server/transaction.js";
import {
  V2_COLLECTIONS,
  V2_FORBIDDEN_CHALLENGE_UNIQUE_KEY,
  V2_INDEX_CLASSIFICATIONS,
  V2_INDEX_PLAN,
  assertV2IndexPlan,
  indexKeySignature,
  validateV2IndexPlan,
} from "../lib/inventory-v2/server/indexPlan.js";
import {
  CANCEL_ORDER_ITEM_UPDATED_AT_ANALYSIS,
  ORDER_MUTATION_INVENTORY,
  ORDER_VERSION_CONTRACT,
  validateOrderMutationInventory,
} from "../lib/inventory-v2/server/orderMutationInventory.js";
import {
  INVENTORY_MODES,
  INVENTORY_OWNERSHIP_ERRORS,
  RESERVED_STOCK_WRITERS,
  SHARED_STOCK_INVARIANTS,
  assertClearOrdersV2Safe,
  assertExactlyOneInventoryOwner,
  assertV1OwnedOrder,
  assertV2OwnedOrder,
  evaluateClearOrdersSafety,
  normalizeInventoryMode,
} from "../lib/inventory-v2/server/ownership.js";
import {
  APPROVAL_ENV,
  CliError,
  assertProductionApproval,
  buildExpectedPlan,
  detectProductionMarkers,
  inspectCollectionIndexes,
  parseDeployArgs,
  runIndexDeploymentCli,
} from "../scripts/inventory-v2-deploy-indexes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

// Documentation comments may mention forbidden names deliberately. Only the
// executable source (comments stripped) is evidence of an export/import.
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir) {
  const absolute = join(root, dir);
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(rel));
    else files.push(rel);
  }
  return files;
}

const normalizePath = (path) => path.split(sep).join("/");

// ---------------------------------------------------------------------------
// Stub transaction harness
// ---------------------------------------------------------------------------

function labelledError(label, message = label) {
  const error = new Error(message);
  error.errorLabels = [label];
  error.hasErrorLabel = (candidate) => candidate === label;
  return error;
}

function transientError() {
  return labelledError("TransientTransactionError", "transient");
}

function unknownCommitError() {
  return labelledError("UnknownTransactionCommitResult", "unknown commit");
}

function unsupportedError() {
  return Object.assign(
    new Error(
      "Transaction numbers are only allowed on a replica set member or mongos"
    ),
    { code: 20 }
  );
}

function makeSession({ commitError, startError, abortError, endError } = {}) {
  const calls = [];
  return {
    calls,
    startTransaction() {
      calls.push("startTransaction");
      if (startError) throw startError;
    },
    async commitTransaction() {
      calls.push("commitTransaction");
      if (commitError) throw commitError;
    },
    async abortTransaction() {
      calls.push("abortTransaction");
      if (abortError) throw abortError;
    },
    async endSession() {
      calls.push("endSession");
      if (endError) throw endError;
    },
  };
}

function makeHarness(plans = []) {
  const sessions = [];
  let index = 0;
  const connection = {
    async startSession() {
      const plan = plans[index] ?? {};
      index += 1;
      const session = makeSession(plan);
      sessions.push(session);
      return session;
    },
  };
  return { connection, sessions };
}

function assertEnded(session) {
  assert.ok(
    session.calls.includes("endSession"),
    `session was not ended: ${session.calls.join(", ")}`
  );
}

function baseOptions(overrides = {}) {
  return {
    actionIdentity: "action-1",
    fingerprint: "fingerprint-1",
    operation: async () => "ok",
    resolveOutcome: async () => ({ status: "UNRESOLVED" }),
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Server-only boundary
// ---------------------------------------------------------------------------

describe("server-only boundary", () => {
  test("the runtime guard is a no-op in Node and fails closed with a window", () => {
    assert.equal(isServerRuntime(), true);
    assert.equal(isServerOnlyViolation(), false);
    assert.doesNotThrow(() => assertServerOnly("test module"));

    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
    const previous = globalThis.window;
    globalThis.window = {};
    try {
      assert.throws(
        () => assertServerOnly("test module"),
        /server-only and must never be imported into a client bundle/
      );
      assert.equal(isServerOnlyViolation(), true);
    } finally {
      if (hadWindow) globalThis.window = previous;
      else delete globalThis.window;
    }
  });

  test("every V2 server module calls assertServerOnly", () => {
    const serverFiles = walk("lib/inventory-v2/server")
      .map(normalizePath)
      .filter(
        (file) =>
          file.endsWith(".js") &&
          !file.endsWith("/boundary.js") &&
          !file.endsWith("/index.js")
      );
    assert.ok(serverFiles.length >= 4);
    for (const file of serverFiles) {
      assert.match(read(file), /assertServerOnly\(/, `${file} is unguarded`);
    }
  });

  test("the public domain barrel remains issuer-free", () => {
    const barrel = stripComments(read("lib/inventory-v2/domain/index.js"));
    for (const forbidden of [
      "issueManagerActionAuthorization",
      "issueWasteManagerAuthorization",
      "resetWasteCorrectionLedger",
    ]) {
      assert.ok(!barrel.includes(forbidden), `domain barrel exports ${forbidden}`);
      assert.ok(
        !(forbidden in domainBarrel),
        `domain namespace unexpectedly exposes ${forbidden}`
      );
    }
  });

  test("the server barrel does not re-export trusted issuers", () => {
    const barrel = stripComments(read("lib/inventory-v2/server/index.js"));
    for (const forbidden of [
      "issueManagerActionAuthorization",
      "issueWasteManagerAuthorization",
      "resetWasteCorrectionLedger",
    ]) {
      assert.ok(!barrel.includes(forbidden), `server barrel exports ${forbidden}`);
    }
  });

  test("no client component or page imports the V2 server boundary", () => {
    const clientFiles = [
      ...walk("app/components"),
      ...walk("app").filter((file) => /\/page\.(js|jsx|ts|tsx)$/.test(normalizePath(file))),
      ...walk("app").filter((file) => /Client\.(js|jsx|ts|tsx)$/.test(file)),
    ].map(normalizePath);
    assert.ok(clientFiles.length > 0);
    for (const file of new Set(clientFiles)) {
      const text = read(file);
      assert.ok(
        !/lib\/inventory-v2\/server/.test(text),
        `${file} imports the V2 server boundary`
      );
    }
  });

  test("no application or non-V2 library module imports inventory-v2", () => {
    const files = [...walk("app"), ...walk("lib")]
      .map(normalizePath)
      .filter(
        (file) =>
          (file.startsWith("app/") || file.startsWith("lib/")) &&
          !file.startsWith("lib/inventory-v2/") &&
          /\.(js|jsx|mjs|ts|tsx)$/.test(file)
      );
    const importPattern =
      /(?:from\s+|import\s*\(\s*|^\s*import\s+)["'][^"']*inventory-v2[^"']*["']/m;
    for (const file of files) {
      assert.ok(!importPattern.test(read(file)), `${file} imports inventory-v2`);
    }
  });

  test("the domain layer stays free of database and server imports", () => {
    const domainFiles = walk("lib/inventory-v2/domain")
      .map(normalizePath)
      .filter((file) => file.endsWith(".js"));
    assert.ok(domainFiles.length >= 8);
    for (const file of domainFiles) {
      const text = read(file);
      assert.ok(!/\bmongoose\b/.test(text), `${file} imports mongoose`);
      assert.ok(
        !/inventory-v2\/server/.test(text),
        `${file} imports the server boundary`
      );
      assert.ok(
        !/from\s+["'](?:node:)?fs["']/.test(text),
        `${file} performs filesystem I/O`
      );
    }
  });

  test("ESLint enforces the boundary for client files", () => {
    const config = read("eslint.config.mjs");
    assert.match(config, /no-restricted-imports/);
    assert.match(config, /lib\/inventory-v2\/server/);
    assert.match(config, /app\/components/);
    assert.match(config, /app\/\*\*\/page/);
  });
});

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

describe("transaction helper", () => {
  test("successful commit returns the operation result and cleans up", async () => {
    const { connection, sessions } = makeHarness([{}]);
    const result = await runV2Transaction(
      connection,
      baseOptions({
        operation: async (_session, context) => {
          assert.equal(context.actionIdentity, "action-1");
          assert.equal(context.fingerprint, "fingerprint-1");
          return { committed: true };
        },
      })
    );
    assert.deepEqual(result, { committed: true });
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0].calls, [
      "startTransaction",
      "commitTransaction",
      "endSession",
    ]);
  });

  test("transient transaction errors retry with the same action identity", async () => {
    const { connection, sessions } = makeHarness([{}, {}]);
    const identities = [];
    const sleeps = [];
    let attempts = 0;
    const result = await runV2Transaction(
      connection,
      baseOptions({
        actionIdentity: "stable-action",
        fingerprint: "stable-fingerprint",
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 10,
        sleep: async (ms) => sleeps.push(ms),
        operation: async (_session, context) => {
          attempts += 1;
          identities.push([
            context.actionIdentity,
            context.fingerprint,
            context.attempt,
          ]);
          if (attempts === 1) throw transientError();
          return "recovered";
        },
      })
    );
    assert.equal(result, "recovered");
    assert.equal(attempts, 2);
    assert.deepEqual(identities, [
      ["stable-action", "stable-fingerprint", 1],
      ["stable-action", "stable-fingerprint", 2],
    ]);
    assert.equal(sleeps.length, 1);
    assert.equal(sessions.length, 2);
    assert.ok(sessions[0].calls.includes("abortTransaction"));
    assertEnded(sessions[0]);
    assertEnded(sessions[1]);
  });

  test("bounded retries are exhausted without exceeding maxAttempts", async () => {
    const { connection, sessions } = makeHarness([{}, {}, {}]);
    let attempts = 0;
    await assert.rejects(
      runV2Transaction(
        connection,
        baseOptions({
          maxAttempts: 3,
          operation: async () => {
            attempts += 1;
            throw transientError();
          },
        })
      ),
      (error) => error.code === TRANSACTION_ERROR_CODES.RETRIES_EXHAUSTED
    );
    assert.equal(attempts, 3);
    assert.equal(sessions.length, 3);
    for (const session of sessions) assertEnded(session);
  });

  test("unknown commit with confirmed success replays the stored result", async () => {
    const { connection, sessions } = makeHarness([
      { commitError: unknownCommitError() },
    ]);
    let attempts = 0;
    const resolutions = [];
    const result = await runV2Transaction(
      connection,
      baseOptions({
        actionIdentity: "unknown-success",
        fingerprint: "fp-success",
        operation: async () => {
          attempts += 1;
          return "should-not-be-used";
        },
        resolveOutcome: async (actionIdentity, context) => {
          resolutions.push([actionIdentity, context.fingerprint]);
          return {
            status: UNKNOWN_COMMIT_RESOLUTIONS.CONFIRMED_SUCCESS,
            actionIdentity: "unknown-success",
            fingerprint: "fp-success",
            result: { replayed: true },
          };
        },
      })
    );
    assert.deepEqual(result, { replayed: true });
    assert.equal(attempts, 1);
    assert.deepEqual(resolutions, [["unknown-success", "fp-success"]]);
    assert.equal(sessions.length, 1);
    assertEnded(sessions[0]);
  });

  test("unknown commit with confirmed absence retries the same action", async () => {
    const { connection, sessions } = makeHarness([
      { commitError: unknownCommitError() },
      {},
    ]);
    let attempts = 0;
    const identities = [];
    const result = await runV2Transaction(
      connection,
      baseOptions({
        actionIdentity: "unknown-absent",
        fingerprint: "fp-absent",
        operation: async (_session, context) => {
          attempts += 1;
          identities.push(context.actionIdentity);
          return "committed-on-retry";
        },
        resolveOutcome: async () => ({
          status: UNKNOWN_COMMIT_RESOLUTIONS.CONFIRMED_ABSENT,
        }),
      })
    );
    assert.equal(result, "committed-on-retry");
    assert.equal(attempts, 2);
    assert.deepEqual(identities, ["unknown-absent", "unknown-absent"]);
    assert.equal(sessions.length, 2);
    assertEnded(sessions[0]);
    assertEnded(sessions[1]);
  });

  test("unknown commit with a conflicting identity fails closed", async () => {
    const { connection, sessions } = makeHarness([
      { commitError: unknownCommitError() },
    ]);
    await assert.rejects(
      runV2Transaction(
        connection,
        baseOptions({
          actionIdentity: "conflict-action",
          fingerprint: "conflict-fingerprint",
          resolveOutcome: async () => ({
            status: UNKNOWN_COMMIT_RESOLUTIONS.CONFIRMED_SUCCESS,
            actionIdentity: "conflict-action",
            fingerprint: "different-fingerprint",
            result: { replayed: true },
          }),
        })
      ),
      (error) =>
        error.code === TRANSACTION_ERROR_CODES.ACTION_IDENTITY_CONFLICT
    );
    assert.equal(sessions.length, 1);
    assertEnded(sessions[0]);
  });

  test("unknown commit with unresolved outcome is never retried", async () => {
    const { connection, sessions } = makeHarness([
      { commitError: unknownCommitError() },
    ]);
    await assert.rejects(
      runV2Transaction(
        connection,
        baseOptions({
          resolveOutcome: async () => ({
            status: UNKNOWN_COMMIT_RESOLUTIONS.UNRESOLVED,
          }),
        })
      ),
      (error) => error.code === TRANSACTION_ERROR_CODES.OUTCOME_UNRESOLVED
    );
    assert.equal(sessions.length, 1);
    assertEnded(sessions[0]);
  });

  test("unsupported transactions map to TRANSACTIONS_UNAVAILABLE (503)", async () => {
    const { connection, sessions } = makeHarness([{}]);
    let attempts = 0;
    await assert.rejects(
      runV2Transaction(
        connection,
        baseOptions({
          operation: async () => {
            attempts += 1;
            throw unsupportedError();
          },
        })
      ),
      (error) =>
        error.code === TRANSACTION_ERROR_CODES.TRANSACTIONS_UNAVAILABLE &&
        error.status === 503
    );
    assert.equal(attempts, 1);
    assert.equal(sessions.length, 1);
    assertEnded(sessions[0]);
  });

  test("deterministic business rejections are not retried or wrapped", async () => {
    const { connection, sessions } = makeHarness([{}]);
    const businessError = Object.assign(new Error("business rejected"), {
      code: "BUSINESS_REJECTED",
    });
    let attempts = 0;
    await assert.rejects(
      runV2Transaction(
        connection,
        baseOptions({
          operation: async () => {
            attempts += 1;
            throw businessError;
          },
        })
      ),
      (error) => error === businessError
    );
    assert.equal(attempts, 1);
    assert.equal(sessions.length, 1);
    assertEnded(sessions[0]);
  });

  test("abort failure never masks the primary error and still cleans up", async () => {
    const { connection, sessions } = makeHarness([
      { abortError: new Error("abort failed") },
    ]);
    const businessError = new Error("primary business failure");
    await assert.rejects(
      runV2Transaction(
        connection,
        baseOptions({
          operation: async () => {
            throw businessError;
          },
        })
      ),
      (error) => {
        assert.equal(error, businessError);
        assert.equal(error.abortError.message, "abort failed");
        return true;
      }
    );
    assert.equal(sessions.length, 1);
    assertEnded(sessions[0]);
  });

  test("every outcome path ends the session", async () => {
    const scenarios = [
      {
        plans: [{}],
        options: baseOptions({ operation: async () => "ok" }),
      },
      {
        plans: [{}, {}],
        options: baseOptions({
          operation: async (_session, context) => {
            if (context.attempt === 1) throw transientError();
            return "ok";
          },
        }),
      },
      {
        plans: [{}],
        options: baseOptions({
          operation: async () => {
            throw unsupportedError();
          },
        }),
      },
      {
        plans: [{}],
        options: baseOptions({
          operation: async () => {
            throw new Error("deterministic");
          },
        }),
      },
      {
        plans: [{ commitError: unknownCommitError() }],
        options: baseOptions({
          resolveOutcome: async () => ({
            status: UNKNOWN_COMMIT_RESOLUTIONS.CONFIRMED_SUCCESS,
            actionIdentity: "action-1",
            fingerprint: "fingerprint-1",
            result: "replayed",
          }),
        }),
      },
    ];

    for (const scenario of scenarios) {
      const { connection, sessions } = makeHarness(scenario.plans);
      try {
        await runV2Transaction(connection, scenario.options);
      } catch {
        // Failure is expected for several scenarios; cleanup is the assertion.
      }
      assert.ok(sessions.length > 0);
      for (const session of sessions) assertEnded(session);
    }
  });

  test("invalid options fail before a session is opened", async () => {
    const { connection, sessions } = makeHarness([{}]);
    await assert.rejects(
      runV2Transaction(connection, baseOptions({ actionIdentity: "" })),
      (error) =>
        error.code === TRANSACTION_ERROR_CODES.ACTION_IDENTITY_REQUIRED
    );
    await assert.rejects(
      runV2Transaction(connection, baseOptions({ resolveOutcome: null })),
      (error) => error.code === TRANSACTION_ERROR_CODES.INVALID_OPTIONS
    );
    await assert.rejects(
      runV2Transaction(null, baseOptions()),
      (error) => error.code === TRANSACTION_ERROR_CODES.INVALID_OPTIONS
    );
    assert.equal(sessions.length, 0);
  });

  test("error classification and bounded backoff are deterministic", () => {
    assert.equal(classifyTransactionError(transientError()), "TRANSIENT");
    assert.equal(classifyTransactionError(unknownCommitError()), "UNKNOWN_COMMIT");
    assert.equal(classifyTransactionError(unsupportedError()), "UNSUPPORTED");
    assert.equal(
      classifyTransactionError(new Error("business")),
      "DETERMINISTIC"
    );
    assert.equal(isTransientTransactionError({ code: 112 }), true);
    assert.equal(isUnknownTransactionCommitResult(unknownCommitError()), true);
    assert.equal(isTransactionsUnsupportedError({ code: 20 }), true);

    const zero = computeBackoffMs(1, 10, 100, () => 0);
    const half = computeBackoffMs(1, 10, 100, () => 0.5);
    const capped = computeBackoffMs(10, 10, 100, () => 0.999);
    assert.equal(zero, 0);
    assert.ok(half >= 0 && half <= 10);
    assert.ok(capped <= 100);
  });
});

// ---------------------------------------------------------------------------
// Index plan and deployment guards
// ---------------------------------------------------------------------------

function uniqueSignatures(collection) {
  return V2_INDEX_PLAN.filter(
    (entry) => entry.collection === collection && entry.options?.unique === true
  )
    .map((entry) => indexKeySignature(entry.key))
    .sort();
}

describe("V2 index plan", () => {
  test("the plan validates and preserves every approved unique constraint", () => {
    assert.equal(validateV2IndexPlan().ok, true);
    assert.equal(assertV2IndexPlan(), true);

    assert.deepEqual(uniqueSignatures(V2_COLLECTIONS.ALLOCATIONS), [
      "allocationId:1",
      "orderId:1|allocationKey:1|epoch:1",
    ].sort());
    assert.deepEqual(uniqueSignatures(V2_COLLECTIONS.WASTE_CORRECTIONS), [
      "allocationId:1|correctionId:1",
    ]);
    assert.deepEqual(uniqueSignatures(V2_COLLECTIONS.APPROVAL_CHALLENGES), [
      "challengeId:1",
    ]);
    assert.deepEqual(uniqueSignatures(V2_COLLECTIONS.APPROVALS), [
      "approvalGroupId:1|stage:1",
      "challengeId:1",
    ].sort());
    assert.deepEqual(uniqueSignatures(V2_COLLECTIONS.PAYMENT_EVIDENCE), [
      "evidenceId:1",
      "orderId:1|orderVersion:1",
    ].sort());
    assert.deepEqual(uniqueSignatures(V2_COLLECTIONS.AUDIT_EVENTS), [
      "eventId:1",
    ]);
    assert.deepEqual(uniqueSignatures(V2_COLLECTIONS.POLICY_VERSIONS), [
      "policyVersion:1",
    ]);
  });

  test("challenges never get a global unique approvalGroupId/stage index", () => {
    const forbidden = V2_INDEX_PLAN.filter(
      (entry) =>
        entry.collection === V2_COLLECTIONS.APPROVAL_CHALLENGES &&
        entry.options?.unique === true &&
        indexKeySignature(entry.key) === V2_FORBIDDEN_CHALLENGE_UNIQUE_KEY
    );
    assert.equal(forbidden.length, 0);
  });

  test("TTL is cleanup-only and never unique", () => {
    const ttl = V2_INDEX_PLAN.filter(
      (entry) => entry.options?.expireAfterSeconds !== undefined
    );
    assert.equal(ttl.length, 1);
    assert.equal(ttl[0].collection, V2_COLLECTIONS.APPROVAL_CHALLENGES);
    assert.equal(
      ttl[0].classification,
      V2_INDEX_CLASSIFICATIONS.CLEANUP_ONLY
    );
    assert.notEqual(ttl[0].options.unique, true);
  });

  test("the optional open-challenge lookup is non-unique and non-critical", () => {
    const open = V2_INDEX_PLAN.find(
      (entry) => entry.name === "challenge_open_lookup"
    );
    assert.ok(open);
    assert.notEqual(open.options.unique, true);
    assert.equal(
      open.classification,
      V2_INDEX_CLASSIFICATIONS.QUERY_PERFORMANCE_ONLY
    );
  });

  test("a tampered plan with a forbidden challenge unique fails closed", () => {
    const tampered = [
      ...V2_INDEX_PLAN,
      {
        collection: V2_COLLECTIONS.APPROVAL_CHALLENGES,
        name: "forbidden_challenge_group_stage_unique",
        key: { approvalGroupId: 1, stage: 1 },
        options: { unique: true },
        classification: V2_INDEX_CLASSIFICATIONS.CORRECTNESS_CRITICAL_UNIQUE,
      },
    ];
    const result = validateV2IndexPlan(tampered);
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((issue) => issue.type === "FORBIDDEN_CHALLENGE_UNIQUE")
    );
    assert.throws(() => assertV2IndexPlan(tampered));
  });

  test("a tampered plan missing a required unique fails closed", () => {
    const tampered = V2_INDEX_PLAN.filter(
      (entry) => entry.name !== "allocation_id_unique"
    );
    const result = validateV2IndexPlan(tampered);
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.type === "MISSING_REQUIRED_UNIQUE" &&
          issue.collection === V2_COLLECTIONS.ALLOCATIONS
      )
    );
  });

  test("a tampered unique TTL fails closed", () => {
    const tampered = V2_INDEX_PLAN.map((entry) =>
      entry.name === "challenge_expires_ttl"
        ? { ...entry, options: { ...entry.options, unique: true } }
        : entry
    );
    const result = validateV2IndexPlan(tampered);
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((issue) => issue.type === "UNIQUE_TTL_FORBIDDEN")
    );
  });
});

describe("index deployment guards", () => {
  test("argument parsing requires an explicit confirmation", () => {
    assert.deepEqual(parseDeployArgs([]), {
      confirm: false,
      allowProduction: false,
      help: false,
    });
    assert.equal(parseDeployArgs(["--confirm"]).confirm, true);
    assert.equal(parseDeployArgs(["--allow-production"]).allowProduction, true);
    assert.equal(parseDeployArgs(["--help"]).help, true);
    assert.throws(() => parseDeployArgs(["--unknown"]), CliError);
  });

  test("production detection fails closed when the environment is unclassified", () => {
    assert.deepEqual(
      detectProductionMarkers({ INVENTORY_V2_INDEX_DEPLOY_ENV: "development" }),
      []
    );
    assert.deepEqual(
      detectProductionMarkers({ INVENTORY_V2_INDEX_DEPLOY_ENV: "test" }),
      []
    );
    assert.ok(
      detectProductionMarkers({ NODE_ENV: "production" }).includes("NODE_ENV")
    );
    assert.ok(detectProductionMarkers({}).length > 0);
  });

  test("the production approval gate requires both the flag and an approval reference", () => {
    assert.deepEqual(
      assertProductionApproval({
        env: { INVENTORY_V2_INDEX_DEPLOY_ENV: "development" },
      }),
      { production: false, markers: [] }
    );
    assert.throws(
      () => assertProductionApproval({ env: { NODE_ENV: "production" } }),
      CliError
    );
    assert.throws(
      () =>
        assertProductionApproval({
          env: { NODE_ENV: "production" },
          allowProduction: true,
        }),
      CliError
    );
    assert.deepEqual(
      assertProductionApproval({
        env: {
          NODE_ENV: "production",
          [APPROVAL_ENV]: "CHANGE-123",
        },
        allowProduction: true,
      }),
      { production: true, markers: ["NODE_ENV"] }
    );
  });

  test("the CLI refuses to run without --confirm and never connects", async () => {
    let connected = false;
    const result = await runIndexDeploymentCli([], {
      env: { INVENTORY_V2_INDEX_DEPLOY_ENV: "development" },
      log: () => {},
      error: () => {},
      connect: async () => {
        connected = true;
      },
    });
    assert.equal(result, 1);
    assert.equal(connected, false);
  });

  test("the CLI refuses production without approval and never connects", async () => {
    let connected = false;
    const result = await runIndexDeploymentCli(["--confirm"], {
      env: { NODE_ENV: "production" },
      log: () => {},
      error: () => {},
      connect: async () => {
        connected = true;
      },
    });
    assert.equal(result, 1);
    assert.equal(connected, false);
  });

  test("the CLI does not connect when the URI is missing", async () => {
    let connected = false;
    const result = await runIndexDeploymentCli(["--confirm"], {
      env: { INVENTORY_V2_INDEX_DEPLOY_ENV: "development" },
      log: () => {},
      error: () => {},
      connect: async () => {
        connected = true;
      },
    });
    assert.equal(result, 1);
    assert.equal(connected, false);
  });

  test("the CLI help path performs no database operation", async () => {
    let connected = false;
    const result = await runIndexDeploymentCli(["--help"], {
      log: () => {},
      error: () => {},
      connect: async () => {
        connected = true;
      },
    });
    assert.equal(result, 0);
    assert.equal(connected, false);
  });

  test("expected plan grouping preserves names, keys, and classifications", () => {
    const grouped = buildExpectedPlan();
    assert.equal(grouped.length, Object.values(V2_COLLECTIONS).length);
    const total = grouped.reduce((sum, entry) => sum + entry.indexes.length, 0);
    assert.equal(total, V2_INDEX_PLAN.length);
    for (const entry of grouped) {
      for (const index of entry.indexes) {
        assert.ok(index.name);
        assert.ok(index.key);
        assert.ok(index.classification);
      }
    }
  });

  test("index inspection detects missing, unexpected, and mismatched indexes", async () => {
    const expected = [
      { name: "a_unique", key: { a: 1 }, options: { unique: true } },
    ];
    const makeCollection = (indexes) => ({
      collectionName: "test_collection",
      async indexes() {
        return indexes;
      },
    });

    const exact = await inspectCollectionIndexes(
      makeCollection([
        { name: "_id_", key: { _id: 1 } },
        { name: "a_unique", key: { a: 1 }, unique: true },
      ]),
      expected
    );
    assert.deepEqual(exact, []);

    const missing = await inspectCollectionIndexes(makeCollection([]), expected);
    assert.ok(missing.some((issue) => issue.type === "MISSING"));

    const unexpected = await inspectCollectionIndexes(
      makeCollection([{ name: "other", key: { b: 1 } }]),
      expected
    );
    assert.ok(unexpected.some((issue) => issue.type === "UNEXPECTED"));
    assert.ok(unexpected.some((issue) => issue.type === "MISSING"));

    const keyMismatch = await inspectCollectionIndexes(
      makeCollection([{ name: "a_unique", key: { a: -1 }, unique: true }]),
      expected
    );
    assert.ok(keyMismatch.some((issue) => issue.type === "KEY_MISMATCH"));

    const optionsMismatch = await inspectCollectionIndexes(
      makeCollection([{ name: "a_unique", key: { a: 1 } }]),
      expected
    );
    assert.ok(optionsMismatch.some((issue) => issue.type === "OPTIONS_MISMATCH"));
  });

  test("the deployment script source contains no destructive index calls", () => {
    const script = read("scripts/inventory-v2-deploy-indexes.mjs");
    assert.match(script, /--confirm/);
    assert.match(script, new RegExp(APPROVAL_ENV));
    assert.match(script, /createIndexes/);
    assert.match(script, /inspectPlan/);
    assert.match(script, /inspectCollectionIndexes/);
    assert.doesNotMatch(script, /\bsyncIndexes\s*\(/);
    assert.doesNotMatch(script, /\bdropIndex\s*\(/);
    assert.doesNotMatch(script, /\bdropIndexes\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// Order mutation inventory
// ---------------------------------------------------------------------------

describe("order mutation inventory", () => {
  test("the inventory validates and covers every required path", () => {
    assert.equal(validateOrderMutationInventory().ok, true);
    const identities = new Set(
      ORDER_MUTATION_INVENTORY.map((entry) => `${entry.file}#${entry.symbol}`)
    );
    for (const required of [
      "lib/orderService.js#createOrder",
      "lib/orderService.js#updateOrderStatus",
      "lib/orderService.js#serveOrder",
      "lib/orderService.js#payOrder",
      "lib/orderService.js#cancelOrder",
      "lib/orderService.js#cancelOrderItem",
      "lib/orderService.js#editOrderItems",
      "app/api/manager/settings/clear-orders/route.js#POST",
    ]) {
      assert.ok(identities.has(required), `missing inventory path ${required}`);
    }
  });

  test("the future version contract rejects updatedAt as a substitute", () => {
    assert.equal(ORDER_VERSION_CONTRACT.field, "orderVersion");
    assert.equal(ORDER_VERSION_CONTRACT.implementedInPhase2, false);
    assert.match(ORDER_VERSION_CONTRACT.updatedAtSubstitute, /FORBIDDEN/);
    assert.match(ORDER_VERSION_CONTRACT.control, /server-only/);
  });

  test("cancelOrderItem still documents the updatedAt optimistic token", () => {
    assert.equal(
      CANCEL_ORDER_ITEM_UPDATED_AT_ANALYSIS.currentToken,
      "updatedAt"
    );
    assert.match(
      CANCEL_ORDER_ITEM_UPDATED_AT_ANALYSIS.phase2Decision,
      /DO NOT replace/i
    );
    const source = read("lib/orderService.js");
    assert.match(source, /updatedAt:\s*docAfter\.updatedAt/);
    assert.doesNotMatch(source, /\borderVersion\b/);
  });

  test("Phase 2.0 does not add orderVersion to the Order schema", () => {
    const model = read("lib/models/Order.js");
    assert.doesNotMatch(model, /\borderVersion\b/);
  });

  test("clear-orders is documented as a V2 hold risk", () => {
    const entry = ORDER_MUTATION_INVENTORY.find(
      (item) =>
        item.file === "app/api/manager/settings/clear-orders/route.js" &&
        item.symbol === "POST"
    );
    assert.ok(entry);
    assert.equal(entry.affectsInventory, true);
    assert.match(entry.notes, /reservedStock/i);
    assert.match(entry.notes, /V2/i);
    const source = read("app/api/manager/settings/clear-orders/route.js");
    assert.match(source, /deleteMany/);
    assert.match(source, /reservedStock:\s*0/);
  });

  test("a tampered inventory missing a required path fails closed", () => {
    const tampered = ORDER_MUTATION_INVENTORY.filter(
      (entry) => entry.symbol !== "cancelOrderItem"
    );
    const result = validateOrderMutationInventory(tampered);
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((issue) => issue.type === "MISSING_REQUIRED_PATH")
    );
  });
});

// ---------------------------------------------------------------------------
// V1/V2 ownership
// ---------------------------------------------------------------------------

describe("V1/V2 ownership", () => {
  test("inventoryMode is required, normalized, and never inferred", () => {
    assert.equal(normalizeInventoryMode("v1"), INVENTORY_MODES.V1);
    assert.equal(normalizeInventoryMode(" V2 "), INVENTORY_MODES.V2);
    assert.throws(
      () => normalizeInventoryMode(undefined),
      (error) => error.code === INVENTORY_OWNERSHIP_ERRORS.MODE_REQUIRED
    );
    assert.throws(
      () => normalizeInventoryMode("V3"),
      (error) => error.code === INVENTORY_OWNERSHIP_ERRORS.MODE_INVALID
    );
  });

  test("V1 services reject V2-owned orders and V2 services reject V1-owned orders", () => {
    assert.equal(assertV1OwnedOrder({ inventoryMode: "V1" }), "V1");
    assert.equal(assertV2OwnedOrder({ inventoryMode: "V2" }), "V2");
    assert.throws(
      () => assertV1OwnedOrder({ inventoryMode: "V2" }),
      (error) => error.code === INVENTORY_OWNERSHIP_ERRORS.OWNER_MISMATCH
    );
    assert.throws(
      () => assertV2OwnedOrder({ inventoryMode: "V1" }),
      (error) => error.code === INVENTORY_OWNERSHIP_ERRORS.OWNER_MISMATCH
    );
  });

  test("an order must have exactly one inventory owner", () => {
    assert.equal(
      assertExactlyOneInventoryOwner({ v1Owned: true, v2Owned: false }),
      "V1"
    );
    assert.equal(
      assertExactlyOneInventoryOwner({ v1Owned: false, v2Owned: true }),
      "V2"
    );
    assert.throws(
      () => assertExactlyOneInventoryOwner({ v1Owned: true, v2Owned: true }),
      (error) => error.code === INVENTORY_OWNERSHIP_ERRORS.MULTIPLE_OWNERS
    );
    assert.throws(
      () => assertExactlyOneInventoryOwner({ v1Owned: false, v2Owned: false }),
      (error) => error.code === INVENTORY_OWNERSHIP_ERRORS.NO_OWNER
    );
  });

  test("clear-orders fails closed for V2 holds and unknown V2 ownership", () => {
    assert.deepEqual(evaluateClearOrdersSafety({}), {
      allowed: true,
      code: "CLEAR_ORDERS_SAFE",
      requiresV2AwareProcedure: false,
    });
    assert.equal(
      evaluateClearOrdersSafety({ v2ActiveHolds: 1 }).code,
      INVENTORY_OWNERSHIP_ERRORS.V2_HOLDS_PRESENT
    );
    assert.equal(
      evaluateClearOrdersSafety({ v2OwnershipUnknown: true }).code,
      INVENTORY_OWNERSHIP_ERRORS.V2_OWNERSHIP_UNKNOWN
    );
    assert.equal(
      evaluateClearOrdersSafety({ v1Consuming: 1 }).code,
      INVENTORY_OWNERSHIP_ERRORS.V1_CONSUMING
    );
    assert.throws(
      () => assertClearOrdersV2Safe({ v2ActiveHolds: 1 }),
      (error) => error.code === INVENTORY_OWNERSHIP_ERRORS.V2_HOLDS_PRESENT
    );
  });

  test("every known reservedStock writer is documented", () => {
    const identities = new Set(
      RESERVED_STOCK_WRITERS.map((entry) => `${entry.file}#${entry.symbol}`)
    );
    for (const required of [
      "lib/inventoryReservationService.js#ensureOrderInventoryReservation",
      "lib/inventoryReservationService.js#reconcileOrderInventory",
      "lib/inventoryReservationService.js#releaseOrderInventory",
      "lib/inventoryReservationService.js#consumeOrderInventory",
      "app/api/manager/settings/clear-orders/route.js#POST",
      "lib/inventoryWasteService.js#recordWaste",
    ]) {
      assert.ok(identities.has(required), `missing writer ${required}`);
    }
    assert.equal(
      identities.has("lib/inventoryReservationService.js#approveInventoryShortage"),
      false,
      "removed shortage approval must not be a registered writer"
    );
    const clearOrders = RESERVED_STOCK_WRITERS.find(
      (entry) => entry.file === "app/api/manager/settings/clear-orders/route.js"
    );
    assert.equal(clearOrders.ownershipScope, "GLOBAL");
    assert.match(clearOrders.risk, /CRITICAL/);
  });

  test("shared-stock invariants cover ownership, atomicity, and isolation", () => {
    assert.ok(SHARED_STOCK_INVARIANTS.length >= 8);
    const text = SHARED_STOCK_INVARIANTS.join("\n");
    assert.match(text, /exactly one inventory owner/i);
    assert.match(text, /conditional atomic update/i);
    assert.match(text, /must not subtract V2 holds/i);
    assert.match(text, /No retroactive deduction/i);
    assert.match(text, /reporting must remain isolated/i);
  });
});
