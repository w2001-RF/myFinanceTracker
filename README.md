# myFinanceTracker

Personal finance tracker (income/expenses, rental income vs. loan, savings goal) built as a static page with Chart.js and Supabase.

## Setup
1. In the Supabase SQL editor: for a new project run [`schema.sql`](schema.sql); for an existing database run [`supabase/migrations/20261015000000_harden_schema.sql`](supabase/migrations/20261015000000_harden_schema.sql) (adds constraints, defaults and Row Level Security policies).
2. In Supabase > Authentication > URL Configuration, set the Site URL to your GitHub Pages URL. Consider disabling public sign-ups once your account exists.
3. Add repository secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Settings > Secrets and variables > Actions).
4. Push to `main`; the workflow generates `supabase-config.js` and deploys `dist/` to GitHub Pages.

## Local development
```sh
cp supabase-config.example.js supabase-config.js   # then fill in your values
npx serve .                                         # or any static server
```
`supabase-config.js` is git-ignored. The anon key is public by design; Row Level Security is what protects the data.
