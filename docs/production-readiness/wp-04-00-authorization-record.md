# WP-04 / WP04-00 — Authorization and Implementation Boundary Record

Status: **AUTHORIZATION RECORDED — DOCUMENTATION ONLY — WP04-01 NOT AUTHORIZED — NO CODE IMPLEMENTED**
Record date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Package: **WP04-00 — Implementation authorization and baseline lock** (C0 / AUTH-0)
Basis: `wp-04-implementation-blueprint.md`, `wp-04-implementation-work-packages.md`, `wp-04-implementation-acceptance-matrix.md`, `wp-04-owner-decision-proposal.md` (§16), `wp-04-gate-dependency-map.md`
Scope of this artifact: **authorization boundary record only**

> This record documents a documentation-only authorization. It does **not** authorize WP04-01 or any later package. No application source, schema, model, collection, index, route, API, script, test, migration, seed, environment variable, or runtime configuration was created or changed. No database, staging, production, `.env`, `.env.local`, secret, or credential was accessed. No stock, payment, accounting, reservation, or order record was mutated. Inventory V2 remains inactive. **No gate is signed, passed, or waived.** G-REC-1, G-REC-2, G-REC-3, G-AUD-1, G-GOV-1, G-IDX-1, G-DB-1, G-DB-2, G-DB-4, and G-PAY-2 remain **UNSIGNED**. G-PAY-1 remains **BLOCKED**.

---

## 0. Purpose of this record

WP04-00 exists to close the gap between *policy approval* and *implementation authorization*. The owner approved WD-01 through WD-14 on 2026-11-08, but that approval is design/policy only. This record:

1. restates the approval already granted;
2. records the separate, limited authorization to perform **WP04-00 itself**;
3. states unambiguously that **WP04-01 is not authorized**;
4. lists every prohibited action;
5. preserves all existing gate states exactly;
6. defines what a future WP04-01 authorization must contain.

This record is not a gate signature, not an implementation ticket, and not a substitute for the acceptance evidence defined in `wp-04-implementation-acceptance-matrix.md`.

---

## A. Owner approval already granted

### A.1 Approval statement

> The owner explicitly approved the recommended defaults for WP-04 decisions **WD-01 through WD-14**, without amendments or additional notes.

| Field | Value |
|---|---|
| Approval date | **2026-11-08** (as supplied by the execution environment) |
| Approval level | **Design and policy only** |
| Amendments | **None** |
| Additional notes | **None** |
| Recorded in | `wp-04-owner-decision-proposal.md` §16 |
| Gate effect | **None** — no gate signed or passed |

### A.2 Approved decisions

| ID | Approved policy |
|---|---|
| WD-01 | D01–D10 are the read-only detection vocabulary |
| WD-02 | No `R9`/`R10` in the first implementation; D02/D09 remain finding codes |
| WD-03 | Role-placeholder ownership matrix; named people deferred |
| WD-04 | Stale `CONSUMING` is alert-only |
| WD-05 | No age-based hold release |
| WD-06 | Shortage is report-only; no correction quantity |
| WD-07 | Evidence history is append-only |
| WD-08 | Lease/retry values remain provisional test inputs |
| WD-09 | Scheduled worker disabled by default |
| WD-10 | Item-level first; mandatory line-level deferred |
| WD-11 | Evidence-based legacy cutoff process; no invented date |
| WD-12 | Verify deployed indexes before relying on uniqueness |
| WD-13 | External/manual writers must be registered |
| WD-14 | Gate evidence definitions approved; signatures remain separate |

### A.3 Deferred decisions (unchanged, not approved by inference)

Shortage accounting semantics; named approver/executor/verifier and backups; numeric `W_STALE` and live-reservation thresholds; legacy cutoff date; evidence/output retention; lease duration, retry count, backoff, jitter, and cap; production scan window and transaction-lifetime limits; alert sink/on-call/SLA; exact recovery task and evidence schema; index deployment window; external-writer inventory; gate signatories and dates; `R9`/`R10` adoption trigger; D06 task creation; automatic hold release; line-to-item allocation model; worker scheduling.

The authoritative 22-item register remains `wp-04-owner-decision-proposal.md` §16.3. This record restates the categories but does not amend or renumber that register.

---

## B. Separate WP04-00 authorization

### B.1 Authorization statement

> The owner subsequently authorized execution of **WP04-00 only**, as a documentation and authorization-boundary activity.

### B.2 Purpose

To record the exact scope and boundaries of this authorization, confirm consistency with WD-01 through WD-14, and verify repository preservation. Nothing else.

### B.3 Authorized activity (exhaustive)

1. Inspect the existing WP-04 planning documents.
2. Record the exact scope and boundaries of this WP04-00 authorization.
3. Create this WP04-00 authorization record.
4. Verify the record is consistent with the approved WD-01 through WD-14 decisions.
5. Report repository preservation and final Git status.

### B.4 Artifacts permitted

| Path | Action | Type |
|---|---|---|
| `docs/production-readiness/wp-04-00-authorization-record.md` | **Created** | Documentation only |

No other path may be created, modified, moved, renamed, or deleted under this authorization.

### B.5 Classification

| Attribute | Value |
|---|---|
| Package | WP04-00 |
| Change class | C0 / AUTH-0 |
| Code changes | **None** |
| Database changes | **None** |
| Operational changes | **None** |
| Reversible by | Deleting this single documentation file; no system dependency |

---

## C. WP04-01 is NOT authorized

**Explicit statement:**

1. **WP04-01 (rule registry, evidence projection, fingerprint) has not been authorized.**
2. **No source-code implementation of any kind is permitted under this authorization.**
3. **A separate, explicit owner authorization is required before WP04-01 begins.**
4. This WP04-00 record must not be cited as, converted into, or inferred as a WP04-01 authorization.
5. The existence of candidate paths in the blueprint (for example `lib/recovery/rules/registry.js`) does **not** authorize creating them.

WP04-01 remains **NOT AUTHORIZED / NOT STARTED**.

---

## D. Prohibited actions

This authorization does **not** permit:

| # | Prohibited action |
|---|---|
| 1 | Application source changes |
| 2 | Schema, API, route, or runtime configuration changes |
| 3 | Database access or mutation |
| 4 | Index creation, synchronization, or deployment |
| 5 | Migrations or seed operations |
| 6 | Recovery collections, records, workers, queues, leases, cron, or schedulers |
| 7 | Reconciliation against actual order or inventory records |
| 8 | Inventory V2 activation |
| 9 | Payment, stock, reservation, or accounting changes |
| 10 | Staging or production execution |
| 11 | Gate signing or any gate status change |
| 12 | WP04-02 or any package after WP04-01 |
| 13 | WP-13 or WP-09 |

Also prohibited: staging, committing, pushing, deploying, resetting, cleaning, checking out, or stashing; overwriting or removing existing user work; reading `.env`, `.env.local`, secrets, credentials, or production data.

---

## E. Existing safety and approval gates (unchanged)

| Gate | State | Note |
|---|---|---|
| **G-REC-1** | **UNSIGNED — NOT STARTED** | Read-only reconciliation not implemented; no staging sample |
| **G-REC-2** | **UNSIGNED — NOT STARTED** | Recovery schema/index not approved, deployed, or verified |
| **G-REC-3** | **UNSIGNED — NOT STARTED** | Worker lease/retry/audit/escalation not proven |
| **G-AUD-1** | **UNSIGNED — NOT STARTED** | Append-only audit not deployed or proven |
| **G-GOV-1** | **UNSIGNED — NOT STARTED** | RACI and named roles/backups not signed |
| **G-IDX-1** | **UNSIGNED** | Index coverage not collected |
| **G-DB-1** | **UNSIGNED** | Topology/concern evidence not collected |
| **G-DB-2** | **UNSIGNED** | Transaction budget not signed |
| **G-DB-4** | **UNSIGNED** | Failover/alert routing not proven |
| **G-PAY-1** | **BLOCKED** | No approved isolated staging environment |
| **G-PAY-2** | **UNSIGNED** | Finance adjustment boundary not approved |

**No gate is signed, passed, or waived by this record.** G-PAY-1 remains **BLOCKED** unless new verified evidence and a separate approval change that status. This record neither supplies that evidence nor grants that approval.

---

## F. Next authorization requirement

The next step requires a **separate, explicit owner instruction authorizing WP04-01**.

That future authorization must:

1. name WP04-01 and nothing later;
2. limit scope to the exact WP04-01 deliverables (rule registry, evidence projection, fingerprint);
3. restate its own stop conditions and acceptance criteria from `wp-04-implementation-work-packages.md` §2;
4. confirm the read-only, database-free nature of the package;
5. name the reviewer of the package;
6. be recorded in its own artifact.

**Do not infer WP04-01 authorization from this WP04-00 record, from the WD-01…WD-14 policy approval, or from the existence of planning documents.**

---

## G. Consistency check against WD-01 through WD-14

| Check | Result |
|---|---|
| Approved decisions WD-01…WD-14 restated without amendment | PASS — matches `wp-04-owner-decision-proposal.md` §1 and §16 |
| Deferred items remain deferred | PASS — no numeric, named, retention, or date item promoted |
| No `R9`/`R10` introduced | PASS — WD-02 respected |
| No age-based release or automatic repair introduced | PASS — WD-04/WD-05 respected |
| Worker remains disabled, no scheduling introduced | PASS — WD-09 respected |
| No index assumption or deployment introduced | PASS — WD-12 respected |
| No gate signed or reclassified | PASS — gate table copied unchanged |
| WP04-01 explicitly excluded | PASS — Section C |
| No code or database artifact created | PASS — Section B.4 and final verification |

---

## H. WP04-00 acceptance status

| Acceptance item | Status |
|---|---|
| Baseline re-verified against the recorded prior state | **MET** — see §I |
| Authorization record exists | **MET** — this file |
| Scope limited to the read-only slice / documentation only | **MET** — §B |
| All deferred items restated (by reference to §16.3) | **MET** — §A.3 |
| Reviewer named | **OPEN — NOT SUPPLIED.** No reviewer name was provided in this authorization. A name must not be invented; it remains an owner action. |
| No gate signed | **MET** |

WP04-00 is **partially accepted**: the record and baseline lock are complete, but the package's reviewer-naming criterion is still open. That gap does not authorize WP04-01 and does not block this documentation record; it must be closed in the WP04-01 authorization or a WP04-00 addendum.

---

## I. Repository preservation verification

### I.1 Baseline (captured before this record was created)

| Measure | Value |
|---|---|
| Branch | `main` |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` |
| Total entries | **299** |
| Modified (` M`) | **61** |
| Untracked (`??`) | **238** |
| Deleted | **0** |
| Staged | **0** |
| Status file | `%LOCALAPPDATA%\Temp\opencode\wp04-00-status-before.txt` |
| SHA-256 | `c8ce107d3996a6df9b554e9e4554ab7e8b448b28e1b6fbf68dfe1186be0b97ea` |

### I.2 Final verification

| Check | Observed | Required | Result |
|---|---|---|---|
| Branch | `main` | `main` | PASS |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` | unchanged | PASS |
| Added paths vs baseline | **1** — `docs/production-readiness/wp-04-00-authorization-record.md` | exactly 1 (this record) | PASS |
| Removed paths vs baseline | **0** | 0 | PASS |
| Modified count | **61** | 61 | PASS |
| Tracked application file changed | **None** — HEAD/index unchanged; only one untracked doc added | none | PASS |
| Staged count | **0** | 0 | PASS |

Final totals: **300** entries = **61** modified + **239** untracked, **0** deleted, **0** staged. Status SHA-256 after creation: `65bee2d9c246757adbe3bb5e35fa0e51b152b8210f0743b908edbb5b0637c4e5`.

### I.3 Preservation rule

The final check compares the complete baseline and final `git status --short --untracked-files=all` path lists. No pre-existing modified or untracked path may be removed. No tracked application file may change. Exactly one new documentation path may be added. No test run is required because no code changed.

If the repository state differs from this baseline, the correct action is to **stop and report the discrepancy**, not to clean up, reset, or overwrite.

---

## J. Closing statement

- **Created:** exactly one documentation artifact, `docs/production-readiness/wp-04-00-authorization-record.md`.
- **Authorized scope:** documentation and authorization-boundary recording only.
- **WP04-01 remains NOT AUTHORIZED.**
- **No source, database, staging, production, or operational work was performed.**
- **No gate was signed, passed, or waived; all gate states are unchanged.**
- **G-PAY-1 remains BLOCKED.**
- **Inventory V2 remains inactive; WP-13 and WP-09 were not started.**

Stop after WP04-00. Await a separate owner authorization for WP04-01.
