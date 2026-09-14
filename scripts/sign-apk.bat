@echo off
set "JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.17.10-hotspot"
set "PATH=%JAVA_HOME%\bin;%PATH%"
set "APKSIGNER=C:\Users\sowzz\AppData\Local\Android\Sdk\build-tools\35.0.0\apksigner.bat"
set "KEYSTORE=%USERPROFILE%\.android\debug.keystore"
set "IN_APK=C:\Users\sowzz\Desktop\mamzouka\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-unsigned.apk"
set "OUT_APK=C:\Users\sowzz\Desktop\mamzouka\mamzouka-tv.apk"

echo Signing APK...
call "%APKSIGNER%" sign --ks "%KEYSTORE%" --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --out "%OUT_APK%" "%IN_APK%"
if %ERRORLEVEL% NEQ 0 (
  echo Signing failed!
  exit /b %ERRORLEVEL%
)

echo Verifying signature...
call "%APKSIGNER%" verify --verbose "%OUT_APK%"
if %ERRORLEVEL% NEQ 0 (
  echo Verification failed!
  exit /b %ERRORLEVEL%
)

echo [SUCCESS] Signed APK ready at %OUT_APK%
