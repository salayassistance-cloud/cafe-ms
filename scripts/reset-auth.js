// Dev helper: resets the `system_auth` document — restores the default PINs
// (stored scrypt-hashed) AND force-clears any locked waiter numbers. Only
// touches system_auth; orders and menu collections are never affected.
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error(
    "MONGODB_URI is not set — run with: node --env-file=.env.local scripts/reset-auth.js"
  );
  process.exit(1);
}

const DEFAULT_PINS = {
  WAITER: "1111",
  KITCHEN: "2222",
  BARISTA: "3333",
  MANAGER: "4444",
};

(async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    const host = (MONGODB_URI.match(/@([^\/\?]+)/) || [])[1] || "unknown";
    console.log(`Connected to database at ${host} (credentials redacted)`);

    const [{ default: SystemAuth }, { hashPin }] = await Promise.all([
      import("../lib/models/SystemAuth.js"),
      import("../lib/pinCrypto.js"),
    ]);

    const update = {
      waiterPin: hashPin(DEFAULT_PINS.WAITER),
      kitchenPin: hashPin(DEFAULT_PINS.KITCHEN),
      baristaPin: hashPin(DEFAULT_PINS.BARISTA),
      managerPin: hashPin(DEFAULT_PINS.MANAGER),
      activeWaiters: [],
    };

    const doc = await SystemAuth.findById("system");
    if (!doc) {
      await SystemAuth.create({ _id: "system", ...update });
      console.log("SystemAuth was missing — created with hashed default PINs.");
    } else {
      Object.assign(doc, update);
      await doc.save();
      console.log("Reset PINs to hashed defaults and cleared active waiter sessions.");
    }

    await mongoose.disconnect();
    console.log("Done.");
  } catch (error) {
    console.error("Auth reset failed:", error.message);
    process.exitCode = 1;
    await mongoose.disconnect().catch(() => {});
  }
})();