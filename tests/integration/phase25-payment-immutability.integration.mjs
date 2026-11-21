// BONO POS Phase 2.5 WP-01 — real MongoDB payment-identity integration tests.
//
// EXPLICIT OPT-IN ONLY. No connection is opened unless every test-only flag is
// present. The target must be a loopback single-node replica set on the private
// Phase 2.5 test port, with a dedicated throw-away database name. The guard
// refuses credentials, non-loopback hosts, the application port, and any
// database that does not carry the phase-specific prefix. It never reads
// MONGODB_URI / MONGO_URI / ROOM_MONGODB_URI.
//
// Exact command (from the repository root):
//
//   $env:POS_PHASE25_INTEGRATION_TESTS="1"
//   $env:POS_PHASE25_TEST_TARGET_ACK="I_CONFIRM_DISPOSABLE_POS_REPLICA_SET"
//   $env:POS_PHASE25_TEST_MONGODB_URI="mongodb://127.0.0.1:27019/bono_pos_phase25_<unique>?directConnection=true"
//   node --import ./tests/helpers/pos-phase25-register.mjs --test tests/integration/phase25-payment-immutability.integration.mjs
//
// This suite only drops the verified phase-specific database it created.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";

import { getOrderModel } from "../../lib/models/Order.js";
import { getPaymentInfoModel } from "../../lib/models/PaymentInfo.js";
import {
  payOrder,
  updatePayment,
  confirmPayment,
  submitPaymentForVerification,
  rejectPayment,
} from "../../lib/orderService.js";

const DB_PREFIX = "bono_pos_phase25_";
const REPLICA_SET_PORT = 27019;
const ALLOWED_REPLICA_SET_NAMES = new Set(["bonopos23rs", "bonopos25rs"]);
const OWNERSHIP_COLLECTION = "phase25_test_ownership";
const OWNERSHIP_ID = "phase25-wp01-run-owner";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ALLOWED_QUERY = new Set([
  "directConnection",
  "replicaSet",
  "serverSelectionTimeoutMS",
  "connectTimeoutMS",
  "appName",
]);

const runId = randomBytes(8).toString("hex");
let sequence = 0;

function nextOrderNumber() {
  sequence += 1;
  return `T25-${runId}-${sequence}`;
}

function parseMongoUri(raw, { port, prefix }) {
  const uri = String(raw || "").trim();
  if (!uri.startsWith("mongodb://")) {
    throw new Error("Phase 2.5 test URI must use the mongodb:// scheme");
  }
  const parsed = new URL(uri.replace(/^mongodb:\/\//, "http://"));
  if (parsed.username || parsed.password) {
    throw new Error("Phase 2.5 test URI must not contain credentials");
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error("Phase 2.5 test URI must target loopback only");
  }
  if (Number(parsed.port) !== port) {
    throw new Error(`Phase 2.5 test URI must use the isolated test port ${port}`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.startsWith(prefix)) {
    throw new Error(`Phase 2.5 test database must start with ${prefix}`);
  }
  for (const [key] of parsed.searchParams) {
    if (!ALLOWED_QUERY.has(key)) {
      throw new Error(`Unsupported Phase 2.5 test URI option: ${key}`);
    }
  }
  const replicaSet = parsed.searchParams.get("replicaSet");
  if (replicaSet !== null && !ALLOWED_REPLICA_SET_NAMES.has(replicaSet)) {
    throw new Error("Phase 2.5 test replica set is not an approved disposable name");
  }
  return { uri, host, port: Number(parsed.port), databaseName };
}

function readConfig(env) {
  if (env.POS_PHASE25_INTEGRATION_TESTS !== "1") {
    return {
      requested: false,
      reason:
        "Set POS_PHASE25_INTEGRATION_TESTS=1 and the Phase 2.5 disposable replica-set flags to run.",
    };
  }
  if (env.POS_PHASE25_TEST_TARGET_ACK !== "I_CONFIRM_DISPOSABLE_POS_REPLICA_SET") {
    throw new Error("POS_PHASE25_TEST_TARGET_ACK must explicitly confirm the disposable target");
  }
  // Only the phase-specific variable is ever used as a target. The application
  // connection variables are deliberately never read or used as a fallback.
  const target = parseMongoUri(env.POS_PHASE25_TEST_MONGODB_URI, {
    port: REPLICA_SET_PORT,
    prefix: DB_PREFIX,
  });
  return { requested: true, ...target };
}

const optIn = readConfig(process.env);

let connection = null;
let config = null;

async function assertTarget() {
  assert.ok(connection, "Phase 2.5 connection is not established");
  assert.ok(config, "Phase 2.5 target configuration is missing");
  assert.equal(connection.name, config.databaseName);
  assert.ok(connection.name.startsWith(DB_PREFIX));

  const hello = await connection.db.admin().command({ hello: 1 });
  assert.ok(
    ALLOWED_REPLICA_SET_NAMES.has(hello.setName),
    `unexpected replica set ${hello.setName}`
  );
  assert.equal(hello.isWritablePrimary, true);
  assert.equal(hello.me, `${config.host}:${config.port}`);

  const marker = await connection.db
    .collection(OWNERSHIP_COLLECTION)
    .findOne({ _id: OWNERSHIP_ID });
  assert.equal(marker?.runId, runId);
}

async function makeOrder(overrides = {}) {
  const Order = getOrderModel(connection);
  return Order.create({
    orderNumber: nextOrderNumber(),
    tableNumber: 1,
    waiterName: "Phase 2.5 Synthetic",
    status: "PENDING",
    items: [],
    totalAmount: 0,
    paymentMethod: "NONE",
    ...overrides,
  });
}

async function makeAccount() {
  const PaymentInfo = getPaymentInfoModel(connection);
  sequence += 1;
  return PaymentInfo.create({
    bankName: "Phase 2.5 Test Bank",
    ownerName: "Disposable Owner",
    accountNumber: `TEST-${runId}-${sequence}`,
    isActive: true,
  });
}

async function readOrder(id) {
  const Order = getOrderModel(connection);
  return Order.findById(id).lean();
}

function timeOf(value) {
  return value ? new Date(value).getTime() : null;
}

describe(
  "Phase 2.5 WP-01 — real replica-set payment identity freeze",
  { skip: optIn.requested ? false : optIn.reason },
  () => {
    before(async () => {
      config = optIn;
      connection = await mongoose
        .createConnection(config.uri, {
          bufferCommands: false,
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 10000,
        })
        .asPromise();

      assert.equal(connection.readyState, 1);
      assert.equal(connection.name, config.databaseName);

      const hello = await connection.db.admin().command({ hello: 1 });
      assert.ok(ALLOWED_REPLICA_SET_NAMES.has(hello.setName));
      assert.equal(hello.isWritablePrimary, true);

      await connection.db.collection(OWNERSHIP_COLLECTION).insertOne({
        _id: OWNERSHIP_ID,
        runId,
        createdAt: new Date(),
        target: {
          host: config.host,
          port: config.port,
          databaseName: config.databaseName,
          replicaSet: hello.setName,
        },
      });

      const Order = getOrderModel(connection);
      const PaymentInfo = getPaymentInfoModel(connection);
      await Promise.all([Order.createIndexes(), PaymentInfo.createIndexes()]);

      await assertTarget();
    });

    after(async () => {
      if (!connection) return;
      await assertTarget();
      if (process.env.POS_PHASE25_KEEP_DB !== "1") {
        await connection.dropDatabase();
      }
      await connection.close();
    });

    beforeEach(async () => {
      await assertTarget();
    });

    test("target guard rejects a non-phase database name", () => {
      assert.throws(
        () => parseMongoUri(`mongodb://127.0.0.1:${REPLICA_SET_PORT}/bono_orders`, {
          port: REPLICA_SET_PORT,
          prefix: DB_PREFIX,
        }),
        /must start with/
      );
    });

    test("target guard rejects credentials and the application port", () => {
      assert.throws(
        () =>
          parseMongoUri(
            `mongodb://user:secret@127.0.0.1:${REPLICA_SET_PORT}/${DB_PREFIX}x?directConnection=true`,
            { port: REPLICA_SET_PORT, prefix: DB_PREFIX }
          ),
        /credentials/
      );
      assert.throws(
        () =>
          parseMongoUri("mongodb://127.0.0.1:27017/bono_pos_phase25_x", {
            port: REPLICA_SET_PORT,
            prefix: DB_PREFIX,
          }),
        /isolated test port/
      );
    });

    test("first cash payment records one identity", async () => {
      const order = await makeOrder({ status: "SERVED" });

      const paid = await payOrder(connection, order._id.toString(), { paymentMethod: "CASH" });

      assert.equal(paid.status, "PAID");
      assert.equal(paid.paymentMethod, "CASH");
      assert.ok(paid.paidAt);
      const fresh = await readOrder(order._id);
      assert.equal(fresh.paymentAccountId ?? null, null);
      assert.equal(fresh.paymentAccountSnapshot ?? null, null);
    });

    test("same-method retry keeps one paidAt and one payment", async () => {
      const order = await makeOrder({ status: "SERVED" });
      const first = await payOrder(connection, order._id.toString(), { paymentMethod: "CASH" });
      const paidAt = timeOf(first.paidAt);

      const retry = await payOrder(connection, order._id.toString(), { paymentMethod: "CASH" });

      assert.equal(retry.paymentMethod, "CASH");
      assert.equal(timeOf(retry.paidAt), paidAt);
      const Order = getOrderModel(connection);
      assert.equal(await Order.countDocuments({ orderNumber: order.orderNumber }), 1);
    });

    test("different-method retry preserves the original cash identity", async () => {
      const account = await makeAccount();
      const order = await makeOrder({ status: "SERVED" });
      const first = await payOrder(connection, order._id.toString(), { paymentMethod: "CASH" });
      const paidAt = timeOf(first.paidAt);

      const retry = await payOrder(connection, order._id.toString(), {
        paymentMethod: "TRANSFER",
        paymentAccountId: account._id.toString(),
      });

      assert.equal(retry.paymentMethod, "CASH");
      assert.equal(retry.paymentAccountId ?? null, null);
      assert.equal(timeOf(retry.paidAt), paidAt);

      const fresh = await readOrder(order._id);
      assert.equal(fresh.paymentMethod, "CASH");
      assert.equal(fresh.paymentAccountId ?? null, null);
      assert.equal(fresh.paymentAccountSnapshot ?? null, null);
      assert.equal(timeOf(fresh.paidAt), paidAt);
    });

    test("different-method retry preserves the original transfer account snapshot", async () => {
      const account = await makeAccount();
      const order = await makeOrder({ status: "SERVED" });
      const first = await payOrder(connection, order._id.toString(), {
        paymentMethod: "TRANSFER",
        paymentAccountId: account._id.toString(),
      });

      const retry = await payOrder(connection, order._id.toString(), { paymentMethod: "CASH" });

      assert.equal(retry.paymentMethod, "TRANSFER");
      assert.equal(String(retry.paymentAccountId), String(account._id));
      assert.equal(retry.paymentAccountSnapshot.accountNumber, account.accountNumber);
      assert.equal(timeOf(retry.paidAt), timeOf(first.paidAt));
    });

    test("legacy PAID with paidAt null is not backfilled by a payOrder retry", async () => {
      const account = await makeAccount();
      const order = await makeOrder({
        status: "PAID",
        paymentMethod: "CASH",
        paidAt: null,
        completedAt: null,
        servedAt: null,
      });

      const retry = await payOrder(connection, order._id.toString(), {
        paymentMethod: "TRANSFER",
        paymentAccountId: account._id.toString(),
      });

      assert.equal(retry.paymentMethod, "CASH");
      assert.equal(retry.paymentAccountId ?? null, null);
      assert.equal(retry.paidAt ?? null, null);
      assert.equal(retry.completedAt ?? null, null);
      assert.equal(retry.servedAt ?? null, null);

      const fresh = await readOrder(order._id);
      assert.equal(fresh.status, "PAID");
      assert.equal(fresh.paymentMethod, "CASH");
      assert.equal(fresh.paidAt ?? null, null);
      assert.equal(fresh.completedAt ?? null, null);
      assert.equal(fresh.servedAt ?? null, null);
    });

    test("concurrent different-method payments leave exactly one consistent identity", async () => {
      const account = await makeAccount();
      const order = await makeOrder({ status: "SERVED" });

      const [cash, transfer] = await Promise.all([
        payOrder(connection, order._id.toString(), { paymentMethod: "CASH" }),
        payOrder(connection, order._id.toString(), {
          paymentMethod: "TRANSFER",
          paymentAccountId: account._id.toString(),
        }),
      ]);

      const fresh = await readOrder(order._id);
      assert.equal(fresh.status, "PAID");
      assert.ok(fresh.paidAt);
      assert.ok(["CASH", "TRANSFER"].includes(fresh.paymentMethod));

      if (fresh.paymentMethod === "CASH") {
        assert.equal(fresh.paymentAccountId ?? null, null);
        assert.equal(fresh.paymentAccountSnapshot ?? null, null);
      } else {
        assert.equal(String(fresh.paymentAccountId), String(account._id));
        assert.equal(fresh.paymentAccountSnapshot.accountNumber, account.accountNumber);
      }

      // Both callers observe the one winning identity, never a torn pair.
      assert.equal(cash.paymentMethod, fresh.paymentMethod);
      assert.equal(transfer.paymentMethod, fresh.paymentMethod);
      assert.equal(cash.paymentMethod, transfer.paymentMethod);
    });

    test("updatePayment on PAID with a different method returns 409 and changes nothing", async () => {
      const order = await makeOrder({ status: "SERVED" });
      const paid = await payOrder(connection, order._id.toString(), { paymentMethod: "CASH" });
      const before = await readOrder(order._id);

      await assert.rejects(
        () =>
          updatePayment(connection, order._id.toString(), {
            paymentMethod: "TRANSFER",
            actorId: null,
          }),
        (err) => {
          assert.equal(err.status, 409);
          assert.equal(err.code, "PAYMENT_METHOD_IMMUTABLE");
          return true;
        }
      );

      const after = await readOrder(order._id);
      assert.equal(after.paymentMethod, "CASH");
      assert.equal(timeOf(after.paidAt), timeOf(paid.paidAt));
      assert.equal(timeOf(after.updatedAt), timeOf(before.updatedAt));
    });

    test("updatePayment on PAID with the same method is idempotent and stamps nothing", async () => {
      const order = await makeOrder({ status: "SERVED" });
      await payOrder(connection, order._id.toString(), { paymentMethod: "CASH" });
      const before = await readOrder(order._id);

      const result = await updatePayment(connection, order._id.toString(), {
        paymentMethod: "CASH",
      });

      const after = await readOrder(order._id);
      assert.equal(result.paymentMethod, "CASH");
      assert.equal(timeOf(after.paidAt), timeOf(before.paidAt));
      assert.equal(timeOf(after.completedAt), timeOf(before.completedAt));
      assert.equal(timeOf(after.servedAt), timeOf(before.servedAt));
      assert.equal(timeOf(after.updatedAt), timeOf(before.updatedAt));
    });

    test("legacy PAID with paidAt null stays frozen with no backfill", async () => {
      const order = await makeOrder({
        status: "PAID",
        paymentMethod: "CASH",
        paidAt: null,
        completedAt: null,
        servedAt: null,
      });

      const same = await updatePayment(connection, order._id.toString(), {
        paymentMethod: "CASH",
      });
      assert.equal(same.paidAt ?? null, null);

      await assert.rejects(
        () =>
          updatePayment(connection, order._id.toString(), {
            paymentMethod: "TRANSFER",
            actorId: null,
          }),
        (err) => err.status === 409 && err.code === "PAYMENT_METHOD_IMMUTABLE"
      );

      const fresh = await readOrder(order._id);
      assert.equal(fresh.paidAt ?? null, null);
      assert.equal(fresh.completedAt ?? null, null);
      assert.equal(fresh.servedAt ?? null, null);
      assert.equal(fresh.paymentMethod, "CASH");
    });

    test("updatePayment on SERVED with paidAt null is allowed and does not settle", async () => {
      const order = await makeOrder({ status: "SERVED" });

      const updated = await updatePayment(connection, order._id.toString(), {
        paymentMethod: "CASH",
      });

      assert.equal(updated.status, "SERVED");
      assert.equal(updated.paymentMethod, "CASH");
      assert.equal(updated.paidAt ?? null, null);
    });

    test("updatePayment racing payOrder cannot tear the settled identity", async () => {
      const account = await makeAccount();
      const order = await makeOrder({ status: "SERVED" });

      const [updateResult, payResult] = await Promise.allSettled([
        updatePayment(connection, order._id.toString(), { paymentMethod: "CASH" }),
        payOrder(connection, order._id.toString(), {
          paymentMethod: "TRANSFER",
          paymentAccountId: account._id.toString(),
        }),
      ]);

      assert.equal(payResult.status, "fulfilled");
      const fresh = await readOrder(order._id);
      assert.equal(fresh.status, "PAID");
      assert.equal(fresh.paymentMethod, "TRANSFER");
      assert.equal(String(fresh.paymentAccountId), String(account._id));
      assert.equal(fresh.paymentAccountSnapshot.accountNumber, account.accountNumber);
      // The pre-PAID edit either lost cleanly or was superseded by the first
      // settled identity. It must never leave CASH paired with the account.
      if (updateResult.status === "rejected") {
        assert.equal(updateResult.reason.status, 409);
        assert.equal(updateResult.reason.code, "PAYMENT_METHOD_IMMUTABLE");
      }
    });

    test("confirmPayment preserves the submitted method and snapshot", async () => {
      const account = await makeAccount();
      const order = await makeOrder({ status: "SERVED" });

      const submitted = await submitPaymentForVerification(connection, order._id.toString(), {
        paymentMethod: "TRANSFER",
        paymentAccountId: account._id.toString(),
      });
      assert.equal(submitted.status, "PAYMENT_PENDING");

      const confirmed = await confirmPayment(connection, order._id.toString());

      assert.equal(confirmed.status, "PAID");
      assert.equal(confirmed.paymentMethod, "TRANSFER");
      assert.equal(String(confirmed.paymentAccountId), String(account._id));
      assert.equal(confirmed.paymentAccountSnapshot.accountNumber, account.accountNumber);
      assert.ok(confirmed.paidAt);
    });

    test("submitPaymentForVerification cannot run on PAID", async () => {
      const order = await makeOrder({
        status: "PAID",
        paymentMethod: "CASH",
        paidAt: new Date(),
      });

      await assert.rejects(
        () =>
          submitPaymentForVerification(connection, order._id.toString(), {
            paymentMethod: "CASH",
          }),
        /already paid/i
      );

      const fresh = await readOrder(order._id);
      assert.equal(fresh.status, "PAID");
      assert.equal(fresh.paymentMethod, "CASH");
    });

    test("rejectPayment returns to SERVED without changing the identity", async () => {
      const account = await makeAccount();
      const order = await makeOrder({ status: "SERVED" });
      await submitPaymentForVerification(connection, order._id.toString(), {
        paymentMethod: "TRANSFER",
        paymentAccountId: account._id.toString(),
      });

      const rejected = await rejectPayment(connection, order._id.toString(), {
        reason: "Phase 2.5 synthetic rejection",
      });

      assert.equal(rejected.status, "SERVED");
      assert.equal(rejected.paymentMethod, "TRANSFER");
      assert.equal(String(rejected.paymentAccountId), String(account._id));
      assert.equal(rejected.paymentAccountSnapshot.accountNumber, account.accountNumber);
      assert.equal(rejected.paidAt ?? null, null);
    });
  }
);
