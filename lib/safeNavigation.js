// Internal-redirect sanitizer (pure, client- and server-safe).
//
// Used wherever a navigation target can be influenced by a query parameter
// (e.g. /login?next=...). Only a same-origin absolute pathname is accepted;
// protocol-relative ("//evil"), backslash-normalized ("/\\evil"), control
// characters, and absolute URLs ("https://...", "javascript:...") all fall
// back to the caller-provided default. Query/hash are preserved because the
// destination is still same-origin.
//
// The origin is a fixed sentinel, not the request host: the function only
// answers "is this an internal path?", never "which host is allowed?".

const SENTINEL_ORIGIN = "http://bono.internal";

function safeFallback(value) {
  if (typeof value !== "string") return "/";
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) return "/";
  if (/[\\\u0000-\u001F\u007F]/.test(trimmed)) return "/";
  return trimmed;
}

export function sanitizeInternalRedirect(value, fallback = "/") {
  const safeDefault = safeFallback(fallback);

  if (typeof value !== "string") return safeDefault;
  const raw = value.trim();
  if (!raw || raw[0] !== "/") return safeDefault;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return safeDefault;
  // Backslashes are treated as slashes by URL parsers, and control characters
  // can be stripped by browsers — reject both before parsing.
  if (/[\\\u0000-\u001F\u007F]/.test(raw)) return safeDefault;

  let url;
  try {
    url = new URL(raw, SENTINEL_ORIGIN);
  } catch {
    return safeDefault;
  }

  if (url.origin !== SENTINEL_ORIGIN) return safeDefault;
  // Dot-segment normalization can produce a protocol-relative pathname.
  if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) return safeDefault;

  return `${url.pathname}${url.search}${url.hash}`;
}
