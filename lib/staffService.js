import { getStaffModel, STAFF_ROLES } from "@/lib/models/Staff";
import { hashPin, verifyPin, isHashedPin } from "@/lib/pinCrypto";

const PIN_RE = /^\d{4}$/;

export const DEFAULT_STAFF = [
  { name: "Abel", role: "WAITER", pin: "1111", waiterNumber: 3 },
  { name: "Kebebe", role: "WAITER", pin: "1111", waiterNumber: 4 },
  { name: "Waiter 1", role: "WAITER", pin: "1111", waiterNumber: 1 },
  { name: "Waiter 2", role: "WAITER", pin: "1111", waiterNumber: 2 },
  { name: "Kitchen", role: "KITCHEN", pin: "2222" },
  { name: "Barista", role: "BARISTA", pin: "3333" },
  { name: "Manager", role: "MANAGER", pin: "4444" },
];

/**
 * Ensure at least one staff per role exists. Called on first login or server start.
 * Non-destructive: only inserts missing {name, role} pairs.
 * Phase 6.5: assigns canonical waiterNumber 1..10 for WAITER, backfills missing numbers.
 * PERFORMANCE FIX: This previously executed ~10 sequential DB round trips on EVERY
 * login (7x findOne + 2x find + N x findById/save), blocking /api/auth/* for
 * 2-3s on Atlas. Now: single cached promise + fast-path + parallel batching.
 */
const _ensureState = globalThis;
if (!_ensureState.__ensureStaffState) _ensureState.__ensureStaffState = { done: false, promise: null };

export async function ensureDefaultStaff(conn) {
  const state = _ensureState.__ensureStaffState;
  if (state.done) return;
  if (state.promise) return state.promise;
  state.promise = (async () => {
  try {
    const Staff = getStaffModel(conn);
    // Fast parallel fetch of waiter numbers + all default candidates in one go
    const [existingWaiters, existingDefaults] = await Promise.all([
      Staff.find({ role: "WAITER", waiterNumber: { $type: "number" } }).select("waiterNumber").lean(),
      Staff.find({ $or: DEFAULT_STAFF.map((s) => ({ name: s.name, role: s.role })) }).lean(),
    ]);
    const used = new Set(existingWaiters.map((d) => d.waiterNumber).filter((n) => Number.isInteger(n) && n >= 1 && n <= 10));
    const nextFree = () => {
      for (let i = 1; i <= 10; i++) if (!used.has(i)) return i;
      return null;
    };

    // Map existing defaults for O(1) lookup
    const existingMap = new Map(existingDefaults.map((d) => [`${d.name}|${d.role}`, d]));

    // Determine missing vs existing that needs patching
    const toCreate = [];
    const toPatch = [];
    for (const s of DEFAULT_STAFF) {
      const key = `${s.name}|${s.role}`;
      const existing = existingMap.get(key);
      if (!existing) {
        let waiterNumber = null;
        if (s.role === "WAITER") {
          if (Number.isInteger(s.waiterNumber) && s.waiterNumber >= 1 && s.waiterNumber <= 10 && !used.has(s.waiterNumber)) {
            waiterNumber = s.waiterNumber;
          } else {
            const m = String(s.name).match(/Waiter\s+(\d+)/i);
            if (m) {
              const n = Number(m[1]);
              if (n >= 1 && n <= 10 && !used.has(n)) waiterNumber = n;
            }
            if (waiterNumber == null) waiterNumber = nextFree();
          }
          if (waiterNumber != null) used.add(waiterNumber);
        }
        const doc = { name: s.name, username: String(s.name).trim().toLowerCase(), role: s.role, pinHash: hashPin(s.pin), isActive: true };
        if (s.role === "WAITER") doc.waiterNumber = waiterNumber;
        toCreate.push(doc);
      } else {
        // Check if existing needs legacy fields backfilled
        let needsPatch = false;
        const patch = {};
        if (existing.isActive == null) { patch.isActive = true; needsPatch = true; }
        if (!existing.username && existing.name) { patch.username = String(existing.name).trim().toLowerCase(); needsPatch = true; }
        if (existing.role === "WAITER" && existing.waiterNumber == null) {
          let waiterNumber = null;
          const m = String(existing.name).match(/Waiter\s+(\d+)/i);
          if (m) {
            const n = Number(m[1]);
            if (n >= 1 && n <= 10 && !used.has(n)) waiterNumber = n;
          }
          if (waiterNumber == null) waiterNumber = nextFree();
          if (waiterNumber != null) {
            used.add(waiterNumber);
            patch.waiterNumber = waiterNumber;
            needsPatch = true;
          }
        }
        if (needsPatch) toPatch.push({ id: existing._id, patch, name: existing.name });
      }
    }

    // Parallel create of missing defaults
    if (toCreate.length > 0) {
      try {
        await Staff.insertMany(toCreate, { ordered: false });
      } catch (e) {
        // Ordered false + unique race may still error on some docs — ignore and fallback to per-doc create
        for (const doc of toCreate) {
          try { await Staff.create(doc); } catch (err) { console.warn(`[staffService] create ${doc.name} skipped: ${err.message}`); }
        }
      }
    }

    // Parallel patch of legacy fields (bulk)
    if (toPatch.length > 0) {
      const bulk = toPatch.map(({ id, patch }) => ({ updateOne: { filter: { _id: id }, update: { $set: patch } } }));
      try { await Staff.bulkWrite(bulk, { ordered: false }); } catch {}
      for (const p of toPatch) {
        if (p.patch.waiterNumber != null) console.log(`[staffService] backfilled waiterNumber ${p.patch.waiterNumber} for ${p.name}`);
      }
    }

    // If all defaults were present and no patch needed, check orphan backfills in parallel
    const needOrphanCheck = toCreate.length === 0 && toPatch.length === 0;
    // Always run orphan/username backfill check in parallel — but skip if fast path shows none missing
    const [missingOrphan, missingUsername] = await Promise.all([
      Staff.find({ role: "WAITER", waiterNumber: null }).select("_id name waiterNumber").lean(),
      Staff.find({ role: "WAITER", $or: [{ username: null }, { username: "" }] }).select("_id name username").lean(),
    ]);

    // Filter out docs already handled (the earlier patch may have updated same ids but lean snapshot stale — re-check via used set)
    // For orphan waiterNumber: build patches in memory then bulkWrite
    const orphanPatches = [];
    for (const doc of missingOrphan) {
      // Skip if doc id was in toPatch (already handled)
      if (toPatch.some((p) => String(p.id) === String(doc._id))) continue;
      if (doc.waiterNumber != null) continue;
      let waiterNumber = null;
      const m = String(doc.name).match(/Waiter\s+(\d+)/i);
      if (m) {
        const n = Number(m[1]);
        if (n >= 1 && n <= 10 && !used.has(n)) waiterNumber = n;
      }
      if (waiterNumber == null) waiterNumber = nextFree();
      if (waiterNumber != null) {
        used.add(waiterNumber);
        orphanPatches.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { waiterNumber } } } });
        console.log(`[staffService] backfilled waiterNumber ${waiterNumber} for ${doc.name} (orphan)`);
      }
    }
    if (orphanPatches.length > 0) {
      try { await Staff.bulkWrite(orphanPatches, { ordered: false }); } catch {}
    }

    const usernamePatches = [];
    const orphanIds = new Set(missingOrphan.map((d) => String(d._id)));
    for (const doc of missingUsername) {
      if (toPatch.some((p) => String(p.id) === String(doc._id))) continue;
      // orphan patches already handled waiterNumber, but username missing is independent
      // Check if already has username after potential earlier patch — we already filtered via query, but doc still empty
      usernamePatches.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { username: String(doc.name).trim().toLowerCase() } } } });
    }
    // De-duplicate username patches that overlap with orphan list — keep single update (merge not needed since bulk handles separately)
    if (usernamePatches.length > 0) {
      try { await Staff.bulkWrite(usernamePatches, { ordered: false }); } catch {}
      for (const doc of missingUsername) {
        if (toPatch.some((p) => String(p.id) === String(doc._id))) continue;
        console.log(`[staffService] backfilled username ${String(doc.name).trim().toLowerCase()} for ${doc.name}`);
      }
    }

    // Mark done if no remaining orphans
    const finalMissing = await Promise.all([
      Staff.countDocuments({ role: "WAITER", waiterNumber: null }),
      Staff.countDocuments({ role: "WAITER", $or: [{ username: null }, { username: "" }] }),
    ]);
    if (finalMissing[0] === 0 && finalMissing[1] === 0) {
      state.done = true;
    }
  } catch (e) {
    console.warn("[staffService] ensureDefaultStaff skipped:", e.message);
  } finally {
    state.promise = null;
  }
  })();
  return state.promise;
}

/**
 * Validate role enum.
 */
export function isValidRole(role) {
  return STAFF_ROLES.includes(role);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find staff by exact name/username + role (case-insensitive for username).
 * For WAITER, username is canonical (lowercase). Falls back to name for legacy.
 * PERFORMANCE FIX: Previously up to 4 sequential round trips per login.
 * Now single $or query — one DB round trip.
 */
export async function findStaff(conn, name, role) {
  if (!name || !role) return null;
  const Staff = getStaffModel(conn);
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const escaped = escapeRegex(trimmed);
  if (role === "WAITER") {
    // Single query covering all aliases — one round trip instead of four sequential
    const doc = await Staff.findOne({
      role,
      $or: [
        { username: lower },
        { username: { $regex: `^${escaped}$`, $options: "i" } },
        { name: trimmed },
        { name: { $regex: `^${escaped}$`, $options: "i" } },
      ],
    });
    return doc;
  }
  // For other roles, try name exact then case-insensitive in one query
  const doc = await Staff.findOne({
    role,
    $or: [{ name: trimmed }, { name: { $regex: `^${escaped}$`, $options: "i" } }],
  });
  return doc;
}

export async function verifyStaffPin(conn, name, pin, role) {
  if (!PIN_RE.test(String(pin))) return { ok: false, error: "PIN must be 4 digits" };
  if (!isValidRole(role)) return { ok: false, error: "Invalid role" };
  const staff = await findStaff(conn, name, role);
  if (!staff) return { ok: false, error: "Invalid Name or PIN" };
  if (staff.isActive === false) return { ok: false, error: "Invalid Name or PIN" };
  const stored = staff.pinHash;
  let valid = false;
  if (isHashedPin(stored)) {
    valid = verifyPin(pin, stored);
  } else {
    // Legacy plaintext (should not happen after migration)
    valid = String(stored) === String(pin);
    if (valid) {
      // Upgrade to hash
      staff.pinHash = hashPin(String(pin));
      await staff.save().catch(() => {});
    }
  }
  if (!valid) return { ok: false, error: "Invalid Name or PIN" };
  return { ok: true, staff };
}

/**
 * Change PIN for a staff member. Validates current PIN, then hashes new PIN.
 */
export async function changeStaffPin(conn, { staffId, currentPin, newPin }) {
  if (!staffId) return { ok: false, error: "staffId required" };
  if (!PIN_RE.test(String(currentPin))) return { ok: false, error: "Current PIN must be 4 digits" };
  if (!PIN_RE.test(String(newPin))) return { ok: false, error: "New PIN must be exactly 4 digits" };
  if (String(currentPin) === String(newPin)) return { ok: false, error: "New PIN must differ from current PIN" };

  const Staff = getStaffModel(conn);
  const staff = await Staff.findById(staffId);
  if (!staff) return { ok: false, error: "Staff not found" };

  let valid = false;
  if (isHashedPin(staff.pinHash)) {
    valid = verifyPin(currentPin, staff.pinHash);
  } else {
    valid = String(staff.pinHash) === String(currentPin);
  }
  if (!valid) return { ok: false, error: "Current PIN is incorrect" };

  staff.pinHash = hashPin(String(newPin));
  await staff.save();
  return { ok: true, staff };
}

/**
 * Update PIN by name+role (alternative for legacy SystemAuth-style calls).
 */
export async function changePinByNameRole(conn, { name, role, currentPin, newPin }) {
  const staff = await findStaff(conn, name, role);
  if (!staff) return { ok: false, error: "Staff not found" };
  return changeStaffPin(conn, { staffId: staff._id, currentPin, newPin });
}

export async function listStaffByRole(conn, role) {
  const Staff = getStaffModel(conn);
  const filter = role ? { role } : {};
  return Staff.find(filter).select("name username role waiterNumber isActive createdAt updatedAt").sort({ role: 1, waiterNumber: 1, name: 1 }).lean();
}

export async function disableStaff(conn, staffId) {
  const Staff = getStaffModel(conn);
  const staff = await Staff.findById(staffId);
  if (!staff) return { ok: false, error: "Staff not found" };
  if (staff.isActive === false) return { ok: false, error: "Already disabled" };
  staff.isActive = false;
  await staff.save();
  return { ok: true, staff };
}

export async function enableStaff(conn, staffId) {
  const Staff = getStaffModel(conn);
  const staff = await Staff.findById(staffId);
  if (!staff) return { ok: false, error: "Staff not found" };
  staff.isActive = true;
  await staff.save();
  return { ok: true, staff };
}


