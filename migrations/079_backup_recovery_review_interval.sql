ALTER TABLE logistics_backup_recovery_objectives
  ADD COLUMN IF NOT EXISTS review_interval_days INTEGER NOT NULL DEFAULT 365
    CHECK (review_interval_days BETWEEN 30 AND 730);

ALTER TABLE logistics_backup_recovery_objective_history
  ADD COLUMN IF NOT EXISTS previous_review_interval_days INTEGER,
  ADD COLUMN IF NOT EXISTS review_interval_days INTEGER;
