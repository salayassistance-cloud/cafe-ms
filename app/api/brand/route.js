import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { connectToDatabase } from "@/lib/mongodb";
import { getBrandConfigModel } from "@/lib/models/BrandConfig";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";

export const dynamic = "force-dynamic";

const DEFAULT_BRAND = { name: "I HOPE CAFE", logoPath: "" };

function serialize(doc) {
  return {
    name: doc?.name || DEFAULT_BRAND.name,
    logoPath: doc?.logoPath || DEFAULT_BRAND.logoPath,
  };
}

// GET /api/brand — public read of the single brand config.
async function getHandler(request) {
  const rl = checkRateLimit(request, { key: "brand_read", ...RATE_LIMITS.GENERAL });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  try {
    const conn = await connectToDatabase();
    const BrandConfig = getBrandConfigModel(conn);
    const doc = await BrandConfig.findOne({}).lean();
    return ok({ brand: serialize(doc) }, 200);
  } catch (e) {
    if (isDbError(e)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] brand GET error:", e?.message || e);
    return fail("Failed to load brand settings.", 500);
  }
}

// POST / PUT /api/brand — manager-only upsert of the single config.
async function saveHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  const rl = checkRateLimit(request, { key: "brand_write", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid JSON body", 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const logoPath = typeof body.logoPath === "string" ? body.logoPath.trim() : "";
  if (!name) return fail("Brand name is required", 400);
  try {
    const conn = await connectToDatabase();
    const BrandConfig = getBrandConfigModel(conn);
    const doc = await BrandConfig.findOneAndUpdate(
      {},
      { name, logoPath },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    return ok({ brand: serialize(doc) }, 200);
  } catch (e) {
    if (isDbError(e)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] brand save error:", e?.message || e);
    return fail("Failed to save brand settings.", 500);
  }
}

export const GET = withApi(getHandler);
export const POST = withApi(saveHandler);
export const PUT = withApi(saveHandler);
