// Meta template catalogue for scheduled messages. These are DRAFTS: none has been submitted to Meta.
// A campaign stays disabled until every template it needs is APPROVED in both languages (checked live against Meta).
// Kannada wording needs a native-speaker review before submission.
// Template body variables may not contain newlines or tabs, so params are sanitised in campaigns.js.

export const TEMPLATES = {
  gfk_birthday_wish: {
    category: "MARKETING",
    params: ["name"],
    en: "Happy Birthday, {{1}}! 🎉 Wishing you a strong, healthy year ahead. Team GOLD FITNESS KENGERI.\nReply STOP to opt out.",
    kn: "ಜನ್ಮದಿನದ ಶುಭಾಶಯಗಳು, {{1}}! 🎉 ಆರೋಗ್ಯಕರ, ಬಲಿಷ್ಠ ವರ್ಷ ನಿಮ್ಮದಾಗಲಿ. GOLD FITNESS KENGERI ತಂಡ.\nನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ.",
  },
  gfk_festival_greeting: {
    category: "MARKETING",
    params: ["festival", "name"],
    en: "Happy {{1}}, {{2}}! Warm wishes from all of us at GOLD FITNESS KENGERI.\nReply STOP to opt out.",
    kn: "ನಮಸ್ಕಾರ! {{1}} ಶುಭಾಶಯಗಳು, {{2}}. GOLD FITNESS KENGERI ತಂಡದಿಂದ ಹೃತ್ಪೂರ್ವಕ ಶುಭಾಶಯಗಳು.\nನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ.",
  },
  gfk_daily_motivation: {
    category: "MARKETING",
    params: ["name", "message"],
    en: "Good morning, {{1}}! 💪 {{2}}\nGOLD FITNESS KENGERI. Reply STOP to opt out.",
    kn: "ಶುಭೋದಯ, {{1}}! 💪 {{2}}\nGOLD FITNESS KENGERI. ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ.",
  },
  gfk_weekly_motivation: {
    category: "MARKETING",
    params: ["name", "message"],
    en: "Hi {{1}}, your weekly gym note: {{2}}\nGOLD FITNESS KENGERI. Reply STOP to opt out.",
    kn: "ನಮಸ್ಕಾರ {{1}}, ಈ ವಾರದ ಜಿಮ್ ಸಂದೇಶ: {{2}}\nGOLD FITNESS KENGERI. ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ.",
  },
  gfk_gym_closure_notice: {
    category: "UTILITY",
    params: ["name", "date", "reason"],
    en: "Hi {{1}}, GOLD FITNESS KENGERI will be closed on {{2}}. {{3}} We reopen as usual after that. Need help? Reply HUMAN.",
    kn: "ನಮಸ್ಕಾರ {{1}}, GOLD FITNESS KENGERI {{2}} ರಂದು ಮುಚ್ಚಿರುತ್ತದೆ. {{3}} ನಂತರ ಎಂದಿನಂತೆ ತೆರೆಯುತ್ತದೆ. ಸಹಾಯ ಬೇಕಾದರೆ HUMAN ಎಂದು ಕಳುಹಿಸಿ.",
  },
  gfk_revised_hours_notice: {
    category: "UTILITY",
    params: ["name", "date", "hours"],
    en: "Hi {{1}}, GOLD FITNESS KENGERI timings on {{2}} are revised: {{3}}. Need help? Reply HUMAN.",
    kn: "ನಮಸ್ಕಾರ {{1}}, {{2}} ರಂದು GOLD FITNESS KENGERI ಸಮಯ ಬದಲಾಗಿದೆ: {{3}}. ಸಹಾಯ ಬೇಕಾದರೆ HUMAN ಎಂದು ಕಳುಹಿಸಿ.",
  },
};

export const LANGS = ["en", "kn"];

export function renderTemplate(name, lang, params) {
  const t = TEMPLATES[name];
  if (!t) return null;
  return (t[lang] || t.en).replace(/\{\{(\d)\}\}/g, (_, i) => String(params[Number(i) - 1] ?? ""));
}

/** Meta body variables may not hold newlines/tabs or runs of 4+ spaces. */
export const cleanParam = (v) => String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
