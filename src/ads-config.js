// ========================================================================
// MAMZOUKA STREAM - SMART ADS CONFIGURATION
// إعدادات الإعلانات الذكية وتحديد الدول والتردد
// يدعم: أكواد HTML/JavaScript (Adsterra, Monetag, Banners) والروابط المباشرة
// ========================================================================

window.MAMZOUKA_ADS_CONFIG = {
  // تفعيل أو تعطيل نظام الإعلانات بالكامل
  enabled: true,

  // 1. إعلانات قبل التشغيل (Pre-Roll / Interstitial Ads)
  // تدعم: كود HTML/JS (مثل Adsterra أو Monetag أو Iframes) أو رابط فيديو مباشر MP4
  preroll: {
    enabled: true,
    // عدد الثواني قبل إمكانية تخطي الإعلان (مثلاً: 5 ثوانٍ)
    skipDelaySeconds: 5,
    // نوع الإعلان: 'html' أو 'video'
    type: 'html',
    // كود HTML / JavaScript الكامل للإعلان (ضع كود Adsterra / Monetag / Banners / Iframes هنا)
    // إذا كان هذا الكود فارغاً، سيشتغل رابط الفيديو المباشر أدناه تلقائياً
    htmlCode: ``,
    // رابط فيديو الإعلان المباشر (mp4 أو webm)
    videoUrl: 'https://vjs.zencdn.net/v/oceans.mp4',
    // رابط التوجيه عند نقر المستخدم على زر زيارة الراعي
    targetUrl: 'https://t.me/mamzouka_official',
    // عنوان الراعي أو الإعلان
    sponsorTitle: 'إعلان راعي البرنامج الرسمي',
  },

  // 2. إعلانات البانر المدمجة (Banner Ads - 300x250 أو 728x90)
  banner: {
    enabled: false,
    // كود HTML الخاص بالبانر
    htmlCode: ``,
  },

  // 3. إعلان الـ Pop-Under / Smartlink (يفتح في المتصفح الخارجي مرة كل 24 ساعة)
  popunder: {
    enabled: true,
    // التردد بالساعات: 24 ساعة = مرة واحدة في اليوم لكل زائر
    frequencyHours: 24,
    // رابط العرض الإعلاني الذكي (Direct Link / Smartlink من Monetag أو Adsterra)
    url: 'https://t.me/mamzouka_official',
  },

  // 4. كود إعلاني عام يعمل في واجهة التطبيق (Social Bar / In-Page Push / Native Script)
  globalAdCode: ``,

  // 5. الدول والمناطق الممنوعة (Excluded / Blacklisted Countries)
  // ضع هنا رموز الدول (ISO 2-letter codes) التي تريد منع ظهور الإعلانات فيها
  // مثال: ['MA', 'DZ', 'FR'] - إذا كان المستخدم من هذه الدول لن تظهر له الإعلانات أبداً
  excludedCountries: [],

  // فحص الدولة عبر عنوان IP تلقائياً
  geoCheckEnabled: true,

  // Remote Cloud Control — same URL as update-config for centralized control
  remoteConfigUrl: 'https://raw.githubusercontent.com/mamzouka/mamzouka-remote-config/main/mamzouka-remote-config.json'
};
