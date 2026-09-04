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
- La revisión compara artículos por nombre, familia, tipo, marca y modelo para advertir duplicados.
- Cada candidato conserva un porcentaje y los factores que originaron la coincidencia.
- Administración decide si son productos distintos o confirma la duplicidad con fundamento.
- Un caso descartado no reaparece en revisiones posteriores.
- Confirmar una duplicidad no fusiona códigos ni modifica saldos; crea una tarea prioritaria.
- Antes de crear un SKU nuevo, el servidor compara nombre, familia, tipo y marca.
- Agregar unidades a un SKU existente continúa permitido y no genera un falso positivo.
- Una coincidencia bloquea el alta para usuarios de bodega.
- Sólo administración puede autorizar la excepción con un fundamento obligatorio.
- La autorización conserva los candidatos comparados en auditoría y en la cola de eventos.

## Identificadores GS1 y códigos operativos

- SKU, GTIN/EAN/UPC y códigos de presentación viven en un registro canónico único.
- La lectura consulta primero ese registro y conserva compatibilidad con el catálogo anterior.
- Los códigos comerciales numéricos de 8, 12, 13 o 14 dígitos validan su dígito GS1.
- Un identificador activo no puede pertenecer a dos artículos de la misma organización.
- Cambiar el código de una presentación desactiva el anterior para evitar lecturas ambiguas.
- Los códigos internos alfanuméricos continúan disponibles para etiquetas propias de ICC.

## Corte controlado a fuente canónica

- El inventario permanece en escritura paralela mientras se compara el respaldo con el libro mayor.
- La activación exige tres conciliaciones limpias consecutivas, cadena de auditoría íntegra,
  ausencia de eventos descartados y ningún ajuste pendiente de aprobación.
- Cualquier falla reinicia el contador para impedir un corte basado en una comprobación aislada.
- La activación y toda reversa quedan registradas en auditoría y en la cola transaccional.
- Una reversa requiere motivo y vuelve a escritura paralela; nunca elimina movimientos canónicos.
- El respaldo heredado permanece disponible para consulta y recuperación durante la estabilización.

## Gobierno de accesos

- Los permisos se asignan mediante una matriz cerrada de roles basada en mínimo privilegio.
- Inspector, operador de bodega, responsable y aprobador son perfiles independientes.
- La separación entre operación y aprobación se revisa para cada usuario no administrador.
- Los permisos desconocidos, invitaciones antiguas y cuentas sin uso generan observaciones.
- Cada cambio de rol, centro, activación o desactivación incrementa la versión de seguridad.
- Las revisiones de acceso y los eventos de seguridad son inalterables y quedan vinculados
  a la auditoría logística.

## Confiabilidad operativa en terreno

- Cada celular, lector USB, estación de trabajo e impresora de etiquetas puede registrarse
  como un perfil operativo asociado a la organización y, cuando corresponda, a una bodega.
- El diagnóstico guiado verifica contexto seguro, conexión, almacenamiento local,
  cámara y QR, comportamiento del lector USB e impresión física de una etiqueta.
- La impresora inicial queda documentada como Xprinter XP-360B, USB, 203 DPI y
  etiqueta de 51 × 27 mm, sin impedir registrar otros modelos posteriormente.
- Cada prueba conserva resultado, responsable, fecha, mediciones y observaciones.
- Una ventana anti-rebote evita que una misma lectura de QR o pistola abra dos
  operaciones por el mismo disparo.
- Las comprobaciones se registran en auditoría y en la cola transaccional; la
  confirmación de impresión exige validar físicamente legibilidad y lectura del QR.

## Continuidad y gestión de incidentes

- El servidor registra periódicamente la salud de base de datos, autenticación,
  almacenamiento, agenda automática y cola de eventos.
- Los incidentes se clasifican desde SEV1 crítico hasta SEV4 menor, conservando
  impacto, responsable, tiempos de reconocimiento, mitigación y resolución.
- Cada cambio de estado agrega un evento inalterable y una referencia en auditoría.
- Los incidentes críticos crean tareas visibles y no se cierran sin resolución,
  causa raíz y acción correctiva.
- Administración puede ejecutar un diagnóstico manual y comparar el resultado
  con los controles automáticos anteriores.
- El historial permite demostrar continuidad, tiempos de respuesta y aprendizaje
  frente a fallas sin depender únicamente de los registros temporales de Render.

## Prevención de operaciones duplicadas

- Movimientos de stock, entregas y devoluciones de custodia, despachos y recepciones
  exigen una clave estable antes de modificar existencias.
- La creación de traslados y entregas utiliza un número o referencia externa única.
- Reintentar desde un celular con mala señal devuelve el resultado previo y no genera
  una segunda salida, recepción o cargo.
- Las claves se validan en el servidor y no dependen solamente del bloqueo visual del botón.

## Integridad de archivos

- Cada archivo conserva tamaño y huella SHA-256 desde su carga inicial.
- Antes de descargar desde PostgreSQL o Supabase Storage el servidor vuelve a calcular
  ambos valores y bloquea cualquier diferencia.
- Una falla de integridad queda registrada en auditoría con archivo, proveedor y responsable.
- Las descargas válidas informan su huella mediante encabezados verificables sin volver público el bucket.
- La carga acepta solamente PDF, imágenes, Word, Excel y texto operativo autorizado.
- El servidor revisa la firma binaria real; cambiar la extensión de un ejecutable no permite archivarlo.
- Los formatos activos como HTML y SVG no se almacenan como documentos de evidencia.
- El servidor genera un identificador nuevo para cada carga y nunca acepta uno elegido por el navegador.
- PostgreSQL impide sustituir contenido, tamaño, proveedor o huella después del registro.
- La eliminación sólo puede habilitarse dentro del proceso formal de disposición documental.
- Cada descarga registra usuario, propósito, categoría, centro y documento asociado.
- El registro de acceso no conserva direcciones IP, tokens ni credenciales del usuario.
- Firmas, EPP, inspecciones y antecedentes de trabajadores se distinguen para facilitar auditorías.

## Gobierno de versiones y despliegues

- Cada publicación registra el commit de GitHub, servicio Render, migración más reciente,
  ambiente, fecha y estado de aprobación.
- El despliegue ejecuta verificaciones obligatorias de base de datos, migraciones,
  auditoría, autenticación, almacenamiento y continuidad.
- Una versión no puede aprobarse mientras exista un control obligatorio fallido.
- Aprobar una nueva versión reemplaza formalmente la aprobación anterior, pero no elimina
  su historial ni sus verificaciones.
- Registrar una reversa exige fundamento y conserva el commit afectado; la ejecución
  material de la reversa se realiza mediante Render o GitHub.
- El panel administrativo muestra qué versión está operando y evita confundir código
  desplegado con código formalmente validado para producción.

## Gobierno de datos personales

- El sistema mantiene un registro de los tratamientos que utilizan identificación,
  datos de contacto, cargo, centro de costo y firmas de trabajadores.
- Las solicitudes de acceso, corrección, restricción u oposición conservan número,
  plazo, responsable, verificación de identidad, respuesta y estado.
- Antes de entregar información personal se exige registrar el medio utilizado para
  verificar la identidad del titular.
- Los accesos administrativos quedan en un registro inalterable con usuario, fecha,
  propósito y categoría consultada.
- Una solicitud de privacidad no elimina movimientos, inspecciones, firmas ni otros
  documentos sujetos a conservación legal o contractual.
- Las tablas permanecen protegidas por RLS y sólo el servidor con perfil administrador
  puede tramitar solicitudes o consultar la trazabilidad completa.

## Respuesta ante incidentes de privacidad

- Cada incidente conserva número, detección, responsable, categorías de datos y personas,
  cantidad potencialmente afectada e impacto en confidencialidad, integridad y disponibilidad.
- El nivel de severidad se deriva de una evaluación de riesgo entre 0 y 100.
- La secuencia obligatoria distingue evaluación, contención, decisión de notificación
  y cierre con causa raíz y acciones correctivas.
- Los incidentes crean una tarea prioritaria y no pueden cerrarse sin una decisión
  documentada sobre la notificación.
- Cada transición queda en un historial inalterable y en la auditoría logística.
- La aplicación registra la decisión; los plazos y destinatarios legales deben validarse
  con asesoría jurídica según el contrato y la normativa aplicable.

## Detección de accesos documentales anómalos

- Las descargas de evidencias se analizan en ventanas de 15 minutos por usuario.
- El sistema genera alertas por volumen elevado, cantidad de archivos distintos o acceso
  reiterado a firmas, registros EPP y antecedentes de trabajadores.
- Una alerta no interrumpe una descarga autorizada, pero crea una tarea prioritaria y una
  notificación para administración.
- Las alertas se revisan, descartan o confirman con fundamento obligatorio.
- Confirmar un acceso no autorizado genera una tarea crítica para formalizar el incidente
  de privacidad y aplicar el procedimiento de respuesta.
- Cada detección y cambio de estado queda en un historial inalterable; no se almacenan
  direcciones IP, tokens ni credenciales.

## Disponibilidad verificable de evidencias

- Administración puede comprobar por lotes los archivos con mayor antigüedad de revisión.
- Cada comprobación recupera el contenido real desde Supabase Storage o PostgreSQL,
  recalcula tamaño y SHA-256 y lo compara con el registro de carga.
- Los resultados distinguen archivo verificado, faltante, alterado y error de proveedor.
- Una diferencia crea una tarea crítica sin sustituir ni eliminar el registro original.
- Cada ejecución conserva responsable, fecha, cantidades y resultados inalterables.
- Una agenda semanal revisa 25 evidencias, priorizando las nunca comprobadas y las más antiguas.
- PostgreSQL aplica un bloqueo distribuido para impedir ejecuciones duplicadas entre instancias.
- Si el proceso se interrumpe, vuelve a quedar disponible después de 30 minutos; una falla
  controlada programa reintento en cuatro horas y genera una tarea crítica.

## Disposición documental controlada

- Cumplir el plazo de conservación crea un expediente candidato; nunca elimina el archivo.
- Un bloqueo legal activo detiene automáticamente cualquier propuesta de archivo.
- El revisor documenta el fundamento y una segunda persona administradora debe aprobarlo.
- El sistema impide que el revisor apruebe o rechace su propia propuesta.
- Archivar conserva el contenido, huella, relaciones, historial y capacidad de descarga.
- Cada transición queda en eventos inalterables y en la auditoría logística.

## Constancias digitales trazables

- La aceptación de EPP queda vinculada al cargo, trabajador, artículo, cantidad, fecha y
  hash del token de un solo uso; el token original no se incluye en respuestas ni evidencias.
- La aprobación de una inspección y la verificación de una corrección requieren una sesión
  autenticada y conservan el perfil responsable y el contenido exacto del acto.
- El envío original del inspector genera su propia constancia y el PDF incorpora las etapas
  disponibles con identificador, firmante, fecha y huella SHA-256 obtenidos desde el servidor.
- Cada constancia incorpora huellas SHA-256 del consentimiento y del contenido, además de
  la huella de la constancia anterior para formar una cadena verificable.
- PostgreSQL impide modificar o eliminar las constancias y bloquea el acceso directo desde
  clientes anónimos o autenticados; sólo el servidor autorizado puede crearlas y consultarlas.
- La idempotencia evita duplicar evidencia si una petición segura se reintenta.
- Estas constancias aportan trazabilidad e integridad, pero no se presentan como una firma
  electrónica avanzada o certificada por un prestador acreditado.

## Segregación en inspecciones

- La persona que ejecuta y envía una inspección no puede aprobarla ni verificar su propia
  corrección, incluso si su perfil administrativo reúne ambos permisos.
- El control se aplica en interfaz, servicio y triggers de PostgreSQL para evitar que una
  integración o acceso privilegiado omita la regla operacional.
- La revisión periódica de accesos identifica autoaprobaciones históricas sin borrar ni
  modificar sus evidencias y las presenta como observaciones de riesgo alto.

## Integridad del expediente de inspección

- Las respuestas, decisiones y puntos de una plantilla quedan inalterables en PostgreSQL
  después de su registro; un cambio de formulario exige crear una versión nueva.
- La identidad del equipo, plantilla, inspector, fecha, resultado y observaciones originales
  no pueden reescribirse durante las etapas posteriores de aprobación o corrección.
- Cada cambio de un hallazgo conserva estado anterior, estado posterior, responsable, fecha
  y fundamento en un historial append-only protegido con RLS.
- El historial también cubre correcciones realizadas mediante una orden de mantenimiento,
  además de plazos, levantamientos y verificaciones del flujo de inspección.

## Asignación y SLA de revisión

- Cada inspección nueva intenta vincular al revisor seleccionado con un perfil activo del
  centro de costo o con un administrador; la asignación queda almacenada en el expediente.
- El envío crea una tarea y una notificación en tiempo real, con un plazo predeterminado de
  24 horas. Las inspecciones no conformes se presentan con prioridad crítica.
- Establecer un plazo resuelve la revisión inicial y crea una tarea de corrección para el
  centro responsable. Registrar el levantamiento crea una verificación independiente para
  el revisor asignado.
- Aprobar o verificar resuelve las tareas correspondientes. El proceso conserva la regla de
  que el inspector no puede aprobar ni verificar su propio trabajo.
- Un proceso periódico detecta plazos vencidos, eleva la prioridad, marca el expediente como
  escalado y publica una notificación crítica sin duplicarla en ejecuciones posteriores.
- El correo puede complementar la comunicación, pero la fuente oficial de pendientes,
  responsables y vencimientos es la bandeja de tareas de la aplicación.

## Programación preventiva de inspecciones

- Cada unidad serializada puede tener un plan activo con primera fecha, frecuencia,
  anticipación de aviso, días de gracia y criterio de bloqueo por vencimiento.
- La siguiente fecha se calcula desde la última inspección aprobada o cerrada; si todavía no
  existe una, se utiliza la primera fecha configurada por el usuario.
- Una revisión diaria crea o actualiza tareas y notificaciones del centro de costo sin
  duplicarlas. Los avisos próximos son de prioridad alta y los vencidos son críticos.
- Cuando el plan exige bloqueo, el equipo pasa a bloqueado después del plazo de gracia. La
  liberación automática sólo ocurre tras una inspección válida y si no existen órdenes de
  mantenimiento ni antecedentes técnicos críticos vencidos.
- Crear o modificar un plan deja auditoría y un evento inalterable con el estado anterior y
  posterior. Desactivar un plan no elimina su historial.
- La pantalla de Inspecciones permite crear y editar planes y ejecutar una revisión inmediata;
  la fuente oficial es PostgreSQL, no la fecha conservada por el navegador.
- Cada plan conserva la clave del formulario exigido. Una inspección de otra familia o con un
  checklist distinto no puede satisfacer accidentalmente la periodicidad del equipo.
- La ejecución registra el identificador del plan y PostgreSQL comprueba que coincidan equipo
  y formulario. Las inspecciones históricas compatibles se vinculan durante la migración.
- Aprobar o verificar la ejecución correcta recalcula el vencimiento y resuelve su tarea de
  manera inmediata; no es necesario esperar al proceso diario.

## Gobierno de formularios de inspección

- Todo formulario nuevo o modificado se guarda primero como borrador inalterable. Publicarlo
  requiere una sesión con permiso de aprobación y una persona distinta de quien lo creó.
- Cada versión conserva autor, aprobador, motivo del cambio, fechas y huella SHA-256 de la
  definición. Los eventos de creación, aprobación y retiro son append-only.
- Sólo puede existir una versión publicada por organización y clave de formulario. Publicar
  una versión nueva retira la anterior sin reescribirla ni afectar inspecciones históricas.
- La ejecución móvil sólo acepta una versión publicada y comprueba que los ítems recibidos
  coincidan exactamente. Nunca crea, modifica ni publica formularios automáticamente.
- Las versiones activas anteriores a este control se identifican como legado para mantener
  continuidad. Su siguiente modificación debe seguir el flujo formal de borrador y aprobación.

## Ejecución de inspecciones con formulario publicado

- Antes de abrir una inspección, el cliente consulta la versión `ACTIVE` aplicable a la unidad serializada.
- Si existe un plan preventivo, su `required_template_key` tiene prioridad sobre la familia del artículo.
- El móvil muestra los ítems almacenados en PostgreSQL; no mantiene listas de inspección escritas en el navegador.
- La inspección conserva el identificador de la versión presentada al inspector.
- Al guardar, el servidor vuelve a comprobar que esa versión continúa vigente y que códigos, orden y textos coinciden.
- Si administración publicó otra versión mientras el formulario estaba abierto, el registro se rechaza y debe recargarse.
- Las inspecciones históricas siguen vinculadas a su versión inmutable para conservar evidencia y trazabilidad.
- Cada punto conserva su tipo de respuesta: cumplimiento, sí/no, número, texto, fecha o alternativa.
- Las alternativas pueden declarar explícitamente si representan conformidad, no conformidad o no aplicación; el sistema no deduce fallas a partir de textos ambiguos.
- El editor administrativo crea los puntos en filas visuales y conserva descripción, tipo, obligatoriedad, alternativas y exigencia de evidencia.
- Las familias serializadas y los planes preventivos sólo pueden seleccionar formularios publicados y vigentes; los consumibles pueden quedar sin formulario.
## Cierre formal de evidencia de inspecciones

- Una inspección se crea con evidencia `PENDING` mientras el archivo se transfiere al almacenamiento.
- Al archivar el archivo, el documento canónico y su vínculo con la inspección se registran en la misma transacción y la evidencia pasa a `VERIFIED`.
- La aprobación, el cierre y la validación de correcciones quedan bloqueados en el servicio y en PostgreSQL mientras la evidencia no esté verificada.
- Una interrupción de red no elimina las respuestas del formulario: deja una tarea visible para adjuntar o reintentar el archivo.
- Las respuestas, el resultado, la identidad del inspector y la versión del formulario permanecen inmutables; sólo cambian los campos controlados del flujo.
- La custodia del archivo tiene un SLA operativo de dos horas. Mientras esté pendiente se crea una tarea automática; al vencer, escala a prioridad crítica.
- La tarea no admite cierre manual: se resuelve dentro de la misma transacción que verifica el documento y Realtime actualiza los equipos conectados.
- Después de la aprobación o cierre, el informe PDF se reconstruye exclusivamente desde las tablas canónicas, firmas enroladas y constancias digitales del servidor.
- Cada inspección posee una sola versión final inmutable, archivada en Storage como documento canónico con SHA-256. Las descargas posteriores reutilizan exactamente el mismo archivo.
- Antes de la aprobación sólo se permite una vista preliminar; nunca se presenta como informe final ni sustituye el documento bajo custodia.
- Aprobar o verificar intenta emitir el informe final en ese mismo flujo. La aprobación no se revierte si Storage está temporalmente indisponible.
- Una falla de archivo genera una tarea crítica automática y visible en Realtime; su botón reintenta la emisión y la tarea sólo se resuelve cuando el documento existe bajo custodia.
- Las inspecciones históricas aprobadas o cerradas que aún no tengan informe final se concilian automáticamente en lotes pequeños. Sólo ingresan expedientes con evidencia verificada y sin informe canónico previo.
- La conciliación es idempotente: reutiliza el mismo control único por inspección, puede ejecutarse nuevamente sin duplicar archivos y crea una tarea crítica individual si Storage no responde.
- Administración puede iniciar una conciliación manual; cada ejecución deja auditoría con la cantidad revisada, archivada y fallida.
- Configuración presenta un tablero de custodia con expedientes elegibles, PDF archivados, pendientes, errores y las huellas de los informes recientes. Desde allí se procesa el siguiente lote sin acceder a herramientas técnicas.
- El tablero calcula el avance porcentual y permite descargar cada informe final reciente mediante la ruta canónica protegida. La entrega reutiliza el archivo inmutable y expone su huella de integridad en la respuesta.
- El registro completo se consulta con paginación del servidor y filtros por código, descripción, centro y período. Cada fila conserva fecha, responsable de generación, estado, huella SHA-256 y acceso al PDF canónico.
- Los mismos filtros pueden exportarse a CSV para auditoría. La exportación neutraliza fórmulas de planilla, limita el volumen, publica su propia huella SHA-256 y registra usuario, filtros y cantidad en la auditoría inalterable.
- La verificación específica recupera los PDF finales desde Storage o PostgreSQL y vuelve a calcular tamaño y SHA-256 contra el informe canónico. Un archivo faltante o alterado genera una tarea crítica que no puede cerrarse manualmente; una comprobación correcta posterior la resuelve automáticamente.
- Una agenda independiente repite esta comprobación cada siete días, a las 04:00 de `America/Santiago`, en lotes acotados y con bloqueo distribuido para impedir ejecuciones simultáneas desde Render. Las fallas reintentan después de cuatro horas y quedan visibles como tarea crítica y en el panel de custodia.
- El diagnóstico de preparación productiva valida esta agenda como control independiente. Una agenda ausente, vencida o fallida bloquea el estado listo; una agenda detenida o que todavía no completa su primera ejecución mantiene el ambiente con observaciones.
- Cada intento automático agrega eventos de inicio y término a una bitácora inalterable. El resultado terminal conserva duración, resumen o error; no se sobrescribe cuando ocurre una ejecución posterior y se consulta desde el panel de custodia.
- Si Render se reinicia y una ejecución queda sólo con evento de inicio, a los treinta minutos el recuperador agrega un cierre fallido inalterable, reactiva el trabajo para reintento inmediato y crea una tarea y notificación críticas. Una ejecución correcta posterior resuelve la tarea del trabajo.
- Las fallas normales tienen un plazo operativo de dos horas antes de escalar; las interrupciones recuperadas, treinta minutos. El escalamiento es atómico para evitar avisos duplicados. Cuando el trabajo vuelve a terminar correctamente, la tarea se resuelve, las alertas anteriores se marcan atendidas y se emite una notificación de recuperación.
- El panel calcula confiabilidad sobre una ventana móvil de treinta días: ejecuciones terminadas, porcentaje de éxito, duración promedio, interrupciones recuperadas e incidentes abiertos o escalados. Los indicadores se obtienen de eventos y tareas del servidor, no del navegador.
- Administración configura el objetivo de servicio de la automatización: ventana de evaluación, tasa mínima de éxito, duración promedio máxima e incidentes abiertos tolerados. El cumplimiento se muestra en Configuración y forma parte del diagnóstico productivo.
- Cada barrido evalúa la meta en el servidor. Un incumplimiento abre una tarea crítica con sus causas, notifica y registra la transición en auditoría; al recuperar la meta, resuelve la tarea, atiende las alertas previas y registra la recuperación.
- Fallas, interrupciones, escalamientos y recuperaciones se agregan además a la cola transaccional con una clave idempotente. La operación no depende de correo, WhatsApp u otra integración: esos canales consumen el evento publicado y pueden reintentar sin duplicarlo ni perderlo.
- Cada intento de entrega conserva canal, resultado, duración y error en una bitácora separada. No se guardan secretos ni el cuerpo completo del evento.
- Configuración permite supervisar las entregas recientes y distinguir un reintento exitoso de un evento descartado.
- El canal externo opcional transmite únicamente la envolvente mínima mediante HTTPS. Incluye firma HMAC, fecha e identificador idempotente para que el receptor valide y descarte repeticiones.
- Administración puede emitir un evento técnico de prueba, sin alterar inventario ni simular una falla. La creación, el procesamiento y todos sus intentos quedan auditados.
- Un objetivo de servicio supervisa cada minuto la antigüedad de pendientes, los eventos descartados y la tasa de fallos sobre una muestra mínima. Una brecha abre una sola tarea crítica y la recuperación la resuelve automáticamente.
- Administración puede modificar esos umbrales desde Configuración. El servidor valida rangos, aplica la evaluación inmediatamente y audita quién cambió la política.
- La política y la bitácora de intentos tienen RLS activo; clientes anónimos o autenticados no pueden consultarlas directamente y deben pasar por la API autorizada.
- Las brechas se asignan al administrador central. Si la tarea supera cuatro horas, se escala una sola vez; la recuperación posterior cierra todas las alertas abiertas del monitor.
- El respaldo canónico incluye políticas, eventos, intentos de entrega e historial de automatizaciones. Cada paquete declara la versión del esquema y el inventario de conjuntos incluidos, sin copiar secretos ni binarios de Storage.
