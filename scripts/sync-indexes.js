const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error(
    "MONGODB_URI is not set — run with: node --env-file=.env.local scripts/sync-indexes.js"
  );
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    const host = (MONGODB_URI.match(/@([^\/\?]+)/) || [])[1] || "unknown";
    console.log(`Connected to database at ${host} (credentials redacted)`);

    const { getOrderModel } = await import("../lib/models/Order.js");
    const Order = getOrderModel(mongoose.connection);
    await Order.syncIndexes();

    console.log("Unified orders indexes synced.");
    console.log(
      "Menu is READ-ONLY from hotel_management.menuitems — this script never touches the menu collections."
    );
    await mongoose.disconnect();
    console.log("Done.");
  } catch (error) {
    console.error("Index sync failed:", error.message);
    process.exitCode = 1;
    await mongoose.disconnect().catch(() => {});
  }
})();
