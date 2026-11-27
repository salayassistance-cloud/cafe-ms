// Hotel-only request hardening: Origin checks, strict JSON handling, bounded
// request bodies, and CSRF header extraction.
//
// No POS security helper is imported. Errors carry stable Hotel error codes and
// generic messages; no request header values are echoed back.

import {
  HOTEL_ALLOWED_ORIGINS_ENV,
  HOTEL_CANONICAL_ORIGIN_ENV,
  HOTEL_JSON_BODY_MAX_BYTES,
} from "../constants.js";
import { getHotelAllowedOrigins, getHotelCanonicalOrigin } from "../config.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
} from "../errors.js";
import { isPlainObject } from "../validation.js";

function isProductionRuntime(env = process.env) {
  return String(env?.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

function extractHostFromOrigin(originStr) {
  try {
    return new URL(originStr).host.toLowerCase();
  } catch {
    return "";
  }
}

function isLoopbackHost(host) {
  if (!host) return false;
  const bare = host.split(":")[0].toLowerCase();
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "[::1]";
}

export function getHotelTrustedHosts(env = process.env, { canonicalOrigin, allowedOrigins } = {}) {
  const hosts = new Set();
  const canonical = canonicalOrigin !== undefined ? canonicalOrigin : getHotelCanonicalOrigin(env);
  if (canonical) {
    const h = extractHostFromOrigin(canonical);
    if (h) hosts.add(h);
  }

  const allowlist = allowedOrigins !== undefined ? allowedOrigins : getHotelAllowedOrigins(env);
  if (Array.isArray(allowlist)) {
    for (const o of allowlist) {
      const h = extractHostFromOrigin(o);
      if (h) hosts.add(h);
    }
  }

  const renderHost = String(env?.RENDER_EXTERNAL_HOSTNAME ?? "").trim().toLowerCase();
  if (renderHost) hosts.add(renderHost);

  return hosts;
}

function headerValue(request, name) {
  try {
    const value = request?.headers?.get?.(name);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function forbiddenOrigin() {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED,
    message: "Request origin is not allowed",
    status: 403,
    expose: true,
  });
}

function badRequest(message = "Invalid request body") {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.BAD_REQUEST,
    message,
    status: 400,
    expose: true,
  });
}

export function getHotelRequestOrigin(request, { canonicalOrigin, allowedOrigins, env = process.env } = {}) {
  const isProd = isProductionRuntime(env);
  const resolvedCanonical = canonicalOrigin !== undefined ? canonicalOrigin : getHotelCanonicalOrigin(env);
  const allowlist = allowedOrigins !== undefined ? allowedOrigins : getHotelAllowedOrigins(env);
  const trustedHosts = getHotelTrustedHosts(env, { canonicalOrigin: resolvedCanonical, allowedOrigins: allowlist });

  // 1. If explicit canonical origin is set, prefer it
  if (resolvedCanonical) {
    return resolvedCanonical;
  }

  // 2. Extract request host candidates:
  // We check X-Forwarded-Host only if it matches our set of trusted hosts, or if in local dev with loopback.
  const forwardedHost = headerValue(request, "x-forwarded-host").toLowerCase();
  const hostHeader = headerValue(request, "host").toLowerCase();
  let urlHost = "";
  let urlProto = "http:";
  try {
    const u = new URL(request.url);
    urlHost = u.host.toLowerCase();
    urlProto = u.protocol;
  } catch {}

  // Determine external scheme
  const forwardedProto = headerValue(request, "x-forwarded-proto").toLowerCase();
  let scheme = isProd ? "https:" : (forwardedProto === "https" ? "https:" : urlProto);
  if (scheme !== "https:" && scheme !== "http:") {
    scheme = "http:";
  }

  // Find a verified trusted host
  let verifiedHost = null;

  // In non-production, check for loopback
  if (!isProd) {
    if (isLoopbackHost(forwardedHost)) verifiedHost = forwardedHost;
    else if (isLoopbackHost(hostHeader)) verifiedHost = hostHeader;
    else if (isLoopbackHost(urlHost)) verifiedHost = urlHost;
  }

  // In any environment, check against trusted hosts
  if (!verifiedHost) {
    if (forwardedHost && trustedHosts.has(forwardedHost)) {
      verifiedHost = forwardedHost;
    } else if (hostHeader && trustedHosts.has(hostHeader)) {
      verifiedHost = hostHeader;
    } else if (urlHost && trustedHosts.has(urlHost)) {
      verifiedHost = urlHost;
    }
  }

  if (verifiedHost) {
    return `${scheme}//${verifiedHost}`;
  }

  // Fall back to request.url origin if valid URL
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

export function assertHotelRequestOrigin(request, { allowedOrigins, canonicalOrigin, env = process.env } = {}) {
  const rawOrigin = headerValue(request, "origin");
  if (!rawOrigin) throw forbiddenOrigin();

  let parsedOrigin;
  try {
    parsedOrigin = new URL(rawOrigin);
  } catch {
    throw forbiddenOrigin();
  }

  if (
    (parsedOrigin.protocol !== "https:" && parsedOrigin.protocol !== "http:") ||
    parsedOrigin.username ||
    parsedOrigin.password
  ) {
    throw forbiddenOrigin();
  }

  const isProd = isProductionRuntime(env);
  // Production security: reject plain HTTP origins unconditionally
  if (isProd && parsedOrigin.protocol !== "https:") {
    throw forbiddenOrigin();
  }

  const origin = parsedOrigin.origin;
  const allowlist =
    allowedOrigins === undefined
      ? getHotelAllowedOrigins(env)
      : allowedOrigins;
  const explicitlyAllowed =
    Array.isArray(allowlist) && allowlist.includes(origin);

  const resolvedCanonical =
    canonicalOrigin === undefined
      ? getHotelCanonicalOrigin(env)
      : canonicalOrigin;

  let sameOrigin = Boolean(resolvedCanonical && origin === resolvedCanonical);

  // If not already resolved via canonical, compute trusted request origin
  if (!sameOrigin) {
    const requestOrigin = getHotelRequestOrigin(request, {
      canonicalOrigin: resolvedCanonical,
      allowedOrigins: allowlist,
      env,
    });

    if (requestOrigin && origin === requestOrigin) {
      sameOrigin = true;
    }
  }

  // Additional check for non-production loopback requests
  let loopbackMatch = false;
  if (!isProd && !sameOrigin && isLoopbackHost(parsedOrigin.host)) {
    const reqHost = headerValue(request, "host") || (() => { try { return new URL(request.url).host; } catch { return ""; } })();
    if (isLoopbackHost(reqHost) && parsedOrigin.host.split(":")[0] === reqHost.split(":")[0]) {
      loopbackMatch = true;
    }
  }

  if (!sameOrigin && !explicitlyAllowed && !loopbackMatch) {
    throw forbiddenOrigin();
  }

  // A cross-site browser request is only acceptable when its exact origin has
  // been allowlisted; otherwise reject it before any credential work.
  const fetchSite = headerValue(request, "sec-fetch-site").toLowerCase();
  if (fetchSite === "cross-site" && !explicitlyAllowed) {
    throw forbiddenOrigin();
  }

  return { origin, sameOrigin: sameOrigin || loopbackMatch, explicitlyAllowed };
}

export function assertHotelJsonContentType(request) {
  const contentType = headerValue(request, "content-type").toLowerCase();
  const mediaType = contentType.split(";")[0].trim();
  if (mediaType !== "application/json") {
    throw new HotelApiError({
      code: HOTEL_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
      message: "Content-Type must be application/json",
      status: 415,
      expose: true,
    });
  }
}

function payloadTooLarge(maxBytes) {
  return new HotelApiError({
    code: HOTEL_ERROR_CODES.PAYLOAD_TOO_LARGE,
    message: `Request body must not exceed ${maxBytes} bytes`,
    status: 413,
    expose: true,
  });
}

async function readBoundedText(request, maxBytes) {
  const contentLength = headerValue(request, "content-length");
  if (contentLength !== "") {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0) {
      throw badRequest();
    }
    if (declared > maxBytes) throw payloadTooLarge(maxBytes);
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw payloadTooLarge(maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function readHotelJsonBody(
  request,
  { maxBytes = HOTEL_JSON_BODY_MAX_BYTES } = {}
) {
  assertHotelJsonContentType(request);

  const text = await readBoundedText(request, maxBytes);
  if (text.trim() === "") throw badRequest();

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest();
  }

  if (!isPlainObject(body)) {
    throw badRequest("Request body must be a JSON object");
  }
  return body;
}

// Cancellation reasons are optional, so a cancellation request may omit a body
// entirely. Any body that is present still goes through the strict bounded JSON
// parser.
export async function readHotelOptionalJsonBody(
  request,
  { maxBytes = HOTEL_JSON_BODY_MAX_BYTES } = {}
) {
  const contentType = headerValue(request, "content-type");
  if (!request.body && contentType === "") return {};
  return readHotelJsonBody(request, { maxBytes });
}

export { HOTEL_ALLOWED_ORIGINS_ENV, HOTEL_CANONICAL_ORIGIN_ENV };
