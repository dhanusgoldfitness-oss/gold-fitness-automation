// Offline smoke test: fake database and fake senders, real HTTP server.
const assert = require('assert');
const crypto = require('crypto');

process.env.VERIFY_TOKEN = 'verify-me';
process.env.META_APP_SECRET = 'app-secret';
process.env.ADMIN_KEY = 'admin-key';

const { createApp, istDate } = require('../src/server');

function fakeDb() {
  const s = { leads: [], messages: [], members: [], nextId: 1 };
  return {
    s,
    async getLead(channel, ext) {
      return s.leads.find((l) => l.channel === channel && l.external_id === ext) || null;
    },
    async createLead(l) {
      const row = { id: s.nextId++, booked: false, needs_human: false, last_seen_before: false, ...l };
      s.leads.push(row);
      return row;
    },
    async updateLead(id, patch) {
      const row = s.leads.find((l) => l.id === id);
      Object.assign(row, patch);
      return row;
    },
    async logMessage(m) {
      if (m.message_id && s.messages.some((x) => x.message_id === m.message_id)) return false;
      s.messages.push(m);
      return true;
    },
    async membersExpiringOn(d) {
      return s.members.filter((m) => m.expires_on === d && m.opt_in && m.last_reminded_on !== d);
    },
    async markReminded(id, d) {
      s.members.find((m) => m.id === id).last_reminded_on = d;
    },
    async audience(kind) {
      const rows = kind === 'members' ? s.members : s.leads;
      return rows.filter((r) => r.opt_in && r.phone);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting for condition');
}

const sign = (body) => 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');

function waPayload(from, id, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Ravi' } }], messages: [{ from, id, type: 'text', text: { body: text } }] } }] }],
  };
}

(async () => {
  const db = fakeDb();
  const sent = [];
  const templates = [];
  const owner = [];
  const app = createApp({
    db,
    send: async (channel, to, body) => sent.push({ channel, to, body }),
    waTemplate: async (to, name, lang, params) => templates.push({ to, name, lang, params }),
    notifyOwner: async (t) => owner.push(t),
    noDelay: true,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function hook(payload, { signed = true } = {}) {
    const body = JSON.stringify(payload);
    return fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(signed ? { 'x-hub-signature-256': sign(body) } : {}) },
      body,
    });
  }

  // 1. Verification handshake
  let r = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123`);
  assert.strictEqual(await r.text(), 'abc123');
  r = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123`);
  assert.strictEqual(r.status, 403);

  // 2. Signature enforced
  r = await hook(waPayload('919000000001', 'm1', 'price'), { signed: false });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(sent.length, 0);

  // 3. First message gets greeting, price intent gets plans
  r = await hook(waPayload('919000000001', 'm1', 'hello'));
  assert.strictEqual(r.status, 200);
  await waitFor(() => sent.length === 1);
  assert.match(sent[0].body, /Welcome to Gold Fitness/);
  await hook(waPayload('919000000001', 'm2', 'what is the price?'));
  await waitFor(() => sent.length === 2);
  assert.match(sent[1].body, /membership plans/);

  // 4. Duplicate webhook is ignored
  await hook(waPayload('919000000001', 'm2', 'what is the price?'));
  await sleep(100);
  assert.strictEqual(sent.length, 2, 'duplicate should not reply twice');

  // 5. Join flow
  const steps = [['m3', 'I want to join', /name/i], ['m4', 'Ravi Kumar', /goal/i], ['m5', 'muscle gain', /when/i], ['m6', 'Monday 6pm', /offers/i], ['m7', 'yes', /all set/i]];
  for (const [id, text, expect] of steps) {
    const before = sent.length;
    await hook(waPayload('919000000001', id, text));
    await waitFor(() => sent.length === before + 1);
    assert.match(sent[sent.length - 1].body, expect);
  }
  const lead = db.s.leads[0];
  assert.strictEqual(lead.booked, true);
  assert.strictEqual(lead.opt_in, true);
  assert.strictEqual(lead.goal, 'muscle gain');
  assert.strictEqual(owner.length, 1);
  assert.match(owner[0], /Ravi Kumar/);

  // 6. STOP opts out
  await hook(waPayload('919000000001', 'm8', 'STOP'));
  await waitFor(() => lead.opt_in === false);

  // 7. Instagram DM, echo skipped
  const before = sent.length;
  await hook({ object: 'instagram', entry: [{ id: 'IGPAGE', messaging: [
    { sender: { id: 'IGUSER1' }, message: { mid: 'ig1', text: 'timings?' } },
    { sender: { id: 'IGPAGE' }, message: { mid: 'ig2', text: 'echo', is_echo: true } },
  ] }] });
  await waitFor(() => sent.length === before + 1);
  assert.strictEqual(sent[sent.length - 1].channel, 'instagram');
  assert.match(sent[sent.length - 1].body, /open/);
  await sleep(50);
  assert.strictEqual(sent.length, before + 1);

  // 8. Reminders, sent once only
  const target = istDate(3);
  db.s.members.push(
    { id: 1, name: 'Asha', phone: '919000000010', expires_on: target, opt_in: true, last_reminded_on: null },
    { id: 2, name: 'Bala', phone: '919000000011', expires_on: target, opt_in: false, last_reminded_on: null },
  );
  let out = await app.runReminders();
  assert.strictEqual(out.sent, 1);
  assert.deepStrictEqual(templates[0].params, ['Asha', target]);
  out = await app.runReminders();
  assert.strictEqual(out.sent, 0, 'must not remind twice');

  // 9. Admin auth and broadcast
  r = await fetch(`${base}/admin/broadcast`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 401);
  const admin = { 'Content-Type': 'application/json', 'x-admin-key': 'admin-key' };
  db.s.leads.push({ id: 99, channel: 'whatsapp', external_id: 'x', name: 'Mani', phone: '919000000020', opt_in: true });
  r = await fetch(`${base}/admin/broadcast`, { method: 'POST', headers: admin, body: JSON.stringify({ audience: 'leads', template: 'offer' }) });
  assert.deepStrictEqual(await r.json(), { dryRun: true, recipients: 1 });
  const tBefore = templates.length;
  r = await fetch(`${base}/admin/broadcast`, { method: 'POST', headers: admin, body: JSON.stringify({ audience: 'leads', template: 'offer', params: ['Hi {{name}}'], dryRun: false }) });
  const res = await r.json();
  assert.strictEqual(res.sent, 1);
  assert.deepStrictEqual(templates[tBefore].params, ['Hi Mani']);

  server.close();
  console.log('All smoke tests passed');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
