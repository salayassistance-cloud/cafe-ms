// WP04-06 R-1 — Read-only recovery scanner.
//
// Composes the WP04-03 evidence adapter and the D01–D10 classifier into a
// single, bounded, read-only scan. Nothing here writes, persists, fingerprints
// raw documents, creates Recovery Tasks, or starts a worker.
//
// Two-pass design (why it exists):
//   The adapter applies the scan window to orders, reservations AND movements.
//   V1 consumes inventory at PREPARING time (lib/orderService.js) and only
//   falls back to consumption at PAYMENT time. A single-pass windowed read can
//   therefore see a PAID order whose reservation/movements were written before
//   `since`, and D01 would report a false "PAID without deduction".
//
//   Pass 1 discovers candidate orders inside the window (including orders with
//   a live CONSUMING reservation and orphan movements).
//   Pass 2 re-reads exactly those orders with NO time window, so each order is
//   classified against its complete reservation/movement history.
//
//   Correction (R-1): if an order discovered in Pass 1 is absent from Pass 2, the
//   scan NEVER classifies the windowed Pass 1 bundle as a fallback. The order is
//   marked incomplete, its findings are suppressed, and the reason is reported.
//   The two passes remain independent reads: no transaction or snapshot is used,
//   and the report states that limitation instead of claiming consistency.
//
// Governance boundaries (OD-38 / OD-39 / OD-40):
//   * the scanner is read-only and returns a frozen report; it persists nothing;
//   * findings carry createsRecoveryTask:false and autoRecovery:"PROHIBITED";
//   * no Recovery Task is created and no closed task is reopened (no recovery
//     collection is read or written at all);
//   * fingerprints come from the classifier over PROJECTED bundles only;
//   * no worker, scheduler, cron, or feature flag is involved;
//   * D06 remains ALERT_ONLY and its windowed discovery is not exhaustive.

import {
  DEFAULT_LIMITS,
  MAX_LIMITS,
  collectEvidence,
} from "./adapter.js";
import { CLASSIFIER_VERSION, FINDING_SCHEMA_VERSION, classifyBundles } from "./classifier.js";

export const SCANNER_VERSION = "wp04-scanner-v1";
export const SCAN_SCHEMA_VERSION = "wp04-scan-v1";

// The scanner deliberately does not claim read consistency. Pass 1 and Pass 2
// are independent reads against a live repository; no transaction or snapshot
// is held. Missing/truncated evidence fails closed instead of being classified.
export const SCAN_CONSISTENCY = Object.freeze({
  mechanism: "TWO_INDEPENDENT_READ_PASSES",
  snapshot: false,
  transaction: false,
  atomic: false,
  readConcern: null,
  limitation:
    "Discovery and full-history reads are independent, non-transactional reads. " +
    "The scan holds no snapshot, so orders, reservations and movements may change " +
    "between passes. An order missing from the full-history pass is marked " +
    "incomplete and all findings for it are suppressed; detected truncation aborts " +
    "the scan. This is fail-closed detection, not read consistency.",
});

export const D06_COVERAGE = Object.freeze({
  rule: "D06",
  classification: "ALERT_ONLY",
  exhaustive: false,
  discoveryMechanism: "WINDOWED_CONSUMING_RESERVATION_READ",
  absenceMeaning: "NO_STALE_CONSUMING_OBSERVED_IN_SCANNED_WINDOW",
  limitation:
    "D06 discovery reads only CONSUMING reservations whose updatedAt falls inside " +
    "the scan window, plus reservations of orders whose order.updatedAt falls " +
    "inside it. A CONSUMING reservation older than the window whose order is also " +
    "outside the window is not read. Absence of a D06 finding therefore means only " +
    "that no stale CONSUMING state was observed in the scanned window; it does not " +
    "prove that none exists.",
});

export class ScannerError extends Error {
  /**
   * @param {string} code Stable error code.
   * @param {string|null} [field] Offending field.
   * @param {string} [message] Safe message.
   */
  constructor(code, field = null, message = code) {
    super(message);
    this.name = "ScannerError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message) {
  throw new ScannerError(code, field, message || code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeLimit(value, fallback, maximum, field) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("INVALID_LIMIT", field, `${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function normalizeScanOptions(options) {
  if (options === null || options === undefined) options = {};
  if (!isPlainObject(options)) {
    fail("INVALID_OPTIONS", "options", "options must be a plain object");
  }
  if (typeof options.since !== "string" || options.since.length === 0) {
    fail(
      "MISSING_SCAN_WINDOW",
      "options.since",
      "a scan window (since) is required; an unbounded scan is not permitted",
    );
  }
  const limits = Object.freeze({
    maxOrders: normalizeLimit(
      options.maxOrders,
      DEFAULT_LIMITS.maxOrders,
      MAX_LIMITS.maxOrders,
      "options.maxOrders",
    ),
    maxDocsPerOrder: normalizeLimit(
      options.maxDocsPerOrder,
      DEFAULT_LIMITS.maxDocsPerOrder,
      MAX_LIMITS.maxDocsPerOrder,
      "options.maxDocsPerOrder",
    ),
    maxInventoryItems: normalizeLimit(
      options.maxInventoryItems,
      DEFAULT_LIMITS.maxInventoryItems,
      MAX_LIMITS.maxInventoryItems,
      "options.maxInventoryItems",
    ),
    maxOrphanMovements: normalizeLimit(
      options.maxOrphanMovements,
      DEFAULT_LIMITS.maxOrphanMovements,
      MAX_LIMITS.maxOrphanMovements,
      "options.maxOrphanMovements",
    ),
    maxTotalBundles: normalizeLimit(
      options.maxTotalBundles,
      DEFAULT_LIMITS.maxTotalBundles,
      MAX_LIMITS.maxTotalBundles,
      "options.maxTotalBundles",
    ),
  });
  return Object.freeze({
    since: options.since,
    until: options.until ?? null,
    now: options.now ?? null,
    limits,
    maxBundles: options.maxBundles,
    maxFindings: options.maxFindings,
  });
}

function identifierKey(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number") return `n:${value}`;
  if (isPlainObject(value) && typeof value.$oid === "string") {
    return `o:${value.$oid.toLowerCase()}`;
  }
  return `x:${String(value)}`;
}

function orderIdOf(evidence) {
  return evidence?.order?.id ?? null;
}

function isOrphanBundle(bundle) {
  return bundle?.order === null && bundle?.reservation === null;
}

function bundleReferencesOrder(bundle, orderKeys) {
  if (orderKeys.size === 0) return false;
  for (const movement of bundle?.movements ?? []) {
    const refOrderId = movement?.refOrderId;
    if (refOrderId === null || refOrderId === undefined) continue;
    if (orderKeys.has(identifierKey(refOrderId))) return true;
  }
  return false;
}

/**
 * Run a bounded, read-only scan and return a frozen finding report.
 *
 * @param {{ orders: Object, reservations: Object, movements: Object, inventory: Object, indexEvidence?: Object }} repositories
 * @param {{ since: string, until?: string, now?: string, maxOrders?: number, maxDocsPerOrder?: number, maxInventoryItems?: number, maxOrphanMovements?: number, maxTotalBundles?: number, maxBundles?: number, maxFindings?: number }} options
 * @returns {Promise<Readonly<Object>>}
 */
export async function scan(repositories, options = {}) {
  const normalized = normalizeScanOptions(options);
  const { limits } = normalized;

  // Pass 1 — windowed discovery. includeConsuming surfaces D06 candidates that
  // would otherwise be invisible when the order itself is outside the window.
  const discovery = await collectEvidence(repositories, {
    since: normalized.since,
    until: normalized.until,
    ruleScope: "ALL",
    includeConsuming: true,
    includeOrphans: true,
    maxOrders: limits.maxOrders,
    maxDocsPerOrder: limits.maxDocsPerOrder,
    maxInventoryItems: limits.maxInventoryItems,
    maxOrphanMovements: limits.maxOrphanMovements,
    maxTotalBundles: limits.maxTotalBundles,
  });

  const candidateIds = [];
  const seen = new Set();
  for (const bundle of discovery.bundles) {
    const id = orderIdOf(bundle);
    if (id === null) continue;
    const key = identifierKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    candidateIds.push(id);
  }
  const candidateOrphanBundles = discovery.bundles.filter(isOrphanBundle);

  // Pass 2 — full history for the discovered orders, with no time window, so
  // PREPARING-time consumption is not mistaken for a missing deduction.
  let fullHistoryBundles = [];
  if (candidateIds.length > 0) {
    const fullHistory = await collectEvidence(repositories, {
      orderIds: candidateIds,
      maxOrders: limits.maxOrders,
      maxDocsPerOrder: limits.maxDocsPerOrder,
      maxInventoryItems: limits.maxInventoryItems,
      maxOrphanMovements: limits.maxOrphanMovements,
      maxTotalBundles: limits.maxTotalBundles,
    });
    fullHistoryBundles = fullHistory.bundles;
  }

  const covered = new Set();
  for (const bundle of fullHistoryBundles) {
    const id = orderIdOf(bundle);
    if (id !== null) covered.add(identifierKey(id));
  }
  const missing = candidateIds.filter((id) => !covered.has(identifierKey(id)));
  const missingKeys = new Set(missing.map(identifierKey));

  // Correction (R-1): a Pass 1 bundle must NEVER be used as a fallback for an
  // order missing from Pass 2. The discovery bundle only contains the windowed
  // slice of reservation/movement history; classifying it can produce a false
  // D01 "PAID_NO_RESERVATION_NO_DEDUCTION". Missing orders are instead marked
  // incomplete, reported, and excluded from classification entirely.
  const orphanBundles = discovery.bundles
    .filter(isOrphanBundle)
    .filter((bundle) => !bundleReferencesOrder(bundle, missingKeys));

  const bundles = [...fullHistoryBundles, ...orphanBundles];

  const report = classifyBundles(bundles, {
    since: normalized.since,
    until: normalized.until,
    now: normalized.now ?? undefined,
    maxBundles: normalized.maxBundles,
    maxFindings: normalized.maxFindings,
    indexEvidence: discovery.indexEvidence,
  });

  const incompleteEvidence = Object.freeze({
    failClosed: true,
    classificationSuppressed: missing.length > 0,
    missingOrders: missing.length,
    missingOrderIds: Object.freeze([...missing]),
    suppressedOrphanBundles: candidateOrphanBundles.length - orphanBundles.length,
    reason: missing.length > 0 ? "ORDER_MISSING_FROM_FULL_HISTORY_PASS" : null,
  });

  const consistency = Object.freeze({
    ...SCAN_CONSISTENCY,
    complete: missing.length === 0,
    missingOrders: missing.length,
  });

  const discoveryCoverage = Object.freeze({
    d06: Object.freeze({
      ...D06_COVERAGE,
      window: Object.freeze({ since: normalized.since, until: normalized.until ?? null }),
    }),
  });

  return Object.freeze({
    schema: SCAN_SCHEMA_VERSION,
    scanner: SCANNER_VERSION,
    classifier: CLASSIFIER_VERSION,
    findingSchema: FINDING_SCHEMA_VERSION,
    readOnly: true,
    persisted: false,
    generatedAt: report.generatedAt,
    window: report.window,
    consistency,
    discoveryCoverage,
    incompleteEvidence,
    evidence: Object.freeze({
      schema: discovery.schema,
      readOnly: true,
      bounds: discovery.bounds,
      bundleCount: bundles.length,
    }),
    passes: Object.freeze({
      discovery: Object.freeze({
        bundles: discovery.bundles.length,
        orders: candidateIds.length,
        orphanBundles: orphanBundles.length,
      }),
      fullHistory: Object.freeze({
        bundles: fullHistoryBundles.length,
        missingOrders: missing.length,
        missingOrderIds: Object.freeze([...missing]),
        complete: missing.length === 0,
      }),
    }),
    summary: report.summary,
    findings: report.findings,
    deferred: report.deferred,
  });
}

/**
 * Stable description of what the scanner does and does not do. Used by the CLI
 * and tests so the boundary is stated in one place.
 *
 * @returns {Readonly<Object>}
 */
export function describeScan() {
  return Object.freeze({
    scanner: SCANNER_VERSION,
    schema: SCAN_SCHEMA_VERSION,
    readOnly: true,
    persists: false,
    createsRecoveryTasks: false,
    reopensClosedTasks: false,
    fingerprintsRawDocuments: false,
    worker: false,
    scheduler: false,
    featureFlag: null,
    consistency: SCAN_CONSISTENCY,
    d06: D06_COVERAGE,
    d06DiscoveryExhaustive: D06_COVERAGE.exhaustive,
    passConsistencyGuaranteed: false,
    incompleteEvidenceFailsClosed: true,
  });
}
