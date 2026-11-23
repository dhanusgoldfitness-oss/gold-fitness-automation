// In-memory store used by the tests and for local runs. SupabaseStore (supabase-store.js) implements the same
// interface for production. Every method is async so the two are interchangeable.

export function normalizeChat(from) {
  return String(from || "").replace(/\D/g, "");
}

export class MemoryStore {
  constructor() {
    this.inbound = new Map(); // wamid -> {wamid, chat, type, payload, status, receivedAt}
    this.sessions = new Map();
    this.optOuts = new Set();
    this.jobs = new Map(); // jobKey -> job
    this.visits = [];
    this.handoffs = [];
    this.adminNotifications = [];
    this.mediaErrors = [];
    this.missingSettings = [];
    this.statuses = []; // delivery status events (never menu input)
    this.timings = new Map();
    this.outboundLinks = new Map(); // outbound wamid -> inbound wamid
  }

  async insertInbound(ev) {
    const existing = this.inbound.get(ev.wamid);
    if (existing) return { inserted: false, status: existing.status };
    this.inbound.set(ev.wamid, { ...ev, status: "received" });
    return { inserted: true, status: "received" };
  }
  async claimInbound(wamid) {
    const ev = this.inbound.get(wamid);
    if (!ev || ev.status !== "received") return null;
    ev.status = "processing";
    return ev;
  }
  async finishInbound(wamid, status = "processed") {
    const ev = this.inbound.get(wamid);
    if (ev) ev.status = status;
  }
  async pendingInbound(olderThanMs, now) {
    return [...this.inbound.values()].filter((e) => e.status === "received" && now - e.receivedAt >= olderThanMs);
  }

  async getSession(chat) {
    const s = this.sessions.get(chat);
    return s ? structuredClone(s) : null;
  }
  async saveSession(chat, s) {
    this.sessions.set(chat, structuredClone(s));
  }

  async isOptedOut(chat) {
    return this.optOuts.has(chat);
  }
  async setOptOut(chat, value) {
    if (value) this.optOuts.add(chat);
    else this.optOuts.delete(chat);
  }

  async getJob(key) {
    const j = this.jobs.get(key);
    return j ? structuredClone(j) : null;
  }
  async createJobIfAbsent(job) {
    if (this.jobs.has(job.key)) return { created: false, job: structuredClone(this.jobs.get(job.key)) };
    this.jobs.set(job.key, structuredClone(job));
    return { created: true, job: structuredClone(job) };
  }
  async saveJob(job) {
    this.jobs.set(job.key, structuredClone(job));
  }
  async recentJobForChat(chat, sinceMs) {
    const all = [...this.jobs.values()].filter((j) => j.chat === chat && j.createdAt >= sinceMs && j.status !== "failed");
    return all.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }
  async lastInboundAt(chat) {
    const times = [...this.inbound.values()].filter((e) => e.chat === chat).map((e) => e.receivedAt);
    return times.length ? Math.max(...times) : null;
  }
  async recordPack(rec) {
    this.packs = this.packs || new Map();
    this.packs.set(rec.ownerWamid, structuredClone(rec));
  }
  async recentPack(client, sinceMs) {
    return [...(this.packs?.values() || [])].filter((p) => p.client === client && p.createdAt >= sinceMs && ["accepted", "uncertain"].includes(p.status)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }
  async getPackByOwnerWamid(w) {
    return this.packs?.get(w) || null;
  }
  async markPackNotice(key) {
    this.packNotices = this.packNotices || new Set();
    if (this.packNotices.has(key)) return false;
    this.packNotices.add(key);
    return true;
  }
  async openJobForChat(chat) {
    return [...this.jobs.values()].filter((j) => j.chat === chat && ["pending", "running", "paused_rate_limit"].includes(j.status)).map((j) => structuredClone(j))[0] || null;
  }
  async openJobs() {
    return [...this.jobs.values()].filter((j) => j.status === "pending" || j.status === "running" || j.status === "paused_rate_limit").map((j) => structuredClone(j));
  }

  async saveVisit(v) {
    this.visits.push(v);
    return v;
  }
  async saveHandoff(h) {
    this.handoffs.push(h);
    return h;
  }
  async addAdminNotification(n) {
    this.adminNotifications.push(n);
  }
  async logMediaError(e) {
    this.mediaErrors.push(e);
  }
  async logMissingSetting(key, context) {
    this.missingSettings.push({ key, context });
  }
  async recordStatus(s) {
    this.statuses.push(s);
  }
  async saveTiming(wamid, rec) {
    this.timings.set(wamid, structuredClone(rec));
  }
  async linkOutbound(outId, inboundWamid) {
    this.outboundLinks.set(outId, inboundWamid);
  }
  async inboundForOutbound(outId) {
    return this.outboundLinks.get(outId) || null;
  }
}
