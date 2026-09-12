@echo off
setlocal
cd /d "%~dp0"

echo ==================================================
echo Starting SQL ^& Snowflake Ops Console...
echo ==================================================

set "PORT=4000"
netstat -aon | findstr ":4000 .*LISTENING" >nul
if not errorlevel 1 (
    set "PORT=4001"
    echo Port 4000 is already in use. Using port 4001 instead.
)

if not exist .env (
    if exist .env.example (
        echo Initializing .env from template...
        copy .env.example .env >nul
    )
)

if not exist servers.csv (
    if exist servers.example.csv (
        echo Initializing servers.csv from template...
        copy servers.example.csv servers.csv >nul
    )
)

echo.
echo Launching backend server on port %PORT%...
set "DEMO_MODE=false"
node src/server.js

echo.
echo [ERROR] Backend stopped unexpectedly.
pause

