-- Slip images now live as files in the Wallet service's uploads directory; the database keeps only the URL they are served from.
-- slip_image stays (nullable) so requests stored by the earlier migration remain readable.
ALTER TABLE topups ADD COLUMN slip_url text;
ALTER TABLE topups DROP CONSTRAINT topup_manual_has_slip;
ALTER TABLE topups ADD CONSTRAINT topup_manual_has_slip CHECK (
  NOT manual OR ((slip_url IS NOT NULL OR slip_image IS NOT NULL) AND slip_content_type IS NOT NULL AND slip_uploaded_at IS NOT NULL)
);
