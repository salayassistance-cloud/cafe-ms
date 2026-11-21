// Hotel identity-selected PIN authentication tests — DB-free.
//
// No MongoDB connection, index creation, deployment, or credential store is
// used. Route/component behavior is verified through source contracts, while
// PIN hashing, validation, rate limits and session timings run in memory.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dummyHotelPinHash,
  hashHotelPin,
  isHashedHotelPin,
  isValidHotelPin,
  verifyHotelPin,
} from "../lib/hotel/auth/pin.js";
import {
  checkHotelRateLimit,
  hotelClientIp,
  hotelRetryAfterSeconds,
  HOTEL_RATE_LIMITS,
  resetHotelRateLimitStore,
} from "../lib/hotel/auth/rateLimit.js";
import { validateHotelPin, validateHotelRole } from "../lib/hotel/validation.js";
import { HotelValidationError } from "../lib/hotel/errors.js";
import {
  HOTEL_ROLES,
  HOTEL_SESSION_ABSOLUTE_MS,
  HOTEL_SESSION_IDLE_MS,
} from "../lib/hotel/constants.js";
import {
  buildHotelSessionDoc,
  generateHotelSessionToken,
  isHotelSessionTimeValid,
  isHotelSessionValid,
} from "../lib/hotel/auth/session.js";
import { deriveHotelSessionCsrfToken } from "../lib/hotel/auth/csrf.js";
import { sanitizeHotelAuditMetadata } from "../lib/hotel/audit.js";
import { HOTEL_UI_TRANSLATIONS } from "../lib/hotel/uiTranslations.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const exists = (path) => existsSync(join(root, path));

let previousHotelSecret;
let previousAuthSecret;

before(() => {
  previousHotelSecret = process.env.HOTEL_SESSION_SECRET;
  previousAuthSecret = process.env.AUTH_SECRET;
  process.env.HOTEL_SESSION_SECRET = "hotel-pin-auth-test-secret-1234567890abcdef";
  process.env.AUTH_SECRET = "pos-test-secret-must-not-be-reused-1234567890";
});

after(() => {
  if (previousHotelSecret === undefined) delete process.env.HOTEL_SESSION_SECRET;
  else process.env.HOTEL_SESSION_SECRET = previousHotelSecret;
  if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = previousAuthSecret;
});

describe("Hotel PIN validation and hashing", () => {
  test("accepts only the selected Hotel role and exactly four digits", () => {
    assert.deepEqual([...HOTEL_ROLES], ["MANAGER", "RECEPTIONIST"]);
    assert.equal(validateHotelRole("manager"), "MANAGER");
    assert.equal(validateHotelRole("Receptionist"), "RECEPTIONIST");
    assert.throws(() => validateHotelRole("WAITER"), HotelValidationError);
    assert.throws(() => validateHotelRole("CASHIER"), HotelValidationError);
    assert.equal(validateHotelPin("1234"), "1234");
    assert.throws(() => validateHotelPin("123"), HotelValidationError);
    assert.throws(() => validateHotelPin("12a4"), HotelValidationError);
    assert.throws(() => validateHotelPin(1234), HotelValidationError);
    assert.equal(isValidHotelPin("0000"), true);
    assert.equal(isValidHotelPin("00000"), false);
  });

  test("stores only a salted scrypt hash and verifies in constant time", () => {
    const hash = hashHotelPin("1234");
    assert.match(hash, /^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.ok(!hash.includes("1234"));
    assert.equal(isHashedHotelPin(hash), true);
    assert.equal(isHashedHotelPin("1234"), false);
    assert.equal(verifyHotelPin("1234", hash), true);
    assert.equal(verifyHotelPin("9999", hash), false);
    assert.equal(verifyHotelPin("1234", null), false);
    assert.equal(verifyHotelPin("1234", "plaintext"), false);
    assert.equal(verifyHotelPin("1234", dummyHotelPinHash()), false);
  });

  test("hashes are salted: identical PINs produce different stored values", () => {
    assert.notEqual(hashHotelPin("1234"), hashHotelPin("1234"));
  });
});

describe("Login rate limiting and account lockout", () => {
  test("limits to five attempts per IP and publishes a retry delay", () => {
    resetHotelRateLimitStore();
    const request = {
      headers: {
        get: (name) =>
          String(name).toLowerCase() === "x-nf-client-connection-ip"
            ? "10.1.2.3"
            : null,
      },
    };
    for (let i = 0; i < HOTEL_RATE_LIMITS.LOGIN.limit; i += 1) {
      assert.equal(
        checkHotelRateLimit(request, {
          key: "hotel_auth_login",
          ...HOTEL_RATE_LIMITS.LOGIN,
          now: 1000,
        }).ok,
        true
      );
    }
    const blocked = checkHotelRateLimit(request, {
      key: "hotel_auth_login",
      ...HOTEL_RATE_LIMITS.LOGIN,
      now: 1000,
    });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfterMs > 0);
    assert.equal(hotelRetryAfterSeconds(blocked.retryAfterMs), 60);
    assert.equal(
      checkHotelRateLimit(request, {
        key: "hotel_auth_login",
        ...HOTEL_RATE_LIMITS.LOGIN,
        now: 1000 + HOTEL_RATE_LIMITS.LOGIN.windowMs,
      }).ok,
      true
    );
    resetHotelRateLimitStore();
  });

  test("reads only the trusted platform IP; spoofed forwarding headers are ignored", () => {
    const request = {
      headers: {
        get: (name) => {
          if (String(name).toLowerCase() === "x-nf-client-connection-ip") return "203.0.113.7";
          if (String(name).toLowerCase() === "x-forwarded-for") return "198.51.100.9";
          if (String(name).toLowerCase() === "x-real-ip") return "198.51.100.2";
          return null;
        },
      },
    };
    assert.equal(hotelClientIp(request), "203.0.113.7");

    const spoofed = {
      headers: {
        get: (name) =>
          String(name).toLowerCase() === "x-forwarded-for"
            ? "203.0.113.7, 10.0.0.1"
            : null,
      },
    };
    assert.equal(hotelClientIp(spoofed), null);
    // Fail-closed fallback: requests without a trusted IP share a bounded
    // bucket instead of bypassing throttling.
    resetHotelRateLimitStore();
    for (let i = 0; i < HOTEL_RATE_LIMITS.LOGIN.untrustedLimit; i += 1) {
      assert.equal(
        checkHotelRateLimit(spoofed, {
          key: "hotel_auth_login",
          ...HOTEL_RATE_LIMITS.LOGIN,
          now: 2000,
        }).ok,
        true
      );
    }
    assert.equal(
      checkHotelRateLimit(spoofed, {
        key: "hotel_auth_login",
        ...HOTEL_RATE_LIMITS.LOGIN,
        now: 2000,
      }).ok,
      false
    );
    resetHotelRateLimitStore();
  });

  test("uses dormant lifecycle fields for lockout and shared failure reasons", () => {
    const credentialSource = read("lib/hotel/auth/credential.js");
    for (const marker of [
      "pinFailedAttempts",
      "pinLockedUntil",
      "HOTEL_PIN_MAX_FAILED_ATTEMPTS = 5",
      "HOTEL_PIN_LOCK_MS = 15 * 60 * 1000",
      "recordFailedHotelPinAttempt",
      "HOTEL_INVALID_CREDENTIALS",
      "verifyHotelPin",
      "dummyHotelPinHash",
    ]) {
      assert.ok(credentialSource.includes(marker), `credential service needs ${marker}`);
    }
    assert.ok(
      credentialSource.includes("Every failure returns the same public reason"),
      "failures must remain indistinguishable"
    );
  });
});

describe("Opaque Hotel session contract", () => {
  test("uses an 8-hour absolute expiry and a 30-minute idle window", () => {
    const token = generateHotelSessionToken();
    const csrf = deriveHotelSessionCsrfToken(token);
    const doc = buildHotelSessionDoc({
      hotelUserId: "507f1f77bcf86cd799439011",
      role: "RECEPTIONIST",
      rawToken: token,
      csrfToken: csrf,
      request: null,
      now: 1000,
    });
    assert.equal(doc.roleSnapshot, "RECEPTIONIST");
    assert.equal(new Date(doc.expiresAt).getTime() - 1000, HOTEL_SESSION_ABSOLUTE_MS);
    assert.equal(new Date(doc.idleExpiresAt).getTime() - 1000, HOTEL_SESSION_IDLE_MS);
    assert.equal(isHotelSessionTimeValid(doc, 1000).ok, true);
    assert.equal(
      isHotelSessionTimeValid(doc, 1000 + HOTEL_SESSION_ABSOLUTE_MS + 1).ok,
      false
    );
  });
});

describe("Hotel login API contract", () => {
  const login = read("app/api/hotel/auth/login/route.js");

  test("accepts identity + PIN only and issues an opaque Hotel session", () => {
    for (const marker of [
      "identityId = String(body.identityId ?? \"\").trim()",
      "validateHotelPin(body.pin)",
      "verifyHotelUserPin(connection, { identityId, pin })",
      "createHotelSession(connection",
      "HOTEL_SESSION_COOKIE",
      "hotelSuccess({",
      "AUTH_LOGIN_FAILED",
      "AUTH_LOGIN_SUCCEEDED",
      "HOTEL_RATE_LIMITS.LOGIN",
      "assertHotelRequestOrigin(request)",
      "readHotelJsonBody(request)",
    ]) {
      assert.ok(login.includes(marker), `login route needs ${marker}`);
    }
    for (const forbidden of [
      "body.username",
      "body.email",
      "body.password",
      "getHotelUserModel(connection).findOne",
      "verifyStaffPin",
      "getPortalSession",
      "requireAuth",
      "sessionStore",
      "@/lib/mongodb",
      "__Host-bono_session",
    ]) {
      assert.ok(!login.includes(forbidden), `login route must not use ${forbidden}`);
    }
  });

  test("returns one uniform authentication failure", () => {
    assert.match(login, /const GENERIC_FAILURE = "Invalid identity or PIN";/);
    assert.match(login, /message: GENERIC_FAILURE/);
    assert.ok(login.includes("recordFailedHotelPinAttempt(connection, result.userId, {"));
  });

  test("does not disclose which field or identity failed", () => {
    assert.ok(!login.includes("error.fieldErrors"));
    assert.ok(!login.includes("Invalid PIN"));
    assert.ok(!login.includes("Account not found"));
  });
});

describe("Logout, me, and self-service PIN change contracts", () => {
  test("logout revokes the Hotel session and clears the Hotel cookie", () => {
    const source = read("app/api/hotel/auth/logout/route.js");
    for (const marker of [
      "verifyHotelSessionCsrf",
      'revokeHotelSession(connection, rawToken, "LOGOUT")',
      "HOTEL_SESSION_COOKIE_DELETE_OPTS",
      "AUTH_LOGOUT",
      "assertHotelRequestOrigin(request)",
    ]) {
      assert.ok(source.includes(marker), `logout needs ${marker}`);
    }
  });

  test("me revalidates the live session without creating one", () => {
    const source = read("app/api/hotel/auth/me/route.js");
    assert.ok(source.includes("authenticateHotelRequest(request)"));
    assert.ok(source.includes("deriveHotelSessionCsrfToken(rawToken)"));
    assert.ok(!source.includes("createHotelSession"));
  });

  test("PIN change is self-only, CSRF protected, and revokes sessions", () => {
    const source = read("app/api/hotel/auth/change-pin/route.js");
    for (const marker of [
      "requireCsrf: true",
      "readHotelCsrfHeader(request)",
      "validateHotelPin(body.currentPin",
      "validateHotelPin(body.newPin",
      "validateHotelPin(body.confirmPin",
      "verifyHotelPin(currentPin, user.pinHash)",
      "setHotelUserPin(connection, user._id, newPin)",
      "revokeAllHotelSessionsForUser(connection, user._id",
      "STAFF_SELF_PIN_CHANGED",
      "New PIN and Confirm PIN do not match",
      "New PIN must differ from current PIN",
    ]) {
      assert.ok(source.includes(marker), `change-pin needs ${marker}`);
    }
    assert.ok(!source.includes("body.staffId"));
  });
});

describe("POS-parity login UI (new Hotel components)", () => {
  test("keypad reproduces the POS dots, grid, keys and palette", () => {
    const keypad = read("app/components/hotel/HotelPinKeypad.jsx");
    for (const marker of [
      "[0, 1, 2, 3]",
      "h-3.5 w-3.5 rounded-full",
      'grid-cols-3 gap-2.5',
      "max-w-[260px]",
      "h-14",
      "Clear",
      "⌫",
      "aria-label=\"Backspace\"",
      "bg-[#FFD600] dark:bg-[#FF5E00]",
      "bg-white dark:bg-[#1C1D24]",
      "rounded-xl",
      "disabled:opacity-40",
      "event.key !== \"Enter\"",
    ]) {
      assert.ok(keypad.includes(marker), `keypad needs ${marker}`);
    }
    const keys = keypad.match(/\["1", "2", "3", "4", "5", "6", "7", "8", "9"\]/);
    assert.ok(keys, "keypad must use the POS 1-9 key order");
  });

  test("gate uses identity selection, four-digit validation and POS card styling", () => {
    const gate = read("app/components/hotel/HotelLoginGate.jsx");
    const portals = read("lib/hotel/ui/portals.js");
    for (const marker of [
      "usePathname()",
      "login.enterPinFour",
      "animate-fade-up",
      "blur-[2px]",
      "max-w-[360px]",
      '"/api/hotel/auth/login"',
      "isCompletePin",
      "HotelPinKeypad",
      'role="alert"',
      "bg-[#1E293B]/30",
      "dark:bg-[#12131A]/70",
      "keypadDisabled",
      "disabled={!ready}",
      "login.noReceptionist",
      "router.push(destination)",
      "router.refresh()",
      "resolveHotelPortal(pathname)",
    ]) {
      assert.ok(gate.includes(marker), `gate needs ${marker}`);
    }
    // Portal identity roles, titles and destinations live in the shared pure
    // routing module so they can be tested without rendering React.
    for (const marker of [
      'role: "RECEPTIONIST"',
      'role: "MANAGER"',
      "login.receptionTitle",
      "login.roomsTitle",
      '"/hotel/rooms"',
      '"/hotel/reception"',
      '"/hotel/management"',
      '"/hotel/reports"',
    ]) {
      assert.ok(portals.includes(marker), `portals needs ${marker}`);
    }
    for (const forbidden of [
      'autoComplete="username"',
      'type="text"',
      "localStorage",
      "sessionStorage",
      "PinGuard",
      "PinLoginModal",
      "/api/auth/login-staff",
    ]) {
      assert.ok(!gate.includes(forbidden), `gate must not use ${forbidden}`);
    }
  });

  test("shared top bar exposes self-service PIN change with the Hotel CSRF header", () => {
    const topBar = read("app/components/hotel/HotelTopBar.jsx");
    assert.ok(topBar.includes("HotelChangePinModal"));
    assert.ok(topBar.includes('t("session.changePin")'));
    const modal = read("app/components/hotel/HotelChangePinModal.jsx");
    assert.ok(modal.includes("HOTEL_CSRF_HEADER"));
    assert.ok(modal.includes('"/api/hotel/auth/change-pin"'));
  });

  test("the static fallback gate remains free of any login form", () => {
    const gate = read("app/components/hotel/HotelSessionGate.jsx");
    assert.ok(!gate.includes("<input"));
    assert.ok(!gate.includes("/api/hotel/auth"));
    assert.ok(!gate.includes("router.push"));
    assert.ok(gate.includes('role="status"'));
  });
});

describe("Legacy interactive credential retirement and isolation", () => {
  test("only the four approved Hotel auth routes exist", () => {
    const authDir = join(root, "app/api/hotel/auth");
    const routeFiles = readdirSync(authDir).sort();
    assert.deepEqual(routeFiles, ["change-pin", "identities", "login", "logout", "me"]);
    for (const name of routeFiles) {
      assert.ok(exists(`app/api/hotel/auth/${name}/route.js`));
    }
    assert.ok(!exists("app/api/hotel/auth/login-staff/route.js"));
    assert.ok(!exists("app/api/hotel/auth/verify-pin/route.js"));
  });

  test("no operational Hotel handler can issue a Hotel session", () => {
    const apiRoot = join(root, "app/api/hotel");
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name === "route.js" ? [full] : [];
      });
    for (const file of walk(apiRoot)) {
      if (file.includes(`${"auth"}`)) continue;
      const source = readFileSync(file, "utf8");
      assert.ok(!source.includes("createHotelSession"), `${file} must not create sessions`);
    }
  });

  test("POS authentication code is not imported by Hotel auth", () => {
    const files = [
      "app/api/hotel/auth/login/route.js",
      "app/api/hotel/auth/logout/route.js",
      "app/api/hotel/auth/me/route.js",
      "app/api/hotel/auth/change-pin/route.js",
      "lib/hotel/auth/credential.js",
      "lib/hotel/auth/pin.js",
      "lib/hotel/auth/cookies.js",
      "lib/hotel/auth/rateLimit.js",
      "app/components/hotel/HotelLoginGate.jsx",
      "app/components/hotel/HotelPinKeypad.jsx",
      "app/components/hotel/HotelChangePinModal.jsx",
      "app/hotel/layout.js",
    ];
    const forbidden = [
      "@/lib/models/Staff",
      "@/lib/staffService",
      "@/lib/sessionStore",
      "@/lib/sessionCrypto",
      "@/lib/serverAuth",
      "@/lib/serverSessionCookies",
      "@/lib/security",
      "@/lib/mongodb",
      "@/lib/clientFetch",
      "getPortalSession",
      "PinGuard",
      "bono_sess",
      "__Host-bono_session",
    ];
    for (const path of files) {
      const source = read(path);
      for (const term of forbidden) {
        assert.ok(!source.includes(term), `${path} must not reference ${term}`);
      }
    }
  });

  test("dormant credential fields are retained, not deleted", () => {
    const userModel = read("lib/hotel/models/hotelUser.js");
    for (const field of [
      "passwordHash",
      "pinHash",
      "username",
      "pinSetAt",
      "pinFailedAttempts",
      "pinLockedUntil",
      "createdByStaffId",
      "updatedByStaffId",
      "createdVia",
    ]) {
      assert.ok(userModel.includes(field), `dormant field ${field} must remain`);
    }
  });
});

describe("Operational access and authorization contracts", () => {
  test("the /hotel layout shows the PIN gate only when no session exists", () => {
    const layout = read("app/hotel/layout.js");
    assert.ok(layout.includes('import HotelLoginGate from "@/app/components/hotel/HotelLoginGate"'));
    assert.ok(layout.includes('<HotelSessionGate reason={result.reason} />'));
    assert.ok(layout.includes("result.reason === \"unavailable\""));
    assert.ok(layout.includes("<HotelLoginGate />"));
    assert.ok(layout.includes("<HotelSessionProvider session={result.session}>"));
  });

  test("Reception, Rooms and Reports retain their server role guards", () => {
    const reception = read("app/hotel/reception/page.js");
    const rooms = read("app/hotel/rooms/page.js");
    const reports = read("app/hotel/reports/page.js");
    assert.ok(reception.includes('requireHotelPageRole("RECEPTIONIST", "/hotel/rooms")'));
    assert.ok(rooms.includes('requireHotelPageRole("MANAGER", "/hotel/reception")'));
    assert.ok(reports.includes('requireHotelPageRole("MANAGER", "/hotel/reception")'));
    assert.ok(exists("app/components/hotel/ReceptionUI.jsx"));
    assert.ok(exists("app/components/hotel/RoomsUI.jsx"));
    assert.ok(exists("app/components/hotel/RoomReportsUI.jsx"));
    for (const api of [
      "app/api/hotel/reports/summary/route.js",
      "app/api/hotel/reservations/route.js",
      "app/api/hotel/guests/route.js",
      "app/api/hotel/stays/route.js",
      "app/api/hotel/payments",
      "app/api/hotel/rooms/route.js",
    ]) {
      assert.ok(exists(api), `operational API ${api} must remain`);
    }
  });

  test("mutations still require exact Origin and session-bound CSRF", () => {
    const authorized = read("lib/hotel/http/authorizedRequest.js");
    assert.ok(authorized.includes("assertHotelRequestOrigin(request"));
    assert.ok(authorized.includes("requireCsrf: mutation"));
    assert.ok(authorized.includes("readHotelCsrfHeader(request)"));
    const security = read("lib/hotel/http/requestSecurity.js");
    assert.ok(security.includes("sec-fetch-site"));
    assert.ok(security.includes("HOTEL_JSON_BODY_MAX_BYTES"));
  });
});

describe("Manager initialization and localization", () => {
  test("operator CLI is explicit, refuses extra managers, and never prints a PIN", () => {
    const script = read("scripts/provision-hotel-manager.mjs");
    assert.ok(script.includes("--provision-hotel-manager"));
    assert.ok(script.includes("--confirm"));
    assert.ok(script.includes('countDocuments({ role: "MANAGER" })'));
    assert.ok(script.includes("separate owner approval"));
    assert.ok(script.includes('createdVia: "OPERATOR_CLI"'));
    assert.ok(script.includes("hashHotelPin(pin)"));
    assert.ok(!script.includes("console.log(pin)"));
    assert.ok(!script.includes("process.stdout.write(pin"));
  });

  test("both locales define every sign-in and PIN-change string", () => {
    const { en, am } = HOTEL_UI_TRANSLATIONS;
    assert.deepEqual(Object.keys(am).sort(), Object.keys(en).sort());
    const gate = read("app/components/hotel/HotelLoginGate.jsx");
    const modal = read("app/components/hotel/HotelChangePinModal.jsx");
    const keys = [
      ...gate.matchAll(/\bt\(\s*["'](session\.[^"']+)["']/g),
      ...modal.matchAll(/\bt\(\s*["'](session\.[^"']+)["']/g),
    ].map((match) => match[1]);
    for (const key of new Set(keys)) {
      assert.ok(key in en, `en.${key} is required`);
      assert.ok(key in am, `am.${key} is required`);
    }
  });
});

describe("Phase 3F authentication remediations", () => {
  test("E-01: a PIN set after session issuance invalidates the session", () => {
    const session = {
      createdAt: new Date(2000),
      expiresAt: new Date(2000 + HOTEL_SESSION_ABSOLUTE_MS),
      idleExpiresAt: new Date(2000 + HOTEL_SESSION_IDLE_MS),
      revokedAt: null,
      roleSnapshot: "RECEPTIONIST",
    };
    const user = {
      _id: "507f1f77bcf86cd799439011",
      isActive: true,
      role: "RECEPTIONIST",
      pinSetAt: new Date(3000),
    };
    const result = isHotelSessionValid(session, user, 2500);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "CREDENTIAL_CHANGED");
    assert.equal(
      isHotelSessionValid({ ...session, createdAt: new Date(4000) }, user, 2500).ok,
      true
    );
    const sessionSource = read("lib/hotel/auth/session.js");
    assert.ok(sessionSource.includes("pinSetAt"));
    assert.ok(sessionSource.includes("CREDENTIAL_CHANGED"));
    assert.ok(sessionSource.includes("metadata: { reason: \"CREDENTIAL_CHANGED\" }"));
  });

  test("E-14: logout does not claim revocation on CSRF failure or DB error", () => {
    const source = read("app/api/hotel/auth/logout/route.js");
    for (const marker of [
      "HOTEL_RATE_LIMITS.LOGOUT",
      "session was not revoked",
      "Session could not be revoked; try again",
      "sessionsRevoked: revokedCount > 0",
      "HOTEL_SESSION_COOKIE_DELETE_OPTS",
    ]) {
      assert.ok(source.includes(marker), `logout needs ${marker}`);
    }
    assert.ok(!source.includes("return hotelSuccess({ loggedOut: true });"));
  });

  test("E-18: PIN-related audit metadata keys are redacted", () => {
    const sanitized = sanitizeHotelAuditMetadata({
      pin: "1234",
      pinHash: "scrypt$secret",
      pinSetAt: "date",
      pinFailedAttempts: 5,
      safeNote: "ok",
    });
    assert.equal(sanitized.pin, undefined);
    assert.equal(sanitized.pinHash, undefined);
    assert.equal(sanitized.pinSetAt, undefined);
    assert.equal(sanitized.pinFailedAttempts, undefined);
    assert.equal(sanitized.safeNote, "ok");
  });

  test("E-21: lockout crossing emits a distinct audit event without credentials", () => {
    const login = read("app/api/hotel/auth/login/route.js");
    assert.ok(login.includes("HOTEL_AUDIT_ACTIONS.STAFF_LOGIN_LOCKED"));
    assert.ok(login.includes("lockResult.locked"));
    assert.ok(login.includes("metadata: { reason: \"PIN_FAILURE_THRESHOLD\" }"));
    assert.ok(!login.includes("metadata: { pin"));
  });

  test("E-08: expired locks reset the counter instead of preserving stale failures", () => {
    const credentialSource = read("lib/hotel/auth/credential.js");
    for (const marker of [
      "lockExpired",
      "$lte: [\"$pinLockedUntil\"",
      "Phase 3F / E-08",
      "Requires MongoDB >= 4.2",
    ]) {
      assert.ok(credentialSource.includes(marker), `lockout needs ${marker}`);
    }
  });

  test("E-26: role-wide identity helper and unvalidated PIN confirmation are gone", () => {
    assert.ok(
      !read("lib/hotel/auth/credential.js").includes("export async function findHotelUsersByRole")
    );
    const create = read("app/api/hotel/staff/route.js");
    assert.ok(create.includes("validateHotelPin(body.confirmPin)"));
    assert.ok(create.includes("body.pin !== body.confirmPin"));
  });
});
