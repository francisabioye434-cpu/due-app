# Architecture

Modular monolith: Node 20+, TypeScript, Drizzle ORM, postgres.js / PGlite.

```
HTTP (server.ts)
  → DueApp services (tenant-scoped)
    → domain (money, aging, time, reminders, email)
    → reminders/worker (claim → recheck → MessagingProvider)
    → messaging (demo | resend)
  → db (schema, migrate)
```

## Tenancy
Business is the isolation root. Memberships enforce access.

## Money
Integer kobo. Computed outstanding. Overpayment rejected.

## Reminders
See `REMINDER_ENGINE.md`. Financial recheck before every send.

## Messaging
`MessagingProvider.send` only. Demo by default. Resend when configured.

## Deploy
One app process + optional `reminders:work` process. Forward-only SQL migrations.
