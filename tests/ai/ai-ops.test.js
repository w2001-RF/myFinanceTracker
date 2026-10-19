import { describe, it, expect } from 'vitest';
import { createMockSupabase, loadApp } from '../helpers.js';

const METRICS = {
  days: 30,
  totals: { calls: 12, ok_calls: 10, fallback_calls: 3, prompt_tokens: 4800, completion_tokens: 2400, total_tokens: 7200, avg_latency_ms: 850 },
  by_model: [
    { model: 'llama-3.3-70b-versatile', calls: 9, ok_calls: 6, error_calls: 3, fallback_calls: 0, avg_latency_ms: 900, p95_latency_ms: 1500, prompt_tokens: 3600, completion_tokens: 1800, total_tokens: 5400 },
    { model: 'llama-3.1-8b-instant', calls: 3, ok_calls: 3, error_calls: 0, fallback_calls: 3, avg_latency_ms: 300, p95_latency_ms: 400, prompt_tokens: 1200, completion_tokens: 600, total_tokens: 1800 },
  ],
  daily: [{ day: '2026-10-02', calls: 12, ok_calls: 10, total_tokens: 7200 }],
  recent_errors: [
    { created_at: '2026-10-02T06:00:00Z', kind: 'advice', model: 'llama-3.3-70b-versatile', role: 'primary', http_status: 429, error_kind: 'rate_limited', latency_ms: 120 },
    { created_at: '2026-10-02T06:01:00Z', kind: 'health', model: '<img src=x>', role: 'primary', http_status: null, error_kind: 'timeout', latency_ms: 20000 },
  ],
  last_run: { started_at: '2026-10-02T06:00:00Z', finished_at: '2026-10-02T06:01:00Z', period: '2026-10', status: 'partial', processed: 9, skipped_invalid: 0, failed: 3, remaining: 4, stopped_early: true, duration_ms: 61500 },
  last_health: [],
};

const SETTINGS_ROW = {
  id: true, enabled: true, primary_model: 'llama-3.3-70b-versatile', fallback_model: 'llama-3.1-8b-instant',
  temperature: '0.4', max_tokens: 600, timeout_seconds: 20, max_users_per_run: 20, delay_ms: 2500,
};

const adminSupabase = (extra = {}) => createMockSupabase({
  tables: { app_settings: [{ id: true, maintenance_mode: false, announcement: '', signups_enabled: true, default_loan_amount: '70000', default_savings_target: '26000' }], ai_model_settings: [SETTINGS_ROW] },
  rpc: {
    is_admin: { data: true, error: null },
    admin_overview: { data: { total_accounts: 3, new_accounts_30d: 1 }, error: null },
    ai_advice_metrics: { data: METRICS, error: null },
  },
  ...extra,
});

async function adminApp(opts) {
  const app = await loadApp({ supabase: adminSupabase(opts) });
  await app.login();
  await app.window.refreshAdminConsole();
  return app;
}

describe('admin dashboard: AI models', () => {
  it('shows health, performance and token totals', async () => {
    const app = await adminApp();
    expect(app.text('aiSuccessRate')).toBe('83%');
    expect(app.text('aiCalls')).toBe('12');
    expect(app.text('aiFallbackCalls')).toBe('3');
    expect(app.text('aiAvgLatency')).toBe('850 ms');
    expect(app.text('aiTokensIn')).toBe('4,800');
    expect(app.text('aiTokensOut')).toBe('2,400');
    expect(app.document.getElementById('aiOps').hidden).toBe(false);
    expect(app.document.getElementById('aiOpsUnavailable').hidden).toBe(true);
  });

  it('lists per-model calls, success, backup usage, latency percentiles and tokens', async () => {
    const app = await adminApp();
    const rows = app.document.querySelectorAll('#aiModelTable tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('llama-3.3-70b-versatile');
    expect(rows[0].textContent).toContain('67%');
    expect(rows[0].textContent).toContain('1,500');
    expect(rows[1].textContent).toContain('100%');
    expect(rows[1].textContent).toContain('3,600'.replace('3,600', '1,200'));
  });

  it('summarises the last monthly run, including an early stop', async () => {
    const app = await adminApp();
    const text = app.text('aiLastRun');
    expect(text).toContain('partial');
    expect(text).toContain('9 generated');
    expect(text).toContain('3 failed');
    expect(text).toContain('stopped early');
    expect(text).toContain('61.5 s');
  });

  it('shows daily usage and recent errors with readable labels, as escaped text', async () => {
    const app = await adminApp();
    expect(app.text('aiDailyTable')).toContain('2026-10-02');
    expect(app.text('aiDailyTable')).toContain('7,200');
    const errors = app.text('aiErrorTable');
    expect(errors).toContain('Rate limited');
    expect(errors).toContain('Timed out');
    expect(errors).toContain('(test)');
    expect(app.document.querySelector('#aiErrorTable img')).toBeNull();
    expect(errors).toContain('<img src=x>');
  });

  it('shows friendly empty states before anything has run', async () => {
    const app = await adminApp({ rpc: { is_admin: { data: true, error: null }, admin_overview: { data: { total_accounts: 1, new_accounts_30d: 0 }, error: null }, ai_advice_metrics: { data: { totals: {}, by_model: [], daily: [], recent_errors: [], last_run: null }, error: null } } });
    expect(app.text('aiSuccessRate')).toBe('—');
    expect(app.text('aiLastRun')).toContain('No monthly run recorded yet');
    expect(app.text('aiModelTable')).toContain('No model calls recorded yet');
    expect(app.text('aiErrorTable')).toContain('No errors recorded');
  });

  it('hides the section with a hint when the migration has not been applied', async () => {
    const app = await adminApp({ rpc: { is_admin: { data: true, error: null }, ai_advice_metrics: { data: null, error: { message: 'function does not exist' } } } });
    expect(app.document.getElementById('aiOps').hidden).toBe(true);
    expect(app.document.getElementById('aiOpsUnavailable').hidden).toBe(false);
  });

  it('reads only the admin-only model settings table (no user content)', async () => {
    const app = await adminApp();
    expect(app.supabase.ops('ai_model_settings', 'select')).toHaveLength(1);
    expect(app.supabase.ops('ai_advice_settings', 'select').length).toBeLessThanOrEqual(1); // the user's own opt-in row from normal app loading
    expect(app.supabase.calls.filter((c) => c.table === 'ai_advice_cache' && c.op === 'select')).toHaveLength(0);
  });
});

describe('admin dashboard: model settings', () => {
  it('fills the form from the stored settings', async () => {
    const app = await adminApp();
    expect(app.document.getElementById('aiPrimaryModel').value).toBe('llama-3.3-70b-versatile');
    expect(app.document.getElementById('aiFallbackModel').value).toBe('llama-3.1-8b-instant');
    expect(app.document.getElementById('aiTemperature').value).toBe('0.4');
    expect(app.document.getElementById('aiEnabled').checked).toBe(true);
  });

  it('saves changed settings with a single update of the settings row', async () => {
    const app = await adminApp();
    app.setValue('aiPrimaryModel', ' openai/gpt-oss-20b ');
    app.setValue('aiFallbackModel', 'llama-3.1-8b-instant');
    app.setValue('aiTemperature', '0.7');
    app.setValue('aiMaxTokens', '800');
    app.setValue('aiTimeout', '30');
    app.setValue('aiMaxUsers', '50');
    app.setValue('aiDelay', '1000');
    app.document.getElementById('aiEnabled').checked = false;
    await app.window.saveAiModelSettings();
    const [up] = app.supabase.ops('ai_model_settings', 'update');
    expect(up.payload).toEqual({
      enabled: false, primary_model: 'openai/gpt-oss-20b', fallback_model: 'llama-3.1-8b-instant',
      temperature: 0.7, max_tokens: 800, timeout_seconds: 30, max_users_per_run: 50, delay_ms: 1000,
    });
    expect(up.filters).toEqual({ id: true });
  });

  it.each([
    ['aiPrimaryModel', 'bad model!'],
    ['aiFallbackModel', ''],
    ['aiPrimaryModel', '<script>'],
    ['aiTemperature', '2'],
    ['aiMaxTokens', '50'],
    ['aiMaxTokens', '5000'],
    ['aiTimeout', '1'],
    ['aiMaxUsers', '0'],
    ['aiDelay', '-1'],
    ['aiDelay', ''],
  ])('rejects %s = %j without saving', async (id, value) => {
    const app = await adminApp();
    app.setValue(id, value);
    await app.window.saveAiModelSettings();
    expect(app.supabase.ops('ai_model_settings', 'update')).toHaveLength(0);
    expect(app.window.alert).toHaveBeenCalled();
  });

  it('warns when the backup is the same as the primary and respects "cancel"', async () => {
    const supabase = adminSupabase();
    const app = await loadApp({ supabase, confirmResult: false });
    await app.login();
    await app.window.refreshAdminConsole();
    app.setValue('aiFallbackModel', 'llama-3.3-70b-versatile');
    await app.window.saveAiModelSettings();
    expect(app.window.confirm).toHaveBeenCalledWith(expect.stringContaining('no real backup'));
    expect(supabase.ops('ai_model_settings', 'update')).toHaveLength(0);
  });

  it('reports database errors', async () => {
    const app = await adminApp({ overrides: { 'ai_model_settings:update': { data: null, error: { message: 'RLS' } } } });
    await app.window.saveAiModelSettings();
    expect(app.window.alert).toHaveBeenCalledWith(expect.stringContaining('RLS'));
  });

  it('does nothing for non-admins', async () => {
    const app = await loadApp({ supabase: createMockSupabase({ tables: { ai_model_settings: [SETTINGS_ROW] } }) });
    await app.login();
    await app.window.saveAiModelSettings();
    await app.window.runAiHealthCheck();
    expect(app.supabase.ops('ai_model_settings', 'update')).toHaveLength(0);
    expect(app.supabase.client.functions.invoke).not.toHaveBeenCalledWith('ai-advice-health');
  });
});

describe('admin dashboard: health test', () => {
  const healthResult = {
    config: { provider_host: 'api.groq.com', api_key_configured: true, cron_secret_configured: false, primary_model: 'a', fallback_model: 'b', enabled: true },
    results: [
      { model: 'llama-3.3-70b-versatile', role: 'primary', ok: true, http_status: 200, error_kind: null, latency_ms: 420, prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      { model: 'llama-3.1-8b-instant', role: 'fallback', ok: false, http_status: 404, error_kind: 'model_unavailable', latency_ms: 90, prompt_tokens: null, completion_tokens: null, total_tokens: null },
    ],
  };

  it('runs the test and shows status, latency, tokens and configuration for each model', async () => {
    const app = await adminApp({ functions: { 'ai-advice-health': { data: healthResult, error: null } } });
    await app.window.runAiHealthCheck();
    expect(app.supabase.client.functions.invoke).toHaveBeenCalledWith('ai-advice-health');
    expect(app.document.getElementById('aiHealthResult').hidden).toBe(false);
    const text = app.text('aiHealthTable');
    expect(text).toContain('OK');
    expect(text).toContain('420 ms');
    expect(text).toContain('20 / 2');
    expect(text).toContain('Model not found');
    expect(text).toContain('HTTP 404');
    const config = app.text('aiHealthConfig');
    expect(config).toContain('api.groq.com');
    expect(config).toContain('API key: set');
    expect(config).toContain('cron secret: MISSING');
  });

  it.each([
    [403, 'Only the app owner'],
    [404, 'not deployed'],
    [429, 'wait a few seconds'],
    [503, 'not configured'],
    [401, 'log in again'],
    [500, 'health test failed'],
  ])('explains HTTP %i', async (status, expected) => {
    const app = await adminApp({ functions: { 'ai-advice-health': { data: null, error: { message: 'x', context: { status } } } } });
    await app.window.runAiHealthCheck();
    expect(app.window.alert).toHaveBeenCalledWith(expect.stringContaining(expected));
  });
});
