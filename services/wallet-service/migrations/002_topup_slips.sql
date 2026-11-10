-- Manual PromptPay top-ups: the student transfers money, attaches the slip image, and an admin approves or rejects the request.
ALTER TABLE topups
  ADD COLUMN manual            boolean     NOT NULL DEFAULT false,
  ADD COLUMN slip_image        bytea,
  ADD COLUMN slip_content_type text,
  ADD COLUMN slip_uploaded_at  timestamptz,
  ADD COLUMN decision_reason   text,
  ADD COLUMN decided_by        uuid,
  ADD COLUMN decided_at        timestamptz;

ALTER TABLE topups
  ADD CONSTRAINT topup_slip_type CHECK (slip_content_type IS NULL OR slip_content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  ADD CONSTRAINT topup_slip_size CHECK (slip_image IS NULL OR octet_length(slip_image) <= 2097152),
  ADD CONSTRAINT topup_manual_has_slip CHECK (NOT manual OR (slip_image IS NOT NULL AND slip_content_type IS NOT NULL AND slip_uploaded_at IS NOT NULL)),
  ADD CONSTRAINT topup_reason_length CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 500);

-- A user can have only one manual top-up request waiting for review at a time.
CREATE UNIQUE INDEX topups_one_open_per_user ON topups (user_id) WHERE manual AND status = 'PENDING';
CREATE INDEX topups_manual_review ON topups (status, created_at DESC) WHERE manual;
