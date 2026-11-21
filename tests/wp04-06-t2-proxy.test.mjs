// WP04-06 — DB-free tests for the commit-aware loopback proxy.
//
// These tests use only loopback TCP sockets and synthetic wire frames: OP_MSG
// frames built locally, an OP_QUERY frame serialized by mongodb 7.5.0's own
// `OpQueryRequest.toBin()` from a hand-built protocol-valid hello document, and
// protocol-shaped OP_REPLY frames. They do not start mongod, connect to MongoDB,
// read environment files, or execute the integration runner. A passing result is
// proxy/parser evidence only; it is NOT T2/P1-P6 evidence and does not close T2.

import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";

import { serialize } from "bson";

import {
  OP_MSG_OPCODE,
  OP_QUERY_OPCODE,
  OP_REPLY_OPCODE,
  OpMsgStreamDemultiplexer
} from "./integration/support/opmsg.mjs";
import {
  createCommitAwareProxy,
  PROXY_MODES
} from "./integration/support/t2Proxy.mjs";

const LOOPBACK = "127.0.0.1";

function buildOpMsg({
  requestID = 1,
  responseTo = 0,
  command = { ping: 1 },
  flags = 0
} = {}) {
  const bodyDocument = serialize(command);
  const body = Buffer.concat([Buffer.from([0]), bodyDocument]);
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

// F1 — a 268-byte OP_QUERY serialized once, DB-free, by mongodb 7.5.0's own
// `OpQueryRequest.toBin()`:
//   new (require("mongodb/lib/cmap/commands.js").OpQueryRequest)(
//     "admin", HANDSHAKE_QUERY, { requestId: 1, numberToReturn: -1 }
//   ).toBin()
// PROVENANCE: the serializer is genuine, but the hello document is hand-built and
// protocol-valid. This frame was NOT captured from a live driver connection and
// is NOT the driver's `prepareHandshakeDocument` output; that document uses
// `ismaster: 1` plus `backpressure: true` and serializes to 286 bytes. Legacy
// payloads are opaque to the proxy, so either shape exercises the same framing
// path. The bytes are embedded so the tests need no driver-internal import.
const DRIVER_SERIALIZED_OP_QUERY_HEX =
  "0c0100000100000000000000d40700000000000061646d696e2e24636d640000" +
  "000000ffffffffe50000001068656c6c6f00010000000868656c6c6f4f6b0001" +
  "03636c69656e7400b1000000036472697665720029000000026e616d65000700" +
  "00006e6f64656a73000276657273696f6e0006000000372e352e300000036f73" +
  "00580000000274797065000b00000057696e646f77735f4e5400026e616d6500" +
  "0600000077696e33320002617263686974656374757265000400000078363400" +
  "0276657273696f6e000b00000031302e302e3236313030000002706c6174666f" +
  "726d00110000004e6f64652e6a73207632342e31342e30000004636f6d707265" +
  "7373696f6e00050000000000";

const HANDSHAKE_QUERY = Object.freeze({
  hello: 1,
  helloOk: true,
  client: {
    driver: { name: "nodejs", version: "7.5.0" },
    os: {
      type: "Windows_NT",
      name: "win32",
      architecture: "x64",
      version: "10.0.26100"
    },
    platform: "Node.js v24.14.0"
  },
  compression: []
});

function buildOpQuery({
  requestID = 1,
  responseTo = 0,
  database = "admin",
  command = HANDSHAKE_QUERY
} = {}) {
  const query = serialize(command);
  const namespace = Buffer.from(`${database}.$cmd\0`, "utf8");
  const messageLength = 16 + 4 + namespace.length + 4 + 4 + query.length;

  const header = Buffer.alloc(16);
  header.writeInt32LE(messageLength, 0);
  header.writeInt32LE(requestID, 4);
  header.writeInt32LE(responseTo, 8);
  header.writeInt32LE(OP_QUERY_OPCODE, 12);

  const tail = Buffer.alloc(12);
  tail.writeInt32LE(0, 0); // flags
  tail.writeInt32LE(0, 4); // numberToSkip
  tail.writeInt32LE(-1, 8); // numberToReturn

  return Buffer.concat([
    header,
    tail.subarray(0, 4),
    namespace,
    tail.subarray(4),
    query
  ]);
}

function buildOpReply({
  requestID = 900,
  responseTo = 1,
  responseFlags = 0,
  cursorId = 0n,
  startingFrom = 0,
  documents = [{ ok: 1 }]
} = {}) {
  const encoded = documents.map((document) => serialize(document));
  const documentBytes = encoded.reduce(
    (total, document) => total + document.length,
    0
  );
  const messageLength = 16 + 4 + 8 + 4 + 4 + documentBytes;

  const header = Buffer.alloc(16);
  header.writeInt32LE(messageLength, 0);
  header.writeInt32LE(requestID, 4);
  header.writeInt32LE(responseTo, 8);
  header.writeInt32LE(OP_REPLY_OPCODE, 12);

  const body = Buffer.alloc(20);
  body.writeInt32LE(responseFlags, 0);
  body.writeBigInt64LE(cursorId, 4);
  body.writeInt32LE(startingFrom, 12);
  body.writeInt32LE(documents.length, 16);

  return Buffer.concat([header, body, ...encoded]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2_000, label = "condition") {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function createReader(socket) {
  const demux = new OpMsgStreamDemultiplexer({ enforceCorrelation: false });
  const frames = [];
  let closed = false;

  socket.on("data", (chunk) => {
    const result = demux.push(chunk);
    frames.push(...result.frames);
  });
  socket.on("close", () => {
    closed = true;
  });

  return {
    frames,
    isClosed: () => closed,
    waitForFrame(predicate, timeoutMs = 2_000) {
      return waitFor(() => frames.find(predicate), timeoutMs, "proxy response frame");
    },
    waitForClose(timeoutMs = 2_000) {
      return waitFor(() => closed, timeoutMs, "client socket close");
    }
  };
}

async function connectClient(port) {
  const socket = net.connect({ host: LOOPBACK, port });
  socket.on("error", () => {});
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function startTarget() {
  const received = [];
  const sent = [];
  const sockets = new Set();
  let nextResponseID = 10_000;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const demux = new OpMsgStreamDemultiplexer({ enforceCorrelation: false });
    socket.on("data", (chunk) => {
      const result = demux.push(chunk);
      for (const frame of result.frames) {
        received.push(frame);
        // F1: answer a legacy OP_QUERY with a legacy OP_REPLY, as mongod does
        // for the driver handshake.
        if (frame.legacy === true) {
          const reply = buildOpReply({
            requestID: nextResponseID++,
            responseTo: frame.requestID,
            documents: [{ ok: 1, isWritablePrimary: true }]
          });
          sent.push(reply);
          socket.write(reply);
          continue;
        }
        const name = frame.command?.name ?? "unknown";
        const reply = buildOpMsg({
          requestID: nextResponseID++,
          responseTo: frame.requestID,
          command: name === "commitTransaction" ? { ok: 1 } : { ok: 1, command: name }
        });
        sent.push(reply);
        socket.write(reply);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  const port = server.address().port;

  return {
    port,
    received,
    sent,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

// Raw byte sink: records exactly what the proxy forwards and lets a test send an
// exact byte sequence back, so pass-through can be asserted byte-for-byte.
async function startRawTarget() {
  const chunks = [];
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  });

  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  const port = server.address().port;

  return {
    port,
    receivedBytes: () => Buffer.concat(chunks),
    waitForBytes(minBytes, timeoutMs = 2_000) {
      return waitFor(
        () => (Buffer.concat(chunks).length >= minBytes ? Buffer.concat(chunks) : null),
        timeoutMs,
        "bytes at the raw target"
      );
    },
    async waitForSocket() {
      return waitFor(() => [...sockets][0] ?? null, 2_000, "target connection");
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function startProxy({ targetPort, mode, ...options }) {
  const proxy = createCommitAwareProxy({
    listenHost: LOOPBACK,
    listenPort: 0,
    targetHost: LOOPBACK,
    targetPort,
    mode,
    ...options
  });
  await proxy.listen();
  return proxy;
}

function proxyPort(proxy) {
  const address = proxy.getAddress();
  assert.ok(address, "proxy must expose a listening address");
  return address.port;
}

test("an OP_MSG hello command passes through the proxy", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.NEGATIVE_CONTROL
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  client.write(buildOpMsg({ requestID: 1, command: { hello: 1, helloOk: true } }));

  const response = await reader.waitForFrame((frame) => frame.responseTo === 1);
  assert.equal(response.command.name, "ok");
  assert.equal(proxy.getStats().commitDetections, 0);
  assert.equal(
    proxy.getEvents().some((event) => event.type === "connection-severed"),
    false
  );
});

test("commit request and matching ACK are correlated and dropped per connection", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.DROP_COMMIT_ACK
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  client.write(buildOpMsg({ requestID: 2, command: { commitTransaction: 1 } }));
  await reader.waitForClose();

  const stats = proxy.getStats();
  assert.equal(stats.commitDetections, 1);
  assert.equal(stats.forwardedCommit, true);
  assert.equal(stats.ackDropped, true);
  assert.equal(stats.droppedAckResponseTo, 2);

  const events = proxy.getEvents();
  const forwarded = events.find((event) => event.type === "commit-forwarded");
  const dropped = events.find((event) => event.type === "commit-ack-dropped");
  assert.ok(forwarded);
  assert.ok(dropped);
  assert.equal(forwarded.requestID, 2);
  assert.equal(dropped.responseTo, 2);
  assert.equal(dropped.correlatedRequestID, 2);
  assert.equal(dropped.correlatedCommand, "commitTransaction");
  assert.equal(target.received.filter((frame) => frame.command?.name === "commitTransaction").length, 1);
});

test("sever-before-commit withholds the commit frame from the target", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.SEVER_BEFORE_COMMIT
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  client.write(buildOpMsg({ requestID: 3, command: { commitTransaction: 1 } }));
  await reader.waitForClose();

  const stats = proxy.getStats();
  assert.equal(stats.commitDetections, 1);
  assert.equal(stats.withheldCommit, true);
  assert.equal(stats.forwardedCommit, false);
  assert.equal(stats.ackDropped, false);
  assert.equal(target.received.length, 0);
  assert.equal(
    proxy.getEvents().some((event) => event.type === "commit-withheld"),
    true
  );
});

test("an unrelated response is never dropped when a commit ACK is dropped", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.DROP_COMMIT_ACK
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  client.write(buildOpMsg({ requestID: 4, command: { ping: 1 } }));
  const pingResponse = await reader.waitForFrame((frame) => frame.responseTo === 4);
  assert.equal(pingResponse.command.name, "ok");

  client.write(buildOpMsg({ requestID: 5, command: { commitTransaction: 1 } }));
  await reader.waitForClose();

  assert.equal(proxy.getStats().droppedAckResponseTo, 5);
});

test("the same responseTo on a separate connection is unaffected", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.DROP_COMMIT_ACK
  });
  const port = proxyPort(proxy);
  const unaffectedClient = await connectClient(port);
  const commitClient = await connectClient(port);
  t.after(async () => {
    unaffectedClient.destroy();
    commitClient.destroy();
    await proxy.close();
    await target.close();
  });

  const unaffectedReader = createReader(unaffectedClient);
  unaffectedClient.write(buildOpMsg({ requestID: 7, command: { ping: 1 } }));
  const unaffectedResponse = await unaffectedReader.waitForFrame(
    (frame) => frame.responseTo === 7
  );
  assert.equal(unaffectedResponse.command.name, "ok");

  const commitReader = createReader(commitClient);
  commitClient.write(buildOpMsg({ requestID: 7, command: { commitTransaction: 1 } }));
  await commitReader.waitForClose();

  assert.equal(proxy.getStats().ackDropped, true);
  assert.equal(unaffectedReader.isClosed(), false);
});

test("a non-commit BSON payload containing commitTransaction is not classified as a commit", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.NEGATIVE_CONTROL
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  client.write(
    buildOpMsg({
      requestID: 8,
      command: {
        find: "orders",
        filter: { note: "commitTransaction" },
        comment: "commitTransaction is only payload text"
      }
    })
  );

  const response = await reader.waitForFrame((frame) => frame.responseTo === 8);
  assert.equal(response.command.name, "ok");
  assert.equal(proxy.getStats().commitDetections, 0);
  assert.equal(
    proxy.getEvents().some((event) => event.type === "commit-detected"),
    false
  );
});

test("coalesced non-commit + commit frames forward only the permitted frames", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.SEVER_BEFORE_COMMIT
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  const nonCommit = buildOpMsg({ requestID: 9, command: { ping: 1 } });
  const commit = buildOpMsg({ requestID: 10, command: { commitTransaction: 1 } });
  client.write(Buffer.concat([nonCommit, commit]));

  await reader.waitForClose();
  await waitFor(
    () => target.received.some((frame) => frame.command?.name === "ping"),
    2_000,
    "non-commit frame at the target"
  );

  const names = target.received.map((frame) => frame.command?.name);
  assert.equal(names.includes("ping"), true);
  assert.equal(names.includes("commitTransaction"), false);
  assert.equal(proxy.getStats().commitDetections, 1);
  assert.equal(proxy.getStats().withheldCommit, true);
});

test("coalesced non-commit + commit frames are both forwarded in ACK-drop mode", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.DROP_COMMIT_ACK
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  client.write(
    Buffer.concat([
      buildOpMsg({ requestID: 11, command: { ping: 1 } }),
      buildOpMsg({ requestID: 12, command: { commitTransaction: 1 } })
    ])
  );

  await waitFor(
    () => target.received.some((frame) => frame.command?.name === "commitTransaction"),
    2_000,
    "commit frame at the target"
  );
  await reader.waitForClose();

  const names = target.received.map((frame) => frame.command?.name);
  assert.deepEqual(names, ["ping", "commitTransaction"]);
  assert.equal(proxy.getStats().commitDetections, 1);
  assert.equal(proxy.getStats().droppedAckResponseTo, 12);
});

test("large frames survive the proxy write/backpressure path", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.NEGATIVE_CONTROL
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  const payload = "x".repeat(512 * 1024);
  client.write(
    buildOpMsg({
      requestID: 13,
      command: { find: "orders", filter: { note: payload } }
    })
  );

  const response = await reader.waitForFrame((frame) => frame.responseTo === 13, 5_000);
  assert.equal(response.command.name, "ok");
  assert.equal(proxy.getStats().commitDetections, 0);
});

test("an idle socket is severed by the configured socket timeout", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.NEGATIVE_CONTROL,
    socketTimeoutMs: 100
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  await reader.waitForClose(2_000);
  assert.equal(
    proxy.getEvents().some((event) => event.type === "socket-timeout"),
    true
  );
});

test("a failed listen releases proxy state and rejects", async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, LOOPBACK, resolve));
  const occupiedPort = blocker.address().port;
  t.after(async () => {
    await new Promise((resolve) => blocker.close(() => resolve()));
  });

  const proxy = createCommitAwareProxy({
    listenHost: LOOPBACK,
    listenPort: occupiedPort,
    targetHost: LOOPBACK,
    targetPort: occupiedPort + 1,
    mode: PROXY_MODES.NEGATIVE_CONTROL
  });

  await assert.rejects(() => proxy.listen());
  assert.equal(
    proxy.getEvents().some((event) => event.type === "proxy-listening"),
    false
  );
  await proxy.close();
});

test("the proxy refuses non-loopback bind or target hosts", () => {
  assert.throws(
    () =>
      createCommitAwareProxy({
        listenHost: "0.0.0.0",
        listenPort: 0,
        targetHost: LOOPBACK,
        targetPort: 27017,
        mode: PROXY_MODES.NEGATIVE_CONTROL
      }),
    /loopback/
  );
  assert.throws(
    () =>
      createCommitAwareProxy({
        listenHost: LOOPBACK,
        listenPort: 0,
        targetHost: "example.com",
        targetPort: 27017,
        mode: PROXY_MODES.NEGATIVE_CONTROL
      }),
    /loopback/
  );
});

// ---------------------------------------------------------------------------
// F1 — legacy OP_QUERY/OP_REPLY handshake framing and pass-through
// ---------------------------------------------------------------------------

test("the OP_QUERY builder reproduces the mongodb 7.5.0-serialized embedded frame", () => {
  const embedded = Buffer.from(DRIVER_SERIALIZED_OP_QUERY_HEX, "hex");
  assert.equal(embedded.length, 268);
  assert.equal(embedded.readInt32LE(0), embedded.length);
  assert.equal(embedded.readInt32LE(4), 1);
  assert.equal(embedded.readInt32LE(8), 0);
  assert.equal(embedded.readInt32LE(12), OP_QUERY_OPCODE);
  assert.equal(buildOpQuery().toString("hex"), embedded.toString("hex"));
});

test("the demultiplexer frames OP_QUERY and OP_REPLY without parsing or correlating them", () => {
  const demux = new OpMsgStreamDemultiplexer();
  const query = buildOpQuery();
  const reply = buildOpReply({ responseTo: 1 });

  const queryResult = demux.push(query);
  assert.equal(queryResult.errors.length, 0);
  assert.equal(queryResult.poisoned, false);
  assert.equal(queryResult.frames.length, 1);
  const [legacyQuery] = queryResult.frames;
  assert.equal(legacyQuery.legacy, true);
  assert.equal(legacyQuery.opCode, OP_QUERY_OPCODE);
  assert.equal(legacyQuery.requestID, 1);
  assert.equal(legacyQuery.responseTo, 0);
  assert.equal(legacyQuery.command, null);
  assert.equal(legacyQuery.raw.toString("hex"), query.toString("hex"));

  const replyResult = demux.push(reply);
  assert.equal(replyResult.errors.length, 0);
  assert.equal(replyResult.frames.length, 1);
  const [legacyReply] = replyResult.frames;
  assert.equal(legacyReply.legacy, true);
  assert.equal(legacyReply.opCode, OP_REPLY_OPCODE);
  assert.equal(legacyReply.requestID, 900);
  assert.equal(legacyReply.responseTo, 1);
  assert.equal(legacyReply.raw.toString("hex"), reply.toString("hex"));

  // A legacy frame must never enter the OP_MSG pending-request map.
  assert.equal(demux.pendingRequestCount, 0);
});

test("the demultiplexer reassembles a fragmented legacy OP_QUERY frame", () => {
  const demux = new OpMsgStreamDemultiplexer();
  const query = buildOpQuery();

  const first = demux.push(query.subarray(0, 7));
  assert.equal(first.frames.length, 0);
  assert.equal(first.pendingBytes, 7);

  const second = demux.push(query.subarray(7, 16));
  assert.equal(second.frames.length, 0);
  assert.equal(second.pendingBytes, 16);

  const third = demux.push(query.subarray(16, 100));
  assert.equal(third.frames.length, 0);
  assert.equal(third.pendingBytes, 100);

  const fourth = demux.push(query.subarray(100));
  assert.equal(fourth.errors.length, 0);
  assert.equal(fourth.frames.length, 1);
  assert.equal(fourth.frames[0].legacy, true);
  assert.equal(fourth.frames[0].opCode, OP_QUERY_OPCODE);
  assert.equal(fourth.frames[0].raw.toString("hex"), query.toString("hex"));
  assert.equal(fourth.pendingBytes, 0);
});

test("the demultiplexer forwards coalesced legacy and OP_MSG frames individually and in order", () => {
  const demux = new OpMsgStreamDemultiplexer();
  const query = buildOpQuery();
  const ping = buildOpMsg({ requestID: 2, command: { ping: 1 } });
  const reply = buildOpReply({ responseTo: 2 });

  const result = demux.push(Buffer.concat([query, ping, reply]));
  assert.equal(result.errors.length, 0);
  assert.equal(result.poisoned, false);
  assert.deepEqual(
    result.frames.map((frame) => frame.opCode),
    [OP_QUERY_OPCODE, OP_MSG_OPCODE, OP_REPLY_OPCODE]
  );
  assert.equal(result.frames[0].raw.toString("hex"), query.toString("hex"));
  assert.equal(result.frames[1].raw.toString("hex"), ping.toString("hex"));
  assert.equal(result.frames[2].raw.toString("hex"), reply.toString("hex"));
  assert.equal(result.frames[1].legacy, undefined);
  assert.equal(result.frames[2].legacy, true);
  // The OP_MSG ping was registered and its OP_REPLY-shaped responseTo 2 is a
  // legacy frame, so it must not consume the pending OP_MSG request.
  assert.equal(demux.pendingRequestCount, 1);
});

test("the demultiplexer rejects an unsupported opcode instead of treating it as OP_MSG", () => {
  const demux = new OpMsgStreamDemultiplexer();
  const frame = Buffer.from(buildOpQuery());
  frame.writeInt32LE(2012, 12); // OP_COMPRESSED

  const result = demux.push(frame);
  assert.equal(result.frames.length, 0);
  assert.equal(result.poisoned, true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "UNSUPPORTED_OPCODE");
  assert.equal(result.errors[0].opCode, 2012);
});

test("the demultiplexer rejects a legacy frame below its protocol minimum", () => {
  const demux = new OpMsgStreamDemultiplexer();
  const header = Buffer.alloc(16);
  header.writeInt32LE(20, 0); // above the wire header, below the OP_QUERY minimum
  header.writeInt32LE(1, 4);
  header.writeInt32LE(0, 8);
  header.writeInt32LE(OP_QUERY_OPCODE, 12);

  const result = demux.push(header);
  assert.equal(result.frames.length, 0);
  assert.equal(result.poisoned, true);
  assert.equal(result.errors[0].code, "INVALID_MESSAGE_LENGTH");
});

test("the mongodb 7.5.0-serialized OP_QUERY frame passes client -> server unchanged", async (t) => {
  const target = await startRawTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.DROP_COMMIT_ACK
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const query = buildOpQuery();
  client.write(query);

  const forwarded = await target.waitForBytes(query.length);
  assert.equal(forwarded.subarray(0, query.length).toString("hex"), query.toString("hex"));

  const stats = proxy.getStats();
  assert.equal(stats.commitDetections, 0);
  assert.equal(stats.ackDropped, false);
  assert.equal(stats.legacyFramesForwarded, 1);
  assert.equal(
    proxy.getEvents().some((event) => event.type === "connection-severed"),
    false
  );
});

test("coalesced legacy and OP_MSG frames are forwarded individually and in order", async (t) => {
  const target = await startRawTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.NEGATIVE_CONTROL
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const query = buildOpQuery();
  const ping = buildOpMsg({ requestID: 2, command: { ping: 1 } });
  const combined = Buffer.concat([query, ping]);
  client.write(combined);

  const forwarded = await target.waitForBytes(combined.length);
  assert.equal(
    forwarded.subarray(0, combined.length).toString("hex"),
    combined.toString("hex")
  );
  assert.equal(proxy.getStats().legacyFramesForwarded, 1);
  assert.equal(proxy.getStats().commitDetections, 0);
});

test("an OP_REPLY handshake response passes server -> client unchanged", async (t) => {
  const target = await startRawTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.NEGATIVE_CONTROL
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  const query = buildOpQuery();
  client.write(query);
  await target.waitForBytes(query.length);

  const reply = buildOpReply({
    responseTo: 1,
    documents: [{ ok: 1, isWritablePrimary: true }]
  });
  const targetSocket = await target.waitForSocket();
  targetSocket.write(reply);

  const forwarded = await reader.waitForFrame(
    (frame) => frame.legacy === true && frame.opCode === OP_REPLY_OPCODE
  );
  assert.equal(forwarded.raw.toString("hex"), reply.toString("hex"));
  assert.equal(forwarded.responseTo, 1);
  assert.equal(proxy.getStats().legacyFramesForwarded, 2);
  assert.equal(proxy.getStats().commitDetections, 0);
});

test("legacy handshake frames are never commit-classified even when the payload contains commitTransaction", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.SEVER_BEFORE_COMMIT
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  const query = buildOpQuery({
    command: {
      hello: 1,
      note: "commitTransaction",
      filter: { text: "commitTransaction is only payload text" }
    }
  });
  client.write(query);

  const reply = await reader.waitForFrame(
    (frame) => frame.legacy === true && frame.opCode === OP_REPLY_OPCODE
  );
  assert.equal(reply.responseTo, 1);

  const stats = proxy.getStats();
  assert.equal(stats.commitDetections, 0);
  assert.equal(stats.withheldCommit, false);
  assert.equal(stats.ackDropped, false);
  assert.equal(target.received.length, 1);
  assert.equal(target.received[0].raw.toString("hex"), query.toString("hex"));
  assert.equal(
    proxy.getEvents().some((event) => event.type === "connection-severed"),
    false
  );
});

test("a legacy OP_REPLY is not ACK-dropped when responseTo matches a commit requestID", async (t) => {
  const target = await startRawTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.DROP_COMMIT_ACK
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  const commit = buildOpMsg({ requestID: 42, command: { commitTransaction: 1 } });
  client.write(commit);
  await target.waitForBytes(commit.length);
  assert.equal(proxy.getStats().forwardedCommit, true);

  const collision = buildOpReply({ responseTo: 42, documents: [{ ok: 1 }] });
  const targetSocket = await target.waitForSocket();
  targetSocket.write(collision);

  const forwarded = await reader.waitForFrame(
    (frame) => frame.legacy === true && frame.opCode === OP_REPLY_OPCODE
  );
  assert.equal(forwarded.raw.toString("hex"), collision.toString("hex"));
  assert.equal(forwarded.responseTo, 42);

  const stats = proxy.getStats();
  assert.equal(stats.ackDropped, false);
  assert.equal(stats.droppedAckResponseTo, null);
  assert.equal(reader.isClosed(), false);
});

test("a malformed legacy length severs the connection without forwarding bytes", async (t) => {
  const target = await startRawTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.NEGATIVE_CONTROL
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(12, 0); // below the 16-byte wire header
  client.write(prefix);

  await reader.waitForClose();
  assert.equal(
    proxy.getEvents().some((event) => event.type === "parse-error" && event.fatal === true),
    true
  );
  assert.equal(
    proxy.getEvents().some((event) => event.type === "connection-severed"),
    true
  );
  assert.equal(target.receivedBytes().length, 0);
});

test("an unsupported opcode severs the connection without forwarding bytes", async (t) => {
  const target = await startRawTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.NEGATIVE_CONTROL
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  const frame = Buffer.from(buildOpQuery());
  frame.writeInt32LE(2012, 12); // OP_COMPRESSED
  client.write(frame);

  await reader.waitForClose();
  const sever = proxy
    .getEvents()
    .find((event) => event.type === "connection-severed");
  assert.ok(sever);
  assert.equal(sever.reason, "client-to-server-parse-error");
  assert.equal(target.receivedBytes().length, 0);
});

// ---------------------------------------------------------------------------
// F2 — opt-in arming: observe setup commits, fault only the effect commit
// ---------------------------------------------------------------------------

test("armed: false observes a commit and forwards it without injecting the fault", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.SEVER_BEFORE_COMMIT,
    armed: false
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  client.write(buildOpMsg({ requestID: 20, command: { commitTransaction: 1 } }));

  // The request reaches the target and its ACK comes back, so no fault landed.
  await waitFor(
    () => target.received.some((frame) => frame.command?.name === "commitTransaction"),
    2_000,
    "unarmed commit at the target"
  );
  const acknowledgement = await reader.waitForFrame((frame) => frame.responseTo === 20);
  assert.equal(acknowledgement.command.name, "ok");

  const stats = proxy.getStats();
  assert.equal(stats.armed, false);
  assert.equal(stats.commitDetections, 1);
  assert.equal(stats.armedCommitDetections, 0);
  assert.equal(stats.unarmedCommitDetections, 1);
  assert.equal(stats.withheldCommit, false);
  assert.equal(stats.forwardedCommit, false);
  assert.equal(stats.ackDropped, false);
  assert.equal(
    proxy.getEvents().some((event) => event.type === "connection-severed"),
    false
  );
  const detection = proxy
    .getEvents()
    .find((event) => event.type === "commit-detected");
  assert.equal(detection.armed, false);
});

test("arm() is idempotent and emits exactly one ordered proxy-armed marker", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.SEVER_BEFORE_COMMIT,
    armed: false
  });
  t.after(async () => {
    await proxy.close();
    await target.close();
  });

  const before = proxy.getEvents().length;
  const first = proxy.arm();
  assert.equal(first.armed, true);
  assert.equal(first.changed, true);
  assert.equal(first.seq, before + 1);
  assert.equal(proxy.getStats().armedAtSeq, first.seq);

  const second = proxy.arm();
  assert.equal(second.armed, true);
  assert.equal(second.changed, false);
  assert.equal(second.seq, first.seq);
  assert.equal(proxy.getStats().armedAtSeq, first.seq);
  assert.equal(
    proxy.getEvents().filter((event) => event.type === "proxy-armed").length,
    1
  );
  assert.equal(proxy.getStats().armed, true);
});

test("arm() on an already-armed proxy adds no event and preserves default behaviour", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.NEGATIVE_CONTROL
  });
  t.after(async () => {
    await proxy.close();
    await target.close();
  });

  assert.equal(proxy.getStats().armed, true);
  const before = proxy.getEvents().length;
  const result = proxy.arm();
  assert.equal(result.changed, false);
  assert.equal(proxy.getEvents().length, before);
  assert.equal(
    proxy.getEvents().some((event) => event.type === "proxy-armed"),
    false
  );
});

test("a commit observed before arm() is not faulted; a commit after arm() is withheld", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.SEVER_BEFORE_COMMIT,
    armed: false
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  client.write(buildOpMsg({ requestID: 21, command: { commitTransaction: 1 } }));
  await waitFor(
    () => target.received.some((frame) => frame.command?.name === "commitTransaction"),
    2_000,
    "pre-arm commit at the target"
  );
  await reader.waitForFrame((frame) => frame.responseTo === 21);
  assert.equal(proxy.getStats().unarmedCommitDetections, 1);
  assert.equal(proxy.getStats().withheldCommit, false);

  const armed = proxy.arm();
  client.write(buildOpMsg({ requestID: 22, command: { commitTransaction: 1 } }));

  await reader.waitForClose();
  const stats = proxy.getStats();
  assert.equal(stats.armedCommitDetections, 1);
  assert.equal(stats.unarmedCommitDetections, 1);
  assert.equal(stats.commitDetections, 2);
  assert.equal(stats.withheldCommit, true);
  assert.equal(
    target.received.filter((frame) => frame.command?.name === "commitTransaction")
      .length,
    1
  );
  const detection = proxy
    .getEvents()
    .find((event) => event.type === "commit-detected" && event.armed === true);
  assert.ok(detection);
  assert.ok(detection.seq > armed.seq);
});

test("a commit after arm() in ACK-drop mode is forwarded and its acknowledgement dropped", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.DROP_COMMIT_ACK,
    armed: false
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);
  const armed = proxy.arm();
  client.write(buildOpMsg({ requestID: 23, command: { commitTransaction: 1 } }));

  await waitFor(
    () => target.received.some((frame) => frame.command?.name === "commitTransaction"),
    2_000,
    "armed commit at the target"
  );
  await reader.waitForClose();

  const stats = proxy.getStats();
  assert.equal(stats.armedCommitDetections, 1);
  assert.equal(stats.forwardedCommit, true);
  assert.equal(stats.ackDropped, true);
  assert.equal(stats.droppedAckResponseTo, 23);
  const forwardedEvent = proxy
    .getEvents()
    .find((event) => event.type === "commit-forwarded");
  assert.ok(forwardedEvent);
  assert.ok(forwardedEvent.seq > armed.seq);
});

test("withhold-commit-hold withholds the armed commit without severing the connection", async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({
    targetPort: target.port,
    mode: PROXY_MODES.WITHHOLD_COMMIT_HOLD,
    armed: false
  });
  const client = await connectClient(proxyPort(proxy));
  t.after(async () => {
    client.destroy();
    await proxy.close();
    await target.close();
  });

  const reader = createReader(client);

  // Before arm(): the commit frame is observed and forwarded unchanged.
  client.write(buildOpMsg({ requestID: 30, command: { commitTransaction: 1 } }));
  await waitFor(
    () => target.received.some((frame) => frame.command?.name === "commitTransaction"),
    2_000,
    "unarmed commit at the target"
  );
  await reader.waitForFrame((frame) => frame.responseTo === 30);

  const armed = proxy.arm();
  client.write(buildOpMsg({ requestID: 31, command: { commitTransaction: 1 } }));

  // The armed commit must never reach the target and must produce no reply.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const commitReceipts = target.received.filter(
    (frame) => frame.command?.name === "commitTransaction"
  );
  assert.equal(commitReceipts.length, 1, "the armed commit must not be forwarded");
  assert.equal(
    reader.frames.some((frame) => frame.responseTo === 31),
    false,
    "the withheld commit must produce no acknowledgement"
  );

  // Deliberately no severance: the writer stays blocked in its commit await,
  // which is exactly the world the T8-CRASH parent must SIGKILL into.
  const events = proxy.getEvents();
  const withheld = events.find(
    (event) => event.type === "commit-withheld" && event.requestID === 31
  );
  assert.ok(withheld, "the armed commit must be withheld");
  assert.equal(withheld.held, true);
  assert.ok(withheld.seq > armed.seq);
  assert.equal(
    events.some((event) => event.type === "connection-severed"),
    false,
    "withhold-commit-hold must not sever the connection"
  );

  const stats = proxy.getStats();
  assert.equal(stats.withheldCommit, true);
  assert.equal(stats.forwardedCommit, false);
  assert.equal(stats.ackDropped, false);
  assert.equal(stats.armedCommitDetections, 1);

  // The connection is deliberately still open and usable by the client.
  assert.equal(client.destroyed, false);
  assert.equal(client.writable, true);
});
