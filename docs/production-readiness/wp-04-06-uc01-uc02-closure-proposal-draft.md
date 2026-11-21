# WP-04-06 — BLK-UC-01 / BLK-UC-02 closure proposal (DRAFT — PENDING OWNER APPROVAL)

> **Status: DRAFT.** This document is a **proposal for owner review only**. It is
> **not** a closure record: **BLK-UC-01 and BLK-UC-02 remain OPEN** until the
> owner approves their closure. No register section, R3 section, blocker row,
> banner, or gate status has been changed by this draft except the separately
> authorized §12.5 W8-approval wording correction (register, corrected in place;
> see §4 below). It authorizes no database access, staging, production, schema
> or index change, migration, runtime wiring, worker, scheduler, or Git action.
> It signs no gate.

**Proposal basis:** independently reviewed execution evidence run
`wp04-06-t2-debdf49b933a`
(`docs/production-readiness/evidence/wp04-06-t2-debdf49b933a.json`,
`EXECUTED_EVIDENCE_RECORDED`, exit 0; assertions `T2_A`, `T2_B`, `T2_C`,
`T5_CRASH`, `T8_CRASH` all `PASSED`) on the disposable loopback replica set
`bonowp0406t2rs` (mongod 8.0.34, ports 27031/27032, bindIp 127.0.0.1).

---

## 1. BLK-UC-01 — criterion-by-criterion comparison

**Blocker as recorded (R3 §19.3, §22.3):** durable operation identity after a
worker crash is not guaranteed; no durable pre-commit intent record exists;
until resolved by owner-approved design, no worker may derive identity as
`eventSequenceCounter + 1n` after a crash, mint a new sequence/event identity,
or perform a conflicting mutation.

| # | Exit criterion (source) | Status | Verified evidence |
|---|---|---|---|
| 1 | Owner-approved durable-identity design (OD-24 O2 `pendingOperation`; OD-25 uniqueness per task across all generations; OD-26 positive `U`; OD-28 permanent sequence gaps; OD-30 task-document CAS as the fence; OD-37 expired-lease identity; T9/Acq claim amendment; I-C standalone `T_reserve`) | **SATISFIED** | All APPROVED, register §1 (2026-11-12); OD-10 production schema contract approved 2026-11-14 (§2, §2.4). |
| 2 | Full reserved identity persisted in `pendingOperation` **before** the effect attempt (R3 §22.4 item 6: `operationId`, `sequenceNumber`, `eventId`, `leaseGeneration` durable, else BLK-UC-01 remains open) | **SATISFIED** | W6 `reserveOperation` implemented in `lib/recovery/taskWriter.js` (standalone `T_reserve`: no event, exactly one sequence reserved); live-verified in run `wp04-06-t2-debdf49b933a` — independent primary/majority reads of `inventory_recovery_tasks` show `pendingOperation = {operationId, state: PREPARED, leaseGeneration: 1, sequenceNumber: 3, eventId: EVT:<taskId>:3, reservedAt, reservedBy, intentDigest}` in both crash scenarios. |
| 3 | Crash/restart test exercising the durable post-crash identity (register §12.5 listed "not exercised by a crash/restart test" as the reason BLK-UC-01 stayed open after T2 acceptance) | **SATISFIED** | **T5-CRASH PASSED** in run `wp04-06-t2-debdf49b933a`: victim child SIGKILLed after exactly W1/W2/W6 (writer trace `createTaskFromFinding, claimLease, reserveOperation`; no `commitOperation` entry — asserted); fresh child reconciled **read-only** (`UNRESOLVED/HOLD`, `writesPerformed: 0`, `matchesSpec: true`); fresh W7 completed at the **exact durable reserved identity** (`t2-op-…-T5-CRASH`, seq 3, `EVT:…:3`) using the reserved fencing token (`23d769d4-cc14-411c-b040-f275b3574f62` — equals the reserved worker token); independent P4 verified the committed world (events 3 / history 1; one effect event + one history row). |
| 4 | No new identity minted after a crash; the reserved identity is the only effect identity | **SATISFIED** | T5-CRASH fresh W7 result reports the reserved `operationId`/`sequenceNumber`/`eventId`; the zero-match CAS convention (durable-state invariance asserted, Phase A) plus the P4 world confirm no conflicting identity was created. |

**Proposed closure basis (register §14.3 style):** BLK-UC-01 closes on the
owner-approved O2 `pendingOperation` design (OD-24/25/26/28/30/37, I-C, T9/Acq)
implemented as W6 standalone `T_reserve`, and the crash/restart execution proof
run `wp04-06-t2-debdf49b933a` (T5-CRASH PASSED) demonstrating durable
reservation recovery, read-only HOLD reconciliation, and exact-identity W7
replay. **Accepted residuals:** harness-only disposable replica-set evidence
(no runtime wiring); Windows SIGKILL = TerminateProcess, recorded as observed,
never claimed as POSIX delivery; single-run evidence requiring independent
review before any acceptance claim; BLK-EVID-01 provenance (untracked files)
remains OPEN and unaffected.

---

## 2. BLK-UC-02 — criterion-by-criterion comparison

**Blocker as recorded (R3 §19.3, §6.2, §7.2, §22.6):** no persisted
representation or safe resolution path for `UNKNOWN_COMMIT`;
`MANUAL_REQUIRED` cannot be committed while a prior transaction is
unresolved; a new lease claim is itself a conflicting mutation; no read-only
arbitration mechanism exists.

| # | Exit criterion (source) | Status | Verified evidence |
|---|---|---|---|
| 1 | Owner-approved resolution protocol | **SATISFIED** | OD-27 APPROVED (hold-default; operator-authorized abandonment; no automatic replay of an unknown-commit window); OD-27-SC APPROVED (same-identity replay only after a writer-observed definitive abort; `UNKNOWN_COMMIT` observed-only); OD-31 APPROVED (`UNKNOWN_COMMIT` observed only; operation stays `PREPARED`); OD-37 APPROVED (expired-original-lease identity predicate; `ABANDONABLE_STATUSES = {LEASED}`). Register §1; W8 authorization recorded §14.4 (2026-11-14). |
| 2 | Approved representation of the indeterminate condition | **SATISFIED** | Per OD-31 the representation is an **observed-only condition**: no persisted `UNKNOWN_COMMIT` status exists or is needed; the operation stays `PREPARED` and the task stays `LEASED` until a separately authorized W8 settlement. Register §14.4 records `ESC_UNKNOWN_COMMIT` as used **only** by W8. |
| 3 | Read-only arbitration mechanism | **SATISFIED** | `assessOperationOutcome` (`lib/recovery/taskWriter.js`) implements the authoritative primary/majority-read classification; live-verified in both crash scenarios: fresh children reconciled `UNRESOLVED/HOLD` with `writesPerformed: 0` against the durable `PREPARED` crash world (T8 post-kill P4: `effectCommitted: false`, task `LEASED`, operation `PREPARED`, events 2 / history 0 — no partial rows). |
| 4 | Operator resolution path that does not conflict with an unresolved prior transaction | **SATISFIED** | W8 `abandonOperation` implements R3 §22.6.2's eight same-transaction CAS requirements with the OD-37 expired-original-lease server-time predicate (`$$NOW ≥ leaseUntil`) and the exact-identity CAS; live-verified in **T8-CRASH PASSED**: armed W7 commit withheld (never reached mongod), victim SIGKILLed inside the commit await, then the fresh child's W8 settled the task to `MANUAL_REQUIRED` / `manualReasonCode: AMBIGUOUS_COMMIT` / `escalation.code: ESC_UNKNOWN_COMMIT`, `pendingOperation.state: ABANDONED` with full settlement metadata, exactly one `RECOVERY_ESCALATED` settlement event (seq 4) and exactly one `ABANDONED` history row referencing the reserved `EVT:…:3` (seq 3 permanently absent — OD-28 gap), counts events 3 / history 1. |
| 5 | Authorization bound to the exact operation identity; audit wording never overclaims | **SATISFIED** | T8 authorization `crash-abandon:wp04-06-t2-debdf49b933a:T8-CRASH` names the exact `operationId`; `operatorId wp04-06-crash-operator`, `operatorRole ROLE-INVENTORY-MANAGER` (in `APPROVAL_ROLES`), `basis: "OPERATOR_DECISION_AFTER_HOLD"` — never `ABORT_CONFIRMED` (R3 §22.6.3 audit-wording control). Settlement metadata mirrors the authorization verbatim in task, event, and history records. |

**Proposed closure basis (register §14.3 style):** BLK-UC-02 closes on the
owner-approved hold-default + operator-authorized OD-37 abandonment protocol
(OD-27, OD-27-SC, OD-31, OD-37; W8 authorization register §14.4), implemented
as the read-only `assessOperationOutcome` HOLD path and W8 `abandonOperation`,
and the crash/abandonment execution proof run `wp04-06-t2-debdf49b933a`
(T8-CRASH PASSED) demonstrating the durable `PREPARED` crash world, the
zero-write HOLD, and the authorized settlement with the permanent sequence gap.

**Accepted residuals (must be preserved verbatim in the closure record):**

1. **Authorization is not abort proof (R3 §22.6).** The W8 CAS is a settlement
   fence, not a historical abort record; the abandonment does not establish
   that the original effect transaction aborted, and the audit basis is
   `OPERATOR_DECISION_AFTER_HOLD`, never `ABORT_CONFIRMED`.
2. **OD-07 dependency (register §5 item 1, §7).** The residual audit/operational
   control remains **not actionable** until OD-07 alerting input exists; this
   closure does not make G-REC-3 sign-off possible and does not activate any
   alerting.
3. **Harness-only evidence.** Disposable replica set, loopback only; no runtime
   wiring, worker, or scheduler; Windows SIGKILL = TerminateProcess recorded as
   observed; the T8 scenario's short lease (`leaseMs` 2000) and host-time expiry
   wait are harness timing measures — the W8 CAS predicate itself is server-time
   (`$$NOW ≥ leaseUntil`), and elapsed time is never treated as abort proof
   (R3 §6.1 invariant 3).
4. **Single-run evidence.** One execution run; requires independent review
   before any acceptance claim; no closure claimed by the runner output itself.
5. **Untracked provenance (BLK-EVID-01 unaffected).** All WP04-06 files remain
   untracked; `git diff --cached` empty.

---

## 3. Proposed register/R3 edits (to be applied only on owner approval)

1. **Register §15 (new):** "Crash/restart execution record (Phase B, 2026-11-15,
   documentation only)" — records run `wp04-06-t2-debdf49b933a`, the T5-CRASH /
   T8-CRASH scenarios, the verified fields above, the three preserved
   failed-run provenance files (`wp04-06-t2-68aede0a0797`,
   `wp04-06-t2-f421dfb3a1b0`, `wp04-06-t2-d70a1e61908a`), and the harness fixes
   (T8 reaper-window wait widening; withheld-commit proxy mode; status-file
   final-read fix). Documentation only; signs no gate.
2. **Register §4 (amendment log, new row R3-AM8):** "BLK-UC-01 and BLK-UC-02
   CLOSED (owner action, date of approval) on the crash/restart execution
   evidence run `wp04-06-t2-debdf49b933a`; residuals preserved (§15);
   BLK-EVID-01 remains OPEN."
3. **Register §14.3 (table, two new rows):** the closure rows from §1/§2 above.
4. **R3 §19.3 (rows BLK-UC-01, BLK-UC-02) and §21.4 (bullets):** updated to
   **CLOSED** with the same basis and residuals, original blocker text
   preserved as provenance.
5. **R3 banner + register T2-acceptance-notice supersession notes:** add the
   UC-01/UC-02 closure to the list of superseded statuses.
6. **Register §12.5 (BLK-UC-01 bullet):** add a "(Superseded: CLOSED … — §15)"
   note matching the §12.5 style (the BLK-UC-02 bullet is already corrected —
   see §4 below).

## 4. §12.5 W8-approval wording correction (applied)

The register §12.5 BLK-UC-02 bullet said the "`UNKNOWN_COMMIT` representation
and the operator resolution protocol remain **unapproved**" — stale when
written (OD-27/OD-27-SC/OD-31/OD-37 were approved 2026-11-12; W8's separate
authorization was recorded in §14.4 on the same date as §12). Corrected in
place with a "(Approval wording corrected …)" note that preserves the OPEN
blocker status. No other register/R3 text was changed.

## 5. Non-claims

This proposal authorizes no database access, staging or production access,
schema change, index deployment (G-IDX-1 remains UNSIGNED/BLOCKED), migration,
runtime Recovery integration, writer call site, worker, scheduler, feature
flag, or change to POS / payment / Inventory / Hotel / waiter / Kitchen /
Barista / Jebena behavior. It signs no gate (G-REC-1, G-REC-2, G-REC-3,
G-AUD-1, G-GOV-1 remain UNSIGNED; G-IDX-1 remains UNSIGNED/BLOCKED; G-PAY-1
remains BLOCKED). **BLK-EVID-01 remains OPEN** and is untouched by this
proposal. Nothing here stages or commits anything.
