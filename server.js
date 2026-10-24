import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(ROOT, 'public');
const DATA_DIR = resolve(ROOT, 'data');
const DB_PATH = resolve(DATA_DIR, 'devoluciones.sqlite');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const TIME_ZONE = 'Europe/Madrid';

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paid_total_cents INTEGER NOT NULL CHECK (paid_total_cents >= 0),
    returned_cents INTEGER NOT NULL CHECK (returned_cents >= 0),
    remaining_cents INTEGER NOT NULL,
    business_date TEXT NOT NULL,
    business_time TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS returns_business_date_idx
    ON returns (business_date, id DESC);
`);

const insertReturn = db.prepare(`
  INSERT INTO returns (
    paid_total_cents, returned_cents, remaining_cents,
    business_date, business_time, created_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`);
const getLatestDate = db.prepare('SELECT MAX(business_date) AS date FROM returns');
const getByDate = db.prepare(`
  SELECT id, paid_total_cents AS paidTotalCents,
         returned_cents AS returnedCents, remaining_cents AS remainingCents,
         business_date AS date, business_time AS time
  FROM returns
  WHERE business_date = ?
  ORDER BY id DESC
`);
const getDailyTotals = db.prepare(`
  SELECT COUNT(*) AS count, COALESCE(SUM(returned_cents), 0) AS returnedCents
  FROM returns
  WHERE business_date = ?
`);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function dateTimeInMadrid(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    time: `${value.hour}:${value.minute}`,
  };
}

function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function toCents(value, fieldName) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`Introduce ${fieldName.toLowerCase()}.`);
  }
  const normalized = String(value).trim().replace(',', '.');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) throw new Error(`${fieldName} debe ser un importe con hasta dos decimales.`);

  const euros = Number(match[1]);
  const cents = Number((match[2] || '').padEnd(2, '0'));
  const totalCents = euros * 100 + cents;
  if (!Number.isSafeInteger(totalCents)) throw new Error(`${fieldName} es demasiado grande.`);
  return totalCents;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error('La solicitud es demasiado grande.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('La solicitud no contiene datos válidos.');
  }
}

async function serveStatic(pathname, response) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(PUBLIC_DIR, `.${decodeURIComponent(requestedPath)}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${sep}`)) {
    sendJson(response, 404, { error: 'No encontrado.' });
    return;
  }

  try {
    if (!(await stat(filePath)).isFile()) throw new Error('No es un archivo.');
    const body = await readFile(filePath);
    response.writeHead(200, {
      'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'No encontrado.' });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/api/returns' && request.method === 'GET') {
    const now = new Date();
    const today = dateTimeInMadrid(now).date;
    const latestDate = getLatestDate.get().date || null;
    const requestedDate = url.searchParams.get('date');
    if (requestedDate && !isDateString(requestedDate)) {
      sendJson(response, 400, { error: 'La fecha seleccionada no es válida.' });
      return;
    }

    const date = requestedDate || latestDate || today;
    const entries = getByDate.all(date);
    const totals = getDailyTotals.get(date);
    sendJson(response, 200, {
      date,
      latestDate,
      entries,
      summary: {
        count: totals.count,
        returnedCents: totals.returnedCents,
      },
    });
    return;
  }

  if (url.pathname === '/api/returns' && request.method === 'POST') {
    try {
      const body = await readJson(request);
      const paidTotalCents = toCents(body.paidTotal, 'El importe pagado');
      const returnedCents = toCents(body.returnedAmount, 'El precio devuelto');
      const remainingCents = paidTotalCents - returnedCents;
      const timestamp = new Date();
      const { date, time } = dateTimeInMadrid(timestamp);
      const result = insertReturn.run(
        paidTotalCents,
        returnedCents,
        remainingCents,
        date,
        time,
        timestamp.toISOString(),
      );

      sendJson(response, 201, {
        entry: {
          id: Number(result.lastInsertRowid),
          paidTotalCents,
          returnedCents,
          remainingCents,
          date,
          time,
        },
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || 'No se pudo guardar la devolución.' });
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'Ruta de API no encontrada.' });
    return;
  }

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Método no permitido.' });
    return;
  }

  await serveStatic(url.pathname, response);
});

server.listen(PORT, HOST, () => {
  console.log(`Caja de devoluciones disponible en http://${HOST}:${PORT}`);
  console.log(`Base de datos: ${DB_PATH}`);
});

function closeDatabase() {
  db.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', closeDatabase);
process.on('SIGTERM', closeDatabase);
