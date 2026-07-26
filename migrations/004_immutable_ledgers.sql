CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE logistics_audit_events
  ADD COLUMN IF NOT EXISTS previous_hash TEXT,
  ADD COLUMN IF NOT EXISTS event_hash TEXT;

DO $$
DECLARE
  audit_row RECORD;
  current_organization UUID := NULL;
  prior_hash TEXT := NULL;
  calculated_hash TEXT;
BEGIN
  FOR audit_row IN
    SELECT id, organization_id, event_type, entity_type, entity_id,
      actor_profile_id, correlation_id, source, before_data, after_data,
      metadata, occurred_at
    FROM logistics_audit_events
    ORDER BY organization_id, id
  LOOP
    IF current_organization IS DISTINCT FROM audit_row.organization_id THEN
      current_organization := audit_row.organization_id;
      prior_hash := NULL;
    END IF;
    calculated_hash := encode(digest(concat_ws('|',
      COALESCE(prior_hash, ''),
      audit_row.organization_id::text,
      audit_row.id::text,
      audit_row.event_type,
      audit_row.entity_type,
      audit_row.entity_id,
      COALESCE(audit_row.actor_profile_id, ''),
      COALESCE(audit_row.correlation_id, ''),
      audit_row.source,
      COALESCE(audit_row.before_data, 'null'::jsonb)::text,
      COALESCE(audit_row.after_data, 'null'::jsonb)::text,
      COALESCE(audit_row.metadata, '{}'::jsonb)::text,
      EXTRACT(EPOCH FROM audit_row.occurred_at)::text
    ), 'sha256'), 'hex');
    UPDATE logistics_audit_events
      SET previous_hash=prior_hash, event_hash=calculated_hash
      WHERE id=audit_row.id;
    prior_hash := calculated_hash;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION logistics_set_audit_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  latest_hash TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('logistics-audit:' || NEW.organization_id::text));
  SELECT event_hash INTO latest_hash
    FROM logistics_audit_events
    WHERE organization_id=NEW.organization_id
    ORDER BY id DESC
    LIMIT 1;
  NEW.previous_hash := latest_hash;
  NEW.event_hash := encode(digest(concat_ws('|',
    COALESCE(NEW.previous_hash, ''),
    NEW.organization_id::text,
    NEW.id::text,
    NEW.event_type,
    NEW.entity_type,
    NEW.entity_id,
    COALESCE(NEW.actor_profile_id, ''),
    COALESCE(NEW.correlation_id, ''),
    NEW.source,
    COALESCE(NEW.before_data, 'null'::jsonb)::text,
    COALESCE(NEW.after_data, 'null'::jsonb)::text,
    COALESCE(NEW.metadata, '{}'::jsonb)::text,
    EXTRACT(EPOCH FROM NEW.occurred_at)::text
  ), 'sha256'), 'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS logistics_audit_hash_before_insert ON logistics_audit_events;
CREATE TRIGGER logistics_audit_hash_before_insert
  BEFORE INSERT ON logistics_audit_events
  FOR EACH ROW EXECUTE FUNCTION logistics_set_audit_hash();

CREATE OR REPLACE FUNCTION logistics_reject_immutable_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; use a reversal or a new audit event', TG_TABLE_NAME
    USING ERRCODE='55000';
END $$;

DROP TRIGGER IF EXISTS logistics_audit_immutable ON logistics_audit_events;
CREATE TRIGGER logistics_audit_immutable
  BEFORE UPDATE OR DELETE ON logistics_audit_events
  FOR EACH ROW EXECUTE FUNCTION logistics_reject_immutable_change();

DROP TRIGGER IF EXISTS logistics_ledger_immutable ON logistics_stock_ledger;
CREATE TRIGGER logistics_ledger_immutable
  BEFORE UPDATE OR DELETE ON logistics_stock_ledger
  FOR EACH ROW EXECUTE FUNCTION logistics_reject_immutable_change();

CREATE OR REPLACE FUNCTION logistics_reject_movement_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Stock movements cannot be deleted; post a REVERSAL movement'
    USING ERRCODE='55000';
END $$;

DROP TRIGGER IF EXISTS logistics_movement_no_delete ON logistics_stock_movements;
CREATE TRIGGER logistics_movement_no_delete
  BEFORE DELETE ON logistics_stock_movements
  FOR EACH ROW EXECUTE FUNCTION logistics_reject_movement_delete();

CREATE OR REPLACE VIEW logistics_audit_chain_verification AS
WITH verified AS (
  SELECT audit.*,
    LAG(event_hash) OVER (PARTITION BY organization_id ORDER BY id) AS expected_previous_hash,
    encode(digest(concat_ws('|',
      COALESCE(previous_hash, ''),
      organization_id::text,
      id::text,
      event_type,
      entity_type,
      entity_id,
      COALESCE(actor_profile_id, ''),
      COALESCE(correlation_id, ''),
      source,
      COALESCE(before_data, 'null'::jsonb)::text,
      COALESCE(after_data, 'null'::jsonb)::text,
      COALESCE(metadata, '{}'::jsonb)::text,
      EXTRACT(EPOCH FROM occurred_at)::text
    ), 'sha256'), 'hex') AS calculated_hash
  FROM logistics_audit_events audit
)
SELECT id, organization_id, event_type, entity_type, entity_id, occurred_at,
  event_hash=calculated_hash AS content_valid,
  previous_hash IS NOT DISTINCT FROM expected_previous_hash AS link_valid
FROM verified;
