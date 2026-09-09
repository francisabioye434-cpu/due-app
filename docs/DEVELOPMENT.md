# Development

## Requirements
- Node ≥ 20
- Optional: PostgreSQL for production-parity tests

## Setup
```bash
cd /path/to/due
npm install
cp .env.example .env   # edit AUTH_SECRET
```

## Commands
```bash
npm run typecheck
npm run lint
npm test                 # PGlite if no DATABASE_URL
npm run db:migrate
npm start
npm run reminders:work
```

## Environment
| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | postgres://… (omit → PGlite) |
| `AUTH_SECRET` | session signing (≥32 chars in production) |
| `DUE_ENV` | development \| production \| test |
| `DUE_MESSAGING_PROVIDER` | `demo` (default) \| `email` |
| `RESEND_API_KEY` | required for email mode |
| `DUE_EMAIL_FROM` | verified sender |
| `RESEND_WEBHOOK_SECRET` | optional webhook verification |
| `PORT` | default 3000 |

## Safety
- Default messaging is **demo** (no real sends)
- Production requires explicit `DUE_MESSAGING_PROVIDER`
- Email mode fails closed without credentials
