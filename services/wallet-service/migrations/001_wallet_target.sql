-- Wallet target schema (wallet_db). Money is stored as integral satang in bigint columns.
-- Lock order used by every transaction: financial_records row first, then wallets row.

CREATE TABLE wallets (
  user_id          uuid PRIMARY KEY,
  posted_satang    bigint NOT NULL DEFAULT 0 CHECK (posted_satang >= 0),
  reserved_satang  bigint NOT NULL DEFAULT 0 CHECK (reserved_satang >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_within_posted CHECK (reserved_satang <= posted_satang)
);

-- Completed money movements only. Read-only history: rows are never updated or deleted.
CREATE TABLE ledger_entries (
  id                   uuid PRIMARY KEY,
  user_id              uuid NOT NULL,
  type                 text NOT NULL CHECK (type IN ('TOP_UP', 'LESSON_PAYMENT', 'LESSON_EARNING', 'REFUND', 'PAYOUT')),
  direction            text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  amount_satang        bigint NOT NULL CHECK (amount_satang > 0),
  balance_after_satang bigint NOT NULL CHECK (balance_after_satang >= 0),
  operation_id         uuid NOT NULL,
  booking_id           uuid,
  payout_account_id    uuid,
  created_at           timestamptz NOT NULL,
  CONSTRAINT one_movement_per_operation UNIQUE (type, operation_id)
);
CREATE INDEX ledger_by_user ON ledger_entries (user_id, created_at DESC, id DESC);
CREATE INDEX ledger_by_booking ON ledger_entries (booking_id, created_at, id) WHERE booking_id IS NOT NULL;

-- One row per booking: the single lock that charge, close, refund, completion, dispute and clearing share.
CREATE TABLE financial_records (
  booking_id                 uuid PRIMARY KEY,
  student_user_id            uuid NOT NULL,
  tutor_user_id              uuid NOT NULL,
  paid_satang                bigint NOT NULL DEFAULT 0 CHECK (paid_satang >= 0),
  refunded_satang            bigint NOT NULL DEFAULT 0 CHECK (refunded_satang >= 0),
  fee_satang                 bigint NOT NULL DEFAULT 0 CHECK (fee_satang >= 0),
  pending_earning_satang     bigint NOT NULL DEFAULT 0 CHECK (pending_earning_satang >= 0),
  status                     text NOT NULL DEFAULT 'UNPAID'
                             CHECK (status IN ('UNPAID', 'PAID', 'CANCELLED', 'COMPLETED', 'SETTLED', 'REFUNDED')),
  payment_gate               text NOT NULL DEFAULT 'OPEN' CHECK (payment_gate IN ('OPEN', 'CLOSED')),
  applied_payment_operation_id uuid,
  starts_at                  timestamptz NOT NULL,
  ends_at                    timestamptz NOT NULL,
  hold_expires_at            timestamptz NOT NULL,
  tutor_confirmed_at         timestamptz,
  completion_source_operation_id uuid,
  clearing_due_at            timestamptz,
  dispute_id                 uuid,
  dispute_held               boolean NOT NULL DEFAULT false,
  revision                   bigint NOT NULL DEFAULT 0,
  created_at                 timestamptz NOT NULL,
  updated_at                 timestamptz NOT NULL,
  CONSTRAINT refund_cap CHECK (refunded_satang <= paid_satang),
  CONSTRAINT distinct_parties CHECK (student_user_id <> tutor_user_id)
);
CREATE INDEX records_due_for_clearing ON financial_records (clearing_due_at)
  WHERE status = 'COMPLETED' AND dispute_held = false;
CREATE INDEX records_by_tutor ON financial_records (tutor_user_id) WHERE status = 'COMPLETED';
CREATE INDEX records_by_student ON financial_records (student_user_id) WHERE status = 'UNPAID';

-- Immutable Booking→Wallet charge attempts and tombstones. Retained for the life of the ledger.
CREATE TABLE payment_operations (
  operation_id         uuid PRIMARY KEY,
  booking_id           uuid NOT NULL REFERENCES financial_records (booking_id),
  command_hash         text NOT NULL,
  status               text NOT NULL CHECK (status IN ('APPLIED', 'DECLINED', 'CLOSED')),
  amount_satang        bigint NOT NULL CHECK (amount_satang > 0),
  transaction_id       uuid,
  balance_after_satang bigint NOT NULL,
  reason               text,
  decided_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL,
  CONSTRAINT receipt_only_when_applied CHECK ((status = 'APPLIED') = (transaction_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_applied_payment_per_booking ON payment_operations (booking_id) WHERE status = 'APPLIED';

CREATE TABLE refund_operations (
  operation_id         uuid PRIMARY KEY,
  booking_id           uuid NOT NULL REFERENCES financial_records (booking_id),
  kind                 text NOT NULL CHECK (kind IN ('STUDENT_CANCEL', 'TUTOR_CANCEL', 'DISPUTE_REMEDY')),
  command_hash         text NOT NULL,
  amount_satang        bigint NOT NULL CHECK (amount_satang > 0),
  total_refunded_satang bigint NOT NULL,
  transaction_id       uuid NOT NULL,
  applied_at           timestamptz NOT NULL
);
CREATE INDEX refunds_by_booking ON refund_operations (booking_id);
CREATE UNIQUE INDEX one_cancellation_refund_per_booking ON refund_operations (booking_id)
  WHERE kind IN ('STUDENT_CANCEL', 'TUTOR_CANCEL');

-- Durable owner operation store behind GET /internal/v1/wallet/operations/{id}.
CREATE TABLE wallet_operations (
  id               uuid PRIMARY KEY,
  kind             text NOT NULL,
  initiator_user_id uuid NOT NULL,
  affected_user_id uuid,
  status           text NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'REJECTED')),
  resource_type    text,
  resource_id      uuid,
  resource_url     text,
  error            jsonb,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);

CREATE TABLE topups (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL,
  amount_satang       bigint NOT NULL CHECK (amount_satang > 0 AND amount_satang <= 10000000),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  provider_reference  uuid NOT NULL UNIQUE,
  operation_id        uuid NOT NULL UNIQUE REFERENCES wallet_operations (id),
  return_to_booking_id uuid,
  synthetic           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL,
  confirmed_at        timestamptz
);
CREATE INDEX topups_by_user ON topups (user_id, created_at DESC, id DESC);

CREATE TABLE payout_accounts (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL,
  bank_code          text NOT NULL,
  account_holder_name text NOT NULL,
  -- Keyed fingerprint of bank|number for duplicate detection. The number itself is never stored.
  number_fingerprint text NOT NULL,
  masked_number      text NOT NULL,
  is_default         boolean NOT NULL DEFAULT false,
  revision           bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL,
  removed_at         timestamptz
);
CREATE UNIQUE INDEX payout_account_no_active_duplicate ON payout_accounts (user_id, number_fingerprint) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX payout_account_single_default ON payout_accounts (user_id) WHERE is_default AND removed_at IS NULL;
CREATE INDEX payout_accounts_by_user ON payout_accounts (user_id, created_at, id) WHERE removed_at IS NULL;

CREATE TABLE payouts (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL,
  amount_satang      bigint NOT NULL CHECK (amount_satang > 0 AND amount_satang <= 10000000),
  payout_account_id  uuid NOT NULL REFERENCES payout_accounts (id),
  -- Immutable accepted destination snapshot. Account removal never rewrites it.
  bank_code          text NOT NULL,
  account_holder_name text NOT NULL,
  masked_number      text NOT NULL,
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  provider_reference uuid NOT NULL UNIQUE,
  operation_id       uuid NOT NULL UNIQUE REFERENCES wallet_operations (id),
  synthetic          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL,
  resolved_at        timestamptz
);
CREATE INDEX payouts_by_user ON payouts (user_id, created_at DESC, id DESC);

CREATE TABLE disputes (
  id               uuid PRIMARY KEY,
  booking_id       uuid NOT NULL REFERENCES financial_records (booking_id),
  student_user_id  uuid NOT NULL,
  tutor_user_id    uuid NOT NULL,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'APPROVED', 'REJECTED')),
  reason           text NOT NULL,
  decision_reason  text,
  refunded_satang  bigint NOT NULL DEFAULT 0 CHECK (refunded_satang >= 0),
  earnings_held    boolean NOT NULL DEFAULT true,
  revision         bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL,
  resolved_at      timestamptz
);
-- At most one OPEN case per booking: concurrent submissions cannot create two holds.
CREATE UNIQUE INDEX one_open_dispute_per_booking ON disputes (booking_id) WHERE status = 'OPEN';
CREATE INDEX disputes_by_student ON disputes (student_user_id, created_at DESC, id DESC);
CREATE INDEX disputes_by_status ON disputes (status, created_at DESC, id DESC);

CREATE TABLE dispute_audit (
  seq            bigserial NOT NULL UNIQUE, -- stable insertion order when two entries share a timestamp
  id             uuid PRIMARY KEY,
  dispute_id     uuid NOT NULL REFERENCES disputes (id),
  actor_user_id  uuid,
  action         text NOT NULL,
  reason         text,
  occurred_at    timestamptz NOT NULL
);
CREATE INDEX dispute_audit_by_dispute ON dispute_audit (dispute_id, seq);

-- Idempotency-Key store: scoped to caller identity, method and canonical route. No TTL by design.
CREATE TABLE idempotency_keys (
  actor_user_id uuid NOT NULL,
  method        text NOT NULL,
  route         text NOT NULL,
  idem_key      uuid NOT NULL,
  input_hash    text NOT NULL,
  status_code   integer,
  response      jsonb,
  headers       jsonb,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (actor_user_id, method, route, idem_key)
);

-- Transactional outbox written in the same transaction as the business decision.
CREATE TABLE outbox (
  event_id        uuid PRIMARY KEY,
  type            text NOT NULL,
  envelope        jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED')),
  attempts        integer NOT NULL DEFAULT 0,
  needs_attention boolean NOT NULL DEFAULT false,
  next_attempt_at timestamptz NOT NULL,
  lease_until     timestamptz,
  fence           bigint NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL,
  published_at    timestamptz
);
CREATE INDEX outbox_ready ON outbox (next_attempt_at) WHERE status = 'PENDING';
