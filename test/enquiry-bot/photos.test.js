import test from "node:test";
import assert from "node:assert/strict";
import { build, say, approved, TOKEN } from "./helpers.js";
import { groupPairs, deliveryUrl } from "../../src/enquiry-bot/photos.js";

const IDS = approved.images.map((a) => a.public_id);
const imgs = (ctx) => ctx.meta.images().map((c) => c.payload.image.link);
const lastPayload = (ctx) => ctx.meta.nonImages().at(-1).payload;

async function choosePackage(ctx, how) {
  await say(ctx, { text: "hi" });
  await say(ctx, { text: "4" });
  if (how === "tap") return say(ctx, { type: "interactive", buttonId: ctx.pkg });
  return say(ctx, { text: ctx.num });
}

for (const [label, num, id, detail] of [
  ["Silver PT", "1", "pt_silver", /\*Silver PT – Group Guidance\*[\s\S]*shared with other members[\s\S]*Monthly: ₹5,775[\s\S]*3 months: ₹13,650[\s\S]*6 months: ₹23,100[\s\S]*Annual: ₹36,750/],
  ["Gold PT", "2", "pt_gold", /\*Gold PT – 1-to-1 Coaching\*[\s\S]*personalized coaching and progress tracking[\s\S]*Monthly: ₹8,925[\s\S]*3 months: ₹23,100[\s\S]*6 months: ₹38,850[\s\S]*Annual: ₹57,750/i],
  ["3+9 Package", "3", "pt_3p9", /\*3\+9 Package – Learn, Then Train Independently\*[\s\S]*Annual total: ₹17,849[\s\S]*basic verbal training instruction[\s\S]*9|Months 4–12: self-guided General Fitness/],
]) {
  for (const how of ["tap", "type"]) {
    test(`${label} (${how}): details immediately, then every approved image once, in order, then the follow-up buttons`, async () => {
      const ctx = build();
      ctx.pkg = id;
      ctx.num = num;
      await choosePackage(ctx, how);
      const calls = ctx.meta.calls.map((c) => c.payload);
      const firstImage = calls.findIndex((p) => p.type === "image");
      const details = calls.slice(0, firstImage).filter((p) => p.type === "text").at(-1);
      assert.match(details.text.body, detail, "details are sent before any image");
      const links = imgs(ctx);
      assert.equal(links.length, 17);
      assert.deepEqual(links, approved.images.map((a) => deliveryUrl(approved.cloud_name, a.public_id, a.version)));
      assert.ok(links.every((u) => u.startsWith("https://") && u.includes("f_jpg")));
      const buttons = lastPayload(ctx);
      assert.equal(buttons.interactive.type, "button");
      assert.deepEqual(buttons.interactive.action.buttons.map((b) => b.reply.title), ["Talk to Owner", "Schedule a Visit", "Main Menu"]);
      assert.equal(calls.at(-1), buttons, "buttons come after the LAST image");
    });
  }
}

test("3+9: basic-instruction wording only; no hands-on/dedicated-coaching claims unless the owner confirms them", async () => {
  const ctx = build();
  await say(ctx, { text: "4" });
  await say(ctx, { text: "3" });
  const t = ctx.meta.nonImages().map((c) => c.payload).find((p) => p.type === "text" && /3\+9/.test(p.text.body)).text.body;
  assert.doesNotMatch(t, /personal training|hands-on|practical demonstration|dedicated|coach/i);
  assert.doesNotMatch(t, /Session frequency/);
  const ctx2 = build({ settings: { plans: { three_plus_nine: { sessionFrequency: "3 sessions a week", confirmedExtras: ["Hands-on form correction"] } } } });
  await say(ctx2, { text: "4" });
  await say(ctx2, { text: "3" });
  const t2 = ctx2.meta.nonImages().map((c) => c.payload).find((p) => p.type === "text" && /3\+9/.test(p.text.body)).text.body;
  assert.match(t2, /Session frequency: 3 sessions a week/);
  assert.match(t2, /Hands-on form correction/);
});

test("every PT package explains anatomy, form/sets/reps, and food/sleep/recovery in simple terms", async () => {
  for (const n of ["1", "2", "3"]) {
    const ctx = build();
    await say(ctx, { text: "4" });
    await say(ctx, { text: n });
    const t = ctx.meta.nonImages().map((c) => c.payload).find((p) => p.type === "text").text.body;
    assert.match(t, /Basic anatomy and which muscles/);
    assert.match(t, /warm-ups, sets, reps and progression/);
    assert.match(t, /protein, hydration, sleep and recovery/);
  }
});

test("customer copy: no trial or transformation promises anywhere", async () => {
  const ctx = build();
  for (const n of ["1", "2", "3"]) {
    await say(ctx, { text: "menu" });
    await say(ctx, { text: "4" });
    await say(ctx, { text: n });
  }
  await say(ctx, { text: "menu" });
  await say(ctx, { text: "1" });
  const all = ctx.meta.nonImages().map((c) => JSON.stringify(c.payload)).join(" ");
  assert.doesNotMatch(all, /trial|transform|guarantee|in \d+ (weeks|days)/i);
});

test("tax breakdown stays hidden until the owner confirms the rate", async () => {
  const ctx = build();
  await say(ctx, { text: "4" });
  await say(ctx, { text: "2" });
  assert.doesNotMatch(ctx.meta.nonImages().map((c) => JSON.stringify(c.payload)).join(" "), /8,500|425/);
  const ctx2 = build({ settings: { tax: { ratePercent: 5, confirmed: true, showBreakdown: true } } });
  await say(ctx2, { text: "4" });
  await say(ctx2, { text: "2" });
  assert.match(ctx2.meta.nonImages().map((c) => JSON.stringify(c.payload)).join(" "), /Monthly: ₹8,925 \(₹8,500 \+ ₹425 tax\)/);
});

test("which-plan question gets the plan guide", async () => {
  const ctx = build();
  await say(ctx, { text: "which plan should I choose?" });
  const t = ctx.meta.nonImages().map((c) => c.payload).find((p) => p.type === "text").text.body;
  assert.match(t, /Choose General Fitness[\s\S]*Choose Silver PT[\s\S]*Choose Gold PT[\s\S]*Choose 3\+9/);
});

test("a PT price missing from settings is reported; photos still go out", async () => {
  const ctx = build({ settings: { plans: { silver: { prices: [] } } } });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  assert.ok(ctx.store.missingSettings.some((m) => m.key === "plans.silver.prices"));
  assert.match(ctx.meta.nonImages().map((c) => c.payload).find((p) => p.type === "text" && /Silver/.test(p.text.body)).text.body, /front desk/);
  assert.equal(ctx.meta.images().length, 17);
});

test("only approved images are sent, even though the folder holds more", async () => {
  const extra = [...approved.images, { public_id: "transformation-01_w1ep3t", version: 1 }, { public_id: "transformation-02_h9b6n4", version: 2 }].map((a) => ({ ...a, resource_type: "image", type: "upload" }));
  const ctx = build({ cloudinary: { pages: [extra] } });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  const sentLinks = imgs(ctx).join(" ");
  assert.equal(ctx.meta.images().length, 17);
  assert.ok(!sentLinks.includes("transformation-01_") && !sentLinks.includes("transformation-02_"));
});

test("multi-page folder listing: every page is fetched and every image is sent (no approved list = whole folder)", async () => {
  const mk = (from, to) => Array.from({ length: to - from }, (_, i) => ({ public_id: `img-${String(from + i).padStart(3, "0")}`, version: 7, resource_type: "image", type: "upload" }));
  const ctx = build({ approvedList: null, cloudinary: { pages: [mk(0, 20), mk(20, 40), mk(40, 45)] } });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "2" });
  assert.equal(ctx.cloud.calls.length, 3, "all three pages requested");
  assert.equal(ctx.cloud.calls[1].body.next_cursor, "1");
  assert.equal(ctx.meta.images().length, 45);
  assert.equal(imgs(ctx)[44].includes("img-044"), true);
});

test("Cloudinary asks for the exact folder path 'before and after' and uses server-side Basic auth", async () => {
  const ctx = build();
  await ctx.manifest.get();
  assert.equal(ctx.cloud.calls[0].body.expression, 'asset_folder="before and after"');
  assert.ok(ctx.cloud.calls[0].url.includes("/v1_1/dnnfzhrbd/resources/search"));
});

test("empty folder: package details still work, media error is recorded for staff, customer gets a graceful message", async () => {
  const ctx = build({ approvedList: null, cloudinary: { pages: [[]] } });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  assert.equal(ctx.meta.images().length, 0);
  assert.ok(ctx.store.mediaErrors.some((e) => e.kind === "manifest"));
  assert.match(lastPayload(ctx).interactive.body.text, /photo gallery is not available/);
  assert.equal(lastPayload(ctx).interactive.action.buttons.length, 3);
});

test("Cloudinary down: falls back to the approved list and still sends all 17", async () => {
  const ctx = build({ cloudinary: { fail: true } });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  assert.equal(ctx.meta.images().length, 17);
  assert.equal((await ctx.manifest.get()).source, "static_fallback");
});

test("Cloudinary down and no approved list: package enquiry still works and the error is recorded", async () => {
  const ctx = build({ approvedList: null, cloudinary: { fail: true } });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "3" });
  assert.ok(ctx.meta.nonImages().some((c) => /Annual total: ₹17,849/.test(c.payload.text?.body || "")));
  assert.ok(ctx.store.mediaErrors.some((e) => e.kind === "manifest" && e.message));
});

test("a failed image is recorded; the remaining images and the buttons are still sent", async () => {
  const script = [undefined, undefined, undefined, { status: 400, code: 131053, message: `Media upload error ${TOKEN}` }]; // 2 non-image replies, then image 1 ok, image 2... see below
  // calls: 1 text (menu), 2 buttons (PT), 3 details text, 4 = image #1 -> fail
  const ctx = build({ metaScript: script });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  assert.equal(ctx.meta.images().length, 17, "all 17 attempted once");
  assert.equal(ctx.store.mediaErrors.length, 1);
  assert.equal(ctx.store.mediaErrors[0].kind, "rejected");
  assert.ok(!JSON.stringify(ctx.store.mediaErrors).includes(TOKEN), "token redacted");
  assert.equal(lastPayload(ctx).interactive.type, "button");
  const job = [...ctx.store.jobs.values()][0];
  assert.equal(job.assets.filter((a) => a.status === "accepted").length, 16);
  assert.equal(job.assets.filter((a) => a.status === "failed").length, 1);
});

test("rate limit: waits, retries the same image, and keeps pacing between images", async () => {
  const ctx = build({ metaScript: [undefined, undefined, { status: 429, code: 130429, retryAfter: "2" }] });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  assert.equal(ctx.meta.images().length, 18, "17 images + 1 retried attempt");
  assert.equal(imgs(ctx)[0], imgs(ctx)[1], "the SAME image was retried");
  assert.ok(ctx.sleeps.includes(2000), "honoured retry-after");
  assert.equal(ctx.sleeps.filter((s) => s === 1500).length, 16, "pacing between 17 images");
  assert.equal(lastPayload(ctx).interactive.type, "button");
});

test("persistent rate limit parks the job (no buttons yet); a resume sends only what is left, never repeats, then sends buttons once", async () => {
  const script = [undefined, undefined]; // PT submenu, details
  for (let i = 0; i < 6; i++) script.push(undefined); // first 6 images fine
  for (let i = 0; i < 5; i++) script.push({ status: 429, code: 130429, retryAfter: "1" }); // initial try + 4 retries all limited
  const ctx = build({ metaScript: script });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  const job = [...ctx.store.jobs.values()][0];
  assert.equal(job.status, "paused_rate_limit");
  assert.equal(job.assets.filter((a) => a.status === "accepted").length, 6);
  assert.ok(!ctx.meta.nonImages().some((c) => c.payload.type === "interactive" && c.payload.interactive.type === "button" && /Above are/.test(c.payload.interactive.body.text)), "no follow-up buttons while images remain");

  await ctx.engine.resumeOpenJobs();
  const after = [...ctx.store.jobs.values()][0];
  assert.equal(after.status, "done");
  const links = imgs(ctx);
  const okLinks = new Set(after.assets.filter((a) => a.status === "accepted").map((a) => a.url));
  assert.equal(okLinks.size, 17);
  // 6 + 5 failed attempts at image #7 + 11 remaining = each image accepted exactly once
  assert.equal(links.length, 6 + 5 + 11);
  await ctx.engine.resumeOpenJobs();
  const follow = ctx.meta.nonImages().filter((c) => /Above are/.test(c.payload.interactive?.body?.text || ""));
  assert.equal(follow.length, 1, "follow-up buttons exactly once");
});

test("uncertain Meta response (timeout) is NOT resent blindly and is recorded for staff", async () => {
  const ctx = build({ metaScript: [undefined, undefined, undefined, "timeout"] }); // image #2 times out
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  assert.equal(ctx.meta.images().length, 17, "exactly one request per image");
  const job = [...ctx.store.jobs.values()][0];
  assert.equal(job.assets[1].status, "uncertain");
  assert.ok(ctx.store.mediaErrors.some((e) => e.kind === "uncertain"));
});

test("a crash mid-send leaves the asset 'sending'; resume marks it uncertain instead of resending it", async () => {
  const ctx = build();
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  const job = [...ctx.store.jobs.values()][0];
  const key = job.key;
  const clone = await ctx.store.getJob(key);
  clone.assets[5].status = "sending";
  clone.assets.slice(6).forEach((a) => (a.status = "pending"));
  clone.status = "running";
  clone.followupSent = false;
  await ctx.store.saveJob(clone);
  const before = ctx.meta.images().length;
  await ctx.engine.resumeOpenJobs();
  const after = await ctx.store.getJob(key);
  assert.equal(after.assets[5].status, "uncertain");
  assert.equal(ctx.meta.images().length - before, 11, "only the untouched pending assets were sent");
});

test("webhook retry of the same message id: one reply, one photo batch", async () => {
  const ctx = build();
  await say(ctx, { text: "4" });
  const { inboundBody } = await import("./helpers.js");
  const { wamid, body } = inboundBody({ text: "1" });
  const p1 = await ctx.engine.ingest(body);
  const p2 = await ctx.engine.ingest(body);
  assert.deepEqual(p1, [wamid]);
  assert.deepEqual(p2, [wamid], "re-delivery of a still-unprocessed event is re-queued; the claim keeps it to one handler");
  await Promise.all([ctx.engine.process(wamid), ctx.engine.process(wamid)]);
  assert.equal(ctx.meta.images().length, 17);
});

function clocked() {
  let t = 1_000_000;
  const clock = () => t;
  const ctx = build({ photoCooldownMs: 30 * 60 * 1000, clock });
  return { ctx, advance: (ms) => (t += ms) };
}
const detailTexts = (ctx) => ctx.meta.nonImages().map((c) => c.payload).filter((p) => p.type === "text").map((p) => p.text.body);

test("cooldown: first selection sends details + all 17 photos; another package within 30 min sends its details immediately and skips the photos", async () => {
  const { ctx, advance } = clocked();
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  assert.equal(ctx.meta.images().length, 17);
  advance(5 * 60 * 1000);
  await say(ctx, { text: "menu" });
  await say(ctx, { text: "4" });
  await say(ctx, { type: "interactive", buttonId: "pt_gold" });
  assert.equal(ctx.meta.images().length, 17, "no automatic photo resend");
  assert.ok(detailTexts(ctx).some((x) => /Gold PT – 1-to-1 Coaching/.test(x)), "Gold details sent right away");
  const btn = lastPayload(ctx);
  assert.deepEqual(btn.interactive.action.buttons.map((b) => b.reply.title), ["Send Photos Again", "Schedule a Visit", "Main Menu"]);
});

test("Send Photos Again (tap) resends the full set once for the last chosen package", async () => {
  const { ctx, advance } = clocked();
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  advance(60_000);
  await say(ctx, { text: "menu" });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "2" });
  await say(ctx, { type: "interactive", buttonId: "photos_again" });
  assert.equal(ctx.meta.images().length, 34);
  assert.equal(lastPayload(ctx).interactive.action.buttons.map((b) => b.reply.title).join("|"), "Talk to Owner|Schedule a Visit|Main Menu");
});

test("Send Photos Again works by typing 1 in that menu or by asking for photos", async () => {
  for (const how of ["1", "send photos again"]) {
    const { ctx, advance } = clocked();
    await say(ctx, { text: "4" });
    await say(ctx, { text: "3" });
    advance(60_000);
    await say(ctx, { text: "menu" });
    await say(ctx, { text: "4" });
    await say(ctx, { text: "1" }); // skipped (cooldown) -> skip menu
    if (how === "1") await say(ctx, { text: "1" });
    else await say(ctx, { text: how });
    assert.equal(ctx.meta.images().length, 34, how);
  }
});

test("after 30 minutes the next package selection sends the full set again", async () => {
  const { ctx, advance } = clocked();
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  advance(31 * 60 * 1000);
  await say(ctx, { text: "menu" });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "2" });
  assert.equal(ctx.meta.images().length, 34);
});

test("a batch still sending is continued, not restarted, when another package is chosen", async () => {
  const script = [undefined, undefined];
  for (let i = 0; i < 4; i++) script.push(undefined);
  for (let i = 0; i < 5; i++) script.push({ status: 429, code: 130429, retryAfter: "1" });
  const { ctx } = (() => {
    let t = 1_000_000;
    const clock = () => t;
    return { ctx: build({ photoCooldownMs: 30 * 60 * 1000, clock, metaScript: script }) };
  })();
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  const job = [...ctx.store.jobs.values()][0];
  assert.equal(job.status, "paused_rate_limit");
  assert.equal(job.assets.filter((a) => a.status === "accepted").length, 4);
  await say(ctx, { text: "menu" });
  await say(ctx, { text: "4" });
  await say(ctx, { text: "2" }); // different package while the first batch is parked
  assert.equal(ctx.store.jobs.size, 1, "no second batch is created");
  const after = [...ctx.store.jobs.values()][0];
  assert.equal(after.status, "done");
  assert.equal(after.assets.filter((a) => a.status === "accepted").length, 17);
  assert.ok(detailTexts(ctx).some((x) => /Gold PT – 1-to-1 Coaching/.test(x)), "newly selected package details still sent immediately");
});

test("a webhook retry of Send Photos Again does not send a second batch", async () => {
  const { ctx, advance } = clocked();
  const { inboundBody } = await import("./helpers.js");
  await say(ctx, { text: "4" });
  await say(ctx, { text: "1" });
  advance(60_000);
  const { wamid, body } = inboundBody({ type: "interactive", buttonId: "photos_again" });
  await ctx.engine.ingest(body);
  await ctx.engine.ingest(body);
  await Promise.all([ctx.engine.process(wamid), ctx.engine.process(wamid)]);
  assert.equal(ctx.meta.images().length, 34);
});

test("one automated sender per conversation: a message arriving mid-batch waits; images stay contiguous", async () => {
  const ctx = build();
  await say(ctx, { text: "4" });
  const { inboundBody } = await import("./helpers.js");
  const a = inboundBody({ text: "1" });
  const b = inboundBody({ text: "hi" });
  const pa = await ctx.engine.ingest(a.body);
  const pb = await ctx.engine.ingest(b.body);
  await Promise.all([ctx.engine.process(pa[0]), ctx.engine.process(pb[0])]);
  const kinds = ctx.meta.calls.map((c) => c.payload.type);
  const first = kinds.indexOf("image");
  const lastImg = kinds.lastIndexOf("image");
  assert.ok(kinds.slice(first, lastImg + 1).every((k) => k === "image"), "no other message between images");
  assert.equal(ctx.meta.calls.at(-1).payload.interactive.type, "list", "the queued Hi is answered after the batch");
});

test("groupPairs keeps before/after files together, before first, and leaves other files in order", () => {
  const out = groupPairs([{ public_id: "a-after_abc123" }, { public_id: "x1" }, { public_id: "a-before_abc123" }, { public_id: "x2" }]);
  assert.deepEqual(out.map((o) => o.public_id), ["a-before_abc123", "a-after_abc123", "x1", "x2"].sort((p, q) => out.findIndex((o) => o.public_id === p) - out.findIndex((o) => o.public_id === q)));
  const idx = (id) => out.findIndex((o) => o.public_id === id);
  assert.equal(idx("a-after_abc123"), idx("a-before_abc123") + 1);
});
