import { v2 as cloudinary } from "cloudinary";

// Cloudinary configuration — uses MONGODB_URI-style env naming per spec
// NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME is client-safe, but server also needs secret.
// Falls back to allow build-time without env (upload will throw at runtime).

const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

if (cloudName && apiKey && apiSecret) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
}

/**
 * Upload a File / Blob / Buffer to Cloudinary and return secure_url.
 * Accepts browser File from FormData (via arrayBuffer) or Node Buffer.
 * Uses unsigned folder `menu_items` for organization.
 */
export async function uploadToCloudinary(file, options = {}) {
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary credentials missing — check .env.local");
  }
  if (!file) throw new Error("No file provided for upload");

  // Normalize to Buffer + mime
  let buffer;
  let mime = "image/jpeg";

  if (file instanceof Buffer) {
    buffer = file;
  } else if (typeof file.arrayBuffer === "function") {
    // Browser File / Blob
    const ab = await file.arrayBuffer();
    buffer = Buffer.from(ab);
    if (file.type) mime = file.type;
  } else if (typeof file === "string" && file.startsWith("data:")) {
    // data URL
    return file;
  } else {
    throw new Error("Unsupported file type for Cloudinary upload");
  }

  if (buffer.length === 0) throw new Error("Empty file");
  // 5MB limit — protect against OOM
  if (buffer.length > 5 * 1024 * 1024) throw new Error("Image too large (max 5MB)");

  // Validate mime is image
  if (!mime.startsWith("image/")) {
    throw new Error("Only image uploads allowed");
  }

  const base64 = `data:${mime};base64,${buffer.toString("base64")}`;

  const result = await cloudinary.uploader.upload(base64, {
    folder: options.folder || "menu_items",
    resource_type: "image",
    transformation: options.transformation || [{ width: 800, height: 800, crop: "limit", quality: "auto" }],
  });

  return result.secure_url;
}

export default cloudinary;
