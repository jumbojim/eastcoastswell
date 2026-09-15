import express from 'express';
import { config } from './src/config.js';
import { pool } from './src/db.js';
import { zipToLatLong, GeocodeError } from './src/geocode.js';
import { findNearestBreak } from './src/matching.js';
import { normalizeUsPhone, validateTwilioSignature } from './src/sms.js';

const app = express();

// Twilio webhooks post form-encoded bodies; the signup form posts JSON.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (
    config.signupAllowedOrigins.length === 0 ||
    config.signupAllowedOrigins.includes('*') ||
    (origin && config.signupAllowedOrigins.includes(origin))
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

// --- Signup ---------------------------------------------------------------
app.post('/api/signup', corsMiddleware, async (req, res) => {
  try {
    const { phone, zip, frequency } = req.body || {};

    if (!phone || !zip || !frequency) {
      return res.status(400).json({ error: 'phone, zip, and frequency are all required.' });
    }
    if (!['daily', 'weekly'].includes(frequency)) {
      return res.status(400).json({ error: 'frequency must be "daily" or "weekly".' });
    }

    const e164 = normalizeUsPhone(phone);
    if (!e164) {
      return res.status(400).json({ error: 'That phone number doesn\'t look valid.' });
    }

    let location;
    try {
      location = await zipToLatLong(zip);
    } catch (err) {
      if (err instanceof GeocodeError) return res.status(400).json({ error: err.message });
      throw err;
    }

    const { rows: breaks } = await pool.query(
      `select id, break_name, latitude, longitude from breaks`
    );
    const nearest = findNearestBreak(location, breaks);
    if (!nearest) {
      return res.status(500).json({ error: 'No surf breaks configured yet — contact support.' });
    }

    if (nearest.distanceMiles > config.matching.maxDistanceMiles) {
      return res.status(400).json({
        error:
          `That zip isn't close to any East Coast break we cover yet ` +
          `(closest is ${nearest.match.break_name}, ${Math.round(nearest.distanceMiles)} mi away). ` +
          `Reach out if you'd like us to add coverage near you.`,
      });
    }
    const isFar = nearest.distanceMiles > config.matching.warnDistanceMiles;

    const { rows: subRows } = await pool.query(
      `insert into subscribers (phone, zip, lookup_latitude, lookup_longitude, frequency, status, opt_in_timestamp)
       values ($1, $2, $3, $4, $5, 'active', now())
       on conflict (phone) do update set
         zip = excluded.zip,
         lookup_latitude = excluded.lookup_latitude,
         lookup_longitude = excluded.lookup_longitude,
         frequency = excluded.frequency,
         status = 'active',
         resubscribed_at = case when subscribers.status = 'unsubscribed' then now() else subscribers.resubscribed_at end
       returning id`,
      [e164, location.zip, location.latitude, location.longitude, frequency]
    );
    const subscriberId = subRows[0].id;

    const { rows: existingBreaks } = await pool.query(
      `select break_id from subscriber_breaks where subscriber_id = $1`,
      [subscriberId]
    );
    const alreadyFollowing = existingBreaks.some((b) => b.break_id === nearest.match.id);
    const atCap = existingBreaks.length >= config.maxBreaksPerSubscriber;

    let added = alreadyFollowing;
    if (!alreadyFollowing && !atCap) {
      await pool.query(
        `insert into subscriber_breaks (subscriber_id, break_id) values ($1, $2) on conflict do nothing`,
        [subscriberId, nearest.match.id]
      );
      added = true;
    }

    return res.json({
      ok: true,
      matchedBreak: nearest.match.break_name,
      distanceMiles: Math.round(nearest.distanceMiles),
      far: isFar,
      frequency,
      // Only relevant on a re-signup: false means they were already at the
      // max-breaks cap and this break wasn't added to their list.
      added,
    });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// --- Twilio inbound webhook (STOP/START + BREAKS/ADD/REMOVE) ---------------
// Point your Twilio number's "A message comes in" webhook at:
//   https://<your-app>/webhooks/twilio/inbound
// Twilio's own Advanced Opt-Out already blocks sends at the carrier level for
// STOP/UNSUBSCRIBE/CANCEL/END/QUIT (and unblocks on START/UNSTOP/YES) — this
// webhook mirrors that state into our own `subscribers` table so the cron
// job's query stays accurate and doesn't waste sends.
//
// BREAKS/ADD/REMOVE let a subscriber self-manage which break(s) they follow,
// entirely over SMS — each command is a single self-contained message (no
// multi-step conversation state to track). REMOVE's "number" refers to the
// position in the list BREAKS (and every other command's reply) shows, which
// is always the same stable order (oldest-added first), recomputed fresh
// each time rather than stored — so there's nothing to go stale or expire.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatBreaksList(breaks) {
  return breaks.map((b, i) => `${i + 1}) ${b.break_name}`).join('\n');
}

async function getSubscriberByPhone(phone) {
  const { rows } = await pool.query(`select id, status from subscribers where phone = $1`, [phone]);
  return rows[0] || null;
}

async function getSubscriberBreaksOrdered(subscriberId) {
  const { rows } = await pool.query(
    `select b.id as break_id, b.break_name
     from subscriber_breaks sb
     join breaks b on b.id = sb.break_id
     where sb.subscriber_id = $1
     order by sb.created_at asc`,
    [subscriberId]
  );
  return rows;
}

app.post('/webhooks/twilio/inbound', async (req, res) => {
  const respond = (text) => {
    res.set('Content-Type', 'text/xml');
    if (text) {
      res.send(`<Response><Message>${xmlEscape(text)}</Message></Response>`);
    } else {
      // No reply — Twilio's own compliance auto-reply already covers STOP/START.
      res.send('<Response></Response>');
    }
  };

  try {
    if (config.twilio.authToken && !validateTwilioSignature(req)) {
      return res.status(403).send('Invalid signature');
    }

    const from = req.body?.From;
    const rawBody = String(req.body?.Body || '').trim();
    const body = rawBody.toLowerCase();

    if (!from) return respond(null);

    if (STOP_WORDS.has(body)) {
      await pool.query(
        `update subscribers set status = 'unsubscribed', unsubscribed_at = now() where phone = $1`,
        [from]
      );
      console.log(`Marked ${from} as unsubscribed.`);
      return respond(null);
    }

    if (START_WORDS.has(body)) {
      await pool.query(
        `update subscribers set status = 'active', resubscribed_at = now() where phone = $1`,
        [from]
      );
      console.log(`Marked ${from} as re-subscribed.`);
      return respond(null);
    }

    if (body === 'breaks') {
      const subscriber = await getSubscriberByPhone(from);
      if (!subscriber) return respond("We don't have a signup for this number yet — sign up on our site first.");
      const breaks = await getSubscriberBreaksOrdered(subscriber.id);
      if (!breaks.length) {
        return respond('You\'re not following any breaks yet. Text ADD and a 5-digit zip to pick one, e.g. "ADD 07740".');
      }
      return respond(`You're following:\n${formatBreaksList(breaks)}\n\nText ADD <zip> or REMOVE <number> to change.`);
    }

    if (/^add\b/.test(body)) {
      const zip = body.replace(/^add\s*/, '').trim();
      if (!/^\d{5}$/.test(zip)) {
        return respond('To add a break, text ADD followed by a 5-digit zip code, e.g. "ADD 07740".');
      }

      const subscriber = await getSubscriberByPhone(from);
      if (!subscriber) return respond("We don't have a signup for this number yet — sign up on our site first.");

      let location;
      try {
        location = await zipToLatLong(zip);
      } catch (err) {
        return respond(err instanceof GeocodeError ? err.message : 'That zip lookup failed — try again shortly.');
      }

      const currentBreaks = await getSubscriberBreaksOrdered(subscriber.id);
      if (currentBreaks.length >= config.maxBreaksPerSubscriber) {
        return respond(
          `You're already following the max of ${config.maxBreaksPerSubscriber} breaks:\n` +
            `${formatBreaksList(currentBreaks)}\n\nText REMOVE <number> to swap one out first.`
        );
      }

      const { rows: allBreaks } = await pool.query(`select id, break_name, latitude, longitude from breaks`);
      const followedIds = new Set(currentBreaks.map((b) => b.break_id));
      const candidates = allBreaks.filter((b) => !followedIds.has(b.id));
      const nearest = findNearestBreak(location, candidates);

      if (!nearest) return respond("You're already following every break we have near that zip.");
      if (nearest.distanceMiles > config.matching.maxDistanceMiles) {
        return respond(
          `That zip isn't close to any East Coast break we cover ` +
            `(closest is ${nearest.match.break_name}, ${Math.round(nearest.distanceMiles)} mi away).`
        );
      }

      await pool.query(
        `insert into subscriber_breaks (subscriber_id, break_id) values ($1, $2) on conflict do nothing`,
        [subscriber.id, nearest.match.id]
      );
      const updated = await getSubscriberBreaksOrdered(subscriber.id);
      const farNote = nearest.distanceMiles > config.matching.warnDistanceMiles
        ? ` (${Math.round(nearest.distanceMiles)} mi away)`
        : '';
      return respond(`Added ${nearest.match.break_name}${farNote}. You're now following:\n${formatBreaksList(updated)}`);
    }

    if (/^remove\b/.test(body)) {
      const arg = rawBody.replace(/^remove\s*/i, '').trim();
      const subscriber = await getSubscriberByPhone(from);
      if (!subscriber) return respond("We don't have a signup for this number yet — sign up on our site first.");

      const currentBreaks = await getSubscriberBreaksOrdered(subscriber.id);
      if (!currentBreaks.length) {
        return respond('You\'re not following any breaks yet. Text ADD and a 5-digit zip to pick one.');
      }
      if (!arg) {
        return respond(
          `Text REMOVE and a number or break name, e.g. "REMOVE 2".\n\nYou're following:\n${formatBreaksList(currentBreaks)}`
        );
      }

      let target = null;
      if (/^\d+$/.test(arg)) {
        target = currentBreaks[Number(arg) - 1] || null;
      } else {
        const needle = arg.toLowerCase();
        const matches = currentBreaks.filter((b) => b.break_name.toLowerCase().includes(needle));
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) {
          return respond(`That matches more than one break: ${matches.map((m) => m.break_name).join(', ')}. Be more specific, or use the number from BREAKS.`);
        }
      }

      if (!target) {
        return respond(`Couldn't find "${arg}" in your list:\n${formatBreaksList(currentBreaks)}`);
      }

      await pool.query(`delete from subscriber_breaks where subscriber_id = $1 and break_id = $2`, [
        subscriber.id,
        target.break_id,
      ]);
      const remaining = await getSubscriberBreaksOrdered(subscriber.id);
      const remainingText = remaining.length
        ? `You're now following:\n${formatBreaksList(remaining)}`
        : "You're not following any breaks now. Text ADD <zip> to pick one, or STOP to unsubscribe completely.";
      return respond(`Removed ${target.break_name}. ${remainingText}`);
    }

    // Unrecognized message — no reply, same as before.
    return respond(null);
  } catch (err) {
    console.error('Inbound webhook error:', err);
    res.status(500).send('error');
  }
});

app.listen(config.port, () => {
  console.log(`East Coast Swell SMS server listening on port ${config.port}`);
});
