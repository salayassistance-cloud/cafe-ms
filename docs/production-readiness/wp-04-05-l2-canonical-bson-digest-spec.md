# WP04-05 L2 — Canonical BSON SHA-256 Digest Specification (v1)

Status: test-only tooling specification. Not an application contract.
Owner approval: 2026-11-14 (bounded L2 supplementary proof).
Implementation: `tests/integration/support/wp04-05/l2/canonicalBsonDigest.mjs`

This document records the exact raw-document canonicalization and digest
construction used by the WP04-05 L2 tooling. It is intentionally independent of
`lib/recovery/fingerprint.js`: the fingerprint hashes a **projected evidence**
object, while this utility hashes **raw driver documents** and preserves BSON
type identity.

---

## 1. Purpose and scope

The digest answers one question deterministically:

> Given the same logical BSON document, does the byte-level value and type set
> hash identically across runs and storage round-trips, without collapsing
> distinct BSON types into one representation?

It is used by the L2 verifier to detect count, value and index changes between a
pre-scan and post-scan snapshot of a disposable database. It is never used to
mutate data, classify findings, or decide recovery actions.

Non-goals:

- no schema validation;
- no business-rule interpretation;
- no encryption or signature (SHA-256 is a collision-resistant content digest,
  not an authenticator);
- no substitute for `lib/recovery/fingerprint.js` in the scanner path.

---

## 2. Canonical encoding (v1)

A value is encoded into a self-delimiting byte stream. Every value begins with a
one-byte type tag. Objects and arrays are length-prefixed. Object keys are sorted
by their **UTF-8 byte sequence** (not locale collation). Every string is prefixed
with its UTF-8 byte length.

### 2.1 Type tags

| Tag | Type | Payload |
| --- | --- | --- |
| `0x00` | `undefined` | none |
| `0x01` | `null` | none |
| `0x02` | object | `u32` member count, then per member: `u32` key byte length + key bytes + encoded value, sorted by key |
| `0x03` | array | `u32` element count, then encoded value per element in index order |
| `0x04` | double | 8-byte IEEE-754 big-endian |
| `0x05` | int32 | 4-byte signed big-endian |
| `0x06` | int64 | 8-byte signed big-endian |
| `0x07` | decimal128 | 16 raw BSON bytes |
| `0x08` | binary | `u8` subtype, `u32` length, bytes |
| `0x09` | ObjectId | 12 raw bytes |
| `0x0a` | boolean | `u8` 0 or 1 |
| `0x0b` | date | `int64` epoch milliseconds |
| `0x0c` | timestamp | `u32` `t`, `u32` `i` |
| `0x0d` | string | `u32` UTF-8 byte length, bytes |
| `0x0e` | regex | string pattern, string options |
| `0x0f` | MinKey | none |
| `0x10` | MaxKey | none |
| `0x11` | symbol | string |
| `0x12` | code | string |
| `0x13` | code-with-scope | string code, encoded scope object |
| `0x14` | DBRef | string collection, string db, encoded ObjectId |

### 2.2 Numeric policy

- A plain JavaScript `number` is encoded as **`0x04` double**. The driver cannot
  distinguish an original Int32 from a Double after value promotion, so the
  canonical encoder never guesses.
- `BSON.Int32` is `0x05`, `BSON.Double` is `0x04`, `BSON.Long` is `0x06`.
  Therefore `Int32(1)`, `Double(1)` and `Long(1)` produce **different** digests.
- `bigint` is encoded as `0x06` int64.
- `-0` is normalized to `+0`.
- `NaN` is canonicalized to the fixed 8-byte pattern `7ff8000000000000`.
- `+Infinity` and `-Infinity` retain their IEEE-754 encodings and never collide
  with `NaN`.
- `Decimal128` is never parsed to a floating-point value; its exact 16 BSON bytes
  are hashed. `"1.5"` and `"1.50"` therefore differ.
- The L2 verifier reads documents with `promoteValues: false` so wire types
  survive the read. Reading with promotion enabled would legitimately erase the
  Int32/Double distinction and is not used for digests.

### 2.3 Null, missing and undefined

These are three distinct states:

| State | Contribution |
| --- | --- |
| `{ a: null }` | key `a` present, value tag `0x01` |
| `{ a: undefined }` | key `a` present, value tag `0x00` |
| `{}` | key `a` absent, **nothing** emitted for `a` |

The member count in the parent object also differs when a key is absent, so
missing vs null vs undefined can never collide.

### 2.4 ObjectId, dates, binary

- ObjectId: exactly the 12 raw bytes (`value.id`), not the 24-hex string. A
  string that merely looks like an ObjectId hashes as a string and differs.
- Date: `int64` epoch milliseconds. An ISO string with the same instant hashes
  as a string and differs.
- Binary: content plus BSON subtype. `Binary(content, 4)` (UUID) differs from
  `Binary(content, 0)` (generic) even with identical bytes. A Node `Buffer` or
  `Uint8Array` is encoded as subtype `0`.
- `UUID` is treated like `Binary` and preserves its subtype and 16 bytes.

### 2.5 Arrays and nested objects

- Array order is significant: `[1, 2]` and `[2, 1]` differ.
- An array is never confused with an object whose keys are `"0"`, `"1"`, etc.
- Nested objects are encoded recursively; the same key-sorting rule applies at
  every depth.

### 2.6 Key-order normalization

`{ a: 2, b: 1 }` and `{ b: 1, a: 2 }` hash identically. Keys are compared as raw
UTF-8 bytes, so ordering is stable across platforms and locales. Length prefixes
on both keys and string values prevent boundary ambiguity, e.g.
`{ a: "bc" }` differs from `{ ab: "c" }`.

### 2.7 Unsupported values fail closed

The encoder throws `CanonicalDigestError` rather than coercing:

- `Map`, `Set`, functions, symbols in unsupported positions;
- non-plain objects with a custom prototype;
- malformed ObjectId/Binary/Decimal128 values;
- invalid `Date` (`NaN` epoch);
- unknown `_bsontype` values.

Error codes include `UNSUPPORTED_OBJECT`, `UNSUPPORTED_BSON_TYPE`,
`UNSUPPORTED_JS_TYPE`, `INVALID_DATE`, `INVALID_OBJECTID`, `INVALID_BINARY`,
`INVALID_DECIMAL128`, and `SYSTEM_COLLECTION`.

---

## 3. Digest construction

### 3.1 Per-document digest

```
documentDigest = SHA-256( canonicalEncode(document) )      // lowercase hex
```

### 3.2 Multiset of documents

`digestDocuments(documents)` sorts the per-document digests lexicographically and
hashes the newline-joined result. Duplicates are preserved, so a multiset with a
repeated document differs from a set with one copy.

### 3.3 Per-collection digest

```
collectionDigest = SHA-256(
  "wp04-05:collection:v1\0" || collectionName || "\0" ||
  join("\n", sorted(documentDigests))
)
```

- The collection name is bound into the hash, so identical documents in
  different collections do not collide.
- Document insertion order is irrelevant; duplicate documents still matter.
- `system.*` collections are rejected explicitly by `digestCollection` and
  filtered out by `digestDatabase`.

### 3.4 Database digest

```
databaseDigest = SHA-256(
  "wp04-05:database:v1\0" ||
  join("\n", sorted(`${collectionName}:${collectionDigest}`))
)
```

`digestDatabaseFromDigests(entries)` accepts precomputed collection digests and
validates that each name is non-empty, each digest is a lowercase 64-hex
SHA-256, and no entry is a `system.*` collection.

### 3.5 Exclusions

- `admin`, `local` and `config` are **not** read by the snapshot at all; the
  snapshot only enumerates the designated disposable database.
- Within that database, collections whose names begin with `system.` are
  excluded from inventory and digests.
- The digest never includes the database name, host, port, credentials, or
  cluster metadata. Those are identity checks elsewhere.

---

## 4. Determinism guarantees

- Key order is normalized recursively.
- Numeric type tags are explicit.
- NaN and signed zero are canonicalized.
- Duplicate documents are counted.
- Collection and database lines are sorted.
- No clock, randomness, locale, or environment value enters the encoding.
- The same in-memory value and the same wire value produce the same digest,
  provided the wire value is read with `promoteValues: false`.

A plain JS integer and the Int32 it serializes to do **not** hash identically by
construction. Callers comparing a fixture plan to stored documents must
normalize the plan through BSON serialization first; the integration test does
exactly this.

---

## 5. Verification usage

`l2Verifier.mjs` computes, for each user collection:

- document count;
- canonical collection digest;
- index inventory (name, key, unique, sparse, partial filter) and its digest.

It then compares a pre-scan and post-scan snapshot. Detected change codes:

- `COLLECTION_SET_CHANGED`
- `COUNT_CHANGED`
- `DOCUMENT_DIGEST_CHANGED`
- `INDEX_SET_CHANGED`
- `TOTAL_COUNT_CHANGED`
- `DATABASE_DIGEST_CHANGED`
- `INDEX_INVENTORY_DIGEST_CHANGED`
- `DATABASE_IDENTITY_CHANGED`

The verifier also checks scanner-report read-only flags, absence of recovery-task
creation, D01–D10 coverage, deterministic repeat runs, and redaction.

---

## 6. Test coverage

DB-free specification tests:
`tests/wp04-05-canonical-bson-digest.test.mjs`

They cover key-order normalization, length-prefix ambiguity, arrays, null vs
missing vs undefined, nested objects, ObjectId, Date, Int32/Double/Long,
Decimal128 precision, binary subtype, Timestamp, MinKey/MaxKey, regex, code,
DBRef, NaN/signed zero, unsupported values, collection/database construction,
duplicate sensitivity, and `system.*` exclusion.

Disposable integration test:
`tests/integration/wp04-05-l2-tooling.integration.test.mjs`

It additionally proves the seeded wire documents hash identically to BSON-
normalized plan documents, and that pre/post snapshots detect count, value and
index tampering while a read-only scan leaves the database unchanged.
