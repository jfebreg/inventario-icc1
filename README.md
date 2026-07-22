# Control de Activos

Prototipo web local para control de activos y consumibles.

Abra `index.html` en un navegador para usarlo. Los datos de prueba y los cambios se almacenan localmente en el navegador.

## Publicar como Web Service en Render

Ahora la carpeta incluye un servidor Node. En Render seleccione **Web Service**, use `npm start` como *Start Command* y deje que Render asigne el puerto automáticamente. No agregue `PORT` manualmente.

Funciones incluidas:

- Familias configurables, con prefijos y códigos correlativos.
- Hoja de Vida para activos no consumibles.
- Movimientos de inventario y control de stock para consumibles.
- Usuarios por centro de costo y administración central.
- Listas editables y carga masiva de inspectores/aprobadores por centro de costo.
- Inspección móvil con registro digital obligatorio.
- Gestión de incumplimientos: aprobador define plazo, estado amarillo durante el período y bloqueo automático al vencer.
