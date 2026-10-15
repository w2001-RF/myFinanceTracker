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
