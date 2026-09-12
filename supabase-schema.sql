-- ========================================================================
-- Mamzouka Stream — Free remote-control database (Supabase, free tier)
-- ========================================================================
-- HOW TO USE (5 minutes, free):
--  1. Create a free account at https://supabase.com (no credit card).
--  2. New project → open SQL Editor → paste this whole file → Run.
--  3. Go to Project Settings → API → copy:
--       Project URL  → paste into src/remote-config.js (supabaseUrl)
--       anon public key → paste into src/remote-config.js (supabaseAnonKey)
--  4. To control the app remotely, edit the row in:
--       Table Editor → remote_config → id = 1 → config (JSON)
--     Changes apply to all users within ~15 minutes (cache TTL), no rebuild.
--  5. Keep the GitHub raw JSON as automatic fallback (works even if you
--     never create Supabase — movies/ads keep working out of the box).
-- ========================================================================

create table if not exists public.remote_config (
  id bigint primary key,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Single-row remote control document
insert into public.remote_config (id, config)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- Public read-only: anyone with the anon key can READ, nobody can WRITE
-- (writes only with the secret service_role key from Supabase dashboard).
alter table public.remote_config enable row level security;

drop policy if exists "public read" on public.remote_config;
create policy "public read"
  on public.remote_config
  for select
  using (true);

-- ========================================================================
-- LAYER 2 — device ban list (enforced inside the Rust backend, unbypassable
-- from the UI: even a fully rewritten frontend gets zero content while the
-- device hash is listed here).
-- To ban a device: Table Editor → bans → Insert row → device_hash = the
-- 64-hex string (ask the user to send it, or read it from your logs if you
-- log policy errors), reason = free text.
-- To unban: delete the row. Cache TTL on devices: ~10 minutes.
-- ========================================================================
create table if not exists public.bans (
  device_hash text primary key,
  reason text not null default '',
  created_at timestamptz not null default now()
);

alter table public.bans enable row level security;

drop policy if exists "public read" on public.bans;
create policy "public read"
  on public.bans
  for select
  using (true);

-- ========================================================================
-- EXAMPLE config JSON (paste into the `config` column to start):
-- ========================================================================
-- {
--   "update": {
--     "enabled": true,
--     "forceLock": false,
--     "expiryDate": "2027-01-01",
--     "telegramUrl": "https://t.me/mamzouka_official",
--     "currentVersion": "1.0.0",
--     "newVersion": "2.0.0",
--     "titleAr": "تحديث إجباري متوفر",
--     "messageAr": "حمّل النسخة الجديدة من تيليغرام"
--   },
--   "ads": {
--     "preroll": { "enabled": true, "skipDelaySeconds": 5,
--                  "videoUrl": "https://vjs.zencdn.net/v/oceans.mp4" },
--     "popunder": { "enabled": true, "frequencyHours": 24,
--                   "url": "https://t.me/mamzouka_official" },
--     "excludedCountries": []
--   },
--   "announcement": {
--     "enabled": false,
--     "textEn": "New 4K servers added!",
--     "textFr": "Nouveaux serveurs 4K !",
--     "textAr": "تمت إضافة سيرفرات 4K!",
--     "link": "https://t.me/mamzouka_official"
--   },
--   "providers": {
--     "vidsrc": true, "vidlink": true, "smashy": true,
--     "embedsu": true, "autoembed": true, "embed2": true,
--     "torrentio": true, "yts": true
--   },
--   "endpoints": {
--     "torrentio_base": "https://torrentio.strem.fun",
--     "engine_node_url": "https://github.com/.../releases/download/engine-v1/node.exe",
--     "engine_zip_url": "https://github.com/.../releases/download/engine-v1/mamzouka-engine.zip",
--     "ffmpeg_url": "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
--   },
--   "tmdb": { "api_key": "" },
--   "limits": { "minSeeders": 0, "maxFailover": 3 }
-- }
--
-- FIELD GUIDE:
--  update.*            → force update / expiry / telegram link (kill switch)
--  ads.*               → preroll video, skip delay, popunder, excluded countries
--  announcement.*      → top banner inside the app (per language + link)
--  providers.* = false → hide a broken source everywhere, no rebuild needed
--  endpoints.torrentio_base → switch Torrentio mirror if the main one dies
--  tmdb.api_key        → rotate the movies catalog key for ALL users at once
--                        (only used when the user kept the default key)
--  limits.minSeeders   → reserved: hide torrents below N seeders (0 = show all)
-- ========================================================================
