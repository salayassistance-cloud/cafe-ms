// Legacy DEV helper: initialises the singleton `system_auth` document with the
// default role PINs, stored scrypt-hashed (salt:derived), and an empty
// activeWaiters list. Idempotent — skips if already present.
//
// Phase 2.2: SystemAuth is retired as a runtime authority (Staff.pinHash is
// canonical). This script refuses to run with NODE_ENV=production and never
// prints PIN values.
const mongoose = require("mongoose");

// Phase 2.2 safety: this is a legacy DEVELOPMENT helper. SystemAuth is no
// longer a runtime credential authority (Staff is). Refuse to touch a
// production database and never print a PIN value.
if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
  console.error(
    "Refusing to seed SystemAuth in production. Provision POS Staff accounts with scripts/pos-provision-manager.mjs."
  );
  process.exit(1);
}

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
      // Never print PIN values (Phase 2.2). The values are only used to build
      // scrypt hashes and must not appear in logs or CI output.
      console.log(
        "Seeded legacy SystemAuth role PINs (hashed). Values are not printed. Rotate them before any shared use."
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