// WP04-06 — Disposable T2 integration runner.
//
// STATUS: T2 WAS ACCEPTED UNDER OD-35 ON THE 2026-11-14 RUN
// wp04-06-t2-94e4714b61c9; this runner output still records `t2: "OPEN"` by
// design and never closes T2 or any blocker from its own output. The runner
// additionally carries the T5-CRASH/T8-CRASH disposable crash/restart proof
// behind the same explicit execution gates.
//
// This runner is intentionally inert unless every explicit execution gate is
// supplied:
//   --execute
//   --run-id wp04-06-t2-<12 lowercase hex>
//   --confirm START-DISPOSABLE-MONGOD
//
// It starts an isolated loopback-only mongod under os.tmpdir(), uses the pure
// OP_MSG parser, and verifies outcomes with a separate direct-connection
// primary/majority client that does not import the proxy under test.
//
// It does not read .env files or production credentials. It never attaches to a
// pre-existing listener. It never kills a process it did not spawn. It removes
// only a temp directory that carries its own run marker, and only after the
// spawned child is confirmed exited.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";

import { createCommitAwareProxy, PROXY_MODES } from "./support/t2Proxy.mjs";
import {
  NEGATIVE_CONTROL_COLLECTION,
  REAL_WRITER_MODULE,
  assertRealWriterScenarioEvidence,
  buildNegativeControlMarker,
  buildRealWriterScenario,
  createRealWriterHarness,
  runRealWriterEffect,
  runRealWriterSetup
} from "./support/t2RealWriter.mjs";
import {
  WP04_COLLECTIONS,
  createIndependentVerifierClient,
  readReplicaSetStateWithIndependentClient,
  verifyMarkerWithIndependentClient,
  verifyWp04AbandonmentStateWithIndependentClient,
  verifyWp04EffectStateWithIndependentClient
} from "./support/t2Verifier.mjs";
import {
  CRASH_WORKER_MODULE,
  CRASH_WORKER_ROLES,
  serializeCrashScenarioSpec
} from "./support/t2CrashWorker.mjs";

const require = createRequire(import.meta.url);
const DRIVER_VERSION = require("mongodb/package.json").version;

const DEFAULT_MONGOD_PATH = "C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe";
const DEFAULT_MONGOD_PORT = 27031;
const DEFAULT_PROXY_PORT = 27032;
const REPLICA_SET_NAME = "bonowp0406t2rs";
const DB_PREFIX = "bono_recovery_wp04_06_t2_";
const TEMP_PREFIX = "bono-wp04-06-t2-";
const OWNER_MARKER = ".wp04-06-t2-owner.json";
const RUN_ID_PATTERN = /^wp04-06-t2-[a-f0-9]{12}$/;
const CONFIRM_TOKEN = "START-DISPOSABLE-MONGOD";
const PROHIBITED_PORTS = new Set([27017, 27018]);
// Overall `withTransaction()` timeout for the disposable T2 effect transaction:
// it covers execution of the transaction callback plus the driver's commit and
// retry handling inside that call. It is not only a commit-retry deadline, and
// it is a harness-only setting — not a production writer timeout.
const EFFECT_TRANSACTION_TIMEOUT_MS = 2_000;

// T8-CRASH: the victim's original lease must be expired by server time before
// the authorized W8 abandonment, so this run uses a short disposable harness
// lease instead of the accepted one-hour default.
const T8_CRASH_LEASE_MS = 2_000;
const T5_CRASH_LABEL = "T5-CRASH";
const T8_CRASH_LABEL = "T8-CRASH";
const CRASH_WORKER_STATUS_TIMEOUT_MS = 45_000;
// The T8 fresh W8 call can legitimately take longer than any other wait: the
// victim's uncommitted transaction keeps its locks until mongod's
// transactionLifetimeLimitSeconds reaper runs (default 60s after the kill), and
// the W7 CAS transient-retry loop must outlive that window. 150s covers the
// 60s reaper plus driver retry/backoff margin.
const T8_FRESH_W8_TIMEOUT_MS = 150_000;
const CRASH_SCRATCH_PREFIX = "bono-wp04-06-t2-crash-";

const EVIDENCE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "production-readiness",
  "evidence"
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextArgument(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Argument '${flag}' requires a value.`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = {
    execute: false,
    runId: null,
    confirm: null,
    mongodPath: DEFAULT_MONGOD_PATH,
    mongodPort: DEFAULT_MONGOD_PORT,
    proxyPort: DEFAULT_PROXY_PORT,
    keepTemp: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--execute":
        args.execute = true;
        break;
      case "--run-id":
        args.runId = nextArgument(argv, index, flag);
        index += 1;
        break;
      case "--confirm":
        args.confirm = nextArgument(argv, index, flag);
        index += 1;
        break;
      case "--mongod":
        args.mongodPath = nextArgument(argv, index, flag);
        index += 1;
        break;
      case "--mongod-port":
        args.mongodPort = Number.parseInt(nextArgument(argv, index, flag), 10);
        index += 1;
        break;
      case "--proxy-port":
        args.proxyPort = Number.parseInt(nextArgument(argv, index, flag), 10);
        index += 1;
        break;
      case "--keep-temp":
        args.keepTemp = true;
        break;
      default:
        throw new Error(`Unknown argument '${flag}'.`);
    }
  }

  return args;
}

/**
 * M4: only an absolute path to a file literally named mongod/mongod.exe is
 * accepted. This prevents an arbitrary executable from being launched through
 * --mongod while still allowing a versioned installation directory.
 */
export function validateMongodExecutable(mongodPath) {
  if (typeof mongodPath !== "string" || !path.isAbsolute(mongodPath)) {
    throw new Error("--mongod must be an absolute path to a mongod executable.");
  }
  const resolved = path.resolve(mongodPath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`mongod binary not found at '${resolved}'.`);
  }
  if (!stat.isFile()) {
    throw new Error(`--mongod '${resolved}' is not a regular file.`);
  }
  const realPath = fs.realpathSync(resolved);
  const baseName = path.basename(realPath).toLowerCase();
  if (baseName !== "mongod" && baseName !== "mongod.exe") {
    throw new Error(
      `--mongod must point to an executable named mongod or mongod.exe, got '${path.basename(realPath)}'.`
    );
  }
  return realPath;
}

export function assertExecutionAuthorized(args) {
  if (!args.execute) return false;

  if (!RUN_ID_PATTERN.test(args.runId ?? "")) {
    throw new Error("--run-id must match wp04-06-t2-<12 lowercase hex>.");
  }
  if (args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`--confirm must be exactly '${CONFIRM_TOKEN}'.`);
  }
  if (!Number.isInteger(args.mongodPort) || !Number.isInteger(args.proxyPort)) {
    throw new Error("MongoDB and proxy ports must be integers.");
  }
  if (args.mongodPort === args.proxyPort) {
    throw new Error("MongoDB and proxy ports must differ.");
  }
  for (const port of [args.mongodPort, args.proxyPort]) {
    if (port < 1024 || port > 65535) {
      throw new Error(`Port ${port} is outside the allowed disposable range.`);
    }
    if (PROHIBITED_PORTS.has(port)) {
      throw new Error(`Port ${port} is a prohibited application port.`);
    }
  }
  args.mongodPath = validateMongodExecutable(args.mongodPath);
  return true;
}

function printPlan() {
  const exampleRunId = `wp04-06-t2-${crypto.randomBytes(6).toString("hex")}`;
  process.stdout.write(
    [
      "WP04-06 T2 disposable harness — AUTHORED, NOT EXECUTED",
      "",
      "This runner is inert by design. No mongod has been started and no database",
      "has been contacted by this invocation.",
      "",
      "To execute under a separate owner authorization, supply:",
      `  --execute --run-id ${exampleRunId} --confirm ${CONFIRM_TOKEN}`,
      "",
      "Scenarios:",
      "  T2-A  pre-commit severance (commit frame withheld before forward)",
      "  T2-B  post-commit acknowledgement loss (commit forwarded, ACK dropped)",
      "  T2-C  negative control (non-commit command containing 'commitTransaction')",
      "  T5-CRASH  SIGKILL of a disposable child writer after W1/W2/W6; a fresh",
      "            child reconciles read-only (HOLD, zero writes) then completes",
      "            W7 at the exact durable reserved identity",
      "  T8-CRASH  SIGKILL mid-W7 via the withhold-hold proxy; the fresh child",
      "            verifies the durable PREPARED world and executes the",
      "            separately authorized OD-37 W8 abandonment after lease expiry",
      "",
      "The P4 verifier uses a separate MongoClient, directConnection: true,",
      "readPreference primary, and readConcern majority. It reads the actual WP04",
      "task, event, and operation-history collections. It does not import or call",
      "the proxy module.",
      "T2 remains OPEN until separately authorized execution produces verified evidence.",
      ""
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// Process ownership and port guards
// ---------------------------------------------------------------------------

function findListenerPid(port) {
  if (process.platform === "win32") {
    const output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[0] === "TCP" && parts[3] === "LISTENING") {
        if (parts[1].endsWith(`:${port}`)) {
          const pid = Number.parseInt(parts[4], 10);
          if (Number.isInteger(pid)) return pid;
        }
      }
    }
    return null;
  }

  try {
    const output = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" }
    );
    const pid = Number.parseInt(output.trim().split(/\s+/)[0], 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function assertPortFree(port) {
  const listenerPid = findListenerPid(port);
  if (listenerPid !== null) {
    throw new Error(
      `BLOCKER: port ${port} already has listener PID ${listenerPid}. ` +
        "Refusing to attach to an unverified listener."
    );
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForOwnedListener(proc, port, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `mongod exited prematurely with code ${proc.exitCode}, signal ${proc.signalCode}.`
      );
    }
    const listenerPid = findListenerPid(port);
    if (listenerPid !== null) {
      if (listenerPid !== proc.pid) {
        throw new Error(
          `OWNERSHIP VIOLATION: port ${port} is owned by PID ${listenerPid}, ` +
            `but the spawned mongod is PID ${proc.pid}. Refusing to attach or signal.`
        );
      }
      return;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for owned mongod PID ${proc.pid} on port ${port}.`);
}

function spawnMongod({ mongodPath, dbPath, port }) {
  const logPath = path.join(dbPath, "mongod.log");
  return spawn(
    mongodPath,
    [
      "--dbpath", dbPath,
      "--port", String(port),
      "--bind_ip", "127.0.0.1",
      "--replSet", REPLICA_SET_NAME,
      "--oplogSize", "128",
      "--storageEngine", "wiredTiger",
      "--logpath", logPath,
      "--logappend"
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"]
    }
  );
}

/**
 * H3: an exit is either an exit code or a signal. The old implementation only
 * checked exitCode, so a signal-terminated child looked alive forever.
 */
export async function waitForExit(proc, timeoutMs) {
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  if (exited()) return true;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof proc.removeListener === "function") {
        proc.removeListener("exit", finish);
      }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof proc.once === "function") {
      proc.once("exit", finish);
    } else {
      finish();
    }
  });

  return exited();
}

// ---------------------------------------------------------------------------
// Isolated temp path and cleanup safeguards
// ---------------------------------------------------------------------------

/**
 * H4: create the run-ID directory exclusively and write the owner marker with
 * exclusive creation. A pre-existing run-ID directory is never adopted,
 * overwritten, or removed.
 */
export function createOwnedTempPath(baseTemp, runId, deps = {}) {
  const exists = deps.exists ?? ((target) => fs.existsSync(target));
  const mkdir = deps.mkdir ?? ((target) => fs.mkdirSync(target));
  const writeFile = deps.writeFile ?? fs.writeFileSync;

  if (!RUN_ID_PATTERN.test(runId ?? "")) {
    throw new Error(`Refusing temp path for invalid run ID '${runId}'.`);
  }

  const resolvedBase = path.resolve(baseTemp);
  const dbPath = path.join(resolvedBase, runId);
  if (path.dirname(path.resolve(dbPath)) !== resolvedBase) {
    throw new Error(`Refusing temp path outside the base directory: ${dbPath}`);
  }
  if (exists(dbPath)) {
    throw new Error(`Refusing pre-existing run-ID directory: ${dbPath}`);
  }

  try {
    mkdir(dbPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Refusing pre-existing run-ID directory: ${dbPath}`);
    }
    throw error;
  }

  const markerPath = path.join(dbPath, OWNER_MARKER);
  const marker = JSON.stringify(
    {
      runId,
      createdAt: new Date().toISOString(),
      harness: "wp04-06-t2",
      note: "Disposable loopback T2 database path. Safe to remove only for this runId."
    },
    null,
    2
  );

  try {
    writeFile(markerPath, marker, { flag: "wx" });
  } catch (error) {
    // The directory was created by us, but the marker could not be established
    // exclusively. Fail closed and leave the directory for manual inspection.
    const failure = new Error(
      `Refusing to adopt temp path because the owner marker could not be created exclusively: ${error.message}`
    );
    failure.dbPath = dbPath;
    failure.code = error.code ?? "OWNER_MARKER_FAILED";
    throw failure;
  }

  return dbPath;
}

export function isOwnedTempPath(dbPath, baseTemp, runId) {
  const resolvedBase = path.resolve(baseTemp);
  const resolvedDb = path.resolve(dbPath);
  const relative = path.relative(resolvedBase, resolvedDb);

  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  if (path.basename(resolvedDb) !== runId) return false;

  const markerPath = path.join(resolvedDb, OWNER_MARKER);
  if (!fs.existsSync(markerPath)) return false;

  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return marker.runId === runId;
  } catch {
    return false;
  }
}

/**
 * H2-H4: cleanup fails closed.
 *
 * - A child is confirmed exited only when exitCode or signalCode is set, or the
 *   PID is no longer alive and no listener belongs to another process.
 * - A listener owned by a different PID blocks both signalling and removal.
 * - The dbPath is retained until the owned child is confirmed exited and no
 *   ownership ambiguity remains.
 * - Every refusal is recorded as a blocker, not just a note.
 */
export async function cleanup({
  proc,
  port,
  dbPath,
  baseTemp,
  runId,
  keepTemp,
  spawned = proc !== null && proc !== undefined,
  deps = {}
}) {
  const findListener = deps.findListenerPid ?? findListenerPid;
  const waitExit = deps.waitForExit ?? waitForExit;
  const owned = deps.isOwnedTempPath ?? isOwnedTempPath;
  const removePath =
    deps.removePath ?? ((target) => fs.rmSync(target, { recursive: true, force: true }));
  const kill = deps.kill ?? ((target, signal) => target.kill(signal));
  const alive = deps.isProcessAlive ?? isProcessAlive;

  const result = {
    mongodStopped: false,
    dbPathRemoved: false,
    keptTemp: false,
    notes: [],
    blockers: []
  };

  const childPresent = Boolean(spawned && proc && Number.isInteger(proc.pid));
  let childExited =
    !childPresent || proc.exitCode !== null || proc.signalCode !== null;
  let ownershipAmbiguous = false;

  if (childPresent && !childExited) {
    let listenerPid = null;
    let listenerCheckFailed = false;
    try {
      listenerPid = findListener(port);
    } catch (error) {
      listenerCheckFailed = true;
      ownershipAmbiguous = true;
      result.notes.push(`Listener ownership check failed: ${error.message}`);
      result.blockers.push({
        code: "LISTENER_CHECK_FAILED",
        message: error.message
      });
    }

    if (!listenerCheckFailed && listenerPid !== null && listenerPid !== proc.pid) {
      ownershipAmbiguous = true;
      result.notes.push(
        `REFUSED to stop listener PID ${listenerPid}: it is not the spawned PID ${proc.pid}.`
      );
      result.blockers.push({
        code: "OWNERSHIP_AMBIGUOUS",
        expectedPid: proc.pid,
        listenerPid
      });
    } else if (!listenerCheckFailed && listenerPid === null && !alive(proc.pid)) {
      childExited = true;
      result.mongodStopped = true;
      result.notes.push(`PID ${proc.pid} is no longer alive; no signal was sent.`);
    } else if (!listenerCheckFailed) {
      try {
        kill(proc, "SIGTERM");
      } catch (error) {
        result.notes.push(`SIGTERM failed: ${error.message}`);
      }
      childExited =
        (await waitExit(proc, 15_000)) ||
        proc.exitCode !== null ||
        proc.signalCode !== null;

      if (!childExited) {
        try {
          kill(proc, "SIGKILL");
        } catch (error) {
          result.notes.push(`SIGKILL failed: ${error.message}`);
        }
        childExited =
          (await waitExit(proc, 5_000)) ||
          proc.exitCode !== null ||
          proc.signalCode !== null;
      }

      result.mongodStopped = childExited;
      if (!childExited) {
        result.blockers.push({ code: "CHILD_STILL_ALIVE", pid: proc.pid });
      }
    }

    try {
      const listenerAfter = findListener(port);
      if (listenerAfter !== null && listenerAfter !== proc.pid) {
        ownershipAmbiguous = true;
        result.blockers.push({ code: "PORT_REBOUND", listenerPid: listenerAfter });
      }
    } catch (error) {
      ownershipAmbiguous = true;
      result.blockers.push({
        code: "LISTENER_CHECK_FAILED_AFTER_STOP",
        message: error.message
      });
    }
  } else if (childPresent) {
    result.mongodStopped = true;
    result.notes.push(
      `Spawned PID ${proc.pid} was already exited (code ${proc.exitCode}, signal ${proc.signalCode}).`
    );
  }

  if (keepTemp) {
    result.keptTemp = true;
    result.notes.push(`Temp path retained by request: ${dbPath}`);
  } else if (!dbPath || !baseTemp) {
    result.notes.push("No owned temp path was created; nothing to remove.");
  } else if (!owned(dbPath, baseTemp, runId)) {
    result.notes.push(`REFUSED to remove unverified temp path: ${dbPath}`);
    result.blockers.push({ code: "TEMP_PATH_NOT_OWNED", dbPath });
  } else if (ownershipAmbiguous) {
    result.notes.push(
      `REFUSED to remove temp path while listener ownership is ambiguous: ${dbPath}`
    );
    result.blockers.push({ code: "TEMP_PATH_RETAINED_OWNERSHIP_AMBIGUOUS", dbPath });
  } else if (childPresent && !childExited) {
    result.notes.push(
      `REFUSED to remove temp path until the owned child is confirmed exited: ${dbPath}`
    );
    result.blockers.push({ code: "TEMP_PATH_RETAINED_CHILD_ALIVE", dbPath });
  } else {
    try {
      removePath(dbPath);
      result.dbPathRemoved = true;
    } catch (error) {
      result.notes.push(`Temp path removal failed: ${error.message}`);
      result.blockers.push({
        code: "TEMP_PATH_REMOVE_FAILED",
        dbPath,
        message: error.message
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Replica set and environment evidence
// ---------------------------------------------------------------------------

async function initReplicaSet({ mongodPort, replicaSetName }) {
  const uri = `mongodb://127.0.0.1:${mongodPort}/?directConnection=true`;
  const client = new MongoClient(uri, {
    directConnection: true,
    serverSelectionTimeoutMS: 20_000
  });

  try {
    await client.connect();
    const admin = client.db("admin");

    try {
      await admin.command({
        replSetInitiate: {
          _id: replicaSetName,
          members: [{ _id: 0, host: `127.0.0.1:${mongodPort}` }]
        }
      });
    } catch (error) {
      if (error.code !== 23 && error.codeName !== "AlreadyInitialized") throw error;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
      try {
        const hello = await admin.command({ hello: 1 });
        if (hello.isWritablePrimary === true && hello.setName === replicaSetName) {
          const status = await admin.command({ replSetGetStatus: 1 });
          return {
            setName: status.set,
            myState: status.myState,
            members: status.members.map((member) => ({
              name: member.name,
              stateStr: member.stateStr,
              health: member.health
            }))
          };
        }
      } catch {
        // The node may be reconfiguring; retry until the deadline.
      }
      await delay(500);
    }
    throw new Error("Replica set did not elect a writable primary.");
  } finally {
    await client.close();
  }
}

/**
 * P6 oplog correction: MongoDB 8.0 only includes the top-level `oplog` server
 * status section when it is explicitly requested (`serverStatus: 1, oplog: 1`),
 * and that section reports `latestOptime`/`earliestOptime`, not the legacy
 * `size`/`used`/`timeDiff` fields. Oplog capacity is captured separately from
 * `getCmdLineOpts`. This pure mapper keeps the evidence shape testable without
 * a database and never invents a value when the section is absent.
 */
export function buildEnvironmentEvidence({
  node = process.version,
  driver = DRIVER_VERSION,
  osLabel = `${os.type()} ${os.release()} ${os.arch()}`,
  mongodPath,
  buildInfo = {},
  cmdLine = {},
  serverStatus = {},
  replicaStatus = {},
  mongodPort,
  proxyPort,
  host = os.hostname()
} = {}) {
  const oplog = serverStatus?.oplog;
  const hasOplogWindow =
    oplog !== null &&
    typeof oplog === "object" &&
    (oplog.latestOptime !== undefined || oplog.earliestOptime !== undefined);
  return {
    node,
    driver,
    os: osLabel,
    mongodPath,
    mongodbVersion: buildInfo?.version ?? null,
    mongodbGitVersion: buildInfo?.gitVersion ?? null,
    replicaSetName: replicaStatus?.set ?? null,
    ports: { mongod: mongodPort, proxy: proxyPort },
    bindIp: "127.0.0.1",
    storageEngine: serverStatus?.storageEngine?.name ?? null,
    oplogSizeMB: cmdLine?.parsed?.replication?.oplogSizeMB ?? null,
    oplog: hasOplogWindow
      ? {
          latestOptime: oplog.latestOptime ?? null,
          earliestOptime: oplog.earliestOptime ?? null
        }
      : null,
    host
  };
}

async function collectEnvironment({ mongodPath, mongodPort, proxyPort }) {
  const uri = `mongodb://127.0.0.1:${mongodPort}/?directConnection=true`;
  const client = new MongoClient(uri, { directConnection: true });
  try {
    await client.connect();
    const admin = client.db("admin");
    const buildInfo = await admin.command({ buildInfo: 1 });
    const cmdLine = await admin.command({ getCmdLineOpts: 1 });
    // P6: `oplog` is not included by default in MongoDB 8.0; request it.
    const serverStatus = await admin.command({ serverStatus: 1, oplog: 1 });
    const replicaStatus = await admin.command({ replSetGetStatus: 1 });

    return buildEnvironmentEvidence({
      mongodPath,
      buildInfo,
      cmdLine,
      serverStatus,
      replicaStatus,
      mongodPort,
      proxyPort
    });
  } finally {
    await client.close();
  }
}

async function prepareDatabase({ mongodPort, dbName }) {
  const uri = `mongodb://127.0.0.1:${mongodPort}/?directConnection=true`;
  const client = new MongoClient(uri, { directConnection: true });
  try {
    await client.connect();
    for (const collectionName of [...Object.values(WP04_COLLECTIONS), NEGATIVE_CONTROL_COLLECTION]) {
      try {
        await client.db(dbName).createCollection(collectionName);
      } catch (error) {
        if (error.code !== 48 && error.codeName !== "NamespaceExists") throw error;
      }
    }
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Effect path
// ---------------------------------------------------------------------------
//
// F2: the effect transaction is driven only by the canonical
// `createRecoveryTaskWriter()` implementation in
// `tests/integration/support/t2RealWriter.mjs`. This runner no longer builds or
// inserts schema-shaped WP04 documents directly. The only collection write for
// T2-A/T2-B is W1/W2/W6/W7 on a Mongoose connection routed through the proxy.

function normalizeCommitError(error) {
  return {
    name: error.name,
    message: error.message,
    code: error.code ?? null,
    codeName: error.codeName ?? null
  };
}

function toEvidenceValue(value) {
  if (typeof value === "bigint") {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : value.toString();
  }
  if (Array.isArray(value)) return value.map(toEvidenceValue);
  if (value && typeof value === "object") {
    if (value instanceof Date || typeof value.toHexString === "function") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, toEvidenceValue(nested)])
    );
  }
  return value;
}

async function runRealWriterCommitScenario({
  scenario,
  mode,
  runId,
  proxyPort,
  mongodPort,
  dbName,
  effectCommitted
}) {
  const proxy = createCommitAwareProxy({
    listenPort: proxyPort,
    targetPort: mongodPort,
    mode,
    armed: false
  });

  await proxy.listen();

  const proxyUri = `mongodb://127.0.0.1:${proxyPort}/${dbName}?directConnection=true`;
  const spec = buildRealWriterScenario({ runId, scenario });
  const writerTrace = [];
  let harness = null;
  let setup = null;
  let arm = null;
  let effect = null;
  let commitError = null;

  try {
    harness = await createRealWriterHarness({
      proxyUri,
      dbName,
      trace: (entry) => writerTrace.push(toEvidenceValue(entry)),
      effectTimeoutMS: EFFECT_TRANSACTION_TIMEOUT_MS
    });

    // W1 → W2 → W6 complete before arming, so the fault can only land on W7.
    setup = await runRealWriterSetup({ writer: harness.setupWriter, scenario: spec });
    arm = proxy.arm();

    try {
      effect = await runRealWriterEffect({
        writer: harness.effectWriter,
        scenario: spec,
        reservation: setup.reservation
      });
    } catch (error) {
      commitError = normalizeCommitError(error);
    }
  } finally {
    if (harness) {
      try {
        await harness.close();
      } catch {}
    }
    await proxy.close();
  }

  const verification = await verifyWp04EffectStateWithIndependentClient({
    uri: `mongodb://127.0.0.1:${mongodPort}/?directConnection=true`,
    dbName,
    taskId: spec.taskId,
    eventId: spec.eventId,
    historyId: spec.historyId,
    effectCommitted,
    expected: {
      taskStatus: effectCommitted ? "RESOLVED" : "LEASED",
      operationState: effectCommitted ? "COMMITTED" : "PREPARED",
      operationId: spec.operationId,
      eventType: spec.expected.eventType,
      historyState: spec.expected.historyState,
      resolution: spec.expected.resolution,
      sequenceNumber: spec.sequenceNumber,
      eventSequenceCounter: spec.expected.eventSequenceCounter,
      leaseGeneration: spec.expected.leaseGeneration,
      currentFingerprint: spec.currentFingerprint,
      setupEventTypes: spec.expected.setupEventTypes
    }
  });

  return {
    scenario,
    mode,
    writerImplementation: harness?.writerImplementation ?? REAL_WRITER_MODULE,
    effect: {
      writePath: "createRecoveryTaskWriter.commitOperation",
      invoked: true,
      value: effect
        ? toEvidenceValue({
            taskId: effect.taskId,
            status: effect.status,
            operationId: effect.operationId,
            sequenceNumber: effect.sequenceNumber,
            eventId: effect.eventId
          })
        : null,
      clientObservedCommitError: commitError !== null,
      boundedWithTransactionTimeoutMS: EFFECT_TRANSACTION_TIMEOUT_MS
    },
    writerTrace,
    setup: {
      created: toEvidenceValue(setup?.created ?? null),
      claimed: toEvidenceValue(setup?.claimed ?? null),
      reservation: toEvidenceValue(setup?.reservation ?? null)
    },
    arm,
    commitError,
    proxy: {
      stats: proxy.getStats(),
      events: proxy.getEvents()
    },
    verification: toEvidenceValue(verification)
  };
}

async function runNegativeControl({ runId, proxyPort, mongodPort, dbName }) {
  const proxy = createCommitAwareProxy({
    listenPort: proxyPort,
    targetPort: mongodPort,
    mode: PROXY_MODES.NEGATIVE_CONTROL
  });

  await proxy.listen();

  const proxyUri = `mongodb://127.0.0.1:${proxyPort}/?directConnection=true`;
  const client = new MongoClient(proxyUri, {
    directConnection: true,
    retryWrites: false,
    retryReads: false,
    serverSelectionTimeoutMS: 15_000
  });

  const marker = buildNegativeControlMarker({ runId });
  let commandResult = null;
  let insertResult = null;

  try {
    await client.connect();
    const db = client.db(dbName);

    // P5: the literal text is payload/comment content, never the parsed command
    // name. The proxy must not classify either command as commitTransaction.
    commandResult = await db.command({
      find: marker.collectionName,
      filter: { _id: marker.markerId },
      comment: marker.comment
    });

    insertResult = await db
      .collection(marker.collectionName)
      .insertOne(marker.document);
  } finally {
    try {
      await client.close();
    } catch {}
    await proxy.close();
  }

  const verification = await verifyMarkerWithIndependentClient({
    uri: `mongodb://127.0.0.1:${mongodPort}/?directConnection=true`,
    dbName,
    collectionName: marker.collectionName,
    markerId: marker.markerId
  });

  const stats = proxy.getStats();

  return {
    scenario: "T2-C",
    mode: PROXY_MODES.NEGATIVE_CONTROL,
    negativeControl: {
      commandName: "find",
      insertCommandName: "insert",
      literalText: marker.literalText,
      comment: marker.comment,
      markerId: marker.markerId,
      collection: marker.collectionName
    },
    commandResult: {
      ok: commandResult.ok ?? null,
      cursorKeys: Object.keys(commandResult.cursor ?? {})
    },
    insertAcknowledged: insertResult.acknowledged === true,
    proxy: {
      stats,
      events: proxy.getEvents()
    },
    verification
  };
}

// ---------------------------------------------------------------------------
// Crash scenarios (T5-CRASH / T8-CRASH)
//
// Each crash scenario drives disposable child writer processes that are spawned
// by this runner and, when they are victims, killed only by this runner. The
// children bind the real canonical writer to their own Mongoose connection, so
// a SIGKILL of the child models a whole writer process dying. Progress is
// exchanged through JSON status files, never through pipes a kill could leave
// half-flushed. All URIs are loopback-only direct connections.
// ---------------------------------------------------------------------------

function crashWorkerModulePath() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "support",
    "t2CrashWorker.mjs"
  );
}

function spawnCrashWorker({ role, specPath, statusPath, controlPath = null, uri }) {
  const modulePath = crashWorkerModulePath();
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Crash worker module is missing: ${modulePath}`);
  }
  if (!CRASH_WORKER_ROLES.includes(role)) {
    throw new Error(`Refusing to spawn unknown crash worker role '${role}'.`);
  }
  const argv = [
    modulePath,
    "--role", role,
    "--spec-file", specPath,
    "--status-file", statusPath,
    "--uri", uri
  ];
  if (controlPath) {
    argv.push("--control-file", controlPath);
  }
  return spawn(process.execPath, argv, {
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"]
  });
}

function readCrashStatusFile(statusPath) {
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch {
    return null;
  }
}

export async function waitForStatusRecord(statusPath, predicate, { label, timeoutMs = CRASH_WORKER_STATUS_TIMEOUT_MS, proc = null } = {}) {
  const startedAt = Date.now();
  let lastRecord = null;
  let lastError = null;
  const readRecord = () => {
    try {
      const record = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      lastRecord = record;
      lastError = null;
      return record;
    } catch (error) {
      // Missing or partially-written status file: keep polling.
      lastError = error;
      return null;
    }
  };
  const checkRecord = (record) => {
    if (record?.phase === "failed") {
      throw new Error(
        `${label}: crash worker reported failure: ${record.error?.message ?? "unknown"}`
      );
    }
    return record != null && predicate(record);
  };
  while (Date.now() - startedAt < timeoutMs) {
    if (checkRecord(readRecord())) {
      return lastRecord;
    }
    if (proc && proc.exitCode !== null) {
      // The worker has exited. Do one final read before failing: the worker
      // writes its status file synchronously and may have reported the
      // expected phase between this loop's last read and process exit.
      if (checkRecord(readRecord())) {
        return lastRecord;
      }
      throw new Error(
        `${label}: crash worker exited with code ${proc.exitCode} before reporting the expected phase ` +
          `(last phase: ${lastRecord?.phase ?? "none"}).`
      );
    }
    await delay(50);
  }
  throw new Error(
    `${label}: timed out after ${timeoutMs}ms. ` +
      `Last status: ${JSON.stringify(lastRecord)}; last read error: ${lastError?.message ?? "none"}.`
  );
}

/**
 * Kill the spawned victim. On Windows, SIGKILL maps to TerminateProcess: the
 * recorded exitCode is the termination status and signalCode stays null. The
 * evidence records exactly what was observed and never claims POSIX signal
 * delivery.
 */
async function terminateCrashVictim(proc, { reason }) {
  const termination = {
    reason,
    requestedSignal: "SIGKILL",
    requestedAt: new Date().toISOString(),
    pid: proc.pid
  };
  try {
    proc.kill("SIGKILL");
    termination.signalCallSucceeded = true;
  } catch (error) {
    termination.signalCallSucceeded = false;
    termination.signalError = error.message;
  }
  const exited =
    (await waitForExit(proc, 10_000)) || proc.exitCode !== null || proc.signalCode !== null;
  termination.exited = exited;
  termination.exitCode = proc.exitCode;
  termination.signalCode = proc.signalCode;
  if (process.platform === "win32") {
    termination.platformNote =
      "Windows maps SIGKILL to TerminateProcess: exitCode is the termination status and signalCode stays null. Recorded as observed.";
  }
  if (!exited) {
    throw new Error(`Crash victim PID ${proc.pid} did not exit after the SIGKILL request.`);
  }
  return termination;
}

async function waitForWithheldCommit(withheldEvents, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (withheldEvents.length > 0) return withheldEvents[0];
    await delay(20);
  }
  throw new Error("The armed commit was not withheld by the proxy in time.");
}

async function readWp04RowCountsWithIndependentClient({ uri, dbName, taskId }) {
  const client = createIndependentVerifierClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const options = { readConcern: { level: "majority" }, readPreference: "primary" };
    const events = await db.collection(WP04_COLLECTIONS.event).countDocuments({ taskId }, options);
    const history = await db.collection(WP04_COLLECTIONS.history).countDocuments({ taskId }, options);
    return { events, history };
  } finally {
    await client.close();
  }
}

async function stopChild(child, label) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {}
    await waitForExit(child, 5_000);
  }
}

/**
 * T5-CRASH — durable-reservation crash/restart proof.
 *
 * 1. A victim child commits W1 → W2 → W6 and is then SIGKILLed having never
 *    attempted W7 (its writer trace is part of the evidence).
 * 2. A fresh child reconciles read-only (UNRESOLVED/HOLD, zero writes), then
 *    completes W7 with a fresh writer at the exact durable reserved identity
 *    under the already-approved rules (first effect attempt at this identity;
 *    at-most-once additionally guaranteed by the PREPARED CAS).
 * 3. The independent P4 verifier reads the actual collections: exact event,
 *    sequence, operation identity, fencing token, and one history row.
 */
async function runCrashRestartScenario({ runId, mongodPort, dbName }) {
  const spec = buildRealWriterScenario({ runId, scenario: T5_CRASH_LABEL });
  const mongodUri = `mongodb://127.0.0.1:${mongodPort}/${dbName}?directConnection=true`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), CRASH_SCRATCH_PREFIX));
  const specPath = path.join(scratch, "spec.json");
  fs.writeFileSync(specPath, serializeCrashScenarioSpec(spec));

  let victim = null;
  let fresh = null;
  let victimStatus = null;
  let freshReconciled = null;
  let freshStatus = null;
  let termination = null;
  let scratchRemovalError = null;

  try {
    const victimStatusPath = path.join(scratch, "victim-status.json");
    victim = spawnCrashWorker({
      role: "t5-victim",
      specPath,
      statusPath: victimStatusPath,
      uri: mongodUri
    });
    victimStatus = await waitForStatusRecord(
      victimStatusPath,
      (record) => record.phase === "setup-complete",
      { label: `${T5_CRASH_LABEL} victim setup`, proc: victim }
    );

    termination = await terminateCrashVictim(victim, {
      reason: "reservation-committed-effect-unattempted"
    });

    const freshStatusPath = path.join(scratch, "fresh-status.json");
    fresh = spawnCrashWorker({
      role: "t5-fresh",
      specPath,
      statusPath: freshStatusPath,
      uri: mongodUri
    });
    freshReconciled = await waitForStatusRecord(
      freshStatusPath,
      (record) => record.phase === "reconciled-hold",
      { label: `${T5_CRASH_LABEL} fresh reconciliation`, proc: fresh }
    );
    freshStatus = await waitForStatusRecord(
      freshStatusPath,
      (record) => record.phase === "w7-complete",
      { label: `${T5_CRASH_LABEL} fresh W7`, proc: fresh }
    );
    await waitForExit(fresh, 15_000);
    if (fresh.exitCode !== 0) {
      throw new Error(`${T5_CRASH_LABEL} fresh worker exited with code ${fresh.exitCode}.`);
    }
  } finally {
    await stopChild(victim, "victim");
    await stopChild(fresh, "fresh");
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch (error) {
      scratchRemovalError = error.message;
    }
  }

  const verification = await verifyWp04EffectStateWithIndependentClient({
    uri: mongodUri,
    dbName,
    taskId: spec.taskId,
    eventId: spec.eventId,
    historyId: spec.historyId,
    effectCommitted: true,
    expected: {
      taskStatus: "RESOLVED",
      operationState: "COMMITTED",
      operationId: spec.operationId,
      eventType: spec.expected.eventType,
      historyState: spec.expected.historyState,
      resolution: spec.expected.resolution,
      sequenceNumber: spec.sequenceNumber,
      eventSequenceCounter: spec.expected.eventSequenceCounter,
      leaseGeneration: spec.expected.leaseGeneration,
      currentFingerprint: spec.currentFingerprint,
      setupEventTypes: spec.expected.setupEventTypes
    }
  });
  const counts = await readWp04RowCountsWithIndependentClient({
    uri: mongodUri,
    dbName,
    taskId: spec.taskId
  });

  return {
    scenario: T5_CRASH_LABEL,
    kind: "crash-restart",
    writerImplementation: REAL_WRITER_MODULE,
    spec: toEvidenceValue(spec),
    crashModel: {
      victim: "disposable child writer process, spawned and SIGKILLed by this runner only",
      victimNeverAttemptedW7:
        "the victim writer trace contains only the setup entry points; the fresh child's W7 is the first effect attempt at this identity (approved first-attempt rules; at-most-once additionally guaranteed by the PREPARED CAS)",
      freshRecovery: "fresh child process reconciles read-only (HOLD, zero writes) then completes W7"
    },
    children: {
      victim: {
        role: "t5-victim",
        pid: victim.pid,
        status: victimStatus,
        termination
      },
      fresh: {
        role: "t5-fresh",
        pid: fresh.pid,
        exitCode: fresh.exitCode,
        reconciledStatus: freshReconciled,
        status: freshStatus
      }
    },
    verification: toEvidenceValue(verification),
    counts,
    notes: scratchRemovalError ? [`Scratch removal failed: ${scratchRemovalError}`] : []
  };
}

/**
 * T8-CRASH — mid-W7 crash and authorized OD-37 abandonment proof.
 *
 * 1. A victim child commits W1 → W2 → W6 through the withhold-hold proxy.
 * 2. The parent arms the proxy and releases the victim; the armed W7 commit is
 *    withheld WITHOUT severing, so the victim hangs inside `withTransaction`
 *    with the transaction uncommitted on the server.
 * 3. The parent SIGKILLs the victim while it is still inside that commit await.
 * 4. The independent P4 verifier reads the crash world: durable PREPARED, no
 *    partial effect event, no partial history row.
 * 5. A fresh child verifies the PREPARED world read-only, waits for the
 *    original lease to expire, then executes the separately authorized OD-37
 *    W8 abandonment with the exact durable operation identity and an explicit
 *    operator authorization naming that identity.
 * 6. The independent P4 verifier reads the settlement: one RECOVERY_ESCALATED
 *    event at the new sequence, the reserved sequence left as a permanent gap,
 *    and exactly one ABANDONED history row.
 */
async function runCrashAbandonmentScenario({ runId, proxyPort, mongodPort, dbName }) {
  const spec = buildRealWriterScenario({
    runId,
    scenario: T8_CRASH_LABEL,
    leaseMs: T8_CRASH_LEASE_MS
  });
  const mongodUri = `mongodb://127.0.0.1:${mongodPort}/${dbName}?directConnection=true`;
  const proxyUri = `mongodb://127.0.0.1:${proxyPort}/${dbName}?directConnection=true`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), CRASH_SCRATCH_PREFIX));
  const specPath = path.join(scratch, "spec.json");
  fs.writeFileSync(specPath, serializeCrashScenarioSpec(spec));

  const withheldEvents = [];
  const proxy = createCommitAwareProxy({
    listenPort: proxyPort,
    targetPort: mongodPort,
    mode: PROXY_MODES.WITHHOLD_COMMIT_HOLD,
    armed: false,
    onEvent: (event) => {
      if (event.type === "commit-withheld" && event.held === true) {
        withheldEvents.push(event);
      }
    }
  });

  let victim = null;
  let fresh = null;
  let arm = null;
  let victimSetupStatus = null;
  let victimW7StartedStatus = null;
  let victimFinalStatus = null;
  let freshReconciled = null;
  let freshStatus = null;
  let termination = null;
  let withheldEvent = null;
  let scratchRemovalError = null;

  await proxy.listen();

  try {
    const victimStatusPath = path.join(scratch, "victim-status.json");
    const controlPath = path.join(scratch, "arm-control.json");
    victim = spawnCrashWorker({
      role: "t8-victim",
      specPath,
      statusPath: victimStatusPath,
      controlPath,
      uri: proxyUri
    });
    victimSetupStatus = await waitForStatusRecord(
      victimStatusPath,
      (record) => record.phase === "setup-complete",
      { label: `${T8_CRASH_LABEL} victim setup`, proc: victim }
    );

    arm = proxy.arm();
    fs.writeFileSync(
      controlPath,
      JSON.stringify({ armed: true, at: new Date().toISOString() })
    );

    victimW7StartedStatus = await waitForStatusRecord(
      victimStatusPath,
      (record) => record.phase === "w7-started",
      { label: `${T8_CRASH_LABEL} victim W7 start`, proc: victim }
    );
    withheldEvent = await waitForWithheldCommit(withheldEvents, 15_000);

    // The commit is withheld and unacknowledged; the victim is still inside the
    // commit await with the transaction uncommitted on the server. Kill it now.
    termination = await terminateCrashVictim(victim, {
      reason: "w7-commit-withheld-unacknowledged"
    });
    victimFinalStatus = readCrashStatusFile(victimStatusPath);

    const postKillVerification = await verifyWp04EffectStateWithIndependentClient({
      uri: mongodUri,
      dbName,
      taskId: spec.taskId,
      eventId: spec.eventId,
      historyId: spec.historyId,
      effectCommitted: false,
      expected: {
        taskStatus: "LEASED",
        operationState: "PREPARED",
        operationId: spec.operationId,
        eventSequenceCounter: spec.expected.eventSequenceCounter,
        leaseGeneration: spec.expected.leaseGeneration,
        setupEventTypes: spec.expected.setupEventTypes
      }
    });
    const postKillCounts = await readWp04RowCountsWithIndependentClient({
      uri: mongodUri,
      dbName,
      taskId: spec.taskId
    });

    const freshStatusPath = path.join(scratch, "fresh-status.json");
    fresh = spawnCrashWorker({
      role: "t8-fresh",
      specPath,
      statusPath: freshStatusPath,
      uri: mongodUri
    });
    freshReconciled = await waitForStatusRecord(
      freshStatusPath,
      (record) => record.phase === "reconciled-hold",
      { label: `${T8_CRASH_LABEL} fresh reconciliation`, proc: fresh }
    );
    freshStatus = await waitForStatusRecord(
      freshStatusPath,
      (record) => record.phase === "w8-complete",
      { label: `${T8_CRASH_LABEL} fresh W8`, proc: fresh, timeoutMs: T8_FRESH_W8_TIMEOUT_MS }
    );
    await waitForExit(fresh, 15_000);
    if (fresh.exitCode !== 0) {
      throw new Error(`${T8_CRASH_LABEL} fresh worker exited with code ${fresh.exitCode}.`);
    }

    const abandonmentVerification = await verifyWp04AbandonmentStateWithIndependentClient({
      uri: mongodUri,
      dbName,
      taskId: spec.taskId,
      historyId: spec.historyId,
      expected: {
        taskId: spec.taskId,
        taskStatus: "MANUAL_REQUIRED",
        manualReasonCode: "AMBIGUOUS_COMMIT",
        escalationCode: "ESC_UNKNOWN_COMMIT",
        operationId: spec.operationId,
        operationState: "ABANDONED",
        reservedEventId: spec.eventId,
        reservedSequenceNumber: spec.sequenceNumber,
        settlementEventId: `EVT:${spec.taskId}:${spec.sequenceNumber + 1}`,
        settlementEventType: "RECOVERY_ESCALATED",
        settlementSequenceNumber: spec.sequenceNumber + 1,
        eventSequenceCounter: spec.eventSequenceCounter + 1,
        historyId: spec.historyId,
        historyState: "ABANDONED",
        totalEvents: 3,
        historyRowCount: 1,
        operatorId: "wp04-06-crash-operator",
        operatorRole: "ROLE-INVENTORY-MANAGER",
        basis: "OPERATOR_DECISION_AFTER_HOLD"
      }
    });
    const counts = await readWp04RowCountsWithIndependentClient({
      uri: mongodUri,
      dbName,
      taskId: spec.taskId
    });

    return {
      scenario: T8_CRASH_LABEL,
      kind: "crash-abandonment",
      writerImplementation: REAL_WRITER_MODULE,
      spec: toEvidenceValue(spec),
      crashModel: {
        victim: "disposable child writer process, spawned and SIGKILLed by this runner only",
        withheldCommit:
          "the proxy withheld the armed W7 commit without severing; the victim was killed while still inside the commit await, so the transaction was never committed",
        abandonment:
          "the fresh child executed the separately authorized OD-37 W8 abandonment (ESC_UNKNOWN_COMMIT, OPERATOR_DECISION_AFTER_HOLD) with the exact durable operation identity after the original lease expired"
      },
      arm,
      withheldEvent,
      proxy: {
        stats: proxy.getStats(),
        events: proxy.getEvents()
      },
      children: {
        victim: {
          role: "t8-victim",
          pid: victim.pid,
          setupStatus: victimSetupStatus,
          w7StartedStatus: victimW7StartedStatus,
          finalStatus: victimFinalStatus,
          termination
        },
        fresh: {
          role: "t8-fresh",
          pid: fresh.pid,
          exitCode: fresh.exitCode,
          reconciledStatus: freshReconciled,
          status: freshStatus
        }
      },
      postKillVerification: toEvidenceValue(postKillVerification),
      postKillCounts,
      abandonmentVerification: toEvidenceValue(abandonmentVerification),
      counts,
      notes: scratchRemovalError ? [`Scratch removal failed: ${scratchRemovalError}`] : []
    };
  } finally {
    await stopChild(victim, "victim");
    await stopChild(fresh, "fresh");
    try {
      await proxy.close();
    } catch {}
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch (error) {
      scratchRemovalError = error.message;
    }
  }
}

// ---------------------------------------------------------------------------
// Crash scenario assertions (pure; testable without a database)
// ---------------------------------------------------------------------------

const SETUP_ENTRY_POINTS = ["createTaskFromFinding", "claimLease", "reserveOperation"];

function eventConnectionKey(event) {
  return `${event.connectionId ?? "unknown"}:${event.requestID}`;
}

/**
 * Pure assertion for the T5-CRASH evidence. Fail-closed: every accepted run
 * must show a killed victim that never attempted W7, a read-only HOLD
 * reconciliation, an exact reserved-identity W7 with the reserved fencing
 * token, and the committed P4 world with one event and one history row.
 */
export function assertCrashRestartEvidence(result, expected = {}) {
  const label = result?.scenario ?? "crash-restart scenario";

  if (result?.kind !== "crash-restart") {
    throw new Error(`${label} evidence is not a crash-restart result.`);
  }
  const spec = result?.spec;
  if (!spec?.taskId || !spec?.operationId || !spec?.worker?.token) {
    throw new Error(`${label} evidence is missing the scenario identity.`);
  }

  const victim = result?.children?.victim;
  const fresh = result?.children?.fresh;
  if (victim?.role !== "t5-victim" || fresh?.role !== "t5-fresh") {
    throw new Error(`${label} evidence is missing the victim/fresh child records.`);
  }

  const termination = victim?.termination;
  if (termination?.requestedSignal !== "SIGKILL") {
    throw new Error(`${label} did not record a requested SIGKILL for the victim.`);
  }
  if (termination?.exited !== true) {
    throw new Error(`${label} victim was not confirmed exited after the SIGKILL request.`);
  }

  const victimStatus = victim?.status;
  if (victimStatus?.phase !== "setup-complete") {
    throw new Error(`${label} victim did not report a completed setup before the kill.`);
  }
  const victimEntryPoints = (victimStatus?.writerTrace ?? []).map(
    (entry) => entry?.entryPoint
  );
  for (const entryPoint of SETUP_ENTRY_POINTS) {
    if (victimEntryPoints.filter((candidate) => candidate === entryPoint).length !== 1) {
      throw new Error(
        `${label} victim trace is missing exactly one ${entryPoint} entry; the victim must have run the full W1/W2/W6 setup.`
      );
    }
  }
  if (victimEntryPoints.includes("commitOperation")) {
    throw new Error(
      `${label} victim attempted the effect; the fresh W7 would not be the first effect attempt at this identity.`
    );
  }

  const reconciled = fresh?.reconciledStatus;
  if (reconciled?.phase !== "reconciled-hold") {
    throw new Error(`${label} fresh child did not report a read-only reconciliation.`);
  }
  if (reconciled?.assessment?.state !== "UNRESOLVED" || reconciled?.assessment?.action !== "HOLD") {
    throw new Error(`${label} fresh reconciliation is not an unresolved HOLD.`);
  }
  if (reconciled?.writesPerformed !== 0) {
    throw new Error(`${label} fresh reconciliation performed writes.`);
  }
  if (reconciled?.matchesSpec !== true) {
    throw new Error(`${label} fresh reconciliation durable identity does not match the reservation.`);
  }
  if (reconciled?.partialEffect?.effectEventPresent || reconciled?.partialEffect?.effectHistoryPresent) {
    throw new Error(`${label} fresh reconciliation found a partial effect row.`);
  }

  const w7 = fresh?.status;
  if (w7?.phase !== "w7-complete") {
    throw new Error(`${label} fresh child did not complete W7.`);
  }
  const w7Result = w7?.result;
  if (w7Result?.status !== "RESOLVED") {
    throw new Error(`${label} fresh W7 did not resolve the task.`);
  }
  if (w7Result?.operationId !== spec.operationId) {
    throw new Error(`${label} fresh W7 did not use the reserved operation identity.`);
  }
  if (Number(w7Result?.sequenceNumber) !== Number(spec.sequenceNumber)) {
    throw new Error(`${label} fresh W7 did not use the reserved sequence.`);
  }
  if (w7Result?.eventId !== spec.eventId) {
    throw new Error(`${label} fresh W7 did not use the reserved event identity.`);
  }

  const verification = result?.verification;
  if (!verification || verification.complete !== true) {
    throw new Error(
      `${label} independent P4 verification did not complete: ${(verification?.problems ?? []).join("; ")}`
    );
  }
  if (verification.effectCommitted !== true) {
    throw new Error(`${label} independent P4 effect outcome is not committed.`);
  }
  const task = verification.documents?.task;
  if (task?.status !== "RESOLVED" || task?.pendingOperation?.state !== "COMMITTED") {
    throw new Error(`${label} committed task state is not the resolved effect world.`);
  }
  const effectEvent = verification.documents?.effectEvent;
  if (effectEvent?.fencingToken !== spec.worker.token) {
    throw new Error(
      `${label} effect event fencing token does not match the reserved worker identity.`
    );
  }

  if (Number(result?.counts?.events) !== 3) {
    throw new Error(
      `${label} expected exactly three events for the task (detected, leased, effect), ` +
        `got ${String(result?.counts?.events)}.`
    );
  }
  if (Number(result?.counts?.history) !== 1) {
    throw new Error(
      `${label} expected exactly one history row for the task, got ${String(result?.counts?.history)}.`
    );
  }
}

/**
 * Pure assertion for the T8-CRASH evidence. Fail-closed: the kill must land
 * while the victim is still inside the withheld commit await, the crash world
 * must be durable PREPARED with no partial rows, the W8 abandonment must carry
 * the exact identity and explicit authorization, and the settlement must leave
 * the reserved sequence as a permanent gap with exactly one history row.
 */
export function assertCrashAbandonmentEvidence(result, expected = {}) {
  const label = result?.scenario ?? "crash-abandonment scenario";

  if (result?.kind !== "crash-abandonment") {
    throw new Error(`${label} evidence is not a crash-abandonment result.`);
  }
  const spec = result?.spec;
  if (!spec?.taskId || !spec?.operationId || !spec?.worker?.token) {
    throw new Error(`${label} evidence is missing the scenario identity.`);
  }

  if (result?.arm?.armed !== true) {
    throw new Error(`${label} proxy was not armed before the victim's W7 commit.`);
  }
  const withheldEvent = result?.withheldEvent;
  if (!withheldEvent || withheldEvent.type !== "commit-withheld" || withheldEvent.held !== true) {
    throw new Error(`${label} did not record the armed withheld commit.`);
  }

  const victim = result?.children?.victim;
  const fresh = result?.children?.fresh;
  if (victim?.role !== "t8-victim" || fresh?.role !== "t8-fresh") {
    throw new Error(`${label} evidence is missing the victim/fresh child records.`);
  }

  const termination = victim?.termination;
  if (termination?.requestedSignal !== "SIGKILL") {
    throw new Error(`${label} did not record a requested SIGKILL for the victim.`);
  }
  if (termination?.exited !== true) {
    throw new Error(`${label} victim was not confirmed exited after the SIGKILL request.`);
  }
  if (victim?.w7StartedStatus?.phase !== "w7-started") {
    throw new Error(`${label} victim did not report starting W7 before the kill.`);
  }
  const finalPhase = victim?.finalStatus?.phase;
  if (finalPhase !== "w7-started") {
    throw new Error(
      `${label} victim final phase is '${finalPhase}'; the kill must land while the victim is still inside the withheld commit await.`
    );
  }

  const stats = result?.proxy?.stats ?? {};
  if (stats.armed !== true || stats.withheldCommit !== true || stats.forwardedCommit !== false) {
    throw new Error(`${label} proxy statistics do not show an armed withheld commit.`);
  }
  if (stats.ackDropped === true) {
    throw new Error(`${label} proxy dropped a commit acknowledgement; the commit must never have reached the server.`);
  }
  if (!Number.isInteger(stats.armedCommitDetections) || stats.armedCommitDetections < 1) {
    throw new Error(`${label} proxy did not observe the armed W7 commit.`);
  }

  const postKill = result?.postKillVerification;
  if (!postKill || postKill.complete !== true) {
    throw new Error(
      `${label} post-kill P4 verification did not complete: ${(postKill?.problems ?? []).join("; ")}`
    );
  }
  if (postKill.effectCommitted !== false) {
    throw new Error(`${label} post-kill verification is not the uncommitted world.`);
  }
  const postKillTask = postKill.documents?.task;
  if (postKillTask?.status !== "LEASED" || postKillTask?.pendingOperation?.state !== "PREPARED") {
    throw new Error(`${label} crash world is not the durable PREPARED state.`);
  }
  if (postKill.found?.effectEvent !== false || postKill.found?.effectHistory !== false) {
    throw new Error(`${label} crash world contains a partial effect row.`);
  }
  if (Number(result?.postKillCounts?.events) !== 2 || Number(result?.postKillCounts?.history) !== 0) {
    throw new Error(
      `${label} crash-world row counts are not the two setup events and zero history rows.`
    );
  }

  const reconciled = fresh?.reconciledStatus;
  if (reconciled?.phase !== "reconciled-hold" || reconciled?.writesPerformed !== 0) {
    throw new Error(`${label} fresh child did not reconcile read-only before W8.`);
  }
  if (reconciled?.matchesSpec !== true) {
    throw new Error(`${label} fresh reconciliation durable identity does not match the reservation.`);
  }

  const w8 = fresh?.status;
  if (w8?.phase !== "w8-complete") {
    throw new Error(`${label} fresh child did not complete W8.`);
  }
  const authorization = w8?.authorization;
  if (authorization?.operationId !== spec.operationId) {
    throw new Error(`${label} W8 authorization does not name the reserved operation identity.`);
  }
  if (authorization?.basis !== "OPERATOR_DECISION_AFTER_HOLD") {
    throw new Error(`${label} W8 authorization does not record the approved audit basis.`);
  }
  const w8Result = w8?.result;
  if (w8Result?.status !== "MANUAL_REQUIRED") {
    throw new Error(`${label} W8 did not settle the task to MANUAL_REQUIRED.`);
  }
  if (w8Result?.operationId !== spec.operationId) {
    throw new Error(`${label} W8 did not settle the reserved operation identity.`);
  }
  if (Number(w8Result?.sequenceNumber) !== Number(spec.sequenceNumber) + 1) {
    throw new Error(`${label} W8 settlement event sequence is not the post-abandonment sequence.`);
  }
  if (w8Result?.eventId !== `EVT:${spec.taskId}:${Number(spec.sequenceNumber) + 1}`) {
    throw new Error(`${label} W8 settlement event identity is not the post-abandonment event.`);
  }

  const verification = result?.abandonmentVerification;
  if (!verification || verification.complete !== true) {
    throw new Error(
      `${label} abandonment P4 verification did not complete: ${(verification?.problems ?? []).join("; ")}`
    );
  }
  if (Number(result?.counts?.events) !== 3) {
    throw new Error(
      `${label} expected exactly three events for the task (detected, leased, escalation), ` +
        `got ${String(result?.counts?.events)}.`
    );
  }
  if (Number(result?.counts?.history) !== 1) {
    throw new Error(
      `${label} expected exactly one history row for the task, got ${String(result?.counts?.history)}.`
    );
  }
}function assertMatchingEvents(result, detected, matched, matchedType) {
  const detectedKeys = detected.map(eventConnectionKey).sort();
  const matchedKeys = matched.map(eventConnectionKey).sort();
  if (detectedKeys.join("\n") !== matchedKeys.join("\n")) {
    throw new Error(
      `${result.scenario} has ${detected.length} commit detection(s) but ` +
        `${matched.length} ${matchedType} event(s); every detected commit must be matched.`
    );
  }
}

/**
 * Retry-aware commit-scenario assertion.
 *
 * A real mongodb 7.5.0 `commitTransaction()` can be attempted more than once:
 * the transaction command is labelled `RetryableWriteError` when the connection
 * is severed, and the driver's adaptive retry loop re-issues it on a new
 * connection. Therefore "exactly one detection" is not a valid acceptance
 * criterion. The invariant is instead:
 *   - at least one commit frame was detected;
 *   - every detected commit was withheld (T2-A) or forwarded (T2-B);
 *   - no detected commit took the opposite path;
 *   - every affected connection recorded the expected severance reason;
 *   - for T2-B, every forwarded commit has a matching ACK-drop event.
 *
 * Events are keyed by `connectionId + requestID` because requestIDs can repeat
 * across connections while the driver retries.
 */
export function assertProxyScenarioEvidence(result, expected) {
  const allEvents = Array.isArray(result?.proxy?.events) ? result.proxy.events : [];
  const stats = result?.proxy?.stats ?? {};

  // F2: a real-writer scenario arms the proxy after W1/W2/W6. Setup commit
  // frames are recorded with `armed: false` and must not be matched against the
  // effect decision. Older synthetic scenarios omit the armed counters, so they
  // retain the original whole-stream behaviour.
  const hasArmedStats =
    Number.isInteger(stats.armedCommitDetections) &&
    Number.isInteger(stats.unarmedCommitDetections);
  if (hasArmedStats) {
    if (
      stats.commitDetections !==
      stats.armedCommitDetections + stats.unarmedCommitDetections
    ) {
      throw new Error(
        `${result.scenario} armed/unarmed commit counts do not add up to commitDetections.`
      );
    }
    if (expected.requireArmed === true && stats.armed !== true) {
      throw new Error(`${result.scenario} proxy was not armed before the effect commit.`);
    }
  } else if (expected.requireArmed === true) {
    throw new Error(`${result.scenario} evidence lacks proxy arming counters.`);
  }

  const events = hasArmedStats
    ? allEvents.filter((event) => event.armed !== false)
    : allEvents;
  const expectedDetections = hasArmedStats
    ? stats.armedCommitDetections
    : stats.commitDetections;

  const detected = events.filter((event) => event.type === "commit-detected");
  const withheld = events.filter((event) => event.type === "commit-withheld");
  const forwarded = events.filter((event) => event.type === "commit-forwarded");
  const ackDropped = events.filter((event) => event.type === "commit-ack-dropped");
  const severed = events.filter((event) => event.type === "connection-severed");

  if (!Number.isInteger(expectedDetections) || expectedDetections < 1) {
    throw new Error(`${result.scenario} did not detect any parsed commitTransaction frame.`);
  }
  if (detected.length !== expectedDetections) {
    throw new Error(
      `${result.scenario} recorded ${detected.length} commit-detected event(s) but ` +
        `the expected detection count is ${expectedDetections}.`
    );
  }

  if (expected.withheld) {
    if (stats.withheldCommit !== true) {
      throw new Error(`${result.scenario} did not withhold the commit frame.`);
    }
    if (stats.forwardedCommit !== false || forwarded.length > 0) {
      throw new Error(`${result.scenario} forwarded a commit it was expected to withhold.`);
    }
    assertMatchingEvents(result, detected, withheld, "commit-withheld");
    for (const detection of detected) {
      const severedForConnection = severed.find(
        (event) =>
          event.connectionId === detection.connectionId &&
          event.reason === expected.severReason
      );
      if (!severedForConnection) {
        throw new Error(
          `${result.scenario} did not sever connection ${detection.connectionId} ` +
            `with reason '${expected.severReason}'.`
        );
      }
    }
  }

  if (expected.forwarded) {
    if (stats.forwardedCommit !== true) {
      throw new Error(`${result.scenario} did not forward the commit frame.`);
    }
    if (stats.withheldCommit !== false || withheld.length > 0) {
      throw new Error(`${result.scenario} withheld a commit it was expected to forward.`);
    }
    assertMatchingEvents(result, detected, forwarded, "commit-forwarded");
    for (const detection of detected) {
      const severedForConnection = severed.find(
        (event) =>
          event.connectionId === detection.connectionId &&
          event.reason === expected.severReason
      );
      if (!severedForConnection) {
        throw new Error(
          `${result.scenario} did not sever connection ${detection.connectionId} ` +
            `with reason '${expected.severReason}'.`
        );
      }
    }
  }

  if (expected.ackDropped) {
    if (stats.ackDropped !== true) {
      throw new Error(`${result.scenario} did not drop the commit acknowledgement.`);
    }
    if (forwarded.length === 0 || ackDropped.length === 0) {
      throw new Error(`${result.scenario} is missing commit-forwarded/commit-ack-dropped events.`);
    }

    const forwardedKeys = forwarded.map((event) => eventConnectionKey(event)).sort();
    const droppedKeys = ackDropped
      .map((event) => `${event.connectionId ?? "unknown"}:${event.responseTo}`)
      .sort();
    if (forwardedKeys.join("\n") !== droppedKeys.join("\n")) {
      throw new Error(
        `${result.scenario} ACK drop responseTo does not match commit requestID for every forwarded commit.`
      );
    }

    for (const dropEvent of ackDropped) {
      if (dropEvent.correlatedRequestID !== dropEvent.responseTo) {
        throw new Error(
          `${result.scenario} ACK correlation does not reference the commit requestID.`
        );
      }
      if (dropEvent.correlatedCommand !== "commitTransaction") {
        throw new Error(
          `${result.scenario} ACK correlation command is not commitTransaction.`
        );
      }
    }

    if (!forwarded.some((event) => event.requestID === stats.droppedAckResponseTo)) {
      throw new Error(`${result.scenario} dropped ACK state is not scoped to a commit requestID.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Evidence output
// ---------------------------------------------------------------------------

/**
 * Project the proxy statistics and commit events that an independent reviewer
 * needs. The raw `proxy.stats`/`proxy.events` are retained too, but this
 * projection makes the retry count and every commit decision explicit even when
 * a scenario assertion later fails.
 */
export function buildScenarioDiagnostics(result) {
  const events = Array.isArray(result?.proxy?.events) ? result.proxy.events : [];
  const stats = result?.proxy?.stats ?? {};
  return {
    commitDetections: stats.commitDetections ?? 0,
    armed: stats.armed === true,
    armedAtSeq: stats.armedAtSeq ?? null,
    armedCommitDetections: stats.armedCommitDetections ?? 0,
    unarmedCommitDetections: stats.unarmedCommitDetections ?? 0,
    forwardedCommit: stats.forwardedCommit === true,
    withheldCommit: stats.withheldCommit === true,
    ackDropped: stats.ackDropped === true,
    droppedAckResponseTo: stats.droppedAckResponseTo ?? null,
    commitDetectedEvents: events.filter((event) => event.type === "commit-detected"),
    commitWithheldEvents: events.filter((event) => event.type === "commit-withheld"),
    commitForwardedEvents: events.filter((event) => event.type === "commit-forwarded"),
    commitAckDroppedEvents: events.filter((event) => event.type === "commit-ack-dropped"),
    connectionSeveredEvents: events.filter((event) => event.type === "connection-severed")
  };
}

/**
 * Persist a scenario immediately, before any assertion runs. If the assertion
 * throws, the evidence file still contains the real proxy statistics/events
 * instead of an empty `scenarios` object.
 */
export function recordScenarioEvidence(evidence, key, result) {
  evidence.scenarios[key] = {
    ...result,
    diagnostics: buildScenarioDiagnostics(result)
  };
}

/**
 * Record the assertion outcome for a scenario and rethrow the original error so
 * the runner still exits non-zero and the top-level error/cleanup fields are
 * preserved. A failed assertion is never represented as passing evidence.
 */
export function recordScenarioAssertion(evidence, key, assertion) {
  try {
    assertion();
    evidence.assertions[key] = { status: "PASSED" };
  } catch (error) {
    evidence.assertions[key] = {
      status: "FAILED",
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
        stack: error?.stack ?? null
      }
    };
    throw error;
  }
}

function writeEvidence(evidence, runId) {
  if (!RUN_ID_PATTERN.test(runId ?? "")) {
    throw new Error(`Refusing to write evidence for invalid run ID '${runId}'.`);
  }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidencePath = path.join(EVIDENCE_DIR, `${runId}.json`);
  if (path.dirname(path.resolve(evidencePath)) !== path.resolve(EVIDENCE_DIR)) {
    throw new Error(`Refusing evidence path outside ${EVIDENCE_DIR}.`);
  }
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx"
  });
  return evidencePath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (!assertExecutionAuthorized(args)) {
    printPlan();
    return 0;
  }

  const runId = args.runId;
  const dbName = `${DB_PREFIX}${runId.slice(-12)}`;
  const baseTempRoot = path.join(os.tmpdir(), TEMP_PREFIX);

  const evidence = {
    harness: "wp04-06-t2",
    runId,
    status: "STARTED",
    executedAt: new Date().toISOString(),
    authorization:
      "Explicit --execute, --run-id, and --confirm gates satisfied. Owner authorization must be recorded separately.",
    boundaries: {
      loopbackOnly: true,
      productionOrStagingAccess: "NONE",
      environmentFilesRead: "NONE",
      proxyUsedForVerification: false,
      effectWritePath: REAL_WRITER_MODULE,
      effectTransactions: "W1 createTaskFromFinding, W2 claimLease, W6 reserveOperation, W7 commitOperation",
      boundedWithTransactionTimeoutMS: EFFECT_TRANSACTION_TIMEOUT_MS,
      crashProof: {
        t5Crash: "SIGKILL of a disposable child writer process after W1/W2/W6; fresh child reconciles read-only then completes W7 at the exact durable reserved identity",
        t8Crash: "withhold-hold proxy keeps the armed W7 commit uncommitted; the runner SIGKILLs the victim mid-W7; a fresh child executes the separately authorized OD-37 W8 abandonment after lease expiry",
        childrenSpawnedByRunner: true,
        childrenKilledByRunner: "victims only, SIGKILL as requested; recorded as observed (Windows maps SIGKILL to TerminateProcess)"
      },
      verifier:
        "separate MongoClient, directConnection, readPreference primary, readConcern majority, actual WP04 collections"
    },
    scenarios: {},
    assertions: {}
  };

  let proc = null;
  let cleanupResult = null;
  let exitCode = 0;
  let realBaseTemp = null;
  let dbPath = null;
  let currentScenario = null;

  try {
    assertPortFree(args.mongodPort);
    assertPortFree(args.proxyPort);

    fs.mkdirSync(baseTempRoot, { recursive: true });
    realBaseTemp = fs.realpathSync(baseTempRoot);
    const realTmpRoot = fs.realpathSync(os.tmpdir());
    const relativeBase = path.relative(realTmpRoot, realBaseTemp);
    if (relativeBase.startsWith("..") || path.isAbsolute(relativeBase)) {
      throw new Error(`Refusing temp base outside os.tmpdir(): ${realBaseTemp}`);
    }

    dbPath = createOwnedTempPath(realBaseTemp, runId);

    proc = spawnMongod({
      mongodPath: args.mongodPath,
      dbPath,
      port: args.mongodPort
    });

    await waitForOwnedListener(proc, args.mongodPort);

    const topology = await initReplicaSet({
      mongodPort: args.mongodPort,
      replicaSetName: REPLICA_SET_NAME
    });

    evidence.topology = topology;
    evidence.environment = await collectEnvironment({
      mongodPath: args.mongodPath,
      mongodPort: args.mongodPort,
      proxyPort: args.proxyPort
    });
    evidence.replicaSetVerification = await readReplicaSetStateWithIndependentClient({
      uri: `mongodb://127.0.0.1:${args.mongodPort}/?directConnection=true`
    });

    await prepareDatabase({ mongodPort: args.mongodPort, dbName });

    currentScenario = "T2_A";
    const t2a = await runRealWriterCommitScenario({
      scenario: "T2-A",
      mode: PROXY_MODES.SEVER_BEFORE_COMMIT,
      runId,
      proxyPort: args.proxyPort,
      mongodPort: args.mongodPort,
      dbName,
      effectCommitted: false
    });
    // Persist the real proxy statistics/events before asserting, so a failed
    // assertion cannot erase the very diagnostics needed to review it.
    recordScenarioEvidence(evidence, "T2_A", t2a);
    recordScenarioAssertion(evidence, "T2_A", () => {
      assertRealWriterScenarioEvidence(t2a, { effectCommitted: false });
      // The driver may retry commitTransaction after the proxy severs the
      // connection, so accept every retry as long as every *armed* effect
      // commit was withheld, none was forwarded, and each connection was
      // severed for the pre-commit reason.
      assertProxyScenarioEvidence(t2a, {
        withheld: true,
        severReason: "pre-commit-severance",
        requireArmed: true
      });
      if (t2a.commitError === null) {
        throw new Error("T2-A expected a client-side commit failure after severance.");
      }
      const task = t2a.verification.documents.task;
      if (
        t2a.verification.complete !== true ||
        t2a.verification.found.task !== true ||
        t2a.verification.found.effectEvent !== false ||
        t2a.verification.found.effectHistory !== false ||
        task?.status !== "LEASED" ||
        task?.pendingOperation?.state !== "PREPARED"
      ) {
        throw new Error(
          `T2-A independent P4 state is not the reserved PREPARED outcome: ` +
            `${t2a.verification.problems.join("; ")}`
        );
      }
    });

    currentScenario = "T2_B";
    const t2b = await runRealWriterCommitScenario({
      scenario: "T2-B",
      mode: PROXY_MODES.DROP_COMMIT_ACK,
      runId,
      proxyPort: args.proxyPort,
      mongodPort: args.mongodPort,
      dbName,
      effectCommitted: true
    });
    recordScenarioEvidence(evidence, "T2_B", t2b);
    recordScenarioAssertion(evidence, "T2_B", () => {
      assertRealWriterScenarioEvidence(t2b, { effectCommitted: true });
      // The same adaptive retry applies to T2-B: every retried effect commit
      // must be forwarded and have its acknowledgement dropped on its own
      // connection.
      assertProxyScenarioEvidence(t2b, {
        forwarded: true,
        ackDropped: true,
        severReason: "post-commit-ack-loss",
        requireArmed: true
      });
      if (t2b.commitError === null) {
        throw new Error("T2-B expected a client-side acknowledgement failure.");
      }
      const task = t2b.verification.documents.task;
      if (
        t2b.verification.complete !== true ||
        t2b.verification.found.task !== true ||
        t2b.verification.found.effectEvent !== true ||
        t2b.verification.found.effectHistory !== true ||
        task?.status !== "RESOLVED" ||
        task?.pendingOperation?.state !== "COMMITTED"
      ) {
        throw new Error(
          `T2-B independent P4 state is not the committed effect outcome: ` +
            `${t2b.verification.problems.join("; ")}`
        );
      }
    });

    currentScenario = "T2_C";
    const t2c = await runNegativeControl({
      runId,
      proxyPort: args.proxyPort,
      mongodPort: args.mongodPort,
      dbName
    });
    recordScenarioEvidence(evidence, "T2_C", t2c);
    recordScenarioAssertion(evidence, "T2_C", () => {
      if (t2c.commandResult.ok !== 1) {
        throw new Error(
          "Negative control failed: the non-commit find command did not succeed."
        );
      }
      if (t2c.proxy.stats.commitDetections !== 0) {
        throw new Error(
          "Negative control failed: a non-commit command was classified as commitTransaction."
        );
      }
      if (t2c.insertAcknowledged !== true) {
        throw new Error("Negative control failed: the marker insert was not acknowledged.");
      }
      if (t2c.verification.found !== true) {
        throw new Error(
          "Negative control failed: the independent verifier did not find the marker."
        );
      }
      if (t2c.negativeControl.literalText !== "commitTransaction") {
        throw new Error("Negative control failed: the literal payload text is missing.");
      }
    });

    currentScenario = "T5_CRASH";
    const t5crash = await runCrashRestartScenario({
      runId,
      mongodPort: args.mongodPort,
      dbName
    });
    recordScenarioEvidence(evidence, "T5_CRASH", t5crash);
    recordScenarioAssertion(evidence, "T5_CRASH", () => {
      assertCrashRestartEvidence(t5crash);
    });

    currentScenario = "T8_CRASH";
    const t8crash = await runCrashAbandonmentScenario({
      runId,
      proxyPort: args.proxyPort,
      mongodPort: args.mongodPort,
      dbName
    });
    recordScenarioEvidence(evidence, "T8_CRASH", t8crash);
    recordScenarioAssertion(evidence, "T8_CRASH", () => {
      assertCrashAbandonmentEvidence(t8crash);
    });

    evidence.status = "EXECUTED_EVIDENCE_RECORDED";
    evidence.claims = {
      f2: "Real canonical writer path exercised: W1/W2/W6/W7 on the proxy-routed Mongoose connection; independent P4 accepted the effect outcome for this run.",
      p5: "Negative control passed: non-commit commands containing the literal 'commitTransaction' text were not classified as commits.",
      p1_p6: "Execution evidence recorded; requires independent review before any acceptance claim.",
      t2: "OPEN — do not close from this runner output alone.",
      blk_uc_01_02: "OPEN — unchanged by this harness; the T5-CRASH/T8-CRASH scenarios supply evidence input only.",
      crash_restart: "T5-CRASH/T8-CRASH executed on the disposable replica set with independent P4 verification of the durable reserved identity, the PREPARED hold world, and the authorized OD-37 abandonment; requires independent review before any acceptance claim; no closure is claimed here.",
      schema_index_authorization: "PENDING — no index was deployed by this harness.",
      production_deployment: "NOT AUTHORIZED — this is a disposable loopback proof only."
    };
  } catch (error) {
    evidence.status = "FAILED_CLOSED";
    evidence.failedScenario = currentScenario;
    evidence.error = {
      name: error.name,
      message: error.message,
      code: error.code ?? null,
      dbPath: error.dbPath ?? null,
      stack: error.stack ?? null
    };
    exitCode = 1;
  } finally {
    cleanupResult = await cleanup({
      proc,
      port: args.mongodPort,
      dbPath,
      baseTemp: realBaseTemp,
      runId,
      keepTemp: args.keepTemp,
      spawned: proc !== null
    });
    evidence.cleanup = cleanupResult;

    if (cleanupResult.blockers.length > 0) {
      if (evidence.status !== "FAILED_CLOSED") {
        evidence.status = "CLEANUP_BLOCKED";
      }
      exitCode = 1;
    }

    try {
      evidence.evidencePath = writeEvidence(evidence, runId);
    } catch (error) {
      evidence.evidenceWriteError = {
        name: error.name,
        message: error.message
      };
      exitCode = 1;
    }

    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  }

  return exitCode;
}

function isDirectExecution(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => {
      if (typeof code === "number") process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`WP04-06 T2 runner failed closed: ${error.message}\n`);
      process.exitCode = 1;
    });
}

export { main, writeEvidence, EVIDENCE_DIR };
