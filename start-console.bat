@echo off
setlocal
cd /d "%~dp0"

echo ==================================================
echo Starting SQL ^& Snowflake Ops Console...
echo ==================================================

:: Free port 4000 if occupied by a zombie process
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
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
echo Launching backend server on port 4000...
node src/server.js

echo.
echo [ERROR] Backend stopped unexpectedly.
pause

