// WP04-06 Packages 2-3 — DB-free writer-boundary, CAS, sequence, H1, approval
// separation-of-duties and reconciliation tests.
//
// No MongoDB connection is opened. No environment file is read. No collection,
// index, migration, worker, scheduler, or route is created. The in-memory fake
// below exists only to exercise transaction/CAS/sequence semantics; it is a
// test harness, is not imported by production code, and is not a T2 proof.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ABANDONABLE_STATUSES,
  OPERATION_SETTLEMENT_BASES,
  TERMINAL_OP_STATES,
} from "../lib/models/RecoveryTask.js";
import {
  DEFINITIVE_ABORT_EVIDENCE,
  DEFERRED_ENTRY_POINTS,
  LIFECYCLE_TRANSITIONS,
  NON_PROOF_OUTCOMES,
  WRITER_ALLOWLIST,
  WRITER_ENTRY_POINTS,
  WRITER_ERROR_CODES,
  RecoveryWriterError,
  assessOperationOutcome,
  assessReplayEligibility,
  buildClaimUnresolvedPredicate,
  buildExpiredOriginalLeasePredicate,
  buildPendingOperationPredicate,
  buildSequencePredicate,
  buildUnresolvedOperationPredicate,
  createRecoveryTaskWriter,
  getLifecycleTransition,
  isAllowlistedEntryPoint,
  nextSequenceNumber,
} from "../lib/recovery/taskWriter.js";
import {
  EVIDENCE_LINKAGE_STATES,
  HISTORY_IMMUTABLE_FIELDS,
  HISTORY_RECONCILIATION_CLASSIFICATIONS,
  ORPHAN_EVIDENCE_STATUS,
  assessEvidenceLinkage,
  assessOperationState,
  classifyHistoryDuplicate,
  compareHistoryRecords,
  evaluateReplayEligibility,
  reconcileDuplicateHistory,
} from "../lib/recovery/operationReconciliation.js";
import { buildOperationHistoryId } from "../lib/recovery/identity.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (path) => readFileSync(join(root, path), "utf8");

const TASK_ID = "REC:v1:031a19a9fa67cd650906b2f27b1c2727";
const OTHER_TASK_ID = "REC:v1:031a19a9fa67cd650906b2f27b1c2728";
const ORDER_ID = "64b000000000000000000001";
const FINGERPRINT = "a".repeat(64);
const NOW = new Date("2026-11-12T03:30:00.000Z");
const EXPIRED = new Date(NOW.getTime() - 60_000);
const LIVE = new Date(NOW.getTime() + 60_000);
const WORKER = Object.freeze({
  id: "worker-1",
  token: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  leaseMs: 300_000,
});

// -----------------------------------------------------------------------------
// In-memory Mongo-ish harness (test-only; not production code)
// -----------------------------------------------------------------------------

function clone(value) {
  return structuredClone(value);
}

function getPath(document, path) {
  let current = document;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function setPath(document, path, value) {
  const parts = path.split(".");
  let current = document;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (current[part] === null || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function unsetPath(document, path) {
  const parts = path.split(".");
  let current = document;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (current[part] === null || typeof current[part] !== "object") return;
    current = current[part];
  }
  delete current[parts[parts.length - 1]];
}

function numeric(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return null;
}

function equals(left, right) {
  if (left === undefined && right === undefined) return true;
  if (left === null && right === null) return true;
  if (left === null || right === null || left === undefined || right === undefined) {
    return false;
  }
  const leftNumber = numeric(left);
  const rightNumber = numeric(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber === rightNumber;
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return left === right;
}

function compareValues(left, right) {
  const leftNumber = numeric(left);
  const rightNumber = numeric(right);
  if (leftNumber !== null && rightNumber !== null) {
    if (leftNumber === rightNumber) return 0;
    return leftNumber < rightNumber ? -1 : 1;
  }
  if (left instanceof Date && right instanceof Date) {
    if (left.getTime() === right.getTime()) return 0;
    return left.getTime() < right.getTime() ? -1 : 1;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function resolveOperand(operand, document, now) {
  if (typeof operand === "string" && operand === "$$NOW") return now;
  if (typeof operand === "string" && operand.startsWith("$")) {
    return getPath(document, operand.slice(1));
  }
  return operand;
}

function evaluateExpression(document, expression, now) {
  const operators = Object.keys(expression);
  assert.equal(operators.length, 1, "fake supports one $expr operator at a time");
  const operator = operators[0];
  const [leftOperand, rightOperand] = expression[operator];
  const left = resolveOperand(leftOperand, document, now);
  const right = resolveOperand(rightOperand, document, now);
  if (operator === "$gt") return compareValues(left, right) > 0;
  if (operator === "$gte") return compareValues(left, right) >= 0;
  if (operator === "$lt") return compareValues(left, right) < 0;
  if (operator === "$lte") return compareValues(left, right) <= 0;
  if (operator === "$eq") return equals(left, right);
  throw new Error(`fake does not support $expr operator ${operator}`);
}

function matchCondition(value, condition, now) {
  if (condition instanceof RegExp) {
    return typeof value === "string" && condition.test(value);
  }
  if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
    const operators = Object.keys(condition).filter((key) => key.startsWith("$"));
    if (operators.length > 0) {
      return operators.every((operator) => {
        const operand = condition[operator];
        if (operator === "$in") return operand.some((candidate) => equals(value, candidate));
        if (operator === "$nin") return !operand.some((candidate) => equals(value, candidate));
        if (operator === "$ne") return !equals(value, operand);
        if (operator === "$exists") return operand === (value !== undefined);
        if (operator === "$lt") return compareValues(value, operand) < 0;
        if (operator === "$lte") return compareValues(value, operand) <= 0;
        if (operator === "$gt") return compareValues(value, operand) > 0;
        if (operator === "$gte") return compareValues(value, operand) >= 0;
        throw new Error(`fake does not support operator ${operator}`);
      });
    }
  }
  if (condition === null) return value === null || value === undefined;
  return equals(value, condition);
}

function matches(document, filter, now) {
  if (!filter) return true;
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$and") return condition.every((entry) => matches(document, entry, now));
    if (key === "$or") return condition.some((entry) => matches(document, entry, now));
    if (key === "$expr") return evaluateExpression(document, condition, now);
    return matchCondition(getPath(document, key), condition, now);
  });
}

function applyUpdate(document, update) {
  if (update.$set) {
    for (const [path, value] of Object.entries(update.$set)) setPath(document, path, value);
  }
  if (update.$unset) {
    for (const path of Object.keys(update.$unset)) unsetPath(document, path);
  }
  if (update.$inc) {
    for (const [path, value] of Object.entries(update.$inc)) {
      const current = getPath(document, path) ?? 0;
      const next =
        typeof current === "bigint" || typeof value === "bigint"
          ? BigInt(current) + BigInt(value)
          : Number(current) + Number(value);
      setPath(document, path, next);
    }
  }
}

class FakeCollection {
  constructor(name, { uniqueKeys = [] } = {}) {
    this.name = name;
    this.uniqueKeys = uniqueKeys;
    this.documents = [];
    this.calls = [];
    this.now = NOW;
    this.failInsertWith = null;
    this.forceMatchedCount = null;
  }

  snapshot() {
    return clone(this.documents);
  }

  restore(documents) {
    this.documents = clone(documents);
  }

  assertUnique(document) {
    const keyPart = (value) => {
      if (value === undefined) return "undefined";
      if (typeof value === "bigint") return `bigint:${value.toString()}`;
      if (value instanceof Date) return `date:${value.getTime()}`;
      return JSON.stringify(value);
    };

    for (const spec of this.uniqueKeys) {
      if (spec.partial && !spec.partial(document)) continue;
      const key = spec.fields.map((field) => keyPart(getPath(document, field))).join("|");
      for (const existing of this.documents) {
        if (spec.partial && !spec.partial(existing)) continue;
        const existingKey = spec.fields
          .map((field) => keyPart(getPath(existing, field)))
          .join("|");
        if (existingKey === key) {
          const error = new Error(`E11000 duplicate key on ${this.name}`);
          error.code = 11000;
          throw error;
        }
      }
    }
  }

  async insertMany(documents, options = {}) {
    this.calls.push({ operation: "insertMany", documents: clone(documents), options });
    if (this.failInsertWith) throw this.failInsertWith;
    const staged = [];
    for (const document of documents) {
      this.assertUnique(document);
      staged.push(document);
      // Reserve so a duplicate inside the same batch is detected.
      this.documents.push(clone(document));
    }
    return staged;
  }

  // Mongoose 9 signature: findOne(filter, projection, options). The canonical
  // writer must pass `null` projection so the session/readConcern land in the
  // options slot; passing options as the second argument would serialize a
  // ClientSession into the projection.
  async findOne(filter, projection = null, options = {}) {
    this.calls.push({ operation: "findOne", filter, projection, options });
    const found = this.documents.find((document) => matches(document, filter, this.now));
    return found ? clone(found) : null;
  }

  async updateOne(filter, update, options = {}) {
    this.calls.push({ operation: "updateOne", filter, update: clone(update), options });
    if (this.forceMatchedCount !== null) {
      return { acknowledged: true, matchedCount: this.forceMatchedCount, modifiedCount: 0 };
    }
    const index = this.documents.findIndex((document) => matches(document, filter, this.now));
    if (index === -1) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }
    applyUpdate(this.documents[index], clone(update));
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }

  writeCalls() {
    return this.calls.filter((call) =>
      ["insertMany", "insertOne", "updateOne", "updateMany", "deleteOne", "deleteMany"].includes(
        call.operation,
      ),
    );
  }
}

class FakeSession {
  constructor(collections) {
    this.collections = collections;
    this.ended = false;
    this.committed = false;
    this.aborted = false;
    this.transactions = 0;
    this.id = `session-${Math.random().toString(16).slice(2)}`;
  }

  async withTransaction(work) {
    this.transactions += 1;
    const snapshots = new Map();
    for (const collection of this.collections) snapshots.set(collection, collection.snapshot());
    try {
      const result = await work();
      this.committed = true;
      return result;
    } catch (error) {
      for (const [collection, snapshot] of snapshots) collection.restore(snapshot);
      this.aborted = true;
      throw error;
    }
  }

  async endSession() {
    this.ended = true;
  }
}

function createFakeDatabase() {
  const tasks = new FakeCollection("inventory_recovery_tasks", {
    uniqueKeys: [
      { fields: ["taskId"] },
      { fields: ["findingIdentityKey"], partial: (document) => document.isOpen === true },
    ],
  });
  const events = new FakeCollection("inventory_recovery_events", {
    uniqueKeys: [
      { fields: ["eventId"] },
      { fields: ["taskId", "sequenceNumber"] },
    ],
  });
  const history = new FakeCollection("inventory_recovery_operation_history", {
    uniqueKeys: [
      { fields: ["historyId"] },
      { fields: ["taskId", "operationId"] },
    ],
  });
  const collections = [tasks, events, history];
  const sessions = [];

  return {
    tasks,
    events,
    history,
    sessions,
    models: { task: tasks, event: events, history },
    startSession: async () => {
      const session = new FakeSession(collections);
      sessions.push(session);
      return session;
    },
  };
}

function baseTask(overrides = {}) {
  return {
    taskId: TASK_ID,
    taskKey: `GRP:${ORDER_ID}`,
    findingIdentityKey: TASK_ID,
    orderId: ORDER_ID,
    rule: "D01",
    code: "STOCK_NEGATIVE",
    classification: "ALERT",
    severity: "HIGH",
    confidence: "HIGH",
    evidenceLevel: "E2",
    initialFingerprint: FINGERPRINT,
    currentFingerprint: FINGERPRINT,
    status: "DETECTED",
    isOpen: true,
    leaseOwner: null,
    leaseToken: null,
    leaseUntil: null,
    leaseGeneration: 0n,
    eventSequenceCounter: 1n,
    attempts: 0,
    maxAttempts: 5,
    pendingOperation: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function creationDraft(overrides = {}) {
  return {
    taskId: TASK_ID,
    taskKey: `GRP:${ORDER_ID}`,
    findingIdentityKey: TASK_ID,
    orderId: ORDER_ID,
    orderNumber: `ORD-${ORDER_ID}`,
    reservationId: null,
    itemId: null,
    lineId: null,
    rule: "D01",
    code: "STOCK_NEGATIVE",
    classification: "ALERT",
    severity: "HIGH",
    confidence: "HIGH",
    evidenceLevel: "E2",
    findingCodeOnly: false,
    durableClass: null,
    fingerprintSchema: "wp04-fingerprint-v1",
    evidenceSchema: "wp04-evidence-v1",
    initialFingerprint: FINGERPRINT,
    currentFingerprint: FINGERPRINT,
    maxAttempts: 5,
    ...overrides,
  };
}

function leasedTask(overrides = {}) {
  return baseTask({
    status: "LEASED",
    leaseOwner: WORKER.id,
    leaseToken: WORKER.token,
    leaseUntil: LIVE,
    leaseGeneration: 1n,
    attempts: 1,
    eventSequenceCounter: 2n,
    ...overrides,
  });
}

function reservedOperation(overrides = {}) {
  return {
    operationId: "op-1",
    state: "PREPARED",
    leaseGeneration: 1n,
    sequenceNumber: 3n,
    eventId: `EVT:${TASK_ID}:3`,
    reservedAt: NOW,
    reservedBy: WORKER.id,
    intentDigest: "b".repeat(64),
    settledAt: null,
    settlement: null,
    ...overrides,
  };
}

function createWriter(database, options = {}) {
  return createRecoveryTaskWriter({
    models: database.models,
    startSession: database.startSession,
    clock: () => NOW,
    newOperationId: () => "op-1",
    ...options,
  });
}

async function expectWriterError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof RecoveryWriterError, `expected writer error, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function allWrites(database) {
  return [...database.tasks.writeCalls(), ...database.events.writeCalls(), ...database.history.writeCalls()];
}

function sessionIds(database) {
  return new Set(allWrites(database).map((call) => call.options.session?.id ?? null));
}

// -----------------------------------------------------------------------------
// A. Allowlist and source boundary (OD-34)
// -----------------------------------------------------------------------------

test("writer boundary: W1-W14 allowlist is exact and the writer surface matches it", () => {
  assert.equal(WRITER_ENTRY_POINTS.length, 14);
  assert.deepEqual(
    WRITER_ENTRY_POINTS.map((entry) => entry.id),
    ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10", "W11", "W12", "W13", "W14"],
  );
  assert.deepEqual(WRITER_ALLOWLIST, [
    "createTaskFromFinding",
    "claimLease",
    "renewLease",
    "releaseLease",
    "applyTransition",
    "reserveOperation",
    "commitOperation",
    "abandonOperation",
    "resolveTask",
    "closeTask",
    "cancelTask",
    "recordApproval",
    "recordRejection",
    "escalateTask",
    "archiveClosedTasks",
    "repairTask",
  ]);

  const database = createFakeDatabase();
  const writer = createWriter(database);
  assert.deepEqual(Object.keys(writer).sort(), [...WRITER_ALLOWLIST].sort());

  assert.equal(isAllowlistedEntryPoint("claimLease"), true);
  assert.equal(isAllowlistedEntryPoint("dropDatabase"), false);
  assert.equal(isAllowlistedEntryPoint("__proto__"), false);

  // Declared-but-deferred entry points refuse to run.
  assert.deepEqual(Object.keys(DEFERRED_ENTRY_POINTS).sort(), ["archiveClosedTasks", "repairTask"]);
});

test("writer boundary: deferred and unspecified entry points fail closed", async () => {
  const database = createFakeDatabase();
  const writer = createWriter(database);

  await expectWriterError(writer.archiveClosedTasks({ taskId: TASK_ID }), "ENTRY_POINT_NOT_IMPLEMENTED");
  await expectWriterError(writer.repairTask({ taskId: TASK_ID }), "ENTRY_POINT_NOT_IMPLEMENTED");
  // W4 has no approved target status; refusing is safer than inventing one.
  await expectWriterError(writer.releaseLease({ taskId: TASK_ID }), "ENTRY_POINT_NOT_IMPLEMENTED");

  assert.equal(allWrites(database).length, 0);
});

test("writer boundary: no recovery write exists outside the canonical writer", () => {
  const scanRoots = ["lib", "app", "scripts"];
  const files = [];

  function walk(directory) {
    for (const entry of readdirSync(join(root, directory))) {
      if (entry === "node_modules" || entry === ".next") continue;
      const path = join(directory, entry);
      const stats = statSync(join(root, path));
      if (stats.isDirectory()) walk(path);
      else if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(entry)) files.push(path);
    }
  }
  for (const scanRoot of scanRoots) walk(scanRoot);

  const writerPath = "lib/recovery/taskWriter.js";
  const modelPaths = new Set([
    "lib/models/RecoveryTask.js",
    "lib/models/RecoveryEvent.js",
  ]);
  const recoveryMention =
    /inventory_recovery_(tasks|events|operation_history)|RecoveryTask|RecoveryEvent|RecoveryOperationHistory/;
  const writeCall =
    /\.(insertOne|insertMany|updateOne|updateMany|findOneAndUpdate|replaceOne|bulkWrite|deleteOne|deleteMany|createIndex|syncIndexes)\s*\(/;
  const modelCreateCall = /(RecoveryTask|RecoveryEvent|taskModel|eventModel)\.create\s*\(/;

  for (const path of files) {
    const normalized = path.split("\\").join("/");
    const source = readSource(path);
    if (!recoveryMention.test(source)) continue;
    if (normalized === writerPath || modelPaths.has(normalized)) continue;
    assert.equal(
      writeCall.test(source) || modelCreateCall.test(source),
      false,
      `${normalized} contains a recovery write call outside ${writerPath}`,
    );
  }

  // Positive control: the writer does import and write through the models.
  const writerSource = readSource(writerPath);
  assert.match(writerSource, /models\/RecoveryTask\.js/);
  assert.match(writerSource, /models\/RecoveryEvent\.js/);
  assert.match(writerSource, /insertMany/);
  assert.match(writerSource, /updateOne/);
});

test("writer boundary: no connection, index, environment, or fallback behaviour", () => {
  const source = readSource("lib/recovery/taskWriter.js");

  assert.equal(/process\.env/.test(source), false);
  assert.equal(/mongoose\.connect|connectToDatabase|MONGODB_URI/.test(source), false);
  assert.equal(/\.createIndex\s*\(|syncIndexes|autoIndex:\s*true/.test(source), false);
  assert.match(source, /withTransaction/);
  assert.match(source, /matchedCount/);
  assert.match(source, /CAS_MISMATCH/);
  assert.match(source, /SEQUENCE_OVERFLOW/);
  assert.match(source, /UNRESOLVED_OUTCOME/);
  assert.match(source, /OPERATOR_DECISION_AFTER_HOLD/);
  assert.match(source, /ABORT_CONFIRMED/);
  assert.equal(/non-?transactional fallback/i.test(source), false);
});

test("writer boundary: WP04-06 reconciliation is read-only, model-free and path-owned", () => {
  const source = readSource("lib/recovery/operationReconciliation.js");

  assert.equal(/\.insertOne\s*\(|\.insertMany\s*\(|\.updateOne\s*\(|\.updateMany\s*\(/.test(source), false);
  assert.equal(/findOneAndUpdate|replaceOne|bulkWrite|deleteOne|deleteMany|upsert/.test(source), false);
  assert.equal(/createIndex|syncIndexes|startSession|withTransaction/.test(source), false);
  assert.equal(/models\/Recovery(Task|Event)\.js/.test(source), false);
  assert.equal(/process\.env|MONGODB_URI|mongoose\.connect/.test(source), false);
  assert.match(source, /findOne/);
  assert.match(source, /readOnly: true/);

  // Path ownership: the WP04-06 auditor is `operationReconciliation.js`; the
  // WP04-03 V1 scanner path stays reserved and is never imported by the writer.
  assert.match(source, /WP04-03/);
  assert.match(source, /reserved/);
  const writerSource = readSource("lib/recovery/taskWriter.js");
  assert.match(writerSource, /from\s+["']\.\/operationReconciliation\.js["']/);
  assert.equal(/from\s+["']\.\/reconciliation\.js["']/.test(writerSource), false);
});

// -----------------------------------------------------------------------------
// B. Transaction boundaries and CAS abort
// -----------------------------------------------------------------------------

test("W1: task and detection event are inserted in one transaction and one session", async () => {
  const database = createFakeDatabase();
  const writer = createWriter(database);

  const result = await writer.createTaskFromFinding({ task: creationDraft() });

  assert.equal(result.sequenceNumber, 1n);
  assert.equal(result.eventId, `EVT:${TASK_ID}:1`);
  assert.equal(database.tasks.documents.length, 1);
  assert.equal(database.events.documents.length, 1);
  assert.equal(database.events.documents[0].eventType, "RECOVERY_DETECTED");
  assert.equal(database.tasks.documents[0].eventSequenceCounter, 1n);

  const sessions = sessionIds(database);
  assert.equal(sessions.size, 1);
  assert.notEqual([...sessions][0], null, "every write must carry a session");
  assert.equal(database.sessions[0].ended, true);
});

test("W1: duplicate finding aborts with no event and no second task", async () => {
  const database = createFakeDatabase();
  const writer = createWriter(database);

  await writer.createTaskFromFinding({ task: creationDraft() });
  await expectWriterError(
    writer.createTaskFromFinding({ task: creationDraft({ taskId: OTHER_TASK_ID }) }),
    "DUPLICATE_TASK",
  );

  assert.equal(database.tasks.documents.length, 1);
  assert.equal(database.events.documents.length, 1);
});

test("W1: privileged lifecycle and audit fields cannot be injected at creation", async () => {
  const injections = {
    approval: { state: "APPROVED", approvedBy: APPROVER.id, operatorRole: APPROVER.role },
    approvedBy: APPROVER.id,
    approvedAt: NOW,
    executedBy: "executor-x",
    executedAt: NOW,
    verifierId: "verifier-x",
    verifiedAt: NOW,
    closedAt: NOW,
    cancelledAt: NOW,
    resolution: "ALREADY_CORRECT",
    status: "CLOSED",
    isOpen: false,
    leaseOwner: "someone-else",
    leaseToken: WORKER.token,
    leaseUntil: LIVE,
    leaseGeneration: 1n,
    eventSequenceCounter: 9n,
    attempts: 4,
    pendingOperation: reservedOperation(),
    manualReasonCode: "ATTEMPTS_EXHAUSTED",
    escalation: { code: "ESC_EXHAUSTED" },
    nextAttemptAt: NOW,
    lastErrorCode: "CONFLICT",
    lastErrorField: "field",
    priorTaskId: ORDER_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };

  for (const [field, value] of Object.entries(injections)) {
    const database = createFakeDatabase();
    const writer = createWriter(database);

    await expectWriterError(
      writer.createTaskFromFinding({ task: creationDraft({ [field]: value }) }),
      "INVALID_ARGUMENT",
    );

    assert.equal(allWrites(database).length, 0, `${field}: no write`);
    assert.equal(database.tasks.documents.length, 0, `${field}: no task`);
    assert.equal(database.events.documents.length, 0, `${field}: no event`);
  }
});

test("W1: legitimate finding metadata persists and writer-owned state is fixed", async () => {
  const database = createFakeDatabase();
  const writer = createWriter(database);

  await writer.createTaskFromFinding({
    task: creationDraft({
      orderNumber: "ORD-1",
      findingCodeOnly: true,
      durableClass: false,
      maxAttempts: 7,
    }),
  });

  const task = database.tasks.documents[0];
  assert.equal(task.taskId, TASK_ID);
  assert.equal(task.taskKey, `GRP:${ORDER_ID}`);
  assert.equal(task.findingIdentityKey, TASK_ID);
  assert.equal(task.orderNumber, "ORD-1");
  assert.equal(task.findingCodeOnly, true);
  assert.equal(task.durableClass, false);
  assert.equal(task.maxAttempts, 7);
  assert.equal(task.status, "DETECTED");
  assert.equal(task.isOpen, true);
  assert.equal(task.leaseOwner, null);
  assert.equal(task.leaseToken, null);
  assert.equal(task.leaseUntil, null);
  assert.equal(task.leaseGeneration, 0n);
  assert.equal(task.eventSequenceCounter, 1n);
  assert.equal(task.attempts, 0);
  assert.equal(task.pendingOperation, null);
  assert.equal(task.createdAt.getTime(), NOW.getTime());
  assert.equal(task.updatedAt.getTime(), NOW.getTime());
});

test("W1: durableClass accepts only Boolean or null", async () => {
  for (const value of [true, false, null]) {
    const database = createFakeDatabase();
    await createWriter(database).createTaskFromFinding({
      task: creationDraft({ durableClass: value }),
    });
    assert.equal(database.tasks.documents[0].durableClass, value);
    assert.equal(database.events.documents.length, 1);
  }

  for (const value of ["true", "false", 1, 0, {}, []]) {
    const database = createFakeDatabase();
    await expectWriterError(
      createWriter(database).createTaskFromFinding({
        task: creationDraft({ durableClass: value }),
      }),
      "INVALID_ARGUMENT",
    );
    assert.equal(allWrites(database).length, 0, `${JSON.stringify(value)}: no write`);
  }
});

test("W2: claim consumes one sequence, bumps the generation, and aborts on stale status", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(baseTask());
  const writer = createWriter(database);

  const claim = await writer.claimLease({ taskId: TASK_ID, fromStatus: "DETECTED", worker: WORKER });

  assert.equal(claim.leaseGeneration, 1n);
  assert.equal(claim.sequenceNumber, 2n);
  assert.equal(database.tasks.documents[0].status, "LEASED");
  assert.equal(database.tasks.documents[0].leaseGeneration, 1n);
  assert.equal(database.tasks.documents[0].attempts, 1);
  assert.equal(database.tasks.documents[0].eventSequenceCounter, 2n);
  assert.equal(database.events.documents[0].sequenceNumber, 2n);
  assert.equal(database.events.documents[0].eventType, "RECOVERY_LEASED");

  // Mongoose 9 reads options from the third argument. If the writer passes the
  // session object as the projection, the driver tries to serialize a
  // ClientSession into the query projection and the read fails.
  const read = database.tasks.calls.find(
    (call) => call.operation === "findOne" && call.filter.taskId === TASK_ID,
  );
  assert.ok(read, "the claim must read the task before its CAS");
  assert.equal(read.projection, null);
  assert.notEqual(read.options.session, undefined);
  assert.deepEqual(read.options.readConcern, { level: "majority" });

  // Second claim from the same observed status is a zero-match CAS.
  await expectWriterError(
    writer.claimLease({ taskId: TASK_ID, fromStatus: "DETECTED", worker: WORKER }),
    "CAS_MISMATCH",
  );
  assert.equal(database.events.documents.length, 1);
});

test("W2: claim is blocked by an unresolved operation (U_claim / T9)", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({ leaseUntil: EXPIRED, pendingOperation: reservedOperation() }),
  );
  const writer = createWriter(database);

  await expectWriterError(
    writer.claimLease({ taskId: TASK_ID, fromStatus: "LEASED", worker: WORKER }),
    "UNRESOLVED_OUTCOME",
  );
  assert.equal(database.events.documents.length, 0);
  assert.equal(database.tasks.documents[0].leaseGeneration, 1n);
});

test("W2: a live lease is never stolen and T12 requires approval", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(leasedTask());
  const writer = createWriter(database);

  await expectWriterError(
    writer.claimLease({ taskId: TASK_ID, fromStatus: "LEASED", worker: WORKER }),
    "CAS_MISMATCH",
  );

  database.tasks.documents = [
    baseTask({ status: "MANUAL_REQUIRED", isOpen: true, eventSequenceCounter: 4n }),
  ];
  await expectWriterError(
    writer.claimLease({
      taskId: TASK_ID,
      fromStatus: "MANUAL_REQUIRED",
      worker: WORKER,
      actor: {
        id: "operator-2",
        role: "ROLE-INVENTORY-MANAGER",
        type: "OPERATOR",
      },
    }),
    "APPROVAL_REQUIRED",
  );
  assert.equal(database.events.documents.length, 0);
});

test("CAS zero-match aborts before any event insert and rolls back", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(baseTask());
  const writer = createWriter(database);

  database.tasks.forceMatchedCount = 0;
  await expectWriterError(
    writer.claimLease({ taskId: TASK_ID, fromStatus: "DETECTED", worker: WORKER }),
    "CAS_MISMATCH",
  );

  assert.equal(database.events.documents.length, 0, "no event on CAS failure");
  assert.equal(database.tasks.documents[0].status, "DETECTED");
  assert.equal(database.tasks.documents[0].eventSequenceCounter, 1n);
  assert.equal(database.sessions[0].aborted, true);
});

test("predicate builders express the approved positive predicates", () => {
  assert.deepEqual(buildUnresolvedOperationPredicate(), {
    $or: [{ pendingOperation: null }, { "pendingOperation.state": { $in: ["COMMITTED", "ABANDONED"] } }],
  });
  assert.deepEqual(buildClaimUnresolvedPredicate(), buildUnresolvedOperationPredicate());

  const expired = buildExpiredOriginalLeasePredicate({
    leaseGeneration: 3n,
    leaseToken: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    leaseOwner: "w",
  });
  assert.equal(expired.$expr.$lte[1], "$$NOW");
  assert.equal(expired.leaseGeneration, 3n);
  assert.equal(expired.leaseToken, "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.equal(expired.leaseOwner, "w");

  const pending = buildPendingOperationPredicate({
    operationId: "op-1",
    leaseGeneration: 1n,
    sequenceNumber: 3n,
    eventId: "EVT:x:3",
  });
  assert.equal(pending["pendingOperation.state"], "PREPARED");
  assert.equal(pending["pendingOperation.sequenceNumber"], 3n);

  const sequence = buildSequencePredicate(4n);
  assert.deepEqual(sequence[0], { eventSequenceCounter: 4n });
  assert.deepEqual(sequence[1], { eventSequenceCounter: { $lt: 1_000_000n } });
});

// -----------------------------------------------------------------------------
// B2. G_ATTEMPTS scope (T2 / T10 only)
// -----------------------------------------------------------------------------

test("G_ATTEMPTS: T2 blocks at maxAttempts", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(baseTask({ attempts: 5, maxAttempts: 5 }));
  const writer = createWriter(database);

  await expectWriterError(
    writer.claimLease({ taskId: TASK_ID, fromStatus: "DETECTED", worker: WORKER }),
    "CAS_MISMATCH",
  );

  assert.equal(database.tasks.documents[0].status, "DETECTED");
  assert.equal(database.tasks.documents[0].attempts, 5);
  assert.equal(database.events.documents.length, 0);
});

test("G_ATTEMPTS: T2 succeeds below maxAttempts", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(baseTask({ attempts: 4, maxAttempts: 5 }));
  const writer = createWriter(database);

  const result = await writer.claimLease({
    taskId: TASK_ID,
    fromStatus: "DETECTED",
    worker: WORKER,
  });

  assert.equal(result.status, "LEASED");
  assert.equal(database.tasks.documents[0].attempts, 5);
  assert.equal(database.events.documents[0].eventType, "RECOVERY_LEASED");
});

test("G_ATTEMPTS: T10 blocks at maxAttempts", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    baseTask({
      status: "RETRY_SCHEDULED",
      attempts: 5,
      maxAttempts: 5,
      nextAttemptAt: EXPIRED,
    }),
  );
  const writer = createWriter(database);

  await expectWriterError(
    writer.claimLease({ taskId: TASK_ID, fromStatus: "RETRY_SCHEDULED", worker: WORKER }),
    "CAS_MISMATCH",
  );

  assert.equal(database.tasks.documents[0].status, "RETRY_SCHEDULED");
  assert.equal(database.events.documents.length, 0);
});

test("G_ATTEMPTS: T9 expired-lease reclaim is exempt at maxAttempts", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({ leaseUntil: EXPIRED, attempts: 5, maxAttempts: 5 }),
  );
  const writer = createWriter(database);

  const result = await writer.claimLease({
    taskId: TASK_ID,
    fromStatus: "LEASED",
    worker: WORKER,
  });

  assert.equal(result.status, "LEASED");
  assert.equal(database.tasks.documents[0].attempts, 6);
  assert.equal(database.events.documents[0].eventType, "RECOVERY_LEASED");
});

test("G_ATTEMPTS: T12 approved manual reclaim is exempt at maxAttempts", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    baseTask({
      status: "MANUAL_REQUIRED",
      attempts: 5,
      maxAttempts: 5,
      approval: {
        state: "APPROVED",
        approvedBy: "operator-1",
        approvedAt: NOW,
        operatorRole: "ROLE-INVENTORY-MANAGER",
      },
    }),
  );
  const writer = createWriter(database);

  const result = await writer.claimLease({
    taskId: TASK_ID,
    fromStatus: "MANUAL_REQUIRED",
    worker: WORKER,
    actor: {
      id: "operator-2",
      role: "ROLE-INVENTORY-MANAGER",
      type: "OPERATOR",
    },
  });

  assert.equal(result.status, "LEASED");
  assert.equal(database.tasks.documents[0].attempts, 6);
  assert.equal(
    database.tasks.documents[0].executedBy,
    "operator-2",
    "T12 attributes the executing operator",
  );
  assert.equal(database.events.documents[0].eventType, "RECOVERY_LEASED");
});

// -----------------------------------------------------------------------------
// C. Sequence allocation (OD-28 / I-C)
// -----------------------------------------------------------------------------

test("I-C: claim, reserve, effect and abandon each consume the approved slot", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(baseTask());
  const writer = createWriter(database);

  const claim = await writer.claimLease({ taskId: TASK_ID, fromStatus: "DETECTED", worker: WORKER });
  assert.equal(claim.sequenceNumber, 2n);

  const reservation = await writer.reserveOperation({
    taskId: TASK_ID,
    worker: WORKER,
    intentDigest: "b".repeat(64),
  });
  assert.equal(reservation.sequenceNumber, 3n);
  assert.equal(database.tasks.documents[0].eventSequenceCounter, 3n);
  assert.equal(
    database.events.documents.length,
    1,
    "T_reserve emits no event (I-C)",
  );

  await writer.commitOperation({
    taskId: TASK_ID,
    worker: WORKER,
    operation: reservation.operation,
    fromStatus: "LEASED",
    toStatus: "RESOLVED",
    eventType: "RECOVERY_RESOLVED",
    fields: { resolution: "ALREADY_CORRECT", currentFingerprint: FINGERPRINT },
  });

  assert.equal(
    database.tasks.documents[0].eventSequenceCounter,
    3n,
    "W7 never increments the counter",
  );
  assert.equal(database.events.documents.length, 2);
  assert.equal(database.events.documents[1].sequenceNumber, 3n);

  // Abandon a second, unresolved reservation and prove the gap is permanent.
  database.tasks.documents[0] = leasedTask({
    eventSequenceCounter: 5n,
    leaseUntil: EXPIRED,
    pendingOperation: reservedOperation({
      operationId: "op-2",
      sequenceNumber: 4n,
      eventId: `EVT:${TASK_ID}:4`,
    }),
  });
  const abandoned = await writer.abandonOperation({
    taskId: TASK_ID,
    operation: {
      operationId: "op-2",
      leaseGeneration: 1n,
      sequenceNumber: 4n,
      eventId: `EVT:${TASK_ID}:4`,
    },
    authorization: {
      id: "auth-1",
      operationId: "op-2",
      operatorId: "operator-1",
      operatorRole: "ROLE-INVENTORY-MANAGER",
    },
  });

  assert.equal(abandoned.sequenceNumber, 6n);
  assert.equal(database.tasks.documents[0].eventSequenceCounter, 6n);
  const sequences = database.events.documents.map((document) => document.sequenceNumber);
  assert.equal(sequences.includes(4n), false, "the reserved sequence remains a permanent gap");
  assert.equal(sequences.includes(5n), false, "no sequence is reused");
  assert.equal(sequences.includes(6n), true);
});

test("OD-28: the sequence ceiling fails closed with no writes", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({ eventSequenceCounter: 1_000_000n }),
  );
  const writer = createWriter(database);

  assert.throws(() => nextSequenceNumber(1_000_000n), (error) => error.code === "SEQUENCE_OVERFLOW");

  await expectWriterError(
    writer.reserveOperation({
      taskId: TASK_ID,
      worker: WORKER,
      intentDigest: "b".repeat(64),
    }),
    "SEQUENCE_OVERFLOW",
  );

  assert.equal(database.tasks.documents[0].eventSequenceCounter, 1_000_000n);
  assert.equal(database.tasks.documents[0].pendingOperation, null);
  assert.equal(database.events.documents.length, 0);
});

test("OD-25: a second reservation is blocked until the prior operation is terminal", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({ eventSequenceCounter: 3n, pendingOperation: reservedOperation() }),
  );
  const writer = createWriter(database);

  await expectWriterError(
    writer.reserveOperation({
      taskId: TASK_ID,
      worker: WORKER,
      intentDigest: "b".repeat(64),
    }),
    "UNRESOLVED_OUTCOME",
  );
  assert.equal(database.events.documents.length, 0);
});

// -----------------------------------------------------------------------------
// D. H1 atomicity (OD-30 / OD-33)
// -----------------------------------------------------------------------------

test("H1: effect writes task, event and history with the same session", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({ eventSequenceCounter: 3n, pendingOperation: reservedOperation() }),
  );
  const writer = createWriter(database);

  await writer.commitOperation({
    taskId: TASK_ID,
    worker: WORKER,
    operation: reservedOperation(),
    fromStatus: "LEASED",
    toStatus: "RESOLVED",
    eventType: "RECOVERY_RESOLVED",
    fields: { resolution: "ALREADY_CORRECT", currentFingerprint: FINGERPRINT },
  });

  assert.equal(database.history.documents.length, 1);
  const record = database.history.documents[0];
  assert.equal(record.historyId, buildOperationHistoryId(TASK_ID, "op-1"));
  assert.equal(record.state, "COMMITTED");
  assert.equal(record.sequenceNumber, 3n);
  assert.equal(record.leaseGeneration, 1n);

  const sessions = sessionIds(database);
  assert.equal(sessions.size, 1, "task, event and history share one session");
  assert.notEqual([...sessions][0], null);

  // The history row is append-only: the writer never updates it.
  assert.equal(database.history.calls.filter((call) => call.operation === "updateOne").length, 0);
});

test("H1: a duplicate history key aborts the whole effect transaction", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({ eventSequenceCounter: 3n, pendingOperation: reservedOperation() }),
  );
  database.history.failInsertWith = Object.assign(new Error("E11000"), { code: 11000 });
  const writer = createWriter(database);

  await expectWriterError(
    writer.commitOperation({
      taskId: TASK_ID,
      worker: WORKER,
      operation: reservedOperation(),
      fromStatus: "LEASED",
      toStatus: "RESOLVED",
      eventType: "RECOVERY_RESOLVED",
      fields: { resolution: "ALREADY_CORRECT", currentFingerprint: FINGERPRINT },
    }),
    "DUPLICATE_HISTORY",
  );

  assert.equal(database.tasks.documents[0].pendingOperation.state, "PREPARED");
  assert.equal(database.tasks.documents[0].status, "LEASED");
  assert.equal(database.events.documents.length, 0, "no event survives the rollback");
});

test("H1: the task-document CAS is the fence, not the history row", () => {
  const source = readSource("lib/recovery/taskWriter.js");
  assert.match(source, /task-document CAS is the fence/i);
  assert.match(source, /never the uniqueness fence/i);
  assert.match(source, /history/i);

  // The effect path does not read the history collection before deciding.
  const commitStart = source.indexOf("async function commitOperation");
  const commitEnd = source.indexOf("async function abandonOperation");
  const commitSource = source.slice(commitStart, commitEnd);
  assert.equal(/historyModel\.findOne/.test(commitSource), false);
  assert.match(commitSource, /buildPendingOperationPredicate/);
});

// -----------------------------------------------------------------------------
// E. Replay and UNKNOWN_COMMIT (OD-27 / OD-27-SC / OD-31)
// -----------------------------------------------------------------------------

test("OD-31: PREPARED is unresolved and UNKNOWN_COMMIT is never persisted", () => {
  const outcome = assessOperationOutcome({ pendingOperation: reservedOperation() });
  assert.equal(outcome.state, "UNRESOLVED");
  assert.equal(outcome.action, "HOLD");
  assert.equal(outcome.replayable, false);

  assert.equal(assessOperationOutcome({ pendingOperation: null }).state, "NO_OPERATION");
  assert.equal(
    assessOperationOutcome({ pendingOperation: reservedOperation({ state: "COMMITTED" }) }).state,
    "TERMINAL",
  );

  const source = readSource("lib/recovery/taskWriter.js");
  assert.equal(/state:\s*["']UNKNOWN_COMMIT["']/.test(source), false);
  assert.equal(TERMINAL_OP_STATES.includes("UNKNOWN_COMMIT"), false);
});

test("OD-27/OD-31: an UNKNOWN_COMMIT observation performs no write through any non-abandonment entry point", async () => {
  const pending = () => reservedOperation();

  const observation = assessOperationOutcome({ pendingOperation: pending() });
  assert.equal(observation.state, "UNRESOLVED");
  assert.equal(observation.action, "HOLD");
  assert.equal(observation.replayable, false);
  assert.equal(assessOperationState({ pendingOperation: pending() }).action, "HOLD");

  // Every writer entry point except the effect (W7) and the separately
  // authorized abandonment (W8) must refuse to settle a PREPARED operation.
  const cases = [
    {
      label: "claimLease",
      method: "claimLease",
      task: leasedTask({ eventSequenceCounter: 4n, pendingOperation: pending() }),
      input: { taskId: TASK_ID, fromStatus: "LEASED", worker: WORKER },
    },
    {
      label: "renewLease",
      method: "renewLease",
      task: leasedTask({ eventSequenceCounter: 4n, pendingOperation: pending() }),
      input: { taskId: TASK_ID, worker: WORKER },
    },
    {
      label: "reserveOperation",
      method: "reserveOperation",
      task: leasedTask({ eventSequenceCounter: 4n, pendingOperation: pending() }),
      input: {
        taskId: TASK_ID,
        worker: WORKER,
        intentDigest: "b".repeat(64),
        operationId: "op-2",
      },
    },
    {
      label: "applyTransition T-APPROVE",
      method: "applyTransition",
      task: manualRequiredTask({ pendingOperation: pending() }),
      input: {
        taskId: TASK_ID,
        transitionId: "T-APPROVE",
        actor: APPROVER,
        approval: approvalRecord(),
      },
    },
    {
      label: "applyTransition T-EXHAUST",
      method: "applyTransition",
      task: leasedTask({
        eventSequenceCounter: 4n,
        attempts: 5,
        maxAttempts: 5,
        pendingOperation: pending(),
      }),
      input: {
        taskId: TASK_ID,
        transitionId: "T-EXHAUST",
        worker: WORKER,
        fields: {
          manualReasonCode: "ATTEMPTS_EXHAUSTED",
          escalation: { code: "ESC_MANUAL_RULE" },
        },
      },
    },
    {
      label: "resolveTask",
      method: "resolveTask",
      task: leasedTask({ eventSequenceCounter: 4n, pendingOperation: pending() }),
      input: { taskId: TASK_ID, worker: WORKER },
    },
    {
      label: "closeTask",
      method: "closeTask",
      task: baseTask({
        status: "RESOLVED",
        isOpen: true,
        eventSequenceCounter: 4n,
        resolution: "ALREADY_CORRECT",
        approvedBy: APPROVER.id,
        executedBy: "executor-1",
        pendingOperation: pending(),
      }),
      input: { taskId: TASK_ID, actor: VERIFIER },
    },
    {
      label: "cancelTask",
      method: "cancelTask",
      task: manualRequiredTask({ pendingOperation: pending() }),
      input: { taskId: TASK_ID, actor: OPERATOR },
    },
    {
      label: "recordApproval",
      method: "recordApproval",
      task: manualRequiredTask({ pendingOperation: pending() }),
      input: { taskId: TASK_ID, actor: APPROVER, approval: approvalRecord() },
    },
    {
      label: "recordRejection",
      method: "recordRejection",
      task: manualRequiredTask({ pendingOperation: pending() }),
      input: { taskId: TASK_ID, actor: APPROVER, approval: approvalRecord({ state: "REJECTED" }) },
    },
    {
      label: "escalateTask",
      method: "escalateTask",
      task: exhaustedLeasedTask({ pendingOperation: pending() }),
      input: { taskId: TASK_ID, worker: WORKER },
    },
  ];

  for (const entry of cases) {
    const database = createFakeDatabase();
    database.tasks.documents.push(entry.task);
    const writer = createWriter(database);

    await expectWriterError(writer[entry.method](entry.input), "UNRESOLVED_OUTCOME");

    assert.equal(allWrites(database).length, 0, `${entry.label}: no write`);
    assert.equal(database.events.documents.length, 0, `${entry.label}: no event`);
    assert.equal(database.history.documents.length, 0, `${entry.label}: no history`);
    assert.equal(
      database.tasks.documents[0].pendingOperation.state,
      "PREPARED",
      `${entry.label}: operation stays PREPARED`,
    );
    assert.equal(
      database.tasks.documents[0].eventSequenceCounter,
      4n,
      `${entry.label}: no sequence consumed`,
    );
  }
});

test("OD-27-SC: replay needs writer-observed definitive abort of the same operation", () => {
  const operation = reservedOperation();

  for (const outcome of NON_PROOF_OUTCOMES) {
    const assessment = assessReplayEligibility({
      operation,
      evidence: { outcome, operationId: "op-1" },
    });
    assert.equal(assessment.replayable, false, `${outcome} must never authorize replay`);
  }

  assert.equal(
    assessReplayEligibility({ operation, evidence: { outcome: "WRITE_CONFLICT_ROLLBACK", operationId: "op-1" } })
      .replayable,
    true,
  );
  assert.equal(
    assessReplayEligibility({ operation, evidence: { outcome: "TRANSACTION_ABORTED", operationId: "op-1" } })
      .replayable,
    true,
  );
  assert.equal(
    assessReplayEligibility({ operation, evidence: { outcome: "WRITE_CONFLICT_ROLLBACK", operationId: "op-2" } })
      .replayable,
    false,
  );
  assert.equal(assessReplayEligibility({ operation, evidence: undefined }).replayable, false);
  assert.deepEqual([...DEFINITIVE_ABORT_EVIDENCE].sort(), ["TRANSACTION_ABORTED", "WRITE_CONFLICT_ROLLBACK"]);
});

test("OD-27-SC: the writer refuses a replay justified by UNKNOWN_COMMIT", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({ eventSequenceCounter: 3n, pendingOperation: reservedOperation() }),
  );
  const writer = createWriter(database);

  await expectWriterError(
    writer.commitOperation({
      taskId: TASK_ID,
      worker: WORKER,
      operation: reservedOperation(),
      fromStatus: "LEASED",
      toStatus: "RESOLVED",
      eventType: "RECOVERY_RESOLVED",
      fields: { resolution: "ALREADY_CORRECT", currentFingerprint: FINGERPRINT },
      abortEvidence: { outcome: "UNKNOWN_COMMIT", operationId: "op-1" },
    }),
    "REPLAY_NOT_AUTHORIZED",
  );

  assert.equal(database.events.documents.length, 0);
  assert.equal(database.history.documents.length, 0);
  assert.equal(database.tasks.documents[0].pendingOperation.state, "PREPARED");
});

// -----------------------------------------------------------------------------
// E3. Offline restart model (BLK-UC-01 / BLK-UC-02)
//
// A fresh createWriter() on the same fake database models a restarted process:
// the writer instance and its sessions are gone, and the task document is the
// only durable state. DB-free; this is not a crash/restart server proof.
// -----------------------------------------------------------------------------

test("BLK-UC-01 (offline): a fresh writer after restart adopts the durable reservation and commits the effect at the reserved identity", async () => {
  // Crash model: the process died after T_reserve committed. The reserved
  // identity lives only on the task document.
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({ eventSequenceCounter: 3n, pendingOperation: reservedOperation() }),
  );
  const durable = database.tasks.documents[0].pendingOperation;
  assert.equal(durable.state, "PREPARED");

  // A brand-new writer (fresh sessions) models the restarted process.
  const restarted = createWriter(database);

  const result = await restarted.commitOperation({
    taskId: TASK_ID,
    worker: WORKER,
    operation: {
      operationId: durable.operationId,
      leaseGeneration: durable.leaseGeneration,
      sequenceNumber: durable.sequenceNumber,
      eventId: durable.eventId,
    },
    fromStatus: "LEASED",
    toStatus: "RESOLVED",
    eventType: "RECOVERY_RESOLVED",
    fields: { resolution: "ALREADY_CORRECT", currentFingerprint: FINGERPRINT },
  });

  // The identity is the reserved one; no new sequence or eventId was minted.
  assert.equal(result.operationId, "op-1");
  assert.equal(result.sequenceNumber, 3n);
  assert.equal(result.eventId, `EVT:${TASK_ID}:3`);

  const task = database.tasks.documents[0];
  assert.equal(task.status, "RESOLVED");
  assert.equal(task.eventSequenceCounter, 3n, "W7 never increments the counter");
  assert.equal(task.pendingOperation.state, "COMMITTED");

  assert.equal(database.events.documents.length, 1, "exactly one effect event");
  assert.equal(database.events.documents[0].sequenceNumber, 3n);
  assert.equal(database.events.documents[0].eventId, `EVT:${TASK_ID}:3`);
  assert.equal(database.events.documents[0].eventType, "RECOVERY_RESOLVED");
  assert.equal(database.events.documents[0].fencingToken, WORKER.token);

  assert.equal(database.history.documents.length, 1, "exactly one history record");
  assert.equal(database.history.documents[0].state, "COMMITTED");
  assert.equal(database.history.documents[0].operationId, "op-1");

  // Exactly one transaction, owned by the restarted writer's fresh session.
  assert.equal(sessionIds(database).size, 1);
  assert.equal(database.sessions.length, 1);
});

test("BLK-UC-01/UC-02 (offline): a fresh writer after an indeterminate effect holds without minting an identity", async () => {
  // Crash model: the process died while T_effect was in flight. The durable
  // operation stays PREPARED; the outcome is indeterminate and absence is not
  // abort proof, so the restarted writer must hold and mint nothing.
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({ eventSequenceCounter: 3n, pendingOperation: reservedOperation() }),
  );

  const restarted = createWriter(database);
  const durable = database.tasks.documents[0].pendingOperation;
  assert.equal(assessOperationState(database.tasks.documents[0]).state, "UNRESOLVED");
  assert.equal(assessOperationState(database.tasks.documents[0]).action, "HOLD");

  // A new reservation would mint a new operation identity; it is refused.
  await expectWriterError(
    restarted.reserveOperation({
      taskId: TASK_ID,
      worker: WORKER,
      intentDigest: "b".repeat(64),
    }),
    "UNRESOLVED_OUTCOME",
  );

  // A claim would bump the lease generation; it is refused by U_claim.
  await expectWriterError(
    restarted.claimLease({ taskId: TASK_ID, fromStatus: "LEASED", worker: WORKER }),
    "UNRESOLVED_OUTCOME",
  );

  // A same-identity effect retry justified by UNKNOWN_COMMIT is refused.
  await expectWriterError(
    restarted.commitOperation({
      taskId: TASK_ID,
      worker: WORKER,
      operation: {
        operationId: durable.operationId,
        leaseGeneration: durable.leaseGeneration,
        sequenceNumber: durable.sequenceNumber,
        eventId: durable.eventId,
      },
      fromStatus: "LEASED",
      toStatus: "RESOLVED",
      eventType: "RECOVERY_RESOLVED",
      fields: { resolution: "ALREADY_CORRECT", currentFingerprint: FINGERPRINT },
      abortEvidence: { outcome: "UNKNOWN_COMMIT", operationId: "op-1" },
    }),
    "REPLAY_NOT_AUTHORIZED",
  );

  assert.equal(allWrites(database).length, 0, "no write");
  assert.equal(database.events.documents.length, 0, "no event");
  assert.equal(database.history.documents.length, 0, "no history");

  const task = database.tasks.documents[0];
  assert.equal(task.pendingOperation.state, "PREPARED", "operation stays PREPARED");
  assert.equal(task.pendingOperation.operationId, "op-1");
  assert.equal(task.eventSequenceCounter, 3n, "no sequence consumed");
  assert.equal(task.leaseGeneration, 1n, "no generation bump");
  assert.equal(task.leaseOwner, WORKER.id);
  assert.equal(task.leaseToken, WORKER.token);
});

test("BLK-UC-02 (offline): post-restart reconciliation adopts COMMITTED and holds PREPARED without abort proof", async () => {
  // Vocabulary: the read-only restart reconciler classifies the durable worlds.
  const committedOperation = reservedOperation({ state: "COMMITTED", settledAt: NOW });
  const abandonedOperation = reservedOperation({ state: "ABANDONED", settledAt: NOW });
  const preparedOperation = reservedOperation();

  assert.deepEqual(assessOperationState({ pendingOperation: committedOperation }), {
    state: "TERMINAL",
    action: "PROCEED",
    replayable: false,
    operationId: "op-1",
    reason: "COMMITTED",
  });
  assert.deepEqual(assessReplayEligibility({ operation: committedOperation }), {
    replayable: false,
    adoptable: true,
    reason: "ALREADY_COMMITTED",
  });

  assert.equal(assessOperationState({ pendingOperation: abandonedOperation }).action, "PROCEED");
  assert.equal(assessOperationState({ pendingOperation: abandonedOperation }).reason, "ABANDONED");
  assert.deepEqual(
    assessReplayEligibility({
      operation: abandonedOperation,
      evidence: { outcome: "TRANSACTION_ABORTED", operationId: "op-1" },
    }),
    { replayable: false, reason: "ALREADY_ABANDONED" },
  );

  assert.equal(assessOperationState({ pendingOperation: preparedOperation }).action, "HOLD");
  assert.equal(
    assessReplayEligibility({ operation: preparedOperation }).reason,
    "NO_DEFINITIVE_ABORT_EVIDENCE",
  );
  assert.equal(
    assessReplayEligibility({
      operation: preparedOperation,
      evidence: { outcome: "UNKNOWN_COMMIT", operationId: "op-1" },
    }).reason,
    "NON_PROOF:UNKNOWN_COMMIT",
  );

  // Writer behavior in the committed world: a restarted writer cannot
  // double-commit the settled effect; the durable state is adopted read-only.
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({
      eventSequenceCounter: 3n,
      pendingOperation: reservedOperation({ state: "COMMITTED", settledAt: NOW }),
    }),
  );
  const restarted = createWriter(database);
  const durable = database.tasks.documents[0].pendingOperation;

  await expectWriterError(
    restarted.commitOperation({
      taskId: TASK_ID,
      worker: WORKER,
      operation: {
        operationId: durable.operationId,
        leaseGeneration: durable.leaseGeneration,
        sequenceNumber: durable.sequenceNumber,
        eventId: durable.eventId,
      },
      fromStatus: "LEASED",
      toStatus: "RESOLVED",
      eventType: "RECOVERY_RESOLVED",
      fields: { resolution: "ALREADY_CORRECT", currentFingerprint: FINGERPRINT },
    }),
    "CAS_MISMATCH",
  );

  // Zero-match CAS abort: no durable state change and no event/history row.
  assert.equal(database.events.documents.length, 0, "no event");
  assert.equal(database.history.documents.length, 0, "no history");
  assert.equal(database.tasks.documents[0].status, "LEASED", "status unchanged");
  assert.equal(database.tasks.documents[0].pendingOperation.state, "COMMITTED");
  assert.equal(database.tasks.documents[0].eventSequenceCounter, 3n);
  assert.equal(database.sessions[0].aborted, true, "the aborted attempt left no partial write");
});

// -----------------------------------------------------------------------------
// E2. W7 strict effect mapping and W5 per-transition allowlists
// -----------------------------------------------------------------------------

const OPERATOR = Object.freeze({
  id: "operator-2",
  role: "ROLE-INVENTORY-MANAGER",
  type: "OPERATOR",
});

const VERIFIER = Object.freeze({
  id: "verifier-2",
  role: "ROLE-TECHNICAL-LEAD",
  type: "VERIFIER",
});

function effectFixture(overrides = {}) {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({
      eventSequenceCounter: 3n,
      pendingOperation: reservedOperation(),
      ...overrides,
    }),
  );
  return database;
}

function effectInput(overrides = {}) {
  return {
    taskId: TASK_ID,
    worker: WORKER,
    operation: reservedOperation(),
    fromStatus: "LEASED",
    toStatus: "RESOLVED",
    eventType: "RECOVERY_RESOLVED",
    fields: { resolution: "ALREADY_CORRECT", currentFingerprint: FINGERPRINT },
    ...overrides,
  };
}

test("W7: only LEASED -> RESOLVED is an approved effect transition", async () => {
  const cases = [
    { fromStatus: "LEASED", toStatus: "CLOSED" },
    { fromStatus: "LEASED", toStatus: "CANCELLED" },
    { fromStatus: "RESOLVED", toStatus: "CLOSED" },
    { fromStatus: "MANUAL_REQUIRED", toStatus: "RESOLVED" },
    { fromStatus: "DETECTED", toStatus: "LEASED" },
  ];

  for (const entry of cases) {
    const database = effectFixture();
    const writer = createWriter(database);
    await expectWriterError(
      writer.commitOperation(effectInput(entry)),
      "TRANSITION_NOT_ALLOWED",
    );
    assert.equal(database.events.documents.length, 0, `${entry.fromStatus}->${entry.toStatus}: no event`);
    assert.equal(database.history.documents.length, 0);
    assert.equal(database.tasks.documents[0].pendingOperation.state, "PREPARED");
  }
});

test("W7: an unapproved event type is rejected before any write", async () => {
  for (const eventType of ["RECOVERY_VERIFIED", "RECOVERY_CLOSED", "RECOVERY_APPROVED", "RECOVERY_LEASED"]) {
    const database = effectFixture();
    const writer = createWriter(database);
    await expectWriterError(
      writer.commitOperation(effectInput({ eventType })),
      "TRANSITION_NOT_ALLOWED",
    );
    assert.equal(database.events.documents.length, 0);
    assert.equal(database.history.documents.length, 0);
    assert.equal(database.tasks.documents[0].status, "LEASED");
  }
});

test("W7: privileged-field injection is rejected", async () => {
  const injections = [
    { isOpen: false },
    { closedAt: NOW },
    { cancelledAt: NOW },
    { status: "CLOSED" },
    { approval: { state: "APPROVED", approvedBy: APPROVER.id, operatorRole: APPROVER.role } },
    { approvedBy: APPROVER.id },
    { approvedAt: NOW },
    { verifierId: "verifier-x" },
    { verifiedAt: NOW },
    { executedBy: "executor-x" },
    { executedAt: NOW },
    { manualReasonCode: "ATTEMPTS_EXHAUSTED" },
    { escalation: { code: "ESC_EXHAUSTED" } },
    { nextAttemptAt: NOW },
    { leaseOwner: "someone-else" },
  ];

  for (const injection of injections) {
    const database = effectFixture();
    const writer = createWriter(database);
    await expectWriterError(
      writer.commitOperation(
        effectInput({ fields: { ...effectInput().fields, ...injection } }),
      ),
      "INVALID_ARGUMENT",
    );
    assert.equal(database.events.documents.length, 0, `${Object.keys(injection)[0]}: no event`);
    assert.equal(database.history.documents.length, 0);
  }
});

test("W7: T5 requires the approved resolution and effect evidence; APPLIED is read-only", async () => {
  const cases = [
    { fields: { currentFingerprint: FINGERPRINT }, label: "missing resolution" },
    { fields: { resolution: "APPLIED", currentFingerprint: FINGERPRINT }, label: "APPLIED" },
    { fields: { resolution: "ESCALATED", currentFingerprint: FINGERPRINT }, label: "ESCALATED" },
    { fields: { resolution: "CANCELLED", currentFingerprint: FINGERPRINT }, label: "CANCELLED" },
    { fields: { resolution: "ALREADY_CORRECT" }, label: "missing effect evidence" },
    {
      fields: { resolution: "ALREADY_CORRECT", currentFingerprint: "not-a-digest" },
      label: "invalid effect evidence",
    },
  ];

  for (const entry of cases) {
    const database = effectFixture();
    const writer = createWriter(database);
    await expectWriterError(
      writer.commitOperation(effectInput({ fields: entry.fields })),
      "INVALID_ARGUMENT",
    );
    assert.equal(database.events.documents.length, 0, `${entry.label}: no event`);
    assert.equal(database.history.documents.length, 0);
  }
});

test("W5: T6 retry enforces attempts < maxAttempts and a scheduled next attempt", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(leasedTask({ eventSequenceCounter: 4n, attempts: 1 }));
  const writer = createWriter(database);
  const nextAttemptAt = new Date(NOW.getTime() + 60_000);

  const result = await writer.applyTransition({
    taskId: TASK_ID,
    transitionId: "T-RETRY",
    worker: WORKER,
    fields: { nextAttemptAt },
  });

  assert.equal(result.status, "RETRY_SCHEDULED");
  assert.equal(database.tasks.documents[0].status, "RETRY_SCHEDULED");
  assert.equal(database.tasks.documents[0].nextAttemptAt.getTime(), nextAttemptAt.getTime());
  assert.equal(database.events.documents[0].eventType, "RECOVERY_RETRY_SCHEDULED");

  const blocked = createFakeDatabase();
  blocked.tasks.documents.push(
    leasedTask({ eventSequenceCounter: 4n, attempts: 5, maxAttempts: 5 }),
  );
  await expectWriterError(
    createWriter(blocked).applyTransition({
      taskId: TASK_ID,
      transitionId: "T-RETRY",
      worker: WORKER,
      fields: { nextAttemptAt },
    }),
    "CAS_MISMATCH",
  );
  assert.equal(blocked.events.documents.length, 0);

  const missing = createFakeDatabase();
  missing.tasks.documents.push(leasedTask({ eventSequenceCounter: 4n, attempts: 1 }));
  await expectWriterError(
    createWriter(missing).applyTransition({
      taskId: TASK_ID,
      transitionId: "T-RETRY",
      worker: WORKER,
      fields: {},
    }),
    "INVALID_ARGUMENT",
  );
  assert.equal(missing.events.documents.length, 0);
});

test("W5: closure, cancellation, resolution and renewal are not reachable through W5", async () => {
  const ids = [
    "T-CLOSE",
    "T-CANCEL-DETECTED",
    "T-CANCEL-LEASED",
    "T-CANCEL-MANUAL",
    "T-RESOLVE",
    "T-RENEW",
  ];

  for (const transitionId of ids) {
    const database = createFakeDatabase();
    database.tasks.documents.push(leasedTask({ eventSequenceCounter: 4n }));
    const writer = createWriter(database);

    await expectWriterError(
      writer.applyTransition({ taskId: TASK_ID, transitionId, worker: WORKER }),
      "TRANSITION_NOT_ALLOWED",
    );
    assert.equal(database.events.documents.length, 0, `${transitionId}: no event`);
    assert.equal(database.tasks.documents[0].status, "LEASED");
  }
});

test("W5: T-REJECT is not reachable through applyTransition", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(manualRequiredTask());
  const writer = createWriter(database);

  await expectWriterError(
    writer.applyTransition({
      taskId: TASK_ID,
      transitionId: "T-REJECT",
      actor: APPROVER,
      approval: approvalRecord({ state: "REJECTED" }),
    }),
    "TRANSITION_NOT_ALLOWED",
  );

  assert.equal(allWrites(database).length, 0, "no write");
  assert.equal(database.events.documents.length, 0, "no event");
  assert.equal(database.history.documents.length, 0, "no history");
  assert.equal(database.tasks.documents[0].status, "MANUAL_REQUIRED");
  assert.equal(database.tasks.documents[0].approval, null, "approval unchanged");
  assert.equal(database.tasks.documents[0].eventSequenceCounter, 4n);
});

test("W5: T-EXHAUST requires a valid escalation category and a technical diagnostic only", async () => {
  const positive = createFakeDatabase();
  positive.tasks.documents.push(exhaustedLeasedTask());
  const result = await createWriter(positive).applyTransition({
    taskId: TASK_ID,
    transitionId: "T-EXHAUST",
    worker: WORKER,
    fields: {
      manualReasonCode: "ATTEMPTS_EXHAUSTED",
      escalation: { code: "ESC_MANUAL_RULE", expectedStatus: "LEASED", actualStatus: "LEASED" },
    },
    diagnosticCode: "TIMEOUT",
  });

  assert.equal(result.status, "MANUAL_REQUIRED");
  assert.equal(positive.tasks.documents[0].escalation.code, "ESC_MANUAL_RULE");
  assert.equal(positive.events.documents[0].eventType, "RECOVERY_ESCALATED");
  assert.equal(positive.events.documents[0].details.diagnosticCode, "TIMEOUT");

  const cases = [
    {
      label: "missing escalation",
      fields: { manualReasonCode: "ATTEMPTS_EXHAUSTED" },
      code: "INVALID_ARGUMENT",
    },
    {
      label: "missing escalation code",
      fields: { manualReasonCode: "ATTEMPTS_EXHAUSTED", escalation: {} },
      code: "INVALID_ARGUMENT",
    },
    {
      label: "diagnostic used as escalation code",
      fields: { manualReasonCode: "ATTEMPTS_EXHAUSTED", escalation: { code: "TIMEOUT" } },
      code: "INVALID_ARGUMENT",
    },
    {
      label: "escalation code used as diagnostic",
      fields: { manualReasonCode: "ATTEMPTS_EXHAUSTED", escalation: { code: "ESC_EXHAUSTED" } },
      diagnosticCode: "ESC_EXHAUSTED",
      code: "INVALID_ARGUMENT",
    },
  ];

  for (const entry of cases) {
    const database = createFakeDatabase();
    database.tasks.documents.push(exhaustedLeasedTask());
    await expectWriterError(
      createWriter(database).applyTransition({
        taskId: TASK_ID,
        transitionId: "T-EXHAUST",
        worker: WORKER,
        fields: entry.fields,
        ...(entry.diagnosticCode ? { diagnosticCode: entry.diagnosticCode } : {}),
      }),
      entry.code,
    );
    assert.equal(allWrites(database).length, 0, `${entry.label}: no write`);
    assert.equal(database.tasks.documents[0].status, "LEASED");
    assert.equal(database.tasks.documents[0].escalation ?? null, null);
    assert.equal(database.events.documents.length, 0);
  }
});

test("W12: caller-supplied escalation must carry an approved category", async () => {
  for (const escalation of [{}, { code: null }, { code: "TIMEOUT" }]) {
    const database = createFakeDatabase();
    database.tasks.documents.push(exhaustedLeasedTask());
    await expectWriterError(
      createWriter(database).escalateTask({
        taskId: TASK_ID,
        worker: WORKER,
        escalation,
      }),
      "INVALID_ARGUMENT",
    );
    assert.equal(allWrites(database).length, 0, `${JSON.stringify(escalation)}: no write`);
    assert.equal(database.tasks.documents[0].status, "LEASED");
    assert.equal(database.events.documents.length, 0);
  }

  const database = createFakeDatabase();
  database.tasks.documents.push(exhaustedLeasedTask());
  const result = await createWriter(database).escalateTask({
    taskId: TASK_ID,
    worker: WORKER,
    escalation: { code: "ESC_EVIDENCE_DRIFT" },
    diagnosticCode: "DRIFT_DETECTED",
  });
  assert.equal(result.status, "MANUAL_REQUIRED");
  assert.equal(database.tasks.documents[0].escalation.code, "ESC_EVIDENCE_DRIFT");
  assert.equal(database.events.documents[0].details.diagnosticCode, "DRIFT_DETECTED");
});

test("W5: per-transition field injection is rejected", async () => {
  const cases = [
    { transitionId: "T-RETRY", fields: { nextAttemptAt: NOW, isOpen: false } },
    { transitionId: "T-RETRY", fields: { nextAttemptAt: NOW, closedAt: NOW } },
    { transitionId: "T-EXHAUST", fields: { manualReasonCode: "ATTEMPTS_EXHAUSTED", approvedBy: APPROVER.id } },
    { transitionId: "T-EXHAUST", fields: { manualReasonCode: "ATTEMPTS_EXHAUSTED", verifierId: "v" } },
    { transitionId: "T-APPROVE", fields: { approval: approvalRecord(), isOpen: false } },
    { transitionId: "T-APPROVE", fields: { approval: approvalRecord(), status: "CLOSED" } },
  ];

  for (const entry of cases) {
    const database = createFakeDatabase();
    database.tasks.documents.push(
      entry.transitionId === "T-APPROVE"
        ? manualRequiredTask()
        : exhaustedLeasedTask({ eventSequenceCounter: 4n }),
    );
    const writer = createWriter(database);

    await expectWriterError(
      writer.applyTransition({
        taskId: TASK_ID,
        transitionId: entry.transitionId,
        worker: WORKER,
        actor: APPROVER,
        fields: entry.fields,
      }),
      "INVALID_ARGUMENT",
    );
    assert.equal(database.events.documents.length, 0, `${entry.transitionId}: no event`);
  }
});

test("W5: T-APPROVE only emits RECOVERY_APPROVED for an APPROVED record", async () => {
  const pending = createFakeDatabase();
  pending.tasks.documents.push(manualRequiredTask());
  await expectWriterError(
    createWriter(pending).applyTransition({
      taskId: TASK_ID,
      transitionId: "T-APPROVE",
      actor: APPROVER,
      approval: approvalRecord({ state: "PENDING" }),
      fields: { approval: approvalRecord({ state: "PENDING" }), approvedBy: APPROVER.id },
    }),
    "APPROVAL_REQUIRED",
  );
  assert.equal(pending.events.documents.length, 0);

  const approved = createFakeDatabase();
  approved.tasks.documents.push(manualRequiredTask());
  const result = await createWriter(approved).applyTransition({
    taskId: TASK_ID,
    transitionId: "T-APPROVE",
    actor: APPROVER,
    approval: approvalRecord(),
    fields: { approval: approvalRecord(), approvedBy: APPROVER.id, approvedAt: NOW },
  });

  assert.equal(result.status, "MANUAL_REQUIRED");
  assert.equal(approved.tasks.documents[0].approval.state, "APPROVED");
  assert.equal(approved.events.documents[0].eventType, "RECOVERY_APPROVED");
});

test("W5: T-APPROVE rejects a desynchronized input/fields approval", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(manualRequiredTask());

  await expectWriterError(
    createWriter(database).applyTransition({
      taskId: TASK_ID,
      transitionId: "T-APPROVE",
      actor: APPROVER,
      approval: approvalRecord(),
      fields: { approval: approvalRecord({ state: "PENDING" }) },
    }),
    "APPROVAL_REQUIRED",
  );

  assert.equal(allWrites(database).length, 0, "no write on desynchronized approval");
  assert.equal(database.events.documents.length, 0, "no RECOVERY_APPROVED event");
  assert.equal(database.history.documents.length, 0);
  assert.equal(database.tasks.documents[0].approval, null);
  assert.equal(database.tasks.documents[0].status, "MANUAL_REQUIRED");
  assert.equal(database.tasks.documents[0].eventSequenceCounter, 4n);
});

test("W5: T-APPROVE rejects conflicting approval and flat audit fields", async () => {
  const cases = [
    {
      label: "conflicting approver identities",
      input: {
        approval: approvalRecord(),
        fields: { approval: approvalRecord({ approvedBy: "someone-else" }) },
      },
    },
    {
      label: "conflicting approval notes",
      input: {
        approval: approvalRecord(),
        fields: { approval: approvalRecord({ notes: "different" }) },
      },
    },
    {
      label: "flat approvedBy contradiction",
      input: {
        approval: approvalRecord(),
        fields: { approvedBy: "someone-else" },
      },
    },
    {
      label: "flat approvedAt contradiction",
      input: {
        approval: approvalRecord(),
        fields: { approvedAt: EXPIRED },
      },
    },
  ];

  for (const entry of cases) {
    const database = createFakeDatabase();
    database.tasks.documents.push(manualRequiredTask());

    await expectWriterError(
      createWriter(database).applyTransition({
        taskId: TASK_ID,
        transitionId: "T-APPROVE",
        actor: APPROVER,
        ...entry.input,
      }),
      "APPROVAL_REQUIRED",
    );

    assert.equal(allWrites(database).length, 0, `${entry.label}: no write`);
    assert.equal(database.events.documents.length, 0, `${entry.label}: no event`);
    assert.equal(database.history.documents.length, 0, `${entry.label}: no history`);
    assert.equal(database.tasks.documents[0].approval, null, `${entry.label}: approval unchanged`);
    assert.equal(database.tasks.documents[0].eventSequenceCounter, 4n);
  }
});

test("W5: T-APPROVE persists exactly the validated approval", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(manualRequiredTask());
  const validated = approvalRecord({ notes: "validated", injected: "drop-me" });

  const result = await createWriter(database).applyTransition({
    taskId: TASK_ID,
    transitionId: "T-APPROVE",
    actor: APPROVER,
    approval: validated,
    fields: {
      approval: approvalRecord({ notes: "validated" }),
      approvedBy: APPROVER.id,
      approvedAt: NOW,
    },
  });

  assert.equal(result.status, "MANUAL_REQUIRED");
  const task = database.tasks.documents[0];
  assert.deepEqual(task.approval, {
    state: "APPROVED",
    approvedBy: APPROVER.id,
    approvedAt: NOW,
    operatorRole: APPROVER.role,
    notes: "validated",
  });
  assert.equal("injected" in task.approval, false, "unknown caller keys are not persisted");
  assert.equal(task.approvedBy, APPROVER.id);
  assert.equal(task.approvedAt.getTime(), NOW.getTime());
  assert.equal(database.events.documents[0].eventType, "RECOVERY_APPROVED");
  assert.equal(database.history.documents.length, 0);
});

test("W9: resolveTask is worker-only and rejects APPLIED", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(leasedTask({ eventSequenceCounter: 4n }));
  const writer = createWriter(database);

  await expectWriterError(
    writer.resolveTask({ taskId: TASK_ID, worker: WORKER, actor: OPERATOR }),
    "AUTHORIZATION_MISMATCH",
  );

  await expectWriterError(
    writer.resolveTask({
      taskId: TASK_ID,
      worker: WORKER,
      fields: { resolution: "APPLIED" },
    }),
    "INVALID_ARGUMENT",
  );

  const result = await writer.resolveTask({
    taskId: TASK_ID,
    worker: WORKER,
    fields: { currentFingerprint: FINGERPRINT },
  });

  assert.equal(result.status, "RESOLVED");
  assert.equal(database.tasks.documents[0].resolution, "ALREADY_CORRECT");
  assert.equal(database.events.documents[0].eventType, "RECOVERY_RESOLVED");
});

test("T14: closeTask requires an independent verifier distinct from approver and executor", async () => {
  const fixture = () =>
    baseTask({
      status: "RESOLVED",
      isOpen: true,
      eventSequenceCounter: 4n,
      approvedBy: APPROVER.id,
      executedBy: "executor-1",
      resolution: "ALREADY_CORRECT",
    });

  const missing = createFakeDatabase();
  missing.tasks.documents.push(fixture());
  await expectWriterError(
    createWriter(missing).closeTask({ taskId: TASK_ID }),
    "INVALID_ARGUMENT",
  );

  const wrongType = createFakeDatabase();
  wrongType.tasks.documents.push(fixture());
  await expectWriterError(
    createWriter(wrongType).closeTask({ taskId: TASK_ID, actor: OPERATOR }),
    "AUTHORIZATION_MISMATCH",
  );

  const sameApprover = createFakeDatabase();
  sameApprover.tasks.documents.push(fixture());
  await expectWriterError(
    createWriter(sameApprover).closeTask({
      taskId: TASK_ID,
      actor: { ...VERIFIER, id: APPROVER.id },
    }),
    "AUTHORIZATION_MISMATCH",
  );

  const sameExecutor = createFakeDatabase();
  sameExecutor.tasks.documents.push(fixture());
  await expectWriterError(
    createWriter(sameExecutor).closeTask({
      taskId: TASK_ID,
      actor: { ...VERIFIER, id: "executor-1" },
    }),
    "AUTHORIZATION_MISMATCH",
  );

  const valid = createFakeDatabase();
  valid.tasks.documents.push(fixture());
  const result = await createWriter(valid).closeTask({ taskId: TASK_ID, actor: VERIFIER });

  assert.equal(result.status, "CLOSED");
  assert.equal(valid.tasks.documents[0].isOpen, false);
  assert.equal(valid.tasks.documents[0].verifierId, VERIFIER.id);
  assert.equal(valid.events.documents.length, 1, "T14 emits exactly one event");
  assert.equal(valid.events.documents[0].eventType, "RECOVERY_VERIFIED");
  assert.equal(
    valid.events.documents.some((event) => event.eventType === "RECOVERY_CLOSED"),
    false,
    "T14 never emits RECOVERY_CLOSED",
  );
});

test("T14: verifier separation covers both approver representations and the executor", async () => {
  const fixture = (overrides = {}) =>
    baseTask({
      status: "RESOLVED",
      isOpen: true,
      eventSequenceCounter: 4n,
      resolution: "ALREADY_CORRECT",
      approvedBy: "approver-1",
      executedBy: "executor-1",
      approval: {
        state: "APPROVED",
        approvedBy: "approver-1",
        operatorRole: APPROVER.role,
      },
      ...overrides,
    });

  const cases = [
    {
      label: "nested approver only",
      task: fixture({
        approvedBy: null,
        approval: {
          state: "APPROVED",
          approvedBy: VERIFIER.id,
          operatorRole: VERIFIER.role,
        },
      }),
    },
    { label: "flat approver", task: fixture({ approvedBy: VERIFIER.id, approval: null }) },
    { label: "executor", task: fixture({ executedBy: VERIFIER.id }) },
    {
      label: "conflicting flat and nested approvers",
      task: fixture({
        approvedBy: "approver-1",
        approval: {
          state: "APPROVED",
          approvedBy: "approver-2",
          operatorRole: APPROVER.role,
        },
      }),
    },
  ];

  for (const entry of cases) {
    const database = createFakeDatabase();
    database.tasks.documents.push(entry.task);

    await expectWriterError(
      createWriter(database).closeTask({ taskId: TASK_ID, actor: VERIFIER }),
      "AUTHORIZATION_MISMATCH",
    );

    assert.equal(allWrites(database).length, 0, `${entry.label}: no write`);
    assert.equal(database.events.documents.length, 0, `${entry.label}: no event`);
    assert.equal(database.history.documents.length, 0, `${entry.label}: no history`);
    assert.equal(database.tasks.documents[0].status, "RESOLVED", `${entry.label}: status unchanged`);
    assert.equal(database.tasks.documents[0].isOpen, true, `${entry.label}: still open`);
    assert.equal(database.tasks.documents[0].eventSequenceCounter, 4n);
  }
});

test("T14: a distinct verifier is accepted and server-attributed", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    baseTask({
      status: "RESOLVED",
      isOpen: true,
      eventSequenceCounter: 4n,
      resolution: "ALREADY_CORRECT",
      approvedBy: "approver-1",
      executedBy: "executor-1",
      approval: {
        state: "APPROVED",
        approvedBy: "approver-1",
        operatorRole: APPROVER.role,
      },
    }),
  );

  const result = await createWriter(database).closeTask({ taskId: TASK_ID, actor: VERIFIER });

  assert.equal(result.status, "CLOSED");
  const task = database.tasks.documents[0];
  assert.equal(task.verifierId, VERIFIER.id);
  assert.equal(task.verifiedAt.getTime(), NOW.getTime());
  assert.equal(task.isOpen, false);
  assert.equal(database.events.documents.length, 1, "T14 emits exactly one event");
  assert.equal(database.events.documents[0].eventType, "RECOVERY_VERIFIED");
  assert.equal(
    database.events.documents.some((event) => event.eventType === "RECOVERY_CLOSED"),
    false,
    "T14 never emits RECOVERY_CLOSED",
  );
});

test("T14: caller-supplied verifier fields cannot override server attribution", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    baseTask({
      status: "RESOLVED",
      isOpen: true,
      eventSequenceCounter: 4n,
      resolution: "ALREADY_CORRECT",
      approvedBy: "approver-1",
      executedBy: "executor-1",
      approval: {
        state: "APPROVED",
        approvedBy: "approver-1",
        operatorRole: APPROVER.role,
      },
    }),
  );

  await expectWriterError(
    createWriter(database).closeTask({
      taskId: TASK_ID,
      actor: VERIFIER,
      fields: { verifierId: "attacker", verifiedAt: NOW },
    }),
    "INVALID_ARGUMENT",
  );

  assert.equal(allWrites(database).length, 0);
  assert.equal(database.events.documents.length, 0);
  assert.equal(database.tasks.documents[0].verifierId, undefined);
  assert.equal(database.tasks.documents[0].isOpen, true);
});

test("T12: claimLease requires an explicit authorized OPERATOR distinct from the approver", async () => {
  const approval = {
    state: "APPROVED",
    approvedBy: APPROVER.id,
    approvedAt: NOW,
    operatorRole: OPERATOR.role,
  };

  const workerActor = createFakeDatabase();
  workerActor.tasks.documents.push(
    baseTask({ status: "MANUAL_REQUIRED", eventSequenceCounter: 4n, approval }),
  );
  await expectWriterError(
    createWriter(workerActor).claimLease({
      taskId: TASK_ID,
      fromStatus: "MANUAL_REQUIRED",
      worker: WORKER,
      actor: { id: WORKER.id, role: "SERVICE-WORKER", type: "WORKER" },
    }),
    "AUTHORIZATION_MISMATCH",
  );

  const selfApproval = createFakeDatabase();
  selfApproval.tasks.documents.push(
    baseTask({ status: "MANUAL_REQUIRED", eventSequenceCounter: 4n, approval }),
  );
  await expectWriterError(
    createWriter(selfApproval).claimLease({
      taskId: TASK_ID,
      fromStatus: "MANUAL_REQUIRED",
      worker: WORKER,
      actor: { ...OPERATOR, id: APPROVER.id },
    }),
    "APPROVAL_REQUIRED",
  );
  assert.equal(selfApproval.events.documents.length, 0);
});

test("T12: incomplete or inconsistent approvals fail closed", async () => {
  const completeApproval = () => ({
    state: "APPROVED",
    approvedBy: APPROVER.id,
    approvedAt: NOW,
    operatorRole: OPERATOR.role,
  });

  const cases = [
    {
      label: "missing operatorRole",
      approval: (() => {
        const approval = completeApproval();
        delete approval.operatorRole;
        return approval;
      })(),
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "null operatorRole",
      approval: { ...completeApproval(), operatorRole: null },
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "missing approvedAt",
      approval: (() => {
        const approval = completeApproval();
        delete approval.approvedAt;
        return approval;
      })(),
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "null approvedAt",
      approval: { ...completeApproval(), approvedAt: null },
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "invalid approvedAt",
      approval: { ...completeApproval(), approvedAt: "2026-11-12" },
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "unauthorized approval role",
      approval: { ...completeApproval(), operatorRole: "ROLE-NOT-REAL" },
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "actor role differs from approval role",
      approval: completeApproval(),
      actor: { ...OPERATOR, role: "ROLE-TECHNICAL-LEAD" },
      code: "AUTHORIZATION_MISMATCH",
    },
    {
      label: "approver is the executor",
      approval: completeApproval(),
      actor: { ...OPERATOR, id: APPROVER.id },
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "flat and nested approvers contradict",
      approval: completeApproval(),
      approvedBy: "other-approver",
      code: "APPROVAL_REQUIRED",
    },
  ];

  for (const entry of cases) {
    const database = createFakeDatabase();
    database.tasks.documents.push(
      manualRequiredTask({
        approval: entry.approval,
        ...(entry.approvedBy ? { approvedBy: entry.approvedBy } : {}),
      }),
    );

    await expectWriterError(
      createWriter(database).claimLease({
        taskId: TASK_ID,
        fromStatus: "MANUAL_REQUIRED",
        worker: WORKER,
        actor: entry.actor ?? OPERATOR,
      }),
      entry.code,
    );

    assert.equal(allWrites(database).length, 0, `${entry.label}: no write`);
    assert.equal(database.events.documents.length, 0, `${entry.label}: no event`);
    assert.equal(database.history.documents.length, 0, `${entry.label}: no history`);
    assert.equal(
      database.tasks.documents[0].status,
      "MANUAL_REQUIRED",
      `${entry.label}: status unchanged`,
    );
    assert.equal(database.tasks.documents[0].eventSequenceCounter, 4n);
    assert.equal(database.tasks.documents[0].executedBy, "executor-1");
  }
});

test("T12: a complete approval permits an authorized distinct operator", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    manualRequiredTask({
      approval: {
        state: "APPROVED",
        approvedBy: APPROVER.id,
        approvedAt: NOW,
        operatorRole: OPERATOR.role,
      },
    }),
  );

  const result = await createWriter(database).claimLease({
    taskId: TASK_ID,
    fromStatus: "MANUAL_REQUIRED",
    worker: WORKER,
    actor: OPERATOR,
  });

  assert.equal(result.status, "LEASED");
  const task = database.tasks.documents[0];
  assert.equal(task.status, "LEASED");
  assert.equal(task.executedBy, OPERATOR.id);
  assert.equal(task.executedAt.getTime(), NOW.getTime());
  assert.equal(task.attempts, 6, "T12 remains exempt from G_ATTEMPTS");
  assert.equal(task.approval.state, "APPROVED");
  assert.equal(database.events.documents[0].eventType, "RECOVERY_LEASED");
});

test("approval persists through T12, T5, T14 and cancellation", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    manualRequiredTask({
      approval: {
        state: "APPROVED",
        approvedBy: APPROVER.id,
        approvedAt: NOW,
        operatorRole: OPERATOR.role,
      },
      approvedBy: APPROVER.id,
      approvedAt: NOW,
    }),
  );
  const writer = createWriter(database);

  await writer.claimLease({
    taskId: TASK_ID,
    fromStatus: "MANUAL_REQUIRED",
    worker: WORKER,
    actor: OPERATOR,
  });
  assert.equal(database.tasks.documents[0].approval.state, "APPROVED");
  assert.equal(database.tasks.documents[0].approvedBy, APPROVER.id);

  await writer.resolveTask({
    taskId: TASK_ID,
    worker: WORKER,
    fields: { currentFingerprint: FINGERPRINT },
  });
  assert.equal(database.tasks.documents[0].approval.state, "APPROVED");
  assert.equal(database.tasks.documents[0].approvedBy, APPROVER.id);

  await writer.closeTask({ taskId: TASK_ID, actor: VERIFIER });
  assert.equal(database.tasks.documents[0].status, "CLOSED");
  assert.equal(database.tasks.documents[0].approval.state, "APPROVED");
  assert.equal(database.tasks.documents[0].approvedBy, APPROVER.id);
  assert.equal(database.tasks.documents[0].approvedAt.getTime(), NOW.getTime());

  const cancelled = createFakeDatabase();
  cancelled.tasks.documents.push(
    manualRequiredTask({
      approval: {
        state: "REJECTED",
        approvedBy: APPROVER.id,
        approvedAt: NOW,
        operatorRole: OPERATOR.role,
      },
      approvedBy: APPROVER.id,
      approvedAt: NOW,
    }),
  );
  await createWriter(cancelled).cancelTask({ taskId: TASK_ID, actor: OPERATOR });
  assert.equal(cancelled.tasks.documents[0].status, "CANCELLED");
  assert.equal(cancelled.tasks.documents[0].approval.state, "REJECTED");
  assert.equal(cancelled.tasks.documents[0].approvedBy, APPROVER.id);
});

test("W3: renewLease rejects a non-worker actor", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(leasedTask({ eventSequenceCounter: 4n }));
  await expectWriterError(
    createWriter(database).renewLease({
      taskId: TASK_ID,
      worker: WORKER,
      actor: OPERATOR,
    }),
    "AUTHORIZATION_MISMATCH",
  );
  assert.equal(database.events.documents.length, 0);
});

test("W8: abandonment fails closed on missing lease expiry and identity mismatch", async () => {
  const noExpiry = abandonmentFixture({ leaseUntil: null });
  await expectWriterError(
    createWriter(noExpiry).abandonOperation({
      taskId: TASK_ID,
      operation: ABANDON_OPERATION,
      authorization: authorization(),
    }),
    "OPERATION_MISMATCH",
  );
  assert.equal(noExpiry.events.documents.length, 0);

  const actorMismatch = abandonmentFixture();
  await expectWriterError(
    createWriter(actorMismatch).abandonOperation({
      taskId: TASK_ID,
      operation: ABANDON_OPERATION,
      authorization: authorization(),
      actor: { id: "someone-else", role: "ROLE-INVENTORY-MANAGER", type: "OPERATOR" },
    }),
    "AUTHORIZATION_MISMATCH",
  );
  assert.equal(actorMismatch.events.documents.length, 0);

  const badRole = abandonmentFixture();
  await expectWriterError(
    createWriter(badRole).abandonOperation({
      taskId: TASK_ID,
      operation: ABANDON_OPERATION,
      authorization: authorization({ operatorRole: "ROLE-NOT-REAL" }),
    }),
    "AUTHORIZATION_MISMATCH",
  );
  assert.equal(badRole.events.documents.length, 0);
});

test("W10: cancellation requires the dedicated operator/worker identity", async () => {
  const noActor = createFakeDatabase();
  noActor.tasks.documents.push(baseTask({ eventSequenceCounter: 4n }));
  await expectWriterError(
    createWriter(noActor).cancelTask({ taskId: TASK_ID }),
    "INVALID_ARGUMENT",
  );

  const operatorCancel = createFakeDatabase();
  operatorCancel.tasks.documents.push(baseTask({ eventSequenceCounter: 4n }));
  const result = await createWriter(operatorCancel).cancelTask({
    taskId: TASK_ID,
    actor: OPERATOR,
  });
  assert.equal(result.status, "CANCELLED");
  assert.equal(operatorCancel.tasks.documents[0].isOpen, false);
  assert.equal(operatorCancel.tasks.documents[0].resolution, "CANCELLED");
  assert.equal(operatorCancel.events.documents[0].eventType, "RECOVERY_CANCELLED");

  const leasedCancel = createFakeDatabase();
  leasedCancel.tasks.documents.push(leasedTask({ eventSequenceCounter: 4n }));
  const leasedResult = await createWriter(leasedCancel).cancelTask({
    taskId: TASK_ID,
    worker: WORKER,
  });
  assert.equal(leasedResult.status, "CANCELLED");
});

// -----------------------------------------------------------------------------
// F. Abandonment fencing (OD-37)
// -----------------------------------------------------------------------------

function abandonmentFixture(overrides = {}) {
  const database = createFakeDatabase();
  database.tasks.documents.push(
    leasedTask({
      eventSequenceCounter: 4n,
      leaseUntil: EXPIRED,
      pendingOperation: reservedOperation(),
      ...overrides,
    }),
  );
  return database;
}

const ABANDON_OPERATION = Object.freeze({
  operationId: "op-1",
  leaseGeneration: 1n,
  sequenceNumber: 3n,
  eventId: `EVT:${TASK_ID}:3`,
});

function authorization(overrides = {}) {
  return {
    id: "auth-1",
    operationId: "op-1",
    operatorId: "operator-1",
    operatorRole: "ROLE-INVENTORY-MANAGER",
    ...overrides,
  };
}

test("W8: ESC_UNKNOWN_COMMIT belongs only to the separately authorized abandonment transition", async () => {
  // Owner decision (2026-11-14): ESC_UNKNOWN_COMMIT is retained only because
  // W8 is a separately authorized transition, not an observation-only path.
  // It is an allowlisted entry point that requires an explicit operator
  // authorization, mutates the task, and emits one event plus one history row.
  assert.deepEqual(
    WRITER_ENTRY_POINTS.filter((entry) => entry.id === "W8").map((entry) => entry.methods),
    [["abandonOperation"]],
  );

  const unauthorized = abandonmentFixture();
  await expectWriterError(
    createWriter(unauthorized).abandonOperation({
      taskId: TASK_ID,
      operation: ABANDON_OPERATION,
    }),
    "INVALID_ARGUMENT",
  );
  assert.equal(allWrites(unauthorized).length, 0, "missing authorization: no write");
  assert.equal(unauthorized.events.documents.length, 0, "missing authorization: no event");

  const wrongOperation = abandonmentFixture();
  await expectWriterError(
    createWriter(wrongOperation).abandonOperation({
      taskId: TASK_ID,
      operation: ABANDON_OPERATION,
      authorization: authorization({ operationId: "op-other" }),
    }),
    "AUTHORIZATION_MISMATCH",
  );
  assert.equal(allWrites(wrongOperation).length, 0, "wrong operation: no write");
  assert.equal(wrongOperation.events.documents.length, 0, "wrong operation: no event");

  const settled = abandonmentFixture();
  const result = await createWriter(settled).abandonOperation({
    taskId: TASK_ID,
    operation: ABANDON_OPERATION,
    authorization: authorization(),
  });

  assert.equal(result.status, "MANUAL_REQUIRED");
  const task = settled.tasks.documents[0];
  assert.equal(task.status, "MANUAL_REQUIRED");
  assert.equal(task.escalation.code, "ESC_UNKNOWN_COMMIT");
  assert.equal(task.pendingOperation.state, "ABANDONED");
  assert.equal(settled.events.documents.length, 1, "exactly one transition event");
  assert.equal(settled.events.documents[0].eventType, "RECOVERY_ESCALATED");
  assert.equal(settled.events.documents[0].details.diagnosticCode, null);
  assert.equal(settled.history.documents.length, 1, "one history record");
  assert.equal(settled.history.documents[0].state, "ABANDONED");
  assert.equal(sessionIds(settled).size, 1);
});

test("OD-37: abandonment settles atomically with approved audit wording", async () => {
  const database = abandonmentFixture();
  const writer = createWriter(database);

  const result = await writer.abandonOperation({
    taskId: TASK_ID,
    operation: ABANDON_OPERATION,
    authorization: authorization(),
    manualReasonCode: "AMBIGUOUS_COMMIT",
  });

  assert.equal(result.status, "MANUAL_REQUIRED");
  assert.equal(result.sequenceNumber, 5n);

  const task = database.tasks.documents[0];
  assert.equal(task.status, "MANUAL_REQUIRED");
  assert.equal(task.manualReasonCode, "AMBIGUOUS_COMMIT");
  assert.equal(task.pendingOperation.state, "ABANDONED");
  assert.equal(task.pendingOperation.settlement.basis, "OPERATOR_DECISION_AFTER_HOLD");
  assert.equal(task.pendingOperation.settlement.operationId, "op-1");

  const event = database.events.documents[0];
  assert.equal(event.eventType, "RECOVERY_ESCALATED");
  assert.equal(task.escalation.code, "ESC_UNKNOWN_COMMIT");
  assert.equal(event.details.diagnosticCode, null, "escalation codes are not diagnostics");
  assert.equal(event.sequenceNumber, 5n);

  const history = database.history.documents[0];
  assert.equal(history.state, "ABANDONED");
  assert.equal(history.basis, "OPERATOR_DECISION_AFTER_HOLD");
  assert.equal(history.manualReasonCode, "AMBIGUOUS_COMMIT");
  assert.equal(history.sequenceNumber, 3n, "history keeps the reserved identity");
  assert.equal(history.settledAt.getTime(), NOW.getTime());

  assert.deepEqual([...OPERATION_SETTLEMENT_BASES], ["OPERATOR_DECISION_AFTER_HOLD"]);
  assert.equal(sessionIds(database).size, 1);
});

test("OD-37: a live original lease zero-matches the CAS and aborts", async () => {
  const database = abandonmentFixture({ leaseUntil: LIVE });
  const writer = createWriter(database);

  await expectWriterError(
    writer.abandonOperation({
      taskId: TASK_ID,
      operation: ABANDON_OPERATION,
      authorization: authorization(),
    }),
    "CAS_MISMATCH",
  );
  assert.equal(database.tasks.documents[0].pendingOperation.state, "PREPARED");
  assert.equal(database.events.documents.length, 0);
  assert.equal(database.history.documents.length, 0);
  assert.equal(database.sessions[0].aborted, true);
});

test("OD-37: the transient handle token must match the original lease token", async () => {
  const database = abandonmentFixture();
  const writer = createWriter(database);

  await expectWriterError(
    writer.abandonOperation({
      taskId: TASK_ID,
      operation: {
        ...ABANDON_OPERATION,
        leaseToken: "11111111-1111-4111-8111-111111111111",
      },
      authorization: authorization(),
    }),
    "OPERATION_MISMATCH",
  );

  assert.equal(database.tasks.documents[0].status, "LEASED");
  assert.equal(database.tasks.documents[0].pendingOperation.state, "PREPARED");
  assert.equal(database.events.documents.length, 0);
});

test("OD-37: matching original lease identity is accepted when server time says expired", async () => {
  const database = abandonmentFixture();
  const writer = createWriter(database);

  const result = await writer.abandonOperation({
    taskId: TASK_ID,
    operation: { ...ABANDON_OPERATION, leaseToken: WORKER.token },
    authorization: authorization(),
  });

  assert.equal(result.status, "MANUAL_REQUIRED");
  assert.equal(database.tasks.documents[0].pendingOperation.state, "ABANDONED");
  assert.equal(database.history.documents[0].state, "ABANDONED");
});

test("OD-37: worker-clock skew cannot override the server-time CAS", async () => {
  // Worker believes the lease is expired, but the server still sees it live.
  const liveDatabase = abandonmentFixture({ leaseUntil: LIVE });
  const liveWriter = createWriter(liveDatabase, {
    clock: () => new Date(LIVE.getTime() + 120_000),
  });

  await expectWriterError(
    liveWriter.abandonOperation({
      taskId: TASK_ID,
      operation: ABANDON_OPERATION,
      authorization: authorization(),
    }),
    "CAS_MISMATCH",
  );
  assert.equal(liveDatabase.tasks.documents[0].pendingOperation.state, "PREPARED");
  assert.equal(liveDatabase.events.documents.length, 0);

  // Worker believes the lease is live, but the server sees it expired.
  const expiredDatabase = abandonmentFixture({ leaseUntil: EXPIRED });
  const expiredWriter = createWriter(expiredDatabase, {
    clock: () => new Date(EXPIRED.getTime() - 120_000),
  });

  const result = await expiredWriter.abandonOperation({
    taskId: TASK_ID,
    operation: ABANDON_OPERATION,
    authorization: authorization(),
  });
  assert.equal(result.status, "MANUAL_REQUIRED");
  assert.equal(expiredDatabase.tasks.documents[0].pendingOperation.state, "ABANDONED");
  assert.equal(expiredDatabase.history.documents.length, 1);
});

test("OD-37: abandonment is bound to the exact operation and source status", async () => {
  const database = abandonmentFixture();
  const writer = createWriter(database);

  await expectWriterError(
    writer.abandonOperation({
      taskId: TASK_ID,
      operation: ABANDON_OPERATION,
      authorization: authorization({ operationId: "op-2" }),
    }),
    "AUTHORIZATION_MISMATCH",
  );

  await expectWriterError(
    writer.abandonOperation({
      taskId: TASK_ID,
      operation: { ...ABANDON_OPERATION, sequenceNumber: 2n },
      authorization: authorization(),
    }),
    "OPERATION_MISMATCH",
  );

  await expectWriterError(
    writer.abandonOperation({
      taskId: TASK_ID,
      operation: { ...ABANDON_OPERATION, eventId: `EVT:${TASK_ID}:2` },
      authorization: authorization(),
    }),
    "OPERATION_MISMATCH",
  );

  assert.equal(database.events.documents.length, 0);
  assert.equal(database.tasks.documents[0].status, "LEASED");
});

test("OD-37: only LEASED is abandonable", async () => {
  const database = abandonmentFixture({ status: "MANUAL_REQUIRED" });
  const writer = createWriter(database);

  await expectWriterError(
    writer.abandonOperation({
      taskId: TASK_ID,
      operation: ABANDON_OPERATION,
      authorization: authorization(),
    }),
    "ABANDONMENT_NOT_PERMITTED",
  );
  assert.deepEqual([...ABANDONABLE_STATUSES], ["LEASED"]);
});

test("OD-37: ABORT_CONFIRMED wording is rejected", async () => {
  const database = abandonmentFixture();
  const writer = createWriter(database);

  await expectWriterError(
    writer.abandonOperation({
      taskId: TASK_ID,
      operation: ABANDON_OPERATION,
      authorization: authorization({ basis: "ABORT_CONFIRMED" }),
    }),
    "INVALID_ARGUMENT",
  );
  assert.equal(database.events.documents.length, 0);
});

// -----------------------------------------------------------------------------
// F2. W11 approval separation of duties / W12 escalation
// -----------------------------------------------------------------------------

const APPROVER = Object.freeze({
  id: "approver-1",
  role: "ROLE-INVENTORY-MANAGER",
  type: "OPERATOR",
});

function approvalRecord(overrides = {}) {
  return {
    state: "APPROVED",
    approvedBy: APPROVER.id,
    approvedAt: NOW,
    operatorRole: APPROVER.role,
    notes: "reviewed",
    ...overrides,
  };
}

function manualRequiredTask(overrides = {}) {
  return baseTask({
    status: "MANUAL_REQUIRED",
    attempts: 5,
    eventSequenceCounter: 4n,
    executedBy: "executor-1",
    verifierId: "verifier-1",
    approval: null,
    ...overrides,
  });
}

test("W11: an authorized operator records approval in one transaction", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(manualRequiredTask());
  const writer = createWriter(database);

  const result = await writer.recordApproval({
    taskId: TASK_ID,
    actor: APPROVER,
    approval: approvalRecord(),
  });

  assert.equal(result.status, "MANUAL_REQUIRED");
  assert.equal(result.sequenceNumber, 5n);
  assert.equal(result.eventId, `EVT:${TASK_ID}:5`);

  const task = database.tasks.documents[0];
  assert.equal(task.status, "MANUAL_REQUIRED");
  assert.equal(task.isOpen, true);
  assert.equal(task.approval.state, "APPROVED");
  assert.equal(task.approval.approvedBy, APPROVER.id);
  assert.equal(task.approval.operatorRole, APPROVER.role);
  assert.equal(task.approvedBy, APPROVER.id);
  assert.equal(task.approvedAt.getTime(), NOW.getTime());
  assert.equal(task.eventSequenceCounter, 5n);

  const event = database.events.documents[0];
  assert.equal(event.eventType, "RECOVERY_APPROVED");
  assert.equal(event.sequenceNumber, 5n);
  assert.equal(event.eventId, `EVT:${TASK_ID}:5`);
  assert.equal(event.actorId, APPROVER.id);
  assert.equal(event.actorRole, APPROVER.role);
  assert.equal(event.actorType, "OPERATOR");
  assert.equal(event.details.fromStatus, "MANUAL_REQUIRED");
  assert.equal(event.details.toStatus, "MANUAL_REQUIRED");

  assert.equal(sessionIds(database).size, 1, "task and event share one session");
  assert.equal(database.sessions[0].ended, true);
});

test("W11: invalid state, actor, role, approval and separation are rejected", async () => {
  const cases = [
    {
      label: "invalid state",
      task: manualRequiredTask({ status: "LEASED" }),
      actor: APPROVER,
      approval: approvalRecord(),
      code: "TRANSITION_NOT_ALLOWED",
    },
    {
      label: "non-operator actor",
      task: manualRequiredTask(),
      actor: { ...APPROVER, type: "WORKER" },
      approval: approvalRecord(),
      code: "AUTHORIZATION_MISMATCH",
    },
    {
      label: "role mismatch",
      task: manualRequiredTask(),
      actor: { ...APPROVER, role: "ROLE-DATA-OWNER" },
      approval: approvalRecord(),
      code: "AUTHORIZATION_MISMATCH",
    },
    {
      label: "approver is the executor",
      task: manualRequiredTask({ executedBy: APPROVER.id }),
      actor: APPROVER,
      approval: approvalRecord(),
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "approver is the verifier",
      task: manualRequiredTask({ verifierId: APPROVER.id }),
      actor: APPROVER,
      approval: approvalRecord(),
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "approval not approved",
      task: manualRequiredTask(),
      actor: APPROVER,
      approval: approvalRecord({ state: "PENDING" }),
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "approver identity mismatch",
      task: manualRequiredTask(),
      actor: APPROVER,
      approval: approvalRecord({ approvedBy: "someone-else" }),
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "unresolved PREPARED operation",
      task: manualRequiredTask({ pendingOperation: reservedOperation() }),
      actor: APPROVER,
      approval: approvalRecord(),
      code: "UNRESOLVED_OUTCOME",
    },
  ];

  for (const entry of cases) {
    const database = createFakeDatabase();
    database.tasks.documents.push(entry.task);
    const writer = createWriter(database);

    await expectWriterError(
      writer.recordApproval({
        taskId: TASK_ID,
        actor: entry.actor,
        approval: entry.approval,
      }),
      entry.code,
    );

    assert.equal(database.events.documents.length, 0, `${entry.label}: no event`);
    assert.equal(database.tasks.documents[0].approval, null, `${entry.label}: approval unchanged`);
    assert.equal(database.tasks.documents[0].eventSequenceCounter, 4n, `${entry.label}: counter unchanged`);
  }
});

test("W11: a zero-match CAS aborts with no partial write", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(manualRequiredTask());
  const writer = createWriter(database);
  database.tasks.forceMatchedCount = 0;

  await expectWriterError(
    writer.recordApproval({
      taskId: TASK_ID,
      actor: APPROVER,
      approval: approvalRecord(),
    }),
    "CAS_MISMATCH",
  );

  assert.equal(database.events.documents.length, 0);
  assert.equal(database.tasks.documents[0].approval, null);
  assert.equal(database.tasks.documents[0].eventSequenceCounter, 4n);
  assert.equal(database.sessions[0].aborted, true);
});

test("W11: event failure rolls back the approval write", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(manualRequiredTask());
  database.events.failInsertWith = new Error("event store unavailable");
  const writer = createWriter(database);

  await assert.rejects(
    writer.recordApproval({
      taskId: TASK_ID,
      actor: APPROVER,
      approval: approvalRecord(),
    }),
    /event store unavailable/,
  );

  assert.equal(database.tasks.documents[0].approval, null);
  assert.equal(database.tasks.documents[0].approvedBy ?? null, null);
  assert.equal(database.tasks.documents[0].eventSequenceCounter, 4n);
  assert.equal(database.events.documents.length, 0);
  assert.equal(database.sessions[0].aborted, true);
});

test("W11: an authorized operator records rejection in one transaction", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(manualRequiredTask());
  const writer = createWriter(database);

  const result = await writer.recordRejection({
    taskId: TASK_ID,
    actor: APPROVER,
    approval: approvalRecord({ state: "REJECTED", notes: "not safe to proceed" }),
  });

  assert.equal(result.status, "MANUAL_REQUIRED");
  assert.equal(result.sequenceNumber, 5n);
  assert.equal(result.eventId, `EVT:${TASK_ID}:5`);

  const task = database.tasks.documents[0];
  assert.equal(task.status, "MANUAL_REQUIRED");
  assert.equal(task.isOpen, true);
  assert.equal(task.approval.state, "REJECTED");
  assert.equal(task.approval.approvedBy, APPROVER.id);
  assert.equal(task.approval.operatorRole, APPROVER.role);
  assert.equal(task.approval.notes, "not safe to proceed");
  assert.equal(task.approvedBy, APPROVER.id);
  assert.equal(task.approvedAt.getTime(), NOW.getTime());
  assert.equal(task.eventSequenceCounter, 5n);

  assert.equal(database.events.documents.length, 1, "exactly one rejection event");
  const event = database.events.documents[0];
  assert.equal(event.eventType, "RECOVERY_REJECTED");
  assert.equal(event.sequenceNumber, 5n);
  assert.equal(event.eventId, `EVT:${TASK_ID}:5`);
  assert.equal(event.actorId, APPROVER.id);
  assert.equal(event.actorRole, APPROVER.role);
  assert.equal(event.actorType, "OPERATOR");
  assert.equal(event.details.fromStatus, "MANUAL_REQUIRED");
  assert.equal(event.details.toStatus, "MANUAL_REQUIRED");

  assert.equal(sessionIds(database).size, 1, "task and event share one session");
  assert.equal(database.sessions[0].ended, true);
});

test("W11: invalid rejection state, actor, role, record and separation are rejected", async () => {
  const cases = [
    {
      label: "invalid state",
      task: manualRequiredTask({ status: "LEASED" }),
      actor: APPROVER,
      approval: approvalRecord({ state: "REJECTED" }),
      code: "TRANSITION_NOT_ALLOWED",
    },
    {
      label: "non-operator actor",
      task: manualRequiredTask(),
      actor: { ...APPROVER, type: "WORKER" },
      approval: approvalRecord({ state: "REJECTED" }),
      code: "AUTHORIZATION_MISMATCH",
    },
    {
      label: "role mismatch",
      task: manualRequiredTask(),
      actor: { ...APPROVER, role: "ROLE-DATA-OWNER" },
      approval: approvalRecord({ state: "REJECTED" }),
      code: "AUTHORIZATION_MISMATCH",
    },
    {
      label: "approver is the executor",
      task: manualRequiredTask({ executedBy: APPROVER.id }),
      actor: APPROVER,
      approval: approvalRecord({ state: "REJECTED" }),
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "approver is the verifier",
      task: manualRequiredTask({ verifierId: APPROVER.id }),
      actor: APPROVER,
      approval: approvalRecord({ state: "REJECTED" }),
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "record is approved, not rejected",
      task: manualRequiredTask(),
      actor: APPROVER,
      approval: approvalRecord({ state: "APPROVED" }),
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "record is pending, not rejected",
      task: manualRequiredTask(),
      actor: APPROVER,
      approval: approvalRecord({ state: "PENDING" }),
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "approver identity mismatch",
      task: manualRequiredTask(),
      actor: APPROVER,
      approval: approvalRecord({ state: "REJECTED", approvedBy: "someone-else" }),
      code: "APPROVAL_REQUIRED",
    },
    {
      label: "unresolved PREPARED operation",
      task: manualRequiredTask({ pendingOperation: reservedOperation() }),
      actor: APPROVER,
      approval: approvalRecord({ state: "REJECTED" }),
      code: "UNRESOLVED_OUTCOME",
    },
  ];

  for (const entry of cases) {
    const database = createFakeDatabase();
    database.tasks.documents.push(entry.task);
    const writer = createWriter(database);

    await expectWriterError(
      writer.recordRejection({
        taskId: TASK_ID,
        actor: entry.actor,
        approval: entry.approval,
      }),
      entry.code,
    );

    assert.equal(allWrites(database).length, 0, `${entry.label}: no write`);
    assert.equal(database.events.documents.length, 0, `${entry.label}: no event`);
    assert.equal(database.history.documents.length, 0, `${entry.label}: no history`);
    assert.equal(database.tasks.documents[0].approval, null, `${entry.label}: approval unchanged`);
    assert.equal(database.tasks.documents[0].eventSequenceCounter, 4n);
  }
});

test("W11: rejection CAS, event failure and terminal decisions fail without partial writes", async () => {
  const zeroMatch = createFakeDatabase();
  zeroMatch.tasks.documents.push(manualRequiredTask());
  zeroMatch.tasks.forceMatchedCount = 0;
  await expectWriterError(
    createWriter(zeroMatch).recordRejection({
      taskId: TASK_ID,
      actor: APPROVER,
      approval: approvalRecord({ state: "REJECTED" }),
    }),
    "CAS_MISMATCH",
  );
  assert.equal(zeroMatch.events.documents.length, 0);
  assert.equal(zeroMatch.tasks.documents[0].approval, null);
  assert.equal(zeroMatch.sessions[0].aborted, true);

  const rollback = createFakeDatabase();
  rollback.tasks.documents.push(manualRequiredTask());
  rollback.events.failInsertWith = new Error("event store unavailable");
  await assert.rejects(
    createWriter(rollback).recordRejection({
      taskId: TASK_ID,
      actor: APPROVER,
      approval: approvalRecord({ state: "REJECTED" }),
    }),
    /event store unavailable/,
  );
  assert.equal(rollback.tasks.documents[0].approval, null);
  assert.equal(rollback.tasks.documents[0].approvedBy ?? null, null);
  assert.equal(rollback.tasks.documents[0].eventSequenceCounter, 4n);
  assert.equal(rollback.events.documents.length, 0);
  assert.equal(rollback.sessions[0].aborted, true);

  // A terminal decision is immutable: neither re-approval nor re-rejection is
  // reachable once APPROVED or REJECTED has been recorded.
  for (const state of ["APPROVED", "REJECTED"]) {
    const database = createFakeDatabase();
    database.tasks.documents.push(
      manualRequiredTask({
        approval: approvalRecord({ state }),
        approvedBy: APPROVER.id,
        approvedAt: NOW,
      }),
    );
    const writer = createWriter(database);

    await expectWriterError(
      writer.recordApproval({
        taskId: TASK_ID,
        actor: APPROVER,
        approval: approvalRecord(),
      }),
      "CAS_MISMATCH",
    );
    await expectWriterError(
      writer.recordRejection({
        taskId: TASK_ID,
        actor: APPROVER,
        approval: approvalRecord({ state: "REJECTED" }),
      }),
      "CAS_MISMATCH",
    );

    assert.equal(database.events.documents.length, 0, `${state}: no event`);
    assert.equal(database.history.documents.length, 0, `${state}: no history`);
    assert.equal(database.tasks.documents[0].approval.state, state);
    assert.equal(database.tasks.documents[0].eventSequenceCounter, 4n);
    assert.equal(database.sessions.at(-1).aborted, true, `${state}: failed CAS aborts`);
  }
});

function exhaustedLeasedTask(overrides = {}) {
  return leasedTask({
    attempts: 5,
    maxAttempts: 5,
    eventSequenceCounter: 4n,
    ...overrides,
  });
}

test("W12: escalation records the terminal exhaustion in one transaction", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(exhaustedLeasedTask());
  const writer = createWriter(database);

  const result = await writer.escalateTask({ taskId: TASK_ID, worker: WORKER });

  assert.equal(result.status, "MANUAL_REQUIRED");
  assert.equal(result.sequenceNumber, 5n);

  const task = database.tasks.documents[0];
  assert.equal(task.status, "MANUAL_REQUIRED");
  assert.equal(task.isOpen, true);
  assert.equal(task.manualReasonCode, "ATTEMPTS_EXHAUSTED");
  assert.deepEqual(task.escalation, { code: "ESC_EXHAUSTED" });
  assert.equal(task.eventSequenceCounter, 5n);

  const event = database.events.documents[0];
  assert.equal(event.eventType, "RECOVERY_ESCALATED");
  assert.equal(event.sequenceNumber, 5n);
  assert.equal(event.eventId, `EVT:${TASK_ID}:5`);
  assert.equal(event.actorId, WORKER.id);
  assert.equal(event.actorType, "WORKER");
  assert.equal(event.details.diagnosticCode, null, "escalation codes are not diagnostics");
  assert.equal(event.details.fromStatus, "LEASED");
  assert.equal(event.details.toStatus, "MANUAL_REQUIRED");
  assert.equal(event.fencingToken, WORKER.token);

  assert.equal(sessionIds(database).size, 1);
});

test("W12: attempts, lease identity and PREPARED operations are enforced", async () => {
  const cases = [
    {
      label: "attempts not exhausted",
      task: exhaustedLeasedTask({ attempts: 4 }),
      code: "CAS_MISMATCH",
    },
    {
      label: "stale lease token",
      task: exhaustedLeasedTask(),
      worker: { ...WORKER, token: "11111111-1111-4111-8111-111111111111" },
      code: "CAS_MISMATCH",
    },
    {
      label: "live lease is not a rejection reason but wrong owner is",
      task: exhaustedLeasedTask({ leaseOwner: "worker-2" }),
      code: "CAS_MISMATCH",
    },
    {
      label: "unresolved PREPARED operation",
      task: exhaustedLeasedTask({ pendingOperation: reservedOperation() }),
      code: "UNRESOLVED_OUTCOME",
    },
  ];

  for (const entry of cases) {
    const database = createFakeDatabase();
    database.tasks.documents.push(entry.task);
    const writer = createWriter(database);

    await expectWriterError(
      writer.escalateTask({
        taskId: TASK_ID,
        worker: entry.worker ?? WORKER,
      }),
      entry.code,
    );

    assert.equal(database.events.documents.length, 0, `${entry.label}: no event`);
    assert.equal(database.tasks.documents[0].status, "LEASED", `${entry.label}: status unchanged`);
  }
});

test("W12: event failure rolls back the escalation write", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(exhaustedLeasedTask());
  database.events.failInsertWith = new Error("event store unavailable");
  const writer = createWriter(database);

  await assert.rejects(
    writer.escalateTask({ taskId: TASK_ID, worker: WORKER }),
    /event store unavailable/,
  );

  assert.equal(database.tasks.documents[0].status, "LEASED");
  assert.equal(database.tasks.documents[0].manualReasonCode ?? null, null);
  assert.equal(database.tasks.documents[0].eventSequenceCounter, 4n);
  assert.equal(database.events.documents.length, 0);
  assert.equal(database.sessions[0].aborted, true);
});

// -----------------------------------------------------------------------------
// G. Read-only reconciliation (OD-32 / OD-33)
// -----------------------------------------------------------------------------

function historyRecord(overrides = {}) {
  return {
    historyId: buildOperationHistoryId(TASK_ID, "op-1"),
    taskId: TASK_ID,
    operationId: "op-1",
    state: "COMMITTED",
    leaseGeneration: 1n,
    sequenceNumber: 3n,
    eventId: `EVT:${TASK_ID}:3`,
    reservedAt: NOW,
    reservedBy: WORKER.id,
    settledAt: NOW,
    intentDigest: "b".repeat(64),
    settlement: null,
    manualReasonCode: null,
    basis: null,
    ...overrides,
  };
}

test("OD-33: an identical duplicate is adopted without a write", () => {
  const expected = historyRecord();
  const existing = historyRecord();

  assert.deepEqual(compareHistoryRecords(expected, existing), {
    identical: true,
    mismatchedFields: [],
  });

  const classification = classifyHistoryDuplicate({ expected, existing });
  assert.equal(classification.classification, "IDENTICAL_ADOPT");
  assert.equal(classification.action, "ADOPT_EXISTING");
  assert.equal(classification.adoptable, true);
  assert.equal(classification.requiresEscalation, false);
});

test("OD-33: a divergent duplicate stops and never overwrites", () => {
  const expected = historyRecord();
  const existing = historyRecord({ sequenceNumber: 9n });

  const classification = classifyHistoryDuplicate({ expected, existing });
  assert.equal(classification.classification, "DIVERGENT");
  assert.equal(classification.action, "STOP_AND_ESCALATE");
  assert.equal(classification.requiresEscalation, true);
  assert.deepEqual(classification.mismatchedFields, ["sequenceNumber"]);
});

test("OD-33: a task showing a different operation is contradictory", () => {
  const classification = classifyHistoryDuplicate({
    expected: historyRecord(),
    existing: historyRecord(),
    task: { pendingOperation: reservedOperation({ operationId: "op-2" }) },
  });
  assert.equal(classification.classification, "CONTRADICTORY");
  assert.equal(classification.action, "STOP_AND_ESCALATE");
  assert.equal(classification.requiresEscalation, true);
});

test("OD-33: an absent row is retried only while the reservation is intact", () => {
  const intact = classifyHistoryDuplicate({
    expected: historyRecord(),
    existing: null,
    task: { pendingOperation: reservedOperation() },
  });
  assert.equal(intact.classification, "ABSENT");
  assert.equal(intact.action, "RETRY_SAME_IDENTITY");

  const changed = classifyHistoryDuplicate({
    expected: historyRecord(),
    existing: null,
    task: { pendingOperation: null },
  });
  assert.equal(changed.action, "STOP_AND_ESCALATE");
});

test("OD-33: duplicate-key reconciliation performs reads only", async () => {
  const database = createFakeDatabase();
  database.tasks.documents.push(leasedTask({ pendingOperation: reservedOperation() }));
  database.history.documents.push(historyRecord());

  const result = await reconcileDuplicateHistory({
    historyModel: database.history,
    taskModel: database.tasks,
    expected: historyRecord(),
    taskId: TASK_ID,
    operationId: "op-1",
  });

  assert.equal(result.classification, "IDENTICAL_ADOPT");
  assert.equal(result.readOnly, true);
  assert.equal(result.taskOperationState, "PREPARED");
  assert.equal(database.history.writeCalls().length, 0);
  assert.equal(database.tasks.writeCalls().length, 0);
  assert.deepEqual(
    [...HISTORY_IMMUTABLE_FIELDS].sort(),
    [
      "basis",
      "eventId",
      "intentDigest",
      "leaseGeneration",
      "manualReasonCode",
      "operationId",
      "reservedAt",
      "reservedBy",
      "sequenceNumber",
      "settledAt",
      "state",
      "taskId",
    ],
  );
  assert.deepEqual([...HISTORY_RECONCILIATION_CLASSIFICATIONS].sort(), [
    "ABSENT",
    "CONTRADICTORY",
    "DIVERGENT",
    "IDENTICAL_ADOPT",
  ]);
});

test("OD-32: snapshot/fingerprint linkage classifies drift and orphan evidence", () => {
  const task = baseTask({ status: "LEASED" });

  const linked = assessEvidenceLinkage({
    task,
    snapshot: { orderId: ORDER_ID, fingerprint: FINGERPRINT, sourcePresent: true },
  });
  assert.equal(linked.state, "LINKED");
  assert.equal(linked.action, "PROCEED");

  const drift = assessEvidenceLinkage({
    task,
    snapshot: { orderId: ORDER_ID, fingerprint: "c".repeat(64), sourcePresent: true },
  });
  assert.equal(drift.state, "DRIFT");
  assert.equal(drift.requiredStatus, "MANUAL_REQUIRED");
  assert.equal(drift.eventType, "RECOVERY_EVIDENCE_DRIFT");

  const orphan = assessEvidenceLinkage({
    task,
    snapshot: { orderId: ORDER_ID, fingerprint: FINGERPRINT, sourcePresent: false },
  });
  assert.equal(orphan.state, "ORPHAN");
  assert.equal(orphan.requiredStatus, ORPHAN_EVIDENCE_STATUS);
  assert.equal(orphan.action, "ESCALATE_MANUAL_REQUIRED");

  const mismatched = assessEvidenceLinkage({
    task,
    snapshot: { orderId: "64b000000000000000000009", fingerprint: FINGERPRINT },
  });
  assert.equal(mismatched.state, "ORPHAN");

  const indeterminate = assessEvidenceLinkage({ task, snapshot: null });
  assert.equal(indeterminate.state, "INDETERMINATE");
  assert.equal(indeterminate.action, "HOLD");

  assert.deepEqual([...EVIDENCE_LINKAGE_STATES], ["LINKED", "DRIFT", "ORPHAN", "INDETERMINATE"]);
});

test("reconciliation owns the writer vocabulary (no drift between audit paths)", () => {
  const writerSource = readSource("lib/recovery/taskWriter.js");
  const reconciliationSource = readSource("lib/recovery/operationReconciliation.js");

  assert.match(writerSource, /from\s+["']\.\/operationReconciliation\.js["']/);
  for (const constant of ["NON_PROOF_OUTCOMES", "DEFINITIVE_ABORT_EVIDENCE"]) {
    assert.match(reconciliationSource, new RegExp(`export const ${constant}`));
    assert.match(writerSource, new RegExp(`export\\s*\\{[^}]*\\b${constant}\\b`));
  }

  const operation = reservedOperation();
  for (const outcome of NON_PROOF_OUTCOMES) {
    assert.equal(
      assessReplayEligibility({ operation, evidence: { outcome, operationId: "op-1" } }).replayable,
      evaluateReplayEligibility({ operation, evidence: { outcome, operationId: "op-1" } }).replayable,
    );
  }
  assert.equal(assessOperationState({ pendingOperation: reservedOperation() }).action, "HOLD");
  assert.equal(assessOperationState({ pendingOperation: null }).action, "PROCEED");
});

test("W7/W5 source contract: strict effect mapping and per-transition allowlists", () => {
  const source = readSource("lib/recovery/taskWriter.js");

  assert.match(source, /export const EFFECT_TRANSITIONS/);
  assert.match(source, /export const W5_TRANSITION_IDS = Object\.freeze\(\[\s*"T-RETRY",\s*"T-EXHAUST",\s*"T-APPROVE"/);
  assert.match(source, /export const TRANSITION_FIELD_ALLOWLISTS/);
  assert.match(source, /export function resolveEffectTransition/);
  assert.match(source, /eventType: transition\.eventType/);
  assert.equal(
    (source.match(/input\.eventType/g) || []).length,
    1,
    "eventType is only an input to the strict resolver, never written directly",
  );
  assert.equal(/function pickWritableFields|const WRITABLE_TASK_FIELDS/.test(source), false);

  // W5 cannot reach T5/T14 or the cancellation rows; only the three generic rows.
  assert.match(source, /!W5_TRANSITION_IDS\.includes\(transition\.id\)/);
  assert.match(source, /requiresApprovalDistinct: true/);
  assert.match(source, /T6: attempts < maxAttempts/);

  // W1 uses an explicit creation allowlist rather than a caller-draft spread.
  assert.match(source, /export const TASK_CREATION_FIELDS/);
  assert.match(source, /function pickCreationFields/);
  assert.match(source, /\.\.\.pickCreationFields\(task\)/);

  // Clause 3 rejection is a fixed MANUAL_REQUIRED -> MANUAL_REQUIRED row driven
  // only by W11 recordRejection.
  assert.match(source, /id: "T-REJECT"/);
  assert.match(source, /async function recordRejection/);
  assert.match(source, /"recordRejection"/);

  // Clause 5: RECOVERY_ESCALATED is emitted by exactly the T-EXHAUST row and
  // the W8 abandonment path, and no escalation category is a diagnostic.
  assert.equal((source.match(/eventType: "RECOVERY_ESCALATED"/g) || []).length, 2);
  assert.equal(/diagnosticCode:\s*"ESC_/.test(source), false);
});

test("OD-10 provenance source contract: no production schema signature is claimed", () => {
  const taskSource = readSource("lib/models/RecoveryTask.js");
  const eventSource = readSource("lib/models/RecoveryEvent.js");

  for (const source of [taskSource, eventSource]) {
    assert.equal(/signed by the owner as OD-10/i.test(source), false);
    assert.match(source, /disposable replica-set proof/i);
    assert.match(source, /PENDING|NOT DEPLOYED|authored schema metadata|authored metadata/i);
  }
});

// -----------------------------------------------------------------------------
// H. Package 1 contract preservation
// -----------------------------------------------------------------------------

test("OD-37/G_ATTEMPTS source contract: server-time identity CAS and T2/T10-only bound", () => {
  const source = readSource("lib/recovery/taskWriter.js");

  const abandonStart = source.indexOf("async function abandonOperation");
  const abandonEnd = source.indexOf("// W9 / W10 / W11 / W12");
  const abandonSource = source.slice(abandonStart, abandonEnd);
  assert.match(abandonSource, /buildExpiredOriginalLeasePredicate/);
  assert.match(abandonSource, /leaseGeneration: task\.leaseGeneration/);
  assert.match(abandonSource, /leaseToken: task\.leaseToken/);
  assert.match(abandonSource, /leaseOwner: task\.leaseOwner/);
  assert.equal(/LEASE_NOT_EXPIRED/.test(abandonSource), false, "no worker-clock rejection");
  assert.equal(/getTime\(\)\s*>\s*now\.getTime\(\)/.test(abandonSource), false);

  const claimStart = source.indexOf("async function claimLease");
  const claimEnd = source.indexOf("async function renewLease");
  const claimSource = source.slice(claimStart, claimEnd);
  const attemptsGuard =
    claimSource.match(/\$expr:\s*\{\s*\$lt:\s*\["\$attempts",\s*"\$maxAttempts"\]\s*\}/g) || [];
  assert.equal(attemptsGuard.length, 1, "exactly one G_ATTEMPTS guard");
  assert.match(claimSource, /fromStatus === "DETECTED" \|\| fromStatus === "RETRY_SCHEDULED"/);
});

test("W11 source contract: role match and distinctness are enforced twice", () => {
  const source = readSource("lib/recovery/taskWriter.js");

  assert.match(source, /requiresApprovalDistinct: true/);
  assert.match(source, /actor\.role !== approval\.operatorRole/);
  assert.match(source, /task\.executedBy === actor\.id/);
  assert.match(source, /task\.verifierId === actor\.id/);
  assert.match(source, /\{ executedBy: \{ \$ne: actor\.id \} \}/);
  assert.match(source, /\{ verifierId: \{ \$ne: actor\.id \} \}/);
});

test("Package 1 contracts are unchanged by Package 2", () => {
  assert.deepEqual([...TERMINAL_OP_STATES], ["COMMITTED", "ABANDONED"]);
  assert.deepEqual([...ABANDONABLE_STATUSES], ["LEASED"]);

  const taskSource = readSource("lib/models/RecoveryTask.js");
  const eventSource = readSource("lib/models/RecoveryEvent.js");
  const identitySource = readSource("lib/recovery/identity.js");

  // Metadata-only modules still deploy no index and open no session.
  for (const source of [taskSource, eventSource, identitySource]) {
    assert.equal(/\.createIndex\s*\(/.test(source), false);
    assert.equal(/\.startSession\s*\(|\.withTransaction\s*\(/.test(source), false);
    assert.equal(/process\.env/.test(source), false);
  }
  assert.match(identitySource, /OPH:<taskId>:<operationId>/);
  assert.match(taskSource, /OPERATOR_DECISION_AFTER_HOLD/);
});

test("lifecycle transitions are the approved rows only", () => {
  assert.equal(LIFECYCLE_TRANSITIONS.length, 11);
  assert.equal(getLifecycleTransition("T-RECLAIM").claim, true);
  assert.equal(getLifecycleTransition("T-REJECT").from, "MANUAL_REQUIRED");
  assert.equal(getLifecycleTransition("T-REJECT").to, "MANUAL_REQUIRED");
  assert.equal(getLifecycleTransition("T-REJECT").eventType, "RECOVERY_REJECTED");
  assert.equal(getLifecycleTransition("T-DROP-EVERYTHING"), null);

  const ids = LIFECYCLE_TRANSITIONS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);

  // Claim rows are W2-only; W5 must not bump a lease generation.
  const source = readSource("lib/recovery/taskWriter.js");
  assert.match(source, /claim transitions must use claimLease/);
  assert.match(source, /eventSequenceCounter: 1n/);
  assert.match(source, /No counter increment at effect time|no counter increment at effect time/i);
});

test("writer error vocabulary is stable and documented", () => {
  assert.deepEqual([...WRITER_ERROR_CODES].sort(), [
    "ABANDONMENT_NOT_PERMITTED",
    "APPROVAL_REQUIRED",
    "AUTHORIZATION_MISMATCH",
    "CAS_MISMATCH",
    "DUPLICATE_EVENT",
    "DUPLICATE_HISTORY",
    "DUPLICATE_TASK",
    "ENTRY_POINT_NOT_ALLOWED",
    "ENTRY_POINT_NOT_IMPLEMENTED",
    "INVALID_ARGUMENT",
    "LEASE_NOT_EXPIRED",
    "OPERATION_MISMATCH",
    "REPLAY_NOT_AUTHORIZED",
    "SEQUENCE_OVERFLOW",
    "TASK_NOT_FOUND",
    "TRANSITION_NOT_ALLOWED",
    "UNRESOLVED_OUTCOME",
  ]);
});
