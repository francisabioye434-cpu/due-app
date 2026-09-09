# Database

## Engines
- **Production / CI:** PostgreSQL 14+ via `postgres.js` + Drizzle
- **Local/test without DATABASE_URL:** PGlite (`@electric-sql/pglite`)

## Migrations (forward only)
1. `001_init.sql` — users, sessions, businesses, memberships, customers, receivables, payments, activity_events
2. `002_reminders.sql` — reminder_rules, reminders, reminder_attempts + partial unique index
3. `003_email_channel.sql` — reminder_delivery_events

## Money
`original_amount_minor`, `amount_minor` as bigint (kobo).

## Tenancy
All business data keyed by `business_id`. Memberships enforce access.

## Apply
```bash
DATABASE_URL=postgres://… npm run db:migrate
```
