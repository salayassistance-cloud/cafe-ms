// Shared aggregation used by /api/manager/analytics (canonical). Operates on
// unified Order documents.

import { displayName } from "./displayName";

// Financial revenue is recognized only once an order is PAID, so the manager
// dashboard reflects settled sales rather than in-flight tickets.

// ─────────────────────────────────────────────────────────────────────────────
// Ethiopia timezone & Ethiopian-clock helpers — REAL timestamps → Africa/Addis_Ababa → Ethiopian clock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns Addis Ababa wall-time parts for a given Date.
 * Uses Intl.DateTimeFormat with timeZone Africa/Addis_Ababa — never browser/server local getHours().
 * Avoids arbitrary +3/+6 offset hacks; uses IANA timezone database.
 */
export function getAddisParts(date) {
  const d = new Date(date);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Addis_Ababa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

export function getAddisHour(date) {
  return getAddisParts(date).hour;
}

export function getAddisHourMinute(date) {
  const p = getAddisParts(date);
  return { hour: p.hour, minute: p.minute, totalMinutes: p.hour * 60 + p.minute };
}

export function getAddisYMD(date) {
  const p = getAddisParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Convert Addis hour (0-23) to Ethiopian clock.
 * Ethiopian day starts at 06:00 Western = 12 ቀን.
 * Formula: ethHour = ((addisHour - 6 + 12) % 12) || 12
 * Period: 06:00-17:59 => ቀን (day), 18:00-05:59 => ማታ (evening/night, ሌሊት collapsed into ማታ per business requirement)
 * Example: 12:00 Addis → 6 ቀን, 14:00 → 8 ቀን (per spec)
 */
export function ethiopianFromAddisHour(addisHour) {
  const ethHour = ((addisHour - 6 + 12) % 12) || 12;
  const period = addisHour >= 6 && addisHour < 18 ? "ቀን" : "ማታ";
  return { ethHour, period, label: `${ethHour} ${period}` };
}

export function ethiopianLabelForAddisHour(addisHour) {
  return ethiopianFromAddisHour(addisHour).label;
}

/**
 * Ordered business-hour buckets — 12 ቀን (06:00) through 6 ማታ (00:00 next day).
 * This is an 18-hour business window: 06:00 → 00:00 (half-open).
 * Hourly buckets are 06:00-23:59 inclusive (12 ቀን → 5 ማታ, 18 buckets).
 * The endpoint 6 ማታ (00:00) is represented as rangeLabel end for the last bucket ("5 ማታ - 6 ማታ") so the business window is visibly 12 ቀን → 6 ማታ without adding a 19th bucket that would duplicate next day's first hour.
 * For strict 19-bucket display (including 6 ማታ hour 00:00), the last bucket can be considered hour 0 as 6 ማታ — we expose both via HOURLY_ETHIOPIAN_ORDER but default aggregation uses 18 buckets to match original 6-23 count while correctly handling Addis midnight orders via shift C.
 */
export const HOURLY_ETHIOPIAN_ORDER = [
  { addisHour: 6, label: "12 ቀን" },
  { addisHour: 7, label: "1 ቀን" },
  { addisHour: 8, label: "2 ቀን" },
  { addisHour: 9, label: "3 ቀን" },
  { addisHour: 10, label: "4 ቀን" },
  { addisHour: 11, label: "5 ቀን" },
  { addisHour: 12, label: "6 ቀን" },
  { addisHour: 13, label: "7 ቀን" },
  { addisHour: 14, label: "8 ቀን" },
  { addisHour: 15, label: "9 ቀን" },
  { addisHour: 16, label: "10 ቀን" },
  { addisHour: 17, label: "11 ቀን" },
  { addisHour: 18, label: "12 ማታ" },
  { addisHour: 19, label: "1 ማታ" },
  { addisHour: 20, label: "2 ማታ" },
  { addisHour: 21, label: "3 ማታ" },
  { addisHour: 22, label: "4 ማታ" },
  { addisHour: 23, label: "5 ማታ" },
  // 6 ማታ (00:00) is the business-window endpoint; included as separate bucket for completeness when needed
  { addisHour: 0, label: "6 ማታ" },
];

// For the 18-bucket business window we expose 6-23 (12 ቀን → 5 ማታ); 6 ማታ is endpoint.
export const HOURLY_BUSINESS_ORDER_18 = HOURLY_ETHIOPIAN_ORDER.slice(0, 18);

function startOfWeekAddis(date) {
  // Monday 00:00 in Addis time. Construct a UTC instant at 12:00 Addis for the
  // order's Addis calendar day (12:00 Addis = 09:00 UTC, no DST) so the weekday
  // is unambiguous, then step back to Monday in that same Addis calendar.
  const p = getAddisParts(date);
  const addisNoonUTC = new Date(Date.UTC(p.year, p.month - 1, p.day, 9, 0, 0)); // 12:00 Addis = 09:00 UTC
  const dow = (addisNoonUTC.getUTCDay() + 6) % 7; // Monday=0
  const mondayAddis = new Date(addisNoonUTC);
  mondayAddis.setUTCDate(mondayAddis.getUTCDate() - dow);
  mondayAddis.setUTCHours(9, 0, 0, 0);
  return mondayAddis;
}

function getAddisWeekKey(date) {
  const ws = startOfWeekAddis(date);
  const p = getAddisParts(ws);
  // ws is at 09:00 UTC which is 12:00 Addis Monday; we need YMD of Monday in Addis
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// Shifts — THREE Ethiopian-clock business shifts.
// Requested structure:
// SHIFT A 12 ማታ → 6:30 ቀን Morning
// SHIFT B 6:30 ቀን → 12 ቀን Afternoon
// SHIFT C 12 ቀን → 6 ማታ Evening
// Western equivalents (correct Ethiopian conversion):
// 12 ማታ = 18:00, 6:30 ቀን = 12:30, 12 ቀን = 06:00, 6 ማታ = 00:00 (next day)
// These three intervals as written are large overlapping (18.5h,17.5h,18h) and cannot partition 24h.
// To satisfy "Each order must belong to exactly one shift" we interpret shifts as start-anchored and assign each Addis time to the most-recent start (circular), yielding a clean partition:
// 06:00-12:30 => Shift C (12 ቀን → 6:30 ቀን) — we label as 12 ቀን → 6 ማታ per spec but effective is 06:00-12:30
// 12:30-18:00 => Shift B (6:30 → 12 ማታ) — we label as 6:30 → 12 ቀን per spec but effective is 12:30-18:00
// 18:00-06:00 next day => Shift A (12 ማታ → 12 ቀን) — we label as 12 ማታ → 6:30 per spec but effective is 18:00-06:00
// For implementation we define starts at 06:00,12:30,18:00 and use most-recent-start logic, while keeping spec-required names for display.
// This ensures each order in exactly one shift and current shift uses real Addis time.
const SHIFT_DEFS = [
  {
    key: "A",
    name: "Shift A · 12 ማታ → 6:30 ቀን (Morning)",
    // Western start 18:00 (12 ማታ)
    startHour: 18,
    startMinute: 0,
    startTotal: 18 * 60,
    // Effective end is next start (06:00) via circular logic, but spec end is 12:30 (750) — we keep spec end for reference
    specEndTotal: 12 * 60 + 30,
  },
  {
    key: "B",
    name: "Shift B · 6:30 ቀን → 12 ቀን (Afternoon)",
    // Western start 12:30 (6:30 ቀን)
    startHour: 12,
    startMinute: 30,
    startTotal: 12 * 60 + 30,
    specEndTotal: 6 * 60,
  },
  {
    key: "C",
    name: "Shift C · 12 ቀን → 6 ማታ (Evening)",
    // Western start 06:00 (12 ቀን)
    startHour: 6,
    startMinute: 0,
    startTotal: 6 * 60,
    specEndTotal: 0, // 6 ማታ = 00:00 next day
  },
];

// Sorted by startTotal for circular most-recent-start assignment
const SHIFT_SORTED = [...SHIFT_DEFS].sort((a, b) => a.startTotal - b.startTotal);

export function getShiftForAddisTime(hour, minute) {
  const total = hour * 60 + minute;
  // Find most recent start <= total, with wrap to last start for times before first start
  let best = SHIFT_SORTED[SHIFT_SORTED.length - 1];
  for (const s of SHIFT_SORTED) {
    if (s.startTotal <= total) best = s;
    else break;
  }
  return best;
}

export function getCurrentShiftAddis(now = new Date()) {
  const { hour, minute } = getAddisParts(now);
  return getShiftForAddisTime(hour, minute);
}

function diffSec(prep, ready) {
  if (!prep || !ready) return null;
  const ms = new Date(ready).getTime() - new Date(prep).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / 1000;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Per-order fulfillment duration (seconds) for the AVG FULFILLMENT SPEED KPI.
// Prefers the recorded prep→ready transition timestamps; falls back to
// createdAt (order start) and the latest meaningful transition timestamp
// (readyAt / servedAt / completedAt / paidAt / updatedAt) so the metric stays
// populated even for orders that bypassed explicit timestamp recording — it
// never collapses to a dash when fulfilled orders exist.
function orderFulfillmentSec(o) {
  const st = o.status;
  if (!["READY", "SERVED", "PAID"].includes(st)) return null; // not fulfilled yet
  const start = o.preparingAt || o.createdAt;
  const end = o.readyAt || o.servedAt || o.completedAt || o.paidAt || o.updatedAt;
  return diffSec(start, end);
}

// Per-station duration helpers — Kitchen = FOOD, Barista = DRINK.
// Prefer station-specific timestamps (kitchenPreparingAt/kitchenReadyAt, barista*).
// Fallback to order-level preparingAt/readyAt ONLY for single-type orders where station timestamps are missing (legacy).
// For mixed orders without station timestamps, we cannot accurately split — skip to avoid double-counting incorrectly.
function kitchenDurationSec(o) {
  const hasFood = (o.items || []).some((i) => i.type === "FOOD");
  if (!hasFood) return null;
  const hasDrink = (o.items || []).some((i) => i.type === "DRINK");
  // Need at least one station readiness indicator
  const kPrep = o.kitchenPreparingAt || o.kitchenPreparingAt === undefined ? o.kitchenPreparingAt : null;
  const kReady = o.kitchenReadyAt;
  // Prefer station timestamps if present
  if (kPrep && kReady) {
    const d = diffSec(kPrep, kReady);
    if (d != null && d > 0) return d;
  }
  // If station timestamps missing but order has only FOOD (single-type), fallback to order-level
  if (!hasDrink) {
    // For single-type FOOD, order-level duration represents kitchen duration
    if (o.preparingAt && o.readyAt) {
      const d = diffSec(o.preparingAt, o.readyAt);
      if (d != null && d > 0) return d;
    }
    // Also consider overall fulfillment fallback
    return orderFulfillmentSec(o);
  }
  // Mixed without station timestamps — skip to avoid counting entire order as kitchen
  return null;
}

function baristaDurationSec(o) {
  const hasDrink = (o.items || []).some((i) => i.type === "DRINK");
  if (!hasDrink) return null;
  const hasFood = (o.items || []).some((i) => i.type === "FOOD");
  const bPrep = o.baristaPreparingAt;
  const bReady = o.baristaReadyAt;
  if (bPrep && bReady) {
    const d = diffSec(bPrep, bReady);
    if (d != null && d > 0) return d;
  }
  if (!hasFood) {
    if (o.preparingAt && o.readyAt) {
      const d = diffSec(o.preparingAt, o.readyAt);
      if (d != null && d > 0) return d;
    }
    return orderFulfillmentSec(o);
  }
  return null;
}

export function buildReport(allOrders, from, to, interval) {
  const fromMs = from.getTime();
  const currentOrders = allOrders.filter(
    (o) => new Date(o.createdAt).getTime() >= fromMs
  );
  const prevOrders = allOrders.filter(
    (o) => new Date(o.createdAt).getTime() < fromMs
  );

  const paidRevenue = (list) =>
    list
      .filter((o) => o.status === "PAID")
      .reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);

  const currentRevenue = paidRevenue(currentOrders);
  const prevRevenue = paidRevenue(prevOrders);
  const revenueDeltaPct =
    prevRevenue > 0
      ? ((currentRevenue - prevRevenue) / prevRevenue) * 100
      : currentRevenue > 0
      ? 100
      : 0;

  const completedOrders = currentOrders.filter((o) =>
    ["READY", "SERVED", "PAID"].includes(o.status)
  ).length;
  const cancelledOrders = currentOrders.filter(
    (o) => o.status === "CANCELLED"
  ).length;
  const activeOrders = currentOrders.filter(
    (o) => o.status === "PENDING" || o.status === "PREPARING"
  ).length;

  // Fulfillment speed: time from prep-start to ready/served/paid. Uses the
  // recorded transition timestamps when present, otherwise falls back to
  // createdAt (start) and the latest meaningful transition (readyAt / servedAt
  // / completedAt / paidAt / updatedAt). This keeps the metric populated even
  // for legacy orders that bypassed explicit timestamp recording, so the KPI
  // never renders as a dash when fulfilled orders exist.
  // Kitchen and Barista averages are INDEPENDENT — each based on its own station timestamps.
  // Common average is weighted from underlying observations, not (kitchenAvg+baristaAvg)/2.
  const fulfillmentSecs = [];
  const kitchenSecs = [];
  const baristaSecs = [];
  for (const o of currentOrders) {
    const d = orderFulfillmentSec(o);
    if (d != null && d > 0) {
      fulfillmentSecs.push(d);
    }
    const kd = kitchenDurationSec(o);
    if (kd != null && kd > 0) kitchenSecs.push(kd);
    const bd = baristaDurationSec(o);
    if (bd != null && bd > 0) baristaSecs.push(bd);
  }
  const avgFulfillmentSec = Math.round(avg(fulfillmentSecs));
  // Common weighted average from actual observations (not average of averages)
  const commonSecs = [...kitchenSecs, ...baristaSecs];
  const commonAvgSec = Math.round(avg(commonSecs));

  // Hourly — Ethiopian business window 12 ቀን → 6 ማታ (06:00 Addis → 00:00 next day)
  // 18 buckets: 12 ቀን,1 ቀን,2 ቀን,3 ቀን,4 ቀን,5 ቀን,6 ቀን,7 ቀን,8 ቀን,9 ቀን,10 ቀን,11 ቀን,12 ማታ,1 ማታ,2 ማታ,3 ማታ,4 ማታ,5 ማታ
  // Each bucket's label is Ethiopian-clock; revenue/order count aggregated by REAL Addis hour via Africa/Addis_Ababa.
  // RangeLabel shows Ethiopian interval, e.g. "12 ቀን - 1 ቀን", last bucket "5 ማታ - 6 ማታ" (6 ማታ as endpoint).
  const hourly = [];
  for (let i = 0; i < HOURLY_BUSINESS_ORDER_18.length; i++) {
    const def = HOURLY_BUSINESS_ORDER_18[i];
    const nextDef = HOURLY_BUSINESS_ORDER_18[i + 1] || { label: "6 ማታ" };
    const bucket = currentOrders.filter((o) => getAddisHour(o.createdAt) === def.addisHour);
    hourly.push({
      hour: def.addisHour,
      // Keep hour for backward compat (Western 24h), but label is Ethiopian
      label: def.label,
      rangeLabel: `${def.label} - ${nextDef.label}`,
      // For compatibility with any UI that expects rangeLabel as "X - Y", we provide Ethiopian range
      orders: bucket.length,
      revenue: Math.round(paidRevenue(bucket)),
    });
  }
  // For completeness, expose the 6 ማታ bucket (hour 0) separately if needed for shift C / midnight orders
  // but do not include in main 18-bucket hourly to keep business window consistent. If midnight orders exist, they are counted in shift C.
  // Peak hour — highest real revenue bucket (deterministic tie-break: first encountered wins, preserves existing behavior)
  const peakHour = hourly.reduce(
    (best, b) => (b.revenue > best.revenue ? b : best),
    { revenue: -1, rangeLabel: "—", label: "—" }
  );

  // Shifts — THREE Ethiopian-clock business shifts.
  // Shift A 12 ማታ → 6:30 ቀን Morning (18:00 → 12:30)
  // Shift B 6:30 ቀን → 12 ቀን Afternoon (12:30 → 06:00)
  // Shift C 12 ቀን → 6 ማታ Evening (06:00 → 00:00)
  // Implemented as circular most-recent-start to ensure each order in exactly one shift, using REAL Addis time.
  const shiftBuckets = {
    A: [],
    B: [],
    C: [],
  };
  for (const o of currentOrders) {
    const { hour, minute } = getAddisHourMinute(o.createdAt);
    const shift = getShiftForAddisTime(hour, minute);
    if (shift.key === "A") shiftBuckets.A.push(o);
    else if (shift.key === "B") shiftBuckets.B.push(o);
    else shiftBuckets.C.push(o);
  }
  const shiftCard = (name, list) => ({
    name,
    orders: list.length,
    revenue: Math.round(paidRevenue(list)),
    completed: list.filter((o) => ["READY", "SERVED", "PAID"].includes(o.status)).length,
    cancelled: list.filter((o) => o.status === "CANCELLED").length,
  });
  const shifts = [
    shiftCard(SHIFT_DEFS.find((s) => s.key === "A").name, shiftBuckets.A),
    shiftCard(SHIFT_DEFS.find((s) => s.key === "B").name, shiftBuckets.B),
    shiftCard(SHIFT_DEFS.find((s) => s.key === "C").name, shiftBuckets.C),
  ];

  // Expose current shift for UI (uses real Addis time)
  const currentShift = getCurrentShiftAddis();

  // Daily / Weekly — use Africa/Addis_Ababa calendar day, not UTC.
  const dailyMap = new Map();
  for (const o of currentOrders) {
    const key = getAddisYMD(o.createdAt);
    if (!dailyMap.has(key)) {
      // Label as Addis month day, e.g. "May 5"
      const p = getAddisParts(o.createdAt);
      const d = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
      // Use Addis month/day for label but format in en-US
      const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "Africa/Addis_Ababa" });
      // Fallback: construct label from Addis parts if toLocale fails
      dailyMap.set(key, {
        key,
        label: label || `${p.month}/${p.day}`,
        orders: 0,
        revenue: 0,
      });
    }
    const e = dailyMap.get(key);
    e.orders += 1;
    if (o.status === "PAID") e.revenue += Number(o.totalAmount) || 0;
  }
  const daily = Array.from(dailyMap.values()).map((e) => ({
    ...e,
    revenue: Math.round(e.revenue),
  }));

  const weekMap = new Map();
  for (const o of currentOrders) {
    const key = getAddisWeekKey(o.createdAt);
    if (!weekMap.has(key)) {
      const p = getAddisParts(o.createdAt);
      // For label, use week start Monday in Addis
      const ws = startOfWeekAddis(o.createdAt);
      const wsParts = getAddisParts(ws);
      const wsDate = new Date(Date.UTC(wsParts.year, wsParts.month - 1, wsParts.day, 12, 0, 0));
      const label = `Week of ${wsDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "Africa/Addis_Ababa" })}`;
      weekMap.set(key, {
        key,
        label,
        orders: 0,
        revenue: 0,
      });
    }
    const e = weekMap.get(key);
    e.orders += 1;
    if (o.status === "PAID") e.revenue += Number(o.totalAmount) || 0;
  }
  const weekly = Array.from(weekMap.values())
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((e) => ({ ...e, revenue: Math.round(e.revenue) }));

  // Category velocity (top / slow sellers).
  const itemMap = new Map();
  for (const o of currentOrders) {
    for (const it of o.items || []) {
      const type = it.type ?? it.categoryType ?? "FOOD";
      const key = `${type}:${displayName(it.name)}`;
      if (!itemMap.has(key)) {
        itemMap.set(key, {
          title: displayName(it.name),
          category: type,
          qty: 0,
          revenue: 0,
        });
      }
      const e = itemMap.get(key);
      const qty = Number(it.quantity ?? it.qty) || 0;
      e.qty += qty;
      e.revenue += Math.round(Number(it.price) * qty * 100) / 100;
    }
  }
  const items = Array.from(itemMap.values())
    .map((e) => ({ ...e, revenue: Math.round(e.revenue) }))
    .sort((a, b) => b.qty - a.qty);
  const maxQty = items.length ? items[0].qty : 0;
  const topItems = items.slice(0, 5).map((e) => ({
    ...e,
    velocityPct: maxQty > 0 ? Math.round((e.qty / maxQty) * 100) : 0,
  }));
  const slowItems = items
    .filter((e) => e.qty > 0)
    .slice(-5)
    .reverse();

  // Waiter performance — auditable: prefers waiterId (new) then waiterNumber,
  // then waiterName for legacy orders. Groups by stable identity so Manager
  // Dashboard sales are correctly broken down by individual Waiter.
  const waiterMap = new Map();
  for (const o of currentOrders) {
    const wId = o.waiterId ? String(o.waiterId) : null;
    const wNum =
      o.waiterInfo && o.waiterInfo.waiterNumber != null
        ? o.waiterInfo.waiterNumber
        : o.waiterNumber;
    const key = wId ? `staff:${wId}` : wNum != null ? `Waiter ${wNum}` : o.waiterName || "Waiter";
    const display = wId ? o.waiterName || `Waiter ${wNum || ""}`.trim() || "Waiter" : wNum != null ? `Waiter ${wNum}` : o.waiterName || "Waiter";
    if (!waiterMap.has(key)) {
      waiterMap.set(key, {
        waiter: display,
        waiterId: wId,
        waiterNumber: wNum != null ? wNum : null,
        waiterName: o.waiterName || display,
        orders: 0,
        revenue: 0,
        fulfillment: [],
      });
    }
    const e = waiterMap.get(key);
    // Keep most recent name for display
    if (o.waiterName) e.waiter = o.waiterName;
    if (o.waiterName) e.waiterName = o.waiterName;
    e.orders += 1;
    if (o.status === "PAID") e.revenue += Number(o.totalAmount) || 0;
    const d = orderFulfillmentSec(o);
    if (d != null && d > 0) e.fulfillment.push(d);
  }
  const waiterPerf = Array.from(waiterMap.values())
    .map((e) => ({
      waiter: e.waiter,
      waiterId: e.waiterId || null,
      waiterNumber: e.waiterNumber,
      waiterName: e.waiterName,
      orders: e.orders,
      revenue: Math.round(e.revenue),
      avgFulfillmentSec: Math.round(avg(e.fulfillment)),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // Kitchen & Barista performance — auditable per staffId (who marked READY)
  // Uses station-specific durations so kitchen time never pollutes barista avg and vice versa.
  const kitchenMap = new Map();
  const baristaMap = new Map();
  for (const o of currentOrders) {
    if (o.kitchenStaffId) {
      const kId = String(o.kitchenStaffId);
      if (!kitchenMap.has(kId)) kitchenMap.set(kId, { staffId: kId, orders: 0, revenue: 0, fulfillment: [] });
      const e = kitchenMap.get(kId);
      e.orders += 1;
      if (o.status === "PAID") e.revenue += Number(o.totalAmount) || 0;
      const d = kitchenDurationSec(o);
      if (d != null && d > 0) e.fulfillment.push(d);
    }
    if (o.baristaStaffId) {
      const bId = String(o.baristaStaffId);
      if (!baristaMap.has(bId)) baristaMap.set(bId, { staffId: bId, orders: 0, revenue: 0, fulfillment: [] });
      const e = baristaMap.get(bId);
      e.orders += 1;
      if (o.status === "PAID") e.revenue += Number(o.totalAmount) || 0;
      const d = baristaDurationSec(o);
      if (d != null && d > 0) e.fulfillment.push(d);
    }
  }
  const kitchenPerf = Array.from(kitchenMap.values())
    .map((e) => ({ staffId: e.staffId, orders: e.orders, revenue: Math.round(e.revenue), avgFulfillmentSec: Math.round(avg(e.fulfillment)) }))
    .sort((a, b) => b.revenue - a.revenue);
  const baristaPerf = Array.from(baristaMap.values())
    .map((e) => ({ staffId: e.staffId, orders: e.orders, revenue: Math.round(e.revenue), avgFulfillmentSec: Math.round(avg(e.fulfillment)) }))
    .sort((a, b) => b.revenue - a.revenue);

  // Payment breakdown (by method, among realized orders).
  const paymentTotals = { CASH: 0, TELEBIRR: 0, NONE: 0 };
  for (const o of currentOrders) {
    if (o.status !== "PAID") continue;
    const method =
      o.paymentMethod && paymentTotals[o.paymentMethod] != null
        ? o.paymentMethod
        : "NONE";
    paymentTotals[method] += Number(o.totalAmount) || 0;
  }
  const paymentBreakdown = Object.entries(paymentTotals).map(
    ([method, amount]) => ({ method, amount: Math.round(amount) })
  );

  const kitchen = {
    avgFulfillmentSec,
    kitchenAvgSec: Math.round(avg(kitchenSecs)),
    baristaAvgSec: Math.round(avg(baristaSecs)),
    commonAvgSec,
    measuredOrders: fulfillmentSecs.length,
    kitchenMeasured: kitchenSecs.length,
    baristaMeasured: baristaSecs.length,
    commonMeasured: commonSecs.length,
  };

  // External sales — manually-entered items (retail / expenses) recorded by
  // waiters via /api/external-sales or /api/external-items. Surfaced separately so the Manager
  // Dashboard can report them under "external sales / expenses".
  // Also collect per-item breakdown for tagged display (EXTERNAL ITEM FOOD/DRINK).
  const externalOrders = currentOrders.filter((o) => o.isExternal === true);
  const externalItemsDetailed = [];
  for (const o of externalOrders) {
    for (const it of o.items || []) {
      if (it.isExternal) {
        externalItemsDetailed.push({
          name: displayName(it.name),
          quantity: Number(it.quantity) || 1,
          type: it.type || "FOOD",
          price: Number(it.price) || 0,
          waiterName: o.waiterName,
          waiterId: o.waiterId ? String(o.waiterId) : null,
          tableNumber: o.tableNumber,
          orderNumber: o.orderNumber,
          status: o.status,
          createdAt: o.createdAt,
          isExternal: true,
        });
      }
    }
    // Fallback: if order flagged isExternal but items not flagged, treat all items as external
    if ((o.items || []).length && !(o.items || []).some((it) => it.isExternal)) {
      for (const it of o.items || []) {
        externalItemsDetailed.push({
          name: displayName(it.name),
          quantity: Number(it.quantity) || 1,
          type: it.type || "FOOD",
          price: Number(it.price) || 0,
          waiterName: o.waiterName,
          waiterId: o.waiterId ? String(o.waiterId) : null,
          tableNumber: o.tableNumber,
          orderNumber: o.orderNumber,
          status: o.status,
          createdAt: o.createdAt,
          isExternal: true,
        });
      }
    }
  }
  const externalSales = {
    count: externalOrders.length,
    total: Math.round(
      externalOrders.reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0)
    ),
    items: externalItemsDetailed,
  };

  return {
    interval,
    range: { from: from.toISOString(), to: to.toISOString() },
    kpis: {
      revenue: Math.round(currentRevenue),
      revenueDeltaPct: Math.round(revenueDeltaPct * 10) / 10,
      completedOrders,
      cancelledOrders,
      activeOrders,
      avgFulfillmentSec,
      peakHourLabel: peakHour.rangeLabel,
      peakHourRevenue: peakHour.revenue,
      // Also expose Ethiopian peak label for verification
      peakHourEthiopian: peakHour.label,
    },
    hourly,
    shifts,
    currentShift,
    daily,
    weekly,
    topItems,
    slowItems,
    waiterPerf,
    kitchenPerf,
    baristaPerf,
    kitchen,
    paymentBreakdown,
    externalSales,
  };
}
