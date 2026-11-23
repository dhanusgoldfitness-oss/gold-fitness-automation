// Owner controls for scheduled messages, over WhatsApp. Only OWNER_COMMAND_NUMBER can use them; everything else is
// ignored exactly like the enquiry-pack command. Every command starts with SCHED so it can never clash with a customer keyword.
//
//   SCHED LIST                              campaigns, state, send time
//   SCHED PREVIEW <campaign>                message, audience today, cost, what blocks enabling
//   SCHED ENABLE|DISABLE <campaign>
//   SCHED TIME <campaign> HH:MM             IST, applies from the next occurrence
//   SCHED STATUS <campaign>                 queue counts (queued/accepted/delivered/failed...)
//   SCHED MSG LIST | SEED | ADD <en|kn> <workout|consistency|recovery> <text> | APPROVE <id> | REJECT <id>
//   SCHED EVENTS                            upcoming calendar entries
//   SCHED EVENT ADD <YYYY-MM-DD> <festival|national|holiday> <English name> [| Kannada name]
//   SCHED EVENT VERIFY|CANCEL <id>          a festival greets only after the owner verifies its date
//   SCHED CLOSE <YYYY-MM-DD> <reason>       gym closed that day (sends the closure notice)
//   SCHED HOURS <YYYY-MM-DD> <hours>        revised hours that day (sends the revised-hours notice)
//   SCHED OPEN <YYYY-MM-DD>                 withdraw a closure / revised hours

import { CAMPAIGNS, CAMPAIGN_KEYS } from "./campaigns.js";
import { istParts, addDays } from "./ist.js";

const digits = (s) => String(s ?? "").replace(/\D/g, "");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d) => DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const key = (s) => String(s || "").toLowerCase();

export class SchedAdmin {
  constructor({ campaigns, store, authorized, seedMessages = [], now = Date.now, log = () => {} }) {
    Object.assign(this, { campaigns, store, authorized: digits(authorized), seedMessages, now, log });
  }

  match(chat, msg) {
    if (msg?.type !== "text") return null;
    const text = String(msg.text?.body || "").trim();
    if (!/^sched(\s|$)/i.test(text)) return null;
    if (!this.authorized || digits(chat) !== this.authorized) {
      this.log("ignored scheduled-message command from an unauthorized sender", digits(chat).slice(-4));
      return null;
    }
    return { text };
  }

  async run(text) {
    try {
      return await this.exec(text.replace(/^sched\s*/i, "").trim());
    } catch (e) {
      this.log("sched command failed", e.message);
      return `Could not do that: ${e.message}`;
    }
  }

  async exec(rest) {
    const [cmd = "help", ...args] = rest.split(/\s+/);
    const c = key(cmd);
    if (c === "help" || c === "") return "SCHED LIST | PREVIEW <campaign> | ENABLE <campaign> | DISABLE <campaign> | TIME <campaign> HH:MM | STATUS <campaign> | MSG LIST/SEED/ADD/APPROVE/REJECT | EVENTS | EVENT ADD/VERIFY/CANCEL | CLOSE <date> <reason> | HOURS <date> <hours> | OPEN <date>";
    if (c === "list") return this.list();
    if (["preview", "enable", "disable", "time", "status"].includes(c)) return this.campaignCmd(c, args);
    if (c === "msg") return this.msg(args);
    if (c === "events") return this.events();
    if (c === "event") return this.event(args);
    if (c === "close") return this.closure(args, "close");
    if (c === "hours") return this.closure(args, "hours");
    if (c === "open") return this.reopen(args);
    return "Unknown SCHED command. Send SCHED HELP.";
  }

  async list() {
    const lines = [];
    for (const k of CAMPAIGN_KEYS) {
      const cfg = await this.campaigns.config(k);
      lines.push(`${cfg.enabled ? "ON " : "OFF"} ${k} - ${CAMPAIGNS[k].label}, ${cfg.send_time} IST`);
    }
    return lines.join("\n");
  }

  async campaignCmd(c, args) {
    const k = key(args[0]);
    if (!CAMPAIGNS[k]) return `Campaign must be one of: ${CAMPAIGN_KEYS.join(", ")}`;
    if (c === "disable") { await this.campaigns.disable(k, "owner"); return `${k} is OFF. Messages already queued for it will be cancelled before sending.`; }
    if (c === "time") { const r = await this.campaigns.setTime(k, args[1]); return r.ok ? `${k} will send at ${r.time} IST from the next occurrence.` : "Time must look like 07:00 (24-hour, IST)."; }
    if (c === "status") return `${k}: ${JSON.stringify(await this.campaigns.queueSummary(k))}`;
    if (c === "enable") {
      const r = await this.campaigns.enable(k, "owner");
      return r.ok ? `${k} is ON.` : `${k} was NOT enabled:\n- ${r.blockers.join("\n- ")}`;
    }
    const p = await this.campaigns.preview(k);
    const cost = p.cost.available ? `${p.cost.currency} ${p.cost.total} (${p.cost.category})` : `not available (${p.cost.category} template)`;
    const tpl = p.templates.map((t) => `${t.name} ${t.lang}: ${t.status}`).join("; ");
    return [`PREVIEW ${k} (${p.enabled ? "ON" : "OFF"}, ${p.send_time} IST)`, `EN: ${p.sample.en}`, `KN: ${p.sample.kn}`, `Audience today: ${p.audienceToday}${Object.keys(p.skipped).length ? ` (skipped ${JSON.stringify(p.skipped)})` : ""}`, `Estimated cost: ${cost}`, `Templates: ${tpl}`, p.canEnable ? `Ready. Send SCHED ENABLE ${k} to turn it on.` : `Cannot enable yet:\n- ${p.blockers.join("\n- ")}`].join("\n");
  }

  async msg(args) {
    const sub = key(args[0]);
    if (sub === "list") {
      const all = await this.store.listMotivation();
      return all.length ? all.map((m) => `${m.id} [${m.lang}/${m.category}] ${m.approved ? "APPROVED" : "draft"}: ${m.text.slice(0, 60)}`).join("\n") : "No messages yet. Send SCHED MSG SEED to load the drafts.";
    }
    if (sub === "seed") {
      const have = new Set((await this.store.listMotivation()).map((m) => m.id));
      let n = 0;
      for (const m of this.seedMessages) if (!have.has(m.id)) { await this.store.saveMotivation({ ...m, approved: false }); n++; }
      return `Loaded ${n} draft messages. None is approved yet. Kannada drafts need a native review first.`;
    }
    if (sub === "add") {
      const lang = key(args[1]);
      const category = key(args[2]);
      const text = args.slice(3).join(" ").trim();
      if (!["en", "kn"].includes(lang) || !["workout", "consistency", "recovery"].includes(category) || text.length < 10 || text.length > 300) return "Use: SCHED MSG ADD <en|kn> <workout|consistency|recovery> <text, 10-300 characters>";
      const m = await this.store.saveMotivation({ lang, category, text, approved: false });
      return `Saved draft ${m.id}. Send SCHED MSG APPROVE ${m.id} to approve it.`;
    }
    if (sub === "approve" || sub === "reject") {
      const m = (await this.store.listMotivation()).find((x) => x.id === args[1]);
      if (!m) return "No message with that id. Send SCHED MSG LIST.";
      await this.store.saveMotivation({ id: m.id, approved: sub === "approve" });
      return `${m.id} is ${sub === "approve" ? "APPROVED" : "not approved"}.`;
    }
    return "SCHED MSG LIST | SEED | ADD <en|kn> <category> <text> | APPROVE <id> | REJECT <id>";
  }

  async events() {
    const from = istParts(this.now()).date;
    const evs = (await this.store.listEvents({ from, to: addDays(from, 120) })).filter((e) => !e.cancelled).sort((a, b) => a.event_date.localeCompare(b.event_date));
    return evs.length ? evs.map((e) => `${e.id}: ${e.event_date} ${e.name_en || e.type}${e.gym_closed ? " [GYM CLOSED]" : ""}${e.revised_hours ? ` [HOURS ${e.revised_hours}]` : ""}${e.type === "festival" || e.type === "national" ? (e.verified ? " verified" : " NOT verified") : ""}`).join("\n") : "No calendar entries in the next 120 days.";
  }

  async event(args) {
    const sub = key(args[0]);
    if (sub === "add") {
      const date = args[1];
      const type = key(args[2]);
      const names = args.slice(3).join(" ").split("|").map((s) => s.trim());
      if (!validDate(date) || !["festival", "national", "holiday"].includes(type) || !names[0]) return "Use: SCHED EVENT ADD <YYYY-MM-DD> <festival|national|holiday> <English name> [| Kannada name]";
      const id = `own-${date}-${type}-${names[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      const e = await this.store.saveEvent({ id, event_date: date, type, name_en: names[0], name_kn: names[1] || null, greet: type !== "holiday", verified: false, gym_closed: false, revised_hours: null, cancelled: false, source: "owner" });
      return `Added ${e.id}. It will NOT send greetings until you verify the date: SCHED EVENT VERIFY ${e.id}`;
    }
    const e = await this.store.getEvent(args[1]);
    if (!e) return "No calendar entry with that id. Send SCHED EVENTS.";
    if (sub === "verify") { await this.store.saveEvent({ id: e.id, verified: true }); return `${e.id} verified for ${e.event_date}.`; }
    if (sub === "cancel") { await this.store.saveEvent({ id: e.id, cancelled: true }); return `${e.id} cancelled.`; }
    return "SCHED EVENT ADD | VERIFY <id> | CANCEL <id>";
  }

  async closure(args, mode) {
    const date = args[0];
    const text = args.slice(1).join(" ").trim();
    if (!validDate(date) || !text) return mode === "close" ? "Use: SCHED CLOSE <YYYY-MM-DD> <reason>" : "Use: SCHED HOURS <YYYY-MM-DD> <hours, e.g. 7:00 AM to 12:00 PM>";
    if (date < istParts(this.now()).date) return "That date has already passed.";
    const id = `closure-${date}`;
    const cur = (await this.store.getEvent(id)) || {};
    const patch = mode === "close" ? { gym_closed: true, reason_en: text, reason_kn: null } : { revised_hours: text };
    const changed = mode === "close" ? !cur.gym_closed || cur.reason_en !== text : cur.revised_hours !== text;
    await this.store.saveEvent({ id, event_date: date, type: "closure", name_en: "Gym schedule change", greet: false, verified: true, cancelled: false, source: "owner", gym_closed: false, revised_hours: null, ...cur, ...patch, notice_rev: (cur.notice_rev ?? 0) + (changed && cur.id ? 1 : 0) });
    const k = mode === "close" ? "closure_notice" : "revised_hours";
    const cfg = await this.campaigns.config(k);
    return `Recorded: ${mode === "close" ? "gym closed" : `revised hours ${text}`} on ${date}. ${cfg.enabled ? "The notice goes to active members and open bookings." : `Nothing will be sent: the ${k} campaign is OFF (send SCHED PREVIEW ${k}).`}`;
  }

  async reopen(args) {
    const e = await this.store.getEvent(`closure-${args[0]}`);
    if (!e) return "No closure or revised hours recorded for that date.";
    await this.store.saveEvent({ id: e.id, gym_closed: false, revised_hours: null, notice_rev: (e.notice_rev ?? 0) + 1 });
    return `Closure/revised hours for ${args[0]} withdrawn. Notices not yet sent are cancelled.`;
  }
}
