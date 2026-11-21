// Recipe `isActive` strict-boolean validation — DB-free.
//
// The update validator used to run `Boolean(body.isActive)`, and
// `Boolean("false") === true`. A non-UI client could therefore activate a
// Recipe by sending the string "false". These tests exercise the production
// validator directly and assert that only real booleans are accepted.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const { validateRecipeUpdate } = await import("../lib/recipeValidation.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const MENU_ID = "507f1f77bcf86cd799439012";
const ITEM_ID = "507f1f77bcf86cd799439013";

const ingredients = () => [{ inventoryItemId: ITEM_ID, quantity: 1, unit: "g" }];

describe("Recipe isActive — accepted values", () => {
  test("boolean true is accepted unchanged", () => {
    const res = validateRecipeUpdate({ isActive: true });
    assert.equal(res.ok, true);
    assert.equal(res.data.isActive, true);
  });

  test("boolean false is accepted unchanged", () => {
    const res = validateRecipeUpdate({ isActive: false });
    assert.equal(res.ok, true);
    assert.equal(res.data.isActive, false);
  });

  test("boolean isActive works alongside other fields", () => {
    const res = validateRecipeUpdate({
      ingredients: ingredients(),
      isActive: false,
    });
    assert.equal(res.ok, true);
    assert.equal(res.data.isActive, false);
    assert.equal(res.data.ingredients.length, 1);
  });

  test("omitted isActive keeps the omission behavior", () => {
    const res = validateRecipeUpdate({ menuItemId: MENU_ID });
    assert.equal(res.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(res.data, "isActive"), false);
  });

  test("omitted isActive alone still reports no update fields", () => {
    const res = validateRecipeUpdate({});
    assert.equal(res.ok, undefined);
    assert.ok(res.error.includes("No update fields provided"));
  });

  test("null isActive keeps the omission behavior", () => {
    const res = validateRecipeUpdate({ menuItemId: MENU_ID, isActive: null });
    assert.equal(res.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(res.data, "isActive"), false);
  });

  test("null isActive alone still reports no update fields", () => {
    const res = validateRecipeUpdate({ isActive: null });
    assert.equal(res.ok, undefined);
    assert.ok(res.error.includes("No update fields provided"));
  });
});

describe("Recipe isActive — rejected values", () => {
  test('string "false" is rejected instead of activating the recipe', () => {
    const res = validateRecipeUpdate({ isActive: "false" });
    assert.equal(res.ok, undefined);
    assert.equal(res.code, "INVALID_IS_ACTIVE");
    assert.ok(res.error.includes("isActive must be a boolean"));
    // The exact defect: coercion turned this into `true`.
    assert.equal(res.data, undefined);
  });

  test('string "true" is rejected instead of being trusted', () => {
    const res = validateRecipeUpdate({ isActive: "true" });
    assert.equal(res.ok, undefined);
    assert.equal(res.code, "INVALID_IS_ACTIVE");
  });

  test("numeric values are rejected", () => {
    for (const value of [1, 0, -1, 0.5, Number.NaN]) {
      const res = validateRecipeUpdate({ isActive: value });
      assert.equal(res.ok, undefined, `isActive ${String(value)} must be rejected`);
      assert.equal(res.code, "INVALID_IS_ACTIVE");
    }
  });

  test("object and array values are rejected", () => {
    for (const value of [{}, { value: false }, [], [false], [true]]) {
      const res = validateRecipeUpdate({ isActive: value });
      assert.equal(res.ok, undefined, `isActive ${JSON.stringify(value)} must be rejected`);
      assert.equal(res.code, "INVALID_IS_ACTIVE");
    }
  });

  test("a rejected isActive does not smuggle other fields through", () => {
    const res = validateRecipeUpdate({
      menuItemId: MENU_ID,
      ingredients: ingredients(),
      isActive: "false",
    });
    assert.equal(res.ok, undefined);
    assert.equal(res.code, "INVALID_IS_ACTIVE");
    assert.equal(res.data, undefined);
  });

  test("invalid isActive cannot reach the M-1 activation path as true", () => {
    // Mirrors the route guard: `if (!validated.ok) return 400` runs first, and
    // `activating` is only computed from validated data.
    const validated = validateRecipeUpdate({ isActive: "false" });
    assert.equal(!validated.ok, true, "route would reject with 400");
    const activating = validated.data?.isActive === true;
    assert.equal(activating, false);

    // The validator call must precede the delegation to the transactional
    // service, and the service may only compute `activating` from the already
    // validated payload (OBS-3 extraction).
    const route = src("app/api/recipes/[id]/route.js");
    const service = src("lib/recipeWriteService.js");
    const guardAt = route.indexOf("validateRecipeUpdate(body)");
    const delegateAt = route.indexOf("await updateRecipe(conn, sid, validated.data)");
    assert.ok(guardAt > -1, "route must call the update validator");
    assert.ok(delegateAt > guardAt, "validation must run before the recipe write");
    assert.ok(route.includes("if (!validated.ok) return fail(validated.error, 400, validated.code)"));
    assert.ok(service.includes("const activating = data.isActive === true"));
  });
});
