// BONO Inventory — Phase 2, Step 9: raw BSON -> canonical Extended JSON v2
// adapter tests, plus the full offline pipeline proof.
//
// DB-FREE BY CONSTRUCTION: imports only pure modules, hand-built BSON byte
// fixtures and the bundled `bson` package (for constructing genuine BSON bytes
// of types JS cannot represent). No MongoDB connection, no environment file
// and no application service is loaded. The export script is imported only for
// its pure argument parser; its driver import is dynamic and occurs solely
// inside main(), which these tests never call.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  BSON as BSONLib,
  Binary,
  BSONRegExp,
  Decimal128,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "bson";

import {
  BSONDecodeError,
  ERROR_CODES,
  MAX_DEPTH,
  bsonDocumentToCanonical,
  bsonStreamToCanonicalDocuments,
  bsonStreamToNdjson,
  doubleToCanonicalString,
} from "../lib/offlineExport/bsonToCanonical.mjs";
import { parseCanonicalValue } from "../lib/offlineExport/contract.mjs";
import { runSanitizer, sanitizeExport } from "../lib/offlineExport/sanitizer.mjs";
import { validateBundle } from "../lib/offlineExport/validator.mjs";
import {
  APPROVED_COLLECTIONS,
  APPROVED_DATABASE,
  CONFIRM_FLAG,
  parseArgs,
  redactSecrets,
} from "../scripts/export-raw-collections.mjs";

// ---------------------------------------------------------------------------
// Hand-built BSON fixture builders (genuine BSON bytes; no database involved)
// ---------------------------------------------------------------------------
const cstr = (s) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
const i32le = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const f64le = (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b; };
const i64le = (bi) => { const b = Buffer.alloc(8); b.writeBigInt64LE(bi); return b; };
const elem = (t, name, pay) => Buffer.concat([Buffer.from([t]), cstr(name), pay]);
const bdoc = (elements) => {
  const body = Buffer.concat([...elements, Buffer.from([0])]);
  return Buffer.concat([i32le(body.length + 4), body]);
};

const spay = (s) => {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([i32le(bytes.length + 1), bytes, Buffer.from([0])]);
};
const eStr = (n, s) => elem(0x02, n, spay(s));
const eDouble = (n, v) => elem(0x01, n, f64le(v));
const eInt32 = (n, v) => elem(0x10, n, i32le(v));
const eInt64 = (n, bi) => elem(0x12, n, i64le(bi));
const eOid = (n, hex) => elem(0x07, n, Buffer.from(hex, "hex"));
const eBool = (n, b) => elem(0x08, n, Buffer.from([b ? 1 : 0]));
const eNull = (n) => elem(0x0a, n, Buffer.alloc(0));
const eDate = (n, ms) => elem(0x09, n, i64le(BigInt(ms)));
const eDoc = (n, elements) => elem(0x03, n, bdoc(elements));
const rDocN = (elements) => ({ t: 0x03, pay: bdoc(elements) });
const eArr = (n, raws) => elem(0x04, n, bdoc(raws.map((r, i) => elem(r.t, String(i), r.pay))));

function throwsCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof BSONDecodeError, `expected BSONDecodeError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Canonical scalar rendering
// ---------------------------------------------------------------------------
test("doubleToCanonicalString keeps integral doubles, -0 and specials exact", () => {
  assert.equal(doubleToCanonicalString(5), "5.0");
  assert.equal(doubleToCanonicalString(-0), "-0.0");
  assert.equal(doubleToCanonicalString(0), "0.0");
  assert.equal(doubleToCanonicalString(0.1), "0.1");
  assert.equal(doubleToCanonicalString(2.5), "2.5");
  assert.equal(doubleToCanonicalString(1e21), "1e+21");
  assert.equal(doubleToCanonicalString(Number.MIN_VALUE), "5e-324");
  assert.equal(doubleToCanonicalString(Number.MAX_VALUE), "1.7976931348623157e+308");
  assert.equal(doubleToCanonicalString(NaN), "NaN");
  assert.equal(doubleToCanonicalString(Infinity), "Infinity");
  assert.equal(doubleToCanonicalString(-Infinity), "-Infinity");
  // Every rendering must round-trip to the exact same double.
  for (const v of [5, -0, 0.1, 2.5, 1e21, Number.MIN_VALUE, Number.MAX_VALUE]) {
    const s = doubleToCanonicalString(v);
    assert.ok(Object.is(Number(s), v), `${s} must round-trip ${String(v)}`);
  }
});

// ---------------------------------------------------------------------------
// Type preservation (the property JS-value EJSON loses)
// ---------------------------------------------------------------------------
test("stored double with integral value stays a double (never int32)", () => {
  const buf = bdoc([eDouble("q", 5)]);
  const node = bsonDocumentToCanonical(buf);
  assert.deepEqual(node, { q: { $numberDouble: "5.0" } });
  const typed = parseCanonicalValue(node, "t");
  assert.equal(typed.e[0][1].t, "double");
  assert.equal(typed.e[0][1].n, 5);
});

test("negative zero double is preserved through the contract parser", () => {
  const node = bsonDocumentToCanonical(bdoc([eDouble("z", -0)]));
  assert.deepEqual(node, { z: { $numberDouble: "-0.0" } });
  const typed = parseCanonicalValue(node, "t");
  assert.equal(typed.e[0][1].t, "double");
  assert.ok(Object.is(typed.e[0][1].n, -0));
});

test("NaN and infinities use the canonical special strings", () => {
  const node = bsonDocumentToCanonical(bdoc([
    eDouble("nan", NaN), eDouble("pos", Infinity), eDouble("neg", -Infinity),
  ]));
  assert.deepEqual(node, {
    nan: { $numberDouble: "NaN" },
    pos: { $numberDouble: "Infinity" },
    neg: { $numberDouble: "-Infinity" },
  });
  const typed = parseCanonicalValue(node, "t");
  assert.equal(typed.e[0][1].special, "NaN");
  assert.equal(typed.e[1][1].special, "Infinity");
  assert.equal(typed.e[2][1].special, "-Infinity");
});

test("int32 is preserved as int32, not double", () => {
  const node = bsonDocumentToCanonical(bdoc([eInt32("n", 500)]));
  assert.deepEqual(node, { n: { $numberInt: "500" } });
  const typed = parseCanonicalValue(node, "t");
  assert.equal(typed.e[0][1].t, "int32");
  assert.equal(typed.e[0][1].n, 500);
});

test("int64 beyond 2^53 keeps its exact digits", () => {
  const node = bsonDocumentToCanonical(bdoc([eInt64("n", 9007199254740993n)]));
  assert.deepEqual(node, { n: { $numberLong: "9007199254740993" } });
  const typed = parseCanonicalValue(node, "t");
  assert.equal(typed.e[0][1].t, "int64");
  assert.equal(typed.e[0][1].s, "9007199254740993");
});

test("int64 extremes are exact", () => {
  for (const v of [-9223372036854775808n, 9223372036854775807n]) {
    const node = bsonDocumentToCanonical(bdoc([eInt64("n", v)]));
    assert.equal(node.n.$numberLong, v.toString());
  }
});

test("Decimal128 keeps its exact decimal digits (bson-serialized bytes)", () => {
  const bytes = BSONLib.serialize({ d: Decimal128.fromString("3.140") });
  const node = bsonDocumentToCanonical(bytes);
  assert.deepEqual(node, { d: { $numberDecimal: "3.140" } });
  const typed = parseCanonicalValue(node, "t");
  assert.equal(typed.e[0][1].t, "decimal128");
  assert.equal(typed.e[0][1].s, "3.140");
});

test("ObjectId is lowercase hex (bson-serialized bytes)", () => {
  const oid = new ObjectId("65A1E2D3C4B5A69788776655");
  const node = bsonDocumentToCanonical(BSONLib.serialize({ o: oid }));
  assert.deepEqual(node, { o: { $oid: oid.toHexString() } });
});

test("dates: epoch, millisecond precision and pre-1970 canonical forms", () => {
  assert.deepEqual(bsonDocumentToCanonical(bdoc([eDate("d", 0)])), {
    d: { $date: "1970-01-01T00:00:00.000Z" },
  });
  assert.deepEqual(bsonDocumentToCanonical(bdoc([eDate("d", 1700000000123)])), {
    d: { $date: "2023-11-14T22:13:20.123Z" },
  });
  assert.deepEqual(bsonDocumentToCanonical(bdoc([eDate("d", -1000)])), {
    d: { $date: { $numberLong: "-1000" } },
  });
  const typed = parseCanonicalValue(bsonDocumentToCanonical(bdoc([eDate("d", -1000)])), "t");
  assert.equal(typed.e[0][1].t, "date");
  assert.equal(typed.e[0][1].iso, "1969-12-31T23:59:59.000Z");
});

test("exact strings are preserved verbatim (unicode, quotes, newlines)", () => {
  const samples = ["kg", "", "  ", "gm\u00A0/ml", "የቡና ኩባያ", "emoji 🍵", 'quote " and \\ backslash', "line\nbreak"];
  for (const s of samples) {
    assert.deepEqual(bsonDocumentToCanonical(bdoc([eStr("u", s)])), { u: s });
  }
});

test("booleans and null are preserved", () => {
  assert.deepEqual(bsonDocumentToCanonical(bdoc([eBool("t", true), eBool("f", false), eNull("n")])),
    { t: true, f: false, n: null });
});

test("nested documents and arrays keep order and shape", () => {
  const buf = bdoc([
    eDoc("a", [eInt32("x", 1), eDoc("b", [eStr("y", "z")])]),
    eArr("arr", [rDocN([eStr("k", "v1")]), rDocN([eStr("k", "v2")])]),
  ]);
  assert.deepEqual(bsonDocumentToCanonical(buf), {
    a: { x: { $numberInt: "1" }, b: { y: "z" } },
    arr: [{ k: "v1" }, { k: "v2" }],
  });
});

test("binary, regex, timestamp, minKey/maxKey match canonical v2 (bson-serialized bytes)", () => {
  const node = bsonDocumentToCanonical(BSONLib.serialize({
    bin: new Binary(Buffer.from([1, 2, 3]), 0),
    re: new BSONRegExp("^a", "mi"),
    ts: new Timestamp({ t: 1700000000, i: 7 }),
    min: new MinKey(),
    max: new MaxKey(),
  }));
  assert.deepEqual(node.bin, { $binary: { base64: "AQID", subType: "00" } });
  assert.deepEqual(node.re, { $regularExpression: { pattern: "^a", options: "im" } });
  assert.deepEqual(node.ts, { $timestamp: { t: 1700000000, i: 7 } });
  assert.deepEqual(node.min, { $minKey: 1 });
  assert.deepEqual(node.max, { $maxKey: 1 });
});

test("legacy binary subtype 2 strips the inner length safely", () => {
  const inner = Buffer.from([9, 8, 7]);
  const buf = bdoc([elem(0x05, "b", Buffer.concat([i32le(4 + inner.length), Buffer.from([2]), i32le(inner.length), inner]))]);
  assert.deepEqual(bsonDocumentToCanonical(buf), {
    b: { $binary: { base64: inner.toString("base64"), subType: "02" } },
  });
  const bad = bdoc([elem(0x05, "b", Buffer.concat([i32le(4 + inner.length), Buffer.from([2]), i32le(99), inner]))]);
  throwsCode(() => bsonDocumentToCanonical(bad), ERROR_CODES.INVALID_BINARY);
});

test("undefined, code and symbol use canonical v2 shapes", () => {
  const buf = bdoc([
    elem(0x06, "u", Buffer.alloc(0)),
    elem(0x0d, "c", cstr("x = 1")),
    elem(0x0e, "s", cstr("sym")),
  ]);
  assert.deepEqual(bsonDocumentToCanonical(buf), {
    u: { $undefined: true },
    c: { $code: "x = 1" },
    s: { $symbol: "sym" },
  });
});

test("every emitted document is accepted by the sanitizer contract parser", () => {
  const buf = bdoc([
    eStr("unit", "kg"),
    eDouble("qty", 2.5),
    eInt32("count", 3),
    eInt64("big", 9007199254740993n),
    eDate("at", 1700000000123),
    eDoc("snap", [eDouble("currentStock", 4), eStr("unit", "kg")]),
    eArr("lines", [rDocN([eStr("lineId", "x")])]),
  ]);
  assert.doesNotThrow(() => parseCanonicalValue(bsonDocumentToCanonical(buf), "root"));
});

// ---------------------------------------------------------------------------
// Fail-closed framing and type errors
// ---------------------------------------------------------------------------
test("rejects non-buffer input", () => {
  throwsCode(() => bsonDocumentToCanonical("not a buffer"), ERROR_CODES.INVALID_INPUT);
});

test("rejects a document shorter than the minimum length", () => {
  throwsCode(() => bsonDocumentToCanonical(Buffer.concat([i32le(4), Buffer.from([0])])),
    ERROR_CODES.INVALID_FRAMING);
});

test("rejects a truncated document", () => {
  const valid = bdoc([eStr("a", "hello")]);
  throwsCode(() => bsonDocumentToCanonical(valid.subarray(0, valid.length - 2)),
    ERROR_CODES.INVALID_LENGTH);
});

test("rejects a missing terminator", () => {
  const buf = bdoc([eStr("a", "x")]);
  buf[buf.length - 1] = 0x01;
  throwsCode(() => bsonDocumentToCanonical(buf), ERROR_CODES.INVALID_FRAMING);
});

test("rejects trailing bytes after a single document", () => {
  const buf = Buffer.concat([bdoc([eNull("a")]), Buffer.from([0])]);
  throwsCode(() => bsonDocumentToCanonical(buf), ERROR_CODES.TRAILING_BYTES);
});

test("rejects duplicate field names", () => {
  const buf = bdoc([elem(0x10, "a", i32le(1)), elem(0x10, "a", i32le(2))]);
  throwsCode(() => bsonDocumentToCanonical(buf), ERROR_CODES.DUPLICATE_FIELD);
});

test("rejects non-sequential array keys", () => {
  const buf = bdoc([elem(0x04, "arr", bdoc([elem(0x02, "0", spay("a")), elem(0x02, "2", spay("b"))]))]);
  throwsCode(() => bsonDocumentToCanonical(buf), ERROR_CODES.INVALID_ARRAY_KEY);
});

test("rejects unsupported BSON type bytes", () => {
  const buf = bdoc([elem(0x42, "x", Buffer.alloc(0))]);
  throwsCode(() => bsonDocumentToCanonical(buf), ERROR_CODES.UNSUPPORTED_TYPE);
});

test("rejects invalid UTF-8 in strings", () => {
  const buf = bdoc([elem(0x02, "s", Buffer.concat([i32le(3), Buffer.from([0xc3, 0x28]), Buffer.from([0])]))]);
  throwsCode(() => bsonDocumentToCanonical(buf), ERROR_CODES.INVALID_UTF8);
});

test("rejects invalid boolean bytes", () => {
  throwsCode(() => bsonDocumentToCanonical(bdoc([elem(0x08, "b", Buffer.from([2]))])),
    ERROR_CODES.INVALID_BOOLEAN);
});

test("rejects invalid string lengths and missing string terminators", () => {
  throwsCode(() => bsonDocumentToCanonical(bdoc([elem(0x02, "s", i32le(0))])),
    ERROR_CODES.INVALID_STRING);
  const noNul = bdoc([elem(0x02, "s", Buffer.concat([i32le(3), Buffer.from("abc")]))]);
  throwsCode(() => bsonDocumentToCanonical(noNul), ERROR_CODES.INVALID_STRING);
});

test("rejects a string whose length overruns the document", () => {
  const buf = bdoc([elem(0x02, "s", Buffer.concat([i32le(100), Buffer.from("a\0")]))]);
  throwsCode(() => bsonDocumentToCanonical(buf), ERROR_CODES.INVALID_LENGTH);
});

test("rejects datetimes outside the ISO-8601 representable range", () => {
  const buf = bdoc([elem(0x09, "d", i64le(8640000000000001n))]);
  throwsCode(() => bsonDocumentToCanonical(buf), ERROR_CODES.INVALID_DATE);
});

test(`rejects nesting deeper than ${MAX_DEPTH}`, () => {
  let doc = bdoc([eNull("leaf")]);
  for (let i = 0; i <= MAX_DEPTH + 1; i += 1) doc = bdoc([elem(0x03, "n", doc)]);
  throwsCode(() => bsonDocumentToCanonical(doc), ERROR_CODES.DEPTH_EXCEEDED);
});

// ---------------------------------------------------------------------------
// Stream conversion
// ---------------------------------------------------------------------------
test("stream conversion: one NDJSON line per document, LF only, trailing LF", () => {
  const stream = Buffer.concat([bdoc([eStr("a", "1")]), bdoc([eStr("a", "2")])]);
  const ndjson = bsonStreamToNdjson(stream);
  assert.equal(ndjson, '{"a":"1"}\n{"a":"2"}\n');
  assert.ok(!ndjson.includes("\r"));
  assert.equal(bsonStreamToCanonicalDocuments(stream).length, 2);
});

test("stream conversion: empty input yields an empty file (valid empty collection)", () => {
  assert.equal(bsonStreamToNdjson(Buffer.alloc(0)), "");
  assert.deepEqual(bsonStreamToCanonicalDocuments(Buffer.alloc(0)), []);
});

test("stream conversion: malformed trailing document fails closed", () => {
  const stream = Buffer.concat([bdoc([eNull("a")]), Buffer.from([10, 0, 0])]);
  throwsCode(() => bsonStreamToNdjson(stream), ERROR_CODES.INVALID_LENGTH);
});

// ---------------------------------------------------------------------------
// Export-script safety (pure argument parser; no driver, no connection)
// ---------------------------------------------------------------------------
test("export script refuses to run without the explicit confirmation flag", () => {
  const parsed = parseArgs(["--output", "out"], {});
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /confirm-read-only-export/);
});

test("export script refuses to run without a runtime-supplied URI", () => {
  const parsed = parseArgs(["--output", "out", CONFIRM_FLAG], {});
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /no URI supplied at runtime/);
});

test("export script accepts a URI from the dedicated environment variable only", () => {
  const parsed = parseArgs(["--output", "out", CONFIRM_FLAG],
    { BONO_EXPORT_URI: "mongodb://readonly@localhost:27017/hotel_management" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.uri, "mongodb://readonly@localhost:27017/hotel_management");
  assert.equal(parsed.config.database, APPROVED_DATABASE);
});

test("export script accepts --uri with CLI precedence over the environment", () => {
  const parsed = parseArgs(
    ["--output", "out", CONFIRM_FLAG, "--uri", "mongodb+srv://readonly@cluster.example/hotel_management"],
    { BONO_EXPORT_URI: "mongodb://ignored@localhost/x" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.uri, "mongodb+srv://readonly@cluster.example/hotel_management");
});

test("export script rejects non-mongodb URI schemes", () => {
  const parsed = parseArgs(["--output", "out", CONFIRM_FLAG, "--uri", "https://example.com"], {});
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /mongodb/);
});

test("export script rejects unknown flags such as a different database", () => {
  const parsed = parseArgs(["--output", "out", CONFIRM_FLAG, "--database", "other_db"], {});
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /unknown argument: --database/);
});

test("export script validates --batch-size", () => {
  for (const value of ["0", "abc", "-1"]) {
    const parsed = parseArgs(["--output", "out", CONFIRM_FLAG, "--uri", "mongodb://x/y", "--batch-size", value], {});
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /batch-size/);
  }
});

test("export script targets exactly the six approved collections (frozen)", () => {
  assert.ok(Object.isFrozen(APPROVED_COLLECTIONS));
  assert.deepEqual([...APPROVED_COLLECTIONS], [
    "inventoryitems", "recipes", "stockmovements",
    "inventoryaudits", "inventoryreservations", "orders",
  ]);
  assert.equal(APPROVED_DATABASE, "hotel_management");
});

test("redactSecrets masks URIs and credential-shaped parameters", () => {
  const out = redactSecrets(
    "connect mongodb://alice:s3cret@db.example.com:27017/x?password=hunter2 failed; password=abc123");
  assert.ok(!out.includes("s3cret"));
  assert.ok(!out.includes("hunter2"));
  assert.ok(!out.includes("abc123"));
  assert.ok(out.includes("[redacted]"));
});

// ---------------------------------------------------------------------------
// Full synthetic pipeline: raw BSON -> NDJSON -> sanitizer -> validator
// ---------------------------------------------------------------------------
const oid = (pfx, n) => pfx + n.toString(16).padStart(20, "0");

const D128 = Decimal128.fromString("3.140");
const D128BYTES = D128.bytes ?? D128.toBytes();

const PIPELINE_DOCS = {
  inventoryitems: [
    bdoc([
      eOid("_id", oid("65a1", 1)),
      eStr("unit", "kg"),
      eDouble("currentStock", 5),
      eDouble("reservedStock", -0),
    ]),
    bdoc([
      eOid("_id", oid("65a1", 2)),
      eNull("unit"),
      elem(0x13, "currentStock", D128BYTES),
    ]),
  ],
  recipes: [
    bdoc([
      eOid("_id", oid("65b1", 1)),
      eArr("ingredients", [
        rDocN([eOid("inventoryItemId", oid("65a1", 1)), eStr("unit", "g"), eInt32("quantity", 500)]),
        rDocN([eOid("inventoryItemId", oid("65a1", 254)), eStr("unit", "ml"), eDouble("quantity", 1.5)]),
      ]),
      eBool("isActive", true),
    ]),
  ],
  stockmovements: [
    bdoc([
      eOid("item", oid("65a1", 1)), eStr("unit", "kg"), eDouble("quantity", 2.5),
      eStr("type", "IN"), eStr("reason", "purchase"),
    ]),
    bdoc([
      eOid("item", oid("65a1", 255)),
      eInt64("quantity", 9007199254740993n),
      eStr("type", "ADJ"),
    ]),
  ],
  inventoryaudits: [
    bdoc([
      eOid("item", oid("65a1", 1)), eStr("unit", "kg"), eStr("action", "ADJUST"),
      eDouble("quantityDelta", 1), eDouble("beforeStock", 4), eDouble("afterStock", 5),
      eDoc("beforeSnapshot", [eDouble("currentStock", 4), eStr("unit", "kg")]),
      eDoc("afterSnapshot", [eDouble("currentStock", 5), eStr("unit", "kg")]),
    ]),
    bdoc([
      eOid("item", oid("65a1", 1)), eStr("unit", " "), eStr("action", "RECOUNT"),
      eNull("beforeSnapshot"),
      eDoc("afterSnapshot", [eDouble("currentStock", 6), eDate("checkedAt", 1700000000123)]),
    ]),
  ],
  inventoryreservations: [
    bdoc([
      eOid("_id", oid("65d1", 1)), eOid("orderId", oid("65c1", 1)), eStr("status", "PENDING"),
      eArr("items", [
        rDocN([
          eOid("inventoryItemId", oid("65a1", 1)), eStr("unit", "kg"),
          eDouble("requiredQuantity", 2), eDouble("availableAtDecision", 1),
          eDouble("shortageQuantity", 1),
        ]),
      ]),
    ]),
  ],
  orders: [
    bdoc([
      eOid("_id", oid("65c1", 1)),
      eArr("items", [
        rDocN([
          eOid("lineId", oid("65e1", 1)),
          eArr("components", [
            rDocN([
              eStr("kind", "PRICED_COMPONENT"), eOid("componentId", oid("65f1", 1)),
              eOid("inventoryItemId", oid("65a1", 1)), eStr("stockUnit", "g"),
              eDouble("stockQuantity", 500),
            ]),
            rDocN([
              eStr("kind", "MENU_ITEM"), eOid("componentId", oid("65f1", 2)),
              eOid("inventoryItemId", oid("65a1", 1)),
            ]),
          ]),
        ]),
        rDocN([eOid("lineId", oid("65e1", 2))]),
      ]),
    ]),
  ],
};

const SYNTHETIC_KEY_HEX = "11".repeat(32); // public test constant, not a credential
const workDir = mkdtempSync(join(tmpdir(), "bono-bson-adapter-"));
const inputDir = join(workDir, "raw-ndjson");
const bundleDir = join(workDir, "bundle");

after(() => rmSync(workDir, { recursive: true, force: true }));

test("full pipeline: raw BSON -> canonical NDJSON -> sanitizer -> validator = BUNDLE ACCEPTED", () => {
  mkdirSync(inputDir, { recursive: true });
  for (const collection of APPROVED_COLLECTIONS) {
    const stream = Buffer.concat(PIPELINE_DOCS[collection]);
    // Adapter output is fed through the same file path the owner will use.
    writeFileSync(join(inputDir, `${collection}.ndjson`),
      bsonStreamToNdjson(stream), "utf8");
  }

  const manifest = runSanitizer({
    inputDir,
    outputDir: bundleDir,
    keyHex: SYNTHETIC_KEY_HEX,
    environmentLabel: "SYNTHETIC BSON ADAPTER TEST",
    timestamp: "2026-11-15T00:00:00.000Z",
  });

  // Counts flow through from the raw BSON.
  assert.equal(manifest.collections.inventoryitems.documentsRead, 2);
  assert.equal(manifest.collections.inventoryitems.documentsWritten, 2);
  assert.equal(manifest.collections.orders.documentsRead, 1);

  // Drift/unit counters derived from the preserved types.
  assert.equal(manifest.collections.inventoryitems.drift.decimal128Count, 1);
  assert.equal(manifest.collections.orders.drift.excludedComponentsCount, 1);
  assert.equal(manifest.collections.inventoryaudits.drift.nullSnapshotCount, 1);
  assert.ok(manifest.collections.recipes.orphans["ingredients[].inventoryItemId"]);
  assert.ok(manifest.collections.stockmovements.orphans.item);

  // -0 reached the sanitized bundle with its IEEE-754 big-endian hex.
  const items = readFileSync(join(bundleDir, "inventoryitems.ndjson"), "utf8");
  assert.match(items, /"reservedStock":0/);
  assert.match(items, /8000000000000000/);

  // Independent validator, fail-closed.
  const result = validateBundle(bundleDir);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test("full pipeline determinism: same raw bytes -> byte-identical bundle", () => {
  const docsByCollection = Object.fromEntries(APPROVED_COLLECTIONS.map((c) => [
    c,
    bsonStreamToCanonicalDocuments(Buffer.concat(PIPELINE_DOCS[c])).map((json, i) => ({ json, line: i + 1 })),
  ]));
  const run = () => sanitizeExport({
    docsByCollection,
    keyHex: SYNTHETIC_KEY_HEX,
    timestamp: "2026-11-15T00:00:00.000Z",
  });
  const a = run();
  const b = run();
  for (const c of APPROVED_COLLECTIONS) {
    assert.equal(a.bundle[c].text, b.bundle[c].text);
    assert.equal(a.manifest.collections[c].sha256, b.manifest.collections[c].sha256);
  }
});
