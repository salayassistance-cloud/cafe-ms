// BONO Inventory V2 — pure inventory station state machine.
//
// Model A: station start + stock decrement + movement + reservation update +
// Order PREPARING happen in one transaction. CONSUMING is therefore NOT a
// committed happy-path state; it exists only for legacy/corrupt recovery.
//
// KDS preparation state (PENDING/PREPARING/READY) is a separate namespace and
// is never stored inside the inventory state.
//
// Evidence rules
// --------------
//   * PENDING START requires explicit, validated full-hold accounting evidence.
//   * APPROVED START requires validated approval evidence and a strictly
//     positive shortage.
//   * APPROVAL_REQUIRED APPROVE requires validated approval evidence.
//   * PARTIALLY_CONSUMED requires positive consumed quantity and positive
//     approved shortage.
//   * Recovery resolution requires accounting/movement evidence and an explicit
//     resolution reason.
//   * A boolean `approvalValid` is never accepted as approval evidence.

import {
  accountingExact,
  assertShortageConsumptionBinding,
  validateTopUpEpoch,
} from "./accounting.js";
import {
  assertApprovalEvidence,
  assertManagerActionAuthorization,
  MANAGER_ACTION_TYPES,
} from "./approval.js";
import {
  ERROR_CODES,
  fail,
} from "./errors.js";
import {
  assertScaledQuantity,
  scaledQuantitiesEqual,
} from "./quantity.js";
import {
  COMPLETION_REASONS,
  INVENTORY_STATES,
  INVENTORY_STATE_VALUES,
  KDS_STATES,
  KDS_STATE_VALUES,
  TERMINAL_INVENTORY_STATES,
} from "./states.js";

export const INVENTORY_EVENTS = Object.freeze({
  LINE_ADDED: "LINE_ADDED",
  APPROVE: "APPROVE",
  INVALIDATE_APPROVAL: "INVALIDATE_APPROVAL",
  START: "START",
  CANCEL_PRE_START: "CANCEL_PRE_START",
  CANCEL_POST_START: "CANCEL_POST_START",
  ARCHIVE_PRE_START: "ARCHIVE_PRE_START",
  ARCHIVE_PREPARED_UNSOLS: "ARCHIVE_PREPARED_UNSOLS",
  TOP_UP: "TOP_UP",
  RECOVERY: "RECOVERY",
  RESOLVE_RECOVERY: "RESOLVE_RECOVERY",
  RECOVER_CONSUMING: "RECOVER_CONSUMING",
  RETRY_CONSUME: "RETRY_CONSUME",
  PARTIAL_CONSUME: "PARTIAL_CONSUME",
});

export const STATE_EVIDENCE_ERRORS = Object.freeze({
  FULL_HOLD_EVIDENCE_REQUIRED: "FULL_HOLD_EVIDENCE_REQUIRED",
  ACCOUNTING_EVIDENCE_REQUIRED: "ACCOUNTING_EVIDENCE_REQUIRED",
  RECOVERY_EVIDENCE_REQUIRED: "RECOVERY_EVIDENCE_REQUIRED",
  RECOVERY_REASON_REQUIRED: "RECOVERY_REASON_REQUIRED",
});

const EVENT_VALUES = Object.freeze(Object.values(INVENTORY_EVENTS));

const RECOVERY_TARGETS = Object.freeze([
  INVENTORY_STATES.NOT_APPLICABLE,
  INVENTORY_STATES.PENDING,
  INVENTORY_STATES.APPROVAL_REQUIRED,
  INVENTORY_STATES.APPROVED,
  INVENTORY_STATES.CONSUMED,
  INVENTORY_STATES.PARTIALLY_CONSUMED,
  INVENTORY_STATES.RELEASED,
  INVENTORY_STATES.RELEASED_PARTIAL,
]);

const CONSUMING_RECOVERY_TARGETS = Object.freeze([
  INVENTORY_STATES.CONSUMED,
  INVENTORY_STATES.PARTIALLY_CONSUMED,
  INVENTORY_STATES.RECOVERY_REQUIRED,
]);

function normalizeState(value) {
  const state = String(value || "").toUpperCase();
  if (!INVENTORY_STATE_VALUES.includes(state)) {
    fail(ERROR_CODES.UNKNOWN_INVENTORY_STATE, "Unknown inventory state", {
      state: value,
    });
  }
  return state;
}

function normalizeEvent(value) {
  const event = String(value || "").toUpperCase();
  if (!EVENT_VALUES.includes(event)) {
    fail(ERROR_CODES.INVALID_TRANSITION, "Unknown inventory event", {
      event: value,
    });
  }
  return event;
}

function assertNotTerminal(state, event) {
  if (TERMINAL_INVENTORY_STATES.includes(state)) {
    fail(ERROR_CODES.TERMINAL_STATE, "Terminal inventory state", {
      state,
      event,
    });
  }
}

function shortageFrom(context) {
  if (context.shortageQuantity === undefined) return undefined;
  return assertScaledQuantity(context.shortageQuantity, "shortageQuantity");
}

function accountingFromContext(context, { required = false } = {}) {
  if (context.accounting !== undefined) {
    return accountingExact(context.accounting);
  }
  if (
    context.heldQuantity !== undefined &&
    context.requiredQuantity !== undefined
  ) {
    return accountingExact({
      requiredQuantity: context.requiredQuantity,
      heldQuantity: context.heldQuantity,
      consumedQuantity:
        context.consumedQuantity === undefined ? 0 : context.consumedQuantity,
      releasedHoldQuantity:
        context.releasedHoldQuantity === undefined
          ? 0
          : context.releasedHoldQuantity,
      voidedQuantity:
        context.voidedQuantity === undefined ? 0 : context.voidedQuantity,
      shortageQuantity: context.shortageQuantity,
      wasteQuantity:
        context.wasteQuantity === undefined ? 0 : context.wasteQuantity,
    });
  }
  if (required) {
    fail(
      STATE_EVIDENCE_ERRORS.ACCOUNTING_EVIDENCE_REQUIRED,
      "Explicit allocation accounting evidence is required",
      { context }
    );
  }
  return null;
}

function assertPositiveShortage(exact, message) {
  if (exact.shortageQuantity <= 0n) {
    fail(ERROR_CODES.INVALID_CONSUMPTION_QUANTITY, message, {
      shortageQuantity: exact.shortageQuantity.toString(),
    });
  }
}

function assertPendingStartEvidence(context) {
  const exact = accountingFromContext(context, { required: true });
  if (
    exact.requiredQuantity <= 0n ||
    !scaledQuantitiesEqual(exact.heldQuantity, exact.requiredQuantity) ||
    exact.shortageQuantity !== 0n ||
    exact.consumedQuantity !== 0n
  ) {
    fail(
      STATE_EVIDENCE_ERRORS.FULL_HOLD_EVIDENCE_REQUIRED,
      "PENDING start requires the full required quantity to be held with no shortage",
      {
        requiredQuantity: exact.requiredQuantity.toString(),
        heldQuantity: exact.heldQuantity.toString(),
        shortageQuantity: exact.shortageQuantity.toString(),
        consumedQuantity: exact.consumedQuantity.toString(),
      }
    );
  }
  return exact;
}

function assertApprovedStartEvidence(context) {
  const evidence = assertApprovalEvidence(
    context.approvalEvidence,
    context.approvalExpected
  );
  const exact = accountingFromContext(context, { required: true });

  // P1-08: approved-shortage consumption is bound to one exact allocation and
  // its authoritative required quantity.
  assertShortageConsumptionBinding({
    exact,
    evidence,
    expected: context.approvalExpected,
    allocationId:
      context.allocationId ?? context.approvalExpected?.allocationId,
    requiredQuantity:
      context.requiredQuantity ?? context.approvalExpected?.requiredQuantity,
  });

  if (
    exact.requiredQuantity <= 0n ||
    exact.consumedQuantity !== 0n ||
    exact.heldQuantity <= 0n
  ) {
    fail(
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
      "APPROVED start requires a positive hold and no prior consumption",
      {
        requiredQuantity: exact.requiredQuantity.toString(),
        heldQuantity: exact.heldQuantity.toString(),
        consumedQuantity: exact.consumedQuantity.toString(),
      }
    );
  }
  assertPositiveShortage(
    exact,
    "APPROVED start requires a strictly positive shortage"
  );

  // F-03/F-04: the approved shortage must equal the live accounting shortage.
  const expectedShortage = assertScaledQuantity(
    context.approvalExpected?.shortageQuantity,
    "expected.shortageQuantity"
  );
  if (expectedShortage !== exact.shortageQuantity) {
    fail(
      ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH,
      "Accounting shortage does not match the approved shortage",
      {
        shortageQuantity: exact.shortageQuantity.toString(),
        expectedShortage: expectedShortage.toString(),
      }
    );
  }

  return exact;
}

function assertApproveEvidence(context) {
  assertApprovalEvidence(context.approvalEvidence, context.approvalExpected);

  // F-03: approval is not enough. The live allocation must be unconsumed and
  // carry the exact shortage bound by the approval evidence.
  const exact = accountingFromContext(context, { required: true });
  if (exact.consumedQuantity !== 0n || exact.requiredQuantity <= 0n) {
    fail(
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
      "APPROVE requires an unconsumed allocation with a positive requirement",
      {
        requiredQuantity: exact.requiredQuantity.toString(),
        consumedQuantity: exact.consumedQuantity.toString(),
      }
    );
  }
  assertPositiveShortage(
    exact,
    "APPROVE requires a strictly positive shortage"
  );
  const expectedShortage = assertScaledQuantity(
    context.approvalExpected?.shortageQuantity,
    "expected.shortageQuantity"
  );
  if (expectedShortage !== exact.shortageQuantity) {
    fail(
      ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH,
      "Accounting shortage does not match the approved shortage",
      {
        shortageQuantity: exact.shortageQuantity.toString(),
        expectedShortage: expectedShortage.toString(),
      }
    );
  }

  return exact;
}

function assertPartiallyConsumedEvidence(exact) {
  if (exact.consumedQuantity <= 0n || exact.shortageQuantity <= 0n) {
    fail(
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
      "PARTIALLY_CONSUMED requires positive consumption and a positive approved shortage",
      {
        consumedQuantity: exact.consumedQuantity.toString(),
        shortageQuantity: exact.shortageQuantity.toString(),
      }
    );
  }
}

function assertRecoveryTargetSupported(target, exact) {
  const Q = exact.requiredQuantity;
  const H = exact.heldQuantity;
  const C = exact.consumedQuantity;
  const S = exact.shortageQuantity;

  let supported = false;
  switch (target) {
    case INVENTORY_STATES.NOT_APPLICABLE:
      supported = Q === 0n && H === 0n && C === 0n && S === 0n;
      break;
    case INVENTORY_STATES.PENDING:
      supported = Q > 0n && H === Q && C === 0n && S === 0n;
      break;
    case INVENTORY_STATES.APPROVAL_REQUIRED:
      supported = Q > 0n && C === 0n && S > 0n;
      break;
    case INVENTORY_STATES.APPROVED:
      supported = Q > 0n && C === 0n && H > 0n && S > 0n;
      break;
    case INVENTORY_STATES.CONSUMED:
      supported = C > 0n && H === 0n && S === 0n;
      break;
    case INVENTORY_STATES.PARTIALLY_CONSUMED:
      supported = C > 0n && S > 0n;
      break;
    case INVENTORY_STATES.RELEASED:
      supported = C === 0n && H === 0n && S === 0n;
      break;
    case INVENTORY_STATES.RELEASED_PARTIAL:
      supported = C > 0n && H === 0n && S === 0n;
      break;
    case INVENTORY_STATES.RECOVERY_REQUIRED:
      supported = true;
      break;
    default:
      supported = false;
      break;
  }

  if (!supported) {
    fail(
      ERROR_CODES.INVALID_RECOVERY_TARGET,
      "Recovery target is not supported by the supplied accounting evidence",
      {
        targetState: target,
        requiredQuantity: Q.toString(),
        heldQuantity: H.toString(),
        consumedQuantity: C.toString(),
        shortageQuantity: S.toString(),
      }
    );
  }
}

function assertMovementEvidence(context) {
  const evidence = context.movementEvidence;
  if (!evidence || typeof evidence !== "object") {
    fail(
      STATE_EVIDENCE_ERRORS.RECOVERY_EVIDENCE_REQUIRED,
      "CONSUMING recovery requires explicit stock-movement evidence",
      { movementEvidence: evidence }
    );
  }
  if (
    typeof evidence.movementId !== "string" ||
    evidence.movementId.length === 0 ||
    evidence.movementId.trim() !== evidence.movementId
  ) {
    fail(
      STATE_EVIDENCE_ERRORS.RECOVERY_EVIDENCE_REQUIRED,
      "Movement evidence must include a non-empty movementId",
      { movementEvidence: evidence }
    );
  }
  if (evidence.quantity !== undefined) {
    const quantity = assertScaledQuantity(
      evidence.quantity,
      "movementEvidence.quantity"
    );
    if (quantity === 0n) {
      fail(
        STATE_EVIDENCE_ERRORS.RECOVERY_EVIDENCE_REQUIRED,
        "Movement evidence quantity must be strictly positive",
        { movementEvidence: evidence }
      );
    }
  }
  return evidence;
}

function managerActionExpected(context, action, targetState = null) {
  return {
    action,
    orderId: context.orderId,
    station: context.station,
    allocationId: context.allocationId ?? context.previousAllocationId,
    epoch: context.currentEpoch ?? context.epoch,
    currentActorId: context.currentActorId,
    revision: context.revision,
    targetState,
    now: context.now,
  };
}

function requireManagerAction(
  context,
  action,
  targetState,
  unauthorizedCode,
  message
) {
  if (
    !context.managerAuthorization ||
    typeof context.managerAuthorization !== "object"
  ) {
    fail(unauthorizedCode, message);
  }
  try {
    return assertManagerActionAuthorization(
      context.managerAuthorization,
      managerActionExpected(context, action, targetState)
    );
  } catch (error) {
    fail(unauthorizedCode, message, { cause: error.code });
  }
}

function resolveRecovery(context, allowedTargets, { requireMovement = false } = {}) {
  const target = String(context.targetState || "").toUpperCase();
  if (!allowedTargets.includes(target)) {
    fail(ERROR_CODES.INVALID_RECOVERY_TARGET, "Invalid recovery target", {
      targetState: target,
      allowed: allowedTargets,
    });
  }

  // F-12: recovery requires validated, scoped, time-bounded Manager evidence.
  // A caller boolean is never accepted.
  requireManagerAction(
    context,
    MANAGER_ACTION_TYPES.RECOVERY_RESOLUTION,
    target,
    ERROR_CODES.RECOVERY_RESOLUTION_UNAUTHORIZED,
    "Recovery resolution requires validated Manager-authorization evidence"
  );

  if (
    typeof context.recoveryReason !== "string" ||
    context.recoveryReason.length === 0 ||
    context.recoveryReason.trim() !== context.recoveryReason
  ) {
    fail(
      STATE_EVIDENCE_ERRORS.RECOVERY_REASON_REQUIRED,
      "Recovery resolution requires an explicit non-empty reason"
    );
  }

  const exact = accountingFromContext(context, { required: true });

  if (requireMovement) {
    assertMovementEvidence(context);
  }

  assertRecoveryTargetSupported(target, exact);
  return target;
}

/**
 * Pure transition function. Returns the next inventory state or throws a stable
 * domain error. No persistence, no side effects.
 */
export function nextInventoryState(fromInput, eventInput, context = {}) {
  const from = normalizeState(fromInput);
  const event = normalizeEvent(eventInput);

  // Arbitrary partial consumption is not a first-release capability at all.
  if (event === INVENTORY_EVENTS.PARTIAL_CONSUME) {
    fail(
      ERROR_CODES.PARTIAL_CONSUMPTION_DISABLED,
      "Arbitrary partial consumption is disabled in the first release"
    );
  }

  assertNotTerminal(from, event);

  if (from === INVENTORY_STATES.RECOVERY_REQUIRED) {
    if (event !== INVENTORY_EVENTS.RESOLVE_RECOVERY) {
      fail(
        ERROR_CODES.RECOVERY_RESOLUTION_REQUIRED,
        "RECOVERY_REQUIRED can only change through explicit recovery resolution",
        { from, event }
      );
    }
    return resolveRecovery(context, RECOVERY_TARGETS);
  }

  if (from === INVENTORY_STATES.CONSUMING) {
    if (
      event !== INVENTORY_EVENTS.RESOLVE_RECOVERY &&
      event !== INVENTORY_EVENTS.RECOVER_CONSUMING
    ) {
      fail(
        ERROR_CODES.INVALID_TRANSITION,
        "CONSUMING is recovery-only; no normal happy-path transition is allowed",
        { from, event }
      );
    }
    return resolveRecovery(context, CONSUMING_RECOVERY_TARGETS, {
      requireMovement: true,
    });
  }

  switch (from) {
    case INVENTORY_STATES.NOT_APPLICABLE:
      if (event === INVENTORY_EVENTS.LINE_ADDED) {
        const shortage = shortageFrom(context);
        if (shortage === undefined) {
          fail(
            STATE_EVIDENCE_ERRORS.ACCOUNTING_EVIDENCE_REQUIRED,
            "LINE_ADDED requires an explicit shortageQuantity",
            { context }
          );
        }
        return shortage > 0n
          ? INVENTORY_STATES.APPROVAL_REQUIRED
          : INVENTORY_STATES.PENDING;
      }
      if (event === INVENTORY_EVENTS.RECOVERY) {
        return INVENTORY_STATES.RECOVERY_REQUIRED;
      }
      break;

    case INVENTORY_STATES.PENDING:
      if (event === INVENTORY_EVENTS.START) {
        assertPendingStartEvidence(context);
        return INVENTORY_STATES.CONSUMED;
      }
      if (
        event === INVENTORY_EVENTS.CANCEL_PRE_START ||
        event === INVENTORY_EVENTS.ARCHIVE_PRE_START
      ) {
        return INVENTORY_STATES.RELEASED;
      }
      if (event === INVENTORY_EVENTS.RECOVERY) {
        return INVENTORY_STATES.RECOVERY_REQUIRED;
      }
      break;

    case INVENTORY_STATES.APPROVAL_REQUIRED:
      if (event === INVENTORY_EVENTS.APPROVE) {
        assertApproveEvidence(context);
        return INVENTORY_STATES.APPROVED;
      }
      if (
        event === INVENTORY_EVENTS.CANCEL_PRE_START ||
        event === INVENTORY_EVENTS.ARCHIVE_PRE_START
      ) {
        return INVENTORY_STATES.RELEASED;
      }
      if (event === INVENTORY_EVENTS.RECOVERY) {
        return INVENTORY_STATES.RECOVERY_REQUIRED;
      }
      break;

    case INVENTORY_STATES.APPROVED:
      if (event === INVENTORY_EVENTS.START) {
        const exact = assertApprovedStartEvidence(context);
        assertPartiallyConsumedEvidence({
          ...exact,
          heldQuantity: 0n,
          consumedQuantity: exact.consumedQuantity + exact.heldQuantity,
        });
        return INVENTORY_STATES.PARTIALLY_CONSUMED;
      }
      if (event === INVENTORY_EVENTS.INVALIDATE_APPROVAL) {
        return INVENTORY_STATES.APPROVAL_REQUIRED;
      }
      if (
        event === INVENTORY_EVENTS.CANCEL_PRE_START ||
        event === INVENTORY_EVENTS.ARCHIVE_PRE_START
      ) {
        return INVENTORY_STATES.RELEASED;
      }
      if (event === INVENTORY_EVENTS.RECOVERY) {
        return INVENTORY_STATES.RECOVERY_REQUIRED;
      }
      break;

    case INVENTORY_STATES.CONSUMED:
      if (event === INVENTORY_EVENTS.RETRY_CONSUME) {
        if (context.accounting !== undefined) {
          const exact = accountingExact(context.accounting);
          if (exact.consumedQuantity <= 0n || exact.shortageQuantity !== 0n) {
            fail(
              ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
              "RETRY_CONSUME requires positive consumption and no shortage",
              {
                consumedQuantity: exact.consumedQuantity.toString(),
                shortageQuantity: exact.shortageQuantity.toString(),
              }
            );
          }
        }
        return INVENTORY_STATES.CONSUMED;
      }
      if (event === INVENTORY_EVENTS.START) {
        fail(
          ERROR_CODES.ALREADY_CONSUMED,
          "A consumed allocation cannot be consumed again"
        );
      }
      if (event === INVENTORY_EVENTS.TOP_UP) {
        fail(
          ERROR_CODES.TOP_UP_FORBIDDEN,
          "A fully consumed allocation cannot be reopened through top-up"
        );
      }
      if (
        event === INVENTORY_EVENTS.CANCEL_POST_START ||
        event === INVENTORY_EVENTS.ARCHIVE_PREPARED_UNSOLS
      ) {
        return INVENTORY_STATES.RELEASED_PARTIAL;
      }
      if (event === INVENTORY_EVENTS.RECOVERY) {
        return INVENTORY_STATES.RECOVERY_REQUIRED;
      }
      break;

    case INVENTORY_STATES.PARTIALLY_CONSUMED:
      if (event === INVENTORY_EVENTS.TOP_UP) {
        // F-12: validated Manager evidence, never a caller boolean.
        requireManagerAction(
          context,
          MANAGER_ACTION_TYPES.TOP_UP,
          null,
          ERROR_CODES.TOP_UP_NOT_AUTHORIZED,
          "Top-up requires validated Manager-authorization evidence"
        );
        if (context.accounting !== undefined) {
          const exact = accountingExact(context.accounting);
          assertPartiallyConsumedEvidence(exact);
        }
        const topUp = validateTopUpEpoch({
          state: from,
          currentEpoch: context.currentEpoch,
          allocationKey: context.allocationKey,
          previousAllocationId: context.previousAllocationId,
          nextEpoch: context.newEpoch,
          newShortageQuantity:
            context.newShortageQuantity === undefined
              ? 0
              : context.newShortageQuantity,
        });
        return topUp.requiresFreshApproval
          ? INVENTORY_STATES.APPROVAL_REQUIRED
          : INVENTORY_STATES.PENDING;
      }
      if (event === INVENTORY_EVENTS.START) {
        fail(
          ERROR_CODES.ALREADY_CONSUMED,
          "A partially consumed allocation cannot be consumed again"
        );
      }
      if (
        event === INVENTORY_EVENTS.CANCEL_POST_START ||
        event === INVENTORY_EVENTS.ARCHIVE_PREPARED_UNSOLS
      ) {
        return INVENTORY_STATES.RELEASED_PARTIAL;
      }
      if (event === INVENTORY_EVENTS.RECOVERY) {
        return INVENTORY_STATES.RECOVERY_REQUIRED;
      }
      break;

    default:
      break;
  }

  fail(ERROR_CODES.INVALID_TRANSITION, "Illegal inventory state transition", {
    from,
    event,
  });
}

export function canTransitionInventory(from, event, context = {}) {
  try {
    nextInventoryState(from, event, context);
    return true;
  } catch {
    return false;
  }
}

/**
 * KDS READY is only legal when inventory is already terminal, or when an
 * approved shortage is the explicit completion reason with positive
 * consumption and positive approved shortage evidence.
 *
 * F-11: a status string alone is never enough. Terminal accounting must be
 * supplied, must balance, and must carry no residual hold or released hold.
 */
export function assertKdsReadyAllowed({
  inventoryState,
  completionReason,
  accounting,
} = {}) {
  const state = normalizeState(inventoryState);

  if (state === INVENTORY_STATES.CONSUMING) {
    fail(
      ERROR_CODES.KDS_READY_REQUIRES_TERMINAL_INVENTORY,
      "KDS READY is forbidden while inventory is CONSUMING",
      { inventoryState: state }
    );
  }
  if (state === INVENTORY_STATES.RECOVERY_REQUIRED) {
    fail(
      ERROR_CODES.KDS_READY_REQUIRES_TERMINAL_INVENTORY,
      "KDS READY is forbidden while inventory needs recovery",
      { inventoryState: state }
    );
  }
  if (state === INVENTORY_STATES.PARTIALLY_CONSUMED) {
    if (completionReason !== COMPLETION_REASONS.APPROVED_SHORTAGE) {
      fail(
        ERROR_CODES.PARTIAL_CONSUMPTION_UNAUTHORIZED,
        "PARTIALLY_CONSUMED must mean APPROVED_SHORTAGE in the first release",
        { inventoryState: state, completionReason }
      );
    }
    if (accounting === undefined) {
      fail(
        STATE_EVIDENCE_ERRORS.ACCOUNTING_EVIDENCE_REQUIRED,
        "PARTIALLY_CONSUMED requires positive consumption and approved-shortage evidence",
        { inventoryState: state }
      );
    }
    const exact = accountingExact(accounting);
    assertPartiallyConsumedEvidence(exact);
    if (exact.heldQuantity !== 0n || exact.releasedHoldQuantity !== 0n) {
      fail(
        ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
        "PARTIALLY_CONSUMED cannot carry a residual hold or released hold",
        {
          heldQuantity: exact.heldQuantity.toString(),
          releasedHoldQuantity: exact.releasedHoldQuantity.toString(),
        }
      );
    }
    return true;
  }
  if (state === INVENTORY_STATES.CONSUMED) {
    if (accounting === undefined) {
      fail(
        STATE_EVIDENCE_ERRORS.ACCOUNTING_EVIDENCE_REQUIRED,
        "CONSUMED requires explicit terminal accounting evidence",
        { inventoryState: state }
      );
    }
    const exact = accountingExact(accounting);
    if (exact.consumedQuantity <= 0n || exact.shortageQuantity !== 0n) {
      fail(
        ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
        "CONSUMED evidence contradicts full consumption",
        {
          consumedQuantity: exact.consumedQuantity.toString(),
          shortageQuantity: exact.shortageQuantity.toString(),
        }
      );
    }
    if (exact.heldQuantity !== 0n || exact.releasedHoldQuantity !== 0n) {
      fail(
        ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
        "CONSUMED cannot carry a residual hold or released hold",
        {
          heldQuantity: exact.heldQuantity.toString(),
          releasedHoldQuantity: exact.releasedHoldQuantity.toString(),
        }
      );
    }
    if (
      completionReason !== undefined &&
      completionReason !== COMPLETION_REASONS.FULL
    ) {
      fail(
        ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
        "CONSUMED completion reason contradicts full consumption",
        { inventoryState: state, completionReason }
      );
    }
    return true;
  }
  fail(
    ERROR_CODES.KDS_READY_REQUIRES_TERMINAL_INVENTORY,
    "KDS READY requires a terminal inventory state",
    { inventoryState: state }
  );
}

export function normalizeKdsState(value) {
  const state = String(value || "").toUpperCase();
  if (!KDS_STATE_VALUES.includes(state)) {
    fail(ERROR_CODES.INVALID_KDS_STATE, "Unknown KDS state", { state: value });
  }
  return state;
}

/** Released stations have no active KDS ticket, regardless of a stale field. */
export function hasActiveKdsTicket({ inventoryState, kdsStatus } = {}) {
  const state = normalizeState(inventoryState);
  if (TERMINAL_INVENTORY_STATES.includes(state)) return false;
  const kds = normalizeKdsState(kdsStatus);
  return (
    kds === KDS_STATES.PENDING ||
    kds === KDS_STATES.PREPARING ||
    kds === KDS_STATES.READY
  );
}
