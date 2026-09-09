# PostgreSQL Reverification Gate

**Date:** 2026-09-09  
**Engine:** PostgreSQL **16.2** (local test instance, port 55432)  
**Database:** `due_test`  
**Migrations:** 001_init → 002_reminders → 003_email_channel — **applied**

## Required cases

| Case | Result |
| --- | --- |
| Concurrent full 300k+300k | **PASS** — 1 success, 1 OVERPAYMENT, paid=300k, outstanding=0 |
| Concurrent partial overrun 300k+300k on 500k | **PASS** — total paid=300k ≤ 500k, outstanding=200k |
| Complementary 300k+200k on 500k | **PASS** — both succeed, paid=500k, outstanding=0 |
| Two workers / one reminder (SKIP LOCKED) | **PASS** — 1 send, 1 succeeded attempt |
| Batch workers (batchSize 3) | **PASS** — no duplicate claims, limits respected |
| Payment/reminder race | **PASS** — zero provider sends after full pay |

## Suite

| Check | Result |
| --- | --- |
| typecheck | exit 0 |
| lint | ok |
| Full suite on PostgreSQL | **63 passed**, 0 failed |
| PGlite-only path | still available when `DATABASE_URL` unset |

## Code changes this gate

- `recordPayment`: `SELECT … FOR UPDATE` inside transaction (falls back if unsupported)
- `tests/pg_concurrency.test.ts`: dedicated PG gate (skips when not postgres)

## Remaining concurrency risks

- PGlite still cannot prove SKIP LOCKED (no row locks) — production must use PostgreSQL
- Very high contention under SERIALIZABLE vs READ COMMITTED not stress-tested beyond dual concurrent ops
- Cross-process multi-host workers not exercised (same DB, two connections/pools in one process)

## Recommendation

**POSTGRES VERIFIED**
