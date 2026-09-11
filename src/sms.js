import twilio from 'twilio';
import { config } from './config.js';

let client = null;
function getClient() {
  if (!client) {
    client = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return client;
}

/**
 * Send one SMS. Twilio (for numbers/Messaging Services with Advanced
 * Opt-Out enabled, the default for US long codes and toll-free numbers)
 * automatically intercepts STOP/UNSUBSCRIBE/CANCEL/END/QUIT replies and
 * blocks further sends to that number at the carrier level — the inbound
 * webhook in server.js additionally mirrors that into our own `subscribers`
 * table so the cron job stops selecting them and the signup/status UI stays
 * accurate.
 */
export async function sendSms(to, body) {
  const params = { to, body };
  if (config.twilio.messagingServiceSid) {
    params.messagingServiceSid = config.twilio.messagingServiceSid;
  } else {
    params.from = config.twilio.fromNumber;
  }
  return getClient().messages.create(params);
}

/** Normalize a US phone number (various input formats) to E.164, e.g. +15551234567. */
export function normalizeUsPhone(raw) {
  const digits = String(raw).replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(raw).startsWith('+') && digits.length >= 10) return `+${digits}`;
  return null; // caller should treat as invalid
}

export function validateTwilioSignature(req) {
  const signature = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  return twilio.validateRequest(config.twilio.authToken, signature, url, req.body);
}
