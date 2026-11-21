# Phase 12 — Final Production-Readiness Audit & Deployment Decision

**Repository:** `C:\hotelms` · **Branch:** `main` · **HEAD:** `6965043`
**Audit date:** 2026-11-21
**System:** BONO POS (Next.js 16.3.1, Node v24.14.0, npm 11.9.0) + Hotel subsystem + Inventory V1/V2
**Target platform:** Netlify (`@netlify/plugin-nextjs`) + MongoDB Atlas
**Report status:** FINAL — no deployment performed, no production system contacted

> **Decision: NOT READY FOR DEPLOYMENT.**
> Five release-blocking infrastructure gaps and seven unresolved security/operational risks
> remain. Code quality and functional correctness are strong; release *evidence* is absent.

---

## A. Executive summary

The application is in good functional and security shape at the source level. The full
database-free suite (**2,524 tests / 409 suites**) passes, the opt-in integration suites
(**32/32**) pass against a disposable local replica set, ESLint reports **0 errors**, a
production build succeeds, and a local production-server smoke test returns correct status
codes with correct security headers. Five genuine defects were found and fixed during this
audit, each with regression protection.

However, the system cannot be certified for production. The blockers are not code defects —
they are **absent deployment evidence**:

1. No verified isolated staging environment; the 15-case payment acceptance checklist has never been executed.
2. No backup, PITR, restore drill, or approved RPO/RTO. No "previously approved BONO backup and recovery requirement" exists anywhere in the repository.
3. **Zero database-verified indexes.** Every index is declared in source only.
4. No monitoring, alerting, on-call, or log shipping.
5. No CI, no artifact promotion, no rollback runbook; Node and the Netlify plugin are unpinned.

Additionally, the release artifact is **not reproducible from version control**: 262 working-tree
entries (including the entire Hotel subsystem, all new tests, and all readiness documentation)
are uncommitted, and three EXTERNAL files are intentionally deleted but unstaged.

Residual security risks remain open and were deliberately **not** changed because they are
business/UX decisions or require infrastructure: public bank-account disclosure, public SSE
with order identifiers, optional manager PIN step-up, IP-only rate limiting, unenforced POS
idle timeout, and no CSP.

**Verdict:** the codebase is a credible release candidate; the *release process* is not.
Deployment should proceed only after the blockers in §H are closed and signed.

---

## B. Scorecard

Scored 0–10 against production-readiness intent (not against "does it work locally").

| Dimension | Score | Basis |
|---|---:|---|
| Authentication & authorization (POS) | 7/10 | Live-role authz on every route, no bypass found; optional manager step-up, no Origin/CSRF check on POS mutations, one cookie-only manager path. |
| Authentication & authorization (Hotel) | 8/10 | 36/36 endpoints authenticated, live-role checks, CSRF+Origin on mutations; shared rate-limit store (E-04) still open. |
| Financial correctness & data integrity | 7/10 | Transactional order/payment design, frozen payment identity, atomic CAS transitions; index deployment unverified, order-number fallback collision, report time-boundary inconsistency. |
| Secrets & configuration | 6/10 | Good handling (no values logged, env git-ignored); boot validation covers only `MONGODB_URI`, Node/plugin unpinned. |
| Deployment & infrastructure | 3/10 | Build config only; no staging, no CI, no promotion, no rollback runbook. |
| Backup & disaster recovery | 1/10 | Nothing configured or verified; RPO/RTO undefined; recovery worker not implemented. |
| Observability & operations | 3/10 | `/api/health` correct and secret-free; nothing consumes it, no alerts, no on-call, logs not shipped. |
| Test coverage & verification | 8/10 | 2,524 DB-free + 32 integration tests, broad invariant coverage; integration suites skip by default, some source-string assertions, no CI enforcement. |
| Code quality & maintainability | 7/10 | 0 lint errors, consistent structure; 262 uncommitted entries, documentation drift. |
| Documentation & release governance | 5/10 | Extensive and honest readiness docs, but `README.md` still claims "Production-ready" and all gates are unsigned. |
| **Overall production readiness** | **4.5/10** | **Functional readiness ≈ 8/10; operational readiness ≈ 2/10.** |

---

## C. Scope, method, and evidence classification

**Method.** Read-only source audit across five domains (Hotel subsystem, POS auth/security,
POS business logic, deployment/backup/recovery, test infrastructure), followed by a controlled
local verification pass (tests, lint, build, production-server smoke), then a minimal set of
targeted fixes with regression tests.

**Evidence classes used throughout this report:**

| Class | Meaning |
|---|---|
| **VERIFIED (local)** | Executed in this audit on this machine with databases blanked or disposable. |
| **SOURCE-INSPECTED** | Confirmed by reading code with `file:line` evidence; not exercised at runtime. |
| **TEST-VERIFIED** | Covered by an automated test that passed in this audit. |
| **NOT VERIFIED** | Cannot be established without owner-provided infrastructure or approval. |
| **BLOCKED** | Requires a decision, credential, environment, or sign-off that was not available. |

No production database was contacted. No deployment, migration, index creation, backup, or
restore was performed. No secret value was read, printed, or copied.

---

## D. Findings register

Severity: **CRITICAL** = must not deploy · **HIGH** = deploy-blocking without explicit owner
risk acceptance · **MEDIUM** = fix soon / mitigate · **LOW** = hygiene · **INFO** = decision or
documentation.

### D.1 Fixed in this audit

#### F-01 — Open redirect via `/login?next=` (HIGH) — **FIXED**

| Field | Detail |
|---|---|
| Component | `app/login/page.js`, `app/components/PinGuard.js` |
| Root cause | `next` was taken verbatim from the query string and passed to the post-login navigation target. `PinGuard` also navigated to its `next` prop without validation. `roleFromNext()` parsed it but nothing constrained the destination. |
| Evidence | `app/login/page.js:6-17` (`roleFromNext`), `PinGuard.js:89,143` (`navigateAfterAuth(router, target)`), `lib/clientFetch.js` `navigateAfterAuth`. |
| Impact | An attacker could send `/login?next=https://evil.example/...`; after a legitimate staff PIN entry the terminal would be redirected off-site — credible credential-phishing against shared POS terminals. |
| Fix | New pure module `lib/safeNavigation.js` exposing `sanitizeInternalRedirect(value, fallback)`. Accepts only same-origin absolute paths; rejects absolute URLs, protocol-relative `//`, backslash-smuggled hosts, control characters, and dot-segment host tricks; normalizes and re-validates the parsed pathname. Wired into the login page (sanitize before role resolution) and `PinGuard` (defense in depth). |
| Verification | `tests/safe-navigation.test.mjs` — 6 tests / 15 assertions covering accepted paths, absolute/protocol-relative/`javascript:`/`data:`, backslash and `%2e%2e` smuggling, control characters, non-strings, and unsafe fallbacks. Plus 2 wiring tests pinning the call sites. **PASS.** |
| Remaining risk | None identified. `next` may still point at any *internal* page; authorization is enforced server-side per page, so an internal redirect cannot escalate role. |

#### F-02 — Plaintext PIN used as an in-memory cache key (MEDIUM) — **FIXED**

| Field | Detail |
|---|---|
| Component | `app/api/auth/verify-pin/route.js` |
| Root cause | The scrypt memoization map was keyed by `` `${storedHash}:${pin}` `` — the submitted 4-digit PIN in plaintext as a live Map key for the process lifetime (up to 256 entries). |
| Evidence | `verify-pin/route.js:15-16` (`staffDerivedCache`), `:106-113` (key construction). Previously logged as SEC-14. |
| Impact | Any heap dump, diagnostic snapshot, or debugger inspection of a warm serverless instance would reveal staff PINs. Because the key also contained the stored hash, a wrong PIN could not shadow the right one — but the confidentiality exposure is real. |
| Fix | Key is now `HMAC-SHA256(process-local 32-byte salt, storedHash ‖ 0x00 ‖ pin)` hex digest. The salt is generated with `randomBytes(32)` at module load; no plaintext PIN is retained. Verification semantics are unchanged (scrypt + `timingSafeEqual` untouched). |
| Verification | `tests/production-remediation-2026.test.mjs` asserts the HMAC key derivation exists, the salt exists, the old `` `${storedHash}:${p}` `` pattern is gone, and no PIN-keyed cache write exists. **PASS.** Full suite still green. |
| Remaining risk | A digest of a 4-digit PIN is trivially brute-forceable if an attacker already has a heap dump *and* the salt. This is a defense-in-depth improvement, not a cryptographic guarantee; the salt raises the bar and removes plaintext at rest in memory. |

#### F-03 — Shared mutable report cache leaked analytics detail into `/api/manager/reports` (MEDIUM) — **FIXED**

| Field | Detail |
|---|---|
| Component | `lib/reportService.js`, `app/api/manager/analytics/route.js` |
| Root cause | `getReport()` returned the cached object **by reference**; the analytics route then assigned `report.completedItemsDetail` and `completedItemsDetailMeta` onto it. Both endpoints use the same cache key. |
| Evidence | `reportService.js:50-62` (cache hit returns `hit.data`), `analytics/route.js:74-79` (mutation), `manager/reports/route.js:50` (same key). |
| Impact | `/api/manager/reports` could receive per-order rows (`orderNumber`, `tableNumber`, `waiterName`, `paymentMethod`) that its own projection never requested. Both endpoints are MANAGER-only, so this is unintended cross-endpoint data bleed rather than privilege escalation — but it is a correctness and least-exposure defect. |
| Fix | `getReport()` returns `{ ...hit.data }` on cache hits; the analytics route builds and returns a separate `responseReport` copy instead of mutating the cached object. |
| Verification | `tests/production-remediation-2026.test.mjs` pins both behaviors (copy on hit, copy on annotate, no mutation of `report.completedItemsDetail`). **PASS.** |
| Remaining risk | The cache is still per-process and unbounded by key count (bounded in practice by interval/date combinations). Acceptable for the current single-instance design; revisit if multi-instance. |

#### F-04 — Station roles could widen their order listing by omitting `dest` (MEDIUM) — **FIXED**

| Field | Detail |
|---|---|
| Component | `app/api/orders/route.js` |
| Root cause | KITCHEN / BARISTA / HOT_DRINK listing applied **no** item-type filter unless the client supplied `?dest=`. A comment claimed station scoping, but the scope was client-driven. |
| Evidence | `orders/route.js:156-169,198-200` (branch with no filter); `KitchenDisplay.js:213-214` always sends `dest`, so only direct API callers were affected. |
| Impact | A station terminal (or a stolen station credential) could list all active orders across stations, including the other station's lines and statuses. Not a payment or mutation escalation — reads only — but it breaks the station-separation model the UI enforces. |
| Fix | When the live role maps to a station via `stationForRole()`, the server forces `query["items"] = { $elemMatch: { type, cancelled: { $ne: true } } }` from `STATION_ITEM_TYPE`, overriding any client `dest`. This mirrors the existing station authority used by `orderService.updateOrderStatus`. |
| Verification | `tests/production-remediation-2026.test.mjs` pins the import, the role-derived station, and the `$elemMatch` override. Full suite green, including `kds-separation`, `hot-drink-station`, `kds-single-flight-polling`. **PASS.** |
| Remaining risk | `$elemMatch` now always applies to station roles, including `dest=ALL`. That is the intended strictness; no UI relies on a station role seeing other stations' orders. |

#### F-05 — Manager direct settlement froze `paymentMethod: "NONE"` (MEDIUM, financial attribution) — **FIXED**

| Field | Detail |
|---|---|
| Component | `app/api/orders/[id]/route.js`, `app/api/orders/[id]/status/route.js`, `lib/orderService.js` |
| Root cause | The MANAGER `SERVED → PAID` path accepted a body with no `paymentMethod`; `payOrder()` normalized `undefined` to `null`, skipped the `$set`, and the schema default (`"NONE"`) was frozen at first payment. Reports map `NONE` to `UNKNOWN`. |
| Evidence | `orders/[id]/route.js:292-293`, `orders/[id]/status/route.js:107-109`, `orderService.js:1380,1439-1467`, `Order.js:191-196`, `reportRevenueBreakdown.js:41-43`. Recorded as residual risk R-6 in `g-pay-1-staging-acceptance-report.md:368`. |
| Impact | Settled revenue silently unattributed; cash/transfer reconciliation and waiter analytics under-report by method. Reachable today via the documented manager direct-settlement path. |
| Fix | Both PAID routes now reject a method-less SERVED settlement with `400 paymentMethod is required to settle a served order`, before calling `payOrder`. Idempotent PAID retries and the `confirmPayment` (cashier) path are untouched. |
| Verification | `tests/production-remediation-2026.test.mjs` pins the guard in both routes. Full suite green, including `wp01-payment-remediation` and `phase25-payment-immutability`. **PASS.** |
| Remaining risk | A manager can still explicitly send `paymentMethod: "NONE"` if that value passes validation. Recommended follow-up (owner-approved): reject explicit `NONE` on first settlement and add a matching `payOrder` invariant. Not done here to avoid changing the accepted API surface without approval. |

### D.2 Open — release-blocking (infrastructure / process)

#### F-06 — No verified staging environment (CRITICAL)

| Field | Detail |
|---|---|
| Component | Deployment |
| Root cause | `netlify.toml` defines a single build/publish block; no staging context, branch deploy, separate database, or staging URL exists. |
| Evidence | `netlify.toml:1-6`; `staging-readiness-report.md:86-128,210-219`; all G0-1…G0-10 gates require owner approval; all 15 G-PAY-1 cases are `BLOCKED — NOT RUN` (`g-pay-1-staging-execution-checklist.md:37-56`). |
| Fix status | **Not fixed — requires owner infrastructure.** |
| Verification | Not verifiable locally. |
| Remaining risk | No environment exists in which payment, inventory, restore, or load behavior has been observed end-to-end. |
| Action | Provision an owner-attested isolated staging app + isolated Mongo replica set; execute the G-PAY-1 15-case checklist; sign the gate register. |

#### F-07 — No backup, PITR, restore drill, or approved RPO/RTO (CRITICAL)

| Field | Detail |
|---|---|
| Component | Data protection |
| Root cause | No backup mechanism, schedule, retention policy, restore procedure, or drill is configured or recorded. No repository document contains an approved backup/recovery requirement. |
| Evidence | `phase-2-4-production-database-checklist.md:436-473,693-704` ("VERIFIED absence"); `phase-2-5-safety-and-deployment-gates.md:249-261` (RPO ≤15 min / RTO ≤4 h are **proposed and unsigned**); `phase-2-4-recovery-readiness.md:411-420` (retention undecided); `phase-2-4-owner-decisions.md:483-484`. |
| Fix status | **Not fixed — requires owner decision + provider configuration.** |
| Verification | Not verifiable locally. |
| Remaining risk | Any data-loss event is unrecoverable to a defined point; financial and audit evidence retention is undefined. |
| Action | Choose mechanism (Atlas continuous backup / PITR), encryption, retention, RPO/RTO; run an isolated restore drill verifying `counters.order_seq`, unique indexes, PAID/ARCHIVED evidence, and reconciliation; independent verifier signs. Must precede release. |

#### F-08 — Zero database-verified indexes (HIGH)

| Field | Detail |
|---|---|
| Component | MongoDB schema |
| Root cause | Indexes exist as schema declarations and guarded deployment scripts, but none has been applied to or verified in any database. |
| Evidence | `scripts/sync-indexes.js:115-125`; `scripts/hotel-deploy-indexes.mjs:81-92`; `scripts/inventory-v2-deploy-indexes.mjs:22-23` ("created but NOT executed"); `phase-2-4-production-database-checklist.md:249-266,403-405`. |
| Fix status | **Not fixed — deployment operation requiring approval.** |
| Verification | Source-inspected only. |
| Remaining risk | Uniqueness/idempotency invariants (e.g. `StockMovement` idempotency key, reservation `orderId`) are unenforced in a live DB; a legacy unique `(refOrderId, reason)` index may still reject multi-ingredient orders; query performance is unmeasured. |
| Action | Run read-only inventory + duplicate preflight, then `--dry-run` → staging `--confirm` → production `--confirm --allow-production` with approval refs, in separate change windows. Verify with `getIndexes()` before/after. |

#### F-09 — No monitoring, alerting, or on-call (HIGH)

| Field | Detail |
|---|---|
| Component | Observability |
| Root cause | `/api/health` is implemented correctly but nothing consumes it; structured logs are one-line JSON with redaction but are never shipped; no metrics, error tracker, alert sink, or named on-call. |
| Evidence | `app/api/health/route.js:6-54`; `lib/operationalLogger.js:1-11` ("hosting provider is assumed log sink"); `phase-2-4-production-database-checklist.md:532-561`. |
| Fix status | **Not fixed — requires infrastructure.** |
| Verification | Health endpoint VERIFIED locally (200, no secrets). Monitoring NOT VERIFIED. |
| Remaining risk | Outages, 503 storms, transaction failures, and paid-without-deduction divergences would be discovered by customers, not operators. |
| Action | External uptime check on `/api/health`, log drain, error tracking, alert routing, named on-call, and a first-response runbook. |

#### F-10 — No CI, artifact promotion, or rollback runbook (HIGH)

| Field | Detail |
|---|---|
| Component | Release engineering |
| Root cause | No `.github/` (or other) CI pipeline; no test job; no promotion of a tested artifact; no documented rollback. |
| Evidence | `netlify.toml:1-6`; `package.json:5-14` (no test script); `phase-2-1-production-gap-assessment.md:78-83,161-166`. |
| Fix status | **Not fixed — requires repo/process change.** |
| Verification | Not verifiable locally. |
| Remaining risk | Nothing prevents a regression from reaching production; recovery from a bad deploy is undefined. |
| Action | Add CI running the full DB-free suite plus a disposable-Mongo integration job; deploy the exact artifact that passed; document and rehearse rollback. |

#### F-11 — Release artifact not reproducible from version control (HIGH)

| Field | Detail |
|---|---|
| Component | Release provenance |
| Root cause | 262 working-tree entries are uncommitted, including the entire Hotel subsystem (`app/hotel/**`, `app/api/hotel/**`, `lib/hotel/**`, `app/components/hotel/**`), all new tests, and all readiness docs. Three EXTERNAL files are deleted but unstaged. |
| Evidence | `git status --porcelain` → 262 entries; `git diff --cached --name-only` → 0. |
| Fix status | **Deliberately not changed** — the working tree is treated as user work and must not be normalized or committed by this audit. |
| Verification | VERIFIED (git read-only). |
| Remaining risk | The deployed build cannot be traced to a commit; a rollback or rebuild may not reproduce it; code review and provenance are impossible. |
| Action | **Owner must** review and commit the working tree in logical, reviewed commits (preserving the three EXTERNAL deletions) and tag the release commit before deploying. |

#### F-12 — Unpinned runtime and build plugin (MEDIUM)

| Field | Detail |
|---|---|
| Component | Build configuration |
| Root cause | Neither `package.json#engines` nor `netlify.toml` pins Node; `@netlify/plugin-nextjs` is declared in `netlify.toml` but is absent from `package.json`/lockfile, so its version is platform-resolved. |
| Evidence | `netlify.toml:1-6`; `package.json:1-31`; Next requires Node `>=20.9.0` (`node_modules/next/package.json:137`). |
| Fix status | **Not fixed — config change requiring owner sign-off.** |
| Verification | SOURCE-INSPECTED. |
| Remaining risk | A platform-side Node or plugin upgrade can silently change build/runtime behavior between deploys. |
| Action | Pin `engines.node` and `NODE_VERSION`; pin the plugin version (add to `package.json` and the lockfile). |

### D.3 Open — security / functional risks (documented, not changed)

#### F-13 — Public, publicly-cached bank-account disclosure (HIGH)

| Field | Detail |
|---|---|
| Component | `GET /api/payment-info` |
| Root cause | No authentication; returns all records (including inactive) with full `accountNumber` and `ownerName`; response is CDN-cacheable for 60s. |
| Evidence | `app/api/payment-info/route.js:10-43`; `next.config.mjs:74-79`. Previously SEC-01. |
| Fix status | **Not fixed — business decision.** The public `/menu` page deliberately shows payment accounts so customers can pay by transfer; restricting it would break a product feature. |
| Verification | SOURCE-INSPECTED; `/menu` consumer confirmed at `app/menu/page.js:261,940-979`. |
| Remaining risk | Anyone (or any CDN cache) can enumerate bank accounts and owner names. |
| Action | Owner must choose: (a) accept as intended public business information, (b) mask to bank + last 4 for unauthenticated callers while keeping full values for authenticated staff, or (c) require a session. If accepted, record the decision and drop the public cache header. |

#### F-14 — Unauthenticated SSE stream with order identifiers (MEDIUM-HIGH)

| Field | Detail |
|---|---|
| Component | `GET /api/events` and all publishers |
| Root cause | SSE requires no session; events carry `orderId`, `orderNumber`, `status`, and `reason`. |
| Evidence | `app/api/events/route.js:12-27,44`; publish sites `app/api/orders/route.js:113-117`, `orders/[id]/route.js:180-186,334-352`, `orders/[id]/status/route.js:136-152`. Previously SEC-04. |
| Fix status | **Not fixed — change would require coordinated client work.** Clients currently consume `ORDER_READY` and identifier fields (`WaiterUI.js:743-750`, `CashierUI.jsx:518-521`). Downgrading payloads to invalidation-only is safe in principle but changes real-time behavior across three terminals. |
| Verification | SOURCE-INSPECTED. |
| Remaining risk | Anonymous observers learn live order volume, IDs, numbers, and status transitions; no per-client stream cap. |
| Action | Owner-approved change: emit invalidation-only events (`{type:"orders-changed"}`) and require a live session with a per-identity stream cap. |

#### F-15 — Manager PIN step-up is optional (MEDIUM-HIGH)

| Field | Detail |
|---|---|
| Component | `POST /api/manager/staff` |
| Root cause | `currentManagerPin` is optional; verification runs only `if (currentManagerPin)`. |
| Evidence | `app/api/manager/staff/route.js:210-266` (notably `:232-234,258-266`); UI omits it when blank (`StaffManagement.jsx:398-399`). Previously R-06 / SEC-02. |
| Fix status | **Not fixed — flow/UI change.** Making it mandatory requires the manager UI to always collect the PIN, which affects the staff-management flow. |
| Verification | SOURCE-INSPECTED. |
| Remaining risk | A stolen Manager session can reset any staff PIN — including station credentials — without knowing the Manager PIN. |
| Action | Require and verify `currentManagerPin` whenever a PIN changes; accept the tab credential via `requireAuth` instead of cookie-only; update the UI to always prompt. |

#### F-16 — Rate limiting is IP-only, header-spoofable, and split across three limiters (MEDIUM-HIGH)

| Field | Detail |
|---|---|
| Component | `proxy.js`, `lib/rateLimit.js`, Hotel limiter |
| Root cause | Three independent in-memory Maps with different thresholds; `proxy.js` trusts `x-forwarded-for` first; no per-account lockout for POS PINs; per-process state resets on restart and multiplies across instances. |
| Evidence | `proxy.js:6-38`; `lib/rateLimit.js:9-36,74-85`; `lib/hotel/auth/rateLimit.js:13-35`. Previously SEC-09 / SEC-14 / R-10; Hotel E-04. |
| Fix status | **Not fixed — infrastructure change.** |
| Verification | SOURCE-INSPECTED. |
| Remaining risk | Credential stuffing and PIN brute force are throttled only per client IP per process; spoofed forwarded headers or multi-instance fan-out defeat it. Hotel has per-identity lockout; POS does not. |
| Action | Trust only platform-provided client IP (`x-nf-client-connection-ip`); add POS per-account lockout/backoff; consolidate on one shared store (Redis/KV). |

#### F-17 — POS idle timeout is written but never enforced (MEDIUM)

| Field | Detail |
|---|---|
| Component | `lib/sessionStore.js` |
| Root cause | Idle timestamp is recorded and slid, but the idle check is intentionally disabled; only the 8-hour absolute expiry ends a session. |
| Evidence | `lib/sessionStore.js:25-26,66-79`. Previously SEC-03. Hotel enforces 30 minutes. |
| Fix status | **Not fixed — policy decision.** |
| Verification | SOURCE-INSPECTED. |
| Remaining risk | An unattended POS terminal remains authenticated for a full shift. |
| Action | Owner decision: enforce idle expiry, or add a documented client auto-lock, and record the accepted policy. |

#### F-18 — No Origin/CSRF validation on POS mutations (MEDIUM)

| Field | Detail |
|---|---|
| Component | `lib/security.js` `requireAuth` |
| Root cause | CSRF defense rests solely on `SameSite=Strict`; `isOriginAllowed` exists but is unused by auth. One manager mutation authenticates from the cookie only and parses JSON regardless of content type. |
| Evidence | `lib/security.js:8-60,112-123`; `app/api/manager/staff/route.js:247-256`. |
| Fix status | **Not fixed — cross-cutting auth change.** |
| Verification | SOURCE-INSPECTED; exploitation not demonstrated. |
| Remaining risk | Same-site sibling-origin state changes are theoretically possible; tab-only clients on plain HTTP cannot use the cookie-only endpoint at all. |
| Action | Add same-origin Origin/Referer validation (or a CSRF token) to cookie-authenticated POS mutations; make the manager route accept tab credentials. |

#### F-19 — Error strings and unredacted logs (MEDIUM)

| Field | Detail |
|---|---|
| Component | Route error mappers, `lib/withApi.js`, `lib/operationalLogger.js` |
| Root cause | Many routes return raw `err.message`; `withApi` logs `errorMessage` (not a redaction term); several routes use `console.error(err.message/stack)`. |
| Evidence | `app/api/orders/[id]/route.js:40-57`; `orders/[id]/status/route.js:15-29`; `lib/withApi.js:45-60`; `lib/operationalLogger.js:17-45`; `app/api/payment-info/route.js:40,76,114,154`. Previously SEC-11. |
| Fix status | **Not fixed — broad but mechanical change.** |
| Verification | SOURCE-INSPECTED. |
| Remaining risk | Internal detail (collection names, driver errors, stack fragments) can reach clients or logs unredacted. |
| Action | Return stable `code` + generic message; route all logging through `logEvent` and add `errorMessage`/`stack` to sensitive redaction. |

#### F-20 — No Content-Security-Policy (LOW)

| Field | Detail |
|---|---|
| Component | `next.config.mjs` |
| Root cause | Security headers are present (nosniff, DENY frame, referrer, permissions, HSTS) but no CSP. |
| Evidence | `next.config.mjs:28-42`. Previously SEC-13. |
| Fix status | Not fixed. |
| Verification | VERIFIED locally (headers observed, CSP absent). |
| Remaining risk | Reduced XSS containment. |
| Action | Ship a report-only CSP first, then enforce. |

#### F-21 — Order-number fallback can collide (LOW-MEDIUM)

| Field | Detail |
|---|---|
| Component | `lib/orderService.js` `genOrderNumber` |
| Root cause | If the counter collection is unreachable, the fallback is `ORD-${Date.now().toString(36)}`; two orders in the same millisecond collide, and `orderNumber` is not unique. |
| Evidence | `orderService.js:205-223`; `Order.js:163` (non-unique index); `orderService.js:729-733`; `cashierReport.js:90-95`. |
| Fix status | Not fixed (requires a deliberate numbering policy change). |
| Verification | SOURCE-INSPECTED. |
| Remaining risk | During a counter outage with same-millisecond concurrency, one order becomes unreachable by number and is dropped from menu-item report counts. |
| Action | Add a random/process suffix to the fallback and/or enforce a unique index on `orderNumber` via the approved index process. |

#### F-22 — Report time-boundary inconsistency (INFO — owner decision)

`lib/analytics.js:277-285` and `cashierReport.js` bucket revenue by `createdAt`; waiter analytics
buckets by `paidAt`/`paymentVerifiedAt` (`manager/waiter-analytics/route.js:181-188`). The same
period yields different totals across screens. The route documents this in `meta`. Resolving it
is a financial-policy decision, not a code patch. **Action:** owner defines the canonical revenue
date and the reports are aligned.

#### F-23 — Hotel subsystem residual items (LOW/MEDIUM)

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-23a | MEDIUM | Hotel rate limiting is per-process/volatile (E-04); absent the trusted header all traffic shares one `untrusted` bucket. | Open, documented (`lib/hotel/auth/rateLimit.js:13-35`) |
| F-23b | LOW | Self-service PIN change revokes all sessions server-side but the modal never refreshes, so a stale authenticated UI persists until the next 401. | Open (`HotelChangePinModal.jsx:68-76`) |
| F-23c | LOW | Staff deactivation treats session-revocation failure as non-fatal and still reports success, unlike PIN reset. | Open (`staff/[id]/status/route.js:60-83`) |
| F-23d | LOW | Lockout-crossing audit event can be missed/duplicated under concurrent wrong PINs (stale pre-attempt snapshot). | Open (`login/route.js:90-120`, `credential.js:117-162`) |
| F-23e | LOW | Atomic lockout uses a pipeline update requiring MongoDB ≥4.2; failure is swallowed so lockout silently never engages on older servers. | Open, deployment-dependent |
| F-23f | INFO | Unique indexes defined but not deployed (`autoIndex:false`). | Covered by F-08 |
| F-23g | INFO | CORS preflight omits `x-hotel-csrf-token`, so an explicitly allowed cross-origin frontend would fail mutations. | Open, config |
| F-23h | INFO | Docs still reference removed `UsersUI`/`/hotel/users`; `management/page.js` missing from the route inventory. | Documentation drift |

No CRITICAL or HIGH authentication bypass, cross-role page access, or unauthenticated Hotel
endpoint was found. All 36 Hotel endpoints authenticate; role checks use live `HotelUser.role`;
direct Manager-route access with a Receptionist session is server-redirected. 484 Hotel tests pass.

#### F-24 — Documentation claims production readiness (MEDIUM)

`README.md:3` states "Production-ready" while every readiness document and this audit conclude
otherwise. **Action:** correct the README status before release; misleading status is itself a
governance risk.

---

## E. Changes made in this audit

| # | File | Change | Risk | Tests |
|---|---|---|---|---|
| 1 | `lib/safeNavigation.js` *(new)* | Pure internal-redirect sanitizer. | None — new, unused elsewhere. | `tests/safe-navigation.test.mjs` |
| 2 | `app/login/page.js` | Sanitize `next` before role resolution. | Low | 2 wiring tests |
| 3 | `app/components/PinGuard.js` | Sanitize navigation target; added `fallbackTarget`. | Low | 1 wiring test |
| 4 | `app/api/auth/verify-pin/route.js` | HMAC-SHA256 derived-cache key with process-local salt. | Low — identical verification semantics. | 1 contract test |
| 5 | `lib/reportService.js` | Cache hit returns a shallow copy. | Low | 1 contract test |
| 6 | `app/api/manager/analytics/route.js` | Annotate a response copy, not the cached object. | Low | 1 contract test |
| 7 | `app/api/orders/route.js` | Station item-type filter derived from live role. | Low — UI already sends `dest`. | 1 contract test + 3 station suites |
| 8 | `app/api/orders/[id]/route.js` | Require `paymentMethod` for MANAGER `SERVED → PAID`. | Low — only rejects an under-specified call. | 1 contract test + payment suites |
| 9 | `app/api/orders/[id]/status/route.js` | Same guard on the status alias. | Low | same |
| 10 | `tests/safe-navigation.test.mjs` *(new)* | 6 tests / 15 assertions. | — | — |
| 11 | `tests/production-remediation-2026.test.mjs` *(new)* | 5 source-contract tests. | — | — |

**Not changed, deliberately:** payment-info visibility, SSE payloads, manager step-up, idle
policy, rate-limit architecture, CSP, report time boundaries, and every index/backup/monitoring
configuration. Each is either a business decision or an owner-approved infrastructure operation.

**Style conformance:** the new module is a pure, dependency-free helper in the same style as
`lib/pwa.js` and `lib/stationStatus.js`; the tests follow the existing DB-free
`node:test` + source-contract pattern used across `tests/*.test.mjs`.

---

## F. Verification results

All commands were run from `C:\hotelms` on this machine. Database URIs were blanked in the
shell for build and smoke so no connection could be opened; `.env.local` was never opened.

| Check | Command | Result |
|---|---|---|
| Full DB-free suite | `node --test --test-reporter=spec "tests/*.test.mjs"` | **2,524 tests / 409 suites — 2,524 pass, 0 fail, 0 skipped** (~80 s) |
| New regression tests | same, two new files | **11 tests / 6 suites — 11 pass, 0 fail** |
| Opt-in integration | `node --test "tests/integration/*.integration.test.mjs"` (disposable local replica set) | **32/32 pass** |
| Hotel suite | `node --test tests/hotel-*.test.mjs` | **484/484 pass** (reported by Hotel audit) |
| Lint | `npx eslint .` | **0 errors, 3 pre-existing warnings** (`MenuCrudClient.jsx:161`, `menu/page.js:385`, `ethiopianCalendar.js:622`) |
| Production build | `$env:MONGODB_URI='';$env:CAFEDB_URI='';$env:ROOM_MONGODB_URI=''; npm run build` | **Success**, compiled in 32.1 s, all routes generated, no DB connection |
| Local production smoke | `next start -p 3100` with URIs blanked | see below |

**Smoke results (VERIFIED):**

| Path | Status |
|---|---|
| `/` | 200 |
| `/pos` | 200 |
| `/room` | 200 |
| `/menu` | 200 |
| `/hotel` | 404 (by design — no index page) |
| `/hotel/reception` | 200 |
| `/api/health?live=1` | 200 |
| `/api/health` | 200 |
| `/api/orders` (unauthenticated) | 401 |
| `/manifest.json` | 200 |

**Headers observed on `/`:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
`Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`. **No CSP** (F-20).

**Health body:** `{"service":"bono-pos","status":"alive","checks":{},"uptimeSeconds":7,"timestamp":"..."}`
— no hosts, credentials, URIs, or stack traces. `/api/health` sets `cache-control: no-store`.

**Not verified (explicitly):** staging behavior, production topology/replica-set mode, transaction
concerns, index presence in any live DB, backup/restore, RPO/RTO, load and failover behavior,
monitoring delivery, DNS/TLS ownership, Netlify runtime Node version, and any behavior requiring
real data.

---

## G. Release blockers (must close before deploy)

| # | Blocker | Owner | Exit criterion |
|---|---|---|---|
| B1 | No verified staging environment (F-06) | Owner + ops | Isolated staging app + DB provisioned; G-PAY-1 15/15 executed and signed |
| B2 | No backup/PITR/restore/RPO/RTO (F-07) | Owner + finance | Mechanism + retention + RPO/RTO approved; isolated restore drill passed and independently verified |
| B3 | Zero DB-verified indexes (F-08) | Owner + DBA | Duplicate preflight clean; indexes deployed with approval refs; `getIndexes()` matches plan |
| B4 | No monitoring/alerting/on-call (F-09) | Ops | `/api/health` monitored, alerts routed, on-call named, runbook published |
| B5 | No CI / promotion / rollback (F-10) | Eng | CI runs full suite + integration job; artifact promoted; rollback rehearsed |
| B6 | Artifact not reproducible from VCS (F-11) | Owner | Working tree committed in reviewed commits (EXTERNAL deletions preserved); release tagged |
| B7 | Unpinned Node + plugin (F-12) | Eng | `engines.node`/`NODE_VERSION` and plugin version pinned |
| B8 | Public bank-account disclosure undecided (F-13) | Owner | Decision recorded; if accepted, cache header removed and risk accepted in writing |
| B9 | Optional manager step-up (F-15) | Owner | Step-up enforced, or documented risk acceptance |
| B10 | No CSP (F-20) | Eng | Report-only CSP shipped, then enforced |

B1–B7 are non-negotiable for any production release. B8–B10 may be explicitly risk-accepted by
the owner with a recorded signature; they cannot be silently ignored.

---

## H. Deployment checklist and plan (not executed)

**Gate 0 — Provision and prove the environment**
- [ ] Pin Node (`engines.node` + `NODE_VERSION`) and `@netlify/plugin-nextjs`.
- [ ] Add all environment variables **by name only**: `MONGODB_URI`, `CAFEDB_URI`, `AUTH_SECRET`, `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `ROOM_MONGODB_URI`, `HOTEL_SESSION_SECRET`, optional `ALLOWED_ORIGINS`, `HOTEL_ALLOWED_ORIGINS`.
- [ ] Confirm `ROOM_MONGODB_URI` ≠ `MONGODB_URI` and both resolve to `bono_hotel` / `hotel_management` as intended.
- [ ] Provision an isolated staging app + isolated Mongo replica set; confirm domain/DNS/TLS ownership.
- [ ] Extend boot validation so `AUTH_SECRET`, `ROOM_MONGODB_URI`, and `HOTEL_SESSION_SECRET` fail fast in production, not only `MONGODB_URI`.

**Gate 1 — Infrastructure proofs (staging only)**
- [ ] Confirm replica-set/mongos topology and transaction support (`hello` / `rs.status`).
- [ ] Record explicit read/write concerns and a transaction budget.
- [ ] Reconcile the `socketTimeoutMS: 30000` vs ~5 s gateway deadline mismatch.
- [ ] Run read-only index inventory and duplicate preflight.
- [ ] Pool-saturation and failover drills.

**Gate 2 — Index deployment (separate change windows)**
- [ ] `--dry-run` review for POS, Hotel, and Inventory V2 plans.
- [ ] Staging `--confirm` with approval refs.
- [ ] Production `--confirm --allow-production` with `POS_INDEX_DEPLOY_APPROVAL` / `HOTEL_INDEX_DEPLOY_APPROVAL` / `INVENTORY_V2_INDEX_DEPLOY_APPROVAL`.
- [ ] Manually drop the obsolete `StockMovement (refOrderId, reason)` index only in a separately approved window.
- [ ] Verify `getIndexes()` before/after; never use `syncIndexes()`.

**Gate 3 — Backup and recovery**
- [ ] Choose mechanism (Atlas continuous backup / PITR), encryption, retention, RPO/RTO; record the decision.
- [ ] Run an isolated restore drill: verify `counters.order_seq`, unique indexes, PAID/ARCHIVED evidence, and clean reconciliation.
- [ ] Name a restore owner; independent verifier signs.
- [ ] Keep destructive operations (`clear-orders`, `clean-order-history.js`) disabled in production.

**Gate 4 — Observability and CI**
- [ ] External uptime monitor on `/api/health`; alert routing; named on-call; runbook.
- [ ] Ship structured logs; add error tracking.
- [ ] CI: full DB-free suite + disposable-Mongo integration job on every change.
- [ ] Correct `README.md` status (F-24).

**Gate 5 — Staging rehearsal**
- [ ] Execute the 15-case G-PAY-1 checklist.
- [ ] Functional, security, load, restore, and rollback drills within the approved RPO/RTO.
- [ ] Finance signs the financial gates.

**Gate 6 — Production release (POS V1 / Track A only)**
- [ ] Deploy the exact artifact that passed staging (commit + tag from B6).
- [ ] Verify environment by key name only — never print values.
- [ ] Post-deploy smoke: `/api/health`, staff login/logout, one order per station, one payment + report, one reservation.
- [ ] Observe error rate and latency; owner signs acceptance.
- [ ] Hotel and Inventory V2 remain on their own tracks with their own gates — **do not bundle**.

**Rollback:** redeploy the previous tagged artifact, restore the previous env set, verify
`/api/health` and one read path; database rollback is restore-based only and requires the Gate 3 drill.

---

## I. Preservation report

| Requirement | Status |
|---|---|
| No staging / commit / push / stash / reset / clean / checkout / revert | **Complied.** `git diff --cached --name-only` → 0 entries. No git write command was issued. |
| Branch and HEAD unchanged | `main` @ `6965043` — unchanged. |
| User work preserved | 262 working-tree entries remain exactly as found; nothing normalized or discarded. |
| Three EXTERNAL files remain deleted | `D app/api/external-items/route.js`, `D app/api/external-sales/route.js`, `D lib/models/ExternalItemRequest.js` — intact and unstaged. |
| `C:\bonosm` untouched | Read-only throughout; not a git repo; no writes. |
| No production DB access | No connection opened. Build and smoke ran with `MONGODB_URI`, `CAFEDB_URI`, `ROOM_MONGODB_URI` blanked. |
| No migration / backfill / index creation / backup / restore / deploy | None performed. |
| No secret exposure | No secret value read, printed, or copied; only key *names* recorded. `.env.local` and `.env.development.local` never opened. |
| No business policy or inventory architecture change | None. Four code fixes + one payment validation guard only. |
| New files added | `lib/safeNavigation.js`, `tests/safe-navigation.test.mjs`, `tests/production-remediation-2026.test.mjs`, and this report. |

---

## J. Final decision

# NOT READY FOR DEPLOYMENT

**Why.** Functional readiness is strong — 2,524 passing tests, 32/32 integration proofs, 0 lint
errors, a clean production build, correct smoke behavior, and no CRITICAL/HIGH authentication
bypass in either subsystem. Five real defects were found and fixed with regression protection.

Operational readiness is not. There is no verified staging environment, no backup or restore
evidence, no approved RPO/RTO, no database-verified index, no monitoring, no CI, no rollback
runbook, and no reproducible release artifact. Those are not polish items; they are the
difference between "the software works" and "the business can safely run on it."

**What would change the verdict.** Closing B1–B7 and explicitly resolving or accepting B8–B10
would move this to **READY AFTER SPECIFIC BLOCKERS** — a state reachable without further code
changes, because the remaining work is infrastructure, evidence, and sign-off.

**Recommended next action.** Schedule the Gate 0–Gate 3 work with the owner. Do not deploy until
B1–B7 are signed. Treat the current working tree as the release candidate, commit it in reviewed
pieces, and deploy only the artifact that passes staging.

---

*End of report. No deployment was performed. No production system was contacted. No secret was exposed.*
