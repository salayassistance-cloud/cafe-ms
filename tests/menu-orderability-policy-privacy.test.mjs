// Phase 1.4 — D9/D10 waiter orderability, D12 public menu privacy, D16 soft-delete.
//
// DB-FREE ONLY. No MongoDB connection, no environment file, no network. The
// serialization and predicate tests run against the real modules with plain
// objects; the UI/route/D16 checks are source contracts plus one filesystem-only
// script execution (scripts/test-menu-unification.mjs never opens a database).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import mongoose from "mongoose";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const { serializeMenuItem } = await import("../lib/menuService.js");
const {
  isMenuItemAvailable,
  isMenuItemOrderable,
  isMenuItemBlockedForReview,
} = await import("../lib/menuOrderability.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function menuDoc(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    name: { en: "Dish", am: "ምግብ", om: "Nyaata" },
    description: { en: "Description" },
    price: 25,
    category: new mongoose.Types.ObjectId(),
    categoryType: "FOOD",
    targetStation: "KITCHEN",
    isAvailable: true,
    inStock: true,
    inventoryPolicy: "TRACKED",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// D9/D10: the shared presentation predicate
// ---------------------------------------------------------------------------

describe("D9/D10: menu orderability predicate", () => {
  test("valid TRACKED and UNTRACKED items stay orderable", () => {
    assert.equal(isMenuItemOrderable({ isAvailable: true, inventoryPolicy: "TRACKED" }), true);
    assert.equal(isMenuItemOrderable({ isAvailable: true, inventoryPolicy: "UNTRACKED" }), true);
  });

  test("a missing optional flag never hides an otherwise valid item", () => {
    // Cached/older payloads have no `orderable`; absence must mean orderable.
    assert.equal(isMenuItemOrderable({ isAvailable: true }), true);
    assert.equal(isMenuItemOrderable({ isAvailable: true, inStock: true }), true);
    assert.equal(isMenuItemOrderable({ isAvailable: true, orderable: undefined }), true);
  });

  test("a policy-blocked item is never orderable", () => {
    assert.equal(isMenuItemOrderable({ isAvailable: true, orderable: false }), false);
    assert.equal(isMenuItemBlockedForReview({ isAvailable: true, orderable: false }), true);
  });

  test("ordinary availability rules still win and are not mislabelled as review", () => {
    const outOfStock = { isAvailable: false, orderable: false };
    assert.equal(isMenuItemAvailable(outOfStock), false);
    assert.equal(isMenuItemOrderable(outOfStock), false);
    assert.equal(
      isMenuItemBlockedForReview(outOfStock),
      false,
      "out-of-stock shows the existing Out of Stock label, not a review reason"
    );
    assert.equal(isMenuItemOrderable({ isAvailable: true, inStock: false }), false);
  });

  test("non-object input is never orderable", () => {
    for (const value of [null, undefined, "dish", 7]) {
      assert.equal(isMenuItemOrderable(value), false);
      assert.equal(isMenuItemBlockedForReview(value), false);
    }
  });
});

// ---------------------------------------------------------------------------
// D12: public payload privacy, Manager path preserved
// ---------------------------------------------------------------------------

describe("D12: internal policy metadata is not public", () => {
  test("the protected Manager serialization keeps policy metadata", () => {
    const out = serializeMenuItem(menuDoc({ inventoryPolicy: "TRACKED" }), new Map());
    assert.equal(out.inventoryPolicy, "TRACKED");
    assert.equal(out.inventoryPolicyResolved, true);
  });

  test("the public serialization omits inventoryPolicy and inventoryPolicyResolved", () => {
    const out = serializeMenuItem(menuDoc(), new Map(), { includeInventoryPolicy: false });
    assert.equal("inventoryPolicy" in out, false);
    assert.equal("inventoryPolicyResolved" in out, false);
  });

  test("public serialization preserves every unrelated field and the neutral flag", () => {
    const doc = menuDoc();
    const out = serializeMenuItem(doc, new Map(), { includeInventoryPolicy: false });
    assert.equal(out._id, String(doc._id));
    assert.equal(out.id, String(doc._id));
    assert.equal(out.price, 25);
    assert.equal(out.isAvailable, true);
    assert.equal(out.categoryType, "FOOD");
    assert.equal(out.station, "KITCHEN");
    assert.deepEqual(out.name, { en: "Dish", am: "ምግብ", om: "Nyaata" });
    assert.equal(typeof out.orderable, "boolean");
  });

  test("the neutral orderable flag reflects policy without naming it", () => {
    const tracked = serializeMenuItem(menuDoc({ inventoryPolicy: "TRACKED" }), new Map());
    const untracked = serializeMenuItem(menuDoc({ inventoryPolicy: "UNTRACKED" }), new Map());
    const unknown = serializeMenuItem(menuDoc({ inventoryPolicy: undefined }), new Map());
    const external = serializeMenuItem(menuDoc({ inventoryPolicy: "EXTERNAL" }), new Map());
    const unavailable = serializeMenuItem(menuDoc({ isAvailable: false }), new Map());

    assert.equal(tracked.orderable, true);
    assert.equal(untracked.orderable, true);
    assert.equal(unknown.orderable, false, "UNKNOWN is not orderable");
    assert.equal(external.orderable, false, "historical EXTERNAL is not orderable");
    assert.equal(unavailable.orderable, false);

    // The flag is a boolean only — no policy enum travels with it.
    assert.equal(typeof unknown.orderable, "boolean");
    assert.equal("inventoryPolicy" in unknown, true, "manager serialization still has it");
  });

  test("the public menu route strips policy metadata", () => {
    const route = src("app/api/menu/route.js");
    assert.ok(route.includes("includeInventoryPolicy: false"));
    assert.ok(route.includes("getUnifiedMenu({ includeUnavailable, includeInventoryPolicy: false })"));
  });

  test("the Manager page keeps the protected policy-bearing path", () => {
    const page = src("app/manager/menu-crud/page.js");
    assert.ok(page.includes('getUnifiedMenu({ includeUnavailable: true })'));
    assert.equal(page.includes("includeInventoryPolicy: false"), false);
    const client = src("app/manager/menu-crud/MenuCrudClient.jsx");
    assert.ok(client.includes("inventoryPolicyResolved"));
    assert.ok(client.includes("inventoryPolicy"));
  });

  test("Waiter and public menu never read the internal policy field", () => {
    for (const path of ["app/components/WaiterUI.js", "app/menu/page.js"]) {
      const code = src(path);
      assert.equal(code.includes("inventoryPolicy"), false, `${path} must not depend on policy metadata`);
      assert.equal(code.includes("inventoryPolicyResolved"), false, `${path} must not depend on policy metadata`);
    }
  });
});

// ---------------------------------------------------------------------------
// D9/D10: Waiter wiring
// ---------------------------------------------------------------------------

describe("D9/D10: Waiter UI filters before selection", () => {
  const waiter = src("app/components/WaiterUI.js");

  test("uses the shared predicate for cart pruning, add, render and the edit picker", () => {
    assert.ok(waiter.includes("from '@/lib/menuOrderability'"));
    assert.ok(waiter.includes("!isMenuItemOrderable(match)"), "cart prune");
    assert.ok(waiter.includes("if (!isMenuItemOrderable(item)) return;"), "add-to-cart guard");
    assert.ok(waiter.includes("const available = isMenuItemOrderable(item);"), "card render");
    assert.ok(waiter.includes(".filter((m) => isMenuItemOrderable(m))"), "edit add-item picker");
    assert.equal(waiter.includes("const orderable = (it) =>"), false, "no duplicated predicate");
  });

  test("shows a neutral, actionable reason without internal identifiers", () => {
    assert.ok(waiter.includes("reviewRequired:"));
    assert.ok(waiter.includes("Not available — ask manager"));
    assert.ok(waiter.includes("አይገኝም — አስተዳዳሪውን ይጠይቁ"));
    assert.ok(waiter.includes("Hin argamu — bulchaa gaafadhu"));
    const label = waiter.slice(waiter.indexOf("reviewRequired:"), waiter.indexOf("reviewRequired:") + 320);
    assert.equal(/TRACKED|UNTRACKED|UNKNOWN|EXTERNAL|inventoryPolicy|Recipe/i.test(label), false);
    assert.ok(waiter.includes("reviewRequired ? t('reviewRequired') : t('outStock')"));
  });

  test("the public menu page applies the same gate", () => {
    const menu = src("app/menu/page.js");
    assert.ok(menu.includes("from '@/lib/menuOrderability'"));
    assert.ok(menu.includes("if (!isMenuItemOrderable(item)) return;"));
    assert.ok(menu.includes("const available = isMenuItemOrderable(item);"));
    assert.ok(menu.includes("reviewRequired ? tx('reviewRequired') : tx('outStock')"));
  });

  test("server-side validation is untouched (UI is not the boundary)", () => {
    const orders = src("lib/orderService.js");
    assert.ok(orders.includes("validateOrderLineInventoryPolicy({"));
    assert.ok(src("lib/inventoryPolicy.js").includes('code: "ITEM_NOT_ORDERABLE"'));
  });

  test("the EXTRA workflow keeps its own inventory-catalog source", () => {
    assert.ok(waiter.includes("/api/extra-items/catalog"));
    assert.ok(waiter.includes("openExtraPicker(cartKey)"));
    assert.equal(waiter.includes("isExtraItem: true"), false);
  });
});

// ---------------------------------------------------------------------------
// D16: stale hard-delete assertions replaced with archive behavior
// ---------------------------------------------------------------------------

describe("D16: menu deletion test alignment", () => {
  test("the DB-free menu unification script passes end to end", () => {
    const out = execFileSync(
      process.execPath,
      [join(root, "scripts", "test-menu-unification.mjs")],
      { cwd: root, encoding: "utf8" }
    );
    assert.match(out, /SUMMARY pass \d+ fail 0/);
    assert.ok(out.includes("All menu unification DB-free checks passed."));
  });

  test("the script no longer expects hard deletion", () => {
    const script = src("scripts/test-menu-unification.mjs");
    assert.equal(script.includes('"deleteCategory cascade deletes items then category"'), false);
    assert.equal(script.includes('"deleteCategory confirms count and handles N items"'), false);
    assert.ok(script.includes("never hard-deletes MenuItem records"));
    assert.ok(script.includes("menu item(s) archived"));
    assert.ok(script.includes("were archived before failure"));
  });

  test("the soft-delete implementation keeps records and hides them from active reads", () => {
    const actions = src("app/manager/menu-crud/actions.js");
    assert.equal(actions.includes("MenuItem.deleteMany("), false);
    assert.equal(actions.includes("MenuItem.deleteOne("), false);
    assert.ok(actions.includes("isDeleted: true"));
    assert.ok(actions.includes("deletedAt: new Date()"));
    assert.ok(actions.includes("recipe and order history preserved"));
    assert.ok(src("lib/menuService.js").includes("MenuItem.find({ isDeleted: { $ne: true } })"));
  });
});
