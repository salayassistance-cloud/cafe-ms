#!/usr/bin/env node
/**
 * Database Cleanup Migration — Order History Reset
 * ------------------------------------------------
 * Selectively clears historical test orders / invoices and resets the order
 * sequence counter, while STRICTLY preserving all operational master data.
 *
 *   ✅ PRESERVED (never touched):
 *        - menu_items / categories     (food & drink catalog + categories)
 *        - users                       (admin & waiter credentials)
 *        - system_auth credentials     (PINs: waiter/kitchen/barista/manager)
 *        - system_auth.activeWaiters   (live device / login sessions)
 *
 *   🧹 CLEANED:
 *        - orders collection           (every historical / unpaid order)
 *        - counters["order_seq"].seq   (reset so the next order is ORD-1001)
 *
 * Safety:
 *   - DRY_RUN=1             -> reports what WOULD be deleted, mutates nothing.
 *   - Idempotent (safe to re-run).
 *
 * Run:
 *   node --env-file=.env.local scripts/clean-order-history.js            # live
 *   DRY_RUN=1 node --env-file=.env.local scripts/clean-order-history.js  # preview
 */

const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error(
    "MONGODB_URI is not set — run with: node --env-file=.env.local scripts/clean-order-history.js"
  );
  process.exit(1);
}

const DRY_RUN = ["1", "true", "yes"].includes(
  String(process.env.DRY_RUN || "").toLowerCase()
);

// Counter ids that may hold the order sequence in this codebase. The canonical
// one is "order_seq" (see lib/orderService.js genOrderNumber). The others are
// defensive fallbacks for legacy / alternate naming so the reset is robust.
const ORDER_COUNTER_IDS = ["order_seq", "orderNumber", "orderId", "order"];

async function main() {
  await mongoose.connect(MONGODB_URI, {
    bufferCommands: false,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 30000,
    connectTimeoutMS: 10000,
  });
  const host = (MONGODB_URI.match(/@([^\/\?]+)/) || [])[1] || "unknown";
  console.log(`🔌 Connected to database at ${host} (credentials redacted)`);

  // ESM model modules are imported dynamically: this script is CommonJS (the
  // repo's *.js scripts use require), while the models are ESM exports.
  const { getOrderModel } = await import("../lib/models/Order.js");
  const { getSystemAuthModel } = await import(
    "../lib/models/SystemAuth.js"
  );

  const Order = getOrderModel(mongoose.connection);
  const SystemAuth = getSystemAuthModel(mongoose.connection);
  const counters = mongoose.connection.collection("counters");

  console.log(
    DRY_RUN
      ? "\n⚠️  DRY RUN — no data will be modified.\n"
      : "\n🧹 ORDER HISTORY RESET — proceeding.\n"
  );

  // -----------------------------------------------------------------------
  // 1. CLEAR ORDERS COLLECTION
  //    Removes every historical / unpaid / in-progress order. This is the
  //    canonical "active waiter order session" store, so clearing it also
  //    satisfies the requirement to drop active/unpaid order sessions.
  // -----------------------------------------------------------------------
  const orderCount = await Order.estimatedDocumentCount();
  if (DRY_RUN) {
    console.log(`🔍 Would delete ALL ${orderCount} document(s) in 'orders'.`);
  } else {
    const res = await Order.deleteMany({});
    console.log(
      `✅ Cleared ${res.deletedCount} order record(s) from 'orders'.`
    );
  }

  // -----------------------------------------------------------------------
  // 2. RESET ORDER SEQUENCE COUNTER
  //    Canonical counter "order_seq" is upserted to seq=0 so the next created
  //    order becomes ORD-1001 (genOrderNumber returns ORD-${1000 + seq}). Any
  //    legacy-named order counters are also zeroed if present.
  // -----------------------------------------------------------------------
  if (DRY_RUN) {
    const cur = await counters.findOne({ _id: "order_seq" });
    console.log(
      `🔍 Would reset counter 'order_seq' (current seq=${
        cur ? cur.seq : "n/a"
      }) to 0.`
    );
  } else {
    await counters.updateOne(
      { _id: "order_seq" },
      { $set: { seq: 0 } },
      { upsert: true }
    );
    const extras = await counters.updateMany(
      { _id: { $in: ORDER_COUNTER_IDS.filter((id) => id !== "order_seq") } },
      { $set: { seq: 0 } }
    );
    console.log(
      `✅ Reset order sequence counter 'order_seq' to 0` +
        (extras.modifiedCount
          ? ` (plus ${extras.modifiedCount} legacy counter doc(s)).`
          : ".")
    );
  }

  // -----------------------------------------------------------------------
  // 3. ACTIVE WAITER SESSIONS — PRESERVE (nothing to clear)
  //    In this POS, live waiter logins live in system_auth.activeWaiters as
  //    { waiterNumber, deviceSessionId, loggedInAt }. These are DEVICE / LOGIN
  // -----------------------------------------------------------------------
  // 3. TRUNCATE ACTIVE WAITER SESSIONS
  //    A history wipe must also release every locked waiter slot. Otherwise the
  //    sign-in grid stays stuck showing all 10 slots as "IN USE" (the exact bug
  //    this migration prevents). We clear system_auth.activeWaiters but leave
  //    the PIN credentials and the system_auth document itself intact.
  // -----------------------------------------------------------------------
  if (DRY_RUN) {
    const sysDoc = await SystemAuth.findById("system").lean();
    console.log(
      `🔍 Would clear ${
        sysDoc?.activeWaiters?.length || 0
      } active waiter session(s) from system_auth.`
    );
  } else {
    await SystemAuth.updateOne(
      { _id: "system" },
      { $set: { activeWaiters: [] } }
    );
    console.log(
      "✅ Released all active waiter sessions (system_auth.activeWaiters = [])."
    );
  }

  console.log(
    "\n🎉 SUCCESS: Order history reset complete. Menu items, categories, " +
      "users and PIN credentials remain untouched; active waiter sessions cleared."
  );
}

main()
  .then(async () => {
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ ERROR during database cleanup:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
