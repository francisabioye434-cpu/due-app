# Email provider

## Selection
**Resend** — simple HTTP API, Idempotency-Key, transactional fit, Svix-style webhooks.

Alternatives considered: Postmark, SendGrid, Amazon SES (more setup / heavier SDKs for V1).

## Config
```
DUE_MESSAGING_PROVIDER=email
RESEND_API_KEY=re_…
DUE_EMAIL_FROM=DUE <billing@yourdomain.com>
DUE_EMAIL_REPLY_TO=optional@…
RESEND_WEBHOOK_SECRET=whsec_…   # optional
```

## Semantics
- HTTP 200 from Resend = **provider accepted**, not delivered
- Webhooks record `delivered`, `bounced`, `complained`, etc. into `reminder_delivery_events`
- Signature verification: HMAC-SHA256 over `id.timestamp.payload`

## Safety
- Demo remains default for development
- Production without explicit provider fails
- Email without API key / from fails at startup
- Secrets never logged or stored in DB
