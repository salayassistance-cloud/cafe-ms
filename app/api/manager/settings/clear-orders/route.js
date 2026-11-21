import { connectToDatabase } from "@/lib/mongodb";
import { verifyStaffPinById } from "@/lib/staffService";
import { getOrderModel } from "@/lib/models/Order";
import { getInventoryReservationModel } from "@/lib/models/InventoryReservation";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { validatePin } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";
import { logEvent } from "@/lib/operationalLogger";

export const dynamic = "force-dynamic";

// Phase 2.2 safety contract for the destructive manager reset:
//
//  0. C3-02: this endpoint is DISABLED in production. A server-side,
//     unconditional 403 DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION is returned
//     before auth, body parsing, PIN verification, or any database work. No
//     header, cookie, query parameter, body field, flag, or environment
//     variable can re-enable it in production.
//  1. MANAGER session + the REQUESTING MANAGER's own Staff PIN (step-up).
//  2. `dryRun: true` returns a preview and mutates nothing.
//  3. Destructive execution requires the literal confirmation token
//     `confirm: "CLEAR-ORDERS"` in addition to the PIN.
//  4. PAID orders are financial evidence: the reset refuses while any exist.
//     Use the (future) approved archive/retention procedure first.
//  5. ARCHIVED orders are preserved; the order counter is reset only when the
//     orders collection is empty, so ORD- numbers can never be duplicated.
//  6. The reset refuses while any V1 inventory consumption is in flight
//     (`CONSUMING`); physical consumption evidence is never deleted.
//  7. StockMovement / inventory audit records are never touched.
//
// This route stays V1-only. It must not run in an environment where Inventory
// V2 holds exist; V2 ownership is explicitly out of scope for Phase 2.2.
const CONFIRMATION_TOKEN = "CLEAR-ORDERS";
const PRESERVED_ORDER_STATUSES = Object.freeze(["PAID", "ARCHIVED"]);
const PRESERVED_RESERVATION_STATUSES = Object.freeze(["CONSUMED", "CONSUMING"]);

// ── C3-02: production hard-deny ─────────────────────────────────────────────
// This destructive endpoint does not exist in production. The decision is made
// server-side from process environment markers only; client headers, cookies,
// query parameters, and body fields are never consulted. Any recognized
// production marker wins over any non-production marker. There is no override.
const DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION = "DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION";
const PRODUCTION_MARKERS = Object.freeze([
  "NODE_ENV",
  "VERCEL_ENV",
  "CONTEXT",
  "DEPLOY_ENV",
  "APP_ENV",
  "ENVIRONMENT",
  "BONO_OPERATION_ENV",
]);
const PRODUCTION_MARKER_VALUES = Object.freeze(["production", "prod", "live"]);
const NON_PRODUCTION_MARKER_VALUES = Object.freeze([
  "development",
  "dev",
  "test",
  "testing",
  "staging",
  "stage",
  "preview",
  "local",
  "ci",
  "deploy-preview",
  "branch-deploy",
]);

function normalizeEnvironmentMarker(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Fail-closed production detector.
 *
 * - any recognized production marker -> production, even alongside a
 *   development/test marker;
 * - any unrecognized marker value -> production (ambiguous configuration);
 * - no markers at all -> production (unclassified runtime).
 *
 * Only an explicit, recognized non-production classification returns false.
 * Compatibility note: a bare `node` invocation with no markers is treated as
 * production. Next.js sets NODE_ENV=development for `next dev` and
 * NODE_ENV=production for `next build`/`next start`, so the development and
 * production runtime split is unchanged.
 */
function isProductionDeployment(env = process.env) {
  let recognizedNonProduction = false;
  for (const marker of PRODUCTION_MARKERS) {
    const value = normalizeEnvironmentMarker(env?.[marker]);
    if (!value) continue;
    if (PRODUCTION_MARKER_VALUES.includes(value)) return true;
    if (NON_PRODUCTION_MARKER_VALUES.includes(value)) recognizedNonProduction = true;
    else return true;
  }
  return !recognizedNonProduction;
}

async function handler(request) {
  // C3-02: hard-deny before auth, rate limiting, body parsing, PIN checks, or
  // any database/model access. Nothing below can run in production.
  if (isProductionDeployment(process.env)) {
    return fail(
      "Destructive administration is disabled in production. This endpoint is not available in a production environment.",
      403,
      DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION
    );
  }

  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);

  const rl = checkRateLimit(request, { key: "clear_orders", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  const len = request.headers.get("content-length");
  if (len && Number(len) > 5 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  const currentManagerPin = validatePin(body?.currentManagerPin);
  if (!currentManagerPin) {
    return fail("Manager PIN re-authentication required (4 digits) for destructive action", 400);
  }

  const dryRun = body?.dryRun === true || body?.preview === true;
  const confirmation = String(body?.confirm ?? body?.confirmation ?? "").trim().toUpperCase();
  if (!dryRun && confirmation !== CONFIRMATION_TOKEN) {
    return fail(
      `Confirmation required: send { "confirm": "${CONFIRMATION_TOKEN}" } (or { "dryRun": true } for a preview)`,
      400,
      "CLEAR_ORDERS_CONFIRMATION_REQUIRED"
    );
  }

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database temporarily unavailable", 503);
  }
  // AUTH-ARCH-8A: step-up re-authentication against the requesting MANAGER's
  // own Staff PIN (canonical Staff credential). The legacy SystemAuth role-PIN
  // check was removed: it verified a shared role secret instead of the
  // authenticated staff member. Sessions without a Staff identity cannot pass.
  const authorised = await verifyStaffPinById(conn, auth.payload.staffId, currentManagerPin);
  if (!authorised.ok) {
    return fail("Manager PIN incorrect", 401);
  }

  const Order = getOrderModel(conn);
  const Reservation = getInventoryReservationModel(conn);
  const InventoryItem = getInventoryItemModel(conn);

  const [totalOrders, paidOrders, archivedOrders, totalReservations, consumingReservations, heldItems] =
    await Promise.all([
      Order.countDocuments({}),
      Order.countDocuments({ status: "PAID" }),
      Order.countDocuments({ status: "ARCHIVED" }),
      Reservation.countDocuments({}),
      Reservation.countDocuments({ status: "CONSUMING" }),
      InventoryItem.countDocuments({ reservedStock: { $gt: 0 } }),
    ]);

  const preservedOrders = paidOrders + archivedOrders;
  const deletableOrders = Math.max(0, totalOrders - preservedOrders);
  const preservedReservations = await Reservation.countDocuments({
    status: { $in: PRESERVED_RESERVATION_STATUSES },
  });

  if (dryRun) {
    return ok(
      {
        preview: true,
        mutated: false,
        totalOrders,
        wouldClearOrders: deletableOrders,
        wouldPreserveOrders: preservedOrders,
        paidOrders,
        archivedOrders,
        totalReservations,
        wouldClearReservations: Math.max(0, totalReservations - preservedReservations),
        wouldPreserveReservations: preservedReservations,
        consumingReservations,
        itemsWithReservedStock: heldItems,
        blockedReasons: [
          ...(paidOrders > 0 ? ["PAID_ORDERS_PRESENT"] : []),
          ...(consumingReservations > 0 ? ["INVENTORY_CONSUMPTION_IN_FLIGHT"] : []),
        ],
      },
      200
    );
  }

  // Fail closed before any mutation. These are not warnings: a destructive
  // reset must never destroy accounting evidence or race a consumption.
  if (paidOrders > 0) {
    return fail(
      "Refusing to clear orders: PAID orders are financial evidence. Archive/export them with the approved procedure first.",
      409,
      "CLEAR_ORDERS_PAID_EVIDENCE_PRESENT"
    );
  }
  if (consumingReservations > 0) {
    return fail(
      "Refusing to clear orders while inventory consumption is in flight (CONSUMING). Retry after it settles.",
      409,
      "CLEAR_ORDERS_V1_CONSUMPTION_IN_FLIGHT"
    );
  }

  // Only non-evidence states are deleted. The filter is repeated here (not
  // just the counts above) so a concurrent PAID/ARCHIVED write cannot be
  // deleted between the preflight and the write.
  const deleted = await Order.deleteMany({ status: { $nin: PRESERVED_ORDER_STATUSES } });

  // Phase 1 invariant: deleting live orders must also return every inventory
  // hold they created. Otherwise reservedStock would leak forever.
  // Phase 1.1: physically consumed reservations are preserved as audit evidence.
  // Their stock was already decremented, so they hold nothing; deleting them
  // would erase the only per-order record of what was consumed and why it was
  // voided. The StockMovement ledger (SaleDeduction/Waste + void metadata) is
  // never touched by this reset either.
  const deletedReservations = await Reservation.deleteMany({ status: { $nin: ["CONSUMED", "CONSUMING"] } });
  // No CONSUMING reservation survived the preflight above; preserved CONSUMED
  // rows hold no stock, so zeroing V1 holds is now a verified reset, not an
  // arbitrary global wipe. V2 holds are out of scope and must not exist here.
  await InventoryItem.updateMany(
    { reservedStock: { $gt: 0 } },
    { $set: { reservedStock: 0 } }
  );

  // Reset the order sequence counter ONLY when the collection is truly empty.
  // Preserved PAID/ARCHIVED rows mean the counter must continue, otherwise the
  // next order would reuse an ORD- number that is already on a historical row.
  const remainingOrders = await Order.countDocuments({});
  let counterReset = false;
  if (remainingOrders === 0) {
    await conn.collection("counters").updateOne(
      { _id: "order_seq" },
      { $set: { seq: 0 } },
      { upsert: true }
    );
    counterReset = true;
  }

  logEvent("warn", "clear_orders_executed", {
    managerStaffId: String(auth.payload.staffId || ""),
    clearedOrders: deleted.deletedCount,
    clearedReservations: deletedReservations.deletedCount,
    preservedOrders: remainingOrders,
    counterReset,
  });

  return ok({ clearedOrders: deleted.deletedCount, clearedReservations: deletedReservations.deletedCount, preservedOrders: remainingOrders, counterReset });
}

export const POST = withApi(handler);
