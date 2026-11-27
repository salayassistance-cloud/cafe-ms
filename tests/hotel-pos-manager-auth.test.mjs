// Phase 1 — Hotel POS Manager authorization contract tests (DB-free).
//
// These tests exercise the single Hotel authorization seam with a test-only
// authenticator double. They never open a POS or Hotel database connection.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { authorizeHotelRequest } from "../lib/hotel/http/authorizedRequest.js";
import { HOTEL_PERMISSIONS } from "../lib/hotel/auth/authorization.js";
import { HOTEL_ERROR_CODES, HotelApiError } from "../lib/hotel/errors.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const HOTEL_ORIGIN = "https://hotel.example";
const POS_STAFF_ID = "661111111111111111111111";
const STUB_CONNECTION = Object.freeze({ models: Object.freeze({}) });

function managerPayload(role = "MANAGER") {
  return { ok: true, payload: { staffId: POS_STAFF_ID, role } };
}

function buildRequest({
  method = "GET",
  path = "/api/hotel/rooms",
  origin = HOTEL_ORIGIN,
  headers = {},
} = {}) {
  const requestHeaders = { ...headers };
  if (origin !== null) requestHeaders.origin = origin;
  return new Request(`${HOTEL_ORIGIN}${path}`, {
    method,
    headers: requestHeaders,
  });
}

function authorize({
  auth = managerPayload,
  permission = HOTEL_PERMISSIONS.ROOMS_READ,
  mutation = false,
  connect = STUB_CONNECTION,
  request = buildRequest(),
  authenticate,
} = {}) {
  return authorizeHotelRequest(request, {
    permission,
    mutation,
    connect,
    allowedOrigins: [HOTEL_ORIGIN],
    authenticate:
      authenticate ??
      (async () => (typeof auth === "function" ? auth() : auth)),
  });
}

async function bodyOf(result) {
  return result.response.json();
}

describe("Hotel API authorization — POS MANAGER and RECEPTION", () => {
  test("the production seam uses the canonical POS requireAuth with MANAGER and RECEPTION", () => {
    const source = read("lib/hotel/http/authorizedRequest.js");
    assert.match(
      source,
      /import \{ requireAuth \} from "\.\.\/\.\.\/security\.js"/
    );
    assert.match(source, /HOTEL_MANAGER_ROLE = "MANAGER"/);
    assert.match(source, /POS_RECEPTION_ROLE = "RECEPTION"/);
    assert.match(source, /ALLOWED_POS_HOTEL_ROLES = Object\.freeze\(\[\s*HOTEL_MANAGER_ROLE,\s*POS_RECEPTION_ROLE,?\s*\]\)/);
    assert.doesNotMatch(source, /lib\/hotel\/auth\/service/);
    assert.doesNotMatch(source, /readHotelCsrfHeader/);
  });

  test("accepts a live POS MANAGER for a permitted Hotel operation", async () => {
    const result = await authorize();

    assert.equal(result.ok, true);
    assert.equal(result.auth.role, "MANAGER");
    assert.deepEqual(result.auth.user, { id: null, role: "MANAGER" });
    assert.equal(result.auth.connection, STUB_CONNECTION);
  });

  test("rejects a request with no session", async () => {
    const result = await authorize({
      auth: { ok: false, status: 401, error: "Authentication required" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.response.status, 401);
    const body = await bodyOf(result);
    assert.equal(body.success, false);
    assert.equal(body.error.code, HOTEL_ERROR_CODES.AUTHENTICATION_REQUIRED);
  });

  test("rejects an invalid or revoked session", async () => {
    for (const code of ["SESSION_INVALID", "SESSION_REVOKED"]) {
      const result = await authorize({
        auth: { ok: false, status: 401, code },
      });
      assert.equal(result.ok, false, code);
      assert.equal(result.response.status, 401, code);
      const body = await bodyOf(result);
      assert.equal(body.error.code, HOTEL_ERROR_CODES.INVALID_SESSION, code);
    }
  });

  test("rejects an expired session", async () => {
    const result = await authorize({
      auth: { ok: false, status: 401, code: "SESSION_EXPIRED" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.response.status, 401);
    assert.equal(
      (await bodyOf(result)).error.code,
      HOTEL_ERROR_CODES.SESSION_EXPIRED
    );
  });

  test("rejects inactive staff through the canonical auth result", async () => {
    const result = await authorize({
      auth: { ok: false, status: 401, code: "ACCOUNT_DISABLED" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.response.status, 401);
    assert.equal(
      (await bodyOf(result)).error.code,
      HOTEL_ERROR_CODES.ACCOUNT_DISABLED
    );
  });

  test("rejects every non-MANAGER POS role", async () => {
    for (const role of [
      "CASHIER",
      "WAITER",
      "KITCHEN",
      "BARISTA",
      "HOT_DRINK",
      "RECEPTIONIST",
      "UNKNOWN",
    ]) {
      const result = await authorize({ auth: managerPayload(role) });
      assert.equal(result.ok, false, role);
      assert.equal(result.response.status, 403, role);
      assert.equal(
        (await bodyOf(result)).error.code,
        HOTEL_ERROR_CODES.FORBIDDEN,
        role
      );
    }
  });

  test("fails closed when the POS authentication database is unavailable", async () => {
    const result = await authorize({
      auth: { ok: false, status: 503, error: "Database connection error" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.response.status, 503);
    assert.equal(
      (await bodyOf(result)).error.code,
      HOTEL_ERROR_CODES.DATABASE_UNAVAILABLE
    );
  });

  test("fails closed when the canonical authenticator throws", async () => {
    const result = await authorize({
      authenticate: async () => {
        throw new Error("pos database unavailable");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.response.status, 503);
    assert.equal(
      (await bodyOf(result)).error.code,
      HOTEL_ERROR_CODES.DATABASE_UNAVAILABLE
    );
  });

  test("fails closed when the Hotel connection cannot be resolved", async () => {
    const result = await authorize({
      connect: async () => {
        throw new HotelApiError({
          code: HOTEL_ERROR_CODES.DATABASE_UNAVAILABLE,
          message: "Hotel database is temporarily unavailable",
          status: 503,
          expose: true,
        });
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.response.status, 503);
    assert.equal(
      (await bodyOf(result)).error.code,
      HOTEL_ERROR_CODES.DATABASE_UNAVAILABLE
    );
  });

  test("never exposes the POS Staff ObjectId as a Hotel actor identity", async () => {
    const result = await authorize();

    assert.equal(result.auth.user.id, null);
    assert.equal(
      JSON.stringify(result.auth).includes(POS_STAFF_ID),
      false,
      "POS staff id must not be placed in the Hotel actor contract"
    );
  });
});

describe("Hotel permission projection and enforcement", () => {
  test("MANAGER receives every Hotel permission", async () => {
    for (const permission of Object.values(HOTEL_PERMISSIONS)) {
      const result = await authorize({ permission });
      assert.equal(result.ok, true, permission);
    }
  });

  test("unknown or malformed Hotel permissions are rejected", async () => {
    for (const permission of ["hotel.unknown", "", 42]) {
      const result = await authorize({ permission });
      assert.equal(result.ok, false, String(permission));
      assert.equal(result.response.status, 403, String(permission));
      assert.equal(
        (await bodyOf(result)).error.code,
        HOTEL_ERROR_CODES.FORBIDDEN,
        String(permission)
      );
    }
  });

  test("missing permission stays allowed for Manager-only routes that declare none", async () => {
    const result = await authorize({ permission: undefined });
    assert.equal(result.ok, true);
  });

  test("Hotel permissions do not alter the POS policy matrix", () => {
    const posPolicy = read("lib/policy.js");
    for (const permission of Object.values(HOTEL_PERMISSIONS)) {
      assert.equal(
        posPolicy.includes(permission),
        false,
        `POS policy must not contain ${permission}`
      );
    }
    assert.equal(posPolicy.includes("HOTEL_MANAGER"), false);
    assert.equal(posPolicy.includes("HOTEL_PERMISSIONS"), false);
  });
});

describe("Mutation Origin validation is preserved", () => {
  test("same-origin mutations continue to pass", async () => {
    const result = await authorize({
      mutation: true,
      request: buildRequest({ method: "POST", origin: HOTEL_ORIGIN }),
    });
    assert.equal(result.ok, true);
  });

  test("mutations without Origin are rejected", async () => {
    await assert.rejects(
      () =>
        authorize({
          mutation: true,
          request: buildRequest({ method: "POST", origin: null }),
        }),
      (error) =>
        error instanceof HotelApiError &&
        error.code === HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED &&
        error.status === 403
    );
  });

  test("cross-origin mutations are rejected", async () => {
    await assert.rejects(
      () =>
        authorize({
          mutation: true,
          request: buildRequest({
            method: "POST",
            origin: "https://evil.example",
          }),
        }),
      (error) =>
        error instanceof HotelApiError &&
        error.code === HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED
    );
  });

  test("GET requests do not require an Origin header", async () => {
    const result = await authorize({
      request: buildRequest({ method: "GET", origin: null }),
    });
    assert.equal(result.ok, true);
  });
});

describe("Hotel page gate — POS MANAGER and RECEPTION", () => {
  const layout = read("app/hotel/layout.js");

  test("uses the canonical POS server-session resolver and existing PIN guard", () => {
    assert.match(
      layout,
      /getLiveSessionFromCookies\(store,\s*\[\s*"MANAGER",\s*"RECEPTION",?\s*\]\)/
    );
    assert.match(layout, /<PinGuard role="RECEPTION" next="\/hotel\/reception"/);
    assert.match(layout, /export const dynamic = "force-dynamic"/);
  });

  test("does not create a Hotel auth system or redirect loop", () => {
    assert.doesNotMatch(layout, /getHotelServerSession|HotelSessionProvider/);
    assert.doesNotMatch(layout, /redirect\s*\(/);
    assert.doesNotMatch(layout, /\/api\/hotel\/auth/);
    assert.doesNotMatch(layout, /new\s+.*Session/);
  });
});
