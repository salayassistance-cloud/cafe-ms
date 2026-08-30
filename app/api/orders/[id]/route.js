import { connectToDatabase } from "@/lib/mongodb";
import mongoose from "mongoose";
import { getOrderModel } from "@/lib/models/Order";
import {
  updateOrderStatus,
  updatePayment,
  serveOrder,
  payOrder,
  cancelOrder,
  archiveOrder,
  toKdsShape,
} from "@/lib/orderService";
import { publish } from "@/lib/eventHub";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { cookies } from "next/headers";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/sessionCrypto";
import { requireAuth } from "@/lib/security";
import { can, canTransition } from "@/lib/policy";
import { validateOrderStatusUpdate, sanitizeString } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

function buildQuery(id) {
  return mongoose.isValidObjectId(id)
    ? { $or: [{ orderNumber: id }, { _id: id }] }
    : { orderNumber: id };
}

// Map service-layer failures to clean HTTP responses. Unknown errors are
// logged server-side and returned as a generic 500 (internal details never
// leak to the client) — the KDS/Waiter client always receives JSON, never a
// crash or an HTML error page.
function mapServiceError(err) {
  if (isDbError(err)) {
    return fail("Database connection error. Please retry shortly.", 503);
  }
  const msg = err && err.message ? String(err.message) : "";
  if (/not found/i.test(msg)) return fail(msg, 404);
  if (/cannot|invalid|only|must|terminal|required/i.test(msg)) return fail(msg, 400);
  console.error("[api] orders/[id] unhandled error:", err);
  return fail("Internal Server Error", 500);
}

// Soft-delete aliases: an ARCHIVE/DELETE action (or an ARCHIVED status) never
// destroys the database record — it flips the ticket to ARCHIVED so it drops
// out of the ACTIVE query while sales history stays intact for reporting.
const ARCHIVE_ALIASES = ["ARCHIVE", "DELETE", "ARCHIVED"];

// GET /api/orders/[id] — fetch a single order (sanitized).
// Validates route param to prevent injection; uses lean + select for performance.
// Requires authentication (any staff can read their own or assigned order).
async function getHandler(request, { params }) {
  const auth = await requireAuth(request);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!can(auth.payload.role, "orders:read")) return fail("Forbidden", 403);
  const { id } = await params;
  const sanitizedId = sanitizeString(id, { maxLen: 50 });
  if (!sanitizedId) return fail("Invalid order identifier", 400);
  if (sanitizedId.length > 50) return fail("Invalid order identifier", 400);
  try {
    const conn = await connectToDatabase();
    const Order = getOrderModel(conn);
    const order = await Order.findOne(buildQuery(sanitizedId))
      .select("orderNumber tableNumber waiterName waiterId waiterNumber waiterInfo kitchenStaffId baristaStaffId items status kitchenStatus baristaStatus totalAmount paymentMethod createdAt updatedAt preparingAt readyAt servedAt paidAt completedAt kitchenPreparingAt kitchenReadyAt baristaPreparingAt baristaReadyAt isExternal")
      .lean();
    if (!order) return fail("Order not found", 404);
    if (auth.payload.role === "WAITER" && String(order.waiterId || "") !== String(auth.payload.staffId || "")) {
      return fail("Forbidden: not your order", 403);
    }
    return ok({ order: toKdsShape(order) }, 200);
  } catch (err) {
    return mapServiceError(err);
  }
}

// PATCH /api/orders/[id]
// Advance the order lifecycle. Validates authentication, role, and business
// transition server-side (policy.canTransition). Browser is untrusted — client
// cannot force arbitrary status. ARCHIVE is KDS soft-delete (keeps history).
//
// Body examples:
//   { "status": "PREPARING" | "READY" | "SERVED" | "PAID" | "ARCHIVED" | "CANCELLED" }
//   { "action": "ARCHIVE" | "DELETE" | "ARCHIVED" | "CANCELLED" }
//   { "paymentMethod": "CASH" }
async function patchHandler(request, { params }) {
  const auth = await requireAuth(request);
  if (!auth.ok) return fail(auth.error, auth.status);
  const rl = checkRateLimit(request, { key: "orders_patch", limit: 60, windowMs: 60_000 });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  const { id } = await params;
  const sanitizedId = sanitizeString(id, { maxLen: 50 });
  if (!sanitizedId) return fail("Invalid order identifier", 400);
  const len = request.headers.get("content-length");
  if (len && Number(len) > 20 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Invalid request body", 400);
  }

  // Strict validation - Zod-like
  const validated = validateOrderStatusUpdate(body);
  if (!validated.ok) return fail(validated.error, 400);
  const { status, action, paymentMethod } = validated.data;

  const isArchive =
    action !== undefined
      ? ARCHIVE_ALIASES.includes(String(action).toUpperCase())
      : String(status || "").toUpperCase() === "ARCHIVED";
  const isCancel = String(action || status || "").toUpperCase() === "CANCELLED";

  // Authorization per transition — never trust client status
  if (isCancel && !canTransition(auth.payload.role, "CANCELLED")) return fail("Forbidden: CANCELLED requires MANAGER", 403);
  if (isArchive && !canTransition(auth.payload.role, "ARCHIVED")) return fail("Forbidden: ARCHIVED requires KITCHEN/BARISTA/MANAGER", 403);
  if (status && !isArchive && !isCancel) {
    const sUpper = String(status).toUpperCase();
    if (["PENDING","PREPARING","READY","SERVED","PAID"].includes(sUpper) && !canTransition(auth.payload.role, sUpper)) {
      return fail(`Forbidden: ${sUpper} requires ${sUpper==="PREPARING"||sUpper==="READY" ? "KITCHEN/BARISTA/MANAGER" : sUpper==="SERVED"||sUpper==="PAID" ? "WAITER/MANAGER" : "authorized role"}`, 403);
    }
    if (sUpper === "PAID" && !can(auth.payload.role, "orders:payment")) return fail("Forbidden: payment requires WAITER/MANAGER", 403);
  }
  if (paymentMethod && !status && !isArchive && !isCancel) {
    if (!can(auth.payload.role, "orders:payment")) return fail("Forbidden: payment requires WAITER/MANAGER", 403);
  }

  try {
    let conn;
    try {
      conn = await connectToDatabase();
    } catch {
      return fail("Database connection error. Please retry shortly.", 503);
    }

    // Session already verified — use for auditable READY attribution
    const sessionStaff = auth.payload;

    // --- CANCEL the whole order -------------------------------------------
    if (isCancel) {
      const doc = await cancelOrder(conn, sanitizedId);

      publish({
        type: "orders-changed",
        reason: "status",
        orderId: String(doc._id),
        orderNumber: doc.orderNumber,
        status: "CANCELLED",
      });

      return ok({ order: toKdsShape(doc) }, 200);
    }

    // --- Soft delete / archive -------------------------
    let doc = null;
    if (isArchive) {
      doc = await archiveOrder(conn, sanitizedId);
    } else if (status) {
      const s = status.toUpperCase();
      if (!["PENDING", "PREPARING", "READY", "SERVED", "PAID"].includes(s)) {
        return fail("Invalid status", 400);
      }
      // Phase 6.5: WAITER can only SERVE/PAID own orders (staffId ownership)
      if (auth.payload.role === "WAITER" && (s === "SERVED" || s === "PAID")) {
        const OrderTmp = getOrderModel(conn);
        const existing = await OrderTmp.findOne(buildQuery(sanitizedId)).select("waiterId waiterNumber").lean();
        if (!existing) return fail("Order not found", 404);
        if (String(existing.waiterId || "") !== String(auth.payload.staffId || "")) {
          return fail("Forbidden: not your order", 403);
        }
      }
      if (s === "SERVED") doc = await serveOrder(conn, sanitizedId);
      else if (s === "PAID") doc = await payOrder(conn, sanitizedId, { paymentMethod });
      else {
        // PREPARING / READY — auditable: record who marked ready
        const opts = {};
        if (s === "READY" && sessionStaff) {
          const sid = sessionStaff.staffId || null;
          const role = String(sessionStaff.role || "").toUpperCase();
          if (sid) {
            opts.staffId = sid;
            opts.staffRole = role;
            if (role === "KITCHEN") opts.kitchenStaffId = sid;
            if (role === "BARISTA") opts.baristaStaffId = sid;
          }
          // Allow validated explicit body fields to override
          if (validated.data.kitchenStaffId) opts.kitchenStaffId = validated.data.kitchenStaffId;
          if (validated.data.baristaStaffId) opts.baristaStaffId = validated.data.baristaStaffId;
        } else if (s === "READY") {
          if (validated.data.kitchenStaffId) opts.kitchenStaffId = validated.data.kitchenStaffId;
          if (validated.data.baristaStaffId) opts.baristaStaffId = validated.data.baristaStaffId;
          if (validated.data.staffId) {
            opts.staffId = validated.data.staffId;
            opts.staffRole = validated.data.staffRole;
          }
        }
        doc = (await updateOrderStatus(conn, sanitizedId, s, opts)).doc;
      }
    } else if (paymentMethod) {
      if (auth.payload.role === "WAITER") {
        const OrderTmp = getOrderModel(conn);
        const existing = await OrderTmp.findOne(buildQuery(sanitizedId)).select("waiterId").lean();
        if (!existing) return fail("Order not found", 404);
        if (String(existing.waiterId || "") !== String(auth.payload.staffId || "")) return fail("Forbidden: not your order", 403);
      }
      doc = await updatePayment(conn, sanitizedId, { paymentMethod });
    }

    if (!doc) {
      return fail("No update fields provided", 400);
    }

    // Non-blocking push: every status/payment transition is broadcast so the
    // KDS board and Waiter lifecycle panel update instantly.
    publish({
      type: "orders-changed",
      reason: status ? "status" : paymentMethod ? "payment" : "update",
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      status: doc.status,
    });

    // Targeted ping so ONLY the owning waiter gets "ORDER_READY" alert.
    // Minimal invalidation only — the owning waiter refetches GET /api/orders
    // (session-scoped to their own orders) to learn their READY state. Never
    // expose another waiter's order context here.
    if (doc.status === "READY") {
      publish({
        type: "ORDER_READY",
        orderId: String(doc._id),
        orderNumber: doc.orderNumber,
      });
    }

    return ok({ order: toKdsShape(doc) }, 200);
  } catch (err) {
    return mapServiceError(err);
  }
}

// DELETE /api/orders/[id] — soft delete: marks the order ARCHIVED so it leaves
// the live ACTIVE board while the row stays in the database for reporting.
// Requires KITCHEN/BARISTA/MANAGER (policy: orders:transition:ARCHIVED)
async function deleteHandler(request, { params }) {
  const auth = await requireAuth(request);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!canTransition(auth.payload.role, "ARCHIVED")) return fail("Forbidden: ARCHIVED requires KITCHEN/BARISTA/MANAGER", 403);
  const { id } = await params;
  const sanitizedId = sanitizeString(id, { maxLen: 50 });
  if (!sanitizedId) return fail("Invalid order identifier", 400);
  try {
    let conn;
    try {
      conn = await connectToDatabase();
    } catch {
      return fail("Database connection error. Please retry shortly.", 503);
    }
    const doc = await archiveOrder(conn, sanitizedId);

    publish({
      type: "orders-changed",
      reason: "archived",
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      status: "ARCHIVED",
    });

    return ok({ order: toKdsShape(doc) }, 200);
  } catch (err) {
    return mapServiceError(err);
  }
}

export const GET = withApi(getHandler);
export const PATCH = withApi(patchHandler);
export const DELETE = withApi(deleteHandler);
