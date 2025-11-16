@echo off
title Lunch Money Target Monitor
cd /d "%~dp0"

echo ================================
echo   Lunch Money Target Monitor
echo ================================
echo.

:: Path to internal files
set MONITOR_PATH=target\internals

:: Check if Node exists globally
node -v >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js is not installed.
    echo.
    echo Please install Node.js LTS from https://nodejs.org
    echo and then run this file again.
    echo.
    pause
    exit /b
)

echo ✅ Node.js detected.
echo.

:: Go into the internals folder where package.json and monitor-ui.js live
cd "%MONITOR_PATH%"

:: FIRST-TIME SETUP: install dependencies automatically if node_modules is missing
if not exist "node_modules" (
    echo 🔧 First-time setup: installing required packages...
    echo This may take a minute. Please wait...
    echo.

    npm install
    if errorlevel 1 (
        echo ❌ Failed to install dependencies.
        echo Make sure you are connected to the internet and try again.
        echo.
        pause
        exit /b
    )

    echo.
    echo ✅ Setup complete. Starting the monitor...
    echo.
) else (
    echo ✅ Dependencies already installed.
    echo Starting monitor wizard...
    echo.
)

:: Run the monitor UI
node monitor-ui.js

echo.
echo (Monitor finished or exited.)
echo.
pause




