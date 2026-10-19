/*
 * In-browser fake of the parts of supabase-js and Chart.js that the app uses, so the Robot Framework
 * end-to-end tests can drive the real index.html with no backend, no network and no real accounts.
 * Test data lives in localStorage (so a page reload keeps the session and the records, like the real app).
 *
 * All credentials below are fake test fixtures.
 */
(function () {
  'use strict';

  window.SUPABASE_CONFIG = { url: 'http://mock.local', anonKey: 'mock-anon-key' };

  // Charts are not what these tests check; a stub keeps them fast and independent of the CDN.
  window.Chart = class {
    destroy() {}
  };

  var DB_KEY = 'mock_db';
  var SESSION_KEY = 'mock_session';
  var OWNER_EMAIL = 'owner@example.com';

  var USERS = {
    'user@example.com': { id: 'u-user', password: 'correct-horse-battery' },
    'owner@example.com': { id: 'u-owner', password: 'correct-horse-battery' },
    'legacy@example.com': { id: 'u-legacy', password: 'abc' } // an old account with a short password
  };

  var DEFAULT_DB = {
    app_settings: [{
      id: true, maintenance_mode: false, maintenance_message: '', announcement: '', signups_enabled: true,
      default_loan_amount: 70000, default_savings_target: 26000
    }],
    ai_model_settings: [{
      id: true, enabled: true, primary_model: 'llama-3.3-70b-versatile', fallback_model: 'llama-3.1-8b-instant',
      temperature: 0.4, max_tokens: 600, timeout_seconds: 20, max_users_per_run: 20, delay_ms: 2500
    }],
    admin_audit_log: []
  };

  // Columns that must be unique per table, like the real database constraints
  var UNIQUE = {
    rental_records: ['user_id', 'month'],
    savings_records: ['user_id', 'month'],
    savings_milestones: ['user_id', 'amount'],
    transaction_templates: ['user_id', 'description', 'type']
  };

  function load() {
    try {
      var raw = localStorage.getItem(DB_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through to defaults */ }
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }

  var db = load();

  function save() {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(16).slice(2) + Date.now();
  }

  function currentSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  var listeners = [];
  function emit(event, session) {
    listeners.forEach(function (cb) { cb(event, session); });
  }

  function rowsOf(name) {
    if (!db[name]) db[name] = [];
    return db[name];
  }

  function matches(row, filters) {
    return Object.keys(filters).every(function (col) { return row[col] === filters[col]; });
  }

  function conflicts(name, row, cols) {
    return rowsOf(name).find(function (existing) {
      return cols.every(function (c) { return String(existing[c]) === String(row[c]); });
    });
  }

  function builder(name) {
    var state = { op: 'select', payload: null, options: null, filters: {}, orderBy: null, max: null, single: false };
    var b = {
      select: function () { return b; },
      insert: function (payload) { state.op = 'insert'; state.payload = payload; return b; },
      upsert: function (payload, options) { state.op = 'upsert'; state.payload = payload; state.options = options || {}; return b; },
      update: function (payload) { state.op = 'update'; state.payload = payload; return b; },
      delete: function () { state.op = 'delete'; return b; },
      eq: function (col, val) { state.filters[col] = val; return b; },
      order: function (col, opts) { state.orderBy = { col: col, asc: !opts || opts.ascending !== false }; return b; },
      limit: function (n) { state.max = n; return b; },
      maybeSingle: function () { state.single = true; return b; },
      then: function (resolve, reject) {
        return Promise.resolve().then(function () { return run(name, state); }).then(resolve, reject);
      }
    };
    return b;
  }

  function run(name, state) {
    var rows = rowsOf(name);
    var out;

    if (state.op === 'select') {
      out = rows.filter(function (r) { return matches(r, state.filters); }).map(function (r) { return Object.assign({}, r); });
      if (state.orderBy) {
        var o = state.orderBy;
        out.sort(function (a, c) {
          var x = a[o.col], y = c[o.col];
          var cmp = x < y ? -1 : x > y ? 1 : 0;
          return o.asc ? cmp : -cmp;
        });
      }
      if (state.max !== null) out = out.slice(0, state.max);
      return { data: state.single ? (out[0] || null) : out, error: null };
    }

    if (state.op === 'insert' || state.op === 'upsert') {
      var inserted = [];
      var items = Array.isArray(state.payload) ? state.payload : [state.payload];
      for (var i = 0; i < items.length; i++) {
        var item = Object.assign({}, items[i]);
        var cols = state.op === 'upsert' && state.options.onConflict ? state.options.onConflict.split(',') : null;
        var existing = cols ? conflicts(name, item, cols) : null;
        if (existing) {
          Object.assign(existing, item);
          inserted.push(existing);
          continue;
        }
        if (UNIQUE[name] && conflicts(name, item, UNIQUE[name])) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint on ' + name } };
        }
        if (item.id === undefined && name !== 'user_settings' && name !== 'ai_advice_settings') item.id = uuid();
        if (!item.created_at) item.created_at = new Date().toISOString();
        rows.push(item);
        inserted.push(item);
      }
      save();
      return { data: inserted, error: null };
    }

    if (state.op === 'update') {
      rows.forEach(function (r) { if (matches(r, state.filters)) Object.assign(r, state.payload); });
      save();
      return { data: null, error: null };
    }

    if (state.op === 'delete') {
      db[name] = rows.filter(function (r) { return !matches(r, state.filters); });
      save();
      return { data: null, error: null };
    }

    return { data: null, error: { message: 'unsupported operation' } };
  }

  function isOwner() {
    var s = currentSession();
    return !!s && s.user.email === OWNER_EMAIL;
  }

  var SAMPLE_METRICS = {
    days: 30,
    totals: { calls: 12, ok_calls: 10, fallback_calls: 3, prompt_tokens: 4800, completion_tokens: 2400, total_tokens: 7200, avg_latency_ms: 850 },
    by_model: [
      { model: 'llama-3.3-70b-versatile', calls: 9, ok_calls: 6, error_calls: 3, fallback_calls: 0, avg_latency_ms: 900, p95_latency_ms: 1500, prompt_tokens: 3600, completion_tokens: 1800, total_tokens: 5400 },
      { model: 'llama-3.1-8b-instant', calls: 3, ok_calls: 3, error_calls: 0, fallback_calls: 3, avg_latency_ms: 300, p95_latency_ms: 400, prompt_tokens: 1200, completion_tokens: 600, total_tokens: 1800 }
    ],
    daily: [{ day: '2026-10-02', calls: 12, ok_calls: 10, total_tokens: 7200 }],
    recent_errors: [{ created_at: '2026-10-02T06:00:00Z', kind: 'advice', model: 'llama-3.3-70b-versatile', role: 'primary', http_status: 429, error_kind: 'rate_limited', latency_ms: 120 }],
    last_run: { started_at: '2026-10-02T06:00:00Z', finished_at: '2026-10-02T06:01:00Z', period: '2026-10', status: 'partial', processed: 9, skipped_invalid: 0, failed: 3, remaining: 4, stopped_early: true, duration_ms: 61500 },
    last_health: []
  };

  var client = {
    from: builder,

    rpc: function (name) {
      return Promise.resolve().then(function () {
        if (name === 'is_admin') return { data: isOwner(), error: null };
        if (!isOwner()) return { data: null, error: { message: 'not authorized' } };
        if (name === 'admin_overview') return { data: { total_accounts: Object.keys(USERS).length, new_accounts_30d: 1 }, error: null };
        if (name === 'ai_advice_metrics') return { data: SAMPLE_METRICS, error: null };
        return { data: null, error: { message: 'unknown function' } };
      });
    },

    functions: {
      invoke: function (name) {
        return Promise.resolve().then(function () {
          if (name === 'ai-advice') {
            var rows = rowsOf('ai_advice_cache').slice().sort(function (a, b) { return a.period < b.period ? 1 : -1; });
            var latest = rows[0];
            return { data: latest ? { advice: latest.advice, period: latest.period, generated_at: latest.created_at } : { advice: null }, error: null };
          }
          if (name === 'ai-advice-health') {
            if (!isOwner()) return { data: null, error: { message: 'forbidden', context: { status: 403 } } };
            return {
              data: {
                config: { provider_host: 'api.mock-provider.test', api_key_configured: true, cron_secret_configured: true, primary_model: 'llama-3.3-70b-versatile', fallback_model: 'llama-3.1-8b-instant', enabled: true },
                results: [
                  { model: 'llama-3.3-70b-versatile', role: 'primary', ok: true, http_status: 200, error_kind: null, latency_ms: 420, prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
                  { model: 'llama-3.1-8b-instant', role: 'fallback', ok: true, http_status: 200, error_kind: null, latency_ms: 180, prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 }
                ]
              },
              error: null
            };
          }
          return { data: null, error: { message: 'not deployed', context: { status: 404 } } };
        });
      }
    },

    auth: {
      getSession: function () {
        return Promise.resolve({ data: { session: currentSession() } });
      },
      onAuthStateChange: function (cb) {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe: function () {} } } };
      },
      signInWithPassword: function (creds) {
        return Promise.resolve().then(function () {
          var user = USERS[creds.email];
          if (!user || user.password !== creds.password) {
            return { data: {}, error: { message: 'Invalid login credentials' } };
          }
          var session = { user: { id: user.id, email: creds.email } };
          localStorage.setItem(SESSION_KEY, JSON.stringify(session));
          emit('SIGNED_IN', session);
          return { data: { user: session.user, session: session }, error: null };
        });
      },
      signUp: function () {
        return Promise.resolve({ data: {}, error: null });
      },
      signOut: function (opts) {
        return Promise.resolve().then(function () {
          if (opts && opts.scope === 'others') return { error: null };
          localStorage.removeItem(SESSION_KEY);
          emit('SIGNED_OUT', null);
          return { error: null };
        });
      }
    }
  };

  window.supabase = { createClient: function () { return client; } };

  // Helpers for the tests (Execute Javascript)
  window.__mock = {
    reset: function () {
      localStorage.removeItem(DB_KEY);
      localStorage.removeItem(SESSION_KEY);
      db = JSON.parse(JSON.stringify(DEFAULT_DB));
    },
    seed: function (table, rows) {
      rowsOf(table).push.apply(rowsOf(table), rows);
      save();
    },
    setSetting: function (table, patch) {
      Object.assign(rowsOf(table)[0], patch);
      save();
    },
    table: function (name) {
      return JSON.parse(JSON.stringify(rowsOf(name)));
    }
  };
})();
