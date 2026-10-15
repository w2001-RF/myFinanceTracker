// Supabase Edge Function: ai-advice-cron
//
// Run once a month by a scheduler (GitHub Actions workflow or pg_cron, see README). For every user who
// opted in and has a shared summary, it asks a free OpenAI-compatible LLM API for recommendations and saves the
// text in `ai_advice_cache` (one row per user per month).
//
// Privacy: it reads ONLY `ai_advice_settings` (opt-in flag + the anonymous summary the user chose to share) and
// `ai_advice_cache`. It never reads transactions, rental or savings records. The summary is re-validated and
// rebuilt here before anything is sent to the provider, and nothing is logged except counts.
//
// Deploy WITHOUT Supabase JWT verification (the caller is a scheduler, not a user):
//   supabase functions deploy ai-advice-cron --no-verify-jwt
//
// Secrets / env (set with `supabase secrets set`):
//   CRON_SECRET             required  shared secret the scheduler sends as `Authorization: Bearer <secret>`
//   AI_API_KEY              required  key for the provider below
//   AI_BASE_URL             optional  OpenAI-compatible base URL (default: Groq)
//   AI_MODEL                optional  model id (default below; check your provider's current free models)
//   AI_CRON_MAX_USERS       optional  users handled per run (default 20; keeps within the time limit, reruns continue)
//   AI_CRON_DELAY_MS        optional  pause between users to respect free-tier rate limits (default 2500)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by Supabase.

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  applyLabelPolicy,
  buildPrompt,
  currentPeriod,
  extractAdvice,
  isAuthorizedCron,
  type OptedInUser,
  parseLimit,
  pickUsers,
  validateSummary,
} from '../_shared/advice.ts';

const AI_BASE_URL = (Deno.env.get('AI_BASE_URL') ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const AI_MODEL = Deno.env.get('AI_MODEL') ?? 'llama-3.3-70b-versatile';
const MAX_USERS = parseLimit(Deno.env.get('AI_CRON_MAX_USERS'), 20);
const DELAY_MS = Math.min(30_000, Number.parseInt(Deno.env.get('AI_CRON_DELAY_MS') ?? '2500', 10) || 0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type AiResult = { ok: true; advice: string } | { ok: false; busy: boolean };

async function askAi(apiKey: string, system: string, user: string): Promise<AiResult> {
  try {
    const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
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
    if (!response.ok) {
      console.error('AI provider returned', response.status); // status only, never content
      return { ok: false, busy: response.status === 429 };
    }
    const advice = extractAdvice(await response.json().catch(() => null));
    return advice ? { ok: true, advice } : { ok: false, busy: false };
  } catch (e) {
    console.error('AI request failed', e instanceof Error ? e.name : 'error');
    return { ok: false, busy: false };
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const cronSecret = Deno.env.get('CRON_SECRET');
  const apiKey = Deno.env.get('AI_API_KEY');
  if (!cronSecret || !apiKey) return json({ error: 'not_configured' }, 503);
  if (!isAuthorizedCron(req.headers.get('Authorization'), cronSecret)) return json({ error: 'unauthorized' }, 401);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const period = currentPeriod();

  const { data: optedIn, error: optedInError } = await admin
    .from('ai_advice_settings')
    .select('user_id, include_labels, summary')
    .eq('enabled', true)
    .not('summary', 'is', null);
  if (optedInError) return json({ error: 'settings_unavailable' }, 503);

  const { data: done, error: doneError } = await admin.from('ai_advice_cache').select('user_id').eq('period', period);
  if (doneError) return json({ error: 'cache_unavailable' }, 503);

  const doneSet = new Set((done ?? []).map((row: { user_id: string }) => row.user_id));
  const waiting = pickUsers((optedIn ?? []) as OptedInUser[], doneSet, Number.MAX_SAFE_INTEGER);
  const batch = waiting.slice(0, MAX_USERS);

  let processed = 0;
  let invalid = 0;
  let failed = 0;
  let stoppedEarly = false;

  for (const user of batch) {
    const checked = validateSummary(user.summary);
    if (!checked.ok) {
      invalid++;
      continue;
    }

    const { system, user: prompt } = buildPrompt(applyLabelPolicy(checked.value, user.include_labels));
    const result = await askAi(apiKey, system, prompt);

    if (!result.ok) {
      failed++;
      if (result.busy) {
        stoppedEarly = true; // provider rate limit: stop and let the next run continue
        break;
      }
      continue;
    }

    const { error: saveError } = await admin
      .from('ai_advice_cache')
      .upsert({ user_id: user.user_id, period, advice: result.advice, model: AI_MODEL }, { onConflict: 'user_id,period' });
    if (saveError) failed++;
    else processed++;

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  // Counts only: no user ids, no content
  return json({
    period,
    processed,
    skipped_invalid: invalid,
    failed,
    remaining: Math.max(0, waiting.length - processed - invalid),
    stopped_early: stoppedEarly,
  });
});
