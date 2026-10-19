import { describe, it, expect } from 'vitest';
import { createMockSupabase, loadApp, USER } from './helpers.js';

async function signedIn(opts) {
  const app = await loadApp(opts);
  await app.login();
  return app;
}

describe('quick transactions', () => {
  const templates = [
    { id: 't1', description: 'Salary', type: 'income', amount: '8000' },
    { id: 't2', description: '<b>Rent</b>', type: 'expense', amount: '2500.5' },
  ];
  const seeded = () => createMockSupabase({ tables: { transaction_templates: templates } });

  it('renders saved quick transactions as escaped chips', async () => {
    const app = await signedIn({ supabase: seeded() });
    expect(app.document.querySelectorAll('#templateList .chip')).toHaveLength(2);
    expect(app.document.querySelector('#templateList b')).toBeNull();
    expect(app.document.getElementById('templateEmpty').hidden).toBe(true);
  });

  it('adds a transaction in one step for the selected month', async () => {
    const app = await signedIn({ supabase: seeded() });
    app.setValue('generalMonth', '2026-05');
    await app.window.addFromTemplate('t1');
    const [insert] = app.supabase.ops('general_transactions', 'insert');
    expect(insert.payload).toEqual([{ user_id: USER.id, month: '2026-05', description: 'Salary', type: 'income', amount: 8000 }]);
    expect(app.document.querySelector('#toasts .toast').textContent).toContain('Salary');
  });

  it('asks for a month before adding from a quick transaction', async () => {
    const app = await signedIn({ supabase: seeded() });
    app.setValue('generalMonth', '');
    await app.window.addFromTemplate('t1');
    expect(app.window.alert).toHaveBeenCalled();
    expect(app.supabase.ops('general_transactions', 'insert')).toHaveLength(0);
  });

  it('saves the form as a quick transaction (upsert on user, description, type)', async () => {
    const app = await signedIn();
    app.setValue('generalDesc', ' Coffee ');
    app.setValue('generalType', 'expense');
    app.setValue('generalAmount', '15');
    await app.window.saveTemplate();
    const [up] = app.supabase.ops('transaction_templates', 'upsert');
    expect(up.options).toEqual({ onConflict: 'user_id,description,type' });
    expect(up.payload).toEqual([{ user_id: USER.id, description: 'Coffee', type: 'expense', amount: 15 }]);
  });

  it.each([['', '10'], ['Coffee', ''], ['Coffee', '0'], ['Coffee', '-3']])('refuses to save desc=%j amount=%j', async (desc, amount) => {
    const app = await signedIn();
    app.setValue('generalDesc', desc);
    app.setValue('generalAmount', amount);
    await app.window.saveTemplate();
    expect(app.supabase.ops('transaction_templates', 'upsert')).toHaveLength(0);
    expect(app.window.alert).toHaveBeenCalled();
  });

  it('copies a quick transaction into the form without saving', async () => {
    const app = await signedIn({ supabase: seeded() });
    app.window.fillFromTemplate('t2');
    expect(app.document.getElementById('generalDesc').value).toBe('<b>Rent</b>');
    expect(app.document.getElementById('generalType').value).toBe('expense');
    expect(app.document.getElementById('generalAmount').value).toBe('2500.5');
    expect(app.supabase.ops('general_transactions', 'insert')).toHaveLength(0);
  });

  it('deletes a quick transaction scoped to id and user', async () => {
    const app = await signedIn({ supabase: seeded() });
    await app.window.deleteTemplate('t1');
    expect(app.supabase.ops('transaction_templates', 'delete')[0].filters).toEqual({ id: 't1', user_id: USER.id });
  });

  it('keeps working (feature disabled) when the table does not exist yet', async () => {
    const supabase = createMockSupabase({ overrides: { 'transaction_templates:select': { data: null, error: { message: 'relation does not exist' } } } });
    const app = await signedIn({ supabase });
    expect(app.document.getElementById('saveTemplateBtn').hidden).toBe(true);
    expect(app.text('templateEmpty')).toContain('migration');
    expect(app.document.getElementById('mainApp').style.display).toBe('block');
  });
});

describe('editing records', () => {
  const tx = [{ id: 'g1', month: '2026-02', description: 'Old', type: 'expense', amount: '10' }];
  const rental = [{ id: 'r1', month: '2026-02', income: '1000', expense: '100', expense_description: 'Fix' }];
  const savings = [{ id: 's1', month: '2026-02', amount: '2000' }];
  const seeded = () => createMockSupabase({ tables: { general_transactions: tx, rental_records: rental, savings_records: savings } });

  it('updates a transaction by id instead of inserting', async () => {
    const app = await signedIn({ supabase: seeded() });
    app.window.editGeneralTransaction('g1');
    expect(app.document.getElementById('generalDesc').value).toBe('Old');
    expect(app.document.getElementById('generalSubmit').textContent).toBe('Update Transaction');
    app.setValue('generalAmount', '99');
    await app.window.addGeneralTransaction();
    const [up] = app.supabase.ops('general_transactions', 'update');
    expect(up.payload).toEqual({ month: '2026-02', description: 'Old', type: 'expense', amount: 99 });
    expect(up.filters).toEqual({ id: 'g1', user_id: USER.id });
    expect(app.supabase.ops('general_transactions', 'insert')).toHaveLength(0);
    expect(app.document.getElementById('generalSubmit').textContent).toBe('Add Transaction');
  });

  it('cancel leaves edit mode without saving', async () => {
    const app = await signedIn({ supabase: seeded() });
    app.window.editGeneralTransaction('g1');
    app.window.cancelGeneralEdit();
    expect(app.document.getElementById('generalSubmit').textContent).toBe('Add Transaction');
    expect(app.document.getElementById('generalDesc').value).toBe('');
    expect(app.supabase.ops('general_transactions', 'update')).toHaveLength(0);
  });

  it('updates a rental record in place and locks its month while editing', async () => {
    const app = await signedIn({ supabase: seeded() });
    app.window.editRentalRecord('r1');
    expect(app.document.getElementById('rentalMonth').disabled).toBe(true);
    app.setValue('rentalIncome', '1500');
    await app.window.addRentalRecord();
    const [up] = app.supabase.ops('rental_records', 'update');
    expect(up.payload).toEqual({ income: 1500, expense: 100, expense_description: 'Fix' });
    expect(up.filters).toEqual({ id: 'r1', user_id: USER.id });
    expect(app.supabase.ops('rental_records', 'upsert')).toHaveLength(0);
    expect(app.window.confirm).not.toHaveBeenCalled();
    expect(app.document.getElementById('rentalMonth').disabled).toBe(false);
  });

  it('updates a savings record in place and locks its month while editing', async () => {
    const app = await signedIn({ supabase: seeded() });
    app.window.editSavings('s1');
    expect(app.document.getElementById('savingsMonth').disabled).toBe(true);
    app.setValue('savingsAmount', '2500');
    await app.window.addSavings();
    const [up] = app.supabase.ops('savings_records', 'update');
    expect(up.payload).toEqual({ amount: 2500 });
    expect(up.filters).toEqual({ id: 's1', user_id: USER.id });
    expect(app.supabase.ops('savings_records', 'upsert')).toHaveLength(0);
  });

  it('reports update errors and stays in edit mode', async () => {
    const supabase = createMockSupabase({ tables: { savings_records: savings }, overrides: { 'savings_records:update': { data: null, error: { message: 'nope' } } } });
    const app = await signedIn({ supabase });
    app.window.editSavings('s1');
    await app.window.addSavings();
    expect(app.window.alert).toHaveBeenCalledWith(expect.stringContaining('nope'));
    expect(app.document.getElementById('savingsMonth').disabled).toBe(true);
  });
});

describe('filters and export', () => {
  const tx = [
    { id: '1', month: '2026-01', description: 'Salary', type: 'income', amount: '100' },
    { id: '2', month: '2026-02', description: 'Groceries', type: 'expense', amount: '20' },
    { id: '3', month: '2026-02', description: 'Gym', type: 'expense', amount: '30' },
  ];
  const rows = (app) => app.document.querySelectorAll('#generalTable tbody tr:not(.empty-row)');
  const seeded = () => createMockSupabase({ tables: { general_transactions: tx } });

  it('shows newest first and a result count', async () => {
    const app = await signedIn({ supabase: seeded() });
    expect(rows(app)).toHaveLength(3);
    expect(rows(app)[0].textContent).toContain('2026-02');
    expect(app.text('generalCount')).toBe('Showing 3 of 3 transactions');
  });

  it('filters by text and type, but totals still cover everything', async () => {
    const app = await signedIn({ supabase: seeded() });
    app.setValue('generalSearch', 'gro');
    app.window.updateGeneralDisplay();
    expect(rows(app)).toHaveLength(1);
    app.setValue('generalSearch', '');
    app.setValue('generalFilterType', 'income');
    app.window.updateGeneralDisplay();
    expect(rows(app)).toHaveLength(1);
    expect(app.text('generalCount')).toBe('Showing 1 of 3 transactions');
    expect(app.text('totalExpenses')).toBe('50.00 DHS');
  });

  it('shows a message when nothing matches', async () => {
    const app = await signedIn({ supabase: seeded() });
    app.setValue('generalSearch', 'zzz');
    app.window.updateGeneralDisplay();
    expect(app.text('generalTable')).toContain('No transactions match your filters');
  });

  it('builds safe CSV (quotes, commas and spreadsheet formulas)', async () => {
    const { window } = await loadApp();
    const csv = window.buildCsv(['a', 'b'], [['x,y', 'say "hi"'], ['=SUM(A1)', 5]]);
    expect(csv).toBe(['a,b', '"x,y","say ""hi"""', "'=SUM(A1),5"].join('\r\n'));
  });
});

describe('loan amount and savings target', () => {
  it('uses the defaults when no settings row exists', async () => {
    const app = await signedIn();
    expect(app.state('loanAmount')).toBe(70000);
    expect(app.state('savingsTarget')).toBe(26000);
    expect(app.text('savingsTargetDisplay')).toBe('26000.00 DHS');
  });

  it('uses the stored loan and target everywhere', async () => {
    const supabase = createMockSupabase({
      tables: {
        user_settings: [{ user_id: USER.id, loan_amount: '50000', savings_target: '10000' }],
        rental_records: [{ id: 'r1', month: '2026-01', income: '5000', expense: '0', expense_description: 'N/A' }],
        savings_records: [{ id: 's1', month: '2026-01', amount: '2500' }],
      },
    });
    const app = await signedIn({ supabase });
    expect(app.text('loanBalance')).toBe('45000.00 DHS');
    expect(app.text('loanProgress')).toBe('10.0%');
    expect(app.text('remainingSavings')).toBe('7500.00 DHS');
    expect(app.text('savingsProgress')).toBe('25.0%');
    expect(app.document.getElementById('loanAmountInput').value).toBe('50000');
  });

  it('saves a new loan amount and recalculates', async () => {
    const supabase = createMockSupabase({ tables: { rental_records: [{ id: 'r1', month: '2026-01', income: '5000', expense: '0', expense_description: 'N/A' }] } });
    const app = await signedIn({ supabase });
    app.setValue('loanAmountInput', '20000');
    await app.window.saveLoanAmount();
    const [up] = app.supabase.ops('user_settings', 'upsert');
    expect(up.options).toEqual({ onConflict: 'user_id' });
    expect(up.payload).toEqual([{ user_id: USER.id, loan_amount: 20000, savings_target: 26000 }]);
    expect(app.text('loanBalance')).toBe('15000.00 DHS');
  });

  it.each([['0'], ['-5'], ['']])('rejects loan amount %j', async (v) => {
    const app = await signedIn();
    app.setValue('loanAmountInput', v);
    await app.window.saveLoanAmount();
    expect(app.supabase.ops('user_settings', 'upsert')).toHaveLength(0);
    expect(app.window.alert).toHaveBeenCalled();
  });

  it('saves a new savings target', async () => {
    const app = await signedIn();
    app.setValue('savingsTargetInput', '30000');
    await app.window.saveSavingsTarget();
    const [up] = app.supabase.ops('user_settings', 'upsert');
    expect(up.payload).toEqual([{ user_id: USER.id, loan_amount: 70000, savings_target: 30000 }]);
    expect(app.text('savingsTargetDisplay')).toBe('30000.00 DHS');
  });

  it('refuses a main target that is not above every sub-target', async () => {
    const supabase = createMockSupabase({ tables: { savings_milestones: [{ id: 'm1', name: 'Phase 1', amount: '12000' }] } });
    const app = await signedIn({ supabase });
    app.setValue('savingsTargetInput', '12000');
    await app.window.saveSavingsTarget();
    expect(app.supabase.ops('user_settings', 'upsert')).toHaveLength(0);
    expect(app.window.alert).toHaveBeenCalledWith(expect.stringContaining('Phase 1'));
  });

  it('disables editing (but keeps the app usable) when the settings table is missing', async () => {
    const supabase = createMockSupabase({ overrides: { 'user_settings:select': { data: null, error: { message: 'missing' } } } });
    const app = await signedIn({ supabase });
    expect(app.document.getElementById('loanSubmit').disabled).toBe(true);
    expect(app.document.getElementById('goalSubmit').disabled).toBe(true);
    expect(app.text('loanBalance')).toBe('70000.00 DHS');
  });
});

describe('savings sub-targets', () => {
  const milestones = [
    { id: 'm1', name: 'Emergency <i>fund</i>', amount: '5000' },
    { id: 'm2', name: 'Holiday', amount: '15000' },
  ];
  const withSavings = (amount = '6000') => createMockSupabase({
    tables: { savings_milestones: milestones, savings_records: [{ id: 's1', month: '2026-01', amount }] },
  });

  it('shows reached and upcoming sub-targets, escaped, with markers on the progress bar', async () => {
    const app = await signedIn({ supabase: withSavings() });
    const items = app.document.querySelectorAll('#milestoneList .milestone');
    expect(items).toHaveLength(2);
    expect(items[0].classList.contains('done')).toBe(true);
    expect(items[1].classList.contains('done')).toBe(false);
    expect(app.document.querySelector('#milestoneList i')).toBeNull();
    expect(app.document.querySelectorAll('#savingsProgressBar .marker')).toHaveLength(2);
    expect(app.text('nextMilestone')).toContain('Holiday');
    expect(app.text('nextMilestone')).toContain('9000.00 DHS to go');
    expect(app.text('dashNextMilestone')).toContain('Holiday');
  });

  it('says so when every sub-target is reached', async () => {
    const app = await signedIn({ supabase: withSavings('16000') });
    expect(app.text('nextMilestone')).toContain('All reached');
  });

  it('adds a sub-target below the main target', async () => {
    const app = await signedIn();
    app.setValue('milestoneName', ' Phase 1 ');
    app.setValue('milestoneAmount', '8000');
    await app.window.addMilestone();
    const [insert] = app.supabase.ops('savings_milestones', 'insert');
    expect(insert.payload).toEqual([{ user_id: USER.id, name: 'Phase 1', amount: 8000 }]);
  });

  it.each([['', '100'], ['A', ''], ['A', '0'], ['A', '26000'], ['A', '30000']])('rejects sub-target name=%j amount=%j', async (name, amount) => {
    const app = await signedIn();
    app.setValue('milestoneName', name);
    app.setValue('milestoneAmount', amount);
    await app.window.addMilestone();
    expect(app.supabase.ops('savings_milestones', 'insert')).toHaveLength(0);
    expect(app.window.alert).toHaveBeenCalled();
  });

  it('edits a sub-target in place', async () => {
    const app = await signedIn({ supabase: withSavings() });
    app.window.editMilestone('m2');
    expect(app.document.getElementById('milestoneSubmit').textContent).toBe('Update sub-target');
    app.setValue('milestoneAmount', '16000');
    await app.window.addMilestone();
    const [up] = app.supabase.ops('savings_milestones', 'update');
    expect(up.payload).toEqual({ name: 'Holiday', amount: 16000 });
    expect(up.filters).toEqual({ id: 'm2', user_id: USER.id });
    expect(app.supabase.ops('savings_milestones', 'insert')).toHaveLength(0);
  });

  it('deletes a sub-target scoped to id and user', async () => {
    const app = await signedIn({ supabase: withSavings() });
    await app.window.deleteMilestone('m1');
    expect(app.supabase.ops('savings_milestones', 'delete')[0].filters).toEqual({ id: 'm1', user_id: USER.id });
  });

  it('keeps working (feature disabled) when the table does not exist yet', async () => {
    const supabase = createMockSupabase({ overrides: { 'savings_milestones:select': { data: null, error: { message: 'missing' } } } });
    const app = await signedIn({ supabase });
    expect(app.document.getElementById('milestoneSubmit').disabled).toBe(true);
    expect(app.text('milestoneEmpty')).toContain('migration');
  });
});

describe('resetting records', () => {
  const rental = [{ id: 'r1', month: '2026-01', income: '100', expense: '0', expense_description: 'N/A' }];
  const savings = [{ id: 's1', month: '2026-01', amount: '2000' }, { id: 's2', month: '2026-02', amount: '2000' }];

  it("deletes all of the user's rental records after confirmation", async () => {
    const app = await signedIn({ supabase: createMockSupabase({ tables: { rental_records: rental } }) });
    await app.window.resetRentalRecords();
    expect(app.window.confirm).toHaveBeenCalledWith(expect.stringContaining('1 rental records'));
    expect(app.supabase.ops('rental_records', 'delete')[0].filters).toEqual({ user_id: USER.id });
  });

  it("deletes all of the user's savings records but not the sub-targets", async () => {
    const app = await signedIn({ supabase: createMockSupabase({ tables: { savings_records: savings } }) });
    await app.window.resetSavingsRecords();
    expect(app.window.confirm).toHaveBeenCalledWith(expect.stringContaining('2 savings records'));
    expect(app.supabase.ops('savings_records', 'delete')[0].filters).toEqual({ user_id: USER.id });
    expect(app.supabase.ops('savings_milestones', 'delete')).toHaveLength(0);
  });

  it('does nothing when the user cancels', async () => {
    const app = await signedIn({ supabase: createMockSupabase({ tables: { rental_records: rental, savings_records: savings } }), confirmResult: false });
    await app.window.resetRentalRecords();
    await app.window.resetSavingsRecords();
    expect(app.supabase.ops('rental_records', 'delete')).toHaveLength(0);
    expect(app.supabase.ops('savings_records', 'delete')).toHaveLength(0);
  });

  it('disables the reset buttons when there is nothing to reset', async () => {
    const app = await signedIn();
    expect(app.document.getElementById('resetRentalBtn').disabled).toBe(true);
    expect(app.document.getElementById('resetSavingsBtn').disabled).toBe(true);
    await app.window.resetRentalRecords();
    expect(app.window.confirm).not.toHaveBeenCalled();
  });

  it('reports reset errors', async () => {
    const supabase = createMockSupabase({ tables: { rental_records: rental }, overrides: { 'rental_records:delete': { data: null, error: { message: 'denied' } } } });
    const app = await signedIn({ supabase });
    await app.window.resetRentalRecords();
    expect(app.window.alert).toHaveBeenCalledWith(expect.stringContaining('denied'));
  });
});

describe('busy state', () => {
  it('does not re-enable buttons the app disabled on purpose when an action finishes', async () => {
    // user_settings table missing => the loan/target buttons are disabled by the app
    const supabase = createMockSupabase({ overrides: { 'user_settings:select': { data: null, error: { message: 'missing' } } } });
    const app = await signedIn({ supabase });
    expect(app.document.getElementById('loanSubmit').disabled).toBe(true);
    app.setValue('rentalMonth', '2026-03');
    app.setValue('rentalIncome', '100');
    await app.window.addRentalRecord(); // runs inside withBusy
    expect(app.document.getElementById('loanSubmit').disabled).toBe(true);
    expect(app.document.getElementById('goalSubmit').disabled).toBe(true);
  });

  it('marks the page busy while a request runs and clears it afterwards', async () => {
    const app = await signedIn({ supabase: createMockSupabase({ delay: 30 }) });
    app.setValue('generalDesc', 'Coffee');
    app.setValue('generalAmount', '5');
    const pending = app.window.addGeneralTransaction();
    expect(app.document.body.classList.contains('is-busy')).toBe(true);
    await pending;
    expect(app.document.body.classList.contains('is-busy')).toBe(false);
    expect(app.document.body.hasAttribute('aria-busy')).toBe(false);
  });
});
