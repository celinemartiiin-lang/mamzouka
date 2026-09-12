// ==========================================================================
// Mamzouka Stream - Chips / selects dictionaries (single language each)
// Loaded AFTER i18n.js, BEFORE main.js. Keyed by data-* attribute values.
// Texts here REPLACE button/option labels on every language switch, so no
// mixed "English (العربية)" strings ever stay on screen.
// ==========================================================================
window.MAMZOUKA_CHIPS = {
  mood: {
    ramadan: { en: '🌙 Ramadan Family', fr: '🌙 Famille Ramadan', ar: '🌙 عائلة رمضان' },
    cozy: { en: '☕ Cozy Night', fr: '☕ Soirée cocooning', ar: '☕ سهرة دافئة' },
    thrill: { en: '🔥 Thrill Rush', fr: '🔥 Montée d’adrénaline', ar: '🔥 إثارة قصوى' },
    laugh: { en: '😂 Laugh Out Loud', fr: '😂 Fou rire', ar: '😂 ضحك هستيري' },
    kids: { en: '👶 Kids Safe', fr: '👶 Enfants', ar: '👶 آمن للأطفال' },
    arab: { en: '🌴 Maghrebi Vibes', fr: '🌴 Ambiance maghrébine', ar: '🌴 أجواء مغاربية' },
    anime: { en: '⚡ Anime Binge', fr: '⚡ Marathon anime', ar: '⚡ ماراطون أنمي' }
  },
  movieGenre: {
    '|': { en: '🌐 All Movies', fr: '🌐 Tous les films', ar: '🌐 كل الأفلام' },
    '|ar': { en: '🌴 Arab Cinema', fr: '🌴 Cinéma arabe', ar: '🌴 السينما العربية' },
    '|ma': { en: '🇲🇦 Morocco', fr: '🇲🇦 Maroc', ar: '🇲🇦 المغرب' },
    '|eg': { en: '🇪🇬 Egypt', fr: '🇪🇬 Égypte', ar: '🇪🇬 مصر' },
    '|us': { en: '🇺🇸 USA / Hollywood', fr: '🇺🇸 USA / Hollywood', ar: '🇺🇸 أمريكا' },
    '|kr': { en: '🇰🇷 South Korea', fr: '🇰🇷 Corée du Sud', ar: '🇰🇷 كوريا' },
    '|in': { en: '🇮🇳 India', fr: '🇮🇳 Inde', ar: '🇮🇳 الهند' },
    '|tr': { en: '🇹🇷 Turkey', fr: '🇹🇷 Turquie', ar: '🇹🇷 تركيا' },
    '|jp': { en: '🇯🇵 Japan', fr: '🇯🇵 Japon', ar: '🇯🇵 اليابان' },
    '|gb': { en: '🇬🇧 UK', fr: '🇬🇧 Royaume-Uni', ar: '🇬🇧 بريطانيا' },
    '|fr': { en: '🇫🇷 France', fr: '🇫🇷 France', ar: '🇫🇷 فرنسا' },
    '|es': { en: '🇪🇸 Spain', fr: '🇪🇸 Espagne', ar: '🇪🇸 إسبانيا' },
    '|de': { en: '🇩🇪 Germany', fr: '🇩🇪 Allemagne', ar: '🇩🇪 ألمانيا' },
    '|it': { en: '🇮🇹 Italy', fr: '🇮🇹 Italie', ar: '🇮🇹 إيطاليا' },
    '|cn': { en: '🇨🇳 China', fr: '🇨🇳 Chine', ar: '🇨🇳 الصين' },
    '|hk': { en: '🇭🇰 Hong Kong', fr: '🇭🇰 Hong Kong', ar: '🇭🇰 هونغ كونغ' },
    '|se': { en: '🇸🇪 Sweden', fr: '🇸🇪 Suède', ar: '🇸🇪 السويد' },
    '|mx': { en: '🇲🇽 Mexico', fr: '🇲🇽 Mexique', ar: '🇲🇽 المكسيك' },
    '|th': { en: '🇹🇭 Thailand', fr: '🇹🇭 Thaïlande', ar: '🇹🇭 تايلاند' },
    '28|': { en: '🌪️ Action', fr: '🌪️ Action', ar: '🌪️ أكشن' },
    '12|': { en: '🗺️ Adventure', fr: '🗺️ Aventure', ar: '🗺️ مغامرات' },
    '35|': { en: '🤣 Comedy', fr: '🤣 Comédie', ar: '🤣 كوميديا' },
    '18|': { en: '🎭 Drama', fr: '🎭 Drame', ar: '🎭 دراما' },
    '27|': { en: '👻 Horror', fr: '👻 Horreur', ar: '👻 رعب' },
    '878|': { en: '🚀 Sci-Fi', fr: '🚀 Science-fiction', ar: '🚀 خيال علمي' },
    '53|': { en: '🩸 Thriller', fr: '🩸 Thriller', ar: '🩸 تشويق' },
    '10749|': { en: '❤️ Romance', fr: '❤️ Romance', ar: '❤️ رومانسية' },
    '99|': { en: '🌍 Documentary', fr: '🌍 Documentaire', ar: '🌍 وثائقي' },
    '16|': { en: '🎨 Animation', fr: '🎨 Animation', ar: '🎨 رسوم متحركة' },
    '80|': { en: '🔪 Crime', fr: '🔪 Crime', ar: '🔪 جريمة' },
    '10752|': { en: '⚔️ War', fr: '⚔️ Guerre', ar: '⚔️ حرب' },
    '37|': { en: '🤠 Western', fr: '🤠 Western', ar: '🤠 ويسترن' },
    '9648|': { en: '🔍 Mystery', fr: '🔍 Mystère', ar: '🔍 غموض' },
    '36|': { en: '📜 History', fr: '📜 Histoire', ar: '📜 تاريخ' },
    '10402|': { en: '🎶 Music', fr: '🎶 Musique', ar: '🎶 موسيقى' },
    '10751|': { en: '👨‍👩‍👧 Family', fr: '👨‍👩‍👧 Famille', ar: '👨‍👩‍👧 عائلي' },
    '10770|': { en: '📺 TV Movie', fr: '📺 Téléfilm', ar: '📺 فيلم تلفزي' }
  },
  tvGenre: {
    '|': { en: '🌐 All Series', fr: '🌐 Toutes les séries', ar: '🌐 كل المسلسلات' },
    '|ar': { en: '🌴 Arab Series', fr: '🌴 Séries arabes', ar: '🌴 المسلسلات العربية' },
    '|ma': { en: '🇲🇦 Morocco', fr: '🇲🇦 Maroc', ar: '🇲🇦 المغرب' },
    '|eg': { en: '🇪🇬 Egypt', fr: '🇪🇬 Égypte', ar: '🇪🇬 مصر' },
    '|sy': { en: '🇸🇾 Syria', fr: '🇸🇾 Syrie', ar: '🇸🇾 سوريا' },
    '|tr': { en: '🇹🇷 Turkey', fr: '🇹🇷 Turquie', ar: '🇹🇷 تركيا' },
    '|kr': { en: '🇰🇷 South Korea', fr: '🇰🇷 Corée du Sud', ar: '🇰🇷 كوريا' },
    '|us': { en: '🇺🇸 USA', fr: '🇺🇸 USA', ar: '🇺🇸 أمريكا' },
    '|gb': { en: '🇬🇧 UK', fr: '🇬🇧 Royaume-Uni', ar: '🇬🇧 بريطانيا' },
    '|es': { en: '🇪🇸 Spain', fr: '🇪🇸 Espagne', ar: '🇪🇸 إسبانيا' },
    '|jp': { en: '🇯🇵 Japan', fr: '🇯🇵 Japon', ar: '🇯🇵 اليابان' },
    '|fr': { en: '🇫🇷 France', fr: '🇫🇷 France', ar: '🇫🇷 فرنسا' },
    '|in': { en: '🇮🇳 India', fr: '🇮🇳 Inde', ar: '🇮🇳 الهند' },
    '|de': { en: '🇩🇪 Germany', fr: '🇩🇪 Allemagne', ar: '🇩🇪 ألمانيا' },
    '|it': { en: '🇮🇹 Italy', fr: '🇮🇹 Italie', ar: '🇮🇹 إيطاليا' },
    '|cn': { en: '🇨🇳 China', fr: '🇨🇳 Chine', ar: '🇨🇳 الصين' },
    '|se': { en: '🇸🇪 Sweden', fr: '🇸🇪 Suède', ar: '🇸🇪 السويد' },
    '|mx': { en: '🇲🇽 Mexico', fr: '🇲🇽 Mexique', ar: '🇲🇽 المكسيك' },
    '|th': { en: '🇹🇭 Thailand', fr: '🇹🇭 Thaïlande', ar: '🇹🇭 تايلاند' },
    '10759|': { en: '🌪️ Action & Adventure', fr: '🌪️ Action & aventure', ar: '🌪️ أكشن ومغامرات' },
    '18|': { en: '🎭 Drama', fr: '🎭 Drame', ar: '🎭 دراما' },
    '35|': { en: '🤣 Comedy', fr: '🤣 Comédie', ar: '🤣 كوميديا' },
    '10765|': { en: '🚀 Sci-Fi & Fantasy', fr: '🚀 SF & fantastique', ar: '🚀 خيال علمي وفانتازيا' },
    '80|': { en: '🔪 Crime', fr: '🔪 Crime', ar: '🔪 جريمة' },
    '9648|': { en: '🔍 Mystery', fr: '🔍 Mystère', ar: '🔍 غموض' },
    '10768|': { en: '⚔️ War & Politics', fr: '⚔️ Guerre & politique', ar: '⚔️ حرب وسياسة' },
    '37|': { en: '🤠 Western', fr: '🤠 Western', ar: '🤠 ويسترن' },
    '99|': { en: '🌍 Documentary', fr: '🌍 Documentaire', ar: '🌍 وثائقي' },
    '16|': { en: '🎨 Animation', fr: '🎨 Animation', ar: '🎨 رسوم متحركة' },
    '10751|': { en: '👨‍👩‍👧 Family & Kids', fr: '👨‍👩‍👧 Famille', ar: '👨‍👩‍👧 عائلي' },
    '10764|': { en: '📺 Reality Shows', fr: '📺 Téléréalité', ar: '📺 برامج واقعية' }
  },
  animeGenre: {
    '': { en: 'All Anime', fr: 'Tous les anime', ar: 'كل الأنمي' },
    '10759': { en: 'Action & Shonen', fr: 'Action & shonen', ar: 'أكشن وشونن' },
    '10765': { en: 'Fantasy & Isekai', fr: 'Fantasy & isekai', ar: 'فانتازيا وإيسيكاي' },
    '18': { en: 'Drama', fr: 'Drame', ar: 'دراما' },
    '35': { en: 'Comedy', fr: 'Comédie', ar: 'كوميديا' },
    '9648': { en: 'Mystery & Supernatural', fr: 'Mystère & surnaturel', ar: 'غموض وخوارق' }
  },
  liveCountry: {
    all: { en: '🌐 All Channels', fr: '🌐 Toutes les chaînes', ar: '🌐 كل القنوات' },
    ma: { en: '🇲🇦 Morocco', fr: '🇲🇦 Maroc', ar: '🇲🇦 المغرب' },
    sa: { en: '🌴 Arab World & Nilesat', fr: '🌴 Monde arabe & Nilesat', ar: '🌴 العالم العربي ونايلسات' },
    eg: { en: '🇪🇬 Egypt', fr: '🇪🇬 Égypte', ar: '🇪🇬 مصر' },
    dz: { en: '🇩🇿 Algeria & Tunisia', fr: '🇩🇿 Algérie & Tunisie', ar: '🇩🇿 الجزائر وتونس' },
    fr: { en: '🇫🇷 France & TNT', fr: '🇫🇷 France & TNT', ar: '🇫🇷 فرنسا' },
    us: { en: '🇺🇸 USA & 🇬🇧 UK', fr: '🇺🇸 USA & 🇬🇧 UK', ar: '🇺🇸 أمريكا وبريطانيا' },
    es: { en: '🇪🇸 Spain', fr: '🇪🇸 Espagne', ar: '🇪🇸 إسبانيا' },
    de: { en: '🇩🇪 Germany', fr: '🇩🇪 Allemagne', ar: '🇩🇪 ألمانيا' },
    tr: { en: '🇹🇷 Turkey', fr: '🇹🇷 Turquie', ar: '🇹🇷 تركيا' },
    it: { en: '🇮🇹 Italy', fr: '🇮🇹 Italie', ar: '🇮🇹 إيطاليا' }
  },
  liveCat: {
    all: { en: '🌟 All Categories', fr: '🌟 Toutes catégories', ar: '🌟 كل الفئات' },
    sports: { en: '⚽ Sports', fr: '⚽ Sport', ar: '⚽ رياضة' },
    news: { en: '📰 News', fr: '📰 Infos', ar: '📰 أخبار' },
    movies: { en: '🎬 Movies & Series', fr: '🎬 Films & séries', ar: '🎬 أفلام ومسلسلات' },
    movie: { en: '🎬 Movies & Series', fr: '🎬 Films & séries', ar: '🎬 أفلام ومسلسلات' },
    radio: { en: '📻 Live Radio', fr: '📻 Radio en direct', ar: '📻 راديو مباشر' },
    gaming: { en: '🎮 Twitch & Gaming', fr: '🎮 Twitch & gaming', ar: '🎮 ألعاب' },
    game: { en: '🎮 Twitch & Gaming', fr: '🎮 Twitch & gaming', ar: '🎮 ألعاب' },
    animation: { en: '👶 Kids & Animation', fr: '👶 Enfants', ar: '👶 أطفال' },
    kids: { en: '👶 Kids & Animation', fr: '👶 Enfants', ar: '👶 أطفال' },
    cartoon: { en: '👶 Kids & Animation', fr: '👶 Enfants', ar: '👶 أطفال' },
    documentary: { en: '🌍 Documentary', fr: '🌍 Documentaire', ar: '🌍 وثائقي' },
    education: { en: '🌍 Documentary', fr: '🌍 Documentaire', ar: '🌍 وثائقي' },
    music: { en: '🎵 Music', fr: '🎵 Musique', ar: '🎵 موسيقى' }
  },
  radioCat: {
    all: { en: '🌟 All Stations', fr: '🌟 Toutes les stations', ar: '🌟 كل المحطات' },
    morocco: { en: '🇲🇦 Moroccan Stations', fr: '🇲🇦 Stations marocaines', ar: '🇲🇦 محطات مغربية' },
    sports: { en: '⚽ Sports Radio', fr: '⚽ Radio sport', ar: '⚽ راديو رياضي' },
    quran: { en: '📖 Quran Karim', fr: '📖 Coran', ar: '📖 القرآن الكريم' },
    arab: { en: '🌴 Arab World', fr: '🌴 Monde arabe', ar: '🌴 العالم العربي' },
    lofi: { en: '🎧 Lofi & Chill Beats', fr: '🎧 Lofi & chill', ar: '🎧 موسيقى هادئة' },
    world: { en: '🌍 World FM', fr: '🌍 Monde FM', ar: '🌍 إذاعات عالمية' }
  },
  ytCat: {
    trending: { en: '🔥 Trending Now', fr: '🔥 Tendances', ar: '🔥 الأكثر رواجا' },
    podcasts: { en: '🎙️ Podcasts & Talk Shows', fr: '🎙️ Podcasts & débats', ar: '🎙️ بودكاست وبرامج' },
    trailers: { en: '🎬 Movie & Series Trailers', fr: '🎬 Bandes-annonces', ar: '🎬 إعلانات الأفلام' },
    documentaries: { en: '🌍 World Documentaries', fr: '🌍 Documentaires', ar: '🌍 وثائقيات' },
    tech: { en: '💻 Tech & Science', fr: '💻 Tech & science', ar: '💻 تقنية وعلوم' },
    gaming: { en: '🎮 Gaming Highlights', fr: '🎮 Gaming', ar: '🎮 ألعاب' }
  },
  twCat: {
    esports: { en: '🏆 eSports & Tournaments', fr: '🏆 eSport & tournois', ar: '🏆 رياضات إلكترونية' },
    minecraft: { en: '⛏️ Minecraft & Sandbox', fr: '⛏️ Minecraft', ar: '⛏️ ماينكرافت' },
    gtav: { en: '🚗 GTA V & Roleplay', fr: '🚗 GTA V & roleplay', ar: '🚗 GTA V' },
    fps: { en: '🎯 Valorant & FPS', fr: '🎯 Valorant & FPS', ar: '🎯 تصويب' },
    sports: { en: '⚽ FC 26 & Sports', fr: '⚽ FC 26 & sport', ar: '⚽ كرة القدم' },
    chatting: { en: '💬 Just Chatting', fr: '💬 Discussion', ar: '💬 دردشة' }
  },
  streamFilter: {
    all: { en: '🌐 All Sources', fr: '🌐 Toutes les sources', ar: '🌐 كل المصادر' },
    debrid: { en: '⚡ Real-Debrid / Direct', fr: '⚡ Real-Debrid / Direct', ar: '⚡ مباشر' },
    '4k': { en: '🌟 4K UHD', fr: '🌟 4K UHD', ar: '🌟 4K' },
    '1080p': { en: '🔵 1080p', fr: '🔵 1080p', ar: '🔵 1080p' },
    '720p': { en: '🟢 720p', fr: '🟢 720p', ar: '🟢 720p' },
    french: { en: '🇫🇷 Français', fr: '🇫🇷 Français', ar: '🇫🇷 فرنسية' },
    arabic: { en: '🇸🇦 العربية', fr: '🇸🇦 Arabe', ar: '🇸🇦 العربية' }
  },
  dlFilter: {
    all: { en: 'All Items', fr: 'Tout', ar: 'الكل' },
    completed: { en: '✅ Offline Ready', fr: '✅ Prêts', ar: '✅ جاهز' },
    downloading: { en: '⏳ Downloading', fr: '⏳ En cours', ar: '⏳ جار التحميل' }
  },
  settingsTab: {
    account: { en: '👤 Account', fr: '👤 Compte', ar: '👤 الحساب' },
    appearance: { en: '🎨 Appearance', fr: '🎨 Apparence', ar: '🎨 المظهر' },
    playback: { en: '▶️ Playback', fr: '▶️ Lecture', ar: '▶️ التشغيل' },
    downloads: { en: '💾 Downloads', fr: '💾 Téléchargements', ar: '💾 التحميلات' },
    subtitles: { en: '💬 Subtitles', fr: '💬 Sous-titres', ar: '💬 الترجمة' },
    live: { en: '📡 Live TV', fr: '📡 TV en direct', ar: '📡 البث المباشر' },
    notifications: { en: '🔔 Notifications', fr: '🔔 Notifications', ar: '🔔 الإشعارات' },
    advanced: { en: '🛠️ Advanced', fr: '🛠️ Avancé', ar: '🛠️ متقدم' }
  }
};

// Generic <option> texts for settings/player selects, keyed "selectId|value"
window.MAMZOUKA_GENOPTS = {
  'setting-theme|moroccan': { en: '🇲🇦 Moroccan Night (Red/Gold)', fr: '🇲🇦 Nuit marocaine (rouge/or)', ar: '🇲🇦 ليل مغربي (أحمر/ذهبي)' },
  'setting-theme|midnight': { en: '🌌 Midnight Blue', fr: '🌌 Bleu minuit', ar: '🌌 أزرق ليلي' },
  'setting-theme|light': { en: '☀️ Light Sand', fr: '☀️ Sable clair', ar: '☀️ رملي فاتح' },
  'setting-density|comfortable': { en: 'Comfortable (180px cards)', fr: 'Confortable (cartes 180px)', ar: 'مريح (بطاقات 180px)' },
  'setting-density|compact': { en: 'Compact (140px cards)', fr: 'Compact (cartes 140px)', ar: 'مضغوط (بطاقات 140px)' },
  'setting-density|spacious': { en: 'Spacious (210px cards)', fr: 'Spacieux (cartes 210px)', ar: 'واسع (بطاقات 210px)' },
  'setting-res|1080p': { en: '1080p Full HD', fr: '1080p Full HD', ar: '1080p عالية الجودة' },
  'setting-res|4K': { en: '4K Ultra HD', fr: '4K Ultra HD', ar: '4K فائقة الجودة' },
  'setting-res|720p': { en: '720p HD', fr: '720p HD', ar: '720p جودة متوسطة' },
  'setting-concurrency|1': { en: '1 parallel', fr: '1 en parallèle', ar: '1 متواز' },
  'setting-concurrency|2': { en: '2 parallel', fr: '2 en parallèle', ar: '2 متوازيان' },
  'setting-concurrency|3': { en: '3 parallel', fr: '3 en parallèle', ar: '3 متوازية' },
  'setting-sub-lang|ara': { en: 'Arabic', fr: 'Arabe', ar: 'العربية' },
  'setting-sub-lang|eng': { en: 'English', fr: 'Anglais', ar: 'الإنجليزية' },
  'setting-sub-lang|fre': { en: 'French', fr: 'Français', ar: 'الفرنسية' },
  'setting-sub-lang|spa': { en: 'Spanish', fr: 'Espagnol', ar: 'الإسبانية' },
  'setting-sub-lang|ger': { en: 'German', fr: 'Allemand', ar: 'الألمانية' },
  'setting-secondary-sub|': { en: 'None', fr: 'Aucune', ar: 'بدون' },
  'setting-secondary-sub|eng': { en: 'English', fr: 'Anglais', ar: 'الإنجليزية' },
  'setting-secondary-sub|fre': { en: 'French', fr: 'Français', ar: 'الفرنسية' },
  'setting-secondary-sub|ara': { en: 'Arabic', fr: 'Arabe', ar: 'العربية' },
  'setting-sub-size|small': { en: 'Small', fr: 'Petite', ar: 'صغير' },
  'setting-sub-size|medium': { en: 'Medium', fr: 'Moyenne', ar: 'متوسط' },
  'setting-sub-size|large': { en: 'Large', fr: 'Grande', ar: 'كبير' },
  'setting-epg-source|auto': { en: 'Auto (per country)', fr: 'Auto (par pays)', ar: 'تلقائي (حسب الدولة)' },
  'setting-epg-source|ma': { en: 'Morocco (ma.xml)', fr: 'Maroc (ma.xml)', ar: 'المغرب (ma.xml)' },
  'setting-epg-source|fr': { en: 'France (fr.xml)', fr: 'France (fr.xml)', ar: 'فرنسا (fr.xml)' },
  'setting-epg-source|us': { en: 'USA (us.xml)', fr: 'USA (us.xml)', ar: 'أمريكا (us.xml)' },
  'sub-font-size|small': { en: 'Small', fr: 'Petite', ar: 'صغير' },
  'sub-font-size|normal': { en: 'Normal', fr: 'Normale', ar: 'عادي' },
  'sub-font-size|large': { en: 'Large', fr: 'Grande', ar: 'كبير' },
  'sub-font-size|xlarge': { en: 'Extra Large', fr: 'Très grande', ar: 'كبير جدا' },
  'sub-font-family|Cairo': { en: 'Cairo', fr: 'Cairo', ar: 'القاهرة' },
  'sub-font-family|Outfit': { en: 'Outfit', fr: 'Outfit', ar: 'Outfit' },
  'sub-font-family|Inter': { en: 'Inter', fr: 'Inter', ar: 'Inter' },
  'sub-font-family|Roboto': { en: 'Roboto', fr: 'Roboto', ar: 'Roboto' },
  'sub-font-family|system-ui': { en: 'System', fr: 'Système', ar: 'النظام' },
  'sub-secondary-lang|': { en: 'Select secondary…', fr: 'Secondaire…', ar: 'اختر ثانوية…' },
  'sub-secondary-lang|eng': { en: 'English', fr: 'Anglais', ar: 'الإنجليزية' },
  'sub-secondary-lang|ara': { en: 'Arabic', fr: 'Arabe', ar: 'العربية' },
  'sub-secondary-lang|fre': { en: 'French', fr: 'Français', ar: 'الفرنسية' }
};
window.MAMZOUKA_SELECTS = {
  sort: {
    'popularity.desc': { en: '🔥 Most Popular', fr: '🔥 Popularité', ar: '🔥 الأكثر شعبية' },
    'vote_average.desc': { en: '🏆 Highest Rated', fr: '🏆 Mieux notés', ar: '🏆 الأعلى تقييما' },
    'revenue.desc': { en: '💰 Box Office', fr: '💰 Box-office', ar: '💰 الأعلى إيرادا' },
    'primary_release_date.desc': { en: '🆕 Latest Releases', fr: '🆕 Nouveautés', ar: '🆕 الأحدث' },
    'first_air_date.desc': { en: '🆕 Latest Releases', fr: '🆕 Nouveautés', ar: '🆕 الأحدث' },
    'vote_count.desc': { en: '👥 Most Voted', fr: '👥 Plus votés', ar: '👥 الأكثر تصويتا' }
  },
  yearAll: { '': { en: 'All Years', fr: 'Toutes années', ar: 'كل السنوات' } },
  year1980: { '1980': { en: '1980s & Classics', fr: 'Années 80 & classiques', ar: 'الثمانينات وكلاسيكيات' } },
  ratingAll: { '0': { en: 'All Ratings', fr: 'Toutes notes', ar: 'كل التقييمات' } },
  ratingStars: {
    '8.5': { en: '★ 8.5+ Masterpieces', fr: '★ 8.5+ Chefs-d’œuvre', ar: '★ 8.5+ روائع' },
    '8.0': { en: '★ 8.0+ Top Rated', fr: '★ 8.0+ Top', ar: '★ 8.0+ ممتاز' },
    '7.0': { en: '★ 7.0+ Recommended', fr: '★ 7.0+ Recommandés', ar: '★ 7.0+ موصى به' },
    '6.0': { en: '★ 6.0+ Good', fr: '★ 6.0+ Bien', ar: '★ 6.0+ جيد' }
  }
};

// <optgroup> labels in country selects, by select + position
window.MAMZOUKA_OPTGROUPS = {
  movie: {
    en: ['🌟 Top Cinema Nations', '🌴 Arab Cinema', '🌍 European Cinema', '🌏 Asian & World Cinema'],
    fr: ['🌟 Grands cinémas', '🌴 Cinéma arabe', '🌍 Cinéma européen', '🌏 Cinéma asiatique & monde'],
    ar: ['🌟 أشهر الدول إنتاجا', '🌴 السينما العربية', '🌍 السينما الأوروبية', '🌏 السينما الآسيوية والعالمية']
  },
  tv: {
    en: ['🌟 Top Drama Nations', '🌴 Arab Series & Drama', '🌍 European Drama', '🌏 Asian & World Series'],
    fr: ['🌟 Grands pays de séries', '🌴 Séries arabes', '🌍 Séries européennes', '🌏 Séries asiatiques & monde'],
    ar: ['🌟 أشهر الدول إنتاجا للدراما', '🌴 المسلسلات والدراما العربية', '🌍 الدراما الأوروبية', '🌏 المسلسلات الآسيوية والعالمية']
  }
};
