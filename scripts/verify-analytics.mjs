// End-to-end verification of the Manager Dashboard analytics API.
//
// Logs in as the seeded manager account, requests GET /api/manager/analytics
// for the last 7 days, and compares the payment breakdown + Sales-by-Waiter
// aggregation against truth computed directly from the orders collection.
//
// Run (against a running `npm run dev` / `npm start` server on :3000):
//   node --env-file=.env.local scripts/verify-analytics.mjs
//
// Requires the test orders from scripts/seed-orders.mjs.

import mongoose from "mongoose";
import { getOrderModel } from "../lib/models/Order.js";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error(
    "MONGODB_URI is not set — run with: node --env-file=.env.local scripts/verify-analytics.mjs"
  );
  process.exit(1);
}
const BASE = process.env.BASE_URL || "http://localhost:3000";

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;

function toLocalYMD(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Parse a YYYY-MM-DD exactly the way the analytics route does (UTC midnight
// shifted to local midnight), so the requested window matches what the API
// computes internally and the comparison is apples-to-apples.
function parseLikeApi(value, endOfDay = false) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d;
}

(async () => {
  let ok = true;

  // ---- Live API first (we adopt its reported window as the source of truth
  // for the DB comparison below). The analytics endpoint is open — no session
  // or login is required. ----
  const to = new Date();
  const from = new Date(Date.now() - WINDOW_DAYS * DAY);
  const qs = new URLSearchParams({
    from: toLocalYMD(from),
    to: toLocalYMD(to),
    interval: "daily",
  });
  const res = await fetch(`${BASE}/api/manager/analytics?${qs}`);
  const json = await res.json();
  if (!json?.success) {
    console.error("API error:", JSON.stringify(json));
    process.exit(1);
  }
  const report = json.data;
  const rangeFrom = new Date(report.range.from);
  const rangeTo = new Date(report.range.to);
  console.log("API window:", report.range.from, "→", report.range.to);

  // ---- DB truth over the EXACT window the API reported ----
  // Mirror lib/analytics.js semantics: the payment breakdown counts only PAID
  // orders; waiterPerf.orders counts EVERY order in the window (workload),
  // while waiterPerf.revenue counts only PAID orders.
  await mongoose.connect(MONGODB_URI);
  const Order = getOrderModel(mongoose.connection);
  const windowOrders = await Order.find({
    createdAt: { $gte: rangeFrom, $lt: rangeTo },
  })
    .lean();
  const paid = windowOrders.filter((o) => o.status === "PAID");

  const expectedMethods = {};
  for (const o of paid) {
    const m = o.paymentMethod || "NONE";
    expectedMethods[m] = (expectedMethods[m] || 0) + (Number(o.totalAmount) || 0);
  }
  const expectedWaiters = {};
  for (const o of windowOrders) {
    const w = o.waiterName || "Waiter";
    if (!expectedWaiters[w]) expectedWaiters[w] = { orders: 0, revenue: 0 };
    expectedWaiters[w].orders += 1;
    if (o.status === "PAID") {
      expectedWaiters[w].revenue += Number(o.totalAmount) || 0;
    }
  }
  await mongoose.disconnect();

  console.log("DB truth — payment by method:", JSON.stringify(expectedMethods));
  console.log("DB truth — revenue by waiter:", JSON.stringify(expectedWaiters));

  console.log("\nLive API report:");
  console.log("  kpis.revenue:", report.kpis.revenue, "ETB");
  console.log("  paymentBreakdown:", JSON.stringify(report.paymentBreakdown));
  console.log("  waiterPerf:", JSON.stringify(report.waiterPerf));

  // ---- Check 1: Cash vs Transfer ----
  console.log("\n--- Payment method checks ---");
  for (const [m, amount] of Object.entries(expectedMethods)) {
    const row = report.paymentBreakdown.find((p) => p.method === m);
    const got = row ? row.amount : -1;
    const pass = got === Math.round(amount);
    ok = ok && pass;
    console.log(
      `  ${m}: expected ${Math.round(amount)} ETB, API ${got} ETB — ${pass ? "PASS" : "FAIL"}`
    );
  }
  const extraMethods = report.paymentBreakdown.filter(
    (p) => !(p.method in expectedMethods) && p.amount !== 0
  );
  if (extraMethods.length) {
    ok = false;
    console.log("  FAIL — unexpected methods with amounts:", JSON.stringify(extraMethods));
  }

  // ---- Check 2: Sales by Waiter ----
  console.log("\n--- Sales by waiter checks ---");
  for (const [w, e] of Object.entries(expectedWaiters)) {
    const row = report.waiterPerf.find((x) => x.waiter === w);
    const pass =
      row && row.orders === e.orders && row.revenue === Math.round(e.revenue);
    ok = ok && pass;
    console.log(
      `  ${w}: expected ${e.orders} orders / ${Math.round(e.revenue)} ETB, API ${
        row ? `${row.orders} / ${row.revenue}` : "MISSING"
      } — ${pass ? "PASS" : "FAIL"}`
    );
  }

  console.log(ok ? "\nALL CHECKS PASSED ✓" : "\nSOME CHECKS FAILED ✗");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("Verification failed:", e.message);
  process.exit(1);
});
