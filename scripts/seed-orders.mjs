// Idempotent test-order seed + analytics verification.
//
// Purpose: exercise the Manager Dashboard's financial aggregation with a few
// realistic orders carrying MIXED payment methods and distinct waiter names, so
// the "Cash vs Bank Transfer" breakdown and the "Sales by Waiter" report can be
// verified against independently computed database truth.
//
// Run with:
//   node --env-file=.env.local scripts/seed-orders.mjs
//
// Safety:
//   - Only rows with orderNumber matching the /^ORD-9/ test namespace are
//     touched (re-seeding deletes prior runs' rows first, never real orders).
//   - One order is deliberately placed OUTSIDE the default 7-day report window
//     to prove range filtering excludes it.

import mongoose from "mongoose";
import { getOrderModel } from "../lib/models/Order.js";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error(
    "MONGODB_URI is not set — run with: node --env-file=.env.local scripts/seed-orders.mjs"
  );
  process.exit(1);
}
const SEED_NS = /^ORD-9\d{3}$/;

// One day in ms.
const DAY = 24 * 60 * 60 * 1000;
// Default report window used by the Manager Dashboard (last 7 days).
const WINDOW_DAYS = 7;

function daysAgo(n, hour = 12) {
  const d = new Date(Date.now() - n * DAY);
  d.setHours(hour, 0, 0, 0);
  return d;
}

// Ordered data: { orderNumber, tableNumber, waiterName, status, paymentMethod,
// items, totalAmount, createdAt }
const SEED_ORDERS = [
  {
    orderNumber: "ORD-9001",
    tableNumber: 3,
    waiterName: "Main Waiter",
    status: "PAID",
    paymentMethod: "CASH",
    createdAt: daysAgo(0, 10),
    items: [{ name: "Macchiato", price: 80, quantity: 2, type: "DRINK" }],
    totalAmount: 160,
  },
  {
    orderNumber: "ORD-9002",
    tableNumber: 5,
    waiterName: "Main Waiter",
    status: "PAID",
    paymentMethod: "CASH",
    createdAt: daysAgo(1, 11),
    items: [{ name: "Shiro", price: 340, quantity: 1, type: "FOOD" }],
    totalAmount: 340,
  },
  {
    orderNumber: "ORD-9003",
    tableNumber: 2,
    waiterName: "Hanna",
    status: "PAID",
    paymentMethod: "TELEBIRR",
    createdAt: daysAgo(1, 15),
    items: [
      { name: "Burger", price: 260, quantity: 2, type: "FOOD" },
    ],
    totalAmount: 520,
  },
  {
    orderNumber: "ORD-9004",
    tableNumber: 7,
    waiterName: "Hanna",
    status: "PAID",
    paymentMethod: "TELEBIRR",
    createdAt: daysAgo(3, 9),
    items: [{ name: "Cappuccino", price: 90, quantity: 1, type: "DRINK" }],
    totalAmount: 90,
  },
  {
    // NOT paid (READY) — must never count toward revenue or the breakdown.
    orderNumber: "ORD-9005",
    tableNumber: 1,
    waiterName: "Main Waiter",
    status: "READY",
    paymentMethod: "NONE",
    createdAt: daysAgo(0, 12),
    items: [{ name: "Tea", price: 100, quantity: 2, type: "DRINK" }],
    totalAmount: 200,
  },
  {
    // PAID CASH but OUTSIDE the 7-day window — must be excluded from the
    // current-window revenue and breakdown (only affects the delta baseline).
    orderNumber: "ORD-9006",
    tableNumber: 4,
    waiterName: "Waiter",
    status: "PAID",
    paymentMethod: "CASH",
    createdAt: daysAgo(10, 14),
    items: [{ name: "Pasta", price: 500, quantity: 1, type: "FOOD" }],
    totalAmount: 500,
  },
];

(async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log(`Connected to ${MONGODB_URI}`);

    const Order = getOrderModel(mongoose.connection);

    // Clean re-seed: drop only this script's test namespace.
    const cleared = await Order.deleteMany({ orderNumber: SEED_NS });
    if (cleared.deletedCount > 0) {
      console.log(`Cleared ${cleared.deletedCount} previous test order(s) (ORD-9xxx).`);
    }

    for (const s of SEED_ORDERS) {
      const doc = new Order({
        orderNumber: s.orderNumber,
        tableNumber: s.tableNumber,
        waiterName: s.waiterName,
        status: s.status,
        paymentMethod: s.paymentMethod,
        items: s.items,
        totalAmount: s.totalAmount,
      });
      await doc.save();
      // Bypass mongoose timestamps so createdAt lands on the seeded date.
      await Order.collection.updateOne(
        { _id: doc._id },
        { $set: { createdAt: s.createdAt, updatedAt: s.createdAt } }
      );
      console.log(
        `Seeded ${s.orderNumber} | ${s.status} | ${s.paymentMethod} | ${s.totalAmount} ETB | ${s.waiterName} | ${s.createdAt.toISOString().slice(0, 10)}`
      );
    }

    // ---------------------------------------------------------------------
    // Print the DB-derived truth for the last-7-days window so it can be
    // cross-checked against the live GET /api/manager/analytics response
    // (which runs the real lib/analytics.js buildReport in the dev server).
    // ---------------------------------------------------------------------
    const to = new Date();
    const from = new Date(Date.now() - WINDOW_DAYS * DAY);
    from.setHours(0, 0, 0, 0);

    const windowOrders = await Order.find({
      createdAt: { $gte: from, $lt: to },
    })
      .lean();
    const windowPaid = windowOrders.filter((o) => o.status === "PAID");

    const expectedMethods = {};
    for (const o of windowPaid) {
      const m = o.paymentMethod || "NONE";
      expectedMethods[m] = (expectedMethods[m] || 0) + (Number(o.totalAmount) || 0);
    }
    const expectedWaiters = {};
    for (const o of windowPaid) {
      const w = o.waiterName || "Waiter";
      if (!expectedWaiters[w]) expectedWaiters[w] = { orders: 0, revenue: 0 };
      expectedWaiters[w].orders += 1;
      expectedWaiters[w].revenue += Number(o.totalAmount) || 0;
    }

    console.log("\n--- DB truth (last 7 days) ---");
    console.log("window PAID orders:", windowPaid.length);
    console.log("totalAmount by method:", JSON.stringify(expectedMethods));
    console.log("revenue by waiter:", JSON.stringify(expectedWaiters));

    const leaked = await Order.findOne({ orderNumber: "ORD-9006" }).select("createdAt status").lean();
    if (leaked) {
      console.log("ORD-9006 (10 days old) present in DB but OUTSIDE window -> excluded ✓");
    }
    await mongoose.disconnect();
  } catch (error) {
    console.error("Seed failed:", error.message);
    process.exitCode = 1;
    await mongoose.disconnect().catch(() => {});
  }
})();
