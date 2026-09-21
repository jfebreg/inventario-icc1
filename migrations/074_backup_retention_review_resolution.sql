-- Una copia sólo puede recibir una resolución humana de conservación.
-- La revisión continúa siendo inmutable y el respaldo nunca se elimina.
CREATE UNIQUE INDEX IF NOT EXISTS logistics_backup_retention_reviews_manifest_unique
  ON logistics_backup_retention_reviews (organization_id,backup_manifest_id);

