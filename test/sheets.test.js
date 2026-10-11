// Offline test for src/sheets.js against a fake Google (token endpoint + Sheets API). No network, no real key.
const assert = require('assert');
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

process.env.GOOGLE_SHEET_ID = 'SHEET123';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'svc@test.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: 'https://oauth2.googleapis.com/token',
});

const colIndex = (letters) => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function makeFakeGoogle() {
  // Headers copied from the real Leads / Sales template, including the stray spaces.
  const store = {
    tabs: {
      Leads: [['date', 'name ', ' phone ', 'goal ', 'source', 'status', 'whatsapp_consent ', 'notes']],
      Sales: [['date', 'customer', 'plan', 'amount_inr', 'payment_method']],
    },
    tokenCalls: 0,
  };

  const setCell = (tab, row, col, v) => {
    const rows = store.tabs[tab];
    while (rows.length < row) rows.push([]);
    const r = rows[row - 1];
    while (r.length < col) r.push('');
    r[col] = v;
  };
  const parseCell = (a1) => {
    const m = /^([A-Z]+)(\d+)$/.exec(a1);
    return { col: colIndex(m[1]), row: Number(m[2]) };
  };
  const json = (obj, status = 200) => ({
    ok: status < 400,
    status,
    async json() {
      return obj;
    },
  });

  async function fakeFetch(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method || 'GET';

    if (u.hostname === 'oauth2.googleapis.com') {
      store.tokenCalls++;
      const params = new URLSearchParams(opts.body);
      assert.strictEqual(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [h, p, s] = params.get('assertion').split('.');
      const valid = crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'));
      assert.ok(valid, 'JWT signature must verify with the matching public key');
      const claim = JSON.parse(Buffer.from(p, 'base64url').toString());
      assert.strictEqual(claim.iss, 'svc@test.iam.gserviceaccount.com');
      assert.match(claim.scope, /auth\/spreadsheets$/);
      return json({ access_token: 'tok', expires_in: 3600 });
    }

    assert.strictEqual(u.hostname, 'sheets.googleapis.com');
    assert.strictEqual(opts.headers.Authorization, 'Bearer tok');
    const prefix = '/v4/spreadsheets/SHEET123';
    const path = decodeURIComponent(u.pathname);
    assert.ok(path.startsWith(prefix), `unexpected path ${path}`);
    const rest = path.slice(prefix.length);
    const body = opts.body ? JSON.parse(opts.body) : null;

    if (rest === '' && method === 'GET') {
      return json({ sheets: Object.keys(store.tabs).map((title) => ({ properties: { title } })) });
    }
    if (rest === ':batchUpdate' && method === 'POST') {
      for (const r of body.requests) store.tabs[r.addSheet.properties.title] = [];
      return json({});
    }
    if (rest === '/values:batchUpdate' && method === 'POST') {
      for (const d of body.data) {
        const [tab, a1] = d.range.split('!');
        const { col, row } = parseCell(a1);
        setCell(tab, row, col, d.values[0][0]);
      }
      return json({});
    }
    if (rest.startsWith('/values/') && rest.endsWith(':append') && method === 'POST') {
      const [tab] = rest.slice(8, -7).split('!');
      store.tabs[tab].push(body.values[0].slice());
      const n = store.tabs[tab].length;
      return json({ updates: { updatedRange: `${tab}!A${n}:I${n}` } });
    }
    if (rest.startsWith('/values/') && method === 'GET') {
      const [tab] = rest.slice(8).split('!');
      return json({ values: store.tabs[tab].map((r) => r.slice()) });
    }
    if (rest.startsWith('/values/') && method === 'PUT') {
      const [tab, a1] = rest.slice(8).split('!');
      const { col, row } = parseCell(a1);
      body.values.forEach((vals, dr) => vals.forEach((v, dc) => setCell(tab, row + dr, col + dc, v)));
      return json({});
    }
    throw new Error(`Fake Google: unhandled ${method} ${rest}`);
  }
  return { store, fakeFetch };
}

function freshSheets() {
  delete require.cache[require.resolve('../src/sheets')];
  return require('../src/sheets');
}

const istDate = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86400000));
const serial = (iso) => Date.UTC(...iso.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x)))) / 86400000 + 25569;

(async () => {
  const { store, fakeFetch } = makeFakeGoogle();
  global.fetch = fakeFetch;

  // ---- 1. init: adds Members tab and external_id column, keeps the user's headers ----
  let db = freshSheets();
  await db.init();
  assert.deepStrictEqual(store.tabs.Members[0], ['name', 'phone', 'plan', 'expires_on', 'opt_in', 'last_reminded_on']);
  assert.strictEqual(store.tabs.Leads[0][8], 'external_id');
  assert.strictEqual(store.tabs.Leads[0][1], 'name ', 'existing headers must be left alone');
  assert.deepStrictEqual(store.tabs.Sales, [['date', 'customer', 'plan', 'amount_inr', 'payment_method']], 'Sales untouched');

  // ---- 2. create + update a WhatsApp lead; only the intended cells change ----
  let lead = await db.createLead({ channel: 'whatsapp', external_id: '919000000001', name: 'Ravi', phone: '919000000001' });
  assert.strictEqual(lead.row, 2);
  const row = store.tabs.Leads[1];
  assert.strictEqual(row[0], istDate(0));
  assert.strictEqual(row[1], 'Ravi');
  assert.strictEqual(row[2], '919000000001');
  assert.strictEqual(row[4], 'whatsapp');
  assert.strictEqual(row[5], 'new');
  assert.strictEqual(row[8], '919000000001');

  row[0] = 'edited by staff'; // simulate a staff edit; later updates must not overwrite it
  await db.updateLead(lead.id, { name: 'Ravi Kumar', state: 'ask_goal' });
  await db.updateLead(lead.id, { goal: 'muscle gain' });
  await db.updateLead(lead.id, { preferred_time: 'Monday 6pm' });
  const done = await db.updateLead(lead.id, { opt_in: true, state: 'idle', booked: true });
  assert.strictEqual(row[1], 'Ravi Kumar');
  assert.strictEqual(row[3], 'muscle gain');
  assert.strictEqual(row[5], 'trial_requested');
  assert.strictEqual(row[6], 'yes');
  assert.strictEqual(row[7], 'Preferred time: Monday 6pm');
  assert.strictEqual(row[0], 'edited by staff');
  assert.strictEqual(done.goal, 'muscle gain');

  // ---- 3. Instagram lead (long ID kept as text, no phone) ----
  const igId = '17841400123456789';
  await db.createLead({ channel: 'instagram', external_id: igId, name: null, phone: null });
  assert.strictEqual(store.tabs.Leads[2][8], igId);
  assert.strictEqual(store.tabs.Leads[2][4], 'instagram');

  // ---- 4. "Restart": fresh module finds both leads from the sheet ----
  db = freshSheets();
  const again = await db.getLead('whatsapp', '919000000001');
  assert.strictEqual(again.row, 2);
  assert.strictEqual(again.name, 'Ravi Kumar');
  assert.strictEqual(again.opt_in, true);
  assert.strictEqual(again.state, 'idle');
  assert.strictEqual(again.last_seen_before, true);
  assert.strictEqual((await db.getLead('instagram', igId)).row, 3);
  assert.strictEqual(await db.getLead('whatsapp', '910000000000'), null);

  // A lead added by hand in the sheet (phone only, no external_id) is matched by phone.
  store.tabs.Leads.push(['2026-10-01', 'Manual Mani', 9000000020, 'fat loss', 'walk-in', 'new', 'yes', '']);
  const manual = await db.getLead('whatsapp', '919000000020');
  assert.strictEqual(manual.name, 'Manual Mani');
  assert.strictEqual(manual.opt_in, true);

  // ---- 5. duplicate webhook IDs ----
  assert.strictEqual(await db.logMessage({ message_id: 'm1' }), true);
  assert.strictEqual(await db.logMessage({ message_id: 'm1' }), false);
  assert.strictEqual(await db.logMessage({ message_id: null }), true);

  // ---- 6. concurrent first messages create one row, not two ----
  const before = store.tabs.Leads.length;
  const [a, b] = await Promise.all([
    db.createLead({ channel: 'whatsapp', external_id: '919000000099', name: 'X', phone: '919000000099' }),
    db.createLead({ channel: 'whatsapp', external_id: '919000000099', name: 'X', phone: '919000000099' }),
  ]);
  assert.strictEqual(a, b);
  assert.strictEqual(store.tabs.Leads.length, before + 1);

  // ---- 7. members: reminders and audiences ----
  const target = istDate(3);
  const [y, m, d] = target.split('-');
  store.tabs.Members.push(
    ['Asha', 9000000010, 'Monthly', serial(target), 'yes', ''], // numeric phone, date as serial number
    ['Bala', '919000000011', 'Monthly', target, 'no', ''], // not opted in
    ['Chitra', '9000000012', 'Yearly', `${d}/${m}/${y}`, 'Yes', ''], // DD/MM/YYYY text
    ['Dev', '919000000013', 'Monthly', istDate(10), 'yes', ''], // not due yet
  );
  const due = await db.membersExpiringOn(target);
  assert.deepStrictEqual(due.map((x) => x.name).sort(), ['Asha', 'Chitra']);
  assert.strictEqual(due.find((x) => x.name === 'Asha').phone, '919000000010');
  await db.markReminded(due.find((x) => x.name === 'Asha').id, target);
  assert.strictEqual(store.tabs.Members[1][5], target);
  assert.deepStrictEqual((await db.membersExpiringOn(target)).map((x) => x.name), ['Chitra'], 'no repeat reminders');

  const memberAud = await db.audience('members');
  assert.deepStrictEqual(memberAud.map((x) => x.name).sort(), ['Asha', 'Chitra', 'Dev']);
  const leadAud = await db.audience('leads');
  assert.ok(leadAud.some((x) => x.phone === '919000000001'));
  assert.ok(leadAud.some((x) => x.phone === '919000000020'));
  assert.ok(!leadAud.some((x) => x.name === 'Bala'));

  // ---- 8. one token for the whole run ----
  assert.strictEqual(store.tokenCalls >= 1 && store.tokenCalls <= 2, true, `token calls: ${store.tokenCalls}`);

  // ---- 9. full conversation on top of the sheet ----
  const fresh = makeFakeGoogle();
  global.fetch = fresh.fakeFetch;
  db = freshSheets();
  const { handleMessage } = require('../src/bot');
  const sent = [];
  const owner = [];
  const deps = { db, send: async (c, t, text) => sent.push(text), notifyOwner: async (t) => owner.push(t) };
  const say = (id, text) => handleMessage({ channel: 'whatsapp', externalId: '919000000555', name: 'Sunil', text, messageId: id }, deps);
  await say('a1', 'hi');
  assert.match(sent.at(-1), /Welcome/);
  for (const [id, text] of [['a2', 'join'], ['a3', 'Sunil Rao'], ['a4', 'weight loss'], ['a5', 'Tuesday 7am'], ['a6', 'yes']]) await say(id, text);
  assert.match(sent.at(-1), /all set/);
  const out = fresh.store.tabs.Leads[1];
  assert.strictEqual(out[1], 'Sunil Rao');
  assert.strictEqual(out[3], 'weight loss');
  assert.strictEqual(out[5], 'trial_requested');
  assert.strictEqual(out[6], 'yes');
  assert.strictEqual(out[7], 'Preferred time: Tuesday 7am');
  assert.strictEqual(owner.length, 1);
  await say('a7', 'stop');
  assert.strictEqual(out[6], 'no');
  assert.strictEqual(fresh.store.tabs.Leads.length, 2, 'one row for the whole conversation');

  console.log('All Sheets tests passed');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
