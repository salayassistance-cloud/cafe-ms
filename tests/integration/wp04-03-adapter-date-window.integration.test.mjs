// WP04-03 — disposable loopback regression for BSON Date window operands.
//
// Scope: the read-only adapter path only. This test exercises
// `collectEvidence()` through `createDriverCollectionRepository()` against a
// disposable, unauthenticated mongod on 127.0.0.1:27026. It deliberately does
// NOT invoke `scan()` or the production scan CLI; the L2 scanner proof is a
// separate authorization.
//
// Regression being locked:
//   * V1 stores `updatedAt`/`createdAt` as BSON Dates;
//   * ISO strings in a `$gte`/`$lte` filter match zero Date documents;
//   * the adapter must emit Date operands and the raw-driver bridge must
//     preserve them.
//
// Safety:
//   * the port is checked free before spawn and the spawned PID must own it;
//   * a per-run temp dbPath and database name are used and removed on teardown;
//   * only this run's database is dropped and only this run's process is stopped.
//
// Run: node --test tests/integration/wp04-03-adapter-date-window.integration.test.mjs
// Skip (e.g. no local mongod): set WP04_03_DATE_WINDOW_SKIP=1.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import mongoose from "mongoose";

import { ORDER_PROJECTION, collectEvidence } from "../../lib/recovery/adapter.js";
import { createDriverCollectionRepository } from "../../lib/recovery/repositories.js";

const MONGOD_PATH =
  process.env.WP04_03_MONGOD_PATH ||
  "C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe";
const PORT = 27026;
const DB_NAME = `bono_recovery_wp04_03_date_window_${process.pid}_${Date.now()}`;

const SINCE = "2026-11-10T00:00:00.000Z";
const UNTIL = "2026-11-11T00:00:00.000Z";
const IN_WINDOW = new Date("2026-11-10T12:00:00.000Z");
const SECRET_ACCOUNT = "PROJECTION-SECRET-ACCOUNT";
const SECRET_HOLDER = "PROJECTION-SECRET-HOLDER";
const SECRET_ITEM = "PROJECTION-SECRET-ITEM";
const SECRET_COMPONENT = "PROJECTION-SECRET-COMPONENT";

const EXPLICIT_SKIP = process.env.WP04_03_DATE_WINDOW_SKIP === "1";
const MONGOD_PRESENT = fs.existsSync(MONGOD_PATH);
const SKIP_REASON = EXPLICIT_SKIP
  ? "WP04_03_DATE_WINDOW_SKIP=1"
  : MONGOD_PRESENT
    ? false
    : "local mongod not found";

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
  throw new Error(`${label} did not reach ${shouldBeOpen ? "open" : "closed"} state`);
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

async function waitForExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return true;
    await sleep(100);
  }
  return child.exitCode !== null;
}

async function connect(uri) {
  return mongoose
    .createConnection(uri, {
      autoIndex: false,
      autoCreate: false,
      bufferCommands: false,
      maxPoolSize: 2,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5000,
    })
    .asPromise();
}

describe(
  "WP04-03 adapter BSON Date window (disposable loopback)",
  { skip: SKIP_REASON },
  () => {
    let child = null;
    let tempDir = null;
    let connection = null;
    let orderId = null;
    let itemId = null;
    const capturedDriverFilters = {
      orders: [],
      inventoryreservations: [],
      stockmovements: [],
      inventoryitems: [],
    };

    before(async () => {
      assert.equal(await isPortInUse(PORT), false, `port ${PORT} must be free`);
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bono-wp04-03-date-window-"));

      child = spawn(
        MONGOD_PATH,
        [
          "--dbpath",
          tempDir,
          "--port",
          String(PORT),
          "--bind_ip",
          "127.0.0.1",
        ],
        { stdio: "ignore", windowsHide: true },
      );
      assert.ok(child.pid, "mongod did not start");

      try {
        await waitForPortState(PORT, true, 20000, "disposable mongod");
        assert.ok(
          listenerPids(PORT).has(child.pid),
          "spawned mongod PID does not own the disposable listener",
        );

        connection = await connect(`mongodb://127.0.0.1:${PORT}/${DB_NAME}`);
        const orders = connection.db.collection("orders");
        orderId = new mongoose.Types.ObjectId();
        itemId = new mongoose.Types.ObjectId();
        await orders.insertOne({
          _id: orderId,
          orderNumber: "WP04-03-DATE-WINDOW-1",
          status: "PAID",
          paymentAccountSnapshot: {
            _id: new mongoose.Types.ObjectId(),
            accountNumber: SECRET_ACCOUNT,
            holderName: SECRET_HOLDER,
          },
          items: [
            {
              lineId: "WP04-03-LINE-1",
              type: "FOOD",
              quantity: 1,
              cancelled: false,
              cancelledAt: null,
              sensitiveItem: SECRET_ITEM,
              components: [
                {
                  componentId: "WP04-03-COMPONENT-1",
                  kind: "STOCK",
                  inventoryItemId: itemId,
                  stockQuantity: 1,
                  sensitiveComponent: SECRET_COMPONENT,
                },
              ],
            },
          ],
          createdAt: new Date("2026-11-10T11:00:00.000Z"),
          updatedAt: IN_WINDOW,
        });
      } catch (error) {
        await teardown();
        throw error;
      }
    });

    after(teardown);

    async function teardown() {
      if (connection) {
        try {
          await connection.dropDatabase();
        } catch {
          // best effort
        }
        try {
          await connection.close();
        } catch {
          // best effort
        }
        connection = null;
      }
      if (child && child.exitCode === null) {
        try {
          child.kill();
        } catch {
          // best effort
        }
        await waitForExit(child, 5000);
      }
      child = null;
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          // best effort
        }
        tempDir = null;
      }
      if (await isPortInUse(PORT)) {
        await waitForPortState(PORT, false, 10000, "disposable mongod shutdown");
      }
    }

    it("queries Date fields with Date operands and preserves exact boundaries", async () => {
      const db = connection.db;

      // Control: a Date field compared against a String operand matches zero
      // documents because BSON type bracketing separates Date and String.
      const stringRange = await db.collection("orders").countDocuments({
        updatedAt: { $gte: SINCE, $lte: UNTIL },
      });
      assert.equal(stringRange, 0, "ISO-string range must not match Date documents");

      // Control: Date operands match the seeded document with inclusive bounds.
      const dateRange = await db.collection("orders").countDocuments({
        updatedAt: { $gte: new Date(SINCE), $lte: new Date(UNTIL) },
      });
      assert.equal(dateRange, 1, "Date range must match the seeded document");

      // Capture each filter exactly as it reaches the raw driver, after
      // toDriverValue() has processed it.
      const captureCollection = (name) => {
        const real = db.collection(name);
        return {
          find(filter, options) {
            capturedDriverFilters[name].push({ filter, options });
            return real.find(filter, options);
          },
        };
      };

      const repositories = {
        orders: createDriverCollectionRepository({
          name: "orders",
          collection: captureCollection("orders"),
          ObjectId: mongoose.Types.ObjectId,
        }),
        reservations: createDriverCollectionRepository({
          name: "inventoryreservations",
          collection: captureCollection("inventoryreservations"),
          ObjectId: mongoose.Types.ObjectId,
        }),
        movements: createDriverCollectionRepository({
          name: "stockmovements",
          collection: captureCollection("stockmovements"),
          ObjectId: mongoose.Types.ObjectId,
        }),
        inventory: createDriverCollectionRepository({
          name: "inventoryitems",
          collection: captureCollection("inventoryitems"),
          ObjectId: mongoose.Types.ObjectId,
        }),
      };

      const options = { since: SINCE, until: UNTIL, ruleScope: "D01", includeOrphans: true };
      const collected = await collectEvidence(repositories, options);

      assert.equal(collected.bounds.orderCount, 1);
      assert.equal(collected.bundles.length, 1);
      assert.equal(collected.bundles[0].order.status, "PAID");
      assert.equal(collected.bundles[0].order.id.$oid, orderId.toHexString());

      const windowCall = capturedDriverFilters.orders.find(
        (call) => call.filter.updatedAt !== undefined,
      );
      assert.ok(windowCall, "orders window filter was not sent to the driver");
      assert.ok(windowCall.filter.updatedAt.$gte instanceof Date);
      assert.ok(windowCall.filter.updatedAt.$lte instanceof Date);
      assert.equal(windowCall.filter.updatedAt.$gte.toISOString(), SINCE);
      assert.equal(windowCall.filter.updatedAt.$lte.toISOString(), UNTIL);
      assert.equal(windowCall.filter.updatedAt.$gte.getTime(), new Date(SINCE).getTime());
      assert.equal(windowCall.filter.updatedAt.$lte.getTime(), new Date(UNTIL).getTime());
      assert.equal(windowCall.filter.status, "PAID");

      // The actual adapter projection must reach the raw driver unchanged and
      // must exclude sensitive extras while retaining nested allowlisted fields.
      const orderProjection = windowCall.options.projection;
      assert.deepEqual(orderProjection, ORDER_PROJECTION);
      const projected = await db.collection("orders").findOne(
        { _id: orderId },
        { projection: orderProjection },
      );
      assert.ok(projected, "projected order was not returned");
      assert.equal(projected.items[0].lineId, "WP04-03-LINE-1");
      assert.equal(projected.items[0].components[0].stockQuantity, 1);
      assert.equal(projected.paymentAccountSnapshot.accountNumber, undefined);
      assert.equal(projected.paymentAccountSnapshot.holderName, undefined);
      assert.equal(projected.items[0].sensitiveItem, undefined);
      assert.equal(projected.items[0].components[0].sensitiveComponent, undefined);

      const serialized = JSON.stringify(collected);
      for (const marker of [SECRET_ACCOUNT, SECRET_HOLDER, SECRET_ITEM, SECRET_COMPONENT]) {
        assert.equal(serialized.includes(marker), false, `sensitive value leaked: ${marker}`);
      }

      const reservationWindowCall = capturedDriverFilters.inventoryreservations.find(
        (call) => call.filter.updatedAt !== undefined,
      );
      assert.ok(
        reservationWindowCall,
        "reservation window filter was not sent to the driver",
      );
      assert.ok(reservationWindowCall.filter.updatedAt.$gte instanceof Date);
      assert.ok(reservationWindowCall.filter.updatedAt.$lte instanceof Date);
      assert.equal(reservationWindowCall.filter.updatedAt.$gte.toISOString(), SINCE);
      assert.equal(reservationWindowCall.filter.updatedAt.$lte.toISOString(), UNTIL);

      const movementWindowCalls = capturedDriverFilters.stockmovements.filter(
        (call) => call.filter.createdAt !== undefined,
      );
      assert.ok(movementWindowCalls.length >= 2, "movement window filters were not sent");
      for (const call of movementWindowCalls) {
        assert.ok(call.filter.createdAt.$gte instanceof Date);
        assert.ok(call.filter.createdAt.$lte instanceof Date);
        assert.equal(call.filter.createdAt.$gte.toISOString(), SINCE);
        assert.equal(call.filter.createdAt.$lte.toISOString(), UNTIL);
      }
      const orphanWindowCall = movementWindowCalls.find(
        (call) => call.filter.refOrderId?.$ne === null,
      );
      assert.ok(orphanWindowCall, "orphan movement window filter was not sent");
      assert.ok(orphanWindowCall.filter.createdAt.$gte instanceof Date);
      assert.ok(orphanWindowCall.filter.createdAt.$lte instanceof Date);

      // Reporting/input representation is unchanged: options still carry ISO
      // strings and were not mutated by the adapter.
      assert.equal(options.since, SINCE);
      assert.equal(options.until, UNTIL);
      assert.equal(typeof options.since, "string");
      assert.equal(typeof options.until, "string");
    });
  },
);
