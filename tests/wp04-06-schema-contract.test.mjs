// WP04-06 Package 1 — DB-free schema-contract and deterministic-identity tests.
//
// No MongoDB connection is opened. No environment file is read. No collection,
// index, migration, writer, worker, or scheduler is created. Model imports only
// declare Mongoose schema metadata.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ABANDONABLE_STATUSES,
  APPROVAL_ROLES,
  APPROVAL_STATES,
  CLASSIFICATIONS,
  CONFIDENCES,
  ESCALATION_CODES,
  EVIDENCE_LEVELS,
  LAST_ERROR_CODES,
  MANUAL_REASON_CODES,
  OPERATION_SETTLEMENT_BASES,
  OPERATION_STATES,
  RESOLUTIONS,
  RULE_IDS,
  SEVERITIES,
  TASK_STATUSES,
  TERMINAL_OP_STATES,
  RecoveryTaskSchema,
} from "../lib/models/RecoveryTask.js";
import {
  ACTOR_ROLES,
  ACTOR_TYPES,
  BASE_DIAGNOSTIC_CODES,
  DIAGNOSTIC_CODES,
  EVENT_TYPES,
  RecoveryEventSchema,
  RecoveryOperationHistorySchema,
} from "../lib/models/RecoveryEvent.js";
import {
  EVENT_ID_PATTERN,
  OPERATION_HISTORY_ID_PATTERN,
  RecoveryIdentityError,
  TASK_ID_PATTERN,
  TASK_KEY_PATTERN,
  assertEventId,
  assertOperationHistoryId,
  assertTaskId,
  buildEventId,
  buildFindingIdentityKey,
  buildOperationHistoryId,
  buildTaskKey,
  validateEventId,
  validateOperationHistoryId,
  validateTaskId,
} from "../lib/recovery/identity.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (path) => readFileSync(join(root, path), "utf8");

const TASK_ID = "REC:v1:031a19a9fa67cd650906b2f27b1c2727";
const ORDER_ID = "64b000000000000000000001";
const ITEM_ID = "64b000000000000000000004";
const LINE_ID = "64b000000000000000000002";
const OPERATION_ID = "op-1";

function enumStrings(path) {
  return [...path.enumValues].filter((value) => typeof value === "string");
}

function indexByKey(schema, keys) {
  const signature = JSON.stringify(keys);
  return schema.indexes().find(([candidate]) => JSON.stringify(candidate) === signature);
}

test("identity: finding identity is deterministic and preserves typed nulls", () => {
  const first = buildFindingIdentityKey("D01", "STOCK_NEGATIVE", ORDER_ID, ITEM_ID, null);
  const second = buildFindingIdentityKey("D01", "STOCK_NEGATIVE", ORDER_ID, ITEM_ID, null);

  assert.equal(first, second);
  assert.equal(first, "REC:v1:031a19a9fa67cd650906b2f27b1c2727");
  assert.match(first, TASK_ID_PATTERN);

  const withLine = buildFindingIdentityKey("D01", "STOCK_NEGATIVE", ORDER_ID, ITEM_ID, LINE_ID);
  assert.equal(withLine, "REC:v1:a42a256221435e087afc683bb68dfe25");
  assert.notEqual(withLine, first);

  const numericLine = buildFindingIdentityKey("D01", "STOCK_NEGATIVE", ORDER_ID, ITEM_ID, 42);
  const typedNumericLine = buildFindingIdentityKey("D01", "STOCK_NEGATIVE", ORDER_ID, ITEM_ID, {
    $num: 42,
  });
  const stringLine = buildFindingIdentityKey("D01", "STOCK_NEGATIVE", ORDER_ID, ITEM_ID, "42");

  assert.equal(numericLine, typedNumericLine);
  assert.notEqual(numericLine, stringLine);
  assert.equal(numericLine, "REC:v1:a965ac6fb84814a65f1ced3f0c6530a0");
});

test("identity: task, event and H1 history identities use approved formats", () => {
  assert.equal(buildTaskKey(ORDER_ID.toUpperCase()), `GRP:${ORDER_ID}`);
  assert.match(buildTaskKey(ORDER_ID), TASK_KEY_PATTERN);

  assert.equal(buildEventId(TASK_ID, 5), `EVT:${TASK_ID}:5`);
  assert.equal(buildEventId(TASK_ID, 5n), `EVT:${TASK_ID}:5`);
  assert.match(buildEventId(TASK_ID, "7"), EVENT_ID_PATTERN);

  assert.equal(
    buildOperationHistoryId(TASK_ID, OPERATION_ID),
    `OPH:${TASK_ID}:${OPERATION_ID}`,
  );
  assert.match(buildOperationHistoryId(TASK_ID, OPERATION_ID), OPERATION_HISTORY_ID_PATTERN);

  assert.equal(validateTaskId(TASK_ID), true);
  assert.equal(validateTaskId("REC:v1:not-hex"), false);
  assert.equal(validateEventId(`EVT:${TASK_ID}:1`), true);
  assert.equal(validateEventId(`EVT:${TASK_ID}:0`), true); // Format only; range is enforced by build.
  assert.equal(validateOperationHistoryId(`OPH:${TASK_ID}:${OPERATION_ID}`), true);
  assert.equal(validateOperationHistoryId(`OPA:${TASK_ID}:${OPERATION_ID}`), false);

  assert.throws(() => assertTaskId("REC:v1:nope"), RecoveryIdentityError);
  assert.throws(() => assertEventId(`EVT:${TASK_ID}:x`), RecoveryIdentityError);
  assert.throws(() => assertOperationHistoryId("OPH:nope"), RecoveryIdentityError);
  assert.throws(() => buildEventId(TASK_ID, 0), RecoveryIdentityError);
  assert.throws(() => buildEventId(TASK_ID, 1_000_001), RecoveryIdentityError);
  assert.throws(() => buildOperationHistoryId(TASK_ID, ""), RecoveryIdentityError);
});

test("task contract: approved enums and operation-state constants are exact", () => {
  assert.deepEqual([...TASK_STATUSES].sort(), [
    "CANCELLED",
    "CLOSED",
    "DETECTED",
    "LEASED",
    "MANUAL_REQUIRED",
    "RESOLVED",
    "RETRY_SCHEDULED",
  ]);
  assert.deepEqual([...CLASSIFICATIONS].sort(), ["ALERT", "DEFECT", "INFO"]);
  assert.deepEqual([...SEVERITIES], ["CRITICAL", "HIGH", "MEDIUM", "INFO"]);
  assert.deepEqual([...CONFIDENCES], ["HIGH", "MEDIUM", "LOW"]);
  assert.deepEqual([...EVIDENCE_LEVELS], ["E0", "E1", "E2", "E3"]);
  assert.deepEqual([...RULE_IDS], ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09", "D10"]);

  assert.ok(MANUAL_REASON_CODES.includes("AMBIGUOUS_COMMIT"));
  assert.ok(ESCALATION_CODES.includes("ESC_EXHAUSTED"));
  assert.ok(!ESCALATION_CODES.includes("ESC_UNSUPPORTED"));
  assert.deepEqual([...APPROVAL_STATES], ["PENDING", "APPROVED", "REJECTED"]);
  assert.ok(APPROVAL_ROLES.includes("ROLE-RECOVERY-EXECUTOR"));
  assert.deepEqual([...RESOLUTIONS], ["ALREADY_CORRECT", "ESCALATED", "CANCELLED"]);
  assert.deepEqual([...LAST_ERROR_CODES], [
    "EVIDENCE_DRIFT",
    "TIMEOUT",
    "CONFLICT",
    "SEQUENCE_OVERFLOW",
  ]);

  assert.deepEqual([...OPERATION_STATES], ["PREPARED", "COMMITTED", "ABANDONED"]);
  assert.ok(!OPERATION_STATES.includes("UNKNOWN_COMMIT"));
  assert.deepEqual([...TERMINAL_OP_STATES], ["COMMITTED", "ABANDONED"]);
  assert.deepEqual([...ABANDONABLE_STATUSES], ["LEASED"]);
  assert.deepEqual([...OPERATION_SETTLEMENT_BASES], ["OPERATOR_DECISION_AFTER_HOLD"]);
});

test("task contract: schema metadata preserves approved constraints", () => {
  assert.equal(RecoveryTaskSchema.options.collection, "inventory_recovery_tasks");
  assert.equal(RecoveryTaskSchema.options.autoIndex, false);
  assert.equal(RecoveryTaskSchema.options.timestamps, false);

  const status = RecoveryTaskSchema.path("status");
  assert.deepEqual(enumStrings(status), [...TASK_STATUSES]);
  assert.equal(status.options.default, "DETECTED");
  assert.equal(RecoveryTaskSchema.path("isOpen").options.default, true);

  assert.deepEqual(enumStrings(RecoveryTaskSchema.path("classification")), [
    ...CLASSIFICATIONS,
  ]);
  assert.deepEqual(enumStrings(RecoveryTaskSchema.path("severity")), [...SEVERITIES]);
  assert.deepEqual(enumStrings(RecoveryTaskSchema.path("confidence")), [...CONFIDENCES]);
  assert.deepEqual(enumStrings(RecoveryTaskSchema.path("evidenceLevel")), [
    ...EVIDENCE_LEVELS,
  ]);
  assert.deepEqual(enumStrings(RecoveryTaskSchema.path("rule")), [...RULE_IDS]);

  assert.equal(RecoveryTaskSchema.path("taskId").options.required, true);
  assert.equal(RecoveryTaskSchema.path("taskId").options.immutable, true);
  assert.equal(String(RecoveryTaskSchema.path("taskKey").options.match), String(TASK_KEY_PATTERN));
  assert.equal(
    String(RecoveryTaskSchema.path("findingIdentityKey").options.match),
    String(TASK_ID_PATTERN),
  );
  assert.equal(RecoveryTaskSchema.path("orderId").options.required, true);
  assert.equal(RecoveryTaskSchema.path("initialFingerprint").options.required, true);
  assert.equal(RecoveryTaskSchema.path("currentFingerprint").options.required, true);
  assert.equal(RecoveryTaskSchema.path("lastErrorField").options.maxlength, 64);

  assert.equal(RecoveryTaskSchema.path("leaseGeneration").options.default, 0n);
  assert.equal(RecoveryTaskSchema.path("eventSequenceCounter").options.default, 0n);
  assert.equal(RecoveryTaskSchema.path("attempts").options.max, 100);
  assert.equal(RecoveryTaskSchema.path("maxAttempts").options.immutable, true);

  assert.deepEqual(enumStrings(RecoveryTaskSchema.path("manualReasonCode")), [
    ...MANUAL_REASON_CODES,
  ]);
  assert.deepEqual(enumStrings(RecoveryTaskSchema.path("approval.state")), [
    ...APPROVAL_STATES,
  ]);
  assert.deepEqual(enumStrings(RecoveryTaskSchema.path("approval.operatorRole")), [
    ...APPROVAL_ROLES,
  ]);
  assert.deepEqual(enumStrings(RecoveryTaskSchema.path("escalation.code")), [
    ...ESCALATION_CODES,
  ]);

  for (const field of [
    "approvedBy",
    "approvedAt",
    "executedBy",
    "executedAt",
    "verifierId",
    "verifiedAt",
  ]) {
    assert.ok(RecoveryTaskSchema.path(field), `${field} must exist`);
  }
});

test("task contract: durableClass is Boolean|null and the eleven missing fields exist", () => {
  const durableClass = RecoveryTaskSchema.path("durableClass");
  assert.ok(durableClass);
  assert.equal(durableClass.instance, "Boolean");
  assert.equal(durableClass.options.type, Boolean);
  assert.equal(durableClass.options.default, null);
  assert.equal(durableClass.cast(true), true);
  assert.equal(durableClass.cast(false), false);
  assert.equal(durableClass.cast(null), null);

  // OD-10 §2.4 clause 6. `escalation.actualStatus` is retained from R3 and is
  // deliberately not counted among the eleven missing fields.
  const requiredFields = [
    "findingCodeOnly",
    "durableClass",
    "fingerprintSchema",
    "evidenceSchema",
    "executedBy",
    "executedAt",
    "verifierId",
    "verifiedAt",
    "escalation.expectedStatus",
    "escalation.expectedQuantity",
    "escalation.actualQuantity",
  ];
  for (const field of requiredFields) {
    assert.ok(RecoveryTaskSchema.path(field), `${field} must be declared`);
  }
  assert.ok(RecoveryTaskSchema.path("escalation.actualStatus"));
  assert.equal(RecoveryTaskSchema.path("findingCodeOnly").options.default, false);
  assert.equal(RecoveryTaskSchema.path("fingerprintSchema").options.default, "wp04-fingerprint-v1");
  assert.equal(RecoveryTaskSchema.path("evidenceSchema").options.default, "wp04-evidence-v1");
});

test("task contract: remaining clause-6 field types, defaults and bounds are exact", () => {
  // OD-10 §2.4 clause 6 — the seven fields whose types/defaults/bounds were not
  // asserted alongside durableClass. Exactness here is schema metadata only;
  // the canonical writer remains the primary enforcement boundary.
  const scalarFields = [
    ["executedBy", "String", null, { maxlength: 128 }],
    ["executedAt", "Date", null, {}],
    ["verifierId", "String", null, { maxlength: 128 }],
    ["verifiedAt", "Date", null, {}],
    ["escalation.expectedStatus", "String", null, {}],
  ];
  for (const [field, instance, defaultValue, options] of scalarFields) {
    const path = RecoveryTaskSchema.path(field);
    assert.ok(path, `${field} must be declared`);
    assert.equal(path.instance, instance, `${field}.instance`);
    assert.equal(path.options.default, defaultValue, `${field}.default`);
    for (const [key, value] of Object.entries(options)) {
      assert.equal(path.options[key], value, `${field}.${key}`);
    }
  }

  for (const field of ["escalation.expectedQuantity", "escalation.actualQuantity"]) {
    const path = RecoveryTaskSchema.path(field);
    assert.ok(path, `${field} must be declared`);
    assert.equal(path.instance, "Number", `${field}.instance`);
    assert.equal(path.options.default, null, `${field}.default`);
    const validator = path.options.validate.validator;
    for (const value of [null, undefined, 0, 12.5, 1_000_000]) {
      assert.equal(validator(value), true, `${field} accepts ${String(value)}`);
    }
    for (const value of [-1, 1_000_001, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      assert.equal(validator(value), false, `${field} rejects ${String(value)}`);
    }
  }
});

test("event contract: detail bounds for leaseDurationMs and delta are enforced", () => {
  const leaseDurationMs = RecoveryEventSchema.path("details.leaseDurationMs");
  assert.equal(leaseDurationMs.options.min, 1);
  assert.equal(leaseDurationMs.options.default, null);

  const consumedDelta = RecoveryEventSchema.path("details.delta.consumedDelta");
  const reservedDelta = RecoveryEventSchema.path("details.delta.reservedDelta");
  assert.ok(consumedDelta);
  assert.ok(reservedDelta);

  for (const path of [consumedDelta, reservedDelta]) {
    const validator = path.options.validate.validator;
    assert.equal(validator(null), true);
    assert.equal(validator(0), true);
    assert.equal(validator(1_000_000), true);
    assert.equal(validator(-1), false);
    assert.equal(validator(1_000_001), false);
    assert.equal(validator(Number.NaN), false);
    assert.equal(validator("1"), false);
  }
});

test("event contract: observedFingerprint is 64-hex and fencingToken is UUID v4", () => {
  const observed = RecoveryEventSchema.path("details.observedFingerprint");
  assert.ok(observed);
  assert.equal(observed.options.default, null);
  const observedPattern = observed.options.match;
  assert.ok(observedPattern);
  assert.equal(observedPattern.test("a".repeat(64)), true);
  assert.equal(observedPattern.test("0123456789abcdef".repeat(4)), true);
  for (const value of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), ""]) {
    assert.equal(
      observedPattern.test(value),
      false,
      `observedFingerprint rejects ${JSON.stringify(value)}`,
    );
  }

  const fencing = RecoveryEventSchema.path("fencingToken");
  assert.ok(fencing);
  assert.equal(fencing.options.default, null);
  assert.equal(fencing.options.immutable, true);
  const uuidPattern = fencing.options.match;
  assert.ok(uuidPattern);
  assert.equal(uuidPattern.test("123e4567-e89b-42d3-a456-426614174000"), true);
  assert.equal(uuidPattern.test("123E4567-E89B-42D3-A456-426614174000"), true);
  for (const value of [
    "123e4567-e89b-12d3-a456-426614174000",
    "123e4567-e89b-42d3-7456-426614174000",
    "123e4567-e89b-42d3-a456-42661417400",
    "123e4567e89b42d3a456426614174000",
    "not-a-uuid",
    "",
  ]) {
    assert.equal(uuidPattern.test(value), false, `fencingToken rejects ${JSON.stringify(value)}`);
  }
});

test("task contract: pendingOperation is the O2/H1 reservation, not UNKNOWN_COMMIT", () => {
  const pending = RecoveryTaskSchema.path("pendingOperation");
  assert.ok(pending);
  assert.equal(pending.options.default, null);

  assert.equal(RecoveryTaskSchema.path("pendingOperation.operationId").options.required, true);
  assert.deepEqual(enumStrings(RecoveryTaskSchema.path("pendingOperation.state")), [
    ...OPERATION_STATES,
  ]);
  assert.equal(
    RecoveryTaskSchema.path("pendingOperation.state").enumValues.includes("UNKNOWN_COMMIT"),
    false,
  );
  assert.equal(
    RecoveryTaskSchema.path("pendingOperation.leaseGeneration").options.required,
    true,
  );
  assert.equal(
    RecoveryTaskSchema.path("pendingOperation.sequenceNumber").options.min,
    1,
  );
  assert.equal(
    RecoveryTaskSchema.path("pendingOperation.sequenceNumber").options.max,
    1_000_000,
  );
  assert.equal(
    String(RecoveryTaskSchema.path("pendingOperation.eventId").options.match),
    String(EVENT_ID_PATTERN),
  );
  assert.equal(
    RecoveryTaskSchema.path("pendingOperation.intentDigest").options.required,
    true,
  );
  assert.equal(RecoveryTaskSchema.path("pendingOperation.reservedAt").options.required, true);
  assert.equal(RecoveryTaskSchema.path("pendingOperation.reservedBy").options.required, true);

  assert.deepEqual(enumStrings(RecoveryTaskSchema.path("pendingOperation.settlement.basis")), [
    ...OPERATION_SETTLEMENT_BASES,
  ]);
  assert.equal(
    RecoveryTaskSchema.path("pendingOperation.settlement.basis").enumValues.includes(
      "ABORT_CONFIRMED",
    ),
    false,
  );
});

test("task contract: index declarations are metadata only and match IDX-TSK-01..06", () => {
  const indexes = RecoveryTaskSchema.indexes();

  assert.deepEqual(indexByKey(RecoveryTaskSchema, { taskId: 1 }), [
    { taskId: 1 },
    { unique: true, name: "IDX-TSK-01" },
  ]);
  assert.deepEqual(indexByKey(RecoveryTaskSchema, { findingIdentityKey: 1 }), [
    { findingIdentityKey: 1 },
    {
      unique: true,
      partialFilterExpression: { isOpen: true },
      name: "IDX-TSK-02",
    },
  ]);
  assert.deepEqual(indexByKey(RecoveryTaskSchema, { orderId: 1, isOpen: 1 }), [
    { orderId: 1, isOpen: 1 },
    { name: "IDX-TSK-03" },
  ]);
  assert.deepEqual(
    indexByKey(RecoveryTaskSchema, {
      status: 1,
      isOpen: 1,
      nextAttemptAt: 1,
      leaseUntil: 1,
    }),
    [
      { status: 1, isOpen: 1, nextAttemptAt: 1, leaseUntil: 1 },
      { name: "IDX-TSK-04" },
    ],
  );
  assert.deepEqual(
    indexByKey(RecoveryTaskSchema, {
      leaseOwner: 1,
      leaseUntil: 1,
      leaseGeneration: 1,
    }),
    [
      { leaseOwner: 1, leaseUntil: 1, leaseGeneration: 1 },
      { partialFilterExpression: { isOpen: true }, name: "IDX-TSK-05" },
    ],
  );
  assert.deepEqual(
    indexByKey(RecoveryTaskSchema, { status: 1, severity: 1, createdAt: 1 }),
    [
      { status: 1, severity: 1, createdAt: 1 },
      { partialFilterExpression: { status: "MANUAL_REQUIRED" }, name: "IDX-TSK-06" },
    ],
  );

  assert.equal(indexes.length, 6);
  assert.ok(indexes.every(([, options]) => options.expireAfterSeconds === undefined));
});

test("event contract: approved event vocabulary removes RECOVERY_MANUAL_REQUIRED", () => {
  assert.ok(EVENT_TYPES.includes("RECOVERY_ESCALATED"));
  assert.ok(EVENT_TYPES.includes("RECOVERY_REJECTED"));
  assert.ok(EVENT_TYPES.includes("RECOVERY_CLOSED"));
  assert.ok(EVENT_TYPES.includes("RECOVERY_EVIDENCE_DRIFT"));
  assert.equal(EVENT_TYPES.includes("RECOVERY_MANUAL_REQUIRED"), false);

  assert.ok(ACTOR_ROLES.includes("ROLE-RECOVERY-EXECUTOR"));
  assert.ok(ACTOR_ROLES.includes("SERVICE-WORKER"));
  assert.deepEqual([...ACTOR_TYPES], ["WORKER", "OPERATOR", "SCANNER", "VERIFIER"]);

  assert.ok(DIAGNOSTIC_CODES.includes("TIMEOUT"));
  assert.ok(DIAGNOSTIC_CODES.includes("PERSISTENCE_TIMEOUT"));
  // OD-10 §2.4 clause 5 / OD-29: escalation categories are not diagnostics.
  assert.equal(DIAGNOSTIC_CODES.includes("ESC_UNKNOWN_COMMIT"), false);
  assert.equal(DIAGNOSTIC_CODES.includes("ESC_EXHAUSTED"), false);
  assert.deepEqual(DIAGNOSTIC_CODES, [...BASE_DIAGNOSTIC_CODES]);
  for (const code of ESCALATION_CODES) {
    assert.equal(DIAGNOSTIC_CODES.includes(code), false, `${code} must not be a diagnostic`);
  }
  for (const code of BASE_DIAGNOSTIC_CODES) {
    assert.equal(ESCALATION_CODES.includes(code), false, `${code} must not be an escalation`);
  }

  assert.equal(RecoveryEventSchema.options.collection, "inventory_recovery_events");
  assert.equal(RecoveryEventSchema.options.autoIndex, false);
  assert.equal(RecoveryEventSchema.options.timestamps, false);
  assert.deepEqual(enumStrings(RecoveryEventSchema.path("eventType")), [...EVENT_TYPES]);
  assert.deepEqual(enumStrings(RecoveryEventSchema.path("actorRole")), [...ACTOR_ROLES]);
  assert.deepEqual(enumStrings(RecoveryEventSchema.path("actorType")), [...ACTOR_TYPES]);
  assert.deepEqual(enumStrings(RecoveryEventSchema.path("details.diagnosticCode")), [
    ...DIAGNOSTIC_CODES,
  ]);
});

test("event contract: event identity, sequence bounds, and append-only evidence metadata", () => {
  assert.equal(
    String(RecoveryEventSchema.path("eventId").options.match),
    String(EVENT_ID_PATTERN),
  );
  assert.equal(
    String(RecoveryEventSchema.path("taskId").options.match),
    String(TASK_ID_PATTERN),
  );
  assert.equal(RecoveryEventSchema.path("sequenceNumber").options.min, 1);
  assert.equal(RecoveryEventSchema.path("sequenceNumber").options.max, 1_000_000);
  assert.equal(RecoveryEventSchema.path("leaseGeneration").options.max, 1_000_000);
  assert.equal(RecoveryEventSchema.path("details.toStatus").options.required, true);
  assert.equal(RecoveryEventSchema.path("details.attempts").options.required, true);
  assert.equal(RecoveryEventSchema.path("fencingToken").options.default, null);
  assert.equal(
    RecoveryEventSchema.path("fingerprintVersion").options.default,
    "wp04-fingerprint-v1",
  );
  assert.equal(
    RecoveryEventSchema.path("evidenceSchemaVersion").options.default,
    "wp04-evidence-v1",
  );

  const projectedEvidenceValidator =
    RecoveryEventSchema.path("projectedEvidence").options.validate.validator;
  assert.equal(projectedEvidenceValidator({ orderId: ORDER_ID }), true);
  assert.equal(projectedEvidenceValidator({ nested: { pin: "1234" } }), false);
  assert.equal(projectedEvidenceValidator({ nested: { accountNumber: "1" } }), false);

  assert.deepEqual(indexByKey(RecoveryEventSchema, { eventId: 1 }), [
    { eventId: 1 },
    { unique: true, name: "IDX-EVT-01" },
  ]);
  assert.deepEqual(
    indexByKey(RecoveryEventSchema, { taskId: 1, sequenceNumber: 1 }),
    [
      { taskId: 1, sequenceNumber: 1 },
      { unique: true, name: "IDX-EVT-02" },
    ],
  );
  assert.deepEqual(indexByKey(RecoveryEventSchema, { orderId: 1, timestamp: -1 }), [
    { orderId: 1, timestamp: -1 },
    { name: "IDX-EVT-03" },
  ]);
  assert.deepEqual(indexByKey(RecoveryEventSchema, { eventType: 1, timestamp: -1 }), [
    { eventType: 1, timestamp: -1 },
    { name: "IDX-EVT-04" },
  ]);
  assert.deepEqual(indexByKey(RecoveryEventSchema, { actorId: 1, timestamp: -1 }), [
    { actorId: 1, timestamp: -1 },
    { name: "IDX-EVT-05" },
  ]);
  assert.deepEqual(indexByKey(RecoveryEventSchema, { taskId: 1, leaseGeneration: 1 }), [
    { taskId: 1, leaseGeneration: 1 },
    { name: "IDX-EVT-06" },
  ]);

  assert.equal(RecoveryEventSchema.indexes().length, 6);
  assert.ok(
    RecoveryEventSchema.indexes().every(
      ([, options]) => options.expireAfterSeconds === undefined,
    ),
  );
});

test("H1 history contract: OPH identity, terminal states, and unique {taskId, operationId}", () => {
  assert.equal(
    RecoveryOperationHistorySchema.options.collection,
    "inventory_recovery_operation_history",
  );
  assert.equal(RecoveryOperationHistorySchema.options.autoIndex, false);
  assert.equal(RecoveryOperationHistorySchema.options.timestamps, false);

  assert.equal(RecoveryOperationHistorySchema.path("historyId").options.required, true);
  assert.equal(
    String(RecoveryOperationHistorySchema.path("historyId").options.match),
    String(OPERATION_HISTORY_ID_PATTERN),
  );
  assert.equal(
    String(RecoveryOperationHistorySchema.path("taskId").options.match),
    String(TASK_ID_PATTERN),
  );
  assert.equal(RecoveryOperationHistorySchema.path("operationId").options.required, true);
  assert.equal(
    String(RecoveryOperationHistorySchema.path("eventId").options.match),
    String(EVENT_ID_PATTERN),
  );
  assert.equal(RecoveryOperationHistorySchema.path("intentDigest").options.required, true);
  assert.equal(RecoveryOperationHistorySchema.path("settledAt").options.required, true);

  assert.deepEqual(enumStrings(RecoveryOperationHistorySchema.path("state")), [
    "COMMITTED",
    "ABANDONED",
  ]);
  assert.equal(
    RecoveryOperationHistorySchema.path("state").enumValues.includes("PREPARED"),
    false,
  );
  assert.ok(
    enumStrings(RecoveryOperationHistorySchema.path("manualReasonCode")).includes(
      "AMBIGUOUS_COMMIT",
    ),
  );
  assert.deepEqual(
    enumStrings(RecoveryOperationHistorySchema.path("basis")),
    ["OPERATOR_DECISION_AFTER_HOLD"],
  );
  assert.equal(
    RecoveryOperationHistorySchema.path("basis").enumValues.includes("ABORT_CONFIRMED"),
    false,
  );

  const uniqueHistoryIndex = indexByKey(RecoveryOperationHistorySchema, {
    taskId: 1,
    operationId: 1,
  });
  assert.ok(uniqueHistoryIndex);
  assert.deepEqual(uniqueHistoryIndex[1], { unique: true });
  assert.equal(uniqueHistoryIndex[1].partialFilterExpression, undefined);

  // The history record is audit evidence, not an active-operation fence.
  assert.equal(RecoveryOperationHistorySchema.path("isOpen"), undefined);
  assert.equal(RecoveryOperationHistorySchema.path("active"), undefined);

  assert.equal(
    RecoveryOperationHistorySchema.indexes().length,
    1,
    "only the approved unique history index is declared",
  );
});

test("source contracts: metadata-only modules, OD-30 same-transaction, OD-27-SC, OD-37", () => {
  const taskSource = readSource("lib/models/RecoveryTask.js");
  const eventSource = readSource("lib/models/RecoveryEvent.js");
  const identitySource = readSource("lib/recovery/identity.js");
  const sources = [taskSource, eventSource, identitySource];

  for (const source of sources) {
    assert.equal(/\.createIndex\s*\(/.test(source), false, "no index deployment");
    assert.equal(/\.startSession\s*\(/.test(source), false, "no transaction writer");
    assert.equal(/\.withTransaction\s*\(/.test(source), false, "no transaction writer");
    assert.equal(/\.insertOne\s*\(/.test(source), false, "no document writer");
    assert.equal(/\.updateOne\s*\(/.test(source), false, "no document writer");
    assert.equal(/connectToDatabase|mongoose\.connect|MONGODB_URI/.test(source), false);
    assert.equal(/process\.env/.test(source), false);
  }

  assert.match(identitySource, /OPH:<taskId>:<operationId>/);
  assert.match(eventSource, /task[\s\S]*document CAS is the fence/i);
  assert.match(eventSource, /T_effect/);
  assert.match(eventSource, /T_abandon/);
  assert.match(taskSource, /UNKNOWN_COMMIT/);
  assert.match(taskSource, /PREPARED/);
  assert.match(taskSource, /ABANDONABLE_STATUSES = \{LEASED\}/);
  assert.match(taskSource, /OPERATOR_DECISION_AFTER_HOLD/);
});

test("no unapproved retention, alerting, or TTL metadata is introduced", () => {
  for (const schema of [
    RecoveryTaskSchema,
    RecoveryEventSchema,
    RecoveryOperationHistorySchema,
  ]) {
    for (const [keys] of schema.indexes()) {
      assert.equal(JSON.stringify(keys).includes("expireAfter"), false);
    }
    for (const path of Object.keys(schema.paths)) {
      assert.equal(
        /^(retention|retentionDays|ttl|alertSink|oncall|sla)/i.test(path),
        false,
        `unapproved operational field ${path}`,
      );
    }
  }
});
