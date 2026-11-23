// Enquiry capture and messaging preferences.
//
// One person = one normalised phone number. The same number is matched across leads, contacts and members, so a lead
// who later becomes a member keeps their preferences and, above all, their STOP. Members are never modified here:
// an enquiry from a member's number is linked to the member through wa_person_prefs.
// Consent is per scope (motivation, birthday, festival), each recorded with its source and timestamp in wa_consent_log.

import { normalizeIndianMobile } from "./phone.js";
import { istParts, validMonthDay } from "./ist.js";

export const SCOPES = ["motivation", "birthday", "festival"];
const placeholderName = (n) => !n || /^whatsapp enquiry/i.test(n);

export class PeopleService {
  constructor({ store, now = Date.now, log = () => {}, gymId = null }) {
    Object.assign(this, { store, now, log, gymId });
  }

  async consent(phone, scope, value, source) {
    await this.store.logConsent({ phone, scope, value: String(value), source, at: new Date(this.now()).toISOString() });
    const p = (await this.store.getPrefs(phone)) || { consent: {} };
    await this.store.savePrefs(phone, { consent: { ...(p.consent || {}), [scope]: { value: String(value), source, at: new Date(this.now()).toISOString() } } });
  }

  /**
   * Create or update the enquiry for this number. Deduplicates on the normalised number.
   * Never touches a member record. Returns { ok, created, lead, member, prefs }.
   */
  async captureEnquiry({ phone, name = null, nameShared = false, source = "WhatsApp bot", language = null, interest = null, packageName = null, note = null }) {
    const norm = normalizeIndianMobile(phone);
    if (!norm) return { ok: false, reason: "invalid_phone" };
    const key = norm.slice(2);
    const member = await this.store.findMemberByKey(key);
    let lead = await this.store.findLeadByKey(key);
    let created = false;
    const today = istParts(this.now()).date;
    if (!lead) {
      lead = await this.store.createLead({
        name: name || `WhatsApp enquiry ${key.slice(-4)}`,
        mobile: norm,
        phone: norm,
        whatsapp_number: norm,
        source,
        interest,
        package_name: packageName,
        status: "New",
        lead_stage: "Initial Discussion",
        follow_up_date: today,
        follow_up_status: "pending",
        notes: [member ? `Existing member: ${member.name || ""} ${member.member_code || ""}`.trim() : null, note].filter(Boolean).join("\n") || null,
      });
      created = true;
    } else {
      // Fill gaps only. Never overwrite what staff entered, never reset the stage or follow-up status.
      const patch = {};
      // A name the customer typed replaces a placeholder or the WhatsApp profile name we saved earlier; never a name staff edited.
      const prev = (await this.store.getPrefs(norm))?.name;
      if (name && (placeholderName(lead.name) || (nameShared && prev && lead.name === prev && name !== prev))) patch.name = name;
      if (packageName && !lead.package_name) patch.package_name = packageName;
      if (interest && !lead.interest) patch.interest = interest;
      if (Object.keys(patch).length) lead = await this.store.updateLead(lead.id, patch);
    }
    const contact = await this.store.findContactByKey(key);
    const prefs = await this.store.savePrefs(norm, {
      lead_id: lead.id,
      member_id: member?.id ?? null,
      contact_id: contact?.id ?? null,
      ...(name ? { name } : {}),
      ...(language ? { language } : {}),
    });
    return { ok: true, created, lead, member, prefs };
  }

  /** Remember what the customer looked at (interested package). */
  async noteInterest(phone, packageName) {
    const norm = normalizeIndianMobile(phone);
    if (!norm || !packageName) return;
    const prefs = await this.store.getPrefs(norm);
    if (!prefs?.lead_id) return;
    await this.store.updateLead(prefs.lead_id, { package_name: packageName, interest: packageName });
  }

  async setLanguage(phone, language) {
    await this.store.savePrefs(phone, { language: language === "kn" ? "kn" : "en" });
  }

  async stopped(phone) {
    const p = await this.store.getPrefs(phone);
    return Boolean(p?.stopped_at);
  }

  /** Motivation: "daily" | "weekly" | "off". */
  async setMotivation(phone, mode, source = "whatsapp_bot") {
    if (!["daily", "weekly", "off"].includes(mode)) throw new Error("mode must be daily, weekly or off");
    await this.store.savePrefs(phone, { motivation: mode });
    await this.consent(phone, "motivation", mode, source);
  }

  async setFestival(phone, on, source = "whatsapp_bot") {
    await this.store.savePrefs(phone, { festival_greetings: Boolean(on) });
    await this.consent(phone, "festival", on ? "on" : "off", source);
  }

  /** Birthday wishes are optional; only a month and a day are stored, never a year. */
  async setBirthday(phone, { month, day } = {}, source = "whatsapp_bot") {
    if (!validMonthDay(month, day)) return { ok: false, reason: "invalid_date" };
    await this.store.savePrefs(phone, { birth_month: month, birth_day: day, birthday_wishes: true });
    await this.consent(phone, "birthday", `on:${month}-${day}`, source);
    return { ok: true };
  }
  async clearBirthday(phone, source = "whatsapp_bot") {
    await this.store.savePrefs(phone, { birth_month: null, birth_day: null, birthday_wishes: false });
    await this.consent(phone, "birthday", "off", source);
  }

  /**
   * STOP: withdraw everything. Preferences are switched off (a later START does not silently turn them back on),
   * the person's contact row is marked opted out so the ERP's own automations stop too, and this follows the number
   * whether it belongs to a lead or a member.
   */
  async stop(phone, source = "whatsapp_stop") {
    const at = new Date(this.now()).toISOString();
    await this.store.savePrefs(phone, { stopped_at: at, motivation: "off", birthday_wishes: false, festival_greetings: false });
    for (const scope of SCOPES) await this.store.logConsent({ phone, scope, value: "stop", source, at });
    await this.store.setContactOptedOut(phone.slice(2), true, source);
  }

  /** START clears the stop flag only. Each preference has to be chosen again. */
  async start(phone, source = "whatsapp_start") {
    await this.store.savePrefs(phone, { stopped_at: null });
    await this.store.logConsent({ phone, scope: "all", value: "start", source, at: new Date(this.now()).toISOString() });
    await this.store.setContactOptedOut(phone.slice(2), false, source);
  }

  async summary(phone) {
    const p = (await this.store.getPrefs(phone)) || {};
    return { motivation: p.motivation || "off", birthday: Boolean(p.birthday_wishes), birthdayDate: p.birth_month ? `${p.birth_day}/${p.birth_month}` : null, festival: Boolean(p.festival_greetings), stopped: Boolean(p.stopped_at), language: p.language || "en" };
  }
}
