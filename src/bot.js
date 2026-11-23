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

// The free-trial wording is used only if config.trialOffer is set.
const hasTrial = () => Boolean(config.trialOffer);

const replies = {
  greeting: () =>
    `Hi! Welcome to ${config.gymName} 💪\n\nReply with:\n• PRICE - membership plans\n• TIMINGS - opening hours\n• LOCATION - where to find us\n• JOIN - ${hasTrial() ? 'book a free trial' : 'become a member'}\n• HUMAN - talk to our team`,
  price: () =>
    `${config.gymName} membership plans:\n` +
    config.plans.map((p) => `• ${p.name}: ${p.price}`).join('\n') +
    (hasTrial() ? `\n\n${config.trialOffer}\nReply JOIN to book.` : `\n\nReply JOIN and our team will get in touch.`),
  hours: () => `We're open ${config.hours}.`,
  location: () => `${config.address}${config.mapsLink ? `\n${config.mapsLink}` : ''}`,
  human: () => `Thanks! Our team will get back to you shortly.`,
  stop: () => `You're unsubscribed from offers and reminders. You can message us any time.`,
  fallback: () => `Reply MENU to see your options.`,
};

// ---- Main menu -------------------------------------------------------------------------------------------------
const GREETING_RE = /^(hi+|hello+|hey+|hlo|helo|menu|start|namaste|namaskara|good (morning|afternoon|evening)|0)$/;
const normalize = (text) => String(text || '').normalize('NFKC').trim().toLowerCase().replace(/[!.?,।\s]+$/g, '').replace(/\s+/g, ' ');

const MENU_ROWS = [
  { id: 'menu_1', title: 'Membership Plans & Fees' },
  { id: 'menu_2', title: 'Schedule a Gym Visit' },
  { id: 'menu_3', title: 'Gym Timings & Location' },
  { id: 'menu_4', title: 'Personal Training', description: 'Silver PT, Gold PT, and 3+9' },
  { id: 'menu_5', title: 'Membership Renewal' },
  { id: 'menu_6', title: 'Talk to the Front Desk' },
  { id: 'menu_7', title: 'Website & Social Media' },
  { id: 'menu_8', title: 'Talk to the Gym Owner' },
  { id: 'menu_9', title: 'ಕನ್ನಡ' },
];
const MENU_BODY = 'Welcome to GOLD FITNESS KENGERI 💪\nTap View Options or reply with a number.';
const MENU_TEXT_LINES = [
  '1. Membership Plans & Fees',
  '2. Schedule a Gym Visit',
  '3. Gym Timings & Location',
  '4. Personal Training — Silver PT, Gold PT, and 3+9',
  '5. Membership Renewal',
  '6. Talk to the Front Desk',
  '7. Website & Social Media',
  '8. Talk to the Gym Owner',
  '9. ಕನ್ನಡ',
];
const menuText = () => `${MENU_BODY.replace('Tap View Options or reply with a number.', 'Reply with a number:')}\n\n${MENU_TEXT_LINES.join('\n')}\n\nReply 0 to return to the main menu.`;
const PT_TEXT = 'Personal Training options. Reply with a number:\n1. Silver PT\n2. Gold PT\n3. 3+9 Package\n\nReply 0 to return to the main menu.';

// The menu bot's plan copy and verified settings are ES modules: load them once, on first use.
let menuData;
function loadMenuData() {
  if (!menuData) {
    menuData = Promise.all([import('./enquiry-bot/plans.js'), import('./enquiry-bot/settings.js'), import('./enquiry-bot/location.js')]).then(([p, s, l]) => ({ renderPlan: p.renderPlan, BASE: s.BASE, locationReply: l.locationReply }));
  }
  return menuData;
}
const PT_KEYS = { 1: 'silver', 2: 'gold', 3: 'three_plus_nine' };

async function sendMenu(channel, to, deps) {
  if (channel === 'whatsapp' && deps.sendList) {
    try {
      await deps.sendList(to, { body: `${MENU_BODY}\n\nReply 0 to return to the main menu.`, button: 'View Options', rows: MENU_ROWS });
      return 'list';
    } catch (e) {
      console.error('Interactive menu failed, sending the numbered text menu:', e.message);
    }
  }
  await deps.send(channel, to, menuText());
  return 'text';
}

async function sendPtOptions(channel, to, deps) {
  if (channel === 'whatsapp' && deps.sendButtons) {
    try {
      await deps.sendButtons(to, { body: 'Personal Training: choose a package.\nReply 0 for the main menu.', buttons: [{ id: 'pt_silver', title: 'Silver PT' }, { id: 'pt_gold', title: 'Gold PT' }, { id: 'pt_3p9', title: '3+9 Package' }] });
      return;
    } catch (e) {
      console.error('PT buttons failed, sending text:', e.message);
    }
  }
  await deps.send(channel, to, PT_TEXT);
}

async function locationText() {
  const { BASE, locationReply } = await loadMenuData();
  return locationReply(BASE, 'en');
}

async function ownerContacts() {
  const { BASE } = await loadMenuData();
  return BASE.owners.map((o) => `${o.phone}: ${o.link}`).join('\n');
}

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
  const norm = normalize(text);
  const isGreeting = GREETING_RE.test(norm);
  const digit = /^[0-9]$/.test(norm) ? norm : null;
  let reply = null;
  let show = null; // 'menu' | 'pt' after the text reply

  // Order matters: STOP and staff handoff first, then greetings/menu, then the old shortcuts, then the fallback.
  if (intent === 'stop' && !isGreeting) {
    await db.updateLead(lead.id, { opt_in: false, state: 'idle' });
    reply = replies.stop();
  } else if (intent === 'human' && !isGreeting) {
    await db.updateLead(lead.id, { state: 'idle', needs_human: true });
    await notifyOwner(`${config.gymName}: ${name || externalId} (${channel}) asked for a person. Last message: "${text}"`);
    reply = replies.human();
  } else if (isGreeting) {
    if (lead.state && lead.state !== 'idle') await db.updateLead(lead.id, { state: 'idle' });
    show = 'menu';
  } else if (lead.state === 'menu_pt' && digit && PT_KEYS[digit]) {
    const { renderPlan, BASE } = await loadMenuData();
    reply = `${renderPlan(PT_KEYS[digit], 'en', BASE.plans[PT_KEYS[digit]], BASE.tax).text}\n\nReply 4 for the other packages or 0 for the main menu.`;
  } else if (lead.state === 'menu_pt' && digit === '4') {
    show = 'pt';
  } else if (lead.state && lead.state !== 'idle' && lead.state !== 'menu_pt') {
    reply = await continueFlow(lead, text, deps);
  } else if (digit && digit !== '0') {
    if (lead.state === 'menu_pt') await db.updateLead(lead.id, { state: 'idle' });
    switch (digit) {
      case '1':
        reply = replies.price();
        break;
      case '2':
        await db.updateLead(lead.id, { state: 'ask_name' });
        reply = `Great! Let's get you started. What's your name?`;
        break;
      case '3':
        reply = await locationText();
        break;
      case '4':
        await db.updateLead(lead.id, { state: 'menu_pt' });
        show = 'pt';
        break;
      case '5':
      case '6':
        await db.updateLead(lead.id, { needs_human: true });
        await notifyOwner(`${config.gymName}: ${name || externalId} (${channel}) asked for the ${digit === '5' ? 'membership renewal' : 'front desk'}.`);
        reply = digit === '5' ? 'Thanks! Our team will help you renew your membership shortly.' : replies.human();
        break;
      case '7': {
        const { BASE } = await loadMenuData();
        reply = `Website & Social Media\nWebsite: ${BASE.website}\nInstagram: ${BASE.instagram}\n\nReply 0 for the main menu.`;
        break;
      }
      case '8':
        reply = `Gym owner contacts:\n${await ownerContacts()}\n\nReply 0 for the main menu.`;
        break;
      default:
        reply = 'Our Kannada menu is coming soon. Reply HUMAN and our team will help you in Kannada.\n\nReply 0 for the main menu.';
    }
  } else if (lead.state === 'menu_pt') {
    await db.updateLead(lead.id, { state: 'idle' });
    reply = replies.fallback();
    show = 'menu';
  } else if (intent === 'join') {
    await db.updateLead(lead.id, { state: 'ask_name' });
    reply = hasTrial() ? `Great! Let's book your free trial. What's your name?` : `Great! Let's get you started. What's your name?`;
  } else if (intent === 'location' || intent === 'hours') {
    reply = await locationText(); // LOCATION and TIMINGS both get the same location + hours reply
  } else if (intent && replies[intent]) {
    reply = replies[intent]();
  } else {
    reply = replies.fallback();
    show = 'menu';
  }

  if (!lead.last_seen_before) await db.updateLead(lead.id, { last_seen_before: true });

  if (reply) {
    await send(channel, externalId, reply);
    await db.logMessage({ channel, external_id: externalId, message_id: null, direction: 'out', body: reply });
  }
  if (show === 'menu') {
    const kind = await sendMenu(channel, externalId, deps);
    await db.logMessage({ channel, external_id: externalId, message_id: null, direction: 'out', body: `[menu:${kind}]` });
  } else if (show === 'pt') {
    await sendPtOptions(channel, externalId, deps);
    await db.logMessage({ channel, external_id: externalId, message_id: null, direction: 'out', body: '[menu:pt]' });
  }
  return { replied: true, intent: isGreeting ? 'greeting' : intent };
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
      return hasTrial()
        ? `Got it. When would you like to come for the trial? (day and time)`
        : `Got it. When would you like to visit the gym? (day and time)`;
    case 'ask_time':
      await db.updateLead(lead.id, { preferred_time: answer.slice(0, 120), state: 'ask_consent' });
      return `Thanks! Would you like to get offers and membership reminders from ${config.gymName} on this chat? Reply YES or NO. You can reply STOP at any time.`;
    case 'ask_consent': {
      const yes = /^\s*(yes|y|ok|okay|sure)\b/i.test(answer);
      const updated = await db.updateLead(lead.id, { opt_in: yes, state: 'idle', booked: true });
      await notifyOwner(
        `${config.gymName}: new ${hasTrial() ? 'trial request' : 'join enquiry'} from ${updated.name || lead.external_id} (${lead.channel}). ` +
          `Goal: ${updated.goal || '-'}. Preferred time: ${updated.preferred_time || '-'}. ` +
          `${lead.channel === 'whatsapp' ? `Phone: ${lead.external_id}` : ''}`
      );
      return `You're all set! Our team will ${hasTrial() ? 'confirm your trial slot' : 'contact you'} shortly. See you at ${config.gymName} 💪`;
    }
    default:
      await db.updateLead(lead.id, { state: 'idle' });
      return replies.fallback();
  }
}

module.exports = { handleMessage, detectIntent, normalize, GREETING_RE };
