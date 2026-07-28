# Arquitectura logística V2

## Objetivo

La V2 incorpora un modelo transaccional compatible con la aplicación vigente. Durante la migración, el estado anterior se conserva sin modificaciones y el nuevo libro mayor se construye en paralelo.

## Componentes implementados

- Organización, centros de costo, sitios, bodegas y ubicaciones jerárquicas.
- Familias, artículos maestros, unidades físicas serializadas y lotes.
- Unidades de medida, presentaciones de compra/entrega y códigos alternativos por artículo.
- Catálogo producto–proveedor con código externo, presentación, plazo, mínimo, múltiplo y precio.
- Clasificación ABC/XYZ persistente y políticas de frecuencia/tolerancia para conteos.
- Solicitudes internas con reserva, tareas de picking ordenadas por ubicación y verificación por escaneo.
- Despacho de solicitudes entre bodegas mediante tránsito y recepción confirmada en destino.
- Indicadores de nivel de servicio, puntualidad, exactitud de picking, exactitud de inventario y tiempos de ciclo.
- Metas configurables por organización o bodega, con tareas críticas y notificaciones ante desviaciones.
- Cierre diario programado de indicadores, con zona horaria configurable, bloqueo distribuido,
  recuperación manual y alertas críticas ante fallas.
- Cola transaccional de eventos con reclamo concurrente, reintentos progresivos, descarte
  controlado, supervisión y recuperación administrativa.
- Revisión diaria de reposición que propone cantidades y genera tareas por bodega, sin emitir
  solicitudes de compra ni comprometer presupuesto automáticamente.
- Programa diario de conteos cíclicos por bodega, basado en ABC/XYZ, saldo físico y último
  conteo contabilizado.
- Movimientos confirmados y libro mayor inalterable.
- Proyección de saldos con versión para concurrencia.
- Traslados con líneas, tránsito, despacho, recepción parcial y recepción completa.
- Custodia de activos, entrega EPP y consumo.
- Documentos versionados y relaciones con entidades.
- Auditoría y cola de eventos.
- Plantillas de inspección versionadas, respuestas, hallazgos y aprobaciones.
- Migraciones SQL versionadas y verificadas por checksum.
- Importación inicial idempotente desde `inventory_app_state`.

## Reglas esenciales

1. El stock sólo cambia mediante un movimiento confirmado.
2. Un movimiento confirmado no se edita ni elimina.
3. Los errores se corrigen mediante reversa.
4. Cada operación de escaneo debe incluir `idempotencyKey`.
5. Los artículos serializados exigen unidad física y cantidad uno.
6. Los artículos por lote exigen lote.
7. No se permite despachar más stock que el disponible.
8. La recepción no puede superar lo despachado.
9. El origen y destino de un traslado deben ser distintos.
10. El estado anterior continúa disponible hasta completar la conciliación.

11. Una solicitud no puede entregarse hasta verificar por escaneo todas sus tareas de picking.
12. Cada diferencia de cantidad exige una excepción documentada antes de continuar.
13. Un despacho entre bodegas conserva el stock de la empresa en tránsito hasta su recepción.
14. Los cierres de indicadores se calculan desde transacciones auditables y quedan versionados por fecha.
15. Las desviaciones de KPI generan tareas con prioridad y se cierran automáticamente al recuperar la meta.
16. Las automatizaciones usan bloqueo PostgreSQL y nunca dependen de una sola instancia del servidor.
17. Cada publicación conserva un identificador estable; las integraciones consumidoras deben tratarlo
    como clave de idempotencia.
18. La automatización de abastecimiento propone y alerta; una persona autorizada conserva la decisión
    de crear, enviar y aprobar cada solicitud de compra.
19. La planificación de conteos nunca altera saldos; el ajuste sólo ocurre tras conteo, revisión,
    aprobación y contabilización.

## API V1 disponible

- `GET /api/v1/logistics/status`
- `GET /api/v1/reconciliation` — sólo administrador.
- `GET /api/v1/items`
- `GET /api/v1/item-identifiers/:code`
- `POST /api/v1/item-presentations` — sólo administrador.
- `GET /api/v1/supplier-items`
- `POST /api/v1/supplier-items` — sólo administrador.
- `GET /api/v1/inventory-classifications`
- `POST /api/v1/inventory-classifications/calculate` — sólo administrador.
- `PATCH /api/v1/inventory-classification-policies` — sólo administrador.
- `GET /api/v1/warehouses`
- `GET /api/v1/stock`
- `POST /api/v1/stock/movements`
- `GET /api/v1/transfers`
- `POST /api/v1/transfers`
- `POST /api/v1/transfers/:id/dispatch`
- `POST /api/v1/transfers/:id/receive`
- `GET /api/v1/material-requests`
- `POST /api/v1/material-requests`
- `PATCH /api/v1/material-requests/:id`
- `PATCH /api/v1/pick-tasks/:id`
- `GET /api/v1/logistics-kpis`
- `POST /api/v1/logistics-kpis/snapshot` — sólo administrador.
- `GET /api/v1/logistics-kpi-targets`
- `PATCH /api/v1/logistics-kpi-targets` — sólo administrador.

Todas las rutas requieren autenticación cuando Supabase Auth está activo y validan los permisos del perfil.

## Despliegue

No requiere variables nuevas. Al iniciar el servidor:

1. Se ejecutan únicamente las migraciones pendientes.
2. Se verifica que una migración aplicada no haya sido alterada.
3. Se crea o actualiza la organización ICC.
4. Se importan bodegas, artículos, unidades y saldos vigentes.
5. La importación usa claves de idempotencia; reiniciar el servicio no duplica stock.

Antes de publicar:

```text
npm run check
npm test
```

Después de publicar, revisar `/api/health`. Debe indicar:

```json
{
  "logisticsReady": true
}
```

## Próximo corte de migración

La siguiente etapa debe conectar las pantallas de movimientos y traslados a `/api/v1`. Durante ese período se compararán automáticamente los saldos antiguos con el libro mayor. Sólo después de lograr conciliación completa se dejará `inventory_app_state` como respaldo de lectura.

## Segunda etapa implementada

- Reportes y Configuración muestran el estado del libro mayor V2.
- El administrador puede comparar saldos anteriores y canónicos.
- Los movimientos desde la pantalla principal se publican primero en V2.
- Las salidas entre bodegas crean traslado y despacho formal.
- Las recepciones confirman el traslado V2, incluyendo los pendientes migrados.
- Si V2 rechaza una operación, el estado anterior no se modifica.
- Los movimientos guardan la referencia canónica para conservar trazabilidad entre ambos modelos.

## Conteos cíclicos programados

- La revisión diaria genera tareas por bodega según clasificación ABC/XYZ.
- Desde la bandeja, el usuario inicia un conteo ciego que incluye sólo los productos vencidos.
- Una tarea y su conteo quedan vinculados para impedir duplicidades.
- Cancelar el conteo reactiva la tarea; no la elimina ni altera saldos.
- La tarea sólo se resuelve al aprobar y contabilizar el conteo.
- Cada diferencia genera un movimiento de ajuste individual, idempotente y auditado.
- Una tarea de conteo no puede marcarse manualmente como resuelta.
- Las diferencias se comparan con la tolerancia configurada para la clase ABC.
- Una diferencia fuera de tolerancia exige reconteo ciego por otra persona.
- El reconteo conserva el primer resultado y exige un motivo normalizado.
- El aprobador no puede ser quien realizó el conteo ni el reconteo.
- La exactitud utiliza una vista canónica con el resultado final aprobado.
- Los reportes muestran exactitud, cumplimiento de tolerancia y tasa de reconteo.
- Las diferencias se analizan por bodega, causa, fecha, cantidad y valor.
- Los usuarios de centro sólo ven los indicadores correspondientes a su ámbito.

## Gobierno de datos maestros

- Una revisión diaria detecta artículos sin familia o unidad base.
- Se identifican existencias sin costo y materiales sin política de reposición.
- Las unidades serializadas sin serie de fabricante quedan visibles como incidencia.
- Cada incidencia mantiene historial y crea una tarea según su severidad.
- Cuando el dato se corrige, la siguiente revisión resuelve la incidencia y su tarea.
- La revisión manual y el panel completo están restringidos a administración.
- Cada incidencia abierta ofrece una corrección guiada según su regla.
- Familia, unidad, bodega y serie se validan dentro de la organización antes de guardar.
- La política de reposición exige mínimo, punto de pedido y máximo coherentes.
- Toda corrección conserva valor anterior, valor nuevo, responsable, fecha y fundamento.
- Después de guardar, el sistema repite la revisión y sólo confirma si la causa desapareció.
