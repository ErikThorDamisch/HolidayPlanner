'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const HP = require('../public/holiday-logic.js');

test('toStr formats a local date as YYYY-MM-DD with zero padding', () => {
  assert.equal(HP.toStr(new Date(2025, 0, 5)), '2025-01-05');
  assert.equal(HP.toStr(new Date(2025, 11, 31)), '2025-12-31');
  // Uses local components, so it does not roll back a day like toISOString() can.
  assert.equal(HP.toStr(new Date(2024, 2, 1)), '2024-03-01');
});

test('parseDate builds a local midnight Date and round-trips with toStr', () => {
  const d = HP.parseDate('2025-06-30');
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 5);   // June is month index 5
  assert.equal(d.getDate(), 30);
  assert.equal(d.getHours(), 0);
  assert.equal(HP.toStr(HP.parseDate('2025-02-28')), '2025-02-28');
});

test('fmtDate converts ISO date to DD.MM.YYYY', () => {
  assert.equal(HP.fmtDate('2025-01-05'), '05.01.2025');
  assert.equal(HP.fmtDate('2025-12-31'), '31.12.2025');
});

test('fmt keeps integers bare and renders halves with one decimal', () => {
  assert.equal(HP.fmt(1), '1');
  assert.equal(HP.fmt(0), '0');
  assert.equal(HP.fmt(25), '25');
  assert.equal(HP.fmt(1.5), '1.5');
  assert.equal(HP.fmt(0.5), '0.5');
});

test('buildHMap indexes holidays by date string', () => {
  const hols = [
    { date: '2025-01-01', name: "New Year's Day", type: 'full' },
    { date: '2025-12-25', name: 'Christmas Day', type: 'full' },
  ];
  const map = HP.buildHMap(hols);
  assert.equal(map['2025-01-01'].name, "New Year's Day");
  assert.equal(map['2025-12-25'].type, 'full');
  assert.equal(map['2025-06-01'], undefined);
});

test('buildHMap keeps the last entry when dates collide', () => {
  const map = HP.buildHMap([
    { date: '2025-05-01', name: 'First' },
    { date: '2025-05-01', name: 'Second' },
  ]);
  assert.equal(map['2025-05-01'].name, 'Second');
});

test('shift moves a date by n days without mutating the input', () => {
  const base = new Date(2025, 0, 1);
  const plus = HP.shift(base, 5);
  assert.equal(HP.toStr(plus), '2025-01-06');
  assert.equal(HP.toStr(HP.shift(base, -1)), '2024-12-31'); // crosses year boundary
  assert.equal(HP.toStr(base), '2025-01-01');               // original untouched
});

test('easterDate returns the correct Easter Sunday for known years', () => {
  // Reference Western Easter dates.
  assert.equal(HP.toStr(HP.easterDate(2024)), '2024-03-31');
  assert.equal(HP.toStr(HP.easterDate(2025)), '2025-04-20');
  assert.equal(HP.toStr(HP.easterDate(2026)), '2026-04-05');
  assert.equal(HP.toStr(HP.easterDate(2000)), '2000-04-23');
});

test('nthWeekday finds the nth given weekday of a month', () => {
  // 3rd Monday of April 2025 (month index 3, Monday = 1).
  assert.equal(HP.toStr(HP.nthWeekday(2025, 3, 1, 3)), '2025-04-21');
  // 2nd Monday of September 2025 (month index 8).
  assert.equal(HP.toStr(HP.nthWeekday(2025, 8, 1, 2)), '2025-09-08');
  // 1st Sunday of June 2025 (weekday 0).
  assert.equal(HP.toStr(HP.nthWeekday(2025, 5, 0, 1)), '2025-06-01');
});

test('getZurichHolidays returns 12 sorted holidays with fixed and Easter-based dates', () => {
  const hols = HP.getZurichHolidays(2025);
  assert.equal(hols.length, 12);

  // Sorted ascending by date.
  const dates = hols.map(h => h.date);
  assert.deepEqual(dates, [...dates].sort());

  const byName = Object.fromEntries(hols.map(h => [h.name, h]));
  assert.equal(byName["New Year's Day"].date, '2025-01-01');
  assert.equal(byName['Berchtoldstag'].date, '2025-01-02');
  assert.equal(byName['Good Friday'].date, '2025-04-18');   // Easter (04-20) − 2
  assert.equal(byName['Easter Monday'].date, '2025-04-21'); // Easter + 1
  assert.equal(byName['Ascension Day'].date, '2025-05-29'); // Easter + 39
  assert.equal(byName['Whit Monday'].date, '2025-06-09');   // Easter + 50
  assert.equal(byName['Christmas Day'].date, '2025-12-25');
});

test('getZurichHolidays marks Sechseläuten and Knabenschiessen as afternoon half days', () => {
  const byName = Object.fromEntries(HP.getZurichHolidays(2025).map(h => [h.name, h]));

  const sech = byName['Sechseläuten'];
  assert.equal(sech.type, 'half');
  assert.equal(sech.halfPeriod, 'afternoon');
  assert.equal(sech.date, '2025-04-21'); // 3rd Monday of April

  const knab = byName['Knabenschiessen'];
  assert.equal(knab.type, 'half');
  assert.equal(knab.halfPeriod, 'afternoon');
  assert.equal(knab.date, '2025-09-08'); // 2nd Monday of September
});

test('getHamburgHolidays returns 10 full-day holidays including fixed German dates', () => {
  const hols = HP.getHamburgHolidays(2025);
  assert.equal(hols.length, 10);
  assert.ok(hols.every(h => h.type === 'full'));

  const dates = hols.map(h => h.date);
  assert.deepEqual(dates, [...dates].sort());

  const byName = Object.fromEntries(hols.map(h => [h.name, h]));
  assert.equal(byName['Neujahr'].date, '2025-01-01');
  assert.equal(byName['Tag der Deutschen Einheit'].date, '2025-10-03');
  assert.equal(byName['Reformationstag'].date, '2025-10-31');
  assert.equal(byName['1. Weihnachtstag'].date, '2025-12-25');
  assert.equal(byName['2. Weihnachtstag'].date, '2025-12-26');
  assert.equal(byName['Karfreitag'].date, '2025-04-18'); // Easter − 2
});

test('icsEsc escapes backslashes, semicolons, commas and newlines', () => {
  assert.equal(HP.icsEsc('a;b,c'), 'a\\;b\\,c');
  assert.equal(HP.icsEsc('line1\nline2'), 'line1\\nline2');
  assert.equal(HP.icsEsc('back\\slash'), 'back\\\\slash');
  assert.equal(HP.icsEsc(42), '42'); // coerces non-strings
});

test('icsDate strips the dashes from an ISO date', () => {
  assert.equal(HP.icsDate('2025-06-30'), '20250630');
});

test('nextDay returns the following calendar day across month and year boundaries', () => {
  assert.equal(HP.nextDay('2025-06-30'), '2025-07-01');
  assert.equal(HP.nextDay('2025-12-31'), '2026-01-01');
  assert.equal(HP.nextDay('2024-02-28'), '2024-02-29'); // leap year
});

test('fmtRange renders a single day, a same-month range and a cross-month range', () => {
  // Single day → long weekday/day/month label.
  assert.equal(HP.fmtRange('2025-06-30', '2025-06-30'), 'Monday 30 June');
  // Same month → "Mon 30 – Wed 2 ..." style with one month name.
  assert.equal(HP.fmtRange('2025-06-02', '2025-06-06'), 'Mon 2 – Fri 6 June');
  // Cross month → both short month names.
  assert.equal(HP.fmtRange('2025-06-30', '2025-07-02'), 'Mon 30 Jun – Wed 2 Jul');
});
