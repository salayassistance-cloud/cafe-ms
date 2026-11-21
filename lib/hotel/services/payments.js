// Hotel-only payment service.
//
// Phase 4C records payments only after a Stay has been checked out and its
// room-charge snapshot is final. The folio service is the sole source of
// balances; this service never trusts a client-supplied total.
//
// Concurrency:
// - The existing per-room lock serializes payment creation and voiding for one
//   Stay, so two different idempotency keys cannot both pass the overpayment
//   check.
// - `stayId + idempotencyKey` is unique in the model. Until that index is
//   deployed, the lock is the application-level backstop.
// - Same key + identical details replays the persisted result. Same key +
//   different details returns 409 and never creates a second payment.
//
// Voiding is a conditional, non-destructive status transition. There is no
// amount or method edit path.

import crypto from "crypto";

import {
  HOTEL_PAYMENT_CURRENCY,
  HOTEL_PAYMENT_OVERPAYMENT_POLICY,
} from "../constants.js";
import {
  hashAuditValue,
  HOTEL_AUDIT_ACTIONS,
  safeRecordHotelAudit,
} from "../audit.js";
import { formatHotelLocalDate } from "../dates.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
} from "../errors.js";
import {
  getHotelPaymentModel,
  paymentMinorUnits,
  toSafeHotelPayment,
} from "../models/hotelPayment.js";
import { getStayModel } from "../models/stay.js";
import { fromHotelMinorUnits } from "../money.js";
import {
  validateHotelPaymentPayload,
  validateHotelPaymentVoidPayload,
  validateObjectIdString,
} from "../validation.js";
import { withHotelRoomBookingLocks } from "./bookingLocks.js";
import {
  buildHotelFolio,
  getHotelFolio,
  toHotelFolioSummary,
} from "./folio.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

function notFound(message = "Stay not found") {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.NOT_FOUND,
    message,
    status: 404,
    expose: true,
  });
}

function conflict(message, field = null) {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.CONFLICT,
    message,
    status: 409,
    expose: true,
    details: field ? { field } : null,
  });
}

function authenticationRequired() {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.AUTHENTICATION_REQUIRED,
    message: "Hotel authentication is required",
    status: 401,
    expose: true,
  });
}

function paymentRecordsUnavailable() {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.DATABASE_UNAVAILABLE,
    message: "Hotel payment records are temporarily unavailable",
    status: 503,
    expose: true,
  });
}

function overpaymentError(folio) {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.CONFLICT,
    message: "Payment exceeds the outstanding balance",
    status: 409,
    expose: true,
    details: {
      field: "amount",
      currency: folio.currency,
      outstandingBalance: folio.outstandingBalance,
      outstandingBalanceMinor: folio.outstandingBalanceMinor,
    },
  });
}

function idString(value) {
  const id = value?._id ?? value;
  return id ? String(id) : null;
}

function requireActorId(actor) {
  const id = actor?.id ?? actor?._id ?? actor;
  const value = id ? String(id) : "";
  if (!value || !OBJECT_ID_RE.test(value)) {
    throw authenticationRequired();
  }
  return value;
}

function paymentNumberFor(now) {
  const datePart = formatHotelLocalDate(new Date(now)).replaceAll("-", "");
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `PAY-${datePart}-${suffix}`;
}

function paymentRequestHash({
  stayId,
  amountMinor,
  method,
  currency = HOTEL_PAYMENT_CURRENCY,
}) {
  const canonical = JSON.stringify({
    stayId: String(stayId),
    amountMinor,
    method,
    currency,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function audit(connection, event) {
  await safeRecordHotelAudit(connection, event);
}

async function auditRejected({
  connection,
  actor,
  request,
  stay = null,
  payment = null,
  reason,
  metadata = {},
}) {
  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.PAYMENT_REJECTED,
    outcome: "FAILURE",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: payment ? "HotelPayment" : "Stay",
    entityId: idString(payment ?? stay),
    metadata: {
      reason,
      stayId: idString(stay),
      paymentId: idString(payment),
      ...metadata,
    },
    request,
  });
}

async function findStay(connection, id) {
  const normalizedId = validateObjectIdString(id, "id");
  const Stay = getStayModel(connection);
  const stay = await Stay.findById(normalizedId).lean();
  if (!stay) throw notFound();
  return stay;
}

async function findPayment(connection, id) {
  const normalizedId = validateObjectIdString(id, "id");
  const Payment = getHotelPaymentModel(connection);
  const payment = await Payment.findById(normalizedId).lean();
  if (!payment) throw notFound("Payment not found");
  return payment;
}

function existingMatches(existing, requestHash) {
  if (
    typeof existing?.requestHash === "string" &&
    existing.requestHash.length > 0
  ) {
    return existing.requestHash === requestHash;
  }

  const amountMinor = paymentMinorUnits(existing);
  if (amountMinor == null) return false;
  return (
    paymentRequestHash({
      stayId: existing.stayId,
      amountMinor,
      method: existing.method,
      currency: existing.currency ?? HOTEL_PAYMENT_CURRENCY,
    }) === requestHash
  );
}

async function replayExistingPayment({
  connection,
  existing,
  stay,
  requestHash,
  actor,
  request,
}) {
  if (!existingMatches(existing, requestHash)) {
    await auditRejected({
      connection,
      actor,
      request,
      stay,
      payment: existing,
      reason: "IDEMPOTENCY_KEY_CONFLICT",
      metadata: {
        idempotencyKeyHash: hashAuditValue(existing.idempotencyKey),
      },
    });
    throw conflict(
      "Idempotency key was already used with different payment details",
      "idempotencyKey"
    );
  }

  const folio = await buildHotelFolio({ connection, stay });
  await audit(connection, {
    action: HOTEL_AUDIT_ACTIONS.PAYMENT_REPLAYED,
    outcome: "SUCCESS",
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    entityType: "HotelPayment",
    entityId: idString(existing),
    metadata: {
      paymentId: idString(existing),
      paymentNumber: existing.paymentNumber ?? null,
      stayId: idString(stay),
      amountMinor: paymentMinorUnits(existing),
      method: existing.method ?? null,
      status: existing.status ?? null,
      replayed: true,
      idempotencyKeyHash: hashAuditValue(existing.idempotencyKey),
    },
    request,
  });

  return {
    payment: toSafeHotelPayment(existing),
    folio,
    created: false,
    replayed: true,
    changed: false,
  };
}

async function withPaymentLock({ connection, stay, now, fn }) {
  if (!stay?.roomId) {
    throw conflict("Stay has no room; payment cannot be processed", "roomId");
  }
  return withHotelRoomBookingLocks({
    connection,
    roomIds: [stay.roomId],
    now,
    busyMessage: "Payment is being processed; retry shortly",
    busyField: "stayId",
    fn,
  });
}

async function createPaymentWithUniqueNumber({
  Payment,
  doc,
  stayId,
  idempotencyKey,
  now,
}) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const created = await Payment.create({
        ...doc,
        paymentNumber: paymentNumberFor(now),
      });
      return { created, duplicate: null };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      lastError = error;
      const duplicate = await Payment.findOne({
        stayId,
        idempotencyKey,
      }).lean();
      if (duplicate) return { created: null, duplicate };
    }
  }

  throw new HotelApiError({
    code: HOTEL_ERROR_CODES.CONFLICT,
    message: "Could not allocate a unique payment number; retry",
    status: 409,
    expose: true,
    details: { field: "paymentNumber" },
    cause: lastError,
  });
}

export async function recordStayPayment({
  connection,
  stayId,
  input = {},
  actor = null,
  request = null,
  now = Date.now(),
} = {}) {
  const validated = validateHotelPaymentPayload(input ?? {});
  const normalizedStayId = validateObjectIdString(stayId, "id");
  const actorUserId = requireActorId(actor);
  const Payment = getHotelPaymentModel(connection);
  const initialStay = await findStay(connection, normalizedStayId);
  const requestHash = paymentRequestHash({
    stayId: normalizedStayId,
    amountMinor: validated.amountMinor,
    method: validated.method,
    currency: HOTEL_PAYMENT_CURRENCY,
  });

  return withPaymentLock({
    connection,
    stay: initialStay,
    now,
    fn: async () => {
      const stay = await findStay(connection, normalizedStayId);

      const existing = await Payment.findOne({
        stayId: stay._id,
        idempotencyKey: validated.idempotencyKey,
      }).lean();
      if (existing) {
        return replayExistingPayment({
          connection,
          existing,
          stay,
          requestHash,
          actor,
          request,
        });
      }

      if (stay.status !== "CHECKED_OUT") {
        await auditRejected({
          connection,
          actor,
          request,
          stay,
          reason: "STAY_NOT_CHECKED_OUT",
          metadata: {
            status: stay.status ?? null,
            amountMinor: validated.amountMinor,
            method: validated.method,
          },
        });
        throw conflict(
          "Payments can only be recorded after check-out",
          "stayId"
        );
      }

      const folio = await buildHotelFolio({ connection, stay });
      if (!folio.available) {
        throw paymentRecordsUnavailable();
      }
      if (!folio.finalized) {
        await auditRejected({
          connection,
          actor,
          request,
          stay,
          reason: "FOLIO_NOT_FINALIZED",
          metadata: {
            status: stay.status ?? null,
            chargeRule: stay.chargeRule ?? null,
            billableNights: stay.billableNights ?? null,
            totalCharges: stay.totalCharges ?? null,
          },
        });
        throw conflict(
          "Stay charges are not finalized; payment cannot be recorded",
          "totalCharges"
        );
      }
      if (folio.outstandingBalanceMinor == null) {
        await auditRejected({
          connection,
          actor,
          request,
          stay,
          reason: "OUTSTANDING_BALANCE_UNAVAILABLE",
        });
        throw conflict(
          "Stay balance is unavailable; payment cannot be recorded",
          "totalCharges"
        );
      }
      if (validated.amountMinor > folio.outstandingBalanceMinor) {
        await auditRejected({
          connection,
          actor,
          request,
          stay,
          reason: "OVERPAYMENT",
          metadata: {
            amountMinor: validated.amountMinor,
            outstandingBalanceMinor: folio.outstandingBalanceMinor,
            totalChargesMinor: folio.totalChargesMinor,
            totalPaidMinor: folio.totalPaidMinor,
            overpaymentPolicy: HOTEL_PAYMENT_OVERPAYMENT_POLICY,
          },
        });
        throw overpaymentError(folio);
      }

      const { created, duplicate } = await createPaymentWithUniqueNumber({
        Payment,
        stayId: stay._id,
        idempotencyKey: validated.idempotencyKey,
        now,
        doc: {
          stayId: stay._id,
          reservationId: stay.reservationId,
          guestId: stay.guestId,
          amountMinor: validated.amountMinor,
          currency: HOTEL_PAYMENT_CURRENCY,
          method: validated.method,
          status: "RECORDED",
          idempotencyKey: validated.idempotencyKey,
          requestHash,
          actorUserId,
          recordedAt: new Date(now),
        },
      });

      if (duplicate) {
        return replayExistingPayment({
          connection,
          existing: duplicate,
          stay,
          requestHash,
          actor,
          request,
        });
      }

      const updatedFolio = await buildHotelFolio({ connection, stay });
      await audit(connection, {
        action: HOTEL_AUDIT_ACTIONS.PAYMENT_RECORDED,
        outcome: "SUCCESS",
        actorUserId,
        actorRole: actor?.role ?? null,
        entityType: "HotelPayment",
        entityId: idString(created),
        metadata: {
          paymentId: idString(created),
          paymentNumber: created.paymentNumber ?? null,
          stayId: idString(stay),
          reservationId: idString(stay.reservationId),
          guestId: idString(stay.guestId),
          amountMinor: validated.amountMinor,
          amount: fromHotelMinorUnits(validated.amountMinor),
          currency: HOTEL_PAYMENT_CURRENCY,
          method: validated.method,
          status: "RECORDED",
          idempotencyKeyHash: hashAuditValue(validated.idempotencyKey),
          totalChargesMinor: updatedFolio.totalChargesMinor,
          totalPaidMinor: updatedFolio.totalPaidMinor,
          outstandingBalanceMinor: updatedFolio.outstandingBalanceMinor,
          settlementStatus: updatedFolio.settlementStatus,
        },
        request,
      });

      return {
        payment: toSafeHotelPayment(created),
        folio: updatedFolio,
        created: true,
        replayed: false,
        changed: true,
      };
    },
  });
}

export async function voidHotelPayment({
  connection,
  paymentId,
  input = {},
  actor = null,
  request = null,
  now = Date.now(),
} = {}) {
  const validated = validateHotelPaymentVoidPayload(input ?? {});
  const normalizedPaymentId = validateObjectIdString(paymentId, "id");
  const actorUserId = requireActorId(actor);
  const Payment = getHotelPaymentModel(connection);
  const initialPayment = await findPayment(connection, normalizedPaymentId);
  const initialStay = await findStay(connection, initialPayment.stayId);

  return withPaymentLock({
    connection,
    stay: initialStay,
    now,
    fn: async () => {
      const stay = await findStay(connection, initialPayment.stayId);
      const payment = await findPayment(connection, normalizedPaymentId);

      if (payment.status === "VOIDED") {
        const folio = await buildHotelFolio({ connection, stay });
        await audit(connection, {
          action: HOTEL_AUDIT_ACTIONS.PAYMENT_VOID_REPLAYED,
          outcome: "SUCCESS",
          actorUserId,
          actorRole: actor?.role ?? null,
          entityType: "HotelPayment",
          entityId: idString(payment),
          metadata: {
            paymentId: idString(payment),
            paymentNumber: payment.paymentNumber ?? null,
            stayId: idString(stay),
            amountMinor: paymentMinorUnits(payment),
            method: payment.method ?? null,
            status: "VOIDED",
            replayed: true,
          },
          request,
        });
        return {
          payment: toSafeHotelPayment(payment),
          folio,
          changed: false,
          replayed: true,
        };
      }

      if (payment.status !== "RECORDED") {
        throw conflict(
          "Payment cannot be voided in its current state",
          "status"
        );
      }

      const voidedAt = new Date(now);
      const result = await Payment.updateOne(
        { _id: payment._id, status: "RECORDED" },
        {
          $set: {
            status: "VOIDED",
            voidedAt,
            voidedBy: actorUserId,
            voidReason: validated.reason,
          },
        },
        { runValidators: true }
      );

      if (!result?.modifiedCount) {
        const current = await findPayment(connection, normalizedPaymentId);
        if (current.status === "VOIDED") {
          const folio = await buildHotelFolio({ connection, stay });
          await audit(connection, {
            action: HOTEL_AUDIT_ACTIONS.PAYMENT_VOID_REPLAYED,
            outcome: "SUCCESS",
            actorUserId,
            actorRole: actor?.role ?? null,
            entityType: "HotelPayment",
            entityId: idString(current),
            metadata: {
              paymentId: idString(current),
              paymentNumber: current.paymentNumber ?? null,
              stayId: idString(stay),
              amountMinor: paymentMinorUnits(current),
              method: current.method ?? null,
              status: "VOIDED",
              replayed: true,
            },
            request,
          });
          return {
            payment: toSafeHotelPayment(current),
            folio,
            changed: false,
            replayed: true,
          };
        }
        throw conflict(
          "Payment status changed during void; reload and retry",
          "status"
        );
      }

      const updated = await findPayment(connection, normalizedPaymentId);
      const folio = await buildHotelFolio({ connection, stay });
      await audit(connection, {
        action: HOTEL_AUDIT_ACTIONS.PAYMENT_VOIDED,
        outcome: "SUCCESS",
        actorUserId,
        actorRole: actor?.role ?? null,
        entityType: "HotelPayment",
        entityId: idString(updated),
        metadata: {
          paymentId: idString(updated),
          paymentNumber: updated.paymentNumber ?? null,
          stayId: idString(stay),
          reservationId: idString(stay.reservationId),
          guestId: idString(stay.guestId),
          amountMinor: paymentMinorUnits(updated),
          method: updated.method ?? null,
          previousStatus: "RECORDED",
          status: "VOIDED",
          reason: validated.reason,
          voidedAt: updated.voidedAt,
          totalChargesMinor: folio.totalChargesMinor,
          totalPaidMinor: folio.totalPaidMinor,
          outstandingBalanceMinor: folio.outstandingBalanceMinor,
          settlementStatus: folio.settlementStatus,
        },
        request,
      });

      return {
        payment: toSafeHotelPayment(updated),
        folio,
        changed: true,
        replayed: false,
      };
    },
  });
}

export async function getStayFolio({ connection, stayId } = {}) {
  const stay = await findStay(connection, stayId);
  const folio = await buildHotelFolio({ connection, stay });
  return { folio };
}

export async function getHotelPayment({ connection, id } = {}) {
  const payment = await findPayment(connection, id);
  let folio = null;

  try {
    folio = await getHotelFolio({
      connection,
      stayId: payment.stayId,
    });
  } catch (error) {
    if (error?.status !== 404) throw error;
  }

  return {
    payment: toSafeHotelPayment(payment),
    folio: toHotelFolioSummary(folio),
  };
}
