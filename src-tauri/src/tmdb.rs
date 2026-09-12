use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Instant, Duration};
use lazy_static::lazy_static;

lazy_static! {
    static ref TMDB_MEM_CACHE: Mutex<HashMap<String, (serde_json::Value, Instant)>> = Mutex::new(HashMap::new());
}
const TMDB_CACHE_TTL: Duration = Duration::from_secs(300);

pub const DEFAULT_TMDB_API_KEY: &str = "0ea8d8ca2abeb5fa061faf1a966747b4";
const TMDB_BASE_URL: &str = "https://api.themoviedb.org/3";
// Live remote TMDB key rotation: set from the free remote DB via
// `set_remote_tmdb_key`. Used ONLY while the user keeps the default key,
// so one rotation fixes the catalog for every default install at once.
static REMOTE_TMDB_KEY: Mutex<Option<String>> = Mutex::new(None);
pub fn set_remote_tmdb_key(key: String) {
    if let Ok(mut slot) = REMOTE_TMDB_KEY.lock() {
        let k = key.trim().to_string();
        *slot = if k.len() > 10 { Some(k) } else { None };
    }
}
fn remote_tmdb_key() -> Option<String> {
    REMOTE_TMDB_KEY.lock().ok().and_then(|s| s.clone())
}
fn env_tmdb_key() -> String {
    option_env!("TMDB_API_KEY").unwrap_or(DEFAULT_TMDB_API_KEY).to_string()
}
const TMDB_IMAGE_BASE: &str = "https://image.tmdb.org/t/p";
fn tmdb_cache_get(key: &str) -> Option<serde_json::Value> {
    if let Ok(map) = TMDB_MEM_CACHE.lock() {
        if let Some((v, ts)) = map.get(key) {
            if ts.elapsed() < TMDB_CACHE_TTL { return Some(v.clone()); }
        }
    }
    None
}
fn tmdb_cache_set(key: String, val: serde_json::Value) {
    if let Ok(mut map) = TMDB_MEM_CACHE.lock() {
        if map.len() > 128 { map.clear(); }
        map.insert(key, (val, Instant::now()));
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaItem {
    pub id: u64,
    pub title: String,
    pub original_title: Option<String>,
    pub overview: String,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub release_date: Option<String>,
    pub vote_average: f64,
    pub vote_count: u64,
    pub media_type: String, // "movie", "tv", or "anime"
    pub genre_ids: Option<Vec<u64>>,
    pub imdb_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MediaListResponse {
    pub page: u32,
    pub total_pages: u32,
    pub total_results: u64,
    pub results: Vec<MediaItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CastMember {
    pub id: u64,
    pub name: String,
    pub character: Option<String>,
    pub profile_path: Option<String>,
    pub profile_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VideoTrailer {
    pub id: String,
    pub key: String,
    pub name: String,
    pub site: String,
    pub video_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Genre {
    pub id: u64,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Episode {
    pub id: u64,
    pub episode_number: u32,
    pub season_number: u32,
    pub name: String,
    pub overview: String,
    pub still_path: Option<String>,
    pub still_url: Option<String>,
    pub air_date: Option<String>,
    pub vote_average: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Season {
    pub id: u64,
    pub season_number: u32,
    pub name: String,
    pub episode_count: u32,
    pub poster_path: Option<String>,
    pub poster_url: Option<String>,
    pub episodes: Option<Vec<Episode>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaDetails {
    pub id: u64,
    pub title: String,
    pub overview: String,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub release_date: Option<String>,
    pub vote_average: f64,
    pub runtime: Option<u32>,
    pub genres: Vec<Genre>,
    pub imdb_id: Option<String>,
    pub media_type: String,
    pub cast: Vec<CastMember>,
    pub trailers: Vec<VideoTrailer>,
    pub seasons: Option<Vec<Season>>,
    pub status: Option<String>,
    pub tagline: Option<String>,
}

fn format_image_url(path: &Option<String>, size: &str) -> Option<String> {
    path.as_ref().map(|p| format!("{}/{}{}", TMDB_IMAGE_BASE, size, p))
}

pub struct TmdbClient {
    client: reqwest::Client,
    api_key: String,
}

impl TmdbClient {
    pub fn new(custom_key: Option<String>) -> Self {
        let api_key = custom_key
            .filter(|k| !k.trim().is_empty())
            .map(|k| {
                // Remote rotation wins while the user is still on the baked-in default.
                if k.trim() == DEFAULT_TMDB_API_KEY {
                    if let Some(remote) = remote_tmdb_key() {
                        return remote;
                    }
                }
                k
            })
            .unwrap_or_else(|| remote_tmdb_key().unwrap_or_else(env_tmdb_key));
        
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .build()
            .unwrap_or_default();

        Self { client, api_key }
    }

    pub async fn get_trending(&self, media_type: &str, time_window: &str, language: Option<&str>) -> Result<Vec<MediaItem>, String> {
        let target_type = if media_type == "anime" { "tv" } else { media_type };
        let lang = language.unwrap_or("en-US");
        let cache_key = format!("trending:{}:{}:{}", target_type, time_window, lang);
        if let Some(cached) = tmdb_cache_get(&cache_key) {
            // use cached raw json value directly
            let data = cached;
            let mut items = Vec::new();
            if let Some(results) = data.get("results").and_then(|r| r.as_array()) {
                for item in results {
                    let m_type = item.get("media_type").and_then(|m| m.as_str()).unwrap_or(target_type).to_string();
                    let title = item.get("title").or_else(|| item.get("name")).and_then(|t| t.as_str()).unwrap_or("Untitled").to_string();
                    let poster_path = item.get("poster_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                    let backdrop_path = item.get("backdrop_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                    items.push(MediaItem {
                        id: item.get("id").and_then(|i| i.as_u64()).unwrap_or(0),
                        title,
                        original_title: item.get("original_title").or_else(|| item.get("original_name")).and_then(|t| t.as_str()).map(|s| s.to_string()),
                        overview: item.get("overview").and_then(|o| o.as_str()).unwrap_or("").to_string(),
                        poster_url: format_image_url(&poster_path, "w500"),
                        backdrop_url: format_image_url(&backdrop_path, "original"),
                        poster_path,
                        backdrop_path,
                        release_date: item.get("release_date").or_else(|| item.get("first_air_date")).and_then(|d| d.as_str()).map(|s| s.to_string()),
                        vote_average: item.get("vote_average").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        vote_count: item.get("vote_count").and_then(|v| v.as_u64()).unwrap_or(0),
                        media_type: m_type,
                        genre_ids: None,
                        imdb_id: None,
                    });
                }
            }
            return Ok(items);
        }
        let url = format!("{}/trending/{}/{}?api_key={}&language={}", TMDB_BASE_URL, target_type, time_window, self.api_key, lang);
        let res = self.client.get(&url).send().await.map_err(|e| e.to_string())?;
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        tmdb_cache_set(cache_key, data.clone());

        let mut items = Vec::new();
        if let Some(results) = data.get("results").and_then(|r| r.as_array()) {
            for item in results {
                let m_type = item.get("media_type")
                    .and_then(|m| m.as_str())
                    .unwrap_or(target_type)
                    .to_string();

                let title = item.get("title")
                    .or_else(|| item.get("name"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("Untitled")
                    .to_string();

                let poster_path = item.get("poster_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                let backdrop_path = item.get("backdrop_path").and_then(|p| p.as_str()).map(|s| s.to_string());

                items.push(MediaItem {
                    id: item.get("id").and_then(|i| i.as_u64()).unwrap_or(0),
                    title,
                    original_title: item.get("original_title").or_else(|| item.get("original_name")).and_then(|t| t.as_str()).map(|s| s.to_string()),
                    overview: item.get("overview").and_then(|o| o.as_str()).unwrap_or("").to_string(),
                    poster_url: format_image_url(&poster_path, "w500"),
                    backdrop_url: format_image_url(&backdrop_path, "original"),
                    poster_path,
                    backdrop_path,
                    release_date: item.get("release_date").or_else(|| item.get("first_air_date")).and_then(|d| d.as_str()).map(|s| s.to_string()),
                    vote_average: item.get("vote_average").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    vote_count: item.get("vote_count").and_then(|v| v.as_u64()).unwrap_or(0),
                    media_type: m_type,
                    genre_ids: None,
                    imdb_id: None,
                });
            }
        }
        Ok(items)
    }

    pub async fn get_discover(
        &self,
        media_type: &str,
        page: u32,
        genre_id: Option<u64>,
        sort_by: Option<&str>,
        year: Option<u32>,
        min_rating: Option<f64>,
        country: Option<&str>,
        language: Option<&str>,
        tmdb_language: Option<&str>,
    ) -> Result<MediaListResponse, String> {
        let sort = sort_by.unwrap_or("popularity.desc");
        let ui_lang = tmdb_language.unwrap_or("en-US");
        
        let (endpoint, mut extra_params, effective_media_type) = if media_type == "anime" {
            // Japanese Animation
            ("discover/tv", "&with_genres=16&with_original_language=ja".to_string(), "tv")
        } else {
            let ep = if media_type == "movie" { "discover/movie" } else { "discover/tv" };
            (ep, String::new(), media_type)
        };

        if let Some(g) = genre_id {
            if media_type == "anime" && g != 16 {
                extra_params.push_str(&format!(",{}", g));
            } else if media_type != "anime" {
                extra_params.push_str(&format!("&with_genres={}", g));
            }
        }

        let mut with_orig_lang: Option<String> = None;
        let mut with_orig_country: Option<String> = None;

        if let Some(c) = country {
            let c_lower = c.trim().to_lowercase();
            if !c_lower.is_empty() && c_lower != "all" {
                match c_lower.as_str() {
                    "ar" | "arab" => {
                        with_orig_lang = Some("ar".to_string());
                    }
                    "us" | "usa" => {
                        with_orig_country = Some("US".to_string());
                        with_orig_lang = Some("en".to_string());
                    }
                    "gb" | "uk" => {
                        with_orig_country = Some("GB".to_string());
                    }
                    "kr" | "korea" => {
                        with_orig_country = Some("KR".to_string());
                        with_orig_lang = Some("ko".to_string());
                    }
                    "jp" | "japan" => {
                        with_orig_country = Some("JP".to_string());
                        with_orig_lang = Some("ja".to_string());
                    }
                    "in" | "india" => {
                        with_orig_country = Some("IN".to_string());
                        with_orig_lang = Some("hi|te|ta|ml|bn|pa|kn".to_string());
                    }
                    "tr" | "turkey" => {
                        with_orig_country = Some("TR".to_string());
                        with_orig_lang = Some("tr".to_string());
                    }
                    "fr" | "france" => {
                        with_orig_country = Some("FR".to_string());
                        with_orig_lang = Some("fr".to_string());
                    }
                    "es" | "spain" => {
                        with_orig_country = Some("ES".to_string());
                        with_orig_lang = Some("es".to_string());
                    }
                    "de" | "germany" => {
                        with_orig_country = Some("DE".to_string());
                        with_orig_lang = Some("de".to_string());
                    }
                    "it" | "italy" => {
                        with_orig_country = Some("IT".to_string());
                        with_orig_lang = Some("it".to_string());
                    }
                    "cn" | "china" => {
                        with_orig_country = Some("CN".to_string());
                        with_orig_lang = Some("zh".to_string());
                    }
                    "hk" | "hongkong" => {
                        with_orig_country = Some("HK".to_string());
                        with_orig_lang = Some("cn|zh|yue".to_string());
                    }
                    "tw" | "taiwan" => {
                        with_orig_country = Some("TW".to_string());
                        with_orig_lang = Some("zh".to_string());
                    }
                    "ca" | "canada" => {
                        with_orig_country = Some("CA".to_string());
                    }
                    "au" | "australia" => {
                        with_orig_country = Some("AU".to_string());
                    }
                    "eg" | "egypt" => {
                        with_orig_country = Some("EG".to_string());
                        with_orig_lang = Some("ar".to_string());
                    }
                    "ma" | "morocco" => {
                        with_orig_country = Some("MA".to_string());
                    }
                    "sa" | "saudi" => {
                        with_orig_country = Some("SA".to_string());
                    }
                    "sy" | "syria" => {
                        with_orig_country = Some("SY".to_string());
                    }
                    "lb" | "lebanon" => {
                        with_orig_country = Some("LB".to_string());
                    }
                    "dz" | "algeria" => {
                        with_orig_country = Some("DZ".to_string());
                    }
                    "tn" | "tunisia" => {
                        with_orig_country = Some("TN".to_string());
                    }
                    "kw" | "kuwait" => {
                        with_orig_country = Some("KW".to_string());
                    }
                    "ae" | "uae" => {
                        with_orig_country = Some("AE".to_string());
                    }
                    "jo" | "jordan" => {
                        with_orig_country = Some("JO".to_string());
                    }
                    "iq" | "iraq" => {
                        with_orig_country = Some("IQ".to_string());
                    }
                    "ps" | "palestine" => {
                        with_orig_country = Some("PS".to_string());
                    }
                    "qa" | "qatar" => {
                        with_orig_country = Some("QA".to_string());
                    }
                    "ru" | "russia" => {
                        with_orig_country = Some("RU".to_string());
                        with_orig_lang = Some("ru".to_string());
                    }
                    "se" | "sweden" => {
                        with_orig_country = Some("SE".to_string());
                        with_orig_lang = Some("sv".to_string());
                    }
                    "dk" | "denmark" => {
                        with_orig_country = Some("DK".to_string());
                        with_orig_lang = Some("da".to_string());
                    }
                    "no" | "norway" => {
                        with_orig_country = Some("NO".to_string());
                        with_orig_lang = Some("no".to_string());
                    }
                    "fi" | "finland" => {
                        with_orig_country = Some("FI".to_string());
                        with_orig_lang = Some("fi".to_string());
                    }
                    "is" | "iceland" => {
                        with_orig_country = Some("IS".to_string());
                        with_orig_lang = Some("is".to_string());
                    }
                    "mx" | "mexico" => {
                        with_orig_country = Some("MX".to_string());
                        with_orig_lang = Some("es".to_string());
                    }
                    "br" | "brazil" => {
                        with_orig_country = Some("BR".to_string());
                        with_orig_lang = Some("pt".to_string());
                    }
                    "th" | "thailand" => {
                        with_orig_country = Some("TH".to_string());
                        with_orig_lang = Some("th".to_string());
                    }
                    "id" | "indonesia" => {
                        with_orig_country = Some("ID".to_string());
                        with_orig_lang = Some("id".to_string());
                    }
                    "ph" | "philippines" => {
                        with_orig_country = Some("PH".to_string());
                        with_orig_lang = Some("tl".to_string());
                    }
                    "ir" | "iran" => {
                        with_orig_country = Some("IR".to_string());
                        with_orig_lang = Some("fa".to_string());
                    }
                    "pk" | "pakistan" => {
                        with_orig_country = Some("PK".to_string());
                        with_orig_lang = Some("ur".to_string());
                    }
                    "pl" | "poland" => {
                        with_orig_country = Some("PL".to_string());
                        with_orig_lang = Some("pl".to_string());
                    }
                    "nl" | "netherlands" => {
                        with_orig_country = Some("NL".to_string());
                        with_orig_lang = Some("nl".to_string());
                    }
                    "be" | "belgium" => {
                        with_orig_country = Some("BE".to_string());
                    }
                    "ng" | "nigeria" => {
                        with_orig_country = Some("NG".to_string());
                    }
                    "za" | "southafrica" => {
                        with_orig_country = Some("ZA".to_string());
                    }
                    "co" | "colombia" => {
                        with_orig_country = Some("CO".to_string());
                        with_orig_lang = Some("es".to_string());
                    }
                    "cl" | "chile" => {
                        with_orig_country = Some("CL".to_string());
                        with_orig_lang = Some("es".to_string());
                    }
                    "ar_latam" | "argentina" => {
                        with_orig_country = Some("AR".to_string());
                        with_orig_lang = Some("es".to_string());
                    }
                    "gr" | "greece" => {
                        with_orig_country = Some("GR".to_string());
                        with_orig_lang = Some("el".to_string());
                    }
                    "pt" | "portugal" => {
                        with_orig_country = Some("PT".to_string());
                        with_orig_lang = Some("pt".to_string());
                    }
                    "at" | "austria" => {
                        with_orig_country = Some("AT".to_string());
                        with_orig_lang = Some("de".to_string());
                    }
                    "ch" | "switzerland" => {
                        with_orig_country = Some("CH".to_string());
                    }
                    "cz" | "czech" => {
                        with_orig_country = Some("CZ".to_string());
                        with_orig_lang = Some("cs".to_string());
                    }
                    "hu" | "hungary" => {
                        with_orig_country = Some("HU".to_string());
                        with_orig_lang = Some("hu".to_string());
                    }
                    "ro" | "romania" => {
                        with_orig_country = Some("RO".to_string());
                        with_orig_lang = Some("ro".to_string());
                    }
                    "ua" | "ukraine" => {
                        with_orig_country = Some("UA".to_string());
                        with_orig_lang = Some("uk".to_string());
                    }
                    "ie" | "ireland" => {
                        with_orig_country = Some("IE".to_string());
                    }
                    "nz" | "newzealand" => {
                        with_orig_country = Some("NZ".to_string());
                    }
                    other => {
                        with_orig_country = Some(other.to_uppercase());
                    }
                }
            }
        }

        if let Some(l) = language {
            let l_trim = l.trim();
            if !l_trim.is_empty() && l_trim != "all" {
                with_orig_lang = Some(l_trim.to_string());
            }
        }

        if let Some(lang) = with_orig_lang {
            extra_params.push_str(&format!("&with_original_language={}", lang));
        }
        if let Some(cntry) = with_orig_country {
            extra_params.push_str(&format!("&with_origin_country={}", cntry));
        }

        if let Some(y) = year {
            if media_type == "movie" {
                extra_params.push_str(&format!("&primary_release_year={}", y));
            } else {
                extra_params.push_str(&format!("&first_air_date_year={}", y));
            }
        }

        if let Some(rating) = min_rating {
            if rating > 0.0 {
                extra_params.push_str(&format!("&vote_average.gte={}&vote_count.gte=50", rating));
            }
        }

        let url = format!("{}/{}?api_key={}&page={}&sort_by={}{}&language={}", TMDB_BASE_URL, endpoint, self.api_key, page, sort, extra_params, ui_lang);
        let cache_key = format!("discover:{}:{}:{}:{}:{}:{}:{}:{}:{}", media_type, page, genre_id.unwrap_or(0), sort, year.unwrap_or(0), (min_rating.unwrap_or(0.0)*10.0) as u64, country.unwrap_or(""), language.unwrap_or(""), ui_lang);
        if let Some(cached) = tmdb_cache_get(&cache_key) {
            let data = cached;
            let page = data.get("page").and_then(|p| p.as_u64()).unwrap_or(1) as u32;
            let total_pages = data.get("total_pages").and_then(|p| p.as_u64()).unwrap_or(1) as u32;
            let total_results = data.get("total_results").and_then(|p| p.as_u64()).unwrap_or(0);
            let mut results_vec = Vec::new();
            if let Some(results) = data.get("results").and_then(|r| r.as_array()) {
                for item in results {
                    let title = item.get("title").or_else(|| item.get("name")).and_then(|t| t.as_str()).unwrap_or("Untitled").to_string();
                    let poster_path = item.get("poster_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                    let backdrop_path = item.get("backdrop_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                    results_vec.push(MediaItem {
                        id: item.get("id").and_then(|i| i.as_u64()).unwrap_or(0),
                        title,
                        original_title: item.get("original_title").or_else(|| item.get("original_name")).and_then(|t| t.as_str()).map(|s| s.to_string()),
                        overview: item.get("overview").and_then(|o| o.as_str()).unwrap_or("").to_string(),
                        poster_url: format_image_url(&poster_path, "w500"),
                        backdrop_url: format_image_url(&backdrop_path, "w1280"),
                        poster_path,
                        backdrop_path,
                        release_date: item.get("release_date").or_else(|| item.get("first_air_date")).and_then(|d| d.as_str()).map(|s| s.to_string()),
                        vote_average: item.get("vote_average").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        vote_count: item.get("vote_count").and_then(|v| v.as_u64()).unwrap_or(0),
                        media_type: effective_media_type.to_string(),
                        genre_ids: None,
                        imdb_id: None,
                    });
                }
            }
            return Ok(MediaListResponse { page, total_pages, total_results, results: results_vec });
        }
        let res = self.client.get(&url).send().await.map_err(|e| e.to_string())?;
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        tmdb_cache_set(cache_key, data.clone());

        let page = data.get("page").and_then(|p| p.as_u64()).unwrap_or(1) as u32;
        let total_pages = data.get("total_pages").and_then(|p| p.as_u64()).unwrap_or(1) as u32;
        let total_results = data.get("total_results").and_then(|p| p.as_u64()).unwrap_or(0);

        let mut results_vec = Vec::new();
        if let Some(results) = data.get("results").and_then(|r| r.as_array()) {
            for item in results {
                let title = item.get("title")
                    .or_else(|| item.get("name"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("Untitled")
                    .to_string();

                let poster_path = item.get("poster_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                let backdrop_path = item.get("backdrop_path").and_then(|p| p.as_str()).map(|s| s.to_string());

                results_vec.push(MediaItem {
                    id: item.get("id").and_then(|i| i.as_u64()).unwrap_or(0),
                    title,
                    original_title: item.get("original_title").or_else(|| item.get("original_name")).and_then(|t| t.as_str()).map(|s| s.to_string()),
                    overview: item.get("overview").and_then(|o| o.as_str()).unwrap_or("").to_string(),
                    poster_url: format_image_url(&poster_path, "w500"),
                    backdrop_url: format_image_url(&backdrop_path, "w1280"),
                    poster_path,
                    backdrop_path,
                    release_date: item.get("release_date").or_else(|| item.get("first_air_date")).and_then(|d| d.as_str()).map(|s| s.to_string()),
                    vote_average: item.get("vote_average").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    vote_count: item.get("vote_count").and_then(|v| v.as_u64()).unwrap_or(0),
                    media_type: effective_media_type.to_string(),
                    genre_ids: None,
                    imdb_id: None,
                });
            }
        }

        Ok(MediaListResponse {
            page,
            total_pages,
            total_results,
            results: results_vec,
        })
    }

    pub async fn search(&self, query: &str, page: u32, language: Option<&str>) -> Result<MediaListResponse, String> {
        let encoded = urlencoding::encode(query);
        let lang = language.unwrap_or("en-US");
        let cache_key = format!("search:{}:{}:{}", query, page, lang);
        if let Some(cached) = tmdb_cache_get(&cache_key) {
            let data = cached;
            let page = data.get("page").and_then(|p| p.as_u64()).unwrap_or(1) as u32;
            let total_pages = data.get("total_pages").and_then(|p| p.as_u64()).unwrap_or(1) as u32;
            let total_results = data.get("total_results").and_then(|p| p.as_u64()).unwrap_or(0);
            let mut results_vec = Vec::new();
            if let Some(results) = data.get("results").and_then(|r| r.as_array()) {
                for item in results {
                    let m_type = item.get("media_type").and_then(|m| m.as_str()).unwrap_or("");
                    if m_type != "movie" && m_type != "tv" { continue; }
                    let title = item.get("title").or_else(|| item.get("name")).and_then(|t| t.as_str()).unwrap_or("Untitled").to_string();
                    let poster_path = item.get("poster_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                    let backdrop_path = item.get("backdrop_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                    results_vec.push(MediaItem {
                        id: item.get("id").and_then(|i| i.as_u64()).unwrap_or(0),
                        title,
                        original_title: item.get("original_title").or_else(|| item.get("original_name")).and_then(|t| t.as_str()).map(|s| s.to_string()),
                        overview: item.get("overview").and_then(|o| o.as_str()).unwrap_or("").to_string(),
                        poster_url: format_image_url(&poster_path, "w500"),
                        backdrop_url: format_image_url(&backdrop_path, "w1280"),
                        poster_path,
                        backdrop_path,
                        release_date: item.get("release_date").or_else(|| item.get("first_air_date")).and_then(|d| d.as_str()).map(|s| s.to_string()),
                        vote_average: item.get("vote_average").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        vote_count: item.get("vote_count").and_then(|v| v.as_u64()).unwrap_or(0),
                        media_type: m_type.to_string(),
                        genre_ids: None,
                        imdb_id: None,
                    });
                }
            }
            return Ok(MediaListResponse { page, total_pages, total_results, results: results_vec });
        }
        let url = format!("{}/search/multi?api_key={}&query={}&page={}&language={}", TMDB_BASE_URL, self.api_key, encoded, page, lang);
        let res = self.client.get(&url).send().await.map_err(|e| e.to_string())?;
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        tmdb_cache_set(cache_key, data.clone());

        let page = data.get("page").and_then(|p| p.as_u64()).unwrap_or(1) as u32;
        let total_pages = data.get("total_pages").and_then(|p| p.as_u64()).unwrap_or(1) as u32;
        let total_results = data.get("total_results").and_then(|p| p.as_u64()).unwrap_or(0);

        let mut results_vec = Vec::new();
        if let Some(results) = data.get("results").and_then(|r| r.as_array()) {
            for item in results {
                let m_type = item.get("media_type").and_then(|m| m.as_str()).unwrap_or("");
                if m_type != "movie" && m_type != "tv" {
                    continue;
                }

                let title = item.get("title")
                    .or_else(|| item.get("name"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("Untitled")
                    .to_string();

                let poster_path = item.get("poster_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                let backdrop_path = item.get("backdrop_path").and_then(|p| p.as_str()).map(|s| s.to_string());

                results_vec.push(MediaItem {
                    id: item.get("id").and_then(|i| i.as_u64()).unwrap_or(0),
                    title,
                    original_title: item.get("original_title").or_else(|| item.get("original_name")).and_then(|t| t.as_str()).map(|s| s.to_string()),
                    overview: item.get("overview").and_then(|o| o.as_str()).unwrap_or("").to_string(),
                    poster_url: format_image_url(&poster_path, "w500"),
                    backdrop_url: format_image_url(&backdrop_path, "w1280"),
                    poster_path,
                    backdrop_path,
                    release_date: item.get("release_date").or_else(|| item.get("first_air_date")).and_then(|d| d.as_str()).map(|s| s.to_string()),
                    vote_average: item.get("vote_average").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    vote_count: item.get("vote_count").and_then(|v| v.as_u64()).unwrap_or(0),
                    media_type: m_type.to_string(),
                    genre_ids: None,
                    imdb_id: None,
                });
            }
        }

        Ok(MediaListResponse {
            page,
            total_pages,
            total_results,
            results: results_vec,
        })
    }

    pub async fn get_details(&self, media_type: &str, id: u64, language: Option<&str>) -> Result<MediaDetails, String> {
        let target_type = if media_type == "anime" { "tv" } else { media_type };
        let lang = language.unwrap_or("en-US");
        let url = format!("{}/{}/{}?api_key={}&append_to_response=credits,videos,external_ids&language={}", TMDB_BASE_URL, target_type, id, self.api_key, lang);
        let res = self.client.get(&url).send().await.map_err(|e| e.to_string())?;
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

        let title = data.get("title")
            .or_else(|| data.get("name"))
            .and_then(|t| t.as_str())
            .unwrap_or("Untitled")
            .to_string();

        let poster_path = data.get("poster_path").and_then(|p| p.as_str()).map(|s| s.to_string());
        let backdrop_path = data.get("backdrop_path").and_then(|p| p.as_str()).map(|s| s.to_string());
        
        // Extract IMDb ID directly or query /external_ids explicitly
        let mut imdb_id = data.get("external_ids")
            .and_then(|ext| ext.get("imdb_id"))
            .or_else(|| data.get("imdb_id"))
            .and_then(|i| i.as_str())
            .map(|s| s.to_string());

        if imdb_id.is_none() {
            // Explicitly query external_ids endpoint
            let ext_url = format!("{}/{}/{}/external_ids?api_key={}", TMDB_BASE_URL, target_type, id, self.api_key);
            if let Ok(ext_res) = self.client.get(&ext_url).send().await {
                if let Ok(ext_json) = ext_res.json::<serde_json::Value>().await {
                    imdb_id = ext_json.get("imdb_id").and_then(|i| i.as_str()).map(|s| s.to_string());
                }
            }
        }

        let mut genres = Vec::new();
        if let Some(g_arr) = data.get("genres").and_then(|g| g.as_array()) {
            for g in g_arr {
                if let (Some(gid), Some(gname)) = (g.get("id").and_then(|i| i.as_u64()), g.get("name").and_then(|n| n.as_str())) {
                    genres.push(Genre { id: gid, name: gname.to_string() });
                }
            }
        }

        let mut cast = Vec::new();
        if let Some(cast_arr) = data.get("credits").and_then(|c| c.get("cast")).and_then(|c| c.as_array()) {
            for member in cast_arr.iter().take(12) {
                let profile_path = member.get("profile_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                cast.push(CastMember {
                    id: member.get("id").and_then(|i| i.as_u64()).unwrap_or(0),
                    name: member.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                    character: member.get("character").and_then(|c| c.as_str()).map(|s| s.to_string()),
                    profile_url: format_image_url(&profile_path, "w185"),
                    profile_path,
                });
            }
        }

        let mut trailers = Vec::new();
        if let Some(v_arr) = data.get("videos").and_then(|v| v.get("results")).and_then(|v| v.as_array()) {
            for v in v_arr {
                if v.get("site").and_then(|s| s.as_str()) == Some("YouTube") {
                    trailers.push(VideoTrailer {
                        id: v.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                        key: v.get("key").and_then(|k| k.as_str()).unwrap_or("").to_string(),
                        name: v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                        site: "YouTube".to_string(),
                        video_type: v.get("type").and_then(|t| t.as_str()).unwrap_or("Trailer").to_string(),
                    });
                }
            }
        }

        let mut seasons = None;
        if target_type == "tv" {
            if let Some(s_arr) = data.get("seasons").and_then(|s| s.as_array()) {
                let mut s_vec = Vec::new();
                for s in s_arr {
                    let s_num = s.get("season_number").and_then(|n| n.as_u64()).unwrap_or(0) as u32;
                    let poster_p = s.get("poster_path").and_then(|p| p.as_str()).map(|x| x.to_string());
                    s_vec.push(Season {
                        id: s.get("id").and_then(|i| i.as_u64()).unwrap_or(0),
                        season_number: s_num,
                        name: s.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                        episode_count: s.get("episode_count").and_then(|c| c.as_u64()).unwrap_or(0) as u32,
                        poster_url: format_image_url(&poster_p, "w300"),
                        poster_path: poster_p,
                        episodes: None,
                    });
                }
                seasons = Some(s_vec);
            }
        }

        Ok(MediaDetails {
            id,
            title,
            overview: data.get("overview").and_then(|o| o.as_str()).unwrap_or("").to_string(),
            poster_url: format_image_url(&poster_path, "w500"),
            backdrop_url: format_image_url(&backdrop_path, "original"),
            release_date: data.get("release_date").or_else(|| data.get("first_air_date")).and_then(|d| d.as_str()).map(|s| s.to_string()),
            vote_average: data.get("vote_average").and_then(|v| v.as_f64()).unwrap_or(0.0),
            runtime: data.get("runtime").and_then(|r| r.as_u64()).map(|n| n as u32),
            genres,
            imdb_id,
            media_type: target_type.to_string(),
            cast,
            trailers,
            seasons,
            status: data.get("status").and_then(|s| s.as_str()).map(|s| s.to_string()),
            tagline: data.get("tagline").and_then(|t| t.as_str()).map(|s| s.to_string()),
        })
    }

    pub async fn get_season_episodes(&self, tv_id: u64, season_number: u32, language: Option<&str>) -> Result<Vec<Episode>, String> {
        let lang = language.unwrap_or("en-US");
        let url = format!("{}/tv/{}/season/{}?api_key={}&language={}", TMDB_BASE_URL, tv_id, season_number, self.api_key, lang);
        let res = self.client.get(&url).send().await.map_err(|e| e.to_string())?;
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

        let mut episodes = Vec::new();
        if let Some(ep_arr) = data.get("episodes").and_then(|e| e.as_array()) {
            for ep in ep_arr {
                let still_p = ep.get("still_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                episodes.push(Episode {
                    id: ep.get("id").and_then(|i| i.as_u64()).unwrap_or(0),
                    episode_number: ep.get("episode_number").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
                    season_number,
                    name: ep.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                    overview: ep.get("overview").and_then(|o| o.as_str()).unwrap_or("").to_string(),
                    still_url: format_image_url(&still_p, "w300"),
                    still_path: still_p,
                    air_date: ep.get("air_date").and_then(|d| d.as_str()).map(|s| s.to_string()),
                    vote_average: ep.get("vote_average").and_then(|v| v.as_f64()).unwrap_or(0.0),
                });
            }
        }
        Ok(episodes)
    }

    pub async fn get_recommendations(&self, media_type: &str, id: u64, language: Option<&str>) -> Result<Vec<MediaItem>, String> {
        let target = if media_type=="anime" {"tv"} else {media_type};
        let lang = language.unwrap_or("en-US");
        let url = format!("{}/{}/{}/recommendations?api_key={}&language={}", TMDB_BASE_URL, target, id, self.api_key, lang);
        let res = self.client.get(&url).send().await.map_err(|e| e.to_string())?;
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        if let Some(results)=data.get("results").and_then(|r| r.as_array()){
            for item in results.iter().take(12){
                let title = item.get("title").or_else(|| item.get("name")).and_then(|t| t.as_str()).unwrap_or("Untitled").to_string();
                let poster_path = item.get("poster_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                let backdrop_path = item.get("backdrop_path").and_then(|p| p.as_str()).map(|s| s.to_string());
                items.push(MediaItem{
                    id: item.get("id").and_then(|i| i.as_u64()).unwrap_or(0),
                    title,
                    original_title: None,
                    overview: item.get("overview").and_then(|o| o.as_str()).unwrap_or("").to_string(),
                    poster_path: poster_path.clone(),
                    backdrop_path: backdrop_path.clone(),
                    poster_url: format_image_url(&poster_path, "w500"),
                    backdrop_url: format_image_url(&backdrop_path, "w1280"),
                    release_date: item.get("release_date").or_else(|| item.get("first_air_date")).and_then(|d| d.as_str()).map(|s| s.to_string()),
                    vote_average: item.get("vote_average").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    vote_count: item.get("vote_count").and_then(|v| v.as_u64()).unwrap_or(0),
                    media_type: target.to_string(),
                    genre_ids: None,
                    imdb_id: None,
                });
            }
        }
        Ok(items)
    }
}
