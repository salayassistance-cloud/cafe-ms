// Recipe validation — follows lib/validate.js + lib/inventoryValidation.js style.
import { sanitizeString, OBJECTID_RE } from "@/lib/validate";

export function validateRecipeCreate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body: expected JSON object" };
  }
  const menuIdRaw = body.menuItemId ?? body.menuId;
  const menuId = String(menuIdRaw || "").trim();
  if (!menuId) return { error: "menuItemId is required" };
  if (!OBJECTID_RE.test(menuId)) return { error: "menuItemId must be valid ObjectId" };

  const ingredients = body.ingredients;
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return { error: "ingredients is required and must be non-empty array" };
  }
  if (ingredients.length > 50) return { error: "Too many ingredients (max 50)" };

  const sanitizedIngredients = [];
  for (let i = 0; i < ingredients.length; i++) {
    const raw = ingredients[i];
    if (!raw || typeof raw !== "object") return { error: `ingredients[${i}]: invalid shape` };
    const invId = String(raw.inventoryItemId || raw.itemId || "").trim();
    if (!invId) return { error: `ingredients[${i}].inventoryItemId is required` };
    if (!OBJECTID_RE.test(invId)) return { error: `ingredients[${i}].inventoryItemId must be valid ObjectId` };
    const qty = Number(raw.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return { error: `ingredients[${i}].quantity must be number > 0` };
    const unitRaw = raw.unit;
    const unit = sanitizeString(unitRaw, { maxLen: 50 });
    if (!unit) return { error: `ingredients[${i}].unit is required` };
    sanitizedIngredients.push({ inventoryItemId: invId, quantity: qty, unit });
  }

  return { ok: true, data: { menuItemId: menuId, ingredients: sanitizedIngredients } };
}

export function validateRecipeUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body" };
  }
  const data = {};
  let hasField = false;

  if (body.menuItemId != null || body.menuId != null) {
    const mid = String(body.menuItemId ?? body.menuId).trim();
    if (!mid) return { error: "menuItemId cannot be empty" };
    if (!OBJECTID_RE.test(mid)) return { error: "menuItemId must be valid ObjectId" };
    data.menuItemId = mid;
    hasField = true;
  }
  if (body.ingredients != null) {
    if (!Array.isArray(body.ingredients) || body.ingredients.length === 0) {
      return { error: "ingredients must be non-empty array" };
    }
    if (body.ingredients.length > 50) return { error: "Too many ingredients (max 50)" };
    const sanitized = [];
    for (let i = 0; i < body.ingredients.length; i++) {
      const raw = body.ingredients[i];
      if (!raw || typeof raw !== "object") return { error: `ingredients[${i}]: invalid shape` };
      const invId = String(raw.inventoryItemId || raw.itemId || "").trim();
      if (!invId) return { error: `ingredients[${i}].inventoryItemId is required` };
      if (!OBJECTID_RE.test(invId)) return { error: `ingredients[${i}].inventoryItemId must be valid ObjectId` };
      const qty = Number(raw.quantity);
      if (!Number.isFinite(qty) || qty <= 0) return { error: `ingredients[${i}].quantity must be number > 0` };
      const unit = sanitizeString(raw.unit, { maxLen: 50 });
      if (!unit) return { error: `ingredients[${i}].unit is required` };
      sanitized.push({ inventoryItemId: invId, quantity: qty, unit });
    }
    data.ingredients = sanitized;
    hasField = true;
  }
  if (body.isActive != null) {
    data.isActive = Boolean(body.isActive);
    hasField = true;
  }

  if (!hasField) return { error: "No update fields provided (need menuItemId, ingredients, or isActive)" };
  return { ok: true, data };
}
