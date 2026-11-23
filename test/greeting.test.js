// Webhook-level tests for the live keyword responder: greetings, menu, numbered replies and shortcuts, with mocked sends.
const assert = require('assert');
const crypto = require('crypto');
process.env.VERIFY_TOKEN = 'v';
process.env.META_APP_SECRET = 'secret';
const { createApp } = require('../src/server');

function fakeDb() {
  const s = { leads: [], messages: [], nextId: 1 };
  return {
    s,
    async getLead(c, e) { return s.leads.find((l) => l.channel === c && l.external_id === e) || null; },
    async createLead(l) { const r = { id: s.nextId++, booked: false, needs_human: false, last_seen_before: false, ...l }; s.leads.push(r); return r; },
    async updateLead(id, p) { return Object.assign(s.leads.find((l) => l.id === id), p); },
    async logMessage(m) { if (m.message_id && s.messages.some((x) => x.message_id === m.message_id)) return false; s.messages.push(m); return true; },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (b) => 'sha256=' + crypto.createHmac('sha256', 'secret').update(b).digest('hex');
let n = 0;

async function harness({ listFails = false } = {}) {
  const db = fakeDb();
  const out = [];
  const owner = [];
  const app = createApp({
    db,
    send: async (channel, to, body) => out.push({ kind: 'text', body }),
    sendList: async (to, list) => { if (listFails) throw new Error('list refused'); out.push({ kind: 'list', ...list }); },
    sendButtons: async (to, b) => out.push({ kind: 'buttons', ...b }),
    notifyOwner: async (t) => owner.push(t),
    enquiryEngine: null,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const say = async (text, extra = {}) => {
    const before = out.length;
    const msg = { from: '919845012345', id: `wamid.${++n}`, type: 'text', text: { body: text }, ...extra };
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: [{ wa_id: msg.from, profile: { name: 'Asha' } }], messages: [msg] } }] }] });
    const r = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
    assert.strictEqual(r.status, 200);
    await sleep(60);
    return out.slice(before);
  };
  return { say, out, owner, db, close: () => server.close() };
}
const OLD = /Sorry, I didn't get that|PRICE, TIMINGS, LOCATION, JOIN or HUMAN/;
const ROW_TITLES = ['Membership Plans & Fees', 'Schedule a Gym Visit', 'Gym Timings & Location', 'Personal Training', 'Membership Renewal', 'Talk to the Front Desk', 'Website & Social Media', 'Talk to the Gym Owner', 'ಕನ್ನಡ'];

(async () => {
  const h = await harness();
  await h.say('hi'); // first contact
  // Hi, Hello, HI and " hello " on a returning contact: exactly one list menu each, never the old fallback.
  for (const g of ['Hi', 'Hello', 'HI', ' hello ', 'Hey', 'Menu', '0', 'hii!']) {
    const got = await h.say(g);
    assert.strictEqual(got.length, 1, `"${g}" must produce exactly one message, got ${got.length}`);
    assert.strictEqual(got[0].kind, 'list', g);
    assert.match(got[0].body, /Welcome to GOLD FITNESS KENGERI 💪\nTap View Options or reply with a number\./);
    assert.match(got[0].body, /Reply 0 to return to the main menu\./);
    assert.strictEqual(got[0].button, 'View Options');
    assert.deepStrictEqual(got[0].rows.map((r) => r.title), ROW_TITLES);
    assert.ok(got[0].rows.every((r) => r.title.length <= 24), 'WhatsApp row titles are limited to 24 characters');
    assert.doesNotMatch(JSON.stringify(got), OLD);
  }

  // Shortcuts keep working.
  let got = await h.say('PRICE');
  assert.match(got[0].body, /5,250/);
  assert.strictEqual(got.length, 1);
  const EXPECTED_LOCATION = [
    '📍 GOLD FITNESS KENGERI',
    '#18 Gold Fitness, Hoysala Circle, Kengeri, Bengaluru – 560060',
    '🗺️ Tap for Google Maps directions:',
    'https://maps.app.goo.gl/BV2ETVx4Nt6YEsPJ8',
    '🕒 Gym Hours',
    'Monday–Saturday: 5:30 AM–10:00 PM',
    'Sunday: 5:00 PM–9:00 PM',
    'Reply 0 for the main menu.',
  ];
  const checkLocation = (got, how) => {
    assert.strictEqual(got.length, 1, `${how}: exactly one reply`);
    const lines = got[0].body.split('\n');
    for (const l of EXPECTED_LOCATION) assert.ok(lines.includes(l), `${how}: missing line "${l}"`);
    assert.ok(lines.includes('https://maps.app.goo.gl/BV2ETVx4Nt6YEsPJ8'), `${how}: URL alone on its own line`);
  };
  checkLocation(await h.say('timings'), 'TIMINGS');
  checkLocation(await h.say('LOCATION'), 'LOCATION');
  checkLocation(await h.say('location'), 'location (lower case)');
  checkLocation(await h.say(' Location '), ' Location  (spaces)');
  checkLocation(await h.say('3'), 'typed 3');
  checkLocation(await h.say('', { type: 'interactive', text: undefined, interactive: { type: 'list_reply', list_reply: { id: 'menu_3', title: 'Gym Timings & Location' } } }), 'tapped Gym Timings & Location');

  // 4 -> PT submenu (buttons), 1/2/3 -> packages, 0 -> main menu.
  got = await h.say('4');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].kind, 'buttons');
  assert.deepStrictEqual(got[0].buttons.map((b) => b.title), ['Silver PT', 'Gold PT', '3+9 Package']);
  got = await h.say('1');
  assert.match(got[0].body, /Silver PT – Group Guidance/);
  assert.match(got[0].body, /5,775/);
  got = await h.say('3');
  assert.match(got[0].body, /3\+9 Package/);
  assert.match(got[0].body, /3 months of basic verbal training instruction and gym orientation \+ 9 months of General Fitness/);
  got = await h.say('0');
  assert.strictEqual(got[0].kind, 'list');

  // Numbers on the main menu.
  assert.match((await h.say('1'))[0].body, /5,250/);
  assert.match((await h.say('7'))[0].body, /dhanusgoldfitness\.com/);
  assert.match((await h.say('8'))[0].body, /97400 18911[\s\S]*97421 42166/);

  // Tapping a list row / PT button arrives as an interactive reply and behaves like the number.
  got = await h.say('', { type: 'interactive', text: undefined, interactive: { type: 'list_reply', list_reply: { id: 'menu_4', title: 'Personal Training' } } });
  assert.strictEqual(got[0].kind, 'buttons');
  got = await h.say('', { type: 'interactive', text: undefined, interactive: { type: 'button_reply', button_reply: { id: 'pt_gold', title: 'Gold PT' } } });
  assert.match(got[0].body, /Gold PT/);

  // Join flow still works from option 2; HUMAN hands off; STOP opts out.
  await h.say('0');
  got = await h.say('2');
  assert.match(got[0].body, /name/i);
  got = await h.say('Hi'); // greeting mid-flow returns to the menu
  assert.strictEqual(got[0].kind, 'list');
  await h.say('HUMAN');
  assert.strictEqual(h.owner.length, 1);
  got = await h.say('STOP');
  assert.match(got[0].body, /unsubscribed/);
  assert.strictEqual(h.db.s.leads[0].opt_in, false);

  // Unrecognized input: "Reply MENU ..." and the menu again; no old fallback text.
  got = await h.say('asdfgh qwerty');
  assert.strictEqual(got.length, 2);
  assert.match(got[0].body, /Reply MENU to see your options/);
  assert.strictEqual(got[1].kind, 'list');
  assert.doesNotMatch(JSON.stringify(got), OLD);
  h.close();

  // If the interactive list cannot be sent, the numbered text menu is sent instead (still exactly one menu).
  const t = await harness({ listFails: true });
  await t.say('hi');
  got = await t.say('Hello');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].kind, 'text');
  for (const line of ['1. Membership Plans & Fees', '4. Personal Training — Silver PT, Gold PT, and 3+9', '9. ಕನ್ನಡ', 'Reply 0 to return to the main menu.']) assert.ok(got[0].body.includes(line), line);
  t.close();
  console.log('greeting tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
