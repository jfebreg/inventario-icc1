-- Vincula la planificación automática con la ejecución física del conteo.
ALTER TABLE logistics_cycle_counts
  ADD COLUMN IF NOT EXISTS planned_task_id TEXT
    REFERENCES inventory_tasks(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS logistics_cycle_counts_planned_task_idx
  ON logistics_cycle_counts (planned_task_id)
  WHERE planned_task_id IS NOT NULL AND status<>'CANCELLED';

CREATE INDEX IF NOT EXISTS logistics_cycle_counts_planned_task_status_idx
  ON logistics_cycle_counts (organization_id,planned_task_id,status);
