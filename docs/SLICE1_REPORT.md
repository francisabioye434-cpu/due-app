# Slice 1 — Receivables core

Registration → business → customer → receivable → dashboard aging → partial/full payment → cancel with history.

## Rules ratified
- Reject overpayments with clear outstanding balance error
- Cancel after partial keeps payments permanently; outstanding drops from active totals
- No reopen / payment void in V1

## Tests
Tenant isolation, authorization, receivable create, aging buckets, partial/full payment, overpayment, cancel, idempotency, timezone boundary, dashboard totals.
