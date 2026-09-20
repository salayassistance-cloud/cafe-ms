import { connectToDatabase } from "@/lib/mongodb";
import { getInventoryAuditModel } from "@/lib/models/InventoryAudit";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { validateObjectId, sanitizeString, validateDateString } from "@/lib/validate";

export const dynamic = "force-dynamic";

// GET /api/inventory/audits?item=&action=&actor=&from=&to=&limit=
// Read only — MANAGER only, supports item/action/actor filters + date range
async function getHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "inventory:read")) return fail("Forbidden: requires MANAGER", 403);

  const { searchParams } = new URL(request.url);
  const rawItem = searchParams.get("item") || searchParams.get("itemId");
  const rawAction = searchParams.get("action");
  const rawActor = searchParams.get("actor") || searchParams.get("actorId");
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  const rawLimit = searchParams.get("limit");

  const query = {};

  if (rawItem) {
    const sid = sanitizeString(rawItem, { maxLen: 50 });
    if (!sid || !validateObjectId(sid)) return fail("Invalid item filter: must be ObjectId", 400);
    query.item = sid;
  }

  if (rawAction) {
    const act = sanitizeString(rawAction, { maxLen: 30 });
    const allowed = ["ITEM_CREATED", "ITEM_UPDATED", "WASTE"];
    const norm = String(act || "").trim().toUpperCase();
    // Support legacy aliases
    const map = { CREATE_ITEM: "ITEM_CREATED", UPDATE_ITEM: "ITEM_UPDATED" };
    const canon = map[norm] || norm;
    if (!allowed.includes(canon)) return fail(`Invalid action filter: must be one of ${allowed.join(", ")}`, 400);
    query.action = canon;
  }

  if (rawActor) {
    const aid = sanitizeString(rawActor, { maxLen: 50 });
    if (!aid || !validateObjectId(aid)) return fail("Invalid actor filter: must be ObjectId", 400);
    query.actorId = aid;
  }

  let fromDate = null;
  let toDate = null;
  if (rawFrom) {
    const ds = sanitizeString(rawFrom, { maxLen: 20 });
    if (!ds || !validateDateString(ds)) return fail("Invalid from date (use YYYY-MM-DD)", 400);
    const d = new Date(ds);
    d.setHours(0, 0, 0, 0);
    fromDate = d;
  }
  if (rawTo) {
    const ds = sanitizeString(rawTo, { maxLen: 20 });
    if (!ds || !validateDateString(ds)) return fail("Invalid to date (use YYYY-MM-DD)", 400);
    const d = new Date(ds);
    d.setHours(23, 59, 59, 999);
    toDate = d;
  }
  if (fromDate && toDate && fromDate > toDate) return fail("from date must be before to date", 400);
  if (fromDate || toDate) {
    query.createdAt = {};
    if (fromDate) query.createdAt.$gte = fromDate;
    if (toDate) query.createdAt.$lte = toDate;
  }

  let limit = 100;
  if (rawLimit != null) {
    const n = Number(rawLimit);
    if (Number.isInteger(n) && n > 0 && n <= 200) limit = n;
    else if (rawLimit.trim() !== "") return fail("limit must be integer 1-200", 400);
  }

  try {
    const conn = await connectToDatabase();
    const InventoryAudit = getInventoryAuditModel(conn);
    const docs = await InventoryAudit.find(query)
      .select("item action actorId actorRole quantityDelta beforeStock afterStock reason correlationId beforeSnapshot afterSnapshot createdAt updatedAt")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const audits = docs.map((d) => ({
      _id: String(d._id),
      id: String(d._id),
      item: d.item ? String(d.item) : null,
      action: d.action,
      actorId: d.actorId ? String(d.actorId) : null,
      actorRole: d.actorRole || null,
      quantityDelta: d.quantityDelta != null ? Number(d.quantityDelta) : null,
      beforeStock: d.beforeStock != null ? Number(d.beforeStock) : null,
      afterStock: d.afterStock != null ? Number(d.afterStock) : null,
      reason: d.reason || "",
      correlationId: d.correlationId ? String(d.correlationId) : null,
      beforeSnapshot: d.beforeSnapshot || null,
      afterSnapshot: d.afterSnapshot || null,
      createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
      updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
    }));

    return ok({ count: audits.length, audits }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] inventory audits GET error:", err);
    return fail("Failed to load inventory audits", 500);
  }
}

export const GET = withApi(getHandler);
