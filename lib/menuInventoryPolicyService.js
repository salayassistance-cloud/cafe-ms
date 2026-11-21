// Manager-controlled MenuItem inventory classification.
//
// This is the ONLY supported write path for an existing MenuItem's
// `inventoryPolicy`. The ordinary MenuItem edit action deliberately refuses to
// change it, and new MenuItems still require an explicit policy at creation.
//
// All decisions and identity checks are server-side: the caller supplies only
// the target MenuItem id, the requested TRACKED/UNTRACKED value and an actor
// resolved from the authenticated Manager session. Nothing from the client is
// used to decide classification, actor identity or audit attribution.
//
// The open-order guard, the guarded policy write and the durable audit event
// share one transaction. Phase 2.1 closes the create-order race with a shared
// conditional `policyVersion` write on this MenuItem: order create/add-line
// flows write the same document in their own transaction, so a concurrent order
// invalidates the version observed here and forces a full re-check.

import mongoose from "mongoose";

import { OPEN_ORDER_STATUSES } from "@/lib/constants";
import {
  INVENTORY_POLICY,
  INVENTORY_POLICY_HISTORICAL_EXTERNAL,
  isTrackedRecipeUsable,
  resolveInventoryPolicy,
  validateExplicitInventoryPolicy,
} from "@/lib/inventoryPolicy";
import {
  validateRecipeIngredientUnits,
  validateRecipeStockArea,
} from "@/lib/recipeStockArea";
import { createInventoryAudit } from "@/lib/inventoryAuditService";
import {
  attachSession,
  bumpMenuItemPolicyVersions,
  normalizePolicyVersion,
  runPolicyVersionedTransaction,
} from "@/lib/inventoryPolicyVersionService";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { getMenuItemModel } from "@/lib/models/MenuItem";
import { getOrderModel } from "@/lib/models/Order";
import { getRecipeModel } from "@/lib/models/Recipe";

// OPEN_ORDER_STATUSES is the canonical lifecycle helper in lib/constants.js.
// Re-exported here for existing callers/tests; the definition is not duplicated.
export { OPEN_ORDER_STATUSES } from "@/lib/constants";

export const MENU_POLICY_AUDIT_REASON = "MENU_ITEM_INVENTORY_POLICY_CHANGE";

export const MENU_POLICY_ERROR_CODES = Object.freeze({
  INVALID_MENU_ITEM_ID: "INVALID_MENU_ITEM_ID",
  INVALID_INVENTORY_POLICY: "INVALID_INVENTORY_POLICY",
  MENU_ITEM_NOT_FOUND: "MENU_ITEM_NOT_FOUND",
  HISTORICAL_POLICY_READ_ONLY: "HISTORICAL_POLICY_READ_ONLY",
  OPEN_ORDERS: "MENU_POLICY_OPEN_ORDERS",
  LEGACY_LINE_IDENTITY_UNRESOLVED: "LEGACY_LINE_IDENTITY_UNRESOLVED",
  OPEN_ORDER_CHECK_UNAVAILABLE: "OPEN_ORDER_CHECK_UNAVAILABLE",
  TRACKED_RECIPE_MISSING: "TRACKED_RECIPE_MISSING",
  TRACKED_RECIPE_INACTIVE: "TRACKED_RECIPE_INACTIVE",
  TRACKED_RECIPE_INVALID: "TRACKED_RECIPE_INVALID",
  CATALOG_UNAVAILABLE: "CATALOG_UNAVAILABLE",
  AUDIT_WRITE_FAILED: "AUDIT_WRITE_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
});

const MESSAGES = Object.freeze({
  [MENU_POLICY_ERROR_CODES.INVALID_MENU_ITEM_ID]: "Invalid menu item id.",
  [MENU_POLICY_ERROR_CODES.INVALID_INVENTORY_POLICY]:
    "Select tracked stock or untracked stock.",
  [MENU_POLICY_ERROR_CODES.MENU_ITEM_NOT_FOUND]: "Menu item not found.",
  [MENU_POLICY_ERROR_CODES.HISTORICAL_POLICY_READ_ONLY]:
    "This historical classification cannot be changed here. Contact a manager for a separate review.",
  [MENU_POLICY_ERROR_CODES.OPEN_ORDERS]:
    "This item has open orders. Close or cancel them before changing its inventory classification.",
  [MENU_POLICY_ERROR_CODES.LEGACY_LINE_IDENTITY_UNRESOLVED]:
    "An open order contains a legacy line whose item identity cannot be resolved safely. The classification was not changed.",
  [MENU_POLICY_ERROR_CODES.OPEN_ORDER_CHECK_UNAVAILABLE]:
    "Open orders could not be checked reliably. The classification was not changed; please retry.",
  [MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_MISSING]:
    "A valid active Recipe is required before an item can track stock.",
  [MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_INACTIVE]:
    "The Recipe for this item is inactive. Activate it before tracking stock.",
  [MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_INVALID]:
    "The Recipe for this item is invalid. Review its ingredients, stock area and units before tracking stock.",
  [MENU_POLICY_ERROR_CODES.CATALOG_UNAVAILABLE]:
    "The menu catalog is temporarily unavailable. Please retry shortly.",
  [MENU_POLICY_ERROR_CODES.AUDIT_WRITE_FAILED]:
    "The classification change could not be recorded. Nothing was changed; please retry.",
  [MENU_POLICY_ERROR_CODES.UNAUTHORIZED]:
    "Only an authenticated Manager can change inventory classification.",
});

export class MenuPolicyChangeError extends Error {
  constructor(code, detail = null, status = 409) {
    super(detail ? `${MESSAGES[code] || MESSAGES[MENU_POLICY_ERROR_CODES.CATALOG_UNAVAILABLE]} ${detail}` : MESSAGES[code] || code);
    this.name = "MenuPolicyChangeError";
    this.code = code;
    this.status = status;
  }
}

export function isMenuPolicyChangeError(err) {
  return !!err && err.name === "MenuPolicyChangeError";
}

function fail(code, detail = null, status = 409) {
  return new MenuPolicyChangeError(code, detail, status);
}

function oid(id) {
  return new mongoose.Types.ObjectId(String(id));
}

/**
 * Check open orders that reference this exact MenuItem line.
 *
 * `$elemMatch` is essential: a top-level `items.itemId` / `items.cancelled`
 * pair would match across different lines and block unrelated orders.
 */
export function buildOpenOrderFilter(menuItemId) {
  return {
    status: { $in: [...OPEN_ORDER_STATUSES] },
    items: {
      $elemMatch: {
        itemId: oid(menuItemId),
        cancelled: { $ne: true },
      },
    },
  };
}

async function readArray(query, code) {
  let rows;
  try {
    rows = await query;
  } catch (err) {
    throw fail(code, err?.message ? String(err.message).slice(0, 120) : null, 503);
  }
  if (!Array.isArray(rows)) throw fail(code, null, 503);
  return rows;
}

// Bounded, deterministic legacy identity fallback. Only exact normalized
// equality against supported MenuItem name fields is used — no fuzzy matching.
// A legacy line fails closed unless its identity is proven: it either matches
// this MenuItem unambiguously, or it is proven to belong to exactly one other
// live MenuItem. Blank, unknown/renamed, mixed or shared names always fail closed.
function supportedNames(value) {
  const out = [];
  if (typeof value === "string") {
    const s = value.trim();
    if (s) out.push(s);
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["en", "am", "om"]) {
      const raw = value[key];
      const s = typeof raw === "string" ? raw.trim() : "";
      if (s) out.push(s);
    }
  }
  return out;
}

function normalizedName(name) {
  return String(name).trim().toLocaleLowerCase();
}

// Bounded, exact-only catalog lookup used to prove a legacy name belongs to
// one specific MenuItem. No prefix/substring/fuzzy matching is performed.
async function findMenuItemsByNames(conn, session, names, excludeId) {
  const clauses = names.flatMap((name) => [
    { name },
    ...["en", "am", "om"].map((key) => ({ [`name.${key}`]: name })),
  ]);
  return readArray(
    attachSession(
      getMenuItemModel(conn)
        .find({
          _id: { $ne: excludeId },
          isDeleted: { $ne: true },
          $or: clauses,
        })
        .select("_id name")
        .limit(5),
      session
    ).lean(),
    MENU_POLICY_ERROR_CODES.OPEN_ORDER_CHECK_UNAVAILABLE
  );
}

async function assertNoAmbiguousLegacyOpenOrders(conn, session, menuItem) {
  const legacyOrders = await readArray(
    attachSession(
      getOrderModel(conn).find({
        status: { $in: [...OPEN_ORDER_STATUSES] },
        items: {
          $elemMatch: {
            cancelled: { $ne: true },
            $or: [{ itemId: null }, { itemId: { $exists: false } }],
          },
        },
      }),
      session
    )
      .select("_id items")
      .lean(),
    MENU_POLICY_ERROR_CODES.OPEN_ORDER_CHECK_UNAVAILABLE
  );

  const targetNames = new Set(supportedNames(menuItem.name).map(normalizedName));
  for (const order of legacyOrders) {
    for (const line of Array.isArray(order?.items) ? order.items : []) {
      if (!line || line.cancelled === true) continue;
      if (line.itemId != null && mongoose.isValidObjectId(String(line.itemId))) continue;
      const names = supportedNames(line.name);
      if (names.length === 0) {
        throw fail(MENU_POLICY_ERROR_CODES.LEGACY_LINE_IDENTITY_UNRESOLVED);
      }
      const normalized = names.map(normalizedName);
      const matches = normalized.filter((name) => targetNames.has(name));
      const others = await findMenuItemsByNames(conn, session, names, menuItem._id);

      if (matches.length > 0) {
        // Mixed localized names that disagree about identity cannot be resolved.
        if (matches.length !== normalized.length) {
          throw fail(MENU_POLICY_ERROR_CODES.LEGACY_LINE_IDENTITY_UNRESOLVED);
        }
        // A shared name is ambiguous, even if the other catalog row is a
        // different item. Fail closed rather than guess.
        if (others.length > 0) {
          throw fail(MENU_POLICY_ERROR_CODES.LEGACY_LINE_IDENTITY_UNRESOLVED);
        }
        throw fail(MENU_POLICY_ERROR_CODES.OPEN_ORDERS, "(legacy name-only line)");
      }

      // No target match. Only treat the line as unrelated if it can be proven
      // to belong to exactly one other live MenuItem whose supported names
      // cover every name on the legacy line. Unknown/renamed names fail closed.
      const distinct = new Map(others.map((doc) => [String(doc._id), doc]));
      if (distinct.size !== 1) {
        throw fail(MENU_POLICY_ERROR_CODES.LEGACY_LINE_IDENTITY_UNRESOLVED);
      }
      const otherNames = new Set(
        supportedNames([...distinct.values()][0]?.name).map(normalizedName)
      );
      if (!normalized.every((name) => otherNames.has(name))) {
        throw fail(MENU_POLICY_ERROR_CODES.LEGACY_LINE_IDENTITY_UNRESOLVED);
      }
      // Provably a different MenuItem — safe to ignore.
    }
  }
}

async function loadTrackedRecipeValidation(conn, session, menuItem) {
  const rows = await readArray(
    getRecipeModel(conn)
      .find({ menuItemId: menuItem._id })
      .session(session)
      .lean(),
    MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_INVALID
  );
  // A duplicate Recipe for one MenuItem is ambiguous — the canonical TRACKED
  // gate treats it as unusable, so classification fails closed as well.
  if (rows.length !== 1) throw fail(MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_MISSING);
  const recipe = rows[0];
  if (recipe.isActive === false) throw fail(MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_INACTIVE);
  if (!isTrackedRecipeUsable(recipe)) throw fail(MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_INVALID);

  const ids = [...new Set(recipe.ingredients.map((ing) => String(ing.inventoryItemId).trim()))];
  const invDocs = await readArray(
    getInventoryItemModel(conn)
      .find({ _id: { $in: ids.map(oid) } })
      .session(session)
      .lean(),
    MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_INVALID
  );
  const inventoryById = new Map(invDocs.map((doc) => [String(doc._id), doc]));

  // Reuse the same canonical stock-area and unit gates a Recipe write uses.
  // Nothing here creates, edits or backfills a Recipe or InventoryItem.
  const area = validateRecipeStockArea({ menuItem, ingredients: recipe.ingredients, inventoryById });
  if (!area.ok) throw fail(MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_INVALID, area.error);
  const units = validateRecipeIngredientUnits({
    ingredients: recipe.ingredients,
    inventoryById,
  });
  if (!units.ok) throw fail(MENU_POLICY_ERROR_CODES.TRACKED_RECIPE_INVALID, units.error);
  return recipe;
}

/**
 * Classify / reclassify one MenuItem.
 *
 * @param {object} conn MongoDB connection (injected; never opened here).
 * @param {{menuItemId: string, requestedPolicy: string,
 *          actor: {staffId: string, role: string}}} input
 * @returns {Promise<{changed: boolean, itemId: string, inventoryPolicy: string,
 *                   previousRaw: *, previousResolved: string}>}
 */
export async function classifyMenuItemInventoryPolicy(conn, input = {}) {
  const { menuItemId, requestedPolicy, actor } = input || {};
  const id = String(menuItemId ?? "").trim();
  if (!mongoose.isValidObjectId(id)) throw fail(MENU_POLICY_ERROR_CODES.INVALID_MENU_ITEM_ID);

  const policyCheck = validateExplicitInventoryPolicy(requestedPolicy);
  if (!policyCheck.ok) throw fail(MENU_POLICY_ERROR_CODES.INVALID_INVENTORY_POLICY);
  const target = policyCheck.policy;

  // The actor comes from the Server Action's live session payload. A client
  // field of the same name can never reach this parameter (see actions.js).
  if (
    !actor ||
    !mongoose.isValidObjectId(String(actor.staffId ?? "")) ||
    String(actor.role ?? "").trim().toUpperCase() !== "MANAGER"
  ) {
    throw fail(MENU_POLICY_ERROR_CODES.UNAUTHORIZED, null, 403);
  }
  if (!conn || typeof conn.startSession !== "function") {
    throw fail(MENU_POLICY_ERROR_CODES.CATALOG_UNAVAILABLE, null, 503);
  }

  return runPolicyVersionedTransaction(
    conn,
    async (session) => {
      const MenuItem = getMenuItemModel(conn);
      const existing = await MenuItem.findOne({
        _id: oid(id),
        isDeleted: { $ne: true },
      })
        .session(session)
        .lean();
      if (!existing) throw fail(MENU_POLICY_ERROR_CODES.MENU_ITEM_NOT_FOUND);

      const previousRaw = existing.inventoryPolicy ?? null;
      const previousResolved = resolveInventoryPolicy(existing);
      // Historical classifications are read-only; EXTERNAL retirement is a
      // separate reviewed workflow and is intentionally not performed here.
      if (previousResolved === INVENTORY_POLICY_HISTORICAL_EXTERNAL) {
        throw fail(MENU_POLICY_ERROR_CODES.HISTORICAL_POLICY_READ_ONLY);
      }
      if (previousResolved === target) {
        return {
          changed: false,
          itemId: id,
          inventoryPolicy: target,
          previousRaw,
          previousResolved,
        };
      }

      const openOrders = await readArray(
        getOrderModel(conn)
          .find(buildOpenOrderFilter(id))
          .session(session)
          .select("_id status")
          .limit(1)
          .lean(),
        MENU_POLICY_ERROR_CODES.OPEN_ORDER_CHECK_UNAVAILABLE
      );
      if (openOrders.length > 0) {
        const status = String(openOrders[0]?.status || "OPEN");
        throw fail(MENU_POLICY_ERROR_CODES.OPEN_ORDERS, `(${status})`);
      }

      // Legacy name-only lines cannot be resolved by itemId. Fail closed when
      // they may refer to this MenuItem (or cannot be resolved at all).
      await assertNoAmbiguousLegacyOpenOrders(conn, session, existing);

      if (target === INVENTORY_POLICY.TRACKED) {
        await loadTrackedRecipeValidation(conn, session, existing);
      }

      // Shared serialization point: the policy update AND the policyVersion
      // bump are one conditional write on the same MenuItem document that
      // order creation/edit-addition also writes. A concurrent order insert
      // changes the version, so this write misses and the whole transaction is
      // retried with a fresh open-order recheck and freshly resolved policy.
      await bumpMenuItemPolicyVersions(
        conn,
        [
          {
            menuItemId: id,
            expectedVersion: normalizePolicyVersion(existing.policyVersion),
            filter: { inventoryPolicy: { $ne: target } },
            set: { inventoryPolicy: target, updatedAt: new Date() },
            runValidators: true,
            timestamps: true,
          },
        ],
        session
      );

      // Durable audit in the same transaction: if this write fails, the
      // classification write is rolled back and the Manager sees an error.
      try {
        await createInventoryAudit(
          conn,
          {
            itemId: id,
            action: "ITEM_UPDATED",
            actorId: String(actor.staffId),
            actorRole: "MANAGER",
            reason: `${MENU_POLICY_AUDIT_REASON}: ${previousResolved} -> ${target}`.slice(0, 500),
            beforeSnapshot: {
              menuItemId: id,
              inventoryPolicy: previousRaw,
              resolvedPolicy: previousResolved,
            },
            afterSnapshot: {
              menuItemId: id,
              inventoryPolicy: target,
              resolvedPolicy: target,
            },
          },
          { session }
        );
      } catch (err) {
        throw fail(
          MENU_POLICY_ERROR_CODES.AUDIT_WRITE_FAILED,
          err?.message ? String(err.message).slice(0, 120) : null,
          503
        );
      }

      return {
        changed: true,
        itemId: id,
        inventoryPolicy: target,
        previousRaw,
        previousResolved,
      };
    },
    {
      makeUnavailableError: (message, status, code) =>
        fail(MENU_POLICY_ERROR_CODES.CATALOG_UNAVAILABLE, message, status),
    }
  );
}
