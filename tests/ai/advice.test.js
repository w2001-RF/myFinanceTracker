import { describe, it, expect } from 'vitest';
import { createMockSupabase, loadApp, USER } from '../helpers.js';
import {
  applyLabelPolicy,
  buildPrompt,
  currentPeriod,
  extractAdvice,
  isAuthorizedCron,
  parseLimit,
  pickUsers,
  sanitizeLabel,
  timingSafeEqual,
  validateSummary,
} from '../../supabase/functions/_shared/advice.ts';

const tx = (month, type, amount, description = 'x') => ({ id: `${month}${type}${amount}${description}`, month, type, amount: String(amount), description });
const NOW = new Date(2026, 9, 15); // 15 Oct 2026

function insights(window, overrides = {}) {
  return window.computeInsights({
    transactions: [], rental: [], savings: [], loan: 70000, target: 26000, milestones: [], now: NOW, ...overrides,
  });
}
const titles = (list) => list.map((i) => i.title);
const find = (list, title) => list.find((i) => i.title === title);

async function signedIn(opts) {
  const app = await loadApp(opts);
  await app.login();
  return app;
}

describe('local insights (computeInsights)', () => {
  it('asks for data when there is none', async () => {
    const { window } = await loadApp();
    expect(titles(insights(window))).toContain('Add your first transactions');
  });

  it('warns when spending exceeds income', async () => {
    const { window } = await loadApp();
    const list = insights(window, { transactions: [tx('2026-01', 'income', 1000), tx('2026-01', 'expense', 1500)] });
    expect(find(list, 'Spending exceeds income').level).toBe('warn');
    expect(find(list, 'Spending exceeds income').text).toContain('500.00 DHS');
  });

  it.each([
    [950, 'Low savings rate', 'warn'],
    [850, 'Savings rate', 'info'],
    [700, 'Healthy savings rate', 'good'],
  ])('rates a spend of %i out of 1000 income as "%s"', async (spent, title, level) => {
    const { window } = await loadApp();
    const list = insights(window, { transactions: [tx('2026-01', 'income', 1000), tx('2026-01', 'expense', spent)] });
    expect(find(list, title).level).toBe(level);
  });

  it('detects rising and falling expenses between the last two months', async () => {
    const { window } = await loadApp();
    const base = [tx('2026-01', 'income', 5000), tx('2026-02', 'income', 5000)];
    const up = insights(window, { transactions: [...base, tx('2026-01', 'expense', 1000), tx('2026-02', 'expense', 1500)] });
    expect(find(up, 'Expenses are rising').text).toContain('50%');
    const down = insights(window, { transactions: [...base, tx('2026-01', 'expense', 1000), tx('2026-02', 'expense', 500)] });
    expect(find(down, 'Expenses are falling')).toBeTruthy();
  });

  it('points out an expense that dominates spending', async () => {
    const { window } = await loadApp();
    const list = insights(window, {
      transactions: [tx('2026-01', 'income', 9000), tx('2026-01', 'expense', 800, 'Rent'), tx('2026-02', 'expense', 800, 'rent'), tx('2026-01', 'expense', 400, 'Food')],
    });
    expect(find(list, 'Biggest expense').text).toContain('80%');
  });

  it('projects when the loan will be repaid', async () => {
    const { window } = await loadApp();
    const list = insights(window, { rental: [{ month: '2026-01', income: '4000', expense: '0' }, { month: '2026-02', income: '4000', expense: '0' }], loan: 20000 });
    const pace = find(list, 'Loan repayment pace');
    expect(pace.text).toContain('12000.00 DHS');
    expect(pace.text).toContain('about 3 months');
    expect(pace.text).toContain('2026-05');
  });

  it('warns when the loan is not shrinking and congratulates when it is repaid', async () => {
    const { window } = await loadApp();
    expect(find(insights(window, { rental: [{ month: '2026-01', income: '100', expense: '300' }] }), 'Loan is not shrinking')).toBeTruthy();
    expect(find(insights(window, { rental: [{ month: '2026-01', income: '5000', expense: '0' }], loan: 4000 }), 'Loan repaid').level).toBe('good');
  });

  it('compares the savings pace with what is needed before the deadline', async () => {
    const { window } = await loadApp();
    // 3 months left (Oct 2026 -> Jan 2027): 26000 - 2000 = 24000 -> 8000/month needed
    const behind = insights(window, { savings: [{ month: '2026-01', amount: '2000' }] });
    expect(find(behind, 'Savings behind schedule').text).toContain('8000.00 DHS');
    const onTrack = insights(window, { savings: [{ month: '2026-01', amount: '9000' }], target: 26000 });
    expect(find(onTrack, 'Savings on track')).toBeTruthy();
  });

  it('handles reached targets and ended periods', async () => {
    const { window } = await loadApp();
    expect(find(insights(window, { savings: [{ month: '2026-01', amount: '30000' }] }), 'Savings target reached')).toBeTruthy();
    const late = insights(window, { savings: [{ month: '2026-01', amount: '1000' }], now: new Date(2027, 2, 1) });
    expect(find(late, 'Savings period has ended')).toBeTruthy();
  });

  it('shows the next sub-target with an ETA', async () => {
    const { window } = await loadApp();
    const list = insights(window, {
      savings: [{ month: '2026-01', amount: '2000' }, { month: '2026-02', amount: '2000' }],
      milestones: [{ name: 'Emergency', amount: '3000' }, { name: 'Holiday', amount: '9000' }],
    });
    const next = find(list, 'Next sub-target');
    expect(next.text).toContain('Holiday');
    expect(next.text).toContain('5000.00 DHS to go');
    expect(next.text).toContain('about 3 months');
  });

  it('renders insights on the Advice tab as escaped text', async () => {
    const supabase = createMockSupabase({
      tables: { general_transactions: [tx('2026-01', 'income', 9000), tx('2026-01', 'expense', 900, '<img src=x onerror=alert(1)>'), tx('2026-01', 'expense', 50, 'Food')] },
    });
    const app = await signedIn({ supabase });
    app.window.renderInsights();
    expect(app.document.querySelector('#insightList img')).toBeNull();
    expect(app.document.querySelectorAll('#insightList .insight').length).toBeGreaterThan(2);
    expect(app.text('insightList')).toContain('<img src=x');
  });
});

describe('AI summary (what leaves the device)', () => {
  const seeded = () => createMockSupabase({
    tables: {
      general_transactions: [tx('2026-01', 'income', 8000, 'Salary ACME'), tx('2026-01', 'expense', 1200, 'Rent for Mr Smith'), tx('2026-02', 'expense', 300, 'Gym')],
      rental_records: [{ id: 'r1', month: '2026-01', income: '3000', expense: '500', expense_description: 'secret plumber' }],
      savings_records: [{ id: 's1', month: '2026-01', amount: '2000' }],
      savings_milestones: [{ id: 'm1', name: 'Private goal name', amount: '1500' }],
    },
  });

  it('contains only aggregated numbers by default', async () => {
    const app = await signedIn({ supabase: seeded() });
    const summary = app.window.buildAdviceSummary(false);
    const json = JSON.stringify(summary);
    expect(json).not.toContain('Salary');
    expect(json).not.toContain('Smith');
    expect(json).not.toContain('plumber');
    expect(json).not.toContain('Private goal');
    expect(json).not.toContain(USER.email);
    expect(json).not.toContain(USER.id);
    expect(summary.top_expenses).toEqual([]);
    expect(summary.months).toEqual([
      { month: '2026-01', income: 8000, expenses: 1200 },
      { month: '2026-02', income: 0, expenses: 300 },
    ]);
    expect(summary.loan).toEqual({ amount: 70000, repaid: 2500, remaining: 67500, avg_monthly_net: 2500 });
    expect(summary.savings.milestones).toEqual([{ amount: 1500, reached: true }]);
  });

  it('adds expense descriptions only when opted in', async () => {
    const app = await signedIn({ supabase: seeded() });
    const summary = app.window.buildAdviceSummary(true);
    expect(summary.top_expenses.map((t) => t.label)).toEqual(['Rent for Mr Smith', 'Gym']);
  });

  it('keeps only the last 12 months', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => tx(`2025-${String((i % 12) + 1).padStart(2, '0')}`, 'income', 100 + i, `n${i}`));
    const unique = new Map(rows.map((r) => [r.month, r]));
    const many = [...unique.values()];
    const app = await signedIn({ supabase: createMockSupabase({ tables: { general_transactions: many } }) });
    expect(app.window.buildAdviceSummary().months.length).toBeLessThanOrEqual(12);
  });

  it('passes server-side validation', async () => {
    const app = await signedIn({ supabase: seeded() });
    const result = validateSummary(JSON.parse(JSON.stringify(app.window.buildAdviceSummary(true))));
    expect(result.ok).toBe(true);
  });
});

describe('monthly AI advice: opt-in and shared summary', () => {
  const seeded = (extra = {}) => createMockSupabase({
    tables: { general_transactions: [tx('2026-01', 'income', 8000, 'Salary'), tx('2026-01', 'expense', 1200, 'Rent')], ...extra },
  });

  it('is off by default and never uploads a summary', async () => {
    const app = await signedIn({ supabase: seeded() });
    expect(app.document.getElementById('aiOptIn').checked).toBe(false);
    expect(app.supabase.ops('ai_advice_settings', 'upsert')).toHaveLength(0);
  });

  it('asks for consent, then stores the opt-in with the anonymous summary', async () => {
    const app = await signedIn({ supabase: seeded() });
    app.document.getElementById('aiOptIn').checked = true;
    await app.window.toggleAiOptIn();
    expect(app.window.confirm.mock.calls[0][0]).toContain('Not shared');
    const [up] = app.supabase.ops('ai_advice_settings', 'upsert');
    expect(up.options).toEqual({ onConflict: 'user_id' });
    const row = up.payload[0];
    expect(row.user_id).toBe(USER.id);
    expect(row.enabled).toBe(true);
    expect(row.include_labels).toBe(false);
    expect(row.summary.months).toHaveLength(1);
    expect(row.summary.top_expenses).toEqual([]);
    expect(JSON.stringify(row.summary)).not.toContain('Salary');
    expect(JSON.stringify(row.summary)).not.toContain('Rent');
    expect(validateSummary(row.summary).ok).toBe(true);
  });

  it('stores nothing and stays off when consent is declined', async () => {
    const app = await signedIn({ supabase: seeded(), confirmResult: false });
    app.document.getElementById('aiOptIn').checked = true;
    await app.window.toggleAiOptIn();
    expect(app.supabase.ops('ai_advice_settings', 'upsert')).toHaveLength(0);
    expect(app.document.getElementById('aiOptIn').checked).toBe(false);
  });

  it('erases the shared summary when turned off', async () => {
    const supabase = seeded({ ai_advice_settings: [{ enabled: true, include_labels: false, summary_at: new Date().toISOString() }] });
    const app = await signedIn({ supabase });
    expect(app.document.getElementById('aiOptIn').checked).toBe(true);
    app.document.getElementById('aiOptIn').checked = false;
    await app.window.toggleAiOptIn();
    const [up] = app.supabase.ops('ai_advice_settings', 'upsert');
    expect(up.payload[0]).toMatchObject({ enabled: false, include_labels: false, summary: null, summary_at: null });
  });

  it('shares descriptions only when ticked, and updates an existing opt-in', async () => {
    const supabase = seeded({ ai_advice_settings: [{ enabled: true, include_labels: false, summary_at: new Date().toISOString() }] });
    const app = await signedIn({ supabase });
    app.document.getElementById('aiIncludeLabels').checked = true;
    await app.window.changeAiLabels();
    const row = app.supabase.ops('ai_advice_settings', 'upsert')[0].payload[0];
    expect(row.include_labels).toBe(true);
    expect(row.summary.top_expenses.map((t) => t.label)).toEqual(['Rent']);
  });

  it('ignores the descriptions checkbox while the monthly advice is off', async () => {
    const app = await signedIn({ supabase: seeded() });
    app.document.getElementById('aiIncludeLabels').checked = true;
    await app.window.changeAiLabels();
    expect(app.supabase.ops('ai_advice_settings', 'upsert')).toHaveLength(0);
  });

  it('refreshes a stale shared summary on load, but not a fresh one', async () => {
    const stale = seeded({ ai_advice_settings: [{ enabled: true, include_labels: false, summary_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString() }] });
    const staleApp = await signedIn({ supabase: stale });
    expect(staleApp.supabase.ops('ai_advice_settings', 'upsert')).toHaveLength(1);

    const fresh = seeded({ ai_advice_settings: [{ enabled: true, include_labels: false, summary_at: new Date().toISOString() }] });
    const freshApp = await signedIn({ supabase: fresh });
    expect(freshApp.supabase.ops('ai_advice_settings', 'upsert')).toHaveLength(0);
  });

  it('does not sync anything for users who opted out', async () => {
    const app = await signedIn({ supabase: seeded({ ai_advice_settings: [{ enabled: false, include_labels: false, summary_at: null }] }) });
    expect(app.supabase.ops('ai_advice_settings', 'upsert')).toHaveLength(0);
  });

  it('disables the feature (app keeps working) when the table does not exist yet', async () => {
    const supabase = seeded();
    const failing = createMockSupabase({
      tables: { general_transactions: [tx('2026-01', 'income', 100)] },
      overrides: { 'ai_advice_settings:select': { data: null, error: { message: 'missing' } } },
    });
    const app = await signedIn({ supabase: failing });
    expect(app.document.getElementById('aiOptIn').disabled).toBe(true);
    expect(app.document.getElementById('aiUnavailable').hidden).toBe(false);
    expect(app.document.getElementById('mainApp').style.display).toBe('block');
    expect(supabase).toBeTruthy();
  });
});

describe('monthly AI advice: showing the saved advice', () => {
  const latest = {
    advice: '- **Save more**: put aside 500 DHS\n- Cut <b>costs</b>\nGeneral information only.',
    period: '2026-10',
    generated_at: '2026-10-02T06:00:00Z',
  };
  const withAdvice = (fn) => createMockSupabase({
    tables: { general_transactions: [tx('2026-01', 'income', 8000), tx('2026-01', 'expense', 1200, 'Rent')] },
    functions: { 'ai-advice': fn },
  });

  it('shows the latest saved advice as safe formatted text, without calling any AI', async () => {
    const app = await signedIn({ supabase: withAdvice({ data: latest, error: null }) });
    await app.window.loadLatestAdvice();
    const [name, options] = app.supabase.client.functions.invoke.mock.calls.at(-1);
    expect(name).toBe('ai-advice');
    expect(options).toBeUndefined(); // no summary is sent: the function only reads the cache
    const box = app.document.getElementById('aiAdvice');
    expect(box.hidden).toBe(false);
    expect(box.querySelectorAll('li')).toHaveLength(2);
    expect(box.querySelector('strong').textContent).toBe('Save more');
    expect(box.querySelector('b')).toBeNull();
    expect(box.textContent).toContain('<b>costs</b>');
    expect(app.text('aiMeta')).toContain('2026-10');
    expect(app.text('aiMeta')).toContain('once a month');
  });

  it('loads the saved advice automatically when the Advice tab is opened', async () => {
    const app = await signedIn({ supabase: withAdvice({ data: latest, error: null }) });
    const before = app.supabase.client.functions.invoke.mock.calls.length;
    app.document.querySelector('[aria-controls="advice"]').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(app.supabase.client.functions.invoke.mock.calls.length).toBe(before + 1);
    expect(app.document.querySelector('#aiAdvice li')).not.toBeNull();
  });

  it('explains when nothing has been generated yet (opted in)', async () => {
    const supabase = createMockSupabase({
      tables: { general_transactions: [tx('2026-01', 'income', 100)], ai_advice_settings: [{ enabled: true, include_labels: false, summary_at: new Date().toISOString() }] },
      functions: { 'ai-advice': { data: { advice: null }, error: null } },
    });
    const app = await signedIn({ supabase });
    await app.window.loadLatestAdvice();
    expect(app.text('aiAdvice')).toContain('next monthly run');
  });

  it('invites the user to opt in when nothing exists and the feature is off', async () => {
    const app = await signedIn({ supabase: withAdvice({ data: { advice: null }, error: null }) });
    await app.window.loadLatestAdvice();
    expect(app.text('aiAdvice')).toContain('Turn on');
  });

  it.each([
    [401, 'log in again'],
    [404, 'not set up yet'],
    [503, 'temporarily unavailable'],
    [500, 'Could not load your advice'],
  ])('explains HTTP %i to the user', async (status, expected) => {
    const app = await signedIn({ supabase: withAdvice({ data: null, error: { message: 'x', context: { status } } }) });
    await app.window.loadLatestAdvice();
    const box = app.document.getElementById('aiAdvice');
    expect(box.classList.contains('error')).toBe(true);
    expect(box.textContent).toContain(expected);
  });

  it('deletes the saved advice (scoped to the user) after confirmation', async () => {
    const app = await signedIn({ supabase: withAdvice({ data: latest, error: null }) });
    await app.window.loadLatestAdvice();
    await app.window.deleteSavedAdvice();
    expect(app.supabase.ops('ai_advice_cache', 'delete')[0].filters).toEqual({ user_id: USER.id });
    expect(app.document.getElementById('aiAdvice').hidden).toBe(true);
  });

  it('keeps the saved advice when deletion is declined or fails', async () => {
    const declined = await signedIn({ supabase: withAdvice({ data: latest, error: null }), confirmResult: false });
    await declined.window.deleteSavedAdvice();
    expect(declined.supabase.ops('ai_advice_cache', 'delete')).toHaveLength(0);

    const failing = createMockSupabase({ overrides: { 'ai_advice_cache:delete': { data: null, error: { message: 'denied' } } } });
    const app = await signedIn({ supabase: failing });
    await app.window.deleteSavedAdvice();
    expect(app.window.alert).toHaveBeenCalledWith(expect.stringContaining('denied'));
  });

  it('clears the advice when logging out', async () => {
    const app = await signedIn({ supabase: withAdvice({ data: latest, error: null }) });
    await app.window.loadLatestAdvice();
    await app.window.logoutUser();
    expect(app.document.getElementById('aiAdvice').innerHTML).toBe('');
    expect(app.document.getElementById('aiOptIn').checked).toBe(false);
  });
});

describe('ai-advice-cron logic', () => {
  it('uses the UTC year-month as the period', () => {
    expect(currentPeriod(new Date('2026-10-01T00:30:00Z'))).toBe('2026-10');
    expect(currentPeriod(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
    expect(currentPeriod(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01');
  });

  it('compares secrets in constant time and rejects wrong, empty or missing ones', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it.each([
    ['Bearer s3cret', 's3cret', true],
    ['bearer s3cret', 's3cret', true],
    ['Bearer wrong', 's3cret', false],
    ['s3cret', 's3cret', false],
    ['Bearer ', 's3cret', false],
    [null, 's3cret', false],
    ['Bearer s3cret', undefined, false],
    ['Bearer s3cret', '', false],
  ])('authorises header %j against secret %j: %s', (header, secret, expected) => {
    expect(isAuthorizedCron(header, secret)).toBe(expected);
  });

  it('only picks opted-in users with a summary who have no advice for the period, up to the cap', () => {
    const users = [
      { user_id: 'a', summary: { x: 1 } },
      { user_id: 'b', summary: null },
      { user_id: 'c', summary: { x: 1 } },
      { user_id: 'd', summary: { x: 1 } },
      { user_id: 'e', summary: { x: 1 } },
    ];
    expect(pickUsers(users, new Set(['c']), 10).map((u) => u.user_id)).toEqual(['a', 'd', 'e']);
    expect(pickUsers(users, new Set(['c']), 2).map((u) => u.user_id)).toEqual(['a', 'd']);
    expect(pickUsers(users, new Set(['a', 'c', 'd', 'e']), 10)).toEqual([]);
  });

  it('removes expense descriptions unless the user opted in to sharing them', () => {
    const summary = validateSummary({
      language: 'en',
      months: [{ month: '2026-01', income: 1, expenses: 1 }],
      loan: { amount: 1, repaid: 0, remaining: 1, avg_monthly_net: 0 },
      savings: { target: 1, saved: 0, remaining: 1, avg_monthly: 0, deadline: null, milestones: [] },
      top_expenses: [{ label: 'Rent', amount: 1 }],
    }).value;
    expect(applyLabelPolicy(summary, false).top_expenses).toEqual([]);
    expect(applyLabelPolicy(summary, null).top_expenses).toEqual([]);
    expect(applyLabelPolicy(summary, undefined).top_expenses).toEqual([]);
    expect(applyLabelPolicy(summary, true).top_expenses).toHaveLength(1);
  });

  it('re-validates a tampered stored summary before it can reach the AI', () => {
    expect(validateSummary({ months: [{ month: 'bad', income: 1, expenses: 1 }] }).ok).toBe(false);
    expect(validateSummary('<script>').ok).toBe(false);
  });
});

describe('ai-advice Edge Function logic', () => {
  const good = () => ({
    language: 'fr',
    months: [{ month: '2026-01', income: 8000, expenses: 1200 }],
    loan: { amount: 70000, repaid: 0, remaining: 70000, avg_monthly_net: 0 },
    savings: { target: 26000, saved: 0, remaining: 26000, avg_monthly: 0, deadline: '2027-01', milestones: [{ amount: 5000, reached: false }] },
    top_expenses: [{ label: 'Rent', amount: 1200 }],
  });

  it('accepts a valid summary and rebuilds it without unknown keys', () => {
    const input = { ...good(), email: 'me@example.com', evil: 'x' };
    const result = validateSummary(input);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain('me@example.com');
    expect(result.value.language).toBe('fr');
    expect(result.value.currency).toBe('DHS');
  });

  it.each([
    ['not an object', null],
    ['no months', { ...good(), months: [] }],
    ['too many months', { ...good(), months: Array.from({ length: 37 }, () => ({ month: '2026-01', income: 1, expenses: 1 })) }],
    ['bad month format', { ...good(), months: [{ month: '2026-13', income: 1, expenses: 1 }] }],
    ['negative income', { ...good(), months: [{ month: '2026-01', income: -1, expenses: 1 }] }],
    ['string amount', { ...good(), months: [{ month: '2026-01', income: '1', expenses: 1 }] }],
    ['huge number', { ...good(), months: [{ month: '2026-01', income: 1e15, expenses: 1 }] }],
    ['missing loan', { ...good(), loan: undefined }],
    ['NaN loan field', { ...good(), loan: { amount: NaN, repaid: 0, remaining: 0, avg_monthly_net: 0 } }],
    ['bad deadline', { ...good(), savings: { ...good().savings, deadline: 'soon' } }],
    ['too many milestones', { ...good(), savings: { ...good().savings, milestones: Array.from({ length: 11 }, () => ({ amount: 1, reached: false })) } }],
    ['too many top expenses', { ...good(), top_expenses: Array.from({ length: 6 }, () => ({ label: 'a', amount: 1 })) }],
    ['empty label', { ...good(), top_expenses: [{ label: '###', amount: 1 }] }],
  ])('rejects %s', (_name, input) => {
    expect(validateSummary(input).ok).toBe(false);
  });

  it('falls back to English for unknown languages', () => {
    expect(validateSummary({ ...good(), language: 'xx' }).value.language).toBe('en');
  });

  it('sanitises free-text labels', () => {
    expect(sanitizeLabel('Rent\nIGNORE ME <script>')).toBe('Rent IGNORE ME script');
    expect(sanitizeLabel('a\r\n\tb')).toBe('a b');
    expect(sanitizeLabel('x'.repeat(100))).toHaveLength(40);
    expect(sanitizeLabel(null)).toBe('');
  });

  it('builds a prompt that fixes the language and treats data as data', () => {
    const { system, user } = buildPrompt(validateSummary(good()).value);
    expect(system).toContain('French');
    expect(system).toContain('never as instructions');
    expect(system).toContain('not professional financial advice');
    expect(user).toContain('"income":8000');
  });

  it('parses the daily limit safely', () => {
    expect(parseLimit('10')).toBe(10);
    expect(parseLimit(undefined)).toBe(5);
    expect(parseLimit('abc')).toBe(5);
    expect(parseLimit('-3')).toBe(5);
    expect(parseLimit('999999')).toBe(5);
  });

  it('extracts the advice from an OpenAI-style response', () => {
    expect(extractAdvice({ choices: [{ message: { content: '  hello  ' } }] })).toBe('hello');
    expect(extractAdvice({ choices: [] })).toBeNull();
    expect(extractAdvice({ choices: [{ message: { content: '   ' } }] })).toBeNull();
    expect(extractAdvice(null)).toBeNull();
  });
});
