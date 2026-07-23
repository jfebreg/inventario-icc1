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

## Registro formal de documentos

La app ahora centraliza respaldos en Reportes → Documentos y respaldos.

Se registran automáticamente:

- entregas a terreno;
- solicitudes de aceptación EPP;
- registros EPP aceptados digitalmente;
- registros de inspección;
- levantamientos de observaciones;
- documentos analizados por IA.

Ahora el servidor incluye endpoint de archivo:

- `POST /api/files/upload`: recibe adjuntos desde la app;
- `GET /api/files/:id`: permite descargar el archivo archivado;
- tabla `inventory_file_objects`: guarda metadatos, referencia y respaldo inicial.

Si no se configura Supabase Storage, el sistema usa PostgreSQL como respaldo inicial para archivos pequeños. Esto permite avanzar y probar, pero para producción se recomienda Supabase Storage o S3.

Variables opcionales para Supabase Storage en Render:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET`
- `MAX_FILE_BYTES` opcional; por defecto 8 MB.

Cuando esas variables existen, el servidor sube los archivos a Supabase Storage y conserva en la base de datos la referencia. Los registros EPP aceptados siguen pudiendo descargarse como HTML firmado.

## Limpieza de eventos y auditoría de stock

Se separaron handlers prioritarios para inspecciones, familias, bodegas, creación de centros de costo y plazos de corrección. Esto reduce el riesgo de ejecuciones duplicadas.

El formulario principal de movimientos ahora guarda en cada movimiento:

- stock antes del cambio;
- stock después del cambio;
- stock en origen;
- stock en destino;
- stock en tránsito;
- total empresa antes/después.

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
