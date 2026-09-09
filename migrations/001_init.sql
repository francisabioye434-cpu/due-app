CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  timezone text NOT NULL DEFAULT 'Africa/Lagos',
  currency text NOT NULL DEFAULT 'NGN',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (business_id, user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  company_name text,
  phone text,
  email text,
  notes text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS receivables (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  description text NOT NULL,
  original_amount_minor bigint NOT NULL,
  currency text NOT NULL,
  due_on date NOT NULL,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid,
  cancellation_reason text,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  UNIQUE (business_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  receivable_id uuid NOT NULL REFERENCES receivables(id),
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  paid_on date NOT NULL,
  method text,
  note text,
  status text NOT NULL DEFAULT 'succeeded',
  recorded_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  UNIQUE (business_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS activity_events (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  receivable_id uuid,
  customer_id uuid,
  type text NOT NULL,
  actor_user_id uuid,
  payload text NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_receivable_idx ON payments(business_id, receivable_id);
CREATE INDEX IF NOT EXISTS activity_receivable_idx ON activity_events(business_id, receivable_id, occurred_at);
