// Outbound senders for WhatsApp Cloud API and Instagram messaging.

const GRAPH = process.env.GRAPH_API_BASE || 'https://graph.facebook.com/v21.0';
const IG_GRAPH = process.env.IG_API_BASE || 'https://graph.instagram.com/v21.0';

async function post(url, token, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Send failed ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// WhatsApp: free-form text works only within 24h of the customer's last message.
function waText(to, body) {
  return post(`${GRAPH}/${process.env.WA_PHONE_NUMBER_ID}/messages`, process.env.WA_ACCESS_TOKEN, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body, preview_url: false },
  });
}

// WhatsApp: approved template, needed for reminders and broadcasts outside the 24h window.
function waTemplate(to, name, language, params = []) {
  return post(`${GRAPH}/${process.env.WA_PHONE_NUMBER_ID}/messages`, process.env.WA_ACCESS_TOKEN, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: { code: language },
      components: params.length
        ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }]
        : [],
    },
  });
}

// Instagram: reply to a DM (customer must have messaged first, within 24h).
function igText(recipientId, body) {
  return post(`${IG_GRAPH}/me/messages`, process.env.IG_ACCESS_TOKEN, {
    recipient: { id: recipientId },
    message: { text: body },
  });
}

// OWNER_PHONE may hold one number or several separated by commas. 10-digit numbers get 91 added.
function ownerNumbers(value = process.env.OWNER_PHONE) {
  return String(value || '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean)
    .map((n) => (n.length === 10 ? `91${n}` : n));
}

async function sendText(channel, to, body) {
  return channel === 'instagram' ? igText(to, body) : waText(to, body);
}

module.exports = { sendText, waText, waTemplate, igText, ownerNumbers };
