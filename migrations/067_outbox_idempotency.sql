-- Idempotencia para eventos críticos entregados por la cola transaccional.
ALTER TABLE logistics_outbox_events
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS logistics_outbox_events_idempotency_uq
  ON logistics_outbox_events (organization_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN logistics_outbox_events.idempotency_key IS
  'Clave estable que impide duplicar un evento lógico durante reintentos o concurrencia.';

CREATE OR REPLACE FUNCTION logistics_enqueue_automation_notification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  target_organization UUID;
  durable_event_type TEXT;
BEGIN
  IF NEW.entity_type='scheduled_job' THEN
    SELECT organization_id INTO target_organization FROM logistics_scheduled_jobs
      WHERE id::text=NEW.entity_id LIMIT 1;
  ELSIF NEW.entity_type='automation_slo' THEN
    SELECT organization_id INTO target_organization FROM logistics_automation_slo_policies
      WHERE id::text=NEW.entity_id LIMIT 1;
  END IF;
  durable_event_type := CASE NEW.notification_type
    WHEN 'SCHEDULER_FAILURE' THEN 'automation.verification.failed'
    WHEN 'SCHEDULER_INTERRUPTED' THEN 'automation.verification.interrupted'
    WHEN 'SCHEDULER_ESCALATION' THEN 'automation.verification.escalated'
    WHEN 'SCHEDULER_RECOVERED' THEN 'automation.verification.recovered'
    WHEN 'AUTOMATION_SLO_BREACH' THEN 'automation.slo.breached'
    WHEN 'AUTOMATION_SLO_RECOVERED' THEN 'automation.slo.recovered'
    ELSE NULL
  END;
  IF target_organization IS NOT NULL AND durable_event_type IS NOT NULL THEN
    INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload,idempotency_key,
       status,available_at)
    VALUES (target_organization,durable_event_type,NEW.entity_type,NEW.entity_id,
      jsonb_build_object('notificationId',NEW.id,'title',NEW.title,'body',NEW.body,
        'severity',NEW.severity,'payload',NEW.payload),
      'notification:'||NEW.id,'PENDING',NOW())
    ON CONFLICT (organization_id,idempotency_key) WHERE idempotency_key IS NOT NULL
    DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS inventory_automation_notification_outbox
  ON inventory_notifications;
CREATE TRIGGER inventory_automation_notification_outbox
  AFTER INSERT ON inventory_notifications
  FOR EACH ROW
  WHEN (NEW.notification_type IN ('SCHEDULER_FAILURE','SCHEDULER_INTERRUPTED',
    'SCHEDULER_ESCALATION','SCHEDULER_RECOVERED','AUTOMATION_SLO_BREACH',
    'AUTOMATION_SLO_RECOVERED'))
  EXECUTE FUNCTION logistics_enqueue_automation_notification();
