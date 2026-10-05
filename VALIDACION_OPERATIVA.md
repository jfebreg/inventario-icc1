# Validación operativa del inventario ICC

Este documento permite registrar la aceptación de los flujos implementados. Una prueba automatizada, un despliegue correcto y una recuperación de respaldo no sustituyen la comprobación de movimientos reales en terreno.

## Evidencia disponible al iniciar esta validación

- El despliegue `c5b548c` fue observado como activo en Render.
- Los registros de ese despliegue muestran respuestas 200 en `/api/health/ready`.
- El administrador informó que la prueba de recuperación terminó correctamente.
- La última ejecución local de la suite registró 547 pruebas aprobadas.

Los escenarios siguientes quedan pendientes hasta registrar su resultado. No se declara certificación internacional ni aceptación final por la sola existencia de los módulos.

## Preparación

Julio Febre coordina la validación con un operador de cada centro. Seleccionar un activo disponible y un producto por cantidad, registrar sus saldos iniciales y usar una operación real autorizada o un entorno separado de pruebas. Las operaciones en producción forman parte del historial; conservar sus referencias y corregir errores mediante el flujo autorizado.

Registrar el commit activo, fecha, centro, usuario y dispositivo en cada escenario. Abrir la aplicación simultáneamente en PC y celular para observar la actualización entre equipos.

## Escenarios de aceptación

| Escenario | Operación | Resultado exigido | Evidencia |
| --- | --- | --- | --- |
| QR y móvil | Escanear la etiqueta del activo y abrir una acción | El producto aparece prellenado; la pantalla móvil permite operar y cerrar el menú sin bloquear el formulario | Código, dispositivo y captura |
| Entrega a terreno | Entregar el activo al trabajador autorizado | La custodia identifica al trabajador; el activo mantiene su existencia física y no permite una segunda entrega incompatible | Referencia de entrega y custodio |
| Devolución | Registrar la devolución de esa custodia | La custodia queda cerrada y el activo vuelve a estar disponible en la ubicación correspondiente | Referencia de devolución y saldo |
| Traslado | Despachar una cantidad y confirmar su recepción en destino | El saldo pasa por tránsito; la cantidad total de la empresa se conserva y la recepción no duplica unidades | Referencias de despacho y recepción; saldos de origen, tránsito y destino |
| Inspección | Completar la plantilla publicada y aprobar con otra persona autorizada | El informe presenta el texto de los ítems, resultados, fotografías y firmas disponibles sin superposición; el PDF final puede descargarse | Inspección, aprobador y PDF final |
| Rechazo y corrección | Registrar una inspección no conforme y verificar su corrección | El equipo se bloquea según sus impedimentos; la tarea se resuelve mediante el flujo de corrección y verificación | Hallazgo, tarea y verificación |
| Acceso por centro | Consultar desde un usuario de un centro distinto | El usuario sólo accede a los datos y operaciones permitidos; Julio conserva su alcance administrativo | Usuario, centro y resultado de consulta |
| Actualización entre equipos | Registrar una operación y revisar la otra sesión | Las tareas y notificaciones se actualizan mediante Realtime; los saldos operativos se actualizan conforme a su mecanismo de refresco | Hora de operación y hora de actualización |
| Conciliación | Revisar el libro mayor tras las operaciones anteriores | No existen diferencias sin explicación; los movimientos mantienen referencias auditables | Resultado de conciliación |

## Registro de resultados

| Escenario | Fecha y commit | Usuario / centro / dispositivo | Referencias | Resultado: aprobado, fallido o pendiente | Observación |
| --- | --- | --- | --- | --- | --- |
| QR y móvil | | | | Pendiente | |
| Entrega a terreno | | | | Pendiente | |
| Devolución | | | | Pendiente | |
| Traslado | | | | Pendiente | |
| Inspección | | | | Pendiente | |
| Rechazo y corrección | | | | Pendiente | |
| Acceso por centro | | | | Pendiente | |
| Actualización entre equipos | | | | Pendiente | |
| Conciliación | | | | Pendiente | |

## Cierre

### Reintentos en el formulario

En un entorno de pruebas, verificar que un artículo sin catálogo o una bodega sin ubicación produzcan un error corregible antes de enviar. Una solicitud ya enviada cuya respuesta se pierde debe conservar su clave y los mismos datos al reintentar en el mismo formulario. Si se creó un traslado y falló el despacho, el reintento debe mantener el número de traslado y la clave del despacho. No cambiar los datos de una operación incierta ni asumir que falló por no recibir respuesta: consultar su referencia y conciliar primero. Las pruebas automatizadas simulan estos fallos; no sustituyen la validación física ni verifican por sí solas el despliegue.

Aceptar el bloque operativo cuando todos los escenarios aplicables estén aprobados y las diferencias detectadas estén corregidas y repetidas satisfactoriamente. Julio registra la aceptación, la fecha y el commit. Si un escenario no aplica, anotar el motivo; no registrarlo como aprobado sin ejecutarlo.
