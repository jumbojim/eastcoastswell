// CLI entry point: `node scripts/send-report.js daily` or `... weekly`.
// Useful for manual test sends, and as the command a Render Cron Job (or
// any other scheduler) can invoke directly instead of running worker.js.

import { assertSendConfig } from '../src/config.js';
import { runSend } from '../src/sendReport.js';
import { pool } from '../src/db.js';

const frequency = process.argv[2];

async function main() {
  if (frequency !== 'daily' && frequency !== 'weekly') {
    console.error('Usage: node scripts/send-report.js <daily|weekly>');
    process.exit(1);
  }
  assertSendConfig();
  await runSend(frequency);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
