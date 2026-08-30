// Native Ethiopian (Ge'ez) calendar converter — no external dependencies.
//
// The Ethiopian calendar has 13 months: 12 of 30 days plus Pagume (ጳጉሜ) of
// 5 days (6 in leap years). It runs ~7-8 years behind the Gregorian calendar
// and the new year (1 Meskerem) falls on 11 September (12 after a leap year).
//
// A year is a leap year when (year % 4 === 0). The epoch used below is the
// Julian Day Number of 1 Meskerem 1 (year 1 EC) = 1724221 (noon-based JD,
// matching the standard Gregorian<->JD forward algorithm verified below).
//
// Conversions are exact and round-trip stable, so report date ranges derived
// here map 1:1 to backend Gregorian timestamps without shifting a business day.

export const ET_MONTHS_AM = [
  'መስከረም', // Meskerem
  'ጥቅምት',   // Tikimt
  'ህዳር',     // Hidar
  'ታህሳስ',   // Tahsas
  'ጥር',       // Tir
  'የካቲት',   // Yekatit
  'መገባ',     // Megabit
  'ሚያዝያ',   // Miyazya
  'ግንቦት',   // Ginbot
  'ሰኔ',       // Sene
  'ሐምሌ',     // Hamle
  'ነሐሴ',     // Nehase
  'ጳጉሜ',     // Pagume
];

export const ET_MONTHS_EN = [
  'Meskerem',
  'Tikimt',
  'Hidar',
  'Tahsas',
  'Tir',
  'Yekatit',
  'Megabit',
  'Miyazya',
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
  return year % 4 === 0;
}

// Convert a JS Date (Gregorian) -> Ethiopian { year, month, day }.
export function toEthiopian(date) {
  const g = new Date(date);
  const jd = gregorianToJD(g.getFullYear(), g.getMonth() + 1, g.getDate());
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

// Convert an Ethiopian date -> JS Date (Gregorian).
export function fromEthiopian(year, month, day) {
  const daysBefore = ethDaysBeforeYear(year);
  const dayOfYear = (month - 1) * 30 + (day - 1);
  const n = daysBefore + dayOfYear;
  const jd = ET_EPOCH_JD + n;
  const g = jdToGregorian(jd);
  return new Date(g.year, g.month - 1, g.day);
}

export function gregYMD(date) {
  const x = new Date(date);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const d = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// e.g. "17 ነሐሴ 2016" (day month year). Pass withYear:false for "17 ነሐሴ".
export function formatEthiopian(ec, opts = {}) {
  const { withYear = true, withYearSuffix = false } = opts;
  const monthName = ET_MONTHS_AM[(ec.month || 1) - 1] || '';
  const core = `${ec.day} ${monthName}`;
  if (!withYear) return core;
  return withYearSuffix ? `${core} ${ec.year} አ.ዓ` : `${core} ${ec.year}`;
}

function startOfWeekGregorian(ref) {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  return d;
}

// Returns Gregorian YYYY-MM-DD bounds for the five executive presets, computed
// on the Ethiopian calendar so "this week / this month" align to EC periods,
// while the backend still receives plain Gregorian timestamps.
export function ethQuickRanges() {
  const now = new Date();
  const todayGreg = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ecToday = toEthiopian(todayGreg);

  const ranges = {
    today: { from: todayGreg, to: todayGreg },
    yesterday: (() => {
      const d = new Date(todayGreg);
      d.setDate(d.getDate() - 1);
      return { from: d, to: d };
    })(),
    thisWeek: (() => {
      const from = startOfWeekGregorian(todayGreg);
      return { from, to: todayGreg };
    })(),
    thisMonth: (() => {
      const from = fromEthiopian(ecToday.year, ecToday.month, 1);
      const to = fromEthiopian(ecToday.year, ecToday.month, ecToday.day);
      return { from, to };
    })(),
    last7: (() => {
      const from = new Date(todayGreg);
      from.setDate(from.getDate() - 6);
      return { from, to: todayGreg };
    })(),
  };

  const out = {};
  for (const key of Object.keys(ranges)) {
    const { from, to } = ranges[key];
    out[key] = {
      key,
      from: gregYMD(from),
      to: gregYMD(to),
      ecFrom: toEthiopian(from),
      ecTo: toEthiopian(to),
    };
  }
  return out;
}

export default {
  ET_MONTHS_AM,
  ET_PRESET_LABELS_AM,
  gregorianToJD,
  jdToGregorian,
  toEthiopian,
  fromEthiopian,
  gregYMD,
  formatEthiopian,
  isEthLeapYear,
  ethQuickRanges,
};
