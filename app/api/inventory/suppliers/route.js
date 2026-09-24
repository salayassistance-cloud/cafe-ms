import { connectToDatabase } from "@/lib/mongodb";
import { getSupplierModel } from "@/lib/models/Supplier";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { validateSupplierCreate } from "@/lib/inventoryValidation";
import { serializeSupplier } from "@/lib/inventoryService";

export const dynamic = "force-dynamic";

// GET /api/inventory/suppliers
// List suppliers — MANAGER only
async function getHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  if (!can(auth.payload.role, "inventory:read")) return fail("Forbidden: requires MANAGER", 403);

  try {
    const conn = await connectToDatabase();
    const Supplier = getSupplierModel(conn);
    const docs = await Supplier.find({})
      .select("name contact address status createdAt updatedAt")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    const suppliers = docs.map(serializeSupplier);
    return ok({ count: suppliers.length, suppliers }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] inventory suppliers GET error:", err);
    return fail("Failed to load suppliers", 500);
  }
}

// POST /api/inventory/suppliers
// Create supplier — MANAGER only, requires name
async function postHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  if (!can(auth.payload.role, "inventory:mutate")) return fail("Forbidden: requires MANAGER", 403);

  const len = request.headers.get("content-length");
  if (len && Number(len) > 50 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Invalid request body: expected JSON object", 400);
  }

  const validated = validateSupplierCreate(body);
  if (!validated.ok) return fail(validated.error, 400);

  try {
    const conn = await connectToDatabase();
    const Supplier = getSupplierModel(conn);
    const doc = new Supplier(validated.data);
    await doc.save();
    return ok({ supplier: serializeSupplier(doc) }, 201);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    if (err && err.code === 11000) return fail("Supplier with this name already exists", 409);
    console.error("[api] inventory suppliers POST error:", err);
    return fail(err?.message || "Failed to create supplier", 500);
  }
}

export const GET = withApi(getHandler);
export const POST = withApi(postHandler);
