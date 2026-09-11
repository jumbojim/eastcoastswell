# East Coast Swell — SMS Surf Report

A small backend that matches SMS subscribers to their nearest East Coast surf
break, pulls live wave/wind data from Open-Meteo, and texts a plain-language
surf report via Twilio on a daily or weekly schedule.

## How it fits together

```
Shopify page (public/signup-widget.html)
        │  POST /api/signup { phone, zip, frequency }
        ▼
Express API (server.js) ── zip → lat/long (Zippopotam) ── nearest break (haversine vs. breaks table)
        │
        ▼
Postgres (Supabase): breaks, subscribers, message_log, send_failures
        ▲
        │  reads subscribers grouped by break
worker.js (node-cron, timezone-aware)
        │  6am daily / Sunday evening weekly
        ▼
Open-Meteo Marine + Forecast APIs ── src/template.js (rule-based sentence) ── Twilio send
        ▲
        │  inbound STOP/START
Twilio webhook → POST /webhooks/twilio/inbound (server.js)
```

No AI/LLM is involved in message generation — `src/template.js` is pure
threshold/lookup-table logic, deterministic and easy to tune.

## Project layout

- `server.js` — Express API: signup endpoint + Twilio inbound webhook (STOP/START)
- `worker.js` — long-running scheduler (node-cron, timezone-aware) that triggers sends
- `scripts/send-report.js` — CLI: `node scripts/send-report.js daily|weekly` (manual test sends, or use with Render's native Cron Job instead of worker.js)
- `scripts/import-breaks.js` — loads `data/east_coast_surf_breaks.csv` into the `breaks` table
- `scripts/migrate.js` — applies `db/schema.sql`
- `src/` — geocoding, nearest-break matching, Open-Meteo integration, message templates, Twilio wrapper, db pool, config
- `public/signup-widget.html` — self-contained signup form to paste into a Shopify Custom Liquid block
- `db/schema.sql` — Postgres schema (breaks, subscribers, message_log, send_failures)
- `render.yaml` — Render Blueprint (API web service + scheduler background worker)

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, Twilio creds, etc.
npm run migrate        # creates tables
npm run import-breaks  # loads data/east_coast_surf_breaks.csv
npm start               # runs the API on http://localhost:3000
```

In another terminal:

```bash
npm run worker          # runs the scheduler (or trigger sends manually below)
npm run send:daily      # force a daily send right now, for testing
npm run send:weekly     # force a weekly send right now, for testing
```

Test the signup endpoint:

```bash
curl -X POST http://localhost:3000/api/signup \
  -H 'Content-Type: application/json' \
  -d '{"phone":"7325550123","zip":"07740","frequency":"daily"}'
```

## Editing the surf break list

Edit `data/east_coast_surf_breaks.csv` (columns: `break_name,state,region,latitude,longitude,notes`)
and re-run `npm run import-breaks` — it's an upsert keyed on `(break_name, state)`, safe to re-run.

## Deploying

See `SETUP.md` for the full account-by-account walkthrough (GitHub, Supabase,
Twilio, Render).

## Tuning the report language

All wording lives in `src/template.js`: `sizeDescriptor()`, `windDescriptor()`,
and the sentence templates in `conditionsSentence()` / `buildWeeklyMessage()`.
Change thresholds or phrasing there — no other file needs to change.
