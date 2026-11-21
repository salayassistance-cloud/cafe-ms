// BONO POS Phase 2.3 — real MongoDB replica-set transaction / concurrency tests.
//
// EXPLICIT OPT-IN ONLY. No connection is opened unless every test-only flag is
// present. The target must be a loopback single-node replica set on the private
// Phase 2.3 port, with a dedicated throw-away database name. The guard refuses
// credentials, non-loopback hosts, the application port, and any database that
// does not carry the phase-specific prefix.
//
// Exact command (from the repository root):
//
//   $env:POS_PHASE23_INTEGRATION_TESTS="1"
//   $env:POS_PHASE23_TEST_TARGET_ACK="I_CONFIRM_DISPOSABLE_POS_REPLICA_SET"
//   $env:POS_PHASE23_TEST_MONGODB_URI="mongodb://127.0.0.1:27019/bono_pos_phase23_<unique>?directConnection=true"
//   node --import ./tests/helpers/pos-phase23-register.mjs --test tests/integration/phase23-replica-set.integration.mjs
//
// Optional standalone-topology proof (separate disposable DB on the local test
// standalone instance; never the application database):
//   POS_PHASE23_STANDALONE_URI / POS_PHASE23_STANDALONE_ACK
//
// This suite never reads .env/.env.local, never uses MONGODB_URI/MONGO_URI, and
// only drops the verified phase-specific database it created.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";

import { getOrderModel } from "../../lib/models/Order.js";
import { getInventoryItemModel } from "../../lib/models/InventoryItem.js";
import { getInventoryReservationModel } from "../../lib/models/InventoryReservation.js";
import { getMenuItemModel } from "../../lib/models/MenuItem.js";
import { getRecipeModel } from "../../lib/models/Recipe.js";
import { getStockMovementModel } from "../../lib/models/StockMovement.js";
import {
  archiveOrder,
  cancelOrder,
  payOrder,
} from "../../lib/orderService.js";
import {
  buildRequirementFingerprint,
  buildShortageFingerprint,
  consumeOrderInventory,
  ensureOrderInventoryReservation,
  isOrderInventoryConsumed,
  releaseOrderInventory,
} from "../../lib/inventoryReservationService.js";
import { createRecipe, updateRecipe } from "../../lib/recipeWriteService.js";
import { updateInventoryItem } from "../../lib/inventoryItemWriteService.js";
import { validateRecipeIngredientUnits } from "../../lib/recipeStockArea.js";
import {
  INVENTORY_ITEM_CHANGED,
  RECIPE_COMMIT_UNKNOWN,
  RECIPE_UNIT_CHANGED,
  RecipeWriteError,
  isInventoryItemWriteError,
  isRecipeWriteError,
} from "../../lib/recipeUnitCoordination.js";
import { STOCK_GROUP } from "../../lib/inventoryCategories.js";

const DB_PREFIX = "bono_pos_phase23_";
const STANDALONE_PREFIX = "bono_pos_phase23_standalone_";
const REPLICA_SET_NAME = "bonopos23rs";
const REPLICA_SET_PORT = 27019;
const OWNERSHIP_COLLECTION = "phase23_test_ownership";
const OWNERSHIP_ID = "phase23-run-owner";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ALLOWED_QUERY = new Set([
  "directConnection",
  "replicaSet",
  "serverSelectionTimeoutMS",
  "connectTimeoutMS",
  "appName",
]);

const runId = randomBytes(8).toString("hex");

function parseMongoUri(raw, { port, prefix, requireReplicaSet }) {
  const uri = String(raw || "").trim();
  if (!uri.startsWith("mongodb://")) {
    throw new Error("Phase 2.3 test URI must use the mongodb:// scheme");
  }
  const parsed = new URL(uri.replace(/^mongodb:\/\//, "http://"));
  if (parsed.username || parsed.password) {
    throw new Error("Phase 2.3 test URI must not contain credentials");
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error("Phase 2.3 test URI must target loopback only");
  }
  if (Number(parsed.port) !== port) {
    throw new Error(`Phase 2.3 test URI must use the isolated test port ${port}`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.startsWith(prefix)) {
    throw new Error(`Phase 2.3 test database must start with ${prefix}`);
  }
  for (const [key] of parsed.searchParams) {
    if (!ALLOWED_QUERY.has(key)) {
      throw new Error(`Unsupported Phase 2.3 test URI option: ${key}`);
    }
  }
  if (requireReplicaSet) {
    const name = parsed.searchParams.get("replicaSet");
    if (name !== null && name !== REPLICA_SET_NAME) {
      throw new Error(`Phase 2.3 test replica set must be ${REPLICA_SET_NAME}`);
    }
  }
  return { uri, host, port: Number(parsed.port), databaseName };
}

function readConfig(env) {
  if (env.POS_PHASE23_INTEGRATION_TESTS !== "1") {
    return {
      requested: false,
      reason:
        "Set POS_PHASE23_INTEGRATION_TESTS=1 and the Phase 2.3 disposable replica-set flags to run.",
    };
  }
  if (env.POS_PHASE23_TEST_TARGET_ACK !== "I_CONFIRM_DISPOSABLE_POS_REPLICA_SET") {
    throw new Error("POS_PHASE23_TEST_TARGET_ACK must explicitly confirm the disposable target");
  }
  const target = parseMongoUri(env.POS_PHASE23_TEST_MONGODB_URI, {
    port: REPLICA_SET_PORT,
    prefix: DB_PREFIX,
    requireReplicaSet: true,
  });
  return { requested: true, ...target };
}

const optIn = readConfig(process.env);

let connection = null;
let config = null;
let sequence = 0;

function nextOrderNumber() {
  sequence += 1;
  return `T23-${runId}-${sequence}`;
}

function labeledError(label, message) {
  const error = new Error(message || label);
  error.errorLabels = [label];
  error.hasErrorLabel = (value) => error.errorLabels.includes(value);
  return error;
}

function instrumentSessions(conn, hook = {}) {
  const stats = {
    started: 0,
    ended: 0,
    committed: 0,
    aborted: 0,
    commitAttempts: 0,
  };
  const originalStartSession = conn.startSession.bind(conn);

  conn.startSession = async function instrumentedStartSession(...args) {
    const session = await originalStartSession(...args);
    stats.started += 1;

    const originalEnd = session.endSession.bind(session);
    session.endSession = async function instrumentedEnd(...endArgs) {
      try {
        return await originalEnd(...endArgs);
      } finally {
        stats.ended += 1;
      }
    };

    const originalCommit = session.commitTransaction.bind(session);
    session.commitTransaction = async function instrumentedCommit(...commitArgs) {
      stats.commitAttempts += 1;
      const mode = hook.commitTransaction ? hook.commitTransaction(stats) : "pass";
      if (mode === "transient_before") {
        throw labeledError(
          "TransientTransactionError",
          "synthetic transient transaction commit failure"
        );
      }
      const result = await originalCommit(...commitArgs);
      stats.committed += 1;
      if (mode === "unknown_after") {
        throw labeledError(
          "UnknownTransactionCommitResult",
          "synthetic unknown transaction commit result"
        );
      }
      return result;
    };

    const originalAbort = session.abortTransaction.bind(session);
    session.abortTransaction = async function instrumentedAbort(...abortArgs) {
      try {
        return await originalAbort(...abortArgs);
      } finally {
        stats.aborted += 1;
      }
    };

    return session;
  };

  return {
    stats,
    restore() {
      delete conn.startSession;
    },
  };
}

async function assertTarget() {
  assert.ok(connection, "Phase 2.3 connection is not established");
  assert.ok(config, "Phase 2.3 target configuration is missing");
  assert.equal(connection.name, config.databaseName);
  assert.ok(connection.name.startsWith(DB_PREFIX));

  const hello = await connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, REPLICA_SET_NAME);
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
    waiterName: "Phase 2.3 Synthetic",
    status: "PENDING",
    items: [],
    totalAmount: 0,
    paymentMethod: "NONE",
    ...overrides,
  });
}

function linkedMenuLine(inventoryItemId, { stockQuantity = 2, quantity = 1 } = {}) {
  return {
    // A stable menu-item reference is required before the deduction planner
    // inspects priced components; there is intentionally no recipe for it.
    itemId: new mongoose.Types.ObjectId(),
    name: "Synthetic linked menu line",
    price: 0,
    quantity,
    type: "FOOD",
    components: [
      {
        kind: "PRICED_COMPONENT",
        name: "Synthetic linked ingredient",
        quantity,
        unitPrice: 0,
        lineSum: 0,
        inventoryItemId,
        stockQuantity,
        stockUnit: "kg",
      },
    ],
  };
}

async function makeItem({
  currentStock = 0,
  reservedStock = 0,
  cost = 1,
  name = "Synthetic Phase 2.3 Item",
  unit = "kg",
} = {}) {
  const InventoryItem = getInventoryItemModel(connection);
  return InventoryItem.create({
    name: `${name} ${runId}-${++sequence}`,
    category: "Test",
    unit,
    currentStock,
    reservedStock,
    minimumStock: 0,
    cost,
    status: "In Stock",
  });
}

async function makeReservation(
  order,
  item,
  { quantity = 1, reservedQuantity = quantity, status = "RESERVED", consumedQuantity = 0 } = {}
) {
  const Reservation = getInventoryReservationModel(connection);
  // Reservations created by the real service always carry the requirement
  // fingerprint of their (validated) requirements. The synthetic fixture must
  // satisfy the same invariant, otherwise the preparation/payment gate's
  // self-heal reconcile treats the reservation as stale and recomputes it from
  // the order (whose synthetic lines are empty), which changes the scenario
  // under test.
  const requirementFingerprint = buildRequirementFingerprint(order._id, [
    {
      inventoryItemId: String(item._id),
      unit: String(item.unit || ""),
      requiredQuantity: quantity,
    },
  ]);
  const shortageFingerprint = buildShortageFingerprint(requirementFingerprint, [
    {
      inventoryItemId: String(item._id),
      unit: String(item.unit || ""),
      requiredQuantity: quantity,
      availableAtDecision: quantity,
      shortageQuantity: 0,
    },
  ]);
  return Reservation.create({
    orderId: order._id,
    orderNumber: order.orderNumber,
    status,
    requirementFingerprint,
    shortageFingerprint,
    items: [
      {
        inventoryItemId: item._id,
        unit: item.unit,
        requiredQuantity: quantity,
        reservedQuantity,
        shortageQuantity: 0,
        availableAtDecision: quantity,
        consumedQuantity,
      },
    ],
    warnings: [],
    decisionAt: new Date(),
  });
}

async function refreshItem(item) {
  const InventoryItem = getInventoryItemModel(connection);
  return InventoryItem.findById(item._id).lean();
}

// A recipe-backed SERVED/PAID order whose validated requirement is exactly
// `quantity` units of `item` — the reachable production shape for a payment-path
// test. Empty-item synthetic orders are reconciled by the preparation/payment
// gate's self-heal (requirements recomputed from order lines), which releases
// every hold before consumption and would silently skip the scenario under
// test. The recipe is the minimal catalog link prepareInventoryDeduction needs.
async function makeRecipeBackedOrder({ status = "SERVED", item, quantity }) {
  const menuItemId = new mongoose.Types.ObjectId();
  const Recipe = getRecipeModel(connection);
  await Recipe.create({
    menuItemId,
    isActive: true,
    ingredients: [{ inventoryItemId: item._id, quantity, unit: item.unit }],
  });
  return makeOrder({
    status,
    items: [
      {
        itemId: menuItemId,
        name: "Synthetic recipe line",
        price: 0,
        quantity: 1,
        type: "FOOD",
      },
    ],
  });
}

async function refreshReservation(order) {
  const Reservation = getInventoryReservationModel(connection);
  return Reservation.findOne({ orderId: order._id }).lean();
}

async function saleMovements(order) {
  const StockMovement = getStockMovementModel(connection);
  return StockMovement.find({ refOrderId: order._id, reason: "SaleDeduction" }).lean();
}

// ---------------------------------------------------------------------------
// OBS-3 Option 2 fixtures and barriers
//
// The production transaction services are driven directly (no parallel
// test-only implementation). Deterministic interleavings are produced by
// pausing exactly one model write, letting the competing operation commit, and
// then releasing the paused write.
// ---------------------------------------------------------------------------

async function makeOBS3Menu({ name = "OBS-3 Dish", categoryType = "FOOD" } = {}) {
  const MenuItem = getMenuItemModel(connection);
  return MenuItem.create({
    name: { am: "", en: `${name} ${runId}-${++sequence}`, om: "" },
    price: 0,
    categoryType,
    station: "KITCHEN",
    targetStation: "KITCHEN",
    inventoryPolicy: "UNTRACKED",
  });
}

async function makeStockItem({
  name = "OBS-3 Stock",
  unit = "kg",
  stockGroup = STOCK_GROUP.KITCHEN,
} = {}) {
  const InventoryItem = getInventoryItemModel(connection);
  return InventoryItem.create({
    name: `${name} ${runId}-${++sequence}`,
    category: "Test",
    stockGroup,
    unit,
    currentStock: 50,
    reservedStock: 0,
    minimumStock: 0,
    cost: 1,
    status: "In Stock",
  });
}

function recipeRow(item, { quantity = 1, unit = item.unit } = {}) {
  return { inventoryItemId: item._id, quantity, unit };
}

function makeGate() {
  let releaseGate;
  let markPaused;
  const released = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const paused = new Promise((resolve) => {
    markPaused = resolve;
  });
  return {
    paused,
    wait() {
      markPaused();
      return released;
    },
    release() {
      releaseGate();
    },
  };
}

// Patch one model write method so the first call waits on `gate`. Subsequent
// calls (including runner retries) pass through. `restore()` is idempotent.
function pauseOnce(model, method, gate) {
  const original = model[method];
  let calls = 0;
  model[method] = function pausedWrite(...args) {
    calls += 1;
    if (calls === 1) return gate.wait().then(() => original.apply(this, args));
    return original.apply(this, args);
  };
  return () => {
    model[method] = original;
  };
}

// The OBS-3b gate, applied to the live committed state: every active Recipe
// that references `itemIds` must have convertible/identical ingredient units.
async function assertNoActiveUnitMismatch(itemIds) {
  const Recipe = getRecipeModel(connection);
  const InventoryItem = getInventoryItemModel(connection);
  const ids = itemIds.map((id) => String(id));
  const items = await InventoryItem.find({ _id: { $in: ids } }).lean();
  const inventoryById = new Map(items.map((item) => [String(item._id), item]));
  const recipes = await Recipe.find({
    isActive: { $ne: false },
    "ingredients.inventoryItemId": { $in: ids },
  }).lean();

  for (const recipe of recipes) {
    const result = validateRecipeIngredientUnits({
      ingredients: recipe.ingredients,
      inventoryById,
    });
    assert.equal(
      result.ok,
      true,
      `active recipe ${recipe._id} has an invalid unit tuple: ${result.error || ""}`
    );
  }
  return recipes;
}

describe(
  "Phase 2.3 — real replica-set transaction and concurrency integrity",
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
      assert.equal(hello.setName, REPLICA_SET_NAME);
      assert.equal(hello.isWritablePrimary, true);

      await connection.db.collection(OWNERSHIP_COLLECTION).insertOne({
        _id: OWNERSHIP_ID,
        runId,
        createdAt: new Date(),
        target: {
          host: config.host,
          port: config.port,
          databaseName: config.databaseName,
          replicaSet: REPLICA_SET_NAME,
        },
      });

      const Order = getOrderModel(connection);
      const InventoryItem = getInventoryItemModel(connection);
      const Reservation = getInventoryReservationModel(connection);
      const StockMovement = getStockMovementModel(connection);
      const MenuItem = getMenuItemModel(connection);
      const Recipe = getRecipeModel(connection);
      await Promise.all([
        Order.createIndexes(),
        InventoryItem.createIndexes(),
        Reservation.createIndexes(),
        StockMovement.createIndexes(),
        MenuItem.createIndexes(),
        Recipe.createIndexes(),
      ]);

      await assertTarget();
    });

    after(async () => {
      if (!connection) return;
      await assertTarget();
      if (process.env.POS_PHASE23_KEEP_DB !== "1") {
        await connection.dropDatabase();
      }
      await connection.close();
    });

    beforeEach(async () => {
      await assertTarget();
    });

    test("target guard rejects a non-phase database name", () => {
      assert.throws(
        () =>
          parseMongoUri(`mongodb://127.0.0.1:${REPLICA_SET_PORT}/bono_orders`, {
            port: REPLICA_SET_PORT,
            prefix: DB_PREFIX,
            requireReplicaSet: true,
          }),
        /must start with/
      );
    });

    test("target guard rejects credentials and the application port", () => {
      assert.throws(
        () =>
          parseMongoUri(
            `mongodb://user:secret@127.0.0.1:${REPLICA_SET_PORT}/${DB_PREFIX}x?directConnection=true`,
            { port: REPLICA_SET_PORT, prefix: DB_PREFIX, requireReplicaSet: true }
          ),
        /credentials/
      );
      assert.throws(
        () =>
          parseMongoUri("mongodb://127.0.0.1:27017/bono_pos_phase23_x", {
            port: REPLICA_SET_PORT,
            prefix: DB_PREFIX,
            requireReplicaSet: true,
          }),
        /isolated test port/
      );
    });

    test("concurrent reservation creation holds stock exactly once", async () => {
      const item = await makeItem({ currentStock: 10 });
      const order = await makeOrder({ items: [linkedMenuLine(item._id)] });

      const [first, second] = await Promise.all([
        ensureOrderInventoryReservation(connection, order),
        ensureOrderInventoryReservation(connection, order),
      ]);

      assert.equal(String(first._id), String(second._id));
      const Reservation = getInventoryReservationModel(connection);
      assert.equal(await Reservation.countDocuments({ orderId: order._id }), 1);
      const fresh = await refreshItem(item);
      assert.equal(fresh.reservedStock, 2);
      assert.equal(fresh.currentStock, 10);
    });

    test("transient commit failure is retried with bounded sessions and one hold", async () => {
      const item = await makeItem({ currentStock: 10 });
      const order = await makeOrder({ items: [linkedMenuLine(item._id)] });

      const instrumentation = instrumentSessions(connection, {
        commitTransaction: (stats) =>
          stats.commitAttempts === 1 ? "transient_before" : "pass",
      });
      try {
        await ensureOrderInventoryReservation(connection, order);
      } finally {
        instrumentation.restore();
      }

      assert.equal(instrumentation.stats.started, 2);
      assert.equal(instrumentation.stats.committed, 1);
      assert.equal(instrumentation.stats.aborted, 1);
      assert.equal(instrumentation.stats.started, instrumentation.stats.ended);
      const fresh = await refreshItem(item);
      assert.equal(fresh.reservedStock, 2);
      const Reservation = getInventoryReservationModel(connection);
      assert.equal(await Reservation.countDocuments({ orderId: order._id }), 1);
    });

    test("unknown commit result is not retried and is resolved from the authoritative reservation", async () => {
      const item = await makeItem({ currentStock: 10 });
      const order = await makeOrder({ items: [linkedMenuLine(item._id)] });

      const instrumentation = instrumentSessions(connection, {
        commitTransaction: (stats) =>
          stats.commitAttempts === 1 ? "unknown_after" : "pass",
      });
      try {
        await assert.rejects(
          () => ensureOrderInventoryReservation(connection, order),
          /unknown transaction commit result/i
        );
      } finally {
        instrumentation.restore();
      }

      // The commit actually landed. The retry must adopt it, never create a
      // second reservation or a second hold.
      assert.equal(instrumentation.stats.committed, 1);
      assert.equal(instrumentation.stats.started, instrumentation.stats.ended);

      const recovered = await ensureOrderInventoryReservation(connection, order);
      assert.equal(String(recovered.orderId), String(order._id));
      const Reservation = getInventoryReservationModel(connection);
      assert.equal(await Reservation.countDocuments({ orderId: order._id }), 1);
      const fresh = await refreshItem(item);
      assert.equal(fresh.reservedStock, 2);
    });

    test("concurrent duplicate consumption deducts stock and writes one movement", async () => {
      const item = await makeItem({ currentStock: 5, reservedStock: 5 });
      const order = await makeOrder({ status: "PAID" });
      await makeReservation(order, item, { quantity: 5 });

      const [first, second] = await Promise.all([
        consumeOrderInventory(connection, order, { trigger: "PAYMENT" }),
        consumeOrderInventory(connection, order, { trigger: "PAYMENT" }),
      ]);

      assert.equal(first.success, true);
      assert.equal(second.success, true);
      const fresh = await refreshItem(item);
      assert.equal(fresh.currentStock, 0);
      assert.equal(fresh.reservedStock, 0);

      const movements = await saleMovements(order);
      assert.equal(movements.length, 1);
      assert.equal(movements[0].quantity, 5);
      assert.equal(movements[0].idempotencyKey, `sale:${order._id}:${item._id}`);

      const reservation = await refreshReservation(order);
      assert.equal(reservation.status, "CONSUMED");
      assert.equal(reservation.items[0].consumedQuantity, 5);
      assert.ok(reservation.consumedAt);
    });

    test("concurrent last-unit consumption never goes negative and never double-deducts", async () => {
      const item = await makeItem({ currentStock: 1, reservedStock: 2 });
      const firstOrder = await makeOrder({ status: "PAID" });
      const secondOrder = await makeOrder({ status: "PAID" });
      await makeReservation(firstOrder, item, { quantity: 1 });
      await makeReservation(secondOrder, item, { quantity: 1 });

      const results = await Promise.all([
        consumeOrderInventory(connection, firstOrder, { trigger: "PAYMENT" }),
        consumeOrderInventory(connection, secondOrder, { trigger: "PAYMENT" }),
      ]);

      assert.ok(results.some((result) => result.success === true));
      const fresh = await refreshItem(item);
      assert.equal(fresh.currentStock, 0);
      assert.ok(fresh.currentStock >= 0);
      assert.ok(fresh.reservedStock >= 0);

      const StockMovement = getStockMovementModel(connection);
      const movements = await StockMovement.find({
        item: item._id,
        reason: "SaleDeduction",
      }).lean();
      assert.equal(movements.length, 1);
      assert.equal(
        movements.reduce((sum, movement) => sum + Number(movement.quantity || 0), 0),
        1
      );
    });

    test("a failure after the stock decrement rolls the whole consumption back", async () => {
      const item = await makeItem({ currentStock: 5, reservedStock: 5 });
      const order = await makeOrder({ status: "PAID" });
      await makeReservation(order, item, { quantity: 5 });
      const StockMovement = getStockMovementModel(connection);
      await StockMovement.create({
        item: item._id,
        type: "IN",
        quantity: 1,
        reason: "Purchase",
        idempotencyKey: `sale:${order._id}:${item._id}`,
      });

      const result = await consumeOrderInventory(connection, order, {
        trigger: "PAYMENT",
      });

      assert.equal(result.success, false);
      assert.equal(result.status, 409);
      const fresh = await refreshItem(item);
      assert.equal(fresh.currentStock, 5);
      assert.equal(fresh.reservedStock, 5);
      const reservation = await refreshReservation(order);
      assert.equal(reservation.status, "RESERVED");
      assert.equal(await isOrderInventoryConsumed(connection, order), false);
      assert.equal((await saleMovements(order)).length, 0);
    });

    test("payment commits even when inventory fails; the stale hold is released and no deduction is recorded", async () => {
      const item = await makeItem({ currentStock: 5, reservedStock: 5 });
      const order = await makeRecipeBackedOrder({ status: "SERVED", item, quantity: 5 });
      await makeReservation(order, item, { quantity: 5 });
      const StockMovement = getStockMovementModel(connection);
      await StockMovement.create({
        item: item._id,
        type: "IN",
        quantity: 1,
        reason: "Purchase",
        idempotencyKey: `sale:${order._id}:${item._id}`,
      });

      const paid = await payOrder(connection, order._id.toString(), {
        paymentMethod: "CASH",
      });

      assert.equal(paid.status, "PAID");
      assert.ok(paid.paidAt);
      const fresh = await refreshItem(item);
      assert.equal(fresh.currentStock, 5);
      assert.equal(fresh.reservedStock, 0);
      const reservation = await refreshReservation(order);
      assert.equal(reservation.status, "RELEASED");
      assert.equal((await saleMovements(order)).length, 0);
    });

    test("an unknown commit after a successful deduction is recovered without a duplicate", async () => {
      const item = await makeItem({ currentStock: 5, reservedStock: 5 });
      const order = await makeOrder({ status: "PAID" });
      await makeReservation(order, item, { quantity: 5 });

      const instrumentation = instrumentSessions(connection, {
        commitTransaction: (stats) =>
          stats.commitAttempts === 1 ? "unknown_after" : "pass",
      });
      let first;
      try {
        first = await consumeOrderInventory(connection, order, {
          trigger: "PAYMENT",
        });
      } finally {
        instrumentation.restore();
      }

      // The caller cannot know the outcome from the failed call...
      assert.equal(first.success, false);
      assert.equal(instrumentation.stats.committed, 1);
      assert.equal(instrumentation.stats.started, instrumentation.stats.ended);

      // ...but the committed authoritative records prove success.
      const fresh = await refreshItem(item);
      assert.equal(fresh.currentStock, 0);
      assert.equal(fresh.reservedStock, 0);
      assert.equal((await saleMovements(order)).length, 1);
      assert.equal((await refreshReservation(order)).status, "CONSUMED");

      const retry = await consumeOrderInventory(connection, order, {
        trigger: "PAYMENT",
      });
      assert.equal(retry.success, true);
      assert.equal(retry.skipped, true);
      assert.equal((await saleMovements(order)).length, 1);
      assert.equal((await refreshItem(item)).currentStock, 0);
    });

    test("concurrent duplicate payment leaves one payment and one deduction", async () => {
      const item = await makeItem({ currentStock: 5, reservedStock: 5 });
      const order = await makeRecipeBackedOrder({ status: "SERVED", item, quantity: 5 });
      await makeReservation(order, item, { quantity: 5 });

      const [first, second] = await Promise.all([
        payOrder(connection, order._id.toString(), { paymentMethod: "CASH" }),
        payOrder(connection, order._id.toString(), { paymentMethod: "CASH" }),
      ]);

      assert.equal(first.status, "PAID");
      assert.equal(second.status, "PAID");
      const Order = getOrderModel(connection);
      const freshOrder = await Order.findById(order._id).lean();
      assert.equal(freshOrder.status, "PAID");
      assert.ok(freshOrder.paidAt);
      assert.equal(freshOrder.paymentMethod, "CASH");
      const freshItem = await refreshItem(item);
      assert.equal(freshItem.currentStock, 0);
      assert.equal(freshItem.reservedStock, 0);
      assert.equal((await saleMovements(order)).length, 1);
      assert.equal((await refreshReservation(order)).status, "CONSUMED");
    });

    test("payment and manager cancellation race never leaves CANCELLED with a committed payment", async () => {
      const Order = getOrderModel(connection);
      for (let iteration = 0; iteration < 15; iteration += 1) {
        const order = await makeOrder({ status: "SERVED" });
        await Promise.allSettled([
          payOrder(connection, order._id.toString(), { paymentMethod: "CASH" }),
          cancelOrder(connection, order._id.toString(), { reason: "RACE_TEST" }),
        ]);

        const fresh = await Order.findById(order._id).lean();
        assert.ok(
          fresh.status === "PAID" || fresh.status === "CANCELLED",
          `unexpected terminal state ${fresh.status}`
        );
        if (fresh.status === "CANCELLED") {
          assert.equal(fresh.paidAt, null);
        } else {
          assert.ok(fresh.paidAt);
          assert.equal(fresh.paymentMethod, "CASH");
        }
      }
    });

    test("payment and archive race never leaves ARCHIVED with a committed payment", async () => {
      const Order = getOrderModel(connection);
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const order = await makeOrder({ status: "READY" });
        await Promise.allSettled([
          payOrder(connection, order._id.toString(), { paymentMethod: "CASH" }),
          archiveOrder(connection, order._id.toString()),
        ]);

        const fresh = await Order.findById(order._id).lean();
        assert.ok(
          fresh.status === "PAID" || fresh.status === "ARCHIVED",
          `unexpected terminal state ${fresh.status}`
        );
        if (fresh.status === "ARCHIVED") {
          assert.equal(fresh.paidAt, null);
        } else {
          assert.ok(fresh.paidAt);
        }
      }
    });

    test("concurrent release returns the hold exactly once", async () => {
      const item = await makeItem({ currentStock: 3, reservedStock: 3 });
      const order = await makeOrder({ status: "PENDING" });
      await makeReservation(order, item, { quantity: 3 });

      await Promise.all([
        releaseOrderInventory(connection, order, { reason: "CANCELLED" }),
        releaseOrderInventory(connection, order, { reason: "CANCELLED" }),
      ]);

      const fresh = await refreshItem(item);
      assert.equal(fresh.currentStock, 3);
      assert.equal(fresh.reservedStock, 0);
      const reservation = await refreshReservation(order);
      assert.equal(reservation.status, "RELEASED");
      assert.equal((reservation.voids || []).length, 0);

      await releaseOrderInventory(connection, order, { reason: "CANCELLED" });
      assert.equal((await refreshItem(item)).reservedStock, 0);
      assert.equal((await refreshReservation(order)).status, "RELEASED");
    });

    test("post-preparation void retries are idempotent and never restore stock", async () => {
      const item = await makeItem({ currentStock: 8, reservedStock: 0 });
      const order = await makeOrder({ status: "PAID" });
      await makeReservation(order, item, {
        quantity: 2,
        reservedQuantity: 0,
        status: "CONSUMED",
        consumedQuantity: 2,
      });
      const StockMovement = getStockMovementModel(connection);
      await StockMovement.create({
        item: item._id,
        type: "OUT",
        quantity: 2,
        unit: "kg",
        reason: "SaleDeduction",
        refOrderId: order._id,
        idempotencyKey: `sale:${order._id}:${item._id}`,
      });

      await releaseOrderInventory(connection, order, {
        reason: "MANAGER_CANCELLED",
        source: "ORDER",
      });
      await releaseOrderInventory(connection, order, {
        reason: "MANAGER_CANCELLED",
        source: "ORDER",
      });

      const reservation = await refreshReservation(order);
      assert.equal(reservation.status, "CONSUMED");
      assert.equal((reservation.voids || []).length, 1);
      const fresh = await refreshItem(item);
      assert.equal(fresh.currentStock, 8);
      assert.equal(fresh.reservedStock, 0);
      const movements = await StockMovement.find({ refOrderId: order._id }).lean();
      assert.equal(movements.length, 1);
      assert.equal(movements[0].reason, "Waste");
    });

    describe("OBS-3 — coordinated Recipe / InventoryItem unit writes", () => {
      test("Race A: a unit change committed mid-recipe rejects the recipe, never a mismatch", async () => {
        const menu = await makeOBS3Menu();
        const item = await makeStockItem({ unit: "kg" });
        const InventoryItem = getInventoryItemModel(connection);
        const gate = makeGate();
        const instrumentation = instrumentSessions(connection);
        const restore = pauseOnce(InventoryItem, "bulkWrite", gate);
        try {
          const pending = createRecipe(connection, {
            menuItemId: menu._id,
            ingredients: [recipeRow(item)],
          });
          // The recipe transaction has validated the old unit and is paused
          // immediately before its coordination write.
          await gate.paused;
          await updateInventoryItem(connection, {
            itemId: String(item._id),
            data: { unit: "g" },
            actor: { role: "MANAGER" },
          });
          gate.release();

          await assert.rejects(pending, (err) => {
            assert.equal(isRecipeWriteError(err), true);
            assert.equal(err.status, 400);
            assert.match(err.message, /Unit mismatch/);
            return true;
          });
        } finally {
          instrumentation.restore();
          gate.release();
          restore();
        }

        assert.equal(instrumentation.stats.started, instrumentation.stats.ended);

        const freshItem = await refreshItem(item);
        assert.equal(freshItem.unit, "g", "the committed unit change wins");
        const Recipe = getRecipeModel(connection);
        assert.equal(await Recipe.countDocuments({ menuItemId: menu._id }), 0);
        await assertNoActiveUnitMismatch([item._id]);
      });

      test("Race B: an active Recipe committed mid-unit-change blocks the unit write", async () => {
        const menu = await makeOBS3Menu();
        const item = await makeStockItem({ unit: "kg" });
        const InventoryItem = getInventoryItemModel(connection);
        const gate = makeGate();
        const instrumentation = instrumentSessions(connection);
        const restore = pauseOnce(InventoryItem, "findOneAndUpdate", gate);
        let recipe;
        try {
          const pending = updateInventoryItem(connection, {
            itemId: String(item._id),
            data: { unit: "g" },
            actor: { role: "MANAGER" },
          });
          // The unit transaction has read the item and passed the D2 checks; it
          // is paused immediately before its guarded write.
          await gate.paused;
          recipe = await createRecipe(connection, {
            menuItemId: menu._id,
            ingredients: [recipeRow(item)],
          });
          gate.release();

          await assert.rejects(pending, (err) => {
            assert.equal(isInventoryItemWriteError(err), true);
            assert.equal(err.status, 409);
            assert.equal(err.code, "UNIT_IN_USE");
            return true;
          });
        } finally {
          instrumentation.restore();
          gate.release();
          restore();
        }

        assert.equal(instrumentation.stats.started, instrumentation.stats.ended);

        assert.ok(recipe, "the recipe committed");
        const freshItem = await refreshItem(item);
        assert.equal(freshItem.unit, "kg", "the stale unit write never lands");
        assert.equal(freshItem.unitRevision, 1, "only the recipe coordination write committed");
        const Recipe = getRecipeModel(connection);
        assert.equal(await Recipe.countDocuments({ menuItemId: menu._id }), 1);
        await assertNoActiveUnitMismatch([item._id]);
      });

      test("an existing active Recipe blocks a unit change with 409 UNIT_IN_USE", async () => {
        const menu = await makeOBS3Menu();
        const item = await makeStockItem({ unit: "kg" });
        const instrumentation = instrumentSessions(connection);
        try {
          await createRecipe(connection, {
            menuItemId: menu._id,
            ingredients: [recipeRow(item)],
          });

          await assert.rejects(
            updateInventoryItem(connection, {
              itemId: String(item._id),
              data: { unit: "g" },
              actor: { role: "MANAGER" },
            }),
            (err) => {
              assert.equal(isInventoryItemWriteError(err), true);
              assert.equal(err.status, 409);
              assert.equal(err.code, "UNIT_IN_USE");
              return true;
            }
          );
        } finally {
          instrumentation.restore();
        }

        assert.equal(instrumentation.stats.started, instrumentation.stats.ended);
        const freshItem = await refreshItem(item);
        assert.equal(freshItem.unit, "kg");
        assert.equal(freshItem.unitRevision, 1);
        await assertNoActiveUnitMismatch([item._id]);
      });

      test("same-item Recipe contention serializes and keeps every revision", async () => {
        const menuA = await makeOBS3Menu({ name: "OBS-3 Dish A" });
        const menuB = await makeOBS3Menu({ name: "OBS-3 Dish B" });
        const item = await makeStockItem({ unit: "kg" });
        const InventoryItem = getInventoryItemModel(connection);
        const gate = makeGate();
        const instrumentation = instrumentSessions(connection);
        const restore = pauseOnce(InventoryItem, "bulkWrite", gate);
        let first;
        let second;
        try {
          const pending = createRecipe(connection, {
            menuItemId: menuA._id,
            ingredients: [recipeRow(item)],
          });
          await gate.paused;
          second = await createRecipe(connection, {
            menuItemId: menuB._id,
            ingredients: [recipeRow(item)],
          });
          gate.release();
          first = await pending;
        } finally {
          instrumentation.restore();
          gate.release();
          restore();
        }

        assert.equal(instrumentation.stats.started, instrumentation.stats.ended);
        assert.ok(first && second);
        const Recipe = getRecipeModel(connection);
        assert.equal(await Recipe.countDocuments({ menuItemId: { $in: [menuA._id, menuB._id] } }), 2);
        const freshItem = await refreshItem(item);
        assert.equal(freshItem.unitRevision, 2, "both committed recipes are reflected");
        await assertNoActiveUnitMismatch([item._id]);
      });

      test("different-item concurrency does not conflict unnecessarily", async () => {
        const menuA = await makeOBS3Menu({ name: "OBS-3 Isolated A" });
        const menuB = await makeOBS3Menu({ name: "OBS-3 Isolated B" });
        const itemA = await makeStockItem({ unit: "kg" });
        const itemB = await makeStockItem({ unit: "kg" });
        const InventoryItem = getInventoryItemModel(connection);
        const gate = makeGate();
        const restore = pauseOnce(InventoryItem, "bulkWrite", gate);
        const instrumentation = instrumentSessions(connection);
        try {
          const pending = createRecipe(connection, {
            menuItemId: menuA._id,
            ingredients: [recipeRow(itemA)],
          });
          await gate.paused;
          await createRecipe(connection, {
            menuItemId: menuB._id,
            ingredients: [recipeRow(itemB)],
          });
          gate.release();
          await pending;
        } finally {
          instrumentation.restore();
          gate.release();
          restore();
        }

        assert.equal(instrumentation.stats.started, 2, "no retry for disjoint items");
        assert.equal(instrumentation.stats.started, instrumentation.stats.ended);
        assert.equal((await refreshItem(itemA)).unitRevision, 1);
        assert.equal((await refreshItem(itemB)).unitRevision, 1);
        await assertNoActiveUnitMismatch([itemA._id, itemB._id]);
      });

      test("multi-ingredient coordination is sorted and removed items are excluded", async () => {
        const menu = await makeOBS3Menu();
        const itemA = await makeStockItem({ unit: "kg" });
        const itemB = await makeStockItem({ unit: "kg" });
        const itemC = await makeStockItem({ unit: "kg" });
        const InventoryItem = getInventoryItemModel(connection);
        const originalBulk = InventoryItem.bulkWrite;
        const instrumentation = instrumentSessions(connection);
        const recorded = [];
        InventoryItem.bulkWrite = function recordCoordination(ops, options) {
          recorded.push(ops.map((op) => String(op.updateOne.filter._id)));
          return originalBulk.apply(this, [ops, options]);
        };

        let created;
        try {
          created = await createRecipe(connection, {
            menuItemId: menu._id,
            // Deliberately unsorted payload.
            ingredients: [recipeRow(itemC), recipeRow(itemA), recipeRow(itemB)],
          });
          await updateRecipe(connection, String(created.doc._id), {
            ingredients: [recipeRow(itemA, { quantity: 2 }), recipeRow(itemC)],
          });
        } finally {
          instrumentation.restore();
          InventoryItem.bulkWrite = originalBulk;
        }

        assert.equal(instrumentation.stats.started, instrumentation.stats.ended);

        const sortedABC = [itemA, itemB, itemC].map((item) => String(item._id)).sort();
        const sortedAC = [itemA, itemC].map((item) => String(item._id)).sort();
        assert.deepEqual(recorded[0], sortedABC, "create coordinates the sorted set");
        assert.deepEqual(recorded[1], sortedAC, "the removed ingredient is excluded");
        assert.equal((await refreshItem(itemA)).unitRevision, 2);
        assert.equal((await refreshItem(itemB)).unitRevision, 1, "removed item untouched by the PATCH");
        assert.equal((await refreshItem(itemC)).unitRevision, 2);
        await assertNoActiveUnitMismatch([itemA._id, itemB._id, itemC._id]);
      });

      test("an aborted Recipe transaction leaves no partial Recipe or revision", async () => {
        const menu = await makeOBS3Menu();
        const itemA = await makeStockItem({ unit: "kg" });
        const itemB = await makeStockItem({ unit: "kg" });
        const InventoryItem = getInventoryItemModel(connection);
        const originalBulk = InventoryItem.bulkWrite;
        const instrumentation = instrumentSessions(connection);
        // Fail once, after the Recipe write and the coordination increments have
        // actually executed inside the transaction. The shared runner aborts on
        // the typed error and never retries it.
        InventoryItem.bulkWrite = async function abortAfterCoordination(ops, options) {
          InventoryItem.bulkWrite = originalBulk;
          await originalBulk.call(this, ops, options);
          throw new RecipeWriteError(
            "synthetic post-write failure",
            409,
            INVENTORY_ITEM_CHANGED
          );
        };

        try {
          await assert.rejects(
            createRecipe(connection, {
              menuItemId: menu._id,
              ingredients: [recipeRow(itemA), recipeRow(itemB)],
            }),
            (err) => {
              assert.equal(isRecipeWriteError(err), true);
              assert.equal(err.status, 409);
              assert.equal(err.code, INVENTORY_ITEM_CHANGED);
              return true;
            }
          );
        } finally {
          instrumentation.restore();
          InventoryItem.bulkWrite = originalBulk;
        }

        assert.equal(instrumentation.stats.started, instrumentation.stats.ended);
        assert.equal(instrumentation.stats.started, 1, "typed errors are never retried");
        const Recipe = getRecipeModel(connection);
        assert.equal(await Recipe.countDocuments({ menuItemId: menu._id }), 0);
        assert.equal((await refreshItem(itemA)).unitRevision, 0, "the earlier $inc rolled back");
        assert.equal((await refreshItem(itemB)).unitRevision, 0, "the earlier $inc rolled back");
        await assertNoActiveUnitMismatch([itemA._id, itemB._id]);
      });

      test("bounded retry, duplicate, validation and unknown-commit behavior", async () => {
        const Recipe = getRecipeModel(connection);

        // (a) bounded retry: every commit attempt is transient -> 409.
        const retryMenu = await makeOBS3Menu({ name: "OBS-3 Retry" });
        const retryItem = await makeStockItem({ unit: "kg" });
        const retrySession = instrumentSessions(connection, {
          commitTransaction: (stats) => (stats.commitAttempts <= 3 ? "transient_before" : "pass"),
        });
        try {
          await assert.rejects(
            createRecipe(connection, {
              menuItemId: retryMenu._id,
              ingredients: [recipeRow(retryItem)],
            }),
            (err) => {
              assert.equal(isRecipeWriteError(err), true);
              assert.equal(err.status, 409);
              assert.equal(err.code, RECIPE_UNIT_CHANGED);
              return true;
            }
          );
        } finally {
          retrySession.restore();
        }
        assert.equal(retrySession.stats.started, 3, "bounded to three attempts");
        assert.equal(retrySession.stats.started, retrySession.stats.ended);
        assert.equal(await Recipe.countDocuments({ menuItemId: retryMenu._id }), 0);
        assert.equal((await refreshItem(retryItem)).unitRevision, 0);

        // (b) duplicate Recipe for the same menu item and (c) validation failure.
        const duplicateMenu = await makeOBS3Menu({ name: "OBS-3 Duplicate" });
        const duplicateItem = await makeStockItem({ unit: "kg" });
        const invalidMenu = await makeOBS3Menu({ name: "OBS-3 Invalid" });
        const invalidItem = await makeStockItem({ unit: "kg" });
        const lifecycleSession = instrumentSessions(connection);
        try {
          await createRecipe(connection, {
            menuItemId: duplicateMenu._id,
            ingredients: [recipeRow(duplicateItem)],
          });
          await assert.rejects(
            createRecipe(connection, {
              menuItemId: duplicateMenu._id,
              ingredients: [recipeRow(duplicateItem)],
            }),
            (err) => {
              assert.equal(isRecipeWriteError(err), true);
              assert.equal(err.status, 409);
              assert.equal(err.message, "Recipe for this menu item already exists");
              return true;
            }
          );

          await assert.rejects(
            createRecipe(connection, {
              menuItemId: invalidMenu._id,
              ingredients: [recipeRow(invalidItem, { unit: "g" })],
            }),
            (err) => {
              assert.equal(isRecipeWriteError(err), true);
              assert.equal(err.status, 400);
              assert.match(err.message, /Unit mismatch/);
              return true;
            }
          );
        } finally {
          lifecycleSession.restore();
        }
        assert.equal(lifecycleSession.stats.started, lifecycleSession.stats.ended);
        assert.equal(await Recipe.countDocuments({ menuItemId: duplicateMenu._id }), 1);
        assert.equal(await Recipe.countDocuments({ menuItemId: invalidMenu._id }), 0);

        // (d) unknown commit is reported, not retried, and not re-resolved.
        const unknownMenu = await makeOBS3Menu({ name: "OBS-3 Unknown" });
        const unknownItem = await makeStockItem({ unit: "kg" });
        const unknownSession = instrumentSessions(connection, {
          commitTransaction: (stats) => (stats.commitAttempts === 1 ? "unknown_after" : "pass"),
        });
        try {
          await assert.rejects(
            createRecipe(connection, {
              menuItemId: unknownMenu._id,
              ingredients: [recipeRow(unknownItem)],
            }),
            (err) => {
              assert.equal(isRecipeWriteError(err), true);
              assert.equal(err.status, 409);
              assert.equal(err.code, RECIPE_COMMIT_UNKNOWN);
              return true;
            }
          );
        } finally {
          unknownSession.restore();
        }
        assert.equal(unknownSession.stats.started, 1, "unknown commit is never retried");
        assert.equal(unknownSession.stats.started, unknownSession.stats.ended);
        // The commit landed: a reload sees exactly one recipe and one revision.
        assert.equal(await Recipe.countDocuments({ menuItemId: unknownMenu._id }), 1);
        assert.equal((await refreshItem(unknownItem)).unitRevision, 1);
        await assertNoActiveUnitMismatch([
          retryItem._id,
          duplicateItem._id,
          invalidItem._id,
          unknownItem._id,
        ]);
      });
    });

    test("unsupported standalone topology fails closed with TRANSACTIONS_UNAVAILABLE", async (t) => {
      const raw = process.env.POS_PHASE23_STANDALONE_URI;
      if (!raw) {
        t.skip("POS_PHASE23_STANDALONE_URI not provided");
        return;
      }
      if (
        process.env.POS_PHASE23_STANDALONE_ACK !==
        "I_CONFIRM_DISPOSABLE_POS_STANDALONE_DB"
      ) {
        throw new Error(
          "POS_PHASE23_STANDALONE_ACK must explicitly confirm the disposable standalone DB"
        );
      }
      const standalone = parseMongoUri(raw, {
        port: 27018,
        prefix: STANDALONE_PREFIX,
        requireReplicaSet: false,
      });

      const standaloneConnection = await mongoose
        .createConnection(standalone.uri, {
          bufferCommands: false,
          serverSelectionTimeoutMS: 5000,
        })
        .asPromise();
      try {
        assert.equal(standaloneConnection.name, standalone.databaseName);
        const hello = await standaloneConnection.db.admin().command({ hello: 1 });
        assert.equal(hello.setName, undefined);
        assert.notEqual(hello.isWritablePrimary, false);

        const InventoryItem = getInventoryItemModel(standaloneConnection);
        const Order = getOrderModel(standaloneConnection);
        const Reservation = getInventoryReservationModel(standaloneConnection);
        const item = await InventoryItem.create({
          name: `Standalone ${runId}`,
          category: "Test",
          unit: "kg",
          currentStock: 5,
          reservedStock: 5,
          minimumStock: 0,
          cost: 1,
          status: "In Stock",
        });
        const order = await Order.create({
          orderNumber: `T23S-${runId}`,
          tableNumber: 1,
          waiterName: "Phase 2.3 Synthetic",
          status: "PAID",
          items: [],
          totalAmount: 0,
          paymentMethod: "NONE",
        });
        await Reservation.create({
          orderId: order._id,
          orderNumber: order.orderNumber,
          status: "RESERVED",
          items: [
            {
              inventoryItemId: item._id,
              unit: "kg",
              requiredQuantity: 5,
              reservedQuantity: 5,
              shortageQuantity: 0,
              availableAtDecision: 5,
              consumedQuantity: 0,
            },
          ],
          warnings: [],
          decisionAt: new Date(),
        });

        const result = await consumeOrderInventory(standaloneConnection, order, {
          trigger: "PAYMENT",
        });
        assert.equal(result.success, false);
        assert.equal(result.status, 503);
        assert.equal(result.code, "TRANSACTIONS_UNAVAILABLE");

        const fresh = await InventoryItem.findById(item._id).lean();
        assert.equal(fresh.currentStock, 5);
        assert.equal(fresh.reservedStock, 5);
      } finally {
        await standaloneConnection.dropDatabase();
        await standaloneConnection.close();
      }
    });
  }
);
