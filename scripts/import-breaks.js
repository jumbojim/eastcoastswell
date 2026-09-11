// Loads data/east_coast_surf_breaks.csv into the `breaks` table.
// Safe to re-run: upserts on (break_name, state) so editing the CSV and
// re-running keeps things in sync instead of creating duplicates.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { pool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvPath = process.argv[2] || path.join(__dirname, '..', 'data', 'east_coast_surf_breaks.csv');

async function main() {
  const raw = readFileSync(csvPath, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });

  console.log(`Importing ${records.length} breaks from ${csvPath} ...`);

  let count = 0;
  for (const r of records) {
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    if (!r.break_name || Number.isNaN(lat) || Number.isNaN(lon)) {
      console.warn('Skipping malformed row:', r);
      continue;
    }

    await pool.query(
      `insert into breaks (break_name, state, region, latitude, longitude, notes)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (break_name, state) do update set
         region = excluded.region,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         notes = excluded.notes`,
      [r.break_name, r.state || null, r.region || null, lat, lon, r.notes || null]
    );
    count++;
  }

  console.log(`Imported/updated ${count} breaks.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
