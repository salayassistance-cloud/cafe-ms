# Phase 14 — Owner Decisions, Release Preparation & Staging Plan

| Field | Value |
|---|---|
| Repository | `C:\hotelms`, branch `main`, HEAD `6965043 Complete Bono UI and reporting updates` |
| Baselines | `docs/production-readiness/phase-12-final-deployment-readiness-report.md`; `docs/production-readiness/phase-13-blocker-resolution-report.md` |
| Prior verdicts | Phase 12: **NOT READY FOR DEPLOYMENT**. Phase 13: same verdict; PIN UX/session defect fixed and locally verified. |
| Phase 14 verdict | **NOT READY FOR DEPLOYMENT** — no deployment performed; all infrastructure and policy decisions remain owner-owned. |
| Date | 2026-11-21 |
| Mode | Review, planning, decision memos, and documentation only. No deployment, no production DB, no backup/restore, no migrations, no index changes, no credentials, no secrets, no commits/pushes. |

## Evidence labels

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in this or the immediately preceding phase via local read-only command, test, or build. |
| **SOURCE-INSPECTED** | Established by reading current code/docs at a cited path; not runtime-proven. |
| **PROPOSED** | A plan, threshold, script invocation, or configuration prepared for owner review; not applied. |
| **OWNER DECISION** | Requires an explicit owner choice/signature before any implementation. |
| **NOT VERIFIED** | No evidence available locally; requires owner-provided environment or provider access. |
| **BLOCKED** | Cannot proceed without owner approval or infrastructure. |

---

## 1. Executive summary

1. **PIN fix reviewed (candidate, not accepted):** the Phase 13 patch is four client-side lines of behavior change in `HotelChangePinModal.jsx` plus test/harness files. It closes the stale-session symptom but **does not equal staging acceptance**. A 13-step staging acceptance checklist is provided in §3.
2. **Backup policy reconciled:** the owner's nine previously approved requirements are treated as **authoritative prior policy**. Repository docs contain proposals with blank approval tables, but their proposed numbers match the approved policy. Missing: mechanism selection, provider configuration, retention settings, drill report, and infrastructure evidence. **No backup or restore was executed.**
3. **Staging architecture and provisioning checklist prepared** in §5: isolated app, isolated POS replica set, isolated Hotel standalone DB, environment variables named only, G0 gates, 15 GP1 cases, and a full execution checklist. **No infrastructure created.**
4. **Index plan prepared** in §6: POS/Hotel/Inventory V2 separated, exact scripts/flags, duplicate preflight, dry-run and verification commands. **No index deployment.**
5. **Observability plan finalized** in §7 with proposed thresholds and a redaction/log-shipping design. **No monitoring provisioned.**
6. **CI proposal prepared** in §8 with concrete jobs, commands, secrets by name, branch protections and failure reporting. **No CI infrastructure or remote setting changed.**
7. **Commit grouping exact counts** in §9: 513 expanded working-tree entries (88 modified, 3 deleted, 422 untracked), 0 staged; three EXTERNAL deletions intact. **No git write command.**
8. **Toolchain:** Node `v24.14.0`/npm `11.9.0` are empirically compatible; exact proposed pins given in §10. The Netlify plugin version has **zero evidence anywhere** and is **BLOCKED** on owner-provided build logs — no version guessed.
9. **B8/B9/B10 decision memos** in §§11–13. Existing behavior unchanged.
10. Verdict and next approvals in §§15–17.

---

## 2. PIN fix review and local evidence (candidate for staging acceptance)

### 2.1 Actual patch reviewed

`app/components/hotel/HotelChangePinModal.jsx` (Phase 13 change):

| Line | Change | Purpose |
|---|---|---|
| `:9`, `:18` | `import { useRouter } from "next/navigation"`; `const router = useRouter()` | Allows the server layout to be revalidated after the session is revoked |
| `:29-38` | `closeIfIdle()` additionally calls `setCurrentPin("")`, `setNewPin("")`, `setConfirmPin("")` | Removes PIN values from component state on cancel/backdrop close |
| `:74-88` | On `response.ok && data?.success`: existing toast/input clearing preserved; `setTimeout` now calls `onClose?.()` then `router.refresh()` | Replaces the stale authenticated page with the sign-in gate immediately after the success toast |

Header comments at `:5-6` still correctly state no target identity is sent; `:61` still forwards only the memory-only CSRF header; `:62-66` still posts only `{currentPin,newPin,confirmPin}`.

**No server-side code changed.** Session revocation scope, PIN hashing, collision policy, rate limits, CSRF/Origin enforcement, and audit behavior are untouched (`app/api/hotel/auth/change-pin/route.js:117-132`; `lib/hotel/auth/session.js:416-436`; `lib/hotel/auth/credential.js:191-207`).

### 2.2 Local tests reviewed (not staging acceptance)

| File | Tests | What it proves |
|---|---|---|
| `tests/hotel-pin-change-behavior.test.mjs` | 13 | scrypt round-trip; new PIN persists/old fails; login verifies new/rejects old; locked account unlocked by change; collision + self-exclusion; Manager reset changes only target and rejects Manager target/collision; session revocation scoped to user; five failures lock identity |
| `tests/hotel-pin-change-route.test.mjs` | 13 | Real `Request` → Origin/CSRF/auth/validation/DB/audit: 200 success, 401 wrong PIN/no cookie, 422 validation, 409 collision, 403 CSRF/Origin, target cannot be chosen; Manager reset 200 + revocation + audit |
| `tests/hotel-change-pin-ui-regression.test.mjs` | 4 | Structural guards for `useRouter`, `router.refresh()` after `onClose()`, PIN clearing on success/cancel, CSRF forwarding, no target identity, no browser storage |
| `tests/helpers/hotel-route-loader.mjs`, `hotel-route-register.mjs`, `hotel-route-fake-db.mjs` | harness | Intercepts **only** the Hotel DB connection; production sources loaded unmodified. Route test self-registers the hook so it runs in the default suite. |

Local results (Phase 13, VERIFIED): 30/30 PIN-focused tests; full DB-free suite 2,554 tests / 417 suites / 0 fail; lint 0 errors / 3 warnings; build success.

**Explicit limitation:** all of the above are DB-free or in-memory. They do **not** prove browser navigation, real cookie behavior, real proxy Origin handling, CDN/cache interaction, or cross-system isolation. The staging checklist below is required.

---

## 3. PIN staging acceptance checklist (candidate → accepted only after staging)

Run against the isolated staging environment from §5 with staging-only identities. Record evidence (screenshots, request/response IDs, audit-log exports) for every step. All steps must pass; any failure returns the PIN fix to **candidate** status.

| ID | Scenario | Steps / expected evidence | Status |
|---|---|---|---|
| PIN-S01 | Prerequisite | Staging Manager and Receptionist identities exist; `HOTEL_SESSION_SECRET` differs from `AUTH_SECRET`; `ROOM_MONGODB_URI` targets `bono_hotel` only | ☐ |
| PIN-S02 | Manager self-service PIN change | Sign in as Manager → Settings → Change PIN → current PIN + new PIN + confirm → success toast → modal closes → **sign-in gate appears without any further action** (verifies `router.refresh()`) | ☐ |
| PIN-S03 | New PIN persistence | Sign in again with the **new** PIN → 200; session established; `/api/hotel/auth/me` returns correct role | ☐ |
| PIN-S04 | Old PIN rejection | Attempt sign-in with the **old** PIN from a fresh session → 401 generic `INVALID_CREDENTIALS`; failed-attempt counter increments; no session cookie set | ☐ |
| PIN-S05 | Receptionist self-service change | Repeat PIN-S02…S04 as Receptionist; confirm role/Hotel DB isolation unchanged | ☐ |
| PIN-S06 | Manager resets Receptionist PIN | Manager opens staff management → reset Receptionist PIN → new PIN works, old PIN fails; `updatedByStaffId` = Manager; Manager's own PIN unchanged; `STAFF_PIN_RESET` audit present | ☐ |
| PIN-S07 | Session revocation | With two simultaneous sessions for the same HotelUser, change PIN in one → both sessions revoked (`revokedAt`, `revokeReason=SECURITY`); the second tab receives 401 on next API call and is gated after refresh | ☐ |
| PIN-S08 | Logout then login | After PIN change, use Log out explicitly → clean sign-in gate; sign in with new PIN → functional session; sign in with old PIN → rejected | ☐ |
| PIN-S09 | Browser navigation / protected-page behavior | Back/forward/refresh on `/hotel/reception`, `/hotel/rooms`, `/hotel/reports`, `/hotel/management` after change never renders cached authenticated content; protected pages redirect/gate server-side for wrong role | ☐ |
| PIN-S10 | CSRF / Origin protection | Replay the change request without `X-Hotel-CSRF-Token` → 403 `CSRF_VALIDATION_FAILED`; from a foreign `Origin` → 403 `ORIGIN_NOT_ALLOWED`; no credential write occurs in either case | ☐ |
| PIN-S11 | Audit evidence | `STAFF_SELF_PIN_CHANGED` (self) and `STAFF_PIN_RESET` (manager reset) records present with correct actor, role, outcome=SUCCESS, timestamp, request metadata; **no PIN value in audit or logs**; redaction verified | ☐ |
| PIN-S12 | Failure/negative cases | Wrong current PIN → 401; mismatched confirm → 422; same old/new → 422; non-4-digit → 422; collision with another identity → 409; all leave PIN unchanged | ☐ |
| PIN-S13 | Regression suite on staging artifact | Run the DB-free suite and the three PIN suites against the exact staged commit; record commit SHA and results | ☐ |

**Acceptance rule:** PIN-S01…S13 all pass with evidence, signed by ops + owner, before the fix is treated as accepted. Local test results alone are insufficient.

---

## 4. B2 — Backup policy reconciliation

### 4.1 Governing principle

The owner has previously approved the nine requirements listed below in prior ChatGPT discussions. **They are treated as authoritative prior policy.** The absence of the original approval text in `C:\hotelms` documentation is **not** grounds to claim they were never approved; repository docs are proposal templates with blank approval tables (`phase-2-4-owner-decisions.md:635-666`; `phase-2-4-production-database-checklist.md:642-658`; `phase-2-5-safety-and-deployment-gates.md:440-455`) and are not the authoritative approval record. This report records the policy as supplied by the owner and identifies only what is missing **in implementation and evidence**.

### 4.2 Requirement-by-requirement reconciliation

| # | Owner-approved policy (from owner) | Repository documentation status | Mechanism / configuration | Restore drill / actual evidence |
|---|---|---|---|---|
| 1 | RPO ≤15 minutes | Proposed value appears as "≤15 minutes" but marked "UNVERIFIED — OWNER DECISION" (`phase-2-5-safety-and-deployment-gates.md:255`); owner now supplies the decision. Doc update required. | **NOT VERIFIED** — no provider config in repo | **MISSING** — drill report with measured data-loss window (`phase-2-4...checklist.md:511,518`) |
| 2 | RTO ≤4 hours | Same status (`:256`); doc update required | **NOT VERIFIED** — no provider config | **MISSING** — measured restore duration within approved RTO (`:270,518`) |
| 3 | Backup retention ≥30 days | Options "30/90/365 days" listed (`phase-2-4...checklist.md:465`); "backup retention proposed ≥30 days" marked unverified (`phase-2-5...gates.md:257`) | **MISSING** — no configured retention evidence | **MISSING** — provider evidence for G15 (`phase-2-4...checklist.md:629`) |
| 4 | Monthly restore points ≥90 days | Not explicitly documented; related "90 days" appears only as generic retention option (`:465`) | **MISSING** — schedule/retention configuration | **MISSING** — restore-point inventory and provider evidence |
| 5 | PITR ≥7 days if supported | "PITR window must match claimed RPO if PITR is used" (`phase-2-5...gates.md:258`); PITR+retention recommended (`phase-2-4-owner-decisions.md:483`); nightly dump insufficient (`phase-2-3-recovery-and-idempotency-design.md:345-350`) | **MISSING** — provider PITR setting, support confirmation | **MISSING** — PITR restore evidence and G16 (`phase-2-4...checklist.md:630`) |
| 6 | Financial/order evidence ≥1 year | 365-day option present (`:465`); PAID/ARCHIVED orders declared financial evidence that must survive cleanup (`:479`; `phase-2-4-destructive-operations-policy.md:161,304`) | **MISSING** — retention configuration for orders/payments | **MISSING** — provider evidence + policy enforcement |
| 7 | Destructive/recovery audit evidence ≥1 year | "Audit retention must be defined; no default exists" (`phase-2-4-owner-decisions.md:597`); C-5 decision open (`phase-2-4-destructive-operations-policy.md:417`); append-only requirement (`:181`) | **MISSING** — retention configuration | **MISSING** — evidence of append-only retention |
| 8 | No audit evidence TTL/deletion without separate approval | "TTL is cleanup-only and must never decide whether a new document may exist" (`phase-2-4...checklist.md:429`); no default deletion allowed (`phase-2-4-owner-decisions.md:597`) | **MISSING** — TTL/config audit | **MISSING** — verification that no audit TTL/disable path exists |
| 9 | Provider-managed encryption at rest and TLS | "Encryption at rest: Not documented"; "Offsite/cross-region copy: Not documented" (`phase-2-4...checklist.md:447-448`); confirmation required (`:268`) | **MISSING** — provider configuration evidence | **MISSING** — provider evidence for G15/G16 |

### 4.3 What remains to close B2

1. Owner attaches the original approval record (or a signed restatement of the nine items) to the release folder; repo docs are updated to reflect approval rather than "UNVERIFIED — OWNER DECISION."
2. Ops/DBA select and configure the mechanism satisfying all nine items (backup + PITR if supported + retention tiers + encryption/TLS + offsite copy). Provider evidence (configuration screenshots/exports, by name only, no secrets) is captured.
3. Isolated restore drill per `phase-2-4...checklist.md:490-528`, `phase-2-5...gates.md:263-286`, `phase-2-3...design.md:343-350`, Gate 3 at `phase-12...report.md:499-503`: restore to isolated target, apply PITR to a chosen point, verify counts/reconciliation/counters/unique indexes, measure RPO/RTO, independent verifier signs.
4. Backup success/failure alerting and drill-age alert configured (owner-approved on-call).

**No backup, restore, or PITR operation was performed in this phase. B2 remains BLOCKED on mechanism/configuration/drill evidence.**

---

## 5. B1 — Isolated staging architecture and execution checklist

**Status: PROPOSED — no infrastructure created; all provisioning BLOCKED on owner approval.**

### 5.1 Architecture (logical)

```
Owner-approved network / hosting provider
┌──────────────────────────────────────────────────────────────────────┐
│ STAGING APPLICATION (isolated deploy, own URL, own build artifact)  │
│  Next.js 16.3.1 / Node pinned (see §10) / same commit as release tag │
│  Env: secrets by NAME ONLY (§5.2), values from owner secret store   │
└───────────────┬──────────────────────────────┬───────────────────────┘
                │ MONGODB_URI (staging POS DB) │ ROOM_MONGODB_URI (bono_hotel)
                ▼                              ▼
┌───────────────────────────────┐  ┌──────────────────────────────────┐
│ POS STAGING DB                │  │ HOTEL STAGING DB                 │
│ disposable replica set        │  │ standalone, non-default port,    │
│ (integration DB prefix)       │  │ DB name forced to `bono_hotel`   │
│ autoIndex gated               │  │ autoIndex:false / autoCreate:false│
└───────────────────────────────┘  └──────────────────────────────────┘
        ✗ No network path from staging config to any production DB
        ✗ No reuse of MONGODB_URI for Hotel; HOTEL_SESSION_SECRET ≠ AUTH_SECRET
```

Isolation requirements: separate app URL/host, separate POS database cluster or database, separate Hotel database and session secret, test-only identities, separate log capture with redaction, separate backup/restore target for the staging drill. Evidence: distinct database names, distinct secret values (never printed), and a read-only connectivity assertion that production hosts/URIs are unreachable from staging configuration.

### 5.2 Environment variables — names only (no values)

| Group | Names | Notes |
|---|---|---|
| POS DB | `MONGODB_URI`, legacy alias `CAFEDB_URI` | `lib/config/runtimeEnv.js:7,16-19` requires `MONGODB_URI` at boot; POS connection `lib/mongodb.js:32-48,140-145` |
| POS auth | `AUTH_SECRET`, `ALLOWED_ORIGINS` | `.env.example:10-21`; `AUTH_SECRET` throws in production if missing (`lib/sessionCrypto.js:9-10`) though it is not yet in `validateRuntimeEnv` (`lib/config/runtimeEnv.js:7`) — Phase 12 Gate 0 asks to extend boot validation |
| Cloudinary | `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | `lib/cloudinary.js:7-9`; client-safe name only for public var |
| Hotel DB | `ROOM_MONGODB_URI` | Must resolve to database `bono_hotel` (`lib/hotel/config.js:48-76`); never reuse POS URI (`.env.example:24`) |
| Hotel auth | `HOTEL_SESSION_SECRET`, `HOTEL_ALLOWED_ORIGINS` | Both required by `assertHotelConfiguration` (`lib/hotel/config.js:188-219`); secret must differ from `AUTH_SECRET` and be ≥32 chars (`:87-113`; `lib/hotel/constants.js:25`) |
| Hotel provisioning | `HOTEL_MANAGER_EMAIL`, `HOTEL_MANAGER_NAME`, `HOTEL_MANAGER_PIN` | `scripts/provision-hotel-manager.mjs:42-44`; inherited names `HOTEL_PROVISION_MANAGER_PASSWORD`, `HOTEL_PROVISION_MANAGER_PIN`, `HOTEL_PROVISION_PIN` are refused by the guard (`tests/helpers/hotel-integration-guard.mjs:66-75`) |
| Other secrets / aliases | `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CAFEDB_URI` (legacy), `BONO_EXPORT_URI`, `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` (public by design) | `.env.example:5-21`; `lib/cloudinary.js:7-9`; `scripts/export-raw-collections.mjs:48` |
| Deployment / approval gates | `POS_INDEX_DEPLOY_APPROVAL`, `HOTEL_INDEX_DEPLOY_APPROVAL`, `INVENTORY_V2_INDEX_DEPLOY_APPROVAL`, `INVENTORY_V2_INDEX_DEPLOY_ENV`, `POS_AUTO_INDEXES`, `RECOVERY_SCAN_APPROVAL`, `PHASE3_MIGRATION_APPROVAL`, `PHASE3_MIGRATION_ENV`, `BONO_OPERATION_ENV`, `DRY_RUN`, `BASE_URL`, production markers `VERCEL_ENV`, `CONTEXT`, `DEPLOY_ENV`, `ENVIRONMENT`, `APP_ENV` | Approval references only; values never printed (`scripts/sync-indexes.js:56,67`; `scripts/hotel-deploy-indexes.mjs:70`; `scripts/inventory-v2-deploy-indexes.mjs:67`; `scripts/inventory-recovery-scan.mjs:266`; `scripts/migrate-phase3-canonical.js:44,89`) |
| Integration (opt-in) | `POS_PHASE25_INTEGRATION_TESTS`, `POS_PHASE25_TEST_TARGET_ACK`, `POS_PHASE25_TEST_MONGODB_URI`; `POS_PHASE23_*`; `HOTEL_INTEGRATION_TESTS`, `HOTEL_INDEX_DEPLOY_ENV`, `HOTEL_TEST_TARGET_ACK`, `HOTEL_TEST_MONGODB_URI`, `HOTEL_TEST_ALLOW_CLEANUP` | Exact ack strings and commands in §5.4 |
| Deploy/CI (when approved) | `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID` or deploy-hook token, notification webhook token | Provider secrets by name only |

### 5.3 Exact provisioning steps (PREPARED — NOT EXECUTED)

| Step | Action | Gate |
|---|---|---|
| P1 | Owner approves staging purpose, owner, cost, test window, and isolation boundaries | OWNER DECISION |
| P2 | Create isolated app deployment target with its own URL; no production alias | Owner/ops |
| P3 | Create staging POS replica set (integration tests require replica set on `127.0.0.1:27019` with phase-prefixed DB names); create staging Hotel standalone MongoDB on a non-default port with DB `bono_hotel` | Owner/DBA |
| P4 | Inject env vars by name (§5.2) from secret store; assert `HOTEL_SESSION_SECRET` ≠ `AUTH_SECRET` and that no value equals a production value | Ops |
| P5 | Prove isolation: from staging app, show production URIs are not configured/reachable; show POS and Hotel URIs resolve to different databases | Ops + verifier |
| P6 | Provision test-only identities: POS MANAGER/WAIER/CHEF/BARISTA/COOK etc. per station policy; Hotel MANAGER + RECEPTIONIST (`HOTEL_PROVISION_MANAGER_PIN` from owner, never committed) | Owner |
| P7 | Deploy the exact release-tag artifact to staging; run lint/test/build/artifact checks from §8 | CI |
| P8 | Apply approved index plans (§6) to staging only, with staging approval refs; capture `getIndexes()` baseline | DBA |
| P9 | Seed only disposable test data; record DB names for cleanup | Ops |
| P10 | Execute G-PAY-1 15 cases + §5.4 checklist; capture evidence | QA + ops |
| P11 | Rehearse rollback (previous tag + previous env set); verify `/api/health` and one read path | Ops |
| P12 | Cleanup only staging/disposable resources; preserve evidence and logs | Ops |

### 5.4 G0 preflight gates and G-PAY-1 case inventory

**G0 gates (all must be positively verified before any staging execution; `g-pay-1-staging-execution-checklist.md:37-56`):**

| Gate | Required evidence |
|---|---|
| G0-1 | Written owner approval naming the environment and approval reference |
| G0-2 | Dated attestation from the environment owner naming the staging URL/origin and deployment context; a responding URL is **not** evidence (authority note `:54`) |
| G0-3 | Dedicated replica set/DB, not production/Hotel/27017/27018; owner confirms no real data |
| G0-4 | Test-only MANAGER/CASHIER/WAITER identities |
| G0-5 | Approval for synthetic `PaymentInfo` create/deactivate/delete |
| G0-6 | Permission for synthetic order/payment writes and read-back |
| G0-7 | Approved structured-JSON log capture without secrets |
| G0-8 | Named cleanup owner and approved procedure |
| G0-9 | Owner decision on C1–C7 contract questions |
| G0-10 | Approved test window and change/ticket reference |

Stop rule at `:52`; read-only G-REC-1 pilot applicability at `:56`. **None are verified.**

**15 prepared GP1 cases (execution checklist numbering, `:85-491`, none executed):**

| ID | Focus |
|---|---|
| GP1-01 | CASH initial settlement → PAID, identity fields/timestamps |
| GP1-02 | TRANSFER initial settlement with active account → exact snapshot |
| GP1-03 | Same-method CASH retry immutability |
| GP1-04 | Different-method CASH retry: MANAGER 409 / CASHIER 403 / status path 200 |
| GP1-05 | Same-method TRANSFER retry immutability |
| GP1-06 | Different-method TRANSFER retry denial |
| GP1-07 | Retry after account deactivation preserves stored identity |
| GP1-08 | Retry after account deletion preserves stored identity |
| GP1-09 | New unpaid TRANSFER with missing/inactive/nonexistent account |
| GP1-10 | Legacy PAID with `paidAt:null` — no backfill |
| GP1-11 | Concurrent two-account race — single winner, unsnapshotted read checks |
| GP1-12 | WAITER submit / CASHIER confirm-reject flow |
| GP1-13 | Authorization matrix and no-mutation-on-denial |
| GP1-14 | Logger redaction probe for account-number key variants |
| GP1-15 | Staged-log scan for account numbers, PIN/token/secret/cookie/URI patterns |

**Numbering discrepancy (must reconcile before signing "15/15"):** `g-pay-1-staging-acceptance-report.md:117-353` uses a different GP1 numbering (9 cases: cash, transfer, snapshot integrity, same-method PAID retry, different-method PAID retry, legacy PAID, concurrency, redacted logs, static checks). Phase 14 does **not** assert that "G-PAY-1 15/15" is satisfied; it requires the owner/QA to map the two schemes and sign the result.

**Integration harness contracts (exact opt-in commands, prepared only):**
```powershell
# POS payment-immutability (replica set on 127.0.0.1:27019; DB prefix bono_pos_phase25_)
$env:POS_PHASE25_INTEGRATION_TESTS='1'
$env:POS_PHASE25_TEST_TARGET_ACK='I_CONFIRM_DISPOSABLE_POS_REPLICA_SET'
$env:POS_PHASE25_TEST_MONGODB_URI='mongodb://127.0.0.1:27019/bono_pos_phase25_<unique>?directConnection=true'
node --import ./tests/helpers/pos-phase25-register.mjs --test tests/integration/phase25-payment-immutability.integration.mjs

# POS Phase 2.3 transactions: POS_PHASE23_* with the same 27019 / prefix bono_pos_phase23_ contract
# Hotel (STANDALONE non-27017 only; replica sets rejected; DB exactly bono_hotel):
HOTEL_INTEGRATION_TESTS=1 HOTEL_INDEX_DEPLOY_ENV=disposable
HOTEL_TEST_TARGET_ACK=I_CONFIRM_DISPOSABLE_MONGODB
HOTEL_TEST_MONGODB_URI=mongodb://127.0.0.1:<non-27017>/bono_hotel
node --test tests/hotel-integration.test.mjs
```
Hotel cleanup is a separate manual step requiring `--confirm` **and** `HOTEL_TEST_ALLOW_CLEANUP=I_CONFIRM_DELETE_DISPOSABLE_MONGODB_DATA`; it deletes only allowlisted collections, never `dropDatabase`/`dropCollection`/`dropIndexes`/`syncIndexes`. **GAP to reconcile:** docs state a 120 s index wait (`docs/hotel-foundation.md:1002`) while the harness constant is 60,000 ms (`hotel-integration-harness.mjs:41`).

### 5.5 Execution checklist (aging)

| Area | Checklist (all require recorded evidence) |
|---|---|
| Auth / authorization | POS role PIN logins and station scoping; Manager vs station role boundaries; Hotel identity+PIN login; Manager/Receptionist route guards; wrong-role page redirect; session expiry/idle (Hotel 30 min) and absolute limits; CSRF/Origin on every mutation |
| Transactions | Order payment + inventory reconciliation separation (INV-FIN-7: no single transaction spans payment and settlement); lost-response retry idempotency; recovery-task reconciliation read-only path; no autonomous recovery writes |
| Indexes | Staging index deployment with approval refs; `getIndexes()` before/after; duplicate preflight empty; legacy conflicts handled only by approved separate change |
| Payment testing | Idempotency key reuse rejected/deduplicated; settled payment immutability; method/cash/bank transfer flows; Cloudinary brand/menu image path; payment-info behavior per B8 decision |
| Inventory tests | Stock deduction on order; duplicate movement prevention; reservations/locks; negative stock guards;Inventory V2 allocation/approval/challenge flow if enabled; audit evidence |
| Hotel room lifecycle | Room type → room → guest → reservation → check-in/stay → hotel payment → check-out; overlapping reservation rejection; room status transitions; report export |
| PIN change | Execute PIN-S01…S13 from §3 in staging |
| Reports | Manager/waiter/cashier reports; report-cache isolation between roles; PDF export; note F-22 time-boundary decision still open (not in scope to resolve here) |
| Cross-system isolation | Hotel data absent from POS queries and vice versa; Hotel session cookie not accepted by POS routes and vice versa; separate secrets; separate DBs |
| Failure scenarios | DB outage (readiness 503, liveness 200); rate-limit 429; PIN lockout; audit-write failure compensation; provider/Cloudinary outage; replayed CSRF/Origin |
| Rollback rehearsal | Redeploy previous tag, restore previous env set, verify health + read path, confirm no evidence deleted; record timings and sign-off |

**Prepared but not executed:** all 15 G-PAY-1 cases GP1-01…GP1-15 (`g-pay-1-staging-execution-checklist.md:37-56`) remain "PREPARED — NOT EXECUTED"; G0-1…G0-10 owner gates unresolved (`staging-readiness-report.md:3-9,86-128,210-219`). Staging URL/DB/credentials: **NOT VERIFIED**.

---

## 6. B3 — Index deployment procedure

**Status: INVENTORY AND PROCEDURE PREPARED; DEPLOYMENT BLOCKED; NO PRODUCTION CONNECTION MADE.**

### 6.1 Inventory (schema declarations, not deployed state)

| System | Scope | Declarations |
|---|---|---|
| POS | 9 collections via `scripts/sync-indexes.js:115-125` | `Order.js:28,41,57,88,90,163-174,182,188,199,207,209,225-227,239,243,246,249-254`; `Staff.js:69-75`; `Category.js:20`; `MenuItem.js:101`; `InventoryAudit.js:62-65`; `InventoryItem.js:49-50`; `InventoryReservation.js:135-147,181,183`; `StockMovement.js:12,64,67,74-83`; `PaymentInfo` has **no** schema indexes (`:131-133`). Additional: `ExtraItem.js:27`, `Recipe.js:25,35`, `Supplier.js:7`, `SystemAuth.js:43`, `Session.js:52-53,78-82,133-143` (manual procedure) |
| POS recovery | separate schemas | `RecoveryTask.js:458-475` (IDX-TSK-01…06); `RecoveryEvent.js:235-243` (IDX-EVT-01…06); `RecoveryOperationHistory:571` |
| Inventory V2 | 7 collections, 16 named indexes | `lib/inventory-v2/server/indexPlan.js:59-238`; notable: `challenge_id_unique`, `challenge_expires_ttl` (`expireAfterSeconds:0`), `challenge_open_lookup` **non-unique partial**; **`{approvalGroupId,stage}` unique on challenges is FORBIDDEN** (`:20-27`, validation `:434-448`) |
| Hotel | 10 collections, separate `bono_hotel` DB | `guest.js:82-84`; `hotelAuditLog.js:76-78`; `hotelSession.js:84-86` (unique tokenHash + TTL); `hotelPayment.js:127-132` (unique paymentNumber, **unique `(stayId,idempotencyKey)`**); `hotelUser.js:107-118`; `reservation.js:244-253`; `room.js:114,137-140`; `roomBookingLock.js:39` TTL; `roomType.js:61,71-72`; `stay.js:240-244` |

All are **declarations only**: POS auto-index work is gated (`lib/mongodb.js:50-108`; production off unless `POS_AUTO_INDEXES=1`), Hotel sets `autoIndex:false`/`autoCreate:false` (`lib/hotel/db/connection.js:17-19,29-34`). Live deployed index state is **NOT VERIFIED** (F-08).

### 6.2 Unique-index conflicts and data-integrity concerns

1. **Legacy `StockMovement (refOrderId, reason)` unique index** rejects multi-ingredient orders; the new unique partial `(refOrderId,reason,item)` cannot replace it additively. Classified `SUPERSEDED_PREFIX` (`lib/indexDeploymentPlan.js:95-101,129-143`). Removal requires a separate owner/DBA-window `dropIndex`, `create-before-drop`, second confirmation `DROP-OBSOLETE-STOCKMOVEMENT-INDEX`, and must never be recreated (`phase-2-5-safety-and-deployment-gates.md:342-347`).
2. **`NAME_TAKEN` / `IndexOptionsConflict` (85/86)** — same name, different key/options → fail closed (`indexDeploymentPlan.js:113-127,149-161`). Historical resolved case: redundant `Session.expiresAt` field index removed in favor of TTL (`Session.js:78-82`).
3. **Redundant overlap** (`waiterId_1` + `waiterId_1_createdAt_-1`, `item_1` + `item_1_createdAt_-1`) — write cost, not functional conflict; do not create manually.
4. **Hotel `(stayId,idempotencyKey)` unique** depends on the Hotel script running — unverified.
5. **GAP:** Inventory V2 has no documented duplicate-data preflight queries, only a `getIndexes()` probe (`wp-04-04-index-and-query-proposal.md:129-135`); G-IDX-1 remains unsigned (`:12,26`).

### 6.3 Scripts, flags, and exact commands (PROPOSED)

| System | Script | Gates | Commands |
|---|---|---|---|
| POS | `scripts/sync-indexes.js` | `--dry-run` offline; `--confirm` required for any write; production additionally `--allow-production` + non-empty `POS_INDEX_DEPLOY_APPROVAL`; requires `MONGODB_URI` for writes; additive `createIndexes()` only (`:195-198`) | `node scripts/sync-indexes.js --dry-run` **(VERIFIED offline: no connection, nothing created)**; `node --env-file=.env.local scripts/sync-indexes.js --confirm`; production: add `--allow-production` with approval env set |
| Hotel | `scripts/hotel-deploy-indexes.mjs` | `--confirm`; production `--allow-production` + `HOTEL_INDEX_DEPLOY_APPROVAL`; `HOTEL_INDEX_DEPLOY_ENV` marker; asserts DB `bono_hotel` (`:173-200,474-478`); preflight/postflight built in (`:483-530`); **no `--dry-run`** | `node --env-file=.env.local scripts/hotel-deploy-indexes.mjs --confirm` (+ `--allow-production` in prod) |
| Inventory V2 | `scripts/inventory-v2-deploy-indexes.mjs` | `--confirm`; production `--allow-production` + `INVENTORY_V2_INDEX_DEPLOY_APPROVAL`; marker `INVENTORY_V2_INDEX_DEPLOY_ENV`; fail-closed on mismatch (`:481-490`) | `node --env-file=.env.local scripts/inventory-v2-deploy-indexes.mjs --confirm` (+ `--allow-production` in prod) |
| POS sessions | `docs/auth-session-index-deployment.md` | manual, prepared-only; destructive drop requires approval (`:70-78`) | explicit `createIndex` statements (`:59-64`) |

### 6.4 Preflight, dry-run, verification commands and expected evidence

**Preflight (approved disposable/staging target only, never production):**
```js
// phase-2-4-production-database-checklist.md:311-330 — both must return EMPTY
db.inventoryreservations.aggregate([{ $group: { _id: "$orderId", count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }]);
db.stockmovements.aggregate([{ $match: { reason: "SaleDeduction", refOrderId: { $type: "objectId" } } }, { $group: { _id: { order: "$refOrderId", item: "$item" }, count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }]);
```

**Verification evidence to capture:**
- POS: before/after `db.<collection>.getIndexes()` for all 9 collections; assert `stockmovements.refOrderId_1_reason_1_item_1` keys `{refOrderId:1,reason:1,item:1}` unique with partial `{refOrderId:{$type:"objectId"}}`; `idempotencyKey_1` unique partial; `inventoryreservations.orderId_1` unique; `paymentinfos` no indexes; diff shows only approved additions; post-deploy multi-item sale succeeds and duplicates rejected.
- Hotel: confirm connected DB `bono_hotel`; before/after `getIndexes()` for all 10 collections; assert exact keys/options including unique `stayId_1_idempotencyKey_1`, TTL on `hotelSession.expiresAt` and `roomBookingLock.expiresAt`, partial on `hotelUser.username`.
- Inventory V2: script auto-verifies 16 indexes across 7 collections; assert `challenge_expires_ttl` TTL=0, `challenge_open_lookup` non-unique partial, and **no** unique `{approvalGroupId,stage}` on challenges.
- All: capture script output, approval ticket refs, timestamps, and verifier signature. Never `syncIndexes()`/`dropIndexes()`; no destructive operation.

**No production connection, no `--confirm`, and no index change was made. BLOCKED.**

---

## 7. B4 — Observability implementation plan

**Status: PLAN FINALIZED; SAFE LOCAL CODE CHANGES IDENTIFIED BUT NOT APPLIED; EXTERNAL MONITORING BLOCKED.**

### 7.1 Current surface (SOURCE-INSPECTED)

- Health: `app/api/health/route.js:1-54` — readiness with env gate then DB connect; `?live=1|true|yes` liveness, no DB; 200/503; `no-store`. Contract `lib/health.js:8-23` forbids host/URI/error/stack/env. Tests `tests/health-endpoint.test.mjs:20-107`.
- Logging: `lib/operationalLogger.js:17-37` redaction terms (`pin,password,passwd,secret,token,credential,authorization,cookie,sessionid,apikey,connectionstring,mongodburi,accountnumber,accountno,acctno,iban`), normalization `:39-45`, bounds `:47-87`, one JSON line `:93-114`, **no shipping** (`:9-10`).
- Errors: `lib/withApi.js:37-63` logs raw `errorMessage` (F-19 gap at `:47,59`); `app/global-error.js:20-23` renders raw `error?.message`.
- Hotel audit: `lib/hotel/audit.js:21-64,105-142,160-218`; fallback uses unstructured `console.warn` (`:210-218`).
- Extension point: `instrumentation.js:9-20` (tracing/metrics) currently only warms MongoDB.
- Headers: `next.config.mjs:28-42` — nosniff, DENY, referrer, permissions, prod HSTS; **no CSP** (F-20).

### 7.2 Health monitoring and uptime

Keep both endpoints unchanged. Configure external uptime monitor with liveness (`/api/health?live=1`) and readiness (`/api/health`). **Proposed, not approved:** liveness every 30 s, readiness every 60 s, ≥2 regions, alert after 3 consecutive failures; availability target 99.9% liveness / 99.5% readiness. Provider-side config **NOT VERIFIED** / outside repo.

### 7.3 Alert thresholds (PROPOSED — require owner/ops approval before paging)

| Signal | Threshold | Severity | Source |
|---|---|---|---|
| Liveness non-200 | 3 consecutive checks | P1 page | external uptime |
| Readiness 503 | 2 consecutive, sustained 2 min | P1 page | external uptime |
| `api_db_error` | >5/min | P2 | `withApi.js:45` |
| `api_unhandled_error` | >10/min or >3× baseline | P2 | `withApi.js:57` |
| `pos_index_provision_failed` | any occurrence | P3 ticket | `lib/mongodb.js:102` |
| `TRANSACTIONS_UNAVAILABLE` | >1% over 5 min | P1 | **NOT IMPLEMENTED** — needs instrumentation |
| Pool saturation / server-selection failures | ≥90% of `maxPoolSize:10` for 2 min / >3/min | P2 | **NOT IMPLEMENTED** |
| Backup failure; drill age >90 d; index drift; PAID-without-deduction; duplicate movement; negative stock | backup failure P1; drill age P3; others P2 | — | **NOT IMPLEMENTED**; required signals at `phase-2-4...checklist.md:546-559` |

### 7.4 Log shipping, redaction, error tracking

- Ship one JSON line per `logEvent` from all instances; index by `event`, `level`, route.
- Re-apply the `SENSITIVE_TERMS` redaction contract at the sink (defense in depth): key normalization folds camel/snake/kebab; free-text regex for MongoDB URIs and Bearer/Basic tokens; account numbers redacted. **Proposed extension:** add `errormessage`, `message`, `stack` to the local redaction list and stop emitting raw `errorMessage` from `withApi` (F-19).
- **Proposed retention:** 30 days hot, 90 days cold, aligned to approved backup/PITR policy; confirm no PII in archived lines.
- Error tracking fields: `event`, `level`, `errorName`, stable `errorCode`, `ts`, `service:"bono-pos"`, non-sensitive path/method, `requestId` where available. **Never raw messages/stacks.** Group by `event + errorName + errorCode + route`.

### 7.5 Incident response and on-call

First-response runbook (to be published and owner-approved): acknowledge P1 in 15 min → classify with liveness vs readiness and event names → for DB incidents check connectivity/topology/pool, never run index scripts → read-only recovery signals only (no autonomous writes, OD-38/OD-39) → mitigate/redeploy per rollback runbook, capture evidence → post-incident review and threshold update. On-call: named primary/secondary with escalation to owner/DBA; P1 page / P2 ticket / P3 next business day. **No rotation or runbook exists today** (F-09).

### 7.6 Safe local changes (identified, NOT applied in Phase 14)

`lib/operationalLogger.js:17-45` (extend redaction terms); `lib/withApi.js:45-62` (stable codes only); `app/global-error.js:20-23` (generic message); `lib/hotel/audit.js:210-218` (route fallback through `logEvent`); `instrumentation.js:9-20` (process-level resilience logging, no exporter); tests `tests/operational-logger.test.mjs` / `tests/health-endpoint.test.mjs` updated accordingly; `next.config.mjs:28-42` report-only CSP **only after** §13 directives approved.

### 7.7 Owner-approved infrastructure required (BLOCKED)

Uptime monitor, log drain/shipper with retention and redaction verification, error tracker, alert rules/severity routing, named on-call rotation, published runbook, CSP report sink. All NOT VERIFIED and outside repository scope.

---

## 8. B5 — CI configuration proposal

**Status: PROPOSED — no workflow files created; no external CI infrastructure or remote setting changed.**

### 8.1 Current state (VERIFIED / SOURCE-INSPECTED)

- `package.json:5-14`: only `dev`, `build`, `start`, `lint`, `db:sync*`, `db:seed-auth`, `db:reset-auth`; **no test/ci script**.
- `netlify.toml:1-6`: build only, unpinned plugin, no staging context.
- `.github/` absent; no CI config files found (`.gitlab-ci.yml`, Jenkinsfile, etc.).
- `package-lock.json` v3 present but modified in working tree.
- Local toolchain: Node `v24.14.0`, npm `11.9.0`; Next requires `node >=20.9.0` (`node_modules/next/package.json:136-138`).

### 8.2 Proposed workflow (design only)

**Stage A — every PR/push to protected branch (runner Linux, pinned Node):**

| Job | Command / action |
|---|---|
| `ci-pin-check` | Assert `node --version` = `v24.14.0`, `npm --version` = `11.9.0`; assert `.nvmrc`, `engines`, lockfile root and `NODE_VERSION` agree (§10) |
| `ci-install` | `npm ci` (lockfile v3); cache `~/.npm` by `hashFiles('package-lock.json')` |
| `ci-lint` | `npm run lint` — fail on errors; warnings tracked |
| `ci-db-free-tests` | `node --test --test-reporter=spec "tests/*.test.mjs"`; upload spec/TAP report on success and failure |
| `ci-build-blanked-db` | `MONGODB_URI="" CAFEDB_URI="" ROOM_MONGODB_URI="" npm run build` (equivalent env blanking per platform) — prove no DB connection |
| `ci-artifact-verify` | SHA-256 of `.next/**` and `package-lock.json`; manifest with git SHA/tag, Node/npm, resolved Next/React versions; assert pinned plugin version (BLOCKED until §10 evidence); scan for secret-value patterns and secret **names**; optional provenance attestation after registry approval |
| `ci-smoke` | Start built server; assert Phase 12 matrix: `/` 200, `/pos` 200, `/room` 200, `/menu` 200, `/hotel/reception` 200, `/api/health?live=1` 200, `/api/health` 200, `/api/orders` unauth 401, `/manifest.json` 200, security headers present; no CSP until B10. `fail-fast:false` |

**Stage B — manual/scheduled, disposable DB only:** `integ-pos-disposable` (replica set `127.0.0.1:27019`, `POS_PHASE25_INTEGRATION_TESTS=1`, `POS_PHASE25_TEST_TARGET_ACK=I_CONFIRM_DISPOSABLE_POS_REPLICA_SET`, phase-prefixed DB URI; loader `tests/helpers/pos-phase25-register.mjs`; Phase 23 analogue with `POS_PHASE23_*`); `integ-hotel-disposable` (`HOTEL_INTEGRATION_TESTS=1`, `HOTEL_INDEX_DEPLOY_ENV=disposable`, `HOTEL_TEST_TARGET_ACK=I_CONFIRM_DISPOSABLE_MONGODB`, standalone non-27017 loopback, DB `bono_hotel`; cleanup only with `HOTEL_TEST_ALLOW_CLEANUP=I_CONFIRM_DELETE_DISPOSABLE_MONGODB_DATA`). Phase 12 recorded 32/32 integration passes; not re-run in Phase 14 (no DB-related source changes).

**Stage C — promotion (owner/ops):** tag exact tested artifact → deploy to staging → G-PAY-1 15/15 → rollback rehearsal → promote same tag. Rollback must not delete evidence.

### 8.3 Secrets (names only), branch protection, failure reporting

Secrets by name: `MONGODB_URI`, `CAFEDB_URI`, `AUTH_SECRET`, `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `ALLOWED_ORIGINS`, `ROOM_MONGODB_URI`, `HOTEL_SESSION_SECRET`, `HOTEL_ALLOWED_ORIGINS`, `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID` or deploy-hook token, notification webhook token. Build/smoke jobs receive **empty** DB URI values, not secrets.

Branch protections (proposed): require all Stage A checks; required review; no direct pushes to `main`; up-to-date branches; signed commits if available. Failure reporting: job-summary artifact, test-report upload on failure, provider notifications + webhook to team channel, no secret values in logs (redaction conventions from `lib/operationalLogger.js`).

**Blockers:** CI runner + secret store, ephemeral MongoDB, deploy hook/token, protected branch checks, artifact registry, staging rehearsal sign-off — all require owner approval. B6 (§9 grouping + reviewed commits + tag) precedes meaningful CI.

---

## 9. B6 — Exact review-based commit grouping plan

**Status: PROPOSAL ONLY — no git write command performed.**

### 9.1 Preservation verification (VERIFIED this phase)

| Check | Result |
|---|---|
| `git status --porcelain` | 265 collapsed entries: 88 modified, 3 deleted, 174 untracked |
| `git status --porcelain -uall` | **513 expanded entries: 88 ` M`, 3 ` D`, 422 `??`** |
| `git diff --cached --name-only` | **0 entries** — index unchanged |
| Three EXTERNAL deletions | ` D app/api/external-items/route.js`; ` D app/api/external-sales/route.js`; ` D lib/models/ExternalItemRequest.js` — still deleted, absent on disk, tracked in index |
| `C:\bonosm` | Not accessed or modified |
| Git write commands | None (no stage/commit/push/stash/reset/clean/checkout/revert/discard) |

### 9.2 Proposed groups (exact counts by path-heuristic classification)

| Group | Entries | Representative paths |
|---|---|---|
| G1 — POS inventory/order/payment/menu | **132** | `app/api/inventory/**`, `app/api/orders/**`, `app/api/menu/route.js`, `app/api/recipes/**`, `lib/orderService.js`, `lib/inventoryDeductionService.js`, `app/components/InventoryUI.jsx`, `CashierUI.jsx`, `WaiterUI.js`, `KitchenDisplay.js`, `app/pos/`, `app/jebena/` |
| G2 — POS auth/staff | **21** | `app/api/auth/verify-pin/route.js`, `app/api/manager/staff/route.js`, `app/api/staff/route.js`, `app/components/{ManagerSidebar,PinGuard,PinLoginModal,StaffManagement}`, `lib/config/security.js`, `lib/staffService.js`, `lib/models/{Session,Staff}.js`, `tests/auth-production-hardening.test.mjs` |
| G3 — Hotel subsystem | **157** | `app/api/hotel/**`, `app/hotel/**`, `app/components/hotel/**`, `lib/hotel/**`, `app/room/`, `tests/hotel-*.test.mjs`, `scripts/{provision-hotel-manager,hotel-deploy-indexes}.*`, `docs/hotel-*` — includes the PIN fix and all new PIN tests; keep separate from POS auth |
| G4a — Docs | included in G4 totals | `docs/production-readiness/**` (71 collapsed entries in docs dir), phase reports, decision docs |
| G4b — Tests | included in G4 totals | `tests/integration/**` (16), `tests/helpers/**` (11), `tests/fixtures/**` (3) plus root-level tests |
| G4c — Config/infra | included in G4 totals | `.env.example`, `ARCHITECTURE.md`, `eslint.config.mjs`, `next.config.mjs`, `package.json`, `package-lock.json`, `proxy.js`, `app/layout.js`, `app/fonts/**` |
| G4d — Recovery / Inventory V2 / offline export | **79** | `lib/inventory-v2/**` (17), `lib/recovery/**` (10), `lib/offlineExport/**` (5), `scripts/{inventory-v2-deploy-indexes,inventory-recovery-scan}.mjs`, `wp-04-*` evidence and docs |
| G4 — General (remaining) | **121** | `lib/mongodb.js`, `lib/policy.js`, theme/language components, `app/login/page.js`, `app/page.js`, misc docs/tests not matched above |
| G5 — Retired EXTERNAL deletions | **3** | the three paths in §9.1 — commit as deletions together, never restore |

Counts sum to 513. They are exact counts of entries assigned by path heuristic; **cross-cutting files may need to travel with the group that first depends on them** — owner review of each diff is required. This is a review plan only: no staging, commit, push, stash, reset, clean, checkout, revert, or discard.

---

## 10. B7 — Toolchain pins with compatibility evidence

**Status: exact values established; evidence-supported pins proposed; plugin pin BLOCKED.**

### 10.1 Current values (VERIFIED / SOURCE-INSPECTED)

| Setting | Current value | Evidence |
|---|---|---|
| Node | `v24.14.0` | local shell; used successfully for full suite, lint, build (Phase 12, 13) |
| npm | `11.9.0` | local shell |
| `package.json#engines` | absent | `package.json:1-31` |
| `package-lock.json#packages[""]#engines` | absent; lockfileVersion 3 | `package-lock.json:4,7-26` |
| `.nvmrc` / `.node-version` / `.tool-versions` / `.npmrc` | all absent | local file checks |
| `next`, `eslint-config-next` | `16.3.1` exact | `package.json:19,28` |
| `react`, `react-dom` | `19.2.8` exact | `package.json:21-22` |
| Netlify plugin | `@netlify/plugin-nextjs`, **no version** | `netlify.toml:5-6` |
| `NODE_VERSION` in `netlify.toml` | absent | `netlify.toml:1-6` |
| Next engine requirement | `node >=20.9.0` | `node_modules/next/package.json:136-138` |

### 10.2 Plugin version investigation (exhaustive)

Every hit for `plugin-nextjs`: `netlify.toml:6` (no version); Phase 12 (`:6,236,241,479`) and Phase 13 (`:309,315,317`) declare it unpinned; architecture audit (`:102,466`) same. **Zero matches** in `package.json`, `package-lock.json` (0 `@netlify` occurrences), `README.md`, build logs, or `.netlify/` state. `node_modules/@netlify/plugin-nextjs` is **not installed**. Read-only git history: `netlify.toml` has a single commit (`dc6e88a`) where the plugin line was added without a version and never changed. **Conclusion: no evidence of the actual plugin version anywhere. BLOCKED — do not guess.**

### 10.3 Proposed exact pins

| Target | Proposed value | Status |
|---|---|---|
| `package.json#engines` | `{ "node": "24.14.0", "npm": "11.9.0" }` | PROPOSED — empirically compatible (2,554 tests, lint, build all pass on this toolchain) |
| `.nvmrc` (new file) | `24.14.0` | PROPOSED |
| `netlify.toml [build.environment]` | `NODE_VERSION = "24.14.0"` | PROPOSED — closes unverified Netlify runtime Node version |
| `dependencies` | keep `next 16.3.1`, `eslint-config-next 16.3.1`, `react/react-dom 19.2.8` exact; keep lockfileVersion 3; enforce `npm ci` | PROPOSED |
| `@netlify/plugin-nextjs` | exact version from owner/Netlify build logs → add to `devDependencies` + regenerate lockfile | **BLOCKED — OWNER DECISION / information required** |
| Caret ranges → exact resolved versions | optional; changes dependency specs | NOT PROPOSED without sign-off |

### 10.4 Source-contract test approach (PROPOSED, not created)

Add a DB-free `tests/*.test.mjs` that reads files as text and asserts: `engines.node/npm` exact; lockfile v3 and root engines match; `.nvmrc` trimmed value; `netlify.toml` `NODE_VERSION` and plugin line with owner-supplied exact version; `package.json#devDependencies` plugin pin and matching lockfile entry; Next/React exact versions. Steps for the plugin will **fail closed until the owner supplies the version** — intended. After pinning: re-run `node --version`, `npm --version`, the contract test, and the full DB-free suite. No `npm ci`/`npm install` or dependency change was performed.

---

## 11. B8 — Decision memo: public bank-account visibility

**Status: OWNER DECISION — no behavior changed.**

| Field | Detail |
|---|---|
| Current behavior (SOURCE-INSPECTED) | `app/api/payment-info/route.js:10-20` serializes full `bankName`, `ownerName`, `accountNumber`, `isActive`; `GET` `:23-43` has no `requireAuth`, only rate limiting, and queries all records without an active filter; writes require MANAGER (`:47,83,121`). `next.config.mjs:74-79` sets `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`. `/menu` (`app/menu/page.js:261,263,940-979`) copies the full account number. |
| Risk | Anonymous enumeration of all bank accounts and owner names, including inactive records, amplified by public CDN caching. HIGH — F-13 (`phase-12...report.md:245-255`). |
| Option A | **Keep public visibility + cache correction + explicit risk acceptance.** Remove the public cache header (or set no-store) and record a signed acceptance that full account data is intended public business information. Fully reversible config-only change; customer-facing copy flow unchanged. |
| Option B | **Mask for unauthenticated users.** Return bank + last 4 to anonymous callers; full values only to authenticated staff; update `/menu` copy flow accordingly. Reduces exposure while preserving self-service payment. Requires API serialization + UI change and tests. |
| Option C | **Require authentication.** Add `requireAuth` to GET and rework `/menu` for signed-in staff only. Strongest control; largest UX change. |
| Recommendation | Option B (or C if the business accepts sign-in for payment details). Option A acceptable only with written risk acceptance and cache correction. |
| Owner decision required | Choose A/B/C and sign. Note C-3 in `phase-2-4-owner-decisions.md:372,392,399,654` covers DELETE/archive policy, **not** public GET visibility. |
| Implementation after approval | A: `next.config.mjs:74-79` + signed memo; B: serializer + `/menu` UI + tests; C: route guard + `/menu` UI + tests. Commit in G1/G4c. No change made now. |

---

## 12. B9 — Decision memo: Manager PIN step-up (POS)

**Status: OWNER DECISION — no policy changed.**

| Field | Detail |
|---|---|
| Operations requiring step-up today | `POST /api/manager/settings/clear-orders` requires the requesting MANAGER's own Staff PIN (`currentManagerPin`) plus `confirm:"CLEAR-ORDERS"` (`route.js:22-25,123-125,144-150`; tests `clear-orders-auth.test.mjs:60`, `clear-orders-safety.test.mjs:22-25`, `clear-orders-production-guard.test.mjs:298-301`). |
| Operations **not** requiring step-up | `POST /api/manager/staff` PIN change: `currentManagerPin` optional (`route.js:210-212,232-234`), verified only inside `if (currentManagerPin)` (`:258-266`); authorization otherwise cookie-only (`:247-254`). UI `StaffManagement.jsx:381-399` sends it only if non-blank (`:384,399`). Self-service PIN change already requires the caller's current PIN (`app/api/auth/change-pin/route.js:41-53`) — no additional step-up needed. |
| Attack scenarios | (1) Stolen/lent Manager session cookie resets any staff/station PIN without knowing the Manager PIN; (2) same-session attacker changes a waiter PIN then uses it at a station; (3) inconsistency: destructive `clear-orders` demands step-up but ordinary PIN change does not. Phase 12 F-15 (`phase-12...report.md:269-279`), R-06 (`phase-2-2-deferred-risks.md:31,126-136`). |
| Workflow impact | Managers must enter their own PIN on every staff PIN reset; the UI already has the field (`pinForm.currentManagerPin`) and resets after each operation (`:408`), so change is small. Risk: extra friction during busy shifts; mitigate with the existing `clear-orders` precedent and clear labels. Waiter/manager login flows themselves are unchanged. |
| Recommended implementation | Require `currentManagerPin` on every Manager-initiated PIN change; reject missing/wrong PIN before any write; accept the tab credential via `requireAuth` instead of cookie-only; make UI field mandatory; add regression tests. Keep self-service change unchanged. |
| Test plan | Route tests: missing PIN → 400/422, wrong PIN → 401, correct PIN → 200; UI test: submit disabled until PIN present; integration: Manager session + wrong PIN cannot change target; confirm `STAFF_PIN_RESET`-equivalent audit; verify no station PIN changed on rejection. |
| Scope guard | The separate Hotel manager reset (`app/api/hotel/staff/[id]/pin/route.js:23-113`) already requires `pin`/`confirmPin`, Receptionist-only targets, full revocation with compensating restore, and audit; it is **not** the subject of B9. |
| Owner decision | "Mandatory Manager step-up for PIN changes — yes or no?" (`phase-2-2-deferred-risks.md:267`); R-06 remains DEFERRED. No change made now. |

---

## 13. B10 — Decision memo: report-only CSP directive set

**Status: PROPOSED DIRECTIVES — NOT ENFORCED, NOT APPLIED.**

### 13.1 External resources currently used (SOURCE-INSPECTED)

| Resource | Evidence / CSP implication |
|---|---|
| Geist font | Self-hosted via `next/font/local` from `app/fonts/geist-latin.woff2` (`app/layout.js:15-20,53`) → `font-src 'self' data:` sufficient; no external font CDN |
| Cloudinary images | Server returns `secure_url` (`lib/cloudinary.js:21-66`); client renders images → `img-src 'self' https://res.cloudinary.com data: blob:` |
| Inline theme script | `app/layout.js:58` `<script dangerouslySetInnerHTML={{__html: THEME_INIT_SCRIPT}} />` → needs `script-src 'unsafe-inline'` (or hash/nonce in a later hardening step) |
| Inline styles | ~30 `style={{...}}` occurrences across `app/**` → `style-src 'self' 'unsafe-inline'` initially |
| Service worker | `public/sw.js` self-unregisters; no remote script; served same-origin |
| Other external URLs | None found in app code (only documentation/example URLs) |
| Next.js runtime | Requires inline hydration/bootstrap scripts and same-origin fetch/SSE (`/api/events`); `connect-src 'self'` covers SSE and all POS/Hotel APIs |
| Netlify | No provider-specific scripts or inline snippets found; deploy-time headers only; Netlify analytics, if enabled later, would require an external `script-src` entry and owner approval |

### 13.2 Proposed report-only directive set (observation only)

```
Content-Security-Policy-Report-Only:
  default-src 'self';
  base-uri 'self';
  object-src 'none';
  frame-ancestors 'none';
  form-action 'self';
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline';
  img-src 'self' https://res.cloudinary.com data: blob:;
  font-src 'self' data:;
  connect-src 'self';
  media-src 'self';
  worker-src 'self' blob:;
  manifest-src 'self'
```

No `report-uri`/`report-to` until an owner-approved report sink exists. No `upgrade-insecure-requests` initially (would affect local/staging HTTP). `'unsafe-inline'` is a deliberate report-only baseline; nonce/hash migration is a later hardening step.

### 13.3 Expected violations and observation plan

Expected violations: the inline theme script and Next.js inline hydration scripts if `script-src` is tightened; inline `style` attributes; any Cloudinary host variant not covered; `blob:` PDF/report URLs; Service Worker scope if `worker-src` differs. Observation: deploy report-only to staging first, collect browser console reports and (once approved) sink reports; classify by directive and source; fix legitimate violations (move inline styles to classes, hash the theme script); re-observe for a full business cycle including POS stations and Hotel portals.

### 13.4 Enforce transition criteria (OWNER DECISION)

1. Owner approves exact directive set and a report sink.
2. ≥2 weeks of staging observation with no unresolved violation affecting POS or Hotel flows.
3. All inline script/style exceptions either justified and documented or removed.
4. Netlify/Next provider requirements re-verified at the pinned Node/plugin versions (§10).
5. Rollback tested (remove header) before enforcement.
6. Eng signs off; then flip from `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in `next.config.mjs:28-42` in a staged rollout.

**No CSP header was added or enforced.**

---

## 14. Preservation and safety statement

- No deployment, no production DB, no migrations/backfills, no production index changes, no backup/restore operations, no production credentials, no secrets exposed.
- No git state changes: no stage, commit, push, stash, reset, clean, checkout, revert, or discard.
- All 513 working-tree entries preserved; three EXTERNAL deletions intact; `C:\bonosm` untouched.
- Business policies, inventory policies, order/payment architecture, and POS/Hotel auth separation unchanged.
- No dependency installation or toolchain change performed.

---

## 15. Exact owner approvals required

| # | Approval | Section |
|---|---|---|
| 1 | Accept PIN fix staging results (PIN-S01…S13) before release | §3 |
| 2 | Attach/sign prior backup policy record; approve mechanism, retention configuration, PITR support decision, and restore-drill window/verifier | §4 |
| 3 | Approve staging provisioning (app URL, POS replica set, Hotel standalone DB), test identities, isolation evidence, test window | §5 |
| 4 | Approve index deployment targets, windows, approval refs, and separate legacy `StockMovement` index removal | §6 |
| 5 | Approve alert thresholds, SLO targets, log retention, on-call rotation, incident runbook, and log drain/error tracker sink | §7 |
| 6 | Approve CI runner, secret store, ephemeral Mongo, deploy hooks, branch protections, artifact registry | §8 |
| 7 | Review and commit the proposed groups; preserve EXTERNAL deletions; tag release | §9 |
| 8 | Provide exact Netlify plugin version and sign Node/npm pins | §10 |
| 9 | Choose B8 option A/B/C and sign (accept risk if A) | §11 |
| 10 | Choose B9 mandatory step-up yes/no and approve test plan | §12 |
| 11 | Approve CSP directive set, report sink, observation window, enforce transition | §13 |
| 12 | Approve F-22 canonical revenue date (separate financial-policy decision, carried from Phase 12) | Baseline |

---

## 16. Remaining deployment blockers

| Blocker | Phase 14 status |
|---|---|
| PIN fix acceptance | Candidate — staging checklist not executed |
| B1 staging | Provisioning prepared; infrastructure NOT VERIFIED / BLOCKED |
| B2 backup/recovery | Policy reconciled; mechanism/config/drill evidence missing — BLOCKED |
| B3 indexes | Inventory + dry-run VERIFIED; deployment not approved — BLOCKED |
| B4 observability | Plan finalized; external monitoring/on-call missing — BLOCKED |
| B5 CI | Proposal complete; runner/provider/remote settings blocked — BLOCKED |
| B6 reproducible artifact | Working tree uncommitted; grouping proposed only — BLOCKED |
| B7 toolchain | Node pins proposed; plugin version BLOCKED |
| B8/B9/B10 | Owner decisions pending — OWNER DECISION |
| Carried Phase 12 risks | F-14 SSE identifiers, F-16 rate limiting, F-17 POS idle, F-18 POS CSRF, F-19 logs, F-21 order numbers, F-22 revenue date — unchanged, not silently resolved |

Phase 12 rule stands: B1–B7 must close; B8–B10 may be explicitly risk-accepted in writing but not silently ignored.

---

## 17. Evidence, tests, and files changed in Phase 14

### 17.1 Evidence and verification performed

| Item | Result | Label |
|---|---|---|
| Working-tree preservation | 265 collapsed / 513 expanded entries, 0 staged, 3 EXTERNAL deletions intact | VERIFIED |
| PIN patch review | `HotelChangePinModal.jsx:9,18,29-38,74-88` read and verified | SOURCE-INSPECTED |
| Local PIN test evidence reviewed | 13 + 13 + 4 tests (Phase 13 results) | VERIFIED (prior phase) |
| Full DB-free suite | 2,554 tests / 417 suites / 0 fail (Phase 13, unchanged source) | VERIFIED (prior phase) |
| Lint / build | 0 errors / 3 warnings; build success (Phase 13, unchanged source) | VERIFIED (prior phase) |
| Index dry-run | `node scripts/sync-indexes.js --dry-run` — offline, no connection, nothing created (Phase 13 and Phase 14 research) | VERIFIED |
| Health/logger focused tests | 20/20 pass (Phase 13) | VERIFIED (prior phase) |
| Toolchain | Node v24.14.0 / npm 11.9.0; Next engine ≥20.9.0; zero plugin-version evidence | VERIFIED |
| External monitoring/staging/provider state | none available | NOT VERIFIED |

**No tests were re-run in Phase 14 because no source file changed in Phase 14.** All cited results come from Phase 13 verification of the same source.

### 17.2 Files changed in Phase 14

**Created:** `docs/production-readiness/phase-14-release-preparation-report.md` (this document).

**Modified:** none. No production code, config, test, or policy file was changed in Phase 14. No dependency, lockfile, or toolchain file was changed. No git state changed. `C:\bonosm` not accessed.

---

## 18. Final decision

**NOT READY FOR DEPLOYMENT.** Phase 14 contains no deployment action. It delivers a staging-acceptance checklist for the PIN candidate, a reconciliation of owner-approved backup policy against missing implementation/evidence, isolated staging architecture and provisioning steps, index/monitoring/CI plans, exact commit grouping, toolchain pins with evidence, and three owner decision memos. All provisioning, deployment, backup/restore, index deployment, external monitoring, CI infrastructure, remote settings, and policy changes remain **BLOCKED** or **OWNER DECISION** pending the approvals in §15.

**STOP — no deployment performed.**
