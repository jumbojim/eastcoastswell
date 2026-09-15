import { pool } from './db.js';
import { getHourlyConditions } from './marine.js';
import {
  buildDailyMessage,
  buildWeeklyMessage,
  buildDailySnippet,
  buildWeeklySnippet,
} from './template.js';
import { sendSms } from './sms.js';
import { todayDateStr, nextDateStrs, dayLabels } from './dates.js';
import { config } from './config.js';

/**
 * Run one send pass for a given frequency ('daily' | 'weekly').
 *
 * A subscriber can follow more than one break (see subscriber_breaks) and
 * gets ONE combined text covering all of them, not one text per break. To
 * avoid re-fetching the same break's conditions once per subscriber, this
 * fetches each distinct break's conditions exactly once, then composes each
 * subscriber's message from that shared cache.
 */
export async function runSend(frequency) {
  if (frequency !== 'daily' && frequency !== 'weekly') {
    throw new Error(`frequency must be "daily" or "weekly", got "${frequency}"`);
  }

  const { rows } = await pool.query(
    `select s.id as subscriber_id, s.phone,
            b.id as break_id, b.break_name, b.latitude, b.longitude
     from subscribers s
     join subscriber_breaks sb on sb.subscriber_id = s.id
     join breaks b on b.id = sb.break_id
     where s.status = 'active' and s.frequency = $1
     order by s.id, sb.created_at asc`,
    [frequency]
  );

  if (!rows.length) {
    console.log(`[send:${frequency}] no active subscribers with a followed break — nothing to do.`);
    return [];
  }

  // Group rows -> per-subscriber break list, and collect the distinct breaks
  // we actually need conditions for.
  const subscribers = new Map(); // subscriber_id -> { phone, breaks: [{id, break_name, latitude, longitude}] }
  const breaksNeeded = new Map(); // break_id -> { break_name, latitude, longitude }

  for (const r of rows) {
    if (!subscribers.has(r.subscriber_id)) {
      subscribers.set(r.subscriber_id, { phone: r.phone, breaks: [] });
    }
    subscribers.get(r.subscriber_id).breaks.push({
      id: r.break_id,
      break_name: r.break_name,
      latitude: r.latitude,
      longitude: r.longitude,
    });
    if (!breaksNeeded.has(r.break_id)) {
      breaksNeeded.set(r.break_id, { break_name: r.break_name, latitude: r.latitude, longitude: r.longitude });
    }
  }

  console.log(
    `[send:${frequency}] ${subscribers.size} subscriber(s) across ${breaksNeeded.size} distinct break(s)`
  );

  const tz = config.reportTimezone;
  const days = frequency === 'weekly' ? 8 : 2;
  const today = todayDateStr(tz);
  const dates = frequency === 'weekly' ? nextDateStrs(tz, 7) : null;
  const labels = frequency === 'weekly' ? dayLabels(tz, 7) : null;

  // Fetch conditions once per distinct break. A failure here only drops that
  // one break from anyone's message this cycle, rather than aborting the run.
  const hourlyByBreak = new Map(); // break_id -> hourlyRecords | null
  const logSnippetByBreak = new Map(); // break_id -> canonical (non-compact) snippet, for message_log only

  for (const [breakId, b] of breaksNeeded) {
    try {
      const hourly = await getHourlyConditions(b.latitude, b.longitude, { timezone: tz, days });
      hourlyByBreak.set(breakId, hourly);
      logSnippetByBreak.set(
        breakId,
        frequency === 'daily'
          ? buildDailySnippet(b.break_name, hourly, today)
          : buildWeeklySnippet(b.break_name, hourly, dates, labels, { compact: false })
      );
    } catch (err) {
      console.error(`[send:${frequency}] failed to fetch conditions for ${b.break_name}:`, err.message);
      hourlyByBreak.set(breakId, null);
    }
  }

  // recipients/failures tallies per break, for message_log.
  const tally = new Map(); // break_id -> { sent: 0, failed: 0 }
  for (const breakId of breaksNeeded.keys()) tally.set(breakId, { sent: 0, failed: 0 });

  let messagesSent = 0;
  let messagesFailed = 0;
  let subscribersSkipped = 0;

  for (const [subscriberId, sub] of subscribers) {
    const breakReports = sub.breaks
      .filter((b) => hourlyByBreak.get(b.id) != null)
      .map((b) => ({ breakName: b.break_name, hourlyRecords: hourlyByBreak.get(b.id) }));

    if (!breakReports.length) {
      // Every break this subscriber follows failed to fetch this cycle.
      subscribersSkipped++;
      continue;
    }

    const message =
      frequency === 'daily'
        ? buildDailyMessage(breakReports, today)
        : buildWeeklyMessage(breakReports, dates, labels);

    const includedBreakIds = sub.breaks.filter((b) => hourlyByBreak.get(b.id) != null).map((b) => b.id);

    try {
      await sendSms(sub.phone, message);
      messagesSent++;
      for (const id of includedBreakIds) tally.get(id).sent++;
    } catch (err) {
      messagesFailed++;
      console.error(`[send:${frequency}] failed to text ${sub.phone}:`, err.message);
      for (const id of includedBreakIds) tally.get(id).failed++;
      await pool
        .query(
          `insert into send_failures (subscriber_id, phone, error_message) values ($1, $2, $3)`,
          [subscriberId, sub.phone, err.message]
        )
        .catch(() => {});
    }
  }

  for (const [breakId, counts] of tally) {
    if (counts.sent === 0 && counts.failed === 0) continue; // break had no active subscribers this cycle
    await pool.query(
      `insert into message_log (break_id, frequency, message_body, recipients_count, failures_count)
       values ($1, $2, $3, $4, $5)`,
      [breakId, frequency, logSnippetByBreak.get(breakId) ?? '', counts.sent, counts.failed]
    );
  }

  console.log(
    `[send:${frequency}] done — ${messagesSent} sent, ${messagesFailed} failed, ${subscribersSkipped} skipped (no conditions available)`
  );

  return { messagesSent, messagesFailed, subscribersSkipped };
}
