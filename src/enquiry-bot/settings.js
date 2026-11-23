// Settings come from saved configuration, never from AI. A provider (database row or JSON file) supplies
// overrides; BASE only holds facts the owner has stated. Missing values are reported, not guessed.

export const BASE = {
  brand: "GOLD FITNESS KENGERI",
  address: "#18 Gold Fitness, Hoysala Circle, Kengeri, Bengaluru – 560060",
  mapsLink: "https://maps.app.goo.gl/BV2ETVx4Nt6YEsPJ8",
  hours: { monSat: "5:30 AM–10:00 PM", sunday: "5:00 PM–9:00 PM" },
  website: "https://dhanusgoldfitness.com/",
  instagram: "https://www.instagram.com/gold_fitness_kengeri/",
  facebook: null, // needs the verified official URL
  youtube: null, // flyer lists @dhanusgoldfitnesskengeri: verify the channel before enabling the link
  youtubeCandidate: "https://www.youtube.com/@dhanusgoldfitnesskengeri",
  owners: [
    { phone: "+91 97400 18911", link: "https://wa.me/919740018911" },
    { phone: "+91 97421 42166", link: "https://wa.me/919742142166" },
  ],
  frontDeskNumber: null,
  handoverHours: 12,
  // Flyer totals. Compare with the approved pricing before production rollout (see report).
  plans: {
    general: {
      membershipFeeIncluded: 500,
      prices: [
        { label: "3 months", price: 5250 },
        { label: "6 months", price: 7350 },
        { label: "Annual", price: 9975 },
      ],
    },
    silver: {
      prices: [
        { label: "Monthly", price: 5775 },
        { label: "3 months", price: 13650 },
        { label: "6 months", price: 23100 },
        { label: "Annual", price: 36750 },
      ],
    },
    gold: {
      prices: [
        { label: "Monthly", price: 8925, base: 8500, tax: 425 },
        { label: "3 months", price: 23100 },
        { label: "6 months", price: 38850 },
        { label: "Annual", price: 57750 },
      ],
    },
    three_plus_nine: { annualTotal: 17849, base: 16999, taxAmount: 849.95, sessionFrequency: null, confirmedExtras: [] },
  },
  // Tax breakdown stays hidden until the owner confirms the applicable rate.
  tax: { ratePercent: 5, confirmed: false, showBreakdown: false },
};

export function mergeSettings(base, override = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (k.startsWith("_") || v === undefined) continue;
    out[k] = k === "plans" || k === "tax" || k === "hours" ? (typeof v === "object" && v ? { ...(base[k] || {}), ...v } : v) : v;
  }
  return out;
}

export function createSettingsLoader({ provider = async () => ({}), ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
  let cache = null;
  let at = 0;
  return {
    async get() {
      if (cache && now() - at < ttlMs) return cache;
      try {
        cache = mergeSettings(BASE, await provider());
        at = now();
      } catch (err) {
        if (!cache) cache = BASE; // keep serving the last good (or base) settings if the source is down
      }
      return cache;
    },
    invalidate() {
      cache = null;
    },
  };
}
