ALTER TABLE as_outbox ADD COLUMN IF NOT EXISTS receipt_checked_at timestamptz;
ALTER TABLE as_outbox ADD COLUMN IF NOT EXISTS receipt_next_check_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE as_outbox ADD COLUMN IF NOT EXISTS receipt_terminal boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS as_outbox_receipts_due ON as_outbox(receipt_next_check_at)
  WHERE kind='invite' AND state='sent' AND provider_id IS NOT NULL AND receipt_terminal=false;
