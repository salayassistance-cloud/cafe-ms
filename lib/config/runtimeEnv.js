// Phase 2.2 — runtime environment contract (pure helpers, no side effects).
//
// These helpers never read .env files and never log values. They are safe to
// call from a health probe or an ops script. Nothing here throws at import
// time, so a missing variable cannot break the build.

export const REQUIRED_SERVER_ENV = Object.freeze(["MONGODB_URI"]);

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/**
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function validateRuntimeEnv(env = process.env) {
  const missing = REQUIRED_SERVER_ENV.filter((key) => !hasValue(env?.[key]));
  return { ok: missing.length === 0, missing };
}

export function assertRuntimeEnv(env = process.env) {
  const result = validateRuntimeEnv(env);
  if (!result.ok) {
    throw new Error(`Missing required environment variables: ${result.missing.join(", ")}`);
  }
  return result;
}
