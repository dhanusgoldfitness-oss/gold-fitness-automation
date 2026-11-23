import test from "node:test";
import assert from "node:assert/strict";
import { build, say, FULL_SETTINGS } from "./helpers.js";
import { ALL_STRINGS, MENU_TITLES, mainMenuText } from "../../src/enquiry-bot/i18n.js";

const sent = (ctx) => ctx.meta.nonImages().map((c) => c.payload);
const last = (ctx) => sent(ctx).at(-1);
const textOf = (p) => p.text?.body || p.interactive?.body?.text || "";

test("Hi shows the complete main menu as an interactive list with View Options and numbered text", async () => {
  const ctx = build();
  await say(ctx, { text: "Hi" });
  const p = last(ctx);
  assert.equal(p.type, "interactive");
  assert.equal(p.interactive.type, "list");
  assert.equal(p.interactive.action.button, "View Options");
  assert.equal(p.interactive.action.sections[0].rows.length, 9);
  const body = p.interactive.body.text;
  assert.match(body, /Welcome to GOLD FITNESS KENGERI 💪/);
  assert.match(body, /Tap View Options or reply with a number\./);
  for (const [i, title] of MENU_TITLES.en.entries()) assert.ok(body.includes(`${i + 1}. ${title}`), `missing ${i + 1}. ${title}`);
  assert.match(body, /Reply 0 for the main menu\./);
  assert.ok(body.includes("9. ಕನ್ನಡ"));
});

test("Hello, Menu and 0 all show the main menu", async () => {
  for (const word of ["Hello", "menu", "0"]) {
    const ctx = build();
    await say(ctx, { text: word });
    assert.equal(last(ctx).interactive.type, "list", word);
  }
});

test("typed number and tapped option do the same thing (membership plans)", async () => {
  const a = build();
  await say(a, { text: "hi" });
  await say(a, { text: "1" });
  const b = build();
  await say(b, { text: "hi" });
  await say(b, { type: "interactive", listId: "menu_1" });
  assert.equal(textOf(sent(a)[1]), textOf(sent(b)[1]));
  assert.match(textOf(sent(a)[1]), /General Fitness – Self-Guided Training[\s\S]*3 months: ₹5,250[\s\S]*6 months: ₹7,350[\s\S]*Annual: ₹9,975[\s\S]*₹500 membership fee/);
  assert.match(textOf(sent(a)[2]), /Open Personal Training/);
});

test("0 returns to the main menu from the PT submenu; typing 1 in the PT submenu opens Silver PT", async () => {
  const ctx = build();
  await say(ctx, { text: "hi" });
  await say(ctx, { text: "4" });
  assert.equal(last(ctx).interactive.type, "button");
  assert.deepEqual(last(ctx).interactive.action.buttons.map((b) => b.reply.id), ["pt_silver", "pt_gold", "pt_3p9"]);
  await say(ctx, { text: "1" });
  assert.match(textOf(sent(ctx).at(-3) ?? sent(ctx).find((p) => /Silver PT/.test(textOf(p)) && p.type === "text")), /Silver PT/);
  const ctx2 = build();
  await say(ctx2, { text: "hi" });
  await say(ctx2, { text: "4" });
  await say(ctx2, { text: "0" });
  assert.equal(last(ctx2).interactive.type, "list");
});

test("typing 1 in the main menu is plans, typing 1 in the PT submenu is Silver PT (menu is remembered per chat)", async () => {
  const ctx = build();
  await say(ctx, { text: "4" }); // main menu, 4 = PT
  await say(ctx, { text: "2" }); // PT menu, 2 = Gold
  const texts = sent(ctx).map(textOf);
  assert.ok(texts.some((x) => /\*Gold PT – 1-to-1 Coaching\*/.test(x)));
  assert.ok(!texts.some((x) => /Membership Plans & Fees\n\n/.test(x)));
});

test("invalid input shows the relevant options for the current menu", async () => {
  const ctx = build();
  await say(ctx, { text: "4" });
  await say(ctx, { text: "banana" });
  const p = sent(ctx);
  assert.match(textOf(p.at(-2)), /Sorry, I didn't get that/);
  assert.equal(p.at(-1).interactive.type, "button"); // PT buttons again, not the main menu
  const ctx2 = build();
  await say(ctx2, { text: "zzz" });
  assert.equal(last(ctx2).interactive.type, "list");
});

test("delivery-status events are never menu input", async () => {
  const ctx = build();
  const body = { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.out1", status: "delivered", timestamp: "1", recipient_id: "919900000001" }] } }] }] };
  const pending = await ctx.engine.ingest(body);
  assert.deepEqual(pending, []);
  assert.equal(ctx.meta.calls.length, 0);
  assert.equal(ctx.store.statuses.length, 1);
});

test("website, Instagram, Facebook/YouTube when configured; both owner WhatsApp links", async () => {
  const ctx = build();
  await say(ctx, { text: "7" });
  const web = textOf(last(ctx));
  assert.ok(web.includes("https://dhanusgoldfitness.com/"));
  assert.ok(web.includes("https://www.instagram.com/gold_fitness_kengeri/"));
  assert.ok(web.includes("Facebook: https://facebook.example/gfk"));
  assert.ok(web.includes("YouTube: https://youtube.example/gfk"));
  await say(ctx, { text: "8" });
  const owner = textOf(last(ctx));
  assert.ok(owner.includes("+91 97400 18911: https://wa.me/919740018911"));
  assert.ok(owner.includes("+91 97421 42166: https://wa.me/919742142166"));
});

test("missing Facebook/YouTube/maps are omitted for the customer and logged for staff", async () => {
  const ctx = build({ settings: {} });
  await say(ctx, { text: "7" });
  const t7 = textOf(last(ctx));
  assert.ok(!/Facebook|YouTube/.test(t7));
  assert.ok(t7.includes("https://dhanusgoldfitness.com/") && t7.includes("https://www.instagram.com/gold_fitness_kengeri/"));
  const keys = ctx.store.missingSettings.map((m) => m.key);
  for (const k of ["facebook", "youtube"]) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes("mapsLink"), "the Google Maps link is now configured");
});

test("a price missing from settings is reported to staff and the customer is told to ask the front desk", async () => {
  const ctx = build({ settings: { plans: { silver: { prices: [] } } } });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  assert.match(textOf(sent(ctx).find((p) => /Silver PT/.test(textOf(p)) && p.type === "text")), /please ask our front desk/);
  assert.ok(ctx.store.missingSettings.some((m) => m.key === "plans.silver.prices"));
});

test("timings & location: exact address, hours and the verified maps link", async () => {
  const ctx = build();
  await say(ctx, { text: "3" });
  const t3 = textOf(last(ctx));
  assert.ok(t3.includes("Monday–Saturday: 5:30 AM–10:00 PM"));
  assert.ok(t3.includes("Sunday: 5:00 PM–9:00 PM"));
  assert.ok(t3.includes("#18 Gold Fitness, Hoysala Circle, Kengeri, Bengaluru – 560060"));
  assert.ok(t3.split("\n").includes("https://maps.app.goo.gl/BV2ETVx4Nt6YEsPJ8"));
});

test("visit request: collects name and slot, saves it, notifies front desk, tells customer staff will confirm", async () => {
  const ctx = build();
  await say(ctx, { text: "2" });
  assert.match(textOf(last(ctx)), /your name/);
  await say(ctx, { text: "Ravi" });
  assert.match(textOf(last(ctx)), /Which day and time/);
  await say(ctx, { text: "tomorrow 6 PM" });
  assert.equal(ctx.store.visits.length, 1);
  assert.equal(ctx.store.visits[0].name, "Ravi");
  assert.equal(ctx.store.visits[0].slot, "tomorrow 6 PM");
  assert.equal(ctx.store.visits[0].status, "requested");
  assert.equal(ctx.notifications.length, 1);
  assert.match(textOf(last(ctx)), /staff will confirm/);
  assert.equal(ctx.store.visits[0].chat, "919900000001");
});

test("a number typed while giving a visit time is data, not a menu choice", async () => {
  const ctx = build();
  await say(ctx, { text: "2" });
  await say(ctx, { text: "Ravi" });
  await say(ctx, { text: "6" });
  assert.equal(ctx.store.visits[0].slot, "6");
  assert.equal(ctx.store.handoffs.length, 0);
});

test("no trial offers anywhere in English or Kannada text, or in any reply", async () => {
  for (const lang of ["en", "kn"]) {
    for (const [k, v] of Object.entries(ALL_STRINGS[lang])) assert.ok(!/trial|ಟ್ರಯಲ್|ಉಚಿತ ಪ್ರಯೋಗ/i.test(v), `${lang}.${k}`);
  }
  const ctx = build();
  for (const s of ["hi", "1", "2", "Ravi", "tomorrow", "3", "4", "1", "7", "8", "9", "1", "4", "2"]) await say(ctx, { text: s });
  for (const p of sent(ctx)) assert.ok(!/trial/i.test(JSON.stringify(p)), JSON.stringify(p));
});

test("'tomorrow trial beku' goes to visit scheduling without offering a trial", async () => {
  const ctx = build();
  await say(ctx, { text: "tomorrow trial beku" });
  assert.match(textOf(last(ctx)), /your name/);
  assert.ok(!/trial/i.test(textOf(last(ctx))));
});

test("'fees estu?' and 'gym elli ide?' route to plans and location without AI", async () => {
  const ctx = build();
  await say(ctx, { text: "fees estu?" });
  assert.match(textOf(sent(ctx)[0]), /Membership Plans & Fees/);
  await say(ctx, { text: "gym elli ide?" });
  assert.ok(textOf(last(ctx)).includes("Hoysala Circle"));
});

test("Kannada: option 9 switches language, shows the Kannada menu, later replies stay Kannada; 9 again returns to English", async () => {
  const ctx = build();
  await say(ctx, { text: "hi" });
  await say(ctx, { text: "9" });
  const menu = last(ctx);
  assert.equal(menu.interactive.type, "list");
  assert.ok(menu.interactive.body.text.includes("ಸ್ವಾಗತ"));
  assert.ok(menu.interactive.action.sections[0].rows.every((r) => r.title.length <= 24));
  await say(ctx, { text: "3" });
  assert.ok(textOf(last(ctx)).includes("ಜಿಮ್ ಸಮಯ"));
  await say(ctx, { text: "9" });
  assert.ok(last(ctx).interactive.body.text.includes("Welcome to GOLD FITNESS KENGERI"));
});

test("every message the bot can build fits WhatsApp limits in both languages", async () => {
  for (const lang of ["en", "kn"]) {
    assert.ok(mainMenuText(lang).length <= 1024);
    for (const title of MENU_TITLES[lang]) assert.ok([...title].length <= 24, title);
  }
  const ctx = build();
  await say(ctx, { text: "9" });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "3" }); // kn PT button 3, interactive client validation would throw otherwise
});

test("staff handoff: creates a record, notifies, and pauses bot replies; STOP still works while paused", async () => {
  const ctx = build();
  await say(ctx, { text: "6" });
  assert.equal(ctx.store.handoffs.length, 1);
  assert.equal(ctx.notifications.at(-1).kind, "handoff");
  const before = ctx.meta.calls.length;
  await say(ctx, { text: "hi" });
  await say(ctx, { text: "1" });
  assert.equal(ctx.meta.calls.length, before, "bot must stay silent while staff handle the chat");
  await say(ctx, { text: "STOP" });
  assert.ok(await ctx.store.isOptedOut("919900000001"));
  assert.equal(ctx.meta.calls.length, before + 1);
});

test("handover period ends: automation resumes", async () => {
  let t = 1_000_000;
  const ctx = build({ clock: () => t });
  await say(ctx, { text: "6" });
  t += 13 * 3600 * 1000;
  await say(ctx, { text: "hi" });
  assert.equal(last(ctx).interactive.type, "list");
});

test("STOP opts out, later messages are ignored, START opts back in", async () => {
  const ctx = build();
  await say(ctx, { text: "stop" });
  assert.ok(await ctx.store.isOptedOut("919900000001"));
  const n = ctx.meta.calls.length;
  await say(ctx, { text: "hi" });
  assert.equal(ctx.meta.calls.length, n);
  await say(ctx, { text: "START" });
  assert.equal(await ctx.store.isOptedOut("919900000001"), false);
  await say(ctx, { text: "hi" });
  assert.equal(last(ctx).interactive.type, "list");
});

test("renewal: private details only after identity verification; unmatched goes to the front desk", async () => {
  const members = { find: async ({ phone, memberCode }) => (phone.endsWith("9900000001") && memberCode === "GFK-100" ? { name: "Asha", plan: "Quarterly", expiry: "30 Nov 2026" } : null) };
  const ctx = build({ members });
  await say(ctx, { text: "5" });
  assert.ok(!/Quarterly|30 Nov/.test(textOf(last(ctx))), "no private data before verification");
  await say(ctx, { text: "GFK-100" });
  assert.match(textOf(last(ctx)), /Quarterly/);
  await say(ctx, { type: "interactive", buttonId: "renew_request" });
  assert.equal(ctx.store.handoffs.at(-1).reason, "renewal_request");

  const ctx2 = build({ members });
  await say(ctx2, { text: "5" });
  await say(ctx2, { text: "WRONG" });
  assert.equal(ctx2.store.handoffs.at(-1).reason, "renewal_unmatched");
  assert.ok(!/Quarterly/.test(textOf(last(ctx2))));
});

test("simulated old trial wording from earlier flows is absent from settings defaults too", async () => {
  const ctx = build();
  assert.ok(!/trial/i.test(JSON.stringify(await ctx.bot.settings.get())));
});

test("Gym Timings & Location: LOCATION, typed 3 and the tapped option all give the same one reply (English), and the Kannada reply uses the same Maps link", async () => {
  const ctx = build();
  const URL_ = "https://maps.app.goo.gl/BV2ETVx4Nt6YEsPJ8";
  const want = ["📍 GOLD FITNESS KENGERI", "#18 Gold Fitness, Hoysala Circle, Kengeri, Bengaluru – 560060", "🗺️ Tap for Google Maps directions:", URL_, "🕒 Gym Hours", "Monday–Saturday: 5:30 AM–10:00 PM", "Sunday: 5:00 PM–9:00 PM", "Reply 0 for the main menu."];
  const bodies = [];
    const real = build({ settings: {} });
  for (const input of [{ text: "LOCATION" }, { text: " location " }, { text: "3" }, { listId: "menu_3", type: "interactive" }]) {
    real.meta.calls.length = 0;
    await say(real, { from: "919911000001", text: "hi" }); // opens the menu so "3" reads against it
    real.meta.calls.length = 0;
    await say(real, { from: "919911000001", ...input });
    assert.equal(real.meta.calls.length, 1, `one reply for ${JSON.stringify(input)}`);
    bodies.push(real.meta.calls[0].payload.text.body);
  }
  for (const b of bodies) {
    assert.deepEqual(b.split("\n").filter((l) => l.trim()), want);
    assert.ok(b.split("\n").includes(URL_), "URL alone on its own line");
  }
  assert.equal(new Set(bodies).size, 1);
  await say(real, { from: "919911000002", text: "hi" });
  await say(real, { from: "919911000002", listId: "menu_9", type: "interactive" }); // Kannada
  real.meta.calls.length = 0;
  await say(real, { from: "919911000002", text: "3" });
  const kn = real.meta.calls[0].payload.text.body;
  assert.ok(kn.split("\n").includes(URL_));
  assert.match(kn, /ಜಿಮ್ ಸಮಯ/);
  assert.match(kn, /ಮುಖ್ಯ ಮೆನುಗಾಗಿ 0/);
});
