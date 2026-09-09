-- columns already included in 002 for greenfield; keep for forward-compat
CREATE TABLE IF NOT EXISTS reminder_delivery_events (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  reminder_attempt_id uuid,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  UNIQUE (provider, provider_event_id)
);
