const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');

const config = require('./config');
// Google Sheets storage when GOOGLE_SHEET_ID is set, otherwise Supabase.
const realDb = process.env.GOOGLE_SHEET_ID ? require('./sheets') : require('./db');
const channels = require('./channels');
const { handleMessage } = require('./bot');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function validSignature(rawBody, header) {
  if (!header || !rawBody) return false;
  const secrets = [process.env.META_APP_SECRET, process.env.IG_APP_SECRET].filter(Boolean);
  return secrets.some((s) => {
    const expected = 'sha256=' + crypto.createHmac('sha256', s).update(rawBody).digest('hex');
    return safeEqual(expected, header);
  });
}

// YYYY-MM-DD in India time, offset by a number of days.
function istDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractMessages(body) {
  const out = [];
  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        const names = {};
        for (const c of v.contacts || []) names[c.wa_id] = c.profile && c.profile.name;
        for (const m of v.messages || []) {
          out.push({
            channel: 'whatsapp',
            externalId: m.from,
            name: names[m.from] || null,
            messageId: m.id,
            text:
              (m.text && m.text.body) ||
              (m.button && m.button.text) ||
              (m.interactive && m.interactive.button_reply && m.interactive.button_reply.title) ||
              '',
          });
        }
      }
    }
  } else if (body.object === 'instagram') {
    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) {
        if (!ev.message || ev.message.is_echo) continue;
        if (ev.sender && String(ev.sender.id) === String(entry.id)) continue; // our own account
        out.push({
          channel: 'instagram',
          externalId: ev.sender.id,
          name: null,
          messageId: ev.message.mid,
          text: ev.message.text || '',
        });
      }
    }
  }
  return out;
}

function createApp(overrides = {}) {
  const db = overrides.db || realDb;
  const send = overrides.send || channels.sendText;
  const waTemplate = overrides.waTemplate || channels.waTemplate;

  const notifyOwner =
    overrides.notifyOwner ||
    (async (text) => {
      if (!process.env.OWNER_PHONE) return;
      try {
        await channels.waText(process.env.OWNER_PHONE, text);
      } catch (e) {
        // Free-form text only reaches the owner if they messaged the number in the last 24h.
        console.error('Owner alert failed:', e.message);
      }
    });

  const deps = { db, send, notifyOwner };
  const app = express();

  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.get('/', (_req, res) => res.json({ ok: true, service: 'gold-fitness-automation' }));

  // Meta webhook verification handshake.
  app.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && process.env.VERIFY_TOKEN && safeEqual(token || '', process.env.VERIFY_TOKEN)) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  app.post('/webhook', (req, res) => {
    if (!overrides.skipSignature && !validSignature(req.rawBody, req.get('x-hub-signature-256'))) {
      return res.sendStatus(401);
    }
    res.sendStatus(200); // answer fast; Meta retries slow responses

    const messages = extractMessages(req.body || {});
    for (const m of messages) {
      handleMessage(m, deps).catch((e) => console.error('Message handling failed:', e.message));
    }
  });

  function requireAdmin(req, res, next) {
    if (!process.env.ADMIN_KEY || !safeEqual(req.get('x-admin-key') || '', process.env.ADMIN_KEY)) {
      return res.sendStatus(401);
    }
    next();
  }

  async function runReminders() {
    const target = istDate(config.renewalReminderDays);
    const members = await db.membersExpiringOn(target);
    let sent = 0;
    let failed = 0;
    for (const mem of members) {
      try {
        const t = config.templates.renewal;
        await waTemplate(mem.phone, t.name, t.language, [mem.name || 'there', target]);
        await db.markReminded(mem.id, target);
        sent++;
      } catch (e) {
        failed++;
        console.error(`Reminder to member ${mem.id} failed:`, e.message);
      }
      await sleep(overrides.noDelay ? 0 : 150);
    }
    return { target, sent, failed };
  }

  app.post('/admin/run-reminders', requireAdmin, async (_req, res) => {
    try {
      res.json(await runReminders());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Body: { audience: "leads"|"members", template, language, params: ["Hi {{name}}", ...], dryRun: true }
  app.post('/admin/broadcast', requireAdmin, async (req, res) => {
    try {
      const { audience = 'leads', template, language = 'en', params = [], dryRun = true } = req.body || {};
      if (!template) return res.status(400).json({ error: 'template is required' });
      const people = await db.audience(audience);
      if (dryRun) return res.json({ dryRun: true, recipients: people.length });

      let sent = 0;
      let failed = 0;
      for (const p of people) {
        try {
          const filled = params.map((x) => String(x).replace(/\{\{name\}\}/g, p.name || 'there'));
          await waTemplate(p.phone, template, language, filled);
          sent++;
        } catch (e) {
          failed++;
          console.error(`Broadcast to ${p.id} failed:`, e.message);
        }
        await sleep(overrides.noDelay ? 0 : 150);
      }
      res.json({ dryRun: false, recipients: people.length, sent, failed });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.runReminders = runReminders;
  return app;
}

if (require.main === module) {
  const storage = process.env.GOOGLE_SHEET_ID ? ['GOOGLE_SERVICE_ACCOUNT_JSON'] : ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
  const required = [...storage, 'WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN', 'VERIFY_TOKEN', 'META_APP_SECRET', 'ADMIN_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const app = createApp();
  const port = process.env.PORT || 3000;

  // Check storage access first so a wrong sheet ID or missing share shows up at startup, not on the first message.
  Promise.resolve(realDb.init ? realDb.init() : null)
    .then(() => {
      app.listen(port, () => console.log(`Gold Fitness automation listening on ${port}`));

      // Daily renewal reminders at 9:00 AM India time.
      cron.schedule('0 9 * * *', () => {
        app.runReminders().then((r) => console.log('Reminders:', r)).catch((e) => console.error('Reminder run failed:', e.message));
      }, { timezone: 'Asia/Kolkata' });
    })
    .catch((e) => {
      console.error('Storage check failed:', e.message);
      process.exit(1);
    });
}

module.exports = { createApp, extractMessages, istDate };
