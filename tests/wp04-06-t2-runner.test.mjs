// WP04-06 — DB-free tests for runner authorization, temp-path safety, cleanup,
// WP04 effect construction, and verifier option immutability.
//
// These tests do not start mongod, connect to MongoDB, read environment files,
// or execute the integration runner. A passing result is harness evidence only;
// it is NOT T2/P1-P6 execution evidence and does not close T2.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  assertExecutionAuthorized,
  assertProxyScenarioEvidence,
  buildEnvironmentEvidence,
  buildScenarioDiagnostics,
  cleanup,
  createOwnedTempPath,
  isOwnedTempPath,
  parseArgs,
  recordScenarioAssertion,
  recordScenarioEvidence,
  validateMongodExecutable,
  waitForExit,
  waitForStatusRecord
} from "./integration/wp04-06-t2-runner.mjs";
import {
  assertCrashAbandonmentEvidence,
  assertCrashRestartEvidence
} from "./integration/wp04-06-t2-runner.mjs";
import {
  NEGATIVE_CONTROL_COLLECTION,
  REAL_WRITER_LEASE_MS,
  REAL_WRITER_MODULE,
  assertLoopbackProxyUri,
  assertRealWriterScenarioEvidence,
  buildNegativeControlMarker,
  buildRealWriterScenario,
  createBoundedSessionOpener,
  runRealWriterEffect,
  runRealWriterSetup
} from "./integration/support/t2RealWriter.mjs";
import {
  assertVerifierOptions,
  createIndependentVerifierClient,
  evaluateWp04AbandonmentState,
  evaluateWp04EffectState,
  evaluateWp04Effects,
  readWp04EffectStateWithClient,
  readWp04EffectsWithClient,
  VERIFIER_READ_CONCERN,
  VERIFIER_READ_PREFERENCE,
  WP04_COLLECTIONS
} from "./integration/support/t2Verifier.mjs";
import {
  CRASH_WORKER_MODULE,
  CRASH_WORKER_ROLES,
  parseCrashWorkerArgs,
  reviveCrashScenarioSpec,
  serializeCrashScenarioSpec
} from "./integration/support/t2CrashWorker.mjs";
import { PROXY_MODES } from "./integration/support/t2Proxy.mjs";

const TESTS_DIR = fileURLToPath(new URL("./", import.meta.url));
const SUPPORT_DIR = fileURLToPath(new URL("./integration/support/", import.meta.url));
const RUN_ID = "wp04-06-t2-0123456789ab";

function makeBaseTemp(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wp04-06-runner-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function fakeProc({ pid = 4_242, exitCode = null, signalCode = null } = {}) {
  const listeners = new Set();
  return {
    pid,
    exitCode,
    signalCode,
    kill() {},
    once(event, listener) {
      if (event === "exit") listeners.add(listener);
    },
    removeListener(event, listener) {
      if (event === "exit") listeners.delete(listener);
    },
    emitExit() {
      for (const listener of [...listeners]) listener();
    }
  };
}

test("parseArgs requires values and rejects unknown flags", () => {
  const parsed = parseArgs([
    "--execute",
    "--run-id",
    RUN_ID,
    "--confirm",
    "START-DISPOSABLE-MONGOD",
    "--mongod-port",
    "27031",
    "--proxy-port",
    "27032"
  ]);
  assert.equal(parsed.execute, true);
  assert.equal(parsed.runId, RUN_ID);
  assert.equal(parsed.mongodPort, 27031);
  assert.equal(parsed.proxyPort, 27032);

  assert.throws(() => parseArgs(["--run-id"]), /requires a value/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});

test("runner authorization validates gates, ports, and the executable name", (t) => {
  assert.equal(assertExecutionAuthorized({ execute: false }), false);

  const base = makeBaseTemp(t);
  const fakeMongod = path.join(base, "mongod.exe");
  fs.writeFileSync(fakeMongod, "");

  const valid = {
    execute: true,
    runId: RUN_ID,
    confirm: "START-DISPOSABLE-MONGOD",
    mongodPort: 27031,
    proxyPort: 27032,
    mongodPath: fakeMongod
  };
  assert.equal(assertExecutionAuthorized({ ...valid }), true);

  assert.throws(
    () => assertExecutionAuthorized({ ...valid, runId: "wp04-06-t2-NOTHEX" }),
    /--run-id/
  );
  assert.throws(
    () => assertExecutionAuthorized({ ...valid, confirm: "WRONG" }),
    /--confirm/
  );
  assert.throws(
    () => assertExecutionAuthorized({ ...valid, mongodPort: 27032 }),
    /must differ/
  );
  assert.throws(
    () => assertExecutionAuthorized({ ...valid, mongodPort: 27017 }),
    /prohibited/
  );
  assert.throws(
    () => assertExecutionAuthorized({ ...valid, proxyPort: 80 }),
    /outside the allowed/
  );
  assert.throws(
    () => assertExecutionAuthorized({ ...valid, proxyPort: Number.NaN }),
    /must be integers/
  );
});

test("validateMongodExecutable rejects relative, missing, and non-mongod paths", (t) => {
  const base = makeBaseTemp(t);
  const fakeMongod = path.join(base, "mongod.exe");
  fs.writeFileSync(fakeMongod, "");
  assert.equal(validateMongodExecutable(fakeMongod), fs.realpathSync(fakeMongod));

  assert.throws(() => validateMongodExecutable("mongod.exe"), /absolute path/);
  assert.throws(
    () => validateMongodExecutable(path.join(base, "missing.exe")),
    /not found/
  );
  assert.throws(
    () => validateMongodExecutable(process.execPath),
    /named mongod/
  );

  const directory = path.join(base, "mongod-dir");
  fs.mkdirSync(directory);
  assert.throws(() => validateMongodExecutable(directory), /not a regular file/);
});

test("createOwnedTempPath refuses a pre-existing run-ID directory", (t) => {
  const base = makeBaseTemp(t);
  fs.mkdirSync(path.join(base, RUN_ID));

  assert.throws(() => createOwnedTempPath(base, RUN_ID), /pre-existing run-ID directory/);
});

test("createOwnedTempPath creates the directory and owner marker exclusively", (t) => {
  const base = makeBaseTemp(t);
  const dbPath = createOwnedTempPath(base, RUN_ID);

  assert.equal(fs.existsSync(dbPath), true);
  assert.equal(isOwnedTempPath(dbPath, base, RUN_ID), true);
  const marker = JSON.parse(
    fs.readFileSync(path.join(dbPath, ".wp04-06-t2-owner.json"), "utf8")
  );
  assert.equal(marker.runId, RUN_ID);

  assert.throws(
    () =>
      createOwnedTempPath(base, RUN_ID, {
        writeFile() {
          const error = new Error("exists");
          error.code = "EEXIST";
          throw error;
        }
      }),
    /pre-existing run-ID directory/
  );
});

test("isOwnedTempPath rejects wrong run IDs, outside paths, and tampered markers", (t) => {
  const base = makeBaseTemp(t);
  const dbPath = createOwnedTempPath(base, RUN_ID);

  assert.equal(isOwnedTempPath(dbPath, base, RUN_ID), true);
  assert.equal(isOwnedTempPath(dbPath, base, "wp04-06-t2-ffffffffffff"), false);
  assert.equal(isOwnedTempPath(path.dirname(base), base, RUN_ID), false);

  fs.writeFileSync(
    path.join(dbPath, ".wp04-06-t2-owner.json"),
    JSON.stringify({ runId: "wp04-06-t2-ffffffffffff" })
  );
  assert.equal(isOwnedTempPath(dbPath, base, RUN_ID), false);
});

test("cleanup keeps the temp path while the owned child is still alive", async (t) => {
  const base = makeBaseTemp(t);
  const dbPath = createOwnedTempPath(base, RUN_ID);
  const proc = fakeProc({ pid: 5_000 });
  const signals = [];
  let removed = false;

  const result = await cleanup({
    proc,
    port: 27031,
    dbPath,
    baseTemp: base,
    runId: RUN_ID,
    deps: {
      findListenerPid: () => proc.pid,
      waitForExit: async () => false,
      isProcessAlive: () => true,
      kill: (target, signal) => signals.push(signal),
      removePath: () => {
        removed = true;
      }
    }
  });

  assert.equal(result.mongodStopped, false);
  assert.equal(result.dbPathRemoved, false);
  assert.equal(removed, false);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(
    result.blockers.some((blocker) => blocker.code === "CHILD_STILL_ALIVE"),
    true
  );
  assert.equal(
    result.blockers.some((blocker) => blocker.code === "TEMP_PATH_RETAINED_CHILD_ALIVE"),
    true
  );
  assert.equal(fs.existsSync(dbPath), true);
});

test("cleanup refuses to signal or remove on ambiguous listener ownership", async (t) => {
  const base = makeBaseTemp(t);
  const dbPath = createOwnedTempPath(base, RUN_ID);
  const proc = fakeProc({ pid: 5_100 });
  const signals = [];
  let removed = false;

  const result = await cleanup({
    proc,
    port: 27031,
    dbPath,
    baseTemp: base,
    runId: RUN_ID,
    deps: {
      findListenerPid: () => 9_999,
      isProcessAlive: () => true,
      kill: (target, signal) => signals.push(signal),
      removePath: () => {
        removed = true;
      }
    }
  });

  assert.deepEqual(signals, []);
  assert.equal(removed, false);
  assert.equal(result.dbPathRemoved, false);
  assert.equal(
    result.blockers.some((blocker) => blocker.code === "OWNERSHIP_AMBIGUOUS"),
    true
  );
  assert.equal(
    result.blockers.some(
      (blocker) => blocker.code === "TEMP_PATH_RETAINED_OWNERSHIP_AMBIGUOUS"
    ),
    true
  );
  assert.equal(fs.existsSync(dbPath), true);
});

test("cleanup retains the path when listener ownership cannot be checked", async (t) => {
  const base = makeBaseTemp(t);
  const dbPath = createOwnedTempPath(base, RUN_ID);
  const proc = fakeProc({ pid: 5_300 });
  const signals = [];
  let removed = false;

  const result = await cleanup({
    proc,
    port: 27031,
    dbPath,
    baseTemp: base,
    runId: RUN_ID,
    deps: {
      findListenerPid: () => {
        throw new Error("netstat unavailable");
      },
      isProcessAlive: () => true,
      kill: (target, signal) => signals.push(signal),
      removePath: () => {
        removed = true;
      }
    }
  });

  assert.deepEqual(signals, []);
  assert.equal(removed, false);
  assert.equal(
    result.blockers.some((blocker) => blocker.code === "LISTENER_CHECK_FAILED"),
    true
  );
  assert.equal(
    result.blockers.some(
      (blocker) => blocker.code === "TEMP_PATH_RETAINED_OWNERSHIP_AMBIGUOUS"
    ),
    true
  );
  assert.equal(fs.existsSync(dbPath), true);
});

test("waitForExit recognizes both exitCode and signalCode", async () => {
  const exitedByCode = fakeProc({ exitCode: 0, signalCode: null });
  assert.equal(await waitForExit(exitedByCode, 10), true);

  const exitedBySignal = fakeProc({ exitCode: null, signalCode: "SIGTERM" });
  assert.equal(await waitForExit(exitedBySignal, 10), true);

  const alive = fakeProc({ exitCode: null, signalCode: null });
  assert.equal(await waitForExit(alive, 10), false);
});

test("cleanup removes an owned path after a signal-terminated child exits", async (t) => {
  const base = makeBaseTemp(t);
  const dbPath = createOwnedTempPath(base, RUN_ID);
  const proc = fakeProc({ pid: 5_200 });
  let removed = false;

  const result = await cleanup({
    proc,
    port: 27031,
    dbPath,
    baseTemp: base,
    runId: RUN_ID,
    deps: {
      findListenerPid: () => proc.pid,
      isProcessAlive: () => true,
      kill: (target, signal) => {
        if (signal === "SIGTERM") {
          target.signalCode = "SIGTERM";
          target.emitExit();
        }
      },
      removePath: () => {
        removed = true;
      }
    }
  });

  assert.equal(result.mongodStopped, true);
  assert.equal(result.dbPathRemoved, true);
  assert.equal(removed, true);
  assert.deepEqual(result.blockers, []);
});

test("cleanup retains an unowned temp path and records a blocker", async (t) => {
  const base = makeBaseTemp(t);
  const dbPath = path.join(base, RUN_ID);
  fs.mkdirSync(dbPath);

  const result = await cleanup({
    proc: null,
    port: 27031,
    dbPath,
    baseTemp: base,
    runId: RUN_ID,
    spawned: false
  });

  assert.equal(result.dbPathRemoved, false);
  assert.equal(
    result.blockers.some((blocker) => blocker.code === "TEMP_PATH_NOT_OWNED"),
    true
  );
  assert.equal(fs.existsSync(dbPath), true);
});

test("cleanup honours keepTemp without reporting a blocker", async (t) => {
  const base = makeBaseTemp(t);
  const dbPath = createOwnedTempPath(base, RUN_ID);

  const result = await cleanup({
    proc: null,
    port: 27031,
    dbPath,
    baseTemp: base,
    runId: RUN_ID,
    keepTemp: true,
    spawned: false
  });

  assert.equal(result.keptTemp, true);
  assert.equal(result.dbPathRemoved, false);
  assert.deepEqual(result.blockers, []);
  assert.equal(fs.existsSync(dbPath), true);
});

test("cleanup stops a live owned child before removing its temp path", async (t) => {
  const base = makeBaseTemp(t);
  const dbPath = createOwnedTempPath(base, RUN_ID);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true
  });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  const result = await cleanup({
    proc: child,
    port: 27031,
    dbPath,
    baseTemp: base,
    runId: RUN_ID,
    deps: { findListenerPid: () => null }
  });

  assert.equal(result.mongodStopped, true);
  assert.equal(result.dbPathRemoved, true);
  assert.equal(fs.existsSync(dbPath), false);
});

function minimalEffectDocuments(scenario) {
  return {
    task: {
      taskId: scenario.taskId,
      status: "RESOLVED"
    },
    event: {
      eventId: scenario.eventId,
      taskId: scenario.taskId,
      eventType: "RECOVERY_RESOLVED"
    },
    history: {
      historyId: scenario.historyId,
      taskId: scenario.taskId,
      eventId: scenario.eventId,
      state: "COMMITTED"
    }
  };
}

test("buildRealWriterScenario produces the canonical I-C identity sequence without lifecycle writes", () => {
  const scenario = buildRealWriterScenario({
    runId: RUN_ID,
    scenario: "T2-B",
    now: new Date("2026-01-01T00:00:00.000Z")
  });

  assert.match(scenario.taskId, /^REC:v1:[a-f0-9]{32}$/);
  assert.match(scenario.taskKey, /^GRP:[a-f0-9]{24}$/);
  assert.equal(scenario.operationId, `t2-op-${RUN_ID}-T2-B`);
  // W1 seq 1, W2 seq 2, W6 reserves seq 3, W7 writes the effect at seq 3.
  assert.equal(scenario.sequenceNumber, 3);
  assert.equal(scenario.eventId, `EVT:${scenario.taskId}:3`);
  assert.equal(scenario.historyId, `OPH:${scenario.taskId}:${scenario.operationId}`);
  assert.match(scenario.worker.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(scenario.intentDigest, /^[a-f0-9]{64}$/);

  assert.equal(scenario.draft.taskId, scenario.taskId);
  assert.equal(scenario.draft.findingIdentityKey, scenario.taskId);
  assert.equal(scenario.draft.initialFingerprint, scenario.initialFingerprint);
  assert.equal(scenario.draft.currentFingerprint, scenario.currentFingerprint);
  assert.equal(scenario.draft.status, undefined);
  assert.equal(scenario.draft.pendingOperation, undefined);
  assert.equal(scenario.draft.eventSequenceCounter, undefined);
  assert.equal(scenario.draft.leaseToken, undefined);

  assert.deepEqual(scenario.expected.setupEventTypes, [
    "RECOVERY_DETECTED",
    "RECOVERY_LEASED"
  ]);
  assert.equal(scenario.expected.sequenceNumber, 3);
  assert.equal(scenario.expected.eventSequenceCounter, 3);
});

test("evaluateWp04Effects fails closed on missing or mismatched rows", () => {
  const scenario = buildRealWriterScenario({ runId: RUN_ID, scenario: "T2-B" });
  const documents = minimalEffectDocuments(scenario);
  const expected = {
    taskId: scenario.taskId,
    eventId: scenario.eventId,
    historyId: scenario.historyId
  };

  const complete = evaluateWp04Effects({
    ...documents,
    expected: { ...expected, status: "RESOLVED" }
  });
  assert.equal(complete.complete, true);

  const missing = evaluateWp04Effects({
    task: documents.task,
    event: documents.event,
    history: null,
    expected
  });
  assert.equal(missing.complete, false);
  assert.equal(missing.problems.some((problem) => /history row is missing/.test(problem)), true);

  const mismatched = evaluateWp04Effects({
    task: { ...documents.task, status: "DETECTED" },
    event: { ...documents.event, taskId: "REC:v1:00000000000000000000000000000000" },
    history: documents.history,
    expected: { ...expected, status: "RESOLVED" }
  });
  assert.equal(mismatched.complete, false);
  assert.equal(mismatched.problems.length >= 2, true);

  const unexpected = evaluateWp04Effects({
    ...documents,
    expectPresent: false
  });
  assert.equal(unexpected.complete, false);
  assert.equal(unexpected.problems.length, 3);
});

test("negative-control marker carries the commitTransaction literal but no WP04 effect identity", () => {
  const marker = buildNegativeControlMarker({ runId: RUN_ID });
  assert.equal(marker.collectionName, NEGATIVE_CONTROL_COLLECTION);
  assert.equal(NEGATIVE_CONTROL_COLLECTION, "wp04_t2_negative_control_markers");
  assert.equal(marker.literalText, "commitTransaction");
  assert.equal(marker.comment.includes("commitTransaction"), true);
  assert.equal(marker.document.note.includes("commitTransaction"), true);
  assert.equal(marker.document._id, marker.markerId);
  assert.equal(
    Object.values(WP04_COLLECTIONS).includes(marker.collectionName),
    false
  );
});

test("runRealWriterSetup drives W1, W2, W6 in order and reserves the PREPARED operation", async () => {
  const scenario = buildRealWriterScenario({ runId: RUN_ID, scenario: "T2-A" });
  const calls = [];
  const writer = {
    async createTaskFromFinding(input) {
      calls.push({ method: "createTaskFromFinding", input });
      return { taskId: scenario.taskId, eventId: `${scenario.taskId}:1`, sequenceNumber: 1n, status: "DETECTED" };
    },
    async claimLease(input) {
      calls.push({ method: "claimLease", input });
      return { taskId: scenario.taskId, status: "LEASED", leaseGeneration: 1n, sequenceNumber: 2n, eventId: `${scenario.taskId}:2` };
    },
    async reserveOperation(input) {
      calls.push({ method: "reserveOperation", input });
      return {
        taskId: scenario.taskId,
        operationId: scenario.operationId,
        leaseGeneration: 1n,
        sequenceNumber: 3n,
        eventId: scenario.eventId,
        operation: { operationId: scenario.operationId, state: "PREPARED", leaseGeneration: 1n, sequenceNumber: 3n, eventId: scenario.eventId }
      };
    }
  };

  const result = await runRealWriterSetup({
    writer,
    scenario,
    now: new Date("2026-01-01T00:00:00.000Z")
  });

  assert.deepEqual(
    calls.map((call) => call.method),
    ["createTaskFromFinding", "claimLease", "reserveOperation"]
  );
  assert.equal(calls[0].input.task, scenario.draft);
  assert.equal(calls[0].input.actor, scenario.scannerActor);
  assert.equal(calls[1].input.fromStatus, "DETECTED");
  assert.equal(calls[1].input.worker, scenario.worker);
  assert.equal(calls[2].input.intentDigest, scenario.intentDigest);
  assert.equal(calls[2].input.operationId, scenario.operationId);
  assert.equal(result.created.status, "DETECTED");
  assert.equal(result.claimed.status, "LEASED");
  assert.equal(result.reservation.operation.state, "PREPARED");
});

test("runRealWriterSetup refuses a writer that did not reserve the expected identity", async () => {
  const scenario = buildRealWriterScenario({ runId: RUN_ID, scenario: "T2-A" });
  const writer = {
    async createTaskFromFinding() {
      return { taskId: scenario.taskId, status: "DETECTED" };
    },
    async claimLease() {
      return { taskId: scenario.taskId, status: "LEASED" };
    },
    async reserveOperation() {
      return {
        taskId: scenario.taskId,
        operationId: scenario.operationId,
        sequenceNumber: 9n,
        eventId: scenario.eventId,
        operation: { state: "PREPARED" }
      };
    }
  };

  await assert.rejects(
    runRealWriterSetup({ writer, scenario }),
    /W6 did not reserve the expected PREPARED operation identity/
  );
});

test("runRealWriterEffect sends the approved W7 LEASED -> RESOLVED effect", async () => {
  const scenario = buildRealWriterScenario({ runId: RUN_ID, scenario: "T2-B" });
  const reservation = {
    operation: { operationId: scenario.operationId, state: "PREPARED" }
  };
  const calls = [];
  const writer = {
    async commitOperation(input) {
      calls.push(input);
      return {
        taskId: scenario.taskId,
        status: "RESOLVED",
        operationId: scenario.operationId,
        sequenceNumber: 3n,
        eventId: scenario.eventId
      };
    }
  };

  const result = await runRealWriterEffect({
    writer,
    scenario,
    reservation,
    now: new Date("2026-01-01T00:00:00.000Z")
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, scenario.taskId);
  assert.equal(calls[0].operation, reservation.operation);
  assert.equal(calls[0].worker, scenario.worker);
  assert.equal(calls[0].fromStatus, "LEASED");
  assert.equal(calls[0].toStatus, "RESOLVED");
  assert.equal(calls[0].eventType, "RECOVERY_RESOLVED");
  assert.deepEqual(calls[0].fields, {
    resolution: "ALREADY_CORRECT",
    currentFingerprint: scenario.currentFingerprint
  });
  assert.equal(result.status, "RESOLVED");
});

test("createBoundedSessionOpener applies the overall effect withTransaction timeout", async () => {
  const captured = [];
  const session = {
    withTransaction(work, options) {
      captured.push(options);
      return work();
    },
    async endSession() {}
  };
  const connection = { async startSession() { return session; } };

  const open = createBoundedSessionOpener(connection, { timeoutMS: 1_234 });
  const bounded = await open();
  const value = await bounded.withTransaction(async () => "ok", {
    readConcern: { level: "majority" },
    writeConcern: { w: "majority" }
  });

  // The injected value is the overall timeout for the whole withTransaction()
  // call, so a caller-supplied per-call timeoutMS is replaced, not merged.
  const overridden = await bounded.withTransaction(async () => "ok", {
    timeoutMS: 60_000
  });

  assert.equal(value, "ok");
  assert.equal(overridden, "ok");
  assert.deepEqual(captured, [
    {
      readConcern: { level: "majority" },
      writeConcern: { w: "majority" },
      timeoutMS: 1_234
    },
    { timeoutMS: 1_234 }
  ]);

  assert.throws(
    () => createBoundedSessionOpener(connection, { timeoutMS: 0 }),
    /timeoutMS/
  );
  assert.throws(
    () => createBoundedSessionOpener(connection, { timeoutMS: 10_001 }),
    /timeoutMS/
  );
  assert.throws(
    () => createBoundedSessionOpener(connection, { timeoutMS: 1.5 }),
    /timeoutMS/
  );
});

test("assertLoopbackProxyUri refuses non-loopback, credentialed, or non-direct URIs", () => {
  assert.doesNotThrow(() =>
    assertLoopbackProxyUri("mongodb://127.0.0.1:27032/?directConnection=true")
  );
  assert.throws(
    () => assertLoopbackProxyUri("mongodb://example.com:27032/?directConnection=true"),
    /loopback/
  );
  assert.throws(
    () => assertLoopbackProxyUri("mongodb://user:pass@127.0.0.1:27032/?directConnection=true"),
    /credentials/
  );
  assert.throws(
    () => assertLoopbackProxyUri("mongodb://127.0.0.1:27032/"),
    /directConnection=true/
  );
  assert.throws(
    () => assertLoopbackProxyUri("mongodb+srv://127.0.0.1:27032/?directConnection=true"),
    /mongodb:\/\//
  );
});

function syntheticRealWriterScenario({ scenario = "T2-A", effectCommitted = false } = {}) {
  return {
    scenario,
    writerImplementation: REAL_WRITER_MODULE,
    effect: {
      writePath: "createRecoveryTaskWriter.commitOperation",
      invoked: true,
      clientObservedCommitError: true
    },
    writerTrace: [
      { entryPoint: "createTaskFromFinding" },
      { entryPoint: "claimLease" },
      { entryPoint: "reserveOperation" }
    ],
    setup: {
      created: { status: "DETECTED" },
      claimed: { status: "LEASED" },
      reservation: { operation: { state: "PREPARED" } }
    },
    proxy: {
      stats: {
        armed: true,
        commitDetections: 4,
        armedCommitDetections: 1,
        unarmedCommitDetections: 3
      },
      events: [
        { type: "commit-detected", connectionId: 1, requestID: 1, armed: false, seq: 10 },
        { type: "commit-detected", connectionId: 2, requestID: 2, armed: false, seq: 20 },
        { type: "commit-detected", connectionId: 3, requestID: 3, armed: false, seq: 30 },
        { type: "proxy-armed", seq: 31 },
        { type: "commit-detected", connectionId: 4, requestID: 4, armed: true, seq: 40 }
      ]
    },
    commitError: { name: "MongoNetworkError", message: "severed" },
    verification: {
      complete: true,
      effectCommitted,
      problems: []
    }
  };
}

test("assertRealWriterScenarioEvidence accepts only the complete armed real-writer shape", () => {
  assert.doesNotThrow(() =>
    assertRealWriterScenarioEvidence(syntheticRealWriterScenario(), {
      effectCommitted: false
    })
  );

  assert.throws(
    () =>
      assertRealWriterScenarioEvidence(
        { ...syntheticRealWriterScenario(), writerImplementation: "direct-insert" },
        { effectCommitted: false }
      ),
    /canonical writer implementation/
  );

  assert.throws(
    () =>
      assertRealWriterScenarioEvidence(
        {
          ...syntheticRealWriterScenario(),
          proxy: {
            ...syntheticRealWriterScenario().proxy,
            stats: { ...syntheticRealWriterScenario().proxy.stats, armed: false }
          }
        },
        { effectCommitted: false }
      ),
    /never armed/
  );

  const preArmDetection = syntheticRealWriterScenario();
  preArmDetection.proxy.events = preArmDetection.proxy.events.map((event) =>
    event.type === "commit-detected" && event.armed === true
      ? { ...event, seq: 30 }
      : event
  );
  assert.throws(
    () => assertRealWriterScenarioEvidence(preArmDetection, { effectCommitted: false }),
    /pre-arm commit/
  );

  assert.throws(
    () =>
      assertRealWriterScenarioEvidence(
        {
          ...syntheticRealWriterScenario({ effectCommitted: true }),
          verification: { complete: true, effectCommitted: false, problems: [] }
        },
        { effectCommitted: true }
      ),
    /not the expected outcome/
  );
});

test("evaluateWp04EffectState separates the PREPARED hold from the committed effect", () => {
  const scenario = buildRealWriterScenario({ runId: RUN_ID, scenario: "T2-A" });
  const baseTask = {
    taskId: scenario.taskId,
    status: "LEASED",
    pendingOperation: {
      operationId: scenario.operationId,
      state: "PREPARED",
      sequenceNumber: 3,
      eventId: scenario.eventId
    },
    eventSequenceCounter: 3,
    leaseGeneration: 1
  };
  const setupEvents = [
    { eventId: `EVT:${scenario.taskId}:1`, eventType: "RECOVERY_DETECTED" },
    { eventId: `EVT:${scenario.taskId}:2`, eventType: "RECOVERY_LEASED" }
  ];

  const held = evaluateWp04EffectState({
    task: baseTask,
    effectEvent: null,
    effectHistory: null,
    events: setupEvents,
    expected: {
      effectCommitted: false,
      taskId: scenario.taskId,
      operationId: scenario.operationId,
      eventId: scenario.eventId,
      taskStatus: "LEASED",
      operationState: "PREPARED",
      eventSequenceCounter: 3,
      leaseGeneration: 1,
      setupEventTypes: scenario.expected.setupEventTypes
    }
  });
  assert.equal(held.complete, true);
  assert.deepEqual(held.problems, []);
  assert.deepEqual(held.found, {
    task: true,
    effectEvent: false,
    effectHistory: false,
    setupEvents: 2
  });

  const leaked = evaluateWp04EffectState({
    task: baseTask,
    effectEvent: { eventId: scenario.eventId },
    effectHistory: null,
    events: [
      ...setupEvents,
      { eventId: scenario.eventId, eventType: "RECOVERY_RESOLVED", sequenceNumber: 3 }
    ],
    expected: {
      effectCommitted: false,
      taskId: scenario.taskId,
      operationId: scenario.operationId,
      eventId: scenario.eventId,
      taskStatus: "LEASED",
      operationState: "PREPARED",
      eventSequenceNumber: 3
    }
  });
  assert.equal(leaked.complete, false);
  assert.equal(
    leaked.problems.some((problem) => /effect event row is present/.test(problem)),
    true
  );
  assert.equal(
    leaked.problems.some((problem) => /effect event at the reserved sequence/.test(problem)),
    true
  );

  const committed = evaluateWp04EffectState({
    task: {
      ...baseTask,
      status: "RESOLVED",
      resolution: "ALREADY_CORRECT",
      currentFingerprint: scenario.currentFingerprint,
      pendingOperation: { ...baseTask.pendingOperation, state: "COMMITTED" }
    },
    effectEvent: {
      eventId: scenario.eventId,
      taskId: scenario.taskId,
      eventType: "RECOVERY_RESOLVED",
      sequenceNumber: 3
    },
    effectHistory: {
      historyId: scenario.historyId,
      taskId: scenario.taskId,
      eventId: scenario.eventId,
      state: "COMMITTED"
    },
    events: [
      ...setupEvents,
      { eventId: scenario.eventId, eventType: "RECOVERY_RESOLVED", sequenceNumber: 3 }
    ],
    expected: {
      effectCommitted: true,
      taskId: scenario.taskId,
      operationId: scenario.operationId,
      eventId: scenario.eventId,
      historyId: scenario.historyId,
      taskStatus: "RESOLVED",
      operationState: "COMMITTED",
      eventType: "RECOVERY_RESOLVED",
      historyState: "COMMITTED",
      resolution: "ALREADY_CORRECT",
      sequenceNumber: 3,
      eventSequenceCounter: 3,
      leaseGeneration: 1,
      currentFingerprint: scenario.currentFingerprint,
      setupEventTypes: scenario.expected.setupEventTypes
    }
  });
  assert.equal(committed.complete, true);
  assert.deepEqual(committed.problems, []);
});

test("readWp04EffectStateWithClient reads the task, effect rows, and all task events", async () => {
  const scenario = buildRealWriterScenario({ runId: RUN_ID, scenario: "T2-A" });
  const calls = [];
  let effectEventDocument = null;
  const documents = {
    [WP04_COLLECTIONS.task]: { taskId: scenario.taskId },
    [WP04_COLLECTIONS.history]: { historyId: scenario.historyId }
  };
  const events = [
    { eventId: `EVT:${scenario.taskId}:1` },
    { eventId: `EVT:${scenario.taskId}:2` }
  ];

  const fakeClient = {
    db(name) {
      assert.equal(name, "wp04_t2_effect_state_test");
      return {
        collection(collectionName) {
          return {
            async findOne(filter, options) {
              calls.push({ kind: "findOne", collectionName, filter, options });
              if (collectionName === WP04_COLLECTIONS.event) {
                return effectEventDocument;
              }
              return documents[collectionName] ?? null;
            },
            find(filter, options) {
              calls.push({ kind: "find", collectionName, filter, options });
              return { async toArray() { return events; } };
            }
          };
        }
      };
    }
  };

  const result = await readWp04EffectStateWithClient(fakeClient, {
    dbName: "wp04_t2_effect_state_test",
    taskId: scenario.taskId,
    eventId: scenario.eventId,
    historyId: scenario.historyId
  });

  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.map((call) => call.collectionName),
    [
      WP04_COLLECTIONS.task,
      WP04_COLLECTIONS.event,
      WP04_COLLECTIONS.history,
      WP04_COLLECTIONS.event
    ]
  );
  assert.deepEqual(calls[2].filter, { historyId: scenario.historyId });
  assert.deepEqual(calls[3].filter, { taskId: scenario.taskId });
  assert.deepEqual(calls[3].options.sort, { sequenceNumber: 1 });
  for (const call of calls) {
    assert.equal(call.options.readPreference, "primary");
    assert.equal(call.options.readConcern.level, "majority");
  }
  assert.equal(result.task.taskId, scenario.taskId);
  assert.equal(result.effectEvent, null);
  assert.equal(result.effectHistory.historyId, scenario.historyId);
  assert.deepEqual(result.events, events);
});

test("P4 verifier options cannot override safety settings", async () => {
  assert.deepEqual(assertVerifierOptions({}), {});
  assert.deepEqual(assertVerifierOptions({ serverSelectionTimeoutMS: 1_000 }), {
    serverSelectionTimeoutMS: 1_000
  });

  for (const forbidden of [
    { readPreference: "secondary" },
    { readConcern: { level: "local" } },
    { directConnection: false },
    { retryWrites: true },
    { retryReads: true }
  ]) {
    assert.throws(() => assertVerifierOptions(forbidden), /cannot be overridden/);
    assert.throws(
      () => createIndependentVerifierClient("mongodb://127.0.0.1:1", forbidden),
      /cannot be overridden/
    );
  }

  const client = createIndependentVerifierClient("mongodb://127.0.0.1:1", {
    serverSelectionTimeoutMS: 1_000
  });
  try {
    assert.equal(client.options.directConnection, true);
    assert.equal(client.readPreference.mode, VERIFIER_READ_PREFERENCE);
    assert.equal(client.options.readConcern.level, VERIFIER_READ_CONCERN.level);
    assert.equal(client.options.retryWrites, false);
    assert.equal(client.options.retryReads, false);
  } finally {
    await client.close();
  }
});

test("verifier reads all three actual WP04 collections with primary/majority", async () => {
  const scenario = buildRealWriterScenario({ runId: RUN_ID, scenario: "T2-B" });
  const calls = [];
  const documents = {
    [WP04_COLLECTIONS.task]: { taskId: scenario.taskId },
    [WP04_COLLECTIONS.event]: { eventId: scenario.eventId },
    [WP04_COLLECTIONS.history]: { historyId: scenario.historyId }
  };

  const fakeClient = {
    db(name) {
      assert.equal(name, "wp04_t2_verifier_test");
      return {
        collection(collectionName) {
          return {
            async findOne(filter, options) {
              calls.push({ collectionName, filter, options });
              return documents[collectionName] ?? null;
            }
          };
        }
      };
    }
  };

  const result = await readWp04EffectsWithClient(fakeClient, {
    dbName: "wp04_t2_verifier_test",
    taskId: scenario.taskId,
    eventId: scenario.eventId,
    historyId: scenario.historyId
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.collectionName),
    [WP04_COLLECTIONS.task, WP04_COLLECTIONS.event, WP04_COLLECTIONS.history]
  );
  assert.deepEqual(calls[0].filter, { taskId: scenario.taskId });
  assert.deepEqual(calls[1].filter, { eventId: scenario.eventId });
  assert.deepEqual(calls[2].filter, { historyId: scenario.historyId });
  for (const call of calls) {
    assert.equal(call.options.readPreference, "primary");
    assert.equal(call.options.readConcern.level, "majority");
  }
  assert.equal(result.task.taskId, scenario.taskId);
  assert.equal(result.event.eventId, scenario.eventId);
  assert.equal(result.history.historyId, scenario.historyId);
});

test("verifier reads the actual WP04 collections with primary/majority", () => {
  const source = readFileSync(`${SUPPORT_DIR}t2Verifier.mjs`, "utf8");
  assert.match(source, /inventory_recovery_tasks/);
  assert.match(source, /inventory_recovery_events/);
  assert.match(source, /inventory_recovery_operation_history/);
  assert.match(source, /readPreference:\s*VERIFIER_READ_PREFERENCE/);
  assert.match(source, /level:\s*"majority"/);
  assert.equal(WP04_COLLECTIONS.task, "inventory_recovery_tasks");
  assert.equal(WP04_COLLECTIONS.event, "inventory_recovery_events");
  assert.equal(WP04_COLLECTIONS.history, "inventory_recovery_operation_history");
  assert.equal(VERIFIER_READ_PREFERENCE, "primary");
});

function syntheticScenario({ scenario, stats, events }) {
  return { scenario, proxy: { stats, events } };
}

test("T2-A and T2-B event/correlation assertions accept consistent evidence", () => {
  const t2a = syntheticScenario({
    scenario: "T2-A",
    stats: {
      commitDetections: 1,
      forwardedCommit: false,
      withheldCommit: true,
      ackDropped: false,
      droppedAckResponseTo: null
    },
    events: [
      { type: "commit-detected", requestID: 100 },
      { type: "commit-withheld", requestID: 100 },
      { type: "connection-severed", reason: "pre-commit-severance" }
    ]
  });
  assert.doesNotThrow(() =>
    assertProxyScenarioEvidence(t2a, {
      withheld: true,
      severReason: "pre-commit-severance"
    })
  );

  const t2b = syntheticScenario({
    scenario: "T2-B",
    stats: {
      commitDetections: 1,
      forwardedCommit: true,
      withheldCommit: false,
      ackDropped: true,
      droppedAckResponseTo: 200
    },
    events: [
      { type: "commit-detected", requestID: 200 },
      { type: "commit-forwarded", requestID: 200 },
      {
        type: "commit-ack-dropped",
        responseTo: 200,
        correlatedRequestID: 200,
        correlatedCommand: "commitTransaction"
      },
      { type: "connection-severed", reason: "post-commit-ack-loss" }
    ]
  });
  assert.doesNotThrow(() =>
    assertProxyScenarioEvidence(t2b, {
      forwarded: true,
      ackDropped: true,
      severReason: "post-commit-ack-loss"
    })
  );
});

test("T2-A and T2-B event/correlation assertions reject inconsistent evidence", () => {
  const t2b = syntheticScenario({
    scenario: "T2-B",
    stats: {
      commitDetections: 1,
      forwardedCommit: true,
      withheldCommit: false,
      ackDropped: true,
      droppedAckResponseTo: 200
    },
    events: [
      { type: "commit-detected", requestID: 200 },
      { type: "commit-forwarded", requestID: 200 },
      {
        type: "commit-ack-dropped",
        responseTo: 201,
        correlatedRequestID: 201,
        correlatedCommand: "commitTransaction"
      },
      { type: "connection-severed", reason: "post-commit-ack-loss" }
    ]
  });
  assert.throws(
    () =>
      assertProxyScenarioEvidence(t2b, {
        forwarded: true,
        ackDropped: true,
        severReason: "post-commit-ack-loss"
      }),
    /does not match commit requestID/
  );

  const leaked = syntheticScenario({
    scenario: "T2-A",
    stats: {
      commitDetections: 1,
      forwardedCommit: true,
      withheldCommit: true,
      ackDropped: false,
      droppedAckResponseTo: null
    },
    events: [
      { type: "commit-detected", requestID: 300 },
      { type: "commit-withheld", requestID: 300 },
      { type: "commit-forwarded", requestID: 300 },
      { type: "connection-severed", reason: "pre-commit-severance" }
    ]
  });
  assert.throws(
    () =>
      assertProxyScenarioEvidence(leaked, {
        withheld: true,
        severReason: "pre-commit-severance"
      }),
    /forwarded a commit/
  );
});

test("T2-A accepts multiple commit retries when every commit is withheld and none is forwarded", () => {
  const events = [];
  for (let connectionId = 1; connectionId <= 3; connectionId += 1) {
    events.push({ type: "commit-detected", connectionId, requestID: 1 });
    events.push({ type: "commit-withheld", connectionId, requestID: 1 });
    events.push({
      type: "connection-severed",
      connectionId,
      reason: "pre-commit-severance"
    });
  }

  const t2a = syntheticScenario({
    scenario: "T2-A",
    stats: {
      commitDetections: 3,
      forwardedCommit: false,
      withheldCommit: true,
      ackDropped: false,
      droppedAckResponseTo: null
    },
    events
  });

  assert.doesNotThrow(() =>
    assertProxyScenarioEvidence(t2a, {
      withheld: true,
      severReason: "pre-commit-severance"
    })
  );
});

test("T2-A rejects a retry batch when any detected commit was forwarded", () => {
  const t2a = syntheticScenario({
    scenario: "T2-A",
    stats: {
      commitDetections: 2,
      forwardedCommit: true,
      withheldCommit: true,
      ackDropped: false,
      droppedAckResponseTo: null
    },
    events: [
      { type: "commit-detected", connectionId: 1, requestID: 1 },
      { type: "commit-withheld", connectionId: 1, requestID: 1 },
      { type: "connection-severed", connectionId: 1, reason: "pre-commit-severance" },
      { type: "commit-detected", connectionId: 2, requestID: 1 },
      { type: "commit-forwarded", connectionId: 2, requestID: 1 },
      { type: "connection-severed", connectionId: 2, reason: "post-commit-ack-loss" }
    ]
  });

  assert.throws(
    () =>
      assertProxyScenarioEvidence(t2a, {
        withheld: true,
        severReason: "pre-commit-severance"
      }),
    /forwarded a commit/
  );
});

test("T2-A rejects a detection without a matching withheld event", () => {
  const t2a = syntheticScenario({
    scenario: "T2-A",
    stats: {
      commitDetections: 2,
      forwardedCommit: false,
      withheldCommit: true,
      ackDropped: false,
      droppedAckResponseTo: null
    },
    events: [
      { type: "commit-detected", connectionId: 1, requestID: 1 },
      { type: "commit-withheld", connectionId: 1, requestID: 1 },
      { type: "connection-severed", connectionId: 1, reason: "pre-commit-severance" },
      { type: "commit-detected", connectionId: 2, requestID: 1 }
    ]
  });

  assert.throws(
    () =>
      assertProxyScenarioEvidence(t2a, {
        withheld: true,
        severReason: "pre-commit-severance"
      }),
    /every detected commit must be matched/
  );
});

test("T2-A rejects a missing pre-commit severance reason", () => {
  const t2a = syntheticScenario({
    scenario: "T2-A",
    stats: {
      commitDetections: 1,
      forwardedCommit: false,
      withheldCommit: true,
      ackDropped: false,
      droppedAckResponseTo: null
    },
    events: [
      { type: "commit-detected", connectionId: 1, requestID: 1 },
      { type: "commit-withheld", connectionId: 1, requestID: 1 },
      { type: "connection-severed", connectionId: 1, reason: "server-socket-error" }
    ]
  });

  assert.throws(
    () =>
      assertProxyScenarioEvidence(t2a, {
        withheld: true,
        severReason: "pre-commit-severance"
      }),
    /did not sever connection 1 with reason 'pre-commit-severance'/
  );
});

test("T2-A rejects a scenario with no parsed commit detection", () => {
  const t2a = syntheticScenario({
    scenario: "T2-A",
    stats: {
      commitDetections: 0,
      forwardedCommit: false,
      withheldCommit: false,
      ackDropped: false,
      droppedAckResponseTo: null
    },
    events: []
  });

  assert.throws(
    () =>
      assertProxyScenarioEvidence(t2a, {
        withheld: true,
        severReason: "pre-commit-severance"
      }),
    /did not detect any parsed commitTransaction frame/
  );
});

test("T2-B accepts multiple forwarded commits with matching ACK drops", () => {
  const events = [];
  for (let connectionId = 1; connectionId <= 2; connectionId += 1) {
    events.push({ type: "commit-detected", connectionId, requestID: 1 });
    events.push({ type: "commit-forwarded", connectionId, requestID: 1 });
    events.push({
      type: "commit-ack-dropped",
      connectionId,
      responseTo: 1,
      correlatedRequestID: 1,
      correlatedCommand: "commitTransaction"
    });
    events.push({
      type: "connection-severed",
      connectionId,
      reason: "post-commit-ack-loss"
    });
  }

  const t2b = syntheticScenario({
    scenario: "T2-B",
    stats: {
      commitDetections: 2,
      forwardedCommit: true,
      withheldCommit: false,
      ackDropped: true,
      droppedAckResponseTo: 1
    },
    events
  });

  assert.doesNotThrow(() =>
    assertProxyScenarioEvidence(t2b, {
      forwarded: true,
      ackDropped: true,
      severReason: "post-commit-ack-loss"
    })
  );
});

test("buildScenarioDiagnostics records every commit-detected, withheld, and forwarded event", () => {
  const diagnostics = buildScenarioDiagnostics({
    proxy: {
      stats: {
        commitDetections: 2,
        forwardedCommit: true,
        withheldCommit: true,
        ackDropped: true,
        droppedAckResponseTo: 2
      },
      events: [
        { type: "commit-detected", connectionId: 1, requestID: 1 },
        { type: "commit-withheld", connectionId: 1, requestID: 1 },
        { type: "commit-detected", connectionId: 2, requestID: 2 },
        { type: "commit-forwarded", connectionId: 2, requestID: 2 },
        {
          type: "commit-ack-dropped",
          connectionId: 2,
          responseTo: 2,
          correlatedRequestID: 2,
          correlatedCommand: "commitTransaction"
        },
        { type: "legacy-frame-forwarded", opCode: 2004 }
      ]
    }
  });

  assert.equal(diagnostics.commitDetections, 2);
  assert.deepEqual(
    diagnostics.commitDetectedEvents.map((event) => event.requestID),
    [1, 2]
  );
  assert.deepEqual(
    diagnostics.commitWithheldEvents.map((event) => event.requestID),
    [1]
  );
  assert.deepEqual(
    diagnostics.commitForwardedEvents.map((event) => event.requestID),
    [2]
  );
  assert.equal(diagnostics.commitAckDroppedEvents.length, 1);
  assert.equal(diagnostics.connectionSeveredEvents.length, 0);
});

test("failed-scenario diagnostics persist and the assertion error is retained alongside cleanup", () => {
  const evidence = { status: "STARTED", scenarios: {}, assertions: {} };
  const scenario = syntheticScenario({
    scenario: "T2-A",
    stats: {
      commitDetections: 2,
      forwardedCommit: false,
      withheldCommit: true,
      ackDropped: false,
      droppedAckResponseTo: null
    },
    events: [
      { type: "commit-detected", connectionId: 1, requestID: 1 },
      { type: "commit-withheld", connectionId: 1, requestID: 1 },
      { type: "connection-severed", connectionId: 1, reason: "pre-commit-severance" },
      { type: "commit-detected", connectionId: 2, requestID: 1 }
    ]
  });

  recordScenarioEvidence(evidence, "T2_A", scenario);
  assert.throws(
    () =>
      recordScenarioAssertion(evidence, "T2_A", () => {
        assertProxyScenarioEvidence(scenario, {
          withheld: true,
          severReason: "pre-commit-severance"
        });
      }),
    /every detected commit must be matched/
  );

  evidence.status = "FAILED_CLOSED";
  evidence.error = {
    name: "Error",
    message: "every detected commit must be matched"
  };
  evidence.cleanup = {
    mongodStopped: true,
    dbPathRemoved: true,
    keptTemp: false,
    notes: [],
    blockers: []
  };

  assert.equal(evidence.scenarios.T2_A.diagnostics.commitDetections, 2);
  assert.equal(evidence.scenarios.T2_A.diagnostics.commitDetectedEvents.length, 2);
  assert.equal(evidence.scenarios.T2_A.diagnostics.commitWithheldEvents.length, 1);
  assert.equal(evidence.assertions.T2_A.status, "FAILED");
  assert.match(evidence.assertions.T2_A.error.message, /every detected commit must be matched/);
  assert.equal(evidence.cleanup.dbPathRemoved, true);
  assert.equal(evidence.status, "FAILED_CLOSED");
  assert.equal(evidence.scenarios.T2_A.proxy.stats.commitDetections, 2);
  assert.equal(evidence.scenarios.T2_A.proxy.events.length, 4);
});

test("P6 environment capture maps the explicitly requested MongoDB 8.0 oplog section", () => {
  const latestOptime = { $timestamp: { t: 1_700_000_000, i: 2 } };
  const earliestOptime = { $timestamp: { t: 1_700_000_000, i: 1 } };
  const environment = buildEnvironmentEvidence({
    node: "v24.14.0",
    driver: "7.5.0",
    osLabel: "Windows_NT 10.0.26200 x64",
    mongodPath: "C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe",
    buildInfo: { version: "8.0.34", gitVersion: "abc123" },
    cmdLine: { parsed: { replication: { oplogSizeMB: 128 } } },
    serverStatus: {
      storageEngine: { name: "wiredTiger" },
      oplog: { latestOptime, earliestOptime }
    },
    replicaStatus: { set: "bonowp0406t2rs" },
    mongodPort: 27031,
    proxyPort: 27032,
    host: "XANIEL"
  });

  assert.deepEqual(environment.oplog, { latestOptime, earliestOptime });
  assert.equal(environment.oplogSizeMB, 128);
  assert.equal(environment.storageEngine, "wiredTiger");
  assert.equal(environment.replicaSetName, "bonowp0406t2rs");
  assert.equal(environment.mongodbVersion, "8.0.34");
});

test("P6 environment capture records oplog as null when the section is absent", () => {
  const environment = buildEnvironmentEvidence({
    buildInfo: { version: "8.0.34" },
    cmdLine: { parsed: {} },
    serverStatus: { storageEngine: { name: "wiredTiger" }, oplog: {} },
    replicaStatus: { set: "bonowp0406t2rs" },
    mongodPort: 27031,
    proxyPort: 27032
  });

  assert.equal(environment.oplog, null);
  assert.equal(environment.oplogSizeMB, null);
  assert.equal(environment.mongodbVersion, "8.0.34");
});

test("runner source contains the fail-closed and correlation guards", () => {
  const runner = readFileSync(`${TESTS_DIR}integration/wp04-06-t2-runner.mjs`, "utf8");
  const proxy = readFileSync(`${SUPPORT_DIR}t2Proxy.mjs`, "utf8");

  assert.match(runner, /validateMongodExecutable/);
  assert.match(runner, /flag:\s*"wx"/);
  assert.match(runner, /TEMP_PATH_RETAINED_CHILD_ALIVE/);
  assert.match(runner, /TEMP_PATH_RETAINED_OWNERSHIP_AMBIGUOUS/);
  assert.match(runner, /assertProxyScenarioEvidence/);
  assert.match(runner, /correlatedCommand/);
  assert.match(runner, /serverStatus:\s*1,\s*oplog:\s*1/);
  assert.match(runner, /inventory_recovery_tasks|WP04_COLLECTIONS/);
  // Active evidence metadata names the overall withTransaction timeout rather
  // than a commit-retry deadline. The legacy label survives only in historical
  // evidence files and in the report's historical-explanation note.
  assert.match(runner, /boundedWithTransactionTimeoutMS/);
  assert.equal(/boundedCommitRetryTimeoutMS/.test(runner), false);

  assert.match(proxy, /One OpMsgStreamDemultiplexer is shared|a single demultiplexer/i);
  assert.match(proxy, /commitRequestIDs/);
  assert.equal(/\.includes\(\s*Buffer\.from\(\s*["']commitTransaction["']/.test(proxy), false);
  assert.equal(/\.includes\(\s*Buffer\.from\(\s*["']commitTransaction["']/.test(runner), false);
});

// -----------------------------------------------------------------------------
// T5-CRASH / T8-CRASH — DB-free runner-structure tests.
//
// These tests cover only the pure scenario-spec, child-argument, and
// evidence-assertion layers. A passing result is harness evidence only; it is
// NOT crash/restart execution evidence and does not close any blocker.
// -----------------------------------------------------------------------------

function evidenceSpec(spec) {
  return {
    ...spec,
    now: spec.now,
    draft: { ...spec.draft, orderId: spec.draft.orderId.toHexString() }
  };
}

test("buildRealWriterScenario honours a short crash lease without changing the accepted default", () => {
  const shortLease = buildRealWriterScenario({
    runId: RUN_ID,
    scenario: "T8-CRASH",
    leaseMs: 2_000
  });
  assert.equal(shortLease.worker.leaseMs, 2_000);

  const defaultLease = buildRealWriterScenario({ runId: RUN_ID, scenario: "T5-CRASH" });
  assert.equal(defaultLease.worker.leaseMs, REAL_WRITER_LEASE_MS);
  assert.equal(REAL_WRITER_LEASE_MS, 60 * 60 * 1_000);

  assert.throws(
    () => buildRealWriterScenario({ runId: RUN_ID, scenario: "T8-CRASH", leaseMs: 0 }),
    /leaseMs/
  );
  assert.throws(
    () =>
      buildRealWriterScenario({
        runId: RUN_ID,
        scenario: "T8-CRASH",
        leaseMs: REAL_WRITER_LEASE_MS + 1
      }),
    /leaseMs/
  );
});

test("crash worker argument parsing enforces roles, loopback URIs, and the arm-control contract", (t) => {
  const base = makeBaseTemp(t);
  const specFile = path.join(base, "spec.json");
  fs.writeFileSync(specFile, "{}");
  const statusFile = path.join(base, "status.json");
  const controlFile = path.join(base, "control.json");
  const uri = "mongodb://127.0.0.1:27031/bono_recovery_wp04_06_t2_0123456789ab?directConnection=true";

  const parsed = parseCrashWorkerArgs([
    "--role", "t8-victim",
    "--spec-file", specFile,
    "--status-file", statusFile,
    "--control-file", controlFile,
    "--uri", uri
  ]);
  assert.equal(parsed.role, "t8-victim");
  assert.equal(parsed.dbName, "bono_recovery_wp04_06_t2_0123456789ab");
  assert.equal(parsed.uri, uri);

  assert.deepEqual([...CRASH_WORKER_ROLES], ["t5-victim", "t5-fresh", "t8-victim", "t8-fresh"]);
  assert.equal(CRASH_WORKER_MODULE, "tests/integration/support/t2CrashWorker.mjs");

  const valid = ["--role", "t5-fresh", "--spec-file", specFile, "--status-file", statusFile, "--uri", uri];
  assert.throws(() => parseCrashWorkerArgs(["--role", "t9-victim", ...valid.slice(2)]), /role must be one of/);
  assert.throws(
    () => parseCrashWorkerArgs(["--role", "t8-victim", ...valid.slice(2)]),
    /control-file/
  );
  assert.throws(
    () => parseCrashWorkerArgs([...valid, "--control-file", controlFile]),
    /must not receive a control file/
  );
  assert.throws(
    () =>
      parseCrashWorkerArgs([
        ...valid.slice(0, valid.length - 2),
        "--uri", "mongodb://example.com:27031/db?directConnection=true"
      ]),
    /loopback/
  );
  assert.throws(
    () =>
      parseCrashWorkerArgs([
        ...valid.slice(0, valid.length - 2),
        "--uri", "mongodb://127.0.0.1:27031/db"
      ]),
    /directConnection=true/
  );
  assert.throws(
    () =>
      parseCrashWorkerArgs([
        ...valid.slice(0, valid.length - 2),
        "--uri", "mongodb://127.0.0.1:27031/?directConnection=true"
      ]),
    /database name/
  );
  assert.throws(
    () =>
      parseCrashWorkerArgs([
        "--role", "t5-fresh",
        "--spec-file", path.join(base, "missing-spec.json"),
        "--status-file", statusFile,
        "--uri", uri
      ]),
    /spec file does not exist/
  );
  assert.throws(() => parseCrashWorkerArgs(["--unknown"]), /Unknown crash worker argument/);
});

test("crash spec serialization round-trips the ObjectId draft and the scenario identity", () => {
  const spec = buildRealWriterScenario({ runId: RUN_ID, scenario: "T5-CRASH" });
  const revived = reviveCrashScenarioSpec(serializeCrashScenarioSpec(spec));

  assert.equal(revived.taskId, spec.taskId);
  assert.equal(revived.operationId, spec.operationId);
  assert.equal(revived.eventId, spec.eventId);
  assert.equal(revived.draft.orderId.toHexString(), spec.draft.orderId.toHexString());
  assert.deepEqual(revived.worker, spec.worker);
  assert.equal(revived.now instanceof Date, true);
  assert.equal(revived.now.toISOString(), spec.now.toISOString());
  assert.deepEqual(revived.expected.setupEventTypes, spec.expected.setupEventTypes);

  assert.throws(
    () => reviveCrashScenarioSpec(JSON.stringify({ crashWorkerSpecVersion: 2 })),
    /version mismatch/
  );
  assert.throws(
    () =>
      serializeCrashScenarioSpec({
        ...spec,
        draft: { ...spec.draft, orderId: "0123456789abcdef01234567" }
      }),
    /ObjectId/
  );
});

function syntheticCrashRestartResult() {
  const spec = buildRealWriterScenario({ runId: RUN_ID, scenario: "T5-CRASH" });
  return {
    spec,
    result: {
      scenario: "T5-CRASH",
      kind: "crash-restart",
      writerImplementation: REAL_WRITER_MODULE,
      spec: evidenceSpec(spec),
      children: {
        victim: {
          role: "t5-victim",
          pid: 111,
          status: {
            role: "t5-victim",
            pid: 111,
            phase: "setup-complete",
            writerTrace: [
              { entryPoint: "createTaskFromFinding" },
              { entryPoint: "claimLease" },
              { entryPoint: "reserveOperation" }
            ]
          },
          termination: {
            requestedSignal: "SIGKILL",
            requestedAt: new Date().toISOString(),
            exited: true,
            exitCode: 1,
            signalCode: null
          }
        },
        fresh: {
          role: "t5-fresh",
          pid: 222,
          exitCode: 0,
          reconciledStatus: {
            phase: "reconciled-hold",
            assessment: { state: "UNRESOLVED", action: "HOLD", replayable: false },
            matchesSpec: true,
            writesPerformed: 0,
            partialEffect: { effectEventPresent: false, effectHistoryPresent: false }
          },
          status: {
            phase: "w7-complete",
            result: {
              taskId: spec.taskId,
              status: "RESOLVED",
              operationId: spec.operationId,
              sequenceNumber: 3,
              eventId: spec.eventId
            }
          }
        }
      },
      verification: {
        complete: true,
        effectCommitted: true,
        problems: [],
        found: { task: true, effectEvent: true, effectHistory: true, setupEvents: 2 },
        documents: {
          task: {
            taskId: spec.taskId,
            status: "RESOLVED",
            pendingOperation: { state: "COMMITTED" }
          },
          effectEvent: {
            eventId: spec.eventId,
            taskId: spec.taskId,
            eventType: "RECOVERY_RESOLVED",
            sequenceNumber: 3,
            fencingToken: spec.worker.token
          },
          effectHistory: { historyId: spec.historyId, state: "COMMITTED" }
        }
      },
      counts: { events: 3, history: 1 },
      notes: []
    }
  };
}

test("T5 crash-restart evidence assertion accepts only the exact crash/restart outcome", () => {
  const { result } = syntheticCrashRestartResult();
  assert.doesNotThrow(() => assertCrashRestartEvidence(result));

  const victimAttemptedEffect = syntheticCrashRestartResult();
  victimAttemptedEffect.result.children.victim.status.writerTrace.push({
    entryPoint: "commitOperation"
  });
  assert.throws(
    () => assertCrashRestartEvidence(victimAttemptedEffect.result),
    /first effect attempt/
  );

  const notExited = syntheticCrashRestartResult();
  notExited.result.children.victim.termination.exited = false;
  assert.throws(() => assertCrashRestartEvidence(notExited.result), /confirmed exited/);

  const wrote = syntheticCrashRestartResult();
  wrote.result.children.fresh.reconciledStatus.writesPerformed = 1;
  assert.throws(() => assertCrashRestartEvidence(wrote.result), /reconciliation performed writes/);

  const wrongIdentity = syntheticCrashRestartResult();
  wrongIdentity.result.children.fresh.status.result.operationId = "t2-op-other";
  assert.throws(
    () => assertCrashRestartEvidence(wrongIdentity.result),
    /reserved operation identity/
  );

  const wrongToken = syntheticCrashRestartResult();
  wrongToken.result.verification.documents.effectEvent.fencingToken = "not-the-reserved-token";
  assert.throws(() => assertCrashRestartEvidence(wrongToken.result), /fencing token/);

  const uncommitted = syntheticCrashRestartResult();
  uncommitted.result.verification.effectCommitted = false;
  assert.throws(() => assertCrashRestartEvidence(uncommitted.result), /not committed/);

  const extraEvent = syntheticCrashRestartResult();
  extraEvent.result.counts.events = 4;
  assert.throws(() => assertCrashRestartEvidence(extraEvent.result), /exactly three events/);

  const extraHistory = syntheticCrashRestartResult();
  extraHistory.result.counts.history = 2;
  assert.throws(() => assertCrashRestartEvidence(extraHistory.result), /exactly one history row/);
});

function syntheticCrashAbandonmentResult() {
  const spec = buildRealWriterScenario({ runId: RUN_ID, scenario: "T8-CRASH", leaseMs: 2_000 });
  return {
    spec,
    result: {
      scenario: "T8-CRASH",
      kind: "crash-abandonment",
      writerImplementation: REAL_WRITER_MODULE,
      spec: evidenceSpec(spec),
      arm: { armed: true, changed: true, seq: 40 },
      withheldEvent: { type: "commit-withheld", held: true, connectionId: 7, requestID: 44 },
      proxy: {
        stats: {
          mode: PROXY_MODES.WITHHOLD_COMMIT_HOLD,
          armed: true,
          commitDetections: 4,
          armedCommitDetections: 1,
          unarmedCommitDetections: 3,
          forwardedCommit: false,
          withheldCommit: true,
          ackDropped: false
        },
        events: []
      },
      children: {
        victim: {
          role: "t8-victim",
          pid: 333,
          setupStatus: {
            role: "t8-victim",
            pid: 333,
            phase: "setup-complete",
            writerTrace: [
              { entryPoint: "createTaskFromFinding" },
              { entryPoint: "claimLease" },
              { entryPoint: "reserveOperation" }
            ]
          },
          w7StartedStatus: { role: "t8-victim", pid: 333, phase: "w7-started" },
          finalStatus: { role: "t8-victim", pid: 333, phase: "w7-started" },
          termination: {
            requestedSignal: "SIGKILL",
            requestedAt: new Date().toISOString(),
            exited: true,
            exitCode: 1,
            signalCode: null
          }
        },
        fresh: {
          role: "t8-fresh",
          pid: 444,
          exitCode: 0,
          reconciledStatus: {
            phase: "reconciled-hold",
            assessment: { state: "UNRESOLVED", action: "HOLD", replayable: false },
            matchesSpec: true,
            writesPerformed: 0
          },
          status: {
            phase: "w8-complete",
            authorization: {
              id: `crash-abandon:${RUN_ID}:T8-CRASH`,
              operationId: spec.operationId,
              operatorId: "wp04-06-crash-operator",
              operatorRole: "ROLE-INVENTORY-MANAGER",
              basis: "OPERATOR_DECISION_AFTER_HOLD"
            },
            result: {
              taskId: spec.taskId,
              status: "MANUAL_REQUIRED",
              operationId: spec.operationId,
              sequenceNumber: 4,
              eventId: `EVT:${spec.taskId}:4`
            }
          }
        }
      },
      postKillVerification: {
        complete: true,
        effectCommitted: false,
        problems: [],
        found: { task: true, effectEvent: false, effectHistory: false, setupEvents: 2 },
        documents: {
          task: {
            taskId: spec.taskId,
            status: "LEASED",
            pendingOperation: { state: "PREPARED", operationId: spec.operationId }
          },
          effectEvent: null,
          effectHistory: null,
          events: []
        }
      },
      postKillCounts: { events: 2, history: 0 },
      abandonmentVerification: {
        complete: true,
        problems: [],
        found: { task: true, settlementEvent: true, settlementHistory: true }
      },
      counts: { events: 3, history: 1 },
      notes: []
    }
  };
}

test("T8 crash-abandonment evidence assertion enforces the mid-W7 kill and the OD-37 settlement", () => {
  const { result } = syntheticCrashAbandonmentResult();
  assert.doesNotThrow(() => assertCrashAbandonmentEvidence(result));

  const killedTooLate = syntheticCrashAbandonmentResult();
  killedTooLate.result.children.victim.finalStatus.phase = "w7-client-error";
  assert.throws(
    () => assertCrashAbandonmentEvidence(killedTooLate.result),
    /still inside the withheld commit await/
  );

  const forwarded = syntheticCrashAbandonmentResult();
  forwarded.result.proxy.stats.forwardedCommit = true;
  assert.throws(
    () => assertCrashAbandonmentEvidence(forwarded.result),
    /armed withheld commit/
  );

  const partialEffect = syntheticCrashAbandonmentResult();
  partialEffect.result.postKillVerification.found.effectHistory = true;
  assert.throws(
    () => assertCrashAbandonmentEvidence(partialEffect.result),
    /partial effect row/
  );

  const committedCrashWorld = syntheticCrashAbandonmentResult();
  committedCrashWorld.result.postKillVerification.effectCommitted = true;
  assert.throws(
    () => assertCrashAbandonmentEvidence(committedCrashWorld.result),
    /uncommitted world/
  );

  const wrongAbandonmentIdentity = syntheticCrashAbandonmentResult();
  wrongAbandonmentIdentity.result.children.fresh.status.authorization.operationId = "t2-op-other";
  assert.throws(
    () => assertCrashAbandonmentEvidence(wrongAbandonmentIdentity.result),
    /does not name the reserved operation identity/
  );

  const wrongBasis = syntheticCrashAbandonmentResult();
  wrongBasis.result.children.fresh.status.authorization.basis = "OPERATOR_HUNCH";
  assert.throws(
    () => assertCrashAbandonmentEvidence(wrongBasis.result),
    /approved audit basis/
  );

  const wrongSettlementSequence = syntheticCrashAbandonmentResult();
  wrongSettlementSequence.result.children.fresh.status.result.sequenceNumber = 5;
  assert.throws(
    () => assertCrashAbandonmentEvidence(wrongSettlementSequence.result),
    /post-abandonment sequence/
  );

  const gapClosed = syntheticCrashAbandonmentResult();
  gapClosed.result.counts.events = 4;
  assert.throws(() => assertCrashAbandonmentEvidence(gapClosed.result), /exactly three events/);
});

test("abandonment P4 evaluation enforces the settlement identity, the permanent gap, and one history row", () => {
  const spec = buildRealWriterScenario({ runId: RUN_ID, scenario: "T8-CRASH", leaseMs: 2_000 });
  const settlementEventId = `EVT:${spec.taskId}:4`;
  const task = {
    taskId: spec.taskId,
    status: "MANUAL_REQUIRED",
    manualReasonCode: "AMBIGUOUS_COMMIT",
    escalation: { code: "ESC_UNKNOWN_COMMIT" },
    pendingOperation: {
      operationId: spec.operationId,
      state: "ABANDONED",
      eventId: spec.eventId,
      settlement: {
        authorizationId: `crash-abandon:${RUN_ID}:T8-CRASH`,
        operatorId: "wp04-06-crash-operator",
        operatorRole: "ROLE-INVENTORY-MANAGER",
        basis: "OPERATOR_DECISION_AFTER_HOLD",
        at: new Date().toISOString()
      }
    },
    eventSequenceCounter: 4
  };
  const events = [
    { eventId: `EVT:${spec.taskId}:1`, eventType: "RECOVERY_DETECTED", taskId: spec.taskId, sequenceNumber: 1 },
    { eventId: `EVT:${spec.taskId}:2`, eventType: "RECOVERY_LEASED", taskId: spec.taskId, sequenceNumber: 2 },
    { eventId: settlementEventId, eventType: "RECOVERY_ESCALATED", taskId: spec.taskId, sequenceNumber: 4 }
  ];
  const history = {
    historyId: spec.historyId,
    taskId: spec.taskId,
    state: "ABANDONED",
    eventId: spec.eventId
  };
  const expected = {
    taskId: spec.taskId,
    taskStatus: "MANUAL_REQUIRED",
    manualReasonCode: "AMBIGUOUS_COMMIT",
    escalationCode: "ESC_UNKNOWN_COMMIT",
    operationId: spec.operationId,
    operationState: "ABANDONED",
    reservedEventId: spec.eventId,
    reservedSequenceNumber: 3,
    settlementEventId,
    settlementEventType: "RECOVERY_ESCALATED",
    settlementSequenceNumber: 4,
    eventSequenceCounter: 4,
    historyId: spec.historyId,
    historyState: "ABANDONED",
    totalEvents: 3,
    historyRowCount: 1,
    operatorId: "wp04-06-crash-operator",
    operatorRole: "ROLE-INVENTORY-MANAGER",
    basis: "OPERATOR_DECISION_AFTER_HOLD"
  };

  const accepted = evaluateWp04AbandonmentState({
    task,
    events,
    settlementHistory: history,
    historyRowCount: 1,
    expected
  });
  assert.equal(accepted.complete, true);
  assert.deepEqual(accepted.problems, []);
  assert.deepEqual(accepted.found, {
    task: true,
    settlementEvent: true,
    settlementHistory: true
  });

  const reservedEventWritten = evaluateWp04AbandonmentState({
    task,
    events: [
      ...events,
      { eventId: spec.eventId, eventType: "RECOVERY_RESOLVED", taskId: spec.taskId, sequenceNumber: 3 }
    ],
    settlementHistory: history,
    historyRowCount: 2,
    expected
  });
  assert.equal(
    reservedEventWritten.problems.some((problem) => /permanently reserved sequence/.test(problem)),
    true
  );
  assert.equal(
    reservedEventWritten.problems.some((problem) => /event count is 4/.test(problem)),
    true
  );
  assert.equal(
    reservedEventWritten.problems.some((problem) => /history row count is 2/.test(problem)),
    true
  );

  const wrongCounter = evaluateWp04AbandonmentState({
    task: { ...task, eventSequenceCounter: 3 },
    events,
    settlementHistory: history,
    historyRowCount: 1,
    expected
  });
  assert.equal(
    wrongCounter.problems.some((problem) => /eventSequenceCounter is 3/.test(problem)),
    true
  );

  const wrongHistoryState = evaluateWp04AbandonmentState({
    task,
    events,
    settlementHistory: { ...history, state: "COMMITTED" },
    historyRowCount: 1,
    expected
  });
  assert.equal(
    wrongHistoryState.problems.some((problem) => /abandoned terminal state/.test(problem)),
    true
  );

  const missingSettlementEvent = evaluateWp04AbandonmentState({
    task,
    events: events.filter((event) => event.eventId !== settlementEventId),
    settlementHistory: history,
    historyRowCount: 1,
    expected
  });
  assert.equal(
    missingSettlementEvent.problems.some((problem) => /settlement event row is missing/.test(problem)),
    true
  );

  const missingSettlement = evaluateWp04AbandonmentState({
    task: {
      ...task,
      pendingOperation: { ...task.pendingOperation, settlement: null }
    },
    events,
    settlementHistory: history,
    historyRowCount: 1,
    expected
  });
  assert.equal(
    missingSettlement.problems.some((problem) => /settlement is missing/.test(problem)),
    true
  );
});

test("waitForStatusRecord accepts the already-exited worker whose status file reports the expected phase", async () => {
  // Regression guard for the T8 fresh-W8 race: the child writes its final
  // status synchronously and may exit before the parent's next poll, so the
  // parent must do a final read after observing the exit instead of throwing
  // on the stale last-read phase.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bono-wp04-06-t2-status-"));
  const statusPath = path.join(scratch, "status.json");
  fs.writeFileSync(
    statusPath,
    JSON.stringify({
      role: "t8-fresh",
      phase: "w8-complete",
      result: { status: "MANUAL_REQUIRED" }
    })
  );
  try {
    const record = await waitForStatusRecord(
      statusPath,
      (candidate) => candidate.phase === "w8-complete",
      { label: "exited-worker final read", proc: { exitCode: 0 }, timeoutMs: 1_000 }
    );
    assert.equal(record.phase, "w8-complete");
    assert.equal(record.result.status, "MANUAL_REQUIRED");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("waitForStatusRecord throws when the exited worker's final status does not report the expected phase", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bono-wp04-06-t2-status-"));
  const statusPath = path.join(scratch, "status.json");
  fs.writeFileSync(
    statusPath,
    JSON.stringify({ role: "t5-fresh", phase: "setup-complete" })
  );
  try {
    await assert.rejects(
      waitForStatusRecord(
        statusPath,
        (candidate) => candidate.phase === "w7-complete",
        { label: "exited-worker mismatch", proc: { exitCode: 3 }, timeoutMs: 1_000 }
      ),
      (error) =>
        error instanceof Error &&
        /exited with code 3 before reporting the expected phase/.test(error.message) &&
        /last phase: setup-complete/.test(error.message)
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("waitForStatusRecord still fails closed on a worker-reported failure phase", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bono-wp04-06-t2-status-"));
  const statusPath = path.join(scratch, "status.json");
  fs.writeFileSync(
    statusPath,
    JSON.stringify({ role: "t8-fresh", phase: "failed", error: { message: "boom" } })
  );
  try {
    await assert.rejects(
      waitForStatusRecord(
        statusPath,
        (candidate) => candidate.phase === "w8-complete",
        { label: "worker failure", proc: null, timeoutMs: 1_000 }
      ),
      (error) =>
        error instanceof Error &&
        /crash worker reported failure: boom/.test(error.message)
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("runner source wires the crash scenarios behind the same execution gates", () => {
  const runner = readFileSync(`${TESTS_DIR}integration/wp04-06-t2-runner.mjs`, "utf8");
  const worker = readFileSync(`${SUPPORT_DIR}t2CrashWorker.mjs`, "utf8");
  const verifier = readFileSync(`${SUPPORT_DIR}t2Verifier.mjs`, "utf8");

  assert.match(runner, /runCrashRestartScenario/);
  assert.match(runner, /runCrashAbandonmentScenario/);
  assert.match(runner, /assertCrashRestartEvidence/);
  assert.match(runner, /assertCrashAbandonmentEvidence/);
  assert.match(runner, /terminateCrashVictim/);
  assert.match(runner, /WITHHOLD_COMMIT_HOLD/);
  assert.match(runner, /T8_CRASH_LEASE_MS = 2_000/);
  assert.match(runner, /T5_CRASH_LABEL = "T5-CRASH"/);
  assert.match(runner, /T8_CRASH_LABEL = "T8-CRASH"/);
  assert.match(runner, /T8_FRESH_W8_TIMEOUT_MS = 150_000/);
  const t8ScenarioStart = runner.indexOf("async function runCrashAbandonmentScenario");
  const t8ScenarioBody =
    t8ScenarioStart >= 0
      ? runner.slice(t8ScenarioStart, runner.indexOf("// Crash scenario assertions"))
      : "";
  assert.equal(t8ScenarioBody.includes("stats: proxy.getStats()"), true);
  assert.equal(t8ScenarioBody.includes("events: proxy.getEvents()"), true);
  assert.match(runner, /verifyWp04AbandonmentStateWithIndependentClient/);
  assert.match(runner, /crash_restart/);
  assert.match(runner, /RECOVERY_ESCALATED/);
  assert.match(runner, /never claimed as a POSIX signal delivery|TerminateProcess/);
  assert.equal(
    /SIGKILLs the victim while it is still inside that commit await/.test(runner),
    true
  );

  assert.match(worker, /assessOperationOutcome/);
  assert.match(worker, /abandonOperation/);
  assert.match(worker, /phase: "w8-started"/);
  assert.match(worker, /assertLoopbackProxyUri/);
  assert.match(worker, /OPERATOR_DECISION_AFTER_HOLD/);
  assert.match(worker, /await new Promise\(\(\) => \{\}\)/);
  assert.equal(/process\.env/.test(worker), false);
  assert.equal(/readFileSync\((?![^)]*specFile)/.test(worker), false);

  assert.match(verifier, /evaluateWp04AbandonmentState/);
  assert.match(verifier, /verifyWp04AbandonmentStateWithIndependentClient/);
});
