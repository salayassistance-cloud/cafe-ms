// lib/offlineExport/contract.mjs — shared pure contract for the BONO
// offline sanitized export pipeline (Phase 2, Step 8).
//
// DB-free by construction: imports only node:crypto. No mongoose/mongodb
// import, no environment file or secret access, no network, no side effects.
//
// Implements the owner-approved contract in
// docs/inventory-stored-unit-audit-export-spec.md (Step 7 corrected):
//   §2 pseudonymization + collisions, §4 type-preserving serialization,
//   §5 raw unit vocabulary, §7.5 deterministic NDJSON serialization.
// The per-collection field-matrix exporters live in exporters.mjs.

import crypto from "node:crypto";

export const CONTRACT_VERSION = "1.0.0";
export const SPEC_PATH = "docs/inventory-stored-unit-audit-export-spec.md";
export const SANITIZER_NAME = "bono-offline-sanitizer";
export const VALIDATOR_NAME = "bono-offline-validator";

export const COLLECTIONS = Object.freeze([
  "inventoryitems",
  "recipes",
  "stockmovements",
  "inventoryaudits",
  "inventoryreservations",
  "orders",
]);

export const NAMESPACES = Object.freeze([
  "item",
  "order",
  "orderline",
  "component",
  "recipe",
  "reservation",
]);

export const PSEUDONYM_PATTERN = /^[0-9a-f]{24}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const QTY_HEX_PATTERN = /^[0-9a-f]{16}$/;
export const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const INTEGER_PATTERN = /^-?\d+$/;
export const OID_PATTERN = /^[0-9a-fA-F]{24}$/;

export class ExportContractError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ExportContractError";
    this.code = code;
    this.details = details ?? null;
  }
}

export const CONTRACT_ERROR_CODES = {
  INVALID_KEY: "INVALID_KEY",
  UNKNOWN_COLLECTION: "UNKNOWN_COLLECTION",
  INVALID_INPUT_LINE: "INVALID_INPUT_LINE",
  NON_CANONICAL_NUMBER: "NON_CANONICAL_NUMBER",
  INVALID_ID_TYPE: "INVALID_ID_TYPE",
  DUPLICATE_ROW_ID: "DUPLICATE_ROW_ID",
  PSEUDONYM_COLLISION: "PSEUDONYM_COLLISION",
  BUNDLE_REJECTED: "BUNDLE_REJECTED",
};

// ---------------------------------------------------------------------------
// §2 Pseudonymization (HMAC-SHA256, namespaces, fail-closed collisions)
// ---------------------------------------------------------------------------

// L3: HMAC input serialization. The message is the UTF-8 bytes of
// "<namespace>|oid|<24 lowercase hex>" for ObjectIds and
// "<namespace>|str|<exact stored string>" for string ids (drift only).
// Any other stored type at an id position fails closed.
export function hmacMessage(namespace, idNode) {
  if (!NAMESPACES.includes(namespace)) {
    throw new ExportContractError("INVALID_ID_TYPE", `unknown namespace ${namespace}`);
  }
  if (idNode.t === "oid") return `${namespace}|oid|${idNode.hex}`;
  if (idNode.t === "str") return `${namespace}|str|${idNode.s}`;
  throw new ExportContractError(
    "INVALID_ID_TYPE",
    `id at a pseudonymized position must be an ObjectId or string (got ${idNode.t})`
  );
}

// The collision policy of §2.5, factored out so tests (and the validator's
// documentation) exercise the exact logic used by the sanitizer.
// Returns true when (namespace, rawKey) is already mapped to this pseudonym;
// throws ExportContractError(PSEUDONYM_COLLISION) on any collision.
export function collisionCheck(maps, used, namespace, rawKey, pseudo) {
  const map = maps.get(namespace);
  const existing = map ? map.get(rawKey) : undefined;
  if (existing !== undefined) {
    if (existing !== pseudo) {
      throw new ExportContractError("PSEUDONYM_COLLISION",
        `same raw id produced two pseudonyms in namespace ${namespace}`, { rawKey });
    }
    return true;
  }
  const usedBy = used.get(pseudo);
  if (usedBy !== undefined && !(usedBy.ns === namespace && usedBy.rawKey === rawKey)) {
    throw new ExportContractError("PSEUDONYM_COLLISION",
      "pseudonym collision across identities; export aborted (no partial output)",
      { pseudonym: pseudo, a: usedBy, b: { ns: namespace, rawKey } });
  }
  return false;
}

export function createPseudonymizer(keyHex) {
  if (typeof keyHex !== "string" || !KEY_HEX_PATTERN.test(keyHex)) {
    throw new ExportContractError("INVALID_KEY", "key must be 64 hex characters (32 bytes)");
  }
  const key = Buffer.from(keyHex, "hex");
  const maps = new Map(); // ns -> Map(rawKey -> pseudonym), rawKey = "oid:<hex>" | "str:<s>"
  const used = new Map(); // pseudonym -> { ns, rawKey }

  function pseudonymize(namespace, idNode) {
    const msg = hmacMessage(namespace, idNode);
    const rawKey = idNode.t === "oid" ? `oid:${idNode.hex}` : `str:${idNode.s}`;
    const pseudo = crypto.createHmac("sha256", key).update(msg, "utf8").digest("hex").slice(0, 24);
    if (collisionCheck(maps, used, namespace, rawKey, pseudo)) return pseudo;
    let map = maps.get(namespace);
    if (!map) {
      map = new Map();
      maps.set(namespace, map);
    }
    map.set(rawKey, pseudo);
    used.set(pseudo, { ns: namespace, rawKey });
    return pseudo;
  }

  function namespaceStats() {
    const stats = {};
    for (const ns of NAMESPACES) {
      const map = maps.get(ns) ?? new Map();
      const distinctPseudonyms = new Set(map.values()).size;
      stats[ns] = { distinctRawCount: map.size, distinctPseudonymCount: distinctPseudonyms };
      if (distinctPseudonyms !== map.size) {
        throw new ExportContractError("PSEUDONYM_COLLISION",
          `truncated-hash collision in namespace ${ns}; export aborted`, { ns });
      }
    }
    return stats;
  }

  // Raw ids registered in a namespace (for orphan resolution keyed by ns).
  function rawKeys(namespace) {
    return new Set((maps.get(namespace) ?? new Map()).keys());
  }

  function pseudonymOf(namespace, rawKey) {
    return (maps.get(namespace) ?? new Map()).get(rawKey) ?? null;
  }

  return { pseudonymize, namespaceStats, rawKeys, pseudonymOf, keyFingerprint: sha256Hex(key) };
}

export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Input parsing: canonical Extended JSON v2 -> internal typed tree
// ---------------------------------------------------------------------------

// Canonical Extended JSON tags we understand, with their approximate BSON
// type codes. Tags outside the "real types" list below become §4
// {"$unknownBsonType": <code>} leaves — never coerced.
const EXTENDED_JSON_TYPE_CODES = Object.freeze({
  "$binary": 5,
  "$undefined": 6,
  "$regex": 11,
  "$dbPointer": 12,
  "$code": 13,
  "$symbol": 14,
  "$codeWithScope": 15,
  "$timestamp": 17,
  "$minKey": -1,
  "$maxKey": 127,
});

function failInput(code, message, path) {
  throw new ExportContractError(code, `${message} (at ${path || "(root)"})`, { path });
}

export function parseCanonicalValue(value, path = "") {
  if (value === null) return { t: "null" };
  const ty = typeof value;
  if (ty === "string") return { t: "str", s: value };
  if (ty === "boolean") return { t: "bool", b: value };
  if (ty === "number") {
    failInput("NON_CANONICAL_NUMBER",
      "bare JSON number in dump input; input must be canonical Extended JSON v2 (bsondump)", path);
  }
  if (Array.isArray(value)) {
    return { t: "arr", e: value.map((v, i) => parseCanonicalValue(v, `${path}[${i}]`)) };
  }
  if (ty !== "object") {
    failInput("INVALID_INPUT_LINE", `unsupported input value type ${ty}`, path);
  }
  const keys = Object.keys(value);
  if (keys.length > 0 && keys[0].startsWith("$")) {
    return parseTagged(value, keys, path);
  }
  return {
    t: "doc",
    e: keys.map((k) => [k, parseCanonicalValue(value[k], path ? `${path}.${k}` : k)]),
  };
}

function parseTagged(value, keys, path) {
  const tag = keys[0];
  switch (tag) {
    case "$oid": {
      const hex = value.$oid;
      if (typeof hex !== "string" || !OID_PATTERN.test(hex)) {
        failInput("INVALID_INPUT_LINE", "invalid $oid", path);
      }
      return { t: "oid", hex: hex.toLowerCase() };
    }
    case "$numberInt": {
      const s = value.$numberInt;
      if (typeof s !== "string" || !INTEGER_PATTERN.test(s)) {
        failInput("INVALID_INPUT_LINE", "invalid $numberInt", path);
      }
      const n = Number(s);
      if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) {
        failInput("INVALID_INPUT_LINE", "$numberInt out of int32 range", path);
      }
      return { t: "int32", n };
    }
    case "$numberLong": {
      const s = value.$numberLong;
      if (typeof s !== "string" || !INTEGER_PATTERN.test(s)) {
        failInput("INVALID_INPUT_LINE", "invalid $numberLong", path);
      }
      return { t: "int64", s };
    }
    case "$numberDouble": {
      const s = value.$numberDouble;
      if (typeof s !== "string") failInput("INVALID_INPUT_LINE", "invalid $numberDouble", path);
      if (s === "NaN") return { t: "double", special: "NaN" };
      if (s === "Infinity") return { t: "double", special: "Infinity" };
      if (s === "-Infinity") return { t: "double", special: "-Infinity" };
      const n = Number(s);
      if (!Number.isFinite(n)) failInput("INVALID_INPUT_LINE", "invalid $numberDouble", path);
      return { t: "double", n }; // keeps -0, exact shortest round-trip
    }
    case "$numberDecimal": {
      const s = value.$numberDecimal;
      if (typeof s !== "string" || s.length === 0) {
        failInput("INVALID_INPUT_LINE", "invalid $numberDecimal", path);
      }
      return { t: "decimal128", s };
    }
    case "$date": {
      const d = value.$date;
      let iso;
      if (d && typeof d === "object" && typeof d.$numberLong === "string" &&
          INTEGER_PATTERN.test(d.$numberLong)) {
        const ms = Number(d.$numberLong);
        iso = new Date(ms).toISOString();
      } else if (typeof d === "string" && !Number.isNaN(Date.parse(d))) {
        iso = new Date(d).toISOString();
      } else {
        failInput("INVALID_INPUT_LINE", "invalid $date", path);
      }
      return { t: "date", iso };
    }
    default: {
      if (tag in EXTENDED_JSON_TYPE_CODES) {
        return { t: "unknown", code: EXTENDED_JSON_TYPE_CODES[tag] };
      }
      // Unrecognized canonical tag: fail closed as an unknown BSON type tag.
      return { t: "unknown", code: tag };
    }
  }
}

// ---------------------------------------------------------------------------
// §4 Output emitters (internal node -> exported value; never coerced)
// ---------------------------------------------------------------------------

export function float64Hex(n) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(n, 0);
  return buf.toString("hex");
}

export function readFloat64Hex(hex) {
  return Buffer.from(hex, "hex").readDoubleBE(0);
}

// JSON.stringify emits -0 as "0" (sign is carried by qtyHex, per §4).
export function emitDouble(node) {
  if (node.t !== "double") throw new ExportContractError("INVALID_INPUT_LINE", "not a double");
  if (node.special) return { $special: node.special };
  return node.n;
}

export function emitInt32(node) {
  return { $int32: node.n };
}

export function emitInt64(node) {
  return { $int64: node.s };
}

export function emitDecimal(node) {
  return { $decimal128: node.s };
}

export function emitDate(node) {
  return { $date: node.iso };
}

export function emitUnknown(node) {
  return { $unknownBsonType: String(node.code) };
}

// Emit any typed leaf in its §4 form; returns { value, valueType }.
export function emitTypedLeaf(node) {
  switch (node.t) {
    case "double":
      return node.special
        ? { value: { $special: node.special }, valueType: `special:${node.special}` }
        : { value: node.n, valueType: "double" };
    case "int32":
      return { value: emitInt32(node), valueType: "int32" };
    case "int64":
      return { value: emitInt64(node), valueType: "int64" };
    case "decimal128":
      return { value: emitDecimal(node), valueType: "decimal128" };
    case "date":
      return { value: emitDate(node), valueType: "date" };
    case "str":
      return { value: node.s, valueType: "string" };
    case "bool":
      return { value: node.b, valueType: "boolean" };
    case "null":
      return { value: null, valueType: "null" };
    case "unknown":
      return { value: emitUnknown(node), valueType: `unknown:${node.code}` };
    default:
      throw new ExportContractError("INVALID_INPUT_LINE", `unexpected node type ${node.t}`);
  }
}

// §4 tag name used by the §5 `nonString:<tag>` vocabulary.
export function unitTag(node) {
  switch (node.t) {
    case "double": return "double";
    case "bool": return "boolean";
    case "int32": return "int32";
    case "int64": return "int64";
    case "decimal128": return "decimal128";
    case "date": return "$date";
    case "unknown": return "$unknownBsonType";
    default: return node.t;
  }
}

// ---------------------------------------------------------------------------
// §5 Raw unit vocabulary (never normalized)
// ---------------------------------------------------------------------------

const WHITESPACE_ONLY = /^\s+$/u;

// Classifies a unit value at a unit field position. Returns:
//   { missing: true }
//   { unitStoredType: "null" }
//   { unitStoredType: "string", unitState, node }
//   { unitStoredType: "nonString:<tag>", node }
export function classifyUnit(maybeNode) {
  if (maybeNode === undefined) return { missing: true };
  if (maybeNode.t === "null") return { unitStoredType: "null" };
  if (maybeNode.t === "str") {
    const s = maybeNode.s;
    const unitState = s.length === 0 ? "empty" : WHITESPACE_ONLY.test(s) ? "whitespace" : "value";
    return { unitStoredType: "string", unitState, node: maybeNode };
  }
  return { unitStoredType: `nonString:${unitTag(maybeNode)}`, node: maybeNode };
}

// ---------------------------------------------------------------------------
// §7.5 Canonical NDJSON serialization (fixed key order, qtyHex, LF)
// ---------------------------------------------------------------------------

// Canonical key order per object context. Unlisted keys are appended sorted
// (the whitelist scan in the validator rejects them for exported shapes).
export const CANONICAL_KEY_ORDER = {
  inventoryitems: ["_id", "unit", "unitStoredType", "unitState", "currentStock", "reservedStock", "qtyHex", "orphan", "orphanRefs"],
  recipes: ["_id", "ingredients", "isActive", "orphan", "orphanRefs"],
  stockmovements: ["item", "unit", "unitStoredType", "unitState", "quantity", "qtyHex", "type", "reason", "orphan", "orphanRefs"],
  inventoryaudits: ["item", "unit", "unitStoredType", "unitState", "action", "quantityDelta", "beforeStock", "afterStock", "beforeSnapshot", "afterSnapshot", "qtyHex", "orphan", "orphanRefs"],
  inventoryreservations: ["_id", "orderId", "status", "items", "requirementFingerprint", "recomputedRequirementFingerprint", "shortageFingerprint", "recomputedShortageFingerprint", "approval", "consumedTrigger", "voids", "orphan", "orphanRefs"],
  orders: ["_id", "items", "orphan", "orphanRefs"],
  "items[]": ["inventoryItemId", "unit", "unitStoredType", "unitState", "requiredQuantity", "reservedQuantity", "shortageQuantity", "availableAtDecision", "consumedQuantity", "qtyHex"],
  "approval": ["requirementFingerprint", "shortageFingerprint", "shortages"],
  "approval.shortages[]": ["inventoryItemId", "unit", "unitStoredType", "unitState", "requiredQuantity", "availableQuantity", "shortageQuantity", "qtyHex"],
  "voids[]": ["phase", "source", "station", "lineId", "items"],
  "voids[].items[]": ["inventoryItemId", "unit", "unitStoredType", "unitState", "quantity", "qtyHex"],
  "ingredients[]": ["inventoryItemId", "unit", "unitStoredType", "unitState", "quantity", "qtyHex"],
  "items[orders]": ["lineId", "components"],
  "items[orders].components[]": ["componentId", "inventoryItemId", "stockUnit", "unitStoredType", "unitState", "stockQuantity", "qtyHex"],
  "snapshotLeaf": ["path", "value", "valueType", "unitStoredType", "unitState", "qtyHex"],
};

// Whitelist of legal keys at each context (used by the validator's
// exclusion/leakage scan). Must match what the exporters can emit.
export const ALLOWED_KEYS = {
  inventoryitems: new Set(CANONICAL_KEY_ORDER.inventoryitems),
  recipes: new Set([...CANONICAL_KEY_ORDER.recipes, "qtyHex"]),
  stockmovements: new Set(CANONICAL_KEY_ORDER.stockmovements),
  inventoryaudits: new Set(CANONICAL_KEY_ORDER.inventoryaudits),
  inventoryreservations: new Set([...CANONICAL_KEY_ORDER.inventoryreservations, "qtyHex"]),
  orders: new Set(CANONICAL_KEY_ORDER.orders),
  "items[]": new Set(CANONICAL_KEY_ORDER["items[]"]),
  "approval": new Set(CANONICAL_KEY_ORDER.approval),
  "approval.shortages[]": new Set(CANONICAL_KEY_ORDER["approval.shortages[]"]),
  "voids[]": new Set(CANONICAL_KEY_ORDER["voids[]"]),
  "voids[].items[]": new Set(CANONICAL_KEY_ORDER["voids[].items[]"]),
  "ingredients[]": new Set(CANONICAL_KEY_ORDER["ingredients[]"]),
  "items[orders]": new Set(CANONICAL_KEY_ORDER["items[orders]"]),
  "items[orders].components[]": new Set(CANONICAL_KEY_ORDER["items[orders].components[]"]),
  "snapshotLeaf": new Set(CANONICAL_KEY_ORDER.snapshotLeaf),
};

export function canonicalize(value, context) {
  if (Array.isArray(value)) {
    // Snapshot leaf arrays are sorted by path ascending; other arrays keep
    // builder order (subdocuments are keyed by pseudonyms, never reordered).
    if (context === "beforeSnapshot[]" || context === "afterSnapshot[]") {
      return [...value]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((leaf) => canonicalize(leaf, "snapshotLeaf"));
    }
    return value.map((v) => canonicalize(v, context));
  }
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0].startsWith("$")) return value; // §4 tagged leaf
  const order = CANONICAL_KEY_ORDER[context] ?? [];
  const out = {};
  for (const k of order) if (k in value) out[k] = value[k];
  const rest = keys.filter((k) => !order.includes(k) && k !== "qtyHex").sort();
  for (const k of rest) out[k] = value[k];
  if (value.qtyHex !== undefined) {
    const sortedHex = {};
    for (const k of Object.keys(value.qtyHex).sort()) sortedHex[k] = value.qtyHex[k];
    out.qtyHex = sortedHex;
  }
  // Recurse with context for known child contexts.
  return recurseContext(out, context);
}

function recurseContext(obj, context) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const child = (k, v) => {
    if (context === "inventoryreservations" && k === "items" && Array.isArray(v)) {
      return v.map((x) => canonicalize(x, "items[]"));
    }
    if (context === "inventoryreservations" && k === "approval") {
      return canonicalize(v, "approval");
    }
    if (context === "approval" && k === "shortages" && Array.isArray(v)) {
      return v.map((x) => canonicalize(x, "approval.shortages[]"));
    }
    if (context === "inventoryreservations" && k === "voids" && Array.isArray(v)) {
      return v.map((x) => canonicalize(x, "voids[]"));
    }
    if (context === "voids[]" && k === "items" && Array.isArray(v)) {
      return v.map((x) => canonicalize(x, "voids[].items[]"));
    }
    if (context === "recipes" && k === "ingredients" && Array.isArray(v)) {
      return v.map((x) => canonicalize(x, "ingredients[]"));
    }
    if (context === "inventoryaudits" &&
        (k === "beforeSnapshot" || k === "afterSnapshot") &&
        Array.isArray(v)) {
      return canonicalize(v, `${k}[]`);
    }
    if (context === "orders" && k === "items" && Array.isArray(v)) {
      return v.map((x) => canonicalize(x, "items[orders]"));
    }
    if (context === "items[orders]" && k === "components" && Array.isArray(v)) {
      return v.map((x) => canonicalize(x, "items[orders].components[]"));
    }
    return v;
  };
  for (const k of Object.keys(obj)) obj[k] = child(k, obj[k]);
  return obj;
}

// Adds the §4 qtyHex companion map: for every plain finite number that is a
// double slot (never a "$"-tag payload), one entry `<key> -> float64 BE hex`.
// qtyHex is emitted only for BSON doubles.
export function addQtyHex(value, context) {
  if (Array.isArray(value)) {
    for (const v of value) addQtyHex(v, context);
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0].startsWith("$")) return value; // tagged leaf
  for (const k of keys) {
    if (k === "qtyHex" || k.startsWith("$")) continue;
    const v = value[k];
    if (typeof v === "number" && Number.isFinite(v)) continue; // handled below
    addQtyHex(v, context);
  }
  const hexMap = {};
  for (const k of keys) {
    if (k === "qtyHex" || k.startsWith("$")) continue;
    const v = value[k];
    if (typeof v === "number" && Number.isFinite(v)) hexMap[k] = float64Hex(v);
  }
  if (Object.keys(hexMap).length > 0) value.qtyHex = hexMap;
  return value;
}

export function serializeRecordLine(record, collection) {
  return JSON.stringify(canonicalize(record, collection));
}

