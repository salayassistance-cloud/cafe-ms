// WP04-06 — Independent P4 verifier for the disposable T2 harness.
//
// AUTHORED FOR THE OFFLINE T2 HARNESS. NOT EXECUTED BY THE AUTHORING PACKAGE.
//
// This module is deliberately isolated from the proxy under test:
// - It imports only the MongoDB driver and Node built-ins.
// - It never imports, constructs, or calls the T2 proxy.
// - It uses a separate MongoClient, directConnection: true, primary read
//   preference, and a majority read concern for every outcome read.
// - It reads the actual WP04 collections (`inventory_recovery_tasks`,
//   `inventory_recovery_events`, `inventory_recovery_operation_history`), not
//   proxy state and not a synthetic marker.
//
// A verifier result is evidence input only. It does not by itself close T2.

import { MongoClient } from "mongodb";

export const VERIFIER_READ_CONCERN = Object.freeze({ level: "majority" });
export const VERIFIER_READ_PREFERENCE = "primary";

export const WP04_COLLECTIONS = Object.freeze({
  task: "inventory_recovery_tasks",
  event: "inventory_recovery_events",
  history: "inventory_recovery_operation_history"
});

// L11: callers may tune only the selection timeout. Every safety-relevant option
// (directConnection, readPreference, readConcern, retry behaviour, topology) is
// fixed by this module and cannot be overridden through an options object.
const ALLOWED_OPTIONS = new Set(["serverSelectionTimeoutMS"]);

export function assertVerifierOptions(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("P4 verifier options must be a plain object.");
  }
  const rejected = Object.keys(options).filter((key) => !ALLOWED_OPTIONS.has(key));
  if (rejected.length > 0) {
    throw new Error(
      `P4 verifier options cannot be overridden: ${rejected.sort().join(", ")}.`
    );
  }
  if (options.serverSelectionTimeoutMS !== undefined) {
    const timeout = options.serverSelectionTimeoutMS;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new Error("P4 verifier serverSelectionTimeoutMS must be a positive integer.");
    }
  }
  return { ...options };
}

export function createIndependentVerifierClient(uri, options = {}) {
  if (typeof uri !== "string" || uri.length === 0) {
    throw new Error("P4 verifier requires a non-empty MongoDB URI.");
  }
  const safe = assertVerifierOptions(options);
  return new MongoClient(uri, {
    directConnection: true,
    readPreference: VERIFIER_READ_PREFERENCE,
    readConcern: VERIFIER_READ_CONCERN,
    retryWrites: false,
    retryReads: false,
    serverSelectionTimeoutMS: safe.serverSelectionTimeoutMS ?? 15_000
  });
}

function readOptions() {
  return {
    readConcern: VERIFIER_READ_CONCERN,
    readPreference: VERIFIER_READ_PREFERENCE
  };
}

/**
 * Read the three actual WP04 collections through a supplied client. Exported so
 * the collection/filter/read-option contract can be tested without a database.
 */
export async function readWp04EffectsWithClient(
  client,
  { dbName, taskId, eventId, historyId }
) {
  if (!client || !dbName || !taskId || !eventId || !historyId) {
    throw new Error(
      "P4 verifier requires a client, dbName, taskId, eventId, and historyId."
    );
  }
  const db = client.db(dbName);
  const options = readOptions();
  const [task, event, history] = await Promise.all([
    db.collection(WP04_COLLECTIONS.task).findOne({ taskId }, options),
    db.collection(WP04_COLLECTIONS.event).findOne({ eventId }, options),
    db.collection(WP04_COLLECTIONS.history).findOne({ historyId }, options)
  ]);
  return { task, event, history, readOptions: options };
}

/**
 * Pure evaluation of the independently-read WP04 records.
 *
 * `expectPresent === false` is the T2-A assertion: the transaction must have
 * left no task, event, or history row. `expectPresent === true` is the T2-B
 * assertion: all three must exist and cross-reference each other.
 */
export function evaluateWp04Effects({
  task = null,
  event = null,
  history = null,
  expected = {},
  expectPresent = true
} = {}) {
  const found = {
    task: task !== null && task !== undefined,
    event: event !== null && event !== undefined,
    history: history !== null && history !== undefined
  };
  const problems = [];

  if (expectPresent === false) {
    for (const name of ["task", "event", "history"]) {
      if (found[name]) problems.push(`${name} row is present but the transaction must be absent`);
    }
    return { complete: problems.length === 0, expectPresent: false, found, problems };
  }

  if (!found.task) problems.push("task row is missing");
  if (!found.event) problems.push("event row is missing");
  if (!found.history) problems.push("history row is missing");

  if (found.task) {
    if (expected.taskId !== undefined && task.taskId !== expected.taskId) {
      problems.push("task.taskId does not match the expected task");
    }
    if (expected.status !== undefined && task.status !== expected.status) {
      problems.push("task.status does not match the expected status");
    }
  }
  if (found.event) {
    if (expected.eventId !== undefined && event.eventId !== expected.eventId) {
      problems.push("event.eventId does not match the expected event");
    }
    if (expected.taskId !== undefined && event.taskId !== expected.taskId) {
      problems.push("event.taskId does not reference the task");
    }
    if (expected.eventType !== undefined && event.eventType !== expected.eventType) {
      problems.push("event.eventType does not match the expected event type");
    }
  }
  if (found.history) {
    if (expected.historyId !== undefined && history.historyId !== expected.historyId) {
      problems.push("history.historyId does not match the expected history");
    }
    if (expected.taskId !== undefined && history.taskId !== expected.taskId) {
      problems.push("history.taskId does not reference the task");
    }
    if (expected.eventId !== undefined && history.eventId !== expected.eventId) {
      problems.push("history.eventId does not reference the event");
    }
    if (expected.historyState !== undefined && history.state !== expected.historyState) {
      problems.push("history.state does not match the expected terminal state");
    }
  }

  return {
    complete: problems.length === 0,
    expectPresent: true,
    found,
    problems
  };
}

function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return Number(value);
}

/**
 * Read the durable state of one real-writer scenario: the task, the reserved
 * effect event and history identities, and every event recorded for the task.
 * All reads use primary/majority read options on the supplied client.
 */
export async function readWp04EffectStateWithClient(
  client,
  { dbName, taskId, eventId, historyId }
) {
  if (!client || !dbName || !taskId || !eventId || !historyId) {
    throw new Error(
      "P4 effect-state verifier requires a client, dbName, taskId, eventId, and historyId."
    );
  }
  const db = client.db(dbName);
  const options = readOptions();
  const [task, effectEvent, effectHistory, events] = await Promise.all([
    db.collection(WP04_COLLECTIONS.task).findOne({ taskId }, options),
    db.collection(WP04_COLLECTIONS.event).findOne({ eventId }, options),
    db.collection(WP04_COLLECTIONS.history).findOne({ historyId }, options),
    db
      .collection(WP04_COLLECTIONS.event)
      .find({ taskId }, { ...options, sort: { sequenceNumber: 1 } })
      .toArray()
  ]);
  return { task, effectEvent, effectHistory, events, readOptions: options };
}

/**
 * Pure evaluation of the real-writer T2 outcome.
 *
 * `expected.effectCommitted === false` is the T2-A assertion: W1/W2/W6 committed,
 * but the W7 effect transaction left the task LEASED with the operation still
 * PREPARED and no effect event/history row. `true` is the T2-B assertion: the
 * effect transaction committed all three rows.
 */
export function evaluateWp04EffectState({
  task = null,
  effectEvent = null,
  effectHistory = null,
  events = [],
  expected = {}
} = {}) {
  if (typeof expected.effectCommitted !== "boolean") {
    throw new Error("P4 effect-state evaluation requires expected.effectCommitted.");
  }
  const problems = [];
  const committed = expected.effectCommitted;
  const taskEvents = Array.isArray(events) ? events : [];

  if (!task) {
    problems.push("task row is missing");
  } else {
    if (expected.taskId !== undefined && task.taskId !== expected.taskId) {
      problems.push("task.taskId does not match the expected task");
    }
    if (expected.taskStatus !== undefined && task.status !== expected.taskStatus) {
      problems.push(
        `task.status is '${task.status}', expected '${expected.taskStatus}'`
      );
    }
    if (expected.operationState !== undefined) {
      if (task.pendingOperation?.state !== expected.operationState) {
        problems.push(
          `task.pendingOperation.state is '${task.pendingOperation?.state}', ` +
            `expected '${expected.operationState}'`
        );
      }
    }
    if (expected.operationId !== undefined) {
      if (task.pendingOperation?.operationId !== expected.operationId) {
        problems.push("task.pendingOperation.operationId does not match the reservation");
      }
    }
    if (expected.eventId !== undefined) {
      if (task.pendingOperation?.eventId !== expected.eventId) {
        problems.push("task.pendingOperation.eventId does not match the reserved event");
      }
    }
    if (
      expected.eventSequenceCounter !== undefined &&
      toNumberOrNull(task.eventSequenceCounter) !== expected.eventSequenceCounter
    ) {
      problems.push(
        `task.eventSequenceCounter is ${String(task.eventSequenceCounter)}, ` +
          `expected ${expected.eventSequenceCounter}`
      );
    }
    if (
      expected.leaseGeneration !== undefined &&
      toNumberOrNull(task.leaseGeneration) !== expected.leaseGeneration
    ) {
      problems.push("task.leaseGeneration does not match the claimed lease");
    }
    if (
      committed &&
      expected.resolution !== undefined &&
      task.resolution !== expected.resolution
    ) {
      problems.push("task.resolution does not match the approved effect");
    }
    if (committed && expected.currentFingerprint !== undefined) {
      if (task.currentFingerprint !== expected.currentFingerprint) {
        problems.push("task.currentFingerprint does not match the effect field");
      }
    }
  }

  if (committed) {
    if (!effectEvent) {
      problems.push("effect event row is missing");
    } else {
      if (expected.eventId !== undefined && effectEvent.eventId !== expected.eventId) {
        problems.push("event.eventId does not match the reserved effect event");
      }
      if (expected.taskId !== undefined && effectEvent.taskId !== expected.taskId) {
        problems.push("event.taskId does not reference the task");
      }
      if (
        expected.eventType !== undefined &&
        effectEvent.eventType !== expected.eventType
      ) {
        problems.push("event.eventType does not match the approved effect");
      }
      if (
        expected.sequenceNumber !== undefined &&
        toNumberOrNull(effectEvent.sequenceNumber) !== expected.sequenceNumber
      ) {
        problems.push("event.sequenceNumber does not match the reserved sequence");
      }
    }

    if (!effectHistory) {
      problems.push("operation history row is missing");
    } else {
      if (
        expected.historyId !== undefined &&
        effectHistory.historyId !== expected.historyId
      ) {
        problems.push("history.historyId does not match the reserved operation");
      }
      if (expected.taskId !== undefined && effectHistory.taskId !== expected.taskId) {
        problems.push("history.taskId does not reference the task");
      }
      if (
        expected.eventId !== undefined &&
        effectHistory.eventId !== expected.eventId
      ) {
        problems.push("history.eventId does not reference the effect event");
      }
      if (
        expected.historyState !== undefined &&
        effectHistory.state !== expected.historyState
      ) {
        problems.push("history.state is not the committed terminal state");
      }
    }
  } else {
    if (effectEvent) problems.push("effect event row is present but the effect must be absent");
    if (effectHistory) {
      problems.push("operation history row is present but the effect must be absent");
    }
    const leakedEffect = taskEvents.find(
      (event) =>
        event.eventId === expected.eventId ||
        event.eventType === expected.eventType ||
        (expected.sequenceNumber !== undefined &&
          toNumberOrNull(event.sequenceNumber) === expected.sequenceNumber)
    );
    if (leakedEffect) {
      problems.push("an effect event at the reserved sequence is present");
    }
  }

  const setupTypes = taskEvents
    .filter((event) => event.eventId !== expected.eventId)
    .map((event) => event.eventType);
  const requiredSetup = Array.isArray(expected.setupEventTypes)
    ? expected.setupEventTypes
    : [];
  for (const eventType of requiredSetup) {
    if (!setupTypes.includes(eventType)) {
      problems.push(`setup event '${eventType}' is missing`);
    }
  }

  return {
    complete: problems.length === 0,
    effectCommitted: committed,
    found: {
      task: task !== null && task !== undefined,
      effectEvent: effectEvent !== null && effectEvent !== undefined,
      effectHistory: effectHistory !== null && effectHistory !== undefined,
      setupEvents: setupTypes.length
    },
    problems
  };
}

export async function verifyWp04EffectStateWithIndependentClient({
  uri,
  dbName,
  taskId,
  eventId,
  historyId,
  effectCommitted,
  expected = {},
  serverSelectionTimeoutMS = 15_000
}) {
  if (!uri || !dbName || !taskId || !eventId || !historyId) {
    throw new Error(
      "P4 effect-state verifier requires uri, dbName, taskId, eventId, and historyId."
    );
  }
  if (typeof effectCommitted !== "boolean") {
    throw new Error("P4 effect-state verifier requires effectCommitted.");
  }

  const client = createIndependentVerifierClient(uri, { serverSelectionTimeoutMS });
  const startedAt = new Date().toISOString();

  try {
    await client.connect();
    const { task, effectEvent, effectHistory, events } =
      await readWp04EffectStateWithClient(client, {
        dbName,
        taskId,
        eventId,
        historyId
      });

    const evaluation = evaluateWp04EffectState({
      task,
      effectEvent,
      effectHistory,
      events,
      expected: {
        taskId,
        eventId,
        historyId,
        effectCommitted,
        ...expected
      }
    });

    return {
      verifier: "independent-direct-primary-majority",
      directConnection: true,
      readPreference: VERIFIER_READ_PREFERENCE,
      readConcern: VERIFIER_READ_CONCERN.level,
      collections: WP04_COLLECTIONS,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...evaluation,
      documents: { task, effectEvent, effectHistory, events }
    };
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// T8-CRASH — abandonment-state verification (OD-37)
// ---------------------------------------------------------------------------

/**
 * Read the durable abandonment state of one task: the task document, every
 * event recorded for the task, the settlement history row, and the total number
 * of history rows for the task. All reads use primary/majority read options on
 * the supplied client.
 */
export async function readWp04AbandonmentStateWithClient(
  client,
  { dbName, taskId, historyId }
) {
  if (!client || !dbName || !taskId || !historyId) {
    throw new Error(
      "P4 abandonment verifier requires a client, dbName, taskId, and historyId."
    );
  }
  const db = client.db(dbName);
  const options = readOptions();
  const [task, events, settlementHistory, historyRowCount] = await Promise.all([
    db.collection(WP04_COLLECTIONS.task).findOne({ taskId }, options),
    db
      .collection(WP04_COLLECTIONS.event)
      .find({ taskId }, { ...options, sort: { sequenceNumber: 1 } })
      .toArray(),
    db.collection(WP04_COLLECTIONS.history).findOne({ historyId }, options),
    db.collection(WP04_COLLECTIONS.history).countDocuments({ taskId }, options)
  ]);
  return { task, events, settlementHistory, historyRowCount, readOptions: options };
}

/**
 * Pure evaluation of the authorized W8 abandonment outcome.
 *
 * Required shape: MANUAL_REQUIRED task with the ABANDONED reserved operation,
 * the approved escalation code and operator settlement, exactly one
 * RECOVERY_ESCALATED settlement event at the post-abandonment sequence, the
 * reserved effect sequence left as a permanent gap, and exactly one history row
 * in the ABANDONED terminal state referencing the reserved identity.
 */
export function evaluateWp04AbandonmentState({
  task = null,
  events = [],
  settlementHistory = null,
  historyRowCount = null,
  expected = {}
} = {}) {
  const problems = [];
  const taskEvents = Array.isArray(events) ? events : [];

  if (!task) {
    problems.push("task row is missing");
  } else {
    if (expected.taskId !== undefined && task.taskId !== expected.taskId) {
      problems.push("task.taskId does not match the expected task");
    }
    if (expected.taskStatus !== undefined && task.status !== expected.taskStatus) {
      problems.push(
        `task.status is '${task.status}', expected '${expected.taskStatus}'`
      );
    }
    if (
      expected.manualReasonCode !== undefined &&
      task.manualReasonCode !== expected.manualReasonCode
    ) {
      problems.push("task.manualReasonCode does not match the abandonment");
    }
    if (
      expected.escalationCode !== undefined &&
      task.escalation?.code !== expected.escalationCode
    ) {
      problems.push("task.escalation.code is not the approved escalation code");
    }

    const operation = task.pendingOperation;
    if (!operation || typeof operation !== "object") {
      problems.push("task.pendingOperation is missing");
    } else {
      if (expected.operationId !== undefined && operation.operationId !== expected.operationId) {
        problems.push("pendingOperation.operationId does not match the reserved operation");
      }
      if (
        expected.operationState !== undefined &&
        operation.state !== expected.operationState
      ) {
        problems.push(
          `pendingOperation.state is '${operation.state}', expected '${expected.operationState}'`
        );
      }
      if (
        expected.reservedEventId !== undefined &&
        operation.eventId !== expected.reservedEventId
      ) {
        problems.push("pendingOperation.eventId does not match the reserved identity");
      }
      const settlement = operation.settlement;
      if (!settlement || typeof settlement !== "object") {
        problems.push("pendingOperation.settlement is missing");
      } else {
        if (
          expected.operatorId !== undefined &&
          settlement.operatorId !== expected.operatorId
        ) {
          problems.push("settlement.operatorId does not match the authorized operator");
        }
        if (
          expected.operatorRole !== undefined &&
          settlement.operatorRole !== expected.operatorRole
        ) {
          problems.push("settlement.operatorRole does not match the authorized role");
        }
        if (expected.basis !== undefined && settlement.basis !== expected.basis) {
          problems.push("settlement.basis is not the approved audit wording");
        }
        if (typeof settlement.authorizationId !== "string") {
          problems.push("settlement.authorizationId is missing");
        }
        if (!settlement.at) {
          problems.push("settlement.at is missing");
        }
      }
    }

    if (
      expected.eventSequenceCounter !== undefined &&
      toNumberOrNull(task.eventSequenceCounter) !== expected.eventSequenceCounter
    ) {
      problems.push(
        `task.eventSequenceCounter is ${String(task.eventSequenceCounter)}, ` +
          `expected ${expected.eventSequenceCounter}`
      );
    }
  }

  const settlementEvent = taskEvents.find(
    (event) => expected.settlementEventId !== undefined && event.eventId === expected.settlementEventId
  );
  if (!settlementEvent) {
    problems.push("settlement event row is missing");
  } else {
    if (
      expected.settlementEventType !== undefined &&
      settlementEvent.eventType !== expected.settlementEventType
    ) {
      problems.push("settlement event type is not the approved escalation event");
    }
    if (expected.taskId !== undefined && settlementEvent.taskId !== expected.taskId) {
      problems.push("settlement event does not reference the task");
    }
    if (
      expected.settlementSequenceNumber !== undefined &&
      toNumberOrNull(settlementEvent.sequenceNumber) !== expected.settlementSequenceNumber
    ) {
      problems.push(
        "settlement event sequence does not match the post-abandonment sequence"
      );
    }
  }

  if (expected.reservedEventId !== undefined) {
    const leakedReserved = taskEvents.find(
      (event) =>
        event.eventId === expected.reservedEventId ||
        (expected.reservedSequenceNumber !== undefined &&
          toNumberOrNull(event.sequenceNumber) === expected.reservedSequenceNumber)
    );
    if (leakedReserved) {
      problems.push("an event exists at the permanently reserved sequence");
    }
  }

  if (expected.totalEvents !== undefined && taskEvents.length !== expected.totalEvents) {
    problems.push(
      `task event count is ${taskEvents.length}, expected ${expected.totalEvents}`
    );
  }

  if (!settlementHistory) {
    problems.push("settlement history row is missing");
  } else {
    if (expected.historyId !== undefined && settlementHistory.historyId !== expected.historyId) {
      problems.push("history.historyId does not match the reserved operation");
    }
    if (expected.taskId !== undefined && settlementHistory.taskId !== expected.taskId) {
      problems.push("history.taskId does not reference the task");
    }
    if (
      expected.historyState !== undefined &&
      settlementHistory.state !== expected.historyState
    ) {
      problems.push("history.state is not the abandoned terminal state");
    }
    if (
      expected.reservedEventId !== undefined &&
      settlementHistory.eventId !== expected.reservedEventId
    ) {
      problems.push("history.eventId does not reference the reserved identity");
    }
  }

  if (
    expected.historyRowCount !== undefined &&
    Number(historyRowCount) !== expected.historyRowCount
  ) {
    problems.push(
      `history row count is ${String(historyRowCount)}, expected ${expected.historyRowCount}`
    );
  }

  return {
    complete: problems.length === 0,
    found: {
      task: task !== null && task !== undefined,
      settlementEvent: settlementEvent !== null && settlementEvent !== undefined,
      settlementHistory: settlementHistory !== null && settlementHistory !== undefined
    },
    problems
  };
}

export async function verifyWp04AbandonmentStateWithIndependentClient({
  uri,
  dbName,
  taskId,
  historyId,
  expected = {},
  serverSelectionTimeoutMS = 15_000
}) {
  if (!uri || !dbName || !taskId || !historyId) {
    throw new Error(
      "P4 abandonment verifier requires uri, dbName, taskId, and historyId."
    );
  }

  const client = createIndependentVerifierClient(uri, { serverSelectionTimeoutMS });
  const startedAt = new Date().toISOString();

  try {
    await client.connect();
    const { task, events, settlementHistory, historyRowCount } =
      await readWp04AbandonmentStateWithClient(client, { dbName, taskId, historyId });

    const evaluation = evaluateWp04AbandonmentState({
      task,
      events,
      settlementHistory,
      historyRowCount,
      expected
    });

    return {
      verifier: "independent-direct-primary-majority",
      directConnection: true,
      readPreference: VERIFIER_READ_PREFERENCE,
      readConcern: VERIFIER_READ_CONCERN.level,
      collections: WP04_COLLECTIONS,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...evaluation,
      documents: { task, events, settlementHistory, historyRowCount }
    };
  } finally {
    await client.close();
  }
}

export async function verifyWp04EffectsWithIndependentClient({
  uri,
  dbName,
  taskId,
  eventId,
  historyId,
  expectPresent = true,
  expected = {},
  serverSelectionTimeoutMS = 15_000
}) {
  if (!uri || !dbName || !taskId || !eventId || !historyId) {
    throw new Error(
      "P4 verifier requires uri, dbName, taskId, eventId, and historyId."
    );
  }

  const client = createIndependentVerifierClient(uri, { serverSelectionTimeoutMS });
  const startedAt = new Date().toISOString();

  try {
    await client.connect();
    const { task, event, history } = await readWp04EffectsWithClient(client, {
      dbName,
      taskId,
      eventId,
      historyId
    });

    const evaluation = evaluateWp04Effects({
      task,
      event,
      history,
      expected: { taskId, eventId, historyId, ...expected },
      expectPresent
    });

    return {
      verifier: "independent-direct-primary-majority",
      directConnection: true,
      readPreference: VERIFIER_READ_PREFERENCE,
      readConcern: VERIFIER_READ_CONCERN.level,
      collections: WP04_COLLECTIONS,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...evaluation,
      documents: { task, event, history }
    };
  } finally {
    await client.close();
  }
}

export async function verifyMarkerWithIndependentClient({
  uri,
  dbName,
  collectionName,
  markerId,
  serverSelectionTimeoutMS = 15_000
}) {
  if (!uri || !dbName || !collectionName || markerId === undefined || markerId === null) {
    throw new Error("P4 verifier requires uri, dbName, collectionName, and markerId.");
  }

  const client = createIndependentVerifierClient(uri, { serverSelectionTimeoutMS });
  const startedAt = new Date().toISOString();

  try {
    await client.connect();
    const document = await client
      .db(dbName)
      .collection(collectionName)
      .findOne({ _id: markerId }, readOptions());

    return {
      verifier: "independent-direct-primary-majority",
      directConnection: true,
      readPreference: VERIFIER_READ_PREFERENCE,
      readConcern: VERIFIER_READ_CONCERN.level,
      startedAt,
      finishedAt: new Date().toISOString(),
      found: document !== null,
      document
    };
  } finally {
    await client.close();
  }
}

export async function readReplicaSetStateWithIndependentClient({
  uri,
  serverSelectionTimeoutMS = 15_000
}) {
  const client = createIndependentVerifierClient(uri, { serverSelectionTimeoutMS });
  try {
    await client.connect();
    const admin = client.db("admin");
    const hello = await admin.command({ hello: 1 });
    const status = await admin.command({ replSetGetStatus: 1 });
    return {
      verifier: "independent-direct-primary-majority",
      directConnection: true,
      readPreference: VERIFIER_READ_PREFERENCE,
      readConcern: VERIFIER_READ_CONCERN.level,
      setName: hello.setName ?? null,
      isWritablePrimary: hello.isWritablePrimary === true,
      primary: status.myState === 1 ? status.members.find((member) => member.self)?.name ?? null : null,
      members: status.members.map((member) => ({
        name: member.name,
        stateStr: member.stateStr,
        health: member.health
      }))
    };
  } finally {
    await client.close();
  }
}
