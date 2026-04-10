@echo off
title Recipe Automator
color 0A

cd /d "%~dp0"

echo ========================================
echo    Recipe Automator
echo ========================================
echo.

:: Check Node.js
node --version >nul 2>nul
if %errorlevel% neq 0 (
    echo [X] Node.js not found!
    echo     Download and install from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Install npm dependencies if needed
if not exist "node_modules" (
    echo [i] First time setup - installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [X] Failed to install dependencies.
        pause
        exit /b 1
    )
    echo.
)

:: Install Playwright Chromium browser if needed
if not exist "%LOCALAPPDATA%\ms-playwright\chromium-*" (
    echo [i] Installing Chromium browser for automation...
    npx playwright install chromium
    if %errorlevel% neq 0 (
        echo [X] Failed to install Chromium.
        pause
        exit /b 1
    )
    echo.
)

:: Create required directories
if not exist "data" mkdir data
if not exist "output" mkdir output
if not exist "screenshots" mkdir screenshots

echo [OK] All dependencies ready!
echo.
echo Starting Recipe Automator on http://localhost:3000
echo.
echo    1. Dashboard will open in your browser
echo    2. First time? Click "Login to Google" to set up Flow
echo    3. Configure your settings (Google Sheet, WordPress, Backgrounds)
echo    4. Click Start to run!
echo.
echo DO NOT CLOSE THIS WINDOW
echo ========================================
echo.

:: Open dashboard in default browser
start "" "http://localhost:3000"

:: Start the server
node src/server.js

echo.
echo Application stopped.
pause
