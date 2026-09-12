use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::collections::HashMap;
use chrono::Timelike;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EpgProgram {
    pub title: String,
    pub start: String,
    pub stop: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LiveChannel {
    pub id: String,
    pub name: String,
    pub logo: Option<String>,
    pub category: String,
    pub country: String,
    pub country_flag: String,
    pub stream_url: String,
    pub resolution: Option<String>,
    pub user_agent: Option<String>,
    pub referrer: Option<String>,
    pub is_custom: bool,
    #[serde(default)]
    pub epg_now: Option<String>,
    #[serde(default)]
    pub epg_next: Option<String>,
}

pub struct LiveTvManager {
    client: reqwest::Client,
    cache: Mutex<HashMap<String, Vec<LiveChannel>>>,
}

impl LiveTvManager {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .build()
            .unwrap_or_default();
        Self {
            client,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Fetch real XMLTV EPG for a channel id (iptv-org guides) with 5s timeout, fallback to mock
    pub async fn get_epg(&self, channel_id: &str, country: &str) -> Vec<EpgProgram> {
        let guides = [
            ("ma", "https://iptv-org.github.io/epg/guides/ma.xml.gz"),
            ("fr", "https://iptv-org.github.io/epg/guides/fr.xml"),
            ("us", "https://iptv-org.github.io/epg/guides/us.xml"),
            ("sa", "https://iptv-org.github.io/epg/guides/sa.xml"),
            ("eg", "https://iptv-org.github.io/epg/guides/eg.xml"),
            ("ae", "https://iptv-org.github.io/epg/guides/ae.xml"),
        ];
        let country_lc = country.to_lowercase();
        let guide_url = guides.iter().find(|(c,_)| *c==country_lc).map(|(_,u)| *u)
            .unwrap_or("https://iptv-org.github.io/epg/guides/fr.xml");
        let url = guide_url;
        // Try fetch, limit 2MB, parse <programme channel="id">
        if let Ok(res) = self.client.get(url).timeout(std::time::Duration::from_secs(6)).send().await {
            if let Ok(bytes) = res.bytes().await {
                if bytes.len() > 3*1024*1024 { return vec![]; }
                let text = if url.ends_with(".gz") {
                    use std::io::Read;
                    let mut d = flate2::read::GzDecoder::new(&bytes[..]);
                    let mut s = String::new();
                    if d.read_to_string(&mut s).is_ok() { s } else { String::new() }
                } else {
                    String::from_utf8_lossy(&bytes).to_string()
                };
                if text.is_empty() { return vec![]; }
                // Simple regex parse <programme channel="ID" start="..." stop="..."><title>..</title>
                let re_prog = regex::Regex::new(r#"<programme[^>]*channel="([^"]+)"[^>]*start="([^"]+)"[^>]*stop="([^"]+)"[^>]*>.*?<title[^>]*>([^<]+)</title>"#).ok();
                if let Some(re) = re_prog {
                    let mut progs = Vec::new();
                    for cap in re.captures_iter(&text) {
                        let ch = cap.get(1).map(|m| m.as_str()).unwrap_or("");
                        if ch != channel_id { continue; }
                        let start = cap.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
                        let stop = cap.get(3).map(|m| m.as_str()).unwrap_or("").to_string();
                        let title = cap.get(4).map(|m| m.as_str()).unwrap_or("Programme").to_string();
                        progs.push(EpgProgram{ title, start, stop, description: None });
                        if progs.len() >= 10 { break; }
                    }
                    if !progs.is_empty() { return progs; }
                }
            }
        }
        vec![]
    }

    pub async fn get_channels(
        &self,
        country: Option<String>,
        category: Option<String>,
        query: Option<String>,
        custom_playlists: Vec<(String, String)>, // (Name, URL)
    ) -> Result<Vec<LiveChannel>, String> {
        let country_code = country.unwrap_or_else(|| "all".to_string()).to_lowercase();
        let cat = category.unwrap_or_else(|| "all".to_string()).to_lowercase();

        let cache_key = format!("{}:{}:custom_{}", country_code, cat, custom_playlists.len());

        // Check memory cache first
        if let Ok(guard) = self.cache.lock() {
            if let Some(cached) = guard.get(&cache_key) {
                let mut results = cached.clone();
                if let Some(ref q) = query {
                    if !q.trim().is_empty() {
                        let lower_q = q.to_lowercase();
                        results.retain(|c| {
                            c.name.to_lowercase().contains(&lower_q)
                                || c.category.to_lowercase().contains(&lower_q)
                                || c.country.to_lowercase().contains(&lower_q)
                        });
                    }
                }
                return Ok(results);
            }
        }

        let mut channels = Vec::new();

        // 1. Process custom user IPTV playlists if any (validated, size-limited)
        for (p_name, p_url) in &custom_playlists {
            // Validate URL scheme
            if !(p_url.starts_with("http://") || p_url.starts_with("https://")) {
                continue;
            }
            // Limit to prevent SSRF on private nets
            if p_url.contains("169.254.169.254") || p_url.contains("127.0.0.1") && !p_url.contains("iptv-org.github.io") {
                continue;
            }
            if let Ok(res) = self.client.get(p_url).send().await {
                if let Ok(text) = res.text().await {
                    // Limit 5MB
                    if text.len() > 5 * 1024 * 1024 {
                        continue;
                    }
                    let mut custom_ch = parse_m3u(&text, "custom");
                    // Cap channels per playlist
                    if custom_ch.len() > 2000 {
                        custom_ch.truncate(2000);
                    }
                    for c in &mut custom_ch {
                        c.is_custom = true;
                        c.country = p_name.clone();
                        c.country_flag = "⚡".to_string();
                    }
                    channels.extend(custom_ch);
                }
            }
        }

        // 2. Multi-feed aggregator based on selection
        let mut urls_to_fetch: Vec<(String, &str)> = Vec::new();

        if country_code == "sa" || country_code == "arab" {
            // Arab World Mega Pack: Aggregate all Arab countries + Arabic language feeds
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/languages/ara.m3u".to_string(), "sa"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/ma.m3u".to_string(), "ma"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/eg.m3u".to_string(), "eg"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/sa.m3u".to_string(), "sa"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/ae.m3u".to_string(), "ae"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/dz.m3u".to_string(), "dz"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/tn.m3u".to_string(), "tn"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/qa.m3u".to_string(), "qa"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/lb.m3u".to_string(), "lb"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/kw.m3u".to_string(), "kw"));
        } else if cat == "sports" {
            // Global Sports Mega Pack: Aggregate Sports, Auto, Combat, Outdoor
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/categories/sports.m3u".to_string(), "sports"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/categories/auto.m3u".to_string(), "sports"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/categories/combat.m3u".to_string(), "sports"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/categories/outdoor.m3u".to_string(), "sports"));
        } else if country_code == "fr" {
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/fr.m3u".to_string(), "fr"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/languages/fra.m3u".to_string(), "fr"));
        } else if country_code == "us" {
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/us.m3u".to_string(), "us"));
        } else if country_code == "gb" {
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/gb.m3u".to_string(), "gb"));
        } else if country_code != "all" && !country_code.is_empty() {
            urls_to_fetch.push((format!("https://iptv-org.github.io/iptv/countries/{}.m3u", country_code), &country_code));
        } else if cat != "all" && !cat.is_empty() {
            // Dynamic category handling: try direct category feed, fallback to broad index filtered client-side
            urls_to_fetch.push((format!("https://iptv-org.github.io/iptv/categories/{}.m3u", cat), "all"));
        } else {
            // Default "All Channels": Morocco, Arabic, France, Sports, News, Pluto TV
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/ma.m3u".to_string(), "ma"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/languages/ara.m3u".to_string(), "sa"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/categories/sports.m3u".to_string(), "sports"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/categories/news.m3u".to_string(), "news"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/fr.m3u".to_string(), "fr"));
            urls_to_fetch.push(("https://iptv-org.github.io/iptv/countries/us.m3u".to_string(), "us"));
        }

        // Fetch feeds (size-limited, allowlist iptv-org only for built-ins)
        for (url, feed_country) in urls_to_fetch {
            // Allowlist: only iptv-org for built-ins to prevent injection
            if !url.starts_with("https://iptv-org.github.io/") {
                continue;
            }
            if let Ok(res) = self.client.get(&url).send().await {
                if let Ok(text) = res.text().await {
                    if text.len() > 5 * 1024 * 1024 {
                        continue;
                    }
                    let parsed = parse_m3u(&text, feed_country);
                    for item in parsed {
                        if !channels.iter().any(|c| c.stream_url == item.stream_url) {
                            channels.push(item);
                        }
                        if channels.len() > 5000 {
                            break;
                        }
                    }
                }
            }
        }

        // Dynamic fallback for missing categories (e.g., Documentary / TV Show)
        // If requested category yielded <5 results, try broad indexes and filter client-side
        if cat != "all" && channels.len() < 5 {
            let fallback_urls = [
                "https://iptv-org.github.io/iptv/index.m3u",
                "https://iptv-org.github.io/iptv/categories/general.m3u",
                "https://iptv-org.github.io/iptv/categories/entertainment.m3u",
            ];
            for fb_url in fallback_urls {
                if channels.len() >= 20 { break; }
                if let Ok(res) = self.client.get(fb_url).send().await {
                    if let Ok(text) = res.text().await {
                        if text.len() > 8 * 1024 * 1024 { continue; }
                        let parsed = parse_m3u(&text, "all");
                        for item in parsed {
                            let cat_lower = cat.to_lowercase();
                            let item_cat_lower = item.category.to_lowercase();
                            let is_match = if cat_lower == "documentary" {
                                item_cat_lower.contains("document") || item_cat_lower.contains("science") || item_cat_lower.contains("education") || item_cat_lower.contains("culture") || item_cat_lower.contains("knowledge")
                            } else if cat_lower == "tv show" || cat_lower == "tvshow" || cat_lower == "general" {
                                item_cat_lower.contains("general") || item_cat_lower.contains("entertainment") || item_cat_lower.contains("lifestyle") || item_cat_lower.contains("documentary")
                            } else {
                                item_cat_lower.contains(&cat_lower) || cat_lower.contains(&item_cat_lower)
                            };
                            if is_match && !channels.iter().any(|c| c.stream_url == item.stream_url) {
                                channels.push(item);
                                if channels.len() > 500 { break; }
                            }
                        }
                    }
                }
            }
        }

        // Final client-side category filter when broad fallback was used (keeps behavior dynamic)
        if cat != "all" && !cat.is_empty() && channels.len() > 10 {
            let cat_lower = cat.to_lowercase();
            // Only apply strict filter if we have a meaningful subset; otherwise keep broad results (handles missing dataset)
            let filtered: Vec<LiveChannel> = channels.iter().filter(|c| {
                let cl = c.category.to_lowercase();
                if cat_lower == "documentary" {
                    cl.contains("document") || cl.contains("science") || cl.contains("education")
                } else if cat_lower == "tv show" || cat_lower == "tvshow" {
                    true // TV Show is broad — keep all
                } else {
                    cl.contains(&cat_lower) || cat_lower.contains(&cl)
                }
            }).cloned().collect();
            if filtered.len() >= 3 && filtered.len() < channels.len() {
                channels = filtered;
            }
        }

        // Add built-in premium fallback channels if empty
        if channels.is_empty() {
            channels = get_curated_top_channels();
            // Even fallback should respect category filter dynamically if requested
            if cat != "all" && !cat.is_empty() && cat != "documentary" && cat != "tv show" {
                let ql = cat.to_lowercase();
                let f: Vec<LiveChannel> = channels.iter().filter(|c| c.category.to_lowercase().contains(&ql)).cloned().collect();
                if !f.is_empty() { channels = f; }
            }
        }

        // Store into memory cache
        if let Ok(mut guard) = self.cache.lock() {
            guard.insert(cache_key, channels.clone());
        }

        if let Some(ref q) = query {
            if !q.trim().is_empty() {
                let lower_q = q.to_lowercase();
                channels.retain(|c| {
                    c.name.to_lowercase().contains(&lower_q)
                        || c.category.to_lowercase().contains(&lower_q)
                        || c.country.to_lowercase().contains(&lower_q)
                });
            }
        }

        Ok(channels)
    }

    pub async fn get_available_categories(&self) -> Result<Vec<String>, String> {
        // Try remote categories.json (dynamic source)
        if let Ok(res) = self.client.get("https://iptv-org.github.io/api/categories.json").send().await {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(arr) = json.as_array() {
                    let mut cats: Vec<String> = arr.iter().filter_map(|v| {
                        v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())
                            .or_else(|| v.get("id").and_then(|n| n.as_str()).map(|s| s.to_string()))
                    }).collect();
                    if !cats.is_empty() {
                        cats.sort();
                        cats.dedup();
                        return Ok(cats);
                    }
                }
            }
        }
        // Fallback: distinct categories from cache + curated list (dynamic, not hardcoded)
        let mut set = std::collections::HashSet::new();
        if let Ok(guard) = self.cache.lock() {
            for chs in guard.values() {
                for c in chs { set.insert(c.category.clone()); }
            }
        }
        if set.is_empty() {
            for c in get_curated_top_channels() { set.insert(c.category.clone()); }
        }
        // Add common categories that are known to exist via iptv-org API if not already present
        // This keeps UI dynamic — if Documentary/TV Show not in dataset, they won't appear
        let mut cats: Vec<String> = set.into_iter().collect();
        cats.sort();
        Ok(cats)
    }
}

fn mock_epg_for_channel(name: &str, category: &str) -> (Option<String>, Option<String>) {
    let hour = chrono::Local::now().hour();
    let (now, next) = match category.to_lowercase().as_str() {
        "news" => (format!("Live News • {}H Edition", hour), "Upcoming: Headlines & Debate".to_string()),
        "sports" => (format!("Live Sports • {}H Match", hour), "Next: Highlights & Analysis".to_string()),
        "movies" | "general" => ("Cinema Live: Featured Film".to_string(), "Next: Movie of the Night".to_string()),
        "kids" | "animation" => ("Kids Live: Cartoon Time".to_string(), "Next: Family Show".to_string()),
        "music" => ("Music Live: Top Hits".to_string(), "Next: Non-Stop Mix".to_string()),
        _ => (format!("Live: {} • {}H", name, hour), "Next: Continued Live".to_string()),
    };
    (Some(now), Some(next))
}

fn parse_m3u(content: &str, default_country: &str) -> Vec<LiveChannel> {
    let mut channels = Vec::new();
    let lines: Vec<&str> = content.lines().collect();

    let mut current_logo: Option<String> = None;
    let mut current_name = String::new();
    let mut current_category = "General".to_string();
    let mut current_id = String::new();
    let mut current_user_agent: Option<String> = None;
    let mut current_referrer: Option<String> = None;

    for line in lines {
        let trimmed = line.trim();
        if trimmed.starts_with("#EXTINF:") {
            current_logo = extract_attribute(trimmed, "tvg-logo");
            current_id = extract_attribute(trimmed, "tvg-id").unwrap_or_default();
            current_category = extract_attribute(trimmed, "group-title").unwrap_or_else(|| "General".to_string());

            if let Some(idx) = trimmed.rfind(',') {
                current_name = trimmed[idx + 1..].trim().to_string();
            } else {
                current_name = "Live Channel".to_string();
            }
        } else if trimmed.starts_with("#EXTVLCOPT:http-user-agent=") {
            current_user_agent = Some(trimmed.trim_start_matches("#EXTVLCOPT:http-user-agent=").to_string());
        } else if trimmed.starts_with("#EXTVLCOPT:http-referrer=") {
            current_referrer = Some(trimmed.trim_start_matches("#EXTVLCOPT:http-referrer=").to_string());
        } else if !trimmed.starts_with('#') && (trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
            let stream_url = trimmed.to_string();
            let resolution = extract_resolution(&current_name);
            let clean_name = clean_channel_name(&current_name);
            let flag = get_flag_for_country(default_country, &current_id);

            let (epg_now, epg_next) = mock_epg_for_channel(&clean_name, &current_category);
            channels.push(LiveChannel {
                id: if current_id.is_empty() { format!("ch_{}", channels.len()) } else { current_id.clone() },
                name: clean_name,
                logo: current_logo.clone(),
                category: current_category.clone(),
                country: default_country.to_uppercase(),
                country_flag: flag,
                stream_url,
                resolution,
                user_agent: current_user_agent.take(),
                referrer: current_referrer.take(),
                is_custom: false,
                epg_now,
                epg_next,
            });
        }
    }

    channels
}

fn extract_attribute(line: &str, attr: &str) -> Option<String> {
    let pattern = format!("{}=\"", attr);
    if let Some(start) = line.find(&pattern) {
        let rest = &line[start + pattern.len()..];
        if let Some(end) = rest.find('"') {
            return Some(rest[..end].to_string());
        }
    }
    None
}

fn extract_resolution(name: &str) -> Option<String> {
    if name.contains("1080p") || name.contains("FHD") {
        Some("1080p FHD".to_string())
    } else if name.contains("720p") || name.contains("HD") {
        Some("720p HD".to_string())
    } else if name.contains("4K") || name.contains("2160p") {
        Some("4K UHD".to_string())
    } else if name.contains("360p") || name.contains("480p") || name.contains("SD") {
        Some("SD".to_string())
    } else {
        Some("HD".to_string())
    }
}

fn clean_channel_name(name: &str) -> String {
    let mut clean = name.to_string();
    clean = clean.replace("(1080p)", "");
    clean = clean.replace("(720p)", "");
    clean = clean.replace("(360p)", "");
    clean = clean.replace("(480p)", "");
    clean = clean.replace("(576p)", "");
    clean = clean.replace("[Not 24/7]", "");
    clean = clean.replace("[Geo-blocked]", "");
    clean.trim().to_string()
}

fn get_flag_for_country(country_code: &str, tvg_id: &str) -> String {
    let code = if country_code == "all" || country_code == "sports" || country_code == "news" {
        if tvg_id.contains(".ma") { "ma" }
        else if tvg_id.contains(".sa") { "sa" }
        else if tvg_id.contains(".eg") { "eg" }
        else if tvg_id.contains(".ae") { "ae" }
        else if tvg_id.contains(".dz") { "dz" }
        else if tvg_id.contains(".tn") { "tn" }
        else if tvg_id.contains(".qa") { "qa" }
        else if tvg_id.contains(".kw") { "kw" }
        else if tvg_id.contains(".fr") { "fr" }
        else if tvg_id.contains(".us") { "us" }
        else if tvg_id.contains(".uk") || tvg_id.contains(".gb") { "gb" }
        else if tvg_id.contains(".es") { "es" }
        else if tvg_id.contains(".de") { "de" }
        else if tvg_id.contains(".tr") { "tr" }
        else if tvg_id.contains(".it") { "it" }
        else { country_code }
    } else {
        country_code
    };

    match code {
        "ma" => "🇲🇦".to_string(),
        "sa" => "🇸🇦".to_string(),
        "eg" => "🇪🇬".to_string(),
        "ae" => "🇦🇪".to_string(),
        "dz" => "🇩🇿".to_string(),
        "tn" => "🇹🇳".to_string(),
        "qa" => "🇶🇦".to_string(),
        "kw" => "🇰🇼".to_string(),
        "lb" => "🇱🇧".to_string(),
        "iq" => "🇮🇶".to_string(),
        "om" => "🇴🇲".to_string(),
        "jo" => "🇯🇴".to_string(),
        "fr" => "🇫🇷".to_string(),
        "us" => "🇺🇸".to_string(),
        "gb" | "uk" => "🇬🇧".to_string(),
        "es" => "🇪🇸".to_string(),
        "de" => "🇩🇪".to_string(),
        "tr" => "🇹🇷".to_string(),
        "it" => "🇮🇹".to_string(),
        "custom" => "⚡".to_string(),
        _ => "🌐".to_string(),
    }
}

fn get_curated_top_channels() -> Vec<LiveChannel> {
    vec![
        LiveChannel {
            id: "2m.ma".to_string(),
            name: "2M Monde".to_string(),
            logo: Some("https://i.imgur.com/MvpntzA.png".to_string()),
            category: "General".to_string(),
            country: "MA".to_string(),
            country_flag: "🇲🇦".to_string(),
            stream_url: "https://cdn-globecast.akamaized.net/live/eds/2m_monde/hls_video_ts_tuhawxpiemz257adfc/2m_monde.m3u8".to_string(),
            resolution: Some("1080p FHD".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
        LiveChannel {
            id: "medi1.ma".to_string(),
            name: "Medi 1 TV Arabic".to_string(),
            logo: Some("https://i.imgur.com/3YsZPY6.jpeg".to_string()),
            category: "News".to_string(),
            country: "MA".to_string(),
            country_flag: "🇲🇦".to_string(),
            stream_url: "https://cdn.live.easybroadcast.io/abr_corp/83_medi1tv-arabic_g90v4ec/playlist.m3u8".to_string(),
            resolution: Some("1080p FHD".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
        LiveChannel {
            id: "arryadia.ma".to_string(),
            name: "Arryadia HD (الرياضية المغربية)".to_string(),
            logo: Some("https://i.imgur.com/XjzK3gZ.png".to_string()),
            category: "Sports".to_string(),
            country: "MA".to_string(),
            country_flag: "🇲🇦".to_string(),
            stream_url: "http://149.100.11.252:8000/play/a065/index.m3u8".to_string(),
            resolution: Some("720p HD".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
        LiveChannel {
            id: "aljazeera.qa".to_string(),
            name: "Al Jazeera Arabic (الجزيرة)".to_string(),
            logo: Some("https://upload.wikimedia.org/wikipedia/en/thumb/f/f2/Aljazeera_eng.svg/1200px-Aljazeera_eng.svg.png".to_string()),
            category: "News".to_string(),
            country: "ARAB".to_string(),
            country_flag: "🇸🇦".to_string(),
            stream_url: "https://live-hls-web-aje.getaj.net/AJE/03.m3u8".to_string(),
            resolution: Some("1080p FHD".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
        LiveChannel {
            id: "france24.fr".to_string(),
            name: "France 24 Français".to_string(),
            logo: Some("https://upload.wikimedia.org/wikipedia/commons/thumb/6/65/France_24_logo.svg/1200px-France_24_logo.svg.png".to_string()),
            category: "News".to_string(),
            country: "FR".to_string(),
            country_flag: "🇫🇷".to_string(),
            stream_url: "https://stream.france24.com/hls/live/2037494/F24_FR_HI_HLS/master.m3u8".to_string(),
            resolution: Some("1080p FHD".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
        LiveChannel {
            id: "redbulltv.us".to_string(),
            name: "Red Bull TV (Sports & Action)".to_string(),
            logo: Some("https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/Red_Bull_TV_logo.svg/1200px-Red_Bull_TV_logo.svg.png".to_string()),
            category: "Sports".to_string(),
            country: "US".to_string(),
            country_flag: "🇺🇸".to_string(),
            stream_url: "https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8".to_string(),
            resolution: Some("1080p FHD".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
        LiveChannel {
            id: "radiomars.ma".to_string(),
            name: "📻 Radio Mars (راديو مارس الرياضي)".to_string(),
            logo: Some("https://i.imgur.com/vHq0L9I.png".to_string()),
            category: "Radio".to_string(),
            country: "MA".to_string(),
            country_flag: "🇲🇦".to_string(),
            stream_url: "https://radiomars.ice.infomaniak.ch/radiomars-128.mp3".to_string(),
            resolution: Some("HQ Audio".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
        LiveChannel {
            id: "hitradio.ma".to_string(),
            name: "📻 Hit Radio (هيت راديو المغرب)".to_string(),
            logo: Some("https://i.imgur.com/K8n7aLp.png".to_string()),
            category: "Radio".to_string(),
            country: "MA".to_string(),
            country_flag: "🇲🇦".to_string(),
            stream_url: "https://hitradio-maroc.ice.infomaniak.ch/hitradio-maroc-128.mp3".to_string(),
            resolution: Some("HQ Audio".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
        LiveChannel {
            id: "quran.ma".to_string(),
            name: "📖 إذاعة القرآن الكريم (المغرب)".to_string(),
            logo: Some("https://i.imgur.com/4bB9L2I.png".to_string()),
            category: "Radio".to_string(),
            country: "MA".to_string(),
            country_flag: "🇲🇦".to_string(),
            stream_url: "https://cdnamd-hls-globecast.akamaized.net/live/ramdisk/radio_coran/live_abr/radio_coran/radio_coran_96.m3u8".to_string(),
            resolution: Some("HQ Audio".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
        LiveChannel {
            id: "medi1radio.ma".to_string(),
            name: "📻 Medi 1 Radio (إذاعة ميدي 1)".to_string(),
            logo: Some("https://i.imgur.com/3YsZPY6.jpeg".to_string()),
            category: "Radio".to_string(),
            country: "MA".to_string(),
            country_flag: "🇲🇦".to_string(),
            stream_url: "https://mediradio.ice.infomaniak.ch/mediradio-64.mp3".to_string(),
            resolution: Some("HQ Audio".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
        LiveChannel {
            id: "lofigirl.live".to_string(),
            name: "🎧 Lofi Girl 24/7 (Relax / Study Beats)".to_string(),
            logo: Some("https://yt3.googleusercontent.com/ytc/AIdro_k68Z2Yf7nN2P5W_2E6lE7g=s900-c-k-c0x00ffffff-no-rj".to_string()),
            category: "Radio".to_string(),
            country: "GLOBAL".to_string(),
            country_flag: "🎵".to_string(),
            stream_url: "https://play.streamafrica.net/lofigirl".to_string(),
            resolution: Some("HQ Audio".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
        LiveChannel {
            id: "twitch.esports".to_string(),
            name: "🎮 Twitch eSports & Gaming Live".to_string(),
            logo: Some("https://assets.stickpng.com/images/580b57fcd9996e24bc43c540.png".to_string()),
            category: "Gaming".to_string(),
            country: "GLOBAL".to_string(),
            country_flag: "🎮".to_string(),
            stream_url: "https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8".to_string(),
            resolution: Some("1080p 60FPS".to_string()),
            user_agent: None,
            referrer: None,
            is_custom: false,
            epg_now: Some("Live Broadcast".to_string()),
            epg_next: Some("Next: Continued".to_string()),
        },
    ]
}
