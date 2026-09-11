# Setup checklist

Do these in order. Each step says exactly what to click/create; nothing here
requires giving me (Claude) any password, API key, or auth token — you'll
paste secrets directly into Supabase/Twilio/Render/GitHub's own dashboards,
never into this chat.

## 1. GitHub — create the repo

1. Go to github.com → **New repository** → name it e.g. `east-coast-swell-sms` → keep it **private** (it'll hold your Twilio/Supabase connection details as env vars, not in code, but private is still the right default) → don't initialize with a README (we already have one).
2. Copy the "push an existing repository" commands GitHub shows you (something like):
   ```bash
   git remote add origin https://github.com/<you>/east-coast-swell-sms.git
   git branch -M main
   git push -u origin main
   ```
3. Tell me the repo URL and I'll wire the remote and push what's built so far — or paste those commands yourself if you'd rather push from your own machine.

## 2. Supabase — database

1. supabase.com → **New project**. Pick a region close to you (e.g. US East).
2. Save the database password somewhere safe when it's shown — you won't see it again.
3. Project Settings → **Database** → **Connection string** → copy the **URI** (use the pooled "Transaction" connection string, port 6543, for anything long-running; direct port 5432 is fine for one-off scripts). This is your `DATABASE_URL`.
4. Once you give me that connection string (or set it as an env var and tell me it's set), I'll run:
   ```bash
   npm run migrate       # creates tables from db/schema.sql
   npm run import-breaks # loads data/east_coast_surf_breaks.csv (168 breaks)
   ```

## 3. Twilio — SMS sending + STOP handling

1. twilio.com → sign up → verify your own phone number for the trial.
2. Buy a phone number (Console → **Phone Numbers** → **Buy a number**) with SMS capability. For real (non-trial) sending in the US, Twilio will also walk you through **A2P 10DLC registration** (brand + campaign) — required by carriers before you can send marketing SMS at volume; expect it to take 1-3 business days for campaign vetting. A **toll-free number** is a faster path to get started (its own verification, usually same-day to a couple weeks) if you want to test sooner.
3. Console → **Account** → **API keys & tokens** gives you `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
4. Turn on **Advanced Opt-Out** for your number/messaging service (Messaging → Settings) so Twilio auto-blocks STOP/UNSUBSCRIBE/CANCEL/END/QUIT at the carrier level. This project's webhook (`/webhooks/twilio/inbound`) mirrors that into our own database on top of it.
5. Once the app is deployed (step 4 below) and you have its URL, go to your Twilio number's config → **"A message comes in"** → set to `https://<your-render-url>/webhooks/twilio/inbound`, HTTP POST.
6. If you expect to grow past a few hundred subscribers, consider creating a **Messaging Service** (Console → Messaging → Services) and using `TWILIO_MESSAGING_SERVICE_SID` instead of a single `TWILIO_FROM_NUMBER` — it handles multiple numbers and throughput automatically. Not required to start.

## 4. Render — hosting

We use two Render services from one repo (a `render.yaml` blueprint is already set up):
- **Web service** (`east-coast-swell-sms-api`) — runs `server.js`, handles signup + Twilio webhook.
- **Background worker** (`east-coast-swell-sms-scheduler`) — runs `worker.js`, a persistent process that fires the daily (6am ET) and weekly (Sunday evening ET) sends via `node-cron`, timezone-aware so it's correct across daylight saving time changes.

Steps:
1. render.com → sign up → connect your GitHub account and authorize the `east-coast-swell-sms` repo.
2. **New** → **Blueprint** → pick the repo → Render reads `render.yaml` and proposes both services.
3. Before/after creating them, fill in the env vars marked "secret" in the dashboard for **both** services: `DATABASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (or `TWILIO_MESSAGING_SERVICE_SID`), and on the web service only, `SIGNUP_ALLOWED_ORIGINS` (your Shopify domain, e.g. `https://your-store.myshopify.com`).
4. Deploy. Grab the web service's `.onrender.com` URL — that's what goes into the Twilio webhook (step 3.5 above) and into `public/signup-widget.html`'s `API_BASE_URL`.

Why Render over Vercel here: the scheduler needs a long-running process so
node-cron can fire at the right local time every day — Vercel's serverless
functions aren't built for that (they run on request, not on a persistent
timer). Vercel would work fine for the signup form/static assets alone, but
since Render can host those too (or you can just paste the widget into
Shopify directly, which needs no hosting at all), one platform is simpler.
If you'd rather use Render's native **Cron Job** service type instead of
`worker.js`, that works too — point it at `node scripts/send-report.js daily`
/ `... weekly` on the schedule you want (see the note in `worker.js`).

## 5. Shopify — the signup form

No app needed. Open `public/signup-widget.html`, replace `API_BASE_URL` at
the top of the `<script>` with your Render web service's URL, then in
Shopify: **Online Store → Themes → Customize** → add a **Custom Liquid**
section wherever you want the form (a page, the footer, etc.) → paste the
whole file's contents in.

## What I need from you to move forward

- [ ] GitHub repo URL (or tell me to hold off and you'll push yourself)
- [ ] Supabase `DATABASE_URL` (or confirm it's set as an env var somewhere I can reach — see note below)
- [ ] Twilio Account SID / Auth Token / From-number (same — set as env vars, not pasted in chat)
- [ ] Your Shopify store domain, for `SIGNUP_ALLOWED_ORIGINS`

Since this session runs in an isolated sandbox, I can't run `npm install`,
hit the live Open-Meteo API, or connect to your Supabase database from here
directly (network is locked down to a small allowlist) — those all work
fine once deployed to Render, or if you run the project locally on your own
machine. I've verified all the logic that doesn't need network access
(nearest-break matching, message templates, phone/date handling) with a
local test script; see the "Verification" note in the final summary.
