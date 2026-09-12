# ==========================================================================
# Mamzouka Stream — package the one-time runtime engine for distribution.
#
# Builds dist-engine/mamzouka-engine.zip containing:
#   torrent-server.js + package.json + PRODUCTION node_modules
#   (express, cors, webtorrent — no dev tools, no @tauri, no obfuscator)
# Plus downloads portable node.exe (dist-engine/node.exe).
#
# Upload BOTH files to a GitHub Release and put their direct links at the
# top of src-tauri/installer-hooks.nsh:
#   https://github.com/<you>/mamzouka/releases/download/<tag>/mamzouka-engine.zip
#   https://github.com/<you>/mamzouka/releases/download/<tag>/node.exe
# The installer (single .exe) fetches them during install. If the download
# fails on a user machine, the app itself retries on first run (see
# Rust command ensure_engine_assets), so nothing is ever bricked.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/package-runtime-deps.ps1
# ==========================================================================
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$OutDir = Join-Path $Root "dist-engine"
$StageDir = Join-Path $OutDir "stage"
$EngineDir = Join-Path $StageDir "engine"

Write-Host "[pack] preparing $OutDir ..."
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $EngineDir | Out-Null

# 1) Production-only node_modules (clean room, no devDependencies)
$TmpDeps = Join-Path $OutDir "deps-tmp"
New-Item -ItemType Directory -Force -Path $TmpDeps | Out-Null
Copy-Item (Join-Path $Root "package.json") (Join-Path $TmpDeps "package.json")
Copy-Item (Join-Path $Root "package-lock.json") (Join-Path $TmpDeps "package-lock.json") -ErrorAction SilentlyContinue
Push-Location $TmpDeps
Write-Host "[pack] npm install --omit=dev (clean room) ..."
$PrevPref = $ErrorActionPreference
$ErrorActionPreference = "Continue"
npm install --omit=dev --no-audit --no-fund 2>&1 | Select-Object -Last 3
$NpmCode = $LASTEXITCODE
$ErrorActionPreference = $PrevPref
if ($NpmCode -ne 0) { throw "npm install failed (exit $NpmCode)" }
Pop-Location
Copy-Item (Join-Path $TmpDeps "node_modules") (Join-Path $EngineDir "node_modules") -Recurse
Copy-Item (Join-Path $Root "torrent-server.js") (Join-Path $EngineDir "torrent-server.js")
Copy-Item (Join-Path $Root "package.json") (Join-Path $EngineDir "package.json")
Remove-Item -Recurse -Force $TmpDeps

# 2) Portable node.exe — latest v22 LTS, auto-resolved (no hardcoded version)
Write-Host "[pack] resolving latest Node v22 LTS ..."
$Index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 30
$Lts = $Index | Where-Object { $_.lts -and $_.version -like "v22.*" } | Select-Object -First 1
if (-not $Lts) { throw "Could not resolve Node v22 LTS from nodejs.org" }
$NodeUrl = "https://nodejs.org/dist/$($Lts.version)/win-x64/node.exe"
Write-Host "[pack] downloading $NodeUrl ..."
Invoke-WebRequest -Uri $NodeUrl -OutFile (Join-Path $OutDir "node.exe") -TimeoutSec 300
$NodeSize = [math]::Round((Get-Item (Join-Path $OutDir "node.exe")).Length / 1MB, 1)
Write-Host "[pack] node.exe = $($Lts.version), ${NodeSize} MB"

# 3) Zip the engine CONTENTS (no top-level folder — the installer extracts
# straight into $INSTDIR\engine\, so torrent-server.js must sit at zip root)
$ZipPath = Join-Path $OutDir "mamzouka-engine.zip"
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Write-Host "[pack] zipping engine ..."
Compress-Archive -Path (Join-Path $EngineDir "*") -DestinationPath $ZipPath -CompressionLevel Optimal
$ZipSize = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
$DepsSize = [math]::Round(((Get-ChildItem $EngineDir -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
Write-Host "[pack] engine unzipped = ${DepsSize} MB, zipped = ${ZipSize} MB"

# 4) Smoke test: boot the staged engine and hit /api/health
Write-Host "[pack] smoke-testing staged engine ..."
$EngineNode = Join-Path $OutDir "node.exe"
$Proc = Start-Process -FilePath $EngineNode -ArgumentList "`"$EngineDir\torrent-server.js`"" -WorkingDirectory $EngineDir -PassThru -WindowStyle Hidden
try {
  Start-Sleep -Seconds 6
  $Health = Invoke-RestMethod -Uri "http://127.0.0.1:31337/api/health" -TimeoutSec 8
  Write-Host ("[pack] engine says: " + ($Health | ConvertTo-Json -Compress))
  if ($Health.status -ne "ok") { throw "engine health check failed" }
  Write-Host "[pack] SMOKE TEST PASSED"
} finally {
  Stop-Process -Id $Proc.Id -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "[pack] DONE. Upload these 2 files to a GitHub Release:"
Write-Host "  1) $ZipPath"
Write-Host "  2) $(Join-Path $OutDir 'node.exe')"
Write-Host "Then paste their release URLs into src-tauri/installer-hooks.nsh"
