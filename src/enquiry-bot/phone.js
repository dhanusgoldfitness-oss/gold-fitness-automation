// Phone normalisation shared by the owner command, enquiry capture and the campaign planner.

const digits = (s) => String(s ?? "").replace(/\D/g, "");

/** "98450 12345", "+91 98450-12345", "09845012345", "919845012345" -> "919845012345". Anything else -> null. */
export function normalizeIndianMobile(input) {
  const raw = String(input ?? "").trim();
  if (!/^[+\d\s().-]+$/.test(raw)) return null; // must be only a phone number: no other words
  let d = digits(raw);
  if (d.length === 13 && d.startsWith("091")) d = d.slice(1);
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) return null;
  return `91${d}`;
}

/** The 10-digit national number used to match the same person across leads, contacts and members stored in different formats. */
export function phoneKey(input) {
  const n = normalizeIndianMobile(input);
  return n ? n.slice(2) : null;
}

export const samePerson = (a, b) => {
  const x = phoneKey(a);
  return x != null && x === phoneKey(b);
};
