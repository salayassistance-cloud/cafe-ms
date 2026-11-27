import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  getTrustedHotelClientIp,
  sanitizeIpCandidate,
  HOTEL_TRUSTED_IP_HEADERS,
  HOTEL_UNTRUSTED_BUCKET,
} from "../lib/hotel/http/clientIp.js";

describe("Hotel Client IP Extraction (Proxy-Aware)", () => {
  test("sanitizes valid IPv4 addresses and strips optional ports", () => {
    assert.equal(sanitizeIpCandidate("192.168.1.1"), "192.168.1.1");
    assert.equal(sanitizeIpCandidate("192.168.1.1:8080"), "192.168.1.1");
    assert.equal(sanitizeIpCandidate("  10.0.0.5  "), "10.0.0.5");
    assert.equal(sanitizeIpCandidate("255.255.255.255"), "255.255.255.255");
    assert.equal(sanitizeIpCandidate("256.0.0.1"), null);
    assert.equal(sanitizeIpCandidate(""), null);
    assert.equal(sanitizeIpCandidate(null), null);
    assert.equal(sanitizeIpCandidate("invalid-ip"), null);
  });

  test("sanitizes valid IPv6 addresses and bracketed forms", () => {
    assert.equal(sanitizeIpCandidate("2001:db8::1"), "2001:db8::1");
    assert.equal(sanitizeIpCandidate("[2001:db8::1]:8080"), "2001:db8::1");
    assert.equal(sanitizeIpCandidate("::1"), "::1");
    assert.equal(sanitizeIpCandidate("::ffff:192.0.2.1"), "192.0.2.1");
  });

  test("prefers x-nf-client-connection-ip when present (Netlify)", () => {
    const req = {
      headers: new Headers({
        "x-nf-client-connection-ip": "198.51.100.50",
        "cf-connecting-ip": "203.0.113.88",
        "x-forwarded-for": "203.0.113.10, 10.0.0.1",
        "x-real-ip": "10.0.0.1",
      }),
    };
    assert.equal(getTrustedHotelClientIp(req), "198.51.100.50");
  });

  test("extracts cf-connecting-ip from Render edge (Cloudflare) and ignores spoofed x-forwarded-for", () => {
    const req = {
      headers: new Headers({
        "cf-connecting-ip": "198.51.100.88",
        "x-forwarded-for": "1.2.3.4, 5.6.7.8", // Spoofed client header
        "x-real-ip": "10.0.0.1",
      }),
    };
    assert.equal(getTrustedHotelClientIp(req), "198.51.100.88");
  });

  test("extracts true-client-ip when cf-connecting-ip is absent", () => {
    const req = {
      headers: new Headers({
        "true-client-ip": "198.51.100.66",
        "x-forwarded-for": "1.2.3.4",
      }),
    };
    assert.equal(getTrustedHotelClientIp(req), "198.51.100.66");
  });

  test("extracts first hop from x-forwarded-for on Render when edge headers absent", () => {
    const req = {
      headers: new Headers({
        "x-forwarded-for": "203.0.113.99, 10.100.0.1, 172.16.0.2",
      }),
    };
    assert.equal(getTrustedHotelClientIp(req), "203.0.113.99");
  });

  test("extracts x-real-ip when x-forwarded-for is absent", () => {
    const req = {
      headers: new Headers({
        "x-real-ip": "198.51.100.77",
      }),
    };
    assert.equal(getTrustedHotelClientIp(req), "198.51.100.77");
  });

  test("returns null when headers are absent", () => {
    const req = {
      headers: new Headers(),
    };
    assert.equal(getTrustedHotelClientIp(req), null);
  });
});
