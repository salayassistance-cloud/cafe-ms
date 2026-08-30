import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { getUnifiedMenu } from "@/lib/menuService";
import { sanitizeString } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
const LANGS = new Set(["am","en","om"]);

// Delegates DB fetch/serialization to lib/menuService (canonical). This route only
// handles HTTP concerns: validation, category/lang filtering, and shaping the
// response envelope. No direct Category/MenuItem queries here — service is the
// single source for alias resolution (category/categoryId, image/imageUrl, etc.).

async function getHandler(request) {
  const rl = checkRateLimit(request, { key: "menu", ...RATE_LIMITS.MENU });
  if (!rl.ok) {
    const res = fail("Too many menu requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  const { searchParams } = new URL(request.url);
  const rawLang = searchParams.get("lang");
  const rawCat = searchParams.get("category");
  // A real-time (SSE menu-changed) refresh passes fresh=1 so this response is NOT
  // cached (defeats the public,s-maxage=60 set by next.config / below) and always
  // returns authoritative DB data. Normal initial loads omit it and stay cacheable.
  const freshRead = searchParams.get("fresh") === "1";
  const lang = rawLang && LANGS.has(rawLang.trim().toLowerCase()) ? rawLang.trim().toLowerCase() : "en";
  // Sanitize category - prevent injection via overly long or script tag values
  let category = "all";
  if (rawCat) {
    const sanitized = sanitizeString(rawCat, { maxLen: 100, allowEmpty: true });
    if (sanitized && sanitized.length > 0) {
      // Allow ObjectId or slug - slug: lowercase alphanum + dash
      if (/^[a-fA-F0-9]{24}$/.test(sanitized) || /^[a-z0-9\-_]+$/i.test(sanitized) || sanitized === "all" || sanitized === "ALL") {
        category = sanitized;
      } else {
        // Fallback: treat as slug but sanitize
        category = sanitized.replace(/[^a-zA-Z0-9\-_]/g, "").slice(0, 50) || "all";
      }
    }
  }
  const includeUnavailable = searchParams.get("all") === "true" || searchParams.get("includeUnavailable") === "true";
  try {
    const data = await getUnifiedMenu({ includeUnavailable });
    let { categories, items } = data;

    // Category filter (ObjectId or slug)
    if (category !== "all" && category !== "ALL") {
      const catById = new Map(categories.map((c) => [String(c._id || c.id), c]));
      const bySlug = categories.find((c) => c.slug === String(category));
      let filterCatId = null;
      if (catById.has(String(category))) filterCatId = String(category);
      else if (bySlug) filterCatId = String(bySlug._id || bySlug.id);
      else filterCatId = String(category);
      items = items.filter((it) => String(it.categoryId || it.category) === filterCatId);
    }

    // Lang-specific shaping — preserves the legacy payload exactly so WaiterUI
    // polling diff does not break. menuService is canonical; this mapping keeps
    // the HTTP contract stable while centralizing alias logic.
    categories = categories.map((c) => {
      const nameObj = c.nameObj && typeof c.nameObj === "object" ? c.nameObj : { en: c.name, am: c.nameAmharic || c.name, om: c.nameOm || c.name };
      const localizedCat = nameObj[lang] || (lang === "am" ? nameObj.am : lang === "om" ? nameObj.om : nameObj.en) || c.name || "";
      // Preserve original multilingual object under nameObj; displayName is localized per lang
      return {
        ...c,
        displayName: localizedCat,
        categoryNameLocalized: localizedCat,
      };
    });
    items = items.map((it) => {
      const localizedTitle = lang === "am" ? it.titleAmharic || it.title : lang === "om" ? it.titleOm || it.title : it.title;
      const descObjOriginal = it.description && typeof it.description === "object" ? it.description : { en: typeof it.description === "string" ? it.description : it.descriptionEn || "" , am: it.descriptionAm || "", om: it.descriptionOm || "" };
      const descLocalized = descObjOriginal[lang] || (lang === "am" ? descObjOriginal.am : lang === "om" ? descObjOriginal.om : descObjOriginal.en) || descObjOriginal.en || descObjOriginal.am || descObjOriginal.om || "";
      return {
        ...it,
        titleLocalized: localizedTitle,
        // Preserve original multilingual object; legacy `description` is localized string per lang
        description: descLocalized,
        descriptionObj: descObjOriginal,
        // ensure legacy aliases mirror canonical
        displayName: localizedTitle,
      };
    });

    const res = ok({ categories, items }, 200);
    // Phase 5: menu is static (CRUD rare) — allow CDN/browser cache 60s, SWR 300s
    // for NORMAL loads. A real-time refresh (fresh=1) must return authoritative DB
    // data, so it is served no-store and bypasses the 60s cache entirely.
    try {
      if (freshRead) {
        res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      } else {
        res.headers.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
        res.headers.set("CDN-Cache-Control", "public, s-maxage=60");
        res.headers.set("Vercel-CDN-Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
      }
    } catch {}
    return res;
  } catch (e) {
    if (isDbError(e)) {
      return fail("Database connection error. Please retry shortly.", 503);
    }
    console.error("[api] menu error:", e?.message || e);
    // Don't leak stack - return empty but log
    return fail("Failed to load menu. Please retry.", 500);
  }
}

export const GET = withApi(getHandler);
