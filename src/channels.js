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

// WhatsApp interactive list ("View Options") and reply buttons. Allowed inside the 24h window only, like text.
function waList(to, { body, button, rows }) {
  return post(`${GRAPH}/${process.env.WA_PHONE_NUMBER_ID}/messages`, process.env.WA_ACCESS_TOKEN, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body },
      action: { button, sections: [{ title: 'Options', rows: rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) }] },
    },
  });
}

function waButtons(to, { body, buttons }) {
  return post(`${GRAPH}/${process.env.WA_PHONE_NUMBER_ID}/messages`, process.env.WA_ACCESS_TOKEN, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: { type: 'button', body: { text: body }, action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } },
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
  const out = [];
  for (const token of String(value || '').split(/[,;\n]+/)) {
    const digits = token.replace(/\D/g, '');
    if (!digits) continue;
    // Two full numbers pasted together without a separator (e.g. 919740018911919742142166) are split into 12-digit chunks.
    if (digits.length > 12 && digits.length % 12 === 0 && digits.startsWith('91')) {
      for (let i = 0; i < digits.length; i += 12) out.push(digits.slice(i, i + 12));
    } else out.push(digits.length === 10 ? `91${digits}` : digits);
  }
  return out;
}

async function sendText(channel, to, body) {
  return channel === 'instagram' ? igText(to, body) : waText(to, body);
}

module.exports = { sendText, waText, waList, waButtons, waTemplate, igText, ownerNumbers };
