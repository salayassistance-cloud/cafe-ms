// OBS-3 Option 2 — DB-free coordination, transaction-runner, and service tests.
//
// No MongoDB connection is opened and no environment file is read. These tests
// exercise the exact production modules the routes delegate to:
//
//   * lib/recipeUnitCoordination.js  — pure participation/write planning;
//   * lib/transactionRunner.js       — the single bounded retry policy;
//   * lib/recipeWriteService.js      — transactional Recipe POST/PATCH;
//   * lib/inventoryItemWriteService.js — transactional InventoryItem PATCH.
//
// Fake connections/models stand in for mongoose collections so the services can
// be driven through success, validation, retry, duplicate and unknown-commit
// paths while asserting session boundaries. The live replica-set proof lives in
// tests/integration/phase23-replica-set.integration.mjs and only runs when the
// disposable-database flags are supplied.

import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STOCK_GROUP } from "../lib/inventoryCategories.js";
import {
  collectAffectedInventoryItemIds,
  buildUnitRevisionWrites,
  shouldCoordinateRecipeWrite,
  RecipeWriteError,
  InventoryItemWriteError,
  isRecipeWriteError,
  isInventoryItemWriteError,
  RECIPE_UNIT_CHANGED,
  INVENTORY_ITEM_CHANGED,
  RECIPE_COMMIT_UNKNOWN,
  INVENTORY_COMMIT_UNKNOWN,
} from "../lib/recipeUnitCoordination.js";
import {
  runInTransaction,
  errorChain,
  hasLabel,
  hasCode,
  isTransientTransactionError,
  isUnknownCommitResult,
  isTransactionsUnsupportedError,
  TransactionRunnerError,
} from "../lib/transactionRunner.js";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const { createRecipe, updateRecipe } = await import("../lib/recipeWriteService.js");
const { updateInventoryItem } = await import("../lib/inventoryItemWriteService.js");
const { RECIPE_UNIT_MISMATCH } = await import("../lib/recipeStockArea.js");
const { validateRecipeUpdate } = await import("../lib/recipeValidation.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const ITEM_A = "507f1f77bcf86cd799439011";
const ITEM_B = "507f1f77bcf86cd799439012";
const MENU_ID = "507f1f77bcf86cd799439013";
const RECIPE_ID = "507f1f77bcf86cd799439014";
const ITEM_ID = "507f1f77bcf86cd799439015";

const foodMenu = { _id: MENU_ID, name: { en: "Dish" }, categoryType: "FOOD" };
const ingredient = (id, unit = "g", quantity = 1) => ({
  inventoryItemId: id,
  quantity,
  unit,
});
const stockDoc = (id, overrides = {}) => ({
  _id: id,
  name: `Item ${id.slice(-2)}`,
  category: "Dry",
  unit: "g",
  stockGroup: STOCK_GROUP.KITCHEN,
  currentStock: 10,
  status: "In Stock",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Fake Mongoose surface
// ---------------------------------------------------------------------------

function makeSession({ commitError = null, abortError = null, endError = null } = {}) {
  return {
    started: false,
    ended: false,
    committed: 0,
    aborted: 0,
    startTransaction() {
      this.started = true;
    },
    async commitTransaction() {
      this.committed += 1;
      if (commitError) throw commitError;
    },
    async abortTransaction() {
      this.aborted += 1;
      if (abortError) throw abortError;
    },
    async endSession() {
      this.ended = true;
      if (endError) throw endError;
    },
  };
}

function makeConn(models, sessionFactory = null) {
  const sessions = [];
  return {
    models,
    sessions,
    async startSession() {
      const session = sessionFactory ? sessionFactory(sessions.length) : makeSession();
      sessions.push(session);
      return session;
    },
  };
}

// Chainable query stub: .select() / .session() / .lean(), and awaitable so
// Model.exists(...) behaves like the driver.
function makeQuery(value, hooks, label, error = null) {
  const q = {
    select() {
      return q;
    },
    session(session) {
      hooks.sessions.push({ label, session });
      return q;
    },
    lean() {
      return error ? Promise.reject(error) : Promise.resolve(value);
    },
    then(onFulfilled, onRejected) {
      const promise = error ? Promise.reject(error) : Promise.resolve(value);
      return promise.then(onFulfilled, onRejected);
    },
  };
  return q;
}

function labeledError(label) {
  const err = new Error(label);
  err.errorLabels = [label];
  return err;
}

function codedError(code, message = `error ${code}`) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Pure coordination helpers
// ---------------------------------------------------------------------------

describe("OBS-3 helpers: coordination set and writes", () => {
  test("ids are normalized, deduplicated, sorted, and the input is not mutated", () => {
    const ingredients = [
      { inventoryItemId: `  ${ITEM_B.toUpperCase()}  ` },
      { inventoryItemId: ITEM_A },
      { inventoryItemId: ITEM_B },
      { inventoryItemId: "" },
      { inventoryItemId: null },
      {},
    ];
    const snapshot = JSON.parse(JSON.stringify(ingredients));

    assert.deepEqual(collectAffectedInventoryItemIds(ingredients), [ITEM_A, ITEM_B]);
    assert.deepEqual(ingredients, snapshot, "caller array and objects are untouched");
  });

  test("non-array input yields an empty set instead of throwing", () => {
    for (const value of [undefined, null, "x", 3, {}]) {
      assert.deepEqual(collectAffectedInventoryItemIds(value), []);
    }
  });

  test("unitRevision writes are sorted, ordered operations", () => {
    const writes = buildUnitRevisionWrites([ITEM_B, ITEM_A, ITEM_B]);
    assert.deepEqual(writes, [
      {
        updateOne: { filter: { _id: ITEM_A }, update: { $inc: { unitRevision: 1 } } },
      },
      {
        updateOne: { filter: { _id: ITEM_B }, update: { $inc: { unitRevision: 1 } } },
      },
    ]);
    const ids = [ITEM_B, ITEM_A];
    buildUnitRevisionWrites(ids);
    assert.deepEqual(ids, [ITEM_B, ITEM_A], "builder never mutates caller ids");
  });

  test("POST always coordinates the active reference set", () => {
    const plan = shouldCoordinateRecipeWrite({
      isCreate: true,
      nextIngredients: [ingredient(ITEM_B), ingredient(ITEM_A)],
    });
    assert.deepEqual(plan, { participate: true, ids: [ITEM_A, ITEM_B] });
  });

  test("participation table for PATCH", () => {
    const active = { isActive: true, ingredients: [ingredient(ITEM_A)] };
    const inactive = { isActive: false, ingredients: [ingredient(ITEM_A)] };
    const legacyActive = { ingredients: [ingredient(ITEM_A)] };

    const cases = [
      {
        name: "active ingredient edit",
        input: { current: active, changesIngredients: true, nextIngredients: [ingredient(ITEM_B)] },
        expected: { participate: true, ids: [ITEM_B] },
      },
      {
        name: "reactivation of an explicit false recipe",
        input: { current: inactive, nextIsActive: true },
        expected: { participate: true, ids: [ITEM_A] },
      },
      {
        name: "reactivation with a new ingredient payload",
        input: {
          current: inactive,
          nextIsActive: true,
          changesIngredients: true,
          nextIngredients: [ingredient(ITEM_B)],
        },
        expected: { participate: true, ids: [ITEM_B] },
      },
      {
        name: "deactivation",
        input: { current: active, nextIsActive: false, changesIngredients: true, nextIngredients: [ingredient(ITEM_B)] },
        expected: { participate: false, ids: [] },
      },
      {
        name: "inactive ingredient edit (D4)",
        input: { current: inactive, changesIngredients: true, nextIngredients: [ingredient(ITEM_B)] },
        expected: { participate: false, ids: [] },
      },
      {
        name: "menu-only edit",
        input: { current: active, changesIngredients: false },
        expected: { participate: false, ids: [] },
      },
      {
        name: "already-active no-op PATCH",
        input: { current: active, nextIsActive: true },
        expected: { participate: false, ids: [] },
      },
      {
        name: "legacy missing isActive stays active for an ingredient edit",
        input: { current: legacyActive, changesIngredients: true, nextIngredients: [ingredient(ITEM_A)] },
        expected: { participate: true, ids: [ITEM_A] },
      },
    ];

    for (const { name, input, expected } of cases) {
      assert.deepEqual(shouldCoordinateRecipeWrite(input), expected, name);
    }
  });

  test("removed ingredients are excluded from the committed coordination set", () => {
    const current = { isActive: true, ingredients: [ingredient(ITEM_A), ingredient(ITEM_B)] };
    const plan = shouldCoordinateRecipeWrite({
      current,
      changesIngredients: true,
      nextIngredients: [ingredient(ITEM_A)],
    });
    assert.deepEqual(plan, { participate: true, ids: [ITEM_A] });
  });

  test("typed errors carry stable codes and are distinguishable", () => {
    const recipeErr = new RecipeWriteError("changed", 409, RECIPE_UNIT_CHANGED);
    const itemErr = new InventoryItemWriteError("changed", 409, INVENTORY_ITEM_CHANGED);
    assert.equal(isRecipeWriteError(recipeErr), true);
    assert.equal(isInventoryItemWriteError(recipeErr), false);
    assert.equal(isInventoryItemWriteError(itemErr), true);
    assert.equal(isRecipeWriteError(itemErr), false);
    assert.equal(recipeErr.status, 409);
    assert.equal(recipeErr.code, RECIPE_UNIT_CHANGED);
  });
});

// ---------------------------------------------------------------------------
// Shared transaction runner
// ---------------------------------------------------------------------------

describe("OBS-3 runner: bounded retry and classification", () => {
  test("success commits once and always ends the session", async () => {
    const conn = makeConn({});
    const result = await runInTransaction(conn, async (session) => {
      assert.equal(session.started, true);
      return "done";
    });
    assert.equal(result, "done");
    assert.equal(conn.sessions.length, 1);
    assert.equal(conn.sessions[0].committed, 1);
    assert.equal(conn.sessions[0].ended, true);
  });

  test("a transient error is retried once and succeeds (20 ms fixed backoff)", async () => {
    const conn = makeConn({});
    let attempts = 0;
    const started = Date.now();
    const result = await runInTransaction(conn, async () => {
      attempts += 1;
      if (attempts === 1) throw codedError(112);
      return attempts;
    });
    assert.equal(result, 2);
    assert.equal(attempts, 2);
    assert.equal(conn.sessions.length, 2);
    assert.ok(conn.sessions.every((s) => s.ended === true));
    assert.equal(conn.sessions[0].aborted, 1);
    assert.ok(Date.now() - started >= 20, "the approved 20 ms backoff is applied");
  });

  test("exhaustion stops at three attempts and aborts/ends every session", async () => {
    const conn = makeConn({});
    let attempts = 0;
    await assert.rejects(
      runInTransaction(conn, async () => {
        attempts += 1;
        throw codedError(251);
      }),
      (err) => err.code === 251
    );
    assert.equal(attempts, 3);
    assert.equal(conn.sessions.length, 3);
    assert.ok(conn.sessions.every((s) => s.aborted === 1 && s.ended === true));
  });

  test("UnknownTransactionCommitResult is never retried", async () => {
    const conn = makeConn({}, (attempt) =>
      makeSession({ commitError: attempt === 0 ? labeledError("UnknownTransactionCommitResult") : null })
    );
    let attempts = 0;
    await assert.rejects(
      runInTransaction(conn, async () => {
        attempts += 1;
        return "candidate";
      }),
      (err) => isUnknownCommitResult(err)
    );
    assert.equal(attempts, 1);
    assert.equal(conn.sessions.length, 1);
    assert.equal(conn.sessions[0].ended, true);
  });

  test("unsupported standalone topology maps to the injected 503 error", async () => {
    const conn = makeConn({});
    await assert.rejects(
      runInTransaction(
        conn,
        async () => {
          const err = new Error("Transaction numbers are only allowed on a replica set member or mongos");
          throw err;
        },
        {
          makeUnavailableError: (message, status, code) =>
            new RecipeWriteError(message, status, code),
        }
      ),
      (err) => {
        assert.equal(isRecipeWriteError(err), true);
        assert.equal(err.status, 503);
        assert.equal(err.code, "TRANSACTIONS_UNAVAILABLE");
        return true;
      }
    );
    assert.equal(conn.sessions.length, 1);
  });

  test("a typed business error is never retried", async () => {
    const conn = makeConn({});
    let attempts = 0;
    const failure = new RecipeWriteError("validation failed", 400, "NOPE");
    await assert.rejects(
      runInTransaction(conn, async () => {
        attempts += 1;
        throw failure;
      }),
      (err) => err === failure
    );
    assert.equal(attempts, 1);
  });

  test("session cleanup survives abort/end failures", async () => {
    const conn = makeConn({}, () =>
      makeSession({ abortError: new Error("abort failed"), endError: new Error("end failed") })
    );
    let attempts = 0;
    await assert.rejects(
      runInTransaction(conn, async () => {
        attempts += 1;
        throw codedError(112);
      })
    );
    assert.equal(attempts, 3, "a failing abort must not stop the retry loop");
    assert.ok(conn.sessions.every((s) => s.ended === true));
  });

  test("classification follows the wrapped driver error chain", () => {
    const inner = labeledError("TransientTransactionError");
    const outer = new Error("wrapped");
    outer.originalError = inner;
    const outer2 = new Error("wrapped twice");
    outer2.cause = outer;

    assert.deepEqual(errorChain(outer2), [outer2, outer, inner]);
    assert.equal(hasLabel(outer2, "TransientTransactionError"), true);
    assert.equal(isTransientTransactionError(outer2), true);
    assert.equal(hasCode({ originalError: codedError(251) }, [112, 251]), true);
    assert.equal(isUnknownCommitResult(outer2), false);
    assert.equal(
      isTransactionsUnsupportedError(
        Object.assign(new Error("x"), { cause: new Error("does not support retryable writes") })
      ),
      true
    );
    assert.equal(isTransactionsUnsupportedError(new Error("unrelated")), false);
  });

  test("the default availability error keeps the shared 503 contract", () => {
    const err = new TransactionRunnerError("down", 503, "TRANSACTIONS_UNAVAILABLE");
    assert.equal(err.status, 503);
    assert.equal(err.code, "TRANSACTIONS_UNAVAILABLE");
  });

  test("the reservation service delegates to the shared runner", () => {
    const service = src("lib/inventoryReservationService.js");
    assert.ok(service.includes("runInTransaction as runSharedTransaction"));
    assert.ok(service.includes("new InventoryReservationError(message, status, code)"));
    assert.equal(service.includes("attempt < 3"), false, "no second retry policy");
    assert.equal(service.includes("attempt < 2"), false, "no second retry policy");
  });
});

// ---------------------------------------------------------------------------
// Recipe transactional service
// ---------------------------------------------------------------------------

function makeRecipeModels({
  menu = foodMenu,
  invDocs = [],
  existing = null,
  current = null,
  updated = null,
  saveError = null,
  bulkError = null,
} = {}) {
  const hooks = { sessions: [], saves: [], bulk: [] };

  class FakeRecipe {
    constructor(data) {
      Object.assign(this, data);
      this._id = RECIPE_ID;
    }
    toObject() {
      return { ...this };
    }
    async save(options = {}) {
      hooks.saves.push({ doc: this, options });
      if (saveError) throw saveError;
    }
  }
  FakeRecipe.findById = () => makeQuery(current, hooks, "Recipe.findById");
  FakeRecipe.findOne = () => makeQuery(existing, hooks, "Recipe.findOne");
  FakeRecipe.findOneAndUpdate = () => makeQuery(updated, hooks, "Recipe.findOneAndUpdate");

  const MenuItem = {
    findById: () => makeQuery(menu, hooks, "MenuItem.findById"),
  };
  const InventoryItem = {
    find: () => makeQuery(invDocs, hooks, "InventoryItem.find"),
    async bulkWrite(ops, options) {
      hooks.bulk.push({ ops, options });
      if (bulkError) throw bulkError;
      return { matchedCount: ops.length, modifiedCount: ops.length };
    },
  };

  return { conn: makeConn({ Recipe: FakeRecipe, MenuItem, InventoryItem }), hooks };
}

function makeUpdateModels(options = {}) {
  return makeRecipeModels(options);
}

describe("OBS-3 recipe service: create", () => {
  const twoItems = [stockDoc(ITEM_A), stockDoc(ITEM_B)];

  test("validates and writes in one session, then coordinates sorted ids", async () => {
    const { conn, hooks } = makeRecipeModels({ invDocs: twoItems });
    const result = await createRecipe(conn, {
      menuItemId: MENU_ID,
      ingredients: [ingredient(ITEM_B), ingredient(ITEM_A)],
    });

    const session = conn.sessions[0];
    assert.equal(conn.sessions.length, 1);
    assert.equal(result.doc._id, RECIPE_ID);
    assert.equal(result.menuDoc, foodMenu);
    assert.equal(result.invDocs.length, 2);

    assert.ok(hooks.sessions.length >= 3, "menu, inventory and duplicate reads are session-bound");
    assert.ok(hooks.sessions.every((entry) => entry.session === session));
    assert.equal(hooks.saves.length, 1);
    assert.equal(hooks.saves[0].options.session, session);

    assert.equal(hooks.bulk.length, 1);
    assert.equal(hooks.bulk[0].options.session, session);
    assert.equal(hooks.bulk[0].options.ordered, true);
    assert.equal(hooks.bulk[0].options.timestamps, false);
    assert.deepEqual(
      hooks.bulk[0].ops.map((op) => op.updateOne.filter._id),
      [ITEM_A, ITEM_B]
    );
    assert.ok(hooks.bulk[0].ops.every((op) => op.updateOne.update.$inc.unitRevision === 1));
    assert.equal(session.committed, 1);
    assert.equal(session.ended, true);
  });

  test("no write happens when the menu item is missing", async () => {
    const { conn, hooks } = makeRecipeModels({ menu: null, invDocs: twoItems });
    await assert.rejects(createRecipe(conn, { menuItemId: MENU_ID, ingredients: [ingredient(ITEM_A)] }), (err) => {
      assert.equal(isRecipeWriteError(err), true);
      assert.equal(err.status, 404);
      return true;
    });
    assert.equal(hooks.saves.length, 0);
    assert.equal(hooks.bulk.length, 0);
  });

  test("unit mismatch fails before any write", async () => {
    const { conn, hooks } = makeRecipeModels({
      invDocs: [stockDoc(ITEM_A, { unit: "kg" })],
    });
    await assert.rejects(
      createRecipe(conn, { menuItemId: MENU_ID, ingredients: [ingredient(ITEM_A, "g")] }),
      (err) => {
        assert.equal(isRecipeWriteError(err), true);
        assert.equal(err.status, 400);
        assert.match(err.message, /Unit mismatch/);
        return true;
      }
    );
    assert.equal(hooks.saves.length, 0);
    assert.equal(hooks.bulk.length, 0);
  });

  test("stock-area mismatch fails before any write", async () => {
    const { conn, hooks } = makeRecipeModels({
      invDocs: [stockDoc(ITEM_A, { stockGroup: STOCK_GROUP.EXTRA })],
    });
    await assert.rejects(
      createRecipe(conn, { menuItemId: MENU_ID, ingredients: [ingredient(ITEM_A)] }),
      (err) => {
        assert.equal(isRecipeWriteError(err), true);
        assert.equal(err.status, 400);
        return true;
      }
    );
    assert.equal(hooks.saves.length, 0);
    assert.equal(hooks.bulk.length, 0);
  });

  test("duplicate ingredient rows still fail exactly as before", async () => {
    const { conn, hooks } = makeRecipeModels({ invDocs: [stockDoc(ITEM_A)] });
    await assert.rejects(
      createRecipe(conn, {
        menuItemId: MENU_ID,
        ingredients: [ingredient(ITEM_A), ingredient(ITEM_A)],
      }),
      (err) => {
        assert.equal(err.status, 404);
        assert.equal(err.message, "One or more inventory items not found");
        return true;
      }
    );
    assert.equal(hooks.saves.length, 0);
  });

  test("duplicate-key races map to the existing 409 recipe message", async () => {
    const { conn } = makeRecipeModels({
      invDocs: [stockDoc(ITEM_A)],
      saveError: codedError(11000, "E11000 duplicate key"),
    });
    await assert.rejects(
      createRecipe(conn, { menuItemId: MENU_ID, ingredients: [ingredient(ITEM_A)] }),
      (err) => {
        assert.equal(isRecipeWriteError(err), true);
        assert.equal(err.status, 409);
        assert.equal(err.message, "Recipe for this menu item already exists");
        return true;
      }
    );
    assert.equal(conn.sessions.length, 1, "duplicate keys are never retried");
  });

  test("exhausted transient conflicts map to 409 RECIPE_UNIT_CHANGED", async () => {
    const { conn, hooks } = makeRecipeModels({
      invDocs: [stockDoc(ITEM_A)],
      bulkError: labeledError("TransientTransactionError"),
    });
    await assert.rejects(
      createRecipe(conn, { menuItemId: MENU_ID, ingredients: [ingredient(ITEM_A)] }),
      (err) => {
        assert.equal(isRecipeWriteError(err), true);
        assert.equal(err.status, 409);
        assert.equal(err.code, RECIPE_UNIT_CHANGED);
        return true;
      }
    );
    assert.equal(hooks.bulk.length, 3, "bounded to three attempts");
    assert.equal(conn.sessions.length, 3);
    assert.ok(conn.sessions.every((s) => s.ended === true));
  });

  test("a coordination no-match aborts with 409 INVENTORY_ITEM_CHANGED", async () => {
    const hooks = { sessions: [], saves: [], bulk: [] };
    class FakeRecipe {
      constructor(data) {
        Object.assign(this, data);
        this._id = RECIPE_ID;
      }
      toObject() {
        return { ...this };
      }
      async save(options) {
        hooks.saves.push(options);
      }
    }
    FakeRecipe.findById = () => makeQuery(null, hooks, "Recipe.findById");
    FakeRecipe.findOne = () => makeQuery(null, hooks, "Recipe.findOne");
    const MenuItem = { findById: () => makeQuery(foodMenu, hooks, "MenuItem.findById") };
    const InventoryItem = {
      find: () => makeQuery([stockDoc(ITEM_A)], hooks, "InventoryItem.find"),
      async bulkWrite() {
        // Simulate a document deleted after validation: the $inc matches nothing.
        return { matchedCount: 0, modifiedCount: 0 };
      },
    };
    const conn = makeConn({ Recipe: FakeRecipe, MenuItem, InventoryItem });

    await assert.rejects(
      createRecipe(conn, { menuItemId: MENU_ID, ingredients: [ingredient(ITEM_A)] }),
      (err) => {
        assert.equal(isRecipeWriteError(err), true);
        assert.equal(err.status, 409);
        assert.equal(err.code, INVENTORY_ITEM_CHANGED);
        return true;
      }
    );
    assert.equal(conn.sessions[0].aborted, 1, "the Recipe write is rolled back");
    assert.equal(conn.sessions.length, 1, "a coordination miss is not blindly retried");
  });

  test("unknown commit maps to 409 RECIPE_COMMIT_UNKNOWN without retry", async () => {
    const hooks = { sessions: [], saves: [], bulk: [] };
    class FakeRecipe {
      constructor(data) {
        Object.assign(this, data);
        this._id = RECIPE_ID;
      }
      toObject() {
        return { ...this };
      }
      async save(options) {
        hooks.saves.push(options);
      }
    }
    FakeRecipe.findById = () => makeQuery(null, hooks, "Recipe.findById");
    FakeRecipe.findOne = () => makeQuery(null, hooks, "Recipe.findOne");
    const MenuItem = { findById: () => makeQuery(foodMenu, hooks, "MenuItem.findById") };
    const InventoryItem = {
      find: () => makeQuery([stockDoc(ITEM_A)], hooks, "InventoryItem.find"),
      async bulkWrite(ops) {
        hooks.bulk.push(ops);
        return { matchedCount: ops.length };
      },
    };
    const conn = makeConn(
      { Recipe: FakeRecipe, MenuItem, InventoryItem },
      () => makeSession({ commitError: labeledError("UnknownTransactionCommitResult") })
    );

    await assert.rejects(
      createRecipe(conn, { menuItemId: MENU_ID, ingredients: [ingredient(ITEM_A)] }),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, RECIPE_COMMIT_UNKNOWN);
        return true;
      }
    );
    assert.equal(conn.sessions.length, 1, "unknown commit is never retried");
  });
});

describe("OBS-3 recipe service: update", () => {
  const activeRecipe = {
    _id: RECIPE_ID,
    menuItemId: MENU_ID,
    isActive: true,
    ingredients: [ingredient(ITEM_A), ingredient(ITEM_B)],
  };

  test("an active ingredient change coordinates only the committed set", async () => {
    const updated = { ...activeRecipe, ingredients: [ingredient(ITEM_A)] };
    const { conn, hooks } = makeUpdateModels({
      current: activeRecipe,
      invDocs: [stockDoc(ITEM_A)],
      updated,
    });

    await updateRecipe(conn, RECIPE_ID, { ingredients: [ingredient(ITEM_A)] });

    const session = conn.sessions[0];
    assert.ok(hooks.sessions.every((entry) => entry.session === session));
    assert.equal(hooks.bulk.length, 1);
    assert.equal(hooks.bulk[0].options.session, session);
    assert.deepEqual(
      hooks.bulk[0].ops.map((op) => op.updateOne.filter._id),
      [ITEM_A],
      "the removed ingredient is not coordinated"
    );
  });

  test("deactivation never coordinates", async () => {
    const updated = { ...activeRecipe, isActive: false };
    const { conn, hooks } = makeUpdateModels({ current: activeRecipe, updated });
    await updateRecipe(conn, RECIPE_ID, { isActive: false });
    assert.equal(hooks.bulk.length, 0);
  });

  test("a no-op ingredient resend never coordinates", async () => {
    const { conn, hooks } = makeUpdateModels({
      current: activeRecipe,
      invDocs: [stockDoc(ITEM_A), stockDoc(ITEM_B)],
      updated: activeRecipe,
    });
    await updateRecipe(conn, RECIPE_ID, {
      ingredients: [ingredient(ITEM_A), ingredient(ITEM_B)],
    });
    assert.equal(hooks.bulk.length, 0);
  });

  test("a menu-only edit never coordinates", async () => {
    const updated = { ...activeRecipe, menuItemId: MENU_ID };
    const { conn, hooks } = makeUpdateModels({
      current: activeRecipe,
      menu: foodMenu,
      invDocs: [stockDoc(ITEM_A), stockDoc(ITEM_B)],
      updated,
    });
    await updateRecipe(conn, RECIPE_ID, { menuItemId: MENU_ID });
    assert.equal(hooks.bulk.length, 0);
  });

  test("an inactive ingredient edit does not coordinate (D4)", async () => {
    const inactive = { ...activeRecipe, isActive: false };
    const updated = { ...inactive, ingredients: [ingredient(ITEM_A)] };
    const { conn, hooks } = makeUpdateModels({
      current: inactive,
      invDocs: [stockDoc(ITEM_A)],
      updated,
    });
    await updateRecipe(conn, RECIPE_ID, { ingredients: [ingredient(ITEM_A)] });
    assert.equal(hooks.bulk.length, 0);
  });

  test("reactivation coordinates the effective stored set", async () => {
    const inactive = { ...activeRecipe, isActive: false };
    const updated = { ...inactive, isActive: true };
    const { conn, hooks } = makeUpdateModels({
      current: inactive,
      invDocs: [stockDoc(ITEM_A), stockDoc(ITEM_B)],
      updated,
    });
    await updateRecipe(conn, RECIPE_ID, { isActive: true });
    assert.equal(hooks.bulk.length, 1);
    assert.deepEqual(
      hooks.bulk[0].ops.map((op) => op.updateOne.filter._id),
      [ITEM_A, ITEM_B]
    );
  });

  test("OBS-3b: reactivation with drifted units fails closed before any write", async () => {
    const inactive = {
      ...activeRecipe,
      isActive: false,
      ingredients: [ingredient(ITEM_A, "ml")],
    };
    const { conn, hooks } = makeUpdateModels({
      current: inactive,
      invDocs: [stockDoc(ITEM_A, { unit: "g" })],
      updated: { ...inactive, isActive: true },
    });

    await assert.rejects(updateRecipe(conn, RECIPE_ID, { isActive: true }), (err) => {
      assert.equal(isRecipeWriteError(err), true);
      assert.equal(err.status, 400);
      assert.equal(err.code, RECIPE_UNIT_MISMATCH);
      return true;
    });
    assert.equal(hooks.bulk.length, 0);
    assert.equal(hooks.sessions.some((e) => e.label === "Recipe.findOneAndUpdate"), false);
    assert.equal(conn.sessions[0].aborted, 1);
  });

  test("strict isActive validation happens before the service is reached", () => {
    const rejected = validateRecipeUpdate({ isActive: "false" });
    assert.equal(rejected.ok, undefined);
    assert.equal(rejected.code, "INVALID_IS_ACTIVE");
    const service = src("lib/recipeWriteService.js");
    assert.ok(service.includes("const activating = data.isActive === true"));
  });

  test("validation and coordination writes are ordered after all reads", () => {
    const service = src("lib/recipeWriteService.js");
    const createFn = service.slice(service.indexOf("export async function createRecipe"));
    const updateFn = service.slice(service.indexOf("export async function updateRecipe"));

    const createStockArea = createFn.indexOf("const stockArea = validateRecipeStockArea({");
    const createWrite = createFn.indexOf("await doc.save({ session })");
    const createBulk = createFn.indexOf("await writeUnitRevisions(InventoryItem, plan, session)");
    assert.ok(createStockArea > 0 && createStockArea < createWrite, "create validates before writing");
    assert.ok(createWrite < createBulk, "create coordinates after the Recipe write");

    const unitGate = updateFn.indexOf("const unitCompat = validateRecipeIngredientUnits({");
    const updateWrite = updateFn.indexOf("const doc = await Recipe.findOneAndUpdate(");
    const updateBulk = updateFn.indexOf("await writeUnitRevisions(InventoryItem, plan, session)");
    assert.ok(unitGate > 0 && unitGate < updateWrite, "reactivation gate precedes the update");
    assert.ok(updateWrite < updateBulk, "coordination writes follow the Recipe write");

    assert.ok(service.includes("ordered: true"));
    assert.ok(service.includes("timestamps: false"));
  });
});

// ---------------------------------------------------------------------------
// InventoryItem transactional service
// ---------------------------------------------------------------------------

const beforeItem = {
  _id: ITEM_ID,
  name: "Rice",
  category: "Dry",
  stockGroup: STOCK_GROUP.KITCHEN,
  unit: "kg",
  currentStock: 4,
  reservedStock: 0,
  minimumStock: 1,
  cost: 10,
  status: "In Stock",
  supplier: null,
};

function makeItemModels({
  before = beforeItem,
  after = beforeItem,
  beforeError = null,
  writeError = null,
  extraLinked = false,
  recipeLinked = false,
  sessionFactory = null,
} = {}) {
  const hooks = { sessions: [], writes: [], audits: [], extra: [], recipe: [] };

  const InventoryItem = {
    findById: () => makeQuery(before, hooks, "InventoryItem.findById", beforeError),
    findOneAndUpdate(filter, update, options) {
      hooks.writes.push({ filter, update, options });
      return makeQuery(after, hooks, "InventoryItem.findOneAndUpdate", writeError);
    },
  };
  const ExtraItem = {
    exists(filter) {
      hooks.extra.push(filter);
      return makeQuery(extraLinked ? { _id: "extra" } : null, hooks, "ExtraItem.exists");
    },
  };
  const Recipe = {
    exists(filter) {
      hooks.recipe.push(filter);
      return makeQuery(recipeLinked ? { _id: "recipe" } : null, hooks, "Recipe.exists");
    },
  };
  const InventoryAudit = {
    async create(docs, options) {
      hooks.audits.push({ docs, options });
      return docs;
    },
  };

  const conn = makeConn(
    { InventoryItem, ExtraItem, Recipe, InventoryAudit },
    sessionFactory
  );
  return { conn, hooks };
}

const managerActor = { staffId: null, role: "MANAGER" };

describe("OBS-3 inventory-item service", () => {
  test("a non-unit update writes once, audits in-session, and skips D2 checks", async () => {
    const after = { ...beforeItem, name: "Long Grain Rice" };
    const { conn, hooks } = makeItemModels({ after });

    const doc = await updateInventoryItem(conn, {
      itemId: ITEM_ID,
      data: { name: "Long Grain Rice" },
      actor: managerActor,
    });

    const session = conn.sessions[0];
    assert.equal(doc.name, "Long Grain Rice");
    assert.equal(hooks.extra.length, 0, "no Extra lookup without a unit change");
    assert.equal(hooks.recipe.length, 0, "no Recipe lookup without a unit change");
    assert.equal(hooks.writes.length, 1);
    assert.deepEqual(hooks.writes[0].filter, { _id: ITEM_ID });
    assert.equal(hooks.writes[0].update.$inc, undefined);
    assert.equal(hooks.writes[0].options.session, session);
    assert.equal(hooks.audits.length, 1);
    assert.equal(hooks.audits[0].docs[0].action, "ITEM_UPDATED");
    assert.equal(hooks.audits[0].options.session, session);
    assert.equal(session.committed, 1);
    assert.equal(session.ended, true);
  });

  test("an allowed unit change increments unitRevision in the same guarded write", async () => {
    const after = { ...beforeItem, unit: "g", unitRevision: 1 };
    const { conn, hooks } = makeItemModels({ after });

    await updateInventoryItem(conn, {
      itemId: ITEM_ID,
      data: { unit: "g" },
      actor: managerActor,
    });

    const session = conn.sessions[0];
    assert.equal(hooks.extra.length, 1);
    assert.equal(hooks.recipe.length, 1);
    assert.equal(hooks.recipe[0]["ingredients.inventoryItemId"], ITEM_ID);
    assert.deepEqual(hooks.recipe[0].isActive, { $ne: false });
    assert.deepEqual(hooks.writes[0].filter, { _id: ITEM_ID, unit: "kg" });
    assert.equal(hooks.writes[0].update.$set.unit, "g");
    assert.equal(hooks.writes[0].update.$inc.unitRevision, 1);
    assert.equal(hooks.writes[0].options.session, session);
    assert.equal(hooks.audits.length, 1);
    assert.equal(hooks.audits[0].docs[0].beforeSnapshot.unit, "kg");
    assert.equal(hooks.audits[0].docs[0].afterSnapshot.unit, "g");
  });

  test("D2 blocks a unit change while an active Recipe uses the item", async () => {
    const { conn, hooks } = makeItemModels({ recipeLinked: true });

    await assert.rejects(
      updateInventoryItem(conn, {
        itemId: ITEM_ID,
        data: { unit: "g" },
        actor: managerActor,
      }),
      (err) => {
        assert.equal(isInventoryItemWriteError(err), true);
        assert.equal(err.status, 409);
        assert.equal(err.code, "UNIT_IN_USE");
        assert.match(err.message, /Unit change blocked/);
        return true;
      }
    );
    assert.equal(hooks.writes.length, 0, "nothing is written when blocked");
    assert.equal(hooks.audits.length, 0, "the audit trail is untouched");
    assert.equal(conn.sessions[0].aborted, 1);
    assert.equal(conn.sessions[0].ended, true);
  });

  test("a guarded no-match returns 409 INVENTORY_ITEM_CHANGED", async () => {
    const { conn, hooks } = makeItemModels({ after: null });
    await assert.rejects(
      updateInventoryItem(conn, {
        itemId: ITEM_ID,
        data: { unit: "g" },
        actor: managerActor,
      }),
      (err) => {
        assert.equal(isInventoryItemWriteError(err), true);
        assert.equal(err.status, 409);
        assert.equal(err.code, INVENTORY_ITEM_CHANGED);
        return true;
      }
    );
    assert.equal(hooks.audits.length, 0);
  });

  test("a missing item returns 404 before any write", async () => {
    const { conn, hooks } = makeItemModels({ before: null });
    await assert.rejects(
      updateInventoryItem(conn, { itemId: ITEM_ID, data: { name: "X" }, actor: managerActor }),
      (err) => {
        assert.equal(err.status, 404);
        return true;
      }
    );
    assert.equal(hooks.writes.length, 0);
  });

  test("exhausted transient conflicts map to 409 INVENTORY_ITEM_CHANGED", async () => {
    const { conn } = makeItemModels({ beforeError: codedError(112) });
    await assert.rejects(
      updateInventoryItem(conn, { itemId: ITEM_ID, data: { name: "X" }, actor: managerActor }),
      (err) => {
        assert.equal(isInventoryItemWriteError(err), true);
        assert.equal(err.status, 409);
        assert.equal(err.code, INVENTORY_ITEM_CHANGED);
        return true;
      }
    );
    assert.equal(conn.sessions.length, 3);
    assert.ok(conn.sessions.every((s) => s.ended === true));
  });

  test("unknown commit maps to 409 INVENTORY_COMMIT_UNKNOWN without retry", async () => {
    const { conn } = makeItemModels({
      sessionFactory: () => makeSession({ commitError: labeledError("UnknownTransactionCommitResult") }),
    });
    await assert.rejects(
      updateInventoryItem(conn, { itemId: ITEM_ID, data: { name: "X" }, actor: managerActor }),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, INVENTORY_COMMIT_UNKNOWN);
        return true;
      }
    );
    assert.equal(conn.sessions.length, 1);
  });

  test("the route is thin and maps typed errors plus DB failures", () => {
    const route = src("app/api/inventory/items/[id]/route.js");
    const service = src("lib/inventoryItemWriteService.js");
    assert.ok(route.includes("updateInventoryItem(conn, {"));
    assert.ok(route.includes("isInventoryItemWriteError(err)"));
    assert.ok(route.includes("isDbError(err)"));
    assert.equal(route.includes("findOneAndUpdate"), false, "the route performs no writes");
    assert.equal(route.includes("$inc"), false, "the route performs no token writes");
    assert.ok(service.includes('"ingredients.inventoryItemId": itemId'));
    assert.ok(service.includes("...RECIPE_ACTIVE_FILTER"));
  });

  test("no API serializer exposes the coordination token", () => {
    assert.equal(src("lib/inventoryService.js").includes("unitRevision"), false);
    assert.equal(src("lib/recipeService.js").includes("unitRevision"), false);
    const schema = src("lib/models/InventoryItem.js");
    assert.ok(schema.includes("unitRevision: { type: Number, default: 0, min: 0 }"));
  });
});
