// WP04-06 — DB-free OP_MSG parser and demultiplexer unit tests.
//
// These tests do not start mongod, open a socket, connect to MongoDB, read an
// environment file, or import the T2 proxy/runner. They exercise only the pure
// wire parser and the source boundaries of the authored harness.
//
// A passing result here is parser evidence only. It is NOT T2/P1-P6 evidence and
// does not close T2, BLK-T2-01, or BLK-UC-01/02.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { serialize } from "bson";

import {
  DEFAULT_MAX_MESSAGE_BYTES,
  OP_MSG_OPCODE,
  OpMsgParseError,
  OpMsgStreamDemultiplexer,
  classifyOpMsgFrame,
  isCommitTransactionFrame,
  parseOpMsgFrame,
  parseOpMsgHeader,
  validateMessageLength
} from "./integration/support/opmsg.mjs";

const SUPPORT_DIR = fileURLToPath(new URL("./integration/support/", import.meta.url));
const TESTS_DIR = fileURLToPath(new URL("./", import.meta.url));

function buildOpMsg({
  requestID = 1,
  responseTo = 0,
  command = { ping: 1 },
  flags = 0,
  extraSections = []
} = {}) {
  const bodyDocument = serialize(command);
  const body = Buffer.concat([Buffer.from([0]), bodyDocument, ...extraSections]);
  const messageLength = 16 + 4 + body.length;

  const header = Buffer.alloc(16);
  header.writeInt32LE(messageLength, 0);
  header.writeInt32LE(requestID, 4);
  header.writeInt32LE(responseTo, 8);
  header.writeInt32LE(OP_MSG_OPCODE, 12);

  const flagBits = Buffer.alloc(4);
  flagBits.writeUInt32LE(flags, 0);

  return Buffer.concat([header, flagBits, body]);
}

function buildKind1Section(identifier, documents) {
  const identifierBytes = Buffer.from(`${identifier}\0`, "utf8");
  const documentBytes = Buffer.concat(documents.map((doc) => serialize(doc)));
  const sectionSize = 4 + identifierBytes.length + documentBytes.length;
  const sizeBytes = Buffer.alloc(4);
  sizeBytes.writeInt32LE(sectionSize, 0);
  return Buffer.concat([
    Buffer.from([1]),
    sizeBytes,
    identifierBytes,
    documentBytes
  ]);
}

function bodyDocumentOffset() {
  return 16 + 4 + 1;
}

test("parses a valid OP_MSG ping frame", () => {
  const raw = buildOpMsg({ requestID: 11, command: { ping: 1 } });
  const frame = parseOpMsgFrame(raw);

  assert.equal(frame.messageLength, raw.length);
  assert.equal(frame.requestID, 11);
  assert.equal(frame.responseTo, 0);
  assert.equal(frame.opCode, OP_MSG_OPCODE);
  assert.equal(frame.body.firstKey, "ping");
  assert.equal(frame.command.name, "ping");
  assert.equal(frame.command.isCommit, false);
  assert.equal(frame.sections.length, 1);
  assert.equal(frame.sections[0].kind, 0);
});

test("parses the 16-byte header without inspecting the body", () => {
  const raw = buildOpMsg({ requestID: 22, responseTo: 7, command: { ping: 1 } });
  const header = parseOpMsgHeader(raw);

  assert.deepEqual(header, {
    messageLength: raw.length,
    requestID: 22,
    responseTo: 7,
    opCode: OP_MSG_OPCODE
  });
});

test("rejects an incomplete 16-byte header", () => {
  assert.throws(
    () => parseOpMsgFrame(Buffer.alloc(10)),
    (error) => error.code === "INCOMPLETE_HEADER"
  );
  assert.throws(
    () => parseOpMsgHeader(Buffer.alloc(10)),
    (error) => error.code === "TRUNCATED_INPUT"
  );
});

test("classifies commitTransaction from the parsed command name", () => {
  const raw = buildOpMsg({
    requestID: 33,
    command: { commitTransaction: 1, lsid: { id: "x" } }
  });
  const frame = parseOpMsgFrame(raw);

  assert.equal(frame.command.name, "commitTransaction");
  assert.equal(classifyOpMsgFrame(frame).isCommit, true);
  assert.equal(isCommitTransactionFrame(frame), true);
});

test("does not classify a non-commit command whose payload contains commitTransaction", () => {
  const command = {
    find: "commitTransaction",
    filter: { note: "commitTransaction", text: "commitTransaction" },
    comment: "commitTransaction"
  };
  const raw = buildOpMsg({ requestID: 44, command });

  // The raw payload really does contain the substring.
  assert.equal(raw.includes(Buffer.from("commitTransaction")), true);

  const frame = parseOpMsgFrame(raw);
  assert.equal(frame.command.name, "find");
  assert.equal(classifyOpMsgFrame(frame).isCommit, false);
  assert.equal(isCommitTransactionFrame(frame), false);
});

test("does not classify commitTransaction found only in a kind-1 document sequence", () => {
  const raw = buildOpMsg({
    requestID: 45,
    command: { insert: "audit", documents: [] },
    extraSections: [buildKind1Section("documents", [{ commitTransaction: 1 }])]
  });

  const frame = parseOpMsgFrame(raw);
  assert.equal(frame.command.name, "insert");
  assert.equal(frame.command.isCommit, false);
  assert.equal(frame.sections.length, 2);
  assert.equal(frame.sections[1].kind, 1);
  assert.equal(frame.sections[1].identifier, "documents");
  assert.equal(frame.sections[1].documents[0].firstKey, "commitTransaction");
});

test("parses a kind-1 document sequence alongside a kind-0 body", () => {
  const raw = buildOpMsg({
    requestID: 46,
    command: { insert: "audit", documents: [] },
    extraSections: [
      buildKind1Section("documents", [{ _id: 1, note: "a" }, { _id: 2, note: "b" }])
    ]
  });

  const frame = parseOpMsgFrame(raw);
  assert.equal(frame.sections[1].documents.length, 2);
  assert.deepEqual(frame.sections[1].documents.map((doc) => doc.firstKey), ["_id", "_id"]);
});

test("parses a checksum-present frame without trusting the checksum", () => {
  const base = buildOpMsg({ requestID: 47, command: { ping: 1 } });
  const raw = Buffer.concat([base, Buffer.alloc(4, 0xab)]);
  raw.writeUInt32LE(1, 16);
  raw.writeInt32LE(raw.length, 0);

  const frame = parseOpMsgFrame(raw);
  assert.equal(frame.flags.checksumPresent, true);
  assert.equal(frame.checksumVerified, false);
  assert.equal(frame.command.name, "ping");
});

test("rejects a message length below the minimum before header inspection", () => {
  const demux = new OpMsgStreamDemultiplexer();
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(10, 0);

  const result = demux.push(prefix);
  assert.equal(result.frames.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "INVALID_MESSAGE_LENGTH");
  assert.equal(result.poisoned, true);
  assert.equal(result.pendingBytes, 0);
});

test("rejects an oversized message length before buffering the frame", () => {
  const demux = new OpMsgStreamDemultiplexer();
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(DEFAULT_MAX_MESSAGE_BYTES + 1, 0);

  const result = demux.push(prefix);
  assert.equal(result.frames.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "OVERSIZED_MESSAGE");
  assert.equal(result.poisoned, true);
});

test("validateMessageLength rejects negative, small, and oversized values", () => {
  assert.equal(validateMessageLength(-1)?.code, "INVALID_MESSAGE_LENGTH");
  assert.equal(validateMessageLength(24)?.code, "INVALID_MESSAGE_LENGTH");
  assert.equal(validateMessageLength(25)?.code, "INVALID_MESSAGE_LENGTH");
  assert.equal(validateMessageLength(DEFAULT_MAX_MESSAGE_BYTES + 1)?.code, "OVERSIZED_MESSAGE");
  assert.equal(validateMessageLength(26), null);
});

test("accepts the 26-byte minimum OP_MSG frame with an empty body document", () => {
  const raw = buildOpMsg({ requestID: 24, command: {} });
  assert.equal(raw.length, 26);

  const frame = parseOpMsgFrame(raw);
  assert.equal(frame.messageLength, 26);
  assert.equal(frame.body.firstKey, null);
  assert.equal(frame.command, null);
  assert.equal(isCommitTransactionFrame(frame), false);
});

test("rejects a supplied frame whose length differs from the header", () => {
  const raw = Buffer.concat([buildOpMsg({ requestID: 55 }), Buffer.from([0])]);
  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error instanceof OpMsgParseError && error.code === "LENGTH_MISMATCH"
  );
});

test("rejects a non-OP_MSG opcode", () => {
  const raw = buildOpMsg({ requestID: 56 });
  raw.writeInt32LE(2012, 12);
  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "UNSUPPORTED_OPCODE"
  );
});

test("rejects unknown OP_MSG flag bits", () => {
  const raw = buildOpMsg({ requestID: 57, flags: 0x00020000 });
  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "UNSUPPORTED_FLAGS"
  );
});

test("rejects an unknown section kind", () => {
  const raw = buildOpMsg({ requestID: 58 });
  raw[20] = 2;
  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "UNSUPPORTED_SECTION_KIND"
  );
});

test("rejects a malformed BSON document length", () => {
  const raw = buildOpMsg({ requestID: 59 });
  raw.writeInt32LE(3, bodyDocumentOffset());
  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "INVALID_BSON_LENGTH"
  );
});

test("rejects a truncated BSON document", () => {
  const raw = buildOpMsg({ requestID: 60 });
  raw.writeInt32LE(raw.length, bodyDocumentOffset());
  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "TRUNCATED_BSON_DOCUMENT"
  );
});

test("rejects a BSON document without a terminator", () => {
  const raw = buildOpMsg({ requestID: 61 });
  const docLength = raw.readInt32LE(bodyDocumentOffset());
  raw[bodyDocumentOffset() + docLength - 1] = 0x01;
  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "INVALID_BSON_TERMINATOR"
  );
});

test("rejects a kind-1 section with an invalid size", () => {
  const raw = buildOpMsg({
    requestID: 62,
    extraSections: [buildKind1Section("documents", [{ a: 1 }])]
  });
  const bodyDocLength = raw.readInt32LE(bodyDocumentOffset());
  const sectionOffset = bodyDocumentOffset() + bodyDocLength;
  raw.writeInt32LE(2, sectionOffset + 1);

  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "INVALID_SECTION_SIZE"
  );
});

test("rejects a kind-1 section with an empty identifier", () => {
  const raw = buildOpMsg({
    requestID: 63,
    extraSections: [buildKind1Section("", [{ a: 1 }])]
  });

  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "INVALID_SECTION_IDENTIFIER"
  );
});

test("handles fragmentation across the 16-byte header", () => {
  const raw = buildOpMsg({ requestID: 70, command: { ping: 1 } });
  const demux = new OpMsgStreamDemultiplexer();

  const first = demux.push(raw.subarray(0, 7));
  assert.equal(first.frames.length, 0);
  assert.equal(first.pendingBytes, 7);
  assert.equal(first.poisoned, false);

  const second = demux.push(raw.subarray(7, 15));
  assert.equal(second.frames.length, 0);
  assert.equal(second.pendingBytes, 15);

  const third = demux.push(raw.subarray(15));
  assert.equal(third.frames.length, 1);
  assert.equal(third.frames[0].requestID, 70);
  assert.equal(third.pendingBytes, 0);
});

test("handles fragmentation across the body", () => {
  const raw = buildOpMsg({ requestID: 71, command: { ping: 1 } });
  const split = bodyDocumentOffset() + 3;
  const demux = new OpMsgStreamDemultiplexer();

  const first = demux.push(raw.subarray(0, split));
  assert.equal(first.frames.length, 0);
  assert.equal(first.errors.length, 0);
  assert.equal(first.pendingBytes, split);

  const second = demux.push(raw.subarray(split));
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0].requestID, 71);
  assert.equal(second.pendingBytes, 0);
});

test("handles two coalesced frames in one TCP chunk", () => {
  const first = buildOpMsg({ requestID: 80, command: { ping: 1 } });
  const second = buildOpMsg({ requestID: 81, command: { hello: 1 } });
  const demux = new OpMsgStreamDemultiplexer();

  const result = demux.push(Buffer.concat([first, second]));
  assert.equal(result.frames.length, 2);
  assert.deepEqual(result.frames.map((frame) => frame.command.name), ["ping", "hello"]);
  assert.equal(result.pendingBytes, 0);
});

test("handles three coalesced frames plus a partial fourth", () => {
  const frames = [
    buildOpMsg({ requestID: 90, command: { ping: 1 } }),
    buildOpMsg({ requestID: 91, command: { hello: 1 } }),
    buildOpMsg({ requestID: 92, command: { isMaster: 1 } })
  ];
  const partial = buildOpMsg({ requestID: 93, command: { ping: 1 } }).subarray(0, 12);
  const demux = new OpMsgStreamDemultiplexer();

  const result = demux.push(Buffer.concat([...frames, partial]));
  assert.equal(result.frames.length, 3);
  assert.equal(result.pendingBytes, 12);
  assert.equal(result.errors.length, 0);
});

test("correlates a response to its request by responseTo", () => {
  const request = buildOpMsg({ requestID: 100, responseTo: 0, command: { ping: 1 } });
  const response = buildOpMsg({ requestID: 200, responseTo: 100, command: { ok: 1 } });
  const demux = new OpMsgStreamDemultiplexer();

  const result = demux.push(Buffer.concat([request, response]));
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[1].responseTo, 100);
  assert.equal(result.frames[1].correlatedRequest, result.frames[0]);
  assert.equal(result.frames[1].correlatedRequest.requestID, 100);
  assert.equal(demux.pendingRequestCount, 0);
});

test("reports an unknown response correlation without poisoning the stream", () => {
  const response = buildOpMsg({ requestID: 201, responseTo: 999, command: { ok: 1 } });
  const demux = new OpMsgStreamDemultiplexer();

  const result = demux.push(response);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].correlatedRequest, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "UNKNOWN_RESPONSE_CORRELATION");
  assert.equal(result.poisoned, false);
});

test("can suppress unknown-response warnings when correlation is not enforced", () => {
  const response = buildOpMsg({ requestID: 202, responseTo: 998, command: { ok: 1 } });
  const demux = new OpMsgStreamDemultiplexer({ enforceCorrelation: false });

  const result = demux.push(response);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].correlatedRequest, null);
  assert.equal(result.errors.length, 0);
  assert.equal(result.poisoned, false);
});

test("poisons the stream after a malformed frame and rejects later pushes", () => {
  const raw = buildOpMsg({ requestID: 203, command: { ping: 1 } });
  raw.writeInt32LE(3, bodyDocumentOffset());
  const demux = new OpMsgStreamDemultiplexer();

  const first = demux.push(raw);
  assert.equal(first.frames.length, 0);
  assert.equal(first.errors[0].code, "INVALID_BSON_LENGTH");
  assert.equal(first.poisoned, true);
  assert.equal(first.pendingBytes, 0);

  const second = demux.push(buildOpMsg({ requestID: 204, command: { ping: 1 } }));
  assert.equal(second.frames.length, 0);
  assert.equal(second.errors.length, 1);
  assert.equal(second.errors[0].code, "STREAM_POISONED");
  assert.equal(second.poisoned, true);
  assert.equal(second.pendingBytes, 0);
});

test("rejects a frame with two kind-0 body sections", () => {
  const base = buildOpMsg({ requestID: 205, command: { ping: 1 } });
  const extraBody = Buffer.concat([Buffer.from([0]), serialize({ ok: 1 })]);
  const raw = Buffer.concat([base, extraBody]);
  raw.writeInt32LE(raw.length, 0);

  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "DUPLICATE_BODY_SECTION"
  );
});

test("rejects a frame with no kind-0 body section", () => {
  const section = buildKind1Section("documents", [{ a: 1 }]);
  const messageLength = 16 + 4 + section.length;
  const header = Buffer.alloc(16);
  header.writeInt32LE(messageLength, 0);
  header.writeInt32LE(206, 4);
  header.writeInt32LE(0, 8);
  header.writeInt32LE(OP_MSG_OPCODE, 12);
  const raw = Buffer.concat([header, Buffer.alloc(4), section]);

  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "MISSING_BODY_SECTION"
  );
});

test("rejects BSON nesting beyond the parser depth limit", () => {
  let nested = { value: 1 };
  for (let index = 0; index < 40; index += 1) {
    nested = { nested };
  }
  const raw = buildOpMsg({ requestID: 207, command: { ping: 1, nested } });

  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "BSON_DEPTH_EXCEEDED"
  );
});

test("rejects an unsupported BSON value type", () => {
  const raw = buildOpMsg({ requestID: 208, command: { ping: 1 } });
  // First body element type byte follows the 4-byte document length.
  raw[bodyDocumentOffset() + 4] = 0x14;

  assert.throws(
    () => parseOpMsgFrame(raw),
    (error) => error.code === "UNSUPPORTED_BSON_TYPE"
  );
});

test("detects duplicate request IDs and poisons the stream", () => {
  const request = buildOpMsg({ requestID: 300, command: { ping: 1 } });
  const demux = new OpMsgStreamDemultiplexer();

  const result = demux.push(Buffer.concat([request, request]));
  assert.equal(result.frames.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "DUPLICATE_REQUEST_ID");
  assert.equal(result.poisoned, true);
});

test("leaves an incomplete frame buffered without classifying it", () => {
  const raw = buildOpMsg({ requestID: 400, command: { commitTransaction: 1 } });
  const demux = new OpMsgStreamDemultiplexer();

  const result = demux.push(raw.subarray(0, raw.length - 1));
  assert.equal(result.frames.length, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(result.pendingBytes, raw.length - 1);
  assert.equal(result.poisoned, false);
});

test("negative control: substring presence alone never drives commit classification", () => {
  const negative = parseOpMsgFrame(
    buildOpMsg({
      requestID: 500,
      command: {
        update: "orders",
        updates: [{ q: { note: "commitTransaction" }, u: { $set: { note: "commitTransaction" } } }],
        comment: "please do not commitTransaction here"
      }
    })
  );
  const positive = parseOpMsgFrame(
    buildOpMsg({ requestID: 501, command: { commitTransaction: 1 } })
  );

  assert.equal(negative.raw.includes(Buffer.from("commitTransaction")), true);
  assert.equal(isCommitTransactionFrame(negative), false);
  assert.equal(isCommitTransactionFrame(positive), true);
});

// ---------------------------------------------------------------------------
// Source boundaries for the authored harness.
// ---------------------------------------------------------------------------

function readSupportFile(name) {
  return readFileSync(`${SUPPORT_DIR}${name}`, "utf8");
}

test("parser source is dependency-free and has no database or network access", () => {
  const source = readSupportFile("opmsg.mjs");

  assert.equal(/\bfrom\s+["'](?:mongodb|mongoose|bson)["']/.test(source), false);
  assert.equal(/\brequire\(\s*["'](?:mongodb|mongoose|bson)["']\s*\)/.test(source), false);
  assert.equal(/\b(?:node:net|node:http|node:https|node:tls|node:dgram|node:fs)["']/.test(source), false);
  assert.equal(/\.includes\(\s*Buffer\.from\(\s*["']commitTransaction["']/.test(source), false);
});

test("P4 verifier source does not import or reference the proxy under test", () => {
  const source = readSupportFile("t2Verifier.mjs");

  assert.equal(/t2Proxy|commitAwareProxy|createCommitAwareProxy/.test(source), false);
  assert.match(source, /readConcern/);
  assert.match(source, /majority/);
  assert.match(source, /directConnection/);
});

test("T2 runner is guarded and the proxy classifies through the parser, not substrings", () => {
  const runner = readFileSync(`${TESTS_DIR}integration/wp04-06-t2-runner.mjs`, "utf8");
  const proxy = readSupportFile("t2Proxy.mjs");

  assert.match(runner, /--execute/);
  assert.match(runner, /isDirectExecution/);
  assert.match(runner, /createCommitAwareProxy/);
  assert.equal(/\.includes\(\s*Buffer\.from\(\s*["']commitTransaction["']/.test(runner), false);

  assert.match(proxy, /OpMsgStreamDemultiplexer/);
  assert.match(proxy, /isCommitTransactionFrame/);
  assert.equal(/\.includes\(\s*Buffer\.from\(\s*["']commitTransaction["']/.test(proxy), false);
});
