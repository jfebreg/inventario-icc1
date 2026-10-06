-- No se alteran migraciones ya aplicadas ni se cambia el contenido de los datos.
-- El servidor debe conectar con el propietario/BYPASSRLS, no con anon/authenticated.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;
CREATE SCHEMA IF NOT EXISTS extensions;
REVOKE CREATE ON SCHEMA extensions FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA extensions TO authenticated, service_role;

ALTER VIEW public.logistics_stock_on_hand SET (security_invoker = true);
ALTER VIEW public.logistics_company_stock SET (security_invoker = true);
ALTER VIEW public.logistics_audit_chain_verification SET (security_invoker = true);
REVOKE ALL ON public.logistics_stock_on_hand, public.logistics_company_stock,
  public.logistics_audit_chain_verification FROM PUBLIC, anon, authenticated;

ALTER TABLE public.inventory_auth_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logistics_schema_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_auth_settings, public.logistics_schema_migrations
  FROM PUBLIC, anon, authenticated;

-- Helpers usados por las políticas RLS: authenticated debe conservar EXECUTE.
ALTER FUNCTION public.inventory_is_admin() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.inventory_user_center() SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION public.inventory_is_admin(), public.inventory_user_center() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_is_admin(), public.inventory_user_center() TO authenticated;

-- Solo las funciones de trigger propias del informe. No modificar funciones de extensiones.
DO $$
DECLARE
  target RECORD;
  hardened INTEGER := 0;
BEGIN
  FOR target IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.pronargs=0
      AND p.prorettype='pg_catalog.trigger'::regtype
      AND p.proname = ANY (ARRAY[
        'logistics_set_audit_hash',
        'logistics_reject_immutable_change',
        'logistics_reject_movement_delete',
        'inventory_security_events_immutable',
        'logistics_incident_events_immutable',
        'logistics_release_checks_immutable',
        'logistics_personal_data_access_immutable',
        'logistics_privacy_incident_events_immutable',
        'inventory_file_object_immutable',
        'logistics_file_access_alert_events_immutable',
        'logistics_evidence_verification_results_immutable',
        'logistics_document_disposition_events_immutable',
        'logistics_digital_attestations_immutable',
        'logistics_guard_inspection_run_separation',
        'logistics_guard_inspection_approval_separation',
        'logistics_reject_inspection_evidence_change',
        'logistics_guard_inspection_template_version',
        'logistics_guard_inspection_run_evidence',
        'logistics_reject_inspection_plan_event_change',
        'logistics_validate_inspection_plan_execution',
        'logistics_require_inspection_evidence_before_approval',
        'logistics_scheduled_job_events_immutable',
        'logistics_enqueue_automation_notification',
        'logistics_backup_retention_review_immutable',
        'logistics_backup_recovery_objective_history_immutable'
      ])
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, extensions, pg_temp', target.signature);
    hardened := hardened + 1;
  END LOOP;
  IF hardened <> 25 THEN
    RAISE EXCEPTION 'Hardening incompleto: se esperaban 25 triggers, se encontraron %', hardened;
  END IF;
END $$;

-- Los índices existentes mantienen sus dependencias; las consultas del servidor
-- usan extensions.similarity explícitamente después de esta migración.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname='pg_trgm' AND n.nspname <> 'extensions') THEN
    ALTER EXTENSION pg_trgm SET SCHEMA extensions;
  END IF;
END $$;
