// Test-only module resolver for Hotel route-handler behavior tests.
//
// Production code uses the Next.js `@/` alias and extensionless internal
// imports. This loader resolves both, and redirects the Hotel database
// connection module to an in-memory fake so a Route Handler can be executed
// with no database, no network, and no production credentials.
//
// It has no effect on the application or on the default `node --test` run;
// it is only active when a test is started with:
//
//   node --import ./tests/helpers/hotel-route-register.mjs --test <file>
//
// No production module is modified.

const ROOT = new URL("../../", import.meta.url);
const FAKE_DB = new URL("./hotel-route-fake-db.mjs", import.meta.url).href;

function withJsExtension(url) {
  const parsed = new URL(url);
  if (/\.[a-zA-Z0-9]+$/.test(parsed.pathname)) return null;
  parsed.pathname += ".js";
  return parsed.href;
}

async function resolveTarget(specifier, context, nextResolve) {
  let target = specifier;
  if (specifier.startsWith("@/")) {
    target = new URL(specifier.slice(2), ROOT).href;
  }

  try {
    return await nextResolve(target, context);
  } catch (error) {
    const isFileLike =
      target.startsWith("file:") ||
      target.startsWith("./") ||
      target.startsWith("../") ||
      target.startsWith("/");
    if (!isFileLike) throw error;

    const absolute = target.startsWith("file:")
      ? target
      : new URL(target, context.parentURL).href;
    const candidate = withJsExtension(absolute);
    if (candidate) {
      try {
        return await nextResolve(candidate, context);
      } catch {
        // Fall through to the original, more accurate error.
      }
    }
    throw error;
  }
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await resolveTarget(specifier, context, nextResolve);
  if (resolved.url.endsWith("/lib/hotel/db/connection.js")) {
    return { url: FAKE_DB, shortCircuit: true };
  }
  return resolved;
}
