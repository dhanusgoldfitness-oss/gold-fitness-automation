// Edit this file with the gym's real details. Replies are built from it.

module.exports = {
  gymName: 'Gold Fitness (KENGERI)',

  hours: 'Mon-Sat 5:30 AM - 10:00 PM, Sun 5:00 PM - 9:00 PM',
  address: 'Gold Fitness, Kengeri, Bengaluru',
  mapsLink: '',
  plans: [
    { name: '3 MONTHS', price: '5,250/-' },
    { name: '6 MONTHS', price: '7,350/-' },
    { name: 'Yearly', price: '9,975/-' },
  ],

  // Message templates must be approved in WhatsApp Manager before use.
  templates: {
    renewal: { name: 'membership_renewal', language: 'en' }, // params: {{1}} name, {{2}} expiry date
    welcome: { name: 'welcome_message', language: 'en' }, // params: {{1}} name
  },

  // Send a renewal reminder this many days before expiry.
  renewalReminderDays: 3,

  // Keyword rules, checked in order. First match wins.
  intents: [
    { id: 'human', words: ['human', 'agent', 'person', 'call me', 'speak to', 'talk to'] },
    { id: 'stop', words: ['stop', 'unsubscribe', 'opt out'] },
    { id: 'join', words: ['join', 'enroll', 'admission', 'register', 'sign up'] },
    { id: 'price', words: ['price', 'fee', 'fees', 'cost', 'plan', 'plans', 'membership', 'charges', 'rate'] },
    { id: 'hours', words: ['time', 'timing', 'timings', 'open', 'close', 'hours', 'when'] },
    { id: 'location', words: ['where', 'location', 'address', 'map', 'direction', 'directions'] },
  ],
};
