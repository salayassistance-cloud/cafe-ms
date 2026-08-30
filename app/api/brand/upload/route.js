import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { connectToDatabase } from "@/lib/mongodb";
import { getBrandConfigModel } from "@/lib/models/BrandConfig";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";
import { uploadToCloudinary } from "@/lib/cloudinary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EXT_BY_TYPE = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

const MAX_BYTES = 5 * 1024 * 1024;

// Verify the real file content matches the resolved extension. Mobile clients
// often send an empty or mismatched MIME type, so acceptance is based on the
// resolved extension (type map or filename) plus an actual byte-signature check
// — this keeps spoofed/renamed uploads (e.g. an .exe named .png) rejected.
function isAllowedImageContent(ext, buf) {
  const head = buf.subarray(0, 12);
  switch (ext) {
    case "png":
      return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47; // ‰PNG
    case "jpg":
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff; // ÿØÿ
    case "gif":
      return head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46; // GIF
    case "webp":
      return (
        head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && // RIFF
        head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50 // WEBP
      );
    case "svg": {
      const s = buf.toString("utf8", 0, Math.min(buf.length, 512)).toLowerCase();
      return s.includes("<svg") || s.trimStart().startsWith("<?xml");
    }
    default:
      return false;
  }
}

// POST /api/brand/upload — manager-only. Receives an image via FormData,
// stores it via Cloudinary (same backend as menu item images) so the logo is
// persistent and reliable even where the server filesystem is read-only or
// ephemeral (e.g. serverless), then updates the single BrandConfig record's
// logoPath and returns the public URL so the logo shows on /menu.
async function postHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);

  const rl = checkRateLimit(request, { key: "brand_upload", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return fail("No image file provided", 400);

    // Resolve a candidate extension from the declared MIME type or the filename.
    // We no longer require file.type to be in a fixed allow-list, because mobile
    // pickers commonly send an empty or mismatched MIME for valid images.
    let ext = EXT_BY_TYPE[file.type];
    if (!ext && file.name) {
      const m = file.name.toLowerCase().match(/\.(png|jpe?g|webp|gif|svg)$/);
      if (m) ext = m[1] === "jpg" ? "jpg" : m[1];
    }
    if (!ext) {
      return fail("Only image files (PNG, JPG, WEBP, GIF, SVG) are allowed", 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length === 0) return fail("Uploaded file is empty", 400);
    if (buf.length > MAX_BYTES) return fail("Image is too large (max 5MB)", 400);
    if (!isAllowedImageContent(ext, buf)) {
      return fail("Only image files (PNG, JPG, WEBP, GIF, SVG) are allowed", 400);
    }

    // Store via Cloudinary (same backend as menu item images). This keeps the
    // logo persistent and reliable across deployments where the local filesystem
    // is read-only/ephemeral (serverless) and avoids raw-multipart body-size
    // limits on the filesystem write. Spoofed/unsupported bytes were already
    // rejected by isAllowedImageContent above; Cloudinary also enforces 5MB.
    const logoPath = await uploadToCloudinary(file, { folder: "brand" });
    const conn = await connectToDatabase();
    const BrandConfig = getBrandConfigModel(conn);
    const doc = await BrandConfig.findOneAndUpdate(
      {},
      { logoPath },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );

    return ok(
      { logoPath, brand: { name: doc?.name || "", logoPath: doc?.logoPath || "" } },
      200
    );
  } catch (e) {
    if (isDbError(e)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] brand upload error:", e?.message || e);
    return fail("Failed to upload logo.", 500);
  }
}

export const POST = withApi(postHandler);
