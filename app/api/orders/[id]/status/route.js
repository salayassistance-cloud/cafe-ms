import { connectToDatabase } from "@/lib/mongodb";
import { updateOrderStatus, serveOrder, payOrder, confirmPayment } from "@/lib/orderService";
import { getOrderModel } from "@/lib/models/Order";
import { publish } from "@/lib/eventHub";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { requireAuth } from "@/lib/security";
import { canTransition, can } from "@/lib/policy";
import mongoose from "mongoose";
import { sanitizeString, validateOrderStatusUpdate } from "@/lib/validate";
import { checkRateLimit, retryAfterSeconds } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

function mapServiceError(err) {
  if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
  const msg = err?.message ? String(err.message) : "";
  if (/not found/i.test(msg)) return fail(msg, 404);
  // Idempotent repeat cancellation is not a server failure — report conflict, never generic 500.
  if (/already cancelled/i.test(msg)) return fail(msg, 409);
  if (/cannot|invalid|only|must|terminal|required/i.test(msg)) return fail(msg, 400);
  console.error("[api] orders/[id]/status unhandled:", err);
  return fail("Internal Server Error", 500);
}

// PATCH /api/orders/[id]/status
// Spec contract: Updates state (READY, SERVED, PAID) and records timestamps/staff IDs.
// All body fields validated; route param sanitized. Requires auth + canTransition.
async function patchHandler(request, { params }) {
  const auth = await requireAuth(request);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  const rl = checkRateLimit(request, { key: "orders_status", limit: 60, windowMs: 60_000 });
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
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid request body", 400);
  const validated = validateOrderStatusUpdate(body);
  if (!validated.ok) return fail(validated.error, 400);
  const raw = validated.data.status;
  if (!raw) return fail("status is required", 400);

  if (!canTransition(auth.payload.role, raw)) return fail(`Forbidden: ${raw} requires ${raw==="PREPARING"||raw==="READY"?"KITCHEN/BARISTA/MANAGER":raw==="SERVED"||raw==="PAYMENT_PENDING"?"WAITER/MANAGER":raw==="PAID"?"CASHIER/MANAGER":"authorized role"}`,403);
  // Canonical payment-confirm authorization (policy: orders:payment:confirm =
  // [CASHIER, MANAGER]). The legacy WAITER/MANAGER check below rejected every
  // CASHIER unconditionally, contradicting the canonical matrix.
  if (raw==="PAID" && !can(auth.payload.role,"orders:payment:confirm")) return fail("Forbidden: payment confirm requires CASHIER/MANAGER",403);

  try {
    let conn;
    try {
      conn = await connectToDatabase();
    } catch {
      return fail("Database connection error. Please retry shortly.", 503);
    }

    const sessionStaff = auth.payload;

    let doc = null;
    const s = raw;

    // Phase 6.5: WAITER can only SERVE/PAID own orders (staffId ownership)
    if (auth.payload.role === "WAITER" && (s === "SERVED" || s === "PAID")) {
      const OrderTmp = getOrderModel(conn);
      const q = mongoose.isValidObjectId(sanitizedId) ? { $or: [{ orderNumber: sanitizedId }, { _id: sanitizedId }] } : { orderNumber: sanitizedId };
      const existing = await OrderTmp.findOne(q).select("waiterId waiterNumber").lean();
      if (!existing) return fail("Order not found", 404);
      if (String(existing.waiterId || "") !== String(auth.payload.staffId || "")) {
        return fail("Forbidden: not your order", 403);
      }
    }

    if (s === "SERVED") {
      doc = await serveOrder(conn, sanitizedId);
    } else if (s === "PAID") {
      // Canonical parity with PATCH /api/orders/[id] (P1): PAYMENT_PENDING →
      // confirmPayment(); MANAGER-only legacy direct settlement from SERVED;
      // anything else is a clean 400. Authorization above already restricts
      // this branch; no duplicate payment logic lives here.
      const OrderForPay = getOrderModel(conn);
      const qPay = mongoose.isValidObjectId(sanitizedId) ? { $or: [{ orderNumber: sanitizedId }, { _id: sanitizedId }] } : { orderNumber: sanitizedId };
      const existingForPay = await OrderForPay.findOne(qPay).select("status").lean();
      if (!existingForPay) return fail("Order not found", 404);
      if (existingForPay.status === "PAYMENT_PENDING") {
        doc = await confirmPayment(conn, sanitizedId, { actorId: auth.payload.staffId });
      } else if (String(auth.payload.role || "").toUpperCase() === "MANAGER" && existingForPay.status === "SERVED") {
        const pm = validated.data.paymentMethod;
        doc = await payOrder(conn, sanitizedId, { paymentMethod: pm, actorId: auth.payload.staffId });
      } else {
        return fail("Order must be submitted for verification before payment", 400);
      }
    } else {
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
        // AUTH-ARCH-4: READY attribution is the authenticated session only.
        // Client-supplied kitchenStaffId/baristaStaffId/staffId are ignored
        // (no client sends them; accepting them would poison audit fields).
      }
      doc = (await updateOrderStatus(conn, sanitizedId, s, opts)).doc;
    }

    if (!doc) return fail("Update failed", 500);

    publish({
      type: "orders-changed",
      reason: "status",
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      status: doc.status,
    });

    if (doc.status === "READY") {
      // Minimal invalidation only — never expose another waiter's order context.
      // The owning waiter refetches GET /api/orders (session-scoped to their own
      // orders) and learns their READY state from their own filtered data.
      publish({
        type: "ORDER_READY",
        orderId: String(doc._id),
        orderNumber: doc.orderNumber,
      });
    }

    const { toKdsShape } = await import("@/lib/orderService");
    return ok({ order: toKdsShape(doc) }, 200);
  } catch (err) {
    return mapServiceError(err);
  }
}

export const PATCH = withApi(patchHandler);

// Also support GET for symmetry — WAITER owner-filtered
async function getHandler(request, { params }) {
  const auth = await requireAuth(request);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  if (!can(auth.payload.role,"orders:read")) return fail("Forbidden",403);
  const { id } = await params;
  const sanitizedId = sanitizeString(id, { maxLen: 50 });
  if (!sanitizedId) return fail("Invalid order identifier", 400);
  try {
    let conn;
    try {
      conn = await connectToDatabase();
    } catch {
      return fail("Database connection error", 503);
    }
    const Order = getOrderModel(conn);
    const q = mongoose.isValidObjectId(sanitizedId) ? { $or: [{ orderNumber: sanitizedId }, { _id: sanitizedId }] } : { orderNumber: sanitizedId };
    const order = await Order.findOne(q).select("orderNumber tableNumber waiterName waiterId waiterNumber waiterInfo kitchenStaffId baristaStaffId items status kitchenStatus baristaStatus totalAmount paymentMethod createdAt updatedAt preparingAt readyAt servedAt paidAt completedAt kitchenPreparingAt kitchenReadyAt baristaPreparingAt baristaReadyAt isExternal").lean();
    if (!order) return fail("Order not found", 404);
    if (auth.payload.role === "WAITER" && String(order.waiterId || "") !== String(auth.payload.staffId || "")) {
      return fail("Forbidden: not your order", 403);
    }
    const { toKdsShape } = await import("@/lib/orderService");
    return ok({ order: toKdsShape(order) }, 200);
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error", 503);
    return fail("Internal Server Error", 500);
  }
}
export const GET = withApi(getHandler);
