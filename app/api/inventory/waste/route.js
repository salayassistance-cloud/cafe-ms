import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { createWasteMovement } from "@/lib/inventoryWasteService";

export const dynamic = "force-dynamic";

// POST /api/inventory/waste { itemId, quantity, notes } — MANAGER only
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

  const itemId = String(body.itemId || "").trim();
  const quantity = body.quantity;
  const notes = body.notes != null ? String(body.notes).trim().slice(0, 500) : "";

  if (!itemId) return fail("itemId is required", 400);
  if (!mongoose.isValidObjectId(itemId)) return fail("Invalid itemId: must be valid ObjectId", 400);
  if (quantity == null || String(quantity).trim() === "") return fail("quantity is required", 400);
  // H7.1: strict finite numeric >0 validation at API boundary (rejects NaN/Infinity/0/negative/non-numeric/boolean/array/object)
  // Preserve service as source of truth; this early check mirrors createWasteMovement rules and avoids DB round-trip.
  {
    if (Array.isArray(quantity) || (quantity != null && typeof quantity === "object") || typeof quantity === "boolean") {
      return fail("quantity must be number > 0", 400);
    }
    const qtyNum = Number(quantity);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) return fail("quantity must be number > 0", 400);
  }

  try {
    const conn = await connectToDatabase();
    const result = await createWasteMovement(conn, {
      itemId,
      quantity,
      notes,
      actorId: auth.payload.staffId || null,
      actorRole: auth.payload.role || null,
    });
    return ok(result, 201);
  } catch (err) {
    if (err && err.status === 400) return fail(err.message, 400);
    if (err && err.status === 404) return fail(err.message, 404);
    if (err && err.status === 409) return fail(err.message, 409);
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] inventory waste POST error:", err);
    return fail(err?.message || "Failed to record waste", 500);
  }
}

export const POST = withApi(postHandler);
