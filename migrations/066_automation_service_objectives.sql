-- Objetivos de servicio configurables para automatizaciones críticas.
CREATE TABLE IF NOT EXISTS logistics_automation_slo_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  job_code TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  evaluation_window_days INTEGER NOT NULL DEFAULT 30
    CHECK (evaluation_window_days BETWEEN 7 AND 365),
  target_success_rate NUMERIC(5,2) NOT NULL DEFAULT 95
    CHECK (target_success_rate BETWEEN 50 AND 100),
  max_average_duration_ms BIGINT NOT NULL DEFAULT 300000
    CHECK (max_average_duration_ms BETWEEN 1000 AND 3600000),
  max_open_incidents INTEGER NOT NULL DEFAULT 0
    CHECK (max_open_incidents BETWEEN 0 AND 100),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,job_code)
);

INSERT INTO logistics_automation_slo_policies
  (organization_id,job_code,evaluation_window_days,target_success_rate,
   max_average_duration_ms,max_open_incidents)
SELECT organization.id,'INSPECTION_REPORT_WEEKLY_VERIFICATION',30,95,300000,0
FROM logistics_organizations organization
ON CONFLICT (organization_id,job_code) DO NOTHING;

ALTER TABLE logistics_automation_slo_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_automation_slo_policies FROM anon,authenticated;

COMMENT ON TABLE logistics_automation_slo_policies IS
  'Metas operativas para evaluar confiabilidad, duración e incidentes de automatizaciones.';
