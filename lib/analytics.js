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
 * Avoids arbitrary fixed offset hacks; uses IANA timezone database.
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

// Convert Addis wall time (year, month 1-12, day, hour, minute, second, ms) to UTC instant.
// Uses Africa/Addis_Ababa via Intl — no hardcoded offset.
// Wall time -> UTC = wallUTC - offset, where offset = wallUTC - utcTime derived from Intl.
export function addisWallToUTC(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const wallUTC = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  // Derive offset for Africa/Addis_Ababa at this wall instant without hardcoding.
  const probe = new Date(wallUTC);
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
  const parts = fmt.formatToParts(probe);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wallFromProbe = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")),
    Number(get("minute")),
    Number(get("second")),
    probe.getUTCMilliseconds()
  );
  const offsetMs = wallFromProbe - probe.getTime();
  let utcMs = wallUTC - offsetMs;
  // Refine once in case of DST edge (Addis has no DST, but loop ensures correctness)
  for (let i = 0; i < 2; i++) {
    const chk = getAddisParts(new Date(utcMs));
    if (chk.year === year && chk.month === month && chk.day === day && chk.hour === hour && chk.minute === minute && chk.second === second) break;
    const chkDate = new Date(utcMs);
    const chkParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Addis_Ababa",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      hourCycle: "h23",
    }).formatToParts(chkDate);
    const g2 = (t) => chkParts.find((p) => p.type === t)?.value;
    const wall2 = Date.UTC(Number(g2("year")), Number(g2("month")) - 1, Number(g2("day")), Number(g2("hour")), Number(g2("minute")), Number(g2("second")), chkDate.getUTCMilliseconds());
    const off2 = wall2 - chkDate.getTime();
    utcMs = wallUTC - off2;
  }
  return new Date(utcMs);
}

export function addisYMDToUTCStart(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd).trim());
  if (!m) return null;
  return addisWallToUTC(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, 0);
}

export function addisYMDToUTCNextStart(ymd) {
  const start = addisYMDToUTCStart(ymd);
  if (!start) return null;
  return new Date(start.getTime() + 24 * 3600 * 1000);
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
  // Monday 12:00 in Addis time — use canonical Addis conversion so weekday is unambiguous
  // without hardcoding offset.
  const p = getAddisParts(date);
  const addisNoonUTC = addisWallToUTC(p.year, p.month, p.day, 12, 0, 0, 0);
  const dow = (addisNoonUTC.getUTCDay() + 6) % 7; // Monday=0
  const mondayUTC = new Date(addisNoonUTC.getTime() - dow * 24 * 3600 * 1000);
  const mondayParts = getAddisParts(mondayUTC);
  return addisWallToUTC(mondayParts.year, mondayParts.month, mondayParts.day, 12, 0, 0, 0);
}

function getAddisWeekKey(date) {
  const ws = startOfWeekAddis(date);
  const p = getAddisParts(ws);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// Shifts — starts are expressed in the same numeric business-hour value used
// by Peak Hourly (getAddisHour), while names remain in Ethiopian-clock form.
// Peak-hour equivalents of the displayed starts:
//   Shift A starts at 12 ቀን (H=6)
//   Shift B starts at 6:30 ቀን (H=12:30)
//   Shift C starts at 12 ማታ (H=18)
// The starts are evaluated in one circular Peak-hour sequence so every hour
// is assigned exactly once without introducing another timestamp conversion.
export const SHIFT_DEFS = [
  {
    key: "A",
    name: "Shift A · 12 ቀን → 6:30 ቀን (Morning)",
    startHour: 6,
    startMinute: 0,
    startTotal: 6 * 60,
  },
  {
    key: "B",
    name: "Shift B · 6:30 ቀን → 12 ቀን (Afternoon)",
    startHour: 12,
    startMinute: 30,
    startTotal: 12 * 60 + 30,
  },
  {
    key: "C",
    name: "Shift C · 12 ማታ → 6 ማታ (Evening)",
    startHour: 18,
    startMinute: 0,
    startTotal: 18 * 60,
  },
];

// Ordered by the same Peak Hourly numeric H value used for classification.
// This is ordering metadata, not a second time interpretation.
const SHIFT_SORTED = [...SHIFT_DEFS].sort((a, b) => a.startTotal - b.startTotal);

export function getShiftForAddisTime(hour, minute, second = 0, ms = 0) {
  const total = hour * 60 + minute + second / 60 + ms / 60000;
  // The final start wraps around for H values before the first start.
  let selected = SHIFT_SORTED[SHIFT_SORTED.length - 1];
  for (const s of SHIFT_SORTED) {
    if (s.startTotal <= total) selected = s;
    else break;
  }
  return selected;
}

export function getShiftForDate(date) {
  // H must come from getAddisHour(), exactly as in Peak Hourly aggregation.
  // The minute is only needed for the displayed 6:30 boundary.
  const peakHour = getAddisHour(date);
  const p = getAddisParts(date);
  const ms = new Date(date).getMilliseconds();
  return getShiftForAddisTime(peakHour, p.minute, p.second, ms);
}

export function getCurrentShiftAddis(now = new Date()) {
  return getShiftForDate(now);
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

  // Shifts consume the same Peak Hourly H value for each order.
  const shiftBuckets = {
    A: [],
    B: [],
    C: [],
  };
  for (const o of currentOrders) {
    const shift = getShiftForDate(o.createdAt);
    if (shift.key === "A") shiftBuckets.A.push(o);
    else if (shift.key === "B") shiftBuckets.B.push(o);
    else if (shift.key === "C") shiftBuckets.C.push(o);
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
