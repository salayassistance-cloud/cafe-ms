// Hotel Manager-controlled staff management tests — DB-free.
//
// Source contracts plus in-memory unit tests. No MongoDB connection, POS
// module, provisioning, index creation, or credential value is used.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReceptionistTarget,
  HOTEL_STAFF_MANAGED_ROLE,
  toSafeStaffSummary,
  validateReceptionistName,
} from "../lib/hotel/auth/staffService.js";
import {
  HOTEL_PIN_MAX_FAILED_ATTEMPTS,
  isHotelIdentityLocked,
  isValidHotelIdentityId,
} from "../lib/hotel/auth/credential.js";
import {
  HOTEL_PERMISSIONS,
  permissionsForHotelRole,
} from "../lib/hotel/auth/authorization.js";
import { HOTEL_AUDIT_ACTIONS } from "../lib/hotel/audit.js";
import { HOTEL_ERROR_CODES } from "../lib/hotel/errors.js";
import { HotelApiError } from "../lib/hotel/errors.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const exists = (path) => existsSync(join(root, path));

const service = read("lib/hotel/auth/staffService.js");
const support = read("lib/hotel/auth/staffRouteSupport.js");
const credential = read("lib/hotel/auth/credential.js");

describe("Staff service validation and safe projections", () => {
  test("only Receptionists are manageable", () => {
    assert.equal(HOTEL_STAFF_MANAGED_ROLE, "RECEPTIONIST");
    assert.throws(
      () => assertReceptionistTarget({ role: "MANAGER" }),
      (error) =>
        error instanceof HotelApiError &&
        error.status === 403 &&
        error.code === HOTEL_ERROR_CODES.FORBIDDEN
    );
    assert.throws(() => assertReceptionistTarget(null), HotelApiError);
    assert.equal(
      assertReceptionistTarget({ role: "RECEPTIONIST" }).role,
      "RECEPTIONIST"
    );
  });

  test("staff names are required, bounded, and sanitized", () => {
    assert.equal(validateReceptionistName("  Abebe  "), "Abebe");
    assert.throws(() => validateReceptionistName("   "), HotelApiError);
    assert.throws(() => validateReceptionistName("x".repeat(101)), HotelApiError);
    assert.throws(() => validateReceptionistName("<script>x</script>"), HotelApiError);
  });

  test("safe staff summaries never expose credential internals", () => {
    const summary = toSafeStaffSummary({
      _id: "507f1f77bcf86cd799439011",
      name: "Abebe",
      role: "RECEPTIONIST",
      isActive: true,
      pinHash: "scrypt$secret",
      passwordHash: "hash",
      email: "private@example.test",
      pinFailedAttempts: 3,
      pinLockedUntil: new Date(),
      createdVia: "STAFF_MANAGEMENT",
      createdByStaffId: "507f1f77bcf86cd799439012",
    });
    assert.deepEqual(Object.keys(summary).sort(), [
      "createdByStaffId",
      "createdVia",
      "id",
      "isActive",
      "lastLoginAt",
      "name",
      "pinSetAt",
      "role",
      "updatedAt",
    ]);
    assert.ok(!JSON.stringify(summary).includes("pinHash"));
    assert.ok(!JSON.stringify(summary).includes("private@example.test"));
  });

  test("creation enforces unique identity, individual PIN, safe email and attribution", () => {
    for (const marker of [
      "findNameCollision(connection, cleanName)",
      "findHotelPinCollision(connection, pin)",
      "role: HOTEL_STAFF_MANAGED_ROLE",
      'createdVia: "STAFF_MANAGEMENT"',
      "createdByStaffId: actorId",
      "updatedByStaffId: actorId",
      "hashHotelPin(pin)",
      "@hotel.invalid",
      "pinSetAt: new Date()",
    ]) {
      assert.ok(service.includes(marker), `creation needs ${marker}`);
    }
    assert.ok(!service.includes("role: body.role"));
  });
});

describe("Individual identity resolution and PIN collision safeguards", () => {
  test("identity ids are opaque ObjectIds and lock state is time based", () => {
    assert.equal(isValidHotelIdentityId("507f1f77bcf86cd799439011"), true);
    assert.equal(isValidHotelIdentityId("123"), false);
    assert.equal(isValidHotelIdentityId({}), false);
    assert.equal(isHotelIdentityLocked({ pinLockedUntil: null }, 1000), false);
    assert.equal(
      isHotelIdentityLocked({ pinLockedUntil: new Date(2000) }, 1000),
      true
    );
    assert.equal(
      isHotelIdentityLocked({ pinLockedUntil: new Date(500) }, 1000),
      false
    );
  });

  test("verification resolves ONE identity, never role-wide PIN scanning", () => {
    for (const marker of [
      "getHotelUserWithPin(connection, identityId)",
      "!role",
      "user.isActive === false",
      "!user.pinHash",
      "isHotelIdentityLocked(user, now)",
      "verifyHotelPin(pin, user.pinHash)",
      "countFailure",
    ]) {
      assert.ok(credential.includes(marker), `verification needs ${marker}`);
    }
    const verifyBlock = credential.slice(
      credential.indexOf("export async function verifyHotelUserPin"),
      credential.indexOf("// Atomic increment")
    );
    assert.ok(!verifyBlock.includes("findHotelUsersByRole"));
    assert.ok(!verifyBlock.includes("for (const user of"));
  });

  test("PIN collisions are rejected across active AND inactive identities", () => {
    assert.match(
      credential,
      /across ALL identities \(active and inactive\)/,
      "collision checks must include inactive accounts"
    );
    assert.ok(credential.includes("findHotelPinCollision"));
    assert.ok(service.includes("findHotelPinCollision(connection, pin)"));
  });

  test("login directory exposes only opaque ids, names and roles", () => {
    const directoryBlock = credential.slice(
      credential.indexOf("export async function findLoginIdentities"),
      credential.indexOf("export async function getHotelUserWithPin")
    );
    for (const marker of [
      "isActive: { $ne: false }",
      "pinHash: { $ne: null, $exists: true }",
      "id: String(user._id)",
      "name: user.name",
      "role: user.role",
    ]) {
      assert.ok(directoryBlock.includes(marker), `directory needs ${marker}`);
    }
    // `pinHash` appears only in the query filter for PIN-bearing identities;
    // the returned projection contains id/name/role/label only.
    for (const forbidden of ["email", "pinFailedAttempts", "passwordHash"]) {
      assert.ok(
        !directoryBlock.includes(forbidden),
        `directory must not expose ${forbidden}`
      );
    }
  });
});

describe("Lockout attribution and concurrent safety", () => {
  test("failed attempts are attributed to the attempted identity only", () => {
    const login = read("app/api/hotel/auth/login/route.js");
    assert.ok(login.includes("result.countFailure"));
    assert.ok(login.includes("recordFailedHotelPinAttempt(connection, result.userId, {"));
    assert.ok(login.includes("verifyHotelUserPin(connection, { identityId, pin })"));
    assert.ok(!login.includes("body.role"));
  });

  test("lockout increments are atomic and race-safe", () => {
    const block = credential.slice(
      credential.indexOf("export async function recordFailedHotelPinAttempt"),
      credential.indexOf("export async function resetHotelPinFailures")
    );
    for (const marker of [
      "HotelUser.updateOne(",
      "$add: [{ $ifNull: [\"$pinFailedAttempts\", 0] }, 1]",
      "$cond",
      "HOTEL_PIN_MAX_FAILED_ATTEMPTS",
      "HOTEL_PIN_LOCK_MS",
      "isActive: { $ne: false }",
    ]) {
      assert.ok(block.includes(marker), `lockout needs ${marker}`);
    }
    assert.ok(!block.includes("findHotelUsersByRole"));
    assert.equal(HOTEL_PIN_MAX_FAILED_ATTEMPTS, 5);
  });
});

describe("Manager-only staff API boundaries", () => {
  const routes = [
    "app/api/hotel/staff/route.js",
    "app/api/hotel/staff/[id]/route.js",
    "app/api/hotel/staff/[id]/pin/route.js",
    "app/api/hotel/staff/[id]/status/route.js",
  ];

  test("every staff route checks STAFF_MANAGE and mutation-level CSRF/Origin", () => {
    for (const path of routes) {
      const source = read(path);
      assert.ok(source.includes("authorizeStaffRequest(request"), `${path}: authorization`);
      assert.ok(source.includes("{ mutation: true }"), `${path}: mutation gate`);
      assert.ok(source.includes("readHotelJsonBody(request)"), `${path}: strict body`);
    }
    assert.ok(
      support.includes("permission: HOTEL_PERMISSIONS.STAFF_MANAGE"),
      "permission must be checked server-side"
    );
    assert.ok(support.includes("authorizeHotelRequest(request"));
  });

  test("Receptionists do not have the STAFF_MANAGE permission", () => {
    assert.equal(
      permissionsForHotelRole("RECEPTIONIST").includes(
        HOTEL_PERMISSIONS.STAFF_MANAGE
      ),
      false
    );
    assert.equal(
      permissionsForHotelRole("MANAGER").includes(
        HOTEL_PERMISSIONS.STAFF_MANAGE
      ),
      true
    );
  });

  test("Manager accounts cannot be mutated through staff endpoints", () => {
    for (const path of routes) {
      const source = read(path);
      assert.ok(
        source.includes("snapshotManagedStaff") || source.includes("createReceptionist"),
        `${path}: must use Receptionist-only service functions`
      );
      assert.ok(!source.includes("role: body.role"));
      assert.ok(!source.includes("STAFF_MANAGER_PROVISIONED"));
    }
    assert.ok(service.includes("Only Receptionist accounts can be managed here"));
  });

  test("self-deactivation is refused (defense in depth)", () => {
    assert.ok(service.includes("You cannot deactivate your own account"));
  });
});

describe("PIN reset, deactivation and session revocation", () => {
  test("PIN reset revokes all sessions and audits without storing the PIN", () => {
    const source = read("app/api/hotel/staff/[id]/pin/route.js");
    for (const marker of [
      "revokeAllHotelSessionsForUser(connection, id, \"SECURITY\")",
      HOTEL_AUDIT_ACTIONS.STAFF_PIN_RESET,
      "requireStaffAudit(",
      "restoreManagedStaff(connection, id, before, updated.updatedAt)",
      "STAFF_PIN_CHANGE_REJECTED",
      "validateHotelPin(body.confirmPin)",
      "pin !== body.confirmPin",
    ]) {
      assert.ok(source.includes(marker), `PIN reset needs ${marker}`);
    }
    const auditCall = source.slice(source.indexOf("staffAuditEvent("));
    assert.ok(!auditCall.includes("metadata: { pin"));
  });

  test("deactivation revokes sessions with ACCOUNT_DISABLED reason", () => {
    const source = read("app/api/hotel/staff/[id]/status/route.js");
    for (const marker of [
      'revokeAllHotelSessionsForUser(\n      connection,\n      id,\n      "ACCOUNT_DISABLED"\n    )',
      HOTEL_AUDIT_ACTIONS.STAFF_DEACTIVATED,
      HOTEL_AUDIT_ACTIONS.STAFF_ACTIVATED,
      "restoreManagedStaff(connection, id, before, updated.updatedAt)",
      "typeof body.isActive !== \"boolean\"",
    ]) {
      assert.ok(source.includes(marker), `status change needs ${marker}`);
    }
  });
});

describe("Audit behavior and sensitive-action confirmations", () => {
  test("required audit is strict and compensates on failure", () => {
    for (const marker of [
      "recordHotelAudit(connection, event)",
      "reverted = (await compensate()) === true",
      "The change could not be recorded and was reverted",
      "The change was applied but could not be recorded; contact an administrator",
      "outcome: \"SUCCESS\"",
      "actorUserId: auth.user.id",
      "actorRole: auth.role",
      "entityType: \"HotelUser\"",
      "entityId: target?.id ?? null",
    ]) {
      assert.ok(support.includes(marker), `required audit needs ${marker}`);
    }
    assert.ok(!support.includes("safeRecordHotelAudit(connection, event)"));
  });

  test("UI confirms destructive actions and renders status/confirmation states", () => {
    const ui = read("app/components/hotel/HotelStaffManagementUI.jsx");
    for (const marker of [
      "window.confirm(",
      "staff.mgmt.confirmDeactivate",
      "staff.mgmt.confirmActivate",
      "StatusBadge",
      "staff.mgmt.empty",
      "Spinner",
      "Banner tone=\"error\"",
      "staff.mgmt.created",
      "staff.mgmt.pinReset",
    ]) {
      if (!marker) continue;
      assert.ok(ui.includes(marker), `UI needs ${marker}`);
    }
  });
});

describe("Isolation and operational preservation", () => {
  test("new Hotel auth/staff files contain no POS references", () => {
    const files = [
      "lib/hotel/auth/staffService.js",
      "lib/hotel/auth/staffRouteSupport.js",
      "lib/hotel/auth/credential.js",
      "app/api/hotel/auth/identities/route.js",
      "app/api/hotel/auth/login/route.js",
      "app/api/hotel/staff/route.js",
      "app/api/hotel/staff/[id]/route.js",
      "app/api/hotel/staff/[id]/pin/route.js",
      "app/api/hotel/staff/[id]/status/route.js",
      "app/components/hotel/HotelStaffManagementUI.jsx",
      "app/hotel/management/page.js",
    ];
    for (const forbidden of [
      "@/lib/models/Staff",
      "@/lib/staffService",
      "@/lib/sessionStore",
      "@/lib/sessionCrypto",
      "@/lib/security",
      "@/lib/mongodb",
      "getPortalSession",
      "PinGuard",
      "bono_sess",
      "__Host-bono_session",
    ]) {
      for (const path of files) {
        assert.ok(!read(path).includes(forbidden), `${path} must not use ${forbidden}`);
      }
    }
  });

  test("management page is Manager-only and operational pages remain", () => {
    const page = read("app/hotel/management/page.js");
    assert.ok(page.includes('requireHotelPageRole("MANAGER", "/hotel/reception")'));
    assert.ok(exists("app/hotel/reception/page.js"));
    assert.ok(exists("app/hotel/rooms/page.js"));
    assert.ok(exists("app/hotel/reports/page.js"));
    assert.ok(exists("app/components/hotel/ReceptionUI.jsx"));
    assert.ok(exists("app/api/hotel/reservations/route.js"));
    assert.ok(exists("app/api/hotel/guests/route.js"));
    assert.ok(exists("app/api/hotel/stays/route.js"));
    assert.ok(exists("app/api/hotel/reports/summary/route.js"));
    const roomsUi = read("app/components/hotel/RoomsUI.jsx");
    const reportsUi = read("app/components/hotel/RoomReportsUI.jsx");
    assert.ok(roomsUi.includes('href="/hotel/management"'));
    assert.ok(reportsUi.includes('href="/hotel/management"'));
  });

  test("retired EXTERNAL paths remain absent", () => {
    assert.equal(exists("app/api/external-items/route.js"), false);
    assert.equal(exists("app/api/external-sales/route.js"), false);
    assert.equal(exists("lib/models/ExternalItemRequest.js"), false);
  });
});

describe("Phase 3F staff-management remediations", () => {
  test("E-06: PIN reset excludes the target identity from collision checks", () => {
    assert.ok(
      service.includes(
        "findHotelPinCollision(connection, pin, { exceptUserId: user._id })"
      ),
      "reset must pass the options object with exceptUserId"
    );
    assert.ok(service.includes("findHotelPinCollision(connection, pin)"));
  });

  test("E-05/E-07: async bounded KDF and self-service collision policy", () => {
    assert.ok(credential.includes("verifyHotelPinAsync(pin, user.pinHash)"));
    assert.ok(read("lib/hotel/auth/pin.js").includes("crypto.scrypt("));
    const changePin = read("app/api/hotel/auth/change-pin/route.js");
    assert.ok(changePin.includes("findHotelPinCollision(connection, newPin, { exceptUserId: user._id })"));
    assert.ok(changePin.includes("HOTEL_ERROR_CODES.CONFLICT"));
  });

  test("E-01: PIN reset revocation failure is fatal and reported truthfully", () => {
    const source = read("app/api/hotel/staff/[id]/pin/route.js");
    for (const marker of [
      "catch {",
      "PIN was not changed: active sessions could not be revoked",
      "STAFF_PIN_CHANGE_REJECTED",
      "SESSION_REVOCATION_FAILED",
      "sessionsRevoked: revoked > 0",
      "revokedSessionCount: revoked",
    ]) {
      assert.ok(source.includes(marker), `PIN reset needs ${marker}`);
    }
    assert.ok(!source.includes("revokeAllHotelSessionsForUser(connection, id, \"SECURITY\").catch("));
  });

  test("E-02/E-19: compensation accuracy and conditional restore", () => {
    assert.ok(read("lib/hotel/auth/staffRouteSupport.js").includes("reverted = (await compensate()) === true"));
    assert.ok(service.includes("if (expected) filter.updatedAt = expected"));
    assert.ok(service.includes("expectedUpdatedAt = null"));
    assert.ok(
      read("app/api/hotel/staff/route.js").includes(
        "(await removeJustCreatedStaff(connection, created.id)).deletedCount > 0"
      )
    );
  });

  test("E-12/E-13: staff mutation IDs are validated and mutations are throttled", () => {
    for (const path of [
      "app/api/hotel/staff/[id]/route.js",
      "app/api/hotel/staff/[id]/pin/route.js",
      "app/api/hotel/staff/[id]/status/route.js",
    ]) {
      const source = read(path);
      assert.ok(source.includes("validateObjectIdString"), `${path}: id validation`);
      assert.ok(source.includes("checkStaffMutationRateLimit(request)"), `${path}: rate limit`);
    }
    assert.ok(
      read("app/api/hotel/staff/route.js").includes("checkStaffMutationRateLimit(request)")
    );
    assert.ok(read("lib/hotel/auth/rateLimit.js").includes("STAFF_MUTATION"));
  });
});
