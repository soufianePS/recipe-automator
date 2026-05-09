@echo off
REM Launches a dedicated Chrome with remote debugging on port 9222.
REM This Chrome uses its OWN profile dir (separate from your daily Chrome),
REM so opening it does NOT conflict with anything you already have open.
REM
REM Usage:
REM   1. Double-click this file (or run from terminal)
REM   2. Chrome opens — log into ChatGPT, Pinterest, Gemini once (cookies persist across runs)
REM   3. Keep this window AND Chrome open while running test scripts
REM   4. Test scripts will connect via CDP to localhost:9222

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "PROFILE_DIR=%LOCALAPPDATA%\recipe-automator-chrome-cdp"

if not exist "%CHROME%" (
  echo [launch-chrome-cdp] Chrome not found at: %CHROME%
  pause
  exit /b 1
)

if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

echo [launch-chrome-cdp] launching Chrome
echo   exe:     %CHROME%
echo   profile: %PROFILE_DIR%
echo   debug:   http://localhost:9222
echo.
echo Once Chrome opens:
echo   - log in to chatgpt.com (solve any CAPTCHA)
echo   - log in to pinterest.com if you want
echo   - log in to gemini.google.com (same account as Flow)
echo   - then run your test scripts with the --cdp flag
echo.
echo Keep this window open. Closing it will kill Chrome.
echo.

"%CHROME%" --remote-debugging-port=9222 --user-data-dir="%PROFILE_DIR%" --no-first-run --no-default-browser-check
