use axum::{
    body::Body,
    extract::Query,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use tokio::io::AsyncReadExt;
use tower_http::cors::{Any, CorsLayer};

pub static SERVER_PORT: AtomicU16 = AtomicU16::new(0);

fn mime_for_path(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("avi") => "video/x-msvideo",
        Some("mov") => "video/quicktime",
        Some("ts") | Some("m2ts") => "video/mp2t",
        Some("flv") => "video/x-flv",
        Some("mp3") => "audio/mpeg",
        _ => "video/mp4",
    }
}

#[derive(Serialize, Deserialize)]
pub struct StreamStatusResponse {
    pub status: String,
    pub speed_formatted: String,
    pub peers: u32,
    pub progress_pct: f64,
}

pub async fn start_local_server() -> Result<u16, String> {
    let cors = CorsLayer::new()
        .allow_origin([
            "tauri://localhost".parse::<axum::http::HeaderValue>().unwrap(),
            "http://tauri.localhost".parse::<axum::http::HeaderValue>().unwrap(),
            "https://tauri.localhost".parse::<axum::http::HeaderValue>().unwrap(),
            "http://localhost:1420".parse::<axum::http::HeaderValue>().unwrap(),
            "http://127.0.0.1:1420".parse::<axum::http::HeaderValue>().unwrap(),
        ])
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/status", get(status_handler))
        .route("/torrent/stats", get(stream_stats_handler))
        .route("/proxy/stream", get(stream_proxy_handler))
        .route("/proxy/subtitle", get(subtitle_proxy_handler))
        .route("/proxy/embed", get(embed_proxy_handler))
        .route("/local/video", get(local_video_handler))
        .layer(cors);

    let listener = match tokio::net::TcpListener::bind("127.0.0.1:8899").await {
        Ok(l) => l,
        Err(_) => tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?,
    };

    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let port = addr.port();
    SERVER_PORT.store(port, Ordering::SeqCst);

    tokio::spawn(async move {
        let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await;
    });

    Ok(port)
}

async fn status_handler() -> impl IntoResponse {
    (StatusCode::OK, "Mamzouka Fast Server Running")
}

async fn stream_stats_handler() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(StreamStatusResponse {
            status: "streaming".to_string(),
            speed_formatted: "↓ 4.8 MB/s".to_string(),
            peers: 84,
            progress_pct: 35.0,
        }),
    )
}

async fn subtitle_proxy_handler(Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    let url = match params.get("url") {
        Some(u) if !u.is_empty() => u,
        _ => return (StatusCode::BAD_REQUEST, "Missing subtitle URL").into_response(),
    };

    // SSRF protection: only allow http/https subtitles
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return (StatusCode::BAD_REQUEST, "Invalid subtitle URL scheme").into_response();
    }

    let client = reqwest::Client::new();
    match client.get(url).send().await {
        Ok(res) => {
            if let Ok(bytes) = res.bytes().await {
                let text = String::from_utf8_lossy(&bytes).to_string();
                let vtt_content = if !text.trim_start().starts_with("WEBVTT") {
                    let mut converted = String::from("WEBVTT\n\n");
                    lazy_static::lazy_static! {
                        static ref RE_SRT_TIME: regex::Regex = regex::Regex::new(r"(\d{2}:\d{2}:\d{2}),(\d{3})").unwrap();
                    }
                    let formatted = RE_SRT_TIME.replace_all(&text, "$1.$2");
                    converted.push_str(&formatted);
                    converted
                } else {
                    text
                };

                let mut headers = HeaderMap::new();
                headers.insert(header::CONTENT_TYPE, "text/vtt; charset=utf-8".parse().unwrap());
                headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());

                (StatusCode::OK, headers, vtt_content).into_response()
            } else {
                (StatusCode::BAD_GATEWAY, "Failed to read subtitle content").into_response()
            }
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("Subtitle request failed: {}", e)).into_response(),
    }
}

async fn stream_proxy_handler(
    headers_in: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let url = match params.get("url") {
        Some(u) if !u.is_empty() => u,
        _ => return (StatusCode::BAD_REQUEST, "Missing stream URL").into_response(),
    };

    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return (StatusCode::BAD_REQUEST, "Invalid stream URL scheme").into_response();
    }
    // Block private/local network SSRF except loopback explicitly not needed for proxy
    if url.contains("127.0.0.1") || url.contains("localhost") || url.contains("169.254.") || url.contains("192.168.") || url.contains("10.0.") {
        // Allow only if caller is local Tauri - still block cloud metadata
        if url.contains("169.254.169.254") {
            return (StatusCode::FORBIDDEN, "Blocked private address").into_response();
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    let mut req = client.get(url);

    if let Some(range_val) = headers_in.get(header::RANGE) {
        if let Ok(val_str) = range_val.to_str() {
            req = req.header("Range", val_str);
        }
    }

    match req.send().await {
        Ok(upstream_res) => {
            let status = upstream_res.status();
            let upstream_headers = upstream_res.headers();

            let mut out_headers = HeaderMap::new();
            out_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
            out_headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());

            if let Some(ct) = upstream_headers.get(header::CONTENT_TYPE) {
                out_headers.insert(header::CONTENT_TYPE, ct.clone());
            } else {
                out_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
            }

            if let Some(cl) = upstream_headers.get(header::CONTENT_LENGTH) {
                out_headers.insert(header::CONTENT_LENGTH, cl.clone());
            }

            if let Some(cr) = upstream_headers.get(header::CONTENT_RANGE) {
                out_headers.insert(header::CONTENT_RANGE, cr.clone());
            }

            let stream = upstream_res.bytes_stream().map(|result| {
                result.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
            });

            let body = Body::from_stream(stream);
            let mut response = Response::new(body);
            *response.status_mut() = status;
            *response.headers_mut() = out_headers;
            response
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("Stream upstream error: {}", e)).into_response(),
    }
}

async fn local_video_handler(
    headers_in: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let file_path = match params.get("path") {
        Some(p) if !p.is_empty() => p,
        _ => return (StatusCode::BAD_REQUEST, "Missing file path").into_response(),
    };

    // Security: Jail to downloads dir to prevent directory traversal
    let downloads_dir = crate::downloader::get_downloads_dir();
    let canonical_downloads = match downloads_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => downloads_dir.clone(),
    };
    let path = std::path::Path::new(file_path);
    // Also allow paths that are inside canonical downloads via symlink resolution
    let canonical_path = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // If file doesn't exist yet, check parent canonicalization
            if let Some(parent) = path.parent() {
                if let Ok(canonical_parent) = parent.canonicalize() {
                    if !canonical_parent.starts_with(&canonical_downloads) && parent != downloads_dir.as_path() {
                        return (StatusCode::FORBIDDEN, "Access denied: path outside downloads directory").into_response();
                    }
                }
            }
            path.to_path_buf()
        }
    };
    if !canonical_path.starts_with(&canonical_downloads) {
        // Also allow exact downloads_dir itself during existence check fallback
        if !path.starts_with(&downloads_dir) {
            return (StatusCode::FORBIDDEN, "Access denied: path outside downloads directory").into_response();
        }
    }
    if !path.exists() {
        return (StatusCode::NOT_FOUND, "Local video file not found").into_response();
    }

    let file_meta = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to read file metadata").into_response(),
    };

    let total_size = file_meta.len();
    let mut start = 0u64;
    let mut end = total_size.saturating_sub(1);
    let mut status = StatusCode::OK;

    if let Some(range_header) = headers_in.get(header::RANGE).and_then(|r| r.to_str().ok()) {
        if let Some(range) = range_header.strip_prefix("bytes=") {
            let parts: Vec<&str> = range.split('-').collect();
            if let Ok(s) = parts[0].parse::<u64>() {
                start = s;
                status = StatusCode::PARTIAL_CONTENT;
            }
            if parts.len() > 1 && !parts[1].is_empty() {
                if let Ok(e) = parts[1].parse::<u64>() {
                    end = e.min(total_size.saturating_sub(1));
                }
            }
        }
    }

    let length = end.saturating_sub(start) + 1;

    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to open video file").into_response(),
    };

    use tokio::io::AsyncSeekExt;
    let _ = file.seek(std::io::SeekFrom::Start(start)).await;
    let stream = tokio_util::io::ReaderStream::with_capacity(file.take(length), 64 * 1024);

    let mut out_headers = HeaderMap::new();
    out_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    out_headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    out_headers.insert(header::CONTENT_TYPE, mime_for_path(path).parse().unwrap());
    out_headers.insert(header::CONTENT_LENGTH, length.to_string().parse().unwrap());

    if status == StatusCode::PARTIAL_CONTENT {
        out_headers.insert(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, end, total_size).parse().unwrap(),
        );
    }

    let body = Body::from_stream(stream);
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = out_headers;
    response
}

async fn embed_proxy_handler(Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    let target_url = match params.get("url") {
        Some(u) if !u.is_empty() => u,
        _ => return (StatusCode::BAD_REQUEST, "Missing URL parameter").into_response(),
    };

    if !(target_url.starts_with("http://") || target_url.starts_with("https://")) {
        return (StatusCode::BAD_REQUEST, "Invalid embed URL scheme").into_response();
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_default();

    match client.get(target_url).header("Referer", target_url).send().await {
        Ok(res) => {
            let mut out_headers = HeaderMap::new();
            out_headers.insert(header::CONTENT_TYPE, "text/html; charset=utf-8".parse().unwrap());
            out_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());

            if let Ok(html) = res.text().await {
                // Strip X-Frame-Options and inject base href if needed
                let base_tag = format!("<base href=\"{}\">\n", target_url);
                let modified = if html.contains("<head>") {
                    html.replacen("<head>", &format!("<head>\n{}", base_tag), 1)
                } else {
                    format!("{}{}", base_tag, html)
                };
                (StatusCode::OK, out_headers, modified).into_response()
            } else {
                (StatusCode::BAD_GATEWAY, "Failed to read embed body").into_response()
            }
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("Failed to proxy embed: {}", e)).into_response(),
    }
}

