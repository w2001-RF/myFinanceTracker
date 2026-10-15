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

## Advice and AI recommendations
The **Advice** tab has two parts:
- **Quick insights**: rule-based tips (savings rate, rising expenses, loan repayment pace, savings vs deadline, next sub-target) computed in the browser. No network, always available.
- **AI recommendations**: a Supabase Edge Function (`supabase/functions/ai-advice`) calls a free OpenAI-compatible LLM API and returns personalised tips. The API key is stored as a Supabase secret, never in the page.

**Privacy:** the page sends only an anonymous summary (monthly income/expense totals, loan and savings progress). No name, email, account id or notes; expense descriptions are shared only if the user ticks the option. The user is asked for consent before the first request, the function validates and re-builds the payload, nothing is stored (only a timestamp for the daily quota) and the answer is shown as plain text.

**Setup:**
1. Run `supabase/migrations/20261018000000_ai_advice_usage.sql`.
2. Get a free API key from an OpenAI-compatible provider (for example [Groq](https://console.groq.com), Google Gemini's OpenAI-compatible endpoint, or OpenRouter `:free` models). Free-tier limits change, so check the provider's current limits.
3. Deploy:
```sh
supabase secrets set AI_API_KEY=your-key
# optional: AI_BASE_URL (default https://api.groq.com/openai/v1), AI_MODEL (default llama-3.3-70b-versatile),
#           AI_DAILY_LIMIT (default 5 per user per 24h), ALLOWED_ORIGIN (e.g. https://you.github.io)
supabase functions deploy ai-advice
```
Until the function is deployed the AI button shows a friendly "not set up yet" message and the quick insights keep working.
