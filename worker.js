// Persistent scheduler process. Deploy this as a Render "Background Worker"
// (long-running, no public port needed) so sends happen at the right LOCAL
// time in REPORT_TIMEZONE year-round, including across DST — node-cron's
// `timezone` option handles that for us, which a plain UTC cron expression
// cannot.
//
// Alternative: if you'd rather use Render's native Cron Job service type
// (which spins a container up, runs one command, and shuts it down), skip
// this file and instead schedule `node scripts/send-report.js daily` /
// `... weekly` directly. See SETUP.md for the tradeoffs.

import cron from 'node-cron';
import { assertSendConfig, config } from './src/config.js';
import { runSend } from './src/sendReport.js';

assertSendConfig();

console.log(`Worker starting. Timezone: ${config.reportTimezone}`);
console.log(`Daily cron:  ${config.dailySendCron}`);
console.log(`Weekly cron: ${config.weeklySendCron}`);

cron.schedule(
  config.dailySendCron,
  () => {
    console.log('Running daily send...');
    runSend('daily').catch((err) => console.error('Daily send failed:', err));
  },
  { timezone: config.reportTimezone }
);

cron.schedule(
  config.weeklySendCron,
  () => {
    console.log('Running weekly send...');
    runSend('weekly').catch((err) => console.error('Weekly send failed:', err));
  },
  { timezone: config.reportTimezone }
);

// Keep the process alive.
process.stdin.resume();
