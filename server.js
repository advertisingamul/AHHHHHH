const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, 'AmulAdsDashboard.html');
const DEFAULT_CALENDAR_ID = 'en.indian#holiday@group.v.calendar.google.com';
const CALENDAR_CACHE_TTL = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shared data store — centralized files + benchmarks
//
// DATA_DIR is configurable so Railway can point it at a persistent volume.
// Set DATA_DIR=/data in Railway env vars and mount a volume at /data to
// survive restarts. Without a volume the data folder sits next to server.js
// and is wiped on each Railway deploy (re-upload needed after each deploy).
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SHARED_DATA_FILE = path.join(DATA_DIR, 'shared-data.json');

let sharedState = { files: [], savedAt: null, benchmarks: null };

function loadSharedData() {
  try {
    if (!fs.existsSync(SHARED_DATA_FILE)) return;
    const raw = fs.readFileSync(SHARED_DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      sharedState = { ...sharedState, ...parsed };
      console.log(`Shared data loaded: ${(sharedState.files || []).length} file(s)`);
    }
  } catch (e) {
    console.warn('Could not load shared data:', e.message);
  }
}

function saveSharedData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SHARED_DATA_FILE, JSON.stringify(sharedState), 'utf8');
  } catch (e) {
    console.warn('Could not persist shared data:', e.message);
  }
}

// ---------------------------------------------------------------------------
// In-memory calendar cache
// ---------------------------------------------------------------------------
const memoryCache = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.md': return 'text/markdown; charset=utf-8';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default: return 'application/octet-stream';
  }
}

function safeResolve(requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const resolved = path.join(ROOT, normalized);
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

function readBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large (50 MB limit)'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Calendar API proxy
// ---------------------------------------------------------------------------
function getCalendarCacheKey(calendarId, year) {
  return `${calendarId}__${year}`;
}

function readCalendarCache(calendarId, year) {
  const key = getCalendarCacheKey(calendarId, year);
  const cached = memoryCache.get(key);
  if (!cached) return null;
  if ((Date.now() - cached.fetchedAt) > CALENDAR_CACHE_TTL) {
    memoryCache.delete(key);
    return null;
  }
  return cached.events;
}

function writeCalendarCache(calendarId, year, events) {
  memoryCache.set(getCalendarCacheKey(calendarId, year), {
    events,
    fetchedAt: Date.now()
  });
}

function normalizeCalendarEvent(event, calendarId) {
  if (!event?.start?.date) return null;
  return {
    date: event.start.date,
    name: event.summary || 'Untitled Event',
    calendarId
  };
}

async function fetchCalendarEvents(calendarId, year) {
  const cached = readCalendarCache(calendarId, year);
  if (cached) return cached;

  const apiKey = process.env.GOOGLE_CALENDAR_API_KEY;
  if (!apiKey) {
    const error = new Error('Missing GOOGLE_CALENDAR_API_KEY');
    error.statusCode = 503;
    throw error;
  }

  const timeMin = `${year}-01-01T00:00:00Z`;
  const timeMax = `${year}-12-31T23:59:59Z`;
  const remoteUrl = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  remoteUrl.searchParams.set('key', apiKey);
  remoteUrl.searchParams.set('timeMin', timeMin);
  remoteUrl.searchParams.set('timeMax', timeMax);
  remoteUrl.searchParams.set('singleEvents', 'true');
  remoteUrl.searchParams.set('orderBy', 'startTime');
  remoteUrl.searchParams.set('maxResults', '500');

  const response = await fetch(remoteUrl, {
    headers: { 'Accept': 'application/json' }
  });

  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`Google Calendar API error (${response.status}) ${details}`);
    error.statusCode = response.status;
    throw error;
  }

  const payload = await response.json();
  const events = (payload.items || []).map((event) => normalizeCalendarEvent(event, calendarId)).filter(Boolean);
  writeCalendarCache(calendarId, year, events);
  return events;
}

async function handleCalendarApi(reqUrl, res) {
  const calendarId = String(reqUrl.searchParams.get('calendarId') || '').trim() || DEFAULT_CALENDAR_ID;
  const year = Number(reqUrl.searchParams.get('year'));

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    sendJson(res, 400, { error: 'Query param "year" must be a valid 4-digit year.' });
    return;
  }

  try {
    const events = await fetchCalendarEvents(calendarId, year);
    sendJson(res, 200, { events });
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, {
      error: error.message || 'Failed to fetch calendar events.'
    });
  }
}

// ---------------------------------------------------------------------------
// Datasets API — centralized file sharing
// ---------------------------------------------------------------------------
function handleDatasetsGet(res) {
  sendJson(res, 200, {
    files: sharedState.files || [],
    savedAt: sharedState.savedAt || null,
    count: (sharedState.files || []).length
  });
}

async function handleDatasetsPost(req, res) {
  let parsed;
  try {
    const raw = await readBody(req);
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }
  if (!Array.isArray(parsed?.files) || !parsed.files.length) {
    sendJson(res, 400, { error: '"files" array is required.' });
    return;
  }
  sharedState.files = parsed.files;
  sharedState.savedAt = new Date().toISOString();
  saveSharedData();
  console.log(`Shared data updated: ${sharedState.files.length} file(s) at ${sharedState.savedAt}`);
  sendJson(res, 200, { ok: true, savedAt: sharedState.savedAt, count: sharedState.files.length });
}

function handleDatasetsDelete(res) {
  sharedState.files = [];
  sharedState.savedAt = null;
  saveSharedData();
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Benchmarks API — shared benchmark settings
// ---------------------------------------------------------------------------
function handleBenchmarksGet(res) {
  sendJson(res, 200, { benchmarks: sharedState.benchmarks || null });
}

async function handleBenchmarksPost(req, res) {
  let parsed;
  try {
    const raw = await readBody(req);
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }
  if (!parsed?.benchmarks || typeof parsed.benchmarks !== 'object') {
    sendJson(res, 400, { error: '"benchmarks" object is required.' });
    return;
  }
  sharedState.benchmarks = parsed.benchmarks;
  saveSharedData();
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
function handleStaticAsset(filePath, res) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (reqUrl.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        calendarApiConfigured: Boolean(process.env.GOOGLE_CALENDAR_API_KEY),
        datasetsCount: (sharedState.files || []).length,
        savedAt: sharedState.savedAt || null
      });
      return;
    }

    if (reqUrl.pathname === '/api/calendar-events') {
      await handleCalendarApi(reqUrl, res);
      return;
    }

    if (reqUrl.pathname === '/api/datasets') {
      if (req.method === 'GET') { handleDatasetsGet(res); return; }
      if (req.method === 'POST') { await handleDatasetsPost(req, res); return; }
      if (req.method === 'DELETE') { handleDatasetsDelete(res); return; }
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (reqUrl.pathname === '/api/benchmarks') {
      if (req.method === 'GET') { handleBenchmarksGet(res); return; }
      if (req.method === 'POST') { await handleBenchmarksPost(req, res); return; }
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
      handleStaticAsset(INDEX_FILE, res);
      return;
    }

    const filePath = safeResolve(reqUrl.pathname.replace(/^\/+/, ''));
    if (!filePath) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    handleStaticAsset(filePath, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

loadSharedData();

server.listen(PORT, HOST, () => {
  console.log(`Amul Campaign Monitor listening on http://${HOST}:${PORT}`);
});
