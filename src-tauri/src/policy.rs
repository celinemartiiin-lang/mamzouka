//! Layer 2 — server-side policy enforcement inside the Rust backend.
//!
//! The JavaScript expiry/kill-switch UI can be tampered with by anyone who
//! opens the app folder. This module re-checks the SAME remote document
//! (Supabase live row → GitHub fallback) from Rust and REFUSES to serve
//! catalog/torrent/download/transcode calls when the admin locked the app.
//! Even a fully rewritten frontend cannot get content out of this backend
//! while a lock is active.
//!
//! Fail-open design: first-ever launch while offline is allowed (movies must
//! work out of the box). A fetched LOCK is sticky and cached, so going
//! offline afterwards does NOT unlock a locked app.

use chrono::NaiveDate;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const GITHUB_FALLBACK_URL: &str = "https://raw.githubusercontent.com/mamzouka/mamzouka-remote-config/main/mamzouka-remote-config.json";
const POLICY_TTL: Duration = Duration::from_secs(600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(4);

struct RemoteSource {
    supabase_url: String,
    supabase_key: String,
}

static REMOTE_SOURCE: Mutex<RemoteSource> = Mutex::new(RemoteSource {
    supabase_url: String::new(),
    supabase_key: String::new(),
});

struct Cached {
    at: Instant,
    locked: bool,
    reason: String,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// Called once at boot from the frontend (URLs are public by design).
pub fn set_remote_source(supabase_url: String, supabase_key: String) {
    if let Ok(mut slot) = REMOTE_SOURCE.lock() {
        slot.supabase_url = supabase_url.trim().trim_end_matches('/').to_string();
        slot.supabase_key = supabase_key.trim().to_string();
    }
}

/// Stable, anonymous device fingerprint for the remote ban list.
/// SHA-256 over OS identity fields + app salt. Not reversible to the user.
pub fn device_id() -> String {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let input = format!("mamzouka-v1|{}|{}|{}", user.trim(), host.trim(), home.trim());
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let out = hasher.finalize();
    out.iter().map(|b| format!("{:02x}", b)).collect()
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("MamzoukaStream/1.0 (policy)")
        .build()
        .unwrap_or_default()
}

/// Fetch the unified remote document. Supabase row first, GitHub fallback.
async fn fetch_remote_doc(client: &reqwest::Client) -> Option<serde_json::Value> {
    let (base, key) = match REMOTE_SOURCE.lock() {
        Ok(s) => (s.supabase_url.clone(), s.supabase_key.clone()),
        Err(_) => (String::new(), String::new()),
    };
    if !base.is_empty() && !key.is_empty() {
        let url = format!("{}/rest/v1/remote_config?id=eq.1&select=config", base);
        if let Ok(res) = client
            .get(&url)
            .header("apikey", &key)
            .header("Authorization", format!("Bearer {}", key))
            .send()
            .await
        {
            if let Ok(rows) = res.json::<serde_json::Value>().await {
                if let Some(cfg) = rows.get(0).and_then(|r| r.get("config")) {
                    if cfg.is_object() {
                        return Some(cfg.clone());
                    }
                }
            }
        }
    }
    // Fallback: public GitHub JSON (works with zero setup).
    if let Ok(res) = client.get(GITHUB_FALLBACK_URL).send().await {
        if let Ok(doc) = res.json::<serde_json::Value>().await {
            if doc.is_object() {
                return Some(doc);
            }
        }
    }
    None
}

fn expiry_passed(date_str: &str) -> bool {
    let date_str = date_str.trim();
    if date_str.is_empty() {
        return false;
    }
    let day: Option<NaiveDate> = date_str
        .get(..10)
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    match day {
        Some(d) => {
            // Locked from 23:59:59 local time of the expiry day.
            let end = d
                .and_hms_opt(23, 59, 59)
                .and_then(|t| t.and_local_timezone(chrono::Local).single())
                .map(|dt| dt.timestamp());
            match end {
                Some(ts) => {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    now >= ts
                }
                None => false,
            }
        }
        None => false,
    }
}

fn update_section(doc: &serde_json::Value) -> serde_json::Value {
    doc.get("update")
        .or_else(|| doc.get("updateConfig"))
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

/// Evaluate lock state from a fetched document (no network here).
fn eval_lock(doc: &serde_json::Value) -> (bool, String) {
    let upd = update_section(doc);
    let enabled = upd.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
    if !enabled {
        return (false, String::new());
    }
    if upd
        .get("forceLock")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || upd
            .get("forceUpdate")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    {
        return (true, "Locked by admin (force lock)".to_string());
    }
    if let Some(exp) = upd.get("expiryDate").and_then(|v| v.as_str()) {
        if expiry_passed(exp) {
            return (true, format!("Version expired on {}", &exp[..10.min(exp.len())]));
        }
    }
    (false, String::new())
}

async fn check_ban(client: &reqwest::Client) -> bool {
    let (base, key) = match REMOTE_SOURCE.lock() {
        Ok(s) => (s.supabase_url.clone(), s.supabase_key.clone()),
        Err(_) => (String::new(), String::new()),
    };
    if base.is_empty() || key.is_empty() {
        return false;
    }
    let url = format!(
        "{}/rest/v1/bans?device_hash=eq.{}&select=device_hash",
        base,
        device_id()
    );
    if let Ok(res) = client
        .get(&url)
        .header("apikey", &key)
        .header("Authorization", format!("Bearer {}", key))
        .send()
        .await
    {
        if let Ok(rows) = res.json::<serde_json::Value>().await {
            if let Some(arr) = rows.as_array() {
                return !arr.is_empty();
            }
        }
    }
    false
}

async fn refresh() -> (bool, String) {
    let client = http_client();
    match fetch_remote_doc(&client).await {
        Some(doc) => {
            let (locked, reason) = eval_lock(&doc);
            if locked {
                store(locked, reason.clone());
                return (locked, reason);
            }
            if check_ban(&client).await {
                let reason = "This device was banned by the admin".to_string();
                store(true, reason.clone());
                return (true, reason);
            }
            store(false, String::new());
            (false, String::new())
        }
        None => {
            // Offline: honor the last known verdict (sticky lock), else allow.
            if let Ok(cache) = CACHE.lock() {
                if let Some(c) = cache.as_ref() {
                    return (c.locked, c.reason.clone());
                }
            }
            (false, String::new())
        }
    }
}

fn store(locked: bool, reason: String) {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some(Cached {
            at: Instant::now(),
            locked,
            reason,
        });
    }
}

/// Gate for every content-serving command. Fails CLOSED on lock,
/// fails OPEN only when no verdict was ever fetched (offline first run).
pub async fn ensure_unlocked() -> Result<(), String> {
    let fresh = match CACHE.lock() {
        Ok(c) => c.as_ref().map(|v| v.at.elapsed() < POLICY_TTL),
        Err(_) => None,
    };
    let (locked, reason) = match fresh {
        Some(true) => match CACHE.lock() {
            Ok(c) => {
                let v = c.as_ref().unwrap();
                (v.locked, v.reason.clone())
            }
            Err(_) => (false, String::new()),
        },
        _ => refresh().await,
    };
    if locked {
        Err(format!(
            "App locked by admin{}",
            if reason.is_empty() {
                String::new()
            } else {
                format!(": {}", reason)
            }
        ))
    } else {
        Ok(())
    }
}
