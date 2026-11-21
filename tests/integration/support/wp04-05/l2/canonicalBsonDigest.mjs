// WP04-05 L2 — canonical BSON SHA-256 digest utility (TEST-ONLY).
//
// This module is deliberately independent of lib/recovery/fingerprint.js. The
// fingerprint module hashes a *projected* evidence object; this utility hashes
// raw driver documents and must preserve BSON type identity.
//
// Canonical encoding (v1)
// -----------------------
// A document/value is encoded into a self-delimiting byte stream. Every value
// starts with a one-byte type tag. Objects and arrays are length-prefixed;
// object keys are sorted by their UTF-8 byte sequence; every string is
// length-prefixed with its UTF-8 byte length. The SHA-256 of that stream is the
// document digest.
//
//   tag  value
//   0x00 undefined            (distinct from null and from a missing key)
//   0x01 null
//   0x02 object: u32 count, then (u32 keyLen, keyBytes, encoded value)* sorted
//   0x03 array:  u32 count, then encoded value per element (index order kept)
//   0x04 double: 8-byte IEEE-754 big-endian (NaN canonicalised, -0 -> +0)
//   0x05 int32:  4-byte signed big-endian
//   0x06 int64:  8-byte signed big-endian (BSON Long / JS BigInt)
//   0x07 decimal128: 16 raw BSON bytes (never parsed to float)
//   0x08 binary: u8 subtype, u32 length, bytes
//   0x09 ObjectId: 12 raw bytes
//   0x0a boolean: u8 0|1
//   0x0b date: int64 epoch milliseconds
//   0x0c timestamp: u32 t, u32 i
//   0x0d string: u32 byteLen, UTF-8 bytes
//   0x0e regex: string pattern, string options
//   0x0f MinKey
//   0x10 MaxKey
//   0x11 symbol: string
//   0x12 code: string
//   0x13 code-with-scope: string code, encoded scope object
//   0x14 DBRef: string collection, string db, encoded ObjectId
//
// Numeric policy
// --------------
// Typed BSON numbers (Int32, Double, Long) encode with distinct tags, so
// `Int32(1)`, `Double(1)` and `Long(1)` never collide. A plain JS number is
// encoded as a BSON *double*: the JavaScript driver cannot distinguish an
// Int32 from a Double once a value has been promoted. The verifier therefore
// reads documents with `promoteValues: false`, which preserves the wire type.
//
// Missing vs null: a missing key contributes nothing to its parent object;
// null contributes tag 0x01. They are therefore distinguishable.
//
// Collection digest
// -----------------
// per-collection = SHA-256(
//   "wp04-05:collection:v1\0" || name || "\0" || join("\n", sorted(docDigests))
// )
// database = SHA-256(join("\n", sorted(`${name}:${collectionDigest}`)))
// `system.*` collections are excluded by the callers and by digestDatabase().

import { createHash } from "node:crypto";

export const CANONICAL_DIGEST_VERSION = "wp04-05-canonical-bson-sha256-v1";
export const CANONICAL_COLLECTION_PREFIX = "wp04-05:collection:v1\0";
export const CANONICAL_DATABASE_PREFIX = "wp04-05:database:v1\0";

export const DIGEST_TYPE_TAGS = Object.freeze({
  UNDEFINED: 0x00,
  NULL: 0x01,
  OBJECT: 0x02,
  ARRAY: 0x03,
  DOUBLE: 0x04,
  INT32: 0x05,
  INT64: 0x06,
  DECIMAL128: 0x07,
  BINARY: 0x08,
  OBJECTID: 0x09,
  BOOLEAN: 0x0a,
  DATE: 0x0b,
  TIMESTAMP: 0x0c,
  STRING: 0x0d,
  REGEX: 0x0e,
  MINKEY: 0x0f,
  MAXKEY: 0x10,
  SYMBOL: 0x11,
  CODE: 0x12,
  CODE_WITH_SCOPE: 0x13,
  DBREF: 0x14,
});

export class CanonicalDigestError extends Error {
  constructor(code, path, message = code) {
    super(message === code ? code : `${code}: ${message}`);
    this.name = "CanonicalDigestError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new CanonicalDigestError(code, path, message || code);
}

const CANONICAL_NAN = Buffer.from("7ff8000000000000", "hex");

function u8(value) {
  const buffer = Buffer.allocUnsafe(1);
  buffer.writeUInt8(value & 0xff, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function i32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32BE(value | 0, 0);
  return buffer;
}

function i64(value) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigInt64BE(BigInt.asIntN(64, value), 0);
  return buffer;
}

function doubleBytes(value) {
  if (Number.isNaN(value)) return CANONICAL_NAN;
  const normalized = Object.is(value, -0) ? 0 : value;
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeDoubleBE(normalized, 0);
  return buffer;
}

function utf8(value) {
  return Buffer.from(value, "utf8");
}

function encodedString(value) {
  const bytes = utf8(value);
  return [u32(bytes.length), bytes];
}

function bsontype(value) {
  const type = value?._bsontype;
  return typeof type === "string" ? type : null;
}

function objectIdBytes(value) {
  if (value?.id && (Buffer.isBuffer(value.id) || value.id instanceof Uint8Array)) {
    const bytes = Buffer.from(value.id);
    if (bytes.length === 12) return bytes;
  }
  const hex = typeof value?.toHexString === "function" ? value.toHexString() : String(value);
  if (/^[0-9a-fA-F]{24}$/.test(hex)) return Buffer.from(hex, "hex");
  return fail("INVALID_OBJECTID", "$", "ObjectId has no 12-byte representation");
}

function binaryBytes(value) {
  if (typeof value?.value === "function") {
    const raw = value.value(true);
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof Uint8Array) return Buffer.from(raw);
  }
  if (value?.buffer) return Buffer.from(value.buffer);
  return fail("INVALID_BINARY", "$", "Binary value has no readable bytes");
}

function decimalBytes(value) {
  const bytes = value?.bytes;
  if (bytes && (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
    const buffer = Buffer.from(bytes);
    if (buffer.length === 16) return buffer;
  }
  return fail("INVALID_DECIMAL128", "$", "Decimal128 has no 16-byte representation");
}

function longBigInt(value) {
  if (typeof value?.toBigInt === "function") return value.toBigInt();
  return BigInt(String(value));
}

function encodeValue(value, out, path) {
  if (value === undefined) {
    out.push(u8(DIGEST_TYPE_TAGS.UNDEFINED));
    return;
  }
  if (value === null) {
    out.push(u8(DIGEST_TYPE_TAGS.NULL));
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(u8(DIGEST_TYPE_TAGS.BOOLEAN), u8(value ? 1 : 0));
      return;
    case "number":
      out.push(u8(DIGEST_TYPE_TAGS.DOUBLE), doubleBytes(value));
      return;
    case "bigint":
      out.push(u8(DIGEST_TYPE_TAGS.INT64), i64(value));
      return;
    case "string":
      out.push(u8(DIGEST_TYPE_TAGS.STRING), ...encodedString(value));
      return;
    case "function":
    case "symbol":
      fail("UNSUPPORTED_JS_TYPE", path, `${path} contains an unsupported JS ${typeof value}`);
      return;
    default:
      break;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail("INVALID_DATE", path, `${path} is an invalid Date`);
    out.push(u8(DIGEST_TYPE_TAGS.DATE), i64(BigInt(value.getTime())));
    return;
  }
  if (value instanceof RegExp) {
    out.push(u8(DIGEST_TYPE_TAGS.REGEX), ...encodedString(value.source), ...encodedString(value.flags));
    return;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    out.push(u8(DIGEST_TYPE_TAGS.BINARY), u8(0), u32(bytes.length), bytes);
    return;
  }
  if (Array.isArray(value)) {
    out.push(u8(DIGEST_TYPE_TAGS.ARRAY), u32(value.length));
    value.forEach((entry, index) => encodeValue(entry, out, `${path}[${index}]`));
    return;
  }

  const type = bsontype(value);
  switch (type) {
    case "ObjectId":
      out.push(u8(DIGEST_TYPE_TAGS.OBJECTID), objectIdBytes(value));
      return;
    case "Decimal128":
      out.push(u8(DIGEST_TYPE_TAGS.DECIMAL128), decimalBytes(value));
      return;
    case "Binary":
    case "UUID": {
      const bytes = binaryBytes(value);
      const subtype = Number.isInteger(value.sub_type) ? value.sub_type : 0;
      out.push(u8(DIGEST_TYPE_TAGS.BINARY), u8(subtype), u32(bytes.length), bytes);
      return;
    }
    case "Int32":
      out.push(u8(DIGEST_TYPE_TAGS.INT32), i32(Number(value.value)));
      return;
    case "Double":
      out.push(u8(DIGEST_TYPE_TAGS.DOUBLE), doubleBytes(Number(value.value)));
      return;
    case "Long":
      out.push(u8(DIGEST_TYPE_TAGS.INT64), i64(longBigInt(value)));
      return;
    case "Timestamp": {
      const t = Number.isInteger(value.t) ? value.t : Number(value.high ?? 0);
      const i = Number.isInteger(value.i) ? value.i : Number(value.low ?? 0);
      out.push(u8(DIGEST_TYPE_TAGS.TIMESTAMP), u32(t), u32(i));
      return;
    }
    case "MinKey":
      out.push(u8(DIGEST_TYPE_TAGS.MINKEY));
      return;
    case "MaxKey":
      out.push(u8(DIGEST_TYPE_TAGS.MAXKEY));
      return;
    case "BSONRegExp":
    case "BSONRegex":
      out.push(
        u8(DIGEST_TYPE_TAGS.REGEX),
        ...encodedString(String(value.pattern ?? "")),
        ...encodedString(String(value.options ?? "")),
      );
      return;
    case "BSONSymbol":
    case "Symbol":
      out.push(u8(DIGEST_TYPE_TAGS.SYMBOL), ...encodedString(String(value.value ?? value)));
      return;
    case "Code":
      if (value.scope !== undefined && value.scope !== null) {
        out.push(u8(DIGEST_TYPE_TAGS.CODE_WITH_SCOPE), ...encodedString(String(value.code)));
        encodeValue(value.scope, out, `${path}.scope`);
      } else {
        out.push(u8(DIGEST_TYPE_TAGS.CODE), ...encodedString(String(value.code)));
      }
      return;
    case "DBRef":
      out.push(
        u8(DIGEST_TYPE_TAGS.DBREF),
        ...encodedString(String(value.collection ?? "")),
        ...encodedString(String(value.db ?? "")),
      );
      encodeValue(value.oid, out, `${path}.oid`);
      return;
    case null:
      break;
    default:
      fail("UNSUPPORTED_BSON_TYPE", path, `${path} contains unsupported BSON type ${type}`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("UNSUPPORTED_OBJECT", path, `${path} is not a plain object`);
  }

  const keys = Object.keys(value).sort((left, right) =>
    Buffer.compare(utf8(left), utf8(right)),
  );
  out.push(u8(DIGEST_TYPE_TAGS.OBJECT), u32(keys.length));
  for (const key of keys) {
    const keyBytes = utf8(key);
    out.push(u32(keyBytes.length), keyBytes);
    encodeValue(value[key], out, path === "$" ? `$.${key}` : `${path}.${key}`);
  }
}

/**
 * Encode a value into the canonical v1 byte stream. Exposed for tests and for
 * independently re-deriving the digest.
 *
 * @param {unknown} value
 * @returns {Buffer}
 */
export function encodeCanonicalBson(value) {
  const out = [];
  encodeValue(value, out, "$");
  return Buffer.concat(out);
}

/**
 * SHA-256 hex digest of one raw document.
 *
 * @param {unknown} document
 * @returns {string}
 */
export function digestDocument(document) {
  return createHash("sha256").update(encodeCanonicalBson(document)).digest("hex");
}

/**
 * Deterministic digest of a multiset of documents (duplicates matter).
 *
 * @param {Array<unknown>} documents
 * @returns {string}
 */
export function digestDocuments(documents) {
  const digests = documents.map((document) => digestDocument(document)).sort();
  return createHash("sha256").update(digests.join("\n"), "utf8").digest("hex");
}

/**
 * Deterministic digest of one collection, binding the collection name to the
 * sorted document digests.
 *
 * @param {{ name: string, documents: Array<unknown> }} collection
 * @returns {string}
 */
export function digestCollection(collection) {
  if (collection === null || typeof collection !== "object") {
    fail("INVALID_COLLECTION", "$", "collection must be an object");
  }
  if (typeof collection.name !== "string" || collection.name.length === 0) {
    fail("INVALID_COLLECTION_NAME", "$", "collection.name must be a non-empty string");
  }
  if (!Array.isArray(collection.documents)) {
    fail("INVALID_COLLECTION_DOCUMENTS", "$", "collection.documents must be an array");
  }
  if (isSystemCollection(collection.name)) {
    fail("SYSTEM_COLLECTION", "$", "system.* collections are excluded from collection digests");
  }
  const documents = collection.documents.map((document) => digestDocument(document)).sort();
  return createHash("sha256")
    .update(CANONICAL_COLLECTION_PREFIX, "utf8")
    .update(collection.name, "utf8")
    .update("\0", "utf8")
    .update(documents.join("\n"), "utf8")
    .digest("hex");
}

/**
 * Deterministic digest over a set of collections. `system.*` entries are
 * silently excluded, matching the L2 evidence rule.
 *
 * @param {Array<{ name: string, documents: Array<unknown> }>} collections
 * @returns {string}
 */
export function digestDatabase(collections) {
  if (!Array.isArray(collections)) {
    fail("INVALID_COLLECTIONS", "$", "collections must be an array");
  }
  return digestDatabaseFromDigests(
    collections
      .filter((collection) => collection && !isSystemCollection(collection.name))
      .map((collection) => ({
        name: collection.name,
        digest: digestCollection(collection),
      })),
  );
}

/**
 * Deterministic database digest from already-computed collection digests.
 *
 * @param {Array<{ name: string, digest: string }>} entries
 * @returns {string}
 */
export function digestDatabaseFromDigests(entries) {
  if (!Array.isArray(entries)) {
    fail("INVALID_COLLECTIONS", "$", "entries must be an array");
  }
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") {
      fail("INVALID_COLLECTION", "$", "entry must be an object");
    }
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      fail("INVALID_COLLECTION_NAME", "$", "entry.name must be a non-empty string");
    }
    if (typeof entry.digest !== "string" || !/^[0-9a-f]{64}$/.test(entry.digest)) {
      fail("INVALID_DIGEST", "$", `entry ${entry.name} is not a lowercase SHA-256 digest`);
    }
    if (isSystemCollection(entry.name)) {
      fail("SYSTEM_COLLECTION", "$", "system.* collections are excluded from database digests");
    }
  }
  const lines = entries.map((entry) => `${entry.name}:${entry.digest}`).sort();
  return createHash("sha256")
    .update(CANONICAL_DATABASE_PREFIX, "utf8")
    .update(lines.join("\n"), "utf8")
    .digest("hex");
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isSystemCollection(name) {
  return typeof name === "string" && name.startsWith("system.");
}
