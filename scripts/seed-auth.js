// Dev helper: initialises the singleton `system_auth` document with the default
// PINs (Waiter 1111 / Kitchen 2222 / Barista 3333 / Manager 4444), stored
// scrypt-hashed (salt:derived), and an empty activeWaiters list. Idempotent —
// skips if already present.
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error(
    "MONGODB_URI is not set — run with: node --env-file=.env.local scripts/seed-auth.js"
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

    const existing = await SystemAuth.findById("system");
    if (existing) {
      console.log("SystemAuth already initialised. Skipping.");
    } else {
      await SystemAuth.create({
        _id: "system",
        waiterPin: hashPin(DEFAULT_PINS.WAITER),
        kitchenPin: hashPin(DEFAULT_PINS.KITCHEN),
        baristaPin: hashPin(DEFAULT_PINS.BARISTA),
        managerPin: hashPin(DEFAULT_PINS.MANAGER),
        activeWaiters: [],
      });
      console.log(
        `Seeded default PINs (hashed) — Waiter ${DEFAULT_PINS.WAITER}, Kitchen ${DEFAULT_PINS.KITCHEN}, Barista ${DEFAULT_PINS.BARISTA}, Manager ${DEFAULT_PINS.MANAGER}`
      );
    }

    await mongoose.disconnect();
    console.log("Done.");
  } catch (error) {
    console.error("Auth seed failed:", error.message);
    process.exitCode = 1;
    await mongoose.disconnect().catch(() => {});
  }
})();