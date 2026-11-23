// Enquiry capture + scheduled messages. Everything is mocked: no Meta, Supabase or Cloudinary call is ever made.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MemoryPeopleStore } from "../../src/enquiry-bot/people-store.js";
import { PeopleService } from "../../src/enquiry-bot/people.js";
import { Campaigns, CAMPAIGNS } from "../../src/enquiry-bot/campaigns.js";
import { SchedAdmin } from "../../src/enquiry-bot/admin.js";
import { MetaError } from "../../src/enquiry-bot/whatsapp.js";
import { TEMPLATES } from "../../src/enquiry-bot/templates.js";
import { istParts, isBirthdayToday, parseBirthday } from "../../src/enquiry-bot/ist.js";
import { normalizeIndianMobile } from "../../src/enquiry-bot/phone.js";
import { createEnquiryEngine } from "../../src/enquiry-bot/factory.js";
import { build, say } from "./helpers.js";

const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));
const FIXED = readJson("../../src/enquiry-bot/config/calendar-fixed.json").fixed;
const SEED = readJson("../../src/enquiry-bot/config/motivation-seed.json").messages;

/** IST wall-clock -> epoch ms. */
const ist = (date, hm = "00:00") => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - 330 * 60000;
};
const P1 = "919876543210";
const P2 = "919876500002";
const P3 = "919876500003";

function rig({ start = ist("2026-11-25", "06:00"), tpl = {}, legacyRules = [] } = {}) {
  const clock = { t: start };
  const now = () => clock.t;
  const store = new MemoryPeopleStore();
  store.legacyRules = legacyRules;
  const sends = [];
  let n = 0;
  const behavior = { next: null };
  const client = {
    async sendTemplate(to, name, lang, params) {
      if (behavior.next) { const e = behavior.next; behavior.next = null; throw e; }
      sends.push({ to, name, lang, params });
      return { id: `wamid.s${++n}`, acceptedAt: clock.t };
    },
  };
  const status = { ...tpl };
  const templateStatus = async (name, lang) => status[`${name}:${lang}`] || { status: "APPROVED", category: TEMPLATES[name].category };
  const mk = () => new Campaigns({ store, client, templateStatus, now, fixedEvents: FIXED, statusTtlMs: 0, rates: {} });
  const campaigns = mk();
  const people = new PeopleService({ store, now });
  const admin = new SchedAdmin({ campaigns, store, authorized: "919742142166", seedMessages: SEED, now });
  return { clock, store, sends, client, campaigns, people, admin, status, behavior, mk };
}
const approveSeed = async (r) => { for (const m of SEED) await r.store.saveMotivation({ ...m, approved: true }); };
const enable = async (r, key) => { await r.campaigns.preview(key, r.clock.t); const res = await r.campaigns.enable(key); assert.equal(res.ok, true, JSON.stringify(res)); };
const person = async (r, phone, { name = "Ravi", lang = "en", motivation, birthday, festival, weekly } = {}) => {
  await r.people.captureEnquiry({ phone, name, language: lang });
  if (motivation) await r.people.setMotivation(phone, motivation);
  if (birthday) await r.people.setBirthday(phone, birthday);
  if (festival) await r.people.setFestival(phone, true);
  if (weekly) await r.store.savePrefs(phone, weekly);
};

// ------------------------------------------------------------------------------------------------ enquiry capture
test("enquiry: same person in any phone format is one lead; staff-entered data is never overwritten", async () => {
  const r = rig();
  const a = await r.people.captureEnquiry({ phone: "+91 98765 43210", source: "WhatsApp bot", language: "en" });
  assert.equal(a.created, true);
  assert.equal(a.lead.mobile, P1);
  assert.equal(a.lead.status, "New");
  assert.equal(a.lead.follow_up_status, "pending");
  assert.equal(a.lead.follow_up_date, "2026-11-25");
  assert.match(a.lead.name, /WhatsApp enquiry 3210/);
  const b = await r.people.captureEnquiry({ phone: "09876543210", name: "Ravi Kumar", packageName: "Gold PT", interest: "Personal Training" });
  assert.equal(b.created, false);
  assert.equal(r.store.leads.length, 1);
  assert.equal(r.store.leads[0].name, "Ravi Kumar", "placeholder name replaced once the customer shares it");
  assert.equal(r.store.leads[0].package_name, "Gold PT");
  r.store.leads[0].name = "Ravi K (front desk)";
  r.store.leads[0].package_name = "Silver PT";
  r.store.leads[0].lead_stage = "Visit Scheduled";
  await r.people.captureEnquiry({ phone: P1, name: "Someone Else", packageName: "3+9 Package" });
  assert.equal(r.store.leads[0].name, "Ravi K (front desk)");
  assert.equal(r.store.leads[0].package_name, "Silver PT");
  assert.equal(r.store.leads[0].lead_stage, "Visit Scheduled");
  assert.equal(r.store.leads.length, 1);
});

test("enquiry: an invalid number is rejected and nothing is created", async () => {
  const r = rig();
  assert.equal((await r.people.captureEnquiry({ phone: "12345" })).ok, false);
  assert.equal(r.store.leads.length, 0);
  assert.equal(normalizeIndianMobile("+91 98765 43210"), P1);
  assert.equal(normalizeIndianMobile("5876543210"), null);
});

test("lead to member: the member record is preserved and the enquiry is linked to it", async () => {
  const r = rig();
  const member = { id: "m1", name: "Asha Rao", member_code: "GFK-101", status: "Active", phone: "98765-43210" };
  r.store.members.push(member);
  const before = structuredClone(member);
  const res = await r.people.captureEnquiry({ phone: P1, name: "Asha", packageName: "Gold PT" });
  assert.deepEqual(r.store.members[0], before, "member untouched");
  assert.equal(res.prefs.member_id, "m1");
  assert.equal(res.prefs.lead_id, res.lead.id);
  assert.match(res.lead.notes, /Existing member: Asha Rao GFK-101/);
  await r.people.captureEnquiry({ phone: P1 });
  assert.equal(r.store.leads.length, 1, "no duplicate enquiry");
});

test("lead who later becomes a member keeps preferences and STOP", async () => {
  const r = rig();
  await person(r, P1, { motivation: "daily", festival: true });
  await r.people.stop(P1);
  r.store.members.push({ id: "m9", name: "Ravi", status: "Active", phone: "9876543210" });
  const again = await r.people.captureEnquiry({ phone: P1 });
  assert.equal(again.prefs.member_id, "m9");
  assert.ok(again.prefs.stopped_at, "STOP survives the link");
  assert.equal((await r.people.summary(P1)).motivation, "off");
  await r.people.start(P1);
  const s = await r.people.summary(P1);
  assert.equal(s.stopped, false);
  assert.equal(s.motivation, "off", "START does not silently turn preferences back on");
});

test("consent is recorded per scope with source and timestamp", async () => {
  const r = rig();
  await r.people.captureEnquiry({ phone: P1 });
  await r.people.setMotivation(P1, "weekly", "whatsapp_bot");
  await r.people.setBirthday(P1, { month: 8, day: 15 });
  await r.people.setFestival(P1, true);
  const scopes = r.store.consentLog.map((c) => c.scope);
  assert.deepEqual(scopes, ["motivation", "birthday", "festival"]);
  for (const c of r.store.consentLog) { assert.ok(c.source); assert.ok(c.at); }
  assert.equal((await r.store.getPrefs(P1)).consent.motivation.value, "weekly");
  assert.equal((await r.people.setBirthday(P1, { month: 2, day: 30 })).ok, false);
  assert.equal((await r.store.getPrefs(P1)).birth_day, 15, "an invalid date changes nothing");
});

test("birthday parsing stores only day and month", () => {
  assert.deepEqual(parseBirthday("15 Aug"), { month: 8, day: 15 });
  assert.deepEqual(parseBirthday("August 15th"), { month: 8, day: 15 });
  assert.deepEqual(parseBirthday("15/08"), { month: 8, day: 15 });
  assert.deepEqual(parseBirthday("29 feb"), { month: 2, day: 29 });
  assert.equal(parseBirthday("31 feb"), null);
  assert.equal(parseBirthday("tomorrow"), null);
});

// ------------------------------------------------------------------------------------------------ bot flow
test("bot: Hi shows the menu immediately; the enquiry is captured after the reply, not before", async () => {
  const ctx = build();
  const store = new MemoryPeopleStore();
  const people = new PeopleService({ store, now: ctx.now });
  ctx.bot.people = people;
  ctx.engine.people = people;
  let capturedBeforeReply = null;
  const origSend = ctx.client.sendList.bind(ctx.client);
  ctx.client.sendList = async (...a) => { capturedBeforeReply = store.leads.length; return origSend(...a); };
  await say(ctx, { from: "919900000001", text: "Hi", name: "Asha" });
  assert.equal(capturedBeforeReply, 0, "menu went out before any enquiry write");
  assert.equal(ctx.meta.calls[0].payload.type, "interactive");
  assert.equal(store.leads.length, 1);
  assert.equal(store.leads[0].name, "Asha");
  assert.equal(store.leads[0].source, "WhatsApp bot");
  await say(ctx, { from: "919900000001", text: "Hello", name: "Asha" });
  assert.equal(store.leads.length, 1, "second message does not duplicate");
});

test("bot: looking at Personal Training records the interested package; no details are asked", async () => {
  const ctx = build();
  const store = new MemoryPeopleStore();
  ctx.bot.people = ctx.engine.people = new PeopleService({ store, now: ctx.now });
  await say(ctx, { from: "919900000001", text: "Hi" });
  await say(ctx, { from: "919900000001", text: "4" });
  await say(ctx, { from: "919900000001", text: "2" });
  assert.equal(store.leads[0].package_name, "Gold PT");
  assert.equal(store.leads[0].interest, "Personal Training");
  assert.ok(!ctx.meta.calls.some((c) => /birthday/i.test(JSON.stringify(c.payload))), "birthday is not asked during a PT enquiry");
});

test("bot: a visit request shares the name and then offers the optional birthday", async () => {
  const ctx = build();
  const store = new MemoryPeopleStore();
  ctx.bot.people = ctx.engine.people = new PeopleService({ store, now: ctx.now });
  const from = "919900000001";
  await say(ctx, { from, text: "Hi" });
  await say(ctx, { from, text: "2" });
  await say(ctx, { from, text: "Meena Iyer" });
  const before = ctx.meta.calls.length;
  await say(ctx, { from, text: "Tomorrow 7 AM" });
  const bodies = ctx.meta.calls.slice(before).map((c) => c.payload.text?.body || "");
  assert.ok(bodies.some((b) => /BIRTHDAY 15 Aug/.test(b)), "optional birthday offered");
  assert.equal(store.leads[0].name, "Meena Iyer");
});

test("bot: preferences by typed commands and buttons; STOP blocks changes until START", async () => {
  const ctx = build();
  const store = new MemoryPeopleStore();
  const people = new PeopleService({ store, now: ctx.now });
  ctx.bot.people = ctx.engine.people = people;
  ctx.engine.repliesAfterStop = true; // production behaviour: a stopped customer can still message and get answers
  ctx.store.isOptedOut = async () => false;
  const from = "919900000001";
  const lastBodies = (from0) => ctx.meta.calls.slice(from0).map((c) => c.payload.text?.body || c.payload.interactive?.body?.text || "");
  let i = ctx.meta.calls.length;
  await say(ctx, { from, text: "UPDATES" });
  assert.ok(ctx.meta.calls.slice(i).some((c) => c.payload.interactive?.action?.buttons?.length === 3), "motivation buttons shown");
  await say(ctx, { from, type: "interactive", buttonId: "pref_mot_daily" });
  assert.equal((await people.summary(from)).motivation, "daily");
  i = ctx.meta.calls.length;
  await say(ctx, { from, text: "birthday 15 aug" });
  assert.match(lastBodies(i).join(" "), /15\/8/);
  assert.equal((await people.summary(from)).birthday, true);
  i = ctx.meta.calls.length;
  await say(ctx, { from, text: "birthday 31 feb" });
  assert.match(lastBodies(i).join(" "), /could not read/);
  await say(ctx, { from, text: "festival on" });
  assert.equal((await people.summary(from)).festival, true);
  await say(ctx, { from, text: "STOP" });
  assert.equal((await people.summary(from)).stopped, true);
  assert.equal((await people.summary(from)).motivation, "off");
  i = ctx.meta.calls.length;
  await say(ctx, { from, text: "motivation daily" });
  assert.match(lastBodies(i).join(" "), /START first/);
  assert.equal((await people.summary(from)).motivation, "off");
  await say(ctx, { from, text: "START" });
  assert.equal((await people.summary(from)).stopped, false);
});

test("bot: typing a name that starts with 'birthday' inside the visit flow is not treated as a command", async () => {
  const ctx = build();
  const store = new MemoryPeopleStore();
  ctx.bot.people = ctx.engine.people = new PeopleService({ store, now: ctx.now });
  const from = "919900000001";
  await say(ctx, { from, text: "Hi" });
  await say(ctx, { from, text: "2" });
  await say(ctx, { from, text: "Birthday Boy" });
  const prefs = await store.getPrefs(from);
  assert.equal(prefs.birthday_wishes, false);
});

test("capture and scheduler are off unless explicitly switched on", async () => {
  const base = { ENQUIRY_BOT: "on", WA_ACCESS_TOKEN: "t", WA_PHONE_NUMBER_ID: "1", BOT_SUPABASE_URL: "https://x.supabase.co", BOT_SUPABASE_SERVICE_KEY: "k" };
  const e1 = createEnquiryEngine({ env: base, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "[]", json: async () => ({}) }), log: () => {} });
  assert.equal(e1.people, null);
  assert.equal(e1.campaigns, null);
  const e2 = createEnquiryEngine({ env: { ...base, ENQUIRY_CAPTURE: "on" }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "[]", json: async () => ({}) }), log: () => {} });
  assert.ok(e2.people);
  assert.equal(e2.campaigns, null);
  const e3 = createEnquiryEngine({ env: { ...base, ENQUIRY_CAPTURE: "on", ENQUIRY_SCHEDULER: "on" }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "[]", json: async () => ({}) }), log: () => {} });
  assert.ok(e3.campaigns);
  assert.equal((await e3.campaigns.config("motivation_daily")).enabled, false, "every campaign starts disabled");
});

// ------------------------------------------------------------------------------------------------ campaigns: enable guards
test("a campaign with a missing, pending or wrongly-categorised template cannot be enabled", async () => {
  const r = rig();
  await approveSeed(r);
  r.status["gfk_daily_motivation:kn"] = { status: "PENDING", category: "MARKETING" };
  let p = await r.campaigns.preview("motivation_daily", r.clock.t);
  assert.equal(p.canEnable, false);
  assert.match(p.blockers.join(" "), /gfk_daily_motivation \(kn\) is PENDING/);
  assert.equal((await r.campaigns.enable("motivation_daily")).ok, false);
  r.status["gfk_daily_motivation:kn"] = { status: "MISSING" };
  assert.match((await r.campaigns.enable("motivation_daily")).blockers.join(" "), /MISSING/);
  r.status["gfk_daily_motivation:kn"] = { status: "APPROVED", category: "UTILITY" };
  assert.match((await r.campaigns.enable("motivation_daily")).blockers.join(" "), /approved as UTILITY, expected MARKETING/);
  r.status["gfk_daily_motivation:kn"] = { status: "APPROVED", category: "MARKETING" };
  await enable(r, "motivation_daily");
  assert.equal((await r.campaigns.config("motivation_daily")).enabled, true);
});

test("unknown template status (no Meta access) keeps every campaign disabled", async () => {
  const r = rig();
  const c = new Campaigns({ store: r.store, client: r.client, now: () => r.clock.t, fixedEvents: FIXED }); // default provider => UNKNOWN
  for (const k of Object.keys(CAMPAIGNS)) assert.equal((await c.enable(k)).ok, false);
});

test("enabling needs a preview, and a changed message set needs a fresh one", async () => {
  const r = rig();
  await approveSeed(r);
  assert.equal((await r.campaigns.enable("motivation_daily")).reason, "preview_required");
  await r.campaigns.preview("motivation_daily", r.clock.t);
  await r.store.saveMotivation({ id: "mot-en-new", lang: "en", category: "workout", text: "A brand new approved line for today.", approved: true });
  assert.equal((await r.campaigns.enable("motivation_daily")).reason, "preview_required", "approved set changed after the preview");
  await r.campaigns.preview("motivation_daily", r.clock.t);
  assert.equal((await r.campaigns.enable("motivation_daily")).ok, true);
});

test("preview shows message, audience count, skipped reasons and cost only when a rate is known", async () => {
  const r = rig();
  await approveSeed(r);
  await person(r, P1, { motivation: "daily" });
  await person(r, P2, { motivation: "daily", lang: "kn" });
  await person(r, P3, { motivation: "daily" });
  await r.people.stop(P3);
  const p = await r.campaigns.preview("motivation_daily", r.clock.t);
  assert.equal(p.audienceToday, 2);
  assert.equal(p.skipped.stopped, 1);
  assert.match(p.sample.en, /Good morning, Ravi/);
  assert.match(p.sample.kn, /ಶುಭೋದಯ/);
  assert.equal(p.cost.available, false);
  assert.equal(p.enabled, false);
  r.campaigns.rates = { MARKETING: 0.78 };
  assert.deepEqual((await r.campaigns.preview("motivation_daily", r.clock.t)).cost, { available: true, category: "MARKETING", currency: "INR", perMessage: 0.78, total: 1.56 });
  assert.equal(r.sends.length, 0, "previewing sends nothing");
});

test("birthday campaign refuses to enable while the ERP scheduler's birthday rule is active", async () => {
  const r = rig({ legacyRules: ["birthday"] });
  const p = await r.campaigns.preview("birthday", r.clock.t);
  assert.match(p.blockers.join(" "), /ERP scheduler's "birthday" rule is still active/);
  assert.equal((await r.campaigns.enable("birthday")).ok, false);
});

// ------------------------------------------------------------------------------------------------ IST scheduling
test("daily motivation: 07:00 IST default, nothing before, once per day, English and Kannada", async () => {
  const r = rig({ start: ist("2026-11-25", "06:30") });
  await approveSeed(r);
  await person(r, P1, { motivation: "daily" });
  await person(r, P2, { motivation: "daily", lang: "kn" });
  await person(r, P3, { motivation: "off" });
  await enable(r, "motivation_daily");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0, "06:30 IST: too early");
  r.clock.t = ist("2026-11-25", "06:59");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
  r.clock.t = ist("2026-11-25", "07:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 2);
  assert.deepEqual(r.sends.map((s) => s.lang).sort(), ["en", "kn"]);
  assert.ok(r.sends.every((s) => s.name === "gfk_daily_motivation"));
  assert.ok(!r.sends.some((s) => s.to === P3), "opted-out person gets nothing");
  const kn = r.sends.find((s) => s.lang === "kn");
  assert.match(kn.params[1], /[ಀ-೿]/, "Kannada message for a Kannada subscriber");
  for (const t of [ist("2026-11-25", "07:01"), ist("2026-11-25", "12:00"), ist("2026-11-25", "23:59")]) { r.clock.t = t; await r.campaigns.tick(t); }
  assert.equal(r.sends.length, 2, "never twice on the same IST day");
  r.clock.t = ist("2026-11-26", "07:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 4, "next IST day sends again");
});

test("IST day boundary: 23:00 UTC is already tomorrow in India", async () => {
  const utc = Date.UTC(2026, 10, 24, 23, 0); // 2026-11-24 23:00 UTC = 2026-11-25 04:30 IST
  assert.equal(istParts(utc).date, "2026-11-25");
  assert.equal(istParts(Date.UTC(2026, 10, 25, 18, 29)).date, "2026-11-25");
  assert.equal(istParts(Date.UTC(2026, 10, 25, 18, 30)).date, "2026-11-26");
  const r = rig({ start: utc });
  await approveSeed(r);
  await person(r, P1, { motivation: "daily" });
  await enable(r, "motivation_daily");
  r.clock.t = Date.UTC(2026, 10, 25, 1, 30); // 07:00 IST on the 25th
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 1);
});

test("owner can edit the send time; it applies from the next occurrence", async () => {
  const r = rig({ start: ist("2026-11-25", "05:00") });
  await approveSeed(r);
  await person(r, P1, { motivation: "daily" });
  await enable(r, "motivation_daily");
  assert.equal((await r.campaigns.setTime("motivation_daily", "6:15")).time, "06:15");
  assert.equal((await r.campaigns.setTime("motivation_daily", "25:00")).ok, false);
  r.clock.t = ist("2026-11-25", "06:14");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
  r.clock.t = ist("2026-11-25", "06:15");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 1);
});

test("weekly subscribers use their own weekday; one message per ISO week", async () => {
  const r = rig({ start: ist("2026-11-23", "06:00") }); // Monday
  await approveSeed(r);
  await person(r, P1, { motivation: "weekly" }); // default Monday
  await person(r, P2, { motivation: "weekly", weekly: { weekly_dow: 3, weekly_time: "18:30" } }); // Wednesday evening
  await enable(r, "motivation_weekly");
  r.clock.t = ist("2026-11-23", "07:00");
  await r.campaigns.tick(r.clock.t);
  assert.deepEqual(r.sends.map((s) => s.to), [P1]);
  r.clock.t = ist("2026-11-25", "07:30");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 1, "Wednesday subscriber not before 18:30");
  r.clock.t = ist("2026-11-25", "18:30");
  await r.campaigns.tick(r.clock.t);
  assert.deepEqual(r.sends.map((s) => s.to), [P1, P2]);
  assert.ok(r.sends.every((s) => s.name === "gfk_weekly_motivation"));
  r.clock.t = ist("2026-11-30", "07:00"); // next Monday = new ISO week
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.filter((s) => s.to === P1).length, 2);
});

test("no back-fill: enabling at 10:00 does not send the 07:00 occurrence", async () => {
  const r = rig({ start: ist("2026-11-25", "10:00") });
  await approveSeed(r);
  await person(r, P1, { motivation: "daily" });
  await enable(r, "motivation_daily");
  const t = await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
  assert.equal(t.planned.beforeEnable, 1);
});

test("a missed occurrence inside its grace window is sent late, outside it is dropped", async () => {
  const r = rig({ start: ist("2026-11-25", "05:00") });
  await approveSeed(r);
  await person(r, P1, { motivation: "daily" });
  await enable(r, "motivation_daily");
  r.clock.t = ist("2026-11-25", "08:30"); // worker was down 07:00-08:30; grace is 3 h
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 1);
  const r2 = rig({ start: ist("2026-11-25", "05:00") });
  await approveSeed(r2);
  await person(r2, P1, { motivation: "daily" });
  await enable(r2, "motivation_daily");
  r2.clock.t = ist("2026-11-25", "11:00"); // 4 h late
  const out = await r2.campaigns.tick(r2.clock.t);
  assert.equal(r2.sends.length, 0);
  assert.equal(out.planned.tooLate, 1);
});

test("motivation rotation is deterministic, uses approved messages only and the person's language", async () => {
  const r = rig({ start: ist("2026-11-25", "06:00") });
  for (const m of SEED) await r.store.saveMotivation({ ...m, approved: m.lang === "en" && m.category === "workout" });
  await person(r, P1, { motivation: "daily" });
  await person(r, P2, { motivation: "daily", lang: "kn" });
  await enable(r, "motivation_daily").catch(() => {});
  assert.equal((await r.campaigns.enable("motivation_daily")).ok, false, "no approved Kannada message -> cannot enable");
  const aud = await r.campaigns.audience("motivation_daily", ist("2026-11-25", "07:00"));
  assert.equal(aud.items.length, 1);
  assert.equal(aud.skipped.no_approved_message, 1);
  const again = await r.campaigns.audience("motivation_daily", ist("2026-11-25", "07:00"));
  assert.deepEqual(again.items[0].params, aud.items[0].params);
  assert.ok(SEED.filter((m) => m.lang === "en" && m.category === "workout").some((m) => m.text === aud.items[0].params[1]));
});

test("seeded drafts are all unapproved until the owner approves them", async () => {
  const r = rig();
  const reply = await r.admin.run("SCHED MSG SEED");
  assert.match(reply, /Loaded 18 draft messages/);
  assert.ok((await r.store.listMotivation()).every((m) => m.approved === false));
  assert.match(await r.admin.run("SCHED MSG APPROVE mot-en-w1"), /APPROVED/);
  assert.equal((await r.store.listMotivation()).filter((m) => m.approved).length, 1);
});

// ------------------------------------------------------------------------------------------------ birthdays
test("birthday: 29 Feb is celebrated on 28 Feb in non-leap years and on 29 Feb in leap years", () => {
  assert.equal(isBirthdayToday(2, 29, istParts(ist("2027-02-28", "09:00"))), true);
  assert.equal(isBirthdayToday(2, 29, istParts(ist("2027-03-01", "09:00"))), false);
  assert.equal(isBirthdayToday(2, 29, istParts(ist("2028-02-28", "09:00"))), false);
  assert.equal(isBirthdayToday(2, 29, istParts(ist("2028-02-29", "09:00"))), true);
  assert.equal(isBirthdayToday(2, 28, istParts(ist("2027-02-28", "09:00"))), true);
  assert.equal(isBirthdayToday(null, null, istParts(ist("2027-02-28"))), false);
});

test("birthday: once per person per year, at 09:00 IST, with the person's first name", async () => {
  const r = rig({ start: ist("2026-12-24", "08:00") });
  await person(r, P1, { name: "Ravi Kumar", birthday: { month: 12, day: 25 } });
  await person(r, P2, { name: "Meena", birthday: { month: 12, day: 26 } });
  await enable(r, "birthday");
  r.clock.t = ist("2026-12-25", "08:59");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
  r.clock.t = ist("2026-12-25", "09:00");
  await r.campaigns.tick(r.clock.t);
  assert.deepEqual(r.sends.map((s) => [s.to, s.params[0]]), [[P1, "Ravi"]]);
  for (const hm of ["09:30", "15:00", "23:00"]) { r.clock.t = ist("2026-12-25", hm); await r.campaigns.tick(r.clock.t); }
  assert.equal(r.sends.length, 1);
  assert.equal((await r.store.queueFor("birthday")).filter((q) => q.phone === P1).length, 1);
  r.clock.t = ist("2027-12-25", "09:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.filter((s) => s.to === P1).length, 2, "next year is a new occurrence");
});

test("birthday: changing or removing the date before the send cancels it", async () => {
  const r = rig({ start: ist("2026-12-25", "08:00") });
  await person(r, P1, { birthday: { month: 12, day: 25 } });
  await person(r, P2, { birthday: { month: 12, day: 25 } });
  await enable(r, "birthday");
  r.clock.t = ist("2026-12-25", "08:30");
  await r.campaigns.plan(r.clock.t);
  await r.people.clearBirthday(P1);
  await r.people.setBirthday(P2, { month: 1, day: 3 });
  r.clock.t = ist("2026-12-25", "09:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
  assert.deepEqual((await r.store.queueFor("birthday")).map((q) => q.cancel_reason).sort(), ["birthday_changed", "preference_off"]);
});

test("birthday: skipped when the ERP scheduler already sent a birthday wish today", async () => {
  const r = rig({ start: ist("2026-12-25", "08:00") });
  await person(r, P1, { birthday: { month: 12, day: 25 } });
  await enable(r, "birthday");
  r.store.legacySentToday.add("9876543210:2026-12-25");
  r.clock.t = ist("2026-12-25", "09:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
  assert.equal((await r.store.queueFor("birthday"))[0].cancel_reason, "legacy_already_sent");
});

// ------------------------------------------------------------------------------------------------ preferences, STOP, rechecks
test("preference change after planning but before sending cancels the message", async () => {
  const r = rig({ start: ist("2026-11-25", "06:00") });
  await approveSeed(r);
  await person(r, P1, { motivation: "daily" });
  await person(r, P2, { motivation: "daily" });
  await enable(r, "motivation_daily");
  r.clock.t = ist("2026-11-25", "06:30");
  await r.campaigns.plan(r.clock.t);
  assert.equal((await r.store.queueFor("motivation_daily")).length, 2);
  await r.people.setMotivation(P1, "off");
  r.clock.t = ist("2026-11-25", "07:00");
  await r.campaigns.tick(r.clock.t);
  assert.deepEqual(r.sends.map((s) => s.to), [P2]);
  assert.equal((await r.store.queueFor("motivation_daily")).find((q) => q.phone === P1).cancel_reason, "preference_off");
});

test("STOP between planning and sending prevents the send, for every message kind", async () => {
  const r = rig({ start: ist("2026-01-25", "06:00") });
  await approveSeed(r);
  await person(r, P1, { motivation: "daily", festival: true });
  r.store.members.push({ id: "m1", name: "Ravi", status: "Active", phone: "9876500002" });
  await enable(r, "motivation_daily");
  await enable(r, "festival");
  await enable(r, "closure_notice");
  await r.admin.run("SCHED CLOSE 2026-01-27 Maintenance work");
  r.clock.t = ist("2026-01-26", "06:30"); // Republic Day eve of send
  await r.campaigns.plan(r.clock.t);
  assert.ok((await r.store.queueFor("festival")).length + (await r.store.queueFor("closure_notice")).length > 0);
  await r.people.stop(P1);
  await r.people.captureEnquiry({ phone: P2 });
  await r.people.stop(P2);
  r.clock.t = ist("2026-01-26", "09:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
  const reasons = [...(await r.store.queueFor("festival")), ...(await r.store.queueFor("motivation_daily")), ...(await r.store.queueFor("closure_notice"))].map((q) => q.cancel_reason);
  assert.ok(reasons.length >= 2 && reasons.every((x) => x === "stopped"), JSON.stringify(reasons));
});

test("STOP also marks the ERP contact opted out, START reverses only that", async () => {
  const r = rig();
  r.store.contacts.push({ id: "c1", phone: "9876543210", whatsapp_opt_in: true, opted_out: false });
  await r.people.captureEnquiry({ phone: P1 });
  await r.people.stop(P1);
  assert.equal(r.store.contacts[0].opted_out, true);
  assert.equal(r.store.contacts[0].whatsapp_opt_in, false);
  await r.people.start(P1);
  assert.equal(r.store.contacts[0].opted_out, false);
  assert.equal(r.store.optInRecords.length, 2);
});

test("STOP through the webhook reaches the preference store for a customer who never set preferences", async () => {
  const ctx = build();
  const store = new MemoryPeopleStore();
  const people = new PeopleService({ store, now: ctx.now });
  ctx.bot.people = ctx.engine.people = people;
  await say(ctx, { from: "919900000001", text: "STOP" });
  assert.equal((await people.summary("919900000001")).stopped, true);
  assert.equal(store.leads.length, 0, "a STOP does not create an enquiry");
});

// ------------------------------------------------------------------------------------------------ priority and the daily cap
test("one greeting/motivation per person per day: birthday beats festival beats motivation", async () => {
  const r = rig({ start: ist("2026-01-26", "05:00") }); // Republic Day
  await approveSeed(r);
  await person(r, P1, { motivation: "daily", festival: true, birthday: { month: 1, day: 26 } });
  await person(r, P2, { motivation: "daily", festival: true });
  await person(r, P3, { motivation: "daily" });
  await enable(r, "birthday");
  await enable(r, "festival");
  await enable(r, "motivation_daily");
  for (const hm of ["07:00", "08:00", "09:00", "10:00"]) { r.clock.t = ist("2026-01-26", hm); await r.campaigns.tick(r.clock.t); }
  const by = Object.fromEntries(r.sends.map((s) => [s.to, s.name]));
  assert.equal(by[P1], "gfk_birthday_wish");
  assert.equal(by[P2], "gfk_festival_greeting");
  assert.equal(by[P3], "gfk_daily_motivation");
  assert.equal(r.sends.length, 3, "exactly one each");
});

test("a festival added at 06:00 supersedes a motivation already queued for 07:00", async () => {
  const r = rig({ start: ist("2026-11-25", "05:00") });
  await approveSeed(r);
  await person(r, P1, { motivation: "daily", festival: true });
  await enable(r, "motivation_daily");
  await enable(r, "festival");
  r.clock.t = ist("2026-11-25", "05:30");
  await r.campaigns.plan(r.clock.t);
  assert.equal((await r.store.queueFor("motivation_daily")).length, 1);
  assert.match(await r.admin.run("SCHED EVENT ADD 2026-11-25 festival Test Habba | ಟೆಸ್ಟ್ ಹಬ್ಬ"), /Added/);
  const id = (await r.store.listEvents({})).find((e) => e.name_en === "Test Habba").id;
  await r.admin.run(`SCHED EVENT VERIFY ${id}`);
  r.clock.t = ist("2026-11-25", "06:00");
  const rep = await r.campaigns.plan(r.clock.t);
  assert.equal(rep.superseded, 1);
  for (const hm of ["07:00", "08:00"]) { r.clock.t = ist("2026-11-25", hm); await r.campaigns.tick(r.clock.t); }
  assert.deepEqual(r.sends.map((s) => s.name), ["gfk_festival_greeting"]);
  assert.equal(r.sends[0].params[0], "Test Habba");
});

test("duplicate occurrences: repeated and concurrent ticks never double-send", async () => {
  const r = rig({ start: ist("2026-11-25", "06:00") });
  await approveSeed(r);
  for (const p of [P1, P2, P3]) await person(r, p, { motivation: "daily" });
  await enable(r, "motivation_daily");
  r.clock.t = ist("2026-11-25", "07:00");
  const [a, b] = await Promise.all([r.campaigns.tick(r.clock.t), r.campaigns.tick(r.clock.t)]);
  assert.ok(a.skipped === "busy" || b.skipped === "busy");
  for (let i = 0; i < 3; i++) await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 3);
  const c2 = r.mk(); // a second worker instance (e.g. an overlapping deploy)
  await c2.tick(r.clock.t);
  assert.equal(r.sends.length, 3);
  assert.equal((await r.store.queueFor("motivation_daily")).length, 3);
});

// ------------------------------------------------------------------------------------------------ templates at send time
test("a template that stops being APPROVED after planning is not sent", async () => {
  const r = rig({ start: ist("2026-11-25", "06:00") });
  await approveSeed(r);
  await person(r, P1, { motivation: "daily" });
  await enable(r, "motivation_daily");
  r.clock.t = ist("2026-11-25", "06:30");
  await r.campaigns.plan(r.clock.t);
  r.status["gfk_daily_motivation:en"] = { status: "PAUSED", category: "MARKETING" };
  r.clock.t = ist("2026-11-25", "07:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
  assert.equal((await r.store.queueFor("motivation_daily"))[0].cancel_reason, "template_not_approved");
});

test("disabling a campaign cancels what is still queued", async () => {
  const r = rig({ start: ist("2026-11-25", "06:00") });
  await approveSeed(r);
  await person(r, P1, { motivation: "daily" });
  await enable(r, "motivation_daily");
  await r.campaigns.plan(ist("2026-11-25", "06:10"));
  assert.match(await r.admin.run("SCHED DISABLE motivation_daily"), /OFF/);
  r.clock.t = ist("2026-11-25", "07:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
  assert.equal((await r.store.queueFor("motivation_daily"))[0].cancel_reason, "campaign_disabled");
});

// ------------------------------------------------------------------------------------------------ delivery tracking + recovery
test("Meta acceptance, delivery, read and failure are tracked separately and never regress", async () => {
  const r = rig({ start: ist("2026-11-25", "06:00") });
  await approveSeed(r);
  await person(r, P1, { motivation: "daily" });
  await person(r, P2, { motivation: "daily" });
  await enable(r, "motivation_daily");
  r.clock.t = ist("2026-11-25", "07:00");
  await r.campaigns.tick(r.clock.t);
  const [q1, q2] = await r.store.queueFor("motivation_daily");
  assert.equal(q1.status, "accepted");
  assert.ok(q1.accepted_at && !q1.delivered_at);
  await r.campaigns.onStatus({ id: q1.wamid, status: "sent", timestamp: "1795000000" });
  await r.campaigns.onStatus({ id: q1.wamid, status: "delivered", timestamp: "1795000005" });
  await r.campaigns.onStatus({ id: q1.wamid, status: "read", timestamp: "1795000009" });
  await r.campaigns.onStatus({ id: q1.wamid, status: "delivered", timestamp: "1795000010" }); // late duplicate must not regress
  const after = await r.store.getQueue(q1.id);
  assert.equal(after.status, "read");
  assert.equal(after.delivered_at, 1795000005000);
  assert.equal(after.read_at, 1795000009000);
  assert.equal(after.sent_at, 1795000000000);
  await r.campaigns.onStatus({ id: q2.wamid, status: "failed", timestamp: "1795000003", errors: [{ code: 131026, title: "Message undeliverable" }] });
  const failed = await r.store.getQueue(q2.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_code, 131026);
  assert.ok(failed.accepted_at, "acceptance is still on record");
  assert.equal(await r.campaigns.onStatus({ id: "wamid.unknown", status: "read" }), false);
});

test("restart recovery: queued rows survive and send once; a row interrupted mid-send is never blindly resent", async () => {
  const r = rig({ start: ist("2026-11-25", "06:00") });
  await approveSeed(r);
  for (const p of [P1, P2, P3]) await person(r, p, { motivation: "daily" });
  await enable(r, "motivation_daily");
  r.clock.t = ist("2026-11-25", "06:30");
  await r.campaigns.plan(r.clock.t);
  // worker A claims one row then "crashes" before Meta answers
  r.clock.t = ist("2026-11-25", "07:00");
  const [stuck] = await r.store.claimDue(r.clock.t, 1);
  assert.equal(stuck.status, "sending");
  // process restarts: fresh Campaigns instance, same durable store
  const b = r.mk();
  r.clock.t = ist("2026-11-25", "07:01");
  const early = await b.tick(r.clock.t);
  assert.equal(early.recovered, 0, "not stale yet: another worker may still be sending it");
  assert.equal(r.sends.length, 2, "the two untouched rows were sent exactly once");
  r.clock.t = ist("2026-11-25", "07:10");
  const out = await b.tick(r.clock.t);
  assert.equal(out.recovered, 1);
  const row = await r.store.getQueue(stuck.id);
  assert.equal(row.status, "uncertain");
  assert.match(row.error, /not resent automatically/);
  assert.equal(r.sends.length, 2, "the interrupted row was NOT resent");
  assert.ok(!r.sends.some((s) => s.to === stuck.phone));
});

test("Meta errors: rate limit retries later, uncertain is not resent, rejected fails, auth stops the batch", async () => {
  const r = rig({ start: ist("2026-11-25", "06:00") });
  await approveSeed(r);
  for (const p of [P1, P2]) await person(r, p, { motivation: "daily" });
  await enable(r, "motivation_daily");
  r.clock.t = ist("2026-11-25", "07:00");
  r.behavior.next = new MetaError("rate_limit", "slow down", { retryAfterMs: 120000 });
  let out = await r.campaigns.tick(r.clock.t);
  assert.equal(out.retried, 1);
  assert.equal(out.accepted, 1);
  r.clock.t = ist("2026-11-25", "07:01");
  assert.equal((await r.campaigns.tick(r.clock.t)).accepted, 0, "retry waits for retryAfter");
  r.clock.t = ist("2026-11-25", "07:03");
  assert.equal((await r.campaigns.tick(r.clock.t)).accepted, 1);
  assert.equal(r.sends.length, 2);

  const u = rig({ start: ist("2026-11-25", "06:00") });
  await approveSeed(u);
  await person(u, P1, { motivation: "daily" });
  await enable(u, "motivation_daily");
  u.clock.t = ist("2026-11-25", "07:00");
  u.behavior.next = new MetaError("uncertain", "no response");
  out = await u.campaigns.tick(u.clock.t);
  assert.equal(out.uncertain, 1);
  u.clock.t = ist("2026-11-25", "07:30");
  await u.campaigns.tick(u.clock.t);
  assert.equal(u.sends.length, 0, "no blind resend after an uncertain result");

  const j = rig({ start: ist("2026-11-25", "06:00") });
  await approveSeed(j);
  for (const p of [P1, P2]) await person(j, p, { motivation: "daily" });
  await enable(j, "motivation_daily");
  j.clock.t = ist("2026-11-25", "07:00");
  j.behavior.next = new MetaError("rejected", "bad number", { code: 131026 });
  out = await j.campaigns.tick(j.clock.t);
  assert.equal(out.failed, 1);
  assert.equal(out.accepted, 1);

  const a = rig({ start: ist("2026-11-25", "06:00") });
  await approveSeed(a);
  for (const p of [P1, P2]) await person(a, p, { motivation: "daily" });
  await enable(a, "motivation_daily");
  a.clock.t = ist("2026-11-25", "07:00");
  a.behavior.next = new MetaError("auth", "token expired", { code: 190 });
  out = await a.campaigns.tick(a.clock.t);
  assert.equal(out.failed, 1);
  assert.equal(a.sends.length, 0, "batch stops after an auth failure");
});

// ------------------------------------------------------------------------------------------------ calendar + closures
test("calendar: fixed national days are seeded as verified; lunar festivals are not seeded at all", async () => {
  const r = rig({ start: ist("2026-08-14", "06:00") });
  await r.campaigns.ensureFixedEvents(2026);
  const evs = await r.store.listEvents({});
  const names = evs.map((e) => e.name_en);
  for (const n of ["Republic Day", "Independence Day", "Gandhi Jayanti", "Karnataka Rajyotsava"]) assert.ok(names.includes(n), n);
  for (const n of ["Diwali", "Deepavali", "Ugadi", "Ganesh Chaturthi", "Eid", "Dasara"]) assert.ok(!names.some((x) => x.includes(n)), `${n} must not be guessed`);
  assert.ok(evs.every((e) => e.verified && e.source === "fixed_statutory_date"));
  await r.campaigns.ensureFixedEvents(2026);
  assert.equal((await r.store.listEvents({})).length, evs.length, "idempotent");
  assert.equal(evs.find((e) => e.name_en === "Independence Day").event_date, "2026-08-15");
});

test("festival greeting: an unverified owner-entered date sends nothing until verified", async () => {
  const r = rig({ start: ist("2026-11-25", "05:00") });
  await person(r, P1, { festival: true });
  await enable(r, "festival");
  await r.admin.run("SCHED EVENT ADD 2026-11-25 festival Test Habba");
  r.clock.t = ist("2026-11-25", "08:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
  const id = (await r.store.listEvents({})).find((e) => e.name_en === "Test Habba").id;
  assert.match(await r.admin.run(`SCHED EVENT VERIFY ${id}`), /verified/);
  r.clock.t = ist("2026-11-25", "08:05");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0].params[1], "Ravi");
});

test("festival greeting: Kannada name for Kannada subscribers; only people who opted in", async () => {
  const r = rig({ start: ist("2026-11-01", "05:00") });
  await person(r, P1, { festival: true, lang: "kn" });
  await person(r, P2, {});
  await enable(r, "festival");
  r.clock.t = ist("2026-11-01", "08:00");
  await r.campaigns.tick(r.clock.t);
  assert.deepEqual(r.sends.map((s) => s.to), [P1]);
  assert.equal(r.sends[0].params[0], "ಕನ್ನಡ ರಾಜ್ಯೋತ್ಸವ");
});

test("a government holiday does NOT close the gym or trigger any closure notice", async () => {
  const r = rig({ start: ist("2026-04-13", "06:00") });
  r.store.members.push({ id: "m1", name: "Asha", status: "Active", phone: "9876500002" });
  await enable(r, "closure_notice");
  await enable(r, "revised_hours");
  await r.admin.run("SCHED EVENT ADD 2026-04-14 holiday Test Public Holiday");
  r.clock.t = ist("2026-04-13", "08:00");
  await r.campaigns.tick(r.clock.t);
  r.clock.t = ist("2026-04-14", "08:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
});

test("closure notice: only when the owner marks the gym closed, only to active members and open bookings, once", async () => {
  const r = rig({ start: ist("2026-12-30", "06:00") });
  r.store.members.push({ id: "m1", name: "Asha Rao", status: "Active", phone: "9876500002" }, { id: "m2", name: "Old Member", status: "Expired", phone: "9876500003" });
  r.store.visitRequests.push({ chat: "919876500004", name: "Visitor", status: "requested" });
  await r.people.captureEnquiry({ phone: "919876500005", name: "Plain Lead" }); // an enquiry with no booking
  await enable(r, "closure_notice");
  assert.match(await r.admin.run("SCHED CLOSE 2026-12-31 Annual maintenance"), /Recorded/);
  r.clock.t = ist("2026-12-30", "08:00");
  await r.campaigns.tick(r.clock.t);
  assert.deepEqual(r.sends.map((s) => s.to).sort(), ["919876500002", "919876500004"]);
  assert.ok(r.sends.every((s) => s.name === "gfk_gym_closure_notice" && s.params[1] === "2026-12-31"));
  assert.equal(r.sends[0].params[0] === "Asha" || r.sends[1].params[0] === "Asha", true);
  for (const hm of ["09:00", "12:00"]) { r.clock.t = ist("2026-12-30", hm); await r.campaigns.tick(r.clock.t); }
  assert.equal(r.sends.length, 2, "once per recipient");
  // owner changes the reason: one fresh notice (revision), not a repeat of the old one
  await r.admin.run("SCHED CLOSE 2026-12-31 Closed for electrical repairs");
  r.clock.t = ist("2026-12-30", "13:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 4);
  assert.match(r.sends[3].params[2], /electrical repairs/);
  // unchanged re-entry sends nothing more
  await r.admin.run("SCHED CLOSE 2026-12-31 Closed for electrical repairs");
  r.clock.t = ist("2026-12-30", "14:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 4);
});

test("closure notice is cancelled when the owner reopens before it is sent; notices respect STOP", async () => {
  const r = rig({ start: ist("2026-12-30", "06:00") });
  r.store.members.push({ id: "m1", name: "Asha", status: "Active", phone: "9876500002" }, { id: "m2", name: "Ravi", status: "Active", phone: "9876500003" });
  await enable(r, "closure_notice");
  await r.admin.run("SCHED CLOSE 2026-12-31 Maintenance");
  r.clock.t = ist("2026-12-30", "07:00");
  await r.campaigns.plan(r.clock.t);
  await r.people.captureEnquiry({ phone: P1 });
  await r.people.stop(P1);
  await r.admin.run("SCHED OPEN 2026-12-31");
  r.clock.t = ist("2026-12-30", "08:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 0);
  assert.ok((await r.store.queueFor("closure_notice")).every((q) => q.cancel_reason === "event_changed"));
  const s = rig({ start: ist("2026-12-30", "06:00") });
  s.store.members.push({ id: "m1", name: "Asha", status: "Active", phone: "9876500002" });
  await enable(s, "closure_notice");
  await s.people.captureEnquiry({ phone: P2 });
  await s.people.stop(P2);
  await s.admin.run("SCHED CLOSE 2026-12-31 Maintenance");
  s.clock.t = ist("2026-12-30", "08:00");
  await s.campaigns.tick(s.clock.t);
  assert.equal(s.sends.length, 0, "a member who sent STOP gets no automated notice");
});

test("revised hours notice uses the utility template with the hours text", async () => {
  const r = rig({ start: ist("2026-12-30", "06:00") });
  r.store.members.push({ id: "m1", name: "Asha", status: "Active", phone: "9876500002" });
  await enable(r, "revised_hours");
  await r.admin.run("SCHED HOURS 2026-12-31 7:00 AM to 12:00 PM");
  r.clock.t = ist("2026-12-30", "08:00");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0].name, "gfk_revised_hours_notice");
  assert.equal(r.sends[0].params[2], "7:00 AM to 12:00 PM");
  assert.equal(TEMPLATES.gfk_revised_hours_notice.category, "UTILITY");
});

test("a notice entered late (same day) goes out promptly but never after the event day ends", async () => {
  const r = rig({ start: ist("2026-12-31", "05:00") });
  r.store.members.push({ id: "m1", name: "Asha", status: "Active", phone: "9876500002" });
  await enable(r, "closure_notice");
  await r.admin.run("SCHED CLOSE 2026-12-31 Power cut");
  r.clock.t = ist("2026-12-31", "05:30");
  await r.campaigns.tick(r.clock.t);
  assert.equal(r.sends.length, 1);
});

// ------------------------------------------------------------------------------------------------ owner admin
test("only the authorised owner number can run SCHED commands", async () => {
  const r = rig();
  const msg = (t) => ({ type: "text", text: { body: t } });
  assert.equal(r.admin.match("919900000001", msg("SCHED ENABLE birthday")), null);
  assert.equal(r.admin.match("919740018911", msg("SCHED ENABLE birthday")), null, "the other owner number is not the command number");
  assert.ok(r.admin.match("919742142166", msg("SCHED LIST")));
  assert.ok(r.admin.match("+91 97421 42166", msg("sched list")));
  assert.equal(r.admin.match("919742142166", msg("what are the timings")), null);
  assert.equal(r.admin.match("919742142166", { type: "image" }), null);
});

test("through the webhook: an unauthorised SCHED message is handled as an ordinary customer message", async () => {
  const ctx = build();
  const r = rig();
  ctx.engine.sched = r.admin;
  await say(ctx, { from: "919900000001", text: "SCHED ENABLE birthday" });
  assert.equal((await r.campaigns.config("birthday")).enabled, false);
  assert.ok(!ctx.meta.calls.some((c) => /ON\.|OFF/.test(c.payload.text?.body || "")), "no admin reply leaked");
});

test("through the webhook: the owner gets replies and campaigns stay OFF without an approved template", async () => {
  const ctx = build();
  const r = rig({ tpl: { "gfk_birthday_wish:kn": { status: "PENDING", category: "MARKETING" } } });
  ctx.engine.sched = r.admin;
  await say(ctx, { from: "919742142166", text: "SCHED LIST" });
  const list = ctx.meta.calls.at(-1).payload.text.body;
  assert.match(list, /OFF birthday/);
  assert.match(list, /OFF motivation_daily/);
  await say(ctx, { from: "919742142166", text: "SCHED PREVIEW birthday" });
  assert.match(ctx.meta.calls.at(-1).payload.text.body, /Cannot enable yet/);
  await say(ctx, { from: "919742142166", text: "SCHED ENABLE birthday" });
  assert.match(ctx.meta.calls.at(-1).payload.text.body, /NOT enabled/);
  assert.equal((await r.campaigns.config("birthday")).enabled, false);
});

test("admin: validation of dates, times and campaign names", async () => {
  const r = rig();
  assert.match(await r.admin.run("SCHED TIME birthday 9am"), /HH:MM|like 07:00/);
  assert.match(await r.admin.run("SCHED TIME nope 09:00"), /Campaign must be one of/);
  assert.match(await r.admin.run("SCHED CLOSE 2026-02-31 x"), /Use: SCHED CLOSE/);
  assert.match(await r.admin.run("SCHED CLOSE 2020-01-01 x"), /already passed/);
  assert.match(await r.admin.run("SCHED EVENT ADD tomorrow festival X"), /Use: SCHED EVENT ADD/);
  assert.match(await r.admin.run("SCHED TIME birthday 10:30"), /10:30 IST/);
  assert.match(await r.admin.run("SCHED LIST"), /OFF birthday - Birthday wishes, 10:30 IST/);
});

test("every template body is within Meta limits and Kannada/English have the same variables", () => {
  for (const [name, t] of Object.entries(TEMPLATES)) {
    for (const lang of ["en", "kn"]) {
      assert.ok(t[lang].length <= 1024, `${name} ${lang} body too long`);
      const vars = [...t[lang].matchAll(/\{\{(\d)\}\}/g)].map((m) => Number(m[1])).sort();
      assert.deepEqual(vars, t.params.map((_, i) => i + 1), `${name} ${lang} variables`);
      assert.ok(!t[lang].startsWith("{{") && !t[lang].trimEnd().endsWith("}}"), `${name} ${lang}: Meta rejects bodies that start or end with a variable`);
    }
    assert.match(t.en, /STOP|HUMAN/);
    assert.match(t.kn, /STOP|HUMAN/);
  }
});
