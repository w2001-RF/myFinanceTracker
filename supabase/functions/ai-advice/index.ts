// Supabase Edge Function: ai-advice
//
// Receives an anonymised summary of the signed-in user's finances, asks a free OpenAI-compatible LLM API
// for recommendations and returns the text. The API key lives only here (as a secret), never in the browser.
//
// Secrets / env (set with `supabase secrets set`):
//   AI_API_KEY        required  key for the provider below
//   AI_BASE_URL       optional  OpenAI-compatible base URL (default: Groq)
//   AI_MODEL          optional  model id (default below; check your provider's current free models)
//   AI_DAILY_LIMIT    optional  advice requests per user per 24h (default 5)
//   ALLOWED_ORIGIN    optional  CORS origin of the site, e.g. https://you.github.io (default *)
// SUPABASE_URL and SUPABASE_ANON_KEY are provided automatically by Supabase.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildPrompt, extractAdvice, parseLimit, validateSummary } from './logic.ts';

const AI_BASE_URL = (Deno.env.get('AI_BASE_URL') ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const AI_MODEL = Deno.env.get('AI_MODEL') ?? 'llama-3.3-70b-versatile';
const DAILY_LIMIT = parseLimit(Deno.env.get('AI_DAILY_LIMIT'), 5);
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*';
const MAX_BODY_BYTES = 20_000;

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

  const apiKey = Deno.env.get('AI_API_KEY');
  if (!apiKey) return json({ error: 'not_configured' }, 503);

  // Only signed-in users; RLS applies to every query below because we forward the user's own JWT
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'unauthorized' }, 401);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return json({ error: 'unauthorized' }, 401);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }
  const checked = validateSummary(body);
  if (!checked.ok) return json({ error: checked.error }, 400);

  // Per-user daily quota (also protects the provider's free tier)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await supabase
    .from('ai_advice_usage')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since);
  if (countError) return json({ error: 'usage_unavailable' }, 503);
  const used = count ?? 0;
  if (used >= DAILY_LIMIT) return json({ error: 'daily_limit', limit: DAILY_LIMIT }, 429);

  const { system, user } = buildPrompt(checked.value);
  let aiResponse: Response;
  try {
    aiResponse = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: 0.4,
        max_tokens: 600,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    console.error('AI request failed', e instanceof Error ? e.name : 'error');
    return json({ error: 'ai_unavailable' }, 502);
  }

  if (!aiResponse.ok) {
    console.error('AI provider returned', aiResponse.status); // status only: never log request content
    return json({ error: aiResponse.status === 429 ? 'ai_busy' : 'ai_unavailable' }, 502);
  }

  const advice = extractAdvice(await aiResponse.json().catch(() => null));
  if (!advice) return json({ error: 'ai_unavailable' }, 502);

  // Count only successful answers; we store no content, just the timestamp
  await supabase.from('ai_advice_usage').insert({});

  return json({ advice, remaining: Math.max(0, DAILY_LIMIT - used - 1) });
});
