// Builds the menu-bot engine for the existing Render service. Returns null (legacy keyword bot keeps answering)
// unless ENQUIRY_BOT=on AND durable storage credentials are present: a restart must never lose inbound events.
//
// Env: ENQUIRY_BOT=on, WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID (already set for the service),
//      BOT_SUPABASE_URL + BOT_SUPABASE_SERVICE_KEY (or SUPABASE_URL + SUPABASE_SERVICE_KEY) with supabase/002_enquiry_bot_tables.sql applied,
//      CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET (CLOUDINARY_CLOUD_NAME / CLOUDINARY_FOLDER optional), ENQUIRY_SETTINGS_FILE (optional JSON overrides).

import fs from "node:fs";
import { Bot } from "./bot.js";
import { Engine } from "./server.js";
import { WhatsAppClient } from "./whatsapp.js";
import { ManifestCache } from "./photos.js";
import { SupabaseStore } from "./supabase-store.js";
import { createSettingsLoader } from "./settings.js";
import { Timings } from "./timing.js";
import { OwnerPack } from "./ownerpack.js";
import { MENU_TITLES } from "./i18n.js";

const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));

export function createEnquiryEngine({ env = process.env, legacyDb, notifyOwner = async () => {}, log = (...a) => console.error(...a), fetchImpl = globalThis.fetch, store: injectedStore } = {}) {
  if (String(env.ENQUIRY_BOT || "").toLowerCase() !== "on") return null;
  const url = env.BOT_SUPABASE_URL || env.SUPABASE_URL;
  const key = env.BOT_SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!injectedStore && (!url || !key)) {
    log("ENQUIRY_BOT=on ignored: no Supabase credentials for durable storage. The legacy keyword bot stays active.");
    return null;
  }
  if (!env.WA_ACCESS_TOKEN || !env.WA_PHONE_NUMBER_ID) {
    log("ENQUIRY_BOT=on ignored: WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID missing.");
    return null;
  }

  const store = injectedStore || new SupabaseStore({ url, key, fetchImpl });

  // Consent rules stay exactly as before: STOP clears the lead's opt_in (offers/reminders) and the customer can still
  // message us and get answers. START opts back in. The existing lead record is the single source of truth.
  const phoneOf = (chat) => chat;
  store.isOptedOut = async () => false;
  store.setOptOut = async (chat, stopped) => {
    if (!legacyDb) return;
    let lead = await legacyDb.getLead("whatsapp", phoneOf(chat));
    if (!lead) lead = await legacyDb.createLead({ channel: "whatsapp", external_id: phoneOf(chat), phone: phoneOf(chat), state: "idle", opt_in: false });
    await legacyDb.updateLead(lead.id, { opt_in: !stopped });
  };

  const approved = readJson("./config/approved-images.json");
  const client = new WhatsAppClient({ token: env.WA_ACCESS_TOKEN, phoneNumberId: env.WA_PHONE_NUMBER_ID, apiVersion: env.WA_API_VERSION || "v21.0", fetchImpl });
  const settings = createSettingsLoader({
    provider: async () => {
      const file = env.ENQUIRY_SETTINGS_FILE;
      return file ? JSON.parse(fs.readFileSync(file, "utf8")) : readJson("./config/settings.example.json");
    },
  });
  const notifier = {
    async notifyFrontDesk({ kind, chat, name, text }) {
      await store.addAdminNotification({ kind, chat, name, text, at: Date.now() }).catch((e) => log("staff notification save failed", e.message));
      await notifyOwner(text).catch(() => {});
    },
  };
  const bot = new Bot({ settings, store, notifier });
  const photoManifest = new ManifestCache({
    cloudName: env.CLOUDINARY_CLOUD_NAME || approved.cloud_name,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
    folder: env.CLOUDINARY_FOLDER || approved.folder,
    approved: approved.images, // exactly the 17 owner-approved images
    fetchImpl,
  });
  // Owner command. Defaults are the numbers the owner gave; each can be overridden by env.
  const authorized = env.OWNER_COMMAND_NUMBER || "919742142166"; // the ONLY number allowed to send commands
  const botNumber = env.BOT_WHATSAPP_NUMBER || "919164440303"; // the WhatsApp API bot number (Meta webhook target)
  const mainEnquiryNumber = env.MAIN_ENQUIRY_NUMBER || "919740018911"; // owner's personal/main enquiry call number
  // Outside-window template stays OFF until the owner confirms Meta approved gfk_requested_gym_details as UTILITY and sets ENQUIRY_PACK_TEMPLATE_ENABLED=on.
  const outsideWindowTemplate = String(env.ENQUIRY_PACK_TEMPLATE_ENABLED || "").toLowerCase() === "on" ? { name: env.ENQUIRY_PACK_TEMPLATE || "gfk_requested_gym_details", language: env.ENQUIRY_PACK_TEMPLATE_LANG || "en", params: [] } : null;
  const settingsWithMenu = { get: async () => ({ ...(await settings.get()), menuTitles: MENU_TITLES.en }) };
  const ownerPack = new OwnerPack({ store, client, settings: settingsWithMenu, authorized, botNumber, mainEnquiryNumber, template: outsideWindowTemplate, log });
  const engine = new Engine({ store, bot, client, settings, timings: new Timings(), photoManifest, repliesAfterStop: true, ownerPack, botNumber, botPhoneNumberId: env.WA_PHONE_NUMBER_ID, log });
  engine.startBackground = () => {
    engine.recoverPending().catch(() => {});
    engine.resumeOpenJobs().catch(() => {});
    setInterval(() => engine.resumeOpenJobs().catch(() => {}), 60_000).unref();
    setInterval(() => engine.recoverPending().catch(() => {}), 30_000).unref();
  };
  return engine;
}
