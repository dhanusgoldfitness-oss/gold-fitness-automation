// Offline integration test: real Express webhook + the menu bot (mock Meta/Cloudinary, in-memory store).
const assert = require('assert');
const crypto = require('crypto');

process.env.VERIFY_TOKEN = 'verify-me';
process.env.META_APP_SECRET = 'app-secret';
process.env.ADMIN_KEY = 'admin-key';

const { createApp } = require('../src/server');
const { ownerNumbers } = require('../src/channels');

const sign = (body) => 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting for condition');
}

function legacyDb() {
  const s = { leads: [], messages: [], nextId: 1 };
  return {
    s,
    async getLead(c, e) { return s.leads.find((l) => l.channel === c && l.external_id === e) || null; },
    async createLead(l) { const row = { id: s.nextId++, ...l }; s.leads.push(row); return row; },
    async updateLead(id, p) { const row = s.leads.find((l) => l.id === id); Object.assign(row, p); return row; },
    async logMessage(m) { s.messages.push(m); return true; },
  };
}

const wa = (from, id, msg) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Ravi' } }], ...msg(from, id) } }] }],
});
const text = (body) => (from, id) => ({ messages: [{ from, id, type: 'text', text: { body } }] });
const status = (from, id) => ({ statuses: [{ id: 'wamid.out1', status: 'read', timestamp: '1', recipient_id: from }] });

(async () => {
  const { createEnquiryEngine } = await import('../src/enquiry-bot/factory.js');
  const { MemoryStore } = await import('../src/enquiry-bot/store.js');

  // --- ownerNumbers: the live OWNER_PHONE value has two numbers with no separator
  assert.deepStrictEqual(ownerNumbers('919740018911919742142166'), ['919740018911', '919742142166']);
  assert.deepStrictEqual(ownerNumbers('9740018911, 9742142166'), ['919740018911', '919742142166']);
  assert.deepStrictEqual(ownerNumbers('+91 97400 18911;+91 97421 42166'), ['919740018911', '919742142166']);
  assert.deepStrictEqual(ownerNumbers(''), []);

  // --- disabled / unsafe configs fall back to the keyword bot
  const logs = [];
  const quiet = (...a) => logs.push(a.join(' '));
  assert.strictEqual(createEnquiryEngine({ env: {}, log: quiet }), null);
  assert.strictEqual(createEnquiryEngine({ env: { ENQUIRY_BOT: 'on', WA_ACCESS_TOKEN: 't', WA_PHONE_NUMBER_ID: '1' }, log: quiet }), null, 'no durable store -> refuse');
  assert.ok(logs.some((l) => /no Supabase credentials/.test(l)));

  // --- enabled
  const db = legacyDb();
  const metaCalls = [];
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('cloudinary')) return { ok: true, status: 200, json: async () => ({ resources: [] }) };
    metaCalls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ messages: [{ id: `wamid.out${metaCalls.length}` }] }) };
  };
  const engine = createEnquiryEngine({
    env: { ENQUIRY_BOT: 'on', WA_ACCESS_TOKEN: 'tok', WA_PHONE_NUMBER_ID: '123', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' },
    legacyDb: db,
    notifyOwner: async () => {},
    fetchImpl,
    store: new MemoryStore(),
    log: quiet,
  });
  assert.ok(engine);
  const legacySent = [];
  const app = createApp({ db, send: async (...a) => legacySent.push(a), waTemplate: async () => {}, notifyOwner: async () => {}, enquiryEngine: engine, noDelay: true });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const hook = (payload, signed = true) => {
    const body = JSON.stringify(payload);
    return fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signed ? { 'x-hub-signature-256': sign(body) } : {}) }, body });
  };

  try {
    // unsigned rejected, nothing saved
    assert.strictEqual((await hook(wa('919000000001', 'w1', text('hi')), false)).status, 401);
    assert.strictEqual(engine.store.inbound.size, 0);

    // Hi -> interactive main menu from the menu bot, NOT the keyword bot
    assert.strictEqual((await hook(wa('919000000001', 'w2', text('Hi')))).status, 200);
    await waitFor(() => metaCalls.length === 1);
    assert.strictEqual(metaCalls[0].type, 'interactive');
    assert.strictEqual(metaCalls[0].interactive.type, 'list');
    assert.strictEqual(metaCalls[0].interactive.action.button, 'View Options');
    assert.strictEqual(legacySent.length, 0, 'only one service answers');

    // duplicate delivery -> still one reply
    await hook(wa('919000000001', 'w2', text('Hi')));
    await sleep(100);
    assert.strictEqual(metaCalls.length, 1);

    // status events never trigger replies
    assert.strictEqual((await hook(wa('919000000001', 'x', status))).status, 200);
    await sleep(100);
    assert.strictEqual(metaCalls.length, 1);

    // typed 1 at main menu -> General Fitness prices
    await hook(wa('919000000001', 'w3', text('1')));
    await waitFor(() => metaCalls.length >= 3);
    assert.match(metaCalls[1].text.body, /General Fitness – Self-Guided Training[\s\S]*₹5,250/);

    // STOP: legacy consent flag cleared, acknowledged; customer can still message; START opts back in
    await hook(wa('919000000001', 'w4', text('STOP')));
    await waitFor(() => db.s.leads.length === 1 && db.s.leads[0].opt_in === false && metaCalls.some((c) => c.text && /unsubscribed from offers and reminders/.test(c.text.body)));
    const before = metaCalls.length;
    await hook(wa('919000000001', 'w5', text('menu')));
    await waitFor(() => metaCalls.length > before);
    await hook(wa('919000000001', 'w6', text('start')));
    await waitFor(() => db.s.leads[0].opt_in === true);

    // Owner command through the real webhook: authorized sender + bare number -> pack to the client, confirmation to the owner
    await hook(wa('919845012345', 'c1', text('hi'))); // client opens the 24h window
    await waitFor(() => metaCalls.some((c) => c.to === '919845012345'));
    const mark = metaCalls.length;
    await hook(wa('919742142166', 'o1', text('+91 98450 12345')));
    await waitFor(() => metaCalls.slice(mark).some((c) => c.to === '919742142166' && /✅ Sent to \+91 98450 12345/.test(c.text?.body || '')), 8000);
    const pack = metaCalls.slice(mark).filter((c) => c.to === '919845012345');
    assert.strictEqual(pack.length, 8);
    assert.match(pack[0].text.body, /GOLD FITNESS KENGERI/);
    // an unauthorized sender cannot trigger it
    const m2 = metaCalls.length;
    await hook(wa('919900000001', 'o2', text('9845012345')));
    await sleep(300);
    assert.ok(!metaCalls.slice(m2).some((c) => c.to === '919845012345'));

    // legacy message log is not written for menu-bot traffic (the bot keeps its own durable log)
    assert.strictEqual(db.s.messages.length, 0);
  } finally {
    server.close();
  }

  // --- disabled engine: keyword bot answers WhatsApp exactly as before
  const db2 = legacyDb();
  const sent2 = [];
  const app2 = createApp({ db: db2, send: async (...a) => sent2.push(a), waTemplate: async () => {}, notifyOwner: async () => {}, enquiryEngine: null, noDelay: true });
  const s2 = app2.listen(0);
  try {
    const body = JSON.stringify(wa('919000000002', 'k1', text('hello')));
    await fetch(`http://127.0.0.1:${s2.address().port}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
    await waitFor(() => sent2.length === 1);
    assert.match(sent2[0][2], /Welcome to/);
  } finally {
    s2.close();
  }

  console.log('enquiry integration test passed');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
