// H-1 / H-2 regression — DB-free.
//
// A tracked recipe row that exists but cannot produce a safe requirement
// (missing inventory link, invalid quantity, missing unit) must be reported as
// unresolved instead of being skipped. The reservation layer folds that into
// its existing blocking contract, so the order can never become a payable or
// preparable NO_INVENTORY.
//
// H-2: only an explicit `isActive: false` is inactive. `true`, missing, and
// legacy `undefined` are active, matching the D2 unit-change guard.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const {
  prepareInventoryDeduction,
  RECIPE_LOOKUP_FAILED_REASON,
  addRecipeLookupFailure,
} = await import("../lib/inventoryDeductionService.js");
const { validateRequirements, calculateRawRequirements } = await import(
  "../lib/inventoryReservationService.js"
);
const { isRecipeActive, RECIPE_ACTIVE_FILTER } = await import(
  "../lib/inventoryReservationRules.js"
);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const ORDER_ID = "507f1f77bcf86cd799439011";
const MENU_ID = "507f1f77bcf86cd799439012";
const INVENTORY_ID = "507f1f77bcf86cd799439013";

function fakeRecipeConn(recipes) {
  return {
    models: {
      Recipe: {
        find: () => ({ lean: async () => recipes }),
      },
    },
  };
}

function orderFor(menuItemId = MENU_ID, quantity = 1) {
  return {
    _id: ORDER_ID,
    items: [{ itemId: menuItemId, name: "Test dish", quantity, type: "FOOD" }],
  };
}

function recipe(ingredients, overrides = {}) {
  return { menuItemId: MENU_ID, ingredients, ...overrides };
}

async function planFor(recipeDoc) {
  return prepareInventoryDeduction(orderFor(), {
    connection: fakeRecipeConn([recipeDoc]),
  });
}

describe("H-1: malformed required recipe rows stay unresolved", () => {
  test("missing inventoryItemId never disappears", async () => {
    const plan = await planFor(recipe([{ quantity: 2, unit: "g" }]));
    assert.deepEqual(plan.ingredients, []);
    assert.equal(plan.unresolved.length, 1);
    assert.match(plan.unresolved[0], /no inventoryItemId/);
    assert.ok(plan.warnings.some((w) => w.includes("requirement unresolved")));
  });

  test("invalid quantities are unresolved, not skipped", async () => {
    for (const quantity of [0, -1, "abc", null]) {
      const plan = await planFor(recipe([{ inventoryItemId: INVENTORY_ID, quantity, unit: "g" }]));
      assert.deepEqual(plan.ingredients, [], `quantity ${String(quantity)} must not deduct`);
      assert.equal(plan.unresolved.length, 1, `quantity ${String(quantity)} must block`);
      assert.match(plan.unresolved[0], /invalid quantity/);
    }
  });

  test("a missing unit is unresolved, not skipped", async () => {
    const plan = await planFor(recipe([{ inventoryItemId: INVENTORY_ID, quantity: 2 }]));
    assert.deepEqual(plan.ingredients, []);
    assert.equal(plan.unresolved.length, 1);
    assert.match(plan.unresolved[0], /no unit/);
  });

  test("a valid row is still deducted while a malformed sibling blocks the order", async () => {
    const plan = await planFor(
      recipe([
        { inventoryItemId: INVENTORY_ID, quantity: 0.25, unit: "kg" },
        { quantity: 1, unit: "g" },
      ])
    );
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INVENTORY_ID, quantity: 0.25, unit: "kg" },
    ]);
    assert.equal(plan.unresolved.length, 1);
  });

  test("a genuine recipe-less menu item stays a valid untracked order", async () => {
    const plan = await prepareInventoryDeduction(orderFor(), {
      connection: fakeRecipeConn([]),
    });
    assert.deepEqual(plan.ingredients, []);
    assert.deepEqual(plan.unresolved, []);
  });

  test("an unresolved seed survives requirement validation", async () => {
    const validated = await validateRequirements({}, [], { unresolved: ["broken recipe row"] });
    assert.deepEqual(validated.unresolved, ["broken recipe row"]);
    assert.deepEqual(validated.items, []);
  });

  test("an unresolved seed blocks even when other requirements are valid", async () => {
    const conn = {
      models: {
        InventoryItem: {
          find: () => ({ select: () => ({ lean: async () => [] }) }),
        },
      },
    };
    const validated = await validateRequirements(
      conn,
      [{ inventoryItemId: INVENTORY_ID, unit: "g", requiredQuantity: 1 }],
      { unresolved: ["broken recipe row"] }
    );
    // The referenced item does not exist, so it is unresolved on its own; the
    // seeded reason must also still be present.
    assert.equal(validated.unresolved.length, 2);
    assert.ok(validated.unresolved.includes("broken recipe row"));
  });

  test("every reservation call site forwards the extraction seed", () => {
    const service = src("lib/inventoryReservationService.js");
    const forwarded = service.match(/unresolved: raw\.unresolved/g) || [];
    assert.equal(forwarded.length, 6, "all six validateRequirements call sites must pass the seed");
    assert.ok(service.includes("unresolved: Array.isArray(plan.unresolved)"));
    assert.ok(service.includes('code: "INVENTORY_UNRESOLVED"'));
  });
});

describe("H-2: one Recipe activation rule", () => {
  test("only an explicit false is inactive", () => {
    assert.equal(isRecipeActive({ isActive: true }), true);
    assert.equal(isRecipeActive({}), true);
    assert.equal(isRecipeActive({ isActive: undefined }), true);
    assert.equal(isRecipeActive({ isActive: false }), false);
    assert.equal(isRecipeActive(null), true);
  });

  test("the D2 query filter matches the document predicate", () => {
    assert.deepEqual(RECIPE_ACTIVE_FILTER, { isActive: { $ne: false } });
  });

  test("deduction selection treats legacy missing isActive as active", async () => {
    const missing = await planFor(
      recipe([{ inventoryItemId: INVENTORY_ID, quantity: 1, unit: "g" }])
    );
    assert.equal(missing.ingredients.length, 1);
    assert.deepEqual(missing.unresolved, []);

    const explicitTrue = await planFor(
      recipe([{ inventoryItemId: INVENTORY_ID, quantity: 1, unit: "g" }], { isActive: true })
    );
    assert.equal(explicitTrue.ingredients.length, 1);
  });

  test("an explicit false recipe is intentionally untracked, not unresolved", async () => {
    const plan = await planFor(
      recipe([{ inventoryItemId: INVENTORY_ID, quantity: 1, unit: "g" }], { isActive: false })
    );
    assert.deepEqual(plan.ingredients, []);
    assert.deepEqual(plan.unresolved, []);
  });

  test("the D2 guard uses the shared filter", () => {
    // OBS-3: the transactional unit-change guard lives in the production
    // service; the route only authenticates, validates and delegates.
    const service = src("lib/inventoryItemWriteService.js");
    assert.ok(service.includes("RECIPE_ACTIVE_FILTER"));
    assert.ok(service.includes("...RECIPE_ACTIVE_FILTER"));
    assert.equal(service.includes("isActive: { $ne: false }"), false);
  });
});

// H-1 fail-open correction: a Recipe lookup failure means the requirement set is
// unknown, not empty. It must add a stable unresolved reason so the reservation
// layer blocks instead of persisting a payable NO_INVENTORY.
describe("H-1: a Recipe lookup failure fails closed", () => {
  const failingFindConn = () => ({
    models: {
      Recipe: {
        find: () => {
          throw new Error("recipe query failed");
        },
      },
    },
  });

  test("a database connection failure marks the plan unresolved", async () => {
    const plan = await prepareInventoryDeduction(orderFor(), {
      connect: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    assert.deepEqual(plan.ingredients, []);
    assert.deepEqual(plan.deductions, []);
    assert.deepEqual(plan.unresolved, [RECIPE_LOOKUP_FAILED_REASON]);
  });

  test("a Recipe query failure marks the plan unresolved", async () => {
    const plan = await prepareInventoryDeduction(orderFor(), {
      connection: failingFindConn(),
    });
    assert.deepEqual(plan.ingredients, []);
    assert.deepEqual(plan.unresolved, [RECIPE_LOOKUP_FAILED_REASON]);
  });

  test("a failure while materialising recipes is also unresolved", async () => {
    const conn = {
      models: {
        Recipe: {
          find: () => ({
            lean: async () => {
              throw new Error("lean failed");
            },
          }),
        },
      },
    };
    const plan = await prepareInventoryDeduction(orderFor(), { connection: conn });
    assert.deepEqual(plan.unresolved, [RECIPE_LOOKUP_FAILED_REASON]);
  });

  test("warnings and unresolved are both populated on lookup failure", async () => {
    const plan = await prepareInventoryDeduction(orderFor(), {
      connection: failingFindConn(),
    });
    assert.equal(plan.warnings.length, 1);
    assert.ok(plan.warnings[0].includes("Failed to fetch recipes"));
    assert.equal(plan.unresolved.length, 1);
  });

  test("warnings and unresolved reasons from earlier rows are preserved", async () => {
    const order = {
      _id: ORDER_ID,
      items: [
        { itemId: "not-an-object-id", name: "Broken line", quantity: 1, type: "FOOD" },
        { itemId: MENU_ID, name: "Test dish", quantity: 1, type: "FOOD" },
      ],
    };
    const plan = await prepareInventoryDeduction(order, { connection: failingFindConn() });
    assert.ok(plan.warnings.some((w) => w.includes("invalid itemId")));
    assert.ok(plan.warnings.some((w) => w.includes("Failed to fetch recipes")));
    assert.deepEqual(plan.unresolved, [RECIPE_LOOKUP_FAILED_REASON]);
  });

  test("the reason helper appends without replacing or duplicating", () => {
    const seeded = ["recipe row 2 has no unit — requirement unresolved"];
    const expected = [...seeded, RECIPE_LOOKUP_FAILED_REASON];
    const result = addRecipeLookupFailure(seeded);
    assert.equal(result, seeded);
    assert.deepEqual(result, expected);
    addRecipeLookupFailure(result);
    assert.equal(result.length, 2);
    assert.deepEqual(addRecipeLookupFailure(undefined), undefined);
  });

  test("a successful lookup with no applicable recipe stays a clean empty plan", async () => {
    const plan = await prepareInventoryDeduction(orderFor(), {
      connection: fakeRecipeConn([]),
    });
    assert.deepEqual(plan.ingredients, []);
    assert.deepEqual(plan.unresolved, []);
    assert.ok(plan.warnings.some((w) => w.includes("Recipe missing")));
  });

  test("an explicit false recipe on a successful lookup is not unresolved", async () => {
    const plan = await planFor(
      recipe([{ inventoryItemId: INVENTORY_ID, quantity: 1, unit: "g" }], { isActive: false })
    );
    assert.deepEqual(plan.unresolved, []);
  });

  test("the unresolved lookup result cannot become NO_INVENTORY", async () => {
    const conn = failingFindConn();
    const raw = await calculateRawRequirements(conn, orderFor());
    assert.deepEqual(raw.requirements, []);
    assert.deepEqual(raw.unresolved, [RECIPE_LOOKUP_FAILED_REASON]);

    // Real production validation path: the seed survives an empty requirement
    // list, which is exactly the input to createNoInventoryReservation's
    // `blocked: unresolved.length > 0` decision.
    const validated = await validateRequirements(conn, raw.requirements, {
      unresolved: raw.unresolved,
    });
    assert.deepEqual(validated.items, []);
    assert.deepEqual(validated.unresolved, [RECIPE_LOOKUP_FAILED_REASON]);
    assert.ok(validated.unresolved.length > 0);

    const service = src("lib/inventoryReservationService.js");
    assert.ok(service.includes("const status = blocked ? \"INSUFFICIENT_STOCK\" : \"NO_INVENTORY\";"));
    assert.ok(service.includes("blocked: unresolved.length > 0"));
  });
});

