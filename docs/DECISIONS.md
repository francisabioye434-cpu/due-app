# Architecture decisions

## ADR-001 Modular monolith
Single Node deployable. Services own domain; HTTP is thin. No microservices in V1.

## ADR-002 Money as integer minor units
Kobo bigint. Reject overpayments. No silent clamps or V1 customer credits.

## ADR-003 Business tenancy
Every query scoped by `business_id` via membership checks. Server-side only.

## ADR-004 Reminder schedule via ReminderRule
Default offsets in `offsets_json`. Partial unique index on active schedule keys.

## ADR-005 Worker claim FOR UPDATE SKIP LOCKED
Postgres production path. PGlite uses optimistic claim (dev/tests).

## ADR-006 MessagingProvider abstraction
Demo default. Resend is one implementation. Financial truth never in providers.

## ADR-007 Resend for Slice 3 email
HTTP API + Idempotency-Key. Accepted ≠ delivered. Webhooks for delivery events.

## ADR-008 Cancel processing + scheduled on pay/cancel
Reduces race windows with the worker.

## ADR-009 Production config fail-closed
Explicit `DUE_MESSAGING_PROVIDER` in production; email mode requires credentials; CSRF Origin required in production.
