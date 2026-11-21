#!/usr/bin/env node
/**
 * Operator-only first-Manager provisioning for BONO Hotel.
 *
 * This is NEVER run automatically during development, build, or tests. It
 * connects only when an operator deliberately invokes it with BOTH flags:
 *
 *   node --env-file=.env.local scripts/provision-hotel-manager.mjs \
 *     --provision-hotel-manager --confirm
 *
 * Required environment (supplied by the operator, never read from source):
 *   ROOM_MONGODB_URI, HOTEL_MANAGER_EMAIL, HOTEL_MANAGER_NAME, HOTEL_MANAGER_PIN
 *
 * Safety rules:
 *  - No Manager is created if any MANAGER HotelUser already exists.
 *  - The PIN is hashed before storage and is never printed.
 *  - No role change, credential rotation, index creation, migration, or
 *    secondary account creation is performed.
 *  - The script performs no work at import time; it is a standalone CLI.
 */

import process from "node:process";

const args = new Set(process.argv.slice(2));
const requested =
  args.has("--provision-hotel-manager") && args.has("--confirm");

if (!requested) {
  process.stdout.write(
    "Refusing to provision: pass --provision-hotel-manager --confirm explicitly.\n"
  );
  process.exit(1);
}

const { connectToHotelDatabase } = await import("../lib/hotel/db/connection.js");
const { getHotelUserModel } = await import("../lib/hotel/models/hotelUser.js");
const { hashHotelPin, isValidHotelPin } = await import("../lib/hotel/auth/pin.js");
const { safeRecordHotelAudit, HOTEL_AUDIT_ACTIONS } = await import(
  "../lib/hotel/audit.js"
);

const email = String(process.env.HOTEL_MANAGER_EMAIL || "").trim().toLowerCase();
const name = String(process.env.HOTEL_MANAGER_NAME || "").trim();
const pin = String(process.env.HOTEL_MANAGER_PIN || "");

if (!email || !name || !isValidHotelPin(pin)) {
  process.stderr.write(
    "HOTEL_MANAGER_EMAIL, HOTEL_MANAGER_NAME and a 4-digit HOTEL_MANAGER_PIN are required.\n"
  );
  process.exit(1);
}

let connection;
try {
  connection = await connectToHotelDatabase();
  const HotelUser = getHotelUserModel(connection);
  const existing = await HotelUser.countDocuments({ role: "MANAGER" });
  if (existing > 0) {
    process.stdout.write(
      "A MANAGER already exists. Promotion/creation requires separate owner approval. No changes made.\n"
    );
    await connection.close();
    process.exit(0);
  }

  const created = await HotelUser.create({
    email,
    name,
    role: "MANAGER",
    isActive: true,
    pinHash: hashHotelPin(pin),
    pinSetAt: new Date(),
    pinFailedAttempts: 0,
    pinLockedUntil: null,
    createdVia: "OPERATOR_CLI",
    createdByStaffId: null,
    updatedByStaffId: null,
  });

  await safeRecordHotelAudit(connection, {
    action: HOTEL_AUDIT_ACTIONS.FIRST_MANAGER_PROVISIONED,
    outcome: "SUCCESS",
    actorUserId: String(created._id),
    actorRole: "MANAGER",
    entityType: "HotelUser",
    entityId: String(created._id),
    metadata: { createdVia: "OPERATOR_CLI" },
  });

  process.stdout.write(
    `Provisioned first Hotel MANAGER (${created.email}). No credential value was printed.\n`
  );
  await connection.close();
  process.exit(0);
} catch (error) {
  process.stderr.write(
    `Provisioning failed: ${error?.name || "Error"}: ${String(error?.message || "unknown").slice(0, 200)}\n`
  );
  if (connection) await connection.close().catch(() => {});
  process.exit(1);
}
