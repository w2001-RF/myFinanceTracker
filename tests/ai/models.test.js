import { describe, it, expect, vi } from 'vitest';
import {
  allRateLimited,
  callChatModel,
  classifyHttpError,
  DEFAULT_MODEL_SETTINGS,
  parseUsage,
  resolveModelSettings,
  runWithFallback,
  shouldTryFallback,
  toMetricRow,
} from '../../supabase/functions/_shared/ai-client.ts';

const okBody = (content = 'Advice text', usage = { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 }) =>
  ({ choices: [{ message: { content } }], usage });

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});

const call = (fetchImpl, extra = {}) => callChatModel({
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'secret-key',
  model: 'model-a',
  role: 'primary',
  system: 'sys',
  user: 'usr',
  temperature: 0.4,
  maxTokens: 600,
  timeoutMs: 5000,
  fetchImpl,
  ...extra,
});

describe('callChatModel', () => {
  it('returns advice, status, latency and token usage on success', async () => {
    let t = 1000;
    const fetchImpl = vi.fn(async () => response(200, okBody()));
    const attempt = await call(fetchImpl, { now: () => (t += 250) });
    expect(attempt).toMatchObject({
      ok: true, model: 'model-a', role: 'primary', http_status: 200, error_kind: null,
      prompt_tokens: 120, completion_tokens: 80, total_tokens: 200, advice: 'Advice text',
    });
    expect(attempt.latency_ms).toBe(250);
  });

  it('posts to the chat completions endpoint with the key, model and limits', async () => {
    const fetchImpl = vi.fn(async () => response(200, okBody()));
    await call(fetchImpl, { temperature: 0.2, maxTokens: 300 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer secret-key');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'model-a', temperature: 0.2, max_tokens: 300 });
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it.each([
    [429, 'rate_limited'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'model_unavailable'],
    [400, 'bad_request'],
    [500, 'server_error'],
    [503, 'server_error'],
  ])('classifies HTTP %i as %s', async (status, kind) => {
    const attempt = await call(async () => response(status, {}));
    expect(attempt).toMatchObject({ ok: false, http_status: status, error_kind: kind });
    expect(attempt.advice).toBeUndefined();
    expect(classifyHttpError(status)).toBe(kind);
  });

  it('reports a timeout', async () => {
    const attempt = await call(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
    expect(attempt).toMatchObject({ ok: false, error_kind: 'timeout', http_status: null });
  });

  it('reports an abort as a timeout and anything else as a network error', async () => {
    expect((await call(async () => { throw Object.assign(new Error('a'), { name: 'AbortError' }); })).error_kind).toBe('timeout');
    expect((await call(async () => { throw new TypeError('fetch failed'); })).error_kind).toBe('network');
  });

  it('reports invalid JSON and empty answers as bad_response (keeping token counts when present)', async () => {
    expect((await call(async () => response(200, new Error('bad json')))).error_kind).toBe('bad_response');
    const empty = await call(async () => response(200, okBody('   ')));
    expect(empty).toMatchObject({ ok: false, error_kind: 'bad_response', total_tokens: 200 });
  });

  it('never throws and never leaks the api key into the result', async () => {
    const attempt = await call(async () => { throw new Error('boom secret-key'); });
    expect(JSON.stringify(attempt)).not.toContain('secret-key');
  });
});

describe('parseUsage', () => {
  it('reads OpenAI-style usage', () => {
    expect(parseUsage(okBody())).toEqual({ prompt: 120, completion: 80, total: 200 });
  });

  it('derives the total when the provider omits it', () => {
    expect(parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({ prompt: 10, completion: 5, total: 15 });
  });

  it.each([[null], [{}], [{ usage: null }], [{ usage: { prompt_tokens: 'x', completion_tokens: -1 } }]])('returns nulls for %j', (input) => {
    expect(parseUsage(input)).toEqual({ prompt: null, completion: null, total: null });
  });
});

describe('runWithFallback', () => {
  const attempt = (model, role, ok, kind = null) => ({
    model, role, ok, http_status: ok ? 200 : 500, error_kind: ok ? null : kind, latency_ms: 10,
    prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, ...(ok ? { advice: `from ${model}` } : {}),
  });

  it('uses the primary model when it works and does not call the backup', async () => {
    const doCall = vi.fn(async (model, role) => attempt(model, role, true));
    const result = await runWithFallback(doCall, 'main', 'backup');
    expect(result).toMatchObject({ advice: 'from main', usedModel: 'main' });
    expect(doCall).toHaveBeenCalledTimes(1);
    expect(result.attempts).toHaveLength(1);
  });

  it.each(['timeout', 'network', 'rate_limited', 'model_unavailable', 'server_error', 'bad_request', 'bad_response'])(
    'falls back to the backup model after a primary failure (%s)',
    async (kind) => {
      const doCall = vi.fn(async (model, role) => attempt(model, role, role === 'fallback', kind));
      const result = await runWithFallback(doCall, 'main', 'backup');
      expect(result).toMatchObject({ advice: 'from backup', usedModel: 'backup' });
      expect(result.attempts.map((a) => [a.role, a.ok])).toEqual([['primary', false], ['fallback', true]]);
    },
  );

  it('does not try the backup when the API key is rejected (it would fail too)', async () => {
    const doCall = vi.fn(async (model, role) => attempt(model, role, false, 'auth'));
    const result = await runWithFallback(doCall, 'main', 'backup');
    expect(doCall).toHaveBeenCalledTimes(1);
    expect(result.advice).toBeNull();
  });

  it('gives up cleanly when both models fail', async () => {
    const doCall = vi.fn(async (model, role) => attempt(model, role, false, 'server_error'));
    const result = await runWithFallback(doCall, 'main', 'backup');
    expect(result).toMatchObject({ advice: null, usedModel: null });
    expect(result.attempts).toHaveLength(2);
  });

  it.each([[null], [undefined], [''], ['main']])('has no backup attempt when the backup is %j', async (backup) => {
    const doCall = vi.fn(async (model, role) => attempt(model, role, false, 'timeout'));
    const result = await runWithFallback(doCall, 'main', backup);
    expect(doCall).toHaveBeenCalledTimes(1);
    expect(result.advice).toBeNull();
  });

  it('detects when both models were rate limited (the run should stop)', () => {
    expect(allRateLimited([attempt('a', 'primary', false, 'rate_limited'), attempt('b', 'fallback', false, 'rate_limited')])).toBe(true);
    expect(allRateLimited([attempt('a', 'primary', false, 'rate_limited'), attempt('b', 'fallback', false, 'timeout')])).toBe(false);
    expect(allRateLimited([])).toBe(false);
  });

  it('decides on fallback only for non-auth failures', () => {
    expect(shouldTryFallback('auth')).toBe(false);
    expect(shouldTryFallback(null)).toBe(false);
    expect(shouldTryFallback('timeout')).toBe(true);
  });

  it('strips the advice text from metric rows', () => {
    const row = toMetricRow(attempt('main', 'primary', true));
    expect(row).not.toHaveProperty('advice');
    expect(JSON.stringify(row)).not.toContain('from main');
    expect(row).toMatchObject({ model: 'main', role: 'primary', ok: true, total_tokens: 2 });
  });
});

describe('resolveModelSettings', () => {
  it('falls back to the built-in defaults', () => {
    expect(resolveModelSettings(null)).toEqual(DEFAULT_MODEL_SETTINGS);
    expect(resolveModelSettings(undefined, {})).toEqual(DEFAULT_MODEL_SETTINGS);
  });

  it('uses environment models when no admin row exists', () => {
    const s = resolveModelSettings(null, { AI_MODEL: 'env-main', AI_FALLBACK_MODEL: 'env-backup' });
    expect(s).toMatchObject({ primary_model: 'env-main', fallback_model: 'env-backup' });
  });

  it('lets the admin row win over the environment', () => {
    const s = resolveModelSettings({ primary_model: 'db-main', fallback_model: 'db-backup', temperature: 0.9, enabled: false }, { AI_MODEL: 'env-main' });
    expect(s).toMatchObject({ primary_model: 'db-main', fallback_model: 'db-backup', temperature: 0.9, enabled: false });
  });

  it('clamps out-of-range numbers and rounds integers', () => {
    const s = resolveModelSettings({ temperature: 9, max_tokens: 5, timeout_seconds: 999, max_users_per_run: 0, delay_ms: -5 });
    expect(s).toMatchObject({ temperature: 1.5, max_tokens: 100, timeout_seconds: 60, max_users_per_run: 1, delay_ms: 0 });
    expect(resolveModelSettings({ max_tokens: '750.4' }).max_tokens).toBe(750);
  });

  it.each([['bad model name!'], ['has space'], ['x'.repeat(81)], ['<script>'], ['']])('rejects model id %j and keeps the default', (name) => {
    expect(resolveModelSettings({ primary_model: name, fallback_model: name }).primary_model).toBe(DEFAULT_MODEL_SETTINGS.primary_model);
    expect(resolveModelSettings({ primary_model: name, fallback_model: name }).fallback_model).toBe(DEFAULT_MODEL_SETTINGS.fallback_model);
  });

  it('accepts typical provider model ids', () => {
    for (const id of ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'meta-llama/llama-4-scout:free', 'gemini-2.5-flash']) {
      expect(resolveModelSettings({ primary_model: id }).primary_model).toBe(id);
    }
  });
});
