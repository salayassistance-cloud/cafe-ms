// WP04-06 — Commit-aware loopback TCP proxy for the disposable T2 harness.
//
// AUTHORED FOR THE OFFLINE T2 HARNESS. NOT EXECUTED BY THE AUTHORING PACKAGE.
//
// The proxy uses the pure wire parser to identify `commitTransaction` by the
// parsed OP_MSG command name. It never classifies a commit by raw byte substring.
//
// Handshake design (F1):
// - mongodb 7.5.0 sends its initial handshake as OP_QUERY (opcode 2004) because
//   `supportsOpMsg` is false until a hello response supplies maxWireVersion;
//   mongod replies with OP_REPLY (opcode 1).
// - Both legacy frames are framed by `messageLength` and forwarded byte-for-byte
//   in both directions. They are never parsed, correlated, commit-classified, or
//   ACK-dropped.
// - Any other opcode (for example OP_COMPRESSED 2012) is rejected and the
//   connection is severed, so an unparsed frame can never smuggle a withheld
//   commit past classification.
//
// Correlation design (C1):
// - One OpMsgStreamDemultiplexer is shared by both directions of a connection,
//   so an OP_MSG request is registered once and the matching OP_MSG response
//   correlates to it.
// - A correlation warning is non-fatal; only a poisoned parser stream severs.
// - ACK-drop state is per client connection and keyed by the parsed commit
//   requestID, so an identical responseTo on another connection is unaffected.
//
// Arming (F2):
// - `armed: false` keeps the proxy in an observing pass-through state. Commit
//   frames are still parsed, counted, and recorded with `armed: false`, but no
//   fault is injected.
// - `arm()` switches the same listener into the configured fault mode and emits
//   a `proxy-armed` marker. This lets the real writer run W1/W2/W6 setup
//   transactions before the W7 effect commit is faulted, without adding a
//   second listener or reconnecting the driver.
// - The default is `armed: true`, so every existing mode is unchanged.
//
// The proxy owns only its own listening socket and the sockets it accepts; it
// does not inspect, signal, or stop any process.

import net from "node:net";

import {
  OpMsgStreamDemultiplexer,
  isCommitTransactionFrame,
  isLegacyHandshakeFrame
} from "./opmsg.mjs";

export const PROXY_MODES = Object.freeze({
  SEVER_BEFORE_COMMIT: "sever-before-commit",
  DROP_COMMIT_ACK: "drop-commit-ack",
  // T8-CRASH: an armed commit is withheld but the connection is deliberately
  // NOT severed, so the writer stays blocked in its commit await and the
  // parent runner can SIGKILL it while W7 is still in flight.
  WITHHOLD_COMMIT_HOLD: "withhold-commit-hold",
  NEGATIVE_CONTROL: "negative-control"
});

export const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "::1", "localhost"]);

function assertMode(mode) {
  if (!Object.values(PROXY_MODES).includes(mode)) {
    throw new Error(`Unsupported T2 proxy mode '${mode}'.`);
  }
}

function assertLoopbackHost(host, field) {
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new Error(
      `T2 proxy ${field} must be a loopback host (${LOOPBACK_HOSTS.join(", ")}), got '${host}'.`
    );
  }
}

export function createCommitAwareProxy({
  listenHost = "127.0.0.1",
  listenPort,
  targetHost = "127.0.0.1",
  targetPort,
  mode,
  maxMessageBytes,
  socketTimeoutMs = 120_000,
  armed = true,
  onEvent = () => {}
}) {
  assertMode(mode);
  assertLoopbackHost(listenHost, "listenHost");
  assertLoopbackHost(targetHost, "targetHost");

  if (typeof armed !== "boolean") {
    throw new Error("T2 proxy armed must be a boolean.");
  }

  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65_535) {
    throw new Error("T2 proxy listenPort must be an integer in 0..65535.");
  }
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535) {
    throw new Error("T2 proxy targetPort must be an integer in 1..65535.");
  }
  if (listenPort !== 0 && listenPort === targetPort) {
    throw new Error("T2 proxy listenPort must differ from targetPort.");
  }
  if (!Number.isInteger(socketTimeoutMs) || socketTimeoutMs < 0) {
    throw new Error("T2 proxy socketTimeoutMs must be a non-negative integer.");
  }

  const events = [];
  const sockets = new Set();
  const allCommitRequestIDs = new Set();
  let server = null;
  let connectionSequence = 0;
  let closePromise = null;
  let commitDetections = 0;
  let forwardedCommit = false;
  let withheldCommit = false;
  let ackDropped = false;
  let droppedAckResponseTo = null;
  let correlationWarnings = 0;
  let legacyFramesForwarded = 0;
  let isArmed = armed;
  let armedAtSeq = null;
  let armedCommitDetections = 0;
  let unarmedCommitDetections = 0;

  const emit = (event) => {
    const enriched = { ...event, seq: events.length + 1, at: new Date().toISOString() };
    events.push(enriched);
    try {
      onEvent(enriched);
    } catch {
      // A consumer callback must never break the proxy.
    }
  };

  const destroyQuietly = (socket) => {
    try {
      socket.destroy();
    } catch {}
  };

  server = net.createServer((clientSocket) => {
    const connectionId = ++connectionSequence;
    sockets.add(clientSocket);

    const serverSocket = net.connect({ host: targetHost, port: targetPort });
    sockets.add(serverSocket);

    // C1: a single demultiplexer observes both directions for this connection.
    const demux = new OpMsgStreamDemultiplexer({ maxMessageBytes });
    // H6: ACK-drop state is scoped to this connection and to parsed commit
    // requestIDs, never to a proxy-global requestID.
    const commitRequestIDs = new Set();
    let severed = false;

    const sever = (reason) => {
      if (severed) return;
      severed = true;
      emit({ type: "connection-severed", connectionId, reason });
      destroyQuietly(clientSocket);
      destroyQuietly(serverSocket);
    };

    // M1/M2: forward complete parsed frames, never the raw chunk. This keeps a
    // coalesced non-commit + commit chunk from leaking the withheld commit, and
    // applies TCP backpressure by pausing the source until the target drains.
    const writeFrame = (target, source, frame) => {
      if (severed) return;
      try {
        const accepted = target.write(frame.raw);
        if (accepted === false && typeof source.pause === "function") {
          source.pause();
          target.once("drain", () => {
            if (!severed && typeof source.resume === "function") source.resume();
          });
        }
      } catch {
        sever("write-failure");
      }
    };

    // F1: OP_QUERY/OP_REPLY handshake frames are opaque. Forward the exact bytes
    // and record the event, but never register, correlate, classify, or drop them.
    const forwardLegacyFrame = (frame, target, source, direction) => {
      legacyFramesForwarded += 1;
      emit({
        type: "legacy-frame-forwarded",
        connectionId,
        direction,
        opCode: frame.opCode,
        messageLength: frame.messageLength,
        requestID: frame.requestID,
        responseTo: frame.responseTo
      });
      writeFrame(target, source, frame);
    };

    const handleParseResult = (parsed, direction) => {
      if (parsed.poisoned) {
        emit({
          type: "parse-error",
          connectionId,
          direction,
          fatal: true,
          errors: parsed.errors.map((error) => ({
            code: error.code,
            message: error.message
          }))
        });
        sever(`${direction}-parse-error`);
        return false;
      }

      const correlation = parsed.errors.filter(
        (error) => error.code === "UNKNOWN_RESPONSE_CORRELATION"
      );
      if (correlation.length > 0) {
        correlationWarnings += correlation.length;
        emit({
          type: "response-correlation-warning",
          connectionId,
          direction,
          fatal: false,
          warnings: correlation.map((error) => ({
            code: error.code,
            responseTo: error.responseTo ?? null
          }))
        });
      }

      const otherErrors = parsed.errors.filter(
        (error) => error.code !== "UNKNOWN_RESPONSE_CORRELATION"
      );
      if (otherErrors.length > 0) {
        emit({
          type: "parse-error",
          connectionId,
          direction,
          fatal: true,
          errors: otherErrors.map((error) => ({
            code: error.code,
            message: error.message
          }))
        });
        sever(`${direction}-parse-error`);
        return false;
      }

      return true;
    };

    const handleCommitFrame = (frame) => {
      commitDetections += 1;
      allCommitRequestIDs.add(frame.requestID);
      if (isArmed) armedCommitDetections += 1;
      else unarmedCommitDetections += 1;
      emit({
        type: "commit-detected",
        connectionId,
        requestID: frame.requestID,
        responseTo: frame.responseTo,
        command: frame.command.name,
        mode,
        armed: isArmed
      });

      // F2 arming: before `arm()`, commit frames are parsed and recorded but
      // forwarded unchanged. No fault is injected into setup transactions.
      if (!isArmed) {
        writeFrame(serverSocket, clientSocket, frame);
        return;
      }

      if (mode === PROXY_MODES.SEVER_BEFORE_COMMIT) {
        withheldCommit = true;
        emit({
          type: "commit-withheld",
          connectionId,
          requestID: frame.requestID
        });
        sever("pre-commit-severance");
        return;
      }

      if (mode === PROXY_MODES.WITHHOLD_COMMIT_HOLD) {
        withheldCommit = true;
        emit({
          type: "commit-withheld",
          connectionId,
          requestID: frame.requestID,
          held: true
        });
        // Deliberately no forward and no sever: the client stays blocked in its
        // commit await with the transaction uncommitted on the server, which is
        // exactly the crash-during-W7 world T8-CRASH must SIGKILL into.
        return;
      }

      if (mode === PROXY_MODES.DROP_COMMIT_ACK) {
        forwardedCommit = true;
        commitRequestIDs.add(frame.requestID);
        emit({
          type: "commit-forwarded",
          connectionId,
          requestID: frame.requestID
        });
        writeFrame(serverSocket, clientSocket, frame);
        return;
      }

      // Negative control: a real commit is still classified, but this mode is
      // expected to be driven by non-commit commands containing the substring.
      emit({
        type: "commit-observed-negative-control",
        connectionId,
        requestID: frame.requestID
      });
      writeFrame(serverSocket, clientSocket, frame);
    };

    clientSocket.on("data", (chunk) => {
      if (severed) return;
      const parsed = demux.push(chunk);
      if (!handleParseResult(parsed, "client-to-server")) return;

      for (const frame of parsed.frames) {
        if (severed) return;
        if (isLegacyHandshakeFrame(frame)) {
          forwardLegacyFrame(frame, serverSocket, clientSocket, "client-to-server");
          continue;
        }
        if (isCommitTransactionFrame(frame)) {
          handleCommitFrame(frame);
          if (severed) return;
          continue;
        }
        writeFrame(serverSocket, clientSocket, frame);
      }
    });

    serverSocket.on("data", (chunk) => {
      if (severed) return;
      const parsed = demux.push(chunk);
      if (!handleParseResult(parsed, "server-to-client")) return;

      for (const frame of parsed.frames) {
        if (severed) return;

        // F1: a legacy OP_REPLY is never an OP_MSG commit acknowledgement, even
        // if its responseTo numerically matches a commit requestID. Forward it.
        if (isLegacyHandshakeFrame(frame)) {
          forwardLegacyFrame(frame, clientSocket, serverSocket, "server-to-client");
          continue;
        }

        // H6/M6: drop only the ACK whose responseTo matches a commit requestID
        // recorded on this connection. The correlated request proves the frame
        // is the commit acknowledgement rather than an unrelated response that
        // happens to reuse the same numeric id.
        if (commitRequestIDs.has(frame.responseTo)) {
          ackDropped = true;
          droppedAckResponseTo = frame.responseTo;
          emit({
            type: "commit-ack-dropped",
            connectionId,
            responseTo: frame.responseTo,
            requestID: frame.requestID,
            correlatedRequestID: frame.correlatedRequest?.requestID ?? null,
            correlatedCommand: frame.correlatedRequest?.command?.name ?? null
          });
          sever("post-commit-ack-loss");
          return;
        }

        writeFrame(clientSocket, serverSocket, frame);
      }
    });

    clientSocket.on("error", (error) => {
      if (severed) return;
      emit({
        type: "socket-error",
        connectionId,
        direction: "client",
        code: error.code ?? null,
        message: error.message
      });
      sever("client-socket-error");
    });
    serverSocket.on("error", (error) => {
      if (severed) return;
      emit({
        type: "socket-error",
        connectionId,
        direction: "server",
        code: error.code ?? null,
        message: error.message
      });
      sever("server-socket-error");
    });

    if (socketTimeoutMs > 0) {
      clientSocket.setTimeout(socketTimeoutMs);
      serverSocket.setTimeout(socketTimeoutMs);
      clientSocket.on("timeout", () => {
        if (severed) return;
        emit({ type: "socket-timeout", connectionId, direction: "client" });
        sever("client-socket-timeout");
      });
      serverSocket.on("timeout", () => {
        if (severed) return;
        emit({ type: "socket-timeout", connectionId, direction: "server" });
        sever("server-socket-timeout");
      });
    }

    clientSocket.on("close", () => {
      sockets.delete(clientSocket);
      if (!severed) destroyQuietly(serverSocket);
    });
    serverSocket.on("close", () => {
      sockets.delete(serverSocket);
      if (!severed) destroyQuietly(clientSocket);
    });
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener("listening", onListening);
          // M3: a failed listen must release any partially bound server/socket
          // state before the caller sees the rejection.
          try {
            server.close();
          } catch {}
          for (const socket of sockets) destroyQuietly(socket);
          sockets.clear();
          reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(listenPort, listenHost);
      });

      const address = server.address();
      const actualPort =
        address && typeof address === "object" ? address.port : listenPort;
      emit({
        type: "proxy-listening",
        listenHost,
        listenPort: actualPort,
        targetHost,
        targetPort,
        mode,
        armed: isArmed
      });
    },

    /**
     * Switch from observing pass-through to the configured fault mode.
     * Idempotent: a second call changes nothing and adds no event.
     */
    arm() {
      if (isArmed) {
        return { armed: true, changed: false, seq: armedAtSeq };
      }
      isArmed = true;
      armedAtSeq = events.length + 1;
      emit({ type: "proxy-armed", mode });
      return { armed: true, changed: true, seq: armedAtSeq };
    },

    async close() {
      for (const socket of sockets) destroyQuietly(socket);
      sockets.clear();
      if (!server.listening) {
        if (closePromise) await closePromise;
        return;
      }
      if (!closePromise) {
        closePromise = new Promise((resolve) => server.close(() => resolve()));
      }
      await closePromise;
    },

    getAddress() {
      const address = server.address();
      if (!address || typeof address !== "object") return null;
      return { host: address.address, port: address.port, family: address.family };
    },

    getEvents() {
      return events.slice();
    },

    getStats() {
      return {
        mode,
        armed: isArmed,
        armedAtSeq,
        armedCommitDetections,
        unarmedCommitDetections,
        commitDetections,
        forwardedCommit,
        withheldCommit,
        ackDropped,
        droppedAckResponseTo,
        commitRequestIDs: [...allCommitRequestIDs],
        correlationWarnings,
        legacyFramesForwarded,
        openSockets: sockets.size
      };
    }
  };
}
