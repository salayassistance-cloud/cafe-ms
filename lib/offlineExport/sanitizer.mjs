// lib/offlineExport/sanitizer.mjs — offline sanitizer for the BONO sanitized
// real-data export (Phase 2, Step 8). Implements the owner-approved contract
// in docs/inventory-stored-unit-audit-export-spec.md.
//
// STRICTLY OFFLINE. It never connects to a database: input is a directory of
// per-collection NDJSON files of canonical Extended JSON v2 (as produced
// locally by `bsondump` from the owner's own mongodump directory). The HMAC
// key never leaves the local machine and is never written to the manifest or
// any output — only its SHA-256 fingerprint is. On any contract violation the
// export aborts in full: no partial output.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  COLLECTIONS,
  CONTRACT_ERROR_CODES,
  CONTRACT_VERSION,
  ExportContractError,
  KEY_HEX_PATTERN,
  SANITIZER_NAME,
  SPEC_PATH,
  addQtyHex,
  createPseudonymizer,
  parseCanonicalValue,
  serializeRecordLine,
  sha256Hex,
} from "./contract.mjs";
import { EXPORTERS, rawIdString } from "./exporters.mjs";
import {
  buildRequirementFingerprint,
  buildShortageFingerprint,
} from "../inventoryReservationRules.js";

// Strips internal bookkeeping fields the exporters attach for orphan
// resolution / counters; these never reach the export.
const INTERNAL_KEYS = new Set(["rawItemKey", "rawOrderKey", "rawLineKey", "__snapshotCounters"]);

function stripInternal(value) {
  if (Array.isArray(value)) {
    for (const v of value) stripInternal(v);
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  for (const k of Object.keys(value)) {
    if (INTERNAL_KEYS.has(k)) delete value[k];
    else stripInternal(value[k]);
  }
  return value;
}

function readInputCollection(inputDir, collection) {
  const file = join(inputDir, `${collection}.ndjson`);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new ExportContractError(CONTRACT_ERROR_CODES.UNKNOWN_COLLECTION,
      `missing input file ${file}`);
  }
  if (text.startsWith("\uFEFF")) {
    throw new ExportContractError(CONTRACT_ERROR_CODES.INVALID_INPUT_LINE,
      `${collection}.ndjson has a BOM`);
  }
  const docs = [];
  const lines = text.length === 0 ? [] : text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i === lines.length - 1 && line === "") continue; // trailing newline
    if (line.includes("\r")) {
      throw new ExportContractError(CONTRACT_ERROR_CODES.INVALID_INPUT_LINE,
        `${collection}.ndjson line ${i + 1}: CR found (LF-only required)`);
    }
    if (line.trim() === "") {
      throw new ExportContractError(CONTRACT_ERROR_CODES.INVALID_INPUT_LINE,
        `${collection}.ndjson line ${i + 1}: blank line`);
    }
    let json;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new ExportContractError(CONTRACT_ERROR_CODES.INVALID_INPUT_LINE,
        `${collection}.ndjson line ${i + 1}: invalid JSON: ${err.message}`);
    }
    docs.push({ json, line: i + 1 });
  }
  return docs;
}

function makeContext() {
  const unitEntries = new Map(); // `${collection}|${path}` -> buckets
  const drift = new Map(); // `${collection}` -> { unknownBsonTypeCount, unknownBsonTypes, decimal128Count, unexpectedKeys, excludedComponents, nullSnapshots }
  const state = { excludedComponents: 0 };
  const ctx = {
    pseudonymize: null, // injected by the sanitizer
    noteExcludedComponent() {
      state.excludedComponents += 1;
    },
    countUnit(collection, path, bucket) {
      const key = `${collection}|${path}`;
      let buckets = unitEntries.get(key);
      if (!buckets) {
        buckets = { missing: 0, null: 0, string: 0, nonString: 0 };
        unitEntries.set(key, buckets);
      }
      buckets[bucket] += 1;
    },
    countDrift(collection, kind, sub) {
      let d = drift.get(collection);
      if (!d) {
        d = { unknownBsonTypeCount: 0, unknownBsonTypes: {}, decimal128Count: 0 };
        drift.set(collection, d);
      }
      if (kind === "unknownBsonType") {
        d.unknownBsonTypeCount += 1;
        d.unknownBsonTypes[sub] = (d.unknownBsonTypes[sub] ?? 0) + 1;
      } else if (kind === "decimal128") {
        d.decimal128Count += 1;
      } else if (kind === "unitStoredTypeNonString") {
        d.unitStoredTypeNonString = (d.unitStoredTypeNonString ?? 0) + 1;
      }
    },
  };
  return { ctx, unitEntries, drift, state };
}

// Numeric helper for §3 fingerprint rows (verbatim stored values, converted to
// Number only where the runtime would see a number; non-numeric drift becomes
// undefined and is filtered out by the fingerprint function itself).
function qtyNumber(node) {
  if (!node) return undefined;
  if (node.t === "double") return node.special ? NaN : node.n;
  if (node.t === "int32") return node.n;
  if (node.t === "int64") return Number(node.s);
  if (node.t === "decimal128") return Number(node.s);
  return undefined;
}

function fingerprintRows(reservationDoc, exporterItems) {
  // Rows are built from the STORED items verbatim (real ids, real unit text,
  // no pre-rounding/sorting — the rules module does its own canonicalization).
  const itemsNode = (reservationDoc.e ?? []).find(([k]) => k === "items");
  const items = itemsNode && itemsNode[1].t === "arr" ? itemsNode[1].e : [];
  return items.map((it) => {
    const e = it.t === "doc" ? it.e : [];
    const find = (k) => e.find(([k2]) => k2 === k)?.[1];
    const idNode = find("inventoryItemId");
    const unitNode = find("unit");
    return {
      inventoryItemId: idNode ? rawIdString(idNode) : "",
      unit: unitNode && unitNode.t === "str" ? unitNode.s : undefined,
      requiredQuantity: qtyNumber(find("requiredQuantity") ?? find("quantity")),
      availableAtDecision: qtyNumber(find("availableAtDecision")),
      shortageQuantity: qtyNumber(find("shortageQuantity")),
    };
  });
}

export function sanitizeExport({
  docsByCollection,
  keyHex,
  timestamp,
  environmentLabel = "",
  corroboration = null,
}) {
  if (typeof keyHex !== "string" || !KEY_HEX_PATTERN.test(keyHex)) {
    throw new ExportContractError(CONTRACT_ERROR_CODES.INVALID_KEY,
      "key must be 64 hex characters (32 bytes)");
  }
  const { ctx, unitEntries, drift, state } = makeContext();
  const pseudo = createPseudonymizer(keyHex);
  ctx.pseudonymize = pseudo.pseudonymize;

  const records = {}; // collection -> [{ record, rawRowId, meta }]
  const rawRowIds = {}; // collection -> Set of raw row ids (duplicate detection)

  for (const collection of COLLECTIONS) {
    const docs = docsByCollection[collection] ?? [];
    rawRowIds[collection] = new Set();
    records[collection] = [];
    for (let docIndex = 0; docIndex < docs.length; docIndex += 1) {
      const supplied = docs[docIndex];
      const { json, line } = supplied && typeof supplied === "object" &&
          "json" in supplied && "line" in supplied
        ? supplied
        : { json: supplied, line: docIndex + 1 };
      const parsed = parseCanonicalValue(json, `${collection}.ndjson:${line}`);
      if (parsed.t !== "doc") {
        throw new ExportContractError(CONTRACT_ERROR_CODES.INVALID_INPUT_LINE,
          `${collection}.ndjson line ${line}: input document must be an object`);
      }
      const idNode = (parsed.e ?? []).find(([k]) => k === "_id")?.[1];
      const rawRowId = idNode && (idNode.t === "oid" || idNode.t === "str")
        ? (idNode.t === "oid" ? `oid:${idNode.hex}` : `str:${idNode.s}`)
        : null;
      if (rawRowId !== null) {
        if (rawRowIds[collection].has(rawRowId)) {
          throw new ExportContractError(CONTRACT_ERROR_CODES.DUPLICATE_ROW_ID,
            `${collection}: duplicate document _id in dump input`);
        }
        rawRowIds[collection].add(rawRowId);
      }
      const record = EXPORTERS[collection](parsed, ctx);
      records[collection].push({
        record,
        rawRowId,
        meta: collectMeta(collection, record, parsed),
      });
    }
  }

  // Aggregate Mixed-snapshot drift counters before internal fields are stripped.
  for (const entry of records.inventoryaudits ?? []) {
    const counters = entry.record.__snapshotCounters;
    if (!counters) continue;
    let d = drift.get("inventoryaudits");
    if (!d) {
      d = { unknownBsonTypeCount: 0, unknownBsonTypes: {}, decimal128Count: 0 };
      drift.set("inventoryaudits", d);
    }
    d.unexpectedKeys = d.unexpectedKeys ?? new Map();
    for (const [path, count] of counters.unexpected) {
      d.unexpectedKeys.set(path, (d.unexpectedKeys.get(path) ?? 0) + count);
    }
    d.nullSnapshots = (d.nullSnapshots ?? 0) + counters.nullSnapshots;
    d.snapshotUnitCount = (d.snapshotUnitCount ?? 0) + counters.snapshotUnits;
  }

  // Orphan resolution (§7.2): references must resolve to exported identities.
  const exportedItems = new Set(
    (records.inventoryitems ?? []).map((r) => r.rawRowId).filter(Boolean)
  );
  const exportedOrders = new Set(
    (records.orders ?? []).map((r) => r.rawRowId).filter(Boolean)
  );
  const exportedLines = new Set();
  for (const o of records.orders ?? []) {
    for (const lk of o.meta.lineKeys) exportedLines.add(lk.rawKey);
  }
  const orphanCounts = {}; // `${collection}|${path}` -> count
  for (const collection of COLLECTIONS) {
    for (const entry of records[collection]) {
      const refs = entry.meta.itemRefs ?? [];
      const orphanRefs = [];
      for (const ref of refs) {
        if (!exportedItems.has(ref.rawKey)) orphanRefs.push(ref.path);
      }
      if (collection !== "orders" && entry.meta.orderKey &&
          !exportedOrders.has(entry.meta.orderKey)) {
        orphanRefs.push("orderId");
      }
      for (const lk of entry.meta.lineKeys ?? []) {
        if (lk.rawKey && !exportedLines.has(lk.rawKey)) orphanRefs.push(lk.path);
      }
      if (orphanRefs.length > 0) {
        entry.record.orphan = true;
        entry.record.orphanRefs = [...new Set(orphanRefs)];
        for (const p of entry.record.orphanRefs) {
          const key = `${collection}|${p}`;
          orphanCounts[key] = (orphanCounts[key] ?? 0) + 1;
        }
      }
    }
  }

  // §3 derived fingerprints: computed on real ids BEFORE pseudonymization.
  for (const entry of records.inventoryreservations ?? []) {
    const rows = fingerprintRows(entry.meta.sourceDoc);
    const orderIdNode = (entry.meta.sourceDoc.e ?? []).find(([k]) => k === "orderId")?.[1];
    const realOrderId = orderIdNode ? rawIdString(orderIdNode) : "";
    const requirement = buildRequirementFingerprint(realOrderId, rows);
    entry.record.recomputedRequirementFingerprint = requirement;
    entry.record.recomputedShortageFingerprint =
      buildShortageFingerprint(requirement, rows);
  }

  // §7.5 deterministic ordering by primary pseudonym.
  const bundle = {};
  for (const collection of COLLECTIONS) {
    const entries = records[collection].map((entry) => {
      stripInternal(entry.record);
      addQtyHex(entry.record, collection);
      return entry;
    });
    entries.sort((a, b) => compareSortKeys(a.record, b.record, collection));
    const lines = entries.map((entry) => serializeRecordLine(entry.record, collection));
    const text = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    bundle[collection] = { text, documentsWritten: entries.length };
  }

  // Manifest (§7.1).
  const manifest = {
    spec: SPEC_PATH,
    contractVersion: CONTRACT_VERSION,
    sanitizer: { name: SANITIZER_NAME, version: CONTRACT_VERSION },
    exportedAt: timestamp ?? new Date().toISOString(),
    environmentLabel,
    collectionFilter: "all documents, no filter",
    inputFormat: "canonical Extended JSON v2 NDJSON (bsondump), offline",
    pseudonymKeyFingerprint: pseudo.keyFingerprint,
    namespaces: pseudo.namespaceStats(),
    collections: {},
  };
  for (const collection of COLLECTIONS) {
    const docsRead = (docsByCollection[collection] ?? []).length;
    const d = drift.get(collection) ?? {
      unknownBsonTypeCount: 0, unknownBsonTypes: {}, decimal128Count: 0,
    };
    manifest.collections[collection] = {
      file: `${collection}.ndjson`,
      sha256: bundle[collection].text === "" ? sha256Hex(Buffer.alloc(0)) : sha256Hex(Buffer.from(bundle[collection].text, "utf8")),
      documentsRead: docsRead,
      documentsWritten: bundle[collection].documentsWritten,
      unitEntries: unitEntriesFor(unitEntries, collection),
      drift: {
        unknownBsonTypeCount: d.unknownBsonTypeCount,
        unknownBsonTypes: d.unknownBsonTypes,
        decimal128Count: d.decimal128Count,
        decimal128HexCount: 0, // Extended JSON carries no Decimal128 bytes
        unitStoredTypeCount: unitStoredTypeTotals(unitEntries, collection),
        unexpectedKeyCount: unexpectedFor(unitEntries, collection, d),
        excludedComponentsCount: collection === "orders" ? state.excludedComponents : undefined,
        nullSnapshotCount: collection === "inventoryaudits" ? nullSnapshots(d) : undefined,
      },
      orphans: orphanEntries(orphanCounts, collection),
    };
  }
  if (corroboration !== null) {
    if (corroboration === null || typeof corroboration !== "object" || Array.isArray(corroboration)) {
      throw new ExportContractError(CONTRACT_ERROR_CODES.INVALID_INPUT_LINE,
        "corroboration must be a JSON object");
    }
    manifest.corroboration = corroboration;
  }

  return { bundle, manifest };
}

function createPseudo(keyHex) {
  // Local import to avoid a top-level cycle: contract exports the factory.
  return createPseudonymizerImpl(keyHex);
}

import { createPseudonymizer as createPseudonymizerImpl } from "./contract.mjs";

function collectMeta(collection, record, sourceDoc) {
  const meta = { itemRefs: [], lineKeys: [], orderKey: null };
  const itemField = collection === "stockmovements" || collection === "inventoryaudits"
    ? "item"
    : "inventoryItemId";
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      const at = path ? `${path}.${k}` : k;
      if (k === "rawItemKey" && typeof v === "string") {
        meta.itemRefs.push({ rawKey: v, path: cleanPath(at, itemField) });
      } else if (k === "rawOrderKey" && typeof v === "string") {
        meta.orderKey = v;
      } else if (k === "rawLineKey" && typeof v === "string") {
        meta.lineKeys.push({ rawKey: v, path: cleanPath(at, "lineId") });
      } else {
        walk(v, at);
      }
    }
  };
  walk(record, "");
  if (collection === "inventoryreservations") meta.sourceDoc = sourceDoc;
  return meta;
}

function cleanPath(path, field) {
  // "items[0].rawItemKey" belongs to the field "<field>" of the array element.
  let p = path
    .replace(/(^|\.)rawItemKey$/, `$1${field}`)
    .replace(/(^|\.)rawOrderKey$/, "$1orderId")
    .replace(/(^|\.)rawLineKey$/, "$1lineId");
  return p.replace(/\[\d+\]/g, "[]");
}

function compareSortKeys(a, b, collection) {
  const ka = sortKey(a, collection);
  const kb = sortKey(b, collection);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// §7.5 primary sort key: the row-identity pseudonym where the matrix exports
// _id; otherwise a deterministic content key (documented elaboration).
function sortKey(record, collection) {
  if (record._id !== undefined) return record._id;
  return `${record.item ?? ""}|${JSON.stringify(record)}`;
}

function unitEntriesFor(unitEntries, collection) {
  const out = {};
  for (const [key, buckets] of unitEntries) {
    const [collectionName, path] = key.split("|");
    if (collectionName !== collection) continue;
    out[path] = { ...buckets };
  }
  return out;
}

function unitStoredTypeTotals(unitEntries, collection) {
  const totals = { missing: 0, null: 0, string: 0, nonString: 0 };
  for (const [key, buckets] of unitEntries) {
    const [collectionName] = key.split("|");
    if (collectionName !== collection) continue;
    for (const bucket of Object.keys(totals)) totals[bucket] += buckets[bucket];
  }
  return totals;
}

function unexpectedFor(unitEntries, collection, d) {
  void unitEntries;
  return d.unexpectedKeys
    ? Object.fromEntries([...d.unexpectedKeys.entries()].sort())
    : {};
}

function nullSnapshots(d) {
  return d.nullSnapshots ?? 0;
}

function orphanEntries(orphanCounts, collection) {
  const out = {};
  for (const [key, count] of Object.entries(orphanCounts)) {
    const [collectionName, path] = key.split("|");
    if (collectionName === collection) out[path] = count;
  }
  return out;
}

export function writeBundle(outputDir, bundle, manifest) {
  mkdirSync(outputDir, { recursive: true });
  for (const collection of COLLECTIONS) {
    writeFileSync(join(outputDir, `${collection}.ndjson`), bundle[collection].text, "utf8");
  }
  writeFileSync(join(outputDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function runSanitizer({
  inputDir,
  outputDir,
  keyHex,
  environmentLabel = "",
  timestamp,
  corroborationPath,
}) {
  const inputRoot = resolve(inputDir);
  const present = new Set(readdirSync(inputRoot).filter((f) => statSync(join(inputRoot, f)).isFile()));
  const docsByCollection = {};
  for (const collection of COLLECTIONS) {
    if (!present.has(`${collection}.ndjson`)) {
      throw new ExportContractError(CONTRACT_ERROR_CODES.UNKNOWN_COLLECTION,
        `missing input file ${collection}.ndjson in ${inputRoot}`);
    }
  }
  for (const f of present) {
    const name = f.replace(/\.ndjson$/, "");
    if (f.endsWith(".ndjson") && !COLLECTIONS.includes(name)) {
      throw new ExportContractError(CONTRACT_ERROR_CODES.UNKNOWN_COLLECTION,
        `unknown input collection file ${f}`);
    }
    if (!f.endsWith(".ndjson") && f !== "manifest.json") {
      throw new ExportContractError(CONTRACT_ERROR_CODES.UNKNOWN_COLLECTION,
        `unexpected input file ${f}`);
    }
  }
  const { bundle, manifest } = sanitizeExport({
    docsByCollection: Object.fromEntries(COLLECTIONS.map((c) => [c, readInputCollection(inputRoot, c)])),
    keyHex,
    timestamp,
    environmentLabel,
    corroboration: corroborationPath
      ? JSON.parse(readFileSync(resolve(corroborationPath), "utf8"))
      : null,
  });
  writeBundle(outputDir, bundle, manifest);
  return manifest;
}

// CLI entry point (no DB access in any code path).
function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const inputDir = get("--input");
  const outputDir = get("--output");
  const keyHex = get("--key");
  let keyFromFile = get("--key-file");
  if (keyFromFile) keyHex = readFileSync(resolve(keyFromFile), "utf8").trim();
  const environmentLabel = get("--environment-label") ?? "";
  const timestamp = get("--timestamp");
  const corroborationPath = get("--corroboration");
  if (!inputDir || !outputDir || !keyHex) {
    console.error(
      "usage: node lib/offlineExport/sanitizer.mjs --input <dir> --output <dir> " +
      "--key <64-hex> [--key-file <path>] [--environment-label <label>] " +
      "[--timestamp <iso>] [--corroboration <json>]"
    );
    process.exit(2);
  }
  try {
    const manifest = runSanitizer({ inputDir, outputDir, keyHex, environmentLabel, timestamp, corroborationPath });
    console.log(`export written to ${resolve(outputDir)}`);
    for (const collection of COLLECTIONS) {
      const c = manifest.collections[collection];
      console.log(`  ${collection}: ${c.documentsWritten} records, sha256 ${c.sha256.slice(0, 16)}…`);
    }
    console.log(`key fingerprint: ${manifest.pseudonymKeyFingerprint}`);
  } catch (err) {
    if (err instanceof ExportContractError) {
      console.error(`EXPORT ABORTED (${err.code}): ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
