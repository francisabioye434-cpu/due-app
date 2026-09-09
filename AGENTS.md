# AGENTS.md — DUE

## Product
DUE: track money owed to freelancers/small service businesses and automate professional payment follow-up.

## Authority
1. Product Constitution (`docs/PRODUCT_CONSTITUTION.md`)
2. Approved PRD / ADRs
3. Implementation plan
4. This repo’s code and migrations

## Stack
Modular monolith · TypeScript · Drizzle · PostgreSQL (PGlite for local tests) · MessagingProvider (demo | Resend)

## Rules for agents
- Do not invent product scope beyond constitution
- Integer money (kobo); reject overpayments
- Tenant isolation server-side always
- Demo messaging is default; never claim real delivery from demo
- Forward-only migrations
- Do not add WhatsApp/SMS/Paystack/AI/subscriptions without explicit authorization
- Canonical path: `/workspace/artifacts/due`
