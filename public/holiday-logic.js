/* ───────────────────────────────────────────────────────────────────────────
   Holiday Planner — pure helper logic

   These functions are free of DOM access and module-level app state, which makes
   them safe to unit-test under Node. The same file is loaded by index.html as a
   plain <script>, where every helper is attached to `window` so the inline app
   code can keep calling them by their bare names.
─────────────────────────────────────────────────────────────────────────── */
(function (root) {
  'use strict';

  // ── Date / number formatting ──────────────────────────────────────────────
  // Local-date → 'YYYY-MM-DD' (no timezone shift, unlike Date.toISOString()).
  function toStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // 'YYYY-MM-DD' → 'DD.MM.YYYY'
  function fmtDate(s) { const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; }
  // Trim trailing ".0" but keep one decimal for halves (e.g. 1 → "1", 1.5 → "1.5").
  function fmt(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
  // Index an array of holidays by their date string.
  function buildHMap(holidays) { const m = {}; holidays.forEach(h => { m[h.date] = h; }); return m; }
  // 'YYYY-MM-DD' → local Date at midnight.
  function parseDate(ds) { const [y, m, d] = ds.split('-'); return new Date(+y, +m - 1, +d); }

  // ── Easter / weekday maths ────────────────────────────────────────────────
  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher) for Easter Sunday.
  function easterDate(yr) {
    const a = yr % 19, b = Math.floor(yr / 100), c = yr % 100, d = Math.floor(b / 4), e = b % 4,
          f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
          i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
          m = Math.floor((a + 11 * h + 22 * l) / 451),
          mo = Math.floor((h + l - 7 * m + 114) / 31), dy = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(yr, mo - 1, dy);
  }
  // Date shifted by n days (does not mutate the input).
  function shift(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
  // nth weekday of a month. month: 0-indexed, weekday: 0=Sun … 6=Sat, n: 1-based.
  function nthWeekday(year, month, weekday, n) {
    const first = new Date(year, month, 1);
    const daysToFirst = (weekday - first.getDay() + 7) % 7;
    return new Date(year, month, 1 + daysToFirst + (n - 1) * 7);
  }

  // ── Region holiday tables ─────────────────────────────────────────────────
  function getZurichHolidays(yr) {
    const e = easterDate(yr), mk = (dt, nm, tp, hp) => ({ date: toStr(dt), name: nm, type: tp || 'full', halfPeriod: hp });
    return [
      mk(new Date(yr, 0, 1),       "New Year's Day"),
      mk(new Date(yr, 0, 2),       'Berchtoldstag'),
      mk(shift(e, -2),             'Good Friday'),
      mk(shift(e, 1),              'Easter Monday'),
      mk(nthWeekday(yr, 3, 1, 3),  'Sechseläuten',    'half', 'afternoon'),  // 3rd Monday of April
      mk(new Date(yr, 4, 1),       'Labour Day'),
      mk(shift(e, 39),             'Ascension Day'),
      mk(shift(e, 50),             'Whit Monday'),
      mk(new Date(yr, 7, 1),       'Swiss National Day'),
      mk(nthWeekday(yr, 8, 1, 2),  'Knabenschiessen', 'half', 'afternoon'), // 2nd Monday of September
      mk(new Date(yr, 11, 25),     'Christmas Day'),
      mk(new Date(yr, 11, 26),     "St. Stephen's Day"),
    ].sort((a, b) => a.date.localeCompare(b.date));
  }

  function getHamburgHolidays(yr) {
    const e = easterDate(yr), mk = (dt, nm) => ({ date: toStr(dt), name: nm, type: 'full' });
    return [
      mk(new Date(yr, 0, 1), 'Neujahr'),          mk(shift(e, -2), 'Karfreitag'),
      mk(shift(e, 1), 'Ostermontag'),             mk(new Date(yr, 4, 1), 'Tag der Arbeit'),
      mk(shift(e, 39), 'Himmelfahrt'),            mk(shift(e, 50), 'Pfingstmontag'),
      mk(new Date(yr, 9, 3), 'Tag der Deutschen Einheit'),
      mk(new Date(yr, 9, 31), 'Reformationstag'),
      mk(new Date(yr, 11, 25), '1. Weihnachtstag'),
      mk(new Date(yr, 11, 26), '2. Weihnachtstag'),
    ].sort((a, b) => a.date.localeCompare(b.date));
  }

  // ── Range label ───────────────────────────────────────────────────────────
  function fmtRange(startStr, endStr) {
    const s = new Date(startStr + 'T00:00:00');
    const e = new Date(endStr   + 'T00:00:00');
    const wds = s.toLocaleDateString('en-GB', { weekday: 'short' });
    const wde = e.toLocaleDateString('en-GB', { weekday: 'short' });
    if (startStr === endStr) {
      return s.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    }
    if (s.getMonth() === e.getMonth()) {
      const sD = s.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
      const eD = e.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
      const mo = s.toLocaleDateString('en-GB', { month: 'long' });
      return `${sD} – ${eD} ${mo}`;
    }
    const sP = s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const eP = e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `${wds} ${sP} – ${wde} ${eP}`;
  }

  // ── ICS helpers ───────────────────────────────────────────────────────────
  function icsEsc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  }
  function icsDate(ds) { return ds.replace(/-/g, ''); }          // YYYY-MM-DD → YYYYMMDD
  function nextDay(ds) { const d = parseDate(ds); d.setDate(d.getDate() + 1); return toStr(d); }

  const api = {
    toStr, fmtDate, fmt, buildHMap, parseDate,
    easterDate, shift, nthWeekday,
    getZurichHolidays, getHamburgHolidays,
    fmtRange, icsEsc, icsDate, nextDay,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;          // Node (tests)
  } else {
    Object.assign(root, api);      // Browser — expose as globals for the inline app
  }
})(typeof window !== 'undefined' ? window : globalThis);
