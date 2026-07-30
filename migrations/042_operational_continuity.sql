-- Continuidad operacional, monitoreo persistente e incidentes.
CREATE TABLE IF NOT EXISTS logistics_health_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  overall_status TEXT NOT NULL CHECK (overall_status IN ('HEALTHY','DEGRADED','DOWN')),
  source TEXT NOT NULL DEFAULT 'SCHEDULER'
    CHECK (source IN ('SCHEDULER','MANUAL','STARTUP')),
  checks JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  checked_by TEXT REFERENCES inventory_user_profiles(id),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logistics_operational_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  incident_number TEXT NOT NULL,
  warehouse_id UUID REFERENCES logistics_warehouses(id),
  category TEXT NOT NULL CHECK (category IN
    ('APPLICATION','DATABASE','AUTH','STORAGE','INTEGRATION','DEVICE','PROCESS','SECURITY')),
  severity TEXT NOT NULL CHECK (severity IN ('SEV1','SEV2','SEV3','SEV4')),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','INVESTIGATING','MITIGATED','RESOLVED')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  impact TEXT,
  owner_profile_id TEXT REFERENCES inventory_user_profiles(id),
  opened_by TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  mitigated_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  root_cause TEXT,
  corrective_action TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,incident_number)
);

CREATE TABLE IF NOT EXISTS logistics_incident_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  incident_id UUID NOT NULL REFERENCES logistics_operational_incidents(id),
  event_type TEXT NOT NULL,
  actor_profile_id TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  notes TEXT,
  before_data JSONB,
  after_data JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION logistics_incident_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'El historial de incidentes es inalterable';
END $$;

DROP TRIGGER IF EXISTS logistics_incident_events_no_change ON logistics_incident_events;
CREATE TRIGGER logistics_incident_events_no_change
  BEFORE UPDATE OR DELETE ON logistics_incident_events
  FOR EACH ROW EXECUTE FUNCTION logistics_incident_events_immutable();

CREATE INDEX IF NOT EXISTS logistics_health_runs_org_idx
  ON logistics_health_runs (organization_id,checked_at DESC);
CREATE INDEX IF NOT EXISTS logistics_incidents_open_idx
  ON logistics_operational_incidents (organization_id,status,severity,opened_at DESC);
CREATE INDEX IF NOT EXISTS logistics_incident_events_incident_idx
  ON logistics_incident_events (incident_id,occurred_at);

ALTER TABLE logistics_health_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_operational_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_incident_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_health_runs,logistics_operational_incidents,
  logistics_incident_events FROM anon,authenticated;
