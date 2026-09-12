# 🚀 Mamzouka Stream — Deployment & Release Runbook

This runbook outlines the deployment architecture, CI/CD pipeline stages, security gates, and release procedures for **Mamzouka Stream** across Windows and Android platforms.

---

## 🏗️ Architecture Overview

```
                          ┌───────────────────────────┐
                          │   Git Tag (e.g. v2.0.0)   │
                          │   or Manual Dispatch      │
                          └─────────────┬─────────────┘
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
       ┌────────────────────────┐              ┌────────────────────────┐
       │   Windows CI Runner    │              │   Android CI Runner    │
       │    (windows-latest)    │              │    (ubuntu-latest)     │
       ├────────────────────────┤              ├────────────────────────┤
       │ 1. npm ci              │              │ 1. Android NDK (r26)   │
       │ 2. npm run secure      │              │ 2. Rust Android targets│
       │ 3. tauri build (NSIS)  │              │ 3. npm run secure      │
       │ 4. SHA-256 Checksum    │              │ 4. aarch64 + armv7 APK │
       │ 5. Upload artifact     │              │ 5. SHA-256 Checksums   │
       └───────────┬────────────┘              └───────────┬────────────┘
                   │                                       │
                   └───────────────────┬───────────────────┘
                                       ▼
                       ┌───────────────────────────────┐
                       │      GitHub Release Job       │
                       │        (ubuntu-latest)        │
                       ├───────────────────────────────┤
                       │ • Aggregates Windows & APKs   │
                       │ • Generates SHA256SUMS.txt    │
                       │ • Publishes GitHub Release    │
                       └───────────────────────────────┘
```

---

## 🔑 CI/CD Secrets Configuration

In your GitHub repository settings under **Settings** → **Secrets and variables** → **Actions**, the following optional secrets can be configured:

| Secret Name | Purpose | Required |
|-------------|---------|----------|
| `GITHUB_TOKEN` | Automatically injected by GitHub Actions to publish releases. | Automatic |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri auto-updater private key for Windows update signing. | Optional |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the Tauri update private key. | Optional |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded release keystore for signing production APKs/AABs. | Optional (Defaults to debug key if empty) |

---

## 📦 How to Trigger a Release

### Method 1: Git Tag (Recommended)
Tagging the commit triggers the complete multi-platform release pipeline:
```bash
git tag v2.0.1
git push origin v2.0.1
```

### Method 2: GitHub Actions Manual Dispatch
1. Navigate to **Actions** → **Release & Multi-Platform Deployment**.
2. Click **Run workflow**.
3. Set the release tag name (e.g. `v2.0.1`).
4. (Optional) Check **Publish as Draft release** to review assets before making them public.
5. (Optional) Check **Build & package runtime torrent engine** if uploading a new `mamzouka-engine.zip` and `node.exe`.

---

## 🛡️ Security & Quality Gates

1. **Frontend Obfuscation Verification (`npm run secure`)**:
   - Obfuscates `main.js`, `i18n.js`, `i18n-chips.js`, and `remote-control.js`.
   - Protects global function names (`startPlayback`, `applyLang`, `invoke`) from being mangled.
   - Preserves editable config files (`update-config.js`, `ads-config.js`, `remote-config.js`).

2. **16 KB ELF Page Alignment (Android 15+)**:
   - Guaranteed via `src-tauri/.cargo/config.toml` flag:
     `-C link-arg=-zmax-page-size=16384`
   - Prevents Android 15 compatibility warnings and store rejection.

3. **Cryptographic Checksums**:
   - `SHA256SUMS.txt` is automatically compiled and attached to every release for integrity verification.

---

## 🚨 Emergency Kill-Switch & Force-Update Protocol

If a security issue, stream domain block, or broken version requires immediate deprecation:
1. Edit `src/update-config.js` or update the remote configuration URL:
   ```javascript
   window.MAMZOUKA_UPDATE_CONFIG = {
     enabled: true,
     forceLock: true, // Emergency instant block
     expiryDate: "2026-09-12",
     telegramUrl: "https://t.me/mamzouka_official"
   };
   ```
2. Alternatively, update your remote endpoint defined at `remoteConfigUrl` to instantly lock old clients without requiring a reinstallation.

---

## 🔄 Rollback Strategy

1. **GitHub Releases**:
   - If a build has a defect, edit the release on GitHub and mark it as **Pre-release** or delete the release asset.
   - Point users to the previous stable release tag.
2. **Remote Killswitch**:
   - Push a JSON change to the remote config to notify users of a patch release.
