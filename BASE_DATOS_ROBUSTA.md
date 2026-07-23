# Base de datos robusta · Inventario ICC1

La app mantiene compatibilidad con el guardado anterior `inventory_app_state`, pero ahora cada guardado también sincroniza tablas separadas para crecer de forma ordenada.

## Tablas creadas

- `inventory_families`: familias de productos.
- `inventory_cost_centers`: bodegas y centros de costo.
- `inventory_users`: usuarios/personas, PIN operativo y roles.
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
5. Los movimientos y la auditoría se insertan como historial: si ya existe el mismo registro, no se reemplaza.
6. Cada versión guardada registra el usuario que realizó el cambio.

## Usuarios y permisos agregados

La app ahora pide ingreso por usuario y PIN antes de operar. Los usuarios existentes parten con PIN temporal `1234`, que debe cambiarse desde Configuración.

Roles disponibles:

- `Administrador central`: configura la app, familias, centros, usuarios, IA, reportes y auditoría.
- `Responsable centro de costo`: mueve stock, recibe traslados, imprime, inspecciona y entrega a terreno.
- `Usuario`: consulta y realiza inspecciones.

Importante: esta es una capa operativa inicial. Para seguridad definitiva conviene pasar luego a autenticación en servidor, con contraseña cifrada o enlace mágico.

## Próxima etapa recomendada

1. Autenticación real:
   - login validado por servidor;
   - contraseña cifrada o enlace mágico;
   - sesión segura;
   - bloqueo de API según permisos por rol.

2. Almacenamiento formal de archivos:
   - recomendado: Supabase Storage o S3 compatible;
   - guardar en BD sólo metadatos y URL segura;
   - no usar disco local de Render para documentos importantes.

3. Auditoría inalterable:
   - bloquear cambios directos por API para usuarios sin permiso;
   - agregar firma digital del evento en servidor;
   - registrar stock antes/después.

4. Modularizar `app.js`:
   - separar inventario, inspecciones, IA, usuarios y movimientos;
   - eliminar eventos duplicados heredados;
   - preparar pruebas simples por módulo.
