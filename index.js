require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('./prompt');

const {
  WA_PHONE_NUMBER_ID, WA_TOKEN, WA_VERIFY_TOKEN, FIRM_NOTIFY_NUMBER,
  ANTHROPIC_API_KEY, ADMIN_KEY, DASHBOARD_ORIGIN, DATABASE_URL,
} = process.env;
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: DASHBOARD_ORIGIN || '*' }));

// ---------- WhatsApp (Meta Cloud API) ----------
async function sendWhatsApp(to, body) {
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    if (!r.ok) console.error('WA error', r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error('WA fetch fail', e.message);
    return false;
  }
}

async function alertFirm(texto) {
  if (FIRM_NOTIFY_NUMBER) await sendWhatsApp(FIRM_NOTIFY_NUMBER, texto);
}

// ---------- Webhook ----------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WA_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200); // responder rápido a Meta
  handlePayload(req.body).catch((e) => console.error('handlePayload', e));
});

async function handlePayload(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg) return; // statuses, etc.

  const telefono = msg.from;
  const nombrePerfil = value.contacts?.[0]?.profile?.name || '';

  // Evitar duplicados (Meta reintenta)
  const dup = await pool.query('SELECT 1 FROM mensajes WHERE wa_id=$1', [msg.id]);
  if (dup.rowCount) return;

  if (msg.type === 'image' || msg.type === 'document') {
    await guardar(telefono, 'user', `[${msg.type} recibido]`, msg.id);
    return manejarComprobante(telefono, nombrePerfil);
  }
  if (msg.type !== 'text') {
    await guardar(telefono, 'user', `[${msg.type}]`, msg.id);
    return sendWhatsApp(telefono, 'Por este medio puedo atender mensajes de texto. ¿Me cuenta por escrito en qué le podemos ayudar?');
  }

  await guardar(telefono, 'user', msg.text.body, msg.id);
  const respuesta = await responderIA(telefono, nombrePerfil);
  await sendWhatsApp(telefono, respuesta);
  await guardar(telefono, 'assistant', respuesta, null);
}

async function guardar(telefono, rol, contenido, waId) {
  await pool.query(
    'INSERT INTO mensajes (wa_id, telefono, rol, contenido) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [waId, telefono, rol, contenido]
  );
}

// ---------- IA ----------
async function responderIA(telefono, nombrePerfil) {
  const { rows } = await pool.query(
    'SELECT rol, contenido FROM mensajes WHERE telefono=$1 ORDER BY id DESC LIMIT 20',
    [telefono]
  );
  let historial = rows.reverse().map((m) => ({ role: m.rol, content: m.contenido }));
  while (historial.length && historial[0].role !== 'user') historial.shift();

  let texto;
  try {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: buildSystemPrompt() + (nombrePerfil ? `\nNombre en el perfil de WhatsApp del cliente: ${nombrePerfil}.` : ''),
      messages: historial,
    });
    texto = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  } catch (e) {
    console.error('IA error', e.message);
    return 'Tuvimos un inconveniente técnico. Un miembro del equipo le responderá en breve. Disculpe la molestia.';
  }

  // Extraer registro de cita (marcador técnico, no markdown)
  const m = texto.match(/##CITA##\s*(\{[\s\S]*?\})/);
  if (m) {
    texto = texto.replace(/##CITA##\s*\{[\s\S]*?\}/, '').trim();
    try {
      const c = JSON.parse(m[1]);
      const ins = await pool.query(
        `INSERT INTO citas (telefono, nombre, area, fecha_hora, resumen)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [telefono, c.nombre, c.area, c.fecha_hora, c.resumen]
      );
      await alertFirm(`Nueva cita #${ins.rows[0].id} pendiente de pago\n${c.nombre} (${telefono})\nÁrea: ${c.area}\nFecha: ${c.fecha_hora}\nCaso: ${c.resumen}`);
    } catch (e) {
      console.error('Error guardando cita', e.message);
    }
  }
  return texto || 'Con gusto le ayudo. ¿Me cuenta un poco más de su caso?';
}

// ---------- Comprobantes ----------
async function manejarComprobante(telefono, nombrePerfil) {
  const { rows } = await pool.query(
    `SELECT id, nombre, fecha_hora FROM citas
     WHERE telefono=$1 AND estado='pendiente_pago' ORDER BY id DESC LIMIT 1`,
    [telefono]
  );
  if (!rows.length) {
    await sendWhatsApp(telefono, 'Recibimos su archivo. Si es un comprobante de pago, primero necesitamos agendar su asesoría. ¿Le ayudo a elegir día y hora?');
    return;
  }
  const cita = rows[0];
  await pool.query('UPDATE citas SET comprobante=TRUE WHERE id=$1', [cita.id]);
  const msg = 'Recibimos su comprobante, gracias. Nuestro equipo lo verificará y le confirmaremos su cita por este mismo medio.';
  await sendWhatsApp(telefono, msg);
  await guardar(telefono, 'assistant', msg, null);
  await alertFirm(`Comprobante recibido para cita #${cita.id}\n${cita.nombre || nombrePerfil} (${telefono})\nFecha: ${cita.fecha_hora}\nRevisar el chat y pulsar "Verificar" en el dashboard.`);
}

// ---------- API del dashboard ----------
function auth(req, res, next) {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(401);
  next();
}

app.get('/api/citas', auth, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM citas ORDER BY id DESC LIMIT 200');
  res.json(rows);
});

app.post('/api/citas/:id/verificar', auth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE citas SET estado='confirmada' WHERE id=$1 RETURNING *`, [req.params.id]
  );
  if (!rows.length) return res.sendStatus(404);
  const c = rows[0];
  const msg = `Su pago fue verificado. Su asesoría queda confirmada para ${c.fecha_hora}. Le esperamos. Si necesita reprogramar, escríbanos por aquí.`;
  await sendWhatsApp(c.telefono, msg);
  await guardar(c.telefono, 'assistant', msg, null);
  res.json(c);
});

app.post('/api/citas/:id/cancelar', auth, async (req, res) => {
  const { rows } = await pool.query(`UPDATE citas SET estado='cancelada' WHERE id=$1 RETURNING *`, [req.params.id]);
  res.json(rows[0] || null);
});

app.get('/api/mensajes/:telefono', auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT rol, contenido, creado_en FROM mensajes WHERE telefono=$1 ORDER BY id', [req.params.telefono]
  );
  res.json(rows);
});

app.get('/', (_req, res) => res.send('amado-webhook ok'));

// ---------- Arranque (crea tablas si no existen) ----------
(async () => {
  try {
    await pool.query(require('fs').readFileSync(__dirname + '/schema.sql', 'utf8'));
    console.log('DB lista');
  } catch (e) {
    console.error('Error de DB', e.message);
  }
  app.listen(PORT, () => console.log('Escuchando en', PORT));
})();
