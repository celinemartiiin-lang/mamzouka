@echo off
set "JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.17.10-hotspot"
set "ANDROID_HOME=C:\Users\sowzz\AppData\Local\Android\Sdk"
set "NDK_HOME=C:\Users\sowzz\AppData\Local\Android\Sdk\ndk\26.3.11579264"
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%USERPROFILE%\.cargo\bin;%PATH%"

echo ========================================================
echo MAMZOUKA STREAM - ANDROID TV APK BUILD
echo ========================================================

echo [1/2] Securing frontend into src-dist...
call npm run secure
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] Frontend obfuscation failed.
  exit /b %ERRORLEVEL%
)

echo [2/3] Building Android APK (aarch64)...
call npx tauri android build --apk --target aarch64
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] Tauri Android build failed.
  exit /b %ERRORLEVEL%
)

echo [3/3] Signing APK for Smart TV installation...
call scripts\sign-apk.bat
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] APK signing failed.
  exit /b %ERRORLEVEL%
)

echo ========================================================
echo [SUCCESS] Signed Android TV APK ready at mamzouka-tv.apk
echo ========================================================
