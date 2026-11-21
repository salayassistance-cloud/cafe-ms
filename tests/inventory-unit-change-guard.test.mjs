// D2 regression — DB-free.
//
// An Extra Item stores no unit; it deducts in the linked InventoryItem's live
// stock unit, and an order reservation freezes the unit it held. A unit change
// while stock is held (or while an Extra wraps the item) must be blocked with
// 409 UNIT_IN_USE, never converted or guessed.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const { evaluateInventoryUnitChange, unitTextChanged, UNIT_IN_USE_CODE } =
  await import("../lib/inventoryValidation.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// OBS-3: the transactional unit-change body moved out of the route into the
// production service so the replica-set harness exercises the same code path.
const routeSource = readFileSync(
  join(root, "lib/inventoryItemWriteService.js"),
  "utf8"
);

describe("D2: inventory unit-change guard", () => {
  test("unit is pinned while stock is reserved by an active order", () => {
    const decision = evaluateInventoryUnitChange({
      currentUnit: "kg",
      nextUnit: "g",
      reservedStock: 1.5,
      extraItemLinked: false,
    });
    assert.equal(decision.changed, true);
    assert.equal(decision.blocked, true);
    assert.equal(decision.code, UNIT_IN_USE_CODE);
    assert.equal(decision.reason, "RESERVED_STOCK");
  });

  test("unit is pinned while any Extra Item references the stock item", () => {
    const decision = evaluateInventoryUnitChange({
      currentUnit: "pcs",
      nextUnit: "kg",
      reservedStock: 0,
      extraItemLinked: true,
    });
    assert.equal(decision.changed, true);
    assert.equal(decision.blocked, true);
    assert.equal(decision.code, UNIT_IN_USE_CODE);
    assert.equal(decision.reason, "EXTRA_ITEM_LINKED");
  });

  test("unit is pinned while an active Recipe references the stock item", () => {
    const decision = evaluateInventoryUnitChange({
      currentUnit: "g",
      nextUnit: "kg",
      reservedStock: 0,
      extraItemLinked: false,
      recipeLinked: true,
    });
    assert.equal(decision.changed, true);
    assert.equal(decision.blocked, true);
    assert.equal(decision.code, UNIT_IN_USE_CODE);
    assert.equal(decision.reason, "RECIPE_LINKED");
  });

  test("the guard is skipped when a referenced recipe exists but the unit is unchanged", () => {
    const decision = evaluateInventoryUnitChange({
      currentUnit: "Bottle",
      nextUnit: "Bottle",
      reservedStock: 0,
      extraItemLinked: false,
      recipeLinked: true,
    });
    assert.equal(decision.changed, false);
    assert.equal(decision.blocked, false);
  });

  test("an unused, unreferenced item may still change unit", () => {
    const decision = evaluateInventoryUnitChange({
      currentUnit: "pcs",
      nextUnit: "kg",
      reservedStock: 0,
      extraItemLinked: false,
    });
    assert.equal(decision.changed, true);
    assert.equal(decision.blocked, false);
    assert.equal(decision.code, null);
  });

  test("an unchanged unit is never blocked, even while reserved or referenced", () => {
    for (const input of [
      { currentUnit: "pcs", nextUnit: "pcs", reservedStock: 4, extraItemLinked: true },
      { currentUnit: "kg", nextUnit: " kg ", reservedStock: 4, extraItemLinked: true },
      { currentUnit: "pcs", nextUnit: null, reservedStock: 4, extraItemLinked: true },
    ]) {
      const decision = evaluateInventoryUnitChange(input);
      assert.equal(decision.changed, false, JSON.stringify(input));
      assert.equal(decision.blocked, false, JSON.stringify(input));
    }
  });

  test("no alias or conversion is applied: kg -> g is a real change", () => {
    assert.equal(unitTextChanged("kg", "g"), true);
    assert.equal(unitTextChanged("L", "ml"), true);
    assert.equal(unitTextChanged("pcs", "PC"), true);
    assert.equal(unitTextChanged("kg", "kg"), false);
  });

  test("a legacy item with missing reservedStock still blocks on an Extra link", () => {
    const decision = evaluateInventoryUnitChange({
      currentUnit: "pcs",
      nextUnit: "kg",
      reservedStock: undefined,
      extraItemLinked: true,
    });
    assert.equal(decision.blocked, true);
    assert.equal(decision.reason, "EXTRA_ITEM_LINKED");
  });
});

describe("D2: service wiring", () => {
  test("the guard runs before the inventory write and blocks with 409 UNIT_IN_USE", () => {
    const guardIdx = routeSource.indexOf("const unitChange = evaluateInventoryUnitChange({");
    const updateIdx = routeSource.indexOf("const doc = await InventoryItem.findOneAndUpdate(");
    assert.ok(guardIdx > 0, "service must evaluate the unit-change guard");
    assert.ok(updateIdx > 0, "service must still perform the update");
    assert.ok(guardIdx < updateIdx, "the guard must run before any write");
    assert.ok(routeSource.includes("Unit change blocked"));
    assert.ok(routeSource.includes("409,"));
    assert.ok(routeSource.includes("unitChange.code"));
  });

  test("the blocked path aborts the transaction and writes nothing", () => {
    const guardBlock = routeSource.slice(
      routeSource.indexOf("const unitChange = evaluateInventoryUnitChange({"),
      routeSource.indexOf("const filter = unitChanged")
    );
    assert.ok(guardBlock.includes("unitChange.blocked"));
    // Typed business error -> the shared runner aborts (no transient label, so
    // it is never retried); nothing is written.
    assert.ok(guardBlock.includes("throw new InventoryItemWriteError("));
    assert.equal(guardBlock.includes("$set:"), false);
    assert.equal(guardBlock.includes("abortTransaction"), false);
  });

  test("the Extra reference is checked inside the same transaction", () => {
    assert.ok(routeSource.includes('getExtraItemModel(conn)'));
    assert.ok(routeSource.includes("extraItemLinked"));
    assert.ok(routeSource.includes("inventoryItemId: itemId"));
    assert.ok(routeSource.includes(".session(session)"));
  });

  test("an active Recipe reference is checked inside the same transaction", () => {
    const guardBlock = routeSource.slice(
      routeSource.indexOf("if (unitChanged) {"),
      routeSource.indexOf("const doc = await InventoryItem.findOneAndUpdate(")
    );
    assert.ok(guardBlock.includes("getRecipeModel(conn)"));
    assert.ok(guardBlock.includes('"ingredients.inventoryItemId": itemId'));
    assert.ok(guardBlock.includes("...RECIPE_ACTIVE_FILTER"));
    assert.ok(guardBlock.includes("recipeLinked"));
    assert.ok(guardBlock.includes(".session(session)"));
    assert.ok(guardBlock.includes("unitChange.code"));
  });

  test("a unit change increments the coordination token in the same write", () => {
    const writeBlock = routeSource.slice(
      routeSource.indexOf("const filter = unitChanged"),
      routeSource.indexOf("// H7.2 audit trail")
    );
    assert.ok(writeBlock.includes("$inc: { unitRevision: 1 }"));
    assert.ok(writeBlock.includes("{ _id: itemId, unit: beforeDoc.unit ?? null }"));
    assert.ok(writeBlock.includes("INVENTORY_ITEM_CHANGED"));
  });

  test("audit behavior is preserved and no unit conversion was introduced", () => {
    assert.ok(routeSource.includes("createInventoryAudit("));
    assert.ok(routeSource.includes("beforeSnapshot: snapshotOf(beforeDoc)"));
    assert.ok(routeSource.includes("afterSnapshot: snapshotOf(doc)"));
    assert.equal(routeSource.includes("convertRequirementToStockUnit"), false);
    assert.equal(routeSource.includes("inventoryUnitAdapter"), false);
  });
});
