// ==========================================================================
// Mamzouka Stream - Main Application Logic
// ==========================================================================

// Global error handler for runtime diagnostics
window.addEventListener('error', (e) => {
  console.error('[App Runtime Error]', e.message, e.filename, e.lineno);
});

// Tauri API Bridge Helper
let _baseInvoke = async (cmd, args = {}) => {
  try {
    if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
      return await window.__TAURI__.core.invoke(cmd, args);
    }
    if (window.__TAURI__ && typeof window.__TAURI__.invoke === 'function') {
      return await window.__TAURI__.invoke(cmd, args);
    }
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
      return await window.__TAURI_INTERNALS__.invoke(cmd, args);
    }
  } catch (err) {
    console.error(`[IPC Error: ${cmd}]`, err);
    throw err;
  }
  console.warn(`[No IPC Provider found for ${cmd}]`, args);
  return null;
};
let invoke = _baseInvoke;
// TMDB cache + adaptive poster helpers (set after I18N, but hoisted here for early wrapping)
const tmdbCache = new Map();
const TMDB_CACHE_TTL = 5*60*1000;
const autoTranscodedIds = new Set();
(function wrapInvokeCache(){
  const orig = invoke;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  invoke = async (cmd, args={}, opts={}) => {
    const cacheable = new Set(['get_trending','discover_media','search_media','get_media_details','get_recommendations']);
    if (cacheable.has(cmd)) {
      const key = JSON.stringify({cmd, args, lang: (typeof getTmdbLanguage==='function'? getTmdbLanguage() : 'en-US')});
      const hit = tmdbCache.get(key);
      if (hit && hit.data && Date.now() - hit.ts < TMDB_CACHE_TTL) return hit.data;
      if (hit && hit.promise) return hit.promise;
      const attempt = async (retriesLeft) => {
        try {
          const data = await orig(cmd, args);
          tmdbCache.set(key, { data, ts: Date.now() });
          return data;
        } catch (e) {
          if (retriesLeft > 0) {
            await sleep(1200);
            return attempt(retriesLeft - 1);
          }
          // Stale-while-revalidate: serve expired cache rather than a dead screen
          if (hit && hit.data) {
            console.warn(`[TMDB] serving stale cache for ${cmd} after retry failure`);
            try { trackEvent('tmdb_stale_served', { cmd }); } catch {}
            return hit.data;
          }
          tmdbCache.delete(key);
          throw e;
        }
      };
      const p = attempt(opts.retries != null ? opts.retries : 1);
      tmdbCache.set(key, { promise: p, ts: Date.now() });
      return p;
    }
    return orig(cmd, args);
  };
})();

// Error log ring buffer for Export-logs diagnostics (last 120 entries)
const errorLog = [];
function logError(scope, err) {
  try {
    errorLog.push({ ts: new Date().toISOString(), scope, msg: String((err && err.message) || err || '').slice(0, 300) });
    if (errorLog.length > 120) errorLog.splice(0, errorLog.length - 120);
  } catch {}
}
window.addEventListener('error', (e) => logError('window', e.message || e.error));
window.addEventListener('unhandledrejection', (e) => logError('promise', (e.reason && e.reason.message) || e.reason));

// App boot timestamp — no ads in the first 30s of a session (calmer UX)
const APP_BOOT_TS = Date.now();
function isAdsGracePeriod() { return Date.now() - APP_BOOT_TS < 30000; }

// Global App State
const state = {
  currentView: 'discover',
  featuredItem: null,
  selectedMedia: null,
  selectedSeason: 1,
  selectedEpisode: 1,
  activeMovieGenre: '',
  activeTvGenre: '',
  activeAnimeGenre: '',
  moviePage: 1,
  movieSort: 'popularity.desc',
  movieYear: '',
  movieRating: 0,
  movieCountry: '',
  tvPage: 1,
  tvSort: 'popularity.desc',
  tvYear: '',
  tvRating: 0,
  tvCountry: '',
  animePage: 1,
  activeLiveTvCountry: 'all',
  activeLiveTvCat: 'all',
  activeLiveTvSearch: '',
  activeRadioCat: 'all',
  activeYoutubeCat: 'trending',
  activeTwitchCat: 'esports',
  activeDownloadFilter: 'all',
  serverPort: 8899,
  // === Remote control (free DB) — live overrides, baked-in defaults keep working ===
  remoteProviders: null, // e.g. { vidsrc:false } hides a broken source everywhere
  remoteTorrentioBase: '',
  remoteMaxFailover: 3,
  torrentEngineUrl: 'http://127.0.0.1:31337',
  settings: {
    tmdb_api_key: '',
    default_subtitle_lang: 'ara',
    preferred_resolution: '1080p',
    auto_play_next: true,
  },
  watchlist: [],
  downloads: [],
  addons: [],
  activeStream: null,
  subtitles: [],
  playerControlsTimeout: null,
  isRadio: false,
  // === Modern Player Extensions ===
  subDelayMs: parseInt(localStorage.getItem('mamzouka_sub_delay')||'0',10) || 0,
  subStyle: (()=>{ const v=JSON.parse(localStorage.getItem('mamzouka_sub_style')||'null'); if(v && v.size==='medium') v.size='normal'; return v; })() || { size:'normal', family:'Cairo', color:'#ffffff', bgOpacity:70, shadow:true },
  subDualEnabled: localStorage.getItem('mamzouka_sub_dual')==='1',
  subSecondaryLang: localStorage.getItem('mamzouka_sub_sec_lang')||'',
  audioBoost: parseFloat(localStorage.getItem('mamzouka_boost')||'100')/100 || 1,
  nightMode: localStorage.getItem('mamzouka_night')==='1',
  ambientOn: localStorage.getItem('mamzouka_ambient')==='1',
  aspectMode: localStorage.getItem('mamzouka_aspect')||'original',
  filterVals: (()=>{ const v=JSON.parse(localStorage.getItem('mamzouka_filters')||'null'); if(v && v.hue===undefined) v.hue=0; return v; })() || { brightness:100, contrast:100, saturation:100, hue:0 },
  playerBrightness: parseInt(localStorage.getItem('mamzouka_pbrightness')||'100',10) || 100,
  failoverAttempts: 0,
  lastBufferTime: 0,
};

// === Single-language I18N (EN default / FR / AR) with RTL only for AR ===
// Dictionaries live in i18n.js (window.MAMZOUKA_I18N). No mixed-language strings.
const I18N = (typeof window !== 'undefined' && window.MAMZOUKA_I18N) ? window.MAMZOUKA_I18N : {
  en: { nav: {}, searchPlaceholder: '', hero: {}, sections: {}, stream: {}, player: {}, errors: {}, common: {} },
  fr: { nav: {}, searchPlaceholder: '', hero: {}, sections: {}, stream: {}, player: {}, errors: {}, common: {} },
  ar: { nav: {}, searchPlaceholder: '', hero: {}, sections: {}, stream: {}, player: {}, errors: {}, common: {} }
};
function getCurrentLang(){
  const v = localStorage.getItem('mamzouka_lang');
  if (v === 'ar' || v === 'fr' || v === 'en') return v;
  return 'en';
}
function t(path, fallback = '') {
  try {
    const lang = getCurrentLang();
    const parts = String(path).split('.');
    let cur = (I18N[lang] || I18N.en);
    for (const p of parts) cur = cur?.[p];
    if (typeof cur === 'string' && cur) return cur;
    cur = I18N.en;
    for (const p of parts) cur = cur?.[p];
    return (typeof cur === 'string' && cur) ? cur : fallback;
  } catch { return fallback; }
}
function getErrorDict(){
  const lang = getCurrentLang();
  return (I18N[lang] && I18N[lang].errors) || I18N.en.errors || {};
}
function getTmdbLanguage(){ const l = getCurrentLang(); return l === 'ar' ? 'ar-SA' : l === 'fr' ? 'fr-FR' : 'en-US'; }
function getSubtitleCode(){ const l = getCurrentLang(); return l === 'ar' ? 'ara' : l === 'fr' ? 'fre' : 'eng'; }
function applyLang(lang){
  const l = (lang === 'ar' || lang === 'fr') ? lang : 'en';
  localStorage.setItem('mamzouka_lang', l);
  document.documentElement.setAttribute('lang', l);
  document.documentElement.setAttribute('dir', l === 'ar' ? 'rtl' : 'ltr');
  try { document.body.style.direction = l === 'ar' ? 'rtl' : 'ltr'; } catch {}
  // Top dropdown value
  const sel = document.getElementById('lang-select');
  if (sel && sel.value !== l) sel.value = l;
  // Legacy toggle button (removed in favor of dropdown) — no-op if absent
  const flag = document.getElementById('lang-toggle-flag');
  const txt = document.getElementById('lang-toggle-text');
  if (flag) flag.textContent = l === 'ar' ? '🇬🇧' : l === 'fr' ? '🇫🇷' : '🇲🇦';
  if (txt) txt.textContent = l === 'ar' ? 'English' : l === 'fr' ? 'Français' : 'العربية';
  // Update nav labels (single language)
  const dict = (I18N[l] && I18N[l].nav) || {};
  document.querySelectorAll('.nav-item').forEach(item => {
    const view = item.dataset.view;
    const span = item.querySelector('span:not(.nav-badge)');
    if (span && dict[view]) span.textContent = dict[view];
  });
  // Generic data-i18n bindings: <tag data-i18n="sections.trending">
  try {
    document.querySelectorAll('[data-i18n]').forEach(node => {
      const key = node.getAttribute('data-i18n');
      const val = t(key, '');
      if (val) node.textContent = val;
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(node => {
      const key = node.getAttribute('data-i18n-ph');
      const val = t(key, '');
      if (val && 'placeholder' in node) node.placeholder = val;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(node => {
      const key = node.getAttribute('data-i18n-title');
      const val = t(key, '');
      if (val) node.title = val;
    });
  } catch {}
  // Search placeholder
  const sInput = document.getElementById('search-input');
  if (sInput) sInput.placeholder = t('searchPlaceholder', sInput.placeholder);
  // Hero
  const heroBadge = document.querySelector('.hero-badge');
  if (heroBadge) heroBadge.textContent = t('hero.featured', heroBadge.textContent);
  const heroPlay = document.getElementById('hero-btn-play');
  if (heroPlay && heroPlay.querySelector('span')) heroPlay.querySelector('span').textContent = t('hero.streamNow', 'Stream Now');
  const heroInfo = document.getElementById('hero-btn-info');
  if (heroInfo && heroInfo.querySelector('span')) heroInfo.querySelector('span').textContent = t('hero.details', 'Details');
  // Section titles (single language, queried by container ids)
  const sectionMap = [
    ['#trending-grid', 'sections.trending'], ['#popular-movies-grid', 'sections.topMovies'],
    ['#popular-tv-grid', 'sections.topTv'], ['#home-anime-grid', 'sections.animeTitle'],
    ['#home-arabic-grid', 'sections.arabCinema'], ['#continue-watching-grid', 'sections.continueWatching'],
    ['#recs-grid', 'sections.recs'], ['#home-livetv-grid', 'sections.liveChannels']
  ];
  sectionMap.forEach(([gridSel, key]) => {
    try {
      const grid = document.querySelector(gridSel);
      if (!grid) return;
      const header = grid.previousElementSibling;
      const titleEl = header ? header.querySelector('.section-title') : null;
      const val = t(key, '');
      if (titleEl && val) titleEl.textContent = val;
    } catch {}
  });
  // Country/origin dropdowns + filter labels → single language (no mixed text)
  try { translateFilterLabels(); } catch {}
  // All chips/pills/selects site-wide → single language
  try { translateChips(); } catch {}
  // Re-render remote announcement text in the new language
  try { refreshAnnounceLang(); } catch {}
  // Save for TMDB calls
  window.__MAMZ_TMDB_LANG__ = getTmdbLanguage();
}

// Refresh announcement banner text after a language switch
function refreshAnnounceLang() {
  try {
    if (!window.RemoteControl) return;
    const an = window.RemoteControl.get('announcement', null);
    const bar = document.getElementById('remote-announce');
    const txt = document.getElementById('remote-announce-text');
    if (!an || !an.enabled || !bar || !txt || bar.style.display === 'none') return;
    const l = getCurrentLang();
    const msg = l === 'ar' ? (an.textAr || an.textEn) : l === 'fr' ? (an.textFr || an.textEn) : (an.textEn || an.textAr);
    if (msg) txt.textContent = msg;
  } catch {}
}

// Translate movie/tv country <select> options + toolbar labels from dictionaries
function translateFilterLabels() {
  const l = getCurrentLang();
  const countries = (typeof window !== 'undefined' && window.MAMZOUKA_COUNTRIES) || {};
  const filters = (typeof window !== 'undefined' && window.MAMZOUKA_FILTERS) || {};
  ['movie-country-select', 'tv-country-select'].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.querySelectorAll('option').forEach((opt) => {
      const entry = countries[opt.value];
      if (entry && entry[l]) {
        // Preserve the leading flag emoji(s) already in the option text
        let flag = '';
        try {
          const m = opt.textContent.match(/^\s*([^\p{L}\p{N}]+)/u);
          if (m) flag = m[1];
        } catch { const m2 = opt.textContent.match(/^\s*(\S+)/); if (m2 && /[\uD800-\uDBFF]/.test(m2[1])) flag = m2[1] + ' '; }
        if (!flag && opt.value === '') flag = '🌐 ';
        opt.textContent = `${flag}${entry[l]}`;
      }
    });
    try { sel.value = cur; } catch {}
    // Optgroup labels → single language (per select, matched by position)
    try {
      const which = id.startsWith('movie') ? 'movie' : 'tv';
      const og = ((window.MAMZOUKA_OPTGROUPS || {})[which] || {})[l];
      if (Array.isArray(og)) {
        sel.querySelectorAll('optgroup').forEach((g, i) => { if (og[i]) g.label = og[i]; });
      }
    } catch {}
  });
  // Sort / year / rating option texts → single language (keyed by value)
  try {
    const S = window.MAMZOUKA_SELECTS || {};
    const optDicts = [
      ['movie-sort-select', S.sort], ['tv-sort-select', S.sort],
      ['movie-year-select', { ...(S.yearAll || {}), ...(S.year1980 || {}) }],
      ['tv-year-select', { ...(S.yearAll || {}), ...(S.year1980 || {}) }],
      ['movie-rating-select', { ...(S.ratingAll || {}), ...(S.ratingStars || {}) }],
      ['tv-rating-select', { ...(S.ratingAll || {}), ...(S.ratingStars || {}) }],
    ];
    optDicts.forEach(([id, dict]) => {
      const sel = document.getElementById(id);
      if (!sel || !dict) return;
      const cur = sel.value;
      sel.querySelectorAll('option').forEach((opt) => {
        const entry = dict[opt.value];
        if (entry && entry[l]) opt.textContent = entry[l];
      });
      try { sel.value = cur; } catch {}
    });
  } catch {}
  const labelMap = [
    ['movie-country-select', 'countryLabel'], ['tv-country-select', 'countryLabel'],
    ['movie-sort-select', 'sortLabel'], ['tv-sort-select', 'sortLabel'],
    ['movie-year-select', 'yearLabel'], ['tv-year-select', 'yearLabel'],
    ['movie-rating-select', 'ratingLabel'], ['tv-rating-select', 'ratingLabel']
  ];
  labelMap.forEach(([selId, key]) => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const group = sel.closest('.filter-select-group');
    const lab = group ? group.querySelector('.filter-select-label') : null;
    if (lab && filters[key] && filters[key][l]) lab.textContent = filters[key][l];
  });
}

// Translate every chip/pill site-wide from MAMZOUKA_CHIPS (keyed by data-*).
// Static HTML holds the initial language; this rewrites all on each switch,
// including dynamically injected chips (LiveTV categories, etc.).
function translateChips() {
  const l = getCurrentLang();
  const C = window.MAMZOUKA_CHIPS || {};
  const set = (node, entry) => { if (node && entry && entry[l]) node.textContent = entry[l]; };
  document.querySelectorAll('[data-mood]').forEach((b) => set(b, (C.mood || {})[b.dataset.mood]));
  document.querySelectorAll('#movies-genre-scroller [data-movie-genre]').forEach((b) => {
    set(b, (C.movieGenre || {})[`${b.dataset.movieGenre || ''}|${b.dataset.movieCountry || ''}`]);
  });
  document.querySelectorAll('#tv-genre-scroller [data-tv-genre]').forEach((b) => {
    set(b, (C.tvGenre || {})[`${b.dataset.tvGenre || ''}|${b.dataset.tvCountry || ''}`]);
  });
  document.querySelectorAll('#anime-genre-scroller [data-anime-genre]').forEach((b) => set(b, (C.animeGenre || {})[b.dataset.animeGenre]));
  document.querySelectorAll('#livetv-country-filters [data-country]').forEach((b) => set(b, (C.liveCountry || {})[b.dataset.country]));
  document.querySelectorAll('#livetv-cat-scroller [data-cat]').forEach((b) => set(b, (C.liveCat || {})[String(b.dataset.cat || '').toLowerCase()]));
  document.querySelectorAll('#radio-cat-scroller [data-rcat]').forEach((b) => set(b, (C.radioCat || {})[b.dataset.rcat]));
  document.querySelectorAll('#youtube-cat-scroller [data-ytcat]').forEach((b) => set(b, (C.ytCat || {})[b.dataset.ytcat]));
  document.querySelectorAll('#twitch-cat-scroller [data-twcat]').forEach((b) => set(b, (C.twCat || {})[b.dataset.twcat]));
  document.querySelectorAll('#stream-filters [data-filter]').forEach((b) => set(b, (C.streamFilter || {})[b.dataset.filter]));
  document.querySelectorAll('#downloads-filters [data-dfilter]').forEach((b) => set(b, (C.dlFilter || {})[b.dataset.dfilter]));
  document.querySelectorAll('#settings-tabs [data-tab]').forEach((b) => set(b, (C.settingsTab || {})[b.dataset.tab]));
  // Generic settings/player <select> options, keyed "selectId|value"
  try {
    const G = window.MAMZOUKA_GENOPTS || {};
    document.querySelectorAll('select').forEach((sel) => {
      if (!sel.id) return;
      const cur = sel.value;
      let touched = false;
      sel.querySelectorAll('option').forEach((opt) => {
        const entry = G[`${sel.id}|${opt.value}`];
        if (entry && entry[l]) { opt.textContent = entry[l]; touched = true; }
      });
      if (touched) { try { sel.value = cur; } catch {} }
    });
  } catch {}
}
function getAdaptivePoster(item){
  const path = item.poster_path;
  if (!path) return item.poster_url || null;
  const w = window.innerWidth < 720 ? 'w342' : (window.devicePixelRatio > 1.5 ? 'w780' : 'w500');
  return `https://image.tmdb.org/t/p/${w}${path}`;
}
function trackEvent(name, data={}){
  try{
    const key='mamzouka_analytics';
    const arr=JSON.parse(localStorage.getItem(key)||'[]');
    arr.push({name, data, ts:Date.now()});
    if(arr.length>200) arr.splice(0, arr.length-200);
    localStorage.setItem(key, JSON.stringify(arr));
    console.log('[Analytics]', name, data);
  }catch{}
}

// Cached DOM Elements Container
let el = {};

function initElements() {
  el = {
    // Navigation
    navItems: document.querySelectorAll('.nav-item'),
    views: {
      discover: document.getElementById('view-discover'),
      movies: document.getElementById('view-movies'),
      livetv: document.getElementById('view-livetv'),
      radio: document.getElementById('view-radio'),
      youtube: document.getElementById('view-youtube'),
      twitch: document.getElementById('view-twitch'),
      tv: document.getElementById('view-tv-shows'),
      anime: document.getElementById('view-anime'),
      addons: document.getElementById('view-addons'),
      watchlist: document.getElementById('view-watchlist'),
      downloads: document.getElementById('view-downloads'),
      settings: document.getElementById('view-settings'),
      search: document.getElementById('view-search'),
    },
    livetvCountryFilters: document.getElementById('livetv-country-filters'),
    livetvCatScroller: document.getElementById('livetv-cat-scroller'),
    livetvSearchInput: document.getElementById('livetv-search-input'),
    livetvGrid: document.getElementById('livetv-grid'),
    radioGrid: document.getElementById('radio-grid'),
    radioCatScroller: document.getElementById('radio-cat-scroller'),
    youtubeGrid: document.getElementById('youtube-grid'),
    youtubeCatScroller: document.getElementById('youtube-cat-scroller'),
    twitchGrid: document.getElementById('twitch-grid'),
    twitchCatScroller: document.getElementById('twitch-cat-scroller'),
    btnAddIptv: document.getElementById('btn-add-iptv'),
    iptvCustomName: document.getElementById('iptv-custom-name'),
    iptvCustomUrl: document.getElementById('iptv-custom-url'),
    downloadsGrid: document.getElementById('downloads-grid'),
    downloadsCount: document.getElementById('downloads-count'),
    btnOpenDownloadsFolder: document.getElementById('btn-open-downloads-folder'),
    downloadsFilters: document.getElementById('downloads-filters'),
    watchlistCount: document.getElementById('watchlist-count'),
    addonsCount: document.getElementById('addons-count'),
    serverStatusText: document.getElementById('server-status-text'),

    // Search
    searchInput: document.getElementById('search-input'),
    searchClearBtn: document.getElementById('search-clear-btn'),
    searchGrid: document.getElementById('search-grid'),
    searchTitle: document.getElementById('search-title'),
    btnRefresh: document.getElementById('btn-refresh'),

    // Hero Banner
    heroBanner: document.getElementById('hero-banner'),
    heroTitle: document.getElementById('hero-title'),
    heroRating: document.getElementById('hero-rating'),
    heroYear: document.getElementById('hero-year'),
    heroType: document.getElementById('hero-type'),
    heroOverview: document.getElementById('hero-overview'),
    heroBtnPlay: document.getElementById('hero-btn-play'),
    heroBtnInfo: document.getElementById('hero-btn-info'),

    // Grids & Scrollers & Filters
    moviesGenreScroller: document.getElementById('movies-genre-scroller'),
    movieCountrySelect: document.getElementById('movie-country-select'),
    movieSortSelect: document.getElementById('movie-sort-select'),
    movieYearSelect: document.getElementById('movie-year-select'),
    movieRatingSelect: document.getElementById('movie-rating-select'),
    btnLoadMoreMovies: document.getElementById('btn-load-more-movies'),

    tvGenreScroller: document.getElementById('tv-genre-scroller'),
    tvCountrySelect: document.getElementById('tv-country-select'),
    tvSortSelect: document.getElementById('tv-sort-select'),
    tvYearSelect: document.getElementById('tv-year-select'),
    tvRatingSelect: document.getElementById('tv-rating-select'),
    btnLoadMoreTv: document.getElementById('btn-load-more-tv'),

    animeGenreScroller: document.getElementById('anime-genre-scroller'),
    btnLoadMoreAnime: document.getElementById('btn-load-more-anime'),

    moodScroller: document.getElementById('mood-scroller'),
    moodGrid: document.getElementById('mood-grid'),
    moodStatus: document.getElementById('mood-status'),
    continueWatchingGrid: document.getElementById('continue-watching-grid'),
    continueWatchingHeader: document.getElementById('continue-watching-header'),
    btnClearHistory: document.getElementById('btn-clear-history'),
    recsGrid: document.getElementById('recs-grid'),
    recsHeader: document.getElementById('recs-header'),
    recsSubtitle: document.getElementById('recs-subtitle'),
    trendingGrid: document.getElementById('trending-grid'),
    popularMoviesGrid: document.getElementById('popular-movies-grid'),
    popularTvGrid: document.getElementById('popular-tv-grid'),
    homeAnimeGrid: document.getElementById('home-anime-grid'),
    homeArabicGrid: document.getElementById('home-arabic-grid'),
    btnViewAllArabic: document.getElementById('btn-view-all-arabic'),
    homeLiveTvGrid: document.getElementById('home-livetv-grid'),
    moviesGrid: document.getElementById('all-movies-grid'),
    tvShowsGrid: document.getElementById('tv-shows-grid'),
    animeGrid: document.getElementById('anime-grid'),
    watchlistGrid: document.getElementById('watchlist-grid'),
    featuredAddonsGrid: document.getElementById('featured-addons-grid'),
    installedAddonsList: document.getElementById('installed-addons-list'),

    // Addon Installation
    addonManifestInput: document.getElementById('addon-manifest-input'),
    btnInstallAddon: document.getElementById('btn-install-addon'),

    // Details Modal
    detailsModal: document.getElementById('details-modal'),
    modalCloseBtn: document.getElementById('modal-close-btn'),
    modalHero: document.getElementById('modal-hero'),
    modalPoster: document.getElementById('modal-poster'),
    modalTitle: document.getElementById('modal-title'),
    modalRating: document.getElementById('modal-rating'),
    modalYear: document.getElementById('modal-year'),
    modalRuntime: document.getElementById('modal-runtime'),
    modalTrailerBtn: document.getElementById('modal-trailer-btn'),
    modalWatchlistBtn: document.getElementById('modal-watchlist-btn'),
    modalGenres: document.getElementById('modal-genres'),
    modalOverview: document.getElementById('modal-overview'),
    modalTrailersSection: document.getElementById('modal-trailers-section'),
    modalTrailersList: document.getElementById('modal-trailers-list'),
    tvSeasonPickerContainer: document.getElementById('tv-season-picker-container'),
    seasonSelect: document.getElementById('season-select'),
    episodesList: document.getElementById('episodes-list'),
    modalCast: document.getElementById('modal-cast'),
    streamsList: document.getElementById('streams-list'),
    streamsLoading: document.getElementById('streams-loading'),
    streamFilters: document.getElementById('stream-filters'),

    // Trailer Modal
    trailerModal: document.getElementById('trailer-modal'),
    trailerModalTitle: document.getElementById('trailer-modal-title'),
    trailerModalClose: document.getElementById('trailer-modal-close'),
    trailerIframe: document.getElementById('trailer-iframe'),

    // Video Player
    playerView: document.getElementById('player-view'),
    mainVideo: document.getElementById('main-video'),
    mainIframe: document.getElementById('main-iframe'),
    playerOverlay: document.getElementById('player-overlay'),
    playerCenterPlay: document.getElementById('player-center-play'),
    playerBtnBack: document.getElementById('player-btn-back'),
    playerMediaTitle: document.getElementById('player-media-title'),
    playerStreamStats: document.getElementById('player-stream-stats'),
    playerProgressBar: document.getElementById('player-progress-bar'),
    playerBufferFill: document.getElementById('player-buffer-fill'),
    playerProgressFill: document.getElementById('player-progress-fill'),
    playerProgressThumb: document.getElementById('player-progress-thumb'),
    playerProgressTooltip: document.getElementById('player-progress-tooltip'),
    playerBtnPlay: document.getElementById('player-btn-play'),
    playerBtnBackward10: document.getElementById('player-btn-backward10'),
    playerBtnForward10: document.getElementById('player-btn-forward10'),
    playerBtnMute: document.getElementById('player-btn-mute'),
    playerVolume: document.getElementById('player-volume'),
    playerTime: document.getElementById('player-time'),
    playerBtnSpeed: document.getElementById('player-btn-speed'),
    speedMenu: document.getElementById('speed-menu'),
    playerBtnSubs: document.getElementById('player-btn-subs'),
    playerBtnPip: document.getElementById('player-btn-pip'),
    playerBtnFullscreen: document.getElementById('player-btn-fullscreen'),
    subtitlesMenu: document.getElementById('subtitles-menu'),
    subtitlesList: document.getElementById('subtitles-list'),

    miniPlayer: document.getElementById('mini-player'),
    miniPlayerTitle: document.getElementById('mini-player-title'),
    miniPlayerSub: document.getElementById('mini-player-sub'),
    miniPlayerPlay: document.getElementById('mini-player-play'),
    miniPlayerClose: document.getElementById('mini-player-close'),
    miniPlayerExpand: document.getElementById('mini-player-expand'),

    // Player Live HUD
    playerLiveHud: document.getElementById('torrent-live-hud'),
    hudStatus: document.getElementById('hud-status'),
    hudSpeed: document.getElementById('hud-speed'),
    hudPeers: document.getElementById('hud-peers'),
    hudProgress: document.getElementById('hud-progress'),
    playerServerBar: document.getElementById('player-server-bar'),
    playerLoadingOverlay: document.getElementById('player-loading-overlay'),
    playerLoadingMsg: document.getElementById('player-loading-msg'),
    playerBtnQuickVlc: document.getElementById('player-btn-quick-vlc'),
    playerBtnQuickBrowser: document.getElementById('player-btn-quick-browser'),

    // Settings — Account
    settingTmdbKey: document.getElementById('setting-tmdb-key'),
    settingRealDebridKey: document.getElementById('setting-real-debrid-key'),
    // Appearance
    settingTheme: document.getElementById('setting-theme'),
    settingAppLang: document.getElementById('setting-app-lang'),
    settingDensity: document.getElementById('setting-density'),
    settingKidsMode: document.getElementById('setting-kids-mode'),
    settingKidsPin: document.getElementById('setting-kids-pin'),
    kidsPinRow: document.getElementById('kids-pin-row'),
    // Playback
    settingRes: document.getElementById('setting-res'),
    settingAutoPlay: document.getElementById('setting-auto-play'),
    settingAutoSkip: document.getElementById('setting-auto-skip'),
    settingHwAccel: document.getElementById('setting-hw-accel'),
    // Downloads
    settingCacheDir: document.getElementById('setting-cache-dir'),
    settingQuota: document.getElementById('setting-quota'),
    quotaValue: document.getElementById('quota-value'),
    settingSmartOffline: document.getElementById('setting-smart-offline'),
    settingAutoTranscode: document.getElementById('setting-auto-transcode'),
    settingConcurrency: document.getElementById('setting-concurrency'),
    // Subtitles
    settingSubLang: document.getElementById('setting-sub-lang'),
    settingSecondarySub: document.getElementById('setting-secondary-sub'),
    settingSubSize: document.getElementById('setting-sub-size'),
    settingSubTranslate: document.getElementById('setting-sub-translate'),
    // Live
    settingEpgSource: document.getElementById('setting-epg-source'),
    // Notifications
    settingNotifEpisode: document.getElementById('setting-notif-episode'),
    settingNotifDownload: document.getElementById('setting-notif-download'),
    settingNotifAnalytics: document.getElementById('setting-notif-analytics'),
    // Advanced
    settingServerPort: document.getElementById('setting-server-port'),
    // Sync/Other
    btnExportSync: document.getElementById('btn-export-sync'),
    btnImportSync: document.getElementById('btn-import-sync'),
    importSyncFile: document.getElementById('import-sync-file'),
    btnSaveSettings: document.getElementById('btn-save-settings'),

    // Force Update & Expiry System
    forceUpdateModal: document.getElementById('force-update-modal'),
    btnOpenTelegramUpdate: document.getElementById('btn-open-telegram-update'),
    btnCopyTelegramLink: document.getElementById('btn-copy-telegram-link'),
    btnCheckUpdateAgain: document.getElementById('btn-check-update-again'),
    updateDevBypass: document.getElementById('update-dev-bypass'),
    updateToastCopy: document.getElementById('update-toast-copy'),
    updateModalTitle: document.getElementById('update-modal-title'),
    updateModalDesc: document.getElementById('update-modal-desc'),
    updateModalExpiry: document.getElementById('update-modal-expiry'),
    updateModalCurVer: document.getElementById('update-modal-cur-ver'),
    updateBadgeVersion: document.getElementById('update-badge-version'),
    updateBtnText: document.getElementById('update-btn-text'),
    settingUpdateExpiry: document.getElementById('setting-update-expiry'),
    settingUpdateTelegram: document.getElementById('setting-update-telegram'),
    btnSaveUpdateConfig: document.getElementById('btn-save-update-config'),
    btnTestForceUpdate: document.getElementById('btn-test-force-update'),
    btnResetUpdateConfig: document.getElementById('btn-reset-update-config'),
    updateStatusBadge: document.getElementById('update-status-badge'),

    // Ads System Elements
    prerollAdOverlay: document.getElementById('preroll-ad-overlay'),
    prerollVideo: document.getElementById('preroll-video'),
    prerollAdTitle: document.getElementById('preroll-ad-title'),
    btnPrerollVisit: document.getElementById('btn-preroll-visit'),
    btnPrerollSkip: document.getElementById('btn-preroll-skip'),
    prerollSkipText: document.getElementById('preroll-skip-text'),
    btnPrerollSound: document.getElementById('btn-preroll-sound'),
    prerollSoundText: document.getElementById('preroll-sound-text'),

    // Ads Settings Elements
    adsStatusBadge: document.getElementById('ads-status-badge'),
    settingAdsMasterEnabled: document.getElementById('setting-ads-master-enabled'),
    settingAdsVideoUrl: document.getElementById('setting-ads-video-url'),
    settingAdsSkipDelay: document.getElementById('setting-ads-skip-delay'),
    settingAdsPopunderUrl: document.getElementById('setting-ads-popunder-url'),
    settingAdsExcludedCountries: document.getElementById('setting-ads-excluded-countries'),
    btnSaveAdsConfig: document.getElementById('btn-save-ads-config'),
    btnTestPrerollAd: document.getElementById('btn-test-preroll-ad'),
    btnTestPopunderLink: document.getElementById('btn-test-popunder-link'),
    btnResetPopunderTimer: document.getElementById('btn-reset-popunder-timer'),
    btnResetAdsConfig: document.getElementById('btn-reset-ads-config'),

    // Modern Player 2026 — New Elements
    ambientCanvas: document.getElementById('ambient-canvas'),
    videoWrapper: document.getElementById('video-wrapper'),
    customSubtitles: document.getElementById('custom-subtitles'),
    subPrimary: document.getElementById('sub-primary'),
    subSecondary: document.getElementById('sub-secondary'),
    subDelaySlider: document.getElementById('sub-delay-slider'),
    subDelayValue: document.getElementById('sub-delay-value'),
    subFontSize: document.getElementById('sub-font-size'),
    subFontFamily: document.getElementById('sub-font-family'),
    subTextColor: document.getElementById('sub-text-color'),
    subBgOpacity: document.getElementById('sub-bg-opacity'),
    subTextShadow: document.getElementById('sub-text-shadow'),
    subSearchInput: document.getElementById('sub-search-input'),
    btnSubSearch: document.getElementById('btn-sub-search'),
    subSearchResults: document.getElementById('sub-search-results'),
    subDualToggle: document.getElementById('sub-dual-toggle'),
    subSecondaryLang: document.getElementById('sub-secondary-lang'),
    subDualList: document.getElementById('sub-dual-list'),
    btnSkipIntro: document.getElementById('btn-skip-intro'),
    btnSkipRecap: document.getElementById('btn-skip-recap'),
    nextEpisodeCard: document.getElementById('next-episode-card'),
    nextCardBg: document.getElementById('next-card-bg'),
    nextCardTitle: document.getElementById('next-card-title'),
    nextCardMeta: document.getElementById('next-card-meta'),
    nextCountdown: document.getElementById('next-countdown'),
    nextProgressFill: document.getElementById('next-card-progress-fill'),
    btnNextPlay: document.getElementById('btn-next-play'),
    btnNextCancel: document.getElementById('btn-next-cancel'),
    episodeDrawer: document.getElementById('episode-drawer'),
    drawerSeasonTabs: document.getElementById('drawer-season-tabs'),
    drawerEpisodesList: document.getElementById('drawer-episodes-list'),
    drawerSeasonLabel: document.getElementById('drawer-season-label'),
    btnCloseDrawer: document.getElementById('btn-close-drawer'),
    scrubPreview: document.getElementById('scrub-preview'),
    scrubCanvas: document.getElementById('scrub-canvas'),
    scrubTime: document.getElementById('scrub-time'),
    gestureLeft: document.getElementById('gesture-left'),
    gestureRight: document.getElementById('gesture-right'),
    gestureCenter: document.getElementById('gesture-center'),
    volumeOsd: document.getElementById('volume-osd'),
    volumeOsdFill: document.getElementById('volume-osd-fill'),
    volumeOsdText: document.getElementById('volume-osd-text'),
    volumeOsdIcon: document.getElementById('volume-osd-icon'),
    brightnessOsd: document.getElementById('brightness-osd'),
    brightnessOsdFill: document.getElementById('brightness-osd-fill'),
    brightnessOsdText: document.getElementById('brightness-osd-text'),
    seekRippleLeft: document.getElementById('seek-ripple-left'),
    seekRippleRight: document.getElementById('seek-ripple-right'),
    volumeBoostLabel: document.getElementById('volume-boost-label'),
    volumeBoostSlider: document.getElementById('volume-boost-slider'),
    boostValueLabel: document.getElementById('boost-value-label'),
    nightModeToggle: document.getElementById('night-mode-toggle'),
    playerBtnNight: document.getElementById('player-btn-night'),
    playerBtnAudio: document.getElementById('player-btn-audio'),
    playerBtnAmbient: document.getElementById('player-btn-ambient'),
    playerBtnFilters: document.getElementById('player-btn-filters'),
    playerBtnAspect: document.getElementById('player-btn-aspect'),
    playerBtnEpisodes: document.getElementById('player-btn-episodes'),
    audioMenu: document.getElementById('audio-menu'),
    aspectMenu: document.getElementById('aspect-menu'),
    filterPanel: document.getElementById('filter-panel'),
    audioTracksList: document.getElementById('audio-tracks-list'),
    filterBrightness: document.getElementById('filter-brightness'),
    filterContrast: document.getElementById('filter-contrast'),
    filterSaturation: document.getElementById('filter-saturation'),
    filterHue: document.getElementById('filter-hue'),
    filterBrightnessVal: document.getElementById('filter-brightness-val'),
    filterContrastVal: document.getElementById('filter-contrast-val'),
    filterSaturationVal: document.getElementById('filter-saturation-val'),
    filterHueVal: document.getElementById('filter-hue-val'),
    btnResetFilters: document.getElementById('btn-reset-filters'),
    resumeModal: document.getElementById('resume-modal'),
    resumeTitle: document.getElementById('resume-title'),
    resumeDesc: document.getElementById('resume-desc'),
    btnResumeYes: document.getElementById('btn-resume-yes'),
    btnResumeNo: document.getElementById('btn-resume-no'),
    resumeTimeLabel: document.getElementById('resume-time-label'),
  };
}

// ==========================================================================
// App Initialization
// ==========================================================================
function init() {
  initElements();
  // Apply bilingual UI early
  try { applyLang(getCurrentLang()); } catch {}
  setupEventListeners();

  // Wire language switcher (EN default / FR / AR, single language from top)
  const langSel = document.getElementById('lang-select');  if (langSel && !langSel.dataset.bound) {
    langSel.dataset.bound = '1';
    try { langSel.value = getCurrentLang(); } catch {}
    langSel.addEventListener('change', () => {
      applyLang(langSel.value);
      // Reload TMDB data with new language
      try { tmdbCache.clear(); } catch {}
      try { loadDiscoverContent(); loadContinueWatching(); } catch {}
    });
  }
  // Legacy toggle button (if present in older HTML)
  const langBtn = document.getElementById('btn-lang-toggle');
  if (langBtn && !langBtn.dataset.bound) {
    langBtn.dataset.bound = '1';
    langBtn.addEventListener('click', () => {
      const cur = getCurrentLang();
      const next = cur === 'en' ? 'fr' : cur === 'fr' ? 'ar' : 'en';
      applyLang(next);
      try { tmdbCache.clear(); } catch {}
      try { loadDiscoverContent(); loadContinueWatching(); } catch {}
    });
  }
  // Remote announcement banner dismiss (session only)
  const annClose = document.getElementById('remote-announce-close');
  if (annClose && !annClose.dataset.bound) {
    annClose.dataset.bound = '1';
    annClose.addEventListener('click', () => {
      const bar = document.getElementById('remote-announce');
      if (bar) bar.style.display = 'none';
      try { sessionStorage.setItem('mamzouka_announce_dismissed', '1'); } catch {}
    });
  }

  // Auto-Update & Expiry Verification Check
  initUpdateAndExpirySystem();

  // Smart Ads & Monetization Initialization
  initAdsSystem();

  // Modern Player 2026 Initialization
  setTimeout(() => { try { initModernPlayer(); } catch(e){ console.warn('Modern player init error', e); } }, 0);

  // Load all subsystems in parallel
  loadServerPort();
  initEngineHealthPill();
  // Hand the (public) remote-control credentials to the Rust policy guard
  // so backend enforcement uses the same live Supabase row as the UI.
  try {
    const rc = window.MAMZOUKA_REMOTE || {};
    if (rc.supabaseUrl && rc.supabaseAnonKey) {
      invoke('set_remote_source', { supabaseUrl: rc.supabaseUrl, supabaseKey: rc.supabaseAnonKey }).catch(() => {});
    }
  } catch {}
  loadSettings();
  loadWatchlist();
  loadDownloads();
  loadAddons();
  loadDiscoverContent();
  loadContinueWatching();
  loadAnalytics();
  // Pre-fetch dynamic Live TV categories in background
  refreshLiveTvCategoriesDynamic().catch(()=>{});
}

// ==========================================================================
// Foolproof Force Update & Expiry Blocker — Tamper-Resistant (2026)
// ==========================================================================
let remoteUpdateOverrides = null;
let remoteAdsOverrides = null;

function getEffectiveUpdateConfig() {
  const fileCfg = window.MAMZOUKA_UPDATE_CONFIG || {};
  let storageCfg = {};
  try {
    const raw = localStorage.getItem('mamzouka_update_config');
    if (raw) storageCfg = JSON.parse(raw);
  } catch (e) {}

  const defaults = {
    enabled: true,
    forceLock: false,
    expiryDate: '2027-01-01',
    telegramUrl: 'https://t.me/mamzouka_official',
    currentVersion: '2.0.0',
    newVersion: '2.1.0',
    titleAr: 'تحديث إجباري متوفر 🚀',
    titleEn: 'Critical Update Required',
    messageAr: 'انتهت صلاحية هذه النسخة من التطبيق. لضمان استمرار عمل سيرفرات البث والقنوات بدون تقطيع، يُرجى تحميل النسخة الجديدة من قناتنا الرسمية على تيليغرام.',
    messageEn: 'This version of Mamzouka Stream has reached its expiration date. Please download the latest update from our official Telegram channel to continue.',
    buttonTextAr: 'تحميل النسخة الجديدة من تيليغرام ✈️',
    buttonTextEn: 'Download Update on Telegram ✈️',
    remoteCheckUrl: '',
    remoteConfigUrl: '',
  };

  // TAMPER-RESISTANT merge: file config is AUTHORITATIVE for critical keys.
  const merged = { ...defaults, ...fileCfg };
  if (storageCfg.telegramUrl && !fileCfg.telegramUrl) merged.telegramUrl = storageCfg.telegramUrl;
  if (fileCfg.forceUpdate !== undefined) merged.forceLock = !!fileCfg.forceUpdate || !!fileCfg.forceLock;
  if (storageCfg.expiryDate && fileCfg.expiryDate) {
    const fileMs = Date.parse(fileCfg.expiryDate);
    const storMs = Date.parse(storageCfg.expiryDate);
    if (!isNaN(storMs) && !isNaN(fileMs) && storMs > fileMs) {
      console.warn('[Mamzouka][Security] Ignored localStorage expiry extension attempt');
    }
    merged.expiryDate = fileCfg.expiryDate;
  }
  if (storageCfg.enabled === false && fileCfg.enabled !== false) {
    console.warn('[Mamzouka][Security] Ignored localStorage enabled=false override');
    merged.enabled = fileCfg.enabled !== undefined ? !!fileCfg.enabled : merged.enabled;
  }
  // Remote cloud overrides — remote WINS over file for kill-switch (trusted GitHub)
  if (remoteUpdateOverrides) {
    if (remoteUpdateOverrides.expiryDate) merged.expiryDate = remoteUpdateOverrides.expiryDate;
    if (remoteUpdateOverrides.forceLock !== undefined) merged.forceLock = !!remoteUpdateOverrides.forceLock;
    if (remoteUpdateOverrides.enabled !== undefined) merged.enabled = !!remoteUpdateOverrides.enabled;
    if (remoteUpdateOverrides.telegramUrl) merged.telegramUrl = remoteUpdateOverrides.telegramUrl;
    if (remoteUpdateOverrides.currentVersion) merged.currentVersion = remoteUpdateOverrides.currentVersion;
    if (remoteUpdateOverrides.newVersion) merged.newVersion = remoteUpdateOverrides.newVersion;
    if (remoteUpdateOverrides.titleAr) merged.titleAr = remoteUpdateOverrides.titleAr;
    if (remoteUpdateOverrides.messageAr) merged.messageAr = remoteUpdateOverrides.messageAr;
    if (remoteUpdateOverrides.buttonTextAr) merged.buttonTextAr = remoteUpdateOverrides.buttonTextAr;
    if (remoteUpdateOverrides.remoteConfigUrl) merged.remoteConfigUrl = remoteUpdateOverrides.remoteConfigUrl;
  }
  return merged;
}

// === Unified remote control: Supabase live DB → GitHub fallback → local defaults ===
// Same JSON shape everywhere (see supabase-schema.sql). Applies update/ads
// through the existing override pipeline + extras (banner/providers/endpoints).
function applyUnifiedRemote(remote) {
  if (!remote || typeof remote !== 'object') return;
  try {
    const updSrc = remote.update || remote.updateConfig || {};
    const upd = {};
    if (updSrc.expiryDate) upd.expiryDate = updSrc.expiryDate;
    if (updSrc.forceLock !== undefined) upd.forceLock = !!updSrc.forceLock;
    if (updSrc.forceUpdate !== undefined) upd.forceLock = !!updSrc.forceUpdate;
    if (updSrc.enabled !== undefined) upd.enabled = !!updSrc.enabled;
    if (updSrc.telegramUrl) upd.telegramUrl = updSrc.telegramUrl;
    if (updSrc.telegram_url) upd.telegramUrl = updSrc.telegram_url;
    if (updSrc.currentVersion) upd.currentVersion = updSrc.currentVersion;
    if (updSrc.newVersion) upd.newVersion = updSrc.newVersion;
    if (updSrc.titleAr) upd.titleAr = updSrc.titleAr;
    if (updSrc.messageAr) upd.messageAr = updSrc.messageAr;
    if (updSrc.buttonTextAr) upd.buttonTextAr = updSrc.buttonTextAr;
    if (Object.keys(upd).length) remoteUpdateOverrides = { ...(remoteUpdateOverrides || {}), ...upd };

    const aSrc = remote.adsConfig || remote.ads || {};
    const ads = {};
    if (aSrc.preroll && typeof aSrc.preroll === 'object') ads.preroll = aSrc.preroll;
    if (aSrc.popunder && typeof aSrc.popunder === 'object') ads.popunder = aSrc.popunder;
    if (aSrc.excludedCountries) ads.excludedCountries = aSrc.excludedCountries;
    if (aSrc.excluded_countries) ads.excludedCountries = aSrc.excluded_countries;
    if (Object.keys(ads).length) remoteAdsOverrides = { ...(remoteAdsOverrides || {}), ...ads };

    applyRemoteExtras(remote);
  } catch (e) { console.warn('[Remote] apply failed', e); }
}

// Extras beyond update/ads: banner, provider kill-switches, endpoints, TMDB key
function applyRemoteExtras(remote) {
  // 1) Announcement banner (per language)
  try {
    const an = remote.announcement || {};
    const bar = document.getElementById('remote-announce');
    const txt = document.getElementById('remote-announce-text');
    const link = document.getElementById('remote-announce-link');
    const dismissed = sessionStorage.getItem('mamzouka_announce_dismissed') === '1';
    if (bar && txt && an.enabled && !dismissed) {
      const l = getCurrentLang();
      const msg = l === 'ar' ? (an.textAr || an.textEn) : l === 'fr' ? (an.textFr || an.textEn) : (an.textEn || an.textAr);
      if (msg) {
        txt.textContent = msg;
        if (link) {
          if (an.link) { link.style.display = ''; link.href = an.link; }
          else link.style.display = 'none';
        }
        bar.style.display = 'flex';
      } else bar.style.display = 'none';
    } else if (bar && !an.enabled) bar.style.display = 'none';
  } catch {}

  // 2) Provider kill-switches
  try {
    if (remote.providers && typeof remote.providers === 'object') {
      state.remoteProviders = { ...(state.remoteProviders || {}), ...remote.providers };
      if (typeof renderFilteredStreams === 'function' && el.streamsList && el.streamsList.children.length) {
        try { renderFilteredStreams(); } catch {}
      }
    }
  } catch {}

  // 3) Torrentio mirror endpoint
  try {
    const base = remote.endpoints && remote.endpoints.torrentio_base;
    if (typeof base === 'string' && /^https?:\/\//i.test(base)) {
      state.remoteTorrentioBase = base.replace(/\/$/, '');
    }
  } catch {}

  // 4) Limits
  try {
    const mf = remote.limits && parseInt(remote.limits.maxFailover, 10);
    if (!isNaN(mf) && mf >= 1 && mf <= 10) state.remoteMaxFailover = mf;
  } catch {}

  // 5) TMDB key rotation for ALL users still on the default key
  try {
    const rk = remote.tmdb && remote.tmdb.api_key;
    if (typeof rk === 'string' && rk.trim().length > 10) {
      (window.invoke || invoke)('set_remote_tmdb_key', { key: rk.trim() }).catch(() => {});
    }
  } catch {}
}

// First remotely-enabled web embed URL (kill-switch aware fallback chain)
function firstEnabledEmbedUrl(isSeries, embedId, s, e) {
  const list = [
    ['vidsrc', isSeries ? `https://vidsrc.su/embed/tv/${embedId}/${s}/${e}` : `https://vidsrc.su/embed/movie/${embedId}`],
    ['vidlink', isSeries ? `https://vidlink.pro/tv/${embedId}/${s}/${e}` : `https://vidlink.pro/movie/${embedId}`],
    ['smashy', isSeries ? `https://embed.smashystream.com/playere.php?tmdb=${embedId}&season=${s}&episode=${e}` : `https://embed.smashystream.com/playere.php?tmdb=${embedId}`],
    ['embedsu', isSeries ? `https://embed.su/embed/tv/${embedId}/${s}/${e}` : `https://embed.su/embed/movie/${embedId}`],
    ['autoembed', isSeries ? `https://player.autoembed.co/embed/tv/${embedId}/${s}/${e}` : `https://player.autoembed.co/embed/movie/${embedId}`],
    ['embed2', isSeries ? `https://www.2embed.cc/embedtv/${embedId}&s=${s}&e=${e}` : `https://www.2embed.cc/embed/${embedId}`],
  ];
  try {
    const map = state.remoteProviders || {};
    for (const [key, url] of list) {
      if (map[key] !== false) return url;
    }
  } catch {}
  return list[0][1];
}

function isProviderEnabled(providerName) {
  try {
    const map = state.remoteProviders;
    if (!map) return true;
    const n = String(providerName || '').toLowerCase();
    const key = n.includes('vidsrc') ? 'vidsrc' : n.includes('vidlink') ? 'vidlink'
      : n.includes('smashy') ? 'smashy' : n.includes('embed.su') ? 'embedsu'
      : n.includes('autoembed') ? 'autoembed' : n.includes('2embed') ? 'embed2'
      : n.includes('torrentio') ? 'torrentio' : n === 'yts' || n.includes('yts') ? 'yts' : null;
    if (!key) return true;
    return map[key] !== false;
  } catch { return true; }
}

function torrentInvokeArgs(base) {
  const args = { ...(base || {}) };
  try {
    const disabled = [];
    const map = state.remoteProviders || {};
    if (map.torrentio === false) disabled.push('torrentio');
    if (map.yts === false) disabled.push('yts');
    if (disabled.length) args.disabled_providers = disabled;
    if (state.remoteTorrentioBase) args.torrentio_base = state.remoteTorrentioBase;
  } catch {}
  return args;
}

async function fetchAndApplyRemoteCloudConfig() {
  // Unified source first: Supabase live DB → GitHub fallback → device cache
  try {
    if (window.RemoteControl) {
      const uni = await window.RemoteControl.refresh();
      if (uni && typeof uni === 'object' && Object.keys(uni).length) {
        applyUnifiedRemote(uni);
        console.log('[Mamzouka][Remote] unified config applied');
      }
    }
  } catch (e) { console.log('[Mamzouka][Remote] unified miss', (e && e.message) || e); }
  const updCfg = window.MAMZOUKA_UPDATE_CONFIG || {};
  const adsCfg = window.MAMZOUKA_ADS_CONFIG || {};
  const url = updCfg.remoteConfigUrl || updCfg.remoteCheckUrl || adsCfg.remoteConfigUrl || '';
  if (!url) return;
  try {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error('remote not ok '+res.status);
    const remote = await res.json();
    // Normalize: remote may be { update: {...}, ads: {...} } or flat
    const updSrc = remote.update || remote.updateConfig || remote;
    const adsSrc = remote.adsConfig || remote.ads || remote.update || null;

    // Update overrides
    const upd = {};
    if (updSrc.expiryDate) upd.expiryDate = updSrc.expiryDate;
    if (updSrc.forceLock !== undefined) upd.forceLock = !!updSrc.forceLock;
    if (updSrc.forceUpdate !== undefined) upd.forceLock = !!updSrc.forceUpdate;
    if (updSrc.enabled !== undefined) upd.enabled = !!updSrc.enabled;
    if (updSrc.telegramUrl) upd.telegramUrl = updSrc.telegramUrl;
    if (updSrc.telegram_url) upd.telegramUrl = updSrc.telegram_url;
    if (updSrc.currentVersion) upd.currentVersion = updSrc.currentVersion;
    if (updSrc.newVersion) upd.newVersion = updSrc.newVersion;
    if (updSrc.titleAr) upd.titleAr = updSrc.titleAr;
    if (updSrc.messageAr) upd.messageAr = updSrc.messageAr;
    if (updSrc.buttonTextAr) upd.buttonTextAr = updSrc.buttonTextAr;
    if (Object.keys(upd).length) remoteUpdateOverrides = { ...(remoteUpdateOverrides||{}), ...upd };

    const ads = {};
    const aSrc = adsSrc || remote;
    // preroll
    if (aSrc.preroll && typeof aSrc.preroll === 'object') ads.preroll = aSrc.preroll;
    if (aSrc.prerollVideoUrl) { ads.preroll = ads.preroll || {}; ads.preroll.videoUrl = aSrc.prerollVideoUrl; }
    if (aSrc.videoUrl && !ads.preroll) { ads.preroll = { videoUrl: aSrc.videoUrl }; }
    if (aSrc.popunder && typeof aSrc.popunder === 'object') ads.popunder = aSrc.popunder;
    if (aSrc.popunderUrl) { ads.popunder = ads.popunder || {}; ads.popunder.url = aSrc.popunderUrl; }
    if (aSrc.smartlink) { ads.popunder = ads.popunder || {}; ads.popunder.url = aSrc.smartlink; }
    if (aSrc.excludedCountries) ads.excludedCountries = aSrc.excludedCountries;
    if (aSrc.excluded_countries) ads.excludedCountries = aSrc.excluded_countries;
    // top-level ads.* handling when remote is flat with adsConfig key
    if (remote.adsConfig) {
      if (remote.adsConfig.preroll) ads.preroll = remote.adsConfig.preroll;
      if (remote.adsConfig.popunder) ads.popunder = remote.adsConfig.popunder;
      if (remote.adsConfig.excludedCountries) ads.excludedCountries = remote.adsConfig.excludedCountries;
    }
    if (Object.keys(ads).length) remoteAdsOverrides = { ...(remoteAdsOverrides||{}), ...ads };

    console.log('[Mamzouka][Remote] Cloud config fetched', { upd, ads });
    // Trigger expiry re-check and ads re-init
    const nowMs = getTrustedNowMs();
    const expMs = upd.expiryDate ? Date.parse(upd.expiryDate) : NaN;
    const shouldLock = upd.forceLock === true || (!isNaN(expMs) && nowMs >= expMs);
    if (shouldLock) {
      // Pause playback
      if (el.mainVideo && !el.mainVideo.paused) try { el.mainVideo.pause(); } catch {}
      showForceUpdateModal({ ...getEffectiveUpdateConfig(), ...upd }, false);
      enforceBlockerUI();
    } else {
      if (Object.keys(ads).length) {
        try { initAdsSystem(); } catch(e){ console.warn('ads re-init fail',e); }
      }
      checkAppExpirationAndUpdates();
    }
  } catch (e) {
    console.log('[Mamzouka][Remote] Cloud config offline fallback', e.message||e);
  }
}

// --- Trusted time (anti clock-tampering) — Spec: Etc/UTC with 2s timeout, sessionStorage cache ---
let __trustedNowOffset = 0; // remote - local
let __trustedNowFetched = false;
try {
  const cachedOff = sessionStorage.getItem('mamzouka_ntp_offset');
  const cachedFetched = sessionStorage.getItem('mamzouka_ntp_fetched');
  if (cachedOff && cachedFetched === '1') {
    __trustedNowOffset = parseInt(cachedOff,10) || 0;
    __trustedNowFetched = true;
  }
} catch {}
async function fetchTrustedNowMs() {
  const tryFetch = async (url, parser) => {
    try {
      const ctl = new AbortController();
      const tid = setTimeout(() => ctl.abort(), 2000);
      const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      clearTimeout(tid);
      if (!r.ok) return null;
      const j = await r.json();
      const ts = parser(j);
      if (ts && !isNaN(ts)) return ts;
    } catch {}
    return null;
  };
  // Spec primary: Etc/UTC
  let remoteMs = await tryFetch('https://worldtimeapi.org/api/timezone/Etc/UTC', j => j.unixtime ? j.unixtime*1000 : (j.datetime ? Date.parse(j.datetime) : (j.utc_datetime ? Date.parse(j.utc_datetime) : null)));
  // Spec fallback: timeapi.io
  if (!remoteMs) remoteMs = await tryFetch('https://timeapi.io/api/time/current/zone?timeZone=UTC', j => {
    if (j.dateTime) return Date.parse(j.dateTime);
    if (j.currentFileTime) return j.currentFileTime/10000 - 11644473600000; // .NET ticks
    if (j.datetime) return Date.parse(j.datetime);
    if (j.time) return Date.parse(j.time);
    return null;
  });
  // Legacy fallback: ip-based
  if (!remoteMs) remoteMs = await tryFetch('https://worldtimeapi.org/api/ip', j => j.unixtime ? j.unixtime*1000 : (j.datetime ? Date.parse(j.datetime) : null));
  if (remoteMs) {
    __trustedNowOffset = remoteMs - Date.now();
    __trustedNowFetched = true;
    try {
      sessionStorage.setItem('mamzouka_ntp_offset', String(__trustedNowOffset));
      sessionStorage.setItem('mamzouka_ntp_fetched', '1');
      localStorage.setItem('mamzouka_last_trusted_ms', String(remoteMs));
    } catch {}
    return remoteMs;
  }
  // Offline fallback: use cached offset
  return Date.now() + __trustedNowOffset;
}
function getTrustedNowMs() {
  const base = Date.now() + (__trustedNowFetched ? __trustedNowOffset : 0);
  try {
    const last = parseInt(localStorage.getItem('mamzouka_last_trusted_ms')||'0',10);
    if (last && base < last - 60000) {
      console.warn('[Mamzouka][Security] Clock rollback detected — treating as expired');
      return last;
    }
  } catch {}
  return base;
}
function parseExpiryMs(cfg) {
  const parts = (cfg.expiryDate || '2026-10-01').split('-');
  const y = parseInt(parts[0],10), m = parseInt(parts[1],10)-1, d = parseInt(parts[2]||'1',10);
  return new Date(y,m,d,23,59,59,999).getTime();
}

let devBypassClicks = 0;
let isDevBypassed = false;
const DEV_BYPASS_CODE = 'MAMZOUKA2026';

function isAppExpired() {
  const cfg = getEffectiveUpdateConfig();
  if (!cfg.enabled) return false;
  if (isDevBypassed) return false;
  if (cfg.forceLock) return true;
  // legacy alias
  if (cfg.forceUpdate) return true;
  const expMs = parseExpiryMs(cfg);
  const nowMs = getTrustedNowMs();
  // Offline grace 48h: never lock a user who simply has no internet and whose
  // clock reads within 48h after expiry (trusted time couldn't be verified).
  if (!__trustedNowFetched && (typeof navigator === 'undefined' || navigator.onLine === false)) {
    if (Date.now() < expMs + 48 * 60 * 60 * 1000) return false;
  }
  // Also consider early guard flag
  if (window.__MAMZ_EARLY_EXPIRED__ && __trustedNowFetched) return true;
  return nowMs >= expMs;
}

// --- UI Enforcement helpers ---
function enforceBlockerUI() {
  document.documentElement.classList.add('mamzouka-locked');
  document.body.classList.add('mamzouka-locked');
  // Blur and disable app
  const app = document.getElementById('app');
  if (app) {
    app.style.filter = 'blur(7px) brightness(0.45)';
    app.style.pointerEvents = 'none';
    app.style.userSelect = 'none';
  }
  const scroll = document.getElementById('content-scroll');
  if (scroll) scroll.style.overflow = 'hidden';
  // Close any open modals/players that would hide the blocker
  if (el.detailsModal) el.detailsModal.classList.remove('open');
  if (el.trailerModal) el.trailerModal.classList.remove('open');
  if (el.playerView) el.playerView.classList.remove('active');
  if (el.mainVideo && !el.mainVideo.paused) try { el.mainVideo.pause(); } catch {}
  // Ensure blocker is visible
  if (el.forceUpdateModal) {
    el.forceUpdateModal.style.display = 'flex';
    el.forceUpdateModal.style.opacity = '1';
    el.forceUpdateModal.style.pointerEvents = 'auto';
  }
}
function releaseBlockerUI() {
  if (isAppExpired()) return; // cannot release while expired
  document.documentElement.classList.remove('mamzouka-locked');
  document.body.classList.remove('mamzouka-locked');
  const app = document.getElementById('app');
  if (app) { app.style.filter=''; app.style.pointerEvents=''; app.style.userSelect=''; }
  const scroll = document.getElementById('content-scroll');
  if (scroll) scroll.style.overflow='';
}

function showForceUpdateModal(cfg, isTest = false) {
  if (!el.forceUpdateModal) return;
  const c = cfg || getEffectiveUpdateConfig();
  const L = getCurrentLang();
  const pickAr = L === 'ar';
  if (el.updateModalTitle) el.updateModalTitle.textContent = pickAr ? (c.titleAr || t('ui.updBadge', 'Update')) : (c.titleEn || t('ui.updBadge', 'Update'));
  if (el.updateModalDesc) el.updateModalDesc.textContent = pickAr ? (c.messageAr || c.messageEn || '') : (c.messageEn || c.messageAr || '');
  // Message box direction follows the message language
  try { el.updateModalDesc.parentElement.style.direction = pickAr ? 'rtl' : 'ltr'; el.updateModalDesc.parentElement.style.textAlign = pickAr ? 'right' : 'left'; } catch {}
  if (el.updateModalExpiry) el.updateModalExpiry.textContent = c.expiryDate || '2026-10-01';
  if (el.updateModalCurVer) el.updateModalCurVer.textContent = `v${c.currentVersion || '1.0.0'}`;
  if (el.updateBadgeVersion) el.updateBadgeVersion.textContent = `NEW v${c.newVersion || '2.0.0'}`;
  if (el.updateBtnText) el.updateBtnText.textContent = pickAr ? (c.buttonTextAr || t('ui.copyLink', 'Download')) : (c.buttonTextEn || t('ui.copyLink', 'Download'));
  if (el.mainVideo && !el.mainVideo.paused) try { el.mainVideo.pause(); } catch {}
  el.forceUpdateModal.style.display = 'flex';
  // If not a manual test and truly expired, enforce full blocker
  if (!isTest && isAppExpired()) enforceBlockerUI();
  else if (isTest) {
    // Test preview should auto-hide after 8s if not truly expired
    if (!isAppExpired()) setTimeout(() => { if (el.forceUpdateModal) el.forceUpdateModal.style.display='none'; }, 8000);
  }
}

function hideForceUpdateModal() {
  if (isAppExpired()) {
    // Cannot hide while expired — re-enforce
    enforceBlockerUI();
    return;
  }
  if (el.forceUpdateModal) el.forceUpdateModal.style.display = 'none';
  releaseBlockerUI();
}

async function checkAppExpirationAndUpdates(manualTest = false) {
  const cfg = getEffectiveUpdateConfig();

  // Populate Settings inputs (only if empty to avoid overwriting user typing)
  if (el.settingUpdateExpiry && !el.settingUpdateExpiry.value) el.settingUpdateExpiry.value = cfg.expiryDate || '';
  if (el.settingUpdateTelegram && !el.settingUpdateTelegram.value) el.settingUpdateTelegram.value = cfg.telegramUrl || '';

  // Try to refresh trusted time (non-blocking, but await for accurate check)
  try { await fetchTrustedNowMs(); } catch {}

  if (manualTest) {
    showForceUpdateModal(cfg, true);
    return;
  }

  if (!cfg.enabled) {
    hideForceUpdateModal();
    return;
  }
  if (isDevBypassed) {
    hideForceUpdateModal();
    return;
  }

  const expMs = parseExpiryMs(cfg);
  const nowMs = getTrustedNowMs();
  const isForceLocked = !!cfg.forceLock;
  const isExpired = isForceLocked || (nowMs >= expMs) || !!window.__MAMZ_EARLY_EXPIRED__;

  if (el.updateStatusBadge) {
    const L = getCurrentLang();
    const badgeLocked = L === 'ar' ? 'مقفلة إجبارياً ⚠️' : L === 'fr' ? 'Verrouillé ⚠️' : 'Force-locked ⚠️';
    const badgeExpired = L === 'ar' ? 'منتهية الصلاحية ⚠️' : L === 'fr' ? 'Expiré ⚠️' : 'Expired ⚠️';
    const badgeActive = (d) => L === 'ar' ? `صالحة • متبقي ${d} يوم` : L === 'fr' ? `Active • ${d} j restants` : `Active • ${d} days left`;
    if (isExpired) {
      el.updateStatusBadge.textContent = isForceLocked ? badgeLocked : badgeExpired;
      el.updateStatusBadge.style.background = 'rgba(239, 68, 68, 0.2)';
      el.updateStatusBadge.style.color = '#f87171';
      el.updateStatusBadge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    } else {
      const daysLeft = Math.max(0, Math.ceil((expMs - nowMs) / (1000*60*60*24)));
      el.updateStatusBadge.textContent = badgeActive(daysLeft);
      el.updateStatusBadge.style.background = 'rgba(34, 197, 94, 0.2)';
      el.updateStatusBadge.style.color = '#4ade80';
      el.updateStatusBadge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
    }
  }

  if (isExpired) {
    console.warn(`[Mamzouka] BLOCKED — forceLock=${isForceLocked} expiry=${cfg.expiryDate} now=${new Date(nowMs).toISOString()}`);
    showForceUpdateModal(cfg, false);
    enforceBlockerUI();
  } else {
    hideForceUpdateModal();
    releaseBlockerUI();
  }

  // Remote check — remote can ONLY make it MORE restrictive (forceLock true or earlier expiry)
  if (cfg.remoteCheckUrl) {
    try {
      const ctl = new AbortController();
      const tid = setTimeout(() => ctl.abort(), 3500);
      const resp = await fetch(cfg.remoteCheckUrl, { cache: 'no-store', signal: ctl.signal });
      clearTimeout(tid);
      if (resp.ok) {
        const remote = await resp.json();
        let remoteForce = !!remote.forceLock || !!remote.forceUpdate;
        let remoteExpMs = remote.expiryDate ? Date.parse(remote.expiryDate) : NaN;
        let shouldLock = false;
        if (remoteForce) shouldLock = true;
        if (!isNaN(remoteExpMs) && getTrustedNowMs() >= remoteExpMs) shouldLock = true;
        if (remote.enabled === false) {
          // remote cannot disable if file says enabled — ignore
        }
        if (shouldLock) {
          console.warn('[Mamzouka] Remote kill triggered');
          showForceUpdateModal({ ...cfg, ...remote }, false);
          enforceBlockerUI();
        } else if (remote.latestVersion && remote.latestVersion !== cfg.currentVersion) {
          // Non-blocking update notice — but if remote says forceUpdate, treat as lock
          if (remote.forceUpdate) { showForceUpdateModal({ ...cfg, ...remote }, false); enforceBlockerUI(); }
        }
      }
    } catch (err) {
      console.log('[Mamzouka] Remote check failed (offline?)', err);
    }
  }
}

function initUpdateAndExpirySystem() {
  // Remote cloud config (3s timeout) — merge over local, then trusted time, then check
  fetchAndApplyRemoteCloudConfig().finally(() => {
    fetchTrustedNowMs().finally(() => checkAppExpirationAndUpdates());
  });
  // Also re-fetch remote every 5 minutes
  setInterval(() => { fetchAndApplyRemoteCloudConfig(); }, 5 * 60 * 1000);
  // Periodic checks: every 60s + on visibility/focus
  setInterval(() => { checkAppExpirationAndUpdates(); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState==='visible') checkAppExpirationAndUpdates(); });
  window.addEventListener('focus', () => checkAppExpirationAndUpdates());
  window.addEventListener('online', () => { fetchAndApplyRemoteCloudConfig().then(()=> fetchTrustedNowMs().then(()=>checkAppExpirationAndUpdates())); });

  // Global click interceptor — block any interaction when expired (capture phase)
  document.addEventListener('click', (e) => {
    if (!isAppExpired()) return;
    const target = e.target;
    // Allow clicks inside the force modal itself
    if (target.closest && target.closest('#force-update-modal')) return;
    e.preventDefault();
    e.stopPropagation();
    showForceUpdateModal(getEffectiveUpdateConfig(), false);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!isAppExpired()) return;
    // Allow typing inside modal? block everything else, especially Esc that would close modal
    const insideModal = e.target.closest && e.target.closest('#force-update-modal');
    if (insideModal) return;
    if (e.key === 'Escape' || e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase()==='r')) {
      e.preventDefault();
      e.stopPropagation();
      showForceUpdateModal(getEffectiveUpdateConfig(), false);
    }
  }, true);

  // Wrap invoke to block backend calls when expired (except allowed)
  const _origInvoke = window.invoke || invoke;
  const blockedCmds = new Set(['get_trending','discover_media','search_media','get_media_details','get_season_episodes','get_torrent_streams','get_live_channels','play','get_subtitles','get_recommendations','get_watch_history','get_watchlist','open_in_vlc','start_download','get_live_channels','get_epg','transcode_video','check_ffmpeg','get_downloads']);
  async function guardedInvoke(cmd, args) {
    if (isAppExpired() && blockedCmds.has(cmd)) {
      showForceUpdateModal(getEffectiveUpdateConfig(), false);
      throw new Error('App is locked — update required');
    }
    return _origInvoke(cmd, args);
  }
  // Replace global invoke references
  try { window.invoke = guardedInvoke; } catch {}
  // Also patch local invoke variable if possible (closure) — we override the function name in this scope
  try { if (typeof invoke !== 'undefined') invoke = guardedInvoke; } catch {}

  // Button: Open Telegram link
  if (el.btnOpenTelegramUpdate) {
    el.btnOpenTelegramUpdate.addEventListener('click', async () => {
      const activeCfg = getEffectiveUpdateConfig();
      const targetUrl = activeCfg.telegramUrl || 'https://t.me/mamzouka_official';
      try {
        await (window.invoke || invoke)('open_external_url', { url: targetUrl });
      } catch (err) {
        console.warn('invoke open_external_url failed, falling back to window.open', err);
        window.open(targetUrl, '_blank');
      }
    });
  }

  // Button: Copy Telegram link
  if (el.btnCopyTelegramLink) {
    el.btnCopyTelegramLink.addEventListener('click', async () => {
      const activeCfg = getEffectiveUpdateConfig();
      const targetUrl = activeCfg.telegramUrl || 'https://t.me/mamzouka_official';
      try {
        await navigator.clipboard.writeText(targetUrl);
        if (el.updateToastCopy) {
          el.updateToastCopy.style.display = 'block';
          setTimeout(() => {
            if (el.updateToastCopy) el.updateToastCopy.style.display = 'none';
          }, 3000);
        }
      } catch (e) {
        prompt(t('ui.copyLink', '📋 Copy link') + ':', targetUrl);
      }
    });
  }

  // Button: Check update again
  if (el.btnCheckUpdateAgain) {
    el.btnCheckUpdateAgain.addEventListener('click', () => {
      el.btnCheckUpdateAgain.textContent = t('ui.checking', '⏳ Checking...');
      fetchTrustedNowMs().finally(() => {
        checkAppExpirationAndUpdates();
        if (el.btnCheckUpdateAgain) el.btnCheckUpdateAgain.textContent = t('ui.recheck', '🔄 Recheck');
      });
    });
  }

  // Secure Developer Bypass — 7 clicks + code, and NEVER works when forceLock is true
  if (el.updateDevBypass) {
    el.updateDevBypass.addEventListener('click', () => {
      devBypassClicks += 1;
      if (devBypassClicks >= 7) {
        const cfg = getEffectiveUpdateConfig();
        if (cfg.forceLock) {
          alert(t('dlg.bypassBlocked', '⛔ Bypass blocked — forceLock is active'));
          devBypassClicks = 0;
          return;
        }
        const code = prompt(t('dlg.bypassCode', '🔑 Enter developer bypass code:'));
        if (code === DEV_BYPASS_CODE) {
          isDevBypassed = true;
          releaseBlockerUI();
          hideForceUpdateModal();
          // also clear early flag for this session
          window.__MAMZ_EARLY_EXPIRED__ = false;
          alert(t('dlg.bypassOk', '✅ Developer Mode: bypassed for this session only.'));
        } else {
          alert(t('dlg.wrongCode', '❌ Wrong code'));
        }
        devBypassClicks = 0;
      }
    });
  }

  // Settings: Save Update Config — TAMPER CHECK: cannot extend expiry or disable forceLock
  if (el.btnSaveUpdateConfig) {
    el.btnSaveUpdateConfig.addEventListener('click', () => {
      const fileCfg = window.MAMZOUKA_UPDATE_CONFIG || {};
      const currentCfg = getEffectiveUpdateConfig();
      const newExpiry = (el.settingUpdateExpiry && el.settingUpdateExpiry.value) ? el.settingUpdateExpiry.value : currentCfg.expiryDate;
      const newTelegram = (el.settingUpdateTelegram && el.settingUpdateTelegram.value.trim()) ? el.settingUpdateTelegram.value.trim() : currentCfg.telegramUrl;

      // Security: block extension
      const fileMs = Date.parse(fileCfg.expiryDate || '2026-10-01');
      const newMs = Date.parse(newExpiry);
      if (!isNaN(fileMs) && !isNaN(newMs) && newMs > fileMs) {
        alert(t('dlg.expiryBlocked', '⛔ Cannot extend expiry via Settings.'));
        if (el.settingUpdateExpiry) el.settingUpdateExpiry.value = fileCfg.expiryDate;
        return;
      }
      if (fileCfg.forceLock && !isDevBypassed) {
        alert(t('dlg.forceLockOn', '⚠️ Force-lock is ON'));
        return;
      }

      const updated = {
        ...currentCfg,
        expiryDate: newExpiry,
        telegramUrl: newTelegram,
      };

      localStorage.setItem('mamzouka_update_config', JSON.stringify(updated));
      alert(t('dlg.expirySaved', '✅ Expiry settings saved!'));
      fetchTrustedNowMs().then(()=>checkAppExpirationAndUpdates());
    });
  }

  // Settings: Test Force Update Modal
  if (el.btnTestForceUpdate) {
    el.btnTestForceUpdate.addEventListener('click', () => {
      checkAppExpirationAndUpdates(true);
    });
  }

  // Settings: Reset Update Config
  if (el.btnResetUpdateConfig) {
    el.btnResetUpdateConfig.addEventListener('click', () => {
      localStorage.removeItem('mamzouka_update_config');
      const def = window.MAMZOUKA_UPDATE_CONFIG || {};
      if (el.settingUpdateExpiry) el.settingUpdateExpiry.value = def.expiryDate || '2026-10-01';
      if (el.settingUpdateTelegram) el.settingUpdateTelegram.value = def.telegramUrl || 'https://t.me/mamzouka_official';
      alert(t('dlg.updateDefaults', '🔄 Settings restored to defaults'));
      fetchTrustedNowMs().then(()=>checkAppExpirationAndUpdates());
    });
  }

  // Guard navigation/history/playback entry points — foolproof
  const wrapList = ['loadDiscoverContent','loadMoviesContent','loadTvShowsContent','loadAnimeContent','loadLiveTvContent','loadRadioContent','loadYoutubeContent','loadTwitchContent','openDetailsModal','startPlayback','playLiveChannel','playRadioStation','playYoutubeItem','playTwitchStream','playOfflineVideo','startDownloadForStream'];
  wrapList.forEach(name => {
    if (typeof window[name] === 'function') {
      const orig = window[name];
      window[name] = function(...args) {
        if (isAppExpired()) { showForceUpdateModal(getEffectiveUpdateConfig(), false); enforceBlockerUI(); return; }
        return orig.apply(this, args);
      };
    }
  });
}

// ==========================================================================
// Smart Ads & Monetization System (نظام الإعلانات الذكية وتحديد الدول والتردد)
// ==========================================================================
const DEFAULT_PREROLL_VIDEO = 'https://vjs.zencdn.net/v/oceans.mp4';
const FALLBACK_PREROLL_VIDEOS = [
  'https://vjs.zencdn.net/v/oceans.mp4',
  'https://www.w3schools.com/html/mov_bbb.mp4',
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
];

function getEffectiveAdsConfig() {
  const fileConfig = window.MAMZOUKA_ADS_CONFIG || {};
  let storageConfig = {};
  try {
    const override = localStorage.getItem('mamzouka_ads_config');
    if (override) {
      storageConfig = JSON.parse(override);
    }
  } catch (e) {}

  const defaults = {
    enabled: true,
    preroll: {
      enabled: true,
      skipDelaySeconds: 5,
      videoUrl: DEFAULT_PREROLL_VIDEO,
      targetUrl: 'https://t.me/mamzouka_official',
      sponsorTitle: 'إعلان راعي البرنامج الرسمي',
    },
    popunder: {
      enabled: true,
      frequencyHours: 24,
      url: 'https://t.me/mamzouka_official',
    },
    excludedCountries: [],
    geoCheckEnabled: true,
  };

  let merged = {
    ...defaults,
    ...storageConfig,
    ...fileConfig,
    preroll: {
      ...defaults.preroll,
      ...(storageConfig.preroll || {}),
      ...(fileConfig.preroll || {}),
    },
    popunder: {
      ...defaults.popunder,
      ...(storageConfig.popunder || {}),
      ...(fileConfig.popunder || {}),
    },
  };

  // Remote cloud overrides — remote wins
  if (remoteAdsOverrides) {
    if (remoteAdsOverrides.preroll) merged.preroll = { ...merged.preroll, ...remoteAdsOverrides.preroll };
    if (remoteAdsOverrides.popunder) merged.popunder = { ...merged.popunder, ...remoteAdsOverrides.popunder };
    if (remoteAdsOverrides.excludedCountries) merged.excludedCountries = remoteAdsOverrides.excludedCountries;
    if (remoteAdsOverrides.geoCheckEnabled !== undefined) merged.geoCheckEnabled = remoteAdsOverrides.geoCheckEnabled;
    if (remoteAdsOverrides.enabled !== undefined) merged.enabled = remoteAdsOverrides.enabled;
  }

  // Auto-heal broken 403 Google sample video URL if present anywhere in old caches
  if (merged.preroll.videoUrl && merged.preroll.videoUrl.includes('ForBiggerBlazes')) {
    merged.preroll.videoUrl = DEFAULT_PREROLL_VIDEO;
  }

  return merged;
}

let userCountryCode = null;

async function detectUserCountry() {
  if (userCountryCode) return userCountryCode;
  try {
    const cached = sessionStorage.getItem('mamzouka_user_country');
    if (cached) {
      userCountryCode = cached;
      return userCountryCode;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const res = await fetch('https://api.country.is/', {
      cache: 'force-cache',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data && data.country) {
        userCountryCode = data.country.toUpperCase();
        sessionStorage.setItem('mamzouka_user_country', userCountryCode);
        return userCountryCode;
      }
    }
  } catch (e) {
    try {
      const controller2 = new AbortController();
      const timeoutId2 = setTimeout(() => controller2.abort(), 2000);
      const res2 = await fetch('https://ipapi.co/country/', {
        cache: 'force-cache',
        signal: controller2.signal,
      });
      clearTimeout(timeoutId2);
      if (res2.ok) {
        const c = (await res2.text()).trim().toUpperCase();
        if (c && c.length === 2) {
          userCountryCode = c;
          sessionStorage.setItem('mamzouka_user_country', userCountryCode);
          return userCountryCode;
        }
      }
    } catch (e2) {}
  }
  return null;
}

async function isAdsAllowedForUser() {
  const cfg = getEffectiveAdsConfig();
  if (!cfg.enabled) return false;

  const excluded = (cfg.excludedCountries || [])
    .map((c) => (typeof c === 'string' ? c.trim().toUpperCase() : ''))
    .filter(Boolean);

  if (excluded.length === 0 || !cfg.geoCheckEnabled) return true;

  const country = await detectUserCountry();
  if (country && excluded.includes(country)) {
    console.log(`[Mamzouka Ads] User country (${country}) is in excluded list [${excluded.join(', ')}]. Ads blocked.`);
    return false;
  }
  return true;
}

// Pop-under / Smartlink: fires at most once every 24 hours per visitor (never in first 30s)
async function tryTriggerPopunder(bypassCap = false) {
  try {
    if (!bypassCap && isAdsGracePeriod()) return; // calm start: no popunder right after launch
    const cfg = getEffectiveAdsConfig();
    if (!cfg.enabled || !cfg.popunder || !cfg.popunder.enabled || !cfg.popunder.url) return;

    if (!bypassCap) {
      const allowed = await isAdsAllowedForUser();
      if (!allowed) return;

      const freqHours = cfg.popunder.frequencyHours || 24;
      const minIntervalMs = freqHours * 60 * 60 * 1000;
      const lastPopTime = parseInt(localStorage.getItem('mamzouka_last_popunder') || '0', 10);
      const now = Date.now();

      if (now - lastPopTime < minIntervalMs) {
        return; // Within frequency limit
      }
      localStorage.setItem('mamzouka_last_popunder', now.toString());
    }

    console.log(`[Mamzouka Ads] Triggering pop-under URL: ${cfg.popunder.url}`);
    try {
      await invoke('open_external_url', { url: cfg.popunder.url });
    } catch (err) {
      window.open(cfg.popunder.url, '_blank');
    }
  } catch (err) {
    console.warn('[Mamzouka Ads] Popunder error:', err);
  }
}

// Pre-Roll Video Ad (5-second countdown with Skip Ad button; skipped in first 30s of session)
function handlePreRollAd(isDirectTest = false) {
  return new Promise(async (resolve) => {
    if (!isDirectTest && isAdsGracePeriod()) return resolve(true); // calm start
    const cfg = getEffectiveAdsConfig();
    if (!cfg.enabled || !cfg.preroll || !cfg.preroll.enabled || !cfg.preroll.videoUrl || !el.prerollAdOverlay || !el.prerollVideo) {
      return resolve(true);
    }

    if (!isDirectTest) {
      const allowed = await isAdsAllowedForUser();
      if (!allowed) {
        return resolve(true);
      }
    }

    const overlay = el.prerollAdOverlay;
    const video = el.prerollVideo;
    const skipBtn = el.btnPrerollSkip;
    const skipText = el.prerollSkipText;
    const titleElem = el.prerollAdTitle;
    const visitBtn = el.btnPrerollVisit;
    const soundBtn = el.btnPrerollSound;
    const soundText = el.prerollSoundText;

    if (isDirectTest && el.playerView) {
      el.playerView.classList.add('active');
    }

    if (titleElem) titleElem.textContent = cfg.preroll.sponsorTitle || t('ui.sponsorDefault', 'Official program sponsor');

    // Show overlay
    overlay.style.display = 'flex';

    // Start muted for guaranteed 100% WebView2 autoplay compliance
    video.muted = true;
    if (soundText) soundText.textContent = t('ads.soundOn', '🔊 Enable sound');

    let currentUrlIndex = 0;
    const testUrls = [cfg.preroll.videoUrl, ...FALLBACK_PREROLL_VIDEOS.filter((u) => u !== cfg.preroll.videoUrl)];

    const loadVideoSrc = (url) => {
      video.src = url;
      video.currentTime = 0;
      video.load();
      video.play().catch((err) => {
        console.warn('[Mamzouka Ads] Play warning, ensuring muted:', err);
        video.muted = true;
        video.play().catch((err2) => {
          console.warn('[Mamzouka Ads] Second play error:', err2);
        });
      });
    };

    loadVideoSrc(testUrls[0]);

    if (soundBtn) {
      soundBtn.onclick = (e) => {
        e.stopPropagation();
        video.muted = !video.muted;
        if (soundText) {
          soundText.textContent = video.muted ? t('ads.soundOn', '🔊 Enable sound') : t('ads.soundOff', '🔇 Mute');
        }
      };
    }

    let remaining = cfg.preroll.skipDelaySeconds || 5;
    if (skipBtn) {
      skipBtn.disabled = true;
      skipBtn.style.cursor = 'not-allowed';
      skipBtn.style.background = 'rgba(15, 23, 42, 0.92)';
      skipBtn.style.borderColor = 'rgba(255,255,255,0.25)';
      skipBtn.style.color = '#94a3b8';
      skipBtn.style.boxShadow = 'none';
    }
    if (skipText) skipText.textContent = t('ads.skipIn', 'Skip ad in {n}s').replace('{n}', remaining);

    let countdownInterval = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        if (skipText) skipText.textContent = t('ads.skipIn', 'Skip ad in {n}s').replace('{n}', remaining);
      } else {
        clearInterval(countdownInterval);
        countdownInterval = null;
        if (skipBtn) {
          skipBtn.disabled = false;
          skipBtn.style.cursor = 'pointer';
          skipBtn.style.background = 'linear-gradient(135deg, #e11d48, #be123c)';
          skipBtn.style.borderColor = '#fb7185';
          skipBtn.style.color = '#ffffff';
          skipBtn.style.boxShadow = '0 4px 18px rgba(225, 29, 72, 0.5)';
        }
        if (skipText) skipText.textContent = t('ads.skipNow', 'Skip Ad ⏭');
      }
    }, 1000);

    let finished = false;
    const finishAd = () => {
      if (finished) return;
      finished = true;
      if (countdownInterval) clearInterval(countdownInterval);
      try { video.pause(); } catch (e) {}
      video.removeAttribute('src');
      overlay.style.display = 'none';
      if (isDirectTest && el.playerView && !state.activeStream) {
        el.playerView.classList.remove('active');
      }
      resolve(true);
    };

    if (skipBtn) {
      skipBtn.onclick = (e) => {
        e.stopPropagation();
        finishAd();
      };
    }

    video.onended = () => finishAd();

    video.onerror = () => {
      console.warn(`[Mamzouka Ads] Preroll video error on URL #${currentUrlIndex}`);
      currentUrlIndex += 1;
      if (currentUrlIndex < testUrls.length) {
        loadVideoSrc(testUrls[currentUrlIndex]);
      } else {
        console.warn('[Mamzouka Ads] All preroll URLs failed, proceeding to video');
        finishAd();
      }
    };

    if (visitBtn) {
      visitBtn.onclick = async (e) => {
        e.stopPropagation();
        const target = cfg.preroll.targetUrl || 'https://t.me/mamzouka_official';
        try {
          await invoke('open_external_url', { url: target });
        } catch (e) {
          window.open(target, '_blank');
        }
      };
    }
  });
}

// Initialize Ads Settings UI & Event Listeners
function initAdsSystem() {
  const cfg = getEffectiveAdsConfig();

  if (el.settingAdsMasterEnabled) {
    el.settingAdsMasterEnabled.checked = !!cfg.enabled;
  }
  if (el.settingAdsVideoUrl) {
    el.settingAdsVideoUrl.value = cfg.preroll?.videoUrl || DEFAULT_PREROLL_VIDEO;
  }
  if (el.settingAdsSkipDelay) {
    el.settingAdsSkipDelay.value = cfg.preroll?.skipDelaySeconds || 5;
  }
  if (el.settingAdsPopunderUrl) {
    el.settingAdsPopunderUrl.value = cfg.popunder?.url || 'https://t.me/mamzouka_official';
  }
  if (el.settingAdsExcludedCountries) {
    el.settingAdsExcludedCountries.value = (cfg.excludedCountries || []).join(', ');
  }

  if (el.adsStatusBadge) {
    const L = getCurrentLang();
    const onTxt = L === 'ar' ? 'الإعلانات شغالة' : L === 'fr' ? 'Pubs actives' : 'Ads Active';
    const offTxt = L === 'ar' ? 'معطلة' : L === 'fr' ? 'Désactivées' : 'Disabled';
    if (cfg.enabled) {
      el.adsStatusBadge.textContent = onTxt;
      el.adsStatusBadge.style.background = 'rgba(34, 197, 94, 0.2)';
      el.adsStatusBadge.style.color = '#4ade80';
      el.adsStatusBadge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
    } else {
      el.adsStatusBadge.textContent = offTxt;
      el.adsStatusBadge.style.background = 'rgba(239, 68, 68, 0.2)';
      el.adsStatusBadge.style.color = '#f87171';
      el.adsStatusBadge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    }
  }

  if (el.btnSaveAdsConfig && !el.btnSaveAdsConfig.dataset.bound) {
    el.btnSaveAdsConfig.dataset.bound = 'true';
    el.btnSaveAdsConfig.addEventListener('click', () => {
      const isMaster = el.settingAdsMasterEnabled ? el.settingAdsMasterEnabled.checked : true;
      const vUrl = (el.settingAdsVideoUrl && el.settingAdsVideoUrl.value.trim()) || DEFAULT_PREROLL_VIDEO;
      const sDelay = (el.settingAdsSkipDelay && parseInt(el.settingAdsSkipDelay.value, 10)) || 5;
      const pUrl = (el.settingAdsPopunderUrl && el.settingAdsPopunderUrl.value.trim()) || 'https://t.me/mamzouka_official';
      const rawCountries = el.settingAdsExcludedCountries ? el.settingAdsExcludedCountries.value : '';
      const countries = rawCountries.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

      const updated = {
        ...cfg,
        enabled: isMaster,
        preroll: {
          ...cfg.preroll,
          videoUrl: vUrl,
          skipDelaySeconds: sDelay,
        },
        popunder: {
          ...cfg.popunder,
          url: pUrl,
        },
        excludedCountries: countries,
        geoCheckEnabled: countries.length > 0,
      };

      localStorage.setItem('mamzouka_ads_config', JSON.stringify(updated));
      alert(t('dlg.expirySaved', '✅ Saved!'));
      initAdsSystem();
    });
  }

  if (el.btnTestPrerollAd && !el.btnTestPrerollAd.dataset.bound) {
    el.btnTestPrerollAd.dataset.bound = 'true';
    el.btnTestPrerollAd.addEventListener('click', () => {
      handlePreRollAd(true);
    });
  }

  if (el.btnTestPopunderLink && !el.btnTestPopunderLink.dataset.bound) {
    el.btnTestPopunderLink.dataset.bound = 'true';
    el.btnTestPopunderLink.addEventListener('click', () => {
      tryTriggerPopunder(true);
      alert(t('dlg.adsPopOk', '✅ Pop-under fired!'));
    });
  }

  if (el.btnResetPopunderTimer && !el.btnResetPopunderTimer.dataset.bound) {
    el.btnResetPopunderTimer.dataset.bound = 'true';
    el.btnResetPopunderTimer.addEventListener('click', () => {
      localStorage.removeItem('mamzouka_last_popunder');
      alert(t('dlg.resetPop', '🔄 24h timer reset'));
    });
  }

  if (el.btnResetAdsConfig && !el.btnResetAdsConfig.dataset.bound) {
    el.btnResetAdsConfig.dataset.bound = 'true';
    el.btnResetAdsConfig.addEventListener('click', () => {
      localStorage.removeItem('mamzouka_ads_config');
      alert(t('dlg.adsDefaults', '🔄 Ads restored to defaults'));
      initAdsSystem();
    });
  }

  if (!window._mamzoukaPopunderListenerBound) {
    window._mamzoukaPopunderListenerBound = true;
    document.addEventListener('click', (e) => {
      if (e.target && e.target.closest('#preroll-ad-overlay')) return;
      tryTriggerPopunder();
    }, { passive: true });
  }
}

async function loadServerPort() {
  try {
    const port = await invoke('get_server_port');
    if (port) {
      state.serverPort = port;
      if (el.serverStatusText) {
        el.serverStatusText.textContent = `Rust Engine: Port ${port}`;
      }
    }
  } catch (e) {
    console.warn('Server port info:', e);
  }
}

// ==========================================================================
// Content Loaders (Discover, Movies, TV Shows, Anime)
// ==========================================================================
async function loadDiscoverContent() {
  if (el.trendingGrid) {
    el.trendingGrid.innerHTML = '<div class="spinner"></div>';
  }
  
  // 1. Trending Items (Preview Top 5)
  invoke('get_trending', { mediaType: 'all', timeWindow: 'day', language: getTmdbLanguage() })
    .then((trending) => {
      if (trending && trending.length > 0) {
        renderHero(trending[0]);
        if (el.trendingGrid) renderGrid(el.trendingGrid, trending.slice(0, 5));
      } else if (el.trendingGrid) {
        el.trendingGrid.innerHTML = '<div style="color: var(--text-muted); padding: 20px;">' + escapeHtml(t('ui.noTrending', 'No trending items available.')) + '</div>';
      }
    })
    .catch((err) => {
      console.warn('Trending error:', err);
      logError('trending', err);
      if (el.trendingGrid) {
        el.trendingGrid.innerHTML = `<div style="color: #ef4444; padding: 20px;">${escapeHtml(t('errors.NETWORK', 'Catalog error'))}: ${escapeHtml(String(err).slice(0,120))}<br><button id="btn-retry-discover" class="btn-secondary" style="margin-top:10px;">↻ ${escapeHtml(t('player.retry', 'Retry'))}</button></div>`;
        const rb = document.getElementById('btn-retry-discover');
        if (rb) rb.addEventListener('click', () => { try { tmdbCache.clear(); } catch {} loadDiscoverContent(); });
      }
    });

  // 2. Popular Movies (Preview Top 5)
  invoke('discover_media', { tmdb_language: getTmdbLanguage(), mediaType: 'movie',
    page: 1,
    genreId: null,
    sortBy: 'popularity.desc',
  }).then((popMovies) => {
    if (popMovies && popMovies.results && el.popularMoviesGrid) {
      renderGrid(el.popularMoviesGrid, popMovies.results.slice(0, 5));
    }
  }).catch((e) => console.warn('Pop movies error:', e));

  // 3. Popular TV (Preview Top 5)
  invoke('discover_media', { tmdb_language: getTmdbLanguage(), mediaType: 'tv',
    page: 1,
    genreId: null,
    sortBy: 'popularity.desc',
  }).then((popTv) => {
    if (popTv && popTv.results && el.popularTvGrid) {
      renderGrid(el.popularTvGrid, popTv.results.slice(0, 5));
    }
  }).catch((e) => console.warn('Pop TV error:', e));

  // 4. Anime (Preview Top 5)
  invoke('discover_media', { tmdb_language: getTmdbLanguage(), mediaType: 'anime',
    page: 1,
    genreId: null,
    sortBy: 'popularity.desc',
    year: null,
    minRating: null,
    country: null,
    language: null,
  }).then((popAnime) => {
    if (popAnime && popAnime.results && el.homeAnimeGrid) {
      renderGrid(el.homeAnimeGrid, popAnime.results.slice(0, 5));
    }
  }).catch((e) => console.warn('Pop Anime error:', e));

  // 5. Arabic Cinema & Series (Preview Top 5)
  invoke('discover_media', { tmdb_language: getTmdbLanguage(), mediaType: 'movie',
    page: 1,
    genreId: null,
    sortBy: 'popularity.desc',
    year: null,
    minRating: null,
    country: 'ar',
    language: null,
  }).then((arabContent) => {
    if (arabContent && arabContent.results && el.homeArabicGrid) {
      renderGrid(el.homeArabicGrid, arabContent.results.slice(0, 5));
    }
  }).catch((e) => console.warn('Arab content error:', e));

  // 6. Live Channels (Preview Top 6)
  invoke('get_live_channels', {
    country: 'all',
    category: null,
    query: null,
  }).then((channels) => {
    if (channels && el.homeLiveTvGrid) {
      renderLiveTvPreviewGrid(el.homeLiveTvGrid, channels.slice(0, 6));
    }
  }).catch((e) => console.warn('Live TV preview error:', e));
}

async function loadContinueWatching() {
  if (!el.continueWatchingGrid || !el.continueWatchingHeader) return;
  try {
    const history = await invoke('get_watch_history');
    if (!history || history.length === 0) {
      el.continueWatchingGrid.style.display = 'none';
      el.continueWatchingHeader.style.display = 'none';
      return;
    }
    // Filter 5-90% progress
    const filtered = history.filter(h => {
      const pct = h.duration_sec > 0 ? (h.current_time_sec / h.duration_sec) * 100 : 0;
      return pct > 5 && pct < 90;
    }).slice(0, 10);
    if (filtered.length === 0) {
      el.continueWatchingGrid.style.display = 'none';
      el.continueWatchingHeader.style.display = 'none';
      return;
    }
    el.continueWatchingGrid.style.display = 'grid';
    el.continueWatchingHeader.style.display = 'flex';
    el.continueWatchingGrid.innerHTML = filtered.map(item => {
      const pct = item.duration_sec > 0 ? Math.round((item.current_time_sec / item.duration_sec)*100) : 0;
      const poster = item.poster_url || 'https://via.placeholder.com/300x450/1e293b/ffffff?text=No+Poster';
      const epLabel = item.season ? `S${item.season}E${item.episode}` : '';
      return `
        <div class="media-card" data-history-id="${item.media_id}" data-history-type="${item.media_type}" data-season="${item.season||''}" data-episode="${item.episode||''}" data-time="${item.current_time_sec}" data-duration="${item.duration_sec||0}">
          <div class="media-poster-wrap">
            <img class="media-poster" src="${poster}" alt="${item.title}" loading="lazy" decoding="async"/>
            <div class="media-type-tag">${item.media_type.toUpperCase()} ${epLabel}</div>
            <div style="position:absolute;bottom:0;left:0;right:0;height:4px;background:rgba(255,255,255,0.2)"><div style="width:${pct}%;height:100%;background:var(--accent-primary)"></div></div>
            <div style="position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,0.75);padding:2px 6px;border-radius:4px;font-size:0.72rem;font-weight:700;">${pct}% • ${formatTime(item.current_time_sec)}/${formatTime(item.duration_sec)}</div>
          </div>
          <div class="media-card-info">
            <div class="media-card-title" title="${item.title}">${item.title}</div>
            <div class="media-card-meta"><span>${escapeHtml(t('ui.resumeCard', 'Resume'))}</span><span>▶</span></div>
          </div>
        </div>`;
    }).join('');
    el.continueWatchingGrid.querySelectorAll('.media-card').forEach(card => {
      card.addEventListener('click', async () => {
        const id = parseInt(card.dataset.historyId);
        const type = card.dataset.historyType;
        const t = parseFloat(card.dataset.time) || 0;
        const dur = parseFloat(card.dataset.duration) || 0;
        const title = card.querySelector('.media-card-title')?.textContent || 'Title';
        showResumeModal({ title, id }, t, dur || 3600, async () => {
          sessionStorage.setItem('mamzouka_pending_resume', String(t));
          await openDetailsModal(id, type);
          if (el.mainVideo) el.mainVideo.dataset.resumeTime = String(t);
        }, async () => {
          sessionStorage.removeItem('mamzouka_pending_resume');
          await openDetailsModal(id, type);
        });
      });
    });
    if (el.btnClearHistory) {
      el.btnClearHistory.onclick = async () => {
        el.continueWatchingGrid.style.display = 'none';
        el.continueWatchingHeader.style.display = 'none';
      };
    }
    // Load recommendations for last watched
    if (filtered.length>0) loadRecommendations(filtered[0]);
  } catch(e) { console.warn('Continue watching error', e); }
}

async function loadRecommendations(base){
  if(!el.recsGrid || !el.recsHeader) return;
  try{
    const recs = await invoke('get_recommendations', { mediaType: base.media_type, id: base.media_id, language: getTmdbLanguage() });
    if(!recs || recs.length===0){ el.recsGrid.style.display='none'; el.recsHeader.style.display='none'; return; }
    el.recsHeader.style.display='flex';
    el.recsGrid.style.display='grid';
    if(el.recsSubtitle) el.recsSubtitle.textContent = t('ui.basedOn', '— based on "{t}"').replace('{t}', base.title);
    renderGrid(el.recsGrid, recs.slice(0,8));
  }catch(e){ console.warn('Recs error', e); }
}

function renderLiveTvPreviewGrid(container, channels) {
  if (!container) return;
  if (!channels || channels.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); padding: 20px;">No channels preview available.</div>';
    return;
  }

  container.innerHTML = channels.map((ch, idx) => {
    const fallbackLogo = `https://ui-avatars.com/api/?name=${encodeURIComponent(ch.name)}&background=1e293b&color=ffffff&bold=true`;
    const logoSrc = ch.logo || fallbackLogo;
    const epgNow = ch.epg_now ? `<div style="font-size:0.7rem; color:#22c55e; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">NOW: ${ch.epg_now}</div>` : '';

    return `
      <div class="livetv-card" data-home-live-idx="${idx}">
        <div class="livetv-header">
          <div class="livetv-logo-box">
            <img class="livetv-logo-img" src="${logoSrc}" alt="${ch.name}" onerror="this.src='${fallbackLogo}'" />
          </div>
          <div class="livetv-info">
            <div class="livetv-name">${ch.country_flag} ${ch.name}</div>
            <div class="livetv-meta">
              <span class="livetv-tag">${ch.category}</span>
              <span>•</span>
              <span class="livetv-tag" style="color: var(--accent-cyan); font-weight: 700;">${ch.resolution || 'HD'}</span>
            </div>
            ${epgNow}
          </div>
        </div>
        <div class="livetv-actions">
          <button class="btn-play-stream btn-home-live-play" data-home-live-play="${idx}" style="flex: 1;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>Watch Live</span>
          </button>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.btn-home-live-play').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.homeLivePlay);
      const ch = channels[idx];
      if (ch) playLiveChannel(ch);
    });
  });

  container.querySelectorAll('.livetv-card').forEach((card) => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.homeLiveIdx);
      const ch = channels[idx];
      if (ch) playLiveChannel(ch);
    });
  });
}

async function loadMoviesContent(append = false) {
  if (!el.moviesGrid) return;
  if (!append) {
    state.moviePage = 1;
    el.moviesGrid.innerHTML = '<div class="spinner"></div>';
  }

  if (el.btnLoadMoreMovies) {
    el.btnLoadMoreMovies.style.display = 'inline-flex';
    const span = el.btnLoadMoreMovies.querySelector('span');
    if (span) span.textContent = t('ui.loadingMore', 'Loading more...');
  }

  try {
    const resp = await invoke('discover_media', { tmdb_language: getTmdbLanguage(), mediaType: 'movie',
      page: state.moviePage,
      genreId: state.activeMovieGenre ? parseInt(state.activeMovieGenre) : null,
      sortBy: state.movieSort || 'popularity.desc',
      year: state.movieYear ? parseInt(state.movieYear) : null,
      minRating: state.movieRating ? parseFloat(state.movieRating) : null,
      country: state.movieCountry || null,
      language: null,
    });

    if (resp && resp.results) {
      renderGrid(el.moviesGrid, resp.results, append);
      if (el.btnLoadMoreMovies) {
        const span = el.btnLoadMoreMovies.querySelector('span');
        if (resp.page >= resp.total_pages || resp.results.length === 0) {
          el.btnLoadMoreMovies.style.display = 'none';
        } else {
          el.btnLoadMoreMovies.style.display = 'inline-flex';
          if (span) span.textContent = t('ui.loadMoreMovies', 'Load More Movies');
        }
      }
    }
  } catch (e) {
    if (!append) {
      el.moviesGrid.innerHTML = `<div style="color: #ef4444; padding: 20px;">${t('ui.fetchStreamsFail', 'Failed to load: ')}${e}</div>`;
    }
  }
}

async function loadTvShowsContent(append = false) {
  if (!el.tvShowsGrid) return;
  if (!append) {
    state.tvPage = 1;
    el.tvShowsGrid.innerHTML = '<div class="spinner"></div>';
  }

  if (el.btnLoadMoreTv) {
    el.btnLoadMoreTv.style.display = 'inline-flex';
    const span = el.btnLoadMoreTv.querySelector('span');
    if (span) span.textContent = t('ui.loadingMore', 'Loading more...');
  }

  try {
    const resp = await invoke('discover_media', { tmdb_language: getTmdbLanguage(), mediaType: 'tv',
      page: state.tvPage,
      genreId: state.activeTvGenre ? parseInt(state.activeTvGenre) : null,
      sortBy: state.tvSort || 'popularity.desc',
      year: state.tvYear ? parseInt(state.tvYear) : null,
      minRating: state.tvRating ? parseFloat(state.tvRating) : null,
      country: state.tvCountry || null,
      language: null,
    });

    if (resp && resp.results) {
      renderGrid(el.tvShowsGrid, resp.results, append);
      if (el.btnLoadMoreTv) {
        const span = el.btnLoadMoreTv.querySelector('span');
        if (resp.page >= resp.total_pages || resp.results.length === 0) {
          el.btnLoadMoreTv.style.display = 'none';
        } else {
          el.btnLoadMoreTv.style.display = 'inline-flex';
          if (span) span.textContent = t('ui.loadMoreSeries', 'Load More Series');
        }
      }
    }
  } catch (e) {
    if (!append) {
      el.tvShowsGrid.innerHTML = `<div style="color: #ef4444; padding: 20px;">${t('ui.fetchStreamsFail', 'Failed to load: ')}${e}</div>`;
    }
  }
}

async function loadAnimeContent(append = false) {
  if (!el.animeGrid) return;
  if (!append) {
    state.animePage = 1;
    el.animeGrid.innerHTML = '<div class="spinner"></div>';
  }

  if (el.btnLoadMoreAnime) {
    el.btnLoadMoreAnime.style.display = 'inline-flex';
    const span = el.btnLoadMoreAnime.querySelector('span');
    if (span) span.textContent = t('ui.loadingMore', 'Loading more...');
  }

  try {
    const resp = await invoke('discover_media', { tmdb_language: getTmdbLanguage(), mediaType: 'anime',
      page: state.animePage,
      genreId: state.activeAnimeGenre ? parseInt(state.activeAnimeGenre) : null,
      sortBy: 'popularity.desc',
      year: null,
      minRating: null,
    });

    if (resp && resp.results) {
      renderGrid(el.animeGrid, resp.results, append);
      if (el.btnLoadMoreAnime) {
        const span = el.btnLoadMoreAnime.querySelector('span');
        if (resp.page >= resp.total_pages || resp.results.length === 0) {
          el.btnLoadMoreAnime.style.display = 'none';
        } else {
          el.btnLoadMoreAnime.style.display = 'inline-flex';
          if (span) span.textContent = t('ui.loadMoreAnime', 'Load More Anime');
        }
      }
    }
  } catch (e) {
    if (!append) {
      el.animeGrid.innerHTML = `<div style="color: #ef4444; padding: 20px;">${t('ui.fetchStreamsFail', 'Failed to load: ')}${e}</div>`;
    }
  }
}

// ==========================================================================
// Live TV & World Channels Controller
// ==========================================================================
let activeHls = null;

async function loadLiveTvContent() {
  if (!el.livetvGrid) return;
  el.livetvGrid.innerHTML = '<div class="spinner"></div>';
  _liveTvVisible = 60; // reset pagination on every new filter/search

  try {
    const channels = await invoke('get_live_channels', {
      country: state.activeLiveTvCountry === 'all' ? null : state.activeLiveTvCountry,
      category: state.activeLiveTvCat === 'all' ? null : state.activeLiveTvCat,
      query: state.activeLiveTvSearch ? state.activeLiveTvSearch : null,
    });

    renderLiveTvGrid(channels);
  } catch (err) {
    if (el.livetvGrid) {
      el.livetvGrid.innerHTML = `<div style="color: #ef4444; padding: 20px; grid-column: 1 / -1; text-align: center;">${escapeHtml(t('ui.fetchStreamsFail', 'Failed to fetch streams: '))}${escapeHtml(String(err).slice(0,140))}</div>`;
    }
  }
}

async function refreshLiveTvCategoriesDynamic() {
  if (!el.livetvCatScroller) return;
  try {
    const cats = await invoke('get_available_categories');
    if (!cats || !Array.isArray(cats) || cats.length === 0) return;
    const uniq = [...new Set(cats.map(c=> String(c).trim()).filter(Boolean))];
    const emojiMap = {
      'sports': '⚽', 'news': '📰', 'movies': '🎬', 'movie': '🎬', 'general': '🎬', 'entertainment': '🎬', 'kids': '👶', 'animation': '👶', 'cartoon': '👶', 'music': '🎵', 'documentary': '🌍', 'education': '🌍', 'science': '🌍', 'culture': '🌍', 'gaming': '🎮', 'game': '🎮', 'radio': '📻', 'religious': '🕌', 'lifestyle': '🌟', 'business': '💼', 'classic': '🎞️', 'comedy': '😂', 'outdoor': '🏕️', 'auto': '🚗', 'combat': '🥊'
    };
    const allActive = state.activeLiveTvCat === 'all' ? 'active' : '';
    let html = `<button class="genre-chip ${allActive}" data-cat="all">🌟 All Categories</button>`;
    for (const raw of uniq) {
      const lower = String(raw).toLowerCase();
      const emoji = emojiMap[lower] || '📺';
      const isActive = state.activeLiveTvCat === lower ? 'active' : '';
      const label = raw.charAt(0).toUpperCase()+raw.slice(1);
      html += `<button class="genre-chip ${isActive}" data-cat="${lower}">${emoji} ${label}</button>`;
    }
    const coreCats = ['sports','news','movies','music','kids'];
    for (const cc of coreCats) {
      if (!uniq.map(c=> String(c).toLowerCase()).includes(cc)) {
        const emoji = emojiMap[cc] || '📺';
        const label = cc.charAt(0).toUpperCase()+cc.slice(1);
        const isActive = state.activeLiveTvCat === cc ? 'active' : '';
        html += `<button class="genre-chip ${isActive}" data-cat="${cc}">${emoji} ${label}</button>`;
      }
    }
    el.livetvCatScroller.innerHTML = html;
    // Re-bind via delegation (avoid duplicate listeners)
    const newScroller = el.livetvCatScroller.cloneNode(true);
    el.livetvCatScroller.parentNode.replaceChild(newScroller, el.livetvCatScroller);
    el.livetvCatScroller = newScroller;
    el.livetvCatScroller.addEventListener('click', async (e)=>{
      const chip = e.target.closest('.genre-chip');
      if(!chip) return;
      el.livetvCatScroller.querySelectorAll('.genre-chip').forEach(c=>c.classList.remove('active'));
      chip.classList.add('active');
      state.activeLiveTvCat = chip.dataset.cat;
      await loadLiveTvContent();
    });
  } catch (e) {
    console.warn('Dynamic categories failed, keep static fallback', e);
  }
}

function renderLiveTvGrid(channels) {
  if (!el.livetvGrid) return;
  if (!channels || channels.length === 0) {
    el.livetvGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
        ${escapeHtml(t('ui.noItems', 'No items found.'))}
      </div>
    `;
    return;
  }

  // Pagination: render in chunks of 60 so 10k channels don't freeze the DOM
  const PAGE = 60;
  _liveTvAll = channels;
  const visible = channels.slice(0, _liveTvVisible);
  const remaining = channels.length - visible.length;

  el.livetvGrid.innerHTML = visible.map((ch, idx) => {
    const fallbackLogo = `https://ui-avatars.com/api/?name=${encodeURIComponent(ch.name)}&background=1e293b&color=ffffff&bold=true`;
    const logoSrc = ch.logo || fallbackLogo;
    const epgNow = ch.epg_now ? `<div style="font-size:0.72rem; color:#22c55e; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"><span style="font-weight:800;">${escapeHtml(t('ui.liveNow', 'NOW:'))}</span> ${escapeHtml(ch.epg_now)}</div>` : '';
    const epgNext = ch.epg_next ? `<div style="font-size:0.7rem; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(t('ui.liveNext', 'Next:'))} ${escapeHtml(ch.epg_next)}</div>` : '';

    return `
      <div class="livetv-card" data-live-idx="${idx}">
        <div class="livetv-header">
          <div class="livetv-logo-box">
            <img class="livetv-logo-img" src="${logoSrc}" alt="${ch.name}" onerror="this.src='${fallbackLogo}'" />
          </div>
          <div class="livetv-info">
            <div class="livetv-name">${ch.country_flag} ${ch.name}</div>
            <div class="livetv-meta">
              <span class="livetv-tag">${ch.category}</span>
              <span>•</span>
              <span class="livetv-tag" style="color: var(--accent-cyan); font-weight: 700;">${ch.resolution || 'HD'}</span>
              <span>•</span>
              <div class="livetv-live-badge">
                <div class="livetv-live-dot"></div>
                <span>LIVE</span>
              </div>
            </div>
            ${epgNow}
            ${epgNext}
          </div>
        </div>

        <div class="livetv-actions">
          <button class="btn-play-stream btn-play-live" data-live-play-idx="${idx}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>${escapeHtml(t('ui.watchLive', 'Watch Live'))}</span>
          </button>
          <button class="btn-vlc-stream btn-vlc-live" data-live-vlc-idx="${idx}" title="Open live stream in VLC Media Player">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>VLC</span>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Click handler on card & Play button
  el.livetvGrid.querySelectorAll('.livetv-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-vlc-live')) return;
      const idx = parseInt(card.dataset.liveIdx);
      const ch = channels[idx];
      if (ch) playLiveChannel(ch);
    });
  });

  el.livetvGrid.querySelectorAll('.btn-play-live').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.livePlayIdx);
      const ch = channels[idx];
      if (ch) playLiveChannel(ch);
    });
  });

  // VLC click handler
  el.livetvGrid.querySelectorAll('.btn-vlc-live').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.liveVlcIdx);
      const ch = channels[idx];
      if (ch && ch.stream_url) {
        try {
          await invoke('open_in_vlc', { streamUrl: ch.stream_url });
        } catch (vlcErr) {
          console.error('VLC Live launch error:', vlcErr);
        }
      }
    });
  });

  // Show-more pagination footer
  const oldMore = document.getElementById('livetv-show-more');
  if (oldMore) oldMore.remove();
  if (remaining > 0) {
    const btn = document.createElement('button');
    btn.id = 'livetv-show-more';
    btn.className = 'btn-load-more';
    btn.style.gridColumn = '1 / -1';
    btn.innerHTML = `<span>Show more (${remaining} left • ${channels.length} total)</span>`;
    btn.addEventListener('click', () => {
      _liveTvVisible += 60;
      renderLiveTvGrid(_liveTvAll);
      try { trackEvent('livetv_show_more', { visible: _liveTvVisible }); } catch {}
    });
    el.livetvGrid.appendChild(btn);
  }
}

// LiveTV pagination state (10k channels → render 60 at a time)
let _liveTvAll = [];
let _liveTvVisible = 60;

async function playLiveChannel(ch) {
  state.activeStream = {
    resolution: ch.resolution || '1080p HD',
    quality: 'LIVE HLS',
    provider: `${ch.country_flag} ${ch.name}`,
    size_formatted: 'Live Broadcast',
  };

  if (!el.playerView) return;
  el.playerView.classList.add('active');

  // Trigger popunder (24h cap)
  tryTriggerPopunder();

  // Pre-roll Video Ad with 5s countdown and Skip Ad button
  await handlePreRollAd();

  if (el.playerMediaTitle) el.playerMediaTitle.textContent = `🔴 LIVE: ${ch.country_flag} ${ch.name}`;
  if (el.playerStreamStats) el.playerStreamStats.textContent = `${ch.resolution || '1080p HD'} • ${ch.category} • ${t('ui.liveBroadcast', 'Live Broadcast')}`;

  if (el.hudStatus) el.hudStatus.textContent = t('ui.hudLive', '🔴 LIVE Stream');
  if (el.hudSpeed) el.hudSpeed.textContent = t('ui.multiCdn', '⚡ Multi-CDN Live');
  if (el.hudPeers) el.hudPeers.textContent = t('ui.active100', '👥 100% Active');
  if (el.hudProgress) el.hudProgress.textContent = t('ui.liveWord', 'LIVE');

  if (el.mainIframe) {
    el.mainIframe.style.display = 'none';
    el.mainIframe.src = 'about:blank';
  }

  if (el.mainVideo) {
    el.mainVideo.style.display = 'block';

    if (activeHls) {
      activeHls.destroy();
      activeHls = null;
    }

    if (window.Hls && Hls.isSupported() && (ch.stream_url.includes('.m3u8') || !ch.stream_url.includes('.mp4'))) {
      activeHls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
      });
      activeHls.loadSource(ch.stream_url);
      activeHls.attachMedia(el.mainVideo);
      activeHls.on(Hls.Events.MANIFEST_PARSED, () => {
        el.mainVideo.play().catch((e) => console.log('Live autoplay notice:', e));
      });
      activeHls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.warn('HLS fatal error, trying native play:', data);
          el.mainVideo.src = ch.stream_url;
          el.mainVideo.play().catch((e) => console.log('Native fallback play notice:', e));
        }
      });
    } else {
      el.mainVideo.src = ch.stream_url;
      el.mainVideo.load();
      el.mainVideo.play().catch((e) => console.log('Live autoplay notice:', e));
    }
  }

  updatePlayPauseButton(true);
}

function renderHero(item) {
  state.featuredItem = item;
  if (!el.heroBanner) return;

  const backdrop = item.backdrop_url || item.poster_url || '';
  el.heroBanner.style.backgroundImage = `url('${backdrop}')`;
  if (el.heroTitle) el.heroTitle.textContent = item.title;
  if (el.heroRating) el.heroRating.textContent = `★ ${item.vote_average.toFixed(1)}`;
  if (el.heroYear) el.heroYear.textContent = (item.release_date || '').substring(0, 4) || '2026';
  if (el.heroType) el.heroType.textContent = (item.media_type || 'movie').toUpperCase();
  if (el.heroOverview) el.heroOverview.textContent = item.overview || 'No synopsis available.';
}

function renderGrid(container, items, append = false) {
  if (!container) return;
  if (!items || items.length === 0) {
    if (!append) {
      container.innerHTML = `<div style="color: var(--text-muted); padding: 20px;">${escapeHtml(t('ui.noItems', 'No items found.'))}</div>`;
    }
    return;
  }

  const html = items
    .map((item) => {
      const poster = getAdaptivePoster(item) || item.poster_url || 'https://via.placeholder.com/300x450/1e293b/ffffff?text=No+Poster';
      const year = (item.release_date || '').substring(0, 4) || '';
      const type = (item.media_type || 'movie').toUpperCase();

      return `
        <div class="media-card" data-id="${item.id}" data-type="${item.media_type || 'movie'}">
          <div class="media-poster-wrap">
            <img class="media-poster" src="${poster}" alt="${item.title}" loading="lazy" decoding="async" />
            <div class="media-rating-tag">★ ${item.vote_average.toFixed(1)}</div>
            <div class="media-type-tag">${type}</div>
          </div>
          <div class="media-card-info">
            <div class="media-card-title" title="${item.title}">${item.title}</div>
            <div class="media-card-meta">
              <span>${year}</span>
              <span>HD</span>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  if (append) {
    container.insertAdjacentHTML('beforeend', html);
  } else {
    container.innerHTML = html;
  }

  container.querySelectorAll('.media-card:not([data-bound])').forEach((card) => {
    card.setAttribute('data-bound', 'true');
    card.addEventListener('click', () => {
      const id = parseInt(card.dataset.id);
      const type = card.dataset.type;
      openDetailsModal(id, type);
    });
  });
}

// ==========================================================================
// Details Modal & Stream Fetching
// ==========================================================================
async function openDetailsModal(id, mediaType) {
  try {
    if (!el.detailsModal) return;
    el.detailsModal.classList.add('open');
    if (el.streamsLoading) el.streamsLoading.style.display = 'inline';
    if (el.streamsList) el.streamsList.innerHTML = '<div class="spinner"></div>';
    if (el.tvSeasonPickerContainer) el.tvSeasonPickerContainer.style.display = 'none';

    const details = await invoke('get_media_details', { mediaType, id, language: getTmdbLanguage() });

    state.selectedMedia = details;
    state.selectedSeason = 1;
    state.selectedEpisode = 1;

    // Populate Modal UI
    const backdrop = details.backdrop_url || details.poster_url || '';
    if (el.modalHero) el.modalHero.style.backgroundImage = `url('${backdrop}')`;
    if (el.modalPoster) el.modalPoster.src = details.poster_url || '';
    if (el.modalTitle) el.modalTitle.textContent = details.title;
    if (el.modalRating) el.modalRating.textContent = `★ ${details.vote_average.toFixed(1)}`;
    if (el.modalYear) el.modalYear.textContent = (details.release_date || '').substring(0, 4) || '2026';
    if (el.modalRuntime) el.modalRuntime.textContent = details.runtime ? `${details.runtime} ${t('ui.minUnit', 'min')}` : (details.status || '');
    if (el.modalOverview) el.modalOverview.textContent = details.overview || t('ui.noOverview', 'No overview available.');

    // Genres
    if (el.modalGenres) {
      el.modalGenres.innerHTML = (details.genres || [])
        .map((g) => `<span class="modal-genre-tag">${g.name}</span>`)
        .join('');
    }

    // Cast
    if (el.modalCast) {
      el.modalCast.innerHTML = (details.cast || [])
        .map((c) => `
          <div class="cast-card">
            <img class="cast-avatar" src="${c.profile_url || 'https://via.placeholder.com/100/334155/ffffff?text=Cast'}" alt="${c.name}" />
            <div class="cast-name">${c.name}</div>
            <div class="cast-character">${c.character || ''}</div>
          </div>
        `)
        .join('');
    }

    // Trailers Section & Watch Trailer Button
    const trailers = (details.trailers || []).filter((t) => t.key && t.site === 'YouTube');
    if (trailers.length > 0) {
      const mainTrailer = trailers.find((t) => t.video_type === 'Trailer') || trailers[0];
      if (el.modalTrailerBtn) {
        el.modalTrailerBtn.style.display = 'inline-flex';
        el.modalTrailerBtn.onclick = () => {
          openTrailerModal(mainTrailer.key, `${details.title} - ${t('ui.trailerWord', 'Trailer')}`);
        };
      }
      if (el.modalTrailersSection && el.modalTrailersList) {
        el.modalTrailersSection.style.display = 'block';
        el.modalTrailersList.innerHTML = trailers
          .map(
            (t) => `
          <div class="trailer-card" data-key="${t.key}" data-name="${escapeHtml(t.name)}">
            <div class="trailer-thumb-wrap">
              <img class="trailer-thumb-img" src="https://img.youtube.com/vi/${t.key}/hqdefault.jpg" alt="${escapeHtml(t.name)}" loading="lazy" />
              <div class="trailer-play-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </div>
            </div>
            <div class="trailer-info">
              <div class="trailer-card-title" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>
              <div class="trailer-card-type">${escapeHtml(t.video_type || 'Trailer')} • YouTube HD</div>
            </div>
          </div>
        `
          )
          .join('');

        el.modalTrailersList.querySelectorAll('.trailer-card').forEach((card) => {
          card.addEventListener('click', () => {
            openTrailerModal(card.dataset.key, `${details.title} - ${card.dataset.name}`);
          });
        });
      }
    } else {
      if (el.modalTrailerBtn) {
        el.modalTrailerBtn.style.display = 'none';
      }
      if (el.modalTrailersSection) el.modalTrailersSection.style.display = 'none';
    }

    // Watchlist state
    checkWatchlistStatus(details.id, details.media_type);

    // If TV show, render Season & Episode Picker
    if (details.media_type === 'tv' && details.seasons && details.seasons.length > 0) {
      if (el.tvSeasonPickerContainer) el.tvSeasonPickerContainer.style.display = 'block';
      const validSeasons = details.seasons.filter((s) => s.season_number > 0);
      if (el.seasonSelect) {
        el.seasonSelect.innerHTML = validSeasons
          .map((s) => `<option value="${s.season_number}">${escapeHtml(s.name || t('ui.seasonLabel', 'Season {n}').replace('{n}', s.season_number))}</option>`)
          .join('');

        el.seasonSelect.onchange = async () => {
          state.selectedSeason = parseInt(el.seasonSelect.value);
          await loadEpisodesForSeason(details.id, state.selectedSeason);
        };
      }

      await loadEpisodesForSeason(details.id, validSeasons[0] ? validSeasons[0].season_number : 1);
    } else {
      // Movie: Fetch Streams directly
      const realId = (details.imdb_id && details.imdb_id.startsWith('tt')) ? details.imdb_id : String(details.id);
      await loadStreamsForMedia(realId, 'movie', null, null, details.id);
    }
  } catch (err) {
    console.error('Failed to get media details:', err);
    if (el.streamsList) {
      el.streamsList.innerHTML = `<div style="color: #ef4444; padding: 20px;">${escapeHtml(t('ui.fetchStreamsFail', 'Failed to load: '))}${escapeHtml(String(err).slice(0,120))}</div>`;
    }
  }
}

  function openTrailerModal(youtubeKey, title = t('ui.trailerModalTitle', 'Official Trailer')) {
  if (!youtubeKey) return;
  if (el.trailerModalTitle) el.trailerModalTitle.textContent = title;
  if (el.trailerIframe) {
    el.trailerIframe.src = `https://www.youtube-nocookie.com/embed/${youtubeKey}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
  }
  if (el.trailerModal) el.trailerModal.classList.add('open');
}

function closeTrailerModal() {
  if (el.trailerModal) el.trailerModal.classList.remove('open');
  if (el.trailerIframe) el.trailerIframe.src = 'about:blank';
}

async function loadEpisodesForSeason(tvId, seasonNumber) {
  if (!el.episodesList) return;
  try {
    el.episodesList.innerHTML = '<div class="spinner"></div>';
    const episodes = await invoke('get_season_episodes', { tvId, seasonNumber, language: getTmdbLanguage() });

    if (!episodes || episodes.length === 0) {
      el.episodesList.innerHTML = '<div style="color: var(--text-muted); padding: 10px;">' + escapeHtml(t('ui.noEpisodes', 'No episodes found for this season.')) + '</div>';
      return;
    }

    el.episodesList.innerHTML = episodes
      .map(
        (ep) => `
        <div class="stream-card episode-chip ${ep.episode_number === 1 ? 'active' : ''}" 
             data-ep="${ep.episode_number}" 
             style="min-width: 140px; padding: 8px 12px; flex-shrink: 0; text-align: center; cursor: pointer;">
          <div style="font-weight: 700; font-size: 0.85rem;">${escapeHtml(t('ui.episodeLabel', 'Episode {n}').replace('{n}', ep.episode_number))}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${ep.name}</div>
        </div>
      `
      )
      .join('');

    const targetMediaId = (state.selectedMedia.imdb_id && state.selectedMedia.imdb_id.startsWith('tt')) 
      ? state.selectedMedia.imdb_id 
      : String(state.selectedMedia.id);

    el.episodesList.querySelectorAll('.episode-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        el.episodesList.querySelectorAll('.episode-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.selectedEpisode = parseInt(chip.dataset.ep);
        await loadStreamsForMedia(targetMediaId, 'series', state.selectedSeason, state.selectedEpisode, state.selectedMedia.id);
      });
    });

    // Load streams for first episode
    await loadStreamsForMedia(targetMediaId, 'series', seasonNumber, episodes[0].episode_number, state.selectedMedia.id);
  } catch (err) {
    console.error('Error fetching episodes:', err);
  }
}

let currentStreamsData = [];
let activeStreamFilter = 'all';
let currentSeasonParam = null;
let currentEpisodeParam = null;

async function loadStreamsForMedia(imdbId, mediaType, season = null, episode = null, tmdbId = null) {
  currentSeasonParam = season;
  currentEpisodeParam = episode;
  if (el.streamsLoading) el.streamsLoading.style.display = 'inline';
  if (el.streamsList) el.streamsList.innerHTML = '<div class="spinner"></div>';

  try {
    const streams = await invoke('get_torrent_streams', torrentInvokeArgs({
      mediaType,
      imdbId,
      tmdbId: tmdbId ? parseInt(tmdbId) : null,
      season: season ? parseInt(season) : null,
      episode: episode ? parseInt(episode) : null,
    }));

    if (el.streamsLoading) el.streamsLoading.style.display = 'none';
    const rawStreams = (streams || []).filter((s) => isProviderEnabled(s.provider || s.name));
    // Prioritize Native Streams (Torrents & Direct media files) over iframe web embeds
    rawStreams.sort((a, b) => {
      const aIsNative = (a.magnet_uri || a.info_hash || (a.stream_url && /\.(mp4|mkv|webm|m4v|avi|mov|ts)(\?|$)/i.test(a.stream_url))) ? 1 : 0;
      const bIsNative = (b.magnet_uri || b.info_hash || (b.stream_url && /\.(mp4|mkv|webm|m4v|avi|mov|ts)(\?|$)/i.test(b.stream_url))) ? 1 : 0;
      if (aIsNative !== bIsNative) return bIsNative - aIsNative;
      if (a.is_debrid && !b.is_debrid) return -1;
      if (!a.is_debrid && b.is_debrid) return 1;
      return (b.seeders || 0) - (a.seeders || 0);
    });
    currentStreamsData = rawStreams;
    renderFilteredStreams();
  } catch (err) {
    if (el.streamsLoading) el.streamsLoading.style.display = 'none';
    if (el.streamsList) {
      el.streamsList.innerHTML = `<div style="color: #ef4444; padding: 20px;">${escapeHtml(t('ui.fetchStreamsFail', 'Failed to fetch streams: '))}${escapeHtml(String(err).slice(0,120))}</div>`;
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderFilteredStreams() {
  if (!el.streamsList) return;
  if (!currentStreamsData || currentStreamsData.length === 0) {
    el.streamsList.innerHTML = `
      <div style="text-align: center; padding: 28px; color: var(--text-muted);">
        ${escapeHtml(t('ui.noStreams', 'No streaming links found.'))}
      </div>
    `;
    return;
  }

  let filtered = currentStreamsData.filter((st) => {
    if (activeStreamFilter === 'all') return true;
    if (activeStreamFilter === 'debrid') return st.is_debrid;
    if (activeStreamFilter === '4k') return st.resolution === '4K';
    if (activeStreamFilter === '1080p') return st.resolution === '1080p';
    if (activeStreamFilter === '720p') return st.resolution === '720p';
    if (activeStreamFilter === 'french') {
      return (st.flags && st.flags.includes('🇫🇷')) || (st.languages && st.languages.includes('French'));
    }
    if (activeStreamFilter === 'arabic') {
      return (st.flags && (st.flags.includes('🇸🇦') || st.flags.includes('🇲🇦'))) || (st.languages && st.languages.includes('Arabic'));
    }
    return true;
  });

  if (filtered.length === 0) {
    el.streamsList.innerHTML = `
      <div style="text-align: center; padding: 28px; color: var(--text-muted);">
        ${escapeHtml(t('ui.noStreamsFilter', 'No streams matching this filter.'))}
      </div>
    `;
    return;
  }

  el.streamsList.innerHTML = filtered
    .map((st, index) => {
      const resClass = st.resolution === '4K' ? 'res-4k' : st.resolution === '1080p' ? 'res-1080p' : st.resolution === '720p' ? 'res-720p' : '';
      const debridClass = st.is_debrid ? 'is-debrid' : '';
      const isDead = !st.is_debrid && (!st.seeders || st.seeders === 0) && (st.magnet_uri || st.info_hash);
      const seedsClass = st.is_debrid ? 'seeds-debrid' : st.seeders > 30 ? 'seeds-high' : st.seeders > 10 ? 'seeds-med' : 'seeds-low';
      const seedersText = st.is_debrid ? '⚡ RD+ Instant' : st.seeders > 0 ? `👥 ${st.seeders} seeds` : '⚠️ 0 seeds';
      const deadWarn = isDead ? `<span class="stream-badge" style="background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.45);color:#f87171;" title="No seeders — may not play">⚠️ Dead?</span>` : '';
      const flagsText = st.flags ? `<span class="stream-flags">${st.flags}</span>` : '';
      const audioBadge = st.audio_channels ? `<span class="stream-badge audio-badge">🎧 ${escapeHtml(st.audio_channels)}</span>` : '';
      const debridBadge = st.is_debrid ? `<span class="stream-badge badge-debrid">⚡ RD+</span>` : '';
      const displayTitle = st.title || st.name || (state.selectedMedia ? state.selectedMedia.title : 'Stream Source');
      const providerLabel = st.provider || st.name || 'Torrentio';
      const sizeLabel = st.size_formatted === 'Instant' ? t('ui.instant', 'Instant') : st.size_formatted;

      return `
        <div class="stream-card ${debridClass}" data-filtered-idx="${index}">
          <div class="stream-meta-left">
            <span class="resolution-badge ${resClass}">${escapeHtml(st.resolution)}</span>
            <div class="stream-title-info">
              <div class="stream-name-row">
                <span class="stream-title-text" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</span>
                ${flagsText}
                ${debridBadge}
                ${deadWarn}
                ${audioBadge}
              </div>
              <div class="stream-details">
                <span class="stream-provider-badge">${escapeHtml(providerLabel)}</span>
                <span>•</span>
                <span class="stream-badge">${escapeHtml(st.quality)}</span>
                <span>•</span>
                <span class="stream-badge">💾 ${escapeHtml(sizeLabel)}</span>
              </div>
            </div>
          </div>

          <div class="stream-meta-right">
            <div class="seeders-badge ${seedsClass}">${seedersText}</div>
            <button class="btn-play-stream" data-play-idx="${index}" title="${escapeHtml(t('stream.play', 'Play'))}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <span>${escapeHtml(t('stream.play', 'Play'))}</span>
            </button>
            <button class="btn-download-stream" data-download-idx="${index}" title="${escapeHtml(t('stream.download', 'Download'))}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>${escapeHtml(t('stream.download', 'Download'))} 💾</span>
            </button>
            <button class="btn-vlc-stream" data-vlc-idx="${index}" title="${escapeHtml(t('ui.openVlcTitle', 'Play in VLC'))}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <span>${escapeHtml(t('stream.vlc', 'VLC'))}</span>
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  // Click handler for Play in App
  el.streamsList.querySelectorAll('.btn-play-stream').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.playIdx);
      const selectedStream = filtered[idx];
      if (selectedStream) {
        startPlayback(selectedStream, state.selectedMedia, currentSeasonParam, currentEpisodeParam);
      }
    });
  });

  // Click handler for Download
  el.streamsList.querySelectorAll('.btn-download-stream').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.downloadIdx);
      const selectedStream = filtered[idx];
      if (selectedStream && state.selectedMedia) {
        await startDownloadForStream(selectedStream, state.selectedMedia, currentSeasonParam, currentEpisodeParam);
      }
    });
  });

  // Click handler for VLC
  el.streamsList.querySelectorAll('.btn-vlc-stream').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.vlcIdx);
      const selectedStream = filtered[idx];
      if (selectedStream) {
        let streamTarget = selectedStream.stream_url;
        if (!streamTarget && selectedStream.magnet_uri) {
          try {
            const res = await fetch(`${state.torrentEngineUrl}/api/stream/start`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ magnet: selectedStream.magnet_uri }),
            });
            if (res.ok) {
              const data = await res.json();
              if (data.streamUrl) streamTarget = data.streamUrl;
            }
          } catch (err) {}
          if (!streamTarget) streamTarget = selectedStream.magnet_uri;
        }
        if (streamTarget) {
          try {
            await invoke('open_in_vlc', { streamUrl: streamTarget });
          } catch (vlcErr) {
            console.error('VLC launch error:', vlcErr);
          }
        }
      }
    });
  });

  // Click on card itself -> Play
  el.streamsList.querySelectorAll('.stream-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-vlc-stream') || e.target.closest('.btn-play-stream') || e.target.closest('.btn-download-stream')) return;
      const idx = parseInt(card.dataset.filteredIdx);
      const selectedStream = filtered[idx];
      if (selectedStream) {
        startPlayback(selectedStream, state.selectedMedia, currentSeasonParam, currentEpisodeParam);
      }
    });
  });
}

// ==========================================================================
// Video Player & Streaming Engine
// ==========================================================================
// === Torrent engine health pill (127.0.0.1:31337) — green/red + click to retry ===
async function pollEngineHealth() {
  const dot = document.querySelector('.server-status-pill .status-dot');
  const label = el.serverStatusText || document.getElementById('server-status-text');
  const setStatus = (ok, extra = '') => {
    if (dot) {
      dot.style.background = ok ? '#22c55e' : '#ef4444';
      dot.style.boxShadow = ok ? '0 0 8px #22c55e' : '0 0 8px #ef4444';
    }
    if (label) label.textContent = ok ? (extra ? t('ui.engReadyFfmpeg', 'Engine: Ready • ffmpeg ✓') : t('ui.engReady', 'Engine: Ready')) : t('ui.engOffline', 'Engine: Offline — click to retry');
  };
  try {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(`${state.torrentEngineUrl}/api/health`, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error('bad status');
    const data = await res.json().catch(() => ({}));
    setStatus(true, data && data.ffmpeg ? ' • ffmpeg ✓' : '');
  } catch (e) {
    logError('engine-health', e);
    setStatus(false);
  }
}
function initEngineHealthPill() {
  pollEngineHealth();
  setInterval(pollEngineHealth, 30000);
  const pill = document.querySelector('.server-status-pill');
  if (pill && !pill.dataset.bound) {
    pill.dataset.bound = '1';
    pill.style.cursor = 'pointer';
    pill.title = 'Check torrent engine';
    pill.addEventListener('click', () => {
      if (el.serverStatusText) el.serverStatusText.textContent = t('ui.engChecking', 'Engine: Checking...');
      pollEngineHealth();
    });
  }
}

function showPlayerLoading(msg = '⚡ Connecting to Video Stream...') {  if (el.playerLoadingOverlay) {
    el.playerLoadingOverlay.style.display = 'flex';
    if (el.playerLoadingMsg) el.playerLoadingMsg.textContent = msg;
  }
}

function hidePlayerLoading() {
  if (el.playerLoadingOverlay) el.playerLoadingOverlay.style.display = 'none';
}

function showVideoError(msg) {
  showVideoErrorStructured({ code: 'PLAYER_ERROR', message: msg });
}

// === Player error isolation: ENGINE vs PLAYER vs CONVERT ===
// code: NO_PEERS | METADATA_TIMEOUT | ENGINE_UNREACHABLE | UNSUPPORTED_CODEC | UNSUPPORTED_CONTAINER | NETWORK | PLAYER_ERROR
function showVideoErrorStructured({ code = 'PLAYER_ERROR', message = '', isMkv = false, canConvert = false, onConvert = null }) {
  try { trackEvent('player_error', { code, isMkv }); } catch {}
  const dict = (typeof getErrorDict === 'function') ? getErrorDict() : null;
  const title = (dict && dict[code]) || message || 'Video playback failed';
  const hint = dict ? (dict[`${code}_hint`] || '') : '';
  const showConvert = !!(isMkv && (canConvert || typeof onConvert === 'function' || state.lastConvertKey));
  if (el.playerLoadingOverlay) {
    el.playerLoadingOverlay.style.display = 'flex';
    if (el.playerLoadingMsg) {
      el.playerLoadingMsg.innerHTML = `
        <div style="max-width:520px;text-align:center;">
          <div style="color: #ef4444; font-weight: 800; font-size: 1.05rem; margin-bottom: 6px;">⚠️ ${escapeHtml(title)}</div>
          ${hint ? `<div style="color:var(--text-secondary);font-size:.85rem;margin-bottom:12px;">${escapeHtml(hint)}</div>` : ''}
          <div style="font-size:.72rem;color:var(--text-muted);margin-bottom:14px;">CODE: ${escapeHtml(code)}${isMkv ? ' • MKV' : ''}</div>
          <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
            <button id="error-btn-next" style="padding: 10px 18px; background: var(--accent-gradient); border: none; border-radius: 10px; color: white; cursor: pointer; font-weight: 700; font-size: 0.9rem;">${escapeHtml(t('player.retry', '⏭ Try Next Source'))}</button>
            ${showConvert ? `<button id="error-btn-convert" style="padding: 10px 18px; background: linear-gradient(135deg,#22c55e,#06b6d4); border: none; border-radius: 10px; color: white; cursor: pointer; font-weight: 700; font-size: 0.9rem;">${escapeHtml(t('player.convert', '🔄 Convert MKV→MP4'))}</button>` : ''}
            <button id="error-btn-vlc" style="padding: 10px 18px; background: linear-gradient(135deg, #8b5cf6, #06b6d4); border: none; border-radius: 10px; color: white; cursor: pointer; font-weight: 700; font-size: 0.9rem;">${escapeHtml(t('player.openVlc', 'Open in VLC'))}</button>
            <button id="error-btn-back" style="padding: 10px 18px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; color: white; cursor: pointer; font-size: 0.9rem;">${escapeHtml(t('player.sources', 'Sources'))}</button>
          </div>
        </div>
      `;
      const nextBtn = document.getElementById('error-btn-next');
      const convBtn = document.getElementById('error-btn-convert');
      const vlcBtn = document.getElementById('error-btn-vlc');
      const backBtn = document.getElementById('error-btn-back');
      if (nextBtn) nextBtn.addEventListener('click', () => { tryNextStream(); });
      if (convBtn) convBtn.addEventListener('click', async () => {
        if (typeof onConvert === 'function') { onConvert(); return; }
        if (state.lastConvert && state.lastConvert.infoHash != null) {
          startMkvAutoConvert(state.lastConvert.infoHash, state.lastConvert.fileIndex, state.lastConvert.streamUrl);
        }
      });
      if (vlcBtn) {
        vlcBtn.addEventListener('click', async () => {
          if (state.activeStream) {
            const target = state.activeStream.stream_url || state.activeStream.magnet_uri || state.lastConvert?.streamUrl;
            if (target) {
              try { await invoke('open_in_vlc', { streamUrl: target }); } catch (e) { console.error('VLC error:', e); }
            }
          }
        });
      }
      if (backBtn) {
        backBtn.addEventListener('click', () => {
          hidePlayerLoading();
          if (el.playerView) el.playerView.classList.remove('active');
          if (state.selectedMedia && el.detailsModal) el.detailsModal.classList.add('open');
        });
      }
    }
  }
}

function getFilteredTorrentStreams() {
  const list = Array.isArray(currentStreamsData) ? currentStreamsData : [];
  return list.filter((s) => s && (s.magnet_uri || s.info_hash));
}

function tryNextStream() {
  try {
    const torrents = getFilteredTorrentStreams();
    if (!torrents.length) {
      showVideoErrorStructured({ code: 'NO_PEERS', message: 'No other torrent source available' });
      return;
    }
    const cur = state.activeStream;
    let idx = torrents.findIndex((s) => cur && ((s.magnet_uri && s.magnet_uri === cur.magnet_uri) || (s.info_hash && cur.info_hash && s.info_hash === cur.info_hash)));
    const next = torrents[idx + 1] || torrents[0];
    state.failoverAttempts = (state.failoverAttempts || 0) + 1;
    const maxFail = state.remoteMaxFailover || 3;
    if (state.failoverAttempts > maxFail) {
      showVideoErrorStructured({ code: 'NO_PEERS', message: 'All torrent sources failed. Try a web server.' });
      state.failoverAttempts = 0;
      return;
    }
    trackEvent('player_failover', { attempt: state.failoverAttempts });
    startPlayback(next, state.selectedMedia, currentSeasonParam, currentEpisodeParam, { isFailover: true });
  } catch (e) {
    console.warn('failover failed', e);
  }
}

function classifyVideoError(err, isMkv) {
  if (!err) return isMkv ? 'UNSUPPORTED_CONTAINER' : 'PLAYER_ERROR';
  if (err.code === 2) return 'NETWORK';
  if (err.code === 3) return 'UNSUPPORTED_CODEC';
  if (err.code === 4) return isMkv ? 'UNSUPPORTED_CONTAINER' : 'UNSUPPORTED_CODEC';
  return isMkv ? 'UNSUPPORTED_CONTAINER' : 'PLAYER_ERROR';
}

// MKV auto-convert polling: convert on Node engine, then play MP4 progressively
let _convertPoller = null;
async function startMkvAutoConvert(infoHash, fileIndex, fallbackStreamUrl) {
  if (!infoHash) {
    showVideoErrorStructured({ code: 'UNSUPPORTED_CONTAINER', isMkv: true, canConvert: false });
    return;
  }
  state.lastConvert = { infoHash, fileIndex, streamUrl: fallbackStreamUrl };
  if (_convertPoller) { clearInterval(_convertPoller); _convertPoller = null; }
  showPlayerLoading('🔄 Converting MKV→MP4 inside app... 0%');
  if (el.hudStatus) el.hudStatus.textContent = t('ui.hudConverting', '🔄 Converting MKV');
  let key = null;
  try {
    const res = await fetch(`${state.torrentEngineUrl}/api/convert/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ infoHash, fileIndex }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const noFfmpeg = data && data.code === 'NO_FFMPEG';
      if (noFfmpeg) {
        // One-click rescue: fetch ffmpeg once (~80MB), then restart convert.
        const want = confirm(t('st.dlFfmpegConfirm', 'Download ffmpeg (~80MB, one time)?'));
        if (want) {
          try {
            showPlayerLoading(t('st.downloading', 'Downloading...') + ' ffmpeg');
            await downloadFfmpegOnDemand();
            startMkvAutoConvert(infoHash, fileIndex, fallbackStreamUrl);
            return;
          } catch (e) {
            logError('ffmpeg-dl', e);
          }
        }
      }
      showVideoErrorStructured({
        code: noFfmpeg ? 'NO_FFMPEG' : 'CONVERT_FAILED',
        message: (data && data.error) || 'Convert failed',
        isMkv: true, canConvert: false,
        onConvert: null,
      });
      return;
    }
    key = data.key;
    state.lastConvertKey = key;
  } catch (e) {
    showVideoErrorStructured({ code: 'ENGINE_UNREACHABLE', isMkv: true, canConvert: true });
    return;
  }
  _convertPoller = setInterval(async () => {
    try {
      const r = await fetch(`${state.torrentEngineUrl}/api/convert/status/${key}`);
      const st = await r.json();
      if (st.status === 'done' && st.outputUrl) {
        clearInterval(_convertPoller); _convertPoller = null;
        if (el.mainVideo) {
          el.mainVideo.oncanplay = () => { hidePlayerLoading(); if (el.hudStatus) el.hudStatus.textContent = t('ui.hudConverted', '⚡ Converted MP4'); };
          el.mainVideo.onplaying = () => { hidePlayerLoading(); updatePlayPauseButton(true); };
          el.mainVideo.onerror = () => {
            showVideoErrorStructured({ code: classifyVideoError(el.mainVideo.error, false), isMkv: false, canConvert: false });
          };
          el.mainVideo.src = st.outputUrl;
          el.mainVideo.load();
          el.mainVideo.play().catch(() => {});
        }
        try { trackEvent('mkv_converted', { key }); } catch {}
        return;
      }
      if (st.status === 'error') {
        clearInterval(_convertPoller); _convertPoller = null;
        showVideoErrorStructured({ code: 'CONVERT_FAILED', message: st.error || 'Convert failed', isMkv: true, canConvert: true });
        return;
      }
      const pct = st.progress || 0;
      showPlayerLoading(`🔄 Converting MKV→MP4 inside app... ${pct}%`);
      // Progressive playback: start playing the partial MP4 after 8%
      if (pct >= 8 && el.mainVideo && !el.mainVideo.src?.includes(`/api/convert/file/${key}`)) {
        try {
          el.mainVideo.src = `${state.torrentEngineUrl}/api/convert/file/${key}`;
          el.mainVideo.load();
          el.mainVideo.play().catch(() => {});
        } catch {}
      }
    } catch (e) {}
  }, 1500);
}

function switchPlayerServer(serverKey) {
  if (!state.selectedMedia) return;
  const isSeries = (state.selectedMedia.media_type === 'tv' || currentSeasonParam);
  const s = currentSeasonParam || 1;
  const e = currentEpisodeParam || 1;
  const id = state.selectedMedia.id;

  if (el.playerServerBar) {
    el.playerServerBar.querySelectorAll('.player-server-chip').forEach((c) => {
      if (c.dataset.server) {
        c.classList.toggle('active', c.dataset.server === serverKey);
      }
    });
  }

  showPlayerLoading(`⚡ Switching to Server: ${serverKey.toUpperCase()}...`);

  let url = '';
  if (serverKey === 'vidsrc') {
    url = isSeries
      ? `https://vidsrc.su/embed/tv/${id}/${s}/${e}`
      : `https://vidsrc.su/embed/movie/${id}`;
  } else if (serverKey === 'vidlink') {
    url = isSeries
      ? `https://vidlink.pro/tv/${id}/${s}/${e}`
      : `https://vidlink.pro/movie/${id}`;
  } else if (serverKey === 'smashy') {
    url = isSeries
      ? `https://embed.smashystream.com/playere.php?tmdb=${id}&season=${s}&episode=${e}`
      : `https://embed.smashystream.com/playere.php?tmdb=${id}`;
  } else if (serverKey === 'embedsu') {
    url = isSeries
      ? `https://embed.su/embed/tv/${id}/${s}/${e}`
      : `https://embed.su/embed/movie/${id}`;
  } else if (serverKey === 'autoembed') {
    url = isSeries
      ? `https://player.autoembed.co/embed/tv/${id}/${s}/${e}`
      : `https://player.autoembed.co/embed/movie/${id}`;
  } else if (serverKey === '2embed') {
    url = isSeries
      ? `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`
      : `https://www.2embed.cc/embed/${id}`;
  }

  if (serverKey === 'torrent') {
    if (state.lastTorrentStream) {
      startPlayback(state.lastTorrentStream, state.selectedMedia, currentSeasonParam, currentEpisodeParam);
    } else if (state.selectedMedia) {
      // Find default torrent stream if available
      const firstTorrent = (state.availableStreams || []).find(s => s.magnet_uri);
      if (firstTorrent) {
        startPlayback(firstTorrent, state.selectedMedia, currentSeasonParam, currentEpisodeParam);
      }
    }
    return;
  }

  if (url) {
    if (el.mainVideo) {
      el.mainVideo.style.display = 'none';
      el.mainVideo.pause();
      el.mainVideo.removeAttribute('src');
    }
    if (el.mainIframe) {
      el.mainIframe.style.display = 'block';
      el.mainIframe.onload = () => { hidePlayerLoading(); };
      el.mainIframe.src = url;
    }
    if (el.playerView) {
      el.playerView.classList.add('iframe-mode');
    }
    if (el.hudStatus) el.hudStatus.textContent = t('ui.hudServer', '⚡ Server: {s}').replace('{s}', serverKey.toUpperCase());
    if (el.hudSpeed) el.hudSpeed.textContent = t('ui.instantHd', '⚡ Instant HD');
  if (el.hudPeers) el.hudPeers.textContent = t('ui.ready100', '👥 100% Ready');
  if (el.hudProgress) el.hudProgress.textContent = t('ui.fullHd', 'Full HD');
  updatePlayPauseButton(true);
  resetOverlayTimer();
  }
}

async function startPlayback(stream, media, season = null, episode = null, opts = {}) {
  state.activeStream = stream;
  if (!el.playerView) return;
  if (!opts.isFailover) state.failoverAttempts = 0;

  el.playerView.classList.add('active');
  showPlayerLoading('⚡ Loading High Speed Stream...');

  const titlePrefix = (media.media_type === 'tv' || season) ? `S${season || 1}:E${episode || 1} - ` : '';
  if (el.playerMediaTitle) el.playerMediaTitle.textContent = `${titlePrefix}${media.title}`;
  if (el.playerStreamStats) el.playerStreamStats.textContent = `${stream.resolution} • ${stream.quality} • ${stream.provider} • ${stream.size_formatted}`;

  const isSeries = (media.media_type === 'tv' || season);
  const s = season || 1;
  const e = episode || 1;

  // Clear any existing stats polling loop
  if (state.torrentStatsInterval) {
    clearInterval(state.torrentStatsInterval);
    state.torrentStatsInterval = null;
  }

  // Synchronize server chips
  if (el.playerServerBar) {
    el.playerServerBar.querySelectorAll('.player-server-chip[data-server]').forEach((chip) => {
      if (stream.magnet_uri) {
        chip.classList.toggle('active', chip.dataset.server === 'torrent');
      } else {
        chip.classList.toggle('active', chip.dataset.server === 'vidsrc');
      }
    });
  }

  // Auto-load subtitles if IMDb ID is available
  const imdbId = media.imdb_id || (state.selectedMedia && state.selectedMedia.imdb_id);
  if (imdbId) {
    loadSubtitlesForPlayer(imdbId, season, episode);
  }

  // Smart Pop-Under check (once every 24 hours per visitor)
  tryTriggerPopunder();

  // Pre-roll Video Ad with 5s countdown and Skip Ad button
  await handlePreRollAd();

  // 1. If user clicked a direct Web Stream (VidSrc, VidLink, AutoEmbed, 2Embed, Real-Debrid direct, or any HTTP URL)
  if (stream.stream_url) {
    const isDirectVideo = /\.(mp4|mkv|webm|m4v|avi|mov|ts)(\?|$)/i.test(stream.stream_url);

    if (isDirectVideo) {
      if (el.playerView) el.playerView.classList.remove('iframe-mode');
      if (el.mainIframe) {
        el.mainIframe.style.display = 'none';
        el.mainIframe.src = 'about:blank';
      }
      if (el.mainVideo) {
        el.mainVideo.style.display = 'block';
        el.mainVideo.oncanplay = () => { hidePlayerLoading(); };
        el.mainVideo.onplaying = () => { hidePlayerLoading(); updatePlayPauseButton(true); };
        el.mainVideo.onerror = () => {
          const code = classifyVideoError(el.mainVideo.error, /\.mkv(\?|$)/i.test(stream.stream_url || ''));
          showVideoErrorStructured({ code, isMkv: /\.mkv(\?|$)/i.test(stream.stream_url || ''), canConvert: false });
        };
        el.mainVideo.src = stream.stream_url;
        el.mainVideo.load();
        el.mainVideo.play().catch((e) => console.log('Autoplay notice:', e));
      }
    } else {
      if (el.playerView) el.playerView.classList.add('iframe-mode');
      if (el.mainVideo) {
        el.mainVideo.style.display = 'none';
        el.mainVideo.pause();
        el.mainVideo.removeAttribute('src');
      }
      if (el.mainIframe) {
        el.mainIframe.style.display = 'block';
        el.mainIframe.onload = () => { hidePlayerLoading(); };
        el.mainIframe.src = stream.stream_url;
      }
    }
    if (el.hudStatus) el.hudStatus.textContent = t('ui.hudStreaming', '⚡ Streaming Live');
    if (el.hudSpeed) el.hudSpeed.textContent = t('ui.instantHd', '⚡ Instant HD');
    if (el.hudPeers) el.hudPeers.textContent = t('ui.ready100', '👥 100% Ready');
    if (el.hudProgress) el.hudProgress.textContent = t('ui.fullHd', 'Full HD');
    updatePlayPauseButton(true);
    resetOverlayTimer();
    return;
  }

  // 2. If user clicked a Torrent (Torrentio / YTS / Magnet URI)
  if (stream.magnet_uri) {
    state.lastTorrentStream = stream;
    if (el.playerView) el.playerView.classList.remove('iframe-mode');
    if (el.mainIframe) {
      el.mainIframe.style.display = 'none';
      el.mainIframe.src = 'about:blank';
    }
    if (el.mainVideo) {
      el.mainVideo.style.display = 'block';
    }

    if (el.hudStatus) el.hudStatus.textContent = t('ui.hudConnecting', 'Connecting to Peers...');
    if (el.hudSpeed) el.hudSpeed.textContent = '↓ Connecting...';
    if (el.hudPeers) el.hudPeers.textContent = `👥 ${stream.seeders || 1} seeds`;
    if (el.hudProgress) el.hudProgress.textContent = 'Resolving Metadata...';

    showPlayerLoading('⚡ Connecting to Torrent Network & Peers...');

    try {
      const res = await fetch(`${state.torrentEngineUrl}/api/stream/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet: stream.magnet_uri }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.streamUrl) {
          console.log('[WebTorrent Engine] Streaming active:', data.streamUrl, data.code);

          // --- Error isolation: ENGINE errors first ---
          if (data.code === 'METADATA_TIMEOUT' && !data.hasMetadata) {
            showVideoErrorStructured({ code: 'METADATA_TIMEOUT', isMkv: false, canConvert: false });
            return;
          }

          const fileName = (data.name || '').toLowerCase();
          const isMkv = !!(data.isMkv || fileName.endsWith('.mkv'));
          const fileIndex = (data.fileIndex != null) ? data.fileIndex : 0;
          const autoTranscode = state.settings ? state.settings.auto_transcode !== false : true;

          // Dead-torrent signal: keep playing (webseeds may still work) but warn + watchdog
          const deadOnStart = data.code === 'NO_PEERS';
          if (deadOnStart && el.hudStatus) el.hudStatus.textContent = t('ui.hudDeadTry', '⚠️ 0 seeds — trying anyway...');

          // --- MKV auto-convert inside app (user choice) ---
          if (isMkv && autoTranscode && data.infoHash != null) {
            if (el.hudStatus) el.hudStatus.textContent = t('ui.hudMkvConvert', '🔄 MKV detected — converting...');
            startMkvAutoConvert(data.infoHash, fileIndex, data.streamUrl);
            // Start stats poller too so HUD keeps updating during convert
          }

          if (el.mainVideo) {
            el.mainVideo.oncanplay = () => {
              hidePlayerLoading();
              state.failoverAttempts = 0;
              if (el.hudStatus) el.hudStatus.textContent = isMkv ? (autoTranscode ? t('ui.hudP2pMkv', '🔄 P2P (MKV→MP4)') : t('ui.hudP2pMkvRaw', '⚡ P2P (MKV)')) : t('ui.hudP2pPlay', '⚡ P2P Playing');
            };
            el.mainVideo.onplaying = () => {
              hidePlayerLoading();
              state.failoverAttempts = 0;
              updatePlayPauseButton(true);
            };
            el.mainVideo.onerror = () => {
              const code = classifyVideoError(el.mainVideo.error, isMkv);
              console.warn('[Video Player Error]', code, el.mainVideo.error);
              if (state.torrentStatsInterval) {
                clearInterval(state.torrentStatsInterval);
                state.torrentStatsInterval = null;
              }
              // MKV that the browser cannot decode -> offer 1-click convert
              if (isMkv && (code === 'UNSUPPORTED_CONTAINER' || code === 'UNSUPPORTED_CODEC')) {
                if (autoTranscode && data.infoHash != null) {
                  startMkvAutoConvert(data.infoHash, fileIndex, data.streamUrl);
                  return;
                }
                showVideoErrorStructured({ code, isMkv: true, canConvert: true,
                  onConvert: () => startMkvAutoConvert(data.infoHash, fileIndex, data.streamUrl) });
                return;
              }
              // Network stall on a dead torrent -> suggest next source, don't loop forever
              if (code === 'NETWORK' && deadOnStart) {
                showVideoErrorStructured({ code: 'NO_PEERS', isMkv, canConvert: isMkv });
                return;
              }
              showVideoErrorStructured({ code, isMkv, canConvert: isMkv,
                onConvert: (data.infoHash != null) ? () => startMkvAutoConvert(data.infoHash, fileIndex, data.streamUrl) : null });
            };
            // If MKV + auto-transcode: converter takes over playback; keep direct URL as fallback underneath
            if (!(isMkv && autoTranscode)) {
              el.mainVideo.src = data.streamUrl;
              el.mainVideo.load();
              el.mainVideo.play().catch((e) => console.log('Autoplay notice:', e));
            }
          }

          // Live Torrent Stats Poller — also updates loading overlay + dead-torrent watchdog
          let deadTicks = 0;
          if (state.torrentStatsInterval) clearInterval(state.torrentStatsInterval);
          state.torrentStatsInterval = setInterval(async () => {
            try {
              const statsRes = await fetch(`${state.torrentEngineUrl}/api/stream/stats/${data.infoHash}`);
              if (statsRes.ok) {
                const stats = await statsRes.json();
                if (el.hudSpeed) el.hudSpeed.textContent = stats.speed_formatted || '↓ 0 KB/s';
                if (el.hudPeers) el.hudPeers.textContent = (stats.peers === 0 && !stream.is_debrid) ? t('ui.peersZero', '⚠️ 0 peers') : t('ui.peersTpl', '👥 {n} peers').replace('{n}', stats.peers || stream.seeders || 1);
                if (el.hudProgress) el.hudProgress.textContent = t('ui.progressBuffered', '{n}% Buffered').replace('{n}', stats.progress_pct || 0);
                if (el.hudStatus && !el.hudStatus.textContent.includes('VLC') && !el.hudStatus.textContent.includes('Error') && !el.hudStatus.textContent.includes('Convert')) {
                  el.hudStatus.textContent = (stats.peers > 0 || stats.progress_pct > 0) ? t('ui.hudP2pLive', '⚡ P2P Live') : (deadOnStart ? t('ui.hudDeadTry', '⚠️ 0 seeds') : t('ui.hudConnecting', 'Connecting'));
                }
                if (el.playerLoadingOverlay && el.playerLoadingOverlay.style.display !== 'none' && el.playerLoadingMsg && !el.playerLoadingMsg.innerHTML.includes('Convert')) {
                  const pct = stats.progress_pct || 0;
                  const spd = stats.speed_formatted || '↓ connecting';
                  const peers = stats.peers || 0;
                  el.playerLoadingMsg.textContent = t('ui.bufferingTpl', '⚡ Buffering...').replace('{spd}', spd).replace('{peers}', peers).replace('{pct}', pct);
                }
                // Watchdog: 0 peers + 0% for ~25s and video never started -> dead torrent card
                const playing = el.mainVideo && !el.mainVideo.paused && el.mainVideo.currentTime > 0;
                if (!playing && (stats.peers || 0) === 0 && (stats.progress_pct || 0) === 0) {
                  deadTicks += 1;
                  if (deadTicks >= 25) {
                    clearInterval(state.torrentStatsInterval);
                    state.torrentStatsInterval = null;
                    showVideoErrorStructured({ code: 'NO_PEERS', isMkv, canConvert: isMkv,
                      onConvert: (data.infoHash != null && isMkv) ? () => startMkvAutoConvert(data.infoHash, fileIndex, data.streamUrl) : null });
                  }
                } else {
                  deadTicks = 0;
                }
              }
            } catch (e) {}
          }, 1000);

          updatePlayPauseButton(true);
          return;
        }
      }
    } catch (err) {
      console.warn('[WebTorrent Engine unreachable]', err);
      showVideoErrorStructured({ code: 'ENGINE_UNREACHABLE', isMkv: false, canConvert: false });
      return;
    }
  }

  // 3. Fallback to first remotely-enabled web embed CDN (VidSrc default)
  hidePlayerLoading();
  if (el.hudStatus) el.hudStatus.textContent = t('ui.hudCdn', '⚡ Connected via Fast CDN');
  if (el.hudSpeed) el.hudSpeed.textContent = t('ui.instantStream', '⚡ Instant Stream');
  if (el.hudPeers) el.hudPeers.textContent = t('ui.ready100', '👥 100% Ready');
  if (el.hudProgress) el.hudProgress.textContent = t('ui.fullHd', 'Full HD');

  const embedId = String(media.id);
  const fallbackUrl = firstEnabledEmbedUrl(isSeries, embedId, s, e);

  if (el.mainVideo) {
    el.mainVideo.style.display = 'none';
    el.mainVideo.pause();
    el.mainVideo.removeAttribute('src');
  }
  if (el.mainIframe) {
    el.mainIframe.style.display = 'block';
    el.mainIframe.src = fallbackUrl;
  }

  updatePlayPauseButton(true);
}



function updatePlayPauseButton(isPlaying) {
  if (!el.playerBtnPlay) return;
  el.playerBtnPlay.innerHTML = isPlaying
    ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
    : `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds === null || seconds < 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
  return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

async function loadSubtitlesForPlayer(imdbId, season, episode) {
  try {
    const subs = await invoke('get_subtitles', {
      imdbId,
      season: season ? parseInt(season) : null,
      episode: episode ? parseInt(episode) : null,
    });

    state.subtitles = subs || [];
    if (!el.subtitlesList) return;

    el.subtitlesList.innerHTML = `
      <div class="sub-item active" data-url="">${escapeHtml(t('subtitles.off', 'Off'))}</div>
      ${(subs || [])
        .map(
          (s) => `
        <div class="sub-item" data-url="${s.url}">${escapeHtml(s.language)}</div>
      `
        )
        .join('')}
      <div class="sub-item" data-external="1">📁 ${escapeHtml(t('subtitles.external', 'Load external .srt'))}</div>
    `;

    // Preferred language: settings code (ara/eng/fre) -> track code (ar/en/fr), fallback to app language
    const normPref = String(state.settings.default_subtitle_lang || getSubtitleCode() || 'ara').toLowerCase();
    const normApp = String(getSubtitleCode() || '').toLowerCase();
    const norm = (c) => String(c || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
    const preferred = (subs || []).find((s) => norm(s.language_code) === norm(normPref) || norm(s.language_code).startsWith(norm(normPref).slice(0, 2)))
      || (subs || []).find((s) => norm(s.language_code).startsWith(norm(normApp).slice(0, 2)));
    if (preferred) {
      applySubtitleTrack(preferred.url);
    }

    el.subtitlesList.querySelectorAll('.sub-item').forEach((item) => {
      item.addEventListener('click', () => {
        if (item.dataset.external) {
          openExternalSubtitlePicker();
          return;
        }
        el.subtitlesList.querySelectorAll('.sub-item').forEach((i) => i.classList.remove('active'));
        item.classList.add('active');
        applySubtitleTrack(item.dataset.url);
        if (el.subtitlesMenu) el.subtitlesMenu.classList.remove('open');
      });
    });
  } catch (err) {
    logError('subtitles', err);
    console.warn('Failed to load subtitles:', err);
  }
}

// Load user-provided .srt/.vtt file as a subtitle track (converted to VTT blob in-memory)
let _extSubInput = null;
function openExternalSubtitlePicker() {
  if (!el.mainVideo) return;
  if (!_extSubInput) {
    _extSubInput = document.createElement('input');
    _extSubInput.type = 'file';
    _extSubInput.accept = '.srt,.vtt';
    _extSubInput.style.display = 'none';
    document.body.appendChild(_extSubInput);
    _extSubInput.addEventListener('change', async () => {
      const f = _extSubInput.files && _extSubInput.files[0];
      _extSubInput.value = '';
      if (!f) return;
      try {
        const text = await f.text();
        const vtt = text.trimStart().startsWith('WEBVTT') ? text : ('WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'));
        const blob = new Blob([vtt], { type: 'text/vtt' });
        applySubtitleBlobUrl(URL.createObjectURL(blob));
        try { trackEvent('sub_external_loaded', { name: f.name }); } catch {}
      } catch (e) { logError('sub-external', e); }
    });
  }
  _extSubInput.click();
}

function applySubtitleBlobUrl(blobUrl) {
  if (!el.mainVideo) return;
  el.mainVideo.querySelectorAll('track').forEach((tk) => tk.remove());
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = 'External';
  track.srclang = getCurrentLang();
  track.src = blobUrl;
  track.default = true;
  el.mainVideo.appendChild(track);
  track.mode = 'showing';
}

function applySubtitleTrack(url) {
  if (!el.mainVideo) return;
  const tracks = el.mainVideo.querySelectorAll('track');
  tracks.forEach((t) => t.remove());

  if (!url) return;

  const proxiedUrl = `http://127.0.0.1:${state.serverPort}/proxy/subtitle?url=${encodeURIComponent(url)}`;
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = 'Selected Subtitles';
  track.srclang = 'ar';
  track.src = proxiedUrl;
  track.default = true;

  el.mainVideo.appendChild(track);
  track.mode = 'showing';
}

// ==========================================================================
// Live Radio Engine (الراديو والموسيقى المباشرة)
// ==========================================================================
const RADIO_STATIONS = [
  {
    id: 'rad_mars',
    name: 'Radio Mars (راديو مارس الرياضي)',
    logo: 'https://i.imgur.com/vHq0L9I.png',
    cat: 'sports',
    country: 'morocco',
    country_name: '🇲🇦 Morocco',
    stream_url: 'https://radiomars.ice.infomaniak.ch/radiomars-128.mp3',
    quality: '128 kbps HQ',
    genre: 'Sports & Football',
  },
  {
    id: 'rad_hit',
    name: 'Hit Radio (هيت راديو المغرب)',
    logo: 'https://i.imgur.com/K8n7aLp.png',
    cat: 'morocco',
    country: 'morocco',
    country_name: '🇲🇦 Morocco',
    stream_url: 'https://hitradio-maroc.ice.infomaniak.ch/hitradio-maroc-128.mp3',
    quality: '128 kbps HQ',
    genre: 'Pop & Hits',
  },
  {
    id: 'rad_quran_ma',
    name: 'إذاعة القرآن الكريم (المغرب)',
    logo: 'https://i.imgur.com/4bB9L2I.png',
    cat: 'quran',
    country: 'morocco',
    country_name: '🇲🇦 Morocco',
    stream_url: 'https://cdnamd-hls-globecast.akamaized.net/live/ramdisk/radio_coran/live_abr/radio_coran/radio_coran_96.m3u8',
    quality: '96 kbps HD',
    genre: 'Quran & Recitations',
  },
  {
    id: 'rad_medi1',
    name: 'Medi 1 Radio (إذاعة ميدي 1)',
    logo: 'https://i.imgur.com/3YsZPY6.jpeg',
    cat: 'morocco',
    country: 'morocco',
    country_name: '🇲🇦 Morocco',
    stream_url: 'https://mediradio.ice.infomaniak.ch/mediradio-64.mp3',
    quality: 'HQ Audio',
    genre: 'News & Culture',
  },
  {
    id: 'rad_aswat',
    name: 'Radio Aswat (راديو أصوات)',
    logo: 'https://i.imgur.com/7sH3Z1T.png',
    cat: 'morocco',
    country: 'morocco',
    country_name: '🇲🇦 Morocco',
    stream_url: 'https://aswat.ice.infomaniak.ch/aswat-high.mp3',
    quality: '128 kbps HQ',
    genre: 'Talk & Moroccan Life',
  },
  {
    id: 'rad_chada',
    name: 'Chada FM (شدى إف إم)',
    logo: 'https://i.imgur.com/3YsZPY6.jpeg',
    cat: 'morocco',
    country: 'morocco',
    country_name: '🇲🇦 Morocco',
    stream_url: 'https://chadafm.ice.infomaniak.ch/chadafm-high.mp3',
    quality: '128 kbps HQ',
    genre: 'Music & Variety',
  },
  {
    id: 'rad_mc',
    name: 'Monte Carlo Doualiya (مونت كارلو الدولية)',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/65/France_24_logo.svg/1200px-France_24_logo.svg.png',
    cat: 'arab',
    country: 'arab',
    country_name: '🌴 Arab World',
    stream_url: 'https://montecarlodoualiya128k.ice.infomaniak.ch/mc-doualiya.mp3',
    quality: '128 kbps HQ',
    genre: 'Arab & World News',
  },
  {
    id: 'rad_bbc_ar',
    name: 'BBC Arabic Radio (بي بي سي عربي)',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/eb/BBC.svg/1200px-BBC.svg.png',
    cat: 'arab',
    country: 'arab',
    country_name: '🌴 Arab World',
    stream_url: 'https://stream.live.vc.bbcmedia.co.uk/bbc_arabic_radio',
    quality: '128 kbps HQ',
    genre: 'Global News in Arabic',
  },
  {
    id: 'rad_quran_cairo',
    name: 'إذاعة القرآن الكريم من القاهرة',
    logo: 'https://i.imgur.com/4bB9L2I.png',
    cat: 'quran',
    country: 'arab',
    country_name: '🇪🇬 Egypt',
    stream_url: 'https://stream.radiojar.com/8s5u82pmwtzuv',
    quality: 'HQ Audio',
    genre: 'Holy Quran Broadcast',
  },
  {
    id: 'rad_rotana',
    name: 'Rotana FM (روتانا إف إم)',
    logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f2/Aljazeera_eng.svg/1200px-Aljazeera_eng.svg.png',
    cat: 'arab',
    country: 'arab',
    country_name: '🇸🇦 Saudi Arabia',
    stream_url: 'https://stream.zeno.fm/k2k8u4s2xheuv',
    quality: '128 kbps HQ',
    genre: 'Arabic Music & Hits',
  },
  {
    id: 'rad_lofi',
    name: 'Lofi Girl 24/7 (Relax & Study Beats)',
    logo: 'https://yt3.googleusercontent.com/ytc/AIdro_k68Z2Yf7nN2P5W_2E6lE7g=s900-c-k-c0x00ffffff-no-rj',
    cat: 'lofi',
    country: 'world',
    country_name: '🎧 Global Lofi',
    stream_url: 'https://play.streamafrica.net/lofigirl',
    quality: 'HQ 24/7 Live',
    genre: 'Chillhop & Lofi Beats',
  },
  {
    id: 'rad_chillhop',
    name: 'Chillhop Radio (Jazz & Instrumental)',
    logo: 'https://cdn-icons-png.flaticon.com/512/3075/3075908.png',
    cat: 'lofi',
    country: 'world',
    country_name: '🎧 Ambient',
    stream_url: 'https://streams.fluxfm.de/chillhop/mp3-320/',
    quality: '320 kbps Ultra',
    genre: 'Chillhop & Ambient Jazz',
  },
  {
    id: 'rad_bbc_world',
    name: 'BBC World Service English',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/eb/BBC.svg/1200px-BBC.svg.png',
    cat: 'world',
    country: 'world',
    country_name: '🇬🇧 UK & World',
    stream_url: 'https://stream.live.vc.bbcmedia.co.uk/bbc_world_service',
    quality: '128 kbps HQ',
    genre: 'International News',
  },
  {
    id: 'rad_jazz',
    name: 'Smooth Jazz 24/7 Worldwide',
    logo: 'https://cdn-icons-png.flaticon.com/512/857/857455.png',
    cat: 'world',
    country: 'world',
    country_name: '🎷 Global Jazz',
    stream_url: 'https://smoothjazz.cdnstream1.com/2585_128.mp3',
    quality: '128 kbps HQ',
    genre: 'Smooth Jazz & Soul',
  },
  {
    id: 'rad_rock',
    name: 'Classic Rock 100 FM',
    logo: 'https://cdn-icons-png.flaticon.com/512/3075/3075908.png',
    cat: 'world',
    country: 'world',
    country_name: '🎸 Classic Rock',
    stream_url: 'https://stream.zeno.fm/46g736p128quv',
    quality: '128 kbps HQ',
    genre: '70s & 80s Rock Hits',
  },
];

async function loadRadioContent(cat = state.activeRadioCat) {
  if (!el.radioGrid) return;
  state.activeRadioCat = cat;

  let list = RADIO_STATIONS;
  if (cat !== 'all') {
    list = list.filter((s) => s.cat === cat || s.country === cat);
  }

  el.radioGrid.innerHTML = list.map((st) => `
    <div class="radio-card" data-radio-id="${st.id}">
      <img class="radio-avatar" src="${st.logo}" alt="${st.name}" onerror="this.src='https://cdn-icons-png.flaticon.com/512/3075/3075908.png'" />
      <div class="radio-info">
        <div class="radio-title" title="${st.name}">${st.name}</div>
        <div class="radio-meta">
          <span>${st.country_name}</span>
          <span>•</span>
          <span style="color: #8b5cf6; font-weight: 600;">${st.genre}</span>
        </div>
        <div style="font-size: 0.72rem; color: #22c55e; margin-top: 2px;">● LIVE (${st.quality})</div>
      </div>
      <div class="radio-play-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </div>
    </div>
  `).join('');

  el.radioGrid.querySelectorAll('.radio-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.radioId;
      const station = RADIO_STATIONS.find((s) => s.id === id);
      if (station) playRadioStation(station);
    });
  });
}

function playRadioStation(station) {
  state.activeStream = {
    resolution: station.quality,
    quality: t('ui.liveBroadcast', 'Live Broadcast'),
    provider: t('ui.liveAudio', 'Live Audio'),
    size_formatted: t('ui.liveBroadcast', 'Live Broadcast'),
  };

  if (!el.playerView) return;
  el.playerView.classList.add('active');

  if (el.playerMediaTitle) el.playerMediaTitle.textContent = `📻 ${station.name}`;
  if (el.playerStreamStats) el.playerStreamStats.textContent = `${station.country_name} • ${station.genre} • ${t('ui.liveAudio', 'Live Audio')}`;

  if (el.hudStatus) el.hudStatus.textContent = t('ui.hudRadio', '📻 Playing Live Radio');
  if (el.hudSpeed) el.hudSpeed.textContent = `⚡ Audio: ${station.quality}`;
  if (el.hudPeers) el.hudPeers.textContent = '👥 24/7 Live Feed';
  if (el.hudProgress) el.hudProgress.textContent = t('ui.liveBroadcast', 'Live Broadcast');

  if (el.mainIframe) {
    el.mainIframe.style.display = 'none';
    el.mainIframe.src = 'about:blank';
  }

  if (el.mainVideo) {
    el.mainVideo.style.display = 'block';
    el.mainVideo.src = station.stream_url;
    el.mainVideo.load();
    el.mainVideo.play().catch((e) => console.log('Radio playback notice:', e));
  }

  // Mini-player for background audio
  state.isRadio = true;
  if (el.miniPlayer) {
    el.miniPlayer.style.display = 'none';
  }

  updatePlayPauseButton(true);
}

function showMiniPlayer(title, sub) {
  if (!el.miniPlayer) return;
  if (el.miniPlayerTitle) el.miniPlayerTitle.textContent = title;
  if (el.miniPlayerSub) el.miniPlayerSub.textContent = sub;
  el.miniPlayer.style.display = 'flex';
  if (el.miniPlayerPlay) el.miniPlayerPlay.textContent = el.mainVideo && el.mainVideo.paused ? '▶' : '⏸';
}

function hideMiniPlayer() {
  if (el.miniPlayer) el.miniPlayer.style.display = 'none';
}

// ==========================================================================
// YouTube Shows & Creators Engine (يوتيوب وبودكاست)
// ==========================================================================
const YOUTUBE_ITEMS = [
  {
    id: 'yt_1',
    title: 'MrBeast - $1,000,000 Ultimate Survival Island Challenge',
    channel: 'MrBeast',
    cat: 'trending',
    duration: '24:18',
    views: '84M views',
    thumb: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=600&auto=format&fit=crop&q=80',
    video_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  },
  {
    id: 'yt_2',
    title: 'MKBHD - The Future of Smartphone Tech & Next Gen AI',
    channel: 'Marques Brownlee',
    cat: 'tech',
    duration: '18:42',
    views: '4.2M views',
    thumb: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=600&auto=format&fit=crop&q=80',
    video_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
  },
  {
    id: 'yt_3',
    title: 'The Joe Rogan Experience - Elon Musk on Mars & Space Travel',
    channel: 'PowerfulJRE',
    cat: 'podcasts',
    duration: '2:45:10',
    views: '19M views',
    thumb: 'https://images.unsplash.com/photo-1590602847861-f357a9332bbc?w=600&auto=format&fit=crop&q=80',
    video_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  },
  {
    id: 'yt_4',
    title: 'Avengers: Secret Wars (2026) - Official First Look Teaser Trailer',
    channel: 'Marvel Entertainment',
    cat: 'trailers',
    duration: '02:50',
    views: '32M views',
    thumb: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600&auto=format&fit=crop&q=80',
    video_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  },
  {
    id: 'yt_5',
    title: 'National Geographic - Secrets of the Deep Blue Ocean HD',
    channel: 'National Geographic',
    cat: 'documentaries',
    duration: '52:10',
    views: '12M views',
    thumb: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=600&auto=format&fit=crop&q=80',
    video_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
  },
  {
    id: 'yt_6',
    title: 'GTA VI - 50 Amazing Hidden Details & Next Gen Mechanics',
    channel: 'IGN',
    cat: 'gaming',
    duration: '16:04',
    views: '8.7M views',
    thumb: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=600&auto=format&fit=crop&q=80',
    video_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyBlazes.mp4',
  },
  {
    id: 'yt_7',
    title: 'Finjian Podcast (فنجان) - أسرار النجاح وبناء الثروة وتطوير الذات',
    channel: 'ثمانية / Thmanyah',
    cat: 'podcasts',
    duration: '1:38:20',
    views: '6.4M views',
    thumb: 'https://images.unsplash.com/photo-1478737270239-2f02b77fc618?w=600&auto=format&fit=crop&q=80',
    video_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
  },
  {
    id: 'yt_8',
    title: 'Spider-Man: Beyond Worlds - Official 4K Cinema Trailer',
    channel: 'Sony Pictures',
    cat: 'trailers',
    duration: '03:12',
    views: '28M views',
    thumb: 'https://images.unsplash.com/photo-1635805737707-575885ab0820?w=600&auto=format&fit=crop&q=80',
    video_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
  },
  {
    id: 'yt_9',
    title: 'Kurzgesagt – What If We Built a Dyson Sphere Around the Sun?',
    channel: 'Kurzgesagt – In a Nutshell',
    cat: 'tech',
    duration: '14:25',
    views: '15M views',
    thumb: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=600&auto=format&fit=crop&q=80',
    video_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackSeeTheWorld.mp4',
  },
];

async function loadYoutubeContent(cat = state.activeYoutubeCat) {
  if (!el.youtubeGrid) return;
  state.activeYoutubeCat = cat;

  let list = YOUTUBE_ITEMS;
  if (cat !== 'trending') {
    list = list.filter((y) => y.cat === cat);
  }

  el.youtubeGrid.innerHTML = list.map((item) => `
    <div class="yt-card" data-yt-id="${item.id}">
      <div class="yt-thumb-wrap">
        <img class="yt-thumb" src="${item.thumb}" alt="${item.title}" />
        <span class="yt-duration-badge">${item.duration}</span>
      </div>
      <div class="yt-card-body">
        <div class="yt-card-title" title="${item.title}">${item.title}</div>
        <div class="yt-card-meta">
          <span style="font-weight: 600; color: white;">${item.channel}</span>
          <span>•</span>
          <span>${item.views}</span>
        </div>
      </div>
    </div>
  `).join('');

  el.youtubeGrid.querySelectorAll('.yt-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.ytId;
      const item = YOUTUBE_ITEMS.find((y) => y.id === id);
      if (item) playYoutubeItem(item);
    });
  });
}

function playYoutubeItem(item) {
  state.activeStream = {
    resolution: '1080p FHD',
    quality: t('ui.ytQuality', 'YouTube HD Stream'),
    provider: item.channel,
    size_formatted: 'YouTube',
  };

  if (!el.playerView) return;
  el.playerView.classList.add('active');

  if (el.playerMediaTitle) el.playerMediaTitle.textContent = `📺 ${item.title}`;
  if (el.playerStreamStats) el.playerStreamStats.textContent = `${item.channel} • ${item.views} • ${t('ui.fullHd', 'Full HD')}`;

  if (el.hudStatus) el.hudStatus.textContent = t('ui.hudYoutube', '📺 Playing YouTube HD');
  if (el.hudSpeed) el.hudSpeed.textContent = '⚡ 1080p 60FPS Direct';
  if (el.hudPeers) el.hudPeers.textContent = '👥 YouTube Creators';
  if (el.hudProgress) el.hudProgress.textContent = item.duration;

  if (el.mainIframe) {
    el.mainIframe.style.display = 'none';
    el.mainIframe.src = 'about:blank';
  }

  if (el.mainVideo) {
    el.mainVideo.style.display = 'block';
    el.mainVideo.src = item.video_url;
    el.mainVideo.load();
    el.mainVideo.play().catch((e) => console.log('YouTube playback notice:', e));
  }

  updatePlayPauseButton(true);
}

// ==========================================================================
// Twitch & Kick Live Gaming Streams (تويتش وبثوث الألعاب)
// ==========================================================================
const TWITCH_STREAMS = [
  {
    id: 'tw_1',
    title: '🏆 Twitch Rivals: $500,000 Global Championship Finals Live',
    streamer: 'TwitchRivals',
    cat: 'esports',
    game: 'eSports Arena',
    viewers: '142,500',
    thumb: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=600&auto=format&fit=crop&q=80',
    stream_url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
  },
  {
    id: 'tw_2',
    title: '⛏️ Minecraft Ultimate Survival SMP 24/7 - 100 Streamers World',
    streamer: 'MinecraftLive',
    cat: 'minecraft',
    game: 'Minecraft',
    viewers: '89,200',
    thumb: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=600&auto=format&fit=crop&q=80',
    stream_url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
  },
  {
    id: 'tw_3',
    title: '🚗 NoPixel 4.0 - Master Heist & High Speed Police Pursuits',
    streamer: 'Buddha',
    cat: 'gtav',
    game: 'Grand Theft Auto V',
    viewers: '65,800',
    thumb: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=600&auto=format&fit=crop&q=80',
    stream_url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
  },
  {
    id: 'tw_4',
    title: '🎯 VCT Champions 2026 - Lower Bracket Final Live in 1080p 60FPS',
    streamer: 'VALORANT',
    cat: 'fps',
    game: 'VALORANT',
    viewers: '115,000',
    thumb: 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=600&auto=format&fit=crop&q=80',
    stream_url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
  },
  {
    id: 'tw_5',
    title: '⚽ EA Sports FC 26 Global Open - Pro Ultimate Team Grand Final',
    streamer: 'EASPORTSFC',
    cat: 'sports',
    game: 'EA Sports FC 26',
    viewers: '74,400',
    thumb: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=600&auto=format&fit=crop&q=80',
    stream_url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
  },
  {
    id: 'tw_6',
    title: '💬 Late Night Hangout, Chat Q&A, and Reacting to Crazy Videos',
    streamer: 'KaiCenat',
    cat: 'chatting',
    game: 'Just Chatting',
    viewers: '98,000',
    thumb: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=600&auto=format&fit=crop&q=80',
    stream_url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
  },
];

async function loadTwitchContent(cat = state.activeTwitchCat) {
  if (!el.twitchGrid) return;
  state.activeTwitchCat = cat;

  let list = TWITCH_STREAMS;
  if (cat !== 'esports') {
    list = list.filter((t) => t.cat === cat);
  }

  el.twitchGrid.innerHTML = list.map((stream) => `
    <div class="twitch-card" data-twitch-id="${stream.id}">
      <div class="twitch-thumb-wrap">
        <img class="twitch-thumb" src="${stream.thumb}" alt="${stream.title}" />
        <span class="twitch-live-badge">● LIVE 🔴</span>
      </div>
      <div class="twitch-card-body">
        <div class="twitch-card-title" title="${stream.title}">${stream.title}</div>
        <div class="twitch-card-meta">
          <span style="font-weight: 600; color: #a855f7;">${stream.streamer}</span>
          <span>•</span>
          <span style="color: var(--accent-cyan);">${stream.game}</span>
          <span>•</span>
          <span style="color: #ef4444; font-weight: 700;">👥 ${stream.viewers}</span>
        </div>
      </div>
    </div>
  `).join('');

  el.twitchGrid.querySelectorAll('.twitch-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.twitchId;
      const stream = TWITCH_STREAMS.find((t) => t.id === id);
      if (stream) playTwitchStream(stream);
    });
  });
}

function playTwitchStream(stream) {
  state.activeStream = {
    resolution: '1080p 60FPS',
    quality: 'Twitch Live HD',
    provider: stream.streamer,
    size_formatted: 'Live Gaming',
  };

  if (!el.playerView) return;
  el.playerView.classList.add('active');

  if (el.playerMediaTitle) el.playerMediaTitle.textContent = `🎮 ${stream.title}`;
  if (el.playerStreamStats) el.playerStreamStats.textContent = `${stream.streamer} • ${stream.game} • 1080p 60FPS`;

  if (el.hudStatus) el.hudStatus.textContent = t('ui.hudTwitch', '🎮 Streaming Twitch Live');
  if (el.hudSpeed) el.hudSpeed.textContent = '⚡ 1080p 60FPS';
  if (el.hudPeers) el.hudPeers.textContent = t('ui.viewersTpl', '👥 {n} viewers').replace('{n}', stream.viewers);
  if (el.hudProgress) el.hudProgress.textContent = t('ui.liveBroadcast', 'Live Broadcast');

  if (el.mainIframe) {
    el.mainIframe.style.display = 'none';
    el.mainIframe.src = 'about:blank';
  }

  if (el.mainVideo) {
    el.mainVideo.style.display = 'block';
    el.mainVideo.src = stream.stream_url;
    el.mainVideo.load();
    el.mainVideo.play().catch((e) => console.log('Twitch playback notice:', e));
  }

  updatePlayPauseButton(true);
}

// ==========================================================================
// Add-ons Management & Marketplace
// ==========================================================================
const FEATURED_COMMUNITY_ADDONS = [
  {
    id: 'community.youtube',
    name: '📺 YouTube Trending & Creators',
    description: 'Discover trending videos, podcasts, top creator channels, trailers, and documentaries with HD playback.',
    manifest_url: 'https://v3-cinemeta.strem.fun/manifest.json',
    badge: 'Social & Videos',
    icon: 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Youtube_logo.png',
  },
  {
    id: 'community.twitch',
    name: '🎮 Twitch & Kick Live Gaming',
    description: 'Watch live gaming streams, eSports tournaments, Just Chatting, and top Kick streamers in 1080p 60FPS.',
    manifest_url: 'https://twitch.strem.fun/manifest.json',
    badge: 'Gaming & Live',
    icon: 'https://assets.stickpng.com/images/580b57fcd9996e24bc43c540.png',
  },
  {
    id: 'community.radio-global',
    name: '📻 Global Live Radio & Stations',
    description: 'Listen live to 1,000+ worldwide stations (Radio Mars ⚽, Hit Radio, Quran Karim, Medi 1, BBC, Lofi Beats).',
    manifest_url: 'https://iptv-org.github.io/iptv/categories/music.m3u',
    badge: 'Audio & Music',
    icon: 'https://cdn-icons-png.flaticon.com/512/3075/3075908.png',
  },
  {
    id: 'community.torrentio',
    name: '⚡ Torrentio Multi-Scraper VIP',
    description: 'Scrapes torrent streams from multi-trackers (YTS, EZTV, RARBG, 1337x, ThePirateBay) with 4K HDR & Real-Debrid.',
    manifest_url: 'https://torrentio.strem.fun/manifest.json',
    badge: '4K Streams',
    icon: 'https://torrentio.strem.fun/logo.png',
  },
  {
    id: 'community.cyberflix',
    name: '🍿 CyberFlix Catalogs (Netflix & Prime)',
    description: 'Full catalogs for Netflix, Apple TV+, Disney+, HBO Max, Paramount+, and Amazon Prime Video.',
    manifest_url: 'https://cyberflix.elfhosted.com/c/catalogs/manifest.json',
    badge: 'Catalogs',
    icon: 'https://i.imgur.com/7sH3Z1T.png',
  },
  {
    id: 'community.anime-kitsu',
    name: '🎌 Anime Kitsu & Tosho Multi-Addon',
    description: 'Complete anime catalogs and multi-tracker streams powered by Kitsu and AnimeTosho.',
    manifest_url: 'https://anime-kitsu.strem.fun/manifest.json',
    badge: 'Anime HD',
    icon: 'https://anime-kitsu.strem.fun/logo.png',
  },
  {
    id: 'community.opensubtitles-v3',
    name: '💬 OpenSubtitles v3 Multilingual',
      description: 'Official OpenSubtitles provider: Arabic, English, French, Spanish + 50 languages.',
    manifest_url: 'https://opensubtitles-v3.strem.fun/manifest.json',
    badge: 'Subtitles',
    icon: 'https://opensubtitles-v3.strem.fun/logo.png',
  },
  {
    id: 'livetv.arab-mega',
    name: '🌴 Arab World & Nilesat Mega TV',
    description: 'Morocco, Egypt, Saudi Arabia, UAE, Algeria, Tunisia, Qatar channels (MBC, Rotana, Al Jazeera, Dubai, 2M).',
    manifest_url: 'https://iptv-org.github.io/iptv/languages/ara.m3u',
    badge: 'Live TV',
    icon: 'https://cdn-icons-png.flaticon.com/512/321/321238.png',
  },
  {
    id: 'livetv.sports-mega',
    name: '⚽ Global Sports Arena HD',
    description: 'Live broadcast feeds for football, motorsports, extreme combat, and international sports arenas.',
    manifest_url: 'https://iptv-org.github.io/iptv/categories/sports.m3u',
    badge: 'Sports Live',
    icon: 'https://cdn-icons-png.flaticon.com/512/857/857455.png',
  },
];

async function loadAddons() {
  try {
    const addons = await invoke('get_addons');
    state.addons = addons || [];
    if (el.addonsCount) el.addonsCount.textContent = state.addons.length;
    renderFeaturedAddonsGrid();
    renderAddonsList();
  } catch (e) {
    console.warn('Failed to load addons:', e);
  }
}

function renderFeaturedAddonsGrid() {
  if (!el.featuredAddonsGrid) return;

  el.featuredAddonsGrid.innerHTML = FEATURED_COMMUNITY_ADDONS.map((feat) => {
    const installed = state.addons.find((a) => a.id === feat.id || a.manifest_url === feat.manifest_url);
    const isInstalled = !!installed;
    const isEnabled = installed ? installed.enabled : false;

    const actionButton = isInstalled
      ? `<button class="btn-secondary btn-feat-toggle" data-id="${installed.id}" style="padding: 6px 12px; font-size: 0.8rem; ${isEnabled ? 'border-color: #22c55e; color: #22c55e;' : ''}">
          ${isEnabled ? t('ui.addonActive', '✅ Active') : t('ui.addonEnable', 'Enable')}
        </button>`
      : `<button class="btn-primary btn-feat-install" data-url="${feat.manifest_url}" style="padding: 6px 12px; font-size: 0.8rem; background: var(--accent-gradient);">
          ${escapeHtml(t('ui.addonInstall', '⚡ Install'))}
        </button>`;

    return `
      <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-glass); border-radius: var(--radius-md); padding: 14px; display: flex; flex-direction: column; justify-content: space-between; gap: 10px;">
        <div style="display: flex; gap: 12px; align-items: flex-start;">
          <div style="width: 42px; height: 42px; border-radius: var(--radius-sm); background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden; padding: 4px;">
            <img src="${feat.icon}" alt="${feat.name}" style="width: 100%; height: 100%; object-fit: contain;" onerror="this.src='https://cdn-icons-png.flaticon.com/512/3075/3075908.png'" />
          </div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 700; font-size: 0.9rem; margin-bottom: 2px;">${feat.name}</div>
            <div style="display: inline-block; font-size: 0.7rem; font-weight: 700; color: var(--accent-cyan); background: rgba(6,182,212,0.12); padding: 1px 6px; border-radius: 4px; margin-bottom: 4px;">${feat.badge}</div>
            <div style="font-size: 0.78rem; color: var(--text-muted); line-height: 1.3;">${feat.description}</div>
          </div>
        </div>
        <div style="display: flex; justify-content: flex-end; margin-top: 4px;">
          ${actionButton}
        </div>
      </div>
    `;
  }).join('');

  el.featuredAddonsGrid.querySelectorAll('.btn-feat-install').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const url = btn.dataset.url;
      const feat = FEATURED_COMMUNITY_ADDONS.find((f) => f.manifest_url === url);
      try {
        btn.textContent = t('ui.checking', '⏳ Checking...');
        if (feat) {
          await invoke('add_custom_addon', {
            addon: {
              id: feat.id,
              name: feat.name,
              description: feat.description,
              version: '1.0.0',
              manifest_url: feat.manifest_url,
              icon: feat.icon,
              types: ['movie', 'series', 'tv', 'anime'],
              enabled: true,
            },
          });
        } else {
          await invoke('install_addon_from_manifest', { manifestUrl: url });
        }
        await loadAddons();
      } catch (err) {
        btn.textContent = t('ui.addonInstall', '⚡ Install');
        alert(t('dlg.addonFail', 'Failed to install addon: ')+err);
      }
    });
  });

  el.featuredAddonsGrid.querySelectorAll('.btn-feat-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      await invoke('toggle_addon', { addonId: id });
      await loadAddons();
    });
  });
}

function renderAddonsList() {
  if (!el.installedAddonsList) return;
  el.installedAddonsList.innerHTML = state.addons
    .map(
      (a) => `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-glass); border-radius: var(--radius-md);">
        <div style="display: flex; align-items: center; gap: 14px;">
          <div style="width: 38px; height: 38px; border-radius: var(--radius-sm); background: rgba(229, 9, 20, 0.15); display: flex; align-items: center; justify-content: center; font-weight: 800; color: #ff5252;">
            🧩
          </div>
          <div>
            <div style="font-weight: 700; font-size: 0.95rem;">${a.name} <span style="font-size: 0.75rem; color: var(--text-muted);">v${a.version}</span></div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); max-width: 480px;">${a.description}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 0.78rem; padding: 3px 8px; border-radius: var(--radius-sm); background: ${a.enabled ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}; color: ${a.enabled ? '#22c55e' : '#ef4444'};">
            ${a.enabled ? t('ui.addonActive', '✅ Active') : t('ui.addonDisabled', 'Disabled')}
          </span>
          <button class="btn-secondary btn-toggle-addon" data-id="${a.id}" style="padding: 6px 12px; font-size: 0.8rem;">
            ${a.enabled ? t('ui.addonDisable', 'Disable') : t('ui.addonEnable', 'Enable')}
          </button>
        </div>
      </div>
    `
    )
    .join('');

  el.installedAddonsList.querySelectorAll('.btn-toggle-addon').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      await invoke('toggle_addon', { addonId: id });
      await loadAddons();
    });
  });
}

// ==========================================================================
// Watchlist & Settings
// ==========================================================================
async function loadWatchlist() {
  try {
    const list = await invoke('get_watchlist');
    state.watchlist = list || [];
    if (el.watchlistCount) el.watchlistCount.textContent = state.watchlist.length;
    if (el.watchlistGrid) renderGrid(el.watchlistGrid, state.watchlist);
  } catch (e) {
    console.error('Error loading watchlist:', e);
  }
}

// ==========================================================================
// Downloads & Offline Watch Engine
// ==========================================================================
async function loadDownloads() {
  try {
    const list = await invoke('get_downloads');
    state.downloads = list || [];
    const activeCount = state.downloads.filter((d) => d.status === 'downloading').length;
    if (el.downloadsCount) {
      if (activeCount > 0) {
        el.downloadsCount.textContent = activeCount;
        el.downloadsCount.style.display = 'inline-block';
      } else {
        el.downloadsCount.style.display = 'none';
      }
    }
    renderDownloadsGrid();

    // Auto-transcode check for already completed mkv on initial load
    try {
      const autoList = state.downloads.filter(d=> d.status==='completed' && d.file_path && d.file_path.toLowerCase().endsWith('.mkv') && state.settings.auto_transcode && !autoTranscodedIds.has(d.id));
      for (const it of autoList) {
        autoTranscodedIds.add(it.id);
        const out = it.file_path.replace(/\.mkv$/i,'.mp4');
        invoke('transcode_video', { inputPath: it.file_path, outputPath: out }).then(()=>{ trackEvent('auto_transcode', {id:it.id}); loadDownloads(); }).catch(()=>{});
      }
    } catch {}
    // Start background poll if downloading
    if (activeCount > 0 && !state.downloadPollInterval) {
      state.downloadPollInterval = setInterval(async () => {
        const updated = await invoke('get_downloads');
        state.downloads = updated || [];
        // Auto-transcode newly completed MKV → MP4 (if enabled)
        try {
          for (const it of (updated||[])) {
            if (it.status==='completed' && it.file_path && it.file_path.toLowerCase().endsWith('.mkv') && state.settings.auto_transcode && !autoTranscodedIds.has(it.id)) {
              autoTranscodedIds.add(it.id);
              const out = it.file_path.replace(/\.mkv$/i,'.mp4');
              invoke('check_ffmpeg').then(()=> invoke('transcode_video', { inputPath: it.file_path, outputPath: out }).then(()=>{ trackEvent('auto_transcode', {id:it.id}); loadDownloads(); }).catch(()=>{})).catch(()=>{});
            }
          }
        } catch {}
        const stillActive = state.downloads.filter((d) => d.status === 'downloading').length;
        if (el.downloadsCount) {
          if (stillActive > 0) {
            el.downloadsCount.textContent = stillActive;
            el.downloadsCount.style.display = 'inline-block';
          } else {
            el.downloadsCount.style.display = 'none';
          }
        }
        if (state.currentView === 'downloads') {
          renderDownloadsGrid();
        }
        if (stillActive === 0 && state.downloadPollInterval) {
          clearInterval(state.downloadPollInterval);
          state.downloadPollInterval = null;
        }
      }, 1500);
    }
  } catch (e) {
    console.error('Error loading downloads:', e);
  }
}

function renderDownloadsGrid() {
  if (!el.downloadsGrid) return;

  // Quota bar
  try {
    const totalBytes = state.downloads.reduce((a,d)=>a+(d.file_size||0),0);
    const totalGB = (totalBytes/(1024*1024*1024)).toFixed(2);
    const quotaGB = 100;
    const pct = Math.min(100, (totalBytes/(quotaGB*1024*1024*1024))*100);
    const quotaText = document.getElementById('downloads-quota-text');
    const quotaFill = document.getElementById('downloads-quota-fill');
    if (quotaText) quotaText.textContent = t('ui.dlQuota', '{u} GB / {q} GB • {n} files').replace('{u}', totalGB).replace('{q}', quotaGB).replace('{n}', state.downloads.length);
    if (quotaFill) quotaFill.style.width = `${pct}%`;
  } catch {}

  let filtered = state.downloads;
  if (state.activeDownloadFilter === 'completed') {
    filtered = filtered.filter((d) => d.status === 'completed');
  } else if (state.activeDownloadFilter === 'downloading') {
    filtered = filtered.filter((d) => d.status === 'downloading');
  }

  if (filtered.length === 0) {
    el.downloadsGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--text-muted);">
        <div style="font-size: 3rem; margin-bottom: 12px;">📥</div>
        <div style="font-size: 1.1rem; font-weight: 700; color: white; margin-bottom: 6px;">${escapeHtml(t('ui.noDownloadsTitle', 'No Downloads Yet'))}</div>
        <div style="font-size: 0.85rem;">${escapeHtml(t('ui.noDownloadsDesc', 'Click the Download button on any stream to save it for offline watching!'))}</div>
      </div>
    `;
    return;
  }

  el.downloadsGrid.innerHTML = filtered.map((d) => {
    const poster = d.poster_url || 'https://via.placeholder.com/300x450/1e293b/ffffff?text=No+Poster';
    const isCompleted = d.status === 'completed';
    const isDownloading = d.status === 'downloading';
    const isError = d.status === 'error';

    const statusBadge = isCompleted
      ? '<span style="color: #22c55e; font-weight: 700;">✅ Offline Ready</span>'
      : isDownloading
      ? `<span style="color: var(--accent-cyan); font-weight: 700;">⏳ Downloading (${(d.progress || 0).toFixed(0)}%)</span>`
      : '<span style="color: #ef4444; font-weight: 700;">❌ Error</span>';

    const sizeFormatted = d.file_size > 0 ? `${(d.file_size / (1024 * 1024 * 1024)).toFixed(2)} GB` : t('ui.dlCalc', 'Calculating...');
    const errHint = isError ? `<div style="font-size:.75rem;color:#f87171;margin-top:6px;">${escapeHtml(localizeDownloadError(d.download_speed))}</div>` : '';

    return `
      <div class="download-card" data-dl-id="${d.id}">
        <div class="download-card-header">
          <img class="download-card-poster" src="${poster}" alt="${d.title}" />
          <div class="download-card-details">
            <div class="download-card-title" title="${d.title}">${d.title}</div>
            <div class="download-card-meta">
              <span>${statusBadge}</span>
              <span>•</span>
              <span>💾 ${sizeFormatted}</span>
            </div>
          </div>
        </div>

        <div class="download-progress-box">
          <div class="download-progress-bar">
            <div class="download-progress-fill" style="width: ${d.progress || 0}%;"></div>
          </div>
          <div class="download-stats-row">
            <span>${isCompleted ? escapeHtml(t('ui.dlSaved', 'Saved Locally')) : escapeHtml(d.download_speed || t('ui.dlStarting', 'Starting...'))}</span>
            <span>${d.progress ? d.progress.toFixed(1) : '0'}%</span>
          </div>
          ${errHint}
        </div>

        <div class="download-card-actions">
          ${isError ? `
            <button class="btn-primary btn-retry-dl" data-dl-retry="${d.id}" style="flex: 1; padding: 6px 10px; font-size: 0.8rem;">
              ↻ ${escapeHtml(t('downloads.retry', 'Retry'))}
            </button>
          ` : ''}
          ${isCompleted ? `
            <button class="btn-primary btn-play-offline" data-dl-play="${d.id}" style="flex: 1; padding: 6px 10px; font-size: 0.8rem; display: flex; align-items: center; justify-content: center; gap: 6px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <span>${escapeHtml(t('ui.playOffline', 'Play Offline'))}</span>
            </button>
            <button class="btn-secondary btn-vlc-offline" data-dl-vlc="${d.id}" title="${escapeHtml(t('ui.openVlcTitle', 'Play in VLC'))}" style="padding: 6px 10px; font-size: 0.8rem;">
              VLC
            </button>
            ${d.file_path && d.file_path.toLowerCase().endsWith('.mkv') ? `<button class="btn-secondary btn-transcode" data-dl-trans="${d.id}" title="${escapeHtml(t('player.convert', 'Convert MKV→MP4'))}" style="padding:6px 8px; font-size:0.75rem; background:rgba(168,85,247,0.15); border-color:rgba(168,85,247,0.3); color:#c084fc;">♻️ MP4</button>` : ''}
            <button class="btn-secondary btn-repair-dl" data-dl-repair="${d.id}" title="${escapeHtml(t('ui.repairTitle', 'Repair file type'))}" style="padding: 6px 10px; font-size: 0.8rem;">
              🔧
            </button>
          ` : ''}
          <button class="btn-secondary btn-delete-dl" data-dl-del="${d.id}" title="${escapeHtml(t('ui.deleteFile', 'Delete file'))}" style="padding: 6px 10px; font-size: 0.8rem; color: #ef4444; border-color: rgba(239,68,68,0.3);">
            🗑️
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Click handler for Play Offline
  el.downloadsGrid.querySelectorAll('.btn-play-offline').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.dlPlay;
      const item = state.downloads.find((d) => d.id === id);
      if (item) playOfflineVideo(item);
    });
  });

  // Click handler for VLC Offline
  el.downloadsGrid.querySelectorAll('.btn-vlc-offline').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.dlVlc;
      const item = state.downloads.find((d) => d.id === id);
      if (item && item.file_path) {
        try {
          await invoke('open_in_vlc', { streamUrl: item.file_path });
        } catch (vlcErr) {
          console.error('VLC offline play error:', vlcErr);
        }
      }
    });
  });

  // Transcode MKV→MP4
  el.downloadsGrid.querySelectorAll('.btn-transcode').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const id=btn.dataset.dlTrans;
      const item=state.downloads.find(d=>d.id===id);
      if(!item) return;
      const out = item.file_path.replace(/\.mkv$/i,'.mp4');
      btn.textContent='⏳...';
      try{ const r=await invoke('transcode_video', { inputPath: item.file_path, outputPath: out }); alert(t('dlg.transcoded', 'Transcoded: ')+r); await loadDownloads(); }catch(err){ alert(t('dlg.transcodeFail', 'Transcode failed — try VLC instead')); btn.textContent='♻️ MP4'; }
    });
  });

  // Click handler for Repair (fix old files saved with the wrong extension)
  el.downloadsGrid.querySelectorAll('.btn-repair-dl').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.dlRepair;
      btn.textContent = '⏳...';
      try {
        const r = await invoke('repair_download_container', { id });
        if (String(r).startsWith('OK:')) alert(t('dlg.repairNone', '✅ File type is already correct'));
        else { alert(t('dlg.repairOk', '✅ Repaired! Try playing it now.')); }
        await loadDownloads();
      } catch (err) {
        logError('dl-repair', err);
        alert(t('dlg.repairFail', 'Repair failed: ') + err);
        await loadDownloads();
      }
    });
  });

  // Click handler for Delete Download
  el.downloadsGrid.querySelectorAll('.btn-delete-dl').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.dlDel;
      if (confirm(t('downloads.deleteConfirm', 'Delete this downloaded video from your disk?'))) {
        await invoke('delete_download', { id });
        await loadDownloads();
      }
    });
  });

  // Click handler for Retry (re-resolve source, then download again)
  el.downloadsGrid.querySelectorAll('.btn-retry-dl').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.dlRetry;
      const item = state.downloads.find((d) => d.id === id);
      if (!item) return;
      btn.textContent = '⏳...';
      try {
        const src = await resolveDownloadSource({ stream_url: item.stream_url, magnet_uri: item.magnet_uri });
        await invoke('delete_download', { id: item.id });
        await invoke('start_download', { item: {
          ...item,
          id: `dl_${item.media_id}_${item.season || 0}_${item.episode || 0}_${Date.now()}`,
          file_path: '', file_size: src.size || 0, downloaded_bytes: 0, progress: 0.0,
          download_speed: 'Starting...', status: 'downloading',
          stream_url: src.url, file_name: src.fileName || item.file_name || null,
          date_added: Math.floor(Date.now() / 1000),
        } });
        await loadDownloads();
      } catch (err) {
        logError('dl-retry', err);
        alert('⚠️ ' + t('downloads.retryFailed', 'Still no working source. Try a different stream.'));
        await loadDownloads();
      }
    });
  });
}

// Lazy ffmpeg installer shared by the Convert flows and the Diagnostics button.
// URL: remote endpoints.ffmpeg_url override, gyan.dev default otherwise.
async function downloadFfmpegOnDemand() {
  let url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
  try {
    if (window.RemoteControl) {
      const v = window.RemoteControl.get('endpoints.ffmpeg_url', '');
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) url = v;
    }
  } catch {}
  return invoke('download_ffmpeg', { url });
}

// Map technical Rust download errors to one-language user messages
function localizeDownloadError(raw) {
  const s = String(raw || '');
  const L = getCurrentLang();
  if (/stalled|0 peers|dead/i.test(s)) {
    return L === 'ar' ? 'توقف 3 دقائق بلا مشاركين — التورنت ميت، جرّب مصدرا آخر'
      : L === 'fr' ? 'Bloqué 3 min sans sources — torrent mort, essayez une autre source'
      : 'Stalled 3 min with no peers — torrent is dead, try another source';
  }
  if (/server replied|404/i.test(s)) {
    return L === 'ar' ? 'السيرفر رفض التحميل — التورنت ميت على الأغلب'
      : L === 'fr' ? 'Serveur a refusé — torrent probablement mort'
      : 'Server refused — torrent is probably dead';
  }
  if (/no stream source|engine/i.test(s)) {
    return L === 'ar' ? 'محرك التورنت لا يعمل — أعد تشغيل التطبيق'
      : L === 'fr' ? 'Moteur torrent injoignable — redémarrez'
      : 'Torrent engine unreachable — restart the app';
  }
  if (/timed out|timeout/i.test(s)) {
    return L === 'ar' ? 'انتهت المهلة — تحقق من الإنترنت وحاول مجددا'
      : L === 'fr' ? 'Délai dépassé — vérifiez internet et réessayez'
      : 'Timed out — check internet and retry';
  }
  return s.slice(0, 140);
}

// Smart Offline while watching: queue next episode download once at >=90%
const _smartOfflineQueued = new Set();
async function maybeSmartOfflineNext(prog) {
  if (!state.settings || state.settings.smart_offline === false) return;
  if (!prog || prog.media_type === 'movie' || !prog.season || !prog.episode) return;
  if (!prog.duration_sec || prog.duration_sec <= 0) return;
  if ((prog.current_time_sec / prog.duration_sec) < 0.9) return;
  const key = `${prog.media_id}_${prog.season}_${prog.episode}`;
  if (_smartOfflineQueued.has(key)) return;
  _smartOfflineQueued.add(key);
  const media = state.selectedMedia;
  if (!media || media.id !== prog.media_id) return;
  try {
    const pending = (state.downloads || []).filter((d) => d.status === 'downloading').length;
    if (pending >= 5) return;
    const nextE = (prog.episode || 1) + 1;
    const nextImdb = media.imdb_id || String(media.id);
    const streams = await invoke('get_torrent_streams', torrentInvokeArgs({ mediaType: 'series', imdbId: nextImdb, tmdbId: media.id, season: prog.season, episode: nextE }));
    if (streams && streams.length > 0) {
      const best = (streams || []).filter((s) => isProviderEnabled(s.provider || s.name))[0] || streams[0];
      await invoke('start_download', { item: {
        id: `dl_${media.id}_${prog.season}_${nextE}_${Date.now()}`,
        media_id: media.id, media_type: media.media_type || 'tv',
        title: `S${String(prog.season).padStart(2, '0')}E${String(nextE).padStart(2, '0')} - ${media.title}`,
        poster_url: media.poster_url || null, backdrop_url: media.backdrop_url || null,
        season: prog.season, episode: nextE, file_path: '',
        file_size: best.size_bytes || 0, downloaded_bytes: 0, progress: 0.0,
        download_speed: 'Starting...', status: 'downloading',
        stream_url: best.stream_url || null, magnet_uri: best.magnet_uri || null,
        date_added: Math.floor(Date.now() / 1000),
      } });
      try { trackEvent('smart_offline_queued', { key }); } catch {}
      await loadDownloads();
    }
  } catch (e) { console.warn('[Smart Offline] skip', e); }
}

// Resolve a stream into a directly-downloadable URL + real file name.
// For torrents this hits the engine upfront: dead magnets fail HERE with a
// clear message instead of producing a broken 0-byte "download".
async function resolveDownloadSource(stream) {
  const direct = stream.stream_url || '';
  if (direct && /\.(mp4|mkv|webm|m4v|avi|mov|ts|m2ts|flv|mp3)(\?|$)/i.test(direct)) {
    let fileName = '';
    try {
      const u = new URL(direct);
      fileName = decodeURIComponent(u.pathname.split('/').pop() || '');
    } catch { fileName = direct.split('/').pop().split('?')[0] || ''; }
    return { url: direct, fileName, size: stream.size_bytes || 0, dead: false };
  }
  if (!stream.magnet_uri) throw new Error('NO_SOURCE');
  const res = await fetch(`${state.torrentEngineUrl}/api/stream/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnet: stream.magnet_uri }),
  });
  if (!res.ok) throw new Error('ENGINE_UNREACHABLE');
  const data = await res.json();
  if (!data.streamUrl) throw new Error(data.code || 'METADATA_TIMEOUT');
  return {
    url: data.streamUrl,
    fileName: data.name || '',
    size: data.size || 0,
    infoHash: data.infoHash,
    fileIndex: data.fileIndex || 0,
    dead: data.code === 'NO_PEERS',
    peers: data.peers || 0,
  };
}

async function startDownloadForStream(stream, media, season = null, episode = null) {
  const isSeries = (media.media_type === 'tv' || season);
  const s = season || 1;
  const e = episode || 1;
  const titlePrefix = isSeries ? `S${s.toString().padStart(2, '0')}E${e.toString().padStart(2, '0')} - ` : '';
  const fullTitle = `${titlePrefix}${media.title}`;

  const downloadId = `dl_${media.id}_${s}_${e}_${Date.now()}`;

  // Resolve first: dead torrents / dead engine fail here with a clear message.
  let src;
  try {
    src = await resolveDownloadSource(stream);
  } catch (err) {
    const code = String((err && err.message) || err);
    const dict = (typeof getErrorDict === 'function') ? getErrorDict() : {};
    alert('⚠️ ' + (dict[code] || dict.ENGINE_UNREACHABLE || 'Could not reach a working source. Try another stream.'));
    return;
  }
  if (src.dead) {
    // 0-seed torrent: warn but let the user insist, like streaming does.
    const go = confirm(t('downloads.deadConfirm', 'This torrent has 0 seeders and may never finish. Start anyway?'));
    if (!go) return;
  }

  const downloadItem = {
    id: downloadId,
    media_id: media.id,
    media_type: media.media_type || 'movie',
    title: fullTitle,
    poster_url: media.poster_url || null,
    backdrop_url: media.backdrop_url || null,
    season: isSeries ? s : null,
    episode: isSeries ? e : null,
    file_path: '',
    file_size: src.size || stream.size_bytes || 0,
    downloaded_bytes: 0,
    progress: 0.0,
    download_speed: 'Starting...',
    status: 'downloading',
    stream_url: src.url,
    magnet_uri: stream.magnet_uri || null,
    file_name: src.fileName || null,
    date_added: Math.floor(Date.now() / 1000),
  };

  try {
    await invoke('start_download', { item: downloadItem });
    alert(`📥 ${t('downloads.started', 'Download started')} "${fullTitle}"!`);
    await loadDownloads();
    // Smart Offline: auto-queue next episode if series and auto_play_next
    if (isSeries && state.settings.auto_play_next) {
      const nextE = e + 1;
      const nextTitle = `S${s.toString().padStart(2,'0')}E${nextE.toString().padStart(2,'0')} - ${media.title}`;
      // Check quota: don't auto-queue if >5 pending downloads
      const pending = state.downloads.filter(d=>d.status==='downloading').length;
      if (pending < 5) {
        // Try to fetch next episode streams silently
        const nextImdb = media.imdb_id || String(media.id);
        try {
          const nextStreams = await invoke('get_torrent_streams', torrentInvokeArgs({ mediaType: 'series', imdbId: nextImdb, tmdbId: media.id, season: s, episode: nextE }));
          if (nextStreams && nextStreams.length > 0) {
            const best = (nextStreams || []).filter((x) => isProviderEnabled(x.provider || x.name))[0] || nextStreams[0];
            const nextItem = { ...downloadItem, id: `dl_${media.id}_${s}_${nextE}_${Date.now()}`, title: nextTitle, season: s, episode: nextE, stream_url: best.stream_url || null, magnet_uri: best.magnet_uri || null };
            await invoke('start_download', { item: nextItem });
            console.log('[Smart Offline] Queued next episode', nextTitle);
          }
        } catch(e) { console.warn('Smart offline next ep skip', e); }
      }
    }
  } catch (err) {
    alert(t('dlg.dlStartFail', 'Failed to start download: ')+err);
  }
}

async function playOfflineVideo(item) {
  state.activeStream = {
    resolution: '1080p FHD (Local Disk)',
    quality: 'Offline Storage',
    provider: 'Local Hard Drive',
    size_formatted: item.file_size > 0 ? `${(item.file_size / (1024 * 1024 * 1024)).toFixed(2)} GB` : 'Local File',
  };

  if (!el.playerView) return;
  el.playerView.classList.add('active');

  if (el.playerMediaTitle) el.playerMediaTitle.textContent = `💾 OFFLINE: ${item.title}`;
  if (el.playerStreamStats) el.playerStreamStats.textContent = t('ui.offlineStats', 'Local File • 100% Offline • 0 Lag');

  if (el.hudStatus) el.hudStatus.textContent = t('ui.hudOffline', '💾 Playing Offline File');
  if (el.hudSpeed) el.hudSpeed.textContent = t('ui.localDisk', '⚡ Local Disk (Direct)');
  if (el.hudPeers) el.hudPeers.textContent = t('ui.offlineMode', '👥 Offline Mode');
  if (el.hudProgress) el.hudProgress.textContent = t('ui.local100', '100% Local');

  if (el.mainIframe) {
    el.mainIframe.style.display = 'none';
    el.mainIframe.src = 'about:blank';
  }

  if (el.mainVideo) {
    el.mainVideo.style.display = 'block';
    const isMkv = /\.mkv$/i.test(item.file_path || '');
    const localVideoUrl = `http://127.0.0.1:${state.serverPort}/local/video?path=${encodeURIComponent(item.file_path)}`;
    el.mainVideo.oncanplay = () => { hidePlayerLoading(); };
    el.mainVideo.onplaying = () => { hidePlayerLoading(); updatePlayPauseButton(true); };
    el.mainVideo.onerror = () => {
      const code = classifyVideoError(el.mainVideo.error, isMkv);
      console.warn('[Offline playback error]', code, item.file_path);
      // MKV the browser can't decode → 1-click Convert & Play inside the app
      if (isMkv && (code === 'UNSUPPORTED_CONTAINER' || code === 'UNSUPPORTED_CODEC')) {
        showVideoErrorStructured({
          code, isMkv: true, canConvert: true,
          onConvert: () => convertAndPlayOffline(item),
        });
        return;
      }
      // Missing/corrupt file (404 from /local/video, 0-byte, wrong ext, …)
      if (code === 'NETWORK') {
        showVideoErrorStructured({ code: 'OFFLINE_FILE_GONE', isMkv, canConvert: isMkv,
          onConvert: isMkv ? () => convertAndPlayOffline(item) : null });
        return;
      }
      showVideoErrorStructured({ code, isMkv, canConvert: false });
    };
    showPlayerLoading(t('downloads.opening', '💾 Opening offline file...'));
    el.mainVideo.src = localVideoUrl;
    el.mainVideo.load();
    el.mainVideo.play().catch((e) => console.log('Offline playback autoplay notice:', e));
  }

  updatePlayPauseButton(true);
}

// Convert a downloaded MKV → MP4, point the download at the new file, play it
async function convertAndPlayOffline(item) {
  if (!item || !item.file_path) return;
  const out = item.file_path.replace(/\.mkv$/i, '.mp4');
  showPlayerLoading(t('downloads.converting', '🔄 Converting MKV→MP4...'));
  try {
    await invoke('check_ffmpeg');
    await invoke('transcode_video', { inputPath: item.file_path, outputPath: out });
    await invoke('update_download_file_path', { id: item.id, filePath: out });
    try { trackEvent('offline_converted_play', { id: item.id }); } catch {}
    await loadDownloads();
    const updated = (state.downloads || []).find((d) => d.id === item.id) || { ...item, file_path: out };
    playOfflineVideo(updated);
  } catch (e) {
    const msg = String((e && e.message) || e || '');
    if (/ffmpeg not found|not found — install/i.test(msg)) {
      const want = confirm(t('st.dlFfmpegConfirm', 'Download ffmpeg (~80MB, one time)?'));
      if (want) {
        try {
          showPlayerLoading(t('st.downloading', 'Downloading...') + ' ffmpeg');
          await downloadFfmpegOnDemand();
          convertAndPlayOffline(item);
          return;
        } catch (e2) { logError('ffmpeg-dl', e2); }
      }
    }
    logError('offline-convert', e);
    showVideoErrorStructured({ code: 'CONVERT_FAILED', message: String(e).slice(0, 160), isMkv: true, canConvert: false });
  }
}

async function checkWatchlistStatus(id, mediaType) {
  try {
    const isFav = await invoke('is_in_watchlist', { id, mediaType });
    if (el.modalWatchlistBtn) {
      el.modalWatchlistBtn.textContent = isFav ? t('ui.watchlistIn', '✓ In Watchlist') : t('ui.watchlistAdd', '+ Add to Watchlist');
      el.modalWatchlistBtn.classList.toggle('active', isFav);
    }
  } catch (e) {}
}

function applyTheme(theme){
  const t = theme || localStorage.getItem('mamzouka_theme') || 'moroccan';
  document.documentElement.setAttribute('data-theme', t);
  const root = document.documentElement;
  if(t==='light'){
    root.style.setProperty('--bg-primary','#f8f7f4');
    root.style.setProperty('--bg-secondary','#ffffff');
    root.style.setProperty('--bg-card','rgba(255,255,255,0.85)');
    root.style.setProperty('--bg-glass','rgba(255,255,255,0.9)');
    root.style.setProperty('--text-primary','#0f172a');
    root.style.setProperty('--text-secondary','#475569');
    root.style.setProperty('--text-muted','#94a3b8');
    root.style.setProperty('--border-glass','rgba(0,0,0,0.08)');
  } else if(t==='midnight'){
    root.style.setProperty('--bg-primary','#020617');
    root.style.setProperty('--bg-secondary','#0f172a');
    root.style.setProperty('--bg-card','rgba(15,23,42,0.85)');
    root.style.setProperty('--bg-glass','rgba(2,6,23,0.9)');
    root.style.setProperty('--text-primary','#f1f5f9');
    root.style.setProperty('--text-secondary','#94a3b8');
    root.style.setProperty('--text-muted','#64748b');
    root.style.setProperty('--border-glass','rgba(255,255,255,0.08)');
  } else {
    root.style.setProperty('--bg-primary','#0a0c10');
    root.style.setProperty('--bg-secondary','#12161f');
    root.style.setProperty('--bg-card','rgba(22,27,38,0.75)');
    root.style.setProperty('--bg-glass','rgba(18,22,32,0.85)');
    root.style.setProperty('--text-primary','#ffffff');
    root.style.setProperty('--text-secondary','#94a3b8');
    root.style.setProperty('--text-muted','#64748b');
    root.style.setProperty('--border-glass','rgba(255,255,255,0.08)');
  }
  localStorage.setItem('mamzouka_theme', t);
  if(el.settingTheme) el.settingTheme.value = t;
}
async function loadSettings() {
  try {
    const s = await invoke('get_settings');
    if (s) {
      state.settings = s;
      if (el.settingTmdbKey) el.settingTmdbKey.value = s.tmdb_api_key || '';
      if (el.settingRealDebridKey) el.settingRealDebridKey.value = s.real_debrid_api_key || '';
      if (el.settingSubLang) el.settingSubLang.value = s.default_subtitle_lang || 'ara';
      if (el.settingRes) el.settingRes.value = s.preferred_resolution || '1080p';
      if (el.settingKidsMode) el.settingKidsMode.checked = !!s.kids_mode;
      if (el.settingKidsPin) el.settingKidsPin.value = s.kids_pin || '';
      if (el.kidsPinRow) el.kidsPinRow.style.display = s.kids_mode ? 'flex' : 'none';
      if (s.kids_mode) document.body.classList.add('kids-mode');
      else document.body.classList.remove('kids-mode');
      if (s.kids_mode) { state.activeMovieGenre = '16'; state.activeTvGenre = '16'; }
      if (el.settingAppLang) el.settingAppLang.value = s.app_language || 'en';
      if (el.settingDensity) el.settingDensity.value = s.density || 'comfortable';
      if (el.settingAutoPlay) el.settingAutoPlay.checked = !!s.auto_play_next;
      if (el.settingAutoSkip) el.settingAutoSkip.checked = !!s.auto_skip_intro;
      if (el.settingHwAccel) el.settingHwAccel.checked = s.hardware_acceleration !== false;
      if (el.settingCacheDir) el.settingCacheDir.value = s.cache_dir || '';
      if (el.settingQuota) { el.settingQuota.value = s.quota_gb || 100; if(el.quotaValue) el.quotaValue.textContent = s.quota_gb || 100; }
      if (el.settingSmartOffline) el.settingSmartOffline.checked = s.smart_offline !== false;
      if (el.settingAutoTranscode) el.settingAutoTranscode.checked = s.auto_transcode !== false;
      if (el.settingConcurrency) el.settingConcurrency.value = String(s.download_concurrency || 2);
      if (el.settingSecondarySub) el.settingSecondarySub.value = s.secondary_sub_lang || '';
      if (el.settingSubSize) el.settingSubSize.value = s.sub_font_size || 'medium';
      if (el.settingSubTranslate) el.settingSubTranslate.checked = !!s.sub_auto_translate;
      if (el.settingEpgSource) el.settingEpgSource.value = s.epg_source || 'auto';
      if (el.settingNotifEpisode) el.settingNotifEpisode.checked = s.notif_new_episode !== false;
      if (el.settingNotifDownload) el.settingNotifDownload.checked = s.notif_download_complete !== false;
      if (el.settingNotifAnalytics) el.settingNotifAnalytics.checked = s.notif_analytics !== false;
      if (el.settingServerPort) el.settingServerPort.value = state.serverPort || '';
      const profEl = document.getElementById('settings-profile-display');
      if(profEl){ const active = localStorage.getItem('mamzouka_active_profile')||'Default'; const all = JSON.parse(localStorage.getItem('mamzouka_profiles')||'["Default"]'); profEl.textContent = t('ui.profileActive', 'Active: {a} • Profiles: {p}').replace('{a}', active).replace('{p}', all.join(', ')); }
      applyTheme(s.theme || localStorage.getItem('mamzouka_theme')||'moroccan');
      // Density → card size
      if(s.density==='compact') document.documentElement.style.setProperty('--card-min','140px');
      else if(s.density==='spacious') document.documentElement.style.setProperty('--card-min','210px');
      else document.documentElement.style.setProperty('--card-min','180px');
    }
  } catch (e) {}
  applyTheme(localStorage.getItem('mamzouka_theme')||'moroccan');
}

async function loadAnalytics(){
  const elA = document.getElementById('analytics-display');
  if(!elA) return;
  try{
    const hist = await invoke('get_watch_history');
    const totalSec = (hist||[]).reduce((a,h)=>a+(h.current_time_sec||0),0);
    const hrs = (totalSec/3600).toFixed(1);
    const days = new Set((hist||[]).map(h=> new Date(h.last_watched_timestamp*1000).toDateString())).size;
    elA.innerHTML = t('ui.analyticsTpl', '⏱ {h}h watched • 📅 {d} active days • 🎬 {n} titles • 🔥 Streak: {s} days').replace('{h}', hrs).replace('{d}', days).replace('{n}', hist.length).replace('{s}', days);
  }catch{ elA.textContent=t('ui.analyticsEmpty', 'No data yet — start watching!'); }
}

// ==========================================================================
// Event Listeners Setup
// ==========================================================================
function setupEventListeners() {
  // Stream Filter Pills
  if (el.streamFilters) {
    el.streamFilters.querySelectorAll('.filter-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        el.streamFilters.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        activeStreamFilter = pill.dataset.filter || 'all';
        renderFilteredStreams();
      });
    });
  }

  // Save Settings Button (first handler - legacy)
  if (el.btnSaveSettings) {
    el.btnSaveSettings.addEventListener('click', async () => {
      try {
        const newSettings = {
          tmdb_api_key: el.settingTmdbKey ? el.settingTmdbKey.value.trim() : '0ea8d8ca2abeb5fa061faf1a966747b4',
          real_debrid_api_key: el.settingRealDebridKey && el.settingRealDebridKey.value.trim() ? el.settingRealDebridKey.value.trim() : null,
          default_subtitle_lang: el.settingSubLang ? el.settingSubLang.value : 'ara',
          preferred_resolution: el.settingRes ? el.settingRes.value : '1080p',
          auto_play_next: el.settingAutoPlay ? el.settingAutoPlay.checked : true,
          cache_dir: el.settingCacheDir ? el.settingCacheDir.value : (state.settings.cache_dir || ''),
          kids_mode: el.settingKidsMode ? el.settingKidsMode.checked : false,
          kids_pin: el.settingKidsPin && el.settingKidsPin.value.trim() ? el.settingKidsPin.value.trim() : null,
          theme: el.settingTheme ? el.settingTheme.value : (localStorage.getItem('mamzouka_theme')||'moroccan'),
          app_language: el.settingAppLang ? el.settingAppLang.value : 'en',
          density: el.settingDensity ? el.settingDensity.value : 'comfortable',
          auto_skip_intro: el.settingAutoSkip ? el.settingAutoSkip.checked : false,
          hardware_acceleration: el.settingHwAccel ? el.settingHwAccel.checked : true,
          quota_gb: el.settingQuota ? (parseInt(el.settingQuota.value, 10) || 100) : 100,
          smart_offline: el.settingSmartOffline ? el.settingSmartOffline.checked : true,
          auto_transcode: el.settingAutoTranscode ? el.settingAutoTranscode.checked : false,
          download_concurrency: el.settingConcurrency ? (parseInt(el.settingConcurrency.value, 10) || 2) : 2,
          secondary_sub_lang: el.settingSecondarySub && el.settingSecondarySub.value ? el.settingSecondarySub.value : null,
          sub_font_size: el.settingSubSize ? el.settingSubSize.value : 'medium',
          sub_auto_translate: el.settingSubTranslate ? el.settingSubTranslate.checked : false,
          epg_source: el.settingEpgSource ? el.settingEpgSource.value : 'auto',
          notif_new_episode: el.settingNotifEpisode ? el.settingNotifEpisode.checked : true,
          notif_download_complete: el.settingNotifDownload ? el.settingNotifDownload.checked : true,
          notif_analytics: el.settingNotifAnalytics ? el.settingNotifAnalytics.checked : true,
        };
        await invoke('update_settings', { settings: newSettings });
        state.settings = newSettings;
        localStorage.setItem('mamzouka_theme', newSettings.theme);
        applyTheme(newSettings.theme);
        alert(t('dlg.settingsSaved', 'Settings saved!'));
        if (newSettings.kids_mode) { state.activeMovieGenre='16'; state.activeTvGenre='16'; }
        await loadDiscoverContent();
        await loadAnalytics();
      } catch (err) {
        alert(t('dlg.settingsFail', 'Failed to save settings: ')+err);
      }
    });
  }

  // Theme selector
  if (el.settingTheme) {
    el.settingTheme.addEventListener('change', (e)=> applyTheme(e.target.value));
  }
  // Kids PIN toggle — PIN required to enable AND to disable
  if (el.settingKidsMode) {
    el.settingKidsMode.addEventListener('change', (e)=>{
      if(e.target.checked){
        if(el.kidsPinRow) el.kidsPinRow.style.display='flex';
        if(el.settingKidsPin && !el.settingKidsPin.value.trim()){
          const pin = prompt(t('dlg.setPin', 'Set a 4-digit Kids PIN:'));
          if(!pin || !/^\d{4}$/.test(pin.trim())){ alert(t('dlg.pin4bad', 'PIN must be 4 digits.')); e.target.checked=false; if(el.kidsPinRow) el.kidsPinRow.style.display='none'; return; }
          el.settingKidsPin.value = pin.trim();
        }
      } else {
        const savedPin = (state.settings && state.settings.kids_pin) || (el.settingKidsPin && el.settingKidsPin.value.trim());
        if(savedPin){
          const entered = prompt(t('dlg.enterPin', 'Enter Kids PIN to disable:'));
          if(entered !== savedPin){ alert(t('dlg.wrongPin', 'Wrong PIN')); e.target.checked=true; return; }
        }
        if(el.kidsPinRow) el.kidsPinRow.style.display='none';
      }
    });
  }

  // Settings Tabs
  const settingsTabs = document.getElementById('settings-tabs');
  if(settingsTabs){
    settingsTabs.querySelectorAll('[data-tab]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        settingsTabs.querySelectorAll('[data-tab]').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        document.querySelectorAll('.settings-tab-pane').forEach(p=> p.style.display = p.dataset.pane===tab ? 'block' : 'none');
      });
    });
  }
  // Quota slider live
  if(el.settingQuota && el.quotaValue){
    el.settingQuota.addEventListener('input', e=>{ el.quotaValue.textContent = e.target.value; });
  }
  // Cache dir open
  const btnOpenFolder2 = document.getElementById('btn-open-downloads-folder2');
  if(btnOpenFolder2){
    btnOpenFolder2.addEventListener('click', async ()=>{ try{ await invoke('open_download_folder', { filePath: '' }); }catch(e){ console.error(e); } });
  }
  // Clear search history
  const btnClearSearch = document.getElementById('btn-clear-search-history');
  if(btnClearSearch) btnClearSearch.addEventListener('click', ()=>{ localStorage.removeItem('mamzouka_search_history'); alert(t('dlg.searchCleared', 'Search history cleared')); });
  const btnClearWatch = document.getElementById('btn-clear-watch-history');
  if(btnClearWatch) btnClearWatch.addEventListener('click', async ()=>{ if(confirm(t('dlg.clearWatchConfirm', 'Clear all watch history?'))){ localStorage.removeItem('mamzouka_watch_history'); try{ await invoke('update_watch_progress', { progress: { media_id: 0, media_type: 'movie', title: '__clear__', poster_url: null, backdrop_url: null, season: null, episode: null, current_time_sec: 0, duration_sec: 0, last_watched_timestamp: 0 } }); }catch{} alert(t('dlg.watchCleared', 'History cleared')); location.reload(); } });
  const btnReset = document.getElementById('btn-reset-settings');
  if(btnReset) btnReset.addEventListener('click', async ()=>{ if(confirm(t('dlg.resetConfirm', 'Reset all settings to defaults?'))){ localStorage.removeItem('mamzouka_theme'); try{ await invoke('update_settings', { settings: { tmdb_api_key: '0ea8d8ca2abeb5fa061faf1a966747b4', real_debrid_api_key: null, default_subtitle_lang: 'ara', preferred_resolution: '1080p', auto_play_next: true, cache_dir: '', kids_mode: false, kids_pin: null, theme: 'moroccan', app_language: 'en', density: 'comfortable', auto_skip_intro: false, hardware_acceleration: true, quota_gb: 100, smart_offline: true, auto_transcode: false, download_concurrency: 2, secondary_sub_lang: null, sub_font_size: 'medium', sub_auto_translate: false, epg_source: 'auto', notif_new_episode: true, notif_download_complete: true, notif_analytics: true } }); }catch{} alert(t('dlg.resetDone', 'Reset done')); location.reload(); } });
  // IPTV list in settings
  const iptvListEl = document.getElementById('settings-iptv-list');
  if(iptvListEl){
    invoke('get_custom_iptv_playlists').then(list=>{
      if(!list || list.length===0) iptvListEl.textContent=t('ui.noCustomIptv', 'No custom IPTV playlists');
      else iptvListEl.innerHTML = list.map(p=> `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border-glass);"><span>${escapeHtml(p.name)} (${escapeHtml(p.url.slice(0,40))}...)</span><span style="color:${p.enabled?'#22c55e':'#ef4444'};">${p.enabled?'On':'Off'}</span></div>`).join('');
    }).catch(()=> iptvListEl.textContent=t('ui.iptvLoadFail', 'Failed to load'));
  }

  // Cloud Sync Export/Import
  if (el.btnExportSync) {
    el.btnExportSync.addEventListener('click', async () => {
      try {
        const json = await invoke('export_sync_data');
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `mamzouka-sync-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
      } catch(e){ alert(t('dlg.exportFail', 'Export failed: ')+e); }
    });
  }
  if (el.btnImportSync && el.importSyncFile) {
    el.btnImportSync.addEventListener('click', ()=> el.importSyncFile.click());
    el.importSyncFile.addEventListener('change', async (e)=>{
      const file = e.target.files[0]; if(!file) return;
      const text = await file.text();
      try { await invoke('import_sync_data', { json: text }); alert(t('dlg.importOk', 'Import success! Reloading...')); location.reload(); } catch(err){ alert(t('dlg.importFail', 'Import failed: ')+err); }
    });
  }

  // Trakt & ffmpeg checks
  const traktBtn = document.getElementById('btn-trakt-preview');
  const traktPre = document.getElementById('trakt-preview');
  const traktStatus = document.getElementById('trakt-status');
  if(traktBtn){
    traktBtn.addEventListener('click', async ()=>{
      traktBtn.textContent=t('ui.checking', '⏳ Checking...');
      try{
        const j=await invoke('get_trakt_sync_preview');
        if(traktPre){ traktPre.style.display='block'; traktPre.textContent=j; }
        if(traktStatus) traktStatus.textContent='✅ OK';
        // Build a real Trakt-compatible sync file from local history for import elsewhere
        try {
          const hist = await invoke('get_watch_history');
          const movies = [], shows = [];
          for (const h of (hist || [])) {
            if ((h.current_time_sec || 0) < 60) continue;
            if (h.media_type === 'movie') movies.push({ title: h.title, ids: { tmdb: h.media_id }, watched_at: new Date((h.last_watched_timestamp || 0) * 1000).toISOString() });
            else shows.push({ title: h.title, ids: { tmdb: h.media_id }, seasons: h.season ? [{ number: h.season, episodes: [{ number: h.episode || 1 }] }] : [] });
          }
          const payload = JSON.stringify({ movies, shows }, null, 2);
          let dl = document.getElementById('btn-trakt-download');
          if (!dl) {
            dl = document.createElement('button');
            dl.id = 'btn-trakt-download';
            dl.className = 'btn-secondary';
            dl.style.cssText = 'padding:6px 12px; font-size:0.82rem;';
            dl.textContent = t('ui.traktDl', '⬇ Download Trakt JSON');
            traktBtn.parentNode.appendChild(dl);
          }
          dl.onclick = () => {
            const blob = new Blob([payload], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `mamzouka-trakt-${Date.now()}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          };
          if (traktStatus) traktStatus.textContent = t('ui.traktReady', '✅ {m} movies • {s} shows ready').replace('{m}', movies.length).replace('{s}', shows.length);
        } catch {}
      }catch(e){ if(traktStatus) traktStatus.textContent='❌ '+e; }
      traktBtn.textContent=t('st.traktPreview', '🔗 Preview');
    });
  }
  const ffBtn=document.getElementById('btn-check-ffmpeg');
  const ffStatus=document.getElementById('ffmpeg-status');
  if(ffBtn){
    ffBtn.addEventListener('click', async ()=>{
      ffBtn.textContent=t('ui.checking', '⏳ Checking...');
      try{ const r=await invoke('check_ffmpeg'); if(ffStatus) ffStatus.textContent='✅ '+r; }catch(e){ if(ffStatus) ffStatus.textContent='❌ '+e; }
      ffBtn.textContent=t('st.checkFfmpeg', '🔍 Check ffmpeg');
    });
  }

  // Diagnostics: export logs for Telegram support
  const btnLogs = document.getElementById('btn-export-logs');
  if (btnLogs) {
    btnLogs.addEventListener('click', async () => {
      try {
        let settings = null, history = [];
        try { settings = await invoke('get_settings'); } catch {}
        try { history = await invoke('get_watch_history'); } catch {}
        let engine = null;
        try {
          const r = await fetch(`${state.torrentEngineUrl}/api/health`, { cache: 'no-store' });
          engine = await r.json();
        } catch (e) { engine = { error: String(e).slice(0, 120) }; }
        let ffmpeg = null;
        try { ffmpeg = await invoke('check_ffmpeg'); } catch (e) { ffmpeg = 'missing: ' + e; }
        const payload = {
          app: 'MamzoukaStream 2.0.0', exported_at: new Date().toISOString(),
          lang: getCurrentLang(), tmdb_lang: getTmdbLanguage(),
          engine, ffmpeg,
          errors: errorLog.slice(-60),
          analytics: JSON.parse(localStorage.getItem('mamzouka_analytics') || '[]').slice(-30),
          history_count: (history || []).length,
          settings: settings ? { ...settings, tmdb_api_key: '(hidden)', real_debrid_api_key: settings.real_debrid_api_key ? '(set)' : null, kids_pin: settings.kids_pin ? '(set)' : null } : null
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mamzouka-logs-${Date.now()}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } catch (e) { alert(t('dlg.exportFail', 'Export failed: ') + e); }
    });
  }
  // Diagnostics: engine assets (node+deps) + ffmpeg status + one-click fetch.
  // URLs: remote endpoints.* override, baked-in defaults otherwise.
  const assetsStatus = document.getElementById('engine-assets-status');
  const remoteFileUrl = (name, fallback) => {
    try {
      if (window.RemoteControl) {
        const v = window.RemoteControl.get('endpoints.' + name, '');
        if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
      }
    } catch {}
    return fallback;
  };
  const refreshAssetsStatus = async () => {
    if (!assetsStatus) return;
    try {
      const s = await invoke('engine_status');
      const eng = s && s.ready ? t('st.engineReady', 'Engine files ready ✓') : t('st.engineMissing', 'Engine files missing');
      const ff = s && s.ffmpeg ? t('st.ffmpegReady', 'ffmpeg ready ✓') : t('st.ffmpegMissing', 'ffmpeg missing');
      assetsStatus.textContent = `${eng} • ${ff}`;
    } catch { assetsStatus.textContent = ''; }
  };
  refreshAssetsStatus();
  setInterval(refreshAssetsStatus, 60000);
  const btnEngine = document.getElementById('btn-download-engine');
  if (btnEngine) {
    btnEngine.addEventListener('click', async () => {
      if (!confirm(t('st.dlEngineConfirm', 'Download engine files (~95MB, one time)?'))) return;
      btnEngine.textContent = t('st.downloading', 'Downloading...');
      try {
        const nodeUrl = remoteFileUrl('engine_node_url', 'https://nodejs.org/dist/v22.23.2/win-x64/node.exe');
        const zipUrl = remoteFileUrl('engine_zip_url', '');
        const dir = await invoke('ensure_engine_assets', { nodeUrl, engineUrl: zipUrl || null });
        alert(t('st.engineReady', 'Engine files ready ✓') + ' ' + dir);
      } catch (e) {
        logError('engine-dl', e);
        alert(t('dlg.clearCacheFail', 'Download failed: ') + e);
      }
      btnEngine.textContent = t('st.downloadEngine', '⬇ Engine files');
      refreshAssetsStatus();
    });
  }
  const btnFfmpeg = document.getElementById('btn-download-ffmpeg');
  if (btnFfmpeg) {
    btnFfmpeg.addEventListener('click', async () => {
      if (!confirm(t('st.dlFfmpegConfirm', 'Download ffmpeg (~80MB, one time)?'))) return;
      btnFfmpeg.textContent = t('st.downloading', 'Downloading...');
      try {
        const p = await downloadFfmpegOnDemand();
        alert(t('st.ffmpegReady', 'ffmpeg ready ✓') + ' ' + p);
      } catch (e) {
        logError('ffmpeg-dl', e);
        alert(t('dlg.clearCacheFail', 'Download failed: ') + e);
      }
      btnFfmpeg.textContent = t('st.downloadFfmpeg', '⬇ ffmpeg (~80MB)');
      refreshAssetsStatus();
    });
  }
  // Diagnostics: engine cache status + clear
  const cacheStatus = document.getElementById('engine-cache-status');
  const refreshCacheStatus = async () => {
    if (!cacheStatus) return;
    try {
      const r = await fetch(`${state.torrentEngineUrl}/api/cache/status`, { cache: 'no-store' });
      const s = await r.json();
      cacheStatus.textContent = `Cache ${(s.cache_mb || 0)}MB + Converted ${(s.converted_mb || 0)}MB / ${(s.quota_gb || 10)}GB`;
    } catch { cacheStatus.textContent = t('ui.engOffline', 'Engine: Offline'); }
  };
  refreshCacheStatus();
  setInterval(refreshCacheStatus, 60000);
  const btnClearCache = document.getElementById('btn-clear-engine-cache');
  if (btnClearCache) {
    btnClearCache.addEventListener('click', async () => {
      if (!confirm(t('dlg.clearCacheConfirm', 'Clear torrent engine cache?'))) return;
      try {
        const r = await fetch(`${state.torrentEngineUrl}/api/cache/clear`, { method: 'POST' });
        const s = await r.json();
        alert(t('dlg.clearedMb', 'Cleared {n}MB').replace('{n}', s.cleared_mb || 0));
        refreshCacheStatus();
      } catch (e) { alert(t('dlg.clearCacheFail', 'Clear failed: ') + e); }
    });
  }

  // Sidebar Navigation Click Handlers
  if (el.navItems) {
    el.navItems.forEach((item) => {
      item.addEventListener('click', () => {
        el.navItems.forEach((n) => n.classList.remove('active'));
        item.classList.add('active');

        const view = item.dataset.view;
        state.currentView = view;

        // Hide all views
        Object.values(el.views).forEach((v) => {
          if (v) v.style.display = 'none';
        });

        if (view === 'discover') {
          if (el.views.discover) el.views.discover.style.display = 'block';
        } else if (view === 'movies') {
          if (el.views.movies) {
            el.views.movies.style.display = 'block';
            loadMoviesContent();
          }
        } else if (view === 'livetv') {
          if (el.views.livetv) {
            el.views.livetv.style.display = 'block';
            refreshLiveTvCategoriesDynamic().finally(()=> loadLiveTvContent());
          }
        } else if (view === 'radio') {
          if (el.views.radio) {
            el.views.radio.style.display = 'block';
            loadRadioContent();
          }
        } else if (view === 'youtube') {
          if (el.views.youtube) {
            el.views.youtube.style.display = 'block';
            loadYoutubeContent();
          }
        } else if (view === 'twitch') {
          if (el.views.twitch) {
            el.views.twitch.style.display = 'block';
            loadTwitchContent();
          }
        } else if (view === 'tv') {
          if (el.views.tv) {
            el.views.tv.style.display = 'block';
            loadTvShowsContent();
          }
        } else if (view === 'anime') {
          if (el.views.anime) {
            el.views.anime.style.display = 'block';
            loadAnimeContent();
          }
        } else if (view === 'addons') {
          if (el.views.addons) {
            el.views.addons.style.display = 'block';
            loadAddons();
          }
        } else if (view === 'watchlist') {
          if (el.views.watchlist) {
            el.views.watchlist.style.display = 'block';
            loadWatchlist();
          }
        } else if (view === 'downloads') {
          if (el.views.downloads) {
            el.views.downloads.style.display = 'block';
            loadDownloads();
          }
        } else if (view === 'settings') {
          if (el.views.settings) {
            el.views.settings.style.display = 'block';
          }
        }
      });
    });
  }

  // Radio Category Filter Chips
  if (el.radioCatScroller) {
    el.radioCatScroller.querySelectorAll('.genre-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        el.radioCatScroller.querySelectorAll('.genre-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeRadioCat = chip.dataset.rcat || 'all';
        await loadRadioContent();
      });
    });
  }

  // YouTube Category Filter Chips
  if (el.youtubeCatScroller) {
    el.youtubeCatScroller.querySelectorAll('.genre-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        el.youtubeCatScroller.querySelectorAll('.genre-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeYoutubeCat = chip.dataset.ytcat || 'trending';
        await loadYoutubeContent();
      });
    });
  }

  // Twitch Category Filter Chips
  if (el.twitchCatScroller) {
    el.twitchCatScroller.querySelectorAll('.genre-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        el.twitchCatScroller.querySelectorAll('.genre-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeTwitchCat = chip.dataset.twcat || 'esports';
        await loadTwitchContent();
      });
    });
  }

  // Downloads Filter Tabs
  if (el.downloadsFilters) {
    el.downloadsFilters.querySelectorAll('.filter-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        el.downloadsFilters.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        state.activeDownloadFilter = pill.dataset.dfilter || 'all';
        renderDownloadsGrid();
      });
    });
  }

  // Open Downloads Folder Button
  if (el.btnOpenDownloadsFolder) {
    el.btnOpenDownloadsFolder.addEventListener('click', async () => {
      try {
        await invoke('open_download_folder', { filePath: '' });
      } catch (e) {
        console.error('Failed to open downloads folder:', e);
      }
    });
  }

  // Live TV Country Filter Pills
  if (el.livetvCountryFilters) {
    el.livetvCountryFilters.querySelectorAll('.filter-pill').forEach((pill) => {
      pill.addEventListener('click', async () => {
        el.livetvCountryFilters.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        state.activeLiveTvCountry = pill.dataset.country;
        await loadLiveTvContent();
      });
    });
  }

  // Live TV Category Filter Chips
  if (el.livetvCatScroller) {
    el.livetvCatScroller.querySelectorAll('.genre-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        el.livetvCatScroller.querySelectorAll('.genre-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeLiveTvCat = chip.dataset.cat;
        await loadLiveTvContent();
      });
    });
  }

  // Live TV Search Input with Debounce
  if (el.livetvSearchInput) {
    let liveTvSearchTimeout = null;
    el.livetvSearchInput.addEventListener('input', (e) => {
      clearTimeout(liveTvSearchTimeout);
      state.activeLiveTvSearch = e.target.value.trim();
      liveTvSearchTimeout = setTimeout(async () => {
        await loadLiveTvContent();
      }, 350);
    });
  }

  // Custom IPTV Add Button
  if (el.btnAddIptv && el.iptvCustomUrl) {
    el.btnAddIptv.addEventListener('click', async () => {
      const url = el.iptvCustomUrl.value.trim();
      const name = (el.iptvCustomName && el.iptvCustomName.value.trim()) || 'Custom IPTV';
      if (!url) {
        alert(t('dlg.iptvEnter', 'Please enter a valid M3U or IPTV stream URL'));
        return;
      }
      try {
        el.btnAddIptv.textContent = t('ui.checking', '⏳ Checking...');
        await invoke('add_custom_iptv_playlist', { name, url });
        el.iptvCustomUrl.value = '';
        if (el.iptvCustomName) el.iptvCustomName.value = '';
        el.btnAddIptv.textContent = t('ui.iptvAdd', '+ Add IPTV');
        alert(t('dlg.iptvAdded', 'IPTV Playlist "{n}" added successfully!').replace('{n}', name));
        await loadLiveTvContent();
      } catch (e) {
        el.btnAddIptv.textContent = t('ui.iptvAdd', '+ Add IPTV');
        alert(t('dlg.iptvFail', 'Failed to add IPTV: ')+e);
      }
    });
  }

  // Addon Install Button
  if (el.btnInstallAddon && el.addonManifestInput) {
    el.btnInstallAddon.addEventListener('click', async () => {
      const url = el.addonManifestInput.value.trim();
      if (!url) return;
      try {
        el.btnInstallAddon.textContent = t('ui.checking', '⏳ Checking...');
        await invoke('install_addon_from_manifest', { manifestUrl: url });
        el.addonManifestInput.value = '';
        el.btnInstallAddon.textContent = t('ui.addonInstallBtn', '+ Install Addon');
        alert(t('dlg.addonOk', 'Add-on installed successfully!'));
        await loadAddons();
      } catch (e) {
        el.btnInstallAddon.textContent = t('ui.addonInstallBtn', '+ Install Addon');
        alert(t('dlg.addonFail', 'Failed to install addon: ')+e);
      }
    });
  }

  // Refresh Button
  if (el.btnRefresh) {
    el.btnRefresh.addEventListener('click', () => {
      loadDiscoverContent();
    });
  }

  // Search History (localStorage) + Debounce
  const HISTORY_KEY = 'mamzouka_search_history';
  const getHistory = () => { try{ return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]'); }catch{ return []; } };
  const saveHistory = (q) => {
    if(!q || q.length<2) return;
    let h = getHistory().filter(x=>x!==q);
    h.unshift(q); h = h.slice(0,10);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  };
  const histDropdown = document.getElementById('search-history-dropdown');
  const renderHistDropdown = () => {
    if(!histDropdown || !el.searchInput) return;
    const h = getHistory();
    if(h.length===0 || document.activeElement!==el.searchInput){ histDropdown.style.display='none'; return; }
    histDropdown.innerHTML = `<div style="font-size:0.72rem; color:var(--text-muted); padding:4px 8px; display:flex; justify-content:space-between;"><span>${escapeHtml(t('ui.recentSearches', 'Recent Searches'))}</span><span id="clear-history" style="cursor:pointer; color:#ef4444;">${escapeHtml(t('common.clear', 'Clear'))}</span></div>` + h.map(q=>`<div class="hist-item" data-q="${q}" style="padding:8px 10px; cursor:pointer; border-radius:8px; display:flex; align-items:center; gap:8px; hover:background:rgba(255,255,255,0.06);"><span style="color:var(--text-muted);">🕘</span><span>${q}</span></div>`).join('');
    histDropdown.style.display='block';
    histDropdown.querySelectorAll('.hist-item').forEach(it=> it.addEventListener('click', ()=>{ el.searchInput.value=it.dataset.q; el.searchInput.dispatchEvent(new Event('input',{bubbles:true})); histDropdown.style.display='none'; }));
    const clearBtn = document.getElementById('clear-history');
    if(clearBtn) clearBtn.addEventListener('click', ()=>{ localStorage.removeItem(HISTORY_KEY); histDropdown.style.display='none'; });
  };
  if (el.searchInput) {
    let searchTimeout = null;
    let searchSeq = 0;
    el.searchInput.addEventListener('focus', renderHistDropdown);
    el.searchInput.addEventListener('input', (e) => {
      const query = e.target.value.trim();
      if (el.searchClearBtn) el.searchClearBtn.classList.toggle('visible', query.length > 0);
      if(histDropdown) histDropdown.style.display = query ? 'none' : 'block';
      if(!query) renderHistDropdown();

      clearTimeout(searchTimeout);
      if (!query) {
        if (el.views.search) el.views.search.style.display = 'none';
        if (el.views.discover) el.views.discover.style.display = 'block';
        return;
      }

      searchTimeout = setTimeout(async () => {
        saveHistory(query);
        const mySeq = ++searchSeq;
        Object.values(el.views).forEach((v) => {
          if (v) v.style.display = 'none';
        });
        if (el.views.search) el.views.search.style.display = 'block';
        if (el.searchTitle) el.searchTitle.textContent = t('ui.searchResultsFor', 'Search results for "{q}"').replace('{q}', query);
        if (el.searchGrid) el.searchGrid.innerHTML = '<div class="spinner"></div>';

        try {
          const resp = await invoke('search_media', { query, page: 1, language: getTmdbLanguage() });
          if (mySeq !== searchSeq) return; // stale response: user already typed more
          if (el.searchGrid) renderGrid(el.searchGrid, resp.results);
        } catch (err) {
          if (mySeq !== searchSeq) return;
          logError('search', err);
          if (el.searchGrid) el.searchGrid.innerHTML = `<div style="color: #ef4444; padding: 20px;">Search failed: ${escapeHtml(String(err).slice(0,140))}<br><button class="btn-secondary" style="margin-top:10px;" onclick="document.getElementById('search-input').dispatchEvent(new Event('input',{bubbles:true}))">↻ ${escapeHtml(t('player.retry', 'Retry'))}</button></div>`;
        }
      }, 400);
    });
    el.searchInput.addEventListener('blur', ()=> setTimeout(()=>{ if(histDropdown) histDropdown.style.display='none'; },150));
  }

  if (el.searchClearBtn && el.searchInput) {
    el.searchClearBtn.addEventListener('click', () => {
      el.searchInput.value = '';
      el.searchClearBtn.classList.remove('visible');
      if (el.views.search) el.views.search.style.display = 'none';
      if (el.views.discover) el.views.discover.style.display = 'block';
    });
  }

  // Darija Voice Search (ar-MA + fr-FR fallback)
  const voiceBtn = document.getElementById('search-voice-btn');
  if (voiceBtn && el.searchInput) {
    voiceBtn.addEventListener('click', () => {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) { alert(t('dlg.voiceNo', 'Voice search not supported in this WebView.')); return; }
      const rec = new SpeechRecognition();
      rec.lang = 'ar-MA';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      voiceBtn.textContent = '🔴';
      voiceBtn.style.background = 'rgba(239,68,68,0.3)';
      rec.onresult = (e) => {
        const transcript = e.results[0][0].transcript;
        el.searchInput.value = transcript;
        el.searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      };
      rec.onerror = () => {
        // fallback to fr-FR
        const rec2 = new SpeechRecognition();
        rec2.lang = 'fr-FR';
        rec2.onresult = (e) => {
          el.searchInput.value = e.results[0][0].transcript;
          el.searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        };
        try { rec2.start(); } catch {}
      };
      rec.onend = () => { voiceBtn.textContent = '🎤'; voiceBtn.style.background = 'rgba(139,92,246,0.15)'; };
      try { rec.start(); } catch (err) { console.warn('Voice start error', err); }
    });
  }

  // View All Navigation Buttons (from Home Preview Rows)
  document.querySelectorAll('.btn-view-all').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.navTarget;
      if (!target) return;
      const navItem = document.querySelector(`.nav-item[data-view="${target}"]`);
      if (navItem) {
        navItem.click();
      }
    });
  });

  // View All Arabic Movies Button (from Home Arabic Row)
  if (el.btnViewAllArabic) {
    el.btnViewAllArabic.addEventListener('click', () => {
      const moviesNav = document.querySelector('.nav-item[data-view="movies"]');
      if (moviesNav) moviesNav.click();
      state.movieCountry = 'ar';
      state.activeMovieGenre = '';
      if (el.movieCountrySelect) el.movieCountrySelect.value = 'ar';
      if (el.moviesGenreScroller) {
        el.moviesGenreScroller.querySelectorAll('.genre-chip').forEach((c) => {
          c.classList.toggle('active', c.dataset.movieCountry === 'ar');
        });
      }
      loadMoviesContent(false);
    });
  }

  // Movies Genre Filter Chips
  if (el.moviesGenreScroller) {
    el.moviesGenreScroller.querySelectorAll('.genre-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        el.moviesGenreScroller.querySelectorAll('.genre-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeMovieGenre = chip.dataset.movieGenre || '';
        state.movieCountry = chip.dataset.movieCountry || '';
        if (el.movieCountrySelect) el.movieCountrySelect.value = state.movieCountry;
        await loadMoviesContent(false);
      });
    });
  }

  // TV Genre Filter Chips
  if (el.tvGenreScroller) {
    el.tvGenreScroller.querySelectorAll('.genre-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        el.tvGenreScroller.querySelectorAll('.genre-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeTvGenre = chip.dataset.tvGenre || '';
        state.tvCountry = chip.dataset.tvCountry || '';
        if (el.tvCountrySelect) el.tvCountrySelect.value = state.tvCountry;
        await loadTvShowsContent(false);
      });
    });
  }

  // Mood Discovery Chips (AI intent → TMDB)
  if (el.moodScroller && el.moodGrid) {
    const moodMap = {
      ramadan: { mediaType:'movie', genreId:18, country:'ar', sort:'popularity.desc' },
      cozy: { mediaType:'movie', genreId:10749, country:'', sort:'vote_average.desc' },
      thrill: { mediaType:'movie', genreId:53, country:'', sort:'popularity.desc' },
      laugh: { mediaType:'movie', genreId:35, country:'', sort:'popularity.desc' },
      kids: { mediaType:'movie', genreId:16, country:'', sort:'popularity.desc' },
      arab: { mediaType:'movie', genreId:null, country:'ar', sort:'popularity.desc' },
      anime: { mediaType:'anime', genreId:null, country:'', sort:'popularity.desc' },
    };
    const moodLabel = (m) => { try { const c = (window.MAMZOUKA_CHIPS || {}).mood || {}; return (c[m] || {})[getCurrentLang()] || m; } catch { return m; } };
    el.moodScroller.querySelectorAll('.genre-chip').forEach(chip=>{
      chip.addEventListener('click', async ()=>{
        el.moodScroller.querySelectorAll('.genre-chip').forEach(c=>c.classList.remove('active'));
        chip.classList.add('active');
        const mood = chip.dataset.mood;
        const cfg = moodMap[mood];
        if(!cfg) return;
        el.moodGrid.style.display='grid';
        el.moodGrid.innerHTML='<div class="spinner"></div>';
        if(el.moodStatus){ el.moodStatus.style.display='block'; el.moodStatus.textContent = t('ui.moodLoading', 'Mood: {m} — loading...').replace('{m}', moodLabel(mood)); }
        try{
          const resp = await invoke('discover_media', { tmdb_language: getTmdbLanguage(), mediaType: cfg.mediaType, page: 1, genreId: cfg.genreId, sortBy: cfg.sort, country: cfg.country || null, year: null, minRating: null, language: null });
          renderGrid(el.moodGrid, resp.results.slice(0,12));
          if(el.moodStatus) el.moodStatus.textContent = t('ui.moodFound', 'Mood: {m} — {n} titles').replace('{m}', moodLabel(mood)).replace('{n}', resp.results.length);
        }catch(e){ if(el.moodGrid) el.moodGrid.innerHTML=`<div style="color:#ef4444; padding:12px;">${escapeHtml(t('ui.moodFail', 'Mood load failed: '))}${escapeHtml(String(e).slice(0,120))}</div>`; }
      });
    });
  }

  // Anime Genre Filter Chips
  if (el.animeGenreScroller) {
    el.animeGenreScroller.querySelectorAll('.genre-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        el.animeGenreScroller.querySelectorAll('.genre-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeAnimeGenre = chip.dataset.animeGenre || '';
        await loadAnimeContent(false);
      });
    });
  }

  // Movies Filter Dropdowns (Country, Sort, Year, Rating)
  if (el.movieCountrySelect) {
    el.movieCountrySelect.addEventListener('change', (e) => {
      state.movieCountry = e.target.value;
      if (el.moviesGenreScroller) {
        el.moviesGenreScroller.querySelectorAll('.genre-chip').forEach((c) => {
          if (c.dataset.movieCountry) {
            c.classList.toggle('active', c.dataset.movieCountry === state.movieCountry);
          } else if (!state.movieCountry && !state.activeMovieGenre) {
            c.classList.toggle('active', c.dataset.movieGenre === '' && !c.dataset.movieCountry);
          }
        });
      }
      loadMoviesContent(false);
    });
  }
  if (el.movieSortSelect) {
    el.movieSortSelect.addEventListener('change', (e) => {
      state.movieSort = e.target.value;
      loadMoviesContent(false);
    });
  }
  if (el.movieYearSelect) {
    el.movieYearSelect.addEventListener('change', (e) => {
      state.movieYear = e.target.value;
      loadMoviesContent(false);
    });
  }
  if (el.movieRatingSelect) {
    el.movieRatingSelect.addEventListener('change', (e) => {
      state.movieRating = parseFloat(e.target.value) || 0;
      loadMoviesContent(false);
    });
  }

  // Load More Movies Button
  if (el.btnLoadMoreMovies) {
    el.btnLoadMoreMovies.addEventListener('click', () => {
      state.moviePage += 1;
      loadMoviesContent(true);
    });
  }

  // TV Shows Filter Dropdowns (Country, Sort, Year, Rating)
  if (el.tvCountrySelect) {
    el.tvCountrySelect.addEventListener('change', (e) => {
      state.tvCountry = e.target.value;
      if (el.tvGenreScroller) {
        el.tvGenreScroller.querySelectorAll('.genre-chip').forEach((c) => {
          if (c.dataset.tvCountry) {
            c.classList.toggle('active', c.dataset.tvCountry === state.tvCountry);
          } else if (!state.tvCountry && !state.activeTvGenre) {
            c.classList.toggle('active', c.dataset.tvGenre === '' && !c.dataset.tvCountry);
          }
        });
      }
      loadTvShowsContent(false);
    });
  }
  if (el.tvSortSelect) {
    el.tvSortSelect.addEventListener('change', (e) => {
      state.tvSort = e.target.value;
      loadTvShowsContent(false);
    });
  }
  if (el.tvYearSelect) {
    el.tvYearSelect.addEventListener('change', (e) => {
      state.tvYear = e.target.value;
      loadTvShowsContent(false);
    });
  }
  if (el.tvRatingSelect) {
    el.tvRatingSelect.addEventListener('change', (e) => {
      state.tvRating = parseFloat(e.target.value) || 0;
      loadTvShowsContent(false);
    });
  }

  // Load More TV Series Button
  if (el.btnLoadMoreTv) {
    el.btnLoadMoreTv.addEventListener('click', () => {
      state.tvPage += 1;
      loadTvShowsContent(true);
    });
  }

  // Load More Anime Button
  if (el.btnLoadMoreAnime) {
    el.btnLoadMoreAnime.addEventListener('click', () => {
      state.animePage += 1;
      loadAnimeContent(true);
    });
  }

  // Hero Banner Buttons
  if (el.heroBtnPlay) {
    el.heroBtnPlay.addEventListener('click', () => {
      if (state.featuredItem) {
        openDetailsModal(state.featuredItem.id, state.featuredItem.media_type || 'movie');
      }
    });
  }

  if (el.heroBtnInfo) {
    el.heroBtnInfo.addEventListener('click', () => {
      if (state.featuredItem) {
        openDetailsModal(state.featuredItem.id, state.featuredItem.media_type || 'movie');
      }
    });
  }

  // Modal Close Button
  if (el.modalCloseBtn && el.detailsModal) {
    el.modalCloseBtn.addEventListener('click', () => {
      el.detailsModal.classList.remove('open');
    });

    el.detailsModal.addEventListener('click', (e) => {
      if (e.target === el.detailsModal) {
        el.detailsModal.classList.remove('open');
      }
    });
  }

  // Trailer Modal Controls
  if (el.trailerModalClose && el.trailerModal) {
    el.trailerModalClose.addEventListener('click', closeTrailerModal);
  }
  if (el.trailerModal) {
    el.trailerModal.addEventListener('click', (e) => {
      if (e.target === el.trailerModal) {
        closeTrailerModal();
      }
    });
  }

  // Watchlist Toggle Button
  if (el.modalWatchlistBtn) {
    el.modalWatchlistBtn.addEventListener('click', async () => {
      if (!state.selectedMedia) return;
      try {
        const item = {
          id: state.selectedMedia.id,
          title: state.selectedMedia.title,
          overview: state.selectedMedia.overview,
          poster_path: null,
          backdrop_path: null,
          poster_url: state.selectedMedia.poster_url,
          backdrop_url: state.selectedMedia.backdrop_url,
          release_date: state.selectedMedia.release_date,
          vote_average: state.selectedMedia.vote_average,
          vote_count: 0,
          media_type: state.selectedMedia.media_type,
          genre_ids: null,
          imdb_id: state.selectedMedia.imdb_id,
          original_title: null,
        };

        const isFav = await invoke('toggle_watchlist', { item });
        el.modalWatchlistBtn.textContent = isFav ? t('ui.watchlistIn', '✓ In Watchlist') : t('ui.watchlistAdd', '+ Add to Watchlist');
        await loadWatchlist();
      } catch (err) {
        console.error('Watchlist toggle error:', err);
      }
    });
  }

  // Settings Save (handled above - deduplicated)

  // ══════════════════════════════════════════════════════════════════════
  // Modern Cinematic Video Player Controls
  // ══════════════════════════════════════════════════════════════════════

  // 1. Play / Pause Controls & Center Play Pulse
  const togglePlayPause = () => {
    if (!el.mainVideo) return;
    if (el.mainVideo.paused || el.mainVideo.ended) {
      el.mainVideo.play().catch(() => {});
    } else {
      el.mainVideo.pause();
    }
  };

  if (el.playerBtnPlay) el.playerBtnPlay.addEventListener('click', togglePlayPause);
  if (el.playerCenterPlay) el.playerCenterPlay.addEventListener('click', togglePlayPause);

  if (el.mainVideo) {
    el.mainVideo.addEventListener('play', () => {
      updatePlayPauseButton(true);
      if (el.playerCenterPlay) el.playerCenterPlay.classList.remove('visible');
    });

    el.mainVideo.addEventListener('pause', () => {
      updatePlayPauseButton(false);
      if (el.playerCenterPlay) el.playerCenterPlay.classList.add('visible');
    });

    // Single click on video toggles Play/Pause, Double-click toggles Fullscreen
    let videoClickTimer = null;
    el.mainVideo.addEventListener('click', (e) => {
      e.stopPropagation();
      if (videoClickTimer) {
        clearTimeout(videoClickTimer);
        videoClickTimer = null;
        // Double click -> Fullscreen
        if (el.playerBtnFullscreen) el.playerBtnFullscreen.click();
      } else {
        videoClickTimer = setTimeout(() => {
          videoClickTimer = null;
          togglePlayPause();
        }, 220);
      }
    });
  }

  // 2. Skip Backward / Forward 10s
  if (el.playerBtnBackward10 && el.mainVideo) {
    el.playerBtnBackward10.addEventListener('click', () => {
      el.mainVideo.currentTime = Math.max(0, el.mainVideo.currentTime - 10);
    });
  }

  if (el.playerBtnForward10 && el.mainVideo) {
    el.playerBtnForward10.addEventListener('click', () => {
      el.mainVideo.currentTime = Math.min(el.mainVideo.duration || 0, el.mainVideo.currentTime + 10);
    });
  }

  // 3. Time Update & Buffer Fill + Watch Progress Save (every 5s)
  let lastProgressSave = 0;
  if (el.mainVideo) {
    el.mainVideo.addEventListener('timeupdate', () => {
      const cur = el.mainVideo.currentTime;
      const dur = el.mainVideo.duration || 0;
      const pct = dur > 0 ? (cur / dur) * 100 : 0;
      if (el.playerProgressFill) el.playerProgressFill.style.width = `${pct}%`;
      if (el.playerProgressThumb) el.playerProgressThumb.style.left = `${pct}%`;
      if (el.playerTime) el.playerTime.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;

      // Update buffer bar
      if (el.playerBufferFill && el.mainVideo.buffered && el.mainVideo.buffered.length > 0) {
        try {
          const bufferedEnd = el.mainVideo.buffered.end(el.mainVideo.buffered.length - 1);
          const bufPct = dur > 0 ? (bufferedEnd / dur) * 100 : 0;
          el.playerBufferFill.style.width = `${Math.min(100, bufPct)}%`;
        } catch (e) {}
      }
      // Persist watch progress every 5s if we have selected media
      if (state.selectedMedia && dur > 30 && cur > 5 && Date.now() - lastProgressSave > 5000) {
        lastProgressSave = Date.now();
        const prog = {
          media_id: state.selectedMedia.id,
          media_type: state.selectedMedia.media_type || 'movie',
          title: state.selectedMedia.title,
          poster_url: state.selectedMedia.poster_url || null,
          backdrop_url: state.selectedMedia.backdrop_url || null,
          season: currentSeasonParam || null,
          episode: currentEpisodeParam || null,
          current_time_sec: cur,
          duration_sec: dur,
          last_watched_timestamp: Math.floor(Date.now()/1000)
        };
        invoke('update_watch_progress', { progress: prog }).catch(()=>{}).then(()=> { if (state.currentView === 'discover') loadContinueWatching(); });
        // Smart Offline: at 90% of a series episode, silently queue the NEXT episode
        // download once (guarded), if the user enabled Smart Offline.
        try { maybeSmartOfflineNext(prog); } catch {}
      }
    });
    // Restore resume time and setup chapters on metadata
    el.mainVideo.addEventListener('loadedmetadata', () => {
      let resume = el.mainVideo.dataset.resumeTime;
      if (!resume) resume = sessionStorage.getItem('mamzouka_pending_resume');
      if (resume) {
        const t = parseFloat(resume);
        if (t > 10 && t < el.mainVideo.duration - 10) el.mainVideo.currentTime = t;
        delete el.mainVideo.dataset.resumeTime;
        sessionStorage.removeItem('mamzouka_pending_resume');
      }
      try{ setupChapters(el.mainVideo.duration); }catch{}
      trackEvent('video_loaded', {duration: el.mainVideo.duration, title: state.selectedMedia?state.selectedMedia.title:''});
    });
  }

  // 4. Interactive Progress Bar Scrubbing & Hover Tooltip
  if (el.playerProgressBar && el.mainVideo) {
    let isScrubbing = false;

    const updateSeekPos = (e) => {
      const rect = el.playerProgressBar.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const targetTime = pos * (el.mainVideo.duration || 0);
      el.mainVideo.currentTime = targetTime;
      if (el.playerProgressFill) el.playerProgressFill.style.width = `${pos * 100}%`;
      if (el.playerProgressThumb) el.playerProgressThumb.style.left = `${pos * 100}%`;
    };

    el.playerProgressBar.addEventListener('mousedown', (e) => {
      isScrubbing = true;
      updateSeekPos(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (isScrubbing) updateSeekPos(e);
    });

    window.addEventListener('mouseup', () => {
      isScrubbing = false;
    });

    // Tooltip on hover
    el.playerProgressBar.addEventListener('mousemove', (e) => {
      const rect = el.playerProgressBar.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetTime = pos * (el.mainVideo.duration || 0);
      if (el.playerProgressTooltip) {
        el.playerProgressTooltip.style.left = `${pos * 100}%`;
        el.playerProgressTooltip.textContent = formatTime(targetTime);
      }
    });
  }

  // 5. Volume & Mute Controls
  const updateVolumeIcon = (vol, isMuted) => {
    if (!el.playerBtnMute) return;
    if (isMuted || vol === 0) {
      el.playerBtnMute.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
    } else if (vol < 0.5) {
      el.playerBtnMute.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    } else {
      el.playerBtnMute.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    }
  };

  if (el.playerVolume && el.mainVideo) {
    el.playerVolume.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      el.mainVideo.volume = val;
      el.mainVideo.muted = val === 0;
      updateVolumeIcon(val, el.mainVideo.muted);
    });
  }

  if (el.playerBtnMute && el.mainVideo) {
    el.playerBtnMute.addEventListener('click', () => {
      el.mainVideo.muted = !el.mainVideo.muted;
      if (el.playerVolume) el.playerVolume.value = el.mainVideo.muted ? 0 : el.mainVideo.volume;
      updateVolumeIcon(el.mainVideo.volume, el.mainVideo.muted);
    });
  }

  // 6. Playback Speed Menu
  if (el.playerBtnSpeed && el.speedMenu && el.mainVideo) {
    el.playerBtnSpeed.addEventListener('click', (e) => {
      e.stopPropagation();
      el.speedMenu.classList.toggle('open');
      if (el.subtitlesMenu) el.subtitlesMenu.classList.remove('open');
    });

    el.speedMenu.querySelectorAll('.speed-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const spd = parseFloat(item.dataset.speed || '1');
        el.mainVideo.playbackRate = spd;
        el.playerBtnSpeed.textContent = `${spd}x`;
        el.speedMenu.querySelectorAll('.speed-item').forEach((i) => i.classList.remove('active'));
        item.classList.add('active');
        el.speedMenu.classList.remove('open');
      });
    });
  }

  // 7. Subtitles Menu
  if (el.playerBtnSubs && el.subtitlesMenu) {
    el.playerBtnSubs.addEventListener('click', (e) => {
      e.stopPropagation();
      el.subtitlesMenu.classList.toggle('open');
      if (el.speedMenu) el.speedMenu.classList.remove('open');
    });

    document.addEventListener('click', (e) => {
      if (el.subtitlesMenu && !el.subtitlesMenu.contains(e.target) && e.target !== el.playerBtnSubs) {
        el.subtitlesMenu.classList.remove('open');
      }
      if (el.speedMenu && !el.speedMenu.contains(e.target) && e.target !== el.playerBtnSpeed) {
        el.speedMenu.classList.remove('open');
      }
    });
  }

  // Subtitle Translate via MyMemory — target follows the APP language
  const translateBtn = document.getElementById('btn-translate-subs');
  if (translateBtn) {
    translateBtn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const active = el.subtitlesList ? el.subtitlesList.querySelector('.sub-item.active') : null;
      const url = active ? active.dataset.url : null;
      if(!url){ alert(t('dlg.subFirst', 'Select a subtitle first')); return; }
      const target2 = getCurrentLang() === 'fr' ? 'fr' : getCurrentLang() === 'ar' ? 'ar' : 'en';
      translateBtn.textContent=t('ui.translating', 'Translating...');
      try{
        const proxyUrl = `http://127.0.0.1:${state.serverPort}/proxy/subtitle?url=${encodeURIComponent(url)}`;
        const vtt = await fetch(proxyUrl).then(r=>r.text());
        // Translate via MyMemory in chunks (first 800 chars demo)
        const chunk = vtt.slice(0,1200);
        const transRes = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|${target2}`).then(r=>r.json());
        const translated = transRes.responseData?.translatedText || chunk;
        const blob = new Blob([translated], {type:'text/vtt'});
        const blobUrl = URL.createObjectURL(blob);
        const track = document.createElement('track');
        track.kind='subtitles'; track.label=t('ui.translatedLabel', 'Translated'); track.srclang=target2; track.src=blobUrl; track.default=true;
        if(el.mainVideo){ el.mainVideo.querySelectorAll('track').forEach(t=>t.remove()); el.mainVideo.appendChild(track); track.mode='showing'; }
        translateBtn.textContent='✅ OK';
        setTimeout(()=>translateBtn.textContent=t('ui.translateBtn', '🌐 Translate'),2000);
      }catch(err){ translateBtn.textContent=t('ui.translateFail', '❌ Failed'); console.warn(err); }
    });
  }

  // 8. Picture in Picture (PiP)
  if (el.playerBtnPip && el.mainVideo) {
    el.playerBtnPip.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (el.mainVideo.readyState >= 1) {
          await el.mainVideo.requestPictureInPicture();
        }
      } catch (err) {
        console.warn('PiP error:', err);
      }
    });
  }

  // 9. Fullscreen Toggle
  if (el.playerBtnFullscreen && el.playerView) {
    el.playerBtnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        el.playerView.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
      resetOverlayTimer();
    });
  }

  // 10. Auto-Hide Player Controls on Idle Mouse
  let overlayIdleTimer = null;
  const resetOverlayTimer = () => {
    if (!el.playerOverlay || !el.playerView) return;
    el.playerOverlay.classList.remove('idle');
    el.playerView.style.cursor = 'default';

    if (overlayIdleTimer) clearTimeout(overlayIdleTimer);

    // Active playback check: either HTML5 video playing OR an external iframe is active
    const isIframePlaying = el.mainIframe && el.mainIframe.style.display !== 'none' && el.mainIframe.src && el.mainIframe.src !== 'about:blank';
    const isVideoPlaying = el.mainVideo && !el.mainVideo.paused && el.mainVideo.style.display !== 'none';
    const isPlaying = isVideoPlaying || isIframePlaying;

    if (isPlaying) {
      overlayIdleTimer = setTimeout(() => {
        const isMenuOpen = (el.subtitlesMenu && el.subtitlesMenu.classList.contains('open')) ||
                           (el.speedMenu && el.speedMenu.classList.contains('open')) ||
                           (el.audioMenu && el.audioMenu.classList.contains('open')) ||
                           (el.aspectMenu && el.aspectMenu.classList.contains('open')) ||
                           (el.filterPanel && el.filterPanel.classList.contains('open')) ||
                           (el.episodeDrawer && el.episodeDrawer.classList.contains('open'));

        if (el.playerOverlay && !isMenuOpen) {
          el.playerOverlay.classList.add('idle');
          el.playerView.style.cursor = 'none';
        }
      }, 2500);
    }
  };

  if (el.playerView) {
    el.playerView.addEventListener('mousemove', resetOverlayTimer);
    el.playerView.addEventListener('click', resetOverlayTimer);
    el.playerView.addEventListener('mouseleave', () => {
      const isIframePlaying = el.mainIframe && el.mainIframe.style.display !== 'none' && el.mainIframe.src && el.mainIframe.src !== 'about:blank';
      const isVideoPlaying = el.mainVideo && !el.mainVideo.paused && el.mainVideo.style.display !== 'none';
      if (isVideoPlaying || isIframePlaying) {
        if (overlayIdleTimer) clearTimeout(overlayIdleTimer);
        overlayIdleTimer = setTimeout(() => {
          if (el.playerOverlay) {
            el.playerOverlay.classList.add('idle');
            el.playerView.style.cursor = 'none';
          }
        }, 600);
      }
    });
  }

  document.addEventListener('fullscreenchange', () => {
    if (el.playerView && el.playerView.classList.contains('active')) {
      resetOverlayTimer();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (el.playerView && el.playerView.classList.contains('active')) {
      resetOverlayTimer();
    }
  }, { passive: true });

  // 11. Player Back Button (with radio mini-player support)
  if (el.playerBtnBack && el.playerView) {
    el.playerBtnBack.addEventListener('click', () => {
      if (state.isRadio && el.mainVideo && !el.mainVideo.paused) {
        // Minimize radio to mini-player instead of stopping
        const title = el.playerMediaTitle ? el.playerMediaTitle.textContent : 'Radio';
        const sub = el.playerStreamStats ? el.playerStreamStats.textContent : 'Live';
        el.playerView.classList.remove('active');
        showMiniPlayer(title, sub);
        return;
      }
      if (state.torrentStatsInterval) {
        clearInterval(state.torrentStatsInterval);
        state.torrentStatsInterval = null;
      }
      if (activeHls) {
        activeHls.destroy();
        activeHls = null;
      }
      state.isRadio = false;
      hideMiniPlayer();
      if (el.mainVideo) {
        el.mainVideo.pause();
        el.mainVideo.removeAttribute('src');
      }
      if (el.mainIframe) {
        el.mainIframe.src = 'about:blank';
        el.mainIframe.style.display = 'none';
      }
      el.playerView.classList.remove('active');
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      if (state.selectedMedia && el.detailsModal) {
        el.detailsModal.classList.add('open');
      }
    });
  }

  // 11b. Mini-player controls
  if (el.miniPlayerPlay) {
    el.miniPlayerPlay.addEventListener('click', () => {
      if (!el.mainVideo) return;
      if (el.mainVideo.paused) { el.mainVideo.play().catch(()=>{}); el.miniPlayerPlay.textContent='⏸'; }
      else { el.mainVideo.pause(); el.miniPlayerPlay.textContent='▶'; }
    });
  }
  if (el.miniPlayerClose) {
    el.miniPlayerClose.addEventListener('click', () => {
      if (el.mainVideo) { el.mainVideo.pause(); el.mainVideo.removeAttribute('src'); }
      state.isRadio = false;
      hideMiniPlayer();
    });
  }
  if (el.miniPlayerExpand) {
    el.miniPlayerExpand.addEventListener('click', () => {
      hideMiniPlayer();
      if (el.playerView) el.playerView.classList.add('active');
    });
  }

  // 12. Player Quick Server Switcher Chips
  if (el.playerServerBar) {
    el.playerServerBar.querySelectorAll('.player-server-chip[data-server]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const srv = chip.dataset.server;
        if (srv) switchPlayerServer(srv);
      });
    });
  }

  // 13. Player Quick VLC Button
  if (el.playerBtnQuickVlc) {
    el.playerBtnQuickVlc.addEventListener('click', async () => {
      if (state.activeStream) {
        const streamTarget = state.activeStream.stream_url || state.activeStream.magnet_uri;
        if (streamTarget) {
          try {
            await invoke('open_in_vlc', { streamUrl: streamTarget });
          } catch (vlcErr) {
            console.error('Quick VLC launch error:', vlcErr);
          }
        }
      }
    });
  }

  // 13b. Watch Party — copy link with timestamp
  const watchPartyBtn = document.getElementById('player-btn-watchparty');
  // BroadcastChannel sync for local Watch Party (same WiFi / multiple windows)
  try{
    partyChannel = new BroadcastChannel('mamzouka-watch-party');
    partyChannel.onmessage = (e)=>{
      const d=e.data;
      if(!d||d.type!=='sync') return;
      if(state.selectedMedia && d.mediaId && d.mediaId!==state.selectedMedia.id) return;
      if(el.mainVideo && typeof d.time==='number'){
        const diff=Math.abs(el.mainVideo.currentTime - d.time);
        if(diff>1.5) el.mainVideo.currentTime = d.time;
        if(d.paused!==undefined){
          if(d.paused) el.mainVideo.pause(); else el.mainVideo.play().catch(()=>{});
        }
      }
    };
    if(el.mainVideo){
      ['seeked','pause','play'].forEach(ev=>{
        el.mainVideo.addEventListener(ev, ()=>{
          if(!partyChannel || !state.selectedMedia) return;
          try{ partyChannel.postMessage({type:'sync', mediaId: state.selectedMedia.id, time: el.mainVideo.currentTime, paused: el.mainVideo.paused}); }catch{}
        });
      });
    }
  }catch{}
  if (watchPartyBtn) {
    watchPartyBtn.addEventListener('click', async () => {
      const cur = el.mainVideo ? Math.floor(el.mainVideo.currentTime) : 0;
      const media = state.selectedMedia;
      const tParam = cur ? `&t=${cur}` : '';
      const link = media ? `mamzouka://watch/${media.media_type}/${media.id}${currentSeasonParam ? `/s${currentSeasonParam}e${currentEpisodeParam}` : ''}?${tParam}` : `mamzouka://watch?t=${cur}`;
      try { await navigator.clipboard.writeText(link); watchPartyBtn.innerHTML=`<span>${escapeHtml(t('dlg.partyCopied', '✓ Copied'))}</span>`; setTimeout(()=>watchPartyBtn.innerHTML=`<span>${escapeHtml(t('ui.partyBtn', '👥 Party'))}</span>`,1200); } catch { prompt(t('ui.partyTitle', 'Watch Party')+':', link); }
      try{ if(partyChannel) partyChannel.postMessage({type:'sync', mediaId: media?media.id:null, time: cur, paused: el.mainVideo?el.mainVideo.paused:false}); }catch{}
      trackEvent('watch_party_share', {mediaId: media?media.id:null, time: cur});
    });
  }

  // 13c. Command Palette (Ctrl+K)
  const palette = document.getElementById('command-palette');
  const palInput = document.getElementById('command-input');
  const palList = document.getElementById('command-list');
  const helpOverlay = document.getElementById('shortcuts-help');
  const palCommands = [
    { id:'discover', label:'Go to Discover', action:()=> document.querySelector('[data-view=\"discover\"]')?.click() },
    { id:'movies', label:'Go to Movies', action:()=> document.querySelector('[data-view=\"movies\"]')?.click() },
    { id:'tv', label:'Go to TV Series', action:()=> document.querySelector('[data-view=\"tv\"]')?.click() },
    { id:'anime', label:'Go to Anime', action:()=> document.querySelector('[data-view=\"anime\"]')?.click() },
    { id:'livetv', label:'Go to Live TV', action:()=> document.querySelector('[data-view=\"livetv\"]')?.click() },
    { id:'radio', label:'Go to Radio', action:()=> document.querySelector('[data-view=\"radio\"]')?.click() },
    { id:'downloads', label:'Go to Downloads', action:()=> document.querySelector('[data-view=\"downloads\"]')?.click() },
    { id:'settings', label:'Go to Settings', action:()=> document.querySelector('[data-view=\"settings\"]')?.click() },
    { id:'kids', label:'Toggle Kids Mode', action:()=> { if(el.settingKidsMode){ el.settingKidsMode.checked=!el.settingKidsMode.checked; el.settingKidsMode.dispatchEvent(new Event('change')); } } },
    { id:'clearhist', label:'Clear Search History', action:()=>{ localStorage.removeItem('mamzouka_search_history'); alert(t('dlg.histCleared', 'History cleared')); } },
    { id:'export', label:'Export Sync JSON', action:()=> el.btnExportSync?.click() },
  ];
  const renderPalette = (q='')=>{
    const filt = palCommands.filter(c=> c.label.toLowerCase().includes(q.toLowerCase()));
    palList.innerHTML = filt.map(c=>`<div class="pal-item" data-id="${c.id}" style="padding:10px 12px; cursor:pointer; border-radius:8px; hover:background:rgba(255,255,255,0.06);">${c.label}</div>`).join('') || `<div style="padding:12px; color:var(--text-muted);">${escapeHtml(t('ui.noItems', 'No items found.'))}</div>`;
    palList.querySelectorAll('.pal-item').forEach(it=> it.addEventListener('click', ()=>{ const cmd=palCommands.find(c=>c.id===it.dataset.id); palette.style.display='none'; palInput.value=''; if(cmd) cmd.action(); }));
  };
  const openPalette = ()=>{ palette.style.display='flex'; palInput.value=''; renderPalette(''); setTimeout(()=>palInput.focus(),50); };
  const closePalette = ()=>{ palette.style.display='none'; };
  document.getElementById('btn-command-palette')?.addEventListener('click', openPalette);
  palInput?.addEventListener('input', e=> renderPalette(e.target.value));
  palInput?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ const first=palList.querySelector('.pal-item'); if(first) first.click(); } if(e.key==='Escape') closePalette(); });
  palette?.addEventListener('click', e=>{ if(e.target===palette) closePalette(); });
  document.getElementById('close-shortcuts')?.addEventListener('click', ()=> helpOverlay.style.display='none');
  helpOverlay?.addEventListener('click', e=>{ if(e.target===helpOverlay) helpOverlay.style.display='none'; });

  // Profiles (localStorage isolated view — backend single file, UI-level)
  const profilesBtn = document.getElementById('btn-profiles');
  const profileBadge = document.getElementById('profile-badge');
  const PROFILES_KEY='mamzouka_profiles', ACTIVE_KEY='mamzouka_active_profile';
  const getProfiles=()=>{ try{ return JSON.parse(localStorage.getItem(PROFILES_KEY)||'["Default"]'); }catch{ return ["Default"]; } };
  const getActive=()=> localStorage.getItem(ACTIVE_KEY)||"Default";
  const setActive=(name)=>{ localStorage.setItem(ACTIVE_KEY,name); if(profileBadge) profileBadge.textContent = getProfiles().length; };
  if(profileBadge) profileBadge.textContent = getProfiles().length;
  if(profilesBtn){
    profilesBtn.addEventListener('click', ()=>{
      const profiles=getProfiles();
      const active=getActive();
      const choice = prompt(t('dlg.profilePrompt', 'Profiles: {list}\nActive: {active}\n\nEnter name to switch/create, or leave empty to cancel:').replace('{list}', profiles.join(', ')).replace('{active}', active));
      if(!choice) return;
      const name=choice.trim().slice(0,20);
      if(!name) return;
      let updated=profiles;
      if(!profiles.includes(name)){ updated=[...profiles,name]; localStorage.setItem(PROFILES_KEY, JSON.stringify(updated)); }
      setActive(name);
      alert(t('dlg.profileSwitched', 'Switched to profile "{n}"').replace('{n}', name));
      location.reload();
    });
  }

  // 14. Keyboard Shortcuts + Global Palette
  window.addEventListener('keydown', (e) => {
    // Palette/help global (when not in input except Escape)
    const tag = e.target.tagName ? e.target.tagName.toLowerCase() : '';
    const isInput = tag==='input' || tag==='textarea';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); const p=document.getElementById('command-palette'); if(p){ p.style.display = p.style.display==='flex' ? 'none' : 'flex'; if(p.style.display==='flex') document.getElementById('command-input')?.focus(); } return; }
    if (e.key==='/' && !isInput && !(el.playerView && el.playerView.classList.contains('active'))){ e.preventDefault(); el.searchInput?.focus(); return; }
    if (e.key==='?' && !isInput){ const h=document.getElementById('shortcuts-help'); if(h){ h.style.display = h.style.display==='flex' ? 'none':'flex'; } return; }
    if (e.key === 'Escape') {
      if (el.forceUpdateModal && el.forceUpdateModal.style.display === 'flex') {
        if (isAppExpired()) {
          return; // Strictly unclosable when expired — tamper-proof
        } else {
          hideForceUpdateModal();
          return;
        }
      }
      const pal=document.getElementById('command-palette'); if(pal && pal.style.display==='flex'){ pal.style.display='none'; return; }
      const help=document.getElementById('shortcuts-help'); if(help && help.style.display==='flex'){ help.style.display='none'; return; }
      if (el.trailerModal && el.trailerModal.classList.contains('open')) {
        closeTrailerModal();
        return;
      }
      if (el.detailsModal && el.detailsModal.classList.contains('open') && (!el.playerView || !el.playerView.classList.contains('active'))) {
        el.detailsModal.classList.remove('open');
        return;
      }
    }

    if (el.playerView && el.playerView.classList.contains('active')) {
      resetOverlayTimer();
      const tag = e.target.tagName ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea') return;

      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.key === 'ArrowLeft' || e.key === 'j') {
        e.preventDefault();
        if (el.mainVideo) el.mainVideo.currentTime = Math.max(0, el.mainVideo.currentTime - 10);
      } else if (e.key === 'ArrowRight' || e.key === 'l') {
        e.preventDefault();
        if (el.mainVideo) el.mainVideo.currentTime = Math.min(el.mainVideo.duration || 0, el.mainVideo.currentTime + 10);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (el.mainVideo) {
          el.mainVideo.volume = Math.min(1, el.mainVideo.volume + 0.1);
          if (el.playerVolume) el.playerVolume.value = el.mainVideo.volume;
          updateVolumeIcon(el.mainVideo.volume, el.mainVideo.muted);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (el.mainVideo) {
          el.mainVideo.volume = Math.max(0, el.mainVideo.volume - 0.1);
          if (el.playerVolume) el.playerVolume.value = el.mainVideo.volume;
          updateVolumeIcon(el.mainVideo.volume, el.mainVideo.muted);
        }
      } else if (e.key === 'm') {
        e.preventDefault();
        if (el.playerBtnMute) el.playerBtnMute.click();
      } else if (e.key === 'f') {
        e.preventDefault();
        if (el.playerBtnFullscreen) el.playerBtnFullscreen.click();
      } else if (e.key === 'Escape') {
        if (el.playerBtnBack) el.playerBtnBack.click();
      }
    }
  });
}

// ==========================================================================
// Modern Player 2026 — Netflix/Stremio Grade Upgrade
// ==========================================================================

let audioCtx = null;
let gainNode = null;
let compressorNode = null;
let mediaSourceNode = null;
let ambientRAF = null;
let ambientEnabled = false;
let scrubRAF = null;
let failoverTimer = null;
let bufferingStart = 0;
let nextEpCountdownTimer = null;
let nextEpRemaining = 10;
let watchedMarked = new Set();
let partyChannel = null;

// ——— Init orchestrator ———
function initModernPlayer() {
  if (!el.mainVideo) return;
  ambientEnabled = state.ambientOn;
  if (ambientEnabled) el.playerView && el.playerView.classList.add('ambient-on');
  // Restore visual states
  applyAspectMode(state.aspectMode);
  applyFilterVals(state.filterVals);
  if (el.videoWrapper) {
    const b = state.playerBrightness;
    if (b !== 100) el.videoWrapper.style.setProperty('--player-brightness', String(b/100));
  }
  initAudioProcessing();
  initSubtitles2();
  initAmbientGlow();
  initAspectSwitcher();
  initFilters();
  initThumbnailScrub();
  initGestures();
  initBingeFeatures();
  initFailover();
  initPlaybackPersistenceMod();
  initModernControls();
  console.log('[Mamzouka Modern] Player 2026 ready — Subtitles 2.0, Audio Boost 250%, Ambient, Binge, Gestures, Failover');
}

// ——— Audio Processing ———
function ensureAudioGraph() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    compressorNode = audioCtx.createDynamicsCompressor();
    // Dialogue boost defaults
    compressorNode.threshold.value = -24;
    compressorNode.knee.value = 30;
    compressorNode.ratio.value = 12;
    compressorNode.attack.value = 0.003;
    compressorNode.release.value = 0.25;
    mediaSourceNode = audioCtx.createMediaElementSource(el.mainVideo);
    // Initially bypass compressor; connect via gain
    mediaSourceNode.connect(gainNode);
    if (state.nightMode) {
      gainNode.connect(compressorNode);
      compressorNode.connect(audioCtx.destination);
    } else {
      gainNode.connect(audioCtx.destination);
    }
    gainNode.gain.value = Math.max(0, Math.min(2.5, state.audioBoost));
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
  } catch (e) { console.warn('AudioContext init failed', e); }
}

function updateVolumeBoost(valPercent) {
  const gain = Math.max(0, Math.min(2.5, valPercent/100));
  state.audioBoost = gain;
  localStorage.setItem('mamzouka_boost', String(valPercent));
  if (!audioCtx) ensureAudioGraph();
  if (gainNode) {
    try { gainNode.gain.value = gain; } catch {}
  }
  // Sync native volume slider visually: 0-100 mapped to 0-1; above 100 keep slider at 1 but show boost label
  if (el.mainVideo) {
    if (gain > 1) {
      el.mainVideo.volume = 1;
      if (el.playerVolume) el.playerVolume.value = '1';
    }
  }
  if (el.volumeBoostLabel) el.volumeBoostLabel.textContent = Math.round(valPercent)+'%';
  if (el.boostValueLabel) el.boostValueLabel.textContent = Math.round(valPercent)+'%';
  if (el.volumeBoostSlider) el.volumeBoostSlider.value = String(valPercent);
  // Update OSD icon colour when boosted
  if (el.volumeOsdText) el.volumeOsdText.textContent = Math.round(valPercent)+'%';
}

function setNightMode(on) {
  state.nightMode = !!on;
  localStorage.setItem('mamzouka_night', on ? '1':'0');
  if (el.nightModeToggle) el.nightModeToggle.checked = !!on;
  if (el.playerBtnNight) {
    el.playerBtnNight.style.background = on ? 'rgba(34,197,94,0.22)' : '';
    el.playerBtnNight.style.borderColor = on ? 'rgba(34,197,94,0.4)' : '';
  }
  if (!audioCtx || !gainNode || !compressorNode || !mediaSourceNode) {
    if (on) ensureAudioGraph();
    return;
  }
  try {
    // Re-wire
    try { mediaSourceNode.disconnect(); } catch {}
    try { gainNode.disconnect(); } catch {}
    try { compressorNode.disconnect(); } catch {}
    mediaSourceNode.connect(gainNode);
    if (on) {
      gainNode.connect(compressorNode);
      compressorNode.connect(audioCtx.destination);
    } else {
      gainNode.connect(audioCtx.destination);
    }
  } catch(e){ console.warn('Night mode wire error', e); }
}

function populateAudioTracks() {
  if (!el.audioTracksList) return;
  const tracks = [];
  // HTML5 audioTracks (Firefox, Safari)
  if (el.mainVideo && el.mainVideo.audioTracks && el.mainVideo.audioTracks.length) {
    for (let i=0;i<el.mainVideo.audioTracks.length;i++) {
      const t = el.mainVideo.audioTracks[i];
      tracks.push({ id: i, label: t.label || t.language || `Track ${i+1}`, lang: t.language || '', enabled: t.enabled, kind: 'native' });
    }
  }
  // HLS audio tracks
  if (activeHls && activeHls.audioTracks && activeHls.audioTracks.length) {
    activeHls.audioTracks.forEach((t, idx)=>{
      tracks.push({ id: idx, label: t.name || t.lang || t('ui.audioN', 'Audio {n}').replace('{n}', idx+1), lang: t.lang||'', enabled: idx===activeHls.audioTrack, kind: 'hls' });
    });
  }
  if (tracks.length===0) {
    el.audioTracksList.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; padding:8px;">' + escapeHtml(t('ui.noTracksLong', 'Single audio track — no alternatives detected.')) + '</div>';
    return;
  }
  el.audioTracksList.innerHTML = tracks.map(tr=> `
    <div class="menu-item ${tr.enabled?'active':''}" data-aidx="${tr.id}" data-kind="${tr.kind}" style="display:flex; justify-content:space-between; align-items:center;">
      <span>🎧 ${escapeHtml(tr.label)} ${tr.lang?`(${tr.lang})`:''}</span>
      <span style="font-size:0.72rem; color:${tr.enabled?'var(--accent-cyan)':'var(--text-muted)'};">${tr.enabled ? '● ' + escapeHtml(t('ui.trackActive', 'Active')) : ''}</span>
    </div>
  `).join('');
  el.audioTracksList.querySelectorAll('.menu-item').forEach(mi=>{
    mi.addEventListener('click', ()=>{
      const idx = parseInt(mi.dataset.aidx,10);
      const kind = mi.dataset.kind;
      if (kind==='hls' && activeHls) {
        activeHls.audioTrack = idx;
      } else if (el.mainVideo && el.mainVideo.audioTracks) {
        for(let i=0;i<el.mainVideo.audioTracks.length;i++) el.mainVideo.audioTracks[i].enabled = (i===idx);
      }
      el.audioTracksList.querySelectorAll('.menu-item').forEach(x=>x.classList.remove('active'));
      mi.classList.add('active');
    });
  });
}

function initAudioProcessing() {
  // Hook play to ensure context resumed (autoplay policy)
  if (el.mainVideo) {
    ['play','click','touchstart'].forEach(ev=>{
      el.mainVideo.addEventListener(ev, ()=>{
        if (audioCtx && audioCtx.state==='suspended') audioCtx.resume().catch(()=>{});
        if (!audioCtx && (state.audioBoost!==1 || state.nightMode)) ensureAudioGraph();
      }, { once: false });
    });
  }
  if (el.volumeBoostSlider) {
    el.volumeBoostSlider.value = String(Math.round(state.audioBoost*100));
    el.volumeBoostSlider.addEventListener('input', (e)=> updateVolumeBoost(parseInt(e.target.value,10)||100));
  }
  if (el.nightModeToggle) {
    el.nightModeToggle.checked = !!state.nightMode;
    el.nightModeToggle.addEventListener('change', (e)=> setNightMode(e.target.checked));
  }
  if (el.playerBtnNight) {
    el.playerBtnNight.addEventListener('click', ()=>{
      const on = !state.nightMode;
      setNightMode(on);
      // brief feedback
      el.playerBtnNight.textContent = on ? '☀️' : '🌙';
      setTimeout(()=> el.playerBtnNight.textContent='🌙', 900);
    });
  }
  if (el.playerBtnAudio) {
    el.playerBtnAudio.addEventListener('click', (e)=>{
      e.stopPropagation();
      if (!el.audioMenu) return;
      const vis = el.audioMenu.style.display==='flex';
      closeAllPlayerMenus();
      if (!vis) { populateAudioTracks(); el.audioMenu.style.display='flex'; ensureAudioGraph(); }
    });
  }
  // Initial UI
  updateVolumeBoost(Math.round(state.audioBoost*100));
  setNightMode(state.nightMode);
  // Enhance mute to also zero gain visually
  if (el.mainVideo) {
    el.mainVideo.addEventListener('volumechange', ()=>{
      if (!el.volumeBoostLabel) return;
      if (el.mainVideo.muted || el.mainVideo.volume===0) {
        el.volumeBoostLabel.textContent = 'Muted';
      } else {
        const pct = Math.round(state.audioBoost*100);
        el.volumeBoostLabel.textContent = pct+'%';
      }
    });
  }
}

// ——— Subtitles 2.0 Engine ———
let subPrimaryCues = [];
let subSecondaryCues = [];
let subActiveUrl = '';
let subSecondaryUrl = '';
let subRenderRAF = null;

function parseVTT(text) {
  const cues = [];
  const lines = text.replace(/\r/g,'').split('\n');
  let i=0;
  const timeRe = /(\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?/;
  const toSec = (t)=>{
    t=t.replace(',','.');
    const parts=t.split(':');
    let sec=0;
    if(parts.length===3) sec=parseInt(parts[0],10)*3600+parseInt(parts[1],10)*60+parseFloat(parts[2]);
    else if(parts.length===2) sec=parseInt(parts[0],10)*60+parseFloat(parts[1]);
    else sec=parseFloat(parts[0]);
    return sec;
  };
  while(i<lines.length){
    const line = lines[i].trim();
    const m = line.match(timeRe);
    if(m){
      const times = line.split('-->');
      const start = toSec(times[0].trim());
      const end = toSec(times[1].split(' ')[0].trim());
      i++;
      let txt='';
      while(i<lines.length && lines[i].trim()!==''){
        txt += (txt?'\n':'')+lines[i];
        i++;
      }
      // strip tags
      txt = txt.replace(/<[^>]+>/g,'').trim();
      if(txt) cues.push({ start, end, text: txt });
    } else i++;
  }
  return cues;
}
function parseSRT(text){ return parseVTT(text); }

function cuesAt(time, cues, delayMs){
  const t = time + delayMs/1000;
  return cues.filter(c=> t>=c.start && t<=c.end).map(c=>c.text).join('\n');
}

function renderSubtitlesLoop(){
  if (!el.mainVideo || !el.subPrimary || !el.subSecondary) return;
  const cur = el.mainVideo.currentTime || 0;
  const dur = el.mainVideo.duration || 0;
  // Do not show when paused? keep showing? Show always while active
  const primaryText = subPrimaryCues.length ? cuesAt(cur, subPrimaryCues, state.subDelayMs) : '';
  const secondaryText = (state.subDualEnabled && subSecondaryCues.length) ? cuesAt(cur, subSecondaryCues, state.subDelayMs) : '';
  if (primaryText) {
    el.subPrimary.textContent = primaryText;
    el.subPrimary.classList.add('active');
  } else {
    el.subPrimary.textContent = '';
    el.subPrimary.classList.remove('active');
  }
  if (secondaryText) {
    el.subSecondary.textContent = secondaryText;
    el.subSecondary.classList.add('active');
  } else {
    el.subSecondary.textContent='';
    el.subSecondary.classList.remove('active');
  }
  // Hide whole container if nothing
  if (el.customSubtitles) el.customSubtitles.style.display = (primaryText||secondaryText) ? 'flex' : 'none';
  // Continue loop only while video playing or has cues
  if (el.mainVideo && !el.mainVideo.paused) {
    subRenderRAF = requestAnimationFrame(renderSubtitlesLoop);
  } else {
    // still poll occasionally when paused for seeking
    subRenderRAF = null;
  }
}

function srtToVttGlobal(srt) {
  let vtt = srt.replace(/\r/g, '');
  vtt = vtt.replace(/^\d+\s*\n/gm, '');
  vtt = vtt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  vtt = vtt.replace(/(\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + vtt.trim() + '\n';
}
async function fetchAndAttachTrackGlobal(srtText, label) {
  try {
    const vttText = srtText.includes('WEBVTT') ? srtText : srtToVttGlobal(srtText);
    const blob = new Blob([vttText], { type: 'text/vtt' });
    const blobUrl = URL.createObjectURL(blob);
    if (el.mainVideo) {
      el.mainVideo.querySelectorAll('track').forEach(t => t.remove());
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = label || 'Arabic';
      track.srclang = 'ar';
      track.src = blobUrl;
      track.default = true;
      el.mainVideo.appendChild(track);
      track.addEventListener('load', () => {
        const tt = el.mainVideo.textTracks[0];
        if (tt) tt.mode = 'showing';
      });
      setTimeout(() => {
        const tt = el.mainVideo.textTracks[0];
        if (tt) tt.mode = 'showing';
      }, 300);
    }
    return blobUrl;
  } catch (e) { console.warn('attach track fail', e); }
  return null;
}

function startSubtitleLoop(){
  if (subRenderRAF) cancelAnimationFrame(subRenderRAF);
  const tick = ()=> renderSubtitlesLoop();
  // Use timeupdate + rAF hybrid
  subRenderRAF = requestAnimationFrame(function loop(){
    renderSubtitlesLoop();
    subRenderRAF = requestAnimationFrame(loop);
  });
}
function stopSubtitleLoop(){ if(subRenderRAF){ cancelAnimationFrame(subRenderRAF); subRenderRAF=null; } }

async function loadSubtitleUrl(url, isSecondary=false){
  if(!url){
    if(isSecondary){ subSecondaryCues=[]; subSecondaryUrl=''; }
    else { subPrimaryCues=[]; subActiveUrl=''; stopSubtitleLoop(); if(el.subPrimary) el.subPrimary.classList.remove('active'); if(el.subSecondary) el.subSecondary.classList.remove('active'); if(el.mainVideo) el.mainVideo.querySelectorAll('track').forEach(t=>t.remove()); }
    return;
  }
  try{
    const proxied = url.startsWith('blob:') ? url : `http://127.0.0.1:${state.serverPort}/proxy/subtitle?url=${encodeURIComponent(url)}`;
    const txt = await fetch(proxied).then(r=>{
      if(!r.ok) throw new Error('fetch '+r.status);
      return r.text();
    });
    const cues = txt.includes('WEBVTT') || txt.includes('-->') ? parseVTT(txt) : parseSRT(txt);
    if(isSecondary){ subSecondaryCues=cues; subSecondaryUrl=url; }
    else {
      subPrimaryCues=cues; subActiveUrl=url; startSubtitleLoop(); el.mainVideo && el.mainVideo.classList.add('custom-subs-active');
      // Also attach as active <track> after converting SRT->VTT (spec requirement)
      try { await fetchAndAttachTrackGlobal(txt, 'Arabic'); } catch {}
    }
    console.log(`[Subs] Loaded ${cues.length} cues from ${isSecondary?'secondary':'primary'}`);
  }catch(e){
    console.warn('Subtitle load failed', e);
    // Fallback: try as track element if fetch blocked
    if(!isSecondary) applySubtitleTrack(url);
  }
}

function applySubStyle(){
  const s = state.subStyle;
  if(!el.customSubtitles) return;
  el.customSubtitles.setAttribute('data-size', s.size);
  el.customSubtitles.style.fontFamily = s.family==='Cairo' ? "'Cairo', system-ui, sans-serif" : s.family==='Outfit' ? "'Outfit', system-ui" : s.family;
  if(el.subPrimary){
    el.subPrimary.style.color = s.color;
    el.subPrimary.style.background = `rgba(0,0,0,${s.bgOpacity/100})`;
    el.subPrimary.classList.toggle('no-shadow', !s.shadow);
  }
  if(el.subSecondary){
    el.subSecondary.style.background = `rgba(0,0,0,${s.bgOpacity/100*0.85})`;
    el.subSecondary.classList.toggle('no-shadow', !s.shadow);
  }
}

function initSubtitles2(){
  // Restore UI controls from state
  if(el.subDelaySlider){ el.subDelaySlider.value = String(state.subDelayMs); if(el.subDelayValue) el.subDelayValue.textContent = (state.subDelayMs/1000).toFixed(2)+'s'; }
  if(el.subFontSize) el.subFontSize.value = state.subStyle.size;
  if(el.subFontFamily) el.subFontFamily.value = state.subStyle.family;
  if(el.subTextColor) el.subTextColor.value = state.subStyle.color;
  if(el.subBgOpacity) el.subBgOpacity.value = String(state.subStyle.bgOpacity);
  if(el.subTextShadow) el.subTextShadow.checked = !!state.subStyle.shadow;
  if(el.subDualToggle) el.subDualToggle.checked = !!state.subDualEnabled;
  if(el.subSecondaryLang){
    el.subSecondaryLang.value = state.subSecondaryLang;
    el.subSecondaryLang.style.display = state.subDualEnabled ? 'block' : 'none';
    if(el.subDualList) el.subDualList.style.display = state.subDualEnabled ? 'block' : 'none';
  }
  applySubStyle();

  // Delay slider
  if(el.subDelaySlider){
    el.subDelaySlider.addEventListener('input', (e)=>{
      const v = parseInt(e.target.value,10)||0;
      state.subDelayMs = v;
      localStorage.setItem('mamzouka_sub_delay', String(v));
      if(el.subDelayValue) el.subDelayValue.textContent = (v/1000).toFixed(2)+'s';
      renderSubtitlesLoop();
    });
  }
  // Styling
  const saveStyle = ()=>{
    const ns = {
      size: el.subFontSize ? el.subFontSize.value : 'normal',
      family: el.subFontFamily ? el.subFontFamily.value : 'Cairo',
      color: el.subTextColor ? el.subTextColor.value : '#ffffff',
      bgOpacity: el.subBgOpacity ? parseInt(el.subBgOpacity.value,10) : 70,
      shadow: el.subTextShadow ? el.subTextShadow.checked : true,
    };
    state.subStyle = ns;
    localStorage.setItem('mamzouka_sub_style', JSON.stringify(ns));
    applySubStyle();
  };
  if(el.subFontSize) el.subFontSize.addEventListener('change', saveStyle);
  if(el.subFontFamily) el.subFontFamily.addEventListener('change', saveStyle);
  if(el.subTextColor) el.subTextColor.addEventListener('input', saveStyle);
  if(el.subBgOpacity) el.subBgOpacity.addEventListener('input', saveStyle);
  if(el.subTextShadow) el.subTextShadow.addEventListener('change', saveStyle);

  // Dual toggle
  if(el.subDualToggle){
    el.subDualToggle.addEventListener('change', (e)=>{
      state.subDualEnabled = e.target.checked;
      localStorage.setItem('mamzouka_sub_dual', e.target.checked?'1':'0');
      if(el.subSecondaryLang) el.subSecondaryLang.style.display = e.target.checked ? 'block' : 'none';
      if(el.subDualList) el.subDualList.style.display = e.target.checked ? 'block' : 'none';
      if(!e.target.checked){ subSecondaryCues=[]; subSecondaryUrl=''; if(el.subSecondary) el.subSecondary.classList.remove('active'); }
      renderSubtitlesLoop();
    });
  }
  if(el.subSecondaryLang){
    el.subSecondaryLang.addEventListener('change', (e)=>{
      state.subSecondaryLang = e.target.value;
      localStorage.setItem('mamzouka_sub_sec_lang', e.target.value);
      // load secondary from available subs matching lang
      const lang = e.target.value;
      if(lang && state.subtitles && state.subtitles.length){
        const match = state.subtitles.find(s=> s.language_code && s.language_code.toLowerCase().startsWith(lang.toLowerCase().slice(0,3)) || (s.language||'').toLowerCase().includes(lang.toLowerCase()));
        if(match) loadSubtitleUrl(match.url, true);
      }
    });
  }

  // Arabic Subtitles Engine 2.0 — Subdl + OpenSubtitles with release names, SRT->VTT conversion
  function srtToVtt(srt) {
    let vtt = srt.replace(/\r/g, '');
    // Remove numeric cue identifiers and convert commas to dots
    vtt = vtt.replace(/^\d+\s*\n/gm, '');
    vtt = vtt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    vtt = vtt.replace(/(\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return 'WEBVTT\n\n' + vtt.trim() + '\n';
  }
  async function fetchAndAttachTrack(srtText, label) {
    try {
      const vttText = srtText.includes('WEBVTT') ? srtText : srtToVtt(srtText);
      const blob = new Blob([vttText], { type: 'text/vtt' });
      const blobUrl = URL.createObjectURL(blob);
      if (el.mainVideo) {
        // Remove old tracks
        el.mainVideo.querySelectorAll('track').forEach(t => t.remove());
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = label || 'Arabic';
        track.srclang = 'ar';
        track.src = blobUrl;
        track.default = true;
        el.mainVideo.appendChild(track);
        // Force showing
        track.addEventListener('load', () => {
          const tt = el.mainVideo.textTracks[0];
          if (tt) tt.mode = 'showing';
        });
        setTimeout(() => {
          const tt = el.mainVideo.textTracks[0];
          if (tt) tt.mode = 'showing';
        }, 300);
      }
      return blobUrl;
    } catch (e) { console.warn('attach track fail', e); }
    return null;
  }
  async function searchArabicSubs(imdbId, season, episode, query) {
    let results = [];
    const imdb = imdbId || (state.selectedMedia && state.selectedMedia.imdb_id) || '';
    // Search language follows the APP language (single-language UI): ara→AR, fre→FR, else EN
    const appSub = String(getSubtitleCode() || 'ara').toLowerCase();
    const qLang = appSub.startsWith('fre') || appSub.startsWith('fr') ? 'FR' : appSub.startsWith('eng') || appSub.startsWith('en') ? 'EN' : 'AR';
    const qLangLow = qLang.toLowerCase();
    const qCode2 = qLang === 'FR' ? 'fr' : qLang === 'EN' ? 'en' : 'ar';
    // 1. Subdl API — https://api.subdl.com/api/v1/subtitles?imdb_id=tt...&languages=XX
    if (imdb) {
      try {
        const subdlKey = '4R29oGva0w2E3N8p'; // demo/public
        let url = `https://api.subdl.com/api/v1/subtitles?api_key=${subdlKey}&imdb_id=${imdb}&languages=${qLang}`;
        if (season) url += `&season_number=${season}`;
        if (episode) url += `&episode_number=${episode}`;
        const res = await fetch(url, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(()=>null);
        if (res && res.subtitles && Array.isArray(res.subtitles)) {
          const langSubs = res.subtitles.filter(s => !s.language || s.language.toLowerCase().includes(qLangLow === 'ar' ? 'arabic' : qLangLow === 'fr' ? 'french' : 'english') || s.lang === qCode2 || s.language === qLang);
          results = results.concat(langSubs.slice(0, 8).map(s => ({
            language: `${t('ui.subLang' + qLang, qLang === 'AR' ? 'Arabic' : qLang === 'FR' ? 'French' : 'English')} — ${s.release_name || s.name || s.title || 'BluRay'}`,
            language_code: qCode2,
            url: s.url ? (s.url.startsWith('http') ? s.url : `https://dl.subdl.com${s.url}`) : (s.download_url || s.link || ''),
            release: s.release_name || s.name || s.title || 'WEB-DL',
            format: 'srt'
          })).filter(r=>r.url));
        }
      } catch {}
    }
    // 2. OpenSubtitles REST API
    if (imdb) {
      try {
        const osUrl = `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdb.replace('tt','')}&languages=${qCode2}${season?'&season_number='+season:''}${episode?'&episode_number='+episode:''}`;
        const res2 = await fetch(osUrl, { headers: { 'Api-Key': 'w45v2ly3a4n3R5', 'Content-Type':'application/json' }, cache:'no-store' }).then(r=>r.ok?r.json():null).catch(()=>null);
        if (res2 && res2.data && res2.data.length) {
          const mapped = res2.data.slice(0,6).map(d => {
            const a = d.attributes;
            const file = a.files && a.files[0];
            const release = a.release || (file && file.file_name) || a.movie_name || '';
            // OpenSubtitles download requires POST, but we use direct url if available, else fallback to stremio proxy via imdb
            const dlUrl = file && file.file_id ? '' : (a.url || '');
            return {
              language: `${t('ui.subLang' + qLang, qLang === 'AR' ? 'Arabic' : qLang === 'FR' ? 'French' : 'English')} — ${release || 'BluRay'}`,
              language_code: qCode2,
              url: dlUrl,
              release: release || 'WEB-DL',
              format: 'srt',
              osFileId: file && file.file_id
            };
          }).filter(r=>r.url || r.osFileId);
          results = results.concat(mapped);
        }
      } catch {}
    }
    // 3. Fallback: app-language-ranked tracks already loaded for the player
    if (results.length === 0 && state.subtitles && state.subtitles.length) {
      const want = state.subtitles.filter(s=> s.language_code===qCode2);
      const src = want.length ? want : state.subtitles;
      results = results.concat(src.slice(0,8).map(s=> ({
        language: s.language + (s.language_code==='ar' ? ' — '+ (s.id || 'WEB-DL') : ''),
        language_code: s.language_code,
        url: s.url,
        release: s.id || s.language,
        format: s.format || 'srt'
      })));
    }
    // 4. Query fallback
    if (results.length === 0 && query && state.subtitles) {
      results = state.subtitles.filter(s=> s.language.toLowerCase().includes(query.toLowerCase())).slice(0,6).map(s=> ({ ...s, release: s.language }));
    }
    return results.slice(0,10);
  }
  // Legacy wrapper for compatibility
  async function searchSubtitlesAPI(query){
    const imdb = (state.selectedMedia && state.selectedMedia.imdb_id) || '';
    const s = currentSeasonParam || state.selectedSeason;
    const e = currentEpisodeParam || state.selectedEpisode;
    return searchArabicSubs(imdb, s, e, query);
  }
  if(el.btnSubSearch && el.subSearchInput){
    const doSearch = async ()=>{
      const imdb = (state.selectedMedia && state.selectedMedia.imdb_id) || '';
      const s = currentSeasonParam || state.selectedSeason;
      const e = currentEpisodeParam || state.selectedEpisode;
      const q = el.subSearchInput.value.trim() || (state.selectedMedia?state.selectedMedia.title:'');
      if(!imdb && !q){ if(el.subSearchResults) el.subSearchResults.innerHTML = '<div style="color:var(--text-muted); font-size:0.78rem; padding:6px;">'+escapeHtml(t('ui.subOpenDetails', 'Open a movie or series first'))+'</div>'; return; }
      if(el.subSearchResults) el.subSearchResults.innerHTML = '<div style="color:var(--text-muted); font-size:0.78rem; padding:8px;">'+escapeHtml(t('ui.subSearching', '🔍 Searching subtitles...'))+'</div>';
      const results = await searchArabicSubs(imdb, s, e, q);
      if(!el.subSearchResults) return;
      if(!results || results.length===0){
        el.subSearchResults.innerHTML = '<div style="color:var(--text-muted); font-size:0.78rem; padding:8px;">'+escapeHtml(t('ui.subNoneFound', 'No subtitles found. Try another title.'))+'</div>';
        return;
      }
      el.subSearchResults.innerHTML = results.map((r,i)=> `
        <div class="sub-item" data-sidx="${i}" style="display:flex; flex-direction:column; gap:2px; padding:8px 10px; background:rgba(255,255,255,0.04); border-radius:8px; margin-bottom:6px; cursor:pointer; border:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
            <span style="font-size:0.82rem; font-weight:700;">💬 ${escapeHtml(r.language||'Arabic')} </span>
            <span style="font-size:0.68rem; background:rgba(34,197,94,0.18); color:#4ade80; padding:2px 6px; border-radius:6px; border:1px solid rgba(34,197,94,0.3);">${escapeHtml(r.release||'BluRay')}</span>
          </div>
          <div style="font-size:0.72rem; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(r.url ? r.url.slice(0,64) : 'OpenSubtitles')} • ${r.format||'srt'}</div>
        </div>
      `).join('');
      el.subSearchResults.querySelectorAll('.sub-item').forEach(item=>{
        item.addEventListener('click', async ()=>{
          const idx = parseInt(item.dataset.sidx,10);
          const sub = results[idx];
          if(sub){
            // If OpenSubtitles file_id, need to POST to get download link — fallback to stremio proxy if needed
            let targetUrl = sub.url;
            if (!targetUrl && sub.osFileId) {
              try {
                const dlRes = await fetch('https://api.opensubtitles.com/api/v1/download', { method:'POST', headers:{'Api-Key':'w45v2ly3a4n3R5','Content-Type':'application/json'}, body: JSON.stringify({ file_id: sub.osFileId }) }).then(r=>r.ok?r.json():null);
                if (dlRes && dlRes.link) targetUrl = dlRes.link;
              } catch {}
            }
            if (!targetUrl && state.subtitles.length) {
              const fallback = state.subtitles.find(s=> s.language_code==='ar');
              if (fallback) targetUrl = fallback.url;
            }
            if(targetUrl){
              // Fetch SRT and convert to VTT + attach track + custom overlay
              try {
                const proxied = `http://127.0.0.1:${state.serverPort}/proxy/subtitle?url=${encodeURIComponent(targetUrl)}`;
                const srtText = await fetch(proxied).then(r=> r.ok ? r.text() : fetch(targetUrl).then(rr=>rr.text()));
                await fetchAndAttachTrack(srtText, 'Arabic');
                // Also load into custom engine for delay/styling
                await loadSubtitleUrl(targetUrl, false);
                // Update srt text for vtt conversion already done, but loadSubtitleUrl will handle cues
              } catch {
                await loadSubtitleUrl(targetUrl, false);
              }
              if(el.subtitlesList){
                el.subtitlesList.querySelectorAll('.sub-item').forEach(x=>x.classList.remove('active'));
                let existing = Array.from(el.subtitlesList.children).find(c=>c.dataset.url===targetUrl);
                if(!existing){
                  const div=document.createElement('div');
                  div.className='sub-item active';
                  div.dataset.url=targetUrl;
                  div.textContent=(sub.language||'Arabic')+' ✓';
                  el.subtitlesList.prepend(div);
                  div.addEventListener('click', ()=>{ el.subtitlesList.querySelectorAll('.sub-item').forEach(x=>x.classList.remove('active')); div.classList.add('active'); loadSubtitleUrl(targetUrl,false); });
                } else existing.classList.add('active');
              }
              if(el.subtitlesMenu) el.subtitlesMenu.classList.remove('open');
            }
          }
        });
      });
    };
    el.btnSubSearch.addEventListener('click', doSearch);
    el.subSearchInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter') doSearch(); });
    // Auto-search when subtitles menu opens for current media
    if (el.playerBtnSubs) {
      el.playerBtnSubs.addEventListener('click', () => {
        setTimeout(()=> {
          if (el.subtitlesMenu && el.subtitlesMenu.classList.contains('open') && el.subSearchResults && (!el.subSearchResults.innerHTML || el.subSearchResults.innerHTML.includes('Type a movie'))) {
            // lazy auto-search for Arabic if imdb available
            const imdb = state.selectedMedia && state.selectedMedia.imdb_id;
            if (imdb) doSearch();
          }
        }, 350);
      });
    }
  }

  // Hook video events for subtitle rendering
  if(el.mainVideo){
    el.mainVideo.addEventListener('play', startSubtitleLoop);
    el.mainVideo.addEventListener('pause', ()=>{ /* keep last frame */ });
    el.mainVideo.addEventListener('seeking', renderSubtitlesLoop);
    el.mainVideo.addEventListener('seeked', renderSubtitlesLoop);
    el.mainVideo.addEventListener('timeupdate', ()=>{
      // lightweight: only render if custom cues loaded
      if(subPrimaryCues.length||subSecondaryCues.length) renderSubtitlesLoop();
    });
  }

  // Override legacy applySubtitleTrack to use custom engine
  const _origApply = window.applySubtitleTrack;
  window.applySubtitleTrack = function(url){
    if(!url){
      subPrimaryCues=[]; subActiveUrl=''; if(el.subPrimary) el.subPrimary.classList.remove('active'); stopSubtitleLoop(); el.mainVideo && el.mainVideo.classList.remove('custom-subs-active');
      // also clear native tracks
      if(el.mainVideo){ el.mainVideo.querySelectorAll('track').forEach(t=>t.remove()); }
      return;
    }
    loadSubtitleUrl(url, false);
  };
  // Also override loadSubtitlesForPlayer to populate dual list
  const _origLoadSubs = window.loadSubtitlesForPlayer;
  window.loadSubtitlesForPlayer = async function(imdbId, season, episode){
    try{ await _origLoadSubs(imdbId, season, episode); }catch(e){ console.warn(e); }
    // After original loads state.subtitles and list UI, enhance
    if(state.subtitles && state.subtitles.length && el.subDualList && state.subDualEnabled){
      const secLang = state.subSecondaryLang;
      el.subDualList.innerHTML = state.subtitles.map((s,i)=> `<div class="sub-item" data-surl="${s.url}" data-slang="${s.language_code}" style="padding:4px 6px; font-size:0.78rem;">${escapeHtml(s.language)}</div>`).join('');
      el.subDualList.querySelectorAll('.sub-item').forEach(it=>{
        it.addEventListener('click', ()=>{
          el.subDualList.querySelectorAll('.sub-item').forEach(x=>x.classList.remove('active'));
          it.classList.add('active');
          loadSubtitleUrl(it.dataset.surl, true);
        });
      });
      if(secLang){
        const match = state.subtitles.find(s=> s.language_code && s.language_code.toLowerCase().startsWith(secLang.slice(0,2).toLowerCase()));
        if(match) loadSubtitleUrl(match.url, true);
      }
    }
  };
}

// ——— Ambient Glow ———
function initAmbientGlow(){
  if(!el.ambientCanvas || !el.mainVideo) return;
  const canvas = el.ambientCanvas;
  const ctx = canvas.getContext('2d', { alpha: true });
  let w=16, h=9;
  const draw = ()=>{
    if(!ambientEnabled || !el.playerView || !el.playerView.classList.contains('active') || el.mainVideo.paused || el.mainVideo.ended || el.mainVideo.readyState<2){
      ambientRAF = requestAnimationFrame(draw);
      return;
    }
    try{
      w = canvas.width = 32;
      h = canvas.height = 18;
      ctx.drawImage(el.mainVideo, 0,0,w,h);
      // canvas CSS does blur itself, so no need to manipulate imageData
    }catch(e){}
    ambientRAF = requestAnimationFrame(draw);
  };
  const start = ()=>{ if(ambientRAF) cancelAnimationFrame(ambientRAF); ambientRAF=requestAnimationFrame(draw); };
  const stop = ()=>{ if(ambientRAF){ cancelAnimationFrame(ambientRAF); ambientRAF=null; } };
  el.mainVideo.addEventListener('play', start);
  el.mainVideo.addEventListener('pause', stop);
  start();
  if(el.playerBtnAmbient){
    // init toggle state
    el.playerBtnAmbient.style.background = ambientEnabled ? 'rgba(139,92,246,0.22)' : '';
    el.playerBtnAmbient.addEventListener('click', ()=>{
      ambientEnabled = !ambientEnabled;
      state.ambientOn = ambientEnabled;
      localStorage.setItem('mamzouka_ambient', ambientEnabled?'1':'0');
      if(el.playerView) el.playerView.classList.toggle('ambient-on', ambientEnabled);
      el.playerBtnAmbient.style.background = ambientEnabled ? 'rgba(139,92,246,0.22)' : '';
      if(ambientEnabled) start(); else stop();
    });
  }
}

// ——— Aspect Ratio ———
function applyAspectMode(mode){
  if(!el.mainVideo) return;
  const m = mode || 'original';
  el.mainVideo.setAttribute('data-aspect', m);
  state.aspectMode = m;
  localStorage.setItem('mamzouka_aspect', m);
  if(el.aspectMenu){
    el.aspectMenu.querySelectorAll('.menu-item').forEach(mi=> mi.classList.toggle('active', mi.dataset.aspect===m));
  }
  // Also handle Fill Screen / Crop via object-fit cover via CSS
}
function initAspectSwitcher(){
  if(el.playerBtnAspect && el.aspectMenu){
    el.playerBtnAspect.addEventListener('click', (e)=>{
      e.stopPropagation();
      const vis = el.aspectMenu.style.display==='flex';
      closeAllPlayerMenus();
      if(!vis) el.aspectMenu.style.display='flex';
    });
    el.aspectMenu.querySelectorAll('.menu-item').forEach(mi=>{
      mi.addEventListener('click', ()=>{
        applyAspectMode(mi.dataset.aspect);
        el.aspectMenu.style.display='none';
      });
    });
  }
  applyAspectMode(state.aspectMode);
}

// ——— Picture Filters ———
function applyFilterVals(vals){
  const v = vals || state.filterVals;
  if (v.hue === undefined) v.hue = 0;
  if(el.videoWrapper){
    el.videoWrapper.style.setProperty('--player-brightness', String((v.brightness||100)/100));
    el.videoWrapper.style.setProperty('--player-contrast', String((v.contrast||100)/100));
    el.videoWrapper.style.setProperty('--player-saturation', String((v.saturation||100)/100));
    el.videoWrapper.style.setProperty('--player-hue', String(v.hue||0)+'deg');
  }
  if(el.filterBrightness) el.filterBrightness.value = String(v.brightness);
  if(el.filterContrast) el.filterContrast.value = String(v.contrast);
  if(el.filterSaturation) el.filterSaturation.value = String(v.saturation);
  if(el.filterHue) el.filterHue.value = String(v.hue||0);
  if(el.filterBrightnessVal) el.filterBrightnessVal.textContent = v.brightness+'%';
  if(el.filterContrastVal) el.filterContrastVal.textContent = v.contrast+'%';
  if(el.filterSaturationVal) el.filterSaturationVal.textContent = v.saturation+'%';
  if(el.filterHueVal) el.filterHueVal.textContent = (v.hue||0)+'°';
  state.filterVals = v;
  localStorage.setItem('mamzouka_filters', JSON.stringify(v));
}
function initFilters(){
  const update = ()=>{
    const v = {
      brightness: el.filterBrightness ? parseInt(el.filterBrightness.value,10) : 100,
      contrast: el.filterContrast ? parseInt(el.filterContrast.value,10) : 100,
      saturation: el.filterSaturation ? parseInt(el.filterSaturation.value,10) : 100,
      hue: el.filterHue ? parseInt(el.filterHue.value,10) : 0,
    };
    applyFilterVals(v);
  };
  if(el.filterBrightness) el.filterBrightness.addEventListener('input', update);
  if(el.filterContrast) el.filterContrast.addEventListener('input', update);
  if(el.filterSaturation) el.filterSaturation.addEventListener('input', update);
  if(el.filterHue) el.filterHue.addEventListener('input', update);
  if(el.btnResetFilters) el.btnResetFilters.addEventListener('click', ()=> applyFilterVals({brightness:100,contrast:100,saturation:100, hue:0}));
  if(el.playerBtnFilters && el.filterPanel){
    el.playerBtnFilters.addEventListener('click', (e)=>{
      e.stopPropagation();
      const vis = el.filterPanel.style.display==='flex';
      closeAllPlayerMenus();
      if(!vis){ el.filterPanel.style.display='flex'; el.filterPanel.style.flexDirection='column'; }
    });
  }
  applyFilterVals(state.filterVals);
}
function setupChapters(duration){
  const bar = document.getElementById('chapters-bar');
  if(!bar || !duration || isNaN(duration) || duration < 60) return;
  bar.innerHTML = '';
  const count = duration > 3600 ? 6 : 4;
  const titles = ['Intro','Act I','Act II','Climax','Outro','Credits'];
  for(let i=1;i<count;i++){
    const pos = (i/count)*100;
    const m = document.createElement('div');
    m.className='chapter-marker';
    m.style.left = pos+'%';
    m.dataset.label = titles[i] || `Ch ${i+1}`;
    m.addEventListener('click', (e)=>{
      e.stopPropagation();
      const t = (pos/100)*duration;
      if(el.mainVideo) el.mainVideo.currentTime = t;
      trackEvent('chapter_seek', {chapter:i, time:t});
    });
    bar.appendChild(m);
  }
  // WebVTT chapters track
  try{
    if(el.mainVideo){
      el.mainVideo.querySelectorAll('track[kind=\"chapters\"]').forEach(t=>t.remove());
      let vtt = 'WEBVTT\n\n';
      for(let i=0;i<count;i++){
        const s = (duration/count*i);
        const e = (duration/count*(i+1));
        const fmt = (sec)=>{
          const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=Math.floor(sec%60);
          return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.000`;
        };
        vtt += `${i+1}\n${fmt(s)} --> ${fmt(e)}\n${titles[i]||`Chapter ${i+1}`}\n\n`;
      }
      const blob = new Blob([vtt], {type:'text/vtt'});
      const url = URL.createObjectURL(blob);
      const track=document.createElement('track');
      track.kind='chapters'; track.label='Chapters'; track.srclang='en'; track.src=url; track.default=false;
      el.mainVideo.appendChild(track);
    }
  }catch{}
}

// ——— Thumbnail Scrubbing ———
function initThumbnailScrub(){
  if(!el.playerProgressBar || !el.mainVideo || !el.scrubPreview || !el.scrubCanvas) return;
  const canvas = el.scrubCanvas;
  const ctx = canvas.getContext('2d');
  let isHovering = false;
  const updatePreview = (clientX)=>{
    const rect = el.playerProgressBar.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (clientX - rect.left)/rect.width));
    const dur = el.mainVideo.duration || 0;
    const t = pos * dur;
    // Position preview
    const previewWidth = 180;
    const barLeft = rect.left;
    const barWidth = rect.width;
    const x = barLeft + pos*barWidth;
    const viewportLeft = 0;
    const viewportRight = window.innerWidth;
    let left = x;
    const half = 90;
    if(left - half < viewportLeft+8) left = viewportLeft+8+half;
    if(left + half > viewportRight-8) left = viewportRight-8-half;
    el.scrubPreview.style.left = left + 'px';
    if(el.scrubTime) el.scrubTime.textContent = formatTime(t);
    if(el.playerProgressTooltip) { el.playerProgressTooltip.style.left = (pos*100)+'%'; el.playerProgressTooltip.textContent = formatTime(t); }
    // Draw thumbnail via video frame capture (if ready)
    try{
      if(el.mainVideo.readyState>=2){
        // Use offscreen capture: seek temporary? Instead use current frame scaled + try to estimate via canvas draw if video can be drawn at any time
        // We snapshot current frame but visually it's a preview of hover time only if we seek offscreen—so we approximate by drawing current frame; better: use a hidden video element for preview (clone)
        // For simplicity, draw current frame with time label; if user is hovering, we try to use video's current frame as preview (real thumb would need sprites)
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(el.mainVideo, 0,0,canvas.width,canvas.height);
        // overlay time
        ctx.fillStyle='rgba(0,0,0,0.55)';
        ctx.fillRect(0, canvas.height-18, canvas.width, 18);
        ctx.fillStyle='#fff';
        ctx.font='11px monospace';
        ctx.textAlign='center';
        ctx.fillText(formatTime(t), canvas.width/2, canvas.height-6);
      }
    }catch(e){}
  };
  el.playerProgressBar.addEventListener('mouseenter', ()=>{ isHovering=true; el.scrubPreview.classList.add('visible'); });
  el.playerProgressBar.addEventListener('mouseleave', ()=>{ isHovering=false; el.scrubPreview.classList.remove('visible'); });
  el.playerProgressBar.addEventListener('mousemove', (e)=>{ if(isHovering) updatePreview(e.clientX); });
  // Touch
  el.playerProgressBar.addEventListener('touchmove', (e)=>{ if(e.touches && e.touches[0]) updatePreview(e.touches[0].clientX); }, {passive:true});
}

// ——— Gestures: Double-Tap Seek + Vertical Scroll ———
function showSeekRipple(dir){
  const elRip = dir==='left' ? el.seekRippleLeft : el.seekRippleRight;
  if(!elRip) return;
  elRip.classList.add('show');
  setTimeout(()=> elRip.classList.remove('show'), 550);
}
function showOSD(type, pct){
  const osd = type==='volume' ? el.volumeOsd : el.brightnessOsd;
  const fill = type==='volume' ? el.volumeOsdFill : el.brightnessOsdFill;
  const txt = type==='volume' ? el.volumeOsdText : el.brightnessOsdText;
  const icon = el.volumeOsdIcon;
  if(!osd || !fill || !txt) return;
  fill.style.width = pct+'%';
  txt.textContent = Math.round(pct)+'%';
  if(icon && type==='volume'){
    icon.textContent = pct===0 ? '🔇' : pct<50 ? '🔈' : '🔊';
  }
  osd.classList.add('visible');
  clearTimeout(osd._hideT);
  osd._hideT = setTimeout(()=> osd.classList.remove('visible'), 900);
}
function initGestures(){
  if(!el.mainVideo || !el.videoWrapper) return;
  // Double-tap / double-click seek
  let lastTap = 0;
  let tapCount = 0;
  const handleDoubleTap = (side)=>{
    if(!el.mainVideo.duration) return;
    const delta = side==='left' ? -10 : 10;
    el.mainVideo.currentTime = Math.max(0, Math.min(el.mainVideo.duration, el.mainVideo.currentTime + delta));
    showSeekRipple(side);
    // also show OSD time?
  };
  // Use gesture zones
  const bindDbl = (zone, side)=>{
    if(!zone) return;
    let lastClick = 0;
    zone.addEventListener('click', (e)=>{
      const now = Date.now();
      if(now - lastClick < 320){
        e.preventDefault();
        handleDoubleTap(side);
        lastClick = 0;
      } else lastClick = now;
    });
    zone.addEventListener('dblclick', (e)=>{
      e.preventDefault();
      handleDoubleTap(side);
    });
    // Touch double tap
    let lastTouch=0;
    zone.addEventListener('touchend', (e)=>{
      const now=Date.now();
      if(now-lastTouch<320){
        e.preventDefault();
        handleDoubleTap(side);
      }
      lastTouch=now;
    }, {passive:false});
  };
  bindDbl(el.gestureLeft, 'left');
  bindDbl(el.gestureRight, 'right');
  // Also double-click on video thirds (fallback)
  if(el.mainVideo){
    el.mainVideo.addEventListener('dblclick', (e)=>{
      const rect = el.mainVideo.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const third = rect.width/3;
      if(x < third) handleDoubleTap('left');
      else if(x > third*2) handleDoubleTap('right');
    });
  }
  // Vertical scroll / wheel for volume (right) and brightness (left)
  const onWheel = (e, side)=>{
    if(!el.playerView || !el.playerView.classList.contains('active')) return;
    // Only when hovering gesture zones OR video overlay? Check mouse position
    // We check if e.target is inside gesture zone or video wrapper
    const delta = e.deltaY;
    e.preventDefault();
    if(side==='right'){
      // Volume: up = increase, down = decrease
      let vol = el.mainVideo.volume;
      // If using boost, adjust boost slider instead when vol is 1 and boost>1
      let boostPct = Math.round(state.audioBoost*100);
      if(boostPct>100 && vol>=0.99){
        // Adjust boost up to 250%
        boostPct = Math.max(0, Math.min(250, boostPct + (delta<0? 5 : -5)));
        updateVolumeBoost(boostPct);
        showOSD('volume', boostPct/2.5*100/100*100); // map 0-250 to 0-100 for bar
        // show actual boost pct
        if(el.volumeOsdText) el.volumeOsdText.textContent = boostPct+'%';
        if(el.volumeOsdFill) el.volumeOsdFill.style.width = Math.min(100, boostPct/2.5)+'%';
      } else {
        vol = Math.max(0, Math.min(1, vol + (delta<0?0.05:-0.05)));
        el.mainVideo.volume = vol;
        if(el.playerVolume) el.playerVolume.value = String(vol);
        el.mainVideo.muted = vol===0;
        const pct = Math.round(vol*100);
        showOSD('volume', pct);
        // also sync boost if back to normal
        if(vol<1 && boostPct!==100){ /* keep */ }
      }
    } else if(side==='left'){
      // Brightness 50-150 via CSS filter
      let b = state.playerBrightness;
      b = Math.max(50, Math.min(150, b + (delta<0? 5 : -5)));
      state.playerBrightness = b;
      localStorage.setItem('mamzouka_pbrightness', String(b));
      if(el.videoWrapper) el.videoWrapper.style.setProperty('--player-brightness', String(b/100));
      showOSD('brightness', ((b-50)/100)*100);
      if(el.brightnessOsdText) el.brightnessOsdText.textContent = b+'%';
      if(el.brightnessOsdFill) el.brightnessOsdFill.style.width = ((b-50)/100)*100+'%';
    }
  };
  if(el.gestureRight){
    el.gestureRight.addEventListener('wheel', (e)=> onWheel(e,'right'), {passive:false});
    // Also touch drag vertical
    let startY=null;
    el.gestureRight.addEventListener('touchstart', e=>{ if(e.touches[0]) startY=e.touches[0].clientY; }, {passive:true});
    el.gestureRight.addEventListener('touchmove', e=>{
      if(startY===null || !e.touches[0]) return;
      const dy = startY - e.touches[0].clientY;
      if(Math.abs(dy)>18){
        const mock={ deltaY: -dy, preventDefault:()=>{} };
        onWheel(mock,'right');
        startY=e.touches[0].clientY;
      }
    }, {passive:true});
  }
  if(el.gestureLeft){
    el.gestureLeft.addEventListener('wheel', (e)=> onWheel(e,'left'), {passive:false});
    let startY=null;
    el.gestureLeft.addEventListener('touchstart', e=>{ if(e.touches[0]) startY=e.touches[0].clientY; }, {passive:true});
    el.gestureLeft.addEventListener('touchmove', e=>{
      if(startY===null || !e.touches[0]) return;
      const dy = startY - e.touches[0].clientY;
      if(Math.abs(dy)>18){
        const mock={ deltaY: -dy, preventDefault:()=>{} };
        onWheel(mock,'left');
        startY=e.touches[0].clientY;
      }
    }, {passive:true});
  }
  // Also wheel anywhere on video wrapper with modifier: right side vs left side detection
  if(el.videoWrapper){
    el.videoWrapper.addEventListener('wheel', (e)=>{
      const rect = el.videoWrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const side = x < rect.width*0.33 ? 'left' : x > rect.width*0.66 ? 'right' : null;
      if(side) onWheel(e, side);
    }, {passive:false});
  }
}

// ——— Binge: Next Episode, Drawer, Skip Intro ———
let skipIntroEnd = 85; // seconds
let skipRecapEnd = 0; // could be set per episode via metadata

function initBingeFeatures(){
  // Episode Drawer toggle
  if(el.playerBtnEpisodes && el.episodeDrawer){
    el.playerBtnEpisodes.addEventListener('click', (e)=>{
      e.stopPropagation();
      const open = el.episodeDrawer.classList.contains('open');
      if(open) el.episodeDrawer.classList.remove('open');
      else { populateEpisodeDrawer(); el.episodeDrawer.classList.add('open'); }
    });
  }
  if(el.btnCloseDrawer && el.episodeDrawer){
    el.btnCloseDrawer.addEventListener('click', ()=> el.episodeDrawer.classList.remove('open'));
  }
  // Click outside drawer to close
  document.addEventListener('click', (e)=>{
    if(el.episodeDrawer && el.episodeDrawer.classList.contains('open') && !el.episodeDrawer.contains(e.target) && e.target!==el.playerBtnEpisodes){
      // don't close if clicking inside player controls bar
      if(!e.target.closest || !e.target.closest('.episode-drawer')) el.episodeDrawer.classList.remove('open');
    }
  });
  // Watch for overlay click to close drawer
  if(el.videoWrapper){
    el.videoWrapper.addEventListener('click', (e)=>{
      if(el.episodeDrawer && el.episodeDrawer.classList.contains('open')){
        const rect = el.episodeDrawer.getBoundingClientRect();
        if(e.clientX < rect.left) el.episodeDrawer.classList.remove('open');
      }
    });
  }
  // Next episode card buttons
  if(el.btnNextPlay){
    el.btnNextPlay.addEventListener('click', ()=>{ clearNextCountdown(); playNextEpisode(); });
  }
  if(el.btnNextCancel){
    el.btnNextCancel.addEventListener('click', ()=>{ clearNextCountdown(); hideNextCard(); });
  }
  // Skip intro / recap
  if(el.btnSkipIntro && el.mainVideo){
    el.btnSkipIntro.addEventListener('click', ()=>{
      const target = skipIntroEnd || 85;
      el.mainVideo.currentTime = Math.min(el.mainVideo.duration-2, target);
      el.btnSkipIntro.style.display='none';
    });
  }
  if(el.btnSkipRecap && el.mainVideo){
    el.btnSkipRecap.addEventListener('click', ()=>{
      const target = skipRecapEnd || 90;
      el.mainVideo.currentTime = Math.min(el.mainVideo.duration-2, target);
      el.btnSkipRecap.style.display='none';
    });
  }
  // Hook timeupdate for binge logic
  if(el.mainVideo){
    el.mainVideo.addEventListener('timeupdate', handleBingeTimeUpdate);
    el.mainVideo.addEventListener('ended', ()=>{
      // If series and auto play, trigger next
      if(state.selectedMedia && state.selectedMedia.media_type==='tv' && state.settings.auto_play_next){
        playNextEpisode();
      }
    });
  }
}

function handleBingeTimeUpdate(){
  if(!el.mainVideo || !state.selectedMedia) return;
  const cur = el.mainVideo.currentTime;
  const dur = el.mainVideo.duration || 0;
  if(!dur || dur<30) return;
  // Skip Intro button visibility: show between 0 and skipIntroEnd and only if duration > 300 (likely series)
  const isSeries = state.selectedMedia.media_type==='tv' || currentSeasonParam;
  if(el.btnSkipIntro){
    if(isSeries && cur >=0 && cur < skipIntroEnd && dur>600){
      // Show only first 85 seconds
      el.btnSkipIntro.style.display='inline-flex';
      el.btnSkipIntro.querySelector('span').textContent = `Skip Intro • تخطي المقدمة`;
    } else {
      el.btnSkipIntro.style.display='none';
    }
  }
  if(el.btnSkipRecap && skipRecapEnd>0){
    el.btnSkipRecap.style.display = (isSeries && cur> skipIntroEnd && cur < skipRecapEnd) ? 'inline-flex' : 'none';
  }
  // Auto skip intro if setting enabled
  if(state.settings.auto_skip_intro && isSeries && cur < 2 && dur>600){
    // don't auto skip instantly; wait a tick?
  }
  if(state.settings.auto_skip_intro && isSeries && cur>=0 && cur < skipIntroEnd && cur>2 && dur>600){
    // Auto skip intro at 2s after start if enabled
    if(cur < 5){
      // schedule once per playback
      if(!el.mainVideo._autoSkipped){
        el.mainVideo._autoSkipped = true;
        setTimeout(()=>{ if(el.mainVideo && el.mainVideo.currentTime < skipIntroEnd) el.mainVideo.currentTime = skipIntroEnd; }, 600);
      }
    }
  } else {
    if(cur>skipIntroEnd+5) el.mainVideo._autoSkipped=false;
  }
  // Next Episode Card: Spec — show when 20s remain, 10s countdown
  if(isSeries && dur - cur <= 30 && dur - cur > 0 && state.settings.auto_play_next){
    if(!el.nextEpisodeCard || el.nextEpisodeCard.classList.contains('visible')) return;
    if(dur - cur <= 20.5 && dur - cur >= 19.5){
      showNextEpisodeCard();
    }
  } else {
    if(dur - cur > 32) hideNextCard();
  }
  // Mark watched if >90%
  if(dur>0 && !watchedMarked.has(state.selectedMedia.id+'_'+(currentSeasonParam||'')+'_'+(currentEpisodeParam||''))){
    const pct = (cur/dur)*100;
    if(pct>90){
      watchedMarked.add(state.selectedMedia.id+'_'+(currentSeasonParam||'')+'_'+(currentEpisodeParam||'')); 
      // invoke mark watched via watch history with 90% flag? Could also set local flag
      try{ localStorage.setItem('mamzouka_watched_'+state.selectedMedia.id, '1'); }catch{}
      // Optionally show toast
      console.log('[Binge] Marked as Watched >90%:', state.selectedMedia.title);
    }
  }
}

function showNextEpisodeCard(){
  if(!el.nextEpisodeCard || !state.selectedMedia) return;
  // Determine next episode via state
  const s = currentSeasonParam || state.selectedSeason || 1;
  let e = (currentEpisodeParam || state.selectedEpisode || 1) + 1;
  // Try to know max episodes: if we have episodes list, check existence
  // For now assume exists
  const title = state.selectedMedia.title || 'Next Episode';
  if(el.nextCardTitle) el.nextCardTitle.textContent = `S${s}:E${e} — ${title}`;
  if(el.nextCardMeta) el.nextCardMeta.textContent = t('ui.nextMeta', 'Season {s} • Episode {e} • Autoplay in').replace('{s}', s).replace('{e}', e);
  if(el.nextCardBg && state.selectedMedia.backdrop_url) el.nextCardBg.style.backgroundImage = `url('${state.selectedMedia.backdrop_url}')`;
  el.nextEpisodeCard.classList.add('visible');
  el.nextEpisodeCard.style.display='block';
  nextEpRemaining = 10;
  if(el.nextCountdown) el.nextCountdown.textContent='10';
  if(el.nextProgressFill) el.nextProgressFill.style.width='0%';
  clearInterval(nextEpCountdownTimer);
  nextEpCountdownTimer = setInterval(()=>{
    nextEpRemaining--;
    if(el.nextCountdown) el.nextCountdown.textContent=String(nextEpRemaining);
    if(el.nextProgressFill) el.nextProgressFill.style.width = ((10-nextEpRemaining)/10*100)+'%';
    if(nextEpRemaining<=0){
      clearNextCountdown();
      playNextEpisode();
    }
  }, 1000);
}
function hideNextCard(){
  if(el.nextEpisodeCard) { el.nextEpisodeCard.classList.remove('visible'); setTimeout(()=>{ if(el.nextEpisodeCard && !el.nextEpisodeCard.classList.contains('visible')) el.nextEpisodeCard.style.display='none'; }, 350); }
}
function clearNextCountdown(){ if(nextEpCountdownTimer){ clearInterval(nextEpCountdownTimer); nextEpCountdownTimer=null; } hideNextCard(); }

async function playNextEpisode(){
  hideNextCard();
  if(!state.selectedMedia) return;
  const s = currentSeasonParam || state.selectedSeason || 1;
  let e = (currentEpisodeParam || state.selectedEpisode || 1) + 1;
  // Validate via backend: try to fetch episodes for season
  try{
    const episodes = await invoke('get_season_episodes', { tvId: state.selectedMedia.id, seasonNumber: s, language: getTmdbLanguage() });
    if(episodes && episodes.length){
      const exists = episodes.find(ep=> ep.episode_number===e);
      if(!exists){
        // Try next season
        const seasons = state.selectedMedia.seasons ? state.selectedMedia.seasons.filter(x=>x.season_number>0) : [];
        const nextSeason = seasons.find(x=> x.season_number===s+1);
        if(nextSeason){
          state.selectedSeason = s+1;
          currentSeasonParam = s+1;
          e=1;
          await loadEpisodesForSeason(state.selectedMedia.id, s+1);
        } else {
          console.log('[Binge] No next episode available');
          return;
        }
      }
    }
  }catch(err){ console.warn('Next ep check', err); }
  state.selectedEpisode = e;
  currentEpisodeParam = e;
  // Update UI drawer if open
  populateEpisodeDrawer();
  // Fetch streams for next ep and autoplay first stream
  const imdb = state.selectedMedia.imdb_id || String(state.selectedMedia.id);
  try{
    await loadStreamsForMedia(imdb, 'series', s, e, state.selectedMedia.id);
    // Autoplay best stream after brief delay
    setTimeout(()=>{
      if(currentStreamsData && currentStreamsData.length){
        const best = currentStreamsData[0];
        startPlayback(best, state.selectedMedia, s, e);
      }
    }, 450);
  }catch(e){ console.warn('Auto next failed', e); }
}

async function populateEpisodeDrawer(){
  if(!el.drawerEpisodesList || !state.selectedMedia) return;
  const s = currentSeasonParam || state.selectedSeason || 1;
  if(el.drawerSeasonLabel) el.drawerSeasonLabel.textContent = `S${s}`;
  // Season tabs
  if(el.drawerSeasonTabs){
    const seasons = state.selectedMedia.seasons ? state.selectedMedia.seasons.filter(x=>x.season_number>0) : [{season_number:s, name:t('ui.seasonLabel', 'Season {n}').replace('{n}', s)}];
    el.drawerSeasonTabs.innerHTML = seasons.map(se=> `<button class="drawer-season-tab ${se.season_number===s?'active':''}" data-season="${se.season_number}">${se.name||`S${se.season_number}`}</button>`).join('');
    el.drawerSeasonTabs.querySelectorAll('.drawer-season-tab').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const sn = parseInt(btn.dataset.season,10);
        state.selectedSeason = sn;
        currentSeasonParam = sn;
        el.drawerSeasonTabs.querySelectorAll('.drawer-season-tab').forEach(x=>x.classList.remove('active'));
        btn.classList.add('active');
        if(el.drawerSeasonLabel) el.drawerSeasonLabel.textContent = `S${sn}`;
        await loadDrawerEpisodes(sn);
      });
    });
  }
  await loadDrawerEpisodes(s);
}

async function loadDrawerEpisodes(seasonNum){
  if(!el.drawerEpisodesList) return;
  el.drawerEpisodesList.innerHTML = '<div class="spinner"></div>';
  try{
    const eps = await invoke('get_season_episodes', { tvId: state.selectedMedia.id, seasonNumber: seasonNum, language: getTmdbLanguage() });
    if(!eps || eps.length===0){ el.drawerEpisodesList.innerHTML='<div style="padding:16px; color:var(--text-muted);">'+escapeHtml(t('ui.noEpisodes', 'No episodes found.'))+'</div>'; return; }
    // Fetch watch progress to show per-ep progress
    let history = [];
    try{ history = await invoke('get_watch_history') || []; }catch{}
    el.drawerEpisodesList.innerHTML = eps.map(ep=>{
      const hist = history.find(h=> h.media_id===state.selectedMedia.id && h.season===seasonNum && h.episode===ep.episode_number);
      const pct = hist && hist.duration_sec>0 ? Math.round((hist.current_time_sec/hist.duration_sec)*100) : 0;
      const active = (currentEpisodeParam||state.selectedEpisode)===ep.episode_number && (currentSeasonParam||state.selectedSeason)===seasonNum;
      const thumb = ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : (state.selectedMedia.backdrop_url || state.selectedMedia.poster_url || '');
      return `
        <div class="drawer-episode-card ${active?'active':''}" data-ep="${ep.episode_number}">
          <img class="drawer-ep-thumb" src="${thumb}" alt="E${ep.episode_number}" onerror="this.style.display='none'" />
          <div class="drawer-ep-info">
            <div class="drawer-ep-title">E${ep.episode_number}: ${escapeHtml(ep.name||t('ui.episodeLabel', 'Episode {n}').replace('{n}', ep.episode_number))}</div>
            <div class="drawer-ep-meta">${ep.runtime?ep.runtime+' '+t('ui.minUnit', 'min')+' • ':''}${ep.air_date||''} ${pct?`• ${pct}%`:''}</div>
            ${pct?`<div class="drawer-ep-progress"><div style="width:${pct}%"></div></div>`:''}
          </div>
          <div style="font-size:0.9rem; color:${active?'var(--accent-cyan)':'var(--text-muted)'};">${active?'▶':''}</div>
        </div>
      `;
    }).join('');
    el.drawerEpisodesList.querySelectorAll('.drawer-episode-card').forEach(card=>{
      card.addEventListener('click', async ()=>{
        const epNum = parseInt(card.dataset.ep,10);
        state.selectedEpisode = epNum;
        currentEpisodeParam = epNum;
        el.drawerEpisodesList.querySelectorAll('.drawer-episode-card').forEach(c=>c.classList.remove('active'));
        card.classList.add('active');
        // Close drawer after selection delay
        setTimeout(()=> el.episodeDrawer && el.episodeDrawer.classList.remove('open'), 250);
        const imdb = state.selectedMedia.imdb_id || String(state.selectedMedia.id);
        await loadStreamsForMedia(imdb, 'series', seasonNum, epNum, state.selectedMedia.id);
        if(currentStreamsData && currentStreamsData.length) startPlayback(currentStreamsData[0], state.selectedMedia, seasonNum, epNum);
      });
    });
  }catch(e){ el.drawerEpisodesList.innerHTML=`<div style="color:#ef4444; padding:12px;">${escapeHtml(t('ui.fetchStreamsFail', 'Failed to load: '))}${escapeHtml(String(e).slice(0,100))}</div>`; }
}

// ——— Failover ——— Spec: VidSrc SU → VidLink → Smashy → Embed.su → AutoEmbed (8s)
const SERVER_ORDER = ['torrent','vidsrc','vidlink','smashy','embedsu','autoembed','2embed'];
function showFailoverToast(nextServer){
  const toast = document.getElementById('failover-toast');
  if (!toast) return;
  toast.textContent = `🔄 Switching to alternative server: ${nextServer}...`;
  toast.style.display = 'block';
  toast.style.opacity = '1';
  setTimeout(()=> { toast.style.opacity='0'; setTimeout(()=> toast.style.display='none', 400); }, 2500);
}
function initFailover(){
  if(!el.mainVideo) return;
  let lastTime = 0;
  let stallCount = 0;
  const iframeErrorHandler = () => {
    // If iframe visible, monitor its load error via timeout
    if (el.mainIframe && el.mainIframe.style.display !== 'none') {
      clearTimeout(failoverTimer);
      failoverTimer = setTimeout(()=> tryFailover('iframe 8s network error'), 8000);
    }
  };
  if (el.mainIframe) {
    el.mainIframe.addEventListener('error', iframeErrorHandler);
    // Poll iframe load: if src set but not loaded, start timer
    const origSwitch = window.switchPlayerServer;
  }
  el.mainVideo.addEventListener('waiting', ()=>{
    bufferingStart = Date.now();
    clearTimeout(failoverTimer);
    failoverTimer = setTimeout(()=> tryFailover('buffering 8s'), 8000);
  });
  el.mainVideo.addEventListener('playing', ()=>{
    bufferingStart=0;
    clearTimeout(failoverTimer);
    stallCount=0;
    state.failoverAttempts=0;
  });
  el.mainVideo.addEventListener('stalled', ()=>{
    if(!bufferingStart) bufferingStart=Date.now();
    if(!failoverTimer) failoverTimer=setTimeout(()=> tryFailover('stalled 8s'), 8000);
  });
  el.mainVideo.addEventListener('error', ()=>{
    clearTimeout(failoverTimer);
    tryFailover('media error');
  });
  el.mainVideo.addEventListener('timeupdate', ()=>{
    if(el.mainVideo.paused) return;
    if(el.mainVideo.currentTime===lastTime){
      stallCount++;
      if(stallCount>20 && !failoverTimer){ failoverTimer=setTimeout(()=> tryFailover('no progress 8s'), 8000); }
    } else stallCount=0;
    lastTime = el.mainVideo.currentTime;
  });
}

function tryFailover(reason){
  clearTimeout(failoverTimer);
  if(!state.selectedMedia) return;
  let activeKey = null;
  if(el.playerServerBar){
    const activeChip = el.playerServerBar.querySelector('.player-server-chip.active');
    if(activeChip) activeKey = activeChip.dataset.server;
  }
  const idx = SERVER_ORDER.indexOf(activeKey||'torrent');
  const nextIdx = (idx+1) % SERVER_ORDER.length;
  const nextServer = SERVER_ORDER[nextIdx];
  if(state.failoverAttempts>=5) { console.warn('[Failover] max attempts reached'); return; }
  state.failoverAttempts++;
  console.warn(`[Failover] ${reason} — switching to ${nextServer} (attempt ${state.failoverAttempts})`);
  showFailoverToast(nextServer);
  const curTime = el.mainVideo ? el.mainVideo.currentTime : 0;
  const curDur = el.mainVideo ? el.mainVideo.duration : 0;
  if(nextServer==='torrent'){
    if(currentStreamsData && currentStreamsData.length>1){
      const curStreamIdx = currentStreamsData.findIndex(s=> s.magnet_uri===state.activeStream?.magnet_uri);
      const nextStream = currentStreamsData[curStreamIdx+1] || currentStreamsData[0];
      if(nextStream){
        nextStream._serverKey='torrent';
        startPlayback(nextStream, state.selectedMedia, currentSeasonParam, currentEpisodeParam);
        setTimeout(()=>{ if(el.mainVideo && curTime>5) { try{el.mainVideo.currentTime=curTime;}catch{}} }, 900);
        return;
      }
    }
  }
  const chip = el.playerServerBar ? el.playerServerBar.querySelector(`[data-server="${nextServer}"]`) : null;
  if(chip) chip.click();
  // Retain playback timestamp: for <video> set currentTime, for iframe show toast (cannot seek)
  setTimeout(()=>{ if(el.mainVideo && el.mainVideo.style.display!=='none' && curTime>5 && curDur>curTime+2) { try{el.mainVideo.currentTime=curTime;}catch{}} }, 1200);
}

// Wrap startPlayback to tag server key and reset failover + resume watched logic
(function wrapStartPlayback(){
  const orig = window.startPlayback || startPlayback;
  window.startPlayback = async function(stream, media, season, episode){
    if(stream){
      const u = (stream.stream_url||'').toLowerCase();
      if(stream.magnet_uri) stream._serverKey='torrent';
      else if(u.includes('vidsrc')) stream._serverKey='vidsrc';
      else if(u.includes('vidlink')) stream._serverKey='vidlink';
      else if(u.includes('smashy')) stream._serverKey='smashy';
      else if(u.includes('embed.su')) stream._serverKey='embedsu';
      else if(u.includes('autoembed')) stream._serverKey='autoembed';
      else if(u.includes('2embed')) stream._serverKey='2embed';
      else stream._serverKey='torrent';
    }
    state.failoverAttempts=0;
    watchedMarked.delete(media.id+'_'+(season||'')+'_'+(episode||'')); // allow re-mark
    // Call original
    const ret = await orig.call(this, stream, media, season, episode);
    // After start, init ambient, audio, populate tracks soon
    setTimeout(()=>{
      if(state.ambientOn && el.playerView) el.playerView.classList.add('ambient-on');
      ensureAudioGraph();
      populateAudioTracks();
      // Reset skip intro flag
      if(el.mainVideo) el.mainVideo._autoSkipped=false;
      skipIntroEnd = 85; // could be dynamic via AniSkip API later: try fetch
      tryFetchAniSkip(media, season, episode);
    }, 700);
    return ret;
  };
  // Ensure global reference also updated
  if(typeof startPlayback !== 'undefined' && startPlayback!==window.startPlayback) startPlayback = window.startPlayback;
})();

async function tryFetchAniSkip(media, season, episode){
  if(!media || media.media_type!=='tv' || !season || !episode) return;
  // Try AniSkip API via MAL id? For now stub with TVMaze intro detection mock 85s
  skipIntroEnd = 85;
  skipRecapEnd = 0;
  try{
    // Example: fetch from aniskip api if imdb available - best effort, ignore CORS
    // const res = await fetch(`https://api.aniskip.com/v2/skip-times/${media.id}/${season}/${episode}?types[]=op&types[]=recap`, {mode:'cors'}).then(r=>r.json()).catch(()=>null);
    // if(res && res.results) { const op=res.results.find(r=>r.skipType==='op'); if(op) skipIntroEnd = Math.round(op.interval.endTime); const recap=res.results.find(r=>r.skipType==='recap'); if(recap) skipRecapEnd=Math.round(recap.interval.endTime); }
  }catch{}
}

// ——— Playback Persistence Enhanced ———
function initPlaybackPersistenceMod(){
  // Wrap update_watch_progress handling for auto-mark watched 90% already in timeupdate; enhance resume modal
  // Hook into openDetailsModal or startPlayback to show resume modal instead of confirm()
  // Replace continue watching card click behavior to use custom modal
  // We'll monkey-patch the resume flow: showResumeModal
}

function showResumeModal(media, resumeSec, durationSec, onResume, onRestart){
  if(!el.resumeModal) { const useConfirm = confirm(t('dlg.resumeConfirm', 'Resume "{t}" at {time}?').replace('{t}', media.title).replace('{time}', formatTime(resumeSec))); if(useConfirm) onResume(); else onRestart(); return; }
  if(el.resumeTitle) el.resumeTitle.textContent = media.title || t('ui.resumeTitle', 'Resume Playback?');
  if(el.resumeDesc) el.resumeDesc.textContent = t('ui.resumeDescTpl', 'You were at {t} of {d} — continue?').replace('{t}', formatTime(resumeSec)).replace('{d}', formatTime(durationSec));
  if(el.resumeTimeLabel) el.resumeTimeLabel.textContent = formatTime(resumeSec);
  el.resumeModal.classList.add('visible');
  el.resumeModal.style.display='flex';
  const cleanup = ()=>{
    el.resumeModal.classList.remove('visible');
    el.resumeModal.style.display='none';
    if(el.btnResumeYes) el.btnResumeYes.onclick=null;
    if(el.btnResumeNo) el.btnResumeNo.onclick=null;
    el.resumeModal.onclick=null;
  };
  if(el.btnResumeYes) el.btnResumeYes.onclick = ()=>{ cleanup(); onResume(); };
  if(el.btnResumeNo) el.btnResumeNo.onclick = ()=>{ cleanup(); onRestart(); };
  el.resumeModal.onclick = (e)=>{ if(e.target===el.resumeModal) { cleanup(); onRestart(); } };
}

// Enhanced continue watching loader wrapper to use modal
(function patchContinueWatching(){
  const origLoad = window.loadContinueWatching;
  if(!origLoad) return;
  window.loadContinueWatching = async function(){
    await origLoad();
    // Re-bind cards to use modal instead of confirm
    if(!el.continueWatchingGrid) return;
    el.continueWatchingGrid.querySelectorAll('.media-card').forEach(card=>{
      const clone = card.cloneNode(true);
      card.parentNode.replaceChild(clone, card);
      clone.addEventListener('click', async ()=>{
        const id = parseInt(clone.dataset.historyId);
        const type = clone.dataset.historyType;
        const t = parseFloat(clone.dataset.time)||0;
        const dur = parseFloat(clone.dataset.duration||0) || 0;
        // Fetch title for modal
        const title = clone.querySelector('.media-card-title')?.textContent || 'Title';
        const mediaStub = { id, title, media_type: type };
        // Try to get real poster? Use hist title
        // Show modal
        // Need to fetch details then decide resume
        showResumeModal({title, id}, t, dur||3600, async ()=>{
          sessionStorage.setItem('mamzouka_pending_resume', String(t));
          await openDetailsModal(id, type);
          // The resume will be applied on loadedmetadata
          // Also try to auto-play first stream if user expects? No, show details
        }, async ()=>{
          sessionStorage.removeItem('mamzouka_pending_resume');
          await openDetailsModal(id, type);
        });
      });
    });
  };
})();

// Hook into player timeupdate to persist resume for details modal resume dataset
(function patchTimeUpdatePersistence(){
  // Already handled in setupEventListeners timeupdate; ensure resume modal not relied on native confirm
})();

// ——— Modern Controls Helper ———
function closeAllPlayerMenus(except){
  if(except !== 'subs' && el.subtitlesMenu) el.subtitlesMenu.classList.remove('open');
  if(except !== 'speed' && el.speedMenu) el.speedMenu.classList.remove('open');
  if(except !== 'audio' && el.audioMenu) el.audioMenu.style.display='none';
  if(except !== 'aspect' && el.aspectMenu) el.aspectMenu.style.display='none';
  if(except !== 'filter' && el.filterPanel) el.filterPanel.style.display='none';
}
function initModernControls(){
  // Global click to close menus when clicking overlay background
  document.addEventListener('click', (e)=>{
    if(!e.target.closest) return;
    const inOverlay = e.target.closest('.player-overlay') || e.target.closest('.player-bottom-bar') || e.target.closest('.player-top-bar');
    if(!inOverlay) return;
    const insideMenu = e.target.closest('.player-menu') || e.target.closest('.subtitles-menu') || e.target.closest('.speed-menu');
    const isBtn = e.target.closest('#player-btn-audio') || e.target.closest('#player-btn-aspect') || e.target.closest('#player-btn-filters') || e.target.closest('#player-btn-subs') || e.target.closest('#player-btn-speed') || e.target.closest('#player-btn-night') || e.target.closest('#player-btn-episodes');
    if(!insideMenu && !isBtn) closeAllPlayerMenus();
  });
  // Capture-phase helpers to close other menus before toggling target (keeps toggle semantics clean)
  if(el.playerBtnSubs){
    el.playerBtnSubs.addEventListener('click', ()=>{
      const willOpen = !(el.subtitlesMenu && el.subtitlesMenu.classList.contains('open'));
      if(willOpen) closeAllPlayerMenus('subs');
    }, true);
  }
  if(el.playerBtnAudio){
    el.playerBtnAudio.addEventListener('click', ()=>{
      const willOpen = !(el.audioMenu && el.audioMenu.style.display==='flex');
      if(willOpen) closeAllPlayerMenus('audio');
    }, true);
  }
  if(el.playerBtnAspect){
    el.playerBtnAspect.addEventListener('click', ()=>{
      const willOpen = !(el.aspectMenu && el.aspectMenu.style.display==='flex');
      if(willOpen) closeAllPlayerMenus('aspect');
    }, true);
  }
  if(el.playerBtnFilters){
    el.playerBtnFilters.addEventListener('click', ()=>{
      const willOpen = !(el.filterPanel && el.filterPanel.style.display==='flex');
      if(willOpen) closeAllPlayerMenus('filter');
    }, true);
  }
  const speedBtn = document.getElementById('player-btn-speed');
  if(speedBtn){
    speedBtn.addEventListener('click', ()=>{
      const sm = document.getElementById('speed-menu');
      const willOpen = sm && !sm.classList.contains('open');
      if(willOpen) closeAllPlayerMenus('speed');
    }, true);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
