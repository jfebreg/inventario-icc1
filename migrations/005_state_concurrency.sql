ALTER TABLE inventory_app_state
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0;

ALTER TABLE inventory_state_versions
  ADD COLUMN IF NOT EXISTS state_revision BIGINT,
  ADD COLUMN IF NOT EXISTS checksum TEXT;

DELETE FROM inventory_state_versions
  WHERE state_revision IS NULL;

CREATE INDEX IF NOT EXISTS inventory_state_versions_revision_idx
  ON inventory_state_versions (state_revision DESC, saved_at DESC)
  WHERE state_revision IS NOT NULL;
