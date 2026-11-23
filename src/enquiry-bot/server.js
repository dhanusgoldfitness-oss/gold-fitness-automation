// Webhook + processing engine.
// Order of work for every inbound message: verify Meta signature -> save durably -> return 200 -> process.
// Dedupe by WhatsApp message id; one automated sender per chat (a per-chat lock); delivery-status events are
// recorded but never treated as menu input; STOP/START keep working.

import crypto from "node:crypto";
import express from "express";
import { runPhotoJob } from "./photos.js";
import { t } from "./i18n.js";
import { normalizeChat } from "./store.js";
import { OwnerPack } from "./ownerpack.js";
import { normalizeIndianMobile } from "./phone.js";

export function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function extractEvents(body) {
  const messages = [];
  const statuses = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const nameByWaId = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) messages.push({ wamid: m.id, from: m.from, name: nameByWaId.get(m.from) || null, msg: m, to: v.metadata?.display_phone_number ?? null, phoneNumberId: v.metadata?.phone_number_id ?? null });
      for (const s of v.statuses || []) statuses.push({ id: s.id, status: s.status, timestamp: s.timestamp, recipient: s.recipient_id, errors: s.errors });
    }
  }
  return { messages, statuses };
}

export class Engine {
  constructor({ store, bot, client, settings, timings, photoManifest, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, photoPaceMs = 1500, photoCooldownMs = 30 * 60 * 1000, repliesAfterStop = false, ownerPack = null, people = null, campaigns = null, sched = null, botNumber = null, botPhoneNumberId = null, log = () => {} }) {
    Object.assign(this, { store, bot, client, settings, timings, photoManifest, sleep, now, photoPaceMs, photoCooldownMs, repliesAfterStop, ownerPack, people, campaigns, sched, botNumber: botNumber ? String(botNumber).replace(/\D/g, "") : null, botPhoneNumberId, log });
    this.locks = new Map();
  }

  withLock(chat, fn) {
    const prev = this.locks.get(chat) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(chat, next);
    next.finally(() => {
      if (this.locks.get(chat) === next) this.locks.delete(chat);
    }).catch(() => {});
    return next;
  }

  /** Persist everything first. Returns the wamids that still need processing. */
  async ingest(body, receivedAt = this.now()) {
    const { messages, statuses } = extractEvents(body);
    const toProcess = [];
    for (const s of statuses) {
      await this.store.recordStatus({ ...s, receivedAt });
      this.timings.status(s.id, s.status, receivedAt);
      if (this.ownerPack) this.ownerPack.onStatus(s).catch((e) => this.log("pack status notice failed", e.message)); // never delays the 200
      if (this.campaigns) this.campaigns.onStatus(s).catch((e) => this.log("scheduled-message status update failed", e.message));
    }
    for (const m of messages) {
      // Only messages addressed to the WhatsApp API bot number are ours. Anything else is logged and ignored.
      const toDigits = m.to ? String(m.to).replace(/\D/g, "") : null;
      if ((this.botNumber && toDigits && toDigits !== this.botNumber) || (this.botPhoneNumberId && m.phoneNumberId && m.phoneNumberId !== this.botPhoneNumberId)) {
        this.log("ignored message addressed to a different business number");
        continue;
      }
      const rec = this.timings.start(m.wamid);
      rec.receivedAt = receivedAt;
      const chat = normalizeChat(m.from);
      const r = await this.store.insertInbound({ wamid: m.wamid, chat, name: m.name, type: m.msg.type, msg: m.msg, receivedAt });
      this.timings.mark(m.wamid, "persistedAt");
      if (r.inserted || r.status === "received") toProcess.push(m.wamid); // retry of an event we saved but never processed
    }
    return toProcess;
  }

  async send(chat, wamid, message) {
    const to = chat;
    let r;
    if (message.type === "text") r = await this.client.sendText(to, message.body);
    else if (message.type === "list") r = await this.client.sendList(to, message);
    else if (message.type === "buttons") r = await this.client.sendButtons(to, message);
    else throw new Error(`unsupported outbound type ${message.type}`);
    this.timings.outboundAccepted(wamid, r.id, r.requestedAt, r.acceptedAt);
    await this.store.linkOutbound(r.id, wamid);
    return r;
  }

  async process(wamid) {
    const ev = await this.store.claimInbound(wamid);
    if (!ev) return "skipped"; // already claimed or processed: one handler per message
    const chat = ev.chat;
    return this.withLock(chat, async () => {
      try {
        this.timings.mark(wamid, "processStartAt");
        const status = await this.handleOne(ev);
        await this.store.finishInbound(wamid, status);
        await this.store.saveTiming(wamid, this.timings.report(wamid) || {});
        return status;
      } catch (err) {
        this.log("process error", wamid, String(err.message || err));
        await this.store.finishInbound(wamid, "error");
        return "error";
      }
    });
  }

  async handleOne(ev) {
    const { chat, msg, name } = ev;
    const body = msg.type === "text" ? String(msg.text?.body || "").trim() : "";
    const lower = body.toLowerCase();

    if (this.ownerPack) {
      const cmd = this.ownerPack.match(chat, msg);
      if (cmd) {
        await this.ownerPack.run({ ownerWamid: ev.wamid, number: cmd.number, force: cmd.force });
        return "owner_command";
      }
    }

    if (this.sched) {
      const cmd = this.sched.match(chat, msg);
      if (cmd) {
        const reply = await this.sched.run(cmd.text);
        await this.send(chat, ev.wamid, { type: "text", body: reply });
        return "sched_command";
      }
    }

    if (/^(stop|unsubscribe|stop all)$/.test(lower)) {
      await this.stopEverywhere(chat, true);
      await this.store.setOptOut(chat, true);
      const ss = (await this.store.getSession(chat)) ?? this.bot.newSession();
      ss.stopped = true;
      ss.pendingPack = false; // STOP wins over a pending enquiry pack
      ss.pendingSince = null;
      await this.store.saveSession(chat, ss);
      const s = (await this.store.getSession(chat)) ?? this.bot.newSession();
      await this.send(chat, ev.wamid, { type: "text", body: t(s.lang, "stopAck") });
      return "opt_out";
    }
    if (this.repliesAfterStop && lower === "start") {
      await this.stopEverywhere(chat, false);
      await this.store.setOptOut(chat, false);
      const ss = (await this.store.getSession(chat)) ?? this.bot.newSession();
      ss.stopped = false;
      await this.store.saveSession(chat, ss);
      const s = (await this.store.getSession(chat)) ?? this.bot.newSession();
      await this.send(chat, ev.wamid, { type: "text", body: t(s.lang, "startAck") });
      return "opt_in";
    }
    if (await this.store.isOptedOut(chat)) {
      if (lower === "start") {
        await this.stopEverywhere(chat, false);
        await this.store.setOptOut(chat, false);
        const s = (await this.store.getSession(chat)) ?? this.bot.newSession();
        await this.send(chat, ev.wamid, { type: "text", body: t(s.lang, "startAck") });
        return "opt_in";
      }
      return "ignored_opted_out";
    }

    const session = await this.store.getSession(chat);
    if (session?.status === "staff") {
      const settings = await this.settings.get();
      const ttl = (settings.handoverHours ?? 12) * 3600 * 1000;
      if (this.now() - (session.staffSince ?? 0) < ttl) return "ignored_staff_handling";
      session.status = "bot"; // handover period ended: automation resumes
      session.staffSince = null;
      await this.store.saveSession(chat, session);
    }

    // First reply to the requested-details template (View Gym Details tap or any message): full pack once, then the menu.
    if (this.ownerPack && session?.pendingPack && !session.stopped && (await this.ownerPack.deliverPending({ chat, wamid: ev.wamid, session }))) {
      await this.captureAfterReply(chat, name);
      return "pack_on_first_reply";
    }

    const messages = await this.bot.handle({ chat, name, msg });
    for (const m of messages) {
      if (m.type === "photo_job") await this.runPhotos(chat, ev.wamid, m.packageKey, { force: Boolean(m.force) });
      else await this.send(chat, ev.wamid, m);
    }
    await this.captureAfterReply(chat, name);
    return "processed";
  }

  /** STOP/START follow the phone number across leads and members. Failure is logged, never blocks the acknowledgement. */
  async stopEverywhere(chat, stop) {
    if (!this.people) return;
    const phone = normalizeIndianMobile(chat);
    if (!phone) return;
    try {
      if (stop) await this.people.stop(phone);
      else await this.people.start(phone);
    } catch (e) {
      this.log(`${stop ? "STOP" : "START"} could not be saved to the preference store`, e.message);
    }
  }

  /**
   * Create or update the enquiry AFTER the reply has gone out, so a customer's first "Hi" still gets the menu immediately.
   * Runs only when something new is known (first contact, a shared name, a package they looked at).
   */
  async captureAfterReply(chat, name) {
    if (!this.people) return;
    try {
      const session = await this.store.getSession(chat);
      if (!session) return;
      const key = JSON.stringify([session.shareName || null, session.interest?.packageName || session.interest?.interest || null, session.lang]);
      if (session.captureKey === key) return;
      const phone = normalizeIndianMobile(chat);
      if (!phone) return;
      const r = await this.people.captureEnquiry({ phone, name: session.shareName || name || null, nameShared: Boolean(session.shareName), language: session.lang, interest: session.interest?.interest ?? null, packageName: session.interest?.packageName ?? null, source: "WhatsApp bot" });
      if (r.ok) {
        // Re-read: another handler may have saved the session while we were capturing.
        const fresh = (await this.store.getSession(chat)) || session;
        fresh.captureKey = key;
        await this.store.saveSession(chat, fresh);
      }
    } catch (e) {
      this.log("enquiry capture failed", e.message);
    }
  }

  async followUp(job) {
    if (job.followupSent) return;
    job.followupSent = true;
    await this.store.saveJob(job);
    const ok = job.assets.some((a) => a.status === "accepted");
    const buttons = await this.bot.afterPhotos(job.chat, ok);
    await this.send(job.chat, job.triggerWamid, buttons);
  }

  async runPhotos(chat, wamid, packageKey, { force = false } = {}) {
    // A batch that is still sending, or stopped part-way (rate limit / restart): continue it from the remaining photos.
    const open = await this.store.openJobForChat(chat);
    if (open) {
      await this.runJob(open);
      return;
    }
    if (!force && this.photoCooldownMs > 0) {
      const recent = await this.store.recentJobForChat(chat, this.now() - this.photoCooldownMs);
      if (recent && recent.status === "done") {
        await this.send(chat, wamid, await this.bot.photosSkipped(chat)); // inside the cooldown: package details were already sent, offer "Send Photos Again"
        return;
      }
    }
    const manifest = await this.photoManifest.get();
    if (!manifest.assets.length) {
      await this.store.logMediaError({ chat, kind: "manifest", message: manifest.error || "no approved images found", at: this.now() });
      await this.send(chat, wamid, await this.bot.afterPhotos(chat, false));
      return;
    }
    const job = {
      key: `photos:${chat}:${wamid}`,
      chat,
      packageKey,
      triggerWamid: wamid,
      status: "pending",
      createdAt: this.now(),
      followupSent: false,
      assets: manifest.assets.map((a, idx) => ({ idx, public_id: a.public_id, url: a.url, status: "pending" })),
    };
    const { job: current } = await this.store.createJobIfAbsent(job);
    await this.runJob(current);
  }

  async runJob(job) {
    if (job.status === "done" && job.followupSent) return;
    const result = await runPhotoJob({ job, store: this.store, client: this.client, to: job.chat, sleep: this.sleep, paceMs: this.photoPaceMs, now: this.now });
    if (!result.paused) await this.followUp(job);
    return result;
  }

  /** Resume photo jobs that were paused by a rate limit or interrupted by a restart. */
  async resumeOpenJobs() {
    for (const job of await this.store.openJobs()) {
      await this.withLock(job.chat, () => this.runJob(job));
    }
  }

  /** Process events that were saved but never handled (crash between save and process). */
  async recoverPending(olderThanMs = 5000) {
    for (const ev of await this.store.pendingInbound(olderThanMs, this.now())) await this.process(ev.wamid);
  }
}

export function createApp({ engine, verifyToken, appSecret, defer = (fn) => setImmediate(fn) }) {
  const app = express();
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.get("/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === verifyToken) return res.status(200).send(String(req.query["hub.challenge"]));
    return res.sendStatus(403);
  });

  app.post("/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const receivedAt = engine.now();
    if (!verifySignature(req.body, req.get("x-hub-signature-256"), appSecret)) return res.sendStatus(401);
    let body;
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.sendStatus(400);
    }
    let pending;
    try {
      pending = await engine.ingest(body, receivedAt); // saved durably BEFORE we acknowledge
    } catch (err) {
      return res.sendStatus(500); // not saved: let Meta retry
    }
    res.sendStatus(200);
    for (const wamid of pending) defer(() => engine.process(wamid).catch(() => {}));
  });
  return app;
}
