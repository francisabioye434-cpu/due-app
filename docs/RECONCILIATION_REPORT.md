# Slice 1–3 Verification Reconciliation

**Date:** 2026-09-09  
**Canonical:** `/workspace/artifacts/due`  
**Base commit:** `a32be2d` (pre-reconciliation)  
**Question:** Was the drop 75 → 37 tests consolidation (A) or lost coverage (B)?

## Verdict

**Mostly A (consolidation), with material B (gaps).**

Many of the historical ~75 tests were multi-assert unit cases later folded into broader integration tests (37). That preserved a large share of behavior, but **named requirements below were implemented and untested** (or only partially exercised) until this gate.

## Summary counts

| Metric | Count |
| --- | --- |
| Behavioral requirements reviewed | **61** |
| Already covered before gap-fill (existing 37 tests) | **42** |
| Missing / weak before gap-fill | **19** |
| Gap-fill tests added | **19** (`tests/reconciliation.test.ts`) |
| Defects found | **1** (concurrent payment race without re-read/transaction) |
| Defects fixed | **1** (`recordPayment` transactional re-read of outstanding) |
| Final automated tests | **56 passed** |
| Real PostgreSQL concurrency re-verify | **NOT REVERIFIED** (PG not available in workspace this run) |

## Recommendation

**RECONSTRUCTION VERIFIED** for Slice 1–3 *behavioral coverage on PGlite*, with the explicit caveat that **SKIP LOCKED / payment races are not re-proven on real PostgreSQL in this run**.

---

## Coverage matrix

Legend: **V** = VERIFIED BY EXISTING TEST · **M** = VERIFIED BY MULTIPLE EXISTING TESTS · **G** = gap-fill test added this gate · **I** = implemented, previously untested · **N** = not verified

### Slice 1

| Requirement | Classification | Evidence |
| --- | --- | --- |
| authentication | **G** (login); register was V | `recon: login…`; register in slice1 |
| atomic business + owner creation | **G** | membership owner + default rule |
| tenant isolation | **V** | slice1 tenant isolation |
| customer CRUD | **G** (create/list/get; no update/delete API) | recon customer test |
| receivable creation | **V** | slice1 |
| receivable idempotency | **V** | slice1 |
| business-local aging | **M**+**G** | overdue/upcoming existing; due_today + boundary G |
| partial payment | **V** | slice1 |
| full payment | **V** | slice1 |
| overpayment rejection | **V** | slice1 |
| payment idempotency | **G** | recon |
| concurrent payment safety | **G** + fix | recon + transactional re-read |
| dashboard totals | **M**+**G** | total/upcoming existing; overdue/dueToday/paidThisMonth G |
| cancellation | **V** | slice1 (unpaid path via recon cancel) |
| cancellation after partial | **V** | slice1 |
| payment after cancellation rejection | **G** | recon |
| cancel-paid rejection | **G** | recon |
| currency mismatch | **G** (payment inherits receivable currency) | recon |
| activity rollback/atomicity | **G** (events present; full rollback not simulated) | recon activity |
| financial invariants | **G** | recon outstanding = original − paid |

### Slice 2

| Requirement | Classification | Evidence |
| --- | --- | --- |
| default reminder schedule | **M** | offsets + schedule tests |
| idempotent scheduling | **V** | reminders.test |
| T-2 / T-0 / T+2 / T+7 / T+14 | **M** | DEFAULT_OFFSETS + schedule |
| 09:00 business-local conversion | **V** | Lagos 09:00 test |
| DST-aware timezone handling | **G** | America/New_York winter/summer |
| already-overdue creation policy | **V** | immediate schedule + planSchedule |
| reminder eligibility | **V** | worker runs |
| paid/cancelled skip | **M** | full pay / cancel tests |
| SKIP LOCKED worker claiming | **V** (code path); **N** on live PG this run | concurrent test branches on kind |
| concurrent workers | **V** (PGlite soft; PG hard asserts when available) | concurrent workers test |
| batch limits | **G** | batchSize: 1 |
| demo provider success/failure | **M** | many reminder tests |
| retry behavior | **V** | retriable then success |
| max retry cap | **V** | max attempts |
| partial payment uses remaining balance | **M** | reminder + email tests |
| full payment cancels future reminders | **V** | reminders.test |
| receivable cancellation cancels reminders | **V** | reminders.test |
| due-date rescheduling | **V** | reminders.test |
| sent history preservation | **G** | recon after updateDueDate |
| tenant isolation for reminders | **G** | recon |
| activity history | **G** | REMINDER_DEMO_SENT etc. |

### Slice 3

| Requirement | Classification | Evidence |
| --- | --- | --- |
| MessagingProvider abstraction | **M** | demo + resend + factory |
| Resend provider contract | **M** | email tests |
| missing destination | **M** | email + reminders |
| malformed email | **G** | customer invalid email |
| current balance at send time | **M** | email balance tests |
| partial-payment amount in content | **M** | 300,000 in body |
| paid/cancelled skip | **G** | zero provider calls |
| provider acceptance state | **V** | ok/accepted paths |
| provider message ID persistence | **G** | re_msg_42 on attempt |
| retriable vs non-retriable failures | **M** | email + reminders |
| retry cap | **V** | max attempts |
| immutable message snapshot | **V** | attempt bodySnapshot / destination |
| customer email changes not rewriting old attempts | **V** | email.test |
| concurrent worker duplicate prevention | **V** (PGlite soft) | concurrent workers |
| production config fail-closed | **M** | config tests |
| demo safe default | **M** | config + factory |
| no silent email→demo fallback | **G** | factory throws |
| webhook signature verification | **M** | webhooks.test |
| duplicate webhook idempotency | **G** | recordResendEvent twice |
| tenant isolation for email attempts | **V** | email isolation |

## Code change this gate

- `src/app/services.ts` — `recordPayment` re-reads outstanding inside a transaction when available (financial race fix).
- `tests/reconciliation.test.ts` — 19 gap-fill tests.

## Not in scope

- Resend live verification  
- Slice 4 / WhatsApp  
