-- Booking target schema (booking_db). Money is stored as integral satang in bigint columns.
-- Lock order used by every transaction: availability_slots rows (ordered by starts_at) first, then the bookings row.
-- Revisions are bigint counters that start at 0 and advance on every owner-visible change (ETag = quoted revision).

-- A tutor's sellable 30-minute intervals. One row per tutor and start, so overlapping inventory cannot exist.
CREATE TABLE availability_slots (
  id            uuid PRIMARY KEY,
  tutor_id      uuid NOT NULL,
  tutor_user_id uuid NOT NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  state         text NOT NULL CHECK (state IN ('OPEN', 'CLOSED', 'HELD', 'BOOKED')),
  booking_id    uuid,
  revision      bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  CONSTRAINT slot_unique_start UNIQUE (tutor_id, starts_at),
  CONSTRAINT slot_is_half_hour CHECK (ends_at = starts_at + interval '30 minutes'),
  -- Bangkok is UTC+7 with no daylight saving, so a Bangkok half-hour is a UTC half-hour.
  CONSTRAINT slot_on_grid CHECK (
    extract(minute FROM starts_at AT TIME ZONE 'UTC') IN (0, 30) AND extract(second FROM starts_at AT TIME ZONE 'UTC') = 0
  ),
  CONSTRAINT slot_booking_matches_state CHECK ((state IN ('HELD', 'BOOKED')) = (booking_id IS NOT NULL))
);
CREATE INDEX slots_by_tutor_time ON availability_slots (tutor_id, starts_at);
CREATE INDEX slots_by_owner_time ON availability_slots (tutor_user_id, starts_at);
CREATE INDEX slots_open ON availability_slots (tutor_id, starts_at) WHERE state = 'OPEN';
CREATE INDEX slots_by_booking ON availability_slots (booking_id) WHERE booking_id IS NOT NULL;

-- The tutor's subjects an OPEN slot advertises.
CREATE TABLE slot_subjects (
  slot_id    uuid NOT NULL REFERENCES availability_slots (id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  PRIMARY KEY (slot_id, subject_id)
);
CREATE INDEX slot_subjects_by_subject ON slot_subjects (subject_id, slot_id);

-- Owner status records for pending public work (payment, cancellation). Polled through /api/operations/booking/{id}.
CREATE TABLE booking_operations (
  id                uuid PRIMARY KEY,
  kind              text NOT NULL,
  initiator_user_id uuid NOT NULL,
  affected_user_id  uuid,
  status            text NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'REJECTED')),
  resource_type     text,
  resource_id       uuid,
  resource_url      text,
  error             jsonb,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);

CREATE TABLE bookings (
  id                    uuid PRIMARY KEY,
  student_user_id       uuid NOT NULL,
  tutor_id              uuid NOT NULL,
  tutor_user_id         uuid NOT NULL,
  student_display_name  text NOT NULL,
  tutor_display_name    text NOT NULL,
  -- Subject and rate snapshot captured at hold time; later catalogue edits never change an existing booking.
  subject_id            uuid NOT NULL,
  subject_name          text NOT NULL,
  subject_description   text NOT NULL,
  subject_rate_satang   bigint NOT NULL CHECK (subject_rate_satang > 0),
  subject_revision      text NOT NULL,
  description           text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  slot_count            integer NOT NULL CHECK (slot_count BETWEEN 1 AND 8),
  amount_satang         bigint NOT NULL CHECK (amount_satang > 0),
  status                text NOT NULL CHECK (status IN ('PAYMENT_DUE', 'CONFIRMED', 'COMPLETED', 'CANCELLED')),
  revision              bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  hold_expires_at       timestamptz,
  paid_at               timestamptz,
  completed_at          timestamptz,
  tutor_confirmed_at    timestamptz,
  cancelled_at          timestamptz,
  cancelled_by          text CHECK (cancelled_by IN ('STUDENT', 'TUTOR', 'EXPIRY')),
  cancellation_reason   text CHECK (char_length(cancellation_reason) BETWEEN 1 AND 500),
  schedule_version      text NOT NULL DEFAULT '1',
  pending_operation_id  uuid REFERENCES booking_operations (id),
  meeting_state         text NOT NULL DEFAULT 'PROVISIONING' CHECK (meeting_state IN ('PROVISIONING', 'MISSING', 'READY')),
  meeting_provider_ref  uuid,
  meeting_generated_url text,
  meeting_custom_url    text,
  meeting_changed_at    timestamptz,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  CONSTRAINT booking_not_self CHECK (student_user_id <> tutor_user_id),
  CONSTRAINT booking_window CHECK (ends_at = starts_at + slot_count * interval '30 minutes'),
  CONSTRAINT booking_hold_while_due CHECK ((status = 'PAYMENT_DUE') = (hold_expires_at IS NOT NULL)),
  CONSTRAINT booking_terminal_stamps CHECK (
    (status <> 'COMPLETED' OR (completed_at IS NOT NULL AND tutor_confirmed_at IS NOT NULL)) AND
    (status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
  )
);
CREATE INDEX bookings_by_student ON bookings (student_user_id, created_at DESC, id DESC);
CREATE INDEX bookings_by_tutor ON bookings (tutor_user_id, created_at DESC, id DESC);
CREATE INDEX bookings_tutor_upcoming ON bookings (tutor_user_id, starts_at, id) WHERE status = 'CONFIRMED';
CREATE INDEX bookings_tutor_unconfirmed ON bookings (tutor_user_id, ends_at, id) WHERE status = 'CONFIRMED';
CREATE INDEX bookings_hold_expiry ON bookings (hold_expires_at) WHERE status = 'PAYMENT_DUE';
CREATE INDEX bookings_meeting_pending ON bookings (updated_at) WHERE status = 'CONFIRMED' AND meeting_state = 'PROVISIONING';

-- Which slots a booking covers, kept after the slots are released so the booking keeps its history.
CREATE TABLE booking_slots (
  booking_id uuid NOT NULL REFERENCES bookings (id),
  slot_id    uuid NOT NULL REFERENCES availability_slots (id),
  position   integer NOT NULL CHECK (position BETWEEN 0 AND 7),
  PRIMARY KEY (booking_id, slot_id),
  UNIQUE (booking_id, position)
);

-- One row per accepted payment attempt. The immutable PaymentCommand is saved before Wallet is called, so recovery
-- can repeat the same identity, query it, or close it. Wallet is never called inside a database transaction.
CREATE TABLE payment_attempts (
  operation_id         uuid PRIMARY KEY,
  booking_id           uuid NOT NULL REFERENCES bookings (id),
  booking_operation_id uuid NOT NULL REFERENCES booking_operations (id),
  command              jsonb NOT NULL,
  command_hash         text NOT NULL,
  status               text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPLIED', 'DECLINED', 'CLOSED')),
  reason               text,
  transaction_id       uuid,
  attempts             integer NOT NULL DEFAULT 0,
  needs_attention      boolean NOT NULL DEFAULT false,
  next_attempt_at      timestamptz NOT NULL,
  lease_until          timestamptz,
  fence                bigint NOT NULL DEFAULT 0,
  last_error           text,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL
);
CREATE INDEX payment_attempts_pending ON payment_attempts (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX payment_attempts_by_booking ON payment_attempts (booking_id, created_at);
-- At most one applied payment per booking, across different attempts.
CREATE UNIQUE INDEX payment_attempts_one_applied ON payment_attempts (booking_id) WHERE status = 'APPLIED';

-- Server-issued cancellation quotes. A quote binds actor, booking revision, policy version and amounts.
CREATE TABLE cancellation_quotes (
  id               uuid PRIMARY KEY,
  booking_id       uuid NOT NULL REFERENCES bookings (id),
  actor            text NOT NULL CHECK (actor IN ('STUDENT', 'TUTOR')),
  actor_user_id    uuid NOT NULL,
  booking_revision bigint NOT NULL,
  policy_version   text NOT NULL,
  refund_satang    bigint NOT NULL CHECK (refund_satang >= 0),
  fee_satang       bigint NOT NULL CHECK (fee_satang >= 0),
  late             boolean NOT NULL,
  requires_warning boolean NOT NULL,
  issued_at        timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  operation_id     uuid REFERENCES booking_operations (id),
  reason           text CHECK (char_length(reason) BETWEEN 1 AND 500),
  CHECK (expires_at > issued_at)
);
CREATE INDEX quotes_by_booking ON cancellation_quotes (booking_id, issued_at DESC);

-- A paid cancellation finalizes only after the refund outcome is known. The command is saved first and repeated by identity.
CREATE TABLE refund_operations (
  operation_id         uuid PRIMARY KEY,
  booking_id           uuid NOT NULL REFERENCES bookings (id),
  booking_operation_id uuid NOT NULL REFERENCES booking_operations (id),
  quote_id             uuid NOT NULL REFERENCES cancellation_quotes (id),
  kind                 text NOT NULL CHECK (kind IN ('STUDENT_CANCEL', 'TUTOR_CANCEL')),
  reason               text,
  command              jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPLIED')),
  transaction_id       uuid,
  attempts             integer NOT NULL DEFAULT 0,
  needs_attention      boolean NOT NULL DEFAULT false,
  next_attempt_at      timestamptz NOT NULL,
  lease_until          timestamptz,
  fence                bigint NOT NULL DEFAULT 0,
  last_error           text,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL
);
CREATE INDEX refund_operations_pending ON refund_operations (next_attempt_at) WHERE status = 'PENDING';
-- At most one cancellation refund per booking.
CREATE UNIQUE INDEX refund_operations_one_per_booking ON refund_operations (booking_id);

-- Completion and its durable Wallet handoff are written together. The first confirmation time is immutable.
CREATE TABLE completion_handoffs (
  booking_id       uuid PRIMARY KEY REFERENCES bookings (id),
  operation_id     uuid NOT NULL UNIQUE,
  command          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE')),
  attempts         integer NOT NULL DEFAULT 0,
  needs_attention  boolean NOT NULL DEFAULT false,
  next_attempt_at  timestamptz NOT NULL,
  lease_until      timestamptz,
  fence            bigint NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
CREATE INDEX completion_handoffs_pending ON completion_handoffs (next_attempt_at) WHERE status = 'PENDING';

-- Reminder schedule (60 and 10 minutes before start). Unique on the stable schedule/offset identity.
CREATE TABLE reminders (
  booking_id       uuid NOT NULL REFERENCES bookings (id),
  schedule_version text NOT NULL,
  offset_minutes   integer NOT NULL CHECK (offset_minutes IN (60, 10)),
  due_at           timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'QUEUED')),
  created_at       timestamptz NOT NULL,
  PRIMARY KEY (booking_id, schedule_version, offset_minutes)
);
CREATE INDEX reminders_due ON reminders (due_at) WHERE status = 'PENDING';

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
