// BONO Inventory V2 — reusable MongoDB transaction foundation.
//
// This helper is deliberately NOT wired into any V1 service in Phase 2.0. It
// generalises the correctness requirements already proven piecemeal by the V1
// reservation/receipt/waste services:
//
//   * a bounded retry loop for TransientTransactionError;
//   * no blind retry for UnknownTransactionCommitResult;
//   * an explicit caller-owned `resolveOutcome(actionIdentity, context)` port
//     that re-reads the authoritative record using the SAME action identity;
//   * deterministic business errors are rethrown immediately;
//   * unsupported transaction topology maps to TRANSACTIONS_UNAVAILABLE (503);
//   * session cleanup in `finally` on every path;
//   * the action identity and fingerprint never change between retries.
//
// Unknown commit contract
// -----------------------
// `resolveOutcome(actionIdentity, { fingerprint, attempt, error })` must return:
//
//   { status: "CONFIRMED_SUCCESS", actionIdentity, fingerprint, result }
//       The authoritative record exists and matches BOTH the exact action
//       identity and fingerprint. Its stored result is replayed.
//
//   { status: "CONFIRMED_ABSENT" }
//       The authoritative record is definitively absent. Retrying the SAME
//       action (never a new identity) is safe.
//
//   { status: "CONFLICT", details? }
//       The identity exists with a different fingerprint/payload.
//
//   { status: "UNRESOLVED", details? }
//       The outcome cannot be established. Fail closed; never retry.
//
// A CONFIRMED_SUCCESS whose stored actionIdentity/fingerprint does not match the
// caller's exact values is treated as a conflict, not as a replay.

import { assertServerOnly } from "./boundary.js";

assertServerOnly("Inventory V2 transaction helper");

export const TRANSACTION_ERROR_CODES = Object.freeze({
  INVALID_OPTIONS: "TRANSACTION_INVALID_OPTIONS",
  ACTION_IDENTITY_REQUIRED: "TRANSACTION_ACTION_IDENTITY_REQUIRED",
  TRANSACTIONS_UNAVAILABLE: "TRANSACTIONS_UNAVAILABLE",
  RETRIES_EXHAUSTED: "TRANSACTION_RETRIES_EXHAUSTED",
  OUTCOME_UNRESOLVED: "TRANSACTION_OUTCOME_UNRESOLVED",
  ACTION_IDENTITY_CONFLICT: "TRANSACTION_ACTION_IDENTITY_CONFLICT",
});

export const UNKNOWN_COMMIT_RESOLUTIONS = Object.freeze({
  CONFIRMED_SUCCESS: "CONFIRMED_SUCCESS",
  CONFIRMED_ABSENT: "CONFIRMED_ABSENT",
  CONFLICT: "CONFLICT",
  UNRESOLVED: "UNRESOLVED",
});

export class InventoryV2TransactionError extends Error {
  constructor(code, message, details = {}, { status = 500, cause } = {}) {
    super(message || code);
    this.name = "InventoryV2TransactionError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.status = status;
    this.retryable = false;
    if (cause !== undefined) this.cause = cause;
  }
}

function transactionError(code, message, details, options) {
  return new InventoryV2TransactionError(code, message, details, options);
}

function isNonEmptyTrimmedString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function hasErrorLabel(error, label) {
  if (!error) return false;
  if (
    typeof error.hasErrorLabel === "function" &&
    error.hasErrorLabel(label) === true
  ) {
    return true;
  }
  if (Array.isArray(error.errorLabels) && error.errorLabels.includes(label)) {
    return true;
  }
  if (
    Array.isArray(error.errInfo?.errorLabels) &&
    error.errInfo.errorLabels.includes(label)
  ) {
    return true;
  }
  return false;
}

export function isTransientTransactionError(error) {
  if (!error) return false;
  if (hasErrorLabel(error, "TransientTransactionError")) return true;
  // 112 = WriteConflict, 251 = NoSuchTransaction (both transient per driver).
  return error.code === 112 || error.code === 251;
}

export function isUnknownTransactionCommitResult(error) {
  return hasErrorLabel(error, "UnknownTransactionCommitResult");
}

export function isTransactionsUnsupportedError(error) {
  if (!error) return false;
  return (
    error.code === 20 ||
    /Transaction numbers are only allowed|replica set member or mongos|transactions are not supported/i.test(
      String(error.message || "")
    )
  );
}

export function classifyTransactionError(error) {
  if (isTransactionsUnsupportedError(error)) return "UNSUPPORTED";
  if (isUnknownTransactionCommitResult(error)) return "UNKNOWN_COMMIT";
  if (isTransientTransactionError(error)) return "TRANSIENT";
  return "DETERMINISTIC";
}

function normalizeOptions(connection, options) {
  if (!connection || typeof connection.startSession !== "function") {
    throw transactionError(
      TRANSACTION_ERROR_CODES.INVALID_OPTIONS,
      "A MongoDB connection exposing startSession() is required",
      { hasConnection: Boolean(connection) }
    );
  }
  if (!options || typeof options !== "object") {
    throw transactionError(
      TRANSACTION_ERROR_CODES.INVALID_OPTIONS,
      "Transaction options are required"
    );
  }
  if (!isNonEmptyTrimmedString(options.actionIdentity)) {
    throw transactionError(
      TRANSACTION_ERROR_CODES.ACTION_IDENTITY_REQUIRED,
      "A stable non-empty actionIdentity is required",
      { actionIdentity: options.actionIdentity }
    );
  }
  if (!isNonEmptyTrimmedString(options.fingerprint)) {
    throw transactionError(
      TRANSACTION_ERROR_CODES.ACTION_IDENTITY_REQUIRED,
      "A stable non-empty fingerprint is required",
      { fingerprint: options.fingerprint }
    );
  }
  if (typeof options.operation !== "function") {
    throw transactionError(
      TRANSACTION_ERROR_CODES.INVALID_OPTIONS,
      "operation(session, context) must be a function"
    );
  }
  if (typeof options.resolveOutcome !== "function") {
    throw transactionError(
      TRANSACTION_ERROR_CODES.INVALID_OPTIONS,
      "resolveOutcome(actionIdentity, context) is required for unknown commit results"
    );
  }

  const maxAttempts = options.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw transactionError(
      TRANSACTION_ERROR_CODES.INVALID_OPTIONS,
      "maxAttempts must be a positive integer",
      { maxAttempts }
    );
  }

  const baseDelayMs = options.baseDelayMs ?? 25;
  const maxDelayMs = options.maxDelayMs ?? 250;
  if (
    !Number.isFinite(baseDelayMs) ||
    baseDelayMs < 0 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < 0
  ) {
    throw transactionError(
      TRANSACTION_ERROR_CODES.INVALID_OPTIONS,
      "baseDelayMs and maxDelayMs must be non-negative finite numbers"
    );
  }

  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  if (typeof sleep !== "function" || typeof random !== "function") {
    throw transactionError(
      TRANSACTION_ERROR_CODES.INVALID_OPTIONS,
      "sleep and random must be functions when supplied"
    );
  }

  return {
    actionIdentity: options.actionIdentity,
    fingerprint: options.fingerprint,
    operation: options.operation,
    resolveOutcome: options.resolveOutcome,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    sleep,
    random,
    onAttempt:
      typeof options.onAttempt === "function" ? options.onAttempt : null,
  };
}

export function computeBackoffMs(attempt, baseDelayMs, maxDelayMs, random) {
  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.max(0, attempt - 1)
  );
  const jitter = Math.floor(random() * (exponential + 1));
  return Math.min(maxDelayMs, jitter);
}

function attachAbortError(error, abortError) {
  if (!error || typeof error !== "object") return;
  try {
    Object.defineProperty(error, "abortError", {
      value: abortError,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch {
    // Frozen/primitive errors: the primary error still propagates unchanged.
  }
}

async function executeAttempt(connection, operation, context) {
  let session;
  try {
    session = await connection.startSession();
  } catch (error) {
    return { kind: "SESSION_FAILED", error };
  }

  let started = false;
  let committed = false;
  let abortError = null;
  let outcome = null;

  try {
    session.startTransaction();
    started = true;
    const result = await operation(session, context);
    try {
      await session.commitTransaction();
      committed = true;
      outcome = { kind: "COMMITTED", result };
    } catch (error) {
      outcome = { kind: "COMMIT_FAILED", error };
    }
  } catch (error) {
    outcome = { kind: "OPERATION_FAILED", error };
  } finally {
    if (started && !committed) {
      try {
        await session.abortTransaction();
      } catch (error) {
        abortError = error;
      }
    }
    try {
      await session.endSession();
    } catch (error) {
      if (!abortError) abortError = error;
    }
  }

  if (abortError) {
    if (outcome?.error) {
      attachAbortError(outcome.error, abortError);
    } else if (outcome) {
      outcome.abortError = abortError;
    }
  }

  return outcome;
}

function retriesExhausted(lastError, details = {}) {
  return transactionError(
    TRANSACTION_ERROR_CODES.RETRIES_EXHAUSTED,
    "Transaction retries were exhausted",
    { ...details, cause: lastError?.message ?? null },
    { status: 409, cause: lastError }
  );
}

function transactionsUnavailable(error) {
  return transactionError(
    TRANSACTION_ERROR_CODES.TRANSACTIONS_UNAVAILABLE,
    "Inventory V2 requires MongoDB transactions (replica set or mongos)",
    { cause: error?.message ?? null },
    { status: 503, cause: error }
  );
}

function outcomeUnresolved(error, details = {}) {
  return transactionError(
    TRANSACTION_ERROR_CODES.OUTCOME_UNRESOLVED,
    "The transaction outcome could not be established; the action was not retried",
    { ...details, cause: error?.message ?? null },
    { status: 409, cause: error }
  );
}

function identityConflict(details = {}) {
  return transactionError(
    TRANSACTION_ERROR_CODES.ACTION_IDENTITY_CONFLICT,
    "The stored action identity or fingerprint does not match this action",
    details,
    { status: 409 }
  );
}

async function resolveUnknownOutcome(config, context, error) {
  let resolution;
  try {
    resolution = await config.resolveOutcome(config.actionIdentity, {
      fingerprint: config.fingerprint,
      attempt: context.attempt,
      error,
    });
  } catch (resolveError) {
    throw outcomeUnresolved(resolveError, { stage: "resolveOutcome" });
  }

  if (!resolution || typeof resolution !== "object") {
    throw outcomeUnresolved(error, { stage: "resolveOutcome", reason: "empty" });
  }

  switch (resolution.status) {
    case UNKNOWN_COMMIT_RESOLUTIONS.CONFIRMED_SUCCESS: {
      if (
        resolution.actionIdentity !== config.actionIdentity ||
        resolution.fingerprint !== config.fingerprint
      ) {
        throw identityConflict({
          expectedActionIdentity: config.actionIdentity,
          storedActionIdentity: resolution.actionIdentity ?? null,
          expectedFingerprint: config.fingerprint,
          storedFingerprint: resolution.fingerprint ?? null,
        });
      }
      return { status: UNKNOWN_COMMIT_RESOLUTIONS.CONFIRMED_SUCCESS, result: resolution.result };
    }
    case UNKNOWN_COMMIT_RESOLUTIONS.CONFIRMED_ABSENT:
      return { status: UNKNOWN_COMMIT_RESOLUTIONS.CONFIRMED_ABSENT };
    case UNKNOWN_COMMIT_RESOLUTIONS.CONFLICT:
      throw identityConflict({
        expectedActionIdentity: config.actionIdentity,
        expectedFingerprint: config.fingerprint,
        resolutionDetails: resolution.details ?? null,
      });
    case UNKNOWN_COMMIT_RESOLUTIONS.UNRESOLVED:
    default:
      throw outcomeUnresolved(error, {
        stage: "resolveOutcome",
        resolutionStatus: resolution.status ?? null,
        resolutionDetails: resolution.details ?? null,
      });
  }
}

/**
 * Run one logical action inside a bounded transaction retry loop.
 *
 * @param {{startSession: Function}} connection dedicated Mongoose connection
 * @param {object} options
 * @param {string} options.actionIdentity stable logical action identity
 * @param {string} options.fingerprint stable payload fingerprint
 * @param {(session: object, context: object) => Promise<any>} options.operation
 * @param {(actionIdentity: string, context: object) => Promise<object>} options.resolveOutcome
 * @param {number} [options.maxAttempts=5]
 * @param {number} [options.baseDelayMs=25]
 * @param {number} [options.maxDelayMs=250]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.random]
 * @param {(event: object) => void} [options.onAttempt]
 * @returns {Promise<any>} the committed operation result or confirmed replay
 */
export async function runV2Transaction(connection, options = {}) {
  const config = normalizeOptions(connection, options);
  const stableContext = Object.freeze({
    actionIdentity: config.actionIdentity,
    fingerprint: config.fingerprint,
  });

  let lastError = null;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const context = Object.freeze({ ...stableContext, attempt });
    if (config.onAttempt) {
      try {
        config.onAttempt({ phase: "start", attempt, context });
      } catch {
        // Observability must never change transaction semantics.
      }
    }

    const outcome = await executeAttempt(connection, config.operation, context);

    if (outcome.kind === "COMMITTED") {
      if (config.onAttempt) {
        try {
          config.onAttempt({ phase: "committed", attempt, context });
        } catch {
          // ignore
        }
      }
      return outcome.result;
    }

    const error = outcome.error;
    lastError = error;

    if (config.onAttempt) {
      try {
        config.onAttempt({
          phase: "failed",
          attempt,
          context,
          classification: classifyTransactionError(error),
        });
      } catch {
        // ignore
      }
    }

    if (isTransactionsUnsupportedError(error)) {
      throw transactionsUnavailable(error);
    }

    // Unknown commit is never retried blindly. Resolve it with the SAME
    // action identity and fingerprint before deciding what happens next.
    if (isUnknownTransactionCommitResult(error)) {
      const resolution = await resolveUnknownOutcome(config, context, error);
      if (resolution.status === UNKNOWN_COMMIT_RESOLUTIONS.CONFIRMED_SUCCESS) {
        return resolution.result;
      }
      // CONFIRMED_ABSENT: the action did not commit. Retry the same action
      // identity (never a new one) if the bounded budget allows it.
      if (attempt < config.maxAttempts) {
        await config.sleep(
          computeBackoffMs(
            attempt,
            config.baseDelayMs,
            config.maxDelayMs,
            config.random
          )
        );
        continue;
      }
      throw retriesExhausted(error, {
        reason: "UNKNOWN_COMMIT_CONFIRMED_ABSENT",
        attempts: attempt,
      });
    }

    if (isTransientTransactionError(error)) {
      if (attempt < config.maxAttempts) {
        await config.sleep(
          computeBackoffMs(
            attempt,
            config.baseDelayMs,
            config.maxDelayMs,
            config.random
          )
        );
        continue;
      }
      throw retriesExhausted(error, {
        reason: "TRANSIENT",
        attempts: attempt,
      });
    }

    // Deterministic business rejection: never retried, never wrapped.
    throw error;
  }

  throw retriesExhausted(lastError, { attempts: config.maxAttempts });
}

export default runV2Transaction;
