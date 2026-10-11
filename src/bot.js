// Conversation logic. Takes its dependencies as arguments so it can be tested without network.

const config = require('./config');

function detectIntent(text) {
  const t = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `;
  for (const intent of config.intents) {
    for (const w of intent.words) {
      if (t.includes(` ${w} `)) return intent.id;
    }
  }
  return null;
}

const replies = {
  greeting: () =>
    `Hi! Welcome to ${config.gymName} 💪\n\nReply with:\n• PRICE - membership plans\n• TIMINGS - opening hours\n• LOCATION - where to find us\n• JOIN - book a free trial\n• HUMAN - talk to our team`,
  price: () =>
    `${config.gymName} membership plans:\n` +
    config.plans.map((p) => `• ${p.name}: ${p.price}`).join('\n') +
    `\n\n${config.trialOffer}\nReply JOIN to book.`,
  hours: () => `We're open ${config.hours}.`,
  location: () => `${config.address}${config.mapsLink ? `\n${config.mapsLink}` : ''}`,
  human: () => `Thanks! Our team will get back to you shortly.`,
  stop: () => `You're unsubscribed from offers and reminders. You can message us any time.`,
  fallback: () =>
    `Sorry, I didn't get that. Reply PRICE, TIMINGS, LOCATION, JOIN or HUMAN, and our team will follow up on anything else.`,
};

async function handleMessage(msg, deps) {
  const { db, send, notifyOwner } = deps;
  const { channel, externalId, name, text, messageId } = msg;

  const isNew = await db.logMessage({
    channel,
    external_id: externalId,
    message_id: messageId,
    direction: 'in',
    body: text,
  });
  if (!isNew) return { skipped: 'duplicate' };

  let lead = await db.getLead(channel, externalId);
  if (!lead) {
    lead = await db.createLead({
      channel,
      external_id: externalId,
      name: name || null,
      phone: channel === 'whatsapp' ? externalId : null,
      state: 'idle',
      opt_in: false,
    });
  }

  const intent = detectIntent(text);
  let reply;

  // Global commands work at any point, even mid-flow.
  if (intent === 'stop') {
    await db.updateLead(lead.id, { opt_in: false, state: 'idle' });
    reply = replies.stop();
  } else if (intent === 'human') {
    await db.updateLead(lead.id, { state: 'idle', needs_human: true });
    await notifyOwner(`${config.gymName}: ${name || externalId} (${channel}) asked for a person. Last message: "${text}"`);
    reply = replies.human();
  } else if (lead.state && lead.state !== 'idle') {
    reply = await continueFlow(lead, text, deps);
  } else if (intent === 'join') {
    await db.updateLead(lead.id, { state: 'ask_name' });
    reply = `Great! Let's book your free trial. What's your name?`;
  } else if (intent && replies[intent]) {
    reply = replies[intent]();
  } else if (!lead.last_seen_before) {
    reply = replies.greeting();
  } else {
    reply = replies.fallback();
  }

  if (!lead.last_seen_before) await db.updateLead(lead.id, { last_seen_before: true });

  await send(channel, externalId, reply);
  await db.logMessage({ channel, external_id: externalId, message_id: null, direction: 'out', body: reply });
  return { replied: true, intent };
}

async function continueFlow(lead, text, deps) {
  const { db, notifyOwner } = deps;
  const answer = String(text || '').trim();

  switch (lead.state) {
    case 'ask_name':
      await db.updateLead(lead.id, { name: answer.slice(0, 80), state: 'ask_goal' });
      return `Nice to meet you, ${answer.slice(0, 40)}! What's your main goal? (e.g. weight loss, muscle gain, general fitness)`;
    case 'ask_goal':
      await db.updateLead(lead.id, { goal: answer.slice(0, 120), state: 'ask_time' });
      return `Got it. When would you like to come for the trial? (day and time)`;
    case 'ask_time':
      await db.updateLead(lead.id, { preferred_time: answer.slice(0, 120), state: 'ask_consent' });
      return `Thanks! Would you like to get offers and membership reminders from ${config.gymName} on this chat? Reply YES or NO. You can reply STOP at any time.`;
    case 'ask_consent': {
      const yes = /^\s*(yes|y|ok|okay|sure)\b/i.test(answer);
      const updated = await db.updateLead(lead.id, { opt_in: yes, state: 'idle', booked: true });
      await notifyOwner(
        `${config.gymName}: new trial request from ${updated.name || lead.external_id} (${lead.channel}). ` +
          `Goal: ${updated.goal || '-'}. Preferred time: ${updated.preferred_time || '-'}. ` +
          `${lead.channel === 'whatsapp' ? `Phone: ${lead.external_id}` : ''}`
      );
      return `You're all set! Our team will confirm your trial slot shortly. See you at ${config.gymName} 💪`;
    }
    default:
      await db.updateLead(lead.id, { state: 'idle' });
      return replies.fallback();
  }
}

module.exports = { handleMessage, detectIntent };
