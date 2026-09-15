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

    await pool.query(
      `insert into subscribers (phone, zip, lookup_latitude, lookup_longitude, matched_break_id, frequency, status, opt_in_timestamp)
       values ($1, $2, $3, $4, $5, $6, 'active', now())
       on conflict (phone) do update set
         zip = excluded.zip,
         lookup_latitude = excluded.lookup_latitude,
         lookup_longitude = excluded.lookup_longitude,
         matched_break_id = excluded.matched_break_id,
         frequency = excluded.frequency,
         status = 'active',
         resubscribed_at = case when subscribers.status = 'unsubscribed' then now() else subscribers.resubscribed_at end`,
      [e164, location.zip, location.latitude, location.longitude, nearest.match.id, frequency]
    );

    return res.json({
      ok: true,
      matchedBreak: nearest.match.break_name,
      distanceMiles: Math.round(nearest.distanceMiles),
      far: isFar,
      frequency,
    });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// --- Twilio inbound webhook (STOP / START handling) ------------------------
// Point your Twilio number's "A message comes in" webhook at:
//   https://<your-app>/webhooks/twilio/inbound
// Twilio's own Advanced Opt-Out already blocks sends at the carrier level for
// STOP/UNSUBSCRIBE/CANCEL/END/QUIT (and unblocks on START/UNSTOP/YES) — this
// webhook mirrors that state into our own `subscribers` table so the cron
// job's query stays accurate and doesn't waste sends.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);

app.post('/webhooks/twilio/inbound', async (req, res) => {
  try {
    if (config.twilio.authToken && !validateTwilioSignature(req)) {
      return res.status(403).send('Invalid signature');
    }

    const from = req.body?.From;
    const body = String(req.body?.Body || '').trim().toLowerCase();

    if (from) {
      if (STOP_WORDS.has(body)) {
        await pool.query(
          `update subscribers set status = 'unsubscribed', unsubscribed_at = now() where phone = $1`,
          [from]
        );
        console.log(`Marked ${from} as unsubscribed.`);
      } else if (START_WORDS.has(body)) {
        await pool.query(
          `update subscribers set status = 'active', resubscribed_at = now() where phone = $1`,
          [from]
        );
        console.log(`Marked ${from} as re-subscribed.`);
      }
    }

    // Empty TwiML response — Twilio's own compliance auto-reply already
    // covers the confirmation text for STOP/START on supported number types.
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  } catch (err) {
    console.error('Inbound webhook error:', err);
    res.status(500).send('error');
  }
});

app.listen(config.port, () => {
  console.log(`East Coast Swell SMS server listening on port ${config.port}`);
});
