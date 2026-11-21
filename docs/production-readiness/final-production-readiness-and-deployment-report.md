# BONO — Final Production Readiness & Conditional Deployment Gate

**Audit date/time:** 2026-11-21, 20:55–21:05 EAT (UTC+03:00)
**Repository:** `C:\hotelms`
**Reference repository:** `C:\bonosm` — not accessed, not modified
**Audit type:** FINAL READINESS AUDIT — fresh verification; prior PASS results were not inherited

---

## 1. Executive verdict

# NOT READY FOR DEPLOYMENT

**No deployment was performed.** Multiple mandatory release gates are `BLOCKED`, `UNVERIFIED`, or `FAIL`. The local code, build, lint, and DB-free test suite are healthy, but that is not sufficient: there is no verified isolated staging environment, no executed G-PAY-1 or PIN staging acceptance, no provider backup/restore/PITR evidence, no deployed-index verification, no production monitoring/alerting, no CI/promotion/rollback rehearsal, no reproducible release artifact in source control, no Node runtime pin, and no authorized read-only access to the stated Render production service to verify its configuration.

The owner's conditional authorization explicitly forbids deployment when any mandatory gate is `FAIL`, `BLOCKED`, or `UNVERIFIED`. This audit therefore **STOPS after the report**. A separate, explicit deployment go-ahead is required after review.

---

## 2. Exact Git and working-tree state

| Item | Fresh evidence |
| --- | --- |
| Branch | `main` |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` |
| HEAD commit | `xans-web`, `2026-10-24T02:32:50+03:00`, `Complete Bono UI and reporting updates` |
| Remote | `origin https://github.com/salayassistance-cloud/cafe-ms.git` (fetch/push) |
| Working tree | **266** porcelain entries: **88 modified**, **3 deleted**, **175 untracked** |
| Staged changes | **0** (`git diff --cached --name-only` empty) |
| Required EXTERNAL retirements | Still deleted and unstaged: `app/api/external-items/route.js`, `app/api/external-sales/route.js`, `lib/models/ExternalItemRequest.js` — preserved exactly |
| Phase 14A fix present | `lib/hotel/auth/credential.js:196-197` (`const identityId = String(userId ?? "");` + strict check) |
| Phase 14A artifacts present | `tests/hotel-pin-change-objectid-regression.test.mjs`, `docs/production-readiness/phase-14a-hotel-pin-change-error-report.md` |
| State after audit | Still 266 entries, 0 staged — no git write command was executed |

**Interpretation:** the production branch HEAD is roughly one month older than the current working tree. A deployment from `main` as it stands would **not** include the Hotel subsystem, the inventory V2 work, the Phase 13/14A fixes, or the retirement of the three EXTERNAL files. The tree is therefore **not deployable as-is from source control**.

---

## 3. Fresh test / build / lint evidence

All commands were executed in `C:\hotelms` on 2026-11-21 during this audit. Exit codes are the shell's `$LASTEXITCODE`.

| Command | Exit code | Result |
| --- | --- | --- |
| `node --test "tests/*.test.mjs"` (opt-in DB env vars removed; single-level glob excludes `tests/integration/**`) | **0** | **2,557 tests / 419 suites; 2,557 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo; 58.34 s** |
| `npm run lint` (`eslint`) | **0** | 0 errors, 3 pre-existing warnings (unrelated files: `MenuCrudClient.jsx:161`, `app/menu/page.js:385`, `lib/ethiopianCalendar.js:622`) |
| `$env:MONGODB_URI=''; $env:CAFEDB_URI=''; $env:ROOM_MONGODB_URI=''; npm run build` | **0** | `✓ Compiled successfully in 7.2s`; page-data collection and 10/10 static pages generated; no DB connection used |
| `npm ls --depth=0` | **0** | Direct dependency tree matches `package.json`; two extraneous transitive packages are present in the lockfile (`@emnapi/runtime@1.11.3`, `@img/sharp-wasm32@0.35.3`) — cosmetic, not a desync |
| `node -e "require('./node_modules/next/package.json').engines"` | — | Next 16.3.1 requires Node `>=20.9.0`; local runtime is Node **v24.14.0**, npm 11.9.0 |

**Test-suite safety:** the `tests/*.test.mjs` glob excludes the opt-in `tests/integration/**` harnesses that spawn loopback mongods. `tests/hotel-integration.test.mjs` self-skips without its opt-in flags; those flags were explicitly removed before the run, and the result confirms **0 skipped** (i.e. it did not engage). No test opened a connection to `127.0.0.1:27017/bono_hotel` or to any external/Atlas host.

**Not run (and why):** `tests/integration/**` opt-in MongoDB harnesses, `hotel-integration.test.mjs` with opt-in enabled, and `tests/hotel-integration-cleanup.mjs`. These require explicitly acknowledged disposable databases; no such authorization was granted for this audit. Their prior PASS claims are not inherited.

---

## 4. Acceptance matrix

Legend: `PASS` — fresh evidence in this audit; `FAIL` — fresh evidence shows the requirement is not met; `BLOCKED` — requires owner/infrastructure action not available; `UNVERIFIED` — no authorized tool/evidence; `NOT APPLICABLE`.

| ID | Requirement | Status | Evidence (fresh, unless marked `prior report`) | Verified | Remaining action |
| --- | --- | --- | --- | --- | --- |
| G-01 | Current branch/HEAD recorded | **PASS** | `git branch --show-current` → `main`; `git rev-parse HEAD` → `69650435…` | 2026-11-21 20:56 | None |
| G-02 | Working tree preserved; EXTERNAL retirements intact | **PASS** | 266 entries, 0 staged; 3 required `D` entries present before and after audit | 2026-11-21 21:04 | None |
| G-03 | Full safe DB-free test suite | **PASS** | `node --test "tests/*.test.mjs"` → exit 0, 2557/2557 pass, 0 skipped | 2026-11-21 20:58 | None |
| G-04 | Lint | **PASS** | `npm run lint` → exit 0, 0 errors | 2026-11-21 21:00 | Fix 3 pre-existing warnings (non-gating) |
| G-05 | Production build without DB | **PASS** | Blank-URI `npm run build` → exit 0, compiled + 10/10 pages | 2026-11-21 21:01 | None |
| G-06 | Dependency/lockfile consistency | **PASS** | `npm ls --depth=0` exit 0; `package.json:15-30` matches `package-lock.json:7-26` | 2026-11-21 21:02 | None |
| G-07 | POS/Hotel authentication separation | **PASS** | No cross-imports of auth/session/db modules; Hotel boundary confined to `app/api/hotel/**`, `app/hotel/**`, `app/components/hotel/**`, `lib/hotel/**` (source review) | 2026-11-21 20:59 | None |
| G-08 | Env validation / fail-closed | **PASS** | POS `lib/config/runtimeEnv.js:7,16-27`; Hotel `lib/hotel/config.js:48-76,87-113`; missing Hotel URI → 503 via `lib/hotel/errors.js:123-129` | 2026-11-21 20:59 | None |
| G-09 | Health endpoint implemented and redacted | **PASS** | `app/api/health/route.js:8-54`; `lib/health.js:8-22` exposes only coarse state | 2026-11-21 20:59 | See G-23 (production monitoring) |
| G-10 | Security headers | **PASS** | `next.config.mjs:28-41` (X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, prod HSTS), `:43-67` no-store | 2026-11-21 20:58 | See B10 (CSP missing) |
| G-11 | External retirement consistency | **PASS** | 3 files deleted; remaining hits are docs/tests/dead i18n keys/read-only `isExternal` markers only | 2026-11-21 20:59 | Optional: fix stale comment `lib/analytics.js:25` |
| G-12 | No real secrets in tracked files | **PASS** | Only placeholders in `.env.example`/`README.md`; `.env.local` untracked; no real URI/credential values in tracked source | 2026-11-21 20:59 | Remove dev-leftover PIN/hash scripts `checkVerifyWaiter.js`, `fixPins2.js` (non-gating) |
| G-13 | Phase 14A PIN-change fix + regression | **PASS (local)** | `credential.js:196-197`; regression test passes inside the 2557-test run; pre-fix failure documented in `phase-14a-…-report.md:41` | 2026-11-21 20:58 | Live staging acceptance PIN-S02…S08 (see B1) |
| G-14 | Inventory/payment/order/station/reporting guards | **PASS (source)** | Server-authoritative order lines `lib/orderService.js:463-615`; payment identity freeze `:1341-1512`; fail-closed inventory `lib/inventoryReservationService.js:664-770`; station scope `lib/stationReport.js:22-31` | 2026-11-21 20:59 | Live staging acceptance (B1) |
| **B1** | Isolated staging + G-PAY-1 15/15 + PIN staging acceptance | **BLOCKED** | No staging URL/DB/credentials/attestation in repo (`staging-readiness-report.md:3,106,128` `prior report`); `g-pay-1-staging-acceptance-report.md:3,20,115` → all cases `BLOCKED — NOT RUN`; `phase-14-…-report.md:75-91` → PIN-S01…S13 all `☐`; `phase-14a-…-report.md:75` → live PIN POST not executed | 2026-11-21 21:03 | Owner provisions isolated staging, attaches G0 attestations, executes and signs GP1-01…15 and PIN-S01…S13; reconcile the 9-vs-15 GP1 numbering (`phase-14-…-report.md:224`) |
| **B2** | Backup / PITR / restore drill / RPO-RTO | **BLOCKED** | Nine targets documented in `phase-14-…-report.md:105-113` but every mechanism/config/evidence cell `NOT VERIFIED` or `MISSING`; `phase-2-4-production-database-checklist.md:442-446` → no backup config, no drill, RPO/RTO/retention undefined; approval tables blank (`:654-657`) | 2026-11-21 21:03 | Owner attaches original approval/signed restatement; ops configures backup+PITR+retention and captures provider evidence; isolated restore drill with independent verifier and measured RPO/RTO |
| **C3** | Database schema/index integrity (declared vs deployed; duplicates) | **BLOCKED** | Index declarations only: POS auto-index gated (`lib/mongodb.js:50-108`), Hotel `autoIndex:false`/`autoCreate:false` (`lib/hotel/db/connection.js:29-40`); `phase-14-…-report.md:276-310` → live index state `NOT VERIFIED`, known legacy `StockMovement (refOrderId, reason)` conflict, Hotel idempotency uniqueness unverified | 2026-11-21 21:03 | Owner-approved read-only `getIndexes()` preflight on staging/production + duplicate preflight; then separately approved index deployment. **No DB connection or index change made in this audit.** |
| **B4** | Monitoring, alerting, error reporting, on-call | **BLOCKED** | Code exists (`/api/health`, operational logger, audit logs) but nothing consumes it; `phase-14-…-report.md:316-361` → provider config `NOT VERIFIED`, several signals `NOT IMPLEMENTED`, no rotation/runbook; raw error/stack logging remains in POS routes (e.g. `app/api/station/report/route.js:79`, `app/api/menu/route.js:110`) | 2026-11-21 21:03 | Ops configures health monitoring + alert routing + error sink, names on-call, publishes runbook; engineering addresses raw error logging (F-19) |
| **B5** | CI, promotion, rollback | **BLOCKED** | No `.github/`, no workflow YAML, no `render.yaml`, no `test` script (`package.json:5-14`); `netlify.toml:1-6` runs build only; `phase-14-…-report.md:367-401` → proposal only, no files created; rollback never rehearsed | 2026-11-21 21:03 | Owner approves CI runner/provider settings; implement CI + artifact promotion; rehearse rollback without DB changes |
| **B6** | Release artifact reproducible from VCS | **FAIL** | HEAD `6965043…` predates all current work; 266 uncommitted entries, 0 staged; a deploy from `main` would omit the entire Hotel subsystem, Phase 13/14A fixes and EXTERNAL retirements | 2026-11-21 21:04 | Owner must instruct an explicit commit/promotion path that preserves the 3 EXTERNAL deletions; tag the release. **No git write performed here.** |
| **B7** | Node/plugin pinning, Render runtime, reproducibility | **BLOCKED** | No `engines`, `.nvmrc`, `.node-version` or Volta pin; Next 16.3.1 needs Node ≥20.9.0; local Node v24.14.0; `@netlify/plugin-nextjs` version unverifiable (`phase-14-…-report.md:459`); **Render runtime entirely unverified** | 2026-11-21 21:02 | Owner supplies the actual Render Node version and intended plugin/version; pin `engines.node` and add Render config; rebuild reproducibly |
| **B8** | Public bank-account disclosure decision (F-13) | **BLOCKED** | `phase-12-…-report.md:467`; `phase-14-…-report.md:480` → `OWNER DECISION — no behavior changed`; no recorded acceptance (`phase-13-…-report.md:332`) | 2026-11-21 21:03 | Owner selects option A/B/C and signs risk acceptance if A |
| **B9** | Mandatory Manager PIN step-up (F-15, R-06) | **BLOCKED** | `phase-12-…-report.md:468`; `phase-14-…-report.md:497-508` → no policy changed, R-06 DEFERRED, no approval row filled | 2026-11-21 21:03 | Owner decides yes/no, approves test plan, engineering implements if yes |
| **B10** | Content-Security-Policy (F-20) | **BLOCKED** | `phase-14-…-report.md:514,563` → proposed directives only, no CSP header added/enforced; fresh source review confirms no CSP in `next.config.mjs` | 2026-11-21 21:03 | Owner approves directive set and report sink; ship report-only, observe, then enforce |
| **F-13…F-22** | Carried Phase 12 risks | **BLOCKED** | `phase-14-…-report.md:609` → F-14, F-16, F-17, F-18, F-19, F-21, F-22 "unchanged, not silently resolved"; F-23a/c/d/e/f/g/h likewise unclosed (F-23f folded into B3); F-23b closed in source only | 2026-11-21 21:03 | Owner decisions on F-13/F-15/F-22; engineering fixes or written risk acceptance for each; live verification for F-23 |
| **R-01** | Render service identity `cafe-ms`, branch, deployed commit | **UNVERIFIED** | No Render MCP resource (`list_mcp_resources` → empty), no Render CLI, no `RENDER_API_KEY`/`RENDER_SERVICE_ID` in environment, no `render.yaml`, no repo doc mentioning `cafe-ms` or Render | 2026-11-21 21:02 | Authorize/read-only Render dashboard access; capture service ID, production branch, latest deployed SHA |
| **R-02** | Render build/start commands, Node runtime | **UNVERIFIED** | Same tooling gap; tracked `netlify.toml:1-6` is a *Netlify* config and cannot evidence Render settings | 2026-11-21 21:02 | Read-only Render inspection by owner/ops |
| **R-03** | Required env var names and presence on Render (incl. `MONGODB_URI`) | **UNVERIFIED** | No Render access; prior note that `ROOM_MONGODB_URI` was pending (`owner task context`) cannot be assumed resolved | 2026-11-21 21:02 | Read-only Render env-name inventory (names only); confirm presence by name |
| **R-04** | `ROOM_MONGODB_URI` exists on Render and targets intended `bono_hotel` Hotel DB | **UNVERIFIED** | No Render access. Local dev target verified only (`phase-14a-…-report.md:63-71`: local `127.0.0.1:27017/bono_hotel`); local `.env.local` uses a different Atlas SRV host and was **never contacted** | 2026-11-21 21:02 | Read-only Render inspection + approved read-only target verification; do not print values |
| **R-05** | Health check configured on Render | **UNVERIFIED** | Endpoint code verified (G-09); provider configuration not accessible | 2026-11-21 21:02 | Read-only Render service inspection |
| **R-06** | Deploy history, last known healthy deploy, rollback availability | **UNVERIFIED** | No Render access; no CI (B5); rollback procedure never rehearsed | 2026-11-21 21:02 | Read-only Render deploy history + documented/rehearsed rollback |
| **R-07** | Production service monitoring/health | **UNVERIFIED** | Same as B4 plus Render access gap | 2026-11-21 21:02 | Authorized read-only Render metrics/logs inspection |
| **D-01** | Production DB backup/recovery evidence | **BLOCKED** | See B2; no production DB was connected to in this audit | 2026-11-21 21:03 | See B2 |
| **D-02** | Live deployed index state / uniqueness | **BLOCKED** | See C3 | 2026-11-21 21:03 | See C3 |
| **D-03** | Local dev Hotel DB isolation | **PASS** | `phase-14a-…-report.md:63-71` (prior phase, read-only): local `bono_hotel` on 127.0.0.1:27017; local public identity endpoint returned 200 with 3 identities; no Atlas contact | 2026-11-21 (prior phase) | Not a production gate; recorded for context |

---

## 5. Reconciliation of prior blockers (no PASS inherited)

| Prior item | Prior claim | Fresh finding |
| --- | --- | --- |
| B1 | "PROPOSED — infrastructure NOT VERIFIED / BLOCKED" | Still BLOCKED. No staging exists in repo; 0 of 15 G-PAY-1 cases and 0 of 13 PIN scenarios executed. |
| B2 | "Policy reconciled; mechanism/config/drill missing — BLOCKED" | Still BLOCKED. No provider evidence, PITR setting, retention config, drill report, verifier signature, or measured RPO/RTO found. |
| C3 / B3 | "Inventory + dry-run VERIFIED; deployment not approved — BLOCKED" | Still BLOCKED. Declarations only; no live index evidence; duplicate/index conflicts remain open. |
| B4 | "Plan finalized; external monitoring missing — BLOCKED" | Still BLOCKED. Code implemented; production monitoring/on-call absent; raw error logging remains in POS routes. |
| B5 | "Proposal complete; runner/provider blocked — BLOCKED" | Still BLOCKED. No CI files, no test script, no promotion/rollback rehearsal. |
| B6 | "Working tree uncommitted; grouping proposed — BLOCKED" | Fresh state: 266 entries / 0 staged / HEAD from 2026-10-24 → **graded FAIL** for "deployable as-is". |
| B7 | "Node pins proposed; plugin BLOCKED" | Still BLOCKED. No `engines`, no runtime pin, plugin version unknown, Render runtime unknown. |
| B8/B9/B10 | All "OWNER DECISION" | Still BLOCKED; no approval record found in repo. |
| F-13…F-23 | Carried, unchanged | Still BLOCKED/UNVERIFIED. F-23b is closed in source and now covered by local regression tests, but its staging acceptance remains unexecuted. |
| Phase 14A PIN 500 | Fixed locally, tests pass | Fix and regression confirmed present and passing in the fresh 2,557-test run; live acceptance still required. |
| WP04-06 design approvals | Recorded for recovery design only | Explicitly **not** gate signatures (`wp-04-06-design-consolidation-and-register.md:16`); G-REC-1/2/3, G-AUD-1, G-GOV-1, G-IDX-1, G-PAY-1 remain unsigned. Not counted as resolution of any B-gate. |

---

## 6. Database and recovery evidence

- **No production MongoDB connection was opened.** No migration, backfill, index creation/deletion, data repair, restore, or destructive operation was performed.
- Local-only read-only evidence from Phase 14A is recorded in §4 (D-03) and is explicitly **not** production evidence.
- Provider backup configuration, PITR window, retention settings, encryption-at-rest/TLS confirmation, restore drill, measured RPO/RTO, and verifier signature: **all BLOCKED / no evidence**.
- Owner-approved targets (RPO ≤15 min, RTO ≤4 h, retention ≥30 d, monthly points ≥90 d, PITR ≥7 d if supported, financial and recovery audit evidence ≥1 year, no TTL/deletion without approval, provider-managed encryption/TLS): documented as claimed policy, **none verified as implemented**.

---

## 7. Security and operational readiness

- **Positive (verified in code):** HttpOnly/Secure CSRF-bound Hotel sessions with HMAC-only storage, absolute/idle expiry and revocation; scrypt PIN hashing with constant-time compare and collision checks; POS HMAC cookies and Origin checks; per-route rate limiting; strict bounded JSON parsing; Origin/Sec-Fetch-Site validation; server-authoritative order/payment/inventory logic; no-store headers on protected routes; redaction helpers for logs and audit metadata; no real secrets in tracked files.
- **Open concerns (not gating by themselves but must be tracked):** no POS CSRF token (SameSite+Origin only); volatile per-process rate-limit store; POS idle timeout not enforced; POS mutations lack Origin/CSRF validation (F-18); manager PIN step-up optional (B9); no CSP (B10/F-20); raw error/stack logging in several POS routes (F-19); raw `err.message` in `lib/menuInventoryPolicyService.js:137,419`; dev-only scripts containing PIN literals/hash prints; health endpoint checks POS DB only, not Hotel DB/secret; inventory hook failures swallowed after commit (`lib/orderService.js:375-395`).
- **Operational:** on-call ownership, incident procedure, alert routing, error tracker, rotation, and runbook are **not configured/verified** (B4).

---

## 8. Remaining risks and owner decisions

Mandatory, all unresolved: isolated staging + G-PAY-1/PIN acceptance (B1); backup/PITR/drill/RPO-RTO (B2); index/duplicate preflight (C3); monitoring/on-call (B4); CI/promotion/rollback (B5); commit/tag strategy preserving EXTERNAL deletions (B6); Node/plugin/Render runtime pins (B7); Render read-only configuration verification (R-01…R-07).

Owner policy decisions still open: B8 (bank-account disclosure), B9 (Manager PIN step-up), B10 (CSP), F-22 (canonical revenue date), plus risk acceptance or remediation for F-13…F-23.

No approval may be inferred from silence in the repository. The owner's statement that backup requirements were previously approved is treated as a **claimed policy**, not evidence of implementation.

---

## 9. Conditional deployment plan (NOT authorized — for owner review only)

To be executed **only** after all mandatory gates pass and a separate explicit go-ahead is given:

1. Confirm final gate sign-off table and that the release commit/tag contains all 266 current changes including the three EXTERNAL deletions (B6).
2. Confirm Render service identity, production branch, target deploy SHA, Node runtime, build/start commands, and env-var names/presence via authorized read-only inspection (R-01…R-05). Confirm `ROOM_MONGODB_URI` targets the intended isolated Hotel DB; never print values.
3. Confirm backup/PITR health and index preflight are signed (B2, C3); confirm monitoring/alerting/on-call active (B4) and CI job green on the exact release SHA (B5).
4. Re-run `npm run lint`, blank-URI `npm run build`, and the full DB-free suite on the release SHA; archive logs and exit codes.
5. Trigger the Render deploy of the reviewed SHA only; record start time, deploy ID, and the previous known-good SHA.
6. Immediately verify `GET /api/health?live=1` → 200, readiness `GET /api/health` → healthy, representative unauthenticated pages, a POS login smoke, and a Hotel identity-directory smoke (all read-only). Do not query production data directly or run writes.
7. Observe health, error rate, and alerts for the agreed soak period; obtain ops + owner sign-off.

**Rollback plan (no database changes):** if any smoke/soak check fails, re-deploy the recorded previous known-good SHA through Render, re-run the same health/smoke checks, and preserve the failed deploy's logs for incident review. Rollback is application-only: **no migration reversal, no index change, no data repair, no destructive database operation**. Because no CI/rollback rehearsal exists today (B5), this plan is untested and must be rehearsed before use.

---

## 10. What was NOT verified or NOT performed

- **Not deployed.** No Render build trigger, service change, environment-variable change, domain/DNS change, or infrastructure modification.
- **Render configuration entirely UNVERIFIED:** service `cafe-ms`, branch, deployed commit, build/start commands, Node runtime, env var names/presence (including whether `ROOM_MONGODB_URI` is still pending), health-check config, deploy history, rollback availability, monitoring — no authorized tool or credential was available.
- **No production database contact:** no Atlas SRV host, production POS DB, or production Hotel DB was connected to. No index, migration, backfill, data repair, restore, or destructive operation.
- **No staging execution:** no G-PAY-1 case and no PIN acceptance scenario was executed; no staging environment was discovered or created.
- **No git write:** no stage, commit, push, tag, stash, reset, clean, checkout, revert, or discard. Working tree and all 3 EXTERNAL retirements preserved.
- **No changes to `C:\bonosm`.**
- **Opt-in integration suites not run:** `tests/integration/**`, opt-in `hotel-integration.test.mjs`, and cleanup/fixture harnesses were not executed; their prior results are not claimed here.
- **No owner approvals inferred or invented:** B8–B10 and F-13…F-23 remain open.

---

## 11. Stop

Per the conditional authorization, the verdict is **NOT READY FOR DEPLOYMENT**. This audit stops here. Deployment requires a separate explicit owner go-ahead after the owner reviews this report and clears each blocker listed in §6/§8 with fresh evidence.
