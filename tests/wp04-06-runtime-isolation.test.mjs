// WP04-06 R-1 — Runtime isolation checks.
//
// These tests prove the recovery scanner/repositories/CLI are not wired into any
// application route, production runtime module, worker, scheduler, cron, feature
// flag, or Recovery Task persistence path. Checks are source/import-level plus a
// child-process check that help/invalid arguments never reach the driver.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/inventory-recovery-scan.mjs", import.meta.url));
const RECOVERY_FILES = [
  "lib/recovery/scanner.js",
  "lib/recovery/repositories.js",
  "scripts/inventory-recovery-scan.mjs",
];

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function walk(dir, extensions, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, extensions, out);
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      out.push(absolute);
    }
  }
  return out;
}

const IMPORT_RE =
  /(?:import\s+(?:[^"'()]*?\sfrom\s+)?|export\s+[^"']*?\sfrom\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function importSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_RE)) specifiers.push(match[1]);
  return specifiers;
}

function filesUnder(relativeDir) {
  return walk(join(ROOT, relativeDir), [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
}

function importViolations(files, pattern) {
  const violations = [];
  for (const absolute of files) {
    const source = readFileSync(absolute, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (pattern.test(specifier)) {
        violations.push(`${relative(ROOT, absolute).replaceAll("\\", "/")} -> ${specifier}`);
      }
    }
  }
  return violations;
}

describe("WP04-06 R-1 runtime isolation", () => {
  it("has no application route import of the scanner, repositories, or CLI", () => {
    const violations = importViolations(
      filesUnder("app"),
      /recovery\/(scanner|repositories|adapter|classifier|taskWriter|fingerprint|evidence)|inventory-recovery-scan/,
    );
    assert.deepEqual(violations, []);
  });

  it("has no production runtime module import of the scanner or repositories", () => {
    const files = filesUnder("lib").filter(
      (absolute) => !relative(ROOT, absolute).replaceAll("\\", "/").startsWith("lib/recovery/"),
    );
    const violations = importViolations(
      files,
      /recovery\/(scanner|repositories|adapter|classifier|taskWriter|fingerprint|evidence)/,
    );
    assert.deepEqual(violations, []);
  });

  it("does not import taskWriter, RecoveryTask, RecoveryEvent, or a persistence path", () => {
    for (const file of RECOVERY_FILES) {
      const specifiers = importSpecifiers(read(file));
      for (const specifier of specifiers) {
        assert.doesNotMatch(
          specifier,
          /taskWriter|RecoveryTask|RecoveryEvent|models\/|inventory_recovery/,
          `${file} must not import persistence: ${specifier}`,
        );
      }
      const source = read(file);
      assert.equal(source.includes("inventory_recovery_task"), false, `${file} task collection`);
      assert.equal(source.includes("inventory_recovery_event"), false, `${file} event collection`);
    }
  });

  it("adds no worker, scheduler, cron, timer loop, or feature flag", () => {
    for (const file of RECOVERY_FILES) {
      const source = read(file);
      for (const forbidden of [
        "worker_threads",
        "new Worker",
        "node-cron",
        "cron.schedule",
        "setInterval",
        "setTimeout",
        "FEATURE_RECOVERY",
      ]) {
        assert.equal(source.includes(forbidden), false, `${file} must not contain ${forbidden}`);
      }
      assert.doesNotMatch(source, /process\.env\.[A-Z0-9_]*(FLAG|ENABLED)/);
    }
  });

  it("does not import payment, order, Inventory, Hotel, Kitchen, Barista, or Jebena runtime modules", () => {
    for (const file of RECOVERY_FILES) {
      for (const specifier of importSpecifiers(read(file))) {
        assert.doesNotMatch(
          specifier,
          /orderService|inventoryService|inventoryReservationService|models\/|hotel|kitchen|barista|jebena|station/i,
          `${file} must not import runtime module ${specifier}`,
        );
      }
    }
  });

  it("leaves the protected payment, order, Inventory, Hotel, Kitchen, Barista and Jebena modules unimported by recovery code", () => {
    const protectedFiles = [
      "lib/orderService.js",
      "lib/inventoryService.js",
      "lib/inventoryReservationService.js",
      "lib/models/Order.js",
      "lib/models/InventoryItem.js",
      "app/api/orders/route.js",
      "app/api/orders/[id]/route.js",
      "app/hotel",
      "app/jebena",
    ];
    const protectedSources = [];
    for (const entry of protectedFiles) {
      try {
        if (statSync(join(ROOT, entry)).isDirectory()) protectedSources.push(...filesUnder(entry));
        else protectedSources.push(join(ROOT, entry));
      } catch {
        // A path that does not exist in this checkout is skipped; it is not a
        // recovery integration point.
      }
    }
    const violations = importViolations(
      protectedSources,
      /recovery\/(scanner|repositories|adapter|classifier|taskWriter|fingerprint|evidence)|inventory-recovery-scan/,
    );
    assert.deepEqual(violations, []);
  });

  it("never connects to a database for CLI help or invalid arguments", () => {
    const baseEnv = { ...process.env, MONGODB_URI: "mongodb://127.0.0.1:1/app" };
    delete baseEnv.NODE_ENV;
    delete baseEnv.VERCEL_ENV;
    delete baseEnv.DEPLOY_ENV;
    delete baseEnv.ENVIRONMENT;
    delete baseEnv.APP_ENV;
    delete baseEnv.CONTEXT;
    for (const args of [["--help"], ["--since", "2026-11-10T00:00:00.000Z"], ["--write"]]) {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: ROOT,
        env: baseEnv,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.equal(output.includes("Recovery scan failed"), false);
      assert.equal(output.includes("ECONNREFUSED"), false);
    }
  });

  it("inserts the driver import only after argument and authorization gates", () => {
    const source = read("scripts/inventory-recovery-scan.mjs");
    const driverImport = source.indexOf('await import("mongoose")');
    const confirmGate = source.indexOf('if (!hasFlag("--confirm"))');
    const productionGate = source.indexOf("if (isProduction)");
    assert.ok(driverImport > confirmGate, "driver import must follow --confirm validation");
    assert.ok(driverImport > productionGate, "driver import must follow the production gate");
    assert.equal(source.includes("--env-file"), false);
    assert.equal(source.includes(".env.local"), false);
  });
});
