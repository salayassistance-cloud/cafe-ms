// Phase 2 — DB-free Manager classification / reclassification regressions.
// No MongoDB connection, no environment file, no network, no DB access.
// Model access is injected through fake `conn.models`; audit writes are
// captured in memory. The UI checks are source contracts plus the real pure
// classification helper (no React renderer needed).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { versionMatches } from "./helpers/policy-version-fakes.mjs";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const {
  classifyMenuItemInventoryPolicy,
  buildOpenOrderFilter,
  isMenuPolicyChangeError,
  MENU_POLICY_ERROR_CODES,
  OPEN_ORDER_STATUSES,
} = await import("../lib/menuInventoryPolicyService.js");
const { resolveSavedMenuItemPolicy } = await import("../lib/inventoryPolicy.js");

const ITEM_ID = "507f1f77bcf86cd799439011";
const OTHER_ITEM_ID = "507f1f77bcf86cd799439012";
const STAFF_ID = "507f1f77bcf86cd799439099";
const INV_ID = "507f1f77bcf86cd799439088";
const OTHER_INV_ID = "507f1f77bcf86cd799439089";

const oid = (id) => new mongoose.Types.ObjectId(String(id));

function menuDoc(policy) {
  return {
    _id: oid(ITEM_ID),
    targetStation: "KITCHEN",
    inventoryPolicy: policy,
    name: { en: "Test Item" },
  };
}

function validRecipe() {
  return {
    _id: oid("507f1f77bcf86cd799439077"),
    menuItemId: oid(ITEM_ID),
    isActive: true,
    ingredients: [
      { inventoryItemId: oid(INV_ID), quantity: 1, unit: "pcs" },
    ],
  };
}

function validInventory() {
  return [
    {
      _id: oid(INV_ID),
      name: "Flour",
      stockGroup: "KITCHEN",
      unit: "pcs",
    },
  ];
}

function chain(value, calls, name) {
  const read = () => (typeof value === "function" ? value() : value);
  const q = {
    session(s) {
      calls.sessions.push({ name, session: s });
      return q;
    },
    select(fields) {
      calls.selects.push({ name, fields });
      return q;
    },
    limit(n) {
      calls.limits.push({ name, n });
      return q;
    },
    lean: async () => read(),
  };
  return q;
}

function makeConn({
  item = menuDoc("TRACKED"),
  recipes = [validRecipe()],
  orders = [],
  inventory = validInventory(),
  menuItems = [],
  orderError = null,
  auditError = null,
  writeError = null,
  versionConflict = false,
} = {}) {
  const calls = {
    writes: [],
    audits: [],
    orderFilters: [],
    recipeFilters: [],
    inventoryFilters: [],
    sessions: [],
    selects: [],
    limits: [],
    commits: 0,
    aborts: 0,
  };

  const MenuItem = {
    findOne(filter) {
      const match = filter?._id && String(filter._id) !== String(item?._id) ? null : item;
      return chain(() => match, calls, "menu.findOne");
    },
    find(filter) {
      calls.menuFilters = calls.menuFilters || [];
      calls.menuFilters.push(filter);
      let rows = menuItems.filter((m) => String(m._id) !== String(item?._id));
      if (filter?._id?.$in) {
        const ids = filter._id.$in.map(String);
        rows = rows.filter((m) => ids.includes(String(m._id)));
      } else if (filter?._id?.$ne) {
        rows = rows.filter((m) => String(m._id) !== String(filter._id.$ne));
      }
      if (filter?.isDeleted?.$ne === true) {
        rows = rows.filter((m) => m.isDeleted !== true);
      }
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
      return chain(() => rows, calls, "menu.find");
    },
    findOneAndUpdate(filter, update, options) {
      calls.writes.push({ filter, update, options });
      if (writeError) return chain(() => { throw writeError; }, calls, "menu.write");
      const current = item?.inventoryPolicy ?? null;
      const blockedByGuard =
        filter?.inventoryPolicy && filter.inventoryPolicy.$ne === current;
      const versionOk = versionMatches(item?.policyVersion, filter?.policyVersion);
      if (versionConflict || blockedByGuard || !versionOk) {
        return chain(() => null, calls, "menu.write");
      }
      const doc = { ...item, ...(update?.$set || {}) };
      Object.assign(item, doc);
      return chain(() => doc, calls, "menu.write");
    },
  };

  const Order = {
    find(filter) {
      calls.orderFilters.push(filter);
      if (orderError) return chain(() => { throw orderError; }, calls, "order.find");
      const statuses = filter?.status?.$in || [];
      const legacyQuery = !!filter?.items?.$elemMatch?.$or;
      const wanted = String(filter?.items?.$elemMatch?.itemId);
      const rows = orders.filter((o) => {
        if (!statuses.includes(o.status)) return false;
        return (o.items || []).some((it) => {
          if (it.cancelled === true) return false;
          if (legacyQuery) {
            return it.itemId == null || !mongoose.isValidObjectId(String(it.itemId));
          }
          return String(it.itemId) === wanted;
        });
      });
      return chain(() => rows.slice(0, 1), calls, "order.find");
    },
  };

  const Recipe = {
    find(filter) {
      calls.recipeFilters.push(filter);
      const wanted = String(filter?.menuItemId);
      return chain(
        () => recipes.filter((r) => String(r.menuItemId) === wanted),
        calls,
        "recipe.find"
      );
    },
  };

  const InventoryItem = {
    find(filter) {
      calls.inventoryFilters.push(filter);
      const wanted = new Set((filter?._id?.$in || []).map(String));
      return chain(
        () => inventory.filter((d) => wanted.has(String(d._id))),
        calls,
        "inventory.find"
      );
    },
  };

  const InventoryAudit = {
    create: async (docOrDocs, options) => {
      if (auditError) throw auditError;
      const docs = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];
      for (const doc of docs) {
        calls.audits.push({ doc, options });
      }
      const created = docs.map((doc) => ({
        _id: oid("507f1f77bcf86cd799439066"),
        ...doc,
      }));
      return Array.isArray(docOrDocs) ? created : created[0];
    },
  };

  const conn = {
    models: { MenuItem, Order, Recipe, InventoryItem, InventoryAudit },
    startSession: async () => ({
      startTransaction() {},
      commitTransaction() {
        calls.commits += 1;
      },
      abortTransaction() {
        calls.aborts += 1;
      },
      endSession() {},
    }),
  };
  return { conn, calls };
}

const actor = { staffId: STAFF_ID, role: "MANAGER" };

async function expectCode(fn, code) {
  await assert.rejects(
    fn,
    (err) => isMenuPolicyChangeError(err) && err.code === code
  );
}

describe("Phase 2A — Manager classification service", () => {
  test("1. TRACKED -> UNTRACKED succeeds with no open orders", async () => {
    const { conn, calls } = makeConn({ item: menuDoc("TRACKED") });
    const res = await classifyMenuItemInventoryPolicy(conn, {
      menuItemId: ITEM_ID,
      requestedPolicy: "UNTRACKED",
      actor,
    });
    assert.equal(res.changed, true);
    assert.equal(res.inventoryPolicy, "UNTRACKED");
    assert.equal(res.previousResolved, "TRACKED");
    assert.equal(calls.writes.length, 1);
    assert.equal(calls.commits, 1);
  });

  test("2. UNTRACKED -> TRACKED succeeds with a valid active Recipe", async () => {
    const { conn, calls } = makeConn({ item: menuDoc("UNTRACKED") });
    const res = await classifyMenuItemInventoryPolicy(conn, {
      menuItemId: ITEM_ID,
      requestedPolicy: "TRACKED",
      actor,
    });
    assert.equal(res.changed, true);
    assert.equal(res.inventoryPolicy, "TRACKED");
    assert.equal(calls.recipeFilters.length, 1);
    assert.equal(calls.inventoryFilters.length, 1);
    assert.equal(calls.commits, 1);
  });

  test("3. UNKNOWN/null -> TRACKED succeeds with a valid active Recipe", async () => {
    const { conn } = makeConn({ item: menuDoc(null) });
    const res = await classifyMenuItemInventoryPolicy(conn, {
      menuItemId: ITEM_ID,
      requestedPolicy: "TRACKED",
      actor,
    });
    assert.equal(res.changed, true);
    assert.equal(res.previousRaw, null);
    assert.equal(res.previousResolved, "UNKNOWN");
    assert.equal(res.inventoryPolicy, "TRACKED");
  });

  test("4. UNKNOWN/null -> UNTRACKED succeeds without requiring a Recipe", async () => {
    const { conn, calls } = makeConn({ item: menuDoc(null), recipes: [] });
    const res = await classifyMenuItemInventoryPolicy(conn, {
      menuItemId: ITEM_ID,
      requestedPolicy: "UNTRACKED",
      actor,
    });
    assert.equal(res.changed, true);
    assert.equal(res.inventoryPolicy, "UNTRACKED");
    assert.deepEqual(calls.recipeFilters, []);
    assert.deepEqual(calls.inventoryFilters, []);
  });

  test("5. TRACKED classification fails when the Recipe is missing", async () => {
    const { conn, calls } = makeConn({ item: menuDoc("UNTRACKED"), recipes: [] });
    await expectCode(
      () =>
        classifyMenuItemInventoryPolicy(conn, {
          menuItemId: ITEM_ID,
          requestedPolicy: "TRACKED",
          actor,
        }),
      MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_MISSING
    );
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.audits.length, 0);
    assert.equal(calls.aborts, 1);
  });

  test("6. TRACKED classification fails when the Recipe is inactive", async () => {
    const recipe = validRecipe();
    recipe.isActive = false;
    const { conn } = makeConn({ item: menuDoc("UNTRACKED"), recipes: [recipe] });
    await expectCode(
      () =>
        classifyMenuItemInventoryPolicy(conn, {
          menuItemId: ITEM_ID,
          requestedPolicy: "TRACKED",
          actor,
        }),
      MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_INACTIVE
    );
  });

  test("7. TRACKED classification fails when the Recipe is invalid (inventory reference)", async () => {
    const { conn } = makeConn({ item: menuDoc("UNTRACKED"), inventory: [] });
    await expectCode(
      () =>
        classifyMenuItemInventoryPolicy(conn, {
          menuItemId: ITEM_ID,
          requestedPolicy: "TRACKED",
          actor,
        }),
      MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_INVALID
    );
  });

  test("8. reclassification is blocked when an affected open order exists", async () => {
    const { conn, calls } = makeConn({
      item: menuDoc("TRACKED"),
      orders: [{ status: "PREPARING", items: [{ itemId: oid(ITEM_ID) }] }],
    });
    await expectCode(
      () =>
        classifyMenuItemInventoryPolicy(conn, {
          menuItemId: ITEM_ID,
          requestedPolicy: "UNTRACKED",
          actor,
        }),
      MENU_POLICY_ERROR_CODES.OPEN_ORDERS
    );
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.audits.length, 0);
    assert.equal(calls.aborts, 1);
    const filter = calls.orderFilters[0];
    assert.deepEqual(
      [...filter.status.$in].sort(),
      [...OPEN_ORDER_STATUSES].sort()
    );
    assert.equal(String(filter.items.$elemMatch.itemId), ITEM_ID);
    assert.deepEqual(filter.items.$elemMatch.cancelled, { $ne: true });
  });

  test("9. reclassification is blocked when the open-order check is untrusted", async () => {
    const { conn, calls } = makeConn({
      item: menuDoc("TRACKED"),
      orderError: new Error("read failed"),
    });
    await expectCode(
      () =>
        classifyMenuItemInventoryPolicy(conn, {
          menuItemId: ITEM_ID,
          requestedPolicy: "UNTRACKED",
          actor,
        }),
      MENU_POLICY_ERROR_CODES.OPEN_ORDER_CHECK_UNAVAILABLE
    );
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.audits.length, 0);
    assert.equal(calls.commits, 0);
  });

  test("10. terminal orders do not block classification", async () => {
    const { conn } = makeConn({
      item: menuDoc("TRACKED"),
      orders: [
        { status: "PAID", items: [{ itemId: oid(ITEM_ID) }] },
        { status: "CANCELLED", items: [{ itemId: oid(ITEM_ID) }] },
        { status: "ARCHIVED", items: [{ itemId: oid(ITEM_ID) }] },
      ],
    });
    const res = await classifyMenuItemInventoryPolicy(conn, {
      menuItemId: ITEM_ID,
      requestedPolicy: "UNTRACKED",
      actor,
    });
    assert.equal(res.changed, true);
    assert.equal(OPEN_ORDER_STATUSES.includes("PAID"), false);
    assert.equal(OPEN_ORDER_STATUSES.includes("CANCELLED"), false);
    assert.equal(OPEN_ORDER_STATUSES.includes("ARCHIVED"), false);
  });

  test("11. an unrelated open order or unrelated line does not block", async () => {
    const { conn } = makeConn({
      item: menuDoc("TRACKED"),
      orders: [
        {
          status: "PENDING",
          items: [
            { itemId: oid(OTHER_ITEM_ID) },
            { itemId: oid(ITEM_ID), cancelled: true },
          ],
        },
      ],
    });
    const res = await classifyMenuItemInventoryPolicy(conn, {
      menuItemId: ITEM_ID,
      requestedPolicy: "UNTRACKED",
      actor,
    });
    assert.equal(res.changed, true);
  });

  test("12. a durable audit event records the full supported context", async () => {
    const { conn, calls } = makeConn({ item: menuDoc(null) });
    await classifyMenuItemInventoryPolicy(conn, {
      menuItemId: ITEM_ID,
      requestedPolicy: "UNTRACKED",
      actor,
    });
    assert.equal(calls.audits.length, 1);
    const { doc, options } = calls.audits[0];
    assert.ok(options.session, "audit shares the transaction session");
    assert.equal(String(doc.item), ITEM_ID);
    assert.equal(doc.action, "ITEM_UPDATED");
    assert.equal(String(doc.actorId), STAFF_ID);
    assert.equal(doc.actorRole, "MANAGER");
    assert.ok(doc.reason.includes("UNKNOWN -> UNTRACKED"));
    assert.equal(doc.beforeSnapshot.resolvedPolicy, "UNKNOWN");
    assert.equal(doc.beforeSnapshot.inventoryPolicy, null);
    assert.equal(doc.afterSnapshot.resolvedPolicy, "UNTRACKED");
    assert.equal(doc.afterSnapshot.inventoryPolicy, "UNTRACKED");
  });

  test("13. audit failure aborts the change instead of silently succeeding", async () => {
    const { conn, calls } = makeConn({
      item: menuDoc("TRACKED"),
      auditError: new Error("audit down"),
    });
    await expectCode(
      () =>
        classifyMenuItemInventoryPolicy(conn, {
          menuItemId: ITEM_ID,
          requestedPolicy: "UNTRACKED",
          actor,
        }),
      MENU_POLICY_ERROR_CODES.AUDIT_WRITE_FAILED
    );
    assert.equal(calls.aborts, 1);
    assert.equal(calls.commits, 0);
  });

  test("14. client-supplied identity cannot replace the authenticated identity", async () => {
    const { conn, calls } = makeConn({ item: menuDoc("TRACKED") });
    await classifyMenuItemInventoryPolicy(conn, {
      menuItemId: ITEM_ID,
      requestedPolicy: "UNTRACKED",
      actor,
      // Untrusted extra fields: the service must ignore them entirely.
      staffId: "507f1f77bcf86cd799439000",
      role: "WAITER",
    });
    assert.equal(String(calls.audits[0].doc.actorId), STAFF_ID);
    assert.equal(calls.audits[0].doc.actorRole, "MANAGER");

    await expectCode(
      () =>
        classifyMenuItemInventoryPolicy(conn, {
          menuItemId: ITEM_ID,
          requestedPolicy: "UNTRACKED",
          actor: { staffId: STAFF_ID, role: "WAITER" },
        }),
      MENU_POLICY_ERROR_CODES.UNAUTHORIZED
    );

    const actions = src("app/manager/menu-crud/actions.js");
    assert.ok(actions.includes("staffId: payload.staffId"));
    assert.ok(actions.includes("role: payload.role"));
    assert.equal(/formData\.(get|has)\(["'](staffId|role|actorId)/.test(actions), false);
  });

  test("15. a no-op on an identical saved policy creates no write or event", async () => {
    const { conn, calls } = makeConn({ item: menuDoc("TRACKED") });
    const res = await classifyMenuItemInventoryPolicy(conn, {
      menuItemId: ITEM_ID,
      requestedPolicy: "TRACKED",
      actor,
    });
    assert.equal(res.changed, false);
    assert.deepEqual(calls.writes, []);
    assert.deepEqual(calls.audits, []);
    assert.deepEqual(calls.orderFilters, []);
    assert.equal(calls.commits, 1);
  });

  test("16. ordinary MenuItem edits still cannot alter inventory policy", () => {
    const actions = src("app/manager/menu-crud/actions.js");
    assert.ok(actions.includes("export async function setMenuItemInventoryPolicy"));
    assert.ok(
      actions.includes(
        "Inventory tracking can only be changed through the inventory review workflow."
      )
    );
    const updateBody = actions.slice(
      actions.indexOf("export async function updateMenuItem"),
      actions.indexOf("export async function setMenuItemInventoryPolicy")
    );
    assert.ok(updateBody.includes("$set: update"));
    assert.equal(updateBody.includes("update.inventoryPolicy"), false);
  });

  test("17. reclassification never rewrites order-line policy snapshots", async () => {
    const { conn, calls } = makeConn({ item: menuDoc("TRACKED") });
    await classifyMenuItemInventoryPolicy(conn, {
      menuItemId: ITEM_ID,
      requestedPolicy: "UNTRACKED",
      actor,
    });
    const set = calls.writes[0].update.$set;
    assert.deepEqual(Object.keys(set).sort(), [
      "inventoryPolicy",
      "policyVersion",
      "updatedAt",
    ]);
    assert.equal("inventoryPolicySnapshot" in set, false);
    const service = src("lib/menuInventoryPolicyService.js");
    assert.equal(service.includes("inventoryPolicySnapshot"), false);
  });

  test("18. reclassification never changes captured Recipes", async () => {
    const { conn, calls } = makeConn({ item: menuDoc("UNTRACKED") });
    await classifyMenuItemInventoryPolicy(conn, {
      menuItemId: ITEM_ID,
      requestedPolicy: "TRACKED",
      actor,
    });
    assert.equal("inventoryRecipeSnapshot" in calls.writes[0].update.$set, false);
    assert.equal(calls.recipeFilters.length, 1, "Recipe is only read for validation");
    assert.equal(calls.audits[0].doc.action, "ITEM_UPDATED");
    const service = src("lib/menuInventoryPolicyService.js");
    assert.equal(service.includes("inventoryRecipeSnapshot"), false);
  });

  test("19. legacy UNKNOWN is never silently auto-classified", async () => {
    const { conn, calls } = makeConn({ item: menuDoc(null), recipes: [] });
    await expectCode(
      () =>
        classifyMenuItemInventoryPolicy(conn, {
          menuItemId: ITEM_ID,
          requestedPolicy: "",
          actor,
        }),
      MENU_POLICY_ERROR_CODES.INVALID_INVENTORY_POLICY
    );
    assert.deepEqual(calls.writes, []);
    assert.equal(
      src("lib/menuInventoryPolicyService.js").includes(
        "validateExplicitInventoryPolicy(requestedPolicy)"
      ),
      true
    );
    const filter = buildOpenOrderFilter(ITEM_ID);
    assert.ok(Array.isArray(filter.status.$in));
  });
});

describe("Phase 2C — InventoryUI canonical classification", () => {
  test("saved policy wins over Recipe presence, and UNKNOWN stays explicit", () => {
    const policies = {
      [ITEM_ID]: "UNTRACKED",
      [OTHER_ITEM_ID]: "TRACKED",
    };
    assert.equal(resolveSavedMenuItemPolicy(policies, ITEM_ID), "UNTRACKED");
    assert.equal(resolveSavedMenuItemPolicy(policies, OTHER_ITEM_ID), "TRACKED");
    assert.equal(resolveSavedMenuItemPolicy(policies, "missing"), "UNKNOWN");
    assert.equal(resolveSavedMenuItemPolicy({}, ITEM_ID), "UNKNOWN");

    // A Recipe row for the UNTRACKED item must not change its classification.
    const recipes = [
      { menuItemId: oid(ITEM_ID), isActive: true, ingredients: [{ quantity: 1 }] },
    ];
    const recipeByMenuId = new Map(
      recipes.map((r) => [String(r.menuItemId), r])
    );
    assert.ok(recipeByMenuId.has(ITEM_ID));
    assert.equal(resolveSavedMenuItemPolicy(policies, ITEM_ID), "UNTRACKED");
  });

  test("TRACKED with an unusable Recipe is still TRACKED and flagged separately", () => {
    const policies = { [ITEM_ID]: "TRACKED" };
    const badRecipe = { isActive: false, ingredients: [] };
    assert.equal(resolveSavedMenuItemPolicy(policies, ITEM_ID), "TRACKED");
    assert.equal(
      !badRecipe || badRecipe.isActive === false || !(badRecipe.ingredients || []).length,
      true
    );
  });

  test("UI source uses canonical policy, not a Recipe-derived partition", () => {
    const ui = src("app/components/InventoryUI.jsx");
    assert.ok(ui.includes("resolveSavedMenuItemPolicy(menuPolicies"));
    assert.ok(ui.includes("setRecipeClassificationFilter('UNKNOWN')"));
    assert.ok(ui.includes("hasRecipeIssue("));
    assert.equal(ui.includes("trackedMenuItemIds"), false);

    const page = src("app/manager/inventory/page.js");
    assert.ok(page.includes("getUnifiedMenu({ includeUnavailable: true })"));
    assert.ok(page.includes("<InventoryUI menuPolicies={menuPolicies} />"));

    // Public menu route must keep stripping internal policy metadata.
    const publicRoute = src("app/api/menu/route.js");
    assert.ok(publicRoute.includes("includeInventoryPolicy: false"));

    const translations = src("lib/translations.js");
    for (const key of [
      "invUnknown",
      "invRecipeIssue",
      "inventoryPolicySaveClassification",
      "inventoryPolicyChangeHint",
    ]) {
      assert.ok(translations.includes(`${key}:`), `missing translation key ${key}`);
    }
  });
});
