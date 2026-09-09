# Slice 3 — Email channel (Resend)

## Architecture
```
Reminder scheduling → Worker → MessagingProvider → ResendEmailProvider
                                              ↘ DemoMessagingProvider (default)
```

## Behaviour
- Real sends only when `DUE_MESSAGING_PROVIDER=email` + credentials
- Pre-send financial recheck; body uses current outstanding
- Idempotency-Key: `due-attempt-{attemptId}`
- Acceptance ≠ delivery; delivery events via signed webhooks
- Retriable vs permanent failure classification
- Destination validated; missing email is non-retriable

## Live verification
**NOT VERIFIED** without `RESEND_API_KEY`, verified sender, and webhook reachability.

## Prohibited still
WhatsApp, SMS, Paystack, Flutterwave, AI, subscriptions, native apps.
