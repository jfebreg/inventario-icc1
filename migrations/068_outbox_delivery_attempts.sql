-- Historial inalterable de cada intento de entrega de la cola transaccional.
CREATE TABLE IF NOT EXISTS logistics_outbox_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  outbox_event_id UUID NOT NULL REFERENCES logistics_outbox_events(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  channel TEXT NOT NULL DEFAULT 'POSTGRES_NOTIFY',
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'STARTED'
    CHECK (status IN ('STARTED','DELIVERED','FAILED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (outbox_event_id,attempt_number,channel)
);

CREATE INDEX IF NOT EXISTS logistics_outbox_attempt_event_idx
  ON logistics_outbox_delivery_attempts (outbox_event_id,attempt_number DESC);

CREATE INDEX IF NOT EXISTS logistics_outbox_attempt_health_idx
  ON logistics_outbox_delivery_attempts (organization_id,status,started_at DESC);

COMMENT ON TABLE logistics_outbox_delivery_attempts IS
  'Bitácora de intentos de entrega. No almacena secretos ni el cuerpo completo del evento.';

