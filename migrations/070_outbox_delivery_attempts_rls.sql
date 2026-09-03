-- La bitácora técnica sólo se consulta mediante el servidor autorizado.
ALTER TABLE logistics_outbox_delivery_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_outbox_delivery_attempts FROM anon,authenticated;

COMMENT ON TABLE logistics_outbox_delivery_attempts IS
  'Bitácora protegida de intentos de entrega; acceso exclusivo mediante el servidor y perfiles autorizados.';

