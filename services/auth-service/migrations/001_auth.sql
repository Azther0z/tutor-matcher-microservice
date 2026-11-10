CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- The service previously used this table with email/password_hash/display_name.
-- Additive changes and backfills preserve those existing identities.
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS capabilities text[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS revision bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_scheme text NOT NULL DEFAULT 'BCRYPT_LEGACY';
ALTER TABLE users ADD COLUMN IF NOT EXISTS aggregate_version bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE users SET email = lower(btrim(email)) WHERE email <> lower(btrim(email));
UPDATE users
SET first_name = COALESCE(first_name, NULLIF(split_part(btrim(display_name), ' ', 1), ''), 'Student'),
    last_name = COALESCE(last_name, NULLIF(btrim(substr(btrim(display_name), length(split_part(btrim(display_name), ' ', 1)) + 1)), ''), 'Account'),
    capabilities = COALESCE(capabilities, ARRAY['STUDENT']::text[]),
    status = COALESCE(status, 'ACTIVE'),
    revision = COALESCE(revision, 0)
WHERE first_name IS NULL OR last_name IS NULL OR capabilities IS NULL OR status IS NULL OR revision IS NULL;
ALTER TABLE users ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE users ALTER COLUMN last_name SET NOT NULL;
ALTER TABLE users ALTER COLUMN capabilities SET NOT NULL;
ALTER TABLE users ALTER COLUMN status SET NOT NULL;
ALTER TABLE users ALTER COLUMN revision SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_uq ON users ((lower(email)));

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text
);
CREATE INDEX IF NOT EXISTS sessions_user_live_idx ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS student_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  learning_areas jsonb NOT NULL DEFAULT '[]'::jsonb,
  level text NOT NULL DEFAULT '',
  goals text NOT NULL DEFAULT '',
  preferred_periods text[] NOT NULL DEFAULT ARRAY[]::text[],
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO student_profiles(user_id) SELECT id FROM users ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS restriction_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS restriction_audit_user_idx ON restriction_audit(user_id, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_digest bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS reset_tokens_latest_idx ON reset_tokens(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reset_contents (
  content_ref uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  reset_token_id uuid NOT NULL REFERENCES reset_tokens(id),
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS events_outbox (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  routing_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  locked_until timestamptz,
  lock_id uuid,
  available_at timestamptz NOT NULL DEFAULT now(),
  needs_attention_at timestamptz
);
CREATE INDEX IF NOT EXISTS events_outbox_pending_idx ON events_outbox(created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS idempotency_records (
  method text NOT NULL,
  key text NOT NULL,
  actor_fingerprint text NOT NULL,
  request_fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(method, key, actor_fingerprint)
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket text NOT NULL,
  subject_digest text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL,
  PRIMARY KEY(bucket, subject_digest)
);

CREATE TABLE IF NOT EXISTS tutor_grants (
  operation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  submission_id uuid NOT NULL,
  approval_revision text NOT NULL,
  applied_at timestamptz NOT NULL,
  UNIQUE(submission_id, approval_revision)
);

CREATE TABLE IF NOT EXISTS auth_operations (
  id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('SUCCEEDED','REJECTED')),
  resource jsonb,
  error jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_operations_actor_idx ON auth_operations(actor_user_id, created_at DESC);
