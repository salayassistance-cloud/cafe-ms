// Server-side PIN helpers — legacy SystemAuth fallback for KDS/Barista/Manager.
// Staff collection is the canonical source for all individual PINs (including waiter).
// SystemAuth role PINs (waiterPin etc.) are legacy compatibility only.
// New waiter login uses Username+PIN via Staff (login-staff), not waiterNumber/device.
//
// PIN STORAGE: PINs are stored scrypt-hashed (salt:derived, see lib/pinCrypto)
// and verified with a constant-time comparison — plaintext is never persisted.
// Legacy plaintext 4-digit values are transparently upgraded to hashes on the
// first successful verification, so existing terminals keep working.

import {
  hashPin,
  isHashedPin,
} from "@/lib/pinCrypto";
import { getSystemAuthModel } from "@/lib/models/SystemAuth";
import crypto from "crypto";

export const ROLES = ["WAITER", "KITCHEN", "BARISTA", "MANAGER"];

// Default fallback PINs used when the document is first created or a stored
// value is found to be invalid (e.g. a legacy hashed value).
export const DEFAULT_PINS = {
  WAITER: "1111",
  KITCHEN: "2222",
  BARISTA: "3333",
  MANAGER: "4444",
};

const PIN_FIELD = {
  WAITER: "waiterPin",
  KITCHEN: "kitchenPin",
  BARISTA: "baristaPin",
  MANAGER: "managerPin",
};

const PIN_RE = /^\d{4}$/;

// ---- Hot-path snapshot cache (strict <50ms auth endpoints) ----
// A remote Atlas round trip alone costs 150-350ms and scrypt ~100ms — neither
// can fit inside a 50ms budget on a per-request basis. The system_auth
// singleton changes ONLY through this process's own writes (updatePins / legacy
// PIN upgrade / invalid-value repair / lock-unlock / reset), so a validated
// in-memory snapshot serves verify-pin AND the polled /api/waiter/active grid
// with zero database I/O. Every writer calls invalidateAuthCache() so the
// snapshot can never go stale.
let systemAuthSnapshot = null;
let systemAuthSnapshotPromise = null;

const SYSTEM_AUTH_SELECT =
  "waiterPin kitchenPin baristaPin managerPin activeWaiters";

async function loadSystemAuthSnapshot(conn) {
  if (!systemAuthSnapshotPromise) {
    systemAuthSnapshotPromise = (async () => {
      const Model = getSystemAuthModel(conn);
      const doc = await Model.findOne({ _id: "system" })
        .select(SYSTEM_AUTH_SELECT)
        .lean();
      if (!doc) return null;
      return {
        waiterPin: doc.waiterPin,
        kitchenPin: doc.kitchenPin,
        baristaPin: doc.baristaPin,
        managerPin: doc.managerPin,
        activeWaiters: Array.isArray(doc.activeWaiters) ? doc.activeWaiters : [],
      };
    })().finally(() => {
      systemAuthSnapshotPromise = null;
    });
  }
  const snap = await systemAuthSnapshotPromise;
  if (snap) systemAuthSnapshot = snap;
  return snap;
}

// Derived-key cache: scrypt (~100ms) dominates the hot path. After a stored
// hash is verified once, remember its derived key so the same terminal's next
// sign-in is a constant-time memory compare instead of another scrypt. Bounded
// to 128 entries; only caches keys for PINs that were actually verified.
const MAX_DERIVED = 128;
const derivedKeyCache = new Map(); // storedHash -> Buffer

function rememberDerived(stored, derived) {
  if (derivedKeyCache.size >= MAX_DERIVED) derivedKeyCache.clear();
  derivedKeyCache.set(stored, derived);
}

function invalidateAuthCache() {
  systemAuthSnapshot = null;
  derivedKeyCache.clear();
}

// Returns the singleton doc, creating it (with hashed default PINs) on first
// use and repairing any invalid value (missing / empty / not a 4-digit plaintext
// and not a valid scrypt hash) back to the hashed default.
export async function getSystemAuth(conn) {
  const Model = getSystemAuthModel(conn);
  let doc = await Model.findOne({ _id: "system" });
  if (!doc) {
    doc = await Model.create({ _id: "system" });
  }
  let changed = false;
  for (const role of ROLES) {
    const field = PIN_FIELD[role];
    const value = doc[field];
    const valid =
      typeof value === "string" && (PIN_RE.test(value) || isHashedPin(value));
    if (!valid) {
      doc[field] = hashPin(DEFAULT_PINS[role]);
      changed = true;
    }
  }
  if (changed) {
    await doc.save();
    invalidateAuthCache();
  }
  return doc;
}

export async function verifyRolePin(conn, role, pin) {
  if (!ROLES.includes(role)) return false;

  // Read from the in-memory snapshot (no DB I/O on the hot path).
  let snap = systemAuthSnapshot || (await loadSystemAuthSnapshot(conn));
  if (!snap) {
    // First boot ever: create the singleton with hashed defaults, then cache.
    await getSystemAuth(conn);
    snap = await loadSystemAuthSnapshot(conn);
    if (!snap) return false;
  }

  const stored = snap[PIN_FIELD[role]];
  if (typeof stored !== "string" || !stored) return false;

  // Hashed value: constant-time scrypt comparison, memoised per stored hash so
  // repeat sign-ins are a memory compare instead of a 100ms KDF.
  if (isHashedPin(stored)) {
    const [salt, keyHex] = stored.split(":");
    // Cache key includes the submitted PIN so a wrong attempt can never shadow
    // the derived key of the correct PIN for the same stored hash.
    const cacheKey = `${stored}:${pin}`;
    let derived = derivedKeyCache.get(cacheKey);
    if (!derived) {
      derived = crypto.scryptSync(String(pin), salt, 32);
      rememberDerived(cacheKey, derived);
    }
    const expected = Buffer.from(keyHex, "hex");
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  }

  // Legacy plaintext value: verify directly, then upgrade the stored PIN to a
  // hash on first successful login so plaintext never lingers in the database.
  if (PIN_RE.test(stored) && stored === String(pin)) {
    const upgraded = hashPin(String(pin));
    void getSystemAuth(conn)
      .then((doc) => {
        doc[PIN_FIELD[role]] = upgraded;
        return doc.save();
      })
      .then(invalidateAuthCache)
      .catch(() => {});
    return true;
  }

  return false;
}



// Updates the four role PINs — LEGACY COMPATIBILITY ONLY.
// Kept for /api/manager/settings/update-pins fallback and emergency.
// For canonical Staff PINs use lib/staffService changeStaffPin / manager staff API.
// Every supplied PIN must be exactly 4 digits and is stored scrypt-hashed.
export async function updatePins(conn, pins) {
  const doc = await getSystemAuth(conn);
  for (const role of ROLES) {
    const pin = String(pins[role] || "");
    if (!PIN_RE.test(pin)) {
      return { ok: false, error: `${role} PIN must be exactly 4 digits` };
    }
    doc[PIN_FIELD[role]] = hashPin(pin);
  }
  await doc.save();
  invalidateAuthCache();
  return { ok: true };
}

