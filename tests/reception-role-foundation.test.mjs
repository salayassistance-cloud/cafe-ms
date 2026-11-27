// Phase 4-B1 — RECEPTION POS role foundation and permission isolation tests (DB-free).
// No database connection, no Hotel connection import, no production mutation.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";

import { STAFF_ROLES, StaffSchema } from "../lib/models/Staff.js";
import { SESSION_ROLES } from "../lib/models/Session.js";
import { buildSessionDoc, isValidRoleSnapshot } from "../lib/sessionStore.js";
import { validateLoginStaffPayload, validateRole } from "../lib/validate.js";
import {
  PERSONAL_PIN_ROLES,
  ROLE_WIDE_PIN_ROLES,
  isRoleWidePinRole,
  pinResetScope,
} from "../lib/staffPinPolicy.js";
import {
  ALL_ROLES,
  GROUPS,
  POS_ROLES,
  ROLES,
  can,
  canTransition,
  normalizeRole,
} from "../lib/policy.js";

describe("Phase 4-B1: RECEPTION POS role foundation (DB-free)", () => {
  test("Staff and Session schemas recognize RECEPTION without breaking existing roles", () => {
    for (const role of [
      "WAITER",
      "KITCHEN",
      "BARISTA",
      "HOT_DRINK",
      "MANAGER",
      "CASHIER",
      "RECEPTION",
    ]) {
      assert.ok(STAFF_ROLES.includes(role), `STAFF_ROLES includes ${role}`);
      assert.ok(SESSION_ROLES.includes(role), `SESSION_ROLES includes ${role}`);
    }

    assert.equal(STAFF_ROLES.includes("RECEPTIONIST"), false);
    assert.equal(SESSION_ROLES.includes("RECEPTIONIST"), false);

    const rolePath = StaffSchema.path("role");
    assert.ok(rolePath.enumValues.includes("RECEPTION"));

    assert.equal(isValidRoleSnapshot("RECEPTION"), true);
    const sessionDoc = buildSessionDoc({
      staffId: new mongoose.Types.ObjectId(),
      role: "RECEPTION",
      now: Date.now(),
    });
    assert.equal(sessionDoc.roleSnapshot, "RECEPTION");
  });

  test("validateRole and login payload validation accept RECEPTION", () => {
    assert.equal(validateRole("RECEPTION"), "RECEPTION");
    assert.equal(validateRole("reception"), "RECEPTION");
    assert.equal(validateRole("RECEPTIONIST"), null);

    const parsed = validateLoginStaffPayload({
      name: "Selam",
      pin: "1234",
      role: "reception",
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.role, "RECEPTION");
  });

  test("RECEPTION follows personal PIN policy (never role-wide)", () => {
    assert.ok(PERSONAL_PIN_ROLES.includes("RECEPTION"));
    assert.equal(ROLE_WIDE_PIN_ROLES.includes("RECEPTION"), false);
    assert.equal(pinResetScope("RECEPTION"), "PERSONAL");
    assert.equal(isRoleWidePinRole("RECEPTION"), false);
  });

  test("policy isolates RECEPTION from POS-only privileges", () => {
    assert.equal(ROLES.RECEPTION, "RECEPTION");
    assert.equal(normalizeRole("reception"), "RECEPTION");
    assert.ok(ALL_ROLES.includes("RECEPTION"));
    assert.equal(POS_ROLES.includes("RECEPTION"), false);
    assert.equal(GROUPS.STAFF_ANY.includes("RECEPTION"), false);

    const deniedForReception = [
      "orders:create",
      "orders:read",
      "orders:read:all",
      "orders:cancel:item",
      "orders:payment",
      "orders:payment:submit",
      "orders:payment:confirm",
      "orders:payment:reject",
      "reports:read",
      "analytics:read",
      "staff:read",
      "staff:mutate",
      "settings:pins",
      "settings:waiters",
      "settings:clearOrders",
      "inventory:read",
      "inventory:mutate",
      "recipe:read",
      "recipe:mutate",
      "menu:mutate",
      "category:mutate",
      "brand:mutate",
      "paymentInfo:mutate",
    ];

    for (const permission of deniedForReception) {
      assert.equal(
        can("RECEPTION", permission),
        false,
        `RECEPTION must be denied ${permission}`
      );
    }

    for (const status of [
      "PENDING",
      "PREPARING",
      "READY",
      "SERVED",
      "PAYMENT_PENDING",
      "PAID",
      "ARCHIVED",
      "CANCELLED",
    ]) {
      assert.equal(
        canTransition("RECEPTION", status),
        false,
        `RECEPTION must not transition orders to ${status}`
      );
    }

    // Self-service PIN change remains permitted for any authenticated staff member.
    assert.equal(can("RECEPTION", "staff:changePin"), true);
  });

  test("existing POS roles and MANAGER retain exact permissions", () => {
    for (const posRole of POS_ROLES) {
      assert.equal(can(posRole, "orders:read"), true);
      assert.equal(can(posRole, "staff:read"), true);
      assert.equal(can(posRole, "staff:changePin"), true);
    }

    assert.equal(can("MANAGER", "staff:mutate"), true);
    assert.equal(can("MANAGER", "orders:read:all"), true);
    assert.equal(can("MANAGER", "inventory:mutate"), true);
    assert.equal(can("MANAGER", "reports:read"), true);
    assert.equal(can("CASHIER", "orders:payment:confirm"), true);
    assert.equal(can("WAITER", "orders:create"), true);
    assert.equal(can("KITCHEN", "orders:transition:PREPARING"), true);
    assert.equal(can("BARISTA", "orders:transition:READY"), true);
    assert.equal(can("HOT_DRINK", "orders:transition:READY"), true);
  });
});
