// WP04-06 — Real canonical writer-path harness for the disposable T2 proof.
//
// This module exists to close finding F2: the T2 effect transaction must be
// driven by the production writer, not by schema-shaped `insertOne()` calls.
//
// It imports and uses:
//   * `lib/recovery/taskWriter.js` — `createRecoveryTaskWriter()` (W1/W2/W6/W7)
//   * `lib/models/RecoveryTask.js` — real task and operation-history models
//   * `lib/models/RecoveryEvent.js` — real event model
//
// The Mongoose connection is created by the caller from a loopback-only URI
// routed through the commit-aware T2 proxy. Every model and the writer are
// bound to that connection, so the W7 effect transaction's commit frame is the
// frame the proxy observes.
//
// Nothing in this module opens a connection at import time or writes to a
// collection directly. The only write path is the canonical writer.
//
// The effect writer accepts an injected `startSession` opener that applies a
// bounded `timeoutMS` to `withTransaction` (2,000 ms in the T2 runner). That
// value is the overall timeout for the entire `withTransaction()` call: it
// covers execution of the transaction callback and the driver's commit and
// retry handling within that call. It does not bound only the commit-retry
// deadline. The setting is specific to this disposable T2 harness; it is not a
// production writer timeout and changes no production runtime behavior. It also
// does not change commit classification, forwarding, or acknowledgement
// dropping. Setup (W1/W2/W6) uses the unbounded transport.

import { createHash, randomUUID } from "node:crypto";

import mongoose from "mongoose";
import { ObjectId } from "mongodb";

import { createRecoveryTaskWriter } from "../../../lib/recovery/taskWriter.js";
import {
  buildEventId,
  buildFindingIdentityKey,
  buildOperationHistoryId,
  buildTaskKey
} from "../../../lib/recovery/identity.js";
import { getRecoveryEventModel } from "../../../lib/models/RecoveryEvent.js";
import {
  getRecoveryOperationHistoryModel,
  getRecoveryTaskModel
} from "../../../lib/models/RecoveryTask.js";

export const REAL_WRITER_MODULE = "lib/recovery/taskWriter.js#createRecoveryTaskWriter";
export const REAL_WRITER_ENTRY_SEQUENCE = Object.freeze([
  "createTaskFromFinding",
  "claimLease",
  "reserveOperation",
  "commitOperation"
]);
export const REAL_WRITER_SETUP_ENTRIES = Object.freeze([
  "createTaskFromFinding",
  "claimLease",
  "reserveOperation"
]);

export const REAL_WRITER_ACTOR_ID = "wp04-06-t2-harness";
export const REAL_WRITER_SCANNER_ID = "wp04-06-t2-scanner";
export const REAL_WRITER_ORDER_ID = "0123456789abcdef01234567";
export const REAL_WRITER_LEASE_MS = 60 * 60 * 1000;
export const DEFAULT_EFFECT_TIMEOUT_MS = 2_000;
const MAX_EFFECT_TIMEOUT_MS = 10_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const WORKER_ACTOR_ROLE = "SERVICE-WORKER";
const WORKER_ACTOR_TYPE = "WORKER";

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !/^wp04-06-t2-[a-f0-9]{12}$/.test(runId)) {
    throw new Error(`Real-writer scenario requires a valid T2 run ID, got '${runId}'.`);
  }
}

/**
 * Build the W1 task draft and the deterministic identities the canonical writer
 * will produce. The draft contains no writer-owned lifecycle fields: `status`,
 * lease state, counters, attempts, `pendingOperation`, and timestamps are set by
 * W1/W2/W6/W7.
 */
export function buildRealWriterScenario({
  runId,
  scenario,
  orderIdHex = REAL_WRITER_ORDER_ID,
  now = new Date(),
  leaseMs = REAL_WRITER_LEASE_MS
} = {}) {
  assertRunId(runId);
  if (typeof scenario !== "string" || scenario.length === 0) {
    throw new Error("Real-writer scenario requires a non-empty scenario label.");
  }
  if (!/^[a-f0-9]{24}$/.test(orderIdHex)) {
    throw new Error("Real-writer scenario requires a 24-hex order ObjectId.");
  }
  // T8-CRASH: only a shorter disposable harness lease is permitted; the
  // accepted default stays the production-shaped one-hour lease.
  if (!Number.isInteger(leaseMs) || leaseMs <= 0 || leaseMs > REAL_WRITER_LEASE_MS) {
    throw new Error(
      `Real-writer scenario leaseMs must be an integer in 1..${REAL_WRITER_LEASE_MS}.`
    );
  }

  const taskId = buildFindingIdentityKey("D01", `T2_${scenario}`, orderIdHex, null, null);
  const taskKey = buildTaskKey(orderIdHex);
  const operationId = `t2-op-${runId}-${scenario}`;
  const historyId = buildOperationHistoryId(taskId, operationId);
  // I-C: W1 emits at sequence 1, W2 at 2, W6 reserves 3 without an event, and
  // W7 inserts its effect event at the reserved sequence without incrementing.
  const sequenceNumber = 3;
  const eventId = buildEventId(taskId, sequenceNumber);

  const worker = {
    id: REAL_WRITER_ACTOR_ID,
    token: randomUUID(),
    leaseMs
  };

  const initialFingerprint = sha256(`initial:${runId}:${scenario}`);
  const currentFingerprint = sha256(`current:${runId}:${scenario}`);
  const intentDigest = sha256(`intent:${runId}:${scenario}`);

  const draft = {
    taskId,
    taskKey,
    findingIdentityKey: taskId,
    orderId: new ObjectId(orderIdHex),
    orderNumber: `T2-${scenario}-${runId.slice(-12)}`,
    reservationId: null,
    itemId: null,
    lineId: null,
    rule: "D01",
    code: `T2_${scenario}`,
    classification: "INFO",
    severity: "INFO",
    confidence: "HIGH",
    evidenceLevel: "E1",
    findingCodeOnly: false,
    durableClass: null,
    fingerprintSchema: "wp04-fingerprint-v1",
    evidenceSchema: "wp04-evidence-v1",
    initialFingerprint,
    currentFingerprint,
    maxAttempts: 5
  };

  return {
    runId,
    scenario,
    now,
    taskId,
    taskKey,
    findingIdentityKey: taskId,
    operationId,
    eventId,
    historyId,
    sequenceNumber,
    leaseGeneration: 1,
    eventSequenceCounter: sequenceNumber,
    worker,
    workerActor: {
      id: worker.id,
      role: WORKER_ACTOR_ROLE,
      type: WORKER_ACTOR_TYPE
    },
    scannerActor: {
      id: REAL_WRITER_SCANNER_ID,
      role: WORKER_ACTOR_ROLE,
      type: "SCANNER"
    },
    initialFingerprint,
    currentFingerprint,
    intentDigest,
    draft,
    expected: {
      effectCommitted: false,
      taskStatus: "LEASED",
      operationState: "PREPARED",
      eventType: "RECOVERY_RESOLVED",
      historyState: "COMMITTED",
      resolution: "ALREADY_CORRECT",
      sequenceNumber,
      eventSequenceCounter: sequenceNumber,
      leaseGeneration: 1,
      setupEventTypes: ["RECOVERY_DETECTED", "RECOVERY_LEASED"]
    }
  };
}

/** The P5 negative-control marker is deliberately not a WP04 effect document. */
export const NEGATIVE_CONTROL_COLLECTION = "wp04_t2_negative_control_markers";

export function buildNegativeControlMarker({ runId } = {}) {
  assertRunId(runId);
  const markerId = `t2-negative-control:${runId}`;
  return {
    markerId,
    collectionName: NEGATIVE_CONTROL_COLLECTION,
    literalText: "commitTransaction",
    comment: "negative control: commitTransaction is only payload text",
    document: {
      _id: markerId,
      runId,
      kind: "negative-control-marker",
      note: "commitTransaction is only payload text",
      createdAt: new Date()
    }
  };
}

/**
 * W1 → W2 → W6 against the real writer. These transactions complete before the
 * proxy is armed, so their commit frames are observed but never faulted.
 */
export async function runRealWriterSetup({ writer, scenario, now = new Date() } = {}) {
  if (!writer || typeof writer.createTaskFromFinding !== "function") {
    throw new Error("Real-writer setup requires the canonical writer.");
  }
  if (!scenario || !scenario.taskId) {
    throw new Error("Real-writer setup requires a built scenario.");
  }

  const created = await writer.createTaskFromFinding({
    task: scenario.draft,
    actor: scenario.scannerActor,
    now
  });
  if (created?.status !== "DETECTED" || created.taskId !== scenario.taskId) {
    throw new Error("W1 did not create the expected DETECTED task.");
  }

  const claimed = await writer.claimLease({
    taskId: scenario.taskId,
    fromStatus: "DETECTED",
    worker: scenario.worker,
    actor: scenario.workerActor,
    now
  });
  if (claimed?.status !== "LEASED" || claimed.taskId !== scenario.taskId) {
    throw new Error("W2 did not claim the expected LEASED task.");
  }

  const reservation = await writer.reserveOperation({
    taskId: scenario.taskId,
    worker: scenario.worker,
    intentDigest: scenario.intentDigest,
    operationId: scenario.operationId,
    now
  });
  if (
    reservation?.operation?.state !== "PREPARED" ||
    reservation.operationId !== scenario.operationId ||
    Number(reservation.sequenceNumber) !== scenario.sequenceNumber ||
    reservation.eventId !== scenario.eventId
  ) {
    throw new Error("W6 did not reserve the expected PREPARED operation identity.");
  }

  return { created, claimed, reservation };
}

/**
 * W7 — the only effect transaction. Called after the proxy is armed so the
 * fault lands on this commit frame rather than a setup commit.
 */
export async function runRealWriterEffect({
  writer,
  scenario,
  reservation,
  now = new Date()
} = {}) {
  if (!writer || typeof writer.commitOperation !== "function") {
    throw new Error("Real-writer effect requires the canonical writer.");
  }
  if (!reservation?.operation) {
    throw new Error("Real-writer effect requires the W6 reservation.");
  }

  return writer.commitOperation({
    taskId: scenario.taskId,
    operation: reservation.operation,
    worker: scenario.worker,
    actor: scenario.workerActor,
    fromStatus: "LEASED",
    toStatus: "RESOLVED",
    eventType: "RECOVERY_RESOLVED",
    fields: {
      resolution: "ALREADY_CORRECT",
      currentFingerprint: scenario.currentFingerprint
    },
    now
  });
}

/**
 * Bind the effect writer's sessions to a bounded overall `withTransaction`
 * timeout. The value is the timeout for the entire `withTransaction()` call: it
 * covers execution of the transaction callback and the driver's commit and
 * UnknownTransactionCommitResult retry handling within that call. It does not
 * bound only the commit-retry deadline.
 *
 * The T2 proof does not need the driver's default 120-second commit-retry
 * window to observe retries, and an unbounded loop would make the evidence file
 * enormous. This is a disposable T2 harness setting, not a production writer
 * timeout. The writer, the command frames, and the proxy decisions remain
 * canonical.
 */
export function createBoundedSessionOpener(
  connection,
  { timeoutMS = DEFAULT_EFFECT_TIMEOUT_MS } = {}
) {
  if (!connection || typeof connection.startSession !== "function") {
    throw new Error("Bounded session opener requires a Mongoose connection.");
  }
  if (!Number.isInteger(timeoutMS) || timeoutMS <= 0 || timeoutMS > MAX_EFFECT_TIMEOUT_MS) {
    throw new Error(
      `Effect transaction timeoutMS must be an integer in 1..${MAX_EFFECT_TIMEOUT_MS}.`
    );
  }

  return async function openBoundedSession() {
    const session = await connection.startSession();
    const canonicalWithTransaction = session.withTransaction.bind(session);
    session.withTransaction = (work, options = {}) =>
      canonicalWithTransaction(work, { ...(options ?? {}), timeoutMS });
    return session;
  };
}

export function assertLoopbackProxyUri(uri) {
  if (typeof uri !== "string" || uri.length === 0) {
    throw new Error("Real-writer harness requires a MongoDB URI.");
  }
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("Real-writer harness requires a parseable MongoDB URI.");
  }
  if (parsed.protocol !== "mongodb:") {
    throw new Error(`Real-writer harness URI must use mongodb://, got '${parsed.protocol}'.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Real-writer harness URI must not contain credentials.");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Real-writer harness URI host must be loopback, got '${parsed.hostname}'.`
    );
  }
  if (parsed.searchParams.get("directConnection") !== "true") {
    throw new Error("Real-writer harness URI must set directConnection=true.");
  }
  return parsed;
}

/**
 * Create a Mongoose connection through the proxy and bind the real models and
 * writer to it. Setup and effect use separate writer instances so only the
 * effect transaction carries the bounded `withTransaction` timeout.
 */
export async function createRealWriterHarness({
  proxyUri,
  dbName = null,
  trace = null,
  effectTimeoutMS = DEFAULT_EFFECT_TIMEOUT_MS
} = {}) {
  assertLoopbackProxyUri(proxyUri);

  const connection = await mongoose
    .createConnection(proxyUri, {
      directConnection: true,
      retryWrites: false,
      retryReads: false,
      serverSelectionTimeoutMS: 15_000
    })
    .asPromise();

  // The models live on the connection's database. A URI without the expected
  // database would silently write to Mongoose's `test` default and the
  // independent P4 verifier would read an empty database.
  if (dbName !== null) {
    if (typeof dbName !== "string" || dbName.length === 0) {
      throw new Error("Real-writer harness requires a non-empty dbName guard.");
    }
    const actual = connection.db?.databaseName;
    if (actual !== dbName) {
      await connection.close();
      throw new Error(
        `Real-writer harness connected to database '${actual}', expected '${dbName}'.`
      );
    }
  }

  const models = {
    task: getRecoveryTaskModel(connection),
    event: getRecoveryEventModel(connection),
    history: getRecoveryOperationHistoryModel(connection)
  };

  const setupWriter = createRecoveryTaskWriter({ connection, models, trace });
  const effectWriter = createRecoveryTaskWriter({
    connection,
    models,
    trace,
    startSession: createBoundedSessionOpener(connection, { timeoutMS: effectTimeoutMS })
  });

  return {
    connection,
    models,
    setupWriter,
    effectWriter,
    effectTimeoutMS,
    writerImplementation: REAL_WRITER_MODULE,
    async close() {
      await connection.close();
    }
  };
}

function requireTraceEntry(result, entryPoint) {
  const trace = Array.isArray(result?.writerTrace) ? result.writerTrace : [];
  return trace.filter((entry) => entry?.entryPoint === entryPoint);
}

/**
 * Guard the real-writer evidence shape. This is intentionally strict: a
 * scenario cannot be accepted unless the setup lifecycle succeeded, the proxy
 * was armed after all setup commits, every armed commit was observed, and the
 * independent P4 result is complete.
 */
export function assertRealWriterScenarioEvidence(result, expected = {}) {
  const label = result?.scenario ?? "real-writer scenario";

  if (result?.writerImplementation !== REAL_WRITER_MODULE) {
    throw new Error(`${label} did not record the canonical writer implementation.`);
  }
  if (result?.effect?.writePath !== "createRecoveryTaskWriter.commitOperation") {
    throw new Error(`${label} effect transaction did not use the canonical writer.`);
  }
  for (const entryPoint of REAL_WRITER_SETUP_ENTRIES) {
    if (requireTraceEntry(result, entryPoint).length !== 1) {
      throw new Error(`${label} did not record exactly one ${entryPoint} writer trace entry.`);
    }
  }
  if (requireTraceEntry(result, "commitOperation").length > 1) {
    throw new Error(`${label} recorded more than one commitOperation writer trace entry.`);
  }

  if (result?.setup?.created?.status !== "DETECTED") {
    throw new Error(`${label} W1 did not report a DETECTED task.`);
  }
  if (result?.setup?.claimed?.status !== "LEASED") {
    throw new Error(`${label} W2 did not report a LEASED task.`);
  }
  if (result?.setup?.reservation?.operation?.state !== "PREPARED") {
    throw new Error(`${label} W6 did not report a PREPARED reservation.`);
  }

  const stats = result?.proxy?.stats ?? {};
  const events = Array.isArray(result?.proxy?.events) ? result.proxy.events : [];
  if (stats.armed !== true) {
    throw new Error(`${label} proxy was never armed for the W7 effect commit.`);
  }
  if (!Number.isInteger(stats.unarmedCommitDetections) || stats.unarmedCommitDetections < 3) {
    throw new Error(
      `${label} did not observe the three W1/W2/W6 setup commits before arming.`
    );
  }
  if (!Number.isInteger(stats.armedCommitDetections) || stats.armedCommitDetections < 1) {
    throw new Error(`${label} did not observe the armed W7 effect commit.`);
  }

  const armedEvent = events.find((event) => event.type === "proxy-armed");
  if (!armedEvent) {
    throw new Error(`${label} is missing the proxy-armed evidence event.`);
  }
  const armedDetections = events.filter(
    (event) => event.type === "commit-detected" && event.armed === true
  );
  if (armedDetections.length !== stats.armedCommitDetections) {
    throw new Error(
      `${label} armed commit detection events do not match the armed detection count.`
    );
  }
  for (const detection of armedDetections) {
    if (!Number.isInteger(detection.seq) || detection.seq <= armedEvent.seq) {
      throw new Error(`${label} classified a pre-arm commit as an armed effect commit.`);
    }
  }

  const verification = result?.verification;
  if (!verification || verification.complete !== true) {
    throw new Error(
      `${label} independent P4 verification did not complete: ` +
        `${(verification?.problems ?? []).join("; ")}`
    );
  }
  if (verification.effectCommitted !== expected.effectCommitted) {
    throw new Error(`${label} independent P4 effect outcome is not the expected outcome.`);
  }

  if (result?.commitError === null) {
    throw new Error(`${label} expected a client-observed commit failure.`);
  }
}
