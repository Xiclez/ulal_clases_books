/*******************************************************
 * ULAL — Clases personalizadas
 * Google Calendar → Apps Script → WhatsApp Cloud API
 *
 * Este script hace tres cosas:
 *
 * 1. ALMACÉN: guarda maestros y clases (Script Properties).
 *    Es la única fuente de verdad: la página pública, el
 *    panel /admin y el notificador leen de aquí.
 *
 * 2. API WEB (doGet / doPost):
 *    - GET  ?action=catalog  → catálogo público (sin teléfonos)
 *    - POST {action:'login'|'admin.*'|...} → panel /admin
 *    - POST sin action       → relay del webhook de Meta
 *
 * 3. NOTIFICADOR: reserva, recordatorio 1 h y 10 min por
 *    WhatsApp. El maestro sale de la clase, y la clase se
 *    identifica por el TÍTULO del evento de Calendar.
 *    Un título desconocido crea la clase como "pendiente".
 *
 * PROPIEDADES DEL SCRIPT:
 *   WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID   (obligatorias)
 *   ADMIN_PASSWORD                        (obligatoria para /admin)
 *   ADMIN_EMAIL        (opcional: aviso de clases pendientes)
 *   CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET  (para subir fotos
 *       desde /admin; CLOUDINARY_CLOUD_NAME es opcional)
 *   WA_GRAPH_VERSION, WA_TEMPLATE_LANGS, META_RELAY_SECRET (opcionales)
 *******************************************************/


/*******************************************************
 * CONFIGURACIÓN
 *******************************************************/

const CALENDAR_ID = 'disegno@ulalmexico.com';

const TEMPLATES = {
  bookingStudent: 'reserva_alumno',
  bookingTeacher: 'reserva_maestro',
  reminder1hStudent: 'recordatorio_1h_alumno',
  reminder1hTeacher: 'recordatorio_1h_maestro',
  reminder10mStudent: 'recordatorio_10m_alumno',
  reminder10mTeacher: 'recordatorio_10m_maestro'
};

const FLAGS = {
  bookingStudent: 'wa_booking_student_sent',
  bookingTeacher: 'wa_booking_teacher_sent',
  reminder1hStudent: 'wa_1h_student_sent',
  reminder1hTeacher: 'wa_1h_teacher_sent',
  reminder10mStudent: 'wa_10m_student_sent',
  reminder10mTeacher: 'wa_10m_teacher_sent',
  // Inicio del evento (epoch ms) con el que se enviaron los avisos.
  // Si cambia, la clase fue reagendada y los recordatorios se reinician.
  start: 'wa_start_ms'
};

const REMINDER_FLAGS = [
  FLAGS.reminder1hStudent,
  FLAGS.reminder1hTeacher,
  FLAGS.reminder10mStudent,
  FLAGS.reminder10mTeacher
];

const STORE = { teacher: 'T_', clase: 'C_' };
const ESTADOS = ['activa', 'pendiente', 'oculta'];
const CATALOG_CACHE_KEY = 'catalog_v1';
const SESSION_SECONDS = 21600; // 6 h


function getConfig_() {
  const props = PropertiesService.getScriptProperties();

  const config = {
    accessToken: props.getProperty('WA_ACCESS_TOKEN'),
    phoneNumberId: props.getProperty('WA_PHONE_NUMBER_ID'),
    graphVersion: props.getProperty('WA_GRAPH_VERSION') || 'v23.0',
    relaySecret: props.getProperty('META_RELAY_SECRET')
  };

  if (!config.accessToken) throw new Error('Falta WA_ACCESS_TOKEN');
  if (!config.phoneNumberId) throw new Error('Falta WA_PHONE_NUMBER_ID');

  return config;
}


/*******************************************************
 * UTILIDADES DE TEXTO / TELÉFONO
 *******************************************************/

function normalizePhone_(phone) {
  if (!phone) return '';

  let clean = String(phone).replace(/\D/g, '');

  // México: 10 dígitos → 52 + número
  if (clean.length === 10) clean = '52' + clean;

  // 521XXXXXXXXXX → 52XXXXXXXXXX
  if (clean.length === 13 && clean.startsWith('521')) {
    clean = '52' + clean.substring(3);
  }

  return clean;
}

function normalizarTexto_(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanStr_(value, max) {
  return String(value == null ? '' : value).trim().substring(0, max || 500);
}

function isHttpsUrl_(url) {
  return /^https:\/\/[^\s<>"']+$/i.test(url);
}


/*******************************************************
 * ALMACÉN (Script Properties)
 *
 * Una propiedad por registro:  T_<id> = maestro,  C_<id> = clase
 *******************************************************/

function loadAll_(prefix) {
  const all = PropertiesService.getScriptProperties().getProperties();

  return Object.keys(all)
    .filter(k => k.indexOf(prefix) === 0)
    .map(k => {
      try { return JSON.parse(all[k]); } catch (e) { return null; }
    })
    .filter(Boolean);
}

function loadCatalog_() {
  const teachers = loadAll_(STORE.teacher)
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));

  const classes = loadAll_(STORE.clase)
    .sort((a, b) =>
      (Number(a.orden) || 0) - (Number(b.orden) || 0) ||
      String(a.nombre).localeCompare(String(b.nombre))
    );

  return { teachers: teachers, classes: classes };
}

function saveRecord_(prefix, record) {
  PropertiesService.getScriptProperties()
    .setProperty(prefix + record.id, JSON.stringify(record));
  CacheService.getScriptCache().remove(CATALOG_CACHE_KEY);
}

function deleteRecord_(prefix, id) {
  PropertiesService.getScriptProperties().deleteProperty(prefix + id);
  CacheService.getScriptCache().remove(CATALOG_CACHE_KEY);
}

function newId_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 10);
}


/*******************************************************
 * VALIDACIÓN Y GUARDADO
 *******************************************************/

function saveTeacher_(input) {
  const catalog = loadCatalog_();
  const existing = input.id
    ? catalog.teachers.filter(t => t.id === input.id)[0]
    : null;

  if (input.id && !existing) throw new Error('El maestro ya no existe.');

  const teacher = {
    id: existing ? existing.id : newId_(),
    nombre: cleanStr_(input.nombre, 80),
    titulo: cleanStr_(input.titulo, 20),
    telefono: normalizePhone_(input.telefono),
    foto: cleanStr_(input.foto, 500),
    area: cleanStr_(input.area, 80),
    activo: input.activo !== false
  };

  if (!teacher.nombre) throw new Error('El nombre del maestro es obligatorio.');

  if (teacher.telefono.length < 11 || teacher.telefono.length > 13) {
    throw new Error('El teléfono debe tener 10 dígitos (o incluir el código de país).');
  }

  if (teacher.foto && !isHttpsUrl_(teacher.foto)) {
    throw new Error('La foto debe ser un enlace que empiece con https://');
  }

  saveRecord_(STORE.teacher, teacher);
  return teacher;
}

function deleteTeacher_(id) {
  const catalog = loadCatalog_();
  let afectadas = 0;

  // Las clases de ese maestro quedan sin asignar (pendientes).
  catalog.classes.forEach(c => {
    if (c.teacherId === id) {
      c.teacherId = '';
      if (c.estado === 'activa') c.estado = 'pendiente';
      saveRecord_(STORE.clase, c);
      afectadas++;
    }
  });

  deleteRecord_(STORE.teacher, id);
  return { clasesSinMaestro: afectadas };
}

function saveClass_(input) {
  const catalog = loadCatalog_();
  const existing = input.id
    ? catalog.classes.filter(c => c.id === input.id)[0]
    : null;

  if (input.id && !existing) throw new Error('La clase ya no existe.');

  const aliases = (Array.isArray(input.aliases)
    ? input.aliases
    : String(input.aliases || '').split(','))
    .map(a => cleanStr_(a, 120))
    .filter(a => a !== '')
    .slice(0, 10);

  const clase = {
    id: existing ? existing.id : newId_(),
    nombre: cleanStr_(input.nombre, 120),
    calendarTitle: cleanStr_(input.calendarTitle, 200),
    aliases: aliases,
    descripcion: cleanStr_(input.descripcion, 600),
    precio: cleanStr_(input.precio, 20),
    detalle: cleanStr_(input.detalle, 80),
    bookingUrl: cleanStr_(input.bookingUrl, 500),
    teacherId: cleanStr_(input.teacherId, 40),
    estado: ESTADOS.indexOf(input.estado) >= 0 ? input.estado : 'pendiente',
    orden: Number(input.orden) || 0,
    creada: existing ? existing.creada : new Date().toISOString(),
    origen: existing ? existing.origen : 'admin'
  };

  if (!clase.nombre) clase.nombre = clase.calendarTitle;
  if (!clase.calendarTitle) clase.calendarTitle = clase.nombre;
  if (!clase.nombre) throw new Error('El nombre de la clase es obligatorio.');

  if (clase.bookingUrl && !isHttpsUrl_(clase.bookingUrl)) {
    throw new Error('El enlace de reserva debe empezar con https://');
  }

  if (clase.teacherId &&
      !catalog.teachers.some(t => t.id === clase.teacherId)) {
    throw new Error('El maestro seleccionado ya no existe.');
  }

  // Dos clases no pueden compartir título de Calendar:
  // el notificador no sabría a qué maestro avisar.
  const titulo = normalizarTexto_(clase.calendarTitle);
  const duplicada = catalog.classes.filter(c =>
    c.id !== clase.id && normalizarTexto_(c.calendarTitle) === titulo
  )[0];

  if (duplicada) {
    throw new Error(
      'Ya existe una clase con ese título de Calendar: "' + duplicada.nombre + '".'
    );
  }

  if (clase.estado === 'activa') {
    if (!clase.teacherId) {
      throw new Error('Para publicar la clase, asígnale un maestro.');
    }
    if (!clase.bookingUrl) {
      throw new Error('Para publicar la clase, pega el enlace de reserva de Calendar.');
    }
  }

  saveRecord_(STORE.clase, clase);
  return clase;
}


/*******************************************************
 * CATÁLOGO PÚBLICO
 *
 * Solo clases activas con maestro activo. NUNCA incluye teléfonos.
 *******************************************************/

function publicTeacher_(t) {
  return {
    id: t.id,
    nombre: t.nombre,
    titulo: t.titulo || '',
    foto: t.foto || '',
    area: t.area || ''
  };
}

function buildPublicCatalog_() {
  const catalog = loadCatalog_();
  const byId = {};

  catalog.teachers.forEach(t => {
    if (t.activo !== false) byId[t.id] = t;
  });

  const classes = catalog.classes
    .filter(c => c.estado === 'activa' && c.bookingUrl && byId[c.teacherId])
    .map(c => ({
      id: c.id,
      nombre: c.nombre,
      descripcion: c.descripcion || '',
      precio: c.precio || '',
      detalle: c.detalle || '',
      bookingUrl: c.bookingUrl,
      teacher: publicTeacher_(byId[c.teacherId])
    }));

  const visibles = {};
  classes.forEach(c => { visibles[c.teacher.id] = true; });

  const teachers = catalog.teachers
    .filter(t => visibles[t.id])
    .map(publicTeacher_);

  return { ok: true, teachers: teachers, classes: classes };
}

function getPublicCatalogJson_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CATALOG_CACHE_KEY);

  if (cached) return cached;

  const json = JSON.stringify(buildPublicCatalog_());

  try { cache.put(CATALOG_CACHE_KEY, json, 300); } catch (e) { /* demasiado grande */ }

  return json;
}


/*******************************************************
 * IDENTIFICAR CLASE Y MAESTRO DE UN EVENTO
 *
 * Solo se usa el TÍTULO del evento. Las reservas de Calendar
 * se titulan "Título de la página de reserva (Nombre del alumno)".
 *******************************************************/

function baseTitle_(summary) {
  // Quita el "(Nombre del alumno)" final.
  return String(summary || '').replace(/\s*\([^()]*\)\s*$/, '').trim();
}

function findClassForTitle_(summary, classes) {
  const titulo = normalizarTexto_(baseTitle_(summary));
  let best = null;
  let bestLen = 0;

  if (!titulo) return null;

  classes.forEach(c => {
    [c.calendarTitle].concat(c.aliases || []).forEach(identificador => {
      const palabra = normalizarTexto_(identificador);

      // Gana la coincidencia más larga (la más específica).
      if (palabra && titulo.indexOf(palabra) >= 0 && palabra.length > bestLen) {
        best = c;
        bestLen = palabra.length;
      }
    });
  });

  return best;
}

/**
 * Devuelve { clase, teacher }. teacher es null si la clase no tiene
 * maestro activo. Con autoCreate, un título desconocido se registra
 * como clase pendiente para asignarla desde /admin.
 */
function resolveEvent_(event, catalog, autoCreate) {
  let clase = findClassForTitle_(event.summary, catalog.classes);

  if (!clase && autoCreate) {
    clase = registerPendingClass_(event, catalog);
  }

  let teacher = null;

  if (clase && clase.teacherId) {
    teacher = catalog.teachers.filter(t =>
      t.id === clase.teacherId && t.activo !== false && t.telefono
    )[0] || null;
  }

  return { clase: clase, teacher: teacher };
}

function registerPendingClass_(event, catalog) {
  const titulo = baseTitle_(event.summary);

  if (!titulo) return null;

  const clase = {
    id: newId_(),
    nombre: titulo,
    calendarTitle: titulo,
    aliases: [],
    descripcion: '',
    precio: '',
    detalle: '',
    bookingUrl: '',
    teacherId: '',
    estado: 'pendiente',
    orden: 0,
    creada: new Date().toISOString(),
    origen: 'calendar'
  };

  saveRecord_(STORE.clase, clase);
  catalog.classes.push(clase);

  console.log(`🆕 Clase nueva detectada en Calendar: "${titulo}" (pendiente)`);

  notifyAdminPendingClass_(clase);

  return clase;
}

function notifyAdminPendingClass_(clase) {
  const email =
    PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');

  if (!email) return;

  try {
    MailApp.sendEmail(
      email,
      'ULAL: clase nueva sin maestro — ' + clase.nombre,
      'Se recibió una reserva de una clase que no estaba registrada:\n\n' +
      '    ' + clase.nombre + '\n\n' +
      'Se agregó al panel como PENDIENTE. Entra a /admin para asignarle ' +
      'maestro y pegar su enlace de reserva.\n\n' +
      'Mientras siga pendiente, el alumno recibe sus avisos pero ningún ' +
      'maestro es notificado.'
    );
  } catch (error) {
    console.error('❌ No se pudo enviar el correo al administrador:', error);
  }
}


/*******************************************************
 * EXTRAER DATOS DEL ALUMNO
 *******************************************************/

function parseStudentFromDescription_(description) {
  if (!description) return null;

  const lines = description
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(x => x !== '');

  let name = '';
  let email = '';
  let phone = '';

  const programmedIndex = lines.findIndex(
    x => x.toLowerCase() === 'programada por'
  );

  if (programmedIndex >= 0) {
    name = lines[programmedIndex + 1] || '';
    email = lines[programmedIndex + 2] || '';
    phone = lines[programmedIndex + 3] || '';
  } else {
    // FALLBACK
    for (let i = 0; i < lines.length; i++) {
      if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lines[i])) {
        email = lines[i];
      }

      if (!phone) {
        const possiblePhone = lines[i].replace(/\D/g, '');

        if (possiblePhone.length >= 10 && possiblePhone.length <= 13) {
          phone = possiblePhone;
        }
      }
    }

    if (!name && email) {
      const emailIndex = lines.indexOf(email);
      if (emailIndex > 0) name = lines[emailIndex - 1];
    }
  }

  return {
    nombre: name,
    email: email,
    telefono: normalizePhone_(phone)
  };
}


/*******************************************************
 * GOOGLE MEET / FECHA / HORA
 *******************************************************/

function getMeetLink_(event) {
  if (event.hangoutLink) return event.hangoutLink;

  if (event.conferenceData && event.conferenceData.entryPoints) {
    for (const entry of event.conferenceData.entryPoints) {
      if (entry.entryPointType === 'video' && entry.uri) return entry.uri;
    }
  }

  return '';
}

function formatDate_(dateTime) {
  return Utilities.formatDate(
    new Date(dateTime), Session.getScriptTimeZone(), 'dd/MM/yyyy'
  );
}

function formatTime_(dateTime) {
  return Utilities.formatDate(
    new Date(dateTime), Session.getScriptTimeZone(), 'HH:mm'
  );
}


/*******************************************************
 * IDIOMA DE PLANTILLA
 *
 * Por defecto: reserva_alumno → es_MX, las demás → en
 * (así están aprobadas hoy en Meta).
 *
 * Para cambiarlo sin tocar código, crea la propiedad
 * WA_TEMPLATE_LANGS con un JSON, por ejemplo:
 *   {"recordatorio_1h_alumno":"es_MX"}
 *******************************************************/

function getTemplateLanguage_(templateName) {
  const raw =
    PropertiesService.getScriptProperties().getProperty('WA_TEMPLATE_LANGS');

  if (raw) {
    try {
      const overrides = JSON.parse(raw);
      if (overrides && overrides[templateName]) return overrides[templateName];
    } catch (e) {
      console.error('WA_TEMPLATE_LANGS no es un JSON válido.');
    }
  }

  return templateName === TEMPLATES.bookingStudent ? 'es_MX' : 'en';
}


/*******************************************************
 * ENVIAR TEMPLATE WHATSAPP
 *******************************************************/

function sendWhatsAppTemplate_(phone, templateName, parameters) {
  if (!phone) {
    throw new Error(`No hay teléfono para template ${templateName}`);
  }

  const config = getConfig_();

  const url =
    `https://graph.facebook.com/${config.graphVersion}` +
    `/${config.phoneNumberId}/messages`;

  const components = [];

  if (parameters && parameters.length > 0) {
    components.push({
      type: 'body',
      parameters: parameters.map(value => ({
        type: 'text',
        text: String(value ?? '')
      }))
    });
  }

  const templateLanguage = getTemplateLanguage_(templateName);

  console.log(
    `📨 Template: ${templateName} | Idioma: ${templateLanguage} | Destino: ${phone}`
  );

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLanguage },
      components: components
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${config.accessToken}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = response.getContentText();

  console.log(`WhatsApp ${templateName} → ${phone} → ${status}`);
  console.log(body);

  if (status < 200 || status >= 300) {
    throw new Error(`Meta WhatsApp error ${status}: ${body}`);
  }

  return JSON.parse(body);
}

function sendToStudent_(template, student, date, time, meet) {
  return sendWhatsAppTemplate_(
    student.telefono, template, [student.nombre, date, time, meet]
  );
}

function sendToTeacher_(template, teacher, student, date, time, meet) {
  return sendWhatsAppTemplate_(
    teacher.telefono, template,
    [teacher.nombre, student.nombre, date, time, meet]
  );
}


/*******************************************************
 * FLAGS PRIVADOS DEL EVENTO
 *******************************************************/

function getPrivateProps_(event) {
  if (event.extendedProperties && event.extendedProperties.private) {
    return { ...event.extendedProperties.private };
  }

  return {};
}

/**
 * Lee el evento más reciente, conserva los flags existentes
 * y agrega los nuevos.
 */
function updateEventFlags_(eventId, updates) {
  const latestEvent = Calendar.Events.get(CALENDAR_ID, eventId);
  const privateProps = getPrivateProps_(latestEvent);

  Object.keys(updates).forEach(flagName => {
    privateProps[flagName] = String(updates[flagName]);
  });

  Calendar.Events.patch(
    { extendedProperties: { private: privateProps } },
    CALENDAR_ID,
    eventId
  );

  return privateProps;
}

/**
 * Envía un aviso una sola vez: si el flag ya está en 'true' no hace
 * nada; si el envío funciona, marca el flag. Los errores se registran
 * sin detener el resto de los avisos.
 */
function sendOnce_(event, privateProps, flag, etiqueta, enviar) {
  if (privateProps[flag] === 'true') return;

  try {
    enviar();
    updateEventFlags_(event.id, { [flag]: 'true' });
    privateProps[flag] = 'true';
    console.log(`✅ ${etiqueta}`);
  } catch (error) {
    console.error(`❌ Error ${etiqueta} ${event.id}:`, error);
  }
}


/*******************************************************
 * TRIGGER DE CALENDAR: eventos nuevos / modificados
 *******************************************************/

function processRecentChangesAndNotify() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    // El trigger de cada minuto vuelve a revisar los cambios,
    // así que esta reserva no se pierde.
    console.log('⏳ Otra ejecución ya está procesando Calendar.');
    return;
  }

  try {
    syncRecentChanges_(loadCatalog_());
  } finally {
    lock.releaseLock();
  }
}

function syncRecentChanges_(catalog) {
  const props = PropertiesService.getScriptProperties();

  const lastRun =
    props.getProperty('LAST_CALENDAR_SYNC') ||
    new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const now = new Date().toISOString();

  let pageToken;

  do {
    const response = Calendar.Events.list(CALENDAR_ID, {
      updatedMin: lastRun,
      showDeleted: false,
      singleEvents: false,
      conferenceDataVersion: 1,
      maxResults: 100,
      pageToken: pageToken
    });

    for (const event of response.items || []) {
      try {
        processBookingEvent_(event, catalog);
      } catch (error) {
        console.error(`❌ Error procesando ${event.id}:`, error);
      }
    }

    pageToken = response.nextPageToken;

  } while (pageToken);

  props.setProperty('LAST_CALENDAR_SYNC', now);
}


/*******************************************************
 * PROCESAR UNA RESERVA
 *******************************************************/

function processBookingEvent_(event, catalog) {
  if (event.status === 'cancelled') return;
  if (!event.start || !event.start.dateTime) return;

  const startMs = new Date(event.start.dateTime).getTime();

  // Un evento pasado que alguien editó no debe generar avisos.
  if (startMs < Date.now()) return;

  const student = parseStudentFromDescription_(event.description || '');

  if (!student || !student.telefono) {
    // No es una reserva (o no trae teléfono): se ignora.
    return;
  }

  const resolved = resolveEvent_(event, catalog, true);
  const teacher = resolved.teacher;

  if (teacher) {
    console.log(`👨‍🏫 Maestro asignado: ${teacher.nombre}`);
  } else {
    console.log(`⚠️ Sin maestro para: ${event.summary}`);
  }

  const meet = getMeetLink_(event);
  const date = formatDate_(event.start.dateTime);
  const time = formatTime_(event.start.dateTime);

  const privateProps = getPrivateProps_(event);

  // REAGENDADO: si cambió la hora, los recordatorios vuelven a enviarse.
  if (privateProps[FLAGS.start] !== String(startMs)) {
    const updates = { [FLAGS.start]: String(startMs) };

    if (privateProps[FLAGS.start]) {
      REMINDER_FLAGS.forEach(flag => { updates[flag] = 'false'; });
      console.log(`🔁 Clase reagendada: ${event.summary} → ${date} ${time}`);
    }

    Object.assign(privateProps, updateEventFlags_(event.id, updates));
  }

  sendOnce_(
    event, privateProps, FLAGS.bookingStudent,
    `Reserva enviada al alumno: ${student.nombre}`,
    () => sendToStudent_(TEMPLATES.bookingStudent, student, date, time, meet)
  );

  if (teacher) {
    sendOnce_(
      event, privateProps, FLAGS.bookingTeacher,
      `Reserva enviada al maestro: ${teacher.nombre}`,
      () => sendToTeacher_(
        TEMPLATES.bookingTeacher, teacher, student, date, time, meet
      )
    );
  }
}


/*******************************************************
 * TRIGGER DE CADA MINUTO: recordatorios
 *
 * También repasa los cambios recientes de Calendar, por si el
 * trigger de Calendar no pudo tomar el candado. Así, cuando en
 * /admin se asigna maestro a una clase pendiente, el maestro
 * recibe los avisos de las reservas que ya existían.
 *******************************************************/

function sendScheduledReminders() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    console.log('⏳ Otra ejecución ya está enviando recordatorios.');
    return;
  }

  try {
    const catalog = loadCatalog_();

    try {
      syncRecentChanges_(catalog);
      resyncUpcomingIfRequested_(catalog);
    } catch (error) {
      console.error('❌ Error repasando cambios de Calendar:', error);
    }

    const ahora = new Date();
    const unaHoraDespues = new Date(ahora.getTime() + 60 * 60 * 1000);

    const eventos = Calendar.Events.list(CALENDAR_ID, {
      timeMin: ahora.toISOString(),
      timeMax: unaHoraDespues.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      showDeleted: false,
      maxResults: 100,
      conferenceDataVersion: 1
    });

    for (const event of eventos.items || []) {
      try {
        processReminder_(event, catalog, ahora);
      } catch (error) {
        console.error(`❌ Error en recordatorio ${event.id}:`, error);
      }
    }

  } finally {
    lock.releaseLock();
  }
}

function processReminder_(event, catalog, ahora) {
  if (event.status === 'cancelled') return;
  if (!event.start || !event.start.dateTime) return;

  const inicio = new Date(event.start.dateTime);
  const minutos = (inicio.getTime() - ahora.getTime()) / 60000;

  if (minutos <= 0 || minutos > 60) return;

  const es10m = minutos <= 10;
  const es1h = minutos > 50;

  if (!es10m && !es1h) return;

  const alumno = parseStudentFromDescription_(event.description || '');

  if (!alumno || !alumno.telefono) return;

  // El alumno recibe su recordatorio aunque la clase no tenga maestro.
  const maestro = resolveEvent_(event, catalog, false).teacher;

  if (!maestro) {
    console.log(`⚠️ Recordatorio sin maestro: ${event.summary}`);
  }

  const meet = getMeetLink_(event);
  const fecha = formatDate_(event.start.dateTime);
  const hora = formatTime_(event.start.dateTime);
  const privateProps = getPrivateProps_(event);

  const tipo = es10m ? '10m' : '1h';
  const tplAlumno = es10m ? TEMPLATES.reminder10mStudent : TEMPLATES.reminder1hStudent;
  const tplMaestro = es10m ? TEMPLATES.reminder10mTeacher : TEMPLATES.reminder1hTeacher;
  const flagAlumno = es10m ? FLAGS.reminder10mStudent : FLAGS.reminder1hStudent;
  const flagMaestro = es10m ? FLAGS.reminder10mTeacher : FLAGS.reminder1hTeacher;

  sendOnce_(
    event, privateProps, flagAlumno,
    `Recordatorio ${tipo} alumno: ${alumno.nombre}`,
    () => sendToStudent_(tplAlumno, alumno, fecha, hora, meet)
  );

  if (maestro) {
    sendOnce_(
      event, privateProps, flagMaestro,
      `Recordatorio ${tipo} maestro: ${maestro.nombre}`,
      () => sendToTeacher_(tplMaestro, maestro, alumno, fecha, hora, meet)
    );
  }
}


/*******************************************************
 * API WEB — GET
 *
 *   ?action=catalog → catálogo público para la página
 *******************************************************/

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;

  if (action === 'catalog') {
    return ContentService
      .createTextOutput(getPublicCatalogJson_())
      .setMimeType(ContentService.MimeType.JSON);
  }

  return jsonResponse_({ ok: true, service: 'ULAL Calendar WhatsApp' });
}


/*******************************************************
 * API WEB — POST
 *
 *   Con "action" en el cuerpo → panel /admin
 *   Sin "action"              → relay del webhook de Meta
 *******************************************************/

function doPost(e) {
  try {
    if (!e || !e.postData) {
      return jsonResponse_({ ok: false, error: 'No POST data' });
    }

    let body = {};

    try {
      body = e.postData.contents ? JSON.parse(e.postData.contents) : {};
    } catch (error) {
      return jsonResponse_({ ok: false, error: 'JSON inválido' });
    }

    if (body && typeof body.action === 'string') {
      return jsonResponse_(handleAdminRequest_(body));
    }

    // ---- Relay del webhook de Meta (Vercel → Apps Script) ----

    const relaySecret =
      PropertiesService.getScriptProperties().getProperty('META_RELAY_SECRET');

    const incomingSecret =
      e.parameter && e.parameter.secret ? e.parameter.secret : '';

    if (relaySecret && incomingSecret !== relaySecret) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' });
    }

    console.log(JSON.stringify(body));

    return jsonResponse_({ ok: true });

  } catch (error) {
    console.error(error);
    return jsonResponse_({ ok: false, error: String(error) });
  }
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


/*******************************************************
 * PANEL /admin
 *******************************************************/

function handleAdminRequest_(body) {
  try {
    if (body.action === 'login') {
      return { ok: true, token: adminLogin_(String(body.password || '')) };
    }

    if (!isValidSession_(body.token)) {
      return { ok: false, code: 'auth', error: 'Sesión vencida. Vuelve a entrar.' };
    }

    if (body.action === 'logout') {
      CacheService.getScriptCache().remove('adm_tok_' + body.token);
      return { ok: true };
    }

    if (body.action === 'admin.list') {
      return { ok: true, data: loadCatalog_() };
    }

    if (body.action === 'upload.sign') {
      return { ok: true, upload: signCloudinaryUpload_() };
    }

    // Las escrituras van una a la vez.
    const lock = LockService.getScriptLock();

    if (!lock.tryLock(20000)) {
      return { ok: false, error: 'El sistema está ocupado. Intenta de nuevo.' };
    }

    try {
      let result;

      switch (body.action) {
        case 'teacher.save':
          result = saveTeacher_(body.teacher || {});
          break;
        case 'teacher.delete':
          result = deleteTeacher_(String(body.id || ''));
          break;
        case 'class.save':
          result = saveClass_(body.clase || {});
          touchSync_();
          break;
        case 'class.delete':
          deleteRecord_(STORE.clase, String(body.id || ''));
          result = {};
          break;
        default:
          return { ok: false, error: 'Acción desconocida' };
      }

      return { ok: true, result: result, data: loadCatalog_() };

    } finally {
      lock.releaseLock();
    }

  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function adminLogin_(password) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('adm_fails') || 0);

  if (fails >= 5) {
    throw new Error('Demasiados intentos fallidos. Espera 15 minutos.');
  }

  const real =
    PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');

  if (!real) {
    throw new Error('Falta configurar ADMIN_PASSWORD en las propiedades del script.');
  }

  if (password !== real) {
    cache.put('adm_fails', String(fails + 1), 900);
    throw new Error('Contraseña incorrecta.');
  }

  cache.remove('adm_fails');

  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  cache.put('adm_tok_' + token, '1', SESSION_SECONDS);

  return token;
}

function isValidSession_(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return false;
  return CacheService.getScriptCache().get('adm_tok_' + token) === '1';
}

/**
 * FOTOS DE MAESTROS (Cloudinary)
 *
 * El panel sube la imagen directo a Cloudinary. Aquí solo se firma
 * la subida, para que el API secret nunca salga del script.
 * La foto se guarda recortada en cuadro (400×400) centrada en el rostro.
 */
const CLOUDINARY_DEFAULT_CLOUD = 'dn4m0kr7j';
const CLOUDINARY_FOLDER = 'ulal/maestros';
const CLOUDINARY_TRANSFORMATION = 'c_fill,g_face,w_400,h_400';

function signCloudinaryUpload_() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('CLOUDINARY_API_KEY');
  const apiSecret = props.getProperty('CLOUDINARY_API_SECRET');

  if (!apiKey || !apiSecret) {
    throw new Error(
      'Para subir fotos falta configurar CLOUDINARY_API_KEY y ' +
      'CLOUDINARY_API_SECRET en las propiedades del script.'
    );
  }

  const params = {
    folder: CLOUDINARY_FOLDER,
    timestamp: String(Math.floor(Date.now() / 1000)),
    transformation: CLOUDINARY_TRANSFORMATION
  };

  // Firma de Cloudinary: parámetros en orden alfabético + API secret, SHA-1.
  const toSign = Object.keys(params).sort()
    .map(k => k + '=' + params[k])
    .join('&') + apiSecret;

  const signature = Utilities
    .computeDigest(Utilities.DigestAlgorithm.SHA_1, toSign, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xFF).toString(16)).slice(-2))
    .join('');

  return {
    url: 'https://api.cloudinary.com/v1_1/' +
      (props.getProperty('CLOUDINARY_CLOUD_NAME') || CLOUDINARY_DEFAULT_CLOUD) +
      '/image/upload',
    fields: Object.assign({ api_key: apiKey, signature: signature }, params)
  };
}

/**
 * Al guardar una clase se pide un repaso de las reservas futuras:
 * si la clase acaba de recibir maestro, este recibe el aviso de las
 * reservas que ya existían. Lo ejecuta el trigger de cada minuto.
 */
function touchSync_() {
  PropertiesService.getScriptProperties().setProperty('RESYNC_UPCOMING', '1');
}

function resyncUpcomingIfRequested_(catalog) {
  const props = PropertiesService.getScriptProperties();

  if (props.getProperty('RESYNC_UPCOMING') !== '1') return;

  props.deleteProperty('RESYNC_UPCOMING');

  const now = new Date();
  let pageToken;

  do {
    const response = Calendar.Events.list(CALENDAR_ID, {
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      singleEvents: true,
      showDeleted: false,
      conferenceDataVersion: 1,
      maxResults: 250,
      pageToken: pageToken
    });

    for (const event of response.items || []) {
      try {
        processBookingEvent_(event, catalog);
      } catch (error) {
        console.error(`❌ Error repasando ${event.id}:`, error);
      }
    }

    pageToken = response.nextPageToken;

  } while (pageToken);
}


/*******************************************************
 * CARGA INICIAL
 *
 * Ejecutar MANUALMENTE una sola vez: copia al almacén los
 * maestros y clases que antes estaban escritos en el código
 * y en la página. No sobrescribe si ya hay datos.
 *******************************************************/

function SEED_INITIAL_DATA() {
  const catalog = loadCatalog_();

  if (catalog.teachers.length || catalog.classes.length) {
    console.log('⚠️ Ya hay datos guardados. No se cargó nada.');
    return;
  }

  const img = 'https://res.cloudinary.com/dn4m0kr7j/image/upload/';

  const teachers = [
    { id: 'arturo', titulo: 'Ing.', nombre: 'Arturo Márquez', telefono: '526143132764', area: 'Preparatoria', foto: img + 'v1789439707/profe-arturo-1_s3crm5.png' },
    { id: 'daniela', titulo: 'Ing.', nombre: 'Daniela Dominguez', telefono: '526142776161', area: 'Preparatoria', foto: img + 'v1789439642/mtra-daniela-1_s110z1.png' },
    { id: 'mario', titulo: 'Ing.', nombre: 'Mario Caro', telefono: '526141529647', area: 'Ing. Industrial', foto: img + 'v1789439923/mario-caro-1_dobtoh.png' },
    { id: 'daniel', titulo: 'Lic.', nombre: 'Daniel Santiesteban', telefono: '526143382541', area: 'Administración', foto: img + 'v1789439801/daniel-santiesteban_vukbut.png' },
    { id: 'gabriela', titulo: 'Lic.', nombre: 'Gabriela Bravo', telefono: '526391609730', area: 'Mercadotecnia y Pedagogía', foto: img + 'v1789439866/mtra-gabriela-bravo_rxkau9.png' },
    { id: 'luiscarlos', titulo: '', nombre: 'Luis Carlos Barrallasco', telefono: '526144272399', area: '', foto: '' }
  ];

  const cal = 'https://calendar.app.google/';
  const detalle = '1 hrs | Videoconferencia';

  const classes = [
    { nombre: 'Licenciatura en Administración', teacherId: 'daniel', bookingUrl: cal + 'JQEddrM9iXfBcbkP7', descripcion: 'Resuelve todas tus dudas y profundiza en los temas que realmente te interesan. Aprende a tu ritmo.' },
    { nombre: 'Licenciatura en Mercadotecnia', teacherId: 'gabriela', bookingUrl: cal + 'M9RNkZtEPVEB2TtcA', descripcion: 'Impulsa tu carrera con clases enfocadas en estrategias de mercado, branding y comunicación digital.' },
    { nombre: '[PREPARATORIA] Matemáticas y Ciencias Experimentales', aliases: ['matemáticas', 'ciencias experimentales'], teacherId: 'arturo', bookingUrl: cal + 'PA3sxNjewTHhViAf6', descripcion: 'Refuerza tus bases en cálculo, álgebra y física con la ayuda de un experto. Prepárate para tus exámenes.' },
    { nombre: 'Licenciatura en Pedagogía', teacherId: 'gabriela', bookingUrl: cal + 'EKR5Qts426Rhum7J7', descripcion: 'Explora modelos educativos, psicología del aprendizaje y técnicas de enseñanza efectivas.' },
    { nombre: 'Ingeniería Industrial', teacherId: 'mario', bookingUrl: cal + 't7jGwNwoXRASi3GE8', descripcion: 'Aprende a optimizar procesos y sistemas. Mejora la eficiencia, calidad y logística para maximizar la productividad en cualquier industria.' },
    { nombre: '[PREPARATORIA] Español y Ciencias Sociales', aliases: ['español', 'ciencias sociales'], teacherId: 'daniela', bookingUrl: cal + '4WCrX8Awj2vGSqVz6', descripcion: 'Mejora tu redacción, análisis y pensamiento crítico. Explora la historia, la sociedad y la literatura para entender mejor el mundo actual.' },
    // No se muestra en la página; solo sirve para avisar al maestro.
    { nombre: 'Sesión informativa', teacherId: 'luiscarlos', estado: 'oculta', precio: '', detalle: '' }
  ];

  teachers.forEach(t => {
    t.activo = true;
    saveRecord_(STORE.teacher, t);
  });

  classes.forEach((c, i) => {
    saveRecord_(STORE.clase, {
      id: 'c' + (i + 1),
      nombre: c.nombre,
      calendarTitle: c.nombre,
      aliases: c.aliases || [],
      descripcion: c.descripcion || '',
      precio: c.precio === undefined ? '299' : c.precio,
      detalle: c.detalle === undefined ? detalle : c.detalle,
      bookingUrl: c.bookingUrl || '',
      teacherId: c.teacherId,
      estado: c.estado || 'activa',
      orden: (i + 1) * 10,
      creada: new Date().toISOString(),
      origen: 'seed'
    });
  });

  console.log(`✅ Cargados ${teachers.length} maestros y ${classes.length} clases.`);
}


/*******************************************************
 * CREAR TRIGGERS
 *
 * Elimina TODOS los triggers del proyecto y crea los 2 necesarios.
 * Ejecutar MANUALMENTE una vez.
 *******************************************************/

function createProductionTriggers() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    ScriptApp.deleteTrigger(trigger);
  }

  ScriptApp.newTrigger('processRecentChangesAndNotify')
    .forUserCalendar(CALENDAR_ID)
    .onEventUpdated()
    .create();

  ScriptApp.newTrigger('sendScheduledReminders')
    .timeBased()
    .everyMinutes(1)
    .create();

  console.log('✅ Triggers de producción creados.');
}


/*******************************************************
 * TESTS (ninguno envía WhatsApp salvo TEST_SEND_WHATSAPP)
 *******************************************************/

function TEST_CONFIGURATION() {
  const props = PropertiesService.getScriptProperties();
  const catalog = loadCatalog_();

  const result = {
    hasAccessToken: !!props.getProperty('WA_ACCESS_TOKEN'),
    hasPhoneNumberId: !!props.getProperty('WA_PHONE_NUMBER_ID'),
    hasAdminPassword: !!props.getProperty('ADMIN_PASSWORD'),
    hasCloudinaryKeys:
      !!props.getProperty('CLOUDINARY_API_KEY') &&
      !!props.getProperty('CLOUDINARY_API_SECRET'),
    adminEmail: props.getProperty('ADMIN_EMAIL') || '(sin configurar)',
    graphVersion: props.getProperty('WA_GRAPH_VERSION') || 'v23.0',
    hasRelaySecret: !!props.getProperty('META_RELAY_SECRET'),
    maestros: catalog.teachers.length,
    clases: catalog.classes.length,
    clasesPendientes: catalog.classes.filter(c => c.estado === 'pendiente').length
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** Muestra el catálogo público tal como lo recibe la página. */
function TEST_CATALOG() {
  console.log(JSON.stringify(buildPublicCatalog_(), null, 2));
}

/**
 * Para los eventos de ayer a 7 días: qué alumno, clase y maestro
 * identifica el script. NO crea clases pendientes.
 */
function TEST_BOOKING_PARSER() {
  const now = new Date();
  const catalog = loadCatalog_();

  const response = Calendar.Events.list(CALENDAR_ID, {
    timeMin: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: true,
    conferenceDataVersion: 1,
    maxResults: 20
  });

  for (const event of response.items || []) {
    const resolved = resolveEvent_(event, catalog, false);

    console.log(JSON.stringify({
      id: event.id,
      title: event.summary,
      start: event.start && event.start.dateTime,
      student: parseStudentFromDescription_(event.description || ''),
      clase: resolved.clase ? resolved.clase.nombre : '(se crearía como pendiente)',
      teacher: resolved.teacher ? resolved.teacher.nombre : null,
      meet: getMeetLink_(event),
      flags: getPrivateProps_(event)
    }, null, 2));
  }
}

/** Envía UNA plantilla al número indicado. */
function TEST_SEND_WHATSAPP() {
  const phone = '523330547185';

  const result = sendWhatsAppTemplate_(
    phone,
    TEMPLATES.bookingStudent,
    ['Prueba', '07/09/2026', '19:00', 'https://meet.google.com/xxxxx']
  );

  console.log(JSON.stringify(result, null, 2));
}
