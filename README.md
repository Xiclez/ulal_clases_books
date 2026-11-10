# ULAL — Clases personalizadas

Página de reservas autoadministrable.

| Parte | Archivo | Qué hace |
|---|---|---|
| Página pública | `index.html` | Dibuja maestros y clases desde el catálogo |
| Panel | `admin/index.html` | Alta, baja y edición de maestros y clases |
| Conexión | `config.js` | URL del Apps Script |
| Backend y notificador | `apps-script/Code.gs` | Guarda los datos, atiende al panel y envía los WhatsApp |

## Instalación (una sola vez)

1. **Apps Script:** abre el proyecto del notificador y reemplaza todo el código por `apps-script/Code.gs`.
2. **Propiedades del script** (Configuración del proyecto → Propiedades de la secuencia de comandos):
   - `ADMIN_PASSWORD`: la contraseña del panel. Obligatoria.
   - `ADMIN_EMAIL`: correo que recibe el aviso cuando aparece una clase nueva. Opcional.
   - `CLOUDINARY_API_KEY` y `CLOUDINARY_API_SECRET`: para subir fotos de maestros desde el panel. Están en Cloudinary → Settings → API Keys. Si la cuenta no es `dn4m0kr7j`, agrega también `CLOUDINARY_CLOUD_NAME`.
3. **Carga inicial:** ejecuta `SEED_INITIAL_DATA` una vez. Copia al almacén los maestros y clases actuales. Pedirá autorizar el envío de correo.
4. **Verifica:** ejecuta `TEST_BOOKING_PARSER` y revisa que cada reserva existente muestre su clase y maestro.
5. **Publica:** Implementar → Administrar implementaciones → editar → *Nueva versión*. Ejecutar como: *yo*. Acceso: *cualquier usuario*. Copia la URL que termina en `/exec`.
6. **Conecta el sitio:** pega esa URL en `config.js` y publica el sitio.
7. Entra a `/admin/`.

Los triggers existentes siguen sirviendo; no hay que recrearlos.

## Uso diario

- **Clase nueva:** crea la página de reserva en Google Calendar. Con la primera reserva (puede ser de prueba) la clase aparece en el panel como *Pendiente*; asígnale maestro y pega el enlace de reserva. También puedes crearla directo en el panel.
- **Maestro nuevo:** panel → Maestros → Nuevo maestro.
- **Quitar un maestro:** sus clases quedan pendientes y dejan de mostrarse hasta reasignarlas.
- **Estados de una clase:** *Publicada* se muestra; *Pendiente* no se muestra; *Oculta* no se muestra pero sí avisa al maestro (por ejemplo, la sesión informativa).

El sistema reconoce cada clase por el **título del evento** en Calendar, que es el título de la página de reserva. Si lo cambias en Calendar, actualízalo en el panel (Editar clase → «Cómo se reconoce en Google Calendar»).
