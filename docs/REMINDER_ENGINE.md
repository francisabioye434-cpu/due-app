# Reminder engine

## Default schedule
Offsets: `-2, 0, +2, +7, +14` days relative to due date.  
Send time: **09:00** business-local → UTC.

## Entities
ReminderRule → Reminder (schedule_key) → ReminderAttempt

## Statuses
`scheduled` | `processing` | `sent` | `failed` | `cancelled`

## Hooks
| Event | Action |
| --- | --- |
| Business created | default rule |
| Receivable created | generate schedule (idempotent) |
| Full payment / cancel | cancel unsent (scheduled + processing) |
| Due date change | cancel + regenerate |
| Partial payment | keep; body uses remaining balance at send |

## Worker
```bash
npm run reminders:work
```
SKIP LOCKED on Postgres; financial recheck; demo or Resend provider.
