// Phase 2.2 — structured application logging with sensitive-data redaction.
//
// Goals:
//  * One JSON line per event so logs are machine-parseable and easy to alert on.
//  * Never emit PINs, passwords, tokens, cookies, authorization headers, or
//    MongoDB connection strings, in any environment.
//  * Never depend on a database or on Next.js aliases (unit-testable).
//
// This module intentionally does not buffer, retry, or ship logs. The hosting
// provider is the log sink; see docs/production-readiness for alerting duties.

// Sensitive field names are matched on a normalized key (lowercase, separators
// removed) so camelCase and snake_case are both covered:
//   pin, pinHash, currentManagerPin, newPin, password, accessToken, sessionId…
// This is intentionally over-inclusive: a redacted log field is cheap, a leaked
// credential is not.
const SENSITIVE_TERMS = Object.freeze([
  "pin",
  "password",
  "passwd",
  "secret",
  "token",
  "credential",
  "authorization",
  "cookie",
  "sessionid",
  "apikey",
  "connectionstring",
  "mongodburi",
  // Payment account numbers. Key normalization already folds camelCase,
  // snake_case, and kebab-case into these forms; bare "account"/"id" is NOT
  // listed so paymentAccountId and ordinary account identifiers stay visible.
  "accountnumber",
  "accountno",
  "acctno",
  "iban",
]);

export function isSensitiveLogKey(key) {
  const normalized = String(key ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!normalized) return false;
  return SENSITIVE_TERMS.some((term) => normalized.includes(term));
}

const MAX_DEPTH = 5;
const MAX_STRING = 2000;

function redactString(value) {
  return String(value)
    .slice(0, MAX_STRING)
    // mongodb://user:password@host -> mongodb://[redacted]@host
    .replace(/(mongodb(?:\+srv)?:\/\/)([^@\s/]+)@/gi, "$1[redacted]@")
    // Bearer/authorization-style tokens
    .replace(/((?:bearer|basic)\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]");
}

export function redactForLog(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[max-depth]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return redactForLog(
      { name: value.name, message: value.message, code: value.code },
      depth + 1
    );
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => redactForLog(entry, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveLogKey(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactForLog(entry, depth + 1);
      }
    }
    return out;
  }
  return "[unserializable]";
}

/**
 * Emit one structured log line. `fields` is redacted before serialization.
 * Unknown levels fall back to `info`.
 */
export function logEvent(level, event, fields = {}) {
  const safeLevel = ["debug", "info", "warn", "error"].includes(level) ? level : "info";
  const payload = {
    ...redactForLog(fields && typeof fields === "object" ? fields : {}),
    ts: new Date().toISOString(),
    level: safeLevel,
    event: String(event || "unknown"),
  };

  let line;
  try {
    line = JSON.stringify(payload);
  } catch {
    line = JSON.stringify({ ts: payload.ts, level: safeLevel, event: payload.event, detail: "[unserializable]" });
  }

  if (safeLevel === "error") console.error(line);
  else if (safeLevel === "warn") console.warn(line);
  else if (safeLevel === "debug") console.debug(line);
  else console.log(line);
  return payload;
}

export const logger = Object.freeze({
  debug: (event, fields) => logEvent("debug", event, fields),
  info: (event, fields) => logEvent("info", event, fields),
  warn: (event, fields) => logEvent("warn", event, fields),
  error: (event, fields) => logEvent("error", event, fields),
});

export const SENSITIVE_LOG_TERMS = SENSITIVE_TERMS;
