import { pool } from './db.js';
import { getHourlyConditions } from './marine.js';
import { buildDailyMessage, buildWeeklyMessage } from './template.js';
import { sendSms } from './sms.js';
import { todayDateStr, nextDateStrs, dayLabels } from './dates.js';
import { config } from './config.js';

/** Run one send pass for a given frequency ('daily' | 'weekly'). */
export async function runSend(frequency) {
  if (frequency !== 'daily' && frequency !== 'weekly') {
    throw new Error(`frequency must be "daily" or "weekly", got "${frequency}"`);
  }

  const { rows: groups } = await pool.query(
    `select b.id as break_id, b.break_name, b.latitude, b.longitude,
            array_agg(s.id) as subscriber_ids, array_agg(s.phone) as phones
     from subscribers s
     join breaks b on b.id = s.matched_break_id
     where s.status = 'active' and s.frequency = $1
     group by b.id, b.break_name, b.latitude, b.longitude`,
    [frequency]
  );

  console.log(`[send:${frequency}] ${groups.length} break group(s) to message`);

  const results = [];
  for (const group of groups) {
    try {
      const result = await sendForBreak(group, frequency);
      results.push(result);
    } catch (err) {
      console.error(`[send:${frequency}] break ${group.break_name} failed entirely:`, err.message);
      results.push({ breakName: group.break_name, error: err.message });
    }
  }
  return results;
}

async function sendForBreak(group, frequency) {
  const tz = config.reportTimezone;
  const days = frequency === 'weekly' ? 8 : 2;

  const hourly = await getHourlyConditions(group.latitude, group.longitude, {
    timezone: tz,
    days,
  });

  let message;
  if (frequency === 'daily') {
    message = buildDailyMessage(group.break_name, hourly, todayDateStr(tz));
  } else {
    const dates = nextDateStrs(tz, 7);
    const labels = dayLabels(tz, 7);
    message = buildWeeklyMessage(group.break_name, hourly, dates, labels);
  }

  const subscriberIds = group.subscriber_ids;
  const phones = group.phones;

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < phones.length; i++) {
    const phone = phones[i];
    const subscriberId = subscriberIds[i];
    try {
      await sendSms(phone, message);
      sent++;
    } catch (err) {
      failed++;
      console.error(`[send:${frequency}] failed to text ${phone}:`, err.message);
      await pool
        .query(
          `insert into send_failures (subscriber_id, phone, error_message) values ($1, $2, $3)`,
          [subscriberId, phone, err.message]
        )
        .catch(() => {});
    }
  }

  await pool.query(
    `insert into message_log (break_id, frequency, message_body, recipients_count, failures_count)
     values ($1, $2, $3, $4, $5)`,
    [group.break_id, frequency, message, sent, failed]
  );

  console.log(
    `[send:${frequency}] ${group.break_name}: sent ${sent}/${phones.length} — "${message}"`
  );

  return { breakName: group.break_name, message, sent, failed };
}
