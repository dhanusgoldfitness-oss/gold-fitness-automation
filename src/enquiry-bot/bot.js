// Menu state machine. Pure rule-based routing: no AI in the menu path. Taps and typed numbers resolve to the same
// stable ids, and typed numbers are read against the menu the customer is currently in.

import { t, mainMenuText, MENU_TITLES } from "./i18n.js";
import { renderPlan, PLAN_GUIDE, rupees } from "./plans.js";
import { locationReply } from "./location.js";
import { normalizeIndianMobile } from "./phone.js";
import { parseBirthday } from "./ist.js";

const GREETINGS = new Set(["hi", "hii", "hiii", "hello", "hey", "hlo", "menu", "start", "namaste", "namaskara", "ನಮಸ್ಕಾರ", "good morning", "good afternoon", "good evening", "0"]);

const DIGITS = {
  main: { 1: "menu_1", 2: "menu_2", 3: "menu_3", 4: "menu_4", 5: "menu_5", 6: "menu_6", 7: "menu_7", 8: "menu_8", 9: "menu_9" },
  pt: { 1: "pt_silver", 2: "pt_gold", 3: "pt_3p9" },
  after_pt: { 1: "after_owner", 2: "after_visit", 3: "menu_main" },
  after_pt_skip: { 1: "photos_again", 2: "after_visit", 3: "menu_main" },
  plans: { 1: "plans_visit", 2: "plans_staff" },
  renew: { 1: "renew_request" },
};

// Deterministic keyword fallback for typed questions (English and Kannada written in English letters).
const KEYWORDS = [
  { id: "plan_guide", words: ["which plan", "best plan", "recommend", "suggest", "difference", "confused", "which one", "choose"] },
  { id: "photos_again", words: ["photos", "photo", "pictures", "transformation", "transformations"] },
  { id: "menu_1", words: ["fee", "fees", "price", "prices", "plan", "plans", "cost", "charges", "estu", "bele", "ಶುಲ್ಕ", "ಬೆಲೆ"] },
  { id: "menu_3", words: ["timing", "timings", "hours", "open", "location", "address", "where", "elli", "ಎಲ್ಲಿ", "ಸಮಯ"] },
  { id: "menu_4", words: ["pt", "personal training", "personal"] },
  { id: "menu_5", words: ["renew", "renewal", "expiry", "expire"] },
  { id: "menu_8", words: ["owner"] },
  { id: "menu_6", words: ["front desk", "staff"] },
  { id: "menu_2", words: ["visit", "tomorrow", "join", "admission", "beku"] },
];

function keywordId(lower) {
  const tokens = new Set(lower.split(/[^\p{L}\p{N}+]+/u).filter(Boolean));
  for (const k of KEYWORDS) {
    if (k.words.some((w) => (w.includes(" ") ? lower.includes(w) : tokens.has(w)))) return k.id;
  }
  return null;
}

const PT_KEYS = { pt_silver: "silver", pt_gold: "gold", pt_3p9: "three_plus_nine" };

const text = (body) => ({ type: "text", body });
const mainMenu = (lang) => ({ type: "list", body: mainMenuText(lang), button: t(lang, "viewOptions"), rows: MENU_TITLES[lang].map((title, i) => ({ id: `menu_${i + 1}`, title })) });
const ptButtons = (lang) => ({
  type: "buttons",
  body: t(lang, "ptBody"),
  buttons: [
    { id: "pt_silver", title: "Silver PT" },
    { id: "pt_gold", title: "Gold PT" },
    { id: "pt_3p9", title: lang === "kn" ? "3+9 ಪ್ಯಾಕೇಜ್" : "3+9 Package" },
  ],
});
const afterButtons = (lang, body) => ({
  type: "buttons",
  body,
  buttons: [
    { id: "after_owner", title: t(lang, "btnOwner") },
    { id: "after_visit", title: t(lang, "btnVisit") },
    { id: "menu_main", title: t(lang, "btnMain") },
  ],
});
const skipButtons = (lang) => ({
  type: "buttons",
  body: t(lang, "photosSkipped"),
  buttons: [
    { id: "photos_again", title: t(lang, "btnPhotos") },
    { id: "after_visit", title: t(lang, "btnVisit") },
    { id: "menu_main", title: t(lang, "btnMain") },
  ],
});
const plansButtons = (lang) => ({
  type: "buttons",
  body: t(lang, "plansOffer"),
  buttons: [
    { id: "plans_visit", title: t(lang, "btnVisit") },
    { id: "plans_staff", title: t(lang, "btnStaff") },
  ],
});

function parseInbound(msg) {
  if (msg.type === "interactive") {
    const r = msg.interactive?.list_reply || msg.interactive?.button_reply;
    return { id: r?.id ?? null };
  }
  if (msg.type === "button") {
    // Quick-reply from the gfk_requested_gym_details template ("View Gym Details"): a repeat tap just shows the menu again.
    const label = String(msg.button?.payload || msg.button?.text || "").trim();
    return { id: /^view gym details$/i.test(label) ? "menu_main" : label || null };
  }
  if (msg.type === "text") return { text: String(msg.text?.body || "").trim() };
  return { unsupported: true };
}


export class Bot {
  constructor({ settings, store, members = { find: async () => null }, notifier = { notifyFrontDesk: async () => {} }, now = Date.now, people = null }) {
    Object.assign(this, { settings, store, members, notifier, now, people });
  }

  newSession() {
    return { menu: "main", lang: "en", step: null, data: {}, status: "bot", staffSince: null };
  }

  async handle({ chat, name, msg }) {
    const settings = await this.settings.get();
    const session = (await this.store.getSession(chat)) ?? this.newSession();
    const lang = () => session.lang;
    const p = parseInbound(msg);
    let id = p.id ?? null;
    const raw = p.text ?? null;
    const lower = raw != null ? raw.toLowerCase().replace(/[!.?,।]+$/g, "").trim() : null;
    let out;

    if (!id && lower != null && GREETINGS.has(lower)) id = "menu_main";

    if (!id && lower != null && !session.step && this.people) {
      const pref = await this.prefCommand({ chat, lower, session });
      if (pref) {
        session.updatedAt = this.now();
        await this.store.saveSession(chat, session);
        return pref;
      }
    }

    if (!id && lower != null && session.step) {
      out = await this.step({ chat, name, settings, session, input: raw });
    } else {
      if (!id && lower != null) {
        if (/^\d+$/.test(lower)) id = DIGITS[session.menu]?.[Number(lower)] ?? null;
        else id = keywordId(lower);
      }
      if (id) {
        session.step = null;
        out = await this.dispatch({ id, chat, name, settings, session });
      } else {
        out = [text(t(lang(), "invalid")), this.currentMenu(session)];
      }
    }
    session.updatedAt = this.now();
    await this.store.saveSession(chat, session);
    return out;
  }

  currentMenu(session) {
    const l = session.lang;
    if (session.menu === "pt") return ptButtons(l);
    if (session.menu === "after_pt_skip") return skipButtons(l);
    if (session.menu === "after_pt") return afterButtons(l, t(l, "afterPhotos"));
    if (session.menu === "plans") return plansButtons(l);
    return mainMenu(l);
  }

  async missing(key, context) {
    await this.store.logMissingSetting(key, context);
  }

  staffLinks(settings, l) {
    return `${t(l, "staffContacts")}\n${settings.owners.map((o) => `${o.phone} - ${o.link}`).join("\n")}`;
  }

  async dispatch({ id, chat, name, settings, session }) {
    const l = session.lang;
    switch (id) {
      case "menu_main":
        session.menu = "main";
        session.data = {};
        return [mainMenu(l)];

      case "menu_1": {
        session.menu = "plans";
        session.interest = { interest: "Membership plans" };
        const r = renderPlan("general", l, settings.plans?.general, settings.tax);
        for (const k of r.missing) await this.missing(k, "membership price");
        return [text(`${t(l, "plansHeader")}\n\n${r.text}`), plansButtons(l)];
      }

      case "plan_guide":
        session.menu = "plans";
        return [text(PLAN_GUIDE[l === "kn" ? "kn" : "en"]), plansButtons(l)];

      case "menu_2":
      case "after_visit":
      case "plans_visit":
        session.menu = "visit";
        session.step = "visit_name";
        session.data = {};
        return [text(t(l, "visitAskName"))];

      case "menu_3": {
        session.menu = "main";
        return [text(locationReply(settings, l))];
      }

      case "menu_4":
        session.menu = "pt";
        return [ptButtons(l)];

      case "pt_silver":
      case "pt_gold":
      case "pt_3p9": {
        const key = PT_KEYS[id];
        session.menu = "after_pt";
        session.lastPackage = key;
        session.interest = { interest: "Personal Training", packageName: { silver: "Silver PT", gold: "Gold PT", three_plus_nine: "3+9 Package" }[key] };
        const r = renderPlan(key, l, settings.plans?.[key], settings.tax);
        for (const k of r.missing) await this.missing(k, "personal training price");
        return [text(r.text), { type: "photo_job", packageKey: key }];
      }

      case "photos_again": {
        const key = session.lastPackage;
        if (!key) {
          session.menu = "pt";
          return [ptButtons(l)];
        }
        session.menu = "after_pt";
        return [text(t(l, "photosAgainAck")), { type: "photo_job", packageKey: key, force: true }];
      }

      case "menu_5":
        session.menu = "renew";
        session.step = "renew_id";
        return [text(t(l, "renewAskId"))];

      case "renew_request": {
        const m = session.data?.member;
        await this.handoff({ chat, name, settings, session, reason: "renewal_request", details: m ? `${m.name} / ${m.plan}` : "" });
        return [text(t(l, "renewRequested"))];
      }

      case "menu_6":
      case "plans_staff":
        await this.handoff({ chat, name, settings, session, reason: "front_desk", details: "" });
        return [text(t(l, "handoff"))];

      case "menu_7": {
        session.menu = "main";
        const links = [["Website", settings.website], ["Instagram", settings.instagram], ["Facebook", settings.facebook], ["YouTube", settings.youtube]];
        const lines = [t(l, "webHeader")];
        for (const [label, url] of links) {
          if (url) lines.push(`${label}: ${url}`);
          else await this.missing(label.toLowerCase(), "official social link");
        }
        lines.push("", t(l, "menuFooter"));
        return [text(lines.join("\n"))];
      }

      case "menu_8":
      case "after_owner": {
        session.menu = "main";
        const lines = [t(l, "ownerHeader"), ...settings.owners.map((o) => `${o.phone}: ${o.link}`), "", t(l, "menuFooter")];
        return [text(lines.join("\n"))];
      }

      case "pref_mot_daily":
      case "pref_mot_weekly":
      case "pref_mot_off":
        return this.setMotivation({ chat, id, session });

      case "menu_9":
        session.lang = l === "en" ? "kn" : "en";
        session.menu = "main";
        return [text(t(session.lang, "langSwitched")), mainMenu(session.lang)];

      default:
        return [text(t(l, "invalid")), this.currentMenu(session)];
    }
  }

  async step({ chat, name, settings, session, input }) {
    const l = session.lang;
    if (session.step === "visit_name") {
      session.data.name = input.slice(0, 60);
      session.step = "visit_slot";
      return [text(t(l, "visitAskSlot", { name: session.data.name }))];
    }
    if (session.step === "visit_slot") {
      const slot = input.slice(0, 120);
      const visit = { chat, name: session.data.name, slot, source: "whatsapp_bot", status: "requested", createdAt: this.now() };
      await this.store.saveVisit(visit);
      await this.notifier.notifyFrontDesk({ kind: "visit_request", chat, name: visit.name, text: `Visit request from ${visit.name} (${chat}): ${slot}` });
      session.step = null;
      session.menu = "main";
      const done = text(t(l, "visitDone", { name: visit.name, slot }));
      session.shareName = visit.name; // the name the customer chose to share; used for their enquiry record
      session.data = {};
      return this.people ? [done, text(t(l, "birthdayAsk"))] : [done];
    }
    if (session.step === "renew_id") {
      const member = await this.members.find({ phone: chat, memberCode: input.trim() });
      session.step = null;
      if (!member) {
        await this.handoff({ chat, name, settings, session, reason: "renewal_unmatched", details: "member id did not match this number" });
        return [text(t(l, "renewUnmatched"))];
      }
      session.data.member = { name: member.name, plan: member.plan, expiry: member.expiry };
      session.menu = "renew";
      return [
        {
          type: "buttons",
          body: t(l, "renewVerified", { name: member.name, plan: member.plan, expiry: member.expiry }),
          buttons: [
            { id: "renew_request", title: t(l, "btnRenew") },
            { id: "menu_main", title: t(l, "btnMain") },
          ],
        },
      ];
    }
    session.step = null;
    return [text(t(l, "invalid")), this.currentMenu(session)];
  }

  // ---- messaging preferences (motivation, birthday, festival). Typed keywords work at any time; STOP wins over all.
  async prefCommand({ chat, lower, session }) {
    const m = /^(updates|preferences|motivation|birthday|festival)(?:\s+(.+))?$/.exec(lower);
    if (!m) return null;
    const l = session.lang;
    const phone = normalizeIndianMobile(chat);
    if (!phone) return null;
    if (await this.people.stopped(phone)) return [text(t(l, "stoppedNote"))];
    await this.people.captureEnquiry({ phone, language: l, source: "WhatsApp bot" }); // preferences need a record to hang on
    const [, cmd, arg = ""] = m;
    if (cmd === "birthday") {
      if (arg === "off") { await this.people.clearBirthday(phone); return [text(t(l, "birthdayOff"))]; }
      const b = parseBirthday(arg);
      if (!b) return [text(t(l, "birthdayInvalid"))];
      await this.people.setBirthday(phone, b);
      return [text(t(l, "birthdaySaved", { date: `${b.day}/${b.month}` }))];
    }
    if (cmd === "festival") {
      if (arg !== "on" && arg !== "off") return [text(t(l, "prefsMore"))];
      await this.people.setFestival(phone, arg === "on");
      return [text(t(l, arg === "on" ? "festivalOn" : "festivalOff"))];
    }
    if (cmd === "motivation" && ["daily", "weekly", "off"].includes(arg)) {
      await this.people.setMotivation(phone, arg);
      return [text(t(l, "prefsSaved"))];
    }
    const s = await this.people.summary(phone);
    const v = (b) => t(l, b ? "valOn" : "valOff");
    const mot = s.motivation === "off" ? t(l, "valOff") : t(l, s.motivation === "daily" ? "valDaily" : "valWeekly");
    return [
      text(t(l, "prefsHeader", { motivation: mot, birthday: s.birthday ? s.birthdayDate : t(l, "valOff"), festival: v(s.festival) })),
      { type: "buttons", body: t(l, "prefsMotivationAsk"), buttons: [{ id: "pref_mot_daily", title: t(l, "btnDaily") }, { id: "pref_mot_weekly", title: t(l, "btnWeekly") }, { id: "pref_mot_off", title: t(l, "btnOff") }] },
      text(t(l, "prefsMore")),
    ];
  }

  async setMotivation({ chat, id, session }) {
    const l = session.lang;
    const phone = normalizeIndianMobile(chat);
    if (!this.people || !phone) return [text(t(l, "invalid")), this.currentMenu(session)];
    if (await this.people.stopped(phone)) return [text(t(l, "stoppedNote"))];
    await this.people.captureEnquiry({ phone, language: l, source: "WhatsApp bot" });
    await this.people.setMotivation(phone, id.replace("pref_mot_", ""));
    return [text(t(l, "prefsSaved"))];
  }

  async handoff({ chat, name, settings, session, reason, details }) {
    await this.store.saveHandoff({ chat, name, reason, details, at: this.now() });
    session.status = "staff";
    session.staffSince = this.now();
    session.step = null;
    session.menu = "main";
    await this.notifier.notifyFrontDesk({ kind: "handoff", chat, name, text: `Customer ${name || chat} (${chat}) needs staff: ${reason}${details ? ` (${details})` : ""}` });
  }

  /** Offered instead of repeating the batch during the cooldown. */
  async photosSkipped(chat) {
    const session = (await this.store.getSession(chat)) ?? this.newSession();
    session.menu = "after_pt_skip";
    await this.store.saveSession(chat, session);
    return skipButtons(session.lang);
  }

  /** Buttons offered after the last photo is accepted (ok) or when photos could not be sent. */
  async afterPhotos(chat, ok) {
    const session = (await this.store.getSession(chat)) ?? this.newSession();
    session.menu = "after_pt";
    await this.store.saveSession(chat, session);
    return afterButtons(session.lang, ok ? t(session.lang, "afterPhotos") : t(session.lang, "photosUnavailable"));
  }
}
