// Google Sheets storage. Same interface as db.js, so bot.js and server.js don't care which is used.
// Authenticates as a service account (signed JWT -> access token) using only Node's crypto and fetch.
//
// Tabs used:
//   Leads   - date, name, phone, goal, source, status, whatsapp_consent, notes (+ external_id, added automatically)
//   Members - name, phone, plan, expires_on, opt_in, last_reminded_on (created automatically if missing)
// The Sales tab is not touched.
//
// Conversation state (which question a person is on) lives in memory. If the server restarts
// mid-chat, that person simply starts over. Saved lead details stay in the sheet.

const crypto = require('crypto');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const LEAD_COLS = ['date', 'name', 'phone', 'goal', 'source', 'status', 'whatsapp_consent', 'notes'];
const EXTRA_LEAD_COL = 'external_id';
const MEMBER_COLS = ['name', 'phone', 'plan', 'expires_on', 'opt_in', 'last_reminded_on'];

const enc = encodeURIComponent;
const sheetId = () => process.env.GOOGLE_SHEET_ID;

// ---------- auth ----------
let creds = null;
let token = { value: null, exp: 0 };

function getCreds() {
  if (creds) return creds;
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const c = JSON.parse(text);
  if (!c.client_email || !c.private_key) throw new Error('Service account JSON needs client_email and private_key');
  creds = c;
  return c;
}

async function getToken() {
  if (token.value && Date.now() < token.exp - 60000) return token.value;
  const c = getCreds();
  const aud = c.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned =
    b64({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    b64({ iss: c.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud, iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(c.private_key).toString('base64url');

  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google sign-in failed ${res.status}: ${data.error_description || data.error || 'unknown error'}`);
  }
  token = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return token.value;
}

async function api(path, { method = 'GET', body } = {}) {
  const t = await getToken();
  const res = await fetch(`${API}/${sheetId()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || JSON.stringify(data);
    const hint =
      res.status === 403 || res.status === 404
        ? ` Share the sheet with ${getCreds().client_email} as Editor and check GOOGLE_SHEET_ID.`
        : '';
    throw new Error(`Sheets ${method} ${path} -> ${res.status}: ${msg}.${hint}`);
  }
  return data;
}

// ---------- small helpers ----------
function colLetter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function istDate(offsetDays = 0) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offsetDays * 86400000));
}

// Accepts a Sheets serial number, YYYY-MM-DD, or DD/MM/YYYY (Indian order). Returns YYYY-MM-DD or ''.
function normDate(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

function normPhone(v) {
  const d = String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
  if (!d) return '';
  return d.length === 10 ? `91${d}` : d;
}

const isYes = (v) => /^(yes|y|true|1|ok)$/i.test(String(v === undefined || v === null ? '' : v).trim());

// ---------- sheet setup ----------
const headers = { Leads: [], Members: [] }; // trimmed, lowercase, in column order

async function readTab(tab) {
  const d = await api(`/values/${enc(`${tab}!A:Z`)}?valueRenderOption=UNFORMATTED_VALUE`);
  return d.values || [];
}

async function writeRange(range, values) {
  return api(`/values/${enc(range)}?valueInputOption=RAW`, { method: 'PUT', body: { values } });
}

async function init() {
  const meta = await api('?fields=sheets.properties.title');
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  const missing = ['Leads', 'Members'].filter((t) => !titles.includes(t));
  if (missing.length) {
    await api(':batchUpdate', { method: 'POST', body: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
  }

  const wanted = { Leads: [...LEAD_COLS, EXTRA_LEAD_COL], Members: MEMBER_COLS };
  for (const tab of ['Leads', 'Members']) {
    const rows = await readTab(tab);
    let hdr = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
    if (!hdr.length) {
      await writeRange(`${tab}!A1`, [wanted[tab]]);
      hdr = wanted[tab].slice();
    } else {
      for (const col of wanted[tab]) {
        if (hdr.includes(col)) continue;
        if (tab === 'Leads' && col !== EXTRA_LEAD_COL) throw new Error(`The Leads tab has no "${col}" column`);
        await writeRange(`${tab}!${colLetter(hdr.length)}1`, [[col]]);
        hdr.push(col);
      }
    }
    headers[tab] = hdr;
  }
}

let readyPromise = null;
function ensure() {
  if (!readyPromise) {
    readyPromise = init().catch((e) => {
      readyPromise = null;
      throw e;
    });
  }
  return readyPromise;
}

function record(tab, row) {
  const rec = {};
  headers[tab].forEach((h, i) => {
    rec[h] = row[i] === undefined ? '' : row[i];
  });
  return rec;
}

// ---------- leads ----------
const cache = new Map(); // "channel:externalId" -> lead
const inflight = new Map();
const key = (channel, ext) => `${channel}:${ext}`;

async function getLead(channel, externalId) {
  const k = key(channel, externalId);
  if (cache.has(k)) return cache.get(k);
  await ensure();
  const rows = await readTab('Leads');
  for (let i = 1; i < rows.length; i++) {
    const rec = record('Leads', rows[i]);
    const match =
      String(rec.external_id) === String(externalId) || (channel === 'whatsapp' && normPhone(rec.phone) === String(externalId));
    if (!match) continue;
    const lead = {
      id: k,
      channel,
      external_id: externalId,
      name: rec.name || null,
      phone: rec.phone ? String(rec.phone) : null,
      goal: rec.goal || null,
      preferred_time: null,
      state: 'idle',
      booked: false,
      needs_human: false,
      last_seen_before: true,
      opt_in: isYes(rec.whatsapp_consent),
      row: i + 1,
    };
    cache.set(k, lead);
    return lead;
  }
  return null;
}

function createLead(l) {
  const k = key(l.channel, l.external_id);
  if (cache.has(k)) return Promise.resolve(cache.get(k));
  if (inflight.has(k)) return inflight.get(k);

  const p = (async () => {
    await ensure();
    const vals = {
      date: istDate(),
      name: l.name || '',
      phone: l.phone || '',
      goal: '',
      source: l.channel,
      status: 'new',
      whatsapp_consent: '',
      notes: '',
      external_id: String(l.external_id),
    };
    const rowValues = headers.Leads.map((h) => (vals[h] === undefined ? '' : vals[h]));
    const res = await api(`/values/${enc('Leads!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: { values: [rowValues] },
    });
    const m = /!(?:[A-Z]+)(\d+)/.exec((res.updates && res.updates.updatedRange) || '');
    if (!m) throw new Error('Could not tell which row the new lead was written to');
    const lead = {
      id: k,
      channel: l.channel,
      external_id: l.external_id,
      name: l.name || null,
      phone: l.phone || null,
      goal: null,
      preferred_time: null,
      state: 'idle',
      booked: false,
      needs_human: false,
      last_seen_before: false,
      opt_in: false,
      row: Number(m[1]),
    };
    cache.set(k, lead);
    return lead;
  })().finally(() => inflight.delete(k));

  inflight.set(k, p);
  return p;
}

async function updateLead(id, patch) {
  const lead = cache.get(id);
  if (!lead) throw new Error(`Unknown lead ${id}`);
  Object.assign(lead, patch);

  // Only write the cells that changed, so staff edits to other columns are never overwritten.
  const data = [];
  const put = (col, value) => {
    const i = headers.Leads.indexOf(col);
    if (i >= 0) data.push({ range: `Leads!${colLetter(i)}${lead.row}`, values: [[value]] });
  };
  if ('name' in patch) put('name', patch.name === null || patch.name === undefined ? '' : patch.name);
  if ('goal' in patch) put('goal', patch.goal === null || patch.goal === undefined ? '' : patch.goal);
  if ('preferred_time' in patch) put('notes', `Preferred time: ${patch.preferred_time}`);
  if ('opt_in' in patch) put('whatsapp_consent', patch.opt_in ? 'yes' : 'no');
  if (patch.booked) put('status', 'trial_requested');
  if (patch.needs_human) put('status', 'needs_human');

  if (data.length) {
    await api('/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data } });
  }
  return lead;
}

// Remembers recent message IDs so repeated webhook deliveries are ignored.
const seen = new Set();
async function logMessage(m) {
  if (!m.message_id) return true;
  if (seen.has(m.message_id)) return false;
  seen.add(m.message_id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  return true;
}

// ---------- members (reminders) and broadcast audiences ----------
async function memberRows() {
  await ensure();
  const rows = await readTab('Members');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const rec = record('Members', rows[i]);
    if (!normPhone(rec.phone)) continue;
    out.push({
      id: i + 1, // sheet row number
      name: rec.name ? String(rec.name) : '',
      phone: normPhone(rec.phone),
      expires_on: normDate(rec.expires_on),
      opt_in: isYes(rec.opt_in),
      last_reminded_on: normDate(rec.last_reminded_on),
    });
  }
  return out;
}

async function membersExpiringOn(isoDate) {
  const all = await memberRows();
  return all.filter((m) => m.opt_in && m.expires_on === isoDate && m.last_reminded_on !== isoDate);
}

async function markReminded(rowNumber, isoDate) {
  const i = headers.Members.indexOf('last_reminded_on');
  await writeRange(`Members!${colLetter(i)}${rowNumber}`, [[isoDate]]);
}

async function audience(kind) {
  if (kind === 'members') {
    return (await memberRows()).filter((m) => m.opt_in).map((m) => ({ id: m.id, name: m.name, phone: m.phone }));
  }
  await ensure();
  const rows = await readTab('Leads');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const rec = record('Leads', rows[i]);
    if (isYes(rec.whatsapp_consent) && normPhone(rec.phone)) {
      out.push({ id: i + 1, name: rec.name ? String(rec.name) : '', phone: normPhone(rec.phone) });
    }
  }
  return out;
}

module.exports = { init, getLead, createLead, updateLead, logMessage, membersExpiringOn, markReminded, audience, _normDate: normDate, _normPhone: normPhone };
