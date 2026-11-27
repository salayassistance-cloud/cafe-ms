// Phase 4-B2 — Manager Staff Administration for RECEPTION (DB-free).
// Verifies source-level wiring of Manager staff creation, individual isActive
// toggling, personal PIN reset + session revocation, and StaffManagement UI,
// plus stubbed live-session revocation behavior. No DB connection or Hotel
// connection import.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import { authenticateRequest } from "../lib/serverAuth.js";
import { generateSessionId, revokeAllStaffSessions } from "../lib/sessionStore.js";
import { isRoleWidePinRole, pinResetScope } from "../lib/staffPinPolicy.js";
import { validateRole } from "../lib/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

describe("Phase 4-B2: Manager Staff Administration for RECEPTION (DB-free)", () => {
  test("POST/DELETE /api/manager/waiters supports RECEPTION alongside WAITER and CASHIER", () => {
    const waitersRoute = read("app/api/manager/waiters/route.js");
    assert.match(
      waitersRoute,
      /INDIVIDUAL_STAFF_ROLES\s*=\s*\[\s*"WAITER",\s*"CASHIER",\s*"RECEPTION"\s*\]/
    );
    assert.match(waitersRoute, /requireAuth\(request,\s*\["MANAGER"\]\)/);
    assert.match(waitersRoute, /revokeAllStaffSessions\(conn,\s*staff\._id,\s*"DISABLED"\)/);
    assert.match(waitersRoute, /role === "RECEPTION"\) return "reception"/);
    assert.equal(waitersRoute.includes("RECEPTIONIST"), false);
  });

  test("PATCH/POST /api/manager/staff supports individual RECEPTION toggle and personal PIN reset", () => {
    const staffRoute = read("app/api/manager/staff/route.js");
    assert.match(staffRoute, /requireAuth\(request,\s*\["MANAGER"\]\)/);
    assert.match(
      staffRoute,
      /\["WAITER",\s*"CASHIER",\s*"RECEPTION"\]\.includes\(staff\.role\)/
    );
    assert.match(staffRoute, /revokeAllStaffSessions\(conn,\s*staffId,\s*"DISABLED"\)/);
    assert.match(staffRoute, /isRoleWidePinRole\(targetRole\)/);

    // Personal PIN policy means RECEPTION never triggers role-wide PIN updates.
    assert.equal(pinResetScope("RECEPTION"), "PERSONAL");
    assert.equal(isRoleWidePinRole("RECEPTION"), false);
    assert.equal(validateRole("RECEPTION"), "RECEPTION");
    assert.equal(validateRole("INVALID_ROLE"), null);
  });

  test("StaffManagement.jsx includes RECEPTION in roles, labels, badges, creation, and toggles", () => {
    const ui = read("app/components/StaffManagement.jsx");
    assert.match(ui, /'RECEPTION'/);
    assert.match(ui, /INDIVIDUAL_ROLES\s*=\s*\[\s*'WAITER',\s*'CASHIER',\s*'RECEPTION'\s*\]/);
    assert.match(ui, /<option value="RECEPTION">\{roleLabel\('RECEPTION'\)\}<\/option>/);
    assert.match(ui, /roleBadgeCls[\s\S]*RECEPTION/);
    assert.match(ui, /roleLabel[\s\S]*RECEPTION:/);
    assert.match(ui, /INDIVIDUAL_ROLES\.includes\(s\.role\)/);
    assert.match(ui, /INDIVIDUAL_ROLES\.includes\(toggleTarget\.role\)/);
  });

  test("deactivating a RECEPTION staff member revokes sessions and blocks authentication", async () => {
    const staffId = new mongoose.Types.ObjectId();
    const sessionId = generateSessionId();
    const staffDoc = {
      _id: staffId,
      name: "Selam",
      role: "RECEPTION",
      waiterNumber: null,
      isActive: true,
    };
    const sessions = [
      {
        _id: new mongoose.Types.ObjectId(),
        sessionId,
        staffId,
        roleSnapshot: "RECEPTION",
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
        idleExpiresAt: new Date(Date.now() + 1800_000),
        version: 1,
        revokedAt: null,
        revokeReason: null,
      },
    ];

    const conn = {
      models: {
        Session: {
          findOne: (q) => ({
            lean: async () =>
              sessions.find((s) => s.sessionId === q.sessionId) || null,
          }),
          updateMany: async (filter, update) => {
            let modifiedCount = 0;
            for (const s of sessions) {
              if (String(s.staffId) === String(filter.staffId) && s.revokedAt === null) {
                Object.assign(s, update.$set);
                modifiedCount += 1;
              }
            }
            return { modifiedCount };
          },
          findByIdAndUpdate: () => ({ lean: async () => ({}) }),
        },
        Staff: {
          findById: () => ({
            select: () => ({
              lean: async () => staffDoc,
            }),
          }),
        },
      },
    };

    const beforeDisable = await authenticateRequest({
      connectProvider: async () => conn,
      newSessionId: sessionId,
      allowedRoles: ["RECEPTION"],
    });
    assert.equal(beforeDisable.ok, true);
    assert.equal(beforeDisable.payload.role, "RECEPTION");

    staffDoc.isActive = false;
    await revokeAllStaffSessions(conn, staffId, "DISABLED");

    const afterDisable = await authenticateRequest({
      connectProvider: async () => conn,
      newSessionId: sessionId,
      allowedRoles: ["RECEPTION"],
    });
    assert.equal(afterDisable.ok, false);
    assert.equal(afterDisable.status, 401);
    assert.equal(afterDisable.code, "SESSION_REVOKED");
  });
});
