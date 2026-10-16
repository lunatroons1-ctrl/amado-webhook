CREATE TABLE IF NOT EXISTS mensajes (
  id SERIAL PRIMARY KEY,
  wa_id TEXT UNIQUE,
  telefono TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('user','assistant')),
  contenido TEXT NOT NULL,
  creado_en TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mensajes_tel ON mensajes (telefono, id);

CREATE TABLE IF NOT EXISTS citas (
  id SERIAL PRIMARY KEY,
  telefono TEXT NOT NULL,
  nombre TEXT,
  area TEXT,
  fecha_hora TEXT,
  resumen TEXT,
  estado TEXT DEFAULT 'pendiente_pago',
  comprobante BOOLEAN DEFAULT FALSE,
  creado_en TIMESTAMPTZ DEFAULT NOW()
);
