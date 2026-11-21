#!/usr/bin/env node
// WP04-06 R-1 — Guarded manual recovery scan (READ-ONLY).
//
// This command reads V1 order/reservation/movement/inventory state and prints
// D01–D10 findings. It never writes, never creates a Recovery Task, never
// deploys an index, and never starts a worker or scheduler.
//
// Usage:
//   MONGODB_URI=... node scripts/inventory-recovery-scan.mjs --since 2026-11-01T00:00:00.000Z --confirm
//   MONGODB_URI=... node scripts/inventory-recovery-scan.mjs --since ... --until ... --confirm --format json
//
// Safety:
//   * MONGODB_URI must already be exported in the process environment. This
//     command never loads an environment file and never prints the URI, its
//     credentials, or its host.
//   * A remote/unknown/SRV/malformed target is refused unless --allow-remote is
//     explicitly supplied. Only positively identified loopback targets are
//     treated as local.
//   * Production runs additionally require --allow-production and a non-empty
//     RECOVERY_SCAN_APPROVAL change/ticket reference (checked, never printed).
//
// Exit codes: 0 = scan completed; 1 = refused/failed; 3 = --fail-on-findings
// and at least one CRITICAL/HIGH finding was emitted.

import { createDriverCollectionRepository } from "../lib/recovery/repositories.js";
import { describeScan, scan } from "../lib/recovery/scanner.js";

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);

const KNOWN_FLAGS = new Set([
  "--confirm",
  "--allow-production",
  "--allow-remote",
  "--fail-on-findings",
  "--format",
  "--since",
  "--until",
  "--max-orders",
  "--max-docs-per-order",
  "--max-inventory-items",
  "--help",
  "-h",
]);

const VALUE_FLAGS = new Set([
  "--format",
  "--since",
  "--until",
  "--max-orders",
  "--max-docs-per-order",
  "--max-inventory-items",
]);

function readFlagValue(flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return null;
  return value;
}

function usage() {
  return [
    "Usage: MONGODB_URI=... node scripts/inventory-recovery-scan.mjs --since <ISO-8601 UTC> --confirm [options]",
    "",
    "Read-only D01–D10 recovery scan. No writes, no task creation, no indexes.",
    "",
    "Required:",
    "  --since <iso>              scan window start (ISO-8601 UTC, ms + Z)",
    "  --confirm                  acknowledge that this is a read-only operator action",
    "",
    "Optional:",
    "  --until <iso>              scan window end",
    "  --max-orders <n>           candidate order ceiling (default 200)",
    "  --max-docs-per-order <n>   per-order document ceiling",
    "  --max-inventory-items <n>  inventory document ceiling",
    "  --format <summary|json>    output format (default summary)",
    "  --fail-on-findings         exit 3 when CRITICAL/HIGH findings are present",
    "  --allow-remote             allow a remote/unknown/SRV database target",
    "  --allow-production         required when a production environment is detected",
    "  --help, -h                 show this text",
    "",
    "Environment: MONGODB_URI (never printed; no environment file is loaded).",
  ].join("\n");
}

function fail(message) {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

function parseCount(flag) {
  const raw = readFlagValue(flag);
  if (raw === null) return undefined;
  if (!/^[0-9]+$/.test(raw)) fail(`${flag} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) fail(`${flag} must be a positive integer.`);
  return value;
}

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function readIso(flag) {
  const raw = readFlagValue(flag);
  if (raw === null) return null;
  if (!ISO_UTC_RE.test(raw) || Number.isNaN(new Date(raw).getTime())) {
    fail(`${flag} must be an ISO-8601 UTC timestamp with milliseconds and Z.`);
  }
  if (new Date(raw).toISOString() !== raw) {
    fail(`${flag} must be a valid ISO-8601 UTC timestamp.`);
  }
  return raw;
}

function isLoopbackIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

function isLoopbackIpv6(host) {
  if (host === "::1") return true;
  if (host === "0:0:0:0:0:0:0:1") return true;
  return host.startsWith("::ffff:127.");
}

/**
 * Classify a MongoDB URI without exposing it. Only a positively identified
 * loopback target is local. Everything else (including SRV, multi-host,
 * malformed, unsupported scheme and non-loopback hosts) is remote/unknown.
 *
 * @param {string|undefined} raw
 * @returns {Readonly<{ kind: "local"|"remote"|"unknown", reason: string }>}
 */
function classifyMongoTarget(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return Object.freeze({ kind: "unknown", reason: "MISSING_URI" });
  }
  if (/\s/.test(raw)) {
    return Object.freeze({ kind: "unknown", reason: "AMBIGUOUS_URI" });
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return Object.freeze({ kind: "unknown", reason: "MALFORMED_URI" });
  }

  if (parsed.protocol === "mongodb+srv:") {
    return Object.freeze({ kind: "unknown", reason: "SRV_TARGET" });
  }
  if (parsed.protocol !== "mongodb:") {
    return Object.freeze({ kind: "unknown", reason: "UNSUPPORTED_SCHEME" });
  }

  const schemeIndex = raw.indexOf("://");
  if (schemeIndex === -1) {
    return Object.freeze({ kind: "unknown", reason: "MALFORMED_URI" });
  }
  const authority = raw.slice(schemeIndex + 3).split(/[/?#]/, 1)[0];
  if (authority.includes(",")) {
    return Object.freeze({ kind: "unknown", reason: "MULTIPLE_HOSTS" });
  }
  const atIndex = authority.lastIndexOf("@");
  const hostPort = atIndex === -1 ? authority : authority.slice(atIndex + 1);
  if (hostPort.length === 0) {
    return Object.freeze({ kind: "unknown", reason: "MISSING_HOST" });
  }
  if (/^(%2f|\/)/i.test(hostPort)) {
    return Object.freeze({ kind: "unknown", reason: "UNIX_SOCKET_TARGET" });
  }

  const hostname = String(parsed.hostname || "")
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  if (hostname.length === 0) {
    return Object.freeze({ kind: "unknown", reason: "MISSING_HOST" });
  }
  if (hostname === "localhost") {
    return Object.freeze({ kind: "local", reason: "LOCALHOST" });
  }
  if (isLoopbackIpv4(hostname)) {
    return Object.freeze({ kind: "local", reason: "LOOPBACK_IPV4" });
  }
  if (isLoopbackIpv6(hostname)) {
    return Object.freeze({ kind: "local", reason: "LOOPBACK_IPV6" });
  }
  return Object.freeze({ kind: "remote", reason: "NON_LOOPBACK_HOST" });
}

// Reject anything we do not understand, including any flag that looks like it
// could ask for a write ("--apply", "--fix", "--write", "--deploy", ...).
// All argument validation happens before any database module is imported.
for (const arg of argv) {
  if (!arg.startsWith("-")) continue;
  if (!KNOWN_FLAGS.has(arg)) {
    fail(`Unknown option ${arg}. This command is read-only and accepts no write flags.

${usage()}`);
  }
}

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(usage());
  process.exit(0);
}

for (const flag of VALUE_FLAGS) {
  if (!hasFlag(flag)) continue;
  if (readFlagValue(flag) === null) fail(`${flag} requires a value.`);
}

if (!hasFlag("--confirm")) {
  fail("Refusing to run without --confirm. No database operation was performed.");
}

const since = readIso("--since");
if (since === null) {
  fail("Refusing to run without --since. An unbounded scan is not permitted.");
}
const until = readIso("--until");
if (until !== null && since > until) {
  fail("--until must not precede --since.");
}
const format = readFlagValue("--format") ?? "summary";
if (format !== "summary" && format !== "json") {
  fail("--format must be either summary or json.");
}

const maxOrders = parseCount("--max-orders");
const maxDocsPerOrder = parseCount("--max-docs-per-order");
const maxInventoryItems = parseCount("--max-inventory-items");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  fail(
    "MONGODB_URI is not set. Export it in the process environment; this command does not load environment files. No database operation was performed.",
  );
}

// Target authorization runs before the production gate. --allow-remote never
// bypasses production authorization; both gates must pass independently.
const target = classifyMongoTarget(MONGODB_URI);
if (target.kind !== "local" && !hasFlag("--allow-remote")) {
  fail(
    `Remote/unknown database target refused (${target.reason}). Supply --allow-remote only after explicit operator authorization. No database operation was performed.`,
  );
}

const productionMarkers = ["NODE_ENV", "VERCEL_ENV", "CONTEXT", "DEPLOY_ENV", "ENVIRONMENT", "APP_ENV"];
const isProduction = productionMarkers.some((key) =>
  ["production", "prod", "live"].includes(String(process.env[key] || "").trim().toLowerCase()),
);
if (isProduction) {
  if (!hasFlag("--allow-production")) {
    fail(
      "Production target refused without --allow-production. No database operation was performed.",
    );
  }
  if (!String(process.env.RECOVERY_SCAN_APPROVAL || "").trim()) {
    fail(
      "Production target refused without a non-empty RECOVERY_SCAN_APPROVAL change/ticket reference. No database operation was performed.",
    );
  }
}

// Import the driver only after every gate and argument check has passed, so
// --help and invalid invocations cannot open (or even initialize) a connection.
const mongoose = (await import("mongoose")).default;
const connection = mongoose.createConnection(MONGODB_URI, {
  bufferCommands: false,
  // Never create collections or indexes from this process.
  autoIndex: false,
  autoCreate: false,
  maxPoolSize: 2,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 60000,
  connectTimeoutMS: 10000,
});

let exitCode = 0;
try {
  await connection.asPromise();
  const db = connection.db;
  const ObjectId = mongoose.Types.ObjectId;

  // Raw driver handles. Only `find` is reachable through the factory; the
  // returned repositories expose nothing but findBounded.
  const repositories = {
    orders: createDriverCollectionRepository({
      name: "orders",
      collection: db.collection("orders"),
      ObjectId,
    }),
    reservations: createDriverCollectionRepository({
      name: "inventoryreservations",
      collection: db.collection("inventoryreservations"),
      ObjectId,
    }),
    movements: createDriverCollectionRepository({
      name: "stockmovements",
      collection: db.collection("stockmovements"),
      ObjectId,
    }),
    inventory: createDriverCollectionRepository({
      name: "inventoryitems",
      collection: db.collection("inventoryitems"),
      ObjectId,
    }),
  };

  const report = await scan(repositories, {
    since,
    until: until ?? undefined,
    maxOrders,
    maxDocsPerOrder,
    maxInventoryItems,
  });

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const boundary = describeScan();
    console.log(`WP04-06 recovery scan — ${report.scanner} (read-only)`);
    console.log(`Window: ${report.window.since} .. ${report.window.until ?? "(open)"}`);
    console.log(
      `Orders scanned: ${report.summary.ordersScanned} | bundles: ${report.evidence.bundleCount} | findings: ${report.summary.findings}`,
    );
    console.log(
      `Discovery pass: ${report.passes.discovery.orders} orders / ${report.passes.discovery.bundles} bundles / ${report.passes.discovery.orphanBundles} orphan bundles`,
    );
    console.log(
      `Full-history pass: ${report.passes.fullHistory.bundles} bundles / ${report.passes.fullHistory.missingOrders} missing/incomplete (findings suppressed)`,
    );
    console.log(`By severity: ${JSON.stringify(report.summary.bySeverity)}`);
    console.log(`By rule: ${JSON.stringify(report.summary.byRule)}`);
    console.log(`By classification: ${JSON.stringify(report.summary.byClassification)}`);
    if (report.deferred.length > 0) {
      console.log(`Deferred (insufficient evidence): ${report.deferred.length}`);
    }
    for (const finding of report.findings) {
      console.log(
        `  [${finding.severity}] ${finding.rule}/${finding.code} order=${finding.orderNumber ?? finding.orderId ?? "n/a"} task=${String(finding.createsRecoveryTask)}`,
      );
    }
    console.log(
      "D06 coverage: ALERT_ONLY and windowed only; absence of a D06 finding does not prove that no stale CONSUMING state exists.",
    );
    console.log(
      `Consistency: snapshot=${String(boundary.consistency.snapshot)} transaction=${String(boundary.consistency.transaction)}; missing/incomplete orders are suppressed.`,
    );
    console.log(
      `Boundary: persisted=${String(boundary.persists)} tasks=${String(boundary.createsRecoveryTasks)} worker=${String(boundary.worker)} flag=${String(boundary.featureFlag)}`,
    );
  }

  if (hasFlag("--fail-on-findings")) {
    const blocking = report.findings.filter(
      (finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH",
    );
    if (blocking.length > 0) exitCode = 3;
  }
} catch (error) {
  // Never echo driver messages: a connection error can contain the host or URI.
  const name = error?.name ?? "Error";
  const code = typeof error?.code === "string" && error.code.length > 0 ? ` [${error.code}]` : "";
  console.error(`Recovery scan failed: ${name}${code}. Details suppressed to avoid leaking target information.`);
  exitCode = 1;
} finally {
  try {
    await connection.close();
  } catch {
    // Closing a failed connection must not mask the original error.
  }
}

process.exit(exitCode);
