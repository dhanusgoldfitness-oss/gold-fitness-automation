// Production store over Supabase PostgREST. Same interface as MemoryStore.
// NOT yet exercised against the live project: apply db/001_bot_tables.sql first, then run a staging test.
// Opt-out reuses the existing contacts.opted_out flag so the current STOP handling stays the single source of truth.

import { normalizeChat } from "./store.js";

export class SupabaseStore {
  constructor({ url, key, fetchImpl = globalThis.fetch }) {
    this.base = `${url.replace(/\/$/, "")}/rest/v1`;
    this.headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    this.fetch = fetchImpl;
  }

  async rest(path, { method = "GET", body, prefer } = {}) {
    const res = await this.fetch(`${this.base}/${path}`, { method, headers: { ...this.headers, ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]} failed: HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async insertInbound(ev) {
    const rows = await this.rest("wa_bot_inbound_events?on_conflict=wamid", { method: "POST", prefer: "resolution=ignore-duplicates,return=representation", body: { wamid: ev.wamid, chat: ev.chat, name: ev.name, msg_type: ev.type, payload: ev.msg, received_at: new Date(ev.receivedAt).toISOString() } });
    if (rows && rows.length) return { inserted: true, status: "received" };
    const [existing] = await this.rest(`wa_bot_inbound_events?wamid=eq.${encodeURIComponent(ev.wamid)}&select=status`);
    return { inserted: false, status: existing?.status ?? "received" };
  }
  async claimInbound(wamid) {
    // Atomic: only one handler flips received -> processing.
    const rows = await this.rest(`wa_bot_inbound_events?wamid=eq.${encodeURIComponent(wamid)}&status=eq.received`, { method: "PATCH", prefer: "return=representation", body: { status: "processing" } });
    if (!rows?.length) return null;
    const r = rows[0];
    return { wamid: r.wamid, chat: r.chat, name: r.name, type: r.msg_type, msg: r.payload, receivedAt: Date.parse(r.received_at) };
  }
  async finishInbound(wamid, status = "processed") {
    await this.rest(`wa_bot_inbound_events?wamid=eq.${encodeURIComponent(wamid)}`, { method: "PATCH", body: { status, processed_at: new Date().toISOString() } });
  }
  async pendingInbound(olderThanMs, now) {
    const cutoff = new Date(now - olderThanMs).toISOString();
    const rows = await this.rest(`wa_bot_inbound_events?status=eq.received&received_at=lte.${cutoff}&select=wamid,received_at`);
    return (rows || []).map((r) => ({ wamid: r.wamid, receivedAt: Date.parse(r.received_at) }));
  }

  async lastInboundAt(chat) {
    const rows = await this.rest(`wa_bot_inbound_events?chat=eq.${chat}&order=received_at.desc&limit=1&select=received_at`);
    return rows?.[0] ? Date.parse(rows[0].received_at) : null;
  }
  async recordPack(rec) {
    await this.rest("wa_bot_pack_sends?on_conflict=owner_wamid", { method: "POST", prefer: "resolution=merge-duplicates", body: { owner_wamid: rec.ownerWamid, client: rec.client, mode: rec.mode, status: rec.status, error: rec.error ?? null, created_at_ms: rec.createdAt, detail: rec } });
  }
  async recentPack(client, sinceMs) {
    const rows = await this.rest(`wa_bot_pack_sends?client=eq.${client}&created_at_ms=gte.${sinceMs}&status=in.(accepted,uncertain)&order=created_at_ms.desc&limit=1&select=detail`);
    return rows?.[0]?.detail ?? null;
  }
  async getPackByOwnerWamid(w) {
    const rows = await this.rest(`wa_bot_pack_sends?owner_wamid=eq.${encodeURIComponent(w)}&select=detail`);
    return rows?.[0]?.detail ?? null;
  }
  async markPackNotice(key) {
    const rows = await this.rest("wa_bot_pack_notices?on_conflict=notice_key", { method: "POST", prefer: "resolution=ignore-duplicates,return=representation", body: { notice_key: key } });
    return Boolean(rows?.length);
  }

  async getSession(chat) {
    const [r] = await this.rest(`wa_bot_sessions?chat=eq.${chat}&select=state`);
    return r?.state ?? null;
  }
  async saveSession(chat, s) {
    await this.rest("wa_bot_sessions?on_conflict=chat", { method: "POST", prefer: "resolution=merge-duplicates", body: { chat, state: s, updated_at: new Date().toISOString() } });
  }

  async isOptedOut(chat) {
    const rows = await this.rest(`contacts?phone=like.*${chat.slice(-10)}&select=opted_out&limit=1`);
    return !!rows?.[0]?.opted_out;
  }
  async setOptOut(chat, value) {
    await this.rest(`contacts?phone=like.*${chat.slice(-10)}`, { method: "PATCH", body: { opted_out: value, ...(value ? {} : { whatsapp_opt_in: true }) } });
  }

  async getJob(key) {
    const [r] = await this.rest(`wa_bot_photo_jobs?job_key=eq.${encodeURIComponent(key)}&select=job`);
    return r?.job ?? null;
  }
  async createJobIfAbsent(job) {
    const rows = await this.rest("wa_bot_photo_jobs?on_conflict=job_key", { method: "POST", prefer: "resolution=ignore-duplicates,return=representation", body: { job_key: job.key, chat: job.chat, status: job.status, created_at_ms: job.createdAt, job } });
    if (rows?.length) return { created: true, job };
    return { created: false, job: await this.getJob(job.key) };
  }
  async saveJob(job) {
    await this.rest(`wa_bot_photo_jobs?job_key=eq.${encodeURIComponent(job.key)}`, { method: "PATCH", body: { status: job.status, job } });
  }
  async recentJobForChat(chat, sinceMs) {
    const rows = await this.rest(`wa_bot_photo_jobs?chat=eq.${chat}&created_at_ms=gte.${sinceMs}&order=created_at_ms.desc&limit=1&select=job`);
    return rows?.[0]?.job ?? null;
  }
  async openJobs() {
    const rows = await this.rest("wa_bot_photo_jobs?status=in.(pending,running,paused_rate_limit)&select=job");
    return (rows || []).map((r) => r.job);
  }

  async saveVisit(v) {
    await this.rest("wa_bot_visit_requests", { method: "POST", body: { chat: v.chat, name: v.name, preferred_slot: v.slot, source: v.source, status: v.status } });
    return v;
  }
  async saveHandoff(h) {
    await this.rest("wa_bot_handoffs", { method: "POST", body: { chat: h.chat, name: h.name, reason: h.reason, details: h.details } });
    return h;
  }
  async addAdminNotification(n) {
    await this.rest("wa_bot_staff_notifications", { method: "POST", body: { kind: n.kind, chat: n.chat, name: n.name, text: n.text } });
  }
  async logMediaError(e) {
    await this.rest("wa_bot_media_errors", { method: "POST", body: { chat: e.chat, job_key: e.jobKey ?? null, public_id: e.public_id ?? null, kind: e.kind, message: e.message } });
  }
  async logMissingSetting(key, context) {
    await this.rest("wa_bot_missing_settings?on_conflict=setting_key", { method: "POST", prefer: "resolution=merge-duplicates", body: { setting_key: key, context, last_seen_at: new Date().toISOString() } });
  }
  async recordStatus(s) {
    await this.rest("wa_bot_status_events", { method: "POST", body: { message_id: s.id, status: s.status, recipient: s.recipient, errors: s.errors ?? null, received_at: new Date(s.receivedAt).toISOString() } });
  }
  async saveTiming(wamid, rec) {
    await this.rest("wa_bot_timings?on_conflict=wamid", { method: "POST", prefer: "resolution=merge-duplicates", body: { wamid, report: rec } });
  }
  async linkOutbound(outId, inboundWamid) {
    await this.rest("wa_bot_outbound_links?on_conflict=out_id", { method: "POST", prefer: "resolution=ignore-duplicates", body: { out_id: outId, inbound_wamid: inboundWamid } });
  }
  async inboundForOutbound(outId) {
    const [r] = await this.rest(`wa_bot_outbound_links?out_id=eq.${encodeURIComponent(outId)}&select=inbound_wamid`);
    return r?.inbound_wamid ?? null;
  }
}

export { normalizeChat };
