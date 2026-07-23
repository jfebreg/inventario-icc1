# Base de datos robusta · Inventario ICC1

La app mantiene compatibilidad con el guardado anterior `inventory_app_state`, pero ahora cada guardado también sincroniza tablas separadas para crecer de forma ordenada.

## Tablas creadas

- `inventory_families`: familias de productos.
- `inventory_cost_centers`: bodegas y centros de costo.
- `inventory_users`: usuarios/personas y roles.
- `inventory_assets`: activos y consumibles.
- `inventory_asset_stock`: stock por activo y bodega.
- `inventory_movements`: movimientos de inventario.
- `inventory_workers`: trabajadores por centro de costo.
- `inventory_worker_signatures`: firmas digitalizadas.
- `inventory_inspections`: inspecciones realizadas.
- `inventory_documents`: metadatos de documentos adjuntos.
- `inventory_ai_results`: resultados y borradores generados por IA.
- `inventory_inspection_templates`: plantillas creadas desde documentos.
- `inventory_audit_log`: auditoría funcional de acciones.
- `inventory_state_versions`: versiones de respaldo de cada guardado.

## Flujo actual

1. El navegador sigue enviando el estado completo a `/api/state`.
2. El servidor guarda el respaldo completo en `inventory_app_state`.
3. En la misma transacción, el servidor sincroniza las tablas separadas.
4. Si algo falla, se revierte el guardado para evitar datos a medias.

## Próxima etapa recomendada

1. Autenticación real:
   - login por usuario;
   - contraseña o enlace mágico;
   - sesión segura;
   - permisos por rol.

2. Almacenamiento formal de archivos:
   - recomendado: Supabase Storage o S3 compatible;
   - guardar en BD sólo metadatos y URL segura;
   - no usar disco local de Render para documentos importantes.

3. Auditoría inalterable:
   - pasar de auditoría funcional a auditoría append-only;
   - no permitir edición/eliminación desde interfaz;
   - registrar stock antes/después.

4. Modularizar `app.js`:
   - separar inventario, inspecciones, IA, usuarios y movimientos;
   - eliminar eventos duplicados heredados;
   - preparar pruebas simples por módulo.
