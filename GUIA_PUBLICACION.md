# Publicar el sistema con Codex/OpenAI (guía simple)

## Antes de empezar

Necesita una cuenta de OpenAI, una cuenta de GitHub y una cuenta de Render.com. No comparta claves por correo ni las pegue dentro de `app.js`.

## 1. Crear la clave de API de OpenAI

1. Entre a [OpenAI Platform – API keys](https://platform.openai.com/api-keys) e inicie sesión.
2. Cree una clave nueva para el proyecto de inventario.
3. Cópiela y guárdela en un lugar seguro: OpenAI la muestra una sola vez.
4. La clave se usará sólo en el servidor, nunca en el navegador.

## 2. Publicar la aplicación

1. Cree un repositorio privado en GitHub llamado `inventario-icc`.
2. Suba la carpeta `inventario-web` completa.
3. En Render.com elija **New +** → **Web Service** → conecte ese repositorio.
4. Configure la variable de entorno `OPENAI_API_KEY` con la clave creada en el paso 1.
5. Configure también `APP_URL` con la dirección que Render entregue, por ejemplo `https://inventario-icc.onrender.com`.
6. Pulse **Deploy**. Render mostrará una URL pública; compártala con los usuarios.

## 3. Usar documentos con IA de Codex/OpenAI

El flujo correcto para una factura o guía es:

1. Usuario toma una foto o adjunta PDF de la factura/guía.
2. El servidor envía el documento a la capa de IA de OpenAI de forma segura.
3. La IA extrae proveedor, fecha, productos, cantidades, unidad y precio.
4. El sistema compara cada producto contra el catálogo y sus códigos.
5. Si existe coincidencia, propone el código y el usuario confirma el ingreso.
6. Si no existe coincidencia, abre el formulario manual para crear el producto o activo.
7. Se guarda el documento original como respaldo del movimiento.

## Importante

La versión actual es una demostración local. Para que el QR abra una ficha desde cualquier teléfono, para enviar correos reales y para usar la capa de IA, se requiere esta publicación con servidor y base de datos. No es seguro poner una clave de OpenAI directamente en una página web.
