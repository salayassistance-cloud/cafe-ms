// recipeWriteService.js — transactional Recipe create/update (OBS-3 Option 2).
//
// The routes keep authentication, request parsing, pure payload validation and
// response serialization. Everything that must share a MongoDB transaction
// lives here so the replica-set harness can exercise the exact production
// operation.
//
// Critical invariant: every InventoryItem used for Recipe validation is read
// with the SAME session that later increments its `unitRevision`. A
// pre-transaction read followed by an in-transaction increment does not close
// the race, because the transaction snapshot may already contain the new unit.

import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { getMenuItemModel } from "@/lib/models/MenuItem";
import { getRecipeModel } from "@/lib/models/Recipe";
import {
  RECIPE_MENU_ITEM_NOT_FOUND,
  isRecipeReactivation,
  recipeIngredientTupleKey,
  requiresStockAreaRevalidation,
  validateRecipeIngredientUnits,
  validateRecipeStockArea,
} from "@/lib/recipeStockArea";
import {
  RECIPE_COMMIT_UNKNOWN,
  RECIPE_UNIT_CHANGED,
  INVENTORY_ITEM_CHANGED,
  RecipeWriteError,
  buildUnitRevisionWrites,
  collectAffectedInventoryItemIds,
  shouldCoordinateRecipeWrite,
} from "@/lib/recipeUnitCoordination";
import {
  isTransientTransactionError,
  isUnknownCommitResult,
  runInTransaction,
} from "@/lib/transactionRunner";

function isDuplicateKeyError(err) {
  return (
    !!err &&
    (err.code === 11000 ||
      err?.cause?.code === 11000 ||
      err?.originalError?.code === 11000)
  );
}

function runRecipeTransaction(conn, fn) {
  return runInTransaction(conn, fn, {
    makeUnavailableError: (message, status, code) =>
      new RecipeWriteError(message, status, code),
  }).catch((err) => {
    // Never retry a duplicate key or a business error: only the runner decides
    // retries, and it already stopped. Map the post-retry outcomes below.
    if (isDuplicateKeyError(err)) {
      throw new RecipeWriteError("Recipe for this menu item already exists", 409);
    }
    if (isUnknownCommitResult(err)) {
      throw new RecipeWriteError(
        "Recipe write could not be confirmed. Reload before retrying.",
        409,
        RECIPE_COMMIT_UNKNOWN
      );
    }
    if (isTransientTransactionError(err)) {
      throw new RecipeWriteError(
        "Inventory units changed while saving the recipe. Reload and retry.",
        409,
        RECIPE_UNIT_CHANGED
      );
    }
    throw err;
  });
}

// Shared coordination write. Runs inside the recipe transaction, after all
// validation and after the Recipe write. Sorted + ordered + no timestamps:
// this is a coordination touch, not a business edit of the item.
async function writeUnitRevisions(InventoryItem, plan, session) {
  if (!plan.participate || plan.ids.length === 0) return;
  const writes = buildUnitRevisionWrites(plan.ids);
  const result = await InventoryItem.bulkWrite(writes, {
    session,
    ordered: true,
    timestamps: false,
  });
  const matched = Number(result?.matchedCount ?? 0);
  if (matched !== writes.length) {
    // Validation already loaded these items in this snapshot. A no-match means
    // a concurrent delete/direct write; abort rather than commit a Recipe that
    // references a document we could not coordinate.
    throw new RecipeWriteError(
      "Inventory item changed concurrently. Reload and retry.",
      409,
      INVENTORY_ITEM_CHANGED
    );
  }
}

/**
 * Create an active Recipe (POST /api/recipes).
 * `data` is the output of validateRecipeCreate: { menuItemId, ingredients }.
 * Returns the created document plus the authoritative docs loaded for the
 * response serializer, preserving the previous response shape.
 */
export async function createRecipe(conn, data) {
  return runRecipeTransaction(conn, async (session) => {
    const Recipe = getRecipeModel(conn);
    const MenuItem = getMenuItemModel(conn);
    const InventoryItem = getInventoryItemModel(conn);

    const menuDoc = await MenuItem.findById(data.menuItemId)
      .select("_id name category categoryType station targetStation isDeleted")
      .session(session)
      .lean();
    if (!menuDoc || menuDoc.isDeleted === true) throw new RecipeWriteError("Menu item not found", 404);

    // Deduplicate for the query/coordination; keep the original raw-count check
    // below so duplicate ingredient rows still fail exactly as before.
    const invIds = collectAffectedInventoryItemIds(data.ingredients);
    const invDocs = invIds.length
      ? await InventoryItem.find({ _id: { $in: invIds } })
          .select("name category unit stockGroup currentStock status")
          .session(session)
          .lean()
      : [];
    if (invDocs.length !== data.ingredients.length) {
      throw new RecipeWriteError("One or more inventory items not found", 404);
    }

    const invUnitMap = new Map(
      invDocs.map((d) => [String(d._id), String(d.unit || "").trim().toLowerCase()])
    );
    for (const ingredient of data.ingredients) {
      const expectedUnit = invUnitMap.get(String(ingredient.inventoryItemId)) || "";
      const ingredientUnit = String(ingredient.unit || "").trim().toLowerCase();
      if (expectedUnit && ingredientUnit !== expectedUnit) {
        const itemDoc = invDocs.find(
          (d) => String(d._id) === String(ingredient.inventoryItemId)
        );
        const invName = itemDoc?.name || ingredient.inventoryItemId;
        throw new RecipeWriteError(
          `Unit mismatch for ingredient "${invName}": recipe unit "${ingredient.unit}" does not match inventory unit "${itemDoc?.unit}"`,
          400
        );
      }
    }

    const invById = new Map(invDocs.map((d) => [String(d._id), d]));
    const stockArea = validateRecipeStockArea({
      menuItem: menuDoc,
      ingredients: data.ingredients,
      inventoryById: invById,
    });
    if (!stockArea.ok) {
      throw new RecipeWriteError(stockArea.error, 400, stockArea.code);
    }

    const existing = await Recipe.findOne({ menuItemId: data.menuItemId })
      .session(session)
      .lean();
    if (existing) throw new RecipeWriteError("Recipe for this menu item already exists", 409);

    const doc = new Recipe(data);
    await doc.save({ session });

    // createRecipe's payload cannot set isActive (validateRecipeCreate drops
    // it), so every created Recipe is active and always participates.
    const plan = shouldCoordinateRecipeWrite({
      isCreate: true,
      nextIngredients: data.ingredients,
    });
    await writeUnitRevisions(InventoryItem, plan, session);

    return { doc, menuDoc, invDocs };
  });
}

/**
 * Update a Recipe (PATCH /api/recipes/[id]).
 * `data` is the output of validateRecipeUpdate and contains only menuItemId,
 * ingredients and/or isActive. Returns the updated document.
 *
 * M-1 stock-area compatibility and OBS-3b reactivation unit validation are
 * preserved verbatim; the only difference is that every read is session-bound.
 */
export async function updateRecipe(conn, recipeId, data) {
  return runRecipeTransaction(conn, async (session) => {
    const Recipe = getRecipeModel(conn);
    const MenuItem = getMenuItemModel(conn);
    const InventoryItem = getInventoryItemModel(conn);

    const changesIngredients = data.ingredients != null;
    const changesMenu = data.menuItemId != null;
    const activating = data.isActive === true;

    let current = null;
    if (changesIngredients || changesMenu || activating) {
      current = await Recipe.findById(recipeId)
        .select("menuItemId ingredients isActive")
        .session(session)
        .lean();
      if (!current) throw new RecipeWriteError("Recipe not found", 404);
    }

    let menuDoc = null;
    if (changesMenu) {
      menuDoc = await MenuItem.findById(data.menuItemId)
        .select("_id name category categoryType station targetStation isDeleted")
        .session(session)
        .lean();
      if (!menuDoc || menuDoc.isDeleted === true) throw new RecipeWriteError("Menu item not found", 404);
      const duplicate = await Recipe.findOne({
        menuItemId: data.menuItemId,
        _id: { $ne: recipeId },
      })
        .session(session)
        .lean();
      if (duplicate) {
        throw new RecipeWriteError("Recipe for this menu item already exists", 409);
      }
    }

    let invDocs = null;
    if (changesIngredients) {
      const invIds = collectAffectedInventoryItemIds(data.ingredients);
      invDocs = invIds.length
        ? await InventoryItem.find({ _id: { $in: invIds } })
            .select("name unit stockGroup")
            .session(session)
            .lean()
        : [];
      if (invDocs.length !== data.ingredients.length) {
        throw new RecipeWriteError("One or more inventory items not found", 404);
      }
      const invUnitMap = new Map(
        invDocs.map((d) => [String(d._id), String(d.unit || "").trim().toLowerCase()])
      );
      for (const ingredient of data.ingredients) {
        const expectedUnit = invUnitMap.get(String(ingredient.inventoryItemId)) || "";
        const ingredientUnit = String(ingredient.unit || "").trim().toLowerCase();
        if (expectedUnit && ingredientUnit !== expectedUnit) {
          const itemDoc = invDocs.find(
            (d) => String(d._id) === String(ingredient.inventoryItemId)
          );
          const invName = itemDoc?.name || ingredient.inventoryItemId;
          throw new RecipeWriteError(
            `Unit mismatch for ingredient "${invName}": recipe unit "${ingredient.unit}" does not match inventory unit "${itemDoc?.unit}"`,
            400
          );
        }
      }
    }

    const needsCompatibility = requiresStockAreaRevalidation(current, data);
    if (needsCompatibility) {
      if (!menuDoc) {
        if (!current?.menuItemId) {
          throw new RecipeWriteError(
            "Recipe has no menu item; stock-area compatibility cannot be validated",
            400,
            RECIPE_MENU_ITEM_NOT_FOUND
          );
        }
        menuDoc = await MenuItem.findById(current.menuItemId)
          .select("_id name category categoryType station targetStation isDeleted")
          .session(session)
          .lean();
        if (!menuDoc || menuDoc.isDeleted === true) throw new RecipeWriteError("Menu item not found", 404);
      }

      const ingredientsForCheck = changesIngredients
        ? data.ingredients
        : current.ingredients || [];
      if (!invDocs) {
        const invIds = collectAffectedInventoryItemIds(ingredientsForCheck);
        invDocs = invIds.length
          ? await InventoryItem.find({ _id: { $in: invIds } })
              .select("name unit stockGroup")
              .session(session)
              .lean()
          : [];
      }

      const invById = new Map(invDocs.map((d) => [String(d._id), d]));
      const stockArea = validateRecipeStockArea({
        menuItem: menuDoc,
        ingredients: ingredientsForCheck,
        inventoryById: invById,
      });
      if (!stockArea.ok) {
        throw new RecipeWriteError(stockArea.error, 400, stockArea.code);
      }

      // OBS-3b: preserved exactly — reactivation revalidates the effective
      // stored rows against the authoritative units loaded in this session.
      if (isRecipeReactivation(current, data)) {
        const unitCompat = validateRecipeIngredientUnits({
          ingredients: ingredientsForCheck,
          inventoryById: invById,
        });
        if (!unitCompat.ok) {
          throw new RecipeWriteError(unitCompat.error, 400, unitCompat.code);
        }
      }
    }

    // Decide participation before the write; validation has fully passed.
    // An ingredient PATCH that resends the stored tuple (the same rule
    // requiresStockAreaRevalidation uses) is a no-op and does not touch the
    // coordination token or conflict with concurrent unit changes.
    const ingredientsChanged =
      changesIngredients &&
      recipeIngredientTupleKey(data.ingredients) !== recipeIngredientTupleKey(current?.ingredients);
    const plan = shouldCoordinateRecipeWrite({
      current,
      nextIsActive: data.isActive,
      changesIngredients: ingredientsChanged,
      nextIngredients: data.ingredients ?? null,
    });

    const doc = await Recipe.findOneAndUpdate(
      { _id: recipeId },
      { $set: { ...data, updatedAt: new Date() } },
      { returnDocument: 'after', runValidators: true, session }
    ).lean();
    if (!doc) throw new RecipeWriteError("Recipe not found", 404);

    await writeUnitRevisions(InventoryItem, plan, session);
    return doc;
  });
}
