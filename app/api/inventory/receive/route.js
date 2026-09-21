import { connectToDatabase } from "@/lib/mongodb";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { sanitizeString, OBJECTID_RE } from "@/lib/validate";
import { receiveInventory, isReceiveServiceError } from "@/lib/inventoryReceiveService";

export const dynamic = "force-dynamic";

// POST /api/inventory/receive { itemId, quantity, unitCost, unit?, notes?, supplier? } — MANAGER only
async function postHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "inventory:mutate")) return fail("Forbidden: requires MANAGER", 403);

  const len = request.headers.get("content-length");
  if (len && Number(len) > 50 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Invalid request body: expected JSON object", 400);
  }

  // Validate itemId
  const rawItemId = body.itemId ?? body.item ?? body.inventoryItemId;
  const itemId = rawItemId != null ? String(rawItemId).trim() : "";
  if (!itemId) return fail("itemId is required", 400);
  if (!OBJECTID_RE.test(itemId)) return fail("itemId must be valid ObjectId", 400);

  // Validate quantity
  const rawQty = body.quantity ?? body.qty;
  if (rawQty == null || String(rawQty).trim() === "") return fail("quantity is required", 400);
  if (Array.isArray(rawQty) || (typeof rawQty === "object" && rawQty !== null) || typeof rawQty === "boolean") {
    return fail("quantity must be number > 0", 400);
  }
  const quantity = Number(rawQty);
  if (!Number.isFinite(quantity) || quantity <= 0) return fail("quantity must be number > 0", 400);

  // Validate unitCost
  const rawCost = body.unitCost ?? body.cost ?? body.price;
  if (rawCost == null || String(rawCost).trim() === "") return fail("unitCost is required", 400);
  if (Array.isArray(rawCost) || (typeof rawCost === "object" && rawCost !== null) || typeof rawCost === "boolean") {
    return fail("unitCost must be number >= 0", 400);
  }
  const unitCost = Number(rawCost);
  if (!Number.isFinite(unitCost) || unitCost < 0) return fail("unitCost must be number >= 0", 400);
  const roundedUnitCost = Math.round(unitCost * 100) / 100;

  // Validate unit (optional, must match item's unit if provided)
  let unit = null;
  if (body.unit != null && String(body.unit).trim() !== "") {
    const u = sanitizeString(body.unit, { maxLen: 50 });
    if (!u) return fail("unit must be 1-50 chars", 400);
    unit = u;
  }

  // Validate notes
  const notes = body.notes != null ? String(body.notes).trim().slice(0, 500) : "";
  if (body.notes != null && /<script/i.test(notes)) return fail("notes contains invalid characters", 400);

  // Validate supplier (optional, if provided must be valid ObjectId)
  let supplier = null;
  if (body.supplier != null && String(body.supplier).trim() !== "") {
    const s = String(body.supplier).trim();
    if (!OBJECTID_RE.test(s)) return fail("supplier must be valid ObjectId if provided", 400);
    supplier = s;
  }

  // Validate idempotencyKey — required, UUID, prefer Idempotency-Key header, optionally body.idempotencyKey
  const headerKey = request.headers.get("idempotency-key") || request.headers.get("Idempotency-Key");
  const rawIdempotencyKey = headerKey != null && String(headerKey).trim() !== "" ? String(headerKey).trim() : (body.idempotencyKey != null ? String(body.idempotencyKey).trim() : "");
  if (!rawIdempotencyKey) return fail("Idempotency-Key is required", 400);
  const idempotencyKey = sanitizeString(rawIdempotencyKey, { maxLen: 64 });
  if (!idempotencyKey) return fail("Idempotency-Key is required", 400);
  // UUID v4 format (8-4-4-4-12 hex) - allow generic UUID for flexibility
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SIMPLE_UUID_RE = /^[a-fA-F0-9\-]{8,64}$/;
  if (!UUID_RE.test(idempotencyKey) && !SIMPLE_UUID_RE.test(idempotencyKey)) {
    // Enforce at least UUID-like: 36 chars with hyphens, or 32 hex
    if (idempotencyKey.length < 8 || idempotencyKey.length > 64) return fail("Idempotency-Key must be 8-64 chars", 400);
  }
  if (idempotencyKey.length < 8) return fail("Idempotency-Key must be at least 8 chars", 400);

  const conn = await connectToDatabase();

  try {
    const result = await receiveInventory(conn, {
      itemId,
      quantity,
      roundedUnitCost,
      unit,
      notes,
      supplier,
      idempotencyKey,
      actor: { staffId: auth.payload.staffId || null, role: auth.payload.role || null },
    });
    return ok(result.data, result.status);
  } catch (err) {
    if (isReceiveServiceError(err)) {
      return fail(err.message, err.status);
    }
    if (isDbError(err)) throw err;
    throw err;
  }
}

export const POST = withApi(postHandler);
