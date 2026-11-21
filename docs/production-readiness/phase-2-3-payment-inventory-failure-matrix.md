# Phase 2.3 — Payment and Inventory Failure Matrix

Status: **VERIFIED AGAINST SOURCE + DISPOSABLE REPLICA SET; ONE ROW IS SOURCE-ONLY**
Date: 2026-11-08
Companion: `phase-2-3-transaction-concurrency-report.md`

Legend:

- **PASS (real)** — proved with a real MongoDB replica set, real sessions, real writes.
- **PASS (unit)** — proved by DB-free pure-rule or source-contract tests.
- **SOURCE-ONLY** — behavior is established by code inspection; no real-concurrency test exists yet.
- **N/A** — boundary does not exist in this codebase.
- **ACCEPTED** — behavior is deliberate and documented; not a defect.
- **RESIDUAL** — a real gap remains and is tracked in `phase-2-3-deferred-risks.md`.

| # | Scenario | Reproduction / race window | Required invariant | Observed outcome | Evidence | Verdict |
|---|---|---|---|---|---|---|
| 1 | **Duplicate payment request, same method** | Two simultaneous `payOrder`/`confirmPayment` requests for one order | One `PAID` state, one `paidAt`, one deduction, one payment method | Second write matches `status: { $in: [...,"PAID"] }`; `paidAt` preserved by `$cond`; consumption sees `CONSUMED` and skips | Real test “concurrent duplicate payment leaves one payment and one deduction”; DB-free payment contract | **PASS (real)** |
| 2 | **Duplicate provider callback / webhook** | External provider retries a settlement callback | Provider event identity must make the callback idempotent | No provider exists: no webhook route, no callback signature, no provider transaction ID. The internal equivalent (`confirmPayment` retry) matches only `PAYMENT_PENDING`; a second call returns “Order already paid” | Repository-wide audit; source `confirmPayment`; DB-free contract | **N/A (documented)** |
| 3 | **Duplicate payment retry with a different method/account** | Retry after a lost response uses `CASH` then `TRANSFER` (or a different account) | A retry must not create a second payment or change historical financial identity | Status stays `PAID`, `paidAt` is preserved, and the first account snapshot is preserved. However, a valid retry **can overwrite `paymentMethod`** because the pipeline sets it whenever supplied. No duplicate financial row exists | Source `payOrder` pipeline; not covered by a dedicated real test | **RESIDUAL** |
| 4 | **Crash / failure after payment commit, before inventory** | `payOrder` commits `PAID`; `consumeOrderInventory` then fails (forced idempotency-key collision in the test) | Payment remains `PAID`; no permanent hold leaks; no false `SaleDeduction`; failure is observable | Order is `PAID` with `paidAt`; hold is released (`reservedStock` 0); reservation `RELEASED`; zero `SaleDeduction`; error logged | Real test “payment commits even when inventory fails…” | **PASS (real) / ACCEPTED** |
| 5 | **Crash mid-consumption transaction (partial write)** | Transaction decrements stock, then a later write fails | No partial stock change, no partial movement, reservation unchanged | Conditional decrement, movement insert, and CONSUMED finalize are one transaction; failure aborts all three. Stock and hold remain 5/5, reservation `RESERVED`, zero movements | Real test “a failure after the stock decrement rolls the whole consumption back” | **PASS (real)** |
| 6 | **Lost payment response** | Client does not receive the success response and retries | A retry adopts the committed payment; no second payment effect | Same as row 1: atomic PAID retry path, preserved `paidAt`, idempotent consumption | Real test row 1; DB-free contract | **PASS (real)** |
| 7 | **Lost inventory response** | Consumption commits but the caller receives an error / loses the response | A retry must detect the committed `CONSUMED` state and not deduct again | After a synthetic unknown commit, authoritative stock is 0/0, one movement exists, reservation `CONSUMED`; retry returns `success:true, skipped:true` with still one movement | Real test “an unknown commit after a successful deduction is recovered without a duplicate” | **PASS (real)** |
| 8 | **Unknown transaction commit result** | Driver throws `UnknownTransactionCommitResult` after the server committed | Never blindly retry an unknown commit; resolve from durable evidence | `runInTransaction` retries only `TransientTransactionError`; unknown commit is rethrown. Recovery reads reservation/stock/movement evidence. Reservation ensure test adopts the existing row and hold | Real tests “unknown commit result is not retried…” and row 7; DB-free helper contract | **PASS (real)** |
| 9 | **Crash during recovery (retry after unknown commit)** | Recovery process dies after an unknown commit and is run again | Recovery must be idempotent and evidence-driven; no duplicate hold/deduction | Re-running reservation ensure finds the unique `orderId` row and does not add a second hold. Re-running consumption sees `CONSUMED`/one movement and skips. No blind `$inc` is used | Real tests rows 5 and 7 (repeat calls); source claim/filter audit | **PASS (real)** |
| 10 | **Concurrent consumption of the last unit by two orders** | Two paid orders each hold 1 unit; only 1 physical unit exists | At most one deduction, stock never negative, reserved stock never negative | Conditional `currentStock >= consumeQty` and `reservedStock >= consumeQty`; one order deducts, the other conflicts/skips; final stock 0, exactly one movement totalling 1 | Real test “concurrent last-unit consumption never goes negative…” | **PASS (real)** |
| 11 | **Concurrent duplicate consumption of the same order** | Two payment/preparation paths consume the same reservation simultaneously | One deduction, one movement, one `CONSUMED` | Atomic `CONSUMING` claim: one caller owns it; the other sees `CONSUMING`/`CONSUMED` and skips. One movement with `sale:<orderId>:<inventoryItemId>` | Real test “concurrent duplicate consumption deducts stock and writes one movement” | **PASS (real)** |
| 12 | **Concurrent duplicate reservation creation** | Two requests (create + PREPARING gate) reserve the same order simultaneously | One reservation document, one hold per item | Transaction + unique `orderId`; both calls return the same reservation; `reservedStock` is 2, not 4 | Real test “concurrent reservation creation holds stock exactly once” | **PASS (real)** |
| 13 | **Order mutation race (edit / line cancel vs preparation or payment)** | Waiter edits or cancels a line while a station starts PREPARING, or payment commits | The winning state must not be partially overwritten; no lost payment; no stock from a cancelled line | `editOrderItems` requires `status:"PENDING"` in the write filter. `cancelOrderItem` excludes terminal states in the array filter and uses a guarded derived-status write (`updatedAt`, `$nin:["CANCELLED","PAID"]`). Payment terminal writes re-check status | Source-only contract tests; not exercised under real concurrent writers | **SOURCE-ONLY** |
| 14 | **Cancellation race (manager cancel / KDS archive vs payment)** | Payment commits between the cancel/archive pre-read and write | A committed `PAID` order can never become `CANCELLED`/`ARCHIVED`; `paidAt` evidence survives | Phase 2.3 adds `status: { $nin: [...] }` to both writes. 15 cancel iterations and 10 archive iterations ended either `PAID` with `paidAt` or the non-paid terminal state with `paidAt: null` | Real tests “payment and manager cancellation race…” and “payment and archive race…” | **PASS (real)** |
| 15 | **Insufficient stock at reservation and at preparation** | Request exceeds available stock; or physical stock changes before preparation | Hold only what exists; shortage is an approval record, never negative stock; preparation blocks until held or approved | `planCoverage` holds available quantity and reports shortage; PREPARING calls `assertOrderInventoryReady`; approved shortages stay on the reservation. Consumption clamps to physical/held/required and aborts on a lost conditional race | DB-free pure-rule tests + real last-unit/rollback tests + source gate | **PASS (unit + real for consumption)** |
| 16 | **Refund / reversal retry (post-preparation void)** | Cancellation or line void is retried after stock was consumed | One void record, one `SaleDeduction`→`Waste` reclassification, stock never restored | Filter `voids.lineId $ne` / `voids.source $ne "ORDER"` deduplicates; second call is a no-op; stock stays 8; one movement remains, now `Waste` | Real test “post-preparation void retries are idempotent…” | **PASS (real)** |

> The table contains 16 rows because the refund/reversal case was kept separate from cancellation racing. Rows 1–15 are the required fifteen-case matrix; row 16 is an additional financial-reversal case.

---

## Extended checks (outside the 15-case matrix)

| Check | Result | Evidence |
|---|---|---|
| Unsupported standalone topology | **503 / `TRANSACTIONS_UNAVAILABLE`**, stock unchanged | Real test “unsupported standalone topology fails closed…” |
| Transient commit failure | Bounded retry (max 3 attempts), one committed hold, all sessions ended | Real test “transient commit failure is retried…” |
| Concurrent release | Hold returned exactly once; second/third release no-op | Real test “concurrent release returns the hold exactly once” |
| Target safety | Non-phase DB, credentials, and application port rejected before any write | Real guard tests |

---

## What the matrix deliberately does not claim

- It does not prove multi-node replica-set failover, network partitions, or rolling elections.
- It does not prove production backup/PITR restore behavior.
- It does not prove an external payment provider integration (none exists).
- It does not prove UI behavior or operator response to alerts.
- Row 13 is source-verified but not proven under real concurrent writers.
- Row 3 is a genuine metadata-idempotency gap for an already-PAID retry with a different valid method; it needs an owner decision.
