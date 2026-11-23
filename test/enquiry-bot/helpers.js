import crypto from "node:crypto";
import fs from "node:fs";
import { Bot } from "../../src/enquiry-bot/bot.js";
import { Engine, createApp } from "../../src/enquiry-bot/server.js";
import { WhatsAppClient } from "../../src/enquiry-bot/whatsapp.js";
import { ManifestCache } from "../../src/enquiry-bot/photos.js";
import { MemoryStore } from "../../src/enquiry-bot/store.js";
import { createSettingsLoader, mergeSettings, BASE } from "../../src/enquiry-bot/settings.js";
import { Timings } from "../../src/enquiry-bot/timing.js";

export const approved = JSON.parse(fs.readFileSync(new URL("../../src/enquiry-bot/config/approved-images.json", import.meta.url), "utf8"));
export const APP_SECRET = "test-app-secret";
export const TOKEN = "EAAB-super-secret-token";

// BASE already carries the owner's plans, prices, hours, address and links; tests add the not-yet-verified links.
export const FULL_SETTINGS = {
  facebook: "https://facebook.example/gfk",
  youtube: "https://youtube.example/gfk",
};

/** Fake Meta Graph API. Records every request; failures can be scripted per call. */
export function fakeMeta({ script = [] } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, opts) => {
    const payload = JSON.parse(opts.body);
    const call = { url, payload, auth: opts.headers.Authorization };
    calls.push(call);
    const step = script.shift();
    if (step === "timeout") throw new Error("socket hang up");
    if (step && step.status) {
      return { ok: false, status: step.status, headers: { get: (h) => (h === "retry-after" ? step.retryAfter ?? null : null) }, json: async () => ({ error: { code: step.code, message: step.message || `fail ${TOKEN}` } }) };
    }
    n++;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ messages: [{ id: `wamid.out${n}` }] }) };
  };
  return { fetchImpl, calls, images: () => calls.filter((c) => c.payload.type === "image"), nonImages: () => calls.filter((c) => c.payload.type !== "image") };
}

export function fakeCloudinary({ pages = null, fail = false } = {}) {
  const calls = [];
  const all = approved.images.map((a) => ({ public_id: a.public_id, version: a.version, resource_type: "image", type: "upload", asset_folder: approved.folder }));
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (fail) return { ok: false, status: 500, json: async () => ({}) };
    const body = JSON.parse(opts.body);
    const list = pages ?? [all];
    const idx = body.next_cursor ? Number(body.next_cursor) : 0;
    return { ok: true, status: 200, json: async () => ({ resources: list[idx], ...(idx + 1 < list.length ? { next_cursor: String(idx + 1) } : {}) }) };
  };
  return { fetchImpl, calls, all };
}

export function build({ settings = FULL_SETTINGS, metaScript = [], cloudinary = {}, members, approvedList = approved.images, photoCooldownMs = 0, clock } = {}) {
  let t = 1_000_000;
  const now = clock || (() => (t += 5));
  const store = new MemoryStore();
  const meta = fakeMeta({ script: metaScript });
  const cloud = fakeCloudinary(cloudinary);
  const client = new WhatsAppClient({ token: TOKEN, phoneNumberId: "123", fetchImpl: meta.fetchImpl, now });
  const loader = createSettingsLoader({ provider: async () => settings, now });
  const notifications = [];
  const bot = new Bot({ settings: loader, store, members, notifier: { notifyFrontDesk: async (n) => notifications.push(n) }, now });
  const manifest = new ManifestCache({ cloudName: approved.cloud_name, apiKey: "k", apiSecret: "s", folder: approved.folder, approved: approvedList, fetchImpl: cloud.fetchImpl, now });
  const sleeps = [];
  const timings = new Timings({ now });
  const engine = new Engine({ store, bot, client, settings: loader, timings, photoManifest: manifest, sleep: async (ms) => sleeps.push(ms), now, photoPaceMs: 1500, photoCooldownMs });
  return { store, meta, cloud, client, bot, engine, manifest, notifications, sleeps, timings, now };
}

let seq = 0;
export function inboundBody({ from = "919900000001", type = "text", text, id, listId, buttonId, name = "Asha" }) {
  const wamid = `wamid.in${++seq}`;
  const msg = { id: wamid, from, type };
  if (type === "text") msg.text = { body: text };
  if (type === "button") msg.button = { text: text, payload: text };
  if (type === "interactive") msg.interactive = listId ? { type: "list_reply", list_reply: { id: listId, title: "x" } } : { type: "button_reply", button_reply: { id: buttonId, title: "x" } };
  return { wamid, body: { entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name } }], messages: [msg] } }] }] } };
}

export async function say(ctx, input) {
  const { wamid, body } = inboundBody(input);
  const pending = await ctx.engine.ingest(body);
  for (const w of pending) await ctx.engine.process(w);
  return wamid;
}

export function sign(raw) {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
}

export { createApp, mergeSettings, BASE };
