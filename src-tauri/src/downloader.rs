use crate::storage::{DownloadItem, StorageManager};
use futures_util::StreamExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::AsyncWriteExt;

pub fn get_downloads_dir() -> PathBuf {
    let dir = dirs::download_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Mamzouka");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn sanitize_filename(name: &str) -> String {
    let invalid_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let mut clean = name
        .chars()
        .map(|c| if invalid_chars.contains(&c) { '_' } else { c })
        .collect::<String>();
    clean.truncate(80);
    clean.trim().to_string()
}

fn ext_from_name(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    // strip query string
    let base = lower.split('?').next().unwrap_or(&lower);
    let file = base.rsplit('/').next().unwrap_or(base);
    if let Some(dot) = file.rfind('.') {
        let ext = &file[dot + 1..];
        const KNOWN: &[&str] = &["mp4", "mkv", "webm", "avi", "mov", "m4v", "ts", "m2ts", "flv", "mp3", "m4a"];
        if KNOWN.contains(&ext) && ext.len() <= 4 {
            return Some(ext.to_string());
        }
    }
    None
}

/// Ask the local engine which real file backs an /api/stream/<hash>/<idx> URL.
/// Returns e.g. "Movie.2024.1080p.WEB-DL.mkv" so we save the right extension.
async fn probe_engine_file_name(client: &reqwest::Client, stream_url: &str) -> Option<String> {
    let after = stream_url.split("/api/stream/").nth(1)?;
    let mut parts = after.split('/');
    let hash = parts.next()?;
    let idx: u64 = parts.next().unwrap_or("0").parse().ok()?;
    if hash.len() < 20 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let probe = format!("http://127.0.0.1:31337/api/stream/probe/{}", hash);
    let res = client.get(&probe).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let json: serde_json::Value = res.json().await.ok()?;
    json.get("files")?
        .as_array()?
        .iter()
        .find(|f| f.get("index").and_then(|i| i.as_u64()) == Some(idx))?
        .get("name")?
        .as_str()
        .map(|s| s.to_string())
}

pub async fn start_background_download(
    mut item: DownloadItem,
    storage: Arc<StorageManager>,
) -> Result<DownloadItem, String> {
    let downloads_dir = get_downloads_dir();

    item.file_path = String::new();
    item.status = "downloading".to_string();
    item.progress = 0.0;
    item.downloaded_bytes = 0;
    item.download_speed = "Resolving source...".to_string();
    let _ = storage.add_or_update_download(item.clone());

    let item_clone = item.clone();
    let storage_clone = storage.clone();

    tokio::spawn(async move {
        let mut download_url = item_clone.stream_url.clone().unwrap_or_default();

        // Resolve magnet → direct stream URL via the local engine (60s budget).
        // NOTE: no total request timeout here on purpose — movies take longer
        // than any fixed budget on slow peers. A stall watchdog below aborts
        // only when zero bytes arrive for STALL_LIMIT.
        if download_url.is_empty() || download_url.starts_with("magnet:") {
            if let Some(ref magnet) = item_clone.magnet_uri {
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(60))
                    .build()
                    .unwrap_or_default();
                let body = serde_json::json!({
                    "magnet": magnet,
                    "season": item_clone.season,
                    "episode": item_clone.episode,
                });
                if let Ok(res) = client.post("http://127.0.0.1:31337/api/stream/start").json(&body).send().await {
                    if let Ok(json) = res.json::<serde_json::Value>().await {
                        if let Some(url) = json.get("stream_url").or_else(|| json.get("streamUrl")).and_then(|u| u.as_str()) {
                            download_url = url.to_string();
                        }
                    }
                }
            }
        }

        if download_url.is_empty() {
            let mut failed_item = item_clone.clone();
            failed_item.status = "error".to_string();
            failed_item.download_speed = "No stream source available".to_string();
            let _ = storage_clone.add_or_update_download(failed_item);
            return;
        }

        // Extension priority: real file name > engine probe > URL path > title > mp4.
        // (Old code guessed from the display title, saving MKV bytes as .mp4 = unplayable.)
        let probe_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        let probed = probe_engine_file_name(&probe_client, &download_url).await;
        let ext = ext_from_name(item_clone.file_name.clone().unwrap_or_default().as_str())
            .or_else(|| probed.as_deref().and_then(ext_from_name))
            .or_else(|| ext_from_name(&download_url))
            .or_else(|| ext_from_name(&item_clone.title))
            .unwrap_or_else(|| "mp4".to_string());
        let clean_title = sanitize_filename(&item_clone.title);
        let filename = format!("{}_{}.{}", clean_title, item_clone.id, ext);
        let target_path = downloads_dir.join(&filename);

        // No total timeout: a movie may legitimately take hours on slow peers.
        // Stall watchdog (below) aborts only after STALL_LIMIT_SECS of zero bytes.
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();

        const STALL_LIMIT_SECS: u64 = 180;

        match client.get(&download_url).send().await {
            Ok(res) => {
                if !res.status().is_success() {
                    let mut failed_item = item_clone.clone();
                    failed_item.status = "error".to_string();
                    failed_item.download_speed = format!("Server replied {} — torrent may be dead, try another source", res.status());
                    let _ = storage_clone.add_or_update_download(failed_item);
                    return;
                }
                let total_size = res.content_length().unwrap_or(item_clone.file_size);
                let mut current_item = item_clone.clone();
                current_item.file_size = total_size;
                current_item.file_path = target_path.to_string_lossy().to_string();
                current_item.download_speed = "Downloading...".to_string();
                let _ = storage_clone.add_or_update_download(current_item.clone());

                let mut file = match tokio::fs::File::create(&target_path).await {
                    Ok(f) => f,
                    Err(e) => {
                        current_item.status = "error".to_string();
                        current_item.download_speed = format!("Failed to create file: {}", e);
                        let _ = storage_clone.add_or_update_download(current_item);
                        return;
                    }
                };

                let mut stream = res.bytes_stream();
                let mut downloaded: u64 = 0;
                let mut last_update = Instant::now();
                let mut last_bytes: u64 = 0;

                loop {
                    let chunk_opt = match tokio::time::timeout(
                        std::time::Duration::from_secs(STALL_LIMIT_SECS),
                        stream.next(),
                    )
                    .await
                    {
                        Ok(v) => v,
                        Err(_) => {
                            current_item.status = "error".to_string();
                            current_item.download_speed = "Stalled 3 min with 0 peers — torrent looks dead, try another source".to_string();
                            let _ = storage_clone.add_or_update_download(current_item);
                            return;
                        }
                    };
                    let chunk_result = match chunk_opt {
                        Some(r) => r,
                        None => break,
                    };
                    match chunk_result {
                        Ok(chunk) => {
                            if let Err(e) = file.write_all(&chunk).await {
                                current_item.status = "error".to_string();
                                current_item.download_speed = format!("Write error: {}", e);
                                let _ = storage_clone.add_or_update_download(current_item);
                                return;
                            }
                            downloaded += chunk.len() as u64;

                            if last_update.elapsed().as_millis() >= 1000 {
                                let elapsed_sec = last_update.elapsed().as_secs_f64();
                                let speed_bps = ((downloaded - last_bytes) as f64 / elapsed_sec) as u64;
                                let speed_formatted = format_speed(speed_bps);

                                current_item.downloaded_bytes = downloaded;
                                if total_size > 0 {
                                    current_item.progress = ((downloaded as f64 / total_size as f64) * 100.0) as f32;
                                }
                                current_item.download_speed = speed_formatted;
                                let _ = storage_clone.add_or_update_download(current_item.clone());

                                last_update = Instant::now();
                                last_bytes = downloaded;
                            }
                        }
                        Err(e) => {
                            current_item.status = "error".to_string();
                            current_item.download_speed = format!("Stream interrupted: {}", e);
                            let _ = storage_clone.add_or_update_download(current_item);
                            return;
                        }
                    }
                }

                let _ = file.flush().await;
                current_item.downloaded_bytes = downloaded;
                current_item.progress = 100.0;
                current_item.status = "completed".to_string();
                current_item.download_speed = "Ready for Offline".to_string();
                let _ = storage_clone.add_or_update_download(current_item);
            }
            Err(e) => {
                let mut failed_item = item_clone.clone();
                failed_item.status = "error".to_string();
                failed_item.download_speed = format!("Download request error: {}", e);
                let _ = storage_clone.add_or_update_download(failed_item);
            }
        }
    });

    Ok(item)
}

pub fn format_speed(bytes_per_sec: u64) -> String {
    let mb = bytes_per_sec as f64 / (1024.0 * 1024.0);
    if mb >= 1.0 {
        format!("{:.1} MB/s", mb)
    } else {
        let kb = bytes_per_sec as f64 / 1024.0;
        format!("{:.0} KB/s", kb)
    }
}
