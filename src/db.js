// Minimal Supabase (PostgREST) client using fetch. No extra dependencies.
// Uses the service role key, so it must only run on the server.

const base = () => `${process.env.SUPABASE_URL}/rest/v1`;

function headers(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function request(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${base()}/${path}`, {
    method,
    headers: headers(prefer ? { Prefer: prefer } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const enc = encodeURIComponent;

async function getLead(channel, externalId) {
  const rows = await request(`leads?channel=eq.${enc(channel)}&external_id=eq.${enc(externalId)}&limit=1`);
  return rows[0] || null;
}

async function createLead(lead) {
  const rows = await request('leads', { method: 'POST', body: lead, prefer: 'return=representation' });
  return rows[0];
}

async function updateLead(id, patch) {
  const rows = await request(`leads?id=eq.${enc(id)}`, {
    method: 'PATCH',
    body: { ...patch, updated_at: new Date().toISOString() },
    prefer: 'return=representation',
  });
  return rows[0];
}

// Returns true if the message was new, false if it was a duplicate webhook retry.
async function logMessage(msg) {
  try {
    await request('messages', { method: 'POST', body: msg });
    return true;
  } catch (e) {
    if (String(e.message).includes('23505')) return false; // unique violation = duplicate
    throw e;
  }
}

async function membersExpiringOn(isoDate) {
  return request(
    `members?expires_on=eq.${enc(isoDate)}&opt_in=eq.true&or=(last_reminded_on.is.null,last_reminded_on.neq.${enc(isoDate)})`
  );
}

async function markReminded(memberId, isoDate) {
  return request(`members?id=eq.${enc(memberId)}`, { method: 'PATCH', body: { last_reminded_on: isoDate } });
}

async function audience(kind) {
  // Only people who opted in to marketing messages.
  const table = kind === 'members' ? 'members' : 'leads';
  const phoneCol = 'phone';
  return request(`${table}?opt_in=eq.true&${phoneCol}=not.is.null&select=id,name,${phoneCol}`);
}

module.exports = { getLead, createLead, updateLead, logMessage, membersExpiringOn, markReminded, audience };
