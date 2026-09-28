ALTER TABLE logistics_backup_recovery_objectives
  ADD COLUMN IF NOT EXISTS trend_window_size INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS trend_min_samples INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS trend_target_percent INTEGER NOT NULL DEFAULT 95,
  ADD COLUMN IF NOT EXISTS trend_critical_percent INTEGER NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS trend_consecutive_breach_limit INTEGER NOT NULL DEFAULT 2;

ALTER TABLE logistics_backup_recovery_objectives
  DROP CONSTRAINT IF EXISTS logistics_backup_recovery_objectives_trend_policy_check;
ALTER TABLE logistics_backup_recovery_objectives
  ADD CONSTRAINT logistics_backup_recovery_objectives_trend_policy_check CHECK (
    trend_window_size BETWEEN 3 AND 52
    AND trend_min_samples BETWEEN 3 AND trend_window_size
    AND trend_target_percent BETWEEN 50 AND 100
    AND trend_critical_percent BETWEEN 0 AND 99
    AND trend_critical_percent < trend_target_percent
    AND trend_consecutive_breach_limit BETWEEN 1 AND trend_window_size
  );

ALTER TABLE logistics_backup_recovery_objective_history
  ADD COLUMN IF NOT EXISTS previous_trend_window_size INTEGER,
  ADD COLUMN IF NOT EXISTS previous_trend_min_samples INTEGER,
  ADD COLUMN IF NOT EXISTS previous_trend_target_percent INTEGER,
  ADD COLUMN IF NOT EXISTS previous_trend_critical_percent INTEGER,
  ADD COLUMN IF NOT EXISTS previous_trend_consecutive_breach_limit INTEGER,
  ADD COLUMN IF NOT EXISTS trend_window_size INTEGER,
  ADD COLUMN IF NOT EXISTS trend_min_samples INTEGER,
  ADD COLUMN IF NOT EXISTS trend_target_percent INTEGER,
  ADD COLUMN IF NOT EXISTS trend_critical_percent INTEGER,
  ADD COLUMN IF NOT EXISTS trend_consecutive_breach_limit INTEGER;
