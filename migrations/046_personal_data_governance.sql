-- Gobierno de datos personales, solicitudes de titulares y trazabilidad de acceso.
CREATE TABLE IF NOT EXISTS logistics_privacy_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  activity_code TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  legal_basis TEXT NOT NULL,
  data_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  safeguards TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,activity_code)
);

CREATE TABLE IF NOT EXISTS logistics_data_subject_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  request_number TEXT NOT NULL,
  request_type TEXT NOT NULL
    CHECK (request_type IN ('ACCESS','CORRECTION','RESTRICTION','OBJECTION')),
  subject_name TEXT NOT NULL,
  subject_identifier TEXT,
  subject_email TEXT,
  verification_method TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','VERIFYING','IN_PROGRESS','COMPLETED','REJECTED')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_at TIMESTAMPTZ NOT NULL,
  assigned_to TEXT REFERENCES inventory_user_profiles(id),
  requested_scope TEXT NOT NULL,
  response_summary TEXT,
  rejection_reason TEXT,
  completed_at TIMESTAMPTZ,
  created_by TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,request_number)
);

CREATE TABLE IF NOT EXISTS logistics_personal_data_access_log (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  actor_profile_id TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  purpose TEXT NOT NULL,
  data_category TEXT NOT NULL,
  subject_reference TEXT,
  entity_type TEXT,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION logistics_personal_data_access_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Los accesos a datos personales son inalterables';
END $$;

DROP TRIGGER IF EXISTS logistics_personal_data_access_no_change
  ON logistics_personal_data_access_log;
CREATE TRIGGER logistics_personal_data_access_no_change
  BEFORE UPDATE OR DELETE ON logistics_personal_data_access_log
  FOR EACH ROW EXECUTE FUNCTION logistics_personal_data_access_immutable();

INSERT INTO logistics_privacy_activities
  (organization_id,activity_code,name,purpose,legal_basis,data_categories,
   subject_categories,recipients,safeguards)
SELECT organization.id,seed.activity_code,seed.name,seed.purpose,seed.legal_basis,
  seed.data_categories::jsonb,seed.subject_categories::jsonb,
  seed.recipients::jsonb,seed.safeguards
FROM logistics_organizations organization
CROSS JOIN (VALUES
  ('WORKER_ENROLLMENT','Enrolamiento de trabajadores',
   'Identificar trabajadores, asociarlos a contratos y gestionar entregas.',
   'Ejecución de relación laboral o contractual y obligaciones legales.',
   '["identificación","contacto","cargo","centro de costo","firma"]',
   '["trabajadores","contratistas"]','["administración","prevención de riesgos"]',
   'Acceso por rol, centro de costo, auditoría y almacenamiento privado.'),
  ('PPE_DELIVERY','Entrega y aceptación de EPP',
   'Acreditar la entrega, recepción y aceptación de elementos de protección personal.',
   'Cumplimiento de obligaciones legales de seguridad y salud ocupacional.',
   '["identificación","contacto","firma","historial de entregas"]',
   '["trabajadores","contratistas"]','["administración","prevención de riesgos"]',
   'Documento firmado, conservación controlada y acceso auditado.'),
  ('INSPECTION_APPROVAL','Inspecciones y aprobaciones',
   'Identificar responsables y acreditar revisiones, aprobaciones y correcciones.',
   'Cumplimiento contractual, seguridad operacional e interés legítimo.',
   '["identificación","firma","actividad laboral"]',
   '["inspectores","aprobadores"]','["administración","mandante autorizado"]',
   'Separación de funciones, firma enrolada y trazabilidad inalterable.')
) AS seed(activity_code,name,purpose,legal_basis,data_categories,
  subject_categories,recipients,safeguards)
ON CONFLICT (organization_id,activity_code) DO NOTHING;

CREATE INDEX IF NOT EXISTS logistics_data_subject_requests_status_idx
  ON logistics_data_subject_requests (organization_id,status,due_at);
CREATE INDEX IF NOT EXISTS logistics_personal_data_access_date_idx
  ON logistics_personal_data_access_log (organization_id,accessed_at DESC);

ALTER TABLE logistics_privacy_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_data_subject_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_personal_data_access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_privacy_activities,logistics_data_subject_requests,
  logistics_personal_data_access_log FROM anon,authenticated;
