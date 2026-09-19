// Recipe service helpers — Phase F, no stock deduction, no sales calc.
import { getLocalizedSingleString } from "@/lib/displayName";

export function serializeRecipe(doc, menuMap, inventoryMap) {
  const menuItem = doc.menuItemId ? menuMap?.get(String(doc.menuItemId)) : null;
  const ingredients = (doc.ingredients || []).map((ing) => {
    const inv = inventoryMap?.get(String(ing.inventoryItemId)) || null;
    return {
      inventoryItemId: String(ing.inventoryItemId),
      quantity: Number(ing.quantity),
      unit: String(ing.unit),
      inventoryItem: inv
        ? {
            _id: String(inv._id),
            name: inv.name,
            category: inv.category,
            unit: inv.unit,
            currentStock: inv.currentStock,
            status: inv.status,
          }
        : null,
    };
  });

  // Menu item display - handle LocalizedString or string
  let menuItemInfo = null;
  if (menuItem) {
    const name = menuItem.name;
    const displayName = typeof name === "object" ? getLocalizedSingleString(name) : String(name || "");
    menuItemInfo = {
      _id: String(menuItem._id),
      name: displayName,
      nameObj: name,
      price: menuItem.price,
      category: menuItem.category ? String(menuItem.category) : null,
      isAvailable: menuItem.isAvailable,
    };
  } else if (doc.menuItemId) {
    menuItemInfo = { _id: String(doc.menuItemId), name: String(doc.menuItemId), price: null };
  }

  return {
    _id: String(doc._id),
    id: String(doc._id),
    menuItemId: String(doc.menuItemId),
    menuItem: menuItemInfo,
    ingredients,
    ingredientsCount: ingredients.length,
    isActive: doc.isActive !== false,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}
