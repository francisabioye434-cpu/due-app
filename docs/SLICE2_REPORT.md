# Vertical Slice 2 Report — Durable Reminder Engine

**Date:** 2026-09-08  
**Canonical project:** `/workspace/artifacts/due`  
**Status:** READY FOR SLICE 3 (with caveats below)

## What was implemented

- **ReminderRule** per business (default offsets policy as JSON)
- **Reminder** durable rows with schedule_key, status machine, attempt_count, next_attempt_at
- **ReminderAttempt** append-only delivery history with body snapshot
- Idempotent schedule generation on receivable create (partial unique index on active keys)
- Worker with **FOR UPDATE SKIP LOCKED** claim on real PostgreSQL; optimistic claim on PGlite
- Demo messaging provider (in-process only; never real delivery)
- Hooks: createBusiness → default rule; createReceivable → schedule; full payment / cancel → cancel unsent; due-date change → cancel + reschedule
- Partial payment: reminders remain; body uses outstanding balance at send time
- Bounded retry (max 3 attempts, next_attempt_at delay)
- Activity events for sent / failed / cancelled
- CLI: `npm run reminders:work`

## Reminder data model

| Entity | Purpose |
| --- | --- |
| `reminder_rules` | Policy: name, is_default, enabled, offsets_json |
| `reminders` | One row per (receivable, rule, schedule_key) while active |
| `reminder_attempts` | Each dispatch attempt + snapshot |

**Statuses:** `scheduled` → `processing` → `sent` | `failed` | `cancelled`

**Partial unique index:** `(receivable_id, rule_id, schedule_key) WHERE status <> 'cancelled'`

## Reminder state machine

```
scheduled  --claim-->  processing  --ok-->  sent
                           |
                           +--retriable fail--> scheduled (next_attempt_at)
                           +--terminal fail--> failed
                           +--paid/cancelled recheck--> cancelled
```

## Scheduling algorithm

- Default offsets: **T-2, T-0, T+2, T+7, T+14** (stored in rule, not hard-coded in worker)
- Wall time: **09:00 business-local** converted to UTC (`localNineAmToUtc`)
- If due date already past: insert **immediate** slot at `now` + remaining future overdue offsets
- Skip historical pre-due slots
- Idempotent insert (unique conflict ignored)

## Worker architecture

- `ReminderWorker.run({ businessId? })`
- Claim batch (default 25)
- Per claim: re-check receivable outstanding / cancelled before provider.send
- Record attempt always; update reminder status; write activity event
- Catch-all: return reminder to `scheduled` with next_attempt_at (avoid stuck processing)

## PostgreSQL claim strategy

```sql
WITH picked AS (
  SELECT id FROM reminders
  WHERE status = 'scheduled'
    AND scheduled_for <= $now
    AND (next_attempt_at IS NULL OR next_attempt_at <= $now)
  ORDER BY scheduled_for
  LIMIT $batch
  FOR UPDATE SKIP LOCKED
)
UPDATE reminders r SET status = 'processing', updated_at = $now
FROM picked WHERE r.id = picked.id
RETURNING r.id;
```

## Retry policy

- `MAX_REMINDER_ATTEMPTS = 3`
- `DEFAULT_RETRY_DELAY_MS = 60_000`
- Non-retriable failures (e.g. MISSING_DESTINATION) → terminal `failed` immediately

## Payment / reminder race handling

1. `recordPayment` when outstanding becomes 0 → `cancelFutureReminders` (scheduled **and** processing)
2. Worker `processOne` re-checks outstanding before send → cancel if paid/cancelled
3. Known residual race: provider already accepted after re-check — demo-only acceptable; Slice 3 should use idempotency keys at provider

## Due-date rescheduling

`updateDueDate` → cancel unsent (`due_date_changed`) → regenerate schedule for new due date (same-date still regenerates for consistency)

## Demo provider behavior

- `DemoMessagingProvider`: in-memory `sent[]`, optional forced failures
- Channel `demo`, name `demo`
- Never contacts external network
- Activity type: `REMINDER_DEMO_SENT`

## UI added

- Services API: `listReminders`, `getReminder` (with attempts)
- HTTP surfaces from Slice 1 continue to serve dashboard; reminder detail available via services layer
- Worker CLI for ops smoke

## Tests run and exact results

### PGlite (no DATABASE_URL)

```
# tests 37
# pass 37
# fail 0
```

### Real PostgreSQL 16.2 (`postgres://due@127.0.0.1:55432/due_test`)

```
# tests 37
# pass 37
# fail 0
```

Including: concurrent workers (SKIP LOCKED, no duplicate sends), payment-stop, cancel-stop, due-date reschedule, idempotent schedule, timezone 09:00 Lagos, retry, max attempts, attempt durability, partial payment balance body.

### Typecheck / lint

- `tsc --noEmit` → exit 0
- `node scripts/lint.mjs` → lint ok

### Smoke (real PG)

- Overdue receivable → immediate schedule → worker sent=1 demo body with ₦250,000.00
- Full payment → no further claims/sends

## Concurrency results

- Two parallel `ReminderWorker` instances on shared postgres pool
- 5 eligible immediate reminders → total sent ≤ 5, **no duplicate reminder ids**
- SKIP LOCKED partitions claims

## Files / migrations changed

- `migrations/002_reminders.sql` — rules, reminders, attempts, partial unique index
- `migrations/003_email_channel.sql` — delivery events table (forward-compat; Slice 3 surface already present)
- `src/db/schema.ts` — Drizzle tables
- `src/domain/reminders.ts` — planSchedule, body, offsets
- `src/domain/time.ts` — localNineAmToUtc
- `src/reminders/schedule.ts` — ensureDefaultRule, generate, cancel, reschedule
- `src/reminders/worker.ts` — SKIP LOCKED claim + processOne
- `src/reminders/work-cli.ts` — CLI entry
- `src/messaging/demo.ts` — demo provider
- `src/app/services.ts` — domain hooks
- `tests/reminders.test.ts` — expanded Slice 2 suite

## Remaining risks

1. **Post-recheck send race** — rare window after financial re-check before provider returns; mitigated by provider idempotency keys in Slice 3
2. **PGlite concurrency** — no real row locks; optimistic claim can double-send under parallel workers (production uses PostgreSQL only)
3. **Email channel code** already in tree (Resend abstraction) but live send **not** verified; Slice 2 treats demo as the only proven provider
4. **cancelFutureReminders** cancels processing, but an in-flight `processOne` after cancel update could still send if it already passed re-check (same residual race)
5. **No multi-rule UI** — single default policy only

## Recommendation

**READY FOR SLICE 3**

Slice 2 DoD met on real PostgreSQL: durable reminders, idempotent schedule, timezone, SKIP LOCKED claim, demo provider, attempt history, bounded retry, payment/cancel stop, due-date reschedule, partial payment amount at send, typecheck/lint green, 37/37 tests on PG + PGlite.

Do **not** begin WhatsApp/SMS/Paystack/subscriptions. Next slice should wire a real messaging channel behind `MessagingProvider` with explicit non-demo labels and production config gates.
