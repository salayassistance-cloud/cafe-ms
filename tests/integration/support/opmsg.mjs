// WP04-06 — Pure MongoDB wire frame parser and stream demultiplexer.
//
// AUTHORED FOR THE OFFLINE T2 HARNESS. THIS MODULE IS NOT PRODUCTION CODE.
//
// Safety properties:
// - No database, network, filesystem, or environment access.
// - No import of `mongodb`, `mongoose`, or `bson`; BSON is traversed locally.
// - Message length is validated from the first 4 bytes before any header,
//   section, BSON, or command inspection.
// - Command classification uses the parsed first key of the kind-0 BSON body,
//   never a raw byte substring search.
// - OP_QUERY (2004) and OP_REPLY (1) handshake frames are framed by
//   `messageLength` and forwarded verbatim; their payloads are never parsed,
//   correlated, or classified. Any other non-OP_MSG opcode is rejected.
// - Malformed, oversized, truncated, or unsupported input is rejected with a
//   typed error and the stream is poisoned rather than guessed at.
//
// The parser is intentionally dependency-free so it can be unit-tested without
// a database and reused by the disposable T2 proxy under separate authorization.

export const OP_MSG_OPCODE = 2013;
export const OP_MSG_HEADER_BYTES = 16;
export const OP_MSG_FLAGS_BYTES = 4;
// Smallest representable OP_MSG:
//   16-byte header + 4-byte flagBits + 1-byte kind-0 marker + 5-byte empty BSON
//   document (4-byte length + 1-byte NUL terminator) = 26 bytes.
export const OP_MSG_MIN_MESSAGE_BYTES = 26;
export const DEFAULT_MAX_MESSAGE_BYTES = 48_000_000;

// F1 — legacy MongoDB wire opcodes required for the driver handshake.
//
// mongodb 7.5.0 sends its initial handshake as OP_QUERY: `Connection.supportsOpMsg`
// is false until a hello response supplies `maxWireVersion`, so the driver builds
// an `OpQueryRequest` (lib/cmap/connection.js:241-243). mongod answers with
// OP_REPLY. Both frames are forwarded verbatim; their payloads are never parsed,
// correlated, commit-classified, or ACK-dropped.
export const OP_REPLY_OPCODE = 1;
export const OP_QUERY_OPCODE = 2004;
// The wire header is the same 16 bytes for every MongoDB opcode.
export const WIRE_HEADER_BYTES = OP_MSG_HEADER_BYTES;
// Protocol minimum sizes, header included, for the legacy frames this module
// forwards. They bound framing only; the payload is opaque to this module.
//   OP_QUERY: 16 header + 4 flags + 1-byte namespace NUL + 4 skip + 4 return
//             + 5-byte empty query document = 34
//   OP_REPLY: 16 header + 4 responseFlags + 8 cursorId + 4 startingFrom
//             + 4 numberReturned = 36
export const OP_QUERY_MIN_MESSAGE_BYTES = 34;
export const OP_REPLY_MIN_MESSAGE_BYTES = 36;

export function isLegacyHandshakeOpcode(opCode) {
  return opCode === OP_QUERY_OPCODE || opCode === OP_REPLY_OPCODE;
}

export function isLegacyHandshakeFrame(frame) {
  return Boolean(
    frame && frame.legacy === true && isLegacyHandshakeOpcode(frame.opCode)
  );
}

export function legacyOpcodeName(opCode) {
  if (opCode === OP_QUERY_OPCODE) return "OP_QUERY";
  if (opCode === OP_REPLY_OPCODE) return "OP_REPLY";
  return null;
}

export const OP_MSG_FLAG_CHECKSUM_PRESENT = 0x00000001;
export const OP_MSG_FLAG_MORE_TO_COME = 0x00000002;
export const OP_MSG_FLAG_EXHAUST_ALLOWED = 0x00010000;

const KNOWN_FLAGS_MASK =
  OP_MSG_FLAG_CHECKSUM_PRESENT |
  OP_MSG_FLAG_MORE_TO_COME |
  OP_MSG_FLAG_EXHAUST_ALLOWED;

const MAX_BSON_DEPTH = 32;

export class OpMsgParseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OpMsgParseError";
    this.code = code;
    Object.assign(this, details);
  }
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new OpMsgParseError(
    "INVALID_INPUT",
    "OP_MSG input must be a Buffer or Uint8Array."
  );
}

function need(buffer, offset, count, end, what) {
  if (offset < 0 || count < 0 || offset + count > end) {
    throw new OpMsgParseError(
      "TRUNCATED_INPUT",
      `Truncated ${what}: need ${count} byte(s) at offset ${offset}, limit ${end}.`,
      { offset }
    );
  }
}

function readCString(buffer, offset, end, what) {
  let cursor = offset;
  while (cursor < end) {
    if (buffer[cursor] === 0x00) {
      return {
        value: buffer.toString("utf8", offset, cursor),
        next: cursor + 1
      };
    }
    cursor += 1;
  }
  throw new OpMsgParseError(
    "UNTERMINATED_CSTRING",
    `Unterminated ${what} at offset ${offset}.`,
    { offset }
  );
}

function readBsonString(buffer, offset, end) {
  need(buffer, offset, 4, end, "BSON string length");
  const length = buffer.readInt32LE(offset);
  if (length < 1) {
    throw new OpMsgParseError(
      "INVALID_BSON_STRING",
      `BSON string length ${length} is invalid at offset ${offset}.`,
      { offset, length }
    );
  }
  need(buffer, offset + 4, length, end, "BSON string bytes");
  const terminator = offset + 4 + length - 1;
  if (buffer[terminator] !== 0x00) {
    throw new OpMsgParseError(
      "INVALID_BSON_STRING",
      `BSON string at offset ${offset} is not NUL-terminated.`,
      { offset }
    );
  }
  return {
    value: buffer.toString("utf8", offset + 4, terminator),
    next: offset + 4 + length
  };
}

function skipBsonValue(buffer, offset, end, type, depth) {
  switch (type) {
    case 0x01: // double
      need(buffer, offset, 8, end, "BSON double");
      return offset + 8;
    case 0x02: // string
      return readBsonString(buffer, offset, end).next;
    case 0x03: // embedded document
    case 0x04: // array
      return readBsonDocument(buffer, offset, end, depth + 1).next;
    case 0x05: { // binary
      need(buffer, offset, 5, end, "BSON binary header");
      const length = buffer.readInt32LE(offset);
      if (length < 0) {
        throw new OpMsgParseError(
          "INVALID_BSON_BINARY",
          `BSON binary length ${length} is invalid at offset ${offset}.`,
          { offset, length }
        );
      }
      need(buffer, offset + 5, length, end, "BSON binary payload");
      return offset + 5 + length;
    }
    case 0x06: // undefined (deprecated)
    case 0x0a: // null
    case 0x7f: // max key
    case 0xff: // min key
      return offset;
    case 0x07: // ObjectId
      need(buffer, offset, 12, end, "BSON ObjectId");
      return offset + 12;
    case 0x08: // boolean
      need(buffer, offset, 1, end, "BSON boolean");
      return offset + 1;
    case 0x09: // UTC datetime
      need(buffer, offset, 8, end, "BSON datetime");
      return offset + 8;
    case 0x0b: { // regular expression
      const pattern = readCString(buffer, offset, end, "BSON regex pattern");
      const flags = readCString(buffer, pattern.next, end, "BSON regex flags");
      return flags.next;
    }
    case 0x0c: { // DBPointer (deprecated)
      const ns = readBsonString(buffer, offset, end);
      need(buffer, ns.next, 12, end, "BSON DBPointer ObjectId");
      return ns.next + 12;
    }
    case 0x0d: // JavaScript code
    case 0x0e: // symbol (deprecated)
      return readBsonString(buffer, offset, end).next;
    case 0x0f: { // JavaScript code with scope
      need(buffer, offset, 4, end, "BSON code-with-scope length");
      const total = buffer.readInt32LE(offset);
      if (total < 14) {
        throw new OpMsgParseError(
          "INVALID_BSON_CODE_W_SCOPE",
          `BSON code-with-scope length ${total} is invalid at offset ${offset}.`,
          { offset, length: total }
        );
      }
      need(buffer, offset, total, end, "BSON code-with-scope payload");
      const scopeEnd = offset + total;
      const code = readBsonString(buffer, offset + 4, scopeEnd);
      const scope = readBsonDocument(buffer, code.next, scopeEnd, depth + 1);
      if (scope.next !== scopeEnd) {
        throw new OpMsgParseError(
          "INVALID_BSON_CODE_W_SCOPE",
          `BSON code-with-scope at offset ${offset} has trailing bytes.`,
          { offset }
        );
      }
      return scopeEnd;
    }
    case 0x10: // int32
      need(buffer, offset, 4, end, "BSON int32");
      return offset + 4;
    case 0x11: // timestamp
    case 0x12: // int64
      need(buffer, offset, 8, end, "BSON 64-bit value");
      return offset + 8;
    case 0x13: // decimal128
      need(buffer, offset, 16, end, "BSON decimal128");
      return offset + 16;
    default:
      throw new OpMsgParseError(
        "UNSUPPORTED_BSON_TYPE",
        `Unsupported BSON type 0x${type.toString(16)} at offset ${offset}.`,
        { offset, bsonType: type }
      );
  }
}

function readBsonDocument(buffer, offset, end, depth = 0) {
  if (depth > MAX_BSON_DEPTH) {
    throw new OpMsgParseError(
      "BSON_DEPTH_EXCEEDED",
      `BSON nesting exceeds ${MAX_BSON_DEPTH} levels at offset ${offset}.`,
      { offset }
    );
  }
  need(buffer, offset, 5, end, "BSON document header");
  const length = buffer.readInt32LE(offset);
  if (length < 5) {
    throw new OpMsgParseError(
      "INVALID_BSON_LENGTH",
      `BSON document length ${length} is invalid at offset ${offset}.`,
      { offset, length }
    );
  }
  const docEnd = offset + length;
  if (docEnd > end) {
    throw new OpMsgParseError(
      "TRUNCATED_BSON_DOCUMENT",
      `BSON document at offset ${offset} claims ${length} bytes, limit ${end}.`,
      { offset, length }
    );
  }
  if (buffer[docEnd - 1] !== 0x00) {
    throw new OpMsgParseError(
      "INVALID_BSON_TERMINATOR",
      `BSON document at offset ${offset} is not NUL-terminated.`,
      { offset }
    );
  }

  const keys = [];
  const strings = Object.create(null);
  let cursor = offset + 4;

  while (cursor < docEnd - 1) {
    const type = buffer[cursor];
    cursor += 1;
    const key = readCString(buffer, cursor, docEnd - 1, "BSON key");
    cursor = key.next;
    keys.push(key.value);

    if (type === 0x02) {
      const stringValue = readBsonString(buffer, cursor, docEnd - 1);
      strings[key.value] = stringValue.value;
      cursor = stringValue.next;
    } else {
      cursor = skipBsonValue(buffer, cursor, docEnd - 1, type, depth);
    }
  }

  if (cursor !== docEnd - 1) {
    throw new OpMsgParseError(
      "INVALID_BSON_STRUCTURE",
      `BSON document at offset ${offset} has trailing bytes before terminator.`,
      { offset }
    );
  }

  return {
    length,
    keys,
    firstKey: keys.length > 0 ? keys[0] : null,
    strings,
    next: docEnd
  };
}

export function validateMessageLength(
  messageLength,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  minMessageBytes = OP_MSG_MIN_MESSAGE_BYTES
) {
  if (!Number.isInteger(messageLength)) {
    return new OpMsgParseError(
      "INVALID_MESSAGE_LENGTH",
      `MongoDB wire messageLength ${messageLength} is not an integer.`
    );
  }
  if (messageLength < minMessageBytes) {
    return new OpMsgParseError(
      "INVALID_MESSAGE_LENGTH",
      `MongoDB wire messageLength ${messageLength} is below the ${minMessageBytes}-byte minimum.`,
      { messageLength, minMessageBytes }
    );
  }
  if (messageLength > maxMessageBytes) {
    return new OpMsgParseError(
      "OVERSIZED_MESSAGE",
      `MongoDB wire messageLength ${messageLength} exceeds the ${maxMessageBytes}-byte limit.`,
      { messageLength, maxMessageBytes }
    );
  }
  return null;
}

// Length-first wire header reader. It deliberately does not restrict the opcode:
// the stream demultiplexer uses it to classify OP_MSG versus legacy handshake
// frames, while `parseOpMsgHeader` keeps the strict OP_MSG-only contract.
export function parseWireHeader(buffer, offset = 0, options = {}) {
  const buf = toBuffer(buffer);
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const minMessageBytes = options.minMessageBytes ?? WIRE_HEADER_BYTES;
  need(buf, offset, WIRE_HEADER_BYTES, buf.length, "MongoDB wire header");

  const messageLength = buf.readInt32LE(offset);
  const requestID = buf.readInt32LE(offset + 4);
  const responseTo = buf.readInt32LE(offset + 8);
  const opCode = buf.readInt32LE(offset + 12);

  const lengthError = validateMessageLength(
    messageLength,
    maxMessageBytes,
    minMessageBytes
  );
  if (lengthError) throw lengthError;

  return { messageLength, requestID, responseTo, opCode };
}

export function parseOpMsgHeader(buffer, offset = 0, options = {}) {
  const buf = toBuffer(buffer);
  const header = parseWireHeader(buf, offset, {
    maxMessageBytes: options.maxMessageBytes,
    minMessageBytes: OP_MSG_MIN_MESSAGE_BYTES
  });

  if (header.opCode !== OP_MSG_OPCODE) {
    throw new OpMsgParseError(
      "UNSUPPORTED_OPCODE",
      `Unsupported MongoDB opcode ${header.opCode}; only OP_MSG (${OP_MSG_OPCODE}) is accepted.`,
      { opCode: header.opCode }
    );
  }

  return header;
}

function parseKind1Section(buffer, cursor, bodyEnd) {
  need(buffer, cursor, 4, bodyEnd, "OP_MSG kind-1 section size");
  const sectionSize = buffer.readInt32LE(cursor);
  if (sectionSize < 5) {
    throw new OpMsgParseError(
      "INVALID_SECTION_SIZE",
      `OP_MSG kind-1 section size ${sectionSize} is invalid at offset ${cursor}.`,
      { offset: cursor, sectionSize }
    );
  }
  const sectionEnd = cursor + sectionSize;
  if (sectionEnd > bodyEnd) {
    throw new OpMsgParseError(
      "TRUNCATED_SECTION",
      `OP_MSG kind-1 section at offset ${cursor} claims ${sectionSize} bytes, limit ${bodyEnd}.`,
      { offset: cursor, sectionSize }
    );
  }

  const identifier = readCString(buffer, cursor + 4, sectionEnd, "kind-1 section identifier");
  if (identifier.value.length === 0) {
    throw new OpMsgParseError(
      "INVALID_SECTION_IDENTIFIER",
      `OP_MSG kind-1 section at offset ${cursor} has an empty identifier.`,
      { offset: cursor }
    );
  }
  const documents = [];
  let docCursor = identifier.next;

  while (docCursor < sectionEnd) {
    const document = readBsonDocument(buffer, docCursor, sectionEnd, 0);
    documents.push({
      length: document.length,
      keys: document.keys,
      firstKey: document.firstKey,
      strings: document.strings
    });
    docCursor = document.next;
  }

  if (docCursor !== sectionEnd) {
    throw new OpMsgParseError(
      "INVALID_SECTION_STRUCTURE",
      `OP_MSG kind-1 section at offset ${cursor} has trailing bytes.`,
      { offset: cursor }
    );
  }

  return {
    section: { kind: 1, identifier: identifier.value, documents },
    next: sectionEnd
  };
}

export function parseOpMsgFrame(input, options = {}) {
  const buffer = toBuffer(input);
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

  if (buffer.length < OP_MSG_HEADER_BYTES) {
    throw new OpMsgParseError(
      "INCOMPLETE_HEADER",
      `OP_MSG frame has ${buffer.length} byte(s); the header requires ${OP_MSG_HEADER_BYTES}.`
    );
  }

  const header = parseOpMsgHeader(buffer, 0, { maxMessageBytes });
  if (header.messageLength !== buffer.length) {
    throw new OpMsgParseError(
      "LENGTH_MISMATCH",
      `OP_MSG header claims ${header.messageLength} bytes but ${buffer.length} were supplied.`,
      { messageLength: header.messageLength, suppliedLength: buffer.length }
    );
  }

  let bodyEnd = buffer.length;
  if (bodyEnd - OP_MSG_HEADER_BYTES < OP_MSG_FLAGS_BYTES) {
    throw new OpMsgParseError(
      "INCOMPLETE_FLAGS",
      "OP_MSG frame is missing its flagBits field."
    );
  }

  const flags = buffer.readUInt32LE(OP_MSG_HEADER_BYTES);
  const unknownFlags = (flags & ~KNOWN_FLAGS_MASK) >>> 0;
  if (unknownFlags !== 0) {
    throw new OpMsgParseError(
      "UNSUPPORTED_FLAGS",
      `OP_MSG frame contains unsupported flag bits 0x${unknownFlags.toString(16)}.`,
      { flags, unknownFlags }
    );
  }

  const checksumPresent = (flags & OP_MSG_FLAG_CHECKSUM_PRESENT) !== 0;
  const moreToCome = (flags & OP_MSG_FLAG_MORE_TO_COME) !== 0;
  const exhaustAllowed = (flags & OP_MSG_FLAG_EXHAUST_ALLOWED) !== 0;

  if (checksumPresent) {
    if (bodyEnd - OP_MSG_HEADER_BYTES - OP_MSG_FLAGS_BYTES < 4) {
      throw new OpMsgParseError(
        "TRUNCATED_CHECKSUM",
        "OP_MSG frame declares a checksum but has no checksum bytes."
      );
    }
    bodyEnd -= 4;
  }

  let cursor = OP_MSG_HEADER_BYTES + OP_MSG_FLAGS_BYTES;
  const sections = [];
  let bodyDocument = null;
  let command = null;

  while (cursor < bodyEnd) {
    const kind = buffer[cursor];
    cursor += 1;

    if (kind === 0) {
      if (bodyDocument !== null) {
        throw new OpMsgParseError(
          "DUPLICATE_BODY_SECTION",
          "OP_MSG frame contains more than one kind-0 body section."
        );
      }
      const document = readBsonDocument(buffer, cursor, bodyEnd, 0);
      cursor = document.next;
      bodyDocument = {
        length: document.length,
        keys: document.keys,
        firstKey: document.firstKey,
        strings: document.strings
      };
      sections.push({ kind: 0, document: bodyDocument });
      if (document.firstKey !== null) {
        command = {
          name: document.firstKey,
          isCommit: document.firstKey === "commitTransaction",
          sectionKind: 0
        };
      }
    } else if (kind === 1) {
      const parsed = parseKind1Section(buffer, cursor, bodyEnd);
      sections.push(parsed.section);
      cursor = parsed.next;
    } else {
      throw new OpMsgParseError(
        "UNSUPPORTED_SECTION_KIND",
        `Unsupported OP_MSG section kind ${kind} at offset ${cursor - 1}.`,
        { offset: cursor - 1, sectionKind: kind }
      );
    }
  }

  if (cursor !== bodyEnd) {
    throw new OpMsgParseError(
      "INVALID_FRAME_STRUCTURE",
      `OP_MSG frame has trailing bytes before its declared end (${cursor} !== ${bodyEnd}).`
    );
  }

  if (bodyDocument === null) {
    throw new OpMsgParseError(
      "MISSING_BODY_SECTION",
      "OP_MSG frame has no kind-0 body section."
    );
  }

  return {
    messageLength: header.messageLength,
    requestID: header.requestID,
    responseTo: header.responseTo,
    opCode: header.opCode,
    flags: { raw: flags, checksumPresent, moreToCome, exhaustAllowed },
    checksumVerified: false,
    sections,
    body: bodyDocument,
    command,
    raw: buffer
  };
}

export function classifyOpMsgFrame(frame) {
  if (!frame || typeof frame !== "object") {
    throw new OpMsgParseError("INVALID_FRAME", "A parsed OP_MSG frame is required.");
  }
  // Legacy handshake frames are opaque byte-for-byte payloads. They are never
  // OP_MSG and can never carry a classified commit.
  if (frame.legacy === true) {
    return { name: null, isCommit: false, sectionKind: null };
  }
  if (!frame.command) {
    return { name: null, isCommit: false, sectionKind: null };
  }
  return {
    name: frame.command.name,
    isCommit: frame.command.isCommit === true,
    sectionKind: frame.command.sectionKind
  };
}

export function isCommitTransactionFrame(frame) {
  if (frame?.legacy === true) return false;
  return classifyOpMsgFrame(frame).isCommit;
}

function poisonError(error) {
  if (error instanceof OpMsgParseError) return error;
  return new OpMsgParseError("UNEXPECTED_PARSE_FAILURE", String(error?.message ?? error));
}

export class OpMsgStreamDemultiplexer {
  constructor(options = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    // When true (the default) an OP_MSG response whose responseTo does not match
    // a pending request is reported as a non-poisoning correlation error. A proxy
    // that shares one demultiplexer across both directions can keep this on and
    // treat the warning as non-fatal, or turn it off when a peer legitimately
    // sends unsolicited/exhaust responses. Legacy handshake frames are never
    // registered or correlated, so they cannot produce this warning.
    this.enforceCorrelation = options.enforceCorrelation !== false;
    this.buffer = Buffer.alloc(0);
    this.pendingRequests = new Map();
    this.poisoned = false;
    this.poisonReason = null;
  }

  get pendingRequestCount() {
    return this.pendingRequests.size;
  }

  get pendingBytes() {
    return this.buffer.length;
  }

  _poison(error) {
    this.poisoned = true;
    this.poisonReason = error;
    this.buffer = Buffer.alloc(0);
  }

  _register(frame) {
    if (frame.responseTo === 0) {
      if (this.pendingRequests.has(frame.requestID)) {
        return new OpMsgParseError(
          "DUPLICATE_REQUEST_ID",
          `OP_MSG requestID ${frame.requestID} is already pending.`,
          { requestID: frame.requestID }
        );
      }
      this.pendingRequests.set(frame.requestID, frame);
      return null;
    }

    const request = this.pendingRequests.get(frame.responseTo) ?? null;
    frame.correlatedRequest = request;
    if (request !== null) {
      this.pendingRequests.delete(frame.responseTo);
      return null;
    }
    if (!this.enforceCorrelation) return null;
    return new OpMsgParseError(
      "UNKNOWN_RESPONSE_CORRELATION",
      `OP_MSG responseTo ${frame.responseTo} does not match a pending request.`,
      { responseTo: frame.responseTo }
    );
  }

  push(chunk) {
    const frames = [];
    const errors = [];

    if (this.poisoned) {
      return {
        frames,
        errors: [
          new OpMsgParseError(
            "STREAM_POISONED",
            `MongoDB wire stream is poisoned: ${this.poisonReason?.message ?? "unknown reason"}.`
          )
        ],
        pendingBytes: 0,
        poisoned: true
      };
    }

    const incoming = toBuffer(chunk);
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(incoming)
        : Buffer.concat([this.buffer, incoming]);

    while (this.buffer.length >= 4) {
      // Length-first: a frame is never inspected, buffered further, or forwarded
      // until its declared size passes the wire bounds.
      const messageLength = this.buffer.readInt32LE(0);
      const lengthError = validateMessageLength(
        messageLength,
        this.maxMessageBytes,
        WIRE_HEADER_BYTES
      );
      if (lengthError) {
        errors.push(lengthError);
        this._poison(lengthError);
        break;
      }

      // The opcode lives at byte 12. Wait for the complete header before
      // classifying the frame, then reject an unsupported opcode immediately
      // rather than buffering its declared length first.
      if (this.buffer.length < WIRE_HEADER_BYTES) break;
      const opCode = this.buffer.readInt32LE(12);
      const legacy = isLegacyHandshakeOpcode(opCode);
      if (opCode !== OP_MSG_OPCODE && !legacy) {
        const opcodeError = new OpMsgParseError(
          "UNSUPPORTED_OPCODE",
          `Unsupported MongoDB opcode ${opCode}; only OP_MSG (${OP_MSG_OPCODE}), ` +
            `OP_QUERY (${OP_QUERY_OPCODE}) and OP_REPLY (${OP_REPLY_OPCODE}) are accepted.`,
          { opCode }
        );
        errors.push(opcodeError);
        this._poison(opcodeError);
        break;
      }

      const minimumBytes =
        opCode === OP_MSG_OPCODE
          ? OP_MSG_MIN_MESSAGE_BYTES
          : opCode === OP_QUERY_OPCODE
            ? OP_QUERY_MIN_MESSAGE_BYTES
            : OP_REPLY_MIN_MESSAGE_BYTES;
      const opcodeLengthError = validateMessageLength(
        messageLength,
        this.maxMessageBytes,
        minimumBytes
      );
      if (opcodeLengthError) {
        errors.push(opcodeLengthError);
        this._poison(opcodeLengthError);
        break;
      }

      if (this.buffer.length < messageLength) break;

      const raw = this.buffer.subarray(0, messageLength);
      this.buffer = this.buffer.subarray(messageLength);

      // F1: legacy handshake frames are emitted as opaque byte-for-byte frames.
      // They are never parsed, correlated, commit-classified, or ACK-dropped.
      if (legacy) {
        frames.push({
          opCode,
          legacy: true,
          messageLength,
          requestID: raw.readInt32LE(4),
          responseTo: raw.readInt32LE(8),
          raw,
          correlatedRequest: null,
          command: null
        });
        continue;
      }

      let frame;
      try {
        frame = parseOpMsgFrame(raw, { maxMessageBytes: this.maxMessageBytes });
      } catch (error) {
        const parseError = poisonError(error);
        errors.push(parseError);
        this._poison(parseError);
        break;
      }

      const correlationError = this._register(frame);
      if (correlationError) {
        errors.push(correlationError);
        if (correlationError.code === "DUPLICATE_REQUEST_ID") {
          this._poison(correlationError);
          break;
        }
      }

      frames.push(frame);
    }

    return {
      frames,
      errors,
      pendingBytes: this.buffer.length,
      poisoned: this.poisoned
    };
  }

  correlate(frame) {
    if (!frame || frame.responseTo === 0) return null;
    const request = this.pendingRequests.get(frame.responseTo) ?? null;
    if (request === null) return null;
    this.pendingRequests.delete(frame.responseTo);
    return { request, response: frame };
  }

  reset() {
    this.buffer = Buffer.alloc(0);
    this.pendingRequests.clear();
    this.poisoned = false;
    this.poisonReason = null;
  }
}

export function createOpMsgStreamDemultiplexer(options = {}) {
  return new OpMsgStreamDemultiplexer(options);
}
