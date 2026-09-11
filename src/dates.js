// Small helpers for turning "now" into local calendar dates/labels in a
// given IANA timezone, without pulling in a date library.
//
// Note: day-offsets are computed by adding whole 24h chunks in UTC and then
// formatting into the target timezone. Around a DST transition this can be
// off by up to an hour internally, which almost never changes which
// calendar date it lands on — good enough for a "which day looks best this
// week" report. Swap in a proper TZ-aware date library if you need exactness.

export function todayDateStr(timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()); // YYYY-MM-DD
}

/** Returns an array of `count` "YYYY-MM-DD" strings starting today, in `timezone`. */
export function nextDateStrs(timezone, count) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  const out = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    out.push(fmt.format(d));
  }
  return out;
}

/** Human day labels matching nextDateStrs: ["Today", "Tue", "Wed", ...]. */
export function dayLabels(timezone, count) {
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' });
  const now = new Date();
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      out.push('Today');
      continue;
    }
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    out.push(weekdayFmt.format(d));
  }
  return out;
}
