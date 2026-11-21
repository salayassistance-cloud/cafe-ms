# Phase 2.5 — Work-Package Matrix

Status: **READ-ONLY PLANNING — NOT IMPLEMENTED, NOT AUTHORIZED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Basis: `phase-2-5-implementation-blueprint.md`; Phase 2.4 decisions A–E
Purpose: dependency graph, wave sequencing, change-class split, risk, and release gates

> This matrix is planning only. It does not authorize code, schema, index, migration, database, deployment, or production work. The owner must approve the blueprint before any work package starts.

---

## 1. How to read this matrix

- **WP** — work package ID from the implementation blueprint.
- **Class** — C0 read-only, C1 code-only, C2 additive schema, C3 index create/drop, C4 data migration, C5 production operation.
- **Wave** — the earliest safe implementation wave. A later wave is not authorization.
- **Depends on** — hard prerequisites. A missing dependency blocks the WP.
- **Gate** — the release gate that must pass before the WP can ship.
- **Risk** — residual risk if the WP is skipped or implemented incorrectly.

**Rules:**

1. A deployment contains one change class. C2 schema lands before dependent C1 code; C3 index work lands in its own window; C5 operations are separate tickets.
2. No WP may enable Inventory V2, add `orderVersion`/`inventoryMode`, change Hotel, or alter POS UI.
3. No WP may use `syncIndexes()`, drop an index outside WP-12, run a migration, or access production during Phase 2.5.
4. A failed gate stops the wave. It is not waived by a later wave.

---

## 2. Master matrix

| WP | Title | Decision | Class | Wave | Depends on | Primary gate | Residual risk if skipped |
|---|---|---|---|---|---|---|---|
| WP-01 | Freeze payment identity after first `PAID` | B-1 | C1 | 0 | none | G-PAY-1 | Historical method can be overwritten by retry; financial metadata is unreliable |
| WP-02 | Append-only payment adjustment ledger | B-2…B-6 | C2 + C1 | 3 | WP-07; finance gate | G-PAY-2 | No first-class refund/chargeback evidence; original payment may be edited to fake a refund |
| WP-03 | Read-only payment reconciliation | B-8 | C1 | 1 | WP-01; WP-02 optional | G-PAY-3 | Payment/account anomalies go undetected |
| WP-04 | Read-only inventory reconciliation | A, D | C1 | 0 | none | G-REC-1 | PAID-without-deduction, duplicates, drift, negative stock are invisible |
| WP-05 | Recovery job schema and indexes | A-2 | C2 | 1 | none | G-REC-2 | No durable task identity; concurrent repair can act twice |
| WP-06 | Recovery lifecycle service and worker | A-3/A-4; E-2/E-3 | C1 + C5 | 2 | WP-05, WP-07, WP-11 | G-REC-3 | Detection without safe ownership; manual repair remains ad hoc |
| WP-07 | Durable POS audit foundation | A, C, E | C2 + C1 | 1 | none | G-AUD-1 | Destructive/recovery actions have only transient logs |
| WP-08 | Destructive-admin production gate | C-1 | C1 + C5 | 2 | WP-05, WP-07, WP-17 | G-DEST-1 | Production reset remains reachable; financial evidence can be lost |
| WP-09 | Retire `clean-order-history.js` | C-2 | C1 | 1 | WP-08 policy | G-DEST-2 | One command can delete all orders, including PAID |
| WP-10 | Payment-account archive and step-up | C-5 | C1 | 2 | WP-07 | G-PAY-4 | Unused account can be hard-deleted without step-up/audit; reference check can fall through |
| WP-11 | V1 index coverage | D-4 | C1 + C3 | 2 | WP-05, WP-07 | G-IDX-1 | Unique reservation/movement guarantees are undeployed; duplicates possible |
| WP-12 | Replace obsolete `StockMovement` index | D-6 | C3 + C5 | 3 | WP-11, WP-13 | G-IDX-2 | Old unique `(order, reason)` rejects valid multi-ingredient orders; or duplicates remain unprotected |
| WP-13 | Database readiness verification tooling | D-1/D-2/D-4 | C1 + C5 | 1 | none | G-DB-1 | Topology/concerns/indexes cannot be evidenced |
| WP-14 | Transaction concerns, budget, pool | D-2/D-3 | C1 | 3 | WP-13; D-2/D-3 sign-off | G-DB-2 | Implicit durability; transactions can outlive the request; unknown commits ambiguous |
| WP-15 | Backup/restore, RPO, RTO | D-5 | C5 | 4 | WP-13, WP-14 | G-DB-3 | No proven restore; RPO/RTO undefined; destructive recovery impossible |
| WP-16 | Failover, pool, alerting staging proof | D-6 | C5 | 4 | WP-14, WP-15 | G-DB-4 | Failover/pool behaviour unproven; alerts not routed |
| WP-17 | RACI, dual control, independent verification | E | C0 | 1 | WP-06, WP-08, WP-10 | G-GOV-1 | No named owner/verifier; recovery and destructive ops are unsafe |
| WP-18 | Transactional/V2-aware destructive reset | C-1 future | C1 + C2 + C5 | 5 | WP-05, WP-07, WP-08, WP-17, separate V2 approval | G-DEST-3 | Deferred; production stays disabled, so the risk is contained |

---

## 3. Dependency graph

```text
Wave 0 — immediate, read-only / code-only
  WP-01 Payment identity freeze
  WP-04 Inventory reconciliation (read-only)
  WP-13 DB readiness verification tooling (read-only)

Wave 1 — foundations
  WP-03 Payment reconciliation (read-only; WP-02 optional)
  WP-05 Recovery job schema
  WP-07 Durable POS audit
  WP-09 Retire unsafe script
  WP-17 RACI (starts; signed before destructive work)

Wave 2 — dependent code and destructive controls
  WP-06 Recovery lifecycle/worker  <-- WP-05, WP-07, WP-11
  WP-08 Destructive-admin gate     <-- WP-05, WP-07, WP-17
  WP-10 Payment-account archive    <-- WP-07
  WP-11 V1 index coverage          <-- WP-05, WP-07

Wave 3 — index and transaction hardening
  WP-12 StockMovement index replacement <-- WP-11, WP-13
  WP-14 Transaction concerns/budget     <-- WP-13, D-2/D-3 sign-off
  WP-02 Payment adjustment ledger       <-- WP-07, finance gate

Wave 4 — operational proof
  WP-15 Backup/restore/RPO/RTO <-- WP-13, WP-14
  WP-16 Failover/pool/alerting <-- WP-14, WP-15

Wave 5 — deferred
  WP-18 Transactional/V2-aware reset <-- all above + separate V2 approval
```

### 3.1 Hard edges

| From | To | Why |
|---|---|---|
| WP-01 | WP-03 | Payment reconciliation assumes the identity freeze; otherwise its findings are unstable. |
| WP-05 | WP-06 | The worker cannot lease or converge tasks without the task collection/index. |
| WP-07 | WP-06 | Every recovery action needs an append-only audit record. |
| WP-07 | WP-08 | Destructive actions must write an intent/result audit before/after mutation. |
| WP-07 | WP-10 | Payment-account deletion/archive needs durable audit. |
| WP-05 | WP-08 | The destructive gate must refuse while an open recovery task exists. |
| WP-11 | WP-06 | Recovery task/inventory indexes must exist before worker scale-up. |
| WP-11 | WP-12 | The new `StockMovement` index must exist before the old index is dropped. |
| WP-13 | WP-12 | Index inventory and duplicate preflight evidence must exist first. |
| WP-13 | WP-14 | Topology/concern evidence precedes explicit values. |
| WP-14 | WP-15 | Restore must use the approved topology/concerns. |
| WP-15 | WP-16 | Failover proof includes restore/backup alerting. |
| WP-17 | WP-08 | A named approver/verifier is required for destructive production policy. |
| WP-17 | WP-06 | A named owner/verifier is required for manual escalation. |

### 3.2 Parallelizable work

- WP-01, WP-04, and WP-13 can start in parallel; they are independent and read-only/code-only.
- WP-03 can start after WP-01 and run alongside WP-05/WP-07.
- WP-09 can proceed after the WP-08 policy is signed; it does not need schema.
- WP-11 index preparation can proceed alongside WP-06 service work, but deployment waits for the C3 window.
- WP-17 starts early and is signed before WP-08 production policy is exercised.

---

## 4. Change-class deployment split

| Class | Work packages | Deploy unit | Approval | Verification |
|---|---|---|---|---|
| **C0** | WP-17; planning documents | None | Owner review | Signed matrix |
| **C1** | WP-01, WP-03, WP-04, WP-09, WP-10, part of WP-06/WP-08/WP-11/WP-13/WP-14 | One application deploy | Owner/technical lead | DB-free suite + targeted integration |
| **C2** | WP-02, WP-05, WP-07 | Schema deploy before dependent code | Owner + DBA | Model/schema tests + disposable DB |
| **C3** | WP-11 index creation, WP-12 replacement | Separate index window | Owner + DBA + approval reference | Before/after `getIndexes()`; duplicate preflight |
| **C4** | None authorized | Separate migration only | Owner + DBA + finance if financial | Migration report + reconciliation |
| **C5** | WP-06 scheduling, WP-08 production gate, WP-12 drop, WP-13 production read, WP-15, WP-16, WP-18 | Separate change ticket/maintenance window | Owner + operations/DBA + verifier | Operational evidence package |

### 4.1 Deployment order

1. **C1-only safety fixes:** WP-01, WP-09, WP-10 (WP-10 may wait for WP-07 audit).
2. **C2 schema:** WP-05 and WP-07; then WP-02 only after finance approval.
3. **C3 indexes:** WP-11 additive coverage; verify; WP-12 replacement.
4. **C1 dependent services:** WP-06 worker, WP-08 gate, WP-03 reports.
5. **C5 operations:** WP-15 restore drill, WP-16 failover/alerting, WP-13 production read-only evidence.
6. **WP-18** remains deferred.

A C2 deploy never carries C1 code that assumes the collection exists unless the collection has been verified. A C3 deploy never carries C1 code. A C5 operation never runs as part of an application release.

---

## 5. Wave plans and exit criteria

### Wave 0 — Immediate safety and visibility

| WP | Exit criteria |
|---|---|
| WP-01 | DB-free tests pass; disposable concurrency tests pass; staging manual cash/transfer retry proof; no UI change. |
| WP-04 | Read-only report classifies R1–R8 on a disposable DB; no write calls; staging sample matches manual queries. |
| WP-13 | Read-only tool reports topology/concerns/indexes without printing the URI; disposable proof. |

**Wave gate G-W0:** No production change; reports are read-only; WP-01 code review signed.

### Wave 1 — Foundations

| WP | Exit criteria |
|---|---|
| WP-03 | Read-only payment report; fixture tests; disposable proof. |
| WP-05 | Schema/index tests; disposable unique-open-task proof; owner signs fields/retention. |
| WP-07 | Append-only audit service; redaction tests; disposable insert/query proof. |
| WP-09 | Script removed or permanently fail-closed; source test; repository search clean. |
| WP-17 | RACI drafted; names pending owner. |

**Wave gate G-W1:** C2 schema reviewed; no production deploy; audit/retention and task schema signed.

### Wave 2 — Dependent code and destructive controls

| WP | Exit criteria |
|---|---|
| WP-06 | Lease/retry/unknown-commit tests; worker only R2/R4; kill switch; staging `--once` proof. |
| WP-08 | Production hard-deny; non-prod refusals; dual-control fields; audit; disposable proof. |
| WP-10 | Referenced archive; unused step-up; fail-closed reference check; audit; disposable proof. |
| WP-11 | Coverage tests; duplicate preflight; staging additive index deploy; before/after dump. |

**Wave gate G-W2:** Production destructive path still disabled; audit rows exist; index coverage verified; worker cannot approve.

### Wave 3 — Index and transaction hardening

| WP | Exit criteria |
|---|---|
| WP-12 | Duplicate preflight clean; new index verified; old index dropped only with second token; multi-item deduction proof. |
| WP-14 | D-2/D-3 values signed; explicit concerns; budget; retry/unknown-commit tests; disposable proof. |
| WP-02 | Finance gate signed; schema/service/index tests; no UI/provider. |

**Wave gate G-W3:** Index replacement evidence; topology/concerns evidence; finance gate either signed or explicitly out of scope.

### Wave 4 — Operational proof

| WP | Exit criteria |
|---|---|
| WP-15 | Isolated restore within signed RPO/RTO; counters/indexes/evidence/reconciliation verified; independent verifier signs. |
| WP-16 | Staging failover/pool/alert proof; no duplicate; no silent success; alert routing confirmed. |

**Wave gate G-W4:** Restore/failover evidence package; RPO/RTO signed; on-call named.

### Wave 5 — Deferred

| WP | Exit criteria |
|---|---|
| WP-18 | Only after separate V2 activation approval, transactional/lock design, staging proof, owner sign-off. Not in Phase 2.5. |

---

## 6. Risk register

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| Payment method overwritten by retry | High today | High | WP-01 atomic freeze; concurrency tests | Technical lead |
| Legacy `PAID` row has unknown method | Medium | Medium | Report in WP-03; no invented backfill | Finance/owner |
| Duplicate reservation/movement due to missing indexes | Medium | High | WP-11 coverage; WP-12 replacement; duplicate preflight | DBA |
| Old `StockMovement` index rejects multi-item orders | Medium | High | WP-12 create-then-drop; staging proof | DBA |
| Recovery worker repairs the wrong class | Low with controls | Critical | Only R2/R4 automatic; evidence; manual escalation; audit | Manager/finance |
| Duplicate recovery task | Medium | High | Unique open-task index; lease; convergence | Technical lead |
| Lease split-brain | Low | High | Atomic lease acquisition/renewal; evidence re-read | Technical lead |
| Unknown commit double deduction | Low | Critical | No blind retry; evidence resolution; unique movement identity | Technical lead |
| Destructive reset deletes evidence | High if enabled | Critical | Production hard-deny; WP-09 retirement; WP-18 deferred | Owner/operations |
| Audit write failure loses accountability | Medium | High | Abort destructive action; durable collection; verifier | Operations |
| Payment account hard-deleted while referenced | Medium | High | Fail-closed reference check; archive-only; step-up | Manager |
| Implicit write concern loses acknowledged data | Medium | High | WP-14 explicit majority; WP-15 restore drill | DBA |
| Failover duplicates a transaction | Low | Critical | WP-16 staging drill; unknown-commit rule | DBA |
| Pool exhaustion under serverless fan-out | Medium | High | WP-14 pool review; WP-16 saturation test | DBA/operations |
| No restore evidence | High today | Critical | WP-15 drill; RPO/RTO sign-off | Owner/DBA |
| Alert sink missing | High today | High | WP-16 routing; named on-call | Operations |
| Refund/chargeback accounting invented | Low with gate | Critical | WP-02 blocked until finance; no revenue recognition | Finance |
| V2 accidentally activated | Low | Critical | Explicit exclusion; no V2 files/collections; guard | Technical lead |
| POS UI regression | Low | Medium | No UI changes; API error contract tested | Technical lead |
| Hotel coupling | Low | High | Separate database/models; explicit exclusion | Technical lead |

---

## 7. Gate mapping

| Phase 2.5 gate | Meaning | Blocks |
|---|---|---|
| **G-PAY-1** | Payment identity freeze proven | Production payment release |
| **G-PAY-2** | Finance-approved adjustment ledger (or explicit out-of-scope policy) | Refund/chargeback enablement |
| **G-PAY-3** | Read-only payment reconciliation available | Financial operations sign-off |
| **G-PAY-4** | Payment account archive/step-up/audit proven | Production account deletion |
| **G-REC-1** | Read-only inventory reconciliation available | Recovery operations |
| **G-REC-2** | Recovery schema/index approved and deployed | Worker implementation |
| **G-REC-3** | Worker lease/retry/audit/escalation proven | Automated recovery |
| **G-AUD-1** | Append-only audit available and tested | Destructive/recovery actions |
| **G-DEST-1** | Production destructive path hard-denied | Any production reset |
| **G-DEST-2** | Unsafe script retired | Repository safety sign-off |
| **G-DEST-3** | Transactional/V2-aware reset approved | Future production reset (not Phase 2.5) |
| **G-IDX-1** | V1 index coverage deployed/verified | Inventory idempotency claim |
| **G-IDX-2** | Obsolete `StockMovement` index safely replaced | Multi-item sale correctness |
| **G-DB-1** | Topology/concerns/index inventory evidenced | Database release gate |
| **G-DB-2** | Explicit transaction budget/concerns/pool signed | Transaction release gate |
| **G-DB-3** | Restore drill within RPO/RTO | Production release |
| **G-DB-4** | Failover/pool/alert proof | Production release |
| **G-GOV-1** | RACI/approver/executor/verifier signed | All recovery/destructive operations |

### 7.1 Mapping to Phase 2.4 pre-production gates

| Phase 2.4 gate | Phase 2.5 work |
|---|---|
| G1 topology | WP-13, WP-16 |
| G2 transaction proof | WP-14, WP-16 |
| G3 standalone 503 | Existing Phase 2.3 proof; WP-14 regression |
| G4 write concern | WP-14 |
| G5 read concern/preference | WP-14 |
| G6 transaction budget | WP-14 |
| G7 pool/concurrency | WP-14, WP-16 |
| G8 failover drill | WP-16 |
| G9 index inventory | WP-13 |
| G10 missing inventory indexes | WP-11 |
| G11 old `StockMovement` index | WP-12 |
| G12 duplicate preflight | WP-11, WP-12, WP-13 |
| G13 V2 index plan | Out of scope; no V2 deployment |
| G14 Hotel index deployment | Out of scope; Hotel unchanged |
| G15 backup/encryption/retention | WP-15 |
| G16 PITR | WP-15 |
| G17 restore drill | WP-15 |
| G18 post-restore reconciliation | WP-15 + WP-03/WP-04 |
| G19 monitoring/on-call | WP-16 |
| G20 recovery ownership | WP-17 |
| G21 destructive policy | WP-08, WP-09, WP-17 |
| G22 payment immutability/refund decision | WP-01, WP-02 |

---

## 8. What can ship first, and what cannot

### 8.1 Safe first release (no schema, no production operation)

- WP-01 payment identity freeze.
- WP-04 read-only inventory reconciliation.
- WP-13 read-only database verification tooling.
- WP-09 script retirement after policy sign-off.

These do not require a new collection, index, migration, or production write. They reduce the highest-risk financial/inventory gaps without activating recovery or destructive features.

### 8.2 Requires a schema/index window

- WP-05 and WP-07 (C2).
- WP-11 (C3 additive).
- WP-12 (C3 create/drop; maintenance window).
- WP-02 (C2; finance-gated).

### 8.3 Requires production operations approval

- WP-15 backup/restore drill.
- WP-16 failover/pool/alerting staging proof.
- WP-13 production read-only evidence.
- WP-08/WP-18 destructive production path (WP-18 deferred; production remains denied).

### 8.4 Cannot ship in Phase 2.5

- Any V2 activation, V2 index deployment, or `orderVersion`/`inventoryMode`.
- Any monetary refund/chargeback code before finance approval.
- Any production destructive reset.
- Any data migration or backfill.
- Any Hotel, Room Service, Waiter, Kitchen, Barista, Jebena Buna, POS UI, or unrelated API change.

---

## 9. Approval and stop conditions

The owner must sign the implementation blueprint and this matrix before any work package starts. The following stop conditions apply:

1. A required dependency is missing or unverified.
2. A C2/C3/C4/C5 change would be bundled with a C1 deploy.
3. A test or staging proof fails.
4. A production database, secret, or destructive operation would be accessed.
5. A work package would activate V2 or alter Hotel/POS UI.
6. A recovery action would perform a blind stock/payment adjustment.
7. Finance has not approved the adjustment accounting boundary.
8. The RACI has no named approver/verifier.

On a stop condition, work returns to the owner; it does not proceed on an assumption.

**This matrix is a proposal. No work package has started.**
