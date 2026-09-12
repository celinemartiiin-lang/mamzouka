// ==========================================================================
// Mamzouka Stream — secure frontend build (Layer 1: obfuscation)
// Copies src/ → src-dist/ and obfuscates the sensitive JS bundles.
//  - OBFUSCATED: main.js, i18n.js, i18n-chips.js, remote-control.js
//    (player logic, expiry/kill-switch gates, trackers, remote endpoints)
//  - COPIED AS-IS: index.html, styles.css, assets/, hls.min.js,
//    update-config.js, ads-config.js, remote-config.js
//    (admin-editable config + third-party lib stay readable on purpose)
// Safety rails for the obfuscator (breaking any of these breaks the app):
//  - renameGlobals: false      (window.RemoteControl / window.invoke /
//                                function names looked up by string must stay)
//  - transformObjectKeys: false (Tauri invoke arg keys like mediaType,
//                                magnet_uri must match the Rust backend)
//  - selfDefending/debugProtection: false (breaks WebView2 embedding)
// Usage: node scripts/secure-frontend.mjs [--prod]
// ==========================================================================
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'src-dist');

const OBFUSCATE = new Set(['main.js', 'i18n.js', 'i18n-chips.js', 'remote-control.js']);

const OBFUSCATOR_OPTIONS = {
  compact: true,
  simplify: true,
  numbersToExpressions: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayThreshold: 0.8,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  renameGlobals: false,
  transformObjectKeys: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  selfDefending: false,
  disableConsoleOutput: false,
  target: 'browser',
};

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

async function main() {
  const t0 = Date.now();
  await fs.rm(DIST, { recursive: true, force: true });
  await copyDir(SRC, DIST);

  // Safety: never obfuscate third-party or admin-editable files,
  // even if someone adds them to the OBFUSCATE set by mistake.
  const PROTECTED = new Set([
    'hls.min.js',
    'update-config.js',
    'ads-config.js',
    'remote-config.js',
  ]);

  for (const file of OBFUSCATE) {
    if (PROTECTED.has(file)) continue;
    const full = path.join(DIST, file);
    try {
      const code = await fs.readFile(full, 'utf8');
      const out = JavaScriptObfuscator.obfuscate(code, OBFUSCATOR_OPTIONS).getObfuscatedCode();
      await fs.writeFile(full, out, 'utf8');
      console.log(`[secure] obfuscated ${file} (${code.length} → ${out.length} chars)`);
    } catch (e) {
      console.warn(`[secure] SKIP ${file}: ${e.message} (shipped readable)`);
    }
  }

  // Sanity: global identifiers the app depends on must survive obfuscation.
  // (String VALUES like 'get_torrent_streams' and even `window.X` property
  // names are base64-encoded and decoded at runtime, so their absence from
  // the raw file is expected and safe. What must NOT change: global
  // function/var names + the `window` object itself, hence
  // renameGlobals:false + transformObjectKeys:false above.)
  const main = await fs.readFile(path.join(DIST, 'main.js'), 'utf8');
  const backendKeys = ['startPlayback', 'applyLang', 'window', 'invoke'];
  const missing = backendKeys.filter((k) => !main.includes(k));
  if (missing.length) {
    console.error(`[secure] FATAL: globals mangled: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`[secure] backend-key check OK (${((Date.now() - t0) / 1000).toFixed(1)}s) → src-dist/`);
}

main().catch((e) => {
  console.error('[secure] failed:', e);
  process.exit(1);
});
