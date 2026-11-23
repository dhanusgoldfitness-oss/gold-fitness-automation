import test from "node:test";
import assert from "node:assert/strict";
import { build, inboundBody, say, TOKEN } from "./helpers.js";
import { normalizeIndianMobile, parseOwnerCommand, buildPackTexts } from "../../src/enquiry-bot/ownerpack.js";
import { OwnerPack } from "../../src/enquiry-bot/ownerpack.js";
import { BASE } from "../../src/enquiry-bot/settings.js";

const OWNER = "919742142166";
const BOT = "919164440303";
const TEMPLATE = { name: "gfk_requested_gym_details", language: "en", params: [] };

function withOwner(opts = {}) {
  const ctx = build(opts);
  const ownerPack = new OwnerPack({ store: ctx.store, client: ctx.client, settings: { get: async () => ({ ...(await ctx.engine.settings.get()), menuTitles: ["Membership Plans & Fees", "Schedule a Gym Visit", "Gym Timings & Location", "Personal Training", "Membership Renewal", "Talk to the Front Desk", "Website & Social Media", "Talk to the Gym Owner", "ಕನ್ನಡ"] }) }, authorized: OWNER, botNumber: BOT, mainEnquiryNumber: "919740018911", template: opts.noTemplate ? null : TEMPLATE, now: ctx.now, sleep: async () => {}, paceMs: 0 });
  ctx.engine.ownerPack = ownerPack;
  ctx.engine.botNumber = BOT;
  ctx.ownerPack = ownerPack;
  return ctx;
}
const asOwner = (ctx, text, extra = {}) => say(ctx, { from: OWNER, text, ...extra });
const to = (ctx, n) => ctx.meta.calls.filter((c) => c.payload.to === n).map((c) => c.payload);
const ownerMsgs = (ctx) => to(ctx, OWNER).map((p) => p.text?.body || "");

test("normalizes bare Indian mobile numbers; rejects everything else", () => {
  for (const [input, want] of [["9845012345", "919845012345"], ["98450 12345", "919845012345"], ["+91 98450-12345", "919845012345"], ["09845012345", "919845012345"], ["919845012345", "919845012345"], ["+919845012345", "919845012345"], ["(98450) 12345", "919845012345"]]) assert.equal(normalizeIndianMobile(input), want, input);
  for (const bad of ["12345", "5845012345", "98450123456", "hello", "call 9845012345", "9845012345 please", "", "+1 415 555 0100", "0000000000", "menu", "1"]) assert.equal(normalizeIndianMobile(bad), null, bad);
  assert.deepEqual(parseOwnerCommand("9845012345 again"), { number: "919845012345", force: true });
  assert.deepEqual(parseOwnerCommand("9845012345"), { number: "919845012345", force: false });
});

test("pack contains fees, timings, location, Silver, Gold, 3+9, visit options, links and BOTH owner numbers; no trial wording", () => {
  const { texts } = buildPackTexts(BASE);
  const all = texts.join("\n---\n");
  for (const re of [/General Fitness[\s\S]*₹5,250/, /Monday–Saturday: 5:30 AM–10:00 PM/, /Sunday: 5:00 PM–9:00 PM/, /Hoysala Circle/, /^https:\/\/maps\.app\.goo\.gl\/BV2ETVx4Nt6YEsPJ8$/m, /Silver PT – Group Guidance[\s\S]*₹5,775/, /Gold PT – 1-to-1 Coaching[\s\S]*₹8,925/, /3\+9 Package[\s\S]*₹17,849/, /3 months of basic verbal training instruction and gym orientation \+ 9 months of General Fitness/, /We offer gym visits/, /97400 18911 \(main enquiry \/ call\)/, /97421 42166 \(owner WhatsApp\)/, /dhanusgoldfitness\.com/, /instagram\.com\/gold_fitness_kengeri/, /97400 18911 \(main enquiry \/ call\): https:\/\/wa\.me\/919740018911/, /97421 42166 \(owner WhatsApp\): https:\/\/wa\.me\/919742142166/]) assert.match(all, re, String(re));
  assert.doesNotMatch(all, /trial|transform/i);
  assert.ok(texts.every((t) => t.length < 4000));
});

test("owner sends a bare number, client inside the 24h window: full pack goes to the client, confirmation goes to the owner", async () => {
  const ctx = withOwner();
  await say(ctx, { from: "919845012345", text: "hi" }); // client messaged the bot earlier today
  ctx.meta.calls.length = 0;
  await asOwner(ctx, "98450 12345");
  const sent = to(ctx, "919845012345");
  assert.equal(sent.length, 8, "7 text messages + main menu list");
  assert.ok(sent.slice(0, -1).every((p) => p.type === "text"));
  assert.equal(sent.at(-1).type, "interactive");
  assert.match(sent[0].text.body, /GOLD FITNESS KENGERI/);
  assert.equal((await ctx.store.getSession("919845012345")).pendingPack ?? false, false, "window open: pack goes immediately, nothing pending");
  assert.ok(ownerMsgs(ctx).some((m) => /✅ Sent to \+91 98450 12345: full pack, within the 24-hour window/.test(m)));
  assert.equal(to(ctx, OWNER).length, 1);
});

test("client outside the 24h window: only the approved gfk_requested_gym_details template is sent, never free-form text or dgf_enquiry_welcome", async () => {
  const ctx = withOwner();
  await asOwner(ctx, "9845012345");
  const sent = to(ctx, "919845012345");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "template");
  assert.equal(sent[0].template.name, "gfk_requested_gym_details");
  assert.equal(sent[0].template.language.code, "en");
  assert.deepEqual(sent[0].template.components, []);
  assert.doesNotMatch(JSON.stringify(ctx.meta.calls), /dgf_enquiry_welcome/);
  assert.match(ownerMsgs(ctx).at(-1), /gfk_requested_gym_details/);
});

test("first reply after the template: the View Gym Details tap sends the full pack once, then the menu; repeat tap and webhook retry never resend", async () => {
  const ctx = withOwner();
  await asOwner(ctx, "9845012345");
  ctx.meta.calls.length = 0;
  const { wamid, body } = inboundBody({ from: "919845012345", type: "button", text: "View Gym Details" });
  await ctx.engine.ingest(body);
  await ctx.engine.ingest(body); // Meta retry
  await Promise.all([ctx.engine.process(wamid), ctx.engine.process(wamid)]);
  let sent = to(ctx, "919845012345");
  assert.equal(sent.length, 8, "7 text messages + main menu list, exactly once");
  assert.equal(sent.at(-1).type, "interactive");
  assert.ok(ownerMsgs(ctx).some((m) => /replied, so the full gym details pack went out automatically/.test(m)));
  await say(ctx, { from: "919845012345", type: "button", text: "View Gym Details" }); // second tap
  sent = to(ctx, "919845012345");
  assert.equal(sent.length, 9, "repeat tap shows only the main menu");
  assert.equal(sent.at(-1).type, "interactive");
  assert.doesNotMatch(JSON.stringify(sent.at(-1)), /Sorry, I didn't get that/);
});

test("any normal first reply while the enquiry is pending also sends the pack once (and is not processed as a menu command)", async () => {
  const ctx = withOwner();
  await asOwner(ctx, "9845012345");
  ctx.meta.calls.length = 0;
  await say(ctx, { from: "919845012345", text: "2" });
  assert.equal(to(ctx, "919845012345").length, 8);
  assert.doesNotMatch(JSON.stringify(to(ctx, "919845012345")), /gym visit\./i, "the typed 2 was not treated as a visit request");
  await say(ctx, { from: "919845012345", text: "hi" });
  assert.equal(to(ctx, "919845012345").length, 9);
});

test("STOP wins over a pending pack: nothing is sent; START later does not trigger the pack either", async () => {
  const ctx = withOwner();
  ctx.engine.repliesAfterStop = true;
  await asOwner(ctx, "9845012345");
  ctx.meta.calls.length = 0;
  await say(ctx, { from: "919845012345", text: "STOP" });
  const afterStop = to(ctx, "919845012345");
  assert.equal(afterStop.length, 1);
  assert.match(JSON.stringify(afterStop[0]), /stop|unsubscribed|opt/i);
  await say(ctx, { from: "919845012345", text: "START" });
  await say(ctx, { from: "919845012345", text: "hi" });
  assert.ok(to(ctx, "919845012345").every((p) => p.type !== "text" || !/Membership Plans & Fees/.test(p.text.body)));
});

test("if the pack cannot be sent on the first reply, the pending flag is restored so the next message tries again", async () => {
  const ctx = withOwner();
  await asOwner(ctx, "9845012345");
  ctx.meta.calls.length = 0;
  ctx.meta.script?.push?.();
  const { wamid, body } = inboundBody({ from: "919845012345", type: "button", text: "View Gym Details" });
  await ctx.engine.ingest(body);
  // make Meta refuse the very first send
  const { MetaError } = await import("../../src/enquiry-bot/whatsapp.js");
  const realSend = ctx.client.sendText.bind(ctx.client);
  ctx.client.sendText = async (to, body) => (to === OWNER ? realSend(to, body) : Promise.reject(new MetaError("rejected", "blocked")));
  await ctx.engine.process(wamid);
  assert.equal((await ctx.store.getSession("919845012345")).pendingPack, true);
  assert.ok(ownerMsgs(ctx).some((m) => /not completed/.test(m)));
});

test("outside the window and no template configured: nothing is sent and the owner is told why", async () => {
  const ctx = withOwner({ noTemplate: true });
  await asOwner(ctx, "9845012345");
  assert.equal(to(ctx, "919845012345").length, 0);
  assert.match(ownerMsgs(ctx).at(-1), /Not sent .* no approved template/);
});

test("only the authorized owner can send commands; a bare number from anyone else is a normal customer message", async () => {
  const ctx = withOwner();
  await say(ctx, { from: "919845012345", text: "hi" });
  ctx.meta.calls.length = 0;
  await say(ctx, { from: "919900000009", text: "9845012345" }); // some other sender
  assert.equal(to(ctx, "919845012345").length, 0, "no pack sent to the number");
  assert.match(JSON.stringify(to(ctx, "919900000009")), /Sorry, I didn't get that/);
  await say(ctx, { from: "919740018911", text: "9845012345" }); // even the main enquiry number is not authorized
  assert.equal(to(ctx, "919845012345").length, 0);
});

test("the owner can still use the bot menu normally; non-number text is not a command", async () => {
  const ctx = withOwner();
  await asOwner(ctx, "hi");
  assert.equal(to(ctx, OWNER)[0].interactive.type, "list");
});

test("own numbers (owner, bot, main enquiry) are refused as targets", async () => {
  const ctx = withOwner();
  for (const n of ["9164440303", "9740018911", "9742142166"]) await asOwner(ctx, n);
  assert.equal(ctx.meta.calls.filter((c) => !["919742142166"].includes(c.payload.to)).length, 0);
  assert.equal(ownerMsgs(ctx).filter((m) => /one of our own numbers/.test(m)).length, 3);
});

test("a client who sent STOP is not messaged", async () => {
  const ctx = withOwner();
  ctx.engine.repliesAfterStop = true;
  await say(ctx, { from: "919845012345", text: "hi" });
  await say(ctx, { from: "919845012345", text: "STOP" });
  ctx.meta.calls.length = 0;
  await asOwner(ctx, "9845012345");
  assert.equal(to(ctx, "919845012345").length, 0);
  assert.match(ownerMsgs(ctx).at(-1), /replied STOP/);
});

test("duplicate guard: same client within 10 minutes is not messaged twice unless the owner says 'again'; a webhook retry never double-sends", async () => {
  const ctx = withOwner();
  await say(ctx, { from: "919845012345", text: "hi" });
  const { wamid, body } = inboundBody({ from: OWNER, text: "9845012345" });
  await ctx.engine.ingest(body);
  await ctx.engine.ingest(body);
  await Promise.all([ctx.engine.process(wamid), ctx.engine.process(wamid)]);
  assert.equal(to(ctx, "919845012345").length, 1 + 8);
  await asOwner(ctx, "9845012345");
  assert.equal(to(ctx, "919845012345").length, 1 + 8);
  assert.match(ownerMsgs(ctx).at(-1), /already sent .* again/);
  await asOwner(ctx, "9845012345 again");
  assert.equal(to(ctx, "919845012345").length, 1 + 16);
});

test("Meta refuses the first pack message (window actually closed): falls back to the template once", async () => {
  const ctx = withOwner({ metaScript: [undefined, { status: 400, code: 131047, message: "Re-engagement message" }] }); // client hi reply ok, first pack message refused
  await say(ctx, { from: "919845012345", text: "hi" });
  ctx.meta.calls.length = 0;
  ctx.meta.calls.push(); // (script index continues)
  await asOwner(ctx, "9845012345");
  const toClient = to(ctx, "919845012345");
  assert.ok(toClient.some((p) => p.type === "template"));
});

test("failure mid-pack is reported to the owner with progress and is NOT retried automatically", async () => {
  const script = [undefined, undefined, undefined, { status: 400, code: 131026, message: `Undeliverable ${TOKEN}` }];
  const ctx = withOwner({ metaScript: script });
  await say(ctx, { from: "919845012345", text: "hi" }); // call 1 = menu to client
  await asOwner(ctx, "9845012345"); // pack: call 2, call 3 ok, call 4 fails
  const toClient = to(ctx, "919845012345");
  assert.equal(toClient.length, 1 + 3);
  assert.match(ownerMsgs(ctx).at(-1), /❌ .* not completed \(2 of 8 messages went out first\)/);
  assert.ok(!ownerMsgs(ctx).join(" ").includes(TOKEN), "token never leaks");
});

test("uncertain Meta result (timeout) is reported, not resent", async () => {
  const ctx = withOwner({ metaScript: [undefined, "timeout"] });
  await say(ctx, { from: "919845012345", text: "hi" });
  await asOwner(ctx, "9845012345");
  assert.equal(to(ctx, "919845012345").length, 2);
  assert.match(ownerMsgs(ctx).at(-1), /did NOT resend/);
});

test("delivery status: owner is told once when the pack is delivered or fails; other statuses are silent", async () => {
  const ctx = withOwner();
  await say(ctx, { from: "919845012345", text: "hi" });
  await asOwner(ctx, "9845012345");
  const rec = await ctx.store.getPackByOwnerWamid([...ctx.store.packs.keys()][0]);
  const status = (id, st, errors) => ctx.engine.ingest({ entry: [{ changes: [{ value: { statuses: [{ id, status: st, timestamp: "1", recipient_id: "919845012345", errors }] } }] }] });
  const before = ownerMsgs(ctx).length;
  await status(rec.firstMessageId, "sent");
  await status(rec.firstMessageId, "read");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ownerMsgs(ctx).length, before);
  await status(rec.firstMessageId, "delivered");
  await status(rec.firstMessageId, "delivered");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ownerMsgs(ctx).length, before + 1);
  assert.match(ownerMsgs(ctx).at(-1), /📬 Delivered to \+91 98450 12345/);
  await status(rec.lastMessageId, "failed", [{ code: 131026, title: "Message undeliverable" }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(ownerMsgs(ctx).at(-1), /could not deliver .*Message undeliverable/);
});

test("messages addressed to a different business number are ignored", async () => {
  const ctx = withOwner();
  const { body } = inboundBody({ from: "919845012345", text: "hi" });
  body.entry[0].changes[0].value.metadata = { display_phone_number: "919999999999", phone_number_id: "999" };
  assert.deepEqual(await ctx.engine.ingest(body), []);
  const ok = inboundBody({ from: "919845012345", text: "hi" });
  ok.body.entry[0].changes[0].value.metadata = { display_phone_number: "91 91644 40303", phone_number_id: "1293149400553401" };
  assert.equal((await ctx.engine.ingest(ok.body)).length, 1);
});
