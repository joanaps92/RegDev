import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync } from 'node:zlib';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(ROOT, 'public');
const DATA_DIR = resolve(process.env.DATA_DIR || resolve(ROOT, 'data'));
const DB_PATH = resolve(DATA_DIR, 'devoluciones.sqlite');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH || '');
const BASE_HREF = BASE_PATH ? `${BASE_PATH}/` : '/';
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
const getByMonth = db.prepare(`
  SELECT id, paid_total_cents AS paidTotalCents,
         returned_cents AS returnedCents, remaining_cents AS remainingCents,
         business_date AS date, business_time AS time
  FROM returns
  WHERE business_date >= ? AND business_date <= ?
  ORDER BY business_date ASC, business_time ASC, id ASC
`);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function normalizeBasePath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';

  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  if (segments.some((segment) => !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === '.' || segment === '..')) {
    throw new Error('BASE_PATH debe ser una ruta válida, por ejemplo /CuentaClara.');
  }
  return `/${segments.join('/')}`;
}

function stripBasePath(pathname) {
  if (!BASE_PATH) return pathname;
  if (pathname === BASE_PATH) return '/';
  if (pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length) || '/';
  // Coolify strips the configured prefix by default. Accept those requests too.
  return pathname;
}

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

function isMonthString(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const date = new Date(`${value}-01T00:00:00Z`);
  return year > 0 && !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 7) === value;
}

function monthDateRange(value) {
  const firstDay = `${value}-01`;
  const lastDay = new Date(`${firstDay}T00:00:00Z`);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
  lastDay.setUTCDate(0);
  return [firstDay, lastDay.toISOString().slice(0, 10)];
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function textCell(reference, value, style = '') {
  const styleAttribute = style ? ` s="${style}"` : '';
  return `<c r="${reference}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function numberCell(reference, value, style = '') {
  const styleAttribute = style ? ` s="${style}"` : '';
  return `<c r="${reference}"${styleAttribute}><v>${Number(value)}</v></c>`;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let checksum = 0xffffffff;
  for (const byte of buffer) checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function zipFiles(files) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const zipDate = 33; // 1 January 1980, the start of the ZIP timestamp range.

  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(zipDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(filename.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, filename, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(zipDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(filename.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, filename);
    localOffset += localHeader.length + filename.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(centralParts.length / 2, 8);
  endRecord.writeUInt16LE(centralParts.length / 2, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function buildMonthlyWorkbook(month, entries) {
  const monthDate = new Date(`${month}-15T12:00:00Z`);
  const monthLabel = new Intl.DateTimeFormat('es-ES', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(monthDate);
  const returnedTotalCents = entries.reduce((total, entry) => total + entry.returnedCents, 0);
  const headerCells = ['Fecha', 'Hora', 'Total pagado (€)', 'Artículo devuelto (€)', 'Importe restante (€)']
    .map((value, index) => textCell(`${String.fromCharCode(65 + index)}4`, value, '2'))
    .join('');
  const dataRows = entries.map((entry, index) => {
    const rowNumber = index + 5;
    const [year, monthNumber, day] = entry.date.split('-');
    return `<row r="${rowNumber}">${[
      textCell(`A${rowNumber}`, `${day}/${monthNumber}/${year}`),
      textCell(`B${rowNumber}`, entry.time),
      numberCell(`C${rowNumber}`, entry.paidTotalCents / 100, '3'),
      numberCell(`D${rowNumber}`, entry.returnedCents / 100, '3'),
      numberCell(`E${rowNumber}`, entry.remainingCents / 100, '3'),
    ].join('')}</row>`;
  }).join('');
  const lastRow = Math.max(4, entries.length + 4);
  const monthTitle = `Devoluciones — ${monthLabel.charAt(0).toUpperCase()}${monthLabel.slice(1)}`;

  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:E${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols><col min="1" max="1" width="16" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/><col min="3" max="3" width="21" customWidth="1"/><col min="4" max="4" width="23" customWidth="1"/><col min="5" max="5" width="24" customWidth="1"/></cols>
  <sheetData>
    <row r="1" ht="28" customHeight="1">${textCell('A1', monthTitle, '1')}</row>
    <row r="2">${textCell('A2', 'Devoluciones')}${numberCell('B2', entries.length)}${textCell('C2', 'Importe total devuelto')}${numberCell('D2', returnedTotalCents / 100, '3')}</row>
    <row r="4" ht="24" customHeight="1">${headerCells}</row>
    ${dataRows}
  </sheetData>
  <autoFilter ref="A4:E${lastRow}"/>
  <mergeCells count="1"><mergeCell ref="A1:E1"/></mergeCells>
  <pageMargins left="0.35" right="0.35" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;€&quot; #,##0.00"/></numFmts>
  <fonts count="3"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="16"/><color rgb="FF192B3A"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF087D78"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  return zipFiles({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Devoluciones" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': worksheetXml,
    'xl/styles.xml': stylesXml,
  });
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
    let body = await readFile(filePath);
    if (filePath === resolve(PUBLIC_DIR, 'index.html')) {
      body = Buffer.from(body.toString('utf8').replace('__BASE_HREF__', BASE_HREF));
    }
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
  const pathname = stripBasePath(url.pathname);

  if (pathname === '/api/returns/export' && request.method === 'GET') {
    const month = url.searchParams.get('month');
    if (!isMonthString(month)) {
      sendJson(response, 400, { error: 'Selecciona un mes válido para la descarga.' });
      return;
    }

    try {
      const [firstDay, lastDay] = monthDateRange(month);
      const entries = getByMonth.all(firstDay, lastDay);
      const workbookBuffer = await buildMonthlyWorkbook(month, entries);
      response.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="devoluciones-${month}.xlsx"`,
        'content-length': workbookBuffer.length,
        'cache-control': 'no-store',
      });
      response.end(workbookBuffer);
    } catch (error) {
      console.error(`No se pudo generar el Excel de ${month}:`, error);
      sendJson(response, 500, { error: 'No se pudo preparar el Excel de ese mes.' });
    }
    return;
  }

  if (pathname === '/api/returns' && request.method === 'GET') {
    const now = new Date();
    const today = dateTimeInMadrid(now).date;
    const latestDate = getLatestDate.get().date || null;
    const requestedDate = url.searchParams.get('date');
    if (requestedDate && !isDateString(requestedDate)) {
      sendJson(response, 400, { error: 'La fecha seleccionada no es válida.' });
      return;
    }

    const date = requestedDate || today;
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

  if (pathname === '/api/returns' && request.method === 'POST') {
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

  if (pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'Ruta de API no encontrada.' });
    return;
  }

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Método no permitido.' });
    return;
  }

  await serveStatic(pathname, response);
});

server.listen(PORT, HOST, () => {
  console.log(`CuentaClara disponible en http://${HOST}:${PORT}`);
  console.log(`Base de datos: ${DB_PATH}`);
});

function closeDatabase() {
  db.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', closeDatabase);
process.on('SIGTERM', closeDatabase);
