// WP04-06 — Disposable crash worker for the T5-CRASH / T8-CRASH scenarios.
//
// AUTHORED FOR THE DISPOSABLE CRASH HARNESS. Spawned only by the T2 crash
// runner; it is never executed by the authoring package and never by tests.
//
// Role of this module: a standalone Node process that binds the real canonical
// writer to its own Mongoose connection, so a SIGKILL of this process models a
// whole writer process dying — instance, sessions, and all.
//
// Roles:
//   * `t5-victim` — runs W1 → W2 → W6 (never W7), reports `setup-complete`, and
//     then stays alive doing nothing until the parent SIGKILLs it. The victim
//     therefore dies with the reservation committed and the effect unattempted.
//   * `t5-fresh` — a fresh process after the crash. It first reconciles
//     read-only through the independent verifier client (HOLD, zero writes),
//     then completes W7 through a fresh writer at the exact durable reserved
//     identity, using the same worker fencing identity the victim claimed with.
//   * `t8-victim` — runs W1 → W2 → W6 through the withhold-hold proxy, waits
//     for the parent's arm signal, then starts W7. The proxy withholds the
//     commit without severing, so this process hangs in `withTransaction` with
//     the transaction uncommitted until the parent SIGKILLs it mid-W7.
//   * `t8-fresh` — a fresh process after the mid-W7 crash. It verifies the
//     PREPARED world read-only, waits until the original lease is expired, then
//     executes the separately authorized OD-37 W8 abandonment with the exact
//     durable operation identity and explicit operator authorization.
//
// Guards:
//   * Only loopback, credential-free, directConnection URIs are accepted.
//   * No environment files are read. No collection is written directly; every
//     write goes through the canonical writer entry points.
//   * Progress is reported exclusively through the JSON status file so the
//     parent can observe the child without any pipe that a SIGKILL could
//     leave half-flushed.
//   * The status payload is converted to evidence-safe values (BigInt → Number,
//     Date → ISO string) before serialization.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ObjectId } from "mongodb";

import {
  REAL_WRITER_MODULE,
  REAL_WRITER_SETUP_ENTRIES,
  assertLoopbackProxyUri,
  createRealWriterHarness,
  runRealWriterEffect,
  runRealWriterSetup
} from "./t2RealWriter.mjs";
import {
  createIndependentVerifierClient,
  readWp04EffectStateWithClient
} from "./t2Verifier.mjs";
import { assessOperationOutcome } from "../../../lib/recovery/taskWriter.js";

export const CRASH_WORKER_MODULE =
  "tests/integration/support/t2CrashWorker.mjs";

export const CRASH_WORKER_ROLES = Object.freeze([
  "t5-victim",
  "t5-fresh",
  "t8-victim",
  "t8-fresh"
]);

export const CRASH_WORKER_SPEC_VERSION = 1;

// The T8 victim hangs inside a commit the proxy withholds. The parent kills it
// within milliseconds of observing the withheld commit; this bounded overall
// withTransaction timeout is only a backstop so a stalled parent cannot leave
// an orphaned victim retrying forever. Fresh children reuse it as a generous
// overall timeout for their single effect/abandonment transaction.
export const CRASH_EFFECT_TIMEOUT_MS = 10_000;

// Server-time lease expiry is the W8 predicate; this margin covers host clock
// jitter between the parent, the child, and the loopback mongod.
export const T8_LEASE_EXPIRY_MARGIN_MS = 2_000;
export const T8_MAX_LEASE_EXPIRY_WAIT_MS = 20_000;

const STATUS_POLL_MS = 50;

function toStatusValue(value) {
  if (typeof value === "bigint") {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toStatusValue);
  if (value && typeof value === "object") {
    if (typeof value.toHexString === "function") return value.toHexString();
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, toStatusValue(nested)])
    );
  }
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize the scenario spec for a child. `draft.orderId` is the only
 * non-JSON value; it is replaced by a tagged 24-hex string that
 * `reviveCrashScenarioSpec` restores as a real ObjectId.
 */
export function serializeCrashScenarioSpec(spec) {
  if (!spec || typeof spec !== "object" || !spec.draft || !spec.worker) {
    throw new Error("Crash worker requires a built real-writer scenario spec.");
  }
  const orderId = spec.draft.orderId;
  if (!orderId || typeof orderId.toHexString !== "function") {
    throw new Error("Crash worker spec draft.orderId must be an ObjectId.");
  }
  return JSON.stringify({
    crashWorkerSpecVersion: CRASH_WORKER_SPEC_VERSION,
    ...spec,
    now: spec.now instanceof Date ? spec.now.toISOString() : spec.now,
    draft: {
      ...spec.draft,
      orderId: { __crashWorkerObjectIdHex: orderId.toHexString() }
    }
  });
}

export function reviveCrashScenarioSpec(json) {
  const parsed = JSON.parse(json);
  if (parsed?.crashWorkerSpecVersion !== CRASH_WORKER_SPEC_VERSION) {
    throw new Error(
      `Crash worker spec version mismatch, expected ${CRASH_WORKER_SPEC_VERSION}.`
    );
  }
  if (!parsed.draft || !parsed.worker || typeof parsed.taskId !== "string") {
    throw new Error("Crash worker spec is missing the scenario identity.");
  }
  const hex = parsed.draft.orderId?.__crashWorkerObjectIdHex;
  if (typeof hex !== "string" || !/^[a-f0-9]{24}$/.test(hex)) {
    throw new Error("Crash worker spec draft.orderId is not a tagged 24-hex ObjectId.");
  }
  parsed.now = new Date(parsed.now);
  if (Number.isNaN(parsed.now.getTime())) {
    throw new Error("Crash worker spec `now` is not a valid date.");
  }
  parsed.draft.orderId = new ObjectId(hex);
  return parsed;
}

export function parseCrashWorkerArgs(argv) {
  const args = {
    role: null,
    specFile: null,
    statusFile: null,
    controlFile: null,
    uri: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--role":
        args.role = value;
        index += 1;
        break;
      case "--spec-file":
        args.specFile = value;
        index += 1;
        break;
      case "--status-file":
        args.statusFile = value;
        index += 1;
        break;
      case "--control-file":
        args.controlFile = value;
        index += 1;
        break;
      case "--uri":
        args.uri = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown crash worker argument '${flag}'.`);
    }
  }

  if (!CRASH_WORKER_ROLES.includes(args.role)) {
    throw new Error(
      `Crash worker --role must be one of ${CRASH_WORKER_ROLES.join(", ")}.`
    );
  }
  for (const field of ["specFile", "statusFile"]) {
    if (typeof args[field] !== "string" || !path.isAbsolute(args[field])) {
      throw new Error(`Crash worker --${field.replace(/File$/, "-file")} must be an absolute path.`);
    }
  }
  if (args.role === "t8-victim") {
    if (typeof args.controlFile !== "string" || !path.isAbsolute(args.controlFile)) {
      throw new Error("Crash worker t8-victim requires an absolute --control-file path.");
    }
  } else if (args.controlFile !== null) {
    throw new Error(`Crash worker role '${args.role}' must not receive a control file.`);
  }

  args.uri = assertLoopbackProxyUri(args.uri ?? "").href;

  const dbName = decodeURIComponent(new URL(args.uri).pathname.replace(/^\//, ""));
  if (!dbName) {
    throw new Error("Crash worker URI must include the disposable database name.");
  }
  args.dbName = dbName;

  if (!fs.existsSync(args.specFile)) {
    throw new Error(`Crash worker spec file does not exist: ${args.specFile}`);
  }

  return args;
}

function writeStatus(statusPath, record) {
  fs.writeFileSync(statusPath, `${JSON.stringify(toStatusValue(record))}\n`);
}

function statusError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code ?? null
  };
}

async function readTaskWithVerifierClient({ uri, dbName, taskId, eventId, historyId }) {
  if (!dbName) {
    throw new Error("Crash worker verifier read requires the disposable database name.");
  }
  const client = createIndependentVerifierClient(uri);
  try {
    await client.connect();
    return await readWp04EffectStateWithClient(client, {
      dbName,
      taskId,
      eventId,
      historyId
    });
  } finally {
    await client.close();
  }
}

/**
 * Read-only reconciliation of the post-crash durable world. This touches only
 * the independent verifier client (primary/majority reads); it performs no
 * write through any path, so "zero writes" holds by construction.
 */
function evaluateDurableHoldWorld({ read, spec }) {
  const task = read.task;
  if (!task) {
    throw new Error("Crash reconciliation found no task row.");
  }
  const operation = task.pendingOperation;
  if (!operation || typeof operation !== "object") {
    throw new Error("Crash reconciliation found no pendingOperation.");
  }
  const assessment = assessOperationOutcome({ pendingOperation: operation });
  const identity = {
    taskId: task.taskId,
    status: task.status,
    operationId: operation.operationId,
    operationState: operation.state,
    sequenceNumber: operation.sequenceNumber,
    eventId: operation.eventId,
    leaseGeneration: operation.leaseGeneration,
    eventSequenceCounter: task.eventSequenceCounter,
    leaseUntil: task.leaseUntil ?? null
  };
  const matchesSpec =
    task.taskId === spec.taskId &&
    task.status === "LEASED" &&
    operation.operationId === spec.operationId &&
    operation.state === "PREPARED" &&
    Number(operation.sequenceNumber) === spec.sequenceNumber &&
    operation.eventId === spec.eventId &&
    Number(operation.leaseGeneration) === spec.leaseGeneration &&
    Number(task.eventSequenceCounter) === spec.eventSequenceCounter;
  const partialEffect = {
    effectEventPresent: read.effectEvent !== null && read.effectEvent !== undefined,
    effectHistoryPresent: read.effectHistory !== null && read.effectHistory !== undefined
  };
  const setupEventTypes = read.events
    .filter((event) => event.eventId !== spec.eventId)
    .map((event) => event.eventType);

  return { assessment, identity, matchesSpec, partialEffect, setupEventTypes };
}

function assertDurableHoldWorld({ world, spec, label }) {
  if (world.assessment.state !== "UNRESOLVED" || world.assessment.action !== "HOLD") {
    throw new Error(
      `${label}: the durable world is not an unresolved HOLD: ` +
        `${world.assessment.state}/${world.assessment.action}`
    );
  }
  if (!world.matchesSpec) {
    throw new Error(
      `${label}: the durable operation identity does not match the reserved identity: ` +
        `${JSON.stringify(world.identity)}`
    );
  }
  if (world.partialEffect.effectEventPresent || world.partialEffect.effectHistoryPresent) {
    throw new Error(
      `${label}: a partial effect row is present after the crash: ` +
        `${JSON.stringify(world.partialEffect)}`
    );
  }
  if (world.setupEventTypes.join(",") !== spec.expected.setupEventTypes.join(",")) {
    throw new Error(
      `${label}: setup event types are not the expected setup lifecycle: ` +
        `${world.setupEventTypes.join(",")}`
    );
  }
}

function assertVictimTraceIsSetupOnly(writerTrace) {
  const entries = Array.isArray(writerTrace) ? writerTrace : [];
  const entryPoints = entries.map((entry) => entry?.entryPoint);
  for (const entryPoint of REAL_WRITER_SETUP_ENTRIES) {
    if (entryPoints.filter((candidate) => candidate === entryPoint).length !== 1) {
      throw new Error(
        `Victim writer trace is missing exactly one ${entryPoint} entry: ${entryPoints.join(", ")}`
      );
    }
  }
  if (entryPoints.includes("commitOperation")) {
    // This is the harness guarantee that keeps T5-CRASH inside the approved
    // rules: the dead victim never attempted the effect, so the fresh child's
    // W7 is the first effect attempt at this identity.
    throw new Error("Victim writer trace contains a commitOperation entry.");
  }
}

async function runSetupAndReport({ args, spec, uri, effectTimeoutMS = undefined }) {
  const writerTrace = [];
  const harnessOptions = {
    proxyUri: uri,
    dbName: args.dbName,
    trace: (entry) => writerTrace.push(toStatusValue(entry))
  };
  if (effectTimeoutMS !== undefined) harnessOptions.effectTimeoutMS = effectTimeoutMS;
  const harness = await createRealWriterHarness(harnessOptions);

  try {
    const setup = await runRealWriterSetup({ writer: harness.setupWriter, scenario: spec });
    assertVictimTraceIsSetupOnly(writerTrace);
    writeStatus(args.statusFile, {
      role: args.role,
      pid: process.pid,
      phase: "setup-complete",
      writerModule: REAL_WRITER_MODULE,
      writerTrace,
      reservation: setup.reservation,
      taskId: spec.taskId,
      operationId: spec.operationId,
      eventId: spec.eventId,
      historyId: spec.historyId
    });
    return { harness, setup, writerTrace };
  } catch (error) {
    try {
      await harness.close();
    } catch {}
    throw error;
  }
}

async function waitForControlFile(controlPath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(controlPath)) return;
    await delay(STATUS_POLL_MS);
  }
  throw new Error("The parent arm signal did not arrive in time.");
}

async function runT5Victim(args, spec) {
  await runSetupAndReport({ args, spec, uri: args.uri });
  // Stay alive until the parent SIGKILLs this process. Nothing further runs.
  await new Promise(() => {});
}

async function runT8Victim(args, spec) {
  const { harness, setup, writerTrace } = await runSetupAndReport({
    args,
    spec,
    uri: args.uri,
    effectTimeoutMS: CRASH_EFFECT_TIMEOUT_MS
  });

  try {
    // The parent arms the withhold-hold proxy after observing `setup-complete`
    // and then writes the control file; only then does W7 start, so the fault
    // can only land on the W7 commit frame.
    await waitForControlFile(args.controlFile, 60_000);
    writeStatus(args.statusFile, {
      role: args.role,
      pid: process.pid,
      phase: "w7-started",
      writerTrace
    });

    try {
      const effect = await runRealWriterEffect({
        writer: harness.effectWriter,
        scenario: spec,
        reservation: setup.reservation
      });
      // Unreachable in a passing T8 run: the parent must SIGKILL this process
      // while the commit is withheld. Recording it keeps any accidental commit
      // observable instead of silently swallowed.
      writeStatus(args.statusFile, {
        role: args.role,
        pid: process.pid,
        phase: "unexpected-w7-commit-acknowledged",
        result: effect
      });
    } catch (error) {
      writeStatus(args.statusFile, {
        role: args.role,
        pid: process.pid,
        phase: "w7-client-error",
        error: statusError(error)
      });
    }
    // Regardless of the client-side outcome, the parent decides when this
    // process dies. Hang until SIGKILL.
    await new Promise(() => {});
  } catch (error) {
    writeStatus(args.statusFile, {
      role: args.role,
      pid: process.pid,
      phase: "failed",
      error: statusError(error)
    });
    try {
      await harness.close();
    } catch {}
    return 1;
  }
}

async function runFreshReconciliation({ args, spec, uri, label }) {
  const read = await readTaskWithVerifierClient({
    uri,
    dbName: args.dbName,
    taskId: spec.taskId,
    eventId: spec.eventId,
    historyId: spec.historyId
  });
  const world = evaluateDurableHoldWorld({ read, spec });
  assertDurableHoldWorld({ world, spec, label });
  writeStatus(args.statusFile, {
    role: args.role,
    pid: process.pid,
    phase: "reconciled-hold",
    assessment: world.assessment,
    identity: world.identity,
    matchesSpec: world.matchesSpec,
    partialEffect: world.partialEffect,
    setupEventTypes: world.setupEventTypes,
    writesPerformed: 0
  });
  return world;
}

async function runT5Fresh(args, spec) {
  // Phase 1: read-only reconciliation in the fresh process. HOLD, zero writes.
  const world = await runFreshReconciliation({
    args,
    spec,
    uri: args.uri,
    label: "T5-CRASH fresh reconciliation"
  });

  // Phase 2: complete W7 with a fresh writer at the exact durable reserved
  // identity. No abortEvidence is supplied: the victim's trace (asserted before
  // the kill) proves this is the first effect attempt at this identity, which
  // is the already-approved W7 rule set. The worker identity is the same
  // fencing identity the victim claimed the lease with.
  if (world.assessment.state !== "UNRESOLVED") {
    throw new Error("T5-CRASH fresh writer expected an unresolved durable world.");
  }

  const writerTrace = [];
  const harness = await createRealWriterHarness({
    proxyUri: args.uri,
    dbName: args.dbName,
    trace: (entry) => writerTrace.push(toStatusValue(entry)),
    effectTimeoutMS: CRASH_EFFECT_TIMEOUT_MS
  });

  try {
    const durableTask = await harness.models.task
      .findOne({ taskId: spec.taskId }, null, { lean: true });
    if (!durableTask) throw new Error("T5-CRASH fresh writer found no durable task row.");
    const durableOperation = durableTask.pendingOperation;
    if (!durableOperation) {
      throw new Error("T5-CRASH fresh writer found no durable pendingOperation.");
    }
    if (
      durableOperation.operationId !== spec.operationId ||
      durableOperation.state !== "PREPARED" ||
      Number(durableOperation.sequenceNumber) !== spec.sequenceNumber ||
      durableOperation.eventId !== spec.eventId
    ) {
      throw new Error(
        "T5-CRASH fresh writer durable identity does not match the reserved identity."
      );
    }

    const result = await runRealWriterEffect({
      writer: harness.effectWriter,
      scenario: spec,
      reservation: { operation: durableOperation }
    });

    writeStatus(args.statusFile, {
      role: args.role,
      pid: process.pid,
      phase: "w7-complete",
      writerModule: REAL_WRITER_MODULE,
      writerTrace,
      result
    });
    await harness.close();
    return 0;
  } catch (error) {
    writeStatus(args.statusFile, {
      role: args.role,
      pid: process.pid,
      phase: "failed",
      error: statusError(error)
    });
    try {
      await harness.close();
    } catch {}
    return 1;
  }
}

async function runT8Fresh(args, spec) {
  // Phase 1: read-only verification of the PREPARED crash world.
  const world = await runFreshReconciliation({
    args,
    spec,
    uri: args.uri,
    label: "T8-CRASH fresh reconciliation"
  });

  // Phase 2: wait until the original lease is expired by host time. The W8
  // predicate itself is server-time (`$$NOW`); this wait only avoids spending
  // the attempt on a CAS that cannot match yet.
  const leaseUntilMs = new Date(world.identity.leaseUntil ?? Date.now()).getTime();
  const waitMs = leaseUntilMs + T8_LEASE_EXPIRY_MARGIN_MS - Date.now();
  if (waitMs > T8_MAX_LEASE_EXPIRY_WAIT_MS) {
    throw new Error(`T8-CRASH lease expiry wait is unreasonably long: ${waitMs}ms.`);
  }
  if (waitMs > 0) await delay(waitMs);
  writeStatus(args.statusFile, {
    role: args.role,
    pid: process.pid,
    phase: "lease-expired-wait-complete",
    leaseUntil: world.identity.leaseUntil ?? null,
    waitedMs: Math.max(0, waitMs)
  });

  // Phase 3: the separately authorized OD-37 W8 abandonment with the exact
  // durable operation identity and an explicit operator authorization naming
  // that identity.
  const writerTrace = [];
  const harness = await createRealWriterHarness({
    proxyUri: args.uri,
    dbName: args.dbName,
    trace: (entry) => writerTrace.push(toStatusValue(entry))
  });

  try {
    const durableTask = await harness.models.task
      .findOne({ taskId: spec.taskId }, null, { lean: true });
    if (!durableTask) throw new Error("T8-CRASH fresh writer found no durable task row.");
    const durableOperation = durableTask.pendingOperation;
    if (!durableOperation) {
      throw new Error("T8-CRASH fresh writer found no durable pendingOperation.");
    }
    if (
      durableOperation.operationId !== spec.operationId ||
      durableOperation.state !== "PREPARED" ||
      Number(durableOperation.sequenceNumber) !== spec.sequenceNumber ||
      durableOperation.eventId !== spec.eventId
    ) {
      throw new Error(
        "T8-CRASH fresh writer durable identity does not match the reserved identity."
      );
    }
    if (durableTask.leaseUntil === undefined || durableTask.leaseUntil === null) {
      throw new Error("T8-CRASH durable task has no original lease expiry.");
    }
    const leaseUntil = new Date(durableTask.leaseUntil);
    if (leaseUntil.getTime() > Date.now()) {
      throw new Error("T8-CRASH original lease is not expired by host time yet.");
    }

    const authorization = {
      id: `crash-abandon:${spec.runId}:${spec.scenario}`,
      operationId: spec.operationId,
      operatorId: "wp04-06-crash-operator",
      operatorRole: "ROLE-INVENTORY-MANAGER",
      basis: "OPERATOR_DECISION_AFTER_HOLD"
    };
    const actor = {
      id: authorization.operatorId,
      role: authorization.operatorRole,
      type: "OPERATOR"
    };

    // Diagnostic status emitted before the abandonment attempt: if W8 hangs in
    // the driver's transient-retry loop (e.g. waiting for mongod's
    // transactionLifetimeLimitSeconds reaper to release the victim's locks),
    // the parent sees this record and knows the child reached abandonOperation
    // rather than stalling earlier.
    writeStatus(args.statusFile, {
      role: args.role,
      pid: process.pid,
      phase: "w8-started",
      authorization,
      leaseUntil: leaseUntil.toISOString(),
      operationId: durableOperation.operationId
    });

    const result = await harness.setupWriter.abandonOperation({
      taskId: spec.taskId,
      operation: durableOperation,
      authorization,
      actor,
      diagnosticCode: null
    });

    writeStatus(args.statusFile, {
      role: args.role,
      pid: process.pid,
      phase: "w8-complete",
      writerModule: REAL_WRITER_MODULE,
      writerTrace,
      authorization,
      leaseUntil: leaseUntil.toISOString(),
      result
    });
    await harness.close();
    return 0;
  } catch (error) {
    writeStatus(args.statusFile, {
      role: args.role,
      pid: process.pid,
      phase: "failed",
      error: statusError(error)
    });
    try {
      await harness.close();
    } catch {}
    return 1;
  }
}

export async function runCrashWorker(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCrashWorkerArgs(argv);
  } catch (error) {
    process.stderr.write(`WP04-06 crash worker refused to start: ${error.message}\n`);
    return 1;
  }

  const spec = reviveCrashScenarioSpec(fs.readFileSync(args.specFile, "utf8"));
  writeStatus(args.statusFile, {
    role: args.role,
    pid: process.pid,
    phase: "started",
    startedAt: new Date().toISOString()
  });

  try {
    switch (args.role) {
      case "t5-victim":
        await runT5Victim(args, spec);
        return 0;
      case "t8-victim":
        await runT8Victim(args, spec);
        return 0;
      case "t5-fresh":
        return await runT5Fresh(args, spec);
      case "t8-fresh":
        return await runT8Fresh(args, spec);
      default:
        throw new Error(`Unhandled crash worker role '${args.role}'.`);
    }
  } catch (error) {
    writeStatus(args.statusFile, {
      role: args.role,
      pid: process.pid,
      phase: "failed",
      error: statusError(error)
    });
    return 1;
  }
}

export function isCrashWorkerDirectExecution(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isCrashWorkerDirectExecution(import.meta.url)) {
  runCrashWorker()
    .then((code) => {
      if (typeof code === "number") process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`WP04-06 crash worker failed closed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
