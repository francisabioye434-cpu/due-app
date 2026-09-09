# Changelog

## 0.3.4 — 2026-09-09
- PostgreSQL 16.2 concurrency reverify gate
- `recordPayment` uses FOR UPDATE inside transactions
- `tests/pg_concurrency.test.ts` (7 cases)
- Full suite: 63 passed on real PostgreSQL

# Changelog

## 0.3.3 — 2026-09-09
- Slice 1–3 verification reconciliation
- Added `tests/reconciliation.test.ts` (19 gap-fill tests)
- Hardened `recordPayment` with transactional outstanding re-read
- Suite: 56 tests on PGlite

# Changelog

## 0.3.2 — 2026-09-08
- Recreate Slices 1–3 in canonical `/workspace/artifacts/due`
- Full docs: constitution, development, database, slice reports, email provider
- package-lock.json present for reproducible installs

## 0.3.1 — 2026-09-08
- SKIP LOCKED claim hardened; cancel processing+scheduled; 37 tests on PGlite + PG

## 0.3.0
- Email channel (Resend) + reminder engine + receivables core

## 0.2.0
- Slice 1 vertical slice
