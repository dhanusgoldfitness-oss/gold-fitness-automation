// Storage for enquiry capture, preferences, the campaign calendar and the durable send queue.
//   MemoryPeopleStore   - tests and local runs.
//   SupabasePeopleStore - production, over the ERP project (leads/contacts/members are the ERP's own tables;
//                         wa_person_prefs, wa_consent_log, wa_sched_*, wa_calendar_events, wa_motivation_messages and
//                         wa_send_queue come from supabase/003_scheduled_messages.sql, which is a DRAFT and not applied).
// The ERP tables are only touched in additive ways: leads rows are inserted/updated, contacts.opted_out is set on STOP.
// Members are never modified.

import { phoneKey } from "./phone.js";

export const CAP_KINDS = new Set(["birthday", "festival", "motivation"]); // at most one of these per person per IST day
export const ACTIVE_STATUSES = new Set(["queued", "sending", "accepted", "uncertain", "delivered", "read"]);
let counter = 0;
const uid = (p) => `${p}_${++counter}_${Math.random().toString(36).slice(2, 8)}`;

export class MemoryPeopleStore {
  constructor() {
    this.leads = [];
    this.members = [];
    this.contacts = [];
    this.optInRecords = [];
    this.prefs = new Map(); // phone -> prefs
    this.consentLog = [];
    this.campaigns = new Map();
    this.events = [];
    this.motivation = [];
    this.queue = [];
    this.legacyRules = []; // active ERP automation rule keys, e.g. ["birthday"]
    this.legacySentToday = new Set(); // `${key10}:${date}` already messaged by the ERP scheduler
    this.visitRequests = [];
  }

  // ---- ERP tables
  async findLeadByKey(key) { return this.leads.find((l) => [l.phone, l.mobile, l.whatsapp_number].some((p) => phoneKey(p) === key)) || null; }
  async createLead(f) { const row = { id: uid("lead"), created_at: new Date().toISOString(), ...f }; this.leads.push(row); return row; }
  async updateLead(id, patch) { return Object.assign(this.leads.find((l) => l.id === id), patch); }
  async findMemberByKey(key) { return this.members.find((m) => [m.phone, m.mobile, m.whatsapp, m.whatsapp_number].some((p) => phoneKey(p) === key)) || null; }
  async findContactByKey(key) { return this.contacts.find((c) => phoneKey(c.phone) === key) || null; }
  async setContactOptedOut(key, optedOut, source) {
    const c = await this.findContactByKey(key);
    if (!c) return null;
    c.opted_out = optedOut;
    if (optedOut) c.whatsapp_opt_in = false;
    this.optInRecords.push({ contact_id: c.id, opted_in: !optedOut, source, recorded_at: new Date().toISOString() });
    return c;
  }
  async activeMembers() { return this.members.filter((m) => /^active$/i.test(m.status || "")); }
  async openVisitRequests() { return this.visitRequests.filter((v) => ["requested", "confirmed"].includes(v.status || "requested")); }
  async legacyActiveRules() { return [...this.legacyRules]; }
  async legacySentOn(key, date) { return this.legacySentToday.has(`${key}:${date}`); }

  // ---- preferences + consent
  async getPrefs(phone) { const p = this.prefs.get(phone); return p ? structuredClone(p) : null; }
  async savePrefs(phone, patch) {
    const cur = this.prefs.get(phone) || { phone, language: "en", motivation: "off", birthday_wishes: false, festival_greetings: false, consent: {}, created_at: new Date().toISOString() };
    const next = { ...cur, ...patch, phone, updated_at: new Date().toISOString() };
    this.prefs.set(phone, next);
    return structuredClone(next);
  }
  async listPrefs() { return [...this.prefs.values()].map((p) => structuredClone(p)); }
  async logConsent(rec) { this.consentLog.push({ ...rec }); }

  // ---- campaigns, calendar, messages
  async getCampaign(key) { const c = this.campaigns.get(key); return c ? structuredClone(c) : null; }
  async saveCampaign(key, patch) { const next = { ...(this.campaigns.get(key) || { key }), ...patch, key, updated_at: new Date().toISOString() }; this.campaigns.set(key, next); return structuredClone(next); }
  async listCampaigns() { return [...this.campaigns.values()].map((c) => structuredClone(c)); }
  async listEvents({ from, to } = {}) { return this.events.filter((e) => (!from || e.event_date >= from) && (!to || e.event_date <= to)).map((e) => structuredClone(e)); }
  async getEvent(id) { const e = this.events.find((x) => x.id === id); return e ? structuredClone(e) : null; }
  async saveEvent(ev) {
    const i = ev.id ? this.events.findIndex((x) => x.id === ev.id) : -1;
    if (i >= 0) { this.events[i] = { ...this.events[i], ...ev }; return structuredClone(this.events[i]); }
    const row = { id: uid("evt"), notice_rev: 0, ...ev };
    this.events.push(row);
    return structuredClone(row);
  }
  async listMotivation() { return this.motivation.map((m) => structuredClone(m)); }
  async saveMotivation(m) {
    const i = this.motivation.findIndex((x) => x.id === m.id);
    if (i >= 0) { this.motivation[i] = { ...this.motivation[i], ...m }; return structuredClone(this.motivation[i]); }
    const row = { id: m.id || uid("mot"), approved: false, ...m };
    this.motivation.push(row);
    return structuredClone(row);
  }

  // ---- durable queue. Unique per (campaign, occurrence, recipient); one greeting/motivation per person per IST day.
  async enqueue(row) {
    const dup = this.queue.find((q) => q.campaign_key === row.campaign_key && q.occurrence_key === row.occurrence_key && q.phone === row.phone);
    if (dup) return { created: false, reason: "duplicate", row: structuredClone(dup) };
    if (CAP_KINDS.has(row.kind)) {
      const other = this.queue.find((q) => q.phone === row.phone && q.ist_date === row.ist_date && CAP_KINDS.has(q.kind) && ACTIVE_STATUSES.has(q.status));
      if (other) return { created: false, reason: "day_cap", row: structuredClone(other) };
    }
    const rec = { id: uid("q"), status: "queued", attempts: 0, created_at: new Date().toISOString(), ...row };
    this.queue.push(rec);
    return { created: true, row: structuredClone(rec) };
  }
  async activeGreetingRow(phone, date) { const q = this.queue.find((r) => r.phone === phone && r.ist_date === date && CAP_KINDS.has(r.kind) && ACTIVE_STATUSES.has(r.status)); return q ? structuredClone(q) : null; }
  async claimDue(nowMs, limit = 25) {
    const due = this.queue.filter((q) => q.status === "queued" && q.scheduled_for <= nowMs).sort((a, b) => a.scheduled_for - b.scheduled_for || a.priority - b.priority).slice(0, limit);
    for (const q of due) { q.status = "sending"; q.sending_at = nowMs; q.attempts++; }
    return due.map((q) => structuredClone(q));
  }
  async updateQueue(id, patch) { const q = this.queue.find((r) => r.id === id); if (q) Object.assign(q, patch); return q ? structuredClone(q) : null; }
  async getQueue(id) { const q = this.queue.find((r) => r.id === id); return q ? structuredClone(q) : null; }
  async findQueueByWamid(wamid) { const q = this.queue.find((r) => r.wamid === wamid); return q ? structuredClone(q) : null; }
  async staleSending(olderThanMs) { return this.queue.filter((q) => q.status === "sending" && q.sending_at <= olderThanMs).map((q) => structuredClone(q)); }
  async queueFor(campaignKey, occurrenceKey) { return this.queue.filter((q) => q.campaign_key === campaignKey && (!occurrenceKey || q.occurrence_key === occurrenceKey)).map((q) => structuredClone(q)); }
  async queueSentOn(phone, date) { return this.queue.some((q) => q.phone === phone && q.ist_date === date && ["accepted", "uncertain", "delivered", "read", "sending"].includes(q.status)); }
}

// ---------------------------------------------------------------------------------------------------------------
export class SupabasePeopleStore {
  /** `rest` is SupabaseStore.rest (already bound with the service-role headers). */
  constructor({ rest, gymId }) {
    this.rest = rest;
    this.gymId = gymId;
  }
  q(v) { return encodeURIComponent(v); }

  // leads / members / contacts store phones in free formats, so match on the last 10 digits.
  async findByKey(table, columns, key, select) {
    const filters = columns.map((c) => `${c}.ilike.*${key}*`).join(",");
    const rows = await this.rest(`${table}?or=(${filters})&select=${select}&limit=20`);
    return (rows || []).find((r) => columns.some((c) => phoneKey(r[c]) === key)) || null;
  }
  findLeadByKey(key) { return this.findByKey("leads", ["phone", "mobile", "whatsapp_number"], key, "*"); }
  findMemberByKey(key) { return this.findByKey("members", ["phone", "mobile", "whatsapp", "whatsapp_number"], key, "id,name,member_code,status,phone,mobile,whatsapp,whatsapp_number"); }
  findContactByKey(key) { return this.findByKey("contacts", ["phone"], key, "id,member_id,phone,whatsapp_opt_in,opted_out"); }
  async createLead(f) { const [row] = await this.rest("leads", { method: "POST", prefer: "return=representation", body: { gym_id: this.gymId, ...f } }); return row; }
  async updateLead(id, patch) { const [row] = await this.rest(`leads?id=eq.${this.q(id)}`, { method: "PATCH", prefer: "return=representation", body: patch }); return row; }
  async setContactOptedOut(key, optedOut, source) {
    const c = await this.findContactByKey(key);
    if (!c) return null;
    await this.rest(`contacts?id=eq.${this.q(c.id)}`, { method: "PATCH", body: optedOut ? { opted_out: true, whatsapp_opt_in: false } : { opted_out: false } });
    await this.rest("opt_in_records", { method: "POST", body: { gym_id: this.gymId, contact_id: c.id, opted_in: !optedOut, source, note: "WhatsApp bot" } });
    return c;
  }
  async activeMembers() { return (await this.rest("members?status=ilike.active&select=id,name,phone,mobile,whatsapp,whatsapp_number&limit=5000")) || []; }
  async openVisitRequests(sinceMs) { return (await this.rest(`wa_bot_visit_requests?status=in.(requested,confirmed)&created_at=gte.${new Date(sinceMs).toISOString()}&select=chat,name,preferred_slot`)) || []; }
  async legacyActiveRules() { return ((await this.rest("automation_rules?is_active=eq.true&select=rule_key")) || []).map((r) => r.rule_key); }
  async legacySentOn(key, date) {
    // The ERP scheduler logs sends in automation_runs by contact; look the contact up by phone.
    const c = await this.findContactByKey(key);
    if (!c) return false;
    const rows = await this.rest(`automation_runs?contact_id=eq.${this.q(c.id)}&run_date=eq.${date}&status=eq.sent&select=id&limit=1`);
    return Boolean(rows?.length);
  }

  async getPrefs(phone) { const r = await this.rest(`wa_person_prefs?phone=eq.${phone}&select=*`); return r?.[0] ?? null; }
  async savePrefs(phone, patch) {
    const [row] = await this.rest("wa_person_prefs?on_conflict=phone", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: { phone, ...patch, updated_at: new Date().toISOString() } });
    return row;
  }
  async listPrefs() { return (await this.rest("wa_person_prefs?select=*&limit=20000")) || []; }
  async logConsent(rec) { await this.rest("wa_consent_log", { method: "POST", body: rec }); }

  async getCampaign(key) { const r = await this.rest(`wa_sched_campaigns?key=eq.${this.q(key)}&select=*`); return r?.[0] ?? null; }
  async saveCampaign(key, patch) {
    const [row] = await this.rest("wa_sched_campaigns?on_conflict=key", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: { key, ...patch, updated_at: new Date().toISOString() } });
    return row;
  }
  async listCampaigns() { return (await this.rest("wa_sched_campaigns?select=*")) || []; }
  async listEvents({ from, to } = {}) {
    const f = [from && `event_date=gte.${from}`, to && `event_date=lte.${to}`].filter(Boolean).join("&");
    return (await this.rest(`wa_calendar_events?${f}&order=event_date.asc&select=*`)) || [];
  }
  async getEvent(id) { const r = await this.rest(`wa_calendar_events?id=eq.${this.q(id)}&select=*`); return r?.[0] ?? null; }
  async saveEvent(ev) {
    const [row] = await this.rest(ev.id ? "wa_calendar_events?on_conflict=id" : "wa_calendar_events", { method: "POST", prefer: `${ev.id ? "resolution=merge-duplicates," : ""}return=representation`, body: ev });
    return row;
  }
  async listMotivation() { return (await this.rest("wa_motivation_messages?select=*&order=created_at.asc")) || []; }
  async saveMotivation(m) {
    const [row] = await this.rest(m.id ? "wa_motivation_messages?on_conflict=id" : "wa_motivation_messages", { method: "POST", prefer: `${m.id ? "resolution=merge-duplicates," : ""}return=representation`, body: m });
    return row;
  }

  async enqueue(row) {
    // The table carries the unique index (campaign_key, occurrence_key, phone) and a partial unique index for the daily cap.
    try {
      const rows = await this.rest("wa_send_queue?on_conflict=campaign_key,occurrence_key,phone", { method: "POST", prefer: "resolution=ignore-duplicates,return=representation", body: row });
      if (rows?.length) return { created: true, row: rows[0] };
      return { created: false, reason: "duplicate" };
    } catch (e) {
      if (/HTTP 409/.test(e.message)) return { created: false, reason: "day_cap", row: await this.activeGreetingRow(row.phone, row.ist_date) };
      throw e;
    }
  }
  async activeGreetingRow(phone, date) {
    const r = await this.rest(`wa_send_queue?phone=eq.${phone}&ist_date=eq.${date}&kind=in.(birthday,festival,motivation)&status=in.(queued,sending,accepted,uncertain,delivered,read)&select=*&limit=1`);
    return r?.[0] ?? null;
  }
  async claimDue(nowMs, limit = 25) {
    const ids = await this.rest(`wa_send_queue?status=eq.queued&scheduled_for=lte.${nowMs}&order=scheduled_for.asc,priority.asc&limit=${limit}&select=id`);
    const claimed = [];
    for (const { id } of ids || []) {
      // Atomic per row: only one worker flips queued -> sending.
      const r = await this.rest(`wa_send_queue?id=eq.${this.q(id)}&status=eq.queued`, { method: "PATCH", prefer: "return=representation", body: { status: "sending", sending_at: nowMs } });
      if (r?.length) claimed.push({ ...r[0], attempts: (r[0].attempts || 0) + 1 });
    }
    return claimed;
  }
  async updateQueue(id, patch) { const [row] = await this.rest(`wa_send_queue?id=eq.${this.q(id)}`, { method: "PATCH", prefer: "return=representation", body: patch }); return row; }
  async getQueue(id) { const r = await this.rest(`wa_send_queue?id=eq.${this.q(id)}&select=*`); return r?.[0] ?? null; }
  async findQueueByWamid(wamid) { const r = await this.rest(`wa_send_queue?wamid=eq.${this.q(wamid)}&select=*`); return r?.[0] ?? null; }
  async staleSending(olderThanMs) { return (await this.rest(`wa_send_queue?status=eq.sending&sending_at=lte.${olderThanMs}&select=*`)) || []; }
  async queueFor(campaignKey, occurrenceKey) { return (await this.rest(`wa_send_queue?campaign_key=eq.${this.q(campaignKey)}${occurrenceKey ? `&occurrence_key=eq.${this.q(occurrenceKey)}` : ""}&select=*`)) || []; }
  async queueSentOn(phone, date) { const r = await this.rest(`wa_send_queue?phone=eq.${phone}&ist_date=eq.${date}&status=in.(accepted,uncertain,delivered,read,sending)&select=id&limit=1`); return Boolean(r?.length); }
}
