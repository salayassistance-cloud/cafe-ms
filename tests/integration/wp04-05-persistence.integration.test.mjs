// BONO Inventory V2 — WP04-05 Disposable Replica-Set Proof Integration Suite
//
// AUTHORIZATION: OWNER APPROVED — OD-10
// SCOPE: DISPOSABLE REPLICA-SET PROOF CORRECTIONS ONLY
//
// Safety Boundaries:
// - Loopback only (127.0.0.1) on isolated test ports (27019 for replica set, 27020 for standalone, 27021 for proxy).
// - Strict process ownership: refuses to attach to any pre-existing listener on test ports.
// - Never reads .env, .env.local, credentials, or production connection strings.
// - Never touches application databases, ports 27017/27018, or existing application models.
// - Database name strictly prefixed with bono_recovery_wp04_05_.
// - Real concurrency using independent client connections.
// - Genuine wire-level unknown-commit fault injection via loopback TCP proxy.
// - Integration with authoritative WP04-01 evidence projection module (lib/recovery/evidence.js).
// - Verification of all 12 proposed indexes and explicit query plans for all 12 indexes.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import mongoose from "mongoose";

import {
  projectEvidence,
  tryProjectEvidence,
  EvidenceProjectionError,
  EVIDENCE_SCHEMA_VERSION
} from "../../lib/recovery/evidence.js";
import { classifyEvidence } from "../../lib/recovery/classifier.js";

const MONGOD_PATH = "C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe";
const REPLSET_PORT = 27019;
const STANDALONE_PORT = 27020;
const PROXY_PORT = 27021;
const REPLSET_NAME = "bonorecoveryrs";
const DB_PREFIX = "bono_recovery_wp04_05_";

const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const PROHIBITED_PORTS = new Set([27017, 27018]);

const runId = randomBytes(6).toString("hex");
const testDbName = `${DB_PREFIX}${runId}`;

// -----------------------------------------------------------------------------
// Safety & Strict Process Ownership Guards
// -----------------------------------------------------------------------------

function validateTargetSafety(host, port, dbName) {
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`Target host '${host}' is NOT an authorized loopback address.`);
  }
  if (PROHIBITED_PORTS.has(port)) {
    throw new Error(`Target port ${port} is a prohibited application port.`);
  }
  if (!dbName.startsWith(DB_PREFIX)) {
    throw new Error(`Database name '${dbName}' must start with '${DB_PREFIX}'.`);
  }
}

async function isPortInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.on("connect", () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => {
      resolve(false);
    });
  });
}

function getPortListenerPid(port) {
  try {
    const stdout = execSync("netstat -ano -p tcp", { encoding: "utf8" });
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[0] === "TCP" && parts[3] === "LISTENING") {
        const localAddr = parts[1];
        if (localAddr.endsWith(`:${port}`)) {
          const pid = parseInt(parts[4], 10);
          if (!Number.isNaN(pid)) return pid;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function guardPortAvailable(port) {
  const occupied = await isPortInUse(port);
  if (occupied) {
    const listenerPid = getPortListenerPid(port);
    throw new Error(
      `BLOCKER: Port ${port} is already occupied (PID: ${listenerPid ?? "unknown"}). ` +
        `Refusing to attach to unverified listener. Test requires an unallocated port.`
    );
  }
}

async function verifyProcessOwnership(proc, port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null || proc.killed) {
      throw new Error(`Child process (PID ${proc.pid}) exited prematurely with code ${proc.exitCode}`);
    }
    const listenerPid = getPortListenerPid(port);
    if (listenerPid !== null) {
      if (listenerPid !== proc.pid) {
        throw new Error(
          `SECURITY / PROCESS OWNERSHIP VIOLATION: Port ${port} is owned by PID ${listenerPid}, ` +
            `but spawned process is PID ${proc.pid}. Refusing to attach.`
        );
      }
      try {
        process.kill(proc.pid, 0);
        return true;
      } catch (err) {
        throw new Error(`Process PID ${proc.pid} is not alive: ${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for process PID ${proc.pid} to bind listener on port ${port}`);
}

async function waitForPort(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortInUse(port)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timeout waiting for port ${port} to open.`);
}

// -----------------------------------------------------------------------------
// Query Plan & Execution Quality Inspection
// -----------------------------------------------------------------------------

function assertNoBlockingSort(node, queryDesc) {
  if (!node) return;
  const blockingSortStages = new Set(["SORT", "SORT_DEFAULT", "SORT_KEY_GENERATOR", "SORT_MERGE"]);
  if (blockingSortStages.has(node.stage)) {
    throw new Error(
      `UNEXPECTED BLOCKING SORT: Query '${queryDesc}' executed an in-memory sort stage '${node.stage}'. ` +
        `Index was expected to provide ordering without in-memory sorting.`
    );
  }
  if (node.inputStage) assertNoBlockingSort(node.inputStage, queryDesc);
  if (node.inputStages) node.inputStages.forEach((s) => assertNoBlockingSort(s, queryDesc));
  if (node.outerStage) assertNoBlockingSort(node.outerStage, queryDesc);
  if (node.innerStage) assertNoBlockingSort(node.innerStage, queryDesc);
}

function getWinningIndexName(node) {
  if (!node) return null;
  if (node.indexName) return node.indexName;
  if (node.inputStage) {
    const res = getWinningIndexName(node.inputStage);
    if (res) return res;
  }
  if (node.inputStages) {
    for (const child of node.inputStages) {
      const res = getWinningIndexName(child);
      if (res) return res;
    }
  }
  if (node.outerStage) {
    const res = getWinningIndexName(node.outerStage);
    if (res) return res;
  }
  if (node.innerStage) {
    const res = getWinningIndexName(node.innerStage);
    if (res) return res;
  }
  return null;
}

function assertPlanQuality(explainResult, expectedIndexName, queryDesc, requiresOrdering = false) {
  assert.ok(explainResult, `Explain result for '${queryDesc}' must exist`);
  const queryPlanner = explainResult.queryPlanner;
  assert.ok(queryPlanner, `queryPlanner for '${queryDesc}' must exist`);

  const winningIndex = getWinningIndexName(queryPlanner.winningPlan);
  assert.strictEqual(
    winningIndex,
    expectedIndexName,
    `Query '${queryDesc}' must select index '${expectedIndexName}', but selected '${winningIndex}'`
  );

  if (requiresOrdering) {
    assertNoBlockingSort(queryPlanner.winningPlan, queryDesc);
  }

  const executionStats = explainResult.executionStats;
  assert.ok(executionStats, `executionStats for '${queryDesc}' must exist`);
  assert.strictEqual(
    executionStats.executionSuccess,
    true,
    `Query '${queryDesc}' executionStats.executionSuccess must be true`
  );
  assert.ok(
    executionStats.totalKeysExamined >= 0,
    `Query '${queryDesc}' totalKeysExamined must be non-negative`
  );
  if (requiresOrdering && executionStats.executionStages) {
    assertNoBlockingSort(executionStats.executionStages, queryDesc);
  }
}

// -----------------------------------------------------------------------------
// Test-Local Finding Identity Helpers (Testing OD-23 Option B & WD-10 Specification)
// -----------------------------------------------------------------------------

function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]));
  return "{" + entries.join(",") + "}";
}

function buildFindingIdentityKey(ruleId, code, orderId, itemId = null, lineId = null) {
  const payload = {
    code: String(code),
    itemId: itemId === null ? { $type: "null" } : { $oid: String(itemId) },
    lineId: lineId === null ? { $type: "null" } : { $str: String(lineId) },
    orderId: { $oid: String(orderId) },
    rule: String(ruleId),
    schema: "wp04-task-identity-v1"
  };
  const canonicalString = canonicalize(payload);
  const digest = createHash("sha256").update(canonicalString, "utf8").digest("hex");
  return `REC:v1:${digest.slice(0, 32)}`;
}

function findingToIdentityKey(finding) {
  // Leverages the authoritative production finding dedupeKey from lib/recovery/classifier.js
  const hash = createHash("sha256").update(finding.dedupeKey, "utf8").digest("hex");
  return `REC:v1:${hash.slice(0, 32)}`;
}

function validateFiniteQuantity(val) {
  if (val === null || val === undefined) return true;
  return typeof val === "number" && Number.isFinite(val) && val >= 0 && val <= 1000000;
}

// -----------------------------------------------------------------------------
// Test-Local Mongoose 9 Schema Declarations (OD-10 Proposed Contracts)
// -----------------------------------------------------------------------------

const TaskSchema = new mongoose.Schema(
  {
    taskId: { type: String, required: true },
    taskKey: { type: String, required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, required: true },
    orderNumber: { type: mongoose.Schema.Types.Mixed, default: null },
    reservationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    itemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lineId: { type: mongoose.Schema.Types.Mixed, default: null },

    rule: {
      type: String,
      required: true,
      enum: ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09", "D10"]
    },
    code: { type: String, required: true },
    classification: {
      type: String,
      required: true,
      enum: ["DEFECT", "ALERT", "INFO"]
    },
    severity: {
      type: String,
      required: true,
      enum: ["CRITICAL", "HIGH", "MEDIUM", "INFO"]
    },
    confidence: {
      type: String,
      required: true,
      enum: ["HIGH", "MEDIUM", "LOW"]
    },
    evidenceLevel: {
      type: String,
      required: true,
      enum: ["E0", "E1", "E2", "E3"]
    },
    findingIdentityKey: { type: String, required: true },
    findingCodeOnly: { type: Boolean, default: false },
    durableClass: { type: mongoose.Schema.Types.Mixed, default: null },

    fingerprintSchema: { type: String, default: "wp04-fingerprint-v1" },
    evidenceSchema: { type: String, default: "wp04-evidence-v1" },
    initialFingerprint: { type: String, required: true },
    currentFingerprint: { type: String, required: true },

    status: {
      type: String,
      required: true,
      enum: [
        "DETECTED",
        "LEASED",
        "RETRY_SCHEDULED",
        "MANUAL_REQUIRED",
        "RESOLVED",
        "CLOSED",
        "CANCELLED"
      ],
      default: "DETECTED"
    },
    isOpen: { type: Boolean, required: true, default: true },
    leaseOwner: { type: String, default: null },
    leaseToken: { type: String, default: null },
    leaseGeneration: { type: mongoose.Schema.Types.BigInt, required: true, default: 0n },
    leaseUntil: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    maxAttempts: { type: Number, required: true, default: 5 },
    nextAttemptAt: { type: Date, default: null },
    eventSequenceCounter: { type: mongoose.Schema.Types.BigInt, required: true, default: 0n },

    manualReasonCode: {
      type: String,
      default: null,
      enum: [
        null,
        "POLICY_MANUAL_RULE",
        "EVIDENCE_DRIFT",
        "ATTEMPTS_EXHAUSTED",
        "PERSISTENCE_TIMEOUT"
      ]
    },
    escalation: {
      code: {
        type: String,
        default: null,
        enum: [
          null,
          "ESC_UNKNOWN_COMMIT",
          "ESC_EVIDENCE_DRIFT",
          "ESC_EXHAUSTED",
          "ESC_MANUAL_RULE"
        ]
      },
      expectedStatus: { type: String, default: null },
      actualStatus: { type: String, default: null },
      expectedQuantity: {
        type: Number,
        default: null,
        validate: {
          validator: validateFiniteQuantity,
          message: "expectedQuantity must be a finite number between 0 and 1000000"
        }
      },
      actualQuantity: {
        type: Number,
        default: null,
        validate: {
          validator: validateFiniteQuantity,
          message: "actualQuantity must be a finite number between 0 and 1000000"
        }
      }
    },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    executedBy: { type: String, default: null },
    executedAt: { type: Date, default: null },
    verifierId: { type: String, default: null },
    verifiedAt: { type: Date, default: null },

    resolution: {
      type: String,
      default: null,
      enum: [null, "ALREADY_CORRECT", "ESCALATED", "CANCELLED"]
    },
    lastErrorCode: {
      type: String,
      default: null,
      enum: [null, "EVIDENCE_DRIFT", "TIMEOUT", "CONFLICT", "SEQUENCE_OVERFLOW"]
    },
    lastErrorField: { type: String, default: null },
    priorTaskId: { type: mongoose.Schema.Types.ObjectId, default: null },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    closedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null }
  },
  {
    collection: "inventory_recovery_tasks",
    autoIndex: false,
    timestamps: false
  }
);

const SENSITIVE_KEY_PATTERN =
  /pin|password|passwd|secret|token|authorization|cookie|sessionid|apikey|connectionstring|mongodburi|accountnumber|credential/i;

const EventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    taskId: { type: String, required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, required: true },
    sequenceNumber: { type: mongoose.Schema.Types.BigInt, required: true },
    leaseGeneration: { type: mongoose.Schema.Types.BigInt, required: true },
    timestamp: { type: Date, required: true, default: Date.now },

    eventType: {
      type: String,
      required: true,
      enum: [
        "RECOVERY_DETECTED",
        "RECOVERY_LEASED",
        "RECOVERY_RENEWED",
        "RECOVERY_RETRY_SCHEDULED",
        "RECOVERY_ESCALATED",
        "RECOVERY_APPROVED",
        "RECOVERY_RESOLVED",
        "RECOVERY_VERIFIED",
        "RECOVERY_CLOSED",
        "RECOVERY_CANCELLED",
        "RECOVERY_EVIDENCE_DRIFT"
      ]
    },

    actorId: { type: String, required: true },
    actorRole: {
      type: String,
      required: true,
      enum: [
        "ROLE-TECHNICAL-LEAD",
        "ROLE-DATA-OWNER",
        "ROLE-INVENTORY-MANAGER",
        "SERVICE-WORKER"
      ]
    },
    actorType: {
      type: String,
      required: true,
      enum: ["WORKER", "OPERATOR", "SCANNER", "VERIFIER"]
    },
    fencingToken: { type: String, default: null },

    fingerprintVersion: { type: String, default: "wp04-fingerprint-v1" },
    evidenceSchemaVersion: { type: String, default: "wp04-evidence-v1" },
    evidenceDigest: { type: String, required: true },
    projectedEvidence: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      validate: {
        validator(val) {
          if (!val || typeof val !== "object") return true;
          function check(obj) {
            for (const [k, v] of Object.entries(obj)) {
              if (SENSITIVE_KEY_PATTERN.test(k)) return false;
              if (v && typeof v === "object" && !check(v)) return false;
            }
            return true;
          }
          return check(val);
        },
        message: "projectedEvidence contains forbidden sensitive keys"
      }
    },

    details: {
      fromStatus: { type: String, default: null },
      toStatus: { type: String, required: true },
      attempts: { type: Number, required: true },
      diagnosticCode: {
        type: String,
        default: null,
        enum: [
          null,
          "DOC_CORRUPT",
          "INDEX_ABSENT",
          "TIMEOUT",
          "LEASE_EXPIRED",
          "DRIFT_DETECTED"
        ]
      },
      observedFingerprint: { type: String, default: null }
    }
  },
  {
    collection: "inventory_recovery_events",
    autoIndex: false,
    timestamps: false
  }
);

// -----------------------------------------------------------------------------
// Test Suite Execution
// -----------------------------------------------------------------------------

describe("BONO WP04-05 Disposable Replica-Set Proof", () => {
  let mongodProcess = null;
  let tempDbDir = null;
  let replSetOwnerVerified = false;
  let connectionPrimary = null;
  let connectionClientA = null;
  let connectionClientB = null;

  let TaskModel = null;
  let EventModel = null;
  let tasksCollection = null;
  let eventsCollection = null;

  before(async () => {
    validateTargetSafety("127.0.0.1", REPLSET_PORT, testDbName);

    // Strict Process Ownership Guard: Guard all three test ports: 27019, 27020, and 27021!
    await guardPortAvailable(REPLSET_PORT);
    await guardPortAvailable(STANDALONE_PORT);
    await guardPortAvailable(PROXY_PORT);

    // Create unique disposable dbPath
    tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bono-wp04-05-rs-"));

    // Spawn mongod process under harness ownership
    let childError = null;
    mongodProcess = spawn(
      MONGOD_PATH,
      [
        "--dbpath",
        tempDbDir,
        "--port",
        String(REPLSET_PORT),
        "--bind_ip",
        "127.0.0.1",
        "--replSet",
        REPLSET_NAME,
        "--oplogSize",
        "128"
      ],
      { stdio: "ignore" }
    );

    mongodProcess.on("error", (err) => {
      childError = err;
    });
    mongodProcess.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        childError = new Error(`mongod exited prematurely with code ${code}, signal ${signal}`);
      }
    });

    assert.ok(mongodProcess.pid, "Spawned mongod must have a valid PID");

    // Strict Process Ownership Verification:
    // Never treat a listening port as proof that spawned mongod owns it!
    // Verify spawned process is alive and owns the intended listener before issuing any command.
    await verifyProcessOwnership(mongodProcess, REPLSET_PORT, 15000);
    if (childError) throw childError;
    replSetOwnerVerified = true;

    // Initiate single-node replica set
    const adminConn = await mongoose
      .createConnection(`mongodb://127.0.0.1:${REPLSET_PORT}/admin?directConnection=true`)
      .asPromise();

    try {
      await adminConn.db.command({
        replSetInitiate: {
          _id: REPLSET_NAME,
          members: [{ _id: 0, host: `127.0.0.1:${REPLSET_PORT}` }]
        }
      });
    } catch (err) {
      // Already initiated is fine
    }

    // Wait for writable primary
    let isPrimary = false;
    for (let i = 0; i < 30; i++) {
      const hello = await adminConn.db.command({ hello: 1 });
      if (hello.isWritablePrimary) {
        isPrimary = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await adminConn.close(true);
    if (!isPrimary) {
      throw new Error("Disposable replica set did not become primary within timeout.");
    }

    // Connect Primary Mongoose connection to disposable database
    const uri = `mongodb://127.0.0.1:${REPLSET_PORT}/${testDbName}?directConnection=true&replicaSet=${REPLSET_NAME}`;
    connectionPrimary = await mongoose.createConnection(uri).asPromise();

    // Independent Client Connections for real concurrency verification
    connectionClientA = await mongoose.createConnection(uri).asPromise();
    connectionClientB = await mongoose.createConnection(uri).asPromise();

    TaskModel = connectionPrimary.model("RecoveryTask", TaskSchema);
    EventModel = connectionPrimary.model("RecoveryEvent", EventSchema);

    await TaskModel.createCollection();
    await EventModel.createCollection();

    tasksCollection = connectionPrimary.db.collection("inventory_recovery_tasks");
    eventsCollection = connectionPrimary.db.collection("inventory_recovery_events");

    // Explicitly create all 12 proposed indexes
    // Task Indexes (IDX-TSK-01 to IDX-TSK-06)
    await tasksCollection.createIndex({ taskId: 1 }, { unique: true, name: "IDX-TSK-01" });
    await tasksCollection.createIndex(
      { findingIdentityKey: 1 },
      { unique: true, partialFilterExpression: { isOpen: true }, name: "IDX-TSK-02" }
    );
    await tasksCollection.createIndex({ orderId: 1, isOpen: 1 }, { name: "IDX-TSK-03" });
    await tasksCollection.createIndex(
      { status: 1, isOpen: 1, nextAttemptAt: 1, leaseUntil: 1 },
      { name: "IDX-TSK-04" }
    );
    await tasksCollection.createIndex(
      { leaseOwner: 1, leaseUntil: 1, leaseGeneration: 1 },
      { partialFilterExpression: { isOpen: true }, name: "IDX-TSK-05" }
    );
    await tasksCollection.createIndex(
      { status: 1, severity: 1, createdAt: 1 },
      { partialFilterExpression: { status: "MANUAL_REQUIRED" }, name: "IDX-TSK-06" }
    );

    // Event Indexes (IDX-EVT-01 to IDX-EVT-06)
    await eventsCollection.createIndex({ eventId: 1 }, { unique: true, name: "IDX-EVT-01" });
    await eventsCollection.createIndex(
      { taskId: 1, sequenceNumber: 1 },
      { unique: true, name: "IDX-EVT-02" }
    );
    await eventsCollection.createIndex({ orderId: 1, timestamp: -1 }, { name: "IDX-EVT-03" });
    await eventsCollection.createIndex({ eventType: 1, timestamp: -1 }, { name: "IDX-EVT-04" });
    await eventsCollection.createIndex({ actorId: 1, timestamp: -1 }, { name: "IDX-EVT-05" });
    await eventsCollection.createIndex({ taskId: 1, leaseGeneration: 1 }, { name: "IDX-EVT-06" });
  });

  after(async () => {
    // If process ownership was not established, fail closed and perform NO shutdown,
    // database drop, or cleanup commands against the unverified listener.
    if (!replSetOwnerVerified) {
      return;
    }

    if (connectionPrimary) {
      try {
        await connectionPrimary.dropDatabase();
      } catch (err) {
        console.error("Error dropping disposable database:", err.message);
      }
      try {
        await connectionPrimary.db.admin().command({ shutdown: 1 });
      } catch {}
      try {
        await connectionPrimary.close(true);
      } catch {}
    }
    if (connectionClientA) {
      try {
        await connectionClientA.close(true);
      } catch {}
    }
    if (connectionClientB) {
      try {
        await connectionClientB.close(true);
      } catch {}
    }

    // Strict Process Ownership Cleanup
    if (mongodProcess && mongodProcess.pid) {
      try {
        mongodProcess.kill();
      } catch {}
      await new Promise((resolve) => {
        if (mongodProcess.killed || mongodProcess.exitCode !== null) return resolve();
        mongodProcess.on("close", resolve);
        setTimeout(resolve, 1000).unref();
      });
      if (tempDbDir) {
        for (let i = 0; i < 5; i++) {
          try {
            fs.rmSync(tempDbDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
            break;
          } catch (err) {
            if (i === 4) {
              console.error("Error removing temp dir:", err.message);
            } else {
              await new Promise((r) => setTimeout(r, 300));
            }
          }
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Proof A: BSON Long Serialization & Round-Trip Behavior
  // ---------------------------------------------------------------------------
  describe("Proof A: Mongoose 9 / BSON Long Serialization & Round-Trip", () => {
    test("TEST-01: Mongoose 9 BigInt stores as BSON Long (type 18 / 'long')", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const taskId = "REC:v1:test01_bson_long_proof_0000001";
      const taskKey = `GRP:${orderId}`;

      const created = await TaskModel.create({
        taskId,
        taskKey,
        orderId,
        rule: "D01",
        code: "STOCK_NEGATIVE",
        classification: "DEFECT",
        severity: "CRITICAL",
        confidence: "HIGH",
        evidenceLevel: "E3",
        findingIdentityKey: taskId,
        initialFingerprint: "abc01",
        currentFingerprint: "abc01",
        status: "DETECTED",
        isOpen: true,
        leaseGeneration: 0n,
        eventSequenceCounter: 42n
      });

      assert.strictEqual(typeof created.eventSequenceCounter, "bigint");
      assert.strictEqual(created.eventSequenceCounter, 42n);

      // Verify raw BSON type stored in MongoDB via $type aggregation
      const rawTypes = await tasksCollection
        .aggregate([
          { $match: { taskId } },
          {
            $project: {
              seqType: { $type: "$eventSequenceCounter" },
              leaseGenType: { $type: "$leaseGeneration" }
            }
          }
        ])
        .toArray();

      assert.strictEqual(rawTypes.length, 1);
      assert.strictEqual(rawTypes[0].seqType, "long", "eventSequenceCounter must be BSON Long (type 18)");
      assert.strictEqual(rawTypes[0].leaseGenType, "long", "leaseGeneration must be BSON Long (type 18)");

      // Wire roundtrip
      const fetched = await TaskModel.findOne({ taskId });
      assert.strictEqual(typeof fetched.eventSequenceCounter, "bigint");
      assert.strictEqual(fetched.eventSequenceCounter, 42n);
      assert.strictEqual(typeof fetched.leaseGeneration, "bigint");
      assert.strictEqual(fetched.leaseGeneration, 0n);
    });

    test("TEST-02: BSON Long atomic $inc preserves BSON Long type", async () => {
      const taskId = "REC:v1:test01_bson_long_proof_0000001";
      const updateResult = await TaskModel.updateOne(
        { taskId },
        { $inc: { eventSequenceCounter: 1n, leaseGeneration: 1n } }
      );
      assert.strictEqual(updateResult.modifiedCount, 1);

      const rawTypes = await tasksCollection
        .aggregate([
          { $match: { taskId } },
          {
            $project: {
              seqType: { $type: "$eventSequenceCounter" },
              leaseGenType: { $type: "$leaseGeneration" }
            }
          }
        ])
        .toArray();

      assert.strictEqual(rawTypes[0].seqType, "long", "$inc must preserve BSON Long type");
      assert.strictEqual(rawTypes[0].leaseGenType, "long", "$inc must preserve BSON Long type");

      const fetched = await TaskModel.findOne({ taskId });
      assert.strictEqual(fetched.eventSequenceCounter, 43n);
      assert.strictEqual(fetched.leaseGeneration, 1n);
    });

    test("TEST-03: Safe sequence range [1, 1000000] and overflow fail-closed guard", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const taskId = "REC:v1:test03_overflow_proof_0000001";

      await TaskModel.create({
        taskId,
        taskKey: `GRP:${orderId}`,
        orderId,
        rule: "D01",
        code: "STOCK_NEGATIVE",
        classification: "DEFECT",
        severity: "CRITICAL",
        confidence: "HIGH",
        evidenceLevel: "E3",
        findingIdentityKey: taskId,
        initialFingerprint: "abc03",
        currentFingerprint: "abc03",
        status: "LEASED",
        isOpen: true,
        leaseGeneration: 1n,
        eventSequenceCounter: 1000000n // AT CEILING
      });

      // Atomic allocation query with bounded ceiling filter
      const res = await TaskModel.updateOne(
        {
          taskId,
          isOpen: true,
          status: "LEASED",
          eventSequenceCounter: { $lt: 1000000n } // HARD CEILING
        },
        { $inc: { eventSequenceCounter: 1n } }
      );

      // Query matched 0 documents because counter is already at 1,000,000
      assert.strictEqual(res.matchedCount, 0, "Counter at ceiling must match 0 documents");
      assert.strictEqual(res.modifiedCount, 0, "Counter must not be modified beyond ceiling");

      // Verify counter remained exactly 1,000,000n
      const check = await TaskModel.findOne({ taskId });
      assert.strictEqual(check.eventSequenceCounter, 1000000n);
    });
  });

  // ---------------------------------------------------------------------------
  // Proof B: Multi-Document Transaction Atomicity and Rollback
  // ---------------------------------------------------------------------------
  describe("Proof B: Multi-Document Transaction Atomicity and Rollback", () => {
    test("TEST-04: Transaction commit atomically persists task counter increment and event insertion", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const taskId = "REC:v1:test04_tx_commit_000000000001";

      await TaskModel.create({
        taskId,
        taskKey: `GRP:${orderId}`,
        orderId,
        rule: "D04",
        code: "STOCK_RESERVATION_MISMATCH",
        classification: "DEFECT",
        severity: "HIGH",
        confidence: "HIGH",
        evidenceLevel: "E2",
        findingIdentityKey: taskId,
        initialFingerprint: "tx04_init",
        currentFingerprint: "tx04_init",
        status: "LEASED",
        isOpen: true,
        leaseOwner: "worker-proof-b",
        leaseToken: "token-proof-b-1",
        leaseGeneration: 1n,
        leaseUntil: new Date(Date.now() + 60000),
        eventSequenceCounter: 0n
      });

      const session = await connectionPrimary.startSession();
      session.startTransaction();

      try {
        const updatedTask = await TaskModel.findOneAndUpdate(
          {
            taskId,
            isOpen: true,
            status: "LEASED",
            leaseOwner: "worker-proof-b",
            leaseGeneration: 1n
          },
          {
            $inc: { eventSequenceCounter: 1n },
            $set: { updatedAt: new Date() }
          },
          { session, returnDocument: "after" }
        );

        const allocatedSeq = updatedTask.eventSequenceCounter; // 1n

        await EventModel.create(
          [
            {
              eventId: `EVT:${taskId}:${allocatedSeq}`,
              taskId,
              orderId,
              sequenceNumber: allocatedSeq,
              leaseGeneration: 1n,
              eventType: "RECOVERY_LEASED",
              actorId: "worker-proof-b",
              actorRole: "SERVICE-WORKER",
              actorType: "WORKER",
              fencingToken: "token-proof-b-1",
              evidenceDigest: "digest04",
              details: {
                fromStatus: "DETECTED",
                toStatus: "LEASED",
                attempts: 1
              }
            }
          ],
          { session }
        );

        await session.commitTransaction();
      } finally {
        await session.endSession();
      }

      // Verify both mutations are visible post-commit
      const taskAfter = await TaskModel.findOne({ taskId });
      assert.strictEqual(taskAfter.eventSequenceCounter, 1n);

      const eventAfter = await EventModel.findOne({ eventId: `EVT:${taskId}:1` });
      assert.ok(eventAfter, "Event 1 must exist post-commit");
      assert.strictEqual(eventAfter.sequenceNumber, 1n);
    });

    test("TEST-05: Transaction abort rolls back both event and task sequence counter (zero gaps, zero phantoms)", async () => {
      const taskId = "REC:v1:test04_tx_commit_000000000001";
      const taskBefore = await TaskModel.findOne({ taskId });
      const orderId = taskBefore.orderId;
      assert.strictEqual(taskBefore.eventSequenceCounter, 1n);

      const session = await connectionPrimary.startSession();
      session.startTransaction();

      try {
        const updatedTask = await TaskModel.findOneAndUpdate(
          { taskId, isOpen: true },
          { $inc: { eventSequenceCounter: 1n } },
          { session, returnDocument: "after" }
        );
        assert.strictEqual(updatedTask.eventSequenceCounter, 2n);

        await EventModel.create(
          [
            {
              eventId: `EVT:${taskId}:2`,
              taskId,
              orderId,
              sequenceNumber: 2n,
              leaseGeneration: 1n,
              eventType: "RECOVERY_RETRY_SCHEDULED",
              actorId: "worker-proof-b",
              actorRole: "SERVICE-WORKER",
              actorType: "WORKER",
              fencingToken: "token-proof-b-1",
              evidenceDigest: "digest05",
              details: {
                fromStatus: "LEASED",
                toStatus: "RETRY_SCHEDULED",
                attempts: 1
              }
            }
          ],
          { session }
        );

        // Simulate failure before commit
        throw new Error("SIMULATED_TRANSACTION_FAILURE");
      } catch (err) {
        assert.strictEqual(err.message, "SIMULATED_TRANSACTION_FAILURE");
        await session.abortTransaction();
      } finally {
        await session.endSession();
      }

      // Verify rollback
      const taskAfter = await TaskModel.findOne({ taskId });
      assert.strictEqual(
        taskAfter.eventSequenceCounter,
        1n,
        "eventSequenceCounter MUST roll back to 1n upon transaction abort"
      );

      const phantomEvent = await EventModel.findOne({ eventId: `EVT:${taskId}:2` });
      assert.strictEqual(phantomEvent, null, "Aborted event must NOT exist in the database");
    });
  });

  // ---------------------------------------------------------------------------
  // Proof C: All 12 Proposed Index Definitions and Actual Behavior
  // ---------------------------------------------------------------------------
  describe("Proof C: All 12 Proposed Index Definitions and Actual Behavior", () => {
    test("TEST-06: Task collection indexes (IDX-TSK-01 to IDX-TSK-06) verified", async () => {
      const indexes = await tasksCollection.indexes();
      const indexMap = new Map(indexes.map((idx) => [idx.name, idx]));

      const tsk01 = indexMap.get("IDX-TSK-01");
      assert.ok(tsk01, "IDX-TSK-01 must exist");
      assert.deepStrictEqual(tsk01.key, { taskId: 1 });
      assert.strictEqual(tsk01.unique, true);

      const tsk02 = indexMap.get("IDX-TSK-02");
      assert.ok(tsk02, "IDX-TSK-02 must exist");
      assert.deepStrictEqual(tsk02.key, { findingIdentityKey: 1 });
      assert.strictEqual(tsk02.unique, true);
      assert.deepStrictEqual(tsk02.partialFilterExpression, { isOpen: true });

      const tsk03 = indexMap.get("IDX-TSK-03");
      assert.ok(tsk03, "IDX-TSK-03 must exist");
      assert.deepStrictEqual(tsk03.key, { orderId: 1, isOpen: 1 });

      const tsk04 = indexMap.get("IDX-TSK-04");
      assert.ok(tsk04, "IDX-TSK-04 must exist");
      assert.deepStrictEqual(tsk04.key, { status: 1, isOpen: 1, nextAttemptAt: 1, leaseUntil: 1 });

      const tsk05 = indexMap.get("IDX-TSK-05");
      assert.ok(tsk05, "IDX-TSK-05 must exist");
      assert.deepStrictEqual(tsk05.key, { leaseOwner: 1, leaseUntil: 1, leaseGeneration: 1 });
      assert.deepStrictEqual(tsk05.partialFilterExpression, { isOpen: true });

      const tsk06 = indexMap.get("IDX-TSK-06");
      assert.ok(tsk06, "IDX-TSK-06 must exist");
      assert.deepStrictEqual(tsk06.key, { status: 1, severity: 1, createdAt: 1 });
      assert.deepStrictEqual(tsk06.partialFilterExpression, { status: "MANUAL_REQUIRED" });
    });

    test("TEST-07: Event collection indexes (IDX-EVT-01 to IDX-EVT-06) verified", async () => {
      const indexes = await eventsCollection.indexes();
      const indexMap = new Map(indexes.map((idx) => [idx.name, idx]));

      const evt01 = indexMap.get("IDX-EVT-01");
      assert.ok(evt01, "IDX-EVT-01 must exist");
      assert.deepStrictEqual(evt01.key, { eventId: 1 });
      assert.strictEqual(evt01.unique, true);

      const evt02 = indexMap.get("IDX-EVT-02");
      assert.ok(evt02, "IDX-EVT-02 must exist");
      assert.deepStrictEqual(evt02.key, { taskId: 1, sequenceNumber: 1 });
      assert.strictEqual(evt02.unique, true);

      const evt03 = indexMap.get("IDX-EVT-03");
      assert.ok(evt03, "IDX-EVT-03 must exist");
      assert.deepStrictEqual(evt03.key, { orderId: 1, timestamp: -1 });

      const evt04 = indexMap.get("IDX-EVT-04");
      assert.ok(evt04, "IDX-EVT-04 must exist");
      assert.deepStrictEqual(evt04.key, { eventType: 1, timestamp: -1 });

      const evt05 = indexMap.get("IDX-EVT-05");
      assert.ok(evt05, "IDX-EVT-05 must exist");
      assert.deepStrictEqual(evt05.key, { actorId: 1, timestamp: -1 });

      const evt06 = indexMap.get("IDX-EVT-06");
      assert.ok(evt06, "IDX-EVT-06 must exist");
      assert.deepStrictEqual(evt06.key, { taskId: 1, leaseGeneration: 1 });
    });

    test("TEST-08: Explicit query plan verification via explain for all 12 proposed indexes", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const taskId = "REC:v1:test08_all12_indexes_0000001";
      const findingKey = taskId;

      // Seed task and event documents for query planner evaluation
      await TaskModel.create({
        taskId,
        taskKey: `GRP:${orderId}`,
        orderId,
        rule: "D01",
        code: "STOCK_NEGATIVE",
        classification: "DEFECT",
        severity: "CRITICAL",
        confidence: "HIGH",
        evidenceLevel: "E3",
        findingIdentityKey: findingKey,
        initialFingerprint: "exp08",
        currentFingerprint: "exp08",
        status: "MANUAL_REQUIRED",
        isOpen: true,
        leaseOwner: "worker-exp-12",
        leaseUntil: new Date(Date.now() + 60000),
        nextAttemptAt: new Date(Date.now() + 30000),
        leaseGeneration: 1n,
        eventSequenceCounter: 1n
      });

      await EventModel.create({
        eventId: `EVT:${taskId}:1`,
        taskId,
        orderId,
        sequenceNumber: 1n,
        leaseGeneration: 1n,
        eventType: "RECOVERY_DETECTED",
        actorId: "actor-exp-12",
        actorRole: "SERVICE-WORKER",
        actorType: "SCANNER",
        evidenceDigest: "digest08",
        timestamp: new Date(),
        details: { toStatus: "MANUAL_REQUIRED", attempts: 0 }
      });

      // 1. IDX-TSK-01: taskId lookup
      const p1 = await tasksCollection.find({ taskId }).explain("executionStats");
      assertPlanQuality(p1, "IDX-TSK-01", "Query 1 (taskId lookup)", false);

      // 2. IDX-TSK-02: findingIdentityKey open query
      const p2 = await tasksCollection.find({ findingIdentityKey: findingKey, isOpen: true }).explain("executionStats");
      assertPlanQuality(p2, "IDX-TSK-02", "Query 2 (findingIdentityKey open query)", false);

      // 3. IDX-TSK-03: orderId triage query
      const p3 = await tasksCollection.find({ orderId, isOpen: true }).explain("executionStats");
      assertPlanQuality(p3, "IDX-TSK-03", "Query 3 (orderId triage query)", false);

      // 4. IDX-TSK-04: worker polling queue query
      const p4 = await tasksCollection
        .find({ status: "MANUAL_REQUIRED", isOpen: true, nextAttemptAt: { $gte: new Date(0) } })
        .explain("executionStats");
      assertPlanQuality(p4, "IDX-TSK-04", "Query 4 (worker polling queue query)", false);

      // 5. IDX-TSK-05: worker heartbeat/generation query
      const p5 = await tasksCollection
        .find({ leaseOwner: "worker-exp-12", isOpen: true })
        .explain("executionStats");
      assertPlanQuality(p5, "IDX-TSK-05", "Query 5 (worker heartbeat query)", false);

      // 6. IDX-TSK-06: manual review escalation FIFO queue (requires ordering without in-memory sort)
      const p6 = await tasksCollection
        .find({ status: "MANUAL_REQUIRED", severity: "CRITICAL" })
        .sort({ createdAt: 1 })
        .explain("executionStats");
      assertPlanQuality(p6, "IDX-TSK-06", "Query 6 (manual review escalation FIFO queue)", true);

      // 7. IDX-EVT-01: eventId primary lookup
      const p7 = await eventsCollection.find({ eventId: `EVT:${taskId}:1` }).explain("executionStats");
      assertPlanQuality(p7, "IDX-EVT-01", "Query 7 (eventId primary lookup)", false);

      // 8. IDX-EVT-02: event chronological playback (requires ordering without in-memory sort)
      const p8 = await eventsCollection.find({ taskId }).sort({ sequenceNumber: 1 }).explain("executionStats");
      assertPlanQuality(p8, "IDX-EVT-02", "Query 8 (event chronological playback)", true);

      // 9. IDX-EVT-03: order audit trail (requires ordering without in-memory sort)
      const p9 = await eventsCollection.find({ orderId }).sort({ timestamp: -1 }).explain("executionStats");
      assertPlanQuality(p9, "IDX-EVT-03", "Query 9 (order audit trail)", true);

      // 10. IDX-EVT-04: operational eventType telemetry (requires ordering without in-memory sort)
      const p10 = await eventsCollection.find({ eventType: "RECOVERY_DETECTED" }).sort({ timestamp: -1 }).explain("executionStats");
      assertPlanQuality(p10, "IDX-EVT-04", "Query 10 (eventType telemetry)", true);

      // 11. IDX-EVT-05: actor compliance audit (requires ordering without in-memory sort)
      const p11 = await eventsCollection.find({ actorId: "actor-exp-12" }).sort({ timestamp: -1 }).explain("executionStats");
      assertPlanQuality(p11, "IDX-EVT-05", "Query 11 (actor compliance audit)", true);

      // 12. IDX-EVT-06: stale generation audit
      const p12 = await eventsCollection.find({ taskId, leaseGeneration: 1n }).explain("executionStats");
      assertPlanQuality(p12, "IDX-EVT-06", "Query 12 (stale generation audit)", false);
    });
  });

  // ---------------------------------------------------------------------------
  // Proof D: OD-23 Option B Real Concurrency & WD-10 Preservation
  // ---------------------------------------------------------------------------
  describe("Proof D: OD-23 Option B Real Concurrency & WD-10 Preservation", () => {
    test("TEST-09: Real concurrency: Two independent clients compete to create open task for same finding; exactly one succeeds", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const itemId = new mongoose.Types.ObjectId();

      // Derive findingIdentityKey by bridging authoritative WP04 classifier output through test-local hasher
      const evidence = projectEvidence({
        order: {
          _id: orderId,
          orderNumber: "ORD-CONC-09",
          status: "PAID",
          paidAt: new Date(),
          paymentMethod: "CASH",
          paymentAccountId: null,
          items: [
            {
              lineId: "line-1",
              type: "FOOD",
              quantity: 1,
              cancelled: false,
              components: [{ inventoryItemId: itemId, stockQuantity: 1 }]
            }
          ]
        },
        reservation: null,
        movements: [],
        inventory: [{ inventoryItemId: itemId, currentStock: -1 }]
      });
      const classification = classifyEvidence(evidence);
      const productionFinding = classification.findings.find((f) => f.rule === "D01") || classification.findings[0];
      assert.ok(productionFinding, "Production classifier must produce a finding");
      const findingKey = findingToIdentityKey(productionFinding);

      const ModelA = connectionClientA.model("RecoveryTask", TaskSchema);
      const ModelB = connectionClientB.model("RecoveryTask", TaskSchema);

      const taskPayloadA = {
        taskId: `${findingKey}:clientA`,
        taskKey: `GRP:${orderId}`,
        orderId,
        itemId,
        rule: productionFinding.rule,
        code: productionFinding.code,
        classification: productionFinding.classification,
        severity: productionFinding.severity,
        confidence: productionFinding.confidence,
        evidenceLevel: productionFinding.evidenceLevel,
        findingIdentityKey: findingKey,
        initialFingerprint: "conc_09",
        currentFingerprint: "conc_09",
        status: "DETECTED",
        isOpen: true
      };

      const taskPayloadB = {
        taskId: `${findingKey}:clientB`,
        taskKey: `GRP:${orderId}`,
        orderId,
        itemId,
        rule: productionFinding.rule,
        code: productionFinding.code,
        classification: productionFinding.classification,
        severity: productionFinding.severity,
        confidence: productionFinding.confidence,
        evidenceLevel: productionFinding.evidenceLevel,
        findingIdentityKey: findingKey,
        initialFingerprint: "conc_09",
        currentFingerprint: "conc_09",
        status: "DETECTED",
        isOpen: true
      };

      // Launch both insertions simultaneously from two independent connections
      const results = await Promise.allSettled([
        ModelA.create(taskPayloadA),
        ModelB.create(taskPayloadB)
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.strictEqual(fulfilled.length, 1, "Exactly one concurrent client must succeed in creating open task");
      assert.strictEqual(rejected.length, 1, "Exactly one concurrent client must be rejected with duplicate key error");

      const rejectedError = rejected[0].reason;
      assert.strictEqual(rejectedError.code, 11000, "Rejected client must receive duplicate key error code 11000");
      assert.ok(
        rejectedError.message.includes("IDX-TSK-02") || rejectedError.message.includes("findingIdentityKey"),
        "Duplicate key violation must be on IDX-TSK-02"
      );

      // Verify DB contains exactly 1 document
      const count = await TaskModel.countDocuments({ findingIdentityKey: findingKey, isOpen: true });
      assert.strictEqual(count, 1, "Database must contain exactly 1 open document for findingIdentityKey");
    });

    test("TEST-10: Real concurrency & WD-10 preservation: Independent findings on same orderId succeed concurrently", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const itemA = new mongoose.Types.ObjectId();
      const itemB = new mongoose.Types.ObjectId();

      // Canonical WD-10 item-level finding identity keys for distinct items on the same order
      const findingA = buildFindingIdentityKey("D01", "STOCK_NEGATIVE", orderId, itemA);
      const findingB = buildFindingIdentityKey("D04", "STOCK_RESERVATION_MISMATCH", orderId, itemB);

      const ModelA = connectionClientA.model("RecoveryTask", TaskSchema);
      const ModelB = connectionClientB.model("RecoveryTask", TaskSchema);

      const results = await Promise.allSettled([
        ModelA.create({
          taskId: `${findingA}:01`,
          taskKey: `GRP:${orderId}`,
          orderId,
          itemId: itemA,
          rule: "D01",
          code: "STOCK_NEGATIVE",
          classification: "DEFECT",
          severity: "CRITICAL",
          confidence: "HIGH",
          evidenceLevel: "E3",
          findingIdentityKey: findingA,
          initialFingerprint: "fa",
          currentFingerprint: "fa",
          status: "DETECTED",
          isOpen: true
        }),
        ModelB.create({
          taskId: `${findingB}:01`,
          taskKey: `GRP:${orderId}`,
          orderId,
          itemId: itemB,
          rule: "D04",
          code: "STOCK_RESERVATION_MISMATCH",
          classification: "DEFECT",
          severity: "HIGH",
          confidence: "HIGH",
          evidenceLevel: "E2",
          findingIdentityKey: findingB,
          initialFingerprint: "fb",
          currentFingerprint: "fb",
          status: "DETECTED",
          isOpen: true
        })
      ]);

      assert.strictEqual(results[0].status, "fulfilled", "Finding A on Item A must insert successfully");
      assert.strictEqual(results[1].status, "fulfilled", "Finding B on Item B must insert successfully");

      const orderTasks = await TaskModel.find({ orderId, isOpen: true });
      assert.strictEqual(orderTasks.length, 2, "WD-10: Distinct item findings must coexist without order bottleneck");
    });

    test("TEST-11: Finding recurrence allowed after close with priorTaskId lineage", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const itemId = new mongoose.Types.ObjectId();
      const findingKey = buildFindingIdentityKey("D01", "STOCK_NEGATIVE", orderId, itemId);
      const taskIdInitial = `${findingKey}:init`;
      const taskIdRecurred = `${findingKey}:recur`;

      const initialTask = await TaskModel.create({
        taskId: taskIdInitial,
        taskKey: `GRP:${orderId}`,
        orderId,
        itemId,
        rule: "D01",
        code: "STOCK_NEGATIVE",
        classification: "DEFECT",
        severity: "CRITICAL",
        confidence: "HIGH",
        evidenceLevel: "E3",
        findingIdentityKey: findingKey,
        initialFingerprint: "init",
        currentFingerprint: "init",
        status: "DETECTED",
        isOpen: true
      });

      // Close the initial task
      await TaskModel.updateOne(
        { _id: initialTask._id },
        {
          $set: {
            status: "CLOSED",
            isOpen: false,
            resolution: "ALREADY_CORRECT",
            closedAt: new Date()
          }
        }
      );

      // Defect recurs after close
      const recurredTask = await TaskModel.create({
        taskId: taskIdRecurred,
        taskKey: `GRP:${orderId}`,
        orderId,
        itemId,
        rule: "D01",
        code: "STOCK_NEGATIVE",
        classification: "DEFECT",
        severity: "CRITICAL",
        confidence: "HIGH",
        evidenceLevel: "E3",
        findingIdentityKey: findingKey,
        initialFingerprint: "recur",
        currentFingerprint: "recur",
        status: "DETECTED",
        isOpen: true,
        priorTaskId: initialTask._id
      });

      assert.ok(recurredTask, "Recurred task must insert successfully once prior task is closed");
      assert.strictEqual(String(recurredTask.priorTaskId), String(initialTask._id));
    });
  });

  // ---------------------------------------------------------------------------
  // Proof E: Real Concurrent Lease Contention & Monotonic Fencing
  // ---------------------------------------------------------------------------
  describe("Proof E: Real Concurrent Lease Contention & Monotonic Fencing", () => {
    test("TEST-12: Real concurrency: Two independent workers compete for one eligible lease; exactly one succeeds", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const taskId = "REC:v1:test12_lease_race_0000000001";

      await TaskModel.create({
        taskId,
        taskKey: `GRP:${orderId}`,
        orderId,
        rule: "D01",
        code: "STOCK_NEGATIVE",
        classification: "DEFECT",
        severity: "CRITICAL",
        confidence: "HIGH",
        evidenceLevel: "E3",
        findingIdentityKey: taskId,
        initialFingerprint: "l12",
        currentFingerprint: "l12",
        status: "DETECTED",
        isOpen: true,
        leaseGeneration: 0n,
        attempts: 0
      });

      const ModelA = connectionClientA.model("RecoveryTask", TaskSchema);
      const ModelB = connectionClientB.model("RecoveryTask", TaskSchema);

      const leaseExpiry = new Date(Date.now() + 30000);

      // Both workers attempt atomic lease acquisition simultaneously
      const [claimA, claimB] = await Promise.all([
        ModelA.findOneAndUpdate(
          { taskId, isOpen: true, status: { $in: ["DETECTED", "RETRY_SCHEDULED"] } },
          {
            $set: {
              status: "LEASED",
              leaseOwner: "worker-A",
              leaseToken: "token-uuid-A",
              leaseUntil: leaseExpiry
            },
            $inc: { leaseGeneration: 1n, attempts: 1 }
          },
          { returnDocument: "after" }
        ),
        ModelB.findOneAndUpdate(
          { taskId, isOpen: true, status: { $in: ["DETECTED", "RETRY_SCHEDULED"] } },
          {
            $set: {
              status: "LEASED",
              leaseOwner: "worker-B",
              leaseToken: "token-uuid-B",
              leaseUntil: leaseExpiry
            },
            $inc: { leaseGeneration: 1n, attempts: 1 }
          },
          { returnDocument: "after" }
        )
      ]);

      const winners = [claimA, claimB].filter((c) => c !== null);
      const losers = [claimA, claimB].filter((c) => c === null);

      assert.strictEqual(winners.length, 1, "Exactly one worker must win the lease race");
      assert.strictEqual(losers.length, 1, "The competing worker must receive null (0 matched)");

      const winner = winners[0];
      assert.strictEqual(winner.status, "LEASED");
      assert.strictEqual(winner.leaseGeneration, 1n, "Lease generation must increment exactly once to 1n");
      assert.strictEqual(winner.attempts, 1);
    });

    test("TEST-13: Monotonic fencing rejects stale workers with expired tokens or old generations", async () => {
      const taskId = "REC:v1:test12_lease_race_0000000001";

      // Advance leaseUntil to past to simulate lease expiration
      await TaskModel.updateOne(
        { taskId },
        { $set: { leaseUntil: new Date(Date.now() - 5000) } }
      );

      // Worker 2 claims expired lease, advancing generation to 2n
      const claim2 = await TaskModel.findOneAndUpdate(
        { taskId, isOpen: true, status: "LEASED", leaseUntil: { $lt: new Date() } },
        {
          $set: {
            status: "LEASED",
            leaseOwner: "worker-2",
            leaseToken: "token-uuid-2",
            leaseUntil: new Date(Date.now() + 30000)
          },
          $inc: { leaseGeneration: 1n, attempts: 1 }
        },
        { returnDocument: "after" }
      );

      assert.ok(claim2);
      assert.strictEqual(claim2.leaseOwner, "worker-2");
      assert.strictEqual(claim2.leaseGeneration, 2n);

      // Stale Worker 1 attempts to write using old generation 1n
      const staleWrite = await TaskModel.updateOne(
        {
          taskId,
          isOpen: true,
          status: "LEASED",
          leaseGeneration: 1n // STALE
        },
        { $set: { resolution: "ALREADY_CORRECT" } }
      );

      assert.strictEqual(staleWrite.matchedCount, 0, "Stale worker write MUST match 0 documents");
      assert.strictEqual(staleWrite.modifiedCount, 0, "Stale worker write MUST NOT modify task");
    });
  });

  // ---------------------------------------------------------------------------
  // Proof F: Genuine Wire-Level Unknown-Commit Outcome & Reconciliation
  // ---------------------------------------------------------------------------
  describe("Proof F: Genuine Wire-Level Unknown-Commit Outcome & Reconciliation", () => {
    let proxyServer = null;
    let proxyDropCommitAck = false;
    let proxyIntercepted = false;
    let proxyAbortBeforeCommit = false;
    let lastInterceptedCommand = null;
    const activeProxySockets = new Set();

    // Test-local reconciliation protocol simulation helper (OD-10 / WP04-04 specification prototype)
    async function executeUnknownCommitReconciliation({
      tasksCollection,
      eventsCollection,
      taskId,
      orderId,
      targetEventId,
      targetSeq,
      leaseGeneration,
      actorId,
      simulateAuthoritativeReadFailure = false
    }) {
      if (simulateAuthoritativeReadFailure) {
        // Authoritative primary read failed (e.g. timeout / connection loss during reconciliation read)
        // Worker MUST fail closed: escalate task to MANUAL_REQUIRED with ESC_UNKNOWN_COMMIT
        const now = new Date();
        await tasksCollection.updateOne(
          { taskId, isOpen: true },
          {
            $set: {
              status: "MANUAL_REQUIRED",
              manualReasonCode: "PERSISTENCE_TIMEOUT",
              updatedAt: now,
              "escalation.code": "ESC_UNKNOWN_COMMIT",
              "escalation.actualStatus": "UNKNOWN_COMMIT_TIMED_OUT"
            }
          }
        );

        const escalationEventId = `EVT:${taskId}:ESC_${Date.now()}`;
        await eventsCollection.insertOne({
          eventId: escalationEventId,
          taskId,
          orderId,
          sequenceNumber: targetSeq,
          leaseGeneration,
          timestamp: now,
          eventType: "RECOVERY_MANUAL_REQUIRED",
          actorId,
          actorRole: "SERVICE-WORKER",
          actorType: "WORKER",
          evidenceDigest: "unknown_commit_escalation",
          details: {
            fromStatus: "LEASED",
            toStatus: "MANUAL_REQUIRED",
            attempts: 1,
            diagnosticCode: "TIMEOUT"
          }
        });

        return {
          action: "FAIL_CLOSED_ESCALATED",
          status: "MANUAL_REQUIRED",
          escalationCode: "ESC_UNKNOWN_COMMIT",
          escalationEventId
        };
      }

      // Normal reconciliation: Authoritative majority read on primary
      const committedEvent = await eventsCollection.findOne(
        { eventId: targetEventId },
        { readConcern: { level: "majority" } }
      );

      if (committedEvent) {
        const task = await tasksCollection.findOne({ taskId }, { readConcern: { level: "majority" } });
        return {
          action: "ADOPT_COMMITTED_STATE",
          status: task?.status,
          sequenceNumber: task?.eventSequenceCounter,
          event: committedEvent
        };
      }

      const task = await tasksCollection.findOne({ taskId }, { readConcern: { level: "majority" } });
      return {
        action: "SAFE_TO_RETRY",
        status: task?.status,
        sequenceNumber: task?.eventSequenceCounter
      };
    }

    before(async () => {
      // Guard proxy port before starting
      await guardPortAvailable(PROXY_PORT);

      // Setup loopback TCP proxy on port 27021 forwarding to 27019
      proxyServer = net.createServer((clientSocket) => {
        activeProxySockets.add(clientSocket);
        const serverSocket = net.connect({ port: REPLSET_PORT, host: "127.0.0.1" });
        activeProxySockets.add(serverSocket);

        clientSocket.on("data", (data) => {
          if (proxyDropCommitAck && data.includes(Buffer.from("commitTransaction"))) {
            proxyIntercepted = true;
            lastInterceptedCommand = "commitTransaction";
            if (proxyAbortBeforeCommit) {
              // Severe network failure before mongod receives commit:
              clientSocket.destroy(new Error("TCP Proxy: Severing connection before commit"));
              serverSocket.destroy();
              return;
            }
            // Forward commit to mongod so mongod COMMITS the transaction
            serverSocket.write(data);
            return;
          }
          serverSocket.write(data);
        });

        serverSocket.on("data", (data) => {
          if (proxyIntercepted && proxyDropCommitAck) {
            // Mongod answered commit! Drop response and sever client socket abruptly
            clientSocket.destroy(new Error("TCP Proxy: Dropping commit ACK"));
            return;
          }
          clientSocket.write(data);
        });

        clientSocket.on("error", () => {});
        serverSocket.on("error", () => {});
        clientSocket.on("close", () => {
          activeProxySockets.delete(clientSocket);
          serverSocket.destroy();
        });
        serverSocket.on("close", () => {
          activeProxySockets.delete(serverSocket);
          clientSocket.destroy();
        });
      });

      await new Promise((resolve) => proxyServer.listen(PROXY_PORT, "127.0.0.1", resolve));
      assert.strictEqual(proxyServer.listening, true, "Proxy server must be listening on port 27021");
    });

    after(() => {
      if (proxyServer) {
        for (const sock of activeProxySockets) {
          try {
            sock.destroy();
          } catch {}
        }
        activeProxySockets.clear();
        proxyServer.close();
        proxyServer.unref();
      }
    });

    test("TEST-14: Genuine unknown-commit when write committed: client encounters network error during commit, test helper reconciles without duplicate", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const taskId = "REC:v1:test14_genuine_unknown_commit_ack";
      const targetSeq = 1n;
      const targetEventId = `EVT:${taskId}:${targetSeq}`;

      await TaskModel.create({
        taskId,
        taskKey: `GRP:${orderId}`,
        orderId,
        rule: "D01",
        code: "STOCK_NEGATIVE",
        classification: "DEFECT",
        severity: "CRITICAL",
        confidence: "HIGH",
        evidenceLevel: "E3",
        findingIdentityKey: taskId,
        initialFingerprint: "uk14",
        currentFingerprint: "uk14",
        status: "LEASED",
        isOpen: true,
        leaseOwner: "worker-f",
        leaseToken: "token-f",
        leaseGeneration: 1n,
        eventSequenceCounter: 0n
      });

      // Connect independent client through TCP proxy on port 27021
      const proxyClient = new mongoose.mongo.MongoClient(
        `mongodb://127.0.0.1:${PROXY_PORT}/${testDbName}?directConnection=true&replicaSet=${REPLSET_NAME}&serverSelectionTimeoutMS=2000`,
        { maxPoolSize: 1 }
      );
      await proxyClient.connect();

      const session = proxyClient.startSession();
      session.startTransaction();

      const tasksCollProxy = proxyClient.db(testDbName).collection("inventory_recovery_tasks");
      const eventsCollProxy = proxyClient.db(testDbName).collection("inventory_recovery_events");

      await tasksCollProxy.updateOne(
        { taskId },
        { $inc: { eventSequenceCounter: 1n }, $set: { status: "RESOLVED", resolution: "ALREADY_CORRECT" } },
        { session }
      );

      await eventsCollProxy.insertOne(
        {
          eventId: targetEventId,
          taskId,
          orderId,
          sequenceNumber: targetSeq,
          leaseGeneration: 1n,
          timestamp: new Date(),
          eventType: "RECOVERY_RESOLVED",
          actorId: "worker-f",
          actorRole: "SERVICE-WORKER",
          actorType: "WORKER",
          evidenceDigest: "digest14",
          details: { fromStatus: "LEASED", toStatus: "RESOLVED", attempts: 1 }
        },
        { session }
      );

      // Enable wire-level ACK drop
      proxyDropCommitAck = true;
      proxyAbortBeforeCommit = false;
      proxyIntercepted = false;
      lastInterceptedCommand = null;

      let commitError = null;
      let interceptedDuringCommit = false;
      let commandDuringCommit = null;
      try {
        await session.commitTransaction();
      } catch (err) {
        commitError = err;
        interceptedDuringCommit = proxyIntercepted;
        commandDuringCommit = lastInterceptedCommand;
      } finally {
        proxyDropCommitAck = false;
        proxyIntercepted = false;
        lastInterceptedCommand = null;
        await session.endSession().catch(() => {});
        await proxyClient.close().catch(() => {});
      }

      // Assert that wire interception of commitTransaction actually occurred
      assert.strictEqual(interceptedDuringCommit, true, "TCP Proxy must have intercepted commitTransaction command");
      assert.strictEqual(commandDuringCommit, "commitTransaction", "Intercepted command must be commitTransaction");

      // Assert that a genuine unacknowledged network error occurred on commit
      assert.ok(commitError, "Client must receive network error during commit");
      assert.ok(
        commitError.name === "MongoNetworkError" ||
          commitError.name === "MongoServerSelectionError" ||
          (commitError.hasErrorLabel && commitError.hasErrorLabel("UnknownTransactionCommitResult")),
        `Error must be an ambiguous network commit error, got: ${commitError?.name} message: ${commitError?.message}`
      );

      // --- Reconciliation Protocol Simulation via Test Helper ---
      const directEvents = connectionPrimary.db.collection("inventory_recovery_events");
      const directTasks = connectionPrimary.db.collection("inventory_recovery_tasks");

      const recon = await executeUnknownCommitReconciliation({
        tasksCollection: directTasks,
        eventsCollection: directEvents,
        taskId,
        orderId,
        targetEventId,
        targetSeq,
        leaseGeneration: 1n,
        actorId: "worker-f"
      });

      assert.strictEqual(recon.action, "ADOPT_COMMITTED_STATE");
      assert.strictEqual(recon.status, "RESOLVED");
      assert.strictEqual(BigInt(recon.sequenceNumber), 1n);

      // Step 3: Prevent duplicate execution (worker knows sequence 1n was completed)
      let duplicateInsertError = null;
      try {
        await directEvents.insertOne({
          eventId: targetEventId,
          taskId,
          orderId,
          sequenceNumber: targetSeq,
          leaseGeneration: 1n,
          timestamp: new Date(),
          eventType: "RECOVERY_RESOLVED",
          actorId: "worker-f",
          actorRole: "SERVICE-WORKER",
          actorType: "WORKER",
          evidenceDigest: "digest14",
          details: { fromStatus: "LEASED", toStatus: "RESOLVED", attempts: 1 }
        });
      } catch (err) {
        duplicateInsertError = err;
      }
      assert.strictEqual(duplicateInsertError?.code, 11000, "IDX-EVT-01 prevents duplicate event persistence");
    });

    test("TEST-15: Genuine unknown-commit when write aborted: client encounters network disconnect before commit, reconciles absence, and retries exact same sequence", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const taskId = "REC:v1:test15_genuine_unknown_commit_abort";
      const targetSeq = 1n;
      const targetEventId = `EVT:${taskId}:${targetSeq}`;

      await TaskModel.create({
        taskId,
        taskKey: `GRP:${orderId}`,
        orderId,
        rule: "D01",
        code: "STOCK_NEGATIVE",
        classification: "DEFECT",
        severity: "CRITICAL",
        confidence: "HIGH",
        evidenceLevel: "E3",
        findingIdentityKey: taskId,
        initialFingerprint: "uk15",
        currentFingerprint: "uk15",
        status: "LEASED",
        isOpen: true,
        leaseOwner: "worker-f",
        leaseToken: "token-f",
        leaseGeneration: 1n,
        eventSequenceCounter: 0n
      });

      const proxyClient = new mongoose.mongo.MongoClient(
        `mongodb://127.0.0.1:${PROXY_PORT}/${testDbName}?directConnection=true&replicaSet=${REPLSET_NAME}&serverSelectionTimeoutMS=2000`,
        { maxPoolSize: 1 }
      );
      await proxyClient.connect();

      const session = proxyClient.startSession();
      session.startTransaction();

      const tasksCollProxy = proxyClient.db(testDbName).collection("inventory_recovery_tasks");
      const eventsCollProxy = proxyClient.db(testDbName).collection("inventory_recovery_events");

      await tasksCollProxy.updateOne({ taskId }, { $inc: { eventSequenceCounter: 1n } }, { session });
      await eventsCollProxy.insertOne(
        {
          eventId: targetEventId,
          taskId,
          orderId,
          sequenceNumber: targetSeq,
          leaseGeneration: 1n,
          timestamp: new Date(),
          eventType: "RECOVERY_RETRY_SCHEDULED",
          actorId: "worker-f",
          actorRole: "SERVICE-WORKER",
          actorType: "WORKER",
          evidenceDigest: "digest15",
          details: { fromStatus: "LEASED", toStatus: "RETRY_SCHEDULED", attempts: 1 }
        },
        { session }
      );

      const proxySessionId = session.id;

      // Enable sever before commit
      proxyDropCommitAck = true;
      proxyAbortBeforeCommit = true;
      proxyIntercepted = false;
      lastInterceptedCommand = null;

      let commitError = null;
      let interceptedDuringAbort = false;
      let commandDuringAbort = null;
      try {
        await session.commitTransaction();
      } catch (err) {
        commitError = err;
        interceptedDuringAbort = proxyIntercepted;
        commandDuringAbort = lastInterceptedCommand;
      } finally {
        proxyDropCommitAck = false;
        proxyAbortBeforeCommit = false;
        proxyIntercepted = false;
        lastInterceptedCommand = null;
        await session.endSession().catch(() => {});
        await proxyClient.close().catch(() => {});
      }

      // Assert that wire interception of commitTransaction actually occurred
      assert.strictEqual(interceptedDuringAbort, true, "TCP Proxy must have intercepted commitTransaction command before severing");
      assert.strictEqual(commandDuringAbort, "commitTransaction", "Intercepted command must be commitTransaction");
      assert.ok(commitError, "Client must receive connection severed error");

      // Terminate orphaned session on server to simulate server-side abort and free WiredTiger transaction row locks
      if (proxySessionId) {
        try {
          await connectionPrimary.db.admin().command({ killSessions: [proxySessionId] });
        } catch {}
      }

      // --- Reconciliation Protocol Simulation via Test Helper ---
      const directEvents = connectionPrimary.db.collection("inventory_recovery_events");
      const directTasks = connectionPrimary.db.collection("inventory_recovery_tasks");

      const recon = await executeUnknownCommitReconciliation({
        tasksCollection: directTasks,
        eventsCollection: directEvents,
        taskId,
        orderId,
        targetEventId,
        targetSeq,
        leaseGeneration: 1n,
        actorId: "worker-f"
      });

      assert.strictEqual(recon.action, "SAFE_TO_RETRY");
      assert.strictEqual(BigInt(recon.sequenceNumber), 0n);

      // Worker retries with the EXACT SAME sequence number 1n and EXACT SAME eventId
      let retrySuccess = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const retrySession = await connectionPrimary.startSession();
        try {
          retrySession.startTransaction();

          await directTasks.updateOne(
            { taskId, isOpen: true },
            { $inc: { eventSequenceCounter: 1n }, $set: { status: "RETRY_SCHEDULED" } },
            { session: retrySession }
          );

          await directEvents.insertOne(
            {
              eventId: targetEventId,
              taskId,
              orderId,
              sequenceNumber: 1n,
              leaseGeneration: 1n,
              timestamp: new Date(),
              eventType: "RECOVERY_RETRY_SCHEDULED",
              actorId: "worker-f",
              actorRole: "SERVICE-WORKER",
              actorType: "WORKER",
              evidenceDigest: "digest15",
              details: { fromStatus: "LEASED", toStatus: "RETRY_SCHEDULED", attempts: 1 }
            },
            { session: retrySession }
          );

          await retrySession.commitTransaction();
          retrySuccess = true;
          break;
        } catch (retryErr) {
          await retrySession.abortTransaction().catch(() => {});
          if (
            (retryErr.hasErrorLabel && retryErr.hasErrorLabel("TransientTransactionError")) ||
            retryErr.code === 112
          ) {
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          throw retryErr;
        } finally {
          await retrySession.endSession();
        }
      }
      assert.ok(retrySuccess, "Retry transaction must succeed");

      // Verify retry committed cleanly
      const finalTask = await TaskModel.findOne({ taskId });
      assert.strictEqual(finalTask.eventSequenceCounter, 1n);
      const finalEvent = await EventModel.findOne({ eventId: targetEventId });
      assert.ok(finalEvent);
      assert.strictEqual(finalEvent.sequenceNumber, 1n);
    });

    test("TEST-16: Ambiguous unknown-commit reconciliation: When authoritative read fails, protocol helper fails closed with ESC_UNKNOWN_COMMIT", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const taskId = "REC:v1:test16_ambiguous_unknown_commit";
      const targetSeq = 1n;
      const targetEventId = `EVT:${taskId}:${targetSeq}`;

      await TaskModel.create({
        taskId,
        taskKey: `GRP:${orderId}`,
        orderId,
        rule: "D01",
        code: "STOCK_NEGATIVE",
        classification: "DEFECT",
        severity: "CRITICAL",
        confidence: "HIGH",
        evidenceLevel: "E3",
        findingIdentityKey: taskId,
        initialFingerprint: "uk16",
        currentFingerprint: "uk16",
        status: "LEASED",
        isOpen: true,
        leaseOwner: "worker-f",
        leaseToken: "token-f",
        leaseGeneration: 1n,
        eventSequenceCounter: 0n
      });

      const directEvents = connectionPrimary.db.collection("inventory_recovery_events");
      const directTasks = connectionPrimary.db.collection("inventory_recovery_tasks");

      // Execute test-local reconciliation protocol helper with simulated authoritative primary read failure
      const outcome = await executeUnknownCommitReconciliation({
        tasksCollection: directTasks,
        eventsCollection: directEvents,
        taskId,
        orderId,
        targetEventId,
        targetSeq,
        leaseGeneration: 1n,
        actorId: "worker-f",
        simulateAuthoritativeReadFailure: true
      });

      assert.strictEqual(outcome.action, "FAIL_CLOSED_ESCALATED");
      assert.strictEqual(outcome.status, "MANUAL_REQUIRED");
      assert.strictEqual(outcome.escalationCode, "ESC_UNKNOWN_COMMIT");

      // Verify the task in MongoDB was actually updated to MANUAL_REQUIRED with ESC_UNKNOWN_COMMIT
      const escalatedTask = await TaskModel.findOne({ taskId });
      assert.ok(escalatedTask);
      assert.strictEqual(escalatedTask.status, "MANUAL_REQUIRED");
      assert.strictEqual(escalatedTask.manualReasonCode, "PERSISTENCE_TIMEOUT");
      assert.strictEqual(escalatedTask.escalation.code, "ESC_UNKNOWN_COMMIT");

      // Verify the audit event was actually persisted to MongoDB
      const escalatedEvent = await EventModel.findOne({ eventId: outcome.escalationEventId });
      assert.ok(escalatedEvent, "Audit event must be persisted to MongoDB");
      assert.strictEqual(escalatedEvent.eventType, "RECOVERY_MANUAL_REQUIRED");
      assert.strictEqual(escalatedEvent.details.toStatus, "MANUAL_REQUIRED");
      assert.strictEqual(escalatedEvent.details.diagnosticCode, "TIMEOUT");
    });
  });

  // ---------------------------------------------------------------------------
  // Proof G: Standalone MongoDB Topology Fail-Closed Behavior
  // ---------------------------------------------------------------------------
  describe("Proof G: Standalone Topology Fail-Closed Verification", () => {
    test("TEST-17: Standalone MongoDB topology rejects transactions and fails closed (TRANSACTIONS_UNAVAILABLE)", async () => {
      validateTargetSafety("127.0.0.1", STANDALONE_PORT, `${DB_PREFIX}standalone_proof`);

      // Strict Process Ownership Guard for standalone test
      await guardPortAvailable(STANDALONE_PORT);

      let standaloneError = null;
      let standaloneOwnerVerified = false;
      const standaloneTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bono-standalone-proof-"));
      const standaloneProc = spawn(
        MONGOD_PATH,
        [
          "--dbpath",
          standaloneTempDir,
          "--port",
          String(STANDALONE_PORT),
          "--bind_ip",
          "127.0.0.1"
        ],
        { stdio: "ignore" }
      );

      standaloneProc.on("error", (err) => {
        standaloneError = err;
      });
      standaloneProc.on("exit", (code, signal) => {
        if (code !== 0 && code !== null) {
          standaloneError = new Error(`standalone mongod exited prematurely with code ${code}, signal ${signal}`);
        }
      });

      assert.ok(standaloneProc.pid, "Standalone mongod must have a valid PID");

      // Verify process ownership before issuing any command:
      // Never treat a listening port as proof that the spawned process owns it.
      await verifyProcessOwnership(standaloneProc, STANDALONE_PORT, 15000);
      if (standaloneError) throw standaloneError;
      standaloneOwnerVerified = true;

      const standaloneUri = `mongodb://127.0.0.1:${STANDALONE_PORT}/${DB_PREFIX}standalone_proof?directConnection=true`;
      const standaloneConn = await mongoose.createConnection(standaloneUri).asPromise();

      // Preflight topology verification: inspect hello
      const hello = await standaloneConn.db.command({ hello: 1 });
      const isReplicaSet = typeof hello.setName === "string" && Boolean(hello.isWritablePrimary);
      assert.strictEqual(isReplicaSet, false, "Standalone instance must not report a replicaSetName");

      // Verify fail-closed behavior: attempt multi-document transaction
      let transactionError = null;
      const session = await standaloneConn.startSession();
      try {
        session.startTransaction();
        const StandaloneModel = standaloneConn.model(
          "StandaloneProof",
          new mongoose.Schema({ name: String })
        );
        await StandaloneModel.createCollection();
        await StandaloneModel.create([{ name: "will_fail" }], { session });
        await session.commitTransaction();
      } catch (err) {
        transactionError = err;
      } finally {
        await session.endSession().catch(() => {});
        if (standaloneOwnerVerified && standaloneConn) {
          try {
            await standaloneConn.dropDatabase();
          } catch {}
          try {
            await standaloneConn.db.admin().command({ shutdown: 1 });
          } catch {}
          try {
            await standaloneConn.close(true);
          } catch {}
        }

        if (standaloneOwnerVerified && standaloneProc && standaloneProc.pid) {
          try {
            standaloneProc.kill();
          } catch {}
          await new Promise((r) => {
            if (standaloneProc.killed || standaloneProc.exitCode !== null) return r();
            standaloneProc.on("close", r);
            setTimeout(r, 1000).unref();
          });
          for (let i = 0; i < 5; i++) {
            try {
              fs.rmSync(standaloneTempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
              break;
            } catch (err) {
              if (i === 4) {
                console.error("Error removing standalone temp dir:", err.message);
              } else {
                await new Promise((r) => setTimeout(r, 300));
              }
            }
          }
        }
      }

      assert.ok(transactionError, "Transaction MUST be rejected on standalone topology");
      assert.ok(
        transactionError.message.includes("does not support retryable writes") ||
          transactionError.message.includes("Transaction numbers are only allowed on a replica set member") ||
          transactionError.code === 20,
        `Expected fail-closed transaction rejection, got: ${transactionError.message}`
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Proof H: Real WP04-01 Evidence Projection Integration & Security
  // ---------------------------------------------------------------------------
  describe("Proof H: Authoritative Evidence Projection Integration & Security", () => {
    test("TEST-18: Real WP04-01 projectEvidence integration: valid V1 evidence projects allowlist; forbidden nested fields rejected", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const itemId = new mongoose.Types.ObjectId();

      const rawEvidence = {
        order: {
          _id: orderId,
          orderNumber: "ORD-991",
          status: "PAID",
          paidAt: new Date(),
          paymentMethod: "CASH",
          paymentAccountId: null,
          items: [
            {
              lineId: "line-1",
              type: "FOOD",
              quantity: 2,
              cancelled: false,
              components: [
                {
                  componentId: "comp-1",
                  kind: "PORTION",
                  inventoryItemId: itemId,
                  stockQuantity: 2.0
                }
              ]
            }
          ]
        },
        reservation: {
          _id: new mongoose.Types.ObjectId(),
          orderId,
          status: "RELEASED",
          releasedReason: "CONSUMPTION_FAILED",
          items: [
            {
              lineId: "line-1",
              inventoryItemId: itemId,
              quantity: 2.0,
              reservedQuantity: 2.0,
              consumedQuantity: 0.0
            }
          ]
        },
        movements: [],
        inventory: [
          {
            _id: itemId,
            currentStock: 10.0,
            reservedStock: 0.0
          }
        ]
      };

      // 1. Authoritative projection via lib/recovery/evidence.js
      const projected = projectEvidence(rawEvidence);
      assert.strictEqual(projected.schema, EVIDENCE_SCHEMA_VERSION);
      assert.strictEqual(projected.order.status, "PAID");
      assert.strictEqual(projected.reservation.status, "RELEASED");
      // Verify allowlist drop: releasedReason is not an approved projected field
      assert.strictEqual(projected.reservation.releasedReason, undefined, "Allowlist must drop unapproved field releasedReason");

      // Verify that the projected output persists safely into EventModel
      const taskId = "REC:v1:test18_evidence_projection_proof";
      const event = await EventModel.create({
        eventId: `EVT:${taskId}:1`,
        taskId,
        orderId,
        sequenceNumber: 1n,
        leaseGeneration: 1n,
        timestamp: new Date(),
        eventType: "RECOVERY_DETECTED",
        actorId: "scanner-1",
        actorRole: "SERVICE-WORKER",
        actorType: "SCANNER",
        evidenceDigest: "digest18",
        projectedEvidence: projected,
        details: { toStatus: "DETECTED", attempts: 0 }
      });

      assert.ok(event);
      assert.strictEqual(event.projectedEvidence.schema, EVIDENCE_SCHEMA_VERSION);

      // 2. Verify sensitive credentials in raw evidence are dropped by projection allowlisting
      const rawEvidenceWithInjectedSecrets = {
        ...rawEvidence,
        order: {
          ...rawEvidence.order,
          pin: "1234",
          secretKey: "supersecret",
          accountNumber: "4000123456789010"
        }
      };

      const projectedClean = projectEvidence(rawEvidenceWithInjectedSecrets);
      assert.strictEqual(projectedClean.order.pin, undefined, "Allowlist must drop pin");
      assert.strictEqual(projectedClean.order.secretKey, undefined, "Allowlist must drop secretKey");
      assert.strictEqual(projectedClean.order.accountNumber, undefined, "Allowlist must drop accountNumber");

      // 3. Schema validator rejection: verify that unprojected objects with forbidden sensitive keys fail validation
      let schemaValidationError = null;
      try {
        await EventModel.create({
          eventId: `EVT:${taskId}:forbidden_secret`,
          taskId,
          orderId,
          sequenceNumber: 99n,
          leaseGeneration: 1n,
          timestamp: new Date(),
          eventType: "RECOVERY_DETECTED",
          actorId: "scanner-1",
          actorRole: "SERVICE-WORKER",
          actorType: "SCANNER",
          evidenceDigest: "digest_bad",
          projectedEvidence: {
            order: {
              accountNumber: "100012345678" // FORBIDDEN KEY
            }
          },
          details: { toStatus: "DETECTED", attempts: 0 }
        });
      } catch (err) {
        schemaValidationError = err;
      }

      assert.ok(schemaValidationError, "Schema must reject documents containing forbidden sensitive keys");
      assert.ok(
        schemaValidationError.message.includes("projectedEvidence contains forbidden sensitive keys") ||
          schemaValidationError.name === "ValidationError",
        "Error must be a schema validation error for sensitive keys"
      );
    });

    test("TEST-19: Quantity escalation fields store finite numbers bounded to [0, 1000000] and reject negative, above-maximum, NaN, and Infinity", async () => {
      const orderId = new mongoose.Types.ObjectId();
      const taskId = "REC:v1:test19_quantity_proof_0000001";

      // 1. Valid finite values succeed
      const task = await TaskModel.create({
        taskId,
        taskKey: `GRP:${orderId}`,
        orderId,
        rule: "D01",
        code: "STOCK_NEGATIVE",
        classification: "DEFECT",
        severity: "CRITICAL",
        confidence: "HIGH",
        evidenceLevel: "E3",
        findingIdentityKey: taskId,
        initialFingerprint: "q19",
        currentFingerprint: "q19",
        status: "MANUAL_REQUIRED",
        isOpen: true,
        escalation: {
          code: "ESC_MANUAL_RULE",
          expectedStatus: "SERVED",
          actualStatus: "SERVED",
          expectedQuantity: 5.5,
          actualQuantity: 2.125
        }
      });

      assert.strictEqual(task.escalation.expectedQuantity, 5.5);
      assert.strictEqual(task.escalation.actualQuantity, 2.125);
      assert.strictEqual(typeof task.escalation.expectedQuantity, "number");

      // Helper to assert validation rejection
      async function assertInvalidQuantity(val, label) {
        let err = null;
        try {
          await TaskModel.create({
            taskId: `REC:v1:test19_bad_${randomBytes(4).toString("hex")}`,
            taskKey: `GRP:${orderId}`,
            orderId,
            rule: "D01",
            code: "STOCK_NEGATIVE",
            classification: "DEFECT",
            severity: "CRITICAL",
            confidence: "HIGH",
            evidenceLevel: "E3",
            findingIdentityKey: `REC:v1:bad_${randomBytes(4).toString("hex")}`,
            initialFingerprint: "q19_bad",
            currentFingerprint: "q19_bad",
            status: "MANUAL_REQUIRED",
            isOpen: true,
            escalation: {
              code: "ESC_MANUAL_RULE",
              expectedQuantity: val,
              actualQuantity: 1.0
            }
          });
        } catch (e) {
          err = e;
        }
        assert.ok(err, `Must reject ${label} quantity value: ${String(val)}`);
        assert.strictEqual(err.name, "ValidationError", `Rejection of ${label} must be a ValidationError`);
      }

      // 2. Negative quantity rejected
      await assertInvalidQuantity(-1, "negative");
      await assertInvalidQuantity(-0.0001, "negative fraction");

      // 3. Above-maximum quantity rejected
      await assertInvalidQuantity(1000001, "above-maximum");
      await assertInvalidQuantity(1000000.001, "above-maximum fraction");

      // 4. NaN rejected
      await assertInvalidQuantity(NaN, "NaN");

      // 5. Infinity and -Infinity rejected
      await assertInvalidQuantity(Infinity, "positive Infinity");
      await assertInvalidQuantity(-Infinity, "negative Infinity");
    });
  });
});
