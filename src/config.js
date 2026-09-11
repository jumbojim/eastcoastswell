import 'dotenv/config';

function required(name, fallback) {
  const val = process.env[name] ?? fallback;
  return val;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: required('DATABASE_URL'),

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || null,
  },

  signupAllowedOrigins: (process.env.SIGNUP_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  reportTimezone: process.env.REPORT_TIMEZONE || 'America/New_York',
  dailySendCron: process.env.DAILY_SEND_CRON || '0 6 * * *',
  weeklySendCron: process.env.WEEKLY_SEND_CRON || '0 18 * * 0',
};

export function assertSendConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.twilio.accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!config.twilio.authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!config.twilio.fromNumber && !config.twilio.messagingServiceSid) {
    missing.push('TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID');
  }
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
