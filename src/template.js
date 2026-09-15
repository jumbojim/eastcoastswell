// Rule-based, plain-language surf report generation. No AI/LLM involved —
// every sentence is assembled from thresholds and lookup tables so output is
// deterministic and cheap to reason about / tune.

const COMPASS_POINTS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

export function degToCompass(deg) {
  if (deg == null || Number.isNaN(deg)) return null;
  const idx = Math.round(((deg % 360) / 22.5)) % 16;
  return COMPASS_POINTS[idx];
}

function round(n, dp = 0) {
  if (n == null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function sizeDescriptor(ft) {
  if (ft == null) return 'unknown size';
  if (ft < 1) return 'flat, barely rideable';
  if (ft < 2) return 'small, ankle-to-knee high';
  if (ft < 3) return 'knee-to-waist high';
  if (ft < 4.5) return 'waist-to-chest high';
  if (ft < 6.5) return 'chest-to-head high';
  if (ft < 9) return 'head high or bigger';
  return 'well overhead — experienced surfers only';
}

function windDescriptor(speedMph) {
  if (speedMph == null) return '';
  if (speedMph < 6) return 'glassy and clean';
  if (speedMph < 12) return 'light and manageable';
  if (speedMph < 18) return 'a bit bumpy';
  return 'blown out and choppy';
}

const HOUR_RE = /T(\d{2}):/;

function hourOf(record) {
  const m = HOUR_RE.exec(record.time);
  return m ? Number(m[1]) : null;
}

function dateOf(record) {
  return record.time.slice(0, 10); // YYYY-MM-DD
}

/** Pick the AM window (5am-11am local) for a given date's records. */
export function amWindow(records, dateStr) {
  return records.filter((r) => dateOf(r) === dateStr && hourOf(r) >= 5 && hourOf(r) <= 11);
}

/** Full daylight window (5am-7pm local) for a given date's records — used for weekly scoring. */
export function daylightWindow(records, dateStr) {
  return records.filter((r) => dateOf(r) === dateStr && hourOf(r) >= 5 && hourOf(r) <= 19);
}

function average(nums) {
  const vals = nums.filter((n) => n != null && !Number.isNaN(n));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Summarize a set of hourly records into one representative snapshot:
 * max swell height (and the period/direction at that peak hour), plus
 * average wind speed/direction across the window.
 */
export function summarizeWindow(records) {
  if (!records.length) return null;

  let peak = records[0];
  for (const r of records) {
    if ((r.swellHeightFt ?? r.waveHeightFt ?? 0) > (peak.swellHeightFt ?? peak.waveHeightFt ?? 0)) {
      peak = r;
    }
  }

  return {
    heightFt: round(peak.swellHeightFt ?? peak.waveHeightFt, 1),
    periodS: round(peak.swellPeriodS ?? peak.wavePeriodS, 0),
    directionDeg: peak.swellDirectionDeg ?? peak.waveDirectionDeg,
    avgWindMph: round(average(records.map((r) => r.windSpeedMph)), 0),
    dominantWindDirectionDeg: peak.windDirectionDeg,
    gustMph: round(Math.max(...records.map((r) => r.windGustMph ?? 0)), 0),
  };
}

function conditionsSentence(summary) {
  if (!summary || summary.heightFt == null) {
    return "conditions data wasn't available this morning — check back later.";
  }
  const dir = degToCompass(summary.directionDeg);
  const windDir = degToCompass(summary.dominantWindDirectionDeg);
  const size = sizeDescriptor(summary.heightFt);
  const windDesc = windDescriptor(summary.avgWindMph);

  const periodPart = summary.periodS ? ` @ ${summary.periodS}s` : '';
  const dirPart = dir ? ` from the ${dir}` : '';
  const windPart =
    summary.avgWindMph != null
      ? ` Wind: ${windDesc}, ${summary.avgWindMph}mph${windDir ? ` ${windDir}` : ''}.`
      : '';

  return `${size} (${summary.heightFt}ft${periodPart}${dirPart}).${windPart}`;
}

/**
 * Build one break's line for a daily message, e.g.
 * "Long Branch: waist-to-chest high (3ft @ 8s from the SE). Wind: light and manageable, 8mph NW."
 */
export function buildDailySnippet(breakName, hourlyRecords, todayDateStr) {
  const summary = summarizeWindow(amWindow(hourlyRecords, todayDateStr));
  return `${breakName}: ${conditionsSentence(summary)}`;
}

/**
 * Build today's daily report for one subscriber, covering 1+ breaks.
 * @param {Array<{breakName: string, hourlyRecords: Array}>} breakReports
 * @param {string} todayDateStr "YYYY-MM-DD" in the report timezone
 */
export function buildDailyMessage(breakReports, todayDateStr) {
  const snippets = breakReports.map((r) => buildDailySnippet(r.breakName, r.hourlyRecords, todayDateStr));
  return `East Coast Swell, this morning — ${snippets.join(' ')} Reply STOP to unsubscribe.`;
}

/**
 * Build one break's weekly outlook. `compact` (used when a subscriber follows
 * more than one break, to keep the combined text a reasonable length) drops
 * the "rest of week" list and keeps just the best-day sentence.
 */
export function buildWeeklySnippet(breakName, hourlyRecords, next7DateStrs, dayLabels, { compact = false } = {}) {
  const daySummaries = next7DateStrs.map((dateStr, i) => ({
    dateStr,
    label: dayLabels[i],
    summary: summarizeWindow(daylightWindow(hourlyRecords, dateStr)),
  }));

  const scored = daySummaries
    .filter((d) => d.summary?.heightFt != null)
    .map((d) => ({ ...d, score: scoreDay(d.summary) }));

  if (!scored.length) {
    return `${breakName}: forecast data wasn't available this week.`;
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const bestSentence = conditionsSentence(best.summary);

  if (compact) {
    return `${breakName}: best day looks like ${best.label} — ${bestSentence}`;
  }

  const others = scored
    .filter((d) => d.dateStr !== best.dateStr)
    .slice(0, 3)
    .map((d) => `${d.label} ~${d.summary.heightFt}ft`)
    .join(', ');

  const outlook = others ? ` Rest of week: ${others}.` : '';

  return `${breakName}: best day looks like ${best.label} — ${bestSentence}${outlook}`;
}

/**
 * Build the weekly report for one subscriber, covering 1+ breaks. Multi-break
 * texts use the compact per-break form so the total stays readable.
 * @param {Array<{breakName: string, hourlyRecords: Array}>} breakReports
 * @param {string[]} next7DateStrs array of 7 "YYYY-MM-DD" strings starting today, in order
 * @param {string[]} dayLabels matching human day labels, e.g. ["Today","Tue","Wed",...]
 */
export function buildWeeklyMessage(breakReports, next7DateStrs, dayLabels) {
  const compact = breakReports.length > 1;
  const snippets = breakReports.map((r) =>
    buildWeeklySnippet(r.breakName, r.hourlyRecords, next7DateStrs, dayLabels, { compact })
  );
  return `East Coast Swell weekly outlook — ${snippets.join(' ')} Reply STOP to unsubscribe.`;
}

/** Simple desirability score: rewards a solid, ridable size and penalizes wind. */
function scoreDay(summary) {
  if (!summary || summary.heightFt == null) return -Infinity;
  const idealHeight = 4; // sweet spot in feet
  const heightScore = -Math.abs(summary.heightFt - idealHeight);
  const windPenalty = (summary.avgWindMph ?? 10) * -0.4;
  return heightScore + windPenalty;
}
