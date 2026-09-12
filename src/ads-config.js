// ========================================================================
// MAMZOUKA STREAM - SMART ADS CONFIGURATION
// إعدادات الإعلانات الذكية وتحديد الدول والتردد
// ========================================================================

window.MAMZOUKA_ADS_CONFIG = {
  // تفعيل أو تعطيل نظام الإعلانات بالكامل
  enabled: true,

  // 1. إعلانات الفيديو قبل التشغيل (Pre-Roll Video Ads)
  preroll: {
    enabled: true,
    // عدد الثواني قبل إمكانية تخطي الإعلان (مثلاً: 5 ثوانٍ)
    skipDelaySeconds: 5,
    // رابط فيديو الإعلان (رابط مباشر mp4 أو webm أو رابط VAST)
    videoUrl: 'https://vjs.zencdn.net/v/oceans.mp4',
    // رابط التوجيه عند نقر المستخدم على الإعلان
    targetUrl: 'https://t.me/mamzouka_official',
    // عنوان الراعي أو الإعلان
    sponsorTitle: 'إعلان راعي البرنامج الرسمي',
  },

  // 2. إعلان الـ Pop-Under / Smartlink (يفتح في المتصفح الخارجي مرة كل 24 ساعة)
  popunder: {
    enabled: true,
    // التردد بالساعات: 24 ساعة = مرة واحدة في اليوم لكل زائر
    frequencyHours: 24,
    // رابط العرض الإعلاني الذكي (Direct Link / Smartlink من Monetag أو Adsterra)
    url: 'https://t.me/mamzouka_official',
  },

  // 3. الدول والمناطق الممنوعة (Excluded / Blacklisted Countries)
  // ضع هنا رموز الدول (ISO 2-letter codes) التي تريد منع ظهور الإعلانات فيها
  // مثال: ['MA', 'DZ', 'FR'] - إذا كان المستخدم من هذه الدول لن تظهر له الإعلانات أبداً
  excludedCountries: [],

  // فحص الدولة عبر عنوان IP تلقائياً
  geoCheckEnabled: true,

  // Remote Cloud Control — same URL as update-config for centralized control
  remoteConfigUrl: 'https://raw.githubusercontent.com/mamzouka/mamzouka-remote-config/main/mamzouka-remote-config.json'
};
