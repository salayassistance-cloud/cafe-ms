// PWA install-launch context (navigation only — never auth/session data).
//
// Why this exists: the Web App Manifest `start_url` is static by spec, so it
// cannot be rewritten per-page at install time. Instead the manifest points at
// the static `/launch` router, and this module preserves the install context
// per-device in localStorage (pathname only, allowlisted). Launching the
// installed app replays the last safe route the device actually visited.
//
// Security: only a same-origin pathname from the allowlist below is ever
// stored or returned. No query/hash (so no PIN, token, staffId, or session
// material), no external URLs (no open redirect).

export const PWA_LAST_ROUTE_KEY = "bono:pwa:last-route";

export const PWA_LAUNCH_FALLBACK = "/";

// Exact top-level launch routes (no subpaths except /manager/* below).
const EXACT_SAFE_ROUTES = new Set([
  "/",
  "/menu",
  "/waiter",
  "/kitchen",
  "/kds",
  "/barista",
  "/cashier",
  "/manager",
]);

function normalizePathname(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.startsWith("//")) return null;
  // Block protocol markers, backslashes, query/hash, traversal, extensions.
  if (
    trimmed.includes("\\") ||
    trimmed.includes(":") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.includes(".")
  ) {
    return null;
  }
  // Allow only safe pathname characters.
  if (!/^\/[A-Za-z0-9/_-]*$/.test(trimmed)) return null;
  // Strip trailing slash (keep root "/").
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

export function isSafePwaRoute(pathname) {
  const clean = normalizePathname(pathname);
  if (!clean) return false;
  if (EXACT_SAFE_ROUTES.has(clean)) return true;
  // Manager sub-portals (e.g. /manager/reports) share MANAGER authorization.
  if (clean.startsWith("/manager/")) return true;
  return false;
}

export function sanitizePwaRoute(pathname) {
  const clean = normalizePathname(pathname);
  if (!clean) return null;
  return isSafePwaRoute(clean) ? clean : null;
}

// Client-only: read the stored launch route (validated, fallback "/").
// Must only be called in the browser (launcher page effect).
export function getSafePwaLaunchRoute() {
  try {
    const raw = window.localStorage.getItem(PWA_LAST_ROUTE_KEY);
    const clean = raw ? sanitizePwaRoute(raw) : null;
    return clean || PWA_LAUNCH_FALLBACK;
  } catch {
    return PWA_LAUNCH_FALLBACK;
  }
}
