# Phase 2.4 — Recovery Readiness

Status: **READ-ONLY DESIGN REVIEW — NOT IMPLEMENTED, NOT APPROVED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Decisions: **A** (durable recovery architecture), **E** (ownership) as it applies to recovery
Companions: `phase-2-4-owner-decisions.md`, `phase-2-4-production-database-checklist.md`

> No recovery collection, model, index, worker, queue, cron, route, environment variable, or migration was created. No database was contacted. The queries below are illustrative and were not executed. No stock or payment record was changed. No Inventory V2 runtime was activated.

Evidence labels:

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in current source, tests, or git state. |
| **REAL-TESTED** | Exercised against the Phase 2.3 disposable replica set. |
| **INFERRED** | A logical consequence of verified code, not separately exercised. |
| **UNVERIFIED** | Requires staging/production/owner input. |
| **OWNER DECISION** | Requires an explicit business/operations decision. |

---

## 1. Why recovery is needed

The current design deliberately commits payment before inventory:

1. `payOrder` / `confirmPayment` atomically writes `status: "PAID"` and `paidAt` in one order document update.
2. `applyPaidInventory` then calls `consumeOrderInventory` in a separate MongoDB transaction.
3. If consumption fails, the order remains `PAID`; the failure is logged; an unconsumed hold is released.
4. Payment is never rolled back because stock/recipe is unavailable.

This is an accepted business boundary (Phase 2.3). It creates legitimate eventual-consistency states:

- `PAID` with no reservation and no movement (legacy or failed intake).
- `PAID` with a live `RESERVED`/`APPROVED` reservation but no movement.
- `CONSUMING` left behind by an abnormal termination.
- Movement evidence present while the reservation is not `CONSUMED`.
- Duplicate movement evidence.
- `CONSUMED` reservation with no movement.
- Hold drift (`reservedStock` greater than live reservation holds).
- Negative stock (should be impossible under conditional writes).

Without a durable recovery owner, these states are detectable only by ad-hoc queries and have no escalation path.

**VERIFIED:** no recovery collection, worker, queue, cron, lease, outbox, or scheduled endpoint exists. `package.json` has no queue/worker dependency.

---

## 2. Current durable primitives (verified)

| Primitive | Current contract | Evidence |
|---|---|---|
| Reservation identity | One document per order; unique `orderId` | `lib/models/InventoryReservation.js` |
| Reservation lifecycle | `NO_INVENTORY`, `RESERVED`, `APPROVAL_REQUIRED`, `APPROVED`, `CONSUMING`, `CONSUMED`, `RELEASED` | same |
| Consumption claim | Transactional `CONSUMING` claim; duplicate callers skip | `lib/inventoryReservationService.js` `consumeOrderInventory` |
| Conditional decrement | `currentStock >= qty` and `reservedStock >= qty` in the update filter | same |
| Movement identity | Unique partial `(refOrderId, reason, item)` | `lib/models/StockMovement.js` |
| Movement idempotency key | Unique partial `idempotencyKey`; `sale:<orderId>:<inventoryItemId>` | same |
| Release | Transactional `RELEASED` claim; hold returned exactly once | `lib/inventoryReservationService.js` `releaseOrderInventory` |
| Void | Transactional, deduplicated `voids` append; `SaleDeduction` → `Waste`; stock not restored | `lib/inventoryReservationService.js` `recordPostPreparationVoid` |
| Transaction retry | 3 attempts; transient only; unknown commit never retried; standalone → 503 | `lib/inventoryReservationService.js` `runInTransaction`; Phase 2.3 real tests |
| Order terminal guards | Atomic filters prevent `PAID` → `CANCELLED`/`ARCHIVED` | `lib/orderService.js` Phase 2.3 fix |
| V2 recovery vocabulary | `RECOVERY_REQUIRED`, `PARTIALLY_CONSUMED`, evidence-based payment readiness | `lib/inventory-v2/domain/states.js`, `paymentReadiness.js` (unwired) |

**What is missing:** a durable task identity, a state owner, a lease, a retry schedule, an escalation record, an alert sink, and an audit sink.

---

## 3. Architecture comparison

### 3.1 Option A — one transaction spanning payment and inventory

| Criterion | Assessment |
|---|---|
| Atomicity | Strongest: `PAID` and deduction commit together |
| Availability | A stock/recipe conflict would fail the customer payment |
| Business fit | Conflicts with the current “payment succeeds, inventory reconciles” policy |
| Compatibility | Requires refactoring payment, order creation, and reservation onto one session; changes error contracts and latency |
| Recovery | Minimal, but failures become customer-facing |
| Verdict | **Reject for settlement.** Possible later for order creation + initial reservation only. |

### 3.2 Option B — durable recovery state

| Criterion | Assessment |
|---|---|
| Atomicity | Per-step; eventual consistency between payment and stock |
| Availability | Payment never blocked by inventory |
| Compatibility | Reuses reservation/movement documents; one small recovery collection |
| Complexity | Medium: task record, lease, retry, audit, alert |
| Recovery | Strong when every step re-reads evidence and uses conditional writes |
| Verdict | **Recommended near-term.** |

### 3.3 Option C — transactional outbox

| Criterion | Assessment |
|---|---|
| Atomicity | Order write and outbox event commit together |
| Availability | Payment independent of inventory |
| Compatibility | Adds a collection, a publisher/consumer, and a dispatch loop; no consumer exists today |
| Complexity | Medium-high |
| Recovery | Excellent: the outbox row is the durable intent and can be replayed |
| Provider fit | Best fit before an external payment provider |
| Verdict | **Strategic target.** Do not build now without a worker/consumer and provider need. |

### 3.4 Option D — explicit reconciliation

| Criterion | Assessment |
|---|---|
| Atomicity | None by itself; it detects |
| Availability | High; read-only |
| Compatibility | No schema change for detection |
| Complexity | Medium: query design, thresholds, alert routing |
| Recovery | Essential safety net under any model |
| Verdict | **Required regardless of A/B/C.** |

### 3.5 Existing durable job infrastructure

**VERIFIED absence:** no BullMQ/Agenda/queue/cron/outbox dependency, no scheduled route, no background worker, no job collection. The only “job-like” code is the request-scoped transaction retry loop.

### 3.6 Recommendation

**Adopt B + D now; keep C as the target before an external provider; reject A for settlement.**

The smallest reliable architecture compatible with the current system is:

1. **Read-only reconciliation first** — a report/query with no schema change and no writes.
2. **One recovery-task collection** — one open task per order, with a small state set, lease, attempt counter, next-attempt time, evidence snapshot, and escalation flag.
3. **Existing idempotent primitives do the work** — the worker calls the current consumption/release/finalize functions; it never writes stock directly.
4. **One server-side worker identity** — or a named operator runbook step; never a POS client.
5. **Manual escalation** for ambiguous or high-risk classes.

---

## 4. Recovery record identity and uniqueness

### 4.1 Proposed identity

| Field | Contract |
|---|---|
| `_id` | MongoDB `ObjectId` (internal) |
| `taskId` | Server-generated stable string; **`RECOVERY:<orderId>`** |
| `orderId` | Order reference; **unique among open tasks** |
| `orderNumber` | Human reference snapshot |
| `reservationId` | Current reservation id, nullable |
| `class` | `R1`…`R8` |
| `status` | `DETECTED`, `LEASED`, `RETRY_SCHEDULED`, `MANUAL_REQUIRED`, `RESOLVED`, `CLOSED`, `CANCELLED` |
| `evidenceFingerprint` | Hash of the authoritative evidence read for this decision |
| `evidence` | Snapshot: order status/paidAt/version, reservation status/items, stock/hold, movement ids/quantities |
| `attempts` | Monotonic integer |
| `nextAttemptAt` | Date; backoff schedule |
| `leaseOwner` | Worker/operator identity |
| `leaseUntil` | Date |
| `lastErrorCode` | Bounded code |
| `lastErrorMessage` | Sanitized, bounded |
| `manualReason` | Why escalation is required |
| `approvedBy` / `approvedAt` | Manager/financial approval for a manual step |
| `resolvedAt` | Completion |
| `resolution` | `APPLIED`, `ALREADY_CORRECT`, `ESCALATED`, `CANCELLED` |
| `createdAt` / `updatedAt` | Timestamps |

### 4.2 Uniqueness rules

| Rule | Rationale |
|---|---|
| **At most one open task per order** | Prevents two workers from acting on the same divergence. A unique partial index on `{ orderId: 1 }` with `{ status: { $in: [open states] } }` is the proposed mechanism. |
| **Closed tasks retain history** | A later divergence may need a new task. Closed tasks must not block a new one. |
| **Task identity is server-derived** | Never accept a client `taskId`, timestamp, or random UUID. |
| **Evidence fingerprint is stable** | Re-running detection with unchanged evidence must converge to the same task, not create a second one. |

**Implementation note:** a partial unique index with `$in` on status is valid in MongoDB. The exact filter must be validated on the target server version. This is a proposal, not deployed.

---

## 5. Authoritative states and classification

### 5.1 Recovery classes

| Class | Detection | Safe action | Must not do |
|---|---|---|---|
| **R1 — PAID, no reservation, no movement** | `Order.status=PAID`; reservation missing; no `SaleDeduction` | Check for a legacy deduction. If evidence is conclusive, record `ALREADY_CORRECT`/legacy marker. Otherwise **manual** | Recompute a deduction from today's recipe without approval |
| **R2 — PAID, live reservation, no movement** | Reservation `RESERVED`/`APPROVED`/`APPROVAL_REQUIRED`/`NO_INVENTORY` with a positive hold and zero movement | Run the normal idempotent consumption transaction; it re-checks stock/hold/movement uniqueness | Force a deduction if physical/hold is insufficient |
| **R3 — stale `CONSUMING`** | `status=CONSUMING` and `updatedAt` older than the lease threshold | Inspect movement/stock evidence. If movements prove the deduction landed, conditionally finalize `CONSUMED`. Otherwise **manual** | Reset to `RESERVED` and re-deduct |
| **R4 — movement exists, reservation not `CONSUMED`** | `SaleDeduction` exists; reservation `RESERVED`/`CONSUMING` | Conditionally mark `CONSUMED`, set `consumedAt`, record evidence. No stock change | Deduct again |
| **R5 — duplicate movements** | More than one `SaleDeduction` for one `(order, item)` | **Manual.** Preserve all rows | Delete or decrement to “fix” |
| **R6 — `CONSUMED` without movement** | `consumedQuantity>0`; zero `SaleDeduction` | **Manual.** Accounting/ledger reconstruction | Re-decrement or silently recreate a movement |
| **R7 — hold drift** | `reservedStock` greater than the sum of live reservation holds | Recompute the expected hold; propose a conditional correction with a full audit record; **manual approval recommended** | Global zeroing of `reservedStock` |
| **R8 — negative stock** | `currentStock < 0` or `reservedStock < 0` | **Manual.** Should be impossible under conditional writes | Clamp silently |

### 5.2 State machine

```text
DETECTED
  -> LEASED                  (worker acquires lease)
  -> RETRY_SCHEDULED         (transient failure, attempts remain)
  -> RESOLVED               (action applied or already correct)
  -> MANUAL_REQUIRED        (ambiguous or high-risk class)
  -> CLOSED                 (record retained)

LEASED
  -> RESOLVED
  -> RETRY_SCHEDULED
  -> MANUAL_REQUIRED
  -> DETECTED                (lease expired with no decision; evidence re-read)

RETRY_SCHEDULED
  -> LEASED                 (nextAttemptAt reached)

MANUAL_REQUIRED
  -> LEASED                 (approved manual step)
  -> CANCELLED              (risk accepted / no action)
  -> CLOSED

RESOLVED / CANCELLED
  -> CLOSED
```

**Invariant:** a task cannot jump from `DETECTED` directly to `RESOLVED` without evidence and an action record.

---

## 6. Lease ownership, acquisition, renewal, and expiry

### 6.1 Lease contract

| Field | Contract |
|---|---|
| `leaseOwner` | Stable worker id (for example `recovery-worker:<instance>`), or a named operator id |
| `leaseUntil` | Short lease; proposed 5 minutes |
| `leaseToken` | Optional monotonic token/version to prevent stale renewal |
| `attempts` | Incremented on acquisition |
| `nextAttemptAt` | Backoff schedule |

### 6.2 Acquisition (atomic)

```text
findOneAndUpdate(
  {
    _id: taskId,
    $or: [
      { status: "DETECTED" },
      { status: "RETRY_SCHEDULED", nextAttemptAt: { $lte: now } },
      { status: "LEASED", leaseUntil: { $lt: now } }
    ]
  },
  {
    $set: {
      status: "LEASED",
      leaseOwner: workerId,
      leaseUntil: now + leaseMs,
      updatedAt: now
    },
    $inc: { attempts: 1 }
  },
  { returnDocument: "after" }
)
```

Only one caller can win the filter. A loser must re-read and exit. **No in-memory lock is sufficient.**

### 6.3 Renewal

```text
updateOne(
  { _id: taskId, status: "LEASED", leaseOwner: workerId, leaseUntil: { $gt: now } },
  { $set: { leaseUntil: now + leaseMs } }
)
```

Renewal fails if the lease was reclaimed; the worker must stop immediately.

### 6.4 Expiry and stale lease recovery

- A lease is reclaimable only after `leaseUntil < now`.
- Before reclaiming, the new owner **re-reads authoritative evidence**.
- If the previous owner may have committed an action, the new owner classifies from evidence (R3/R4), not from the previous owner's claim.
- If the previous owner wrote a partial action, the new owner must not repeat it blindly.

### 6.5 Concurrent worker protection

| Protection | Mechanism |
|---|---|
| Two workers, one task | Atomic lease acquisition |
| Two tasks, one order | Unique open-task identity per order |
| Worker crash | Lease expiry + evidence re-read |
| Clock skew | Use server time (`now` from the application or `$$NOW` where supported); document the tolerance |
| Split brain | Conditional lease renewal + ownership check on every write |

---

## 7. Retry limits and backoff

### 7.1 Proposed policy

| Parameter | Proposed value | Rationale |
|---|---|---|
| `maxAttempts` | 5 | Bounded; matches the V2 helper default |
| Backoff | Exponential, 30 s → 60 s → 120 s → 240 s → 480 s, capped at 15 min, with jitter | Avoid thundering herd; allow transient topology recovery |
| Attempts for unknown commit | **0 automatic retries** | Never retry an unknown commit; resolve evidence first |
| Attempts for deterministic business rejection | **0 automatic retries** | Escalate instead |
| Manual escalation threshold | `attempts >= maxAttempts` or class R1/R5/R6/R7/R8 | Prevent infinite repair loops |

### 7.2 Retry classes

| Failure | Action |
|---|---|
| Transient transaction error | Retry the same idempotent step, bounded |
| Unknown commit result | Re-read evidence; if committed, finalize; if absent, retry the **same action identity** once; if unresolved, escalate |
| Topology unavailable (`TRANSACTIONS_UNAVAILABLE`) | Do not hammer; schedule a later attempt and alert; fix topology |
| Deterministic business rejection | Escalate; never loop |
| Duplicate/conflict | Escalate; preserve evidence |

### 7.3 Idempotency

Every recovery action must use an existing stable identity or an equivalent conditional filter:

- reservation: one per `orderId`;
- consumption: `sale:<orderId>:<inventoryItemId>`;
- void: `voids.source` / `voids.lineId` deduplication;
- hold correction: a conditional update with expected before/after and an audit record.

The worker must never generate a new random identity for a retry.

---

## 8. Unknown commit handling

The current V1 helper already refuses to retry an unknown commit. The recovery worker must preserve that rule:

1. Treat the outcome as unknown.
2. Re-read the authoritative reservation, stock, and movement rows.
3. If the intended effect is present exactly once, mark `RESOLVED` and record `ALREADY_CORRECT`/recovered.
4. If the effect is definitively absent, retry the **same** action identity within the bounded budget.
5. If the evidence is contradictory or incomplete, mark `MANUAL_REQUIRED` and preserve the evidence.
6. Never apply a second deduction because the response was lost.

**REAL-TESTED:** the Phase 2.3 disposable replica-set suite proves unknown-commit recovery for reservation ensure and consumption without a duplicate.

---

## 9. Manual intervention workflow

### 9.1 Trigger conditions

A human must review when:

- `PAID` without reservation and without deduction, and no legacy evidence exists;
- stale `CONSUMING` without conclusive movement evidence;
- duplicate `SaleDeduction` rows for one order/item;
- `CONSUMED` without movement;
- negative `currentStock`/`reservedStock`;
- paid order with a `RELEASED` reservation and no deduction;
- hold drift not explained by live reservations;
- stock restored by any path other than an approved correction movement;
- retry budget exhausted;
- evidence fingerprint changes while a task is open (possible concurrent mutation).

### 9.2 Workflow

```text
DETECTED -> classify
  -> R2/R4: LEASED -> execute -> RESOLVED
  -> R1/R3 ambiguous/R5/R6/R7/R8: MANUAL_REQUIRED
       -> Manager reviews evidence
       -> financial reviewer reviews (if monetary/accounting)
       -> approved procedure executed by a different person
       -> independent verifier checks after-state
       -> CLOSED with evidence package
```

### 9.3 Required record

The manual record must include:

- task id, order id/number;
- class and reason;
- evidence snapshot (before);
- approver and approval timestamp;
- executor and execution timestamp;
- exact action/filter used;
- before/after values;
- verifier and verification timestamp;
- attachments/references (export, receipt, provider case, etc.).

---

## 10. Audit evidence and retention

### 10.1 Required audit fields

| Field | Purpose |
|---|---|
| `runId` / `taskId` | Correlate logs and review |
| `orderId` / `orderNumber` | Target |
| `reservationId` | Inventory intent |
| `class` | Why recovery ran |
| `detectedAt` | Detection time |
| `evidence` | Exact authoritative values read |
| `evidenceFingerprint` | Prove the decision inputs did not change |
| `action` | The single step attempted |
| `filters` | Exact conditional filter |
| `before` / `after` | Stock, hold, reservation status, movement count |
| `result` | Applied / skipped / escalated / failed |
| `owner` | Worker or operator identity |
| `approver` | Manager/financial approver |
| `verifier` | Independent verifier |
| `finishedAt` | Completion time |
| `notes` | Manual rationale |

### 10.2 Retention options

| Option | Description | Assessment |
|---|---|---|
| 90 days | Short operational retention | Likely insufficient for financial disputes |
| 1 year | Common operational/audit baseline | Minimum plausible |
| 7 years | Financial-record style retention | Recommended if finance requires it |
| Indefinite | Never expire | Storage/access burden |

**Recommendation:** the owner and financial reviewer set the period. Do not invent a statutory period. The audit record must be **append-only**; corrections are new entries, not edits. Access must be restricted and reads logged.

### 10.3 Storage

- Preferred: a dedicated append-only collection (for example `inventory_recovery_audit`) or the existing Hotel-style append-only audit pattern adapted to POS.
- The POS currently has **no durable financial audit collection**; structured logs are the only trail and are not sufficient for audit retention.
- Do not store PINs, tokens, or secrets. Store hashes/references only.

---

## 11. Alert delivery and failure handling

### 11.1 Current state

`lib/operationalLogger.js` emits one JSON line per event and explicitly does not buffer, retry, or ship logs. There is no alert sink, threshold, escalation policy, or on-call owner. **VERIFIED.**

### 11.2 Proposed alerts

| Signal | Severity | Proposed route |
|---|---|---|
| `PAID` without deduction beyond threshold | Critical | Operations + finance |
| Duplicate `SaleDeduction` | Critical | Operations + finance |
| Negative stock | Critical | Operations + Manager |
| `CONSUMED` without movement | Critical | Finance |
| Stale `CONSUMING` | High | Operations |
| Hold drift | High | Operations/Manager |
| Worker lease contention / repeated expiry | High | Operations |
| `TRANSACTIONS_UNAVAILABLE` rate | High | Operations/DBA |
| Retry budget exhausted | High | Operations |
| Task escalated to manual | Review | Manager (+ finance if monetary) |

### 11.3 Failure handling

- Alert delivery failure must not block payment.
- If the alert sink is down, the task remains durable and is retried by the scanner.
- A critical alert must have a named on-call recipient and an acknowledgement path.
- Alert payloads must be redacted (no secrets, no full account numbers).

---

## 12. Recovery worker authorization

| Concern | Contract |
|---|---|
| Identity | A server-side service identity or a named operator; **not** a Staff session and **not** a POS client |
| Authentication | A dedicated credential/secret with least privilege, provisioned outside the Staff role model; no default secret |
| Authorization | The worker may execute only approved deterministic classes (R2/R4) and only through existing conditional primitives |
| Human approval | R1/R3 ambiguous/R5–R8 require a Manager and, where financial, a financial reviewer |
| Audit | Every action records the worker/operator identity and approval chain |
| Network | No public endpoint; run in the trusted server environment or an operator-controlled CLI |
| Rate | Bounded concurrency; never a global scan-and-mutate |
| Kill switch | A documented way to disable the worker without deleting tasks |
| Separation | The worker cannot approve its own escalation; a human verifier is independent |

**System reality:** there is no service-account model today. Provisioning one is a separate approved change. Until then, recovery is a named operator runbook, not an autonomous worker.

---

## 13. Detection queries (illustrative, not executed)

These are read-only examples. They must be validated on staging with representative volumes and the deployed indexes. Do not run them against production as part of this phase.

### 13.1 Paid without reservation or deduction

```js
db.orders.aggregate([
  { $match: { status: "PAID" } },
  { $lookup: {
      from: "inventoryreservations",
      localField: "_id",
      foreignField: "orderId",
      as: "reservation"
  }},
  { $lookup: {
      from: "stockmovements",
      let: { oid: "$_id" },
      pipeline: [
        { $match: { $expr: { $and: [
            { $eq: ["$refOrderId", "$$oid"] },
            { $eq: ["$reason", "SaleDeduction"] }
        ] } } },
        { $limit: 1 }
      ],
      as: "deduction"
  }},
  { $match: {
      reservation: { $size: 0 },
      deduction: { $size: 0 },
      paidAt: { $lt: new Date(Date.now() - 15 * 60 * 1000) }
  }},
  { $project: { orderNumber: 1, paidAt: 1, totalAmount: 1 } }
])
```

### 13.2 Live reservation on a paid order

```js
db.inventoryreservations.find({
  status: { $in: ["RESERVED", "APPROVED", "APPROVAL_REQUIRED", "NO_INVENTORY", "CONSUMING"] }
}).forEach((r) => {
  const o = db.orders.findOne({ _id: r.orderId });
  if (o && o.status === "PAID") printjson({ orderId: r.orderId, status: r.status });
});
```

### 13.3 Stale `CONSUMING`

```js
db.inventoryreservations.find({
  status: "CONSUMING",
  updatedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) }
});
```

### 13.4 Duplicate deduction

```js
db.stockmovements.aggregate([
  { $match: { reason: "SaleDeduction", refOrderId: { $type: "objectId" } } },
  { $group: {
      _id: { order: "$refOrderId", item: "$item" },
      count: { $sum: 1 },
      totalQty: { $sum: "$quantity" }
  }},
  { $match: { count: { $gt: 1 } } }
]);
```

### 13.5 Reserved-stock drift

```js
db.inventoryitems.find({ reservedStock: { $gt: 0 } }).forEach((it) => {
  const reservations = db.inventoryreservations.find({
    status: { $in: ["RESERVED", "APPROVED", "APPROVAL_REQUIRED", "NO_INVENTORY"] },
    "items.inventoryItemId": it._id
  }).toArray();
  const expected = reservations.reduce((sum, r) => {
    const line = r.items.find((x) => String(x.inventoryItemId) === String(it._id));
    return sum + Number(line?.reservedQuantity || 0);
  }, 0);
  if (Math.abs(expected - it.reservedStock) > 0.0005) {
    printjson({ item: it._id, name: it.name, actual: it.reservedStock, expected });
  }
});
```

### 13.6 `CONSUMED` without movement

```js
db.inventoryreservations.find({ status: "CONSUMED" }).forEach((r) => {
  const n = db.stockmovements.countDocuments({
    refOrderId: r.orderId,
    reason: { $in: ["SaleDeduction", "Waste"] }
  });
  if (n === 0) printjson({ orderId: r.orderId, consumedAt: r.consumedAt });
});
```

### 13.7 Negative stock

```js
db.inventoryitems.find({
  $or: [{ currentStock: { $lt: 0 } }, { reservedStock: { $lt: 0 } }]
});
```

---

## 14. Recovery loop (pseudo-code)

```text
task = findOrCreateOpenTask(orderId)            # unique open task per order
if task.status in [RESOLVED, CLOSED, CANCELLED] -> exit
if lease acquire(task, workerId) fails          -> exit
try:
  evidence = read(order, reservation, inventory, movements)
  if evidence.fingerprint changed                 -> update evidence, release, exit
  switch classify(evidence):
    R2 -> consumeOrderInventory(order)            # idempotent transaction
    R4 -> finalizeConsumed(reservation, evidence) # conditional, no stock change
    R3 -> if movements prove landed: finalize; else manual
    R1/R5/R6/R7/R8 -> manual
  recordAudit(before, filters, result, after)
  markResolved or markManual
finally:
  releaseLease(task, workerId)
```

Re-running after a crash re-reads evidence and reaches the same decision. No step depends on an in-memory value.

---

## 15. Required tests

### 15.1 DB-free / source-contract

1. Task identity is server-derived and stable.
2. One open task per order; a second detection converges.
3. State transitions are guarded; no `DETECTED → RESOLVED` shortcut.
4. Lease acquisition filter includes owner/expiry/status.
5. Renewal requires the same owner and a live lease.
6. Backoff is bounded and jittered.
7. Unknown commit is never automatically retried.
8. Manual classes cannot be auto-resolved.
9. Audit fields include evidence, filters, before/after, approver, verifier.
10. Worker authorization is server-only; no Staff-session fallback.
11. No blind `$inc`/`$set` on stock or payment.
12. R1/R3/R5/R6/R7/R8 map to `MANUAL_REQUIRED`.

### 15.2 Real replica-set (disposable only)

1. Two workers race one task; one wins.
2. Lease expiry allows exactly one reclaim.
3. A crash after a committed deduction is recovered without a duplicate.
4. Unknown commit is resolved from evidence.
5. Transient failure retries within budget and commits once.
6. R2 consumption is idempotent on repeat.
7. R4 finalization does not change stock.
8. Hold-drift correction is conditional and audited.
9. Manual escalation creates no stock/payment mutation.
10. The worker cannot execute R5/R6/R7/R8 automatically.

Tests must use a disposable replica set and an isolated database; never the application database or production.

---

## 16. Operational and migration impact

### 16.1 Operational

- A scheduler or operator-invoked command is required.
- A worker identity/credential must be provisioned.
- An alert sink and on-call recipient must be named.
- Manual review capacity must be assigned.
- A kill switch and a runbook must exist.
- Recovery concurrency must be bounded to avoid load spikes.

### 16.2 Data migration

- Additive collection + indexes only, when approved.
- No change to existing orders, reservations, inventory items, or movements.
- Existing divergence must be detected and classified before enabling writes.
- Closed tasks are retained as audit; no deletion.
- If a V2 collection is chosen later, it must follow the V2 index plan and ownership model; V2 is not activated here.

### 16.3 Compatibility

- V1 remains authoritative.
- V2 stays unwired.
- TRACKED/UNTRACKED/EXTERNAL behaviour is unchanged: recovery only completes existing evidence, never invents a hold/deduction for an untracked/external line.
- Station/KDS states are untouched.
- Payment is never reversed by recovery.

---

## 17. Owner decisions required

1. Approve **B + D** as the near-term model; approve **C** as the strategic target.
2. Approve the recovery-task collection, fields, open-task uniqueness, and indexes.
3. Approve lease duration, renewal, expiry, and concurrency limits.
4. Approve retry/backoff values and the `maxAttempts` escalation threshold.
5. Approve the unknown-commit rule (never blind retry; evidence first).
6. Approve the manual classes and the approver/executor/verifier matrix.
7. Approve the alert sink, severity routing, and on-call owner.
8. Approve audit retention and access control.
9. Approve the worker identity model and kill switch.
10. Approve the read-only reconciliation report as the first deliverable.

**Until these are approved, no recovery worker may be implemented, and recovery remains a manual, evidence-driven operator procedure.**

---

## 18. Production-blocking statement

**Recovery readiness is production-blocking.** The current system can create a paid order without a deduction, and it has no durable owner to detect or repair it. A read-only reconciliation report is the minimum immediate control. An automated worker is not safe without an approved lease, authorization, audit, and escalation model.

**No recovery collection, worker, index, route, or migration was created in this phase.**
