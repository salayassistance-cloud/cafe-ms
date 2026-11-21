// WP04-06 R-1 — CLI boundary tests.
//
// Every case runs the real CLI in a child process with a controlled environment.
// No test supplies a reachable database: the cases that pass the argument and
// target gates stop at the independent production gate before any driver import.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/inventory-recovery-scan.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const SINCE = "2026-11-10T00:00:00.000Z";
const UNTIL = "2026-11-11T00:00:00.000Z";
const LOCAL_URI = "mongodb://127.0.0.1:1/local";
const REMOTE_URI = "mongodb://alice:supersecret@db.secret.invalid:27017/app";

const BASE_ENV = { ...process.env };
for (const key of [
  "MONGODB_URI",
  "NODE_ENV",
  "VERCEL_ENV",
  "CONTEXT",
  "DEPLOY_ENV",
  "ENVIRONMENT",
  "APP_ENV",
  "RECOVERY_SCAN_APPROVAL",
]) {
  delete BASE_ENV[key];
}

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...BASE_ENV, ...env },
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function assertNoLeak(output) {
  for (const secret of [
    "supersecret",
    "alice",
    "db.secret.invalid",
    "mongodb://",
    "127.0.0.1:27017",
  ]) {
    assert.equal(output.includes(secret), false, `output must not leak ${secret}`);
  }
}

describe("WP04-06 R-1 scan CLI argument safety", () => {
  it("prints help without a database or environment file and exits 0", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.output, /Usage:/);
    assert.match(result.output, /--allow-remote/);
    assert.match(result.output, /--confirm/);
    assert.equal(result.output.includes("--env-file"), false);
    assert.equal(result.output.includes(".env.local"), false);
    assert.equal(result.output.includes("Recovery scan failed"), false);
  });

  it("requires --since and --confirm before any database operation", () => {
    const missingSince = run(["--confirm"], { MONGODB_URI: LOCAL_URI });
    assert.equal(missingSince.status, 1);
    assert.match(missingSince.stderr, /--since/);
    assert.equal(missingSince.output.includes("Recovery scan failed"), false);

    const missingConfirm = run(["--since", SINCE], { MONGODB_URI: LOCAL_URI });
    assert.equal(missingConfirm.status, 1);
    assert.match(missingConfirm.stderr, /--confirm/);
    assert.equal(missingConfirm.output.includes("Recovery scan failed"), false);
  });

  it("rejects unknown and write-like flags before any database operation", () => {
    for (const flag of ["--apply", "--fix", "--write", "--deploy", "--repair", "--force"]) {
      const result = run(["--since", SINCE, "--confirm", flag], { MONGODB_URI: LOCAL_URI });
      assert.equal(result.status, 1, `${flag} must be refused`);
      assert.match(result.stderr, /Unknown option/);
      assert.equal(result.output.includes("Recovery scan failed"), false);
    }
    const helpWithWrite = run(["--help", "--write"], { MONGODB_URI: LOCAL_URI });
    assert.equal(helpWithWrite.status, 1);
    assert.match(helpWithWrite.stderr, /Unknown option/);
    assert.equal(helpWithWrite.output.includes("Recovery scan failed"), false);
  });

  it("validates --since/--until/--format and missing values before connecting", () => {
    for (const args of [
      ["--since", "2026-11-10", "--confirm"],
      ["--since", SINCE, "--until", "2026-11-09T00:00:00.000Z", "--confirm"],
      ["--since", SINCE, "--confirm", "--format", "xml"],
      ["--since", SINCE, "--confirm", "--format"],
      ["--since", SINCE, "--confirm", "--max-orders", "0"],
    ]) {
      const result = run(args, { MONGODB_URI: LOCAL_URI });
      assert.equal(result.status, 1);
      assert.equal(result.output.includes("Recovery scan failed"), false);
    }
  });

  it("requires MONGODB_URI in the process environment and never loads env files", () => {
    const result = run(["--since", SINCE, "--confirm"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MONGODB_URI is not set/);
    assert.match(result.stderr, /does not load environment files/);
    assert.equal(result.output.includes("--env-file"), false);
    assert.equal(result.output.includes(".env.local"), false);
    assert.equal(result.output.includes("Recovery scan failed"), false);
  });
});

describe("WP04-06 R-1 scan CLI target and production authorization", () => {
  it("positively identifies loopback targets and leaves remote authorization untouched", () => {
    for (const uri of [
      "mongodb://127.0.0.1:1/app",
      "mongodb://localhost:1/app",
      "mongodb://[::1]:1/app",
    ]) {
      const result = run(["--since", SINCE, "--confirm"], {
        MONGODB_URI: uri,
        NODE_ENV: "production",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Production target refused without --allow-production/);
      assert.equal(result.output.includes("Remote/unknown database target refused"), false);
    }
  });

  it("refuses a remote target without --allow-remote and never leaks the URI", () => {
    const result = run(["--since", SINCE, "--confirm"], { MONGODB_URI: REMOTE_URI });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Remote\/unknown database target refused/);
    assert.equal(result.output.includes("Recovery scan failed"), false);
    assertNoLeak(result.output);
  });

  it("passes the remote gate only with --allow-remote, then still enforces production", () => {
    const result = run(["--since", SINCE, "--confirm", "--allow-remote"], {
      MONGODB_URI: REMOTE_URI,
      NODE_ENV: "production",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production target refused without --allow-production/);
    assert.equal(result.output.includes("Remote/unknown database target refused"), false);
    assert.equal(result.output.includes("Recovery scan failed"), false);
    assertNoLeak(result.output);
  });

  it("enforces production authorization independently of --allow-remote and --allow-production", () => {
    const noProductionFlag = run(["--since", SINCE, "--confirm"], {
      MONGODB_URI: LOCAL_URI,
      NODE_ENV: "production",
    });
    assert.equal(noProductionFlag.status, 1);
    assert.match(noProductionFlag.stderr, /--allow-production/);

    const noApproval = run(["--since", SINCE, "--confirm", "--allow-production"], {
      MONGODB_URI: LOCAL_URI,
      NODE_ENV: "production",
    });
    assert.equal(noApproval.status, 1);
    assert.match(noApproval.stderr, /RECOVERY_SCAN_APPROVAL/);
    assert.equal(noApproval.output.includes("Recovery scan failed"), false);
  });

  it("fails closed for malformed, unknown, SRV, multi-host and ambiguous targets", () => {
    for (const uri of [
      "not-a-uri",
      "mongodb+srv://cluster.invalid/app",
      "mongodb://127.0.0.1:1,127.0.0.1:2/app",
      "mongodb:///app",
      "https://127.0.0.1/app",
      "mongodb://local host/app",
    ]) {
      const result = run(["--since", SINCE, "--confirm"], { MONGODB_URI: uri });
      assert.equal(result.status, 1, `${uri} must fail closed`);
      assert.match(result.stderr, /Remote\/unknown database target refused/);
      assert.equal(result.output.includes("Recovery scan failed"), false);
    }
  });

  it("does not print credentials or hostnames for any refusal path", () => {
    for (const args of [
      ["--since", SINCE, "--confirm"],
      ["--since", SINCE, "--confirm", "--allow-remote"],
      ["--since", SINCE, "--confirm", "--format"],
    ]) {
      const result = run(args, { MONGODB_URI: REMOTE_URI, NODE_ENV: "production" });
      assertNoLeak(result.output);
    }
  });

  it("never connects for help or invalid arguments", () => {
    for (const args of [["--help"], ["--since", SINCE], ["--bogus"]]) {
      const result = run(args, { MONGODB_URI: LOCAL_URI });
      assert.equal(result.output.includes("Recovery scan failed"), false);
      assert.equal(result.output.includes("ECONNREFUSED"), false);
    }
  });
});
