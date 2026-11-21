# WP04-02 — Open Risks and Gates

Status: **OPEN REGISTER — NO GATE CHANGED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`

> This register records what still blocks integration. Nothing here is approved, waived, or closed by WP04-02. Gate states below are unchanged from WP04-01.

---

## 1. Risk register

Severity reflects the impact of acting **before** the risk is resolved.

| ID | Risk | Severity | Likelihood | Why it matters | Mitigation | Gate |
|---|---|---|---|---|---|---|
| **RK-01** | Read-only claim is only source-level until proven on a real server | High | Medium | A hidden write, transaction, or index call would violate the core safety property | L2 operation-profiling test with a disposable replica set; read-only DB user | G-DB-2, G-DB-4 |
| **RK-02** | Deployed unique index may not match schema | High | Medium | Duplicate detection and idempotency assumptions change; over- or under-reporting | Verify deployed indexes read-only; report `INDEX_ABSENT_SUSPECTED`; never create/repair | G-IDX-1 |
| **RK-03** | No approved `W_STALE` / live-hold threshold | High | High | D05/D06 cannot distinguish a long legitimate hold from an abandoned one | Owner supplies numeric threshold; until then D06 stays alert-only and no age-based release exists | G-REC-1 |
| **RK-04** | `PAID` + `RELEASED(CONSUMPTION_FAILED)` is a designed V1 outcome | High | High | The most visible D01 case is an expected failure mode, not proof of corruption | Report only; human compares physical stock; no auto-repair | G-REC-1 |
| **RK-05** | `CONSUMING` is a normal transient state | Medium | High | Scanning without an in-flight window produces false positives | Use an approved active-transaction window; alert-only | G-REC-1 |
| **RK-06** | Non-fatal inventory hooks can leave missing evidence | Medium | Medium | Reservation creation, payment consumption, and cancellation hooks swallow errors by design | Treat absence as evidence; never infer success | G-REC-1 |
| **RK-07** | Legacy orders have no reservation | Medium | Medium | Different lifecycle path; double-deduction protection exists in the service | Explicit `LEGACY_SHAPE` handling; no rewrite | G-REC-1 |
| **RK-08** | Line-level attribution is deferred | Medium | High | Item-level only; a shared ingredient cannot be assigned to one line | Report item-level; do not invent line allocation | Owner decision |
| **RK-09** | Shortage semantics are unresolved | Medium | High | A shortage may be normal, approved, or a defect | Report-only; no correction quantity | Owner decision |
| **RK-10** | V1 `Number` quantities vs V2 exact `BigInt` | Medium | Low | Mixing schemas could silently mis-handle precision | V1-only adapter; V2 requires a new evidence version | Owner decision |
| **RK-11** | Free-text evidence is withheld | Low | Medium | Some sub-codes cannot use reason text | Classifier must not require free text; report unimplementable sub-codes | Owner decision |
| **RK-12** | No approved alert sink, on-call, or SLA | Medium | High | A finding with no owner is noise | Alerting stays disabled until sink/on-call approved | G-GOV-1 |
| **RK-13** | Human review roles are placeholders | High | Medium | Separation of duties cannot be evidenced with invented names | Owner names approver/executor/verifier | G-GOV-1, G-AUD-1 |
| **RK-14** | Evidence retention period is undecided | Medium | Medium | Append-only history has no lifecycle | Owner sets retention; no TTL or delete path in design | G-AUD-1 |
| **RK-15** | Multi-collection reads are not one transaction | Medium | Medium | A scan can combine slightly different points in time | One logical per-order read; declared read concern; accept and document bounded skew | G-REC-1 |
| **RK-16** | Query cost on the deployed tier is unmeasured | Medium | Medium | Large scans can degrade production | Bounded window, per-order cap, limit; benchmark on disposable data | G-DB-2 |
| **RK-17** | Worker/lease numerics are undecided | Medium | Low (not started) | Future claims could duplicate or starve | No worker in this phase; lease design deferred | G-REC-2 |
| **RK-18** | No disposable replica set approved | High | High | L2 cannot run | Owner approves disposable environment | G-DB-2, G-DB-4 |
| **RK-19** | No approved staging sample | High | High | Realism cannot be validated | Owner approves isolated read-only sample | G-PAY-1, G-REC-1 |
| **RK-20** | Inventory V2 activation would invalidate the v1 evidence model | High | Low | V2 uses exact quantity objects the projection rejects | Keep V2 inactive; new schema version if activated | Owner decision |

---

## 2. Owner decisions still open

These are policy inputs, not implementation choices. None is invented here.

| ID | Decision needed | Affects |
|---|---|---|
| **OD-01** | Numeric `W_ACTIVE` transaction window | D05, D06, false positives |
| **OD-02** | Numeric `W_STALE` stale-hold / stale-CONSUMING threshold | D05, D06 |
| **OD-03** | Legacy cutoff date | D01, D02, D07, D10 |
| **OD-04** | Shortage accounting semantics | D01, D07, D10 |
| **OD-05** | Evidence and output retention period | Persistence design |
| **OD-06** | Alert sink, on-call rotation, SLA | Operational boundary |
| **OD-07** | Named approver, executor, independent verifier roles | Manual review boundary |
| **OD-08** | Production scan window and per-run limits | Adapter queries |
| **OD-09** | Exact recovery task/evidence collection names | Future persistence |
| **OD-10** | Index inventory and deployment approval | G-IDX-1 |
| **OD-11** | External-writer register (other systems writing stock) | D02, D03 |
| **OD-12** | R9/R10 adoption (currently prohibited) | Rule vocabulary |
| **OD-13** | D06 task creation (currently alert-only) | D06 |
| **OD-14** | Line-level attribution (currently deferred) | D07, D08 |
| **OD-15** | Disposable replica-set authorization | L2 testing |
| **OD-16** | Isolated staging sample authorization | L3 evidence |

---

## 3. Gate states — unchanged

| Gate | State | What would be required to change it |
|---|---|---|
| G-REC-1 | **UNSIGNED — NOT STARTED** | Full evidence package incl. disposable and staging proof; independent review |
| G-REC-2 | **UNSIGNED — NOT STARTED** | Persistence/lease/worker design and tests |
| G-REC-3 | **UNSIGNED — NOT STARTED** | Recovery execution and separation-of-duties proof |
| G-AUD-1 | **UNSIGNED — NOT STARTED** | Audit/evidence retention and access design |
| G-GOV-1 | **UNSIGNED — NOT STARTED** | Named owners, alerting policy, sign-off |
| G-IDX-1 | **UNSIGNED** | Read-only index inventory and approval |
| G-DB-1 | **UNSIGNED** | Database readiness package |
| G-DB-2 | **UNSIGNED** | Disposable environment proof |
| G-DB-4 | **UNSIGNED** | Replica-set / transaction behavior proof |
| G-PAY-1 | **BLOCKED** | Approved isolated staging environment |
| G-PAY-2 | **UNSIGNED** | Payment reconciliation acceptance |

**No gate was signed, passed, waived, or downgraded by WP04-02.** This is a documentation package; it supplies no gate evidence by itself.

---

## 4. Prerequisites before the first isolated integration implementation

Ordered, all requiring separate authorization:

1. Owner approves the adapter's query window and limits (OD-01, OD-08).
2. Owner approves stale thresholds (OD-02) or explicitly accepts alert-only D06.
3. Owner names review roles (OD-07) and the alert sink (OD-06).
4. Read-only index inventory is produced and approved (G-IDX-1, OD-10).
5. Disposable replica-set environment is approved (OD-15, G-DB-2/4).
6. The adapter is implemented with injected repositories and zero write imports.
7. L1 tests pass with a write trap proving no writes.
8. Only then may L2 run, and only then may G-REC-1 evidence begin to accumulate.

---

## 5. Conditions that must never be met by any future package

These are hard prohibitions carried forward from the approved policy:

- No automatic repair of stock, payment, accounting, reservation, or order records.
- No age-based inventory-hold release.
- No shortage correction quantity.
- No D06 recovery-task creation.
- No R9/R10 class.
- No D02/D09 durable task class.
- No line-level attribution invention.
- No `syncIndexes`, index drop, or index creation on a live database.
- No Inventory V2 activation.
- No gate self-signing.
- No scheduling, cron, queue, or worker activation without a separate package.

---

## 6. Residual-risk statement

Even with all gates eventually signed:

- The fingerprint proves byte-identical canonical evidence, **not** that the evidence is true.
- A clean scan does **not** prove the absence of corruption; it proves no rule fired within the scanned window.
- Physical stock truth requires human verification against a physical count.
- The reconciliation layer is a detector, not an authority.

---

## 7. Status statement

- WP04-02 is a **read-only review and documentation package**.
- No live integration was performed.
- No recovery functionality was wired into any route, service, worker, or scheduler.
- **WP04-03 and every later package remain unauthorized.**
- Stopping here pending separate owner authorization for the first isolated integration implementation package.
