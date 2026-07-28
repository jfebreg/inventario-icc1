-- Detección y revisión humana de posibles artículos duplicados.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE logistics_data_quality_issues
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES inventory_user_profiles(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_decision TEXT
    CHECK (review_decision IS NULL OR review_decision IN ('NOT_DUPLICATE','CONFIRMED_DUPLICATE')),
  ADD COLUMN IF NOT EXISTS review_notes TEXT;

CREATE INDEX IF NOT EXISTS logistics_items_name_similarity_idx
  ON logistics_items USING GIN
  (LOWER(name) gin_trgm_ops)
  WHERE active=TRUE;

CREATE INDEX IF NOT EXISTS logistics_data_quality_duplicate_review_idx
  ON logistics_data_quality_issues
  (organization_id,rule_code,status,review_decision,last_detected_at DESC)
  WHERE rule_code='POSSIBLE_DUPLICATE';
