# myFinanceTracker

Personal finance tracker (income/expenses, rental income vs. loan, savings goal) built as a static page with Chart.js and Supabase.

## Setup
1. In the Supabase SQL editor: for a new project run [`schema.sql`](schema.sql); for an existing database run the files in [`supabase/migrations/`](supabase/migrations/) in order (`20261015000000_harden_schema.sql`, then `20261016000000_templates_settings_milestones.sql`). The app still works before the second migration, but quick transactions, the editable loan/target and sub-targets stay disabled.
2. In Supabase > Authentication > URL Configuration, set the Site URL to your GitHub Pages URL. Consider disabling public sign-ups once your account exists.
3. Add repository secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Settings > Secrets and variables > Actions).
4. Push to `main`; the workflow generates `supabase-config.js` and deploys `dist/` to GitHub Pages.

## Local development
```sh
cp supabase-config.example.js supabase-config.js   # then fill in your values
npx serve .                                         # or any static server
```
`supabase-config.js` is git-ignored. The anon key is public by design; Row Level Security is what protects the data.

## Tests
```sh
npm install
npm test
```
Tests (Vitest + jsdom) load `index.html` with a mocked Supabase client and a stubbed Chart.js, so they never touch a real database or the network. CI runs them before every deploy.

## Sessions
- Users stay signed in across reloads and browser restarts (the session is stored in the browser and refreshed automatically).
- They are asked to log in again after **30 days without opening the app** (`INACTIVITY_LIMIT_MS` in `index.html`).
- Only one active session: logging in on another device/browser ends all other sessions, which return to the login screen. Tabs in the same browser share one session.

## Features
- Income vs expenses with **quick transactions** (save a transaction once, add it in one tap), search/filter and CSV export.
- Rental income and savings: add, **edit**, delete and **reset** records; editable **loan amount** and **savings target**; **sub-targets** shown as milestones on the progress bar.
- Light/dark theme (follows the device) and a layout that works down to ~240px wide screens.

## Advice and monthly AI advice
The **Advice** tab has two parts:
- **Quick insights**: rule-based tips (savings rate, rising expenses, loan repayment pace, savings vs deadline, next sub-target) computed in the browser. No network, always available.
- **Monthly AI advice**: users can opt in. Once a month a scheduled job asks a free OpenAI-compatible LLM API for personalised recommendations and saves them. The app only ever shows the **latest saved advice**: opening the tab or calling the `ai-advice` function never triggers a new AI request, it returns the cached value.

How it works:
- `ai-advice-cron` (Edge Function) is called by a scheduler on the 1st-3rd of each month (GitHub Actions workflow `monthly-ai-advice.yml`, or `pg_cron`). It is protected by `CRON_SECRET` and is idempotent: it only creates advice for opted-in users who have none for the current month, so reruns are safe.
- `ai-advice` (Edge Function) is read-only: it returns the signed-in user's most recent row from `ai_advice_cache`.
- The API key (`AI_API_KEY`) lives only in Supabase secrets, never in the page.

**Privacy:** AI advice is off by default. When a user opts in (after a consent prompt) the app stores an anonymous summary (monthly totals, loan and savings progress; expense descriptions only if ticked) in `ai_advice_settings`. The cron job reads only that table, never transactions, rental or savings records, re-validates the summary before use, and logs only counts. Users can turn it off (which erases their shared summary) and delete their saved advice at any time; both tables are protected by Row Level Security.

**Setup** (details in the deployment steps you were given):
1. Run `supabase/migrations/20261019000000_ai_monthly_cache.sql` and then `20261020000000_ai_model_monitoring.sql`.
2. Set secrets: `AI_API_KEY`, `CRON_SECRET` (and optionally `AI_BASE_URL`, `AI_MODEL`, `AI_CRON_MAX_USERS`, `AI_CRON_DELAY_MS`, `ALLOWED_ORIGIN`).
3. Deploy: `supabase functions deploy ai-advice`, `supabase functions deploy ai-advice-health` and `supabase functions deploy ai-advice-cron --no-verify-jwt`.
4. Add the GitHub repository secrets `SUPABASE_URL` and `CRON_SECRET` (same value as the Supabase secret) so `monthly-ai-advice.yml` can run. Test it once from Actions > Monthly AI advice > Run workflow.

Free AI tiers (for example Groq, Google Gemini's OpenAI-compatible endpoint, OpenRouter `:free` models) change their limits, so check your provider's current limits.

**Tests:** `npm test` runs the core tests; `npm run test:ai` runs the AI tests; `npm run test:all` runs everything. In CI the AI tests are optional: they never block a deploy, and you can skip them with the repository variable `RUN_AI_TESTS=false`.

### Backup model and monitoring
- **Backup model:** if the primary model fails (timeout, rate limit, model removed or renamed, provider error, empty answer) the monthly job automatically retries once with the backup model (both default to Groq models and are editable). An invalid API key is not retried, because the backup would fail too. If both models are rate limited the run stops early and the next scheduled day continues.
- **Admin dashboard, "AI advice models":** success rate, calls, how often the backup was used, average and p95 latency, tokens in/out per model and per day, the last monthly run, recent errors, and **Test models now** (a tiny test request to each model, with status, latency, tokens and whether the API key / cron secret are configured).
- **Model settings (admin only):** kill switch, primary and backup model, temperature, max output tokens, timeout, users per run and pause between users. Changes are validated, enforced by the database and written to the audit log. The provider URL and API key are deliberately **not** editable from the app: they are Edge Function secrets, so user summaries can never be redirected from the page.
- **Privacy:** metrics are technical only (model name, status, latency, token counts). They never contain prompts, summaries, advice text or user ids, are readable by admins only and are deleted after 180 days.

## Owner (admin) console and privacy
The app owner can manage **app-wide settings only**: maintenance mode and message, an announcement banner, whether the sign-up button is shown, and the default loan/target for new users. Every change is written to an audit log.

**Privacy by design (compliance):**
- Users' financial data is protected by Row Level Security with "own rows only" policies. No admin policy exists on any content table, so an admin account is just a normal user for data access: it sees its own records and nothing else.
- The only cross-user information available to the admin is two **aggregate counts** (total accounts, new accounts in 30 days) through `admin_overview()`. No emails, identities or content are returned.
- Admin rights live in `app_admins`, which the app cannot modify (no insert/update/delete privileges); admins are created only from the SQL editor. The audit log is read-only for admins and written by a database trigger.
- `supabase/tests/admin_isolation.sql` is a read-only script that proves an admin cannot read other users' rows. Run it after every schema change.

**Setup:** apply `supabase/migrations/20261017000000_admin_console.sql`, then make yourself the owner (once):
```sql
insert into public.app_admins (user_id)
select id from auth.users where email = 'owner@example.com';
```

**Limits to be aware of:** maintenance mode, the sign-up button and the announcement are enforced in the page; to block API sign-ups also turn sign-ups off in Supabase (Authentication). Whoever holds the Supabase project credentials (dashboard or service-role key) can technically read the database; keep those credentials out of the app, restrict who has them, and cover this in your privacy policy / data-processing terms.
