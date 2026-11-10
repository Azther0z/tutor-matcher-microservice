-- Additive recovery metadata for databases that already applied 001.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_scheme text NOT NULL DEFAULT 'BCRYPT_LEGACY';
ALTER TABLE users ADD COLUMN IF NOT EXISTS aggregate_version bigint NOT NULL DEFAULT 0;
ALTER TABLE events_outbox ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE events_outbox ADD COLUMN IF NOT EXISTS needs_attention_at timestamptz;
ALTER TABLE tutor_grants ADD COLUMN IF NOT EXISTS admission jsonb;
