// WP04-05 L2 — independent evidence verifier (TEST-ONLY).
//
// The verifier is intentionally separate from the scanner/classifier code path.
// It reads raw documents from the disposable database, computes its own counts
// and canonical BSON digests, inventories collections/indexes, and then compares
// those facts with a scanner report and the fixture expectations.
//
// It does not import the classifier, the adapter, or the scanner. Its only
// knowledge of D01–D10 is the frozen fixture plan and the report it is given, so
// a bug in classification cannot silently satisfy verification.
//
// Checks
// ------
//   * collection set, per-collection document counts, total count;
//   * per-collection canonical document digest;
//   * database digest;
//   * index inventory (name/key/unique/sparse/partial filter) per collection;
//   * every D01–D10 rule represented, with the expected sub-code;
//   * manual sample cross-check by order id;
//   * report read-only flags and no recovery-task evidence;
//   * deterministic repeat report;
//   * redaction: no URI, credential value, host, port, or sensitive key.

import { createHash } from "node:crypto";

import { digestCollection, digestDatabaseFromDigests, digestDocument, isSystemCollection } from "./canonicalBsonDigest.mjs";

export const VERIFIER_VERSION = "wp04-05-l2-verifier-v1";

export const REPORT_RULES = Object.freeze([
  "D01",
  "D02",
  "D03",
  "D04",
  "D05",
  "D06",
  "D07",
  "D08",
  "D09",
  "D10",
]);

const RECOVERY_COLLECTIONS = new Set(["inventory_recovery_tasks", "inventory_recovery_events"]);

const REDACTION_PATTERNS = Object.freeze([
  Object.freeze({ code: "URI_LEAK", pattern: /mongodb(\+srv)?:\/\//i }),
  Object.freeze({ code: "HOST_LEAK", pattern: /\b(?:127\.0\.0\.1|localhost|::1|0:0:0:0:0:0:0:1)\b/i }),
  Object.freeze({
    code: "SECRET_KEY_LEAK",
    pattern: /\b(?:password|passwd|credential|secret|token|authorization|connectionstring|mongodburi|accountnumber)\b/i,
  }),
]);

export class VerifierError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "VerifierError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new VerifierError(code, message);
}

function identifierKey(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number") return `n:${value}`;
  if (typeof value === "object" && typeof value.$oid === "string") {
    return `o:${value.$oid.toLowerCase()}`;
  }
  if (typeof value?.toHexString === "function") return `o:${value.toHexString().toLowerCase()}`;
  return `x:${String(value)}`;
}

function normalizeIndex(index) {
  return Object.freeze({
    name: String(index.name),
    key: index.key,
    unique: index.unique === true,
    sparse: index.sparse === true,
    partialFilterExpression: index.partialFilterExpression ?? null,
  });
}

function sortByName(entries) {
  return [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * Read a complete, deterministic snapshot of one databases' user collections.
 *
 * @param {import("mongoose").Connection} connection
 * @param {string} dbName
 */
export async function snapshotDatabase(connection, dbName) {
  if (connection?.db?.databaseName !== dbName) {
    fail("SNAPSHOT_DB_MISMATCH", "snapshot connection is not the disposable database");
  }
  const db = connection.db;
  const infos = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = infos
    .map((info) => info.name)
    .filter((name) => !isSystemCollection(name))
    .sort();

  const collections = [];
  for (const name of names) {
    const collection = db.collection(name);
    const count = await collection.countDocuments({});
    // `promoteValues:false` preserves Int32/Double/Long/Decimal128/Binary
    // wrappers so the digest never collapses distinct BSON types.
    const documents = await collection.find({}, { promoteValues: false }).toArray();
    if (documents.length !== count) {
      fail("SNAPSHOT_UNSTABLE", `collection ${name} changed while it was being read`);
    }
    const indexes = sortByName((await collection.indexes()).map(normalizeIndex));
    collections.push(
      Object.freeze({
        name,
        count,
        documentDigest: digestCollection({ name, documents }),
        indexDigest: digestDocument(indexes),
        indexes: Object.freeze(indexes),
      }),
    );
  }

  const totalDocuments = collections.reduce((total, entry) => total + entry.count, 0);
  const databaseDigest = digestDatabaseFromDigests(
    collections.map((entry) => ({ name: entry.name, digest: entry.documentDigest })),
  );
  const indexInventoryDigest = createHash("sha256")
    .update(JSON.stringify(collections.map((entry) => ({ name: entry.name, indexes: entry.indexes }))))
    .digest("hex");

  return Object.freeze({
    verifier: VERIFIER_VERSION,
    dbName,
    collections: Object.freeze(collections),
    totalDocuments,
    databaseDigest,
    indexInventoryDigest,
  });
}

/**
 * Compare two snapshots and report every divergence.
 *
 * @param {{ dbName: string, collections: Array, totalDocuments: number, databaseDigest: string, indexInventoryDigest: string }} before
 * @param {typeof before} after
 */
export function compareSnapshots(before, after) {
  const violations = [];
  if (before?.dbName !== after?.dbName) {
    violations.push({ code: "DATABASE_IDENTITY_CHANGED", detail: "snapshot database names differ" });
  }
  const beforeMap = new Map((before?.collections ?? []).map((entry) => [entry.name, entry]));
  const afterMap = new Map((after?.collections ?? []).map((entry) => [entry.name, entry]));
  const allNames = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  for (const name of [...allNames].sort()) {
    const left = beforeMap.get(name);
    const right = afterMap.get(name);
    if (!left || !right) {
      violations.push({
        code: "COLLECTION_SET_CHANGED",
        detail: `${name} was ${left ? "removed" : "added"}`,
      });
      continue;
    }
    if (left.count !== right.count) {
      violations.push({ code: "COUNT_CHANGED", detail: `${name}: ${left.count} -> ${right.count}` });
    }
    if (left.documentDigest !== right.documentDigest) {
      violations.push({ code: "DOCUMENT_DIGEST_CHANGED", detail: name });
    }
    if (left.indexDigest !== right.indexDigest) {
      violations.push({ code: "INDEX_SET_CHANGED", detail: name });
    }
  }
  if (before?.totalDocuments !== after?.totalDocuments) {
    violations.push({
      code: "TOTAL_COUNT_CHANGED",
      detail: `${before?.totalDocuments} -> ${after?.totalDocuments}`,
    });
  }
  if (before?.databaseDigest !== after?.databaseDigest) {
    violations.push({ code: "DATABASE_DIGEST_CHANGED", detail: "database digest differs" });
  }
  if (before?.indexInventoryDigest !== after?.indexInventoryDigest) {
    violations.push({ code: "INDEX_INVENTORY_DIGEST_CHANGED", detail: "index inventory digest differs" });
  }
  return Object.freeze({
    ok: violations.length === 0,
    violations: Object.freeze(violations.map((entry) => Object.freeze(entry))),
    countsMatch: !violations.some((entry) => entry.code === "COUNT_CHANGED" || entry.code === "TOTAL_COUNT_CHANGED"),
    digestsMatch: !violations.some((entry) => entry.code === "DOCUMENT_DIGEST_CHANGED"),
    collectionsMatch: !violations.some((entry) => entry.code === "COLLECTION_SET_CHANGED"),
    indexesMatch: !violations.some((entry) => entry.code === "INDEX_SET_CHANGED" || entry.code === "INDEX_INVENTORY_DIGEST_CHANGED"),
  });
}

function collectStrings(value, path, out) {
  if (typeof value === "string") {
    out.push({ path, value });
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${path}[${index}]`, out));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    out.push({ path: `${path}.${key}<key>`, value: key });
    collectStrings(nested, `${path}.${key}`, out);
  }
}

/**
 * @param {unknown} report
 * @param {{ forbiddenStrings?: Array<string> }} [options]
 */
export function redactionViolations(report, options = {}) {
  const strings = [];
  collectStrings(report, "$", strings);
  const forbidden = (options.forbiddenStrings ?? []).filter(
    (entry) => typeof entry === "string" && entry.length > 0,
  );
  const violations = [];
  for (const entry of strings) {
    for (const rule of REDACTION_PATTERNS) {
      if (rule.pattern.test(entry.value)) {
        violations.push({ code: "REDACTION_LEAK", detail: `${rule.code} at ${entry.path}` });
      }
    }
    for (const needle of forbidden) {
      if (entry.value.includes(needle)) {
        violations.push({ code: "REDACTION_LEAK", detail: `forbidden value at ${entry.path}` });
      }
    }
  }
  return Object.freeze(violations.map((entry) => Object.freeze(entry)));
}

function findingsByRule(report) {
  const map = new Map();
  for (const finding of report?.findings ?? []) {
    const list = map.get(finding.rule) ?? [];
    list.push(finding);
    map.set(finding.rule, list);
  }
  return map;
}

/**
 * Verify a completed read-only scan against the pre/post snapshots and the
 * fixture plan.
 *
 * @param {{
 *   before: Object,
 *   after: Object,
 *   report: Object,
 *   repeatReport?: Object|null,
 *   cases: Array,
 *   forbiddenStrings?: Array<string>,
 * }} input
 */
export function verifyReadOnlyScan(input) {
  const { before, after, report, repeatReport = null, cases, forbiddenStrings = [] } = input ?? {};
  const violations = [];

  const comparison = compareSnapshots(before, after);
  violations.push(...comparison.violations);

  if (report?.readOnly !== true) violations.push({ code: "REPORT_NOT_READ_ONLY", detail: "readOnly" });
  if (report?.persisted !== false) violations.push({ code: "REPORT_PERSISTED", detail: "persisted" });
  if (report?.schema === undefined) violations.push({ code: "REPORT_SCHEMA_MISSING", detail: "schema" });
  if (report?.summary?.findings !== (report?.findings ?? []).length) {
    violations.push({ code: "SUMMARY_COUNT_MISMATCH", detail: "summary.findings" });
  }
  for (const finding of report?.findings ?? []) {
    if (finding.autoRecovery !== "PROHIBITED") {
      violations.push({ code: "AUTO_RECOVERY_NOT_PROHIBITED", detail: finding.dedupeKey ?? finding.rule });
    }
    if (finding.createsRecoveryTask !== false) {
      violations.push({ code: "TASK_CREATION_NOT_FALSE", detail: finding.dedupeKey ?? finding.rule });
    }
    if (finding.readOnly !== true) {
      violations.push({ code: "FINDING_NOT_READ_ONLY", detail: finding.dedupeKey ?? finding.rule });
    }
    if (finding.task !== null) {
      violations.push({ code: "FINDING_TASK_PRESENT", detail: finding.dedupeKey ?? finding.rule });
    }
  }

  for (const collection of after?.collections ?? []) {
    if (RECOVERY_COLLECTIONS.has(collection.name)) {
      violations.push({ code: "RECOVERY_COLLECTION_CREATED", detail: collection.name });
    }
  }

  const byRule = findingsByRule(report);
  for (const rule of REPORT_RULES) {
    if (!byRule.has(rule)) violations.push({ code: "MISSING_RULE", detail: rule });
  }
  for (const finding of report?.findings ?? []) {
    if (!REPORT_RULES.includes(finding.rule)) {
      violations.push({ code: "UNKNOWN_RULE_IN_REPORT", detail: String(finding.rule) });
    }
  }

  for (const fixture of cases ?? []) {
    const findings = byRule.get(fixture.rule) ?? [];
    for (const expected of fixture.expected) {
      const matched = findings.some(
        (finding) =>
          finding.code === expected.code &&
          identifierKey(finding.orderId) === identifierKey(fixture.order._id),
      );
      if (!matched) {
        violations.push({
          code: "CLASSIFICATION_MISMATCH",
          detail: `${fixture.rule}/${expected.code}`,
        });
      }
    }
  }

  if (repeatReport !== null) {
    if (JSON.stringify(report) !== JSON.stringify(repeatReport)) {
      violations.push({ code: "NONDETERMINISTIC_REPORT", detail: "two identical runs differ" });
    }
  }

  violations.push(...redactionViolations(report, { forbiddenStrings }));

  const deduped = [];
  const seen = new Set();
  for (const violation of violations) {
    const key = `${violation.code}:${violation.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(Object.freeze({ ...violation }));
  }

  return Object.freeze({
    verifier: VERIFIER_VERSION,
    ok: deduped.length === 0,
    violations: Object.freeze(deduped),
    comparison,
    rulesObserved: Object.freeze([...byRule.keys()].sort()),
  });
}
