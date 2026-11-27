// inventoryReservationService.js — Phase 1 inventory hardening.
//
// PRE-PREPARATION INVENTORY GATE (Stock Policy A)
//
// Physical stock              -> InventoryItem.currentStock
// Held for active orders      -> InventoryItem.reservedStock
// Sellable now                -> currentStock - reservedStock
// Insufficient stock          -> InventoryReservation.status INSUFFICIENT_STOCK
//                                (blocks preparation AND payment; never negative)
// Actual consumption          -> StockMovement reason SaleDeduction at FIRST
//                                preparation start (payment is idempotent
//                                fallback for legacy direct settlement)
// Post-preparation cancellation -> reservation void + SaleDeduction reclassified
//                                to Waste; stock is never restored
//
// Design guarantees:
//  * A reservation is one document per order (unique orderId) and is idempotent.
//  * All hold changes are atomic conditional updates inside a MongoDB session.
//    A read followed by an unconditional decrement is never used.
//  * Shortage is never represented as negative currentStock.
//  * There is no Manager shortage override. A shortage blocks preparation and
//    payment; stock must become available (or the order edited) first.
//  * Cancellation before preparation releases holds exactly once.
//  * Cancellation after preparation never restores consumed stock; it records
//    an auditable void/waste instead.
//  * Consumption is claimed once, so preparation retries and payment retries
//    cannot deduct stock twice.
//  * No dependencies and no production database access at import time.

import mongoose from "mongoose";
import { getInventoryReservationModel } from "@/lib/models/InventoryReservation";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { getStockMovementModel } from "@/lib/models/StockMovement";
import { prepareInventoryDeduction } from "@/lib/inventoryDeductionService";
import {
  QTY_EPSILON,
  round3,
  sameUnit,
  availableOf,
  planCoverage,
  hasConsumedStock,
  releasePlan,
  consumptionPlan,
  buildRequirementFingerprint,
  buildShortageFingerprint,
} from "@/lib/inventoryReservationRules";
import {
  convertRequirementToStockUnit,
  mergeRequirements,
} from "@/lib/inventoryRequirementConversion";
import { validateInventoryUnit } from "@/lib/inventoryUnitGuard";
import { runInTransaction as runSharedTransaction } from "@/lib/transactionRunner";

export { buildRequirementFingerprint, buildShortageFingerprint };

// OBS-1: a reservation in an in-flight or terminal state belongs to the
// consumption/void path. Reconciliation must never rewrite it, and the guard
// must hold even if consumption claims the status between the read and the
// write — so the same canonical list feeds both the read-side guards and the
// atomic write predicate below.
export const IMMUTABLE_RESERVATION_STATUSES = Object.freeze([
  "CONSUMING",
  "CONSUMED",
  "RELEASED",
]);

export function canReconcileReservation(status) {
  return !IMMUTABLE_RESERVATION_STATUSES.includes(status);
}

// Atomic predicate for the reconciliation write. Built from the canonical list
// so a stale snapshot can never overwrite a newer immutable status.
export function buildReconcileWriteFilter(reservationId) {
  return { _id: reservationId, status: { $nin: IMMUTABLE_RESERVATION_STATUSES } };
}

export class InventoryReservationError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = "InventoryReservationError";
    this.status = status;
    if (code) this.code = code;
  }
}

function toOid(value) {
  const s = String(value || "").trim();
  return s && mongoose.isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : null;
}

function orderIdOf(order) {
  const oid = toOid(order?._id || order?.id);
  if (!oid) throw new InventoryReservationError("Order id is required", 400);
  return oid;
}

// Phase 2.3 runner extracted to lib/transactionRunner.js (single retry policy
// shared with Recipe writes and InventoryItem unit changes). This wrapper keeps
// the reservation layer's typed TRANSACTIONS_UNAVAILABLE 503 contract; the
// retry classification and bounds are unchanged.
async function runInTransaction(conn, fn) {
  return runSharedTransaction(conn, fn, {
    makeUnavailableError: (message, status, code) =>
      new InventoryReservationError(message, status, code),
  });
}

// Calculate recipe-linked requirements (read-only). Cancelled lines, NOTE
// components and recipe-less items never reserve stock. `unresolved` carries
// required recipe rows that could not be extracted safely (missing link,
// quantity, or unit) so the reservation fails closed instead of becoming a
// payable NO_INVENTORY. Exported for DB-free regression tests.
export async function calculateRawRequirements(conn, order) {
  const plan = await prepareInventoryDeduction(order, { connection: conn });
  return {
    warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
    unresolved: Array.isArray(plan.unresolved) ? plan.unresolved : [],
    requirements: (Array.isArray(plan.ingredients) ? plan.ingredients : [])
      .map((it) => ({
        inventoryItemId: String(it.inventoryItemId || ""),
        unit: String(it.unit || "").trim(),
        requiredQuantity: round3(it.quantity),
      }))
      .filter((it) => it.inventoryItemId && it.requiredQuantity > 0),
  };
}

// Validate every requirement against the live InventoryItem documents.
// Invalid references and unit mismatches are explicit warnings and never
// fabricate a deduction. They do not block unrelated (valid) items, but they
// are also recorded in `unresolved`: a required recipe ingredient that cannot
// be validated must fail closed instead of disappearing into a payable
// NO_INVENTORY. A truly untracked item produces no requirement at all and is
// therefore never marked unresolved.
//
// `unresolved` is a seed from requirement extraction (malformed recipe rows).
// Every caller must pass it; the seed survives even when the requirement list
// is empty. Exported for DB-free regression tests.
export async function validateRequirements(
  conn,
  requirements,
  { session = null, unresolved: seededUnresolved = [] } = {}
) {
  const warnings = [];
  const unresolved = Array.isArray(seededUnresolved) ? [...seededUnresolved] : [];
  if (!requirements.length) return { items: [], inventory: new Map(), warnings, unresolved };
  const InventoryItem = getInventoryItemModel(conn);
  const ids = [...new Set(requirements.map((it) => it.inventoryItemId))].filter((id) =>
    mongoose.isValidObjectId(id)
  );
  let query = InventoryItem.find({ _id: { $in: ids } }).select(
    "_id name unit currentStock reservedStock cost"
  );
  if (session) query = query.session(session);
  const docs = await query.lean();
  const inventory = new Map(docs.map((d) => [String(d._id), d]));

  const items = [];
  for (const req of requirements) {
    const doc = inventory.get(req.inventoryItemId);
    if (!doc) {
      const warning = `Inventory item ${req.inventoryItemId} referenced by recipe was not found — no reservation`;
      warnings.push(warning);
      unresolved.push(warning);
      continue;
    }
    const invUnit = String(doc.unit || "").trim();
    if (!sameUnit(invUnit, req.unit)) {
      // Units differ. Convert exactly into the item's stock unit, or fail
      // closed. V1's three-decimal precision is enforced inside the helper
      // before any rounding can happen; nothing is ever rounded into range.
      const conversion = convertRequirementToStockUnit(
        req.requiredQuantity,
        req.unit,
        invUnit
      );
      if (!conversion.ok) {
        const warning = `Unit mismatch for inventory item ${req.inventoryItemId}: recipe ${req.unit}, inventory ${invUnit || "(missing)"} — no reservation (${conversion.code})`;
        warnings.push(warning);
        unresolved.push(warning);
        continue;
      }
      items.push({
        inventoryItemId: req.inventoryItemId,
        unit: invUnit,
        requiredQuantity: conversion.quantity,
      });
      continue;
    }
    // Identical unit text keeps the existing V1 semantics — but only for an
    // approved unit. cup/cup or bottle/bottle must not silently pass just
    // because both free-text values happen to match.
    const unitCheck = validateInventoryUnit(invUnit || req.unit, "inventory unit");
    if (!unitCheck.ok) {
      const warning = `Unsupported inventory unit for item ${req.inventoryItemId}: recipe ${req.unit}, inventory ${invUnit || "(missing)"} — no reservation (${unitCheck.code})`;
      warnings.push(warning);
      unresolved.push(warning);
      continue;
    }
    items.push({
      inventoryItemId: req.inventoryItemId,
      unit: invUnit || req.unit,
      requiredQuantity: round3(req.requiredQuantity),
    });
  }

  // M3: deterministic merge per inventory item after exact conversion. Rows
  // that could not be converted exactly were already skipped above.
  const merged = mergeRequirements(items);
  for (const warning of merged.warnings) {
    warnings.push(warning);
    unresolved.push(warning);
  }
  return { items: merged.items, inventory, warnings, unresolved };
}

function itemsFromReservation(reservation) {
  return (Array.isArray(reservation?.items) ? reservation.items : []).map((it) => ({
    inventoryItemId: String(it.inventoryItemId),
    unit: String(it.unit || ""),
    requiredQuantity: round3(it.requiredQuantity),
    reservedQuantity: round3(it.reservedQuantity),
    shortageQuantity: round3(it.shortageQuantity),
    availableAtDecision: round3(it.availableAtDecision),
    consumedQuantity: round3(it.consumedQuantity),
  }));
}

function summarize(reservation) {
  if (!reservation) return null;
  const doc = typeof reservation.toObject === "function" ? reservation.toObject() : reservation;
  const items = itemsFromReservation(doc);
  return {
    reservationId: doc._id ? String(doc._id) : null,
    orderId: doc.orderId ? String(doc.orderId) : null,
    orderNumber: doc.orderNumber || null,
    status: doc.status,
    items,
    warnings: Array.isArray(doc.warnings) ? doc.warnings : [],
    unresolved: doc.unresolved === true,
    requirementFingerprint: doc.requirementFingerprint || null,
    shortageFingerprint: doc.shortageFingerprint || null,
    approval: doc.approval
      ? {
          managerId: doc.approval.managerId ? String(doc.approval.managerId) : null,
          approvedAt: doc.approval.approvedAt ? new Date(doc.approval.approvedAt).toISOString() : null,
          reason: doc.approval.reason || null,
          requirementFingerprint: doc.approval.requirementFingerprint || null,
          shortageFingerprint: doc.approval.shortageFingerprint || null,
          shortages: (doc.approval.shortages || []).map((s) => ({
            inventoryItemId: String(s.inventoryItemId),
            unit: s.unit,
            requiredQuantity: Number(s.requiredQuantity) || 0,
            availableQuantity: Number(s.availableQuantity) || 0,
            shortageQuantity: Number(s.shortageQuantity) || 0,
          })),
        }
      : null,
    decisionAt: doc.decisionAt ? new Date(doc.decisionAt).toISOString() : null,
    consumedAt: doc.consumedAt ? new Date(doc.consumedAt).toISOString() : null,
    consumedBy: doc.consumedBy ? String(doc.consumedBy) : null,
    consumedTrigger: doc.consumedTrigger || null,
    releasedAt: doc.releasedAt ? new Date(doc.releasedAt).toISOString() : null,
    releaseReason: doc.releaseReason || null,
    voidedAt: doc.voidedAt ? new Date(doc.voidedAt).toISOString() : null,
    voidReason: doc.voidReason || null,
    voidedBy: doc.voidedBy ? String(doc.voidedBy) : null,
    voids: (doc.voids || []).map((v) => ({
      at: v.at ? new Date(v.at).toISOString() : null,
      by: v.by ? String(v.by) : null,
      reason: v.reason || null,
      phase: v.phase || null,
      source: v.source || null,
      lineId: v.lineId ? String(v.lineId) : null,
      station: v.station || null,
      items: (v.items || []).map((it) => ({
        inventoryItemId: String(it.inventoryItemId),
        unit: it.unit || "",
        quantity: Number(it.quantity) || 0,
      })),
    })),
    hasShortage: items.some((it) => it.shortageQuantity > QTY_EPSILON),
  };
}

export { summarize as serializeInventoryReservation };

async function createNoInventoryReservation(conn, order, warnings, { blocked = false } = {}) {
  const Reservation = getInventoryReservationModel(conn);
  const orderId = orderIdOf(order);
  const now = new Date();
  const requirementFingerprint = buildRequirementFingerprint(orderId, []);
  // An unresolved requirement is NOT the same as a legitimately untracked
  // order: it must block preparation/payment. Reusing INSUFFICIENT_STOCK keeps
  // the existing blocking state contract; `unresolved` records why.
  const status = blocked ? "INSUFFICIENT_STOCK" : "NO_INVENTORY";
  try {
    return await Reservation.findOneAndUpdate(
      { orderId },
      {
        $setOnInsert: {
          orderId,
          orderNumber: order.orderNumber || null,
          status,
          items: [],
          warnings: warnings.slice(0, 50),
          unresolved: blocked,
          requirementFingerprint,
          shortageFingerprint: buildShortageFingerprint(requirementFingerprint, []),
          decisionAt: now,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).lean();
  } catch (err) {
    if (err?.code === 11000) {
      return Reservation.findOne({ orderId }).lean();
    }
    throw err;
  }
}

// Idempotently create the pre-preparation reservation for an order.
// Safe to call from order creation, the preparation gate and payment fallback.
export async function ensureOrderInventoryReservation(conn, order) {
  if (!conn) throw new InventoryReservationError("Database connection is required", 503);
  const orderId = orderIdOf(order);
  const Reservation = getInventoryReservationModel(conn);

  const existing = await Reservation.findOne({ orderId }).lean();
  if (existing) return existing;

  const raw = await calculateRawRequirements(conn, order);
  const validated = await validateRequirements(conn, raw.requirements, { unresolved: raw.unresolved });
  const warnings = [...raw.warnings, ...validated.warnings].slice(0, 50);
  const unresolved = validated.unresolved;

  if (validated.items.length === 0) {
    return createNoInventoryReservation(conn, order, warnings, {
      blocked: unresolved.length > 0,
    });
  }

  const requirementFingerprint = buildRequirementFingerprint(orderId, validated.items);

  try {
    return await runInTransaction(conn, async (session) => {
      const current = await Reservation.findOne({ orderId }).session(session).lean();
      if (current) return current;

      // Re-validate inside the transaction so availability is transaction-consistent.
      const live = await validateRequirements(conn, raw.requirements, { session, unresolved: raw.unresolved });
      if (live.items.length === 0) {
        const blocked = live.unresolved.length > 0;
        const [doc] = await Reservation.create(
          [
            {
              orderId,
              orderNumber: order.orderNumber || null,
              status: blocked ? "INSUFFICIENT_STOCK" : "NO_INVENTORY",
              items: [],
              warnings: warnings.slice(0, 50),
              unresolved: blocked,
              requirementFingerprint: buildRequirementFingerprint(orderId, []),
              shortageFingerprint: buildShortageFingerprint(
                buildRequirementFingerprint(orderId, []),
                []
              ),
              decisionAt: new Date(),
            },
          ],
          { session }
        );
        return doc;
      }

      const InventoryItem = getInventoryItemModel(conn);
      const now = new Date();
      // Reserve the physically available portion of every requirement. A
      // shortage order therefore holds all stock it honestly can, while the
      // uncovered remainder is recorded as an explicit blocking shortage
      // (never as negative stock).
      const items = live.items.map((it) => {
        const inv = live.inventory.get(it.inventoryItemId);
        const avail = availableOf(inv);
        const plan = planCoverage(it.requiredQuantity, 0, avail);
        return {
          inventoryItemId: new mongoose.Types.ObjectId(it.inventoryItemId),
          unit: it.unit,
          requiredQuantity: it.requiredQuantity,
          reservedQuantity: plan.reservedQuantity,
          shortageQuantity: plan.shortageQuantity,
          availableAtDecision: round3(avail),
          consumedQuantity: 0,
        };
      });
      const fullyReserved =
        live.unresolved.length === 0 &&
        items.every((it) => it.shortageQuantity <= QTY_EPSILON);

      for (const it of items) {
        if (it.reservedQuantity <= 0) continue;
        const updated = await InventoryItem.updateOne(
          {
            _id: it.inventoryItemId,
            $expr: {
              $gte: [
                {
                  $subtract: [
                    { $ifNull: ["$currentStock", 0] },
                    { $ifNull: ["$reservedStock", 0] },
                  ],
                },
                it.reservedQuantity,
              ],
            },
          },
          { $inc: { reservedStock: it.reservedQuantity } },
          { session }
        );
        if ((updated.modifiedCount ?? updated.nModified ?? 0) === 0) {
          throw new InventoryReservationError(
            "Inventory changed while reserving. Please retry.",
            409,
            "RESERVATION_CONFLICT"
          );
        }
      }

      const status = fullyReserved ? "RESERVED" : "INSUFFICIENT_STOCK";
      const requirementFp = buildRequirementFingerprint(orderId, items);
      const shortageFp = buildShortageFingerprint(requirementFp, items);
      const [doc] = await Reservation.create(
        [
          {
            orderId,
            orderNumber: order.orderNumber || null,
            status,
            items,
            warnings: [...warnings, ...live.warnings].slice(0, 50),
            unresolved: live.unresolved.length > 0,
            requirementFingerprint: requirementFp,
            shortageFingerprint: shortageFp,
            decisionAt: now,
          },
        ],
        { session }
      );
      return doc;
    });
  } catch (err) {
    if (err?.code === 11000) {
      const raced = await Reservation.findOne({ orderId }).lean();
      if (raced) return raced;
    }
    throw err;
  }
}

// Recompute requirements and adjust the hold. Used after edit/cancel operations
// and by the preparation gate (self-healing if a hook was missed).
export async function reconcileOrderInventory(conn, order) {
  const orderId = orderIdOf(order);
  const Reservation = getInventoryReservationModel(conn);
  let reservation = await Reservation.findOne({ orderId }).lean();
  if (!reservation) reservation = await ensureOrderInventoryReservation(conn, order);
  if (!reservation) return null;
  if (!canReconcileReservation(reservation.status)) return reservation;

  const raw = await calculateRawRequirements(conn, order);
  const validated = await validateRequirements(conn, raw.requirements, { unresolved: raw.unresolved });
  const newRequirementFp = buildRequirementFingerprint(orderId, validated.items);

  // Fast no-op for stable reservations. Historical APPROVED reservations are
  // also left untouched while their requirement is unchanged so old orders
  // remain readable/reportable; they are never re-created by new code. An
  // unresolved requirement must never no-op into an acceptable state.
  if (
    ["RESERVED", "APPROVED", "NO_INVENTORY"].includes(reservation.status) &&
    reservation.requirementFingerprint === newRequirementFp &&
    validated.unresolved.length === 0
  ) {
    return reservation;
  }

  try {
    return await runInTransaction(conn, async (session) => {
      const current = await Reservation.findOne({ orderId }).session(session).lean();
      if (!current) {
        throw new InventoryReservationError("Reservation disappeared", 409, "RESERVATION_CONFLICT");
      }
      if (!canReconcileReservation(current.status)) return current;

      const live = await validateRequirements(conn, raw.requirements, { session, unresolved: raw.unresolved });
      const currentFp = buildRequirementFingerprint(orderId, live.items);
      const oldMap = new Map(itemsFromReservation(current).map((it) => [it.inventoryItemId, it]));

      const target = new Map();
      for (const it of live.items) {
        const old = oldMap.get(it.inventoryItemId);
        const oldHold = round3(old?.reservedQuantity || 0);
        const inv = live.inventory.get(it.inventoryItemId);
        // An already-held quantity is preserved exactly. Otherwise the order
        // grabs as much genuinely available stock as it can; the remainder is
        // an explicit blocking shortage. Stock is never allowed to go negative.
        const plan = planCoverage(it.requiredQuantity, oldHold, availableOf(inv));
        target.set(it.inventoryItemId, {
          ...it,
          reservedQuantity: plan.reservedQuantity,
          shortageQuantity: plan.shortageQuantity,
        });
      }

      // Items removed from the order release their holds.
      for (const [invId, old] of oldMap) {
        if (!target.has(invId) && old.reservedQuantity > 0) {
          target.set(invId, {
            inventoryItemId: invId,
            unit: old.unit,
            requiredQuantity: 0,
            reservedQuantity: 0,
            availableAtDecision: 0,
            consumedQuantity: old.consumedQuantity || 0,
          });
        }
      }

      const InventoryItem = getInventoryItemModel(conn);

      for (const next of target.values()) {
        const old = oldMap.get(next.inventoryItemId);
        const oldHold = round3(old?.reservedQuantity || 0);
        const newHold = round3(next.reservedQuantity || 0);
        const delta = round3(newHold - oldHold);

        if (delta > 0) {
          const updated = await InventoryItem.updateOne(
            {
              _id: next.inventoryItemId,
              $expr: {
                $gte: [
                  {
                    $subtract: [
                      { $ifNull: ["$currentStock", 0] },
                      { $ifNull: ["$reservedStock", 0] },
                    ],
                  },
                  delta,
                ],
              },
            },
            { $inc: { reservedStock: delta } },
            { session }
          );
          if ((updated.modifiedCount ?? updated.nModified ?? 0) === 0) {
            throw new InventoryReservationError(
              "Inventory changed while reconciling the order. Please retry.",
              409,
              "RESERVATION_CONFLICT"
            );
          }
        } else if (delta < 0) {
          await InventoryItem.updateOne(
            { _id: next.inventoryItemId },
            [
              {
                $set: {
                  reservedStock: {
                    $max: [
                      0,
                      {
                        $subtract: [
                          { $ifNull: ["$reservedStock", 0] },
                          Math.abs(delta),
                        ],
                      },
                    ],
                  },
                },
              },
            ],
            { session, updatePipeline: true }
          );
        }
      }

      const now = new Date();
      const finalItems = [];
      for (const it of live.items) {
        const targetItem = target.get(it.inventoryItemId);
        const inv = live.inventory.get(it.inventoryItemId);
        const hold = round3(targetItem?.reservedQuantity || 0);
        const previousHold = round3(oldMap.get(it.inventoryItemId)?.reservedQuantity || 0);
        finalItems.push({
          inventoryItemId: new mongoose.Types.ObjectId(it.inventoryItemId),
          unit: it.unit,
          requiredQuantity: it.requiredQuantity,
          reservedQuantity: hold,
          shortageQuantity: Math.max(0, round3(it.requiredQuantity - hold)),
          // Pre-reconcile stock attributable to this order, independent of the
          // hold movement performed above (same rule as initial reservation).
          availableAtDecision: round3(previousHold + availableOf(inv)),
          consumedQuantity: round3(oldMap.get(it.inventoryItemId)?.consumedQuantity || 0),
        });
      }

      const shortage = finalItems.some((it) => it.shortageQuantity > QTY_EPSILON);
      let nextStatus;
      if (live.unresolved.length > 0) {
        // A required ingredient that cannot be validated outranks every other
        // consideration: preparation and payment stay blocked.
        nextStatus = "INSUFFICIENT_STOCK";
      } else if (shortage) {
        nextStatus = "INSUFFICIENT_STOCK";
      } else if (finalItems.length === 0) {
        nextStatus = "NO_INVENTORY";
      } else {
        nextStatus = "RESERVED";
      }

      const requirementFp = buildRequirementFingerprint(orderId, finalItems);
      const shortageFp = buildShortageFingerprint(requirementFp, finalItems);
      const updated = await Reservation.findOneAndUpdate(
        buildReconcileWriteFilter(current._id),
        {
          $set: {
            status: nextStatus,
            items: finalItems,
            warnings: [...raw.warnings, ...live.warnings].slice(0, 50),
            unresolved: live.unresolved.length > 0,
            requirementFingerprint: requirementFp,
            shortageFingerprint: shortageFp,
            decisionAt: now,
            // A legacy approval is never re-adopted by the current policy.
            approval: null,
          },
        },
        { session, returnDocument: 'after' }
      ).lean();
      if (!updated) {
        // The status became immutable between the snapshot read above and this
        // write (or the document vanished). Never report the stale snapshot as a
        // successful reconciliation: the existing conflict handler re-reads the
        // committed state outside the aborted transaction and lets the newer
        // owner (consumption or void) win.
        throw new InventoryReservationError(
          "Reservation changed during reconciliation",
          409,
          "RESERVATION_CONFLICT"
        );
      }
      return updated;
    });
  } catch (err) {
    if (err instanceof InventoryReservationError) {
      const fresh = await Reservation.findOne({ orderId }).lean();
      if (fresh) return fresh;
    }
    throw err;
  }
}

// Pre-preparation gate used by the station dispatch path.
export async function assertOrderInventoryReady(conn, order) {
  const orderId = orderIdOf(order);
  const Reservation = getInventoryReservationModel(conn);
  let reservation = await Reservation.findOne({ orderId }).lean();
  if (!reservation) reservation = await ensureOrderInventoryReservation(conn, order);
  if (!reservation) {
    throw new InventoryReservationError(
      "Inventory check could not be completed. Preparation is blocked.",
      503,
      "INVENTORY_CHECK_UNAVAILABLE"
    );
  }

  // Mixed-station orders: after the first station starts, the whole order's
  // stock is already consumed. Later stations must be allowed to start without
  // re-reserving or re-consuming; post-consumption line changes are voided,
  // not reconciled back into availability.
  if (hasConsumedStock(reservation)) {
    return reservation;
  }

  // Self-heal if the order changed without a successful reconcile hook. An
  // unresolved requirement is always reconciled so the blocking status is
  // written before the gate below reads it.
  const raw = await calculateRawRequirements(conn, order);
  const validated = await validateRequirements(conn, raw.requirements, { unresolved: raw.unresolved });
  if (validated.unresolved.length > 0) {
    reservation = (await reconcileOrderInventory(conn, order)) || reservation;
  }
  const currentFp = buildRequirementFingerprint(orderId, validated.items);
  if (reservation.requirementFingerprint !== currentFp) {
    reservation = (await reconcileOrderInventory(conn, order)) || reservation;
    if (reservation.requirementFingerprint !== currentFp) {
      throw new InventoryReservationError(
        "Inventory requirements changed. Please retry preparation.",
        409,
        "RESERVATION_CONFLICT"
      );
    }
  }

  if (reservation.status === "INSUFFICIENT_STOCK") {
    const names = (reservation.items || [])
      .filter((it) => Number(it.shortageQuantity) > QTY_EPSILON)
      .map((it) => String(it.inventoryItemId))
      .slice(0, 5);
    throw new InventoryReservationError(
      `Insufficient stock. Preparation is blocked until stock is available${
        names.length ? ` (${names.join(", ")})` : ""
      }`,
      409,
      "INSUFFICIENT_STOCK"
    );
  }
  if (reservation.status === "APPROVAL_REQUIRED") {
    // Legacy pre-policy shortage state: there is no approval path anymore, so
    // the order is treated exactly like a blocking shortage.
    throw new InventoryReservationError(
      "Insufficient stock. Preparation is blocked until stock is available.",
      409,
      "INSUFFICIENT_STOCK"
    );
  }
  if (reservation.status === "RELEASED") {
    throw new InventoryReservationError(
      "Inventory was released for this order. Preparation is blocked.",
      409,
      "RESERVATION_RELEASED"
    );
  }
  if (reservation.status === "CONSUMED") {
    // Stock was already physically deducted for this order — the normal
    // post-preparation state and payable (hasConsumedStock returns true for
    // CONSUMED, so a fresh read returns early above). This branch is reached
    // only when a concurrent payment consumed the reservation between the
    // stale read and the reconcile refresh; the reservation returned by
    // reconcile is adopted as-is. Payment must stay idempotent, so a consumed
    // reservation is ready, never an error.
    return reservation;
  }
  if (!["RESERVED", "APPROVED", "NO_INVENTORY"].includes(reservation.status)) {
    throw new InventoryReservationError(
      "Inventory reservation is not ready. Preparation is blocked.",
      503
    );
  }
  return reservation;
}

// Payment gate. Stock Policy A: an order with a shortage can never be paid,
// even if a legacy/direct path bypassed the preparation gate. A consumed
// reservation (normal PREPARING path) or a fully reserved one is payable.
export async function assertOrderInventoryPayable(conn, order) {
  try {
    return await assertOrderInventoryReady(conn, order);
  } catch (err) {
    if (err instanceof InventoryReservationError && err.code === "INSUFFICIENT_STOCK") {
      throw new InventoryReservationError(
        "Insufficient stock. Payment is blocked until stock is available.",
        409,
        "INSUFFICIENT_STOCK"
      );
    }
    throw err;
  }
}

// True when physical stock has already been decremented for this order. Used by
// cancellation paths to choose between "release the hold" and "record a void".
export async function isOrderInventoryConsumed(conn, orderOrId) {
  const orderId = toOid(orderOrId?._id || orderOrId);
  if (!orderId) return false;
  const Reservation = getInventoryReservationModel(conn);
  const reservation = await Reservation.findOne({ orderId })
    .select("status consumedAt items.consumedQuantity")
    .lean();
  return hasConsumedStock(reservation);
}

// Append an auditable post-preparation void inside an existing transaction.
// Whole-order cancellations additionally reclassify the original SaleDeduction
// movements to Waste so reports stop treating them as sold consumption without
// decrementing stock a second time.
async function appendPostPreparationVoid(conn, current, opts, session) {
  const Reservation = getInventoryReservationModel(conn);
  const StockMovement = getStockMovementModel(conn);
  const source = String(opts.source || "ORDER").toUpperCase();
  const reason = (String(opts.reason || "CANCELLED").trim() || "CANCELLED").slice(0, 200);
  const actorOid = toOid(opts.actorId);
  const lineOid = toOid(opts.lineId);
  const station = opts.station || null;
  const now = new Date();

  const filter = { _id: current._id };
  if (source === "LINE" && lineOid) {
    // One void record per cancelled line; retries are no-ops.
    filter["voids.lineId"] = { $ne: lineOid };
  } else {
    // One whole-order void record; repeated cancel/archive calls are no-ops.
    filter["voids.source"] = { $ne: "ORDER" };
  }

  const voidItems =
    source === "ORDER"
      ? (current.items || [])
          .map((it) => ({
            inventoryItemId: it.inventoryItemId,
            unit: it.unit || "",
            quantity: round3(it.consumedQuantity),
          }))
          .filter((it) => it.quantity > QTY_EPSILON)
      : [];

  const set = {
    voidedAt: current.voidedAt || now,
    voidReason: reason,
    voidedBy: actorOid,
  };
  if (source === "ORDER") set.releaseReason = reason.slice(0, 100);

  const updated = await Reservation.findOneAndUpdate(
    filter,
    {
      $set: set,
      $push: {
        voids: {
          at: now,
          by: actorOid,
          reason,
          phase: "AFTER_PREPARATION",
          source,
          lineId: lineOid,
          station,
          items: voidItems,
        },
      },
    },
    { session, returnDocument: 'after' }
  ).lean();

  if (!updated) {
    const fresh = await Reservation.findOne({ _id: current._id }).session(session).lean();
    return fresh || current;
  }

  if (source === "ORDER") {
    await StockMovement.updateMany(
      { refOrderId: current.orderId, reason: "SaleDeduction" },
      { $set: { reason: "Waste", voidedAt: now, voidReason: reason, voidedBy: actorOid } },
      { session }
    );
  }

  return updated;
}

// Idempotent release for cancellation/archive.
//  * Before preparation: hold is returned (reservedStock decremented).
//  * After preparation: stock is already consumed and is NEVER restored; an
//    auditable void is recorded. Whole-order cancels reclassify the consumed
//    sale movements as Waste.
export async function releaseOrderInventory(
  conn,
  orderOrId,
  {
    reason = "CANCELLED",
    actorId = null,
    source = "ORDER",
    recordVoid = true,
    lineId = null,
    station = null,
  } = {}
) {
  const orderId = toOid(orderOrId?._id || orderOrId);
  if (!orderId) throw new InventoryReservationError("Order id is required", 400);
  const Reservation = getInventoryReservationModel(conn);
  const InventoryItem = getInventoryItemModel(conn);

  return runInTransaction(conn, async (session) => {
    const current = await Reservation.findOne({ orderId }).session(session).lean();
    if (!current) return null;

    const plan = releasePlan(current, { source, recordVoid });
    if (plan.action === "VOID_CONSUMED") {
      if (!plan.recordVoid) return current;
      return appendPostPreparationVoid(
        conn,
        current,
        { reason, actorId, source, lineId, station },
        session
      );
    }

    if (current.status === "RELEASED") return current;

    for (const it of current.items || []) {
      const qty = round3(it.reservedQuantity);
      if (qty <= 0) continue;
      await InventoryItem.updateOne(
        { _id: it.inventoryItemId },
        [
          {
            $set: {
              reservedStock: {
                $max: [
                  0,
                  {
                    $subtract: [
                      { $ifNull: ["$reservedStock", 0] },
                      qty,
                    ],
                  },
                ],
              },
            },
          },
        ],
        { session, updatePipeline: true }
      );
    }

    const now = new Date();
    const updated = await Reservation.findOneAndUpdate(
      { _id: current._id, status: { $nin: ["RELEASED", "CONSUMED"] } },
      {
        $set: {
          status: "RELEASED",
          releasedAt: now,
          releaseReason: String(reason || "CANCELLED").slice(0, 100),
          items: (current.items || []).map((it) => ({
            ...it,
            reservedQuantity: 0,
          })),
        },
      },
      { session, returnDocument: 'after' }
    ).lean();
    return updated || current;
  });
}

// Record a line/whole-order void when stock was consumed after preparation
// began. Safe to call more than once: the reservation void entry is deduplicated
// by order or lineId.
export async function recordPostPreparationVoid(conn, orderOrId, opts = {}) {
  const orderId = toOid(orderOrId?._id || orderOrId);
  if (!orderId) throw new InventoryReservationError("Order id is required", 400);
  const Reservation = getInventoryReservationModel(conn);

  return runInTransaction(conn, async (session) => {
    const current = await Reservation.findOne({ orderId }).session(session).lean();
    if (!current) return null;
    if (!hasConsumedStock(current)) return current;
    return appendPostPreparationVoid(conn, current, opts, session);
  });
}

// Consume physical stock exactly once. Primary trigger is the first successful
// PREPARING transition (ingredients are physically used when preparation
// starts). Payment calls it as an idempotent fallback for legacy/edge orders.
// The order/payment is never rolled back if inventory fails; failures are
// returned for server logging.
export async function consumeOrderInventory(conn, order, { actorId, trigger = "PAYMENT" } = {}) {
  const orderId = orderIdOf(order);
  const Reservation = getInventoryReservationModel(conn);
  let reservation = await Reservation.findOne({ orderId }).lean();
  if (!reservation) {
    // Pre-Phase-1 orders were deducted by the legacy payment hook and have no
    // reservation. A retried payment must never deduct those a second time.
    const StockMovement = getStockMovementModel(conn);
    const legacyDeduction = await StockMovement.exists({
      refOrderId: orderId,
      reason: "SaleDeduction",
    });
    if (legacyDeduction) {
      return {
        success: true,
        skipped: true,
        warnings: ["Legacy sale deduction already recorded for this order"],
      };
    }
    reservation = await ensureOrderInventoryReservation(conn, order);
  }
  if (!reservation) return { success: true, skipped: true, warnings: ["No reservation"] };

  // Stock Policy A: a shortage blocks consumption/payment. The only exception
  // is a legacy APPROVED reservation (historical in-flight orders), which is
  // consumed from physical stock only (never negative).
  if (["INSUFFICIENT_STOCK", "APPROVAL_REQUIRED"].includes(reservation.status)) {
    return {
      success: false,
      blocked: true,
      skipped: false,
      error: "Insufficient stock. Payment is blocked until stock is available.",
      code: "INSUFFICIENT_STOCK",
      status: 409,
      warnings: Array.isArray(reservation.warnings) ? reservation.warnings : [],
    };
  }

  const plan = consumptionPlan(reservation.status);
  if (plan === "ALREADY_CONSUMED") {
    return { success: true, skipped: true, warnings: ["Inventory already consumed"] };
  }
  if (plan === "IN_PROGRESS") {
    return { success: true, skipped: true, warnings: ["Inventory consumption already in progress"] };
  }
  if (plan === "RELEASED") {
    return {
      success: true,
      skipped: true,
      warnings: ["Inventory was released; nothing consumed"],
    };
  }

  const raw = await calculateRawRequirements(conn, order);
  const validated = await validateRequirements(conn, raw.requirements, { unresolved: raw.unresolved });
  // A recipe/unit edited after reservation can leave a required ingredient
  // unresolved. Never consume or accept payment in that state.
  if (validated.unresolved.length > 0) {
    return {
      success: false,
      blocked: true,
      skipped: false,
      error:
        "Inventory requirement cannot be validated (recipe or stock unit). Payment is blocked until it is corrected.",
      code: "INVENTORY_UNRESOLVED",
      status: 409,
      warnings: [...raw.warnings, ...validated.warnings],
    };
  }
  const currentRequired = new Map(
    validated.items.map((it) => [it.inventoryItemId, round3(it.requiredQuantity)])
  );
  const actorOid = toOid(actorId);

  try {
    return await runInTransaction(conn, async (session) => {
      const claimed = await Reservation.findOneAndUpdate(
        {
          _id: reservation._id,
          status: { $in: ["RESERVED", "APPROVED", "NO_INVENTORY"] },
        },
        { $set: { status: "CONSUMING" } },
        { session, returnDocument: 'after' }
      ).lean();
      if (!claimed) {
        const now = await Reservation.findOne({ _id: reservation._id }).session(session).lean();
        if (now?.status === "CONSUMED") {
          return { success: true, skipped: true, warnings: ["Inventory already consumed"] };
        }
        if (now?.status === "RELEASED") {
          return { success: true, skipped: true, warnings: ["Inventory was released"] };
        }
        if (now?.status === "CONSUMING") {
          // A concurrent payment retry owns the claim. Never report failure
          // here: the caller would otherwise release a live consumption.
          return { success: true, skipped: true, warnings: ["Inventory consumption already in progress"] };
        }
        throw new InventoryReservationError("Could not claim reservation for consumption", 409);
      }

      const InventoryItem = getInventoryItemModel(conn);
      const StockMovement = getStockMovementModel(conn);
      const ids = (claimed.items || []).map((it) => it.inventoryItemId);
      const invDocs = ids.length
        ? await InventoryItem.find({ _id: { $in: ids } }).session(session).lean()
        : [];
      const invMap = new Map(invDocs.map((d) => [String(d._id), d]));

      const finalItems = [];
      const movements = [];
      for (const it of claimed.items || []) {
        const invId = String(it.inventoryItemId);
        const inv = invMap.get(invId);
        const reserved = round3(it.reservedQuantity);
        const required = currentRequired.has(invId)
          ? currentRequired.get(invId)
          : Math.max(0, round3(it.requiredQuantity) - round3(it.consumedQuantity));
        const physical = Math.max(0, Number(inv?.currentStock) || 0);
        const held = Math.max(0, Number(inv?.reservedStock) || 0);
        const consumeQty = Math.max(0, Math.min(reserved, required, physical, held));
        const releaseQty = Math.max(0, round3(reserved - consumeQty));

        if (consumeQty > 0) {
          const updated = await InventoryItem.updateOne(
            {
              _id: invId,
              currentStock: { $gte: consumeQty },
              reservedStock: { $gte: consumeQty },
            },
            { $inc: { currentStock: -consumeQty, reservedStock: -consumeQty } },
            { session }
          );
          if ((updated.modifiedCount ?? updated.nModified ?? 0) === 0) {
            throw new InventoryReservationError(
              "Physical stock changed during consumption. Inventory was not fully deducted.",
              409,
              "CONSUMPTION_CONFLICT"
            );
          }
          const unitCost = Number(inv?.cost) || 0;
          movements.push({
            item: new mongoose.Types.ObjectId(invId),
            type: "OUT",
            quantity: consumeQty,
            unit: it.unit,
            unitCost,
            totalCost: Math.round(consumeQty * unitCost * 100) / 100,
            reason: "SaleDeduction",
            refOrderId: orderId,
            notes: `Sale deduction for order ${order.orderNumber || String(orderId)}`,
            ...(actorOid ? { createdBy: actorOid } : {}),
            idempotencyKey: `sale:${String(orderId)}:${invId}`,
          });
        } else if (releaseQty > 0) {
          await InventoryItem.updateOne(
            { _id: invId },
            [
              {
                $set: {
                  reservedStock: {
                    $max: [
                      0,
                      {
                        $subtract: [
                          { $ifNull: ["$reservedStock", 0] },
                          releaseQty,
                        ],
                      },
                    ],
                  },
                },
              },
            ],
            { session, updatePipeline: true }
          );
        }

        finalItems.push({
          inventoryItemId: new mongoose.Types.ObjectId(invId),
          unit: it.unit,
          requiredQuantity: round3(it.requiredQuantity),
          reservedQuantity: 0,
          shortageQuantity: round3(it.shortageQuantity),
          availableAtDecision: round3(it.availableAtDecision),
          consumedQuantity: round3(round3(it.consumedQuantity) + consumeQty),
        });
      }

      if (movements.length > 0) {
        await StockMovement.insertMany(movements, { session });
      }

      const now = new Date();
      const updated = await Reservation.findOneAndUpdate(
        { _id: claimed._id, status: "CONSUMING" },
        {
          $set: {
            status: "CONSUMED",
            items: finalItems,
            consumedAt: now,
            consumedBy: actorOid || null,
            consumedTrigger: String(trigger || "PAYMENT").slice(0, 30),
            decisionAt: now,
          },
        },
        { session, returnDocument: 'after' }
      ).lean();

      if (!updated) {
        throw new InventoryReservationError("Consumption could not be finalized", 409);
      }

      return {
        success: true,
        skipped: false,
        consumed: finalItems.reduce((sum, it) => sum + round3(it.consumedQuantity), 0),
        movements: movements.length,
        warnings: [...raw.warnings, ...validated.warnings],
        reservation: summarize(updated),
      };
    });
  } catch (err) {
    return {
      success: false,
      skipped: false,
      error: err?.message || "Inventory consumption failed",
      code: err?.code || null,
      status: Number.isInteger(err?.status) ? err.status : 409,
      warnings: [...raw.warnings, ...validated.warnings],
    };
  }
}
