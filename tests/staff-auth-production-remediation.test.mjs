import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  isRejectedDefaultCredential,
  isKnownDefaultPin,
  isProductionRuntime,
  KNOWN_DEFAULT_PINS,
} from "../lib/config/security.js";
import {
  ROLE_WIDE_PIN_ROLES,
  PERSONAL_PIN_ROLES,
  pinResetScope,
  isRoleWidePinRole,
} from "../lib/staffPinPolicy.js";
import {
  verifyStaffPin,
  verifyStaffPinById,
  changeStaffPin,
  isValidRole,
} from "../lib/staffService.js";
import { hashPin, verifyPin } from "../lib/pinCrypto.js";

const PROD_ENV = { NODE_ENV: "production" };
const DEV_ENV = { NODE_ENV: "development" };
const TEST_ENV = { NODE_ENV: "test" };

describe("Staff Authentication — Production Policy and Default PIN Protections", () => {
  test("documented default PINs are recognized for identification but not arbitrarily blocked", () => {
    const defaults = ["1111", "2222", "3333", "4444", "5555"];
    for (const pin of defaults) {
      assert.equal(isKnownDefaultPin(pin), true, `${pin} must be recognized as default`);
      assert.equal(isRejectedDefaultCredential(pin, PROD_ENV), false, `${pin} must not be rejected in production`);
      assert.equal(isRejectedDefaultCredential(pin, DEV_ENV), false, `${pin} usable in dev`);
      assert.equal(isRejectedDefaultCredential(pin, TEST_ENV), false, `${pin} usable in test`);
    }
  });

  test("non-default PINs are not rejected by the credential policy", () => {
    const nonDefaults = ["7391", "8245", "9182", "5629", "1357"];
    for (const pin of nonDefaults) {
      assert.equal(isKnownDefaultPin(pin), false, `${pin} must not be known default`);
      assert.equal(isRejectedDefaultCredential(pin, PROD_ENV), false, `${pin} allowed in prod`);
    }
  });

  test("PIN reset scope policy: MANAGER is personal, station roles are role-wide", () => {
    assert.equal(isRoleWidePinRole("KITCHEN"), true);
    assert.equal(isRoleWidePinRole("BARISTA"), true);
    assert.equal(isRoleWidePinRole("HOT_DRINK"), true);

    assert.equal(isRoleWidePinRole("WAITER"), false);
    assert.equal(isRoleWidePinRole("CASHIER"), false);
    assert.equal(isRoleWidePinRole("MANAGER"), false);

    assert.equal(pinResetScope("MANAGER"), "PERSONAL");
    assert.equal(pinResetScope("WAITER"), "PERSONAL");
    assert.equal(pinResetScope("CASHIER"), "PERSONAL");
  });

  test("role validation accurately recognizes all 6 official staff roles", () => {
    const validRoles = ["WAITER", "KITCHEN", "BARISTA", "HOT_DRINK", "MANAGER", "CASHIER"];
    for (const r of validRoles) {
      assert.equal(isValidRole(r), true);
    }
    assert.equal(isValidRole("ADMIN"), false);
    assert.equal(isValidRole("RECEPTIONIST"), false);
    assert.equal(isValidRole(""), false);
  });
});

describe("Staff Verification and Account Status Enforcement", () => {
  // Test stub connection and model for DB-independent unit validation
  function createStubConnection(staffDocs = []) {
    const docs = [...staffDocs];
    return {
      model: () => ({
        findOne: async (query) => {
          return docs.find((d) => {
            if (query.role && d.role !== query.role) return false;
            if (query.$or) {
              return query.$or.some((cond) => {
                if (cond.username && String(cond.username).toLowerCase() === String(d.username).toLowerCase()) return true;
                if (cond.name && d.name === cond.name) return true;
                return false;
              });
            }
            return true;
          }) || null;
        },
        findById: (id) => ({
          select: () => ({
            lean: async () => docs.find((d) => String(d._id) === String(id)) || null,
          }),
          lean: async () => docs.find((d) => String(d._id) === String(id)) || null,
        }),
      }),
      models: {},
    };
  }

  test("rejects invalid PIN format immediately", async () => {
    const conn = createStubConnection();
    const res = await verifyStaffPin(conn, "Abebe", "123", "WAITER");
    assert.equal(res.ok, false);
    assert.match(res.error, /PIN must be 4 digits/);
  });

  test("rejects nonexistent staff account without enumeration", async () => {
    const conn = createStubConnection([]);
    const res = await verifyStaffPin(conn, "Nonexistent", "7391", "WAITER");
    assert.equal(res.ok, false);
    assert.equal(res.error, "Invalid Name or PIN");
  });

  test("inactive account with wrong PIN returns generic failure to prevent enumeration", async () => {
    const inactiveStaff = {
      _id: "660000000000000000000001",
      name: "Tigist",
      username: "tigist",
      role: "WAITER",
      pinHash: hashPin("7391"),
      isActive: false,
    };
    const conn = createStubConnection([inactiveStaff]);

    // Wrong PIN attempt against inactive account
    const res = await verifyStaffPin(conn, "Tigist", "9999", "WAITER");
    assert.equal(res.ok, false);
    assert.equal(res.error, "Invalid Name or PIN");
  });

  test("inactive account with correct PIN safely reports ACCOUNT_DISABLED to caller", async () => {
    const inactiveStaff = {
      _id: "660000000000000000000002",
      name: "Chala",
      username: "chala",
      role: "WAITER",
      pinHash: hashPin("7391"),
      isActive: false,
    };
    const conn = createStubConnection([inactiveStaff]);

    // Correct PIN attempt against inactive account
    const res = await verifyStaffPin(conn, "Chala", "7391", "WAITER");
    assert.equal(res.ok, false);
    assert.equal(res.code, "ACCOUNT_DISABLED");
    assert.match(res.error, /Account disabled/i);
  });

  test("active account with correct non-default PIN authenticates successfully", async () => {
    const activeStaff = {
      _id: "660000000000000000000003",
      name: "Desta",
      username: "desta",
      role: "WAITER",
      pinHash: hashPin("7391"),
      isActive: true,
    };
    const conn = createStubConnection([activeStaff]);

    const res = await verifyStaffPin(conn, "Desta", "7391", "WAITER");
    assert.equal(res.ok, true);
    assert.equal(res.staff.name, "Desta");
  });

  test("active account with matching hash authenticates successfully even for historical default PINs", async () => {
    for (const pin of ["1111", "2222", "3333", "4444", "5555"]) {
      const activeStaff = {
        _id: "660000000000000000000004",
        name: "Abebe",
        username: "abebe",
        role: "WAITER",
        pinHash: hashPin(pin),
        isActive: true,
      };
      const conn = createStubConnection([activeStaff]);
      const res = await verifyStaffPin(conn, "Abebe", pin, "WAITER");
      assert.equal(res.ok, true, `PIN ${pin} authenticates when hash matches`);
      assert.equal(res.staff.name, "Abebe");
    }
  });
});
