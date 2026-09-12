//! First-run asset manager: portable node + engine deps + ffmpeg.
//!
//! Distribution model is a SINGLE .exe installer. Heavy one-time files are
//! fetched from direct links, with two chances:
//!   1. At install time (NSIS hook → $INSTDIR\engine\)
//!   2. Here, on first run / on demand, into the per-user app data dir.
//! Everything degrades gracefully: missing engine ⇒ web embeds still work,
//! missing ffmpeg ⇒ VLC fallback. Nothing ever hard-bricks the app.

use std::io::Write;
use std::path::PathBuf;

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn app_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.mamzouka.stream")
}

/// $INSTDIR\engine (preferred) or per-user fallback.
pub fn engine_dirs() -> Vec<PathBuf> {
    let exe = exe_dir();
    vec![
        exe.join("engine"),
        exe.join("resources").join("engine"),
        app_data_dir().join("engine"),
    ]
}

pub fn engine_ready(dir: &PathBuf) -> bool {
    dir.join("node.exe").exists()
        && dir
            .join("node_modules")
            .join("webtorrent")
            .join("package.json")
            .exists()
        && dir.join("torrent-server.js").exists()
}

pub fn find_ready_engine() -> Option<PathBuf> {
    engine_dirs().into_iter().find(|d| engine_ready(d))
}

/// ffmpeg lives next to the exe when an admin drops it there,
/// otherwise in per-user app data (downloaded lazily, see below).
pub fn local_ffmpeg_path() -> Option<PathBuf> {
    let cands = [
        exe_dir().join("ffmpeg.exe"),
        exe_dir().join("resources").join("ffmpeg.exe"),
        exe_dir().join("engine").join("ffmpeg.exe"),
        app_data_dir().join("bin").join("ffmpeg.exe"),
    ];
    cands.into_iter().find(|p| p.exists())
}

fn download_to(url: &str, dest: &PathBuf) -> Result<(), String> {
    let bytes = reqwest::blocking::get(url).map_err(|e| format!("download failed: {}", e))?;
    if !bytes.status().is_success() {
        return Err(format!("server replied {}", bytes.status()));
    }
    let data = bytes
        .bytes()
        .map_err(|e| format!("download failed: {}", e))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
    }
    let mut f = std::fs::File::create(dest).map_err(|e| format!("write failed: {}", e))?;
    f.write_all(&data)
        .map_err(|e| format!("write failed: {}", e))?;
    Ok(())
}

fn unzip_to(zip_path: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("open zip failed: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("bad zip: {}", e))?;
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir failed: {}", e))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("zip read failed: {}", e))?;
        let out = match entry.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("mkdir failed: {}", e))?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
            }
            let mut f = std::fs::File::create(&out).map_err(|e| format!("write failed: {}", e))?;
            std::io::copy(&mut entry, &mut f).map_err(|e| format!("extract failed: {}", e))?;
        }
    }
    Ok(())
}

pub fn default_node_url() -> String {
    // Pinned portable build; rotate by editing ONE place (or remote endpoints).
    "https://nodejs.org/dist/v22.23.2/win-x64/node.exe".to_string()
}

/// Ensure node.exe + engine deps exist somewhere usable.
/// Downloads into per-user app data (no admin rights needed).
/// Returns the ready engine dir.
pub fn ensure_engine_assets(node_url: Option<String>, engine_url: Option<String>) -> Result<PathBuf, String> {
    if let Some(dir) = find_ready_engine() {
        return Ok(dir);
    }
    let node_url = match node_url {
        Some(u) if u.starts_with("http") => u,
        _ => default_node_url(),
    };
    let engine_url = match engine_url {
        Some(u) if u.starts_with("http") => u,
        _ => {
            return Err(
                "Engine files missing and no engine zip URL configured — ask the admin for the release link"
                    .to_string(),
            )
        }
    };
    let dir = app_data_dir().join("engine");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {}", e))?;
    let node_dest = dir.join("node.exe");
    if !node_dest.exists() {
        download_to(&node_url, &node_dest)?;
    }
    if !engine_ready(&dir) {
        let zip = dir.join("engine.zip");
        download_to(&engine_url, &zip)?;
        unzip_to(&zip, &dir)?;
        let _ = std::fs::remove_file(&zip);
    }
    if engine_ready(&dir) {
        Ok(dir)
    } else {
        Err("Engine download finished but files look incomplete — retry or use web servers".to_string())
    }
}

pub fn engine_status() -> serde_json::Value {
    let ready = find_ready_engine().map(|p| p.to_string_lossy().to_string());
    serde_json::json!({
        "ready": ready.is_some(),
        "path": ready,
        "ffmpeg": local_ffmpeg_path().map(|p| p.to_string_lossy().to_string()),
    })
}

/// Download + extract ffmpeg essentials zip, return ffmpeg.exe path.
/// Only the ~80MB essentials zip's bin/ffmpeg.exe is kept.
pub fn download_ffmpeg(zip_url: &str) -> Result<PathBuf, String> {
    if !(zip_url.starts_with("http://") || zip_url.starts_with("https://")) {
        return Err("Bad ffmpeg URL".to_string());
    }
    if let Some(existing) = local_ffmpeg_path() {
        return Ok(existing);
    }
    let bin_dir = app_data_dir().join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("mkdir failed: {}", e))?;
    let zip_path = bin_dir.join("ffmpeg.zip");
    download_to(zip_url, &zip_path)?;
    let tmp = bin_dir.join("ffmpeg-dl");
    let _ = std::fs::remove_dir_all(&tmp);
    unzip_to(&zip_path, &tmp)?;
    // Find bin/ffmpeg.exe anywhere inside (essentials layout: ffmpeg-*/bin/ffmpeg.exe)
    let mut found: Option<PathBuf> = None;
    let mut stack = vec![tmp.clone()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("scan failed: {}", e))?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().and_then(|n| n.to_str()) == Some("ffmpeg.exe") {
                found = Some(p);
                break;
            }
        }
        if found.is_some() {
            break;
        }
    }
    let _ = std::fs::remove_file(&zip_path);
    match found {
        Some(src) => {
            let dest = bin_dir.join("ffmpeg.exe");
            let _ = std::fs::remove_file(&dest);
            std::fs::rename(&src, &dest).map_err(|e| format!("install failed: {}", e))?;
            let _ = std::fs::remove_dir_all(&tmp);
            Ok(dest)
        }
        None => Err("ffmpeg.exe not found inside the downloaded zip".to_string()),
    }
}
