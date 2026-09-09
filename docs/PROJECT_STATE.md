# Project state

**Canonical repository:** `/workspace/artifacts/due`  
**Version:** 0.3.2 — Slices 1–3 recreated and verified  
**Verified:** 2026-09-08

## Verification

| Check | Result |
| --- | --- |
| `tsc --noEmit` | exit 0 |
| lint | ok |
| `npm test` (PGlite) | **37 passed**, 0 failed |
| Server smoke | GET / → 302 /signup; GET /signup → 200 |

## Included

### Slice 1 — Receivables
Auth, multi-tenant business, customers, receivables, payments, overpayment reject, cancel after partial (history preserved), dashboard aging, tenant isolation, idempotency keys.

### Slice 2 — Reminder engine
ReminderRule, Reminder, ReminderAttempt; default T-2/T0/T+2/T+7/T+14; business-local 09:00; SKIP LOCKED worker (Postgres); demo provider; payment/cancel stop; due-date reschedule; partial payment keeps reminders with balance-at-send; bounded retry.

### Slice 3 — Email (Resend)
Resend behind `MessagingProvider`; attempt snapshots; retriable/permanent failures; webhook signature helpers + delivery events; fail-closed config. **Live Resend smoke: NOT VERIFIED**.

## Stack
Modular monolith · TypeScript · Drizzle · PostgreSQL (PGlite local) · MessagingProvider (demo default | Resend)

## Not started
WhatsApp, SMS, Paystack, Flutterwave, AI, subscriptions, native apps, customer portal.
