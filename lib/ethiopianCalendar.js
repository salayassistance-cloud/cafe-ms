// Canonical Ethiopian (Ge'ez) business calendar + Africa/Addis_Ababa timezone.
// PHASE C foundation — the ONLY business calendar/timezone implementation.
//
// Business rules:
// - Ethiopian Calendar is the ONLY business/display calendar.
// - Africa/Addis_Ababa is the ONLY business timezone (EAT / UTC+3, via IANA).
// - English and Amharic are two language representations of the SAME Ethiopian date.
// - Gregorian YYYY-MM-DD values are TRANSPORT ONLY (API/MongoDB boundaries),
//   never business-facing dates. Never render Gregorian month names in business UI.
// - Business-day boundary is civil midnight in Africa/Addis_Ababa.
// - All business ranges are half-open: [from Addis midnight, next Addis midnight).
// - Stored timestamps are never rewritten here; conversion happens at display/query.
//
// Architecture: native Julian-Day converter (no npm packages, no DB, no I/O).
// This module is dependency-free so it runs identically on server and client
// regardless of machine/server/browser timezone. Do NOT create a second
// calendar utility — extend this file instead.
//
// Gregorian reference (technical only, NOT business-facing):
//   Meskerem 12, 2019 E.C. == 2026-09-22 Gregorian (Addis day).

export const BUSINESS_TIMEZONE = 'Africa/Addis_Ababa';

// Canonical month names — Phase C spec (do not use Gregorian month names).
export const ET_MONTHS_AM = [
  'መስከረም', // 1 Meskerem
  'ጥቅምት',   // 2 Tikimt
  'ኅዳር',     // 3 Hidar
  'ታኅሣሥ',   // 4 Tahsas
  'ጥር',       // 5 Tir
  'የካቲት',   // 6 Yekatit
  'መጋቢት',   // 7 Megabit
  'ሚያዝያ',   // 8 Miazia
  'ግንቦት',   // 9 Ginbot
  'ሰኔ',       // 10 Sene
  'ሐምሌ',     // 11 Hamle
  'ነሐሴ',     // 12 Nehase
  'ጳጉሜ',     // 13 Pagume
];

export const ET_MONTHS_EN = [
  'Meskerem',
  'Tikimt',
  'Hidar',
  'Tahsas',
  'Tir',
  'Yekatit',
  'Megabit',
  'Miazia',
  'Ginbot',
  'Sene',
  'Hamle',
  'Nehase',
  'Pagume',
];

export const ET_MONTHS_OM = [
  'Meskerem',
  'Lamma',
  'Gur',
  'Bitootessa',
  'Boojjim',
  'Elba',
  'Ammas',
  'Milkeem',
  'Garba',
  'Shawwal',
  'Adool',
  'Bere',
  'Pagume',
];

// Monday-first weekday names (matches EthiopianDateRangePicker grid).
export const ET_WEEKDAYS_AM = ['ሰኞ', 'ማክሰ', 'ረቡዕ', 'ሐሙስ', 'አርብ', 'ቅዳሜ', 'እሑድ'];
export const ET_WEEKDAYS_EN = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export const ET_PRESET_LABELS_AM = {
  today: 'ዛሬ',
  yesterday: 'ትላንት',
  thisWeek: 'በዚህ ሳምንት',
  thisMonth: 'በዚህ ወር',
  last7: 'ያለፉት 7 ቀናት',
};

// Forward: Gregorian (y, m [1-12], d) -> Julian Day Number (noon-based).
export function gregorianToJD(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return (
    d +
    Math.floor((153 * mm + 2) / 5) +
    365 * yy +
    Math.floor(yy / 4) -
    Math.floor(yy / 100) +
    Math.floor(yy / 400) -
    32045
  );
}

// Inverse: Julian Day Number -> Gregorian {y, m [1-12], d}.
export function jdToGregorian(jd) {
  const a = jd + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d - 4800 + Math.floor(m / 10);
  return { year, month, day };
}

const ET_EPOCH_JD = 1724221; // JD of 1 Meskerem 1, year 1 EC (noon)

// Number of days elapsed before the start of Ethiopian year `year`.
function ethDaysBeforeYear(year) {
  return 365 * (year - 1) + Math.floor((year - 1) / 4);
}

export function isEthLeapYear(year) {
  return Number.isInteger(year) && year % 4 === 0;
}

export function daysInEthMonth(year, month) {
  if (month >= 1 && month <= 12) return 30;
  if (month === 13) return isEthLeapYear(year) ? 6 : 5; // Pagume
  return 0;
}

// Linear day index for EC range comparison (same-year safe, cross-year safe).
export function ethDayNumber(ec) {
  const y = Number(ec.year);
  const m = Number(ec.month);
  const d = Number(ec.day);
  return ethDaysBeforeYear(y) + (m - 1) * 30 + (d - 1);
}

export function validateEthiopianDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 13) return null;
  const dim = daysInEthMonth(y, m);
  if (d < 1 || d > dim) return null;
  return { year: y, month: m, day: d };
}

// ─────────────────────────────────────────────────────────────────────────────
// Africa/Addis_Ababa timezone — canonical, never server/browser local.
// Uses IANA database via Intl; no hardcoded offset, no setHours/getHours.
// ─────────────────────────────────────────────────────────────────────────────

function normalizeHour(v) {
  // Some ICU builds emit "24" for midnight with hourCycle h23.
  const n = Number(v);
  if (n === 24) return 0;
  return n;
}

// Returns Addis Ababa wall-time parts for an instant.
export function getAddisParts(date) {
  const d = new Date(date);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: normalizeHour(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

export function getAddisYMD(date) {
  const p = getAddisParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Convert Addis wall time (year, month 1-12, day, hour, minute, second, ms) to UTC instant.
export function addisWallToUTC(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const wallUTC = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const probe = new Date(wallUTC);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(probe);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wallFromProbe = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    normalizeHour(get('hour')),
    Number(get('minute')),
    Number(get('second')),
    probe.getUTCMilliseconds()
  );
  const offsetMs = wallFromProbe - probe.getTime();
  let utcMs = wallUTC - offsetMs;
  // Refine for correctness (Addis Ababa has no DST, loop is a safety net).
  for (let i = 0; i < 2; i += 1) {
    const chk = getAddisParts(new Date(utcMs));
    if (
      chk.year === year &&
      chk.month === month &&
      chk.day === day &&
      chk.hour === hour &&
      chk.minute === minute &&
      chk.second === second
    ) {
      break;
    }
    const chkDate = new Date(utcMs);
    const chkParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: BUSINESS_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    }).formatToParts(chkDate);
    const g2 = (t) => chkParts.find((p) => p.type === t)?.value;
    const wall2 = Date.UTC(
      Number(g2('year')),
      Number(g2('month')) - 1,
      Number(g2('day')),
      normalizeHour(g2('hour')),
      Number(g2('minute')),
      Number(g2('second')),
      chkDate.getUTCMilliseconds()
    );
    const off2 = wall2 - chkDate.getTime();
    utcMs = wallUTC - off2;
  }
  return new Date(utcMs);
}

export function addisYMDToUTCStart(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd).trim());
  if (!m) return null;
  return addisWallToUTC(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, 0);
}

export function addisYMDToUTCNextStart(ymd) {
  const start = addisYMDToUTCStart(ymd);
  if (!start) return null;
  return new Date(start.getTime() + 24 * 3600 * 1000);
}

// Parse a Gregorian transport YYYY-MM-DD string (Addis wall date).
// Returns { year, month, day } or null. Never constructs local-midnight Dates.
export function parseTransportYMD(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Overflow guard via round-trip through Addis (e.g. Feb 30 invalid).
  const start = addisWallToUTC(y, mo, d, 0, 0, 0, 0);
  const chk = getAddisParts(start);
  if (chk.month !== mo || chk.day !== d || chk.year !== y) return null;
  return { year: y, month: mo, day: d };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ethiopian ↔ Gregorian conversion (JD math unchanged; TZ semantics fixed).
// ─────────────────────────────────────────────────────────────────────────────

// Convert an instant -> Ethiopian { year, month, day } using its Addis wall date.
// This is the business-calendar interpretation (never server-local date).
export function toEthiopian(date) {
  const p = getAddisParts(date);
  const jd = gregorianToJD(p.year, p.month, p.day);
  const n = jd - ET_EPOCH_JD; // days since 1 Meskerem 1, year 1 EC

  // Resolve the Ethiopian year (within a couple of steps of the estimate).
  let year = Math.floor(n / 365) + 1;
  while (ethDaysBeforeYear(year) > n) year -= 1;
  while (ethDaysBeforeYear(year + 1) <= n) year += 1;

  const d = n - ethDaysBeforeYear(year); // 0-based day-of-year
  if (d < 360) {
    return { year, month: Math.floor(d / 30) + 1, day: (d % 30) + 1 };
  }
  return { year, month: 13, day: d - 359 };
}

// Alias required by Phase C spec.
export function gregorianToEthiopian(date) {
  return toEthiopian(date);
}

// Convert an Ethiopian date -> Gregorian { year, month, day } (calendar math only).
export function ethiopianToGregorian(year, month, day) {
  const v = validateEthiopianDate(year, month, day);
  if (!v) return null;
  const n = ethDaysBeforeYear(v.year) + (v.month - 1) * 30 + (v.day - 1);
  const g = jdToGregorian(ET_EPOCH_JD + n);
  return { year: g.year, month: g.month, day: g.day };
}

// Convert an Ethiopian date -> JS Date at Addis civil midnight (UTC instant).
// This is the correct business-day start for queries; transport stays YYYY-MM-DD.
export function fromEthiopian(year, month, day) {
  const g = ethiopianToGregorian(year, month, day);
  if (!g) return new Date(NaN);
  return addisWallToUTC(g.year, g.month, g.day, 0, 0, 0, 0);
}

// Ethiopian Y/M/D -> Addis civil-midnight UTC instant (null on invalid input).
export function ethiopianToAddisStart(year, month, day) {
  const v = validateEthiopianDate(year, month, day);
  if (!v) return null;
  return fromEthiopian(v.year, v.month, v.day);
}

// Ethiopian Y/M/D -> next Ethiopian civil-midnight UTC instant (exclusive end).
export function ethiopianToAddisNextStart(year, month, day) {
  const v = validateEthiopianDate(year, month, day);
  if (!v) return null;
  const start = fromEthiopian(v.year, v.month, v.day);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + 24 * 3600 * 1000);
}

// Transport helper: Gregorian YYYY-MM-DD (Addis wall) -> UTC Date.
// Backward-compatible replacement for local `new Date(y, m - 1, d)` bridges.
export function gregYMD(date) {
  return getAddisYMD(date);
}

// ─────────────────────────────────────────────────────────────────────────────
// Month / weekday names (language representations of the SAME Ethiopian date).
// ─────────────────────────────────────────────────────────────────────────────

export function getEthiopianMonthName(month, lang = 'am') {
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 13) return '';
  if (lang === 'en') return ET_MONTHS_EN[m - 1];
  if (lang === 'om') return ET_MONTHS_OM[m - 1];
  return ET_MONTHS_AM[m - 1];
}

export function getEthiopianMonthNameAmharic(month) {
  return getEthiopianMonthName(month, 'am');
}

export function getEthiopianMonthNameEnglish(month) {
  return getEthiopianMonthName(month, 'en');
}

// Weekday of an instant's Addis wall date. Monday-first index 0-6.
export function getEthiopianWeekdayName(date, lang = 'am') {
  const p = getAddisParts(date);
  const noon = addisWallToUTC(p.year, p.month, p.day, 12, 0, 0, 0);
  const dowMondayFirst = (noon.getUTCDay() + 6) % 7;
  if (lang === 'en') return ET_WEEKDAYS_EN[dowMondayFirst];
  return ET_WEEKDAYS_AM[dowMondayFirst];
}

// Legacy EC-object formatter (Amharic month names). Kept for compatibility.
// e.g. "17 ነሐሴ 2016" (day month year). Pass withYear:false for "17 ነሐሴ".
export function formatEthiopian(ec, opts = {}) {
  const { withYear = true, withYearSuffix = false } = opts;
  const monthName = ET_MONTHS_AM[(ec.month || 1) - 1] || '';
  const core = `${ec.day} ${monthName}`;
  if (!withYear) return core;
  return withYearSuffix ? `${core} ${ec.year} አ.ዓ` : `${core} ${ec.year}`;
}

// Canonical instant formatter — SAME Ethiopian date in EN or AM.
// English: "Meskerem 12, 2019 E.C."
// Amharic: "መስከረም 12, 2019 ዓ.ም."
export function formatEthiopianDate(date, lang = 'am') {
  const ec = toEthiopian(date);
  if (lang === 'en') {
    return `${ET_MONTHS_EN[ec.month - 1]} ${ec.day}, ${ec.year} E.C.`;
  }
  if (lang === 'om') {
    return `${ET_MONTHS_OM[ec.month - 1]} ${ec.day}, ${ec.year} E.C.`;
  }
  return `${ET_MONTHS_AM[ec.month - 1]} ${ec.day}, ${ec.year} ዓ.ም.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ethiopian clock — 12 daytime hours + 12 nighttime hours (ONE implementation).
// The clock resets at ~06:00 Addis wall time: 06:00 → 12:00 day,
// 18:00 → 12:00 night. Pipeline: instant → Addis wall hour (IANA, never
// browser-local) → Ethiopian hour. Same convention as Manager Reports hourly
// buckets ("7 ቀን" displayed in English as "7 AM" via the established
// ቀን→AM / ማታ→PM period mapping): the hour number is Ethiopian, AM/PM marks
// day/night — never a Western clock reading.
// ─────────────────────────────────────────────────────────────────────────────

// Addis 24h wall hour (0-23) → Ethiopian clock hour + day/night period.
// ethHour = ((H - 6 + 12) % 12) || 12 so both 06:00 and 18:00 map to 12
// (disambiguated by period). Day: 06:00–17:59, night: 18:00–05:59.
export function ethiopianClockFromAddisHour(addisHour) {
  const h = Number(addisHour);
  const ethHour = ((h - 6 + 12) % 12) || 12;
  const isDay = h >= 6 && h < 18;
  const periodAm = isDay ? 'ቀን' : 'ማታ';
  const periodEn = isDay ? 'AM' : 'PM';
  return {
    ethHour,
    period: isDay ? 'day' : 'night',
    periodAm,
    periodEn,
    labelAm: `${ethHour} ${periodAm}`,
    labelEn: `${ethHour} ${periodEn}`,
  };
}

// Instant → Ethiopian clock parts (Addis-aware, never browser-local).
// Minutes/seconds carry over unchanged; only the hour is reinterpreted.
export function getEthiopianClockParts(date) {
  const p = getAddisParts(date);
  const c = ethiopianClockFromAddisHour(p.hour);
  return { ...c, minute: p.minute, second: p.second, addisHour: p.hour };
}

// Canonical clock display — Ethiopian hour + day/night marker.
// Amharic: "7:30 ቀን" / "7:30 ማታ". English: "7:30 AM" / "7:30 PM"
// (Ethiopian hour number; AM/PM marks day/night per Manager Reports convention).
export function formatEthiopianClock(date, lang = 'am') {
  const c = getEthiopianClockParts(date);
  const mm = String(c.minute).padStart(2, '0');
  if (lang === 'en' || lang === 'om') return `${c.ethHour}:${mm} ${c.periodEn}`;
  return `${c.ethHour}:${mm} ${c.periodAm}`;
}

// Canonical instant formatter — Ethiopian date + Ethiopian clock.
// English: "Meskerem 12, 2019 E.C. 7:30 AM" (7:30 day = 13:30 Addis wall)
// Amharic: "መስከረም 12, 2019 ዓ.ም. 7:30 ቀን"
export function formatEthiopianDateTime(date, lang = 'am') {
  const base = formatEthiopianDate(date, lang);
  return `${base} ${formatEthiopianClock(date, lang)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Business ranges — civil midnight Addis, half-open [from, to).
// ─────────────────────────────────────────────────────────────────────────────

// Start (inclusive, Addis 00:00 UTC instant) of the business day containing `date`.
export function getBusinessDayStart(date) {
  return addisYMDToUTCStart(getAddisYMD(date));
}

// End (exclusive, next Addis 00:00 UTC instant) of the business day containing `date`.
export function getBusinessDayEnd(date) {
  return addisYMDToUTCNextStart(getAddisYMD(date));
}

// Ethiopian day range: { from, to, ec, key }.
export function getEthiopianDayRange(year, month, day) {
  const v = validateEthiopianDate(year, month, day);
  if (!v) return null;
  const from = ethiopianToAddisStart(v.year, v.month, v.day);
  const to = new Date(from.getTime() + 24 * 3600 * 1000);
  return { from, to, ec: v, key: getAddisYMD(from) };
}

// Ethiopian month range: Meskerem..Nehase = 30 days, Pagume = 5/6 days.
export function getEthiopianMonthRange(year, month) {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 13) return null;
  const dim = daysInEthMonth(y, m);
  if (!dim) return null;
  const from = ethiopianToAddisStart(y, m, 1);
  const lastStart = ethiopianToAddisStart(y, m, dim);
  const to = new Date(lastStart.getTime() + 24 * 3600 * 1000);
  return { from, to, ecYear: y, ecMonth: m, daysInMonth: dim };
}

// Ethiopian year range: Meskerem 1 -> next Meskerem 1.
export function getEthiopianYearRange(year) {
  const y = Number(year);
  if (!Number.isInteger(y)) return null;
  const from = ethiopianToAddisStart(y, 1, 1);
  const nextFrom = ethiopianToAddisStart(y + 1, 1, 1);
  return { from, to: nextFrom, ecYear: y };
}

// Current instant -> EC (testable with explicit `now`).
export function getNowEthiopian(now = new Date()) {
  return toEthiopian(now);
}

export function getTodayEthiopian(now = new Date()) {
  return toEthiopian(now);
}

// Normalize business-date input to a half-open Addis range.
// Accepts: EC { year, month, day } | EC { year, month } (month) | EC { year }
// | Gregorian transport "YYYY-MM-DD" | Date instant. Returns { from, to, ec }.
export function normalizeBusinessDateInput(input, now = new Date()) {
  if (input == null) {
    const ec = toEthiopian(now);
    const r = getEthiopianDayRange(ec.year, ec.month, ec.day);
    return { ...r, kind: 'day' };
  }
  if (input instanceof Date) {
    const ec = toEthiopian(input);
    const r = getEthiopianDayRange(ec.year, ec.month, ec.day);
    return { ...r, kind: 'day' };
  }
  if (typeof input === 'string') {
    const t = parseTransportYMD(input);
    if (!t) return null;
    const from = addisYMDToUTCStart(input.trim());
    const to = addisYMDToUTCNextStart(input.trim());
    return { from, to, ec: toEthiopian(from), kind: 'day', transport: input.trim() };
  }
  if (typeof input === 'object') {
    const y = Number(input.year);
    const m = input.month == null ? null : Number(input.month);
    const d = input.day == null ? null : Number(input.day);
    if (!Number.isInteger(y)) return null;
    if (m == null) {
      const r = getEthiopianYearRange(y);
      return r ? { ...r, kind: 'year' } : null;
    }
    if (d == null) {
      const r = getEthiopianMonthRange(y, m);
      return r ? { ...r, kind: 'month' } : null;
    }
    const r = getEthiopianDayRange(y, m, d);
    return r ? { ...r, kind: 'day' } : null;
  }
  return null;
}

function startOfWeekAddis(ref) {
  // Monday 12:00 Addis wall time — unambiguous weekday without local TZ.
  const p = getAddisParts(ref);
  const addisNoonUTC = addisWallToUTC(p.year, p.month, p.day, 12, 0, 0, 0);
  const dow = (addisNoonUTC.getUTCDay() + 6) % 7; // Monday=0
  const mondayNoon = new Date(addisNoonUTC.getTime() - dow * 24 * 3600 * 1000);
  const mp = getAddisParts(mondayNoon);
  return addisWallToUTC(mp.year, mp.month, mp.day, 0, 0, 0, 0);
}

// Deprecated alias kept for compatibility — now Addis-aware (never local).
// Prefer startOfWeekAddis / getBusinessDayStart in new code.
export function startOfWeekGregorian(ref) {
  return startOfWeekAddis(ref);
}

// Returns Gregorian YYYY-MM-DD transport bounds for the five executive presets,
// computed on the Ethiopian calendar AND Africa/Addis_Ababa wall time so
// "today / this month" align to EC business periods. Backend still receives
// plain Gregorian transport strings; UI must render ecFrom/ecTo, never from/to.
export function ethQuickRanges(now = new Date()) {
  const ref = new Date(now);
  const addisTodayStr = getAddisYMD(ref);
  const todayStart = addisYMDToUTCStart(addisTodayStr);
  const ecToday = toEthiopian(ref);

  const yesterdayStart = new Date(todayStart.getTime() - 24 * 3600 * 1000);
  const last7Start = new Date(todayStart.getTime() - 6 * 24 * 3600 * 1000);
  const weekStart = startOfWeekAddis(ref);
  const monthStart = ethiopianToAddisStart(ecToday.year, ecToday.month, 1);

  const ranges = {
    today: { fromStart: todayStart, toStart: todayStart },
    yesterday: { fromStart: yesterdayStart, toStart: yesterdayStart },
    thisWeek: { fromStart: weekStart, toStart: todayStart },
    thisMonth: { fromStart: monthStart, toStart: todayStart },
    last7: { fromStart: last7Start, toStart: todayStart },
  };

  const out = {};
  for (const key of Object.keys(ranges)) {
    const { fromStart, toStart } = ranges[key];
    out[key] = {
      key,
      from: getAddisYMD(fromStart),
      to: getAddisYMD(toStart),
      ecFrom: toEthiopian(fromStart),
      ecTo: toEthiopian(toStart),
    };
  }
  return out;
}

export default {
  BUSINESS_TIMEZONE,
  ET_MONTHS_AM,
  ET_MONTHS_EN,
  ET_MONTHS_OM,
  ET_WEEKDAYS_AM,
  ET_WEEKDAYS_EN,
  ET_PRESET_LABELS_AM,
  gregorianToJD,
  jdToGregorian,
  toEthiopian,
  gregorianToEthiopian,
  fromEthiopian,
  ethiopianToGregorian,
  ethiopianToAddisStart,
  ethiopianToAddisNextStart,
  gregYMD,
  parseTransportYMD,
  getAddisParts,
  getAddisYMD,
  addisWallToUTC,
  addisYMDToUTCStart,
  addisYMDToUTCNextStart,
  formatEthiopian,
  formatEthiopianDate,
  formatEthiopianDateTime,
  formatEthiopianClock,
  getEthiopianClockParts,
  ethiopianClockFromAddisHour,
  getEthiopianMonthName,
  getEthiopianMonthNameAmharic,
  getEthiopianMonthNameEnglish,
  getEthiopianWeekdayName,
  getEthiopianDayRange,
  getEthiopianMonthRange,
  getEthiopianYearRange,
  getBusinessDayStart,
  getBusinessDayEnd,
  getNowEthiopian,
  getTodayEthiopian,
  normalizeBusinessDateInput,
  validateEthiopianDate,
  daysInEthMonth,
  ethDayNumber,
  isEthLeapYear,
  startOfWeekGregorian,
  ethQuickRanges,
};
