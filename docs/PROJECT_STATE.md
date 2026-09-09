# Project state

**Canonical:** `/workspace/artifacts/due`  
**Version:** 0.3.4 — PostgreSQL concurrency reverify  
**GitHub origin/main:** still at `a32be2d` until reconciliation + PG gate are committed

## Verification (2026-09-09)

| Check | Result |
| --- | --- |
| typecheck | exit 0 |
| lint | ok |
| npm test PGlite | 56+ (recon) |
| npm test PostgreSQL 16.2 | **63 passed** |
| PG concurrency gate | **7/7 passed** |
| Resend live | NOT VERIFIED |
| Slice 4 | not started |

See `docs/POSTGRES_REVERIFY.md` and `docs/RECONCILIATION_REPORT.md`.
