// One shared "Gym Timings & Location" reply, used by the keyword bot, the menu bot (English and Kannada) and the enquiry pack.
// The Google Maps URL sits on its own line as a plain URL so WhatsApp makes it tappable.

export const MAPS_LINK = "https://maps.app.goo.gl/BV2ETVx4Nt6YEsPJ8";
export const ADDRESS = "#18 Gold Fitness, Hoysala Circle, Kengeri, Bengaluru – 560060";

const COPY = {
  en: { maps: "🗺️ Tap for Google Maps directions:", hours: "🕒 Gym Hours", monSat: "Monday–Saturday", sun: "Sunday", footer: "Reply 0 for the main menu." },
  kn: { maps: "🗺️ ಗೂಗಲ್ ಮ್ಯಾಪ್ಸ್ ದಿಕ್ಕುಗಳಿಗಾಗಿ ಟ್ಯಾಪ್ ಮಾಡಿ:", hours: "🕒 ಜಿಮ್ ಸಮಯ", monSat: "ಸೋಮವಾರ–ಶನಿವಾರ", sun: "ಭಾನುವಾರ", footer: "ಮುಖ್ಯ ಮೆನುಗಾಗಿ 0 ಕಳುಹಿಸಿ." },
};

/** settings may override address / hours / mapsLink; the defaults are the owner-confirmed values. */
export function locationReply(settings = {}, lang = "en", { footer = true } = {}) {
  const c = COPY[lang === "kn" ? "kn" : "en"];
  const h = settings.hours && typeof settings.hours === "object" ? settings.hours : {};
  const monSat = h.monSat || "5:30 AM–10:00 PM";
  const sunday = h.sunday || "5:00 PM–9:00 PM";
  const blocks = [
    `📍 GOLD FITNESS KENGERI\n${settings.address || ADDRESS}`,
    `${c.maps}\n${settings.mapsLink || MAPS_LINK}`,
    `${c.hours}\n${c.monSat}: ${monSat}\n${c.sun}: ${sunday}`,
  ];
  if (footer) blocks.push(c.footer);
  return blocks.join("\n\n");
}
