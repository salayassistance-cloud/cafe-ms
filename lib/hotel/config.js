// Hotel-only configuration validation.
//
// This module never opens a connection and never logs or returns a raw secret,
// URI, or credential. Validation happens when a caller explicitly asks for a
// value, not at module import time, so a build can run before secrets exist.
//
// The database URI is used exclusively from ROOM_MONGODB_URI. The session
// secret must be independent from the POS AUTH_SECRET.

import {
  HOTEL_ALLOWED_ORIGINS_ENV,
  HOTEL_CANONICAL_ORIGIN_ENV,
  HOTEL_DB_NAME,
  HOTEL_MONGODB_URI_ENV,
  HOTEL_SESSION_SECRET_ENV,
  HOTEL_SESSION_SECRET_MIN_LENGTH,
} from "./constants.js";
import {
  HotelConfigurationError,
  HotelDatabaseConfigurationError,
} from "./errors.js";

const MONGO_SCHEME_RE = /^mongodb(?:\+srv)?:\/\//i;
const MONGODB_URI_WHITESPACE_RE = /\s/;

function envString(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value : "";
}

function extractMongoDatabaseName(uri) {
  const withoutQuery = uri.replace(/[?#].*$/, "");
  const afterScheme = withoutQuery.replace(MONGO_SCHEME_RE, "");
  const firstSlash = afterScheme.indexOf("/");
  if (firstSlash === -1) return "";

  const rawPath = afterScheme.slice(firstSlash + 1).replace(/\/+$/, "");
  if (rawPath === "") return "";

  try {
    return decodeURIComponent(rawPath);
  } catch {
    throw new HotelDatabaseConfigurationError(
      `${HOTEL_MONGODB_URI_ENV} contains an invalid database path`
    );
  }
}

export function requireHotelMongoUri(env = process.env) {
  const raw = envString(env, HOTEL_MONGODB_URI_ENV);
  if (raw.trim() === "") {
    throw new HotelDatabaseConfigurationError(
      `${HOTEL_MONGODB_URI_ENV} is not configured`
    );
  }

  const uri = raw.trim();
  if (!MONGO_SCHEME_RE.test(uri)) {
    throw new HotelDatabaseConfigurationError(
      `${HOTEL_MONGODB_URI_ENV} must be a mongodb:// or mongodb+srv:// URI`
    );
  }
  if (MONGODB_URI_WHITESPACE_RE.test(uri)) {
    throw new HotelDatabaseConfigurationError(
      `${HOTEL_MONGODB_URI_ENV} must not contain whitespace`
    );
  }

  const databaseName = extractMongoDatabaseName(uri);
  if (databaseName !== "" && databaseName !== HOTEL_DB_NAME) {
    throw new HotelDatabaseConfigurationError(
      `${HOTEL_MONGODB_URI_ENV} must target the ${HOTEL_DB_NAME} database`
    );
  }

  return uri;
}

export function isHotelMongoUriConfigured(env = process.env) {
  try {
    requireHotelMongoUri(env);
    return true;
  } catch {
    return false;
  }
}

export function requireHotelSessionSecret(env = process.env) {
  const secret = envString(env, HOTEL_SESSION_SECRET_ENV);
  if (secret === "") {
    throw new HotelConfigurationError(
      `${HOTEL_SESSION_SECRET_ENV} is not configured`
    );
  }
  if (secret.trim() === "") {
    throw new HotelConfigurationError(
      `${HOTEL_SESSION_SECRET_ENV} must not be whitespace-only`
    );
  }
  if (secret.length < HOTEL_SESSION_SECRET_MIN_LENGTH) {
    throw new HotelConfigurationError(
      `${HOTEL_SESSION_SECRET_ENV} must be at least ${HOTEL_SESSION_SECRET_MIN_LENGTH} characters`
    );
  }

  const authSecret = envString(env, "AUTH_SECRET");
  if (authSecret !== "" && secret === authSecret) {
    throw new HotelConfigurationError(
      `${HOTEL_SESSION_SECRET_ENV} must be different from AUTH_SECRET`
    );
  }

  return secret;
}

export function parseHotelAllowedOrigins(rawValue) {
  if (rawValue == null) return Object.freeze([]);
  const value = String(rawValue).trim();
  if (value === "") return Object.freeze([]);

  const origins = new Set();
  for (const entry of value.split(",")) {
    const candidate = entry.trim();
    if (candidate === "") continue;
    if (candidate.includes("*")) {
      throw new HotelConfigurationError(
        `${HOTEL_ALLOWED_ORIGINS_ENV} must not contain wildcards`
      );
    }

    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new HotelConfigurationError(
        `${HOTEL_ALLOWED_ORIGINS_ENV} contains an invalid origin`
      );
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new HotelConfigurationError(
        `${HOTEL_ALLOWED_ORIGINS_ENV} entries must use http or https`
      );
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new HotelConfigurationError(
        `${HOTEL_ALLOWED_ORIGINS_ENV} entries must be bare origins`
      );
    }

    origins.add(parsed.origin);
  }

  return Object.freeze([...origins]);
}

export function parseSingleBareOrigin(candidate, envVarName = HOTEL_CANONICAL_ORIGIN_ENV) {
  if (candidate == null) return null;
  const value = String(candidate).trim();
  if (value === "") return null;
  if (value.includes("*")) {
    throw new HotelConfigurationError(
      `${envVarName} must not contain wildcards`
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HotelConfigurationError(
      `${envVarName} contains an invalid origin`
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HotelConfigurationError(
      `${envVarName} must use http or https`
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new HotelConfigurationError(
      `${envVarName} must be a bare origin`
    );
  }

  return parsed.origin;
}

export function getHotelCanonicalOrigin(env = process.env) {
  const explicit = envString(env, HOTEL_CANONICAL_ORIGIN_ENV);
  if (explicit.trim() !== "") {
    return parseSingleBareOrigin(explicit, HOTEL_CANONICAL_ORIGIN_ENV);
  }
  const renderUrl = envString(env, "RENDER_EXTERNAL_URL");
  if (renderUrl.trim() !== "") {
    return parseSingleBareOrigin(renderUrl, "RENDER_EXTERNAL_URL");
  }
  return null;
}

export function getHotelAllowedOrigins(env = process.env) {
  return parseHotelAllowedOrigins(envString(env, HOTEL_ALLOWED_ORIGINS_ENV));
}

function collectConfigurationIssues(env, options) {
  const issues = [];

  if (options.requireDatabase) {
    try {
      requireHotelMongoUri(env);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "database configuration is invalid");
    }
  }

  if (options.requireSessionSecret) {
    try {
      requireHotelSessionSecret(env);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "session secret is invalid");
    }
  }

  return issues;
}

export function assertHotelConfiguration(
  env = process.env,
  { requireDatabase = true, requireSessionSecret = true } = {}
) {
  const issues = collectConfigurationIssues(env, {
    requireDatabase,
    requireSessionSecret,
  });

  // Validate the allowlist even when it is optional, so a malformed value fails
  // closed instead of silently disabling origin checks.
  let allowedOrigins = Object.freeze([]);
  try {
    allowedOrigins = getHotelAllowedOrigins(env);
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "allowed origins are invalid"
    );
  }

  let canonicalOrigin = null;
  try {
    canonicalOrigin = getHotelCanonicalOrigin(env);
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "canonical origin is invalid"
    );
  }

  if (issues.length > 0) {
    throw new HotelConfigurationError(
      `Hotel configuration is invalid: ${issues.join("; ")}`
    );
  }

  return {
    databaseName: HOTEL_DB_NAME,
    allowedOrigins,
    canonicalOrigin,
    sessionSecretConfigured: requireSessionSecret,
  };
}

// Safe diagnostics for an operator or health check. Values are never included.
export function inspectHotelConfiguration(env = process.env) {
  let databaseConfigured = false;
  let sessionSecretConfigured = false;
  let allowedOrigins = Object.freeze([]);
  let canonicalOrigin = null;
  const issues = [];

  try {
    requireHotelMongoUri(env);
    databaseConfigured = true;
  } catch (error) {
    issues.push(error.message);
  }

  try {
    requireHotelSessionSecret(env);
    sessionSecretConfigured = true;
  } catch (error) {
    issues.push(error.message);
  }

  try {
    allowedOrigins = getHotelAllowedOrigins(env);
  } catch (error) {
    issues.push(error.message);
  }

  try {
    canonicalOrigin = getHotelCanonicalOrigin(env);
  } catch (error) {
    issues.push(error.message);
  }

  return {
    ready: issues.length === 0,
    database: {
      configured: databaseConfigured,
      name: HOTEL_DB_NAME,
    },
    sessionSecret: {
      configured: sessionSecretConfigured,
      minLength: HOTEL_SESSION_SECRET_MIN_LENGTH,
    },
    allowedOrigins,
    canonicalOrigin,
    issues,
  };
}
