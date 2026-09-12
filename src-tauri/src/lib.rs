pub mod assets;
pub mod downloader;
pub mod livetv;
pub mod policy;
pub mod server;
pub mod storage;
pub mod tmdb;
pub mod torrents;

use std::sync::{Arc, Mutex};
use tauri::State;

static NODE_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

pub fn cleanup_node_child() {
    if let Ok(mut lock) = NODE_CHILD.lock() {
        if let Some(mut child) = lock.take() {
            println!("[Mamzouka] Cleaning up WebTorrent Node child process...");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub struct AppState {
    pub storage: Arc<storage::StorageManager>,
    pub torrents: Arc<torrents::TorrentClient>,
    pub livetv: Arc<livetv::LiveTvManager>,
}

#[tauri::command]
fn get_server_port() -> u16 {
    server::SERVER_PORT.load(std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
async fn get_trending(
    state: State<'_, AppState>,
    media_type: String,
    time_window: String,
    language: Option<String>,
) -> Result<Vec<tmdb::MediaItem>, String> {
    crate::policy::ensure_unlocked().await?;
    let custom_key = state.storage.get_settings().tmdb_api_key;
    let client = tmdb::TmdbClient::new(Some(custom_key));
    client.get_trending(&media_type, &time_window, language.as_deref()).await
}

#[tauri::command]
async fn discover_media(
    state: State<'_, AppState>,
    media_type: String,
    page: u32,
    genre_id: Option<u64>,
    sort_by: Option<String>,
    year: Option<u32>,
    min_rating: Option<f64>,
    country: Option<String>,
    language: Option<String>,
    tmdb_language: Option<String>,
) -> Result<tmdb::MediaListResponse, String> {
    crate::policy::ensure_unlocked().await?;
    let custom_key = state.storage.get_settings().tmdb_api_key;
    let client = tmdb::TmdbClient::new(Some(custom_key));
    client.get_discover(
        &media_type,
        page,
        genre_id,
        sort_by.as_deref(),
        year,
        min_rating,
        country.as_deref(),
        language.as_deref(),
        tmdb_language.as_deref(),
    ).await
}

#[tauri::command]
async fn search_media(
    state: State<'_, AppState>,
    query: String,
    page: u32,
    language: Option<String>,
) -> Result<tmdb::MediaListResponse, String> {
    crate::policy::ensure_unlocked().await?;
    let custom_key = state.storage.get_settings().tmdb_api_key;
    let client = tmdb::TmdbClient::new(Some(custom_key));
    client.search(&query, page, language.as_deref()).await
}

#[tauri::command]
async fn get_media_details(
    state: State<'_, AppState>,
    media_type: String,
    id: u64,
    language: Option<String>,
) -> Result<tmdb::MediaDetails, String> {
    crate::policy::ensure_unlocked().await?;
    let custom_key = state.storage.get_settings().tmdb_api_key;
    let client = tmdb::TmdbClient::new(Some(custom_key));
    client.get_details(&media_type, id, language.as_deref()).await
}

#[tauri::command]
async fn get_season_episodes(
    state: State<'_, AppState>,
    tv_id: u64,
    season_number: u32,
    language: Option<String>,
) -> Result<Vec<tmdb::Episode>, String> {
    crate::policy::ensure_unlocked().await?;
    let custom_key = state.storage.get_settings().tmdb_api_key;
    let client = tmdb::TmdbClient::new(Some(custom_key));
    client.get_season_episodes(tv_id, season_number, language.as_deref()).await
}

#[tauri::command]
async fn get_torrent_streams(
    state: State<'_, AppState>,
    media_type: String,
    imdb_id: String,
    tmdb_id: Option<u64>,
    season: Option<u32>,
    episode: Option<u32>,
    torrentio_base: Option<String>,
    disabled_providers: Option<Vec<String>>,
) -> Result<Vec<torrents::TorrentStream>, String> {
    crate::policy::ensure_unlocked().await?;
    let debrid_key = crate::storage::effective_debrid_key(&state.storage.get_settings().real_debrid_api_key);
    state.torrents.get_streams(&media_type, &imdb_id, tmdb_id, season, episode, debrid_key, torrentio_base, disabled_providers).await
}

#[tauri::command]
fn set_remote_tmdb_key(key: String) -> Result<bool, String> {
    crate::tmdb::set_remote_tmdb_key(key);
    Ok(true)
}

#[tauri::command]
async fn set_remote_source(supabase_url: String, supabase_key: String) -> Result<bool, String> {
    crate::policy::set_remote_source(supabase_url, supabase_key);
    // Warm the policy cache in the background so first content call is fast.
    crate::policy::ensure_unlocked().await.ok();
    Ok(true)
}

#[tauri::command]
async fn get_policy_status() -> Result<serde_json::Value, String> {
    // Read-only verdict for the UI badge; never throws.
    match crate::policy::ensure_unlocked().await {
        Ok(()) => Ok(serde_json::json!({ "locked": false })),
        Err(e) => Ok(serde_json::json!({ "locked": true, "reason": e })),
    }
}

/// First-run / on-demand engine fetch (node.exe + deps zip → per-user dir).
/// The NSIS hook normally does this at install; this is the safety net.
#[tauri::command]
async fn ensure_engine_assets(
    node_url: Option<String>,
    engine_url: Option<String>,
) -> Result<String, String> {
    let dir = crate::assets::ensure_engine_assets(node_url, engine_url)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn engine_status() -> Result<serde_json::Value, String> {
    Ok(crate::assets::engine_status())
}

/// Lazy ffmpeg install (~80MB essentials zip, first Convert only).
/// URL may come from remote endpoints config; defaults to gyan.dev.
#[tauri::command]
async fn download_ffmpeg(url: Option<String>) -> Result<String, String> {
    let zip_url = match url {
        Some(u) if u.starts_with("http") => u,
        _ => "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip".to_string(),
    };
    let path = crate::assets::download_ffmpeg(&zip_url)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn open_in_vlc(stream_url: String) -> Result<bool, String> {
    use std::process::Command;
    let player_paths = [
        r"C:\Program Files\VideoLAN\VLC\vlc.exe",
        r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
        r"C:\Program Files\mpv\mpv.exe",
        r"C:\Program Files (x86)\mpv\mpv.exe",
        r"C:\Program Files\MPC-HC\mpc-hc64.exe",
        r"C:\Program Files (x86)\K-Lite Codec Pack\MPC-HC64\mpc-hc64.exe",
        r"C:\Program Files\DAUM\PotPlayer\PotPlayer64.exe",
        r"C:\Program Files (x86)\DAUM\PotPlayer\PotPlayer.exe",
        "vlc",
        "mpv",
        "potplayer",
    ];

    for path in &player_paths {
        if Command::new(path).arg(&stream_url).spawn().is_ok() {
            return Ok(true);
        }
    }

    let _ = Command::new("cmd")
        .args(["/C", "start", "", &stream_url])
        .spawn();
    Ok(true)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<bool, String> {
    use std::process::Command;
    let _ = Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();
    Ok(true)
}

#[tauri::command]
async fn get_live_channels(
    state: State<'_, AppState>,
    country: Option<String>,
    category: Option<String>,
    query: Option<String>,
) -> Result<Vec<livetv::LiveChannel>, String> {
    crate::policy::ensure_unlocked().await?;
    let custom_playlists = state
        .storage
        .get_custom_iptv()
        .into_iter()
        .filter(|p| p.enabled)
        .map(|p| (p.name, p.url))
        .collect();
    state.livetv.get_channels(country, category, query, custom_playlists).await
}

#[tauri::command]
async fn get_epg(
    state: State<'_, AppState>,
    channel_id: String,
    country: String,
) -> Result<Vec<livetv::EpgProgram>, String> {
    crate::policy::ensure_unlocked().await?;
    Ok(state.livetv.get_epg(&channel_id, &country).await)
}

#[tauri::command]
async fn get_available_categories(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    state.livetv.get_available_categories().await
}

#[tauri::command]
fn get_custom_iptv_playlists(state: State<'_, AppState>) -> Result<Vec<storage::CustomIptvPlaylist>, String> {
    Ok(state.storage.get_custom_iptv())
}

#[tauri::command]
fn add_custom_iptv_playlist(
    state: State<'_, AppState>,
    name: String,
    url: String,
) -> Result<storage::CustomIptvPlaylist, String> {
    state.storage.add_custom_iptv(name, url)
}

#[tauri::command]
fn remove_custom_iptv_playlist(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.storage.remove_custom_iptv(&id)
}

#[tauri::command]
fn get_downloads(state: State<'_, AppState>) -> Result<Vec<storage::DownloadItem>, String> {
    Ok(state.storage.get_downloads())
}

#[tauri::command]
async fn start_download(
    state: State<'_, AppState>,
    item: storage::DownloadItem,
) -> Result<storage::DownloadItem, String> {
    crate::policy::ensure_unlocked().await?;
    downloader::start_background_download(item, state.storage.clone()).await
}

#[tauri::command]
fn delete_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(item) = state.storage.get_downloads().into_iter().find(|d| d.id == id) {
        if !item.file_path.is_empty() {
            let _ = std::fs::remove_file(&item.file_path);
        }
    }
    state.storage.remove_download(&id)
}

#[tauri::command]
fn update_download_file_path(state: State<'_, AppState>, id: String, file_path: String) -> Result<(), String> {
    let mut downloads = state.storage.get_downloads();
    let mut found = false;
    for d in downloads.iter_mut() {
        if d.id == id {
            d.file_path = file_path.clone();
            found = true;
        }
    }
    if !found {
        return Err("Download not found".to_string());
    }
    for d in &downloads {
        if d.id == id {
            let _ = state.storage.add_or_update_download(d.clone());
        }
    }
    Ok(())
}

/// Repair old downloads saved with the wrong extension (MKV bytes as .mp4).
/// Sniffs EBML vs ftyp magic bytes and renames accordingly. Returns new path
/// or "OK:<path>" when already correct.
#[tauri::command]
fn repair_download_container(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let item = state
        .storage
        .get_downloads()
        .into_iter()
        .find(|d| d.id == id)
        .ok_or_else(|| "Download not found".to_string())?;
    if item.file_path.is_empty() {
        return Err("No file saved yet".to_string());
    }
    let data = std::fs::read(&item.file_path).map_err(|e| format!("Cannot read file: {}", e))?;
    if data.len() < 12 {
        return Err("File too small / incomplete — re-download it".to_string());
    }
    let is_ebml = data.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]);
    let is_ftyp = data.len() > 7 && &data[4..8] == b"ftyp";
    let lower = item.file_path.to_lowercase();
    let want_ext: Option<&str> = if is_ebml && !lower.ends_with(".mkv") && !lower.ends_with(".webm") {
        Some("mkv")
    } else if is_ftyp && (lower.ends_with(".mkv") || lower.ends_with(".avi")) {
        Some("mp4")
    } else {
        None
    };
    match want_ext {
        None => Ok(format!("OK:{}", item.file_path)),
        Some(ext) => {
            let mut new_path = std::path::PathBuf::from(&item.file_path);
            new_path.set_extension(ext);
            std::fs::rename(&item.file_path, &new_path)
                .map_err(|e| format!("Rename failed: {}", e))?;
            let new_str = new_path.to_string_lossy().to_string();
            let mut downloads = state.storage.get_downloads();
            for d in downloads.iter_mut() {
                if d.id == id {
                    d.file_path = new_str.clone();
                }
            }
            for d in &downloads {
                if d.id == id {
                    let _ = state.storage.add_or_update_download(d.clone());
                }
            }
            Ok(new_str)
        }
    }
}

#[tauri::command]
fn open_download_folder(file_path: String) -> Result<bool, String> {
    use std::process::Command;
    if !file_path.is_empty() && std::path::Path::new(&file_path).exists() {
        let _ = Command::new("explorer").args(["/select,", &file_path]).spawn();
    } else {
        let dir = downloader::get_downloads_dir();
        let _ = Command::new("explorer").arg(dir).spawn();
    }
    Ok(true)
}

#[tauri::command]
async fn get_subtitles(
    state: State<'_, AppState>,
    imdb_id: String,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<Vec<torrents::SubtitleTrack>, String> {
    crate::policy::ensure_unlocked().await?;
    state.torrents.get_subtitles(&imdb_id, season, episode).await
}

#[tauri::command]
fn get_watchlist(state: State<'_, AppState>) -> Result<Vec<tmdb::MediaItem>, String> {
    let data = state.storage.data.lock().map_err(|e| e.to_string())?;
    Ok(data.watchlist.clone())
}

#[tauri::command]
fn toggle_watchlist(
    state: State<'_, AppState>,
    item: tmdb::MediaItem,
) -> Result<bool, String> {
    state.storage.toggle_watchlist(item)
}

#[tauri::command]
fn is_in_watchlist(
    state: State<'_, AppState>,
    id: u64,
    media_type: String,
) -> Result<bool, String> {
    Ok(state.storage.is_in_watchlist(id, &media_type))
}

#[tauri::command]
fn get_watch_history(state: State<'_, AppState>) -> Result<Vec<storage::WatchProgress>, String> {
    let data = state.storage.data.lock().map_err(|e| e.to_string())?;
    Ok(data.history.clone())
}

#[tauri::command]
fn update_watch_progress(
    state: State<'_, AppState>,
    progress: storage::WatchProgress,
) -> Result<(), String> {
    state.storage.update_progress(progress)
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<storage::AppSettings, String> {
    Ok(state.storage.get_settings())
}

#[tauri::command]
fn update_settings(
    state: State<'_, AppState>,
    settings: storage::AppSettings,
) -> Result<(), String> {
    state.storage.update_settings(settings)
}

#[tauri::command]
fn save_settings(
    state: State<'_, AppState>,
    settings: Option<storage::AppSettings>,
    new_settings: Option<storage::AppSettings>,
) -> Result<(), String> {
    let s = settings.or(new_settings).ok_or_else(|| "Missing settings payload".to_string())?;
    state.storage.update_settings(s)
}

#[tauri::command]
fn get_addons(state: State<'_, AppState>) -> Result<Vec<storage::Addon>, String> {
    Ok(state.storage.get_addons())
}

#[tauri::command]
async fn install_addon_from_manifest(
    state: State<'_, AppState>,
    manifest_url: String,
) -> Result<storage::Addon, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_default();

    let res = client.get(&manifest_url).send().await;
    
    let (id, name, description, version, icon, types) = match res {
        Ok(resp) => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                let id = json.get("id").and_then(|i| i.as_str()).unwrap_or("custom.addon").to_string();
                let name = json.get("name").and_then(|n| n.as_str()).unwrap_or("Community Addon").to_string();
                let description = json.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string();
                let version = json.get("version").and_then(|v| v.as_str()).unwrap_or("1.0.0").to_string();
                let icon = json.get("icon").or_else(|| json.get("logo")).and_then(|l| l.as_str()).map(|s| s.to_string());
                let mut types = Vec::new();
                if let Some(t_arr) = json.get("types").and_then(|t| t.as_array()) {
                    for t in t_arr {
                        if let Some(ts) = t.as_str() {
                            types.push(ts.to_string());
                        }
                    }
                }
                (id, name, description, version, icon, types)
            } else {
                let name = manifest_url.split('/').last().unwrap_or("Custom Addon").replace(".json", "").replace(".m3u", "");
                ("custom.addon".to_string(), name, "Custom Installed Streaming Addon".to_string(), "1.0.0".to_string(), None, vec!["movie".to_string(), "series".to_string(), "tv".to_string()])
            }
        }
        Err(_) => {
            let name = manifest_url.split('/').last().unwrap_or("Custom Addon").replace(".json", "").replace(".m3u", "");
            ("custom.addon".to_string(), name, "Custom Installed Streaming Addon".to_string(), "1.0.0".to_string(), None, vec!["movie".to_string(), "series".to_string(), "tv".to_string()])
        }
    };

    let addon = storage::Addon {
        id,
        name,
        description,
        version,
        manifest_url,
        icon,
        types,
        enabled: true,
    };

    state.storage.add_addon(addon.clone())?;
    Ok(addon)
}

#[tauri::command]
fn add_custom_addon(
    state: State<'_, AppState>,
    addon: storage::Addon,
) -> Result<storage::Addon, String> {
    state.storage.add_addon(addon.clone())?;
    Ok(addon)
}

#[tauri::command]
fn remove_addon(state: State<'_, AppState>, addon_id: String) -> Result<(), String> {
    state.storage.remove_addon(&addon_id)
}

#[tauri::command]
fn toggle_addon(state: State<'_, AppState>, addon_id: String) -> Result<bool, String> {
    state.storage.toggle_addon(&addon_id)
}

#[tauri::command]
fn export_sync_data(state: State<'_, AppState>) -> Result<String, String> {
    state.storage.export_sync_json()
}

#[tauri::command]
fn import_sync_data(state: State<'_, AppState>, json: String) -> Result<(), String> {
    state.storage.import_sync_json(&json)
}

#[tauri::command]
async fn get_recommendations(state: State<'_, AppState>, media_type: String, id: u64, language: Option<String>) -> Result<Vec<tmdb::MediaItem>, String> {
    crate::policy::ensure_unlocked().await?;
    let key = state.storage.get_settings().tmdb_api_key;
    let client = tmdb::TmdbClient::new(Some(key));
    client.get_recommendations(&media_type, id, language.as_deref()).await
}

#[tauri::command]
fn check_ffmpeg() -> Result<String, String> {
    if let Some(p) = crate::assets::local_ffmpeg_path() {
        return Ok(format!("ffmpeg found: {}", p.to_string_lossy()));
    }
    let mut candidates = vec!["ffmpeg".to_string(), "ffmpeg.exe".to_string()];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("ffmpeg.exe").to_string_lossy().to_string());
            candidates.push(dir.join("resources").join("ffmpeg.exe").to_string_lossy().to_string());
            candidates.push(dir.join("ffmpeg").to_string_lossy().to_string());
        }
    }
    candidates.push(r"C:\ffmpeg\bin\ffmpeg.exe".to_string());
    candidates.push(r"C:\Program Files\ffmpeg\bin\ffmpeg.exe".to_string());
    for bin in candidates {
        if std::process::Command::new(&bin).arg("-version").output().is_ok() {
            return Ok(format!("ffmpeg found: {}", bin));
        }
    }
    Err("ffmpeg not found — install from https://www.gyan.dev/ffmpeg/builds/ or press VLC for instant playback".to_string())
}

fn resolve_ffmpeg_bin() -> Option<String> {
    // In-app / installer-provided copy first (no admin rights needed).
    if let Some(p) = crate::assets::local_ffmpeg_path() {
        return Some(p.to_string_lossy().to_string());
    }
    let mut candidates = vec!["ffmpeg".to_string(), "ffmpeg.exe".to_string()];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("ffmpeg.exe").to_string_lossy().to_string());
            candidates.push(dir.join("resources").join("ffmpeg.exe").to_string_lossy().to_string());
        }
    }
    candidates.push(r"C:\ffmpeg\bin\ffmpeg.exe".to_string());
    candidates.push(r"C:\Program Files\ffmpeg\bin\ffmpeg.exe".to_string());
    for bin in &candidates {
        if std::process::Command::new(bin).arg("-version").output().is_ok() {
            return Some(bin.clone());
        }
    }
    None
}

#[tauri::command]
async fn transcode_video(input_path: String, output_path: String) -> Result<String, String> {
    crate::policy::ensure_unlocked().await?;
    let input = std::path::Path::new(&input_path);
    if !input.exists() { return Err("Input not found".to_string()); }
    let bin = resolve_ffmpeg_bin().ok_or_else(|| "ffmpeg not found — install from https://www.gyan.dev/ffmpeg/builds/ or use VLC".to_string())?;
    // Fast path: copy video (H.264 MKV) + AAC audio + keep subs — finishes in seconds
    let fast = std::process::Command::new(&bin)
        .args(["-y", "-i", &input_path, "-map", "0:v:0", "-map", "0:a?", "-map", "0:s?", "-c:v", "copy", "-c:a", "aac", "-c:s", "mov_text", "-movflags", "+faststart", &output_path])
        .output()
        .map_err(|e| format!("ffmpeg not available: {}", e))?;
    if fast.status.success() {
        return Ok(output_path);
    }
    // Slow path: full H.264 transcode (H.265 MKV), keep subs
    let out = std::process::Command::new(&bin)
        .args(["-y", "-i", &input_path, "-map", "0:v:0", "-map", "0:a?", "-map", "0:s?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-c:s", "mov_text", "-movflags", "+faststart", &output_path])
        .output()
        .map_err(|e| format!("ffmpeg not available: {}", e))?;
    match out {
        o if o.status.success() => Ok(output_path),
        o => Err(format!("ffmpeg failed: {}. Try VLC instead.", String::from_utf8_lossy(&o.stderr).chars().take(400).collect::<String>())),
    }
}

#[tauri::command]
fn get_trakt_sync_preview(state: State<'_, AppState>) -> Result<String, String> {
    let hist = state.storage.data.lock().map_err(|e| e.to_string())?.history.clone();
    let preview = serde_json::json!({
        "trakt_format": "https://trakt.tv/oauth — placeholder",
        "watched_count": hist.len(),
        "items": hist.iter().take(5).map(|h| serde_json::json!({"title": h.title, "type": h.media_type, "progress": h.current_time_sec})).collect::<Vec<_>>()
    });
    Ok(serde_json::to_string_pretty(&preview).unwrap())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let storage = Arc::new(storage::StorageManager::new());
    let torrents = Arc::new(torrents::TorrentClient::new());
    let livetv = Arc::new(livetv::LiveTvManager::new());

    // Launch WebTorrent node streaming engine & Axum local server in background
    tauri::async_runtime::spawn(async move {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| std::path::PathBuf::from("."));

        let cur_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let candidate_paths = [
            // Layer 0 — installer/first-run engine dir (node.exe + full deps).
            exe_dir.join("engine").join("torrent-server.js"),
            exe_dir.join("resources").join("engine").join("torrent-server.js"),
            exe_dir.join("torrent-server.js"),
            exe_dir.join("resources").join("torrent-server.js"),
            exe_dir.join("../../../torrent-server.js"),
            exe_dir.join("../../torrent-server.js"),
            exe_dir.join("../torrent-server.js"),
            cur_dir.join("torrent-server.js"),
            cur_dir.join("../torrent-server.js"),
            std::path::PathBuf::from("torrent-server.js"),
            std::path::PathBuf::from("../torrent-server.js"),
        ];

        let mut script_path = None;
        for path in &candidate_paths {
            if path.exists() {
                script_path = Some(path.clone());
                break;
            }
        }

        let mut started = false;
        let health_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(800))
            .build()
            .unwrap_or_default();

        if let Ok(res) = health_client.get("http://127.0.0.1:31337/api/health").send().await {
            if res.status().is_success() {
                println!("[Mamzouka] WebTorrent engine is already active and healthy on port 31337");
                started = true;
            }
        }

        if !started {
            if let Some(path) = script_path {
                println!("[Mamzouka] Starting WebTorrent Node stream engine from: {:?}", path);
                let node_candidates = [
                    // Bundled portable node first (single-exe distribution).
                    exe_dir.join("engine").join("node.exe").to_string_lossy().to_string(),
                    exe_dir.join("resources").join("engine").join("node.exe").to_string_lossy().to_string(),
                    "node".to_string(),
                    r"C:\Program Files\nodejs\node.exe".to_string(),
                    r"C:\Program Files (x86)\nodejs\node.exe".to_string(),
                    exe_dir.join("node.exe").to_string_lossy().to_string(),
                    exe_dir.join("resources").join("node.exe").to_string_lossy().to_string(),
                ];

                for node_bin in &node_candidates {
                    let mut cmd = std::process::Command::new(node_bin);
                    cmd.arg(&path);
                    if let Some(parent) = path.parent() {
                        cmd.current_dir(parent);
                    }
                    // Point the engine at the lazily-downloaded ffmpeg, if any.
                    if let Some(ff) = crate::assets::local_ffmpeg_path() {
                        cmd.env("MAMZOUKA_FFMPEG", ff);
                    }
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                    }
                    if let Ok(child) = cmd.spawn() {
                        println!("[Mamzouka] WebTorrent spawned successfully using {}", node_bin);
                        if let Ok(mut lock) = NODE_CHILD.lock() {
                            *lock = Some(child);
                        }
                        started = true;
                        break;
                    }
                }
                if !started {
                    eprintln!("[Mamzouka] Failed to spawn node process from any candidate path");
                }
            } else {
                eprintln!("[Mamzouka] torrent-server.js not found in candidate paths!");
            }
        }

        match server::start_local_server().await {
            Ok(port) => println!("[Mamzouka] Local streaming server listening on port {}", port),
            Err(e) => eprintln!("[Mamzouka] Failed to start local server: {}", e),
        }
    });

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            storage,
            torrents,
            livetv,
        })
        .invoke_handler(tauri::generate_handler![
            get_server_port,
            get_trending,
            discover_media,
            search_media,
            get_media_details,
            get_season_episodes,
            get_torrent_streams,
            set_remote_tmdb_key,
            set_remote_source,
            get_policy_status,
            ensure_engine_assets,
            engine_status,
            download_ffmpeg,
            open_in_vlc,
            open_external_url,
            get_live_channels,
            get_custom_iptv_playlists,
            add_custom_iptv_playlist,
            remove_custom_iptv_playlist,
            get_downloads,
            start_download,
            delete_download,
            update_download_file_path,
            repair_download_container,
            open_download_folder,
            get_subtitles,
            get_watchlist,
            toggle_watchlist,
            is_in_watchlist,
            get_watch_history,
            update_watch_progress,
            get_settings,
            update_settings,
            save_settings,
            get_epg,
            export_sync_data,
            import_sync_data,
            get_recommendations,
            check_ffmpeg,
            transcode_video,
            get_trakt_sync_preview,
            get_addons,
            install_addon_from_manifest,
            add_custom_addon,
            remove_addon,
            toggle_addon,
            get_available_categories,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            cleanup_node_child();
        }
    });
}
