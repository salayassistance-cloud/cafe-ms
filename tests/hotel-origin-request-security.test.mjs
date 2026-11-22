import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  assertHotelRequestOrigin,
  getHotelRequestOrigin,
  getHotelTrustedHosts,
} from "../lib/hotel/http/requestSecurity.js";
import {
  getHotelCanonicalOrigin,
  getHotelAllowedOrigins,
  parseSingleBareOrigin,
  inspectHotelConfiguration,
} from "../lib/hotel/config.js";
import { HOTEL_ERROR_CODES, HotelApiError } from "../lib/hotel/errors.js";

function mockRequest({
  url = "https://bono-pos.onrender.com/api/hotel/auth/login",
  origin,
  host = "bono-pos.onrender.com",
  forwardedProto,
  forwardedHost,
  fetchSite,
} = {}) {
  const headersMap = new Map();
  if (origin !== undefined) headersMap.set("origin", origin);
  if (host !== undefined) headersMap.set("host", host);
  if (forwardedProto !== undefined) headersMap.set("x-forwarded-proto", forwardedProto);
  if (forwardedHost !== undefined) headersMap.set("x-forwarded-host", forwardedHost);
  if (fetchSite !== undefined) headersMap.set("sec-fetch-site", fetchSite);

  return {
    url,
    headers: {
      get: (k) => headersMap.get(k.toLowerCase()) ?? null,
    },
  };
}

describe("Hotel Origin Security — Reverse Proxy & Canonical Resolution", () => {
  const prodEnv = {
    NODE_ENV: "production",
    RENDER: "true",
    RENDER_EXTERNAL_URL: "https://bono-pos.onrender.com",
    RENDER_EXTERNAL_HOSTNAME: "bono-pos.onrender.com",
  };

  test("resolves canonical origin automatically from RENDER_EXTERNAL_URL in production", () => {
    const canonical = getHotelCanonicalOrigin(prodEnv);
    assert.equal(canonical, "https://bono-pos.onrender.com");
  });

  test("explicit HOTEL_CANONICAL_ORIGIN takes precedence over RENDER_EXTERNAL_URL", () => {
    const customEnv = {
      ...prodEnv,
      HOTEL_CANONICAL_ORIGIN: "https://hotel.bono.et",
    };
    const canonical = getHotelCanonicalOrigin(customEnv);
    assert.equal(canonical, "https://hotel.bono.et");
  });

  test("rejects malformed canonical origin with wildcards, paths, or credentials", () => {
    assert.throws(
      () => parseSingleBareOrigin("https://*.onrender.com"),
      /must not contain wildcards/
    );
    assert.throws(
      () => parseSingleBareOrigin("https://user:pass@example.com"),
      /must be a bare origin/
    );
    assert.throws(
      () => parseSingleBareOrigin("https://example.com/subpath"),
      /must be a bare origin/
    );
    assert.throws(
      () => parseSingleBareOrigin("ftp://example.com"),
      /must use http or https/
    );
  });

  test("trusted host set includes canonical, allowlist, and Render external hostname", () => {
    const env = {
      NODE_ENV: "production",
      RENDER_EXTERNAL_HOSTNAME: "bono-pos.onrender.com",
      HOTEL_ALLOWED_ORIGINS: "https://hotel.bono.et, https://admin.bono.et",
    };
    const trusted = getHotelTrustedHosts(env);
    assert.ok(trusted.has("bono-pos.onrender.com"));
    assert.ok(trusted.has("hotel.bono.et"));
    assert.ok(trusted.has("admin.bono.et"));
    assert.equal(trusted.has("attacker.com"), false);
  });

  test("Render proxy scenario: internal HTTP request.url matches external HTTPS Origin", () => {
    // Render edge terminates TLS: forwards plain HTTP to Node container
    const req = mockRequest({
      url: "http://bono-pos.onrender.com:10000/api/hotel/auth/login",
      origin: "https://bono-pos.onrender.com",
      host: "bono-pos.onrender.com:10000",
      forwardedProto: "https",
      forwardedHost: "bono-pos.onrender.com",
    });

    const res = assertHotelRequestOrigin(req, { env: prodEnv });
    assert.equal(res.origin, "https://bono-pos.onrender.com");
    assert.equal(res.sameOrigin, true);
  });

  test("passes when origin matches explicit allowlist even if different from canonical host", () => {
    const env = {
      ...prodEnv,
      HOTEL_ALLOWED_ORIGINS: "https://hotel.bono.et",
    };
    const req = mockRequest({
      url: "http://bono-pos.onrender.com:10000/api/hotel/rooms",
      origin: "https://hotel.bono.et",
      host: "bono-pos.onrender.com:10000",
      forwardedProto: "https",
    });

    const res = assertHotelRequestOrigin(req, { env });
    assert.equal(res.origin, "https://hotel.bono.et");
    assert.equal(res.explicitlyAllowed, true);
  });

  test("rejects untrusted third-party origins in production with 403 ORIGIN_NOT_ALLOWED", () => {
    const req = mockRequest({
      url: "http://bono-pos.onrender.com:10000/api/hotel/auth/login",
      origin: "https://attacker.evil.com",
      host: "bono-pos.onrender.com:10000",
      forwardedProto: "https",
    });

    assert.throws(
      () => assertHotelRequestOrigin(req, { env: prodEnv }),
      (err) => err instanceof HotelApiError && err.code === HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED && err.status === 403
    );
  });

  test("rejects spoofed X-Forwarded-Host from untrusted candidate", () => {
    // Attacker crafts headers trying to trick server into accepting evil.com as requestOrigin
    const req = mockRequest({
      url: "http://bono-pos.onrender.com:10000/api/hotel/auth/login",
      origin: "https://evil.com",
      host: "bono-pos.onrender.com:10000",
      forwardedProto: "https",
      forwardedHost: "evil.com",
    });

    assert.throws(
      () => assertHotelRequestOrigin(req, { env: prodEnv }),
      (err) => err instanceof HotelApiError && err.code === HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED
    );
  });

  test("strictly rejects unencrypted HTTP origins in production", () => {
    const req = mockRequest({
      url: "http://bono-pos.onrender.com:10000/api/hotel/auth/login",
      origin: "http://bono-pos.onrender.com",
      host: "bono-pos.onrender.com:10000",
      forwardedProto: "http",
    });

    assert.throws(
      () => assertHotelRequestOrigin(req, { env: prodEnv }),
      (err) => err instanceof HotelApiError && err.code === HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED
    );
  });

  test("rejects requests missing Origin header", () => {
    const req = mockRequest({
      url: "https://bono-pos.onrender.com/api/hotel/auth/login",
      origin: null,
    });

    assert.throws(
      () => assertHotelRequestOrigin(req, { env: prodEnv }),
      (err) => err instanceof HotelApiError && err.code === HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED
    );
  });

  test("rejects cross-site fetch unless explicitly in allowlist", () => {
    const reqCrossSite = mockRequest({
      url: "http://bono-pos.onrender.com:10000/api/hotel/auth/login",
      origin: "https://bono-pos.onrender.com",
      fetchSite: "cross-site",
    });

    // Cross-site with only canonical (not in explicit allowlist) is forbidden
    assert.throws(
      () => assertHotelRequestOrigin(reqCrossSite, { env: prodEnv }),
      (err) => err instanceof HotelApiError && err.code === HOTEL_ERROR_CODES.ORIGIN_NOT_ALLOWED
    );

    // Cross-site with explicit allowlist entry succeeds
    const envWithAllowlist = {
      ...prodEnv,
      HOTEL_ALLOWED_ORIGINS: "https://bono-pos.onrender.com",
    };
    const allowed = assertHotelRequestOrigin(reqCrossSite, { env: envWithAllowlist });
    assert.equal(allowed.explicitlyAllowed, true);
  });

  test("supports local development loopback origins seamlessly", () => {
    const devEnv = { NODE_ENV: "development" };
    const reqLocalhost = mockRequest({
      url: "http://localhost:3000/api/hotel/auth/login",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    });

    const res = assertHotelRequestOrigin(reqLocalhost, { env: devEnv });
    assert.equal(res.origin, "http://localhost:3000");
    assert.equal(res.sameOrigin, true);
  });

  test("diagnostic inspectHotelConfiguration reflects canonicalOrigin metadata", () => {
    const inspection = inspectHotelConfiguration(prodEnv);
    assert.equal(inspection.canonicalOrigin, "https://bono-pos.onrender.com");
  });
});
