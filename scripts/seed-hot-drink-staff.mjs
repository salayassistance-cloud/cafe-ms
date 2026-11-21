#!/usr/bin/env node
// Ops seed: provision the JEBENA BUNA (HOT_DRINK) station operator account.
//
// AUTH-ARCH-8B: station roles are provisioned out-of-band by an operator — the
// manager Staff UI only creates WAITER/CASHIER. This script is the HOT_DRINK
// counterpart of that operator policy, reusing the canonical Staff model and
// scrypt PIN hashing. It is idempotent:
//   - no HOT_DRINK Staff row  -> create exactly one shared station account
//   - row already exists      -> leave it untouched (never overwrite a live PIN)
//
// Usage:
//   node --env-file=.env.local scripts/seed-hot-drink-staff.mjs
//   node --env-file=.env.local scripts/seed-hot-drink-staff.mjs --reset-pin
//
// `--reset-pin` is an explicit opt-in that resets the role-wide PIN to
// DEFAULT_HOT_DRINK_PIN (mirrors the Manager "reset role PIN" action and
// scripts/reset-auth.js). Without the flag the script only creates a missing
// account.
import mongoose from "mongoose";
import Staff from "../lib/models/Staff.js";
import { hashPin } from "../lib/pinCrypto.js";
import {
  DEFAULT_HOT_DRINK_PIN,
  isKnownDefaultPin,
  isProductionRuntime,
} from "../lib/config/security.js";

const ROLE = "HOT_DRINK";
const ACCOUNT_NAME = "Jebena Buna";
const resetPin = process.argv.includes("--reset-pin");

// Phase 2.2: never provision a publicly known default PIN in production.
// Operators must set DEFAULT_HOT_DRINK_PIN to a deployment-specific value.
if (isProductionRuntime() && isKnownDefaultPin(DEFAULT_HOT_DRINK_PIN)) {
  console.error(
    "Refusing to seed the HOT_DRINK account with a known default PIN in production. Set DEFAULT_HOT_DRINK_PIN to a non-default 4-digit value."
  );
  process.exit(1);
}

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error(
    "MONGODB_URI is not set — run with: node --env-file=.env.local scripts/seed-hot-drink-staff.mjs"
  );
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    const host = (MONGODB_URI.match(/@([^\/\?]+)/) || [])[1] || "unknown";
    console.log(`Connected to database at ${host} (credentials redacted)`);

    const existing = await Staff.find({ role: ROLE }).select("_id name isActive").lean();

    if (existing.length === 0) {
      const doc = await Staff.create({
        name: ACCOUNT_NAME,
        role: ROLE,
        pinHash: hashPin(DEFAULT_HOT_DRINK_PIN),
        isActive: true,
      });
      console.log(
        `Created ${ROLE} station account "${doc.name}" (${doc._id}) with the default PIN (hashed).`
      );
    } else if (resetPin) {
      const result = await Staff.updateMany(
        { role: ROLE },
        { $set: { pinHash: hashPin(DEFAULT_HOT_DRINK_PIN) } }
      );
      console.log(
        `Reset the role-wide ${ROLE} PIN for ${result.modifiedCount} account(s) to the default (hashed).`
      );
    } else {
      console.log(
        `${ROLE} station account(s) already present (${existing.length}) — skipping. Use --reset-pin to reset the role-wide PIN.`
      );
    }

    await mongoose.disconnect();
    console.log("Done.");
  } catch (error) {
    console.error("HOT_DRINK staff seed failed:", error.message);
    process.exitCode = 1;
    await mongoose.disconnect().catch(() => {});
  }
})();
