// Scheduled WhatsApp messages: campaign planner, durable send queue and dispatcher.
//
// Rules this module enforces (all in Asia/Kolkata):
//  - A campaign is OFF until the owner has previewed it and enabled it, and it cannot be enabled while any template it
//    needs is not APPROVED (in English and Kannada) in Meta, or while the ERP scheduler's own rule for it is active.
//  - At most one greeting/motivation message per person per IST day. Priority: birthday > festival > motivation.
//    Service notices (closure / revised hours) are separate and only go to affected members and open bookings.
//  - Every occurrence is a queue row, unique per (campaign, occurrence, recipient). A row survives restarts.
//  - STOP, preferences, campaign state, calendar edits and template status are re-checked immediately before each send.
//  - Meta acceptance, delivery, read and failure are recorded separately. An uncertain send is never blindly resent.
//  - No back-fill: an occurrence scheduled before the campaign was enabled is never sent.

import crypto from "node:crypto";
import { istParts, isoWeekKey, addDays, parseTime, formatTime, isBirthdayToday } from "./ist.js";
import { TEMPLATES, LANGS, renderTemplate, cleanParam } from "./templates.js";
import { CAP_KINDS } from "./people-store.js";
import { MetaError } from "./whatsapp.js";

const IST_MS = 330 * 60 * 1000;
const H = 3600000;
const MOTIVATION_CATEGORIES = ["workout", "consistency", "recovery"];

export const CAMPAIGNS = {
  birthday: { kind: "birthday", priority: 1, template: "gfk_birthday_wish", time: "09:00", maxLateMs: 12 * H, label: "Birthday wishes", legacyRule: "birthday" },
  festival: { kind: "festival", priority: 2, template: "gfk_festival_greeting", time: "08:00", maxLateMs: 6 * H, label: "Festival & national-day greetings" },
  motivation_daily: { kind: "motivation", priority: 3, template: "gfk_daily_motivation", time: "07:00", maxLateMs: 3 * H, label: "Daily motivation" },
  motivation_weekly: { kind: "motivation", priority: 3, template: "gfk_weekly_motivation", time: "07:00", maxLateMs: 3 * H, label: "Weekly motivation" },
  closure_notice: { kind: "notice", priority: 0, template: "gfk_gym_closure_notice", time: "08:00", maxLateMs: 0, label: "Gym closure notice", leadDays: 1 },
  revised_hours: { kind: "notice", priority: 0, template: "gfk_revised_hours_notice", time: "08:00", maxLateMs: 0, label: "Revised-hours notice", leadDays: 1 },
};
export const CAMPAIGN_KEYS = Object.keys(CAMPAIGNS);

const dateTimeMs = (date, minutes) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) + minutes * 60000 - IST_MS;
};
const endOfDayMs = (date) => dateTimeMs(addDays(date, 1), 0);
const dayNumber = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
const firstName = (n) => (!n || /^whatsapp enquiry/i.test(n) ? null : String(n).trim().split(/\s+/)[0]);
const fallbackName = (lang) => (lang === "kn" ? "ಸ್ನೇಹಿತರೇ" : "there");

export class Campaigns {
  constructor({ store, client, templateStatus = async () => ({ status: "UNKNOWN" }), now = Date.now, log = () => {}, rates = {}, staleSendingMs = 2 * 60 * 1000, fixedEvents = [], statusTtlMs = 5 * 60 * 1000 }) {
    Object.assign(this, { store, client, templateStatus, now, log, rates, staleSendingMs, fixedEvents, statusTtlMs });
    this._statusCache = new Map();
    this._running = false;
  }

  // ---------------------------------------------------------------- config
  async config(key) {
    const def = CAMPAIGNS[key];
    if (!def) throw new Error(`unknown campaign ${key}`);
    const row = (await this.store.getCampaign(key)) || {};
    return { key, enabled: false, send_time: def.time, ...row, def };
  }

  async setTime(key, text) {
    const m = parseTime(text);
    if (m == null) return { ok: false, reason: "bad_time" };
    await this.store.saveCampaign(key, { send_time: formatTime(m) }); // applies from the next occurrence
    return { ok: true, time: formatTime(m) };
  }

  async disable(key, by = "owner") {
    await this.store.saveCampaign(key, { enabled: false, disabled_at: this.now(), disabled_by: by });
    return { ok: true };
  }

  // ---------------------------------------------------------------- template status
  async tplStatus(name, lang) {
    const k = `${name}:${lang}`;
    const hit = this._statusCache.get(k);
    if (hit && this.now() - hit.at < this.statusTtlMs) return hit.v;
    let v;
    try {
      v = (await this.templateStatus(name, lang)) || { status: "UNKNOWN" };
    } catch (e) {
      v = { status: "UNKNOWN", error: e.message };
    }
    this._statusCache.set(k, { at: this.now(), v });
    return v;
  }

  async templateReport(key) {
    const name = CAMPAIGNS[key].template;
    const expected = TEMPLATES[name].category;
    const out = [];
    for (const lang of LANGS) {
      const s = await this.tplStatus(name, lang);
      const status = String(s.status || "UNKNOWN").toUpperCase();
      const categoryOk = !s.category || String(s.category).toUpperCase() === expected;
      out.push({ name, lang, status, category: s.category || null, expected, ok: status === "APPROVED" && categoryOk, categoryOk });
    }
    return out;
  }

  // ---------------------------------------------------------------- audience
  async context(nowMs) {
    const [prefs, events, messages, members, visits] = await Promise.all([this.store.listPrefs(), this.store.listEvents({}), this.store.listMotivation(), this.store.activeMembers(), this.store.openVisitRequests(nowMs - 7 * 86400000)]);
    return { prefs, events, messages: messages.filter((m) => m.approved), members, visits };
  }

  pickMotivation(messages, lang, date, weekly) {
    const pool = messages.filter((m) => m.lang === lang);
    if (!pool.length) return null;
    const n = weekly ? Number(isoWeekKey(...date.split("-").map(Number)).split("W")[1]) : dayNumber(date);
    const cat = MOTIVATION_CATEGORIES[n % MOTIVATION_CATEGORIES.length];
    const inCat = pool.filter((m) => m.category === cat).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const list = inCat.length ? inCat : pool.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return list[Math.floor(n / MOTIVATION_CATEGORIES.length) % list.length];
  }

  /** Who would get this campaign on this IST date, with the exact template parameters. Pure: sends and queues nothing. */
  async audience(key, nowMs, ctx = null) {
    ctx = ctx || (await this.context(nowMs));
    const def = CAMPAIGNS[key];
    const parts = istParts(nowMs);
    const date = parts.date;
    const cfg = await this.config(key);
    const sendMin = parseTime(cfg.send_time) ?? parseTime(def.time);
    const items = [];
    const skipped = {};
    const skip = (r) => (skipped[r] = (skipped[r] || 0) + 1);
    const prefsBy = new Map(ctx.prefs.map((p) => [p.phone, p]));
    const nameFor = (p, lang) => firstName(p?.name) || fallbackName(lang);

    if (def.kind === "notice") {
      const wantHours = key === "revised_hours";
      const evs = ctx.events.filter((e) => !e.cancelled && e.event_date >= date && e.event_date <= addDays(date, def.leadDays) && (wantHours ? e.revised_hours : e.gym_closed));
      const people = new Map();
      for (const m of ctx.members) for (const f of [m.whatsapp_number, m.whatsapp, m.phone, m.mobile]) { const n = f && String(f).replace(/\D/g, "").slice(-10); if (n && n.length === 10) { people.set(`91${n}`, m.name); break; } }
      for (const v of ctx.visits) { const n = String(v.chat || "").replace(/\D/g, "").slice(-10); if (n.length === 10 && !people.has(`91${n}`)) people.set(`91${n}`, v.name); }
      for (const ev of evs) {
        for (const [phone, nm] of people) {
          const p = prefsBy.get(phone);
          if (p?.stopped_at) { skip("stopped"); continue; }
          const lang = p?.language === "kn" ? "kn" : "en";
          const reason = lang === "kn" ? ev.reason_kn || ev.reason_en || "" : ev.reason_en || "";
          const params = wantHours
            ? [firstName(p?.name) || firstName(nm) || fallbackName(lang), ev.event_date, ev.revised_hours]
            : [firstName(p?.name) || firstName(nm) || fallbackName(lang), ev.event_date, reason ? `${reason}.` : ""];
          const sched = Math.max(dateTimeMs(addDays(ev.event_date, -def.leadDays), sendMin), nowMs);
          items.push({ phone, lang, ist_date: date, occurrence_key: `${ev.id}:r${ev.notice_rev ?? 0}`, scheduled_for: sched, expires_at: endOfDayMs(ev.event_date), params: params.map(cleanParam), meta: { event_id: ev.id, notice_rev: ev.notice_rev ?? 0 } });
        }
      }
      return { items, skipped, date };
    }

    for (const p of ctx.prefs) {
      if (p.stopped_at) { skip("stopped"); continue; }
      const lang = p.language === "kn" ? "kn" : "en";
      const base = { phone: p.phone, lang, ist_date: date };
      if (key === "birthday") {
        if (!p.birthday_wishes) continue;
        if (!isBirthdayToday(p.birth_month, p.birth_day, parts)) continue;
        items.push({ ...base, occurrence_key: `birthday:${parts.year}`, scheduled_for: dateTimeMs(date, sendMin), params: [nameFor(p, lang)].map(cleanParam) });
      } else if (key === "festival") {
        if (!p.festival_greetings) continue;
        for (const ev of ctx.events.filter((e) => e.event_date === date && e.greet && e.verified && !e.cancelled && ["festival", "national"].includes(e.type))) {
          items.push({ ...base, occurrence_key: `${ev.id}`, scheduled_for: dateTimeMs(date, sendMin), params: [lang === "kn" ? ev.name_kn || ev.name_en : ev.name_en, nameFor(p, lang)].map(cleanParam), meta: { event_id: ev.id } });
          break; // one festival greeting per person per day
        }
      } else if (key === "motivation_daily" || key === "motivation_weekly") {
        const weekly = key === "motivation_weekly";
        if (p.motivation !== (weekly ? "weekly" : "daily")) continue;
        if (weekly && (p.weekly_dow || 1) !== parts.dow) continue;
        const msg = this.pickMotivation(ctx.messages, lang, date, weekly);
        if (!msg) { skip("no_approved_message"); continue; }
        const own = weekly && p.weekly_time ? parseTime(p.weekly_time) : null;
        items.push({ ...base, occurrence_key: weekly ? parts.isoWeek : date, scheduled_for: dateTimeMs(date, own ?? sendMin), params: [nameFor(p, lang), msg.text].map(cleanParam), meta: { message_id: msg.id } });
      }
    }
    return { items, skipped, date };
  }

  // ---------------------------------------------------------------- preview / enable
  sample(key) {
    const name = CAMPAIGNS[key].template;
    const ex = { name: "Ravi", festival: "Republic Day", message: "Show up today. Small steps add up.", date: "2026-12-25", reason: "Public holiday.", hours: "7:00 AM to 12:00 PM" };
    const out = {};
    for (const lang of LANGS) out[lang] = renderTemplate(name, lang, TEMPLATES[name].params.map((p) => (lang === "kn" && p === "festival" ? "ಗಣರಾಜ್ಯೋತ್ಸವ" : ex[p])));
    return out;
  }

  estimate(key, count) {
    const category = TEMPLATES[CAMPAIGNS[key].template].category;
    const rate = this.rates[category];
    return rate == null ? { available: false, category, note: "No per-message rate configured; see Meta's pricing for your country." } : { available: true, category, currency: "INR", perMessage: rate, total: Math.round(rate * count * 100) / 100 };
  }

  async previewHash(key, templates, ctx) {
    const approvedIds = key.startsWith("motivation") ? ctx.messages.map((m) => m.id).sort() : [];
    return crypto.createHash("sha1").update(JSON.stringify({ key, sample: this.sample(key), templates: templates.map((t) => [t.name, t.lang, t.status, t.category]), approvedIds })).digest("hex");
  }

  async blockers(key, ctx) {
    const out = [];
    const templates = await this.templateReport(key);
    for (const t of templates) {
      if (t.status !== "APPROVED") out.push(`Template ${t.name} (${t.lang}) is ${t.status}, not APPROVED`);
      else if (!t.categoryOk) out.push(`Template ${t.name} (${t.lang}) was approved as ${t.category}, expected ${t.expected}`);
    }
    const def = CAMPAIGNS[key];
    if (def.legacyRule && (await this.store.legacyActiveRules()).includes(def.legacyRule)) out.push(`The ERP scheduler's "${def.legacyRule}" rule is still active; turn it off first or people would be messaged twice`);
    if (key.startsWith("motivation")) for (const lang of LANGS) if (!ctx.messages.some((m) => m.lang === lang)) out.push(`No owner-approved ${lang === "kn" ? "Kannada" : "English"} motivation messages yet`);
    return { blockers: out, templates };
  }

  /** What the owner sees before enabling: message, audience, cost, and what still blocks it. Records the preview. */
  async preview(key, nowMs = this.now()) {
    const ctx = await this.context(nowMs);
    const aud = await this.audience(key, nowMs, ctx);
    const { blockers, templates } = await this.blockers(key, ctx);
    const hash = await this.previewHash(key, templates, ctx);
    await this.store.saveCampaign(key, { preview_hash: hash, previewed_at: nowMs });
    const cfg = await this.config(key);
    return { key, label: CAMPAIGNS[key].label, enabled: Boolean(cfg.enabled), send_time: cfg.send_time, date: aud.date, sample: this.sample(key), audienceToday: aud.items.length, skipped: aud.skipped, templates, cost: this.estimate(key, aud.items.length), blockers, canEnable: blockers.length === 0 };
  }

  async enable(key, by = "owner") {
    const cfg = await this.config(key);
    const ctx = await this.context(this.now());
    const { blockers, templates } = await this.blockers(key, ctx);
    if (blockers.length) return { ok: false, reason: "blocked", blockers };
    const hash = await this.previewHash(key, templates, ctx);
    if (!cfg.preview_hash || cfg.preview_hash !== hash) return { ok: false, reason: "preview_required", blockers: ["Preview this campaign (and check the message) before enabling it"] };
    await this.store.saveCampaign(key, { enabled: true, enabled_at: this.now(), enabled_by: by });
    return { ok: true };
  }

  // ---------------------------------------------------------------- calendar
  async ensureFixedEvents(year) {
    for (const f of this.fixedEvents) {
      const id = `fixed-${f.key}-${year}`;
      if (await this.store.getEvent(id)) continue;
      await this.store.saveEvent({ id, event_date: `${year}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}`, name_en: f.name_en, name_kn: f.name_kn, type: f.type, greet: Boolean(f.greet), verified: true, gym_closed: false, revised_hours: null, cancelled: false, source: "fixed_statutory_date" });
    }
  }

  // ---------------------------------------------------------------- planning
  /** Turn today's due occurrences into durable queue rows. Safe to run every tick: the queue is unique per recipient/occurrence. */
  async plan(nowMs = this.now()) {
    const parts = istParts(nowMs);
    await this.ensureFixedEvents(parts.year);
    const ctx = await this.context(nowMs);
    const report = { created: 0, duplicates: 0, capped: 0, superseded: 0, tooLate: 0, beforeEnable: 0 };
    const keys = [...CAMPAIGN_KEYS].sort((a, b) => CAMPAIGNS[a].priority - CAMPAIGNS[b].priority);
    for (const key of keys) {
      const cfg = await this.config(key);
      if (!cfg.enabled) continue;
      const def = CAMPAIGNS[key];
      const aud = await this.audience(key, nowMs, ctx);
      for (const it of aud.items) {
        const scheduled = it.scheduled_for;
        if (cfg.enabled_at && scheduled < cfg.enabled_at && def.kind !== "notice") { report.beforeEnable++; continue; }
        const expires = it.expires_at ?? scheduled + def.maxLateMs;
        if (nowMs > expires) { report.tooLate++; continue; }
        const row = { campaign_key: key, occurrence_key: it.occurrence_key, phone: it.phone, kind: def.kind, priority: def.priority, ist_date: it.ist_date, scheduled_for: scheduled, expires_at: expires, template: def.template, lang: it.lang, params: it.params, meta: it.meta || {} };
        let r = await this.store.enqueue(row);
        if (!r.created && r.reason === "day_cap" && r.row.status === "queued" && r.row.priority > def.priority) {
          await this.store.updateQueue(r.row.id, { status: "cancelled", cancel_reason: `superseded_by_${key}` });
          report.superseded++;
          r = await this.store.enqueue(row);
        }
        if (r.created) report.created++;
        else if (r.reason === "day_cap") report.capped++;
        else report.duplicates++;
      }
    }
    return report;
  }

  // ---------------------------------------------------------------- dispatch
  /** Everything that must still be true at the moment of sending. Returns a cancel reason, or null if OK to send. */
  async recheck(row, nowMs) {
    const cfg = await this.config(row.campaign_key);
    if (!cfg.enabled) return "campaign_disabled";
    if (nowMs > row.expires_at) return "expired";
    const p = await this.store.getPrefs(row.phone);
    if (p?.stopped_at) return "stopped";
    const parts = istParts(nowMs);
    switch (row.kind) {
      case "birthday":
        if (!p?.birthday_wishes) return "preference_off";
        if (!isBirthdayToday(p.birth_month, p.birth_day, parts)) return "birthday_changed";
        if (await this.store.legacySentOn(row.phone.slice(2), row.ist_date)) return "legacy_already_sent";
        break;
      case "festival": {
        if (!p?.festival_greetings) return "preference_off";
        const ev = await this.store.getEvent(row.meta?.event_id);
        if (!ev || ev.cancelled || !ev.verified || !ev.greet || ev.event_date !== row.ist_date) return "event_changed";
        break;
      }
      case "motivation":
        if (p?.motivation !== (row.campaign_key === "motivation_weekly" ? "weekly" : "daily")) return "preference_off";
        break;
      case "notice": {
        const ev = await this.store.getEvent(row.meta?.event_id);
        const want = row.campaign_key === "revised_hours" ? ev?.revised_hours : ev?.gym_closed;
        if (!ev || ev.cancelled || !want || (ev.notice_rev ?? 0) !== row.meta.notice_rev) return "event_changed";
        break;
      }
    }
    const reports = await this.templateReport(row.campaign_key);
    const mine = reports.find((r) => r.lang === row.lang);
    if (!mine?.ok) return "template_not_approved";
    return null;
  }

  async tick(nowMs = this.now()) {
    if (this._running) return { skipped: "busy" };
    this._running = true;
    try {
      const recovered = await this.recoverStale(nowMs);
      const planned = await this.plan(nowMs);
      const sent = await this.dispatch(nowMs);
      return { recovered, planned, ...sent };
    } finally {
      this._running = false;
    }
  }

  /** After a crash a row can be stuck in "sending": we cannot know whether Meta accepted it, so it is never resent. */
  async recoverStale(nowMs) {
    const stale = await this.store.staleSending(nowMs - this.staleSendingMs);
    for (const r of stale) await this.store.updateQueue(r.id, { status: "uncertain", error: "interrupted while sending; not resent automatically" });
    return stale.length;
  }

  async dispatch(nowMs) {
    const out = { accepted: 0, cancelled: 0, failed: 0, retried: 0, uncertain: 0 };
    const rows = await this.store.claimDue(nowMs, 25);
    for (const row of rows) {
      const reason = await this.recheck(row, nowMs).catch((e) => `recheck_error:${e.message}`);
      if (reason) { await this.store.updateQueue(row.id, { status: reason === "expired" ? "expired" : "cancelled", cancel_reason: reason }); out.cancelled++; continue; }
      try {
        const res = await this.client.sendTemplate(row.phone, row.template, row.lang, row.params || []);
        await this.store.updateQueue(row.id, { status: "accepted", wamid: res.id, accepted_at: res.acceptedAt ?? nowMs });
        out.accepted++;
      } catch (e) {
        const kind = e instanceof MetaError ? e.kind : "uncertain";
        if (kind === "rate_limit" && row.attempts < 5) {
          await this.store.updateQueue(row.id, { status: "queued", scheduled_for: nowMs + (e.retryAfterMs || 60000), error: e.message });
          out.retried++;
        } else if (kind === "uncertain") {
          await this.store.updateQueue(row.id, { status: "uncertain", error: e.message });
          out.uncertain++;
        } else {
          await this.store.updateQueue(row.id, { status: "failed", failed_at: nowMs, error: e.message, error_code: e.code ?? null });
          out.failed++;
          if (kind === "auth") { this.log("scheduled sends paused: WhatsApp token rejected"); break; }
        }
      }
    }
    return out;
  }

  /** Meta status webhooks: sent / delivered / read / failed, tracked separately from acceptance. */
  async onStatus(s) {
    const row = s?.id ? await this.store.findQueueByWamid(s.id) : null;
    if (!row) return false;
    const at = s.timestamp ? Number(s.timestamp) * 1000 : this.now();
    const rank = { accepted: 1, delivered: 2, read: 3 };
    if (s.status === "failed") {
      if (row.status === "delivered" || row.status === "read") return true;
      await this.store.updateQueue(row.id, { status: "failed", failed_at: at, error: s.errors?.[0]?.title || s.errors?.[0]?.message || "failed", error_code: s.errors?.[0]?.code ?? null });
    } else if (s.status === "sent") {
      await this.store.updateQueue(row.id, { sent_at: at });
    } else if ((rank[s.status] || 0) > (rank[row.status] || 0)) {
      await this.store.updateQueue(row.id, { status: s.status, [`${s.status}_at`]: at });
    }
    return true;
  }

  async queueSummary(key) {
    const rows = await this.store.queueFor(key);
    const by = {};
    for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
    return by;
  }
}
