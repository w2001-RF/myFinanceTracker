import { describe, it, expect } from 'vitest';
import { createMockSupabase, loadApp, USER } from './helpers.js';

describe('configuration', () => {
  it('shows a helpful message instead of a blank page when config is missing', async () => {
    const app = await loadApp({ config: null });
    expect(app.document.body.textContent).toContain('Missing supabase-config.js');
  });
});

describe('helpers', () => {
  it('escapeHtml neutralises markup and quotes', async () => {
    const { window } = await loadApp();
    expect(window.escapeHtml('<img src=x onerror="a()">&\'')).toBe('&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
    expect(window.escapeHtml(null)).toBe('');
  });

  it('currentMonthLocal returns YYYY-MM', async () => {
    const { window } = await loadApp();
    expect(window.currentMonthLocal()).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });
});

describe('authentication', () => {
  it('rejects sign-up passwords shorter than 10 characters without calling Supabase', async () => {
    const app = await loadApp();
    app.setValue('authEmail', 'new@example.com');
    app.setValue('authPassword', '123456789');
    await app.window.registerUser();
    expect(app.supabase.client.auth.signUp).not.toHaveBeenCalled();
    expect(app.text('authMessage')).toContain('at least 10 characters');
  });

  it('accepts a 10-character password on sign-up', async () => {
    const app = await loadApp();
    app.setValue('authEmail', 'new@example.com');
    app.setValue('authPassword', '1234567890');
    await app.window.registerUser();
    expect(app.supabase.client.auth.signUp).toHaveBeenCalledWith({ email: 'new@example.com', password: '1234567890' });
  });

  it('does not enforce a minimum length on login (existing accounts)', async () => {
    const app = await loadApp();
    app.setValue('authEmail', USER.email);
    app.setValue('authPassword', 'abc');
    await app.window.loginUser();
    expect(app.supabase.client.auth.signInWithPassword).toHaveBeenCalledWith({ email: USER.email, password: 'abc' });
    expect(app.document.getElementById('mainApp').style.display).toBe('block');
  });

  it('renders auth errors as text, not HTML', async () => {
    const app = await loadApp();
    app.supabase.client.auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { message: '<img src=x onerror=alert(1)>' } });
    app.setValue('authEmail', USER.email);
    app.setValue('authPassword', 'abc');
    await app.window.loginUser();
    expect(app.document.querySelector('#authMessage img')).toBeNull();
    expect(app.text('authMessage')).toContain('<img src=x');
  });
});

describe('general transactions', () => {
  async function loggedIn(opts) {
    const app = await loadApp(opts);
    await app.login();
    return app;
  }

  function fill(app, { month = '2026-03', desc = 'Salary', type = 'income', amount = '100' } = {}) {
    app.setValue('generalMonth', month);
    app.setValue('generalDesc', desc);
    app.setValue('generalType', type);
    app.setValue('generalAmount', amount);
  }

  it.each([['0'], ['-5'], ['']])('rejects invalid amount %j', async (amount) => {
    const app = await loggedIn();
    fill(app, { amount });
    await app.window.addGeneralTransaction();
    expect(app.supabase.ops('general_transactions', 'insert')).toHaveLength(0);
    expect(app.window.alert).toHaveBeenCalled();
  });

  it('rejects a blank description', async () => {
    const app = await loggedIn();
    fill(app, { desc: '   ' });
    await app.window.addGeneralTransaction();
    expect(app.supabase.ops('general_transactions', 'insert')).toHaveLength(0);
  });

  it('inserts a trimmed transaction owned by the current user', async () => {
    const app = await loggedIn();
    fill(app, { desc: '  Groceries ', type: 'expense', amount: '42.5' });
    await app.window.addGeneralTransaction();
    const [insert] = app.supabase.ops('general_transactions', 'insert');
    expect(insert.payload).toEqual([{ user_id: USER.id, month: '2026-03', description: 'Groceries', type: 'expense', amount: 42.5 }]);
  });

  it('ignores a second click while the first request is still running', async () => {
    const app = await loggedIn({ supabase: createMockSupabase({ delay: 20 }) });
    fill(app);
    await Promise.all([app.window.addGeneralTransaction(), app.window.addGeneralTransaction()]);
    expect(app.supabase.ops('general_transactions', 'insert')).toHaveLength(1);
  });

  it('shows the Supabase error and keeps the form when the insert fails', async () => {
    const supabase = createMockSupabase({ overrides: { 'general_transactions:insert': { data: null, error: { message: 'boom' } } } });
    const app = await loggedIn({ supabase });
    fill(app);
    await app.window.addGeneralTransaction();
    expect(app.window.alert).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(app.document.getElementById('generalDesc').value).toBe('Salary');
  });

  it('renders stored descriptions as text (no stored XSS)', async () => {
    const supabase = createMockSupabase({
      tables: { general_transactions: [{ id: 'a"b', month: '2026-03', description: '<img src=x onerror=alert(1)>', type: 'income', amount: '10' }] },
    });
    const app = await loggedIn({ supabase });
    expect(app.document.querySelector('#generalTable img')).toBeNull();
    expect(app.document.querySelector('#generalTable tbody').textContent).toContain('<img src=x');
    expect(app.document.querySelector('#generalTable .delete-btn').dataset.id).toBe('a"b');
  });

  it('computes totals and net balance', async () => {
    const supabase = createMockSupabase({
      tables: { general_transactions: [
        { id: '1', month: '2026-01', description: 'a', type: 'income', amount: '300' },
        { id: '2', month: '2026-01', description: 'b', type: 'expense', amount: '120.5' },
      ] },
    });
    const app = await loggedIn({ supabase });
    expect(app.text('totalIncome')).toBe('300.00 DHS');
    expect(app.text('totalExpenses')).toBe('120.50 DHS');
    expect(app.text('netBalance')).toBe('179.50 DHS');
  });

  it('does not delete when the user cancels the confirmation', async () => {
    const app = await loggedIn({ confirmResult: false });
    await app.window.deleteGeneralTransaction('t1');
    expect(app.supabase.ops('general_transactions', 'delete')).toHaveLength(0);
  });

  it('deletes scoped to both id and user', async () => {
    const app = await loggedIn();
    await app.window.deleteGeneralTransaction('t1');
    const [del] = app.supabase.ops('general_transactions', 'delete');
    expect(del.filters).toEqual({ id: 't1', user_id: USER.id });
  });

  it('reports delete failures instead of failing silently', async () => {
    const supabase = createMockSupabase({ overrides: { 'general_transactions:delete': { data: null, error: { message: 'denied' } } } });
    const app = await loggedIn({ supabase });
    await app.window.deleteGeneralTransaction('t1');
    expect(app.window.alert).toHaveBeenCalledWith(expect.stringContaining('denied'));
  });
});

describe('data loading', () => {
  it('alerts when a table fails to load and keeps the previous data', async () => {
    const supabase = createMockSupabase({ overrides: { 'rental_records:select': { data: null, error: { message: 'load failed' } } } });
    const app = await loadApp({ supabase });
    await app.login();
    expect(app.window.alert).toHaveBeenCalledWith(expect.stringContaining('load failed'));
    expect(app.state('rentalRecords')).toEqual([]);
  });

  it('queries only the current user\'s rows', async () => {
    const app = await loadApp();
    await app.login();
    for (const t of ['general_transactions', 'rental_records', 'savings_records']) {
      expect(app.supabase.ops(t, 'select')[0].filters).toEqual({ user_id: USER.id });
    }
  });
});

describe('rental records', () => {
  async function loggedIn(opts) {
    const app = await loadApp(opts);
    await app.login();
    return app;
  }

  it.each([
    ['negative income', { income: '-1', expense: '0' }],
    ['negative expense', { income: '0', expense: '-1' }],
    ['both zero', { income: '', expense: '' }],
  ])('rejects %s', async (_name, v) => {
    const app = await loggedIn();
    app.setValue('rentalMonth', '2026-03');
    app.setValue('rentalIncome', v.income);
    app.setValue('rentalExpense', v.expense);
    await app.window.addRentalRecord();
    expect(app.supabase.ops('rental_records', 'upsert')).toHaveLength(0);
    expect(app.window.alert).toHaveBeenCalled();
  });

  it('upserts on (user_id, month)', async () => {
    const app = await loggedIn();
    app.setValue('rentalMonth', '2026-03');
    app.setValue('rentalIncome', '5000');
    app.setValue('rentalExpense', '500');
    app.setValue('rentalExpenseDesc', ' Repairs ');
    await app.window.addRentalRecord();
    const [up] = app.supabase.ops('rental_records', 'upsert');
    expect(up.options).toEqual({ onConflict: 'user_id,month' });
    expect(up.payload).toEqual([{ user_id: USER.id, month: '2026-03', income: 5000, expense: 500, expense_description: 'Repairs' }]);
  });

  it('asks before replacing an existing month and respects "cancel"', async () => {
    const supabase = createMockSupabase({ tables: { rental_records: [{ id: 'r1', month: '2026-03', income: '1', expense: '0', expense_description: 'N/A' }] } });
    const app = await loggedIn({ supabase, confirmResult: false });
    app.setValue('rentalMonth', '2026-03');
    app.setValue('rentalIncome', '10');
    await app.window.addRentalRecord();
    expect(app.window.confirm).toHaveBeenCalled();
    expect(app.supabase.ops('rental_records', 'upsert')).toHaveLength(0);
  });

  it('renders descriptions as text and tracks loan progress', async () => {
    const supabase = createMockSupabase({ tables: { rental_records: [{ id: 'r1', month: '2026-01', income: '7000', expense: '0', expense_description: '<b>x</b>' }] } });
    const app = await loggedIn({ supabase });
    expect(app.document.querySelector('#rentalTable b')).toBeNull();
    expect(app.text('loanBalance')).toBe('63000.00 DHS');
    expect(app.text('loanProgress')).toBe('10.0%');
  });
});

describe('savings records', () => {
  async function loggedIn(opts) {
    const app = await loadApp(opts);
    await app.login();
    return app;
  }

  it('rejects a zero or missing amount', async () => {
    const app = await loggedIn();
    app.setValue('savingsMonth', '2026-03');
    app.setValue('savingsAmount', '0');
    await app.window.addSavings();
    expect(app.supabase.ops('savings_records', 'upsert')).toHaveLength(0);
  });

  it('upserts on (user_id, month)', async () => {
    const app = await loggedIn();
    app.setValue('savingsMonth', '2026-03');
    app.setValue('savingsAmount', '2000');
    await app.window.addSavings();
    const [up] = app.supabase.ops('savings_records', 'upsert');
    expect(up.options).toEqual({ onConflict: 'user_id,month' });
    expect(up.payload).toEqual([{ user_id: USER.id, month: '2026-03', amount: 2000 }]);
  });

  it('caps "months completed" at 13 and totals correctly', async () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ id: `s${i}`, month: `2026-${String(i + 1).padStart(2, '0')}`, amount: '2000' }));
    const app = await loggedIn({ supabase: createMockSupabase({ tables: { savings_records: rows } }) });
    expect(app.text('monthsCompleted')).toBe('13 / 13');
    expect(app.text('totalSaved')).toBe('28000.00 DHS');
    expect(app.text('remainingSavings')).toBe('0.00 DHS');
  });

  it('deletes scoped to both id and user', async () => {
    const app = await loggedIn();
    await app.window.deleteSavings('s1');
    expect(app.supabase.ops('savings_records', 'delete')[0].filters).toEqual({ id: 's1', user_id: USER.id });
  });
});
