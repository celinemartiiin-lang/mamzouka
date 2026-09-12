// ========================================================================
// MAMZOUKA STREAM - FOOLPROOF FORCE UPDATE & EXPIRY BLOCKER CONFIG
// إعدادات الإغلاق الإجباري وتاريخ انتهاء الصلاحية - لا يمكن تجاوزها
// ========================================================================
// This file is the SOURCE OF TRUTH. It is loaded BEFORE main.js and cannot
// be bypassed via localStorage. Edit here and rebuild.
//
// Fields:
// - enabled: master switch for blocker system
// - forceLock: immediate emergency kill switch (true = lock right now)
// - expiryDate: "YYYY-MM-DD" — app is BLOCKED on or after this date at 23:59:59
// - telegramUrl: official channel for update download
// - currentVersion / newVersion: display only
// - titleAr, titleEn, messageAr, messageEn, buttonTextAr, buttonTextEn
// - remoteCheckUrl: optional JSON endpoint for remote kill (e.g. GitHub raw)
// ========================================================================

window.MAMZOUKA_UPDATE_CONFIG = {
  enabled: true,
  // Immediate emergency kill switch (locks app right now for testing or forced sunset)
  forceLock: false,
  // Expiry date format (YYYY-MM-DD) - blocks app on or after this date at 23:59:59
  expiryDate: '2026-10-01',
  // Official Telegram channel or download URL
  telegramUrl: 'https://t.me/mamzouka_official',
  // Version identifiers
  currentVersion: '1.0.0',
  newVersion: '2.0.0',
  // Localized texts (Arabic & English)
  titleAr: 'تحديث إجباري متوفر 🚀',
  titleEn: 'Critical Update Required',
  messageAr: 'انتهت صلاحية هذه النسخة من التطبيق. لضمان استمرار عمل سيرفرات البث والقنوات بدون تقطيع، يُرجى تحميل النسخة الجديدة من قناتنا الرسمية على تيليغرام.',
  messageEn: 'This version of Mamzouka Stream has reached its expiration date. To ensure uninterrupted streaming and working live TV channels, please download the latest release from our official Telegram channel.',
  buttonTextAr: 'تحميل النسخة الجديدة من تيليغرام ✈️',
  buttonTextEn: 'Download Update on Telegram ✈️',
  // Optional remote JSON check (e.g. GitHub raw URL) — if provided, remote can force lock
  // Expected JSON shape: { "forceLock": false, "expiryDate": "2026-10-01", "enabled": true }
  remoteCheckUrl: '',
  // Remote Cloud Control — real-time kill-switch & ads update (GitHub Raw / Gist)
  // Example: 'https://raw.githubusercontent.com/youruser/mamzouka-remote-config/main/config.json'
  remoteConfigUrl: 'https://raw.githubusercontent.com/mamzouka/mamzouka-remote-config/main/mamzouka-remote-config.json'
};
// Tamper-resistant: freeze config so DevTools cannot easily override in memory
try { Object.freeze(window.MAMZOUKA_UPDATE_CONFIG); } catch {}
