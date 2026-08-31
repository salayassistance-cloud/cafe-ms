"use server";

import { revalidatePath } from "next/cache";
import { publish } from "@/lib/eventHub";
import { uploadToCloudinary } from "@/lib/cloudinary";
import { cookies } from "next/headers";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/sessionCrypto";

// Centralized guard for menu CRUD — canonical policy is MANAGER only (lib/policy.js)
// Server Actions cannot use requireAuth(request) (no Request); we verify the
// HttpOnly cookie directly, identical to lib/authServer getPortalSession.
async function assertManager() {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (!token) return { success: false, error: "Authentication required" };
    const payload = verifySessionToken(token);
    if (!payload || String(payload.role).toUpperCase() !== "MANAGER") {
      return { success: false, error: "Forbidden: requires MANAGER role" };
    }
    const { SESSION_IDLE_TIMEOUT_MS } = await import("@/lib/sessionCrypto");
    if (payload.iat && Date.now() - Number(payload.iat) > SESSION_IDLE_TIMEOUT_MS) {
      return { success: false, error: "Your session has expired due to inactivity. Please sign in again." };
    }
  } catch {
    return { success: false, error: "Authentication required" };
  }
  return null;
}

function parseBool(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "on" || s === "1" || s === "yes";
}

function slugify(input) {
  return String(input).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "category";
}

async function getDbModels() {
  const { connectToDatabase } = await import("@/lib/mongodb");
  const conn = await connectToDatabase();
  const { getCategoryModel } = await import("@/lib/models/Category");
  const { getMenuItemModel } = await import("@/lib/models/MenuItem");
  const Category = getCategoryModel(conn);
  const MenuItem = getMenuItemModel(conn);
  return { conn, Category, MenuItem };
}

function revalidateAll() {
  revalidatePath("/menu");
  revalidatePath("/waiter");
  revalidatePath("/manager/menu-crud");
  revalidatePath("/manager/reports");
  revalidatePath("/");
  // Push a lightweight "menu changed" event so already-open /menu and Waiter
  // terminals refetch the authoritative catalog immediately (real-time sync).
  // Reuses the existing SSE eventHub — no second event system, one event per
  // mutation (revalidateAll runs once per CRUD action).
  try {
    publish({ type: "menu-changed" });
  } catch {
    /* event hub is best-effort; DB commit above already succeeded */
  }
}

export async function createCategory(prevState, formData) {
  const authErr = await assertManager();
  if (authErr) return authErr;
  const hasLocalizedNames = ["nameEn", "nameAm", "nameOm"].some((key) => formData.has(key));
  const legacyName = formData.get("name")?.toString().trim() || "";
  const nameEn = (hasLocalizedNames ? formData.get("nameEn") : legacyName)?.toString().trim() || "";
  const nameAm = (hasLocalizedNames ? formData.get("nameAm") : legacyName)?.toString().trim() || "";
  const nameOm = (hasLocalizedNames ? formData.get("nameOm") : legacyName)?.toString().trim() || "";
  if (!nameEn && !nameAm && !nameOm) return { success: false, error: "Category name required" };
  // Match Menu Item creation: use the first provided locale for any omitted locale.
  const primaryName = nameEn || nameAm || nameOm;
  const finalNameEn = nameEn || primaryName;
  const finalNameAm = nameAm || primaryName;
  const finalNameOm = nameOm || primaryName;
  const slug = slugify(finalNameEn || finalNameAm || finalNameOm);
  const rawStation = formData.get("targetStation")?.toString().trim().toUpperCase();
  const targetStation = rawStation === "BARISTA" ? "BARISTA" : "KITCHEN";
  try {
    const { Category } = await getDbModels();
    const existing = await Category.findOne({ slug }).lean();
    if (existing) return { success: false, error: `Category "${primaryName}" already exists` };
    const doc = new Category({
      name: { en: finalNameEn, am: finalNameAm, om: finalNameOm },
      slug,
      type: targetStation === "BARISTA" ? "DRINK" : "FOOD",
      targetStation,
      isActive: true,
      order: Date.now() % 10000,
      displayOrder: Date.now() % 10000,
    });
    await doc.save();
    revalidateAll();
    return {
      success: true,
      message: `Category "${primaryName}" created`,
      category: {
        _id: String(doc._id),
        id: String(doc._id),
        name: { en: finalNameEn, am: finalNameAm, om: finalNameOm },
        nameObj: { en: finalNameEn, am: finalNameAm, om: finalNameOm },
        nameEn: finalNameEn,
        nameAm: finalNameAm,
        nameOm: finalNameOm,
        slug,
        type: targetStation === "BARISTA" ? "DRINK" : "FOOD",
        targetStation,
        station: targetStation,
      },
    };
  } catch (e) {
    return { success: false, error: e.message || "Failed to create category" };
  }
}

export async function deleteCategory(formDataOrId) {
  const authErr = await assertManager();
  if (authErr) return authErr;
  const id = typeof formDataOrId === "string" ? formDataOrId : formDataOrId.get("id")?.toString() || formDataOrId.get("_id")?.toString();
  if (!id) return { success: false, error: "Category id required" };
  try {
    const { Category, MenuItem } = await getDbModels();
    const count = await MenuItem.countDocuments({ $or: [{ category: id }, { categoryId: id }] });
    if (count > 0) return { success: false, error: `Cannot delete — ${count} menu item(s) still reference this category` };
    const res = await Category.deleteOne({ _id: id });
    if (res.deletedCount === 0) return { success: false, error: "Category not found" };
    revalidateAll();
    return { success: true, message: "Category deleted" };
  } catch (e) {
    return { success: false, error: e.message || "Failed to delete category" };
  }
}

export async function updateCategory(prevState, formData) {
  const authErr = await assertManager();
  if (authErr) return authErr;
  const id = formData.get("id")?.toString().trim();
  const hasLocalizedNames = ["nameEn", "nameAm", "nameOm"].some((key) => formData.has(key));
  const legacyName = formData.get("name")?.toString().trim() || "";
  if (!id || (!hasLocalizedNames && !legacyName)) return { success: false, error: "id and name required" };
  const submittedNameEn = (hasLocalizedNames ? formData.get("nameEn") : legacyName)?.toString().trim() || "";
  const submittedNameAm = (hasLocalizedNames ? formData.get("nameAm") : legacyName)?.toString().trim() || "";
  const submittedNameOm = (hasLocalizedNames ? formData.get("nameOm") : legacyName)?.toString().trim() || "";
  const rawStation = formData.get("targetStation")?.toString().trim().toUpperCase();
  const targetStation = rawStation === "BARISTA" ? "BARISTA" : rawStation === "KITCHEN" ? "KITCHEN" : null;
  try {
    const { Category } = await getDbModels();
    const cat = await Category.findById(id);
    if (!cat) return { success: false, error: "Category not found" };
    const existingName = cat.name || {};
    const isLocalized = typeof existingName === "object" && (existingName.en || existingName.am || existingName.om);
    const baseEn = isLocalized ? (existingName.en || "") : (typeof existingName === "string" ? existingName : "");
    const baseAm = isLocalized ? (existingName.am || "") : baseEn;
    const baseOm = isLocalized ? (existingName.om || "") : baseEn;
    // Match Menu Item updates: an empty submitted locale keeps its existing value.
    const finalNameEn = submittedNameEn || baseEn;
    const finalNameAm = submittedNameAm || baseAm;
    const finalNameOm = submittedNameOm || baseOm;
    if (!finalNameEn && !finalNameAm && !finalNameOm) {
      return { success: false, error: "Category name required" };
    }
    const slug = slugify(finalNameEn || finalNameAm || finalNameOm);
    cat.name = { en: finalNameEn, am: finalNameAm, om: finalNameOm };
    cat.slug = slug;
    if (targetStation) {
      cat.targetStation = targetStation;
      cat.type = targetStation === "BARISTA" ? "DRINK" : "FOOD";
    }
    await cat.save();
    revalidateAll();
    return {
      success: true,
      message: "Category updated",
      category: {
        _id: String(cat._id),
        id: String(cat._id),
        name: { en: finalNameEn, am: finalNameAm, om: finalNameOm },
        nameObj: { en: finalNameEn, am: finalNameAm, om: finalNameOm },
        nameEn: finalNameEn,
        nameAm: finalNameAm,
        nameOm: finalNameOm,
        slug: cat.slug,
        type: cat.type,
        targetStation: cat.targetStation,
        station: cat.targetStation,
      },
    };
  } catch (e) {
    return { success: false, error: e.message || "Failed to update category" };
  }
}

export async function createMenuItem(prevState, formData) {
  const authErr = await assertManager();
  if (authErr) return authErr;
  try {
    const nameEn = formData.get("nameEn")?.toString().trim() || "";
    const nameAm = formData.get("nameAm")?.toString().trim() || "";
    const nameOm = formData.get("nameOm")?.toString().trim() || "";
    const descEn = formData.get("descriptionEn")?.toString().trim() || "";
    const descAm = formData.get("descriptionAm")?.toString().trim() || "";
    const descOm = formData.get("descriptionOm")?.toString().trim() || "";
    const priceRaw = formData.get("price")?.toString().trim();
    const category = formData.get("category")?.toString().trim();
    const imageFile = formData.get("image");
    const imageUrlFromInput = formData.get("imageUrl")?.toString().trim() || "";
    const isSpecial = parseBool(formData.get("isSpecial"));
    const isNew = parseBool(formData.get("isNew") || formData.get("isItemNew") || formData.get("isPopular"));
    const isAvailable = formData.get("isAvailable") == null ? true : parseBool(formData.get("isAvailable"));
    const isFasting = parseBool(formData.get("isFasting"));
    const isNonFasting = parseBool(formData.get("isNonFasting"));
    if (!nameEn && !nameAm && !nameOm) return { success: false, error: "At least one name (EN/AM/OM) is required" };
    if (!category) return { success: false, error: "Category is required" };
    const price = Number(priceRaw);
    if (!Number.isFinite(price) || price < 0) return { success: false, error: "Price must be a non-negative number" };
    const primaryName = nameEn || nameAm || nameOm;
    const finalNameEn = nameEn || primaryName;
    const finalNameAm = nameAm || primaryName;
    const finalNameOm = nameOm || primaryName;
    const finalDescEn = descEn || descAm || descOm || "";
    const finalDescAm = descAm || descEn || "";
    const finalDescOm = descOm || descEn || "";
    let finalImageUrl = imageUrlFromInput || "";
    if (imageFile && typeof imageFile === "object" && "arrayBuffer" in imageFile && imageFile.size > 0) {
      try {
        finalImageUrl = await uploadToCloudinary(imageFile);
      } catch (err) {
        return { success: false, error: `Image upload failed: ${err.message}` };
      }
    }
    if (!finalImageUrl) {
      finalImageUrl = "/placeholders/food.svg";
    }
    const fastingFlags = {};
    if (formData.get("isFasting") == null && formData.get("isNonFasting") == null) {
      fastingFlags.isFasting = false;
      fastingFlags.isNonFasting = true;
    } else {
      fastingFlags.isFasting = isFasting;
      fastingFlags.isNonFasting = isNonFasting;
      if (!isFasting && !isNonFasting) fastingFlags.isNonFasting = true;
    }
    const { MenuItem, Category } = await getDbModels();
    let catDoc = null;
    try {
      catDoc = await Category.findById(category).lean();
      if (!catDoc) catDoc = await Category.findOne({ slug: category }).lean();
    } catch {}
    if (!catDoc) return { success: false, error: "Category not found" };
    const catId = catDoc._id;
    const rawStation = formData.get("targetStation")?.toString().trim().toUpperCase();
    const forcedStation = rawStation === "BARISTA" ? "BARISTA" : rawStation === "KITCHEN" ? "KITCHEN" : null;
    const catStation = catDoc.targetStation ? catDoc.targetStation : (catDoc.type === "DRINK" || /drink|barista|juice|coffee|beer|wine/i.test(catDoc.name?.en || catDoc.slug || "")) ? "BARISTA" : "KITCHEN";
    const resolvedStation = forcedStation || catStation;
    // Ensure category itself carries correct station tag for reports
    if (catDoc.targetStation !== resolvedStation) {
      try { await Category.updateOne({ _id: catId }, { $set: { targetStation: resolvedStation, type: resolvedStation === "BARISTA" ? "DRINK" : "FOOD" } }); } catch {}
    }
    const payload = {
      name: { am: finalNameAm, en: finalNameEn, om: finalNameOm },
      description: { am: finalDescAm, en: finalDescEn, om: finalDescOm },
      price: Math.round(price * 100) / 100,
      category: catId,
      categoryId: catId,
      categoryType: resolvedStation === "BARISTA" ? "DRINK" : "FOOD",
      station: resolvedStation,
      targetStation: resolvedStation,
      imageUrl: finalImageUrl,
      image: finalImageUrl,
      isSpecial,
      isNew,
      isItemNew: isNew,
      isPopular: isNew,
      isAvailable,
      isFasting: fastingFlags.isFasting,
      isNonFasting: fastingFlags.isNonFasting,
      inStock: isAvailable,
    };
    const doc = new MenuItem(payload);
    const saved = await doc.save();
    revalidateAll();
    return { success: true, message: `Menu item "${finalNameEn}" created`, itemId: String(saved._id) };
  } catch (e) {
    return { success: false, error: e.message || "Failed to create menu item" };
  }
}

export async function updateMenuItem(prevState, formData) {
  const authErr = await assertManager();
  if (authErr) return authErr;
  try {
    const id = formData.get("id")?.toString().trim() || formData.get("_id")?.toString().trim();
    if (!id) return { success: false, error: "Item id required" };
    const nameEn = formData.get("nameEn")?.toString().trim();
    const nameAm = formData.get("nameAm")?.toString().trim();
    const nameOm = formData.get("nameOm")?.toString().trim();
    const descEn = formData.get("descriptionEn")?.toString().trim();
    const descAm = formData.get("descriptionAm")?.toString().trim();
    const descOm = formData.get("descriptionOm")?.toString().trim();
    const priceRaw = formData.get("price")?.toString().trim();
    const category = formData.get("category")?.toString().trim();
    const imageFile = formData.get("image");
    const hasSpecial = formData.has("isSpecial");
    const hasNew = formData.has("isNew") || formData.has("isItemNew");
    const hasAvailable = formData.has("isAvailable");
    const hasFasting = formData.has("isFasting");
    const hasNonFasting = formData.has("isNonFasting");
    const update = {};
    if (imageFile && typeof imageFile === "object" && "arrayBuffer" in imageFile && imageFile.size > 0) {
      try {
        update.imageUrl = await uploadToCloudinary(imageFile);
        update.image = update.imageUrl;
      } catch (err) {
        return { success: false, error: `Image upload failed: ${err.message}` };
      }
    }
    if (priceRaw !== undefined && priceRaw !== null && priceRaw !== "") {
      const price = Number(priceRaw);
      if (!Number.isFinite(price) || price < 0) return { success: false, error: "Price must be non-negative" };
      update.price = Math.round(price * 100) / 100;
    }
    const { MenuItem, Category } = await getDbModels();
    let existing = null;
    try {
      existing = await MenuItem.findById(id).lean();
    } catch {}
    if (!existing) return { success: false, error: "Item not found" };
    const exName = existing.name || {};
    const isLocalized = typeof exName === "object" && (exName.en || exName.am || exName.om);
    const baseEn = isLocalized ? (exName.en || "") : (typeof exName === "string" ? exName : "");
    const baseAm = isLocalized ? (exName.am || "") : baseEn;
    const baseOm = isLocalized ? (exName.om || "") : baseEn;
    const anyNameProvided = formData.has("nameEn") || formData.has("nameAm") || formData.has("nameOm");
    if (anyNameProvided) {
      const finalEn = formData.get("nameEn")?.toString().trim() || baseEn;
      const finalAm = formData.get("nameAm")?.toString().trim() || baseAm;
      const finalOm = formData.get("nameOm")?.toString().trim() || baseOm;
      if (finalEn || finalAm || finalOm) {
        update.name = { en: finalEn || baseEn, am: finalAm || baseAm, om: finalOm || baseOm };
      }
    }
    const exDesc = existing.description || {};
    const isDescLoc = typeof exDesc === "object" && (exDesc.en || exDesc.am || exDesc.om);
    const baseDescEn = isDescLoc ? (exDesc.en || "") : (typeof exDesc === "string" ? exDesc : "");
    const baseDescAm = isDescLoc ? (exDesc.am || "") : baseDescEn;
    const baseDescOm = isDescLoc ? (exDesc.om || "") : baseDescEn;
    const anyDescProvided = formData.has("descriptionEn") || formData.has("descriptionAm") || formData.has("descriptionOm");
    if (anyDescProvided) {
      const finalDE = formData.get("descriptionEn")?.toString().trim();
      const finalDA = formData.get("descriptionAm")?.toString().trim();
      const finalDO = formData.get("descriptionOm")?.toString().trim();
      if (finalDE === "" && finalDA === "" && finalDO === "") {
        // keep as is
      } else {
        update.description = {
          en: finalDE !== undefined && finalDE !== "" ? finalDE : baseDescEn,
          am: finalDA !== undefined && finalDA !== "" ? finalDA : baseDescAm,
          om: finalDO !== undefined && finalDO !== "" ? finalDO : baseDescOm,
        };
      }
      if (formData.get("descriptionEn") != null) {
        const v = formData.get("descriptionEn").toString().trim();
        if (v) update.description = { ...update.description, en: v };
      }
      if (formData.get("descriptionAm") != null) {
        const v = formData.get("descriptionAm").toString().trim();
        if (v) update.description = { ...update.description, am: v };
      }
      if (formData.get("descriptionOm") != null) {
        const v = formData.get("descriptionOm").toString().trim();
        if (v) update.description = { ...update.description, om: v };
      }
      if (update.description) {
        update.description = {
          en: update.description.en ?? baseDescEn,
          am: update.description.am ?? baseDescAm,
          om: update.description.om ?? baseDescOm,
        };
      }
    }
    if (category) {
      let catDoc = await Category.findById(category).lean().catch(() => null);
      if (!catDoc) catDoc = await Category.findOne({ slug: category }).lean().catch(() => null);
      if (!catDoc) return { success: false, error: "Category not found" };
      update.category = catDoc._id;
      update.categoryId = catDoc._id;
      const catStation = catDoc.targetStation ? catDoc.targetStation : (catDoc.type === "DRINK" || /drink|barista|juice|coffee|beer|wine/i.test(catDoc.name?.en || catDoc.slug || "")) ? "BARISTA" : "KITCHEN";
      update.categoryType = catStation === "BARISTA" ? "DRINK" : "FOOD";
      update.station = catStation;
      update.targetStation = catStation;
    }
    // Explicit targetStation override for reports routing (Foods/Drinks toggle)
    const rawStationUpd = formData.get("targetStation")?.toString().trim().toUpperCase();
    if (rawStationUpd === "KITCHEN" || rawStationUpd === "BARISTA") {
      update.targetStation = rawStationUpd;
      update.station = rawStationUpd;
      update.categoryType = rawStationUpd === "BARISTA" ? "DRINK" : "FOOD";
    }
    if (hasSpecial) update.isSpecial = parseBool(formData.get("isSpecial"));
    if (hasNew) update.isNew = parseBool(formData.get("isNew") || formData.get("isItemNew") || formData.get("isPopular"));
    if (update.isNew !== undefined) {
      update.isItemNew = update.isNew;
      update.isPopular = update.isNew;
    }
    if (hasAvailable) {
      update.isAvailable = parseBool(formData.get("isAvailable"));
      update.inStock = update.isAvailable;
    }
    if (hasFasting) update.isFasting = parseBool(formData.get("isFasting"));
    if (hasNonFasting) update.isNonFasting = parseBool(formData.get("isNonFasting"));
    const res = await MenuItem.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: false });
    if (!res) return { success: false, error: "Failed to update — not found" };
    revalidateAll();
    return { success: true, message: "Menu item updated", itemId: String(res._id) };
  } catch (e) {
    return { success: false, error: e.message || "Failed to update menu item" };
  }
}

export async function deleteMenuItem(formDataOrId) {
  const authErr = await assertManager();
  if (authErr) return authErr;
  const id = typeof formDataOrId === "string" ? formDataOrId : formDataOrId.get("id")?.toString() || formDataOrId.get("_id")?.toString() || formDataOrId.get("itemId")?.toString();
  if (!id) return { success: false, error: "Item id required" };
  try {
    const { MenuItem } = await getDbModels();
    const res = await MenuItem.deleteOne({ _id: id });
    if (res.deletedCount === 0) return { success: false, error: "Item not found" };
    revalidateAll();
    return { success: true, message: "Menu item deleted" };
  } catch (e) {
    return { success: false, error: e.message || "Failed to delete menu item" };
  }
}

export const createMenuCategory = createCategory;
export const updateMenuCategory = updateCategory;
export const deleteMenuCategory = deleteCategory;
