// Copy this file to supabase-config.js for local development.
// supabase-config.js is git-ignored; in CI it is generated from repo secrets.
// The anon key is public by design - security relies on Row Level Security (see schema.sql).

window.SUPABASE_CONFIG = {
  url: 'https://your-project.supabase.co',
  anonKey: 'your-anon-key-here'
};
