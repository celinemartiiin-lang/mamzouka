use serde::{Deserialize, Serialize};
use lazy_static::lazy_static;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TorrentStream {
    pub name: String,
    pub title: String,
    pub info_hash: Option<String>,
    pub file_idx: Option<u32>,
    pub magnet_uri: Option<String>,
    pub stream_url: Option<String>,
    pub resolution: String,       // "4K", "1080p", "720p", "SD"
    pub quality: String,          // "BluRay", "WEB-DL", "HDR", "HDR10+", "DV"
    pub size_formatted: String,   // "2.4 GB"
    pub size_bytes: Option<u64>,
    pub seeders: u32,
    pub peers: u32,
    pub provider: String,         // "Real-Debrid", "Torrentio", "YTS", "VidSrc"
    pub audio_channels: Option<String>,
    pub flags: Option<String>,    // Emojis: "🇬🇧 🇫🇷 🇸🇦"
    pub languages: Vec<String>,
    pub is_debrid: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SubtitleTrack {
    pub id: String,
    pub language: String,
    pub language_code: String,
    pub url: String,
    pub format: String, // "vtt" or "srt"
}

pub struct TorrentClient {
    client: reqwest::Client,
}

impl TorrentClient {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .build()
            .unwrap_or_default();
        Self { client }
    }

    /// Fetches streams with full flag metadata, language detection, Real-Debrid support, and direct servers.
    /// `torrentio_base`: remote-controlled mirror (fallback to default on failure).
    /// `disabled_providers`: remote kill-switches, e.g. ["torrentio", "yts"].
    pub async fn get_streams(
        &self,
        media_type: &str, // "movie", "tv", "series", "anime"
        raw_id: &str,
        tmdb_id: Option<u64>,
        season: Option<u32>,
        episode: Option<u32>,
        debrid_token: Option<String>,
        torrentio_base: Option<String>,
        disabled_providers: Option<Vec<String>>,
    ) -> Result<Vec<TorrentStream>, String> {
        let mut streams = Vec::new();
        let is_series = media_type == "tv" || media_type == "series" || media_type == "anime";
        let target_stream_type = if is_series { "series" } else { "movie" };
        let sea = season.unwrap_or(1);
        let ep = episode.unwrap_or(1);

        // Normalize TMDB and IMDb ID
        let mut imdb_formatted_id = if raw_id.starts_with("tt") {
            raw_id.to_string()
        } else {
            String::new()
        };

        // If no IMDb ID provided, resolve it dynamically from TMDB external_ids
        if imdb_formatted_id.is_empty() {
            let numeric_id = tmdb_id.map(|t| t.to_string()).unwrap_or_else(|| raw_id.trim_start_matches("tt").to_string());
            let tmdb_type = if is_series { "tv" } else { "movie" };
            let ext_url = format!("https://api.themoviedb.org/3/{}/{}/external_ids?api_key=0ea8d8ca2abeb5fa061faf1a966747b4", tmdb_type, numeric_id);
            if let Ok(res) = self.client.get(&ext_url).send().await {
                if let Ok(json) = res.json::<serde_json::Value>().await {
                    if let Some(imdb) = json.get("imdb_id").and_then(|i| i.as_str()) {
                        if imdb.starts_with("tt") {
                            imdb_formatted_id = imdb.to_string();
                        }
                    }
                }
            }
        }

        // TMDB numeric ID for embed services (they need TMDB IDs, not IMDb)
        let embed_id = if let Some(tid) = tmdb_id {
            tid.to_string()
        } else if !raw_id.starts_with("tt") {
            raw_id.to_string()
        } else {
            raw_id.trim_start_matches("tt").to_string()
        };

        let torrentio_query_id = if is_series {
            format!("{}:{}:{}", imdb_formatted_id, sea, ep)
        } else {
            imdb_formatted_id.clone()
        };

        // 1. Working Direct CDN Embed Streams — Fallback servers
        if is_series {
            let vidsrc_su = format!("https://vidsrc.su/embed/tv/{}/{}/{}", embed_id, sea, ep);
            streams.push(TorrentStream {
                name: "VidSrc SU [Web Server]".to_string(),
                title: format!("S{}:E{} - Multi-CDN Fallback Server", sea, ep),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(vidsrc_su),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "VidSrc SU".to_string(),
                audio_channels: Some("Stereo".to_string()),
                flags: Some("🇬🇧 🇫🇷 🇸🇦".to_string()),
                languages: vec!["English".to_string(), "Arabic".to_string()],
                is_debrid: false,
            });

            let vidlink_url = format!("https://vidlink.pro/tv/{}/{}/{}", embed_id, sea, ep);
            streams.push(TorrentStream {
                name: "VidLink Pro [Web Server]".to_string(),
                title: format!("S{}:E{} - Multi-Language Direct Server", sea, ep),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(vidlink_url),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "VidLink Pro".to_string(),
                audio_channels: None,
                flags: Some("🇸🇦 🇲🇦 🇬🇧 🇪🇸".to_string()),
                languages: vec!["Arabic".to_string(), "English".to_string(), "Spanish".to_string()],
                is_debrid: true,
            });

            let smashy_url = format!("https://embed.smashystream.com/playere.php?tmdb={}&season={}&episode={}", embed_id, sea, ep);
            streams.push(TorrentStream {
                name: "SmashyStream [Web Server]".to_string(),
                title: format!("S{}:E{} - Smashy Fast CDN", sea, ep),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(smashy_url),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "SmashyStream".to_string(),
                audio_channels: None,
                flags: Some("🇬🇧 🇫🇷 🇸🇦".to_string()),
                languages: vec!["English".to_string(), "Arabic".to_string()],
                is_debrid: false,
            });

            let embedsu_url = format!("https://embed.su/embed/tv/{}/{}/{}", embed_id, sea, ep);
            streams.push(TorrentStream {
                name: "Embed.su [Web Server]".to_string(),
                title: format!("S{}:E{} - Embed.su HD Server", sea, ep),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(embedsu_url),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "Embed.su".to_string(),
                audio_channels: None,
                flags: Some("🇬🇧 🇸🇦 🇲🇦".to_string()),
                languages: vec!["English".to_string(), "Arabic".to_string()],
                is_debrid: false,
            });

            let autoembed_url = format!("https://player.autoembed.co/embed/tv/{}/{}/{}", embed_id, sea, ep);
            streams.push(TorrentStream {
                name: "AutoEmbed CO [Web Server]".to_string(),
                title: format!("S{}:E{} - High Speed Adaptive HD Server", sea, ep),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(autoembed_url),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "AutoEmbed CO".to_string(),
                audio_channels: None,
                flags: Some("🇬🇧 🇫🇷 🇸🇦".to_string()),
                languages: vec!["English".to_string(), "Arabic".to_string()],
                is_debrid: false,
            });

            let embed2_url = format!("https://www.2embed.cc/embedtv/{}&s={}&e={}", embed_id, sea, ep);
            streams.push(TorrentStream {
                name: "2Embed [Web Server]".to_string(),
                title: format!("S{}:E{} - Global CDN Backup Server", sea, ep),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(embed2_url),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "2Embed".to_string(),
                audio_channels: None,
                flags: Some("🇬🇧 🇫🇷 🇩🇪".to_string()),
                languages: vec!["English".to_string(), "French".to_string()],
                is_debrid: false,
            });
        } else {
            let vidsrc_su = format!("https://vidsrc.su/embed/movie/{}", embed_id);
            streams.push(TorrentStream {
                name: "VidSrc SU [Web Server]".to_string(),
                title: "Multi-CDN Fallback Server".to_string(),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(vidsrc_su),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "VidSrc SU".to_string(),
                audio_channels: Some("Stereo".to_string()),
                flags: Some("🇬🇧 🇫🇷 🇸🇦".to_string()),
                languages: vec!["English".to_string(), "Arabic".to_string()],
                is_debrid: false,
            });

            let vidlink_url = format!("https://vidlink.pro/movie/{}", embed_id);
            streams.push(TorrentStream {
                name: "VidLink Pro [Web Server]".to_string(),
                title: "Multi-Language Direct Server".to_string(),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(vidlink_url),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "VidLink Pro".to_string(),
                audio_channels: None,
                flags: Some("🇸🇦 🇲🇦 🇬🇧 🇪🇸".to_string()),
                languages: vec!["Arabic".to_string(), "English".to_string(), "Spanish".to_string()],
                is_debrid: false,
            });

            let smashy_url = format!("https://embed.smashystream.com/playere.php?tmdb={}", embed_id);
            streams.push(TorrentStream {
                name: "SmashyStream [Web Server]".to_string(),
                title: "Smashy Fast CDN".to_string(),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(smashy_url),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "SmashyStream".to_string(),
                audio_channels: None,
                flags: Some("🇬🇧 🇫🇷 🇸🇦".to_string()),
                languages: vec!["English".to_string(), "Arabic".to_string()],
                is_debrid: false,
            });

            let embedsu_url = format!("https://embed.su/embed/movie/{}", embed_id);
            streams.push(TorrentStream {
                name: "Embed.su [Web Server]".to_string(),
                title: "Embed.su HD Server".to_string(),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(embedsu_url),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "Embed.su".to_string(),
                audio_channels: None,
                flags: Some("🇬🇧 🇸🇦 🇲🇦".to_string()),
                languages: vec!["English".to_string(), "Arabic".to_string()],
                is_debrid: false,
            });

            let autoembed_url = format!("https://player.autoembed.co/embed/movie/{}", embed_id);
            streams.push(TorrentStream {
                name: "AutoEmbed CO [Web Server]".to_string(),
                title: "High Speed Adaptive HD Server".to_string(),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(autoembed_url),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "AutoEmbed CO".to_string(),
                audio_channels: None,
                flags: Some("🇬🇧 🇫🇷 🇸🇦".to_string()),
                languages: vec!["English".to_string(), "Arabic".to_string()],
                is_debrid: false,
            });

            let embed2_url = format!("https://www.2embed.cc/embed/{}", embed_id);
            streams.push(TorrentStream {
                name: "2Embed [Web Server]".to_string(),
                title: "Global CDN Backup Server".to_string(),
                info_hash: None,
                file_idx: None,
                magnet_uri: None,
                stream_url: Some(embed2_url),
                resolution: "1080p".to_string(),
                quality: "Web Embed".to_string(),
                size_formatted: "Instant".to_string(),
                size_bytes: None,
                seeders: 0,
                peers: 0,
                provider: "2Embed".to_string(),
                audio_channels: None,
                flags: Some("🇬🇧 🇫🇷 🇩🇪".to_string()),
                languages: vec!["English".to_string(), "French".to_string()],
                is_debrid: false,
            });
        }


        // 2. Query Torrentio (with Real-Debrid API if provided)
        // Remote kill-switch: skip entirely when disabled from the free DB.
        let disabled = disabled_providers.unwrap_or_default();
        let disabled_lc: Vec<String> = disabled.iter().map(|d| d.to_lowercase()).collect();
        let skip_torrentio = disabled_lc.iter().any(|d| d == "torrentio");
        let skip_yts = disabled_lc.iter().any(|d| d == "yts");

        const DEFAULT_TORRENTIO: &str = "https://torrentio.strem.fun";
        let custom_base: Option<String> = torrentio_base
            .map(|b| b.trim().trim_end_matches('/').to_string())
            .filter(|b| b.starts_with("http://") || b.starts_with("https://"));
        // Candidate bases: remote mirror first, compiled default as fallback.
        let mut bases: Vec<String> = Vec::new();
        if let Some(ref cb) = custom_base {
            if cb != DEFAULT_TORRENTIO {
                bases.push(cb.clone());
            }
        }
        bases.push(DEFAULT_TORRENTIO.to_string());

        if !skip_torrentio {
        for base_root in &bases {
        let torrentio_base_url = if let Some(ref token) = debrid_token {
            if !token.trim().is_empty() {
                format!("{}/realdebrid={}", base_root, token.trim())
            } else {
                base_root.clone()
            }
        } else {
            base_root.clone()
        };

        let torrentio_url = format!("{}/stream/{}/{}.json", torrentio_base_url, target_stream_type, torrentio_query_id);
        let mut fetched_ok = false;
        if let Ok(res) = self.client.get(&torrentio_url).send().await {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(stream_arr) = json.get("streams").and_then(|s| s.as_array()) {
                    for s in stream_arr {
                        let raw_name = s.get("name").and_then(|n| n.as_str()).unwrap_or("Torrentio").to_string();
                        let raw_title = s.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
                        let info_hash = s.get("infoHash").and_then(|h| h.as_str()).map(|h| h.to_lowercase());
                        let file_idx = s.get("fileIdx").and_then(|f| f.as_u64()).map(|f| f as u32);
                        let direct_url = s.get("url").and_then(|u| u.as_str()).map(|u| u.to_string());

                        // Split title to get actual release filename on line 1 and metadata on subsequent lines
                        let title_lines: Vec<&str> = raw_title.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
                        let raw_release_name = title_lines.first().cloned().unwrap_or(&raw_title);

                        let (res, qual, size, seeders, flags, langs, audio) = parse_rich_torrent_meta(&raw_name, &raw_title);

                        let magnet = if let Some(ref hash) = info_hash {
                            Some(build_magnet_uri(hash, raw_release_name))
                        } else {
                            None
                        };

                        let is_debrid = raw_name.contains("[RD+]") || raw_name.contains("[RD]") || direct_url.is_some();
                        let provider_name = if is_debrid {
                            "⚡ Real-Debrid [Instant HD]".to_string()
                        } else {
                            extract_provider_name(&raw_title)
                        };

                        // Create clean, human-readable display title
                        let display_title = if is_series {
                            format!("S{}:E{} • {}", sea, ep, raw_release_name)
                        } else {
                            raw_release_name.to_string()
                        };

                        let display_name = if is_debrid {
                            format!("⚡ Real-Debrid • {}", provider_name)
                        } else {
                            format!("Torrentio • {}", provider_name)
                        };

                        streams.push(TorrentStream {
                            name: display_name,
                            title: display_title,
                            info_hash,
                            file_idx,
                            magnet_uri: magnet,
                            stream_url: direct_url,
                            resolution: res,
                            quality: qual,
                            size_formatted: size,
                            size_bytes: None,
                            seeders,
                            peers: 0,
                            provider: provider_name,
                            audio_channels: audio,
                            flags,
                            languages: langs,
                            is_debrid,
                        });
                    }
                    fetched_ok = true;
                }
            }
            }
            if fetched_ok {
                break;
            }
        }
        }

        // 3. Query YTS API for Movies (remote kill-switch aware)
        if !skip_yts && !is_series && raw_id.starts_with("tt") {
            let yts_url = format!("https://yts.mx/api/v2/list_movies.json?query_term={}", raw_id);
            if let Ok(res) = self.client.get(&yts_url).send().await {
                if let Ok(json) = res.json::<serde_json::Value>().await {
                    if let Some(movies) = json.get("data").and_then(|d| d.get("movies")).and_then(|m| m.as_array()) {
                        if let Some(movie) = movies.first() {
                            if let Some(torrents) = movie.get("torrents").and_then(|t| t.as_array()) {
                                for t in torrents {
                                    let quality = t.get("quality").and_then(|q| q.as_str()).unwrap_or("720p").to_string();
                                    let torrent_type = t.get("type").and_then(|t| t.as_str()).unwrap_or("bluray").to_string();
                                    let size_str = t.get("size").and_then(|s| s.as_str()).unwrap_or("").to_string();
                                    let seeders = t.get("seeds").and_then(|s| s.as_u64()).unwrap_or(0) as u32;
                                    let peers = t.get("peers").and_then(|p| p.as_u64()).unwrap_or(0) as u32;
                                    let hash = t.get("hash").and_then(|h| h.as_str()).unwrap_or("").to_lowercase();
                                    let movie_title = movie.get("title_long").and_then(|tl| tl.as_str()).unwrap_or("Movie");

                                    let magnet = build_magnet_uri(&hash, movie_title);

                                    streams.push(TorrentStream {
                                        name: format!("YTS [{}]", quality),
                                        title: format!("{} [{} - {}]", movie_title, quality, torrent_type.to_uppercase()),
                                        info_hash: Some(hash),
                                        file_idx: Some(0),
                                        magnet_uri: Some(magnet),
                                        stream_url: None,
                                        resolution: quality.clone(),
                                        quality: torrent_type.to_uppercase(),
                                        size_formatted: size_str,
                                        size_bytes: None,
                                        seeders,
                                        peers,
                                        provider: "YTS".to_string(),
                                        audio_channels: Some("AAC 2.0".to_string()),
                                        flags: Some("🇬🇧 English".to_string()),
                                        languages: vec!["English".to_string()],
                                        is_debrid: false,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        // Sort: Real-Debrid First, then Torrents with seeds, then other torrents, then Web Embeds
        streams.sort_by(|a, b| {
            if a.is_debrid && !b.is_debrid {
                return std::cmp::Ordering::Less;
            }
            if !a.is_debrid && b.is_debrid {
                return std::cmp::Ordering::Greater;
            }
            // Real media (magnet / info_hash) before web embed iframes
            let a_has_media = a.magnet_uri.is_some() || a.info_hash.is_some();
            let b_has_media = b.magnet_uri.is_some() || b.info_hash.is_some();
            if a_has_media && !b_has_media {
                return std::cmp::Ordering::Less;
            }
            if !a_has_media && b_has_media {
                return std::cmp::Ordering::Greater;
            }
            b.seeders.cmp(&a.seeders)
        });

        Ok(streams)
    }

    /// Fetches subtitles from OpenSubtitles and Stremio subtitle providers
    pub async fn get_subtitles(
        &self,
        imdb_id: &str,
        season: Option<u32>,
        episode: Option<u32>,
    ) -> Result<Vec<SubtitleTrack>, String> {
        let mut subs = Vec::new();

        let sub_id = if let (Some(s), Some(e)) = (season, episode) {
            format!("{}:{}:{}", imdb_id, s, e)
        } else {
            imdb_id.to_string()
        };

        let sub_url = format!("https://opensubtitles-v3.strem.fun/subtitles/series/{}.json", sub_id);
        let movie_sub_url = format!("https://opensubtitles-v3.strem.fun/subtitles/movie/{}.json", sub_id);
        let target_url = if season.is_some() { sub_url } else { movie_sub_url };

        if let Ok(res) = self.client.get(&target_url).send().await {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(sub_arr) = json.get("subtitles").and_then(|s| s.as_array()) {
                    for (i, s) in sub_arr.iter().enumerate() {
                        let lang = s.get("lang").and_then(|l| l.as_str()).unwrap_or("ara");
                        let url = s.get("url").and_then(|u| u.as_str()).unwrap_or("");
                        let id = s.get("id").and_then(|id| id.as_str()).unwrap_or(&i.to_string()).to_string();

                        if !url.is_empty() {
                            let (name, code) = match lang {
                                "ara" | "ar" => ("Arabic (العربية)", "ar"),
                                "eng" | "en" => ("English", "en"),
                                "fre" | "fr" => ("French (Français)", "fr"),
                                "spa" | "es" => ("Spanish (Español)", "es"),
                                _ => (lang, lang),
                            };

                            subs.push(SubtitleTrack {
                                id,
                                language: name.to_string(),
                                language_code: code.to_string(),
                                url: url.to_string(),
                                format: if url.ends_with(".srt") { "srt".to_string() } else { "vtt".to_string() },
                            });
                        }
                    }
                }
            }
        }

        // Sort: Arabic first, then English, then French
        subs.sort_by(|a, b| {
            let rank = |code: &str| match code {
                "ar" => 1,
                "en" => 2,
                "fr" => 3,
                _ => 4,
            };
            rank(&a.language_code).cmp(&rank(&b.language_code))
        });

        Ok(subs)
    }
}

fn parse_rich_torrent_meta(name: &str, title: &str) -> (String, String, String, u32, Option<String>, Vec<String>, Option<String>) {
    let combined = format!("{} {}", name, title).to_uppercase();

    let resolution = if combined.contains("4K") || combined.contains("2160P") || combined.contains("UHD") {
        "4K".to_string()
    } else if combined.contains("1080P") || combined.contains("FHD") {
        "1080p".to_string()
    } else if combined.contains("720P") || combined.contains("HD") {
        "720p".to_string()
    } else {
        "1080p".to_string()
    };

    let quality = if combined.contains("REMUX") {
        "4K REMUX".to_string()
    } else if combined.contains("BLURAY") || combined.contains("BLU-RAY") {
        "BluRay".to_string()
    } else if combined.contains("HDR10+") {
        "HDR10+".to_string()
    } else if combined.contains("HDR") {
        "HDR".to_string()
    } else if combined.contains("DV") || combined.contains("DOVI") || combined.contains("DOLBY VISION") {
        "Dolby Vision".to_string()
    } else if combined.contains("WEB-DL") || combined.contains("WEBDL") || combined.contains("WEB") {
        "WEB-DL".to_string()
    } else {
        "WEB-DL".to_string()
    };

    let audio = if combined.contains("ATMOS") {
        Some("Dolby Atmos".to_string())
    } else if combined.contains("DDP5.1") || combined.contains("E-AC3") || combined.contains("EAC3") {
        Some("Dolby Digital+ 5.1".to_string())
    } else if combined.contains("AC3") || combined.contains("DD5.1") {
        Some("Dolby Digital 5.1".to_string())
    } else if combined.contains("DTS-HD") || combined.contains("DTS") {
        Some("DTS 5.1".to_string())
    } else if combined.contains("AAC") {
        Some("AAC 2.0".to_string())
    } else {
        None
    };

    lazy_static! {
        static ref RE_SIZE: regex::Regex = regex::Regex::new(r"(\d+(?:\.\d+)?\s*(?:GB|MB|GiB|MiB))").unwrap();
        static ref RE_SEEDS: regex::Regex = regex::Regex::new(r"(?:👤|👥|seeds?|peers?)[\s:]*(\d+)").unwrap();
        static ref RE_SEEDS_FALLBACK: regex::Regex = regex::Regex::new(r"(\d+)\s*(?:seeds|peers|s)").unwrap();
    }
    let size = RE_SIZE
        .captures(&title)
        .or_else(|| RE_SIZE.captures(&combined))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "1.5 GB".to_string());

    let seeders = RE_SEEDS
        .captures(title)
        .or_else(|| RE_SEEDS.captures(&combined))
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u32>().ok())
        .or_else(|| {
            RE_SEEDS_FALLBACK
                .captures(title)
                .and_then(|c| c.get(1))
                .and_then(|m| m.as_str().parse::<u32>().ok())
        })
        .unwrap_or(0);

    // Extract Flag emojis and Languages
    let mut flags_vec = Vec::new();
    let mut langs_vec = Vec::new();

    // Check for flags in raw title
    for (flag_emoji, lang_name) in [
        ("🇬🇧", "English"),
        ("🇫🇷", "French"),
        ("🇪🇸", "Spanish"),
        ("🇩🇪", "German"),
        ("🇮🇹", "Italian"),
        ("🇵🇹", "Portuguese"),
        ("🇸🇦", "Arabic"),
        ("🇲🇦", "Arabic"),
        ("🇷🇺", "Russian"),
        ("🇯🇵", "Japanese"),
        ("🇰🇷", "Korean"),
        ("🇨🇳", "Chinese"),
        ("🇮🇳", "Hindi"),
    ] {
        if title.contains(flag_emoji) {
            if !flags_vec.contains(&flag_emoji.to_string()) {
                flags_vec.push(flag_emoji.to_string());
                langs_vec.push(lang_name.to_string());
            }
        }
    }

    // Text language checks if no emojis
    if flags_vec.is_empty() {
        if combined.contains("FRE") || combined.contains("FRENCH") || combined.contains("VFF") || combined.contains("TRUEFRENCH") {
            flags_vec.push("🇫🇷".to_string());
            langs_vec.push("French".to_string());
        }
        if combined.contains("SPA") || combined.contains("SPANISH") || combined.contains("LATINO") || combined.contains("CASTELLANO") {
            flags_vec.push("🇪🇸".to_string());
            langs_vec.push("Spanish".to_string());
        }
        if combined.contains("ITA") || combined.contains("ITALIAN") {
            flags_vec.push("🇮🇹".to_string());
            langs_vec.push("Italian".to_string());
        }
        if combined.contains("GER") || combined.contains("GERMAN") {
            flags_vec.push("🇩🇪".to_string());
            langs_vec.push("German".to_string());
        }
        if combined.contains("ARA") || combined.contains("ARABIC") {
            flags_vec.push("🇸🇦".to_string());
            langs_vec.push("Arabic".to_string());
        }
        if combined.contains("ENG") || combined.contains("ENGLISH") || flags_vec.is_empty() {
            flags_vec.push("🇬🇧".to_string());
            langs_vec.push("English".to_string());
        }
    }

    let flags_str = if !flags_vec.is_empty() {
        Some(flags_vec.join(" "))
    } else {
        Some("🇬🇧".to_string())
    };

    (resolution, quality, size, seeders, flags_str, langs_vec, audio)
}

fn extract_provider_name(title: &str) -> String {
    lazy_static! {
        static ref RE_GEAR: regex::Regex = regex::Regex::new(r"⚙️\s*([^\n\r]+)").unwrap();
    }
    if let Some(caps) = RE_GEAR.captures(title) {
        if let Some(m) = caps.get(1) {
            let prov = m.as_str().trim();
            if !prov.is_empty() {
                return prov.to_string();
            }
        }
    }

    let t_upper = title.to_uppercase();
    if t_upper.contains("1337X") {
        "1337x".to_string()
    } else if t_upper.contains("RARBG") {
        "RARBG".to_string()
    } else if t_upper.contains("TORRENTGALAXY") || t_upper.contains("TGX") {
        "TorrentGalaxy".to_string()
    } else if t_upper.contains("THEPIRATEBAY") || t_upper.contains("TPB") {
        "ThePirateBay".to_string()
    } else if t_upper.contains("EZTV") {
        "EZTV".to_string()
    } else if t_upper.contains("YTS") {
        "YTS".to_string()
    } else if t_upper.contains("BADR") || t_upper.contains("AKWAM") || t_upper.contains("MYCIMA") {
        "Arabic Source".to_string()
    } else {
        "Torrentio".to_string()
    }
}

fn build_magnet_uri(info_hash: &str, title: &str) -> String {
    let trackers = [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://tracker.bittor.pw:1337/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "udp://explodie.org:6969/announce",
        "udp://open.demonii.com:1337/announce",
        "udp://tracker.dler.org:6969/announce",
        "udp://p4p.arenabg.com:1337/announce",
        "http://tracker.openbittorrent.com:80/announce",
        "wss://tracker.openwebtorrent.com",
        "wss://tracker.btorrent.xyz",
        "wss://tracker.webtorrent.dev",
        "wss://tracker.files.fm:7073/announce",
    ];

    let mut magnet = format!("magnet:?xt=urn:btih:{}&dn={}", info_hash, urlencoding::encode(title));
    for tr in trackers {
        magnet.push_str("&tr=");
        magnet.push_str(&urlencoding::encode(tr));
    }
    magnet
}
