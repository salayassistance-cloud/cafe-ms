# WP-04 — Implementation Work Packages

Status: **PLANNING ONLY — NO PACKAGE AUTHORIZED — NOT IMPLEMENTED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Companions: `wp-04-implementation-blueprint.md`, `wp-04-implementation-acceptance-matrix.md`, `wp-04-gate-dependency-map.md`, `wp-04-owner-decision-proposal.md`

> WD-01 through WD-14 are approved at policy level (2026-11-08). **No work package below is authorized.** Each package requires a separate authorization before any file, collection, index, worker, or operational change. No gate is signed. No database, staging, `.env`, secret, or credential was accessed. No stock, payment, accounting, or reservation record was mutated. Inventory V2 remains inactive.

---

## 0. Package rules

1. A package is independently reviewable and reversible.
2. A C1 package never bundles C2/C3/C4/C5 work.
3. A package stops at the first unapproved dependency, missing evidence, or unsigned gate.
4. Tests are additive; no existing test is weakened or deleted.
5. No package may import a write-capable application service into the detection plane.
6. No package may add a model to `lib/mongodb.js` auto-index provisioning.
7. A failing test blocks the package; a later pass does not waive the failure.
8. Every package records a baseline and final `git status` fingerprint.
9. No package deletes data to "fix" a failure.
10. The package ID set (WP04-00…WP04-12) is shared with the blueprint and acceptance matrix.

### 0.1 Authorization classes

| Class | Meaning | Who authorizes |
|---|---|---|
| **AUTH-0** | Documentation/authorization only | Owner |
| **AUTH-1** | Additive C1 source + DB-free tests | Owner/CAB after WP04-00 |
| **AUTH-2** | Disposable replica-set database work | Owner + DBA |
| **AUTH-3** | Read-only index/topology evidence | Owner + DBA |
| **AUTH-4** | C2 schema/index deployment | Owner + DBA + change window |
| **AUTH-5** | Staging/production operational run | Owner + operations + C5 ticket |

### 0.2 Dependency order

```text
WP04-00 (authorization)
   |
   v
WP04-01 -> WP04-02 -> WP04-03 -> WP04-04
                                |
                                v
                            WP04-05 (C2 disposable)
                                |
                                v
                            WP04-06 (C5 staging)  -> G-REC-1

WP04-12 (G-IDX-1, read-only) ---> WP04-07 (G-REC-2) ---> WP04-09
WP04-08 (G-AUD-1) ----------------> WP04-09 / WP04-10
WP04-11 (G-GOV-1) ----------------> WP04-09 / WP04-10
                                        |
                                        v
                                    WP04-10 (G-REC-3, C5)
```

---

## 1. WP04-00 — Implementation authorization and baseline lock

| Field | Detail |
|---|---|
| Class | C0 — AUTH-0 |
| Scope | Record the separate implementation authorization, re-verify the repository baseline, confirm the deferred list, and name the package reviewer. No code. |
| Files likely affected | A decision/authorization record under `docs/production-readiness/` only. |
| Prerequisites | This blueprint, the owner decision record, the gate map. |
| DB-free tests | Verify `git branch`, HEAD, full status count, and SHA-256 fingerprint match the recorded baseline. |
| Disposable replica-set tests | None. |
| Security / authorization tests | Confirm no `.env`, secret, credential, or production path is referenced; confirm the authorization names a reviewer and the C1 scope. |
| Failure / concurrency tests | None; this is a gate, not code. |
| Acceptance criteria | Authorization record exists; baseline fingerprint matches; reviewer named; scope limited to the approved read-only slice; all deferred items restated. |
| Rollback | Revoke the authorization in writing; no artifact depends on it. |
| Stop conditions | Baseline drift; missing authorization; package scope mixes C1 with C2+; reviewer has a conflict with verification. |

---

## 2. WP04-01 — Rule registry, evidence projection, fingerprint

| Field | Detail |
|---|---|
| Class | C1 — AUTH-1 |
| Scope | Stable D01–D10 metadata; bounded evidence projection; canonical JSON and SHA-256 fingerprint. Pure modules, no database. |
| Files likely affected | `lib/recovery/rules/registry.js`, `lib/recovery/evidence.js`, `lib/recovery/fingerprint.js` (candidate paths). No existing file is modified. |
| Prerequisites | WP04-00 authorization; the detection rule matrix; the evidence model in the design document §6. |
| DB-free tests | Registry contains exactly D01–D10; every sub-code is registered; severity/confidence enums; evidence projection whitelist; sensitive-key exclusion; fingerprint determinism across key order; numeric canonicalization (`100` vs `100.0`); changed quantity changes hash; account number never enters the hash; no V2 field accepted. |
| Disposable replica-set tests | None; the layer is pure and must not open a connection. |
| Security / authorization tests | No `process.env` file read; no dynamic import; no `eval`; no write method imported; no secret-bearing field in the projection. |
| Failure / concurrency tests | Deterministic output under reordered object keys; bounded arrays/strings; malformed input returns a typed error rather than throwing an unredacted dump. |
| Acceptance criteria | 100% D01–D10 metadata; all fingerprint tests pass; no write-capable import in the graph; lint clean; no existing test regression. |
| Rollback | Delete the additive modules; no data or schema impact. |
| Stop conditions | A rule needs an unapproved numeric threshold to be representable; an authoritative field is missing or conflicting in source; the projection cannot exclude a secret. |

---

## 3. WP04-02 — Pure classifier D01–D10

| Field | Detail |
|---|---|
| Class | C1 — AUTH-1 |
| Scope | Apply the ten rules to a bounded evidence snapshot; emit findings with severity, confidence, evidence level, dedupe key, and review routing. |
| Files likely affected | `lib/recovery/classify.js` plus optional `lib/recovery/rules/d01.js`…`d10.js` (candidate). |
| Prerequisites | WP04-01; the fixtures from WP04-04 may be developed in parallel but must pass before acceptance. |
| DB-free tests | C-01…C-40 from the test plan; one positive and one negative per rule; D02/D09 route to manual; shortage produces no correction; D06 produces no task; line-level gaps stay Medium; dedupe across overlapping rules. |
| Disposable replica-set tests | None. |
| Security / authorization tests | No database import; no write service import; no payment mutation; no `autoRecovery` value other than `PROHIBITED`. |
| Failure / concurrency tests | Malformed snapshot → D10, not a crash; missing order/reservation → E0/E1 + manual; contradictory evidence → D10; deterministic repeat classification. |
| Acceptance criteria | All rule fixtures pass; output schema valid; no automatic action path; every finding carries confidence, severity, evidence level, and recommended review. |
| Rollback | Delete the additive classifier/rules. |
| Stop conditions | A rule needs an accounting decision; a false positive cannot be suppressed without an unapproved policy; a rule would need a stock write. |

---

## 4. WP04-03 — Read-only scanner, guard, CLI, output contract

| Field | Detail |
|---|---|
| Class | C1 — AUTH-1 |
| Scope | Bounded read-only orchestration from primary; structural write ban; CLI flags; deterministic redacted output; exit codes. |
| Files likely affected | `lib/recovery/reconciliation.js`, `lib/recovery/readOnlyGuard.js`, `scripts/reconcile-inventory.mjs` (candidate). |
| Prerequisites | WP04-02; connection access only at run time, never in tests. |
| DB-free tests | SC-01…SC-10 source-contract tests; flag parser rejects `--apply`/`--fix`/`--repair`/`--force`/`--execute` and unknown flags; exit 0/2/1; redaction; `readOnly: true`; deterministic finding order; no `.env` read. |
| Disposable replica-set tests | Bounded scan of seeded classes; document counts and deterministic hash unchanged before/after; no new collection/index; index-present and index-absent cases; no `inventory_v2_*` collection. |
| Security / authorization tests | Read-only credential/session; no HTTP route; no client-supplied actor identity; output masks account numbers; no full document dump. |
| Failure / concurrency tests | Read timeout exits non-zero with no partial report presented as complete; topology unavailable exits cleanly; a concurrent V1 write produces a re-read/drift signal, never a repair. |
| Acceptance criteria | Scanner is structurally read-only; all seeded classes classify; before/after hash identical; no V2 read/write; CLI refusals proven. |
| Rollback | Remove the CLI and modules; no data cleanup needed. |
| Stop conditions | Scanner requires a write or index; output cannot be redacted; a read requires production access. |

---

## 5. WP04-04 — DB-free fixtures and test suite

| Field | Detail |
|---|---|
| Class | C1 — AUTH-1 |
| Scope | Additive unit/fixture/contract tests for WP04-01…WP04-03, including the C-01…C-40 and FP-01…FP-08 cases. |
| Files likely affected | `tests/wp04-reconciliation.test.mjs`, `tests/wp04-contract.test.mjs` (candidate; the earlier plan names `tests/phase25-recovery-reconciliation.test.mjs`). |
| Prerequisites | WP04-01…WP04-03 interfaces stable enough to test. |
| DB-free tests | The suite itself; baseline full suite must be re-run with 0 failures and 0 skipped. |
| Disposable replica-set tests | None in this package. |
| Security / authorization tests | Assert no test opens a database, reads `.env`, or requires a credential; assert no fixture contains a real account number or PIN. |
| Failure / concurrency tests | Fixture mutation does not leak between tests; deterministic reruns; a deliberately failing rule is caught. |
| Acceptance criteria | New tests pass; baseline suite passes; no skipped tests; no database connection attempted; coverage of every rule and fingerprint property. |
| Rollback | Remove the additive test files. |
| Stop conditions | Baseline regression; a test would require real data; a fixture cannot represent a class without inventing accounting semantics. |

---

## 6. WP04-05 — Disposable replica-set read-only proof

| Field | Detail |
|---|---|
| Class | C2 — AUTH-2 |
| Scope | Prove the scanner is read-only against a loopback-only, credential-free, disposable replica set; seed D01–D10 and index present/absent variants. |
| Files likely affected | `tests/integration/wp04-reconciliation.integration.mjs`; reuse `tests/helpers/pos-phase25-loader.mjs` and `pos-phase25-register.mjs`. |
| Prerequisites | WP04-03/04; explicit disposable-DB authorization; no `MONGODB_URI`/`ROOM_MONGODB_URI`; loopback only. |
| DB-free tests | Not applicable to this package; run WP04-04 first. |
| Disposable replica-set tests | IX-01…IX-05; seeded classes per rule; before/after counts and hash; no new collection/index; no V2; schema/index baseline captured. |
| Security / authorization tests | Harness refuses non-loopback hosts, credentials, production URI env vars, and a missing acknowledgement flag; drops only the phase-specific database it created. |
| Failure / concurrency tests | Scanner timeout; unavailable topology; duplicate fixtures; concurrent read-only scan; index absent; seeded partial write by a fixture is confined to the disposable DB. |
| Acceptance criteria | Every seeded class is detected; no mutation of the disposable data; index-present and index-absent behaviour proven; evidence package stored. |
| Rollback | Drop only the verified phase-specific database created by the run. |
| Stop conditions | Any non-disposable target; any write by the scanner; a required fixture cannot be created without an unapproved production write. |

**Current status (2026-11-14): AUTH-2 bounded proof AUTHORIZED 2026-11-11 and EXECUTED (19/19); the executed suite covers persistence/index/wire proof, not this §6 read-only scanner scope. The later WP04-05 L2 supplementary proof (disposable local authenticated replica set, D01–D10) was owner-accepted on 2026-11-14 — ACCEPTED — PASS — for that disposable scope only (see `wp-04-05-disposable-replica-set-proof-report.md` §11). This is NOT overall L2 acceptance and NOT a G-REC-1 signature; no further WP04-05 work is authorized.**

---

## 7. WP04-06 — Staging read-only pilot (G-REC-1 evidence)

| Field | Detail |
|---|---|
| Class | C5 — AUTH-5 |
| Scope | Run the read-only scanner against an approved isolated staging copy; complete M-01…M-12; assemble the G-REC-1 evidence package. |
| Files likely affected | None expected; a defect found here returns to WP04-03. |
| Prerequisites | WP04-05 bounded-proof execution (AUTH-2 granted 2026-11-11; executed 19/19) **plus** the accepted WP04-05 L2 supplementary proof (owner-accepted 2026-11-14, disposable scope only); approved isolated staging (G0-1/2/3/7/8/10); read-only credential; named inventory/finance reviewers; separate seeded-data authorization for M-02; approved staging counts/hash method; no G-PAY-1 bypass (environment approval only, not acceptance). |
| DB-free tests | Re-run WP04-04 as the baseline. |
| Disposable replica-set tests | Re-run WP04-05 as the pre-staging proof. |
| Security / authorization tests | Redaction sample; no secret in output; no write path; no production connection; credential scope confirmed read-only. |
| Failure / concurrency tests | Staging unavailable; sample mismatch against manual read-only queries; runtime exceeds the approved window; scanner exits non-zero on read error; a required D01–D10 seed class is absent; the counts/hash method is unapproved. |
| Acceptance criteria | Each D01–D10 represented; sample matches manual queries; counts/hashes unchanged; no new collection/index; output redacted; owner signs format/retention; G-REC-1 evidence package complete. |
| Rollback | Revoke the staging credential; no data change to roll back. |
| Stop conditions | No approved staging; any write; any secret exposure; an unexplained sample mismatch; G-PAY-1 remains blocked and is not waived. |

**Current status: BLOCKED — no approved isolated staging environment; the WP04-05 L2 supplementary proof is owner-accepted (2026-11-14) for its disposable scope only, which does not complete overall L2 or sign G-REC-1; the separate M-02 seeded-data authorization and the staging counts/hash method remain unapproved (RC-1, RC-4).**

**Ordering (RC-2, 2026-11-14).** Environment approval clears the shared G-PAY-1 environmental blocker only; it does not sign, accept, or waive G-PAY-1. L3 read-only G-REC-1 evidence does not depend on G-PAY-1 acceptance, and it does not clear G-PAY-1. See `wp-04-02-isolated-integration-test-plan.md` §6.

---

## 8. WP04-07 — Durable recovery schema and repository (G-REC-2)

| Field | Detail |
|---|---|
| Class | C2 — AUTH-4 |
| Scope | Durable recovery task model and repository using only the seven approved statuses; open-task convergence; no worker. |
| Files likely affected | `lib/models/InventoryRecoveryJob.js`, `lib/recovery/taskRepository.js` (candidate); schema tests. |
| Prerequisites | G-IDX-1 evidence; WD-02/WD-07; OD-10 schema contract approved 2026-11-14 (any item outside OD-10 remains deferred); separate owner authorization. |
| DB-free tests | Enum contains exactly seven statuses; no `AWAITING_APPROVAL`; required fields; `isOpen` semantics; no TTL; no V2 field/collection; model naming/collection name; terminal retention. |
| Disposable replica-set tests | Unique `taskId`; unique partial open task per order; concurrent detection converges; duplicate create is rejected and re-read; terminal history retained. |
| Security / authorization tests | Repository is server-only; no route/export to a client; no actor identity from a cookie; task fields cannot be set by an unauthenticated caller. |
| Failure / concurrency tests | Two scanners create one open task; duplicate-key retry re-reads; evidence drift re-classifies without overwriting an executing task. |
| Acceptance criteria | Schema approved; index dump; duplicate preflight; one-open-task proof; no TTL; no V2; G-REC-2 evidence package. |
| Rollback | Stop writes; do not drop the collection; existing tasks remain durable. |
| Stop conditions | Index absent or duplicate preflight fails; schema field unapproved; any new status proposed; any V2 field. |

---

## 9. WP04-08 — Append-only evidence history and audit adapter (G-AUD-1)

| Field | Detail |
|---|---|
| Class | C2 — AUTH-4 |
| Scope | Insert-only evidence events and audit linkage; fail-closed when audit is unavailable. |
| Files likely affected | `lib/models/InventoryRecoveryEvidence.js`, `lib/recovery/evidenceHistory.js`, a redacted audit adapter (candidate); WP-07 audit remains its own package. |
| Prerequisites | WD-07; WP-07 audit design; deferred retention/shape approval (D-06/D-11); separate owner authorization. |
| DB-free tests | Insert-only API surface; no update/delete export; required fields; redaction; reason enum; fingerprint linkage; no TTL. |
| Disposable replica-set tests | Insert/query by task/domain/order; unique event id; audit failure aborts; prior events immutable; closed task retains history. |
| Security / authorization tests | No delete/update route; no secret in evidence; verifier/approver fields immutable after write; no client write path. |
| Failure / concurrency tests | Duplicate event rejected; append during drift; audit outage blocks action; concurrent inserts retain order by timestamp/id. |
| Acceptance criteria | G-AUD-1 evidence package: append-only proof, redaction, query paths, fail-closed, retention decision. |
| Rollback | Stop appends; do not delete evidence; retain all history. |
| Stop conditions | Audit cannot be guaranteed; evidence would contain a secret; retention/shape unapproved. |

---

## 10. WP04-09 — Claim/lease service and retry interface (disabled)

| Field | Detail |
|---|---|
| Class | C1/C2 — AUTH-4 |
| Scope | Atomic claim/renew/finish, lease expiry/reclaim, retry classification and provisional backoff. No scheduler and no automatic execution. |
| Files likely affected | `lib/recovery/leaseService.js`, `lib/recovery/retryPolicy.js` (candidate). |
| Prerequisites | WP04-07; WD-08 provisional values; G-REC-2 progress; separate owner authorization. |
| DB-free tests | T1–T15 transitions; guard definitions; illegal transitions; attempts increment on lease; provisional backoff; distinctness; unknown-commit branch selection. |
| Disposable replica-set tests | Two-worker race → one winner; renewal with stale token fails; finish with stale token fails; expiry/reclaim; crash before/after action; unknown commit present/absent/contradictory; no duplicate effect. |
| Security / authorization tests | Worker identity mandatory; worker cannot approve/verify; no Staff session/cookie/PIN identity; stale token cannot write. |
| Failure / concurrency tests | Split-brain; lease loss; duplicate finish; evidence drift mid-action; audit failure; topology unavailable. |
| Acceptance criteria | G-REC-3 lease/retry subset passes; numeric values remain provisional; worker still disabled; no stock/payment write outside the approved primitive. |
| Rollback | Disable the interface; tasks remain durable; no data deletion. |
| Stop conditions | Any numeric value is treated as approved; a duplicate effect appears; a manual class becomes automatic. |

---

## 11. WP04-10 — Worker CLI and manual escalation interface (disabled)

| Field | Detail |
|---|---|
| Class | C5 — AUTH-5 |
| Scope | Operator-invoked worker CLI, disabled by default; escalation payload; authorization/audit boundary. R2/R4 only where the approved design allows; all other classes escalate. |
| Files likely affected | `scripts/recovery-worker.mjs`, `lib/recovery/escalation.js`, `lib/recovery/authorization.js` (candidate). |
| Prerequisites | G-REC-2, G-REC-3, G-AUD-1, G-GOV-1, G-DB-2/G-DB-4; separate C5 authorization. |
| DB-free tests | Kill switch absent/false by default; `--execute` required; worker id required; no public route; R2/R4 action map only; manual classes escalate; audit failure aborts; no V2. |
| Disposable replica-set tests | Staging `--once` run with measured duration; two-worker race; crash recovery; unknown commit; R2 idempotent consumption; R4 status-only finalize with no stock change. |
| Security / authorization tests | No HTTP route; no session-derived identity; approver/executor/verifier distinct; worker cannot approve or verify; no Manager PIN. |
| Failure / concurrency tests | Topology unavailable; lease loss; audit failure; evidence drift; kill switch mid-run; contradictory unknown commit. |
| Acceptance criteria | G-REC-3 evidence package complete; worker off by default; manual classes escalate; no stock arithmetic added. |
| Rollback | Disable the kill switch/process; retain durable tasks and audit; no deletion. |
| Stop conditions | Any gate unsigned; a manual class executes automatically; any automatic action outside R2/R4; any V2 activation. |

**Current status: BLOCKED — G-REC-2, G-REC-3, G-AUD-1, G-GOV-1 are unsigned.**

---

## 12. WP04-11 — RACI and operational interface (G-GOV-1)

| Field | Detail |
|---|---|
| Class | C0 — AUTH-0 |
| Scope | Approved RACI with named approver/executor/verifier and backups; escalation channel/SLA; retention policy; runbook. No code and no system permissions. |
| Files likely affected | A governance document/runbook under `docs/production-readiness/` only. |
| Prerequisites | WD-03; owner willingness to name people; separate owner/operations authorization. |
| DB-free tests | Tabletop review of every class; distinctness check; worker-cannot-approve review. |
| Disposable replica-set tests | None. |
| Security / authorization tests | Confirm placeholders are not treated as system roles; confirm no account/permission is created by the document. |
| Failure / concurrency tests | Absence/backup coverage; escalation timeout; on-call handover. |
| Acceptance criteria | G-GOV-1 evidence package: signed RACI, backups, distinctness, escalation channel/SLA, retention policy, named on-call. |
| Rollback | Withdraw the draft; no system effect. |
| Stop conditions | No named person for a required role; no backup; a person would be approver and verifier. |

---

## 13. WP04-12 — Index verification evidence (G-IDX-1)

| Field | Detail |
|---|---|
| Class | C3 — AUTH-3 |
| Scope | Read-only collection/index inventory for `inventoryreservations`, `stockmovements`, `inventoryitems`, `paymentinfos`, and `orders`; no index creation or deletion. |
| Files likely affected | Reuse WP-13 tooling or a read-only script under `scripts/` (candidate); no application model change. |
| Prerequisites | Separate DBA/owner authorization; approved read-only connection; WP-13/WP-11 coordination. |
| DB-free tests | Index-inventory parser; redaction of the connection string; expected-vs-observed comparison; `INDEX_ABSENT` reporting. |
| Disposable replica-set tests | Disposable index-present/absent fixtures to prove the report format. |
| Security / authorization tests | Read-only credential; never print the URI; no `createIndex`/`dropIndex`/`syncIndexes`. |
| Failure / concurrency tests | Permission denied; topology unavailable; partial index read. |
| Acceptance criteria | G-IDX-1 evidence: exact deployed index list per collection, presence/absence for the unique guarantees, no URI/secret in evidence. |
| Rollback | None; read-only. |
| Stop conditions | The tool would need an index write; production read without approval; secret exposure. |

---

## 14. Authorization matrix

| Package | Authorization required | Gate | Can start now? |
|---|---|---|---|
| WP04-00 | AUTH-0 owner | — | Yes, owner may authorize |
| WP04-01 | AUTH-1 | G-REC-1 | No — needs WP04-00 |
| WP04-02 | AUTH-1 | G-REC-1 | No — needs WP04-01 |
| WP04-03 | AUTH-1 | G-REC-1 | No — needs WP04-02 |
| WP04-04 | AUTH-1 | G-REC-1 | No — needs WP04-01..03 |
| WP04-05 | AUTH-2 | G-REC-1 | Bounded proof authorized 2026-11-11 and executed 19/19; L2 supplementary proof ACCEPTED — PASS 2026-11-14 (disposable scope; overall L2/G-REC-1 still open) |
| WP04-06 | AUTH-5 | G-REC-1 | No — staging blocked |
| WP04-07 | AUTH-4 | G-REC-2 | No — G-IDX-1 + schema approval |
| WP04-08 | AUTH-4 | G-AUD-1 | No — schema/retention approval |
| WP04-09 | AUTH-4 | G-REC-2, G-REC-3 | No — WP04-07 |
| WP04-10 | AUTH-5 | G-REC-3 | No — all recovery gates |
| WP04-11 | AUTH-0 | G-GOV-1 | No — names pending |
| WP04-12 | AUTH-3 | G-IDX-1 | No — DBA/owner authorization |

**Recommended first implementation package:** WP04-01, after WP04-00 records a separate read-only implementation authorization.

---

## 15. Cross-package evidence and rollback

| Evidence | Produced by | Consumed by |
|---|---|---|
| Baseline/final status fingerprint | every package | acceptance matrix |
| Rule registry completeness | WP04-01/04 | G-REC-1 |
| Fingerprint determinism | WP04-01/04 | G-REC-1, G-REC-2 |
| Classifier fixtures | WP04-02/04 | G-REC-1 |
| Source-contract read-only proof | WP04-03/04 | G-REC-1 |
| Disposable before/after hash | WP04-05 | G-REC-1 |
| Staging sample | WP04-06 | G-REC-1 |
| Schema/index dump | WP04-07/12 | G-REC-2 |
| Append-only/audit proof | WP04-08 | G-AUD-1 |
| Lease/retry/unknown-commit proof | WP04-09/10 | G-REC-3 |
| Signed RACI | WP04-11 | G-GOV-1 |
| Index inventory | WP04-12 | G-IDX-1 |

Rollback never deletes task, evidence, audit, movement, reservation, or order history. A wrong data write is an incident, not a scripted undo.

---

## 16. Closing statement

**No package is authorized for staging or runtime.** The owner approved policy and separately accepted the R-1 read-only source. AUTH-2 was granted for the bounded WP04-05 proof; L3 still requires its own authorization.

**WP-04 design is complete; the R-1 read-only source is accepted. G-REC-1 is unsigned. G-PAY-1 is blocked. Inventory V2 is inactive.**
This documentation correction contacted no database and created or changed no code, schema, collection, index, route, API, script, test, or runtime configuration. The R-1 source exists under its own accepted authorization.