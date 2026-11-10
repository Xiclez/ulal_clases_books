# Correo al maestro con EmailJS

Cada reserva (y cada cambio de horario) le envía un correo al maestro de la clase, usando el correo que tiene en `/admin`. Sustituye a las reglas de reenvío de Gmail.

## Configuración

1. **Servicio:** en EmailJS → *Email Services* → *Add New Service*, conecta la cuenta desde la que saldrán los correos. Anota el **Service ID**.
2. **Plantilla:** *Email Templates* → *Create New Template*.
   - **Subject:** `{{aviso}}: {{class_name}} — {{date}} {{time}}`
   - **Content:** cambia al editor de código (`</>`) y pega todo `plantilla_maestro.html`.
   - **To Email:** `{{to_email}}`
   - **From Name:** `ULAL Clases`
   - **Reply To:** `{{reply_to}}`
   - Guarda y anota el **Template ID**.
3. **Llaves:** *Account* → *General*: copia la **Public Key** y la **Private Key**.
4. **Permiso:** *Account* → *Security*: activa **Allow EmailJS API for non-browser applications**. Sin esto EmailJS rechaza los envíos del Apps Script.
5. **Propiedades del script:** agrega `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY` y `EMAILJS_PRIVATE_KEY`.
6. **Prueba:** ejecuta `TEST_SEND_EMAIL`. Llega un correo de ejemplo a la dirección de `ADMIN_EMAIL`.
7. **Correos de los maestros:** captúralos en `/admin` → Maestros → Editar.

## Variables de la plantilla

| Variable | Contenido |
|---|---|
| `{{aviso}}` | «Nueva clase agendada» o «Clase reagendada» |
| `{{teacher_name}}` | Nombre del maestro |
| `{{class_name}}` | Nombre de la clase |
| `{{date}}`, `{{time}}` | Fecha (dd/mm/aaaa) y hora (24 h) |
| `{{student_name}}`, `{{student_email}}`, `{{student_phone}}` | Datos del alumno |
| `{{meet_link}}` | Enlace de Google Meet (o del evento, si no hay Meet) |
| `{{to_email}}` | Correo del maestro |
| `{{reply_to}}` | Correo del alumno |

Un maestro sin correo solo recibe WhatsApp. Si faltan las propiedades `EMAILJS_*`, no se envía ningún correo y lo demás sigue funcionando.
