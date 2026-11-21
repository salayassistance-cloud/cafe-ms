// Regression protection for the /login?next= open-redirect fix.
//
// `next` is user-controlled. After a successful PIN login the app must only
// navigate to a same-origin internal path; absolute URLs, protocol-relative
// targets, backslash-normalized hosts and dot-segment tricks must fall back.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeInternalRedirect } from "../lib/safeNavigation.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

describe("sanitizeInternalRedirect", () => {
  test("accepts internal absolute paths, including query/hash", () => {
    assert.equal(sanitizeInternalRedirect("/waiter"), "/waiter");
    assert.equal(sanitizeInternalRedirect("/manager/reports"), "/manager/reports");
    assert.equal(sanitizeInternalRedirect("/cashier?tab=paid#top"), "/cashier?tab=paid#top");
    assert.equal(sanitizeInternalRedirect("/a/../b"), "/b");
  });

  test("rejects absolute and protocol-relative URLs", () => {
    assert.equal(sanitizeInternalRedirect("https://evil.example", "/waiter"), "/waiter");
    assert.equal(sanitizeInternalRedirect("http://evil.example/x", "/waiter"), "/waiter");
    assert.equal(sanitizeInternalRedirect("//evil.example", "/waiter"), "/waiter");
    assert.equal(sanitizeInternalRedirect("///evil.example", "/waiter"), "/waiter");
    assert.equal(sanitizeInternalRedirect("javascript:alert(1)", "/waiter"), "/waiter");
    assert.equal(sanitizeInternalRedirect("data:text/html,x", "/waiter"), "/waiter");
  });

  test("rejects backslash and dot-segment host smuggling", () => {
    assert.equal(sanitizeInternalRedirect("/\\evil.example", "/waiter"), "/waiter");
    assert.equal(sanitizeInternalRedirect("/..//evil.example", "/waiter"), "/waiter");
    assert.equal(sanitizeInternalRedirect("/%2e%2e//evil.example", "/waiter"), "/waiter");
  });

  test("rejects non-strings, blanks, control characters and unsafe fallbacks", () => {
    assert.equal(sanitizeInternalRedirect(null), "/");
    assert.equal(sanitizeInternalRedirect(undefined), "/");
    assert.equal(sanitizeInternalRedirect(""), "/");
    assert.equal(sanitizeInternalRedirect("/\t/evil"), "/");
    assert.equal(sanitizeInternalRedirect("https://evil.example", "//evil.example"), "/");
  });
});

describe("login redirect wiring", () => {
  test("the /login compatibility page sanitizes next before role resolution", () => {
    const page = src("app/login/page.js");
    assert.ok(page.includes("sanitizeInternalRedirect"), "login page sanitizes next");
    assert.ok(
      page.includes("sanitizeInternalRedirect(params?.next"),
      "the raw search param is the sanitized value"
    );
  });

  test("PinGuard sanitizes its navigation target (defense in depth)", () => {
    const guard = src("app/components/PinGuard.js");
    assert.ok(guard.includes("sanitizeInternalRedirect(requestedTarget"), "PinGuard sanitizes target");
    assert.ok(!/const target\s*=\s*next\s*\|\|/.test(guard), "no raw next target remains");
  });
});
