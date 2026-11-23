// Hotel identity + PIN verification service.
//
// Identity is selected individually (an opaque HotelUser id from the login
// directory), never guessed by scanning a role's PINs. The server resolves the
// live HotelUser, verifies that identity's own PIN, and re-reads active status,
// authoritative role and lockout on every attempt. Collisions between two
// identities' PINs can therefore never authenticate the wrong person.
//
// Every failure returns the same public reason. `countFailure` is internal and
// only true for an active, unlocked identity that supplied a wrong PIN, so
// lockout attribution always targets the actual attempted identity.

import { getHotelUserModel } from "../models/hotelUser.js";
import { normalizeHotelRole } from "./authorization.js";
import {
  dummyHotelPinHash,
  hashHotelPin,
  isValidHotelPin,
  verifyHotelPin,
  verifyHotelPinAsync,
} from "./pin.js";

export const HOTEL_PIN_MAX_FAILED_ATTEMPTS = 5;
export const HOTEL_PIN_LOCK_MS = 15 * 60 * 1000;
export const HOTEL_INVALID_CREDENTIALS = "INVALID_CREDENTIALS";
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

export function isValidHotelIdentityId(value) {
  return typeof value === "string" && OBJECT_ID_RE.test(value);
}

export function isHotelIdentityLocked(user, now = Date.now()) {
  const until = user?.pinLockedUntil ? new Date(user.pinLockedUntil).getTime() : 0;
  return Number.isFinite(until) && until > Number(now);
}

// Public pre-login directory. Only opaque ids, display names and roles are
// exposed — never email, username, PIN hashes, lockout state, or credential
// internals. A PIN-less (legacy) account is not offered as a login identity.
export async function findLoginIdentities(connection, { role = null } = {}) {
  const HotelUser = getHotelUserModel(connection);
  const filter = {
    isActive: { $ne: false },
    pinHash: { $ne: null, $exists: true },
  };
  const normalizedRole = role ? normalizeHotelRole(role) : null;
  if (role && !normalizedRole) return [];
  if (normalizedRole) filter.role = normalizedRole;

  const users = await HotelUser.find(filter).select("_id name role").lean();
  return users.map((user) => ({
    id: String(user._id),
    name: user.name,
    role: user.role,
    label: `${user.name} (${user.role === "MANAGER" ? "Manager" : "Receptionist"})`,
  }));
}

// Phase 3F / E-26: the former findHotelUsersByRole helper was removed after
// verifying it had no runtime call sites. Role-wide PIN resolution must never
// be reintroduced: login always resolves exactly one selected HotelUser.

export async function getHotelUserWithPin(connection, userId) {
  if (!isValidHotelIdentityId(userId)) return null;
  const HotelUser = getHotelUserModel(connection);
  return HotelUser.findById(userId).select("+pinHash").lean();
}

// { ok: false, reason, userId: string|null, countFailure: boolean }
export async function verifyHotelUserPin(
  connection,
  { identityId, pin },
  { now = Date.now() } = {}
) {
  const fail = (user = null, countFailure = false) => ({
    ok: false,
    reason: HOTEL_INVALID_CREDENTIALS,
    userId: user ? String(user._id) : null,
    countFailure,
    failedAttempts: Number(user?.pinFailedAttempts || 0),
    wasLocked: user ? isHotelIdentityLocked(user, now) : false,
  });

  if (!isValidHotelIdentityId(identityId) || !isValidHotelPin(pin)) {
    verifyHotelPin(pin, dummyHotelPinHash());
    return fail();
  }

  const user = await getHotelUserWithPin(connection, identityId);
  if (!user) {
    verifyHotelPin(pin, dummyHotelPinHash());
    return fail();
  }

  const role = normalizeHotelRole(user.role);
  if (
    !role ||
    user.isActive === false ||
    !user.pinHash ||
    isHotelIdentityLocked(user, now)
  ) {
    verifyHotelPin(pin, dummyHotelPinHash());
    return fail(user, false);
  }

  if (!verifyHotelPin(pin, user.pinHash)) {
    return fail(user, true);
  }
  return { ok: true, user, role };
}

// Atomic increment + threshold lock on ONE identity. The pipeline form avoids
// read-modify-write races between concurrent failed attempts.
// Phase 3F / E-08: an already-expired lock resets the counter to 1 instead of
// preserving stale failures that would immediately re-lock the identity.
// Requires MongoDB >= 4.2 for pipeline updates (deployment verification).
export async function recordFailedHotelPinAttempt(
  connection,
  userId,
  { now = Date.now(), failedAttempts = 0, wasLocked = false } = {}
) {
  if (!isValidHotelIdentityId(userId)) return { updated: 0, locked: false };
  const HotelUser = getHotelUserModel(connection);
  const lockExpired = {
    $and: [
      { $ne: ["$pinLockedUntil", null] },
      { $lte: ["$pinLockedUntil", new Date(Number(now))] },
    ],
  };
  const result = await HotelUser.updateOne(
    { _id: userId, isActive: { $ne: false } },
    [
      {
        $set: {
          pinFailedAttempts: {
            $cond: [lockExpired, 1, { $add: [{ $ifNull: ["$pinFailedAttempts", 0] }, 1] }],
          },
        },
      },
      {
        $set: {
          pinLockedUntil: {
            $cond: [
              { $gte: ["$pinFailedAttempts", HOTEL_PIN_MAX_FAILED_ATTEMPTS] },
              new Date(Number(now) + HOTEL_PIN_LOCK_MS),
              {
                $cond: [
                  { $lte: ["$pinLockedUntil", new Date(Number(now))] },
                  null,
                  { $ifNull: ["$pinLockedUntil", null] },
                ],
              },
            ],
          },
        },
      },
    ]
  );
  return {
    updated: result.modifiedCount ?? 0,
    locked: !wasLocked && Number(failedAttempts) + 1 >= HOTEL_PIN_MAX_FAILED_ATTEMPTS,
  };
}

export async function resetHotelPinFailures(connection, userId, { additionalSet = {} } = {}) {
  if (!isValidHotelIdentityId(userId)) return null;
  const HotelUser = getHotelUserModel(connection);
  return HotelUser.updateOne(
    { _id: userId },
    { $set: { pinFailedAttempts: 0, pinLockedUntil: null, ...additionalSet } }
  );
}

// PIN collision check across ALL identities (active and inactive). Rejecting
// both avoids any ambiguous credential even for a reactivated account.
// Phase 3F / E-05/E-06: uses the async KDF and verifies candidates SEQUENTIALLY,
// keeping concurrent KDF work bounded to one operation per scan.
export async function findHotelPinCollision(connection, pin, { exceptUserId = null } = {}) {
  if (!isValidHotelPin(pin)) return null;
  const HotelUser = getHotelUserModel(connection);
  const filter = exceptUserId ? { _id: { $ne: exceptUserId } } : {};
  const users = await HotelUser.find(filter).select("+pinHash").lean();
  for (const user of users) {
    if (user.pinHash && (await verifyHotelPinAsync(pin, user.pinHash))) {
      return String(user._id);
    }
  }
  return null;
}

export async function setHotelUserPin(connection, userId, pin) {
  // Callers pass the `_id` of a Mongoose `.lean()` document, which is a bson
  // ObjectId at runtime (the in-memory test doubles use a 24-hex string).
  // Normalize to the string form before applying the strict identity check so
  // a real PIN update cannot fail as an invalid identity and surface as 500.
  const identityId = String(userId ?? "");
  if (!isValidHotelIdentityId(identityId) || !isValidHotelPin(pin)) {
    throw new Error("A valid Hotel identity and 4-digit PIN are required");
  }
  const HotelUser = getHotelUserModel(connection);
  return HotelUser.updateOne(
    { _id: identityId },
    {
      $set: {
        pinHash: hashHotelPin(pin),
        pinSetAt: new Date(),
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      },
    }
  );
}
