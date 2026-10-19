// Supabase Edge Function: ai-advice-cron
//
// Run once a month by a scheduler (GitHub Actions workflow or pg_cron, see README). For every user who
// opted in and has a shared summary, it asks a free OpenAI-compatible LLM API for recommendations and saves the
// text in `ai_advice_cache` (one row per user per month).
//
// Models: it tries the primary model and, if that fails (timeout, rate limit, model removed, server error...),
// the backup model. Both are editable by the app owner in the admin dashboard (table `ai_model_settings`);
// environment variables only provide defaults. Every call is recorded as a technical metric
// (model, status, latency, token counts) in `ai_advice_calls`, and every run in `ai_advice_runs`.
//
// Privacy: it reads ONLY `ai_advice_settings` (opt-in flag + the anonymous summary the user chose to share),
// `ai_advice_cache` and the model settings. It never reads transactions, rental or savings records. The summary is
// re-validated and rebuilt before anything is sent to the provider. Metrics contain no prompts, advice text or user ids.
//
// Deploy WITHOUT Supabase JWT verification (the caller is a scheduler, not a user):
//   supabase functions deploy ai-advice-cron --no-verify-jwt
//
// Secrets / env (set with `supabase secrets set`):
//   CRON_SECRET             required  shared secret the scheduler sends as `Authorization: Bearer <secret>`
//   AI_API_KEY              required  key for the provider below
//   AI_BASE_URL             optional  OpenAI-compatible base URL (default: Groq). Not editable from the app on purpose.
//   AI_MODEL                optional  default primary model (the admin dashboard value wins)
//   AI_FALLBACK_MODEL       optional  default backup model (the admin dashboard value wins)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by Supabase.

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  applyLabelPolicy,
  buildPrompt,
  currentPeriod,
  isAuthorizedCron,
  type OptedInUser,
  pickUsers,
  validateSummary,
} from '../_shared/advice.ts';
import { allRateLimited, callChatModel, resolveModelSettings, runWithFallback, toMetricRow } from '../_shared/ai-client.ts';

const AI_BASE_URL = (Deno.env.get('AI_BASE_URL') ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const RETENTION_DAYS = 180;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
  const startedAt = Date.now();
  const period = currentPeriod();

  // Effective model settings: admin-edited row over env defaults over built-ins (missing table => defaults)
  const { data: settingsRow } = await admin.from('ai_model_settings').select('*').eq('id', true).maybeSingle();
  const settings = resolveModelSettings(settingsRow, {
    AI_MODEL: Deno.env.get('AI_MODEL'),
    AI_FALLBACK_MODEL: Deno.env.get('AI_FALLBACK_MODEL'),
  });

  // Run record (best effort: monitoring must never break the job itself)
  const { data: runRow } = await admin.from('ai_advice_runs').insert({ period }).select('id').maybeSingle();
  const runId: number | null = runRow?.id ?? null;
  const finishRun = async (patch: Record<string, unknown>) => {
    if (runId === null) return;
    await admin.from('ai_advice_runs').update({
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      ...patch,
    }).eq('id', runId);
  };

  if (!settings.enabled) {
    await finishRun({ status: 'disabled' });
    return json({ period, disabled: true });
  }

  const { data: optedIn, error: optedInError } = await admin
    .from('ai_advice_settings')
    .select('user_id, include_labels, summary')
    .eq('enabled', true)
    .not('summary', 'is', null);
  if (optedInError) {
    await finishRun({ status: 'failed' });
    return json({ error: 'settings_unavailable' }, 503);
  }

  const { data: done, error: doneError } = await admin.from('ai_advice_cache').select('user_id').eq('period', period);
  if (doneError) {
    await finishRun({ status: 'failed' });
    return json({ error: 'cache_unavailable' }, 503);
  }

  const doneSet = new Set((done ?? []).map((row: { user_id: string }) => row.user_id));
  const waiting = pickUsers((optedIn ?? []) as OptedInUser[], doneSet, Number.MAX_SAFE_INTEGER);
  const batch = waiting.slice(0, settings.max_users_per_run);

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
    const result = await runWithFallback(
      (model, role) => callChatModel({
        baseUrl: AI_BASE_URL,
        apiKey,
        model,
        role,
        system,
        user: prompt,
        temperature: settings.temperature,
        maxTokens: settings.max_tokens,
        timeoutMs: settings.timeout_seconds * 1000,
      }),
      settings.primary_model,
      settings.fallback_model,
    );

    // Metrics: one row per attempt, without any content
    await admin.from('ai_advice_calls').insert(
      result.attempts.map((a) => ({ run_id: runId, kind: 'advice', ...toMetricRow(a) })),
    );
    for (const a of result.attempts) {
      if (!a.ok) console.error('AI call failed', a.role, a.error_kind, a.http_status); // never content
    }

    if (!result.advice) {
      failed++;
      if (allRateLimited(result.attempts)) {
        stoppedEarly = true; // both models throttled: stop and let the next run continue
        break;
      }
      continue;
    }

    const { error: saveError } = await admin
      .from('ai_advice_cache')
      .upsert({ user_id: user.user_id, period, advice: result.advice, model: result.usedModel }, { onConflict: 'user_id,period' });
    if (saveError) failed++;
    else processed++;

    if (settings.delay_ms > 0) await sleep(settings.delay_ms);
  }

  const remaining = Math.max(0, waiting.length - processed - invalid);
  const status = failed === 0 ? 'ok' : processed > 0 ? 'partial' : 'failed';
  await finishRun({ status, processed, skipped_invalid: invalid, failed, remaining, stopped_early: stoppedEarly });

  // Keep the metric tables small
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  await admin.from('ai_advice_calls').delete().lt('created_at', cutoff);
  await admin.from('ai_advice_runs').delete().lt('started_at', cutoff);

  // Counts only: no user ids, no content
  return json({
    period,
    processed,
    skipped_invalid: invalid,
    failed,
    remaining,
    stopped_early: stoppedEarly,
    models: { primary: settings.primary_model, fallback: settings.fallback_model },
  });
});
