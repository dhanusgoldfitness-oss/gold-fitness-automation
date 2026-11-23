// Plan copy (English + Kannada) and renderer. Prices, taxes and optional inclusions come from settings so the owner can
// change them without a deploy. Kannada wording needs native review before go-live.
// Rules from the owner: no transformation timelines, no trial offers, shared guidance must be clear for Silver,
// "personalized coaching and progress tracking" for Gold, 3+9 phase 1 = basic (verbal) instruction only.

export const PT_ORDER = ["silver", "gold", "three_plus_nine"];

const COPY = {
  en: {
    general: {
      title: "General Fitness – Self-Guided Training",
      best: "Best for people who already know their workouts, can use the equipment confidently, and can follow their routine independently.",
      includes: [],
    },
    silver: {
      title: "Silver PT – Group Guidance",
      best: "Best for first-time members, members returning after a break, and anyone who wants help learning exercises, form and workout structure in a group setting.",
      note: "Trainer guidance is shared with other members in the group.",
      includes: ["Shared trainer guidance (group setting)", "A structured workout plan", "Basic form correction", "General food and recovery guidance", "Full gym and equipment access", "Workouts six days a week"],
      learn: true,
    },
    gold: {
      title: "Gold PT – 1-to-1 Coaching",
      best: "Best for beginners or experienced members who want a dedicated coach, a personalized routine, individual feedback and regular progress reviews.",
      note: "Personalized coaching and progress tracking.",
      includes: ["A dedicated personal trainer", "Customized workouts", "Daily form correction and support", "Personal nutrition guidance", "Weekly progress tracking", "Body analysis", "Monthly fitness assessments", "Accountability", "Workouts six days a week"],
      learn: true,
    },
    three_plus_nine: {
      title: "3+9 Package – Learn, Then Train Independently",
      best: "3 months of basic verbal training instruction and gym orientation + 9 months of General Fitness.",
      includes: ["Months 1–3: basic verbal training instruction and gym orientation", "Months 4–12: self-guided General Fitness"],
      learn: true,
      learnNote: "In the first 3 months (basic learning phase) you will learn, in simple terms:",
    },
  },
  kn: {
    general: {
      title: "ಜನರಲ್ ಫಿಟ್‌ನೆಸ್ – ಸ್ವಯಂ ತರಬೇತಿ",
      best: "ತಮ್ಮ ವರ್ಕೌಟ್‌ಗಳನ್ನು ಈಗಾಗಲೇ ತಿಳಿದಿರುವ, ಉಪಕರಣಗಳನ್ನು ವಿಶ್ವಾಸದಿಂದ ಬಳಸಬಲ್ಲ ಮತ್ತು ತಾವಾಗಿಯೇ ದಿನಚರಿ ಅನುಸರಿಸಬಲ್ಲವರಿಗೆ ಸೂಕ್ತ.",
      includes: [],
    },
    silver: {
      title: "ಸಿಲ್ವರ್ ಪಿಟಿ – ಗುಂಪು ಮಾರ್ಗದರ್ಶನ",
      best: "ಮೊದಲ ಬಾರಿ ಸೇರುವವರು, ವಿರಾಮದ ನಂತರ ಮರಳುವವರು ಮತ್ತು ಗುಂಪಿನಲ್ಲಿ ವ್ಯಾಯಾಮ, ಸರಿಯಾದ ಭಂಗಿ ಹಾಗೂ ವರ್ಕೌಟ್ ರಚನೆ ಕಲಿಯಲು ಬಯಸುವವರಿಗೆ ಸೂಕ್ತ.",
      note: "ತರಬೇತುದಾರರ ಮಾರ್ಗದರ್ಶನ ಗುಂಪಿನ ಇತರ ಸದಸ್ಯರೊಂದಿಗೆ ಹಂಚಿಕೆಯಾಗಿರುತ್ತದೆ.",
      includes: ["ಹಂಚಿಕೆಯ ತರಬೇತುದಾರ ಮಾರ್ಗದರ್ಶನ (ಗುಂಪು)", "ರಚನಾತ್ಮಕ ವರ್ಕೌಟ್ ಯೋಜನೆ", "ಮೂಲ ಭಂಗಿ ತಿದ್ದುಪಡಿ", "ಸಾಮಾನ್ಯ ಆಹಾರ ಮತ್ತು ಚೇತರಿಕೆ ಮಾರ್ಗದರ್ಶನ", "ಪೂರ್ಣ ಜಿಮ್ ಮತ್ತು ಉಪಕರಣಗಳ ಬಳಕೆ", "ವಾರಕ್ಕೆ ಆರು ದಿನ ವರ್ಕೌಟ್"],
      learn: true,
    },
    gold: {
      title: "ಗೋಲ್ಡ್ ಪಿಟಿ – 1-ಟು-1 ಕೋಚಿಂಗ್",
      best: "ಹೊಸಬರು ಅಥವಾ ಅನುಭವಿ ಸದಸ್ಯರು, ತಮ್ಮದೇ ಆದ ಕೋಚ್, ವೈಯಕ್ತಿಕ ದಿನಚರಿ, ವೈಯಕ್ತಿಕ ಪ್ರತಿಕ್ರಿಯೆ ಮತ್ತು ನಿಯಮಿತ ಪ್ರಗತಿ ಪರಿಶೀಲನೆ ಬಯಸುವವರಿಗೆ ಸೂಕ್ತ.",
      note: "ವೈಯಕ್ತಿಕ ಕೋಚಿಂಗ್ ಮತ್ತು ಪ್ರಗತಿ ಟ್ರ್ಯಾಕಿಂಗ್.",
      includes: ["ಮೀಸಲಾದ ವೈಯಕ್ತಿಕ ತರಬೇತುದಾರ", "ನಿಮಗಾಗಿ ರೂಪಿಸಿದ ವರ್ಕೌಟ್‌ಗಳು", "ಪ್ರತಿದಿನ ಭಂಗಿ ತಿದ್ದುಪಡಿ ಮತ್ತು ಬೆಂಬಲ", "ವೈಯಕ್ತಿಕ ಪೌಷ್ಟಿಕಾಂಶ ಮಾರ್ಗದರ್ಶನ", "ವಾರದ ಪ್ರಗತಿ ಟ್ರ್ಯಾಕಿಂಗ್", "ದೇಹ ವಿಶ್ಲೇಷಣೆ", "ಮಾಸಿಕ ಫಿಟ್‌ನೆಸ್ ಮೌಲ್ಯಮಾಪನ", "ಹೊಣೆಗಾರಿಕೆ ಬೆಂಬಲ", "ವಾರಕ್ಕೆ ಆರು ದಿನ ವರ್ಕೌಟ್"],
      learn: true,
    },
    three_plus_nine: {
      title: "3+9 ಪ್ಯಾಕೇಜ್ – ಮೊದಲು ಕಲಿಯಿರಿ, ನಂತರ ಸ್ವತಂತ್ರವಾಗಿ ವರ್ಕೌಟ್ ಮಾಡಿ",
      best: "ಮೊದಲು ಮೂಲಭೂತ ಅಂಶಗಳನ್ನು ಕಲಿಯಿರಿ, ನಂತರ ನೀವೇ ವರ್ಕೌಟ್ ಮಾಡಿ.",
      includes: ["1–3 ತಿಂಗಳು: ಮೂಲ ಮೌಖಿಕ ತರಬೇತಿ ಸೂಚನೆ ಮತ್ತು ಜಿಮ್ ಪರಿಚಯ", "4–12 ತಿಂಗಳು: ಸ್ವಯಂ ತರಬೇತಿಯ ಜನರಲ್ ಫಿಟ್‌ನೆಸ್"],
      learn: true,
      learnNote: "ಮೊದಲ 3 ತಿಂಗಳಲ್ಲಿ (ಮೂಲ ಕಲಿಕೆಯ ಹಂತ) ಸರಳ ಭಾಷೆಯಲ್ಲಿ ಕಲಿಯುವುದು:",
    },
  },
};

const LABELS = {
  en: {
    includes: "Includes",
    learnNote: "You will learn, in simple terms:",
    topics: ["Basic anatomy and which muscles an exercise works", "Equipment setup, exercise form, warm-ups, sets, reps and progression", "Basic food habits, protein, hydration, sleep and recovery"],
    feeIncluded: "These totals include the ₹{fee} membership fee.",
    annualTotal: "Annual total",
    priceMissing: "Price: please ask our front desk team",
    freq: "Session frequency",
    extras: "Also included",
    taxLine: "({base} + {tax} tax)",
  },
  kn: {
    includes: "ಒಳಗೊಂಡಿರುವುದು",
    learnNote: "ಸರಳ ಭಾಷೆಯಲ್ಲಿ ನೀವು ಕಲಿಯುವುದು:",
    topics: ["ಮೂಲ ಅಂಗರಚನೆ ಮತ್ತು ವ್ಯಾಯಾಮ ಯಾವ ಸ್ನಾಯುಗಳಿಗೆ ಕೆಲಸ ಕೊಡುತ್ತದೆ", "ಉಪಕರಣ ಸೆಟಪ್, ವ್ಯಾಯಾಮದ ಭಂಗಿ, ವಾರ್ಮ್-ಅಪ್, ಸೆಟ್, ರೆಪ್ಸ್ ಮತ್ತು ಪ್ರಗತಿ", "ಮೂಲ ಆಹಾರ ಅಭ್ಯಾಸ, ಪ್ರೋಟೀನ್, ನೀರು, ನಿದ್ರೆ ಮತ್ತು ಚೇತರಿಕೆ"],
    feeIncluded: "ಈ ಮೊತ್ತಗಳಲ್ಲಿ ₹{fee} ಸದಸ್ಯತ್ವ ಶುಲ್ಕ ಸೇರಿದೆ.",
    annualTotal: "ವಾರ್ಷಿಕ ಒಟ್ಟು",
    priceMissing: "ಶುಲ್ಕ: ದಯವಿಟ್ಟು ನಮ್ಮ ಫ್ರಂಟ್ ಡೆಸ್ಕ್ ಅನ್ನು ಕೇಳಿ",
    freq: "ಸೆಷನ್ ಆವರ್ತನ",
    extras: "ಇನ್ನೂ ಒಳಗೊಂಡಿರುವುದು",
    taxLine: "({base} + {tax} ತೆರಿಗೆ)",
  },
};

export const PLAN_GUIDE = {
  en: "Already know your workouts and can train independently? Choose General Fitness.\nNew to the gym or want to learn in a group? Choose Silver PT.\nWant a dedicated coach and a customized routine? Choose Gold PT.\nWant basic instruction first and then train on your own? Choose 3+9.",
  kn: "ನಿಮ್ಮ ವರ್ಕೌಟ್‌ಗಳು ಈಗಾಗಲೇ ಗೊತ್ತಿದ್ದು ಸ್ವತಂತ್ರವಾಗಿ ಮಾಡಬಲ್ಲಿರಾ? ಜನರಲ್ ಫಿಟ್‌ನೆಸ್ ಆರಿಸಿ.\nಜಿಮ್‌ಗೆ ಹೊಸಬರೇ ಅಥವಾ ಗುಂಪಿನಲ್ಲಿ ಕಲಿಯಲು ಬಯಸುವಿರಾ? ಸಿಲ್ವರ್ ಪಿಟಿ ಆರಿಸಿ.\nಮೀಸಲಾದ ಕೋಚ್ ಮತ್ತು ನಿಮಗಾಗಿ ರೂಪಿಸಿದ ದಿನಚರಿ ಬೇಕೇ? ಗೋಲ್ಡ್ ಪಿಟಿ ಆರಿಸಿ.\nಮೊದಲು ಮೂಲ ಸೂಚನೆ, ನಂತರ ನೀವೇ ವರ್ಕೌಟ್ ಮಾಡಬೇಕೇ? 3+9 ಆರಿಸಿ.",
};

export const rupees = (n) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function priceLine(entry, l, tax) {
  let line = `${entry.label}: ${rupees(entry.price)}`;
  if (tax?.confirmed && tax?.showBreakdown && entry.base != null && entry.tax != null) {
    line += ` ${LABELS[l].taxLine.replace("{base}", rupees(entry.base)).replace("{tax}", rupees(entry.tax))}`;
  }
  return line;
}

/** Returns { text, missing: [keys] } for one plan. cfg = settings.plans[key]. */
export function renderPlan(key, lang, cfg, tax) {
  const l = lang === "kn" ? "kn" : "en";
  const c = COPY[l][key];
  const L = LABELS[l];
  const lines = [`*${c.title}*`, c.best];
  if (c.note) lines.push(c.note);
  const missing = [];
  const prices = cfg?.prices || [];
  if (key === "three_plus_nine") {
    if (cfg?.annualTotal != null) lines.push("", priceLine({ label: L.annualTotal, price: cfg.annualTotal, base: cfg.base, tax: cfg.taxAmount }, l, tax));
    else {
      lines.push("", L.priceMissing);
      missing.push("plans.three_plus_nine.annualTotal");
    }
  } else if (prices.length) {
    lines.push("", ...prices.map((p) => priceLine(p, l, tax)));
    if (key === "general" && cfg?.membershipFeeIncluded != null) lines.push(L.feeIncluded.replace("{fee}", Number(cfg.membershipFeeIncluded).toLocaleString("en-IN")));
  } else {
    lines.push("", L.priceMissing);
    missing.push(`plans.${key}.prices`);
  }
  if (c.includes.length) lines.push("", `${L.includes}:`, ...c.includes.map((i) => `• ${i}`));
  // Owner-confirmed extras only (e.g. hands-on form correction for 3+9). Never advertised by default.
  if (cfg?.confirmedExtras?.length) lines.push("", `${L.extras}:`, ...cfg.confirmedExtras.map((i) => `• ${i}`));
  if (key === "three_plus_nine" && cfg?.sessionFrequency) lines.push(`${L.freq}: ${cfg.sessionFrequency}`);
  if (c.learn) lines.push("", c.learnNote || L.learnNote, ...L.topics.map((i) => `• ${i}`));
  return { text: lines.join("\n"), missing };
}
