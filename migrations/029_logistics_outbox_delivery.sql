-- Entrega confiable de eventos mediante patrón Transactional Outbox.
ALTER TABLE logistics_outbox_events
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

UPDATE logistics_outbox_events
SET status=CASE WHEN published_at IS NULL THEN 'PENDING' ELSE 'PUBLISHED' END
WHERE status IS NULL;

ALTER TABLE logistics_outbox_events
  ALTER COLUMN status SET DEFAULT 'PENDING',
  ALTER COLUMN status SET NOT NULL;

ALTER TABLE logistics_outbox_events
  DROP CONSTRAINT IF EXISTS logistics_outbox_events_status_check;
ALTER TABLE logistics_outbox_events
  ADD CONSTRAINT logistics_outbox_events_status_check
  CHECK (status IN ('PENDING','PROCESSING','RETRY','PUBLISHED','DEAD_LETTER'));

DROP INDEX IF EXISTS logistics_outbox_pending_idx;
CREATE INDEX IF NOT EXISTS logistics_outbox_delivery_idx
  ON logistics_outbox_events (available_at,created_at)
  WHERE status IN ('PENDING','RETRY');

CREATE INDEX IF NOT EXISTS logistics_outbox_dead_letter_idx
  ON logistics_outbox_events (created_at DESC)
  WHERE status='DEAD_LETTER';

CREATE INDEX IF NOT EXISTS logistics_outbox_stale_idx
  ON logistics_outbox_events (locked_at)
  WHERE status='PROCESSING';
