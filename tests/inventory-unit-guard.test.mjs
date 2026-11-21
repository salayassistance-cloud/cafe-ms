// Phase A — canonical unit guard and write-boundary enforcement (DB-free).
//
// The guard must reuse the existing engine/alias table and the adapter's
// ambiguous-unit rejection list. These tests exercise the production
// validators, not a copy of their logic.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const {
  classifyInventoryUnit,
  validateInventoryUnit,
  isValidInventoryUnit,
  INVALID_UNIT_CODE,
  INVENTORY_UNIT_OPTIONS,
  INVENTORY_UNIT_VALUES,
} = await import("../lib/inventoryUnitGuard.js");
const { UNIT_DEFINITIONS } = await import("../lib/inventoryUnits.js");
const { validateInventoryItemCreate, validateInventoryItemUpdate } =
  await import("../lib/inventoryValidation.js");
const { validateRecipeCreate, validateRecipeUpdate } =
  await import("../lib/recipeValidation.js");
const { mergeRequirements, convertRequirementToStockUnit } =
  await import("../lib/inventoryRequirementConversion.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const ITEM_ID = "507f1f77bcf86cd799439012";
const MENU_ID = "507f1f77bcf86cd799439011";

describe("Phase A — one authoritative unit classifier", () => {
  test("canonical units are valid and resolve to their canonical dimension", () => {
    const expected = {
      g: "g",
      kg: "g",
      ml: "ml",
      L: "ml",
      pcs: "pcs",
    };
    for (const [unit, canonical] of Object.entries(expected)) {
      const result = validateInventoryUnit(unit);
      assert.equal(result.ok, true, unit);
      assert.equal(result.canonicalUnit, canonical, unit);
      assert.equal(isValidInventoryUnit(unit), true, unit);
    }
  });

  test("approved engine aliases are accepted exactly as the engine defines them", () => {
    const cases = {
      grams: "g",
      kilogram: "g",
      kilograms: "g",
      kgs: "g",
      millilitre: "ml",
      milliliters: "ml",
      litres: "ml",
      liters: "ml",
      each: "pcs",
      pieces: "pcs",
      ea: "pcs",
    };
    for (const [alias, canonical] of Object.entries(cases)) {
      const classified = classifyInventoryUnit(alias);
      assert.equal(classified.status, "valid", alias);
      assert.equal(classified.canonicalUnit, canonical, alias);
      // The alias itself is preserved for persistence, never rewritten.
      assert.equal(validateInventoryUnit(alias).value, alias, alias);
    }
  });

  test("ambiguous container/portion nouns are rejected, never treated as pcs", () => {
    for (const unit of ["cup", "cups", "bottle", "bottles", "can", "cans", "pack", "slice", "shot", "pinch", "unit", "item"]) {
      const classified = classifyInventoryUnit(unit);
      assert.equal(classified.status, "ambiguous", unit);
      assert.equal(classified.code, "AMBIGUOUS_UNIT", unit);
      const result = validateInventoryUnit(unit);
      assert.equal(result.ok, false, unit);
      assert.equal(result.code, "AMBIGUOUS_UNIT", unit);
    }
  });

  test("unknown and missing units are rejected without coercion", () => {
    for (const unit of ["oz", "lb", "floz", "stone", "dozen"]) {
      const result = validateInventoryUnit(unit);
      assert.equal(result.ok, false, unit);
      assert.equal(result.code, "UNKNOWN_UNIT", unit);
    }
    for (const unit of [null, undefined, "", "   ", 5]) {
      assert.equal(isValidInventoryUnit(unit), false, String(unit));
    }
  });

  test("select options are derived from the engine, not a second vocabulary", () => {
    assert.deepEqual(
      INVENTORY_UNIT_VALUES,
      Object.keys(UNIT_DEFINITIONS)
    );
    for (const option of INVENTORY_UNIT_OPTIONS) {
      assert.equal(isValidInventoryUnit(option.value), true, option.value);
    }
    assert.equal(INVALID_UNIT_CODE, "INVALID_UNIT");
  });
});

describe("Phase A — every write boundary rejects invalid units", () => {
  test("inventory item create rejects ambiguous and unknown units with INVALID_UNIT", () => {
    for (const unit of ["cup", "bottle", "oz", ""]) {
      const res = validateInventoryItemCreate({
        name: "Coffee Beans",
        category: "Beverages",
        unit,
      });
      assert.ok(res.error, unit || "(empty)");
      assert.ok(
        [INVALID_UNIT_CODE, "MISSING_UNIT", "AMBIGUOUS_UNIT", "UNKNOWN_UNIT"].includes(res.code),
        `${unit}: ${res.code}`
      );
    }
    const ok = validateInventoryItemCreate({
      name: "Coffee Beans",
      category: "Beverages",
      unit: "kg",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.data.unit, "kg");
  });

  test("inventory item update rejects ambiguous and unknown units with INVALID_UNIT", () => {
    for (const unit of ["cup", "packet", "oz"]) {
      const res = validateInventoryItemUpdate({ unit });
      assert.equal(res.ok, undefined, unit);
      assert.ok([INVALID_UNIT_CODE, "AMBIGUOUS_UNIT", "UNKNOWN_UNIT"].includes(res.code), unit);
    }
    const ok = validateInventoryItemUpdate({ unit: "L" });
    assert.equal(ok.ok, true);
    assert.equal(ok.data.unit, "L");
  });

  test("recipe create/update reject ambiguous and unknown ingredient units", () => {
    const create = validateRecipeCreate({
      menuItemId: MENU_ID,
      ingredients: [{ inventoryItemId: ITEM_ID, quantity: 1, unit: "cup" }],
    });
    assert.equal(create.ok, undefined);
    assert.equal(create.code, "AMBIGUOUS_UNIT");

    const update = validateRecipeUpdate({
      ingredients: [{ inventoryItemId: ITEM_ID, quantity: 1, unit: "oz" }],
    });
    assert.equal(update.ok, undefined);
    assert.equal(update.code, "UNKNOWN_UNIT");

    const valid = validateRecipeCreate({
      menuItemId: MENU_ID,
      ingredients: [{ inventoryItemId: ITEM_ID, quantity: 0.5, unit: "kg" }],
    });
    assert.equal(valid.ok, true);
  });

  test("item and recipe routes surface the validator code", () => {
    assert.ok(src("app/api/inventory/items/route.js").includes("validated.code"));
    assert.ok(src("app/api/inventory/items/[id]/route.js").includes("validated.code"));
    assert.ok(src("app/api/recipes/route.js").includes("validated.code"));
    assert.ok(src("app/api/recipes/[id]/route.js").includes("validated.code"));
  });

  test("receive route and service validate the incoming and stored unit", () => {
    const route = src("app/api/inventory/receive/route.js");
    const service = src("lib/inventoryReceiveService.js");
    assert.ok(route.includes("validateInventoryUnit"));
    assert.ok(route.includes("unitCheck.code"));
    assert.ok(service.includes("validateInventoryUnit"));
    assert.ok(service.includes("Cannot receive for item with unsupported unit"));
    assert.ok(service.includes("itemUnitCheck.code"));
  });
});

describe("Phase A — requirement merge and fail-closed reservation", () => {
  const conversion = src("lib/inventoryRequirementConversion.js");
  const reservation = src("lib/inventoryReservationService.js");
  const model = src("lib/models/InventoryReservation.js");

  const row = (unit, quantity) => ({
    inventoryItemId: ITEM_ID,
    unit,
    requiredQuantity: quantity,
  });

  test("same-unit fast path rejects cup/cup and bottle/bottle", () => {
    for (const unit of ["cup", "bottle"]) {
      const out = mergeRequirements([row(unit, 1), row(unit, 2)]);
      assert.equal(out.items.length, 0, unit);
      assert.ok(out.warnings.length > 0, unit);
      for (const warning of out.warnings) {
        assert.match(warning, /AMBIGUOUS_UNIT/, unit);
      }
    }
  });

  test("valid kg→g and L→ml conversions still pass exactly", () => {
    const mass = convertRequirementToStockUnit(1.5, "kg", "g");
    assert.equal(mass.ok, true);
    assert.equal(mass.quantity, 1500);
    const volume = convertRequirementToStockUnit(1.25, "L", "ml");
    assert.equal(volume.ok, true);
    assert.equal(volume.quantity, 1250);

    const out = mergeRequirements([row("kg", 0.5), row("kg", 0.25)]);
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].requiredQuantity, 0.75);
    assert.equal(out.items[0].unit, "kg");
  });

  test("no cross-dimension conversion is introduced", () => {
    assert.equal(convertRequirementToStockUnit(1, "kg", "ml").ok, false);
    assert.equal(convertRequirementToStockUnit(1, "L", "g").ok, false);
  });

  test("ambiguous-unit rejection is in the conversion module itself", () => {
    assert.ok(conversion.includes("AMBIGUOUS_UNITS"));
    assert.ok(conversion.includes("AMBIGUOUS_UNIT"));
  });

  test("unresolved requirements reuse the blocking state and are persisted", () => {
    assert.ok(reservation.includes("unresolved"));
    assert.ok(reservation.includes('status = blocked ? "INSUFFICIENT_STOCK" : "NO_INVENTORY"'));
    assert.ok(reservation.includes("unresolved: blocked"));
    assert.ok(reservation.includes('code: "INVENTORY_UNRESOLVED"'));
    assert.ok(reservation.includes("validated.unresolved.length === 0"));
    assert.ok(model.includes("unresolved: { type: Boolean, default: false }"));
  });

  test("a legitimately untracked order is not marked unresolved", () => {
    // No requirements -> validateRequirements returns an empty unresolved list,
    // so createNoInventoryReservation writes the legitimate NO_INVENTORY state.
    assert.ok(reservation.includes("if (!requirements.length) return { items: [], inventory: new Map(), warnings, unresolved };"));
    assert.ok(reservation.includes("blocked: unresolved.length > 0"));
    assert.ok(reservation.includes('nextStatus = "NO_INVENTORY"'));
  });
});
