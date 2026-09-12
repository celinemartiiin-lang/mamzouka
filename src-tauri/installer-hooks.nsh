; ==========================================================================
; Mamzouka Stream — NSIS installer hooks (Tauri `installerHooks`)
; Single-.exe distribution: the installer fetches the one-time runtime
; engine (portable node.exe + production node_modules) from direct links
; DURING install into $INSTDIR\engine\.
;
; >>> BEFORE PUBLISHING A RELEASE, EDIT THE TWO URLS BELOW <<<
; 1. Run:  powershell -ExecutionPolicy Bypass -File scripts\package-runtime-deps.ps1
; 2. Upload dist-engine\mamzouka-engine.zip + dist-engine\node.exe
;    to a GitHub Release (free, direct links, no login needed to download).
; 3. Paste the two release URLs below, then: npm run build
;
; If the download fails on a user machine (offline/proxy), the install
; still succeeds — the app retries the same download on first run
; (Rust command `ensure_engine_assets` + Diagnostics button).
; ==========================================================================

!define MAMZOUKA_NODE_URL "https://github.com/celinemartiiin-lang/mamzouka/releases/download/engine-v1/node.exe"
!define MAMZOUKA_ENGINE_URL "https://github.com/celinemartiiin-lang/mamzouka/releases/download/engine-v1/mamzouka-engine.zip"

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Mamzouka: fetching runtime engine (one-time, ~95 MB)..."
  nsExec::ExecToStack "powershell -NoProfile -ExecutionPolicy Bypass -Command $$ProgressPreference=$\'SilentlyContinue\'; $$d=$\'$INSTDIR\engine\'; New-Item -ItemType Directory -Force -Path \"$$d\" | Out-Null; try { if (-not (Test-Path $\'$INSTDIR\engine\node.exe\')) { Invoke-WebRequest -Uri $\'${MAMZOUKA_NODE_URL}\' -OutFile $\'$INSTDIR\engine\node.exe\' -TimeoutSec 900 }; if (-not (Test-Path $\'$INSTDIR\engine\node_modules\webtorrent\package.json\')) { $$zip=$\'$INSTDIR\engine\engine.zip\'; Invoke-WebRequest -Uri $\'${MAMZOUKA_ENGINE_URL}\' -OutFile \"$$zip\" -TimeoutSec 900; Expand-Archive -Path \"$$zip\" -DestinationPath \"$$d\" -Force; Remove-Item -Force \"$$zip\" } } catch { exit 1 }"
  Pop $0
  Pop $1
  DetailPrint "Mamzouka: engine setup finished (exit=$0)"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\engine"
!macroend
