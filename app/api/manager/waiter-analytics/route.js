import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { getStaffModel } from "@/lib/models/Staff";
import { getOrderModel } from "@/lib/models/Order";
import { requireAuth } from "@/lib/security";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { validateObjectId } from "@/lib/validate";
import { addisWallToUTC, getAddisYMD, getAddisParts } from "@/lib/analytics";

export const dynamic = "force-dynamic";

// Helpers — reuse canonical logic from lib/analytics but locally for waiter scope
function normalizePaymentMethod(m) {
  const v = String(m || "").trim().toUpperCase();
  if (v === "TELEBIRR") return "TRANSFER";
  return v || "NONE";
}
function isTransfer(m) {
  const v = String(m || "").trim().toUpperCase();
  return v === "TRANSFER" || v === "TELEBIRR";
}
function effectiveOrderAmount(order) {
  if (!order || !Array.isArray(order.items)) return Number(order?.totalAmount) || 0;
  const hasCancelled = (order.items || []).some((it) => it.cancelled === true);
  function activeSum(list) {
    return list.reduce((s, it) => {
      const base = (Number(it.price) || 0) * (Number(it.quantity) || 0);
      const comps = Array.isArray(it.components) ? it.components : [];
      const compSum = comps.filter((c) => c.kind === "PRICED_COMPONENT").reduce((cs, c) => cs + (Number(c.lineSum) || Number(c.quantity) * Number(c.unitPrice) || 0), 0);
      return s + base + compSum;
    }, 0);
  }
  if (!hasCancelled) {
    if (Number.isFinite(Number(order.totalAmount)) && Number(order.totalAmount) !== 0) return Number(order.totalAmount) || 0;
    return Math.round(activeSum(order.items) * 100) / 100;
  }
  const active = (order.items || []).filter((it) => !it.cancelled);
  return Math.round(activeSum(active) * 100) / 100;
}
function soldQuantity(order) {
  if (!order || !Array.isArray(order.items)) return 0;
  return (order.items || []).filter((it) => !it.cancelled).reduce((s, it) => s + (Number(it.quantity) || 0), 0);
}
function getPaidTimestamp(order) {
  // Canonical: paidAt is authoritative, fallback to paymentVerifiedAt, then completedAt
  if (order.paidAt) return new Date(order.paidAt);
  if (order.paymentVerifiedAt) return new Date(order.paymentVerifiedAt);
  if (order.completedAt) return new Date(order.completedAt);
  return null;
}
function getLast7Range(now) {
  const todayStr = getAddisYMD(now);
  const todayStart = addisWallToUTC(...todayStr.split("-").map(Number), 0, 0, 0, 0);
  const from = new Date(todayStart.getTime() - 6 * 24 * 3600 * 1000);
  const to = new Date(todayStart.getTime() + 24 * 3600 * 1000);
  // Return as UTC instants half-open [from 00:00 6 days ago, to tomorrow 00:00)
  return { from, to };
}
function getTodayRange(now) {
  const ymd = getAddisYMD(now);
  const [y, m, d] = ymd.split("-").map(Number);
  const from = addisWallToUTC(y, m, d, 0, 0, 0, 0);
  const to = new Date(from.getTime() + 24 * 3600 * 1000);
  return { from, to };
}
function getYesterdayRange(now) {
  const today = getTodayRange(now);
  const from = new Date(today.from.getTime() - 24 * 3600 * 1000);
  const to = new Date(today.from.getTime());
  return { from, to };
}
function getThisMonthRange(now) {
  const p = getAddisParts(now);
  const from = addisWallToUTC(p.year, p.month, 1, 0, 0, 0, 0);
  let y = p.year, m = p.month + 1;
  if (m > 12) { m = 1; y += 1; }
  const to = addisWallToUTC(y, m, 1, 0, 0, 0, 0);
  return { from, to };
}
function parseCustomRange(fromStr, toStr) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(String(fromStr).trim()) || !re.test(String(toStr).trim())) return { error: "Custom range requires from and to as YYYY-MM-DD" };
  const [fy, fm, fd] = String(fromStr).trim().split("-").map(Number);
  const [ty, tm, td] = String(toStr).trim().split("-").map(Number);
  const from = addisWallToUTC(fy, fm, fd, 0, 0, 0, 0);
  const toExclusive = addisWallToUTC(ty, tm, td, 0, 0, 0, 0);
  const to = new Date(toExclusive.getTime() + 24 * 3600 * 1000); // end-exclusive: next midnight after to
  if (!from || !to || isNaN(from.getTime()) || isNaN(to.getTime())) return { error: "Invalid custom dates" };
  if (from.getTime() >= to.getTime()) return { error: "Custom from must be before to" };
  // Prevent unbounded: max 90 days
  const days = (to.getTime() - from.getTime()) / (24*3600*1000);
  if (days > 90) return { error: "Custom range too large (max 90 days)" };
  // Validate no overflow (Feb 30)
  const pf = getAddisParts(from);
  if (pf.month !== fm || pf.day !== fd) return { error: "Invalid from date" };
  const pt = getAddisParts(toExclusive);
  if (pt.month !== tm || pt.day !== td) return { error: "Invalid to date" };
  return { from, to };
}

async function handler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  const rl = checkRateLimit(request, { key: "manager_waiter_analytics", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }

  const { searchParams } = new URL(request.url);
  const presetRaw = String(searchParams.get("preset") || searchParams.get("range") || "today").trim().toLowerCase();
  const preset = ["today","yesterday","last7","last_7","last7days","thismonth","this_month","custom"].includes(presetRaw) ? presetRaw.replace(/_/g,"") : "today";
  const normalizedPreset = preset === "last_7" ? "last7" : preset === "last7days" ? "last7" : preset === "this_month" ? "thismonth" : preset;
  const waiterIdRaw = searchParams.get("waiterId") || searchParams.get("staffId");
  const waiterId = waiterIdRaw ? validateObjectId(String(waiterIdRaw).trim()) : null;
  if (waiterIdRaw && !waiterId) return fail("Invalid waiterId", 400);
  const limitRaw = searchParams.get("limit");
  let limit = 50;
  if (limitRaw) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 200) return fail("limit must be integer 1-200", 400);
    limit = n;
  }

  const now = new Date();
  let from, to;
  let presetLabel = "";
  if (normalizedPreset === "today") {
    const r = getTodayRange(now);
    from = r.from; to = r.to;
    presetLabel = "Today";
  } else if (normalizedPreset === "yesterday") {
    const r = getYesterdayRange(now);
    from = r.from; to = r.to;
    presetLabel = "Yesterday";
  } else if (normalizedPreset === "last7") {
    const r = getLast7Range(now);
    from = r.from; to = r.to;
    presetLabel = "Last 7 Days (incl. today)";
  } else if (normalizedPreset === "thismonth") {
    const r = getThisMonthRange(now);
    from = r.from; to = r.to;
    presetLabel = "This Month";
  } else if (normalizedPreset === "custom") {
    const fromStr = searchParams.get("from");
    const toStr = searchParams.get("to");
    if (!fromStr || !toStr) return fail("Custom preset requires from and to (YYYY-MM-DD)", 400);
    const parsed = parseCustomRange(fromStr, toStr);
    if (parsed.error) return fail(parsed.error, 400);
    from = parsed.from; to = parsed.to;
    presetLabel = `Custom ${String(fromStr).trim()} → ${String(toStr).trim()}`;
  } else {
    const r = getTodayRange(now);
    from = r.from; to = r.to;
    presetLabel = "Today";
  }

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database temporarily unavailable", 503);
  }

  const Staff = getStaffModel(conn);
  const Order = getOrderModel(conn);

  // Summary mode: no waiterId → return summaries for all WAITERs
  if (!waiterId) {
    const waiters = await Staff.find({ role: "WAITER" }).select("name username isActive waiterNumber createdAt").sort({ name: 1 }).lean();
    if (waiters.length === 0) {
      return ok({ preset: normalizedPreset, presetLabel, range: { from: from.toISOString(), to: to.toISOString(), timezone: "Africa/Addis_Ababa", halfOpen: "[from, to)" }, summaries: [], counts: { totalWaiters: 0 } }, 200);
    }
    const waiterIds = waiters.map((w) => w._id);
    // Fetch orders created in window for volume/status counts, and paid orders by paidAt for revenue
    const createdOrders = await Order.find({ waiterId: { $in: waiterIds }, createdAt: { $gte: from, $lt: to } })
      .select("waiterId status totalAmount items paymentMethod paidAt paymentVerifiedAt createdAt")
      .lean();
    const paidOrders = await Order.find({ waiterId: { $in: waiterIds }, status: "PAID", paidAt: { $gte: from, $lt: to } })
      .select("waiterId status totalAmount items paymentMethod paidAt paymentVerifiedAt")
      .lean();
    // Also need paymentVerified fallback for those where paidAt is null but verifiedAt in window (rare legacy)
    const verifiedFallback = await Order.find({ waiterId: { $in: waiterIds }, status: "PAID", paidAt: null, paymentVerifiedAt: { $gte: from, $lt: to } })
      .select("waiterId status totalAmount items paymentMethod paidAt paymentVerifiedAt")
      .lean();
    const allPaid = [...paidOrders, ...verifiedFallback];
    // Group
    const byWaiter = new Map();
    for (const w of waiters) byWaiter.set(String(w._id), { waiter: w, created: [], paid: [] });
    for (const o of createdOrders) {
      const k = String(o.waiterId);
      const g = byWaiter.get(k);
      if (g) g.created.push(o);
    }
    for (const o of allPaid) {
      const k = String(o.waiterId);
      const g = byWaiter.get(k);
      if (g) {
        // Avoid double-count if same order appears in both (created and paid same window, but paid already counted via created window? We want paid by payment date, not by creation, so keep separate)
        // Check if already in paid via paidOrders vs verifiedFallback overlap not needed
        g.paid.push(o);
      }
    }
    const summaries = [];
    for (const [wid, g] of byWaiter) {
      const w = g.waiter;
      const created = g.created;
      const paid = g.paid;
      const totalOrdersCreated = created.length;
      const paidOrdersByPayment = paid.length;
      const paidRevenueByPayment = Math.round(paid.reduce((s, o) => s + effectiveOrderAmount(o), 0) * 100) / 100;
      const paidCash = paid.filter((o) => normalizePaymentMethod(o.paymentMethod) === "CASH");
      const paidTransfer = paid.filter((o) => isTransfer(o.paymentMethod));
      const paidCashTotal = Math.round(paidCash.reduce((s, o) => s + effectiveOrderAmount(o), 0) * 100) / 100;
      const paidTransferTotal = Math.round(paidTransfer.reduce((s, o) => s + effectiveOrderAmount(o), 0) * 100) / 100;
      // Status breakdown within created window
      const pending = created.filter((o) => ["PENDING","PREPARING","READY"].includes(o.status)).length;
      const served = created.filter((o) => o.status === "SERVED").length;
      const paymentPending = created.filter((o) => o.status === "PAYMENT_PENDING").length;
      const cancelled = created.filter((o) => o.status === "CANCELLED").length;
      const paidByCreation = created.filter((o) => o.status === "PAID").length;
      const soldQty = created.filter((o) => o.status === "PAID" ? false : false) // placeholder, correct below
      // Sold quantity should be from paid orders by payment date, excluding cancelled lines
      const soldQtyPaid = paid.reduce((s, o) => s + soldQuantity(o), 0);
      const avgPaidValue = paidOrdersByPayment > 0 ? Math.round((paidRevenueByPayment / paidOrdersByPayment) * 100) / 100 : 0;

      summaries.push({
        waiterId: String(w._id),
        name: w.name,
        username: w.username || String(w.name).toLowerCase(),
        isActive: w.isActive !== false,
        waiterNumber: w.waiterNumber ?? null,
        // Volume by createdAt
        totalOrdersCreated,
        paidByCreation,
        pending,
        served,
        paymentPending,
        cancelled,
        // Revenue by payment date
        paidOrdersByPayment,
        paidRevenueByPayment,
        soldQtyPaid,
        avgPaidValue,
        paidCashCount: paidCash.length,
        paidCashTotal,
        paidTransferCount: paidTransfer.length,
        paidTransferTotal,
        // Transparent level — not configured
        level: "Not configured",
        levelReason: "Awaiting approved thresholds — showing raw metrics only",
      });
    }
    // Sort by paid revenue desc, then paid orders
    summaries.sort((a, b) => b.paidRevenueByPayment - a.paidRevenueByPayment || b.paidOrdersByPayment - a.paidOrdersByPayment);
    return ok({ preset: normalizedPreset, presetLabel, range: { from: from.toISOString(), to: to.toISOString(), timezone: "Africa/Addis_Ababa", halfOpen: "[from, to)", fromLabel: from.toISOString(), toLabel: to.toISOString() }, summaries, meta: { timezone: "Africa/Addis_Ababa", halfOpen: "[from, to)", volumeBy: "createdAt", revenueBy: "paidAt/paymentVerifiedAt" } }, 200);
  }

  // Detail mode: single waiter
  const staff = await Staff.findById(waiterId).select("name username role isActive waiterNumber createdAt").lean();
  if (!staff) return fail("Waiter not found", 404);
  if (staff.role !== "WAITER") return fail("waiterId must be a WAITER", 400);

  // Legacy attribution: only waiterId match, no fallback to name/number (unambiguous)
  const wid = staff._id;
  const createdOrders = await Order.find({ waiterId: wid, createdAt: { $gte: from, $lt: to } })
    .select("orderNumber tableNumber waiterName waiterId items status totalAmount paymentMethod paymentAccountId paymentAccountSnapshot paymentSubmittedAt paymentVerifiedAt paymentRejectedAt paymentRejectionReason paidAt completedAt servedAt readyAt createdAt updatedAt")
    .sort({ createdAt: -1 })
    .lean();
  const paidOrders = await Order.find({ waiterId: wid, status: "PAID", paidAt: { $gte: from, $lt: to } })
    .select("orderNumber totalAmount items paymentMethod paidAt paymentVerifiedAt")
    .lean();
  const verifiedFallback = await Order.find({ waiterId: wid, status: "PAID", paidAt: null, paymentVerifiedAt: { $gte: from, $lt: to } })
    .select("orderNumber totalAmount items paymentMethod paidAt paymentVerifiedAt")
    .lean();
  const allPaid = [...paidOrders, ...verifiedFallback];
  // For detail, also fetch pending verification and rejected within window (by createdAt, to show together)
  const pendingOrders = createdOrders.filter((o) => o.status === "PAYMENT_PENDING");
  const servedOrders = createdOrders.filter((o) => o.status === "SERVED");
  const cancelledOrders = createdOrders.filter((o) => o.status === "CANCELLED");

  // KPIs
  const totalOrdersCreated = createdOrders.length;
  const paidOrdersByPayment = allPaid.length;
  const paidRevenueByPayment = Math.round(allPaid.reduce((s, o) => s + effectiveOrderAmount(o), 0) * 100) / 100;
  const soldQtyPaid = allPaid.reduce((s, o) => s + soldQuantity(o), 0);
  const avgPaidValue = paidOrdersByPayment > 0 ? Math.round((paidRevenueByPayment / paidOrdersByPayment) * 100) / 100 : 0;
  const paidCash = allPaid.filter((o) => normalizePaymentMethod(o.paymentMethod) === "CASH");
  const paidTransfer = allPaid.filter((o) => isTransfer(o.paymentMethod));
  const pendingVerificationCount = pendingOrders.length;
  const pendingVerificationAmount = Math.round(pendingOrders.reduce((s, o) => s + effectiveOrderAmount(o), 0) * 100) / 100;
  const rejectedCount = createdOrders.filter((o) => o.paymentRejectedAt && new Date(o.paymentRejectedAt) >= from && new Date(o.paymentRejectedAt) < to).length;

  // Item performance — from paid orders by payment date
  const itemMap = new Map();
  for (const o of allPaid) {
    for (const it of o.items || []) {
      if (it.cancelled) continue;
      const key = it.itemId ? String(it.itemId) : `name:${String(it.name).trim().toLowerCase()}`;
      const type = it.type || "FOOD";
      const mapKey = `${type}:${key}`;
      if (!itemMap.has(mapKey)) {
        itemMap.set(mapKey, { name: String(it.name).trim(), type, quantity: 0, revenue: 0, unitPrice: Number(it.price) || 0 });
      }
      const e = itemMap.get(mapKey);
      e.quantity += Number(it.quantity) || 0;
      e.revenue += Math.round((Number(it.price) || 0) * (Number(it.quantity) || 0) * 100) / 100;
      // Components
      for (const c of it.components || []) {
        if (c.cancelled) continue;
        if (c.kind === "PRICED_COMPONENT") {
          const cKey = `comp:${String(c.name).trim().toLowerCase()}:${String(c.inventoryItemId || c.name)}`;
          const ck = `${cKey}`;
          if (!itemMap.has(ck)) {
            itemMap.set(ck, { name: String(c.name).trim(), type: "COMPONENT", quantity: 0, revenue: 0, unitPrice: Number(c.unitPrice) || 0, isComponent: true });
          }
          const ce = itemMap.get(ck);
          ce.quantity += Number(c.quantity) || 0;
          ce.revenue += Number(c.lineSum) || (Number(c.quantity) * Number(c.unitPrice) || 0);
        }
      }
    }
  }
  const items = Array.from(itemMap.values()).map((e) => ({ ...e, revenue: Math.round(e.revenue * 100) / 100 })).sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity);

  // Order history — already fetched createdOrders, limit to 200, map safe fields
  const history = createdOrders.slice(0, Math.min(limit, 200)).map((o) => ({
    _id: String(o._id),
    orderNumber: o.orderNumber,
    tableNumber: o.tableNumber,
    status: o.status,
    paymentMethod: normalizePaymentMethod(o.paymentMethod),
    rawPaymentMethod: o.paymentMethod,
    paymentAccountSnapshot: o.paymentAccountSnapshot || null,
    paymentSubmittedAt: o.paymentSubmittedAt || null,
    paymentVerifiedAt: o.paymentVerifiedAt || null,
    paymentRejectedAt: o.paymentRejectedAt || null,
    paymentRejectionReason: o.paymentRejectionReason || null,
    paidAt: o.paidAt || null,
    servedAt: o.servedAt || null,
    readyAt: o.readyAt || null,
    completedAt: o.completedAt || null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    totalAmount: Number(o.totalAmount) || 0,
    effectiveAmount: effectiveOrderAmount(o),
    items: (o.items || []).map((it) => ({
      lineId: it.lineId ? String(it.lineId) : null,
      name: String(it.name).trim(),
      price: Number(it.price) || 0,
      quantity: Number(it.quantity) || 0,
      type: it.type || "FOOD",
      cancelled: !!it.cancelled,
      cancelReason: it.cancelReason || null,
      subTotal: Math.round((Number(it.price) || 0) * (Number(it.quantity) || 0) * 100) / 100,
      components: (it.components || []).map((c) => ({
        kind: c.kind,
        name: c.name || null,
        note: c.note || null,
        quantity: c.quantity ?? null,
        unitPrice: c.unitPrice ?? null,
        lineSum: c.lineSum ?? null,
        cancelled: !!c.cancelled,
      })),
    })),
  }));

  const payload = {
    waiter: { id: String(staff._id), name: staff.name, username: staff.username || String(staff.name).toLowerCase(), role: staff.role, isActive: staff.isActive !== false, waiterNumber: staff.waiterNumber ?? null },
    preset: normalizedPreset,
    presetLabel,
    range: { from: from.toISOString(), to: to.toISOString(), timezone: "Africa/Addis_Ababa", halfOpen: "[from, to)" },
    kpis: {
      totalOrdersCreated,
      paidOrdersByPayment,
      paidRevenueByPayment,
      soldQtyPaid,
      avgPaidValue,
      pendingVerificationCount,
      pendingVerificationAmount,
      servedUnpaid: servedOrders.length,
      pendingInProgress: createdOrders.filter((o) => ["PENDING","PREPARING","READY"].includes(o.status)).length,
      cancelled: cancelledOrders.length,
      rejectedCount,
      paidCashCount: paidCash.length,
      paidCashTotal: Math.round(paidCash.reduce((s, o) => s + effectiveOrderAmount(o), 0) * 100) / 100,
      paidTransferCount: paidTransfer.length,
      paidTransferTotal: Math.round(paidTransfer.reduce((s, o) => s + effectiveOrderAmount(o), 0) * 100) / 100,
    },
    paymentBreakdown: {
      cash: { count: paidCash.length, total: Math.round(paidCash.reduce((s, o) => s + effectiveOrderAmount(o), 0) * 100) / 100 },
      transfer: { count: paidTransfer.length, total: Math.round(paidTransfer.reduce((s, o) => s + effectiveOrderAmount(o), 0) * 100) / 100 },
      pending: { count: pendingVerificationCount, total: pendingVerificationAmount },
      rejected: { count: rejectedCount },
    },
    items,
    history,
    historyCount: createdOrders.length,
    historyLimited: createdOrders.length > limit,
    level: "Not configured",
    levelReason: "Awaiting approved thresholds — showing raw metrics only",
    meta: {
      timezone: "Africa/Addis_Ababa",
      halfOpen: "[from, to)",
      volumeBy: "createdAt",
      revenueBy: "paidAt (fallback paymentVerifiedAt/completedAt)",
      legacyAttribution: "waiterId exact match only; legacy orders without waiterId are excluded (unambiguous)",
      maxHistory: 200,
    },
  };

  return ok(payload, 200);
}

export const GET = withApi(handler);
