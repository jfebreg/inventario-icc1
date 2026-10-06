# Corrección del Security Advisor

La migración 080 corrige las tres vistas con privilegios del propietario, cierra las dos tablas internas, fija el search_path de los 25 triggers propios del informe y mueve pg_trgm a extensions. Los helpers de permisos dejan de admitir ejecución por PUBLIC/anon; authenticated conserva EXECUTE porque las políticas RLS los necesitan. Sus advertencias de SECURITY DEFINER para authenticated pueden persistir: no son una razón para retirar ese permiso sin rediseñar las políticas.

## Despliegue y comprobación

1. Conservar un respaldo V2 verificado antes del despliegue. La migración no elimina filas ni cambia saldos.
2. Publicar juntos server.js, lib/logistics.js y migrations/080_security_advisor_hardening.sql. El servidor ejecuta la migración dentro de una transacción. No aplicar únicamente el SQL: las búsquedas ahora usan extensions.similarity.
3. La conexión PostgreSQL del servidor debe ser propietaria o BYPASSRLS. No utilizar una conexión anon/authenticated para el servidor. La migración no fuerza RLS al propietario.
4. Comprobar que Render termine Live y que /api/health/ready responda correctamente, con la cadena de auditoría íntegra.
5. Probar inicio de sesión, permisos por centro, notificaciones Realtime, conciliación y revisión de productos duplicados. Verificar que una operación autorizada genere auditoría sin errores.
6. Actualizar Security Advisor y exportar nuevamente el informe. No declarar solucionadas alertas sin comprobar el resultado real.

Las pruebas locales verifican cobertura y contratos del código, no ejecutan este SQL contra PostgreSQL. Validar primero en una base de ensayo con la estructura actual cuando esté disponible.

## Ajuste fuera del código

La protección de contraseñas filtradas se activa en la configuración de Auth y requiere Pro o superior según la documentación de Supabase. Este cambio no activa la opción ni cambia el plan. Las 123 sugerencias informativas no están incluidas en el informe de advertencias revisado.
