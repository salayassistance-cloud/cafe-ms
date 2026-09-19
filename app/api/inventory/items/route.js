import { connectToDatabase } from "@/lib/mongodb";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { validateInventoryItemCreate } from "@/lib/inventoryValidation";
import { serializeInventoryItem } from "@/lib/inventoryService";
import { sanitizeString } from "@/lib/validate";

export const dynamic = "force-dynamic";

// GET /api/inventory/items?category=&status=
// List inventory items — MANAGER only, supports category/status filters
async function getHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "inventory:read")) return fail("Forbidden: requires MANAGER", 403);

  const { searchParams } = new URL(request.url);
  const rawCategory = searchParams.get("category");
  const rawStatus = searchParams.get("status");

  const query = {};
  if (rawCategory) {
    const cat = sanitizeString(rawCategory, { maxLen: 100, allowEmpty: true });
    if (cat) query.category = cat;
  }
  if (rawStatus) {
    const st = String(rawStatus).trim();
    const allowed = ["In Stock", "Low Stock", "Out Of Stock"];
    if (allowed.includes(st)) query.status = st;
    else if (st.length > 0) return fail(`Invalid status filter: ${st}`, 400);
  }

  try {
    const conn = await connectToDatabase();
    const InventoryItem = getInventoryItemModel(conn);
    const docs = await InventoryItem.find(query)
      .select("name category unit currentStock minimumStock cost supplier status createdAt updatedAt")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    const items = docs.map(serializeInventoryItem);
    return ok({ count: items.length, items }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] inventory items GET error:", err);
    return fail("Failed to load inventory items", 500);
  }
}

// POST /api/inventory/items
// Create inventory item — MANAGER only, requires name, category, unit
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

  const validated = validateInventoryItemCreate(body);
  if (!validated.ok && validated.error) return fail(validated.error, 400);
  if (!validated.ok) return fail("Validation failed", 400);

  try {
    const conn = await connectToDatabase();
    const InventoryItem = getInventoryItemModel(conn);
    const doc = new InventoryItem(validated.data);
    await doc.save();
    return ok({ item: serializeInventoryItem(doc) }, 201);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    if (err && err.code === 11000) return fail("Inventory item already exists", 409);
    console.error("[api] inventory items POST error:", err);
    return fail(err?.message || "Failed to create inventory item", 500);
  }
}

export const GET = withApi(getHandler);
export const POST = withApi(postHandler);
