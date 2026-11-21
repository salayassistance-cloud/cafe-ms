// Phase 2.1 — shared MenuItem `policyVersion` serialization.
//
// Classification and order creation/edit-addition both write the SAME
// MenuItem document inside a transaction using a conditional policyVersion
// filter. MongoDB write conflicts therefore serialize the two flows: the
// loser aborts and is retried with freshly re-resolved catalog/policy data.
// Neither flow can commit a stale inventory policy alongside a committed
// classification change.
//
// Legacy documents without `policyVersion` are treated as version 0; the
// filter matches 0, null and missing in one predicate, so no backfill or
// initialization write is needed.

import mongoose from "mongoose";

import { getMenuItemModel } from "@/lib/models/MenuItem";
import { runInTransaction } from "@/lib/transactionRunner";

export const POLICY_VERSION_CONFLICT = "POLICY_VERSION_CONFLICT";
export const POLICY_TRANSACTION_UNAVAILABLE = "POLICY_TRANSACTION_UNAVAILABLE";
export const ORDER_EDIT_CONFLICT = "ORDER_EDIT_CONFLICT";

export class PolicyVersionError extends Error {
  constructor(code, status = 409, message = null) {
    super(
      message ||
        (code === POLICY_VERSION_CONFLICT
          ? "Menu item classification changed concurrently; please retry."
          : "Safe transactional order/classification processing is unavailable. Please retry shortly.")
    );
    this.name = "PolicyVersionError";
    this.code = code;
    this.status = status;
  }
}

export function isPolicyVersionError(err) {
  return !!err && err.name === "PolicyVersionError";
}

export function normalizePolicyVersion(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : 0;
}

// Mongo `null` also matches missing fields, so this single predicate covers
// legacy documents that never had the field.
export function policyVersionFilter(value) {
  const version = normalizePolicyVersion(value);
  return version === 0 ? { $in: [0, null] } : version;
}

// Fake/test query objects in the DB-free suite may not implement .session().
// Production Mongoose queries always do and receive the session.
export function attachSession(query, session) {
  if (session && query && typeof query.session === "function") {
    return query.session(session);
  }
  return query;
}

/**
 * Conditionally bump one or more MenuItem policy versions.
 *
 * @param {object} conn
 * @param {Array<{menuItemId: string, expectedVersion: *, set?: object,
 *                filter?: object, runValidators?: boolean, timestamps?: boolean}>} entries
 * @param {object|null} session transaction session from runPolicyVersionedTransaction
 */
export async function bumpMenuItemPolicyVersions(conn, entries, session) {
  const MenuItem = getMenuItemModel(conn);
  for (const entry of entries || []) {
    const current = normalizePolicyVersion(entry.expectedVersion);
    const filter = {
      _id: new mongoose.Types.ObjectId(String(entry.menuItemId)),
      isDeleted: { $ne: true },
      policyVersion: policyVersionFilter(current),
      ...(entry.filter || {}),
    };
    const update = {
      $set: {
        policyVersion: current + 1,
        ...(entry.set || {}),
      },
    };
    const maybeQuery = await MenuItem.findOneAndUpdate(filter, update, {
      session,
      returnDocument: "after",
      runValidators: entry.runValidators !== false,
      // Order creation must not change the catalog's public updatedAt merely
      // to serialize; classification explicitly supplies its own updatedAt.
      timestamps: entry.timestamps !== false,
    });
    // Mongoose returns a Query; in-memory test doubles may return the doc.
    const doc =
      maybeQuery && typeof maybeQuery.lean === "function"
        ? await maybeQuery.lean()
        : maybeQuery;
    if (!doc) throw new PolicyVersionError(POLICY_VERSION_CONFLICT);
  }
}

/**
 * Single transaction attempt with the same fail-closed session check. Used by
 * order flows whose caller re-resolves catalog data in an outer retry loop.
 */
export async function runPolicyVersionTransactionOnce(conn, fn, options = {}) {
  if (!conn || typeof conn.startSession !== "function") {
    throw new PolicyVersionError(POLICY_TRANSACTION_UNAVAILABLE, 503);
  }
  // Order flows retry at the outer level, where the Order document and version
  // entries are reconstructed. A single inner attempt prevents a transient
  // retry from reusing an aborted attempt's mutable Mongoose document.
  return runInTransaction(conn, fn, { ...options, maxAttempts: 1 });
}

/**
 * Run `fn` inside the existing bounded transaction runner, retrying the whole
 * callback when a conditional policyVersion write misses. Callbacks must
 * re-resolve catalog/policy data on every attempt.
 */
export async function runPolicyVersionedTransaction(conn, fn, options = {}) {
  if (!conn || typeof conn.startSession !== "function") {
    throw new PolicyVersionError(POLICY_TRANSACTION_UNAVAILABLE, 503);
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runInTransaction(conn, fn, options);
    } catch (err) {
      lastErr = err;
      if (err?.code === POLICY_VERSION_CONFLICT && attempt < 2) continue;
      throw err;
    }
  }
  throw lastErr || new PolicyVersionError(POLICY_VERSION_CONFLICT);
}
