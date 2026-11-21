// transactionRunner.js — the single MongoDB transaction retry policy for V1.
//
// Extracted verbatim from lib/inventoryReservationService.js so Recipe writes
// and InventoryItem unit changes share the exact retry/classification behavior
// the reservation layer already proved. There is no second retry policy.
//
// Guarantees:
//   * bounded to three attempts with a 20 ms fixed backoff;
//   * retries only TransientTransactionError / write conflicts (codes 112, 251);
//   * never retries UnknownTransactionCommitResult (the write may be durable);
//   * aborts on every failure and ends the session in `finally`;
//   * unsupported standalone topology maps to an injected 503 error;
//   * deterministic validation/business errors propagate immediately;
//   * `options.maxAttempts` may narrow the bounded retry for callers whose
//     outer loop rebuilds mutable state before every attempt.
//
// No database access at import time and no dependencies — the DB-free suite
// exercises this module with a fake connection.

export class TransactionRunnerError extends Error {
  constructor(message, status = 500, code = null) {
    super(message);
    this.name = "TransactionRunnerError";
    this.status = status;
    if (code) this.code = code;
  }
}

// The MongoDB driver may wrap the original server error (for example a
// standalone deployment rejects the transactional write first as
// "Transaction numbers are only allowed..." and surfaces a wrapper about
// retryable writes). Walk the cause/originalError chain so topology and
// transient classification see the real server error.
export function errorChain(err) {
  const chain = [];
  let current = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    chain.push(current);
    current =
      current.originalError ||
      current.errorResponse?.originalError ||
      current.cause ||
      null;
  }
  return chain;
}

export function hasLabel(err, label) {
  return errorChain(err).some(
    (entry) =>
      (typeof entry.hasErrorLabel === "function" && entry.hasErrorLabel(label)) ||
      (Array.isArray(entry.errorLabels) && entry.errorLabels.includes(label)) ||
      (entry.errorLabelSet && Object.prototype.hasOwnProperty.call(entry.errorLabelSet, label))
  );
}

export function hasCode(err, codes) {
  return errorChain(err).some((entry) => codes.includes(entry.code));
}

export function isTransientTransactionError(err) {
  return hasLabel(err, "TransientTransactionError") || hasCode(err, [112, 251]);
}

export function isUnknownCommitResult(err) {
  return hasLabel(err, "UnknownTransactionCommitResult");
}

// A standalone MongoDB (no replica set / mongos) accepts startSession() but
// rejects the first transactional write. Surface that as an explicit 503 so
// clients see "inventory unavailable" instead of a generic 409/500. The driver
// sometimes reports "does not support retryable writes" with the real
// "Transaction numbers are only allowed..." error nested inside.
export function isTransactionsUnsupportedError(err) {
  if (!err) return false;
  return (
    hasCode(err, [20]) ||
    errorChain(err).some((entry) =>
      /Transaction numbers are only allowed|replica set member or mongos|transactions are not supported|does not support retryable writes/i.test(
        String(entry.message || "")
      )
    )
  );
}

// Bounded retry for transient transaction errors only. Unknown commit results
// are never retried because the write may already be durable.
//
// `makeUnavailableError(message, status, code)` lets each caller keep its own
// typed error contract (reservation vs recipe vs inventory-item). The default
// is a generic TransactionRunnerError with the same status/code.
export async function runInTransaction(conn, fn, options = {}) {
  const makeUnavailableError =
    options.makeUnavailableError ||
    ((message, status, code) => new TransactionRunnerError(message, status, code));
  // Callers whose outer retry loop reconstructs all mutable state can request
  // a single attempt here. Default retry behavior is unchanged.
  const maxAttempts =
    Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
      ? options.maxAttempts
      : 3;

  let lastErr = null;
  // Keep the canonical bounded loop visible (`attempt < 3`); maxAttempts can
  // narrow it for callers that rebuild state in an outer retry loop.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt >= maxAttempts) break;
    const session = await conn.startSession();
    try {
      session.startTransaction();
      const result = await fn(session);
      await session.commitTransaction();
      return result;
    } catch (err) {
      lastErr = err;
      try {
        await session.abortTransaction();
      } catch {}
      if (isTransactionsUnsupportedError(err)) {
        throw makeUnavailableError(
          "Inventory reservations require MongoDB transactions (replica set or mongos).",
          503,
          "TRANSACTIONS_UNAVAILABLE"
        );
      }
      if (isTransientTransactionError(err) && !isUnknownCommitResult(err) && attempt < 2 && maxAttempts > 1) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch {}
        continue;
      }
      throw err;
    } finally {
      try {
        await session.endSession();
      } catch {}
    }
  }
  throw lastErr || new TransactionRunnerError("Transaction failed", 409);
}

export default runInTransaction;
