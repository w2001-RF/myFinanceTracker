// Supabase Edge Function: ai-advice
//
// Read-only. Returns the signed-in user's most recent monthly AI advice from the cache table.
// It never calls the AI provider: advice is generated once a month by the `ai-advice-cron` function,
// so every call here costs nothing and always returns the last saved value.
//
// Response: { advice: string | null, period?: 'YYYY-MM', generated_at?: ISO date }
// SUPABASE_URL and SUPABASE_ANON_KEY are provided automatically by Supabase.
// Optional env: ALLOWED_ORIGIN (CORS origin of the site, e.g. https://you.github.io; default *).

import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Vary': 'Origin',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'unauthorized' }, 401);

  // The user's own JWT is forwarded, so Row Level Security limits the query to their own rows
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return json({ error: 'unauthorized' }, 401);

  const { data, error } = await supabase
    .from('ai_advice_cache')
    .select('period, advice, created_at')
    .order('period', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return json({ error: 'unavailable' }, 503);
  if (!data) return json({ advice: null });

  return json({ advice: data.advice, period: data.period, generated_at: data.created_at });
});
