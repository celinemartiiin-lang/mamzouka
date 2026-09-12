use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

// Layer 3 — secrets live in the OS credential store (DPAPI on Windows,
// Keychain on macOS, Secret Service on Linux), never in plaintext JSON.
// The UI sees only a sentinel; the real value never leaves Rust except
// inside the outgoing Real-Debrid HTTPS call.
pub const DEBRID_SENTINEL: &str = "••••••";
const KEYRING_SERVICE: &str = "com.mamzouka.stream";
const KEYRING_USER: &str = "real-debrid";

fn keyring_entry() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()
}

pub fn keychain_get_debrid() -> Option<String> {
    keyring_entry()?
        .get_password()
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

fn keychain_set_debrid(token: &str) -> bool {
    match keyring_entry() {
        Some(e) => e.set_password(token).is_ok(),
        None => false,
    }
}

fn keychain_delete_debrid() {
    if let Some(e) = keyring_entry() {
        let _ = e.delete_credential();
    }
}

pub fn is_sentinel(v: &Option<String>) -> bool {
    matches!(v, Some(s) if s == DEBRID_SENTINEL)
}

/// The token actually used for API calls: explicit value wins,
/// otherwise the OS-encrypted copy. Empty = not configured.
pub fn effective_debrid_key(stored: &Option<String>) -> Option<String> {
    match stored {
        Some(s) if !s.trim().is_empty() && s != DEBRID_SENTINEL => Some(s.trim().to_string()),
        _ => keychain_get_debrid(),
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Addon {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub manifest_url: String,
    pub icon: Option<String>,
    pub types: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WatchProgress {
    pub media_id: u64,
    pub media_type: String, // "movie", "tv", "anime"
    pub title: String,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub current_time_sec: f64,
    pub duration_sec: f64,
    pub last_watched_timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    #[serde(default = "default_tmdb")]
    pub tmdb_api_key: String,
    #[serde(default)]
    pub real_debrid_api_key: Option<String>,
    #[serde(default = "default_sub_lang")]
    pub default_subtitle_lang: String,
    #[serde(default = "default_res")]
    pub preferred_resolution: String, // "1080p", "4K", "720p"
    #[serde(default = "default_true")]
    pub auto_play_next: bool,
    #[serde(default)]
    pub cache_dir: String,
    #[serde(default)]
    pub kids_mode: bool,
    #[serde(default)]
    pub kids_pin: Option<String>,
    // Appearance
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_language")]
    pub app_language: String,
    #[serde(default = "default_density")]
    pub density: String,
    // Playback
    #[serde(default)]
    pub auto_skip_intro: bool,
    #[serde(default = "default_true")]
    pub hardware_acceleration: bool,
    // Downloads
    #[serde(default = "default_quota")]
    pub quota_gb: u32,
    #[serde(default = "default_true")]
    pub smart_offline: bool,
    #[serde(default = "default_true")]
    pub auto_transcode: bool,
    #[serde(default = "default_concurrency")]
    pub download_concurrency: u32,
    // Subtitles
    #[serde(default)]
    pub secondary_sub_lang: Option<String>,
    #[serde(default = "default_sub_size")]
    pub sub_font_size: String,
    #[serde(default)]
    pub sub_auto_translate: bool,
    // Live
    #[serde(default = "default_epg_source")]
    pub epg_source: String,
    // Notifications
    #[serde(default = "default_true")]
    pub notif_new_episode: bool,
    #[serde(default = "default_true")]
    pub notif_download_complete: bool,
    #[serde(default = "default_true")]
    pub notif_analytics: bool,
}

fn default_tmdb() -> String { "0ea8d8ca2abeb5fa061faf1a966747b4".to_string() }
fn default_sub_lang() -> String { "ara".to_string() }
fn default_res() -> String { "1080p".to_string() }
fn default_theme() -> String { "moroccan".to_string() }
fn default_language() -> String { "en".to_string() }
fn default_density() -> String { "comfortable".to_string() }
fn default_true() -> bool { true }
fn default_quota() -> u32 { 100 }
fn default_concurrency() -> u32 { 2 }
fn default_sub_size() -> String { "medium".to_string() }
fn default_epg_source() -> String { "auto".to_string() }

impl Default for AppSettings {
    fn default() -> Self {
        let cache_dir = dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("MamzoukaStream")
            .to_string_lossy()
            .to_string();

        Self {
            tmdb_api_key: option_env!("TMDB_API_KEY").unwrap_or("0ea8d8ca2abeb5fa061faf1a966747b4").to_string(),
            real_debrid_api_key: None,
            default_subtitle_lang: "ara".to_string(),
            preferred_resolution: "1080p".to_string(),
            auto_play_next: true,
            cache_dir: cache_dir.clone(),
            kids_mode: false,
            kids_pin: None,
            theme: default_theme(),
            app_language: default_language(),
            density: default_density(),
            auto_skip_intro: false,
            hardware_acceleration: true,
            quota_gb: default_quota(),
            smart_offline: true,
            auto_transcode: false,
            download_concurrency: default_concurrency(),
            secondary_sub_lang: None,
            sub_font_size: default_sub_size(),
            sub_auto_translate: false,
            epg_source: default_epg_source(),
            notif_new_episode: true,
            notif_download_complete: true,
            notif_analytics: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomIptvPlaylist {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadItem {
    pub id: String,
    pub media_id: u64,
    pub media_type: String, // "movie", "tv", "anime"
    pub title: String,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub file_path: String,
    pub file_size: u64,
    pub downloaded_bytes: u64,
    pub progress: f32, // 0.0 to 100.0
    pub download_speed: String,
    pub status: String, // "downloading", "completed", "error", "paused"
    pub stream_url: Option<String>,
    pub magnet_uri: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>, // real torrent file name (for correct extension)
    pub date_added: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppData {
    pub settings: AppSettings,
    pub watchlist: Vec<crate::tmdb::MediaItem>,
    pub history: Vec<WatchProgress>,
    pub addons: Vec<Addon>,
    #[serde(default)]
    pub custom_iptv: Vec<CustomIptvPlaylist>,
    #[serde(default)]
    pub downloads: Vec<DownloadItem>,
}

impl Default for AppData {
    fn default() -> Self {
        let default_addons = vec![
            Addon {
                id: "community.torrentio".to_string(),
                name: "Torrentio Multi-Scraper".to_string(),
                description: "Scrapes torrent streams from multi-trackers (YTS, EZTV, RARBG, 1337x, ThePirateBay) for movies and series.".to_string(),
                version: "1.0.13".to_string(),
                manifest_url: "https://torrentio.strem.fun/manifest.json".to_string(),
                icon: Some("https://torrentio.strem.fun/logo.png".to_string()),
                types: vec!["movie".to_string(), "series".to_string(), "anime".to_string()],
                enabled: true,
            },
            Addon {
                id: "livetv.arab-mega".to_string(),
                name: "🌴 Arab World & Nilesat Mega TV".to_string(),
                description: "Morocco, Egypt, Saudi Arabia, UAE, Algeria, Tunisia, Qatar complete channels (MBC, Rotana, Al Jazeera, Dubai, Abu Dhabi).".to_string(),
                version: "2.5.0".to_string(),
                manifest_url: "https://iptv-org.github.io/iptv/languages/ara.m3u".to_string(),
                icon: None,
                types: vec!["tv".to_string()],
                enabled: true,
            },
            Addon {
                id: "livetv.sports-mega".to_string(),
                name: "⚽ Global Sports Arena (باقة الرياضة المباشرة)".to_string(),
                description: "Sports, football, motorsport, combat, extreme sports and international live broadcast feeds.".to_string(),
                version: "2.1.0".to_string(),
                manifest_url: "https://iptv-org.github.io/iptv/categories/sports.m3u".to_string(),
                icon: None,
                types: vec!["tv".to_string()],
                enabled: true,
            },
            Addon {
                id: "livetv.france-mega".to_string(),
                name: "🇫🇷 France TNT & Premium TV".to_string(),
                description: "France Télévisions (France 2, 3, 5), TF1, Arte, Euronews, TV5 Monde, BFM TV and French channels.".to_string(),
                version: "1.2.0".to_string(),
                manifest_url: "https://iptv-org.github.io/iptv/countries/fr.m3u".to_string(),
                icon: None,
                types: vec!["tv".to_string()],
                enabled: true,
            },
            Addon {
                id: "livetv.usa-uk-mega".to_string(),
                name: "🇺🇸 USA & 🇬🇧 UK FAST TV".to_string(),
                description: "News, 24/7 entertainment, comedy, crime, documentaries and movies from USA and UK.".to_string(),
                version: "1.1.0".to_string(),
                manifest_url: "https://iptv-org.github.io/iptv/languages/eng.m3u".to_string(),
                icon: None,
                types: vec!["tv".to_string()],
                enabled: true,
            },
            Addon {
                id: "community.opensubtitles-v3".to_string(),
                name: "OpenSubtitles v3".to_string(),
                description: "Official OpenSubtitles provider for Arabic, English, French and multi-language subtitles.".to_string(),
                version: "1.0.0".to_string(),
                manifest_url: "https://opensubtitles-v3.strem.fun/manifest.json".to_string(),
                icon: None,
                types: vec!["movie".to_string(), "series".to_string()],
                enabled: true,
            },
            Addon {
                id: "community.anime-kitsu".to_string(),
                name: "Anime Kitsu & Catalogs".to_string(),
                description: "Complete anime database and catalogs powered by Kitsu & AnimeTosho.".to_string(),
                version: "1.1.0".to_string(),
                manifest_url: "https://anime-kitsu.strem.fun/manifest.json".to_string(),
                icon: None,
                types: vec!["anime".to_string(), "series".to_string()],
                enabled: true,
            },
            Addon {
                id: "community.cyberflix".to_string(),
                name: "CyberFlix Catalogs".to_string(),
                description: "Trending streams and catalogs from Netflix, Disney+, Apple TV+, HBO Max and Amazon Prime.".to_string(),
                version: "1.4.0".to_string(),
                manifest_url: "https://cyberflix.elfhosted.com/c/catalogs/manifest.json".to_string(),
                icon: None,
                types: vec!["movie".to_string(), "series".to_string()],
                enabled: true,
            },
        ];

        Self {
            settings: AppSettings::default(),
            watchlist: Vec::new(),
            history: Vec::new(),
            addons: default_addons,
            custom_iptv: Vec::new(),
            downloads: Vec::new(),
        }
    }
}

pub struct StorageManager {
    file_path: PathBuf,
    pub data: Mutex<AppData>,
}

impl StorageManager {
    pub fn new() -> Self {
        let app_dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("MamzoukaStream");
        
        let _ = fs::create_dir_all(&app_dir);
        let file_path = app_dir.join("data.json");

        let mut data = if file_path.exists() {
            match fs::read_to_string(&file_path) {
                Ok(content) => serde_json::from_str::<AppData>(&content).unwrap_or_default(),
                Err(_) => AppData::default(),
            }
        } else {
            AppData::default()
        };

        // Ensure default addons exist if empty
        if data.addons.is_empty() {
            data.addons = AppData::default().addons;
        }

        Self {
            file_path,
            data: Mutex::new(data),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        let json_str = serde_json::to_string_pretty(&*data).map_err(|e| e.to_string())?;
        fs::write(&self.file_path, json_str).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn toggle_watchlist(&self, item: crate::tmdb::MediaItem) -> Result<bool, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let exists_idx = data.watchlist.iter().position(|x| x.id == item.id && x.media_type == item.media_type);
        let is_now_favorite = if let Some(idx) = exists_idx {
            data.watchlist.remove(idx);
            false
        } else {
            data.watchlist.push(item);
            true
        };
        drop(data);
        self.save()?;
        Ok(is_now_favorite)
    }

    pub fn is_in_watchlist(&self, id: u64, media_type: &str) -> bool {
        if let Ok(data) = self.data.lock() {
            data.watchlist.iter().any(|x| x.id == id && x.media_type == media_type)
        } else {
            false
        }
    }

    pub fn update_progress(&self, progress: WatchProgress) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        data.history.retain(|x| !(x.media_id == progress.media_id && x.media_type == progress.media_type && x.season == progress.season && x.episode == progress.episode));
        data.history.insert(0, progress);
        if data.history.len() > 100 {
            data.history.truncate(100);
        }
        drop(data);
        self.save()?;
        Ok(())
    }

    pub fn get_settings(&self) -> AppSettings {
        let mut s = self.data.lock().map(|d| d.settings.clone()).unwrap_or_default();
        // One-time silent migration: plaintext token in JSON → OS keychain.
        if let Some(tok) = s.real_debrid_api_key.clone() {
            let tok = tok.trim().to_string();
            if !tok.is_empty() && tok != DEBRID_SENTINEL && keychain_set_debrid(&tok) {
                s.real_debrid_api_key = None;
                if let Ok(mut data) = self.data.lock() {
                    data.settings.real_debrid_api_key = None;
                }
                let _ = self.save();
            }
        }
        // Never expose the real secret to the UI layer; show a sentinel instead.
        if s.real_debrid_api_key.is_none() && keychain_get_debrid().is_some() {
            s.real_debrid_api_key = Some(DEBRID_SENTINEL.to_string());
        }
        s
    }

    pub fn update_settings(&self, mut settings: AppSettings) -> Result<(), String> {
        // Route the token through the OS keychain; keep the JSON file clean.
        match settings.real_debrid_api_key.clone() {
            Some(tok) if tok.trim() == DEBRID_SENTINEL => {
                // UI echoed the mask back → keep whatever is stored.
                settings.real_debrid_api_key = None;
            }
            Some(tok) if !tok.trim().is_empty() => {
                if keychain_set_debrid(tok.trim()) {
                    settings.real_debrid_api_key = None;
                } else {
                    // Keychain unavailable (portable/locked profile) → file fallback.
                    settings.real_debrid_api_key = Some(tok.trim().to_string());
                }
            }
            _ => {
                keychain_delete_debrid();
                settings.real_debrid_api_key = None;
            }
        }
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        data.settings = settings;
        drop(data);
        self.save()?;
        Ok(())
    }

    pub fn get_addons(&self) -> Vec<Addon> {
        self.data.lock().map(|d| d.addons.clone()).unwrap_or_default()
    }

    pub fn add_addon(&self, addon: Addon) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        data.addons.retain(|a| a.manifest_url != addon.manifest_url && a.id != addon.id);
        data.addons.push(addon);
        drop(data);
        self.save()?;
        Ok(())
    }

    pub fn remove_addon(&self, addon_id: &str) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        data.addons.retain(|a| a.id != addon_id);
        drop(data);
        self.save()?;
        Ok(())
    }

    pub fn toggle_addon(&self, addon_id: &str) -> Result<bool, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        if let Some(addon) = data.addons.iter_mut().find(|a| a.id == addon_id) {
            addon.enabled = !addon.enabled;
            let status = addon.enabled;
            drop(data);
            self.save()?;
            Ok(status)
        } else {
            Err("Addon not found".to_string())
        }
    }

    pub fn get_custom_iptv(&self) -> Vec<CustomIptvPlaylist> {
        self.data.lock().map(|d| d.custom_iptv.clone()).unwrap_or_default()
    }

    pub fn add_custom_iptv(&self, name: String, url: String) -> Result<CustomIptvPlaylist, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let id = format!("iptv_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
        let item = CustomIptvPlaylist {
            id: id.clone(),
            name,
            url,
            enabled: true,
        };
        data.custom_iptv.push(item.clone());
        drop(data);
        self.save()?;
        Ok(item)
    }

    pub fn remove_custom_iptv(&self, id: &str) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        data.custom_iptv.retain(|x| x.id != id);
        drop(data);
        self.save()?;
        Ok(())
    }

    pub fn get_downloads(&self) -> Vec<DownloadItem> {
        self.data.lock().map(|d| d.downloads.clone()).unwrap_or_default()
    }

    pub fn add_or_update_download(&self, item: DownloadItem) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        if let Some(pos) = data.downloads.iter().position(|x| x.id == item.id) {
            data.downloads[pos] = item;
        } else {
            data.downloads.insert(0, item);
        }
        drop(data);
        self.save()?;
        Ok(())
    }

    pub fn remove_download(&self, id: &str) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        data.downloads.retain(|x| x.id != id);
        drop(data);
        self.save()?;
        Ok(())
    }

    pub fn export_sync_json(&self) -> Result<String, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&*data).map_err(|e| e.to_string())
    }

    pub fn import_sync_json(&self, json: &str) -> Result<(), String> {
        let imported: AppData = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        *data = imported;
        drop(data);
        self.save()?;
        Ok(())
    }
}
