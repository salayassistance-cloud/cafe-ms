import { connectToDatabase } from "@/lib/mongodb";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { createInventoryAudit } from "@/lib/inventoryAuditService";
import { requireAuth } from "@/lib/security";
import { can } from "@/lib/policy";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { validateInventoryItemUpdate } from "@/lib/inventoryValidation";
import { serializeInventoryItem } from "@/lib/inventoryService";
import { validateObjectId, sanitizeString } from "@/lib/validate";

export const dynamic = "force-dynamic";

// PATCH /api/inventory/items/[id]
// Update allowed fields: name, category, unit, minimumStock, cost, status, supplier — MANAGER only
async function patchHandler(request, { params }) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  if (!can(auth.payload.role, "inventory:mutate")) return fail("Forbidden: requires MANAGER", 403);

  const { id } = await params;
  const sanitizedId = sanitizeString(id, { maxLen: 50 });
  if (!sanitizedId || !validateObjectId(sanitizedId)) return fail("Invalid inventory item id", 400);

  const len = request.headers.get("content-length");
  if (len && Number(len) > 50 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Invalid request body", 400);
  }

  const validated = validateInventoryItemUpdate(body);
  if (!validated.ok) return fail(validated.error, 400);

  const conn = await connectToDatabase();
  const session = await conn.startSession();
  try {
    session.startTransaction();
    const InventoryItem = getInventoryItemModel(conn);
    // Capture before snapshot for audit (inside transaction for consistency)
    const beforeDoc = await InventoryItem.findById(sanitizedId).session(session).lean();
    if (!beforeDoc) {
      try {
        await session.abortTransaction();
      } catch {}
      return fail("Inventory item not found", 404);
    }

    const doc = await InventoryItem.findOneAndUpdate(
      { _id: sanitizedId },
      { $set: { ...validated.data, updatedAt: new Date() } },
      { new: true, runValidators: true, session }
    ).lean();
    if (!doc) {
      try {
        await session.abortTransaction();
      } catch {}
      return fail("Inventory item not found", 404);
    }

    // H7.2 audit trail — via shared service (actor from session, atomic)
    // H7.3 cost history — via COST_UPDATED when persisted cost actually changes
    try {
      const changedFields = Object.keys(validated.data);
      const reason = `Updated ${changedFields.join(", ")}`;
      const beforeSnap = {
        name: beforeDoc.name,
        category: beforeDoc.category,
        unit: beforeDoc.unit,
        currentStock: Number(beforeDoc.currentStock) || 0,
        minimumStock: Number(beforeDoc.minimumStock) || 0,
        cost: Number(beforeDoc.cost) || 0,
        status: beforeDoc.status,
        supplier: beforeDoc.supplier ? String(beforeDoc.supplier) : null,
      };
      const afterSnap = {
        name: doc.name,
        category: doc.category,
        unit: doc.unit,
        currentStock: Number(doc.currentStock) || 0,
        minimumStock: Number(doc.minimumStock) || 0,
        cost: Number(doc.cost) || 0,
        status: doc.status,
        supplier: doc.supplier ? String(doc.supplier) : null,
      };
      await createInventoryAudit(
        conn,
        {
          itemId: String(doc._id),
          action: "ITEM_UPDATED",
          actorId: auth.payload.staffId || null,
          actorRole: auth.payload.role || null,
          quantityDelta: null,
          beforeStock: Number(beforeDoc.currentStock) || 0,
          afterStock: Number(doc.currentStock) || 0,
          reason: reason.slice(0, 500),
          correlationId: null,
          beforeSnapshot: beforeSnap,
          afterSnapshot: afterSnap,
        },
        { session }
      );

      // H7.3: record explicit cost change only when persisted cost differs (rounded to 2 decimals per validation)
      const oldCostRaw = beforeDoc.cost;
      const newCostRaw = doc.cost;
      const oldCost = oldCostRaw != null ? Math.round(Number(oldCostRaw) * 100) / 100 : 0;
      const newCost = newCostRaw != null ? Math.round(Number(newCostRaw) * 100) / 100 : 0;
      const costChanged = Number.isFinite(oldCost) && Number.isFinite(newCost) && oldCost !== newCost;
      if (costChanged) {
        await createInventoryAudit(
          conn,
          {
            itemId: String(doc._id),
            action: "COST_UPDATED",
            actorId: auth.payload.staffId || null,
            actorRole: auth.payload.role || null,
            oldCost: oldCost,
            newCost: newCost,
            reason: `Cost updated from ${oldCost} to ${newCost}`.slice(0, 500),
            correlationId: null,
            beforeSnapshot: null,
            afterSnapshot: null,
          },
          { session }
        );
      }
    } catch (auditErr) {
      try {
        await session.abortTransaction();
      } catch {}
      throw auditErr;
    }

    await session.commitTransaction();
    return ok({ item: serializeInventoryItem(doc) }, 200);
  } catch (err) {
    try {
      await session.abortTransaction();
    } catch {}
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    if (err && err.code === 11000) return fail("Inventory item already exists", 409);
    console.error("[api] inventory items PATCH error:", err);
    return fail(err?.message || "Failed to update inventory item", 500);
  } finally {
    try {
      await session.endSession();
    } catch {}
  }
}

export const PATCH = withApi(patchHandler);
