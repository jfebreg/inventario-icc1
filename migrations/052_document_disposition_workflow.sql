-- Disposición documental con revisión, aprobación independiente y archivo seguro.
ALTER TABLE logistics_documents
  DROP CONSTRAINT IF EXISTS logistics_documents_status_check;
ALTER TABLE logistics_documents
  ADD CONSTRAINT logistics_documents_status_check
  CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','VOID','ARCHIVED'));

CREATE TABLE IF NOT EXISTS logistics_document_dispositions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  document_id UUID NOT NULL REFERENCES logistics_documents(id),
  retention_policy_id UUID REFERENCES logistics_retention_policies(id),
  legal_hold_id UUID REFERENCES logistics_legal_holds(id),
  proposed_action TEXT NOT NULL DEFAULT 'ARCHIVE'
    CHECK (proposed_action IN ('ARCHIVE')),
  status TEXT NOT NULL DEFAULT 'CANDIDATE'
    CHECK (status IN ('CANDIDATE','UNDER_REVIEW','AWAITING_APPROVAL',
      'APPROVED','ARCHIVED','REJECTED','BLOCKED')),
  reason TEXT,
  reviewer_profile_id TEXT REFERENCES inventory_user_profiles(id),
  reviewed_at TIMESTAMPTZ,
  approver_profile_id TEXT REFERENCES inventory_user_profiles(id),
  approved_at TIMESTAMPTZ,
  archived_by TEXT REFERENCES inventory_user_profiles(id),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,document_id)
);

CREATE TABLE IF NOT EXISTS logistics_document_disposition_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  disposition_id UUID NOT NULL REFERENCES logistics_document_dispositions(id),
  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  actor_profile_id TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  detail TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION logistics_document_disposition_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Los eventos de disposición documental son inalterables';
END $$;

DROP TRIGGER IF EXISTS logistics_document_disposition_events_no_change
  ON logistics_document_disposition_events;
CREATE TRIGGER logistics_document_disposition_events_no_change
  BEFORE UPDATE OR DELETE ON logistics_document_disposition_events
  FOR EACH ROW EXECUTE FUNCTION logistics_document_disposition_events_immutable();

CREATE INDEX IF NOT EXISTS logistics_document_dispositions_status_idx
  ON logistics_document_dispositions (organization_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS logistics_document_disposition_events_date_idx
  ON logistics_document_disposition_events (disposition_id,occurred_at);

ALTER TABLE logistics_document_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_document_disposition_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_document_dispositions,
  logistics_document_disposition_events FROM anon,authenticated;
