// ==========================================================================
// Mamzouka Stream - Remote Control client (free DB + fallback)
// Source order: Supabase (live DB) → GitHub raw JSON → {} (local defaults)
// Cached on device for cacheTtlMin. Never throws — always resolves {}.
// Loaded AFTER remote-config.js, BEFORE main.js.
// ==========================================================================
(function () {
  const cfg = (typeof window !== 'undefined' && window.MAMZOUKA_REMOTE) || {};
  const CACHE_KEY = 'mamzouka_remote_cache_v1';
  let memCache = null;

  function getCached() {
    if (memCache && Date.now() - memCache.ts < ttlMs()) return memCache.data;
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.data && Date.now() - parsed.ts < ttlMs()) {
        memCache = parsed;
        return parsed.data;
      }
    } catch {}
    return null;
  }

  function ttlMs() {
    const m = parseInt(cfg.cacheTtlMin, 10);
    return (isNaN(m) ? 15 : m) * 60 * 1000;
  }

  function setCached(data) {
    memCache = { data, ts: Date.now() };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(memCache)); } catch {}
  }

  async function fetchJson(url, headers) {
    const timeout = parseInt(cfg.fetchTimeoutMs, 10) || 4000;
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctl.signal, headers: headers || {} });
      clearTimeout(tid);
      if (!res.ok) throw new Error('http ' + res.status);
      return await res.json();
    } catch (e) {
      clearTimeout(tid);
      throw e;
    }
  }

  async function fetchSupabase() {
    const base = (cfg.supabaseUrl || '').replace(/\/$/, '');
    const key = cfg.supabaseAnonKey || '';
    if (!base || !key) throw new Error('supabase not configured');
    const table = cfg.supabaseTable || 'remote_config';
    const id = cfg.supabaseRowId != null ? cfg.supabaseRowId : 1;
    const url = `${base}/rest/v1/${encodeURIComponent(table)}?id=eq.${encodeURIComponent(id)}&select=config`;
    const rows = await fetchJson(url, { apikey: key, Authorization: 'Bearer ' + key });
    if (Array.isArray(rows) && rows[0] && rows[0].config && typeof rows[0].config === 'object') {
      return rows[0].config;
    }
    throw new Error('empty row');
  }

  async function fetchGithub() {
    const url = cfg.githubUrl || (window.MAMZOUKA_UPDATE_CONFIG || {}).remoteConfigUrl || '';
    if (!url) throw new Error('no github url');
    return await fetchJson(url);
  }

  async function refresh() {
    // 1) Supabase live DB
    try {
      const data = await fetchSupabase();
      setCached(data);
      console.log('[RemoteControl] live config from Supabase');
      return data;
    } catch (e) {
      console.log('[RemoteControl] supabase miss:', (e && e.message) || e);
    }
    // 2) GitHub fallback (works with zero setup)
    try {
      const data = await fetchGithub();
      setCached(data);
      console.log('[RemoteControl] config from GitHub fallback');
      return data;
    } catch (e) {
      console.log('[RemoteControl] github miss:', (e && e.message) || e);
    }
    // 3) Stale cache is better than nothing (any age)
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.data) {
          console.log('[RemoteControl] using stale cache');
          return parsed.data;
        }
      }
    } catch {}
    return {};
  }

  async function ensure() {
    const hit = getCached();
    if (hit) return hit;
    return refresh();
  }

  function get(path, fallback) {
    try {
      const data = (memCache && memCache.data) || null;
      if (!data) return fallback;
      const parts = String(path).split('.');
      let cur = data;
      for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return fallback;
        cur = cur[p];
      }
      return cur === undefined ? fallback : cur;
    } catch {
      return fallback;
    }
  }

  window.RemoteControl = { refresh, ensure, get, all: () => ((memCache && memCache.data) || {}) };
})();
