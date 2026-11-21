// OBS-2 regression — DB-free.
//
// `executeInventoryDeduction` is the legacy direct-deduction executor. It has no
// application caller, but it is still referenced by the documented Phase G2
// seam, by the reservedStock ownership registry (scope "LEGACY_V1_DEDUCTION"),
// and by a Phase 2.3 regression test that pins the export as the documented
// unwired executor. It can therefore not be deleted from this file, so the
// behaviour is disabled instead: every invocation must fail closed before any
// connection, model, session, or write.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const deductionModule = await import("../lib/inventoryDeductionService.js");
const reservationModule = await import("../lib/inventoryReservationService.js");

const {
  executeInventoryDeduction,
  LegacyInventoryDeductionDisabledError,
  LEGACY_DEDUCTION_DISABLED_CODE,
  prepareInventoryDeduction,
  addRecipeLookupFailure,
  RECIPE_LOOKUP_FAILED_REASON,
  calculateDeductionFromRecipes,
} = deductionModule;

const ORDER_ID = "507f1f77bcf86cd799439011";
const ITEM_ID = "507f1f77bcf86cd799439012";

// A connection that records every property access. If the disabled executor
// touched it at all, `accesses` would be non-empty.
function makeFakeConnection() {
  const accesses = [];
  const conn = new Proxy(
    {
      startSession: async () => {
        throw new Error("startSession must never be reached");
      },
    },
    {
      get(target, prop) {
        accesses.push(String(prop));
        return Reflect.get(target, prop);
      },
      has() {
        accesses.push("<has>");
        return false;
      },
    }
  );
  return { conn, accesses };
}

function isDisabledError(err) {
  assert.equal(err?.name, "LegacyInventoryDeductionDisabledError");
  assert.equal(err?.code, LEGACY_DEDUCTION_DISABLED_CODE);
  assert.equal(err?.status, 409);
  assert.match(err.message, /disabled/i);
  assert.match(err.message, /consumeOrderInventory/);
  return true;
}

describe("OBS-2: legacy deduction executor is disabled", () => {
  test("the export shape is preserved", () => {
    assert.equal(typeof executeInventoryDeduction, "function");
    assert.equal(typeof LegacyInventoryDeductionDisabledError, "function");
    assert.equal(LEGACY_DEDUCTION_DISABLED_CODE, "LEGACY_DEDUCTION_DISABLED");
  });

  test("a valid-looking plan rejects with a stable explicit error", async () => {
    await assert.rejects(
      () =>
        executeInventoryDeduction({
          orderId: ORDER_ID,
          ingredients: [{ inventoryItemId: ITEM_ID, quantity: 2, unit: "kg" }],
          warnings: [],
          unresolved: [],
        }),
      isDisabledError
    );
  });

  test("it rejects before any connection, model, or session operation", async () => {
    const { conn, accesses } = makeFakeConnection();
    await assert.rejects(
      () =>
        executeInventoryDeduction(
          {
            orderId: ORDER_ID,
            ingredients: [{ inventoryItemId: ITEM_ID, quantity: 1, unit: "kg" }],
          },
          { connection: conn, actorId: "507f1f77bcf86cd799439013" }
        ),
      isDisabledError
    );
    assert.equal(
      accesses.length,
      0,
      "the supplied connection must never be read, so no model/session work can start"
    );
  });

  test("plans that previously short-circuited never report success", async () => {
    // Previously: empty ingredients returned { success: true }.
    await assert.rejects(
      () => executeInventoryDeduction({ orderId: ORDER_ID, ingredients: [] }),
      isDisabledError
    );
    // Previously: an invalid plan returned { success: false } without a write.
    await assert.rejects(() => executeInventoryDeduction(null), isDisabledError);
    // Previously: a missing orderId returned { success: false }.
    await assert.rejects(
      () => executeInventoryDeduction({ ingredients: [] }),
      isDisabledError
    );
  });

  test("no live direct-deduction write remains in the module", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../lib/inventoryDeductionService.js", import.meta.url)),
      "utf8"
    );
    assert.equal(
      source.includes("currentStock: -qty"),
      false,
      "the unconditional $inc currentStock write must be gone"
    );
    assert.equal(
      source.includes("bulkWrite("),
      false,
      "no partial-write path may remain in this module"
    );
  });
});

describe("OBS-2: canonical reservation path stays intact", () => {
  test("reservation consumption and reconciliation exports are available", () => {
    for (const name of [
      "consumeOrderInventory",
      "reconcileOrderInventory",
      "releaseOrderInventory",
      "assertOrderInventoryReady",
      "ensureOrderInventoryReservation",
    ]) {
      assert.equal(
        typeof reservationModule[name],
        "function",
        `${name} must remain exported`
      );
    }
    assert.deepEqual([...reservationModule.IMMUTABLE_RESERVATION_STATUSES], [
      "CONSUMING",
      "CONSUMED",
      "RELEASED",
    ]);
    assert.equal(reservationModule.canReconcileReservation("CONSUMING"), false);
  });

  test("requirement validation and planner exports are available", () => {
    assert.equal(typeof prepareInventoryDeduction, "function");
    assert.equal(typeof calculateDeductionFromRecipes, "function");
    assert.equal(typeof addRecipeLookupFailure, "function");
    assert.equal(
      RECIPE_LOOKUP_FAILED_REASON,
      "Recipe lookup failed - inventory requirement unresolved"
    );
    assert.equal(typeof reservationModule.validateRequirements, "function");
    assert.equal(typeof reservationModule.calculateRawRequirements, "function");
  });
});
