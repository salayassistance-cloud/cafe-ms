// D1 regression — DB-free.
//
// A legacy or payload-bypassing order line without a catalog itemId used to
// short-circuit prepareInventoryDeduction before the component loop. A priced
// Extra was then charged while its stock requirement was silently empty, and
// the reservation became NO_INVENTORY (ready to prepare/pay). The component
// loop must always run; only the recipe lookup may be skipped.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const { prepareInventoryDeduction } = await import("../lib/inventoryDeductionService.js");

const ORDER_ID = "507f1f77bcf86cd799439011";
const EXTRA_ID = "507f1f77bcf86cd799439012";
const INVENTORY_ID = "507f1f77bcf86cd799439013";

function legacyOrder(components, overrides = {}) {
  return {
    _id: ORDER_ID,
    items: [
      {
        name: "Custom plate",
        price: 100,
        quantity: 1,
        type: "FOOD",
        components,
        ...overrides,
      },
    ],
  };
}

describe("D1: stock-linked Extra is never skipped for an itemId-less parent", () => {
  test("legacy payload still produces the reservation requirement", async () => {
    const plan = await prepareInventoryDeduction(
      legacyOrder([
        {
          kind: "PRICED_COMPONENT",
          extraItemId: EXTRA_ID,
          name: "Extra Injera",
          quantity: 2,
          unitPrice: 20,
          lineSum: 40,
          inventoryItemId: INVENTORY_ID,
          stockQuantity: 1,
          stockUnit: "pcs",
        },
      ])
    );

    // 1 stock unit x quantity 2. This is what the reservation service consumes
    // to reserve stock, so the Extra can no longer be sold with an empty plan.
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INVENTORY_ID, quantity: 2, unit: "pcs" },
    ]);
    assert.deepEqual(plan.deductions, plan.ingredients);
    // The parent is still reported as unusable for recipe lookup.
    assert.ok(
      plan.warnings.some((w) => w.includes("missing menu item reference")),
      "the missing recipe identity must still be reported"
    );
  });

  test("multiple Extras on one free-text parent aggregate deterministically", async () => {
    const otherInventory = "507f1f77bcf86cd799439014";
    const plan = await prepareInventoryDeduction(
      legacyOrder([
        {
          kind: "PRICED_COMPONENT",
          extraItemId: EXTRA_ID,
          quantity: 2,
          inventoryItemId: INVENTORY_ID,
          stockQuantity: 1,
          stockUnit: "pcs",
        },
        {
          kind: "PRICED_COMPONENT",
          extraItemId: "507f1f77bcf86cd799439015",
          quantity: 3,
          inventoryItemId: INVENTORY_ID,
          stockQuantity: 1,
          stockUnit: "pcs",
        },
        {
          kind: "PRICED_COMPONENT",
          extraItemId: "507f1f77bcf86cd799439016",
          quantity: 1,
          inventoryItemId: otherInventory,
          stockQuantity: 1,
          stockUnit: "kg",
        },
      ])
    );
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INVENTORY_ID, quantity: 5, unit: "pcs" },
      { inventoryItemId: otherInventory, quantity: 1, unit: "kg" },
    ]);
  });

  test("NOTE-only free-text parent still deducts nothing", async () => {
    const plan = await prepareInventoryDeduction(
      legacyOrder([{ kind: "NOTE", note: "no onion" }])
    );
    assert.deepEqual(plan.ingredients, []);
    assert.ok(plan.warnings.includes("No valid order items for deduction"));
  });

  test("cancelled free-text parent never deducts its Extra", async () => {
    const plan = await prepareInventoryDeduction(
      legacyOrder(
        [
          {
            kind: "PRICED_COMPONENT",
            extraItemId: EXTRA_ID,
            quantity: 1,
            inventoryItemId: INVENTORY_ID,
            stockQuantity: 1,
            stockUnit: "pcs",
          },
        ],
        { cancelled: true }
      )
    );
    assert.deepEqual(plan.ingredients, []);
  });
});
