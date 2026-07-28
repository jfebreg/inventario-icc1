-- Correcciones guiadas y auditables de datos maestros.
ALTER TABLE logistics_data_quality_issues
  ADD COLUMN IF NOT EXISTS corrected_by TEXT REFERENCES inventory_user_profiles(id),
  ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS correction_notes TEXT,
  ADD COLUMN IF NOT EXISTS correction_data JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS logistics_data_quality_corrected_idx
  ON logistics_data_quality_issues
  (organization_id,corrected_at DESC)
  WHERE corrected_at IS NOT NULL;
