-- Control independiente de diferencias fuera de tolerancia.
ALTER TABLE logistics_cycle_counts
  DROP CONSTRAINT IF EXISTS logistics_cycle_counts_status_check;

ALTER TABLE logistics_cycle_counts
  ADD CONSTRAINT logistics_cycle_counts_status_check
  CHECK (status IN (
    'DRAFT','IN_PROGRESS','RECOUNT_REQUIRED',
    'SUBMITTED','APPROVED','POSTED','CANCELLED'
  ));

ALTER TABLE logistics_cycle_count_lines
  ADD COLUMN IF NOT EXISTS tolerance_percent NUMERIC(7,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recount_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recount_quantity NUMERIC(18,4)
    CHECK (recount_quantity >= 0),
  ADD COLUMN IF NOT EXISTS recount_by TEXT
    REFERENCES inventory_user_profiles(id),
  ADD COLUMN IF NOT EXISTS recount_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS variance_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS variance_notes TEXT;

ALTER TABLE logistics_cycle_count_lines
  DROP CONSTRAINT IF EXISTS logistics_cycle_count_lines_variance_reason_check;

ALTER TABLE logistics_cycle_count_lines
  ADD CONSTRAINT logistics_cycle_count_lines_variance_reason_check
  CHECK (variance_reason_code IS NULL OR variance_reason_code IN (
    'COUNT_ERROR','RECEIPT_PENDING','UNRECORDED_ISSUE','DAMAGE',
    'LOSS','FOUND_STOCK','LOCATION_ERROR','UNIT_ERROR','OTHER'
  ));

CREATE INDEX IF NOT EXISTS logistics_cycle_count_recount_idx
  ON logistics_cycle_count_lines (count_id,recount_required,recount_at);
