import { describe, it, expect } from 'vitest';
import { createMockSupabase, loadApp, USER } from './helpers.js';

const ADMIN_RPC = {
  is_admin: { data: true, error: null },
  admin_overview: { data: { total_accounts: 42, new_accounts_30d: 5 }, error: null },
};

const SETTINGS_ROW = {
  id: true,
  maintenance_mode: false,
  maintenance_message: '',
  announcement: '',
  signups_enabled: true,
  default_loan_amount: '70000',
  default_savings_target: '26000',
};

const settingsWith = (extra) => ({ app_settings: [{ ...SETTINGS_ROW, ...extra }] });

async function signedIn(opts) {
  const app = await loadApp(opts);
  await app.login();
  return app;
}

describe('admin detection', () => {
  it('hides the admin tab for ordinary users', async () => {
    const app = await signedIn();
    expect(app.document.getElementById('adminTab').hidden).toBe(true);
    expect(app.state('isAdmin')).toBe(false);
  });

  it('shows the admin tab for admins', async () => {
    const app = await signedIn({ supabase: createMockSupabase({ rpc: ADMIN_RPC }) });
    expect(app.document.getElementById('adminTab').hidden).toBe(false);
  });

  it('treats an rpc error as "not admin"', async () => {
    const supabase = createMockSupabase({ rpc: { is_admin: { data: null, error: { message: 'boom' } } } });
    const app = await signedIn({ supabase });
    expect(app.document.getElementById('adminTab').hidden).toBe(true);
  });

  it('forgets admin rights on logout', async () => {
    const app = await signedIn({ supabase: createMockSupabase({ rpc: ADMIN_RPC }) });
    await app.window.logoutUser();
    expect(app.document.getElementById('adminTab').hidden).toBe(true);
    expect(app.state('isAdmin')).toBe(false);
  });
});

describe('owner console', () => {
  async function adminApp(tables = settingsWith({}), extra = {}) {
    const app = await signedIn({ supabase: createMockSupabase({ rpc: ADMIN_RPC, tables, ...extra }) });
    await app.window.refreshAdminConsole();
    return app;
  }

  it('shows aggregate counts only', async () => {
    const app = await adminApp();
    expect(app.text('adminTotalAccounts')).toBe('42');
    expect(app.text('adminNewAccounts')).toBe('5');
  });

  it('never queries any user-content table from the console', async () => {
    const app = await adminApp();
    const before = app.supabase.calls.length;
    await app.window.refreshAdminConsole();
    const touched = new Set(app.supabase.calls.slice(before).map((c) => c.table));
    expect([...touched]).toEqual(['admin_audit_log']);
  });

  it('fills the form from the current settings', async () => {
    const app = await adminApp(settingsWith({ announcement: 'Hello', signups_enabled: false, default_loan_amount: '50000' }));
    expect(app.document.getElementById('adminAnnouncement').value).toBe('Hello');
    expect(app.document.getElementById('adminSignups').checked).toBe(false);
    expect(app.document.getElementById('adminDefaultLoan').value).toBe('50000');
  });

  it('saves the settings with an update of the single settings row', async () => {
    const app = await adminApp();
    app.document.getElementById('adminMaintenance').checked = true;
    app.setValue('adminMaintenanceMessage', ' Back at 6pm ');
    app.document.getElementById('adminSignups').checked = false;
    app.setValue('adminAnnouncement', 'Update on Sunday');
    app.setValue('adminDefaultLoan', '80000');
    app.setValue('adminDefaultTarget', '30000');
    await app.window.saveAppSettings();
    const [up] = app.supabase.ops('app_settings', 'update');
    expect(up.payload).toEqual({
      maintenance_mode: true,
      maintenance_message: 'Back at 6pm',
      signups_enabled: false,
      announcement: 'Update on Sunday',
      default_loan_amount: 80000,
      default_savings_target: 30000,
    });
    expect(up.filters).toEqual({ id: true });
    expect(app.document.getElementById('registerBtn').hidden).toBe(true);
    expect(app.text('announcement')).toBe('Update on Sunday');
  });

  it.each([['0', '100'], ['-1', '100'], ['', '100'], ['100', '0'], ['100', '']])('rejects defaults loan=%j target=%j', async (loan, target) => {
    const app = await adminApp();
    app.setValue('adminDefaultLoan', loan);
    app.setValue('adminDefaultTarget', target);
    await app.window.saveAppSettings();
    expect(app.supabase.ops('app_settings', 'update')).toHaveLength(0);
    expect(app.window.alert).toHaveBeenCalled();
  });

  it('reports errors when the database refuses the change', async () => {
    const supabase = createMockSupabase({ rpc: ADMIN_RPC, tables: settingsWith({}), overrides: { 'app_settings:update': { data: null, error: { message: 'RLS' } } } });
    const app = await signedIn({ supabase });
    await app.window.refreshAdminConsole();
    await app.window.saveAppSettings();
    expect(app.window.alert).toHaveBeenCalledWith(expect.stringContaining('RLS'));
  });

  it('does nothing for non-admins even if the function is called directly', async () => {
    const app = await signedIn({ supabase: createMockSupabase({ tables: settingsWith({}) }) });
    await app.window.saveAppSettings();
    expect(app.supabase.ops('app_settings', 'update')).toHaveLength(0);
  });

  it('renders the audit log as text', async () => {
    const log = [{ id: 1, admin_id: 'a', action: 'update_app_settings', details: { changed: ['announcement', '<img src=x>'] }, created_at: '2026-10-17T10:00:00Z' }];
    const app = await adminApp({ ...settingsWith({}), admin_audit_log: log });
    expect(app.document.querySelector('#auditTable img')).toBeNull();
    expect(app.text('auditTable')).toContain('update_app_settings');
    expect(app.text('auditTable')).toContain('announcement');
  });

  it('says so when the audit log is empty', async () => {
    const app = await adminApp();
    expect(app.text('auditTable')).toContain('No changes recorded yet');
  });
});

describe('app-wide settings for everyone', () => {
  it('shows the announcement on the login screen, as text', async () => {
    const app = await loadApp({ supabase: createMockSupabase({ tables: settingsWith({ announcement: '<b>Maintenance</b> Sunday' }) }) });
    expect(app.document.getElementById('announcement').hidden).toBe(false);
    expect(app.document.querySelector('#announcement b')).toBeNull();
    expect(app.text('announcement')).toBe('<b>Maintenance</b> Sunday');
  });

  it('hides the banner when there is no announcement', async () => {
    const app = await loadApp({ supabase: createMockSupabase({ tables: settingsWith({}) }) });
    expect(app.document.getElementById('announcement').hidden).toBe(true);
  });

  it('hides "Create Account" when sign-ups are closed', async () => {
    const app = await loadApp({ supabase: createMockSupabase({ tables: settingsWith({ signups_enabled: false }) }) });
    expect(app.document.getElementById('registerBtn').hidden).toBe(true);
  });

  it('keeps the built-in defaults when the table is missing', async () => {
    const supabase = createMockSupabase({ overrides: { 'app_settings:select': { data: null, error: { message: 'missing' } } } });
    const app = await loadApp({ supabase });
    expect(app.document.getElementById('registerBtn').hidden).toBe(false);
    expect(app.document.getElementById('announcement').hidden).toBe(true);
  });

  it('shows the maintenance screen to ordinary users and loads none of their data', async () => {
    const supabase = createMockSupabase({ tables: settingsWith({ maintenance_mode: true, maintenance_message: 'Back at 6pm' }) });
    const app = await signedIn({ supabase });
    expect(app.document.getElementById('maintenanceScreen').style.display).toBe('block');
    expect(app.document.getElementById('mainApp').style.display).toBe('none');
    expect(app.text('maintenanceText')).toBe('Back at 6pm');
    expect(app.supabase.ops('general_transactions', 'select')).toHaveLength(0);
  });

  it('lets admins into the app during maintenance', async () => {
    const supabase = createMockSupabase({ rpc: ADMIN_RPC, tables: settingsWith({ maintenance_mode: true }) });
    const app = await signedIn({ supabase });
    expect(app.document.getElementById('mainApp').style.display).toBe('block');
    expect(app.document.getElementById('maintenanceScreen').style.display).toBe('none');
  });

  it('uses the owner-defined defaults for users without their own loan or target', async () => {
    const supabase = createMockSupabase({ tables: settingsWith({ default_loan_amount: '50000', default_savings_target: '12000' }) });
    const app = await signedIn({ supabase });
    expect(app.state('loanAmount')).toBe(50000);
    expect(app.state('savingsTarget')).toBe(12000);
    expect(app.text('loanBalance')).toBe('50000.00 DHS');
  });

  it("a user's own settings win over the defaults", async () => {
    const supabase = createMockSupabase({
      tables: {
        ...settingsWith({ default_loan_amount: '50000' }),
        user_settings: [{ user_id: USER.id, loan_amount: '20000', savings_target: '9000' }],
      },
    });
    const app = await signedIn({ supabase });
    expect(app.state('loanAmount')).toBe(20000);
    expect(app.state('savingsTarget')).toBe(9000);
  });
});
