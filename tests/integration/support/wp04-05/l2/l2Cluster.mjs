// WP04-05 L2 — auth-enabled disposable loopback replica set (TEST-ONLY).
//
// Ownership model
// ---------------
// The harness spawns its own `mongod` on the dedicated L2 port, proves the
// spawned PID owns the listener, and only ever issues commands against that
// process. It never attaches to a pre-existing listener.
//
// Authentication model
// --------------------
// Starting a replica set with `--auth --keyFile` requires an internal key file
// and at least one user. The harness therefore runs a two-phase bootstrap on a
// brand-new dbPath:
//
//   phase A (no auth, loopback only)
//     replSetInitiate -> wait for primary
//     create admin/setup user in `admin`
//     create scanner user  (read      on the disposable DB only)
//     create writer user   (readWrite on the disposable DB only)
//     clean shutdown
//
//   phase B (auth + keyFile)
//     restart the same dbPath with access control enabled
//     verify authorization=enabled and bindIp=127.0.0.1 via getCmdLineOpts
//     return role-scoped URIs
//
// The scanner account is used for every scanner operation. The writer account
// is used only during fixture setup. The admin account is used only for
// bootstrap, config verification and teardown; it is never handed to the
// scanner or to the fixture writer.
//
// No credential, URI, or host is logged or embedded in a returned error.

import { spawn, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import mongoose from "mongoose";

export const L2_PORT = 27023;
export const L2_REPLSET = "bonorecoveryl2rs";
export const L2_DB_PREFIX = "bono_recovery_wp04_05_l2_";
export const L2_MONGOD_PATH = "C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe";

const PROHIBITED_PORTS = new Set([27017, 27018]);

export class L2ClusterError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "L2ClusterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new L2ClusterError(code, message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(400);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPortState(port, shouldBeOpen, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await isPortInUse(port);
    if (open === shouldBeOpen) return;
    await sleep(150);
  }
  fail("PORT_STATE_TIMEOUT", `${label} did not reach ${shouldBeOpen ? "open" : "closed"} state`);
}

function listenerPids(port) {
  try {
    const output = execSync("netstat -ano -p tcp", { encoding: "utf8" });
    const pids = new Set();
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[0] === "TCP" && parts[3] === "LISTENING") {
        if (parts[1].endsWith(`:${port}`)) {
          const pid = Number(parts[4]);
          if (Number.isSafeInteger(pid)) pids.add(pid);
        }
      }
    }
    return pids;
  } catch {
    return new Set();
  }
}

async function assertOwnedListener(port, pid, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listenerPids(port).has(pid)) return;
    await sleep(200);
  }
  fail("LISTENER_OWNERSHIP_UNPROVEN", "spawned mongod PID does not own the L2 listener");
}

function assertDisposablePort(port) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    fail("INVALID_PORT", "invalid L2 port");
  }
  if (PROHIBITED_PORTS.has(port) || [27019, 27020, 27021].includes(port)) {
    fail("PORT_REFUSED", "port belongs to an application or another harness");
  }
  if (port !== L2_PORT) fail("PORT_REFUSED", `only the dedicated L2 port ${L2_PORT} is allowed`);
}

function assertLoopbackDbName(dbName) {
  if (typeof dbName !== "string" || !dbName.startsWith(L2_DB_PREFIX)) {
    fail("DB_NAMESPACE_REFUSED", `database must start with ${L2_DB_PREFIX}`);
  }
}

function buildUri({ user, password, dbName, port, authSource }) {
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  return (
    `mongodb://${encodedUser}:${encodedPassword}@127.0.0.1:${port}/${dbName}` +
    `?directConnection=true&replicaSet=${L2_REPLSET}&authSource=${authSource}`
  );
}

async function connect(uri, timeoutMs = 5000) {
  return mongoose
    .createConnection(uri, {
      autoIndex: false,
      autoCreate: false,
      bufferCommands: false,
      maxPoolSize: 2,
      minPoolSize: 0,
      serverSelectionTimeoutMS: timeoutMs,
    })
    .asPromise();
}

async function waitForPrimary(connection, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hello = await connection.db.command({ hello: 1 });
    if (hello.isWritablePrimary) return hello;
    await sleep(250);
  }
  fail("PRIMARY_TIMEOUT", "disposable replica set did not become primary");
}

async function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function rolesOf(connection) {
  const status = await connection.db.admin().command({ connectionStatus: 1 });
  const roles = status?.authInfo?.authenticatedUserRoles;
  if (!Array.isArray(roles)) fail("AUTH_STATUS_UNAVAILABLE", "authentication status unavailable");
  return roles.map((role) => ({ role: role.role, db: role.db }));
}

async function expectDenied(label, operation) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === 13 || error?.codeName === "Unauthorized") {
      return Object.freeze({ check: label, denied: true });
    }
    throw error;
  }
  fail("PRIVILEGE_ESCALATION", `${label} was not denied`);
}

async function expectAllowed(label, operation) {
  await operation();
  return Object.freeze({ check: label, denied: false });
}

/**
 * Prove the credential boundaries of a running L2 cluster. Returns only labels;
 * never returns a URI or a credential.
 *
 * @param {Awaited<ReturnType<typeof startL2Cluster>>} cluster
 */
export async function verifyCredentialBoundaries(cluster) {
  assertLoopbackDbName(cluster.dbName);
  const checks = [];
  const scanner = await connect(cluster.uriFor("scanner"));
  const writer = await connect(cluster.uriFor("writer"));
  const unauthenticated = await connect(
    `mongodb://127.0.0.1:${cluster.port}/${cluster.dbName}?directConnection=true&replicaSet=${L2_REPLSET}`,
  );

  try {
    const scannerRoles = await rolesOf(scanner);
    if (!(scannerRoles.length === 1 && scannerRoles[0].role === "read" && scannerRoles[0].db === cluster.dbName)) {
      fail("SCANNER_SCOPE_REFUSED", "scanner account is not read-only on the disposable database");
    }
    const writerRoles = await rolesOf(writer);
    if (!(writerRoles.length === 1 && writerRoles[0].role === "readWrite" && writerRoles[0].db === cluster.dbName)) {
      fail("WRITER_SCOPE_REFUSED", "fixture writer is not readWrite on the disposable database");
    }

    checks.push(
      await expectDenied("UNAUTHENTICATED_READ", () =>
        unauthenticated.db.collection("orders").findOne({}),
      ),
    );
    checks.push(
      await expectAllowed("SCANNER_READ", () =>
        scanner.db.collection("orders").findOne({}),
      ),
    );
    checks.push(
      await expectDenied("SCANNER_INSERT", () =>
        scanner.db.collection("orders").insertOne({ l2: "forbidden" }),
      ),
    );
    checks.push(
      await expectDenied("SCANNER_CREATE_INDEX", () =>
        scanner.db.collection("orders").createIndex({ l2: 1 }),
      ),
    );
    checks.push(
      await expectDenied("SCANNER_CREATE_COLLECTION", () =>
        scanner.db.createCollection("l2_priv_probe"),
      ),
    );
    checks.push(
      await expectDenied("SCANNER_DROP_DATABASE", () => scanner.db.dropDatabase()),
    );
    checks.push(
      await expectDenied("SCANNER_FOREIGN_READ", () =>
        scanner.getClient().db("admin").collection("system.users").findOne({}),
      ),
    );

    checks.push(
      await expectAllowed("WRITER_INSERT", () =>
        writer.db.collection("l2_priv_probe").insertOne({ l2: "writer-probe" }),
      ),
    );
    checks.push(
      await expectAllowed("WRITER_DROP_OWN_COLLECTION", () =>
        writer.db.collection("l2_priv_probe").drop(),
      ),
    );
    checks.push(
      await expectDenied("WRITER_FOREIGN_DATABASE_INSERT", async () => {
        const writerCredential = cluster.credentialsFor("writer");
        const foreign = await connect(
          `mongodb://${encodeURIComponent(writerCredential.username)}:` +
            `${encodeURIComponent(writerCredential.password)}@127.0.0.1:${cluster.port}/` +
            `${L2_DB_PREFIX}foreign?directConnection=true&replicaSet=${L2_REPLSET}` +
            `&authSource=${cluster.dbName}`,
        );
        try {
          await foreign.db.collection("l2_priv_probe").insertOne({ l2: "escape" });
        } finally {
          await foreign.close();
        }
      }),
    );
    checks.push(
      await expectDenied("WRITER_FOREIGN_ADMIN_READ", async () => {
        const writerCredential = cluster.credentialsFor("writer");
        const adminTarget = await connect(
          `mongodb://${encodeURIComponent(writerCredential.username)}:` +
            `${encodeURIComponent(writerCredential.password)}@127.0.0.1:${cluster.port}/` +
            `admin?directConnection=true&replicaSet=${L2_REPLSET}` +
            `&authSource=${cluster.dbName}`,
        );
        try {
          await adminTarget.getClient().db("admin").collection("system.users").findOne({});
        } finally {
          await adminTarget.close();
        }
      }),
    );
    checks.push(
      await expectDenied("WRITER_DROP_DATABASE", () => writer.db.dropDatabase()),
    );

    return Object.freeze({
      scannerRoles: Object.freeze(scannerRoles),
      writerRoles: Object.freeze(writerRoles),
      checks: Object.freeze(checks),
    });
  } finally {
    await scanner.close();
    await writer.close();
    await unauthenticated.close();
  }
}

/**
 * Start the disposable, auth-enabled, loopback-only replica set.
 *
 * @param {{ port?: number, mongodPath?: string }} [options]
 */
export async function startL2Cluster(options = {}) {
  const port = options.port ?? L2_PORT;
  const mongodPath = options.mongodPath ?? L2_MONGOD_PATH;
  assertDisposablePort(port);
  if (await isPortInUse(port)) fail("PORT_IN_USE", "dedicated L2 port is already in use");

  const runId = randomBytes(6).toString("hex");
  const dbName = `${L2_DB_PREFIX}${runId}`;
  assertLoopbackDbName(dbName);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bono-wp04-05-l2-"));
  const keyFile = path.join(tempDir, "l2-keyfile");
  fs.writeFileSync(keyFile, randomBytes(48).toString("base64"), { mode: 0o600 });

  const credentials = Object.freeze({
    admin: Object.freeze({
      username: `l2admin_${runId}`,
      password: randomBytes(24).toString("base64url"),
      authSource: "admin",
    }),
    scanner: Object.freeze({
      username: `l2scan_${runId}`,
      password: randomBytes(24).toString("base64url"),
      authSource: dbName,
    }),
    writer: Object.freeze({
      username: `l2write_${runId}`,
      password: randomBytes(24).toString("base64url"),
      authSource: dbName,
    }),
  });

  const baseArgs = [
    "--dbpath",
    tempDir,
    "--port",
    String(port),
    "--bind_ip",
    "127.0.0.1",
    "--replSet",
    L2_REPLSET,
    "--oplogSize",
    "128",
  ];

  let child = null;
  let stopped = false;

  const cleanupSpawn = async () => {
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // best effort
      }
      await waitForExit(child, 5000);
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // best effort
    }
  };

  const spawnMongod = (args, label) => {
    const process = spawn(mongodPath, args, { stdio: "ignore", windowsHide: true });
    process.on("error", () => {
      // Surfaced by the caller's timeout/ownership checks; never echo details.
    });
    if (!process.pid) fail("SPAWN_FAILED", `mongod (${label}) did not start`);
    return process;
  };

  try {
    // ---------------------------------------------------------------------
    // Phase A — no auth, create the replica set and the three accounts.
    // ---------------------------------------------------------------------
    child = spawnMongod(baseArgs, "bootstrap");
    await waitForPortState(port, true, 20000, "bootstrap mongod");
    await assertOwnedListener(port, child.pid);

    const bootstrap = await connect(
      `mongodb://127.0.0.1:${port}/admin?directConnection=true`,
    );
    try {
      try {
        await bootstrap.db.command({
          replSetInitiate: {
            _id: L2_REPLSET,
            members: [{ _id: 0, host: `127.0.0.1:${port}` }],
          },
        });
      } catch (error) {
        if (!/already initialized/i.test(String(error?.message || ""))) throw error;
      }
      await waitForPrimary(bootstrap);

      await bootstrap.db.command({
        createUser: credentials.admin.username,
        pwd: credentials.admin.password,
        roles: [
          { role: "userAdminAnyDatabase", db: "admin" },
          { role: "dbAdminAnyDatabase", db: "admin" },
          { role: "clusterMonitor", db: "admin" },
        ],
      });

      const targetDb = await connect(
        `mongodb://127.0.0.1:${port}/${dbName}?directConnection=true`,
      );
      try {
        await targetDb.db.command({
          createUser: credentials.scanner.username,
          pwd: credentials.scanner.password,
          roles: [{ role: "read", db: dbName }],
        });
        await targetDb.db.command({
          createUser: credentials.writer.username,
          pwd: credentials.writer.password,
          roles: [{ role: "readWrite", db: dbName }],
        });
      } finally {
        await targetDb.close();
      }

      try {
        await bootstrap.db.admin().command({ shutdown: 1, force: true });
      } catch {
        // The connection closes as part of a successful shutdown.
      }
    } finally {
      await bootstrap.close();
    }

    if (!(await waitForExit(child, 20000))) fail("SHUTDOWN_TIMEOUT", "bootstrap mongod did not stop");
    child = null;
    await waitForPortState(port, false, 20000, "bootstrap mongod shutdown");

    // ---------------------------------------------------------------------
    // Phase B — access control enabled.
    // ---------------------------------------------------------------------
    child = spawnMongod([...baseArgs, "--auth", "--keyFile", keyFile], "authorized");
    await waitForPortState(port, true, 20000, "authorized mongod");
    await assertOwnedListener(port, child.pid);

    const adminUri = buildUri({
      user: credentials.admin.username,
      password: credentials.admin.password,
      dbName: "admin",
      port,
      authSource: "admin",
    });
    const admin = await connect(adminUri);
    let config;
    try {
      await waitForPrimary(admin);
      const opts = await admin.db.admin().command({ getCmdLineOpts: 1 });
      const parsed = opts?.parsed ?? {};
      const authorization = parsed?.security?.authorization ?? null;
      const keyFilePath = parsed?.security?.keyFile ?? null;
      const rawBindIp = parsed?.net?.bindIp ?? null;
      const bindIp = Array.isArray(rawBindIp) ? rawBindIp.join(",") : String(rawBindIp ?? "");
      if (authorization !== "enabled") {
        fail("AUTH_NOT_ENABLED", "authorized mongod did not report authorization=enabled");
      }
      if (!keyFilePath) fail("KEYFILE_NOT_ENABLED", "authorized mongod did not report a keyFile");
      if (!bindIp.split(",").map((entry) => entry.trim()).includes("127.0.0.1")) {
        fail("BIND_NOT_LOOPBACK", "authorized mongod is not bound to 127.0.0.1");
      }
      config = Object.freeze({ authorization, keyFile: true, bindIp });
    } finally {
      await admin.close();
    }

    const cluster = {
      dbName,
      port,
      replSet: L2_REPLSET,
      tempDir,
      pid: child.pid,
      config,
      uriFor(role) {
        const credential = credentials[role];
        if (!credential) fail("UNKNOWN_ROLE", "unknown credential role");
        return buildUri({
          user: credential.username,
          password: credential.password,
          dbName: role === "admin" ? "admin" : dbName,
          port,
          authSource: credential.authSource,
        });
      },
      credentialsFor(role) {
        const credential = credentials[role];
        if (!credential) fail("UNKNOWN_ROLE", "unknown credential role");
        return Object.freeze({ ...credential });
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        let adminConnection = null;
        try {
          adminConnection = await connect(adminUri, 3000);
          // Drop only this run's disposable database. Never touch `admin`.
          await adminConnection.getClient().db(dbName).dropDatabase();
          try {
            await adminConnection.db.admin().command({ shutdown: 1, force: true });
          } catch {
            // Expected: the server closes the connection.
          }
        } catch {
          // Teardown still proceeds to process kill / directory removal.
        } finally {
          if (adminConnection) {
            try {
              await adminConnection.close();
            } catch {
              // best effort
            }
          }
        }
        if (child && child.exitCode === null) {
          if (!(await waitForExit(child, 15000))) {
            try {
              child.kill();
            } catch {
              // best effort
            }
            await waitForExit(child, 5000);
          }
        }
        child = null;
        await cleanupSpawn();
        await waitForPortState(port, false, 10000, "L2 shutdown");
      },
      [inspect.custom]() {
        return `L2Cluster <${dbName}> 127.0.0.1:${port} auth=enabled`;
      },
    };

    return Object.freeze(cluster);
  } catch (error) {
    await cleanupSpawn();
    if (error instanceof L2ClusterError) throw error;
    fail("CLUSTER_START_FAILED", "L2 cluster failed to start");
  }
}
