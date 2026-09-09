CREATE TABLE IF NOT EXISTS reminder_rules (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  is_default boolean NOT NULL,
  enabled boolean NOT NULL,
  offsets_json text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  receivable_id uuid NOT NULL REFERENCES receivables(id),
  rule_id uuid NOT NULL REFERENCES reminder_rules(id),
  schedule_key text NOT NULL,
  offset_days integer NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  channel text NOT NULL DEFAULT 'email',
  last_body text,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reminders_active_schedule_uq
  ON reminders (receivable_id, rule_id, schedule_key)
  WHERE status <> 'cancelled';
CREATE TABLE IF NOT EXISTS reminder_attempts (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  reminder_id uuid NOT NULL REFERENCES reminders(id),
  attempt_number integer NOT NULL,
  provider text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  status text NOT NULL,
  failure_code text,
  failure_message text,
  provider_message_id text,
  channel text NOT NULL DEFAULT 'demo',
  destination text,
  subject text,
  body_snapshot text,
  retriable boolean,
  acceptance text,
  created_at timestamptz NOT NULL
);
