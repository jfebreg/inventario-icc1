# Activación de Supabase Auth y Realtime

Administrador inicial:

- Nombre: Julio Febre
- Correo: jfebreg@msn.com
- Rol: Administrador central
- Centro: Bodega Central

## Variables requeridas en Render

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (sólo servidor)
- `SUPABASE_BUCKET`
- `DATABASE_URL`
- `APP_BASE_URL=https://inventario-icc1.onrender.com`
- `AUTH_BOOTSTRAP_TOKEN` con un valor aleatorio de al menos 32 caracteres

No publique `SUPABASE_SERVICE_ROLE_KEY` ni `AUTH_BOOTSTRAP_TOKEN` en GitHub.

## Configuración en Supabase

En **Authentication > URL Configuration**:

1. Site URL: `https://inventario-icc1.onrender.com`
2. Redirect URL: `https://inventario-icc1.onrender.com/?auth=invite`
3. Redirect URL: `https://inventario-icc1.onrender.com/?auth=recovery`

## Primera activación

1. Despliegue la nueva versión en Render.
2. Abra la aplicación.
3. En **Activación inicial**, ingrese el valor de `AUTH_BOOTSTRAP_TOKEN`.
4. Presione **Enviar invitación a Julio**.
5. Abra el mensaje recibido en `jfebreg@msn.com`.
6. Cree una contraseña de al menos ocho caracteres.
7. Ingrese como Julio Febre.

Después del primer ingreso confirmado, el acceso mediante PIN queda deshabilitado.

## Operación

Desde Configuración, Julio puede:

- completar correos de usuarios actuales;
- invitar nuevos usuarios;
- asignar roles y centros de costo;
- deshabilitar o reactivar accesos;
- enrolar trabajadores;
- decidir expresamente si un trabajador recibe acceso básico.

Supabase Realtime actualiza las tablas `inventory_tasks` e `inventory_notifications`. Las políticas RLS limitan los registros por usuario y centro de costo.
