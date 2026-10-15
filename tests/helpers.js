import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { vi } from 'vitest';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

export const USER = { id: 'user-1', email: 'me@example.com' };

/**
 * In-memory stand-in for the supabase-js client. No network, no database.
 * `tables` seeds rows returned by select(); `overrides['table:op']` replaces the
 * result of an operation (select/insert/upsert/update/delete), e.g. to simulate errors.
 * Every operation is recorded in `calls`.
 */
export function createMockSupabase({ tables = {}, overrides = {}, delay = 0, session = null, rpc = {} } = {}) {
  const calls = [];
  const authListeners = [];

  function builder(table) {
    const call = { table, op: 'select', payload: null, options: null, filters: {} };
    calls.push(call);
    const b = {
      select: () => b,
      insert: (payload) => ((call.op = 'insert'), (call.payload = payload), b),
      upsert: (payload, options) => ((call.op = 'upsert'), (call.payload = payload), (call.options = options), b),
      update: (payload) => ((call.op = 'update'), (call.payload = payload), b),
      delete: () => ((call.op = 'delete'), b),
      eq: (col, val) => ((call.filters[col] = val), b),
      order: () => b,
      limit: () => b,
      then(resolve, reject) {
        const result = overrides[`${table}:${call.op}`] ??
          { data: call.op === 'select' ? (tables[table] ?? []) : null, error: null };
        return new Promise((r) => setTimeout(r, delay)).then(() => result).then(resolve, reject);
      },
    };
    return b;
  }

  const client = {
    from: (table) => builder(table),
    rpc: vi.fn(async (name) => rpc[name] ?? { data: null, error: null }),
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn((cb) => {
        authListeners.push(cb);
        return { data: { subscription: { unsubscribe() {} } } };
      }),
      signUp: vi.fn(async () => ({ data: {}, error: null })),
      signInWithPassword: vi.fn(async () => ({ data: { user: USER }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  };

  const emitAuth = (event, sess = null) => authListeners.forEach((cb) => cb(event, sess));

  return { client, calls, emitAuth, ops: (table, op) => calls.filter((c) => c.table === table && c.op === op) };
}

/** Loads index.html in jsdom with the CDN libraries and config replaced by mocks. */
export async function loadApp({ supabase = createMockSupabase(), config = { url: 'http://mock', anonKey: 'mock' }, confirmResult = true, lastActive = null } = {}) {
  const virtualConsole = new VirtualConsole(); // swallow expected errors (e.g. missing config)
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', // external <script src> are not fetched: libraries are mocked below
    pretendToBeVisual: true,
    virtualConsole,
    url: 'http://localhost/',
    beforeParse(window) {
      if (config) window.SUPABASE_CONFIG = config;
      window.supabase = { createClient: () => supabase.client };
      window.Chart = class { destroy() {} };
      if (lastActive !== null) window.localStorage.setItem('ft_last_active', String(lastActive));
      window.alert = vi.fn();
      window.confirm = vi.fn(() => confirmResult);
    },
  });
  const { window } = dom;
  // Let the DOMContentLoaded handler finish: wait for its first request, then a few more ticks
  for (let i = 0; config && i < 200 && !supabase.calls.some((c) => c.table === 'app_settings'); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 15));

  const app = {
    window,
    document: window.document,
    supabase,
    /** Read a top-level `let` variable of the page script (not exposed on window). */
    state: (name) => window.eval(name),
    setValue(id, value) { window.document.getElementById(id).value = value; },
    text: (id) => window.document.getElementById(id).textContent,
    async login() {
      app.setValue('authEmail', USER.email);
      app.setValue('authPassword', 'x');
      await window.loginUser();
    },
  };
  return app;
}
