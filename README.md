# Gold Fitness Automation

WhatsApp and Instagram automation for Gold Fitness. Leads and members live in a Google Sheet.

| Feature | How it works |
|---|---|
| Auto-reply | Keyword replies for price, timings, location, join, human, stop (edit `src/config.js`) |
| Lead capture | "JOIN" starts a short chat (name, goal, preferred time, consent) and fills a row in the **Leads** tab |
| Owner alert | A WhatsApp message to `OWNER_PHONE` for each trial request or "HUMAN" request |
| Reminders | Daily 9:00 AM IST: members whose plan expires in 3 days get the `membership_renewal` template |
| Broadcast | `POST /admin/broadcast` sends an approved template to opted-in leads or members |

## Your Google Sheet

The service reads and writes these tabs:

**Leads** (your existing columns): `date, name, phone, goal, source, status, whatsapp_consent, notes`
- A new contact gets a row with `status = new`. Finishing JOIN sets `trial_requested`; asking for a person sets `needs_human`.
- `whatsapp_consent` becomes `yes` or `no` from the customer's answer, and `no` again if they send STOP.
- The preferred trial time is written to `notes`.
- An `external_id` column is added automatically on the right. It is how the service recognises the same person (a WhatsApp number or an Instagram ID). Don't delete it.
- Only the cells it needs are written, so edits you make to other columns stay.

**Members** (created automatically on first run): `name, phone, plan, expires_on, opt_in, last_reminded_on`
- Fill `expires_on` as a date (2026-12-31 or 31/12/2026). Set `opt_in` to `yes` only for members who agreed to receive messages.
- `last_reminded_on` is filled by the service so nobody is reminded twice.

**Sales** is not used by the service.

**You must share the sheet** with the service account email as **Editor**: the `client_email` value inside your service account JSON (it ends in `@dhanus-gold-fitness.iam.gserviceaccount.com`). Without this you get a 403 error at startup.

## Before you go live

1. **Edit `src/config.js`.** Plan prices are `CHANGE ME` placeholders. Check hours and address too.
2. **Create two message templates** in WhatsApp Manager and wait for approval:
   - `membership_renewal` (utility): body with `{{1}}` = name, `{{2}}` = expiry date
   - `welcome_message` (optional): body with `{{1}}` = name
   Reminders and broadcasts fail until templates are approved. Free-form replies only work within 24 hours of the customer's last message.
3. **Get a permanent token.** The WhatsApp test token expires in 24 hours. Create a System User token with `whatsapp_business_messaging` and `whatsapp_business_management`, and use it as `WA_ACCESS_TOKEN`.
4. **Marketing needs consent.** Broadcasts go only to people marked `yes`. The JOIN flow asks for it; for existing members, set `opt_in` only for people who agreed.

## Keep the service account key safe

The key file gives full access to anything shared with that account. It must never go into this folder, GitHub, or a chat.
- Put it only in the `GOOGLE_SERVICE_ACCOUNT_JSON` environment variable on Render (paste the file's contents, collapsed to one line).
- If a copy was shared anywhere else, create a new key in Google Cloud (IAM > Service Accounts > Keys), put the new one in Render, then delete the old key.

## Setup

### 1. Deploy on Render
1. Push this folder to a GitHub repo.
2. Render > New > Web Service > pick the repo. Build command `npm install`, start command `npm start`.
3. Add the environment variables from `.env.example`.
4. Your webhook URL is `https://YOUR-SERVICE.onrender.com/webhook`.

On start the service checks it can open the sheet and stops with a clear message if it can't. Render's free tier sleeps when idle, which delays replies and can skip the 9:00 AM reminder run. Use a paid instance for production.

### 2. Connect WhatsApp
Meta App Dashboard > WhatsApp > Configuration: set the callback URL to the webhook URL and the verify token to your `VERIFY_TOKEN`, then subscribe to `messages`. (Your app `Gold-fitness-Automation` already has a callback URL set, so replace it with this one.)

### 3. Connect Instagram
1. Link the gym's Instagram professional account to the Meta app and enable Instagram messaging.
2. Subscribe to the `messages` webhook field for Instagram and use the same webhook URL and verify token.
3. Put the Instagram token in `IG_ACCESS_TOKEN`.
4. Instagram DMs need app permissions approved by Meta App Review before they work for the public. Until then, only app roles (admins, testers) can message it.

## Admin endpoints

Send the header `x-admin-key: <ADMIN_KEY>`.

Run reminders now:
```
curl -X POST https://YOUR-SERVICE.onrender.com/admin/run-reminders -H "x-admin-key: KEY"
```

Count recipients for a broadcast (dry run is the default):
```
curl -X POST https://YOUR-SERVICE.onrender.com/admin/broadcast \
  -H "x-admin-key: KEY" -H "Content-Type: application/json" \
  -d '{"audience":"members","template":"your_template","language":"en","params":["{{name}}"]}'
```
Add `"dryRun": false` to actually send. `{{name}}` is replaced with each person's name.

## Local development

```
npm install
cp .env.example .env   # fill in values; keep GOOGLE_SERVICE_ACCOUNT_JSON on one line
npm run dev            # needs Node 20+
npm test               # offline tests, no network and no real keys
```

## Notes

- If the server restarts in the middle of someone's JOIN chat, that person starts the questions again. Saved details stay in the sheet.
- Google allows about 60 writes per minute per user, far more than a gym needs.
- To use Supabase instead of Google Sheets, leave `GOOGLE_SHEET_ID` empty and run `supabase/schema.sql`.
