// lib/offlineExport/validator.mjs — independent offline validator for the
// BONO sanitized export bundle (Phase 2, Step 8).
//
// STRICTLY OFFLINE, DB-free. It verifies the bundle itself (files, bytes,
// digests, manifest) against the approved contract in
// docs/inventory-stored-unit-audit-export-spec.md. It never trusts the
// sanitizer's success: every check is re-derived from the bundle. Fail-closed:
// ANY violation rejects the entire bundle (exit 1); a partially valid bundle
// is never accepted.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ALLOWED_KEYS,
  COLLECTIONS,
  CONTRACT_VERSION,
  NAMESPACES,
  PSEUDONYM_PATTERN,
  QTY_HEX_PATTERN,
  SHA256_PATTERN,
  canonicalize,
  readFloat64Hex,
  sha256Hex,
} from "./contract.mjs";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

// Identity field -> namespace map (per collection, per context path).
const IDENTITY_FIELDS = {
  inventoryitems: [["", "_id", "item"]],
  recipes: [["", "_id", "recipe"], ["ingredients[]", "inventoryItemId", "item"]],
  stockmovements: [["", "item", "item"]],
  inventoryaudits: [["", "item", "item"]],
  inventoryreservations: [
    ["", "_id", "reservation"],
    ["", "orderId", "order"],
    ["items[]", "inventoryItemId", "item"],
    ["approval.shortages[]", "inventoryItemId", "item"],
    ["voids[]", "lineId", "orderline"],
    ["voids[].items[]", "inventoryItemId", "item"],
  ],
  orders: [
    ["", "_id", "order"],
    ["items[orders]", "lineId", "orderline"],
    ["items[orders].components[]", "componentId", "component"],
    ["items[orders].components[]", "inventoryItemId", "item"],
  ],
};

const FINGERPRINT_FIELDS = new Set([
  "requirementFingerprint",
  "recomputedRequirementFingerprint",
  "shortageFingerprint",
  "recomputedShortageFingerprint",
]);

export function validateBundle(bundleDir) {
  const violations = [];
  const add = (code, message) => violations.push({ code, message });

  // 1. File inventory (fail-closed: exact set).
  let files;
  try {
    files = readdirSync(bundleDir).filter((f) => statSync(join(bundleDir, f)).isFile());
  } catch (err) {
    add("BUNDLE_UNREADABLE", `cannot read bundle directory: ${err.message}`);
    return { ok: false, violations };
  }
  const expected = [...COLLECTIONS.map((c) => `${c}.ndjson`), "manifest.json"];
  for (const f of files) {
    if (!expected.includes(f)) add("UNEXPECTED_FILE", `unexpected file in bundle: ${f}`);
  }
  for (const f of expected) {
    if (!files.includes(f)) add("MISSING_FILE", `missing bundle file: ${f}`);
  }
  if (violations.length > 0) {
    return { ok: false, violations };
  }

  // 2. Manifest structural completeness.
  let manifest;
  const manifestBytes = readFileSync(join(bundleDir, "manifest.json"));
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (err) {
    add("MANIFEST_INVALID_JSON", `manifest.json is not valid JSON: ${err.message}`);
    return { ok: false, violations };
  }
  for (const key of ["spec", "contractVersion", "sanitizer", "exportedAt", "environmentLabel",
    "collectionFilter", "pseudonymKeyFingerprint", "namespaces", "collections"]) {
    if (!(key in manifest)) add("MANIFEST_INCOMPLETE", `manifest missing field: ${key}`);
  }
  if (manifest.contractVersion !== CONTRACT_VERSION) {
    add("MANIFEST_CONTRACT_VERSION", `manifest contractVersion ${manifest.contractVersion} != ${CONTRACT_VERSION}`);
  }
  if (typeof manifest.pseudonymKeyFingerprint !== "string" ||
      !SHA256_PATTERN.test(manifest.pseudonymKeyFingerprint)) {
    add("MANIFEST_KEY_FINGERPRINT", "pseudonymKeyFingerprint missing or not sha256 hex");
  }
  if (manifest.collectionFilter !== "all documents, no filter") {
    add("MANIFEST_COLLECTION_FILTER", "collectionFilter must state 'all documents, no filter'");
  }
  const manifestNamespaces = manifest.namespaces ?? {};
  for (const ns of NAMESPACES) {
    const entry = manifestNamespaces[ns];
    if (!entry || typeof entry.distinctRawCount !== "number" ||
        typeof entry.distinctPseudonymCount !== "number") {
      add("MANIFEST_NAMESPACES", `manifest namespaces.${ns} missing counts`);
      continue;
    }
    // §2.5 injectivity criterion, re-asserted from the manifest.
    if (entry.distinctRawCount !== entry.distinctPseudonymCount) {
      add("NAMESPACE_NOT_INJECTIVE",
        `namespaces.${ns}: distinctRawCount ${entry.distinctRawCount} != distinctPseudonymCount ${entry.distinctPseudonymCount}`);
    }
  }

  // 3. Per-file validation.
  const bundle = {};
  const observedNamespacePseudonyms = Object.fromEntries(NAMESPACES.map((ns) => [ns, new Set()]));
  const exportedItems = new Set();
  const exportedOrders = new Set();
  const exportedLines = new Set();
  const allOrphanRefs = [];

  for (const collection of COLLECTIONS) {
    validateCollectionFile(collection);
  }

  // 4. Cross-collection pseudonym/orphan checks (only when no fatal
  // per-file violations already prevent record parsing).
  if (violations.length === 0) {
    crossChecks();
  }

  return { ok: violations.length === 0, violations };

  // ------------------------------------------------------------------

  function validateCollectionFile(collection) {
    const mc = (manifest.collections ?? {})[collection];
    if (!mc || typeof mc !== "object") {
      add("MANIFEST_COLLECTION", `manifest.collections.${collection} missing`);
      return;
    }
    const file = join(bundleDir, `${collection}.ndjson`);
    const bytes = readFileSync(file);
    const text = bytes.toString("utf8");

    // Digest + encoding.
    const digest = sha256Hex(bytes);
    if (mc.sha256 !== digest) {
      add("DIGEST_MISMATCH",
        `${collection}.ndjson digest ${digest} != manifest ${mc.sha256}`);
    }
    if (bytes.length > 0 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      add("BOM", `${collection}.ndjson has a UTF-8 BOM`);
    }
    if (text.includes("\r")) add("CRLF", `${collection}.ndjson contains CR (LF-only required)`);
    if (text.length > 0 && !text.endsWith("\n")) {
      add("TRAILING_NEWLINE", `${collection}.ndjson must end with a trailing LF`);
    }

    // Records. Parsed results are kept line-aligned; failed lines are null
    // (INVALID_JSON is recorded and the bundle is rejected — never a crash).
    const lines = text.length === 0
      ? []
      : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    const records = [];
    for (let i = 0; i < lines.length; i += 1) {
      let rec = null;
      try {
        rec = JSON.parse(lines[i]);
      } catch (err) {
        add("INVALID_JSON", `${collection}.ndjson line ${i + 1}: invalid JSON: ${err.message}`);
      }
      records.push(rec);
    }
    if (typeof mc.documentsWritten !== "number" || mc.documentsWritten !== records.length) {
      add("COUNT_MISMATCH",
        `${collection}: documentsWritten ${mc.documentsWritten} != actual records ${records.length}`);
    }
    if (typeof mc.documentsRead !== "number" || mc.documentsRead !== mc.documentsWritten) {
      add("DOCUMENTS_READ_MISMATCH",
        `${collection}: documentsRead ${mc.documentsRead} != documentsWritten ${mc.documentsWritten}`);
    }

    // Whitelist key scan, tag validation, unit vocabulary, identities.
    for (let i = 0; i < records.length; i += 1) {
      const rec = records[i];
      checkRecord(rec, collection, i + 1, add, observedNamespacePseudonyms,
        allOrphanRefs, exportedItems, exportedOrders, exportedLines);
      // Byte-stable canonical serialization: re-serialize and compare. A line
      // that failed JSON parsing above cannot be canonicalized — the
      // INVALID_JSON violation is already recorded; never crash here.
      if (rec !== undefined) {
        const canonical = canonicalize(rec, collection);
        if (JSON.stringify(canonical) !== lines[i]) {
          add("NON_CANONICAL_SERIALIZATION",
            `${collection}.ndjson line ${i + 1}: not byte-identical to canonical serialization`);
        }
      }
      // qtyHex <-> number bits consistency.
      checkQtyHex(rec, collection, i + 1, add);
    }
    checkSorted(records, collection, add);
    checkUnitVocabulary(records, mc, collection, add);
    checkDriftManifest(records, mc, collection, add);
  }

  function crossChecks() {
    // Pseudonym namespace counts from observed data.
    for (const ns of NAMESPACES) {
      const entry = (manifest.namespaces ?? {})[ns];
      if (!entry) continue;
      const observed = observedNamespacePseudonyms[ns].size;
      if (observed !== entry.distinctPseudonymCount) {
        add("NAMESPACE_COUNT_MISMATCH",
          `namespace ${ns}: observed distinct pseudonyms ${observed} != manifest ${entry.distinctPseudonymCount}`);
      }
    }
    // Global pseudonym uniqueness across namespaces (sum of per-ns distinct
    // sets equals the union — no pseudonym may be reused across namespaces).
    const union = new Set();
    for (const ns of NAMESPACES) {
      for (const p of observedNamespacePseudonyms[ns]) union.add(p);
    }
    const sum = NAMESPACES.reduce((acc, ns) => acc + observedNamespacePseudonyms[ns].size, 0);
    if (union.size !== sum) {
      add("CROSS_NAMESPACE_REUSE",
        `pseudonyms reused across namespaces (union ${union.size} != sum ${sum})`);
    }
    // Orphan recomputation and flag consistency.
    const expectedByRecord = new Map(); // record -> Set of paths
    const orphanCounts = {};
    for (const ref of allOrphanRefs) {
      let orphaned = false;
      if (ref.kind === "item") orphaned = !exportedItems.has(ref.rawKey);
      else if (ref.kind === "order") orphaned = !exportedOrders.has(ref.rawKey);
      else if (ref.kind === "line") orphaned = !exportedLines.has(ref.rawKey);
      if (orphaned) {
        const key = `${ref.collection}|${ref.path}`;
        orphanCounts[key] = (orphanCounts[key] ?? 0) + 1;
        let set = expectedByRecord.get(ref.record);
        if (!set) {
          set = new Set();
          expectedByRecord.set(ref.record, set);
        }
        set.add(ref.path);
      }
    }
    for (const [record, expectedPaths] of expectedByRecord) {
      const ref = allOrphanRefs.find((r) => r.record === record);
      if (record.orphan !== true) {
        add("ORPHAN_FLAG", `${ref.collection}: record with unresolvable ${[...expectedPaths].join(", ")} lacks orphan: true`);
      } else {
        const declared = new Set(record.orphanRefs ?? []);
        for (const p of expectedPaths) {
          if (!declared.has(p)) {
            add("ORPHAN_REFS", `orphanRefs missing expected path "${p}"`);
          }
        }
      }
    }
    for (const ref of allOrphanRefs) {
      if (ref.record.orphan !== true && ref.record.orphanRefs !== undefined) {
        add("ORPHAN_REFS", `${ref.collection}: orphanRefs present without orphan flag`);
      }
    }
    for (const collection of COLLECTIONS) {
      const expectedOrphans = {};
      for (const [key, count] of Object.entries(orphanCounts)) {
        const [c, path] = key.split("|");
        if (c === collection) expectedOrphans[path] = count;
      }
      const manifestOrphans = manifest.collections[collection].orphans ?? {};
      const manifestPaths = Object.keys(manifestOrphans);
      const expectedPaths = Object.keys(expectedOrphans);
      for (const p of new Set([...manifestPaths, ...expectedPaths])) {
        if ((manifestOrphans[p] ?? 0) !== (expectedOrphans[p] ?? 0)) {
          add("ORPHAN_COUNT_MISMATCH",
            `${collection}: orphan count for ${p}: manifest ${manifestOrphans[p] ?? 0} != recomputed ${expectedOrphans[p] ?? 0}`);
        }
      }
    }
  }
}

// Walk a record and verify the whitelist of keys, §4 tags, unit vocabulary,
// identity fields, and orphan bookkeeping for one record.
function checkRecord(rec, collection, lineNo, add, observedNs, orphanRefs, exportedItems, exportedOrders, exportedLines) {
  const identityPaths = IDENTITY_FIELDS[collection] ?? [];

  function walkObject(value, context, path) {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walkObject(v, childContext(context), `${path}[${i}]`));
      return;
    }    if (value === null || typeof value !== "object") return;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0].startsWith("$")) return; // §4 tagged leaf
    const allowed = ALLOWED_KEYS[context];
    if (!allowed) {
      add("WHITELIST_CONTEXT", `${collection} line ${lineNo}: unknown context ${context} at ${path}`);
      return;
    }
    for (const k of keys) {
      if (!allowed.has(k)) {
        add("EXCLUDED_KEY_PRESENT",
          `${collection} line ${lineNo}: non-contract key "${k}" at ${path}${path ? "." : ""}${k}`);
      }
    }
    // Identity fields at this context (ctxPath "" denotes the record root).
    for (const [ctxPath, field, ns] of identityPaths) {
      const matches = ctxPath === "" ? context === collection : ctxPath === context;
      if (!matches || !(field in value)) continue;
      const v = value[field];
      if (v === null || v === undefined) continue;
      if (typeof v !== "string" || !PSEUDONYM_PATTERN.test(v)) {
        add("PSEUDONYM_FORMAT", `${collection} line ${lineNo}: ${path}${path ? "." : ""}${field} is not a 24-hex pseudonym`);
        continue;
      }
      observedNs[ns].add(v);
      if (context === "inventoryitems" && field === "_id") exportedItems.add(v);
      if (collection === "orders") {
        if (field === "_id") exportedOrders.add(v);
        if (field === "lineId" && v) exportedLines.add(v);
      }
      if (ns === "item" && field !== "_id") {
        orphanRefs.push({ collection, kind: "item", rawKey: v, path: refPath(path, field), record: rec });
      }
      if (ns === "order" && field === "orderId") {
        orphanRefs.push({ collection, kind: "order", rawKey: v, path: "orderId", record: rec });
      }
      if (ns === "orderline" && field === "lineId" && collection !== "orders" && v) {
        orphanRefs.push({ collection, kind: "line", rawKey: v, path: refPath(path, field), record: rec });
      }
    }
    // Fingerprint fields must be 64-hex strings.
    for (const k of keys) {
      if (FINGERPRINT_FIELDS.has(k)) {
        const v = value[k];
        if (typeof v !== "string" || !SHA256_PATTERN.test(v)) {
          add("FINGERPRINT_FORMAT", `${collection} line ${lineNo}: ${k} is not a 64-hex sha256 string`);
        }
      }
    }
    // Orphan flag consistency.
    if ("orphan" in value) {
      if (value.orphan !== true || !Array.isArray(value.orphanRefs) || value.orphanRefs.length === 0) {
        add("ORPHAN_FLAG", `${collection} line ${lineNo}: orphan flag present but malformed at ${path}`);
      }
    }
    // Recurse into known child contexts.
    for (const k of keys) {
      const child = childContextOf(context, k);
      if (child) walkObject(value[k], child, path ? `${path}.${k}` : k);
    }
  }

  walkObject(rec, collection, "", null);
}

function refPath(path, field) {
  const normalized = path.replace(/\[\d+\]/g, "[]");
  return normalized ? `${normalized}.${field}` : field;
}

function childContextOf(context, key) {
  if (context === "inventoryreservations") {
    if (key === "items") return "items[]";
    if (key === "approval") return "approval";
    if (key === "voids") return "voids[]";
  }
  if (context === "approval" && key === "shortages") return "approval.shortages[]";
  if (context === "voids[]" && key === "items") return "voids[].items[]";
  if (context === "recipes" && key === "ingredients") return "ingredients[]";
  if (context === "orders" && key === "items") return "items[orders]";
  if (context === "items[orders]" && key === "components") return "items[orders].components[]";
  if (context === "inventoryaudits" && (key === "beforeSnapshot" || key === "afterSnapshot")) {
    return "snapshotLeaf";
  }
  return null;
}

function childContext(context) {
  // Array elements inherit the element context for the parent context name.
  const map = {
    "items[]": "items[]",
    "approval.shortages[]": "approval.shortages[]",
    "voids[]": "voids[]",
    "voids[].items[]": "voids[].items[]",
    "ingredients[]": "ingredients[]",
    "items[orders]": "items[orders]",
    "items[orders].components[]": "items[orders].components[]",
    snapshotLeaf: "snapshotLeaf",
  };
  return map[context] ?? context;
}

function checkQtyHex(rec, collection, lineNo, add) {
  function walk(value, path) {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0].startsWith("$")) return;
    const numbers = keys.filter((k) => typeof value[k] === "number" && Number.isFinite(value[k]));
    const hexMap = value.qtyHex;
    if (numbers.length > 0) {
      if (!hexMap || typeof hexMap !== "object") {
        add("QTY_HEX_MISSING", `${collection} line ${lineNo}: doubles at ${path} have no qtyHex map`);
      } else {
        for (const k of numbers) {
          const hex = hexMap[k];
          if (typeof hex !== "string" || !QTY_HEX_PATTERN.test(hex)) {
            add("QTY_HEX_FORMAT", `${collection} line ${lineNo}: qtyHex["${k}"] at ${path} is not 16-hex`);
            continue;
          }
          const bits = readFloat64Hex(hex);
          const num = value[k];
          const same = Object.is(bits, num) || (bits === 0 && num === 0);
          if (!same) {
            add("QTY_HEX_BITS", `${collection} line ${lineNo}: qtyHex["${k}"] at ${path} does not match the number's IEEE-754 bits`);
          }
        }
      }
    } else if (hexMap !== undefined && Object.keys(hexMap).length > 0) {
      add("QTY_HEX_EXTRA", `${collection} line ${lineNo}: qtyHex present at ${path} with no double fields`);
    }
    for (const k of keys) {
      if (k !== "qtyHex" && !k.startsWith("$")) walk(value[k], path ? `${path}.${k}` : k);
    }
  }
  walk(rec, "");
}

function checkSorted(records, collection, add) {
  // Unparseable lines (null) already produced INVALID_JSON; skip them here.
  const valid = records.filter((r) => r !== null);
  const keyOf = (record) =>
    record._id !== undefined ? record._id : `${record.item ?? ""}|${JSON.stringify(record)}`;
  for (let i = 1; i < valid.length; i += 1) {
    const a = keyOf(valid[i - 1]);
    const b = keyOf(valid[i]);
    if (a > b) {
      add("SORT_ORDER", `${collection}: records not in ascending primary-key order at line ${i + 1}`);
    }
  }
  const ids = new Set();
  for (const r of valid) {
    if (r._id !== undefined) {
      if (ids.has(r._id)) add("DUPLICATE_PRIMARY", `${collection}: duplicate primary pseudonym ${r._id}`);
      ids.add(r._id);
    }
  }
}

function checkUnitVocabulary(records, mc, collection, add) {
  const VALID_STORED = new Set(["missing", "null", "string", "nonString"]);
  const observed = {}; // path -> buckets
  function walk(value, context, path) {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, childContext(context), `${path}[${i}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    if ("unitStoredType" in value) {
      const t = value.unitStoredType;
      const unitKey = context === "snapshotLeaf"
        ? "value"
        : "stockUnit" in value ? "stockUnit" : "unit";
      let bucket;
      if (t === "string") {
        const v = value[unitKey];
        if (typeof v !== "string" || !("unitState" in value) ||
            !["value", "empty", "whitespace"].includes(value.unitState)) {
          add("UNIT_VOCABULARY", `${collection}: invalid string unit entry at ${path}`);
        } else {
          // Vocabulary consistency (§5): empty/whitespace states must match content.
          const s = v;
          const expected = s.length === 0 ? "empty" : /^\s+$/u.test(s) ? "whitespace" : "value";
          if (expected !== value.unitState) {
            add("UNIT_STATE_MISMATCH", `${collection}: unitState ${value.unitState} != content-derived ${expected} at ${path}`);
          }
        }
        bucket = "string";
      } else if (t === "null") {
        if (value[unitKey] !== null) {
          add("UNIT_VOCABULARY", `${collection}: unitStoredType null but value not null at ${path}`);
        }
        bucket = "null";
      } else if (t === "missing") {
        if (unitKey !== "value" && unitKey in value) {
          add("UNIT_VOCABULARY", `${collection}: unitStoredType missing but unit key present at ${path}`);
        }
        bucket = "missing";
      } else if (t.startsWith("nonString:")) {
        bucket = "nonString";
      } else {
        add("UNIT_VOCABULARY", `${collection}: unknown unitStoredType "${t}" at ${path}`);
        bucket = "nonString";
      }
      const p = context === "snapshotLeaf"
        ? (path.replace(/\[\d+\]/g, "[]").replace(/\[\]$/, "") || "(root)")
        : ((path ? `${path}.${unitKey}` : unitKey).replace(/\[\d+\]/g, "[]"));
      observed[p] = observed[p] ?? { missing: 0, null: 0, string: 0, nonString: 0 };
      observed[p][bucket] += 1;
    }
    for (const k of Object.keys(value)) {
      const child = childContextOf(context, k);
      if (child) walk(value[k], child, path ? `${path}.${k}` : k);
    }
  }
  for (const rec of records) walk(rec, collection, "");

  const manifestEntries = mc.unitEntries ?? {};
  const paths = new Set([...Object.keys(observed), ...Object.keys(manifestEntries)]);
  for (const p of paths) {
    const m = manifestEntries[p] ?? { missing: 0, null: 0, string: 0, nonString: 0 };
    const o = observed[p] ?? { missing: 0, null: 0, string: 0, nonString: 0 };
    for (const bucket of ["missing", "null", "string", "nonString"]) {
      if ((m[bucket] ?? 0) !== o[bucket]) {
        add("UNIT_COUNT_MISMATCH",
          `${collection}: unitEntries[${p}].${bucket}: manifest ${m[bucket] ?? 0} != observed ${o[bucket]}`);
      }
    }
  }
  // Aggregate totals (L2).
  const totals = { missing: 0, null: 0, string: 0, nonString: 0 };
  for (const o of Object.values(observed)) {
    for (const bucket of Object.keys(totals)) totals[bucket] += o[bucket];
  }
  const manifestTotals = (mc.drift ?? {}).unitStoredTypeCount;
  if (!manifestTotals) {
    add("MANIFEST_DRIFT", `${collection}: drift.unitStoredTypeCount missing`);
  } else {
    for (const bucket of Object.keys(totals)) {
      if ((manifestTotals[bucket] ?? 0) !== totals[bucket]) {
        add("UNIT_TOTAL_MISMATCH",
          `${collection}: unitStoredTypeCount.${bucket}: manifest ${manifestTotals[bucket] ?? 0} != observed ${totals[bucket]}`);
      }
    }
  }
}

function checkDriftManifest(records, mc, collection, add) {
  const drift = mc.drift ?? {};
  for (const key of ["unknownBsonTypeCount", "decimal128Count", "unitStoredTypeCount"]) {
    if (!(key in drift)) add("MANIFEST_DRIFT", `${collection}: drift.${key} missing`);
  }
  const declaredUnknown = drift.unknownBsonTypes ?? {};
  // Verify unknownBsonType tag occurrences against the records.
  let observedUnknown = 0;
  const observedByType = {};
  function walk(value) {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$unknownBsonType") {
      observedUnknown += 1;
      const code = String(value.$unknownBsonType);
      observedByType[code] = (observedByType[code] ?? 0) + 1;
      return;
    }
    for (const k of keys) walk(value[k]);
  }
  for (const rec of records) walk(rec);
  if (observedUnknown !== (drift.unknownBsonTypeCount ?? -1)) {
    add("DRIFT_COUNT_MISMATCH",
      `${collection}: unknownBsonTypeCount manifest ${drift.unknownBsonTypeCount} != observed ${observedUnknown}`);
  }
  for (const code of new Set([...Object.keys(declaredUnknown), ...Object.keys(observedByType)])) {
    if ((declaredUnknown[code] ?? 0) !== (observedByType[code] ?? 0)) {
      add("DRIFT_COUNT_MISMATCH",
        `${collection}: unknownBsonTypes["${code}"] manifest ${declaredUnknown[code] ?? 0} != observed ${observedByType[code] ?? 0}`);
    }
  }
}

// CLI entry point (no DB access in any code path).
function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const bundleDir = get("--bundle");
  if (!bundleDir) {
    console.error("usage: node lib/offlineExport/validator.mjs --bundle <dir>");
    process.exit(2);
  }
  const result = validateBundle(resolve(bundleDir));
  if (result.ok) {
    console.log("BUNDLE ACCEPTED — all contract checks passed.");
    process.exit(0);
  }
  console.error(`BUNDLE REJECTED — ${result.violations.length} violation(s):`);
  for (const v of result.violations) console.error(`  [${v.code}] ${v.message}`);
  process.exit(1);
}

  if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
