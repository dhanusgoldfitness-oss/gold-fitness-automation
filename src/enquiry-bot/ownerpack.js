// Owner-only command: the authorized owner number sends a bare Indian mobile number to the bot number, and the bot sends
// that client the enquiry pack (fees, timings, location, Silver PT, Gold PT, 3+9, visit options, website/social links,
// both owner numbers), then confirms the result back to the owner's chat.
//
// Authorization is by sender number only (WhatsApp authenticates the sender; the webhook signature authenticates Meta).
// Nobody else can trigger it: a bare number from any other sender is treated as an ordinary customer message.

import { renderPlan } from "./plans.js";
import { locationReply } from "./location.js";
import { t } from "./i18n.js";
import { MetaError } from "./whatsapp.js";
import { normalizeIndianMobile } from "./phone.js";
export { normalizeIndianMobile };

const digits = (s) => String(s || "").replace(/\D/g, "");

/** Owner message may be the number, optionally followed by "again" to force a resend inside the duplicate guard. */
export function parseOwnerCommand(text) {
  const m = String(text ?? "").trim().match(/^(.*?)(?:\s+(again|resend))?$/i);
  const number = normalizeIndianMobile(m?.[1]);
  return number ? { number, force: Boolean(m[2]) } : null;
}

export const maskNumber = (n) => `+91 ${n.slice(2, 7)} ${n.slice(7)}`;

/** The pack as an ordered list of text messages (each well under WhatsApp's 4096-character limit). */
export function buildPackTexts(settings) {
  const l = "en";
  const missing = [];
  const texts = [];
  const general = renderPlan("general", l, settings.plans?.general, settings.tax);
  missing.push(...general.missing);
  texts.push(`Hello! Thank you for your enquiry at *${settings.brand}* 💪\nHere is everything you need to know.\n\n*Membership Plans & Fees*\n\n${general.text}`);
  texts.push(locationReply(settings, l, { footer: false }));
  for (const key of ["silver", "gold", "three_plus_nine"]) {
    const r = renderPlan(key, l, settings.plans?.[key], settings.tax);
    missing.push(...r.missing);
    texts.push(r.text);
  }
  texts.push("*Gym Visits*\nWe offer gym visits. Come in during gym hours, or reply *2* to request a visit and our team will confirm your time.\nNot sure which plan to choose? Reply *Menu* and our options will help.");
  const links = [`Website: ${settings.website}`, `Instagram: ${settings.instagram}`];
  if (settings.facebook) links.push(`Facebook: ${settings.facebook}`);
  else missing.push("facebook");
  if (settings.youtube) links.push(`YouTube: ${settings.youtube}`);
  else missing.push("youtube");
  const owners = settings.owners.map((o, i) => `${o.phone}${i === 0 ? " (main enquiry / call)" : " (owner WhatsApp)"}: ${o.link}`);
  texts.push(`*Website & Social Media*\n${links.join("\n")}\n\n*Call or WhatsApp the gym owner*\n${owners.join("\n")}`);
  return { texts, missing };
}

export class OwnerPack {
  /**
   * authorized / botNumber / mainEnquiryNumber: digits only, e.g. "919742142166".
   * template: { name, language } approved template used when the client is outside the 24-hour window, or null.
   */
  constructor({ store, client, settings, authorized, botNumber, mainEnquiryNumber, template = null, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), paceMs = 800, duplicateGuardMs = 10 * 60 * 1000, windowMs = 24 * 3600 * 1000, log = () => {} }) {
    Object.assign(this, { store, client, settings, authorized: digits(authorized), botNumber: digits(botNumber), mainEnquiryNumber: digits(mainEnquiryNumber), template, now, sleep, paceMs, duplicateGuardMs, windowMs, log });
  }

  isAuthorized(chat) {
    return digits(chat) === this.authorized;
  }

  /** Returns the parsed command if this message is an owner command, else null (it is handled as a normal customer message). */
  match(chat, msg) {
    if (msg?.type !== "text") return null;
    const cmd = parseOwnerCommand(msg.text?.body);
    if (!cmd) return null;
    if (!this.isAuthorized(chat)) {
      this.log("ignored enquiry-pack command from an unauthorized sender", digits(chat).slice(-4));
      return null;
    }
    return cmd;
  }

  async confirm(text) {
    await this.client.sendText(this.authorized, text).catch((e) => this.log("owner confirmation failed", e.message));
  }

  async run({ ownerWamid, number, force = false }) {
    const own = new Set([this.authorized, this.botNumber, this.mainEnquiryNumber, ...(this.settings.ownerDigits || [])].filter(Boolean));
    const label = maskNumber(number);
    if (own.has(number)) return this.confirm(`⚠️ ${label} is one of our own numbers, so I did not send anything.`);

    const settings = await this.settings.get();
    const session = await this.store.getSession(number);
    if (session?.stopped) return this.confirm(`⚠️ Not sent: ${label} replied STOP earlier. Ask them to send START first.`);

    if (!force) {
      const recent = await this.store.recentPack(number, this.now() - this.duplicateGuardMs);
      if (recent) return this.confirm(`ℹ️ The enquiry pack was already sent to ${label} a few minutes ago (${recent.mode}). Send "${number.slice(2)} again" to send it again.`);
    }

    const lastIn = await this.store.lastInboundAt(number);
    const inWindow = lastIn != null && this.now() - lastIn < this.windowMs;
    let mode = inWindow ? "pack_in_window" : "template";
    const rec = { ownerWamid, client: number, mode, status: "sending", createdAt: this.now(), firstMessageId: null, error: null };

    try {
      if (inWindow) {
        try {
          await this.sendPack(number, settings, rec);
        } catch (err) {
          // Meta says the 24-hour window is closed after all (our clock/record was wrong): fall back to the template, once.
          if (err instanceof MetaError && err.kind === "rejected" && rec.sentCount === 0 && this.template) {
            mode = rec.mode = "template";
            await this.sendTemplate(number, rec);
          } else throw err;
        }
      } else if (this.template) {
        await this.sendTemplate(number, rec);
      } else {
        rec.status = "not_sent";
        rec.error = "outside the 24-hour window and no approved template is enabled";
        await this.store.recordPack(rec);
        return this.confirm(`⚠️ Not sent to ${label}: they have not messaged us in the last 24 hours and no approved template is configured. Ask them to send Hi to +91 91644 40303, or set up a template.`);
      }
    } catch (err) {
      rec.status = err instanceof MetaError && err.kind === "uncertain" ? "uncertain" : "failed";
      rec.error = String(err.message || err).slice(0, 300);
      await this.store.recordPack(rec);
      const sent = rec.sentCount ? ` (${rec.sentCount} of ${rec.total} messages went out first)` : "";
      const why = err instanceof MetaError && err.kind === "uncertain" ? "WhatsApp did not confirm; I did NOT resend to avoid duplicates. Check the chat before sending again" : `WhatsApp refused it: ${rec.error}`;
      return this.confirm(`❌ Enquiry pack to ${label} not completed${sent}. ${why}.`);
    }

    rec.status = "accepted";
    await this.store.recordPack(rec);
    // The client's next reply continues in the menu. After the template, its 1-4 options map to our menu.
    const s = (await this.store.getSession(number)) ?? { menu: "main", lang: "en", step: null, data: {}, status: "bot", staffSince: null };
    s.menu = "main";
    s.step = null;
    s.pendingPack = mode === "template"; // template sent: the full pack goes out automatically on the client's first reply
    s.pendingSince = mode === "template" ? this.now() : null;
    s.updatedAt = this.now();
    await this.store.saveSession(number, s);
    const missing = rec.missing?.length ? `\nNote: not yet configured, so left out: ${[...new Set(rec.missing)].join(", ")}.` : "";
    const how = mode === "template" ? "approved template gfk_requested_gym_details (client is outside the 24-hour window; the full pack goes out automatically when they tap View Gym Details or reply)" : "full pack, within the 24-hour window";
    return this.confirm(`✅ Sent to ${label}: ${how}.${missing}\nI will tell you if WhatsApp reports it delivered or failed.`);
  }

  /**
   * Client's first reply while their enquiry is pending: send the full pack once, then the main menu (the pack ends with it).
   * Called by the engine AFTER STOP/opt-out handling. Returns true if the pack was (or may have been) sent, so the reply
   * is not processed further. The session flag is cleared before sending, so a repeat tap or webhook retry can never resend.
   */
  async deliverPending({ chat, wamid, session }) {
    if (!session?.pendingPack) return false;
    const settings = await this.settings.get();
    session.pendingPack = false;
    session.pendingSince = null;
    session.menu = "main";
    session.step = null;
    session.updatedAt = this.now();
    await this.store.saveSession(chat, session);
    const rec = { ownerWamid: `reply:${wamid}`, client: chat, mode: "first_reply", status: "sending", createdAt: this.now(), firstMessageId: null, error: null };
    const label = maskNumber(chat);
    try {
      await this.sendPack(chat, settings, rec);
      rec.status = "accepted";
      await this.store.recordPack(rec);
      await this.confirm(`✅ ${label} replied, so the full gym details pack went out automatically.`);
    } catch (err) {
      const uncertain = err instanceof MetaError && err.kind === "uncertain";
      rec.status = uncertain ? "uncertain" : "failed";
      rec.error = String(err.message || err).slice(0, 300);
      await this.store.recordPack(rec);
      if (!uncertain && !rec.sentCount) {
        // Nothing went out: put the flag back so the next message from the client tries again.
        const s = (await this.store.getSession(chat)) ?? session;
        s.pendingPack = true;
        s.pendingSince = session.pendingSince ?? this.now();
        await this.store.saveSession(chat, s);
      }
      const part = rec.sentCount ? ` (${rec.sentCount} of ${rec.total} messages went out first; not resent)` : "";
      await this.confirm(`❌ ${label} replied but the gym details pack was not completed${part}: ${uncertain ? "WhatsApp did not confirm, so I did not resend" : rec.error}.`);
    }
    return true;
  }

  async sendPack(number, settings, rec) {
    const { texts, missing } = buildPackTexts(settings);
    rec.total = texts.length + 1;
    rec.sentCount = 0;
    rec.missing = missing;
    for (const body of texts) {
      const r = await this.client.sendText(number, body);
      if (!rec.firstMessageId) rec.firstMessageId = r.id;
      rec.lastMessageId = r.id;
      rec.sentCount++;
      await this.sleep(this.paceMs);
    }
    const menuBody = `Tap *View Options* or reply with a number.\nReply 0 for the main menu.`;
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ id: `menu_${i}`, title: (settings.menuTitles || [])[i - 1] || `Option ${i}` }));
    const r = await this.client.sendList(number, { body: menuBody, button: t("en", "viewOptions"), rows });
    rec.lastMessageId = r.id;
    rec.sentCount++;
    await this.linkIds(rec);
  }

  async sendTemplate(number, rec) {
    rec.total = 1;
    rec.sentCount = 0;
    const r = await this.client.sendTemplate(number, this.template.name, this.template.language, this.template.params || []);
    rec.firstMessageId = r.id;
    rec.lastMessageId = r.id;
    rec.sentCount = 1;
    await this.linkIds(rec);
  }

  async linkIds(rec) {
    for (const id of [rec.firstMessageId, rec.lastMessageId].filter(Boolean)) await this.store.linkOutbound(id, `pack:${rec.ownerWamid}`);
  }

  /** Called for delivery-status events. Tells the owner once when the pack is delivered or failed. */
  async onStatus(s) {
    if (!["delivered", "failed"].includes(s.status)) return;
    const wamid = await this.store.inboundForOutbound(s.id);
    if (!wamid?.startsWith("pack:")) return;
    const key = `${s.id}:${s.status}`;
    if (!(await this.store.markPackNotice(key))) return;
    const rec = await this.store.getPackByOwnerWamid(wamid.slice(5));
    const label = rec ? maskNumber(rec.client) : "the client";
    if (s.status === "delivered") await this.confirm(`📬 Delivered to ${label}.`);
    else {
      const e = s.errors?.[0];
      await this.confirm(`❌ WhatsApp could not deliver to ${label}${e ? `: ${e.title || e.message || e.code}` : ""}.`);
    }
  }
}
