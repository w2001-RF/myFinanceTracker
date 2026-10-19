// Shared AI client for the Edge Functions: one chat-completion call with timing, token usage and
// error classification, plus the primary -> backup model orchestration.
// No Deno-specific APIs, so everything here is unit-testable with Vitest (fetch is injectable).

import { extractAdvice } from './advice.ts';

export type Role = 'primary' | 'fallback';
export type ErrorKind =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'auth'
  | 'model_unavailable'
  | 'server_error'
  | 'bad_request'
  | 'bad_response';

/** What we record about every call. Never contains prompts, summaries, advice text or user ids. */
export interface Attempt {
  model: string;
  role: Role;
  ok: boolean;
  http_status: number | null;
  error_kind: ErrorKind | null;
  latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  advice?: string;
}

export interface ModelSettings {
  enabled: boolean;
  primary_model: string;
  fallback_model: string;
  temperature: number;
  max_tokens: number;
  timeout_seconds: number;
  max_users_per_run: number;
  delay_ms: number;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  enabled: true,
  primary_model: 'llama-3.3-70b-versatile',
  fallback_model: 'llama-3.1-8b-instant',
  temperature: 0.4,
  max_tokens: 600,
  timeout_seconds: 20,
  max_users_per_run: 20,
  delay_ms: 2500,
};

/** Model ids are sent to the provider, so keep them to a conservative character set. */
export const MODEL_NAME_RE = /^[A-Za-z0-9._:/-]{1,80}$/;

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const modelName = (value: unknown, fallback: string): string =>
  typeof value === 'string' && MODEL_NAME_RE.test(value.trim()) ? value.trim() : fallback;

/**
 * Effective settings = admin-edited row (if any) over environment defaults over built-ins.
 * Values are clamped to the same ranges the database enforces.
 */
export function resolveModelSettings(
  row: Partial<Record<keyof ModelSettings, unknown>> | null | undefined,
  env: { AI_MODEL?: string | null; AI_FALLBACK_MODEL?: string | null } = {},
): ModelSettings {
  const d = DEFAULT_MODEL_SETTINGS;
  const base = {
    primary: modelName(env.AI_MODEL, d.primary_model),
    fallback: modelName(env.AI_FALLBACK_MODEL, d.fallback_model),
  };
  const r = row ?? {};
  return {
    enabled: r.enabled === undefined || r.enabled === null ? d.enabled : r.enabled === true,
    primary_model: modelName(r.primary_model, base.primary),
    fallback_model: modelName(r.fallback_model, base.fallback),
    temperature: clamp(r.temperature, 0, 1.5, d.temperature),
    max_tokens: Math.round(clamp(r.max_tokens, 100, 2000, d.max_tokens)),
    timeout_seconds: Math.round(clamp(r.timeout_seconds, 5, 60, d.timeout_seconds)),
    max_users_per_run: Math.round(clamp(r.max_users_per_run, 1, 100, d.max_users_per_run)),
    delay_ms: Math.round(clamp(r.delay_ms, 0, 30000, d.delay_ms)),
  };
}

export function classifyHttpError(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'model_unavailable';
  if (status >= 500) return 'server_error';
  return 'bad_request'; // includes 400, e.g. a decommissioned model id
}

/** Auth problems affect every model (same key), so the backup would fail too. Everything else may be model-specific. */
export function shouldTryFallback(kind: ErrorKind | null): boolean {
  return kind !== null && kind !== 'auth';
}

const intOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

/** Token usage from an OpenAI-compatible response (`usage.prompt_tokens` etc.). */
export function parseUsage(payload: unknown): { prompt: number | null; completion: number | null; total: number | null } {
  const usage = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).usage : null;
  const u = typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : {};
  const prompt = intOrNull(u.prompt_tokens);
  const completion = intOrNull(u.completion_tokens);
  const total = intOrNull(u.total_tokens) ?? (prompt !== null && completion !== null ? prompt + completion : null);
  return { prompt, completion, total };
}

export interface CallOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  role: Role;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** One chat-completion request. Never throws: failures come back as an Attempt with an error_kind. */
export async function callChatModel(opts: CallOptions): Promise<Attempt> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const started = now();
  const base: Attempt = {
    model: opts.model,
    role: opts.role,
    ok: false,
    http_status: null,
    error_kind: null,
    latency_ms: 0,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
  };
  const finish = (patch: Partial<Attempt>): Attempt => ({ ...base, ...patch, latency_ms: Math.max(0, now() - started) });

  let response: Response;
  try {
    response = await fetchImpl(`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    return finish({ error_kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' });
  }

  if (!response.ok) {
    return finish({ http_status: response.status, error_kind: classifyHttpError(response.status) });
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    return finish({ http_status: response.status, error_kind: 'bad_response' });
  }

  const usage = parseUsage(payload);
  const advice = extractAdvice(payload);
  const tokens = { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.total };
  if (!advice) return finish({ http_status: response.status, error_kind: 'bad_response', ...tokens });
  return finish({ ok: true, http_status: response.status, advice, ...tokens });
}

export interface FallbackResult {
  advice: string | null;
  usedModel: string | null;
  attempts: Attempt[];
}

/** Try the primary model; if it fails (and the failure is not an auth problem) try the backup model once. */
export async function runWithFallback(
  doCall: (model: string, role: Role) => Promise<Attempt>,
  primary: string,
  fallback: string | null | undefined,
): Promise<FallbackResult> {
  const attempts: Attempt[] = [];

  const first = await doCall(primary, 'primary');
  attempts.push(first);
  if (first.ok && first.advice) return { advice: first.advice, usedModel: first.model, attempts };

  if (fallback && fallback !== primary && shouldTryFallback(first.error_kind)) {
    const second = await doCall(fallback, 'fallback');
    attempts.push(second);
    if (second.ok && second.advice) return { advice: second.advice, usedModel: second.model, attempts };
  }

  return { advice: null, usedModel: null, attempts };
}

/** Both models were throttled: continuing would only burn more requests, so a run should stop and resume later. */
export function allRateLimited(attempts: Attempt[]): boolean {
  return attempts.length > 0 && attempts.every((a) => a.error_kind === 'rate_limited');
}

/** The attempt without the advice text, safe to store as a metric row. */
export function toMetricRow(a: Attempt): Omit<Attempt, 'advice'> {
  const { advice: _advice, ...row } = a;
  return row;
}
