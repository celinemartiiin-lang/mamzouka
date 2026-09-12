// ========================================================================
// MAMZOUKA STREAM - REMOTE CONTROL CONNECTION SETTINGS
// ========================================================================
// Priority:  1) Supabase (free DB, you control everything live)
//            2) GitHub raw JSON (automatic fallback, zero setup)
//            3) Built-in local defaults (ads-config.js / update-config.js)
//
// Movies work out of the box for anyone: default TMDB key + public
// Torrentio/YTS/IPTV endpoints are baked in. Remote only OVERRIDES them.
//
// To go live with Supabase (free, 5 min):
//  1. Run supabase-schema.sql in your free Supabase project.
//  2. Paste Project URL + anon key below, rebuild once.
//  3. From then on, edit Table Editor → remote_config → id=1 → config.
//
// Remote endpoints.* keys the app understands (all optional):
//  torrentio_base, engine_node_url, engine_zip_url, ffmpeg_url
// ========================================================================

window.MAMZOUKA_REMOTE = {
  // Free Supabase project (empty = skip, use GitHub fallback only)
  supabaseUrl: 'https://tbldjsdysejvwtgdtshu.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRibGRqc2R5c2Vqdnd0Z2R0c2h1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwNDk4OTQsImV4cCI6MjEwNDYyNTg5NH0.qCwlclUXlB7HCSz-H9Dy8uTNtXLUsPxiu56cGN6pjjg',
  supabaseTable: 'remote_config',
  supabaseRowId: 1,

  // Automatic fallback — public JSON, works with no account at all
  githubUrl: 'https://raw.githubusercontent.com/mamzouka/mamzouka-remote-config/main/mamzouka-remote-config.json',

  // How long to cache remote config on the device (minutes)
  cacheTtlMin: 15,

  // Per-request timeout (ms)
  fetchTimeoutMs: 4000,
};
