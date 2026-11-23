// All scheduling is in Asia/Kolkata (UTC+05:30, no daylight saving), so plain arithmetic is exact.

const IST_MS = 330 * 60 * 1000;
const DAY = 86400000;

export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** Calendar parts of an instant, in India time. dow: 1=Monday..7=Sunday. */
export function istParts(nowMs) {
  const d = new Date(nowMs + IST_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { year, month, day, date, dow, minutes, isoWeek: isoWeekKey(year, month, day) };
}

/** ISO-8601 week key like "2026-W48". */
export function isoWeekKey(y, m, d) {
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(dt.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((dt.getTime() - yearStart) / DAY + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY).toISOString().slice(0, 10);
}

/** "07:00" or "7:00" -> minutes after midnight; null if invalid. */
export function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}
export const formatTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Birthday on a given IST date. A 29 February birthday is celebrated on 28 February in non-leap years. */
export function isBirthdayToday(month, day, parts) {
  if (!month || !day) return false;
  if (month === 2 && day === 29 && !isLeap(parts.year)) return parts.month === 2 && parts.day === 28;
  return parts.month === month && parts.day === day;
}

/** Valid month/day (29 Feb allowed). */
export const validMonthDay = (month, day) => Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 ? 29 : daysInMonth(2024, month));

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "15 Aug", "August 15", "15/08", "15-8" -> {month, day}; null if it cannot be read. No year is ever stored. */
export function parseBirthday(text) {
  const t = String(text ?? "").toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/[,]/g, " ").trim();
  let m = /^(\d{1,2})\s*[\/\-. ]\s*(\d{1,2})$/.exec(t); // day/month (Indian order)
  if (m) return validMonthDay(Number(m[2]), Number(m[1])) ? { month: Number(m[2]), day: Number(m[1]) } : null;
  m = /^(\d{1,2})\s*([a-z]{3,9})$/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3));
    return mi >= 0 && validMonthDay(mi + 1, Number(m[1])) ? { month: mi + 1, day: Number(m[1]) } : null;
  }
  m = /^([a-z]{3,9})\s*(\d{1,2})$/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3));
    return mi >= 0 && validMonthDay(mi + 1, Number(m[2])) ? { month: mi + 1, day: Number(m[2]) } : null;
  }
  return null;
}
