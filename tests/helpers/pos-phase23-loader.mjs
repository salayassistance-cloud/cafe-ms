// Phase 2.3 integration-test resolver for the repository's module specifiers.
//
// The production code uses Next.js path aliases (`@/lib/...`) and some internal
// files import each other without a `.js` extension. The DB-free unit suite
// only imports pure modules with explicit paths, so it never needs this.
// The opt-in replica-set harness is executed explicitly with:
//
//   node --import ./tests/helpers/pos-phase23-register.mjs \
//        --test tests/integration/phase23-replica-set.integration.mjs
//
// This loader has no runtime effect on the application or the default test run.

const ROOT = new URL("../../", import.meta.url);

function withJsExtension(url) {
  const parsed = new URL(url);
  if (/\.[a-zA-Z0-9]+$/.test(parsed.pathname)) return null;
  parsed.pathname += ".js";
  return parsed.href;
}

export async function resolve(specifier, context, nextResolve) {
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
