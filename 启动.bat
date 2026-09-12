@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org first.
    echo.
    pause
    exit /b 1
)
node server.js
if errorlevel 1 (
    echo.
    echo Failed to start. Copy the error above and share it.
    pause
)
