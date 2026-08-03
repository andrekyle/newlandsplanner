// Newlands SDA Church - Church Programme Planner
// Zero-dependency server: Node.js built-in http + Supabase (or local node:sqlite fallback)
// Run with: node server.js   (Node 22.5+ required)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
// PIN used to save/edit programmes. 1844 by default (change via env var ELDER_PIN).
const ELDER_PIN = process.env.ELDER_PIN || '1844';
const IS_VERCEL = !!process.env.VERCEL;

// ---- Storage: Supabase Postgres when SUPABASE_SERVICE_ROLE_KEY is set, local SQLite otherwise.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uduvabtbeantxqtrdnpv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
const USE_SUPABASE = !!SUPABASE_KEY;

let store;

if (USE_SUPABASE) {
  // ---- Supabase backend (via PostgREST, no client library needed) ----
  async function sb(pathq, opts = {}) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathq}`, {
      ...opts,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }
  store = {
    async monthEvents(month) { // rows: {id, date, type, data(object)}
      return sb(`events?select=id,date,type,data&date=like.${month}-*&order=date,type`);
    },
    async dayEvents(date) {
      return sb(`events?date=eq.${date}&order=type`);
    },
    async getEvent(id) {
      const rows = await sb(`events?id=eq.${encodeURIComponent(id)}&limit=1`);
      return rows[0] || null;
    },
    async insertEvent(id, date, type, data, updated_at, updated_by) {
      await sb('events', { method: 'POST', body: JSON.stringify({ id, date, type, data, updated_at, updated_by }) });
    },
    async updateEvent(data, updated_at, updated_by, id) {
      await sb(`events?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ data, updated_at, updated_by }) });
    },
    async deleteEvent(id) {
      await sb(`events?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async namesFor(field) {
      const rows = await sb(`names?select=name&field=eq.${encodeURIComponent(field)}&order=uses.desc,name&limit=40`);
      return rows.map(r => r.name);
    },
    async allNames() {
      const rows = await sb('names?select=name&order=name&limit=400');
      return [...new Set(rows.map(r => r.name))].slice(0, 200);
    },
    async bumpName(field, name) {
      await sb('rpc/bump_name', { method: 'POST', body: JSON.stringify({ p_field: field, p_name: name }) });
    },
  };
} else {
  // ---- Local SQLite backend (development / single-machine use) ----
  try {
  const { DatabaseSync } = require('node:sqlite');
  // Vercel's writable filesystem is /tmp (ephemeral between instances/cold starts).
  const DB_PATH = IS_VERCEL ? '/tmp/programmes.db' : path.join(__dirname, 'programmes.db');
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS programmes (
      date TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,           -- random id
      date TEXT NOT NULL,            -- YYYY-MM-DD
      type TEXT NOT NULL,            -- event type key (sabbath, board_meeting, ...)
      data TEXT NOT NULL,            -- JSON of all form fields
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
    CREATE TABLE IF NOT EXISTS names (
      field TEXT NOT NULL,           -- duty/field key e.g. songService
      name TEXT NOT NULL,
      uses INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (field, name)
    );
  `);

  // ---- one-time migration: old per-date programmes -> events of type 'sabbath'
  const legacyRows = db.prepare('SELECT * FROM programmes').all();
  if (legacyRows.length > 0) {
    const insEv = db.prepare('INSERT INTO events (id, date, type, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)');
    const already = db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'sabbath' AND date = ?");
    for (const r of legacyRows) {
      if (already.get(r.date).c === 0) {
        insEv.run(crypto.randomUUID(), r.date, 'sabbath', r.data, r.updated_at, r.updated_by);
      }
    }
    db.exec('DELETE FROM programmes');
  }

  const monthStmt = db.prepare("SELECT id, date, type, data FROM events WHERE date LIKE ? ORDER BY date, type");
  const dayStmt = db.prepare('SELECT * FROM events WHERE date = ? ORDER BY type');
  const getEvStmt = db.prepare('SELECT * FROM events WHERE id = ?');
  const insEvStmt = db.prepare('INSERT INTO events (id, date, type, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)');
  const updEvStmt = db.prepare('UPDATE events SET data = ?, updated_at = ?, updated_by = ? WHERE id = ?');
  const delEvStmt = db.prepare('DELETE FROM events WHERE id = ?');
  const namesStmt = db.prepare('SELECT name FROM names WHERE field = ? ORDER BY uses DESC, name LIMIT 40');
  const allNamesStmt = db.prepare('SELECT DISTINCT name FROM names ORDER BY name LIMIT 200');
  const bumpNameStmt = db.prepare(`
    INSERT INTO names (field, name, uses) VALUES (?, ?, 1)
    ON CONFLICT(field, name) DO UPDATE SET uses = uses + 1
  `);

  const parseRow = r => r && ({ ...r, data: JSON.parse(r.data) });
  store = {
    async monthEvents(month) { return monthStmt.all(month + '-%').map(parseRow); },
    async dayEvents(date) { return dayStmt.all(date).map(parseRow); },
    async getEvent(id) { return parseRow(getEvStmt.get(id)); },
    async insertEvent(id, date, type, data, updated_at, updated_by) { insEvStmt.run(id, date, type, JSON.stringify(data), updated_at, updated_by); },
    async updateEvent(data, updated_at, updated_by, id) { updEvStmt.run(JSON.stringify(data), updated_at, updated_by, id); },
    async deleteEvent(id) { delEvStmt.run(id); },
    async namesFor(field) { return namesStmt.all(field).map(r => r.name); },
    async allNames() { return allNamesStmt.all().map(r => r.name); },
    async bumpName(field, name) { bumpNameStmt.run(field, name); },
  };
  } catch (e) {
    // SQLite unavailable or failed to initialise (e.g. serverless runtime) — never crash the function.
    console.error('SQLite storage unavailable and SUPABASE_SERVICE_ROLE_KEY not set:', e.message);
    const fail = async () => { throw new Error('Storage not configured: set the SUPABASE_SERVICE_ROLE_KEY environment variable.'); };
    store = {
      monthEvents: fail, dayEvents: fail, getEvent: fail, insertEvent: fail,
      updateEvent: fail, deleteEvent: fail, namesFor: fail, allNames: fail, bumpName: fail,
    };
  }
}

// Required fields per event type for the "complete" indicator.
// Only the full Sabbath service has a strict required set; others count complete when a leader is set.
const REQUIRED = {
  sabbath: ['pastor', 'elder', 'deacons', 'childrensStory', 'offering', 'welcoming', 'sabbathSchool', 'lessonStudy'],
};

function isComplete(type, dataObj) {
  let req = REQUIRED[type] || ['leader'];
  if (type === 'sabbath') {
    const st = String(dataObj.serviceType || '');
    if (/communion/i.test(st)) req = req.concat('communionOfficiant');
    if (/baptism/i.test(st)) req = req.concat('baptismOfficiant');
    if (/dedication/i.test(st)) req = req.concat('dedicationOfficiant');
  }
  return req.every(f => {
    let v = dataObj[f];
    if (f === 'deacons' && (v == null || (Array.isArray(v) && !v.length))) v = dataObj.deacon; // legacy
    if (Array.isArray(v)) return v.some(x => (x || '').trim());
    return ((v || '') + '').trim().length > 0;
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function cleanData(data) {
  const clean = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (typeof v === 'string') clean[k] = v.trim().slice(0, 500);
    else if (Array.isArray(v)) clean[k] = v.map(x => ('' + x).trim().slice(0, 200)).filter(Boolean).slice(0, 30);
  }
  return clean;
}

async function recordNames(data, nameFields) {
  const fields = Array.isArray(nameFields) ? nameFields.map(String) : [];
  for (const field of fields) {
    const v = data[field];
    const list = Array.isArray(v) ? v : (typeof v === 'string' && v ? [v] : []);
    for (const name of list) {
      if (name && name.length >= 2) {
        try { await store.bumpName(field, name); } catch (e) { console.error('bumpName failed:', e.message); }
      }
    }
  }
}

async function handleRequest(req, res) {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);
  try {

  // --- health / diagnostics
  if (url.pathname === '/api/health' && req.method === 'GET') {
    let ok = true, detail = '';
    try { await store.monthEvents('2000-01'); } catch (e) { ok = false; detail = e.message; }
    return json(res, ok ? 200 : 500, { ok, storage: USE_SUPABASE ? 'supabase' : 'sqlite', node: process.version, vercel: IS_VERCEL, detail });
  }

  // --- month overview: { 'YYYY-MM-DD': [{id,type,complete}] }
  if (url.pathname === '/api/month' && req.method === 'GET') {
    const m = url.searchParams.get('m');
    if (!/^\d{4}-\d{2}$/.test(m || '')) return json(res, 400, { error: 'bad month' });
    const rows = await store.monthEvents(m);
    const out = {};
    for (const r of rows) {
      (out[r.date] = out[r.date] || []).push({ id: r.id, type: r.type, complete: isComplete(r.type, r.data) });
    }
    return json(res, 200, out);
  }

  // --- events for a day
  if (url.pathname.startsWith('/api/day/') && req.method === 'GET') {
    const date = url.pathname.slice('/api/day/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'bad date' });
    const rows = await store.dayEvents(date);
    return json(res, 200, rows.map(r => ({
      id: r.id, date: r.date, type: r.type, data: r.data,
      updated_at: r.updated_at, updated_by: r.updated_by,
      complete: isComplete(r.type, r.data),
    })));
  }

  // --- name suggestions
  if (url.pathname === '/api/names' && req.method === 'GET') {
    const field = url.searchParams.get('field');
    const names = field ? await store.namesFor(field) : await store.allNames();
    return json(res, 200, names);
  }

  // --- create / update event
  if (url.pathname === '/api/event' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    if ((payload.pin || '') !== ELDER_PIN) return json(res, 403, { error: 'Incorrect PIN. Only authorised leaders may save.' });
    const date = payload.date, type = (payload.type || '').slice(0, 50);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !type) return json(res, 400, { error: 'bad date or type' });
    const clean = cleanData(payload.data);
    await recordNames(clean, payload.nameFields);
    const now = new Date().toISOString();
    const by = (payload.updatedBy || '').slice(0, 100);
    let id = payload.id;
    if (id && await store.getEvent(id)) {
      await store.updateEvent(clean, now, by, id);
    } else {
      id = crypto.randomUUID();
      await store.insertEvent(id, date, type, clean, now, by);
    }
    return json(res, 200, { ok: true, id, complete: isComplete(type, clean) });
  }

  // --- delete event
  if (url.pathname.startsWith('/api/event/') && req.method === 'DELETE') {
    const id = url.pathname.slice('/api/event/'.length);
    let payload = {};
    try { payload = JSON.parse(await readBody(req) || '{}'); } catch {}
    if ((payload.pin || url.searchParams.get('pin') || '') !== ELDER_PIN) return json(res, 403, { error: 'Incorrect PIN.' });
    await store.deleteEvent(id);
    return json(res, 200, { ok: true });
  }

  // --- Static ---
  if (url.pathname === '/logo.png') {
    try {
      const img = fs.readFileSync(path.join(__dirname, 'adventist_logo-300x300.png'));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(img);
    } catch { res.writeHead(404); return res.end('Not found'); }
  }
  if (url.pathname === '/sda-logo.webp') {
    try {
      const img = fs.readFileSync(path.join(__dirname, 'sda-logo.webp'));
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
      return res.end(img);
    } catch { res.writeHead(404); return res.end('Not found'); }
  }
  if (url.pathname === '/sda-logo.svg') {
    try {
      const svg = fs.readFileSync(path.join(__dirname, 'sda-logo.svg'));
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      return res.end(svg);
    } catch { res.writeHead(404); return res.end('Not found'); }
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  res.writeHead(404); res.end('Not found');

  } catch (err) {
    console.error('Request failed:', err);
    const msg = /^Storage not configured/.test(err.message || '') ? err.message : 'Server error. Please try again.';
    if (!res.headersSent) return json(res, 500, { error: msg });
  }
}

// Start the HTTP server only when run directly (node server.js).
// On Vercel, requests are handled by the serverless function in api/.
if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Newlands SDA Church Programme Planner running at http://localhost:${PORT}`);
    console.log(`Storage: ${USE_SUPABASE ? 'Supabase (' + SUPABASE_URL + ')' : 'local SQLite'}`);
    console.log(`PIN: ${ELDER_PIN} (change with the ELDER_PIN environment variable)`);
  });
}

module.exports = { handleRequest };
