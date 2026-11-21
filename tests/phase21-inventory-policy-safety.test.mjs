// Phase 2.1 — DB-free safety-correction regressions.
// No MongoDB connection, no environment file, no network, no build.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { describe, test } from "node:test";
import mongoose from "mongoose";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const {
  normalizePolicyVersion,
  policyVersionFilter,
  bumpMenuItemPolicyVersions,
  ORDER_EDIT_CONFLICT,
  POLICY_VERSION_CONFLICT,
  POLICY_TRANSACTION_UNAVAILABLE,
} = await import("../lib/inventoryPolicyVersionService.js");
const {
  OPEN_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  isOpenOrderStatus,
  isTerminalOrderStatus,
} = await import("../lib/constants.js");
const { classifyMenuItemInventoryPolicy } = await import(
  "../lib/menuInventoryPolicyService.js"
);
const { createOrder, editOrderItems } = await import("../lib/orderService.js");
const { runInTransaction } = await import("../lib/transactionRunner.js");

const ITEM = "507f1f77bcf86cd799439011";
const OTHER = "507f1f77bcf86cd799439012";
const STAFF = "507f1f77bcf86cd799439099";
const INV = "507f1f77bcf86cd799439088";
const oid = (id) => new mongoose.Types.ObjectId(String(id));

function chain(value) {
  const q = {
    session() { return q; },
    select() { return q; },
    limit() { return q; },
    lean: async () => (typeof value === "function" ? value() : value),
    then: (res, rej) => Promise.resolve(typeof value === "function" ? value() : value).then(res, rej),
  };
  return q;
}

function sessionConn(models, calls = {}) {
  const session = {
    startTransaction() {},
    commitTransaction() { calls.commits = (calls.commits || 0) + 1; },
    abortTransaction() {
      calls.aborts = (calls.aborts || 0) + 1;
      if (typeof calls.onAbort === "function") calls.onAbort();
    },
    endSession() {},
  };
  return { models, startSession: async () => session };
}

describe("2.1 — shared policyVersion serialization", () => {
  test("legacy undefined version is treated as 0 and matches null/missing", () => {
    assert.equal(normalizePolicyVersion(undefined), 0);
    assert.equal(normalizePolicyVersion(null), 0);
    assert.equal(normalizePolicyVersion("nonsense"), 0);
    assert.equal(normalizePolicyVersion(3), 3);
    assert.deepEqual(policyVersionFilter(0), { $in: [0, null] });
    assert.equal(policyVersionFilter(4), 4);
  });

  test("conditional bump writes the same MenuItem document and rejects stale versions", async () => {
    const doc = { _id: oid(ITEM), policyVersion: 0, inventoryPolicy: "TRACKED" };
    const writes = [];
    const MenuItem = {
      findOneAndUpdate(filter, update, opts) {
        writes.push({ filter, update, opts });
        const version = doc.policyVersion ?? 0;
        const ok = filter.policyVersion.$in.includes(version);
        if (!ok) return chain(null);
        Object.assign(doc, update.$set);
        return chain(doc);
      },
    };
    const conn = sessionConn({ MenuItem });
    await bumpMenuItemPolicyVersions(conn, [
      { menuItemId: ITEM, expectedVersion: undefined, set: { inventoryPolicy: "UNTRACKED" }, timestamps: false },
    ], null);
    assert.equal(doc.policyVersion, 1);
    assert.equal(doc.inventoryPolicy, "UNTRACKED");
    assert.equal(writes[0].opts.timestamps, false);
    await assert.rejects(
      () => bumpMenuItemPolicyVersions(conn, [{ menuItemId: ITEM, expectedVersion: 0 }], null),
      (err) => err.code === POLICY_VERSION_CONFLICT
    );
  });

  test("missing transaction support fails closed", async () => {
    await assert.rejects(
      () => bumpMenuItemPolicyVersions({ models: {} }, [{ menuItemId: ITEM }], null),
      (err) => err?.status === 503 || err?.name === "TypeError"
    );
    const { runPolicyVersionTransactionOnce } = await import("../lib/inventoryPolicyVersionService.js");
    await assert.rejects(
      () => runPolicyVersionTransactionOnce({ models: {} }, async () => 1),
      (err) => err.code === POLICY_TRANSACTION_UNAVAILABLE
    );
  });

  test("order creation re-resolves catalog after a lost version race", async () => {
    const current = {
      _id: ITEM,
      name: { en: "Coffee" },
      price: 10,
      categoryType: "FOOD",
      station: "KITCHEN",
      targetStation: "KITCHEN",
      isAvailable: true,
      inStock: true,
      inventoryPolicy: "TRACKED",
      policyVersion: 0,
    };
    let reads = 0;
    let staleSimulated = false;
    const saved = [];
    const MenuItem = {
      find() {
        reads += 1;
        return chain([{ ...current }]);
      },
      findOneAndUpdate(filter, update) {
        const version = current.policyVersion ?? 0;
        const expected = filter.policyVersion;
        const ok =
          expected && typeof expected === "object" && Array.isArray(expected.$in)
            ? expected.$in.includes(version)
            : version === Number(expected);
        if (!ok) return chain(null);
        if (!staleSimulated) {
          // Simulate a Manager classification committing first.
          staleSimulated = true;
          current.policyVersion = 1;
          current.inventoryPolicy = "UNTRACKED";
          return chain(null); // version guard miss
        }
        Object.assign(current, update.$set);
        return chain({ ...current });
      },
    };
    const Recipe = { find: () => chain([{ menuItemId: ITEM, isActive: true, ingredients: [{ inventoryItemId: INV, quantity: 1, unit: "g" }] }]) };
    const InventoryItem = { find: () => chain([{ _id: INV, name: "Beans", unit: "g", currentStock: 100, reservedStock: 0, cost: 1 }]), updateOne: async () => ({}) };
    const InventoryReservation = { findOne: () => chain(null), findOneAndUpdate: () => chain({}), create: async (d) => d };
    const saveOptions = [];
    const instances = [];
    class FakeOrder {
      constructor(data) {
        Object.assign(this, data);
        this._id = oid("507f1f77bcf86cd799439077");
        instances.push(this);
      }
      async save(opts) { saveOptions.push(opts); saved.push(this); return this; }
    }
    const conn = sessionConn({
      Order: FakeOrder,
      MenuItem,
      Recipe,
      InventoryItem,
      InventoryReservation,
      ExtraItem: { find: () => chain([]), findOne: () => chain(null) },
      OrderCounter: { findOneAndUpdate: async () => ({ seq: 1 }) },
    });

    const doc = await createOrder(conn, {
      tableNumber: 1,
      items: [{ itemId: ITEM, name: "forged", price: 1, quantity: 1, type: "FOOD" }],
    });
    assert.equal(saved.length, 1);
    assert.equal(reads, 2, "catalog must be re-resolved after the version conflict");
    assert.equal(doc.items[0].inventoryPolicySnapshot, "UNTRACKED");
    assert.equal(current.policyVersion, 2);
    assert.ok(saveOptions.every((opts) => opts && opts.session), "order save receives the session");
    assert.equal(instances.length, 2, "a fresh Order document is built per attempt");
    assert.notEqual(instances[0], instances[1]);
  });

  test("order source uses the shared serializer for create and add-line edits", () => {
    const orders = src("lib/orderService.js");
    assert.equal((orders.match(/bumpMenuItemPolicyVersions\(/g) || []).length >= 2, true);
    assert.ok(orders.includes("runPolicyVersionTransactionOnce"));
    assert.ok(orders.includes("POLICY_VERSION_CONFLICT"));
    assert.ok(orders.includes("timestamps: false"));
    assert.ok(orders.includes("addVersions"));
  });

  test("failed transaction cannot leave a partial classification/audit update", async () => {
    const item = { _id: oid(ITEM), name: { en: "Item" }, inventoryPolicy: "TRACKED", policyVersion: 0 };
    const original = { inventoryPolicy: item.inventoryPolicy, policyVersion: item.policyVersion };
    const calls = { commits: 0, aborts: 0, onAbort: () => Object.assign(item, original) };
    const MenuItem = {
      findOne: () => chain(item),
      find: () => chain([]),
      findOneAndUpdate(filter, update) {
        Object.assign(item, update.$set);
        return chain(item);
      },
    };
    const Order = { find: () => chain([]) };
    const Recipe = { find: () => chain([]) };
    const InventoryItem = { find: () => chain([]) };
    const InventoryAudit = { create: async () => { throw new Error("audit down"); } };
    const conn = sessionConn({ MenuItem, Order, Recipe, InventoryItem, InventoryAudit }, calls);
    await assert.rejects(
      () => classifyMenuItemInventoryPolicy(conn, {
        menuItemId: ITEM,
        requestedPolicy: "UNTRACKED",
        actor: { staffId: STAFF, role: "MANAGER" },
      }),
      (err) => err.code === "AUDIT_WRITE_FAILED"
    );
    assert.equal(calls.commits, 0);
    assert.ok(calls.aborts >= 1);
    assert.equal(item.inventoryPolicy, "TRACKED", "abort must restore policy");
    assert.equal(item.policyVersion, 0, "abort must restore version");
  });

  test("single-attempt transaction does not reuse mutable state on transient errors", async () => {
    let calls = 0;
    const conn = {
      startSession: async () => ({
        startTransaction() {},
        commitTransaction() {},
        abortTransaction() {},
        endSession() {},
      }),
    };
    await assert.rejects(
      () =>
        runInTransaction(
          conn,
          async () => {
            calls += 1;
            const err = new Error("write conflict");
            err.code = 112;
            throw err;
          },
          { maxAttempts: 1 }
        ),
      (err) => err.code === 112
    );
    assert.equal(calls, 1, "single-attempt runner must not retry the callback");
  });

  test("version bump receives the transaction session", async () => {
    const doc = { _id: oid(ITEM), policyVersion: 0 };
    const optsSeen = [];
    const session = { marker: "tx" };
    const MenuItem = {
      findOneAndUpdate(filter, update, opts) {
        optsSeen.push(opts);
        Object.assign(doc, update.$set);
        return chain(doc);
      },
    };
    await bumpMenuItemPolicyVersions(
      { models: { MenuItem } },
      [{ menuItemId: ITEM, expectedVersion: 0 }],
      session
    );
    assert.equal(optsSeen.length, 1);
    assert.equal(optsSeen[0].session, session);
    assert.equal(optsSeen[0].maxAttempts, undefined);
  });

  function makeEditConn({ nullOrderWrite = false } = {}) {
    const current = {
      _id: ITEM,
      name: { en: "Coffee" },
      price: 10,
      categoryType: "FOOD",
      station: "KITCHEN",
      targetStation: "KITCHEN",
      isAvailable: true,
      inStock: true,
      inventoryPolicy: "TRACKED",
      policyVersion: 0,
    };
    const original = { policyVersion: 0, inventoryPolicy: "TRACKED" };
    const calls = {
      commits: 0,
      aborts: 0,
      reads: 0,
      writes: [],
      writeOpts: [],
      versionOpts: [],
      staleSimulated: false,
      onAbort: () => Object.assign(current, original),
    };
    const existing = {
      _id: oid("507f1f77bcf86cd799439077"),
      status: "PENDING",
      waiterId: null,
      totalAmount: 10,
      inventoryRecipeSnapshot: null,
      items: [{ lineId: oid("507f1f77bcf86cd799439078"), name: "Old", price: 10, quantity: 1, cancelled: false, itemId: oid(ITEM), inventoryPolicySnapshot: "TRACKED" }],
    };
    const MenuItem = {
      find() {
        calls.reads += 1;
        return chain([{ ...current }]);
      },
      findOneAndUpdate(filter, update, opts) {
        calls.versionOpts.push(opts);
        const expected = filter.policyVersion;
        const ok =
          expected && typeof expected === "object" && Array.isArray(expected.$in)
            ? expected.$in.includes(current.policyVersion ?? 0)
            : current.policyVersion === expected;
        if (!ok) return chain(null);
        if (!calls.staleSimulated && !nullOrderWrite) {
          calls.staleSimulated = true;
          current.policyVersion = 1;
          current.inventoryPolicy = "UNTRACKED";
          return chain(null);
        }
        Object.assign(current, update.$set);
        return chain({ ...current });
      },
    };
    const Order = {
      findOne: () => chain(existing),
      findOneAndUpdate(filter, update, opts) {
        calls.writeOpts.push(opts);
        if (nullOrderWrite) return chain(null);
        calls.writes.push(update);
        return chain({ ...existing, ...(update.$set || {}) });
      },
    };
    const conn = sessionConn({
      MenuItem,
      Order,
      Recipe: {
        find: () =>
          chain([{ menuItemId: ITEM, isActive: true, ingredients: [{ inventoryItemId: INV, quantity: 1, unit: "g" }] }]),
      },
      InventoryItem: { find: () => chain([]) },
      ExtraItem: { find: () => chain([]), findOne: () => chain(null) },
      InventoryAudit: { create: async () => ({}) },
    }, calls);
    return { conn, calls, existing };
  }
  const addChange = [{ op: "add", menuItemId: ITEM, quantity: 1 }];

  test("add-line edit retry re-resolves catalog after a version conflict", async () => {
    const { conn, calls } = makeEditConn();
    // The simulated classification is an external committed change, not part
    // of the aborted transaction, so rollback must not undo it.
    calls.onAbort = () => {};
    const doc = await editOrderItems(conn, "507f1f77bcf86cd799439077", addChange, {
      staffRole: "MANAGER",
    });
    assert.equal(calls.reads, 2, "catalog re-resolved after conflict");
    assert.equal(doc.items[0].inventoryPolicySnapshot, "TRACKED", "existing line unchanged");
    assert.equal(doc.items[1].inventoryPolicySnapshot, "UNTRACKED", "new line captures fresh policy");
    assert.ok(calls.versionOpts.every((o) => o && o.session));
    assert.ok(calls.writeOpts.every((o) => o && o.session));
    assert.equal(calls.commits, 1);
  });

  test("null order write after version bump aborts the transaction", async () => {
    const { conn, calls } = makeEditConn({ nullOrderWrite: true });
    await assert.rejects(
      () => editOrderItems(conn, "507f1f77bcf86cd799439077", addChange, { staffRole: "MANAGER" }),
      (err) => err.code === ORDER_EDIT_CONFLICT
    );
    assert.ok(calls.aborts >= 1);
    assert.equal(calls.commits, 0);
    assert.equal(calls.writes.length, 0);
  });
});

describe("2.1 — canonical lifecycle", () => {
  test("canonical helper exposes one verified terminal/open split", () => {
    assert.deepEqual([...OPEN_ORDER_STATUSES].sort(), ["PENDING", "PREPARING", "READY"].sort());
    assert.ok(TERMINAL_ORDER_STATUSES.includes("SERVED"));
    assert.ok(TERMINAL_ORDER_STATUSES.includes("PAYMENT_PENDING"));
    assert.equal(isOpenOrderStatus("PREPARING"), true);
    assert.equal(isTerminalOrderStatus("SERVED"), true);
    assert.equal(isOpenOrderStatus("PAID"), false);
    assert.equal(isTerminalOrderStatus("UNKNOWN"), false);
    const orders = src("lib/orderService.js");
    assert.equal(orders.includes('["SERVED", "PAYMENT_PENDING", "PAID", "CANCELLED", "ARCHIVED"]'), false);
  });

  function lifecycleConn(orderStatus) {
    const item = { _id: oid(ITEM), name: { en: "Coffee" }, inventoryPolicy: "TRACKED", policyVersion: 0 };
    const MenuItem = {
      findOne: () => chain(item),
      find: () => chain([]),
      findOneAndUpdate(filter, update) { Object.assign(item, update.$set); return chain(item); },
    };
    const Order = {
      find: (filter) => {
        const statuses = filter?.status?.$in || [];
        const rows = statuses.includes(orderStatus)
          ? [{ _id: oid("507f1f77bcf86cd799439088"), status: orderStatus, items: [{ itemId: oid(ITEM), cancelled: false }] }]
          : [];
        return chain(rows);
      },
    };
    const InventoryAudit = { create: async (d) => d };
    return sessionConn({ MenuItem, Order, Recipe: { find: () => chain([]) }, InventoryItem: { find: () => chain([]) }, InventoryAudit });
  }

  test("genuinely open orders block; verified terminal orders do not", async () => {
    await assert.rejects(
      () => classifyMenuItemInventoryPolicy(lifecycleConn("PREPARING"), {
        menuItemId: ITEM, requestedPolicy: "UNTRACKED",
        actor: { staffId: STAFF, role: "MANAGER" },
      }),
      (err) => err.code === "MENU_POLICY_OPEN_ORDERS"
    );
    for (const status of ["SERVED", "PAYMENT_PENDING", "PAID", "CANCELLED", "ARCHIVED"]) {
      const res = await classifyMenuItemInventoryPolicy(lifecycleConn(status), {
        menuItemId: ITEM, requestedPolicy: "UNTRACKED",
        actor: { staffId: STAFF, role: "MANAGER" },
      });
      assert.equal(res.changed, true, `${status} should not block`);
    }
  });
});

describe("2.1 — legacy identity fallback", () => {
  function legacyConn(lines, menuItems = []) {
    const item = { _id: oid(ITEM), name: { en: "Coffee", am: "ቡና" }, inventoryPolicy: "TRACKED", policyVersion: 0 };
    const MenuItem = {
      findOne: () => chain(item),
      find: (filter) => {
        let rows = menuItems.filter((m) => String(m._id) !== String(item._id));
        if (filter?._id?.$ne) rows = rows.filter((m) => String(m._id) !== String(filter._id.$ne));
        if (filter?.isDeleted?.$ne === true) rows = rows.filter((m) => m.isDeleted !== true);
        if (Array.isArray(filter?.$or)) {
          rows = rows.filter((m) =>
            filter.$or.some((clause) => {
              if (Object.prototype.hasOwnProperty.call(clause, "name")) {
                return String(m.name) === String(clause.name);
              }
              for (const key of ["en", "am", "om"]) {
                const field = `name.${key}`;
                if (Object.prototype.hasOwnProperty.call(clause, field)) {
                  return String(m.name?.[key]) === String(clause[field]);
                }
              }
              return false;
            })
          );
        }
        return chain(rows);
      },
      findOneAndUpdate(filter, update) { Object.assign(item, update.$set); return chain(item); },
    };
    const Order = {
      find: (filter) => {
        if (!filter?.items?.$elemMatch?.$or) return chain([]);
        return chain([{ _id: oid("507f1f77bcf86cd799439088"), status: "PENDING", items: lines }]);
      },
    };
    return sessionConn({
      MenuItem, Order,
      Recipe: { find: () => chain([]) },
      InventoryItem: { find: () => chain([]) },
      InventoryAudit: { create: async (d) => d },
    });
  }
  const input = { menuItemId: ITEM, requestedPolicy: "UNTRACKED", actor: { staffId: STAFF, role: "MANAGER" } };

  test("name-only legacy line matching the item blocks", async () => {
    await assert.rejects(
      () => classifyMenuItemInventoryPolicy(legacyConn([{ name: "Coffee", cancelled: false }]), input),
      (err) => err.code === "MENU_POLICY_OPEN_ORDERS"
    );
  });
  test("missing itemId with no name fails closed", async () => {
    await assert.rejects(
      () => classifyMenuItemInventoryPolicy(legacyConn([{ cancelled: false }]), input),
      (err) => err.code === "LEGACY_LINE_IDENTITY_UNRESOLVED"
    );
  });
  test("ambiguous name shared with another MenuItem fails closed", async () => {
    const other = { _id: oid(OTHER), name: { en: "Coffee" }, isDeleted: false };
    await assert.rejects(
      () => classifyMenuItemInventoryPolicy(legacyConn([{ name: "Coffee", cancelled: false }], [other]), input),
      (err) => err.code === "LEGACY_LINE_IDENTITY_UNRESOLVED"
    );
  });
  test("provably unrelated and cancelled legacy lines do not block", async () => {
    const other = { _id: oid("507f1f77bcf86cd799439013"), name: { en: "Tea" }, isDeleted: false };
    const res = await classifyMenuItemInventoryPolicy(
      legacyConn(
        [{ name: "Tea", cancelled: false }, { name: "Coffee", cancelled: true }],
        [other]
      ),
      input
    );
    assert.equal(res.changed, true);
  });
  test("unknown or renamed legacy name fails closed", async () => {
    await assert.rejects(
      () => classifyMenuItemInventoryPolicy(legacyConn([{ name: "Old Coffee Name", cancelled: false }]), input),
      (err) => err.code === "LEGACY_LINE_IDENTITY_UNRESOLVED"
    );
  });
  test("legacy name matching multiple other MenuItems fails closed", async () => {
    const a = { _id: oid("507f1f77bcf86cd799439013"), name: { en: "Tea" }, isDeleted: false };
    const b = { _id: oid("507f1f77bcf86cd799439014"), name: { en: "Tea" }, isDeleted: false };
    await assert.rejects(
      () => classifyMenuItemInventoryPolicy(legacyConn([{ name: "Tea", cancelled: false }], [a, b]), input),
      (err) => err.code === "LEGACY_LINE_IDENTITY_UNRESOLVED"
    );
  });
});

describe("2.1 — audit visibility and UI source contracts", () => {
  test("audit route maps reason, actor and snapshots", () => {
    const route = src("app/api/inventory/audits/route.js");
    assert.ok(route.includes("notes: d.reason || \"\""));
    assert.ok(route.includes("actorName: d.actorId"));
    assert.ok(route.includes("actor: d.actorId"));
    assert.ok(route.includes("MENU_ITEM_INVENTORY_POLICY_CHANGE"));
    assert.ok(route.includes("beforeSnapshot: d.beforeSnapshot"));
    assert.ok(route.includes("afterSnapshot: d.afterSnapshot"));
  });
  test("Manager audit UI renders policy change distinctly and does not fake System", () => {
    const ui = src("app/components/InventoryUI.jsx");
    assert.ok(ui.includes("isPolicyChange"));
    assert.ok(ui.includes("policyDetail"));
    assert.ok(ui.includes("a.actorName || a.actor || 'System'"));
    assert.ok(ui.includes("invPolicyChange"));
  });
  test("classification action is protected against duplicate submission", () => {
    const client = src("app/manager/menu-crud/MenuCrudClient.jsx");
    assert.ok(client.includes("classificationInFlight"));
    assert.ok(client.includes("classificationInFlight.current = true"));
    assert.ok(client.includes("classificationInFlight.current = false"));
    assert.ok(client.includes("if (res.changed)"));
    assert.ok(client.includes("catch (err)"), "network/server exceptions are caught");
    assert.ok(client.includes("setFormError(err?.message || 'Failed to change inventory classification')"));
  });
  test("lifecycle terminal helper remains the single source of truth", () => {
    const orders = src("lib/orderService.js");
    assert.equal(orders.includes('["SERVED", "PAYMENT_PENDING", "PAID", "CANCELLED", "ARCHIVED"]'), false);
    assert.ok(orders.includes("isTerminalOrderStatus(pre.status)"));
    assert.ok(orders.includes("isTerminalOrderStatus(existing.status)"));
    assert.ok(orders.includes("isTerminalOrderStatus(re.status)"));
  });
});
