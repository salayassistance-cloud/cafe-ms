// lib/offlineExport/bsonToCanonical.mjs — byte-level BSON -> canonical
// Extended JSON v2 converter (Phase 2, Step 9).
//
// WHY THIS EXISTS
// The approved pipeline (docs/inventory-stored-unit-audit-export-spec.md)
// specifies `mongodump` -> `bsondump` -> canonical Extended JSON v2 NDJSON,
// consumed by lib/offlineExport/sanitizer.mjs. MongoDB Database Tools are not
// available in this environment, so this module replaces `bsondump
// --canonical` while keeping the sanitizer's input contract byte-compatible.
//
// WHY BYTE-LEVEL
// Converting BSON through ordinary JavaScript values destroys the stored-type
// evidence this audit exists to collect: an int32 and a double with the same
// numeric value are indistinguishable as JS numbers (both arrive as `5`), and
// int64 values beyond 2^53 lose precision. This module reads the raw BSON
// bytes and therefore preserves int32 vs int64 vs double vs Decimal128,
// negative zero, NaN, +/-Infinity, exact int64 digits, exact Decimal128 digits,
// exact strings and exact dates.
//
// SAFETY PROPERTIES
// - Pure and offline: no database, no filesystem, no environment access.
// - Fail-closed: unsupported type bytes, duplicate field names, malformed
//   lengths, missing terminators, non-sequential array keys, invalid UTF-8,
//   invalid booleans, out-of-range dates and excessive nesting all throw
//   BSONDecodeError. Nothing is coerced, rounded or silently defaulted.
// - Only the bundled `bson` package is used, and only to decode the 16-byte
//   Decimal128 payload into its exact decimal string.
//
// Canonical Extended JSON v2 shapes emitted (all accepted by
// contract.parseCanonicalValue):
//   double        {"$numberDouble": "1.5" | "NaN" | "Infinity" | "-Infinity"}
//   int32         {"$numberInt": "5"}
//   int64         {"$numberLong": "9007199254740993"}
//   decimal128    {"$numberDecimal": "3.140"}
//   date (>=1970) {"$date": "1970-01-01T00:00:00.000Z"}
//   date (<1970)  {"$date": {"$numberLong": "-1000"}}
//   objectId      {"$oid": "<24 lowercase hex>"}
//   regex         {"$regularExpression": {"pattern": "...", "options": "im"}}
//   timestamp     {"$timestamp": {"t": <uint32>, "i": <uint32>}}
//   binary        {"$binary": {"base64": "...", "subType": "<2 hex>"}}
//   minKey/maxKey {"$minKey": 1} / {"$maxKey": 1}
//   code/symbol/undefined/dbPointer/codeWithScope: their canonical v2 shapes.
// Types the sanitizer classifies as drift (regex, binary, code, ...) are still
// emitted faithfully; the sanitizer/validator own the drift accounting.

import { Decimal128 } from "bson";

export const BSON_ADAPTER_NAME = "bono-bson-to-canonical";
export const BSON_ADAPTER_VERSION = "1.0.0";

// MongoDB's own nesting limit for BSON documents.
export const MAX_DEPTH = 100;

// JavaScript Date range; BSON datetimes outside it cannot be rendered as an
// ISO-8601 string by the downstream contract.
const MAX_DATE_MS = 8640000000000000n;

export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_FRAMING: "INVALID_FRAMING",
  INVALID_LENGTH: "INVALID_LENGTH",
  INVALID_UTF8: "INVALID_UTF8",
  INVALID_STRING: "INVALID_STRING",
  INVALID_BOOLEAN: "INVALID_BOOLEAN",
  INVALID_ARRAY_KEY: "INVALID_ARRAY_KEY",
  INVALID_BINARY: "INVALID_BINARY",
  INVALID_DATE: "INVALID_DATE",
  INVALID_DECIMAL: "INVALID_DECIMAL",
  DUPLICATE_FIELD: "DUPLICATE_FIELD",
  UNSUPPORTED_TYPE: "UNSUPPORTED_TYPE",
  DEPTH_EXCEEDED: "DEPTH_EXCEEDED",
  TRAILING_BYTES: "TRAILING_BYTES",
});

export class BSONDecodeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BSONDecodeError";
    this.code = code;
  }
}

const utf8Fatal = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(buf, start, end, path) {
  try {
    return utf8Fatal.decode(buf.subarray(start, end));
  } catch {
    throw new BSONDecodeError(ERROR_CODES.INVALID_UTF8,
      `invalid UTF-8 bytes at ${path || "(root)"}`);
  }
}

function readCString(buf, pos, limit, path) {
  const nul = buf.indexOf(0, pos);
  if (nul === -1 || nul >= limit) {
    throw new BSONDecodeError(ERROR_CODES.INVALID_FRAMING,
      `unterminated cstring at ${path || "(root)"}`);
  }
  return [decodeUtf8(buf, pos, nul, path), nul + 1];
}

function ensure(pos, need, limit, what, path) {
  if (pos + need > limit) {
    throw new BSONDecodeError(ERROR_CODES.INVALID_LENGTH,
      `${what} overruns the document at ${path || "(root)"}`);
  }
}

// ---------------------------------------------------------------------------
// Canonical scalar renderers
// ---------------------------------------------------------------------------

// Shortest decimal string that round-trips the IEEE-754 value, with the
// double-ness of integral values kept visible ("5" -> "5.0") and the sign of
// negative zero preserved ("-0.0"). Never uses a lossy path.
export function doubleToCanonicalString(v) {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (Object.is(v, -0)) return "-0.0";
  const s = String(v); // ES2018 guarantees shortest round-trip
  if (Number.isInteger(v) && !s.includes(".") && !s.includes("e") && !s.includes("E")) {
    return `${s}.0`;
  }
  return s;
}

function dateToCanonical(ms, path) {
  if (ms > MAX_DATE_MS || ms < -MAX_DATE_MS) {
    throw new BSONDecodeError(ERROR_CODES.INVALID_DATE,
      `datetime out of ISO-8601 representable range at ${path || "(root)"}`);
  }
  // Canonical v2: dates before the epoch use the exact numberLong form.
  if (ms < 0n) return { $date: { $numberLong: ms.toString() } };
  return { $date: new Date(Number(ms)).toISOString() };
}

function hexByte(byte) {
  return byte.toString(16).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

function readValue(type, buf, pos, limit, depth, path) {
  switch (type) {
    case 0x01: { // double
      ensure(pos, 8, limit, "double", path);
      return [{ $numberDouble: doubleToCanonicalString(buf.readDoubleLE(pos)) }, pos + 8];
    }
    case 0x02: { // UTF-8 string
      ensure(pos, 4, limit, "string length", path);
      const len = buf.readInt32LE(pos);
      if (len < 1) {
        throw new BSONDecodeError(ERROR_CODES.INVALID_STRING,
          `string length ${len} at ${path || "(root)"}`);
      }
      ensure(pos + 4, len, limit, "string", path);
      if (buf[pos + 4 + len - 1] !== 0) {
        throw new BSONDecodeError(ERROR_CODES.INVALID_STRING,
          `string not NUL-terminated at ${path || "(root)"}`);
      }
      return [decodeUtf8(buf, pos + 4, pos + 4 + len - 1, path), pos + 4 + len];
    }
    case 0x03: { // embedded document
      return readDocument(buf, pos, limit, depth + 1, path);
    }
    case 0x04: { // array
      return readArray(buf, pos, limit, depth + 1, path);
    }
    case 0x05: { // binary
      ensure(pos, 5, limit, "binary header", path);
      const len = buf.readInt32LE(pos);
      if (len < 0) {
        throw new BSONDecodeError(ERROR_CODES.INVALID_BINARY,
          `negative binary length at ${path || "(root)"}`);
      }
      ensure(pos + 5, len, limit, "binary payload", path);
      const subType = buf[pos + 4];
      let data = buf.subarray(pos + 5, pos + 5 + len);
      if (subType === 0x02) {
        // Old binary subtype: payload begins with its own int32 length.
        if (len < 4 || data.readInt32LE(0) !== len - 4) {
          throw new BSONDecodeError(ERROR_CODES.INVALID_BINARY,
            `legacy subtype-2 inner length mismatch at ${path || "(root)"}`);
        }
        data = data.subarray(4);
      }
      return [{
        $binary: { base64: data.toString("base64"), subType: hexByte(subType) },
      }, pos + 5 + len];
    }
    case 0x06: { // undefined (deprecated)
      return [{ $undefined: true }, pos];
    }
    case 0x07: { // objectId
      ensure(pos, 12, limit, "objectId", path);
      return [{ $oid: buf.subarray(pos, pos + 12).toString("hex") }, pos + 12];
    }
    case 0x08: { // boolean
      ensure(pos, 1, limit, "boolean", path);
      const b = buf[pos];
      if (b !== 0 && b !== 1) {
        throw new BSONDecodeError(ERROR_CODES.INVALID_BOOLEAN,
          `invalid boolean byte 0x${hexByte(b)} at ${path || "(root)"}`);
      }
      return [b === 1, pos + 1];
    }
    case 0x09: { // UTC datetime (int64 ms)
      ensure(pos, 8, limit, "datetime", path);
      return [dateToCanonical(buf.readBigInt64LE(pos), path), pos + 8];
    }
    case 0x0a: { // null
      return [null, pos];
    }
    case 0x10: { // int32
      ensure(pos, 4, limit, "int32", path);
      return [{ $numberInt: String(buf.readInt32LE(pos)) }, pos + 4];
    }
    case 0x11: { // timestamp (uint32 increment, uint32 seconds)
      ensure(pos, 8, limit, "timestamp", path);
      return [{
        $timestamp: { t: buf.readUInt32LE(pos + 4), i: buf.readUInt32LE(pos) },
      }, pos + 8];
    }
    case 0x12: { // int64 — exact via BigInt, never through Number
      ensure(pos, 8, limit, "int64", path);
      return [{ $numberLong: buf.readBigInt64LE(pos).toString() }, pos + 8];
    }
    case 0x13: { // decimal128 — exact decimal string
      ensure(pos, 16, limit, "decimal128", path);
      let s;
      try {
        s = new Decimal128(buf.subarray(pos, pos + 16)).toString();
      } catch {
        throw new BSONDecodeError(ERROR_CODES.INVALID_DECIMAL,
          `undecodable decimal128 at ${path || "(root)"}`);
      }
      if (typeof s !== "string" || s.length === 0) {
        throw new BSONDecodeError(ERROR_CODES.INVALID_DECIMAL,
          `empty decimal128 rendering at ${path || "(root)"}`);
      }
      return [{ $numberDecimal: s }, pos + 16];
    }
    case 0x0b: { // regular expression
      const [pattern, afterPattern] = readCString(buf, pos, limit, path);
      const [options, afterOptions] = readCString(buf, afterPattern, limit, path);
      // Canonical v2 sorts regex options alphabetically.
      return [{
        $regularExpression: { pattern, options: [...options].sort().join("") },
      }, afterOptions];
    }
    case 0x0c: { // DBPointer (deprecated)
      const [ref, afterRef] = readCString(buf, pos, limit, path);
      ensure(afterRef, 12, limit, "dbPointer id", path);
      return [{
        $dbPointer: { $ref: ref, $id: { $oid: buf.subarray(afterRef, afterRef + 12).toString("hex") } },
      }, afterRef + 12];
    }
    case 0x0d: { // JavaScript code
      const [code, next] = readCString(buf, pos, limit, path);
      return [{ $code: code }, next];
    }
    case 0x0e: { // symbol (deprecated)
      const [symbol, next] = readCString(buf, pos, limit, path);
      return [{ $symbol: symbol }, next];
    }
    case 0x0f: { // code with scope
      ensure(pos, 4, limit, "codeWithScope length", path);
      const total = buf.readInt32LE(pos);
      if (total < 10) { // 4 (length) + 1 (empty code) + 5 (empty scope)
        throw new BSONDecodeError(ERROR_CODES.INVALID_LENGTH,
          `codeWithScope length ${total} at ${path || "(root)"}`);
      }
      ensure(pos, total, limit, "codeWithScope", path);
      const [code, afterCode] = readCString(buf, pos + 4, pos + total, path);
      const [scope, end] = readDocument(buf, afterCode, pos + total, depth + 1, path);
      if (end !== pos + total) {
        throw new BSONDecodeError(ERROR_CODES.INVALID_LENGTH,
          `codeWithScope length mismatch at ${path || "(root)"}`);
      }
      return [{ $code: code, $scope: scope }, end];
    }
    case 0xff: { // minKey
      return [{ $minKey: 1 }, pos];
    }
    case 0x7f: { // maxKey
      return [{ $maxKey: 1 }, pos];
    }
    default:
      throw new BSONDecodeError(ERROR_CODES.UNSUPPORTED_TYPE,
        `unsupported BSON type byte 0x${hexByte(type)} at ${path || "(root)"} — abort`);
  }
}

// ---------------------------------------------------------------------------
// Container parsing
// ---------------------------------------------------------------------------

function readDocumentHeader(buf, offset, limit, depth, path) {
  if (depth > MAX_DEPTH) {
    throw new BSONDecodeError(ERROR_CODES.DEPTH_EXCEEDED,
      `nesting deeper than ${MAX_DEPTH} at ${path || "(root)"}`);
  }
  ensure(offset, 4, limit, "document length", path);
  const size = buf.readInt32LE(offset);
  if (size < 5) {
    throw new BSONDecodeError(ERROR_CODES.INVALID_FRAMING,
      `document length ${size} < 5 at ${path || "(root)"}`);
  }
  const end = offset + size;
  if (end > limit) {
    throw new BSONDecodeError(ERROR_CODES.INVALID_LENGTH,
      `document length ${size} overruns the buffer at ${path || "(root)"}`);
  }
  if (buf[end - 1] !== 0) {
    throw new BSONDecodeError(ERROR_CODES.INVALID_FRAMING,
      `missing document terminator at ${path || "(root)"}`);
  }
  return end;
}

function readDocument(buf, offset, limit, depth, path) {
  const end = readDocumentHeader(buf, offset, limit, depth, path);
  const out = {};
  let pos = offset + 4;
  while (pos < end - 1) {
    const type = buf[pos];
    pos += 1;
    if (type === 0x00) {
      throw new BSONDecodeError(ERROR_CODES.INVALID_FRAMING,
        `unexpected 0x00 element type at ${path || "(root)"}`);
    }
    const [name, afterName] = readCString(buf, pos, end - 1, path);
    if (Object.prototype.hasOwnProperty.call(out, name)) {
      throw new BSONDecodeError(ERROR_CODES.DUPLICATE_FIELD,
        `duplicate field name "${name}" at ${path || "(root)"} — abort`);
    }
    const childPath = path ? `${path}.${name}` : name;
    const [value, next] = readValue(type, buf, afterName, end - 1, depth, childPath);
    out[name] = value;
    pos = next;
  }
  if (pos !== end - 1) {
    throw new BSONDecodeError(ERROR_CODES.INVALID_FRAMING,
      `element overrun at ${path || "(root)"}`);
  }
  return [out, end];
}

function readArray(buf, offset, limit, depth, path) {
  const end = readDocumentHeader(buf, offset, limit, depth, path);
  const out = [];
  let pos = offset + 4;
  let index = 0;
  while (pos < end - 1) {
    const type = buf[pos];
    pos += 1;
    if (type === 0x00) {
      throw new BSONDecodeError(ERROR_CODES.INVALID_FRAMING,
        `unexpected 0x00 element type at ${path || "(root)"}`);
    }
    const [name, afterName] = readCString(buf, pos, end - 1, path);
    if (name !== String(index)) {
      throw new BSONDecodeError(ERROR_CODES.INVALID_ARRAY_KEY,
        `array key "${name}" where "${index}" expected at ${path || "(root)"}`);
    }
    const [value, next] = readValue(type, buf, afterName, end - 1, depth, `${path}[${index}]`);
    out.push(value);
    pos = next;
    index += 1;
  }
  if (pos !== end - 1) {
    throw new BSONDecodeError(ERROR_CODES.INVALID_FRAMING,
      `element overrun at ${path || "(root)"}`);
  }
  return [out, end];
}

function assertBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new BSONDecodeError(ERROR_CODES.INVALID_INPUT, "expected a Buffer");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Converts exactly one BSON document spanning the whole buffer.
export function bsonDocumentToCanonical(buffer) {
  assertBuffer(buffer);
  const [value, end] = readDocument(buffer, 0, buffer.length, 0, "");
  if (end !== buffer.length) {
    throw new BSONDecodeError(ERROR_CODES.TRAILING_BYTES,
      `${buffer.length - end} trailing byte(s) after the document`);
  }
  return value;
}

// Converts a mongodump-style .bson stream (length-prefixed documents
// concatenated back-to-back) into canonical values. Empty input yields [].
export function bsonStreamToCanonicalDocuments(buffer) {
  assertBuffer(buffer);
  const documents = [];
  let pos = 0;
  while (pos < buffer.length) {
    const [value, end] = readDocument(buffer, pos, buffer.length, 0, "");
    documents.push(value);
    pos = end;
  }
  return documents;
}

// Converts a .bson stream to NDJSON: one canonical Extended JSON v2 document
// per line, LF only, trailing newline, no BOM. Empty input yields "".
export function bsonStreamToNdjson(buffer) {
  const documents = bsonStreamToCanonicalDocuments(buffer);
  if (documents.length === 0) return "";
  return `${documents.map((d) => JSON.stringify(d)).join("\n")}\n`;
}
