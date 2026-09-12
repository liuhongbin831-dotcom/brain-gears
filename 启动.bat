@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org first.
    echo.
    pause
    exit /b 1
)

rem If the app is already running on 8642, just open the browser (no new instance).
powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1',8642); exit 0 } catch { exit 1 }"
if not errorlevel 1 (
    start "" "http://localhost:8642"
    exit /b 0
)

node server.js
if errorlevel 1 (
    echo.
    echo Failed to start. Copy the error above and share it.
    pause
)
