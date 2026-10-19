// Supabase Edge Function: ai-advice-health  (admin only)
//
// Sends one tiny test request to the primary model and one to the backup model and reports, for each:
// whether it answered, HTTP status, error kind, latency and token usage. The test prompt contains no user data.
// Also reports non-secret configuration (provider host, whether the API key / cron secret are set).
// Results are stored as `kind = 'health'` metric rows so the dashboard can show the last test.
//
// Deploy with normal JWT verification (a signed-in admin calls it from the dashboard):
//   supabase functions deploy ai-advice-health
//
// Env: AI_API_KEY, optional AI_BASE_URL / AI_MODEL / AI_FALLBACK_MODEL / ALLOWED_ORIGIN (see ai-advice-cron).
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { callChatModel, resolveModelSettings, toMetricRow } from '../_shared/ai-client.ts';

const AI_BASE_URL = (Deno.env.get('AI_BASE_URL') ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*';
const COOLDOWN_MS = 10_000;

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'unauthorized' }, 401);

  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await asUser.auth.getUser();
  if (userError || !userData.user) return json({ error: 'unauthorized' }, 401);

  // Admin check happens in the database, with the caller's own identity
  const { data: isAdmin, error: adminError } = await asUser.rpc('is_admin');
  if (adminError || isAdmin !== true) return json({ error: 'forbidden' }, 403);

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  // Cooldown: at most one health test every few seconds (protects the free tier)
  const { data: last } = await service
    .from('ai_advice_calls')
    .select('created_at')
    .eq('kind', 'health')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last && Date.now() - Date.parse(last.created_at) < COOLDOWN_MS) return json({ error: 'cooldown' }, 429);

  const { data: settingsRow } = await service.from('ai_model_settings').select('*').eq('id', true).maybeSingle();
  const settings = resolveModelSettings(settingsRow, {
    AI_MODEL: Deno.env.get('AI_MODEL'),
    AI_FALLBACK_MODEL: Deno.env.get('AI_FALLBACK_MODEL'),
  });

  const apiKey = Deno.env.get('AI_API_KEY');
  const config = {
    provider_host: new URL(AI_BASE_URL).host,
    api_key_configured: Boolean(apiKey),
    cron_secret_configured: Boolean(Deno.env.get('CRON_SECRET')),
    primary_model: settings.primary_model,
    fallback_model: settings.fallback_model,
    enabled: settings.enabled,
  };
  if (!apiKey) return json({ config, results: [], error: 'not_configured' }, 503);

  const models: { model: string; role: 'primary' | 'fallback' }[] = [{ model: settings.primary_model, role: 'primary' }];
  if (settings.fallback_model && settings.fallback_model !== settings.primary_model) {
    models.push({ model: settings.fallback_model, role: 'fallback' });
  }

  const attempts = await Promise.all(models.map((m) => callChatModel({
    baseUrl: AI_BASE_URL,
    apiKey,
    model: m.model,
    role: m.role,
    system: 'You are a health check. Reply with the single word OK.',
    user: 'ping',
    temperature: 0,
    maxTokens: 8,
    timeoutMs: settings.timeout_seconds * 1000,
  })));

  await service.from('ai_advice_calls').insert(attempts.map((a) => ({ run_id: null, kind: 'health', ...toMetricRow(a) })));

  return json({ config, results: attempts.map(toMetricRow) });
});
