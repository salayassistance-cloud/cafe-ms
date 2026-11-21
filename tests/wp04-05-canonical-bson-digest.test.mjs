// WP04-05 L2 — canonical BSON digest tests (DB-FREE).
//
// These tests define the hash specification: distinct BSON types must never
// collapse into the same digest, and the same logical document must always hash
// identically regardless of key insertion order.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  Binary,
  BSONRegExp,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "bson";

import {
  CANONICAL_DIGEST_VERSION,
  CanonicalDigestError,
  DIGEST_TYPE_TAGS,
  digestCollection,
  digestDatabase,
  digestDocument,
  digestDocuments,
  encodeCanonicalBson,
  isSystemCollection,
} from "./integration/support/wp04-05/l2/canonicalBsonDigest.mjs";

const oidA = new ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
const oidB = new ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");

describe("canonical BSON digest — specification", () => {
  test("publishes a stable version and explicit type tags", () => {
    assert.equal(CANONICAL_DIGEST_VERSION, "wp04-05-canonical-bson-sha256-v1");
    assert.equal(new Set(Object.values(DIGEST_TYPE_TAGS)).size, Object.keys(DIGEST_TYPE_TAGS).length);
    for (const value of Object.values(DIGEST_TYPE_TAGS)) {
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xff);
    }
  });

  test("key insertion order never changes the digest", () => {
    assert.equal(digestDocument({ a: 2, b: 1 }), digestDocument({ b: 1, a: 2 }));
    assert.equal(
      digestDocument({ z: { b: 2, a: 1 }, a: [1, 2] }),
      digestDocument({ a: [1, 2], z: { a: 1, b: 2 } }),
    );
    assert.equal(digestDocument({ a: 1, B: 2 }), digestDocument({ B: 2, a: 1 }));
  });

  test("length prefixes prevent key/value boundary ambiguity", () => {
    assert.notEqual(digestDocument({ a: "bc" }), digestDocument({ ab: "c" }));
    assert.notEqual(digestDocument({ "": "x" }), digestDocument({ x: "" }));
  });

  test("array order is significant and array type is preserved", () => {
    assert.notEqual(digestDocument([1, 2]), digestDocument([2, 1]));
    assert.notEqual(digestDocument([1]), digestDocument({ 0: 1 }));
  });

  test("null, missing and undefined are distinct", () => {
    assert.notEqual(digestDocument({ a: null }), digestDocument({}));
    assert.notEqual(digestDocument({ a: null }), digestDocument({ a: undefined }));
    assert.notEqual(digestDocument({}), digestDocument({ a: undefined }));
  });

  test("nested objects and arrays are encoded recursively", () => {
    const left = { a: [{ b: [1, { c: null }] }] };
    const right = { a: [{ b: [1, { c: null }] }] };
    assert.equal(digestDocument(left), digestDocument(right));
    assert.notEqual(digestDocument(left), digestDocument({ a: [{ b: [1, { c: 0 }] }] }));
  });
});

describe("canonical BSON digest — BSON type fidelity", () => {
  test("ObjectId is encoded as 12 raw bytes", () => {
    assert.equal(digestDocument({ id: oidA }), digestDocument({ id: new ObjectId(oidA.toHexString()) }));
    assert.notEqual(digestDocument({ id: oidA }), digestDocument({ id: oidB }));
    assert.notEqual(digestDocument({ id: oidA }), digestDocument({ id: oidA.toHexString() }));
    assert.deepEqual(encodeCanonicalBson(oidA).subarray(1, 13), oidA.id);
  });

  test("Date is encoded as int64 epoch milliseconds", () => {
    const at = new Date("2026-11-10T12:00:00.000Z");
    assert.equal(digestDocument({ at }), digestDocument({ at: new Date(at.getTime()) }));
    assert.notEqual(digestDocument({ at }), digestDocument({ at: new Date(at.getTime() + 1) }));
    assert.notEqual(digestDocument({ at }), digestDocument({ at: at.toISOString() }));
  });

  test("Int32, Double and Long never collide", () => {
    const int32 = digestDocument({ n: new Int32(1) });
    const double = digestDocument({ n: new Double(1) });
    const long = digestDocument({ n: Long.fromNumber(1) });
    assert.notEqual(int32, double);
    assert.notEqual(int32, long);
    assert.notEqual(double, long);
    assert.equal(double, digestDocument({ n: 1 }));
    assert.equal(long, digestDocument({ n: 1n }));
  });

  test("Decimal128 keeps its exact BSON representation", () => {
    assert.equal(digestDocument({ d: new Decimal128("1.5") }), digestDocument({ d: new Decimal128("1.5") }));
    assert.notEqual(digestDocument({ d: new Decimal128("1.5") }), digestDocument({ d: new Decimal128("2.5") }));
    // "1.50" has a different exponent/coefficient encoding than "1.5".
    assert.notEqual(digestDocument({ d: new Decimal128("1.5") }), digestDocument({ d: new Decimal128("1.50") }));
  });

  test("Binary preserves content and subtype", () => {
    const binary = new Binary(Buffer.from("abc"), 4);
    assert.equal(digestDocument({ b: binary }), digestDocument({ b: new Binary(Buffer.from("abc"), 4) }));
    assert.notEqual(digestDocument({ b: binary }), digestDocument({ b: new Binary(Buffer.from("abd"), 4) }));
    assert.notEqual(digestDocument({ b: binary }), digestDocument({ b: new Binary(Buffer.from("abc"), 0) }));
    assert.equal(digestDocument({ b: Buffer.from("abc") }), digestDocument({ b: new Binary(Buffer.from("abc"), 0) }));
  });

  test("Timestamp, MinKey, MaxKey, regex, symbol, code and DBRef are typed", () => {
    assert.notEqual(
      digestDocument({ t: new Timestamp({ t: 1, i: 2 }) }),
      digestDocument({ t: new Timestamp({ t: 2, i: 1 }) }),
    );
    assert.notEqual(digestDocument({ k: new MinKey() }), digestDocument({ k: new MaxKey() }));
    // A JS RegExp and a BSONRegExp both serialise to the same BSON regex type.
    assert.equal(digestDocument({ r: new BSONRegExp("a", "i") }), digestDocument({ r: /a/i }));
    assert.notEqual(digestDocument({ r: new BSONRegExp("a", "i") }), digestDocument({ r: /b/i }));
    assert.notEqual(digestDocument({ c: new Code("x") }), digestDocument({ c: new Code("x", { a: 1 }) }));
    assert.equal(
      digestDocument({ d: new DBRef("orders", oidA, "db") }),
      digestDocument({ d: new DBRef("orders", oidA, "db") }),
    );
    assert.notEqual(digestDocument({ d: new DBRef("orders", oidA) }), digestDocument({ d: new DBRef("orders", oidB) }));
  });

  test("NaN is canonicalised; -0 equals +0; infinities stay distinct", () => {
    assert.equal(digestDocument({ n: NaN }), digestDocument({ n: NaN }));
    assert.equal(digestDocument({ n: -0 }), digestDocument({ n: 0 }));
    assert.notEqual(digestDocument({ n: NaN }), digestDocument({ n: Infinity }));
    assert.notEqual(digestDocument({ n: Infinity }), digestDocument({ n: -Infinity }));
  });

  test("unsupported values fail closed instead of colliding", () => {
    for (const value of [new Map(), new Set(), () => {}, Symbol("x")]) {
      assert.throws(() => digestDocument({ value }), CanonicalDigestError);
    }
    class Custom {
      constructor() {
        this.a = 1;
      }
    }
    assert.throws(() => digestDocument({ custom: new Custom() }), /UNSUPPORTED_OBJECT/);
  });
});

describe("canonical BSON digest — collection and database construction", () => {
  test("collection digest is independent of document order but sensitive to duplicates", () => {
    const a = { _id: oidA, value: 1 };
    const b = { _id: oidB, value: 2 };
    const left = digestCollection({ name: "orders", documents: [a, b] });
    const right = digestCollection({ name: "orders", documents: [b, a] });
    assert.equal(left, right);
    assert.notEqual(left, digestCollection({ name: "orders", documents: [a, b, a] }));
    assert.notEqual(left, digestCollection({ name: "not-orders", documents: [a, b] }));
  });

  test("document multiset digest is deterministic", () => {
    const docs = [{ a: 1 }, { a: 2 }, { a: 1 }];
    assert.equal(digestDocuments(docs), digestDocuments([{ a: 2 }, { a: 1 }, { a: 1 }]));
    assert.notEqual(digestDocuments(docs), digestDocuments([{ a: 1 }, { a: 2 }]));
  });

  test("system.* collections are excluded and rejected explicitly", () => {
    assert.equal(isSystemCollection("system.users"), true);
    assert.equal(isSystemCollection("orders"), false);
    assert.throws(
      () => digestCollection({ name: "system.users", documents: [] }),
      /SYSTEM_COLLECTION/,
    );
    const user = digestCollection({ name: "orders", documents: [{ a: 1 }] });
    assert.equal(
      digestDatabase([
        { name: "orders", documents: [{ a: 1 }] },
        { name: "system.users", documents: [{ user: "x" }] },
      ]),
      digestDatabase([{ name: "orders", documents: [{ a: 1 }] }]),
    );
    assert.notEqual(user, digestDatabase([{ name: "orders", documents: [{ a: 1 }] }]));
  });

  test("the encoded stream is stable and self-delimiting", () => {
    const encoded = encodeCanonicalBson({ a: 1, b: [true, null] });
    assert.ok(Buffer.isBuffer(encoded));
    assert.equal(encoded.toString("hex"), encodeCanonicalBson({ b: [true, null], a: 1 }).toString("hex"));
    assert.equal(digestDocument({ a: 1 }), digestDocument({ a: 1 }));
  });
});
