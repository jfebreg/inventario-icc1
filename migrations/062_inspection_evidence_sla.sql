-- Cola operativa de evidencias: dos horas para completar la custodia del archivo.
CREATE OR REPLACE VIEW logistics_inspection_evidence_queue
WITH (security_invoker = true) AS
SELECT inspection.id AS inspection_id,inspection.organization_id,
  inspection.asset_unit_id,inspection.warehouse_id,
  inspection.assigned_reviewer_profile_id,inspection.inspected_at,
  inspection.created_at,inspection.evidence_status,
  inspection.created_at + INTERVAL '2 hours' AS evidence_due_at,
  CASE
    WHEN inspection.created_at + INTERVAL '2 hours' < NOW() THEN 'OVERDUE'
    ELSE 'PENDING'
  END AS sla_status
FROM logistics_inspection_runs inspection
WHERE inspection.evidence_required=TRUE
  AND inspection.evidence_status<>'VERIFIED';

COMMENT ON VIEW logistics_inspection_evidence_queue IS
  'Inspecciones cuyo archivo obligatorio aún no ha completado su custodia digital.';
