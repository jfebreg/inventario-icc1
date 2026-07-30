-- Gobierno de accesos, mínimo privilegio y revisión periódica.
ALTER TABLE inventory_user_profiles
  ADD COLUMN IF NOT EXISTS security_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_security_change_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS inventory_role_templates (
  role_code TEXT PRIMARY KEY,
  role_name TEXT NOT NULL UNIQUE,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  privileged BOOLEAN NOT NULL DEFAULT FALSE,
  can_initiate BOOLEAN NOT NULL DEFAULT FALSE,
  can_approve BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO inventory_role_templates
  (role_code,role_name,permissions,privileged,can_initiate,can_approve,description)
VALUES
  ('USER','Usuario','["view"]',FALSE,FALSE,FALSE,'Consulta dentro de su centro de costo.'),
  ('INSPECTOR','Inspector','["view","inspect"]',FALSE,FALSE,FALSE,'Registra inspecciones sin aprobarlas.'),
  ('WAREHOUSE_OPERATOR','Operador de bodega',
    '["view","move","receive","terrain","print"]',FALSE,TRUE,FALSE,
    'Opera existencias y recepciones dentro de su bodega.'),
  ('CENTER_MANAGER','Responsable centro de costo',
    '["view","inspect","move","receive","terrain","print","workers"]',FALSE,TRUE,FALSE,
    'Gestiona la operación de su centro sin aprobar sus propias transacciones.'),
  ('CENTER_APPROVER','Aprobador centro de costo',
    '["view","approve","audit"]',FALSE,FALSE,TRUE,
    'Aprueba operaciones de otras personas dentro de su centro.'),
  ('CENTRAL_ADMIN','Administrador central',
    '["view","inspect","approve","move","receive","terrain","print","workers","admin","ai","audit"]',
    TRUE,TRUE,TRUE,'Administración global; sus acciones privilegiadas quedan auditadas.')
ON CONFLICT (role_code) DO UPDATE SET
  role_name=EXCLUDED.role_name,permissions=EXCLUDED.permissions,
  privileged=EXCLUDED.privileged,can_initiate=EXCLUDED.can_initiate,
  can_approve=EXCLUDED.can_approve,description=EXCLUDED.description,
  active=TRUE,updated_at=NOW();

CREATE TABLE IF NOT EXISTS inventory_access_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewed_by TEXT REFERENCES inventory_user_profiles(id),
  status TEXT NOT NULL DEFAULT 'COMPLETED'
    CHECK (status IN ('COMPLETED','REQUIRES_ACTION')),
  profile_count INTEGER NOT NULL DEFAULT 0,
  issue_count INTEGER NOT NULL DEFAULT 0,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_security_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_profile_id TEXT REFERENCES inventory_user_profiles(id),
  target_profile_id TEXT REFERENCES inventory_user_profiles(id),
  before_data JSONB,
  after_data JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION inventory_security_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Los eventos de seguridad son inalterables';
END $$;

DROP TRIGGER IF EXISTS inventory_security_events_no_change ON inventory_security_events;
CREATE TRIGGER inventory_security_events_no_change
  BEFORE UPDATE OR DELETE ON inventory_security_events
  FOR EACH ROW EXECUTE FUNCTION inventory_security_events_immutable();

CREATE INDEX IF NOT EXISTS inventory_security_events_target_idx
  ON inventory_security_events (target_profile_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS inventory_access_reviews_date_idx
  ON inventory_access_reviews (reviewed_at DESC);

ALTER TABLE inventory_role_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_access_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_security_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inventory_role_templates,inventory_access_reviews,
  inventory_security_events FROM anon,authenticated;
