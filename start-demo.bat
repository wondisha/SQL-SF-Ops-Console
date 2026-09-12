@echo off
setlocal
cd /d "%~dp0"

set "PORT=4000"
netstat -aon | findstr ":4000 .*LISTENING" >nul
if not errorlevel 1 (
    set "PORT=4001"
    echo Port 4000 is already in use. Using port 4001 instead.
)

if not exist node_modules (
    echo Installing production dependencies...
    call npm ci --omit=dev
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed.
        pause
        exit /b 1
    )
)
if not exist .env if exist .env.example copy .env.example .env >nul
if not exist servers.csv if exist servers.example.csv copy servers.example.csv servers.csv >nul

echo Starting OmniDB Console demo at http://localhost:%PORT%
set "DEMO_MODE=true"
node src/server.js
pause
