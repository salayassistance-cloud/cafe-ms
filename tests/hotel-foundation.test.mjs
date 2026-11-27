// Hotel foundation tests â€” DB-free.
//
// No MongoDB connection is opened, no index is created, and no POS module is
// imported. Authentication flows use plain in-memory stub connections.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import { HOTEL_DB_NAME } from "../lib/hotel/constants.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
  HotelValidationError,
} from "../lib/hotel/errors.js";
import {
  HOTEL_PERMISSIONS,
  assertHotelPermission,
  canHotel,
  permissionsForHotelRole,
} from "../lib/hotel/auth/authorization.js";
import {
  sanitizeHotelAuditMetadata,
  getHotelRequestAuditMeta,
  recordHotelAudit,
  HOTEL_AUDIT_ACTIONS,
} from "../lib/hotel/audit.js";
import {
  hotelErrorResponse,
  hotelSuccess,
  withHotelApi,
} from "../lib/hotel/http/apiResponse.js";
import { validateRoomTypePayload } from "../lib/hotel/validation.js";
import { getRoomTypeModel } from "../lib/hotel/models/roomType.js";
import { getRoomModel } from "../lib/hotel/models/room.js";
import { getHotelUserModel } from "../lib/hotel/models/hotelUser.js";
import { getHotelAuditLogModel } from "../lib/hotel/models/hotelAuditLog.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (path) => readFileSync(join(root, path), "utf8");

const TEST_AUTH_SECRET = "pos-test-secret-that-must-not-be-reused-1234567890";
const TEST_HOTEL_SECRET = "hotel-test-secret-that-is-independent-1234567890";

let previousHotelSecret;
let previousAuthSecret;

before(() => {
  previousHotelSecret = process.env.HOTEL_SESSION_SECRET;
  previousAuthSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = TEST_AUTH_SECRET;
  process.env.HOTEL_SESSION_SECRET = TEST_HOTEL_SECRET;
});

after(() => {
  if (previousHotelSecret === undefined) delete process.env.HOTEL_SESSION_SECRET;
  else process.env.HOTEL_SESSION_SECRET = previousHotelSecret;

  if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = previousAuthSecret;
});

function withHotelSecret(value, fn) {
  const current = process.env.HOTEL_SESSION_SECRET;
  if (value === undefined) delete process.env.HOTEL_SESSION_SECRET;
  else process.env.HOTEL_SESSION_SECRET = value;
  try {
    return fn();
  } finally {
    if (current === undefined) delete process.env.HOTEL_SESSION_SECRET;
    else process.env.HOTEL_SESSION_SECRET = current;
  }
}

function auditConnection() {
  return {
    models: {
      HotelAuditLog: {
        create: async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }),
      },
    },
  };
}

describe("Hotel connection and model isolation (DB-free)", () => {
  test("connection is dedicated, lazy, and cannot auto-create schema", () => {
    const connectionSource = src("lib/hotel/db/connection.js");
    assert.match(connectionSource, /dbName:\s*HOTEL_DB_NAME/);
    assert.match(connectionSource, /autoIndex:\s*false/);
    assert.match(connectionSource, /autoCreate:\s*false/);
    assert.equal(HOTEL_DB_NAME, "bono_hotel");
    assert.ok(
      !/process\.env\.MONGODB_URI/.test(connectionSource),
      "Hotel connection must not read the POS MONGODB_URI"
    );
    assert.ok(
      !/mongoose\.connect\s*\(/.test(connectionSource),
      "Hotel connection must not use the default POS connection"
    );
    assert.ok(
      !/mongodb(?:\+srv)?:\/\/[^\s"'`]*@/.test(connectionSource),
      "No credential-bearing MongoDB URI may be hardcoded"
    );
  });

  test("importing the connection opens nothing and missing config fails closed", async () => {
    const previousUri = process.env.ROOM_MONGODB_URI;
    delete process.env.ROOM_MONGODB_URI;

    try {
      const connectionModule = await import("../lib/hotel/db/connection.js");
      assert.equal(connectionModule.isHotelDatabaseConfigured(), false);
      await assert.rejects(
        () => connectionModule.connectToHotelDatabase(),
        (error) =>
          error instanceof HotelApiError &&
          error.status === 503 &&
          error.code === HOTEL_ERROR_CODES.HOTEL_CONFIGURATION_ERROR
      );
    } finally {
      if (previousUri === undefined) delete process.env.ROOM_MONGODB_URI;
      else process.env.ROOM_MONGODB_URI = previousUri;
    }
  });

  test("Hotel modules never import POS auth/database/session modules", () => {
    // Phase 1: authorizedRequest.js is the single approved POS-auth seam.
    const posAuthSeam = "lib/hotel/http/authorizedRequest.js";
    const files = [
      "lib/hotel/constants.js",
      "lib/hotel/config.js",
      "lib/hotel/errors.js",
      "lib/hotel/db/connection.js",
      "lib/hotel/auth/authorization.js",
      "lib/hotel/audit.js",
      "lib/hotel/dates.js",
      "lib/hotel/money.js",
      "lib/hotel/validation.js",
      "lib/hotel/http/apiResponse.js",
      "lib/hotel/http/requestSecurity.js",
      "lib/hotel/http/query.js",
      "lib/hotel/http/authorizedRequest.js",
      "lib/hotel/http/roomTypeHandlers.js",
      "lib/hotel/http/roomHandlers.js",
      "lib/hotel/http/guestHandlers.js",
      "lib/hotel/http/reservationHandlers.js",
      "lib/hotel/http/stayHandlers.js",
      "lib/hotel/http/paymentHandlers.js",
      "lib/hotel/services/roomTypes.js",
      "lib/hotel/services/rooms.js",
      "lib/hotel/services/bookingLocks.js",
      "lib/hotel/services/guests.js",
      "lib/hotel/services/reservations.js",
      "lib/hotel/services/stays.js",
      "lib/hotel/services/stayPayments.js",
      "lib/hotel/services/folio.js",
      "lib/hotel/services/payments.js",
      "lib/hotel/models/roomType.js",
      "lib/hotel/models/room.js",
      "lib/hotel/models/guest.js",
      "lib/hotel/models/reservation.js",
      "lib/hotel/models/stay.js",
      "lib/hotel/models/hotelPayment.js",
      "lib/hotel/models/roomBookingLock.js",
      "lib/hotel/models/hotelUser.js",
      "lib/hotel/models/hotelAuditLog.js",
    ];
    const allowedBareImports = new Set([
      "crypto",
      "util",
      "mongoose",
      "next/headers",
      "server-only",
    ]);
    const specifierPatterns = [
      /from\s+["']([^"']+)["']/g,
      /import\s*\(\s*["']([^"']+)["']/g,
      /^\s*import\s+["']([^"']+)["']/gm,
    ];

    for (const file of files) {
      const source = src(file);
      for (const forbidden of [
        "@/lib/mongodb",
        "@/lib/serverAuth",
        "@/lib/authServer",
        "@/lib/sessionStore",
        "@/lib/withApi",
        "@/lib/security",
        "@/lib/apiResponse",
        "@/lib/validate",
      ]) {
        assert.ok(!source.includes(forbidden), `${file} imports ${forbidden}`);
      }

      const specifiers = new Set();
      for (const pattern of specifierPatterns) {
        for (const match of source.matchAll(pattern)) {
          specifiers.add(match[1]);
        }
      }

      for (const specifier of specifiers) {
        if (specifier.startsWith(".")) {
          // The single approved exception: the Hotel authorization seam reuses
          // the canonical POS resolver instead of implementing a second one.
          if (file === posAuthSeam && specifier === "../../security.js") {
            continue;
          }
          const resolved = posix.normalize(
            posix.join(posix.dirname(file), specifier)
          );
          assert.ok(
            resolved.startsWith("lib/hotel/"),
            `${file} imports outside lib/hotel: ${specifier} -> ${resolved}`
          );
          continue;
        }
        assert.ok(
          allowedBareImports.has(specifier),
          `${file} has an unexpected external import: ${specifier}`
        );
      }
    }
  });

  test("RoomType compiles only on the supplied Hotel connection", async () => {
    assert.equal(mongoose.models.RoomType, undefined);
    const connection = mongoose.createConnection();

    try {
      const RoomType = getRoomTypeModel(connection);
      assert.equal(connection.models.RoomType, RoomType);
      assert.equal(mongoose.models.RoomType, undefined);

      const valid = new RoomType({
        name: "Deluxe",
        code: "dlx",
        capacity: 2,
        baseNightlyRate: 100,
        amenities: ["Wi-Fi", "TV"],
      });
      await valid.validate();
      assert.equal(valid.code, "DLX");

      const duplicateAmenities = new RoomType({
        name: "Suite",
        code: "STE",
        capacity: 4,
        baseNightlyRate: 200,
        amenities: ["TV", "TV"],
      });
      await assert.rejects(
        duplicateAmenities.validate(),
        (error) => Boolean(error.errors.amenities)
      );

      const indexes = RoomType.schema.indexes();
      assert.ok(
        indexes.some(
          ([keys, options]) => keys.code === 1 && options.unique === true
        ),
        "RoomType.code unique index is defined"
      );
    } finally {
      await connection.close();
    }
  });

  test("Room compiles only on the supplied Hotel connection", async () => {
    assert.equal(mongoose.models.Room, undefined);
    const connection = mongoose.createConnection();

    try {
      const Room = getRoomModel(connection);
      assert.equal(connection.models.Room, Room);
      assert.equal(mongoose.models.Room, undefined);
      assert.equal(Room.collection.name, "hotel_rooms");

      const valid = new Room({
        roomNumber: "101",
        floor: 1,
        roomTypeId: new mongoose.Types.ObjectId(),
        capacity: 2,
        amenities: ["Wi-Fi", "TV"],
      });
      await valid.validate();
      assert.equal(valid.operationalStatus, "AVAILABLE");
      assert.equal(valid.statusHistory.length, 0);

      const invalidFloor = new Room({
        roomNumber: "102",
        floor: 1.5,
        roomTypeId: new mongoose.Types.ObjectId(),
        capacity: 2,
      });
      await assert.rejects(
        invalidFloor.validate(),
        (error) => Boolean(error.errors.floor)
      );

      const indexes = Room.schema.indexes();
      assert.ok(
        indexes.some(
          ([keys, options]) =>
            keys.roomNumber === 1 && options.unique === true
        ),
        "Room.roomNumber unique index is defined"
      );
    } finally {
      await connection.close();
    }
  });

  test("auth/audit models hide secrets and define indexes without applying them", async () => {
    assert.equal(mongoose.models.HotelUser, undefined);
    const connection = mongoose.createConnection();

    try {
      const HotelUser = getHotelUserModel(connection);
      assert.equal(HotelUser.schema.path("passwordHash"), undefined);
      assert.equal(HotelUser.schema.path("pinHash"), undefined);
      assert.deepEqual(HotelUser.schema.path("role").enumValues, [
        "MANAGER",
        "RECEPTIONIST",
      ]);

      const HotelAuditLog = getHotelAuditLogModel(connection);
      assert.ok(HotelAuditLog.schema.path("metadata"));
      assert.equal(mongoose.models.HotelAuditLog, undefined);
    } finally {
      await connection.close();
    }
  });
});

describe("Hotel roles and permissions", () => {
  test("MANAGER has every Hotel permission", () => {
    for (const permission of Object.values(HOTEL_PERMISSIONS)) {
      assert.equal(canHotel("MANAGER", permission), true, permission);
    }
  });

  test("RECEPTIONIST is limited to front-desk permissions", () => {
    assert.equal(
      canHotel("RECEPTIONIST", HOTEL_PERMISSIONS.RESERVATIONS_MANAGE),
      true
    );
    assert.equal(
      canHotel("RECEPTIONIST", HOTEL_PERMISSIONS.ROOM_TYPES_MANAGE),
      false
    );
    assert.equal(canHotel("RECEPTIONIST", HOTEL_PERMISSIONS.AUDIT_READ), false);
    assert.equal(permissionsForHotelRole("receptionist").length > 0, true);
    assert.equal(canHotel("UNKNOWN", HOTEL_PERMISSIONS.DASHBOARD_READ), false);
    assert.equal(canHotel("MANAGER", "hotel.unknown"), false);
  });

  test("permission failure is a 403 HotelApiError", () => {
    assert.throws(
      () =>
        assertHotelPermission(
          "RECEPTIONIST",
          HOTEL_PERMISSIONS.ROOM_TYPES_MANAGE
        ),
      (error) =>
        error instanceof HotelApiError &&
        error.status === 403 &&
        error.code === HOTEL_ERROR_CODES.FORBIDDEN
    );
  });
});

describe("Hotel validation", () => {
  test("prototype keys are rejected", () => {
    const body = JSON.parse(
      '{"name":"Deluxe","code":"DLX","capacity":2,"baseNightlyRate":1,"__proto__":{"admin":true}}'
    );
    assert.throws(() => validateRoomTypePayload(body), HotelValidationError);
  });


  test("RoomType input is normalized, rounded, and field-scoped", () => {
    const result = validateRoomTypePayload({
      name: " Deluxe ",
      code: "dlx",
      capacity: 2,
      baseNightlyRate: 123.456,
      amenities: ["Wi-Fi", "Wi-Fi", " TV "],
      extra: "ignored",
    });
    assert.deepEqual(result, {
      name: "Deluxe",
      code: "DLX",
      capacity: 2,
      baseNightlyRate: 123.46,
      amenities: ["Wi-Fi", "TV"],
      description: "",
      isActive: true,
    });

    assert.throws(
      () =>
        validateRoomTypePayload({
          name: "<script>alert(1)</script>",
          code: "DLX",
          capacity: 2,
          baseNightlyRate: 1,
        }),
      (error) => error instanceof HotelValidationError && Boolean(error.fieldErrors.name)
    );
    assert.throws(
      () =>
        validateRoomTypePayload({
          name: "Deluxe",
          code: "not valid",
          capacity: 2,
          baseNightlyRate: 1,
        }),
      (error) => Boolean(error.fieldErrors.code)
    );
  });
});

describe("Hotel audit foundation", () => {
  test("metadata drops secrets and redacts URI-like values", () => {
    const sanitized = sanitizeHotelAuditMetadata({
      password: "secret",
      cookie: "raw-cookie",
      nested: {
        token: "raw-token",
        reason: "VIP guest",
        uri: "mongodb://user:pass@example/db",
      },
    });

    assert.equal(sanitized.password, undefined);
    assert.equal(sanitized.cookie, undefined);
    assert.equal(sanitized.nested.token, undefined);
    assert.equal(sanitized.nested.reason, "VIP guest");
    assert.match(sanitized.nested.uri, /redacted-mongodb-uri/);
  });

  test("request metadata stores hashes, not raw IP or user agent", async () => {
    const request = new Request("https://hotel.example/api", {
      headers: {
        "x-nf-client-connection-ip": "203.0.113.9",
        "x-forwarded-for": "198.51.100.99",
        "user-agent": "HotelTestAgent/1.0",
      },
    });
    const meta = getHotelRequestAuditMeta(request);
    assert.match(meta.ipHash, /^[0-9a-f]{64}$/);
    assert.match(meta.userAgentHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(meta).includes("203.0.113.9"));
    assert.ok(!JSON.stringify(meta).includes("HotelTestAgent"));

    const row = await recordHotelAudit(auditConnection(), {
      action: HOTEL_AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
      outcome: "FAILURE",
      request,
      metadata: { password: "must-not-persist", emailHash: "abc" },
    });
    assert.equal(row.metadata.password, undefined);
    assert.equal(row.metadata.emailHash, "abc");
    assert.ok(!JSON.stringify(row).includes("203.0.113.9"));
  });
});

describe("Hotel HTTP responses", () => {
  test("success envelope is no-store and error envelope hides internal errors", async () => {
    const success = hotelSuccess({ id: "1" });
    assert.equal(success.status, 200);
    assert.match(success.headers.get("cache-control"), /no-store/);
    assert.deepEqual(await success.json(), {
      success: true,
      data: { id: "1" },
      error: null,
    });

    const unauthorized = hotelErrorResponse(
      new HotelApiError({
        status: 401,
        code: HOTEL_ERROR_CODES.INVALID_CREDENTIALS,
        message: "Invalid email or password",
      })
    );
    assert.equal(unauthorized.status, 401);
    assert.deepEqual((await unauthorized.json()).error, {
      code: HOTEL_ERROR_CODES.INVALID_CREDENTIALS,
      message: "Invalid email or password",
    });

    const internal = hotelErrorResponse(
      new Error("upstream failure with password=pass and token=secret")
    );
    const internalBody = await internal.json();
    assert.equal(internal.status, 500);
    assert.equal(internalBody.error.message, "Internal Server Error");
    assert.ok(!JSON.stringify(internalBody).includes("pass"));
    assert.ok(!JSON.stringify(internalBody).includes("secret"));
  });

  test("validation errors expose safe field details only", async () => {
    const response = hotelErrorResponse(
      new HotelValidationError({ email: "email is invalid" })
    );
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, HOTEL_ERROR_CODES.VALIDATION_ERROR);
    assert.deepEqual(body.error.details, {
      fieldErrors: { email: "email is invalid" },
    });
  });

  test("wrapper converts thrown Hotel errors without leaking", async () => {
    const handler = withHotelApi(async () => {
      throw new HotelApiError({
        status: 403,
        code: HOTEL_ERROR_CODES.FORBIDDEN,
        message: "You do not have permission to perform this action",
      });
    });
    const response = await handler(new Request("https://hotel.example/api"));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, HOTEL_ERROR_CODES.FORBIDDEN);
  });
});
