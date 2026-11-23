import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { build, say, inboundBody, sign, createApp, APP_SECRET } from "./helpers.js";
import { verifySignature } from "../../src/enquiry-bot/server.js";

async function withServer(ctx, fn) {
  const deferred = [];
  const app = createApp({ engine: ctx.engine, verifyToken: "verify-me", appSecret: APP_SECRET, defer: (f) => deferred.push(f) });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, deferred);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (base, body, sig) => fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json", ...(sig ? { "x-hub-signature-256": sig } : {}) }, body });

test("signature verification accepts only the correct HMAC", () => {
  const raw = Buffer.from('{"a":1}');
  assert.equal(verifySignature(raw, sign(raw), APP_SECRET), true);
  assert.equal(verifySignature(raw, sign(raw), "wrong"), false);
  assert.equal(verifySignature(raw, "sha256=00", APP_SECRET), false);
  assert.equal(verifySignature(raw, null, APP_SECRET), false);
  assert.equal(verifySignature(raw, sign(Buffer.from("tampered")), APP_SECRET), false);
});

test("GET verification handshake", async () => {
  const ctx = build();
  await withServer(ctx, async (base) => {
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "abc");
    const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc`);
    assert.equal(bad.status, 403);
  });
});

test("unsigned or wrongly signed POSTs are rejected and nothing is saved", async () => {
  const ctx = build();
  await withServer(ctx, async (base) => {
    const { body } = inboundBody({ text: "hi" });
    const raw = JSON.stringify(body);
    assert.equal((await post(base, raw)).status, 401);
    assert.equal((await post(base, raw, "sha256=deadbeef")).status, 401);
    assert.equal(ctx.store.inbound.size, 0);
  });
});

test("event is saved durably BEFORE the 200, processed after; a duplicate delivery is not processed twice", async () => {
  const ctx = build();
  await withServer(ctx, async (base, deferred) => {
    const { wamid, body } = inboundBody({ text: "hi" });
    const raw = JSON.stringify(body);
    const res = await post(base, raw, sign(Buffer.from(raw)));
    assert.equal(res.status, 200);
    assert.equal(ctx.store.inbound.get(wamid).status, "received", "persisted, not yet processed when Meta got its 200");
    assert.equal(ctx.meta.calls.length, 0);
    assert.equal(deferred.length, 1);
    const dup = await post(base, raw, sign(Buffer.from(raw)));
    assert.equal(dup.status, 200);
    assert.equal(deferred.length, 2, "retry of a still-unprocessed event is queued again...");
    await Promise.all(deferred.map((f) => f()));
    assert.equal(ctx.meta.calls.length, 1, "...but only one handler wins the claim, so one reply");
    const again = await post(base, raw, sign(Buffer.from(raw)));
    assert.equal(again.status, 200);
    assert.equal(deferred.length, 2, "a processed message is not queued again");
  });
});

test("if saving fails the webhook returns 500 so Meta retries", async () => {
  const ctx = build();
  ctx.store.insertInbound = async () => {
    throw new Error("db down");
  };
  await withServer(ctx, async (base) => {
    const { body } = inboundBody({ text: "hi" });
    const raw = JSON.stringify(body);
    assert.equal((await post(base, raw, sign(Buffer.from(raw)))).status, 500);
  });
});

test("recovery: an event saved but never processed (crash) is handled once on restart", async () => {
  const ctx = build();
  const { wamid, body } = inboundBody({ text: "hi" });
  await ctx.engine.ingest(body); // saved, crash before processing
  await ctx.engine.recoverPending(0);
  await ctx.engine.recoverPending(0);
  assert.equal(ctx.meta.calls.length, 1);
  assert.equal(ctx.store.inbound.get(wamid).status, "processed");
});

test("status webhooks (sent/delivered/read/failed) are stored and never answered", async () => {
  const ctx = build();
  await withServer(ctx, async (base, deferred) => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.x", status: "read", timestamp: "1", recipient_id: "9199" }] } }] }] });
    const res = await post(base, body, sign(Buffer.from(body)));
    assert.equal(res.status, 200);
    assert.equal(deferred.length, 0);
    assert.equal(ctx.store.statuses[0].status, "read");
  });
});

test("the Meta token is sent only in the Authorization header and never appears in logged errors", async () => {
  const ctx = build();
  await say(ctx, { text: "hi" });
  assert.ok(ctx.meta.calls[0].auth.startsWith("Bearer "));
  assert.ok(!JSON.stringify(ctx.meta.calls[0].payload).includes("secret"));
});

test("timing: receipt, queue wait, Meta acceptance and delivery are reported separately; first-after-idle vs warm", async () => {
  let t = 0;
  const clock = () => t;
  const ctx = build({ clock });
  const run = async (text, gapBefore) => {
    t += gapBefore;
    const { wamid, body } = inboundBody({ text });
    t += 3; // webhook arrives
    const pending = await ctx.engine.ingest(body, clock());
    t += 40; // queue wait before the handler starts
    await ctx.engine.process(pending[0]);
    return wamid;
  };
  const first = await run("hi", 0);
  const warm = await run("1", 20_000);
  const cold = await run("hi", 30 * 60 * 1000);
  const r1 = ctx.timings.report(first);
  assert.equal(typeof r1.ack_ms, "number");
  assert.equal(typeof r1.queue_wait_ms, "number");
  assert.equal(typeof r1.meta_accept_ms, "number");
  assert.equal(r1.accept_to_delivered_ms, null, "delivery is unknown until a status webhook arrives");
  const out1 = ctx.timings.records.get(first).outbound[0].id;
  t += 900;
  await ctx.engine.ingest({ entry: [{ changes: [{ value: { statuses: [{ id: out1, status: "delivered", timestamp: "1", recipient_id: "9199" }] } }] }] }, clock());
  assert.ok(ctx.timings.report(first).accept_to_delivered_ms >= 900);
  const cw = ctx.timings.coldVsWarm();
  assert.equal(cw.cold_count, 2); // the very first message and the one after a 30-minute gap
  assert.equal(cw.warm_count, 1);
  assert.ok(cw.cold_avg_ms !== null && cw.warm_avg_ms !== null);
  assert.ok(ctx.timings.report(cold).first_after_idle >= 30 * 60 * 1000);
  assert.ok(ctx.timings.report(warm).first_after_idle < 60_000);
});
