import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseResetManagerPinArgs,
  validateResetManagerPinInput,
  runHotelResetManagerPinCli,
  CliError,
} from "../scripts/hotel-reset-manager-pin.mjs";
import { hashHotelPin, isHashedHotelPin, verifyHotelPin } from "../lib/hotel/auth/pin.js";

describe("Hotel Manager Reset PIN CLI — Pure Argument & Input Validation", () => {
  test("parses --email, --dry-run, --confirm, and --help", () => {
    const parsed = parseResetManagerPinArgs([
      "--email",
      "manager@example.com",
      "--dry-run",
    ]);
    assert.equal(parsed.email, "manager@example.com");
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.confirm, false);
    assert.equal(parsed.help, false);

    const parsedConfirm = parseResetManagerPinArgs([
      "--email=manager@example.com",
      "--confirm",
    ]);
    assert.equal(parsedConfirm.email, "manager@example.com");
    assert.equal(parsedConfirm.confirm, true);
    assert.equal(parsedConfirm.dryRun, false);
  });

  test("rejects --pin argument to prevent secret exposure in process listings", () => {
    assert.throws(
      () => parseResetManagerPinArgs(["--pin", "1234"]),
      (err) => err instanceof CliError && err.message.includes("PIN must not be passed")
    );
    assert.throws(
      () => parseResetManagerPinArgs(["--pin=1234"]),
      (err) => err instanceof CliError && err.message.includes("PIN must not be passed")
    );
  });

  test("rejects unknown arguments without echoing them", () => {
    assert.throws(
      () => parseResetManagerPinArgs(["--unknown-flag"]),
      (err) => err instanceof CliError && err.message.includes("Unknown argument")
    );
  });

  test("validates PIN format: strictly 4 digits", () => {
    assert.deepEqual(
      validateResetManagerPinInput({ email: "mgr@test.com", pin: "4321" }),
      { email: "mgr@test.com", pin: "4321" }
    );
    assert.throws(
      () => validateResetManagerPinInput({ email: "mgr@test.com", pin: "123" }),
      (err) => err instanceof CliError && err.message.includes("PIN must be exactly 4 numeric digits")
    );
    assert.throws(
      () => validateResetManagerPinInput({ email: "mgr@test.com", pin: "12345" }),
      (err) => err instanceof CliError && err.message.includes("PIN must be exactly 4 numeric digits")
    );
    assert.throws(
      () => validateResetManagerPinInput({ email: "mgr@test.com", pin: "abcd" }),
      (err) => err instanceof CliError && err.message.includes("PIN must be exactly 4 numeric digits")
    );
  });

  test("validates email format if specified", () => {
    assert.throws(
      () => validateResetManagerPinInput({ email: "not-an-email", pin: "1234" }),
      (err) => err instanceof CliError && err.message.includes("Valid email address required")
    );
  });
});

describe("Hotel Manager Reset PIN CLI — Scrypt MCF Cryptography", () => {
  test("generates valid scrypt MCF format and verifies correctly", () => {
    const pin = "7890";
    const hash = hashHotelPin(pin);
    assert.equal(isHashedHotelPin(hash), true);
    assert.match(hash, /^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.equal(verifyHotelPin(pin, hash), true);
    assert.equal(verifyHotelPin("0000", hash), false);
  });
});

describe("Hotel Manager Reset PIN CLI — Execution Workflow", () => {
  function createMockDeps({
    managers = [
      {
        _id: "661111111111111111111111",
        email: "manager@bonohotel.com",
        name: "Test Manager",
        role: "MANAGER",
        isActive: true,
        pinFailedAttempts: 3,
        pinLockedUntil: new Date(Date.now() + 60000),
      },
    ],
    pin = "8520",
  } = {}) {
    let updateOneCalled = null;
    let revokedUserId = null;
    let auditRecord = null;
    let connectionClosed = false;

    const mockConnection = {
      close: async () => {
        connectionClosed = true;
      },
    };

    const mockHotelUserModel = {
      findOne: async (query) => {
        return (
          managers.find(
            (m) =>
              (!query.email || m.email.toLowerCase() === query.email.toLowerCase()) &&
              (!query.role || m.role === query.role)
          ) || null
        );
      },
      find: (query) => ({
        lean: async () =>
          managers.filter((m) => !query.role || m.role === query.role),
      }),
      updateOne: async (filter, update) => {
        updateOneCalled = { filter, update };
        return { modifiedCount: 1 };
      },
    };

    const mockHotelSessionModel = {
      countDocuments: async () => 2,
    };

    const deps = {
      connectToHotelDatabase: async () => mockConnection,
      getHotelUserModel: () => mockHotelUserModel,
      getHotelSessionModel: () => mockHotelSessionModel,
      resolvePin: async () => pin,
      sessionService: {
        revokeAllHotelSessionsForUser: async (conn, userId, reason) => {
          revokedUserId = { userId, reason };
          return 2;
        },
      },
      auditService: {
        safeRecordHotelAudit: async (conn, record) => {
          auditRecord = record;
        },
        HOTEL_AUDIT_ACTIONS: {
          STAFF_PIN_RESET: "STAFF_PIN_RESET",
        },
      },
    };

    return {
      deps,
      getResults: () => ({
        updateOneCalled,
        revokedUserId,
        auditRecord,
        connectionClosed,
      }),
    };
  }

  test("refuses execution without --confirm or --dry-run", async () => {
    const { deps } = createMockDeps();
    const code = await runHotelResetManagerPinCli(["--email", "manager@bonohotel.com"], deps);
    assert.equal(code, 1);
  });

  test("dry-run mode inspects target and verifies hash without database mutations", async () => {
    const { deps, getResults } = createMockDeps();
    const code = await runHotelResetManagerPinCli(
      ["--email", "manager@bonohotel.com", "--dry-run"],
      deps
    );
    assert.equal(code, 0);
    const results = getResults();
    assert.equal(results.updateOneCalled, null, "No database write in dry-run mode");
    assert.equal(results.revokedUserId, null, "No session revocation in dry-run mode");
    assert.equal(results.auditRecord, null, "No audit emission in dry-run mode");
    assert.equal(results.connectionClosed, true, "Connection closed cleanly");
  });

  test("confirmed execution updates pinHash, clears failures/lock, revokes sessions, and records audit", async () => {
    const { deps, getResults } = createMockDeps({ pin: "9630" });
    const code = await runHotelResetManagerPinCli(
      ["--email", "manager@bonohotel.com", "--confirm"],
      deps
    );
    assert.equal(code, 0);
    const results = getResults();
    assert.ok(results.updateOneCalled, "HotelUser updateOne was called");
    assert.equal(results.updateOneCalled.filter._id, "661111111111111111111111");
    assert.equal(results.updateOneCalled.update.$set.pinFailedAttempts, 0);
    assert.equal(results.updateOneCalled.update.$set.pinLockedUntil, null);
    assert.ok(results.updateOneCalled.update.$set.pinSetAt instanceof Date);
    assert.ok(isHashedHotelPin(results.updateOneCalled.update.$set.pinHash));
    assert.equal(verifyHotelPin("9630", results.updateOneCalled.update.$set.pinHash), true);

    assert.deepEqual(results.revokedUserId, {
      userId: "661111111111111111111111",
      reason: "ROTATED",
    });

    assert.ok(results.auditRecord, "Audit record was created");
    assert.equal(results.auditRecord.action, "STAFF_PIN_RESET");
    assert.equal(results.auditRecord.actorRole, "MANAGER");
    assert.equal(results.auditRecord.entityType, "HotelUser");
    assert.equal(results.auditRecord.outcome, "SUCCESS");
    assert.equal(results.connectionClosed, true);
  });
});
