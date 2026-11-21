// Regression protection for the final pre-deployment remediation batch.
//
// These are DB-free source-contract tests (the same style used across the
// suite) that pin the security/correctness invariants fixed in this pass:
//   1. verify-pin never keeps a plaintext PIN as a derived-cache Map key;
//   2. report caching cannot leak one endpoint's annotations into another;
//   3. station roles cannot widen their order listing by omitting `dest`;
//   4. a manager's direct SERVED→PAID settlement must name a payment method.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

describe("verify-pin derived cache key", () => {
  test("uses an HMAC digest and never the raw PIN in the Map key", () => {
    const route = src("app/api/auth/verify-pin/route.js");
    assert.ok(route.includes('createHmac("sha256", DERIVED_CACHE_SALT)'), "HMAC key derivation present");
    assert.ok(route.includes("DERIVED_CACHE_SALT"), "process-local salt present");
    assert.ok(!route.includes("`${storedHash}:${p}`"), "plaintext PIN is not a cache key");
    assert.ok(!/staffDerivedCache\.set\([^,]*pin[^,]*,/i.test(route), "no PIN-keyed cache write");
  });
});

describe("report cache isolation", () => {
  test("getReport returns a copy on cache hits", () => {
    const service = src("lib/reportService.js");
    assert.ok(service.includes("return { ...hit.data };"), "cache hit returns a shallow copy");
  });

  test("analytics annotates a copy, not the shared cached report", () => {
    const route = src("app/api/manager/analytics/route.js");
    assert.ok(route.includes("const responseReport = {"), "response copy created");
    assert.ok(route.includes("return ok(responseReport, 200)"), "copy is returned");
    assert.ok(!route.includes("report.completedItemsDetail ="), "cached object is not mutated");
  });
});

describe("station order listing authority", () => {
  test("station roles derive the item-type filter from the live role", () => {
    const route = src("app/api/orders/route.js");
    assert.ok(route.includes('import { stationForRole, STATION_ITEM_TYPE } from "@/lib/stationStatus"'), "station helpers imported");
    assert.ok(route.includes("const station = stationForRole(role);"), "station derived from role");
    assert.ok(route.includes('query["items"] = { $elemMatch: { type, cancelled: { $ne: true } } };'), "server overrides client dest");
  });
});

describe("manager direct settlement requires a payment method", () => {
  test("both PAID routes reject a method-less SERVED settlement", () => {
    const patch = src("app/api/orders/[id]/route.js");
    const status = src("app/api/orders/[id]/status/route.js");
    const message = "paymentMethod is required to settle a served order";
    assert.ok(patch.includes(message), "PATCH route guard present");
    assert.ok(status.includes(message), "status alias route guard present");
  });
});
