-- Objetivos de servicio para la entrega de eventos operativos.
CREATE TABLE IF NOT EXISTS logistics_outbox_slo_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  window_minutes INTEGER NOT NULL DEFAULT 60 CHECK (window_minutes BETWEEN 15 AND 10080),
  max_pending_minutes INTEGER NOT NULL DEFAULT 15 CHECK (max_pending_minutes BETWEEN 1 AND 1440),
  max_failure_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 20
    CHECK (max_failure_rate_percent BETWEEN 0 AND 100),
  minimum_attempts INTEGER NOT NULL DEFAULT 5 CHECK (minimum_attempts BETWEEN 1 AND 1000),
  max_dead_letters INTEGER NOT NULL DEFAULT 0 CHECK (max_dead_letters BETWEEN 0 AND 1000),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id)
);

INSERT INTO logistics_outbox_slo_policies (organization_id)
SELECT id FROM logistics_organizations
ON CONFLICT (organization_id) DO NOTHING;

ALTER TABLE logistics_outbox_slo_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_outbox_slo_policies FROM anon,authenticated;

COMMENT ON TABLE logistics_outbox_slo_policies IS
  'Umbrales para detectar atrasos, descartes y degradación sostenida de la entrega de eventos.';

