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

const memoryCache = new Map();

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
    headers: {
      'Accept': 'application/json'
    }
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

function handleStaticAsset(filePath, res) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': getMimeType(filePath)
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (reqUrl.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        calendarApiConfigured: Boolean(process.env.GOOGLE_CALENDAR_API_KEY)
      });
      return;
    }

    if (reqUrl.pathname === '/api/calendar-events') {
      await handleCalendarApi(reqUrl, res);
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

server.listen(PORT, HOST, () => {
  console.log(`AHHHHHH listening on http://${HOST}:${PORT}`);
});
